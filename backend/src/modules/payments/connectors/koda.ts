/**
 * Connecteur KODA (https://kodajnn.com/v1) — prestataire CANDIDAT, non désigné (voir document maître § 18.7).
 *
 * Faits documentés : Bearer sk_… ; POST /intents {amount (entier, unités mineures KODA), currency, operators[],
 * metadata{}, success_url} → {intent_id, client_secret, checkout_url} ; GET /intents/{id} ; POST /intents/{id}/cancel ;
 * webhook `x-koda-signature` = HMAC-SHA256 hexadécimal du corps brut ; événements `payment.verified`, `payment.verified.late`.
 * KODA traite le CDF comme une devise à ZÉRO décimale (25000 = 25 000 FC) et l'USD à 2 décimales (589 = 5,89 $).
 *
 * Hypothèses [À VÉRIFIER sur /v1/openapi.json] : forme exacte du corps des webhooks (parseur tolérant ci-dessous),
 * absence d'horodatage signé (anti-rejeu par identifiant d'événement), prise en charge de l'en-tête Idempotency-Key,
 * préfixe des clés de test, corps de POST /intents/{id}/verify.
 */
import { hmacSha256Hex, randomSecret, safeEqualHex, sha256Hex } from '../../../core/crypto.js';
import { ProviderHttpClient, type FetchLike, type HttpLogger } from './http-client.js';
import { fromMinorUnits, parseMinorInput, toMinorUnits, toSafeJsonInteger, type ExponentTable } from './minor-units.js';
import {
  headerValue, maskSecret, modeFromKey, pick, pickString, pickTimestamp, WebhookPayloadError, WebhookVerificationError,
  type ConnectorMode, type CreatedIntent, type HeaderBag, type IntentRequest, type NormalizedProviderEvent, type PaymentConnector,
  type VerificationEvidenceInput, type VerificationEvidenceResult, type VerifiedWebhook,
} from './types.js';

export const KODA_DEFAULT_BASE_URL = 'https://kodajnn.com/v1';
export const KODA_DEMO_WEBHOOK_SECRET = 'demo-whsec-koda';
export const KODA_SIGNATURE_HEADER = 'x-koda-signature';
/** CDF à zéro décimale chez KODA (≠ MOSOLO : 2 décimales). */
export const KODA_EXPONENTS: ExponentTable = { CDF: 0, USD: 2 };
export const KODA_SUCCESS_EVENTS = ['payment.verified', 'payment.verified.late'] as const;

export interface KodaConfig {
  apiKey?: string;
  webhookSecret: string;
  baseUrl: string;
  settlementAccountAlias: string;
  operators: string[];
  successUrl: string;
  exponents?: ExponentTable;
}

export interface ConnectorRuntime {
  fetch?: FetchLike;
  logger?: HttpLogger;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** Signature attendue d'un webhook KODA (utilitaire démo / tests). */
export function signKodaWebhook(secret: string, rawBody: string): string {
  return hmacSha256Hex(secret, rawBody);
}

export class KodaConnector implements PaymentConnector {
  readonly id = 'koda' as const;
  readonly label = 'KODA';
  readonly mode: ConnectorMode;
  readonly settlementAccountAlias: string;
  readonly exponents: ExponentTable;
  private readonly http?: ProviderHttpClient;

