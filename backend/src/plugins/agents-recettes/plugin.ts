/**
 * Module d'extension « agents-recettes » (01/10/2026) : agents IA de recettes — élargir l'assiette, faciliter le
 * paiement, arrêter les fuites, recouvrer intelligemment, mesurer avant de changer un tarif, garder la confiance de la
 * population, guider les agents de terrain. Voir model.ts (doctrine, catalogue, paramètres) et service.ts.
 */
import { z } from 'zod';
import type { RoleCode } from '@mosolo/shared';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { DECIDEURS, DOLEANCE_CATEGORIES, IMPORTATEURS, LANCEURS, LECTEURS, SOURCES, TERRAIN, TRAITEURS_DOLEANCES, VALIDATEURS_SOURCE, type DoleanceCategorie, type SourceKind } from './model.js';
import { AgentsRecettesService } from './service.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
definePolicy('agents-recettes:read', g(LECTEURS));
definePolicy('agents-recettes:run', g(LANCEURS));
definePolicy('agents-recettes:decide', g(DECIDEURS));
definePolicy('agents-recettes:source.deposer', g(IMPORTATEURS));
definePolicy('agents-recettes:source.valider', g(VALIDATEURS_SOURCE));
definePolicy('agents-recettes:tournee', g(TERRAIN));
definePolicy('agents-recettes:doleance.deposer', { R30: always, R31: always });
definePolicy('agents-recettes:doleance.traiter', g(TRAITEURS_DOLEANCES));

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const ligne = z.object({
  ref: z.string().trim().min(1).max(80), lat: z.number().min(-90).max(90).optional(), lon: z.number().min(-180).max(180).optional(),
  commune: z.string().trim().max(60).optional(), plaque: z.string().trim().max(20).optional(), categorie: z.string().trim().max(40).optional(),
  operateur: z.string().trim().max(80).optional(), observe: z.number().int().min(0).max(100000).optional(), libelle: z.string().trim().max(160).optional(),
}).strict(); // jamais de nom ni de téléphone : le schéma les refuse
const sourceSchema = z.object({ kind: z.enum(Object.keys(SOURCES) as [SourceKind, ...SourceKind[]]), reference: z.string().trim().min(3).max(200), lignes: z.array(ligne).min(1).max(20000) }).strict();
const decisionSchema = z.object({ accepter: z.boolean(), motif }).strict();
const validationSchema = z.object({ approuver: z.boolean(), motif }).strict();
const regulSchema = z.object({ fenetreJours: z.number().int().min(1).max(365), remisePenalitesPct: z.number().min(0).max(100), devise: z.enum(['CDF', 'USD']) }).strict();
const impactSchema = z.object({ ruleCode: z.string().trim().min(2).max(60), variationPct: z.number().min(-90).max(300) }).strict();
const doleanceSchema = z.object({ commune: z.string().trim().min(2).max(60), categorie: z.enum(Object.keys(DOLEANCE_CATEGORIES) as [DoleanceCategorie, ...DoleanceCategorie[]]), texte: z.string().trim().min(10).max(2000), agentId: z.string().trim().max(80).optional() }).strict();
const reponseSchema = z.object({ texte: z.string().trim().min(10).max(2000) }).strict();

export const agentsRecettesPlugin = definePlugin<AgentsRecettesService>({
  name: 'agentsRecettes',
  create: (ctx) => new AgentsRecettesService(ctx),
  seed: (ctx, svc) => svc.seedDemo(),
  routes: (app, _ctx, svc) => {
    app.get('/v1/agents-recettes', async (req) => svc.catalogue(requireUser(req)));
    app.get('/v1/agents-recettes/equite', async (req) => svc.equite(requireUser(req)));
    app.get('/v1/agents-recettes/humeur', async (req) => svc.humeur(requireUser(req)));
    app.get('/v1/agents-recettes/sources', async (req) => svc.listeSources(requireUser(req)));
    app.post('/v1/agents-recettes/sources', async (req, reply) => reply.code(201).send(svc.deposerSource(requireUser(req), parse(sourceSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/agents-recettes/sources/:id/validation', async (req) => svc.validerSource(requireUser(req), req.params.id, parse(validationSchema, req.body)));
    app.post('/v1/agents-recettes/simulations/regularisation', async (req) => svc.simulerRegularisation(requireUser(req), parse(regulSchema, req.body)));
    app.post('/v1/agents-recettes/simulations/impact-tarif', async (req) => svc.simulerImpact(requireUser(req), parse(impactSchema, req.body)));
    app.get('/v1/agents-recettes/tournee', async (req) => svc.tournee(requireUser(req)));
    app.get('/v1/agents-recettes/doleances', async (req) => svc.listeDoleances(requireUser(req)));
    app.post<{ Params: { id: string } }>('/v1/agents-recettes/doleances/:id/reponse', async (req) => svc.repondreDoleance(requireUser(req), req.params.id, parse(reponseSchema, req.body).texte));
    app.post<{ Params: { id: string } }>('/v1/agents-recettes/propositions/:id/decision', async (req) => svc.decider(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
    app.get<{ Params: { code: string } }>('/v1/agents-recettes/:code', async (req) => svc.liste(requireUser(req), req.params.code.toUpperCase()));
    app.post<{ Params: { code: string } }>('/v1/agents-recettes/:code/lancer', async (req, reply) => reply.code(201).send(svc.lancer(requireUser(req), req.params.code.toUpperCase())));
    // Usagers : doléances (dépôt et suivi) ; public : où va votre argent (agrégats, seuil de 5 contribuables).
    app.post('/v1/doleances', async (req, reply) => reply.code(201).send(svc.deposerDoleance(requireUser(req), parse(doleanceSchema, req.body))));
    app.get('/v1/doleances/miennes', async (req) => svc.mesDoleances(requireUser(req)));
    app.get('/v1/public/ou-va-votre-argent', async () => svc.ouVaArgent());
  },
});
