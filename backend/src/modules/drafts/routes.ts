import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';

const draftSchema = z.object({ data: z.record(z.unknown()) }).strict();

export function registerDraftRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.put<{ Params: { key: string } }>('/v1/drafts/:key', async (req) => {
    const user = requireUser(req);
    authorize(user, 'draft.write');
    const { data } = parse(draftSchema, req.body);
    const v = ctx.drafts.save(user, req.params.key, data);
    return { key: v.key, version: v.version, savedAt: v.savedAt, changeSummary: v.changeSummary, changes: v.changes };
  });

  // `?siAbsent=vide` (ajout 27/09/2026) : un brouillon absent répond 200 `{ draft: null }` au lieu de 404, pour que la
  // restauration automatique d'un formulaire neuf ne produise pas d'erreur réseau. Sans ce paramètre : 404 inchangé.
  app.get<{ Params: { key: string }; Querystring: { siAbsent?: string } }>('/v1/drafts/:key', async (req) => {
    const user = requireUser(req);
    try {
      return ctx.drafts.latest(user, req.params.key);
    } catch (e) {
      if (req.query.siAbsent === 'vide' && (e as { code?: string }).code === 'DRAFT_NOT_FOUND') return { draft: null };
      throw e;
    }
  });

  app.get<{ Params: { key: string } }>('/v1/drafts/:key/versions', async (req) => ctx.drafts.history(requireUser(req), req.params.key));
}
