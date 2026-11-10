/**
 * Module d'extension « Intégrité » : ligne de signalement protégée (SMS, SVI, numéro gratuit, web ; anonymat possible),
 * détection explicable (alertes, jamais de sanction), dossiers d'enquête avec séparation enquêteur / décideur,
 * contrôles mystère, incidents de sécurité, protection des données (DPO) et revue périodique des accès.
 */
import { definePlugin } from '../types.js';
import { declareIntegritePolicies } from './policy.js';
import { registerIntegriteRoutes } from './routes.js';
import { seedIntegrite } from './seed.js';
import { IntegriteService } from './service.js';

export const integritePlugin = definePlugin<IntegriteService>({
  name: 'integrite',
  create: (ctx) => {
    declareIntegritePolicies();
    return new IntegriteService(ctx);
  },
  seed: (ctx, svc) => seedIntegrite(ctx, svc),
  routes: (app, ctx, svc) => registerIntegriteRoutes(app, ctx, svc),
});

export { IntegriteService } from './service.js';
