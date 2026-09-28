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
  constructor(provider: string, detail: string, readonly providerStatus?: number) {
    super(502, 'PROVIDER_UNAVAILABLE', `Prestataire ${provider} indisponible ou en erreur : ${detail}`, {
      provider, ...(providerStatus !== undefined ? { providerStatus } : {}),
    });
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
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(private readonly opts: ProviderHttpClientOptions) {
    // Conversion justifiée : le `fetch` global (undici) a une signature plus large que FetchLike, sous-ensemble utilisé ici.
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? defaultSleep;
    this.circuit = { ...DEFAULT_CIRCUIT, ...(opts.circuit ?? {}) };
    this.now = opts.now ?? Date.now;
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
      if (e instanceof ProviderHttpError && (status === undefined || status >= 500 || status === 408 || status === 429)) this.recordFailure();
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
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.sleep(200 * 2 ** (attempt - 2));
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
      try {
        const res = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal });
        status = res.status;
        text = await res.text();
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
      lastError = new ProviderHttpError(this.opts.provider, `HTTP ${status}`, status);
      // 4xx (hors 408/429) : erreur définitive, aucune nouvelle tentative.
      if (status < 500 && status !== 408 && status !== 429) throw lastError;
    }
    throw lastError;
  }
}
