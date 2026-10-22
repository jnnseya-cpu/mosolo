/**
 * Inspection et constat (spécification fonctionnelle, module 35) — construit sur les missions et les constats scellés du
 * module terrain (§ 15, § 15A), sans circuit parallèle :
 *  - DOSSIER D'INSPECTION préparé avant la visite, par objet de la mission (identité et position de l'objet, plaque,
 *    situation déclarée, derniers constats, réclamation en cours, points à vérifier) — sans montant ni donnée de paiement ;
 *    versionné et scellé (empreinte) ;
 *  - PAQUET HORS LIGNE de la mission : dossiers + modèles de procès-verbal autorisés pour l'agent, signé (HMAC dérivé de
 *    la clé serveur), expirant à l'échéance de la mission — consultable sans réseau sur le terminal ;
 *  - PROCÈS-VERBAL selon les POUVOIRS de l'agent (modèles par pouvoir légal, base légale À VÉRIFIER), établi à partir de
 *    son constat géorepéré : déclaration de la personne, SIGNATURE ou REFUS de signer, numérotation par le système,
 *    empreinte ; transmis au superviseur, validé par une personne distincte ;
 *  - un constat ou un procès-verbal VALIDÉ n'est jamais modifié (409) ; une rectification avant validation crée une
 *    nouvelle version, l'ancienne est conservée ;
 *  - CONTESTATION du procès-verbal par la personne concernée (accusé de réception horodaté, réponse motivée par une
 *    personne distincte de l'auteur).
 * Aucun procès-verbal ne crée d'obligation ni de sanction.
 */
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { canonicalJson, hmacSha256Hex, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import type { ObjectCategory } from '../../modules/objects/service.js';
import { distanceM } from './geo.js';
import type { Finding, Mission } from './model.js';
import type { TerrainService } from './service.js';

const { always, ownTaxpayer, mandant } = GRANTS;
definePolicy('terrain:inspection.prepare', { R07: always, R09: always, R11: always });
definePolicy('terrain:inspection.read', { R06: always, R07: always, R09: always, R10: always, R11: always, R22: always, R23: always, R24: always });
definePolicy('terrain:pv.draft', { R09: always, R10: always, R11: always });
definePolicy('terrain:pv.validate', { R09: always, R11: always });
definePolicy('terrain:pv.contest', { R12: always, R30: ownTaxpayer, R31: mandant });
definePolicy('terrain:pv.answer', { R09: always, R11: always });

/** Pouvoirs légaux d'établissement d'un procès-verbal (habilitation par rôle ; textes habilitants À VÉRIFIER). */
export const LEGAL_POWERS = {
  CONSTAT_OBJET: { label: 'Constat de situation d’un objet (existence, occupation, activité)', roles: ['R10', 'R11'] },
  CONTROLE_FISCAL: { label: 'Contrôle de conformité (titre, quittance, autorisation présentés)', roles: ['R11'] },
  CONTRE_VISITE: { label: 'Contre-visite de contrôle qualité', roles: ['R09', 'R11'] },
} as const;
export type LegalPower = keyof typeof LEGAL_POWERS;

export interface PvTemplate {
  id: string;
  version: number;
  power: LegalPower;
  title: string;
  sections: string[];
  mentions: string[];
  legalBasis: { status: 'A_VERIFIER'; note: string };
}

const COMMON_MENTIONS = [
  'Le présent procès-verbal constate une situation ; il ne crée ni obligation, ni pénalité, ni sanction.',
  'Aucun agent n’encaisse d’argent : tout paiement se fait au compte public désigné (référence officielle).',
  'La personne concernée peut contester ce procès-verbal (espace MOSOLO, guichet, USSD) ; la réponse est motivée.',
];

export const PV_TEMPLATES: PvTemplate[] = [
  {
    id: 'PV-CONSTAT-OBJET', version: 1, power: 'CONSTAT_OBJET', title: 'Procès-verbal de constat de situation',
    sections: ['Agent et badge', 'Objet (identifiant, plaque, position)', 'Date et heure (serveur)', 'Position GPS et écart au point enregistré', 'Constatations', 'Photographies (empreintes)', 'Déclaration de la personne rencontrée', 'Signature ou refus de signer', 'Voies de contestation'],
    mentions: COMMON_MENTIONS, legalBasis: { status: 'A_VERIFIER', note: 'Texte habilitant le constat par les agents de la régie à confirmer par le juridique (registre des points juridiques).' },
  },
  {
    id: 'PV-CONTROLE', version: 1, power: 'CONTROLE_FISCAL', title: 'Procès-verbal de contrôle de conformité',
    sections: ['Contrôleur et habilitation', 'Objet et redevable (nom masqué)', 'Date et heure (serveur)', 'Position GPS', 'Titres, quittances ou autorisations présentés (codes vérifiés)', 'Constatations', 'Photographies (empreintes)', 'Déclaration de la personne', 'Signature ou refus de signer', 'Voies de contestation'],
    mentions: COMMON_MENTIONS, legalBasis: { status: 'A_VERIFIER', note: 'Pouvoirs de contrôle (procédure fiscale provinciale) à confirmer par le juridique.' },
  },
  {
    id: 'PV-CONTRE-VISITE', version: 1, power: 'CONTRE_VISITE', title: 'Procès-verbal de contre-visite',
    sections: ['Agent de contre-visite', 'Constat initial (référence, empreinte)', 'Date et heure (serveur)', 'Position GPS et écart au constat initial', 'Conformité constatée', 'Photographies (empreintes)', 'Signature ou refus de signer', 'Voies de contestation'],
    mentions: COMMON_MENTIONS, legalBasis: { status: 'A_VERIFIER', note: 'Contrôle qualité interne (§ 15A) : base contractuelle et réglementaire à confirmer.' },
  },
];

export interface InspectionDossier {
  id: string;
  missionId: string;
  objectId: string;
  version: number;
  preparedBy: string;
  preparedAt: string;
  content: {
    object: { id: string; category: string; commune: string; quartier: string; avenue?: string; lat: number; lon: number; status: string; igf?: string; declared: Record<string, unknown> };
    holder: { known: boolean; nameMasked: string | null };
    situation: { label: string; openAppeal: boolean; overdueObligations: number; payableObligations: number };
    lastFindings: { id: string; outcome: string; status: string; capturedAt: string }[];
    checklist: string[];
  };
  contentHash: string;
}

export type PvStatus = 'TRANSMIS' | 'VALIDE' | 'REJETE' | 'REMPLACE';
export interface ProcesVerbal {
  id: string;
  number: string;
  version: number;
  supersedes?: string;
  clientRef: string;
  findingId: string;
  missionId: string;
  objectId?: string;
  templateId: string;
  templateVersion: number;
  power: LegalPower;
  authorId: string;
  commune: string;
  gps: Finding['gps'];
  distanceM: number;
  geofenceFlags: Finding['flags'];
  findingSeal: string;
  statements: { observations: string; personDeclaration: string };
  signature: { kind: 'SIGNE' | 'REFUS_DE_SIGNER' | 'PERSONNE_ABSENTE'; signerName?: string; signatureImageSha256?: string; refusalNote?: string };
  photoSha256: string[];
  signedAt: string;
  recordedAt: string;
  seal: string;
  status: PvStatus;
  review?: { by: string; at: string; decision: 'VALIDE' | 'REJETE'; reason: string };
  contestations: { id: string; by: string; at: string; text: string; acknowledgement: string; answer?: { by: string; at: string; text: string } }[];
}

const mask = (name: string) => name.split(/\s+/).map((w) => (w ? `${w[0]}${'*'.repeat(Math.max(1, w.length - 1))}` : w)).join(' ');

export class InspectionService {
  readonly dossiers = new InMemoryRepository<InspectionDossier>();
  readonly pvs = new InMemoryRepository<ProcesVerbal>();
  private readonly ids = new IdGenerator();
  private readonly packageKey: string;
  private pvSeq = 0;

  constructor(private readonly ctx: AppContext, private readonly terrain: TerrainService) {
    this.packageKey = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:terrain:paquet-inspection:v1');
  }

  private now() { return this.ctx.clock.now().toISOString(); }

  private mission(id: string): Mission {
    const m = this.terrain.missions.get(id);
    if (!m) throw notFound('MISSION_NOT_FOUND', `Mission inconnue : ${id}`);
    return m;
  }

  powersOf(u: User): LegalPower[] {
    return (Object.keys(LEGAL_POWERS) as LegalPower[]).filter((p) => (LEGAL_POWERS[p].roles as readonly string[]).some((r) => u.roles.includes(r as never)));
  }

  templatesFor(u: User): PvTemplate[] {
    const powers = this.powersOf(u);
    return PV_TEMPLATES.filter((t) => powers.includes(t.power));
  }

  /** Préparation avant visite : un dossier par objet de la mission (nouvelle version si déjà préparé). */
  prepare(u: User, missionId: string): InspectionDossier[] {
    authorize(u, 'terrain:inspection.prepare');
    const m = this.mission(missionId);
    if (!m.objectIds.length) throw unprocessable('MISSION_WITHOUT_OBJECTS', 'Mission de zone sans objet désigné : aucun dossier à préparer (la découverte relève du recensement).');
    const today = kinshasaDate(this.ctx.clock.now());
    const out: InspectionDossier[] = [];
    for (const objectId of m.objectIds) {
      const o = this.ctx.objects.objects.get(objectId);
      if (!o) continue;
      const tp = o.taxpayerId ? this.ctx.taxpayers.taxpayers.get(o.taxpayerId) : undefined;
      const obligations = this.ctx.assessment.obligations.find((x) => x.objectId === o.id && !x.supersededBy);
      const payable = obligations.filter((x) => ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE', 'CONTESTEE'].includes(x.status));
      const overdue = payable.filter((x) => x.status !== 'CONTESTEE' && this.ctx.assessment.isPastDue(x, today));
      const openAppeal = obligations.some((x) => !!this.ctx.appeals.openFor(x.id));
      const findings = this.terrain.findings.find((f) => f.objectId === o.id).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 5);
      const content: InspectionDossier['content'] = {
        object: { id: o.id, category: o.category, commune: o.commune, quartier: o.quartier, ...(o.avenue ? { avenue: o.avenue } : {}), lat: o.lat, lon: o.lon, status: o.status, ...(o.igf ? { igf: o.igf.code } : {}), declared: o.attributes },
        holder: { known: !!tp, nameMasked: tp ? mask(tp.fullName) : null },
        situation: {
          label: openAppeal ? 'Réclamation en cours : constater sans mesure' : overdue.length ? 'Échéance(s) dépassée(s) : informer, orienter vers le paiement officiel' : payable.length ? 'Obligation(s) à venir' : 'Aucune obligation en cours connue',
          openAppeal, overdueObligations: overdue.length, payableObligations: payable.length,
        },
        lastFindings: findings.map((f) => ({ id: f.id, outcome: f.outcome, status: f.status, capturedAt: f.capturedAt })),
        checklist: [
          'Présenter le badge vérifiable ; ne jamais demander ni recevoir d’argent.',
          'Vérifier l’existence et la position de l’objet (GPS, écart toléré au point enregistré).',
          'Comparer les attributs déclarés à la situation observée ; photographier (empreinte seulement).',
          ...(openAppeal ? ['Réclamation en cours : aucune mesure, constat seulement.'] : []),
          'Recueillir la déclaration de la personne ; signature ou refus de signer.',
        ],
      };
      const prev = this.dossiers.find((d) => d.missionId === m.id && d.objectId === o.id).sort((a, b) => b.version - a.version)[0];
      const d = this.dossiers.insert({ id: this.ids.next('DINS', 6), missionId: m.id, objectId: o.id, version: (prev?.version ?? 0) + 1, preparedBy: u.id, preparedAt: this.now(), content, contentHash: sha256Hex(canonicalJson(content)) });
      out.push(d);
    }
    this.ctx.audit.append({ actor: actorOf(u), action: 'terrain.inspection.prepared', resourceType: 'mission', resourceId: m.id, details: { dossiers: out.map((d) => ({ id: d.id, objectId: d.objectId, version: d.version, contentHash: d.contentHash })) } });
    return out;
  }

  private latestDossiers(missionId: string): InspectionDossier[] {
    const by = new Map<string, InspectionDossier>();
    for (const d of this.dossiers.find((x) => x.missionId === missionId)) if (!by.has(d.objectId) || by.get(d.objectId)!.version < d.version) by.set(d.objectId, d);
    return [...by.values()];
  }

  private assertMissionAccess(u: User, m: Mission): void {
    const fieldOnly = u.roles.includes('R10') && !u.roles.some((r) => ['R06', 'R07', 'R09', 'R11', 'R22', 'R23', 'R24'].includes(r));
    if (fieldOnly && m.assignedAgentId !== u.id) throw forbidden('MISSION_NOT_ASSIGNED', 'Mission non affectée à cet agent.');
  }

  /**
   * Itinéraire de la mission (module 34 « Missions — zones, listes, itinéraires ») : ordre de passage des objets désignés,
   * au plus proche voisin depuis le centre de la zone, avec distances à vol d'oiseau (indicatif, sans service externe).
   */
  itinerary(m: Mission): { order: number; objectId: string; lat: number; lon: number; legM: number; cumulativeM: number }[] {
    const pts = m.objectIds.map((id) => this.ctx.objects.objects.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
    const out: { order: number; objectId: string; lat: number; lon: number; legM: number; cumulativeM: number }[] = [];
    let cur = { lat: m.center.lat, lon: m.center.lon };
    let total = 0;
    const left = [...pts];
    while (left.length) {
      left.sort((a, b) => distanceM(cur, a) - distanceM(cur, b) || a.id.localeCompare(b.id));
      const next = left.shift()!;
      const leg = distanceM(cur, next);
      total += leg;
      out.push({ order: out.length + 1, objectId: next.id, lat: next.lat, lon: next.lon, legM: leg, cumulativeM: total });
      cur = { lat: next.lat, lon: next.lon };
    }
    return out;
  }

  missionItinerary(u: User, missionId: string) {
    authorize(u, 'terrain:inspection.read');
    const m = this.mission(missionId);
    this.assertMissionAccess(u, m);
    return { missionId: m.id, start: m.center, steps: this.itinerary(m), note: 'Ordre de passage indicatif (plus proche voisin, distances à vol d’oiseau).' };
  }

  /**
   * Objet « non enregistré » découvert sur le terrain (module 34) : fiche PROVISOIRE à identifiant provisoire, créée à
   * partir du constat géolocalisé ; AUCUN effet fiscal avant qualification (validation par une personne distincte, module
   * fiscal) ; aucun redevable rattaché d'office. Idempotent par constat.
   */
  registerUnregistered(u: User, findingId: string, input: { category: ObjectCategory; quartier: string; localityRank: 1 | 2 | 3 | 4 }) {
    authorize(u, 'object.create', { communes: [this.terrain.findings.get(findingId)?.commune ?? ''] });
    const f = this.terrain.findings.get(findingId);
    if (!f) throw notFound('FINDING_NOT_FOUND', `Constat inconnu : ${findingId}`);
    if (f.outcome !== 'OBJET_NON_ENREGISTRE') throw unprocessable('NOT_UNREGISTERED_FINDING', 'Seul un constat « objet non enregistré » crée une fiche provisoire.');
    if (f.agentId !== u.id && !u.roles.some((r) => r === 'R11' || r === 'R07')) throw forbidden('NOT_FINDING_AUTHOR', 'Fiche provisoire créée par l’auteur du constat ou par le contrôle.');
    if (f.status === 'REJETE') throw conflict('FINDING_REJECTED', 'Constat rejeté : aucune fiche.');
    const provisionalId = `OBJ-PROV-${f.id}`;
    const existing = this.ctx.objects.objects.get(provisionalId);
    if (existing) return { object: existing, replayed: true };
    const object = this.ctx.objects.create(u, {
      category: input.category, commune: f.commune, quartier: input.quartier, localityRank: input.localityRank, lat: f.gps.lat, lon: f.gps.lon,
      attributes: { source: 'CONSTAT_TERRAIN', findingId: f.id, ...(f.photoSha256 ? { photoSha256: f.photoSha256 } : {}), observations: f.observations },
    }, provisionalId);
    this.ctx.audit.append({ actor: actorOf(u), action: 'terrain.object.provisional_created', resourceType: 'object', resourceId: object.id, details: { findingId: f.id, commune: f.commune, fiscalEffect: 'AUCUN_AVANT_QUALIFICATION' } });
    return { object, replayed: false };
  }

  /**
   * Paquet hors ligne de la mission : dossiers préparés, modèles de procès-verbal autorisés pour l'agent, signé, expirant
   * à l'échéance de la mission. Le terminal le conserve et le vérifie ; aucune donnée de paiement.
   */
  offlinePackage(u: User, missionId: string) {
    authorize(u, 'terrain:inspection.read');
    const m = this.mission(missionId);
    this.assertMissionAccess(u, m);
    const body = {
      mission: { id: m.id, title: m.title, kind: m.kind, commune: m.commune, quartier: m.quartier ?? null, center: m.center, radiusM: m.radiusM, periodStart: m.periodStart, dueDate: m.dueDate, instructions: m.instructions, toleranceM: this.terrain.toleranceFor(m.commune) },
      dossiers: this.latestDossiers(m.id),
      itinerary: this.itinerary(m),
      templates: this.templatesFor(u),
      powers: this.powersOf(u),
      issuedTo: u.id,
      issuedAt: this.now(),
      validUntil: `${m.dueDate}T23:59:59.000+01:00`,
    };
    const packageHash = sha256Hex(canonicalJson(body));
    const signature = hmacSha256Hex(this.packageKey, packageHash);
    this.ctx.audit.append({ actor: actorOf(u), action: 'terrain.inspection.package.issued', resourceType: 'mission', resourceId: m.id, details: { dossiers: body.dossiers.length, packageHash } });
    return { ...body, packageHash, signature, offline: 'Paquet consultable sans réseau ; les procès-verbaux saisis hors ligne sont transmis à la reconnexion (heure de référence : serveur).' };
  }

  /** Vérification d'un paquet présenté (intégrité, émission par le serveur). */
  verifyPackage(pkg: { packageHash: string; signature: string } & Record<string, unknown>): { valid: boolean; reason?: string } {
    const { packageHash, signature, offline: _o, ...body } = pkg;
    if (sha256Hex(canonicalJson(body)) !== packageHash) return { valid: false, reason: 'Contenu modifié (empreinte différente).' };
    if (hmacSha256Hex(this.packageKey, packageHash) !== signature) return { valid: false, reason: 'Signature du serveur invalide.' };
    return { valid: true };
  }

  private nextNumber(): string {
    this.pvSeq = Math.max(this.pvSeq, this.pvs.count()) + 1;
    return `PV-${kinshasaDate(this.ctx.clock.now()).slice(0, 4)}-${String(this.pvSeq).padStart(6, '0')}`;
  }

  /** Procès-verbal établi par l'auteur du constat, selon un modèle de SON pouvoir ; numéroté par le système ; transmis au superviseur. */
  draft(u: User, input: {
    clientRef: string; findingId: string; templateId: string; personDeclaration: string;
    signature: ProcesVerbal['signature']; signedAt: string; extraPhotoSha256?: string[]; supersedes?: string;
  }): { pv: ProcesVerbal; replayed: boolean } {
    authorize(u, 'terrain:pv.draft');
    const f = this.terrain.findings.get(input.findingId);
    if (!f) throw notFound('FINDING_NOT_FOUND', `Constat inconnu : ${input.findingId}`);
    if (f.agentId !== u.id) throw forbidden('NOT_FINDING_AUTHOR', 'Le procès-verbal est établi par l’auteur du constat.');
    if (f.status === 'REJETE') throw conflict('FINDING_REJECTED', 'Constat rejeté : aucun procès-verbal.');
    const tpl = PV_TEMPLATES.find((t) => t.id === input.templateId);
    if (!tpl) throw notFound('PV_TEMPLATE_NOT_FOUND', `Modèle inconnu : ${input.templateId}`);
    if (!this.powersOf(u).includes(tpl.power)) throw forbidden('POWER_NOT_HELD', `Pouvoir « ${LEGAL_POWERS[tpl.power].label} » non détenu : modèle ${tpl.id} interdit.`);
    if (input.signature.kind === 'SIGNE' && (!input.signature.signerName?.trim() || !input.signature.signatureImageSha256)) throw badRequest('SIGNATURE_INCOMPLETE', 'Signature : nom du signataire et empreinte de la signature requis.');
    if (input.signature.kind === 'REFUS_DE_SIGNER' && !input.signature.refusalNote?.trim()) throw badRequest('REFUSAL_NOTE_REQUIRED', 'Refus de signer : mention obligatoire des circonstances.');
    const statements = { observations: f.observations, personDeclaration: input.personDeclaration.trim() };
    const photos = [...new Set([...(f.photoSha256 ? [f.photoSha256] : []), ...(input.extraPhotoSha256 ?? []).map((h) => h.toLowerCase())])];
    const sealContent = { clientRef: input.clientRef, findingId: f.id, findingSeal: f.seal, templateId: tpl.id, templateVersion: tpl.version, authorId: u.id, statements, signature: input.signature, photos, signedAt: input.signedAt, supersedes: input.supersedes ?? null };
    const seal = sha256Hex(canonicalJson(sealContent));
    const prior = this.pvs.findOne((p) => p.authorId === u.id && p.clientRef === input.clientRef);
    if (prior) {
      if (prior.seal !== seal) throw conflict('CLIENT_REF_REUSED', 'Référence de procès-verbal déjà utilisée avec un autre contenu.');
      return { pv: prior, replayed: true };
    }
    let version = 1;
    if (input.supersedes) {
      const old = this.getPv(input.supersedes);
      if (old.status === 'VALIDE') throw conflict('PV_VALIDATED_IMMUTABLE', 'Procès-verbal validé : il n’est jamais modifié (contestation possible).');
      if (old.status === 'REMPLACE') throw conflict('PV_ALREADY_SUPERSEDED', 'Procès-verbal déjà remplacé.');
      if (old.authorId !== u.id || old.findingId !== f.id) throw forbidden('NOT_PV_AUTHOR', 'Rectification par l’auteur, sur le même constat.');
      version = old.version + 1;
      this.pvs.update({ ...old, status: 'REMPLACE' });
    } else if (this.pvs.findOne((p) => p.findingId === f.id && p.status !== 'REJETE' && p.status !== 'REMPLACE')) {
      throw conflict('PV_EXISTS', 'Un procès-verbal existe déjà pour ce constat : rectifier (nouvelle version) plutôt que doubler.');
    }
    const pv = this.pvs.insert({
      id: this.ids.next('PV', 6), number: this.nextNumber(), version, ...(input.supersedes ? { supersedes: input.supersedes } : {}), clientRef: input.clientRef,
      findingId: f.id, missionId: f.missionId, ...(f.objectId ? { objectId: f.objectId } : {}), templateId: tpl.id, templateVersion: tpl.version, power: tpl.power,
      authorId: u.id, commune: f.commune, gps: f.gps, distanceM: f.distanceM, geofenceFlags: f.flags, findingSeal: f.seal, statements, signature: input.signature,
      photoSha256: photos, signedAt: input.signedAt, recordedAt: this.now(), seal, status: 'TRANSMIS', contestations: [],
    });
    this.ctx.audit.append({ actor: actorOf(u), action: 'terrain.pv.transmitted', resourceType: 'pv', resourceId: pv.id, details: { number: pv.number, findingId: f.id, templateId: tpl.id, power: tpl.power, signature: pv.signature.kind, seal, version, geofenceFlags: f.flags } });
    const m = this.terrain.missions.get(f.missionId);
    const supervisors = this.ctx.users.withRole('R09').filter((s) => !s.territory || s.territory.includes(f.commune)).filter((s) => s.id !== u.id);
    if (m && supervisors.length) this.ctx.comms.publish('approval.requested', supervisors.map(userRecipient), { objet: `Procès-verbal ${pv.number} à valider (mission ${m.id})` }, { entity: 'DGIPK' });
    return { pv, replayed: false };
  }

  getPv(id: string): ProcesVerbal {
    const p = this.pvs.get(id);
    if (!p) throw notFound('PV_NOT_FOUND', `Procès-verbal inconnu : ${id}`);
    return p;
  }

  list(u: User, filter: { status?: string; missionId?: string } = {}): ProcesVerbal[] {
    authorize(u, 'terrain:inspection.read');
    const fieldOnly = u.roles.includes('R10') && !u.roles.some((r) => ['R06', 'R07', 'R09', 'R11', 'R22', 'R23', 'R24'].includes(r));
    return this.pvs.find((p) => (!fieldOnly || p.authorId === u.id) && (!filter.status || p.status === filter.status) && (!filter.missionId || p.missionId === filter.missionId))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  /** Validation par le superviseur (personne distincte de l'auteur) ; un procès-verbal validé est figé. */
  review(u: User, id: string, input: { decision: 'VALIDE' | 'REJETE'; reason: string }): ProcesVerbal {
    authorize(u, 'terrain:pv.validate');
    const p = this.getPv(id);
    assertDistinctPerson(u.id, [p.authorId], 'Séparation des tâches : l’auteur ne valide jamais son propre procès-verbal.');
    if (p.status !== 'TRANSMIS') throw conflict(p.status === 'VALIDE' ? 'PV_VALIDATED_IMMUTABLE' : 'PV_NOT_PENDING', `Procès-verbal au statut ${p.status} : décision impossible.`);
    if (input.reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Décision motivée (5 caractères au moins).');
    const out = this.pvs.update({ ...p, status: input.decision, review: { by: u.id, at: this.now(), decision: input.decision, reason: input.reason.trim() } });
    this.ctx.audit.append({ actor: actorOf(u), action: input.decision === 'VALIDE' ? 'terrain.pv.validated' : 'terrain.pv.rejected', resourceType: 'pv', resourceId: id, details: { number: p.number, seal: p.seal, reason: input.reason.trim() } });
    return out;
  }

  /** Contestation par la personne concernée (ou au guichet pour elle) : accusé de réception horodaté. */
  contest(u: User, id: string, text: string): ProcesVerbal {
    const p = this.getPv(id);
    const o = p.objectId ? this.ctx.objects.objects.get(p.objectId) : undefined;
    authorize(u, 'terrain:pv.contest', o?.taxpayerId ? { taxpayerId: o.taxpayerId } : {});
    if (p.status !== 'VALIDE' && p.status !== 'TRANSMIS') throw conflict('PV_NOT_CONTESTABLE', `Procès-verbal au statut ${p.status}.`);
    if (text.trim().length < 10) throw badRequest('TEXT_REQUIRED', 'Motif de la contestation (10 caractères au moins).');
    const at = this.now();
    const c = { id: this.ids.next('CPV', 6), by: u.id, at, text: text.trim(), acknowledgement: `Accusé de réception ${sha256Hex(`${p.id}|${u.id}|${at}`).slice(0, 12).toUpperCase()} — ${at}` };
    const out = this.pvs.update({ ...p, contestations: [...p.contestations, c] });
    this.ctx.audit.append({ actor: actorOf(u), action: 'terrain.pv.contested', resourceType: 'pv', resourceId: id, details: { number: p.number, contestationId: c.id } });
    return out;
  }

  answer(u: User, id: string, contestationId: string, text: string): ProcesVerbal {
    authorize(u, 'terrain:pv.answer');
    const p = this.getPv(id);
    assertDistinctPerson(u.id, [p.authorId], 'La réponse à une contestation est donnée par une personne distincte de l’auteur du procès-verbal.');
    const c = p.contestations.find((x) => x.id === contestationId);
    if (!c) throw notFound('CONTESTATION_NOT_FOUND', `Contestation inconnue : ${contestationId}`);
    if (c.answer) throw conflict('CONTESTATION_ANSWERED', 'Contestation déjà traitée.');
    if (text.trim().length < 10) throw badRequest('REASON_REQUIRED', 'Réponse motivée (10 caractères au moins).');
    const out = this.pvs.update({ ...p, contestations: p.contestations.map((x) => (x.id === contestationId ? { ...x, answer: { by: u.id, at: this.now(), text: text.trim() } } : x)) });
    this.ctx.audit.append({ actor: actorOf(u), action: 'terrain.pv.contestation.answered', resourceType: 'pv', resourceId: id, details: { contestationId } });
    return out;
  }

  /** PV visibles par le contribuable concerné (ses objets). */
  mine(u: User): ProcesVerbal[] {
    if (!u.taxpayerId) return [];
    const objects = new Set(this.ctx.objects.objects.find((o) => o.taxpayerId === u.taxpayerId).map((o) => o.id));
    return this.pvs.find((p) => !!p.objectId && objects.has(p.objectId) && p.status !== 'REMPLACE');
  }

  /** Indicateurs du module 35 : constats, taux de validation, contestations (données réelles). */
  indicators(u: User) {
    authorize(u, 'terrain:inspection.read');
    const findings = this.terrain.findings.all();
    const reviewed = findings.filter((f) => f.status === 'VALIDE' || f.status === 'REJETE');
    const validated = reviewed.filter((f) => f.status === 'VALIDE').length;
    const pvs = this.pvs.all().filter((p) => p.status !== 'REMPLACE');
    const pvReviewed = pvs.filter((p) => p.status === 'VALIDE' || p.status === 'REJETE');
    const contestations = pvs.flatMap((p) => p.contestations);
    return {
      constats: { total: findings.length, soumis: findings.filter((f) => f.status === 'SOUMIS').length, valides: validated, rejetes: reviewed.length - validated, horsZone: findings.filter((f) => f.flags.includes('HORS_ZONE') || f.flags.includes('DISTANCE')).length },
      tauxValidation: reviewed.length ? { statut: 'MESURE' as const, valeur: `${Math.round((validated * 1000) / reviewed.length) / 10} %`, revus: reviewed.length } : { statut: 'NON_MESURE' as const, motif: 'Aucun constat revu.' },
      procesVerbaux: { total: pvs.length, transmis: pvs.filter((p) => p.status === 'TRANSMIS').length, valides: pvs.filter((p) => p.status === 'VALIDE').length, rejetes: pvs.filter((p) => p.status === 'REJETE').length, tauxValidation: pvReviewed.length ? `${Math.round((pvReviewed.filter((p) => p.status === 'VALIDE').length * 1000) / pvReviewed.length) / 10} %` : null, refusDeSigner: pvs.filter((p) => p.signature.kind === 'REFUS_DE_SIGNER').length },
      contestations: { total: contestations.length, traitees: contestations.filter((c) => !!c.answer).length },
      dossiers: this.dossiers.count(),
    };
  }
}
