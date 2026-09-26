import type { AIRecommendation } from '@mosolo/shared';
import { api, describeError } from '../lib/api';
import { useApi } from './useApi';

/** Demande une analyse contextuelle (POST /v1/ai/insights). */
export function useInsight(context: 'governor' | 'rental' | 'treasury' | 'communications', deps: unknown[] = [], subjectId?: string) {
  const q = useApi(() => api<AIRecommendation>('/v1/ai/insights', { method: 'POST', body: { context, ...(subjectId ? { subjectId } : {}) } }), deps);
  return { rec: q.data, loading: q.loading, error: q.error ? describeError(q.error).message : null, reload: q.reload };
}
