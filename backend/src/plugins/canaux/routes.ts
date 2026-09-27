/** Routes HTTP du module « canaux » (§ H.16 : enrôlement assisté, cartes, points agréés, vérification, USSD/SVI). */
import { assistOrderSchema } from './assisted.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { ApiError } from '../../core/errors.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { header, isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { formatCardNumber } from './cards.js';
import { PICTOGRAMS, POINT_TYPES } from './model.js';
import type { CanauxService } from './service.js';

const startSchema = z.object({ msisdn: z.string().regex(/^\+?\d{9,15}$/, 'numéro appelant attendu'), lang: z.string().max(5).optional() }).strict();
const inputSchema = z.object({ input: z.string().max(40) }).strict();
const motifSchema = z.object({ motif: z.string().trim().min(10, 'motif d’au moins 10 caractères').max(500) }).strict();
const suspendSchema = z.object({ motif: z.string().trim().min(10, 'motif d’au moins 10 caractères').max(500), proposalId: z.string().optional() }).strict();
const reviewSchema = z.object({ decision: z.enum(['DISTINCT', 'DOUBLON']), motif: z.string().trim().min(10).max(500) }).strict();
const blockSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
const pinSchema = z.object({ pin: z.string().regex(/^\d{4}$/, '4 chiffres') }).strict();
// `.strict()` : le point de paiement ne transmet QUE la référence — jamais un montant (§ 18A.3).
const collectSchema = z.object({ paymentReference: z.string().min(8).max(20) }).strict();
const cardRefSchema = z.object({ cardNumber: z.string().min(12).max(20), obligationId: z.string().min(1) }).strict();
const closeSchema = z.object({ counted: z.array(moneySchema).max(10) }).strict();
const depositSchema = z.object({
  bankSlipRef: z.string().trim().min(3).max(60),
  depositedAt: z.string().datetime({ offset: true }),
  lines: z.array(z.object({ accountAlias: z.string().min(3).max(60), amount: moneySchema }).strict()).min(1).max(10),
}).strict();
const bankMatchSchema = z.object({ statementId: z.string().min(1).max(100) }).strict();
const pointSchema = z.object({
  name: z.string().trim().min(3).max(120), type: z.enum(POINT_TYPES), operator: z.string().trim().min(2).max(120),
  approval: z.object({ authority: z.string().min(2).max(120), reference: z.string().min(3).max(60), grantedOn: isoDateString }).strict(),
  commune: z.string(), quartier: z.string().min(1).max(80), address: z.string().min(3).max(200),
  lat: z.number().min(-5).max(-3.5), lon: z.number().min(15).max(16.6), hours: z.string().min(3).max(80),
  limits: z.object({ perTransaction: z.array(moneySchema).min(1), perDay: z.array(moneySchema).min(1) }).strict(),
  settlementDelayHours: z.number().int().min(1).max(72), guichetId: z.string().optional(), operatorUserIds: z.array(z.string()).min(1).max(20),
}).strict();

/**
 * Clé du limiteur : adresse réseau vue par le serveur (`req.ip`, qui ne tient compte d'un mandataire que s'il est
 * déclaré de confiance). Jamais un en-tête X-Forwarded-For fourni par le client : il suffirait de le changer à
 * chaque requête pour contourner la limitation et énumérer les codes.
 */
function clientKey(req: FastifyRequest): string {
  return `ip:${req.ip || 'inconnu'}`;
}

export function registerCanauxRoutes(app: FastifyInstance, ctx: AppContext, svc: CanauxService): void {
  // ---------- USSD et SVI (passerelle opérateur ; ici en mode simulateur) ----------
  for (const [channel, base] of [['USSD', '/v1/ussd/sessions'], ['SVI', '/v1/ivr/sessions']] as const) {
    app.post(base, async (req, reply) => {
      const body = parse(startSchema, req.body);
      return reply.code(201).send(svc.engine.start(channel, body.msisdn, body.lang));
    });
    app.post<{ Params: { id: string } }>(`${base}/:id/input`, async (req) => {
      const body = parse(inputSchema, req.body);
      return svc.engine.input(channel, req.params.id, body.input);
    });
  }
  app.get('/v1/channel-sessions', async (req) => {
    const user = requireUser(req);
    authorize(user, 'canaux:sessions.read');
    return svc.engine.sessions.all().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100).map((s) => svc.engine.sessionView(s));
  });

  // ---------- Public : points, guichets, pictogrammes, vérifications ----------
  app.get<{ Querystring: { commune?: string } }>('/v1/public/payment-points', async (req) => ({
    points: svc.points.publicList(req.query.commune), guichets: svc.points.guichets.all(),
    notice: 'Seuls les points référencés et actifs peuvent encaisser et produire une preuve valable. Aucun agent public ne reçoit d’argent.',
  }));
  app.get('/v1/public/pictograms', async () => PICTOGRAMS);
  app.get<{ Params: { code: string } }>('/v1/public/short-codes/:code', async (req, reply) => {
    // Même garde anti-énumération que la vérification publique des quittances (volume et échecs par client).
    const gate = ctx.receipts.admit(clientKey(req));
    if (!gate.allowed) {
      void reply.header('retry-after', String(gate.retryAfter ?? 60));
      throw new ApiError(429, 'VERIFICATION_RATE_LIMITED', 'Trop de vérifications depuis ce poste : réessayez plus tard (protection contre l’énumération).', { retryAfter: gate.retryAfter });
    }
    return { ...svc.verify(req.params.code, clientKey(req), 'WEB'), verifiedAt: ctx.clock.now().toISOString() };
  });
  app.get<{ Querystring: { t?: string } }>('/v1/public/mosolo-cards/verify', async (req) => {
    svc.limiter.admit(clientKey(req), 'WEB-CARTE');
    const r = svc.cards.verifyToken(req.query.t ?? '');
    svc.limiter.record(clientKey(req), 'WEB-CARTE', req.query.t ?? '', 'CARTE', r.status, r.status === 'INVALIDE');
    return { ...r, verifiedAt: ctx.clock.now().toISOString() };
  });

  // ---------- Enrôlement assisté ----------
  // Lot signé : x-device-signature = HMAC-SHA256(clé du terminal enrôlé, corps brut).
  app.post('/v1/assisted-enrolments/batches', async (req) => {
    const user = requireUser(req);
    return svc.enrolment.syncBatch(user, req.rawBody ?? '', header(req, 'x-device-signature'));
  });
  app.get('/v1/assisted-enrolments', async (req) => svc.enrolment.list(requireUser(req)));
  app.get<{ Params: { id: string } }>('/v1/assisted-enrolments/:id', async (req) => {
    const user = requireUser(req);
    authorize(user, 'canaux:enrolment.read');
    return svc.enrolment.view(svc.enrolment.get(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/v1/assisted-enrolments/:id/review', async (req) => {
    const body = parse(reviewSchema, req.body);
    return svc.enrolment.review(requireUser(req), req.params.id, body.decision, body.motif);
  });
  app.get<{ Params: { taxpayerId: string } }>('/v1/pictogram-notices/:taxpayerId', async (req) => svc.notice(requireUser(req), req.params.taxpayerId));

  // ---------- Carte MOSOLO ----------
  app.get<{ Params: { number: string } }>('/v1/mosolo-cards/:number', async (req) => {
    const user = requireUser(req);
    const card = svc.cards.get(req.params.number);
    authorize(user, 'canaux:card.read', { taxpayerId: card.taxpayerId });
    return svc.cards.view(card);
  });
  app.post<{ Params: { number: string } }>('/v1/mosolo-cards/:number/block', async (req) => {
    const user = requireUser(req);
    const body = parse(blockSchema, req.body);
    const card = svc.cards.get(req.params.number);
    authorize(user, 'canaux:card.block', { taxpayerId: card.taxpayerId });
    return svc.cards.view(svc.cards.block({ kind: 'user', id: user.id, roles: user.roles }, card.number, body.reason));
  });
  app.post<{ Params: { number: string } }>('/v1/mosolo-cards/:number/pin', async (req) => {
    const user = requireUser(req);
    const body = parse(pinSchema, req.body);
    const card = svc.cards.get(req.params.number);
    authorize(user, 'canaux:card.pin', { taxpayerId: card.taxpayerId });
    svc.cards.setPin(card.taxpayerId, body.pin, { kind: 'user', id: user.id });
    return { cardNumber: formatCardNumber(card.number), pinSet: true, stored: 'empreinte scrypt salée — jamais en clair' };
  });
  app.post<{ Params: { number: string } }>('/v1/mosolo-cards/:number/reissue-requests', async (req, reply) => {
    const body = parse(motifSchema, req.body);
    return reply.code(201).send(svc.cards.requestReissue(requireUser(req), req.params.number, body.motif));
  });
  app.get('/v1/mosolo-cards/reissue-requests', async (req) => {
    const user = requireUser(req);
    authorize(user, 'canaux:card.reissue.approve');
    return svc.cards.reissues.all();
  });
  app.post<{ Params: { id: string } }>('/v1/mosolo-cards/reissue-requests/:id/approve', async (req) => {
    const r = svc.cards.approveReissue(requireUser(req), req.params.id);
    return { request: r.request, card: svc.cards.view(r.card) };
  });

  // ---------- Points de paiement agréés : registre et supervision (Trésor) ----------
  app.get('/v1/payment-points', async (req) => svc.points.supervision(requireUser(req)));
  app.post('/v1/payment-points', async (req, reply) => {
    const body = parse(pointSchema, req.body);
    return reply.code(201).send(svc.points.reference(requireUser(req), body));
  });
  app.post<{ Params: { id: string } }>('/v1/payment-points/:id/activate', async (req) => svc.points.activate(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/payment-points/:id/suspend', async (req) => {
    const body = parse(suspendSchema, req.body);
    return svc.points.suspend(requireUser(req), req.params.id, body.motif, body.proposalId);
  });
  // Rétablissement / écartement à quatre yeux : le premier appel enregistre la demande, un R17 distinct décide.
  app.post<{ Params: { id: string } }>('/v1/payment-points/:id/reinstate', async (req) => {
    const body = parse(motifSchema, req.body);
    return svc.points.reinstate(requireUser(req), req.params.id, body.motif);
  });
  app.post<{ Params: { id: string } }>('/v1/payment-point-proposals/:id/dismiss', async (req) => {
    const body = parse(motifSchema, req.body);
    return svc.points.dismissProposal(requireUser(req), req.params.id, body.motif);
  });

  // ---------- Paiement numérique assisté par l'agent (jamais d'espèces) ----------
  app.get<{ Querystring: { objectId?: string; obligationIds?: string } }>('/v1/agents/assist/payables', async (req) => {
    const user = requireUser(req);
    const ids = (req.query.obligationIds ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
    return svc.assisted.payables(user, { ...(req.query.objectId ? { objectId: req.query.objectId } : {}), obligationIds: ids });
  });
  app.post('/v1/agents/assist/payment-orders', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(assistOrderSchema, req.body);
    const res = await ctx.idempotency.executeAsync(`assist-order:${user.id}`, key, body, async () => ({ statusCode: 201, body: await svc.assisted.issue(user, body) }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.get<{ Params: { reference: string } }>('/v1/agents/assist/payment-orders/:reference', async (req) => svc.assisted.status(requireUser(req), req.params.reference));

  // ---------- Console de l'opérateur du point agréé (R32) ----------
  app.get('/v1/payment-points/mine', async (req) => svc.points.myPoints(requireUser(req)));
  app.get<{ Params: { id: string; reference: string } }>('/v1/payment-points/:id/references/:reference', async (req) =>
    svc.points.lookup(requireUser(req), req.params.id, req.params.reference));
  app.get<{ Params: { id: string; number: string } }>('/v1/payment-points/:id/cards/:number', async (req) =>
    svc.points.cardSituation(requireUser(req), req.params.id, req.params.number));
  app.post<{ Params: { id: string } }>('/v1/payment-points/:id/card-references', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(cardRefSchema, req.body);
    const res = ctx.idempotency.execute(`canaux-card-ref:${user.id}`, key, { point: req.params.id, body }, () => ({
      statusCode: 201, body: svc.points.cardReference(user, req.params.id, body.cardNumber, body.obligationId),
    }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.post<{ Params: { id: string } }>('/v1/payment-points/:id/collections', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(collectSchema, req.body);
    const res = ctx.idempotency.execute(`canaux-collect:${user.id}`, key, { point: req.params.id, body }, () => ({
      statusCode: 201, body: svc.points.collect(user, req.params.id, body.paymentReference),
    }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.post<{ Params: { id: string; cid: string } }>('/v1/payment-points/:id/collections/:cid/print', async (req) =>
    svc.points.print(requireUser(req), req.params.id, req.params.cid));
  app.get<{ Params: { id: string; day: string } }>('/v1/payment-points/:id/cash-days/:day', async (req) =>
    svc.points.cashDayView(requireUser(req), req.params.id, parse(isoDateString, req.params.day)));
  app.post<{ Params: { id: string; day: string } }>('/v1/payment-points/:id/cash-days/:day/close', async (req) => {
    const body = parse(closeSchema, req.body);
    return svc.points.close(requireUser(req), req.params.id, parse(isoDateString, req.params.day), body.counted);
  });
  app.post<{ Params: { id: string; day: string } }>('/v1/payment-points/:id/cash-days/:day/deposit', async (req) => {
    const body = parse(depositSchema, req.body);
    return svc.points.deposit(requireUser(req), req.params.id, parse(isoDateString, req.params.day), body);
  });
  // Constatation du versement au relevé du compte public (Trésor, quatre yeux) : proposition R17/R18, approbation R17 distinct.
  app.post<{ Params: { id: string; day: string } }>('/v1/payment-points/:id/cash-days/:day/bank-match', async (req) => {
    const body = parse(bankMatchSchema, req.body);
    return svc.points.proposeBankMatch(requireUser(req), req.params.id, parse(isoDateString, req.params.day), body.statementId);
  });
  app.post<{ Params: { id: string; day: string } }>('/v1/payment-points/:id/cash-days/:day/bank-match/approve', async (req) =>
    svc.points.approveBankMatch(requireUser(req), req.params.id, parse(isoDateString, req.params.day)));

  // ---------- Indicateurs d'inclusion (agrégats) ----------
  app.get('/v1/channels/indicators', async (req) => svc.indicators(requireUser(req)));
}
