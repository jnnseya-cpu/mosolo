/**
 * Contrat commun des connecteurs de prestataires de paiement (BitriPay, KODA…).
 * Un connecteur ne fait que : créer / annuler une intention chez le prestataire, et vérifier + normaliser
 * ses webhooks signés. Il ne décide RIEN : la confirmation (montant, référence, doublon, écritures,
 * quittance provisoire) est faite par `PaymentService.confirmFromProvider`, commune à tous les canaux.
 */
import type { MoneyJSON } from '@mosolo/shared';
import type { ExponentTable } from './minor-units.js';

export { fromMinorUnits, toMinorUnits, toSafeJsonInteger, parseMinorInput, type ExponentTable } from './minor-units.js';

export const CONNECTOR_IDS = ['bitripay', 'koda'] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

/** Mode d'exécution : SANDBOX_LOCAL = aucune clé, aucun appel réseau ; TEST / LIVE selon le préfixe de la clé. */
export type ConnectorMode = 'SANDBOX_LOCAL' | 'TEST' | 'LIVE';

/** Méthode de confirmation portée par l'ordre et la quittance (traçabilité de la preuve). */
export type ConfirmationMethod = 'HMAC_CALLBACK' | 'KODA_OPERATOR_LEDGER' | 'BITRIPAY_RAIL';

export interface IntentRequest {
  paymentOrderId: string;
  paymentReference: string;
  obligationId: string;
  amount: MoneyJSON;
  channel: string;
  /** Échéance de la référence MOSOLO (BitriPay : expires_in_minutes en découle). */
  expiresAt?: string;
  /** Catégorie de recette de l'obligation (BitriPay : purpose_code TAX / GOVERNMENT_FEE en découle, à confirmer). */
  revenueCategory?: string;
}

export interface CreatedIntent {
  providerIntentId: string;
  checkoutUrl: string | null;
  qrPayload: string | null;
  /** Vrai hors production réelle (bac à sable local ou clé de test du prestataire). */
  sandbox: boolean;
}

/** Contrôles anti-rejeu effectués par le connecteur, reportés dans la preuve interne de la quittance. */
export interface WebhookChecks {
  signatureVerified: true;
  /** Unicité : nonce (rappel générique) ou identifiant d'événement (webhooks prestataires). */
  replayGuard: 'NONCE' | 'EVENT_ID';
  /** true si un horodatage SIGNÉ a été vérifié (±5 min) ; NON_APPLICABLE si le prestataire n'en signe pas. */
  timestampInWindow: true | 'NON_APPLICABLE';
}

interface EventBase {
  /** Identifiant d'événement du prestataire (ou empreinte du corps brut à défaut) : clé d'unicité anti-rejeu. */
  eventId: string;
  eventType: string;
  providerIntentId?: string;
  paymentReference?: string;
  /** Identifiant d'ordre MOSOLO éventuellement renvoyé dans les métadonnées. */
  paymentOrderId?: string;
}

export interface PaymentEvent extends EventBase {
  kind: 'PAYMENT';
  providerTxnId: string;
  /** Absent seulement pour un échec sans montant (l'ordre fournit alors le montant). */
  amount?: MoneyJSON;
  status: 'SUCCESS' | 'FAILED';
  completedAt: string;
  confirmationMethod: ConfirmationMethod;
  providerReceiptId?: string;
  late?: boolean;
  /** Frais d'application prélevés sur l'intention (unités mineures) : interdit sur une recette publique ⇒ alerte. */
  applicationFeeMinor?: string;
}

export interface SettlementEvent extends EventBase {
  kind: 'SETTLEMENT';
  amount?: MoneyJSON;
  settlementId?: string;
  settledAt?: string;
}

export interface IgnoredEvent extends EventBase {
  kind: 'IGNORED';
  /**
   * UNKNOWN_TYPE : type non traité ; NON_TERMINAL_ATTEMPT_FAILURE : tentative échouée, l'intention reste payable ;
   * INFORMATIF : étape intermédiaire documentée (created, processing…), sans effet ; PING : essai du prestataire (200) ;
   * LITIGE : paiement contesté chez le prestataire (alerte au Trésor, aucune écriture automatique).
   */
  reason: 'UNKNOWN_TYPE' | 'NON_TERMINAL_ATTEMPT_FAILURE' | 'INFORMATIF' | 'PING' | 'LITIGE';
}

