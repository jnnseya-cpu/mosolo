/**
 * Routes des compléments RakaPay (modules 76 et 81) : limites approuvées, ajustements de l'opérateur dans ces limites,
 * grille de commission et commissions instantanées, analyse quotidienne, blocage préventif motivé, période de grâce.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { moneySchema, parse, isRealCalendarDate } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import type { RakaPayService } from './service.js';

const motif = z.string().trim().min(10).max(2000);
const pct = z.string().regex(/^\d{1,2}(\.\d{1,2})?$|^100$/);

export function registerBilletterieRoutes(app: FastifyInstance, svc: RakaPayService): void {
  const b = svc.billetterie;
  app.post<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/limites', async (req) => b.approveLimits(requireUser(req), req.params.id, parse(z.object({
    commissionMaxPct: pct, priceBands: z.array(z.object({ offerId: z.string().min(1).max(64), min: moneySchema, max: moneySchema }).strict()).max(200), motif,
  }).strict(), req.body)));
  app.get<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/limites', async (req) => {
    requireUser(req);
    return { limits: b.limits.get(req.params.id) ?? null, grid: b.grids.get(req.params.id) ?? null };
  });
  app.post<{ Params: { id: string } }>('/v1/rakapay/offres/:id/prix', async (req) => b.adjustPrice(requireUser(req), req.params.id, parse(z.object({ price: moneySchema }).strict(), req.body).price));
  app.post<{ Params: { id: string } }>('/v1/rakapay/operateurs/:id/grille-commissions', async (req) =>
    b.setGrid(requireUser(req), req.params.id, parse(z.object({ rates: z.array(z.object({ offerId: z.string().min(1).max(64), pct }).strict()).min(1).max(200) }).strict(), req.body).rates));
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>('/v1/rakapay/operateurs/:id/analyse-quotidienne', async (req) =>
    b.dailyAnalysis(requireUser(req), req.params.id, req.query.date ?? b.today()));
  app.get('/v1/rakapay/commissions/mes-commissions', async (req) => {
    const user = requireUser(req);
    return { items: b.commissions.find((c) => c.agentId === user.id).sort((x, y) => y.at.localeCompare(x.at)) };
  });
  app.post<{ Params: { id: string; userId: string } }>('/v1/rakapay/operateurs/:id/agents/:userId/blocage', async (req, reply) =>
    reply.code(201).send(b.block(requireUser(req), req.params.id, req.params.userId, parse(z.object({ motif: z.string().trim().min(15).max(2000), reviewId: z.string().max(120).optional() }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/rakapay/blocages/:id/levee', async (req) => b.lift(requireUser(req), req.params.id, parse(z.object({ motif: z.string().trim().min(15).max(2000) }).strict(), req.body).motif));
  app.get('/v1/rakapay/blocages', async (req) => {
    authorize(requireUser(req), 'rakapay:operator.supervise', { entity: 'DGTK' });
    return { items: b.blocks.all().sort((x, y) => y.decidedAt.localeCompare(x.decidedAt)) };
  });
  // Période de grâce (modules 81 et 76) : proposition → approbation par une autre personne.
  app.get('/v1/rakapay/periode-grace', async (req) => { requireUser(req); return b.graceView(); });
  app.post('/v1/rakapay/periode-grace', async (req, reply) => reply.code(201).send(b.proposeGrace(requireUser(req), parse(z.object({ module: z.enum(['76', '81']), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate, 'date inexistante au calendrier'), motif }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/rakapay/periode-grace/:id/decision', async (req) => b.decideGrace(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
}
