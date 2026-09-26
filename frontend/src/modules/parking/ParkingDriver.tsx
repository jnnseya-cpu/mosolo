/**
 * Espace de l'usager — MOSOLO Parking (ParkSmart) : démarrer, prolonger ou terminer une session liée à la plaque,
 * payer par le circuit commun, historique, réservations de voirie, constats et contestation, parkings partenaires.
 * Aucun montant n'est calculé dans l'interface : le moteur de liquidation applique la règle publiée.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { DataTable } from '../../components/DataTable';
import { useApi } from '../../hooks/useApi';
import { api, newIdempotencyKey } from '../../lib/api';
import {
  DemoTag, ErrorLine, fmtMinutes, LightBadge, MiniMap, Money, NATURE, PAYMENT_STATE, PayButton, PURPOSE, SESSION_STATUS, useAction,
  VIOLATION_STATUS, ZONE_STATUS, type ObligationSummary, type Partner, type Reservation, type Session, type Violation, type Zone,
} from './shared';
import './parking.css';
import { PrintProofLink } from '../preuves/PrintLink';

type Tab = 'sessions' | 'start' | 'reservations' | 'violations' | 'partners';
const DURATIONS = [15, 30, 60, 120, 180, 240];

export default function ParkingDriver() {
  const { user } = useApp();
  const [tab, setTab] = useState<Tab>('sessions');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const hasAccount = !!user?.taxpayerId;
  const zones = useApi(() => api<{ items: Zone[] }>('/v1/parking/zones').then((r) => r.items), [user?.id, tick]);
  const sessions = useApi(hasAccount ? () => api<{ items: Session[] }>('/v1/parking/sessions/mine').then((r) => r.items) : null, [user?.id, tick]);
  const vehicles = useApi(hasAccount ? () => api<{ items: { plate: string }[] }>('/v1/parking/vehicles/mine').then((r) => r.items.map((v) => v.plate)) : null, [user?.id, tick]);

  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Parking · ParkSmart" title="Stationnement"
        lead="Payez votre stationnement depuis votre téléphone : le titre est lié à la plaque, aucun papier à montrer. Rappel avant l’expiration, prolongation à distance.">
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>

      {!hasAccount ? (
        <EmptyState title="Compte usager requis" icon="car">
          Choisissez un usager (contribuable) dans le sélecteur de l’en-tête, par exemple « Mbuyi Kalala » ou le marchand partenaire fictif.
        </EmptyState>
      ) : (
        <>
          <ExampleNotice text="Seules les zones de démonstration sont payantes ici (règle fictive). Les zones réelles restent « acte requis » tant que le zonage et la grille ne sont pas publiés." />
          <div className="seg seg-wrap pk-tabs" role="tablist" aria-label="Rubriques">
            {([['sessions', 'Mes sessions'], ['start', 'Démarrer'], ['reservations', 'Réservations'], ['violations', 'Constats'], ['partners', 'Parkings partenaires']] as [Tab, string][]).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          {tab === 'sessions' && <SessionsTab state={sessions} onChange={refresh} onStart={() => setTab('start')} />}
          {tab === 'start' && <StartTab zones={zones.data ?? []} loading={zones.loading} error={zones.error} plates={vehicles.data ?? []} onDone={() => { refresh(); }} />}
          {tab === 'reservations' && <ReservationsTab zones={zones.data ?? []} plates={vehicles.data ?? []} tick={tick} onChange={refresh} />}
          {tab === 'violations' && <ViolationsTab tick={tick} onChange={refresh} />}
          {tab === 'partners' && <PartnersTab tick={tick} />}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Sessions

function SessionsTab({ state, onChange, onStart }: { state: ReturnType<typeof useApi<Session[]>>; onChange: () => void; onStart: () => void }) {
  const { fmtDate } = useApp();
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  const all = state.data ?? [];
  const running = all.filter((s) => s.status === 'ACTIVE' || s.status === 'EN_ATTENTE_PAIEMENT');
  const past = all.filter((s) => !running.includes(s));
  return (
    <div className="stack">
      {running.length === 0 ? (
        <EmptyState title="Aucune session en cours" icon="parking">
          <button type="button" className="btn btn-primary btn-sm" onClick={onStart}><Icon name="parking" size={16} /> Démarrer une session</button>
        </EmptyState>
      ) : (
        <div className="pk-cards pk-cards-2">{running.map((s) => <SessionCard key={s.id} s={s} onChange={onChange} />)}</div>
      )}
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="history" size={18} /> Historique</h2><p className="panel-sub">Sessions terminées, expirées ou abandonnées.</p></div></header>
        <DataTable<Session>
          rows={past} rowKey={(s) => s.id} caption="Historique des sessions"
          empty={<p className="muted small">Aucune session passée.</p>}
          columns={[
            { key: 'plate', label: 'Plaque', primary: true, render: (s) => <span className="pk-plate">{s.plate}</span> },
            { key: 'zone', label: 'Zone', render: (s) => <>{s.zone?.name ?? '—'} <DemoTag show={!!s.zone?.demo} /></> },
            { key: 'start', label: 'Début', render: (s) => fmtDate(s.startAt ?? s.createdAt, true) },
            { key: 'dur', label: 'Durée payée', num: true, render: (s) => fmtMinutes(s.totalMinutes) },
            { key: 'amt', label: 'Montant', num: true, render: (s) => <Money items={s.total} /> },
            { key: 'st', label: 'État', render: (s) => <StatusBadge tone={SESSION_STATUS[s.status].tone} label={SESSION_STATUS[s.status].label} /> },
          ]}
        />
      </section>
    </div>
  );
}

function SessionCard({ s, onChange }: { s: Session; onChange: () => void }) {
  const { fmtDate } = useApp();
  const [minutes, setMinutes] = useState(30);
  const [ext, setExt] = useState<ObligationSummary | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const act = useAction();
  const st = SESSION_STATUS[s.status];
  return (
    <article className={`pk-card pk-ticket pk-ticket-${s.light}`} aria-label={`Session ${s.plate}`}>
      <div className="pk-card-head">
        <div className="min0">
          <span className="pk-plate"><Icon name="car" size={14} /> {s.plate}</span>
          <p className="pk-sub" style={{ marginTop: 6 }}>{s.zone?.name ?? '—'} · {s.zone?.commune} <DemoTag show={!!s.zone?.demo} /></p>
        </div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      {s.status === 'ACTIVE' ? (
        <div>
          <p className="caps-sm muted">Temps restant</p>
          {s.startAt && s.paidUntil ? <ValidityCountdown from={s.startAt} until={s.paidUntil} label="Stationnement payé" /> : <p className="pk-countdown">{fmtMinutes(s.remainingMinutes)}</p>}
          <p className="small">Valable jusqu’à {fmtDate(s.paidUntil ?? undefined, true)} · <LightBadge light={s.light} /></p>
          {s.ticketCode && <p className="small">Ticket <span className="mono">{s.ticketCode}</span> · vérifiable par QR, USSD, SMS et WhatsApp <PrintProofLink code={s.ticketCode} /></p>}
          {s.light === 'AMBRE' && <p className="small">Rappel envoyé : prolongez à distance pour éviter un constat.</p>}
        </div>
      ) : (
        <p className="small">La validité démarre dès la confirmation signée du paiement par le prestataire.</p>
      )}
      {s.pendingPayment && (
        <div className="stack-sm">
          <p className="small"><strong>Paiement attendu :</strong> <Money items={s.segments.find((g) => g.obligationId === s.pendingPayment)?.amount} /></p>
          <PayButton obligationId={s.pendingPayment} onDone={onChange} />
        </div>
      )}
      {s.status === 'ACTIVE' && !s.pendingPayment && (
        <div className="stack-sm">
          {ext ? (
            <p className="notice notice-ok">Prolongation de {fmtMinutes(minutes)} liquidée : <Money items={ext.amount} />. Réglez-la pour l’ajouter à votre titre.</p>
          ) : (
            <div className="row-actions">
              <label className="sr-only" htmlFor={`ext-${s.id}`}>Durée de prolongation</label>
              <select id={`ext-${s.id}`} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="input-sm">
                {DURATIONS.map((d) => <option key={d} value={d}>+ {fmtMinutes(d)}</option>)}
              </select>
              <button type="button" className="btn btn-secondary btn-sm" disabled={act.busy}
                onClick={() => void act.run(() => api<{ obligation: ObligationSummary }>(`/v1/parking/sessions/${s.id}/extend`, { method: 'POST', idempotencyKey: key, body: { durationMinutes: minutes } }), (r) => { setExt(r.obligation); setKey(newIdempotencyKey()); onChange(); })}>
                <Icon name="clock" size={16} /> Prolonger
              </button>
            </div>
          )}
        </div>
      )}
      <ErrorLine error={act.error} />
      <div className="pk-card-foot">
        <span className="small muted">Total : <Money items={s.total} /> · {fmtMinutes(s.totalMinutes)}</span>
        {(s.status === 'ACTIVE' || s.status === 'EN_ATTENTE_PAIEMENT') && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={act.busy}
            onClick={() => void act.run(() => api(`/v1/parking/sessions/${s.id}/end`, { method: 'POST', body: {} }), onChange)}>
            <Icon name="x" size={16} /> Terminer
          </button>
        )}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ Démarrer

function StartTab({ zones, loading, error, plates, onDone }: { zones: Zone[]; loading: boolean; error: unknown; plates: string[]; onDone: () => void }) {
  const open = zones.filter((z) => z.legalStatus === 'OUVERTE');
  const [zoneId, setZoneId] = useState('');
  const [plate, setPlate] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [declare, setDeclare] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const [result, setResult] = useState<{ session: Session; obligation: ObligationSummary } | null>(null);
  const act = useAction();
  const zone = open.find((z) => z.id === (zoneId || open[0]?.id));
  const plateValue = plate || plates[0] || '';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!zone) return;
    void act.run(async () => {
      if (declare && plateValue && !plates.includes(plateValue.toUpperCase())) await api('/v1/parking/vehicles', { method: 'POST', body: { plate: plateValue } });
      return api<{ session: Session; obligation: ObligationSummary }>('/v1/parking/sessions', { method: 'POST', idempotencyKey: key, body: { zoneId: zone.id, plate: plateValue, durationMinutes: minutes } });
    }, (r) => { setResult(r); setKey(newIdempotencyKey()); onDone(); });
  }

  if (loading && zones.length === 0) return <Loading />;
  if (error) return <ErrorState error={error} />;
  const statusColor = (z: Zone) => (z.legalStatus === 'OUVERTE' ? 'var(--flag-blue)' : z.legalStatus === 'SUSPENDUE' ? 'var(--gold)' : 'var(--ink-3)');
  return (
    <div className="pk-grid pk-grid-2">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="parking" size={18} /> Démarrer une session</h2><p className="panel-sub">Le montant est calculé par le moteur à partir de la grille publiée de la zone.</p></div></header>
        {result ? (
          <div className="stack">
            <div className="result-card" role="status">
              <p className="caps-sm muted">Session enregistrée</p>
              <p><span className="pk-plate">{result.session.plate}</span> · {result.session.zone?.name}</p>
              <dl className="kv kv-dense">
                <div><dt>Durée</dt><dd>{fmtMinutes(result.session.totalMinutes)}</dd></div>
                <div><dt>Montant (moteur)</dt><dd><Money items={result.obligation.amount} /></dd></div>
                <div><dt>Obligation</dt><dd className="mono">{result.obligation.id}</dd></div>
                <div><dt>Commune d’attribution</dt><dd>{result.obligation.commune ?? '—'}</dd></div>
              </dl>
            </div>
            <PayButton obligationId={result.obligation.id} onDone={onDone} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResult(null)}>Nouvelle session</button>
          </div>
        ) : open.length === 0 ? (
          <EmptyState title="Aucune zone payante ouverte" icon="ban">Les zones proposées attendent l’acte de zonage et la grille tarifaire.</EmptyState>
        ) : (
          <form className="form" onSubmit={submit}>
            <label className="field">
              <span className="label">Zone</span>
              <select value={zone?.id ?? ''} onChange={(e) => setZoneId(e.target.value)}>
                {open.map((z) => <option key={z.id} value={z.id}>{z.name} — {z.commune}{z.demo ? ' (démonstration)' : ''}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="label">Plaque d’immatriculation</span>
              <input className="pk-plate-input" list="pk-plates" value={plateValue} onChange={(e) => setPlate(e.target.value)} placeholder="KN-0000-XX" autoComplete="off" required />
              <datalist id="pk-plates">{plates.map((p) => <option key={p} value={p} />)}</datalist>
              <span className="hint">Titre lié à la plaque. Un marchand peut payer pour la plaque d’un client.</span>
            </label>
            {plateValue && !plates.includes(plateValue.trim().toUpperCase()) && (
              <label className="check"><input type="checkbox" checked={declare} onChange={(e) => setDeclare(e.target.checked)} /> Déclarer ce véhicule comme le mien (notifications de constat)</label>
            )}
            <fieldset className="field">
              <legend className="label">Durée</legend>
              <div className="seg seg-wrap">
                {DURATIONS.filter((d) => !zone?.maxDurationMinutes || d <= zone.maxDurationMinutes).map((d) => (
                  <button key={d} type="button" aria-pressed={minutes === d} onClick={() => setMinutes(d)}>{fmtMinutes(d)}</button>
                ))}
              </div>
            </fieldset>
            {zone?.tariffRule && (
              <div className="callout callout-info">
                <Icon name="scale" size={18} />
                <div className="small">
                  <p><strong>Grille appliquée :</strong> {zone.tariffRule.label} (v{zone.tariffRule.version}) <DemoTag show={zone.tariffRule.demo} label="Règle fictive" /></p>
                  <p>Tarif horaire du rang {zone.localityRank} : <Money items={zone.tariffRule.rateTable[`tarif_horaire:${zone.localityRank}`] && zone.tariffRule.currency ? { amount: zone.tariffRule.rateTable[`tarif_horaire:${zone.localityRank}`]!, currency: zone.tariffRule.currency as 'CDF' } : null} /></p>
                </div>
              </div>
            )}
            <ErrorLine error={act.error} />
            <button type="submit" className="btn btn-primary btn-block" disabled={act.busy || !plateValue}>{act.busy ? 'Envoi…' : 'Démarrer et obtenir le montant'}</button>
          </form>
        )}
      </section>
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="pin" size={18} /> Zones</h2><p className="panel-sub">Géométrie indicative. Gris : acte requis ; bleu : ouverte.</p></div></header>
        <MiniMap caption="Carte des zones de stationnement" height={240}
          shapes={zones.map((z) => ({ id: z.id, type: z.geometry.type, coordinates: z.geometry.coordinates, color: statusColor(z), label: `${z.name} — ${ZONE_STATUS[z.legalStatus].label}`, dashed: z.legalStatus !== 'OUVERTE' }))}
          onSelect={(id) => zones.find((z) => z.id === id && z.legalStatus === 'OUVERTE') && setZoneId(id)} />
        <ul className="list-rows" style={{ marginTop: 12 }}>
          {zones.map((z) => (
            <li key={z.id} className="list-row">
              <div className="min0"><p className="pk-row-title">{z.name}</p><p className="pk-sub">{z.commune} · {z.occupancy.capacity > 0 ? `${z.occupancy.free} place(s) libre(s) sur ${z.occupancy.capacity}` : 'capacité à recenser'}</p></div>
              <div className="row-side"><DemoTag show={z.demo} /><StatusBadge tone={ZONE_STATUS[z.legalStatus].tone} label={ZONE_STATUS[z.legalStatus].label} /></div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Réservations de voirie

function ReservationsTab({ zones, plates, tick, onChange }: { zones: Zone[]; plates: string[]; tick: number; onChange: () => void }) {
  const { fmtDate, user } = useApp();
  const list = useApi(() => api<{ items: Reservation[] }>('/v1/parking/reservations/mine').then((r) => r.items), [user?.id, tick]);
  const open = zones.filter((z) => z.legalStatus === 'OUVERTE');
  const tomorrow = useMemo(() => { const d = new Date(Date.now() + 86_400_000); d.setMinutes(0, 0, 0); return d; }, []);
  const [f, setF] = useState({ zoneId: '', purpose: 'LIVRAISON', places: 1, start: toLocalInput(tomorrow), hours: 2, plate: '', notes: '' });
  const act = useAction();
  function submit(e: FormEvent) {
    e.preventDefault();
    const start = new Date(f.start);
    void act.run(() => api('/v1/parking/reservations', {
      method: 'POST',
      body: { zoneId: f.zoneId || open[0]?.id, purpose: f.purpose, places: f.places, startAt: start.toISOString(), endAt: new Date(start.getTime() + f.hours * 3_600_000).toISOString(), ...(f.plate ? { plate: f.plate } : {}), ...(f.notes ? { notes: f.notes } : {}) },
    }), () => { onChange(); });
  }
  return (
    <div className="pk-grid pk-grid-2">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="clock" size={18} /> Mes réservations</h2><p className="panel-sub">Déménagements, chantiers, livraisons, événements : décision motivée de la régie, puis paiement.</p></div></header>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (list.data ?? []).length === 0 ? <p className="muted small">Aucune réservation.</p> : (
          <div className="pk-cards">
            {(list.data ?? []).map((r) => (
              <article key={r.id} className="pk-card">
                <div className="pk-card-head">
                  <div className="min0"><p className="pk-row-title">{PURPOSE[r.purpose] ?? r.purpose} · {r.places} place(s)</p><p className="pk-sub">{r.zone?.name} · {fmtDate(r.startAt, true)} → {fmtDate(r.endAt, true)}</p>{r.state === 'CONFIRMEE' && <ValidityCountdown compact from={r.startAt} until={r.endAt} label="Réservation" />}</div>
                  <StatusBadge tone={r.state === 'CONFIRMEE' ? 'good' : r.state === 'REFUSEE' ? 'critical' : r.state === 'DEMANDEE' ? 'neutral' : 'warning'} label={RES_STATE[r.state] ?? r.state} />
                </div>
                {r.decision && <p className="small"><strong>Motif de la décision :</strong> {r.decision.reason}</p>}
                {r.amount && <p className="small">Montant : <Money items={r.amount} /> · <StatusBadge tone={PAYMENT_STATE[r.payment]?.tone ?? 'neutral'} label={PAYMENT_STATE[r.payment]?.label ?? r.payment} /></p>}
                {r.state === 'EN_ATTENTE_PAIEMENT' && r.obligationId && <PayButton obligationId={r.obligationId} onDone={onChange} />}
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="send" size={18} /> Demander une réservation</h2><p className="panel-sub">Aucune surréservation : la capacité publiée est une borne stricte.</p></div></header>
        {open.length === 0 ? <p className="muted small">Aucune zone ouverte.</p> : (
          <form className="form" onSubmit={submit}>
            <label className="field"><span className="label">Zone</span>
              <select value={f.zoneId || open[0]!.id} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>{open.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></label>
            <div className="field-row">
              <label className="field"><span className="label">Objet</span>
                <select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>{Object.entries(PURPOSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="field"><span className="label">Places</span><input type="number" min={1} max={50} value={f.places} onChange={(e) => setF({ ...f, places: Number(e.target.value) })} /></label>
            </div>
            <div className="field-row">
              <label className="field"><span className="label">Début</span><input type="datetime-local" step={900} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
              <label className="field"><span className="label">Durée (heures)</span><input type="number" min={1} max={168} value={f.hours} onChange={(e) => setF({ ...f, hours: Number(e.target.value) })} /></label>
            </div>
            <label className="field"><span className="label">Plaque (facultatif)</span><input className="pk-plate-input" list="pk-plates-r" value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} />
              <datalist id="pk-plates-r">{plates.map((p) => <option key={p} value={p} />)}</datalist></label>
            <label className="field"><span className="label">Précisions</span><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
            <ErrorLine error={act.error} />
            <button type="submit" className="btn btn-primary" disabled={act.busy}>{act.busy ? 'Envoi…' : 'Envoyer la demande'}</button>
          </form>
        )}
      </section>
    </div>
  );
}

const RES_STATE: Record<string, string> = { DEMANDEE: 'Demandée', REFUSEE: 'Refusée', EN_ATTENTE_PAIEMENT: 'Approuvée — à payer', CONFIRMEE: 'Confirmée', TERMINEE: 'Terminée' };

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ Constats et contestation

function ViolationsTab({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate, user } = useApp();
  const list = useApi(() => api<{ items: Violation[] }>('/v1/parking/violations/mine').then((r) => r.items), [user?.id, tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = list.data ?? [];
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="shieldCheck" size={18} /><p className="small">Un constat est établi par un agent habilité, avec photographies et position ; il est vérifié par un superviseur puis décidé, avec motif, par une autre personne. Aucune amende, aucun blocage ni aucune fourrière n’est déclenché par un algorithme. Vous pouvez présenter vos observations avant la décision et former un recours après.</p></div>
      {items.length === 0 ? <EmptyState title="Aucun constat" icon="check">Aucun constat n’est rattaché aux plaques que vous avez déclarées.</EmptyState> : (
        <div className="pk-cards pk-cards-2">
          {items.map((v) => (
            <article key={v.id} className="pk-card">
              <div className="pk-card-head">
                <div className="min0"><p className="pk-row-title">{NATURE[v.nature] ?? v.nature}</p><p className="pk-sub">{v.reference} · <span className="pk-plate">{v.plate}</span> · {v.zone?.name}</p></div>
                <StatusBadge tone={VIOLATION_STATUS[v.status].tone} label={VIOLATION_STATUS[v.status].label} />
              </div>
              {v.evidence && (
                <div className="pk-evidence">
                  <span><Icon name="camera" size={14} /> {v.evidence.photoSha256.length} photographie(s) scellée(s) · {fmtDate(v.evidence.observedAt, true)}</span>
                  <span className="mono">{v.evidence.photoSha256[0]?.slice(0, 24)}…</span>
                  <span>{v.evidence.observations}</span>
                </div>
              )}
              {v.proposal && v.status === 'VERIFIE' && <p className="small"><strong>Proposition (barème) :</strong> {v.proposal.amount ? <Money items={v.proposal.amount} /> : 'aucune — acte requis'} · décision à venir</p>}
              {v.decision && <p className="small"><strong>Décision :</strong> {v.decision.reason} — {v.decision.effect}</p>}
              {v.obligation && (
                <div className="stack-sm">
                  <p className="small">Obligation <span className="mono">{v.obligation.id}</span> : <Money items={v.obligation.amount} /> · échéance {fmtDate(v.obligation.dueDate)} · <StatusBadge tone={PAYMENT_STATE[v.obligation.payment]?.tone ?? 'neutral'} label={PAYMENT_STATE[v.obligation.payment]?.label ?? v.obligation.payment} /></p>
                  {v.obligation.payment === 'AUCUNE_REFERENCE' && <PayButton obligationId={v.obligation.id} onDone={onChange} label="Payer par les canaux officiels" />}
                </div>
              )}
              {v.contests.map((c) => <p key={c.id} className="small muted">Contestation du {fmtDate(c.at, true)} ({c.stage === 'AVANT_DECISION' ? 'observations' : `recours ${c.appealId ?? ''}`}) : {c.grounds}</p>)}
              {(v.status === 'CONSTATE' || v.status === 'VERIFIE' || v.status === 'RETENU') && <ContestForm v={v} onDone={onChange} />}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ContestForm({ v, onDone }: { v: Violation; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [grounds, setGrounds] = useState('');
  const act = useAction();
  if (v.status === 'RETENU' && !v.obligation) return null;
  if (!open) return <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}><Icon name="scale" size={16} /> {v.status === 'RETENU' ? 'Former un recours' : 'Présenter mes observations'}</button>;
  return (
    <form className="form pk-reason" onSubmit={(e) => { e.preventDefault(); void act.run(() => api(`/v1/parking/violations/${v.id}/contest`, { method: 'POST', body: { grounds } }), () => { setOpen(false); onDone(); }); }}>
      <label className="field"><span className="label">Motifs</span><textarea rows={3} value={grounds} onChange={(e) => setGrounds(e.target.value)} placeholder="Exposez les faits (10 caractères au moins)." /></label>
      <ErrorLine error={act.error} />
      <div className="btn-row"><button type="submit" className="btn btn-primary btn-sm" disabled={act.busy}>Envoyer</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Annuler</button></div>
    </form>
  );
}

// ------------------------------------------------------------------ Parkings partenaires

function PartnersTab({ tick }: { tick: number }) {
  const { fmtDate } = useApp();
  const list = useApi(() => api<{ items: Partner[] }>('/v1/parking/partners').then((r) => r.items), [tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = (list.data ?? []).filter((p) => p.status === 'PARTENAIRE');
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="store" size={18} /> Parkings privés et marchands partenaires</h2><p className="panel-sub">Places libres déclarées par l’exploitant (donnée déclarative). Leurs tarifs privés ne transitent pas par MOSOLO.</p></div></header>
      {items.length === 0 ? <p className="muted small">Aucun partenaire conventionné.</p> : (
        <ul className="list-rows">
          {items.map((p) => (
            <li key={p.id} className="list-row">
              <div className="min0"><p className="pk-row-title">{p.name} <DemoTag show={p.demo} label="Fictif" /></p><p className="pk-sub">{p.kind === 'PARKING_PRIVE' ? 'Parking privé' : 'Marchand'} · {p.commune}, {p.quartier} · {p.capacity} places</p></div>
              <div className="row-side">{p.declaredFree ? <span className="small"><strong>{p.declaredFree.places}</strong> libre(s) · {fmtDate(p.declaredFree.at, true)}</span> : <span className="small muted">Non déclaré</span>}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
