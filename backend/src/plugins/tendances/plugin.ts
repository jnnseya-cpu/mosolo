/**
 * Module d'extension « tendances » (10/11/2026) : Veille des tendances (Trend Intelligence). Voir model.ts (doctrine,
 * paramètres, rôles), scoring.ts (calculs), contrat.ts (Growth Brief v1) et service.ts. Correspondance avec les routes
 * de la spécification v2.3 : trend-intelligence/README.md.
 */
import { z } from 'zod';
import type { RoleCode } from '@mosolo/shared';
import { requireUser } from '../../core/auth.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { parse } from '../../core/http.js';
import { definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { CANAUX } from './contrat.js';
import { APPROBATEURS, AUTOMATISEURS, DEPOSANTS, EXPLOITANTS, GELEURS, LECTEURS, PROPOSANTS } from './model.js';
import { TendancesService } from './service.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
definePolicy('tendances:read', g(LECTEURS));
definePolicy('tendances:propose', g(PROPOSANTS));
definePolicy('tendances:approve', g(APPROBATEURS));
definePolicy('tendances:freeze', g(GELEURS));
definePolicy('tendances:automate', g(AUTOMATISEURS));
definePolicy('tendances:work', g(EXPLOITANTS));
definePolicy('tendances:ingest', g(DEPOSANTS));

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(1000);
const iso = z.string().datetime();
const observation = z.object({
  sourceId: z.string().min(1).max(80), recordId: z.string().min(1).max(200), revision: z.number().int().min(1).max(1_000_000).optional(),
  observeLe: iso, debut: iso, fin: iso, marche: z.string().regex(/^[A-Z]{2}$/).optional(), locale: z.string().min(2).max(35).optional(),
  texte: z.string().trim().min(1).max(500), metrique: z.string().max(60).optional(), valeur: z.number().min(0).max(1e12),
  unite: z.string().max(40).optional(), couverture: z.number().min(0).max(1).optional(),
}).strict();
const lotSchema = z.object({ observations: z.array(observation).min(1).max(500) }).strict();
const sujet = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), libelle: z.string().trim().min(1).max(120), alias: z.array(z.string().trim().min(1).max(80)).max(50),
  adequation: z.number().min(0).max(100), intention: z.number().min(0).max(100), pret: z.boolean(), classe: z.enum(['PERSISTANT', 'SOUDAIN']),
  audience: z.string().trim().min(1).max(500), intentionTexte: z.string().trim().min(1).max(500), claims: z.array(z.string().max(128)).max(64), cta: z.string().max(128),
  assetId: z.string().max(128).nullable(),
}).strict();
const profilSchema = z.object({
  marche: z.string().regex(/^[A-Z]{2}$/), locale: z.string().min(2).max(35), fuseau: z.string().min(1).max(60),
  canaux: z.array(z.enum(CANAUX)).min(1).max(6), assets: z.array(z.string().max(128)).max(200),
  claims: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), texte: z.string().trim().min(1).max(500), source: z.string().trim().min(1).max(200) }).strict()).max(200),
  ctas: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), libelle: z.string().trim().min(1).max(40), cible: z.string().regex(/^\/[A-Za-z0-9/_?=&.-]*$/, 'adresse interne seulement') }).strict()).max(50),
  sujets: z.array(sujet).max(200), interdits: z.array(z.string().trim().min(1).max(500)).max(32),
  resultat: z.object({ conversion: z.string().trim().min(1).max(120), denominateur: z.string().trim().min(1).max(120) }).strict(),
  qualiteFamilles: z.record(z.string().max(60), z.number().min(0).max(100)),
}).strict();
const champsPage = z.object({ titre: z.string().trim().min(1).max(70), description: z.string().trim().min(1).max(160), accroche: z.string().trim().min(1).max(120), ctaLibelle: z.string().trim().min(1).max(40), bloc: z.string().trim().min(1).max(2000), ctaCible: z.string().regex(/^\/[A-Za-z0-9/_?=&.-]*$/) }).strict();
const pageSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), slug: z.string(), sujet: z.string().max(128), champs: champsPage }).strict();
const gelSchema = z.object({ actif: z.boolean(), motif }).strict();
const motifSchema = z.object({ motif }).strict();
const exportSchema = z.object({ destination: z.string().trim().min(3).max(200) }).strict();
const evenementSchema = z.object({ evenement: z.enum(['VISITE', 'CTA']), revision: z.number().int().min(1).optional() }).strict();
const effectifSchema = z.object({ marche: z.string().regex(/^[A-Z]{2}$/), locale: z.string().min(2).max(35), sujet: z.string().min(1).max(128), canal: z.enum(CANAUX) }).strict();

