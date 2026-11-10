/**
 * Client HTTP sortant des connecteurs : `fetch` injectable (tests : jamais de réseau réel), délai maximal,
 * nouvelles tentatives UNIQUEMENT sur appels idempotents (GET, ou POST porteur d'une Idempotency-Key si le
 * prestataire la garantit), en-tête Idempotency-Key sur tout POST qui engage de l'argent, journalisation
 * masquée (la clé secrète n'apparaît jamais : ni dans les journaux, ni dans les erreurs).
 */
import { ApiError } from '../../../core/errors.js';
import { maskSecret } from './types.js';

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  /** En-têtes de réponse (lecture de `Retry-After` sur HTTP 429 / 503). Facultatif : simulateurs minimaux. */
  headers?: { get(name: string): string | null };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface HttpLogEntry {
  provider: string;
  method: string;
  path: string;
  attempt: number;
  status?: number;
  error?: string;
  durationMs: number;
  /** Toujours masquée. */
  authorization: string;
  idempotencyKey?: string;
}

export type HttpLogger = (entry: HttpLogEntry) => void;

export interface ProviderHttpClientOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** Le prestataire garantit-il l'idempotence d'un POST rejoué avec la même Idempotency-Key ? */
  idempotentPostsWithKey?: boolean;
  logger?: HttpLogger;
  sleep?: (ms: number) => Promise<void>;
  /** En-têtes ajoutés à chaque requête (ex. `BitriPay-Account` : compte connecté pour lequel la clé agit). */
  extraHeaders?: Record<string, string>;
  /** Disjoncteur (valeurs PAR DÉFAUT — À CONFIRMER PAR LE MAÎTRE D'OUVRAGE avec l'exploitant). */
  circuit?: Partial<CircuitOptions>;
  /** Horloge du disjoncteur (tests) ; défaut : Date.now. */
  now?: () => number;
  /** Attente maximale sur Retry-After (défaut : DEFAULT_MAX_RETRY_AFTER_WAIT_MS, à confirmer). */
  maxRetryAfterWaitMs?: number;
}

/**
 * Disjoncteur des appels sortants : après `failureThreshold` appels consécutifs en échec (réseau, délai, 5xx, 408,
 * 429), le prestataire est déclaré indisponible pendant `cooldownMs` : aucun appel n'est tenté et l'utilisateur reçoit
 * immédiatement un 503 clair. À l'échéance, un appel d'essai est admis (semi-ouvert) : succès ⇒ fermé ; échec ⇒ rouvert.
 */
export interface CircuitOptions {
  failureThreshold: number;
  cooldownMs: number;
}

/** Valeurs PAR DÉFAUT — À CONFIRMER PAR LE MAÎTRE D'OUVRAGE (et avec les niveaux de service des prestataires). */
export const DEFAULT_CIRCUIT: CircuitOptions = { failureThreshold: 5, cooldownMs: 30_000 };
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RETRIES = 2;
/**
 * Attente maximale acceptée sur un `Retry-After` (HTTP 429, limitation de débit KODA) avant une nouvelle tentative :
 * au-delà, l'appel échoue aussitôt et le délai est renvoyé à l'appelant (503 + Retry-After).
 * Valeur PAR DÉFAUT — À CONFIRMER PAR LE MAÎTRE D'OUVRAGE.
 */
export const DEFAULT_MAX_RETRY_AFTER_WAIT_MS = 5_000;

/**
 * Codes d'erreur BitriPay (OpenAPI 2026-09-01, `{error:{code, bp, message, details}}`) qui signalent une indisponibilité
 * du prestataire (gardien, mode dégradé, rail indisponible, limitation de débit) : comptés par le disjoncteur et
 * renvoyés au client en 503 (+ Retry-After). Les autres 4xx restent des erreurs définitives.
 */
export const PROVIDER_UNAVAILABLE_CODES = new Set(['guardian_halt', 'degraded_mode', 'connector_unavailable', 'rail_unavailable', 'rate_limited']);
/** Codes de configuration (clé sans la portée requise…) : affichés dans l'état de raccordement. */
export const PROVIDER_CONFIG_CODES = new Set(['scope_denied', 'invalid_api_key', 'api_key_revoked']);

