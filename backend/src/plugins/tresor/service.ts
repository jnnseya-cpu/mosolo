/**
 * Trésor avancé et cycle complet de la quittance (§ 19, § 20, document maître ch. 18–20, H.10) :
 *  - files d'exception traitables (affectation, en cours, résolue / classée avec motif, justificatif, quatre yeux) ;
 *  - compte d'attente (suspens) daté, justifié, avec ancienneté, apuré sous double validation ;
 *  - opérations financières en double validation (proposition, validation par une autre personne) :
 *    annulation et remplacement de quittance, contrepassation, remboursement, contre-écriture, apurement, nomenclature ;
 *  - clôture quotidienne signée (empreinte chaînée) et clôture mensuelle ;
 *  - imputation selon une nomenclature paramétrable (état « Comptabilisé ») et export signé vers la comptabilité publique.
 * Le système constate et propose ; une personne habilitée décide, une autre valide. Aucun fonds ne sort vers un compte
 * privé : un remboursement retourne vers l'instrument de paiement d'origine uniquement, exécuté par le Trésor.
 */
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canTransition, Money, type CurrencyCode, type MoneyJSON, type RevenueCategory } from '@mosolo/shared';
import type { AuditActor } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, HOUR_MS } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { AppContext } from '../../context.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import type { Receipt, ReceiptDecision } from '../../modules/receipts/service.js';
import type { LedgerEntry } from '../../modules/treasury/ledger.js';
import type { ExceptionStatus, ReconciliationException } from '../../modules/treasury/service.js';

/* ------------------------------------------------------------------ types */

export const EXCEPTION_SLA_HOURS = 48;
export const SUSPENSE_SLA_DAYS = 5;
export const SUSPENSE_MAX_DAYS = 30;

export interface Evidence {
  label: string;
  /** Empreinte SHA-256 de la pièce (la pièce elle-même reste dans la GED). */
  sha256?: string;
  note?: string;
  addedBy: string;
  addedAt: string;
}

export interface CaseEvent {
  at: string;
  by: string;
  action: 'AFFECTEE' | 'PRISE_EN_CHARGE' | 'JUSTIFICATIF' | 'RESOLUTION_PROPOSEE' | 'RESOLUTION_VALIDEE' | 'RESOLUTION_REJETEE';
  note?: string;
}

export type ResolutionAction = 'AUCUNE' | 'MISE_EN_SUSPENS';

export interface ExceptionCase {
  id: string; // = identifiant de l'exception
  status: ExceptionStatus;
  assignee?: string;
  assignedBy?: string;
  assignedAt?: string;
  startedAt?: string;
  evidence: Evidence[];
  proposal?: { outcome: 'RESOLUE' | 'CLASSEE'; motif: string; action: ResolutionAction; proposedBy: string; proposedAt: string };
  decision?: { approvedBy: string; approvedAt: string; suspenseId?: string };
  history: CaseEvent[];
}

export interface SuspenseItem {
  id: string;
  accountAlias: string;
  amount: MoneyJSON;
  valueDate: string;
  statementId?: string;
  paymentReference?: string;
  exceptionId?: string;
  /** Justification de la mise en suspens (obligatoire). */
  justification: string;
  openedAt: string;
  openedBy: string;
  approvedBy?: string;
  ledgerEntryId: string;
  status: 'OUVERT' | 'APURE';
  clearing?: { operationId: string; mode: 'AFFECTATION' | 'RESTITUTION'; paymentReference?: string; ledgerEntryId: string; at: string };
  demo?: boolean;
  /**
   * Paiement reçu mais non affecté (doublon, référence expirée…) : fonds encore chez le prestataire. Seule la
   * restitution à l'instrument d'origine est possible ; elle solde la créance sur le prestataire.
   */
  unappliedId?: string;
}

export type OperationKind =
  | 'ANNULATION_QUITTANCE' | 'REMPLACEMENT_QUITTANCE' | 'CONTREPASSATION' | 'REMBOURSEMENT'
  | 'CONTRE_ECRITURE' | 'APUREMENT_SUSPENS' | 'PARAMETRE_NOMENCLATURE';

export const RECEIPT_KINDS: OperationKind[] = ['ANNULATION_QUITTANCE', 'REMPLACEMENT_QUITTANCE'];

export interface OperationInput {
  kind: OperationKind;
  reason: string;
  /** Motif générique affiché publiquement (quittances) ; défaut selon le type. */
  publicReason?: string;
  receipt?: string;
  paymentReference?: string;
  ledgerEntryId?: string;
  suspenseId?: string;
  mode?: 'AFFECTATION' | 'RESTITUTION';
  nomenclature?: { revenueCategory: RevenueCategory; code: string; label: string; officialAct?: string };
}

export interface FinancialOperation {
  id: string;
  kind: OperationKind;
  status: 'PROPOSEE' | 'EXECUTEE' | 'REJETEE';
  input: OperationInput;
  /** Résumé lisible de la cible, calculé à la proposition (aucune donnée nominative). */
  target: { label: string; amount?: MoneyJSON; key: string };
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  result?: Record<string, unknown>;
}

export interface NomenclatureEntry {
  revenueCategory: RevenueCategory;
  code: string;
  label: string;
  /** Code de démonstration (fictif) tant qu'aucun acte officiel n'est référencé (J1 : nomenclature consolidée). */
  demo: boolean;
  officialAct?: string;
  version: number;
  updatedAt: string;
  approvedBy?: string;
}

export interface Imputation {
  id: string; // = identifiant de l'ordre de paiement
  paymentReference: string;
  receiptNumber?: string;
  ledgerEntryId: string;
  entryDate: string;
  code: string;
  label: string;
  demo: boolean;
  nomenclatureVersion: number;
  amount: MoneyJSON;
  imputedAt: string;
  imputedBy: string;
}

export interface DailyClosure {
  id: string;
  date: string;
  fromSeq: number;
  toSeq: number;
  entries: number;
  totals: { currency: CurrencyCode; debit: MoneyJSON; credit: MoneyJSON; balanced: boolean }[];
  balanced: boolean;
  entriesHash: string;
  ledgerHeadHash: string | null;
  openExceptions: number;
  openSuspense: number;
  unimputed: number;
  prevHash: string;
  hash: string;
  signature: string;
  closedBy: string;
  closedAt: string;
}

export interface MonthlyClosure {
  id: string;
  month: string;
  dailyClosures: string[];
  dailyHashes: string[];
  totals: { currency: CurrencyCode; debit: MoneyJSON; credit: MoneyJSON }[];
  imputed: number;
  prevHash: string;
  hash: string;
  signature: string;
  closedBy: string;
  closedAt: string;
}

const GENESIS = '0'.repeat(64);

const DEFAULT_PUBLIC_REASON: Partial<Record<OperationKind, string>> = {
  ANNULATION_QUITTANCE: 'Annulée par décision motivée de la régie.',
  REMPLACEMENT_QUITTANCE: 'Remplacée par décision motivée de la régie.',
  CONTREPASSATION: 'Paiement contrepassé.',
  REMBOURSEMENT: 'Paiement remboursé.',
};

/** Date civile de Kinshasa (UTC+1, sans heure d'été). */
export function kinDate(iso: string | Date): string {
  const t = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime();
  return new Date(t + HOUR_MS).toISOString().slice(0, 10);
}

const actorOf = (u: User): AuditActor => ({ kind: 'user', id: u.id, roles: u.roles });

function sumByCurrency(items: MoneyJSON[]): MoneyJSON[] {
  const m = new Map<CurrencyCode, Money>();
  for (const j of items) {
    const v = Money.fromJSON(j);
    m.set(v.currency, (m.get(v.currency) ?? Money.zero(v.currency)).add(v));
  }
  return [...m.values()].map((v) => v.toJSON());
}

