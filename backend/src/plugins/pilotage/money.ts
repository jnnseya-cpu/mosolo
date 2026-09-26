/** Agrégation monétaire exacte (BigInt via Money) : un total par devise, jamais de mélange ni de flottant. */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';

export class CurrencyTotals {
  private readonly totals = new Map<CurrencyCode, Money>();

  add(m: MoneyJSON): this {
    const v = Money.fromJSON(m);
    const cur = this.totals.get(v.currency);
    this.totals.set(v.currency, cur ? cur.add(v) : v);
    return this;
  }

  get empty(): boolean {
    return this.totals.size === 0;
  }

  currencies(): CurrencyCode[] {
    return [...this.totals.keys()].sort();
  }

  get(c: CurrencyCode): Money | undefined {
    return this.totals.get(c);
  }

  toJSON(): MoneyJSON[] {
    return this.currencies().map((c) => this.totals.get(c)!.toJSON());
  }

  /** Contre-valeur INDICATIVE consolidée en CDF (taux officiel du jour) — jamais un montant légal. */
  consolidated(convert: (m: MoneyJSON) => MoneyJSON): MoneyJSON {
    let acc = Money.zero('CDF');
    for (const m of this.toJSON()) acc = acc.add(Money.fromJSON(m.currency === 'CDF' ? m : convert(m)));
    return acc.toJSON();
  }
}

export function totalsOf(items: MoneyJSON[]): CurrencyTotals {
  const t = new CurrencyTotals();
  for (const m of items) t.add(m);
  return t;
}

/** Ratio en pourcentage, une décimale, arithmétique entière (demi-supérieur). */
export function pct(num: number, den: number): string | null {
  if (den <= 0) return null;
  const n = BigInt(num) * 1000n;
  const d = BigInt(den);
  const q = (n * 2n + d) / (2n * d); // arrondi au plus proche
  return `${q / 10n}.${q % 10n}`;
}

/** Durée moyenne en heures (une décimale) à partir de millisecondes entières. */
export function hoursOf(ms: number): string {
  const tenths = BigInt(Math.round(ms / 360_000));
  return `${tenths / 10n}.${(tenths < 0n ? -tenths : tenths) % 10n}`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
