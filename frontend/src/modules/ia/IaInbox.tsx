import { useMemo, useState } from 'react';
import type { AIRecommendation } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { AIInsightPanel } from '../../components/AIInsightPanel';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api, asList } from '../../lib/api';
import IaRecCard from './IaRecCard';
import { AUTONOMY_LABEL, AUTONOMY_SHORT, STATUS_LABEL } from './labels';
import type { Autonomy, IaRec, IaStatus } from './types';

const STATUS_FILTERS: ('ALL' | IaStatus)[] = ['EMISE', 'TRAITEE_AUTO', 'ACCEPTEE', 'MODIFIEE', 'REJETEE', 'ANNULEE', 'ALL'];
const LEVELS: ('ALL' | Autonomy)[] = ['ALL', 'A_AUTO', 'B_VALIDATION', 'C_RECOMMANDATION'];

/** Boîte de réception de la couche d'intelligence : par agent, par niveau, validation B, décision C, annulation. */
export default function IaInbox() {
  const { user } = useApp();
  const q = useApi(async () => asList<IaRec>(await api<unknown>('/v1/ia/inbox')), [user?.id]);
  const legacy = useApi(async () => asList<AIRecommendation>(await api<unknown>('/v1/ai/recommendations'), 'recommendations'), [user?.id]);
  const [status, setStatus] = useState<'ALL' | IaStatus>('EMISE');
  const [level, setLevel] = useState<'ALL' | Autonomy>('ALL');
  const [agent, setAgent] = useState('ALL');
  const all = useMemo(() => q.data ?? [], [q.data]);
  const agents = useMemo(() => [...new Map(all.map((r) => [r.agentCode, r.agent])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const list = all.filter((r) => (status === 'ALL' || r.status === status) && (level === 'ALL' || r.autonomy === level) && (agent === 'ALL' || r.agentCode === agent));
  const count = (s: 'ALL' | IaStatus) => all.filter((r) => (s === 'ALL' || r.status === s) && (level === 'ALL' || r.autonomy === level) && (agent === 'ALL' || r.agentCode === agent)).length;
  const kpis = [
    { label: 'À décider', value: all.filter((r) => r.status === 'EMISE').length },
    { label: 'Validations B en attente', value: all.filter((r) => r.status === 'EMISE' && r.canValidate && r.actions.some((a) => a.level === 'B' && a.status === 'PROPOSEE')).length },
    { label: 'Actions A exécutées', value: all.reduce((n, r) => n + r.actions.filter((a) => a.status === 'EXECUTEE_AUTO').length, 0) },
    { label: 'Décidées', value: all.filter((r) => ['ACCEPTEE', 'MODIFIEE', 'REJETEE'].includes(r.status)).length },
    { label: 'Annulées', value: all.filter((r) => r.status === 'ANNULEE').length },
  ];
  const replace = (n: IaRec) => q.setData(all.map((x) => (x.id === n.id ? n : x)));

  return (
    <div className="stack">
      <div className="kpi-row ia-kpis">
        {kpis.map((k) => (
          <div className="kpi" key={k.label}><div className="kpi-label">{k.label}</div><div className="kpi-value">{q.data ? k.value : '—'}</div></div>
        ))}
      </div>
      <div className="ia-filters">
        <label className="field ia-select">
          <span className="label">Agent</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="ALL">Tous les agents</option>
            {agents.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <div className="field">
          <span className="label">Niveau d’autonomie</span>
          <div className="seg seg-sm" role="group" aria-label="Niveau d’autonomie">
            {LEVELS.map((l) => (
              <button key={l} type="button" aria-pressed={level === l} onClick={() => setLevel(l)} title={l === 'ALL' ? undefined : AUTONOMY_LABEL[l]}>
                {l === 'ALL' ? 'Tous' : `Niveau ${AUTONOMY_SHORT[l]}`}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="seg seg-wrap ia-status-seg" role="group" aria-label="Statut">
        {STATUS_FILTERS.map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === 'ALL' ? 'Toutes' : STATUS_LABEL[s]} <span className="count">{count(s)}</span>
          </button>
        ))}
      </div>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && list.length === 0 && <EmptyState title="Aucune recommandation pour ces filtres" icon="analysis" />}
      <div className="stack">
        {list.map((r) => <IaRecCard key={r.id} rec={r} onChange={replace} />)}
      </div>

      {(legacy.data ?? []).length > 0 && (
        <details className="panel ia-legacy">
          <summary><strong>Recommandations des tableaux de bord</strong> <span className="muted small">({legacy.data!.length}) — panneaux d’analyse du Gouverneur, du Trésor et des communications</span></summary>
          <div className="stack">
            {legacy.data!.map((r) => (
              <AIInsightPanel key={r.id} rec={r} onDecided={(n) => legacy.setData((legacy.data ?? []).map((x) => (x.id === n.id ? n : x)))} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
