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
import { ProviderHttpClient, type CircuitOptions, type CircuitSnapshot, type FetchLike, type HttpLogger } from './http-client.js';
import { fromMinorUnits, parseMinorInput, toMinorUnits, toSafeJsonInteger, type ExponentTable } from './minor-units.js';
import {
  classifyIntentStatus, headerValue, maskSecret, modeFromKey, pick, pickString, pickTimestamp, WebhookPayloadError, WebhookVerificationError,
  type ConnectorMode, type CreatedIntent, type HeaderBag, type IntentRequest, type NormalizedProviderEvent, type PaymentConnector,
  type ConnectionTestResult, type ProviderIntentStatus, type VerificationEvidenceInput, type VerificationEvidenceResult, type VerifiedWebhook,
} from './types.js';

export const KODA_DEFAULT_BASE_URL = 'https://kodajnn.com/v1';
export const KODA_DEMO_WEBHOOK_SECRET = 'demo-whsec-koda';
export const KODA_SIGNATURE_HEADER = 'x-koda-signature';
/** CDF à zéro décimale chez KODA (≠ MOSOLO : 2 décimales). */
export const KODA_EXPONENTS: ExponentTable = { CDF: 0, USD: 2 };
export const KODA_SUCCESS_EVENTS = ['payment.verified', 'payment.verified.late'] as const;
/** Libellés de statut d'intention KODA (GET /intents/{id}) — [À CONFIRMER AVEC LE PRESTATAIRE] : non documentés. */
export const KODA_STATUS_SUCCEEDED = ['verified', 'paid', 'succeeded', 'completed'] as const;
export const KODA_STATUS_FAILED = ['failed', 'canceled', 'cancelled', 'expired'] as const;
export const KODA_STATUS_PENDING = ['pending', 'created', 'processing', 'requires_payment'] as const;
/** Point d'appel de « Tester la connexion » : spécification publiée /v1/openapi.json (lecture seule, sans effet). */
export const KODA_PING_PATH = '/openapi.json';

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
  maxRetries?: number;
  /** Disjoncteur (défauts : DEFAULT_CIRCUIT, à confirmer). */
  circuit?: Partial<CircuitOptions>;
  /** Horloge du disjoncteur et des mesures (tests). */
  now?: () => number;
}

