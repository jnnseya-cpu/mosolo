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

  app.get<{ Params: { key: string } }>('/v1/drafts/:key', async (req) => ctx.drafts.latest(requireUser(req), req.params.key));

  app.get<{ Params: { key: string } }>('/v1/drafts/:key/versions', async (req) => ctx.drafts.history(requireUser(req), req.params.key));
}
