/**
 * Indicateurs des modules 27 à 40 (spécification fonctionnelle, rubrique « Indicateurs » de chaque fiche) : valeurs
 * calculées sur les données réelles ; un indicateur sans source est affiché « non mesuré » avec son motif.
 */
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { DonutViz, fmtNombre, KpiGrid, KpiTile, StackedBarViz } from '../../components/viz';
import './pilotage.css';

const entier = (v: number) => fmtNombre(v, 0);

/** Visuels des modules 27 à 40 : mesurés / non mesurés par module (aucun chiffre inventé). */
export function VisuelsModules({ data }: { data: ModulesResponse }) {
  const total = data.mesures + data.nonMesures;
  return (
    <>
      <KpiGrid max={3} label="Indicateurs des modules 27 à 40 — synthèse">
        <KpiTile hero label="Indicateurs mesurés" value={data.mesures} format={entier} target={{ value: total, label: `sur ${total}`, max: total }} state={{ label: 'Données réelles', tone: 'good' }} />
        <KpiTile label="Non mesurés" value={data.nonMesures} format={entier} state={{ label: 'Source absente', tone: 'neutral' }} sub="Motif affiché dans le tableau" />
        <KpiTile label="Modules couverts" value={data.modules.length} format={entier} state={{ label: 'Modules 27 à 40', tone: 'info' }} />
      </KpiGrid>
      <div className="viz-grid" style={{ ['--viz-min' as string]: '300px' }}>
        <StackedBarViz className="viz-span-2" title="Mesurés et non mesurés par module" subtitle="Nombre d’indicateurs" mode="absolute" orientation="horizontal" format={entier}
          series={[{ key: 'm', label: 'Mesuré' }, { key: 'n', label: 'Non mesuré' }]}
          rows={data.modules.map((m) => ({ key: String(m.module), label: `${m.module} — ${m.titre}`, values: { m: m.indicateurs.filter((i) => i.statut === 'MESURE').length, n: m.indicateurs.filter((i) => i.statut !== 'MESURE').length } }))} />
        <DonutViz title="Couverture de la mesure" centerLabel="indicateurs" slices={[{ key: 'm', label: 'Mesurés', value: data.mesures }, { key: 'n', label: 'Non mesurés', value: data.nonMesures }]} />
      </div>
    </>
  );
}

export interface ModuleIndicator { code: string; libelle: string; statut: 'MESURE' | 'NON_MESURE'; valeur: string | null; detail: string; source: string }
export interface ModulesResponse { asOf: string; modules: { module: number; titre: string; indicateurs: ModuleIndicator[] }[]; mesures: number; nonMesures: number }

export function ModulesTable({ data }: { data: ModulesResponse }) {
  return (
    <div className="rtable-wrap">
      <table className="data-table rtable compact">
        <thead><tr><th>Module</th><th>Indicateur</th><th>Valeur</th><th>Détail et source</th></tr></thead>
        <tbody>{data.modules.flatMap((m) => m.indicateurs.map((i, k) => (
          <tr key={i.code}>
            <td data-label="Module">{k === 0 ? `${m.module} — ${m.titre}` : ''}</td>
            <td data-label="Indicateur" className="cell-primary">{i.libelle}</td>
            <td data-label="Valeur">{i.statut === 'MESURE' ? <strong>{i.valeur}</strong> : <StatusBadge tone="neutral" label="Non mesuré" />}</td>
            <td data-label="Détail" className="small">{i.detail} <span className="muted">— {i.source}</span></td>
          </tr>)))}</tbody>
      </table>
    </div>
  );
}

export default function IndicateursModules2740() {
  const { user } = useApp();
  const q = useApi(() => api<ModulesResponse>('/v1/pilotage/indicateurs-modules/27-40'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage" title="Indicateurs des modules 27 à 40"
        lead="Liquidation, paiement, règlement, rapprochement, quittances, arriérés, campagnes, terrain, inspection, exécution, recours, documents, notifications et renseignement : chaque indicateur est calculé sur les données réelles, ou déclaré non mesuré avec son motif." />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <p className="small">Au {q.data.asOf} : <strong>{q.data.mesures}</strong> indicateur(s) mesuré(s), {q.data.nonMesures} non mesuré(s) (source de données absente).</p>
          <VisuelsModules data={q.data} />
          <ModulesTable data={q.data} />
        </>
      )}
    </div>
  );
}
