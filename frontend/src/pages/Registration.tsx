import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LANGUAGES, LANGUAGE_CODES, RESIDENTIAL_SITUATIONS, isLanguageCode, type ResidentialSituation } from '@mosolo/shared';
import { useApp } from '../context';
import { useAutosave } from '../hooks/useAutosave';
import { AutosaveBar } from '../components/VersionHistory';
import { CoverSplit } from '../components/Split';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import { api, describeError, safeSet } from '../lib/api';
import { isDraftLanguage, type UIKey } from '../lib/i18n';
import type { RegistrationInput, RegistrationResult } from '../lib/types';

const PHONE_RE = /^\+?243\s?[0-9 ]{9,12}$|^0[0-9 ]{9,11}$/;

export default function Registration() {
  const { tr, lang } = useApp();
  const draft = useAutosave<RegistrationInput>('registration', { phone: '', fullName: '', language: lang, situation: '' });
  const v = draft.value;
  const [errors, setErrors] = useState<Partial<Record<keyof RegistrationInput, string>>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RegistrationResult | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const set = <K extends keyof RegistrationInput>(k: K, val: RegistrationInput[K]) => draft.setValue((p) => ({ ...p, [k]: val }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!PHONE_RE.test(v.phone.trim())) errs.phone = tr('reg.err.phone');
    if (v.fullName.trim().length < 3) errs.fullName = tr('reg.err.name');
    if (!v.situation) errs.situation = tr('reg.err.situation');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setApiError(null);
    try {
      const r = await api<RegistrationResult>('/v1/registrations', { method: 'POST', body: { ...v, phone: v.phone.replace(/\s/g, ''), fullName: v.fullName.trim() } });
      setResult(r);
      safeSet('mosolo.taxpayerId', r.taxpayerId);
      draft.reset();
    } catch (err) {
      setApiError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-flush">
      <CoverSplit>
        <div className="form-card">
          <p className="eyebrow">{tr('nav.register')}</p>
          <h1>{tr('taxpayer.register')}</h1>
          <p className="lead">{tr('reg.lead')}</p>
          <div className="callout callout-info">
            <Icon name="info" size={18} />
            <p>{tr('reg.notProof')}</p>
          </div>

          {result ? (
            <div className="result-card" role="status">
              <StatusBadge tone="good" label={tr('reg.done')} />
              <dl className="kv">
                <div><dt>{tr('reg.iuc')}</dt><dd className="mono">{result.iuc}</dd></div>
                <div><dt>{tr('reg.taxpayerId')}</dt><dd className="mono">{result.taxpayerId}</dd></div>
                <div><dt>{tr('reg.level')}</dt><dd>{result.verificationLevel} — {tr(`level.${result.verificationLevel}` as UIKey)}</dd></div>
              </dl>
              <p className="small muted">{tr('reg.next')}</p>
              <Link className="btn btn-primary" to="/espace">{tr('home.cta.space')}</Link>
            </div>
          ) : (
            <form onSubmit={(e) => void submit(e)} noValidate className="form">
              <div className="field">
                <label htmlFor="reg-phone" className="label">{tr('taxpayer.phone')}</label>
                <input id="reg-phone" type="tel" inputMode="tel" autoComplete="tel" value={v.phone} placeholder="+243 81 234 5678"
                  onChange={(e) => set('phone', e.target.value)} aria-invalid={!!errors.phone} aria-describedby="reg-phone-hint reg-phone-err" />
                <span id="reg-phone-hint" className="hint">{tr('reg.phoneHint')}</span>
                {errors.phone && <span id="reg-phone-err" className="err">{errors.phone}</span>}
              </div>
              <div className="field">
                <label htmlFor="reg-name" className="label">{tr('taxpayer.fullName')}</label>
                <input id="reg-name" autoComplete="name" value={v.fullName} onChange={(e) => set('fullName', e.target.value)}
                  aria-invalid={!!errors.fullName} aria-describedby="reg-name-err" />
                {errors.fullName && <span id="reg-name-err" className="err">{errors.fullName}</span>}
              </div>
              <div className="field">
                <label htmlFor="reg-lang" className="label">{tr('reg.language')}</label>
                <select id="reg-lang" value={v.language} onChange={(e) => isLanguageCode(e.target.value) && set('language', e.target.value)}>
                  {LANGUAGE_CODES.map((c) => (
                    <option key={c} value={c} lang={c}>{LANGUAGES[c].nativeName}{isDraftLanguage(c) ? ` (${tr('lang.draft')})` : ''}</option>
                  ))}
                </select>
                <span className="hint">{tr('reg.langHint')}</span>
              </div>
              <fieldset className="field" aria-describedby={errors.situation ? 'reg-sit-err' : undefined}>
                <legend className="label">{tr('reg.situationQuestion')}</legend>
                <div className="radio-list">
                  {RESIDENTIAL_SITUATIONS.map((s) => (
                    <label key={s} className={`radio ${v.situation === s ? 'checked' : ''}`}>
                      <input type="radio" name="situation" value={s} checked={v.situation === s} onChange={() => set('situation', s as ResidentialSituation)} />
                      <span>{tr(`situation.${s}` as UIKey)}</span>
                    </label>
                  ))}
                </div>
                {errors.situation && <span id="reg-sit-err" className="err">{errors.situation}</span>}
              </fieldset>
              <AutosaveBar draft={draft} />
              {apiError && <p className="notice notice-err" role="alert">{apiError}</p>}
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? tr('common.sending') : tr('taxpayer.register')}</button>
              <p className="small muted">{tr('reg.privacy')}</p>
            </form>
          )}
        </div>
      </CoverSplit>
    </div>
  );
}
