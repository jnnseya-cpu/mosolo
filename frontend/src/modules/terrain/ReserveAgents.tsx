/**
 * Réserve des agents et sous-traitants (module 67, § 37A.5) — décision du maître d'ouvrage du 27/09/2026.
 *
 * La réserve de 10 % de chaque module est répartie au prorata des POINTS DE RÉSULTATS VÉRIFIÉS (objets confirmés après
 * contrôle qualité, enrôlements valides, régularisations confirmées par quittance définitive) × NOTE DE QUALITÉ, jamais
 * selon le montant liquidé. Vues : par module, par agent, par équipe, par sous-traitant ; reprise des points fictifs
 * ou frauduleux (proposée par le contrôle qualité ou l'anti-fraude, décidée par une autre personne de la régie).
 * Les écrans de la commission de 10 % (« Mes gains », validations, récapitulatif) sont des vues de cette réserve.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { MoneyText } from '../../components/MoneyText';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';

export type PointKind = 'OBJET_CONFIRME' | 'ENROLEMENT_VALIDE' | 'REGULARISATION_CONFIRMEE';
export interface ReservePoint {
  key: string; kind: PointKind; kindLabel: string; agentId: string; subcontractorId: string | null; team: string; month: string; at: string;
  modules: string[]; points: number; reference: string; status: 'VERIFIE' | 'EN_ATTENTE' | 'REPRIS'; statusReason?: string;
  validation: 'VALIDE' | 'A_VALIDER' | 'DEMANDEE' | 'REFUSEE'; suspicion?: string; clawbackId?: string;
}
export interface ReserveAgentRow {
  agentId: string; name: string; team: string; teamLabel: string; subcontractorId: string | null; points: number; byKind: Record<PointKind, number>; weightedPoints: number;
  quality: { score: number; confirmed: number; judged: number; byDefault: boolean }; modules: string[];
  share: MoneyJSON[]; payable: MoneyJSON[]; toRecover: MoneyJSON[]; netPayable: MoneyJSON[];
}
export interface ReserveGroupRow { key: string; label: string; agents: number; points: number; share: MoneyJSON[]; payable: MoneyJSON[] }
export interface ReserveModuleRow {
  module: string; currency: string | null; reserve: MoneyJSON | null; base: MoneyJSON | null; weightedPoints: number; points: number; distributed: MoneyJSON | null; undistributed: MoneyJSON | null;
  status: 'REPARTIE' | 'SANS_POINTS' | 'SANS_RESERVE' | 'NON_CALCULEE';
  holders: { agentId: string; name: string; team: string; points: number; weightedPoints: number; sharePct: string | null; share: MoneyJSON | null; payable: MoneyJSON | null }[];
}
export interface PointClawback {
  id: string; pointKeys: string[]; agentId: string; grounds: 'POINT_FICTIF' | 'POINT_FRAUDULEUX'; motif: string; proposedBy: string; proposedAt: string;
  status: 'PROPOSEE' | 'DECIDEE' | 'REJETEE'; decision?: { by: string; at: string; approve: boolean; motif: string }; toRecover?: MoneyJSON[];
}
export interface ReserveView {
  period: string; generatedAt: string; mode: 'CALCUL' | 'SIMULATION' | null; notice: string; reservePct: string | null;
  weights: { objetConfirme: number; enrolementValide: number; regularisationConfirmee: number; noteSansJugement: number; status: string };
  modules: ReserveModuleRow[]; agents: ReserveAgentRow[]; teams: ReserveGroupRow[]; subcontractors: ReserveGroupRow[];
  points: { verified: number; pending: number; reclaimed: number; suspected: number; unattached: number };
  items: ReservePoint[]; clawbacks: PointClawback[]; rules: string[]; cashHandled: false;
}

const KIND_LABEL: Record<PointKind, string> = { OBJET_CONFIRME: 'Objets confirmés', ENROLEMENT_VALIDE: 'Enrôlements valides', REGULARISATION_CONFIRMEE: 'Régularisations confirmées' };
const POINT_STATUS: Record<ReservePoint['status'], { label: string; tone: Tone }> = {
  VERIFIE: { label: 'Vérifié', tone: 'good' }, EN_ATTENTE: { label: 'En attente', tone: 'neutral' }, REPRIS: { label: 'Repris', tone: 'critical' },
};
const MODULE_STATUS: Record<ReserveModuleRow['status'], { label: string; tone: Tone }> = {
  REPARTIE: { label: 'Répartie', tone: 'good' }, SANS_POINTS: { label: 'Aucun point : non répartie', tone: 'neutral' },
  SANS_RESERVE: { label: 'Points sans réserve (aucune recette rapprochée)', tone: 'warning' }, NON_CALCULEE: { label: 'Réserve non calculée', tone: 'neutral' },
};
const CLAWBACK_STATUS: Record<PointClawback['status'], { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'Proposée — décision de la régie', tone: 'warning' }, DECIDEE: { label: 'Décidée — points repris', tone: 'critical' }, REJETEE: { label: 'Rejetée', tone: 'neutral' },
};
const has = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));
const currentMonth = () => new Date().toISOString().slice(0, 7);

export function MoneyList({ items, empty = '—' }: { items: MoneyJSON[] | null | undefined; empty?: string }) {
  if (!items?.length) return <span className="muted">{empty}</span>;
  return <>{items.map((m) => <span key={m.currency} style={{ display: 'block' }}><MoneyText money={m} showIndicative={false} /></span>)}</>;
}

/** Carte « Ma quote-part de la réserve » (écran « Mes gains » harmonisé, console des agents). */
export function ReserveShareCard({ reserve }: { reserve: ReserveView }) {
  const me = reserve.agents[0];
  return (
    <section className="panel" aria-labelledby="reserve-card" data-testid="reserve-share-card">
      <header className="panel-head"><div>
        <h2 className="panel-title" id="reserve-card"><Icon name="scale" size={18} /> Ma quote-part de la réserve des agents ({reserve.period})</h2>
        <p className="panel-sub">{reserve.notice} Points de résultats vérifiés × note de qualité — jamais le montant liquidé.</p>
      </div></header>
      {!me ? <EmptyState title="Aucun point de résultat vérifié ce mois-ci" icon="users">Objets confirmés après contrôle qualité, enrôlements valides et régularisations confirmées par quittance définitive comptent pour la réserve.</EmptyState> : (
        <div className="kpi-row">
          <div className="kpi"><span className="kpi-label">Points vérifiés</span><span className="kpi-value">{me.points}</span><span className="kpi-sub">{(Object.keys(KIND_LABEL) as PointKind[]).map((k) => `${KIND_LABEL[k]} ${me.byKind[k]}`).join(' · ')}</span></div>
          <div className="kpi"><span className="kpi-label">Note de qualité</span><span className="kpi-value">{Math.round(me.quality.score * 100)} %</span><span className="kpi-sub">{me.quality.byDefault ? 'aucun résultat jugé (note par défaut)' : `${me.quality.confirmed} confirmé(s) / ${me.quality.judged} jugé(s)`}</span></div>
          <div className="kpi"><span className="kpi-label">Quote-part calculée</span><span className="kpi-value"><MoneyList items={me.share} empty="0" /></span></div>
          <div className="kpi"><span className="kpi-label">Quote-part payable</span><span className="kpi-value"><MoneyList items={me.netPayable} empty="0" /></span><span className="kpi-sub">points validés{me.toRecover.length ? ' ; reprises déduites' : ''} ; versée par le Trésor</span></div>
        </div>
      )}
    </section>
  );
}

