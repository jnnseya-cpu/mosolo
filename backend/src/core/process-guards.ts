/**
 * Gardes du processus (deuxième passe adverse, 27/09/2026) — installées par les points d'entrée du serveur.
 *
 * - Rejet de promesse non géré : sous Node 22, il arrête le processus par défaut, ce qui perdrait les écritures en
 *   attente d'un stockage persistant. Il est journalisé, signalé à l'exploitant (alerte unique par jour) et le
 *   processus continue : l'opération fautive a déjà répondu (ou répondra) par sa propre erreur.
 * - Exception non capturée : l'état en mémoire n'est plus garanti. Elle est journalisée, les écritures en attente sont
 *   vidées (arrêt propre), puis le processus s'arrête avec le code 1 pour être relancé par l'hébergeur.
 */
import type { JobContext } from './jobs.js';
import { describeError } from './jobs.js';
import { kinshasaDate } from './clock.js';

export interface ProcessLike {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (e: unknown) => void): unknown;
}

export interface ProcessGuardDeps {
  ctx: JobContext;
  log: (message: string) => void;
  exit: (code: number) => void;
  /** Arrêt propre : fermeture de l'application et vidage des écritures persistantes en attente. */
  shutdown: () => Promise<void>;
}

export function installProcessGuards(proc: ProcessLike, deps: ProcessGuardDeps): void {
  proc.on('unhandledRejection', (reason) => {
    const error = describeError(reason);
    deps.log(`Rejet de promesse non géré (${error.code}) : ${error.message}`);
    try {
      deps.ctx.alerts.raiseOnce(`rejet-non-gere:${error.code}:${kinshasaDate(deps.ctx.clock.now())}`, {
        type: 'REJET_NON_GERE', severity: 'HIGH', source: 'processus',
        detail: `Rejet de promesse non géré (${error.code}) : le processus continue. Examiner le journal du serveur.`,
        context: { code: error.code },
      });
    } catch {
      // Alerte impossible : la ligne de journal ci-dessus reste la trace.
    }
  });
  let stopping = false;
  proc.on('uncaughtException', (err) => {
    const error = describeError(err);
    deps.log(`Exception non capturée (${error.code}) : ${error.message} — arrêt propre du processus.`);
    if (stopping) return;
    stopping = true;
    void deps.shutdown().catch(() => undefined).finally(() => deps.exit(1));
  });
}
