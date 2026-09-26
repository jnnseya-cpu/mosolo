/**
 * Orchestrateur de paiement (D5, ch. 18) : MOSOLO émet des références et reçoit des confirmations signées ;
 * il ne détient jamais les fonds. Le compte bénéficiaire est un ALIAS résolu dans le coffre.
 */
import { Money, PRIMARY_CURRENCY, UNATTRIBUTED_COMMUNE, canTransition, type CurrencyCode, type MoneyJSON, type PaymentStatus, type TerritorialAttribution } from '@mosolo/shared';
import { z } from 'zod';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS, type Clock } from '../../core/clock.js';
import { checkChar, hmacSha256Hex, randomCode, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { AlertService } from '../alerts/service.js';
import { PAYABLE_STATUSES, type AssessmentService } from '../assessment/service.js';
import type { CommunicationService } from '../communications/service.js';
import type { FxConversion, FxService } from '../fx/service.js';
import { taxpayerRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import type { ReceiptService } from '../receipts/service.js';
import type { LedgerService } from '../treasury/ledger.js';
import type { VaultService } from '../vault/service.js';
import { ProviderHttpError } from './connectors/http-client.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import {
  WebhookPayloadError, WebhookVerificationError, type ConfirmationMethod, type ConnectorId, type HeaderBag, type NormalizedProviderEvent,
  type HoldEvent, type PaymentEvent, type SettlementEvent, type WebhookChecks,
} from './connectors/types.js';

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
  /** Intention créée chez un prestataire connecté (BitriPay, KODA) : l'ordre lui est alors lié. */
  providerIntentId?: string;
  providerCheckoutUrl?: string | null;
  providerQrPayload?: string | null;
  providerSandbox?: boolean;
  providerTxnId?: string;
  confirmationMethod?: ConfirmationMethod;
  payerAmount?: MoneyJSON;
  confirmedAt?: string;
  settledAt?: string;
  reconciledAt?: string;
  ledgerEntryIds: string[];
  /** Échéancier accordé dont cet ordre paie une échéance (module recouvrement). */
  installmentPlanId?: string;
  /** Copie du rattachement territorial de l'obligation (§ 20.3) : la recette compte pour cette commune. */
  attribution?: TerritorialAttribution;
}

/** Recettes réelles par commune du fait générateur (agrégats seulement, par devise, niveaux jamais additionnés). */
export interface CommuneRevenue {
  commune: string;
  /** Paiements confirmés (CONFIRME, REGLE, RAPPROCHE). */
  confirmedCount: number;
  /** Montant payé, confirmé par le prestataire (inclut le rapproché). */
  paid: MoneyJSON[];
  /** Dont montant rapproché avec le relevé du compte public : seul chiffre de recette arrivée. */
  reconciled: MoneyJSON[];
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

/** Confirmation normalisée (après vérification de signature propre au canal), commune à tous les prestataires. */
export interface NormalizedConfirmation {
  providerTxnId: string;
  paymentReference: string;
  amount: { amount: string; currency: string };
  status: 'SUCCESS' | 'FAILED';
  completedAt: string;
  payerAmount?: { amount: string; currency: string };
  confirmationMethod: ConfirmationMethod;
  /** Intention annoncée par le prestataire : doit correspondre à celle liée à l'ordre. */
  providerIntentId?: string;
}

/** Contrôles du rappel générique : signature HMAC, nonce unique, horodatage ±5 min. */
const CALLBACK_CHECKS: WebhookChecks = { signatureVerified: true, replayGuard: 'NONCE', timestampInWindow: true };

/** Annonce de règlement d'un prestataire : INDICE de rapprochement, sans effet sur l'état du paiement. */
export interface SettlementAnnouncement {
  id: string;
  provider: string;
  eventId: string;
  providerIntentId?: string;
  paymentReference?: string;
  paymentOrderId?: string;
  settlementId?: string;
  amount?: MoneyJSON;
  amountMatchesOrder?: boolean;
  settledAt?: string;
  receivedAt: string;
}

/** Paiement mis en attente par le prestataire (résultat opérateur inconnu) : exception jusqu'à résolution. */
export interface ProviderHold {
  id: string;
  provider: string;
  eventId: string;
  reason: 'PROVIDER_AMBIGUOUS';
  providerIntentId?: string;
  paymentReference?: string;
  paymentOrderId?: string;
  amount?: MoneyJSON;
  receivedAt: string;
}

/** Réponse « ce paiement a-t-il eu lieu ? » du prestataire : PIÈCE DE DOSSIER, sans aucun effet. */
export interface ProviderResolutionRecord {
  id: string;
  kind: 'PROVIDER_PAYMENT_RESOLUTION';
  legalEffect: 'AUCUN';
  notice: string;
  provider: string;
  paymentReference: string;
  paymentOrderId: string;
  orderStatusAtRequest: PaymentStatus;
  providerResult: unknown;
  sandbox: boolean;
  requestedBy: string;
  requestedAt: string;
}

export interface WebhookEventResult {
  eventId: string;
  eventType: string;
  outcome: 'PROCESSED' | 'SETTLEMENT_ANNOUNCED' | 'HELD' | 'IGNORED';
  status?: CallbackResponse['status'];
  paymentReference?: string;
  receiptNumber?: string;
  receiptCode?: string;
  receiptStatus?: string;
  reason?: string;
  replayed?: boolean;
}

interface WebhookEventRecord {
  id: string;
  provider: string;
  eventId: string;
  receivedAt: string;
  result: WebhookEventResult;
}

/** Résultat de vérification capture/SMS obtenu du prestataire : PIÈCE DE DOSSIER, sans aucun effet. */
export interface VerificationEvidenceRecord {
  id: string;
  kind: 'PROVIDER_VERIFICATION_EVIDENCE';
  legalEffect: 'AUCUN';
  notice: string;
  caseRef: string;
  provider: string;
  paymentReference: string;
  paymentOrderId: string;
  orderStatusAtRequest: PaymentStatus;
  smsCodeSha256?: string;
  screenshotSha256?: string;
  providerResult: unknown;
  sandbox: boolean;
  requestedBy: string;
  requestedAt: string;
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
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    status: o.status,
    channel: o.channel,
    ussdInstructions: `Composez le code USSD officiel de MOSOLO [code court À CONFIGURER] puis saisissez la référence ${o.paymentReference.replace(/-/g, '')}. Aucun agent ne vous demandera d’espèces.`,
    ...(o.providerIntentId
      ? {
          provider: o.provider,
          providerIntentId: o.providerIntentId,
          checkoutUrl: o.providerCheckoutUrl ?? null,
          qrPayload: o.providerQrPayload ?? null,
          sandbox: o.providerSandbox ?? true,
        }
      : {}),
  };
}

