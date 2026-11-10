/**
 * Routes de l'exécution automatique AVIA après arrêté (modules 62 et 78) : état, passage manuel (même chemin que le
 * planificateur mensuel), exécutions par compagnie, observations de la compagnie après l'avis (procédure contradictoire).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import type { AviaAutoService } from './avia-auto.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'empreinte SHA-256 hexadécimale attendue');

export function registerAviaAutoRoutes(app: FastifyInstance, auto: AviaAutoService): void {
  app.get('/v1/verticales/avia/auto', async (req) => auto.overview(requireUser(req)));
  app.post('/v1/verticales/avia/auto/run', async (req, reply) => {
    const body = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).strict(), req.body ?? {});
    return reply.code(201).send(auto.runMonth(requireUser(req), body));
  });
  app.get('/v1/verticales/avia/auto/executions', async (req) => ({ items: auto.list(requireUser(req)) }));
  app.get<{ Params: { id: string } }>('/v1/verticales/avia/auto/executions/:id', async (req) => auto.read(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/verticales/avia/auto/executions/:id/observations', async (req, reply) => {
    const body = parse(z.object({ text: z.string().trim().min(10).max(3000), documents: z.array(sha256).max(20) }).strict(), req.body);
    return reply.code(201).send(auto.observe(requireUser(req), req.params.id, body));
  });
}

/**
 * Planificateur mensuel AVIA : actif par défaut (vérification horaire), désactivé sous les tests (VITEST) ;
 * MOSOLO_AVIA_AUTO_SCHEDULER=off le désactive, =on le force.
 */
export function aviaAutoSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.MOSOLO_AVIA_AUTO_SCHEDULER ?? '').trim().toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return !env.VITEST;
}
