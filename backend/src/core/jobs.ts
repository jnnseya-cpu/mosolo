/**
 * Tâches planifiées (liquidation automatique, répartition, tarification ParkSmart, réserve, échéanciers…) : une
 * exception n'est JAMAIS avalée en silence (deuxième passe adverse, 27/09/2026).
 *
 * - chaque échec est inscrit au journal d'audit (`system.job.failed`, message borné, sans pile ni chemin interne) ;
 * - l'exploitant est alerté une fois par tâche et par jour de Kinshasa (pas de tempête d'alertes : la tâche est
 *   rejouée au prochain passage, ce qui borne les nouvelles tentatives à la fréquence du planificateur) ;
 * - le processus ne s'arrête pas et aucune écriture partielle n'est « réparée » ici : chaque tâche reste idempotente.
 */
import type { AuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { kinshasaDate } from './clock.js';
import { ApiError } from './errors.js';

export interface JobContext {
  clock: Clock;
  audit: AuditLog;
  alerts: { raiseOnce(fingerprint: string, input: { type: string; severity: 'MEDIUM' | 'HIGH' | 'CRITICAL'; source: string; detail: string; context?: Record<string, unknown> }): unknown };
}

/** Message d'erreur publiable : code métier ou nom, texte borné, jamais la pile d'appels. */
export function describeError(e: unknown): { code: string; message: string } {
  if (e instanceof ApiError) return { code: e.code, message: e.message.slice(0, 300) };
  if (e instanceof Error) return { code: e.name || 'Error', message: e.message.slice(0, 300) };
  return { code: 'ERREUR', message: String(e).slice(0, 300) };
}

/**
 * Exécute un passage de tâche planifiée. Renvoie `ok: false` en cas d'échec (journalisé et alerté), sans propager.
 */
export function runScheduledJob(ctx: JobContext, job: string, fn: () => unknown): { ok: boolean; error?: { code: string; message: string } } {
  try {
    fn();
    return { ok: true };
  } catch (e) {
    const error = describeError(e);
    try {
      ctx.audit.append({
        actor: { kind: 'system', id: 'planificateur' }, action: 'system.job.failed', resourceType: 'scheduled_job', resourceId: job, outcome: 'FAILURE',
        details: { job, ...error },
      });
      ctx.alerts.raiseOnce(`tache:${job}:${kinshasaDate(ctx.clock.now())}`, {
        type: 'TACHE_PLANIFIEE_EN_ECHEC', severity: 'HIGH', source: `planificateur:${job}`,
        detail: `La tâche planifiée « ${job} » a échoué (${error.code}) : elle sera rejouée au prochain passage. Vérifier le journal d'audit.`,
        context: { job, code: error.code },
      });
    } catch {
      // Journal indisponible : rien de plus ne peut être fait ici ; le processus continue (le gestionnaire
      // de processus consigne les erreurs non gérées sur la sortie d'erreur).
    }
    return { ok: false, error };
  }
}
