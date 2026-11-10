/** Routes RakaPay multi-opérateurs (§ 11D) : agrément, offres, agents, circuit privé séparé, tableaux, revue des ventes. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { moneySchema, parse } from '../../core/http.js';
import type { RakaPayService } from './service.js';

const motif = z.string().trim().min(5).max(2000);

export function registerOperateursRoutes(app: FastifyInstance, svc: RakaPayService): void {
  const o = svc.operateurs;
  // Agrément (candidature → proposition → décision d'une autre personne).
  app.post('/v1/rakapay/operateurs/candidatures', async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(3).max(160), kind: z.enum(['PUBLIC', 'PRIVE']), commune: z.string().min(2).max(40), taxpayerId: z.string().max(64).optional() }).strict(), req.body);
    return reply.code(201).send(o.apply(requireUser(req), body));
  });
  app.post<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/agrement/proposition', async (req) =>
    o.proposeApproval(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['ACCREDITER', 'REFUSER']), motif }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/agrement/decision', async (req) =>
    o.decideApproval(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
  app.get<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/agrement', async (req) => {
    requireUser(req);
    return o.approvals.get(req.params.id) ?? { id: req.params.id, operatorId: req.params.id };
  });

  // Offres proposées par l'opérateur (approuvées selon les règles du registre).
  app.get<{ Querystring: { operatorId?: string } }>('/v1/rakapay/offres', async (req) => ({ items: o.listOffers(req.user, req.query.operatorId) }));
  app.post<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/offres', async (req, reply) => {
    const body = parse(z.object({
      family: z.enum(['ACCES', 'STATIONNEMENT']), commercialName: z.string().trim().min(2).max(120),
      duration: z.object({ unit: z.enum(['HEURE', 'JOUR']), value: z.number().int().positive().max(365) }).strict(),
      place: z.object({ commune: z.string().min(2).max(40), label: z.string().trim().min(2).max(160), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict(),
      typeCode: z.string().max(60).optional(), price: moneySchema.optional(),
    }).strict(), req.body);
    return reply.code(201).send(o.proposeOffer(requireUser(req), req.params.id, body));
  });
  app.post<{ Params: { id: string } }>('/v1/rakapay/offres/:id/decision', async (req) =>
    o.decideOffer(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));

  // Agents exclusifs d'un opérateur.
  app.post<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/agents', async (req, reply) =>
    reply.code(201).send(o.attachAgent(requireUser(req), req.params.id, parse(z.object({ userId: z.string().min(1).max(64) }).strict(), req.body).userId)));
  app.post<{ Params: { id: string; userId: string } }>('/v1/rakapay/operateurs/:id/agents/:userId/retrait', async (req) => o.detachAgent(requireUser(req), req.params.id, req.params.userId));
  app.get('/v1/rakapay/operateurs/mon-rattachement', async (req) => {
    const user = requireUser(req);
    const a = o.agentOf(user.id);
    const own = user.taxpayerId ? svc.operators.find((x) => x.taxpayerId === user.taxpayerId) : [];
    return { agentOf: a ? { operatorId: a.operatorId, name: svc.operators.get(a.operatorId)?.name ?? a.operatorId } : null, adminOf: own.map((x) => ({ id: x.id, name: x.name, kind: x.kind, status: x.status })) };
  });

  // Circuit privé séparé (AC-TKT-01).
  app.post('/v1/rakapay/ventes-privees', async (req, reply) =>
    reply.code(201).send(o.recordPrivateSale(requireUser(req), parse(z.object({ offerId: z.string().min(1).max(64), channel: z.string().min(2).max(20) }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/rakapay/ventes-privees/:id/annulation', async (req, reply) =>
    reply.code(201).send(o.cancelPrivateSale(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif)));

  // Tableaux : opérateur (sans visibilité croisée) et supervision des deux circuits.
  app.get<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/tableau', async (req) => o.dashboard(requireUser(req), req.params.id));
  app.get('/v1/rakapay/circuits', async (req) => o.circuits(requireUser(req)));
  app.get<{ Querystring: { tauxHypothetique?: string } }>('/v1/rakapay/redevance-plateforme/simulation', async (req) => o.simulatePlatformFee(requireUser(req), req.query.tauxHypothetique ?? ''));

  // Revue des ventes atypiques (signal explicable, décision humaine motivée).
  app.post('/v1/rakapay/revues-ventes/detection', async (req) => o.detectUnusualSales(requireUser(req)));
  app.get('/v1/rakapay/revues-ventes', async (req) => ({ items: o.listReviews(requireUser(req)) }));
  app.post<{ Params: { id: string } }>('/v1/rakapay/revues-ventes/:id/decision', async (req) =>
    o.decideReview(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['CLASSER', 'TRANSMETTRE_INTEGRITE']), motif }).strict(), req.body)));
}
