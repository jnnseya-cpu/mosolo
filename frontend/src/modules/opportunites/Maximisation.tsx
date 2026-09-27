/**
 * Moteur de maximisation (§ 8.7) et douze leviers (§ 8.6) : classement par revenu net ajusté au risque sur entrées
 * explicites et datées (entrée inconnue ⇒ non classée), tableaux séparés par nature de recette, cas d'usage
 * prioritaires, simulation d'une campagne avant son lancement (sans effet).
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { GeoMapLazy } from '../../components/GeoMapLazy';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, DashboardsView, hasRole, LeversView, money, Tabs, useAction, type Lever, type RankingReport } from './shared';
import './opportunites.css';

const READ = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R09', 'R11', 'R13', 'R14', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24', 'R25'];
const WRITE = ['R06', 'R07', 'R15'];
const SIM = ['R05', 'R06', 'R07', 'R15'];
type Tab = 'classement' | 'cas' | 'simulation' | 'leviers';

const INPUTS: { key: string; label: string; kind: 'money' | 'fraction' | 'kind' }[] = [
  { key: 'revenueKind', label: 'Nature de recette', kind: 'kind' },
  { key: 'legalPotential', label: 'Potentiel légal', kind: 'money' },
  { key: 'complianceProbability', label: 'Probabilité de conformité (0 à 1)', kind: 'fraction' },
  { key: 'collectionSpeed', label: 'Vitesse d’encaissement (0 à 1)', kind: 'fraction' },
  { key: 'censusCost', label: 'Coût de recensement', kind: 'money' },
  { key: 'controlCost', label: 'Coût de contrôle', kind: 'money' },
  { key: 'contestRisk', label: 'Risque de contestation', kind: 'money' },
  { key: 'socialRisk', label: 'Risque social', kind: 'money' },
];
const KINDS: Record<string, string> = { RECETTE_NOUVELLE: 'Recettes nouvelles', REGULARISATION_ARRIERES: 'Régularisation d’arriérés', AMELIORATION_RAPPROCHEMENT: 'Amélioration du rapprochement', RECLASSEMENT: 'Simple reclassement' };

interface UseCases {
  generatedAt: string; params: { expiryHorizonDays: number; forecastWeeks: number; status: string };
  rentalLayer: { note: string; points: { id: string; lat: number; lon: number; commune: string; signals: string[]; level: string }[] };
  shopsVsPatentes: { note: string; rows: { commune: string; visible: number; activePatentes: number }[] };
  expiring: { horizonDays: number; items: { kind: string; ref: string; label: string; validUntil: string; commune: string | null }[] };
  confirmedNotReconciled: { count: number; byCurrency: MoneyJSON[]; oldestConfirmedAt: string | null };
  concentrations: { note: string; items: { source: string; ref: string; detail: string; dimension: string }[] };
  forecast: { weeks: number; observedPaymentRate: string | null; method: string; rows: { week: number; weekStart: string; category: string; commune: string; obligations: number; due: MoneyJSON; expected: MoneyJSON | null }[] };
  simulations: { id: string; label: string; at: string; result: { net: MoneyJSON } }[];
}

function InputEditor({ report, onDone }: { report: RankingReport; onDone: () => void }) {
  const a = useAction();
  const rows = [...report.ranked, ...report.notRanked];
  const [f, setF] = useState({ id: rows[0]?.id ?? '', key: 'legalPotential', amount: '', currency: 'CDF', fraction: '', kind: 'RECETTE_NOUVELLE', date: new Date().toISOString().slice(0, 10), source: '' });
  const def = INPUTS.find((i) => i.key === f.key)!;
  const submit = async () => {
    const value = def.kind === 'kind' ? f.kind : def.kind === 'fraction' ? f.fraction.trim() : { amount: f.amount.trim(), currency: f.currency };
    if (await a.run(() => api(`/v1/opportunites/${f.id}/maximisation/${f.key}`, { method: 'PUT', body: { value, ...(def.kind === 'kind' ? {} : { date: f.date, source: f.source }) } }))) onDone();
  };
  return (
    <details className="op-details"><summary>Saisir une entrée (analyste) — datée et sourcée</summary>
      <div className="field-row">
        <label className="field"><span>Opportunité</span><select value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })}>{rows.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.title}</option>)}</select></label>
        <label className="field"><span>Entrée</span><select value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })}>{INPUTS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></label>
      </div>
      {def.kind === 'money' && <div className="field-row"><label className="field"><span>Montant</span><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label><label className="field"><span>Devise</span><select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>CDF</option><option>USD</option></select></label></div>}
      {def.kind === 'fraction' && <label className="field"><span>Valeur (0 à 1)</span><input inputMode="decimal" value={f.fraction} onChange={(e) => setF({ ...f, fraction: e.target.value })} /></label>}
      {def.kind === 'kind' && <label className="field"><span>Nature</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
      {def.kind !== 'kind' && <div className="field-row"><label className="field"><span>Date de l’hypothèse</span><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label><label className="field"><span>Source</span><input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label></div>}
      <ActionError error={a.error} />
      <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || !f.id || (def.kind !== 'kind' && f.source.trim().length < 3)} onClick={() => void submit()}>Enregistrer</button>
    </details>
  );
}

function RankingTab({ canWrite }: { canWrite: boolean }) {
  const q = useApi(() => api<RankingReport>('/v1/opportunites-maximisation/classement'), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const r = q.data;
  return (
    <div className="stack">
      <p className="callout callout-info"><Icon name="info" size={18} /><span>{r.method} {r.rule}</span></p>
      <DashboardsView report={r} />
      {canWrite && <InputEditor report={r} onDone={q.reload} />}
      <DataTable rows={r.ranked} rowKey={(x) => x.id} caption="Opportunités classées"
        empty={<EmptyState title="Aucune opportunité classée" icon="chart">Toutes les entrées doivent être renseignées, datées et sourcées.</EmptyState>}
        columns={[
          { key: 'r', label: 'Rang', num: true, render: (x) => r.ranked.indexOf(x) + 1 },
          { key: 'o', label: 'Opportunité', primary: true, render: (x) => `${x.code} — ${x.title}` },
          { key: 'k', label: 'Nature', render: (x) => x.revenueKindLabel },
          { key: 'n', label: 'Revenu net ajusté', num: true, render: (x) => <strong>{money(x.net)}</strong> },
          { key: 'f', label: 'Calcul', full: true, render: (x) => <span className="small mono">{x.formula}</span> },
        ]} />
      <DataTable rows={r.notRanked} rowKey={(x) => x.id} caption="Non classées (entrées manquantes)"
        columns={[
          { key: 'o', label: 'Opportunité', primary: true, render: (x) => `${x.code} — ${x.title}` },
          { key: 'k', label: 'Nature', render: (x) => x.revenueKindLabel },
          { key: 'm', label: 'Motif', full: true, render: (x) => <span className="small muted">{x.reason}</span> },
        ]} />
    </div>
  );
}

function UseCasesTab() {
  const q = useApi(() => api<UseCases>('/v1/opportunites-maximisation/cas-usage'), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const u = q.data;
  const pts = u.rentalLayer.points;
  return (
    <div className="stack">
      <section className="panel" aria-labelledby="uc-map">
        <h2 className="panel-title" id="uc-map">Immeubles à forte probabilité de location non recensée</h2>
        <p className="small muted">{u.rentalLayer.note}</p>
        {pts.length > 0 && <GeoMapLazy center={[pts[0]!.lon, pts[0]!.lat]} zoom={11} height={300} ariaLabel="Couche des immeubles à vérifier"
          markers={pts.map((p) => ({ id: p.id, lon: p.lon, lat: p.lat, color: p.level === 'FORTE' ? '#e34948' : '#E0A526', label: `${p.commune} — ${p.signals.length} signal(s)` }))} />}
        <DataTable rows={pts} rowKey={(p) => p.id} caption="Immeubles à vérifier"
          columns={[
            { key: 'i', label: 'Objet', primary: true, render: (p) => <span className="mono small">{p.id}</span> },
            { key: 'c', label: 'Commune', render: (p) => p.commune },
            { key: 'l', label: 'Niveau', render: (p) => <StatusBadge tone={p.level === 'FORTE' ? 'serious' : 'warning'} label={p.level === 'FORTE' ? 'Forte (signaux convergents)' : 'À vérifier'} /> },
            { key: 's', label: 'Signaux', full: true, render: (p) => <span className="small">{p.signals.join(' ; ')}</span> },
          ]} />
      </section>
      <section className="panel" aria-labelledby="uc-shops">
        <h2 className="panel-title" id="uc-shops">Commerces visibles × patentes actives</h2>
        <p className="small muted">{u.shopsVsPatentes.note}</p>
        <DataTable rows={u.shopsVsPatentes.rows} rowKey={(r) => r.commune} caption="Par commune"
          columns={[{ key: 'c', label: 'Commune', primary: true, render: (r) => r.commune }, { key: 'v', label: 'Commerces visibles', num: true, render: (r) => r.visible }, { key: 'p', label: 'Patentes actives', num: true, render: (r) => r.activePatentes }]} />
      </section>
      <section className="panel" aria-labelledby="uc-exp">
        <h2 className="panel-title" id="uc-exp">Véhicules et autorisations arrivant à échéance ({u.expiring.horizonDays} jours — {u.params.status})</h2>
        <DataTable rows={u.expiring.items} rowKey={(r) => `${r.kind}:${r.ref}`} caption="Échéances"
          empty={<EmptyState title="Aucune échéance proche" icon="check" />}
          columns={[{ key: 'k', label: 'Nature', render: (r) => r.kind }, { key: 'r', label: 'Référence', primary: true, render: (r) => <span className="mono small">{r.ref}</span> }, { key: 'l', label: 'Libellé', render: (r) => r.label }, { key: 'v', label: 'Échéance', render: (r) => r.validUntil }]} />
      </section>
      <div className="kpi-row">
        <div className="kpi"><p className="kpi-label caps-sm">Paiements confirmés non rapprochés</p><p className="kpi-value">{u.confirmedNotReconciled.count}</p><div className="kpi-foot"><span className="kpi-sub">{u.confirmedNotReconciled.byCurrency.map((m) => money(m)).join(' · ') || '—'}</span></div></div>
        <div className="kpi"><p className="kpi-label caps-sm">Concentrations à examiner</p><p className="kpi-value">{u.concentrations.items.length}</p><div className="kpi-foot"><span className="kpi-sub">agent ou zone — aucune mesure automatique</span></div></div>
      </div>
      {u.concentrations.items.length > 0 && <ul className="plain-list small">{u.concentrations.items.map((c) => <li key={c.ref}><strong>{c.source}</strong> ({c.dimension === 'ZONE' ? 'zone' : 'agent'}) — {c.detail}</li>)}</ul>}
      <section className="panel" aria-labelledby="uc-fc">
        <h2 className="panel-title" id="uc-fc">Prévision hebdomadaire de trésorerie par catégorie et commune</h2>
        <p className="small muted">{u.forecast.method} Taux observé : {u.forecast.observedPaymentRate ?? 'non mesuré'}.</p>
        <DataTable rows={u.forecast.rows} rowKey={(r) => `${r.week}|${r.category}|${r.commune}|${r.due.currency}`} caption="Prévision hebdomadaire"
          empty={<EmptyState title="Aucune échéance sur l’horizon" icon="chart" />}
          columns={[
            { key: 'w', label: 'Semaine', render: (r) => `S${r.week} (${r.weekStart})` }, { key: 'c', label: 'Catégorie', primary: true, render: (r) => r.category },
            { key: 'm', label: 'Commune', render: (r) => r.commune }, { key: 'd', label: 'Exigible', num: true, render: (r) => money(r.due) }, { key: 'e', label: 'Attendu', num: true, render: (r) => money(r.expected) },
          ]} />
      </section>
    </div>
  );
}

function SimulationTab() {
  const a = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ label: '', targets: '', currency: 'CDF', averageDue: '', p: '', v: '', census: '', control: '', contest: '', social: '', hyp: '', source: '', date: today });
  const [res, setRes] = useState<{ result: Record<string, MoneyJSON | string> } | null>(null);
  const m = (x: string) => ({ amount: x.trim() || '0', currency: f.currency });
  const submit = async () => {
    const r = await a.run(() => api<{ result: Record<string, MoneyJSON | string> }>('/v1/opportunites-maximisation/simulations', { method: 'POST', body: {
      label: f.label, targets: Number(f.targets), averageDue: m(f.averageDue), complianceProbability: f.p.trim(), collectionSpeed: f.v.trim(),
      censusCostPerTarget: m(f.census), controlCostPerTarget: m(f.control), contestRisk: m(f.contest), socialRisk: m(f.social), hypotheses: [{ text: f.hyp, source: f.source, date: f.date }],
    } }));
    if (r) setRes(r);
  };
  const field = (k: keyof typeof f, label: string) => <label className="field"><span>{label}</span><input inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <section className="panel" aria-labelledby="sim-t">
      <h2 className="panel-title" id="sim-t">Simulation d’une campagne de conformité avant lancement</h2>
      <p className="small muted">Toutes les entrées sont explicites ; aucune campagne n’est lancée, aucune obligation créée.</p>
      <label className="field"><span>Intitulé</span><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
      <div className="field-row">{field('targets', 'Nombre de cibles')}<label className="field"><span>Devise</span><select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>CDF</option><option>USD</option></select></label></div>
      <div className="field-row">{field('averageDue', 'Montant moyen dû par cible')}{field('p', 'Probabilité de conformité (0 à 1)')}</div>
      <div className="field-row">{field('v', 'Vitesse d’encaissement (0 à 1)')}{field('census', 'Coût de recensement par cible')}</div>
      <div className="field-row">{field('control', 'Coût de contrôle par cible')}{field('contest', 'Risque de contestation (montant)')}</div>
      {field('social', 'Risque social (montant)')}
      <label className="field"><span>Hypothèse</span><textarea rows={2} value={f.hyp} onChange={(e) => setF({ ...f, hyp: e.target.value })} /></label>
      <div className="field-row"><label className="field"><span>Source</span><input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label><label className="field"><span>Date</span><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label></div>
      <ActionError error={a.error} />
      <button type="button" className="btn btn-primary" disabled={a.busy || f.label.trim().length < 3 || !f.targets || f.hyp.trim().length < 5 || f.source.trim().length < 3} onClick={() => void submit()}>Simuler</button>
      {res && <dl className="op-facts">{Object.entries(res.result).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{typeof v === 'string' ? v : money(v)}</dd></div>)}</dl>}
    </section>
  );
}

function LeversTab() {
  const q = useApi(() => api<{ levers: Lever[]; rule: string }>('/v1/opportunites-leviers'), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return <div className="stack"><p className="small muted">{q.data.rule}</p><LeversView levers={q.data.levers} /></div>;
}

export default function Maximisation() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const [tab, setTab] = useState<Tab>('classement');
  if (!hasRole(roles, ...READ)) {
    return <div className="page"><PageHead eyebrow="Opportunités · § 8.6 – 8.7" title="Moteur de maximisation" /><EmptyState title="Accès réservé" icon="lock">Réservé aux autorités, à la régie, au Trésor, au contrôle interne et à l’audit.</EmptyState></div>;
  }
  const items: { id: Tab; label: string }[] = [
    { id: 'classement', label: 'Classement' }, { id: 'cas', label: 'Cas d’usage prioritaires' },
    ...(hasRole(roles, ...SIM) ? [{ id: 'simulation' as Tab, label: 'Simulation de campagne' }] : []), { id: 'leviers', label: 'Douze leviers' },
  ];
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Opportunités · Cahier v2.9 § 8.6 – 8.7" title="Moteur de maximisation"
        lead="Revenu net ajusté au risque sur entrées explicites et datées ; tableaux toujours séparés entre recettes nouvelles, régularisation d’arriérés, amélioration du rapprochement et simple reclassement." />
      <Tabs value={tab} onChange={setTab} label="Rubrique" items={items} />
      {tab === 'classement' && <RankingTab canWrite={hasRole(roles, ...WRITE)} />}
      {tab === 'cas' && <UseCasesTab />}
      {tab === 'simulation' && <SimulationTab />}
      {tab === 'leviers' && <LeversTab />}
    </div>
  );
}
