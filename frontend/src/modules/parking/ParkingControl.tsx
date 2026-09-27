/**
 * Terminal de l'agent de contrôle (R11) et du superviseur (R09) — ParkSmart.
 * Contrôle par plaque (résultat minimal : vert, ambre, rouge), constat photographique HUMAIN,
 * vérification par une personne distincte. Aucune sanction, aucun encaissement sur le terrain.
 */
import { AssistedPay } from '../../components/AssistedPay';
import { useRef, useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api, isDefinitiveRejection, newIdempotencyKey } from '../../lib/api';
import {
  DemoTag, ErrorLine, hasRole, LIGHT_VIEW, Money, NATURE, ReasonForm, useAction, VIOLATION_STATUS,
  type Light, type Violation, type Zone,
} from './shared';
import { PlateScanner } from '../../components/PlateScanner';
import { EvidenceCamera } from './EvidenceCamera';
import { EvidencePhotos } from './EvidencePhotos';
import './parking.css';

interface PenaltyLine { module: string; reference: string; nature: string; status: string; createdAt: string; decidedAt: string | null; amount: MoneyJSON | null; payment: string; unpaid: boolean; overdueDays: number | null; zone?: string; obligationId?: string | null }
interface ControlResult { checkId: string; plate: string; zone: { id: string; code: string; name: string } | null; light: Light; title: string | null; validUntil: string | null; checkedAt: string; guidance: string; penalties?: PenaltyLine[]; penaltiesUnpaid?: number }
interface Evidence { photoIds: string[]; place: string; lat: number; lon: number; accuracy: number | null }

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
  const { fmtDate, user } = useApp();
  const [zoneId, setZoneId] = useState('');
  const [plate, setPlate] = useState('');
  const [result, setResult] = useState<ControlResult | null>(null);
  const [scan, setScan] = useState(false);
  const [step, setStep] = useState<'result' | 'camera' | 'constat'>('result');
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const act = useAction();
  const zone = zones.find((z) => z.id === (zoneId || zones[0]?.id));
  function run(p: string) {
    setStep('result'); setEvidence(null);
    void act.run(() => api<ControlResult>(`/v1/parking/control/${encodeURIComponent(p.trim())}${zone ? `?zoneId=${encodeURIComponent(zone.id)}` : ''}`), (r) => {
      setResult(r);
      // Plaque ROUGE : la caméra de preuve géolocalisée s'ouvre d'elle-même.
      if (r.light === 'ROUGE' && zone) setStep('camera');
    });
  }
  function check(e: FormEvent) { e.preventDefault(); run(plate); }
  if (loading && zones.length === 0) return <Loading />;
  const view = result ? LIGHT_VIEW[result.light] : null;
  const reset = () => { setStep('result'); setResult(null); setPlate(''); setEvidence(null); };
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="qr" size={18} /> Vérifier une plaque</h2><p className="panel-sub">Lisez la plaque à la caméra ou saisissez-la. Résultat minimal : aucun nom ni adresse. Chaque contrôle est journalisé.</p></div></header>
      <form className="form" onSubmit={check}>
        <label className="field"><span className="label">Zone contrôlée</span>
          <select value={zone?.id ?? ''} onChange={(e) => setZoneId(e.target.value)}>{zones.map((z) => <option key={z.id} value={z.id}>{z.name}{z.demo ? ' (démo)' : ''}</option>)}</select></label>
        <label className="field"><span className="label">Plaque</span>
          <div className="input-row"><input className="pk-plate-input" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="KN-0000-XX" required autoComplete="off" />
            <button type="submit" className="btn btn-primary" disabled={act.busy}>Contrôler</button></div>
          <span className="hint">Essayez KN-0001-DM (titre valide) ou KN-0777-DM (aucun titre) — plaques fictives.</span></label>
        {!scan && <button type="button" className="btn btn-secondary" onClick={() => setScan(true)}><Icon name="camera" size={18} /> Scanner la plaque (caméra)</button>}
      </form>
      {scan && <PlateScanner onConfirm={(p) => { setScan(false); setPlate(p); run(p); }} onClose={() => setScan(false)} />}
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
          <Penalties items={result.penalties ?? []} />
          {result.light === 'ROUGE' && step === 'result' && zone && (
            <button type="button" className="btn btn-secondary" onClick={() => setStep('camera')}><Icon name="camera" size={18} /> Ouvrir la caméra de preuve</button>
          )}
          {step === 'camera' && zone && user && (
            <EvidenceCamera checkId={result.checkId} plate={result.plate} zone={{ id: zone.id, name: zone.name, center: zone.center }} agent={{ id: user.id, name: user.name }}
              onCancel={() => setStep('result')}
              onDone={(photoIds, place, fix) => { setEvidence({ photoIds, place, lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy }); setStep('constat'); }} />
          )}
          {step === 'constat' && zone && evidence && <ConstatForm zone={zone} plate={result.plate} checkId={result.checkId} evidence={evidence} onDone={() => { reset(); onRecorded(); }} />}
        </div>
      )}
    </section>
  );
}

