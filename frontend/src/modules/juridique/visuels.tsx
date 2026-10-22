/**
 * Registre juridique et gouvernance des données — visuels (trousse de visualisation, 27/09/2026). Dérivés des seules
 * données déjà chargées par les écrans ; aucune cible inventée (la progression est suivie « sans cible »).
 */
import { BarChartViz, ChartGrid, ProgressMeter, StatusDistribution } from '../../components/viz';
import { countBy } from '../../lib/aggregate';
import { barresDe, entier, SERIE_N } from '../fiscal/visuels';

export function PointsVisuels({ points, fonctions }: { points: { statut: string; autorite: string; proposition: unknown }[]; fonctions: { enAttente: boolean }[] }) {
  const tranches = points.filter((p) => p.statut === 'TRANCHE').length;
  return (
    <ChartGrid min={300}>
      <div className="panel">
        <ProgressMeter label="Points tranchés sur acte" value={tranches} max={Math.max(1, points.length)} format={entier} unit={`sur ${points.length}`}
          toneLabel="Suivi (sans cible)" tone={tranches === points.length && points.length ? 'good' : 'neutral'} />
        <p className="small muted">Tant qu’un point est ouvert, l’hypothèse intérimaire sûre s’applique.</p>
      </div>
      <StatusDistribution title="Points J1 à J30 par statut" unitLabel="points"
        items={[
          { key: 'o', label: 'Ouvert', tone: 'warning', count: points.filter((p) => p.statut !== 'TRANCHE' && !p.proposition).length },
          { key: 'p', label: 'Proposition à décider', tone: 'info', count: points.filter((p) => p.statut !== 'TRANCHE' && !!p.proposition).length },
          { key: 't', label: 'Tranché', tone: 'good', count: tranches },
        ]} />
      <StatusDistribution title="Fonctions conditionnées" unitLabel="fonctions" emptyText="Aucune fonction conditionnée."
        items={[{ key: 'a', label: 'En attente de base légale', tone: 'warning', count: fonctions.filter((f) => f.enAttente).length }, { key: 't', label: 'Base légale tranchée', tone: 'good', count: fonctions.filter((f) => !f.enAttente).length }]} />
      <BarChartViz className="viz-span-all" title="Points ouverts par autorité compétente" orientation="horizontal" format={entier} series={SERIE_N('Points ouverts')}
        rows={barresDe(countBy(points.filter((p) => p.statut !== 'TRANCHE'), 'autorite').slice(0, 8))} emptyText="Tous les points sont tranchés." note="Huit autorités les plus sollicitées (liste complète dans le tableau)." />
    </ChartGrid>
  );
}

const CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5'];
export function DonneesVisuels({ depots, classes }: { depots: { classe: string; enregistrements: number; purgeable: boolean; source: string }[]; classes: Record<string, string> }) {
  const lib = (c: string) => `${c} — ${classes[c] ?? c}`;
  return (
    <ChartGrid min={300}>
      <BarChartViz title="Dépôts par classe" orientation="horizontal" format={entier} series={SERIE_N('Dépôts')}
        rows={CLASSES.map((c) => ({ key: c, label: lib(c), values: { n: depots.filter((d) => d.classe === c).length } }))} />
      <BarChartViz title="Enregistrements par classe" orientation="horizontal" format={entier} series={SERIE_N('Enregistrements')}
        rows={CLASSES.map((c) => ({ key: c, label: lib(c), values: { n: depots.filter((d) => d.classe === c).reduce((s, d) => s + d.enregistrements, 0) } }))} />
      <StatusDistribution title="Conservation des dépôts" unitLabel="dépôts"
        items={[
          { key: 'p', label: 'Purgeable (règle de conservation)', tone: 'info', count: depots.filter((d) => d.purgeable).length },
          { key: 'n', label: 'Jamais purgé (financier, audit, preuve)', tone: 'good', count: depots.filter((d) => !d.purgeable).length },
          { key: 'a', label: 'À classer', tone: 'warning', count: depots.filter((d) => d.source === 'A_CLASSER').length },
        ]} />
    </ChartGrid>
  );
}
