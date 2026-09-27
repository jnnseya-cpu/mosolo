/**
 * Signature des rappels prestataires génériques (§ 30.3), schéma v2 : l'horodatage et le nonce sont COUVERTS par la
 * signature (un nonce ou un horodatage réécrit invalide le rappel), clés identifiées (kid) pour une rotation sans
 * interruption, mémoire de nonces bornée.
 *
 *   chaîne canonique = "mosolo-callback-v2\n<x-timestamp>\n<x-nonce>\n<corps brut>"
 *   x-signature      = "v2=" + hex(HMAC-SHA256(secret, chaîne canonique))   (préfixe « v2= » ou « sha256= » facultatif)
 *   x-key-id         = kid de la clé employée (facultatif : sans lui, chaque clé active est essayée à temps constant)
 *
 * Trousseau d'un prestataire (variable MOSOLO_PROVIDER_SECRET_<PRESTATAIRE>) : soit un secret seul (kid « default »),
 * soit « kid:secret[,kid:secret…] » — kid en minuscules [a-z0-9_-]{1,32}, la PREMIÈRE clé est la clé courante, les
 * suivantes restent acceptées en vérification. Rotation : ajouter la nouvelle clé en tête, basculer le prestataire,
 * retirer l'ancienne. Un secret seul ne doit donc pas avoir la forme « kid:… ».
 */
import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, safeEqualHex } from '../../core/crypto.js';

export interface ProviderKey {
  kid: string;
  secret: string;
}

export const CALLBACK_SIGNATURE_VERSION = 'v2';
export const DEFAULT_KEY_ID = 'default';
const KID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Nonce : 8 à 128 caractères sûrs (UUID, base64url, hexadécimal…), jamais de séparateur de la chaîne canonique. */
const NONCE = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidNonce(n: string): boolean {
  return NONCE.test(n);
}

/** Trousseau depuis la valeur d'environnement (voir en-tête). Liste vide si la valeur est vide. */
export function parseProviderKeyRing(raw: string | undefined): ProviderKey[] {
  const value = raw?.trim();
  if (!value) return [];
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  const pairs = items.map((s) => {
    const i = s.indexOf(':');
    return i > 0 && KID.test(s.slice(0, i)) && s.length > i + 1 ? { kid: s.slice(0, i), secret: s.slice(i + 1) } : undefined;
  });
  if (pairs.every((p): p is ProviderKey => !!p)) {
    const kids = new Set<string>();
    for (const p of pairs) {
      if (kids.has(p.kid)) throw new Error(`identifiant de clé « ${p.kid} » en double`);
      kids.add(p.kid);
    }
    return pairs;
  }
  if (items.length > 1) throw new Error('trousseau illisible : format « kid:secret,kid:secret » attendu');
  return [{ kid: DEFAULT_KEY_ID, secret: value }];
}

export function canonicalCallbackString(timestamp: string, nonce: string, rawBody: string): string {
  return `mosolo-callback-${CALLBACK_SIGNATURE_VERSION}\n${timestamp}\n${nonce}\n${rawBody}`;
}

/** Signature hexadécimale v2 (sans préfixe). */
export function signCallback(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return hmacSha256Hex(secret, canonicalCallbackString(timestamp, nonce, rawBody));
}

/**
 * En-têtes complets d'un rappel signé (simulateurs de démonstration, points agréés, tests) : horodatage `at`, nonce
 * aléatoire, signature v2 et kid éventuel.
 */
export function signedCallbackHeaders(secret: string, rawBody: string, at: Date, opts: { nonce?: string; kid?: string } = {}): { signature: string; nonce: string; timestamp: string; keyId?: string } {
  const timestamp = at.toISOString();
  const nonce = opts.nonce ?? randomUUID();
  return { signature: `${CALLBACK_SIGNATURE_VERSION}=${signCallback(secret, timestamp, nonce, rawBody)}`, nonce, timestamp, ...(opts.kid ? { keyId: opts.kid } : {}) };
}

/**
 * Vérification à temps constant contre les clés candidates (toutes comparées, sans sortie anticipée) ; renvoie le kid
 * de la clé qui a signé, ou undefined.
 */
export function verifyCallbackSignature(keys: ProviderKey[], signature: string, timestamp: string, nonce: string, rawBody: string): string | undefined {
  const provided = signature.trim().replace(/^(v2|sha256)=/i, '').toLowerCase();
  const canonical = canonicalCallbackString(timestamp, nonce, rawBody);
  let matched: string | undefined;
  for (const k of keys) {
    if (safeEqualHex(hmacSha256Hex(k.secret, canonical), provided) && matched === undefined) matched = k.kid;
  }
  return matched;
}

/**
 * Mémoire anti-rejeu bornée : un nonce est retenu jusqu'à la fin de la fenêtre de son horodatage signé (au-delà, le
 * rappel est de toute façon refusé comme périmé). Plafond atteint ⇒ purge des expirés puis éviction des plus anciens
 * (signalée à l'appelant : une éviction forcée rouvre une fenêtre de rejeu, à surveiller).
 */
export class NonceStore {
  private readonly entries = new Map<string, number>();
  constructor(private readonly max = 100_000) {}

  get size(): number {
    return this.entries.size;
  }

  /** Enregistre le nonce ; false s'il est déjà connu et non expiré. `evicted` : nombre d'entrées vivantes sacrifiées. */
  remember(key: string, expiresAt: number, now: number): { fresh: boolean; evicted: number } {
    const known = this.entries.get(key);
    if (known !== undefined && known > now) return { fresh: false, evicted: 0 };
    this.entries.delete(key);
    let evicted = 0;
    if (this.entries.size >= this.max) {
      for (const [k, exp] of this.entries) if (exp <= now) this.entries.delete(k);
      for (const k of this.entries.keys()) {
        if (this.entries.size < this.max) break;
        this.entries.delete(k);
        evicted++;
      }
    }
    this.entries.set(key, expiresAt);
    return { fresh: true, evicted };
  }
}
