/**
 * Relevés de règlement et rapprochement à trois voies (ch. 20) :
 * obligation (dû) ↔ confirmation prestataire (payé) ↔ crédit sur compte public (arrivé), puis écriture.
 * Tout ce qui ne s'apparie pas devient une exception ; rien n'est forcé.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AuditActor, AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import { DAY_MS, type Clock } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { conflict } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AssessmentService } from '../assessment/service.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient, userRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import type { PaymentService } from '../payments/service.js';
import type { ReceiptService } from '../receipts/service.js';
import type { VaultService } from '../vault/service.js';
import type { LedgerService } from './ledger.js';

export interface StatementLine {
  accountAlias: string;
  amount: MoneyJSON;
  valueDate: string;
  paymentReference: string;
}

export type ExceptionType =
  | 'ORPHAN_CREDIT' | 'CREDIT_WITHOUT_CONFIRMATION' | 'DUPLICATE_CREDIT' | 'WRONG_ACCOUNT' | 'UNKNOWN_ACCOUNT' | 'AMOUNT_MISMATCH' | 'MISSING_SETTLEMENT' | 'PROVIDER_AMBIGUOUS'
  | 'UNAPPLIED_PAYMENT';

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
  matched: { paymentReference: string; receiptNumber: string; obligationId: string; amount: MoneyJSON }[];
  exceptions: ReconciliationException[];
}

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

    const result: StatementResult = { statementId: input.statementId, importedAt: now, importedBy: user.id, lines: input.lines.length, matched: [], exceptions: [] };
    const open = (type: ExceptionType, line: StatementLine, detail: string) => {
      const ex = this.exceptions.insert({
        id: this.ids.next('EXC'), type, statementId: input.statementId, paymentReference: line.paymentReference, line, detail, status: 'OUVERTE', openedAt: now,
      });
      result.exceptions.push(ex);
      this.audit.append({ actor, action: 'reconciliation.exception.opened', resourceType: 'reconciliation_exception', resourceId: ex.id, outcome: 'FAILURE', details: { type, paymentReference: line.paymentReference } });
    };

    for (const line of input.lines) {
      const account = this.vault.current(line.accountAlias);
      if (!account) {
        open('UNKNOWN_ACCOUNT', line, `Compte ${line.accountAlias} inconnu du coffre.`);
        continue;
      }
      const order = this.payments.byReference(line.paymentReference);
      if (!order) {
        open('ORPHAN_CREDIT', line, 'Crédit sans référence de paiement connue : recherche prestataire.');
        continue;
      }
      if (order.status === 'RAPPROCHE' || order.status === 'REGLE') {
        open('DUPLICATE_CREDIT', line, `Crédit en double pour ${order.paymentReference}.`);
        continue;
      }
      if (order.status !== 'CONFIRME') {
        open('CREDIT_WITHOUT_CONFIRMATION', line, `Crédit reçu sans confirmation prestataire vérifiée (statut ${order.status}).`);
        continue;
      }
      if (order.beneficiaryAlias !== line.accountAlias) {
        open('WRONG_ACCOUNT', line, `Crédit sur ${line.accountAlias} au lieu de ${order.beneficiaryAlias}.`);
        continue;
      }
      let credited: Money | undefined;
      try {
        credited = Money.fromJSON(line.amount);
      } catch {
        credited = undefined;
      }
      if (!credited || !credited.equals(Money.fromJSON(order.amount))) {
        open('AMOUNT_MISMATCH', line, `Montant crédité ${line.amount.amount} ${line.amount.currency} ≠ ${order.amount.amount} ${order.amount.currency}.`);
        continue;
      }
      // Appariement complet : écriture, RAPPROCHE, quittance définitive, obligation soldée.
      result.matched.push(this.completeMatch(order.id, {
        debit: 'COMPTE_PUBLIC_RECETTES', description: `Crédit ${line.accountAlias} (${input.statementId}) pour ${order.paymentReference}`,
        actor, details: { statementId: input.statementId },
      }));
    }
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
