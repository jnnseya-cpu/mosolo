/**
 * Application citoyenne Android et iOS (module 4) — fonctions propres à l'appareil, testées au niveau web :
 *  - plateforme (Capacitor natif Android / iOS, ou navigateur) ;
 *  - détection d'appareil modifié (racine, jailbreak, émulateur, débogage) par le module natif « MosoloIntegrite »,
 *    avec repli navigateur (automatisation détectée) ; le verdict est remonté au serveur, qui refuse les fonctions
 *    sensibles d'un appareil compromis ;
 *  - code d'accès (PIN) de l'appareil partagé, vérifié localement par PBKDF2, verrouillage automatique ;
 *  - portefeuille de titres CHIFFRÉ (AES-GCM, clé dérivée du code) pour la consultation hors connexion.
 * Aucune validité n'est calculée sur l'horloge du téléphone : le portefeuille conserve l'état et l'heure SERVEUR de la
 * dernière synchronisation, affichés tels quels hors connexion.
 */
import { safeGet, safeSet } from './api';

export type Plateforme = 'ANDROID' | 'IOS' | 'WEB';

interface CapacitorLike {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}
const cap = (): CapacitorLike | undefined => (globalThis as { Capacitor?: CapacitorLike }).Capacitor;

export function plateforme(): Plateforme {
  const p = cap()?.getPlatform?.();
  return p === 'android' ? 'ANDROID' : p === 'ios' ? 'IOS' : 'WEB';
}

export interface VerdictIntegrite { racine: boolean; jailbreak: boolean; emulateur: boolean; debogage: boolean; signatureAlteree?: boolean; source: 'MODULE_NATIF' | 'NAVIGATEUR' }

/**
 * Crochet de détection d'appareil modifié. Le module natif (mobile/native/…) expose `MosoloIntegrite.verifier()` ;
 * dans un navigateur, seul un pilotage automatisé (webdriver) est détectable.
 */
export async function verifierIntegrite(): Promise<VerdictIntegrite> {
  const natif = cap()?.Plugins?.['MosoloIntegrite'] as { verifier?: () => Promise<Partial<VerdictIntegrite>> } | undefined;
  if (natif?.verifier) {
    const r = await natif.verifier();
    return { racine: !!r.racine, jailbreak: !!r.jailbreak, emulateur: !!r.emulateur, debogage: !!r.debogage, signatureAlteree: !!r.signatureAlteree, source: 'MODULE_NATIF' };
  }
  const webdriver = typeof navigator !== 'undefined' && (navigator as { webdriver?: boolean }).webdriver === true;
  return { racine: false, jailbreak: false, emulateur: false, debogage: webdriver, source: 'NAVIGATEUR' };
}

// ───────────────────────── Dérivation de clé (PBKDF2) ─────────────────────────

const PBKDF2_ITERATIONS = 210_000;
const enc = new TextEncoder();
type Octets = Uint8Array<ArrayBuffer>;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
function unb64(s: string): Octets {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const aleatoire = (n: number): Octets => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

async function baseKey(pin: string) {
  return crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
}
async function verifierDe(pin: string, salt: Octets): Promise<string> {
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, await baseKey(pin), 256);
  return b64(new Uint8Array(bits));
}
async function cleDe(pin: string, salt: Octets): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, await baseKey(pin), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ───────────────────────── Code d'accès et verrouillage ─────────────────────────

const PIN_KEY = 'mosolo.appareil.code';
const ESSAIS_KEY = 'mosolo.appareil.essais';
/** Verrouillage automatique après inactivité — valeur par défaut à confirmer par le maître d'ouvrage. */
export const VERROUILLAGE_AUTO_MS = 2 * 60_000;
/** Essais de code avant blocage temporaire — valeur par défaut à confirmer par le maître d'ouvrage. */
export const ESSAIS_MAX = 5;
export const BLOCAGE_MS = 5 * 60_000;
export const PAR_DEFAUT = 'par défaut — à confirmer par le maître d’ouvrage';

export const PIN_VALIDE = /^\d{4,8}$/;

export function codeDefini(): boolean {
  return !!safeGet(PIN_KEY);
}

