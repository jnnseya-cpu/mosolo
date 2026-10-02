import { CURRENCIES, CURRENCY_CODES, FAMILLE_DU_ROLE, FAMILLES_COMPTES, LANGUAGES, LANGUAGE_CODES, ORDRE_FAMILLES, isCurrencyCode, isLanguageCode, type LanguageCode, type RoleCode } from '@mosolo/shared';
import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { api } from '../lib/api';
import { TraducteurEcran } from '../lib/traductionAuto';
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
        {/* Noms natifs, jamais traduits ; mention « brouillon » conservée ; l'avis précise « traduction automatique ». */}
        <select id={id} value={lang} translate="no" data-no-translate onChange={(e) => isLanguageCode(e.target.value) && setLang(e.target.value)}
          title={LANGUAGE_CODES.some(isDraftLanguage) ? tr('lang.draftHint') : undefined}>
          {LANGUAGE_CODES.map((c) => (
            <option key={c} value={c} lang={c}>{LANGUAGES[c].nativeName}{isDraftLanguage(c) ? ` (${tr('lang.draft')})` : ''}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Langue de l'interface (30/09/2026) : l'interface est rédigée en français (version qui fait foi). Une autre langue
 * choisie déclenche la TRADUCTION AUTOMATIQUE de tout l'écran (Google Cloud Translation, par le serveur) avec la
 * mention « traduction automatique » et un retour au français en un clic. Service non configuré : avis clair, l'écran
 * reste en français et la langue choisie sert aux SMS et notifications.
 */
export function AvisLangue() {
  const { lang, setLang, user } = useApp();
  const [etat, setEtat] = useState<'verif' | 'actif' | 'indisponible' | 'erreur'>('verif');
  const [diag, setDiag] = useState<{ cause: string; remede: string[] } | null>(null);
  const admin = !!user?.roles.some((r) => r === 'R26' || r === 'R28');
  useEffect(() => {
    if (lang === 'fr') return;
    let traducteur: TraducteurEcran | null = null;
    let annule = false;
    setEtat('verif');
    void api<{ disponible: boolean }>('/v1/traduction/etat').then((e) => {
      if (annule) return;
      if (!e.disponible) { setEtat('indisponible'); return; }
      traducteur = new TraducteurEcran(lang);
      traducteur.onErreur = () => {
        setEtat('erreur');
        // Diagnostic lisible (cause et remède) donné par le serveur — 01/10/2026.
        void api<{ diagnostic: { cause: string; remede: string[] } | null }>('/v1/traduction/etat').then((x) => setDiag(x.diagnostic)).catch(() => undefined);
      };
      traducteur.demarrer();
      setEtat('actif');
    }).catch(() => { if (!annule) setEtat('indisponible'); });
    return () => { annule = true; traducteur?.arreter(); };
  }, [lang]);
  if (lang === 'fr') return null;
  return (
    <div className="callout callout-info avis-langue" role="status" data-testid="avis-langue">
      <span>
        <strong translate="no">{LANGUAGES[lang].nativeName}</strong>{' '}
        {etat === 'actif' ? ': traduction automatique de l’écran — la version française fait foi.'
          : etat === 'verif' ? ': traduction en cours…'
            : etat === 'erreur' ? `: service de traduction indisponible — certains textes restent en français.${diag ? ` Cause : ${diag.cause}` : ''}`
              : ': traduction automatique non configurée sur ce serveur — l’interface reste en français ; vos SMS et notifications sont envoyés dans cette langue.'}
      </span>
      {etat === 'erreur' && diag && admin && (
        <details className="small" translate="no" data-no-translate>
          <summary>Remède (administration)</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{diag.remede.join('\n')}</pre>
        </details>
      )}
      <button type="button" className="btn btn-secondary btn-sm" translate="no" data-no-translate onClick={() => setLang('fr')}>Afficher en français</button>
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
