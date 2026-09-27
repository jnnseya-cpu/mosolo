/**
 * Simulateur de scénarios (§ 38.3–38.4) sur la base réelle : prudent (= conservateur), attendu, transformationnel
 * (= ambitieux) ; hypothèses datées et sourcées ; analyse de sensibilité (conformité, change, délai des protocoles).
 * Non opposable : ni prévision ni engagement. Les scénarios d'exemple du tableau du Gouverneur restent marqués [EXEMPLE].
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Callout, Choice, Field, hasRole, moneysText, moneyText, Notice, useRunner } from './planif';
import './pilotage.css';
import { BarChartViz, fmtCompact, fmtNombre, StatusDistribution } from '../../components/viz';
import { BarresParDevise, etatsDe, nombre, Visuels } from './visuels';

const HYP_ETAT = { EN_VIGUEUR: { label: 'En vigueur', tone: 'good' as const }, REMPLACEE: { label: 'Remplacée', tone: 'neutral' as const } };

/** Visuels du simulateur : recette additionnelle nette et sensibilité par scénario, base réelle par catégorie. */
export function VisuelsScenarios({ sim, hyps }: { sim: Simulation; hyps: Hyp[] | null }) {
  const cdf = (v: number) => `${fmtCompact(v)} CDF`;
  return (
    <Visuels label="Scénarios en graphiques">
      <BarChartViz title="Recette additionnelle nette par scénario" subtitle="Contre-valeur CDF ; non mesuré tant qu’une hypothèse manque" orientation="vertical" format={cdf} tickFormat={fmtCompact}
        note="Simulation non opposable : ni prévision ni engagement." series={[{ key: 'n', label: 'Recette additionnelle nette' }]}
        rows={sim.scenarios.map((s) => ({ key: s.code, label: s.label, values: { n: nombre(s.additionalNetCdf?.amount) } }))} />
      <BarChartViz className="viz-span-2" title="Sensibilité par scénario" subtitle="Effet en CDF d’un point de conformité, d’un pour cent de change, d’un mois de délai" orientation="horizontal" format={cdf} tickFormat={fmtCompact}
        series={[{ key: 'c', label: '+1 point de conformité' }, { key: 'x', label: '+1 % de change' }, { key: 'd', label: '+1 mois de délai' }]}
        rows={sim.scenarios.map((s) => ({ key: s.code, label: s.label, values: { c: nombre(s.sensitivity.compliancePlusOnePointCdf?.amount), x: nombre(s.sensitivity.exchangeRatePlusOnePctCdf?.amount), d: nombre(s.sensitivity.protocolDelayPlusOneMonthCdf?.amount) } }))} />
      <BarChartViz title="Conformité actuelle par recette" subtitle="Base réelle (12 mois)" orientation="horizontal" format={(v) => `${fmtNombre(v)} %`} emptyText="Aucune obligation sur 12 mois"
        series={[{ key: 'c', label: 'Conformité actuelle' }]} rows={sim.base.map((b) => ({ key: b.revenue, label: b.revenue, values: { c: nombre(b.compliance) } }))} />
      <BarresParDevise title="Potentiel par recette" series={[{ key: 'p', label: 'Potentiel' }]} rows={sim.base.map((b) => ({ key: b.revenue, label: b.revenue, values: { p: b.potential } }))} emptyText="Aucun potentiel calculé" />
      <StatusDistribution title="Registre des hypothèses" unitLabel="hypothèses" emptyText="Aucune hypothèse enregistrée" items={etatsDe(hyps ?? [], (h) => h.status, HYP_ETAT)} />
    </Visuels>
  );
}

interface Hyp { id: string; scenario: string; variable: string; revenue: string; value: string; source: string; sourceDate: string; recordedBy: string; status: string }
type Line = { revenue: string; available: false; reason: string } | { revenue: string; available: true; currentCompliance: string; targetCompliance: string; deltaPoints: string; potential: MoneyJSON[]; additionalGross: MoneyJSON[]; additionalNetCdf: MoneyJSON | null };
export interface Scenario {
  code: string; label: string; equivalent: string; compliance: string; cost: string; reading: string; exchangeRate: string | null; exchangeRateSource: string; protocolDelayMonths: number; protocolDelaySource: string;
  lines: Line[]; additionalNetCdf: MoneyJSON | null; complete: boolean; missing: string[]; hypotheses: Hyp[];
  sensitivity: { note: string; compliancePlusOnePointCdf: MoneyJSON | null; exchangeRatePlusOnePctCdf: MoneyJSON | null; protocolDelayPlusOneMonthCdf: MoneyJSON | null };
}
export interface Simulation { notice: string; basis: string; basisNote: string; formula: string; scenarios: Scenario[]; base: { revenue: string; objects: number; objectsSource: string; potential: MoneyJSON[]; compliance: string | null }[]; variables: Record<string, { label: string; unit: string }> }