/** Pénalités de l'usager (tous les agents du module) : constats en cours et pénalités retenues, payées ou non. */
function Penalties({ items }: { items: PenaltyLine[] }) {
  const { fmtDate } = useApp();
  const [paying, setPaying] = useState<string | null>(null);
  if (!items.length) return <p className="small muted"><Icon name="check" size={14} /> Aucune pénalité enregistrée pour cette plaque.</p>;
  const unpaid = items.filter((p) => p.unpaid).length;
  return (
    <div className="pk-pen" aria-label="Pénalités de l’usager">
      <p className="pk-row-title"><Icon name="alert" size={16} /> Pénalités de l’usager : {items.length}{unpaid ? ` dont ${unpaid} impayée(s)` : ''}</p>
      {items.map((p) => (
        <div key={p.reference} className={`pk-pen-row${p.unpaid ? ' is-unpaid' : ''}`}>
          <span><span className="mono">{p.reference}</span> · {p.nature}{p.zone ? ` · ${p.zone}` : ''}</span>
          {p.unpaid && p.obligationId && paying !== p.obligationId && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPaying(p.obligationId!)}><Icon name="phone" size={14} /> Faire payer (numérique)</button>}
          {p.unpaid && p.obligationId && paying === p.obligationId && <AssistedPay obligationIds={[p.obligationId]} onClose={() => setPaying(null)} />}
          <span>{p.amount ? <Money items={[p.amount]} /> : 'montant après décision'} · {p.unpaid ? `impayée${p.overdueDays !== null ? ` depuis ${p.overdueDays} j` : ''}` : p.status === 'RETENU' ? 'payée' : `constat ${p.status.toLowerCase()}`} · {fmtDate(p.decidedAt ?? p.createdAt)}</span>
        </div>
      ))}
      <p className="small muted">L’usager paie par canal numérique (vous pouvez émettre sa référence sur place) ou en espèces dans un point agréé. Vous n’encaissez rien ; aucune mesure sur place.</p>
    </div>
  );
}

function ConstatForm({ zone, plate, checkId, evidence, onDone }: { zone: Zone; plate: string; checkId: string; evidence: Evidence; onDone: () => void }) {
  const [nature, setNature] = useState('NON_PAIEMENT');
  const [obs, setObs] = useState('');
  const [done, setDone] = useState<Violation | null>(null);
  const act = useAction();
  // Une clé par constat : une relance après coupure réseau ou double appui ne crée jamais deux constats.
  const idem = useRef(newIdempotencyKey());
  if (done) {
    return (
      <div className="result-card" role="status">
        <StatusBadge tone="good" label="Constat enregistré" />
        <p className="small">Référence <span className="mono">{done.reference}</span> · {done.photos?.length ?? evidence.photoIds.length} photo(s) jointe(s). Il sera vérifié par le superviseur puis décidé par une autre personne. Aucune pénalité n’est émise à ce stade.</p>
        <EvidencePhotos photos={done.photos ?? []} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Nouveau contrôle</button>
      </div>
    );
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (act.busy) return;
    void act.run(() => api<Violation>('/v1/parking/violations', {
      method: 'POST', idempotencyKey: idem.current,
      body: { zoneId: zone.id, plate, nature, checkId, photoIds: evidence.photoIds, place: evidence.place, lat: evidence.lat, lon: evidence.lon, ...(evidence.accuracy !== null ? { gpsAccuracyM: evidence.accuracy } : {}), observations: obs || 'Constat sur place.' },
    }).catch((err: unknown) => { if (isDefinitiveRejection(err)) idem.current = newIdempotencyKey(); throw err; }), setDone);
  }
  return (
    <form className="form panel" onSubmit={submit} aria-label="Constat">
      <p className="pk-row-title">Constat — <span className="pk-plate">{plate}</span></p>
      <p className="small"><Icon name="camera" size={14} /> {evidence.photoIds.length} photo(s) horodatée(s) et géolocalisée(s) · {evidence.place}</p>
      <label className="field"><span className="label">Nature présumée</span>
        <select value={nature} onChange={(e) => setNature(e.target.value)}>{Object.entries(NATURE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
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
                  {v.evidence.place && <span>Lieu : {v.evidence.place}</span>}
                </div>
              )}
              <EvidencePhotos photos={v.photos ?? []} />
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
