/**
 * Supervision terrain : préparation et affectation des missions, revue indépendante des constats,
 * contrôle qualité (échantillonnage, contre-visites, taux d'erreur) et indicateurs de production.
 * Le système signale et propose ; une personne habilitée décide, avec motif tracé.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable, type Column } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { ChartCard } from '../../components/ChartCard';
import { ChartTooltip, useChartColors } from '../../components/charts';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { hasRole, Progress, ReasonDrawer, useFeedback } from './common';
import { FINDING_STATUS, FLAG_LABEL, fmtPct, MISSION_STATUS, moduleLabel, OUTCOME_LABEL } from './labels';
import type { CounterVisit, FieldAgent, Finding, Indicators, Lot, Mission, QualityBoard, QualityRow } from './types';
import './terrain.css';

type Tab = 'missions' | 'findings' | 'quality' | 'production';

function Kpis({ ind }: { ind: Indicators }) {
  return (
    <dl className="tr-kpis">
      <div><dt>Missions</dt><dd>{ind.missions.total}<small>{ind.missions.byStatus.A_AFFECTER} à affecter · {ind.missions.overdue} en retard</small></dd></div>
      <div><dt>Constats</dt><dd>{ind.findings.total}<small>{fmtPct(ind.findings.withPhotoPct)} avec photo scellée</small></dd></div>
      <div><dt>Validés</dt><dd>{ind.findings.validated}<small>{ind.findings.rejected} rejetés</small></dd></div>
      <div><dt>À revoir</dt><dd>{ind.findings.pending}<small>revue indépendante</small></dd></div>
      <div><dt>Écarts GPS</dt><dd>{fmtPct(ind.findings.flaggedPct)}<small>des constats signalés</small></dd></div>
    </dl>
  );
}

function MissionForm({ lots, onDone }: { lots: Lot[]; onDone: () => void }) {
  const fb = useFeedback();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ lotId: '', title: '', commune: 'Limete', quartier: '', lat: '-4.3712', lon: '15.3441', radiusM: '300', objectIds: '', findings: '10', periodStart: today, dueDate: '', instructions: 'Aucune demande d’argent ; photo selon le protocole ; constat sans conclusion sur la propriété.' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lot = lots.find((l) => l.id === f.lotId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await fb.run(() => api('/v1/terrain/missions', {
      method: 'POST',
      body: {
        ...(f.lotId ? { lotId: f.lotId } : {}), title: f.title.trim(), commune: lot?.commune ?? f.commune.trim(), ...(f.quartier.trim() ? { quartier: f.quartier.trim() } : {}),
        center: { lat: Number(f.lat), lon: Number(f.lon) }, radiusM: Number(f.radiusM),
        objectIds: f.objectIds.split(/[\s,;]+/).filter(Boolean), objectives: { findings: Number(f.findings) },
        periodStart: f.periodStart, dueDate: f.dueDate, instructions: f.instructions,
      },
    }), 'Mission créée.');
    if (ok) onDone();
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      {fb.node}
      <div className="field">
        <label className="label" htmlFor="mf-lot">Lot (sous-traitance)</label>
        <select id="mf-lot" value={f.lotId} onChange={set('lotId')}>
          <option value="">Équipe interne de la régie (sans lot)</option>
          {lots.filter((l) => l.status === 'OUVERT').map((l) => <option key={l.id} value={l.id}>{l.id} — {l.commune} ({l.periodStart} → {l.periodEnd}){l.probation ? ' · probatoire' : ''}</option>)}
        </select>
        {lot && <span className="hint">La mission doit rester dans la commune {lot.commune}{lot.quartiers.length ? ` (${lot.quartiers.join(', ')})` : ''} et entre le {lot.periodStart} et le {lot.periodEnd} : toute mission hors lot est refusée.</span>}
      </div>
      <div className="field"><label className="label" htmlFor="mf-title">Intitulé</label><input id="mf-title" value={f.title} onChange={set('title')} required minLength={3} /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="mf-commune">Commune</label><input id="mf-commune" value={lot?.commune ?? f.commune} onChange={set('commune')} disabled={!!lot} /></div>
        <div className="field"><label className="label" htmlFor="mf-q">Quartier</label><input id="mf-q" value={f.quartier} onChange={set('quartier')} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="mf-lat">Centre — latitude</label><input id="mf-lat" inputMode="decimal" value={f.lat} onChange={set('lat')} /></div>
        <div className="field"><label className="label" htmlFor="mf-lon">Centre — longitude</label><input id="mf-lon" inputMode="decimal" value={f.lon} onChange={set('lon')} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="mf-r">Rayon de la zone (m)</label><input id="mf-r" inputMode="numeric" value={f.radiusM} onChange={set('radiusM')} /></div>
        <div className="field"><label className="label" htmlFor="mf-obj">Objectif (constats)</label><input id="mf-obj" inputMode="numeric" value={f.findings} onChange={set('findings')} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="mf-ids">Objets assignés (identifiants, facultatif)</label><input id="mf-ids" className="mono" value={f.objectIds} onChange={set('objectIds')} placeholder="OBJ-DEMO-PARCELLE-01, …" /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="mf-start">Début</label><input id="mf-start" type="date" value={f.periodStart} onChange={set('periodStart')} required /></div>
        <div className="field"><label className="label" htmlFor="mf-due">Échéance</label><input id="mf-due" type="date" value={f.dueDate} onChange={set('dueDate')} required /></div>
      </div>
      <div className="field"><label className="label" htmlFor="mf-ins">Consignes</label><textarea id="mf-ins" rows={3} value={f.instructions} onChange={set('instructions')} /></div>
      <button type="submit" className="btn btn-primary btn-block" disabled={!f.title.trim() || !f.dueDate}><Icon name="check" size={18} /> Créer la mission</button>
    </form>
  );
}

function AssignForm({ mission, agents, onDone }: { mission: Mission; agents: FieldAgent[]; onDone: () => void }) {
  const fb = useFeedback();
  const eligible = agents.filter((a) => a.status === 'HABILITE' && (a.subcontractorId ?? null) === (mission.subcontractorId ?? null));
  const [agentId, setAgentId] = useState(eligible.find((a) => a.habilitation?.communes.includes(mission.commune))?.id ?? '');
  async function submit() {
    const ok = await fb.run(() => api(`/v1/terrain/missions/${mission.id}/assignment`, { method: 'POST', body: { agentId } }), 'Mission affectée ; l’agent est notifié.');
    if (ok) onDone();
  }
  return (
    <div className="form">
      {fb.node}
      <p className="small">{mission.title} · {mission.commune}{mission.quartier ? ` / ${mission.quartier}` : ''} · échéance {mission.dueDate}</p>
      <div className="field">
        <label className="label" htmlFor="as-agent">Agent habilité</label>
        <select id="as-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Choisir…</option>
          {eligible.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.habilitation?.communes.includes(mission.commune)}>
              {a.displayName} — {a.habilitation?.communes.join(', ')}{a.habilitation?.communes.includes(mission.commune) ? '' : ' (hors zone)'}
            </option>
          ))}
        </select>
        <span className="hint">Seuls les agents habilités par la régie, de la structure titulaire du lot et habilités pour la commune sont proposés. Le serveur refuse l’affectation d’un agent à son propre quartier ou aux objets de ses proches déclarés.</span>
      </div>
      <button type="button" className="btn btn-primary btn-block" disabled={!agentId} onClick={() => void submit()}>Affecter</button>
    </div>
  );
}

function FindingRow({ f, canReview, onReview }: { f: Finding; canReview: boolean; onReview: (f: Finding, d: 'VALIDE' | 'REJETE') => void }) {
  const { fmtDate } = useApp();
  const st = FINDING_STATUS[f.status];
  const cv = f.counterVisit;
  const blocked = f.status === 'A_CONTRE_VISITER' && cv && cv.status !== 'REALISEE';
  return (
    <li className="list-row">
      <div className="min0" style={{ flex: '1 1 320px' }}>
        <p className="tr-row-title">{OUTCOME_LABEL[f.outcome]} · {f.objectId ?? 'nouvel objet'}</p>
        <p className="tr-sub">{f.agentName} · mission <span className="mono">{f.missionId}</span> · {f.commune} · saisi le {fmtDate(f.capturedAt, true)}</p>
        {f.observations && <p className="small" style={{ marginTop: 4 }}>{f.observations}</p>}
        <p className="tr-sub" style={{ marginTop: 4 }}>
          GPS {f.gps.lat.toFixed(5)}, {f.gps.lon.toFixed(5)} (± {Math.round(f.gps.accuracyM)} m) · {f.distanceM} m du point {f.reference.kind === 'OBJET' ? 'enregistré' : 'central'} (tolérance {f.toleranceM} m)
        </p>
        <p className="tr-sub">Photo : {f.photoSha256 ? <span className="tr-mono">SHA-256 {f.photoSha256.slice(0, 16)}…</span> : 'aucune'} · scellé <span className="tr-mono">{f.seal.slice(0, 12)}…</span></p>
        {f.flagMessage && <p className="tr-flag"><Icon name="gps" size={16} /> {f.flagMessage}</p>}
        {f.justification && <p className="small muted">Justification de l’agent : {f.justification}</p>}
        {f.flags.length > 0 && <div className="tr-chips">{f.flags.map((x) => <span key={x} className="tag">{FLAG_LABEL[x] ?? x}</span>)}</div>}
        {cv && <p className="small" style={{ marginTop: 4 }}>Contre-visite : {cv.status === 'REALISEE' ? `${cv.result === 'CONFORME' ? 'conforme' : 'non conforme'} — proposition : ${cv.result === 'CONFORME' ? 'valider' : 'rejeter'}` : cv.status === 'A_FAIRE' ? `confiée à ${cv.assignedName ?? '—'}` : 'à affecter'}</p>}
        {f.review && <p className="small muted">Décision : {f.review.decision === 'VALIDE' ? 'validé' : 'rejeté'} le {fmtDate(f.review.at, true)} — {f.review.reason}</p>}
      </div>
      <div className="row-side" style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
        <StatusBadge tone={st.tone} label={st.label} />
        {canReview && (f.status === 'SOUMIS' || f.status === 'A_CONTRE_VISITER') && (
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!!blocked} onClick={() => onReview(f, 'VALIDE')}><Icon name="check" size={16} /> Valider</button>
            <button type="button" className="btn btn-sm btn-secondary" disabled={!!blocked} onClick={() => onReview(f, 'REJETE')}><Icon name="x" size={16} /> Rejeter</button>
          </div>
        )}
        {blocked && <span className="small muted">En attente de la contre-visite</span>}
      </div>
    </li>
  );
}

function qualityColumns(kind: string): Column<QualityRow>[] {
  return [
    { key: 'l', label: kind, primary: true, render: (r) => r.label },
    { key: 's', label: 'Constats', num: true, render: (r) => r.submitted },
    { key: 'v', label: 'Validés', num: true, render: (r) => r.validated },
    { key: 'rj', label: 'Taux de rejet', num: true, render: (r) => fmtPct(r.rejectionRatePct) },
    { key: 'cv', label: 'Contre-visites', num: true, render: (r) => r.counterVisitsDone },
    { key: 'er', label: 'Taux d’erreur', num: true, render: (r) => fmtPct(r.errorRatePct) },
    { key: 'fl', label: 'Écarts GPS', num: true, render: (r) => r.flagged },
    { key: 'mc', label: 'Contrôles mystère', num: true, render: (r) => (r.mysteryChecks ? `${r.mysteryChecks} (${r.mysteryIrregularities} irrég.)` : '—') },
    { key: 'dl', label: 'Délai de revue', num: true, render: (r) => (r.avgReviewDelayHours ? `${r.avgReviewDelayHours.replace('.', ',')} h` : '—') },
  ];
}

export default function Supervision() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles;
  const uid = user?.id;
  const [tab, setTab] = useState<Tab>('missions');
  const [filter, setFilter] = useState<'A_REVOIR' | 'SIGNALES' | 'TOUS'>('A_REVOIR');
  const ind = useApi(() => api<Indicators>('/v1/terrain/indicators'), [uid]);
  const missions = useApi(() => api<{ items: Mission[] }>('/v1/terrain/missions'), [uid]);
  const findings = useApi(() => api<{ items: Finding[] }>('/v1/terrain/findings'), [uid]);
  const agents = useApi(() => api<{ items: FieldAgent[] }>('/v1/terrain/agents').catch(() => ({ items: [] as FieldAgent[] })), [uid]);
  const lots = useApi(() => api<{ items: Lot[] }>('/v1/terrain/lots').catch(() => ({ items: [] as Lot[] })), [uid]);
  const quality = useApi(() => api<QualityBoard>('/v1/terrain/quality').catch(() => null), [uid]);
  const visits = useApi(() => api<{ items: CounterVisit[] }>('/v1/terrain/counter-visits').catch(() => ({ items: [] as CounterVisit[] })), [uid]);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<Mission | null>(null);
  const [reviewing, setReviewing] = useState<{ f: Finding; d: 'VALIDE' | 'REJETE' } | null>(null);
  const fb = useFeedback();
  const [rate, setRate] = useState('5');
  const [scopeSt, setScopeSt] = useState('');
  const [cvAgent, setCvAgent] = useState<Record<string, string>>({});
  const { cat, theme } = useChartColors();

  const canCreate = hasRole(roles, 'R07', 'R09', 'R35');
  const canReview = hasRole(roles, 'R09', 'R11');
  const canSample = hasRole(roles, 'R09', 'R11', 'R22');
  const reloadAll = () => { ind.reload(); missions.reload(); findings.reload(); quality.reload(); visits.reload(); };

  const shownFindings = useMemo(() => (findings.data?.items ?? []).filter((f) =>
    filter === 'TOUS' ? true : filter === 'SIGNALES' ? f.flags.some((x) => x === 'DISTANCE' || x === 'HORS_ZONE') : f.status === 'SOUMIS' || f.status === 'A_CONTRE_VISITER'), [findings.data, filter]);
  const stIds = useMemo(() => [...new Set((agents.data?.items ?? []).map((a) => a.subcontractorId).filter((x): x is string => !!x))], [agents.data]);
  const regieAgents = (agents.data?.items ?? []).filter((a) => a.status === 'HABILITE' && !a.subcontractorId);

  if (!user) return <div className="page"><EmptyState title="Choisissez un utilisateur de démonstration (superviseur, contrôleur, responsable de module…)" icon="users" /></div>;
  if (ind.error) return <div className="page"><PageHead eyebrow="Opérations de terrain" title="Supervision terrain" /><ErrorState error={ind.error} onRetry={ind.reload} /></div>;

  const missionCols: Column<Mission>[] = [
    { key: 't', label: 'Mission', primary: true, full: true, render: (m) => (<div className="min0"><p className="tr-row-title">{m.title}</p><p className="tr-sub"><span className="mono">{m.id}</span>{m.lotId ? ` · lot ${m.lotId}` : ' · équipe interne'} · {moduleLabel(m.module)}{m.demo ? ' · démo' : ''}</p></div>) },
    { key: 'z', label: 'Zone', render: (m) => `${m.commune}${m.quartier ? ` / ${m.quartier}` : ''} · ${m.radiusM} m` },
    { key: 'a', label: 'Agent', render: (m) => m.agentName ?? <span className="muted">non affectée</span> },
    { key: 'd', label: 'Échéance', render: (m) => <span>{fmtDate(m.dueDate)}{m.overdue ? <> <StatusBadge tone="critical" label="En retard" /></> : null}</span> },
    { key: 'p', label: 'Objectif', render: (m) => <Progress pct={m.progress.objectivePct} label={`${m.progress.findings} / ${m.objectives.findings} constats · ${m.progress.validated} validés`} /> },
    { key: 's', label: 'Statut', render: (m) => <StatusBadge tone={MISSION_STATUS[m.status].tone} label={MISSION_STATUS[m.status].label} /> },
    { key: 'x', label: 'Action', render: (m) => (canCreate && (m.status === 'A_AFFECTER' || m.status === 'AFFECTEE')
      ? <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAssigning(m)}><Icon name="users" size={16} /> {m.assignedAgentId ? 'Réaffecter' : 'Affecter'}</button> : null) },
  ];

  const communeData = (ind.data?.byCommune ?? []).map((c) => ({ commune: c.commune, Constats: c.findings, Validés: c.validated, Objectif: c.objectiveTarget }));

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Opérations de terrain" title="Supervision terrain" lead="Missions, revue indépendante des constats, contrôle qualité et production. Le système signale les écarts ; la décision revient à une personne habilitée, avec motif tracé." />
      <div className="callout callout-danger" role="note"><Icon name="cash" size={20} /><p><strong>Aucun encaissement sur le terrain.</strong> Agents, superviseurs et sous-traitants ne manipulent jamais d’argent ; un constat ne crée jamais de dette.</p></div>
      {ind.data ? <Kpis ind={ind.data} /> : <Loading />}
      <ExampleNotice text="Missions, agents et constats de démonstration : données fictives." />

      <div className="seg seg-wrap tr-tabs" role="group" aria-label="Sections">
        {([['missions', 'Missions'], ['findings', 'Constats à revoir'], ['quality', 'Contrôle qualité'], ['production', 'Production']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {fb.node}

      {tab === 'missions' && (
        <section className="section" aria-labelledby="ms-t">
          <div className="section-head"><h2 id="ms-t">Missions</h2><span className="count">{missions.data?.items.length ?? 0}</span>
            {canCreate && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="pin" size={18} /> Nouvelle mission</button>}
          </div>
          {missions.loading ? <Loading /> : missions.error ? <ErrorState error={missions.error} onRetry={missions.reload} /> : (
            <DataTable columns={missionCols} rows={missions.data?.items ?? []} rowKey={(m) => m.id} caption="Missions" empty={<EmptyState title="Aucune mission dans votre périmètre." icon="pin" />} />
          )}
        </section>
      )}

      {tab === 'findings' && (
        <section className="section" aria-labelledby="fd-t">
          <div className="section-head"><h2 id="fd-t">Constats</h2><span className="count">{shownFindings.length}</span></div>
          <div className="seg seg-sm seg-wrap" role="group" aria-label="Filtre">
            {([['A_REVOIR', 'À revoir'], ['SIGNALES', 'Écart GPS signalé'], ['TOUS', 'Tous']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          {!canReview && <p className="small muted">Lecture seule : la validation relève d’un superviseur ou d’un contrôleur de la régie, jamais de l’auteur ni de sa structure.</p>}
          {findings.loading ? <Loading /> : shownFindings.length === 0 ? <EmptyState title="Aucun constat dans ce filtre." icon="check" /> : (
            <ul className="list-rows">{shownFindings.map((f) => <FindingRow key={f.id} f={f} canReview={canReview && f.agentId !== uid} onReview={(x, d) => setReviewing({ f: x, d })} />)}</ul>
          )}
        </section>
      )}

      {tab === 'quality' && (
        <section className="section" aria-labelledby="q-t">
          <div className="tr-grid tr-grid-2">
            <div className="panel">
              <div className="panel-head"><h2 className="panel-title" id="q-t">Contre-visites</h2></div>
              <p className="small muted">{quality.data?.method}</p>
              {canSample && (
                <div className="tr-inline-form">
                  <div className="field-row">
                    <div className="field"><label className="label" htmlFor="q-rate">Taux d’échantillonnage (%)</label><input id="q-rate" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
                    <div className="field"><label className="label" htmlFor="q-st">Périmètre</label>
                      <select id="q-st" value={scopeSt} onChange={(e) => setScopeSt(e.target.value)}>
                        <option value="">Tous les constats soumis</option>
                        {stIds.map((s) => <option key={s} value={s}>Sous-traitant {s}</option>)}
                      </select>
                    </div>
                  </div>
                  <button type="button" className="btn btn-primary" onClick={() => void fb.run(() => api('/v1/terrain/quality/samples', { method: 'POST', body: { ratePercent: Number(rate), ...(scopeSt ? { subcontractorId: scopeSt } : {}) } }), 'Échantillon tiré : les constats sélectionnés passent en contre-visite.').then(reloadAll)}>
                    <Icon name="refresh" size={18} /> Tirer un échantillon
                  </button>
                </div>
              )}
              {(visits.data?.items ?? []).length === 0 ? <EmptyState title="Aucune contre-visite en cours." icon="check" /> : (
                <ul className="list-rows">
                  {(visits.data?.items ?? []).map((c) => (
                    <li key={c.id} className="list-row">
                      <div className="min0">
                        <p className="tr-row-title"><span className="mono">{c.id}</span> · constat <span className="mono">{c.findingId}</span></p>
                        <p className="tr-sub">{c.commune} · mission {c.missionId} · {c.status === 'REALISEE' ? `réalisée : ${c.result === 'CONFORME' ? 'conforme' : 'non conforme'}${c.distanceToOriginalM !== undefined ? ` · ${c.distanceToOriginalM} m du constat initial` : ''}` : c.assignedName ? `confiée à ${c.assignedName}` : 'à affecter'}</p>
                      </div>
                      {canSample && c.status !== 'REALISEE' ? (
                        <div className="row-actions">
                          <select aria-label="Agent de contre-visite" value={cvAgent[c.id] ?? ''} onChange={(e) => setCvAgent((x) => ({ ...x, [c.id]: e.target.value }))}>
                            <option value="">Agent de la régie…</option>
                            {regieAgents.filter((a) => a.id !== c.originalAgentId && (!c.commune || a.habilitation?.communes.includes(c.commune))).map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                          </select>
                          <button type="button" className="btn btn-sm btn-secondary" disabled={!cvAgent[c.id]} onClick={() => void fb.run(() => api(`/v1/terrain/counter-visits/${c.id}/assignment`, { method: 'POST', body: { agentId: cvAgent[c.id] } }), 'Contre-visite confiée.').then(() => visits.reload())}>Confier</button>
                        </div>
                      ) : <StatusBadge tone={c.status === 'REALISEE' ? (c.result === 'CONFORME' ? 'good' : 'critical') : 'warning'} label={c.status === 'REALISEE' ? (c.result === 'CONFORME' ? 'Conforme' : 'Non conforme') : 'En attente'} />}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="panel">
              <div className="panel-head"><h2 className="panel-title">Qualité par sous-traitant</h2></div>
              <DataTable columns={qualityColumns('Structure')} rows={quality.data?.bySubcontractor ?? []} rowKey={(r) => r.key} caption="Qualité par sous-traitant" empty={<EmptyState title="Aucun constat." />} />
            </div>
          </div>
          <div className="panel tr-section">
            <div className="panel-head"><h2 className="panel-title">Qualité par agent</h2></div>
            <DataTable columns={qualityColumns('Agent')} rows={quality.data?.byAgent ?? []} rowKey={(r) => r.key} caption="Qualité par agent" empty={<EmptyState title="Aucun constat." />} />
            <p className="small muted tr-table-note">Taux d’erreur = contre-visites non conformes / contre-visites réalisées. Taux de rejet = constats rejetés / constats revus. Ces indicateurs éclairent une décision humaine ; ils ne déclenchent aucune sanction automatique.</p>
          </div>
        </section>
      )}

      {tab === 'production' && ind.data && (
        <section className="section tr-grid tr-grid-2">
          <ChartCard title="Constats par commune" subtitle="Constats saisis, validés et objectif des missions" example
            table={{ columns: ['Commune', 'Constats', 'Validés', 'Objectif'], rows: communeData.map((c) => [c.commune, c.Constats, c.Validés, c.Objectif]) }}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={communeData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke={theme.grid} />
                <XAxis dataKey="commune" tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis allowDecimals={false} tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
                <Bar dataKey="Constats" fill={cat[0]} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Validés" fill={cat[1]} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Objectif" fill={cat[2]} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <div className="panel">
            <div className="panel-head"><h2 className="panel-title">Tableau de production</h2></div>
            <DataTable
              columns={[
                { key: 'c', label: 'Commune', primary: true, render: (c) => c.commune },
                { key: 'm', label: 'Missions', num: true, render: (c) => c.missions },
                { key: 'f', label: 'Constats', num: true, render: (c) => c.findings },
                { key: 'o', label: 'Objectif', num: true, render: (c) => fmtPct(c.objectivePct) },
                { key: 'g', label: 'Écarts GPS', num: true, render: (c) => c.flagged },
                { key: 't', label: 'Tolérance', num: true, render: (c) => `${c.toleranceM} m` },
              ]}
              rows={ind.data.byCommune} rowKey={(c) => c.commune} caption="Production par commune"
            />
            <dl className="kv kv-dense" style={{ marginTop: 12 }}>
              <div><dt>Agents habilités</dt><dd>{ind.data.agents.habilitated} / {ind.data.agents.total} ({ind.data.agents.invited} en attente d’habilitation, {ind.data.agents.suspended} suspendus)</dd></div>
              {ind.data.badgeVerifications && <div><dt>Vérifications publiques de badge</dt><dd>{ind.data.badgeVerifications.total} (dont {ind.data.badgeVerifications.byResult.INCONNU} codes inconnus)</dd></div>}
              <div><dt>Encaissement terrain</dt><dd>Aucun — fonction inexistante</dd></div>
            </dl>
          </div>
        </section>
      )}

      <Drawer open={creating} title="Préparer une mission" onClose={() => setCreating(false)}>
        <MissionForm lots={lots.data?.items ?? []} onDone={() => { setCreating(false); missions.reload(); ind.reload(); }} />
      </Drawer>
      <Drawer open={!!assigning} title="Affecter la mission" onClose={() => setAssigning(null)}>
        {assigning && <AssignForm mission={assigning} agents={agents.data?.items ?? []} onDone={() => { setAssigning(null); missions.reload(); }} />}
      </Drawer>
      <ReasonDrawer
        open={!!reviewing} title={reviewing?.d === 'VALIDE' ? 'Valider le constat' : 'Rejeter le constat'}
        intro={reviewing && <p>Constat <span className="mono">{reviewing.f.id}</span> de {reviewing.f.agentName}. {reviewing.f.flagMessage ? `Signalement : ${reviewing.f.flagMessage}.` : ''} Un constat validé est figé ; il ne crée aucune dette.</p>}
        confirmLabel={reviewing?.d === 'VALIDE' ? 'Valider' : 'Rejeter'} danger={reviewing?.d === 'REJETE'}
        onClose={() => setReviewing(null)}
        onConfirm={async (reason) => { await api(`/v1/terrain/findings/${reviewing!.f.id}/review`, { method: 'POST', body: { decision: reviewing!.d, reason } }); reloadAll(); }}
      />
    </div>
  );
}
