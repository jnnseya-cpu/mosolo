/**
 * Gestion documentaire — visuels (trousse de visualisation, 27/09/2026), dérivés de /v1/documents et
 * /v1/documents/indicateurs (déjà chargés par l'écran). Intégrité « non mesurée » tant qu'aucun contrôle n'a eu lieu.
 */
import { countBy } from '../../lib/aggregate';
import { BarChartViz, ChartGrid, fmtNombre, GaugeMeter, KpiGrid, KpiTile } from '../../components/viz';
import { ActiviteParJour, Etats, etatsDe, Parts } from '../plateforme/visuels';
import '../plateforme/visuels.css';

interface Ind {
  volume: { documents: number; actifs: number; purges: number; versions: number; octets: number; byCategory: Record<string, { documents: number; bytes: number }> };
  classification: { proposees: number; confirmees: number };
  integrite: { statut: string; derniereVerification?: string; verifiees?: number; conformes?: number; ecarts?: number; motif?: string };
}
interface Doc { status: string; categoryLabel: string; category: string; classification: { status: string }; versions: { uploadedAt: string }[]; legalHold?: unknown }

const mo = (n: number) => n / 1_048_576;

export function DocumentsVisuels({ ind, docs, labels }: { ind: Ind | null; docs: Doc[] | null; labels: Record<string, string> }) {
  const integ = ind?.integrite.statut === 'MESURE' && ind.integrite.verifiees ? (100 * (ind.integrite.conformes ?? 0)) / ind.integrite.verifiees : null;
  return (
    <div className="vz-bloc" data-testid="documents-visuels">
      {ind && (
        <KpiGrid max={4} label="Gestion documentaire — chiffres clés">
          <KpiTile hero label="Documents" value={ind.volume.documents} state={{ label: `${ind.volume.actifs} actif(s), chiffré(s)`, tone: 'good' }} sub={`${ind.volume.versions} version(s) · ${ind.volume.purges} purgé(s)`} />
          <KpiTile label="Volume stocké" value={mo(ind.volume.octets)} unit="Mo" format={(v) => fmtNombre(v, 2)} sub="chiffré au repos" />
          <KpiTile label="Classifications à confirmer" value={ind.classification.proposees} state={{ label: `${ind.classification.confirmees} confirmée(s)`, tone: ind.classification.proposees ? 'warning' : 'good' }} />
          <KpiTile label="Écarts d’intégrité" value={ind.integrite.statut === 'MESURE' ? ind.integrite.ecarts ?? 0 : null} reason={ind.integrite.motif ?? 'Aucun contrôle d’intégrité exécuté.'}
            state={ind.integrite.statut === 'MESURE' ? { label: ind.integrite.ecarts ? 'À examiner' : 'Aucun écart', tone: ind.integrite.ecarts ? 'critical' : 'good' } : undefined} />
        </KpiGrid>
      )}
      <ChartGrid min={280} label="Gestion documentaire — graphiques">
        {ind && (
          <GaugeMeter title="Intégrité vérifiée" subtitle={ind.integrite.statut === 'MESURE' ? `${ind.integrite.conformes}/${ind.integrite.verifiees} version(s) conforme(s)` : undefined}
            value={integ} unit="%" format={(v) => fmtNombre(v, 1)} reason={ind.integrite.motif ?? 'Aucun contrôle d’intégrité exécuté.'} />
        )}
        {ind && (
          <Parts title="Classification des pièces" centerLabel="pièces" emptyText="Aucune pièce"
            slices={[{ key: 'p', label: 'Proposée (à confirmer)', value: ind.classification.proposees }, { key: 'c', label: 'Confirmée par une personne', value: ind.classification.confirmees }]} />
        )}
        {ind && (
          <BarChartViz className="viz-span-2" title="Documents par catégorie" orientation="horizontal" series={[{ key: 'n', label: 'Documents' }]} format={(v) => fmtNombre(v, 0)} emptyText="Aucune pièce"
            rows={Object.entries(ind.volume.byCategory).sort((a, b) => b[1].documents - a[1].documents).map(([k, v]) => ({ key: k, label: labels[k] ?? k, values: { n: v.documents } }))} />
        )}
        {docs && (
          <Etats title="Pièces par état" unitLabel="pièces" emptyText="Aucune pièce"
            items={etatsDe(docs, (d) => (d.status !== 'ACTIF' ? 'PURGE' : d.legalHold ? 'GEL' : 'ACTIF'), { ACTIF: { label: 'Active, chiffrée', tone: 'good' }, GEL: { label: 'Sous gel juridique', tone: 'warning' }, PURGE: { label: 'Purgée (empreinte conservée)', tone: 'neutral' } }, ['ACTIF', 'GEL', 'PURGE'])} />
        )}
        {docs && <ActiviteParJour title="Dépôts de versions" series={[{ key: 'v', label: 'Versions déposées', items: docs.flatMap((d) => d.versions.map((v) => ({ at: v.uploadedAt }))) }]} />}
        {docs && !ind && <Parts title="Pièces par catégorie" centerLabel="pièces" slices={countBy(docs, (d) => d.categoryLabel).map((c) => ({ key: c.key, label: c.key, value: c.count }))} />}
      </ChartGrid>
    </div>
  );
}
