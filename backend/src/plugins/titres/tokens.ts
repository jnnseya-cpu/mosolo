/**
 * Jetons des titres (§ 19A.5, § H.11.5).
 *  - Jeton STATIQUE (QR papier, autocollant, gilet) : charge utile signée Ed25519, vérifiable HORS LIGNE avec la clé publique.
 *  - Jeton DYNAMIQUE (application) : HMAC-SHA256 du titre et de la fenêtre de 30 s ; régénéré toutes les 30 s ;
 *    une capture d'écran ou un code copié devient invalide à la fenêtre suivante (AC-TIT-05).
 */
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, hmacSha256Hex, randomSecret, safeEqualHex } from '../../core/crypto.js';

export const DYNAMIC_WINDOW_SECONDS = 30;
/** Marge de passage d'une fenêtre à la suivante (latence réseau du scan), en secondes. */
export const DYNAMIC_GRACE_SECONDS = 3;

export type StaticPayload = Record<string, string | number | boolean | null>;

export class TokenSigner {
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private readonly dynamicKey: string;

  constructor(opts: { signingKey?: KeyObject; dynamicKey?: string } = {}) {
    if (opts.signingKey) {
      this.privateKey = opts.signingKey;
      this.publicKey = createPublicKey(opts.signingKey);
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    this.dynamicKey = opts.dynamicKey ?? randomSecret();
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** Signature Ed25519 d'un document canonique (listes de révocation, paquets hors ligne). */
  signDocument(doc: unknown): string {
    return sign(null, Buffer.from(canonicalJson(doc)), this.privateKey).toString('base64url');
  }

  verifyDocument(doc: unknown, signature: string): boolean {
    try {
      return verify(null, Buffer.from(canonicalJson(doc)), this.publicKey, Buffer.from(signature, 'base64url'));
    } catch {
      return false;
    }
  }

  /** `MT1.<charge utile base64url>.<signature base64url>` */
  signStatic(payload: StaticPayload): string {
    const body = Buffer.from(canonicalJson(payload)).toString('base64url');
    const sig = sign(null, Buffer.from(body), this.privateKey).toString('base64url');
    return `MT1.${body}.${sig}`;
  }

  verifyStatic(token: string): StaticPayload | null {
    const parts = token.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'MT1') return null;
    const [, body, sig] = parts as [string, string, string];
    try {
      if (!verify(null, Buffer.from(body), this.publicKey, Buffer.from(sig, 'base64url'))) return null;
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StaticPayload) : null;
    } catch {
      return null;
    }
  }

  static windowOf(t: number): number {
    return Math.floor(t / (DYNAMIC_WINDOW_SECONDS * 1000));
  }

  /** `MD1.<id du titre>.<fenêtre>.<mac>` pour la fenêtre de 30 s contenant `t` (heure serveur). */
  dynamicFor(credentialId: string, t: number): { token: string; window: number; windowStart: string; expiresAt: string } {
    const w = TokenSigner.windowOf(t);
    const mac = hmacSha256Hex(this.dynamicKey, `${credentialId}|${w}`).slice(0, 32);
    return {
      token: `MD1.${credentialId}.${w}.${mac}`,
      window: w,
      windowStart: new Date(w * DYNAMIC_WINDOW_SECONDS * 1000).toISOString(),
      expiresAt: new Date((w + 1) * DYNAMIC_WINDOW_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Vérifie un jeton dynamique à l'heure serveur `now` : MAC exact et fenêtre courante (ou la précédente pendant
   * les 3 premières secondes de la nouvelle fenêtre). Toute capture présentée plus tard est refusée.
   */
  verifyDynamic(token: string, now: number): { ok: true; credentialId: string } | { ok: false; credentialId?: string; reason: 'FORMAT' | 'SIGNATURE' | 'FENETRE_EXPIREE' } {
    const parts = token.trim().split('.');
    if (parts.length !== 4 || parts[0] !== 'MD1' || !/^\d+$/.test(parts[2] ?? '')) return { ok: false, reason: 'FORMAT' };
    const [, id, wStr, mac] = parts as [string, string, string, string];
    const w = Number(wStr);
    const expected = hmacSha256Hex(this.dynamicKey, `${id}|${w}`).slice(0, 32);
    if (!safeEqualHex(expected, mac.toLowerCase())) return { ok: false, reason: 'SIGNATURE' };
    const current = TokenSigner.windowOf(now);
    const intoWindow = now - current * DYNAMIC_WINDOW_SECONDS * 1000;
    const fresh = w === current || (w === current - 1 && intoWindow <= DYNAMIC_GRACE_SECONDS * 1000);
    if (!fresh) return { ok: false, credentialId: id, reason: 'FENETRE_EXPIREE' };
    return { ok: true, credentialId: id };
  }
}
