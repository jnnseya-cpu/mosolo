/**
 * Opportunités, recoupement et maximisation (Cahier v2.9, ch. 8) — visuels (trousse de visualisation, 27/09/2026).
 * Graphiques dérivés des listes que chaque écran charge déjà ; aucun potentiel inventé (« à estimer par le recensement
 * pilote » tant qu'aucune hypothèse documentée ne le fonde) ; aucune mesure automatique.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { BarChartViz, ChartGrid, DonutViz, HeatGrid, KpiGrid, KpiTile, StatusDistribution, type StatusItem } from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy } from '../../lib/aggregate';
import { barresDe, entier, repartition, SERIE_N } from '../fiscal/visuels';
import { ORIGIN_LABELS, RULE_LABELS, WL_STATUS, type Lever, type OpportunitySummary, type RankingReport, type WorklistItem } from './shared';

/** Registre : état d'instruction, décisions, avancement dans le pipeline en huit étapes, origine. */
export function RegistreVisuels({ all }: { all: OpportunitySummary[] }) {
  const etats: StatusItem[] = [
    { key: 'EN_INSTRUCTION', label: 'En instruction', tone: 'info', count: all.filter((o) => o.status === 'EN_INSTRUCTION').length },
    { key: 'ACTIVATION', label: 'Décidée — activation', tone: 'good', count: all.filter((o) => o.decision === 'ACTIVATION').length },
    { key: 'REPORT', label: 'Décidée — report', tone: 'warning', count: all.filter((o) => o.decision === 'REPORT').length },
    { key: 'ABANDON', label: 'Décidée — abandon', tone: 'serious', count: all.filter((o) => o.decision === 'ABANDON').length },
  ];
  const avancement = Array.from({ length: 9 }, (_, n) => ({ key: String(n), label: `${n}/8`, values: { n: all.filter((o) => o.completed === n).length } }));
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Opportunités par état" unitLabel="opportunités" items={etats} emptyText="Aucune opportunité au registre." />
      <BarChartViz title="Étapes complétées du pipeline" subtitle="nombre d’opportunités par avancement" format={entier} series={SERIE_N('Opportunités')} rows={avancement} />
      <DonutViz title="Origine des pistes" centerLabel="pistes" format={entier} slices={countBy(all, 'origin').map((r) => ({ key: r.key, label: ORIGIN_LABELS[r.key] ?? r.key, value: r.count }))} />
    </ChartGrid>
  );
}

/** Indicateurs du moteur : opportunités ayant complété chaque étape (§ 8.4). */
export function ParEtapeVisuel({ parEtape, labels }: { parEtape: { step: number; completed: number }[]; labels?: Record<number, string> }) {
  return (
    <BarChartViz title="Opportunités ayant complété chaque étape" orientation="horizontal" format={entier} series={SERIE_N('Opportunités')}
      rows={parEtape.map((s) => ({ key: String(s.step), label: labels?.[s.step] ? `${s.step}. ${labels[s.step]}` : `Étape ${s.step}`, values: { n: s.completed } }))} />
  );
}

