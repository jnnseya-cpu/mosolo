import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { AI_CONTEXTS } from './provider.js';

const insightSchema = z.object({ context: z.enum(AI_CONTEXTS as [string, ...string[]]), subjectId: z.string().optional() }).strict();
const decideSchema = z.object({ decision: z.enum(['ACCEPTEE', 'REJETEE', 'MODIFIEE']), reason: z.string().trim().min(3).max(1000) }).strict();

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/ai/insights', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(insightSchema, req.body);
    return reply.code(201).send(ctx.ai.generate(user, body.context as (typeof AI_CONTEXTS)[number], body.subjectId));
  });

  app.get<{ Querystring: { status?: string; context?: string } }>('/v1/ai/recommendations', async (req) => {
    const user = requireUser(req);
    return ctx.ai.list(user, { ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.context ? { context: req.query.context } : {}) });
  });

  app.post<{ Params: { id: string } }>('/v1/ai/recommendations/:id/decide', async (req) => {
    const user = requireUser(req);
    const body = parse(decideSchema, req.body);
    return ctx.ai.decide(user, req.params.id, body.decision, body.reason);
  });
}
