import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { api } from '../../lib/api';
import './verticales.css';

interface PlateResult { code: string; authentique: boolean; type?: string; statut?: string; enregistre?: boolean; commune?: string; quartier?: string; message?: string }
interface CertResult { code: string; authentique: boolean; type?: string; verticale?: string; commune?: string | null; validFrom?: string; validUntil?: string | null; statut?: string; message?: string }

/** Extrait le code d'un contenu de QR (URL …/verifier-plaque/CODE) ou d'une saisie. */
const extract = (raw: string) => {
  const s = raw.trim();
  const m = /verifier-plaque\/([^/?#]+)/.exec(s);
  return decodeURIComponent(m ? m[1]! : s).toUpperCase();
};

/**
 * Vérification publique d'une plaque (NFIU, étal, site, embarcation, chantier) ou d'un titre (autorisation, quitus).
 * Minimisation : aucune donnée nominative, aucune adresse précise, jamais la situation de paiement d'un bien identifiable.
 */
export default function PlateVerify() {
  const { code: param } = useParams();
  const nav = useNavigate();
  const { fmtDate } = useApp();
  const [input, setInput] = useState(param ?? '');
  const [state, setState] = useState<{ loading: boolean; error: unknown; plate: PlateResult | null; cert: CertResult | null }>({ loading: false, error: null, plate: null, cert: null });

  useEffect(() => {
    if (!param) return;
    const code = extract(param);
    setInput(code);
    let alive = true;
    setState({ loading: true, error: null, plate: null, cert: null });
    Promise.all([
      api<PlateResult>(`/v1/public/verticales/plates/${encodeURIComponent(code)}`),
      api<CertResult>(`/v1/public/verticales/certificates/${encodeURIComponent(code)}`),
    ]).then(([plate, cert]) => { if (alive) setState({ loading: false, error: null, plate, cert }); }, (e: unknown) => { if (alive) setState({ loading: false, error: e, plate: null, cert: null }); });
    return () => { alive = false; };
  }, [param]);

  const submit = (e: FormEvent) => { e.preventDefault(); const c = extract(input); if (c) nav(`/verifier-plaque/${encodeURIComponent(c)}`); };
  const plate = state.plate?.authentique ? state.plate : null;
  const cert = !plate && state.cert?.authentique ? state.cert : null;
  const unknown = !state.loading && !state.error && param && !plate && !cert;

  return (
    <div className="page">
      <div className="vxv-wrap">
        <PageHead eyebrow="Vérification publique" title="Vérifier une plaque ou un titre"
          lead="Scannez le QR ou saisissez le code imprimé. La réponse ne contient aucune donnée personnelle ni situation de paiement." />
        <form className="verify-form" onSubmit={submit}>
          <label className="label" htmlFor="vxv-code">Code de la plaque ou du titre</label>
          <div className="input-row">
            <input id="vxv-code" className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ex. KIN-LMT-000001-X ou EVT-2026-00001-X" autoComplete="off" />
            <button type="submit" className="btn btn-primary" disabled={!input.trim()}><Icon name="shieldCheck" size={18} /> Vérifier</button>
          </div>
        </form>
        {state.loading && <Loading />}
        {!!state.error && <ErrorState error={state.error} />}
        {plate && (
          <div className="verify-out stack">
            <div className="vxv-plate"><small>Ville-Province de Kinshasa</small><span className="mono">{plate.code}</span><small>{plate.type}</small></div>
            <div className={`verdict ${plate.statut === 'EN_SERVICE' ? 'verdict-good' : 'verdict-warning'}`}>
              <span className="verdict-icon"><Icon name={plate.statut === 'EN_SERVICE' ? 'check' : 'replace'} size={36} /></span>
              <p className="verdict-title">{plate.message}</p>
              <dl className="kv kv-dense">
                <div><dt>Commune</dt><dd>{plate.commune}</dd></div>
                <div><dt>Quartier</dt><dd>{plate.quartier}</dd></div>
                <div><dt>Objet enregistré</dt><dd>{plate.enregistre ? 'Oui' : 'Non'}</dd></div>
              </dl>
            </div>
          </div>
        )}
        {cert && (
          <div className="verify-out">
            <div className={`verdict ${cert.statut === 'VALIDE' ? 'verdict-good' : cert.statut === 'REVOQUE' ? 'verdict-critical' : 'verdict-warning'}`}>
              <span className="verdict-icon"><Icon name={cert.statut === 'VALIDE' ? 'check' : cert.statut === 'REVOQUE' ? 'ban' : 'clock'} size={36} /></span>
              <p className="verdict-title">{cert.message}</p>
              <dl className="kv kv-dense">
                <div><dt>Titre</dt><dd>{cert.type}</dd></div>
                <div><dt>Service</dt><dd>{cert.verticale}</dd></div>
                {cert.commune && <div><dt>Commune</dt><dd>{cert.commune}</dd></div>}
                {cert.validFrom && <div><dt>Validité</dt><dd>du {fmtDate(cert.validFrom)}{cert.validUntil ? ` au ${fmtDate(cert.validUntil)}` : ''}</dd></div>}
              </dl>
            </div>
          </div>
        )}
        {unknown && (
          <div className="verify-out">
            <div className="verdict verdict-critical">
              <span className="verdict-icon"><Icon name="question" size={36} /></span>
              <p className="verdict-title">Aucune plaque ni aucun titre ne correspond à ce code.</p>
              <p className="small">Une plaque ou un titre inconnu peut être un faux : signalez-le à la Ville. Ne payez jamais en espèces à une personne qui le présente.</p>
            </div>
          </div>
        )}
        <p className="verify-privacy small muted"><Icon name="lock" size={14} /> Vérification minimale (§ 16.8) : authenticité, commune, quartier ou validité — jamais le nom du propriétaire, ni l’adresse précise, ni la situation « payé / non payé ».</p>
      </div>
    </div>
  );
}
