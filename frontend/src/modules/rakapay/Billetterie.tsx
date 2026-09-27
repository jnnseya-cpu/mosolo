/**
 * RakaPay (modules 76 et 81) — écrans des décisions du maître d'ouvrage :
 *  - `OperatorTools` : limites approuvées (supervision), ajustement des prix et de la grille de commission par
 *    l'opérateur DANS ces limites, analyse quotidienne des ventes (l'agent ne voit que les siennes), commissions
 *    instantanées, blocage préventif motivé et levée par une autre personne ;
 *  - `GracePanel` : période de grâce paramétrable (proposition, approbation par une autre personne) ;
 *  - `ConstatsPanel` : décisions motivées sur les constats (classement, transmission, pénalité au pourcentage
 *    réglementaire du ticket) ; `MesPenalites` : le redevable consulte et conteste ses pénalités.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { AnalyseQuotidienneVisuel } from './visuels';
import { ConstatsVisuel, constatLabel } from '../titres/visuels';

interface Group { key: string; count: number; amounts: MoneyJSON[]; commissions?: MoneyJSON[]; blocked?: boolean }
interface Limits { commissionMaxPct: string; priceBands: { offerId: string; min: MoneyJSON; max: MoneyJSON }[]; motif: string; approvedAt: string }
interface Grid { rates: { offerId: string; pct: string }[]; updatedAt: string }
export interface DailyAnalysis {
  date: string; viewer: string; sales: number; amounts: MoneyJSON[]; cancellations: number; previous7DaysAverage: number; trend: string;
  commissions: { count: number; amounts: MoneyJSON[]; payer: string }; byHour: Group[]; byOffer: Group[]; byAgent: Group[];
  limits: Limits | null; grid: Grid | null;
}
interface Block { id: string; operatorId: string; agentId: string; status: string; motif: string; decidedAt: string }

const Amounts = ({ list }: { list: MoneyJSON[] }) => (list.length ? <>{list.map((m) => <MoneyText key={m.currency} money={m} />)}</> : <span>0</span>);

function usePost(reload: () => void) {
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async (path: string, body: unknown, msg: string) => {
    setErr(null); setOk(null);
    try { await api(path, { method: 'POST', body }); setOk(msg); reload(); } catch (e) { setErr(describeError(e).message); }
  };
  return { err, ok, run };
}

export function OperatorTools({ operatorId, viewer, offers, agents }: { operatorId: string; viewer: string; offers: { id: string; commercialName: string; publicRevenue: boolean; status: string }[]; agents: { userId: string; name: string }[] }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const q = useApi(() => api<DailyAnalysis>(`/v1/rakapay/operateurs/${operatorId}/analyse-quotidienne?date=${date}`), [operatorId, date]);
  const blocks = useApi(viewer === 'SUPERVISION' ? () => api<{ items: Block[] }>('/v1/rakapay/blocages') : null, [operatorId]);
  const p = usePost(() => { q.reload(); blocks.reload(); });
  const privOffers = offers.filter((o) => !o.publicRevenue && o.status === 'APPROUVEE');
  const [lim, setLim] = useState({ max: '', offerId: privOffers[0]?.id ?? '', min: '', maxPrice: '', motif: '' });
  const [adj, setAdj] = useState({ offerId: privOffers[0]?.id ?? '', price: '', pct: '' });
  const [blk, setBlk] = useState({ agentId: agents[0]?.userId ?? '', motif: '' });
  if (q.loading && !q.data) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const a = q.data;
  return (
    <div className="stack-sm" aria-label="Analyse et limites de l’opérateur">
      <div className="panel-head"><h3><Icon name="chart" size={16} /> Analyse quotidienne</h3><input type="date" className="input-sm" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Jour analysé" /></div>
      <AnalyseQuotidienneVisuel a={a} />
      <p className="small">{a.sales} vente(s) · <Amounts list={a.amounts} /> · {a.cancellations} annulation(s) · moyenne des 7 jours précédents : {a.previous7DaysAverage} ({a.trend === 'HAUSSE' ? 'en hausse' : a.trend === 'BAISSE' ? 'en baisse' : 'stable'})</p>
      <p className="small">Commissions des agents : {a.commissions.count} · <Amounts list={a.commissions.amounts} /> — {a.commissions.payer}</p>
      <p className="small muted">Par heure : {a.byHour.map((g) => `${g.key} h (${g.count})`).join(', ') || '—'} · par offre : {a.byOffer.map((g) => `${g.key} (${g.count})`).join(', ') || '—'}</p>
      {a.byAgent.length > 0 && <ul className="small">{a.byAgent.map((g) => <li key={g.key}>{g.key} : {g.count} vente(s), commission <Amounts list={g.commissions ?? []} />{g.blocked ? ' — bloqué à titre préventif' : ''}</li>)}</ul>}
      <p className="small">Limites approuvées : {a.limits ? `commission ≤ ${a.limits.commissionMaxPct} % · ${a.limits.priceBands.map((b) => `${b.offerId} : ${b.min.amount}–${b.max.amount} ${b.min.currency}`).join(' · ')}` : 'aucune (tout ajustement suppose des limites approuvées)'}{a.grid ? ` · grille : ${a.grid.rates.map((r) => `${r.offerId === '*' ? 'toutes offres' : r.offerId} ${r.pct} %`).join(', ')}` : ''}</p>
      {viewer === 'SUPERVISION' && (
        <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void p.run(`/v1/rakapay/operateurs/${operatorId}/limites`, { commissionMaxPct: lim.max, priceBands: lim.offerId && lim.min && lim.maxPrice ? [{ offerId: lim.offerId, min: { amount: lim.min, currency: 'CDF' }, max: { amount: lim.maxPrice, currency: 'CDF' } }] : [], motif: lim.motif }, 'Limites approuvées.'); }}>
          <input value={lim.max} onChange={(e) => setLim({ ...lim, max: e.target.value })} placeholder="Commission max. (%)" aria-label="Commission maximale" inputMode="decimal" />
          <select value={lim.offerId} onChange={(e) => setLim({ ...lim, offerId: e.target.value })} aria-label="Offre">{privOffers.map((o) => <option key={o.id} value={o.id}>{o.commercialName}</option>)}</select>
          <input value={lim.min} onChange={(e) => setLim({ ...lim, min: e.target.value })} placeholder="Prix min. (FC)" aria-label="Prix minimum" inputMode="decimal" />
          <input value={lim.maxPrice} onChange={(e) => setLim({ ...lim, maxPrice: e.target.value })} placeholder="Prix max. (FC)" aria-label="Prix maximum" inputMode="decimal" />
          <input value={lim.motif} onChange={(e) => setLim({ ...lim, motif: e.target.value })} placeholder="Motif de l’approbation" aria-label="Motif" />
          <button type="submit" className="btn btn-secondary btn-sm">Approuver les limites</button>
        </form>
      )}
      {viewer === 'EXPLOITANT' && (
        <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); if (adj.price) void p.run(`/v1/rakapay/offres/${adj.offerId}/prix`, { price: { amount: adj.price, currency: 'CDF' } }, 'Prix ajusté dans la fourchette approuvée.'); if (adj.pct) void p.run(`/v1/rakapay/operateurs/${operatorId}/grille-commissions`, { rates: [{ offerId: '*', pct: adj.pct }] }, 'Grille de commission mise à jour.'); }}>
          <select value={adj.offerId} onChange={(e) => setAdj({ ...adj, offerId: e.target.value })} aria-label="Offre à ajuster">{privOffers.map((o) => <option key={o.id} value={o.id}>{o.commercialName}</option>)}</select>
          <input value={adj.price} onChange={(e) => setAdj({ ...adj, price: e.target.value })} placeholder="Nouveau prix (FC)" aria-label="Nouveau prix" inputMode="decimal" />
          <input value={adj.pct} onChange={(e) => setAdj({ ...adj, pct: e.target.value })} placeholder="Commission des agents (%)" aria-label="Commission des agents" inputMode="decimal" />
          <button type="submit" className="btn btn-secondary btn-sm">Ajuster dans les limites</button>
        </form>
      )}
      {viewer === 'SUPERVISION' && agents.length > 0 && (
        <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void p.run(`/v1/rakapay/operateurs/${operatorId}/agents/${blk.agentId}/blocage`, { motif: blk.motif }, 'Blocage préventif décidé.'); }}>
          <select value={blk.agentId} onChange={(e) => setBlk({ ...blk, agentId: e.target.value })} aria-label="Agent">{agents.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}</select>
          <input value={blk.motif} onChange={(e) => setBlk({ ...blk, motif: e.target.value })} placeholder="Motif de la décision (15 caractères au moins)" aria-label="Motif du blocage" />
          <button type="submit" className="btn btn-ghost btn-sm">Bloquer à titre préventif</button>
        </form>
      )}
      {blocks.data && blocks.data.items.filter((b) => b.operatorId === operatorId && b.status === 'BLOQUE').map((b) => (
        <p key={b.id} className="small">{b.agentId} bloqué — {b.motif} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = window.prompt('Motif de la levée (personne distincte)'); if (m) void p.run(`/v1/rakapay/blocages/${b.id}/levee`, { motif: m }, 'Blocage levé.'); }}>Lever</button></p>
      ))}
      {p.err && <p className="notice notice-err" role="alert">{p.err}</p>}
      {p.ok && <p className="notice notice-ok" role="status">{p.ok}</p>}
    </div>
  );
}

interface GraceView { modules: { module: string; until: string | null; active: boolean; pending: { id: string; until: string; motif: string } | null }[]; notice: string }

export function GracePanel() {
  const { user } = useApp();
  const q = useApi(() => api<GraceView>('/v1/rakapay/periode-grace'), [user?.id]);
  const p = usePost(q.reload);
  const [f, setF] = useState({ module: '81', until: '', motif: '' });
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="panel stack-sm">
      <h2 className="panel-title"><Icon name="clock" size={18} /> Période de grâce avant pénalités</h2>
      <p className="small muted">{q.data.notice}</p>
      <ul className="list-rows">{q.data.modules.map((m) => (
        <li key={m.module} className="list-row">
          <span>Module {m.module === '81' ? '81 — pass wewa' : '76 — billetterie'} : {m.until ? `jusqu’au ${m.until}` : 'aucune'}</span>
          <div className="row-side">
            <StatusBadge tone={m.active ? 'info' : 'neutral'} label={m.active ? 'En cours' : 'Aucune grâce'} />
            {m.pending && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const r = window.prompt(`Approuver la grâce jusqu’au ${m.pending!.until} — motif`); if (r) void p.run(`/v1/rakapay/periode-grace/${m.pending!.id}/decision`, { approve: true, motif: r }, 'Période de grâce approuvée.'); }}>Approuver ({m.pending.until})</button>}
          </div>
        </li>
      ))}</ul>
      <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void p.run('/v1/rakapay/periode-grace', f, 'Proposition enregistrée : approbation par une autre personne.'); }}>
        <select value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })} aria-label="Module"><option value="81">81 — pass wewa</option><option value="76">76 — billetterie</option></select>
        <input type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} aria-label="Fin de la grâce" />
        <input value={f.motif} onChange={(e) => setF({ ...f, motif: e.target.value })} placeholder="Motif" aria-label="Motif de la proposition" />
        <button type="submit" className="btn btn-secondary btn-sm">Proposer</button>
      </form>
      {p.err && <p className="notice notice-err" role="alert">{p.err}</p>}
      {p.ok && <p className="notice notice-ok" role="status">{p.ok}</p>}
    </section>
  );
}

interface Constat { id: string; module?: string; at: string; status: string; reason: string; duringGrace: boolean; presented: string; penalty?: { amount: MoneyJSON; percentage: string; ruleCode: string } }

export function ConstatsPanel({ module }: { module: '76' | '81' }) {
  const { user } = useApp();
  const q = useApi(() => api<Constat[]>(`/v1/titres/constats?module=${module}`), [user?.id, module]);
  const p = usePost(q.reload);
  const [ref, setRef] = useState(module === '81' ? 'RKP-WEWA-JOUR' : 'RKP-BUS-1J');
  const [holder, setHolder] = useState('');
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const list = Array.isArray(q.data) ? q.data : [];
  return (
    <section className="panel stack-sm">
      <h2 className="panel-title"><Icon name="scale" size={18} /> Constats du module {module} — décisions motivées</h2>
      <div className="row-wrap">
        <input value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Ticket de référence" placeholder="Ticket de référence" />
        <input value={holder} onChange={(e) => setHolder(e.target.value)} aria-label="Redevable identifié" placeholder="Redevable (si aucun titre)" />
      </div>
      {list.length > 0 && <ConstatsVisuel constats={list} title={`Constats du module ${module}`} />}
      {!list.length ? <EmptyState title="Aucun constat" icon="check" /> : (
        <ul className="list-rows">{list.map((k) => (
          <li key={k.id} className="list-row">
            <div className="min0"><p className="row-title">{k.id} · {k.reason}</p><p className="small muted">{k.at}{k.duringGrace ? ' · période de grâce (pédagogique)' : ''}{k.penalty ? ` · pénalité ${k.penalty.percentage} % : ${k.penalty.amount.amount} ${k.penalty.amount.currency}` : ''}</p></div>
            <div className="row-side">
              <StatusBadge tone={k.status === 'OUVERT' ? 'warning' : 'neutral'} label={constatLabel(k.status)} />
              {k.status === 'OUVERT' && <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = window.prompt('Motif du classement'); if (m) void p.run(`/v1/titres/constats/${k.id}/decision`, { outcome: 'CLASSE', motif: m }, 'Constat classé.'); }}>Classer</button>
                {!k.duringGrace && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = window.prompt('Motif de la pénalité (pourcentage réglementaire du ticket)'); if (m) void p.run(`/v1/titres/constats/${k.id}/decision`, { outcome: 'RETENU', motif: m, referenceTypeCode: ref, ...(holder ? { holderTaxpayerId: holder } : {}) }, 'Pénalité retenue, contestable par le redevable.'); }}>Retenir la pénalité</button>}
              </>}
            </div>
          </li>
        ))}</ul>
      )}
      {p.err && <p className="notice notice-err" role="alert">{p.err}</p>}
      {p.ok && <p className="notice notice-ok" role="status">{p.ok}</p>}
    </section>
  );
}

interface MyPenalty { id: string; module: string | null; at: string; status: string; reason: string; penalty: { amount: MoneyJSON; percentage: string; obligationId: string }; contests: { appealId: string; at: string }[] }

export function MesPenalites() {
  const { user } = useApp();
  const q = useApi(user?.roles.includes('R30') ? () => api<MyPenalty[]>('/v1/titres/constats/mine') : null, [user?.id]);
  const p = usePost(q.reload);
  if (!user?.roles.includes('R30')) return null;
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="panel stack-sm">
      <h2 className="panel-title"><Icon name="scale" size={18} /> Mes pénalités de contrôle</h2>
      {!q.data.length ? <EmptyState title="Aucune pénalité" icon="check" /> : (
        <ul className="list-rows">{q.data.map((k) => (
          <li key={k.id} className="list-row">
            <div className="min0"><p className="row-title">{k.reason}</p><p className="small muted">{k.at} · {k.penalty.percentage} % du ticket de référence · avis {k.penalty.obligationId}</p></div>
            <div className="row-side">
              <MoneyText money={k.penalty.amount} />
              {k.contests.length ? <StatusBadge tone="info" label="Contestée" /> : <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const g = window.prompt('Motif de votre contestation (10 caractères au moins)'); if (g) void p.run(`/v1/titres/constats/${k.id}/contestation`, { grounds: g }, 'Contestation enregistrée : décision motivée d’une autre personne.'); }}>Contester</button>}
            </div>
          </li>
        ))}</ul>
      )}
      {p.err && <p className="notice notice-err" role="alert">{p.err}</p>}
      {p.ok && <p className="notice notice-ok" role="status">{p.ok}</p>}
    </section>
  );
}
