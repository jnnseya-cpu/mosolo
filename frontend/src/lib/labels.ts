import type { LanguageCode } from '@mosolo/shared';
import { hasKey, tr } from './i18n';

/** « UNITE_LOCATIVE » → « Unité locative » (repli : casse de titre, soulignés remplacés). */
export function humanize(code: string): string {
  const s = code.replace(/[_.]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lookup(lang: LanguageCode, key: string, code: string): string {
  return hasKey(key) ? tr(lang, key) : humanize(code);
}

export const categoryLabel = (lang: LanguageCode, code: string) => lookup(lang, `objcat.${code}`, code);
export const revenueCategoryLabel = (lang: LanguageCode, code: string) => lookup(lang, `revcat.${code}`, code);
export const periodicityLabel = (lang: LanguageCode, code: string) => lookup(lang, `periodicity.${code}`, code);
export const ledgerLabel = (lang: LanguageCode, code: string) => lookup(lang, `ledger.${code}`, code);
export const levelLabel = (lang: LanguageCode, code: string) => { const k = `levelFull.${code}`; return hasKey(k) ? tr(lang, k) : code; };

/** Action d'audit → libellé français ; « rule.approved.verificateur_juridique » → « Visa de règle ». */
export function auditActionLabel(lang: LanguageCode, action: string): string {
  const parts = action.split('.');
  for (let n = parts.length; n >= 2; n--) {
    const k = `audit.action.${parts.slice(0, n).join('.')}`;
    if (hasKey(k)) return tr(lang, k);
  }
  return action;
}
