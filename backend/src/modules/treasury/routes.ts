import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, requireAcr, ACR } from '../../core/auth.js';
import { ApiError } from '../../core/errors.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';

const statementSchema = z.object({
  statementId: z.string().min(1).max(100),
  lines: z.array(z.object({
    accountAlias: z.string().min(1),
    amount: moneySchema,
    valueDate: isoDateString,
    paymentReference: z.string().min(1),
  }).strict()).min(1).max(5000),
}).strict();

const reversalSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export function registerTreasuryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/settlements/statements', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'settlement.import');
    const body = parse(statementSchema, req.body);
    const { replayed, result } = ctx.treasury.importStatement(user, body);
    return reply.code(replayed ? 200 : 201).send(result);
  });

  app.get('/v1/reconciliation/exceptions', async (req) => ctx.treasury.listExceptions(requireUser(req)));

  app.get<{ Querystring: { sourceId?: string } }>('/v1/ledger/entries', async (req) => {
    authorize(requireUser(req), 'ledger.read');
    return ctx.ledger.list(req.query.sourceId ? { sourceId: req.query.sourceId } : {});
  });

  app.get('/v1/ledger/balance', async (req) => {
    authorize(requireUser(req), 'ledger.read');
    return ctx.ledger.balance();
  });

  // Correction : uniquement par contre-écriture liée à l'original.
  app.post<{ Params: { id: string } }>('/v1/ledger/entries/:id/reversals', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'ledger.reverse');
    requireAcr(user, ACR.MFA); // DG-09
    const { reason } = parse(reversalSchema, req.body);
    return reply.code(201).send(ctx.ledger.reverse(req.params.id, reason, { kind: 'user', id: user.id, roles: user.roles }));
  });

  // Grand livre en ajout seul : aucune modification ni suppression, quel que soit le rôle.
  for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
    app.route<{ Params: { id: string } }>({
      method,
      url: '/v1/ledger/entries/:id',
      handler: async (req) => {
        ctx.audit.append({
          actor: { kind: req.user ? 'user' : 'public', id: req.user?.id ?? 'anonyme', ...(req.user ? { roles: req.user.roles } : {}) },
          action: 'ledger.tamper.attempt', resourceType: 'ledger_entry', resourceId: req.params.id, outcome: 'DENIED', details: { method },
        });
        throw new ApiError(405, 'LEDGER_APPEND_ONLY', 'Grand livre en ajout seul : aucune écriture ne peut être modifiée ou supprimée ; utiliser une contre-écriture.');
      },
    });
  }
}
