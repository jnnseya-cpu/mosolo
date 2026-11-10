/**
 * Files locales hors ligne (constats de terrain, enrôlements assistés, contrôles de titres) :
 * - une file PAR UTILISATEUR (clé suffixée par l'identifiant) : un autre agent sur le même appareil ne voit ni ne
 *   synchronise jamais les saisies d'un collègue ;
 * - toute modification relit la file stockée juste avant d'écrire : une saisie enregistrée pendant une
 *   synchronisation n'est jamais écrasée ; seules les entrées effectivement transmises sont retirées.
 *
 * Données de mission CHIFFRÉES au repos (§ 15.1, § 15.4 « cache local chiffré et minimal », ARB-68) :
 * - AES-GCM 256 bits, IV aléatoire de 96 bits par écriture, données associées = clé de la file (une file recopiée
 *   sous une autre clé ne se déchiffre pas) ;
 * - clé PAR SESSION ET PAR UTILISATEUR, générée par WebCrypto avec `extractable: false` et conservée comme objet
 *   CryptoKey dans IndexedDB (jamais lisible par JavaScript, jamais écrite en clair) ; sans IndexedDB : clé en
 *   mémoire (la file chiffrée ne survit pas au rechargement) ; sans WebCrypto : file en mémoire seulement, jamais
 *   de repli en clair ;
 * - expiration automatique des entrées au-delà de 72 h (ARB-68, paramètre `terrain.donnees_mission_ttl_h` du registre
 *   des seuils, par défaut — à confirmer) ;
 * - déconnexion : files effacées ET clé détruite (effacement cryptographique de toute copie résiduelle).
 * L'interface reste synchrone (lecture et écriture immédiates en mémoire) ; le chiffrement et le déchiffrement sont
 * asynchrones : les écrans s'abonnent à `onQueueChange` pour se rafraîchir quand une file chiffrée a été relue.
 * Les files historiques en clair (tableaux JSON) sont relues puis rechiffrées à la première écriture.
 */
import { safeGet, safeSet } from './api';

/** Préfixes des files locales connues (purgées à la déconnexion). */
export const OFFLINE_QUEUES = ['mosolo.fieldQueue.v2', 'mosolo.canaux.enrolQueue', 'mosolo.titres.queue'] as const;

/** Durée de vie des données de mission sur le terminal (ARB-68) — valeur par défaut du registre, à confirmer. */
export const OFFLINE_MISSION_TTL_HOURS = 72;
let ttlMs = OFFLINE_MISSION_TTL_HOURS * 3_600_000;
/** Aligne la durée de vie sur le registre des seuils (valeur servie par le serveur). */
export function setOfflineTtlHours(h: number): void {
  if (Number.isFinite(h) && h > 0) ttlMs = h * 3_600_000;
}

const ENVELOPE_V = 'mosolo-file-chiffree/1';
interface Envelope { v: typeof ENVELOPE_V; alg: 'AES-GCM-256'; iv: string; ct: string; at: string }
interface Entry<T> { t: number; d: T }

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function queueKey(base: string, userId: string | null | undefined): string | null {
  return userId ? `${base}.${userId}` : null;
}

/* ------------------------------------------------------------------ */
/* Clés de session non exportables                                     */
/* ------------------------------------------------------------------ */

const DB_NAME = 'mosolo-terrain-cles';
const STORE = 'cles';
const keys = new Map<string, Promise<CryptoKey | null>>();

