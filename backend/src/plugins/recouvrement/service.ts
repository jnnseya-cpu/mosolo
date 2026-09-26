/**
 * Recouvrement gradué, avis légaux, arriérés, échéanciers (ch. 21, § 6.3, § 6.7 ; modules 27, 32, 33, 36, 39).
 *
 * Doctrine appliquée :
 *  - le système CONSTATE (retard, âge, prescription), SEGMENTE (sans effet) et RAPPELLE (rappels amiables datés) ;
 *  - toute étape au-delà du rappel est une PROPOSITION d'un agent de recouvrement (R20) suivie d'une DÉCISION
 *    motivée d'une autorité distincte (R21) — jamais de mesure, pénalité ou blocage automatique ;
 *  - aucune proposition ni décision sur un dossier contesté avec effet suspensif (demandé ou accordé), sans adresse
 *    de notification valide, pendant un paiement en cours de règlement ou un échéancier en vigueur ;
 *  - pénalités et remises uniquement sur le fondement d'une règle ACTIVE du registre, après décision humaine ;
 *  - chaque avis est numéroté, porte ses mentions obligatoires (base légale, montant, échéance, voie et délai de
 *    recours), son empreinte, sa preuve de notification (journal de délivrance) et son accusé de lecture.
 */
import { isRuleExecutable, Money, type CurrencyCode, type MoneyJSON, type ObligationStatus } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, isoDate } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { APPEAL_PROCEDURE } from '../../modules/appeals/procedure.js';
import type { Obligation } from '../../modules/assessment/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { AGE_BANDS, LARGE_DEBTOR_THRESHOLD_EXAMPLE, RECOVERY_PROCEDURE, SEGMENTS, type SegmentCode } from './parameters.js';

