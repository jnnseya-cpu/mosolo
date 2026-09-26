import { t, MESSAGES, LANGUAGES, type LanguageCode, type MessageKey } from '@mosolo/shared';
import { EXTRA_FR, type ExtraKey } from '../i18n-extra';

export type UIKey = MessageKey | ExtraKey;

function isSharedKey(k: string): k is MessageKey {
  return k in MESSAGES.fr;
}

/**
 * Traduit une clé d'interface : clés partagées via `t()` de @mosolo/shared
 * (repli français), clés propres au frontend via `i18n-extra.ts` (français).
 */
export function tr(lang: LanguageCode, key: UIKey, vars: Record<string, string | number> = {}): string {
  if (isSharedKey(key)) return t(lang, key, vars);
  const raw: string | undefined = (EXTRA_FR as Record<string, string>)[key];
  if (raw === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] clé manquante : ${key}`);
    return key;
  }
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

export function isDraftLanguage(lang: LanguageCode): boolean {
  return LANGUAGES[lang].status === 'brouillon';
}