function cryptoAvailable(): boolean {
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
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

/** Clé AES-GCM de la session de l'utilisateur (propriétaire de la file = suffixe de la clé). */
function keyFor(owner: string): Promise<CryptoKey | null> {
  const cached = keys.get(owner);
  if (cached) return cached;
  const p = (async () => {
    if (!cryptoAvailable()) return null;
    const db = await openDb();
    const id = `file-hors-ligne|${owner}`;
    if (db) {
      const existing = await idb<CryptoKey>(db, 'readonly', (s) => s.get(id));
      if (existing && typeof existing === 'object' && 'algorithm' in existing) return existing;
    }
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (db) await idb(db, 'readwrite', (s) => s.put(k, id));
    return k;
  })().catch(() => null);
  keys.set(owner, p);
  return p;
}

async function destroyKey(owner: string): Promise<void> {
  keys.delete(owner);
  const db = await openDb();
  if (db) await idb(db, 'readwrite', (s) => s.delete(`file-hors-ligne|${owner}`));
}

const ownerOf = (key: string) => key.slice(key.lastIndexOf('.') + 1);

/* ------------------------------------------------------------------ */
/* État en mémoire                                                     */
/* ------------------------------------------------------------------ */

/** Entrées déchiffrées (horodatées pour l'expiration). */
const cache = new Map<string, Entry<unknown>[]>();
/** Dernière valeur brute du stockage connue (lue ou écrite par ce module). */
const lastSeen = new Map<string, string | null>();
/** Génération d'écriture : une écriture chiffrée dépassée n'est jamais appliquée. */
const gen = new Map<string, number>();
/** Modifications faites pendant le déchiffrement d'une file : rejouées sur la file relue (aucune saisie perdue). */
const pending = new Map<string, ((q: unknown[]) => unknown[])[]>();
const hydrating = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
/** Chiffrements et déchiffrements en cours : attendus par `flushOfflineQueues` (sinon course sous charge). */
const inflight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

function notify(key: string): void {
  for (const l of listeners.get(key) ?? []) { try { l(); } catch { /* écran démonté */ } }
}

/** Abonnement : appelé quand la file a été relue (déchiffrée) ou modifiée ailleurs. Renvoie le désabonnement. */
export function onQueueChange(key: string | null, listener: () => void): () => void {
  if (!key) return () => undefined;
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => { set.delete(listener); };
}

function isEnvelope(v: unknown): v is Envelope {
  return !!v && typeof v === 'object' && (v as Envelope).v === ENVELOPE_V;
}

const fresh = <T>(entries: Entry<T>[]): Entry<T>[] => {
  const limit = Date.now() - ttlMs;
  return entries.filter((e) => e.t >= limit);
};

/** Chiffre et écrit (si aucune écriture plus récente n'a eu lieu entre-temps). */
function persist(key: string): void {
  const g = (gen.get(key) ?? 0) + 1;
  gen.set(key, g);
  const entries = cache.get(key) ?? [];
  track((async () => {
    const k = await keyFor(ownerOf(key));
    if (!k || gen.get(key) !== g) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(key) }, k, enc.encode(JSON.stringify(entries))));
    if (gen.get(key) !== g) return;
    const raw = JSON.stringify({ v: ENVELOPE_V, alg: 'AES-GCM-256', iv: b64(iv), ct: b64(ct), at: new Date().toISOString() } satisfies Envelope);
    safeSet(key, raw);
    lastSeen.set(key, raw);
  })().catch(() => undefined));
}

/** Déchiffre une file écrite par ailleurs (rechargement, autre onglet), puis rejoue les modifications en attente. */
function hydrate(key: string, raw: string, env: Envelope): void {
  if (hydrating.has(key)) return;
  hydrating.add(key);
  track((async () => {
    let entries: Entry<unknown>[] = [];
    try {
      const k = await keyFor(ownerOf(key));
      if (k) {
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: enc.encode(key) }, k, unb64(env.ct));
        const parsed = JSON.parse(dec.decode(pt)) as unknown;
        if (Array.isArray(parsed)) entries = parsed as Entry<unknown>[];
      }
    } catch { entries = []; /* clé détruite ou file altérée : illisible, jamais en clair */ }
    hydrating.delete(key);
    if (safeGet(key) !== raw) { notify(key); return; }
    lastSeen.set(key, raw);
    let items = fresh(entries).map((e) => e.d);
    const ops = pending.get(key) ?? [];
    pending.delete(key);
    for (const fn of ops) items = fn(items);
    setItems(key, items, entries);
    if (ops.length || entries.length !== fresh(entries).length) persist(key);
    notify(key);
  })());
}

/** Remplace les entrées en conservant l'horodatage des éléments inchangés (l'expiration court depuis leur saisie). */
function setItems(key: string, items: unknown[], previous: Entry<unknown>[] = cache.get(key) ?? []): void {
  const now = Date.now();
  const stamps = new Map<string, number[]>();
  for (const e of previous) {
    const s = JSON.stringify(e.d);
    stamps.set(s, [...(stamps.get(s) ?? []), e.t]);
  }
  cache.set(key, items.map((d) => {
    const s = JSON.stringify(d);
    const list = stamps.get(s);
    const t = list?.length ? list.shift()! : now;
    return { t, d };
  }));
}

