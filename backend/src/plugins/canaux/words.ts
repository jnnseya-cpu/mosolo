/**
 * Montants énoncés en toutes lettres pour le SVI (§ 11.6.3) : « cent cinquante dollars américains ».
 * Calcul exact sur chaîne décimale (BigInt), jamais de nombre flottant. Français (langue de référence) ;
 * les autres langues passent par l'audio pré-enregistré validé (§ 11.5).
 */
import type { MoneyJSON } from '@mosolo/shared';

const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

function below100(n: number): string {
  if (n <= 16) return UNITS[n]!;
  if (n < 20) return `dix-${UNITS[n - 10]!}`;
  if (n < 70) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (u === 0) return TENS[t]!;
    if (u === 1) return `${TENS[t]!} et un`;
    return `${TENS[t]!}-${UNITS[u]!}`;
  }
  if (n < 80) return n === 71 ? 'soixante et onze' : `soixante-${below100(n - 60)}`;
  if (n === 80) return 'quatre-vingts';
  return `quatre-vingt-${below100(n - 80)}`;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = h === 0 ? '' : h === 1 ? 'cent' : `${UNITS[h]!} cent${r === 0 ? 's' : ''}`;
  if (r === 0) return head || 'zéro';
  return head ? `${head} ${below100(r)}` : below100(r);
}

/** Entier positif en toutes lettres (orthographe traditionnelle, jusqu'aux milliards). */
export function integerToFrenchWords(value: bigint): string {
  if (value === 0n) return 'zéro';
  const parts: string[] = [];
  const scales: [bigint, string, string][] = [
    [1_000_000_000n, 'milliard', 'milliards'],
    [1_000_000n, 'million', 'millions'],
  ];
  let rest = value;
  for (const [size, one, many] of scales) {
    const q = rest / size;
    if (q > 0n) {
      parts.push(`${q === 1n ? 'un' : integerToFrenchWords(q)} ${q === 1n ? one : many}`);
      rest %= size;
    }
  }
  const thousands = Number(rest / 1000n);
  const units = Number(rest % 1000n);
  if (thousands > 0) parts.push(thousands === 1 ? 'mille' : `${below1000(thousands).replace(/cents$/, 'cent').replace(/vingts$/, 'vingt')} mille`);
  if (units > 0) parts.push(below1000(units));
  return parts.join(' ');
}

const CURRENCY_WORDS: Record<string, [string, string, string]> = {
  USD: ['dollar américain', 'dollars américains', 'cent'],
  CDF: ['franc congolais', 'francs congolais', 'centime'],
  EUR: ['euro', 'euros', 'centime'],
};

/** « 150.00 USD » → « cent cinquante dollars américains » ; « 12.50 USD » → « douze dollars américains et cinquante cents ». */
export function moneyToFrenchWords(m: MoneyJSON): string {
  const [intPart = '0', frac = ''] = m.amount.split('.');
  const major = BigInt(intPart);
  const minor = Number((frac + '00').slice(0, 2));
  const [one, many, sub] = CURRENCY_WORDS[m.currency] ?? [m.currency, m.currency, 'centième'];
  const head = `${integerToFrenchWords(major)} ${major === 1n ? one : many}`;
  if (minor === 0) return head;
  return `${head} et ${integerToFrenchWords(BigInt(minor))} ${sub}${minor > 1 ? 's' : ''}`;
}
