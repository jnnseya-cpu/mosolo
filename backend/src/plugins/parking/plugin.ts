/** Verticale MOSOLO Parking (ParkSmart, § 11A) : zones, sessions liées à la plaque, réservations, contrôle, constats RW1. */
import { definePlugin } from '../types.js';
import { declareParkingPolicies } from './policy.js';
import { registerParkingRoutes } from './routes.js';
import { seedParking } from './seed.js';
import { ParkingService } from './service.js';

export const parkingPlugin = definePlugin<ParkingService>({
  name: 'parking',
  create: (ctx) => {
    declareParkingPolicies();
    return new ParkingService(ctx);
  },
  seed: (ctx, svc) => seedParking(ctx, svc),
  routes: (app, ctx, svc) => registerParkingRoutes(app, ctx, svc),
});
