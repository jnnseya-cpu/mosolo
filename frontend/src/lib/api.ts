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

/**
 * Écart entre l'horloge du serveur et celle de l'appareil (§ H.11.6 : l'heure du téléphone n'est jamais prise en compte
 * pour la validité). Mis à jour à chaque réponse ; les comptes à rebours utilisent `serverNow()`.
 */
let serverOffsetMs = 0;
export function noteServerTime(iso: string | null | undefined): void {
  if (!iso) return;
  const t = Date.parse(iso);
  if (!Number.isNaN(t)) serverOffsetMs = t - Date.now();
}
export function serverNow(): number { return Date.now() + serverOffsetMs; }

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

/**
 * Session réelle (écran Connexion). Sur un appareil partagé, le jeton reste dans le stockage de l'onglet
 * (sessionStorage, effacé à la fermeture) et n'est jamais écrit dans le stockage durable (localStorage).
 */
const SESSION_KEY = 'mosolo.session';
function sessionStore(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}
export function readStoredSession(): string | null {
  try { const v = sessionStore()?.getItem(SESSION_KEY); if (v) return v; } catch { /* stockage indisponible */ }
  return safeGet(SESSION_KEY);
}
export function writeStoredSession(value: string | null, sharedDevice = false): void {
  const tab = sessionStore();
  try {
    if (value === null || !sharedDevice) tab?.removeItem(SESSION_KEY);
    else tab?.setItem(SESSION_KEY, value);
  } catch { /* stockage indisponible */ }
  safeSet(SESSION_KEY, value !== null && !sharedDevice ? value : null);
}

/** En-têtes d'authentification communs (langue, utilisateur de démonstration, jeton porteur de la session). */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Accept-Language': getApiLang() };
  const user = getDemoUser();
  if (user) headers['x-demo-user'] = user;
  // Session réelle (écran Connexion) : le jeton porteur prévaut côté serveur sur le sélecteur de démonstration.
  const sess = readStoredSession();
  if (sess) {
    try {
      const s = JSON.parse(sess) as { accessToken?: string; session?: { expiresAt?: string } };
      if (s.accessToken && s.session?.expiresAt && new Date(s.session.expiresAt) > new Date()) headers.Authorization = `Bearer ${s.accessToken}`;
    } catch { /* session illisible : ignorée */ }
  }
  return headers;
}

/** Ressource binaire authentifiée (photo de preuve…) : mêmes en-têtes que `api`, rendue en Blob. */
export async function apiBlob(path: string): Promise<Blob> {
  const headers = authHeaders();
  let res: Response;
  try { res = await fetch(API_URL + path, { headers }); } catch { throw new NetworkError(); }
  if (!res.ok) throw new ApiError(res.status, res.statusText || `HTTP ${res.status}`);
  return res.blob();
}

/** Identifiant de corrélation d'une requête (§ 30.1 X-Request-Id), repris dans chaque enregistrement d'audit du serveur. */
export function newRequestId(): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `web-${r}`;
}

/**
 * Empreinte d'installation de l'application (§ 25.1 « empreinte d'appareil ») : identifiant aléatoire propre à ce
 * navigateur, sans aucune donnée personnelle ; permet au serveur de repérer un appareil servant plusieurs comptes.
 */
const DEVICE_KEY = 'mosolo.appareil';
export function deviceFingerprint(): string | null {
  let v = safeGet(DEVICE_KEY);
  if (!v) {
    v = newRequestId().replace(/^web-/, 'nav-');
    safeSet(DEVICE_KEY, v);
  }
  return safeGet(DEVICE_KEY) ? v : null;
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(), ...opts.headers };
  headers['X-Request-Id'] ??= newRequestId();
  // Sessions réelles seulement : le sélecteur d'utilisateurs de démonstration change de compte sur le même navigateur.
  const fp = headers.Authorization ? deviceFingerprint() : null;
  if (fp) headers['x-mosolo-device-fingerprint'] = fp;
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
  noteServerTime(res.headers.get('x-mosolo-server-time'));
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

/**
 * Refus définitif du serveur (4xx hors 408/429) : la requête ne passera pas telle quelle, une nouvelle clé
 * d'idempotence peut être tirée. Réseau coupé, délai ou 5xx : on garde la même clé pour que la relance soit
 * reconnue comme la même opération (jamais deux références pour un seul geste).
 */
export function isDefinitiveRejection(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

export function describeError(e: unknown): { network: boolean; message: string; code?: string } {
  if (e instanceof NetworkError) return { network: true, message: e.message };
  if (e instanceof ApiError) return { network: false, message: e.detail ? `${e.title} — ${e.detail}` : e.title, code: e.code };
  return { network: false, message: e instanceof Error ? e.message : String(e) };
}
