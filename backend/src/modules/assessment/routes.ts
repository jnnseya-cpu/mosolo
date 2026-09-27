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
  // Entrées de la formule uniquement (identifiants du langage de règles) ; les taux viennent de la table certifiée :
  // toute entrée non requise par la règle est refusée par le moteur (400 INPUT_NOT_ALLOWED).
  inputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Identifiant d’entrée invalide'), decimalString)
    .refine((o) => Object.keys(o).length <= 50, 'Au plus 50 entrées').default({}),
  simulate: z.boolean(),
  /** Dérogation approuvée (base inférieure aux données connues de l'objet au-delà de la tolérance). */
  baseOverrideId: z.string().min(1).optional(),
}).strict();

const baseOverrideSchema = z.object({
  ruleId: z.string(),
  taxpayerId: z.string(),
  objectId: z.string(),
  inputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Identifiant d’entrée invalide'), decimalString).default({}),
  motive: z.string().trim().min(10).max(2000),
}).strict();
const baseOverrideDecisionSchema = z.object({ approve: z.boolean(), reason: z.string().trim().min(10).max(2000) }).strict();

export function registerAssessmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/assessments/calculate', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(calculateSchema, req.body);
    const res = ctx.assessment.calculate(user, body);
    return reply.code(res.obligation ? 201 : 200).send({ trace: res.trace, obligation: res.obligation ? obligationDetail(res.obligation) : null });
  });

  // Dérogation à la base connue de l'objet : demande motivée (liquidateur) puis seconde approbation (hiérarchie).
  app.post('/v1/assessments/base-overrides', async (req, reply) => {
    return reply.code(201).send(ctx.assessment.requestBaseOverride(requireUser(req), parse(baseOverrideSchema, req.body)));
  });

  app.get('/v1/assessments/base-overrides', async (req) => {
    const user = requireUser(req);
    if (!evaluate(user, 'assessment.liquidate') && !evaluate(user, 'assessment:base-override.approve') && !evaluate(user, 'audit.read')) {
      throw forbidden('FORBIDDEN', 'Consultation des dérogations réservée à la liquidation, à la hiérarchie et à l’audit.');
    }
    return ctx.assessment.baseOverrides.all();
  });

  app.post<{ Params: { id: string } }>('/v1/assessments/base-overrides/:id/decision', async (req) => {
    return ctx.assessment.decideBaseOverride(requireUser(req), req.params.id, parse(baseOverrideDecisionSchema, req.body));
  });

  app.get<{ Querystring: { taxpayerId?: string; objectId?: string } }>('/v1/obligations', async (req) => {
    const user = requireUser(req);
    if (!hasAnyGrant(user, 'obligation.read')) {
      throw forbidden('FORBIDDEN', 'Ce rôle ne peut consulter que des agrégats, jamais des obligations nominatives.');
    }
    const taxpayerId = req.query.taxpayerId ?? (user.roles.includes('R30') ? user.taxpayerId : undefined);
    let candidates = taxpayerId ? ctx.assessment.byTaxpayer(taxpayerId) : ctx.assessment.obligations.all();
    // Filtre facultatif par objet (catalogue des API : GET /v1/objets/:id/obligations) : refus explicite sans droit sur l'objet.
    if (req.query.objectId !== undefined) {
      const obj = ctx.objects.get(req.query.objectId);
      const ofObject = ctx.assessment.obligations.find((o) => o.objectId === obj.id);
      authorize(user, 'obligation.read', { taxpayerId: obj.taxpayerId, entities: [...new Set(['DGIPK', ...ofObject.map((o) => o.entity)])], communes: [obj.commune] });
      candidates = candidates.filter((o) => o.objectId === obj.id);
    }
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
      paymentOrders: ctx.payments.byObligation(o.id).map((p) => ({ paymentOrderId: p.id, paymentReference: p.paymentReference, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt })),
      receipts: ctx.payments.byObligation(o.id).flatMap((p) => {
        const r = ctx.receipts.byPaymentOrder(p.id);
        return r ? [{ number: r.number, code: r.code, status: r.status }] : [];
      }),
    };
  });
}