/* ------------------------------------------------------------------ service */

export class TresorService {
  readonly cases = new InMemoryRepository<ExceptionCase>();
  readonly suspense = new InMemoryRepository<SuspenseItem>();
  readonly operations = new InMemoryRepository<FinancialOperation>();
  readonly nomenclature = new Map<string, NomenclatureEntry>();
  readonly imputations = new InMemoryRepository<Imputation>();
  readonly daily = new InMemoryAppendOnlyRepository<DailyClosure>();
  readonly monthly = new InMemoryAppendOnlyRepository<MonthlyClosure>();
  private nomenclatureVersion = 0;
  private readonly ids = new IdGenerator();
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private readonly agedNotified = new Set<string>();

  constructor(private readonly ctx: AppContext) {
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    ctx.treasury.setExceptionOverlay((e) => this.decorate(e));
    // Paiement non affecté : porté au compte d'attente (écriture déjà passée par le module paiements), daté, justifié.
    ctx.payments.onUnapplied((u) => {
      this.openSuspense({
        accountAlias: u.beneficiaryAlias, amount: u.amount, valueDate: kinDate(u.receivedAt), paymentReference: u.paymentReference,
        exceptionId: `EXC-NAFF-${u.id}`, unappliedId: u.id, openedBy: 'systeme:paiements',
        justification: `Paiement ${u.provider} ${u.providerTxnId} non affecté (${u.reason}) : remboursement vers l'instrument d'origine à décider.`,
      }, u.ledgerEntryId);
    });
  }

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  private signHex(hash: string): string {
    return sign(null, Buffer.from(hash), this.privateKey).toString('base64url');
  }

  /* ---------------------------------------------------------- exceptions */

  private decorate(e: ReconciliationException): ReconciliationException {
    const c = this.cases.get(e.id);
    const opened = new Date(e.openedAt).getTime();
    const now = this.ctx.clock.now().getTime();
    const dueAt = new Date(opened + EXCEPTION_SLA_HOURS * HOUR_MS).toISOString();
    const status: ExceptionStatus = c?.status ?? 'OUVERTE';
    const done = status === 'RESOLUE' || status === 'CLASSEE';
    const assignee = c?.assignee ? this.ctx.users.get(c.assignee) : undefined;
    return {
      ...e,
      status,
      dueAt,
      ageHours: Math.max(0, Math.floor((now - opened) / HOUR_MS)),
      overdue: !done && now > opened + EXCEPTION_SLA_HOURS * HOUR_MS,
      ...(c?.assignee ? { assignee: c.assignee, assigneeName: assignee?.name ?? c.assignee } : {}),
      ...(c?.proposal ? { proposal: c.proposal } : {}),
      ...(c?.decision ? { decision: c.decision } : {}),
      evidence: c?.evidence ?? [],
      history: c?.history ?? [],
    };
  }

  private exception(user: User, id: string): ReconciliationException {
    const e = this.ctx.treasury.listExceptions(user).find((x) => x.id === id);
    if (!e) throw notFound('EXCEPTION_NOT_FOUND', `Exception inconnue ou déjà sortie de la file : ${id}`);
    return e;
  }

  private caseOf(id: string): ExceptionCase {
    return this.cases.get(id) ?? this.cases.insert({ id, status: 'OUVERTE', evidence: [], history: [] });
  }

  listExceptions(user: User, filter: { queue?: string; status?: string } = {}) {
    authorize(user, 'tresor:exception.read');
    const all = this.ctx.treasury.listExceptions(user);
    // Exceptions ayant dépassé le délai de 48 h : signalées une seule fois au Trésor (revue du contrôle interne).
    const aged = all.filter((e) => e.overdue === true && !this.agedNotified.has(e.id));
    if (aged.length) {
      for (const e of aged) this.agedNotified.add(e.id);
      this.ctx.comms.publish('reconciliation.exception.aged', this.ctx.users.withRole('R17').map(userRecipient), { reference: aged.map((e) => e.id).join(', ') }, { entity: 'TRESOR' });
    }
    const items = all.filter((e) => (!filter.queue || e.queue === filter.queue) && (!filter.status || e.status === filter.status));
    const queues = ['PAIEMENT_SANS_OBLIGATION', 'OBLIGATION_SANS_REGLEMENT', 'REGLEMENT_SANS_PAIEMENT', 'ECART_MONTANT'].map((q) => {
      const inQ = all.filter((e) => e.queue === q);
      return {
        queue: q,
        open: inQ.filter((e) => e.status === 'OUVERTE').length,
        inProgress: inQ.filter((e) => e.status === 'EN_COURS').length,
        closed: inQ.filter((e) => e.status === 'RESOLUE' || e.status === 'CLASSEE').length,
        overdue: inQ.filter((e) => e.overdue === true).length,
      };
    });
    return { items, queues, slaHours: EXCEPTION_SLA_HOURS };
  }

