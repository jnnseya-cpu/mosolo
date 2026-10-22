/**
 * Module d'extension « apprentissage » : apprentissage des utilisateurs et environnement de travail (Cahier § 24).
 * Micro-apprentissage contextuel intégré au poste, certification par public, compréhension des contribuables,
 * garde de confidentialité (actes professionnels seulement). Semé AVANT « terrain » : les certificats de
 * démonstration existent quand les agents de démonstration sont habilités.
 */
import { definePlugin } from '../types.js';
import { declareApprentissagePolicies } from './policy.js';
import { registerApprentissageRoutes } from './routes.js';
import { seedApprentissage } from './seed.js';
import { ApprentissageService } from './service.js';

export const apprentissagePlugin = definePlugin<ApprentissageService>({
  name: 'apprentissage',
  create: (ctx) => {
    declareApprentissagePolicies();
    return new ApprentissageService(ctx);
  },
  seed: (ctx, svc) => seedApprentissage(ctx, svc),
  routes: (app, _ctx, svc) => registerApprentissageRoutes(app, svc),
});

export { ApprentissageService } from './service.js';
export { certificationValide } from './garde.js';
