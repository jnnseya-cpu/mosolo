import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LANGUAGES, LANGUAGE_CODES, RESIDENTIAL_SITUATIONS, isLanguageCode, type LanguageCode, type ResidentialSituation } from '@mosolo/shared';
import { useApp } from '../context';
import { useAutosave } from '../hooks/useAutosave';
import { AutosaveBar } from '../components/VersionHistory';
import { CoverSplit } from '../components/Split';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import { api, describeError, safeSet } from '../lib/api';
import { isDraftLanguage, type UIKey } from '../lib/i18n';
import { levelLabel } from '../lib/labels';
import type { RegistrationInput, RegistrationResult } from '../lib/types';
import '../modules/acces/acces.css';
import { useApi } from '../hooks/useApi';
import { asList } from '../lib/api';
import { PiecesEnAttenteVisuel } from './visuels';

/** Rôles habilités à revoir les pièces d'identité (politique ACCES.proofReview du serveur). */
const REVUE_PIECES = ['R06', 'R07', 'R11', 'R12'];
const TYPE_PIECE: Record<string, string> = {
  OTP_TELEPHONE: 'Code à usage unique (téléphone)', PIECE_IDENTITE: 'Pièce d’identité', ADRESSE: 'Adresse', CONTROLE_DOCUMENTAIRE: 'Contrôle documentaire', VISITE_TERRAIN: 'Visite de terrain',
  NIF: 'NIF', RCCM: 'RCCM', ID_NAT: 'Identification nationale', MANDAT_NOTARIE: 'Mandat notarié', ENROLEMENT_ASSISTE: 'Enrôlement assisté',
};

/** Guichet : registre des pièces en attente de revue, en graphique, avec lien vers le registre d'identité. */
function RegistreGuichet() {
  const { lang } = useApp();
  const q = useApi(async () => asList<{ type: string; status: string; taxpayer?: { verificationLevel?: string } }>(await api<unknown>('/v1/acces/identity-proofs')), []);
  return (
    <section className="section viz-section" aria-labelledby="reg-guichet">
      <div className="section-head"><h2 id="reg-guichet">Guichet : pièces en attente de revue</h2>{q.data && <span className="count">{q.data.length}</span>}
        <Link className="btn btn-secondary btn-sm" to="/acces/identite"><Icon name="user" size={16} /> Ouvrir le registre d’identité</Link></div>
      {q.error ? <p className="notice notice-err" role="alert">{describeError(q.error).message}</p> : q.loading ? null : (
        <PiecesEnAttenteVisuel items={q.data ?? []} typeLabel={(t) => TYPE_PIECE[t] ?? t} niveauLabel={(n) => (n ? levelLabel(lang, n) : 'Non renseigné')} />
      )}
    </section>
  );
}

const PHONE_RE = /^\+?243\s?[0-9 ]{9,12}$|^0[0-9 ]{9,11}$/;
const FORMS: [string, string][] = [
  ['SARL', 'SARL'], ['SA', 'SA'], ['SAS', 'SAS'], ['SNC', 'SNC'], ['ETS', 'Établissement (ETS)'], ['ASBL', 'ASBL / association'],
  ['COOPERATIVE', 'Coopérative'], ['INSTITUTION_PUBLIQUE', 'Institution publique'], ['AUTRE', 'Autre'],
];
/** Échelle de vérification (§ 9.2) : preuves exigées et droits ouverts. */
const LADDER: { code: string; label: string; proof: string; rights: string }[] = [
  { code: 'N0', label: 'N0 — déclaratif', proof: 'Téléphone vérifié par code à usage unique', rights: 'Consulter, simuler, signaler, payer une référence reçue' },
  { code: 'N1', label: 'N1 — identifié', proof: 'Pièce d’identité contrôlée et adresse déclarée', rights: 'Déclarer des objets, recevoir des obligations, obtenir des quittances, désigner un mandataire de confiance' },
  { code: 'N2', label: 'N2 — vérifié', proof: 'Contrôle documentaire ou visite de terrain', rights: 'Objets de forte valeur, contestation formelle' },
  { code: 'N3', label: 'N3 — certifié', proof: 'NIF vérifié ; RCCM pour les personnes morales ; mandat écrit ou notarié', rights: 'Opérations d’entreprise, mandat de tiers, quitus fiscal' },
];
const ORDER: Record<string, number> = { N0: 0, N0A: 0, N1: 1, N2: 2, N3: 3 };

type Profile = 'PP' | 'PM';
interface OrgInput {
  raisonSociale: string; forme: string; rccm: string; idNat: string; nif: string; phone: string; email: string; language: LanguageCode;
  repName: string; repFonction: string; repHabilitation: 'DIRIGEANT' | 'MANDATAIRE_HABILITE'; declarantSame: boolean; declName: string; declFonction: string;
}
interface Done extends RegistrationResult { kind: Profile; phone: string; phoneVerified: boolean }

