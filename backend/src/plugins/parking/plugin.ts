/** Verticale MOSOLO Parking (ParkSmart, § 11A) : zones, sessions liées à la plaque, réservations, contrôle, constats RW1. */
import { definePlugin } from '../types.js';
import { declareParkingPolicies } from './policy.js';
import { registerParkingRoutes } from './routes.js';
import { seedParking } from './seed.js';
import { ParkingService } from './service.js';
import { pricingSchedulerEnabled } from './tarification-dynamique.js';

export const parkingPlugin = definePlugin<ParkingService>({
  name: 'parking',
  create: (ctx) => {
    declareParkingPolicies();
    const svc = new ParkingService(ctx);
    // Abonnements, pré-réservation premium et titres événement : types du moteur de titres (§ 19A), s'il est chargé.
    svc.smart.defineTitleTypes();
    // Module 75 : tarification dynamique automatique dans les fourchettes de l'acte (planificateur horaire).
    if (pricingSchedulerEnabled(process.env)) svc.tarification.startScheduler();
    return svc;
  },
  seed: (ctx, svc) => seedParking(ctx, svc),
  routes: (app, ctx, svc) => {
    registerParkingRoutes(app, ctx, svc);
    app.addHook('onClose', async () => svc.tarification.stopScheduler());
  },
});
