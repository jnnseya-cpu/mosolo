/** Verticale MOSOLO Advertising (KIN PUB CONTROL, § 11B) : inventaire, autorisations, inspections et dossiers RW1. */
import { definePlugin } from '../types.js';
import { declarePublicitePolicies } from './policy.js';
import { registerPubliciteRoutes } from './routes.js';
import { seedPublicite } from './seed.js';
import { PubliciteService } from './service.js';
import { contribuerCompteUnique } from './compte-unique.js';

export const publicitePlugin = definePlugin<PubliciteService>({
  name: 'publicite',
  create: (ctx) => {
    declarePublicitePolicies();
    const svc = new PubliciteService(ctx);
    // Compte unique (ch. 9) : enseignes et autorisations de l'annonceur.
    contribuerCompteUnique(ctx, svc);
    return svc;
  },
  seed: (ctx, svc) => seedPublicite(ctx, svc),
  routes: (app, ctx, svc) => registerPubliciteRoutes(app, ctx, svc),
});