function Ladder({ level, verified }: { level: string; verified: boolean }) {
  return (
    <ol className="ac-ladder" aria-label="Niveaux de vérification">
      {LADDER.map((l) => {
        const reached = l.code === 'N0' ? verified || ORDER[level]! > 0 : ORDER[level]! >= ORDER[l.code]!;
        const current = l.code === (level === 'N0A' ? 'N0' : level);
        return (
          <li key={l.code} className={`${reached ? 'reached' : ''} ${current ? 'current' : ''}`}>
            <span className="ac-lvl">{l.code}</span>
            <div className="min0"><p className="row-title">{l.label}{current ? ' · votre niveau' : ''}</p><p className="small muted">{l.proof}</p><p className="small">{l.rights}</p></div>
          </li>
        );
      })}
    </ol>
  );
}

function OtpStep({ done, onVerified }: { done: Done; onVerified: (level: string) => void }) {
  const [challenge, setChallenge] = useState<{ challengeId: string; expiresAt: string; destinationMasked: string; sandbox: boolean } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sms, setSms] = useState<string | null>(null);
  async function send() {
    setBusy(true); setErr(null);
    try { setChallenge(await api(`/v1/acces/identity/${done.taxpayerId}/otp`, { method: 'POST', body: {} })); } catch (e) { setErr(describeError(e).message); } finally { setBusy(false); }
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ verificationLevel: string }>(`/v1/acces/identity/${done.taxpayerId}/otp/verify`, { method: 'POST', body: { challengeId: challenge.challengeId, code } });
      onVerified(r.verificationLevel);
    } catch (e2) { setErr(describeError(e2).message); } finally { setBusy(false); }
  }
  async function readSms() {
    try {
      const r = await api<{ items: { text: string }[] }>(`/v1/acces/sandbox/outbox?to=${encodeURIComponent(done.phone)}`);
      setSms(r.items[0]?.text ?? 'Aucun message.');
    } catch (e) { setSms(describeError(e).message); }
  }
  return (
    <div className="ac-inline-form">
      <p className="ac-section-title"><Icon name="phone" size={16} /> Vérifier mon téléphone</p>
      <p className="small">Un code à usage unique, valable 5 minutes, est envoyé par SMS. Personne — ni agent, ni guichet — ne doit vous le demander.</p>
      {!challenge ? (
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={busy}><Icon name="send" size={18} /> Recevoir le code</button>
      ) : (
        <form className="form" onSubmit={(e) => void verify(e)}>
          <div className="field">
            <label className="label" htmlFor="otp-code">Code reçu au {challenge.destinationMasked}</label>
            <input id="otp-code" className="mono ac-code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>Valider</button>
            <button type="button" className="btn btn-ghost" onClick={() => void send()} disabled={busy}>Renvoyer</button>
          </div>
          {challenge.sandbox && (
            <div className="ac-sandbox">
              <p className="small muted">Démonstration : aucun SMS réel n’est envoyé. Le message est consultable dans le bac à sable (jamais en production).</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void readSms()}>Afficher le SMS simulé</button>
              {sms && <p className="ac-sms">{sms}</p>}
            </div>
          )}
        </form>
      )}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </div>
  );
}

