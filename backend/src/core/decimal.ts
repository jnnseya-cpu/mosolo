/**
 * Arithmétique décimale exacte à échelle fixe (10^-18) sur BigInt.
 * Utilisée par l'évaluateur de formules et les taux croisés. Jamais de virgule flottante.
 */
import { parseScaled } from '@mosolo/shared';

export const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

export class DecimalError extends Error {}

export function dec(value: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) throw new DecimalError(`Nombre décimal invalide : "${value}"`);
  return parseScaled(value, SCALE);
}

function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new DecimalError('Division par zéro');
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n; // arrondi « demi vers le haut » (en valeur absolue)
  return neg ? -q : q;
}

export const decAdd = (a: bigint, b: bigint): bigint => a + b;
export const decSub = (a: bigint, b: bigint): bigint => a - b;
export const decMul = (a: bigint, b: bigint): bigint => roundDiv(a * b, ONE);
export const decDiv = (a: bigint, b: bigint): bigint => roundDiv(a * ONE, b);

/** Représentation décimale sans zéros superflus (« 158.4 », « 0 »). */
export function decToString(v: bigint): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(SCALE + 1, '0');
  const int = s.slice(0, s.length - SCALE);
  const frac = s.slice(s.length - SCALE).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

/** Quotient exact a / b de deux décimaux en chaîne, arrondi à 12 décimales. */
export function divideDecimalStrings(a: string, b: string, decimals = 12): string {
  const q = decDiv(dec(a), dec(b));
  const factor = 10n ** BigInt(SCALE - decimals);
  return decToString(roundDiv(q, factor) * factor);
}
