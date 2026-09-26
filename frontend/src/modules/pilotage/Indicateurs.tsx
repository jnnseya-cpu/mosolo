import { useMemo, useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { ExportButton, FiltersBar, KPI_STATUS, kpiTone, qs, ScopeLine, TrendMark, useFmt, type Filters, type Kpi, type Scope } from './shared';
import './pilotage.css';

interface KpiResponse { generatedAt: string; scope: Scope; summary: { total: number; measured: number; onTarget: number; offTarget: number }; kpis: Kpi[] }

/** Catalogue des indicateurs : définition, formule, source, valeur réelle, cible, tendance. */
export default function Indicateurs() {
  const { user } = useApp();
  const f = useFmt();
  const [filters, setFilters] = useState<Filters>({});
  const [domain, setDomain] = useState<string>('');
  const q = useApi(() => api<KpiResponse>(`/v1/pilotage/indicateurs${qs({ ...filters })}`), [user?.id, JSON.stringify(filters)]);
  const domains = useMemo(() => [...new Set((q.data?.kpis ?? []).map((k) => k.domain))], [q.data]);
  const kpis = (q.data?.kpis ?? []).filter((k) => !domain || k.domain === domain);

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 39 et annexe H" title="Catalogue des indicateurs" lead="Chaque indicateur est calculé sur les données réelles du socle. Un indicateur sans source mesurable est déclaré « non mesuré » : aucune valeur n’est inventée.">
        <ExportButton kind="indicateurs" params={{ ...filters }} label="Exporter (CSV + JSON signés)" />
      </PageHead>
      <FiltersBar value={filters} onChange={setFilters} lock={q.data?.scope ?? null} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <>
          <ScopeLine scope={q.data.scope} generatedAt={q.data.generatedAt} />
          <div className="pl-figs" style={{ marginBottom: 16 }}>
            <div className="pl-fig"><span>Indicateurs</span><strong>{q.data.summary.total}</strong></div>
            <div className="pl-fig"><span>Mesurés</span><strong>{q.data.summary.measured}</strong></div>
            <div className="pl-fig"><span>Cible atteinte</span><strong>{q.data.summary.onTarget}</strong></div>
            <div className="pl-fig"><span>Sous la cible</span><strong>{q.data.summary.offTarget}</strong></div>
          </div>
          <div className="pl-tabs" role="group" aria-label="Domaine" style={{ marginBottom: 12 }}>
            <button type="button" aria-pressed={domain === ''} onClick={() => setDomain('')}>Tous</button>
            {domains.map((d) => <button key={d} type="button" aria-pressed={domain === d} onClick={() => setDomain(d)}>{d}</button>)}
          </div>
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
                  <dl>
                    <dt>Définition</dt><dd>{k.definition}</dd>
                    <dt>Formule</dt><dd>{k.formula}</dd>
                    <dt>Source</dt><dd>{k.source}</dd>
                    <dt>Cible</dt><dd>{k.targetLabel}</dd>
                    {k.denominator !== undefined && <><dt>Base</dt><dd>{k.numerator ?? 0} / {k.denominator}</dd></>}
                    <dt>Référence</dt><dd>{k.reference}{k.structural ? ' · mesure structurelle' : ''}</dd>
                  </dl>
                  {k.detail && <p className="small muted">{k.detail}</p>}
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