function ClawbackBar({ point, onDone }: { point: ReservePoint; onDone: () => void }) {
  const [motif, setMotif] = useState('');
  const [grounds, setGrounds] = useState<'POINT_FICTIF' | 'POINT_FRAUDULEUX'>('POINT_FICTIF');
  const [msg, setMsg] = useState<string | null>(null);
  async function propose() {
    setMsg(null);
    try { await api('/v1/agents/reserve/reprises', { method: 'POST', body: { pointKeys: [point.key], grounds, motif, evidenceSha256: [] } }); setMotif(''); onDone(); }
    catch (e) { const d = describeError(e); setMsg(d.message + (d.code ? ` (${d.code})` : '')); }
  }
  return (
    <span className="row-actions">
      <select aria-label={`Motif de reprise ${point.key}`} value={grounds} onChange={(e) => setGrounds(e.target.value as typeof grounds)}><option value="POINT_FICTIF">Point fictif</option><option value="POINT_FRAUDULEUX">Point frauduleux</option></select>
      <input aria-label={`Justification ${point.key}`} placeholder="justification (10 caractères min.)" value={motif} onChange={(e) => setMotif(e.target.value)} />
      <button type="button" className="btn btn-ghost btn-sm" disabled={motif.trim().length < 10} onClick={() => void propose()}>Proposer la reprise</button>
      {msg && <span className="small notice-err" role="alert">{msg}</span>}
    </span>
  );
}

