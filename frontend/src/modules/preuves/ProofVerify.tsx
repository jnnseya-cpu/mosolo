/**
 * Vérifier une preuve — page universelle : ticket, place (parking, marché), pass wewa, certificat, autorisation,
 * quitus, attestation de bail, badge, quittance, carte. Même résolveur que l'USSD, le SMS, WhatsApp et les pages légères.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHead } from '../../components/Shell';
import { AideContextuelle } from '../apprentissage/AideContextuelle';
import { Icon } from '../../components/Icon';
import { ValidityCountdown, ValidityLegend } from '../../components/ValidityCountdown';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, ExampleNotice, Loading } from '../../components/States';
import { API_URL, api, serverNow } from '../../lib/api';
import { BLOCKING, proofPrintUrl, type ProofResult } from './shared';
import { scanTarget } from './scan';
import { QrScanner } from '../../components/QrScanner';
import './preuves.css';

export default function ProofVerify() {
  const params = useParams<{ code?: string }>();
  const [search] = useSearchParams();
  const code = params.code ?? search.get('c') ?? '';
  const nav = useNavigate();
  const [input, setInput] = useState(code);
  const [res, setRes] = useState<ProofResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (c: string) => {
    if (!c) { setRes(null); return; }
    setBusy(true); setErr(null);
    try { setRes(await api<ProofResult>(`/v1/public/preuves?c=${encodeURIComponent(c)}`)); }
    catch (e) { setErr(e); setRes(null); }
    finally { setBusy(false); }
  };
  useEffect(() => { setInput(code); void load(code); }, [code]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = input.trim();
    if (c) nav(c.length > 60 ? `/preuve?c=${encodeURIComponent(c)}` : `/preuve/${encodeURIComponent(c)}`);
  };

  return (
    <div className="page pv-page">
      <PageHead eyebrow="Vérification publique" title="Vérifier une preuve"
        lead="Ticket, place de stationnement ou de marché, pass wewa, certificat, autorisation, quitus, quittance, badge : scannez le QR code avec la caméra, prenez-le en photo, ou saisissez le code imprimé dessous."><AideContextuelle cle="preuves.verifier" libelle="Aide : vérifier une preuve" /></PageHead>
      <ExampleNotice />
      <form className="card pv-form" onSubmit={submit}>
        <label htmlFor="pv-code">Code de la preuve</label>
        <div className="pv-form-row">
          <input id="pv-code" className="input mono" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" autoCapitalize="characters" placeholder="ex. PKT4K7M2QX, EVT-2026-00001-W, Q26KIN…" />
          <button className="btn btn-primary" disabled={busy || !input.trim()}><Icon name="shieldCheck" size={16} /> Vérifier</button>
        </div>
        <p className="small muted">Sans smartphone : USSD <b>*[code court À RACCORDER — convention opérateur requise]#</b>, SMS <b>V</b> + code, WhatsApp <b>MENU</b>, ou la <a href={`${API_URL}/l`}>version légère</a> (sans application, faible débit).</p>
        {scan
          ? <QrScanner onResult={(raw) => { setScan(false); nav(scanTarget(raw)); }} onClose={() => setScan(false)} />
          : <button type="button" className="btn btn-secondary pv-scan" onClick={() => setScan(true)}><Icon name="qr" size={18} /> Scanner un QR code</button>}
      </form>

      {busy && <Loading />}
      {err !== null && <ErrorState error={err} onRetry={() => void load(code)} />}
      {res && <ProofCard r={res} onRefresh={() => void load(code)} />}
      {!code && <HowToRead />}
    </div>
  );
}

/** Exemples illustratifs (fictifs) de la règle : fenêtres de 100 h positionnées à 80 %, 25 % et 0,5 % de validité restante. */
function HowToRead() {
  const [t0] = useState(serverNow);
  const H = 3_600_000;
  const ex = [
    { pct: 0.8, label: 'Vert — 50 % ou plus de validité restante' },
    { pct: 0.25, label: 'Orange — de 1 % à moins de 50 %' },
    { pct: 0.005, label: 'Rouge — moins de 1 % : encore valable, à renouveler tout de suite' },
  ];
  return (
    <section className="card pv-howto" aria-labelledby="pv-howto-t">
      <h2 id="pv-howto-t" className="h3">Comment lire la couleur d’une preuve</h2>
      <p className="small muted">Toute preuve à durée limitée (ticket, place, pass, certificat, autorisation, quitus, badge) affiche un compte à rebours. Sa couleur dépend de la part de validité qui reste, à l’heure du serveur. Exemples illustratifs, fictifs :</p>
      <div className="pv-howto-grid">
        {ex.map((e) => {
          const until = t0 + e.pct * 100 * H;
          return <ValidityCountdown key={e.pct} label={e.label} from={new Date(until - 100 * H).toISOString()} until={new Date(until).toISOString()} />;
        })}
      </div>
      <p className="small">Une fois la validité échue, la preuve affiche <strong>✗ EXPIRÉ</strong>. Une preuve révoquée, suspendue ou remplacée n’affiche pas de compte à rebours mais la mention qui s’applique.</p>
    </section>
  );
}