export default function Registration() {
  const { tr, lang, user } = useApp();
  const [profile, setProfile] = useState<Profile>('PP');
  const draft = useAutosave<RegistrationInput>('registration', { phone: '', fullName: '', language: lang, situation: '' });
  const v = draft.value;
  const [org, setOrg] = useState<OrgInput>({
    raisonSociale: '', forme: 'SARL', rccm: '', idNat: '', nif: '', phone: '', email: '', language: lang,
    repName: '', repFonction: '', repHabilitation: 'DIRIGEANT', declarantSame: true, declName: '', declFonction: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Done | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const set = <K extends keyof RegistrationInput>(k: K, val: RegistrationInput[K]) => draft.setValue((p) => ({ ...p, [k]: val }));
  const setO = <K extends keyof OrgInput>(k: K, val: OrgInput[K]) => setOrg((p) => ({ ...p, [k]: val }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!PHONE_RE.test(v.phone.trim())) errs.phone = tr('reg.err.phone');
    if (v.fullName.trim().length < 3) errs.fullName = tr('reg.err.name');
    if (!v.situation) errs.situation = tr('reg.err.situation');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setApiError(null);
    try {
      const phone = v.phone.replace(/\s/g, '');
      const r = await api<RegistrationResult>('/v1/registrations', { method: 'POST', body: { ...v, phone, fullName: v.fullName.trim() } });
      setResult({ ...r, kind: 'PP', phone, phoneVerified: false });
      safeSet('mosolo.taxpayerId', r.taxpayerId);
      draft.reset();
    } catch (err) {
      setApiError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitOrg(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (org.raisonSociale.trim().length < 2) errs.raisonSociale = 'Raison sociale requise.';
    if (!PHONE_RE.test(org.phone.trim())) errs.orgPhone = tr('reg.err.phone');
    if (org.repName.trim().length < 3 || org.repFonction.trim().length < 2) errs.rep = 'Au moins un représentant nommément désigné, avec sa fonction.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setApiError(null);
    try {
      const phone = org.phone.replace(/[\s-]/g, '');
      const rep = { fullName: org.repName.trim(), fonction: org.repFonction.trim(), habilitation: org.repHabilitation };
      const r = await api<RegistrationResult>('/v1/acces/organisations', {
        method: 'POST',
        body: {
          raisonSociale: org.raisonSociale.trim(), forme: org.forme, phone, language: org.language,
          ...(org.rccm.trim() ? { rccm: org.rccm.trim() } : {}), ...(org.idNat.trim() ? { idNat: org.idNat.trim() } : {}), ...(org.nif.trim() ? { nif: org.nif.trim() } : {}),
          ...(org.email.trim() ? { email: org.email.trim() } : {}),
          representatives: [rep],
          declarant: org.declarantSame ? { fullName: rep.fullName, fonction: rep.fonction } : { fullName: org.declName.trim(), fonction: org.declFonction.trim() },
        },
      });
      setResult({ ...r, kind: 'PM', phone, phoneVerified: false });
      safeSet('mosolo.taxpayerId', r.taxpayerId);
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
            <p>{tr('reg.notProof')} L’inscription publique ne crée que des comptes de contribuable : les comptes de travail des agents s’ouvrent uniquement sur invitation.</p>
          </div>

          {result ? (
            <div className="result-card" role="status">
              <StatusBadge tone="good" label={tr('reg.done')} />
              <dl className="kv">
                <div><dt>{tr('reg.iuc')}</dt><dd className="mono">{result.iuc}</dd></div>
                <div><dt>{tr('reg.taxpayerId')}</dt><dd className="mono">{result.taxpayerId}</dd></div>
                <div><dt>Titulaire</dt><dd>{result.kind === 'PM' ? 'Personne morale' : 'Personne physique'}</dd></div>
                <div><dt>{tr('reg.level')}</dt><dd>{levelLabel(lang, result.verificationLevel)}{result.phoneVerified ? ' · téléphone vérifié' : ' · téléphone à vérifier'}</dd></div>
              </dl>
              {!result.phoneVerified && <OtpStep done={result} onVerified={(level) => setResult({ ...result, phoneVerified: true, verificationLevel: level as RegistrationResult['verificationLevel'] })} />}
              <Ladder level={result.verificationLevel} verified={result.phoneVerified} />
              {result.kind === 'PM' && <p className="small muted">RCCM, identification nationale et NIF sont enregistrés comme « déclarés » : ils seront contrôlés (niveau N3) avant toute opération d’entreprise.</p>}
              <p className="small muted">{tr('reg.next')}</p>
              <Link className="btn btn-primary" to="/espace">{tr('home.cta.space')}</Link>
            </div>
          ) : (
            <>
              <div className="seg" role="group" aria-label="Type de titulaire" style={{ marginBottom: 16 }}>
                <button type="button" aria-pressed={profile === 'PP'} onClick={() => { setProfile('PP'); setErrors({}); }}><Icon name="user" size={16} /> Particulier</button>
                <button type="button" aria-pressed={profile === 'PM'} onClick={() => { setProfile('PM'); setErrors({}); }}><Icon name="building" size={16} /> Entreprise ou organisation</button>
              </div>
              {profile === 'PP' ? (
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
              ) : (
                <form onSubmit={(e) => void submitOrg(e)} noValidate className="form">
                  <div className="field">
                    <label htmlFor="org-rs" className="label">Raison sociale</label>
                    <input id="org-rs" value={org.raisonSociale} onChange={(e) => setO('raisonSociale', e.target.value)} aria-invalid={!!errors.raisonSociale} aria-describedby="org-rs-err" />
                    {errors.raisonSociale && <span id="org-rs-err" className="err">{errors.raisonSociale}</span>}
                  </div>
                  <div className="field-row">
                    <div className="field"><label htmlFor="org-f" className="label">Forme juridique</label>
                      <select id="org-f" value={org.forme} onChange={(e) => setO('forme', e.target.value)}>{FORMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                    <div className="field"><label htmlFor="org-lang" className="label">{tr('reg.language')}</label>
                      <select id="org-lang" value={org.language} onChange={(e) => isLanguageCode(e.target.value) && setO('language', e.target.value)}>{LANGUAGE_CODES.map((c) => <option key={c} value={c} lang={c}>{LANGUAGES[c].nativeName}</option>)}</select></div>
                  </div>
                  <fieldset className="field">
                    <legend className="label">Identifiants déclarés (facultatifs, contrôlés ensuite)</legend>
                    <div className="field-row">
                      <div className="field"><label htmlFor="org-rccm" className="label">RCCM</label><input id="org-rccm" className="mono" value={org.rccm} onChange={(e) => setO('rccm', e.target.value)} placeholder="CD/KIN/RCCM/…" /></div>
                      <div className="field"><label htmlFor="org-idnat" className="label">Identification nationale</label><input id="org-idnat" className="mono" value={org.idNat} onChange={(e) => setO('idNat', e.target.value)} /></div>
                    </div>
                    <div className="field"><label htmlFor="org-nif" className="label">NIF</label><input id="org-nif" className="mono" value={org.nif} onChange={(e) => setO('nif', e.target.value)} />
                      <span className="hint">Sans NIF, un identifiant provisoire est ouvert et une régularisation proposée.</span></div>
                  </fieldset>
                  <div className="field-row">
                    <div className="field"><label htmlFor="org-ph" className="label">Téléphone de contact</label>
                      <input id="org-ph" type="tel" value={org.phone} onChange={(e) => setO('phone', e.target.value)} aria-invalid={!!errors.orgPhone} aria-describedby="org-ph-err" />
                      {errors.orgPhone && <span id="org-ph-err" className="err">{errors.orgPhone}</span>}</div>
                    <div className="field"><label htmlFor="org-em" className="label">Courriel (facultatif)</label><input id="org-em" type="email" value={org.email} onChange={(e) => setO('email', e.target.value)} /></div>
                  </div>
                  <fieldset className="field" aria-describedby={errors.rep ? 'org-rep-err' : undefined}>
                    <legend className="label">Représentant nommément habilité</legend>
                    <div className="field-row">
                      <div className="field"><label htmlFor="org-rn" className="label">Nom complet</label><input id="org-rn" value={org.repName} onChange={(e) => setO('repName', e.target.value)} /></div>
                      <div className="field"><label htmlFor="org-rf" className="label">Fonction</label><input id="org-rf" value={org.repFonction} onChange={(e) => setO('repFonction', e.target.value)} placeholder="Gérant, directeur…" /></div>
                    </div>
                    <div className="radio-list">
                      <label className={`radio ${org.repHabilitation === 'DIRIGEANT' ? 'checked' : ''}`}><input type="radio" name="hab" checked={org.repHabilitation === 'DIRIGEANT'} onChange={() => setO('repHabilitation', 'DIRIGEANT')} /><span>Dirigeant statutaire</span></label>
                      <label className={`radio ${org.repHabilitation === 'MANDATAIRE_HABILITE' ? 'checked' : ''}`}><input type="radio" name="hab" checked={org.repHabilitation === 'MANDATAIRE_HABILITE'} onChange={() => setO('repHabilitation', 'MANDATAIRE_HABILITE')} /><span>Mandataire habilité (mandat écrit)</span></label>
                    </div>
                    {errors.rep && <span id="org-rep-err" className="err">{errors.rep}</span>}
                  </fieldset>
                  <label className="ac-check"><input type="checkbox" checked={org.declarantSame} onChange={(e) => setO('declarantSame', e.target.checked)} /> Je suis ce représentant et je fais la déclaration</label>
                  {!org.declarantSame && (
                    <div className="field-row">
                      <div className="field"><label htmlFor="org-dn" className="label">Déclarant</label><input id="org-dn" value={org.declName} onChange={(e) => setO('declName', e.target.value)} /></div>
                      <div className="field"><label htmlFor="org-df" className="label">Fonction du déclarant</label><input id="org-df" value={org.declFonction} onChange={(e) => setO('declFonction', e.target.value)} /></div>
                    </div>
                  )}
                  {apiError && <p className="notice notice-err" role="alert">{apiError}</p>}
                  <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? tr('common.sending') : 'Créer le compte de l’organisation'}</button>
                  <p className="small muted">Un seul compte par organisation ; ses représentants agissent dans la limite de leur habilitation (préparer, valider, payer). {tr('reg.privacy')}</p>
                </form>
              )}
            </>
          )}
          {user?.roles.some((r) => REVUE_PIECES.includes(r)) && <RegistreGuichet />}
        </div>
      </CoverSplit>
    </div>
  );
}
