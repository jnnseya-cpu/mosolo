/** Routes HTTP du pilotage. Toute route interne exige un utilisateur et une autorisation ; la transparence est publique. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { canonicalJson } from '../../core/crypto.js';
import { isoDateString, parse } from '../../core/http.js';
import { PAYMENT_CHANNELS } from '../../modules/payments/service.js';
import { DRILL_DIMENSIONS, type DrillDimension } from './ladder.js';
import type { PilotageService } from './service.js';

const querySchema = z.object({
  commune: z.string().trim().min(1).max(64).optional(),
  category: z.string().trim().regex(/^[A-Z_]{2,40}$/, 'code de catégorie attendu').optional(),
  entity: z.string().trim().regex(/^[A-Z0-9_-]{2,40}$/, 'code d’administration attendu').optional(),
  channel: z.enum(PAYMENT_CHANNELS).optional(),
  period: z.string().trim().regex(/^\d{4}(-(0[1-9]|1[0-2])|-[TQ][1-4])?$/, 'AAAA, AAAA-MM ou AAAA-Tn attendu').optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  dimension: z.enum(DRILL_DIMENSIONS).optional(),
  ref: z.string().trim().min(3).max(80).optional(),
  months: z.coerce.number().int().min(1).max(36).optional(),
  format: z.enum(['csv', 'json', 'bundle']).optional(),
  lang: z.string().optional(),
}).strict();

const periodSchema = z.string().regex(/^\d{4}-[TQ][1-4]$/, 'trimestre AAAA-Tn attendu');
const publishSchema = z.object({ motif: z.string().trim().min(10).max(1000) }).strict();
const verifySchema = z.object({
  payload: z.string().min(1).max(10_000_000).optional(),
  data: z.unknown().optional(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^[0-9a-fA-F]{64}$/),
}).strict();

export function registerPilotageRoutes(app: FastifyInstance, _ctx: AppContext, svc: PilotageService): void {
  const q = (raw: unknown) => {
    const { dimension: _d, ref: _r, months: _m, format: _f, lang: _l, ...rest } = parse(querySchema, raw);
    return rest;
  };

  app.get('/v1/pilotage/echelle', async (req) => svc.ladder(requireUser(req), q(req.query)));
  app.get('/v1/pilotage/indicateurs', async (req) => svc.kpis(requireUser(req), q(req.query)));
  app.get('/v1/pilotage/serie', async (req) => {
    const all = parse(querySchema, req.query);
    return svc.series(requireUser(req), q(req.query), all.months ?? 12);
  });
  app.get<{ Params: { dimension: string } }>('/v1/pilotage/drill/:dimension', async (req) => {
    const user = requireUser(req);
    if (req.params.dimension === 'paiements') return svc.payments(user, q(req.query));
    const dim = parse(z.enum(DRILL_DIMENSIONS), req.params.dimension) as DrillDimension;
    return svc.drill(user, dim, q(req.query));
  });

  // Réductions de recettes (fuites) et recettes potentielles non liquidées.
  app.get('/v1/pilotage/reductions', async (req) => svc.reductions(requireUser(req), q(req.query)));
  app.post('/v1/pilotage/reductions/detection', async (req) => {
    const r = svc.detectReductionSignals(requireUser(req));
    return { raised: r.raised, signals: r.signals, params: r.params, automaticEffect: r.automaticEffect };
  });

  app.get('/v1/pilotage/tableaux', async (req) => ({ profiles: svc.profilesFor(requireUser(req)) }));
  app.get<{ Params: { profil: string } }>('/v1/pilotage/tableaux/:profil', async (req) => svc.profile(requireUser(req), req.params.profil, q(req.query)));
  // Alias du contrat (C3-508) : GET /v1/tableaux/{profil}.
  app.get<{ Params: { profil: string } }>('/v1/tableaux/:profil', async (req) => svc.profile(requireUser(req), req.params.profil, q(req.query)));

  app.get('/v1/pilotage/piste-audit', async (req) => svc.dossiers(requireUser(req)));
  app.get<{ Params: { ref: string } }>('/v1/pilotage/piste-audit/:ref', async (req) => svc.auditTrail(requireUser(req), req.params.ref));

  app.get<{ Params: { kind: string } }>('/v1/pilotage/exports/:kind', async (req, reply) => {
    const user = requireUser(req);
    const all = parse(querySchema, req.query);
    const res = svc.export(user, req.params.kind, { ...q(req.query), ...(all.dimension ? { dimension: all.dimension } : {}), ...(all.ref ? { ref: all.ref } : {}) });
    if (all.format === 'csv' || all.format === 'json') {
      const part = all.format === 'csv' ? res.csv : res.json;
      return reply
        .header('content-type', all.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${part.filename}"`)
        .header('x-mosolo-export-id', res.exportId)
        .header('x-mosolo-sha256', part.manifest.sha256)
        .header('x-mosolo-signature', part.manifest.signature)
        .header('x-mosolo-key-id', part.manifest.keyId)
        .send(part.content);
    }
    return res;
  });
  // Vérification d'un export reçu : publique (n'expose aucun contenu, seulement l'authenticité).
  app.post('/v1/pilotage/exports/verify', async (req) => {
    const b = parse(verifySchema, req.body);
    const payload = b.payload ?? (b.data !== undefined ? canonicalJson(b.data) : '');
    return svc.verifyExport(payload, b.sha256, b.signature);
  });

  app.get<{ Params: { period: string } }>('/v1/pilotage/transparence/:period', async (req) => svc.transparencyPreview(requireUser(req), parse(periodSchema, req.params.period)));
  app.post<{ Params: { period: string } }>('/v1/pilotage/transparence/:period/publier', async (req, reply) => {
    const user = requireUser(req);
    const { motif } = parse(publishSchema, req.body);
    return reply.code(201).send(svc.publishTransparency(user, parse(periodSchema, req.params.period), motif));
  });

  // Transparence publique : sans authentification, sans aucune donnée personnelle.
  app.get('/v1/public/transparency', async () => svc.publicIndex());
  app.get<{ Params: { period: string } }>('/v1/public/transparency/:period', async (req) => svc.publicPeriod(parse(periodSchema, req.params.period)));
}
