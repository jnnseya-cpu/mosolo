import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { decimalString, parse } from '../../core/http.js';
import { authorize, evaluate, hasAnyGrant } from '../../core/policy.js';
import { obligationDetail, obligationSummary } from './views.js';

const calculateSchema = z.object({
  ruleId: z.string(),
  taxpayerId: z.string(),
  objectId: z.string(),
  inputs: z.record(decimalString).default({}),
  simulate: z.boolean(),
}).strict();

export function registerAssessmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/assessments/calculate', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(calculateSchema, req.body);
    const res = ctx.assessment.calculate(user, body);
    return reply.code(res.obligation ? 201 : 200).send({ trace: res.trace, obligation: res.obligation ? obligationDetail(res.obligation) : null });
  });

  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/obligations', async (req) => {
    const user = requireUser(req);
    if (!hasAnyGrant(user, 'obligation.read')) {
      throw forbidden('FORBIDDEN', 'Ce rôle ne peut consulter que des agrégats, jamais des obligations nominatives.');
    }
    const taxpayerId = req.query.taxpayerId ?? (user.roles.includes('R30') ? user.taxpayerId : undefined);
    const candidates = taxpayerId ? ctx.assessment.byTaxpayer(taxpayerId) : ctx.assessment.obligations.all();
    if (taxpayerId) {
      // Refus explicite si le demandeur n'a aucun droit sur ce contribuable.
      const objs = ctx.objects.byTaxpayer(taxpayerId);
      authorize(user, 'obligation.read', { taxpayerId, entities: [...new Set(['DGIPK', ...candidates.map((o) => o.entity)])], communes: objs.map((o) => o.commune) });
    }
    return candidates.flatMap((o) => {
      const obj = ctx.objects.objects.get(o.objectId);
      const access = evaluate(user, 'obligation.read', { taxpayerId: o.taxpayerId, entity: o.entity, communes: obj ? [obj.commune] : [] });
      return access ? [obligationSummary(o, access)] : [];
    });
  });

  app.get<{ Params: { id: string } }>('/v1/obligations/:id', async (req) => {
    const user = requireUser(req);
    const o = ctx.assessment.get(req.params.id);
    const obj = ctx.objects.objects.get(o.objectId);
    const access = authorize(user, 'obligation.read', { taxpayerId: o.taxpayerId, entity: o.entity, communes: obj ? [obj.commune] : [] });
    if (access === 'minimal') return obligationSummary(o, 'minimal');
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'obligation.viewed', resourceType: 'obligation', resourceId: o.id });
    return {
      ...obligationDetail(o),
      paymentOrders: ctx.payments.byObligation(o.id).map((p) => ({ paymentOrderId: p.id, paymentReference: p.paymentReference, status: p.status, expiresAt: p.expiresAt })),
      receipts: ctx.payments.byObligation(o.id).flatMap((p) => {
        const r = ctx.receipts.byPaymentOrder(p.id);
        return r ? [{ number: r.number, code: r.code, status: r.status }] : [];
      }),
    };
  });
}
