import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { currencySchema, header, parse } from '../../core/http.js';
import { CONNECTOR_IDS } from './connectors/types.js';
import { authorize } from '../../core/policy.js';
import { isDemoMode } from '../../core/auth.js';
import { ApiError, conflict, notFound } from '../../core/errors.js';
import { INBOUND_WEBHOOKS } from '../integrations/inventory.js';
import { signBitriPayWebhook, BITRIPAY_DEMO_WEBHOOK_SECRET } from './connectors/bitripay.js';
import { signKodaWebhook, KODA_DEMO_WEBHOOK_SECRET } from './connectors/koda.js';
import { toMinorUnits } from './connectors/minor-units.js';
import { randomUUID } from 'node:crypto';
import { orderView, PAYMENT_CHANNELS } from './service.js';
import { buildReadiness } from './readiness.js';

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
    // Dernière réception (console « Clés et raccordements ») : prestataires connus seulement, jamais le corps.
    const inboundId = `callback:${req.params.provider}`;
    const known = INBOUND_WEBHOOKS.some((w) => w.id === inboundId);
    try {
      const res = ctx.payments.handleCallback(
        req.params.provider,
        { signature: header(req, 'x-signature'), nonce: header(req, 'x-nonce'), timestamp: header(req, 'x-timestamp'), keyId: header(req, 'x-key-id') },
        req.rawBody ?? '',
      );
      if (known) ctx.integrations.recordInbound(inboundId, 'VALIDE');
      return reply.code(200).send(res);
    } catch (e) {
      if (known) ctx.integrations.recordInbound(inboundId, 'REFUSEE', e instanceof ApiError ? e.code : 'ERREUR');
      throw e;
    }
  });

  // Webhooks serveur à serveur des prestataires connectés : corps BRUT vérifié avant toute interprétation.
  for (const provider of CONNECTOR_IDS) {
    app.post(`/v1/providers/${provider}/webhooks`, async (req, reply) => {
      // Signature vérifiée sur le corps BRUT, puis confirmation serveur à serveur avant toute quittance.
      const res = await ctx.payments.receiveConnectorWebhook(provider, req.headers, req.rawBody ?? '');
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

  // Console des prestataires connectés (BitriPay, KODA) : configuration masquée, webhooks, annonces de règlement, attentes.
  app.get('/v1/providers/connectors', async (req) => {
    const user = requireUser(req);
    authorize(user, 'provider.read');
    const p = ctx.payments;
    const events = p.webhookEvents.all().slice(-40).reverse().map((e) => ({
      provider: e.provider, eventId: e.eventId, receivedAt: e.receivedAt, eventType: e.result.eventType, outcome: e.result.outcome,
      status: e.result.status ?? null, paymentReference: e.result.paymentReference ?? null, receiptStatus: e.result.receiptStatus ?? null, reason: e.result.reason ?? null,
    }));
    const orders = p.orders.find((o) => !!o.provider);
    const stats = ctx.connectors.list().map((c) => ({
      id: c.id,
      orders: orders.filter((o) => o.provider === c.id).length,
      confirmed: orders.filter((o) => o.provider === c.id && ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(o.status)).length,
      reconciled: orders.filter((o) => o.provider === c.id && o.status === 'RAPPROCHE').length,
      webhooks: p.webhookEvents.find((e) => e.provider === c.id).length,
    }));
    return {
      connectors: ctx.connectors.describe(), stats, events,
      settlementAnnouncements: p.settlementAnnouncements.all().slice(-20).reverse(),
      holds: p.unresolvedHolds(),
      recentOrders: orders.slice(-15).reverse().map((o) => ({ paymentReference: o.paymentReference, provider: o.provider, status: o.status, amount: o.amount, providerIntentId: o.providerIntentId, sandbox: o.providerSandbox ?? null, createdAt: o.createdAt })),
      doctrine: [
        'Aucune quittance sur capture d’écran ou SMS : seule la confirmation signée serveur à serveur fait foi.',
        'Une annonce de règlement du prestataire n’est jamais un règlement : seul le relevé du compte public fait passer à « rapproché ».',
        'Le prestataire règle au compte public du coffre ; aucun frais n’est prélevé sur la recette.',
      ],
    };
  });

  // « Prestataires de paiement — état de raccordement » (R17, R26, R28) : noms de variables et présence, jamais de valeur.
  app.get('/v1/providers/readiness', async (req) => {
    const user = requireUser(req);
    authorize(user, 'provider.readiness');
    return buildReadiness(ctx);
  });

  // « Tester la connexion » : appel réel inoffensif documenté, sinon validation à blanc (le résultat dit lequel).
  app.post<{ Params: { provider: string } }>('/v1/providers/:provider/test-connection', async (req) => {
    const user = requireUser(req);
    return ctx.payments.testProviderConnection(user, req.params.provider);
  });

  // Démonstration : simule l'envoi, par le prestataire, d'un webhook SIGNÉ (secret de démonstration) vers la route réelle.
  // Refusé hors bac à sable local et hors mode démonstration : en production, seul le prestataire peut confirmer.
  const simSchema = z.object({ paymentReference: z.string().min(3).max(64), event: z.enum(['succeeded', 'settled', 'ambiguous', 'canceled']) }).strict();
  app.post<{ Params: { provider: string } }>('/v1/providers/:provider/sandbox-simulate', async (req) => {
    const user = requireUser(req);
    authorize(user, 'provider.simulate');
    const connector = ctx.connectors.get(req.params.provider);
    if (!connector) throw notFound('UNKNOWN_PROVIDER', `Prestataire non connecté : ${req.params.provider}`);
    if (connector.mode !== 'SANDBOX_LOCAL' || !isDemoMode()) throw conflict('SIMULATION_FORBIDDEN', 'Simulation réservée au bac à sable local en mode démonstration.');
    const body = parse(simSchema, req.body);
    const order = ctx.payments.byReference(body.paymentReference);
    if (!order || order.provider !== connector.id || !order.providerIntentId) throw notFound('PAYMENT_REFERENCE_NOT_FOUND', 'Référence inconnue pour ce prestataire.');
    const minor = Number(toMinorUnits(order.amount, connector.exponents));
    let raw: string; let headers: Record<string, string>;
    if (connector.id === 'koda') {
      if (body.event !== 'succeeded') throw conflict('EVENT_NOT_SUPPORTED', 'KODA n’émet que payment.verified (paiement vérifié).');
      raw = JSON.stringify({ id: `evt_sim_${randomUUID()}`, type: 'payment.verified', data: { intent_id: order.providerIntentId, amount: minor, currency: order.amount.currency, receipt_id: `KR-SIM-${order.paymentReference}`, metadata: { payment_reference: order.paymentReference } } });
      headers = { 'x-koda-signature': signKodaWebhook(KODA_DEMO_WEBHOOK_SECRET, raw) };
    } else {
      const type = { succeeded: 'payment_intent.succeeded', settled: 'payment_intent.settled', ambiguous: 'payment_intent.ambiguous_hold', canceled: 'payment_intent.canceled' }[body.event];
      const t = Math.floor(ctx.clock.now().getTime() / 1000);
      raw = JSON.stringify({ id: `evt_sim_${randomUUID()}`, type, created: t, data: { object: { id: order.providerIntentId, amount_minor: minor, currency: order.amount.currency.toLowerCase(), metadata: { payment_reference: order.paymentReference }, ...(body.event === 'settled' ? { settlement_id: `st_sim_${order.paymentReference}` } : {}) } } });
      headers = { 'bitripay-signature': signBitriPayWebhook(BITRIPAY_DEMO_WEBHOOK_SECRET, raw, t) };
    }
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'provider.sandbox.simulated', resourceType: 'payment_order', resourceId: order.id, details: { provider: connector.id, event: body.event } });
    return { simulated: true, sandbox: true, ...ctx.payments.handleConnectorWebhook(connector.id, headers, raw) };
  });

  // Démonstration (30/09/2026) : confirmation SIGNÉE d'un opérateur DIRECT (monnaie mobile, QR, USSD sans passerelle),
  // envoyée à la route réelle des rappels. Refusée hors mode démonstration ou avec un vrai secret d'opérateur.
  app.post<{ Params: { provider: string } }>('/v1/providers/:provider/demo-operator-confirmation', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'provider.simulate');
    if (!isDemoMode()) throw conflict('SIMULATION_FORBIDDEN', 'Simulation réservée au mode démonstration.');
    const body = parse(z.object({ paymentReference: z.string().min(3).max(64) }).strict(), req.body);
    const { raw, headers } = ctx.payments.demoOperatorCallback(req.params.provider, body.paymentReference);
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'provider.demo_operator.simulated', resourceType: 'payment_reference', resourceId: body.paymentReference, details: { provider: req.params.provider } });
    const res = await app.inject({ method: 'POST', url: `/v1/providers/${encodeURIComponent(req.params.provider)}/callbacks`, headers: { 'content-type': 'application/json', 'x-signature': headers.signature, 'x-nonce': headers.nonce, 'x-timestamp': headers.timestamp }, payload: raw });
    return reply.code(res.statusCode).send({ simulated: true, provider: req.params.provider, ...(res.json() as object) });
  });

  // Page de retour « /paiement/retour » (29/09/2026) : état RÉEL du paiement lu dans MOSOLO (jamais dans l'URL de retour).
  app.get<{ Params: { reference: string } }>('/v1/payment-orders/:reference/status', async (req, reply) => {
    const user = requireUser(req);
    reply.header('cache-control', 'no-store');
    return ctx.payments.paymentStatusFor(user, req.params.reference);
  });

  // « Ce paiement a-t-il eu lieu ? » auprès du prestataire : pièce de dossier (legalEffect AUCUN).
  app.post<{ Params: { reference: string } }>('/v1/payment-orders/:reference/provider-resolution', async (req, reply) => {
    const user = requireUser(req);
    const record = await ctx.payments.resolveWithProvider(user, req.params.reference);
    return reply.code(201).send(record);
  });
}
