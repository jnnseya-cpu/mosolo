/**
 * Plateforme multilingue.
 * Le français est la langue de référence : seule version juridiquement opposable.
 * Les langues sont désignées par leur nom natif, jamais par un drapeau.
 *
 * Statut des traductions : seules les chaînes françaises sont validées.
 * Les autres langues sont des BROUILLONS à faire valider par des relecteurs natifs
 * (chapitre 11.5 du document maître) avant activation en production.
 */
import { fr, type MessageKey } from './fr.js';
import { ln } from './ln.js';
import { sw } from './sw.js';
import { kg } from './kg.js';
import { lua } from './lua.js';
import { en } from './en.js';

export type { MessageKey };

export const LANGUAGES = {
  fr: { code: 'fr', name: 'Français', nativeName: 'Français', role: 'reference', status: 'valide' },
  ln: { code: 'ln', name: 'Lingala', nativeName: 'Lingála', role: 'nationale', status: 'brouillon' },
  sw: { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', role: 'nationale', status: 'brouillon' },
  kg: { code: 'kg', name: 'Kikongo', nativeName: 'Kikongo', role: 'nationale', status: 'brouillon' },
  lua: { code: 'lua', name: 'Tshiluba', nativeName: 'Tshilubà', role: 'nationale', status: 'brouillon' },
  en: { code: 'en', name: 'Anglais', nativeName: 'English', role: 'diaspora_investisseurs', status: 'brouillon' },
} as const;

export type LanguageCode = keyof typeof LANGUAGES;
export const REFERENCE_LANGUAGE: LanguageCode = 'fr';
export const LANGUAGE_CODES = Object.keys(LANGUAGES) as LanguageCode[];

export const MESSAGES: Record<LanguageCode, Partial<Record<MessageKey, string>>> = { fr, ln, sw, kg, lua, en };

export function isLanguageCode(v: string): v is LanguageCode {
  return v in LANGUAGES;
}

/** Traduit une clé ; repli sur le français si la traduction manque. Variables {{nom}}. */
export function t(lang: LanguageCode, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const raw = MESSAGES[lang][key] ?? fr[key];
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

/** Taux de complétude d'une langue (pourcentage de clés traduites). */
export function completeness(lang: LanguageCode): number {
  const keys = Object.keys(fr) as MessageKey[];
  const done = keys.filter((k) => MESSAGES[lang][k] !== undefined).length;
  return Math.round((done / keys.length) * 100);
}

/** Locale Intl utilisée pour le formatage des nombres et des dates. */
export function intlLocale(lang: LanguageCode): string {
  // Les langues nationales utilisent les conventions numériques françaises de la RDC.
  return lang === 'en' ? 'en-GB' : 'fr-CD';
}