/** Synchronise la mémoire avec le stockage ; renvoie faux si une file chiffrée est en cours de déchiffrement. */
function sync(key: string): boolean {
  const raw = safeGet(key);
  if (lastSeen.has(key) && raw === lastSeen.get(key)) return !hydrating.has(key);
  // Écriture extérieure (autre écran, ancienne version en clair, autre onglet) : elle fait foi.
  if (raw === null) {
    lastSeen.set(key, null);
    if (!cache.has(key)) cache.set(key, []);
    return true;
  }
  let v: unknown;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (Array.isArray(v)) {
    lastSeen.set(key, raw);
    let items: unknown[] = v;
    const ops = pending.get(key) ?? [];
    pending.delete(key);
    for (const fn of ops) items = fn(items);
    setItems(key, items);
    // File historique en clair : rechiffrée aussitôt (migration).
    persist(key);
    return true;
  }
  if (isEnvelope(v)) {
    hydrate(key, raw, v);
    return false;
  }
  lastSeen.set(key, raw);
  cache.set(key, []);
  return true;
}

/* ------------------------------------------------------------------ */
/* Interface publique (inchangée)                                      */
/* ------------------------------------------------------------------ */

export function readQueue<T>(key: string | null): T[] {
  if (!key) return [];
  sync(key);
  const entries = cache.get(key) ?? [];
  const alive = fresh(entries);
  if (alive.length !== entries.length) { cache.set(key, alive); persist(key); }
  let items = alive.map((e) => e.d as T);
  // Modifications en attente du déchiffrement : visibles immédiatement.
  for (const fn of pending.get(key) ?? []) items = fn(items) as T[];
  return items;
}

/** Relit la file, applique `fn`, réécrit (chiffré) et renvoie la nouvelle file. */
export function updateQueue<T>(key: string | null, fn: (q: T[]) => T[]): T[] {
  if (!key) return [];
  const ready = sync(key);
  if (!ready) {
    // File chiffrée en cours de relecture : la modification est rejouée dessus, rien n'est écrasé.
    const ops = pending.get(key) ?? [];
    ops.push(fn as (q: unknown[]) => unknown[]);
    pending.set(key, ops);
    return readQueue<T>(key);
  }
  const next = fn(fresh(cache.get(key) ?? []).map((e) => e.d as T));
  setItems(key, next);
  persist(key);
  return next;
}

/** Déconnexion : efface les files locales de l'utilisateur et détruit sa clé (données personnelles, appareil partagé). */
export function purgeUserQueues(userId: string | null | undefined, bases: readonly string[] = OFFLINE_QUEUES): void {
  for (const b of bases) {
    const k = queueKey(b, userId);
    if (!k) continue;
    gen.set(k, (gen.get(k) ?? 0) + 1);
    cache.delete(k);
    pending.delete(k);
    lastSeen.set(k, null);
    safeSet(k, null);
    notify(k);
  }
  if (userId) void destroyKey(userId).catch(() => undefined);
}

/** Purge des files expirées de tous les utilisateurs de l'appareil (démarrage de l'application). */
export function purgeExpiredQueues(): number {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && OFFLINE_QUEUES.some((b) => k.startsWith(`${b}.`))) { readQueue(k); n++; }
    }
  } catch { /* stockage indisponible */ }
  return n;
}

/** Attente de la fin des chiffrements en cours (tests, déconnexion ordonnée). */
export async function flushOfflineQueues(): Promise<void> {
  // Attente EXPLICITE des opérations en cours (et de celles qu'elles déclenchent : un déchiffrement peut relancer un
  // chiffrement) — auparavant quelques tours de boucle d'événements, insuffisants sous charge (échec intermittent).
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all([...keys.values()]);
    if (!inflight.size && !hydrating.size) break;
    await Promise.allSettled([...inflight]);
  }
}

/** Réinitialise l'état en mémoire (tests : simule un rechargement de la page). */
export function __resetOfflineQueuesForTests(opts: { dropKeys?: boolean } = {}): void {
  cache.clear(); lastSeen.clear(); pending.clear(); hydrating.clear(); gen.clear(); inflight.clear();
  if (opts.dropKeys) keys.clear();
}