function ClawbackDecision({ c, onDone }: { c: PointClawback; onDone: () => void }) {
  const { user } = useApp();
  const [motif, setMotif] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const blocked = c.proposedBy === user?.id ? 'Vous avez proposé cette reprise : une autre personne décide.' : c.agentId === user?.id ? 'Reprise de vos propres points : une autre personne décide.' : null;
  async function decide(approve: boolean) {
    setMsg(null);
    try { await api(`/v1/agents/reserve/reprises/${encodeURIComponent(c.id)}/decision`, { method: 'POST', body: { approve, motif } }); onDone(); }
    catch (e) { const d = describeError(e); setMsg(d.message + (d.code ? ` (${d.code})` : '')); }
  }
  if (blocked) return <span className="small muted">{blocked}</span>;
  return (
    <span className="row-actions">
      <input aria-label={`Motif de décision ${c.id}`} placeholder="motif (10 caractères min.)" value={motif} onChange={(e) => setMotif(e.target.value)} />
      <button type="button" className="btn btn-primary btn-sm" disabled={motif.trim().length < 10} onClick={() => void decide(true)}>Reprendre les points</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={motif.trim().length < 10} onClick={() => void decide(false)}>Rejeter</button>
      {msg && <span className="small notice-err" role="alert">{msg}</span>}
    </span>
  );
}

