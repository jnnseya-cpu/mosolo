/**
 * Galerie de la trousse de visualisation (/visualisation/galerie) — rôles internes habilités.
 * Chaque composant est rendu avec les DONNÉES RÉELLES de la plateforme quand elles sont servies (pilotage, postes de
 * décision) ; sinon avec un jeu d'exemple nettement marqué [EXEMPLE] (non opposable). La section « États » montre le
 * chargement, le vide, l'erreur et le « non mesuré » que chaque composant sait afficher.
 * Référence : docs/document-maitre/charte-visualisation.md.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { countBy, kinshasaMonth, periodLabel, periodRange, share, sumBy, topN, trendOfSeries } from '../../lib/aggregate';
import { PageHead } from '../../components/Shell';
import { EmptyState, ExampleNotice } from '../../components/States';
import { Icon } from '../../components/Icon';
import {
  BarChartViz, ChartGrid, DonutViz, ETATS_PAIEMENT, fmtCompact, fmtNombre, GaugeMeter, HeatGrid, KpiGrid, KpiTile, LadderFunnel, LineAreaViz, MatrixHeat,
  ProgressMeter, sixEtatsFromLadder, Sparkline, StackedBarViz, StatusDistribution, TimelineStrip, TrendBadge, type LadderLevelLike,
} from '../../components/viz';
import { CATEGORY_LABELS, CHANNEL_LABELS, KPI_STATUS, kpiTone, useFmt, type DrillResult, type Kpi } from '../pilotage/shared';
import type { Fiche } from '../postes/common';

/** Rôles internes autorisés à ouvrir la galerie : les lecteurs des tableaux de pilotage (mêmes rôles que « Tableaux par profil »). */
export const ROLES_GALERIE = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R17', 'R18', 'R22', 'R23', 'R24'];

interface Echelle { levels: LadderLevelLike[]; generatedAt: string }
interface Indicateurs { kpis: Kpi[] }

async function essai<T>(path: string): Promise<{ data: T | null; motif: string | null }> {
  try { return { data: await api<T>(path), motif: null }; } catch (e) { return { data: null, motif: describeError(e).message }; }
}

function Source({ reel, motif, api: chemin }: { reel: boolean; motif?: string | null; api: string }) {
  return reel
    ? <span className="viz-source"><Icon name="check" size={12} /> Données réelles · {chemin}</span>
    : <span className="viz-source"><Icon name="info" size={12} /> [EXEMPLE] données illustratives, non opposables{motif ? ` — données réelles indisponibles : ${motif}` : ''}</span>;
}

const cdf = (m?: MoneyJSON | null) => (m ? Number(m.amount) : null);

// ————————————————————————— jeux d'exemple (marqués [EXEMPLE], non contractuels) —————————————————————————

const EX_PAIEMENTS = [
  { key: 'PAYE', count: 812 }, { key: 'EN_ATTENTE', count: 143 }, { key: 'IMPAYE', count: 61 },
];
const EX_JOURS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const EX_HEURES = Array.from({ length: 24 }, (_, h) => `${h} h`);
// Profil d'affluence horaire illustratif (paiements par heure) : creux la nuit, pics en fin de matinée — [EXEMPLE].
const EX_MATRICE = EX_JOURS.map((_, j) => EX_HEURES.map((__, h) => (h < 6 ? (j === 6 ? null : 1 + (h % 2)) : Math.round((j < 5 ? 38 : 16) * Math.exp(-((h - 11) ** 2) / 18) + (j < 5 ? 6 : 3)))));
const EX_FRISE = [
  { id: 'e1', at: '2026-09-01T09:00:00Z', category: 'Décisions', label: 'Campagne IRL validée [EXEMPLE]' },
  { id: 'e2', at: '2026-09-08T11:00:00Z', category: 'Alertes', label: 'Écart de rapprochement (Limete) [EXEMPLE]' },
  { id: 'e3', at: '2026-09-12T08:30:00Z', category: 'Échéances', label: 'Échéance vignette [EXEMPLE]' },
  { id: 'e4', at: '2026-09-19T15:00:00Z', category: 'Décisions', label: 'Délégation au ministre des Finances [EXEMPLE]' },
  { id: 'e5', at: '2026-09-24T10:00:00Z', category: 'Alertes', label: 'Suspension conservatoire d’un point de paiement [EXEMPLE]' },
  { id: 'e6', at: '2026-09-27T07:00:00Z', category: 'Échéances', label: 'Note du lundi [EXEMPLE]' },
];

