/**
 * Routes du module 79 (plaque fiscale immobilière NFIU) : habilitations nominatives, situation complète en lecture
 * seule pour l'agent habilité, rapports journaliers des agents, indicateurs. Aucune route ne modifie un montant.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { PN } from './nfiu.js';
import { P } from './policies.js';
import type { VerticalesService } from './service.js';

const motif = z.string().trim().min(10).max(2000);

export function registerNfiuRoutes(app: FastifyInstance, svc: VerticalesService): void {
  const n = svc.nfiu!;
  app.get('/v1/verticales/nfiu/habilitations', async (req) => ({ items: n.list(requireUser(req)) }));
  app.post('/v1/verticales/nfiu/habilitations', async (req, reply) => reply.code(201).send(n.habilitate(requireUser(req), parse(z.object({
    userId: z.string().min(1).max(64), communes: z.array(z.string().min(2).max(40)).min(1).max(24), motif, validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(), req.body))));
  app.post<{ Params: { userId: string } }>('/v1/verticales/nfiu/habilitations/:userId/revocation', async (req) =>
    n.revoke(requireUser(req), req.params.userId, parse(z.object({ motif }).strict(), req.body).motif));
  // Mon habilitation (agent) : communes et échéance.
  app.get('/v1/verticales/nfiu/habilitations/mienne', async (req) => {
    const user = requireUser(req);
    const h = n.habilitations.get(user.id);
    return { habilitation: h && !h.revoked ? h : null };
  });
  // Situation complète d'une plaque NFIU (lecture seule, journalisée).
  app.get<{ Params: { code: string } }>('/v1/verticales/nfiu/plates/:code/situation', async (req) => {
    const user = requireUser(req);
    const p = svc.getPlate(req.params.code);
    authorize(user, P.plateScan, { communes: [p.commune] });
    return { plate: { code: p.code, commune: p.commune, quartier: p.quartier, status: p.status }, ...n.fullSituation(user, p) };
  });
  // Rapports journaliers des agents : consultation (l'agent ne voit que sa ligne) et production à la demande.
  app.get<{ Querystring: { date?: string } }>('/v1/verticales/nfiu/rapports', async (req) => n.report(requireUser(req), req.query.date ?? kinshasaDate(svc.now())));
  app.post('/v1/verticales/nfiu/rapports', async (req, reply) => reply.code(201).send(n.generate(requireUser(req), parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(), req.body).date)));
  app.get('/v1/verticales/nfiu/rapports/historique', async (req) => {
    authorize(requireUser(req), PN.report, {});
    return { items: n.reports.all().sort((a, b) => b.date.localeCompare(a.date)).map((r) => ({ date: r.date, generatedAt: r.generatedAt, trigger: r.trigger, totals: r.totals })) };
  });
  app.get('/v1/verticales/nfiu/indicateurs', async (req) => {
    authorize(requireUser(req), PN.report, {});
    return n.indicators();
  });
}