export function ScenarioCard({ s }: { s: Scenario }) {
  return (
    <article className="pl-card t-info" aria-labelledby={`sc-${s.code}`}>
      <div className="pl-card-head">
        <div className="min0"><p className="pl-code">{s.code}{s.equivalent !== s.label ? ` · équivaut à « ${s.equivalent.toLowerCase()} »` : ''}</p><h2 className="row-title" id={`sc-${s.code}`}>{s.label}</h2></div>
        <StatusBadge tone={s.complete ? 'good' : 'warning'} label={s.complete ? 'Hypothèses complètes' : 'Hypothèses manquantes'} />
      </div>
      <p className="pl-card-value">{moneyText(s.additionalNetCdf)}</p>
      <p className="small muted">{s.compliance} — {s.reading}</p>
      <dl>
        <dt>Change</dt><dd>{s.exchangeRate ?? '—'} CDF/USD ({s.exchangeRateSource === 'HYPOTHESE' ? 'hypothèse' : 'taux officiel du jour'})</dd>
        <dt>Protocoles</dt><dd>{s.protocolDelayMonths} mois ({s.protocolDelaySource === 'HYPOTHESE' ? 'hypothèse' : 'non renseigné'})</dd>
        <dt>+1 point de conformité</dt><dd>{moneyText(s.sensitivity.compliancePlusOnePointCdf)}</dd>
        <dt>+1 % de change</dt><dd>{moneyText(s.sensitivity.exchangeRatePlusOnePctCdf)}</dd>
        <dt>+1 mois de délai</dt><dd>{moneyText(s.sensitivity.protocolDelayPlusOneMonthCdf)}</dd>
      </dl>
      {s.missing.length > 0 && <p className="small muted">Manque : {s.missing.join(' ; ')}</p>}
      {s.hypotheses.length > 0 && <ul className="small plain-list">{s.hypotheses.map((h) => <li key={h.id}>{h.variable} {h.revenue !== '*' ? `(${h.revenue})` : ''} = {h.value} — {h.source}, {h.sourceDate}</li>)}</ul>}
    </article>
  );
}

export interface IllustrativeExample {
  titre: string; source: string; colonnes: string[]; avertissement: string; formula: string; concordance: boolean;
  lignes: { ligne: string; objetsTexte: string; montantTexte: string; conformiteTexte: string; gainTexte: string; marque: string; gainCalcule: MoneyJSON; gainMillionsCalcule: number; gainMillionsCahier: number; concordance: boolean }[];
}

/** Exemple illustratif du Cahier (§ 39.3) : lecture seule, jamais enregistré comme hypothèse ni utilisé par les scénarios. */
export function IllustrativeExamplePanel({ x }: { x: IllustrativeExample }) {
  return (
    <Section title={`[EXEMPLE] ${x.titre}`} sub={`${x.source} — ${x.formula}`}>
      <DataTable caption="Exemple illustratif (hypothèses)" rows={x.lignes} rowKey={(l) => l.ligne} columns={[
        { key: 'l', label: x.colonnes[0] ?? 'Ligne', primary: true, render: (l) => <><strong>{l.ligne}</strong><span className="small muted" style={{ display: 'block' }}>{l.marque}</span></> },
        { key: 'o', label: x.colonnes[1] ?? 'Objets', render: (l) => l.objetsTexte },
        { key: 'm', label: x.colonnes[2] ?? 'Montant', render: (l) => l.montantTexte },
        { key: 'c', label: x.colonnes[3] ?? 'Conformité', render: (l) => l.conformiteTexte },
        { key: 'g', label: `${x.colonnes[4] ?? 'Gain'} (Cahier)`, num: true, render: (l) => l.gainTexte },
        { key: 'k', label: 'Recalcul (formule du simulateur)', num: true, render: (l) => <>{moneyText(l.gainCalcule)} <StatusBadge tone={l.concordance ? 'good' : 'critical'} label={l.concordance ? `≈ ${l.gainMillionsCalcule} M USD, concordant` : `≈ ${l.gainMillionsCalcule} M USD, écart`} /></> },
      ]} />
      <BarChartViz example exampleLabel="EXEMPLE — hypothèses du Cahier, non opposable" title="Gain : Cahier et recalcul" subtitle="Millions USD par ligne de l’exemple illustratif (§ 39.3)" orientation="horizontal" format={(v) => `${fmtNombre(v)} M USD`}
        series={[{ key: 'c', label: 'Cahier' }, { key: 'k', label: 'Recalcul' }]} rows={x.lignes.map((l) => ({ key: l.ligne, label: l.ligne, values: { c: l.gainMillionsCahier, k: l.gainMillionsCalcule } }))} />
      <Callout tone="warn"><strong>Avertissement méthodologique.</strong> {x.avertissement}</Callout>
    </Section>
  );
}

