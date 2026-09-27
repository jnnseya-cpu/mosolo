/**
 * Montants monétaires exacts (jamais de virgule flottante).
 * Un montant est un entier d'unités mineures (BigInt) associé à un code ISO 4217.
 * Toute opération entre devises différentes sans conversion explicite est refusée.
 */
import { CURRENCIES, type CurrencyCode, PRIMARY_CURRENCY } from './currencies.js';

export interface MoneyJSON {
  /** Montant décimal sous forme de chaîne, ex. "1250000.00" */
  amount: string;
  currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Opération interdite entre ${a} et ${b} sans conversion explicite`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Montant portant plus de décimales que la devise n'en admet : refusé, jamais arrondi (frontières monétaires). */
export class AmountPrecisionError extends Error {
  constructor(amount: string, currency: CurrencyCode, decimals: number) {
    super(`Montant ${amount} ${currency} : au plus ${decimals} décimale(s) admise(s), aucun arrondi n'est appliqué`);
    this.name = 'AmountPrecisionError';
  }
}

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

function decimalsOf(c: CurrencyCode): number {
  return CURRENCIES[c].decimals;
}

/** Divise n par d (d > 0) en arrondissant selon le mode. */
function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d <= 0n) throw new Error('Diviseur invalide');
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  const r = a % d;
  if (r !== 0n) {
    const twice = r * 2n;
    switch (mode) {
      case 'DOWN':
        break;
      case 'UP':
        q += 1n;
        break;
      case 'HALF_UP':
        if (twice >= d) q += 1n;
        break;
      case 'HALF_EVEN':
        if (twice > d || (twice === d && q % 2n === 1n)) q += 1n;
        break;
    }
  }
  return neg ? -q : q;
}

/** Parse une chaîne décimale en entier mis à l'échelle `scale` (arrondi HALF_UP au-delà). */
export function parseScaled(value: string, scale: number, mode: RoundingMode = 'HALF_UP'): bigint {
  const s = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Montant décimal invalide : "${value}"`);
  const neg = s.startsWith('-');
  const [intPart, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const digits = BigInt((intPart ?? '0') + frac.padEnd(Math.max(scale, frac.length), '0'));
  const extra = Math.max(0, frac.length - scale);
  const scaled = extra > 0 ? divRound(digits, 10n ** BigInt(extra), mode) : digits;
  return neg ? -scaled : scaled;
}

function formatScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(scale + 1, '0');
  const int = a.slice(0, a.length - scale) || '0';
  const frac = scale > 0 ? '.' + a.slice(a.length - scale) : '';
  return (neg ? '-' : '') + int + frac;
}

export class Money {
  private constructor(
    /** Unités mineures */
    readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {}

  static of(amount: string | number, currency: CurrencyCode, mode: RoundingMode = 'HALF_UP'): Money {
    if (!(currency in CURRENCIES)) throw new Error(`Devise inconnue : ${currency}`);
    const str = typeof amount === 'number' ? amountFromNumber(amount) : amount;
    return new Money(parseScaled(str, decimalsOf(currency), mode), currency);
  }

  static fromMinor(minor: bigint, currency: CurrencyCode): Money {
    return new Money(minor, currency);
  }

  static zero(currency: CurrencyCode = PRIMARY_CURRENCY): Money {
    return new Money(0n, currency);
  }

  static fromJSON(j: MoneyJSON): Money {
    return Money.of(j.amount, j.currency);
  }

  /**
   * Lecture STRICTE d'un montant reçu à une frontière monétaire (rappel ou webhook prestataire, relevé bancaire) :
   * aucun arrondi. Chaîne décimale positive ou nulle, devise connue, et jamais plus de décimales significatives que
   * la devise n'en admet (« 149.995 » USD est refusé, il n'est pas lu 150.00). Des zéros finals (« 150.000 ») sont
   * exacts et acceptés. Lève `AmountPrecisionError` (précision) ou `Error` (format, devise).
   */
  static parseStrict(j: { amount: string; currency: string }): Money {
    if (typeof j?.currency !== 'string' || !(j.currency in CURRENCIES)) throw new Error(`Devise inconnue : ${String(j?.currency)}`);
    const currency = j.currency as CurrencyCode;
    const s = typeof j.amount === 'string' ? j.amount.trim() : '';
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Montant décimal invalide : "${String(j.amount)}"`);
    const frac = s.split('.')[1] ?? '';
    const dec = decimalsOf(currency);
    if (frac.length > dec && /[1-9]/.test(frac.slice(dec))) throw new AmountPrecisionError(s, currency, dec);
    return new Money(parseScaled(s, dec, 'DOWN'), currency);
  }

  toJSON(): MoneyJSON {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  toDecimalString(): string {
    return formatScaled(this.minor, decimalsOf(this.currency));
  }

  private same(o: Money): void {
    if (o.currency !== this.currency) throw new CurrencyMismatchError(this.currency, o.currency);
  }

  add(o: Money): Money {
    this.same(o);
    return new Money(this.minor + o.minor, this.currency);
  }

  subtract(o: Money): Money {
    this.same(o);
    return new Money(this.minor - o.minor, this.currency);
  }

  /** Multiplie par un taux décimal exprimé en chaîne (ex. "0.22"). */
  multiply(rate: string, mode: RoundingMode = 'HALF_UP'): Money {
    const scale = 12;
    const r = parseScaled(rate, scale);
    return new Money(divRound(this.minor * r, 10n ** BigInt(scale), mode), this.currency);
  }

  /** Applique un pourcentage exprimé en chaîne (ex. "22" pour 22 %). */
  percent(pct: string, mode: RoundingMode = 'HALF_UP'): Money {
    const scale = 12;
    const p = parseScaled(pct, scale);
    return new Money(divRound(this.minor * p, 100n * 10n ** BigInt(scale), mode), this.currency);
  }

  /**
   * Convertit vers une autre devise au taux officiel `rate`
   * (1 unité de la devise source = `rate` unités de la devise cible).
   */
  convert(target: CurrencyCode, rate: string, mode: RoundingMode = 'HALF_UP'): Money {
    if (target === this.currency) return this;
    const scale = 12;
    const r = parseScaled(rate, scale);
    const fromDec = BigInt(decimalsOf(this.currency));
    const toDec = BigInt(decimalsOf(target));
    // minor_cible = minor_source × r × 10^toDec / (10^fromDec × 10^scale)
    const num = this.minor * r * 10n ** toDec;
    const den = 10n ** fromDec * 10n ** BigInt(scale);
    return new Money(divRound(num, den, mode), target);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }
  compare(o: Money): -1 | 0 | 1 {
    this.same(o);
    return this.minor < o.minor ? -1 : this.minor > o.minor ? 1 : 0;
  }
  equals(o: Money): boolean {
    return this.currency === o.currency && this.minor === o.minor;
  }
  negate(): Money {
    return new Money(-this.minor, this.currency);
  }
}

function amountFromNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error('Montant non fini');
  // Les nombres sont acceptés uniquement pour les littéraux simples ; préférer les chaînes.
  return n.toFixed(6);
}

export function sum(items: Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
}
