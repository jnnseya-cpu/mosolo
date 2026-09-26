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
}

export class ProviderHttpError extends ApiError {
  constructor(provider: string, detail: string, readonly providerStatus?: number) {
    super(502, 'PROVIDER_UNAVAILABLE', `Prestataire ${provider} indisponible ou en erreur : ${detail}`, {
      provider, ...(providerStatus !== undefined ? { providerStatus } : {}),
    });
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ProviderHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ProviderHttpClientOptions) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotencyKey?: string; moneyMoving?: boolean } = {},
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