const SITUATION_TONE: Record<string, 'good' | 'warning' | 'critical' | 'neutral' | 'info'> = { green: 'good', amber: 'warning', red: 'critical', grey: 'neutral', blue: 'info' };

export function ProofCard({ r, onRefresh }: { r: ProofResult; onRefresh?: () => void }) {
  const blocked = BLOCKING[r.state] ?? null;
  return (
    <section className={`card pv-result pv-${r.found ? r.state : 'INCONNU'}`} aria-live="polite">
      <header className="pv-result-head">
        <div>
          <p className="eyebrow">{r.kindLabel}</p>
          <h2 className="pv-title">{r.found ? r.title : 'Code inconnu'}</h2>
          <p className="mono pv-code">{r.code}</p>
        </div>
        {r.found && (
          <span className={`pv-auth ${r.authentic ? 'pv-auth-ok' : 'pv-auth-ko'}`}>
            <Icon name={r.authentic ? 'shieldCheck' : 'alert'} size={16} /> {r.authentic ? 'Authentique' : 'Signature non authentique'}
          </span>
        )}
      </header>

      {r.found && (r.validity || blocked) && (
        <ValidityCountdown label="Validité" from={r.validity?.from ?? null} until={r.validity?.until ?? null} blocked={blocked} />
      )}
      {r.found && !r.validity && !blocked && <p className="pv-state"><Icon name="check" size={16} /> {r.stateLabel}</p>}
      {r.situation && (
        <div className="pv-situation"><span className="small muted">Situation</span><StatusBadge tone={SITUATION_TONE[r.situation.color] ?? 'neutral'} label={r.situation.label} /></div>
      )}
      {r.found && r.facts.length > 0 && (
        <dl className="kv pv-facts">{r.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
      )}
      <p>{r.message}</p>
      {r.found && r.validity && r.validity.band !== 'PERMANENT' && <ValidityLegend />}
      <p className="pv-advice small"><Icon name="alert" size={14} /> <span>{r.advice}</span></p>
      <div className="pv-actions">
        {onRefresh && <button type="button" className="btn btn-ghost" onClick={onRefresh}><Icon name="refresh" size={16} /> Actualiser</button>}
        {r.found && <Link className="btn btn-secondary" to={proofPrintUrl(r.code)}><Icon name="download" size={16} /> Version imprimable</Link>}
        <a className="btn btn-ghost" href={`${API_URL}/l/v?c=${encodeURIComponent(r.code)}`}><Icon name="offline" size={16} /> Version légère</a>
      </div>
      <p className="small muted">Vérifié le {new Date(r.checkedAt).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa' })} — heure du serveur (Kinshasa) ; l’heure du téléphone n’est jamais prise en compte.</p>
    </section>
  );
}
