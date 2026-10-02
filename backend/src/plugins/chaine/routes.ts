/** Routes HTTP de la chaîne opératoire : sept questions (objet, obligation) et contrôle des ruptures. */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import type { ChaineService } from './service.js';

export function registerChaineRoutes(app: FastifyInstance, _ctx: AppContext, svc: ChaineService): void {
  // Sept questions et treize maillons pour un objet fiscal (toutes ses obligations visibles du lecteur).
  app.get<{ Params: { id: string } }>('/v1/objects/:id/sept-questions', async (req) => svc.objectView(requireUser(req), req.params.id));
  // Chaîne d'une obligation (mêmes habilitations que GET /v1/obligations/:id).
  app.get<{ Params: { id: string } }>('/v1/obligations/:id/chaine', async (req) => svc.obligationView(requireUser(req), req.params.id));
  // Invariants « aucun maillon sauté » : détection, alertes (une par rupture), aucun effet automatique.
  app.get('/v1/integrite/chaine/ruptures', async (req) => svc.ruptures(requireUser(req)));
}
