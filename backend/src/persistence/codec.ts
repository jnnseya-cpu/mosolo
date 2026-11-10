/**
 * Sérialiseur JSONB sans perte pour les documents des dépôts :
 * BigInt (montants en unités mineures), Date, Map, Set, octets et `undefined` dans les tableaux
 * sont encodés par une étiquette `$t`. Un objet métier qui possède lui-même une clé `$t` est protégé
 * par l'étiquette `obj`. Aucun nombre flottant n'est introduit : un BigInt reste une chaîne décimale.
 */

type Tagged =
  | { $t: 'bigint'; v: string }
  | { $t: 'date'; v: string }
  | { $t: 'map'; v: [unknown, unknown][] }
  | { $t: 'set'; v: unknown[] }
  | { $t: 'bytes'; v: string }
  | { $t: 'undef' }
  | { $t: 'obj'; v: Record<string, unknown> };

const TAG = '$t';

export function encodeDoc(value: unknown): unknown {
  if (typeof value === 'bigint') return { $t: 'bigint', v: value.toString() } satisfies Tagged;
  if (value === undefined) return { $t: 'undef' } satisfies Tagged;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nombre non fini non sérialisable.');
    if (typeof value === 'function' || typeof value === 'symbol') throw new Error('Valeur non sérialisable.');
    return value;
  }
  if (value instanceof Date) return { $t: 'date', v: value.toISOString() } satisfies Tagged;
  if (value instanceof Map) return { $t: 'map', v: [...value.entries()].map(([k, v]) => [encodeDoc(k), encodeDoc(v)]) } satisfies Tagged;
  if (value instanceof Set) return { $t: 'set', v: [...value.values()].map(encodeDoc) } satisfies Tagged;
  if (value instanceof Uint8Array) return { $t: 'bytes', v: Buffer.from(value).toString('base64') } satisfies Tagged;
  if (Array.isArray(value)) return value.map(encodeDoc);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue; // propriété absente ≡ undefined (sémantique JSON)
    out[k] = encodeDoc(v);
  }
  return Object.prototype.hasOwnProperty.call(out, TAG) ? ({ $t: 'obj', v: out } satisfies Tagged) : out;
}

export function decodeDoc(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeDoc);
  const o = value as Record<string, unknown>;
  if (typeof o[TAG] === 'string') {
    const t = o as Tagged;
    switch (t.$t) {
      case 'bigint': return BigInt(t.v);
      case 'date': return new Date(t.v);
      case 'map': return new Map(t.v.map(([k, v]) => [decodeDoc(k), decodeDoc(v)]));
      case 'set': return new Set(t.v.map(decodeDoc));
      case 'bytes': return new Uint8Array(Buffer.from(t.v, 'base64'));
      case 'undef': return undefined;
      case 'obj': return decodePlain(t.v);
      default: throw new Error(`Étiquette de sérialisation inconnue : ${String((t as { $t: unknown }).$t)}`);
    }
  }
  return decodePlain(o);
}

function decodePlain(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = decodeDoc(v);
  return out;
}

/** Forme texte stable d'un document encodé (comparaison « a changé ? »). */
export function stableText(encoded: unknown): string {
  return JSON.stringify(sortKeys(encoded));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