// ───────────────────────── Politique d'accès (moindre privilège) ─────────────────────────
const A = GRANTS.always;
const AGENTS_READ = { R06: A, R07: A, R11: A, R20: A, R21: A, R22: A, R23: A };
definePolicy('recouvrement:read', AGENTS_READ);
definePolicy('recouvrement:schedule', { R06: A, R07: A, R20: A });
definePolicy('recouvrement:propose', { R20: A });
definePolicy('recouvrement:decide', { R21: A });
definePolicy('recouvrement:notice.issue', { R06: A, R07: A, R11: A, R20: A });
definePolicy('recouvrement:notice.read', { ...AGENTS_READ, R12: A, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('recouvrement:notice.ack', { R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('recouvrement:address.verify', { R12: A, R20: A });
definePolicy('recouvrement:plan.request', { R12: A, R20: A, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('recouvrement:plan.decide', { R20: A, R21: A });
definePolicy('recouvrement:plan.default', { R20: A });
definePolicy('recouvrement:takeover.propose', { R20: A });
definePolicy('recouvrement:takeover.validate', { R06: A });
definePolicy('recouvrement:penalty.propose', { R20: A });
definePolicy('recouvrement:remission.request', { R20: A, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('recouvrement:mine', { R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('recouvrement:observations', { R20: A, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });

// ───────────────────────── Types ─────────────────────────
export type NoticeKind =
  | 'AVIS_IMPOSITION' | 'RAPPEL' | 'AVIS_ECHEANCE_DEPASSEE' | 'RELANCE' | 'AVIS_FORMEL' | 'MISE_EN_DEMEURE'
  | 'MESURE_ENVISAGEE' | 'DECISION_MESURE' | 'LEVEE_MESURE' | 'ECHEANCIER';

const NOTICE_META: Record<NoticeKind, { prefix: string; title: string; event: string }> = {
  AVIS_IMPOSITION: { prefix: 'AI', title: 'Avis d’imposition', event: 'assessment.issued' },
  RAPPEL: { prefix: 'RA', title: 'Rappel amiable avant échéance', event: 'obligation.due_soon' },
  AVIS_ECHEANCE_DEPASSEE: { prefix: 'AE', title: 'Avis d’échéance dépassée', event: 'obligation.overdue' },
  RELANCE: { prefix: 'RL', title: 'Relance et offre d’assistance', event: 'recovery.reminder.1' },
  AVIS_FORMEL: { prefix: 'AF', title: 'Constat et notification formelle', event: 'recovery.reminder.2' },
  MISE_EN_DEMEURE: { prefix: 'MD', title: 'Mise en demeure', event: 'recovery.formal_notice' },
  MESURE_ENVISAGEE: { prefix: 'ME', title: 'Mesure d’exécution envisagée — vos droits', event: 'recovery.enforcement.proposed' },
  DECISION_MESURE: { prefix: 'DM', title: 'Décision de mesure d’exécution', event: 'recovery.enforcement.decided' },
  LEVEE_MESURE: { prefix: 'LM', title: 'Levée de mesure', event: 'recovery.enforcement.lifted' },
  ECHEANCIER: { prefix: 'EC', title: 'Échéancier de paiement accordé', event: 'installment_plan.granted' },
};

export interface NoticeContent {
  number: string;
  kind: NoticeKind;
  title: string;
  issuedOn: string;
  issuingAuthority: string;
  administeringEntity: string;
  taxpayer: { id: string; name: string; iuc: string };
  obligation: { id: string; label: string; ruleCode: string; ruleVersion: number; objectId: string; status: ObligationStatus };
  legalBasis: { id: string; title: string; status: string }[];
  articles: string[];
  amount: MoneyJSON;
  dueDate: string;
  remedy: { path: string; delayDays: number; deadline: string; delayStatus: 'A_VERIFIER' };
  payment: { beneficiaryAccountAlias: string; paymentReference?: string; instructions: string };
  body: string[];
  decision?: { by: string; at: string; motivation: string; legalBasis?: { instrumentId: string; title: string; article: string } };
  installments?: { seq: number; dueDate: string; amount: MoneyJSON }[];
  mentions: string[];
  demo: boolean;
}

export interface LegalNotice {
  id: string;
  number: string;
  kind: NoticeKind;
  taxpayerId: string;
  obligationId: string;
  caseId?: string;
  planId?: string;
  issuedAt: string;
  issuedBy: string;
  content: NoticeContent;
  contentHash: string;
  eventCode: string;
  deliveryIds: string[];
  notification: 'NOTIFIE' | 'NON_DELIVRE';
  readAt?: string;
  readBy?: string;
  demo: boolean;
}

export type StepKind =
  | 'RAPPEL_J_MOINS_15' | 'RAPPEL_J_MOINS_3' | 'AVIS_J_PLUS_1' | 'RELANCE_J_PLUS_15'
  | 'AVIS_FORMEL' | 'MISE_EN_DEMEURE' | 'MESURE_EXECUTION' | 'LEVEE' | 'CLASSEMENT';
export type ProposalKind = 'AVIS_FORMEL' | 'MISE_EN_DEMEURE' | 'MESURE_EXECUTION' | 'LEVEE' | 'CLASSEMENT';
const REMINDER_STEPS: StepKind[] = ['RAPPEL_J_MOINS_15', 'RAPPEL_J_MOINS_3', 'AVIS_J_PLUS_1', 'RELANCE_J_PLUS_15'];

export const STEP_LABELS: Record<StepKind, string> = {
  RAPPEL_J_MOINS_15: 'Rappel amiable J−15',
  RAPPEL_J_MOINS_3: 'Rappel amiable J−3',
  AVIS_J_PLUS_1: 'Avis d’échéance dépassée J+1',
  RELANCE_J_PLUS_15: 'Relance et offre d’assistance J+15',
  AVIS_FORMEL: 'Constat et notification formelle (J+30)',
  MISE_EN_DEMEURE: 'Mise en demeure (double validation)',
  MESURE_EXECUTION: 'Mesure d’exécution (décision motivée)',
  LEVEE: 'Levée de la mesure',
  CLASSEMENT: 'Classement motivé',
};

export interface RecoveryStep {
  kind: StepKind;
  doneOn: string;
  at: string;
  by: string;
  noticeId?: string;
  proposalId?: string;
  /** Étape d'historique de démonstration (données fictives antérieures à la mise en service). */
  demoHistoric?: boolean;
}

export interface RecoveryCase {
  id: string;
  obligationId: string;
  taxpayerId: string;
  openedAt: string;
  openedBy: string;
  status: 'OUVERT' | 'REGULARISE' | 'CLASSE';
  steps: RecoveryStep[];
  observations: { at: string; by: string; text: string }[];
  demo?: boolean;
}

export interface Blocker { code: string; detail: string }

export interface RecoveryProposal {
  id: string;
  caseId: string;
  obligationId: string;
  taxpayerId: string;
  kind: ProposalKind;
  motivation: string;
  legalBasis?: { instrumentId: string; title: string; article: string };
  measureType?: string;
  proposedBy: string;
  proposedAt: string;
  status: 'PROPOSEE' | 'APPROUVEE' | 'REJETEE';
  decision?: { decision: 'APPROUVEE' | 'REJETEE'; by: string; at: string; motivation: string };
  noticeId?: string;
}

export interface InstallmentPlan {
  id: string;
  taxpayerId: string;
  obligationId: string;
  requestedBy: string;
  requestedAt: string;
  requestedCount: number;
  reason: string;
  legalBasis: { instrumentId: string; title: string; demo: boolean };
  status: 'DEMANDE' | 'ACCORDE' | 'REFUSE' | 'DEFAILLANT' | 'SOLDE';
  decision?: { by: string; at: string; motivation: string; granted: boolean };
  installments: { seq: number; dueDate: string; amount: MoneyJSON }[];
  defaultRecord?: { by: string; at: string; motivation: string };
  noticeId?: string;
  /** Échéances déjà rappelées (rappel J−3, une seule fois par échéance). */
  remindedSeqs?: number[];
}

export interface ArrearTakeover {
  id: string;
  taxpayerId: string;
  objectId?: string;
  fiscalYear: number;
  revenueLabel: string;
  amount: MoneyJSON;
  originalLegalBasis: { instrumentIds: string[]; articles: string[]; instruments: { id: string; title: string; status: string; abrogatedOn?: string }[] };
  legalOpinionRef: string;
  interruptionActRef?: string;
  prescription: { prescribedOn: string; reached: boolean; interrupted: boolean; status: 'A_VERIFIER' };
  proposedBy: string;
  proposedAt: string;
  status: 'PROPOSEE' | 'VALIDEE' | 'REJETEE';
  decision?: { by: string; at: string; motivation: string };
}

export interface PenaltyProposal {
  id: string;
  obligationId: string;
  taxpayerId: string;
  objectId: string;
  penaltyRuleId: string;
  inputs: Record<string, string>;
  previewAmount: MoneyJSON;
  motivation: string;
  proposedBy: string;
  proposedAt: string;
  status: 'PROPOSEE' | 'DECIDEE' | 'REJETEE' | 'LIQUIDEE';
  decision?: { by: string; at: string; motivation: string; decision: 'APPROUVEE' | 'REJETEE' };
  liquidatedObligationId?: string;
  liquidatedBy?: string;
}

export interface RemissionRequest {
  id: string;
  obligationId: string;
  taxpayerId: string;
  basisRuleId: string;
  requestedAmount: MoneyJSON;
  motivation: string;
  requestedBy: string;
  requestedAt: string;
  status: 'DEMANDEE' | 'ACCORDEE' | 'REFUSEE';
  decision?: { by: string; at: string; motivation: string; grantedAmount?: MoneyJSON };
  rectifyingObligationId?: string;
}

export interface NotificationAddress {
  id: string; // = taxpayerId
  channel: 'TELEPHONE' | 'COURRIEL' | 'ADRESSE_POSTALE';
  valueMasked: string;
  proof: string;
  verifiedAt: string;
  verifiedBy: string;
  demo?: boolean;
}

const PAYABLE: ObligationStatus[] = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];
const ARREAR_STATUSES: ObligationStatus[] = [...PAYABLE, 'CONTESTEE'];

const dayMs = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).getTime();
export const addDays = (d: string, n: number) => isoDate(new Date(dayMs(d) + n * DAY_MS));
const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
const mask = (v: string) => (v.length <= 4 ? '****' : `${v.slice(0, 3)}${'*'.repeat(Math.max(3, v.length - 5))}${v.slice(-2)}`);

// ───────────────────────── Service ─────────────────────────
export class RecoveryService {
  readonly notices = new InMemoryRepository<LegalNotice>();
  readonly cases = new InMemoryRepository<RecoveryCase>();
  readonly proposals = new InMemoryRepository<RecoveryProposal>();
  readonly plans = new InMemoryRepository<InstallmentPlan>();
  readonly takeovers = new InMemoryRepository<ArrearTakeover>();
  readonly penalties = new InMemoryRepository<PenaltyProposal>();
  readonly remissions = new InMemoryRepository<RemissionRequest>();
  readonly addresses = new InMemoryRepository<NotificationAddress>();
  private readonly ids = new IdGenerator();
  /** Instrument autorisant les échéanciers (absent ⇒ « acte requis », aucun échéancier possible). */
  planLegalBasisInstrumentId: string | null = null;

  constructor(private readonly ctx: AppContext) {}

  private today(): string {
    return isoDate(this.ctx.clock.now());
  }
  private nowIso(): string {
    return this.ctx.clock.now().toISOString();
  }
  private actor(user: User) {
    return { kind: 'user' as const, id: user.id, roles: user.roles };
  }

  // ── Adresse de notification ──
  addressValid(taxpayerId: string): boolean {
    if (this.addresses.get(taxpayerId)) return true;
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    return !!tp && tp.verificationLevel !== 'N0';
  }

  verifyAddress(user: User, taxpayerId: string, input: { channel: NotificationAddress['channel']; value: string; proof: string }): NotificationAddress {
    authorize(user, 'recouvrement:address.verify');
    this.ctx.taxpayers.get(taxpayerId);
    const rec: NotificationAddress = {
      id: taxpayerId, channel: input.channel, valueMasked: mask(input.value.trim()), proof: input.proof,
      verifiedAt: this.nowIso(), verifiedBy: user.id,
    };
    const saved = this.addresses.get(taxpayerId) ? this.addresses.update(rec) : this.addresses.insert(rec);
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.notification_address.verified', resourceType: 'taxpayer', resourceId: taxpayerId, details: { channel: input.channel, proof: input.proof } });
    return saved;
  }

  // ── Avis légaux numérotés ──
  private nextNumber(kind: NoticeKind): string {
    const year = this.ctx.clock.now().getUTCFullYear();
    return this.ids.next(`${NOTICE_META[kind].prefix}-${year}`, 6);
  }

  /** Mentions obligatoires : un avis incomplet n'est jamais émis. */
  static missingMandatory(c: NoticeContent): string[] {
    const missing: string[] = [];
    if (!c.number) missing.push('numéro');
    if (!c.legalBasis.length) missing.push('base légale');
    if (!c.amount?.amount || !c.amount.currency) missing.push('montant');
    if (!c.dueDate) missing.push('échéance');
    if (!c.remedy?.path?.trim()) missing.push('voie de recours');
    if (!(c.remedy?.delayDays > 0)) missing.push('délai de recours');
    if (!c.taxpayer?.id) missing.push('destinataire');
    return missing;
  }

  private issueNotice(kind: NoticeKind, o: Obligation, opts: {
    by: string; caseId?: string; planId?: string; body: string[]; dueDate?: string; amount?: MoneyJSON;
    decision?: NoticeContent['decision']; installments?: NoticeContent['installments'];
  }): LegalNotice {
    const rule = this.ctx.rules.get(o.ruleId);
    const tp = this.ctx.taxpayers.get(o.taxpayerId);
    const issuedOn = this.today();
    const number = this.nextNumber(kind);
    const order = this.ctx.payments.orders.find((p) => p.obligationId === o.id && p.status === 'INITIE').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const demo = !!rule.demo;
    const content: NoticeContent = {
      number, kind, title: NOTICE_META[kind].title, issuedOn,
      issuingAuthority: o.explanation.competentAuthority, administeringEntity: o.entity,
      taxpayer: { id: tp.id, name: tp.fullName, iuc: tp.iuc },
      obligation: { id: o.id, label: o.label, ruleCode: o.ruleCode, ruleVersion: o.ruleVersion, objectId: o.objectId, status: o.status },
      legalBasis: o.explanation.legalBasis,
      articles: o.explanation.articles,
      amount: opts.amount ?? o.amount,
      dueDate: opts.dueDate ?? o.dueDate,
      remedy: {
        path: o.explanation.appealPath, delayDays: APPEAL_PROCEDURE.filingDelayDays,
        deadline: addDays(issuedOn, APPEAL_PROCEDURE.filingDelayDays), delayStatus: 'A_VERIFIER',
      },
      payment: {
        beneficiaryAccountAlias: o.beneficiaryAccountAlias,
        ...(order ? { paymentReference: order.paymentReference } : {}),
        instructions: 'Paiement uniquement par le circuit officiel MOSOLO vers le compte public indiqué (référence unique générée depuis votre espace, un guichet ou un point agréé). Aucun agent n’encaisse d’espèces.',
      },
      body: opts.body,
      ...(opts.decision ? { decision: opts.decision } : {}),
      ...(opts.installments ? { installments: opts.installments } : {}),
      mentions: [
        'Aucune quittance n’est délivrée sur capture d’écran ou SMS : seule la quittance MOSOLO vérifiable fait foi.',
        `Délais de recours et de procédure : valeurs de conception à confirmer par l’Édit n° 005/2021 [À VÉRIFIER].`,
        'Valeur juridique de la notification électronique : à confirmer au regard du Code du numérique et de l’édit [À VÉRIFIER].',
        ...(demo ? ['DÉMONSTRATION — règle fictive, avis sans valeur juridique.'] : []),
      ],
      demo,
    };
    const missing = RecoveryService.missingMandatory(content);
    if (missing.length) {
      throw unprocessable('NOTICE_MANDATORY_CONTENT_MISSING', `Avis non émis : mentions obligatoires manquantes (${missing.join(', ')}).`, { missing });
    }
    const contentHash = sha256Hex(canonicalJson(content));
    const deliveries = this.ctx.comms.publish(NOTICE_META[kind].event, [taxpayerRecipient(tp)], { reference: number, date: content.dueDate }, { entity: o.entity });
    const delivered = deliveries.some((d) => d.status !== 'supprime_par_preference' && d.status !== 'echoue');
    const notice = this.notices.insert({
      id: number, number, kind, taxpayerId: o.taxpayerId, obligationId: o.id,
      ...(opts.caseId ? { caseId: opts.caseId } : {}), ...(opts.planId ? { planId: opts.planId } : {}),
      issuedAt: this.nowIso(), issuedBy: opts.by, content, contentHash, eventCode: NOTICE_META[kind].event,
      deliveryIds: deliveries.map((d) => d.id), notification: delivered ? 'NOTIFIE' : 'NON_DELIVRE', demo,
    });
    this.ctx.audit.append({
      actor: opts.by === 'systeme' ? { kind: 'system', id: 'recouvrement' } : { kind: 'user', id: opts.by },
      action: 'recovery.notice.issued', resourceType: 'notice', resourceId: number,
      details: { kind, obligationId: o.id, contentHash, deliveries: deliveries.length },
    });
    return notice;
  }

  /** Avis d'imposition numéroté et imprimable pour une obligation émise. */
  issueAssessmentNotice(user: User, obligationId: string): LegalNotice {
    authorize(user, 'recouvrement:notice.issue');
    const o = this.ctx.assessment.get(obligationId);
    if (!PAYABLE.includes(o.status) && o.status !== 'CONTESTEE') {
      throw unprocessable('OBLIGATION_NOT_NOTIFIABLE', `Obligation au statut ${o.status} : aucun avis d'imposition.`);
    }
    const existing = this.notices.findOne((n) => n.kind === 'AVIS_IMPOSITION' && n.obligationId === o.id);
    if (existing) return existing;
    return this.issueNotice('AVIS_IMPOSITION', o, {
      by: user.id,
      body: [
        `Il vous est notifié l’obligation ${o.id} — ${o.label}.`,
        `Montant établi par application de la règle ${o.ruleCode} version ${o.ruleVersion} : formule « ${o.explanation.formula} », rang de localité ${o.explanation.localityRank}.`,
        `Fait générateur : ${o.explanation.taxableEvent}. Redevable : ${o.explanation.liableParty}.`,
        'Vous pouvez contester ce montant depuis votre espace MOSOLO, avec pièces justificatives, dans le délai indiqué.',
      ],
    });
  }

  noticeFor(user: User, id: string): LegalNotice {
    const n = this.notices.get(id);
    if (!n) throw notFound('NOTICE_NOT_FOUND', `Avis inconnu : ${id}`);
    authorize(user, 'recouvrement:notice.read', { taxpayerId: n.taxpayerId });
    return n;
  }

  noticeProof(user: User, id: string) {
    const n = this.noticeFor(user, id);
    const deliveries = this.ctx.comms.deliveries.find((d) => n.deliveryIds.includes(d.id)).map((d) => ({
      id: d.id, at: d.at, channel: d.channel, status: d.status, provider: d.provider, providerMode: d.providerMode,
      recipientMasked: d.recipientMasked, contentHash: d.contentHash, mandatory: d.mandatory,
    }));
    return {
      notice: { id: n.id, number: n.number, kind: n.kind, issuedAt: n.issuedAt, contentHash: n.contentHash, eventCode: n.eventCode },
      deliveries,
      readAcknowledgement: n.readAt ? { at: n.readAt, by: n.readBy } : null,
    };
  }

  acknowledgeRead(user: User, id: string): LegalNotice {
    const n = this.notices.get(id);
    if (!n) throw notFound('NOTICE_NOT_FOUND', `Avis inconnu : ${id}`);
    authorize(user, 'recouvrement:notice.ack', { taxpayerId: n.taxpayerId });
    if (n.readAt) return n;
    const updated = this.notices.update({ ...n, readAt: this.nowIso(), readBy: user.id });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.notice.read', resourceType: 'notice', resourceId: id, details: { contentHash: n.contentHash } });
    return updated;
  }

  listNotices(filter: { taxpayerId?: string; taxpayerIds?: string[]; obligationId?: string } = {}): LegalNotice[] {
    return this.notices
      .find((n) => (!filter.taxpayerId || n.taxpayerId === filter.taxpayerId) && (!filter.taxpayerIds || filter.taxpayerIds.includes(n.taxpayerId)) && (!filter.obligationId || n.obligationId === filter.obligationId))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }

  // ── Constats : âge, prescription, segmentation (sans effet) ──
  private ageBand(age: number) {
    return AGE_BANDS.find((b) => age <= b.max) ?? AGE_BANDS[AGE_BANDS.length - 1]!;
  }

  prescription(dueDate: string) {
    const prescribedOn = addDays(dueDate, 0).replace(/^\d{4}/, (y) => String(Number(y) + RECOVERY_PROCEDURE.limitationYears));
    const remaining = daysBetween(this.today(), prescribedOn);
    return {
      limitationYears: RECOVERY_PROCEDURE.limitationYears,
      startsOn: dueDate,
      prescribedOn,
      daysRemaining: remaining,
      state: remaining <= 0 ? 'ATTEINTE_A_EXAMINER' as const : remaining <= RECOVERY_PROCEDURE.limitationWarningDays ? 'PROCHE' as const : 'EN_COURS' as const,
      note: 'Calcul indicatif (délai À VÉRIFIER, actes interruptifs non paramétrés) : aucune extinction automatique — constat par décision.',
      status: 'A_VERIFIER' as const,
    };
  }

  private activePlan(obligationId: string): InstallmentPlan | undefined {
    return this.plans.findOne((p) => p.obligationId === obligationId && p.status === 'ACCORDE');
  }

  segmentOf(o: Obligation): { code: SegmentCode; label: string; approach: string; reasons: string[] } {
    const reasons: string[] = [];
    const appeal = this.ctx.appeals.openFor(o.id);
    const threshold = LARGE_DEBTOR_THRESHOLD_EXAMPLE[o.amount.currency as CurrencyCode];
    const reminders = this.notices.find((n) => n.obligationId === o.id && ['AVIS_ECHEANCE_DEPASSEE', 'RELANCE', 'AVIS_FORMEL'].includes(n.kind));
    const readReminders = reminders.filter((n) => n.readAt);
    const orders = this.ctx.payments.orders.find((p) => p.obligationId === o.id);
    const otherOverdue = this.ctx.assessment.byTaxpayer(o.taxpayerId).filter((x) => x.id !== o.id && ARREAR_STATUSES.includes(x.status) && x.dueDate < this.today());
    let code: SegmentCode;
    if (appeal || o.status === 'CONTESTEE') {
      code = 'CONTESTATION'; reasons.push('Réclamation ouverte sur l’obligation.');
    } else if (threshold && Money.fromJSON(o.amount).compare(Money.of(threshold, o.amount.currency as CurrencyCode)) >= 0) {
      code = 'GRAND_REDEVABLE'; reasons.push(`Montant ≥ seuil de démonstration ${threshold} ${o.amount.currency} [EXEMPLE].`);
    } else if (this.plans.findOne((p) => p.obligationId === o.id && ['DEMANDE', 'DEFAILLANT'].includes(p.status))) {
      code = 'CAPACITE_LIMITEE'; reasons.push('Demande d’échéancier ou échéancier défaillant.');
    } else if (orders.some((p) => p.status === 'ECHOUE' || p.status === 'INITIE') && !orders.some((p) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status))) {
      code = 'FRICTION'; reasons.push('Tentative de paiement initiée ou échouée, sans confirmation.');
    } else if (readReminders.length >= 2) {
      code = 'REFUS_PRESUME'; reasons.push(`${readReminders.length} avis lus sans régularisation — présomption à vérifier par un agent.`);
    } else if (otherOverdue.length > 0) {
      code = 'RETARD_REPETE'; reasons.push(`${otherOverdue.length} autre(s) obligation(s) échue(s) pour ce contribuable.`);
    } else {
      code = 'OUBLI'; reasons.push('Premier retard connu.');
    }
    return { code, label: SEGMENTS[code].label, approach: SEGMENTS[code].approach, reasons };
  }

  riskOf(o: Obligation, age: number): { level: 'FAIBLE' | 'MOYEN' | 'ELEVE'; score: number; factors: string[] } {
    const factors: string[] = [];
    let score = 0;
    if (age > 180) { score += 3; factors.push('Ancienneté > 180 jours'); } else if (age > 90) { score += 2; factors.push('Ancienneté > 90 jours'); } else if (age > 30) { score += 1; factors.push('Ancienneté > 30 jours'); }
    const others = this.ctx.assessment.byTaxpayer(o.taxpayerId).filter((x) => x.id !== o.id && ARREAR_STATUSES.includes(x.status) && x.dueDate < this.today()).length;
    if (others) { score += Math.min(2, others); factors.push(`${others} autre(s) créance(s) échue(s)`); }
    const read = this.notices.find((n) => n.obligationId === o.id && !!n.readAt && n.kind !== 'AVIS_IMPOSITION').length;
    if (read >= 2) { score += 1; factors.push('Avis lus sans suite'); }
    if (!this.addressValid(o.taxpayerId)) { score += 1; factors.push('Adresse de notification non vérifiée'); }
    return { level: score >= 4 ? 'ELEVE' : score >= 2 ? 'MOYEN' : 'FAIBLE', score, factors };
  }

  /**
   * Garde-fous de toute étape au-delà du rappel (§ 21.3) — évalués à la proposition ET à la décision.
   */
  measureBlockers(o: Obligation): Blocker[] {
    const b: Blocker[] = [];
    const appeal = this.ctx.appeals.openFor(o.id);
    const se = appeal?.suspensiveEffect?.status;
    if (appeal && (se === 'DEMANDE' || se === 'ACCORDE')) {
      b.push({ code: 'SUSPENSIVE_APPEAL', detail: `Réclamation ${appeal.id} avec effet suspensif ${se === 'ACCORDE' ? 'accordé' : 'demandé (en attente de décision)'} : aucune mesure.` });
    }
    if (!PAYABLE.includes(o.status) && !(o.status === 'CONTESTEE' && appeal && !b.length)) {
      b.push({ code: 'OBLIGATION_NOT_RECOVERABLE', detail: `Obligation au statut ${o.status}.` });
    }
    if (o.dueDate >= this.today()) b.push({ code: 'NOT_YET_DUE', detail: `Échéance au ${o.dueDate} non dépassée.` });
    if (!this.addressValid(o.taxpayerId)) b.push({ code: 'NO_VALID_NOTIFICATION_ADDRESS', detail: 'Adresse de notification non vérifiée : aucune mesure possible.' });
    if (this.ctx.payments.orders.find((p) => p.obligationId === o.id && (p.status === 'CONFIRME' || p.status === 'REGLE')).length) {
      b.push({ code: 'PAYMENT_IN_PROGRESS', detail: 'Paiement confirmé en cours de règlement ou de rapprochement.' });
    }
    if (this.activePlan(o.id)) b.push({ code: 'INSTALLMENT_PLAN_ACTIVE', detail: 'Échéancier en vigueur : aucune mesure tant qu’il est respecté.' });
    const rule = this.ctx.rules.rules.get(o.ruleId);
    if (rule?.status === 'SUSPENDUE') b.push({ code: 'RULE_SUSPENDED', detail: `Règle ${rule.code} v${rule.version} suspendue.` });
    if (this.prescription(o.dueDate).state === 'ATTEINTE_A_EXAMINER') b.push({ code: 'PRESCRIPTION_TO_EXAMINE', detail: 'Délai de prescription indicatif atteint : examen juridique préalable.' });
    return b;
  }

  // ── Dossiers de recouvrement ──
  caseFor(obligationId: string): RecoveryCase | undefined {
    return this.cases.findOne((c) => c.obligationId === obligationId && c.status === 'OUVERT');
  }

  getCase(id: string): RecoveryCase {
    const c = this.cases.get(id);
    if (!c) throw notFound('RECOVERY_CASE_NOT_FOUND', `Dossier inconnu : ${id}`);
    return c;
  }

  openCase(by: User | 'systeme', obligationId: string, demo = false): RecoveryCase {
    if (by !== 'systeme') authorize(by, 'recouvrement:propose');
    const o = this.ctx.assessment.get(obligationId);
    const existing = this.caseFor(o.id);
    if (existing) return existing;
    if (!ARREAR_STATUSES.includes(o.status)) throw unprocessable('OBLIGATION_NOT_RECOVERABLE', `Obligation au statut ${o.status}.`);
    const byId = by === 'systeme' ? 'systeme' : by.id;
    const c = this.cases.insert({
      id: this.ids.next('DREC', 6), obligationId: o.id, taxpayerId: o.taxpayerId, openedAt: this.nowIso(), openedBy: byId,
      status: 'OUVERT', steps: [], observations: [], ...(demo ? { demo: true } : {}),
    });
    this.ctx.audit.append({
      actor: by === 'systeme' ? { kind: 'system', id: 'recouvrement' } : this.actor(by),
      action: 'recovery.case.opened', resourceType: 'recovery_case', resourceId: c.id, details: { obligationId: o.id },
    });
    return c;
  }

  private addStep(c: RecoveryCase, step: RecoveryStep): RecoveryCase {
    const fresh = this.getCase(c.id);
    return this.cases.update({ ...fresh, steps: [...fresh.steps, step] });
  }

  private done(c: RecoveryCase, kind: StepKind): RecoveryStep | undefined {
    return c.steps.find((s) => s.kind === kind);
  }

  /** Parcours daté : étapes prévues (dates de conception) et réalisées. */
  timeline(c: RecoveryCase, o: Obligation) {
    const due = o.dueDate;
    const formal = this.done(c, 'AVIS_FORMEL');
    const demand = this.done(c, 'MISE_EN_DEMEURE');
    const planned: { kind: StepKind; plannedOn: string | null }[] = [
      { kind: 'RAPPEL_J_MOINS_15', plannedOn: addDays(due, -15) },
      { kind: 'RAPPEL_J_MOINS_3', plannedOn: addDays(due, -3) },
      { kind: 'AVIS_J_PLUS_1', plannedOn: addDays(due, RECOVERY_PROCEDURE.overdueNoticeAfterDays) },
      { kind: 'RELANCE_J_PLUS_15', plannedOn: addDays(due, RECOVERY_PROCEDURE.followUpAfterDays) },
      { kind: 'AVIS_FORMEL', plannedOn: addDays(due, RECOVERY_PROCEDURE.formalNoticeAfterDays) },
      { kind: 'MISE_EN_DEMEURE', plannedOn: formal ? addDays(formal.doneOn, RECOVERY_PROCEDURE.demandAfterFormalNoticeDays) : null },
      { kind: 'MESURE_EXECUTION', plannedOn: demand ? addDays(demand.doneOn, RECOVERY_PROCEDURE.demandResponseDays) : null },
    ];
    return planned.map((p) => {
      const s = this.done(c, p.kind);
      const pending = this.proposals.findOne((x) => x.caseId === c.id && x.kind === p.kind && x.status === 'PROPOSEE');
      return {
        kind: p.kind, label: STEP_LABELS[p.kind], plannedOn: p.plannedOn,
        status: s ? 'FAIT' : pending ? 'PROPOSEE' : p.plannedOn && p.plannedOn <= this.today() ? 'ECHUE' : 'A_VENIR',
        doneOn: s?.doneOn ?? null, noticeId: s?.noticeId ?? null, proposalId: s?.proposalId ?? pending?.id ?? null,
        requiresDecision: !REMINDER_STEPS.includes(p.kind), demoHistoric: !!s?.demoHistoric,
      };
    });
  }

  /** Préconditions propres à chaque étape proposée (en plus des garde-fous communs). */
  private stepPreconditions(c: RecoveryCase, o: Obligation, kind: ProposalKind): Blocker[] {
    const b: Blocker[] = [];
    const today = this.today();
    if (kind === 'AVIS_FORMEL') {
      if (!c.steps.some((s) => s.kind === 'AVIS_J_PLUS_1' || s.kind === 'RELANCE_J_PLUS_15')) {
        b.push({ code: 'REMINDER_REQUIRED', detail: 'Aucun rappel amiable préalable : le parcours ne commence jamais par la contrainte.' });
      }
      const from = addDays(o.dueDate, RECOVERY_PROCEDURE.formalNoticeAfterDays);
      if (today < from) b.push({ code: 'DELAY_NOT_ELAPSED', detail: `Notification formelle possible à partir du ${from}.` });
      if (this.done(c, 'AVIS_FORMEL')) b.push({ code: 'STEP_ALREADY_DONE', detail: 'Notification formelle déjà faite.' });
    } else if (kind === 'MISE_EN_DEMEURE') {
      const formal = this.done(c, 'AVIS_FORMEL');
      if (!formal) b.push({ code: 'PREVIOUS_STEP_REQUIRED', detail: 'La notification formelle doit précéder la mise en demeure.' });
      else {
        const from = addDays(formal.doneOn, RECOVERY_PROCEDURE.demandAfterFormalNoticeDays);
        if (today < from) b.push({ code: 'DELAY_NOT_ELAPSED', detail: `Mise en demeure possible à partir du ${from}.` });
      }
      if (this.done(c, 'MISE_EN_DEMEURE')) b.push({ code: 'STEP_ALREADY_DONE', detail: 'Mise en demeure déjà notifiée.' });
    } else if (kind === 'MESURE_EXECUTION') {
      const demand = this.done(c, 'MISE_EN_DEMEURE');
      if (!demand) b.push({ code: 'PREVIOUS_STEP_REQUIRED', detail: 'Une mise en demeure notifiée doit précéder toute mesure.' });
      else {
        const from = addDays(demand.doneOn, RECOVERY_PROCEDURE.demandResponseDays);
        if (today < from) b.push({ code: 'DELAY_NOT_ELAPSED', detail: `Délai de la mise en demeure (paiement ou observations) ouvert jusqu’au ${from}.` });
      }
    }
    return b;
  }

  /** Prochaine étape suggérée au dossier (le système ne l'exécute pas). */
  nextStep(c: RecoveryCase, o: Obligation): { kind: StepKind | null; label: string; eligible: boolean; blockers: Blocker[] } {
    if (c.status !== 'OUVERT') return { kind: null, label: 'Dossier clos', eligible: false, blockers: [] };
    const order: ProposalKind[] = ['AVIS_FORMEL', 'MISE_EN_DEMEURE', 'MESURE_EXECUTION'];
    if (!this.done(c, 'AVIS_J_PLUS_1') && o.dueDate < this.today()) {
      return { kind: 'AVIS_J_PLUS_1', label: STEP_LABELS.AVIS_J_PLUS_1, eligible: true, blockers: [] };
    }
    const kind = order.find((k) => !this.done(c, k));
    if (!kind) return { kind: null, label: 'Mesure décidée : suivi jusqu’à régularisation ou levée', eligible: false, blockers: [] };
    const blockers = [...this.measureBlockers(o), ...this.stepPreconditions(c, o, kind)];
    return { kind, label: STEP_LABELS[kind], eligible: blockers.length === 0, blockers };
  }

  caseView(c: RecoveryCase) {
    const o = this.ctx.assessment.get(c.obligationId);
    return {
      ...c,
      obligation: { id: o.id, label: o.label, amount: o.amount, dueDate: o.dueDate, status: o.status, ruleCode: o.ruleCode, commune: o.attribution?.commune ?? null },
      timeline: this.timeline(c, o),
      nextStep: this.nextStep(c, o),
      proposals: this.proposals.find((p) => p.caseId === c.id),
      notices: this.notices.find((n) => n.caseId === c.id).map((n) => ({ id: n.id, kind: n.kind, issuedAt: n.issuedAt, readAt: n.readAt ?? null, notification: n.notification })),
      addressValid: this.addressValid(c.taxpayerId),
    };
  }

  /** Rappel amiable exécuté par un agent (niveau « rappel » : aucune décision requise). */
  manualReminder(user: User, caseId: string): RecoveryCase {
    authorize(user, 'recouvrement:propose');
    const c = this.getCase(caseId);
    if (c.status !== 'OUVERT') throw conflict('CASE_CLOSED', 'Dossier clos.');
    const o = this.ctx.assessment.get(c.obligationId);
    const sent = this.sendNextReminder(c, o, user.id, true);
    if (!sent) throw conflict('NO_REMINDER_DUE', 'Aucun rappel dû à ce stade (rappels déjà faits ou écart minimal non écoulé).');
    return this.getCase(caseId);
  }

  /** Envoie le prochain rappel amiable applicable (jamais deux étapes d'un coup). Retourne l'étape envoyée. */
  private sendNextReminder(c: RecoveryCase, o: Obligation, by: string, manual = false): StepKind | null {
    const today = this.today();
    const toDue = daysBetween(today, o.dueDate);
    const last = [...c.steps].filter((s) => REMINDER_STEPS.includes(s.kind)).sort((a, b) => b.doneOn.localeCompare(a.doneOn))[0];
    const gapOk = !last || daysBetween(last.doneOn, today) >= RECOVERY_PROCEDURE.minGapDays;
    let kind: StepKind | null = null;
    let notice: NoticeKind = 'RAPPEL';
    let body: string[] = [];
    if (toDue > 3 && toDue <= RECOVERY_PROCEDURE.reminderBeforeDays[0] && !this.done(c, 'RAPPEL_J_MOINS_15')) {
      kind = 'RAPPEL_J_MOINS_15'; body = [`Votre obligation ${o.id} arrive à échéance le ${o.dueDate}.`, 'Aucune pénalité n’est appliquée à ce stade.'];
    } else if (toDue > 0 && toDue <= RECOVERY_PROCEDURE.reminderBeforeDays[1] && !this.done(c, 'RAPPEL_J_MOINS_3')) {
      kind = 'RAPPEL_J_MOINS_3'; body = [`Votre obligation ${o.id} arrive à échéance le ${o.dueDate}.`, 'Aucune pénalité n’est appliquée à ce stade.'];
    } else if (toDue <= -RECOVERY_PROCEDURE.overdueNoticeAfterDays && !this.done(c, 'AVIS_J_PLUS_1')) {
      kind = 'AVIS_J_PLUS_1'; notice = 'AVIS_ECHEANCE_DEPASSEE';
      body = [`L’échéance du ${o.dueDate} de l’obligation ${o.id} est dépassée.`, 'Votre référence de paiement reste valable ; vous pouvez régulariser depuis votre espace ou un point agréé.'];
    } else if (toDue <= -RECOVERY_PROCEDURE.followUpAfterDays && this.done(c, 'AVIS_J_PLUS_1') && gapOk && !this.done(c, 'RELANCE_J_PLUS_15')) {
      kind = 'RELANCE_J_PLUS_15'; notice = 'RELANCE';
      body = [`L’obligation ${o.id} reste impayée depuis le ${o.dueDate}.`, 'Un agent peut vous assister (guichet, appel, visite d’information). Si un acte l’autorise, un échéancier peut être demandé depuis votre espace.', 'Aucune sanction n’est prise à ce stade.'];
    }
    if (!kind) return null;
    if (!manual && !gapOk && kind !== 'RAPPEL_J_MOINS_15') return null;
    const n = this.issueNotice(notice, o, { by, caseId: c.id, body });
    this.addStep(c, { kind, doneOn: today, at: this.nowIso(), by, noticeId: n.id });
    return kind;
  }

  /**
   * Planification (tâche quotidienne sur l'heure serveur) : constat de retard (EN_RETARD), rappels amiables datés,
   * proposition de levée dès régularisation, suivi des délais de recours. Idempotente. Aucune mesure.
   */
  runSchedule(by: User | 'systeme') {
    if (by !== 'systeme') authorize(by, 'recouvrement:schedule');
    const today = this.today();
    const out = { remindersSent: [] as { obligationId: string; step: StepKind }[], overdueRecorded: 0, casesOpened: 0, casesRegularised: 0, liftProposed: 0, installmentReminders: 0, appealSlaBreaches: [] as string[] };
    for (const o0 of this.ctx.assessment.obligations.all()) {
      let o = o0;
      if (!PAYABLE.includes(o.status) || this.activePlan(o.id)) continue;
      const toDue = daysBetween(today, o.dueDate);
      if (toDue > RECOVERY_PROCEDURE.reminderBeforeDays[0]) continue;
      if (toDue < 0 && (o.status === 'EMISE' || o.status === 'EXIGIBLE')) {
        o = this.ctx.assessment.setStatus(o.id, 'EN_RETARD');
        out.overdueRecorded++;
        this.ctx.audit.append({ actor: { kind: 'system', id: 'recouvrement' }, action: 'obligation.overdue.recorded', resourceType: 'obligation', resourceId: o.id, details: { dueDate: o.dueDate } });
      }
      let c = this.caseFor(o.id);
      if (!c) { c = this.openCase('systeme', o.id); out.casesOpened++; }
      const step = this.sendNextReminder(c, o, 'systeme');
      if (step) out.remindersSent.push({ obligationId: o.id, step });
    }
    // Régularisation : dossier clos ; si une mesure a été décidée, la levée est PROPOSÉE (décision R21).
    for (const c of this.cases.find((x) => x.status === 'OUVERT')) {
      const o = this.ctx.assessment.obligations.get(c.obligationId);
      if (!o || (o.status !== 'SOLDEE' && o.status !== 'ANNULEE')) continue;
      const measure = this.done(c, 'MESURE_EXECUTION');
      if (measure && !this.done(c, 'LEVEE')) {
        if (!this.proposals.findOne((p) => p.caseId === c.id && p.kind === 'LEVEE' && p.status === 'PROPOSEE')) {
          this.proposals.insert({
            id: this.ids.next('PROP', 6), caseId: c.id, obligationId: c.obligationId, taxpayerId: c.taxpayerId, kind: 'LEVEE',
            motivation: `Régularisation constatée (obligation ${o.status}) : levée de la mesure proposée.`, proposedBy: 'systeme', proposedAt: this.nowIso(), status: 'PROPOSEE',
          });
          out.liftProposed++;
        }
        continue;
      }
      this.cases.update({ ...c, status: 'REGULARISE' });
      out.casesRegularised++;
    }
    // Échéanciers : rappel amiable avant chaque échéance non payée (jamais de sanction).
    for (const plan of this.plans.find((p) => p.status === 'ACCORDE')) {
      const view = this.planView(plan);
      const due = view.rows.filter((r) => r.state === 'A_ECHOIR' && daysBetween(today, r.dueDate) <= RECOVERY_PROCEDURE.reminderBeforeDays[1] && !(plan.remindedSeqs ?? []).includes(r.seq));
      if (!due.length) continue;
      this.ctx.comms.publish('installment_plan.installment_due', [taxpayerRecipient(this.ctx.taxpayers.get(plan.taxpayerId))], { reference: plan.id, date: due[0]!.dueDate }, { entity: 'DGIPK' });
      this.plans.update({ ...plan, remindedSeqs: [...(plan.remindedSeqs ?? []), ...due.map((r) => r.seq)] });
      out.installmentReminders++;
    }
    out.appealSlaBreaches = this.ctx.appeals.sweepDeadlines(this.ctx.users);
    this.ctx.audit.append({ actor: by === 'systeme' ? { kind: 'system', id: 'recouvrement' } : this.actor(by), action: 'recovery.schedule.run', resourceType: 'recovery', details: { ...out, remindersSent: out.remindersSent.length } });
    return out;
  }

  /** Proposition motivée d'une étape au-delà du rappel (agent de recouvrement R20). */
  propose(user: User, caseId: string, input: { kind: ProposalKind; motivation: string; legalBasis?: { instrumentId: string; article: string }; measureType?: string }): RecoveryProposal {
    authorize(user, 'recouvrement:propose');
    const c = this.getCase(caseId);
    if (c.status !== 'OUVERT') throw conflict('CASE_CLOSED', 'Dossier clos.');
    if (this.proposals.findOne((p) => p.caseId === c.id && p.status === 'PROPOSEE')) throw conflict('PROPOSAL_PENDING', 'Une proposition attend déjà une décision sur ce dossier.');
    const o = this.ctx.assessment.get(c.obligationId);
    let legalBasis: RecoveryProposal['legalBasis'];
    if (input.kind === 'MISE_EN_DEMEURE' || input.kind === 'MESURE_EXECUTION') {
      if (!input.legalBasis) throw unprocessable('LEGAL_BASIS_REQUIRED', 'Mise en demeure et mesures d’exécution : base légale (instrument et article) obligatoire.');
      const inst = this.ctx.rules.instrument(input.legalBasis.instrumentId);
      if (!inst) throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument inconnu du registre : ${input.legalBasis.instrumentId}`);
      if (inst.status !== 'EN_VIGUEUR' && inst.status !== 'MODIFIE') {
        throw unprocessable('INSTRUMENT_NOT_IN_FORCE', `L’instrument ${inst.id} n’est pas certifié en vigueur (${inst.status}) : procédure non autorisée.`, { instrumentId: inst.id });
      }
      legalBasis = { instrumentId: inst.id, title: inst.title, article: input.legalBasis.article };
    }
    if (input.kind === 'MESURE_EXECUTION' && !input.measureType?.trim()) throw badRequest('MEASURE_TYPE_REQUIRED', 'Nature de la mesure prévue par l’acte obligatoire.');
    if (input.kind === 'LEVEE' && !this.done(c, 'MESURE_EXECUTION')) throw conflict('NO_MEASURE_TO_LIFT', 'Aucune mesure décidée à lever.');
    if (input.kind !== 'LEVEE' && input.kind !== 'CLASSEMENT') {
      const blockers = [...this.measureBlockers(o), ...this.stepPreconditions(c, o, input.kind)];
      if (blockers.length) {
        this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.proposal.blocked', resourceType: 'recovery_case', resourceId: c.id, outcome: 'DENIED', details: { kind: input.kind, blockers: blockers.map((x) => x.code) } });
        throw unprocessable(blockers[0]!.code, blockers.map((x) => x.detail).join(' '), { blockers });
      }
    }
    const p = this.proposals.insert({
      id: this.ids.next('PROP', 6), caseId: c.id, obligationId: o.id, taxpayerId: o.taxpayerId, kind: input.kind, motivation: input.motivation,
      ...(legalBasis ? { legalBasis } : {}), ...(input.measureType ? { measureType: input.measureType.trim() } : {}),
      proposedBy: user.id, proposedAt: this.nowIso(), status: 'PROPOSEE',
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.proposal.created', resourceType: 'recovery_case', resourceId: c.id, details: { proposalId: p.id, kind: p.kind } });
    this.ctx.comms.publish('approval.requested', this.ctx.users.withRole('R21').map(userRecipient), { objet: `${STEP_LABELS[p.kind]} — ${o.id}` }, { entity: o.entity });
    // Droit d'être entendu : le contribuable est informé dès qu'une mesure est envisagée.
    if (p.kind === 'MESURE_EXECUTION') {
      const n = this.issueNotice('MESURE_ENVISAGEE', o, {
        by: user.id, caseId: c.id,
        body: [
          `Une mesure d’exécution (${p.measureType}) est envisagée pour l’obligation ${o.id}. Elle n’est pas décidée.`,
          'Vous pouvez présenter vos observations depuis votre espace avant toute décision, régulariser ou contester.',
        ],
      });
      this.proposals.update({ ...p, noticeId: n.id });
    }
    return this.proposals.get(p.id)!;
  }

  /** Décision motivée d'une autorité distincte (R21) : seule une décision APPROUVEE produit l'étape. */
  decide(user: User, proposalId: string, input: { decision: 'APPROUVEE' | 'REJETEE'; motivation: string }): RecoveryProposal {
    authorize(user, 'recouvrement:decide');
    const p = this.proposals.get(proposalId);
    if (!p) throw notFound('PROPOSAL_NOT_FOUND', `Proposition inconnue : ${proposalId}`);
    if (p.status !== 'PROPOSEE') throw conflict('PROPOSAL_ALREADY_DECIDED', `Proposition déjà ${p.status === 'APPROUVEE' ? 'approuvée' : 'rejetée'}.`);
    assertDistinctPerson(user.id, [p.proposedBy], 'La décision appartient à une autorité distincte de l’agent qui propose.');
    const c = this.getCase(p.caseId);
    const o = this.ctx.assessment.get(p.obligationId);
    const now = this.nowIso();
    if (input.decision === 'APPROUVEE' && p.kind !== 'LEVEE' && p.kind !== 'CLASSEMENT') {
      const blockers = [...this.measureBlockers(o), ...this.stepPreconditions(c, o, p.kind)];
      if (blockers.length) {
        this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.decision.blocked', resourceType: 'recovery_case', resourceId: c.id, outcome: 'DENIED', details: { proposalId, blockers: blockers.map((x) => x.code) } });
        throw unprocessable(blockers[0]!.code, blockers.map((x) => x.detail).join(' '), { blockers });
      }
    }
    const decision = { decision: input.decision, by: user.id, at: now, motivation: input.motivation };
    let updated = this.proposals.update({ ...p, status: input.decision, decision });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.proposal.decided', resourceType: 'recovery_case', resourceId: c.id, details: { proposalId, kind: p.kind, decision: input.decision, motivation: input.motivation } });
    if (input.decision === 'REJETEE') return updated;

    const today = this.today();
    const noticeDecision = { by: user.id, at: now, motivation: input.motivation, ...(p.legalBasis ? { legalBasis: p.legalBasis } : {}) };
    let notice: LegalNotice | undefined;
    if (p.kind === 'AVIS_FORMEL') {
      notice = this.issueNotice('AVIS_FORMEL', o, {
        by: user.id, caseId: c.id, decision: noticeDecision,
        body: [
          `Il est constaté que l’obligation ${o.id} (${o.amount.amount} ${o.amount.currency}) reste impayée depuis le ${o.dueDate}.`,
          `Motivation : ${input.motivation}`,
          'Vous pouvez régulariser, demander un échéancier si un acte l’autorise, ou contester dans le délai indiqué.',
        ],
      });
    } else if (p.kind === 'MISE_EN_DEMEURE') {
      notice = this.issueNotice('MISE_EN_DEMEURE', o, {
        by: user.id, caseId: c.id, decision: noticeDecision, dueDate: addDays(today, RECOVERY_PROCEDURE.demandResponseDays),
        body: [
          `Vous êtes mis en demeure de régler l’obligation ${o.id} au plus tard à la date d’échéance indiquée.`,
          `Fondement : ${p.legalBasis?.title} — ${p.legalBasis?.article}. Motivation : ${input.motivation}`,
          'Dans ce délai, vous pouvez payer, présenter vos observations ou contester. Aucune mesure ne peut être décidée avant son expiration.',
        ],
      });
    } else if (p.kind === 'MESURE_EXECUTION') {
      notice = this.issueNotice('DECISION_MESURE', o, {
        by: user.id, caseId: c.id, decision: noticeDecision,
        body: [
          `Décision : ${p.measureType}, pour l’obligation ${o.id}.`,
          `Fondement : ${p.legalBasis?.title} — ${p.legalBasis?.article}. Motivation : ${input.motivation}`,
          'L’exécution relève du service légalement compétent. La mesure est levée dès régularisation. Cette décision est susceptible de recours.',
        ],
      });
    } else if (p.kind === 'LEVEE') {
      notice = this.issueNotice('LEVEE_MESURE', o, { by: user.id, caseId: c.id, decision: noticeDecision, body: [`La mesure prise pour l’obligation ${o.id} est levée. Motivation : ${input.motivation}`] });
    }
    const stepKind: StepKind = p.kind;
    this.addStep(c, { kind: stepKind, doneOn: today, at: now, by: user.id, proposalId: p.id, ...(notice ? { noticeId: notice.id } : {}) });
    if (p.kind === 'CLASSEMENT' || p.kind === 'LEVEE') {
      const fresh = this.getCase(c.id);
      this.cases.update({ ...fresh, status: p.kind === 'CLASSEMENT' ? 'CLASSE' : 'REGULARISE' });
    }
    if (notice) updated = this.proposals.update({ ...updated, noticeId: notice.id });
    return updated;
  }

  addObservation(user: User, caseId: string, text: string): RecoveryCase {
    const c = this.getCase(caseId);
    authorize(user, 'recouvrement:observations', { taxpayerId: c.taxpayerId });
    const updated = this.cases.update({ ...c, observations: [...c.observations, { at: this.nowIso(), by: user.id, text }] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.observations.recorded', resourceType: 'recovery_case', resourceId: caseId, details: { length: text.length } });
    return updated;
  }

  // ── Arriérés (balance âgée, segmentation, prescription) ──
  arrearView(o: Obligation, full: boolean) {
    const today = this.today();
    const age = Math.max(0, daysBetween(o.dueDate, today));
    const band = this.ageBand(age);
    const c = this.caseFor(o.id) ?? this.cases.find((x) => x.obligationId === o.id).at(-1);
    const rule = this.ctx.rules.rules.get(o.ruleId);
    const base = {
      obligationId: o.id, taxpayerId: o.taxpayerId, label: o.label, revenueCategory: o.revenueCategory, ruleCode: o.ruleCode,
      entity: o.entity, commune: o.attribution?.commune ?? null, amount: o.amount, dueDate: o.dueDate, ageDays: age,
      ageBand: band.code, status: o.status, prescription: this.prescription(o.dueDate),
      legalBasis: o.explanation.legalBasis, caseId: c?.id ?? null, plan: this.plans.find((p) => p.obligationId === o.id).at(-1) ?? null,
      demo: !!rule?.demo,
    };
    if (!full) return base;
    const blockers = this.measureBlockers(o);
    return {
      ...base,
      segment: this.segmentOf(o),
      risk: this.riskOf(o, age),
      recoverability: { addressValid: this.addressValid(o.taxpayerId), blockers },
      nextStep: c ? this.nextStep(c, o) : null,
      /** La segmentation et le profil de risque n'ont aucun effet : ils orientent la proposition d'un agent. */
      automaticDecision: false as const,
    };
  }

  arrears(filter: { segment?: string; commune?: string; revenueCategory?: string; taxpayerId?: string } = {}) {
    const today = this.today();
    const items = this.ctx.assessment.obligations
      .find((o) => ARREAR_STATUSES.includes(o.status) && o.dueDate < today && (!filter.taxpayerId || o.taxpayerId === filter.taxpayerId))
      .map((o) => this.arrearView(o, true) as ReturnType<RecoveryService['arrearView']> & { segment: { code: string } })
      .filter((a) => (!filter.segment || a.segment.code === filter.segment) && (!filter.commune || a.commune === filter.commune) && (!filter.revenueCategory || a.revenueCategory === filter.revenueCategory))
      .sort((a, b) => b.ageDays - a.ageDays);
    return { asOf: today, items, balance: this.balance(items), takeovers: this.takeovers.find((t) => t.status === 'VALIDEE') };
  }

  /** Balance âgée : totaux par devise (jamais additionnés entre devises). */
  balance(items: { amount: MoneyJSON; ageBand: string; revenueCategory: string; commune: string | null; segment?: { code: string } }[]) {
    const add = (acc: Record<string, Record<string, string>>, key: string, m: MoneyJSON) => {
      const bucket = (acc[key] ??= {});
      bucket[m.currency] = Money.fromJSON({ amount: bucket[m.currency] ?? '0', currency: m.currency }).add(Money.fromJSON(m)).toDecimalString();
    };
    const byBand: Record<string, Record<string, string>> = {};
    const byCategory: Record<string, Record<string, string>> = {};
    const byCommune: Record<string, Record<string, string>> = {};
    const bySegment: Record<string, number> = {};
    const total: Record<string, Record<string, string>> = {};
    for (const i of items) {
      add(byBand, i.ageBand, i.amount);
      add(byCategory, i.revenueCategory, i.amount);
      add(byCommune, i.commune ?? 'NON_ATTRIBUE', i.amount);
      add(total, 'total', i.amount);
      if (i.segment) bySegment[i.segment.code] = (bySegment[i.segment.code] ?? 0) + 1;
    }
    return { count: items.length, total: total.total ?? {}, byBand, byCategory, byCommune, bySegment, bands: AGE_BANDS.map((b) => ({ code: b.code, label: b.label })) };
  }

  /** Vue contribuable : ses arriérés et échéances, sans segment ni profil de risque (minimisation). */
  mine(taxpayerIds: string[]) {
    const today = this.today();
    const obligations = this.ctx.assessment.obligations.find((o) => taxpayerIds.includes(o.taxpayerId));
    const arrears = obligations.filter((o) => ARREAR_STATUSES.includes(o.status) && o.dueDate < today).map((o) => {
      const c = this.caseFor(o.id);
      return {
        ...this.arrearView(o, false),
        steps: c ? c.steps.map((s) => ({ kind: s.kind, label: STEP_LABELS[s.kind], doneOn: s.doneOn, noticeId: s.noticeId ?? null })) : [],
        pendingMeasure: c ? this.proposals.find((p) => p.caseId === c.id && p.status === 'PROPOSEE' && p.kind === 'MESURE_EXECUTION').map((p) => ({ id: p.id, measureType: p.measureType, proposedAt: p.proposedAt })) : [],
        caseId: c?.id ?? null,
      };
    });
    const upcoming = obligations.filter((o) => PAYABLE.includes(o.status) && o.dueDate >= today).map((o) => ({ obligationId: o.id, label: o.label, amount: o.amount, dueDate: o.dueDate, status: o.status, daysToDue: daysBetween(today, o.dueDate) }));
    return {
      asOf: today,
      arrears,
      upcoming,
      notices: this.listNotices({ taxpayerIds }).map((n) => ({ id: n.id, number: n.number, kind: n.kind, title: n.content.title, issuedAt: n.issuedAt, readAt: n.readAt ?? null, obligationId: n.obligationId, demo: n.demo })),
      plans: this.plans.find((p) => taxpayerIds.includes(p.taxpayerId)).map((p) => this.planView(p)),
      planBasis: this.planBasis(),
      procedure: { ...RECOVERY_PROCEDURE },
    };
  }

  // ── Échéanciers ──
  planBasis(): { available: boolean; instrumentId?: string; title?: string; demo?: boolean; detail: string } {
    const id = this.planLegalBasisInstrumentId;
    const inst = id ? this.ctx.rules.instrument(id) : undefined;
    if (!inst || (inst.status !== 'EN_VIGUEUR' && inst.status !== 'MODIFIE')) {
      return { available: false, detail: 'Acte requis : aucun instrument en vigueur n’autorise les échéanciers de paiement.' };
    }
    return { available: true, instrumentId: inst.id, title: inst.title, demo: !!inst.demo, detail: inst.demo ? 'Instrument FICTIF de démonstration — aucune valeur juridique.' : 'Instrument en vigueur.' };
  }

  requestPlan(user: User, input: { obligationId: string; installments: number; reason: string }): InstallmentPlan {
    const o = this.ctx.assessment.get(input.obligationId);
    authorize(user, 'recouvrement:plan.request', { taxpayerId: o.taxpayerId });
    const basis = this.planBasis();
    if (!basis.available) throw unprocessable('ACTE_REQUIS', basis.detail);
    if (!PAYABLE.includes(o.status)) throw unprocessable('OBLIGATION_NOT_PAYABLE', `Obligation au statut ${o.status}.`);
    if (this.plans.findOne((p) => p.obligationId === o.id && (p.status === 'DEMANDE' || p.status === 'ACCORDE'))) throw conflict('PLAN_ALREADY_OPEN', 'Un échéancier est déjà demandé ou en vigueur pour cette obligation.');
    if (input.installments < 2 || input.installments > RECOVERY_PROCEDURE.maxInstallments) {
      throw badRequest('INVALID_INSTALLMENT_COUNT', `Nombre d’échéances entre 2 et ${RECOVERY_PROCEDURE.maxInstallments} (valeur de conception À VÉRIFIER).`);
    }
    const plan = this.plans.insert({
      id: this.ids.next('ECH', 6), taxpayerId: o.taxpayerId, obligationId: o.id, requestedBy: user.id, requestedAt: this.nowIso(),
      requestedCount: input.installments, reason: input.reason,
      legalBasis: { instrumentId: basis.instrumentId!, title: basis.title!, demo: !!basis.demo },
      status: 'DEMANDE', installments: [],
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'installment_plan.requested', resourceType: 'installment_plan', resourceId: plan.id, details: { obligationId: o.id, installments: input.installments } });
    return plan;
  }

  /** Découpage exact en unités mineures ; le reliquat va à la dernière échéance. */
  static split(total: MoneyJSON, n: number, firstDue: string, periodDays: number) {
    const m = Money.fromJSON(total);
    const base = m.minor / BigInt(n);
    const rest = m.minor - base * BigInt(n);
    return Array.from({ length: n }, (_, i) => ({
      seq: i + 1,
      dueDate: addDays(firstDue, i * periodDays),
      amount: Money.fromMinor(base + (i === n - 1 ? rest : 0n), m.currency).toJSON(),
    }));
  }

  decidePlan(user: User, id: string, input: { granted: boolean; motivation: string; installments?: number }): InstallmentPlan {
    authorize(user, 'recouvrement:plan.decide');
    const plan = this.plans.get(id);
    if (!plan) throw notFound('PLAN_NOT_FOUND', `Échéancier inconnu : ${id}`);
    if (plan.status !== 'DEMANDE') throw conflict('PLAN_ALREADY_DECIDED', `Échéancier au statut ${plan.status}.`);
    assertDistinctPerson(user.id, [plan.requestedBy], 'La décision sur un échéancier appartient à une personne distincte du demandeur.');
    const o = this.ctx.assessment.get(plan.obligationId);
    const now = this.nowIso();
    if (!input.granted) {
      const refused = this.plans.update({ ...plan, status: 'REFUSE', decision: { by: user.id, at: now, motivation: input.motivation, granted: false } });
      this.ctx.audit.append({ actor: this.actor(user), action: 'installment_plan.refused', resourceType: 'installment_plan', resourceId: id, details: { motivation: input.motivation } });
      return refused;
    }
    if (!PAYABLE.includes(o.status)) throw unprocessable('OBLIGATION_NOT_PAYABLE', `Obligation au statut ${o.status}.`);
    const n = input.installments ?? plan.requestedCount;
    if (n < 2 || n > RECOVERY_PROCEDURE.maxInstallments) throw badRequest('INVALID_INSTALLMENT_COUNT', `Nombre d’échéances entre 2 et ${RECOVERY_PROCEDURE.maxInstallments}.`);
    const installments = RecoveryService.split(o.amount, n, addDays(this.today(), RECOVERY_PROCEDURE.installmentPeriodDays), RECOVERY_PROCEDURE.installmentPeriodDays);
    let updated = this.plans.update({ ...plan, status: 'ACCORDE', installments, decision: { by: user.id, at: now, motivation: input.motivation, granted: true } });
    const notice = this.issueNotice('ECHEANCIER', o, {
      by: user.id, planId: id, installments, dueDate: installments[installments.length - 1]!.dueDate,
      decision: { by: user.id, at: now, motivation: input.motivation },
      body: [
        `Un échéancier de ${n} échéances est accordé pour l’obligation ${o.id}.`,
        `Fondement : ${plan.legalBasis.title}.`,
        'Tant que l’échéancier est respecté, aucune mesure de recouvrement ne peut être engagée.',
      ],
    });
    updated = this.plans.update({ ...updated, noticeId: notice.id });
    this.ctx.audit.append({ actor: this.actor(user), action: 'installment_plan.granted', resourceType: 'installment_plan', resourceId: id, details: { installments: n, motivation: input.motivation } });
    return updated;
  }

  /** Suivi : les paiements confirmés par le circuit commun sont imputés dans l'ordre des échéances. */
  planView(plan: InstallmentPlan) {
    const today = this.today();
    const o = this.ctx.assessment.obligations.get(plan.obligationId);
    const currency = (o?.amount.currency ?? 'USD') as CurrencyCode;
    let paid = Money.zero(currency);
    for (const p of this.ctx.payments.orders.find((x) => x.obligationId === plan.obligationId && ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(x.status))) {
      if (p.amount.currency === currency) paid = paid.add(Money.fromJSON(p.amount));
    }
    let remaining = paid;
    const rows = plan.installments.map((i) => {
      const amt = Money.fromJSON(i.amount);
      let state: 'PAYEE' | 'A_ECHOIR' | 'ECHUE_IMPAYEE';
      if (remaining.compare(amt) >= 0) { state = 'PAYEE'; remaining = remaining.subtract(amt); } else state = i.dueDate < today ? 'ECHUE_IMPAYEE' : 'A_ECHOIR';
      return { ...i, state };
    });
    const overdue = rows.filter((r) => r.state === 'ECHUE_IMPAYEE' && daysBetween(r.dueDate, today) > RECOVERY_PROCEDURE.installmentGraceDays);
    return {
      ...plan,
      rows,
      paid: paid.toJSON(),
      nextDue: rows.find((r) => r.state !== 'PAYEE') ?? null,
      /** Signal seulement : la défaillance est constatée par une personne habilitée. */
      defaultToExamine: plan.status === 'ACCORDE' && overdue.length > 0,
    };
  }

  recordDefault(user: User, id: string, motivation: string): InstallmentPlan {
    authorize(user, 'recouvrement:plan.default');
    const plan = this.plans.get(id);
    if (!plan) throw notFound('PLAN_NOT_FOUND', `Échéancier inconnu : ${id}`);
    if (plan.status !== 'ACCORDE') throw conflict('PLAN_NOT_ACTIVE', `Échéancier au statut ${plan.status}.`);
    const view = this.planView(plan);
    if (!view.defaultToExamine) {
      throw unprocessable('NO_OVERDUE_INSTALLMENT', `Aucune échéance impayée au-delà du délai de grâce (${RECOVERY_PROCEDURE.installmentGraceDays} jours) : défaillance non constatable.`);
    }
    const updated = this.plans.update({ ...plan, status: 'DEFAILLANT', defaultRecord: { by: user.id, at: this.nowIso(), motivation } });
    this.ctx.audit.append({ actor: this.actor(user), action: 'installment_plan.default.recorded', resourceType: 'installment_plan', resourceId: id, details: { motivation } });
    this.ctx.comms.publish('installment_plan.defaulted', [taxpayerRecipient(this.ctx.taxpayers.get(plan.taxpayerId))], { reference: id }, { entity: 'DGIPK' });
    return updated;
  }

  // ── Reprise d'arriérés historiques (§ 6.3 pt 2) ──
  proposeTakeover(user: User, input: {
    taxpayerId: string; objectId?: string; fiscalYear: number; revenueLabel: string; amount: MoneyJSON;
    instrumentIds: string[]; articles: string[]; legalOpinionRef: string; interruptionActRef?: string;
  }): ArrearTakeover {
    authorize(user, 'recouvrement:takeover.propose');
    this.ctx.taxpayers.get(input.taxpayerId);
    if (input.objectId) this.ctx.objects.get(input.objectId);
    const yearStart = `${input.fiscalYear}-01-01`;
    const instruments = input.instrumentIds.map((id) => {
      const inst = this.ctx.rules.instrument(id);
      if (!inst) throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument inconnu du registre : ${id}`);
      if (inst.status === 'A_VERIFIER') throw unprocessable('INSTRUMENT_NOT_CERTIFIED', `L’instrument ${id} n’est pas certifié (À VÉRIFIER) : reprise impossible.`, { instrumentId: id });
      if (inst.status === 'ABROGE' && inst.abrogatedOn && yearStart >= inst.abrogatedOn) {
        throw unprocessable('ORIGINAL_BASIS_NOT_APPLICABLE', `L’exercice ${input.fiscalYear} est postérieur à l’abrogation de ${id} (${inst.abrogatedOn}) : cette base légale ne peut fonder la créance.`, { instrumentId: id });
      }
      return { id: inst.id, title: inst.title, status: inst.status, ...(inst.abrogatedOn ? { abrogatedOn: inst.abrogatedOn } : {}) };
    });
    const prescribedOn = `${input.fiscalYear + 1 + RECOVERY_PROCEDURE.limitationYears}-01-01`;
    const reached = this.today() >= prescribedOn;
    if (reached && !input.interruptionActRef) {
      throw unprocessable('ARREAR_PRESCRIBED', `Prescription indicative atteinte le ${prescribedOn} (délai À VÉRIFIER) : reprise impossible sans acte interruptif référencé.`, { prescribedOn });
    }
    const t = this.takeovers.insert({
      id: this.ids.next('REP', 6), taxpayerId: input.taxpayerId, ...(input.objectId ? { objectId: input.objectId } : {}),
      fiscalYear: input.fiscalYear, revenueLabel: input.revenueLabel, amount: Money.fromJSON(input.amount).toJSON(),
      originalLegalBasis: { instrumentIds: input.instrumentIds, articles: input.articles, instruments },
      legalOpinionRef: input.legalOpinionRef, ...(input.interruptionActRef ? { interruptionActRef: input.interruptionActRef } : {}),
      prescription: { prescribedOn, reached, interrupted: !!input.interruptionActRef, status: 'A_VERIFIER' },
      proposedBy: user.id, proposedAt: this.nowIso(), status: 'PROPOSEE',
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.takeover.proposed', resourceType: 'arrear_takeover', resourceId: t.id, details: { fiscalYear: t.fiscalYear, instrumentIds: input.instrumentIds, legalOpinionRef: input.legalOpinionRef } });
    return t;
  }

  validateTakeover(user: User, id: string, input: { decision: 'VALIDEE' | 'REJETEE'; motivation: string }): ArrearTakeover {
    authorize(user, 'recouvrement:takeover.validate');
    const t = this.takeovers.get(id);
    if (!t) throw notFound('TAKEOVER_NOT_FOUND', `Reprise inconnue : ${id}`);
    if (t.status !== 'PROPOSEE') throw conflict('TAKEOVER_ALREADY_DECIDED', `Reprise au statut ${t.status}.`);
    assertDistinctPerson(user.id, [t.proposedBy], 'La validation d’une reprise appartient à une personne distincte de l’auteur de la proposition.');
    const updated = this.takeovers.update({ ...t, status: input.decision, decision: { by: user.id, at: this.nowIso(), motivation: input.motivation } });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.takeover.decided', resourceType: 'arrear_takeover', resourceId: id, details: { decision: input.decision, motivation: input.motivation } });
    return updated;
  }

  // ── Pénalités : règle ACTIVE (catégorie PENALITE) + décision humaine + liquidation par le circuit commun ──
  proposePenalty(user: User, input: { obligationId: string; penaltyRuleId: string; inputs: Record<string, string>; motivation: string }): PenaltyProposal {
    authorize(user, 'recouvrement:penalty.propose');
    const o = this.ctx.assessment.get(input.obligationId);
    const rule = this.ctx.rules.get(input.penaltyRuleId);
    if (rule.revenueCategory !== 'PENALITE') throw unprocessable('NOT_A_PENALTY_RULE', `La règle ${rule.code} n’est pas une règle de pénalité.`);
    const exec = isRuleExecutable(rule, this.ctx.clock.now());
    if (!exec.ok) throw unprocessable('PENALTY_RULE_NOT_ACTIVE', `Aucune pénalité hors règle ACTIVE : ${rule.code} v${rule.version} — ${exec.reason}.`, { ruleStatus: rule.status });
    const blockers = this.measureBlockers(o);
    if (blockers.length) throw unprocessable(blockers[0]!.code, blockers.map((b) => b.detail).join(' '), { blockers });
    const object = this.ctx.objects.get(o.objectId);
    const ev = this.ctx.rules.evaluate(rule, input.inputs, object.localityRank);
    const p = this.penalties.insert({
      id: this.ids.next('PEN', 6), obligationId: o.id, taxpayerId: o.taxpayerId, objectId: o.objectId, penaltyRuleId: rule.id,
      inputs: input.inputs, previewAmount: Money.of(ev.value, rule.currency, rule.rounding).toJSON(), motivation: input.motivation,
      proposedBy: user.id, proposedAt: this.nowIso(), status: 'PROPOSEE',
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.penalty.proposed', resourceType: 'obligation', resourceId: o.id, details: { penaltyId: p.id, ruleId: rule.id, preview: p.previewAmount } });
    return p;
  }

  decidePenalty(user: User, id: string, input: { decision: 'APPROUVEE' | 'REJETEE'; motivation: string }): PenaltyProposal {
    authorize(user, 'recouvrement:decide');
    const p = this.penalties.get(id);
    if (!p) throw notFound('PENALTY_NOT_FOUND', `Proposition de pénalité inconnue : ${id}`);
    if (p.status !== 'PROPOSEE') throw conflict('PENALTY_ALREADY_DECIDED', `Pénalité au statut ${p.status}.`);
    assertDistinctPerson(user.id, [p.proposedBy], 'La décision sur une pénalité appartient à une autorité distincte de l’agent qui propose.');
    if (input.decision === 'APPROUVEE') {
      const blockers = this.measureBlockers(this.ctx.assessment.get(p.obligationId));
      if (blockers.length) throw unprocessable(blockers[0]!.code, blockers.map((b) => b.detail).join(' '), { blockers });
    }
    const updated = this.penalties.update({ ...p, status: input.decision === 'APPROUVEE' ? 'DECIDEE' : 'REJETEE', decision: { by: user.id, at: this.nowIso(), motivation: input.motivation, decision: input.decision } });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.penalty.decided', resourceType: 'obligation', resourceId: p.obligationId, details: { penaltyId: id, decision: input.decision, motivation: input.motivation } });
    return updated;
  }

  /** Liquidation de la pénalité décidée, par un agent liquidateur, via le moteur commun (règle ACTIVE). */
  liquidatePenalty(user: User, id: string): PenaltyProposal {
    authorize(user, 'assessment.liquidate');
    const p = this.penalties.get(id);
    if (!p) throw notFound('PENALTY_NOT_FOUND', `Proposition de pénalité inconnue : ${id}`);
    if (p.status !== 'DECIDEE') throw conflict('PENALTY_NOT_DECIDED', 'Seule une pénalité décidée peut être liquidée.');
    assertDistinctPerson(user.id, [p.proposedBy, p.decision!.by], 'Le liquidateur est distinct de l’auteur de la proposition et de l’autorité de décision.');
    const res = this.ctx.assessment.calculate(user, { ruleId: p.penaltyRuleId, taxpayerId: p.taxpayerId, objectId: p.objectId, inputs: p.inputs, simulate: false });
    const updated = this.penalties.update({ ...p, status: 'LIQUIDEE', liquidatedObligationId: res.obligation!.id, liquidatedBy: user.id });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.penalty.liquidated', resourceType: 'obligation', resourceId: res.obligation!.id, details: { penaltyId: id, baseObligationId: p.obligationId } });
    return updated;
  }

  // ── Remises : règle ACTIVE déclarant la base de remise + décision humaine motivée ──
  requestRemission(user: User, input: { obligationId: string; basisRuleId: string; requestedAmount: MoneyJSON; motivation: string }): RemissionRequest {
    const o = this.ctx.assessment.get(input.obligationId);
    authorize(user, 'recouvrement:remission.request', { taxpayerId: o.taxpayerId });
    const rule = this.ctx.rules.get(input.basisRuleId);
    const exec = isRuleExecutable(rule, this.ctx.clock.now());
    if (!exec.ok) throw unprocessable('ACTE_REQUIS', `Aucune remise hors règle ACTIVE : ${rule.code} v${rule.version} — ${exec.reason}.`, { ruleStatus: rule.status });
    if (!rule.exemptions.length) throw unprocessable('REMISSION_BASIS_NOT_DECLARED', `La règle ${rule.code} ne déclare aucune base de remise ou d’exonération.`);
    if (!PAYABLE.includes(o.status)) throw unprocessable('OBLIGATION_NOT_PAYABLE', `Obligation au statut ${o.status}.`);
    const req = Money.fromJSON(input.requestedAmount);
    const orig = Money.fromJSON(o.amount);
    if (req.currency !== orig.currency) throw badRequest('CURRENCY_MISMATCH', `Montant attendu en ${orig.currency}.`);
    if (req.isNegative() || req.compare(orig) >= 0) throw unprocessable('INVALID_REMISSION_AMOUNT', 'Le montant après remise doit être positif et inférieur au montant dû.');
    const r = this.remissions.insert({
      id: this.ids.next('REM', 6), obligationId: o.id, taxpayerId: o.taxpayerId, basisRuleId: rule.id, requestedAmount: req.toJSON(),
      motivation: input.motivation, requestedBy: user.id, requestedAt: this.nowIso(), status: 'DEMANDEE',
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.remission.requested', resourceType: 'obligation', resourceId: o.id, details: { remissionId: r.id, basisRuleId: rule.id } });
    return r;
  }

  decideRemission(user: User, id: string, input: { granted: boolean; motivation: string; grantedAmount?: MoneyJSON }): RemissionRequest {
    authorize(user, 'recouvrement:decide');
    const r = this.remissions.get(id);
    if (!r) throw notFound('REMISSION_NOT_FOUND', `Demande de remise inconnue : ${id}`);
    if (r.status !== 'DEMANDEE') throw conflict('REMISSION_ALREADY_DECIDED', `Remise au statut ${r.status}.`);
    assertDistinctPerson(user.id, [r.requestedBy], 'La décision de remise appartient à une autorité distincte du demandeur.');
    const now = this.nowIso();
    if (!input.granted) {
      const refused = this.remissions.update({ ...r, status: 'REFUSEE', decision: { by: user.id, at: now, motivation: input.motivation } });
      this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.remission.refused', resourceType: 'obligation', resourceId: r.obligationId, details: { remissionId: id } });
      return refused;
    }
    const rule = this.ctx.rules.get(r.basisRuleId);
    const exec = isRuleExecutable(rule, this.ctx.clock.now());
    if (!exec.ok) throw unprocessable('ACTE_REQUIS', `Règle de remise non exécutable : ${exec.reason}.`);
    const o = this.ctx.assessment.get(r.obligationId);
    const amount = input.grantedAmount ? Money.fromJSON(input.grantedAmount) : Money.fromJSON(r.requestedAmount);
    if (amount.currency !== o.amount.currency || amount.isNegative() || amount.compare(Money.fromJSON(o.amount)) >= 0) {
      throw unprocessable('INVALID_REMISSION_AMOUNT', 'Le montant après remise doit être positif, dans la devise de l’obligation et inférieur au montant dû.');
    }
    const rectified = this.ctx.assessment.rectify(o.id, amount.toJSON(), { appealId: id, reason: `Remise ${id} (${rule.code}) — ${input.motivation}`, decidedBy: user });
    const updated = this.remissions.update({ ...r, status: 'ACCORDEE', decision: { by: user.id, at: now, motivation: input.motivation, grantedAmount: amount.toJSON() }, rectifyingObligationId: rectified.id });
    this.ctx.audit.append({ actor: this.actor(user), action: 'recovery.remission.granted', resourceType: 'obligation', resourceId: o.id, details: { remissionId: id, rectifyingObligationId: rectified.id } });
    return updated;
  }

  // ── Indicateurs (agrégats, sans donnée nominative) ──
  indicators() {
    const cases = this.cases.all();
    const proposals = this.proposals.all();
    const notices = this.notices.all();
    const appeals = this.ctx.appeals.list();
    const decidedAppeals = appeals.filter((a) => a.decision);
    const measures = proposals.filter((p) => p.kind === 'MESURE_EXECUTION' && p.status === 'APPROUVEE');
    const byCommune: Record<string, number> = {};
    for (const m of measures) {
      const o = this.ctx.assessment.obligations.get(m.obligationId);
      const k = o?.attribution?.commune ?? 'NON_ATTRIBUE';
      byCommune[k] = (byCommune[k] ?? 0) + 1;
    }
    const regularised = cases.filter((c) => c.status === 'REGULARISE').length;
    return {
      asOf: this.today(),
      cases: { open: cases.filter((c) => c.status === 'OUVERT').length, regularised, classed: cases.filter((c) => c.status === 'CLASSE').length },
      proposals: { pending: proposals.filter((p) => p.status === 'PROPOSEE').length, approved: proposals.filter((p) => p.status === 'APPROUVEE').length, rejected: proposals.filter((p) => p.status === 'REJETEE').length },
      notices: { issued: notices.length, read: notices.filter((n) => n.readAt).length, undelivered: notices.filter((n) => n.notification === 'NON_DELIVRE').length },
      regularisationRate: cases.length ? `${Math.round((regularised / cases.length) * 100)} %` : null,
      measuresByCommune: byCommune,
      appeals: {
        open: appeals.filter((a) => !a.decision).length,
        overdue: appeals.filter((a) => a.deadlines.state === 'DELAI_DEPASSE').length,
        decidedWithinDeadline: decidedAppeals.length ? `${Math.round((decidedAppeals.filter((a) => a.deadlines.state === 'DECIDE_DANS_LE_DELAI').length / decidedAppeals.length) * 100)} %` : null,
      },
      plans: { requested: this.plans.find((p) => p.status === 'DEMANDE').length, active: this.plans.find((p) => p.status === 'ACCORDE').length, defaulted: this.plans.find((p) => p.status === 'DEFAILLANT').length },
      recoveryCost: { status: 'NON_MESURE', detail: 'Coût des actions de recouvrement non encore saisi : récupération nette non calculable.' },
    };
  }

  // ── Démonstration ──
  seedDemo(): void {
    const ctx = this.ctx;
    // Instrument FICTIF autorisant les échéanciers (démonstration du circuit ; sans valeur juridique).
    if (!ctx.rules.instrument('recouvrement-demo-echeancier')) {
      ctx.rules.instruments.insert({
        id: 'recouvrement-demo-echeancier', title: 'Instrument FICTIF autorisant les échéanciers — démonstration, aucune valeur juridique',
        status: 'EN_VIGUEUR', demo: true, note: 'Remplacé par l’acte provincial autorisant les échéanciers (point juridique J14).',
      });
    }
    this.planLegalBasisInstrumentId = 'recouvrement-demo-echeancier';
    const rule = ctx.rules.rules.find((r) => r.code === 'DEMO-IF-BATI' && r.status === 'ACTIVE')[0];
    const tenant = ctx.taxpayers.taxpayers.get('TP-DEMO-0002');
    if (!rule || !tenant) return;
    // Adresse de notification vérifiée (fictive) pour la contribuable de démonstration en arriéré.
    this.addresses.insert({ id: tenant.id, channel: 'TELEPHONE', valueMasked: mask(tenant.phone), proof: 'OTP confirmé au guichet (démonstration)', verifiedAt: ctx.clock.now().toISOString(), verifiedBy: 'u-guichet', demo: true });
    // Parcelle fictive et obligation échue (dates antérieures fictives) pour illustrer le parcours gradué.
    const controller = ctx.users.get('u-controleur');
    if (!controller) return;
    const object = ctx.objects.create(controller, {
      taxpayerId: tenant.id, category: 'PARCELLE', commune: 'Lemba', quartier: 'Salongo', localityRank: 3, lat: -4.4012, lon: 15.3187,
      attributes: { superficie_m2: '300', usage: 'residentiel', batiments: 1, demo: 'oui' },
    }, 'OBJ-RECOUVREMENT-DEMO-01');
    const { obligation } = ctx.assessment.calculate(controller, { ruleId: rule.id, taxpayerId: tenant.id, objectId: object.id, inputs: {}, simulate: false });
    if (!obligation) return;
    const today = isoDate(ctx.clock.now());
    const dueDate = addDays(today, -73);
    const createdAt = `${addDays(dueDate, -30)}T09:00:00.000Z`;
    ctx.assessment.obligations.update({ ...obligation, createdAt, dueDate, status: 'EN_RETARD', explanation: { ...obligation.explanation, dueDate, computedAt: createdAt } });
    const c = this.openCase('systeme', obligation.id, true);
    const hist: RecoveryStep[] = [
      { kind: 'AVIS_J_PLUS_1', doneOn: addDays(dueDate, 1), at: `${addDays(dueDate, 1)}T08:00:00.000Z`, by: 'systeme', demoHistoric: true },
      { kind: 'RELANCE_J_PLUS_15', doneOn: addDays(dueDate, 15), at: `${addDays(dueDate, 15)}T08:00:00.000Z`, by: 'systeme', demoHistoric: true },
    ];
    this.cases.update({ ...this.getCase(c.id), steps: hist });
  }
}

export { REMINDER_STEPS };
