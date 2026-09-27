/**
 * Module d'extension « terrain » : sous-traitance terrain, agents et badges vérifiables, missions,
 * constats scellés géolocalisés, contrôle qualité indépendant, contrôles mystère (§ 15, § 15A ; H.8).
 * Aucune fonction d'encaissement : le module ne manipule jamais d'argent.
 * Contrôle qualité renforcé (§ 15A.5, § 15A.7) : doublons, objets présumés fictifs, rotation des zones, récupération
 * des sommes versées (décision à deux personnes, puis ordre du Trésor à quatre yeux).
 */
import type { TresorService } from '../tresor/service.js';
import { definePlugin } from '../types.js';
import { declareTerrainPolicies } from './policy.js';
import { TerrainQualityService } from './qualite-fraude.js';
import { registerTerrainQualityRoutes } from './routes-qualite.js';
import { registerTerrainRoutes } from './routes.js';
import { TerrainService } from './service.js';
import { InspectionService } from './inspection.js';
import { registerInspectionRoutes } from './routes-inspection.js';

export const terrainPlugin = definePlugin<TerrainService>({
  name: 'terrain',
  create: (ctx) => {
    declareTerrainPolicies();
    const svc = new TerrainService(ctx);
    svc.qualite = new TerrainQualityService(ctx, svc);
    const tresor = ctx.ext.tresor as TresorService | undefined;
    if (tresor) svc.qualite.attachTreasury(tresor);
    // Inspection et constat (module 35) : dossiers préparés, paquet hors ligne, procès-verbaux selon les pouvoirs.
    svc.inspection = new InspectionService(ctx, svc);
    return svc;
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => {
    registerTerrainRoutes(app, ctx, svc);
    registerTerrainQualityRoutes(app, svc.qualite!);
    registerInspectionRoutes(app, svc.inspection!);
  },
});

export { TerrainService } from './service.js';