export default function GalerieVisualisation() {
  const { user } = useApp();
  const f = useFmt();
  const autorise = !user || user.roles.some((r) => ROLES_GALERIE.includes(r));
  const q = useApi(async () => {
    const [echelle, communes, categories, canaux, mois, indicateurs, accueil] = await Promise.all([
      essai<Echelle>('/v1/pilotage/echelle'), essai<DrillResult>('/v1/pilotage/drill/commune'), essai<DrillResult>('/v1/pilotage/drill/category'),
      essai<DrillResult>('/v1/pilotage/drill/channel'), essai<DrillResult>('/v1/pilotage/drill/month'), essai<Indicateurs>('/v1/pilotage/indicateurs'),
      essai<{ bloc1?: { fiches: Fiche[] }; fiches?: Fiche[] }>('/v1/postes/accueil'),
    ]);
    return { echelle, communes, categories, canaux, mois, indicateurs, accueil };
  }, [user?.id]);

  if (!autorise) return <div className="page"><PageHead title="Galerie de visualisation" /><EmptyState title="Accès réservé" icon="lock">Galerie réservée aux rôles internes habilités (pilotage, trésor, audit, plateforme).</EmptyState></div>;
  const d = q.data;
  const loading = q.loading && !d;

  // Six états (échelle réelle)
  const ladder = d?.echelle.data?.levels;
  // Mois (12 derniers, jours de Kinshasa) : les mois sans fait valent 0 (le serveur ne liste que les mois actifs).
  const cur = kinshasaMonth(new Date())!;
  const [yy, mm] = cur.split('-').map(Number) as [number, number];
  const mois = periodRange(new Date(Date.UTC(yy, mm - 12, 1)).toISOString().slice(0, 7), cur, 'month');
  const rowOf = (k: string) => d?.mois.data?.rows.find((r) => r.key === k);
  const serie = (lvl: string) => mois.map((k) => cdf(rowOf(k)?.values[lvl]?.consolidatedCdf) ?? 0);
  const encaisse = serie('confirmed');
  const rapproche = serie('reconciled');
  const tEnc = trendOfSeries(encaisse);
  // Communes
  const comRows = d?.communes.data?.rows.filter((r) => r.key !== 'NON_ATTRIBUE') ?? [];
  // Catégories et canaux
  const catRows = d?.categories.data?.rows ?? [];
  const canRows = d?.canaux.data?.rows ?? [];
  // Indicateurs : répartition par état (countBy) et un indicateur pour la jauge
  const kpis = d?.indicateurs.data?.kpis ?? [];
  const parEtat = countBy(kpis, 'status');
  const recon = kpis.find((k) => k.code === 'RAPPROCHEMENT_J1');
  const part = kpis.find((k) => k.code === 'PART_NUMERIQUE');
  const cible = (k?: Kpi) => { const m = k ? /[≥>]\s*(\d+(?:[.,]\d+)?)\s*%/.exec(k.targetLabel) : null; return m ? Number(m[1]!.replace(',', '.')) : undefined; };
  // Frise : échéances réelles des fiches du poste de décision
  const fiches = d?.accueil.data?.bloc1?.fiches ?? d?.accueil.data?.fiches ?? [];
  const friseReelle = fiches.map((x) => ({ id: x.id, at: x.echeance.date, category: x.echeance.urgente ? 'Urgent' : x.echeance.enRetard ? 'En retard' : 'À échéance', label: x.objet }));
  const friseExemple = friseReelle.length === 0 || fiches.some((x) => x.exemple);
  // Agrégations de démonstration sur une liste : sumBy par devise (jamais de mélange CDF / USD)
  const sommes = sumBy(comRows.flatMap((r) => (r.values.assessed?.amounts ?? []).map((m) => ({ commune: r.key, montant: m }))), (x) => x.montant.currency, 'montant');

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Plateforme · trousse de visualisation" title="Galerie de visualisation"
        lead="Chaque composant de la trousse, avec les données réelles de la plateforme quand elles sont servies, sinon un exemple marqué [EXEMPLE]. Règles : charte de visualisation (document maître)." />
      <ExampleNotice text="Les blocs marqués [EXEMPLE] sont illustratifs et non opposables ; tous les autres sont calculés sur les données réelles, sans modification du serveur (agrégations côté écran)." />

      <h2 className="section-title">1. Tuiles d’indicateurs, courbes miniatures et tendances</h2>
      <KpiGrid max={4}>
        <KpiTile hero label="Encaissé — mois courant" value={encaisse[encaisse.length - 1] ?? null} unit="CDF" format={fmtCompact} loading={loading}
          state={{ label: 'Encaissé', tone: 'info' }} delta={{ trend: tEnc, versus: 'vs mois précédent' }}
          spark={{ values: encaisse, labels: mois.map((m) => periodLabel(m, 'month')), label: 'Encaissé, 12 derniers mois' }} sub={<Source reel={!!d?.mois.data} motif={d?.mois.motif} api="/v1/pilotage/drill/month" />} />
        <KpiTile label="Rapproché — mois courant" value={rapproche[rapproche.length - 1] ?? null} unit="CDF" format={fmtCompact} loading={loading}
          state={{ label: 'Rapproché', tone: 'good' }} delta={{ trend: trendOfSeries(rapproche), versus: 'vs mois précédent' }}
          spark={{ values: rapproche, labels: mois.map((m) => periodLabel(m, 'month')), label: 'Rapproché, 12 derniers mois' }} />
        <KpiTile label={recon?.label ?? 'Rapprochement à J+1'} value={recon?.value === null || !recon ? null : Number(recon.value)} unit="%" loading={loading}
          reason={recon?.detail ?? 'Indicateur non servi'} state={recon ? { label: KPI_STATUS[recon.status], tone: kpiTone(recon) } : undefined}
          target={cible(recon) !== undefined ? { value: cible(recon)!, label: recon!.targetLabel } : undefined} />
        <KpiTile label="Potentiel estimé" value={null} reason={ladder?.find((l) => l.level === 'potential')?.note ?? 'Modèle de potentiel non calibré.'} state={{ label: 'Non mesuré', tone: 'neutral' }} />
      </KpiGrid>
      <p className="small muted">Badges de tendance seuls : <TrendBadge current={120} previous={100} versus="vs veille" /> <TrendBadge current={80} previous={100} versus="vs veille" /> <TrendBadge current={80} previous={100} better="BAISSE" versus="(délai, baisse favorable)" /> <TrendBadge current={5} previous={null} versus="vs veille" /> [EXEMPLE]</p>
      <div style={{ maxWidth: 240, margin: '8px 0 24px' }}><Sparkline values={encaisse} labels={mois.map((m) => periodLabel(m, 'month'))} label="Encaissé, 12 derniers mois" format={fmtCompact} area /></div>

      <h2 className="section-title">2. Graphiques</h2>
      <ChartGrid min={320}>
        <LadderFunnel className="viz-span-2" title="Échelle des six états (LadderFunnel)" subtitle="Potentiel → disponible, données réelles ; montants par devise, barres en contre-valeur CDF"
          steps={ladder ? sixEtatsFromLadder(ladder, f.amounts) : []} loading={loading} error={d && !ladder ? new Error(d.echelle.motif ?? 'échelle indisponible') : undefined}
          note={<Source reel={!!ladder} motif={d?.echelle.motif} api="/v1/pilotage/echelle" />} />
        <BarChartViz title="Barres groupées (BarChartViz)" subtitle="Liquidé, confirmé, rapproché par commune — contre-valeur CDF" orientation="horizontal" format={fmtCompact} loading={loading}
          series={[{ key: 'assessed', label: 'Liquidé' }, { key: 'confirmed', label: 'Confirmé' }, { key: 'reconciled', label: 'Rapproché' }]}
          rows={comRows.map((r) => ({ label: r.key, values: { assessed: cdf(r.values.assessed?.consolidatedCdf), confirmed: cdf(r.values.confirmed?.consolidatedCdf), reconciled: cdf(r.values.reconciled?.consolidatedCdf) } }))}
          note={<Source reel={!!d?.communes.data} motif={d?.communes.motif} api="/v1/pilotage/drill/commune" />} />
        <BarChartViz title="Colonnes avec cible (BarChartViz)" subtitle="Encaissé par mois — la ligne de référence est un exemple de cible" format={fmtCompact} loading={loading} example
          series={[{ key: 'v', label: 'Encaissé' }]} rows={mois.slice(-6).map((m, i) => ({ label: periodLabel(m, 'month'), values: { v: encaisse.slice(-6)[i] ?? 0 } }))}
          reference={{ value: Math.max(1, ...encaisse) * 0.8, label: 'Cible [EXEMPLE]' }} note="Barres réelles ; la cible (80 % du maximum) est illustrative [EXEMPLE]." />
        <StackedBarViz title="Empilé à 100 % (StackedBarViz)" subtitle="Encaissé par commune — part rapprochée et part en attente de rapprochement" loading={loading}
          series={[{ key: 'confirmed', label: 'Confirmé non rapproché' }, { key: 'reconciled', label: 'Rapproché' }]} format={fmtCompact}
          rows={comRows.filter((r) => (cdf(r.values.confirmed?.consolidatedCdf) ?? 0) > 0).map((r) => {
            const c = cdf(r.values.confirmed?.consolidatedCdf) ?? 0; const rr = cdf(r.values.reconciled?.consolidatedCdf) ?? 0;
            return { label: r.key, values: { confirmed: Math.max(0, c - rr), reconciled: rr } };
          })}
          note="Le rapproché est inclus dans le confirmé : la pile sépare « confirmé non rapproché » et « rapproché » (aucun double compte)." />
        <LineAreaViz className="viz-span-2" title="Série temporelle (LineAreaViz)" subtitle="Encaissé et rapproché, 12 mois de Kinshasa — contre-valeur CDF" granularity="month" area format={fmtCompact} loading={loading}
          series={[{ key: 'enc', label: 'Encaissé' }, { key: 'rap', label: 'Rapproché' }]} points={mois.map((m, i) => ({ date: m, values: { enc: encaisse[i] ?? 0, rap: rapproche[i] ?? 0 } }))}
          note={<Source reel={!!d?.mois.data} motif={d?.mois.motif} api="/v1/pilotage/drill/month" />} />
        <DonutViz title="Anneau (DonutViz)" subtitle="Liquidé par catégorie — contre-valeur CDF" centerLabel="CDF liquidés" format={fmtCompact} loading={loading}
          slices={catRows.map((r) => ({ key: r.key, label: CATEGORY_LABELS[r.key] ?? r.key, value: cdf(r.values.assessed?.consolidatedCdf) ?? 0 }))}
          note={<Source reel={!!d?.categories.data} motif={d?.categories.motif} api="/v1/pilotage/drill/category" />} />
        <DonutViz title="Anneau avec « Autres »" subtitle="Encaissé par canal — au-delà de 5 parts, repli dans « Autres »" centerLabel="CDF encaissés" format={fmtCompact} loading={loading}
          slices={canRows.map((r) => ({ key: r.key, label: CHANNEL_LABELS[r.key] ?? r.key, value: cdf(r.values.confirmed?.consolidatedCdf) ?? 0 }))} />
        <GaugeMeter title="Jauge (GaugeMeter)" subtitle={recon?.label ?? 'Rapprochement à J+1'} loading={loading} value={recon?.value == null ? null : Number(recon.value)} unit="%"
          target={cible(recon)} targetLabel={recon?.targetLabel} reason={recon?.detail ?? 'Indicateur non servi'} tone={recon ? kpiTone(recon) : undefined} toneLabel={recon ? KPI_STATUS[recon.status] : undefined}
          note={<Source reel={!!recon} motif={d?.indicateurs.motif} api="/v1/pilotage/indicateurs" />} />
        <StatusDistribution title="Répartition par état (StatusDistribution)" subtitle={`${kpis.length} indicateurs, état servi par le serveur`} unitLabel="indicateurs" loading={loading}
          items={parEtat.map((r) => ({ key: r.key, label: KPI_STATUS[r.key as Kpi['status']] ?? r.key, count: r.count, tone: kpiTone({ status: r.key } as Kpi) }))}
          note={<Source reel={kpis.length > 0} motif={d?.indicateurs.motif} api="/v1/pilotage/indicateurs (countBy)" />} />
        <StatusDistribution title="États de paiement (préréglage)" subtitle="Payé / En attente / Impayé" unitLabel="paiements" example
          items={EX_PAIEMENTS.map((x) => ({ key: x.key, ...ETATS_PAIEMENT[x.key]!, count: x.count }))} note={<Source reel={false} api="" />} />
        <HeatGrid className="viz-span-2" title="Carte de chaleur des communes (HeatGrid)" subtitle="Rapproché par commune — contre-valeur CDF ; disposition schématique" loading={loading}
          measureLabel="Rapproché (contre-valeur CDF)" unit="CDF" format={fmtCompact} unmeasuredReason="aucun paiement rapproché rattaché à cette commune"
          cells={comRows.map((r) => ({ commune: r.key, value: cdf(r.values.reconciled?.consolidatedCdf) }))}
          note={<Source reel={!!d?.communes.data} motif={d?.communes.motif} api="/v1/pilotage/drill/commune" />} />
        <MatrixHeat className="viz-span-2" title="Matrice jour × heure (MatrixHeat)" subtitle="Paiements par heure de Kinshasa" example rows={EX_JOURS} cols={EX_HEURES} values={EX_MATRICE}
          measureLabel="Paiements" note={<Source reel={false} api="" />} />
        <TimelineStrip className="viz-span-2" title="Frise d’événements (TimelineStrip)" subtitle="Échéances des dossiers en attente de décision" example={friseExemple}
          events={friseReelle.length ? friseReelle : EX_FRISE} categories={friseReelle.length ? ['Urgent', 'En retard', 'À échéance'] : ['Décisions', 'Alertes', 'Échéances']}
          note={<Source reel={!friseExemple} motif={d?.accueil.motif} api="/v1/postes/accueil" />} />
      </ChartGrid>

      <h2 className="section-title">3. Jauge linéaire et agrégations</h2>
      <ChartGrid min={300}>
        <section className="panel">
          <ProgressMeter label={part?.label ?? 'Part des paiements numériques'} value={part?.value == null ? null : Number(part.value)} unit="%" target={cible(part)} targetLabel={part?.targetLabel}
            reason={part?.detail ?? 'Indicateur non servi'} tone={part ? kpiTone(part) : undefined} toneLabel={part ? KPI_STATUS[part.status] : undefined} />
          <p className="small muted" style={{ marginTop: 8 }}><Source reel={!!part} motif={d?.indicateurs.motif} api="/v1/pilotage/indicateurs" /></p>
        </section>
        <section className="panel">
          <h3 className="panel-title">sumBy par devise (jamais de mélange)</h3>
          <ul className="plain-list small">
            {sommes.length ? sommes.map((s) => <li key={s.key}><strong>{s.key}</strong> : {f.amounts(Object.values(s.totals) as MoneyJSON[])} — {s.count} montant(s) liquidé(s) sur {comRows.length} commune(s)</li>) : <li>Aucune donnée pour cette période</li>}
          </ul>
          <p className="small muted">Parts (plus fort reste) des communes au rapproché : {(() => {
            const top = topN(comRows.map((r) => ({ key: r.key, v: cdf(r.values.reconciled?.consolidatedCdf) ?? 0 })), 3, (r) => ('v' in r ? r.v : 0));
            const vals = top.rows.map((r) => ('other' in r ? r.value : r.v));
            const parts = share(vals);
            return top.rows.map((r, i) => `${r.key} ${parts[i] ?? '—'} %`).join(' · ') || '—';
          })()}</p>
        </section>
      </ChartGrid>

      <h2 className="section-title">4. États de chaque composant</h2>
      <ChartGrid min={260}>
        <BarChartViz title="Chargement" series={[{ key: 'v', label: 'Valeur' }]} rows={[]} loading />
        <BarChartViz title="Vide" series={[{ key: 'v', label: 'Valeur' }]} rows={[]} />
        <DonutViz title="Erreur" slices={[]} error={new Error('Service injoignable (exemple)')} onRetry={() => q.reload()} />
        <LineAreaViz title="Non mesuré" series={[{ key: 'v', label: 'Valeur' }]} points={[]} unmeasured="aucune assignation certifiée pour l’exercice ; l’écart n’est pas calculable." />
        <KpiTile label="Tuile en chargement" value={null} loading />
        <KpiTile label="Tuile non mesurée" value={null} reason="Modèle de potentiel non calibré (§ 38.2)." />
        <GaugeMeter title="Jauge non mesurée" value={null} unit="%" target={95} reason="Aucun paiement sur la période." />
        <KpiTile label="Valeur formatée" value={fmtNombre(1234567.8)} unit="CDF" state={{ label: 'Exemple', tone: 'neutral' }} example />
      </ChartGrid>
    </div>
  );
}