export default function Scenarios() {
  const { user } = useApp();
  const sim = useApi(() => api<Simulation>('/v1/pilotage/scenarios'), [user?.id]);
  const hyps = useApi(() => api<{ items: Hyp[] }>('/v1/pilotage/scenarios/hypotheses'), [user?.id]);
  const example = useApi(() => api<IllustrativeExample>('/v1/pilotage/scenarios/exemple-illustratif'), [user?.id]);
  const reload = () => { sim.reload(); hyps.reload(); };
  const r = useRunner(reload);
  const [h, setH] = useState({ scenario: 'ATTENDU', variable: 'TAUX_CONFORMITE_CIBLE', revenue: '*', value: '', source: '', sourceDate: '' });
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 38.3–38.4" title="Simulateur de scénarios" lead="Scénarios construits uniquement sur la base réelle, avec hypothèses datées et sourcées et analyse de sensibilité. Simulation non opposable." />
      {sim.loading && !sim.data ? <Loading /> : sim.error ? <ErrorState error={sim.error} onRetry={reload} /> : sim.data && (
        <div className="dash-grid">
          <div className="span-12"><Callout tone={sim.data.basis === 'BASE_CERTIFIEE' ? 'info' : 'warn'}><strong>{sim.data.notice}</strong> {sim.data.basisNote}</Callout></div>
          <div className="span-12 pl-cat">{sim.data.scenarios.map((s) => <ScenarioCard key={s.code} s={s} />)}</div>
          <VisuelsScenarios sim={sim.data} hyps={hyps.data?.items ?? null} />
          <Section title="Base réelle par catégorie" sub={sim.data.formula}>
            <DataTable caption="Base" rows={sim.data.base} rowKey={(b) => b.revenue} empty={<EmptyState title="Aucune obligation sur 12 mois" icon="chart" />} columns={[
              { key: 'r', label: 'Recette', primary: true, render: (b) => b.revenue },
              { key: 'o', label: 'Objets', num: true, render: (b) => `${b.objects} (${b.objectsSource === 'BASE_CERTIFIEE' ? 'base certifiée' : 'observé'})` },
              { key: 'p', label: 'Potentiel', num: true, render: (b) => moneysText(b.potential) },
              { key: 'c', label: 'Conformité actuelle', num: true, render: (b) => (b.compliance === null ? '—' : `${b.compliance} %`) },
            ]} />
          </Section>
        </div>
      )}
      <div className="dash-grid">
        <Section title="Registre des hypothèses" sub="Chaque hypothèse est datée et sourcée ; une nouvelle valeur remplace la précédente sans l’effacer">
          <Notice msg={r.msg} />
          <DataTable caption="Hypothèses" rows={hyps.data?.items ?? []} rowKey={(x) => x.id} empty={<EmptyState title="Aucune hypothèse enregistrée" icon="chart">Aucune valeur n’est présumée : le scénario reste incomplet tant qu’une hypothèse manque.</EmptyState>} columns={[
            { key: 's', label: 'Scénario', primary: true, render: (x) => `${x.scenario} · ${x.variable}${x.revenue !== '*' ? ` (${x.revenue})` : ''}` },
            { key: 'v', label: 'Valeur', num: true, render: (x) => x.value },
            { key: 'o', label: 'Source', render: (x) => <span className="small">{x.source} — {x.sourceDate}</span> },
            { key: 't', label: 'Statut', render: (x) => <StatusBadge tone={x.status === 'EN_VIGUEUR' ? 'good' : 'neutral'} label={x.status === 'EN_VIGUEUR' ? 'En vigueur' : 'Remplacée'} /> },
          ]} />
          {hasRole(user?.roles, 'R05', 'R06', 'R15') && (
            <div className="form">
              <Choice label="Scénario" value={h.scenario} onChange={(v) => setH({ ...h, scenario: v })} options={[['PRUDENT', 'Prudent (conservateur)'], ['ATTENDU', 'Attendu'], ['TRANSFORMATIONNEL', 'Transformationnel (ambitieux)']]} />
              <Choice label="Variable" value={h.variable} onChange={(v) => setH({ ...h, variable: v })} options={Object.entries(sim.data?.variables ?? {}).map(([k, x]) => [k, `${x.label} (${x.unit})`])} />
              <Field label="Catégorie de recette (« * » pour toutes)" value={h.revenue} onChange={(v) => setH({ ...h, revenue: v })} />
              <Field label="Valeur" value={h.value} onChange={(v) => setH({ ...h, value: v })} />
              <Field label="Source" value={h.source} onChange={(v) => setH({ ...h, source: v })} />
              <Field label="Date de la source" type="date" value={h.sourceDate} onChange={(v) => setH({ ...h, sourceDate: v })} />
              <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/scenarios/hypotheses', h, 'Hypothèse enregistrée.')}>Enregistrer l’hypothèse</button></div>
            </div>
          )}
        </Section>
        {example.data && <IllustrativeExamplePanel x={example.data} />}
      </div>
    </div>
  );
}
