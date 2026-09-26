import { useState } from 'react';
import type { AIRecommendation } from '@mosolo/shared';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { PageHead } from '../components/Shell';
import { AIInsightPanel } from '../components/AIInsightPanel';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { api, asList } from '../lib/api';
import type { UIKey } from '../lib/i18n';

const FILTERS = ['ALL', 'EMISE', 'ACCEPTEE', 'REJETEE', 'MODIFIEE'] as const;

export default function AIInbox() {
  const { tr, user } = useApp();
  const q = useApi(async () => asList<AIRecommendation>(await api<unknown>('/v1/ai/recommendations'), 'recommendations'), [user?.id]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('EMISE');
  const list = (q.data ?? []).filter((r) => filter === 'ALL' || r.status === filter);
  const count = (f: (typeof FILTERS)[number]) => (q.data ?? []).filter((r) => f === 'ALL' || r.status === f).length;
  return (
    <div className="page">
      <PageHead eyebrow={tr('ai.eyebrow')} title={tr('ai.inboxTitle')} lead={tr('ai.inboxLead')} />
      <div className="seg seg-wrap" role="group" aria-label={tr('ai.filter')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'ALL' ? tr('ai.all') : tr(`ai.status.${f}` as UIKey)} <span className="count">{count(f)}</span>
          </button>
        ))}
      </div>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && list.length === 0 && <EmptyState title={tr('ai.none')} icon="analysis" />}
      <div className="stack">
        {list.map((r) => (
          <AIInsightPanel key={r.id} rec={r} onDecided={(n) => q.setData((q.data ?? []).map((x) => (x.id === n.id ? n : x)))} />
        ))}
      </div>
    </div>
  );
}
