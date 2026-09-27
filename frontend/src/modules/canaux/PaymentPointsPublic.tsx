import { useMemo, useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { GeoMapLazy } from '../../components/GeoMapLazy';
import { webglSupported } from '../../lib/geo';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { POINT_STATUS, POINT_TYPE_LABEL, type Guichet, type PublicPoint } from './shared';
import './canaux.css';

interface VerifyResult { kind: string; status: string; message: string; amount?: MoneyJSON; date?: string; verifiedAt: string }

const TYPE_ICON: Record<string, string> = { GUICHET_BANCAIRE_MOSOLO: 'building', AGENCE_BANCAIRE: 'bank', AGENT_MONNAIE_MOBILE: 'phone', TPE_PRESTATAIRE: 'card' };

/** Plan schématique (repli sans WebGL) : projection linéaire des coordonnées dans l'emprise des points (aucun fond de carte externe). */
function PointsMap({ points, guichets, selected, onSelect }: { points: PublicPoint[]; guichets: Guichet[]; selected: string | null; onSelect: (id: string) => void }) {
  const W = 640; const H = 360; const pad = 36;
  const lats = points.map((p) => p.lat); const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats, -4.40); const maxLat = Math.max(...lats, -4.29);
  const minLon = Math.min(...lons, 15.24); const maxLon = Math.max(...lons, 15.37);
  const x = (lon: number) => pad + ((lon - minLon) / (maxLon - minLon)) * (W - 2 * pad);
  const y = (lat: number) => pad + ((maxLat - lat) / (maxLat - minLat)) * (H - 2 * pad);
  return (
    <svg className="cx-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Plan schématique des points de paiement agréés">
      <rect x="0" y="0" width={W} height={H} className="cx-map-bg" rx="6" />
      {[1, 2, 3].map((i) => <line key={`h${i}`} x1="0" x2={W} y1={(H / 4) * i} y2={(H / 4) * i} className="cx-map-grid" />)}
      {[1, 2, 3, 4, 5].map((i) => <line key={`v${i}`} y1="0" y2={H} x1={(W / 6) * i} x2={(W / 6) * i} className="cx-map-grid" />)}
      <path d={`M0 ${pad - 10} C ${W * 0.3} ${pad + 10}, ${W * 0.6} ${pad - 25}, ${W} ${pad - 5}`} className="cx-map-river" />
      <text x={W - 12} y={pad - 14} textAnchor="end" className="cx-map-river-label">Fleuve Congo (indicatif)</text>
      {guichets.map((g) => {
        const p = points.find((pt) => pt.id === g.bankPointId);
        return p ? <text key={g.id} x={x(p.lon)} y={y(p.lat) + 26} textAnchor="middle" className="cx-map-label">{g.commune}</text> : null;
      })}
      {points.map((p) => {
        const cx = x(p.lon); const cy = y(p.lat); const on = selected === p.id;
        return (
          <g key={p.id} className={`cx-map-pt ${p.status === 'ACTIF' ? 'ok' : 'off'} ${on ? 'on' : ''}`} transform={`translate(${cx} ${cy})`}
            tabIndex={0} role="button" aria-label={`${p.name} — ${POINT_STATUS[p.status]?.label}`} onClick={() => onSelect(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onSelect(p.id); }}>
            {p.type === 'GUICHET_BANCAIRE_MOSOLO' ? <rect x="-9" y="-9" width="18" height="18" rx="3" /> : <circle r="8" />}
            {p.status !== 'ACTIF' && <path d="M-5 -5 L5 5 M5 -5 L-5 5" className="cx-map-x" />}
          </g>
        );
      })}
    </svg>
  );
}

