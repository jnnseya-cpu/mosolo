/**
 * Régie du stationnement (R06/R07) — ParkSmart : décisions motivées sur les constats vérifiés, réservations de voirie,
 * gestion des zones (géométrie, capacité, rattachement à la grille publiée, suspension) et partenaires privés.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import {
  DemoTag, ErrorLine, hasRole, MiniMap, Money, NATURE, PAYMENT_STATE, pctText, PURPOSE, ReasonForm, useAction, VIOLATION_STATUS, ZONE_KIND, ZONE_STATUS,
  type Partner, type Reservation, type Violation, type Zone,
} from './shared';
import { EvidencePhotos } from './EvidencePhotos';
import { AgentCommissions } from './AgentEarnings';
import { ExemptionsPanel } from './Stationnement14';
import './parking.css';

type Tab = 'decisions' | 'reservations' | 'zones' | 'partners' | 'commissions' | 'exemptions';

export default function ParkingRegie() {
  const { user } = useApp();
  const [tab, setTab] = useState<Tab>('decisions');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  if (!hasRole(user?.roles, 'R06', 'R07')) {
    return (
      <div className="page">
        <PageHead eyebrow="MOSOLO Parking" title="Régie du stationnement" />
        <EmptyState title="Écran réservé à la régie" icon="lock">Choisissez « Cheffe de service Stationnement — DGTK » ou « Directeur général DGTK » dans l’en-tête.</EmptyState>
      </div>
    );
  }
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Parking · régie DGTK" title="Régie du stationnement"
        lead="Le système prépare ; la régie décide, avec motif. Aucune zone n’est payante sans acte de zonage et grille publiée au registre (quatre visas).">
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      <div className="seg seg-wrap pk-tabs" role="tablist" aria-label="Rubriques">
        {([['decisions', 'Décisions sur constats'], ['reservations', 'Réservations'], ['zones', 'Zones'], ['partners', 'Partenaires'], ['commissions', 'Commissions des agents (10 %)'], ['exemptions', 'Exemptions']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'decisions' && <Decisions tick={tick} onChange={refresh} />}
      {tab === 'reservations' && <Reservations tick={tick} onChange={refresh} />}
      {tab === 'zones' && <Zones tick={tick} onChange={refresh} />}
      {tab === 'partners' && <Partners tick={tick} onChange={refresh} />}
      {tab === 'commissions' && <AgentCommissions key={tick} />}
      {tab === 'exemptions' && <ExemptionsPanel tick={tick} />}
    </div>
  );
}

function Decisions({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate } = useApp();
  const list = useApi(() => api<{ items: Violation[] }>('/v1/parking/violations').then((r) => r.items), [tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const pending = (list.data ?? []).filter((v) => v.status === 'VERIFIE');
  const decided = (list.data ?? []).filter((v) => v.status === 'RETENU' || v.status === 'CLASSE');
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="scale" size={18} /><p className="small">Circuit unique : constat par l’agent → vérification par le superviseur → proposition du système selon le barème publié → <strong>votre décision motivée</strong> → notification → recours. Le blocage et la fourrière ne sont pas disponibles dans l’application : ils relèvent de l’autorité compétente, selon la procédure légale.</p></div>
      {pending.length === 0 ? <EmptyState title="Aucun constat vérifié en attente" icon="check" /> : (
        <div className="pk-cards pk-cards-2">
          {pending.map((v) => (
            <article key={v.id} className="pk-card">
              <div className="pk-card-head">
                <div className="min0"><p className="pk-row-title">{NATURE[v.nature] ?? v.nature} · <span className="pk-plate">{v.plate}</span></p><p className="pk-sub">{v.reference} · {v.zone?.name} · {fmtDate(v.createdAt, true)}</p></div>
                <StatusBadge tone={VIOLATION_STATUS[v.status].tone} label={VIOLATION_STATUS[v.status].label} />
              </div>
              <p className="pk-steps"><span className="on">Constat <b>{v.agentId}</b></span><span className="on">Vérification <b>{v.verification?.by}</b></span><span>Décision : vous</span></p>
              {v.evidence && <div className="pk-evidence"><span><Icon name="camera" size={14} /> {v.evidence.photoSha256.length} photo(s) scellée(s) · GPS {v.evidence.lat.toFixed(5)}, {v.evidence.lon.toFixed(5)}</span>{v.evidence.place && <span><Icon name="pin" size={14} /> {v.evidence.place}</span>}<span>{v.evidence.observations}</span><span className="muted">Vérification : {v.verification?.note}</span></div>}
              <EvidencePhotos photos={v.photos ?? []} />
              <p className="small"><strong>Proposition du système :</strong> {v.proposal?.amount ? <Money items={v.proposal.amount} /> : 'aucune pénalité (barème non publié)'} — <span className="muted">{v.proposal?.basis}</span></p>
              <p className="small">{v.holderIdentified ? 'Titulaire de la plaque identifié (compte déclaré).' : 'Titulaire non identifié : une décision retenue n’émettra aucune obligation.'}</p>
              {v.contests.length > 0 && <div className="pk-evidence"><strong>Observations de l’usager</strong>{v.contests.map((c) => <span key={c.id}>« {c.grounds} » ({fmtDate(c.at, true)})</span>)}</div>}
              <div className="pk-grid pk-grid-even">
                <ReasonForm confirmLabel="Retenir le constat" onSubmit={(reason) => api(`/v1/parking/violations/${v.id}/decide`, { method: 'POST', body: { outcome: 'RETENUE', reason } }).then(onChange)} />
                <ReasonForm confirmLabel="Classer sans suite" danger onSubmit={(reason) => api(`/v1/parking/violations/${v.id}/decide`, { method: 'POST', body: { outcome: 'CLASSEE', reason } }).then(onChange)} />
              </div>
            </article>
          ))}
        </div>
      )}
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="history" size={18} /> Décisions rendues</h2></div></header>
        <DataTable<Violation> rows={decided} rowKey={(v) => v.id} caption="Décisions rendues" empty={<p className="muted small">Aucune décision.</p>}
          columns={[
            { key: 'ref', label: 'Constat', primary: true, render: (v) => <span className="mono">{v.reference}</span> },
            { key: 'plate', label: 'Plaque', render: (v) => <span className="pk-plate">{v.plate}</span> },
            { key: 'dec', label: 'Décision', render: (v) => <StatusBadge tone={VIOLATION_STATUS[v.status].tone} label={VIOLATION_STATUS[v.status].label} /> },
            { key: 'reason', label: 'Motif', full: true, render: (v) => <span className="small">{v.decision?.reason} — {v.decision?.effect}</span> },
            { key: 'ob', label: 'Obligation', render: (v) => v.obligation ? <><Money items={v.obligation.amount} /> <StatusBadge tone={PAYMENT_STATE[v.obligation.payment]?.tone ?? 'neutral'} label={PAYMENT_STATE[v.obligation.payment]?.label ?? ''} /></> : '—' },
            { key: 'ct', label: 'Contestations', num: true, render: (v) => v.contests.length },
          ]} />
      </section>
    </div>
  );
}

function Reservations({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate } = useApp();
  const list = useApi(() => api<{ items: Reservation[] }>('/v1/parking/reservations').then((r) => r.items), [tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const pending = (list.data ?? []).filter((r) => r.status === 'DEMANDEE');
  const others = (list.data ?? []).filter((r) => r.status !== 'DEMANDEE');
  return (
    <div className="stack">
      {pending.length === 0 ? <EmptyState title="Aucune demande en attente" icon="check" /> : (
        <div className="pk-cards pk-cards-2">
          {pending.map((r) => (
            <article key={r.id} className="pk-card">
              <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{PURPOSE[r.purpose]} · {r.places} place(s)</p><p className="pk-sub">{r.reference} · {r.zone?.name}</p></div></div>
              <p className="small">{fmtDate(r.startAt, true)} → {fmtDate(r.endAt, true)}{r.plate ? <> · <span className="pk-plate">{r.plate}</span></> : null}</p>
              {r.notes && <p className="small muted">{r.notes}</p>}
              <p className="small muted">L’approbation liquide la redevance sur la grille publiée ; aucune surréservation n’est possible.</p>
              <div className="pk-grid pk-grid-even">
                <ReasonForm confirmLabel="Approuver" onSubmit={(reason) => api(`/v1/parking/reservations/${r.id}/decide`, { method: 'POST', body: { approve: true, reason } }).then(onChange)} />
                <ReasonForm confirmLabel="Refuser" danger onSubmit={(reason) => api(`/v1/parking/reservations/${r.id}/decide`, { method: 'POST', body: { approve: false, reason } }).then(onChange)} />
              </div>
            </article>
          ))}
        </div>
      )}
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title">Réservations traitées</h2></div></header>
        <DataTable<Reservation> rows={others} rowKey={(r) => r.id} caption="Réservations traitées" empty={<p className="muted small">Aucune.</p>}
          columns={[
            { key: 'ref', label: 'Référence', primary: true, render: (r) => <span className="mono">{r.reference}</span> },
            { key: 'obj', label: 'Objet', render: (r) => `${PURPOSE[r.purpose]} · ${r.places} pl.` },
            { key: 'when', label: 'Période', render: (r) => `${fmtDate(r.startAt, true)} → ${fmtDate(r.endAt, true)}` },
            { key: 'amt', label: 'Montant', num: true, render: (r) => <Money items={r.amount} /> },
            { key: 'st', label: 'État', render: (r) => <StatusBadge tone={r.state === 'CONFIRMEE' ? 'good' : r.state === 'REFUSEE' ? 'critical' : 'warning'} label={r.state.replace(/_/g, ' ').toLowerCase()} /> },
          ]} />
      </section>
    </div>
  );
}

function Zones({ tick, onChange }: { tick: number; onChange: () => void }) {
  const zones = useApi(() => api<{ items: Zone[] }>('/v1/parking/zones').then((r) => r.items), [tick]);
  const [sel, setSel] = useState<string | null>(null);
  if (zones.loading && !zones.data) return <Loading />;
  if (zones.error) return <ErrorState error={zones.error} onRetry={zones.reload} />;
  const all = zones.data ?? [];
  const current = all.find((z) => z.id === sel) ?? null;
  const color = (z: Zone) => (z.legalStatus === 'OUVERTE' ? 'var(--flag-blue)' : z.legalStatus === 'SUSPENDUE' ? 'var(--gold)' : 'var(--ink-3)');
  return (
    <div className="pk-grid pk-grid-2">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="parking" size={18} /> Zones</h2><p className="panel-sub">Sélectionnez une zone pour la rattacher à une grille publiée ou la suspendre.</p></div></header>
        <MiniMap caption="Carte des zones" height={260} onSelect={setSel}
          shapes={all.map((z) => ({ id: z.id, type: z.geometry.type, coordinates: z.geometry.coordinates, color: color(z), label: `${z.name} — ${ZONE_STATUS[z.legalStatus].label}`, dashed: z.legalStatus !== 'OUVERTE' }))} />
        <div className="pk-legend"><span><i style={{ background: 'var(--flag-blue)' }} /> Ouverte</span><span><i style={{ background: 'var(--gold)' }} /> Suspendue</span><span><i style={{ background: 'var(--ink-3)' }} /> Acte requis</span></div>
        <ul className="list-rows" style={{ marginTop: 12 }}>
          {all.map((z) => (
            <li key={z.id} className="list-row">
              <div className="min0"><p className="pk-row-title">{z.name}</p><p className="pk-sub">{z.code} · {ZONE_KIND[z.kind]} · {z.commune} · rang {z.localityRank} · {z.capacity.standard} places (+{z.capacity.livraison} livraison, {z.capacity.pmr} PMR) · occupation {pctText(z.occupancy.rate)}</p>
                <p className="pk-sub">Acte : {z.actReference ?? 'non publié'} · Grille : {z.tariffRule ? `${z.tariffRule.code} (${z.tariffRule.status})` : '—'}</p></div>
              <div className="row-side"><DemoTag show={z.demo} /><StatusBadge tone={ZONE_STATUS[z.legalStatus].tone} label={ZONE_STATUS[z.legalStatus].label} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSel(z.id)}>Gérer</button></div>
            </li>
          ))}
        </ul>
      </section>
      <div className="stack">
        {current ? <ZoneEditor key={current.id} zone={current} onChange={onChange} /> : <CreateZone onChange={onChange} />}
      </div>
    </div>
  );
}

function ZoneEditor({ zone, onChange }: { zone: Zone; onChange: () => void }) {
  const [rule, setRule] = useState(zone.tariffRuleCode ?? '');
  const [penalty, setPenalty] = useState(zone.penaltyRuleCode ?? '');
  const [act, setAct] = useState(zone.actReference ?? '');
  const a = useAction();
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title">{zone.name}</h2><p className="panel-sub">{zone.note}</p></div><StatusBadge tone={ZONE_STATUS[zone.legalStatus].tone} label={ZONE_STATUS[zone.legalStatus].label} /></header>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/v1/parking/zones/${zone.id}/tariff`, { method: 'POST', body: { tariffRuleCode: rule.trim() || null, penaltyRuleCode: penalty.trim() || null, actReference: act.trim() || null } }), onChange); }}>
        <label className="field"><span className="label">Référence de l’acte de zonage</span><input value={act} onChange={(e) => setAct(e.target.value)} placeholder="Arrêté n° … du …" /></label>
        <div className="field-row">
          <label className="field"><span className="label">Code de la grille (registre)</span><input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="ex. DEMO-PARK-HORAIRE" /></label>
          <label className="field"><span className="label">Code du barème des pénalités</span><input value={penalty} onChange={(e) => setPenalty(e.target.value)} placeholder="facultatif" /></label>
        </div>
        <p className="hint">Aucun montant n’est saisi ici : la zone n’ouvre que si la règle citée est ACTIVE (quatre visas, date d’effet atteinte).</p>
        <ErrorLine error={a.error} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={a.busy}>Enregistrer le rattachement</button>
      </form>
      <div style={{ marginTop: 16 }}>
        <ReasonForm confirmLabel={zone.suspended ? 'Rouvrir la zone' : 'Suspendre la zone'} danger={!zone.suspended}
          placeholder={zone.suspended ? 'Motif de réouverture' : 'Motif de suspension (chantier, événement…)'}
          onSubmit={(reason) => api(`/v1/parking/zones/${zone.id}/suspension`, { method: 'POST', body: { suspended: !zone.suspended, reason } }).then(onChange)} />
        {zone.suspended && <p className="small muted">Suspendue : {zone.suspended.reason}</p>}
      </div>
    </section>
  );
}

function CreateZone({ onChange }: { onChange: () => void }) {
  const [f, setF] = useState({ code: '', name: '', commune: 'Gombe', quartier: '', kind: 'SECTEUR', rank: 1, standard: 20, livraison: 2, pmr: 1, coords: '15.305,-4.303; 15.312,-4.302; 15.313,-4.308' });
  const a = useAction();
  function submit(e: FormEvent) {
    e.preventDefault();
    const coordinates = f.coords.split(';').map((p) => p.split(',').map((n) => Number(n.trim())) as [number, number]).filter((p) => p.length === 2 && p.every((n) => Number.isFinite(n)));
    void a.run(() => api('/v1/parking/zones', {
      method: 'POST',
      body: { code: f.code.trim().toUpperCase(), name: f.name, commune: f.commune, quartier: f.quartier, kind: f.kind, localityRank: f.rank, capacity: { standard: f.standard, livraison: f.livraison, pmr: f.pmr }, geometry: { type: f.kind === 'ARTERE' ? 'LineString' : 'Polygon', coordinates } },
    }), onChange);
  }
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="pin" size={18} /> Délimiter une zone</h2><p className="panel-sub">Créée au statut « acte requis ».</p></div></header>
      <form className="form" onSubmit={submit}>
        <div className="field-row">
          <label className="field"><span className="label">Code</span><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="KALAMU-MATONGE" required /></label>
          <label className="field"><span className="label">Type</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(ZONE_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <label className="field"><span className="label">Nom</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <div className="field-row">
          <label className="field"><span className="label">Commune</span><input value={f.commune} onChange={(e) => setF({ ...f, commune: e.target.value })} required /></label>
          <label className="field"><span className="label">Quartier ou axe</span><input value={f.quartier} onChange={(e) => setF({ ...f, quartier: e.target.value })} required /></label>
        </div>
        <div className="field-row">
          <label className="field"><span className="label">Rang de localité</span><select value={f.rank} onChange={(e) => setF({ ...f, rank: Number(e.target.value) })}>{[1, 2, 3, 4].map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          <label className="field"><span className="label">Places standard</span><input type="number" min={0} value={f.standard} onChange={(e) => setF({ ...f, standard: Number(e.target.value) })} /></label>
        </div>
        <div className="field-row">
          <label className="field"><span className="label">Places livraison</span><input type="number" min={0} value={f.livraison} onChange={(e) => setF({ ...f, livraison: Number(e.target.value) })} /></label>
          <label className="field"><span className="label">Places PMR</span><input type="number" min={0} value={f.pmr} onChange={(e) => setF({ ...f, pmr: Number(e.target.value) })} /></label>
        </div>
        <label className="field"><span className="label">Sommets (longitude,latitude ; …)</span><textarea rows={2} value={f.coords} onChange={(e) => setF({ ...f, coords: e.target.value })} /></label>
        <ErrorLine error={a.error} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={a.busy}>Créer la zone</button>
      </form>
    </section>
  );
}

function Partners({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate } = useApp();
  const list = useApi(() => api<{ items: (Partner & { lastStatus?: { reason: string; at: string } })[] }>('/v1/parking/partners').then((r) => r.items), [tick]);
  const [f, setF] = useState({ name: '', kind: 'PARKING_PRIVE', commune: 'Gombe', quartier: '', capacity: 50, lat: '-4.305', lon: '15.31' });
  const a = useAction();
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  return (
    <div className="pk-grid pk-grid-2">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="store" size={18} /> Parkings privés et marchands</h2><p className="panel-sub">Convention, suspension ou reprise : décision motivée. Aucun fonds privé ne transite par un compte public.</p></div></header>
        <div className="pk-cards">
          {(list.data ?? []).map((p) => (
            <article key={p.id} className="pk-card">
              <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{p.name} <DemoTag show={p.demo} label="Fictif" /></p><p className="pk-sub">{p.kind === 'PARKING_PRIVE' ? 'Parking privé' : 'Marchand'} · {p.commune} · {p.capacity} places{p.declaredFree ? ` · ${p.declaredFree.places} libres (déclaré le ${fmtDate(p.declaredFree.at, true)})` : ''}</p></div>
                <StatusBadge tone={p.status === 'PARTENAIRE' ? 'good' : p.status === 'SUSPENDU' ? 'critical' : 'neutral'} label={p.status === 'PARTENAIRE' ? 'Partenaire' : p.status === 'SUSPENDU' ? 'Suspendu' : 'Convention en cours'} /></div>
              {p.lastStatus && <p className="small muted">Dernière décision : {p.lastStatus.reason}</p>}
              <ReasonForm confirmLabel={p.status === 'PARTENAIRE' ? 'Suspendre' : 'Conventionner'} danger={p.status === 'PARTENAIRE'}
                onSubmit={(reason) => api(`/v1/parking/partners/${p.id}/status`, { method: 'POST', body: { status: p.status === 'PARTENAIRE' ? 'SUSPENDU' : 'PARTENAIRE', reason } }).then(onChange)} />
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title">Inscrire un partenaire</h2></div></header>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void a.run(() => api('/v1/parking/partners', { method: 'POST', body: { name: f.name, kind: f.kind, commune: f.commune, quartier: f.quartier, capacity: f.capacity, lat: Number(f.lat), lon: Number(f.lon) } }), onChange); }}>
          <label className="field"><span className="label">Nom</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <div className="field-row">
            <label className="field"><span className="label">Type</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PARKING_PRIVE">Parking privé</option><option value="MARCHAND">Marchand</option></select></label>
            <label className="field"><span className="label">Capacité</span><input type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} /></label>
          </div>
          <div className="field-row">
            <label className="field"><span className="label">Commune</span><input value={f.commune} onChange={(e) => setF({ ...f, commune: e.target.value })} /></label>
            <label className="field"><span className="label">Quartier</span><input value={f.quartier} onChange={(e) => setF({ ...f, quartier: e.target.value })} required /></label>
          </div>
          <div className="field-row">
            <label className="field"><span className="label">Latitude</span><input value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} /></label>
            <label className="field"><span className="label">Longitude</span><input value={f.lon} onChange={(e) => setF({ ...f, lon: e.target.value })} /></label>
          </div>
          <ErrorLine error={a.error} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={a.busy}>Inscrire</button>
        </form>
      </section>
    </div>
  );
}
