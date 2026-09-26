import { RESIDENTIAL_SITUATIONS, LANGUAGE_CODES } from '@mosolo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { obligationSummary } from '../assessment/views.js';
import { maskPhone } from './service.js';

const registrationSchema = z.object({
  phone: z.string().regex(/^\+?[0-9 -]{9,20}$/, 'numéro de téléphone invalide'),
  fullName: z.string().trim().min(2).max(120),
  language: z.enum(LANGUAGE_CODES as [string, ...string[]]),
  situation: z.enum(RESIDENTIAL_SITUATIONS),
  email: z.string().email().optional(),
}).strict();

export function registerIdentityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/registrations', async (req, reply) => {
    const body = parse(registrationSchema, req.body);
    const tp = ctx.taxpayers.register(body as Parameters<typeof ctx.taxpayers.register>[0]);
    return reply.code(201).send({ taxpayerId: tp.id, iuc: tp.iuc, verificationLevel: tp.verificationLevel });
  });

  app.get<{ Params: { id: string } }>('/v1/taxpayers/:id', async (req) => {
    const user = requireUser(req);
    const tp = ctx.taxpayers.get(req.params.id);
    const objects = ctx.objects.byTaxpayer(tp.id);
    const obligations = ctx.assessment.byTaxpayer(tp.id);
    const access = authorize(user, 'taxpayer.read', {
      taxpayerId: tp.id,
      entities: [...new Set(['DGIPK', ...obligations.map((o) => o.entity)])],
      communes: objects.map((o) => o.commune),
    });
    const isSelf = user.taxpayerId === tp.id;
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'taxpayer.viewed', resourceType: 'taxpayer', resourceId: tp.id, details: { access } });
    const profile = {
      id: tp.id, iuc: tp.iuc, fullName: tp.fullName, phone: isSelf ? tp.phone : maskPhone(tp.phone), language: tp.language,
      situation: tp.situation, verificationLevel: tp.verificationLevel, createdAt: tp.createdAt,
    };
    if (access === 'minimal') {
      return { access, taxpayer: profile, objects, leases: null, obligations: obligations.map((o) => obligationSummary(o, 'minimal')), receipts: null, masked: true };
    }
    return {
      access,
      taxpayer: profile,
      objects,
      leases: ctx.objects.leasesOf(tp.id),
      obligations: obligations.map((o) => obligationSummary(o, 'full')),
      paymentOrders: obligations.flatMap((o) => ctx.payments.byObligation(o.id)).map((p) => ({
        paymentOrderId: p.id, paymentReference: p.paymentReference, obligationId: p.obligationId, status: p.status, amount: p.amount, createdAt: p.createdAt, expiresAt: p.expiresAt,
      })),
      receipts: ctx.receipts.byTaxpayer(tp.id),
      ...(isSelf ? { inbox: ctx.comms.inApp.inbox(tp.id) } : {}),
    };
  });
}
