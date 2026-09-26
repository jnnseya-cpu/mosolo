/** Routes HTTP du module « verticales » (préfixe /v1/verticales, vérifications publiques sous /v1/public/verticales). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { badRequest, forbidden } from '../../core/errors.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { decimalString, isoDateString, moneySchema, parse } from '../../core/http.js';
import { VERTICALS } from './catalogue.js';
import { ACCOUNT_TYPES, DOCUMENT_TYPES } from './calcu.js';
import { type VerticalesService } from './service.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const docSchema = z.object({ label: z.string().trim().min(1).max(160), sha256 }).strict();
const reason = z.string().trim().min(5).max(2000);

const caseSchema = z.object({
  type: z.string().min(1).max(64),
  taxpayerId: z.string().optional(),
  objectId: z.string().optional(),
  details: z.record(z.string().max(2000)).default({}),
  documents: z.array(docSchema).max(20).default([]),
}).strict();

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'période AAAA-MM attendue');
const count = z.number().int().min(0).max(100_000_000);

export function registerVerticalRoutes(app: FastifyInstance, ctx: AppContext, svc: VerticalesService): void {
  // ---------------------------------------------------------------- catalogue (public)
  app.get('/v1/verticales', async () => ({
    items: VERTICALS.map((v) => svc.catalogueSummary(v)),
    notice: 'Aucune règle sectorielle n’est certifiée à ce jour : les montants affichés proviennent de règles fictives de démonstration, non opposables.',
  }));

  app.get<{ Params: { slug: string } }>('/v1/verticales/:slug', async (req) => svc.catalogueDetail(svc.vertical(req.params.slug)));

  // ---------------------------------------------------------------- espace de l'usager
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/verticales/me/summary', async (req) => {
    const user = requireUser(req);
    const tp = req.query.taxpayerId ?? user.taxpayerId;
    if (!tp) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable requis (mandataire : ?taxpayerId=).');
    return { taxpayerId: tp, items: svc.summary(user, tp) };
  });

  app.get<{ Params: { slug: string }; Querystring: { taxpayerId?: string } }>('/v1/verticales/:slug/space', async (req) => {
    const user = requireUser(req);
    const tp = req.query.taxpayerId ?? user.taxpayerId;
    if (!tp) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable requis (mandataire : ?taxpayerId=).');
    return svc.space(user, req.params.slug, tp);
  });

  // ---------------------------------------------------------------- démarches en ligne
  app.post<{ Params: { slug: string } }>('/v1/verticales/:slug/cases', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(caseSchema, req.body);
    const res = ctx.idempotency.execute(`vx-case:${user.id}`, key, { slug: req.params.slug, body }, () => ({ statusCode: 201, body: svc.submitCase(user, req.params.slug, body) }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });

  app.get<{ Querystring: { vertical?: string; status?: string; taxpayerId?: string } }>('/v1/verticales/cases', async (req) => {
    const user = requireUser(req);
    return svc.listCases(user, req.query);
  });

  app.get<{ Params: { id: string } }>('/v1/verticales/cases/:id', async (req) => {
    const user = requireUser(req);
    const view = svc.readCase(user, req.params.id);
    return { ...view, conditions: svc.conditionsFor(svc.getCase(req.params.id)) };
  });

  app.post<{ Params: { id: string } }>('/v1/verticales/cases/:id/documents', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ documents: z.array(docSchema).min(1).max(20) }).strict(), req.body);
    return svc.addDocuments(user, req.params.id, body.documents);
  });

  app.post<{ Params: { id: string } }>('/v1/verticales/cases/:id/take', async (req) => svc.take(requireUser(req), req.params.id));

  app.post<{ Params: { id: string } }>('/v1/verticales/cases/:id/request-info', async (req) => {
    const body = parse(z.object({ note: reason }).strict(), req.body);
    return svc.requestInfo(requireUser(req), req.params.id, body.note);
  });

  app.post<{ Params: { id: string } }>('/v1/verticales/cases/:id/visits', async (req, reply) => {
    const body = parse(z.object({ date: isoDateString, result: z.enum(['CONFORME', 'NON_CONFORME', 'A_REVOIR']), observations: reason, evidenceSha256: sha256.optional() }).strict(), req.body);
    return reply.code(201).send(svc.recordVisit(requireUser(req), req.params.id, body));
  });

  app.post<{ Params: { id: string } }>('/v1/verticales/cases/:id/propose', async (req) => {
    const body = parse(z.object({ outcome: z.enum(['ACCEPTER', 'REFUSER']), reason }).strict(), req.body);
    return svc.propose(requireUser(req), req.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/v1/verticales/cases/:id/decide', async (req) => {
    const body = parse(z.object({ decision: z.enum(['ACCEPTE', 'REFUSE']), reason }).strict(), req.body);
    return svc.decide(requireUser(req), req.params.id, body);
  });

  // ---------------------------------------------------------------- liquidation par un agent (règle ACTIVE seulement)
  app.post<{ Params: { slug: string; objectId: string } }>('/v1/verticales/:slug/objects/:objectId/liquidate', async (req, reply) => {
    const body = parse(z.object({ inputs: z.record(decimalString).default({}) }).strict(), req.body ?? {});
    return reply.code(201).send(svc.liquidateObject(requireUser(req), req.params.slug, req.params.objectId, body.inputs));
  });

  // ---------------------------------------------------------------- plaques et certificats
  app.post('/v1/verticales/plates', async (req, reply) => {
    const body = parse(z.object({ objectId: z.string().min(1) }).strict(), req.body);
    return reply.code(201).send(svc.issuePlate(requireUser(req), body.objectId));
  });
  app.post<{ Params: { code: string } }>('/v1/verticales/plates/:code/replace', async (req, reply) => {
    const body = parse(z.object({ reason }).strict(), req.body);
    return reply.code(201).send(svc.replacePlate(requireUser(req), req.params.code, body.reason));
  });
  app.get<{ Params: { code: string } }>('/v1/verticales/plates/:code/scan', async (req) => svc.scanPlate(requireUser(req), req.params.code));
  app.get<{ Params: { code: string } }>('/v1/verticales/plates/:code/counter', async (req) => svc.counterLookup(requireUser(req), req.params.code));
  app.get<{ Querystring: { date?: string } }>('/v1/verticales/plates-report/daily', async (req) => {
    const date = req.query.date ?? ctx.clock.now().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('INVALID_DATE', 'date AAAA-MM-JJ attendue');
    return svc.dailyReport(requireUser(req), date);
  });

  app.get<{ Params: { code: string } }>('/v1/public/verticales/plates/:code', async (req) => svc.publicPlate(req.params.code));
  app.get<{ Params: { code: string } }>('/v1/public/verticales/certificates/:code', async (req) => svc.publicCertificate(req.params.code));

  // ---------------------------------------------------------------- marchés
  app.get('/v1/verticales/marches/plan', async () => ({ markets: svc.marketPlan(), notice: 'Plan de démonstration — références fictives.' }));
  app.post<{ Params: { id: string } }>('/v1/verticales/marches/stalls/:id/titles', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(z.object({ period: z.enum(['JOUR', 'SEMAINE', 'MOIS']) }).strict(), req.body);
    const res = ctx.idempotency.execute(`vx-stall-title:${user.id}`, key, { stall: req.params.id, body }, () => ({ statusCode: 201, body: svc.requestStallTitle(user, req.params.id, body.period) }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });

  // ---------------------------------------------------------------- événements
  app.post<{ Params: { objectId: string } }>('/v1/verticales/evenements/events/:objectId/ticketing', async (req, reply) => {
    const body = parse(z.object({ ticketsSold: count, source: z.enum(['RAKAPAY', 'AUTRE_OPERATEUR', 'DECLARATION_MANUELLE']), fileSha256: sha256.optional() }).strict(), req.body);
    return reply.code(201).send(svc.declareTicketing(requireUser(req), req.params.objectId, body));
  });
  app.post<{ Params: { objectId: string } }>('/v1/verticales/evenements/events/:objectId/controls', async (req, reply) => {
    const body = parse(z.object({ observedAttendance: count }).strict(), req.body);
    return reply.code(201).send(svc.controlEvent(requireUser(req), req.params.objectId, body.observedAttendance));
  });

  // ---------------------------------------------------------------- télécom
  app.get('/v1/verticales/telecom/reconciliation', async (req) => svc.telecomReconciliation(requireUser(req)));

  // ---------------------------------------------------------------- indicateurs agrégés
  app.get('/v1/verticales/indicators', async (req) => {
    const user = requireUser(req);
    if (!user.roles.some((r) => /^R(0[1-9]|1\d|2[0-9])$/.test(r))) throw forbidden('AGENTS_ONLY', 'Indicateurs réservés aux agents publics.');
    return svc.indicators();
  });

  // ---------------------------------------------------------------- AVIA
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/verticales/avia/declarations', async (req) => svc.avia.list(requireUser(req), req.query.taxpayerId));
  app.get('/v1/verticales/avia/overview', async (req) => svc.avia.overview(requireUser(req)));
  app.get<{ Params: { id: string } }>('/v1/verticales/avia/declarations/:id', async (req) => svc.avia.read(requireUser(req), req.params.id));
  app.post('/v1/verticales/avia/declarations', async (req, reply) => {
    const body = parse(z.object({ taxpayerId: z.string().optional(), period: periodSchema, aircraftObjectIds: z.array(z.string()).max(50).default([]), flights: count, passengersDeparting: count, freightKg: count }).strict(), req.body);
    return reply.code(201).send(svc.avia.declare(requireUser(req), body));
  });
  app.post('/v1/verticales/avia/operator-data', async (req, reply) => {
    const body = parse(z.object({ period: periodSchema, airlineTaxpayerId: z.string(), source: z.enum(['RVA', 'DGM', 'EXPLOITANT']), flights: count, passengersBoarded: count, passengersExited: count.optional(), freightKg: count, fileSha256: sha256.optional() }).strict(), req.body);
    return reply.code(201).send(svc.avia.submitOperatorData(requireUser(req), body));
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/avia/declarations/:id/reconcile', async (req) => svc.avia.reconcile(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/verticales/avia/declarations/:id/observations', async (req) => {
    const body = parse(z.object({ text: reason, documents: z.array(sha256).max(20).default([]) }).strict(), req.body);
    return svc.avia.observe(requireUser(req), req.params.id, body);
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/avia/declarations/:id/validate', async (req) => {
    const body = parse(z.object({ reason }).strict(), req.body);
    return svc.avia.validate(requireUser(req), req.params.id, body.reason);
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/avia/declarations/:id/billing', async (req, reply) => reply.code(201).send(svc.avia.requestBilling(requireUser(req), req.params.id)));

  // ---------------------------------------------------------------- CALCU
  app.get('/v1/verticales/calcu/overview', async (req) => svc.calcu.overview(requireUser(req)));
  app.post('/v1/verticales/calcu/accounts', async (req, reply) => {
    const body = parse(z.object({ entityName: z.string().trim().min(2).max(160), bank: z.string().trim().min(2).max(120), accountNumber: z.string().trim().min(6).max(64), currency: z.enum(['CDF', 'USD']), type: z.enum(ACCOUNT_TYPES), signatories: z.array(z.string().trim().min(2).max(120)).min(1).max(10) }).strict(), req.body);
    return reply.code(201).send(svc.calcu.declareAccount(requireUser(req), body));
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/accounts/:id/validate', async (req) => {
    const body = parse(z.object({ as: z.enum(['FINANCES', 'CONTROLE']) }).strict(), req.body);
    return svc.calcu.validateAccount(requireUser(req), req.params.id, body.as);
  });
  app.post('/v1/verticales/calcu/documents', async (req, reply) => {
    const body = parse(z.object({ accountId: z.string(), operationRef: z.string().trim().min(2).max(64), type: z.enum(DOCUMENT_TYPES), supplier: z.string().trim().min(2).max(160), amount: moneySchema, date: isoDateString, sha256 }).strict(), req.body);
    return reply.code(201).send(svc.calcu.registerDocument(requireUser(req), body));
  });
  app.post('/v1/verticales/calcu/gateway/transactions', async (req, reply) => {
    const body = parse(z.object({ bank: z.string().trim().min(2).max(120), accountNumber: z.string().trim().min(6).max(64), amount: moneySchema, at: z.string().datetime({ offset: true }), beneficiary: z.string().trim().min(2).max(160), reference: z.string().trim().min(1).max(64) }).strict(), req.body);
    return reply.code(201).send(svc.calcu.receiveTransaction(requireUser(req), body));
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/reports/:id/freeze', async (req) => {
    const body = parse(z.object({ reason, legalBasis: z.string().trim().min(3).max(300) }).strict(), req.body);
    return svc.calcu.freeze(requireUser(req), req.params.id, body);
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/reports/:id/close', async (req) => {
    const body = parse(z.object({ reason }).strict(), req.body);
    return svc.calcu.close(requireUser(req), req.params.id, body.reason);
  });
}