export class PaymentService {
  readonly orders = new InMemoryRepository<PaymentOrder>();
  readonly confirmations = new InMemoryRepository<ProviderConfirmation>();
  readonly webhookEvents = new InMemoryRepository<WebhookEventRecord>();
  readonly settlementAnnouncements = new InMemoryAppendOnlyRepository<SettlementAnnouncement>();
  readonly providerHolds = new InMemoryAppendOnlyRepository<ProviderHold>();
  readonly providerResolutions = new InMemoryAppendOnlyRepository<ProviderResolutionRecord>();
  readonly verificationEvidence = new InMemoryAppendOnlyRepository<VerificationEvidenceRecord>();
  private readonly nonces = new Set<string>();
  /** Obligations dont une intention prestataire est en cours de création (verrou anti-concurrence). */
  private readonly pendingIntents = new Set<string>();
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
    readonly connectors: ConnectorRegistry,
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

  /** Contrôles et préparation d'un ordre (sans l'enregistrer). */
  /** Montant de la prochaine échéance d'un échéancier accordé (module recouvrement) ; jamais saisi par le client. */
  private installmentResolver?: (obligationId: string, planId: string) => MoneyJSON;

  setInstallmentResolver(fn: (obligationId: string, planId: string) => MoneyJSON): void {
    this.installmentResolver = fn;
  }

  /** Montant déjà payé (confirmé, réglé ou rapproché) sur une obligation, par devise de l'obligation. */
  paidOn(obligationId: string): Money {
    const ob = this.assessment.get(obligationId);
    return this.orders
      .find((o) => o.obligationId === obligationId && ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(o.status))
      .reduce((m, o) => m.add(Money.fromJSON(o.amount)), Money.zero(ob.amount.currency));
  }

