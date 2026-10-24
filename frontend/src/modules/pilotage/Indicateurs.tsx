import { useMemo, useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { AUTORITES_POSTE, PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { ExportButton, FiltersBar, KPI_STATUS, kpiTone, qs, ScopeLine, TrendMark, useFmt, type Filters, type Kpi, type Scope } from './shared';
import './pilotage.css';
import { fmtNombre, KpiTile, StackedBarViz, StatusDistribution } from '../../components/viz';
import { ETATS_KPI, etatsDe, Tuiles, Visuels } from './visuels';

const STATUTS = Object.keys(ETATS_KPI) as Kpi['status'][];
const entier = (v: number) => fmtNombre(v, 0);

/** Visuels du catalogue : état de chaque indicateur (couleur d'état + icône + libellé), par domaine. */
export function VisuelsCatalogue({ kpis, summary }: { kpis: Kpi[]; summary: KpiResponse['summary'] }) {
  const domaines = [...new Set(kpis.map((k) => k.domain))];
  return (
    <div className="dash-grid" style={{ marginBottom: 16 }}>
      <Tuiles label="Catalogue des indicateurs — synthèse" max={4}>
        <KpiTile hero label="Indicateurs mesurés" value={summary.measured} format={entier} target={{ value: summary.total, label: `sur ${summary.total} indicateurs`, max: summary.total }} state={{ label: 'Données réelles', tone: 'info' }} />
        <KpiTile label="Cible atteinte" value={summary.onTarget} format={entier} state={{ label: 'Cible atteinte', tone: 'good' }} />
        <KpiTile label="Sous la cible" value={summary.offTarget} format={entier} state={{ label: 'Sous la cible', tone: summary.offTarget > 0 ? 'critical' : 'good' }} />
        <KpiTile label="Non mesurés" value={summary.total - summary.measured} format={entier} state={{ label: 'Source absente', tone: 'neutral' }} sub="Aucune valeur inventée" />
      </Tuiles>
      <Visuels label="Indicateurs en graphiques">
        <StatusDistribution title="Indicateurs par état" subtitle="Cible déclarée par le catalogue (§ 39) ; sans cible = suivi" unitLabel="indicateurs" items={etatsDe(kpis, (k) => k.status, ETATS_KPI)} />
        <StackedBarViz className="viz-span-2" title="États par domaine" subtitle="Nombre d’indicateurs par état et par domaine" mode="absolute" orientation="horizontal" format={entier}
          series={STATUTS.map((s) => ({ key: s, label: ETATS_KPI[s]!.label }))}
          rows={domaines.map((d) => ({ key: d, label: d, values: Object.fromEntries(STATUTS.map((s) => [s, kpis.filter((k) => k.domain === d && k.status === s).length])) }))} />
      </Visuels>
    </div>
  );
}

/**
 * Synthèse des autorités (29/09/2026, § 27 « Le Gouverneur n'a pas besoin de tout voir ») : six indicateurs de décision
 * affichés d'abord aux autorités (R01–R05), le catalogue complet restant à un clic (rien n'est retiré).
 * Sélection PAR DÉFAUT — À CONFIRMER PAR LE MAÎTRE D'OUVRAGE.
 */
export const SYNTHESE_AUTORITES = ['RAPPROCHEMENT_J1', 'ECART_ASSIGNATION', 'PAIEMENT_EMISES', 'COMMUNES_RECETTE', 'RECOURS_DANS_DELAI', 'ALERTES_CRITIQUES'];

interface KpiResponse { generatedAt: string; scope: Scope; summary: { total: number; measured: number; onTarget: number; offTarget: number }; kpis: Kpi[] }

/** Catalogue des indicateurs : définition, formule, source, valeur réelle, cible, tendance. */
export default function Indicateurs() {
  const { user } = useApp();
  const f = useFmt();
  const [filters, setFilters] = useState<Filters>({});
  const [domain, setDomain] = useState<string>('');
  const q = useApi(() => api<KpiResponse>(`/v1/pilotage/indicateurs${qs({ ...filters })}`), [user?.id, JSON.stringify(filters)]);
  const domains = useMemo(() => [...new Set((q.data?.kpis ?? []).map((k) => k.domain))], [q.data]);
  const autorite = !!user?.roles.some((r) => AUTORITES_POSTE.includes(r));
  const [complet, setComplet] = useState(false);
  const synthese = autorite && !complet;
  const kpis = (q.data?.kpis ?? []).filter((k) => (synthese ? SYNTHESE_AUTORITES.includes(k.code) : !domain || k.domain === domain))
    .sort((a, b) => (synthese ? SYNTHESE_AUTORITES.indexOf(a.code) - SYNTHESE_AUTORITES.indexOf(b.code) : 0));

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 39 et annexe H" title="Catalogue des indicateurs" lead="Chaque indicateur est calculé sur les données réelles du socle. Un indicateur sans source mesurable est déclaré « non mesuré » : aucune valeur n’est inventée.">
        <ExportButton kind="indicateurs" params={{ ...filters }} label="Exporter (CSV + JSON signés)" />
      </PageHead>
      <FiltersBar value={filters} onChange={setFilters} lock={q.data?.scope ?? null} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <>
          <ScopeLine scope={q.data.scope} generatedAt={q.data.generatedAt} />
          {autorite && (
            <div className="pl-tabs" role="group" aria-label="Affichage" style={{ marginBottom: 12 }}>
              <button type="button" aria-pressed={!complet} onClick={() => setComplet(false)}>Synthèse ({SYNTHESE_AUTORITES.length} indicateurs de décision)</button>
              <button type="button" aria-pressed={complet} onClick={() => setComplet(true)}>Catalogue complet ({q.data.summary.total} indicateurs)</button>
            </div>
          )}
          {synthese && <p className="small muted" style={{ marginBottom: 12 }}>Sélection par défaut — à confirmer par le maître d’ouvrage. Définition, formule et source : un clic sur « Comprendre ».</p>}
          {!synthese && <VisuelsCatalogue kpis={q.data.kpis} summary={q.data.summary} />}
          {!synthese && <div className="pl-figs" style={{ marginBottom: 16 }}>
            <div className="pl-fig"><span>Indicateurs</span><strong>{q.data.summary.total}</strong></div>
            <div className="pl-fig"><span>Mesurés</span><strong>{q.data.summary.measured}</strong></div>
            <div className="pl-fig"><span>Cible atteinte</span><strong>{q.data.summary.onTarget}</strong></div>
            <div className="pl-fig"><span>Sous la cible</span><strong>{q.data.summary.offTarget}</strong></div>
          </div>}
          {!synthese && <div className="pl-tabs" role="group" aria-label="Domaine" style={{ marginBottom: 12 }}>
            <button type="button" aria-pressed={domain === ''} onClick={() => setDomain('')}>Tous</button>
            {domains.map((d) => <button key={d} type="button" aria-pressed={domain === d} onClick={() => setDomain(d)}>{d}</button>)}
          </div>}
          <div className="pl-cat">
            {kpis.map((k) => {
              const tone = kpiTone(k);
              return (
                <article key={k.code} className={`pl-card t-${tone}`} aria-labelledby={`kpi-${k.code}`}>
                  <div className="pl-card-head">
                    <div className="min0">
                      <p className="pl-code">{k.code} · {k.domain}</p>
                      <h2 className="row-title" id={`kpi-${k.code}`}>{k.label}</h2>
                    </div>
                    <StatusBadge tone={tone} label={KPI_STATUS[k.status]} />
                  </div>
                  <p className="pl-card-value">{k.status === 'NON_MESURE' ? 'Non mesuré' : f.num(k.value, k.unit)}</p>
                  <TrendMark k={k} />
                  {k.question && <p className="small"><strong>Question de décision :</strong> {k.question}</p>}
                  {synthese ? (
                    <details>
                      <summary className="small">Comprendre</summary>
                      <Fiche k={k} />
                    </details>
                  ) : <Fiche k={k} />}
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Fiche d'un indicateur : définition, formule, source, cible, base, référence. */
function Fiche({ k }: { k: Kpi }) {
  return (
    <>
      <dl>
        <dt>Définition</dt><dd>{k.definition}</dd>
        <dt>Formule</dt><dd>{k.formula}</dd>
        <dt>Source</dt><dd>{k.source}</dd>
        <dt>Cible</dt><dd>{k.targetLabel}</dd>
        {k.denominator !== undefined && <><dt>Base</dt><dd>{k.numerator ?? 0} / {k.denominator}</dd></>}
        <dt>Référence</dt><dd>{k.reference}{k.structural ? ' · mesure structurelle' : ''}</dd>
      </dl>
      {k.detail && <p className="small muted">{k.detail}</p>}
    </>
  );
}
