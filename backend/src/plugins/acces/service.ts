/**
 * Service du module « acces » : espaces d'entité et fiches de module, revendications et arbitrages entre entités,
 * invitations en cascade, comptes de travail et secondes validations, identité avancée (OTP, niveaux, personnes
 * morales, doublons et fusion), mandats, MFA simulé et consultation motivée (bris de glace).
 *
 * Doctrine : aucune décision automatique défavorable — le système bloque la seconde revendication et ouvre un dossier,
 * une personne habilitée décide avec motif ; aucune obligation n'est annulée ni créée en double par ce module ;
 * aucun code à usage unique n'est jamais renvoyé par l'API métier (bac à sable : boîte d'envoi journalisée).
 */
import { randomInt } from 'node:crypto';
import { hasIncompatibility, ROLES, type RoleCode, type VerificationLevel } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf, type AuditActor } from '../../core/audit.js';
import { ACR, hasAcr, isDemoMode, type User } from '../../core/auth.js';
import { HOUR_MS, isoDate, kinshasaDate } from '../../core/clock.js';
import { hmacSha256Hex, randomSecret, sha256Hex } from '../../core/crypto.js';
import { ApiError, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, evaluate, registerPersonResolver, registerRelatedTaxpayersResolver, type AnyAction } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { obligationSummary } from '../../modules/assessment/views.js';
import type { Recipient } from '../../modules/communications/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { maskPhone, type Taxpayer } from '../../modules/identity/service.js';
import {
  FIELD_ROLES, LEVEL_INFO, LEVEL_ORDER, LEVEL_RANK, LEVEL_RIGHTS, ROLE_LEVEL, SECOND_VALIDATION_ROLES, SENSITIVE_ROLES,
  type AccessLevel, type ArbitrationCase, type Claim, type Consultation, type EntityKind, type EntitySpace, type Grant,
  type IdentityProof, type Invitation, type InvitationScope, type Mandate, type MandateAction, type MergeRequest,
  type ModuleConfig, type ModuleStatus, type ModuleVisa, type Organisation, type OtpChallenge, type ProofType,
  type Representative, type SandboxMessage, type TaxableFact, type ValidationRequest, type ValidatorRequirement, type WorkAccount,
} from './model.js';
import { ElevationService } from './elevations.js';

export const INVITATION_TTL_MS = 72 * HOUR_MS;
export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const MFA_SESSION_MS = 15 * 60_000;
export const CONSULTATION_TTL_MS = 30 * 60_000;
const SPECIAL_LEVELS: AccessLevel[] = ['AUDIT', 'ADMIN_TECHNIQUE'];
const PUBLIC_ROLES: RoleCode[] = ['R30', 'R31'];

export const normalizePhone = (p: string): string => p.replace(/[\s-]/g, '');
/** Pièce présentée à la finalisation d'une invitation (numéro jamais conservé en clair). */
export interface IdentityDocumentInput { type: string; number: string; birthDate?: string }
/** Comptes clos : n'empêchent pas l'ouverture d'un nouveau compte pour la même personne. */
const CLOSED_ACCOUNT: WorkAccount['status'][] = ['REVOQUE', 'EXPIRE'];
const tooMany = (code: string, detail: string) => new ApiError(429, code, detail);

function maskRef(ref: string): string {
  const clean = ref.trim();
  return clean.length <= 3 ? '•••' : `${'•'.repeat(Math.min(8, clean.length - 3))}${clean.slice(-3)}`;
}

function normName(n: string): string[] {
  return n.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
}

export class AccesService {
  readonly entities = new InMemoryRepository<EntitySpace>();
  readonly modules = new InMemoryRepository<ModuleConfig>();
  readonly claims = new InMemoryRepository<Claim>();
  readonly arbitrations = new InMemoryRepository<ArbitrationCase>();
  readonly invitations = new InMemoryRepository<Invitation>();
  readonly accounts = new InMemoryRepository<WorkAccount>();
  readonly validations = new InMemoryRepository<ValidationRequest>();
  readonly grants = new InMemoryRepository<Grant>();
  readonly proofs = new InMemoryRepository<IdentityProof>();
  readonly organisations = new InMemoryRepository<Organisation>();
  readonly otps = new InMemoryRepository<OtpChallenge>();
  readonly outbox = new InMemoryAppendOnlyRepository<SandboxMessage>();
  readonly merges = new InMemoryRepository<MergeRequest>();
  readonly consultations = new InMemoryRepository<Consultation>();
  readonly mandates = new InMemoryRepository<Mandate>();
  /** Sessions MFA (démo) : utilisateur → fin de validité. */
  private readonly mfaSessions = new Map<string, string>();
  /** Mandataires professionnels certifiés N3 (cabinet, mandat notarié). */
  readonly certifiedMandataires = new Set<string>();
  /** Proches déclarés (module 91, conflits d'intérêts) : agent → contribuables. */
  readonly declaredRelations = new Map<string, Set<string>>();
  /** Correspondance règle → fait générateur (établie par les revendications et les fiches). */
  readonly ruleFacts = new Map<string, TaxableFact>();
  private readonly ids = new IdGenerator();
  private readonly smsWired: boolean;
  /** Clé d'empreinte des pièces d'identité, dérivée du secret serveur (jamais le secret lui-même, jamais le numéro). */
  private readonly personKey: string;

  /** Accès privilégié juste-à-temps (élévation motivée, approuvée, expirante, session enregistrée). */
  readonly elevations: ElevationService;

  constructor(private readonly ctx: AppContext) {
    this.elevations = new ElevationService(ctx, this);
    this.smsWired = ctx.comms.channelStatus().some((c) => c.channel === 'sms' && c.wired);
    this.personKey = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:acces:empreinte-personne:v1');
    // Source des liens agent ↔ contribuables pour le contrôle de conflit d'intérêts (vérifier, décider, accorder).
    registerRelatedTaxpayersResolver((u) => this.relatedTaxpayers(u));
    // Séparation des tâches par personne physique : compte → empreinte de la pièce d'identité.
    registerPersonResolver((id) => this.ctx.users.get(id)?.personId ?? this.accounts.get(id)?.personId);
  }

