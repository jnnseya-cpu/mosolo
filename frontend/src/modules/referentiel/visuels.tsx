/**
 * Référentiel des recettes et modèle de données — visuels (trousse de visualisation, 27/09/2026). Aucun taux ni montant
 * (le référentiel n'en porte pas) : volumes de lignes, compétence, complétude de l'inventaire § 7.4, codes, effectifs
 * des entités et conformité de la matrice d'habilitations, tous lus sur les réponses déjà chargées.
 */
import { BarChartViz, ChartGrid, KpiGrid, KpiTile, ProgressMeter, StatusDistribution } from '../../components/viz';
import { countBy } from '../../lib/aggregate';
import { entier, SERIE_N } from '../fiscal/visuels';

export function RecettesVisuels({ lines, sections, codes }: {
  lines: { code: string; section: string; competenceLabel: string; activation: { activable: boolean }; inventory?: { renseigne: boolean }[] }[];
  sections: { id: string; title: string }[]; codes: { status: string }[] | null;
}) {
  const attrs = lines.flatMap((l) => l.inventory ?? []);
  const renseignes = attrs.filter((a) => a.renseigne).length;
  return (
    <div className="stack viz-block" aria-label="Résumé visuel du référentiel">
      <KpiGrid max={4} label="Référentiel — chiffres clés">
        <KpiTile hero label="Lignes de recettes" value={lines.length} format={entier} state={{ label: 'Toutes à vérifier', tone: 'warning' }} />
        <KpiTile label="Activables" value={lines.filter((l) => l.activation.activable).length} format={entier} sub="règle ACTIVE et acte requis" />
        <KpiTile label="Inventaire § 7.4 renseigné" value={attrs.length ? renseignes : null} format={entier} sub={attrs.length ? `sur ${attrs.length} attributs` : undefined} reason="Inventaire réservé aux agents habilités." />
        <KpiTile label="Codes réservés" value={codes === null ? null : codes.length} format={entier} reason="Registre des codes réservé aux agents habilités." sub={codes ? `${codes.filter((c) => c.status === 'RETIRE').length} retiré(s), jamais réutilisé(s)` : undefined} />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Lignes par section du Cahier (ch. 7)" orientation="horizontal" format={entier} series={SERIE_N('Lignes')}
          rows={sections.map((s) => ({ key: s.id, label: s.title, values: { n: lines.filter((l) => l.section === s.id).length } }))} />
        <BarChartViz title="Lignes par compétence" orientation="horizontal" format={entier} series={SERIE_N('Lignes')}
          rows={countBy(lines, 'competenceLabel').map((r) => ({ key: r.key, label: r.key, values: { n: r.count } }))} note="Nombre de lignes, jamais un taux : le référentiel ne porte aucun taux." />
        {attrs.length > 0 && (
          <div className="panel"><ProgressMeter label="Complétude de l’inventaire de référence (§ 7.4)" value={renseignes} max={attrs.length} format={entier} unit={`sur ${attrs.length}`} toneLabel="Suivi (sans cible)" tone="neutral" />
            <p className="small muted">Une valeur inconnue reste « non renseigné » : rien n’est estimé à la place de la source.</p></div>
        )}
      </ChartGrid>
    </div>
  );
}

export function ModeleVisuels({ entities, roles }: { entities: { code: string; entity: string; total: number | null }[] | null; roles: { cahierRole: string; ok: boolean }[] | null }) {
  const mesurees = (entities ?? []).filter((e) => e.total !== null).sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  return (
    <ChartGrid min={300}>
      {entities && (
        <BarChartViz className="viz-span-2" title="Effectifs courants par entité" subtitle="sans donnée personnelle" orientation="horizontal" format={entier} series={SERIE_N('Enregistrements')}
          rows={mesurees.slice(0, 12).map((e) => ({ key: e.code, label: e.entity, values: { n: e.total } }))}
          note={`${mesurees.length} entité(s) comptée(s) sur ${entities.length} ; ${Math.max(0, mesurees.length - 12)} autre(s) dans le tableau.`} />
      )}
      {roles && (
        <StatusDistribution title="Matrice d’habilitations (ch. 12)" unitLabel="rôles"
          items={[{ key: 'ok', label: 'Conforme', tone: 'good', count: roles.filter((r) => r.ok).length }, { key: 'ko', label: 'Écart — examen requis', tone: 'critical', count: roles.filter((r) => !r.ok).length }]} />
      )}
    </ChartGrid>
  );
}