export function ReserveBody({ d, onDone }: { d: ReserveView; onDone: () => void }) {
  const { user, fmtDate } = useApp();
  const canPropose = has(user?.roles, 'R09', 'R11', 'R22', 'R24');
  const canDecide = has(user?.roles, 'R06', 'R07');
  return (
    <>
      <div className={`callout ${d.mode === 'CALCUL' ? 'callout-info' : 'callout-warn'}`} role="note" data-testid="reserve-notice">
        <Icon name={d.mode === 'CALCUL' ? 'shieldCheck' : 'alert'} size={18} />
        <span><strong>{d.notice}</strong> Réserve : {d.reservePct ?? '—'} % des recettes rapprochées de chaque module. Pondérations : objet confirmé {d.weights.objetConfirme}, enrôlement valide {d.weights.enrolementValide}, régularisation {d.weights.regularisationConfirmee} ({d.weights.status}).</span>
      </div>
      <div className="kpi-row">
        <div className="kpi"><span className="kpi-label">Points vérifiés</span><span className="kpi-value">{d.points.verified}</span><span className="kpi-sub">{d.points.pending} en attente · {d.points.unattached} non rattaché(s)</span></div>
        <div className="kpi"><span className="kpi-label">Points repris</span><span className="kpi-value">{d.points.reclaimed}</span><span className="kpi-sub">{d.points.suspected} présumé(s) à contre-visiter</span></div>
        <div className="kpi"><span className="kpi-label">Agents</span><span className="kpi-value">{d.agents.length}</span><span className="kpi-sub">{d.subcontractors.length} sous-traitant(s)</span></div>
      </div>

      <section className="panel"><header className="panel-head"><div><h2 className="panel-title"><Icon name="chart" size={18} /> Réserve par module</h2><p className="panel-sub">Quote-part = réserve du module × points pondérés de l’agent / points pondérés du module (troncature au centime ; le reliquat reste dans la réserve).</p></div></header>
        <DataTable caption="Réserve par module" rows={d.modules} rowKey={(m) => `${m.module}-${m.currency ?? 'x'}`} empty={<EmptyState title="Aucun module" icon="chart" />} columns={[
          { key: 'm', label: 'Module (règle)', primary: true, render: (m) => <span className="mono">{m.module}</span> },
          { key: 'r', label: 'Réserve', num: true, render: (m) => (m.reserve ? <MoneyText money={m.reserve} showIndicative={false} /> : '—') },
          { key: 'p', label: 'Points (pondérés)', num: true, render: (m) => `${m.points} (${m.weightedPoints})` },
          { key: 'd', label: 'Réparti', num: true, render: (m) => (m.distributed ? <MoneyText money={m.distributed} showIndicative={false} /> : '—') },
          { key: 'u', label: 'Non réparti', num: true, render: (m) => (m.undistributed ? <MoneyText money={m.undistributed} showIndicative={false} /> : '—') },
          { key: 'h', label: 'Répartition', render: (m) => <span className="small">{m.holders.map((h) => `${h.name} ${h.sharePct ?? '—'} %`).join(' · ') || '—'}</span> },
          { key: 's', label: 'État', render: (m) => <StatusBadge tone={MODULE_STATUS[m.status].tone} label={MODULE_STATUS[m.status].label} /> },
        ]} />
      </section>

      <section className="panel"><header className="panel-head"><div><h2 className="panel-title"><Icon name="users" size={18} /> Quotes-parts par agent</h2><p className="panel-sub">Payable = points validés (validation à deux personnes des régularisations ; constats validés par le contrôle qualité), reprises déduites.</p></div></header>
        <DataTable caption="Quotes-parts par agent" rows={d.agents} rowKey={(a) => a.agentId} empty={<EmptyState title="Aucun point vérifié ce mois-ci" icon="users" />} columns={[
          { key: 'n', label: 'Agent', primary: true, render: (a) => <>{a.name} <span className="mono small muted">{a.agentId}</span></> },
          { key: 't', label: 'Équipe', render: (a) => <span className="small">{a.teamLabel}</span> },
          { key: 'p', label: 'Points', num: true, render: (a) => <span title={(Object.keys(KIND_LABEL) as PointKind[]).map((k) => `${KIND_LABEL[k]} ${a.byKind[k]}`).join(', ')}>{a.points}</span> },
          { key: 'q', label: 'Note', num: true, render: (a) => `${Math.round(a.quality.score * 100)} %${a.quality.byDefault ? ' (défaut)' : ''}` },
          { key: 's', label: 'Quote-part', render: (a) => <MoneyList items={a.share} empty="0" /> },
          { key: 'v', label: 'Payable', render: (a) => <MoneyList items={a.netPayable} empty="0" /> },
          { key: 'r', label: 'À récupérer', render: (a) => <MoneyList items={a.toRecover} /> },
        ]} />
      </section>

      <div className="two-col">
        <section className="panel"><header className="panel-head"><h2 className="panel-title">Par équipe</h2></header>
          <DataTable caption="Quotes-parts par équipe" rows={d.teams} rowKey={(t) => t.key} empty={<EmptyState title="Aucune équipe" icon="users" />} columns={[
            { key: 'l', label: 'Équipe', primary: true, render: (t) => t.label },
            { key: 'a', label: 'Agents', num: true, render: (t) => t.agents },
            { key: 'p', label: 'Points', num: true, render: (t) => t.points },
            { key: 's', label: 'Quote-part', render: (t) => <MoneyList items={t.share} empty="0" /> },
          ]} />
        </section>
        <section className="panel"><header className="panel-head"><h2 className="panel-title">Par sous-traitant</h2></header>
          <DataTable caption="Quotes-parts par sous-traitant" rows={d.subcontractors} rowKey={(t) => t.key} empty={<EmptyState title="Aucun sous-traitant" icon="users" />} columns={[
            { key: 'l', label: 'Sous-traitant', primary: true, render: (t) => t.label },
            { key: 'a', label: 'Agents', num: true, render: (t) => t.agents },
            { key: 'p', label: 'Points', num: true, render: (t) => t.points },
            { key: 's', label: 'Quote-part', render: (t) => <MoneyList items={t.share} empty="0" /> },
          ]} />
        </section>
      </div>

      <section className="panel"><header className="panel-head"><div><h2 className="panel-title"><Icon name="check" size={18} /> Points de résultats</h2><p className="panel-sub">Présomption (doublon, objet présumé fictif) : à contre-visiter — jamais une reprise automatique ; la reprise est proposée puis décidée par deux personnes.</p></div></header>
        <DataTable caption="Points de résultats" rows={d.items} rowKey={(p) => p.key} empty={<EmptyState title="Aucun point" icon="check" />} columns={[
          { key: 'k', label: 'Nature', render: (p) => p.kindLabel },
          { key: 'r', label: 'Référence', primary: true, render: (p) => <span className="mono small">{p.reference}</span> },
          { key: 'a', label: 'Agent', render: (p) => <span className="mono small">{p.agentId}</span> },
          { key: 'm', label: 'Module(s)', render: (p) => <span className="mono small">{p.modules.join(', ') || 'non rattaché'}</span> },
          { key: 'd', label: 'Date', render: (p) => fmtDate(p.at, true) },
          { key: 's', label: 'État', render: (p) => <><StatusBadge tone={POINT_STATUS[p.status].tone} label={POINT_STATUS[p.status].label} />{p.suspicion && <StatusBadge tone="warning" label={`Présumé : ${p.suspicion}`} />}{p.statusReason && <span className="small muted" style={{ display: 'block' }}>{p.statusReason}</span>}</> },
          ...(canPropose ? [{ key: 'x', label: 'Reprise', render: (p: ReservePoint) => (p.status === 'VERIFIE' && p.agentId !== user?.id ? <ClawbackBar point={p} onDone={onDone} /> : '—') }] : []),
        ]} />
      </section>

      <section className="panel"><header className="panel-head"><div><h2 className="panel-title"><Icon name="alert" size={18} /> Reprises de points</h2><p className="panel-sub">Mois clos : la quote-part déjà versée pour les points repris est récupérée sur les quotes-parts suivantes.</p></div></header>
        <DataTable caption="Reprises de points" rows={d.clawbacks} rowKey={(c) => c.id} empty={<EmptyState title="Aucune reprise" icon="check" />} columns={[
          { key: 'i', label: 'Reprise', primary: true, render: (c) => <span className="mono">{c.id}</span> },
          { key: 'a', label: 'Agent', render: (c) => <span className="mono small">{c.agentId}</span> },
          { key: 'g', label: 'Motif', render: (c) => <span className="small">{c.grounds === 'POINT_FICTIF' ? 'Point fictif' : 'Point frauduleux'} — {c.motif}</span> },
          { key: 'r', label: 'À récupérer', render: (c) => <MoneyList items={c.toRecover} /> },
          { key: 's', label: 'État', render: (c) => <StatusBadge tone={CLAWBACK_STATUS[c.status].tone} label={CLAWBACK_STATUS[c.status].label} /> },
          ...(canDecide ? [{ key: 'x', label: 'Décision', render: (c: PointClawback) => (c.status === 'PROPOSEE' ? <ClawbackDecision c={c} onDone={onDone} /> : '—') }] : []),
        ]} />
      </section>
      <ul className="small">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
    </>
  );
}