  /**
   * Identifiant de personne : HMAC (clé serveur) du numéro de pièce normalisé (majuscules, sans accents, espaces ni
   * séparateurs). Le TYPE de pièce, saisi librement, est ignoré : changer le libellé ne fabrique pas une autre personne.
   */
  personIdFor(documentNumber: string): string {
    const norm = documentNumber.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm.length < 3) throw unprocessable('ID_DOCUMENT_INVALID', 'Numéro de pièce d’identité illisible.');
    return `P-${hmacSha256Hex(this.personKey, norm).slice(0, 40)}`;
  }

  /**
   * Bac à sable : MODE DÉMONSTRATION EXPLICITE et aucun fournisseur SMS branché — les codes sont journalisés dans la
   * boîte d'envoi. Hors démonstration, jamais : la boîte d'envoi exposerait codes à usage unique, codes MFA et jetons
   * d'invitation.
   */
  get sandbox(): boolean {
    return !this.smsWired && isDemoMode();
  }

  // ═════════════════════════════════ Outils communs ═════════════════════════════════

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  private today(): string {
    return kinshasaDate(this.ctx.clock.now());
  }

  private actor(user: User): AuditActor {
    return actorOf(user);
  }

  private log(actor: AuditActor, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}, outcome?: 'SUCCESS' | 'DENIED') {
    this.ctx.audit.append({ actor, action: `acces.${action}`, resourceType, resourceId, details, ...(outcome ? { outcome } : {}) });
  }

  private usersRecipients(users: User[]): Recipient[] {
    return users.map(userRecipient);
  }

  private publishSafe(event: string, recipients: Recipient[], vars: Record<string, string>, entity: string): void {
    if (recipients.length) this.ctx.comms.publish(event, recipients, vars, { entity });
  }

  private sandboxSend(to: string, purpose: string, text: string): void {
    if (!this.sandbox) return;
    this.outbox.append({ id: this.ids.next('SBX', 6), at: this.now(), to: normalizePhone(to), purpose, text });
  }

  sandboxMessages(to: string): SandboxMessage[] {
    if (!isDemoMode()) throw notFound('ROUTE_NOT_FOUND', 'Indisponible hors mode démonstration.');
    if (!this.sandbox) throw notFound('SANDBOX_DISABLED', 'Boîte d’envoi du bac à sable indisponible : un fournisseur de messages est branché.');
    const t = normalizePhone(to);
    return this.outbox.find((m) => m.to === t).reverse();
  }

  /** Balayage des échéances (mandats, accès temporaires, invitations) sur l'heure serveur. */
  sweep(): void {
    const now = this.now();
    const today = this.today();
    for (const m of this.mandates.find((x) => x.status === 'ACTIF' && x.validTo < today)) {
      this.mandates.update({ ...m, status: 'EXPIRE' });
      this.syncMandants(m.mandataireUserId, m.mandantTaxpayerId);
      this.log({ kind: 'system', id: 'echeancier' }, 'mandate.expired', 'mandate', m.id, { mandant: m.mandantTaxpayerId });
    }
    for (const a of this.accounts.find((x) => x.status === 'ACTIF' && !!x.scope.validUntil && x.scope.validUntil < today)) {
      this.accounts.update({ ...a, status: 'EXPIRE' });
      this.setDirectoryRoles(a.id, []);
      this.log({ kind: 'system', id: 'echeancier' }, 'account.expired', 'account', a.id, { entity: a.entity });
    }
    for (const i of this.invitations.find((x) => x.status === 'ENVOYEE' && x.expiresAt < now)) {
      this.invitations.update({ ...i, status: 'EXPIREE' });
      this.log({ kind: 'system', id: 'echeancier' }, 'invitation.expired', 'invitation', i.id, { entity: i.entity });
    }
  }

  // ═════════════════════════════════ MFA et codes à usage unique ═════════════════════════════════

  private issueOtp(purpose: OtpChallenge['purpose'], subjectId: string, to: string, label: string): OtpChallenge {
    const since = new Date(this.ctx.clock.now().getTime() - 15 * 60_000).toISOString();
    if (this.otps.find((o) => o.subjectId === subjectId && o.purpose === purpose && o.createdAt >= since).length >= 3) {
      throw tooMany('OTP_RATE_LIMITED', 'Trop de codes demandés : réessayez dans quelques minutes.');
    }
    for (const o of this.otps.find((x) => x.subjectId === subjectId && x.purpose === purpose && x.status === 'EN_ATTENTE')) {
      this.otps.update({ ...o, status: 'EXPIRE' });
    }
    const id = this.ids.next('OTP', 6);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challenge = this.otps.insert({
      id, purpose, subjectId, codeHash: sha256Hex(`${id}:${code}`), attempts: 0, status: 'EN_ATTENTE',
      expiresAt: new Date(this.ctx.clock.now().getTime() + OTP_TTL_MS).toISOString(), createdAt: this.now(),
    });
    this.sandboxSend(to, label, `Votre code MOSOLO : ${code} (valable 5 minutes, usage unique). Ne le communiquez à personne.`);
    return challenge;
  }

  private checkOtp(challengeId: string, subjectId: string, purpose: OtpChallenge['purpose'], code: string): void {
    const c = this.otps.get(challengeId);
    if (!c || c.subjectId !== subjectId || c.purpose !== purpose) throw notFound('OTP_UNKNOWN', 'Demande de code inconnue.');
    if (c.status === 'VERIFIE') throw conflict('OTP_ALREADY_USED', 'Ce code a déjà été utilisé.');
    if (c.status === 'BLOQUE') throw tooMany('OTP_LOCKED', 'Trop d’essais : demandez un nouveau code.');
    if (c.status === 'EXPIRE' || c.expiresAt < this.now()) {
      this.otps.update({ ...c, status: 'EXPIRE' });
      throw unprocessable('OTP_EXPIRED', 'Code expiré : demandez un nouveau code.');
    }
    if (sha256Hex(`${c.id}:${code}`) !== c.codeHash) {
      const attempts = c.attempts + 1;
      this.otps.update({ ...c, attempts, status: attempts >= OTP_MAX_ATTEMPTS ? 'BLOQUE' : 'EN_ATTENTE' });
      throw unprocessable('OTP_INVALID', `Code incorrect (${OTP_MAX_ATTEMPTS - attempts} essai(s) restant(s)).`);
    }
    this.otps.update({ ...c, status: 'VERIFIE' });
  }

  isSensitive(user: User): boolean {
    return user.roles.some((r) => SENSITIVE_ROLES.includes(r)) || this.hasInviteRight(user);
  }

  mfaActiveUntil(user: User): string | null {
    const until = this.mfaSessions.get(user.id);
    return until && until > this.now() ? until : null;
  }

  mfaChallenge(user: User) {
    const c = this.issueOtp('MFA', user.id, `app:${user.id}`, 'Second facteur (application d’authentification simulée)');
    this.log(this.actor(user), 'mfa.challenge', 'user', user.id);
    return { challengeId: c.id, expiresAt: c.expiresAt, channel: 'application d’authentification (simulée)', sandbox: this.sandbox };
  }

  mfaVerify(user: User, challengeId: string, code: string) {
    try {
      this.checkOtp(challengeId, user.id, 'MFA', code);
    } catch (e) {
      this.log(this.actor(user), 'mfa.failed', 'user', user.id, {}, 'DENIED');
      throw e;
    }
    const until = new Date(this.ctx.clock.now().getTime() + MFA_SESSION_MS).toISOString();
    this.mfaSessions.set(user.id, until);
    this.log(this.actor(user), 'mfa.verified', 'user', user.id, { until });
    return { mfa: true, until };
  }

  /** Actions sensibles : second facteur récent exigé (toujours pour le bris de glace). */
  requireMfa(user: User, always = false): void {
    if (!always && !this.isSensitive(user)) return;
    // Session ouverte par mot de passe + TOTP (fournisseur d'identité « socle ») : le second facteur est déjà prouvé.
    if (hasAcr(user, ACR.MFA)) return;
    if (!this.mfaActiveUntil(user)) {
      throw unauthorized('MFA_REQUIRED', 'Second facteur requis pour cette action sensible : validez votre code d’authentification.');
    }
  }

  // ═════════════════════════════════ Entités ═════════════════════════════════

  entity(id: string): EntitySpace {
    const e = this.entities.get(id);
    if (!e) throw notFound('ENTITY_NOT_FOUND', `Entité inconnue : ${id}`);
    return e;
  }

  /** L'entité et toutes ses sous-entités (espace de l'administrateur d'entité). */
  subtree(rootId: string): Set<string> {
    const out = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of this.entities.all()) {
        if (e.parentId && out.has(e.parentId) && !out.has(e.id)) { out.add(e.id); grew = true; }
      }
    }
    return out;
  }

  private isPlatformAdmin(user: User): boolean {
    return user.roles.includes('R26');
  }

  private isOversight(user: User): boolean {
    return user.roles.some((r) => ['R26', 'R22', 'R23', 'R28'].includes(r));
  }

  /** Entités visibles pour l'administration des accès : tout pour la supervision, sinon son sous-arbre. */
  private visibleEntities(user: User): Set<string> | null {
    return this.isOversight(user) ? null : this.subtree(user.entity);
  }

  listEntities() {
    return this.entities.all().map((e) => ({
      ...e,
      modules: this.modules.find((m) => m.responsibleEntity === e.id && m.status !== 'RETIRE').map((m) => ({ id: m.id, code: m.code, label: m.label, status: m.status })),
      accounts: this.allAccounts().filter((a) => a.entity === e.id && a.status === 'ACTIF').length,
    }));
  }

  createEntity(user: User, input: { id: string; name: string; shortName: string; kind: EntityKind; parentId: string | null; decisionRef: string }): EntitySpace {
    this.requireMfa(user);
    if (this.entities.get(input.id)) throw conflict('ENTITY_EXISTS', `L’entité ${input.id} existe déjà.`);
    if (input.parentId) this.entity(input.parentId);
    const e = this.entities.insert({
      id: input.id, name: input.name, shortName: input.shortName, kind: input.kind, parentId: input.parentId,
      status: 'ACTIVE', createdAt: this.now(), createdBy: user.id, decisionRef: input.decisionRef,
    });
    this.log(this.actor(user), 'entity.created', 'entity', e.id, { entity: e.id, kind: e.kind, parentId: e.parentId, decisionRef: input.decisionRef });
    this.publishSafe('entity.space.activated', this.usersRecipients([user]), { reference: e.id }, 'PLATEFORME');
    return e;
  }

  /** Suspension d'une entité : révocation en cascade de tous ses comptes et invitations (§ 12A.5). */
  suspendEntity(user: User, id: string, input: { motif: string; decisionRef: string }) {
    this.requireMfa(user);
    const target = this.entity(id);
    if (target.kind === 'PLATEFORME') throw unprocessable('ENTITY_NOT_SUSPENDABLE', 'L’espace d’exploitation de la plateforme ne peut pas être suspendu par cette voie.');
    if (target.status === 'SUSPENDUE') throw conflict('ENTITY_ALREADY_SUSPENDED', 'Entité déjà suspendue.');
    const scope = this.subtree(id);
    let revokedAccounts = 0;
    let revokedInvitations = 0;
    for (const eid of scope) {
      const e = this.entities.get(eid)!;
      if (e.status === 'ACTIVE') this.entities.update({ ...e, status: 'SUSPENDUE', suspendedAt: this.now(), suspensionReason: input.motif });
    }
    for (const a of this.allAccounts().filter((x) => scope.has(x.entity) && x.status !== 'REVOQUE')) {
      this.doRevokeAccount(user, a, `Suspension de l’entité ${id} : ${input.motif}`, undefined);
      revokedAccounts++;
    }
    for (const i of this.invitations.find((x) => scope.has(x.entity) && x.status === 'ENVOYEE')) {
      this.invitations.update({ ...i, status: 'REVOQUEE', revokedAt: this.now(), revokedReason: `Suspension de l’entité ${id}` });
      revokedInvitations++;
    }
    this.log(this.actor(user), 'entity.suspended', 'entity', id, { entity: id, motif: input.motif, decisionRef: input.decisionRef, revokedAccounts, revokedInvitations, cascade: [...scope] });
    return { entity: this.entity(id), revokedAccounts, revokedInvitations, cascade: [...scope] };
  }

  // ═════════════════════════════════ Fiches de configuration de module ═════════════════════════════════

  module(id: string): ModuleConfig {
    const m = this.modules.get(id);
    if (!m) throw notFound('MODULE_NOT_FOUND', `Fiche de module inconnue : ${id}`);
    return m;
  }

  private transition(m: ModuleConfig, to: ModuleStatus, by: string, note?: string, patch: Partial<ModuleConfig> = {}): ModuleConfig {
    return this.modules.update({ ...m, ...patch, status: to, history: [...m.history, { at: this.now(), from: m.status, to, by, ...(note ? { note } : {}) }] });
  }

  private visaActors(m: ModuleConfig): string[] {
    return m.visas.map((v) => v.by);
  }

  private visa(user: User, step: ModuleVisa['step'], note?: string): ModuleVisa {
    const role = user.roles[0]!;
    return { step, by: user.id, role, at: this.now(), ...(note ? { note } : {}) };
  }

  createModule(user: User, input: Omit<ModuleConfig, 'id' | 'status' | 'visas' | 'history' | 'attachments' | 'createdBy' | 'createdAt' | 'recette' | 'pendingReattachment' | 'arbitrationId' | 'demo'>, opts: { demo?: boolean } = {}) {
    const ent = this.entity(input.responsibleEntity);
    if (ent.status !== 'ACTIVE') throw unprocessable('ENTITY_SUSPENDED', 'Entité suspendue : aucune fiche ne peut lui être rattachée.');
    if (this.modules.findOne((m) => m.code === input.code)) throw conflict('MODULE_CODE_EXISTS', `Code de module déjà utilisé : ${input.code}`);
    for (const a of input.beneficiaryAliases) {
      if (!this.ctx.vault.aliasExists(a)) throw unprocessable('BENEFICIARY_NOT_IN_VAULT', `Compte bénéficiaire ${a} absent du coffre : seuls les comptes publics du coffre sont admis.`);
    }
    const known = new Set(this.ctx.rules.list().map((r) => r.code));
    const unknown = input.ruleCodes.filter((c) => !known.has(c));
    if (unknown.length) throw unprocessable('UNKNOWN_RULE', `Règles absentes du registre : ${unknown.join(', ')}.`);
    if (input.moduleManagerId) {
      const mgr = this.ctx.users.get(input.moduleManagerId);
      if (!mgr || !this.subtree(ent.id).has(mgr.entity)) throw unprocessable('MANAGER_OUT_OF_ENTITY', 'Le responsable de module doit appartenir à l’entité responsable.');
    }
    const id = this.ids.next('MOD', 4);
    const rivals = this.modules.find((m) => m.responsibleEntity !== input.responsibleEntity && m.status !== 'RETIRE'
      && (m.revenueScope === input.revenueScope || m.ruleCodes.some((c) => input.ruleCodes.includes(c))));
    let m = this.modules.insert({
      ...input, id, status: 'BROUILLON', visas: [], attachments: [], createdBy: user.id, createdAt: this.now(),
      history: [{ at: this.now(), from: null, to: 'BROUILLON', by: user.id }], ...(opts.demo ? { demo: true } : {}),
    });
    this.log(this.actor(user), 'module.drafted', 'module', id, { entity: input.responsibleEntity, code: input.code, revenueScope: input.revenueScope });
    let arbitration: ArbitrationCase | undefined;
    if (rivals.length) {
      // Deux entités revendiquent la même compétence : la seconde fiche est bloquée, un dossier d'arbitrage est ouvert.
      arbitration = this.openOrJoinArbitration({
        kind: 'COMPETENCE_MODULE',
        subject: { revenueScope: input.revenueScope, ruleCodes: [...new Set([...input.ruleCodes, ...rivals.flatMap((r) => r.ruleCodes)])] },
        holders: rivals.map((r) => ({ entity: r.responsibleEntity, moduleConfigId: r.id })),
        newcomer: { entity: input.responsibleEntity, moduleConfigId: id },
        openedBy: user.id,
        existingObligationIds: [],
        demo: !!opts.demo,
      });
      m = this.transition(m, 'BLOQUE_ARBITRAGE', 'systeme', `Compétence déjà revendiquée par ${rivals.map((r) => r.responsibleEntity).join(', ')} : dossier ${arbitration.id}`, { arbitrationId: arbitration.id });
      this.log({ kind: 'system', id: 'arbitrage' }, 'module.blocked', 'module', id, { entity: input.responsibleEntity, arbitrationId: arbitration.id });
    }
    return { module: m, blocked: !!arbitration, ...(arbitration ? { arbitrationId: arbitration.id } : {}) };
  }

  submitModule(user: User, id: string, note?: string) {
    const m = this.module(id);
    if (m.status !== 'BROUILLON') throw conflict('MODULE_BAD_STATE', `Soumission impossible depuis l’état ${m.status}.`);
    const out = this.transition(m, 'VALIDATION_PROGRAMME', user.id, note, { visas: [this.visa(user, 'SOUMISSION', note)] });
    this.log(this.actor(user), 'module.submitted', 'module', id, { entity: m.responsibleEntity });
    return out;
  }

  visaProgramme(user: User, id: string, note?: string) {
    const m = this.module(id);
    if (m.status !== 'VALIDATION_PROGRAMME') throw conflict('MODULE_BAD_STATE', `Visa programme impossible depuis l’état ${m.status}.`);
    assertDistinctPerson(user.id, this.visaActors(m), 'Chaque visa de la fiche est donné par une personne distincte (maker-checker).');
    this.requireMfa(user);
    const out = this.transition(m, 'VALIDATION_JURIDIQUE', user.id, note, { visas: [...m.visas, this.visa(user, 'PROGRAMME', note)] });
    this.log(this.actor(user), 'module.visa.programme', 'module', id, { entity: m.responsibleEntity });
    return out;
  }

  visaJuridique(user: User, id: string, input: { actReferences: string[]; note?: string }) {
    const m = this.module(id);
    if (m.status !== 'VALIDATION_JURIDIQUE') throw conflict('MODULE_BAD_STATE', `Visa juridique impossible depuis l’état ${m.status}.`);
    assertDistinctPerson(user.id, this.visaActors(m), 'Chaque visa de la fiche est donné par une personne distincte (maker-checker).');
    this.requireMfa(user);
    const out = this.transition(m, 'RECETTE', user.id, input.note, {
      visas: [...m.visas, this.visa(user, 'JURIDIQUE', input.note)], actReferences: [...new Set([...m.actReferences, ...input.actReferences])],
    });
    this.log(this.actor(user), 'module.visa.juridique', 'module', id, { entity: m.responsibleEntity, actReferences: input.actReferences });
    return out;
  }

  recordRecette(user: User, id: string, input: { passed: boolean; report: string }) {
    const m = this.module(id);
    if (m.status !== 'RECETTE') throw conflict('MODULE_BAD_STATE', `Recette impossible depuis l’état ${m.status}.`);
    assertDistinctPerson(user.id, this.visaActors(m), 'La recette est constatée par une personne distincte des signataires de la fiche.');
    const recette = { passed: input.passed, report: input.report, by: user.id, at: this.now() };
    const out = input.passed
      ? this.transition(m, 'SECONDE_VALIDATION', user.id, input.report, { recette, visas: [...m.visas, this.visa(user, 'RECETTE', input.report)] })
      : this.transition(m, 'BROUILLON', user.id, `Échec de recette : ${input.report}`, { recette, visas: [] });
    this.log(this.actor(user), 'module.recette', 'module', id, { entity: m.responsibleEntity, passed: input.passed });
    return out;
  }

  activateModule(user: User, id: string, input: { actReference: string; note?: string }) {
    const m = this.module(id);
    if (m.status !== 'SECONDE_VALIDATION') throw conflict('MODULE_BAD_STATE', `Activation impossible depuis l’état ${m.status} : fiche approuvée et recette réussie requises.`);
    assertDistinctPerson(user.id, this.visaActors(m), 'La seconde validation est donnée par une personne distincte des signataires de la fiche.');
    this.requireMfa(user);
    if (this.entity(m.responsibleEntity).status !== 'ACTIVE') throw unprocessable('ENTITY_SUSPENDED', 'Entité responsable suspendue.');
    if (!m.beneficiaryAliases.length) throw unprocessable('BENEFICIARY_REQUIRED', 'Au moins un compte bénéficiaire public du coffre est requis avant activation.');
    const active = new Set(this.ctx.rules.list().filter((r) => r.status === 'ACTIVE').map((r) => r.code));
    const notActive = m.ruleCodes.filter((c) => !active.has(c));
    if (notActive.length) {
      throw unprocessable('RULE_NOT_ACTIVE', `Activation refusée : règles non actives (4 visas requis) — ${notActive.join(', ')}. Les tarifs restent « acte requis ».`, { rules: notActive });
    }
    const clash = this.modules.findOne((x) => x.id !== m.id && x.status === 'ACTIF' && x.revenueScope === m.revenueScope && x.responsibleEntity !== m.responsibleEntity);
    if (clash) throw conflict('SCOPE_ALREADY_ATTACHED', `La compétence ${m.revenueScope} est déjà rattachée à ${clash.responsibleEntity} : arbitrage requis.`);
    const out = this.transition(m, 'ACTIF', user.id, input.note, {
      visas: [...m.visas, this.visa(user, 'ACTIVATION', input.note)],
      attachments: [...m.attachments, { entity: m.responsibleEntity, from: this.now(), actReference: input.actReference, validatedBy: user.id }],
    });
    this.log(this.actor(user), 'module.activated', 'module', id, { entity: m.responsibleEntity, actReference: input.actReference });
    const admins = this.ctx.users.all().filter((u) => u.entity === m.responsibleEntity && u.roles.includes('R08'));
    this.publishSafe('entity.module.attached', this.usersRecipients(admins), { reference: m.code }, m.responsibleEntity);
    return out;
  }

  changeModuleStatus(user: User, id: string, input: { to: 'SUSPENDU' | 'ACTIF' | 'RETIRE'; motif: string }) {
    const m = this.module(id);
    const allowed: Record<string, ModuleStatus[]> = { SUSPENDU: ['ACTIF'], ACTIF: ['SUSPENDU'], RETIRE: ['ACTIF', 'SUSPENDU', 'BROUILLON', 'BLOQUE_ARBITRAGE'] };
    if (!allowed[input.to]!.includes(m.status)) throw conflict('MODULE_BAD_STATE', `Passage de ${m.status} à ${input.to} impossible.`);
    this.requireMfa(user);
    const patch: Partial<ModuleConfig> = input.to === 'RETIRE'
      ? { attachments: m.attachments.map((a) => (a.to ? a : { ...a, to: this.now() })) }
      : {};
    const out = this.transition(m, input.to, user.id, input.motif, patch);
    this.log(this.actor(user), 'module.status_changed', 'module', id, { entity: m.responsibleEntity, from: m.status, to: input.to, motif: input.motif });
    return out;
  }

  proposeReattachment(user: User, id: string, input: { newEntity: string; beneficiaryAliases: string[]; actReference: string; motif: string }) {
    const m = this.module(id);
    if (m.status !== 'ACTIF') throw conflict('MODULE_BAD_STATE', 'Seul un module actif peut changer d’entité responsable.');
    if (m.pendingReattachment) throw conflict('REATTACHMENT_PENDING', 'Un changement de rattachement est déjà en attente.');
    const ent = this.entity(input.newEntity);
    if (ent.id === m.responsibleEntity) throw unprocessable('SAME_ENTITY', 'Le module est déjà rattaché à cette entité.');
    if (ent.status !== 'ACTIVE') throw unprocessable('ENTITY_SUSPENDED', 'Entité suspendue.');
    for (const a of input.beneficiaryAliases) {
      if (!this.ctx.vault.aliasExists(a)) throw unprocessable('BENEFICIARY_NOT_IN_VAULT', `Compte bénéficiaire ${a} absent du coffre.`);
    }
    const out = this.modules.update({ ...m, pendingReattachment: { ...input, proposedBy: user.id, at: this.now() } });
    this.log(this.actor(user), 'module.reattachment.proposed', 'module', id, { entity: m.responsibleEntity, newEntity: input.newEntity, actReference: input.actReference });
    return out;
  }

  decideReattachment(user: User, id: string, input: { approve: boolean; note?: string }) {
    const m = this.module(id);
    const p = m.pendingReattachment;
    if (!p) throw conflict('NO_PENDING_REATTACHMENT', 'Aucun changement de rattachement en attente.');
    assertDistinctPerson(user.id, [p.proposedBy], 'La seconde validation d’un rattachement est donnée par une personne distincte de l’auteur de la proposition.');
    this.requireMfa(user);
    const { pendingReattachment: _p, ...rest } = m;
    if (!input.approve) {
      const out = this.modules.update(rest);
      this.log(this.actor(user), 'module.reattachment.rejected', 'module', id, { entity: m.responsibleEntity, note: input.note });
      return out;
    }
    const at = this.now();
    const out = this.modules.update({
      ...rest,
      responsibleEntity: p.newEntity,
      beneficiaryAliases: p.beneficiaryAliases,
      attachments: [...m.attachments.map((a) => (a.to ? a : { ...a, to: at })), { entity: p.newEntity, from: at, actReference: p.actReference, validatedBy: user.id }],
      history: [...m.history, { at, from: m.status, to: m.status, by: user.id, note: `Rattachement transféré de ${m.responsibleEntity} à ${p.newEntity} (${p.actReference})` }],
    });
    this.log(this.actor(user), 'module.reattached', 'module', id, { entity: p.newEntity, previous: m.responsibleEntity, actReference: p.actReference });
    return out;
  }

  // ═════════════════════════════════ Revendications et arbitrages ═════════════════════════════════

  arbitration(id: string): ArbitrationCase {
    const a = this.arbitrations.get(id);
    if (!a) throw notFound('ARBITRATION_NOT_FOUND', `Dossier d’arbitrage inconnu : ${id}`);
    return a;
  }

  private openOrJoinArbitration(input: {
    kind: ArbitrationCase['kind']; subject: ArbitrationCase['subject'];
    holders: { entity: string; claimId?: string; moduleConfigId?: string }[];
    newcomer: { entity: string; claimId?: string; moduleConfigId?: string };
    openedBy: string; existingObligationIds: string[]; demo: boolean;
  }): ArbitrationCase {
    const same = (a: ArbitrationCase) => a.kind === input.kind && a.status !== 'DECIDE' && (input.kind === 'FAIT_GENERATEUR'
      ? a.subject.objectId === input.subject.objectId && a.subject.factCode === input.subject.factCode && a.subject.period === input.subject.period
      : a.subject.revenueScope === input.subject.revenueScope);
    const existing = this.arbitrations.findOne(same);
    if (existing) {
      const claimants = [...existing.claimants];
      for (const h of [...input.holders.map((h) => ({ ...h, holder: true })), { ...input.newcomer, holder: false }]) {
        if (!claimants.some((c) => c.entity === h.entity && c.claimId === h.claimId && c.moduleConfigId === h.moduleConfigId)) claimants.push(h);
      }
      return this.arbitrations.update({ ...existing, claimants, existingObligationIds: [...new Set([...existing.existingObligationIds, ...input.existingObligationIds])] });
    }
    const a = this.arbitrations.insert({
      id: this.ids.next('ARB', 5), kind: input.kind, subject: input.subject,
      claimants: [...input.holders.map((h) => ({ ...h, holder: true })), { ...input.newcomer, holder: false }],
      status: 'OUVERT', openedAt: this.now(), openedBy: input.openedBy, existingObligationIds: input.existingObligationIds,
      ...(input.demo ? { demo: true } : {}),
    });
    this.log({ kind: 'system', id: 'arbitrage' }, 'arbitration.opened', 'arbitration', a.id, {
      entity: input.newcomer.entity, kind: a.kind, subject: a.subject, claimants: a.claimants.map((c) => c.entity),
    });
    return a;
  }

  private obligationPeriod(createdAt: string): string {
    return createdAt.slice(0, 4);
  }

  /**
   * Revendication d'un fait générateur (objet × fait × période) par l'entité de l'agent.
   * Une seule revendication par fait générateur (§ 10A.3) : la seconde est bloquée et un dossier d'arbitrage s'ouvre.
   */
  claim(user: User, input: { objectId: string; factCode: TaxableFact; period: string; ruleCode?: string; basis: string }, opts: { demo?: boolean } = {}) {
    const entity = user.entity;
    this.ctx.objects.get(input.objectId);
    if (input.ruleCode) {
      const known = this.ruleFacts.get(input.ruleCode);
      if (known && known !== input.factCode) throw unprocessable('RULE_FACT_MISMATCH', `La règle ${input.ruleCode} porte sur le fait générateur ${known}.`);
      if (!known) this.ruleFacts.set(input.ruleCode, input.factCode);
    }
    const sameSubject = (c: Claim) => c.objectId === input.objectId && c.factCode === input.factCode && c.period === input.period;
    const decided = this.arbitrations.findOne((a) => a.kind === 'FAIT_GENERATEUR' && a.status === 'DECIDE' && a.subject.objectId === input.objectId
      && a.subject.factCode === input.factCode && a.subject.period === input.period);
    const mine = this.claims.findOne((c) => sameSubject(c) && c.entity === entity && c.status !== 'RETIREE');
    if (mine?.status === 'ACCEPTEE') return { claim: mine, blocked: false, existing: true };
    if (mine?.status === 'BLOQUEE') return { claim: mine, blocked: true, existing: true, arbitration: this.arbitration(mine.arbitrationId!) };
    if (mine?.status === 'REJETEE' || (decided && decided.decision?.winnerEntity !== entity)) {
      throw conflict('CLAIM_REJECTED_BY_ARBITRATION', `Ce fait générateur a été attribué par arbitrage à ${decided?.decision?.winnerEntity ?? 'une autre entité'} : aucune seconde obligation.`, { arbitrationId: decided?.id ?? mine?.arbitrationId });
    }
    const holders = this.claims.find((c) => sameSubject(c) && c.entity !== entity && c.status === 'ACCEPTEE');
    const obligations = this.ctx.assessment.obligations.find((o) => o.objectId === input.objectId && o.entity !== entity && o.status !== 'ANNULEE'
      && this.ruleFacts.get(o.ruleCode) === input.factCode && this.obligationPeriod(o.createdAt) === input.period.slice(0, 4));
    const id = this.ids.next('REV', 6);
    const base: Claim = {
      id, entity, objectId: input.objectId, factCode: input.factCode, period: input.period, basis: input.basis,
      status: 'ACCEPTEE', createdBy: user.id, createdAt: this.now(), ...(input.ruleCode ? { ruleCode: input.ruleCode } : {}), ...(opts.demo ? { demo: true } : {}),
    };
    if (holders.length === 0 && obligations.length === 0) {
      const claim = this.claims.insert(base);
      this.log(this.actor(user), 'claim.accepted', 'claim', id, { entity, objectId: input.objectId, factCode: input.factCode, period: input.period });
      return { claim, blocked: false, existing: false };
    }
    const holderEntities = new Map<string, { entity: string; claimId?: string }>();
    for (const h of holders) holderEntities.set(h.entity, { entity: h.entity, claimId: h.id });
    for (const o of obligations) if (!holderEntities.has(o.entity)) holderEntities.set(o.entity, { entity: o.entity });
    const arbitration = this.openOrJoinArbitration({
      kind: 'FAIT_GENERATEUR', subject: { objectId: input.objectId, factCode: input.factCode, period: input.period },
      holders: [...holderEntities.values()], newcomer: { entity, claimId: id }, openedBy: user.id,
      existingObligationIds: obligations.map((o) => o.id), demo: !!opts.demo,
    });
    const claim = this.claims.insert({ ...base, status: 'BLOQUEE', arbitrationId: arbitration.id });
    this.log(this.actor(user), 'claim.blocked', 'claim', id, {
      entity, objectId: input.objectId, factCode: input.factCode, period: input.period, arbitrationId: arbitration.id, holders: [...holderEntities.keys()],
    }, 'DENIED');
    return { claim, blocked: true, existing: false, arbitration };
  }

  /**
   * Liquidation sous garde de revendication : revendication acceptée ⇒ liquidation par le circuit commun
   * (règle ACTIVE obligatoire) ; revendication bloquée ⇒ aucune obligation, dossier d'arbitrage.
   */
  guardedLiquidation(user: User, input: { ruleId: string; objectId: string; factCode: TaxableFact; period: string; inputs: Record<string, string>; basis: string }) {
    const rule = this.ctx.rules.get(input.ruleId);
    if (rule.administeringEntity !== user.entity) {
      throw forbidden('OUT_OF_ENTITY', `La règle ${rule.code} est administrée par ${rule.administeringEntity} : une entité ne liquide que ses propres recettes.`);
    }
    const r = this.claim(user, { objectId: input.objectId, factCode: input.factCode, period: input.period, ruleCode: rule.code, basis: input.basis });
    if (r.blocked) {
      throw conflict('CLAIM_BLOCKED', 'Fait générateur déjà revendiqué par une autre entité : aucune obligation n’est créée, un dossier d’arbitrage est ouvert.', {
        claimId: r.claim.id, arbitrationId: r.claim.arbitrationId,
      });
    }
    const dup = this.ctx.assessment.obligations.findOne((o) => o.objectId === input.objectId && o.ruleCode === rule.code && o.status !== 'ANNULEE'
      && this.obligationPeriod(o.createdAt) === input.period.slice(0, 4));
    if (dup) throw conflict('DUPLICATE_OBLIGATION', `Une obligation existe déjà pour ce fait générateur et cette période (${dup.id}) : jamais de double perception.`, { obligationId: dup.id });
    const obj = this.ctx.objects.get(input.objectId);
    if (!obj.taxpayerId) throw unprocessable('OBJECT_WITHOUT_TAXPAYER', 'Objet sans redevable rattaché : aucune obligation possible.');
    const res = this.ctx.assessment.calculate(user, { ruleId: rule.id, taxpayerId: obj.taxpayerId, objectId: obj.id, inputs: input.inputs, simulate: false });
    return { claim: r.claim, obligation: res.obligation ? obligationSummary(res.obligation, 'full') : null };
  }

  visibleArbitrations(user: User): ArbitrationCase[] {
    return this.arbitrations.all().filter((a) => evaluate(user, 'acces:arbitration.read', { entities: a.claimants.map((c) => c.entity) }) !== false);
  }

  arbitrationOpinion(user: User, id: string, input: { text: string; recommendedEntity?: string }) {
    const a = this.arbitration(id);
    if (a.status === 'DECIDE') throw conflict('ARBITRATION_CLOSED', 'Dossier déjà décidé.');
    if (input.recommendedEntity && !a.claimants.some((c) => c.entity === input.recommendedEntity)) {
      throw unprocessable('NOT_A_CLAIMANT', 'L’entité recommandée doit être l’une des entités revendiquantes.');
    }
    const out = this.arbitrations.update({ ...a, status: 'INSTRUIT', opinion: { by: user.id, at: this.now(), text: input.text, ...(input.recommendedEntity ? { recommendedEntity: input.recommendedEntity } : {}) } });
    this.log(this.actor(user), 'arbitration.opinion', 'arbitration', id, { entity: a.claimants[0]?.entity, recommendedEntity: input.recommendedEntity });
    return out;
  }

  /** Décision humaine motivée : jamais automatique ; aucune obligation n'est annulée d'office (rectification par le circuit de réclamation). */
  decideArbitration(user: User, id: string, input: { winnerEntity: string; motif: string; actReference: string }) {
    const a = this.arbitration(id);
    if (a.status === 'DECIDE') throw conflict('ARBITRATION_CLOSED', 'Dossier déjà décidé.');
    if (!a.opinion) throw conflict('OPINION_REQUIRED', 'Avis juridique requis avant décision (comité juridique et tarifaire).');
    assertDistinctPerson(user.id, [a.opinion.by, a.openedBy], 'La décision est prise par une autorité distincte de l’auteur de l’avis et de la revendication.');
    if (a.claimants.some((c) => c.entity === user.entity)) throw forbidden('CONFLICT_OF_INTEREST', 'Une entité partie au litige ne peut pas le trancher.');
    if (!a.claimants.some((c) => c.entity === input.winnerEntity)) throw unprocessable('NOT_A_CLAIMANT', 'L’entité retenue doit être l’une des entités revendiquantes.');
    this.requireMfa(user);
    let rectificationRequired = false;
    if (a.kind === 'FAIT_GENERATEUR') {
      for (const c of a.claimants) {
        if (!c.claimId) continue;
        const claim = this.claims.get(c.claimId);
        if (claim) this.claims.update({ ...claim, status: c.entity === input.winnerEntity ? 'ACCEPTEE' : 'REJETEE', arbitrationId: a.id });
      }
      rectificationRequired = a.existingObligationIds.some((oid) => this.ctx.assessment.obligations.get(oid)?.entity !== input.winnerEntity);
    } else {
      for (const c of a.claimants) {
        if (!c.moduleConfigId) continue;
        const m = this.modules.get(c.moduleConfigId);
        if (!m) continue;
        if (c.entity === input.winnerEntity && m.status === 'BLOQUE_ARBITRAGE') this.transition(m, 'BROUILLON', user.id, `Arbitrage ${a.id} : compétence reconnue`);
        else if (c.entity !== input.winnerEntity && m.status === 'BLOQUE_ARBITRAGE') this.transition(m, 'RETIRE', user.id, `Arbitrage ${a.id} : compétence attribuée à ${input.winnerEntity}`);
        else if (c.entity !== input.winnerEntity && ['ACTIF', 'SUSPENDU'].includes(m.status)) rectificationRequired = true;
      }
    }
    const out = this.arbitrations.update({
      ...a, status: 'DECIDE',
      decision: { by: user.id, at: this.now(), winnerEntity: input.winnerEntity, motif: input.motif, actReference: input.actReference, rectificationRequired },
    });
    this.log(this.actor(user), 'arbitration.decided', 'arbitration', id, { entity: input.winnerEntity, winnerEntity: input.winnerEntity, actReference: input.actReference, rectificationRequired });
    return out;
  }

  // ═════════════════════════════════ Comptes de travail, droits, invitations ═════════════════════════════════

  /** Niveau d'accès porté par un utilisateur (le plus élevé de ses rôles). */
  userLevel(user: Pick<User, 'roles'>): AccessLevel | null {
    let best: AccessLevel | null = null;
    for (const r of user.roles) {
      const l = ROLE_LEVEL[r];
      if (!l) continue;
      if (!best || LEVEL_RANK[l] > LEVEL_RANK[best]) best = l;
    }
    return best;
  }

  hasInviteRight(user: User): boolean {
    if (this.isPlatformAdmin(user)) return true;
    const acc = this.accounts.get(user.id);
    if (acc && acc.status !== 'ACTIF') return false;
    return !!this.grants.findOne((g) => g.userId === user.id && g.kind === 'DROIT_INVITER' && g.status === 'ACTIF');
  }

  isAccessOperator(user: User): boolean {
    return !!this.grants.findOne((g) => g.userId === user.id && g.kind === 'OPERATEUR_ACCES' && g.status === 'ACTIF');
  }

  /** Compte de travail d'un utilisateur (créé à la volée pour les comptes amorcés de démonstration). */
  ensureAccount(userId: string): WorkAccount | undefined {
    const existing = this.accounts.get(userId);
    if (existing) return existing;
    const u = this.ctx.users.get(userId);
    if (!u || u.roles.length === 0 || u.roles.every((r) => PUBLIC_ROLES.includes(r))) return undefined;
    return this.accounts.insert({
      id: u.id, fullName: u.name, entity: u.entity, accessLevel: this.userLevel(u) ?? 'CONSULTATION', roles: [...u.roles],
      scope: { ...(u.territory ? { territory: u.territory } : {}), ...(this.managedModules(u.id).length ? { modules: this.managedModules(u.id) } : {}) },
      canInvite: false, status: 'ACTIF', origin: 'AMORCAGE_DEMO', secretsPending: false, linkedTaxpayerIds: [], createdAt: this.now(),
      // Comptes amorcés : pièce FICTIVE distincte par compte de démonstration (une personne par compte).
      personId: u.personId ?? this.personIdFor(`DEMO-PIECE-${u.id}`),
    });
  }

  private allAccounts(): WorkAccount[] {
    for (const u of this.ctx.users.all()) this.ensureAccount(u.id);
    return this.accounts.all();
  }

  private managedModules(userId: string): string[] {
    return this.modules.find((m) => m.moduleManagerId === userId && m.status !== 'RETIRE').map((m) => m.id);
  }

  private setDirectoryRoles(userId: string, roles: RoleCode[]): void {
    const u = this.ctx.users.get(userId);
    if (!u) return;
    const clash = hasIncompatibility(roles);
    if (clash) throw forbidden('ROLE_INCOMPATIBILITY', `Cumul interdit des rôles ${clash[0]} et ${clash[1]} (§ 12.5).`);
    this.ctx.users.setRoles(userId, roles);
  }

  accountView(a: WorkAccount) {
    const { phone, personId: _p, birthDate: _b, ...rest } = a;
    return {
      ...rest, ...(phone ? { phoneMasked: maskPhone(phone) } : {}),
      accessLevelLabel: LEVEL_INFO[a.accessLevel].label, roleLabels: a.roles.map((r) => ROLES[r]),
      inviteRight: !!this.grants.findOne((g) => g.userId === a.id && g.kind === 'DROIT_INVITER' && g.status === 'ACTIF') || a.roles.includes('R26'),
      accessOperator: !!this.grants.findOne((g) => g.userId === a.id && g.kind === 'OPERATEUR_ACCES' && g.status === 'ACTIF'),
    };
  }

  listAccounts(user: User, entity?: string) {
    const scope = this.visibleEntities(user);
    return this.allAccounts()
      .filter((a) => (!scope || scope.has(a.entity)) && (!entity || a.entity === entity))
      .map((a) => this.accountView(a));
  }

  me(user: User) {
    const acc = this.ensureAccount(user.id);
    return {
      user: { id: user.id, name: user.name, roles: user.roles, entity: user.entity, ...(user.territory ? { territory: user.territory } : {}) },
      account: acc ? this.accountView(acc) : null,
      level: this.userLevel(user),
      sensitive: this.isSensitive(user),
      inviteRight: this.hasInviteRight(user),
      accessOperator: this.isAccessOperator(user),
      mfa: { required: this.isSensitive(user), activeUntil: this.mfaActiveUntil(user) },
      sandbox: this.sandbox,
    };
  }

  invitationView(i: Invitation) {
    const { tokenHash: _t, codeHash: _c, personId: _p, phone, ...rest } = i;
    return { ...rest, phoneMasked: maskPhone(phone), accessLevelLabel: LEVEL_INFO[i.accessLevel].label, roleLabels: i.roles.map((r) => ROLES[r]) };
  }

  listInvitations(user: User) {
    this.sweep();
    const scope = this.visibleEntities(user);
    return this.invitations.all().filter((i) => !scope || scope.has(i.entity)).reverse().map((i) => this.invitationView(i));
  }

  /** Invitation en cascade : pas d'élévation, pas de sortie de périmètre, droit d'inviter explicite (§ 12A.2). */
  createInvitation(user: User, input: {
    fullName: string; phone: string; email?: string; entity: string; accessLevel: AccessLevel; roles: RoleCode[];
    scope?: InvitationScope; canInvite?: boolean; motif: string;
  }) {
    this.sweep();
    const deny = (code: string, detail: string, ext?: Record<string, unknown>) => {
      this.log(this.actor(user), 'invitation.refused', 'invitation', '—', { entity: input.entity, code, accessLevel: input.accessLevel, roles: input.roles }, 'DENIED');
      return forbidden(code, detail, ext);
    };
    if (!this.hasInviteRight(user)) throw deny('NO_INVITE_RIGHT', 'Le droit d’inviter est une permission explicite, que vous ne détenez pas (§ 12A.2).');
    const admin = this.isPlatformAdmin(user);
    const ent = this.entity(input.entity);
    if (ent.status !== 'ACTIVE') throw unprocessable('ENTITY_SUSPENDED', 'Entité suspendue : aucune invitation possible.');
    if (!admin && !this.subtree(user.entity).has(input.entity)) {
      throw deny('OUT_OF_PERIMETER', 'Pas de sortie de périmètre : une entité n’invite que dans son propre espace (§ 12A.2).');
    }
    const roles = [...new Set(input.roles)];
    if (roles.some((r) => PUBLIC_ROLES.includes(r))) {
      throw unprocessable('PUBLIC_ROLE_NOT_INVITABLE', 'Contribuable et mandataire sont des comptes publics : inscription publique uniquement, jamais par invitation.');
    }
    const clash = hasIncompatibility(roles);
    if (clash) throw deny('ROLE_INCOMPATIBILITY', `Rôles incompatibles (§ 12.5) : ${clash[0]} (${ROLES[clash[0]]}) et ${clash[1]} (${ROLES[clash[1]]}).`, { roles: clash });
    const lvl = input.accessLevel;
    for (const r of roles) {
      const rl = ROLE_LEVEL[r]!;
      const ok = SPECIAL_LEVELS.includes(rl) || SPECIAL_LEVELS.includes(lvl) ? rl === lvl : LEVEL_RANK[rl] <= LEVEL_RANK[lvl];
      if (!ok) throw unprocessable('ROLE_LEVEL_MISMATCH', `Le rôle ${r} (${ROLES[r]}) ne relève pas du niveau ${LEVEL_INFO[lvl].label}.`);
    }
    const scope: InvitationScope = { ...(input.scope ?? {}) };
    if (!admin) {
      const mine = this.userLevel(user);
      if (!mine || SPECIAL_LEVELS.includes(lvl) || LEVEL_RANK[lvl] > LEVEL_RANK[mine] || SPECIAL_LEVELS.includes(mine)) {
        throw deny('NO_ELEVATION', `Pas d’élévation : vous ne pouvez accorder qu’un niveau inférieur ou égal au vôtre (${mine ? LEVEL_INFO[mine].label : 'aucun'}).`);
      }
      if (roles.some((r) => LEVEL_RANK[ROLE_LEVEL[r]!] > LEVEL_RANK[mine])) throw deny('NO_ELEVATION', 'Pas d’élévation : un rôle demandé dépasse votre propre niveau.');
      if (lvl === 'OPERATEUR_ACCES' && !user.roles.includes('R08')) throw deny('NO_ELEVATION', 'L’opérateur d’accès est désigné par l’administrateur d’entité (§ 12A.7).');
      if (mine === 'SUPERVISEUR' && lvl !== 'AGENT_TERRAIN') throw deny('NO_ELEVATION', 'Un superviseur (sur délégation) n’invite que des agents de son équipe (§ 12A.2, niveau 3).');
      if (mine === 'RESPONSABLE_MODULE') {
        if (!['SUPERVISEUR', 'AGENT_TERRAIN', 'OPERATEUR', 'CONSULTATION'].includes(lvl)) throw deny('NO_ELEVATION', 'Un responsable de module invite des superviseurs et des agents dans son module.');
        const managed = new Set([...this.managedModules(user.id), ...(this.ensureAccount(user.id)?.scope.modules ?? [])]);
        const asked = scope.modules ?? [];
        if (managed.size === 0 || asked.length === 0 || asked.some((m) => !managed.has(m))) {
          throw deny('OUT_OF_PERIMETER', 'Un responsable de module n’invite que dans son module : périmètre de module requis et limité aux modules confiés.');
        }
      }
      const inviterAcc = this.ensureAccount(user.id);
      if (user.territory) {
        if (!scope.territory || scope.territory.length === 0) scope.territory = [...user.territory];
        if (scope.territory.some((c) => !user.territory!.includes(c))) throw deny('OUT_OF_PERIMETER', 'Territoire accordé hors de votre propre territoire.');
      }
      if (inviterAcc?.scope.modules?.length && scope.modules?.some((m) => !inviterAcc.scope.modules!.includes(m))) {
        throw deny('OUT_OF_PERIMETER', 'Module accordé hors de vos propres modules.');
      }
      if (inviterAcc?.scope.validUntil && (!scope.validUntil || scope.validUntil > inviterAcc.scope.validUntil)) {
        scope.validUntil = scope.validUntil && scope.validUntil < inviterAcc.scope.validUntil ? scope.validUntil : inviterAcc.scope.validUntil;
      }
    }
    for (const m of scope.modules ?? []) {
      const mod = this.module(m);
      if (!this.subtree(mod.responsibleEntity).has(input.entity) && mod.responsibleEntity !== input.entity) {
        throw unprocessable('MODULE_OUT_OF_ENTITY', `Le module ${mod.code} n’est pas rattaché à l’entité ${input.entity}.`);
      }
    }
    if (input.canInvite && (SPECIAL_LEVELS.includes(lvl) ? lvl !== 'ADMIN_TECHNIQUE' : LEVEL_RANK[lvl] < LEVEL_RANK.SUPERVISEUR)) {
      throw unprocessable('INVITE_RIGHT_NOT_ALLOWED', 'Le droit d’inviter ne peut être accordé qu’à partir du niveau superviseur.');
    }
    const phone = normalizePhone(input.phone);
    const own = this.accounts.get(user.id);
    if ((user.phone && normalizePhone(user.phone) === phone) || (own?.phone && own.phone === phone)) {
      throw deny('SELF_INVITATION', 'Personne ne peut s’inviter ni s’attribuer un rôle lui-même (§ 12A.6).');
    }
    if (this.invitations.findOne((i) => i.phone === phone && i.status === 'ENVOYEE')) {
      throw conflict('INVITATION_PENDING', 'Une invitation est déjà en cours pour ce numéro.');
    }
    if (this.accounts.findOne((a) => a.phone === phone && ['ACTIF', 'ATTENTE_VALIDATION', 'ATTENTE_SECRETS'].includes(a.status))) {
      throw conflict('ACCOUNT_EXISTS', 'Un compte de travail nominatif existe déjà pour ce numéro : changement de rôle par nouvelle validation.');
    }
    const id = this.ids.next('INV', 6);
    const token = randomSecret(24);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const inv = this.invitations.insert({
      id, inviterId: user.id, inviterEntity: user.entity, fullName: input.fullName.trim(), phone, ...(input.email ? { email: input.email } : {}),
      entity: input.entity, accessLevel: lvl, roles, scope, canInvite: !!input.canInvite, motif: input.motif,
      tokenHash: sha256Hex(token), codeHash: sha256Hex(`${id}:${code}`),
      expiresAt: new Date(this.ctx.clock.now().getTime() + INVITATION_TTL_MS).toISOString(), createdAt: this.now(),
      status: 'ENVOYEE', failedAttempts: 0,
    });
    this.sandboxSend(phone, 'Invitation MOSOLO (lien)', `Invitation nominative KINSHASA MOSOLO — ${ent.shortName}. Lien personnel : /invitation?jeton=${token} (valable 72 h, usage unique, lié à ce numéro).`);
    this.sandboxSend(phone, 'Invitation MOSOLO (code)', `Code d’invitation MOSOLO : ${code}. Ne le communiquez à personne, pas même à un agent.`);
    this.ctx.comms.publish('invitation.sent', [{ id: `invite:${id}`, kind: 'user', name: inv.fullName, lang: 'fr', prefs: {} }], { reference: id }, { entity: input.entity });
    this.log(this.actor(user), 'invitation.sent', 'invitation', id, {
      entity: input.entity, accessLevel: lvl, roles, canInvite: inv.canInvite, scope, inviteeMasked: maskPhone(phone), motif: input.motif,
    });
    return { invitation: this.invitationView(inv), sandbox: this.sandbox };
  }

  private invitationByToken(token: string): Invitation {
    this.sweep();
    const inv = this.invitations.findOne((i) => i.tokenHash === sha256Hex(token));
    if (!inv) throw notFound('INVITATION_UNKNOWN', 'Lien d’invitation inconnu.');
    return inv;
  }

  lookupInvitation(token: string) {
    const i = this.invitationByToken(token);
    const ent = this.entity(i.entity);
    return {
      id: i.id, entity: { id: ent.id, name: ent.name }, accessLevel: i.accessLevel, accessLevelLabel: LEVEL_INFO[i.accessLevel].label,
      roleLabels: i.roles.map((r) => ROLES[r]), phoneMasked: maskPhone(i.phone), expiresAt: i.expiresAt, status: i.status,
      sensitive: this.invitationRequirement(i) !== null, requirement: this.invitationRequirement(i),
      passkeyRequired: i.canInvite || i.roles.some((r) => SENSITIVE_ROLES.includes(r)),
      deviceRequired: i.roles.some((r) => FIELD_ROLES.includes(r)),
    };
  }

  private assertOpen(i: Invitation): void {
    if (i.status === 'FINALISEE') throw conflict('INVITATION_ALREADY_USED', 'Lien déjà utilisé : une invitation ne sert qu’une fois.');
    if (i.status === 'EXPIREE' || i.expiresAt < this.now()) {
      if (i.status === 'ENVOYEE') this.invitations.update({ ...i, status: 'EXPIREE' });
      throw conflict('INVITATION_EXPIRED', 'Invitation expirée : demandez une nouvelle invitation à votre administrateur.');
    }
    if (i.status !== 'ENVOYEE') throw conflict('INVITATION_CLOSED', 'Invitation révoquée ou refusée.');
  }

  private failAttempt(i: Invitation, code: string, detail: string, status: 403 | 422): never {
    const failedAttempts = i.failedAttempts + 1;
    this.invitations.update({ ...i, failedAttempts, ...(failedAttempts >= OTP_MAX_ATTEMPTS ? { status: 'REFUSEE' as const } : {}) });
    this.log({ kind: 'public', id: 'invitation' }, 'invitation.attempt_refused', 'invitation', i.id, { entity: i.entity, code, failedAttempts }, 'DENIED');
    throw new ApiError(status, code, detail);
  }

  private invitationRequirement(i: Pick<Invitation, 'roles' | 'canInvite' | 'accessLevel'>): ValidatorRequirement | null {
    if (i.roles.includes('R01')) return 'HORS_BANDE_CABINET';
    if (i.accessLevel === 'AUDIT') return 'AUTORITE_AUDIT';
    if (i.canInvite || i.roles.some((r) => SENSITIVE_ROLES.includes(r)) || i.accessLevel === 'OPERATEUR_ACCES') return 'SECURITE';
    if (i.roles.some((r) => SECOND_VALIDATION_ROLES.includes(r))) return 'SECURITE';
    if (i.roles.some((r) => FIELD_ROLES.includes(r))) return 'HABILITATION_REGIE';
    return null;
  }

  /** Finalisation depuis le lien : usage unique, lié au numéro, code, pièce, photo, MFA (§ 12A.5). */
  acceptInvitation(input: {
    token: string; phone: string; code: string; identityDocument: IdentityDocumentInput; photoTaken: true;
    mfaMethod: 'PASSKEY' | 'TOTP' | 'SMS'; deviceId?: string;
  }) {
    const i = this.invitationByToken(input.token);
    this.assertOpen(i);
    if (normalizePhone(input.phone) !== i.phone) this.failAttempt(i, 'INVITATION_PHONE_MISMATCH', 'Ce lien ne fonctionne qu’avec le numéro invité.', 403);
    if (sha256Hex(`${i.id}:${input.code}`) !== i.codeHash) this.failAttempt(i, 'INVITATION_CODE_INVALID', 'Code d’invitation incorrect.', 422);
    const needsPasskey = i.canInvite || i.roles.some((r) => SENSITIVE_ROLES.includes(r));
    if (needsPasskey && input.mfaMethod !== 'PASSKEY') {
      throw unprocessable('PHISHING_RESISTANT_MFA_REQUIRED', 'Rôle sensible : une clé d’accès résistante à l’hameçonnage (passkey) est obligatoire.');
    }
    if (i.roles.some((r) => FIELD_ROLES.includes(r)) && !input.deviceId) {
      throw unprocessable('DEVICE_REQUIRED', 'Agent de terrain : liaison à un terminal enregistré obligatoire.');
    }
    return this.finalize(i, { via: 'LIEN', actor: { kind: 'public', id: `invite:${i.id}` }, mfaMethod: input.mfaMethod, idDocument: input.identityDocument, ...(input.deviceId ? { deviceId: input.deviceId } : {}) });
  }

  /** Inscription assistée par l'opérateur d'accès désigné, en présence de la personne (§ 12A.7). */
  assistedFinalize(user: User, invitationId: string, input: {
    identityDocument: IdentityDocumentInput; photoTaken: true; otpCode?: string; witness?: { fullName: string; idNumber?: string };
    gps: { lat: number; lon: number }; operatorDeviceId: string; personDeviceId?: string;
  }) {
    this.sweep();
    if (!this.isAccessOperator(user)) throw forbidden('NOT_ACCESS_OPERATOR', 'Permission expresse « inscription assistée des intervenants » requise.');
    const i = this.invitations.get(invitationId);
    if (!i) throw notFound('INVITATION_UNKNOWN', 'Aucune invitation préalable : l’opérateur ne crée aucun compte sans invitation.');
    if (!this.subtree(user.entity).has(i.entity)) {
      this.log(this.actor(user), 'invitation.assisted_refused', 'invitation', i.id, { entity: i.entity, reason: 'AUTRE_ENTITE' }, 'DENIED');
      throw forbidden('OUT_OF_PERIMETER', 'L’opérateur d’accès n’agit que pour les invités de son entité.');
    }
    this.assertOpen(i);
    if (input.otpCode) {
      if (sha256Hex(`${i.id}:${input.otpCode}`) !== i.codeHash) this.failAttempt(i, 'INVITATION_CODE_INVALID', 'Code reçu par la personne incorrect.', 422);
    } else if (!input.witness) {
      throw unprocessable('PRESENCE_PROOF_REQUIRED', 'Code reçu sur le téléphone de la personne ou témoin identifié requis (empreinte désactivée tant que J18 n’est pas certifié).');
    }
    if (i.roles.some((r) => FIELD_ROLES.includes(r)) && !input.personDeviceId) {
      throw unprocessable('DEVICE_REQUIRED', 'Agent de terrain : liaison au terminal de terrain qui lui est attribué obligatoire.');
    }
    return this.finalize(i, {
      via: 'OPERATEUR_ACCES', actor: this.actor(user), idDocument: input.identityDocument, ...(input.personDeviceId ? { deviceId: input.personDeviceId } : {}),
      assisted: { operatorId: user.id, gps: input.gps, operatorDeviceId: input.operatorDeviceId, witness: !!input.witness },
    });
  }

  private finalize(i: Invitation, opts: {
    via: 'LIEN' | 'OPERATEUR_ACCES'; actor: AuditActor; mfaMethod?: 'PASSKEY' | 'TOTP' | 'SMS'; idDocument: IdentityDocumentInput; deviceId?: string;
    assisted?: { operatorId: string; gps: { lat: number; lon: number }; operatorDeviceId: string; witness: boolean };
  }) {
    // Une personne physique = un seul compte de travail non clos, quel que soit le téléphone (séparation des tâches).
    const personId = this.personIdFor(opts.idDocument.number);
    const existing = this.accounts.findOne((a) => a.personId === personId && !CLOSED_ACCOUNT.includes(a.status));
    if (existing) {
      this.log(opts.actor, 'invitation.duplicate_person', 'invitation', i.id, { entity: i.entity, existingAccountId: existing.id, existingEntity: existing.entity }, 'DENIED');
      this.ctx.alerts.raise({
        type: 'DUPLICATE_PERSON_ATTEMPT', severity: 'HIGH', source: 'acces',
        detail: `Tentative d’ouvrir un second compte de travail pour une personne déjà titulaire du compte ${existing.id} (invitation ${i.id}).`,
        context: { invitationId: i.id, existingAccountId: existing.id, inviterId: i.inviterId, entity: i.entity },
      });
      throw conflict('DUPLICATE_PERSON', 'Cette personne détient déjà un compte de travail non clos : un seul compte par personne ; changement de rôle par nouvelle validation, ou clôture préalable du compte existant.', { existingAccountId: existing.id });
    }
    const id = this.ids.next('acc-u', 5);
    this.ctx.users.add({ id, name: `${i.fullName} (invité)`, roles: [], entity: i.entity, ...(i.scope.territory?.length ? { territory: i.scope.territory } : {}), phone: i.phone, personId });
    const requirement = this.invitationRequirement(i);
    const linked = this.ctx.taxpayers.taxpayers.find((t) => t.phone === i.phone).map((t) => t.id);
    let acc = this.accounts.insert({
      id, fullName: i.fullName, phone: i.phone, entity: i.entity, accessLevel: i.accessLevel, roles: i.roles, scope: i.scope,
      canInvite: i.canInvite, status: requirement ? 'ATTENTE_VALIDATION' : 'ATTENTE_SECRETS', origin: 'INVITATION', invitationId: i.id,
      sponsorId: i.inviterId, ...(opts.mfaMethod ? { mfaMethod: opts.mfaMethod } : {}), secretsPending: opts.via === 'OPERATEUR_ACCES',
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}), personId, ...(opts.idDocument.birthDate ? { birthDate: opts.idDocument.birthDate } : {}),
      linkedTaxpayerIds: linked, createdAt: this.now(),
    });
    this.invitations.update({ ...i, status: 'FINALISEE', finalizedAt: this.now(), finalizedVia: opts.via, accountId: id, personId });
    this.detectPossibleDuplicates(acc);
    let validationId: string | undefined;
    if (requirement) {
      validationId = this.validations.insert({
        id: this.ids.next('VAL', 5), kind: 'ACTIVATION_COMPTE', subjectUserId: id, entity: i.entity, requestedBy: i.inviterId,
        requirement, motif: i.motif, status: 'EN_ATTENTE', createdAt: this.now(),
      }).id;
    } else {
      acc = this.activate(acc);
    }
    this.log(opts.actor, opts.via === 'LIEN' ? 'invitation.finalized' : 'invitation.assisted_registration', 'invitation', i.id, {
      entity: i.entity, accountId: id, status: acc.status, requirement, idDocumentType: opts.idDocument.type, ...(opts.assisted ? { assisted: opts.assisted } : {}),
    });
    const inviter = this.ctx.users.get(i.inviterId);
    const admins = this.ctx.users.all().filter((u) => u.entity === i.entity && u.roles.includes('R08'));
    this.publishSafe('invitation.accepted', this.usersRecipients([...(inviter ? [inviter] : []), ...admins.filter((a) => a.id !== inviter?.id)]), { reference: i.id }, i.entity);
    return {
      accountId: id, status: acc.status, requirement, validationId, secretsPending: acc.secretsPending,
      message: requirement
        ? 'Identité vérifiée. Le compte reste inactif jusqu’à la seconde validation par une personne distincte de l’invitant.'
        : acc.status === 'ACTIF' ? 'Compte de travail actif.' : 'Compte créé : la personne doit définir elle-même ses secrets sur son terminal.',
    };
  }

  /**
   * Détection (sans blocage : homonymes et terminaux partagés existent) : même nom et même date de naissance, ou même
   * terminal, sur un autre compte non clos ⇒ alerte de sécurité à instruire (pièce d'identité différente déclarée).
   */
  private detectPossibleDuplicates(acc: WorkAccount): void {
    const key = (n: string) => normName(n).sort().join(' ');
    const name = key(acc.fullName);
    const reasons = new Map<string, Set<string>>();
    const flag = (other: string, reason: string) => {
      const set = reasons.get(other) ?? new Set<string>();
      set.add(reason);
      reasons.set(other, set);
    };
    for (const a of this.accounts.all()) {
      if (a.id === acc.id || CLOSED_ACCOUNT.includes(a.status)) continue;
      if (acc.birthDate && a.birthDate === acc.birthDate && key(a.fullName) === name) flag(a.id, 'NOM_ET_DATE_DE_NAISSANCE');
      if (acc.deviceId && a.deviceId === acc.deviceId) flag(a.id, 'MEME_TERMINAL');
    }
    if (acc.deviceId) {
      for (const d of this.ctx.field.devices.find((x) => x.id === acc.deviceId && x.agentUserId !== acc.id && x.status === 'ACTIF')) flag(d.agentUserId, 'MEME_TERMINAL');
    }
    if (reasons.size === 0) return;
    const matches = [...reasons].map(([accountId, r]) => ({ accountId, reasons: [...r] }));
    this.ctx.alerts.raise({
      type: 'POSSIBLE_DUPLICATE_PERSON', severity: 'HIGH', source: 'acces',
      detail: `Compte ${acc.id} : indices d’une même personne derrière plusieurs comptes de travail (${matches.map((m) => `${m.accountId} — ${m.reasons.join(', ')}`).join(' ; ')}).`,
      context: { accountId: acc.id, matches },
    });
    this.log({ kind: 'system', id: 'acces' }, 'account.possible_duplicate', 'account', acc.id, { entity: acc.entity, matches });
  }

  private activate(acc: WorkAccount): WorkAccount {
    if (acc.secretsPending) return this.accounts.update({ ...acc, status: 'ATTENTE_SECRETS' });
    this.setDirectoryRoles(acc.id, acc.roles);
    const out = this.accounts.update({ ...acc, status: 'ACTIF', activatedAt: this.now() });
    if (acc.canInvite && !this.grants.findOne((g) => g.userId === acc.id && g.kind === 'DROIT_INVITER' && g.status === 'ACTIF')) {
      this.grants.insert({ id: this.ids.next('GRT', 5), userId: acc.id, kind: 'DROIT_INVITER', entity: acc.entity, grantedBy: acc.sponsorId ?? 'invitation', status: 'ACTIF', createdAt: this.now() });
    }
    const u = this.ctx.users.get(acc.id);
    if (u) this.publishSafe('role.assigned', this.usersRecipients([u]), {}, acc.entity);
    this.log({ kind: 'system', id: 'acces' }, 'account.activated', 'account', acc.id, { entity: acc.entity, roles: acc.roles, accessLevel: acc.accessLevel });
    return out;
  }

  /** La personne définit elle-même ses secrets (jamais l'opérateur d'accès). */
  setOwnSecrets(user: User, input: { mfaMethod: 'PASSKEY' | 'TOTP' | 'SMS' }) {
    const acc = this.accounts.get(user.id);
    if (!acc || !acc.secretsPending) throw conflict('NO_SECRETS_PENDING', 'Aucun secret en attente pour ce compte.');
    if ((acc.canInvite || acc.roles.some((r) => SENSITIVE_ROLES.includes(r))) && input.mfaMethod !== 'PASSKEY') {
      throw unprocessable('PHISHING_RESISTANT_MFA_REQUIRED', 'Rôle sensible : clé d’accès (passkey) obligatoire.');
    }
    let out = this.accounts.update({ ...acc, secretsPending: false, mfaMethod: input.mfaMethod });
    this.log(this.actor(user), 'account.secrets_set', 'account', acc.id, { entity: acc.entity, mfaMethod: input.mfaMethod });
    if (out.status === 'ATTENTE_SECRETS') out = this.activate(out);
    return this.accountView(out);
  }

  listValidations(user: User) {
    const scope = this.visibleEntities(user);
    return this.validations.all().filter((v) => !scope || scope.has(v.entity) || this.qualifiedFor(user, v)).reverse().map((v) => {
      const acc = this.accounts.get(v.subjectUserId);
      return {
        ...v, qualified: v.status === 'EN_ATTENTE' && this.qualifiedFor(user, v) && ![v.requestedBy, v.subjectUserId].includes(user.id),
        subject: acc ? { id: acc.id, fullName: acc.fullName, entity: acc.entity, accessLevelLabel: LEVEL_INFO[acc.accessLevel].label, roleLabels: acc.roles.map((r) => ROLES[r]) } : { id: v.subjectUserId },
      };
    });
  }

  private qualifiedFor(user: User, v: ValidationRequest): boolean {
    const inEntity = this.subtree(user.entity).has(v.entity);
    switch (v.requirement) {
      case 'HORS_BANDE_CABINET': return user.roles.includes('R02') || user.roles.includes('R03');
      case 'AUTORITE_AUDIT': return user.roles.includes('R22');
      case 'HABILITATION_REGIE': return (user.roles.includes('R06') || user.roles.includes('R07')) && inEntity;
      case 'SECURITE': return user.roles.includes('R28') || (user.roles.includes('R06') && inEntity);
    }
  }

  /** Seconde validation par une personne distincte de l'invitant (§ 12A.5, § 12A.6). */
  decideValidation(user: User, id: string, input: { decision: 'APPROUVEE' | 'REJETEE'; note?: string; outOfBandConfirmed?: boolean; certificationRef?: string }) {
    const v = this.validations.get(id);
    if (!v) throw notFound('VALIDATION_NOT_FOUND', `Demande de validation inconnue : ${id}`);
    if (v.status !== 'EN_ATTENTE') throw conflict('VALIDATION_CLOSED', 'Demande déjà traitée.');
    assertDistinctPerson(user.id, [v.requestedBy, v.subjectUserId], 'La seconde validation est donnée par une personne distincte de l’invitant et de l’intéressé.');
    if (!this.qualifiedFor(user, v)) {
      throw forbidden('VALIDATOR_NOT_QUALIFIED', {
        SECURITE: 'Seconde validation réservée au responsable sécurité ou à la direction de l’entité.',
        HORS_BANDE_CABINET: 'Le compte du Gouverneur est confirmé hors bande par le Cabinet ou le Secrétariat général.',
        AUTORITE_AUDIT: 'Les comptes d’audit sont validés par l’autorité d’audit.',
        HABILITATION_REGIE: 'Les agents de terrain sont habilités par la régie de l’entité.',
      }[v.requirement]);
    }
    if (input.decision === 'APPROUVEE') {
      if (v.requirement === 'HORS_BANDE_CABINET' && input.outOfBandConfirmed !== true) throw unprocessable('OUT_OF_BAND_REQUIRED', 'Confirmation hors bande requise.');
      if (v.requirement === 'HABILITATION_REGIE' && !input.certificationRef) throw unprocessable('CERTIFICATION_REQUIRED', 'Référence de la formation certifiée requise pour habiliter un agent de terrain.');
    }
    this.requireMfa(user);
    const out = this.validations.update({ ...v, status: input.decision, decidedBy: user.id, decidedAt: this.now(), ...(input.note ? { decisionNote: input.note } : {}) });
    if (v.kind === 'ACTIVATION_COMPTE') {
      const acc = this.accounts.get(v.subjectUserId)!;
      if (input.decision === 'APPROUVEE') this.activate(acc);
      else this.doRevokeAccount(user, acc, `Seconde validation refusée : ${input.note ?? 'sans motif'}`, undefined);
    } else {
      const g = this.grants.findOne((x) => x.validationId === v.id);
      if (g) this.grants.update({ ...g, status: input.decision === 'APPROUVEE' ? 'ACTIF' : 'REVOQUE' });
    }
    this.log(this.actor(user), 'validation.decided', 'validation', id, { entity: v.entity, kind: v.kind, decision: input.decision, subject: v.subjectUserId, certificationRef: input.certificationRef });
    return out;
  }

  /** Délégation du droit d'inviter ou désignation d'un opérateur d'accès : effet après seconde validation. */
  requestGrant(user: User, input: { userId: string; kind: 'DROIT_INVITER' | 'OPERATEUR_ACCES'; motif: string }) {
    this.requireMfa(user);
    const target = this.ctx.users.get(input.userId);
    if (!target) throw notFound('USER_NOT_FOUND', `Utilisateur inconnu : ${input.userId}`);
    const admin = this.isPlatformAdmin(user);
    if (target.id === user.id) throw forbidden('SELF_GRANT', 'Personne ne s’attribue une permission à soi-même.');
    if (!admin && !this.subtree(user.entity).has(target.entity)) throw forbidden('OUT_OF_PERIMETER', 'Délégation limitée à votre entité.');
    const tl = this.userLevel(target);
    if (!tl) throw unprocessable('PUBLIC_ACCOUNT', 'Un compte public ne reçoit aucune permission de travail.');
    if (input.kind === 'DROIT_INVITER') {
      if (!this.hasInviteRight(user)) throw forbidden('NO_INVITE_RIGHT', 'Seul un détenteur du droit d’inviter peut le déléguer.');
      if (!SPECIAL_LEVELS.includes(tl) && LEVEL_RANK[tl] < LEVEL_RANK.SUPERVISEUR) throw unprocessable('INVITE_RIGHT_NOT_ALLOWED', 'Droit d’inviter délégable à partir du niveau superviseur.');
      const mine = this.userLevel(user);
      if (!admin && (!mine || SPECIAL_LEVELS.includes(tl) || LEVEL_RANK[tl] > LEVEL_RANK[mine])) throw forbidden('NO_ELEVATION', 'Pas d’élévation par délégation.');
    } else if (!admin && !user.roles.includes('R08')) {
      throw forbidden('NOT_ENTITY_ADMIN', 'L’opérateur d’accès est désigné par l’administrateur d’entité.');
    }
    if (this.grants.findOne((g) => g.userId === target.id && g.kind === input.kind && g.status !== 'REVOQUE')) throw conflict('GRANT_EXISTS', 'Permission déjà accordée ou en attente.');
    const val = this.validations.insert({
      id: this.ids.next('VAL', 5), kind: input.kind === 'DROIT_INVITER' ? 'DROIT_INVITER' : 'OPERATEUR_ACCES', subjectUserId: target.id,
      entity: target.entity, requestedBy: user.id, requirement: 'SECURITE', motif: input.motif, status: 'EN_ATTENTE', createdAt: this.now(),
    });
    const g = this.grants.insert({ id: this.ids.next('GRT', 5), userId: target.id, kind: input.kind, entity: target.entity, grantedBy: user.id, status: 'EN_ATTENTE', createdAt: this.now(), validationId: val.id });
    this.log(this.actor(user), 'grant.requested', 'grant', g.id, { entity: target.entity, kind: input.kind, subject: target.id, validationId: val.id });
    return { grant: g, validation: val };
  }

  listGrants(user: User) {
    const scope = this.visibleEntities(user);
    return this.grants.all().filter((g) => !scope || scope.has(g.entity));
  }

  revokeGrant(user: User, id: string, motif: string) {
    const g = this.grants.get(id);
    if (!g) throw notFound('GRANT_NOT_FOUND', `Permission inconnue : ${id}`);
    if (!this.isPlatformAdmin(user) && !this.subtree(user.entity).has(g.entity)) throw forbidden('OUT_OF_PERIMETER', 'Permission hors de votre entité.');
    if (g.status === 'REVOQUE') throw conflict('GRANT_REVOKED', 'Permission déjà révoquée.');
    this.requireMfa(user);
    const out = this.grants.update({ ...g, status: 'REVOQUE' });
    this.log(this.actor(user), 'grant.revoked', 'grant', id, { entity: g.entity, kind: g.kind, subject: g.userId, motif });
    return out;
  }

  revokeAccount(user: User, id: string, input: { motif: string; successorId?: string }) {
    const acc = this.ensureAccount(id);
    if (!acc) throw notFound('ACCOUNT_NOT_FOUND', `Compte de travail inconnu : ${id}`);
    if (!this.isOversight(user) && !this.subtree(user.entity).has(acc.entity)) throw forbidden('OUT_OF_PERIMETER', 'Compte hors de votre entité.');
    if (acc.status === 'REVOQUE') throw conflict('ACCOUNT_REVOKED', 'Compte déjà révoqué.');
    if (acc.id === user.id) throw forbidden('SELF_REVOCATION', 'La révocation de son propre compte passe par l’administrateur de l’entité.');
    this.requireMfa(user);
    if (input.successorId) {
      const s = this.ensureAccount(input.successorId);
      if (!s || s.status !== 'ACTIF' || s.entity !== acc.entity) throw unprocessable('BAD_SUCCESSOR', 'Le successeur doit être un compte actif de la même entité.');
    }
    return this.accountView(this.doRevokeAccount(user, acc, input.motif, input.successorId));
  }

  /** Révocation immédiate du compte et de ses terminaux ; les invités sont rattachés au successeur (§ 12A.5). */
  private doRevokeAccount(user: User, acc: WorkAccount, motif: string, successorId: string | undefined): WorkAccount {
    this.setDirectoryRoles(acc.id, []);
    const out = this.accounts.update({ ...acc, status: 'REVOQUE', revokedAt: this.now(), revokedReason: motif });
    for (const d of this.ctx.field.devices.find((x) => x.agentUserId === acc.id && x.status === 'ACTIF')) this.ctx.field.revoke(d.id, `Révocation du compte : ${motif}`);
    for (const g of this.grants.find((x) => x.userId === acc.id && x.status !== 'REVOQUE')) this.grants.update({ ...g, status: 'REVOQUE' });
    for (const i of this.invitations.find((x) => x.inviterId === acc.id && x.status === 'ENVOYEE')) {
      this.invitations.update({ ...i, status: 'REVOQUEE', revokedAt: this.now(), revokedReason: `Départ de l’invitant : ${motif}` });
    }
    const fallback = successorId ?? this.ctx.users.all().find((u) => u.entity === acc.entity && u.roles.includes('R08') && u.id !== acc.id)?.id;
    for (const child of this.accounts.find((x) => x.sponsorId === acc.id && x.status !== 'REVOQUE')) {
      this.accounts.update({ ...child, ...(fallback ? { sponsorId: fallback } : {}) });
      this.log(this.actor(user), 'account.sponsor_reassigned', 'account', child.id, { entity: child.entity, from: acc.id, to: fallback ?? null });
    }
    const u = this.ctx.users.get(acc.id);
    if (u) this.publishSafe('role.removed', this.usersRecipients([u]), {}, acc.entity);
    this.log(this.actor(user), 'account.revoked', 'account', acc.id, { entity: acc.entity, motif, successorId: fallback ?? null });
    return out;
  }

  revokeInvitation(user: User, id: string, motif: string) {
    const i = this.invitations.get(id);
    if (!i) throw notFound('INVITATION_UNKNOWN', `Invitation inconnue : ${id}`);
    if (i.inviterId !== user.id && !this.isOversight(user) && !(user.roles.includes('R08') && this.subtree(user.entity).has(i.entity))) {
      throw forbidden('OUT_OF_PERIMETER', 'Seuls l’invitant, l’administrateur de l’entité ou la sécurité révoquent une invitation.');
    }
    if (i.status !== 'ENVOYEE') throw conflict('INVITATION_CLOSED', 'Invitation déjà close.');
    const out = this.invitations.update({ ...i, status: 'REVOQUEE', revokedAt: this.now(), revokedReason: motif });
    this.log(this.actor(user), 'invitation.revoked', 'invitation', id, { entity: i.entity, motif });
    return this.invitationView(out);
  }

  journal(user: User, entity?: string) {
    const scope = this.visibleEntities(user);
    return this.ctx.audit.list({ action: 'acces.', limit: 100_000 }).items
      .filter((r) => {
        const e = typeof r.details.entity === 'string' ? r.details.entity : undefined;
        if (entity && e !== entity) return false;
        return !scope || (e !== undefined && scope.has(e));
      })
      .reverse()
      .slice(0, 300)
      .map((r) => ({ seq: r.seq, at: r.at, actor: r.actor.id, action: r.action, resourceType: r.resourceType, resourceId: r.resourceId, outcome: r.outcome, entity: r.details.entity ?? null, hash: r.hash }));
  }

  // ═════════════════════════════════ Identité avancée ═════════════════════════════════

  private taxpayer(id: string): Taxpayer {
    return this.ctx.taxpayers.get(id);
  }

  proofView(p: IdentityProof) {
    const { referenceHash: _h, ...rest } = p;
    return rest;
  }

  sendPhoneOtp(taxpayerId: string) {
    const t = this.taxpayer(taxpayerId);
    if (!t.phone) throw unprocessable('NO_PHONE', 'Aucun téléphone sur ce compte (enrôlement assisté) : vérification au guichet.');
    if (t.phoneVerifiedAt) throw conflict('PHONE_ALREADY_VERIFIED', 'Téléphone déjà vérifié.');
    const c = this.issueOtp('VERIFICATION_TELEPHONE', t.id, t.phone, 'Vérification du téléphone');
    this.ctx.comms.publish('auth.otp_code', [taxpayerRecipient(t)], { code: '••••••' }, { entity: 'GOUVERNORAT' });
    this.log({ kind: 'public', id: 'inscription' }, 'identity.otp_sent', 'taxpayer', t.id, {});
    return { challengeId: c.id, expiresAt: c.expiresAt, destinationMasked: maskPhone(t.phone), channel: 'sms', sandbox: this.sandbox };
  }

  verifyPhoneOtp(taxpayerId: string, challengeId: string, code: string) {
    const t = this.taxpayer(taxpayerId);
    try {
      this.checkOtp(challengeId, t.id, 'VERIFICATION_TELEPHONE', code);
    } catch (e) {
      this.log({ kind: 'public', id: 'inscription' }, 'identity.otp_failed', 'taxpayer', t.id, {}, 'DENIED');
      throw e;
    }
    this.ctx.taxpayers.markPhoneVerified(t.id);
    this.proofs.insert({
      id: this.ids.next('PRV', 6), taxpayerId: t.id, type: 'OTP_TELEPHONE', referenceMasked: maskPhone(t.phone), referenceHash: sha256Hex(t.phone),
      status: 'VALIDEE', declaredBy: 'systeme', declaredAt: this.now(), reviewedBy: 'systeme', reviewedAt: this.now(),
    });
    this.log({ kind: 'public', id: 'inscription' }, 'identity.phone_verified', 'taxpayer', t.id, {});
    const level = this.recomputeLevel(t.id, { kind: 'system', id: 'verification' });
    return { taxpayerId: t.id, phoneVerified: true, verificationLevel: level };
  }

  /** Niveau calculé à partir des preuves validées ; le niveau ne baisse jamais d'office. */
  private computeLevel(t: Taxpayer): VerificationLevel {
    const ps = this.proofs.find((p) => p.taxpayerId === t.id);
    const ok = (type: ProofType) => ps.some((p) => p.type === type && p.status === 'VALIDEE');
    const phoneOk = !!t.phoneVerifiedAt || ok('OTP_TELEPHONE');
    const base: VerificationLevel = t.assisted && !phoneOk ? 'N0A' : 'N0';
    const address = ps.some((p) => p.type === 'ADRESSE' && p.status !== 'REJETEE');
    if (!((phoneOk || t.assisted) && ok('PIECE_IDENTITE') && address)) return base;
    if (!(ok('CONTROLE_DOCUMENTAIRE') || ok('VISITE_TERRAIN'))) return 'N1';
    if (!(ok('NIF') && (t.kind !== 'PERSONNE_MORALE' || ok('RCCM')))) return 'N2';
    return 'N3';
  }

  private recomputeLevel(taxpayerId: string, actor: AuditActor): VerificationLevel {
    const t = this.taxpayer(taxpayerId);
    const next = this.computeLevel(t);
    if (LEVEL_ORDER[next] > LEVEL_ORDER[t.verificationLevel]) {
      return this.ctx.taxpayers.setVerificationLevel(t.id, next, actor, 'Preuves validées').verificationLevel;
    }
    return t.verificationLevel;
  }

  nextSteps(t: Taxpayer): string[] {
    const ps = this.proofs.find((p) => p.taxpayerId === t.id && p.status !== 'REJETEE');
    const has = (type: ProofType) => ps.some((p) => p.type === type);
    const out: string[] = [];
    if (!t.phoneVerifiedAt && t.phone) out.push('Vérifier votre téléphone par code à usage unique (N0).');
    if (!has('PIECE_IDENTITE')) out.push('Déclarer une pièce d’identité (contrôlée au guichet ou en ligne) — N1.');
    if (!has('ADRESSE')) out.push('Déclarer votre adresse — N1.');
    if (!has('CONTROLE_DOCUMENTAIRE') && !has('VISITE_TERRAIN')) out.push('Contrôle documentaire approfondi ou visite de terrain — N2.');
    if (!has('NIF')) out.push('NIF vérifié — N3.');
    if (t.kind === 'PERSONNE_MORALE' && !has('RCCM')) out.push('RCCM vérifié (personne morale) — N3.');
    return out;
  }

  identity(taxpayerId: string, viewer: 'self' | 'agent') {
    const t = this.taxpayer(taxpayerId);
    const org = this.organisations.findOne((o) => o.taxpayerId === t.id);
    return {
      taxpayer: {
        id: t.id, iuc: t.iuc, fullName: t.fullName, kind: t.kind ?? 'PERSONNE_PHYSIQUE', phoneMasked: t.phone ? maskPhone(t.phone) : null,
        phoneVerified: !!t.phoneVerifiedAt, verificationLevel: t.verificationLevel, assisted: !!t.assisted, status: t.status ?? 'ACTIF',
        ...(t.mergedInto ? { mergedInto: t.mergedInto } : {}), createdAt: t.createdAt,
      },
      proofs: this.proofs.find((p) => p.taxpayerId === t.id).map((p) => this.proofView(p)),
      organisation: org ?? null,
      levels: LEVEL_RIGHTS,
      nextSteps: this.nextSteps(t),
      viewer,
    };
  }

  declareProof(user: User, taxpayerId: string, input: { type: ProofType; reference: string; note?: string }) {
    const t = this.taxpayer(taxpayerId);
    if (input.type === 'OTP_TELEPHONE' || input.type === 'ENROLEMENT_ASSISTE') throw unprocessable('SYSTEM_PROOF', 'Cette preuve est établie par le système, pas déclarée.');
    if (this.proofs.findOne((p) => p.taxpayerId === t.id && p.type === input.type && p.status === 'DECLAREE')) {
      throw conflict('PROOF_PENDING', 'Une preuve de ce type est déjà en attente de contrôle.');
    }
    const hash = sha256Hex(`${input.type}:${input.reference.trim().toUpperCase()}`);
    const p = this.proofs.insert({
      id: this.ids.next('PRV', 6), taxpayerId: t.id, type: input.type, referenceMasked: maskRef(input.reference), referenceHash: hash,
      ...(input.note ? { note: input.note } : {}), status: 'DECLAREE', declaredBy: user.id, declaredAt: this.now(),
    });
    this.log(this.actor(user), 'identity.proof_declared', 'taxpayer', t.id, { type: input.type, proofId: p.id });
    const clash = this.proofs.findOne((x) => x.taxpayerId !== t.id && x.referenceHash === hash && x.status !== 'REJETEE');
    if (clash) this.log({ kind: 'system', id: 'deduplication' }, 'identity.duplicate_suspected', 'taxpayer', t.id, { other: clash.taxpayerId, reason: `MEME_${input.type}` });
    return this.proofView(p);
  }

  pendingProofs() {
    return this.proofs.find((p) => p.status === 'DECLAREE').map((p) => {
      const t = this.taxpayer(p.taxpayerId);
      return { ...this.proofView(p), taxpayer: { id: t.id, iuc: t.iuc, fullName: t.fullName, verificationLevel: t.verificationLevel, kind: t.kind ?? 'PERSONNE_PHYSIQUE' } };
    });
  }

  reviewProof(user: User, proofId: string, input: { decision: 'VALIDEE' | 'REJETEE'; note: string }) {
    const p = this.proofs.get(proofId);
    if (!p) throw notFound('PROOF_NOT_FOUND', `Preuve inconnue : ${proofId}`);
    if (p.status !== 'DECLAREE') throw conflict('PROOF_REVIEWED', 'Preuve déjà contrôlée.');
    assertDistinctPerson(user.id, [p.declaredBy], 'Le contrôle d’une pièce est fait par une personne distincte de celle qui l’a saisie.');
    const out = this.proofs.update({ ...p, status: input.decision, reviewedBy: user.id, reviewedAt: this.now(), reviewNote: input.note });
    this.log(this.actor(user), 'identity.proof_reviewed', 'taxpayer', p.taxpayerId, { type: p.type, decision: input.decision, proofId });
    const level = this.recomputeLevel(p.taxpayerId, this.actor(user));
    return { proof: this.proofView(out), verificationLevel: level };
  }

  /** Enrôlement assisté (N0-A) : consentement oral enregistré ou témoin ; empreinte désactivée tant que J18 n'est pas certifié. */
  assistedEnrolment(user: User, input: {
    fullName: string; language: Taxpayer['language']; commune: string; phone?: string;
    consent: { method: 'ORAL_ENREGISTRE' | 'TEMOIN' | 'EMPREINTE'; witnessName?: string; recordingRef?: string }; deviceId?: string;
  }) {
    if (input.consent.method === 'EMPREINTE') {
      throw unprocessable('FINGERPRINT_DISABLED', 'Capture d’empreinte désactivée tant que la question juridique J18 n’est pas certifiée : consentement oral enregistré ou témoin identifié.');
    }
    if (input.consent.method === 'TEMOIN' && !input.consent.witnessName) throw unprocessable('WITNESS_REQUIRED', 'Témoin identifié requis.');
    if (input.consent.method === 'ORAL_ENREGISTRE' && !input.consent.recordingRef) throw unprocessable('RECORDING_REQUIRED', 'Référence de l’enregistrement du consentement requise.');
    if (user.territory && !user.territory.includes(input.commune)) throw forbidden('OUT_OF_TERRITORY', 'Enrôlement hors de votre zone autorisée.');
    const t = this.ctx.taxpayers.registerAssisted({ fullName: input.fullName, language: input.language, situation: 'other', ...(input.phone ? { phone: input.phone } : {}) }, this.actor(user));
    this.proofs.insert({
      id: this.ids.next('PRV', 6), taxpayerId: t.id, type: 'ENROLEMENT_ASSISTE', referenceMasked: input.consent.method, referenceHash: sha256Hex(`${t.id}:${input.consent.method}`),
      note: `Consentement ${input.consent.method === 'TEMOIN' ? 'devant témoin' : 'oral enregistré'} — ${input.commune}`,
      status: 'VALIDEE', declaredBy: user.id, declaredAt: this.now(), reviewedBy: user.id, reviewedAt: this.now(),
    });
    this.log(this.actor(user), 'identity.assisted_enrolment', 'taxpayer', t.id, { commune: input.commune, consentMethod: input.consent.method, deviceId: input.deviceId ?? null });
    return {
      taxpayerId: t.id, iuc: t.iuc, verificationLevel: t.verificationLevel,
      notice: 'Compte N0-A créé. Aucun paiement n’est demandé ni reçu par l’agent : le paiement se fait par référence auprès d’un point agréé.',
    };
  }

  registerOrganisation(input: {
    raisonSociale: string; forme: Organisation['forme']; rccm?: string; idNat?: string; nif?: string; phone: string; email?: string;
    language: Taxpayer['language']; representatives: { fullName: string; fonction: string; phone?: string; habilitation: Representative['habilitation'] }[];
    declarant: { fullName: string; fonction: string };
  }, opts: { demo?: boolean } = {}) {
    const t = this.ctx.taxpayers.register({
      phone: input.phone, fullName: input.raisonSociale, language: input.language, situation: 'other', kind: 'PERSONNE_MORALE', ...(input.email ? { email: input.email } : {}),
    });
    const org = this.organisations.insert({
      id: this.ids.next('ORG', 5), taxpayerId: t.id, raisonSociale: input.raisonSociale, forme: input.forme,
      ...(input.rccm ? { rccmDeclared: input.rccm } : {}), ...(input.idNat ? { idNatDeclared: input.idNat } : {}), ...(input.nif ? { nifDeclared: input.nif } : {}),
      representatives: input.representatives.map((r) => ({ fullName: r.fullName, fonction: r.fonction, habilitation: r.habilitation, ...(r.phone ? { phoneMasked: maskPhone(normalizePhone(r.phone)) } : {}) })),
      createdAt: this.now(), ...(opts.demo ? { demo: true } : {}),
    });
    const declarant = `inscription:${input.declarant.fullName}`;
    for (const [type, ref] of [['RCCM', input.rccm], ['ID_NAT', input.idNat], ['NIF', input.nif]] as const) {
      if (!ref) continue;
      const hash = sha256Hex(`${type}:${ref.trim().toUpperCase()}`);
      this.proofs.insert({
        id: this.ids.next('PRV', 6), taxpayerId: t.id, type, referenceMasked: maskRef(ref), referenceHash: hash, status: 'DECLAREE',
        declaredBy: declarant, declaredAt: this.now(), note: 'Identifiant déclaré à l’inscription (statut probant : déclaré)',
      });
      const clash = this.proofs.findOne((x) => x.taxpayerId !== t.id && x.referenceHash === hash && x.status !== 'REJETEE');
      if (clash) this.log({ kind: 'system', id: 'deduplication' }, 'identity.duplicate_suspected', 'taxpayer', t.id, { other: clash.taxpayerId, reason: `MEME_${type}` });
    }
    this.log({ kind: 'public', id: 'inscription' }, 'organisation.registered', 'taxpayer', t.id, {
      forme: input.forme, representatives: input.representatives.length, declared: { rccm: !!input.rccm, idNat: !!input.idNat, nif: !!input.nif },
    });
    return { taxpayerId: t.id, iuc: t.iuc, verificationLevel: t.verificationLevel, organisationId: org.id, kind: 'PERSONNE_MORALE' as const };
  }

  // ─────────────── Doublons et fusion ───────────────

  private matchReasons(a: Taxpayer, b: Taxpayer): string[] {
    const reasons: string[] = [];
    const pa = this.proofs.find((p) => p.taxpayerId === a.id && p.status !== 'REJETEE' && p.type !== 'OTP_TELEPHONE' && p.type !== 'ENROLEMENT_ASSISTE');
    const pb = this.proofs.find((p) => p.taxpayerId === b.id && p.status !== 'REJETEE');
    for (const p of pa) if (pb.some((q) => q.referenceHash === p.referenceHash)) reasons.push(`MEME_${p.type}`);
    if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) reasons.push('MEME_COURRIEL');
    const na = new Set(normName(a.fullName));
    const nb = new Set(normName(b.fullName));
    const inter = [...na].filter((x) => nb.has(x)).length;
    const union = new Set([...na, ...nb]).size;
    if (inter >= 2 && (inter / union >= 0.5 || inter === Math.min(na.size, nb.size))) reasons.push('NOM_PROCHE');
    return [...new Set(reasons)];
  }

  private score(reasons: string[]): number {
    const w: Record<string, number> = { MEME_PIECE_IDENTITE: 0.6, MEME_RCCM: 0.6, MEME_NIF: 0.6, MEME_ID_NAT: 0.5, MEME_COURRIEL: 0.3, NOM_PROCHE: 0.25 };
    return Math.min(1, reasons.reduce((s, r) => s + (w[r] ?? 0.2), 0));
  }

  duplicateCandidates() {
    const list = this.ctx.taxpayers.taxpayers.find((t) => t.status !== 'FUSIONNE');
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if ((a.kind ?? 'PERSONNE_PHYSIQUE') !== (b.kind ?? 'PERSONNE_PHYSIQUE')) continue;
        const reasons = this.matchReasons(a, b);
        if (!reasons.length) continue;
        const merge = this.merges.findOne((m) => [m.survivorId, m.absorbedId].includes(a.id) && [m.survivorId, m.absorbedId].includes(b.id) && ['PROPOSEE', 'VERIFIEE'].includes(m.status));
        const brief = (t: Taxpayer) => ({ id: t.id, iuc: t.iuc, fullName: t.fullName, verificationLevel: t.verificationLevel, createdAt: t.createdAt, phoneMasked: t.phone ? maskPhone(t.phone) : null });
        out.push({
          id: `${a.id}~${b.id}`, a: brief(a), b: brief(b), reasons, score: this.score(reasons).toFixed(2),
          nameOnly: reasons.every((r) => r === 'NOM_PROCHE'), ...(merge ? { merge: { id: merge.id, status: merge.status } } : {}),
        });
      }
    }
    return out.sort((x, y) => Number(y.score) - Number(x.score));
  }

  merge(id: string): MergeRequest {
    const m = this.merges.get(id);
    if (!m) throw notFound('MERGE_NOT_FOUND', `Demande de fusion inconnue : ${id}`);
    return m;
  }

  listMerges() {
    return this.merges.all().reverse();
  }

  /** Fusion sur preuve, jamais sur la seule similitude de noms ; double validation par deux personnes distinctes. */
  proposeMerge(user: User, input: { survivorId: string; absorbedId: string; evidence: string; documentRef?: string }) {
    if (input.survivorId === input.absorbedId) throw unprocessable('SAME_ACCOUNT', 'Deux comptes distincts sont requis.');
    const a = this.taxpayer(input.survivorId);
    const b = this.taxpayer(input.absorbedId);
    if (a.status === 'FUSIONNE' || b.status === 'FUSIONNE') throw conflict('ALREADY_MERGED', 'Un des comptes est déjà fusionné.');
    if ((a.kind ?? 'PERSONNE_PHYSIQUE') !== (b.kind ?? 'PERSONNE_PHYSIQUE')) throw unprocessable('KIND_MISMATCH', 'Une personne physique et une personne morale ne se fusionnent jamais.');
    const reasons = this.matchReasons(a, b);
    if (!reasons.length) throw unprocessable('NO_MATCH_BASIS', 'Aucun élément de rapprochement entre ces comptes.');
    if (reasons.every((r) => r === 'NOM_PROCHE') && !input.documentRef) {
      throw unprocessable('NAME_ONLY_MATCH', 'Aucune fusion sur la seule similitude de noms : une pièce justificative référencée est obligatoire.');
    }
    if (this.merges.findOne((m) => ['PROPOSEE', 'VERIFIEE'].includes(m.status) && [m.survivorId, m.absorbedId].some((x) => x === a.id || x === b.id))) {
      throw conflict('MERGE_PENDING', 'Une demande de fusion est déjà en cours pour l’un de ces comptes.');
    }
    const m = this.merges.insert({
      id: this.ids.next('FUS', 5), survivorId: a.id, absorbedId: b.id, reasons, evidence: input.evidence,
      ...(input.documentRef ? { documentRef: input.documentRef } : {}), status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now(),
    });
    this.log(this.actor(user), 'merge.proposed', 'taxpayer', b.id, { mergeId: m.id, survivorId: a.id, reasons });
    this.ctx.comms.publish('account.merge.proposed', [taxpayerRecipient(a), taxpayerRecipient(b)], { reference: m.id }, { entity: 'GOUVERNORAT' });
    return m;
  }

  verifyMerge(user: User, id: string, note?: string) {
    const m = this.merge(id);
    if (m.status !== 'PROPOSEE') throw conflict('MERGE_BAD_STATE', `Vérification impossible depuis l’état ${m.status}.`);
    assertDistinctPerson(user.id, [m.proposedBy], 'La vérification est faite par une personne distincte de l’auteur de la proposition.');
    const out = this.merges.update({ ...m, status: 'VERIFIEE', verifiedBy: user.id, verifiedAt: this.now() });
    this.log(this.actor(user), 'merge.verified', 'taxpayer', m.absorbedId, { mergeId: id, note });
    return out;
  }

  approveMerge(user: User, id: string) {
    const m = this.merge(id);
    if (m.status !== 'VERIFIEE') throw conflict('MERGE_BAD_STATE', 'Double validation : la fusion doit d’abord être vérifiée par une autre personne.');
    assertDistinctPerson(user.id, [m.proposedBy, m.verifiedBy!], 'L’approbation est donnée par une troisième personne, distincte de l’auteur et du vérificateur.');
    this.requireMfa(user);
    this.ctx.taxpayers.setMergeState(m.absorbedId, m.survivorId);
    const out = this.merges.update({ ...m, status: 'EFFECTUEE', approvedBy: user.id, approvedAt: this.now() });
    this.log(this.actor(user), 'merge.completed', 'taxpayer', m.absorbedId, { mergeId: id, survivorId: m.survivorId, reversible: true });
    this.ctx.comms.publish('account.merge.completed', [taxpayerRecipient(this.taxpayer(m.survivorId)), taxpayerRecipient(this.taxpayer(m.absorbedId))], { reference: id }, { entity: 'GOUVERNORAT' });
    return out;
  }

  closeMerge(user: User, id: string, input: { action: 'REJETER' | 'ANNULER'; motif: string }) {
    const m = this.merge(id);
    if (input.action === 'REJETER') {
      if (!['PROPOSEE', 'VERIFIEE'].includes(m.status)) throw conflict('MERGE_BAD_STATE', 'Seule une demande en cours peut être rejetée.');
      assertDistinctPerson(user.id, [m.proposedBy], 'Le rejet est prononcé par une personne distincte de l’auteur.');
      const out = this.merges.update({ ...m, status: 'REJETEE', closedBy: user.id, closedAt: this.now(), closeReason: input.motif });
      this.log(this.actor(user), 'merge.rejected', 'taxpayer', m.absorbedId, { mergeId: id, motif: input.motif });
      return out;
    }
    if (m.status !== 'EFFECTUEE') throw conflict('MERGE_BAD_STATE', 'Seule une fusion effectuée peut être annulée.');
    this.requireMfa(user);
    this.ctx.taxpayers.setMergeState(m.absorbedId, null);
    const out = this.merges.update({ ...m, status: 'ANNULEE', closedBy: user.id, closedAt: this.now(), closeReason: input.motif });
    this.log(this.actor(user), 'merge.reversed', 'taxpayer', m.absorbedId, { mergeId: id, motif: input.motif });
    return out;
  }

  // ─────────────── Consultation motivée (bris de glace) ───────────────

  relatedTaxpayers(user: User): Set<string> {
    const out = new Set<string>(this.declaredRelations.get(user.id) ?? []);
    for (const t of this.accounts.get(user.id)?.linkedTaxpayerIds ?? []) out.add(t);
    if (user.taxpayerId) out.add(user.taxpayerId);
    return out;
  }

  /**
   * Motif de consultation obligatoire : dans le périmètre, la finalité est journalisée ; hors périmètre, accès
   * « bris de glace » limité à 30 minutes, second facteur, alerte à l'audit, revue a posteriori.
   */
  requestConsultation(user: User, input: { taxpayerId: string; purpose: Consultation['purpose']; motif: string }) {
    const t = this.taxpayer(input.taxpayerId);
    if (this.relatedTaxpayers(user).has(t.id)) {
      this.log(this.actor(user), 'consultation.refused', 'taxpayer', t.id, { entity: user.entity, reason: 'SELF_OR_RELATIVE_CASE' }, 'DENIED');
      throw forbidden('SELF_OR_RELATIVE_CASE', 'Un agent ne consulte ni ne traite son propre dossier ni celui de ses proches déclarés (récusation).');
    }
    const objects = this.ctx.objects.byTaxpayer(t.id);
    const obligations = this.ctx.assessment.byTaxpayer(t.id);
    const inPerimeter = evaluate(user, 'taxpayer.read' as AnyAction, {
      taxpayerId: t.id, entities: [...new Set(['DGIPK', ...obligations.map((o) => o.entity)])], communes: objects.map((o) => o.commune),
    });
    const mode: Consultation['mode'] = inPerimeter === 'full' ? 'PERIMETRE' : 'BRIS_DE_GLACE';
    if (mode === 'BRIS_DE_GLACE') this.requireMfa(user, true);
    const c = this.consultations.insert({
      id: this.ids.next('CSL', 6), userId: user.id, userEntity: user.entity, taxpayerId: t.id, purpose: input.purpose, motif: input.motif, mode,
      grantedAt: this.now(), expiresAt: new Date(this.ctx.clock.now().getTime() + CONSULTATION_TTL_MS).toISOString(), reads: 0,
    });
    this.log(this.actor(user), mode === 'PERIMETRE' ? 'consultation.motivated' : 'consultation.break_glass', 'taxpayer', t.id, {
      entity: user.entity, consultationId: c.id, purpose: input.purpose, motif: input.motif, expiresAt: c.expiresAt,
    });
    if (mode === 'BRIS_DE_GLACE') {
      this.ctx.alerts.raise({
        type: 'BRIS_DE_GLACE', severity: 'HIGH', source: 'acces', actor: this.actor(user),
        detail: `Consultation hors périmètre motivée (${input.purpose}) par ${user.id} — revue a posteriori requise.`,
        context: { consultationId: c.id, taxpayerId: t.id },
      });
      this.publishSafe('auth.break_glass.used', this.usersRecipients(this.ctx.users.withRole('R22')), { reference: c.id }, 'AUDIT');
    }
    return c;
  }

  consultationDossier(user: User, id: string) {
    const c = this.consultations.get(id);
    if (!c || c.userId !== user.id) throw notFound('CONSULTATION_NOT_FOUND', 'Autorisation de consultation inconnue.');
    if (c.expiresAt < this.now()) throw forbidden('CONSULTATION_EXPIRED', 'Autorisation expirée : une nouvelle demande motivée est nécessaire.');
    this.consultations.update({ ...c, reads: c.reads + 1 });
    this.log(this.actor(user), 'consultation.read', 'taxpayer', c.taxpayerId, { entity: user.entity, consultationId: c.id, mode: c.mode });
    const t = this.taxpayer(c.taxpayerId);
    return {
      consultation: { id: c.id, mode: c.mode, purpose: c.purpose, expiresAt: c.expiresAt },
      taxpayer: { id: t.id, iuc: t.iuc, fullName: t.fullName, phoneMasked: t.phone ? maskPhone(t.phone) : null, verificationLevel: t.verificationLevel, kind: t.kind ?? 'PERSONNE_PHYSIQUE' },
      objects: this.ctx.objects.byTaxpayer(t.id).map((o) => ({ id: o.id, category: o.category, commune: o.commune, quartier: o.quartier })),
      obligations: this.ctx.assessment.byTaxpayer(t.id).map((o) => obligationSummary(o, 'full')),
    };
  }

  listConsultations(user: User) {
    const all = this.consultations.all().reverse();
    return user.roles.some((r) => ['R22', 'R23', 'R28'].includes(r)) ? all : all.filter((c) => c.userId === user.id);
  }

  reviewConsultation(user: User, id: string, input: { conclusion: 'JUSTIFIEE' | 'INJUSTIFIEE'; note: string }) {
    const c = this.consultations.get(id);
    if (!c) throw notFound('CONSULTATION_NOT_FOUND', 'Consultation inconnue.');
    if (c.review) throw conflict('ALREADY_REVIEWED', 'Consultation déjà revue.');
    assertDistinctPerson(user.id, [c.userId], 'La revue est faite par une personne distincte du demandeur.');
    const out = this.consultations.update({ ...c, review: { by: user.id, at: this.now(), conclusion: input.conclusion, note: input.note } });
    this.log(this.actor(user), 'consultation.reviewed', 'consultation', id, { entity: c.userEntity, conclusion: input.conclusion });
    if (input.conclusion === 'INJUSTIFIEE') {
      this.ctx.alerts.raise({
        type: 'BRIS_DE_GLACE_INJUSTIFIE', severity: 'HIGH', source: 'acces', actor: this.actor(user),
        detail: `Consultation ${id} jugée injustifiée : dossier à instruire (aucune sanction automatique).`, context: { consultationId: id, userId: c.userId },
      });
    }
    return out;
  }

  // ─────────────── Mandats ───────────────

  private syncMandants(mandataireUserId: string, taxpayerId: string): void {
    const u = this.ctx.users.get(mandataireUserId);
    if (!u) return;
    const active = !!this.mandates.findOne((m) => m.mandataireUserId === mandataireUserId && m.mandantTaxpayerId === taxpayerId && m.status === 'ACTIF');
    const set = new Set(u.mandants ?? []);
    if (active) set.add(taxpayerId); else set.delete(taxpayerId);
    this.ctx.users.setMandants(mandataireUserId, [...set]);
  }

  mandateView(m: Mandate) {
    const u = this.ctx.users.get(m.mandataireUserId);
    const t = this.ctx.taxpayers.taxpayers.get(m.mandantTaxpayerId);
    return {
      ...m, mandataireName: u?.name ?? m.mandataireUserId, mandantName: t?.fullName ?? m.mandantTaxpayerId,
      certified: this.certifiedMandataires.has(m.mandataireUserId),
    };
  }

  listMandates(user: User) {
    this.sweep();
    const list = user.roles.includes('R30') && user.taxpayerId
      ? this.mandates.find((m) => m.mandantTaxpayerId === user.taxpayerId)
      : this.mandates.find((m) => m.mandataireUserId === user.id);
    return list.reverse().map((m) => this.mandateView(m));
  }

  mandataires() {
    return this.ctx.users.withRole('R31').map((u) => ({ id: u.id, name: u.name, certified: this.certifiedMandataires.has(u.id) }));
  }

  createMandate(user: User, input: { mandataireUserId: string; kind: Mandate['kind']; scope: MandateAction[]; objectIds?: string[]; validFrom?: string; validTo: string; proofRef?: string }) {
    const tpId = user.taxpayerId!;
    const t = this.taxpayer(tpId);
    if (LEVEL_ORDER[t.verificationLevel] < 1) {
      throw unprocessable('LEVEL_TOO_LOW', 'Désigner un mandataire exige le niveau N1 (pièce d’identité contrôlée et adresse déclarée).');
    }
    const mandataire = this.ctx.users.get(input.mandataireUserId);
    if (!mandataire || !mandataire.roles.includes('R31')) throw unprocessable('NOT_A_MANDATAIRE', 'Le mandataire doit disposer d’un compte public de mandataire.');
    if (input.kind === 'PROFESSIONNEL' && !this.certifiedMandataires.has(mandataire.id)) {
      throw unprocessable('MANDATAIRE_NOT_CERTIFIED', 'Mandat de tiers professionnel : le mandataire doit être certifié N3 (mandat écrit ou notarié).');
    }
    const validFrom = input.validFrom ?? this.today();
    if (input.validTo <= validFrom) throw unprocessable('BAD_PERIOD', 'La date de fin doit suivre la date de début.');
    const max = new Date(`${validFrom}T00:00:00Z`);
    max.setUTCFullYear(max.getUTCFullYear() + 3);
    if (input.validTo > isoDate(max)) throw unprocessable('MANDATE_TOO_LONG', 'Durée maximale d’un mandat : 3 ans, renouvelable.');
    const own = new Set(this.ctx.objects.byTaxpayer(tpId).map((o) => o.id));
    const objectIds = input.objectIds ?? [];
    if (objectIds.some((o) => !own.has(o))) throw forbidden('NOT_OWN_OBJECT', 'Un mandat ne porte que sur vos propres objets.');
    if (this.mandates.findOne((m) => m.mandantTaxpayerId === tpId && m.mandataireUserId === mandataire.id && m.status === 'ACTIF')) {
      throw conflict('MANDATE_EXISTS', 'Un mandat actif existe déjà pour ce mandataire : révoquez-le avant d’en créer un autre.');
    }
    const m = this.mandates.insert({
      id: this.ids.next('MDT', 5), mandantTaxpayerId: tpId, mandataireUserId: mandataire.id, kind: input.kind, scope: [...new Set(input.scope)],
      objectIds, validFrom, validTo: input.validTo, ...(input.proofRef ? { proofRef: input.proofRef } : {}), status: 'ACTIF', createdAt: this.now(), createdBy: user.id,
    });
    this.syncMandants(mandataire.id, tpId);
    this.log(this.actor(user), 'mandate.granted', 'mandate', m.id, { mandant: tpId, mandataire: mandataire.id, scope: m.scope, validTo: m.validTo, kind: m.kind });
    this.ctx.comms.publish('mandate.granted', [taxpayerRecipient(t), userRecipient(mandataire)], { reference: m.id }, { entity: 'GOUVERNORAT' });
    return this.mandateView(m);
  }

  revokeMandate(user: User, id: string, motif: string) {
    const m = this.mandates.get(id);
    if (!m) throw notFound('MANDATE_NOT_FOUND', `Mandat inconnu : ${id}`);
    const isMandant = user.taxpayerId === m.mandantTaxpayerId;
    const isMandataire = user.id === m.mandataireUserId;
    if (!isMandant && !isMandataire) throw forbidden('NOT_A_PARTY', 'Seuls le mandant et le mandataire peuvent mettre fin au mandat.');
    if (m.status !== 'ACTIF') throw conflict('MANDATE_CLOSED', 'Mandat déjà clos.');
    const out = this.mandates.update({ ...m, status: 'REVOQUE', revokedAt: this.now(), revokedBy: user.id, revokeReason: motif });
    this.syncMandants(m.mandataireUserId, m.mandantTaxpayerId);
    this.log(this.actor(user), 'mandate.revoked', 'mandate', id, { mandant: m.mandantTaxpayerId, mandataire: m.mandataireUserId, by: isMandant ? 'MANDANT' : 'MANDATAIRE', motif });
    const t = this.taxpayer(m.mandantTaxpayerId);
    const mu = this.ctx.users.get(m.mandataireUserId);
    this.ctx.comms.publish('mandate.revoked', [taxpayerRecipient(t), ...(mu ? [userRecipient(mu)] : [])], { reference: id }, { entity: 'GOUVERNORAT' });
    return this.mandateView(out);
  }

  /**
   * § 13.5 « Chaque acte du mandataire est notifié au mandant » : après une requête d'écriture réussie d'un mandataire,
   * les enregistrements d'audit de la requête (même identifiant de corrélation) désignent le ou les mandants concernés ;
   * chacun reçoit l'événement `mandate.action_performed`, et l'acte est journalisé. Aucun acte n'est inféré : sans
   * mandant identifiable dans le journal, rien n'est notifié.
   */
  notifyMandateActs(user: User, input: { correlationId?: string; method: string; route: string }): string[] {
    if (!user.roles.includes('R31') || user.roles.includes('R30') || !input.correlationId) return [];
    const mandants = new Set(user.mandants ?? []);
    if (!mandants.size) return [];
    const records = this.ctx.audit.list({ correlationId: input.correlationId, limit: 500 }).items.filter((r) => r.actor.id === user.id && r.outcome === 'SUCCESS' && !r.action.startsWith('acces.mandate.'));
    if (!records.length) return [];
    const concerned = new Set<string>();
    const consider = (v: unknown) => { if (typeof v === 'string' && mandants.has(v)) concerned.add(v); };
    for (const r of records) {
      for (const k of ['taxpayerId', 'mandant', 'taxpayer', 'ownerTaxpayerId']) consider(r.details[k]);
      if (r.resourceType === 'taxpayer') consider(r.resourceId);
      const obligationId = typeof r.details.obligationId === 'string' ? r.details.obligationId : r.resourceType === 'obligation' ? r.resourceId : null;
      if (obligationId) {
        try { consider(this.ctx.assessment.get(obligationId).taxpayerId); } catch { /* obligation inconnue */ }
      }
    }
    const actions = [...new Set(records.map((r) => r.action))];
    for (const tpId of concerned) {
      const t = this.ctx.taxpayers.taxpayers.get(tpId);
      if (!t) continue;
      this.ctx.comms.publish('mandate.action_performed', [taxpayerRecipient(t)], { mandataire: user.name, action: actions.join(', ') }, { entity: 'GOUVERNORAT' });
      this.log(this.actor(user), 'mandate.action_performed', 'taxpayer', tpId, { mandant: tpId, mandataire: user.id, method: input.method, route: input.route, actions });
    }
    return [...concerned];
  }

  /** Périmètre d'un mandat : action et objet (utilisable par les autres modules avant un acte du mandataire). */
  mandateAllows(userId: string, taxpayerId: string, action: MandateAction, objectId?: string): boolean {
    this.sweep();
    return !!this.mandates.findOne((m) => m.mandataireUserId === userId && m.mandantTaxpayerId === taxpayerId && m.status === 'ACTIF'
      && m.scope.includes(action) && (!objectId || m.objectIds.length === 0 || m.objectIds.includes(objectId)));
  }
}