const entier = (v: unknown) => { const s = Array.isArray(v) ? v[0] : v; const n = typeof s === 'string' ? Number(s.replace(/"/g, '')) : NaN; return Number.isInteger(n) ? n : undefined; };

type P = { Params: { inst: string; id: string } };

/** Cycle automatique : actif par défaut hors tests ; `MOSOLO_TENDANCES_AUTO=off` le coupe, `on` le force. */
export function cycleAutomatiqueActif(env: NodeJS.ProcessEnv): boolean {
  const v = (env.MOSOLO_TENDANCES_AUTO ?? '').trim().toLowerCase();
  if (v === 'off') return false;
  if (v === 'on') return true;
  return !env.VITEST;
}
export const tendancesPlugin = definePlugin<TendancesService>({
  name: 'tendances',
  create: (ctx) => new TendancesService(ctx),
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => {
    // Fonctionnement en arrière-plan (invisible) : cycle horaire, premier passage peu après le démarrage.
    if (cycleAutomatiqueActif(process.env)) {
      svc.startScheduler();
      const premier = setTimeout(() => { void svc.cycleAutomatique().catch(() => undefined); }, 5_000);
      premier.unref?.();
      app.addHook('onClose', async () => { clearTimeout(premier); svc.stopScheduler(); });
    }
    app.get('/v1/tendances', async (req) => svc.etat(requireUser(req)));
    app.put<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/profil', async (req, reply) => {
      const garde = { siRevision: entier(req.headers['if-match']), siAucun: req.headers['if-none-match'] === '*' };
      return reply.code(201).send(svc.enregistrerProfil(requireUser(req), req.params.inst, parse(profilSchema, req.body), garde));
    });
    app.get<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/profil', async (req) => svc.lireProfil(requireUser(req), req.params.inst));
    app.post<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/observations/lot', async (req, reply) => {
      const user = requireUser(req);
      const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
      const body = parse(lotSchema, req.body);
      const res = ctx.idempotency.execute(`tendances:obs:${req.params.inst}:${user.id}`, key, body, () => ({ statusCode: 202, body: svc.deposer(user, req.params.inst, body.observations) }));
      if (res.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(res.statusCode).send(res.body);
    });
    app.post<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/collecte', async (req, reply) => reply.code(202).send(svc.collecter(requireUser(req), req.params.inst)));
    app.post<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/calcul', async (req, reply) => reply.code(202).send(svc.calculer(requireUser(req), req.params.inst)));
    app.get<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/opportunites', async (req) => svc.listeOpportunites(requireUser(req), req.params.inst));
    app.post<P>('/v1/tendances/installations/:inst/opportunites/:id/brief', async (req, reply) => reply.code(201).send(svc.creerBrief(requireUser(req), req.params.inst, req.params.id)));
    app.get<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/briefs', async (req) => svc.listeBriefs(requireUser(req), req.params.inst));
    app.get<{ Params: { inst: string }; Querystring: Record<string, string> }>('/v1/tendances/installations/:inst/brief-effectif', async (req, reply) => {
      const r = svc.briefEffectif(requireUser(req), req.params.inst, parse(effectifSchema, req.query));
      return r ? r : reply.code(204).send();
    });
    app.post<P>('/v1/tendances/installations/:inst/briefs/:id/approbation', async (req) => svc.approuverBrief(requireUser(req), req.params.inst, req.params.id, entier(req.headers['if-match'])));
    app.post<P>('/v1/tendances/installations/:inst/briefs/:id/revocation', async (req) => svc.revoquerBrief(requireUser(req), req.params.inst, req.params.id, parse(motifSchema, req.body).motif));
    app.post<P>('/v1/tendances/installations/:inst/briefs/:id/generation', async (req, reply) => reply.code(201).send(await svc.generer(requireUser(req), req.params.inst, req.params.id)));
    app.get<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/actions', async (req) => svc.listeActions(requireUser(req), req.params.inst));
    app.get<P>('/v1/tendances/installations/:inst/actions/:id', async (req) => svc.action(requireUser(req), req.params.inst, req.params.id));
    app.post<P>('/v1/tendances/installations/:inst/actions/:id/approbation', async (req) => svc.approuverAction(requireUser(req), req.params.inst, req.params.id));
    app.post<P>('/v1/tendances/installations/:inst/actions/:id/retour', async (req) => svc.retablir(requireUser(req), req.params.inst, req.params.id, parse(motifSchema, req.body).motif));
    app.post<P>('/v1/tendances/installations/:inst/actions/:id/export', async (req) => svc.exporter(requireUser(req), req.params.inst, req.params.id, parse(exportSchema, req.body).destination));
    app.get<P>('/v1/tendances/installations/:inst/actions/:id/mesure', async (req) => svc.mesure(requireUser(req), req.params.inst, req.params.id));
    app.post<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/automatique', async (req) => { const b = parse(gelSchema, req.body); return svc.automatiser(requireUser(req), req.params.inst, b.actif, b.motif); });
    app.post<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/gel', async (req) => { const b = parse(gelSchema, req.body); return svc.geler(requireUser(req), req.params.inst, b.actif, b.motif); });
    app.get<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/pages', async (req) => svc.listePages(requireUser(req), req.params.inst));
    app.post<{ Params: { inst: string } }>('/v1/tendances/installations/:inst/pages', async (req, reply) => reply.code(201).send(svc.creerPage(requireUser(req), req.params.inst, parse(pageSchema, req.body))));
    app.post<P>('/v1/tendances/installations/:inst/pages/:id/approbation', async (req) => svc.approuverPage(requireUser(req), req.params.inst, req.params.id));
    app.post('/v1/tendances/travaux', async (req) => ({ items: svc.traiterTravaux(requireUser(req)) }));
    // Public : page propre (révision active seulement) et mesure agrégée (aucun identifiant de visiteur).
    app.get<{ Params: { slug: string } }>('/v1/public/tendances/pages/:slug', async (req) => svc.pagePublique(req.params.slug));
    app.post<{ Params: { slug: string } }>('/v1/public/tendances/pages/:slug/evenements', async (req, reply) => { const b = parse(evenementSchema, req.body); return reply.code(202).send(svc.evenementPublic(req.params.slug, b.evenement, b.revision)); });
  },
});