  constructor(private readonly config: KodaConfig, runtime: ConnectorRuntime = {}) {
    this.mode = modeFromKey('KODA', config.apiKey);
    this.settlementAccountAlias = config.settlementAccountAlias;
    this.exponents = config.exponents ?? KODA_EXPONENTS;
    if (config.apiKey) {
      this.http = new ProviderHttpClient({
        provider: 'koda', baseUrl: config.baseUrl, apiKey: config.apiKey,
        // Idempotence d'un POST rejoué non documentée chez KODA : aucune nouvelle tentative de POST [À VÉRIFIER].
        idempotentPostsWithKey: false,
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}), ...(runtime.logger ? { logger: runtime.logger } : {}),
        ...(runtime.sleep ? { sleep: runtime.sleep } : {}), ...(runtime.timeoutMs ? { timeoutMs: runtime.timeoutMs } : {}),
      });
    }
  }

  get sandbox(): boolean {
    return this.mode !== 'LIVE';
  }

  async createIntent(req: IntentRequest): Promise<CreatedIntent> {
    // Conversion exacte AVANT tout appel : un montant non représentable est refusé (422), jamais arrondi.
    const amount = toSafeJsonInteger(toMinorUnits(req.amount, this.exponents));
    if (!this.http) {
      return { providerIntentId: `sbx_koda_${randomSecret(8)}`, checkoutUrl: null, qrPayload: null, sandbox: true };
    }
    const sep = this.config.successUrl.includes('?') ? '&' : '?';
    const res = await this.http.request<Record<string, unknown>>('POST', '/intents', {
      moneyMoving: true,
      idempotencyKey: req.paymentReference,
      body: {
        amount,
        currency: req.amount.currency,
        operators: this.config.operators,
        // Métadonnées minimales : aucune donnée personnelle du contribuable.
        metadata: {
          payment_reference: req.paymentReference, order_id: req.paymentOrderId, obligation_id: req.obligationId,
          description: `KINSHASA MOSOLO ${req.paymentReference}`,
        },
        success_url: `${this.config.successUrl}${sep}reference=${encodeURIComponent(req.paymentReference)}`,
      },
    });
    const providerIntentId = pickString(res, 'intent_id', 'id', 'intent.id');
    if (!providerIntentId) throw new WebhookPayloadError('PROVIDER_RESPONSE_INVALID', 'Réponse KODA sans intent_id.');
    // `client_secret` n'est ni conservé ni renvoyé : MOSOLO n'expose aucun secret prestataire au navigateur.
    return { providerIntentId, checkoutUrl: pickString(res, 'checkout_url') ?? null, qrPayload: null, sandbox: this.sandbox };
  }

  async cancelIntent(providerIntentId: string, idempotencyKey: string): Promise<void> {
    if (!this.http) return;
    await this.http.request('POST', `/intents/${encodeURIComponent(providerIntentId)}/cancel`, { moneyMoving: true, idempotencyKey, body: {} });
  }

  verifyWebhook(headers: HeaderBag, rawBody: string, now: Date): VerifiedWebhook {
    const provided = headerValue(headers, KODA_SIGNATURE_HEADER);
    if (!provided) throw new WebhookVerificationError('SIGNATURE_MISSING', `En-tête ${KODA_SIGNATURE_HEADER} obligatoire.`);
    const expected = hmacSha256Hex(this.config.webhookSecret, rawBody);
    if (!safeEqualHex(expected, provided.trim().replace(/^sha256=/, '').toLowerCase())) {
      throw new WebhookVerificationError('INVALID_SIGNATURE', 'Signature KODA invalide.');
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WebhookPayloadError('INVALID_JSON', 'Corps JSON invalide.');
    }
    return {
      events: [this.normalize(json, rawBody, now)],
      // KODA ne signe pas d'horodatage (à notre connaissance) : l'anti-rejeu repose sur l'identifiant d'événement.
      checks: { signatureVerified: true, replayGuard: 'EVENT_ID', timestampInWindow: 'NON_APPLICABLE' },
    };
  }

  /** Parseur tolérant [À VÉRIFIER sur /v1/openapi.json]. */
  private normalize(json: unknown, rawBody: string, now: Date): NormalizedProviderEvent {
    const eventType = pickString(json, 'type', 'event', 'event_type') ?? 'inconnu';
    const eventId = pickString(json, 'id', 'event_id') ?? `sha256:${sha256Hex(rawBody)}`;
    const metadata = pick(json, 'metadata', 'data.metadata', 'intent.metadata', 'data.intent.metadata');
    const providerIntentId = pickString(json, 'intent_id', 'intent.id', 'data.intent_id', 'data.intent.id');
    const paymentReference = pickString(metadata, 'payment_reference');
    const paymentOrderId = pickString(metadata, 'order_id');
    const base = {
      eventId, eventType,
      ...(providerIntentId ? { providerIntentId } : {}),
      ...(paymentReference ? { paymentReference } : {}),
      ...(paymentOrderId ? { paymentOrderId } : {}),
    };
    if (!(KODA_SUCCESS_EVENTS as readonly string[]).includes(eventType)) return { kind: 'IGNORED', reason: 'UNKNOWN_TYPE', ...base };

    const minor = parseMinorInput(pick(json, 'amount', 'data.amount', 'intent.amount', 'data.intent.amount'));
    const currency = pickString(json, 'currency', 'data.currency', 'intent.currency', 'data.intent.currency')?.toUpperCase();
    if (minor === undefined || !currency) throw new WebhookPayloadError('PROVIDER_AMOUNT_MISSING', 'Événement KODA sans montant entier ni devise.');
    let amount;
    try {
      amount = fromMinorUnits(minor, currency, this.exponents);
    } catch (e) {
      throw new WebhookPayloadError('PROVIDER_AMOUNT_INVALID', (e as Error).message);
    }
    const receiptId = pickString(json, 'receipt_id', 'data.receipt_id');
    if (!receiptId && !providerIntentId) throw new WebhookPayloadError('PROVIDER_TXN_MISSING', 'Événement KODA sans receipt_id ni intent_id.');
    return {
      kind: 'PAYMENT', ...base,
      // Unicité de transaction : reçu KODA (un 2e reçu sur la même référence ⇒ DOUBLON), sinon l'intention.
      providerTxnId: receiptId ?? providerIntentId!,
      ...(receiptId ? { providerReceiptId: receiptId } : {}),
      amount, status: 'SUCCESS',
      completedAt: pickTimestamp(json, 'verified_at', 'data.verified_at', 'created_at', 'data.created_at', 'created') ?? now.toISOString(),
      confirmationMethod: 'KODA_OPERATOR_LEDGER',
      late: eventType === 'payment.verified.late',
    };
  }

  async requestVerificationEvidence(input: VerificationEvidenceInput): Promise<VerificationEvidenceResult> {
    if (!this.http) {
      return { sandbox: true, providerResult: { status: 'SANDBOX_NON_VERIFIE', note: 'Bac à sable local : aucun appel au prestataire.' } };
    }
    // Corps [À VÉRIFIER sur /v1/openapi.json] ; la capture elle-même n'est jamais transmise, seule son empreinte.
    const providerResult = await this.http.request('POST', `/intents/${encodeURIComponent(input.providerIntentId)}/verify`, {
      body: { ...(input.smsCode ? { sms_code: input.smsCode } : {}), ...(input.screenshotSha256 ? { screenshot_sha256: input.screenshotSha256 } : {}) },
    });
    return { sandbox: this.sandbox, providerResult };
  }

  describe(): Record<string, unknown> {
    return {
      id: this.id, label: this.label, mode: this.mode, baseUrl: this.config.baseUrl, apiKey: maskSecret(this.config.apiKey),
      webhookSecret: maskSecret(this.config.webhookSecret), settlementAccountAlias: this.settlementAccountAlias,
      operators: this.config.operators, exponents: this.exponents,
    };
  }
}
