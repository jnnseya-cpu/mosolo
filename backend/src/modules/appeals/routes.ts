import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { moneySchema, parse } from '../../core/http.js';
import { authorize, evaluate } from '../../core/policy.js';
import { forbidden } from '../../core/errors.js';

const decisionEnum = z.enum(['ACCEPTEE', 'PARTIELLEMENT_ACCEPTEE', 'REJETEE']);
const submitSchema = z.object({ obligationId: z.string(), grounds: z.string().trim().min(5).max(5000), requestedAmount: moneySchema.optional() }).strict();
const instructSchema = z.object({ proposal: decisionEnum, analysis: z.string().trim().min(5).max(5000), proposedAmount: moneySchema.optional() }).strict();
const decideSchema = z.object({ decision: decisionEnum, reason: z.string().trim().min(5).max(5000), rectifiedAmount: moneySchema.optional() }).strict();

export function registerAppealRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/appeals', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(ctx.appeals.submit(user, parse(submitSchema, req.body)));
  });

  app.get<{ Params: { id: string } }>('/v1/appeals/:id', async (req) => {
    const user = requireUser(req);
    const a = ctx.appeals.get(req.params.id);
    const allowed =
      evaluate(user, 'appeal.submit', { taxpayerId: a.taxpayerId }) || evaluate(user, 'appeal.instruct') || evaluate(user, 'appeal.decide') || evaluate(user, 'audit.read');
    if (!allowed) throw forbidden('FORBIDDEN', 'Accès au dossier de réclamation refusé.');
    return a;
  });

  app.post<{ Params: { id: string } }>('/v1/appeals/:id/instruct', async (req) => {
    const user = requireUser(req);
    authorize(user, 'appeal.instruct');
    return ctx.appeals.instruct(user, req.params.id, parse(instructSchema, req.body));
  });

  app.post<{ Params: { id: string } }>('/v1/appeals/:id/decide', async (req) => {
    const user = requireUser(req);
    return ctx.appeals.decide(user, req.params.id, parse(decideSchema, req.body));
  });
}
