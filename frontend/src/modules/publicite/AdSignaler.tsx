/**
 * Portail citoyen de signalement des supports publicitaires (§ 11B.5) : public, sans compte, sans donnée nominative.
 * Une demande d'espèces ou un faux contrôleur est transmis à la ligne d'intégrité (code de suivi affiché une seule fois).
 */
import { useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { api, describeError } from '../../lib/api';
import { COMMUNES } from '../../verticals/catalogue';
import '../referentiel/referentiel.css';

const KINDS: { value: string; label: string }[] = [
  { value: 'SUPPORT_SANS_PLAQUE', label: 'Panneau ou enseigne sans plaque QR' },
  { value: 'SUPPORT_DANGEREUX', label: 'Support dangereux (chute, câbles, visibilité)' },
  { value: 'AFFICHAGE_SAUVAGE', label: 'Affichage sauvage' },
  { value: 'DEMANDE_ESPECES', label: 'Un contrôleur m’a demandé de l’argent liquide' },
  { value: 'FAUX_CONTROLEUR', label: 'Contrôleur non vérifiable (faux contrôleur)' },
  { value: 'AUTRE', label: 'Autre' },
];

interface Result { reference: string; status: string; message: string; integrity?: { reference: string; trackingCode: string; message: string } }

export default function AdSignaler() {
  const [kind, setKind] = useState('SUPPORT_SANS_PLAQUE');
  const [commune, setCommune] = useState('Gombe');
  const [description, setDescription] = useState('');
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const locate = () => {
    setErr(null);
    if (!navigator.geolocation) { setErr('Position indisponible sur cet appareil.'); return; }
    navigator.geolocation.getCurrentPosition((p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude }), () => setErr('Position refusée : la commune suffit.'));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try {
      setRes(await api<Result>('/v1/public/publicite/signalements', { method: 'POST', body: { kind, commune, description, lat: pos?.lat ?? -4.325, lon: pos?.lon ?? 15.31 } }));
      setDescription('');
    } catch (ex) { setErr(describeError(ex).message); }
  };
  return (
    <div className="page">
      <PageHead eyebrow="KIN PUB CONTROL · portail citoyen" title="Signaler un support publicitaire"
        lead="Un panneau sans plaque, un affichage sauvage, un support dangereux ? Signalez-le. Un inspecteur accrédité vérifie sur place ; aucune sanction n’est prononcée sur la seule foi d’un signalement." />
      {res ? (
        <div className="panel stack-sm" role="status">
          <h2 className="panel-title"><Icon name="check" size={18} /> Signalement {res.reference} reçu</h2>
          <p>{res.message}</p>
          {res.integrity && <p className="callout callout-info"><Icon name="lock" size={18} /> <span>{res.integrity.message} Code de suivi : <strong className="mono">{res.integrity.trackingCode}</strong> (référence {res.integrity.reference}).</span></p>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRes(null)}>Nouveau signalement</button>
        </div>
      ) : (
        <form className="panel stack-sm" onSubmit={submit}>
          <label className="label" htmlFor="ads-kind">Ce que vous signalez</label>
          <select id="ads-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
          <label className="label" htmlFor="ads-commune">Commune</label>
          <select id="ads-commune" value={commune} onChange={(e) => setCommune(e.target.value)}>{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
          <label className="label" htmlFor="ads-desc">Description (lieu, repère)</label>
          <textarea id="ads-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
          <div className="row-wrap">
            <button type="button" className="btn btn-ghost btn-sm" onClick={locate}><Icon name="gps" size={14} /> Joindre ma position</button>
            {pos && <span className="small muted">Position jointe ({pos.lat.toFixed(4)}, {pos.lon.toFixed(4)})</span>}
          </div>
          {err && <p className="err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary" disabled={description.trim().length < 10}>Envoyer le signalement</button>
          <p className="hint">Aucune donnée nominative n’est demandée. Un agent ne demande jamais d’espèces : tout paiement se fait vers le compte public.</p>
        </form>
      )}
    </div>
  );
}
