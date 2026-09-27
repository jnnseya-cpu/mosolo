/** Routes des risques résiduels : collusion, registre des seuils anti-fraude, santé des clés ; garde de rotation. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../../core/auth.js';
import { parse } from '../../../core/http.js';
import { CIRCUITS } from './circuits.js';
import type { GouvernanceService } from './service.js';

const motif = z.string().trim().min(10).max(2000);
const changeBody = z.object({
  parameterId: z.string().trim().min(1).max(120),
  kind: z.enum(['CONFIRMATION', 'MODIFICATION']),
  proposedValue: z.union([z.number(), z.boolean()]).optional(),
  acte: z.string().trim().min(3).max(300).optional(),
  motif,
}).strict();
const decisionBody = z.object({ approve: z.boolean(), motif }).strict();

export function registerGouvernanceRoutes(app: FastifyInstance, svc: GouvernanceService): void {
  app.get('/v1/integrite/collusion', async (req) => svc.collusion(requireUser(req)));
  app.post('/v1/integrite/collusion/run', async (req) => svc.runCollusion(requireUser(req)));

  app.get('/v1/integrite/thresholds', async (req) => svc.register(requireUser(req)));
  app.post('/v1/integrite/thresholds/change-requests', async (req, reply) => reply.code(201).send(svc.proposeChange(requireUser(req), parse(changeBody, req.body))));
  app.post<{ Params: { id: string } }>('/v1/integrite/thresholds/change-requests/:id/decision', async (req) => svc.decideChange(requireUser(req), req.params.id, parse(decisionBody, req.body)));

  app.get('/v1/integrite/key-health', async (req) => svc.keys(requireUser(req)));

  // Garde de rotation : avant la décision d'un circuit à quatre yeux (s'applique aux routes déclarées avant comme après).
  const guards = new Map(CIRCUITS.filter((c) => c.guard).map((c) => [c.guard!.url, c]));
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'POST' || !req.user) return;
    const c = guards.get(req.routeOptions.url ?? '');
    if (!c?.guard) return;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (c.guard.refusal?.(body)) return;
    svc.rotationGuard(req.user, c.code, c.guard.key(req.params as Record<string, string>));
  });
}
