/**
 * Relevés de règlement et rapprochement à trois voies (ch. 20) :
 * obligation (dû) ↔ confirmation prestataire (payé) ↔ crédit sur compte public (arrivé), puis écriture.
 * Tout ce qui ne s'apparie pas devient une exception ; rien n'est forcé.
 */
import { AmountPrecisionError, Money, type MoneyJSON } from '@mosolo/shared';
import type { AuditActor, AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import { DAY_MS, type Clock } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { conflict, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AssessmentService } from '../assessment/service.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient, userRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import type { PaymentOrder, PaymentService, UnappliedPayment } from '../payments/service.js';
import type { ReceiptService } from '../receipts/service.js';
import type { VaultService } from '../vault/service.js';
import type { LedgerService } from './ledger.js';

export interface StatementLine {
  accountAlias: string;
  amount: MoneyJSON;
  valueDate: string;
  paymentReference: string;
  /** Contrepartie (donneur d'ordre) : empreinte fournie par la banque ou le prestataire ; destination d'une restitution. */
  counterparty?: string;
  /** Version du compte du coffre en vigueur à l'import : renseignée par le système, jamais saisie. */
  accountVersion?: number;
}

export type ExceptionType =
  | 'ORPHAN_CREDIT' | 'CREDIT_WITHOUT_CONFIRMATION' | 'DUPLICATE_CREDIT' | 'WRONG_ACCOUNT' | 'UNKNOWN_ACCOUNT' | 'AMOUNT_MISMATCH' | 'MISSING_SETTLEMENT' | 'PROVIDER_AMBIGUOUS'
  | 'UNAPPLIED_PAYMENT'
  /** Crédit reçu alors que le compte du coffre a changé de version depuis l'émission de la référence. */
  | 'ACCOUNT_VERSION_MISMATCH'
  /** Crédit d'un paiement confirmé dont la quittance ne peut devenir définitive (annulée, signalée…) : rien n'est passé. */
  | 'RECEIPT_NOT_FINALIZABLE';

/** Cycle de traitement d'une exception (§ 20, C3-113) : ouverte → en cours → résolue ou classée avec motif. */
export type ExceptionStatus = 'OUVERTE' | 'EN_COURS' | 'RESOLUE' | 'CLASSEE';

/** Les quatre files d'exception du § 20 (Cahier) / module 30. */
export type ExceptionQueue = 'PAIEMENT_SANS_OBLIGATION' | 'OBLIGATION_SANS_REGLEMENT' | 'REGLEMENT_SANS_PAIEMENT' | 'ECART_MONTANT';

export const EXCEPTION_QUEUE: Record<ExceptionType, ExceptionQueue> = {
  DUPLICATE_CREDIT: 'PAIEMENT_SANS_OBLIGATION',
  UNAPPLIED_PAYMENT: 'PAIEMENT_SANS_OBLIGATION',
  MISSING_SETTLEMENT: 'OBLIGATION_SANS_REGLEMENT',
  PROVIDER_AMBIGUOUS: 'OBLIGATION_SANS_REGLEMENT',
  ORPHAN_CREDIT: 'REGLEMENT_SANS_PAIEMENT',
  CREDIT_WITHOUT_CONFIRMATION: 'REGLEMENT_SANS_PAIEMENT',
  UNKNOWN_ACCOUNT: 'REGLEMENT_SANS_PAIEMENT',
  AMOUNT_MISMATCH: 'ECART_MONTANT',
  WRONG_ACCOUNT: 'ECART_MONTANT',
  ACCOUNT_VERSION_MISMATCH: 'ECART_MONTANT',
  RECEIPT_NOT_FINALIZABLE: 'REGLEMENT_SANS_PAIEMENT',
};

export interface ReconciliationException {
  id: string;
  type: ExceptionType;
  statementId?: string;
  paymentReference?: string;
  line?: StatementLine;
  detail: string;
  status: ExceptionStatus;
  openedAt: string;
  computed?: boolean;
  queue?: ExceptionQueue;
  /** Champs de traitement ajoutés par le module Trésor (affectation, échéance, résolution). */
  [workflow: string]: unknown;
}

export interface StatementResult {
  statementId: string;
  importedAt: string;
  importedBy: string;
  lines: number;
  matched: { paymentReference: string; receiptNumber: string; obligationId: string; amount: MoneyJSON; accountVersion?: number }[];
  /** Lignes ayant réglé un paiement non affecté (doublon, retard) : fonds arrivés, restitution unique ensuite. */
  settledUnapplied: { unappliedId: string; paymentReference: string; amount: MoneyJSON; ledgerEntryId: string }[];
  exceptions: ReconciliationException[];
  /** Lignes réclamées par un module (bordereau de versement d'un point agréé…) et appariées automatiquement. */
  claimed?: Record<string, unknown>[];
}

/**
 * Réclamation, SANS ÉCRITURE (phase 1), des lignes de relevé dont la référence n'est pas une référence de paiement
 * (ex. bordereau de versement d'un point agréé). Ligne réclamée : appariée par `apply` (phase 2), ou exception typée
 * (`exceptions`) à la place du « crédit orphelin » générique — jamais ignorée en silence.
 */
export interface StatementClaimant {
  (statementId: string, lines: StatementLine[]): {
    matched: StatementLine[];
    exceptions: { line: StatementLine; type: ExceptionType; detail: string }[];
    apply: (actor: AuditActor) => Record<string, unknown>[];
  };
}

type LinePlan =
  | { kind: 'EXCEPTION'; type: ExceptionType; line: StatementLine; detail: string }
  | { kind: 'MATCH'; order: PaymentOrder; line: StatementLine }
  | { kind: 'UNAPPLIED'; u: UnappliedPayment; line: StatementLine };

interface StoredStatement {
  id: string;
  fingerprint: string;
  result: StatementResult;
}

export class TreasuryService {
  readonly statements = new InMemoryRepository<StoredStatement>();
  readonly exceptions = new InMemoryRepository<ReconciliationException>();
  private readonly ids = new IdGenerator();
  /** Surcouche de traitement (affectation, statut, résolution) fournie par le module Trésor avancé. */
  private overlay: ((e: ReconciliationException) => ReconciliationException) | undefined;
  private readonly claimants: StatementClaimant[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly users: UserDirectory,
    private readonly payments: PaymentService,
    private readonly assessment: AssessmentService,
    private readonly receipts: ReceiptService,
    private readonly vault: VaultService,
    private readonly ledger: LedgerService,
    private readonly taxpayers: TaxpayerService,
  ) {}

  importStatement(user: User, input: { statementId: string; lines: StatementLine[] }): { replayed: boolean; result: StatementResult } {
    authorize(user, 'settlement.import');
    const fingerprint = sha256Hex(canonicalJson(input.lines));
    const existing = this.statements.get(input.statementId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw conflict('STATEMENT_ALREADY_IMPORTED', `Relevé ${input.statementId} déjà importé avec un contenu différent.`);
      return { replayed: true, result: existing.result };
    }
    const now = this.clock.now().toISOString();
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    this.audit.append({ actor, action: 'settlement.received', resourceType: 'statement', resourceId: input.statementId, details: { lines: input.lines.length } });

    // Phase 1 — validation et plan, SANS AUCUNE ÉCRITURE : tout le relevé est accepté ou rien ne l'est.
    // Montants lus strictement (aucun arrondi : « 149.995 » n'est jamais 150.00).
    input.lines.forEach((line, i) => {
      try {
        Money.parseStrict(line.amount);
      } catch (e) {
        throw unprocessable(e instanceof AmountPrecisionError ? 'AMOUNT_PRECISION' : 'INVALID_AMOUNT', `Ligne ${i + 1} du relevé ${input.statementId} : ${(e as Error).message}. Aucune ligne importée.`, { line: i + 1 });
      }
    });
    const plans: LinePlan[] = [];
    const matchedOrders = new Set<string>();
    const usedUnapplied = new Set<string>();
    for (const raw of input.lines) {
      const account = this.vault.current(raw.accountAlias);
      const line: StatementLine = { ...raw, ...(account ? { accountVersion: account.version } : {}) };
      const exception = (type: ExceptionType, detail: string) => plans.push({ kind: 'EXCEPTION', type, line, detail });
      if (!account) {
        exception('UNKNOWN_ACCOUNT', `Compte ${line.accountAlias} inconnu du coffre.`);
        continue;
      }
      const credited = Money.parseStrict(line.amount);
      const order = this.payments.byReference(line.paymentReference);
      if (!order) {
        exception('ORPHAN_CREDIT', 'Crédit sans référence de paiement connue : recherche prestataire.');
        continue;
      }
      if (order.status === 'CONFIRME' && !matchedOrders.has(order.id)) {
        if (order.beneficiaryAlias !== line.accountAlias) {
          exception('WRONG_ACCOUNT', `Crédit sur ${line.accountAlias} au lieu de ${order.beneficiaryAlias}.`);
          continue;
        }
        if (!credited.equals(Money.fromJSON(order.amount))) {
          exception('AMOUNT_MISMATCH', `Montant crédité ${line.amount.amount} ${line.amount.currency} ≠ ${order.amount.amount} ${order.amount.currency}.`);
          continue;
        }
        if (order.beneficiaryAccountVersion !== undefined && order.beneficiaryAccountVersion !== account.version) {
          exception('ACCOUNT_VERSION_MISMATCH', `Référence ${order.paymentReference} émise sous la version ${order.beneficiaryAccountVersion} du compte ${line.accountAlias}, crédit reçu sous la version ${account.version} : vérification du changement de compte requise.`);
          continue;
        }
        const blocker = this.matchBlocker(order);
        if (blocker) {
          exception('RECEIPT_NOT_FINALIZABLE', blocker);
          continue;
        }
        matchedOrders.add(order.id);
        plans.push({ kind: 'MATCH', order, line });
        continue;
      }
      // Doublon ou paiement tardif déjà en compte d'attente : la ligne RÈGLE ce paiement non affecté (un seul suspens,
      // une seule restitution possible), elle n'ouvre jamais un second suspens.
      const u = this.payments.findSettleableUnapplied(line.paymentReference, credited, line.accountAlias, usedUnapplied);
      if (u) {
        usedUnapplied.add(u.id);
        plans.push({ kind: 'UNAPPLIED', u, line });
        continue;
      }
      if (order.status === 'RAPPROCHE' || order.status === 'REGLE' || matchedOrders.has(order.id)) {
        exception('DUPLICATE_CREDIT', `Crédit en double pour ${order.paymentReference}.`);
        continue;
      }
      exception('CREDIT_WITHOUT_CONFIRMATION', `Crédit reçu sans confirmation prestataire vérifiée (statut ${order.status}).`);
    }
    // Crédits orphelins soumis aux modules (bordereaux de versement) : appariés ou requalifiés, toujours sans écriture ici.
    const applies: ((a: AuditActor) => Record<string, unknown>[])[] = [];
    for (const claim of this.claimants) {
      const orphans = plans.filter((p): p is Extract<LinePlan, { kind: 'EXCEPTION' }> => p.kind === 'EXCEPTION' && p.type === 'ORPHAN_CREDIT').map((p) => p.line);
      if (orphans.length === 0) break;
      const r = claim(input.statementId, orphans);
      const matched = new Set(r.matched);
      const requalified = new Map(r.exceptions.map((e) => [e.line, e]));
      for (let i = plans.length - 1; i >= 0; i--) {
        const p = plans[i]!;
        if (p.kind !== 'EXCEPTION' || p.type !== 'ORPHAN_CREDIT') continue;
        if (matched.has(p.line)) plans.splice(i, 1);
        else if (requalified.has(p.line)) plans[i] = { kind: 'EXCEPTION', ...requalified.get(p.line)! };
      }
      applies.push(r.apply);
    }

    // Phase 2 — application.
    const result: StatementResult = { statementId: input.statementId, importedAt: now, importedBy: user.id, lines: input.lines.length, matched: [], settledUnapplied: [], exceptions: [] };
    for (const p of plans) {
      if (p.kind === 'EXCEPTION') {
        const ex = this.exceptions.insert({
          id: this.ids.next('EXC'), type: p.type, statementId: input.statementId, paymentReference: p.line.paymentReference, line: p.line, detail: p.detail, status: 'OUVERTE', openedAt: now,
        });
        result.exceptions.push(ex);
        this.audit.append({ actor, action: 'reconciliation.exception.opened', resourceType: 'reconciliation_exception', resourceId: ex.id, outcome: 'FAILURE', details: { type: p.type, paymentReference: p.line.paymentReference } });
      } else if (p.kind === 'MATCH') {
        // Appariement complet : écriture, RAPPROCHE, quittance définitive, obligation soldée.
        const m = this.completeMatch(p.order.id, {
          debit: 'COMPTE_PUBLIC_RECETTES', description: `Crédit ${p.line.accountAlias} (${input.statementId}) pour ${p.order.paymentReference}`,
          actor, details: { statementId: input.statementId, accountVersion: p.line.accountVersion ?? null },
        });
        const { ledgerEntryId: _l, ...matched } = m;
        result.matched.push({ ...matched, ...(p.line.accountVersion !== undefined ? { accountVersion: p.line.accountVersion } : {}) });
      } else {
        result.settledUnapplied.push(this.settleUnapplied(p.u, { statementId: input.statementId, ...(p.line.accountVersion !== undefined ? { accountVersion: p.line.accountVersion } : {}), actor }));
      }
    }
    const claimed = applies.flatMap((a) => a(actor));
    if (claimed.length > 0) result.claimed = claimed;
    if (result.exceptions.length > 0) {
      this.comms.publish('reconciliation.exception.opened', this.users.withRole('R18').map(userRecipient), { reference: input.statementId }, { entity: 'TRESOR' });
    }
    this.statements.insert({ id: input.statementId, fingerprint, result });
    return { replayed: false, result };
  }

  /**
   * Clôt la chaîne d'un paiement confirmé : écriture de règlement, RAPPROCHE, quittance définitive, obligation soldée.
   * `debit` : compte public (relevé) ou compte d'attente (apurement d'un suspens décidé à quatre yeux).
   */
  completeMatch(orderId: string, opts: { debit: 'COMPTE_PUBLIC_RECETTES' | 'COMPTE_ATTENTE'; description: string; actor: AuditActor; details?: Record<string, unknown> }) {
    const order = this.payments.orders.get(orderId);
    if (!order || order.status !== 'CONFIRME') throw conflict('PAYMENT_NOT_CONFIRMED', `Le paiement ${order?.paymentReference ?? orderId} n'est pas au statut confirmé.`);
    // Tout est vérifié AVANT la moindre écriture : jamais d'écriture ni de RAPPROCHE sans quittance définitive.
    const blocker = this.matchBlocker(order);
    if (blocker) throw conflict('RECEIPT_NOT_FINALIZABLE', blocker);
    const entry = this.ledger.postPair({
      eventType: 'SETTLEMENT_CREDITED', description: opts.description,
      sourceType: 'payment_order', sourceId: order.id, debit: opts.debit, credit: 'FONDS_A_RECEVOIR_PRESTATAIRES', amount: order.amount,
    });
    this.payments.settleAndReconcile(order.id, entry.id);
    const receipt = this.receipts.finalize(order.id);
    // Échéancier : l'obligation n'est soldée que lorsque le cumul payé atteint son montant. Un paiement reçu sur une
    // obligation depuis rectifiée compte pour l'obligation en vigueur ; une obligation ANNULEE ne change jamais d'état.
    const ob = this.assessment.get(this.payments.currentObligationId(order.obligationId));
    const fully = this.payments.paidOn(ob.id).compare(Money.fromJSON(ob.amount)) >= 0;
    const obligation = ob.status === 'ANNULEE' ? ob : this.assessment.setStatus(ob.id, fully ? 'SOLDEE' : 'PARTIELLEMENT_PAYEE');
    this.audit.append({ actor: opts.actor, action: 'reconciliation.matched', resourceType: 'payment_order', resourceId: order.id, details: { ...opts.details, receipt: receipt.number, ledgerEntryId: entry.id } });
    this.comms.publish('receipt.finalized', [taxpayerRecipient(this.taxpayers.get(order.taxpayerId))], { reference: receipt.number }, { entity: obligation.entity });
    return { paymentReference: order.paymentReference, receiptNumber: receipt.number, obligationId: obligation.id, amount: order.amount, ledgerEntryId: entry.id };
  }

  /**
   * Motif empêchant d'apparier un paiement confirmé (sans rien écrire) : quittance absente ou non finalisable,
   * obligation ou contribuable introuvable. `undefined` : appariement possible.
   */
  matchBlocker(order: PaymentOrder): string | undefined {
    const r = this.receipts.byPaymentOrder(order.id);
    if (!r) return `Aucune quittance pour ${order.paymentReference} : appariement impossible.`;
    if (r.status !== 'PROVISOIRE' && r.status !== 'DEFINITIVE') return `Quittance ${r.number} au statut ${r.status} pour ${order.paymentReference} : elle ne peut devenir définitive, aucun appariement.`;
    try {
      this.assessment.get(this.payments.currentObligationId(order.obligationId));
      this.taxpayers.get(order.taxpayerId);
    } catch (e) {
      return `Paiement ${order.paymentReference} : ${(e as Error).message}`;
    }
    return undefined;
  }

  /**
   * Règlement par le prestataire d'un paiement non affecté (doublon, retard) : les fonds arrivent sur le compte public
   * (débit compte public, crédit créance sur le prestataire). Le suspens déjà ouvert reste le SEUL restituable.
   */
  settleUnapplied(u: UnappliedPayment, opts: { statementId: string; accountVersion?: number; actor: AuditActor }) {
    const st = this.payments.unappliedState(u.id);
    if (st?.settled) throw conflict('UNAPPLIED_ALREADY_SETTLED', `Le paiement non affecté ${u.id} est déjà réglé (${st.settled.statementId}).`);
    if (st?.restituted) throw conflict('UNAPPLIED_ALREADY_RESTITUTED', `Le paiement non affecté ${u.id} est déjà restitué.`);
    const entry = this.ledger.postPair({
      eventType: 'UNAPPLIED_SETTLED', description: `Règlement prestataire du paiement non affecté ${u.id} (${u.paymentReference}) sur relevé ${opts.statementId}`,
      sourceType: 'unapplied_payment', sourceId: u.id, debit: 'COMPTE_PUBLIC_RECETTES', credit: 'FONDS_A_RECEVOIR_PRESTATAIRES', amount: u.amount,
    });
    this.payments.markUnappliedSettled(u.id, {
      statementId: opts.statementId, ledgerEntryId: entry.id, at: this.clock.now().toISOString(), ...(opts.accountVersion !== undefined ? { accountVersion: opts.accountVersion } : {}),
    });
    this.audit.append({ actor: opts.actor, action: 'reconciliation.unapplied_settled', resourceType: 'unapplied_payment', resourceId: u.id, details: { statementId: opts.statementId, paymentReference: u.paymentReference, ledgerEntryId: entry.id } });
    return { unappliedId: u.id, paymentReference: u.paymentReference, amount: u.amount, ledgerEntryId: entry.id };
  }

  /** Branche un module réclamant des lignes de relevé à référence non-paiement (bordereaux des points agréés). */
  addStatementClaimant(fn: StatementClaimant): void {
    this.claimants.push(fn);
  }

  /** Branche la surcouche de traitement des exceptions (module Trésor avancé). */
  setExceptionOverlay(fn: (e: ReconciliationException) => ReconciliationException): void {
    this.overlay = fn;
  }

  /** Exceptions brutes (stockées + calculées), avant surcouche de traitement. */
  rawExceptions(): ReconciliationException[] {
    const now = this.clock.now();
    const missing: ReconciliationException[] = this.payments.orders
      .find((o) => o.status === 'CONFIRME' && !!o.confirmedAt && now.getTime() - new Date(o.confirmedAt).getTime() > DAY_MS)
      .map((o) => ({
        id: `EXC-MS-${o.id}`, type: 'MISSING_SETTLEMENT', paymentReference: o.paymentReference,
        detail: `Confirmation du ${o.confirmedAt} sans crédit constaté à J+1 : relance prestataire.`, status: 'OUVERTE', openedAt: new Date(new Date(o.confirmedAt!).getTime() + DAY_MS).toISOString(), computed: true,
      }));
    // Attente prestataire (résultat opérateur inconnu) non résolue : aucune quittance tant qu'elle reste ouverte.
    const held: ReconciliationException[] = this.payments.unresolvedHolds().map((h) => ({
      id: `EXC-HOLD-${h.id}`, type: 'PROVIDER_AMBIGUOUS', ...(h.paymentReference ? { paymentReference: h.paymentReference } : {}),
      detail: `Résultat opérateur inconnu signalé par ${h.provider} le ${h.receivedAt} : interroger la résolution prestataire, puis attendre la confirmation signée ou le relevé.`,
      status: 'OUVERTE', openedAt: h.receivedAt, computed: true,
    }));
    // Paiement reçu mais non affecté (doublon, référence expirée, obligation couverte ou rectifiée) : à rembourser.
    const unapplied: ReconciliationException[] = this.payments.unappliedPayments.all().map((u) => ({
      id: `EXC-NAFF-${u.id}`, type: 'UNAPPLIED_PAYMENT', paymentReference: u.paymentReference,
      detail: `Paiement ${u.provider} ${u.providerTxnId} de ${u.amount.amount} ${u.amount.currency} non affecté (${u.reason}) : fonds en compte d'attente, remboursement vers l'instrument d'origine à décider.`,
      status: 'OUVERTE', openedAt: u.receivedAt, computed: true, unappliedId: u.id,
    }));
    return [...this.exceptions.all(), ...missing, ...held, ...unapplied].map((e) => ({ ...e, queue: EXCEPTION_QUEUE[e.type] }));
  }

  /** Exceptions ouvertes + « règlement manquant » calculé (confirmation sans crédit après J+1). */
  listExceptions(user: User): ReconciliationException[] {
    authorize(user, 'reconciliation.read');
    const all = this.rawExceptions();
    return this.overlay ? all.map(this.overlay) : all;
  }

}
