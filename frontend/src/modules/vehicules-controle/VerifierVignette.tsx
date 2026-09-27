/**
 * Vérification publique (sans compte) d'une vignette technique sécurisée ou de l'agrément d'un centre. Le QR d'une
 * vignette pointe vers le domaine officiel : un autre domaine est signalé. Un numéro inconnu est faux par construction.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHead } from '../../components/Shell';
import { api, describeError } from '../../lib/api';
import { StateBadge } from './common';

interface StickerCheck { found: boolean; authentic?: boolean; state: string; message: string; number?: string; plateMasked?: string; echeance?: string | null; centre?: { name: string; publicCode: string } | null; officialDomain?: string }
interface CentreCheck { found: boolean; state: string; message: string; name?: string; kindLabel?: string; commune?: string; habilitation?: { from: string; to: string } | null }

export default function VerifierVignette() {
  const params = useParams<{ numero?: string }>();
  const [value, setValue] = useState(params.numero ?? '');
  const [code, setCode] = useState('');
  const [res, setRes] = useState<StickerCheck | null>(null);
  const [cres, setCres] = useState<CentreCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function check(v = value) {
    setErr(null);
    try { setRes(await api<StickerCheck>(`/v1/public/vehicules/vignettes/verifier?qr=${encodeURIComponent(v.trim())}`)); } catch (e) { setErr(describeError(e).message); }
  }
  async function checkCentre() {
    setErr(null);
    try { setCres(await api<CentreCheck>(`/v1/public/centres-agrees/${encodeURIComponent(code.trim())}`)); } catch (e) { setErr(describeError(e).message); }
  }
  useEffect(() => { if (params.numero) void check(params.numero); }, [params.numero]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <PageHead eyebrow="Vérification publique" title="Vérifier une vignette technique ou un centre agréé" lead="Saisissez le numéro imprimé ou scannez le QR. Aucun agent ne demande d’espèces." />
      <div className="vc-form">
        <label><span>Numéro de vignette ou adresse du QR</span><input value={value} onChange={(e) => setValue(e.target.value)} placeholder="VTS-2026-00000011" /></label>
        <button type="button" className="btn btn-primary" disabled={!value.trim()} onClick={() => void check()}>Vérifier la vignette</button>
      </div>
      {res && (
        <div className="vc-line" role="status" style={{ marginTop: '1rem' }}>
          <StateBadge state={res.authentic ? 'CONFORME' : 'A_FAIRE'} label={res.authentic ? 'Authentique' : 'Non authentique ou non valable'} />
          <p>{res.message}</p>
          {res.plateMasked && <p className="small">Plaque : {res.plateMasked} · échéance {res.echeance ?? '—'} · {res.centre?.name ?? ''}</p>}
          {res.officialDomain && <p className="small">Domaine officiel : {res.officialDomain}</p>}
        </div>
      )}
      <div className="vc-form" style={{ marginTop: '1.5rem' }}>
        <label><span>Numéro d’agrément du centre</span><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="AGR-…" /></label>
        <button type="button" className="btn btn-secondary" disabled={!code.trim()} onClick={() => void checkCentre()}>Vérifier le centre</button>
      </div>
      {cres && (
        <div className="vc-line" role="status" style={{ marginTop: '1rem' }}>
          <StateBadge state={cres.state === 'AGREE' ? 'AGREE' : cres.state === 'SUSPENDU' ? 'SUSPENDU' : 'A_FAIRE'} label={cres.state === 'NON_AGREE' ? 'Non agréé' : undefined} />
          <p>{cres.message}</p>
          {cres.name && <p className="small">{cres.name} · {cres.kindLabel} · {cres.commune}{cres.habilitation ? ` · habilité du ${cres.habilitation.from} au ${cres.habilitation.to}` : ''}</p>}
        </div>
      )}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </div>
  );
}
