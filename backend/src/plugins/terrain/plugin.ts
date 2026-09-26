/**
 * Module d'extension « terrain » : sous-traitance terrain, agents et badges vérifiables, missions,
 * constats scellés géolocalisés, contrôle qualité indépendant, contrôles mystère (§ 15, § 15A ; H.8).
 * Aucune fonction d'encaissement : le module ne manipule jamais d'argent.
 */
import { definePlugin } from '../types.js';
import { declareTerrainPolicies } from './policy.js';
import { registerTerrainRoutes } from './routes.js';
import { TerrainService } from './service.js';

export const terrainPlugin = definePlugin<TerrainService>({
  name: 'terrain',
  create: (ctx) => {
    declareTerrainPolicies();
    return new TerrainService(ctx);
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => registerTerrainRoutes(app, ctx, svc),
});

export { TerrainService } from './service.js';
