import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { currencySchema, header, parse } from '../../core/http.js';
import { CONNECTOR_IDS } from './connectors/types.js';
import { orderView, PAYMENT_CHANNELS } from './service.js';

// `.strict()` : le client ne peut fournir ni montant ni compte bénéficiaire.
const orderSchema = z.object({
  channel: z.enum(PAYMENT_CHANNELS),
  displayCurrency: currencySchema.optional(),
  /** Prestataire connecté (canaux MOBILE_MONEY et QR uniquement). */
  provider: z.enum(CONNECTOR_IDS).optional(),
  /** Échéancier accordé : l'ordre porte le montant de la prochaine échéance (lu dans le plan, jamais saisi). */
  installmentPlanId: z.string().min(1).max(64).optional(),
}).strict();

// Aucune image n'est reçue : seule l'empreinte de la capture et/ou le code SMS présenté.
const evidenceSchema = z.object({
  caseRef: z.string().min(3).max(64),
  smsCode: z.string().min(1).max(64).optional(),
  screenshotSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().refine((b) => b.smsCode || b.screenshotSha256, { message: 'smsCode ou screenshotSha256 requis' });

export function registerPaymentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { id: string } }>('/v1/obligations/:id/payment-orders', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(orderSchema, req.body);
    const res = body.provider
      ? await ctx.idempotency.executeAsync(`payment-order:${user.id}`, key, { obligationId: req.params.id, body }, async () => ({
          statusCode: 201,
          body: orderView(await ctx.payments.createOrderWithProvider(user, req.params.id, body)),
        }))
      : ctx.idempotency.execute(`payment-order:${user.id}`, key, { obligationId: req.params.id, body }, () => ({
          statusCode: 201,
          body: orderView(ctx.payments.createOrder(user, req.params.id, body)),
        }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });

  app.post<{ Params: { provider: string } }>('/v1/providers/:provider/callbacks', async (req, reply) => {
    const res = ctx.payments.handleCallback(
      req.params.provider,
      { signature: header(req, 'x-signature'), nonce: header(req, 'x-nonce'), timestamp: header(req, 'x-timestamp') },
      req.rawBody ?? '',
    );
    return reply.code(200).send(res);
  });

  // Webhooks serveur à serveur des prestataires connectés : corps BRUT vérifié avant toute interprétation.
  for (const provider of CONNECTOR_IDS) {
    app.post(`/v1/providers/${provider}/webhooks`, async (req, reply) => {
      const res = ctx.payments.handleConnectorWebhook(provider, req.headers, req.rawBody ?? '');
      return reply.code(200).send(res);
    });
  }

  // Pièce de dossier (R17, R18, R20) : n'émet jamais de quittance, ne change jamais l'état du paiement.
  app.post<{ Params: { reference: string } }>('/v1/payment-orders/:reference/provider-verification-evidence', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(evidenceSchema, req.body);
    const record = await ctx.payments.requestVerificationEvidence(user, { paymentReference: req.params.reference, ...body });
    return reply.code(201).send(record);
  });

  // « Ce paiement a-t-il eu lieu ? » auprès du prestataire : pièce de dossier (legalEffect AUCUN).
  app.post<{ Params: { reference: string } }>('/v1/payment-orders/:reference/provider-resolution', async (req, reply) => {
    const user = requireUser(req);
    const record = await ctx.payments.resolveWithProvider(user, req.params.reference);
    return reply.code(201).send(record);
  });
}