export async function definirCode(pin: string): Promise<void> {
  if (!PIN_VALIDE.test(pin)) throw new Error('Code de 4 à 8 chiffres attendu.');
  const salt = aleatoire(16);
  safeSet(PIN_KEY, JSON.stringify({ salt: b64(salt), verifier: await verifierDe(pin, salt) }));
  safeSet(ESSAIS_KEY, null);
}

export type ResultatCode = { ok: true } | { ok: false; restants: number; bloqueJusqua?: number };

/** Vérifie le code ; au-delà de ESSAIS_MAX échecs, blocage temporaire (le portefeuille reste chiffré). */
export async function verifierCode(pin: string, now = Date.now()): Promise<ResultatCode> {
  const raw = safeGet(PIN_KEY);
  if (!raw) return { ok: true };
  const essais = JSON.parse(safeGet(ESSAIS_KEY) ?? '{"n":0}') as { n: number; jusqua?: number };
  if (essais.jusqua && now < essais.jusqua) return { ok: false, restants: 0, bloqueJusqua: essais.jusqua };
  const { salt, verifier } = JSON.parse(raw) as { salt: string; verifier: string };
  if ((await verifierDe(pin, unb64(salt))) === verifier) { safeSet(ESSAIS_KEY, null); return { ok: true }; }
  const n = (essais.jusqua && now >= essais.jusqua ? 0 : essais.n) + 1;
  const bloque = n >= ESSAIS_MAX ? now + BLOCAGE_MS : undefined;
  safeSet(ESSAIS_KEY, JSON.stringify({ n: bloque ? 0 : n, ...(bloque ? { jusqua: bloque } : {}) }));
  return { ok: false, restants: bloque ? 0 : ESSAIS_MAX - n, ...(bloque ? { bloqueJusqua: bloque } : {}) };
}

/** Minuterie d'inactivité : appelle `onLock` après `ms` sans activité ; `touch()` relance la minuterie. */
export function verrouillageAuto(onLock: () => void, ms = VERROUILLAGE_AUTO_MS) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { if (t) clearTimeout(t); t = setTimeout(onLock, ms); };
  touch();
  return { touch, stop: () => { if (t) clearTimeout(t); } };
}

// ───────────────────────── Portefeuille chiffré ─────────────────────────

const WALLET_KEY = 'mosolo.portefeuille.v1';

export interface TitrePortefeuille {
  id: string;
  numero: string;
  libelle: string;
  /** Jeton statique signé (Ed25519) : vérifiable hors ligne par le contrôleur. */
  jetonStatique?: string;
  validUntil: string;
  /** État et texte calculés PAR LE SERVEUR à la synchronisation (jamais recalculés sur l'horloge du téléphone). */
  etatServeur: string;
  texteServeur: string;
}
export interface Portefeuille {
  titres: TitrePortefeuille[];
  quittances: { numero: string; montant: string; date: string }[];
  preferences: { langue: string };
  /** Heure du SERVEUR à la synchronisation. */
  synchroniseA: string;
}

export function portefeuillePresent(): boolean {
  return !!safeGet(WALLET_KEY);
}

export async function scellerPortefeuille(pin: string, p: Portefeuille): Promise<void> {
  const salt = aleatoire(16);
  const iv = aleatoire(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cleDe(pin, salt), enc.encode(JSON.stringify(p)));
  safeSet(WALLET_KEY, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) }));
}

/** Ouvre le portefeuille ; code erroné ou données altérées ⇒ null (AES-GCM authentifie le contenu). */
export async function ouvrirPortefeuille(pin: string): Promise<Portefeuille | null> {
  const raw = safeGet(WALLET_KEY);
  if (!raw) return null;
  try {
    const { salt, iv, ct } = JSON.parse(raw) as { salt: string; iv: string; ct: string };
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await cleDe(pin, unb64(salt)), unb64(ct));
    return JSON.parse(new TextDecoder().decode(pt)) as Portefeuille;
  } catch {
    return null;
  }
}

export function effacerPortefeuille(): void {
  safeSet(WALLET_KEY, null);
}

/** Contenu brut stocké (pour contrôle : jamais de donnée lisible en clair). */
export function contenuStocke(): string | null {
  return safeGet(WALLET_KEY);
}
