/**
 * Moteur de découverte des recettes (module 61) — indicateurs (opportunités instruites, gain net des pilotes) et
 * résultats de pilote constatés par le comité de pilotage : recettes du périmètre pilote, recettes du groupe témoin,
 * coût réel, source. Gain net = (pilote − témoin) − coût ; jamais estimé par le système ; aucune obligation créée.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { ActionError, hasRole, Kpi, money, useAction } from './shared';

export interface PilotResult {
  id: string; opportunityId: string; periodStart: string; periodEnd: string; perimeter: string;
  observedRevenue: MoneyJSON; comparisonRevenue: MoneyJSON | null; implementationCost: MoneyJSON; netGain: MoneyJSON; withComparison: boolean;
  source: string; note: string | null; recordedBy: string; recordedAt: string; effect: 'AUCUNE_OBLIGATION_CREEE';
}
export interface OppIndicators {
  generatedAt: string;
  opportunites: { total: number; instruites: number; enInstruction: number; signauxNonInstruits: number; decidees: Record<string, number> & { total: number }; parEtape: { step: number; completed: number }[] };
  pilotes: { resultats: number; opportunitesPilotees: number; gainNet: { currency: string; netGain: MoneyJSON; netGainWithComparison: MoneyJSON; pilots: number }[]; note?: string };
  methode: string;
}

export function OppIndicatorsPanel() {
  const q = useApi(() => api<OppIndicators>('/v1/opportunites-indicateurs'), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  return (
    <section className="panel" aria-labelledby="op-ind" data-testid="opp-indicators">
      <h2 className="panel-title" id="op-ind">Indicateurs du moteur de découverte</h2>
      <div className="kpi-row">
        <Kpi label="Opportunités instruites" value={d.opportunites.instruites} sub={`${d.opportunites.total} au registre · ${d.opportunites.signauxNonInstruits} signal(aux) non instruit(s)`} />
        <Kpi label="Décidées" value={d.opportunites.decidees.total} sub={`activation ${d.opportunites.decidees.ACTIVATION ?? 0} · report ${d.opportunites.decidees.REPORT ?? 0} · abandon ${d.opportunites.decidees.ABANDON ?? 0}`} />
        <Kpi label="Résultats de pilote" value={d.pilotes.resultats} sub={`${d.pilotes.opportunitesPilotees} opportunité(s) pilotée(s)`} />
        <Kpi label="Gain net des pilotes" value={d.pilotes.gainNet.length ? d.pilotes.gainNet.map((g) => money(g.netGain)).join(' · ') : '—'} sub={d.pilotes.note ?? 'dont avec groupe témoin : ' + d.pilotes.gainNet.map((g) => money(g.netGainWithComparison)).join(' · ')} />
      </div>
      <p className="small muted">{d.methode}</p>
    </section>
  );
}

export function PilotResultsSection({ opportunityId, pilotDefined, roles }: { opportunityId: string; pilotDefined: boolean; roles: string[] }) {
  const q = useApi(() => api<{ items: PilotResult[] }>(`/v1/opportunites/${encodeURIComponent(opportunityId)}/resultats-pilote`), [opportunityId]);
  const a = useAction();
  const [f, setF] = useState({ periodStart: '', periodEnd: '', perimeter: '', observed: '', comparison: '', cost: '', currency: 'CDF', source: '', note: '' });
  const canRecord = pilotDefined && hasRole(roles, 'R02', 'R05', 'R06');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit() {
    const m = (v: string) => ({ amount: v.replace(',', '.'), currency: f.currency });
    const body = {
      periodStart: f.periodStart, periodEnd: f.periodEnd, perimeter: f.perimeter, observedRevenue: m(f.observed), implementationCost: m(f.cost),
      ...(f.comparison ? { comparisonRevenue: m(f.comparison) } : {}), source: f.source, ...(f.note ? { note: f.note } : {}),
    };
    if (await a.run(() => api(`/v1/opportunites/${encodeURIComponent(opportunityId)}/resultats-pilote`, { method: 'POST', body }))) q.reload();
  }
  return (
    <section className="panel" aria-labelledby="op-pil">
      <h3 className="panel-title" id="op-pil">Résultats du pilote (gain net constaté)</h3>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : (
        <DataTable caption="Résultats du pilote" rows={q.data?.items ?? []} rowKey={(r) => r.id} empty={<EmptyState title={pilotDefined ? 'Aucun résultat constaté' : 'Pilote non défini (étape 7)'} icon="chart" />} columns={[
          { key: 'p', label: 'Période', primary: true, render: (r) => `${r.periodStart} → ${r.periodEnd}` },
          { key: 'z', label: 'Périmètre', render: (r) => <span className="small">{r.perimeter}</span> },
          { key: 'o', label: 'Recettes pilote', num: true, render: (r) => money(r.observedRevenue) },
          { key: 't', label: 'Groupe témoin', num: true, render: (r) => money(r.comparisonRevenue) },
          { key: 'c', label: 'Coût', num: true, render: (r) => money(r.implementationCost) },
          { key: 'g', label: 'Gain net', num: true, render: (r) => <><strong>{money(r.netGain)}</strong>{!r.withComparison && <StatusBadge tone="warning" label="sans comparaison" />}</> },
          { key: 's', label: 'Source', render: (r) => <span className="small">{r.source}</span> },
        ]} />
      )}
      {canRecord && (
        <form className="form" aria-label="Constater un résultat de pilote" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pil-s">Début</label><input id="pil-s" type="date" required value={f.periodStart} onChange={set('periodStart')} /></div>
            <div className="field"><label className="label" htmlFor="pil-e">Fin</label><input id="pil-e" type="date" required value={f.periodEnd} onChange={set('periodEnd')} /></div>
            <div className="field"><label className="label" htmlFor="pil-cur">Devise</label><select id="pil-cur" value={f.currency} onChange={set('currency')}><option value="CDF">CDF</option><option value="USD">USD</option></select></div>
          </div>
          <div className="field"><label className="label" htmlFor="pil-z">Périmètre pilote</label><input id="pil-z" required value={f.perimeter} onChange={set('perimeter')} /></div>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pil-o">Recettes observées (pilote)</label><input id="pil-o" inputMode="decimal" required value={f.observed} onChange={set('observed')} /></div>
            <div className="field"><label className="label" htmlFor="pil-t">Recettes du groupe témoin</label><input id="pil-t" inputMode="decimal" value={f.comparison} onChange={set('comparison')} /></div>
            <div className="field"><label className="label" htmlFor="pil-c">Coût d’implémentation</label><input id="pil-c" inputMode="decimal" required value={f.cost} onChange={set('cost')} /></div>
          </div>
          <div className="field"><label className="label" htmlFor="pil-src">Source des chiffres</label><input id="pil-src" required value={f.source} onChange={set('source')} /></div>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={a.busy}>Constater le résultat</button>
          <ActionError error={a.error} />
          <p className="small muted">Aucun résultat ne crée de règle, d’obligation ni de taxe : il éclaire la décision de l’autorité.</p>
        </form>
      )}
    </section>
  );
}
