/**
 * Module d'extension « catalogue-api » : routes françaises du catalogue des API (Cahier, chapitre 31), relais réels
 * vers les routes canoniques existantes (inchangées). Aucune donnée propre, aucune règle métier dupliquée.
 */
import { definePlugin } from '../types.js';
import { CATALOGUE_API, type CatalogueApiRow } from './catalogue.js';
import { registerCatalogueApiRoutes } from './routes.js';

export interface CatalogueApiService {
  routes: readonly CatalogueApiRow[];
}

export const catalogueApiPlugin = definePlugin<CatalogueApiService>({
  name: 'catalogueApi',
  create: () => ({ routes: CATALOGUE_API }),
  routes: (app, ctx) => registerCatalogueApiRoutes(app, ctx),
});
