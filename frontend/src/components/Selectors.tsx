import { CURRENCIES, CURRENCY_CODES, LANGUAGES, LANGUAGE_CODES, isCurrencyCode, isLanguageCode } from '@mosolo/shared';
import { useApp } from '../context';
import { isDraftLanguage } from '../lib/i18n';

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

/** Utilisateur de démonstration (en-tête x-demo-user). */
export function DemoUserSelector({ id = 'user-select' }: { id?: string }) {
  const { users, usersError, user, setUserId, tr } = useApp();
  return (
    <div className="ctl">
      <label htmlFor={id} className="ctl-label">{tr('header.demoUser')}</label>
      <select id={id} value={user?.id ?? ''} disabled={users.length === 0} onChange={(e) => setUserId(e.target.value)}>
        {users.length === 0 && <option value="">{usersError ? tr('header.usersUnavailable') : tr('common.loading')}</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} — {u.roles.join(', ')}{u.entity ? ` · ${u.entity}` : ''}</option>
        ))}
      </select>
    </div>
  );
}
