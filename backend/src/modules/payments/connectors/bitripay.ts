/**
 * Connecteur BitriPay (https://api.bitripay.com/v1 — page développeur du prestataire, clés de test et réelles sur la même
 * URL ; https://www.bitripay.com/api/v1 et https://www.bitripay.com/v1, serveurs de l'OpenAPI, en variantes documentées) — prestataire CANDIDAT, non désigné.
 *
 * Faits documentés : Bearer sk_… ; Idempotency-Key sur tout POST financier ; POST /payment_intents {amount_minor,
 * currency, description, allowed_operators[orange_cd, mpesa_cd, airtel_cd, africell_cd], metadata} →
 * {id, checkout_url, qr_payload, client_secret} ; GET /payment_intents/{id} ; POST /payment_intents/{id}/cancel ;
 * webhook `BitriPay-Signature` (HMAC, secret whsec_ du point de terminaison) + clé plateforme Ed25519 publiée à
 * GET /v1/keys ; événements `payment_intent.succeeded` et `payment_intent.settled`.
 *
 * Hypothèses [À VÉRIFIER sur l'OpenAPI BitriPay] : format de l'en-tête de signature (schéma « à la Stripe »
 * `t=<unix>,v1=<hex HMAC-SHA256 de "<t>.<corps brut>">`, tolérance ±5 min), en-tête `BitriPay-Signature-Ed25519`
 * (signature base64 du corps brut), forme des événements (`data.object`), exposant du CDF (défaut ISO 4217 : 2),
 * noms `payment_intent.payment_failed` / `payment_intent.canceled`, corps de POST /verifications.
 *
 * Comptes connectés (plateformes et agrégateurs) : BitriPay détient la licence d'agrégateur ; chaque client est
 * le « merchant of record » avec ses portefeuilles, son profil de règlement et ses relevés. Si MOSOLO est intégré
 * par un tiers, la Ville (régie) est le compte connecté : l'en-tête `BitriPay-Account: acct_…` accompagne CHAQUE
 * requête et chaque webhook doit porter ce même `account`. Doctrine : AUCUN `application_fee_minor` n'est jamais
 * envoyé (la rémunération d'un intégrateur relève d'un contrat plafonné, jamais d'un prélèvement sur la recette
 * publique) ; un frais constaté sur un événement déclenche une alerte critique.
 * `payment_intent.ambiguous_hold` (résultat opérateur inconnu, paiement en revue manuelle) : aucune quittance,
 * exception de rapprochement. GET /payment_resolution : pièce de dossier, jamais une confirmation À ELLE SEULE.
 *
 * Documentation publique fournie par le maître d'ouvrage (29/09/2026) — désormais CONFIRMÉ : une seule URL
 * https://api.bitripay.com/v1 (clés sk_test_… et sk_live_…) ; POST /payment_intents {amount_minor, currency, description,
 * allowed_operators[orange_cd, mpesa_cd, airtel_cd, africell_cd]} avec `Authorization: Bearer` et `Idempotency-Key` →
 * checkout_url, qr_payload, client_secret ; GET /payment_intents/{id} ; POST /payment_intents/{id}/cancel ;
 * GET /payment_intents/{id}/timeline ; webhook `BitriPay-Signature` (HMAC, secret whsec_ du point de terminaison) + clé
 * plateforme Ed25519 publiée à GET /keys (publique, mise en cache par ETag) ; GET /status (état de fonctionnement :
 * normal, gardien, dégradé) — utilisé pour « Tester la connexion » et l'affichage du disjoncteur ; POST /verifications
 * (Scan-to-Verify) ; GET /payment_resolution (CONFIRMED / PENDING / AMBIGUOUS / NOT_FOUND) — désormais utilisé comme
 * CONFIRMATION SERVEUR À SERVEUR SUPPLÉMENTAIRE avant toute quittance (désactivable : BITRIPAY_RESOLUTION_CHECK=false) ;
 * en-tête BitriPay-Account (comptes connectés) ; événements payment_intent.succeeded, payment_intent.ambiguous_hold
 * (jamais de quittance : attente / revue manuelle), échecs ; livraison « au moins une fois » : dédoublonnage par
 * identifiant d'événement (déjà en place). Bac à sable : +243000000501 réussit, +243000000404 échoue, +243000000408
 * ambigu, +243000000500 délai puis succès, +243000000503 prestataire indisponible, numéros finissant par 0000 refusés.
 */
import { createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { hmacSha256Hex, randomSecret, safeEqualHex, sha256Hex } from '../../../core/crypto.js';
import { ProviderHttpClient, type CircuitSnapshot } from './http-client.js';
import { runtimeHttpOptions, type ConnectorRuntime } from './koda.js';
import { fromMinorUnits, parseMinorInput, toMinorUnits, toSafeJsonInteger, type ExponentTable } from './minor-units.js';
import type { MoneyJSON } from '@mosolo/shared';
import {
  classifyIntentStatus, ConnectorConfigError, headerValue, maskSecret, modeFromKey, pick, pickString, pickTimestamp, WebhookPayloadError, WebhookVerificationError,
  type ConnectorMode, type CreatedIntent, type HeaderBag, type IntentRequest, type NormalizedProviderEvent, type PaymentConnector,
  type ConnectionTestResult, type ProviderIntentStatus, type VerificationEvidenceInput, type VerificationEvidenceResult, type VerifiedWebhook, type WebhookChecks,
} from './types.js';

/**
 * URL par défaut : https://api.bitripay.com/v1 — confirmée par la page développeur de BitriPay (29/09/2026) : clés de
 * test (bac à sable) et réelles sur la même URL. Variantes documentées (serveurs de l'OpenAPI 2026-09-01) :
 * https://www.bitripay.com/api/v1 et https://www.bitripay.com/v1 ; BITRIPAY_BASE_URL reste configurable.
 */
export const BITRIPAY_DEFAULT_BASE_URL = 'https://api.bitripay.com/v1';
/** Même adresse que le défaut (nom conservé pour les références antérieures). */
export const BITRIPAY_LEGACY_BASE_URL = BITRIPAY_DEFAULT_BASE_URL;
/** Serveurs déclarés par l'OpenAPI 2026-09-01 (variantes documentées). */
export const BITRIPAY_OPENAPI_BASE_URLS = ['https://www.bitripay.com/api/v1', 'https://www.bitripay.com/v1'] as const;
export const BITRIPAY_KNOWN_BASE_URLS = [BITRIPAY_DEFAULT_BASE_URL, ...BITRIPAY_OPENAPI_BASE_URLS] as const;
/** Codes d'objet (purpose_code) documentés utilisés par MOSOLO. */
export type BitriPayPurposeCode = 'TAX' | 'GOVERNMENT_FEE';
/**
 * Catégorie de recette ⇒ purpose_code : droits administratifs et redevances de service = GOVERNMENT_FEE ; tout le reste =
 * TAX (défaut). Correspondance PAR DÉFAUT — À CONFIRMER PAR LE MAÎTRE D'OUVRAGE (et avec le prestataire).
 */
export function purposeCodeFor(revenueCategory: string | undefined): BitriPayPurposeCode {
  return revenueCategory === 'DROIT_ADMINISTRATIF' || revenueCategory === 'REDEVANCE_SERVICE' ? 'GOVERNMENT_FEE' : 'TAX';
}
/** Événements documentés sans effet sur l'ordre (étapes intermédiaires, objets annexes) : journalisés seulement. */
export const BITRIPAY_INFORMATIONAL_EVENTS = [
  'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.authorised',
  'checkout.session.completed', 'checkout.session.expired', 'verification.completed', 'verification.confirmed',
  'settlement.created', 'settlement.completed', 'reconciliation.exception',
] as const;
export const BITRIPAY_DEMO_WEBHOOK_SECRET = 'demo-whsec-bitripay';
export const BITRIPAY_SIGNATURE_HEADER = 'bitripay-signature';
export const BITRIPAY_ED25519_HEADER = 'bitripay-signature-ed25519';
export const BITRIPAY_TOLERANCE_SECONDS = 300;
export const BITRIPAY_OPERATORS = ['orange_cd', 'mpesa_cd', 'airtel_cd', 'africell_cd'] as const;
export const BITRIPAY_ACCOUNT_HEADER = 'bitripay-account';
const CONNECTED_ACCOUNT_RE = /^acct_[A-Za-z0-9_]{4,64}$/;
/** Statuts d'intention (GET /payment_intents/{id}) — schéma « à la Stripe » supposé [À CONFIRMER AVEC LE PRESTATAIRE]. */
export const BITRIPAY_STATUS_SUCCEEDED = ['succeeded', 'settled'] as const;
export const BITRIPAY_STATUS_FAILED = ['canceled', 'cancelled', 'failed', 'expired'] as const;
export const BITRIPAY_STATUS_PENDING = ['requires_payment_method', 'requires_action', 'processing', 'pending', 'ambiguous_hold', 'created'] as const;
/** Clé publique de la plateforme publiée à GET /v1/keys (documenté, lecture seule) : contrôle de la clé Ed25519 épinglée. */
export const BITRIPAY_PING_PATH = '/keys';
/** « Tester la connexion » : GET /v1/status (état de fonctionnement de la plateforme — documenté, lecture seule). */
export const BITRIPAY_STATUS_PATH = '/status';
/** État de fonctionnement « normal » lu à GET /status (libellés tolérés [forme exacte À CONFIRMER AVEC LE PRESTATAIRE]). */
export const BITRIPAY_OPERATING_NORMAL = ['operational', 'normal', 'ok', 'up', 'healthy'] as const;
/** Réponses de GET /payment_resolution (documentées). */
export type BitriPayResolution = 'CONFIRMED' | 'PENDING' | 'AMBIGUOUS' | 'NOT_FOUND' | 'INCONNU';

/** Lecture tolérante du verdict de GET /payment_resolution. */
export function classifyResolution(providerResult: unknown): BitriPayResolution {
  const raw = (pickString(providerResult, 'resolution', 'status', 'result', 'data.resolution', 'data.status') ?? '').toUpperCase();
  return raw === 'CONFIRMED' || raw === 'PENDING' || raw === 'AMBIGUOUS' || raw === 'NOT_FOUND' ? raw : 'INCONNU';
}

/** Dernier état de fonctionnement lu à GET /status (affichage du disjoncteur ; aucune donnée secrète). */
export interface BitriPayPlatformStatus {
  at: string;
  /** Libellé brut (operational, guardian, degraded…). */
  state: string | null;
  /** NORMAL : fonctionnement normal ; DEGRADE : mode dégradé ou gardien ; INCONNU : illisible. */
  level: 'NORMAL' | 'DEGRADE' | 'INCONNU';
  guardian: boolean;
  detail: string | null;
}

/** Numéros « magiques » du bac à sable BitriPay (clé de test) : chaque issue du moteur de tentatives. */
export const BITRIPAY_SANDBOX_MSISDNS = {
  '+243000000501': 'succeed',
  '+243000000404': 'fail',
  '+243000000408': 'ambiguous',
  '+243000000500': 'timeout_then_succeed',
  '+243000000503': 'provider_unavailable',
} as const;
/** Bac à sable BitriPay : tout numéro se terminant par 0000 est refusé (decline). */
export const BITRIPAY_SANDBOX_DECLINED_SUFFIX = '0000';

export interface BitriPayConfig {
  apiKey?: string;
  webhookSecret: string;
  /** Clé publique Ed25519 de la plateforme (PEM ou 32 octets bruts en base64), épinglée par configuration. */
  ed25519PublicKey?: string;
  /** Exiger la signature HMAC `BitriPay-Signature` (défaut : oui). */
  hmacRequired: boolean;
  /** Exiger la signature Ed25519 (défaut : non ; vérifiée si présente et clé configurée). */
  ed25519Required: boolean;
  toleranceSeconds?: number;
  baseUrl: string;
  settlementAccountAlias: string;
  /** Exposant du CDF chez BitriPay : 2 (ISO 4217, défaut) ou 0 [À VÉRIFIER]. */
  cdfExponent: 0 | 2;
  allowedOperators: string[];
  /** Compte connecté de la Ville (`acct_…`) quand la clé est celle d'un intégrateur ; absent si la Ville utilise sa propre clé. */
  connectedAccountId?: string;
  /** URL de retour vers MOSOLO (`${MOSOLO_PUBLIC_URL}/paiement/retour`) ; la référence est ajoutée en `?ref=`. */
  returnUrl?: string;
  /**
   * Nom du champ d'URL de retour de POST /payment_intents (ex. `return_url`) : NON documenté dans l'extrait fourni ⇒
   * rien n'est envoyé tant que BITRIPAY_RETURN_URL_FIELD n'est pas renseignée [À CONFIRMER AVEC LE PRESTATAIRE].
   */
  returnUrlField?: string;
  /** Confirmation supplémentaire par GET /payment_resolution avant quittance (défaut : oui). */
  resolutionCheck?: boolean;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function parseEd25519PublicKey(value: string): KeyObject {
  try {
    if (value.includes('BEGIN PUBLIC KEY')) return createPublicKey(value);
    const raw = Buffer.from(value, 'base64');
    if (raw.length !== 32) throw new Error('32 octets attendus');
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch (e) {
    throw new ConnectorConfigError(`BITRIPAY_ED25519_PUBLIC_KEY invalide (${(e as Error).message}).`);
  }
}

/** En-tête de signature attendu (utilitaire démo / tests) : `t=<unix>,v1=<hex>`. */
export function signBitriPayWebhook(secret: string, rawBody: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacSha256Hex(secret, `${unixSeconds}.${rawBody}`)}`;
}

export class BitriPayConnector implements PaymentConnector {
  readonly id = 'bitripay' as const;
  readonly label = 'BitriPay';
  readonly mode: ConnectorMode;
  readonly settlementAccountAlias: string;
  readonly exponents: ExponentTable;
  private readonly http?: ProviderHttpClient;
  private readonly edKey?: KeyObject;
  private readonly tolerance: number;
  readonly signatureScheme: string;
  /** Dernier état de fonctionnement lu à GET /status (null : jamais lu). */
  lastPlatformStatus: BitriPayPlatformStatus | null = null;
  private readonly clockNow: () => number;

  constructor(private readonly config: BitriPayConfig, runtime: ConnectorRuntime = {}) {
    // Clé secrète sk_… ou clé restreinte rk_… à portées (OpenAPI 2026-09-01) ; jamais une clé publiable pk_….
    this.mode = modeFromKey('BitriPay', config.apiKey, { allowRestricted: true });
    this.settlementAccountAlias = config.settlementAccountAlias;
    if (config.cdfExponent !== 0 && config.cdfExponent !== 2) throw new ConnectorConfigError('BITRIPAY_CDF_EXPONENT doit valoir 0 ou 2.');
    this.exponents = { CDF: config.cdfExponent, USD: 2 };
    this.tolerance = config.toleranceSeconds ?? BITRIPAY_TOLERANCE_SECONDS;
    if (config.ed25519PublicKey) this.edKey = parseEd25519PublicKey(config.ed25519PublicKey);
    this.signatureScheme = [
      `HMAC-SHA256 (en-tête BitriPay-Signature « t=<unix>,v1=<hex> » sur « <t>.<corps brut> », fenêtre ±${this.tolerance} s)${config.hmacRequired ? ' — exigée' : ' — facultative'}`,
      `Ed25519 (en-tête BitriPay-Signature-Ed25519 « keyId,t,sig », clé de la plateforme GET /keys épinglée)${config.ed25519Required ? ' — exigée' : this.edKey ? ' — vérifiée si présente' : ' — clé non configurée'}`,
    ].join(' ; ');
    if (config.ed25519Required && !this.edKey) throw new ConnectorConfigError('Ed25519 exigé mais BITRIPAY_ED25519_PUBLIC_KEY absente.');
    if (!config.hmacRequired && !config.ed25519Required) throw new ConnectorConfigError('BitriPay : au moins un schéma de signature doit être exigé.');
    if (config.returnUrlField !== undefined && !/^[a-z][a-z0-9_]{1,40}$/.test(config.returnUrlField)) {
      throw new ConnectorConfigError('BITRIPAY_RETURN_URL_FIELD invalide : nom de champ en minuscules attendu (ex. return_url).');
    }
    this.clockNow = runtime.now ?? Date.now;
    if (config.connectedAccountId !== undefined && !CONNECTED_ACCOUNT_RE.test(config.connectedAccountId)) {
      throw new ConnectorConfigError('BITRIPAY_ACCOUNT_ID invalide : identifiant de compte connecté « acct_… » attendu.');
    }
    if (config.apiKey) {
      this.http = new ProviderHttpClient({
        provider: 'bitripay', baseUrl: config.baseUrl, apiKey: config.apiKey,
        // BitriPay documente l'Idempotency-Key : un POST rejoué avec la même clé est sans double effet.
        idempotentPostsWithKey: true,
        ...runtimeHttpOptions(runtime),
        ...(config.connectedAccountId ? { extraHeaders: { [BITRIPAY_ACCOUNT_HEADER]: config.connectedAccountId } } : {}),
      });
    }
  }

  get sandbox(): boolean {
    return this.mode !== 'LIVE';
  }

  get operators(): readonly string[] {
    return this.config.allowedOperators;
  }

  circuitSnapshot(): CircuitSnapshot | null {
    return this.http?.circuitSnapshot() ?? null;
  }

  /** Dernière erreur de configuration renvoyée par BitriPay (ex. scope_denied : clé sans la portée requise). */
  configurationIssue() {
    return this.http?.lastConfigurationError ?? null;
  }

  /** GET /payment_intents/{id} (documenté) ; forme de la réponse [À CONFIRMER AVEC LE PRESTATAIRE] : parseur tolérant. */
  async fetchIntentStatus(providerIntentId: string): Promise<ProviderIntentStatus> {
    if (!this.http) throw new WebhookPayloadError('STATUS_QUERY_UNAVAILABLE', 'BitriPay : bac à sable local, aucune interrogation serveur à serveur possible.');
    const res = await this.http.request<Record<string, unknown>>('GET', `/payment_intents/${encodeURIComponent(providerIntentId)}`);
    const obj = pick(res, 'data.object', 'data') ?? res;
    const rawStatus = pickString(obj, 'status') ?? null;
    let amount;
    try {
      amount = this.amountOf(obj, false);
    } catch {
      amount = undefined;
    }
    return {
      providerIntentId: pickString(obj, 'id') ?? providerIntentId,
      status: classifyIntentStatus(rawStatus ?? undefined, BITRIPAY_STATUS_SUCCEEDED, BITRIPAY_STATUS_FAILED, BITRIPAY_STATUS_PENDING),
      rawStatus, ...(amount ? { amount } : {}),
    };
  }

  /** Confirmation supplémentaire par GET /payment_resolution avant toute quittance (défaut : oui). */
  get confirmsWithResolution(): boolean {
    return this.config.resolutionCheck !== false;
  }

  /** GET /status : état de fonctionnement de la plateforme (normal, gardien, dégradé), mémorisé pour l'affichage. */
  async fetchPlatformStatus(): Promise<BitriPayPlatformStatus> {
    if (!this.http) throw new WebhookPayloadError('STATUS_QUERY_UNAVAILABLE', 'BitriPay : bac à sable local, aucun appel au prestataire.');
    const res = await this.http.request<Record<string, unknown>>('GET', BITRIPAY_STATUS_PATH);
    const state = pickString(res, 'operating_state', 'state', 'status', 'data.state', 'data.status') ?? null;
    const guardianRaw = pick(res, 'guardian', 'guardian_mode', 'data.guardian');
    const guardian = guardianRaw === true || (typeof guardianRaw === 'object' && guardianRaw !== null && (guardianRaw as Record<string, unknown>).active === true)
      || /guardian/i.test(state ?? '');
    const degradedRaw = pick(res, 'degraded', 'data.degraded');
    const degraded = degradedRaw === true || /degrad/i.test(state ?? '');
    const normal = !!state && (BITRIPAY_OPERATING_NORMAL as readonly string[]).includes(state.toLowerCase()) && !guardian && !degraded;
    const level: BitriPayPlatformStatus['level'] = normal ? 'NORMAL' : degraded || guardian ? 'DEGRADE' : 'INCONNU';
    this.lastPlatformStatus = {
      at: new Date(this.clockNow()).toISOString(), state, level, guardian,
      detail: pickString(res, 'message', 'detail', 'reason', 'data.message') ?? null,
    };
    return this.lastPlatformStatus;
  }

  /**
   * « Tester la connexion » : en mode réel, GET /v1/status (état de fonctionnement de la plateforme, documenté,
   * lecture seule, authentifié) — prouve la joignabilité et, si la réponse est 200, l'acceptation de la clé ; signale
   * le mode dégradé ou gardien. Si une clé Ed25519 est épinglée, elle est aussi comparée à celle publiée par GET /v1/keys.
   * En bac à sable local : validation à blanc de la configuration, sans aucun appel.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const checks: ConnectionTestResult['checks'] = [
      { label: 'Secret de webhook présent', ok: !!this.config.webhookSecret },
      { label: 'Au moins un schéma de signature exigé', ok: this.config.hmacRequired || this.config.ed25519Required },
      { label: 'Alias du compte de règlement défini', ok: !!this.settlementAccountAlias, detail: this.settlementAccountAlias },
      { label: 'Opérateurs définis', ok: this.config.allowedOperators.length > 0, detail: this.config.allowedOperators.join(', ') },
      { label: 'URL de l’API en https', ok: /^https:\/\//.test(this.config.baseUrl) || this.mode !== 'LIVE', detail: this.config.baseUrl },
    ];
    if (!this.http) {
      return {
        kind: 'VALIDATION_A_BLANC', ok: checks.every((c) => c.ok), checks,
        proves: 'Validation à blanc : cohérence de la configuration seulement. Aucun appel n’a été fait au prestataire (bac à sable local, aucune clé API).',
        detail: 'Bac à sable local : renseigner BITRIPAY_API_KEY pour un essai réel.',
      };
    }
    const started = Date.now();
    try {
      const st = await this.fetchPlatformStatus();
      checks.push({
        label: 'Plateforme BitriPay en fonctionnement normal (GET /status)', ok: st.level === 'NORMAL',
        detail: st.level === 'NORMAL' ? st.state ?? undefined : `${st.level === 'DEGRADE' ? 'mode dégradé' : 'état illisible'}${st.guardian ? ' (gardien actif)' : ''} — ${st.state ?? 'inconnu'}`,
      });
      if (this.edKey) {
        const res = await this.http.request<unknown>('GET', BITRIPAY_PING_PATH);
        const pinned = this.edKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
        const published = JSON.stringify(res);
        const pem = this.edKey.export({ format: 'pem', type: 'spki' }).toString().replace(/-----[^-]+-----|\s/g, '');
        checks.push({ label: 'Clé Ed25519 épinglée identique à celle publiée par GET /v1/keys', ok: published.includes(pinned) || published.includes(pem) });
      }
      const degraded = st.level !== 'NORMAL';
      return {
        kind: 'APPEL_REEL', ok: checks.every((c) => c.ok), endpoint: `GET ${BITRIPAY_STATUS_PATH}`, httpStatus: 200, durationMs: Date.now() - started, checks,
        proves: 'Appel réel inoffensif (GET /status, état de fonctionnement) : prouve la joignabilité de l’API BitriPay et l’acceptation de la clé ; indique si la plateforme est en mode dégradé ou gardien. Ne prouve pas la réception des webhooks (à vérifier par un paiement de test).',
        detail: degraded ? `API BitriPay joignable mais en mode dégradé (${st.state ?? 'état inconnu'}) : paiements possiblement retardés.` : 'API BitriPay joignable, fonctionnement normal.',
      };
    } catch (e) {
      const status = e instanceof Error && 'providerStatus' in e ? (e as { providerStatus?: number }).providerStatus : undefined;
      return {
        kind: 'APPEL_REEL', ok: false, endpoint: `GET ${BITRIPAY_STATUS_PATH}`, ...(status !== undefined ? { httpStatus: status } : {}), durationMs: Date.now() - started, checks,
        proves: status === 401 || status === 403 ? 'Appel réel inoffensif en échec : clé refusée par BitriPay.' : 'Appel réel inoffensif en échec : l’API BitriPay n’a pas répondu correctement.',
        detail: e instanceof Error ? e.message : 'erreur',
      };
    }
  }

  async createIntent(req: IntentRequest): Promise<CreatedIntent> {
    const amountMinor = toSafeJsonInteger(toMinorUnits(req.amount, this.exponents));
    if (!this.http) {
      return { providerIntentId: `sbx_bitripay_${randomSecret(8)}`, checkoutUrl: null, qrPayload: null, sandbox: true };
    }
    const back = this.config.returnUrl;
    const withRef = (extra = '') => (back ? `${back}${back.includes('?') ? '&' : '?'}ref=${encodeURIComponent(req.paymentReference)}${extra}` : undefined);
    const expiresInMinutes = req.expiresAt ? Math.floor((Date.parse(req.expiresAt) - this.clockNow()) / 60_000) : undefined;
    const res = await this.http.request<Record<string, unknown>>('POST', '/payment_intents', {
      moneyMoving: true,
      // Idempotency-Key obligatoire (OpenAPI) : rejeu ⇒ même objet ; réutilisation avec un autre corps ⇒ 409 idempotency_key_reused.
      idempotencyKey: req.paymentReference,
      // Jamais d'application_fee_minor ni de splits : la recette publique est réglée intégralement au compte de la Ville ;
      // toute répartition se fait dans le grand livre de MOSOLO, par règle approuvée.
      body: {
        amount_minor: amountMinor,
        currency: req.amount.currency,
        // Rails de paiement (OpenAPI : rails[] ; anciennement « allowed_operators » sur la page publique) — identifiants à confirmer.
        rails: this.config.allowedOperators,
        capture_method: 'automatic',
        reference: req.paymentReference,
        description: `KINSHASA MOSOLO ${req.paymentReference}`,
        purpose_code: purposeCodeFor(req.revenueCategory),
        ...(expiresInMinutes !== undefined && expiresInMinutes > 0 ? { expires_in_minutes: expiresInMinutes } : {}),
        ...(req.channel === 'QR' ? { qr: true } : {}),
        metadata: { payment_reference: req.paymentReference, order_id: req.paymentOrderId, obligation_id: req.obligationId },
        // Retour navigateur vers la page MOSOLO « /paiement/retour » (commodité, jamais une preuve de paiement).
        ...(back ? { success_url: withRef(), cancel_url: withRef('&annule=1') } : {}),
        // Ancien paramétrage (avant l'OpenAPI) : champ supplémentaire si un autre nom a été configuré.
        ...(this.config.returnUrlField && back && !['success_url', 'cancel_url'].includes(this.config.returnUrlField) ? { [this.config.returnUrlField]: withRef() } : {}),
      },
    });
    const providerIntentId = pickString(res, 'id');
    if (!providerIntentId) throw new WebhookPayloadError('PROVIDER_RESPONSE_INVALID', 'Réponse BitriPay sans id.');
    return {
      providerIntentId,
      checkoutUrl: pickString(res, 'checkout_url') ?? null,
      qrPayload: pickString(res, 'qr_payload') ?? null,
      sandbox: this.sandbox,
    };
  }

  async cancelIntent(providerIntentId: string, idempotencyKey: string): Promise<void> {
    if (!this.http) return;
    await this.http.request('POST', `/payment_intents/${encodeURIComponent(providerIntentId)}/cancel`, { moneyMoving: true, idempotencyKey, body: {} });
  }

  verifyWebhook(headers: HeaderBag, rawBody: string, now: Date): VerifiedWebhook {
    const hmacHeader = headerValue(headers, BITRIPAY_SIGNATURE_HEADER);
    const edHeader = headerValue(headers, BITRIPAY_ED25519_HEADER);
    let hmacOk = false;
    let edOk = false;

    if (hmacHeader) {
      const parts = hmacHeader.split(',').map((p) => p.trim().split('=') as [string, string | undefined]);
      const t = parts.find(([k]) => k === 't')?.[1];
      const v1s = parts.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v!.toLowerCase());
      if (!t || !/^\d{1,12}$/.test(t) || v1s.length === 0) throw new WebhookVerificationError('INVALID_SIGNATURE', 'En-tête BitriPay-Signature mal formé.');
      const expected = hmacSha256Hex(this.config.webhookSecret, `${t}.${rawBody}`);
      if (!v1s.some((v) => safeEqualHex(expected, v))) throw new WebhookVerificationError('INVALID_SIGNATURE', 'Signature BitriPay (HMAC) invalide.');
      if (Math.abs(Math.floor(now.getTime() / 1000) - Number(t)) > this.tolerance) {
        throw new WebhookVerificationError('TIMESTAMP_OUT_OF_WINDOW', `Horodatage signé hors de la fenêtre de ±${this.tolerance} s.`);
      }
      hmacOk = true;
    } else if (this.config.hmacRequired) {
      throw new WebhookVerificationError('SIGNATURE_MISSING', 'En-tête BitriPay-Signature obligatoire.');
    }

    if (edHeader && this.edKey) {
      // OpenAPI 2026-09-01 : « BitriPay-Signature-Ed25519: keyId,t,sig » (clé de la plateforme publiée à GET /keys).
      // Forme lue : « keyId=…,t=…,sig=… » ou « <keyId>,<t>,<sig> » ; forme antérieure (signature base64 seule) tolérée.
      // Contenu signé : « <t>.<corps brut> » si t est fourni, sinon le corps brut [À CONFIRMER AVEC LE PRESTATAIRE].
      const parts = edHeader.split(',').map((x) => x.trim());
      const named = Object.fromEntries(parts.filter((x) => x.includes('=') && !/^[A-Za-z0-9+/]+={1,2}$/.test(x)).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
      let t: string | undefined; let sigB64: string;
      if (named.sig || named.v1) {
        t = named.t; sigB64 = named.sig ?? named.v1!;
      } else if (parts.length === 3) {
        t = parts[1]; sigB64 = parts[2]!;
      } else {
        sigB64 = edHeader.trim();
      }
      let sig: Buffer;
      try {
        sig = Buffer.from(sigB64, 'base64');
      } catch {
        sig = Buffer.alloc(0);
      }
      if (t !== undefined && (!/^\d{1,12}$/.test(t) || Math.abs(Math.floor(now.getTime() / 1000) - Number(t)) > this.tolerance)) {
        throw new WebhookVerificationError('TIMESTAMP_OUT_OF_WINDOW', `Horodatage Ed25519 hors de la fenêtre de ±${this.tolerance} s.`);
      }
      const candidates = t !== undefined ? [`${t}.${rawBody}`, rawBody] : [rawBody];
      if (sig.length !== 64 || !candidates.some((m) => edVerify(null, Buffer.from(m, 'utf8'), this.edKey!, sig))) {
        throw new WebhookVerificationError('INVALID_SIGNATURE', 'Signature BitriPay (Ed25519) invalide.');
      }
      edOk = true;
    } else if (this.config.ed25519Required) {
      throw new WebhookVerificationError('SIGNATURE_MISSING', 'En-tête BitriPay-Signature-Ed25519 obligatoire.');
    }
    if (!hmacOk && !edOk) throw new WebhookVerificationError('SIGNATURE_MISSING', 'Aucune signature BitriPay vérifiable.');

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WebhookPayloadError('INVALID_JSON', 'Corps JSON invalide.');
    }
    this.checkAccount(json);
    const checks: WebhookChecks = { signatureVerified: true, replayGuard: 'EVENT_ID', timestampInWindow: hmacOk ? true : 'NON_APPLICABLE' };
    return { events: [this.normalize(json, rawBody, now)], checks };
  }

  /** Chaque événement doit concerner le compte de la Ville, et lui seul. */
  private checkAccount(json: unknown): void {
    const account = pickString(json, 'account');
    const expected = this.config.connectedAccountId;
    if (expected && account !== expected) {
      throw new WebhookPayloadError('CONNECTED_ACCOUNT_MISMATCH', `Événement BitriPay pour le compte « ${account ?? 'absent'} » au lieu du compte de la Ville.`);
    }
    if (!expected && account) {
      throw new WebhookPayloadError('UNEXPECTED_CONNECTED_ACCOUNT', `Événement BitriPay d'un compte connecté (${account}) alors qu'aucun n'est configuré.`);
    }
  }

  private amountOf(obj: unknown, required: boolean) {
    const minor = parseMinorInput(pick(obj, 'amount_minor', 'amount_received', 'amount'));
    const currency = pickString(obj, 'currency')?.toUpperCase();
    if (minor === undefined || !currency) {
      if (required) throw new WebhookPayloadError('PROVIDER_AMOUNT_MISSING', 'Événement BitriPay sans montant entier ni devise.');
      return undefined;
    }
    try {
      return fromMinorUnits(minor, currency, this.exponents);
    } catch (e) {
      throw new WebhookPayloadError('PROVIDER_AMOUNT_INVALID', (e as Error).message);
    }
  }

  /** Parseur tolérant (forme « à la Stripe » supposée) [À VÉRIFIER sur l'OpenAPI BitriPay]. */
  private normalize(json: unknown, rawBody: string, now: Date): NormalizedProviderEvent {
    const eventType = pickString(json, 'type', 'event') ?? 'inconnu';
    const eventId = pickString(json, 'id', 'event_id') ?? `sha256:${sha256Hex(rawBody)}`;
    const obj = pick(json, 'data.object', 'data') ?? {};
    const providerIntentId = pickString(obj, 'payment_intent', 'id');
    const paymentReference = pickString(obj, 'metadata.payment_reference');
    const paymentOrderId = pickString(obj, 'metadata.order_id');
    const base = {
      eventId, eventType,
      ...(providerIntentId ? { providerIntentId } : {}),
      ...(paymentReference ? { paymentReference } : {}),
      ...(paymentOrderId ? { paymentOrderId } : {}),
    };
    const completedAt = pickTimestamp(obj, 'succeeded_at', 'completed_at', 'created') ?? pickTimestamp(json, 'created') ?? now.toISOString();
    switch (eventType) {
      case 'payment_intent.succeeded': {
        if (!providerIntentId) throw new WebhookPayloadError('PROVIDER_TXN_MISSING', 'Événement BitriPay sans identifiant d’intention.');
        const fee = parseMinorInput(pick(obj, 'application_fee_minor', 'application_fee_amount'));
        return {
          kind: 'PAYMENT', ...base, providerTxnId: providerIntentId, amount: this.amountOf(obj, true)!, status: 'SUCCESS', completedAt, confirmationMethod: 'BITRIPAY_RAIL',
          ...(fee !== undefined && fee !== 0n ? { applicationFeeMinor: fee.toString() } : {}),
        };
      }
      case 'payment_intent.canceled': {
        if (!providerIntentId) throw new WebhookPayloadError('PROVIDER_TXN_MISSING', 'Événement BitriPay sans identifiant d’intention.');
        const amount = this.amountOf(obj, false);
        return {
          kind: 'PAYMENT', ...base, providerTxnId: `${providerIntentId}:canceled`, ...(amount ? { amount } : {}),
          status: 'FAILED', completedAt, confirmationMethod: 'BITRIPAY_RAIL',
        };
      }
      // OpenAPI 2026-09-01 : échec, annulation (orthographe « cancelled ») et expiration ferment l'ordre.
      case 'payment_intent.failed':
      case 'payment_intent.cancelled':
      case 'payment_intent.expired': {
        if (!providerIntentId) throw new WebhookPayloadError('PROVIDER_TXN_MISSING', 'Événement BitriPay sans identifiant d’intention.');
        const amount = this.amountOf(obj, false);
        return {
          kind: 'PAYMENT', ...base, providerTxnId: `${providerIntentId}:${eventType.slice('payment_intent.'.length)}`, ...(amount ? { amount } : {}),
          status: 'FAILED', completedAt, confirmationMethod: 'BITRIPAY_RAIL',
        };
      }
      case 'payment_intent.disputed':
        // Contestation chez le prestataire : alerte au Trésor, aucune écriture automatique (une personne décide).
        return { kind: 'IGNORED', reason: 'LITIGE', ...base };
      case 'ping':
        return { kind: 'IGNORED', reason: 'PING', ...base };
      case 'payment_intent.payment_failed':
        // Tentative échouée : l'intention reste payable (nouvel essai du payeur) ⇒ journalisée, sans changement d'état.
        return { kind: 'IGNORED', reason: 'NON_TERMINAL_ATTEMPT_FAILURE', ...base };
      case 'payment_intent.ambiguous_hold': {
        const amount = this.amountOf(obj, false);
        return { kind: 'HOLD', reason: 'PROVIDER_AMBIGUOUS', ...base, ...(amount ? { amount } : {}) };
      }
      case 'payment_intent.settled': {
        const amount = this.amountOf(obj, false);
        const settlementId = pickString(obj, 'settlement_id', 'settlement.id');
        const settledAt = pickTimestamp(obj, 'settled_at');
        return { kind: 'SETTLEMENT', ...base, ...(amount ? { amount } : {}), ...(settlementId ? { settlementId } : {}), ...(settledAt ? { settledAt } : {}) };
      }
      default:
        return { kind: 'IGNORED', reason: (BITRIPAY_INFORMATIONAL_EVENTS as readonly string[]).includes(eventType) ? 'INFORMATIF' : 'UNKNOWN_TYPE', ...base };
    }
  }

  async requestVerificationEvidence(input: VerificationEvidenceInput): Promise<VerificationEvidenceResult> {
    if (!this.http) {
      return { sandbox: true, providerResult: { status: 'SANDBOX_NON_VERIFIE', note: 'Bac à sable local : aucun appel au prestataire.' } };
    }
    // Corps [À VÉRIFIER sur l'OpenAPI BitriPay] ; seule l'empreinte de la capture est transmise.
    const providerResult = await this.http.request('POST', '/verifications', {
      body: {
        payment_intent: input.providerIntentId,
        ...(input.smsCode ? { sms_code: input.smsCode } : {}),
        ...(input.screenshotSha256 ? { screenshot_sha256: input.screenshotSha256 } : {}),
      },
    });
    return { sandbox: this.sandbox, providerResult };
  }

  /**
   * GET /payment_resolution?reference=&amount_minor=&currency= (OpenAPI 2026-09-01 ; msisdn et window_hours facultatifs,
   * non envoyés) : CONFIRMED (écriture au grand livre du prestataire) / PENDING / AMBIGUOUS / NOT_FOUND. Portée requise
   * de la clé : verifications:write. `providerIntentId` n'est plus transmis (paramètre non documenté).
   */
  async resolvePayment(providerIntentId: string, paymentReference: string, amount?: MoneyJSON) {
    if (!this.http) {
      return { sandbox: true, providerResult: { status: 'SANDBOX_NON_VERIFIE', note: 'Bac à sable local : aucun appel au prestataire.' } };
    }
    const q = new URLSearchParams({ reference: paymentReference });
    if (amount) {
      q.set('amount_minor', String(toSafeJsonInteger(toMinorUnits(amount, this.exponents))));
      q.set('currency', amount.currency);
    }
    const providerResult = await this.http.request('GET', `/payment_resolution?${q.toString()}`);
    return { sandbox: this.sandbox, providerResult };
  }

  describe(): Record<string, unknown> {
    return {
      id: this.id, label: this.label, mode: this.mode, baseUrl: this.config.baseUrl, apiKey: maskSecret(this.config.apiKey),
      webhookSecret: maskSecret(this.config.webhookSecret), ed25519PublicKeyConfigured: !!this.edKey,
      hmacRequired: this.config.hmacRequired, ed25519Required: this.config.ed25519Required,
      settlementAccountAlias: this.settlementAccountAlias, exponents: this.exponents, allowedOperators: this.config.allowedOperators,
      connectedAccountId: this.config.connectedAccountId ?? null, applicationFee: 'INTERDIT',
      returnUrl: this.config.returnUrlField && this.config.returnUrl ? this.config.returnUrl : null, resolutionCheck: this.confirmsWithResolution,
      platformStatus: this.lastPlatformStatus, configurationIssue: this.configurationIssue(),
    };
  }
}
