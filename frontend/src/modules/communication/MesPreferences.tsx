/**
 * Mes préférences de communication (module 39 « Préférences — canal choisi, consentements ») : canal préféré, canaux
 * refusés (les avis obligatoires restent envoyés), consentement WhatsApp, langue ; historique des consentements.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';

interface Prefs { taxpayerId: string; language: string; prefs: { preferredChannel?: string; disabledChannels?: string[]; whatsappConsent?: boolean; optedOut?: boolean }; history: { id: string; at: string; by: string }[] }
const CHANNELS: Record<string, string> = { sms: 'SMS', email: 'Courriel', 'in-app': 'Application', push: 'Notification du téléphone', whatsapp: 'WhatsApp', ussd: 'USSD', svi: 'Appel vocal', courrier: 'Courrier' };
const LANGS: Record<string, string> = { fr: 'Français', ln: 'Lingala', sw: 'Swahili', kg: 'Kikongo', lua: 'Tshiluba', en: 'English' };

export default function MesPreferences() {
  const { user } = useApp();
  const tp = user?.taxpayerId ?? '';
  // Aucun appel tant que le compte n'est pas connu (sinon « /preferences/ » sans identifiant ⇒ refus 403 inutile).
  const q = useApi(tp ? () => api<Prefs>(`/v1/communication/preferences/${encodeURIComponent(tp)}`) : null, [tp]);
  const [f, setF] = useState({ preferredChannel: '', disabled: [] as string[], whatsappConsent: false, optedOut: false, language: 'fr' });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setF({ preferredChannel: q.data.prefs.preferredChannel ?? '', disabled: q.data.prefs.disabledChannels ?? [], whatsappConsent: !!q.data.prefs.whatsappConsent, optedOut: !!q.data.prefs.optedOut, language: q.data.language });
  }, [q.data]);
  async function save(e: FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null);
    try {
      await api(`/v1/communication/preferences/${encodeURIComponent(tp)}`, { method: 'PUT', body: { preferredChannel: f.preferredChannel || null, disabledChannels: f.disabled, whatsappConsent: f.whatsappConsent, optedOut: f.optedOut, language: f.language } });
      setMsg('Préférences enregistrées (historique conservé).'); q.reload();
    } catch (x) { setErr(describeError(x).message); }
  }
  if (!tp) return <div className="page"><p className="notice">Réservé aux contribuables et à leurs mandataires.</p></div>;
  return (
    <div className="page">
      <PageHead eyebrow="Mon compte" title="Mes préférences de communication" lead="Choisissez le canal par lequel vous préférez être informé. Les avis obligatoires (échéance dépassée, décisions) vous sont toujours adressés, jamais par WhatsApp." />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <form className="panel stack-sm" onSubmit={(e) => void save(e)} aria-label="Préférences">
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pref-ch">Canal préféré</label>
              <select id="pref-ch" value={f.preferredChannel} onChange={(e) => setF({ ...f, preferredChannel: e.target.value })}><option value="">Aucun (canaux par défaut)</option>{Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="pref-lang">Langue</label>
              <select id="pref-lang" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          </div>
          <fieldset className="btn-row"><legend className="label">Canaux refusés (messages facultatifs)</legend>
            {Object.entries(CHANNELS).filter(([k]) => k !== 'in-app').map(([k, v]) => <label key={k} className="small"><input type="checkbox" checked={f.disabled.includes(k)} onChange={() => setF({ ...f, disabled: f.disabled.includes(k) ? f.disabled.filter((x) => x !== k) : [...f.disabled, k] })} /> {v}</label>)}
          </fieldset>
          <label className="small"><input type="checkbox" checked={f.whatsappConsent} onChange={(e) => setF({ ...f, whatsappConsent: e.target.checked })} /> J’accepte de recevoir des messages facultatifs par WhatsApp</label>
          <label className="small"><input type="checkbox" checked={f.optedOut} onChange={(e) => setF({ ...f, optedOut: e.target.checked })} /> Ne plus recevoir de messages facultatifs</label>
          {msg && <p className="notice notice-ok" role="status">{msg}</p>}
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary btn-sm">Enregistrer</button>
          <p className="small muted">{q.data.history.length} modification(s) enregistrée(s){q.data.history[0] ? `, la dernière le ${new Date(q.data.history[0].at).toLocaleString('fr-FR')}` : ''}.</p>
        </form>
      )}
    </div>
  );
}