export default function PaymentPointsPublic() {
  const data = useApi(() => api<{ points: PublicPoint[]; guichets: Guichet[]; notice: string }>('/v1/public/payment-points'), []);
  const [commune, setCommune] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [vr, setVr] = useState<VerifyResult | null>(null);
  const [verr, setVerr] = useState<string | null>(null);
  const communes = useMemo(() => [...new Set((data.data?.points ?? []).map((p) => p.commune))].sort(), [data.data]);
  const pts = (data.data?.points ?? []).filter((p) => !commune || p.commune === commune);
  const guichets = (data.data?.guichets ?? []).filter((g) => !commune || g.commune === commune);

  async function verify(e: FormEvent) {
    e.preventDefault(); setVr(null); setVerr(null);
    try { setVr(await api<VerifyResult>(`/v1/public/short-codes/${encodeURIComponent(code.trim())}`)); } catch (x) { setVerr(describeError(x).message); }
  }

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Réseau des points de paiement agréés — module 66" title="Où payer en espèces ?" lead="Uniquement dans un établissement régulé, référencé dans MOSOLO : le montant s’affiche à partir de votre référence et ne peut pas être modifié. Aucun agent public ne reçoit d’argent." />
      <ExampleNotice text="Points, adresses et agréments de démonstration (fictifs). La liste officielle sera publiée après conventions (J9, J20)." />
      {data.loading && <Loading />}
      {data.error !== null && <ErrorState error={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          <div className="seg seg-wrap" role="group" aria-label="Commune">
            <button type="button" aria-pressed={!commune} onClick={() => setCommune('')}>Toutes</button>
            {communes.map((c) => <button key={c} type="button" aria-pressed={commune === c} onClick={() => setCommune(c)}>{c}</button>)}
          </div>
          <div className="cx-two">
            <section className="panel">
              <header className="panel-head"><div><h2 className="panel-title"><Icon name="pin" size={18} /> Carte des points</h2><p className="panel-sub">{webglSupported() ? 'Bleu foncé : guichet bancaire d’un guichet MOSOLO · bleu clair : autre point · gris : point suspendu · rouge : point sélectionné. © contributeurs OpenStreetMap.' : 'Plan schématique — carré : guichet bancaire d’un guichet MOSOLO · rond : autre point · croix : point suspendu'}</p></div></header>
              <GeoMapLazy center={[15.3136, -4.3217]} height={360} ariaLabel="Carte des points de paiement agréés"
                {...(pts.length ? { bounds: [[Math.min(...pts.map((p) => p.lon)), Math.min(...pts.map((p) => p.lat))], [Math.max(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lat))]] as [[number, number], [number, number]] } : {})}
                markers={pts.map((p) => ({ id: p.id, lon: p.lon, lat: p.lat, color: p.status !== 'ACTIF' ? '#8a8f98' : p.id === selected ? '#D7141A' : p.type === 'GUICHET_BANCAIRE_MOSOLO' ? '#232C6B' : '#1E9BD7', label: p.id === selected ? p.name : '' }))}
                onSelect={setSelected}
                fallback={<PointsMap points={pts} guichets={guichets} selected={selected} onSelect={setSelected} />} />
            </section>
            <section className="panel">
              <header className="panel-head"><h2 className="panel-title"><Icon name="building" size={18} /> Guichets MOSOLO communaux</h2><span className="count">{guichets.length}</span></header>
              <ul className="list-rows">{guichets.map((g) => (
                <li key={g.id} className="list-row list-row-stack">
                  <span className="row-title">{g.name}</span>
                  <span className="small">{g.address}</span>
                  <span className="small muted">{g.hours} · {g.services.join(' · ')}</span>
                </li>
              ))}</ul>
            </section>
          </div>
          <section className="panel cx-mt">
            <header className="panel-head"><h2 className="panel-title"><Icon name="store" size={18} /> Points agréés</h2><span className="count">{pts.length}</span></header>
            {pts.length === 0 ? <EmptyState title="Aucun point dans cette commune" /> : (
              <ul className="cx-point-list">{pts.map((p) => (
                <li key={p.id} className={`cx-point ${selected === p.id ? 'on' : ''}`} onClick={() => setSelected(p.id)}>
                  <span className="cx-point-icon"><Icon name={TYPE_ICON[p.type] ?? 'store'} size={20} /></span>
                  <div className="cx-point-body">
                    <div className="row-between"><strong>{p.name}</strong><StatusBadge tone={POINT_STATUS[p.status]?.tone ?? 'neutral'} label={POINT_STATUS[p.status]?.label ?? p.status} /></div>
                    <span className="small">{POINT_TYPE_LABEL[p.type]} · {p.operator}</span>
                    <span className="small muted">{p.commune}, {p.quartier} — {p.address}</span>
                    <span className="small cx-inl"><Icon name="clock" size={14} /> {p.hours}</span>
                  </div>
                </li>
              ))}</ul>
            )}
            <p className="small muted">{data.data.notice}</p>
          </section>
        </>
      )}
      <section className="panel cx-mt" aria-labelledby="cx-verify">
        <header className="panel-head"><div><h2 className="panel-title" id="cx-verify"><Icon name="shieldCheck" size={18} /> Vérifier un reçu</h2><p className="panel-sub">Code court à 6 caractères imprimé sur le reçu, code de quittance ou numéro de carte MOSOLO.</p></div></header>
        <form className="input-row" onSubmit={verify}>
          <input aria-label="Code à vérifier" className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ex. 7KQ2MX" autoCapitalize="characters" />
          <button type="submit" className="btn btn-primary" disabled={!code.trim()}>Vérifier</button>
        </form>
        {verr && <p className="notice notice-err" role="alert">{verr}</p>}
        {vr && (
          <div className={`cx-verify-out ${vr.status === 'VALIDE' ? 'good' : vr.status === 'EN ATTENTE' ? 'warning' : 'critical'}`}>
            <strong>{vr.status}</strong> — {vr.message}
            {vr.amount && <span> · <MoneyText money={vr.amount} showIndicative={false} />{vr.date ? ` du ${vr.date}` : ''}</span>}
          </div>
        )}
        <p className="small muted cx-inl"><Icon name="lock" size={14} /> Réponse minimale, sans nom ; vérifications limitées en fréquence.</p>
      </section>
    </div>
  );
}
