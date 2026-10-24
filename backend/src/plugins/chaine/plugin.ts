/**
 * Module d'extension « chaine » : sept questions par objet et par obligation, chaîne opératoire en treize maillons
 * (Cahier v2.9 § 3) et contrôle des invariants « aucun maillon sauté ». Lecture seule sur les dépôts du socle et des
 * modules fiscal, recouvrement, terrain et pilotage ; alertes vers l'anti-fraude, la sécurité et l'audit interne.
 */
import { definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { registerChaineRoutes } from './routes.js';
import { ChaineService } from './service.js';

const { always } = GRANTS;

// Contrôle des ruptures de chaîne : audit interne et externe, anti-fraude, sécurité (lecture et détection seulement).
definePolicy('chaine:ruptures.read', { R22: always, R23: always, R24: always, R28: always });

export const chainePlugin = definePlugin<ChaineService>({
  name: 'chaine',
  create: (ctx) => new ChaineService(ctx),
  routes: (app, ctx, svc) => registerChaineRoutes(app, ctx, svc),
});
