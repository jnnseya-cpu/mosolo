/**
 * Orchestrateur de paiement (D5, ch. 18) : MOSOLO émet des références et reçoit des confirmations signées ;
 * il ne détient jamais les fonds. Le compte bénéficiaire est un ALIAS résolu dans le coffre.
 */
import { Money, PRIMARY_CURRENCY, canTransition, type CurrencyCode, type MoneyJSON, type PaymentStatus } from '@mosolo/shared';
import { z } from 'zod';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS, type Clock } from '../../core/clock.js';
import { checkChar, hmacSha256Hex, randomCode, safeEqualHex } from '../../core/crypto.js';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AlertService } from '../alerts/service.js';
import { PAYABLE_STATUSES, type AssessmentService } from '../assessment/service.js';
import type { CommunicationService } from '../communications/service.js';
import type { FxConversion, FxService } from '../fx/service.js';
import { taxpayerRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import type { ReceiptService } from '../receipts/service.js';
import type { LedgerService } from '../treasury/ledger.js';
import type { VaultService } from '../vault/service.js';

export const PAYMENT_CHANNELS = ['MOBILE_MONEY', 'BANK', 'CARD', 'AGENT_POINT', 'USSD', 'QR', 'TRANSFER'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

export const CALLBACK_WINDOW_MS = 5 * 60 * 1000;
export const REFERENCE_VALIDITY_HOURS = 48;

export interface PaymentOrder {
  id: string;
  paymentReference: string;
  obligationId: string;
  taxpayerId: string;
  channel: PaymentChannel;
  amount: MoneyJSON;
  indicativeAmount: FxConversion | null;
  beneficiaryAlias: string;
  expiresAt: string;
  status: PaymentStatus;
  createdBy: string;
  createdAt: string;
  provider?: string;
  providerTxnId?: string;
  payerAmount?: MoneyJSON;
  confirmedAt?: string;
  settledAt?: string;
  reconciledAt?: string;
  ledgerEntryIds: string[];
}

export interface ProviderConfirmation {
  id: string;
  provider: string;
  providerTxnId: string;
  paymentReference: string;
  outcome: 'CONFIRME' | 'ECHOUE' | 'DOUBLON';
  receivedAt: string;
  response: CallbackResponse;
}

export interface CallbackResponse {
  status: 'CONFIRME' | 'ECHOUE' | 'DOUBLON';
  paymentReference: string;
  receiptNumber?: string;
  receiptCode?: string;
  receiptStatus?: string;
  replayed?: boolean;
}

export const callbackBodySchema = z.object({
  providerTxnId: z.string().min(1).max(128),
  paymentReference: z.string().min(1).max(64),
  amount: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), currency: z.string() }),
  status: z.enum(['SUCCESS', 'FAILED']),
  completedAt: z.string().datetime({ offset: true }),
  payerAmount: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), currency: z.string() }).optional(),
  payerMsisdnHash: z.string().max(128).optional(),
});

export function orderView(o: PaymentOrder) {
  return {
    paymentOrderId: o.id,
    paymentReference: o.paymentReference,
    obligationId: o.obligationId,
    amount: o.amount,
    indicativeAmount: o.indicativeAmount,
    beneficiaryAlias: o.beneficiaryAlias,
    expiresAt: o.expiresAt,
    status: o.status,
    channel: o.channel,
    ussdInstructions: `Composez le code USSD officiel de MOSOLO [code court À CONFIGURER] puis saisissez la référence ${o.paymentReference.replace(/-/g, '')}. Aucun agent ne vous demandera d’espèces.`,
  };
}

