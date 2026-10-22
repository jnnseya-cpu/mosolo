/**
 * Couches du cadastre fiscal géospatial (Document maître FR 2, nouvelle version, § 17.1) : les 21 couches du Cahier,
 * leur source, la route ou l'écran qui les sert et l'effectif du périmètre du lecteur. Une couche sans source est
 * déclarée « non disponible » ; le potentiel estimé reste « non mesuré » (jamais inventé).
 */
import { useApp } from '../../context';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';

export interface LayerView { code: string; label: string; status: 'DISPONIBLE' | 'NON_MESURE' | 'NON_DISPONIBLE'; count: number | null; source: string; served: string; note?: string }
const TONE = { DISPONIBLE: 'good', NON_MESURE: 'neutral', NON_DISPONIBLE: 'warning' } as const;
const LABEL = { DISPONIBLE: 'Disponible', NON_MESURE: 'Non mesuré', NON_DISPONIBLE: 'Non disponible' } as const;

export function LayersList({ layers }: { layers: LayerView[] }) {
  return (
    <ul className="list-rows">
      {layers.map((l) => (
        <li key={l.code} className="list-row list-row-stack">
          <span className="row-title">{l.label} <StatusBadge tone={TONE[l.status]} label={LABEL[l.status]} />{l.count !== null ? <span className="small muted"> · {l.count}</span> : null}</span>
          <span className="small muted">{l.source} — {l.served}{l.note ? ` — ${l.note}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

export function CouchesCadastre() {
  const { user } = useApp();
  const q = useApi(() => api<{ layers: LayerView[]; notice: string }>('/v1/fiscal/couches'), [user?.id]);
  return (
    <details className="panel">
      <summary className="panel-title">Couches du cadastre fiscal (§ 17.1)</summary>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && <><p className="small muted">{q.data.notice}</p><LayersList layers={q.data.layers} /></>}
    </details>
  );
}
