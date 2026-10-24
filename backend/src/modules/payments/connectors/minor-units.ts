/**
 * Conversion EXACTE entre `MoneyJSON` (chaîne décimale, décimales MOSOLO) et un entier d'unités mineures
 * tel que l'attend un prestataire, selon SA table d'exposants (qui peut différer d'ISO 4217 :
 * KODA traite le CDF comme une devise à zéro décimale). Aucun flottant : chaînes et BigInt uniquement.
 * Un montant non représentable dans l'exposant du prestataire est refusé (422 AMOUNT_NOT_REPRESENTABLE) —
 * jamais arrondi, car tout arrondi créerait un écart entre le dû et le payé.
 */
import { CURRENCIES, isCurrencyCode, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import { unprocessable } from '../../../core/errors.js';

/** Exposant (nombre de décimales) par devise, du point de vue du prestataire. */
export type ExponentTable = Partial<Record<CurrencyCode, number>>;

const DECIMAL = /^(\d{1,18})(?:\.(\d{1,18}))?$/;

function notRepresentable(detail: string, ext: Record<string, unknown>): never {
  throw unprocessable('AMOUNT_NOT_REPRESENTABLE', detail, ext);
}

export function exponentFor(table: ExponentTable, currency: string): number {
  if (!isCurrencyCode(currency)) throw unprocessable('CURRENCY_NOT_SUPPORTED_BY_PROVIDER', `Devise inconnue : ${currency}`);
  const e = table[currency];
  if (e === undefined) throw unprocessable('CURRENCY_NOT_SUPPORTED_BY_PROVIDER', `Devise ${currency} non prise en charge par ce prestataire.`);
  return e;
}

/** MoneyJSON → unités mineures du prestataire (BigInt). Refuse toute fraction non représentable. */
export function toMinorUnits(money: MoneyJSON, table: ExponentTable): bigint {
  const exponent = exponentFor(table, money.currency);
  const m = DECIMAL.exec(money.amount.trim());
  if (!m) throw unprocessable('INVALID_AMOUNT', `Montant décimal invalide : "${money.amount}"`);
  const intPart = m[1]!;
  const frac = m[2] ?? '';
  const kept = frac.slice(0, exponent);
  const dropped = frac.slice(exponent);
  if (/[1-9]/.test(dropped)) {
    notRepresentable(
      `Le montant ${money.amount} ${money.currency} n'est pas représentable chez ce prestataire (${exponent} décimale(s) pour ${money.currency}) : aucun arrondi n'est admis.`,
      { amount: money, providerExponent: exponent },
    );
  }
  return BigInt(intPart + kept.padEnd(exponent, '0'));
}

/**
 * Entier transmissible en JSON : refuse ce qui dépasse Number.MAX_SAFE_INTEGER
 * (le JSON d'un prestataire ne porte pas de BigInt ; au-delà, la précision serait perdue).
 */
export function toSafeJsonInteger(minor: bigint): number {
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    notRepresentable(`Montant hors de la plage entière sûre pour une transmission JSON : ${minor}`, {});
  }
  return Number(minor);
}

/** Lecture tolérante d'un montant entrant (nombre entier JSON ou chaîne de chiffres) ; jamais de décimale. */
export function parseMinorInput(v: unknown): bigint | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
  if (typeof v === 'bigint') return v >= 0n ? v : undefined;
  return undefined;
}

/**
 * Unités mineures du prestataire → MoneyJSON au format MOSOLO (décimales du référentiel `@mosolo/shared`).
 * Ex. KODA : 25000 CDF (exposant 0) → "25000.00" CDF ; 589 USD (exposant 2) → "5.89" USD.
 */
export function fromMinorUnits(minor: bigint, currency: string, table: ExponentTable): MoneyJSON {
  const exponent = exponentFor(table, currency);
  const code = currency as CurrencyCode;
  const mosoloDecimals = CURRENCIES[code].decimals;
  if (minor < 0n) notRepresentable('Montant négatif refusé.', {});
  let scaled: bigint;
  if (mosoloDecimals >= exponent) {
    scaled = minor * 10n ** BigInt(mosoloDecimals - exponent);
  } else {
    const div = 10n ** BigInt(exponent - mosoloDecimals);
    if (minor % div !== 0n) notRepresentable(`Montant ${minor} (exposant ${exponent}) non représentable en ${mosoloDecimals} décimale(s) MOSOLO.`, {});
    scaled = minor / div;
  }
  const s = scaled.toString().padStart(mosoloDecimals + 1, '0');
  const amount = mosoloDecimals > 0 ? `${s.slice(0, s.length - mosoloDecimals)}.${s.slice(s.length - mosoloDecimals)}` : s;
  return { amount, currency: code };
}
