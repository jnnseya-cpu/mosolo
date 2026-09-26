/**
 * Plugin « rakapay » : billetterie urbaine multi-opérateurs (module 76) et pass des moto-taxis wewa (module 81).
 * Dépend du plugin « titres » (à charger AVANT).
 */
import { definePlugin } from '../types.js';
import { registerRakaPayRoutes } from './routes.js';
import { seedRakaPay } from './seed.js';
import { RakaPayService } from './service.js';

export const rakapayPlugin = definePlugin<RakaPayService>({
  name: 'rakapay',
  create: (ctx) => new RakaPayService(ctx),
  seed: (ctx, svc) => seedRakaPay(ctx, svc),
  routes: (app, ctx, svc) => registerRakaPayRoutes(app, ctx, svc),
});

export { RakaPayService } from './service.js';
