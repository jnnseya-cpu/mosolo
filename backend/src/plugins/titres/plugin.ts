/**
 * Plugin « titres » : moteur générique de titres et de contrôle (modules 70, 71).
 * Les modules émetteurs (RakaPay, stationnement, marchés…) déclarent leurs types et appellent `purchase`.
 */
import { definePlugin } from '../types.js';
import { registerTitresRoutes } from './routes.js';
import { TitresService } from './service.js';

export const titresPlugin = definePlugin<TitresService>({
  name: 'titres',
  create: (ctx) => new TitresService(ctx),
  routes: (app, ctx, svc) => registerTitresRoutes(app, ctx, svc),
});

export { TitresService } from './service.js';
export type * from './model.js';
