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
  // Surcharge par entité (27/09/2026) : même circuit à deux personnes, entité visée et date d'effet.
  entity: z.string().min(2).max(40).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ attendue').optional(),
  removal: z.boolean().optional(),
}).strict();
const overrideBody = z.object({
  parameterId: z.string().trim().min(1).max(160),
  entity: z.string().min(2).max(40),
  value: z.union([z.number(), z.boolean()]).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ attendue').optional(),
  removal: z.boolean().optional(),
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

  // Variables par département (27/09/2026) : valeurs en vigueur et provenance ; surcharges par le circuit à deux personnes.
  app.get<{ Querystring: { entity?: string; modulables?: string } }>('/v1/parametres/effectifs', async (req) => {
    const q = parse(z.object({ entity: z.string().min(2).max(40), modulables: z.enum(['0', '1', 'true', 'false']).optional() }).strict(), req.query);
    return svc.effectifs(requireUser(req), q.entity, { modulablesOnly: q.modulables === '1' || q.modulables === 'true' });
  });
  app.get<{ Querystring: { entity?: string } }>('/v1/parametres/surcharges', async (req) => {
    const q = parse(z.object({ entity: z.string().min(2).max(40).optional() }).strict(), req.query);
    return svc.overridesFor(requireUser(req), q.entity);
  });
  app.post('/v1/parametres/surcharges', async (req, reply) => {
    const b = parse(overrideBody, req.body);
    return reply.code(201).send(svc.proposeChange(requireUser(req), {
      parameterId: b.parameterId, kind: 'MODIFICATION', entity: b.entity, motif: b.motif,
      ...(b.value !== undefined ? { proposedValue: b.value } : {}), ...(b.effectiveFrom ? { effectiveFrom: b.effectiveFrom } : {}),
      ...(b.removal ? { removal: true } : {}), ...(b.acte ? { acte: b.acte } : {}),
    }));
  });

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
