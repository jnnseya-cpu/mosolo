import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { currencySchema, header, parse } from '../../core/http.js';
import { orderView, PAYMENT_CHANNELS } from './service.js';

// `.strict()` : le client ne peut fournir ni montant ni compte bénéficiaire.
const orderSchema = z.object({
  channel: z.enum(PAYMENT_CHANNELS),
  displayCurrency: currencySchema.optional(),
}).strict();

export function registerPaymentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { id: string } }>('/v1/obligations/:id/payment-orders', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(orderSchema, req.body);
    const res = ctx.idempotency.execute(`payment-order:${user.id}`, key, { obligationId: req.params.id, body }, () => ({
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
}