/** Options communes du client HTTP d'un connecteur, tirées de l'environnement d'exécution. */
export function runtimeHttpOptions(runtime: ConnectorRuntime) {
  return {
    ...(runtime.fetch ? { fetch: runtime.fetch } : {}), ...(runtime.logger ? { logger: runtime.logger } : {}),
    ...(runtime.sleep ? { sleep: runtime.sleep } : {}), ...(runtime.timeoutMs ? { timeoutMs: runtime.timeoutMs } : {}),
    ...(runtime.maxRetries !== undefined ? { maxRetries: runtime.maxRetries } : {}),
    ...(runtime.circuit ? { circuit: runtime.circuit } : {}), ...(runtime.now ? { now: runtime.now } : {}),
  };
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
  readonly signatureScheme = 'HMAC-SHA256 hexadécimal du corps brut, en-tête x-koda-signature (préfixe « sha256= » toléré) ; aucun horodatage signé connu : anti-rejeu par identifiant d’événement persistant';
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
        ...runtimeHttpOptions(runtime),
      });
    }
  }

  get sandbox(): boolean {
    return this.mode !== 'LIVE';
  }

  get operators(): readonly string[] {
    return this.config.operators;
  }

  /** État du disjoncteur des appels sortants (absent en bac à sable local). */
  circuitSnapshot(): CircuitSnapshot | null {
    return this.http?.circuitSnapshot() ?? null;
  }

  /** GET /intents/{id} (documenté) ; forme de la réponse [À CONFIRMER AVEC LE PRESTATAIRE] : parseur tolérant. */
  async fetchIntentStatus(providerIntentId: string): Promise<ProviderIntentStatus> {
    if (!this.http) throw new WebhookPayloadError('STATUS_QUERY_UNAVAILABLE', 'KODA : bac à sable local, aucune interrogation serveur à serveur possible.');
    const res = await this.http.request<Record<string, unknown>>('GET', `/intents/${encodeURIComponent(providerIntentId)}`);
    const rawStatus = pickString(res, 'status', 'intent.status', 'data.status') ?? null;
    const minor = parseMinorInput(pick(res, 'amount', 'intent.amount', 'data.amount'));
    const currency = pickString(res, 'currency', 'intent.currency', 'data.currency')?.toUpperCase();
    let amount;
    if (minor !== undefined && currency) {
      try {
        amount = fromMinorUnits(minor, currency, this.exponents);
      } catch {
        amount = undefined;
      }
    }
    return {
      providerIntentId: pickString(res, 'intent_id', 'id', 'intent.id') ?? providerIntentId,
      status: classifyIntentStatus(rawStatus ?? undefined, KODA_STATUS_SUCCEEDED, KODA_STATUS_FAILED, KODA_STATUS_PENDING),
      rawStatus, ...(amount ? { amount } : {}),
    };
  }

  /**
   * « Tester la connexion » : KODA ne documente (à notre connaissance) aucun point d'appel « ping » ou « solde ». En mode
   * réel : GET /v1/openapi.json (spécification publiée, lecture seule) — prouve la joignabilité, PAS la validité de la
   * clé. En bac à sable local : validation à blanc de la configuration, sans aucun appel.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const checks = [
      { label: 'Secret de webhook présent', ok: !!this.config.webhookSecret },
      { label: 'Alias du compte de règlement défini', ok: !!this.settlementAccountAlias, detail: this.settlementAccountAlias },
      { label: 'Opérateurs définis', ok: this.config.operators.length > 0, detail: this.config.operators.join(', ') },
      { label: 'URL de retour (success_url) en https', ok: /^https:\/\//.test(this.config.successUrl) || this.mode === 'SANDBOX_LOCAL', detail: this.config.successUrl },
      { label: 'URL de l’API en https', ok: /^https:\/\//.test(this.config.baseUrl) || this.mode !== 'LIVE', detail: this.config.baseUrl },
    ];
    if (!this.http) {
      return {
        kind: 'VALIDATION_A_BLANC', ok: checks.every((c) => c.ok), checks,
        proves: 'Validation à blanc : cohérence de la configuration seulement. Aucun appel n’a été fait au prestataire (bac à sable local, aucune clé API).',
        detail: 'Bac à sable local : renseigner KODA_API_KEY pour un essai réel.',
      };
    }
    const started = Date.now();
    try {
      await this.http.request('GET', KODA_PING_PATH);
      return {
        kind: 'APPEL_REEL', ok: checks.every((c) => c.ok), endpoint: `GET ${KODA_PING_PATH}`, httpStatus: 200, durationMs: Date.now() - started, checks,
        proves: 'Appel réel inoffensif (lecture de la spécification publiée) : prouve la joignabilité de l’API KODA. Ne prouve PAS la validité de la clé API (point d’appel authentifié sans effet non documenté — À CONFIRMER AVEC LE PRESTATAIRE).',
        detail: 'API KODA joignable.',
      };
    } catch (e) {
      const status = e instanceof Error && 'providerStatus' in e ? (e as { providerStatus?: number }).providerStatus : undefined;
      return {
        kind: 'APPEL_REEL', ok: false, endpoint: `GET ${KODA_PING_PATH}`, ...(status !== undefined ? { httpStatus: status } : {}), durationMs: Date.now() - started, checks,
        proves: 'Appel réel inoffensif en échec : l’API KODA n’a pas répondu correctement.', detail: e instanceof Error ? e.message : 'erreur',
      };
    }
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
