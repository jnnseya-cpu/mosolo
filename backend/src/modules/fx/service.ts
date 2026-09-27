/**
 * Taux de change officiels (module 89). DÉMONSTRATION : cours fixes déclarés « BCC (démo) ».
 * En production : import quotidien signé du cours indicatif de la Banque Centrale du Congo, jamais saisi à la main.
 */
import { CURRENCIES, CURRENCY_CODES, Money, PRIMARY_CURRENCY, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { Clock } from '../../core/clock.js';
import { kinshasaDate } from '../../core/clock.js';
import { divideDecimalStrings } from '../../core/decimal.js';
import { badRequest, notFound } from '../../core/errors.js';

export const FX_SOURCE = 'BCC (démo)';
/** Premier jour couvert par le jeu de taux de démonstration. */
export const FX_FIRST_DATE = '2024-01-01';

/** Francs congolais pour une unité de devise — valeurs de DÉMONSTRATION, non officielles. */
const DEMO_CDF_PER_UNIT: Record<CurrencyCode, string> = {
  CDF: '1', USD: '2850', EUR: '3100', GBP: '3620', CAD: '2080', CHF: '3230', ZAR: '158',
  XAF: '4.73', AOA: '3.12', ZMW: '104', RWF: '2.02', UGX: '0.77', KES: '22.05', TZS: '1.07',
  BIF: '0.97', CNY: '396', AED: '776',
};

export interface FxRate {
  currency: CurrencyCode;
  flag: string;
  name: string;
  cdfPerUnit: string;
}

export interface FxConversion {
  amount: MoneyJSON;
  rate: string;
  rateDate: string;
  source: string;
  indicative: true;
  demo: boolean;
}

export class FxService {
  constructor(private readonly clock: Clock) {}

  private assertDate(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
      throw badRequest('INVALID_DATE', `Date invalide : ${date} (format AAAA-MM-JJ attendu).`);
    }
    if (date < FX_FIRST_DATE || date > kinshasaDate(this.clock.now())) {
      throw notFound('FX_RATE_MISSING', `Aucun taux officiel publié pour le ${date}.`);
    }
  }

  ratesFor(date: string) {
    this.assertDate(date);
    return {
      date,
      base: PRIMARY_CURRENCY,
      source: FX_SOURCE,
      demo: true,
      note: 'Taux de démonstration — la règle fixant le taux applicable (fait générateur, avis, paiement) est une règle juridique [À VÉRIFIER].',
      rates: CURRENCY_CODES.map((c) => ({ currency: c, flag: CURRENCIES[c].flag, name: CURRENCIES[c].name, cdfPerUnit: DEMO_CDF_PER_UNIT[c] })),
    };
  }

  /** Taux « 1 unité de `from` = x unités de `to` » à la date donnée. */
  rate(from: CurrencyCode, to: CurrencyCode, date: string): string {
    this.assertDate(date);
    if (from === to) return '1';
    const a = DEMO_CDF_PER_UNIT[from];
    const b = DEMO_CDF_PER_UNIT[to];
    if (!a || !b) throw notFound('FX_RATE_MISSING', `Taux ${from}/${to} indisponible au ${date}.`);
    if (to === 'CDF') return a;
    return divideDecimalStrings(a, b);
  }

  /** Contre-valeur indicative (n'altère jamais la devise légale d'une obligation). */
  convert(money: MoneyJSON, to: CurrencyCode, date: string = kinshasaDate(this.clock.now())): FxConversion {
    const rate = this.rate(money.currency, to, date);
    return {
      amount: Money.fromJSON(money).convert(to, rate).toJSON(),
      rate,
      rateDate: date,
      source: FX_SOURCE,
      indicative: true,
      demo: true,
    };
  }
}
