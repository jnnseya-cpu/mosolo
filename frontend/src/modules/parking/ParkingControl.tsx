/**
 * Terminal de l'agent de contrôle (R11) et du superviseur (R09) — ParkSmart.
 * Contrôle par plaque (résultat minimal : vert, ambre, rouge), constat photographique HUMAIN,
 * vérification par une personne distincte. Aucune sanction, aucun encaissement sur le terrain.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import {
  DemoTag, ErrorLine, GpsField, hasRole, LIGHT_VIEW, NATURE, PhotoHashes, ReasonForm, useAction, VIOLATION_STATUS,
  type Light, type Violation, type Zone,
} from './shared';
import './parking.css';

interface ControlResult { checkId: string; plate: string; zone: { id: string; code: string; name: string } | null; light: Light; title: string | null; validUntil: string | null; checkedAt: string; guidance: string }

export default function ParkingControl() {
  const { user } = useApp();
  const [tick, setTick] = useState(0);
  const isAgent = hasRole(user?.roles, 'R11');
  const isSupervisor = hasRole(user?.roles, 'R09');
  const zones = useApi(() => api<{ items: Zone[] }>('/v1/parking/zones').then((r) => r.items.filter((z) => z.legalStatus !== 'ACTE_REQUIS')), [user?.id]);
  const violations = useApi(isAgent || isSupervisor ? () => api<{ items: Violation[] }>('/v1/parking/violations').then((r) => r.items) : null, [user?.id, tick]);

  if (!isAgent && !isSupervisor) {
    return (
      <div className="page">
        <PageHead eyebrow="MOSOLO Parking" title="Contrôle du stationnement" />
        <EmptyState title="Écran réservé aux agents de contrôle et superviseurs" icon="lock">Choisissez « Contrôleuse de stationnement » ou « Superviseur stationnement » dans l’en-tête.</EmptyState>
      </div>
    );
  }
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Parking · terminal de contrôle" title={isAgent ? 'Contrôle par plaque' : 'Vérification des constats'}
        lead="Le contrôle constate ; il ne sanctionne pas. Toute suite est décidée, avec motif, par une personne habilitée distincte. Aucun agent n’encaisse d’espèces." />
      <div className="pk-grid pk-grid-2">
        {isAgent ? <ControlPanel zones={zones.data ?? []} loading={zones.loading} onRecorded={() => setTick((n) => n + 1)} /> : <VerifyQueue state={violations} onChange={() => setTick((n) => n + 1)} />}
        <RecentList state={violations} title={isAgent ? 'Mes constats récents' : 'Constats du périmètre'} />
      </div>
    </div>
  );
}

function ControlPanel({ zones, loading, onRecorded }: { zones: Zone[]; loading: boolean; onRecorded: () => void }) {
  const { fmtDate } = useApp();
  const [zoneId, setZoneId] = useState('');
  const [plate, setPlate] = useState('');
  const [result, setResult] = useState<ControlResult | null>(null);
  const [constat, setConstat] = useState(false);
  const act = useAction();
  const zone = zones.find((z) => z.id === (zoneId || zones[0]?.id));
  function check(e: FormEvent) {
    e.preventDefault();
    setConstat(false);
    void act.run(() => api<ControlResult>(`/v1/parking/control/${encodeURIComponent(plate.trim())}${zone ? `?zoneId=${encodeURIComponent(zone.id)}` : ''}`), setResult);
  }
  if (loading && zones.length === 0) return <Loading />;
  const view = result ? LIGHT_VIEW[result.light] : null;
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="qr" size={18} /> Vérifier une plaque</h2><p className="panel-sub">Résultat minimal : aucun nom ni adresse. Chaque contrôle est journalisé.</p></div></header>
      <form className="form" onSubmit={check}>
        <label className="field"><span className="label">Zone contrôlée</span>
          <select value={zone?.id ?? ''} onChange={(e) => setZoneId(e.target.value)}>{zones.map((z) => <option key={z.id} value={z.id}>{z.name}{z.demo ? ' (démo)' : ''}</option>)}</select></label>
        <label className="field"><span className="label">Plaque</span>
          <div className="input-row"><input className="pk-plate-input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="KN-0000-XX" required autoComplete="off" />
            <button type="submit" className="btn btn-primary" disabled={act.busy}>Contrôler</button></div>
          <span className="hint">Essayez KN-0001-DM (titre valide) ou KN-0777-DM (aucun titre) — plaques fictives.</span></label>
      </form>
      <ErrorLine error={act.error} />
      {result && view && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className={`pk-light pk-light-${result.light}`} role="status" aria-live="polite">
            <div className="pk-light-icon"><Icon name={view.icon} size={40} /></div>
            <p className="pk-light-title">{view.label}</p>
            <p><span className="pk-plate">{result.plate}</span></p>
            {result.validUntil && <p className="small">Valable jusqu’à {fmtDate(result.validUntil, true)} ({result.title === 'RESERVATION' ? 'réservation' : 'session'})</p>}
            <p className="small">{result.guidance}</p>
            <p className="small muted">Contrôle {result.checkId} · {fmtDate(result.checkedAt, true)}</p>
          </div>
          {result.light === 'ROUGE' && !constat && zone && (
            <button type="button" className="btn btn-secondary" onClick={() => setConstat(true)}><Icon name="camera" size={18} /> Établir un constat photographique</button>
          )}
          {constat && zone && <ConstatForm zone={zone} plate={result.plate} checkId={result.checkId} onDone={() => { setConstat(false); setResult(null); setPlate(''); onRecorded(); }} />}
        </div>
      )}
    </section>
  );
}

function ConstatForm({ zone, plate, checkId, onDone }: { zone: Zone; plate: string; checkId: string; onDone: () => void }) {
  const [nature, setNature] = useState('NON_PAIEMENT');
  const [photos, setPhotos] = useState<string[]>([]);
  const [lat, setLat] = useState(zone.center.lat.toFixed(6));
  const [lon, setLon] = useState(zone.center.lon.toFixed(6));
  const [acc, setAcc] = useState<number | undefined>();
  const [obs, setObs] = useState('');
  const [done, setDone] = useState<Violation | null>(null);
  const act = useAction();
  if (done) {
    return (
      <div className="result-card" role="status">
        <StatusBadge tone="good" label="Constat enregistré" />
        <p className="small">Référence <span className="mono">{done.reference}</span>. Il sera vérifié par le superviseur puis décidé par une autre personne. Aucune pénalité n’est émise à ce stade.</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Nouveau contrôle</button>
      </div>
    );
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (photos.length === 0) { act.setError('Au moins une photographie est obligatoire.'); return; }
    void act.run(() => api<Violation>('/v1/parking/violations', {
      method: 'POST',
      body: { zoneId: zone.id, plate, nature, checkId, photoSha256: photos, lat: Number(lat), lon: Number(lon), ...(acc !== undefined ? { gpsAccuracyM: acc } : {}), observations: obs || 'Constat sur place.' },
    }), setDone);
  }
  return (
    <form className="form panel" onSubmit={submit} aria-label="Constat">
      <p className="pk-row-title">Constat — <span className="pk-plate">{plate}</span></p>
      <label className="field"><span className="label">Nature présumée</span>
        <select value={nature} onChange={(e) => setNature(e.target.value)}>{Object.entries(NATURE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <PhotoHashes value={photos} onChange={setPhotos} />
      <GpsField lat={lat} lon={lon} onChange={(a, b, c) => { setLat(a); setLon(b); if (c !== undefined) setAcc(c); }} />
      <label className="field"><span className="label">Observations</span><textarea rows={3} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Faits constatés, signalisation, circonstances." /></label>
      <ErrorLine error={act.error} />
      <button type="submit" className="btn btn-primary" disabled={act.busy}>{act.busy ? 'Envoi…' : 'Enregistrer le constat'}</button>
    </form>
  );
}

function VerifyQueue({ state, onChange }: { state: ReturnType<typeof useApi<Violation[]>>; onChange: () => void }) {
  const { fmtDate } = useApp();
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  const queue = (state.data ?? []).filter((v) => v.status === 'CONSTATE');
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="shieldCheck" size={18} /> À vérifier</h2><p className="panel-sub">Contrôle qualité des preuves avant toute proposition. Vous ne pouvez pas vérifier vos propres constats.</p></div></header>
      {queue.length === 0 ? <p className="muted small">Aucun constat en attente.</p> : (
        <div className="pk-cards">
          {queue.map((v) => (
            <article key={v.id} className="pk-card">
              <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{NATURE[v.nature] ?? v.nature} · <span className="pk-plate">{v.plate}</span></p><p className="pk-sub">{v.reference} · {v.zone?.name} · agent {v.agentId}</p></div></div>
              {v.evidence && (
                <div className="pk-evidence">
                  <span><Icon name="camera" size={14} /> {v.evidence.photoSha256.length} photo(s) · GPS {v.evidence.lat.toFixed(5)}, {v.evidence.lon.toFixed(5)}{v.evidence.gpsAccuracyM !== null ? ` (± ${v.evidence.gpsAccuracyM} m)` : ''} · {fmtDate(v.evidence.observedAt, true)}</span>
                  <span>{v.evidence.observations}</span>
                </div>
              )}
              <div className="pk-grid pk-grid-even">
                <ReasonForm confirmLabel="Confirmer les preuves" placeholder="Note de vérification" onSubmit={(note) => api(`/v1/parking/violations/${v.id}/verify`, { method: 'POST', body: { confirm: true, note } }).then(onChange)} />
                <ReasonForm confirmLabel="Écarter le constat" danger placeholder="Motif du rejet (qualité insuffisante…)" onSubmit={(note) => api(`/v1/parking/violations/${v.id}/verify`, { method: 'POST', body: { confirm: false, note } }).then(onChange)} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentList({ state, title }: { state: ReturnType<typeof useApi<Violation[]>>; title: string }) {
  const { fmtDate } = useApp();
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="history" size={18} /> {title}</h2><p className="panel-sub">Un constat ne peut être ni modifié ni supprimé.</p></div></header>
      {state.loading && !state.data ? <Loading /> : state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : (state.data ?? []).length === 0 ? <p className="muted small">Aucun constat.</p> : (
        <ul className="list-rows">
          {(state.data ?? []).slice(0, 12).map((v) => (
            <li key={v.id} className="list-row">
              <div className="min0"><p className="pk-row-title"><span className="pk-plate">{v.plate}</span> {NATURE[v.nature] ?? v.nature}</p><p className="pk-sub">{v.reference} · {v.zone?.name} · {fmtDate(v.createdAt, true)}</p></div>
              <div className="row-side">{v.zone?.code.startsWith('DEMO') && <DemoTag />}<StatusBadge tone={VIOLATION_STATUS[v.status].tone} label={VIOLATION_STATUS[v.status].label} /></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