export default function ReserveAgents() {
  const { user } = useApp();
  const [period, setPeriod] = useState(currentMonth());
  const q = useApi(() => api<ReserveView>(`/v1/agents/reserve?period=${encodeURIComponent(period)}`), [user?.id, period]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Agents et sous-traitants · § 37A.5 (module 67)" title="Réserve des agents"
        lead="La réserve de 10 % de chaque module est répartie au prorata des points de résultats vérifiés × note de qualité, jamais selon le montant liquidé. Versement par le Trésor ; aucun agent ne reçoit d’argent de l’usager.">
        <label className="pl-filter" htmlFor="reserve-month"><span>Mois</span><input id="reserve-month" type="month" value={period} onChange={(e) => setPeriod(e.target.value || currentMonth())} /></label>
        <button type="button" className="btn btn-secondary btn-sm" onClick={q.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <ReserveBody d={q.data} onDone={q.reload} />}
    </div>
  );
}

/** Vue « sous-traitants et équipes » (écran des sous-traitants) : points et quotes-parts de la réserve. */
export function SubcontractorPointsPanel() {
  const { user } = useApp();
  const q = useApi(() => api<{ period: string; available: boolean; notice: string; subcontractors: ReserveGroupRow[]; teams: ReserveGroupRow[]; agents: ReserveAgentRow[] }>('/v1/terrain/points-resultats'), [user?.id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  return (
    <section className="panel" aria-labelledby="st-points" data-testid="subcontractor-points">
      <header className="panel-head"><div><h2 className="panel-title" id="st-points"><Icon name="scale" size={18} /> Rémunération : points de résultats vérifiés ({d.period})</h2><p className="panel-sub">{d.notice}</p></div></header>
      <DataTable caption="Points et quotes-parts par sous-traitant" rows={d.subcontractors} rowKey={(t) => t.key} empty={<EmptyState title="Aucun point de sous-traitant ce mois-ci" icon="users" />} columns={[
        { key: 'l', label: 'Sous-traitant', primary: true, render: (t) => t.label },
        { key: 'a', label: 'Agents', num: true, render: (t) => t.agents },
        { key: 'p', label: 'Points', num: true, render: (t) => t.points },
        { key: 's', label: 'Quote-part', render: (t) => <MoneyList items={t.share} empty="0" /> },
        { key: 'v', label: 'Payable', render: (t) => <MoneyList items={t.payable} empty="0" /> },
      ]} />
    </section>
  );
}