/** Lecture d'un en-tête Retry-After : secondes entières ou date HTTP ; `undefined` si absent ou illisible. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d{1,6}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

export type CircuitStateName = 'FERME' | 'OUVERT' | 'SEMI_OUVERT';

export interface CircuitSnapshot {
  state: CircuitStateName;
  consecutiveFailures: number;
  failureThreshold: number;
  cooldownMs: number;
  openedAt: string | null;
  reopensAt: string | null;
  timeoutMs: number;
  maxRetries: number;
}

export class ProviderHttpError extends ApiError {
  /**
   * @param providerErrorCode code d'erreur MÉTIER renvoyé par le prestataire (ex. KODA `code_already_used`), jamais le corps.
   * @param retryAfterSeconds délai demandé par le prestataire (HTTP 429 `Retry-After`) : 503 PROVIDER_RATE_LIMITED.
   */
  constructor(provider: string, detail: string, readonly providerStatus?: number, readonly providerErrorCode?: string, readonly retryAfterSeconds?: number, readonly providerBp?: string) {
    const rateLimited = providerStatus === 429 || providerErrorCode === 'rate_limited';
    const unavailable = !!providerErrorCode && PROVIDER_UNAVAILABLE_CODES.has(providerErrorCode);
    super(
      rateLimited || unavailable ? 503 : 502,
      rateLimited ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
      rateLimited
        ? `Prestataire ${provider} : limite de débit atteinte — réessayez${retryAfterSeconds !== undefined ? ` dans ${retryAfterSeconds} s` : ' plus tard'}.`
        : unavailable
          ? `Prestataire ${provider} momentanément indisponible (${providerErrorCode}${providerBp ? `, ${providerBp}` : ''}) : aucun paiement ne peut lui être transmis ; réessayez plus tard ou choisissez un autre canal.`
          : `Prestataire ${provider} indisponible ou en erreur : ${detail}`,
      {
        provider, ...(providerStatus !== undefined ? { providerStatus } : {}), ...(providerErrorCode ? { providerErrorCode } : {}), ...(providerBp ? { providerBp } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds: Math.max(1, retryAfterSeconds) } : unavailable ? { retryAfterSeconds: 60 } : {}),
      },
    );
  }
}

/** Code « bp » BitriPay (ex. BP-3006) d'une réponse d'erreur — jamais le corps entier. */
function bpCodeOf(text: string): string | undefined {
  try {
    const e = (JSON.parse(text) as { error?: { bp?: unknown } }).error;
    const bp = e && typeof e === 'object' ? e.bp : undefined;
    return typeof bp === 'string' && /^BP-\d{4}$/.test(bp) ? bp : undefined;
  } catch {
    return undefined;
  }
}

