/**
 * Primitives cryptographiques du fournisseur d'identité local (node:crypto uniquement) :
 *  - jetons JWT signés EdDSA (Ed25519), publiés en JWKS ;
 *  - TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 chiffres) et Base32 (RFC 4648) ;
 *  - empreintes de mots de passe scrypt (sel aléatoire, comparaison à temps constant).
 */
import {
  createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, scryptSync,
  sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject,
} from 'node:crypto';

// ------------------------------------------------------------------------------------------------ JWT (EdDSA)

export interface JwtClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  auth_time: number;
  acr: string;
  amr: string[];
  [claim: string]: unknown;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class JwtSigner {
  readonly kid: string;
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(privateKeyPem?: string) {
    if (privateKeyPem) {
      this.privateKey = createPrivateKey(privateKeyPem);
      if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('MOSOLO_JWT_PRIVATE_KEY doit être une clé Ed25519 (PKCS#8 PEM).');
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x: string };
    // Empreinte RFC 7638 : membres requis triés.
    this.kid = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x })).digest('base64url');
  }

  jwks(): { keys: Record<string, string>[] } {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    return { keys: [{ ...jwk, kid: this.kid, alg: 'EdDSA', use: 'sig' }] };
  }

  sign(claims: JwtClaims): string {
    const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.kid }));
    const payload = b64u(JSON.stringify(claims));
    const sig = edSign(null, Buffer.from(`${header}.${payload}`), this.privateKey);
    return `${header}.${payload}.${b64u(sig)}`;
  }

  /** Vérifie la signature et la structure ; retourne les revendications (les dates sont contrôlées par l'appelant). */
  verify(token: string): JwtClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    } catch {
      return null;
    }
    // Aucun algorithme n'est accepté depuis le jeton lui-même (pas de « alg: none », pas de confusion HS/EdDSA).
    if (header.alg !== 'EdDSA' || header.kid !== this.kid) return null;
    const ok = edVerify(null, Buffer.from(`${h}.${p}`), this.publicKey, Buffer.from(s, 'base64url'));
    if (!ok) return null;
    try {
      return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtClaims;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------------------------------------------ Base32 + TOTP

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Secret Base32 invalide.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_S = 30;

/** HOTP (RFC 4226) — troncature dynamique. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_S);
}

export function totp(secretB32: string, now: Date): string {
  return hotp(base32Decode(secretB32), totpStep(now));
}

/** Vérifie un code TOTP (fenêtre ±1 pas) ; retourne le pas utilisé (anti-rejeu par l'appelant) ou null. */
export function verifyTotp(secretB32: string, code: string, now: Date, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = totpStep(now);
  for (let d = -window; d <= window; d++) {
    if (safeEqualStr(hotp(secret, step + d), code)) return step + d;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = 'KINSHASA MOSOLO'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`;
}

// ------------------------------------------------------------------------------------------------ Mots de passe

export interface PasswordHash {
  alg: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string, salt = randomBytes(16)): PasswordHash {
  const hash = scryptSync(password.normalize('NFKC'), salt, 32, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { alg: 'scrypt', n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function verifyPassword(password: string, h: PasswordHash): boolean {
  const got = scryptSync(password.normalize('NFKC'), Buffer.from(h.salt, 'base64'), 32, { N: h.n, r: h.r, p: h.p });
  const want = Buffer.from(h.hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

// ------------------------------------------------------------------------------------------------ Divers

export function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function sha256b64u(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

/** Code numérique aléatoire (OTP SMS). */
export function randomDigits(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += String(randomInt(0, 10));
  return out;
}