  private prepareOrder(user: User, obligationId: string, input: { channel: PaymentChannel; displayCurrency?: CurrencyCode; installmentPlanId?: string }) {
    const obligation = this.assessment.get(obligationId);
    authorize(user, 'payment.create', { taxpayerId: obligation.taxpayerId });
    if (!PAYABLE_STATUSES.includes(obligation.status)) {
      throw unprocessable('OBLIGATION_NOT_PAYABLE', `Obligation au statut ${obligation.status} : paiement impossible.`);
    }
    const now = this.clock.now();
    let amount: MoneyJSON = obligation.amount;
    if (input.installmentPlanId) {
      if (!this.installmentResolver) throw unprocessable('INSTALLMENT_PLANS_UNAVAILABLE', 'Aucun échéancier ne peut être payé : module de recouvrement non chargé.');
      amount = this.installmentResolver(obligationId, input.installmentPlanId);
    }
    const remaining = Money.fromJSON(obligation.amount).subtract(this.paidOn(obligationId));
    if (Money.fromJSON(amount).compare(remaining) > 0) amount = remaining.toJSON();
    for (const o of this.orders.find((x) => x.obligationId === obligationId)) {
      if (['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(o.status) && !(input.installmentPlanId && !remaining.isZero() && !remaining.isNegative())) {
        throw unprocessable('OBLIGATION_ALREADY_PAID', `Un paiement confirmé existe déjà (${o.paymentReference}).`);
      }
      if (o.status === 'INITIE' && new Date(o.expiresAt) > now) {
        throw conflict('ACTIVE_PAYMENT_REFERENCE_EXISTS', `Une référence active existe déjà pour cette obligation.`, { paymentReference: o.paymentReference });
      }
    }
    const beneficiaryAlias = this.vault.resolveAlias(obligation.beneficiaryAccountAlias);
    const draft: PaymentOrder = {
      id: '',
      paymentReference: this.newReference(),
      obligationId,
      taxpayerId: obligation.taxpayerId,
      channel: input.channel,
      // Montant = solde de l'obligation (ou échéance de l'échéancier accordé), jamais saisi par le client.
      amount,
      ...(input.installmentPlanId ? { installmentPlanId: input.installmentPlanId } : {}),
      attribution: obligation.attribution,
      indicativeAmount: this.indicative(amount, input.displayCurrency),
      beneficiaryAlias,
      expiresAt: new Date(now.getTime() + REFERENCE_VALIDITY_HOURS * HOUR_MS).toISOString(),
      status: 'INITIE',
      createdBy: user.id,
      createdAt: now.toISOString(),
      ledgerEntryIds: [],
    };
    return { obligation, draft };
  }

  private commitOrder(user: User, draft: PaymentOrder, entity: string): PaymentOrder {
    const order = this.orders.insert({ ...draft, id: draft.id || this.ids.next('PO') });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'payment.reference.issued', resourceType: 'payment_order', resourceId: order.id,
      details: {
        paymentReference: order.paymentReference, obligationId: order.obligationId, channel: order.channel, amount: order.amount,
        ...(order.providerIntentId ? { provider: order.provider, providerIntentId: order.providerIntentId, providerSandbox: order.providerSandbox } : {}),
      },
    });
    this.comms.publish('payment.reference.issued', [taxpayerRecipient(this.taxpayers.get(order.taxpayerId))], { reference: order.paymentReference }, { entity });
    return order;
  }

  /** Création d'un ordre de paiement (l'idempotence est appliquée par la route). */
  createOrder(user: User, obligationId: string, input: { channel: PaymentChannel; displayCurrency?: CurrencyCode; installmentPlanId?: string }): PaymentOrder {
    const { obligation, draft } = this.prepareOrder(user, obligationId, input);
    return this.commitOrder(user, draft, obligation.entity);
  }

  /**
   * Création d'un ordre lié à un prestataire connecté (BitriPay, KODA) : l'intention est créée chez le prestataire
   * AVANT l'enregistrement de l'ordre. En cas d'échec sortant : 502 PROVIDER_UNAVAILABLE et AUCUN ordre enregistré
   * (le contribuable peut réessayer ; une intention éventuellement créée côté prestataire porte une référence
   * inconnue de MOSOLO et ne pourra jamais produire de quittance).
   */
  async createOrderWithProvider(
    user: User,
    obligationId: string,
    input: { channel: PaymentChannel; displayCurrency?: CurrencyCode; provider?: ConnectorId; installmentPlanId?: string },
  ): Promise<PaymentOrder> {
    if (!input.provider) return this.createOrder(user, obligationId, input);
    const connector = this.connectors.get(input.provider);
    if (!connector) throw unprocessable('UNKNOWN_PROVIDER', `Prestataire non connecté : ${input.provider}`);
    if (input.channel !== 'MOBILE_MONEY' && input.channel !== 'QR') {
      throw unprocessable('PROVIDER_CHANNEL_UNSUPPORTED', `Le prestataire ${connector.label} n'est proposé que pour les canaux MOBILE_MONEY et QR.`);
    }
    const { obligation, draft } = this.prepareOrder(user, obligationId, input);
    // Doctrine : le règlement du prestataire va au compte public du coffre qui est aussi le bénéficiaire de l'ordre.
    this.vault.resolveAlias(connector.settlementAccountAlias);
    if (connector.settlementAccountAlias !== draft.beneficiaryAlias) {
      throw unprocessable(
        'SETTLEMENT_ACCOUNT_MISMATCH',
        `Le compte de règlement de ${connector.label} (${connector.settlementAccountAlias}) n'est pas le compte bénéficiaire de l'obligation (${draft.beneficiaryAlias}).`,
      );
    }
    if (this.pendingIntents.has(obligationId)) {
      throw conflict('PAYMENT_INITIATION_IN_PROGRESS', 'Une initiation de paiement est déjà en cours pour cette obligation.');
    }
    this.pendingIntents.add(obligationId);
    const id = this.ids.next('PO');
    try {
      let intent;
      try {
        intent = await connector.createIntent({
          paymentOrderId: id, paymentReference: draft.paymentReference, obligationId, amount: draft.amount, channel: draft.channel,
        });
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 'PROVIDER_UNAVAILABLE';
        this.audit.append({
          actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'payment.provider_intent.failed', resourceType: 'obligation', resourceId: obligationId,
          outcome: 'FAILURE', details: { provider: connector.id, paymentReference: draft.paymentReference, code },
        });
        if (e instanceof ApiError) throw e;
        throw new ProviderHttpError(connector.id, e instanceof Error ? e.name : 'erreur');
      }
      return this.commitOrder(user, {
        ...draft, id, provider: connector.id, providerIntentId: intent.providerIntentId,
        providerCheckoutUrl: intent.checkoutUrl, providerQrPayload: intent.qrPayload, providerSandbox: intent.sandbox,
      }, obligation.entity);
    } finally {
      this.pendingIntents.delete(obligationId);
    }
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
    return this.confirmFromProvider(provider, { ...body, confirmationMethod: 'HMAC_CALLBACK' }, CALLBACK_CHECKS);
  }

  /**
   * Confirmation d'un paiement par un prestataire, APRÈS vérification de signature propre au canal (rappel générique
   * ou connecteur). Contrôles communs : unicité de la transaction (rejeu ⇒ réponse mémorisée, aucun double effet),
   * référence connue, liaison ordre ↔ intention prestataire, montant exact (Money), doublon, écritures, quittance
   * provisoire, communications, audit.
   */
  confirmFromProvider(provider: string, n: NormalizedConfirmation, checks: WebhookChecks = CALLBACK_CHECKS): CallbackResponse {
    // Rejeu d'une transaction déjà traitée : 200 idempotent, aucun double effet.
    const already = this.confirmations.findOne((c) => c.provider === provider && c.providerTxnId === n.providerTxnId);
    if (already) {
      this.audit.append({ actor: { kind: 'provider', id: provider }, action: 'payment.callback.replayed', resourceType: 'provider_txn', resourceId: n.providerTxnId, details: { paymentReference: n.paymentReference } });
      return { ...already.response, replayed: true };
    }

    const order = this.orders.findOne((o) => o.paymentReference === n.paymentReference);
    if (!order) this.reject(provider, 422, 'UNKNOWN_PAYMENT_REFERENCE', `Référence inconnue : ${n.paymentReference}`, { providerTxnId: n.providerTxnId });
    // Un ordre lié à une intention prestataire ne peut être confirmé que par CE prestataire, pour CETTE intention.
    if (order.providerIntentId && (order.provider !== provider || (n.providerIntentId !== undefined && n.providerIntentId !== order.providerIntentId))) {
      this.reject(provider, 422, 'PROVIDER_ORDER_MISMATCH', `La confirmation ne correspond pas au prestataire ou à l'intention liés à ${order.paymentReference}.`, {
        paymentReference: order.paymentReference, providerTxnId: n.providerTxnId, providerIntentId: n.providerIntentId,
      });
    }
    const paid = (() => {
      try {
        return Money.fromJSON(n.amount as MoneyJSON);
      } catch {
        return undefined;
      }
    })();
    if (!paid || !paid.equals(Money.fromJSON(order.amount))) {
      this.reject(provider, 422, 'AMOUNT_MISMATCH', `Montant confirmé ${n.amount.amount} ${n.amount.currency} ≠ montant dû ${order.amount.amount} ${order.amount.currency}.`, {
        paymentReference: order.paymentReference, providerTxnId: n.providerTxnId,
      });
    }

    const actor = { kind: 'provider' as const, id: provider };
    const record = (outcome: ProviderConfirmation['outcome'], response: CallbackResponse): CallbackResponse => {
      this.confirmations.insert({
        id: this.ids.next('CONF'), provider, providerTxnId: n.providerTxnId, paymentReference: order.paymentReference, outcome,
        receivedAt: this.clock.now().toISOString(), response,
      });
      return response;
    };
    const tp = this.taxpayers.get(order.taxpayerId);
    const obligation = this.assessment.get(order.obligationId);

    if (n.status === 'FAILED') {
      if (order.status === 'INITIE') this.transition(order, 'ECHOUE');
      this.audit.append({ actor, action: 'payment.failed', resourceType: 'payment_order', resourceId: order.id, details: { providerTxnId: n.providerTxnId } });
      this.comms.publish('payment.failed', [taxpayerRecipient(tp)], { reference: order.paymentReference }, { entity: obligation.entity });
      return record('ECHOUE', { status: 'ECHOUE', paymentReference: order.paymentReference });
    }

    if (order.status !== 'INITIE') {
      // Deuxième paiement pour une même référence : DOUBLON, traité par règle (remboursement), jamais de 2e quittance.
      this.audit.append({ actor, action: 'payment.duplicate_detected', resourceType: 'payment_order', resourceId: order.id, outcome: 'FAILURE', details: { providerTxnId: n.providerTxnId, currentStatus: order.status } });
      this.comms.publish('payment.duplicate_detected', [taxpayerRecipient(tp)], { reference: order.paymentReference }, { entity: obligation.entity });
      return record('DOUBLON', { status: 'DOUBLON', paymentReference: order.paymentReference });
    }

    const payerAmount = n.payerAmount && n.payerAmount.currency !== order.amount.currency ? Money.fromJSON(n.payerAmount as MoneyJSON).toJSON() : undefined;
    const entry = this.ledger.postPair({
      eventType: 'PAYMENT_CONFIRMED', description: `Confirmation ${provider} ${n.providerTxnId} pour ${order.paymentReference}`,
      sourceType: 'payment_order', sourceId: order.id, debit: 'FONDS_A_RECEVOIR_PRESTATAIRES', credit: 'CREANCES_CONTRIBUABLES', amount: order.amount,
    });
    const confirmed = this.transition(order, 'CONFIRME', {
      provider, providerTxnId: n.providerTxnId, confirmedAt: this.clock.now().toISOString(), confirmationMethod: n.confirmationMethod,
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
      providerTxnId: n.providerTxnId,
      paidAt: n.completedAt,
      confirmationMethod: n.confirmationMethod,
      signatureVerified: checks.signatureVerified,
      // Nonce unique (rappel générique) ou identifiant d'événement unique (webhook prestataire).
      nonceUnique: true,
      replayGuard: checks.replayGuard,
      timestampInWindow: checks.timestampInWindow,
    });
    this.audit.append({ actor, action: 'payment.confirmed', resourceType: 'payment_order', resourceId: order.id, details: { providerTxnId: n.providerTxnId, receipt: receipt.number, confirmationMethod: n.confirmationMethod } });
    const vars = { reference: order.paymentReference };
    this.comms.publish('payment.confirmed', [taxpayerRecipient(tp)], vars, { entity: obligation.entity });
    this.comms.publish('receipt.issued_provisional', [taxpayerRecipient(tp)], { reference: receipt.number }, { entity: obligation.entity });
    if (payerAmount) this.comms.publish('payment.currency_converted', [taxpayerRecipient(tp)], vars, { entity: obligation.entity });
    return record('CONFIRME', {
      status: 'CONFIRME', paymentReference: order.paymentReference, receiptNumber: receipt.number, receiptCode: receipt.code, receiptStatus: receipt.status,
    });
  }

  /**
   * Webhook signé d'un prestataire connecté (BitriPay, KODA). Signature vérifiée à temps constant par le connecteur
   * (invalide ⇒ 401 + alerte), unicité de l'identifiant d'événement (rejeu ⇒ 200, aucun double effet), puis :
   * paiement ⇒ `confirmFromProvider` ; annonce de règlement ⇒ indice de rapprochement SEULEMENT ; autre ⇒ ignoré + audit.
   */
  handleConnectorWebhook(providerId: string, headers: HeaderBag, rawBody: string): { received: true; results: WebhookEventResult[] } {
    const connector = this.connectors.get(providerId);
    if (!connector) throw notFound('UNKNOWN_PROVIDER', `Prestataire non connecté : ${providerId}`);
    let verified;
    try {
      verified = connector.verifyWebhook(headers, rawBody, this.clock.now());
    } catch (e) {
      if (e instanceof WebhookVerificationError) this.reject(providerId, 401, e.code, e.message, { channel: 'webhook' });
      if (e instanceof WebhookPayloadError) {
        if (e.code === 'INVALID_JSON') throw badRequest('INVALID_JSON', e.message);
        this.reject(providerId, 422, e.code, e.message, { channel: 'webhook' });
      }
      throw e;
    }
    const results: WebhookEventResult[] = [];
    for (const ev of verified.events) {
      const key = `${providerId}:${ev.eventId}`;
      const done = this.webhookEvents.get(key);
      if (done) {
        this.audit.append({ actor: { kind: 'provider', id: providerId }, action: 'payment.webhook.replayed', resourceType: 'provider_event', resourceId: ev.eventId, details: { eventType: ev.eventType } });
        results.push({ ...done.result, replayed: true });
        continue;
      }
      let result: WebhookEventResult;
      if (ev.kind === 'PAYMENT') result = this.applyPaymentEvent(providerId, ev, verified.checks);
      else if (ev.kind === 'SETTLEMENT') result = this.announceSettlement(providerId, ev);
      else if (ev.kind === 'HOLD') result = this.recordHold(providerId, ev);
      else {
        this.audit.append({
          actor: { kind: 'provider', id: providerId },
          action: ev.reason === 'NON_TERMINAL_ATTEMPT_FAILURE' ? 'payment.attempt_failed' : 'payment.webhook.ignored',
          resourceType: 'provider_event', resourceId: ev.eventId,
          details: { eventType: ev.eventType, reason: ev.reason, ...(ev.paymentReference ? { paymentReference: ev.paymentReference } : {}) },
        });
        result = { eventId: ev.eventId, eventType: ev.eventType, outcome: 'IGNORED', reason: ev.reason };
      }
      // Enregistré seulement après succès : un événement refusé (422) peut être re-présenté et sera re-contrôlé.
      this.webhookEvents.insert({ id: key, provider: providerId, eventId: ev.eventId, receivedAt: this.clock.now().toISOString(), result });
      results.push(result);
    }
    return { received: true, results };
  }

  /** Référence MOSOLO d'un événement : métadonnées (référence, ordre) et intention stockée doivent concorder. */
  private resolveEventOrder(providerId: string, ev: PaymentEvent | SettlementEvent | HoldEvent): PaymentOrder | undefined {
    const byIntent = ev.providerIntentId ? this.orders.findOne((o) => o.provider === providerId && o.providerIntentId === ev.providerIntentId) : undefined;
    const byOrderId = ev.paymentOrderId ? this.orders.get(ev.paymentOrderId) : undefined;
    const byRef = ev.paymentReference ? this.byReference(ev.paymentReference) : undefined;
    const refs = new Set([ev.paymentReference, byOrderId?.paymentReference, byIntent?.paymentReference].filter((r): r is string => !!r));
    if (refs.size > 1) {
      this.reject(providerId, 422, 'REFERENCE_CONFLICT', 'Référence, ordre et intention de l’événement ne concordent pas.', {
        eventId: ev.eventId, providerIntentId: ev.providerIntentId, references: [...refs],
      });
    }
    return byIntent ?? byOrderId ?? byRef;
  }

  private applyPaymentEvent(providerId: string, ev: PaymentEvent, checks: WebhookChecks): WebhookEventResult {
    const order = this.resolveEventOrder(providerId, ev);
    const paymentReference = order?.paymentReference ?? ev.paymentReference;
    if (!paymentReference) {
      this.reject(providerId, 422, 'UNKNOWN_PAYMENT_REFERENCE', 'Événement sans référence MOSOLO résoluble (métadonnées ou intention).', {
        eventId: ev.eventId, providerIntentId: ev.providerIntentId,
      });
    }
    // Un échec sans montant porte sur l'ordre lui-même ; un succès exige TOUJOURS le montant du prestataire.
    const amount = ev.amount ?? (ev.status === 'FAILED' && order ? order.amount : undefined);
    if (!amount) this.reject(providerId, 422, 'PROVIDER_AMOUNT_MISSING', 'Événement de paiement sans montant.', { eventId: ev.eventId });
    const r = this.confirmFromProvider(providerId, {
      providerTxnId: ev.providerTxnId, paymentReference, amount, status: ev.status, completedAt: ev.completedAt,
      confirmationMethod: ev.confirmationMethod, ...(ev.providerIntentId ? { providerIntentId: ev.providerIntentId } : {}),
    }, checks);
    if (ev.applicationFeeMinor) {
      // Le payeur a bien payé : la quittance reste due. Mais un frais retenu sur une recette publique est interdit ;
      // le rapprochement fera apparaître l'écart au compte public. Alerte critique, sans blocage du contribuable.
      this.alerts.raise({
        type: 'APPLICATION_FEE_ON_PUBLIC_REVENUE', severity: 'CRITICAL', source: `prestataire:${providerId}`,
        detail: `Frais d'application de ${ev.applicationFeeMinor} unités mineures retenu sur ${paymentReference} : interdit sur une recette publique.`,
        context: { eventId: ev.eventId, paymentReference, providerIntentId: ev.providerIntentId, applicationFeeMinor: ev.applicationFeeMinor },
        actor: { kind: 'provider', id: providerId },
      });
    }
    return { eventId: ev.eventId, eventType: ev.eventType, outcome: 'PROCESSED', ...r };
  }

  /** Mise en attente du prestataire : aucune transition, aucune quittance ; exception ouverte jusqu'à résolution. */
  private recordHold(providerId: string, ev: HoldEvent): WebhookEventResult {
    const order = this.resolveEventOrder(providerId, ev);
    const paymentReference = order?.paymentReference ?? ev.paymentReference;
    const hold = this.providerHolds.append({
      id: this.ids.next('HOLD'), provider: providerId, eventId: ev.eventId, reason: ev.reason,
      ...(ev.providerIntentId ? { providerIntentId: ev.providerIntentId } : {}),
      ...(paymentReference ? { paymentReference } : {}), ...(order ? { paymentOrderId: order.id } : {}),
      ...(ev.amount ? { amount: ev.amount } : {}), receivedAt: this.clock.now().toISOString(),
    });
    this.alerts.raise({
      type: 'PROVIDER_AMBIGUOUS', severity: 'HIGH', source: `prestataire:${providerId}`,
      detail: `Résultat opérateur inconnu pour ${paymentReference ?? ev.providerIntentId ?? ev.eventId} : paiement en revue chez le prestataire, aucune quittance.`,
      context: { holdId: hold.id, eventId: ev.eventId, paymentReference }, actor: { kind: 'provider', id: providerId },
    });
    this.audit.append({
      actor: { kind: 'provider', id: providerId }, action: 'payment.provider_hold', resourceType: 'payment_order', resourceId: order?.id ?? ev.providerIntentId ?? ev.eventId,
      outcome: 'FAILURE', details: { holdId: hold.id, eventId: ev.eventId, reason: ev.reason, orderStatus: order?.status },
    });
    return { eventId: ev.eventId, eventType: ev.eventType, outcome: 'HELD', reason: ev.reason, ...(paymentReference ? { paymentReference } : {}) };
  }

  /** Attentes prestataire non résolues : ordre toujours ni confirmé, ni réglé, ni échoué. */
  unresolvedHolds(): ProviderHold[] {
    return this.providerHolds.all().filter((h) => {
      const o = h.paymentOrderId ? this.orders.get(h.paymentOrderId) : h.paymentReference ? this.byReference(h.paymentReference) : undefined;
      return !o || o.status === 'INITIE';
    });
  }

  /**
   * « Ce paiement a-t-il eu lieu ? » auprès du prestataire (BitriPay GET /payment_resolution), réservé à R17, R18
   * et R20 pour instruire une exception. PIÈCE DE DOSSIER : ne modifie jamais l'état et n'émet jamais de quittance.
   */
  async resolveWithProvider(user: User, paymentReference: string): Promise<ProviderResolutionRecord> {
    authorize(user, 'payment.evidence');
    const order = this.byReference(paymentReference);
    if (!order) throw notFound('PAYMENT_REFERENCE_NOT_FOUND', `Référence inconnue : ${paymentReference}`);
    if (!order.provider || !order.providerIntentId) {
      throw unprocessable('NO_PROVIDER_INTENT', 'Cet ordre n’est lié à aucune intention d’un prestataire connecté.');
    }
    const connector = this.connectors.get(order.provider);
    if (!connector) throw unprocessable('UNKNOWN_PROVIDER', `Prestataire non connecté : ${order.provider}`);
    if (!connector.resolvePayment) throw unprocessable('PROVIDER_RESOLUTION_UNSUPPORTED', `${connector.label} ne propose pas d'interrogation de résolution.`);
    const res = await connector.resolvePayment(order.providerIntentId, order.paymentReference);
    const record = this.providerResolutions.append({
      id: this.ids.next('RESOL'), kind: 'PROVIDER_PAYMENT_RESOLUTION', legalEffect: 'AUCUN',
      notice: 'Réponse du prestataire versée au dossier : ni confirmation, ni quittance. Seuls une confirmation signée et le relevé du compte public font foi.',
      provider: connector.id, paymentReference: order.paymentReference, paymentOrderId: order.id, orderStatusAtRequest: order.status,
      providerResult: res.providerResult, sandbox: res.sandbox, requestedBy: user.id, requestedAt: this.clock.now().toISOString(),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'payment.provider_resolution.requested', resourceType: 'payment_order', resourceId: order.id,
      details: { resolutionId: record.id, provider: connector.id, legalEffect: 'AUCUN' },
    });
    return record;
  }

  /** Annonce de règlement : journalisée et conservée comme indice ; ne fait JAMAIS passer à REGLE / RAPPROCHE. */
  private announceSettlement(providerId: string, ev: SettlementEvent): WebhookEventResult {
    const order = this.resolveEventOrder(providerId, ev);
    let amountMatchesOrder: boolean | undefined;
    if (ev.amount && order) {
      try {
        amountMatchesOrder = Money.fromJSON(ev.amount).equals(Money.fromJSON(order.amount));
      } catch {
        amountMatchesOrder = false;
      }
    }
    const hint = this.settlementAnnouncements.append({
      id: this.ids.next('SETANN'), provider: providerId, eventId: ev.eventId,
      ...(ev.providerIntentId ? { providerIntentId: ev.providerIntentId } : {}),
      ...(order ? { paymentReference: order.paymentReference, paymentOrderId: order.id } : ev.paymentReference ? { paymentReference: ev.paymentReference } : {}),
      ...(ev.settlementId ? { settlementId: ev.settlementId } : {}),
      ...(ev.amount ? { amount: ev.amount } : {}),
      ...(amountMatchesOrder !== undefined ? { amountMatchesOrder } : {}),
      ...(ev.settledAt ? { settledAt: ev.settledAt } : {}),
      receivedAt: this.clock.now().toISOString(),
    });
    this.audit.append({
      actor: { kind: 'provider', id: providerId }, action: 'payment.settlement_announced', resourceType: 'payment_order', resourceId: order?.id ?? ev.providerIntentId ?? ev.eventId,
      outcome: order && amountMatchesOrder !== false ? 'SUCCESS' : 'FAILURE',
      details: {
        announcementId: hint.id, eventId: ev.eventId, settlementId: ev.settlementId, paymentReference: hint.paymentReference, orderStatus: order?.status,
        amountMatchesOrder, note: 'Indice de rapprochement uniquement : REGLE/RAPPROCHE exigent le relevé du compte public.',
      },
    });
    return { eventId: ev.eventId, eventType: ev.eventType, outcome: 'SETTLEMENT_ANNOUNCED', ...(hint.paymentReference ? { paymentReference: hint.paymentReference } : {}) };
  }

  /**
   * Relais vers l'API de vérification capture d'écran / code SMS du prestataire, réservé à R17, R18 et R20
   * pour documenter un dossier de litige ou d'exception. Le résultat est une PIÈCE DE DOSSIER : il ne modifie
   * jamais l'état du paiement et n'émet jamais de quittance (§ 18.5 : aucune quittance sur preuve visuelle).
   */
  async requestVerificationEvidence(
    user: User,
    input: { paymentReference: string; caseRef: string; smsCode?: string; screenshotSha256?: string },
  ): Promise<VerificationEvidenceRecord> {
    authorize(user, 'payment.evidence');
    const order = this.byReference(input.paymentReference);
    if (!order) throw notFound('PAYMENT_REFERENCE_NOT_FOUND', `Référence inconnue : ${input.paymentReference}`);
    if (!order.provider || !order.providerIntentId) {
      throw unprocessable('NO_PROVIDER_INTENT', 'Cet ordre n’est lié à aucune intention d’un prestataire connecté.');
    }
    const connector = this.connectors.get(order.provider);
    if (!connector) throw unprocessable('UNKNOWN_PROVIDER', `Prestataire non connecté : ${order.provider}`);
    const res = await connector.requestVerificationEvidence({
      providerIntentId: order.providerIntentId, paymentReference: order.paymentReference,
      ...(input.smsCode ? { smsCode: input.smsCode } : {}), ...(input.screenshotSha256 ? { screenshotSha256: input.screenshotSha256 } : {}),
    });
    const record = this.verificationEvidence.append({
      id: this.ids.next('EVID'),
      kind: 'PROVIDER_VERIFICATION_EVIDENCE',
      legalEffect: 'AUCUN',
      notice: 'Pièce de dossier uniquement. Aucune quittance ni changement d’état ne peut en résulter : seule la confirmation serveur à serveur signée fait foi, puis le relevé du compte public.',
      caseRef: input.caseRef,
      provider: connector.id,
      paymentReference: order.paymentReference,
      paymentOrderId: order.id,
      orderStatusAtRequest: order.status,
      ...(input.smsCode ? { smsCodeSha256: sha256Hex(input.smsCode) } : {}),
      ...(input.screenshotSha256 ? { screenshotSha256: input.screenshotSha256 } : {}),
      providerResult: res.providerResult,
      sandbox: res.sandbox,
      requestedBy: user.id,
      requestedAt: this.clock.now().toISOString(),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'payment.verification_evidence.requested', resourceType: 'payment_order', resourceId: order.id,
      details: { evidenceId: record.id, caseRef: input.caseRef, provider: connector.id, legalEffect: 'AUCUN' },
    });
    return record;
  }

  /** § 20.3 : regroupement par commune du fait générateur ; sans lieu établi ⇒ « NON_ATTRIBUE », jamais deviné. */
  revenueByCommune(): CommuneRevenue[] {
    const rows = new Map<string, { confirmedCount: number; paid: Map<string, Money>; reconciled: Map<string, Money> }>();
    const add = (m: Map<string, Money>, v: MoneyJSON) => {
      const cur = m.get(v.currency);
      m.set(v.currency, cur ? cur.add(Money.fromJSON(v)) : Money.fromJSON(v));
    };
    for (const o of this.orders.all()) {
      if (o.status !== 'CONFIRME' && o.status !== 'REGLE' && o.status !== 'RAPPROCHE') continue;
      const commune = o.attribution?.commune ?? UNATTRIBUTED_COMMUNE;
      const row = rows.get(commune) ?? { confirmedCount: 0, paid: new Map(), reconciled: new Map() };
      row.confirmedCount += 1;
      add(row.paid, o.amount);
      if (o.status === 'RAPPROCHE') add(row.reconciled, o.amount);
      rows.set(commune, row);
    }
    const json = (m: Map<string, Money>) => [...m.values()].map((x) => x.toJSON());
    return [...rows.entries()]
      .map(([commune, r]) => ({ commune, confirmedCount: r.confirmedCount, paid: json(r.paid), reconciled: json(r.reconciled) }))
      .sort((a, b) => (a.commune === UNATTRIBUTED_COMMUNE ? 1 : b.commune === UNATTRIBUTED_COMMUNE ? -1 : a.commune.localeCompare(b.commune, 'fr')));
  }

  byReference(ref: string): PaymentOrder | undefined {
    return this.orders.findOne((o) => o.paymentReference === ref);
  }

  byObligation(obligationId: string): PaymentOrder[] {
    return this.orders.find((o) => o.obligationId === obligationId);
  }

  /**
   * Contrepassation d'un paiement décidée en double validation (module Trésor) : transition contrôlée par la table
   * partagée des états (canTransition), jamais une réécriture directe. Les contre-écritures sont rattachées à l'ordre.
   */
  markReversed(orderId: string, reversalEntryIds: string[]): PaymentOrder {
    const o = this.orders.get(orderId);
    if (!o) throw notFound('PAYMENT_ORDER_NOT_FOUND', `Ordre inconnu : ${orderId}`);
    return this.transition(o, 'CONTREPASSE', { ledgerEntryIds: [...o.ledgerEntryIds, ...reversalEntryIds] });
  }

  /** Remboursement approuvé en double validation vers l'instrument d'origine (transition contrôlée). */
  markRefunded(orderId: string, refundEntryId: string): PaymentOrder {
    const o = this.orders.get(orderId);
    if (!o) throw notFound('PAYMENT_ORDER_NOT_FOUND', `Ordre inconnu : ${orderId}`);
    return this.transition(o, 'REMBOURSE', { ledgerEntryIds: [...o.ledgerEntryIds, refundEntryId] });
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
