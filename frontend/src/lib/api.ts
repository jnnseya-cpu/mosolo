/**
 * Client HTTP du contrat d'API v1 (specs/contrat-api.md).
 * Aucun code backend n'est importé : seules les routes du contrat sont appelées.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');

const USER_KEY = 'mosolo.demoUser';
const LANG_KEY = 'mosolo.lang';

export function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function safeSet(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* stockage indisponible */ }
}

export function getDemoUser(): string | null { return safeGet(USER_KEY); }
export function setDemoUser(id: string | null): void { safeSet(USER_KEY, id); }
export function getApiLang(): string { return safeGet(LANG_KEY) ?? 'fr'; }
export function setApiLang(lang: string): void { safeSet(LANG_KEY, lang); }

/** Erreur au format RFC 9457 ({ type, title, status, detail, code }). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly code?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}
/** Le backend est injoignable (réseau coupé, serveur arrêté). */
export class NetworkError extends Error {
  constructor(message = 'Serveur injoignable') { super(message); this.name = 'NetworkError'; }
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  raw?: boolean;
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Accept-Language': getApiLang(), ...opts.headers };
  const user = getDemoUser();
  if (user) headers['x-demo-user'] = user;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new NetworkError();
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let title = res.statusText || `HTTP ${res.status}`; let detail: string | undefined; let code: string | undefined;
    let body: Record<string, unknown> | undefined;
    if (ct.includes('json')) {
      try {
        const p = (await res.json()) as { title?: string; detail?: string; code?: string; message?: string } & Record<string, unknown>;
        title = p.title ?? title; detail = p.detail ?? p.message; code = p.code; body = p;
      } catch { /* corps illisible */ }
    }
    throw new ApiError(res.status, title, detail, code, body);
  }
  if (opts.raw) return (await res.text()) as unknown as T;
  if (res.status === 204) return undefined as T;
  if (ct.includes('json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

/** Normalise une liste renvoyée soit comme tableau, soit comme `{ items | data | <clé> }`. */
export function asList<T>(v: unknown, ...keys: string[]): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of [...keys, 'items', 'data', 'results']) if (Array.isArray(o[k])) return o[k] as T[];
  }
  return [];
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function describeError(e: unknown): { network: boolean; message: string; code?: string } {
  if (e instanceof NetworkError) return { network: true, message: e.message };
  if (e instanceof ApiError) return { network: false, message: e.detail ? `${e.title} — ${e.detail}` : e.title, code: e.code };
  return { network: false, message: e instanceof Error ? e.message : String(e) };
}
