/**
 * Preuve imprimée, aux couleurs de la Ville et vérifiable (§ H.11.5 « QR statique : dates en gros caractères,
 * pictogrammes, code court ») — pour les personnes sans smartphone, au guichet, au point agréé ou chez soi :
 * - formats A6 (carte à afficher), ticket thermique 80 mm et 58 mm (imprimantes des points agréés) ;
 * - logo officiel de la Ville inchangé, bandeau aux couleurs nationales, fond de sécurité, micro-texte du code ;
 * - QR vers la page de vérification (lisible par tout téléphone et par le terminal de contrôle), code court en gros ;
 * - un papier ne peut pas décompter : il porte l'ÉCHÉANCIER DES COULEURS (vert jusqu'à…, orange jusqu'à…, rouge jusqu'à…)
 *   selon la règle 50 % / 1 %, et rappelle que seule la vérification en ligne fait foi.
 */
import { PrintFooterMark } from '../../components/Brand';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { QrCode } from '../../components/QrCode';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { BLOCKING, colourSchedule, proofUrl, type ProofResult } from './shared';
import './preuves.css';

type Format = 'a6' | 'ticket80' | 'ticket58';
const FORMATS: { id: Format; label: string }[] = [
  { id: 'a6', label: 'Carte A6 (à afficher)' }, { id: 'ticket80', label: 'Ticket 80 mm' }, { id: 'ticket58', label: 'Ticket 58 mm' },
];

const kin = (t: number | string, withTime = true) => new Date(t).toLocaleString('fr-FR', {
  timeZone: 'Africa/Kinshasa', day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
});

export default function ProofPrint() {
  const { code = '' } = useParams<{ code: string }>();
  const [search, setSearch] = useSearchParams();
  const format = (FORMATS.find((f) => f.id === search.get('format'))?.id ?? 'a6') as Format;
  const [r, setR] = useState<ProofResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    api<ProofResult>(`/v1/public/preuves/${encodeURIComponent(code)}/impression`).then((x) => { if (alive) setR(x); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [code]);

  if (err !== null) return <div className="page"><ErrorState error={err} /></div>;
  if (!r) return <div className="page"><Loading /></div>;
  const verifyUrl = `${window.location.origin}${proofUrl(r.code)}`;
  return (
    <div className="page pv-print-page">
      <div className="pv-toolbar pv-noprint">
        <Link to={proofUrl(r.code)} className="btn btn-ghost"><Icon name="arrowRight" size={16} /> Retour à la vérification</Link>
        <div className="seg seg-wrap" role="group" aria-label="Format d’impression">
          {FORMATS.map((f) => (
            <button key={f.id} type="button" aria-pressed={format === f.id} onClick={() => setSearch({ format: f.id })}>{f.label}</button>
          ))}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => window.print()} disabled={!r.found}><Icon name="download" size={16} /> Imprimer</button>
      </div>
      {!r.found ? <p className="notice notice-err">Code inconnu : rien à imprimer.</p> : <PrintedProof r={r} format={format} verifyUrl={verifyUrl} />}
      <p className="small muted pv-noprint">Le document imprimé ne contient aucun nom ni montant. Il porte le QR et le code court : toute personne peut vérifier sa validité réelle, à l’heure du serveur.</p>
    </div>
  );
}

export function PrintedProof({ r, format, verifyUrl }: { r: ProofResult; format: Format; verifyUrl: string }) {
  const v = r.validity;
  const blocked = BLOCKING[r.state] ?? null;
  const sched = v?.from && v.until && v.band !== 'PERMANENT' ? colourSchedule(v.from, v.until) : null;
  const small = format !== 'a6';
  const micro = `${r.code} · VILLE DE KINSHASA · MOSOLO · `.repeat(8);
  return (
    <article className={`pv-sheet pv-${format} pv-print-area`} aria-label={`Preuve imprimable ${r.code}`}>
      <div className="pv-guilloche" aria-hidden="true" />
      <header className="pv-sheet-head">
        <img src="/logo-ville-de-kinshasa.png" alt="Ville de Kinshasa" className="pv-logo" />
        <div className="pv-brand">
          <strong>VILLE DE KINSHASA</strong>
          <span>Ville-Province de Kinshasa · KINSHASA MOSOLO · preuve vérifiable</span>
        </div>
      </header>
      <div className="pv-flag" aria-hidden="true"><i /><i /><i /></div>
      <p className="pv-kind">{r.kindLabel}</p>
      <h1 className="pv-sheet-title">{r.title}</h1>

      <div className="pv-sheet-main">
        <QrCode value={verifyUrl} size={small ? (format === 'ticket58' ? 150 : 180) : 128} alt={`QR de vérification de ${r.code}`} />
        <div className="pv-sheet-code">
          <span className="pv-label">Code</span>
          <span className="pv-code-big mono">{r.code}</span>
          {v?.from && v.until && v.band !== 'PERMANENT' && (
            <div className="pv-dates">
              <span className="pv-label">Valable</span>
              <span>du <b>{kin(v.from)}</b></span>
              <span>au <b>{kin(v.until)}</b></span>
            </div>
          )}
        </div>
      </div>

      {sched && !blocked && (
        <div className="pv-schedule" aria-label="Échéancier des couleurs de validité">
          <span className="pv-label">Couleur au contrôle (heure du serveur)</span>
          <ol>
            <li className="pv-s-VERT"><span className="pv-s-dot">✓</span> Vert jusqu’au <b>{kin(sched.green)}</b></li>
            <li className="pv-s-AMBRE"><span className="pv-s-dot">!</span> Orange jusqu’au <b>{kin(sched.amber)}</b></li>
            <li className="pv-s-ROUGE"><span className="pv-s-dot">!</span> Rouge jusqu’au <b>{kin(sched.end)}</b>, puis <b>EXPIRÉ</b></li>
          </ol>
        </div>
      )}

      <div className="pv-at-print">
        <span className="pv-label">État à l’impression</span>
        <ValidityCountdown compact from={v?.from ?? null} until={v?.until ?? null} blocked={blocked} />
      </div>

      {r.facts.length > 0 && (
        <dl className="pv-sheet-facts">{r.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
      )}

      <div className="pv-verify">
        <strong>Vérifier ce document</strong>
        <span>Scannez le QR · USSD <b>*[code court]#</b> · SMS <b>V {r.code.length > 16 ? '<code>' : r.code}</b> · WhatsApp <b>MENU</b> · version légère <b>/l</b></span>
        <span>Seule la vérification en ligne fait foi : la copie d’une preuve expirée ou révoquée s’affiche comme telle.</span>
      </div>
      <p className="pv-cash"><Icon name="ban" size={14} /> Aucun agent ne reçoit d’espèces ni ne demande de code secret.</p>
      <p className="pv-micro" aria-hidden="true">{micro}</p>
      <footer className="pv-sheet-foot">
        <span>Imprimé le {kin(r.printedAt ?? r.checkedAt)} (heure du serveur)</span>
        <span className="pv-demo">DÉMONSTRATION — NON OPPOSABLE</span>
      </footer>
      <PrintFooterMark />
    </article>
  );
}
