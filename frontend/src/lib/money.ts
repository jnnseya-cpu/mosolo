import { Money, parseScaled, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { ExchangeRates } from './types';

const SCALE = 12;

function scaledToString(v: bigint, scale: number): string {
  const s = v.toString().padStart(scale + 1, '0');
  return `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
}

/** 1 / rate, en chaîne décimale exacte à 12 décimales. */
export function invertRate(rate: string): string {
  const r = parseScaled(rate, SCALE);
  if (r === 0n) throw new Error('Taux nul');
  return scaledToString((10n ** BigInt(SCALE * 2)) / r, SCALE);
}

/**
 * Contre-valeur indicative (jamais une conversion de l'obligation, § 11.6.1).
 * Les taux sont exprimés en CDF pour 1 unité de devise.
 */
export function convertIndicative(m: MoneyJSON, target: CurrencyCode, rates: ExchangeRates | null): MoneyJSON | null {
  if (m.currency === target) return m;
  if (!rates) return null;
  try {
    let v = Money.fromJSON(m);
    if (m.currency !== 'CDF') {
      const r = rates.rates[m.currency];
      if (!r) return null;
      v = v.convert('CDF', r);
    }
    if (target !== 'CDF') {
      const r = rates.rates[target];
      if (!r) return null;
      v = v.convert(target, invertRate(r));
    }
    return v.toJSON();
  } catch {
    return null;
  }
}

/** Valeur numérique (pour la géométrie des graphiques uniquement — jamais pour un calcul financier). */
export function plotValue(m: MoneyJSON | number | string | undefined): number {
  if (m === undefined) return 0;
  if (typeof m === 'number') return m;
  if (typeof m === 'string') return Number(m);
  return Number(m.amount);
}

/** Libellé compact « 4,82 Md » pour axes et étiquettes. */
export function compact(n: number, lang = 'fr'): string {
  const abs = Math.abs(n);
  const fmt = (v: number, d = 2) => v.toLocaleString(lang === 'en' ? 'en-GB' : 'fr-FR', { maximumFractionDigits: d });
  if (abs >= 1e9) return `${fmt(n / 1e9)} Md`;
  if (abs >= 1e6) return `${fmt(n / 1e6, 1)} M`;
  if (abs >= 1e3) return `${fmt(n / 1e3, 1)} k`;
  return fmt(n);
}

/** Exemple de taux (source déclarée) utilisé seulement si l'API est injoignable. */
export const EXAMPLE_RATES: ExchangeRates = {
  date: '2026-09-25',
  source: 'EXEMPLE — cours indicatif BCC non importé',
  example: true,
  rates: { USD: '2850.00', EUR: '3120.00', GBP: '3690.00', CAD: '2090.00', CHF: '3350.00', ZAR: '158.00' },
};
