/**
 * Routes RakaPay (billetterie, module 76) et wewa (module 81) — convention § H.14 :
 * `/v1/rakapay/...`, `/v1/cooperatives/{id}/group-payments` → ici `/v1/rakapay/cooperatives/{id}/paiements-groupes`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { PAYMENT_CHANNELS } from '../../modules/payments/service.js';
import { placeSchema } from '../titres/service.js';
import { WEWA_DURATIONS, type RakaPayService } from './service.js';
import { withOverdue } from '../sanctions/service.js';
import { registerOperateursRoutes } from './operateurs-routes.js';
import { registerBilletterieRoutes } from './billetterie-routes.js';

const channel = z.enum(PAYMENT_CHANNELS);
const ticketSchema = z.object({ productId: z.string().min(1).max(64), departureStationId: z.string().min(1).max(64), channel }).strict();
const passSchema = z.object({ motoId: z.string().min(1).max(64), duration: z.enum(WEWA_DURATIONS), channel }).strict();
const groupSchema = z.object({ items: z.array(z.object({ motoId: z.string().min(1).max(64), duration: z.enum(WEWA_DURATIONS) }).strict()).min(1).max(200), channel }).strict();
const motoSchema = z.object({
  plate: z.string().trim().min(4).max(20), orderNumber: z.string().trim().min(2).max(40), make: z.string().trim().min(2).max(80),
  ownerTaxpayerId: z.string().max(64).optional(), ownerLabel: z.string().trim().min(2).max(120).optional(), stationId: z.string().min(1).max(64),
  cooperativeId: z.string().max(64).optional(),
}).strict();
const driverSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(), licenceNo: z.string().trim().min(3).max(40), phone: z.string().trim().max(20).optional(),
  taxpayerId: z.string().max(64).optional(), motoId: z.string().max(64).optional(), cooperativeId: z.string().max(64).optional(), photoRef: z.string().max(128).optional(),
}).strict();
const controlSchema = z.object({
  vest: z.string().trim().max(2000).optional(), sticker: z.string().trim().max(2000).optional(), plate: z.string().trim().max(20).optional(),
  qr: z.string().trim().max(2000).optional(), place: placeSchema, deviceId: z.string().max(100).optional(),
}).strict().refine((b) => b.vest || b.sticker || b.plate || b.qr, { message: 'gilet, autocollant, plaque ou QR requis' });
const reportSchema = z.object({
  category: z.enum(['PRELEVEMENT_IRREGULIER', 'DEMANDE_ESPECES', 'CONTROLE_ABUSIF', 'AUTRE']), commune: z.string().trim().min(2).max(40),
  stationId: z.string().max(64).optional(), occurredAt: z.string().datetime({ offset: true }).or(isoDateString),
  description: z.string().trim().min(10).max(3000), amountDemanded: moneySchema.optional(), anonymous: z.boolean().default(true),
}).strict();
const complaintDecision = z.object({ status: z.enum(['QUALIFIE', 'TRANSMIS', 'CLOS']), motif: z.string().trim().min(5).max(2000), confirmed: z.boolean().optional() }).strict();
const coopDecision = z.object({ decision: z.enum(['ACCREDITER', 'SUSPENDRE', 'REACTIVER']), motif: z.string().trim().min(5).max(2000) }).strict();

function idempotent<T>(ctx: AppContext, scope: string, req: { headers: Record<string, string | string[] | undefined> }, payload: unknown, fn: () => T) {
  const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
  return ctx.idempotency.execute(scope, key, payload, () => ({ statusCode: 201, body: fn() }));
}

export function registerRakaPayRoutes(app: FastifyInstance, ctx: AppContext, svc: RakaPayService): void {
  // Référentiels publics (transparence : stations, lignes, catalogue et tarifs issus des règles).
  app.get('/v1/rakapay/stations', async () => svc.stations.all());
  app.get('/v1/rakapay/lignes', async () => svc.lines.all());
  app.get('/v1/rakapay/catalogue', async () => svc.catalogue());
  app.get('/v1/rakapay/operateurs', async () =>
    svc.operators.all().map((o) => ({ id: o.id, code: o.code, name: o.name, kind: o.kind, commune: o.commune, status: o.status, stationIds: o.stationIds, demo: o.demo })));

  // Billetterie : achat → référence de paiement (idempotent).
  app.post('/v1/rakapay/tickets', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(ticketSchema, req.body);
    const res = idempotent(ctx, `rakapay-ticket:${user.id}`, req, body, () => svc.buyTicket(user, body));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.get('/v1/rakapay/tickets', async (req) => {
    const user = requireUser(req);
    if (!user.taxpayerId) throw forbidden('FORBIDDEN', 'Réservé aux titulaires.');
    authorize(user, 'titres:read.own', { taxpayerId: user.taxpayerId });
    svc.titres.sync();
    return svc.myTickets(user.taxpayerId);
  });

  // Espace wewa du conducteur.
  app.get('/v1/rakapay/wewa/moi', async (req) => {
    const user = requireUser(req);
    if (!user.taxpayerId) throw forbidden('FORBIDDEN', 'Réservé aux conducteurs disposant d’un compte.');
    authorize(user, 'titres:read.own', { taxpayerId: user.taxpayerId });
    return svc.myWewa(user);
  });
  app.post('/v1/rakapay/wewa/passes', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(passSchema, req.body);
    const res = idempotent(ctx, `rakapay-pass:${user.id}`, req, body, () => svc.buyPass(user, body));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });

  // Registre (enregistrement gratuit).
  app.post('/v1/rakapay/wewa/motos', async (req, reply) => reply.code(201).send(svc.registerMoto(requireUser(req), parse(motoSchema, req.body))));
  app.post('/v1/rakapay/wewa/conducteurs', async (req, reply) => {
    const d = svc.registerDriver(requireUser(req), parse(driverSchema, req.body));
    return reply.code(201).send({ ...d, phone: undefined });
  });
  app.post<{ Params: { id: string } }>('/v1/rakapay/wewa/conducteurs/:id/affectation', async (req) => {
    const body = parse(z.object({ motoId: z.string().min(1).max(64) }).strict(), req.body);
    const d = svc.assign(requireUser(req), req.params.id, body.motoId);
    return { ...d, phone: undefined };
  });
  app.get<{ Querystring: { commune?: string } }>('/v1/rakapay/wewa/registre', async (req) => svc.registry(requireUser(req), req.query.commune));
  app.get<{ Params: { id: string } }>('/v1/rakapay/wewa/motos/:id/statut', async (req) => {
    const user: User = requireUser(req);
    const m = svc.moto(req.params.id);
    const d = svc.drivers.findOne((x) => x.currentMotoId === m.id);
    const coop = m.cooperativeId ? svc.operators.get(m.cooperativeId) : undefined;
    const own = (d?.taxpayerId && user.taxpayerId === d.taxpayerId) || (coop?.taxpayerId && user.taxpayerId === coop.taxpayerId);
    if (!own) authorize(user, 'rakapay:registry.read', { communes: [m.commune] });
    svc.titres.sync();
    return { plate: m.plate, ...svc.motoStatus(m) };
  });

  // Contrôle protecteur (gilet, autocollant, plaque, QR) — contrôleur habilité, jamais la coopérative.
  app.post('/v1/rakapay/wewa/controles', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(controlSchema, req.body);
    const view = svc.control(user, body);
    // Plaque lue (même si la moto n'est pas enregistrée) : le registre des pénalités la recherche aussi — mais seulement
    // si le contrôle a réellement porté sur cette plaque (jamais une plaque jointe à un contrôle par gilet ou autocollant).
    const plate = view.plate ?? (view.method === 'PLAQUE' ? body.plate ?? null : null);
    return reply.code(201).send(withOverdue(ctx, user, view, { plate }, 'RAKAPAY', view.controlId));
  });

  // Vérification par le passager (publique, minimale).
  app.get<{ Params: { code: string } }>('/v1/public/wewa/:code', async (req) => svc.passengerCheck(decodeURIComponent(req.params.code)));

  // Coopératives.
  app.get('/v1/rakapay/cooperatives', async () =>
    svc.operators.find((o) => o.kind === 'COOPERATIVE').map((o) => ({ id: o.id, code: o.code, name: o.name, commune: o.commune, status: o.status, members: svc.motos.find((m) => m.cooperativeId === o.id).length, demo: o.demo })));
  app.get<{ Params: { id: string } }>('/v1/rakapay/cooperatives/:id', async (req) => svc.coopView(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/rakapay/cooperatives/:id/paiements-groupes', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(groupSchema, req.body);
    const res = idempotent(ctx, `rakapay-group:${user.id}`, req, { coop: req.params.id, body }, () => svc.groupPayment(user, req.params.id, body));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.post<{ Params: { id: string } }>('/v1/rakapay/cooperatives/:id/decisions', async (req) => svc.decideCoop(requireUser(req), req.params.id, parse(coopDecision, req.body)));

  // Signalements (anonymes possibles, sans authentification).
  app.post('/v1/rakapay/signalements', async (req, reply) => {
    const body = parse(reportSchema, req.body);
    const c = svc.report(req.user, { ...body, occurredAt: body.occurredAt.length === 10 ? `${body.occurredAt}T00:00:00.000+01:00` : body.occurredAt });
    return reply.code(201).send({ id: c.id, status: c.status, receivedAt: c.receivedAt, message: 'Signalement reçu. Il est protégé et transmis à la cellule anti-fraude.' });
  });
  app.get('/v1/rakapay/signalements', async (req) => {
    const user = requireUser(req);
    authorize(user, 'rakapay:complaint.read');
    return svc.complaints.all().map((c) => ({ ...c, reporterUserId: undefined })).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  });
  app.post<{ Params: { id: string } }>('/v1/rakapay/signalements/:id/traitement', async (req) => svc.handleComplaint(requireUser(req), req.params.id, parse(complaintDecision, req.body)));

  // Multi-opérateurs (§ 11D) : agrément, offres, agents exclusifs, circuit privé séparé, tableaux, revue des ventes.
  registerOperateursRoutes(app, svc);
  // Module 76 / 81 : limites, ajustements, commissions, analyse quotidienne, blocage préventif, période de grâce.
  registerBilletterieRoutes(app, svc);

  // Tableau de pilotage (agrégats).
  app.get('/v1/rakapay/indicateurs', async (req) => {
    const user = requireUser(req);
    authorize(user, 'rakapay:indicators');
    return svc.indicators();
  });
}