/**
 * Mise en attente par le prestataire (résultat opérateur inconnu, ex. BitriPay `payment_intent.ambiguous_hold`) :
 * AUCUN changement d'état, AUCUNE quittance ; exception de rapprochement jusqu'à résolution.
 */
export interface HoldEvent extends EventBase {
  kind: 'HOLD';
  reason: 'PROVIDER_AMBIGUOUS';
  amount?: MoneyJSON;
}

export type NormalizedProviderEvent = PaymentEvent | SettlementEvent | HoldEvent | IgnoredEvent;

/** « Ce paiement a-t-il eu lieu ? » selon le prestataire : PIÈCE DE DOSSIER, sans effet juridique ni financier. */
export interface ProviderResolution {
  sandbox: boolean;
  providerResult: unknown;
}

export interface VerifiedWebhook {
  events: NormalizedProviderEvent[];
  checks: WebhookChecks;
}

/** Preuve visuelle soumise à un agent (jamais par le contribuable pour obtenir une quittance). */
export interface VerificationEvidenceInput {
  providerIntentId: string;
  paymentReference: string;
  smsCode?: string;
  screenshotSha256?: string;
}

export interface VerificationEvidenceResult {
  providerResult: unknown;
  sandbox: boolean;
}

export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * État d'une intention lu chez le prestataire par une interrogation SERVEUR À SERVEUR (BitriPay
 * GET /payment_intents/{id}, KODA GET /intents/{id}) : exigé avant toute quittance (Cahier § 19.2-19.3).
 */
export interface ProviderIntentStatus {
  providerIntentId: string;
  /** SUCCEEDED : payé ; FAILED : échec terminal / annulé ; PENDING : en cours ; UNKNOWN : statut non reconnu. */
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
  /** Libellé brut renvoyé par le prestataire (ex. `succeeded`, `verified`). */
  rawStatus: string | null;
  amount?: MoneyJSON;
}

/** Résultat de « Tester la connexion » : appel réel inoffensif, ou validation à blanc (aucun appel). */
export interface ConnectionTestResult {
  kind: 'APPEL_REEL' | 'VALIDATION_A_BLANC';
  ok: boolean;
  /** Point d'appel utilisé (méthode et chemin) ; absent pour une validation à blanc. */
  endpoint?: string;
  httpStatus?: number;
  durationMs?: number;
  /** Ce que l'essai prouve, et ce qu'il ne prouve pas (explicite pour l'exploitant). */
  proves: string;
  detail: string;
  checks: { label: string; ok: boolean; detail?: string }[];
}

export interface PaymentConnector {
  readonly id: ConnectorId;
  readonly label: string;
  readonly mode: ConnectorMode;
  /** Alias du compte public de règlement, résolu dans le coffre (contrôlé au démarrage). */
  readonly settlementAccountAlias: string;
  readonly exponents: ExponentTable;
  createIntent(req: IntentRequest): Promise<CreatedIntent>;
  cancelIntent(providerIntentId: string, idempotencyKey: string): Promise<void>;
  /** Vérifie la signature (temps constant) puis normalise. Lève WebhookVerificationError / WebhookPayloadError. */
  verifyWebhook(headers: HeaderBag, rawBody: string, now: Date): VerifiedWebhook;
  /** Relais vers l'API de vérification capture/SMS du prestataire : PIÈCE DE DOSSIER uniquement. */
  requestVerificationEvidence(input: VerificationEvidenceInput): Promise<VerificationEvidenceResult>;
  /** Interrogation « ce paiement a-t-il eu lieu ? » (si le prestataire la propose) : pièce de dossier uniquement. */
  resolvePayment?(providerIntentId: string, paymentReference: string, amount?: MoneyJSON): Promise<ProviderResolution>;
  /** Interrogation serveur à serveur de l'état d'une intention (absente en bac à sable local). */
  fetchIntentStatus?(providerIntentId: string): Promise<ProviderIntentStatus>;
  /**
   * Vrai si le prestataire offre une interrogation « ce paiement a-t-il eu lieu ? » utilisée comme confirmation serveur à
   * serveur SUPPLÉMENTAIRE avant quittance (BitriPay GET /payment_resolution, 29/09/2026).
   */
  readonly confirmsWithResolution?: boolean;
  /** « Tester la connexion » : point d'appel inoffensif documenté, sinon validation de configuration à blanc. */
  testConnection?(): Promise<ConnectionTestResult>;
  /** Schéma de signature attendu des webhooks (texte affichable). */
  readonly signatureScheme?: string;
  /** Opérateurs proposés au payeur. */
  readonly operators?: readonly string[];
  /** Configuration affichable (clés masquées). */
  describe(): Record<string, unknown>;
}

