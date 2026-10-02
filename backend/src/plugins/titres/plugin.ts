/**
 * Plugin « titres » : moteur générique de titres et de contrôle (modules 70, 71).
 * Les modules émetteurs (RakaPay, stationnement, marchés…) déclarent leurs types et appellent `purchase`.
 */
import { definePlugin } from '../types.js';
import { registerTitresRoutes } from './routes.js';
import { TitresService } from './service.js';
import { defineActeRequisTypes } from './catalogue.js';
import { contribuerCompteUnique } from './compte-unique.js';

export const titresPlugin = definePlugin<TitresService>({
  name: 'titres',
  create: (ctx) => {
    const svc = new TitresService(ctx);
    // Catalogue § 19A.4 : types amorcés au statut ACTE_REQUIS (visibles, non activables).
    defineActeRequisTypes(svc);
    // Compte unique (ch. 9) : titres, pass et tickets du titulaire.
    contribuerCompteUnique(ctx, svc);
    return svc;
  },
  routes: (app, ctx, svc) => registerTitresRoutes(app, ctx, svc),
});

export { TitresService } from './service.js';
export type * from './model.js';
