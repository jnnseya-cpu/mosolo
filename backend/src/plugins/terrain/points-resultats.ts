/**
 * Portail des partenaires et équipes terrain (module 67) — rémunération par POINTS DE RÉSULTATS VÉRIFIÉS (§ 37A.5).
 *
 * Vue « sous-traitants et équipes » de la réserve des agents (sanctions/reserve-agents.ts, décision du maître d'ouvrage
 * du 27/09/2026) : objets confirmés après contrôle qualité, enrôlements valides, régularisations confirmées par
 * quittance définitive, pondérés par la note de qualité ; quote-part de la réserve de 10 % par module, jamais selon le
 * montant liquidé. Un sous-traitant (R35) ne voit que sa structure. Aucun versement ici ; zéro espèce.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import type { SanctionsService } from '../sanctions/service.js';
import { TERRAIN_ACTIONS as A } from './policy.js';
import type { TerrainService } from './service.js';

export class ResultPointsService {
  constructor(private readonly ctx: AppContext, private readonly terrain: TerrainService) {}

  compute(u: User, period?: string) {
    authorize(u, A.remunerationRead);
    const month = period ?? kinshasaDate(this.ctx.clock.now()).slice(0, 7);
    const reserve = (this.ctx.ext.sanctions as SanctionsService | undefined)?.reserve;
    const scoped = this.terrain.subcontractorScope(u);
    if (!reserve) {
      return { period: month, available: false as const, notice: 'Réserve des agents non chargée (module « sanctions ») : points non calculés.', subcontractors: [], teams: [], agents: [], cashHandled: false };
    }
    // Sous-traitant : sa structure seulement (null : aucune structure rattachée → rien).
    if (scoped === null) return { period: month, available: true as const, notice: 'Aucune structure sous-traitante rattachée à ce compte.', subcontractors: [], teams: [], agents: [], cashHandled: false };
    const c = scoped ? reserve.forSubcontractor(scoped.id, month) : reserve.compute(month);
    return {
      period: month, available: true as const, notice: c.notice, mode: c.mode, weights: c.weights, rules: c.rules,
      subcontractors: c.subcontractors, teams: c.teams, agents: c.agents, modules: c.modules, points: c.points, clawbacks: c.clawbacks,
      cashHandled: false,
    };
  }
}

export function registerResultPointsRoutes(app: FastifyInstance, svc: ResultPointsService): void {
  app.get('/v1/terrain/points-resultats', async (req) => {
    const q = parse(z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'mois AAAA-MM attendu').optional() }).strict(), req.query);
    return svc.compute(requireUser(req), q.period);
  });
}