  assign(user: User, id: string, assigneeId: string) {
    authorize(user, 'tresor:exception.assign');
    const e = this.exception(user, id);
    if (e.status === 'RESOLUE' || e.status === 'CLASSEE') throw conflict('EXCEPTION_CLOSED', `L'exception ${id} est close.`);
    const assignee = this.ctx.users.get(assigneeId);
    if (!assignee || !assignee.roles.some((r) => r === 'R18' || r === 'R17')) {
      throw unprocessable('ASSIGNEE_NOT_ELIGIBLE', 'Une exception ne s’affecte qu’à un analyste de rapprochement ou à un comptable public.');
    }
    const c = this.caseOf(id);
    const at = this.now();
    const updated = this.cases.update({
      ...c, assignee: assigneeId, assignedBy: user.id, assignedAt: at, status: c.status === 'OUVERTE' ? 'OUVERTE' : c.status,
      history: [...c.history, { at, by: user.id, action: 'AFFECTEE', note: assignee.name }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.assigned', resourceType: 'reconciliation_exception', resourceId: id, details: { assignee: assigneeId } });
    this.ctx.comms.publish('reconciliation.exception.opened', [userRecipient(assignee)], { reference: id }, { entity: 'TRESOR' });
    void updated;
    return this.exception(user, id);
  }

  private requireAssignee(user: User, c: ExceptionCase, id: string): void {
    if (c.assignee !== user.id) throw conflict('NOT_ASSIGNEE', `Seule la personne affectée à l'exception ${id} peut la traiter${c.assignee ? '' : ' (aucune affectation)'}.`);
  }

  start(user: User, id: string) {
    authorize(user, 'tresor:exception.work');
    const e = this.exception(user, id);
    const c = this.caseOf(id);
    this.requireAssignee(user, c, id);
    if (c.status !== 'OUVERTE') throw conflict('EXCEPTION_INVALID_TRANSITION', `Exception ${id} : déjà ${c.status}.`);
    const at = this.now();
    this.cases.update({ ...c, status: 'EN_COURS', startedAt: at, history: [...c.history, { at, by: user.id, action: 'PRISE_EN_CHARGE' }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.started', resourceType: 'reconciliation_exception', resourceId: id });
    return this.exception(user, id);
  }

  addEvidence(user: User, id: string, input: { label: string; sha256?: string; note?: string }) {
    authorize(user, 'tresor:exception.work');
    const e = this.exception(user, id);
    const c = this.caseOf(id);
    this.requireAssignee(user, c, id);
    if (c.status === 'RESOLUE' || c.status === 'CLASSEE') throw conflict('EXCEPTION_CLOSED', `L'exception ${id} est close.`);
    const at = this.now();
    const ev: Evidence = { label: input.label, ...(input.sha256 ? { sha256: input.sha256 } : {}), ...(input.note ? { note: input.note } : {}), addedBy: user.id, addedAt: at };
    this.cases.update({ ...c, evidence: [...c.evidence, ev], history: [...c.history, { at, by: user.id, action: 'JUSTIFICATIF', note: input.label }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.evidence_added', resourceType: 'reconciliation_exception', resourceId: id, details: { label: input.label, sha256: input.sha256 ?? null } });
    return this.exception(user, id);
  }

  proposeResolution(user: User, id: string, input: { outcome: 'RESOLUE' | 'CLASSEE'; motif: string; action: ResolutionAction }) {
    authorize(user, 'tresor:exception.work');
    const e = this.exception(user, id);
    const c = this.caseOf(id);
    this.requireAssignee(user, c, id);
    if (c.status !== 'EN_COURS') throw conflict('EXCEPTION_INVALID_TRANSITION', `Exception ${id} : prise en charge requise avant toute proposition (état ${c.status}).`);
    if (c.proposal && !c.decision) throw conflict('RESOLUTION_ALREADY_PROPOSED', `Une résolution attend déjà validation pour ${id}.`);
    if (input.outcome === 'RESOLUE' && c.evidence.length === 0) throw unprocessable('EVIDENCE_REQUIRED', 'Une résolution exige au moins un justificatif.');
    if (input.action === 'MISE_EN_SUSPENS') this.assertSuspendable(e);
    const at = this.now();
    this.cases.update({ ...c, proposal: { ...input, proposedBy: user.id, proposedAt: at }, history: [...c.history, { at, by: user.id, action: 'RESOLUTION_PROPOSEE', note: `${input.outcome} — ${input.motif}` }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.resolution_proposed', resourceType: 'reconciliation_exception', resourceId: id, details: { ...input } });
    return this.exception(user, id);
  }

  private assertSuspendable(e: ReconciliationException): void {
    if (!e.line) throw unprocessable('SUSPENSE_NEEDS_STATEMENT_LINE', 'Seul un crédit constaté sur relevé peut être porté en compte d’attente.');
    if (!this.ctx.vault.current(e.line.accountAlias)) throw unprocessable('SUSPENSE_UNKNOWN_ACCOUNT', `Le compte ${e.line.accountAlias} n'est pas un compte public du coffre : aucun suspens possible.`);
    if (this.suspense.findOne((s) => s.exceptionId === e.id)) throw conflict('SUSPENSE_ALREADY_OPENED', `Un suspens existe déjà pour ${e.id}.`);
  }

  approveResolution(user: User, id: string) {
    authorize(user, 'tresor:exception.approve');
    const e = this.exception(user, id);
    const c = this.caseOf(id);
    if (!c.proposal || c.decision) throw conflict('NO_PENDING_RESOLUTION', `Aucune résolution en attente pour ${id}.`);
    assertDistinctPerson(user.id, [c.proposal.proposedBy], 'Quatre yeux : la résolution doit être validée par une autre personne que son auteur.');
    const at = this.now();
    let suspenseId: string | undefined;
    if (c.proposal.action === 'MISE_EN_SUSPENS') {
      this.assertSuspendable(e);
      suspenseId = this.openSuspense({
        accountAlias: e.line!.accountAlias, amount: e.line!.amount, valueDate: e.line!.valueDate,
        ...(e.statementId ? { statementId: e.statementId } : {}), ...(e.paymentReference ? { paymentReference: e.paymentReference } : {}),
        exceptionId: id, justification: c.proposal.motif, openedBy: c.proposal.proposedBy, approvedBy: user.id,
      }).id;
    }
    this.cases.update({
      ...c, status: c.proposal.outcome, decision: { approvedBy: user.id, approvedAt: at, ...(suspenseId ? { suspenseId } : {}) },
      history: [...c.history, { at, by: user.id, action: 'RESOLUTION_VALIDEE', note: suspenseId ? `Suspens ${suspenseId}` : undefined }],
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: `reconciliation.exception.${c.proposal.outcome === 'RESOLUE' ? 'resolved' : 'classified'}`,
      resourceType: 'reconciliation_exception', resourceId: id, details: { proposedBy: c.proposal.proposedBy, motif: c.proposal.motif, suspenseId: suspenseId ?? null },
    });
    return this.exception(user, id);
  }

  rejectResolution(user: User, id: string, motif: string) {
    authorize(user, 'tresor:exception.approve');
    const e = this.exception(user, id);
    const c = this.caseOf(id);
    if (!c.proposal || c.decision) throw conflict('NO_PENDING_RESOLUTION', `Aucune résolution en attente pour ${id}.`);
    assertDistinctPerson(user.id, [c.proposal.proposedBy], 'Quatre yeux : le rejet revient à une autre personne que l’auteur.');
    const at = this.now();
    const { proposal: _p, ...rest } = c;
    this.cases.update({ ...rest, status: 'EN_COURS', history: [...c.history, { at, by: user.id, action: 'RESOLUTION_REJETEE', note: motif }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.resolution_rejected', resourceType: 'reconciliation_exception', resourceId: id, details: { motif } });
    return this.exception(user, id);
  }

  /* ------------------------------------------------------------ suspens */

  /** `existingEntryId` : écriture de mise en attente déjà passée (paiement non affecté), aucune nouvelle écriture. */
  private openSuspense(input: Omit<SuspenseItem, 'id' | 'openedAt' | 'ledgerEntryId' | 'status'>, existingEntryId?: string): SuspenseItem {
    const id = this.ids.next('SUSP');
    const entryId = existingEntryId ?? this.ctx.ledger.postPair({
      eventType: 'SUSPENSE_OPENED', description: `Fonds non identifiés sur ${input.accountAlias} (${input.valueDate}) portés en compte d'attente`,
      sourceType: 'suspense', sourceId: id, debit: 'COMPTE_PUBLIC_RECETTES', credit: 'COMPTE_ATTENTE', amount: input.amount,
    }).id;
    const item = this.suspense.insert({ ...input, id, openedAt: this.now(), ledgerEntryId: entryId, status: 'OUVERT' });
    this.ctx.audit.append({
      actor: input.unappliedId ? { kind: 'system', id: input.openedBy } : { kind: 'user', id: input.approvedBy ?? input.openedBy }, action: 'suspense.opened', resourceType: 'suspense', resourceId: id,
      details: { amount: input.amount, accountAlias: input.accountAlias, exceptionId: input.exceptionId ?? null, proposedBy: input.openedBy },
    });
    return item;
  }

  private suspenseView(s: SuspenseItem) {
    const now = this.ctx.clock.now().getTime();
    const ref = new Date(`${s.valueDate}T00:00:00.000Z`).getTime();
    const ageDays = Math.max(0, Math.floor((now - ref) / DAY_MS));
    const bucket = ageDays <= 2 ? '0-2 j' : ageDays <= SUSPENSE_SLA_DAYS ? `3-${SUSPENSE_SLA_DAYS} j` : ageDays <= SUSPENSE_MAX_DAYS ? `${SUSPENSE_SLA_DAYS + 1}-${SUSPENSE_MAX_DAYS} j` : `> ${SUSPENSE_MAX_DAYS} j`;
    return { ...s, ageDays: s.status === 'OUVERT' ? ageDays : undefined, bucket: s.status === 'OUVERT' ? bucket : undefined, overSla: s.status === 'OUVERT' && ageDays > SUSPENSE_SLA_DAYS, overMax: s.status === 'OUVERT' && ageDays > SUSPENSE_MAX_DAYS };
  }

  listSuspense(user: User) {
    authorize(user, 'tresor:suspense.read');
    const items = this.suspense.all().map((s) => this.suspenseView(s)).sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    const open = items.filter((s) => s.status === 'OUVERT');
    const buckets = ['0-2 j', `3-${SUSPENSE_SLA_DAYS} j`, `${SUSPENSE_SLA_DAYS + 1}-${SUSPENSE_MAX_DAYS} j`, `> ${SUSPENSE_MAX_DAYS} j`].map((b) => ({
      bucket: b, count: open.filter((s) => s.bucket === b).length, amounts: sumByCurrency(open.filter((s) => s.bucket === b).map((s) => s.amount)),
    }));
    return { items, open: open.length, totals: sumByCurrency(open.map((s) => s.amount)), buckets, slaDays: SUSPENSE_SLA_DAYS, maxDays: SUSPENSE_MAX_DAYS };
  }

  /* ------------------------------------------------ double validation */

  private receiptKinds(kind: OperationKind): boolean {
    return RECEIPT_KINDS.includes(kind);
  }

  private order(ref: string | undefined): PaymentOrder {
    if (!ref) throw badRequest('PAYMENT_REFERENCE_REQUIRED', 'Référence de paiement requise.');
    const o = this.ctx.payments.byReference(ref);
    if (!o) throw notFound('PAYMENT_NOT_FOUND', `Référence de paiement inconnue : ${ref}`);
    return o;
  }

  private settlementEntries(orderId: string): LedgerEntry[] {
    return this.ctx.ledger.list({ sourceId: orderId }).filter((e) => !e.reversalOf && !this.ctx.ledger.isReversed(e.id));
  }

  /** Contrôles de recevabilité, rejoués à la validation (l'état a pu changer entre-temps). */
  private precheck(input: OperationInput): FinancialOperation['target'] {
    switch (input.kind) {
      case 'ANNULATION_QUITTANCE': {
        const r = this.ctx.receipts.require(input.receipt ?? '');
        if (r.status === 'DEFINITIVE') throw conflict('RECEIPT_DEFINITIVE', `La quittance ${r.number} est définitive : elle ne s'annule pas (remplacement, contrepassation ou remboursement).`);
        this.ctx.receipts.assertTransition(r, 'ANNULEE');
        const o = this.ctx.payments.orders.get(r.paymentOrderId);
        if (o && (o.status === 'REGLE' || o.status === 'RAPPROCHE')) throw conflict('PAYMENT_SETTLED', `Le paiement ${o.paymentReference} est réglé : annulation impossible.`);
        return { key: `receipt:${r.id}`, label: `Quittance ${r.number} (${r.status})`, amount: r.amount };
      }
      case 'REMPLACEMENT_QUITTANCE': {
        const r = this.ctx.receipts.require(input.receipt ?? '');
        this.ctx.receipts.assertReplaceable(r);
        return { key: `receipt:${r.id}`, label: `Quittance ${r.number} (${r.status})`, amount: r.amount };
      }
      case 'CONTREPASSATION': {
        const o = this.order(input.paymentReference);
        if (o.status !== 'CONTREPASSE' && !canTransition(o.status, 'CONTREPASSE')) {
          throw conflict('INVALID_PAYMENT_TRANSITION', `Paiement ${o.paymentReference} au statut ${o.status} : contrepassation impossible (confirmé ou contesté requis).`);
        }
        const r = this.ctx.receipts.byPaymentOrder(o.id);
        if (o.status === 'CONTREPASSE' && (!r || r.status === 'CONTREPASSEE')) throw conflict('ALREADY_REVERSED', `Paiement ${o.paymentReference} déjà contrepassé.`);
        return { key: `payment:${o.id}`, label: `Paiement ${o.paymentReference} (${o.status})${r ? ` — quittance ${r.number}` : ''}`, amount: o.amount };
      }
      case 'REMBOURSEMENT': {
        const o = this.order(input.paymentReference);
        if (!canTransition(o.status, 'REMBOURSE')) throw conflict('INVALID_PAYMENT_TRANSITION', `Paiement ${o.paymentReference} au statut ${o.status} : remboursement possible seulement après rapprochement ou sur doublon.`);
        return { key: `payment:${o.id}`, label: `Remboursement ${o.paymentReference} vers l'instrument d'origine (${o.channel}${o.provider ? `, ${o.provider}` : ''})`, amount: o.amount };
      }
      case 'CONTRE_ECRITURE': {
        const e = this.ctx.ledger.get(input.ledgerEntryId ?? '');
        if (!e) throw notFound('LEDGER_ENTRY_NOT_FOUND', `Écriture inconnue : ${input.ledgerEntryId}`);
        if (e.reversalOf) throw conflict('CANNOT_REVERSE_REVERSAL', 'Une contre-écriture ne se contrepasse pas.');
        if (this.ctx.ledger.isReversed(e.id)) throw conflict('ALREADY_REVERSED', `L'écriture ${e.id} est déjà contrepassée.`);
        return { key: `ledger:${e.id}`, label: `Écriture ${e.id} — ${e.description}`, amount: e.lines[0]!.amount };
      }
      case 'APUREMENT_SUSPENS': {
        const s = this.suspense.get(input.suspenseId ?? '');
        if (!s) throw notFound('SUSPENSE_NOT_FOUND', `Suspens inconnu : ${input.suspenseId}`);
        if (s.status !== 'OUVERT') throw conflict('SUSPENSE_CLEARED', `Le suspens ${s.id} est déjà apuré.`);
        if (input.mode === 'AFFECTATION') {
          if (s.unappliedId) throw unprocessable('UNAPPLIED_PAYMENT_REFUND_ONLY', `Le suspens ${s.id} porte un paiement non affecté : seule la restitution à l'instrument d'origine est possible.`);
          const o = this.order(input.paymentReference);
          if (o.status !== 'CONFIRME') throw conflict('PAYMENT_NOT_CONFIRMED', `Le paiement ${o.paymentReference} doit être confirmé par le prestataire (statut ${o.status}).`);
          if (!Money.fromJSON(o.amount).equals(Money.fromJSON(s.amount))) throw unprocessable('AMOUNT_MISMATCH', `Montant du suspens ${s.amount.amount} ${s.amount.currency} ≠ montant dû ${o.amount.amount} ${o.amount.currency}.`);
          if (o.beneficiaryAlias !== s.accountAlias) throw unprocessable('WRONG_ACCOUNT', `Le suspens est sur ${s.accountAlias}, le paiement est destiné à ${o.beneficiaryAlias}.`);
          return { key: `suspense:${s.id}`, label: `Affectation du suspens ${s.id} au paiement ${o.paymentReference}`, amount: s.amount };
        }
        if (input.mode === 'RESTITUTION') return { key: `suspense:${s.id}`, label: `Restitution du suspens ${s.id} à l'émetteur d'origine`, amount: s.amount };
        throw badRequest('MODE_REQUIRED', 'Mode d’apurement requis : AFFECTATION ou RESTITUTION.');
      }
      case 'PARAMETRE_NOMENCLATURE': {
        const n = input.nomenclature;
        if (!n) throw badRequest('NOMENCLATURE_REQUIRED', 'Entrée de nomenclature requise.');
        return { key: `nomenclature:${n.revenueCategory}`, label: `Imputation ${n.revenueCategory} → ${n.code}${n.officialAct ? '' : ' [DÉMO]'}` };
      }
    }
  }

  propose(user: User, input: OperationInput): FinancialOperation {
    authorize(user, this.receiptKinds(input.kind) ? 'tresor:receipt.propose' : 'tresor:finance.propose');
    const target = this.precheck(input);
    const pending = this.operations.findOne((o) => o.status === 'PROPOSEE' && o.target.key === target.key);
    if (pending) throw conflict('OPERATION_ALREADY_PENDING', `Une opération ${pending.id} attend déjà validation sur cette cible.`);
    const op = this.operations.insert({
      id: this.ids.next('OPF'), kind: input.kind, status: 'PROPOSEE', input, target, proposedBy: user.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.operation.proposed', resourceType: 'financial_operation', resourceId: op.id, details: { kind: op.kind, target: target.label, reason: input.reason } });
    if (input.kind === 'REMBOURSEMENT') {
      const o = this.order(input.paymentReference);
      this.ctx.comms.publish('refund.requested', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: 'TRESOR' });
    }
    return op;
  }

  listOperations(user: User, status?: string) {
    authorize(user, 'tresor:operation.read');
    return this.operations.all().filter((o) => !status || o.status === status).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  private requireOperation(id: string): FinancialOperation {
    const op = this.operations.get(id);
    if (!op) throw notFound('OPERATION_NOT_FOUND', `Opération inconnue : ${id}`);
    if (op.status !== 'PROPOSEE') throw conflict('OPERATION_ALREADY_DECIDED', `L'opération ${id} est déjà ${op.status}.`);
    return op;
  }

  reject(user: User, id: string, note: string): FinancialOperation {
    authorize(user, 'tresor:operation.approve');
    const op = this.requireOperation(id);
    assertDistinctPerson(user.id, [op.proposedBy], 'Double validation : le rejet revient à une autre personne que l’auteur.');
    const updated = this.operations.update({ ...op, status: 'REJETEE', decidedBy: user.id, decidedAt: this.now(), decisionNote: note });
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.operation.rejected', resourceType: 'financial_operation', resourceId: id, details: { kind: op.kind, note } });
    if (op.kind === 'REMBOURSEMENT') {
      const o = this.ctx.payments.byReference(op.input.paymentReference ?? '');
      if (o) this.ctx.comms.publish('refund.refused', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: 'TRESOR' });
    }
    return updated;
  }

  approve(user: User, id: string, note?: string): FinancialOperation {
    authorize(user, 'tresor:operation.approve');
    const op = this.requireOperation(id);
    assertDistinctPerson(user.id, [op.proposedBy], 'Double validation : l’opération doit être validée par une autre personne que son auteur.');
    this.precheck(op.input);
    const at = this.now();
    const decision: ReceiptDecision = {
      operationId: op.id, proposedBy: op.proposedBy, approvedBy: user.id, reason: op.input.reason,
      publicReason: op.input.publicReason ?? DEFAULT_PUBLIC_REASON[op.kind] ?? 'Décision motivée de la régie.', at,
    };
    const result = this.execute(user, op, decision);
    const updated = this.operations.update({ ...op, status: 'EXECUTEE', decidedBy: user.id, decidedAt: at, ...(note ? { decisionNote: note } : {}), result });
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.operation.executed', resourceType: 'financial_operation', resourceId: id, details: { kind: op.kind, proposedBy: op.proposedBy, ...result } });
    return updated;
  }

  /**
   * Après contrepassation ou remboursement : l'obligation en vigueur reprend l'état que justifie le cumul encore payé
   * (SOLDEE, PARTIELLEMENT_PAYEE ou EXIGIBLE). Seuls ces états « de paiement » sont recalculés ; ANNULEE, CONTESTEE…
   * ne sont jamais touchés.
   */
  private restoreObligationStatus(obligationId: string) {
    const ob = this.ctx.assessment.get(this.ctx.payments.currentObligationId(obligationId));
    if (ob.status !== 'SOLDEE' && ob.status !== 'PARTIELLEMENT_PAYEE') return ob;
    const paid = this.ctx.payments.paidOn(ob.id);
    const status = paid.compare(Money.fromJSON(ob.amount)) >= 0 ? 'SOLDEE' : paid.isZero() ? 'EXIGIBLE' : 'PARTIELLEMENT_PAYEE';
    return status === ob.status ? ob : this.ctx.assessment.setStatus(ob.id, status);
  }

  private notifyTaxpayer(event: string, r: Receipt | undefined, reference: string): void {
    if (!r) return;
    this.ctx.comms.publish(event, [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference }, { entity: r.administration });
  }

  private execute(user: User, op: FinancialOperation, decision: ReceiptDecision): Record<string, unknown> {
    const actor = actorOf(user);
    const input = op.input;
    switch (input.kind) {
      case 'ANNULATION_QUITTANCE': {
        const r = this.ctx.receipts.applyDecision(input.receipt!, 'ANNULEE', decision);
        this.notifyTaxpayer('receipt.cancelled', r, r.number);
        return { receiptNumber: r.number, receiptStatus: r.status };
      }
      case 'REMPLACEMENT_QUITTANCE': {
        const r = this.ctx.receipts.require(input.receipt!);
        const tp = this.ctx.taxpayers.get(r.taxpayerId);
        const ob = this.ctx.assessment.get(r.obligationId);
        const { original, replacement } = this.ctx.receipts.replace(r.id, { taxpayerRef: tp.iuc, revenueCategory: ob.label, administration: ob.entity }, decision);
        this.notifyTaxpayer('receipt.replaced', replacement, replacement.number);
        return { receiptNumber: original.number, replacedBy: replacement.number, replacementCode: replacement.code };
      }
      case 'CONTREPASSATION': {
        const o = this.order(input.paymentReference);
        const reversed: string[] = [];
        for (const e of this.settlementEntries(o.id)) reversed.push(this.ctx.ledger.reverse(e.id, `Contrepassation ${op.id} : ${input.reason}`, actor).id);
        if (o.status !== 'CONTREPASSE') {
          // Transition contrôlée par la table partagée des états de paiement (CONFIRME|CONTESTE → CONTREPASSE).
          this.ctx.payments.markReversed(o.id, reversed);
          this.ctx.audit.append({ actor, action: 'payment.reversed', resourceType: 'payment_order', resourceId: o.id, details: { operationId: op.id, from: o.status, proposedBy: op.proposedBy } });
        }
        const r = this.ctx.receipts.byPaymentOrder(o.id);
        let receiptNumber: string | undefined;
        if (r && (r.status === 'PROVISOIRE' || r.status === 'DEFINITIVE' || r.status === 'SUSPECTE')) receiptNumber = this.ctx.receipts.applyDecision(r.id, 'CONTREPASSEE', decision).number;
        const ob = this.restoreObligationStatus(o.obligationId);
        this.ctx.comms.publish('payment.reversed', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: ob.entity });
        return { paymentReference: o.paymentReference, reversalEntries: reversed, receiptNumber: receiptNumber ?? null };
      }
      case 'REMBOURSEMENT': {
        const o = this.order(input.paymentReference);
        // Plafond : exactement le montant payé ; destination : l'instrument d'origine, jamais un compte saisi.
        const entry = this.ctx.ledger.postPair({
          eventType: 'REFUND', description: `Remboursement ${o.paymentReference} vers l'instrument d'origine (${op.id})`,
          sourceType: 'payment_order', sourceId: o.id, debit: 'RECETTES_CONSTATEES', credit: 'COMPTE_PUBLIC_RECETTES', amount: o.amount,
        });
        this.ctx.payments.markRefunded(o.id, entry.id);
        // Comme pour la contrepassation : l'obligation redevient due à hauteur de ce qui a été restitué.
        this.restoreObligationStatus(o.obligationId);
        this.ctx.audit.append({ actor, action: 'payment.refunded', resourceType: 'payment_order', resourceId: o.id, details: { operationId: op.id, ledgerEntryId: entry.id, destination: 'INSTRUMENT_ORIGINE' } });
        const r = this.ctx.receipts.byPaymentOrder(o.id);
        const receipt = r && r.status === 'DEFINITIVE' ? this.ctx.receipts.applyDecision(r.id, 'REMBOURSEE', decision) : undefined;
        this.ctx.comms.publish('refund.approved', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: 'TRESOR' });
        return { paymentReference: o.paymentReference, ledgerEntryId: entry.id, destination: 'INSTRUMENT_ORIGINE', receiptNumber: receipt?.number ?? null };
      }
      case 'CONTRE_ECRITURE': {
        const rev = this.ctx.ledger.reverse(input.ledgerEntryId!, `${input.reason} (${op.id}, validée par ${user.id})`, actor);
        return { ledgerEntryId: input.ledgerEntryId, reversalId: rev.id };
      }
      case 'APUREMENT_SUSPENS': {
        const s = this.suspense.get(input.suspenseId!)!;
        let ledgerEntryId: string;
        let paymentReference: string | undefined;
        if (input.mode === 'AFFECTATION') {
          const o = this.order(input.paymentReference);
          const m = this.ctx.treasury.completeMatch(o.id, { debit: 'COMPTE_ATTENTE', description: `Apurement du suspens ${s.id} au profit de ${o.paymentReference} (${op.id})`, actor, details: { suspenseId: s.id, operationId: op.id } });
          ledgerEntryId = m.ledgerEntryId;
          paymentReference = o.paymentReference;
        } else {
          // Paiement non affecté : les fonds sont restitués par le prestataire au payeur (créance sur le prestataire soldée).
          ledgerEntryId = this.ctx.ledger.postPair({
            eventType: 'SUSPENSE_RESTITUTION', description: `Restitution du suspens ${s.id} à l'émetteur d'origine (${op.id})`,
            sourceType: 'suspense', sourceId: s.id, debit: 'COMPTE_ATTENTE', credit: s.unappliedId ? 'FONDS_A_RECEVOIR_PRESTATAIRES' : 'COMPTE_PUBLIC_RECETTES', amount: s.amount,
          }).id;
        }
        this.suspense.update({ ...s, status: 'APURE', clearing: { operationId: op.id, mode: input.mode!, ...(paymentReference ? { paymentReference } : {}), ledgerEntryId, at: decision.at } });
        if (s.unappliedId && s.exceptionId) {
          // L'exception « paiement non affecté » est résolue par cette restitution validée à quatre yeux.
          const c = this.caseOf(s.exceptionId);
          this.cases.update({
            ...c, status: 'RESOLUE', decision: { approvedBy: user.id, approvedAt: decision.at, suspenseId: s.id },
            history: [...c.history, { at: decision.at, by: user.id, action: 'RESOLUTION_VALIDEE', note: `Restitution ${op.id}` }],
          });
        }
        this.ctx.audit.append({ actor, action: 'suspense.cleared', resourceType: 'suspense', resourceId: s.id, details: { mode: input.mode, paymentReference: paymentReference ?? null, operationId: op.id } });
        return { suspenseId: s.id, mode: input.mode, ledgerEntryId, paymentReference: paymentReference ?? null };
      }
      case 'PARAMETRE_NOMENCLATURE': {
        const n = input.nomenclature!;
        const entry = this.setNomenclature({ ...n, demo: !n.officialAct }, user.id);
        return { revenueCategory: n.revenueCategory, code: entry.code, version: entry.version, demo: entry.demo };
      }
    }
  }

  /* ---------------------------------------------------------- nomenclature */

  private setNomenclature(n: { revenueCategory: RevenueCategory; code: string; label: string; demo: boolean; officialAct?: string }, approvedBy?: string): NomenclatureEntry {
    this.nomenclatureVersion += 1;
    const entry: NomenclatureEntry = {
      revenueCategory: n.revenueCategory, code: n.code, label: n.label, demo: n.demo, ...(n.officialAct ? { officialAct: n.officialAct } : {}),
      version: this.nomenclatureVersion, updatedAt: this.now(), ...(approvedBy ? { approvedBy } : {}),
    };
    this.nomenclature.set(n.revenueCategory, entry);
    return entry;
  }

  listNomenclature(user: User) {
    authorize(user, 'tresor:nomenclature.read');
    return {
      version: this.nomenclatureVersion,
      entries: [...this.nomenclature.values()],
      notice: 'Codes marqués DÉMO : fictifs. La nomenclature officielle (OL 18/004 et textes d’application) est un acte requis ; tout changement passe par la double validation.',
    };
  }

  /* ---------------------------------------------------------- imputation */

  private settlementEntryOf(o: PaymentOrder): LedgerEntry | undefined {
    return this.ctx.ledger.list({ sourceId: o.id }).find((e) => e.eventType === 'SETTLEMENT_CREDITED' && !e.reversalOf);
  }

  /** Impute les paiements rapprochés non encore imputés (état « Comptabilisé »). */
  runImputation(user: User) {
    authorize(user, 'tresor:imputation.run');
    const imputed: Imputation[] = [];
    const unmapped: { paymentReference: string; revenueCategory: string }[] = [];
    for (const o of this.ctx.payments.orders.find((x) => x.status === 'RAPPROCHE')) {
      if (this.imputations.get(o.id)) continue;
      const ob = this.ctx.assessment.get(o.obligationId);
      const n = this.nomenclature.get(ob.revenueCategory);
      const entry = this.settlementEntryOf(o);
      if (!n || !entry) {
        unmapped.push({ paymentReference: o.paymentReference, revenueCategory: ob.revenueCategory });
        continue;
      }
      const receipt = this.ctx.receipts.byPaymentOrder(o.id);
      imputed.push(this.imputations.insert({
        id: o.id, paymentReference: o.paymentReference, ...(receipt ? { receiptNumber: receipt.number } : {}), ledgerEntryId: entry.id,
        entryDate: kinDate(entry.at), code: n.code, label: n.label, demo: n.demo, nomenclatureVersion: n.version, amount: o.amount,
        imputedAt: this.now(), imputedBy: user.id,
      }));
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.imputation.run', resourceType: 'imputation', resourceId: `run-${this.now()}`, details: { imputed: imputed.length, unmapped: unmapped.length } });
    return { imputed, unmapped };
  }

  private lastDaily(): DailyClosure | undefined {
    return this.daily.all().at(-1);
  }

  /** État comptable des paiements rapprochés : Rapproché → Comptabilisé (imputé), jour clôturé ou non. */
  accountingStatus(user: User) {
    authorize(user, 'tresor:closure.read');
    const closedSeq = this.lastDaily()?.toSeq ?? 0;
    const rows = this.ctx.payments.orders
      .find((o) => o.status === 'RAPPROCHE' || o.status === 'REMBOURSE' || this.imputations.get(o.id) !== undefined)
      .map((o) => {
        const imp = this.imputations.get(o.id);
        const entry = this.settlementEntryOf(o);
        return {
          paymentReference: o.paymentReference, paymentStatus: o.status, amount: o.amount,
          receiptNumber: this.ctx.receipts.byPaymentOrder(o.id)?.number ?? null,
          state: imp ? 'COMPTABILISE' : 'RAPPROCHE',
          code: imp?.code ?? null, demoCode: imp?.demo ?? null,
          ledgerEntryId: entry?.id ?? null, dayClosed: !!entry && entry.seq <= closedSeq,
        };
      });
    return {
      rows,
      counts: { rapproche: rows.filter((r) => r.state === 'RAPPROCHE').length, comptabilise: rows.filter((r) => r.state === 'COMPTABILISE').length },
    };
  }

  /* -------------------------------------------------------------- clôtures */

  private openCounts(user: User) {
    return {
      openExceptions: this.ctx.treasury.listExceptions(user).filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE').length,
      openSuspense: this.suspense.find((s) => s.status === 'OUVERT').length,
      unimputed: this.ctx.payments.orders.find((o) => o.status === 'RAPPROCHE' && !this.imputations.get(o.id)).length,
    };
  }

  /**
   * Clôture quotidienne signée : couvre toutes les écritures non encore clôturées datées (Kinshasa) du jour ou avant ;
   * empreinte = SHA-256(empreinte précédente + contenu canonique), signée Ed25519. Aucune écriture n'est modifiée.
   */
  closeDay(user: User, date: string): DailyClosure {
    authorize(user, 'tresor:closure.write');
    const today = kinDate(this.ctx.clock.now());
    if (date > today) throw unprocessable('CLOSURE_IN_FUTURE', `Impossible de clôturer une journée future (${date}).`);
    const last = this.lastDaily();
    if (last && date <= last.date) throw conflict('DAY_ALREADY_CLOSED', `Journée ${date} déjà couverte par la clôture ${last.id}.`);
    const fromSeq = (last?.toSeq ?? 0) + 1;
    const entries = this.ctx.ledger.list().filter((e) => e.seq >= fromSeq && kinDate(e.at) <= date);
    // Une journée antérieure encore ouverte se clôture d'abord : jamais deux journées dans une même clôture (les totaux
    // mensuels resteraient mélangés). Les écritures tardives d'une journée déjà clôturée suivent la clôture suivante.
    const earlier = entries.find((e) => kinDate(e.at) < date && (!last || kinDate(e.at) > last.date));
    if (earlier) {
      const day = kinDate(earlier.at);
      throw conflict('EARLIER_DAY_NOT_CLOSED', `La journée du ${day} comporte des écritures non clôturées : clôturez-la avant celle du ${date}.`, { date: day });
    }
    const toSeq = entries.at(-1)?.seq ?? fromSeq - 1;
    const totals = new Map<CurrencyCode, { debit: Money; credit: Money }>();
    for (const e of entries) for (const l of e.lines) {
      const m = Money.fromJSON(l.amount);
      const t = totals.get(m.currency) ?? { debit: Money.zero(m.currency), credit: Money.zero(m.currency) };
      if (l.side === 'DEBIT') t.debit = t.debit.add(m); else t.credit = t.credit.add(m);
      totals.set(m.currency, t);
    }
    const totalsJson = [...totals.entries()].map(([currency, t]) => ({ currency, debit: t.debit.toJSON(), credit: t.credit.toJSON(), balanced: t.debit.equals(t.credit) }));
    const content = {
      id: `CLJ-${date}`, date, fromSeq, toSeq, entries: entries.length, totals: totalsJson, balanced: totalsJson.every((t) => t.balanced),
      entriesHash: sha256Hex(entries.map((e) => e.hash).join('')), ledgerHeadHash: this.ctx.ledger.balance().headHash,
      ...this.openCounts(user), prevHash: last?.hash ?? GENESIS, closedBy: user.id, closedAt: this.now(),
    };
    const hash = sha256Hex(content.prevHash + canonicalJson(content));
    const closure = this.daily.append({ ...content, hash, signature: this.signHex(hash) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'ledger.day_closed', resourceType: 'closure', resourceId: closure.id, details: { hash, entries: closure.entries, fromSeq, toSeq } });
    this.ctx.comms.publish('ledger.day_closed', this.ctx.users.withRole('R17').map(userRecipient), { reference: closure.id }, { entity: 'TRESOR' });
    return closure;
  }

  /** Clôture mensuelle : toutes les écritures du mois clôturées au jour le jour et aucune écriture rapprochée non imputée. */
  closeMonth(user: User, month: string): MonthlyClosure {
    authorize(user, 'tresor:closure.write');
    if (month > kinDate(this.ctx.clock.now()).slice(0, 7)) throw unprocessable('CLOSURE_IN_FUTURE', `Mois futur : ${month}.`);
    if (this.monthly.get(`CLM-${month}`)) throw conflict('MONTH_ALREADY_CLOSED', `Mois ${month} déjà clôturé.`);
    const lastMonth = this.monthly.all().at(-1);
    if (lastMonth && month <= lastMonth.month) throw conflict('MONTH_ALREADY_CLOSED', `Une clôture mensuelle postérieure existe (${lastMonth.id}).`);
    const closedSeq = this.lastDaily()?.toSeq ?? 0;
    const inMonth = this.ctx.ledger.list().filter((e) => kinDate(e.at).startsWith(month));
    const uncovered = inMonth.filter((e) => e.seq > closedSeq);
    if (uncovered.length) throw conflict('DAYS_NOT_CLOSED', `${uncovered.length} écriture(s) du mois ${month} ne sont couvertes par aucune clôture quotidienne.`, { count: uncovered.length });
    const unimputed = this.ctx.payments.orders.find((o) => o.status === 'RAPPROCHE' && !this.imputations.get(o.id) && kinDate(this.settlementEntryOf(o)?.at ?? o.reconciledAt ?? this.now()).startsWith(month));
    if (unimputed.length) throw conflict('UNIMPUTED_ENTRIES', `${unimputed.length} paiement(s) rapproché(s) du mois ne sont pas imputés selon la nomenclature.`, { count: unimputed.length });
    const days = this.daily.find((d) => d.date.startsWith(month));
    // Totaux du mois = écritures DATÉES du mois (toutes couvertes par une clôture quotidienne, contrôlé ci-dessus),
    // jamais la somme de clôtures qui pourraient porter des écritures tardives d'un autre mois.
    const totals = new Map<CurrencyCode, { debit: Money; credit: Money }>();
    for (const e of inMonth) for (const l of e.lines) {
      const m = Money.fromJSON(l.amount);
      const cur = totals.get(m.currency) ?? { debit: Money.zero(m.currency), credit: Money.zero(m.currency) };
      totals.set(m.currency, l.side === 'DEBIT' ? { ...cur, debit: cur.debit.add(m) } : { ...cur, credit: cur.credit.add(m) });
    }
    const content = {
      id: `CLM-${month}`, month, dailyClosures: days.map((d) => d.id), dailyHashes: days.map((d) => d.hash),
      totals: [...totals.entries()].map(([currency, t]) => ({ currency, debit: t.debit.toJSON(), credit: t.credit.toJSON() })),
      imputed: this.imputations.find((i) => i.entryDate.startsWith(month)).length,
      prevHash: lastMonth?.hash ?? GENESIS, closedBy: user.id, closedAt: this.now(),
    };
    const hash = sha256Hex(content.prevHash + canonicalJson(content));
    const closure = this.monthly.append({ ...content, hash, signature: this.signHex(hash) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'ledger.month_closed', resourceType: 'closure', resourceId: closure.id, details: { hash, days: days.length } });
    return closure;
  }

  /** Recalcule la chaîne des clôtures et vérifie chaque signature. */
  verifyClosures(): { valid: boolean; brokenAt?: string } {
    const check = <T extends { id: string; prevHash: string; hash: string; signature: string }>(list: T[]) => {
      let prev = GENESIS;
      for (const c of list) {
        const { hash, signature, ...content } = c;
        if (content.prevHash !== prev || sha256Hex(prev + canonicalJson(content)) !== hash) return c.id;
        if (!verify(null, Buffer.from(hash), this.publicKey, Buffer.from(signature, 'base64url'))) return c.id;
        prev = hash;
      }
      return undefined;
    };
    const broken = check(this.daily.all()) ?? check(this.monthly.all());
    return broken ? { valid: false, brokenAt: broken } : { valid: true };
  }

  listClosures(user: User) {
    authorize(user, 'tresor:closure.read');
    const today = kinDate(this.ctx.clock.now());
    const last = this.lastDaily();
    const pending = this.ctx.ledger.list().filter((e) => e.seq > (last?.toSeq ?? 0));
    return {
      daily: [...this.daily.all()].reverse(), monthly: [...this.monthly.all()].reverse(), chain: this.verifyClosures(),
      today, lastClosedDate: last?.date ?? null, unclosedEntries: pending.length,
      oldestUnclosedDate: pending[0] ? kinDate(pending[0].at) : null,
      algorithm: 'Ed25519', publicKeyPem: this.publicKeyPem(),
    };
  }

  /* ---------------------------------------------------------------- export */

  /** Export signé vers la comptabilité publique : écritures imputées, sans aucune donnée nominative. */
  exportAccounting(user: User, q: { format: 'csv' | 'json'; from?: string; to?: string }) {
    authorize(user, 'tresor:export');
    const closedSeq = this.lastDaily()?.toSeq ?? 0;
    const rows = this.imputations.all()
      .filter((i) => (!q.from || i.entryDate >= q.from) && (!q.to || i.entryDate <= q.to))
      .sort((a, b) => a.ledgerEntryId.localeCompare(b.ledgerEntryId))
      .map((i) => {
        const e = this.ctx.ledger.get(i.ledgerEntryId)!;
        const debit = e.lines.find((l) => l.side === 'DEBIT')!;
        const credit = e.lines.find((l) => l.side === 'CREDIT')!;
        return {
          date: i.entryDate, piece: e.id, paymentReference: i.paymentReference, receiptNumber: i.receiptNumber ?? '',
          imputationCode: i.code, demoCode: i.demo, nomenclatureVersion: i.nomenclatureVersion,
          debitAccount: debit.account, creditAccount: credit.account, amount: i.amount.amount, currency: i.amount.currency,
          dayClosed: e.seq <= closedSeq, ledgerHash: e.hash,
        };
      });
    const generatedAt = this.now();
    let body: string;
    if (q.format === 'csv') {
      const head = ['date', 'piece', 'reference_paiement', 'quittance', 'code_imputation', 'code_demo', 'version_nomenclature', 'compte_debit', 'compte_credit', 'montant', 'devise', 'jour_cloture', 'empreinte_ecriture'];
      const esc = (v: unknown) => { const s = String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      body = [head.join(';'), ...rows.map((r) => [r.date, r.piece, r.paymentReference, r.receiptNumber, r.imputationCode, r.demoCode ? 'OUI' : 'NON', r.nomenclatureVersion, r.debitAccount, r.creditAccount, r.amount, r.currency, r.dayClosed ? 'OUI' : 'NON', r.ledgerHash].map(esc).join(';'))].join('\n') + '\n';
    } else {
      body = canonicalJson(rows);
    }
    const sha256 = sha256Hex(body);
    const signature = this.signHex(sha256);
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.export', resourceType: 'export', resourceId: sha256.slice(0, 16), details: { format: q.format, rows: rows.length, from: q.from ?? null, to: q.to ?? null, sha256 } });
    return {
      format: q.format, generatedAt, from: q.from ?? null, to: q.to ?? null, count: rows.length, rows, body, sha256, signature, algorithm: 'Ed25519' as const,
      demo: rows.some((r) => r.demoCode),
      notice: 'Codes d’imputation de démonstration (fictifs) signalés « code_demo = OUI » : non opposables à la comptabilité publique.',
    };
  }

  /* ----------------------------------------------------------- quittances */

  receiptView(user: User, ref: string) {
    const r = this.ctx.receipts.require(ref);
    authorize(user, 'tresor:receipt.read', { taxpayerId: r.taxpayerId });
    const chain: { number: string; status: string }[] = [];
    let cur: Receipt | undefined = r.replaces ? this.ctx.receipts.find(r.replaces) : undefined;
    while (cur) { chain.unshift({ number: cur.number, status: cur.status }); cur = cur.replaces ? this.ctx.receipts.find(cur.replaces) : undefined; }
    const order = this.ctx.payments.orders.get(r.paymentOrderId);
    return {
      number: r.number, code: r.code, status: r.status, mention: r.mention, amount: r.amount, paymentReference: r.paymentReference,
      paymentStatus: order?.status ?? null, revenueCategory: r.revenueCategory, administration: r.administration, issuedAt: r.issuedAt,
      finalizedAt: r.finalizedAt ?? null, replaces: r.replaces ?? null, replacedBy: r.replacedBy ?? null, previous: chain,
      decision: r.decision ?? null, duplicates: r.duplicates ?? 0, lastDuplicateAt: r.lastDuplicateAt ?? null,
      pendingOperations: this.operations.find((o) => o.status === 'PROPOSEE' && (o.target.key === `receipt:${r.id}` || o.target.key === `payment:${r.paymentOrderId}`)).map((o) => o.id),
    };
  }

  duplicate(user: User, ref: string) {
    const r = this.ctx.receipts.require(ref);
    authorize(user, 'tresor:receipt.duplicate', { taxpayerId: r.taxpayerId });
    return this.ctx.receipts.duplicate(r.id, user.id);
  }

  verificationJournal(user: User) {
    authorize(user, 'tresor:verification.journal');
    return this.ctx.receipts.verificationJournal();
  }

  /* -------------------------------------------------------------- synthèse */

  overview(user: User) {
    authorize(user, 'tresor:overview');
    const ex = this.ctx.treasury.listExceptions(user);
    const open = ex.filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE');
    const susp = this.suspense.find((s) => s.status === 'OUVERT').map((s) => this.suspenseView(s));
    const last = this.lastDaily();
    return {
      exceptions: { open: open.length, overdue: open.filter((e) => e.overdue === true).length, unassigned: open.filter((e) => !e.assignee).length },
      suspense: { open: susp.length, totals: sumByCurrency(susp.map((s) => s.amount)), oldestDays: susp.reduce((m, s) => Math.max(m, s.ageDays ?? 0), 0) },
      operations: { pending: this.operations.find((o) => o.status === 'PROPOSEE').length },
      closures: { lastClosedDate: last?.date ?? null, lastHash: last?.hash ?? null, chainValid: this.verifyClosures().valid },
      accounting: { imputed: this.imputations.count(), unimputed: this.ctx.payments.orders.find((o) => o.status === 'RAPPROCHE' && !this.imputations.get(o.id)).length },
    };
  }

  /* ----------------------------------------------------------------- démo */

  seedDemo(): void {
    this.ctx.users.add({ id: 'tresor-chef-comptable', name: 'Chef comptable — Trésor, second valideur (démo)', roles: ['R17'], entity: 'TRESOR' });
    this.ctx.users.add({ id: 'tresor-analyste-2', name: 'Analyste de rapprochement n° 2 (démo)', roles: ['R18'], entity: 'TRESOR' });
    const demo: [RevenueCategory, string, string][] = [
      ['IMPOT_PROVINCIAL', 'DEMO-IMP-701', '[DÉMO] Impôts provinciaux — code fictif'],
      ['INTERET_COMMUN', 'DEMO-IC-702', '[DÉMO] Impôts d’intérêt commun — code fictif'],
      ['DROIT_ADMINISTRATIF', 'DEMO-DA-703', '[DÉMO] Droits et actes administratifs — code fictif'],
      ['REDEVANCE_SERVICE', 'DEMO-RS-704', '[DÉMO] Redevances de service — code fictif'],
      ['CONCESSION_DOMANIALE', 'DEMO-CD-705', '[DÉMO] Concessions et domaine public — code fictif'],
      ['RECETTE_ETD', 'DEMO-ETD-706', '[DÉMO] Recettes des ETD — code fictif'],
    ];
    for (const [revenueCategory, code, label] of demo) this.setNomenclature({ revenueCategory, code, label, demo: true });
    // Un suspens de démonstration (crédit non identifié, 4 jours) pour illustrer l'ancienneté et l'apurement.
    const valueDate = kinDate(new Date(this.ctx.clock.now().getTime() - 4 * DAY_MS));
    this.openSuspense({
      accountAlias: 'KIN-DGIPK-RECETTES-01', amount: { amount: '75.00', currency: 'USD' }, valueDate, statementId: 'REL-DEMO-SUSPENS',
      justification: '[DÉMONSTRATION] Crédit sans référence de paiement sur relevé fictif ; recherche prestataire en cours.',
      openedBy: 'u-analyste-rappro', approvedBy: 'u-tresor', demo: true,
    });
  }
}
