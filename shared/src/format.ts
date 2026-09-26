/** Formatage d'affichage des montants : drapeau + code ISO + montant localisé (§ 11.6.3). */
import { CURRENCIES, type CurrencyCode } from './currencies.js';
import type { MoneyJSON } from './money.js';

function groupDigits(int: string, sep: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/**
 * Formate un montant sans passer par Number (pas de perte de précision).
 * style 'rich' : "🇨🇩 CDF 1 250 000,00" ; 'plain' (SMS/USSD) : "CDF 1250000".
 */
export function formatMoney(m: MoneyJSON, opts: { locale?: 'fr' | 'en'; style?: 'rich' | 'plain' } = {}): string {
  const { locale = 'fr', style = 'rich' } = opts;
  const info = CURRENCIES[m.currency as CurrencyCode];
  const neg = m.amount.startsWith('-');
  const [int = '0', frac = ''] = (neg ? m.amount.slice(1) : m.amount).split('.');
  if (style === 'plain') return `${m.currency} ${neg ? '-' : ''}${int}${frac && /[1-9]/.test(frac) ? '.' + frac : ''}`;
  const sep = locale === 'fr' ? ' ' : ',';
  const dec = locale === 'fr' ? ',' : '.';
  const body = groupDigits(int, sep) + (info.decimals > 0 ? dec + frac.padEnd(info.decimals, '0').slice(0, info.decimals) : '');
  return `${info.flag} ${m.currency} ${neg ? '-' : ''}${body}`;
}
