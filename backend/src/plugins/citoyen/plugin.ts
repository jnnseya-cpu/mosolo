/**
 * Module d'extension « citoyen » — modules 1 à 12 de la Spécification fonctionnelle : application Android et iOS
 * (module 4), portail web public (5), compléments USSD et SMS (6), relations (7), cadastre géospatial (8), intelligence
 * locative (9), activités et patentes (10), véhicules (11), autorisations de transport (12) et indicateurs de
 * chacun des douze modules. Réutilise les circuits communs (compte unique, registre des règles, titres, verticales).
 */
import { definePlugin } from '../types.js';
import { registerCitoyenRoutes } from './routes.js';
import { CitoyenService } from './service.js';

export const citoyenPlugin = definePlugin<CitoyenService>({
  name: 'citoyen',
  create: (ctx) => new CitoyenService(ctx),
  routes: (app, ctx, svc) => registerCitoyenRoutes(app, ctx, svc),
});

export { CitoyenService };