/** Liste de travail du recoupement : état, règle, commune. */
export function ListeTravailVisuels({ items }: { items: WorklistItem[] }) {
  const communes = countBy(items.filter((i) => i.commune), (i) => i.commune);
  return (
    <div className="stack viz-block">
      <KpiGrid max={3} label="Liste de travail — chiffres clés">
        <KpiTile hero label="Éléments à traiter" value={items.filter((i) => ['A_EXAMINER', 'VERIFICATION_REQUISE'].includes(i.status)).length} format={entier} example state={{ label: 'Aucun avis automatique', tone: 'info' }} />
        <KpiTile label="Missions ouvertes" value={items.filter((i) => i.status === 'MISSION_OUVERTE').length} format={entier} />
        <KpiTile label="Éléments au total" value={items.length} format={entier} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Liste de travail par état" unitLabel="éléments" example items={repartition(items, (i) => i.status, WL_STATUS)} emptyText="Liste vide." />
        <BarChartViz title="Éléments par règle de recoupement" orientation="horizontal" format={entier} series={SERIE_N('Éléments')} example rows={barresDe(countBy(items, 'ruleCode'), (k) => RULE_LABELS[k] ?? k)} />
        {communes.length > 0 && <HeatGrid className="viz-span-all" title="Éléments par commune" measureLabel="Éléments" format={entier} example cells={communes.map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun élément dans cette commune" />}
      </ChartGrid>
    </div>
  );
}

export function SourcesVisuel({ items, labels }: { items: { status: string; batches: number; partnerName: string; demo?: boolean }[]; labels: Record<string, { label: string; tone: Tone }> }) {
  const exemple = items.some((s) => s.demo || s.partnerName.includes('[EXEMPLE]'));
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Sources partenaires par état" unitLabel="sources" example={exemple} items={repartition(items, (s) => s.status, labels)} emptyText="Aucune source." />
      <BarChartViz title="Lots reçus par source" orientation="horizontal" format={entier} series={SERIE_N('Lots')} example={exemple} rows={items.map((s) => ({ key: s.partnerName, label: s.partnerName, values: { n: s.batches } }))} />
    </ChartGrid>
  );
}

export function BlocagesVisuel({ items }: { items: { status: string; opposable: boolean }[] }) {
  return (
    <StatusDistribution title="Services bloqués faute de quitus" unitLabel="dossiers" emptyText="Aucun blocage."
      items={[
        { key: 'b', label: 'Bloqué (opposable)', tone: 'serious', count: items.filter((b) => b.status === 'BLOQUE' && b.opposable).length },
        { key: 'i', label: 'Bloqué (informatif)', tone: 'warning', count: items.filter((b) => b.status === 'BLOQUE' && !b.opposable).length },
        { key: 'l', label: 'Levé', tone: 'good', count: items.filter((b) => b.status === 'LEVE').length },
      ]} />
  );
}

/** Classement : classées / non classées par nature de recette (tableaux séparés § 8.7 — jamais additionnés). */
export function ClassementVisuel({ report }: { report: RankingReport }) {
  return (
    <ChartGrid min={300}>
      <BarChartViz className="viz-span-2" title="Opportunités classées et non classées, par nature de recette" orientation="horizontal" format={entier}
        series={[{ key: 'r', label: 'Classées' }, { key: 'n', label: 'Non classées (entrées manquantes)' }]}
        rows={report.dashboards.map((d) => ({ key: d.kind, label: d.label, values: { r: d.ranked, n: d.notRanked } }))} />
      <KpiTile label="Opportunités classées" value={report.ranked.length ? report.ranked.length : null} format={entier}
        reason="Aucune opportunité classée : toutes les entrées doivent être renseignées, datées et sourcées." />
    </ChartGrid>
  );
}

export function LeviersVisuel({ levers }: { levers: Lever[] }) {
  return (
    <StatusDistribution title="Douze leviers — mesure du gain" unitLabel="leviers"
      items={[{ key: 'm', label: 'Mesuré', tone: 'good', count: levers.filter((l) => l.measured).length }, { key: 'n', label: 'Non mesuré (aucune donnée source)', tone: 'neutral', count: levers.filter((l) => !l.measured).length }]} />
  );
}

export function CommercesPatentesVisuel({ rows, notReconciled }: { rows: { commune: string; visible: number; activePatentes: number }[]; notReconciled: { count: number; byCurrency: MoneyJSON[] } }) {
  return (
    <ChartGrid min={300}>
      <BarChartViz className="viz-span-2" title="Commerces visibles et patentes actives, par commune" orientation="horizontal" format={entier} example
        series={[{ key: 'v', label: 'Commerces visibles' }, { key: 'p', label: 'Patentes actives' }]}
        rows={rows.map((r) => ({ key: r.commune, label: r.commune, values: { v: r.visible, p: r.activePatentes } }))} emptyText="Aucun commerce recensé." />
      <KpiTile label="Paiements confirmés non rapprochés" value={notReconciled.count} format={entier} sub={notReconciled.byCurrency.map((m) => `${m.amount} ${m.currency}`).join(' · ') || 'aucun montant'} state={{ label: notReconciled.count ? 'À rapprocher' : 'À jour', tone: notReconciled.count ? 'warning' : 'good' }} />
    </ChartGrid>
  );
}
