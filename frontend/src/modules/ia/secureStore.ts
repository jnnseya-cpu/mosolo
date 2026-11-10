/**
 * Brouillons hors ligne CHIFFRÉS dans le navigateur (§ 23.5.3 « stockage local chiffré en hors ligne », AI-06 / SP-15e).
 *
 * - Clé d'appareil : clé HMAC-SHA-256 générée par WebCrypto avec `extractable: false`, conservée comme objet CryptoKey
 *   dans IndexedDB. Son matériau n'est jamais lisible par JavaScript ni écrit en clair (ni localStorage, ni exportable).
 * - Clé de brouillon : dérivée par utilisateur (HMAC(clé d'appareil, « mosolo-brouillon-v1|<utilisateur> ») → clé AES-GCM
 *   256 bits importée non exportable) ; le matériau dérivé n'existe qu'un instant en mémoire, puis est effacé.
 * - Chiffrement : AES-GCM, IV aléatoire de 96 bits par enregistrement, données associées = clé du brouillon + utilisateur
 *   (un contenu recopié sous une autre clé ou pour un autre utilisateur ne se déchiffre pas).
 * - Sans IndexedDB (navigation privée stricte) : clé de session en mémoire ; les brouillons restent chiffrés mais ne
 *   survivent pas au rechargement. Sans WebCrypto : AUCUN stockage local (jamais de repli en clair).
 */
const DB_NAME = 'mosolo-ia-cles';
const STORE = 'cles';
const MASTER_ID = 'appareil-hmac-v1';
export const SEALED_PREFIX = 'mosolo.sdraft.';

export interface SealedEnvelope {
  v: 1;
  alg: 'AES-GCM-256';
  kdf: 'HMAC-SHA-256/cle-appareil-non-exportable';
  iv: string;
  ct: string;
  at: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let sessionMaster: Promise<CryptoKey> | null = null;
const derived = new Map<string, Promise<CryptoKey>>();

export function secureStorageAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

async function generateMaster(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']) as Promise<CryptoKey>;
}

/** Clé d'appareil non exportable (persistée comme CryptoKey dans IndexedDB, sinon clé de session). */
async function masterKey(): Promise<CryptoKey> {
  if (sessionMaster) return sessionMaster;
  sessionMaster = (async () => {
    const db = await openDb();
    if (!db) return generateMaster();
    const existing = await idb<CryptoKey>(db, 'readonly', (s) => s.get(MASTER_ID));
    if (existing && typeof existing === 'object' && 'algorithm' in existing) return existing;
    const k = await generateMaster();
    await idb(db, 'readwrite', (s) => s.put(k, MASTER_ID));
    return k;
  })();
  return sessionMaster;
}

/** Clé AES-GCM dérivée pour un utilisateur ; non exportable, jamais stockée. */
async function draftKey(scope: string): Promise<CryptoKey> {
  const cached = derived.get(scope);
  if (cached) return cached;
  const p = (async () => {
    const m = await masterKey();
    const raw = new Uint8Array(await crypto.subtle.sign('HMAC', m, enc.encode(`mosolo-brouillon-v1|${scope}`)));
    try {
      return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally {
      raw.fill(0);
    }
  })();
  derived.set(scope, p);
  return p;
}

function safeLocal(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** Chiffre et enregistre un brouillon local. Retourne false si le chiffrement est indisponible (rien n'est écrit). */
export async function sealDraft(key: string, data: unknown, scope: string): Promise<boolean> {
  const ls = safeLocal();
  if (!secureStorageAvailable() || !ls) return false;
  const k = await draftKey(scope);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${key}|${scope}`) }, k, enc.encode(JSON.stringify(data))));
  const env: SealedEnvelope = { v: 1, alg: 'AES-GCM-256', kdf: 'HMAC-SHA-256/cle-appareil-non-exportable', iv: b64(iv), ct: b64(ct), at: new Date().toISOString() };
  try { ls.setItem(SEALED_PREFIX + key, JSON.stringify(env)); return true; } catch { return false; }
}

/** Déchiffre un brouillon local ; null s'il est absent, altéré ou d'un autre utilisateur. */
export async function openDraft<T>(key: string, scope: string): Promise<{ data: T; at: string } | null> {
  const ls = safeLocal();
  if (!secureStorageAvailable() || !ls) return null;
  let env: SealedEnvelope;
  try {
    const raw = ls.getItem(SEALED_PREFIX + key);
    if (!raw) return null;
    env = JSON.parse(raw) as SealedEnvelope;
  } catch { return null; }
  try {
    const k = await draftKey(scope);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: enc.encode(`${key}|${scope}`) }, k, unb64(env.ct));
    return { data: JSON.parse(dec.decode(pt)) as T, at: env.at };
  } catch {
    return null;
  }
}

export function removeSealed(key: string): void {
  try { safeLocal()?.removeItem(SEALED_PREFIX + key); } catch { /* stockage indisponible */ }
}

/**
 * Migration des brouillons historiques en clair (`mosolo.draft.*`, lib/drafts.ts) vers le stockage chiffré.
 * À appeler par le socle une fois lib/drafts.ts basculé sur cet adaptateur (voir rapport du lot « ia »).
 */
export async function migrateClearDrafts(scope: string, clearPrefix = 'mosolo.draft.'): Promise<number> {
  const ls = safeLocal();
  if (!ls || !secureStorageAvailable()) return 0;
  const keys: string[] = [];
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k?.startsWith(clearPrefix)) keys.push(k); }
  let n = 0;
  for (const k of keys) {
    const raw = ls.getItem(k);
    if (raw === null) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }
    if (await sealDraft(k.slice(clearPrefix.length), value, scope)) { ls.removeItem(k); n++; }
  }
  return n;
}

/** Réinitialise les caches (tests). */
export function __resetSecureStoreForTests(): void { sessionMaster = null; derived.clear(); }