/** Code d'erreur métier d'une réponse de prestataire (`error.code`, `code`, `error` texte) — jamais le corps entier. */
function errorCodeOf(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error;
    const code = (e && typeof e === 'object' ? (e as Record<string, unknown>).code : undefined) ?? j.code ?? (typeof e === 'string' ? e : undefined);
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Disjoncteur ouvert : le prestataire est déclaré indisponible, aucun appel n'est tenté (503 + Retry-After). */
export class ProviderCircuitOpenError extends ApiError {
  constructor(provider: string, retryAfterSeconds: number) {
    super(503, 'PROVIDER_CIRCUIT_OPEN',
      `Le prestataire ${provider} est momentanément indisponible (plusieurs échecs consécutifs) : aucun paiement ne peut lui être transmis. Réessayez dans ${retryAfterSeconds} s ou choisissez un autre canal.`,
      { provider, retryAfterSeconds });
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ProviderHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly circuit: CircuitOptions;
  private readonly now: () => number;
  private readonly maxRetryAfterWaitMs: number;
  private consecutiveFailures = 0;
  /** Dernière erreur de CONFIGURATION renvoyée par le prestataire (ex. scope_denied) : affichée, jamais la clé. */
  lastConfigurationError: { at: string; method: string; path: string; code: string; bp: string | null } | null = null;
  private openedAt: number | null = null;

  constructor(private readonly opts: ProviderHttpClientOptions) {
    // Conversion justifiée : le `fetch` global (undici) a une signature plus large que FetchLike, sous-ensemble utilisé ici.
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? defaultSleep;
    this.circuit = { ...DEFAULT_CIRCUIT, ...(opts.circuit ?? {}) };
    this.now = opts.now ?? Date.now;
    this.maxRetryAfterWaitMs = opts.maxRetryAfterWaitMs ?? DEFAULT_MAX_RETRY_AFTER_WAIT_MS;
  }

  /** État du disjoncteur (vue de raccordement ; aucune donnée secrète). */
  circuitSnapshot(): CircuitSnapshot {
    const now = this.now();
    const reopens = this.openedAt !== null ? this.openedAt + this.circuit.cooldownMs : null;
    const state: CircuitStateName = this.openedAt === null ? 'FERME' : reopens !== null && now >= reopens ? 'SEMI_OUVERT' : 'OUVERT';
    return {
      state, consecutiveFailures: this.consecutiveFailures, failureThreshold: this.circuit.failureThreshold, cooldownMs: this.circuit.cooldownMs,
      openedAt: this.openedAt !== null ? new Date(this.openedAt).toISOString() : null, reopensAt: reopens !== null ? new Date(reopens).toISOString() : null,
      timeoutMs: this.timeoutMs, maxRetries: this.maxRetries,
    };
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    // Semi-ouvert (appel d'essai en échec) ou seuil atteint : (ré)ouverture.
    if (this.openedAt !== null || this.consecutiveFailures >= this.circuit.failureThreshold) this.openedAt = this.now();
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotencyKey?: string; moneyMoving?: boolean } = {},
  ): Promise<T> {
    if (this.openedAt !== null) {
      const remaining = this.openedAt + this.circuit.cooldownMs - this.now();
      if (remaining > 0) throw new ProviderCircuitOpenError(this.opts.provider, Math.ceil(remaining / 1000));
    }
    try {
      const res = await this.send<T>(method, path, options);
      this.recordSuccess();
      return res;
    } catch (e) {
      // Seules les pannes (réseau, délai, 5xx, 408, 429) comptent ; une erreur 4xx définitive ne déclare pas la panne.
      const status = e instanceof ProviderHttpError ? e.providerStatus : undefined;
      const unavailable = e instanceof ProviderHttpError && !!e.providerErrorCode && PROVIDER_UNAVAILABLE_CODES.has(e.providerErrorCode);
      if (e instanceof ProviderHttpError && e.providerErrorCode && PROVIDER_CONFIG_CODES.has(e.providerErrorCode)) {
        this.lastConfigurationError = { at: new Date(this.now()).toISOString(), method, path: path.split('?')[0]!, code: e.providerErrorCode, bp: e.providerBp ?? null };
      }
      if (e instanceof ProviderHttpError && (status === undefined || status >= 500 || status === 408 || status === 429 || unavailable)) this.recordFailure();
      else if (e instanceof ProviderHttpError) this.recordSuccess();
      throw e;
    }
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotencyKey?: string; moneyMoving?: boolean },
  ): Promise<T> {
    if (method === 'POST' && options.moneyMoving && !options.idempotencyKey) {
      // Garde-fou : un POST qui engage de l'argent sans clé d'idempotence est un défaut de programmation.
      throw new Error(`POST ${path} sans Idempotency-Key`);
    }
    const retryable = method === 'GET' || (options.idempotencyKey !== undefined && this.opts.idempotentPostsWithKey === true);
    const attempts = retryable ? this.maxRetries + 1 : 1;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      accept: 'application/json',
      'user-agent': 'kinshasa-mosolo/1.0',
      ...(this.opts.extraHeaders ?? {}),
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const url = this.opts.baseUrl.replace(/\/+$/, '') + path;

    let lastError = new ProviderHttpError(this.opts.provider, 'échec');
    let retryAfterMs: number | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Nouvelle tentative : délai demandé par le prestataire (Retry-After) s'il y en a un, sinon recul exponentiel.
      if (attempt > 1) await this.sleep(retryAfterMs ?? 200 * 2 ** (attempt - 2));
      retryAfterMs = undefined;
      const started = Date.now();
      const log = (extra: Partial<HttpLogEntry>) =>
        this.opts.logger?.({
          provider: this.opts.provider, method, path, attempt, durationMs: Date.now() - started,
          authorization: `Bearer ${maskSecret(this.opts.apiKey)}`,
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          ...extra,
        });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let status: number;
      let text: string;
      let retryAfterHeader: string | null;
      try {
        const res = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal });
        status = res.status;
        text = await res.text();
        retryAfterHeader = res.headers?.get('retry-after') ?? null;
      } catch {
        const reason = controller.signal.aborted ? `délai de ${this.timeoutMs} ms dépassé` : 'erreur réseau';
        log({ error: reason });
        lastError = new ProviderHttpError(this.opts.provider, reason);
        continue;
      } finally {
        clearTimeout(timer);
      }
      log({ status });
      if (status >= 200 && status < 300) {
        try {
          return (text ? JSON.parse(text) : {}) as T;
        } catch {
          throw new ProviderHttpError(this.opts.provider, 'réponse JSON illisible', status);
        }
      }
      const retryAfter = status === 429 || status === 503 ? parseRetryAfter(retryAfterHeader, this.now()) : undefined;
      const errCode = errorCodeOf(text);
      lastError = new ProviderHttpError(this.opts.provider, `HTTP ${status}`, status, errCode, retryAfter, bpCodeOf(text));
      // 4xx (hors 408/429) : erreur définitive, aucune nouvelle tentative (indisponibilité signalée par code : pas de rejeu non plus).
      if (status < 500 && status !== 408 && status !== 429) throw lastError;
      if (retryAfter !== undefined) {
        // Limitation de débit : on respecte le délai demandé ; trop long ⇒ échec immédiat, délai transmis à l'appelant.
        if (retryAfter * 1000 > this.maxRetryAfterWaitMs) throw lastError;
        retryAfterMs = retryAfter * 1000;
      }
    }
    throw lastError;
  }
}
