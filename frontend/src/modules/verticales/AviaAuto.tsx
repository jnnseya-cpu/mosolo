/**
 * MOSOLO AVIA (modules 62 et 78) — exécution AUTOMATIQUE de la facturation ou de la compensation des écarts mensuels
 * APRÈS l'arrêté provincial (décision du maître d'ouvrage) ; avant l'arrêté : proposition seulement.
 *  - `AviaAutoSection` (console des agents) : mode du mois échu, règles du registre, planificateur, passages,
 *    exécutions par compagnie (avis émis, crédits de compensation, écarts restés en proposition), passage manuel.
 *  - `AviaAutoAirline` (espace de la compagnie) : avis reçus et procédure contradictoire APRÈS l'avis (observations
 *    dans le délai ; chaque observation ouvre une réclamation sur l'avis par le circuit commun des recours).
 */
import { useState } from 'react';
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { useApp } from '../../context';
import type { MoneyJSON } from '@mosolo/shared';
import { AviaAutoViz } from './visuels';

type Money = MoneyJSON;
export interface AviaAutoExecution {
  id: string; period: string; airlineTaxpayerId: string; airlineName: string; kind: 'FACTURATION' | 'COMPENSATION' | 'AUCUN_MONTANT'; trigger: string; actReference: string;
  remittanceGap: string; boardedWithoutIfa: number; gapLabels: string[];
  billings: { ruleCode: string; ruleVersion: number; obligationId: string; amount: Money; label: string; status: string | null; dueDate: string | null; appeal: { id: string; status: string } | null }[];
  creditsApplied: { executionId: string; amount: string }[];
  compensation: { amount: string; remaining: string } | null;
  notExecuted: { label: string; reason: string }[];
  contradictory: { deadline: string; observations: { at: string; text: string; appealIds: string[] }[] };
  contradictoryOpen: boolean; total: Money; notice: string; at: string;
}
interface AutoOverview {
  currentMode: { period: string; mode: 'EXECUTION' | 'PROPOSITION'; reason: string; act: { reference: string; signedOn: string } | null };
  scheduler: { active: boolean; frequency: string; lastRun: { at: string; period: string; mode: string } | null };
  rules: { code: string; label: string; status: string; version: number | null; demo: boolean }[];
  totals: { executions: number; billed: Money[]; compensated: string; creditsRemaining: string; observations: number };
  runs: { id: string; period: string; mode: string; trigger: string; at: string; reason: string; executions: string[]; skipped: { airlineTaxpayerId: string; reason: string }[] }[];
  executions: AviaAutoExecution[];
  notice: string;
}

const KIND_LABEL: Record<AviaAutoExecution['kind'], string> = { FACTURATION: 'Avis émis', COMPENSATION: 'Compensation (crédit)', AUCUN_MONTANT: 'Aucun montant exécutable' };
const KIND_TONE: Record<AviaAutoExecution['kind'], 'warning' | 'good' | 'neutral'> = { FACTURATION: 'warning', COMPENSATION: 'good', AUCUN_MONTANT: 'neutral' };

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null); setOk(null);
    try { await fn(); setOk(success); } catch (e) { setError(describeError(e).message); } finally { setBusy(false); }
  };
  return { busy, error, ok, run };
}

function ExecutionCard({ e, airline, onChange }: { e: AviaAutoExecution; airline?: boolean; onChange: () => void }) {
  const { fmtDate } = useApp();
  const a = useAction();
  const [text, setText] = useState('');
  return (
    <article className="panel" aria-label={`Exécution ${e.id}`}>
      <div className="panel-head">
        <h3 className="panel-title">{e.airlineName} — {e.period}</h3>
        <StatusBadge tone={KIND_TONE[e.kind]} label={KIND_LABEL[e.kind]} />
      </div>
      <p className="small muted">Arrêté {e.actReference} · {e.trigger === 'PLANIFIEE' ? 'Calendrier mensuel' : 'Passage manuel'} · écart de reversement {e.remittanceGap} USD · {e.boardedWithoutIfa} passager(s) sans IFA</p>
      {e.billings.length > 0 && (
        <ul className="list-rows">
          {e.billings.map((b) => (
            <li key={b.obligationId} className="list-row">
              <div className="min0"><p className="row-title">{b.label}</p><p className="small muted mono">{b.obligationId} · règle {b.ruleCode} v{b.ruleVersion}{b.dueDate ? ` · échéance ${fmtDate(b.dueDate)}` : ''}</p></div>
              <div className="row-side"><MoneyText money={b.amount} />{b.appeal && <StatusBadge tone="info" label={`Réclamation ${b.appeal.status}`} />}</div>
            </li>
          ))}
        </ul>
      )}
      {e.creditsApplied.length > 0 && <p className="small">Crédits de compensation imputés : {e.creditsApplied.map((c) => `${c.amount} USD (${c.executionId})`).join(', ')}</p>}
      {e.compensation && <p className="small"><Icon name="check" size={13} /> Trop-reversé de {e.compensation.amount} USD porté au crédit de la compagnie — reste à imputer : {e.compensation.remaining} USD.</p>}
      {e.notExecuted.map((n) => <p key={n.label} className="small muted">{n.label} — {n.reason}</p>)}
      <p className="small">
        Procédure contradictoire {e.contradictoryOpen ? `ouverte jusqu’au ${fmtDate(e.contradictory.deadline)}` : `close depuis le ${fmtDate(e.contradictory.deadline)} (recours de droit commun ouvert)`} — {e.contradictory.observations.length} observation(s).
      </p>
      {airline && e.contradictoryOpen && (
        <form className="form" onSubmit={(ev) => { ev.preventDefault(); void a.run(async () => { await api(`/v1/verticales/avia/auto/executions/${e.id}/observations`, { method: 'POST', body: { text, documents: [] } }); setText(''); onChange(); }, 'Observations transmises : chaque avis fait l’objet d’une réclamation instruite par une autre personne.'); }}>
          <label className="field"><span>Vos observations sur cet avis</span><textarea value={text} onChange={(ev) => setText(ev.target.value)} minLength={10} required rows={3} /></label>
          <button type="submit" className="btn btn-primary" disabled={a.busy}>Présenter mes observations</button>
        </form>
      )}
      {a.error && <p className="notice notice-err" role="alert">{a.error}</p>}
      {a.ok && <p className="notice notice-ok" role="status">{a.ok}</p>}
    </article>
  );
}