export class PaymentService {
  readonly orders = new InMemoryRepository<PaymentOrder>();
  readonly confirmations = new InMemoryRepository<ProviderConfirmation>();
  private readonly nonces = new Set<string>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly alerts: AlertService,
    private readonly assessment: AssessmentService,
    private readonly taxpayers: TaxpayerService,
    private readonly vault: VaultService,
    private readonly fx: FxService,
    private readonly receipts: ReceiptService,
    private readonly ledger: LedgerService,
    private readonly providerSecrets: Record<string, string>,
  ) {}

  private newReference(): string {
    for (;;) {
      const core = randomCode(7);
      const ref = `PR-${core.slice(0, 4)}-${core.slice(4)}${checkChar(core)}`;
      if (!this.orders.findOne((o) => o.paymentReference === ref)) return ref;
    }
  }

  private indicative(amount: MoneyJSON, display?: CurrencyCode): FxConversion | null {
    const target = display ?? (amount.currency !== PRIMARY_CURRENCY ? PRIMARY_CURRENCY : undefined);
    if (!target || target === amount.currency) return null;
    try {
      return this.fx.convert(amount, target);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FX_RATE_MISSING') throw unprocessable('FX_RATE_MISSING', e.message);
      throw e;
    }
  }

  /** Création d'un ordre de paiement (l'idempotence est appliquée par la route). */
  createOrder(user: User, obligationId: string, input: { channel: PaymentChannel; displayCurrency?: CurrencyCode }): PaymentOrder {
    const obligation = this.assessment.get(obligationId);
    authorize(user, 'payment.create', { taxpayerId: obligation.taxpayerId });
    if (!PAYABLE_STATUSES.includes(obligation.status)) {
      throw unprocessable('OBLIGATION_NOT_PAYABLE', `Obligation au statut ${obligation.status} : paiement impossible.`);
    }
    const now = this.clock.now();
    for (const o of this.orders.find((x) => x.obligationId === obligationId)) {
      if (['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(o.status)) {
        throw unprocessable('OBLIGATION_ALREADY_PAID', `Un paiement confirmé existe déjà (${o.paymentReference}).`);
      }
      if (o.status === 'INITIE' && new Date(o.expiresAt) > now) {
        throw conflict('ACTIVE_PAYMENT_REFERENCE_EXISTS', `Une référence active existe déjà pour cette obligation.`, { paymentReference: o.paymentReference });
      }
    }
    const beneficiaryAlias = this.vault.resolveAlias(obligation.beneficiaryAccountAlias);
    const order = this.orders.insert({
      id: this.ids.next('PO'),
      paymentReference: this.newReference(),
      obligationId,
      taxpayerId: obligation.taxpayerId,
      channel: input.channel,
      // Montant = solde de l'obligation, jamais saisi par le client.
      amount: obligation.amount,
      indicativeAmount: this.indicative(obligation.amount, input.displayCurrency),
      beneficiaryAlias,
      expiresAt: new Date(now.getTime() + REFERENCE_VALIDITY_HOURS * HOUR_MS).toISOString(),
      status: 'INITIE',
      createdBy: user.id,
      createdAt: now.toISOString(),
      ledgerEntryIds: [],
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'payment.reference.issued', resourceType: 'payment_order', resourceId: order.id,
      details: { paymentReference: order.paymentReference, obligationId, channel: order.channel, amount: order.amount },
    });
    this.comms.publish('payment.reference.issued', [taxpayerRecipient(this.taxpayers.get(order.taxpayerId))], { reference: order.paymentReference }, { entity: obligation.entity });
    return order;
  }

  private transition(o: PaymentOrder, to: PaymentStatus, extra: Partial<PaymentOrder> = {}): PaymentOrder {
    if (!canTransition(o.status, to)) throw conflict('INVALID_PAYMENT_TRANSITION', `Transition ${o.status} → ${to} interdite.`);
    return this.orders.update({ ...o, ...extra, status: to });
  }

  private reject(provider: string, status: number, code: string, detail: string, context: Record<string, unknown>): never {
    this.alerts.raise({
      type: code, severity: code === 'AMOUNT_MISMATCH' || code === 'INVALID_SIGNATURE' ? 'CRITICAL' : 'HIGH',
      source: `prestataire:${provider}`, detail, context, actor: { kind: 'provider', id: provider },
    });
    throw new ApiError(status, code, detail);
  }

  /**
   * Rappel prestataire (§ 30.3) : signature HMAC-SHA256 du corps brut, fenêtre ±5 min, nonce unique,
   * unicité de providerTxnId (rejeu ⇒ 200 sans double effet), contrôle montant/référence,
   * puis CONFIRME + quittance provisoire.
   */
  handleCallback(provider: string, headers: { signature?: string; nonce?: string; timestamp?: string }, rawBody: string): CallbackResponse {
    const secret = this.providerSecrets[provider];
    if (!secret) throw notFound('UNKNOWN_PROVIDER', `Prestataire non habilité : ${provider}`);
    const { signature, nonce, timestamp } = headers;
    if (!signature || !nonce || !timestamp) {
      this.reject(provider, 401, 'CALLBACK_HEADERS_MISSING', 'En-têtes x-signature, x-nonce et x-timestamp obligatoires.', {});
    }
    const expected = hmacSha256Hex(secret, rawBody);
    const provided = signature.replace(/^sha256=/, '').toLowerCase();
    if (!safeEqualHex(expected, provided)) {
      this.reject(provider, 401, 'INVALID_SIGNATURE', 'Signature du rappel invalide.', { nonce });
    }
    const ts = new Date(timestamp).getTime();
    if (Number.isNaN(ts) || Math.abs(this.clock.now().getTime() - ts) > CALLBACK_WINDOW_MS) {
      this.reject(provider, 401, 'TIMESTAMP_OUT_OF_WINDOW', 'Horodatage hors de la fenêtre de ±5 minutes.', { timestamp });
    }
    const nonceKey = `${provider}:${nonce}`;
    if (this.nonces.has(nonceKey)) {
      this.reject(provider, 409, 'NONCE_REPLAYED', 'Nonce déjà utilisé : rejeu refusé.', { nonce });
    }
    this.nonces.add(nonceKey);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw badRequest('INVALID_JSON', 'Corps JSON invalide.');
    }
    const parsed = callbackBodySchema.safeParse(json);
    if (!parsed.success) throw badRequest('VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const body = parsed.data;

    // Rejeu d'une transaction déjà traitée : 200 idempotent, aucun double effet.
    const already = this.confirmations.findOne((c) => c.provider === provider && c.providerTxnId === body.providerTxnId);
    if (already) {
      this.audit.append({ actor: { kind: 'provider', id: provider }, action: 'payment.callback.replayed', resourceType: 'provider_txn', resourceId: body.providerTxnId, details: { paymentReference: body.paymentReference } });
      return { ...already.response, replayed: true };
    }

    const order = this.orders.findOne((o) => o.paymentReference === body.paymentReference);
    if (!order) this.reject(provider, 422, 'UNKNOWN_PAYMENT_REFERENCE', `Référence inconnue : ${body.paymentReference}`, { providerTxnId: body.providerTxnId });
    const paid = (() => {
      try {
        return Money.fromJSON(body.amount as MoneyJSON);
      } catch {
        return undefined;
      }
    })();
    if (!paid || !paid.equals(Money.fromJSON(order.amount))) {
      this.reject(provider, 422, 'AMOUNT_MISMATCH', `Montant confirmé ${body.amount.amount} ${body.amount.currency} ≠ montant dû ${order.amount.amount} ${order.amount.currency}.`, {
        paymentReference: order.paymentReference, providerTxnId: body.providerTxnId,
      });
    }

    const actor = { kind: 'provider' as const, id: provider };
    const record = (outcome: ProviderConfirmation['outcome'], response: CallbackResponse): CallbackResponse => {
      this.confirmations.insert({
        id: this.ids.next('CONF'), provider, providerTxnId: body.providerTxnId, paymentReference: order.paymentReference, outcome,
        receivedAt: this.clock.now().toISOString(), response,
      });
      return response;
    };
    const tp = this.taxpayers.get(order.taxpayerId);
    const obligation = this.assessment.get(order.obligationId);

    if (body.status === 'FAILED') {
      if (order.status === 'INITIE') this.transition(order, 'ECHOUE');
      this.audit.append({ actor, action: 'payment.failed', resourceType: 'payment_order', resourceId: order.id, details: { providerTxnId: body.providerTxnId } });
      this.comms.publish('payment.failed', [taxpayerRecipient(tp)], { reference: order.paymentReference }, { entity: obligation.entity });
      return record('ECHOUE', { status: 'ECHOUE', paymentReference: order.paymentReference });
    }

    if (order.status !== 'INITIE') {
      // Deuxième paiement pour une même référence : DOUBLON, traité par règle (remboursement), jamais de 2e quittance.
      this.audit.append({ actor, action: 'payment.duplicate_detected', resourceType: 'payment_order', resourceId: order.id, outcome: 'FAILURE', details: { providerTxnId: body.providerTxnId, currentStatus: order.status } });
      this.comms.publish('payment.duplicate_detected', [taxpayerRecipient(tp)], { reference: order.paymentReference }, { entity: obligation.entity });
      return record('DOUBLON', { status: 'DOUBLON', paymentReference: order.paymentReference });
    }

    const payerAmount = body.payerAmount && body.payerAmount.currency !== order.amount.currency ? Money.fromJSON(body.payerAmount as MoneyJSON).toJSON() : undefined;
    const entry = this.ledger.postPair({
      eventType: 'PAYMENT_CONFIRMED', description: `Confirmation ${provider} ${body.providerTxnId} pour ${order.paymentReference}`,
      sourceType: 'payment_order', sourceId: order.id, debit: 'FONDS_A_RECEVOIR_PRESTATAIRES', credit: 'CREANCES_CONTRIBUABLES', amount: order.amount,
    });
    const confirmed = this.transition(order, 'CONFIRME', {
      provider, providerTxnId: body.providerTxnId, confirmedAt: this.clock.now().toISOString(),
      ...(payerAmount ? { payerAmount } : {}), ledgerEntryIds: [...order.ledgerEntryIds, entry.id],
    });
    // Contre-valeur indicative en CDF (AC-CUR-01) : taux et source figurent sur la quittance.
    const indicativeAmount = confirmed.indicativeAmount ?? this.indicative(confirmed.amount);
    const receipt = this.receipts.issueProvisional({
      kind: 'VERIFIED_PROVIDER_CONFIRMATION',
      paymentOrderId: confirmed.id,
      paymentReference: confirmed.paymentReference,
      obligationId: obligation.id,
      taxpayerId: tp.id,
      taxpayerRef: tp.iuc,
      revenueCategory: obligation.label,
      administration: obligation.entity,
      beneficiaryAlias: confirmed.beneficiaryAlias,
      amount: confirmed.amount,
      ...(payerAmount ? { payerAmount } : {}),
      ...(indicativeAmount ? { indicativeAmount } : {}),
      channel: confirmed.channel,
      provider,
      providerTxnId: body.providerTxnId,
      paidAt: body.completedAt,
      signatureVerified: true,
      nonceUnique: true,
      timestampInWindow: true,
    });
    this.audit.append({ actor, action: 'payment.confirmed', resourceType: 'payment_order', resourceId: order.id, details: { providerTxnId: body.providerTxnId, receipt: receipt.number } });
    const vars = { reference: order.paymentReference };
    this.comms.publish('payment.confirmed', [taxpayerRecipient(tp)], vars, { entity: obligation.entity });
    this.comms.publish('receipt.issued_provisional', [taxpayerRecipient(tp)], { reference: receipt.number }, { entity: obligation.entity });
    if (payerAmount) this.comms.publish('payment.currency_converted', [taxpayerRecipient(tp)], vars, { entity: obligation.entity });
    return record('CONFIRME', {
      status: 'CONFIRME', paymentReference: order.paymentReference, receiptNumber: receipt.number, receiptCode: receipt.code, receiptStatus: receipt.status,
    });
  }

  byReference(ref: string): PaymentOrder | undefined {
    return this.orders.findOne((o) => o.paymentReference === ref);
  }

  byObligation(obligationId: string): PaymentOrder[] {
    return this.orders.find((o) => o.obligationId === obligationId);
  }

  /** Règlement puis rapprochement (appelé par le Trésor). */
  settleAndReconcile(orderId: string, ledgerEntryId: string): PaymentOrder {
    const o = this.orders.get(orderId)!;
    const now = this.clock.now().toISOString();
    const settled = this.transition(o, 'REGLE', { settledAt: now });
    return this.transition(settled, 'RAPPROCHE', { reconciledAt: now, ledgerEntryIds: [...settled.ledgerEntryIds, ledgerEntryId] });
  }

  /** Signature attendue d'un rappel (utilitaire pour la démo et les tests). */
  static sign(secret: string, rawBody: string): string {
    return hmacSha256Hex(secret, rawBody);
  }
}
