/**
 * Module d'extension « vehicules-controle » — chaîne véhicule de la RFCK (Cahier, chapitre 18) :
 * 82. Contrôle technique et vignette sécurisée ; 83. Fourrières, enlèvement et gardiennage ;
 * 84. Centres agréés et tiers de confiance (n° 59–61 dans le catalogue du maître d'ouvrage du 27/09/2026).
 * Chargé après « titres » et « fiscal » (il relit la vignette, la taxe, les licences et le quitus) et avant
 * « preuves » et « chaine ».
 */
import { definePlugin } from '../types.js';
import { declareVehiculesPolicies } from './policy.js';
import { registerVehiculesRoutes } from './routes.js';
import { seedVehicules } from './seed.js';
import { VehiculesControleService } from './service.js';

export { VehiculesControleService } from './service.js';

export const vehiculesControlePlugin = definePlugin<VehiculesControleService>({
  name: 'vehicules-controle',
  create: (ctx) => {
    declareVehiculesPolicies();
    const svc = new VehiculesControleService(ctx);
    svc.hookTitres();
    return svc;
  },
  seed: (ctx, svc) => seedVehicules(ctx, svc),
  routes: (app, _ctx, svc) => registerVehiculesRoutes(app, svc),
});
