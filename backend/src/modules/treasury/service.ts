/**
 * Relevés de règlement et rapprochement à trois voies (ch. 20) :
 * obligation (dû) ↔ confirmation prestataire (payé) ↔ crédit sur compte public (arrivé), puis écriture.
 * Tout ce qui ne s'apparie pas devient une exception ; rien n'est forcé.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
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
  | 'ORPHAN_CREDIT' | 'CREDIT_WITHOUT_CONFIRMATION' | 'DUPLICATE_CREDIT' | 'WRONG_ACCOUNT' | 'UNKNOWN_ACCOUNT' | 'AMOUNT_MISMATCH' | 'MISSING_SETTLEMENT' | 'PROVIDER_AMBIGUOUS';

export interface ReconciliationException {
  id: string;
  type: ExceptionType;
  statementId?: string;
  paymentReference?: string;
  line?: StatementLine;
  detail: string;
  status: 'OUVERTE';
  openedAt: string;
  computed?: boolean;
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
      const entry = this.ledger.postPair({
        eventType: 'SETTLEMENT_CREDITED', description: `Crédit ${line.accountAlias} (${input.statementId}) pour ${order.paymentReference}`,
        sourceType: 'payment_order', sourceId: order.id, debit: 'COMPTE_PUBLIC_RECETTES', credit: 'FONDS_A_RECEVOIR_PRESTATAIRES', amount: order.amount,
      });
      this.payments.settleAndReconcile(order.id, entry.id);
      const receipt = this.receipts.finalize(order.id);
      const obligation = this.assessment.setStatus(order.obligationId, 'SOLDEE');
      this.audit.append({ actor, action: 'reconciliation.matched', resourceType: 'payment_order', resourceId: order.id, details: { statementId: input.statementId, receipt: receipt.number } });
      this.comms.publish('receipt.finalized', [taxpayerRecipient(this.taxpayers.get(order.taxpayerId))], { reference: receipt.number }, { entity: obligation.entity });
      result.matched.push({ paymentReference: order.paymentReference, receiptNumber: receipt.number, obligationId: obligation.id, amount: order.amount });
    }
    if (result.exceptions.length > 0) {
      this.comms.publish('reconciliation.exception.opened', this.users.withRole('R18').map(userRecipient), { reference: input.statementId }, { entity: 'TRESOR' });
    }
    this.statements.insert({ id: input.statementId, fingerprint, result });
    return { replayed: false, result };
  }

  /** Exceptions ouvertes + « règlement manquant » calculé (confirmation sans crédit après J+1). */
  listExceptions(user: User): ReconciliationException[] {
    authorize(user, 'reconciliation.read');
    const now = this.clock.now();
    const missing: ReconciliationException[] = this.payments.orders
      .find((o) => o.status === 'CONFIRME' && !!o.confirmedAt && now.getTime() - new Date(o.confirmedAt).getTime() > DAY_MS)
      .map((o) => ({
        id: `EXC-MS-${o.id}`, type: 'MISSING_SETTLEMENT', paymentReference: o.paymentReference,
        detail: `Confirmation du ${o.confirmedAt} sans crédit constaté à J+1 : relance prestataire.`, status: 'OUVERTE', openedAt: now.toISOString(), computed: true,
      }));
    // Attente prestataire (résultat opérateur inconnu) non résolue : aucune quittance tant qu'elle reste ouverte.
    const held: ReconciliationException[] = this.payments.unresolvedHolds().map((h) => ({
      id: `EXC-HOLD-${h.id}`, type: 'PROVIDER_AMBIGUOUS', ...(h.paymentReference ? { paymentReference: h.paymentReference } : {}),
      detail: `Résultat opérateur inconnu signalé par ${h.provider} le ${h.receivedAt} : interroger la résolution prestataire, puis attendre la confirmation signée ou le relevé.`,
      status: 'OUVERTE', openedAt: h.receivedAt, computed: true,
    }));
    return [...this.exceptions.all(), ...missing, ...held];
  }
}
