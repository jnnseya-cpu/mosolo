import type { AIRecommendation } from '@mosolo/shared';
import { api, describeError } from '../lib/api';
import { useApi } from './useApi';

/**
 * Demande une analyse contextuelle (POST /v1/ai/insights). `enabled` (facultatif, défaut : oui) évite d'appeler le
 * serveur pour un rôle qui n'a pas droit à ce contexte (refus 403 attendu, inutile à provoquer).
 */
export function useInsight(context: 'governor' | 'rental' | 'treasury' | 'communications', deps: unknown[] = [], subjectId?: string, enabled = true) {
  const q = useApi(!enabled ? null : () => api<AIRecommendation>('/v1/ai/insights', { method: 'POST', body: { context, ...(subjectId ? { subjectId } : {}) } }), deps);
  return { rec: q.data, loading: q.loading, error: q.error ? describeError(q.error).message : null, reload: q.reload };
}