/** Console des agents : mode, règles, planificateur, passages et exécutions. */
export function AviaAutoSection() {
  const { fmtDate } = useApp();
  const fmtDateTime = (iso: string) => fmtDate(iso, true);
  const q = useApi(() => api<AutoOverview>('/v1/verticales/avia/auto'), []);
  const a = useAction();
  const [period, setPeriod] = useState('');
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const o = q.data;
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="scale" size={18} /><p>{o.notice}</p></div>
      <AviaAutoViz executions={o.executions} billed={o.totals.billed} />
      <section className="panel">
        <h2 className="panel-title"><Icon name="clock" size={18} /> Mois échu {o.currentMode.period}</h2>
        <StatusBadge tone={o.currentMode.mode === 'EXECUTION' ? 'warning' : 'neutral'} label={o.currentMode.mode === 'EXECUTION' ? 'Exécution automatique (après arrêté)' : 'Proposition seulement (avant arrêté)'} />
        <p className="small">{o.currentMode.reason}</p>
        <p className="small muted">Planificateur : {o.scheduler.active ? 'actif' : 'inactif sur ce serveur'} — {o.scheduler.frequency}{o.scheduler.lastRun ? ` · dernier passage ${fmtDateTime(o.scheduler.lastRun.at)} (${o.scheduler.lastRun.period}, ${o.scheduler.lastRun.mode})` : ''}</p>
        <ul className="list-rows">
          {o.rules.map((r) => <li key={r.code} className="list-row"><span>{r.label} <span className="mono small">{r.code}</span></span><StatusBadge tone={r.status === 'ACTIVE' ? 'good' : 'neutral'} label={r.status === 'ACTIVE' ? `ACTIVE v${r.version}${r.demo ? ' [EXEMPLE]' : ''}` : 'Acte requis'} /></li>)}
        </ul>
        {o.rules.some((r) => r.demo) && <ExampleNotice text="Règle fictive de démonstration [EXEMPLE] : montants non opposables." />}
        <form className="form form-inline" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/v1/verticales/avia/auto/run', { method: 'POST', body: period ? { period } : {} }); q.reload(); }, 'Passage exécuté (idempotent : aucun second avis).'); }}>
          <label className="field"><span>Mois (AAAA-MM, défaut : mois échu)</span><input value={period} onChange={(e) => setPeriod(e.target.value)} pattern="\d{4}-\d{2}" placeholder="2026-08" /></label>
          <button type="submit" className="btn" disabled={a.busy}>Exécuter le passage mensuel</button>
        </form>
        {a.error && <p className="notice notice-err" role="alert">{a.error}</p>}
        {a.ok && <p className="notice notice-ok" role="status">{a.ok}</p>}
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="chart" size={18} /> Indicateurs</h2>
        <p className="small">Exécutions : {o.totals.executions} · facturé : {o.totals.billed.map((m) => `${m.amount} ${m.currency}`).join(', ') || '0'} · compensé : {o.totals.compensated} USD (reste à imputer {o.totals.creditsRemaining} USD) · observations : {o.totals.observations}</p>
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="table" size={18} /> Passages</h2>
        {o.runs.length === 0 ? <EmptyState title="Aucun passage enregistré" /> : (
          <DataTable caption="Passages mensuels" rows={o.runs} rowKey={(r) => r.id} columns={[
            { key: 'p', label: 'Mois', render: (r) => r.period },
            { key: 'm', label: 'Mode', render: (r) => (r.mode === 'EXECUTION' ? 'Exécution' : 'Proposition') },
            { key: 't', label: 'Déclenchement', render: (r) => (r.trigger === 'PLANIFIEE' ? 'Calendrier' : 'Manuel') },
            { key: 'e', label: 'Exécutions', num: true, render: (r) => r.executions.length },
            { key: 'at', label: 'Le', render: (r) => fmtDateTime(r.at) },
          ]} />
        )}
      </section>
      {o.executions.length === 0 ? <EmptyState title="Aucune exécution automatique" /> : o.executions.map((e) => <ExecutionCard key={e.id} e={e} onChange={q.reload} />)}
    </div>
  );
}

/** Espace de la compagnie : avis reçus après l'arrêté et observations dans le délai. */
export function AviaAutoAirline() {
  const q = useApi(() => api<{ items: AviaAutoExecution[] }>('/v1/verticales/avia/auto/executions'), []);
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="panel" aria-labelledby="vx-avia-auto">
      <div className="panel-head"><h2 className="panel-title" id="vx-avia-auto"><Icon name="plane" size={18} /> Avis d’écart après arrêté et procédure contradictoire</h2><span className="count">{q.data.items.length}</span></div>
      {q.data.items.length === 0 ? <EmptyState title="Aucun avis d’écart" /> : q.data.items.map((e) => <ExecutionCard key={e.id} e={e} airline onChange={q.reload} />)}
    </section>
  );
}