/** Lecture tolérante d'un statut d'intention (listes de libellés documentées + hypothèses, À CONFIRMER). */
export function classifyIntentStatus(raw: string | undefined, succeeded: readonly string[], failed: readonly string[], pending: readonly string[]): ProviderIntentStatus['status'] {
  if (!raw) return 'UNKNOWN';
  const v = raw.toLowerCase();
  if (succeeded.includes(v)) return 'SUCCEEDED';
  if (failed.includes(v)) return 'FAILED';
  if (pending.includes(v)) return 'PENDING';
  return 'UNKNOWN';
}

/** Signature absente / invalide / horodatage hors fenêtre → 401 + alerte de sécurité. */
export class WebhookVerificationError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
    this.name = 'WebhookVerificationError';
  }
}

/** Corps signé mais inexploitable (devise inconnue, montant illisible…) → 422 + alerte. */
export class WebhookPayloadError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
    this.name = 'WebhookPayloadError';
  }
}

/** Configuration invalide : empêche le démarrage. */
export class ConnectorConfigError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ConnectorConfigError';
  }
}

export function headerValue(headers: HeaderBag, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Masque une clé secrète : `sk_live_…a1b2` (jamais plus de 4 caractères finaux). */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '(absente)';
  const prefix = /^(sk|pk|whsec|rk)_(test_|live_)?/.exec(secret)?.[0] ?? '';
  return `${prefix}…${secret.length > prefix.length + 8 ? secret.slice(-4) : ''}`;
}

/**
 * Mode déduit de la clé ; refuse toute clé publiable. `allowRestricted` : clé restreinte rk_live_ / rk_test_ admise
 * (BitriPay, OpenAPI 2026-09-01 : clés restreintes à portées — payment_intents:write/read, verifications:write…).
 */
export function modeFromKey(provider: string, apiKey: string | undefined, opts: { allowRestricted?: boolean } = {}): ConnectorMode {
  if (!apiKey) return 'SANDBOX_LOCAL';
  if (/^pk_/.test(apiKey)) throw new ConnectorConfigError(`${provider} : clé publiable refusée — seule une clé secrète sk_… côté serveur est admise.`);
  if (opts.allowRestricted && /^rk_(live|test)_/.test(apiKey)) return /^rk_live_/.test(apiKey) ? 'LIVE' : 'TEST';
  if (!/^sk_/.test(apiKey)) throw new ConnectorConfigError(`${provider} : clé secrète attendue au format sk_…${opts.allowRestricted ? ' ou rk_…' : ''} (reçu ${maskSecret(apiKey)}).`);
  return /^sk_live_/.test(apiKey) ? 'LIVE' : 'TEST';
}

/** Accès tolérant à un chemin pointé (`data.intent_id`). */
export function pick(obj: unknown, ...paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = obj;
    for (const seg of p.split('.')) {
      if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[seg];
      else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

export function pickString(obj: unknown, ...paths: string[]): string | undefined {
  const v = pick(obj, ...paths);
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

/** Horodatage tolérant : ISO 8601 ou secondes Unix. */
export function pickTimestamp(obj: unknown, ...paths: string[]): string | undefined {
  const v = pick(obj, ...paths);
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === 'string') {
    if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000).toISOString();
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return undefined;
}
