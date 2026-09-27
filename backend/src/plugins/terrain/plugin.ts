/**
 * Module d'extension « terrain » : sous-traitance terrain, agents et badges vérifiables, missions,
 * constats scellés géolocalisés, contrôle qualité indépendant, contrôles mystère (§ 15, § 15A ; H.8).
 * Aucune fonction d'encaissement : le module ne manipule jamais d'argent.
 * Contrôle qualité renforcé (§ 15A.5, § 15A.7) : doublons, objets présumés fictifs, rotation des zones, récupération
 * des sommes versées (décision à deux personnes, puis ordre du Trésor à quatre yeux).
 */
import type { TresorService } from '../tresor/service.js';
import { definePlugin } from '../types.js';
import { ResultPointsService, registerResultPointsRoutes } from './points-resultats.js';
import { declareTerrainPolicies } from './policy.js';
import { TerrainQualityService } from './qualite-fraude.js';
import { registerTerrainQualityRoutes } from './routes-qualite.js';
import { registerTerrainRoutes } from './routes.js';
import { TerrainService } from './service.js';

export const terrainPlugin = definePlugin<TerrainService>({
  name: 'terrain',
  create: (ctx) => {
    declareTerrainPolicies();
    const svc = new TerrainService(ctx);
    svc.qualite = new TerrainQualityService(ctx, svc);
    const tresor = ctx.ext.tresor as TresorService | undefined;
    if (tresor) svc.qualite.attachTreasury(tresor);
    return svc;
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => {
    registerTerrainRoutes(app, ctx, svc);
    registerTerrainQualityRoutes(app, svc.qualite!);
    // Module 67 : rémunération par points de résultats vérifiés (§ 37A.5), quote-part indicative de la réserve.
    registerResultPointsRoutes(app, new ResultPointsService(ctx, svc));
  },
});

export { TerrainService } from './service.js';
