/**
 * Service des opérations de terrain : sous-traitants accrédités, lots, agents et badges, missions,
 * constats scellés géolocalisés, contrôle qualité indépendant, contrôles mystère, indicateurs de production
 * et calcul INDICATIF de rémunération sur livrables vérifiés.
 *
 * Ce service ne manipule JAMAIS d'argent : aucun encaissement, aucune référence de paiement, aucune lecture
 * des montants payés par les contribuables. Un constat ne crée jamais d'obligation (statut probant OBSERVÉ).
 * Toute suspension, tout retrait, toute validation est une décision humaine motivée, tracée dans l'audit.
 */
import { Money, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { AuditActor } from '../../core/audit.js';
import { isDemoMode, type User } from '../../core/auth.js';
import { kinshasaDate, kinshasaDay } from '../../core/clock.js';
import { canonicalJson, checkChar, hmacSha256Hex, randomCode, randomSecret, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { validityView } from '../../core/validity.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { distanceM, pct, type LatLon } from './geo.js';
import {
  DEFAULT_GPS_TOLERANCE_M, MIN_SAMPLE_RATE, PROBATION_MAX_AGENTS,
  type AgentBadge, type AgentStatus, type BadgeVerification, type ContractUnitPrices, type CounterVisit, type FieldAgent,
  type Finding, type FindingOutcome, type Lot, type Mission, type MissionStatus, type MysteryCheck, type PublicBadgeResult,
  type QualitySample, type Subcontractor, type SubcontractorStatus, type TerrainModule,
} from './model.js';
import { TERRAIN_ACTIONS as A } from './policy.js';

/** Rôles qui voient l'ensemble du dispositif (pas de restriction à un sous-traitant). */
const BROAD_ROLES: RoleCode[] = ['R06', 'R07', 'R08', 'R09', 'R11', 'R17', 'R22', 'R23', 'R24'];
const ACCREDITED: SubcontractorStatus[] = ['ACCREDITE_PROBATOIRE', 'ACCREDITE'];
const OPEN_MISSION: MissionStatus[] = ['AFFECTEE', 'EN_COURS'];

export interface InviteSubcontractorInput {
  name: string;
  selectionReference: string;
  requestedModules: TerrainModule[];
  capacityAgents: number;
  managerName: string;
}
export interface DossierInput { rccm: string; nif: string; references?: string; capacityAgents?: number; requestedModules?: TerrainModule[] }
export interface DiligenceInput { legalExistence: boolean; taxClearance: boolean; noConflictOfInterest: boolean; publicAgentLinksDeclared: boolean; notes?: string }
export interface ProposalInput { modules: TerrainModule[]; communes: string[]; validUntil: string; probationUntil: string; reason: string }
export interface LotInput { subcontractorId?: string; module: TerrainModule; commune: string; quartiers: string[]; periodStart: string; periodEnd: string; maxAgents: number }
export interface InviteAgentInput { displayName: string; declaredQuartiers?: string[]; declaredObjectIds?: string[]; photoRef?: string }
export interface HabilitationInput {
  identityVerified: boolean; trainingCertificateRef: string; trainingValidUntil: string; ethicsSigned: boolean;
  deviceId?: string; module: TerrainModule; communes: string[]; validUntil: string;
}
export interface MissionInput {
  lotId?: string; module?: TerrainModule; kind?: Mission['kind']; title: string; commune: string; quartier?: string;
  center?: LatLon; radiusM?: number; objectIds?: string[]; objectives: { findings: number; objects?: number };
  instructions?: string; periodStart: string; dueDate: string;
}
export interface FindingInput {
  clientRef: string; objectId?: string; outcome: FindingOutcome; observations: string;
  gps: { lat: number; lon: number; accuracyM: number; source?: 'GPS' | 'MANUEL' | 'ZONE' }; photoSha256?: string; capturedAt: string; deviceId?: string; justification?: string;
}

/**
 * Clé d'un terminal enrôlé par les données initiales : secret configuré s'il existe ; sinon clé connue en mode
 * démonstration SEULEMENT, et clé aléatoire hors démonstration (une clé prévisible permettrait de signer des
 * synchronisations au nom de l'agent).
 */
export function seedDeviceKey(deviceId: string, configured: Record<string, string> = {}, demo = isDemoMode()): string {
  return configured[deviceId] ?? (demo ? `demo-key-${deviceId}` : randomSecret(16));
}

export class TerrainService {
  readonly subcontractors = new InMemoryRepository<Subcontractor>();
  readonly lots = new InMemoryRepository<Lot>();
  readonly agents = new InMemoryRepository<FieldAgent>();
  readonly badges = new InMemoryRepository<AgentBadge>();
  readonly missions = new InMemoryRepository<Mission>();
  readonly findings = new InMemoryRepository<Finding>();
  readonly samples = new InMemoryAppendOnlyRepository<QualitySample>();
  readonly counterVisits = new InMemoryRepository<CounterVisit>();
  readonly mysteryChecks = new InMemoryRepository<MysteryCheck>();
  readonly verifications = new InMemoryAppendOnlyRepository<BadgeVerification>();
  /** Tolérance GPS par commune (mètres) — paramètre de la régie. */
  private readonly tolerances = new Map<string, number>();
  private readonly ids = new IdGenerator();
  private readonly badgeKey: string;

  constructor(private readonly ctx: AppContext) {
    // Clé de signature des QR de badge, dérivée de la clé serveur (production : HSM, clé dédiée).
    this.badgeKey = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:terrain:badge-qr:v1');
  }

  // ─────────────────────────── utilitaires ───────────────────────────

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }
  private today(): string {
    return kinshasaDate(this.ctx.clock.now());
  }
  private actor(u: User): AuditActor {
    return { kind: 'user', id: u.id, roles: u.roles };
  }
  private audit(u: User | null, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}): void {
    this.ctx.audit.append({ actor: u ? this.actor(u) : { kind: 'public', id: 'anonyme' }, action, resourceType, resourceId, details });
  }
  private notify(eventCode: string, userIds: string[], vars: Record<string, string>, entity?: string): void {
    const recipients = userIds.map((id) => this.ctx.users.get(id)).filter((u): u is User => !!u).map(userRecipient);
    if (recipients.length > 0) this.ctx.comms.publish(eventCode, recipients, vars, entity ? { entity } : {});
  }
  /** Utilisateur limité à son sous-traitant (R35 sans rôle de régie ni de contrôle). */
  private scopedSubcontractor(u: User): Subcontractor | null | undefined {
    if (u.roles.some((r) => BROAD_ROLES.includes(r))) return undefined;
    if (!u.roles.includes('R35')) return undefined;
    return this.subcontractors.findOne((s) => s.entity === u.entity) ?? null;
  }
  private assertOwnSubcontractor(u: User, st: Subcontractor): void {
    const scoped = this.scopedSubcontractor(u);
    if (scoped === undefined) return;
    if (!scoped || scoped.id !== st.id) throw forbidden('OUT_OF_SCOPE', 'Hors du périmètre de votre structure.');
  }
  private isFieldAgentOnly(u: User): boolean {
    return u.roles.includes('R10') && !u.roles.some((r) => BROAD_ROLES.includes(r) || r === 'R35');
  }
  private inTerritory(u: User, commune: string): boolean {
    if (!u.roles.includes('R09') || u.roles.some((r) => ['R06', 'R07', 'R11', 'R22', 'R23', 'R24'].includes(r))) return true;
    return !u.territory || u.territory.includes(commune);
  }
  private reason(r: string | undefined): string {
    const v = (r ?? '').trim();
    if (v.length < 5) throw badRequest('REASON_REQUIRED', 'Décision motivée requise (motif d’au moins 5 caractères).');
    return v;
  }

  toleranceFor(commune: string): number {
    return this.tolerances.get(commune) ?? DEFAULT_GPS_TOLERANCE_M;
  }
  tolerancesView() {
    return { defaultM: DEFAULT_GPS_TOLERANCE_M, byCommune: Object.fromEntries(this.tolerances), parameter: true, note: 'Paramètre fixé par la régie (valeurs de démonstration).' };
  }
  setTolerance(u: User, commune: string, meters: number, reason: string) {
    authorize(u, A.settingsManage);
    const why = this.reason(reason);
    const before = this.toleranceFor(commune);
    this.tolerances.set(commune, meters);
    this.audit(u, 'terrain.settings.gps_tolerance', 'commune', commune, { before, after: meters, reason: why });
    return this.tolerancesView();
  }

  // ─────────────────────────── sous-traitants ───────────────────────────

  listSubcontractors(u: User): Subcontractor[] {
    authorize(u, A.subcontractorRead);
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return [];
    return scoped ? [scoped] : this.subcontractors.all();
  }

  getSubcontractor(u: User, id: string): Subcontractor {
    authorize(u, A.subcontractorRead);
    const st = this.subcontractors.get(id);
    if (!st) throw notFound('SUBCONTRACTOR_NOT_FOUND', `Sous-traitant inconnu : ${id}`);
    this.assertOwnSubcontractor(u, st);
    return st;
  }

  private mustGet(id: string): Subcontractor {
    const st = this.subcontractors.get(id);
    if (!st) throw notFound('SUBCONTRACTOR_NOT_FOUND', `Sous-traitant inconnu : ${id}`);
    return st;
  }

  private transition(u: User, st: Subcontractor, to: SubcontractorStatus, reason: string, patch: Partial<Subcontractor> = {}): Subcontractor {
    const updated = this.subcontractors.update({
      ...st, ...patch, status: to, history: [...st.history, { at: this.now(), by: u.id, from: st.status, to, reason }],
    });
    this.audit(u, `terrain.subcontractor.${to.toLowerCase()}`, 'subcontractor', st.id, { from: st.status, to, reason });
    return updated;
  }

  /** Invitation après sélection hors plateforme : aucune inscription libre (§ 15A.3). */
  inviteSubcontractor(u: User, input: InviteSubcontractorInput, opts: { id?: string; entity?: string; managerId?: string; demo?: boolean } = {}) {
    authorize(u, A.subcontractorManage);
    let id = opts.id ?? this.ids.next('ST', 4);
    while (!opts.id && this.subcontractors.get(id)) id = this.ids.next('ST', 4);
    const entity = opts.entity ?? `ST-${id.split('-')[1]}`;
    if (this.subcontractors.findOne((s) => s.entity === entity)) throw conflict('ENTITY_TAKEN', `Code d’entité déjà utilisé : ${entity}`);
    const managerId = opts.managerId ?? `terrain-${entity.toLowerCase()}-resp`;
    const manager = this.ctx.users.add({ id: managerId, name: `${input.managerName}${opts.demo ? ' (démo)' : ''}`, roles: ['R35'], entity });
    const st = this.subcontractors.insert({
      id, entity, name: input.name, managers: [manager.id], capacityAgents: input.capacityAgents, requestedModules: input.requestedModules,
      status: 'INVITE', invitedBy: u.id, invitedAt: this.now(), selectionReference: input.selectionReference, history: [],
      ...(opts.demo ? { demo: true } : {}),
    });
    this.audit(u, 'terrain.subcontractor.invited', 'subcontractor', id, { name: input.name, selectionReference: input.selectionReference, managerId });
    return { subcontractor: st, managerUserId: manager.id };
  }

  submitDossier(u: User, id: string, input: DossierInput): Subcontractor {
    authorize(u, A.subcontractorDossier);
    const st = this.mustGet(id);
    this.assertOwnSubcontractor(u, st);
    if (!['INVITE', 'EN_DILIGENCE'].includes(st.status)) throw conflict('INVALID_STATE', `Dossier non modifiable au statut ${st.status}.`);
    const patch: Partial<Subcontractor> = {
      rccm: input.rccm, nif: input.nif, ...(input.references ? { references: input.references } : {}),
      ...(input.capacityAgents ? { capacityAgents: input.capacityAgents } : {}),
      ...(input.requestedModules ? { requestedModules: input.requestedModules } : {}),
    };
    if (st.status === 'INVITE') return this.transition(u, st, 'EN_DILIGENCE', 'Dossier complété', patch);
    const updated = this.subcontractors.update({ ...st, ...patch });
    this.audit(u, 'terrain.subcontractor.dossier_updated', 'subcontractor', id, {});
    return updated;
  }

  recordDiligence(u: User, id: string, input: DiligenceInput): Subcontractor {
    authorize(u, A.subcontractorManage);
    const st = this.mustGet(id);
    if (st.status !== 'EN_DILIGENCE') throw conflict('INVALID_STATE', 'La diligence porte sur un dossier « en diligence ».');
    const updated = this.subcontractors.update({ ...st, diligence: { ...input, checkedBy: u.id, checkedAt: this.now() } });
    this.audit(u, 'terrain.subcontractor.diligence', 'subcontractor', id, { ...input });
    return updated;
  }

  /** Étape « maker » : proposition motivée d'accréditation par module, durée limitée, période probatoire. */
  proposeAccreditation(u: User, id: string, input: ProposalInput): Subcontractor {
    authorize(u, A.subcontractorAccredit);
    const st = this.mustGet(id);
    if (st.status !== 'EN_DILIGENCE') throw conflict('INVALID_STATE', `Proposition impossible au statut ${st.status}.`);
    const d = st.diligence;
    if (!d || !d.legalExistence || !d.taxClearance || !d.noConflictOfInterest || !d.publicAgentLinksDeclared) {
      throw unprocessable('DILIGENCE_INCOMPLETE', 'Diligence incomplète : existence légale, quitus fiscal, absence de conflit d’intérêts et déclaration des liens sont requis.');
    }
    const today = this.today();
    if (!(input.probationUntil > today && input.probationUntil <= input.validUntil)) {
      throw badRequest('INVALID_PERIOD', 'La période probatoire doit être future et précéder la fin de l’accréditation.');
    }
    const updated = this.subcontractors.update({ ...st, proposal: { ...input, reason: this.reason(input.reason), proposedBy: u.id, proposedAt: this.now() } });
    this.audit(u, 'terrain.subcontractor.accreditation_proposed', 'subcontractor', id, { modules: input.modules, communes: input.communes, validUntil: input.validUntil, probationUntil: input.probationUntil });
    return updated;
  }

  /** Étape « checker » : approbation par une AUTRE personne ; accréditation probatoire sur lot réduit. */
  approveAccreditation(u: User, id: string, reason: string): Subcontractor {
    authorize(u, A.subcontractorAccredit);
    const st = this.mustGet(id);
    if (st.status !== 'EN_DILIGENCE' || !st.proposal) throw conflict('NO_PROPOSAL', 'Aucune proposition d’accréditation en attente.');
    assertDistinctPerson(u.id, [st.proposal.proposedBy], 'Maker-checker : l’approbation doit être donnée par une autre personne que l’auteur de la proposition.');
    const why = this.reason(reason);
    const updated = this.transition(u, st, 'ACCREDITE_PROBATOIRE', why, {
      accreditation: { ...st.proposal, approvedBy: u.id, approvedAt: this.now() },
    });
    this.notify('subcontractor.agent.accredited', st.managers, { agent: st.name }, st.entity);
    return updated;
  }

  /** Fin de période probatoire : décision humaine motivée, au vu du tableau de qualité. */
  confirmAccreditation(u: User, id: string, reason: string) {
    authorize(u, A.subcontractorAccredit);
    const st = this.mustGet(id);
    if (st.status !== 'ACCREDITE_PROBATOIRE' || !st.accreditation) throw conflict('INVALID_STATE', 'Seul un sous-traitant en période probatoire peut être confirmé.');
    if (this.today() < st.accreditation.probationUntil) {
      throw unprocessable('PROBATION_NOT_OVER', `Période probatoire en cours jusqu’au ${st.accreditation.probationUntil}.`);
    }
    const quality = this.qualityRows(this.findings.find((f) => f.subcontractorId === id), this.counterVisits.all(), 'subcontractor');
    const updated = this.transition(u, st, 'ACCREDITE', this.reason(reason));
    return { subcontractor: updated, qualityAtDecision: quality[0] ?? null };
  }

  setContract(u: User, id: string, contract: ContractUnitPrices): Subcontractor {
    authorize(u, A.subcontractorManage);
    const st = this.mustGet(id);
    if (!ACCREDITED.includes(st.status)) throw conflict('INVALID_STATE', 'Le contrat se rattache à un sous-traitant accrédité.');
    const updated = this.subcontractors.update({ ...st, contract });
    this.audit(u, 'terrain.subcontractor.contract_set', 'subcontractor', id, { reference: contract.reference, example: contract.example });
    return updated;
  }

  /** Suspension motivée : révoque d'un coup tous les agents, leurs badges et leurs terminaux (§ 15A.4). */
  suspendSubcontractor(u: User, id: string, reason: string) {
    authorize(u, A.subcontractorManage);
    const st = this.mustGet(id);
    if (!ACCREDITED.includes(st.status)) throw conflict('INVALID_STATE', `Suspension impossible au statut ${st.status}.`);
    const why = this.reason(reason);
    const updated = this.transition(u, st, 'SUSPENDU', why, { statusBeforeSuspension: st.status });
    const affected = this.cascadeAgents(u, id, 'SUSPENDU', `Suspension du sous-traitant : ${why}`);
    return { subcontractor: updated, agentsSuspended: affected };
  }

  reinstateSubcontractor(u: User, id: string, reason: string): Subcontractor {
    authorize(u, A.subcontractorManage);
    const st = this.mustGet(id);
    if (st.status !== 'SUSPENDU' || !st.statusBeforeSuspension) throw conflict('INVALID_STATE', 'Le sous-traitant n’est pas suspendu.');
    // Les agents restent suspendus : chacun doit être ré-habilité individuellement par la régie.
    return this.transition(u, st, st.statusBeforeSuspension, this.reason(reason), { statusBeforeSuspension: undefined });
  }

  withdrawSubcontractor(u: User, id: string, reason: string) {
    authorize(u, A.subcontractorManage);
    const st = this.mustGet(id);
    if (st.status === 'RETIRE') throw conflict('INVALID_STATE', 'Accréditation déjà retirée.');
    const why = this.reason(reason);
    const updated = this.transition(u, st, 'RETIRE', why);
    const affected = this.cascadeAgents(u, id, 'REVOQUE', `Retrait de l’accréditation : ${why}`);
    for (const l of this.lots.find((x) => x.subcontractorId === id && x.status === 'OUVERT')) this.lots.update({ ...l, status: 'CLOS' });
    return { subcontractor: updated, agentsRevoked: affected };
  }

  private cascadeAgents(u: User, subcontractorId: string, to: 'SUSPENDU' | 'REVOQUE', reason: string): string[] {
    const out: string[] = [];
    for (const a of this.agents.find((x) => x.subcontractorId === subcontractorId && (x.status === 'HABILITE' || (to === 'REVOQUE' && x.status !== 'REVOQUE')))) {
      this.setAgentStatus(u, a, to, reason);
      out.push(a.id);
    }
    return out;
  }

  // ─────────────────────────── lots ───────────────────────────

  createLot(u: User, input: LotInput, opts: { id?: string; demo?: boolean } = {}): Lot {
    authorize(u, A.lotManage);
    if (input.periodEnd < input.periodStart) throw badRequest('INVALID_PERIOD', 'Période du lot invalide.');
    let probation = false;
    if (input.subcontractorId) {
      const st = this.mustGet(input.subcontractorId);
      if (!ACCREDITED.includes(st.status) || !st.accreditation) throw conflict('NOT_ACCREDITED', 'Lot attribuable seulement à un sous-traitant accrédité.');
      if (!st.accreditation.modules.includes(input.module)) throw unprocessable('MODULE_NOT_ACCREDITED', `Sous-traitant non accrédité pour le module ${input.module}.`);
      if (!st.accreditation.communes.includes(input.commune)) throw unprocessable('ZONE_NOT_ACCREDITED', `Sous-traitant non accrédité pour la commune ${input.commune}.`);
      if (input.periodEnd > st.accreditation.validUntil) throw unprocessable('LOT_BEYOND_ACCREDITATION', 'Le lot dépasse la durée de l’accréditation.');
      probation = st.status === 'ACCREDITE_PROBATOIRE';
      if (probation && input.maxAgents > PROBATION_MAX_AGENTS) {
        throw unprocessable('PROBATION_LOT_TOO_LARGE', `Période probatoire : lot réduit, ${PROBATION_MAX_AGENTS} agents au plus.`);
      }
    }
    const lot = this.lots.insert({
      id: opts.id ?? this.ids.next('LOT', 4), ...(input.subcontractorId ? { subcontractorId: input.subcontractorId } : {}),
      module: input.module, commune: input.commune, quartiers: input.quartiers, periodStart: input.periodStart, periodEnd: input.periodEnd,
      maxAgents: input.maxAgents, probation, status: 'OUVERT', createdBy: u.id, createdAt: this.now(), ...(opts.demo ? { demo: true } : {}),
    });
    this.audit(u, 'terrain.lot.created', 'lot', lot.id, { subcontractorId: input.subcontractorId, commune: input.commune, probation });
    return lot;
  }

  listLots(u: User): Lot[] {
    authorize(u, A.missionRead);
    if (this.isFieldAgentOnly(u)) throw forbidden('FORBIDDEN', 'Les lots sont visibles des gestionnaires.');
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return [];
    return this.lots.find((l) => (scoped ? l.subcontractorId === scoped.id : true));
  }

  closeLot(u: User, id: string, reason: string): Lot {
    authorize(u, A.lotManage);
    const lot = this.lots.get(id);
    if (!lot) throw notFound('LOT_NOT_FOUND', `Lot inconnu : ${id}`);
    const updated = this.lots.update({ ...lot, status: 'CLOS' });
    this.audit(u, 'terrain.lot.closed', 'lot', id, { reason: this.reason(reason) });
    return updated;
  }

  // ─────────────────────────── agents et badges ───────────────────────────

  /** Le gestionnaire invite un agent : compte nominatif créé INACTIF jusqu'à l'habilitation par la régie. */
  inviteAgent(u: User, subcontractorId: string | undefined, input: InviteAgentInput, opts: { id?: string; demo?: boolean } = {}): FieldAgent {
    authorize(u, A.agentInvite);
    let entity = u.entity;
    let territory: string[] | undefined;
    if (subcontractorId) {
      const st = this.mustGet(subcontractorId);
      this.assertOwnSubcontractor(u, st);
      if (!ACCREDITED.includes(st.status) || !st.accreditation) throw conflict('NOT_ACCREDITED', 'Seul un sous-traitant accrédité peut inviter des agents.');
      const active = this.agents.find((a) => a.subcontractorId === st.id && a.status !== 'REVOQUE').length;
      if (active >= st.capacityAgents) throw unprocessable('AGENT_CAPACITY_REACHED', `Nombre maximal d’agents atteint (${st.capacityAgents}).`);
      entity = st.entity;
      territory = st.accreditation.communes;
    } else if (u.roles.includes('R35') && !u.roles.includes('R07')) {
      throw forbidden('OUT_OF_SCOPE', 'Un sous-traitant invite ses agents dans sa structure.');
    }
    let id = opts.id ?? `terrain-ag-${this.ids.next('A', 4).split('-')[1]}`;
    while (!opts.id && this.ctx.users.get(id)) id = `terrain-ag-${this.ids.next('A', 4).split('-')[1]}`;
    this.ctx.users.add({ id, name: `${input.displayName}${opts.demo ? ' (démo)' : ''}`, roles: ['R10'], entity, ...(territory ? { territory } : {}) });
    const agent = this.agents.insert({
      id, displayName: input.displayName, ...(subcontractorId ? { subcontractorId } : {}), entity, status: 'INVITE', invitedBy: u.id, invitedAt: this.now(),
      declaredQuartiers: input.declaredQuartiers ?? [], declaredObjectIds: input.declaredObjectIds ?? [],
      ...(input.photoRef ? { photoRef: input.photoRef } : {}), history: [{ at: this.now(), by: u.id, to: 'INVITE', reason: 'Invitation' }],
      ...(opts.demo ? { demo: true } : {}),
    });
    this.audit(u, 'terrain.agent.invited', 'field_agent', id, { subcontractorId, entity });
    return agent;
  }

  /** Rattache un compte R10 existant (équipe interne) au registre des agents, sans l'habiliter. */
  registerInternalAgent(u: User, userId: string, input: InviteAgentInput): FieldAgent {
    authorize(u, A.agentInvite);
    const target = this.ctx.users.get(userId);
    if (!target || !target.roles.includes('R10')) throw unprocessable('NOT_A_FIELD_AGENT', 'Le compte doit porter le rôle Agent de terrain (R10).');
    if (this.agents.get(userId)) throw conflict('AGENT_EXISTS', 'Agent déjà enregistré.');
    const agent = this.agents.insert({
      id: userId, displayName: input.displayName, entity: target.entity, status: 'INVITE', invitedBy: u.id, invitedAt: this.now(),
      declaredQuartiers: input.declaredQuartiers ?? [], declaredObjectIds: input.declaredObjectIds ?? [],
      ...(input.photoRef ? { photoRef: input.photoRef } : {}), history: [{ at: this.now(), by: u.id, to: 'INVITE', reason: 'Rattachement équipe interne' }],
    });
    this.audit(u, 'terrain.agent.registered', 'field_agent', userId, {});
    return agent;
  }

  /** Habilitation par la régie : identité, certification, engagement déontologique, terminal enrôlé. */
  habilitateAgent(u: User, agentId: string, input: HabilitationInput) {
    authorize(u, A.agentHabilitate);
    const agent = this.agents.get(agentId);
    if (!agent) throw notFound('AGENT_NOT_FOUND', `Agent inconnu : ${agentId}`);
    if (!['INVITE', 'SUSPENDU'].includes(agent.status)) throw conflict('INVALID_STATE', `Habilitation impossible au statut ${agent.status}.`);
    const today = this.today();
    if (!input.identityVerified) throw unprocessable('IDENTITY_NOT_VERIFIED', 'Identité non vérifiée : habilitation refusée.');
    if (!input.trainingCertificateRef.trim() || input.trainingValidUntil < today) throw unprocessable('TRAINING_NOT_CERTIFIED', 'Certification de formation absente ou expirée : habilitation refusée (module 50).');
    if (!input.ethicsSigned) throw unprocessable('ETHICS_NOT_SIGNED', 'Engagement déontologique non signé : habilitation refusée.');
    if (input.validUntil < today) throw badRequest('INVALID_PERIOD', 'Fin d’habilitation passée.');
    if (agent.subcontractorId) {
      const st = this.mustGet(agent.subcontractorId);
      if (!ACCREDITED.includes(st.status) || !st.accreditation) throw conflict('SUBCONTRACTOR_NOT_ACCREDITED', `Sous-traitant ${st.status} : aucun agent ne peut être habilité.`);
      if (!st.accreditation.modules.includes(input.module)) throw unprocessable('MODULE_NOT_ACCREDITED', 'Module hors accréditation du sous-traitant.');
      const outside = input.communes.filter((c) => !st.accreditation!.communes.includes(c));
      if (outside.length > 0) throw unprocessable('ZONE_NOT_ACCREDITED', `Communes hors accréditation : ${outside.join(', ')}.`);
      if (input.validUntil > st.accreditation.validUntil) throw unprocessable('BEYOND_ACCREDITATION', 'L’habilitation ne peut dépasser l’accréditation du sous-traitant.');
    }
    // Terminal : enrôlé, actif et affecté à cet agent ; sinon enrôlement d'un nouveau terminal.
    let deviceId = input.deviceId ?? `dev-${agentId}`;
    let deviceKeyOnce: string | undefined;
    const existing = this.ctx.field.devices.get(deviceId);
    if (existing) {
      if (existing.agentUserId !== agentId) throw forbidden('DEVICE_USER_MISMATCH', 'Ce terminal est affecté à un autre agent.');
      if (existing.status !== 'ACTIF') {
        deviceId = `${deviceId}-${this.ids.next('R', 3).split('-')[1]}`;
      }
    }
    if (!this.ctx.field.devices.get(deviceId)) {
      deviceKeyOnce = randomSecret(16);
      this.ctx.field.enroll(deviceId, agentId, deviceKeyOnce);
      this.audit(u, 'auth.device.enrolled', 'device', deviceId, { agentId });
    }
    const habilitation = {
      identityVerified: true, trainingCertificateRef: input.trainingCertificateRef, trainingValidUntil: input.trainingValidUntil,
      ethicsSignedAt: this.now(), deviceId, module: input.module, communes: input.communes, validUntil: input.validUntil, decidedBy: u.id, decidedAt: this.now(),
    };
    const target = this.ctx.users.get(agentId);
    if (target) target.territory = [...input.communes];
    const updated = this.setAgentStatus(u, { ...agent, habilitation }, 'HABILITE', 'Habilitation par la régie');
    const badge = this.issueBadge(u, updated);
    this.notify('subcontractor.agent.accredited', [agentId, ...(agent.subcontractorId ? this.mustGet(agent.subcontractorId).managers : [])], { agent: agent.displayName });
    return { agent: updated, badge: this.badgeView(badge), deviceId, ...(deviceKeyOnce ? { deviceKeyOnce } : {}) };
  }

  private setAgentStatus(u: User, agent: FieldAgent, to: AgentStatus, reason: string): FieldAgent {
    const updated = this.agents.update({ ...agent, status: to, history: [...agent.history, { at: this.now(), by: u.id, to, reason }] });
    if (to === 'SUSPENDU' || to === 'REVOQUE') {
      for (const b of this.badges.find((x) => x.agentId === agent.id && x.status !== 'REVOQUE')) {
        this.badges.update({ ...b, status: to === 'SUSPENDU' ? 'SUSPENDU' : 'REVOQUE', revokedAt: this.now(), revocationReason: reason });
      }
      // Révocation immédiate de tous ses terminaux (effacement à distance).
      for (const d of this.ctx.field.devices.find((x) => x.agentUserId === agent.id && x.status === 'ACTIF')) this.ctx.field.revoke(d.id, reason);
      // Missions non achevées : rendues au gestionnaire pour réaffectation.
      for (const m of this.missions.find((x) => x.assignedAgentId === agent.id && OPEN_MISSION.includes(x.status))) {
        const { assignedAgentId: _a, assignedAt: _b, assignedBy: _c, ...rest } = m;
        this.missions.update({ ...rest, status: 'A_AFFECTER' });
      }
      this.notify('subcontractor.agent.revoked', [agent.id], { agent: agent.displayName });
    }
    this.audit(u, `terrain.agent.${to.toLowerCase()}`, 'field_agent', agent.id, { reason, subcontractorId: agent.subcontractorId });
    return updated;
  }

  suspendAgent(u: User, agentId: string, reason: string): FieldAgent {
    authorize(u, A.agentSuspend);
    const agent = this.agents.get(agentId);
    if (!agent) throw notFound('AGENT_NOT_FOUND', `Agent inconnu : ${agentId}`);
    const scoped = this.scopedSubcontractor(u);
    if (scoped !== undefined && (!scoped || agent.subcontractorId !== scoped.id)) throw forbidden('OUT_OF_SCOPE', 'Agent hors de votre structure.');
    if (agent.status !== 'HABILITE') throw conflict('INVALID_STATE', `Suspension impossible au statut ${agent.status}.`);
    return this.setAgentStatus(u, agent, 'SUSPENDU', this.reason(reason));
  }

  revokeAgent(u: User, agentId: string, reason: string): FieldAgent {
    authorize(u, A.agentSuspend);
    const agent = this.agents.get(agentId);
    if (!agent) throw notFound('AGENT_NOT_FOUND', `Agent inconnu : ${agentId}`);
    const scoped = this.scopedSubcontractor(u);
    if (scoped !== undefined && (!scoped || agent.subcontractorId !== scoped.id)) throw forbidden('OUT_OF_SCOPE', 'Agent hors de votre structure.');
    if (agent.status === 'REVOQUE') throw conflict('INVALID_STATE', 'Agent déjà révoqué.');
    return this.setAgentStatus(u, agent, 'REVOQUE', this.reason(reason));
  }

  listAgents(u: User) {
    authorize(u, A.agentRead);
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return [];
    return this.agents
      .find((a) => (scoped ? a.subcontractorId === scoped.id : true))
      .map((a) => ({ ...a, badge: this.activeBadgeView(a.id) }));
  }

  private shortCode(): string {
    for (;;) {
      const body = randomCode(6);
      const code = `AG-${body}-${checkChar(`AG${body}`)}`;
      if (!this.badges.findOne((b) => b.shortCode === code)) return code;
    }
  }
  private qrToken(b: Pick<AgentBadge, 'id' | 'shortCode' | 'validUntil'>): string {
    return hmacSha256Hex(this.badgeKey, `${b.id}|${b.shortCode}|${b.validUntil}`).slice(0, 24);
  }

  private issueBadge(u: User, agent: FieldAgent, fixedCode?: string): AgentBadge {
    const h = agent.habilitation;
    if (!h) throw conflict('NOT_HABILITATED', 'Badge délivré seulement après habilitation.');
    for (const b of this.badges.find((x) => x.agentId === agent.id && x.status !== 'REVOQUE')) {
      this.badges.update({ ...b, status: 'REVOQUE', revokedAt: this.now(), revocationReason: 'Remplacé par un nouveau badge' });
    }
    const id = this.ids.next('BDG');
    const shortCode = fixedCode ?? this.shortCode();
    const base = { id, shortCode, validUntil: h.validUntil };
    const badge = this.badges.insert({
      ...base, agentId: agent.id, qrToken: this.qrToken(base), module: h.module, communes: h.communes, validFrom: this.today(),
      status: 'ACTIF', issuedAt: this.now(), issuedBy: u.id,
    });
    this.audit(u, 'terrain.badge.issued', 'agent_badge', id, { agentId: agent.id, shortCode });
    return badge;
  }

  reissueBadge(u: User, agentId: string, reason: string) {
    authorize(u, A.badgeIssue);
    const agent = this.agents.get(agentId);
    if (!agent) throw notFound('AGENT_NOT_FOUND', `Agent inconnu : ${agentId}`);
    if (agent.status !== 'HABILITE') throw conflict('INVALID_STATE', 'Réémission réservée à un agent habilité.');
    const why = this.reason(reason);
    const badge = this.issueBadge(u, agent);
    this.audit(u, 'terrain.badge.reissued', 'agent_badge', badge.id, { agentId, reason: why });
    return this.badgeView(badge);
  }

  private badgeView(b: AgentBadge) {
    return { ...b, qrPath: `/verifier-agent/${b.shortCode}?t=${b.qrToken}` };
  }
  private activeBadgeView(agentId: string) {
    const b = this.badges.findOne((x) => x.agentId === agentId && x.status !== 'REVOQUE');
    return b ? this.badgeView(b) : null;
  }

  private structureOf(agent: FieldAgent): string {
    if (agent.subcontractorId) return this.subcontractors.get(agent.subcontractorId)?.name ?? agent.entity;
    return agent.entity;
  }

  /**
   * Vérification publique d'un badge (scan, SMS, SVI) — divulgation minimale : ni téléphone, ni adresse,
   * ni identifiant de compte. Un QR dont la signature ne correspond pas est traité comme inconnu.
   */
  publicVerify(rawCode: string, token: string | undefined, channel: BadgeVerification['channel']) {
    const code = rawCode.trim().toUpperCase().replace(/\s+/g, '');
    const normalized = code.replace(/-/g, '');
    const badge = this.badges.findOne((b) => b.shortCode.replace(/-/g, '') === normalized);
    const advice = 'Aucun agent ni sous-traitant n’encaisse d’argent : payez uniquement par les canaux officiels. En cas de doute, signalez-le.';
    let result: PublicBadgeResult = 'INCONNU';
    if (badge && (!token || safeEqualHex(this.qrToken(badge), token.toLowerCase()))) {
      if (badge.status === 'REVOQUE') result = 'REVOQUE';
      else if (badge.status === 'SUSPENDU') result = 'SUSPENDU';
      else if (badge.validUntil < this.today()) result = 'EXPIRE';
      else result = 'VALIDE';
    }
    this.verifications.append({ id: this.ids.next('VRB', 8), at: this.now(), shortCode: badge ? badge.shortCode : code.slice(0, 20), result, channel });
    if (result === 'INCONNU' || !badge) {
      return { result, checkedAt: this.now(), advice, reportable: true };
    }
    const agent = this.agents.get(badge.agentId)!;
    const active = result === 'VALIDE';
    return {
      result, checkedAt: this.now(), advice, reportable: !active,
      badge: {
        shortCode: badge.shortCode,
        displayName: agent.displayName,
        structure: this.structureOf(agent),
        structureKind: agent.subcontractorId ? 'SOUS_TRAITANT_ACCREDITE' : 'REGIE',
        module: badge.module,
        communes: badge.communes,
        validFrom: badge.validFrom,
        validUntil: badge.validUntil,
        validity: active ? validityView(badge.validFrom, badge.validUntil, this.ctx.clock.now()) : null,
        hasPhoto: !!agent.photoRef,
        ...(agent.photoRef && active ? { photoRef: agent.photoRef } : {}),
      },
    };
  }

  /** Signalement d'un faux agent ou d'un agent hors zone : anonyme, transmis à l'enquêteur (module 69). */
  reportAgent(rawCode: string, input: { place: string; description: string; kind: 'FAUX_AGENT' | 'HORS_ZONE' | 'DEMANDE_ESPECES' }) {
    const reference = `SIG-AG-${randomCode(8)}`;
    const code = rawCode.trim().toUpperCase().slice(0, 20);
    const eventCode = input.kind === 'DEMANDE_ESPECES' ? 'fraud.cash_request_reported' : 'fraud.fake_agent_reported';
    this.ctx.alerts.raise({
      type: input.kind === 'DEMANDE_ESPECES' ? 'CASH_REQUEST_REPORTED' : 'FAKE_AGENT_REPORTED', severity: 'MEDIUM', source: 'terrain',
      detail: `Signalement ${reference} (${input.kind}) — badge ${code} — lieu : ${input.place}`, context: { reference, badge: code }, actor: { kind: 'public', id: 'anonyme' },
    });
    this.notify(eventCode, this.ctx.users.withRole('R24').map((x) => x.id), { lieu: input.place, reference });
    this.audit(null, 'terrain.badge.reported', 'agent_badge', code, { reference, kind: input.kind, place: input.place });
    return { reference, status: 'RECU', message: 'Signalement reçu et transmis à l’enquêteur anti-fraude. Votre identité n’est pas demandée.' };
  }

  // ─────────────────────────── missions ───────────────────────────

  createMission(u: User, input: MissionInput, opts: { id?: string; demo?: boolean } = {}): Mission {
    authorize(u, A.missionCreate);
    if (input.dueDate < input.periodStart) throw badRequest('INVALID_PERIOD', 'Échéance antérieure au début de mission.');
    const scoped = this.scopedSubcontractor(u);
    let lot: Lot | undefined;
    if (input.lotId) {
      lot = this.lots.get(input.lotId);
      if (!lot) throw notFound('LOT_NOT_FOUND', `Lot inconnu : ${input.lotId}`);
    }
    if (scoped !== undefined) {
      // Un sous-traitant ne crée de mission que dans un lot qui lui est attribué.
      if (!scoped || !lot || lot.subcontractorId !== scoped.id) throw forbidden('MISSION_OUTSIDE_LOT', 'Aucune mission hors du lot attribué.');
    }
    if (lot) {
      if (lot.status !== 'OUVERT') throw conflict('LOT_CLOSED', 'Lot clos.');
      const outside =
        input.commune !== lot.commune ||
        (input.quartier !== undefined && lot.quartiers.length > 0 && !lot.quartiers.includes(input.quartier)) ||
        input.periodStart < lot.periodStart || input.dueDate > lot.periodEnd ||
        (input.module !== undefined && input.module !== lot.module);
      if (outside) throw unprocessable('MISSION_OUTSIDE_LOT', `Mission hors du lot ${lot.id} (commune ${lot.commune}, du ${lot.periodStart} au ${lot.periodEnd}).`);
    }
    if (!this.inTerritory(u, input.commune)) throw forbidden('OUT_OF_TERRITORY', `Commune ${input.commune} hors de votre territoire.`);
    const objectIds = input.objectIds ?? [];
    const objs = objectIds.map((id) => {
      const o = this.ctx.objects.objects.get(id);
      if (!o) throw unprocessable('OBJECT_NOT_FOUND', `Objet inconnu : ${id}`);
      if (o.commune !== input.commune) throw unprocessable('OBJECT_OUTSIDE_ZONE', `L’objet ${id} n’est pas dans la commune ${input.commune}.`);
      return o;
    });
    const center = input.center ?? (objs[0] ? { lat: objs[0].lat, lon: objs[0].lon } : undefined);
    if (!center) throw badRequest('CENTER_REQUIRED', 'Point central de la zone requis (ou au moins un objet).');
    const mission = this.missions.insert({
      id: opts.id ?? this.ids.next('MIS', 4), ...(lot ? { lotId: lot.id, ...(lot.subcontractorId ? { subcontractorId: lot.subcontractorId } : {}) } : {}),
      module: input.module ?? lot?.module ?? 'FONCIER_LOCATIF', kind: input.kind ?? 'RECENSEMENT', title: input.title, commune: input.commune,
      ...(input.quartier ? { quartier: input.quartier } : {}), center, radiusM: input.radiusM ?? 300, objectIds, objectives: input.objectives,
      instructions: input.instructions ?? '', periodStart: input.periodStart, dueDate: input.dueDate, status: 'A_AFFECTER',
      createdBy: u.id, createdAt: this.now(), ...(opts.demo ? { demo: true } : {}),
    });
    this.audit(u, 'terrain.mission.created', 'mission', mission.id, { lotId: mission.lotId, commune: mission.commune, objects: objectIds.length });
    return mission;
  }

  assignMission(u: User, missionId: string, agentId: string): Mission {
    authorize(u, A.missionAssign);
    const m = this.missions.get(missionId);
    if (!m) throw notFound('MISSION_NOT_FOUND', `Mission inconnue : ${missionId}`);
    const scoped = this.scopedSubcontractor(u);
    if (scoped !== undefined && (!scoped || m.subcontractorId !== scoped.id)) throw forbidden('MISSION_OUTSIDE_LOT', 'Mission hors du lot attribué à votre structure.');
    if (!this.inTerritory(u, m.commune)) throw forbidden('OUT_OF_TERRITORY', 'Mission hors de votre territoire.');
    if (!['A_AFFECTER', 'AFFECTEE'].includes(m.status)) throw conflict('INVALID_STATE', `Affectation impossible au statut ${m.status}.`);
    const agent = this.agents.get(agentId);
    if (!agent) throw notFound('AGENT_NOT_FOUND', `Agent inconnu : ${agentId}`);
    if (agent.status !== 'HABILITE' || !agent.habilitation) throw unprocessable('AGENT_NOT_HABILITATED', 'Agent non habilité par la régie : aucune mission possible.');
    if ((m.subcontractorId ?? null) !== (agent.subcontractorId ?? null)) throw unprocessable('AGENT_OUTSIDE_LOT', 'L’agent n’appartient pas à la structure titulaire du lot.');
    const h = agent.habilitation;
    if (!h.communes.includes(m.commune)) throw unprocessable('AGENT_OUT_OF_ZONE', `Agent non habilité pour la commune ${m.commune}.`);
    if (h.validUntil < m.dueDate) throw unprocessable('HABILITATION_EXPIRES', 'L’habilitation expire avant l’échéance de la mission.');
    if ((m.quartier && agent.declaredQuartiers.includes(m.quartier)) || m.objectIds.some((o) => agent.declaredObjectIds.includes(o))) {
      throw forbidden('CONFLICT_OF_INTEREST', 'Interdiction d’affecter un agent à son propre quartier ou aux objets de ses proches déclarés (§ 15A.5).');
    }
    if (m.lotId) {
      const lot = this.lots.get(m.lotId)!;
      const agentsOnLot = new Set(this.missions.find((x) => x.lotId === lot.id && !!x.assignedAgentId && x.status !== 'ANNULEE' && x.id !== m.id).map((x) => x.assignedAgentId!));
      agentsOnLot.add(agentId);
      if (agentsOnLot.size > lot.maxAgents) throw unprocessable('LOT_AGENT_LIMIT', `Nombre maximal d’agents du lot atteint (${lot.maxAgents}).`);
    }
    const updated = this.missions.update({ ...m, assignedAgentId: agentId, assignedBy: u.id, assignedAt: this.now(), status: 'AFFECTEE' });
    this.audit(u, 'terrain.mission.assigned', 'mission', m.id, { agentId, previous: m.assignedAgentId });
    this.notify('mission.assigned', [agentId], { mission: m.id });
    return updated;
  }

  private missionVisible(u: User, m: Mission): boolean {
    if (this.isFieldAgentOnly(u)) return m.assignedAgentId === u.id;
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return false;
    if (scoped) return m.subcontractorId === scoped.id;
    return this.inTerritory(u, m.commune);
  }

  private missionView(m: Mission) {
    const fs = this.findings.find((f) => f.missionId === m.id);
    const agent = m.assignedAgentId ? this.agents.get(m.assignedAgentId) : undefined;
    const objects = m.objectIds.map((id) => {
      const o = this.ctx.objects.objects.get(id);
      return o ? { id, category: o.category, commune: o.commune, quartier: o.quartier, lat: o.lat, lon: o.lon, status: o.status, visited: fs.some((f) => f.objectId === id) } : { id, missing: true };
    });
    return {
      ...m, objects, agentName: agent?.displayName ?? null, toleranceM: this.toleranceFor(m.commune),
      progress: {
        findings: fs.length, validated: fs.filter((f) => f.status === 'VALIDE').length, rejected: fs.filter((f) => f.status === 'REJETE').length,
        flagged: fs.filter((f) => f.flags.some((x) => x === 'DISTANCE' || x === 'HORS_ZONE')).length,
        objectivePct: pct(Math.min(fs.length, m.objectives.findings), m.objectives.findings),
      },
      overdue: OPEN_MISSION.concat('A_AFFECTER').includes(m.status) && m.dueDate < this.today(),
    };
  }

  listMissions(u: User, filter: { status?: MissionStatus; commune?: string } = {}) {
    authorize(u, A.missionRead);
    return this.missions
      .find((m) => this.missionVisible(u, m) && (!filter.status || m.status === filter.status) && (!filter.commune || m.commune === filter.commune))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((m) => this.missionView(m));
  }

  getMission(u: User, id: string) {
    authorize(u, A.missionRead);
    const m = this.missions.get(id);
    if (!m || !this.missionVisible(u, m)) throw notFound('MISSION_NOT_FOUND', `Mission inconnue : ${id}`);
    return { ...this.missionView(m), findings: this.findings.find((f) => f.missionId === id).map((f) => this.findingView(f)) };
  }

  completeMission(u: User, id: string): Mission {
    authorize(u, A.findingSubmit);
    const m = this.missions.get(id);
    if (!m || m.assignedAgentId !== u.id) throw forbidden('MISSION_NOT_ASSIGNED', 'Mission non affectée à cet agent.');
    if (!OPEN_MISSION.includes(m.status)) throw conflict('INVALID_STATE', `Mission au statut ${m.status}.`);
    const updated = this.missions.update({ ...m, status: 'TERMINEE', completedAt: this.now() });
    this.audit(u, 'terrain.mission.completed', 'mission', id, { onTime: this.today() <= m.dueDate });
    this.notify('mission.updated', this.supervisorsFor(m), { mission: id });
    return updated;
  }

  cancelMission(u: User, id: string, reason: string): Mission {
    authorize(u, A.missionCreate);
    const m = this.missions.get(id);
    if (!m || !this.missionVisible(u, m)) throw notFound('MISSION_NOT_FOUND', `Mission inconnue : ${id}`);
    if (['TERMINEE', 'ANNULEE'].includes(m.status)) throw conflict('INVALID_STATE', `Mission au statut ${m.status}.`);
    const updated = this.missions.update({ ...m, status: 'ANNULEE' });
    this.audit(u, 'terrain.mission.cancelled', 'mission', id, { reason: this.reason(reason) });
    return updated;
  }

  private supervisorsFor(m: Mission): string[] {
    const internal = this.ctx.users.withRole('R09').filter((s) => !s.territory || s.territory.includes(m.commune)).map((s) => s.id);
    const st = m.subcontractorId ? this.subcontractors.get(m.subcontractorId)?.managers ?? [] : [];
    return [...internal, ...st];
  }

  // ─────────────────────────── constats ───────────────────────────

  private findingView(f: Finding) {
    const agent = this.agents.get(f.agentId);
    return { ...f, agentName: agent?.displayName ?? f.agentId };
  }

  /**
   * Constat scellé lié à une mission : GPS, précision, empreinte SHA-256 de la photo (jamais le binaire),
   * horodatage ; écart au point enregistré signalé (jamais rejeté automatiquement). Aucune obligation créée.
   */
  submitFinding(u: User, missionId: string, input: FindingInput) {
    authorize(u, A.findingSubmit);
    const agent = this.agents.get(u.id);
    if (!agent || agent.status !== 'HABILITE' || !agent.habilitation) throw forbidden('AGENT_NOT_HABILITATED', 'Agent non habilité (ou suspendu) : aucun constat possible.');
    const today = this.today();
    const badge = this.badges.findOne((b) => b.agentId === u.id && b.status === 'ACTIF');
    if (!badge || badge.validUntil < today || agent.habilitation.validUntil < today) throw forbidden('HABILITATION_EXPIRED', 'Habilitation ou badge expiré.');
    const m = this.missions.get(missionId);
    if (!m || m.assignedAgentId !== u.id) throw forbidden('MISSION_NOT_ASSIGNED', 'Mission non affectée à cet agent.');

    const sealContent = {
      clientRef: input.clientRef, missionId, objectId: input.objectId ?? null, agentId: u.id, outcome: input.outcome, observations: input.observations,
      gps: input.gps, photoSha256: input.photoSha256 ?? null, capturedAt: input.capturedAt, deviceId: input.deviceId ?? null, justification: input.justification ?? null,
    };
    const seal = sha256Hex(canonicalJson(sealContent));
    const previous = this.findings.findOne((f) => f.agentId === u.id && f.clientRef === input.clientRef);
    if (previous) {
      if (previous.seal !== seal) throw conflict('CLIENT_REF_REUSED', 'Référence de constat déjà utilisée avec un autre contenu.');
      return { finding: this.findingView(previous), replayed: true };
    }
    if (!OPEN_MISSION.includes(m.status)) throw conflict('MISSION_CLOSED', `Mission au statut ${m.status} : aucun constat.`);
    if (today < m.periodStart || today > m.dueDate) throw unprocessable('OUTSIDE_MISSION_PERIOD', `Hors de la période de mission (${m.periodStart} → ${m.dueDate}).`);
    if (m.lotId) {
      const lot = this.lots.get(m.lotId)!;
      if (lot.status !== 'OUVERT' || today < lot.periodStart || today > lot.periodEnd) throw unprocessable('OUTSIDE_LOT_PERIOD', 'Hors de la période du lot attribué.');
    }
    if (!agent.habilitation.communes.includes(m.commune)) throw forbidden('AGENT_OUT_OF_ZONE', 'Commune hors habilitation.');
    const captured = new Date(input.capturedAt).getTime();
    if (captured > this.ctx.clock.now().getTime() + 5 * 60_000) throw badRequest('CAPTURE_IN_FUTURE', 'Horodatage de capture dans le futur.');
    if (kinshasaDay(input.capturedAt) < m.periodStart) throw unprocessable('OUTSIDE_MISSION_PERIOD', 'Capture antérieure au début de la mission.');
    if (input.deviceId) {
      const d = this.ctx.field.devices.get(input.deviceId);
      if (!d) throw forbidden('UNKNOWN_DEVICE', 'Terminal non enrôlé.');
      if (d.agentUserId !== u.id) throw forbidden('DEVICE_USER_MISMATCH', 'Ce terminal n’est pas affecté à cet agent.');
      if (d.status !== 'ACTIF') throw forbidden('DEVICE_REVOKED', 'Terminal révoqué.');
    }
    if (input.outcome !== 'OBJET_NON_ENREGISTRE' && m.objectIds.length > 0 && !input.objectId) {
      throw badRequest('OBJECT_REQUIRED', 'Objet de la mission requis pour ce type de constat.');
    }
    let reference: Finding['reference'] = { kind: 'ZONE_MISSION', lat: m.center.lat, lon: m.center.lon };
    if (input.objectId) {
      const o = this.ctx.objects.objects.get(input.objectId);
      if (!o) throw unprocessable('OBJECT_NOT_FOUND', `Objet inconnu : ${input.objectId}`);
      if (!m.objectIds.includes(o.id) && o.commune !== m.commune) throw unprocessable('OBJECT_OUTSIDE_MISSION', 'Objet hors de la mission.');
      reference = { kind: 'OBJET', lat: o.lat, lon: o.lon };
    }
    const tol = this.toleranceFor(m.commune);
    const dist = distanceM(input.gps, reference);
    const flags: Finding['flags'] = [];
    let flagMessage: string | undefined;
    if (reference.kind === 'OBJET' && dist > tol) {
      flags.push('DISTANCE');
      flagMessage = `Opération effectuée à ${dist} m du point enregistré — vérification requise`;
    }
    const fromCenter = distanceM(input.gps, m.center);
    if (fromCenter > m.radiusM + tol) {
      flags.push('HORS_ZONE');
      flagMessage ??= `Opération effectuée à ${fromCenter} m du centre de la zone de mission (rayon ${m.radiusM} m) — justification et vérification requises`;
    }
    if (input.gps.accuracyM > tol || (input.gps.source && input.gps.source !== 'GPS')) flags.push('GPS_IMPRECIS');
    if (!input.photoSha256 && (input.outcome === 'CONSTATE' || input.outcome === 'OBJET_NON_ENREGISTRE')) flags.push('SANS_PHOTO');

    const finding = this.findings.insert({
      id: this.ids.next('CST'), clientRef: input.clientRef, missionId, ...(input.objectId ? { objectId: input.objectId } : {}), agentId: u.id,
      ...(agent.subcontractorId ? { subcontractorId: agent.subcontractorId } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      commune: m.commune, outcome: input.outcome, observations: input.observations, gps: input.gps,
      ...(input.photoSha256 ? { photoSha256: input.photoSha256.toLowerCase() } : {}), capturedAt: input.capturedAt, receivedAt: this.now(),
      reference, distanceM: dist, toleranceM: tol, flags, ...(flagMessage ? { flagMessage } : {}),
      ...(input.justification ? { justification: input.justification } : {}), seal, probativeStatus: 'OBSERVE', status: 'SOUMIS',
    });
    if (m.status === 'AFFECTEE') this.missions.update({ ...m, status: 'EN_COURS' });
    this.audit(u, 'terrain.finding.submitted', 'finding', finding.id, { missionId, objectId: input.objectId, distanceM: dist, flags, seal });
    if (flags.includes('DISTANCE') || flags.includes('HORS_ZONE')) {
      this.audit(u, 'mission.geofence.breach', 'finding', finding.id, { message: flagMessage });
      this.notify('mission.geofence.breach', this.supervisorsFor(m), { mission: m.id });
    }
    return { finding: this.findingView(finding), replayed: false };
  }

  private findingVisible(u: User, f: Finding): boolean {
    if (this.isFieldAgentOnly(u)) return f.agentId === u.id;
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return false;
    if (scoped) return f.subcontractorId === scoped.id;
    return this.inTerritory(u, f.commune);
  }

  listFindings(u: User, filter: { missionId?: string; status?: Finding['status']; agentId?: string; flagged?: boolean } = {}) {
    authorize(u, A.missionRead);
    return this.findings
      .find((f) => this.findingVisible(u, f) && (!filter.missionId || f.missionId === filter.missionId) && (!filter.status || f.status === filter.status)
        && (!filter.agentId || f.agentId === filter.agentId) && (filter.flagged === undefined || filter.flagged === f.flags.length > 0))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map((f) => ({ ...this.findingView(f), counterVisit: this.counterVisits.findOne((c) => c.findingId === f.id) ?? null }));
  }

  /** Validation indépendante par la régie : ni l'auteur, ni sa structure ; décision motivée ; constat validé figé. */
  reviewFinding(u: User, id: string, decision: 'VALIDE' | 'REJETE', reason: string) {
    authorize(u, A.findingReview);
    const f = this.findings.get(id);
    if (!f) throw notFound('FINDING_NOT_FOUND', `Constat inconnu : ${id}`);
    assertDistinctPerson(u.id, [f.agentId], 'Séparation des tâches : un agent ne valide jamais ses propres constats.');
    if (f.subcontractorId && this.subcontractors.get(f.subcontractorId)?.entity === u.entity) {
      throw forbidden('NOT_INDEPENDENT', 'Contrôle indépendant requis : la structure du sous-traitant ne valide pas ses propres constats.');
    }
    if (!this.inTerritory(u, f.commune)) throw forbidden('OUT_OF_TERRITORY', 'Constat hors de votre territoire.');
    if (f.status === 'VALIDE' || f.status === 'REJETE') throw conflict('FINDING_ALREADY_REVIEWED', 'Constat déjà revu : un constat validé ou rejeté n’est plus modifiable.');
    if (f.status === 'A_CONTRE_VISITER') {
      const cv = this.counterVisits.findOne((c) => c.findingId === id);
      if (cv && cv.status !== 'REALISEE') throw conflict('COUNTER_VISIT_PENDING', 'Contre-visite d’échantillon en attente : décision impossible avant son résultat.');
    }
    const why = this.reason(reason);
    const updated = this.findings.update({ ...f, status: decision, review: { by: u.id, at: this.now(), decision, reason: why } });
    this.audit(u, decision === 'VALIDE' ? 'terrain.finding.validated' : 'terrain.finding.rejected', 'finding', id, { reason: why, seal: f.seal });
    return this.findingView(updated);
  }

  // ─────────────────────────── contrôle qualité ───────────────────────────

  /** Échantillon aléatoire (≥ 5 %) + 100 % des constats à risque, pour contre-visite par un autre agent. */
  createSample(u: User, input: { subcontractorId?: string; agentId?: string; missionId?: string; ratePercent: number }) {
    authorize(u, A.qualitySample);
    if (input.ratePercent < MIN_SAMPLE_RATE || input.ratePercent > 100) throw unprocessable('SAMPLE_RATE_TOO_LOW', `Taux d’échantillonnage entre ${MIN_SAMPLE_RATE} % et 100 %.`);
    const inSample = new Set(this.counterVisits.all().map((c) => c.findingId));
    const population = this.findings.find((f) => f.status === 'SOUMIS' && !inSample.has(f.id)
      && (!input.subcontractorId || f.subcontractorId === input.subcontractorId) && (!input.agentId || f.agentId === input.agentId)
      && (!input.missionId || f.missionId === input.missionId) && this.inTerritory(u, f.commune));
    const id = this.ids.next('ECH', 4);
    const risky = population.filter((f) => f.flags.some((x) => x === 'DISTANCE' || x === 'HORS_ZONE' || x === 'GPS_IMPRECIS'));
    const rest = population.filter((f) => !risky.includes(f));
    const n = rest.length === 0 ? 0 : Math.max(1, Math.ceil((rest.length * input.ratePercent) / 100));
    // Tirage reproductible et vérifiable a posteriori : ordre des empreintes (identifiant d'échantillon + constat).
    const random = rest
      .map((f) => ({ f, k: sha256Hex(`${id}|${f.id}|${f.seal}`) }))
      .sort((a, b) => a.k.localeCompare(b.k))
      .slice(0, n)
      .map((x) => x.f);
    const sample = this.samples.append({
      id, scope: { ...(input.subcontractorId ? { subcontractorId: input.subcontractorId } : {}), ...(input.agentId ? { agentId: input.agentId } : {}), ...(input.missionId ? { missionId: input.missionId } : {}) },
      ratePercent: input.ratePercent, population: population.length, randomSelected: random.map((f) => f.id), riskSelected: risky.map((f) => f.id),
      createdBy: u.id, createdAt: this.now(),
    });
    const visits: CounterVisit[] = [];
    for (const f of [...risky, ...random]) {
      visits.push(this.counterVisits.insert({ id: this.ids.next('CTV'), sampleId: id, findingId: f.id, originalAgentId: f.agentId, status: 'A_AFFECTER' }));
      this.findings.update({ ...f, status: 'A_CONTRE_VISITER' });
    }
    this.audit(u, 'terrain.quality.sample', 'quality_sample', id, { population: population.length, random: random.length, risk: risky.length, rate: input.ratePercent });
    return { sample, counterVisits: visits };
  }

  assignCounterVisit(u: User, id: string, agentId: string): CounterVisit {
    authorize(u, A.qualitySample);
    const cv = this.counterVisits.get(id);
    if (!cv) throw notFound('COUNTER_VISIT_NOT_FOUND', `Contre-visite inconnue : ${id}`);
    if (cv.status === 'REALISEE') throw conflict('INVALID_STATE', 'Contre-visite déjà réalisée.');
    const finding = this.findings.get(cv.findingId)!;
    assertDistinctPerson(agentId, [cv.originalAgentId], 'La contre-visite est confiée à un autre agent que l’auteur du constat.');
    const target = this.ctx.users.get(agentId);
    const agent = this.agents.get(agentId);
    const isController = !!target?.roles.includes('R11');
    if (!isController) {
      if (!agent || agent.status !== 'HABILITE' || !agent.habilitation) throw unprocessable('AGENT_NOT_HABILITATED', 'Agent de contre-visite non habilité.');
      // Indépendance : la contre-visite relève de la régie, jamais d'un sous-traitant.
      if (agent.subcontractorId) throw forbidden('NOT_INDEPENDENT', 'La contre-visite est réalisée par un agent de la régie, indépendant du sous-traitant.');
      if (!agent.habilitation.communes.includes(finding.commune)) throw unprocessable('AGENT_OUT_OF_ZONE', 'Agent non habilité pour cette commune.');
    }
    const updated = this.counterVisits.update({ ...cv, assignedTo: agentId, status: 'A_FAIRE' });
    this.audit(u, 'terrain.quality.counter_visit_assigned', 'counter_visit', id, { agentId, findingId: cv.findingId });
    this.notify('mission.assigned', [agentId], { mission: id });
    return updated;
  }

  performCounterVisit(u: User, id: string, input: { result: 'CONFORME' | 'NON_CONFORME'; notes: string; gps: { lat: number; lon: number; accuracyM: number; source?: 'GPS' | 'MANUEL' | 'ZONE' }; photoSha256?: string }) {
    authorize(u, A.counterVisitPerform);
    const cv = this.counterVisits.get(id);
    if (!cv) throw notFound('COUNTER_VISIT_NOT_FOUND', `Contre-visite inconnue : ${id}`);
    if (cv.assignedTo !== u.id) throw forbidden('NOT_ASSIGNED', 'Contre-visite non confiée à cet agent.');
    if (cv.status !== 'A_FAIRE') throw conflict('INVALID_STATE', `Contre-visite au statut ${cv.status}.`);
    const f = this.findings.get(cv.findingId)!;
    const updated = this.counterVisits.update({
      ...cv, status: 'REALISEE', result: input.result, notes: input.notes, gps: input.gps, ...(input.photoSha256 ? { photoSha256: input.photoSha256.toLowerCase() } : {}),
      performedAt: this.now(), distanceToOriginalM: distanceM(input.gps, f.gps),
    });
    this.audit(u, 'terrain.quality.counter_visit_done', 'counter_visit', id, { result: input.result, findingId: f.id });
    // Proposition seulement : la décision sur le constat reste humaine (revue motivée).
    return { counterVisit: updated, proposal: input.result === 'CONFORME' ? 'VALIDER' : 'REJETER', note: 'Proposition : la décision sur le constat reste à un réviseur habilité.' };
  }

  listCounterVisits(u: User) {
    if (this.isFieldAgentOnly(u)) {
      authorize(u, A.counterVisitPerform);
      return this.counterVisits.find((c) => c.assignedTo === u.id).map((c) => this.counterVisitView(c, true));
    }
    authorize(u, A.qualityRead);
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return [];
    return this.counterVisits
      .find((c) => {
        const f = this.findings.get(c.findingId)!;
        return scoped ? f.subcontractorId === scoped.id : this.inTerritory(u, f.commune);
      })
      .map((c) => this.counterVisitView(c, !scoped));
  }

  private counterVisitView(c: CounterVisit, withTarget: boolean) {
    const f = this.findings.get(c.findingId)!;
    return {
      ...c, commune: f.commune, missionId: f.missionId, objectId: f.objectId ?? null,
      // L'agent de contre-visite reçoit le point à revoir, jamais le résultat du premier constat (contrôle à l'aveugle).
      ...(withTarget ? { target: { lat: f.gps.lat, lon: f.gps.lon } } : {}),
      assignedName: c.assignedTo ? this.agents.get(c.assignedTo)?.displayName ?? this.ctx.users.get(c.assignedTo)?.name ?? c.assignedTo : null,
    };
  }

  private qualityRows(findings: Finding[], visits: CounterVisit[], by: 'agent' | 'subcontractor') {
    const groups = new Map<string, Finding[]>();
    for (const f of findings) {
      const key = by === 'agent' ? f.agentId : f.subcontractorId ?? 'REGIE';
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    return [...groups.entries()].map(([key, fs]) => {
      const ids = new Set(fs.map((f) => f.id));
      const done = visits.filter((c) => ids.has(c.findingId) && c.status === 'REALISEE');
      const nonConforming = done.filter((c) => c.result === 'NON_CONFORME').length;
      const validated = fs.filter((f) => f.status === 'VALIDE').length;
      const rejected = fs.filter((f) => f.status === 'REJETE').length;
      const reviewed = fs.filter((f) => f.review);
      const delays = reviewed.map((f) => new Date(f.review!.at).getTime() - new Date(f.receivedAt).getTime());
      const mystery = this.mysteryChecks.find((mc) => mc.status === 'REALISE' && mc.target.id === key);
      const label = by === 'agent'
        ? this.agents.get(key)?.displayName ?? key
        : key === 'REGIE' ? 'Équipes internes de la régie' : this.subcontractors.get(key)?.name ?? key;
      return {
        key, label, submitted: fs.length, validated, rejected,
        pending: fs.filter((f) => f.status === 'SOUMIS' || f.status === 'A_CONTRE_VISITER').length,
        flagged: fs.filter((f) => f.flags.some((x) => x === 'DISTANCE' || x === 'HORS_ZONE')).length,
        counterVisitsDone: done.length, nonConforming,
        /** Taux d'erreur mesuré par contre-visite (non conformes / contre-visites réalisées), en %. */
        errorRatePct: pct(nonConforming, done.length),
        rejectionRatePct: pct(rejected, validated + rejected),
        confirmedRatePct: pct(validated, fs.length),
        avgReviewDelayHours: delays.length ? (delays.reduce((a, b) => a + b, 0) / delays.length / 3_600_000).toFixed(1) : null,
        mysteryChecks: mystery.length, mysteryIrregularities: mystery.filter((x) => x.result === 'IRREGULARITE').length,
      };
    });
  }

  qualityBoard(u: User) {
    authorize(u, A.qualityRead);
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return { byAgent: [], bySubcontractor: [], samples: [] };
    const fs = this.findings.find((f) => (scoped ? f.subcontractorId === scoped.id : this.inTerritory(u, f.commune)));
    const visits = this.counterVisits.all();
    return {
      byAgent: this.qualityRows(fs, visits, 'agent'),
      bySubcontractor: this.qualityRows(fs, visits, 'subcontractor'),
      samples: scoped ? [] : this.samples.all().reverse(),
      method: `Échantillon aléatoire d’au moins ${MIN_SAMPLE_RATE} % des constats soumis, plus 100 % des constats à risque (écart GPS, hors zone, GPS imprécis) ; contre-visite par un agent de la régie ; décision humaine motivée.`,
    };
  }

  // ─────────────────────────── contrôles mystère ───────────────────────────

  planMysteryCheck(u: User, input: { targetKind: 'AGENT' | 'SOUS_TRAITANT'; targetId: string; plannedFor: string }): MysteryCheck {
    authorize(u, A.mysteryManage);
    const exists = input.targetKind === 'AGENT' ? this.agents.get(input.targetId) : this.subcontractors.get(input.targetId);
    if (!exists) throw notFound('TARGET_NOT_FOUND', 'Cible du contrôle inconnue.');
    const mc = this.mysteryChecks.insert({
      id: this.ids.next('CMY', 4), target: { kind: input.targetKind, id: input.targetId }, plannedFor: input.plannedFor, status: 'PLANIFIE', plannedBy: u.id,
    });
    this.audit(u, 'terrain.mystery.planned', 'mystery_check', mc.id, { target: mc.target });
    return mc;
  }

  recordMysteryCheck(u: User, id: string, input: { result: 'SANS_IRREGULARITE' | 'IRREGULARITE'; notes: string }) {
    authorize(u, A.mysteryManage);
    const mc = this.mysteryChecks.get(id);
    if (!mc) throw notFound('MYSTERY_CHECK_NOT_FOUND', `Contrôle inconnu : ${id}`);
    if (mc.status === 'REALISE') throw conflict('INVALID_STATE', 'Contrôle déjà réalisé.');
    const updated = this.mysteryChecks.update({ ...mc, status: 'REALISE', result: input.result, notes: input.notes, performedBy: u.id, performedAt: this.now() });
    this.audit(u, 'terrain.mystery.recorded', 'mystery_check', id, { result: input.result, target: mc.target });
    if (input.result === 'IRREGULARITE') {
      this.ctx.alerts.raise({ type: 'MYSTERY_CHECK_IRREGULARITY', severity: 'HIGH', source: 'terrain', detail: `Contrôle mystère ${id} : irrégularité constatée (${mc.target.kind} ${mc.target.id}).`, context: { id }, actor: this.actor(u) });
    }
    return {
      mysteryCheck: updated,
      // Aucune sanction automatique : proposition à une autorité habilitée.
      proposal: input.result === 'IRREGULARITE' ? 'Examen par la régie : suspension conservatoire possible sur décision motivée.' : null,
    };
  }

  listMysteryChecks(u: User): MysteryCheck[] {
    authorize(u, A.mysteryManage);
    return this.mysteryChecks.all();
  }

  /** Résultats publiés sous forme agrégée (jamais nominative). */
  publicMysterySummary() {
    const done = this.mysteryChecks.find((m) => m.status === 'REALISE');
    const clean = done.filter((m) => m.result === 'SANS_IRREGULARITE').length;
    return { performed: done.length, withoutIrregularity: clean, withoutIrregularityPct: pct(clean, done.length), aggregated: true };
  }

  // ─────────────────────────── indicateurs et rémunération ───────────────────────────

  indicators(u: User) {
    authorize(u, A.qualityRead);
    const scoped = this.scopedSubcontractor(u);
    if (scoped === null) return null;
    const ms = this.missions.find((m) => (scoped ? m.subcontractorId === scoped.id : this.inTerritory(u, m.commune)));
    const fs = this.findings.find((f) => (scoped ? f.subcontractorId === scoped.id : this.inTerritory(u, f.commune)));
    const communes = [...new Set(ms.map((m) => m.commune))].sort();
    const byStatus = Object.fromEntries((['A_AFFECTER', 'AFFECTEE', 'EN_COURS', 'TERMINEE', 'ANNULEE'] as MissionStatus[]).map((s) => [s, ms.filter((m) => m.status === s).length]));
    const agents = this.agents.find((a) => (scoped ? a.subcontractorId === scoped.id : true));
    const verifs = this.verifications.all();
    const days: Record<string, number> = {};
    for (const f of fs) days[kinshasaDay(f.capturedAt)] = (days[kinshasaDay(f.capturedAt)] ?? 0) + 1;
    return {
      missions: { total: ms.length, byStatus, overdue: ms.filter((m) => m.status !== 'TERMINEE' && m.status !== 'ANNULEE' && m.dueDate < this.today()).length },
      findings: {
        total: fs.length, validated: fs.filter((f) => f.status === 'VALIDE').length, rejected: fs.filter((f) => f.status === 'REJETE').length,
        pending: fs.filter((f) => f.status === 'SOUMIS' || f.status === 'A_CONTRE_VISITER').length,
        flaggedPct: pct(fs.filter((f) => f.flags.some((x) => x === 'DISTANCE' || x === 'HORS_ZONE')).length, fs.length),
        withPhotoPct: pct(fs.filter((f) => f.photoSha256).length, fs.length),
        byDay: Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
      },
      byCommune: communes.map((c) => {
        const cm = ms.filter((m) => m.commune === c);
        const cf = fs.filter((f) => f.commune === c);
        const target = cm.reduce((a, m) => a + m.objectives.findings, 0);
        return {
          commune: c, missions: cm.length, findings: cf.length, validated: cf.filter((f) => f.status === 'VALIDE').length,
          flagged: cf.filter((f) => f.flags.some((x) => x === 'DISTANCE' || x === 'HORS_ZONE')).length,
          objectiveTarget: target, objectivePct: pct(Math.min(cf.length, target), target), toleranceM: this.toleranceFor(c),
        };
      }),
      agents: { total: agents.length, habilitated: agents.filter((a) => a.status === 'HABILITE').length, invited: agents.filter((a) => a.status === 'INVITE').length, suspended: agents.filter((a) => a.status === 'SUSPENDU').length },
      subcontractors: scoped ? null : Object.fromEntries((['INVITE', 'EN_DILIGENCE', 'ACCREDITE_PROBATOIRE', 'ACCREDITE', 'SUSPENDU', 'RETIRE'] as SubcontractorStatus[]).map((s) => [s, this.subcontractors.find((x) => x.status === s).length])),
      badgeVerifications: scoped ? null : { total: verifs.length, byResult: Object.fromEntries(['VALIDE', 'SUSPENDU', 'REVOQUE', 'EXPIRE', 'INCONNU'].map((r) => [r, verifs.filter((v) => v.result === r).length])) },
      cashHandled: false,
    };
  }

  /**
   * Calcul INDICATIF de la rémunération d'un sous-traitant : livrables vérifiés × prix unitaires du contrat.
   * Ne lit jamais les paiements des contribuables ni les montants liquidés (RW6) ; paiement réel sur crédit
   * budgétaire, hors plateforme, après certification des livrables par la régie.
   */
  remuneration(u: User, subcontractorId: string) {
    authorize(u, A.remunerationRead);
    const st = this.mustGet(subcontractorId);
    this.assertOwnSubcontractor(u, st);
    const fs = this.findings.find((f) => f.subcontractorId === st.id);
    const validated = fs.filter((f) => f.status === 'VALIDE').length;
    const ms = this.missions.find((m) => m.subcontractorId === st.id && m.status === 'TERMINEE');
    const onTime = ms.filter((m) => (m.completedAt ? kinshasaDay(m.completedAt) : '') <= m.dueDate).length;
    const notice = 'Calcul indicatif sur livrables vérifiés (constats validés après contrôle qualité, missions achevées dans les délais), aux prix unitaires du contrat. Jamais un pourcentage des recettes ni un montant lié à ce que paient les contribuables. Paiement sur crédit budgétaire, hors plateforme, après certification par la régie.';
    const deliverables = {
      validatedFindings: validated, missionsOnTime: onTime, missionsLate: ms.length - onTime,
      rejectedFindings: fs.filter((f) => f.status === 'REJETE').length, pendingFindings: fs.filter((f) => f.status === 'SOUMIS' || f.status === 'A_CONTRE_VISITER').length,
    };
    if (!st.contract) return { subcontractorId: st.id, available: false, reason: 'Prix unitaires du contrat non renseignés.', deliverables, indicative: true, notice };
    const c = st.contract;
    const l1 = Money.fromJSON(c.validatedFinding).multiply(String(validated));
    const l2 = Money.fromJSON(c.missionOnTime).multiply(String(onTime));
    const total = l1.currency === l2.currency ? l1.add(l2).toJSON() : null;
    return {
      subcontractorId: st.id, available: true, indicative: true, example: c.example, contractReference: c.reference, basis: 'LIVRABLES_VERIFIES',
      deliverables,
      lines: [
        { deliverable: 'Constats validés après contrôle qualité', count: validated, unitPrice: c.validatedFinding, amount: l1.toJSON() },
        { deliverable: 'Missions achevées dans les délais', count: onTime, unitPrice: c.missionOnTime, amount: l2.toJSON() },
      ],
      total, notice,
    };
  }

  /** Espace de l'agent : son profil, son badge, ses missions et ses contre-visites. */
  me(u: User) {
    authorize(u, A.missionRead);
    const agent = this.agents.get(u.id);
    return {
      agent: agent ? { id: agent.id, displayName: agent.displayName, status: agent.status, structure: this.structureOf(agent), habilitation: agent.habilitation ?? null } : null,
      badge: agent ? this.activeBadgeView(agent.id) : null,
      missions: this.missions.find((m) => m.assignedAgentId === u.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((m) => this.missionView(m)),
      counterVisits: this.counterVisits.find((c) => c.assignedTo === u.id).map((c) => this.counterVisitView(c, true)),
      devices: this.ctx.field.devices.find((d) => d.agentUserId === u.id).map((d) => ({ id: d.id, status: d.status })),
      cashHandled: false,
    };
  }

  // ─────────────────────────── données de démonstration ───────────────────────────

  seedDemo(): void {
    const ctx = this.ctx;
    const d = (days: number) => kinshasaDate(new Date(ctx.clock.now().getTime() + days * 86_400_000));
    const regie = ctx.users.add({ id: 'terrain-resp-module', name: 'Responsable de module foncier DGIPK (démo)', roles: ['R07'], entity: 'DGIPK' });
    const dg = ctx.users.get('u-dg-dgipk')!;
    ctx.users.add({ id: 'terrain-agent-regie-qc', name: 'Agent qualité de la régie (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete', 'Lemba', 'Matete', 'Ngaba'] });
    for (const [c, m] of [['Gombe', 30], ['Limete', 50], ['Lemba', 60]] as const) this.tolerances.set(c, m);

    // Équipes internes de la régie.
    const internal: [string, string, string[], string[], string][] = [
      ['u-agent-terrain', 'Agent Limete — équipe interne', ['Limete', 'Lemba', 'Matete'], ['Righini'], 'dev-terrain-001'],
      ['u-agent-terrain-2', 'Agent Limete 2 — équipe interne', ['Limete', 'Ngaba'], [], 'dev-terrain-002'],
      ['u-agent-gombe', 'Agent Gombe — équipe interne', ['Gombe'], [], 'dev-u-agent-gombe'],
      ['terrain-agent-regie-qc', 'Agent qualité de la régie', ['Limete', 'Lemba', 'Matete', 'Ngaba'], [], 'dev-terrain-agent-regie-qc'],
    ];
    const fixedCodes: Record<string, string> = { 'u-agent-terrain': 'AG-7K4M2Q-', 'u-agent-gombe': 'AG-G0MB3E-' };
    for (const [id, name, communes, quartiers, deviceId] of internal) {
      this.registerInternalAgent(regie, id, { displayName: name, declaredQuartiers: quartiers });
      const agent = this.agents.get(id)!;
      // Clé du terminal : secret configuré, sinon clé connue en démonstration SEULEMENT (aléatoire hors démonstration).
      if (!ctx.field.devices.get(deviceId)) ctx.field.enroll(deviceId, id, seedDeviceKey(deviceId, ctx.secrets.deviceKeys));
      const habilitation = {
        identityVerified: true, trainingCertificateRef: `CERT-DEMO-${id}`, trainingValidUntil: d(300), ethicsSignedAt: this.now(), deviceId,
        module: 'FONCIER_LOCATIF' as const, communes, validUntil: d(180), decidedBy: dg.id, decidedAt: this.now(),
      };
      const hab = this.agents.update({ ...agent, habilitation, status: 'HABILITE', demo: true, history: [...agent.history, { at: this.now(), by: dg.id, to: 'HABILITE', reason: 'Habilitation (démo)' }] });
      const prefix = fixedCodes[id];
      this.issueBadge(dg, hab, prefix ? `${prefix}${checkChar(prefix.replace(/-/g, ''))}` : undefined);
    }

    // Sous-traitant accrédité en période probatoire (lot réduit, H.24.4).
    const { subcontractor: st } = this.inviteSubcontractor(regie, {
      name: 'Kin Recensement SARL (fictif)', selectionReference: 'AMI-DGIPK-2026-004 (démo)', requestedModules: ['FONCIER_LOCATIF'], capacityAgents: 8,
      managerName: 'Responsable Kin Recensement',
    }, { id: 'ST-0001', entity: 'ST-KIN-RECENS', managerId: 'terrain-st-resp', demo: true });
    const stManager = ctx.users.get('terrain-st-resp')!;
    this.submitDossier(stManager, st.id, { rccm: 'CD/KIN/RCCM/00-B-00000 (fictif)', nif: 'A0000000X (fictif)', references: 'Recensement pilote fictif', capacityAgents: 8 });
    this.recordDiligence(regie, st.id, { legalExistence: true, taxClearance: true, noConflictOfInterest: true, publicAgentLinksDeclared: true, notes: 'Diligence de démonstration' });
    this.proposeAccreditation(regie, st.id, { modules: ['FONCIER_LOCATIF'], communes: ['Limete', 'Lemba'], validUntil: d(365), probationUntil: d(60), reason: 'Sélection AMI ; capacité vérifiée (démo)' });
    this.approveAccreditation(dg, st.id, 'Diligence complète ; période probatoire sur lot réduit (démo)');
    this.setContract(regie, st.id, {
      reference: 'CONV-ST-0001 (démo)', validatedFinding: { amount: '2500.00', currency: 'CDF' }, missionOnTime: { amount: '15000.00', currency: 'CDF' }, example: true,
    });
    const lot = this.createLot(regie, { subcontractorId: st.id, module: 'FONCIER_LOCATIF', commune: 'Limete', quartiers: ['Kingabwa', 'Mososo'], periodStart: d(-10), periodEnd: d(80), maxAgents: 3 }, { id: 'LOT-LIM-01', demo: true });
    this.inviteAgent(stManager, st.id, { displayName: 'Agent Kin Recensement 1' }, { id: 'terrain-st-agent-1', demo: true });
    this.habilitateAgent(regie, 'terrain-st-agent-1', {
      identityVerified: true, trainingCertificateRef: 'CERT-DEMO-ST-1', trainingValidUntil: d(300), ethicsSigned: true, module: 'FONCIER_LOCATIF', communes: ['Limete'], validUntil: d(80),
    });
    this.inviteAgent(stManager, st.id, { displayName: 'Agent Kin Recensement 2', declaredQuartiers: ['Mososo'] }, { id: 'terrain-st-agent-2', demo: true });

    // Deuxième sous-traitant, encore en diligence.
    const { subcontractor: st2 } = this.inviteSubcontractor(regie, {
      name: 'Mboka Data Terrain (fictif)', selectionReference: 'AMI-DGIPK-2026-004 (démo)', requestedModules: ['FONCIER_LOCATIF', 'PATENTES'], capacityAgents: 12,
      managerName: 'Responsable Mboka Data',
    }, { id: 'ST-0002', entity: 'ST-MBOKA', managerId: 'terrain-st2-resp', demo: true });
    this.submitDossier(ctx.users.get('terrain-st2-resp')!, st2.id, { rccm: 'CD/KIN/RCCM/00-B-11111 (fictif)', nif: 'B1111111Y (fictif)' });

    // Missions (données de démonstration).
    const sup = ctx.users.get('u-superviseur')!;
    const m1 = this.createMission(sup, {
      title: 'Recensement locatif — Limete / Kingabwa, îlot 14', commune: 'Limete', quartier: 'Kingabwa', objectIds: ['OBJ-DEMO-PARCELLE-01', 'OBJ-DEMO-UNITE-01'],
      objectives: { findings: 6, objects: 2 }, instructions: 'Vérifier l’existence et l’occupation ; photo de façade ; aucune demande d’argent.', periodStart: d(-3), dueDate: d(14), radiusM: 250,
    }, { id: 'MIS-LIM-014', demo: true });
    this.assignMission(sup, m1.id, 'u-agent-terrain');
    const m2 = this.createMission(sup, {
      title: 'Contrôle ciblé — Lemba / Righini', commune: 'Lemba', quartier: 'Righini', center: { lat: -4.4012, lon: 15.3198 },
      objectives: { findings: 10 }, instructions: 'Immeubles multi-unités déclarés vacants.', periodStart: d(0), dueDate: d(20), radiusM: 400,
    }, { id: 'MIS-LEM-003', demo: true });
    void m2;
    const m3 = this.createMission(stManager, {
      lotId: lot.id, title: 'Recensement — Limete / Mososo (lot probatoire)', commune: 'Limete', quartier: 'Kingabwa', center: { lat: -4.3712, lon: 15.3441 },
      objectives: { findings: 20 }, instructions: 'Objets non enregistrés : créer un constat « objet non enregistré » avec photo.', periodStart: d(-5), dueDate: d(25), radiusM: 500,
    }, { id: 'MIS-LIM-021', demo: true });
    this.assignMission(stManager, m3.id, 'terrain-st-agent-1');
    this.createMission(ctx.users.get('terrain-resp-module')!, {
      title: 'Recensement publicitaire — Gombe / boulevard du 30 Juin', commune: 'Gombe', center: { lat: -4.3036, lon: 15.3092 },
      objectives: { findings: 15 }, periodStart: d(0), dueDate: d(30), radiusM: 600,
    }, { id: 'MIS-GOM-002', demo: true });
    this.assignMission(regie, 'MIS-GOM-002', 'u-agent-gombe');

    // Constats de démonstration (empreintes fictives ; aucune photo stockée).
    const agent1 = ctx.users.get('u-agent-terrain')!;
    const stAgent = ctx.users.get('terrain-st-agent-1')!;
    const at = (h: number) => new Date(ctx.clock.now().getTime() - h * 3_600_000).toISOString();
    const fake = (s: string) => sha256Hex(`photo-demo-${s}`);
    this.submitFinding(agent1, m1.id, { clientRef: 'demo-1', objectId: 'OBJ-DEMO-PARCELLE-01', outcome: 'CONSTATE', observations: 'Parcelle bâtie, un bâtiment, occupée (démo).', gps: { lat: -4.37122, lon: 15.34412, accuracyM: 8 }, photoSha256: fake('1'), capturedAt: at(30) });
    this.submitFinding(agent1, m1.id, { clientRef: 'demo-2', objectId: 'OBJ-DEMO-UNITE-01', outcome: 'CONSTATE', observations: 'Unité occupée par un locataire (démo).', gps: { lat: -4.37517, lon: 15.3442, accuracyM: 12 }, photoSha256: fake('2'), capturedAt: at(29), justification: 'Accès par l’arrière de l’îlot (démo).' });
    for (let i = 1; i <= 5; i++) {
      this.submitFinding(stAgent, m3.id, {
        clientRef: `demo-st-${i}`, outcome: 'OBJET_NON_ENREGISTRE', observations: `Local commercial non enregistré n° ${i} (démo).`,
        gps: { lat: -4.3712 - i * 0.0004, lon: 15.3441 + i * 0.0003, accuracyM: 6 + i }, ...(i !== 4 ? { photoSha256: fake(`st-${i}`) } : {}), capturedAt: at(40 - i),
      });
    }
    const controleur = ctx.users.get('u-controleur')!;
    const first = this.findings.findOne((f) => f.clientRef === 'demo-1')!;
    this.reviewFinding(controleur, first.id, 'VALIDE', 'Constat cohérent : photo et position conformes (démo).');
    const { counterVisits } = this.createSample(controleur, { subcontractorId: st.id, ratePercent: 20 });
    if (counterVisits[0]) {
      this.assignCounterVisit(controleur, counterVisits[0].id, 'terrain-agent-regie-qc');
      const f0 = this.findings.get(counterVisits[0].findingId)!;
      this.performCounterVisit(ctx.users.get('terrain-agent-regie-qc')!, counterVisits[0].id, { result: 'CONFORME', notes: 'Local présent, activité confirmée (démo).', gps: { ...f0.gps, accuracyM: 9 } });
      this.reviewFinding(controleur, f0.id, 'VALIDE', 'Contre-visite conforme (démo).');
    }
    const enqueteur = ctx.users.get('u-enqueteur')!;
    const mc1 = this.planMysteryCheck(enqueteur, { targetKind: 'SOUS_TRAITANT', targetId: st.id, plannedFor: d(-2) });
    this.recordMysteryCheck(enqueteur, mc1.id, { result: 'SANS_IRREGULARITE', notes: 'Aucune demande d’argent ; badge présenté (démo).' });
    const mc2 = this.planMysteryCheck(enqueteur, { targetKind: 'AGENT', targetId: 'u-agent-terrain', plannedFor: d(-1) });
    this.recordMysteryCheck(enqueteur, mc2.id, { result: 'SANS_IRREGULARITE', notes: 'Protocole respecté (démo).' });
    this.planMysteryCheck(enqueteur, { targetKind: 'AGENT', targetId: 'terrain-st-agent-1', plannedFor: d(7) });
    for (const s of this.subcontractors.all()) this.subcontractors.update({ ...s, demo: true });
    for (const a of this.agents.all()) this.agents.update({ ...a, demo: true });
  }
}
