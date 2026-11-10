import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** JSON canonique : clés triées récursivement, pour des empreintes stables. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortDeep(val);
    }
    return out;
  }
  return v;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Comparaison à temps constant de deux chaînes hexadécimales. */
export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Code aléatoire en base 32 de Crockford (sans I, L, O, U : lisible et dictable). */
export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CROCKFORD[bytes[i]! % 32];
  return out;
}

/** Caractère de contrôle (somme pondérée modulo 32) pour les références dictées. */
export function checkChar(s: string): string {
  let acc = 0;
  const clean = s.replace(/[^0-9A-Z]/g, '');
  for (let i = 0; i < clean.length; i++) acc += (i + 1) * Math.max(0, CROCKFORD.indexOf(clean[i]!));
  return CROCKFORD[acc % 32]!;
}
