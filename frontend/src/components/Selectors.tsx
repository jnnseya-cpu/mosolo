import { CURRENCIES, CURRENCY_CODES, FAMILLE_DU_ROLE, FAMILLES_COMPTES, LANGUAGES, LANGUAGE_CODES, ORDRE_FAMILLES, isCurrencyCode, isLanguageCode, type LanguageCode, type RoleCode } from '@mosolo/shared';
import { useApp } from '../context';
import { hasKey, isDraftLanguage, tr } from '../lib/i18n';
import type { DemoUser } from '../lib/types';

/** Libellé court d'un utilisateur de démo (« Agent de terrain », « DG DGIPK »…), nom complet en infobulle. */
export function shortLabel(u: DemoUser, all: DemoUser[], lang: LanguageCode = 'fr'): string {
  const role = u.roles[0] ?? '';
  const key = `roleShort.${role}`;
  const base = hasKey(key) ? tr(lang, key, { entity: u.entity ?? '' }).trim() : u.name;
  const same = all.filter((x) => (x.roles[0] ?? '') === role);
  if (same.length <= 1) return base;
  if (role === 'R30' || role === 'R31') return `${base} · ${u.name.replace(/\s*\(.*\)\s*$/, '')}`;
  const terr = u.territory?.[0];
  if (terr && same.filter((x) => x.territory?.[0] === terr).length === 1) return `${base} · ${terr}`;
  return `${base} n° ${same.indexOf(u) + 1}`;
}

/** Sélecteur de langue : noms natifs uniquement, jamais de drapeau (une langue n'est pas un pays). */
export function LanguageSelector({ id = 'lang-select' }: { id?: string }) {
  const { lang, setLang, tr } = useApp();
  return (
    <div className="ctl">
      <label htmlFor={id} className="ctl-label">{tr('common.language')}</label>
      <div className="ctl-row">
        <select id={id} value={lang} onChange={(e) => isLanguageCode(e.target.value) && setLang(e.target.value)}>
          {LANGUAGE_CODES.map((c) => (
            <option key={c} value={c} lang={c}>
              {LANGUAGES[c].nativeName}{isDraftLanguage(c) ? ` (${tr('lang.draft')})` : ''}
            </option>
          ))}
        </select>
        {isDraftLanguage(lang) && <span className="tag tag-draft" title={tr('lang.draftHint')}>{tr('lang.draft')}</span>}
      </div>
    </div>
  );
}

/** Devise d'affichage : drapeau + code ISO ; franc congolais en premier (devise principale). */
export function CurrencySelector({ id = 'currency-select' }: { id?: string }) {
  const { currency, setCurrency, tr } = useApp();
  const codes = ['CDF', ...CURRENCY_CODES.filter((c) => c !== 'CDF')];
  return (
    <div className="ctl">
      <label htmlFor={id} className="ctl-label">{tr('common.currency')}</label>
      <select id={id} value={currency} onChange={(e) => isCurrencyCode(e.target.value) && setCurrency(e.target.value)}>
        {codes.map((c) => {
          const info = CURRENCIES[c as keyof typeof CURRENCIES];
          return <option key={c} value={c}>{info.flag} {c}</option>;
        })}
      </select>
    </div>
  );
}

/**
 * Comptes de démonstration regroupés par famille de comptes (27/09/2026) : autorité, régie, trésor, juridique, contrôle,
 * terrain, audit, technique, public, partenaire ; les comptes sans rôle (en attente de validation) en dernier.
 */
export function groupByFamily(users: DemoUser[]): { code: string; label: string; users: DemoUser[] }[] {
  const famille = (u: DemoUser) => FAMILLE_DU_ROLE[u.roles[0] as RoleCode] as string | undefined;
  const groups = ORDRE_FAMILLES.map((f) => ({ code: f as string, label: FAMILLES_COMPTES[f], users: users.filter((u) => famille(u) === f) }));
  const other = users.filter((u) => !famille(u));
  return [...groups, { code: 'AUTRES', label: 'Sans rôle (en attente)', users: other }].filter((g) => g.users.length > 0);
}

/** Utilisateur de démonstration (en-tête x-demo-user). */
export function DemoUserSelector({ id = 'user-select' }: { id?: string }) {
  const { users, usersError, user, setUserId, tr: t, lang } = useApp();
  return (
    <div className="ctl">
      <label htmlFor={id} className="ctl-label">{t('header.demoUser')}</label>
      <select id={id} className="user-select" value={user?.id ?? ''} title={user ? `${user.name} — ${user.roles.join(', ')}` : undefined} disabled={users.length === 0} onChange={(e) => setUserId(e.target.value)}>
        {users.length === 0 && <option value="">{usersError ? t('header.usersUnavailable') : t('common.loading')}</option>}
        {groupByFamily(users).map((g) => (
          <optgroup key={g.code} label={g.label}>
            {g.users.map((u) => (
              <option key={u.id} value={u.id} title={`${u.name} — ${u.roles.join(', ')}${u.entity ? ` · ${u.entity}` : ''}`}>{shortLabel(u, users, lang)}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
