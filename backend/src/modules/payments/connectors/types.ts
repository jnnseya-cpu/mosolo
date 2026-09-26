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
}

export interface SettlementEvent extends EventBase {
  kind: 'SETTLEMENT';
  amount?: MoneyJSON;
  settlementId?: string;
  settledAt?: string;
}

export interface IgnoredEvent extends EventBase {
  kind: 'IGNORED';
  /** UNKNOWN_TYPE : type non traité ; NON_TERMINAL_ATTEMPT_FAILURE : tentative échouée, l'intention reste payable. */
  reason: 'UNKNOWN_TYPE' | 'NON_TERMINAL_ATTEMPT_FAILURE';
}

export type NormalizedProviderEvent = PaymentEvent | SettlementEvent | IgnoredEvent;

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
  /** Configuration affichable (clés masquées). */
  describe(): Record<string, unknown>;
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

/** Mode déduit de la clé ; refuse toute clé publiable. */
export function modeFromKey(provider: string, apiKey: string | undefined): ConnectorMode {
  if (!apiKey) return 'SANDBOX_LOCAL';
  if (/^pk_/.test(apiKey)) throw new ConnectorConfigError(`${provider} : clé publiable refusée — seule une clé secrète sk_… côté serveur est admise.`);
  if (!/^sk_/.test(apiKey)) throw new ConnectorConfigError(`${provider} : clé secrète attendue au format sk_… (reçu ${maskSecret(apiKey)}).`);
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
