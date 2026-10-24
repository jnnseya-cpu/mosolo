/**
 * Module d'extension « grands-redevables » (module 56) : portefeuille dédié, gestionnaire dédié et rotation,
 * conventions par redevable (déclaration et rapprochement), journal des décisions tracées. Voir grands-redevables.ts.
 */
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { isoDateString, parse } from '../../core/http.js';
import { definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { GrandsRedevablesService, PERIODICITIES, type Periodicity } from './grands-redevables.js';
import type { VerticalesService } from './service.js';

const { always, sameEntity } = GRANTS;
definePolicy('grands-redevables:read', { R01: always, R02: always, R05: always, R06: sameEntity, R07: sameEntity, R11: sameEntity, R22: always, R23: always, R24: always });
definePolicy('grands-redevables:manage', { R06: sameEntity, R07: sameEntity, R11: sameEntity });
definePolicy('grands-redevables:convention', { R11: sameEntity, R07: sameEntity });
definePolicy('grands-redevables:decide', { R06: sameEntity, R07: sameEntity });

const motif = z.string().trim().min(10).max(2000);
type P = { Params: { taxpayerId: string } };

export const grandsRedevablesPlugin = definePlugin<GrandsRedevablesService>({
  name: 'grands-redevables',
  create: (ctx) => new GrandsRedevablesService(ctx, () => (ctx.ext.verticales as VerticalesService | undefined)?.secteurs),
  seed: (ctx) => {
    // Second gestionnaire de la cellule (démonstration) : permet la rotation des gestionnaires.
    if (!ctx.users.get('gr-gestionnaire-2')) ctx.users.add({ id: 'gr-gestionnaire-2', name: 'Gestionnaire grands redevables n° 2 (démo)', roles: ['R11'], entity: 'DGTK' });
  },
  routes: (app, _ctx, svc) => {
    app.get('/v1/grands-redevables', async (req) => svc.view(requireUser(req)));
    app.post<P>('/v1/grands-redevables/:taxpayerId/gestionnaire', async (req) => svc.assignManager(requireUser(req), req.params.taxpayerId, parse(z.object({ managerId: z.string().max(80), motif }).strict(), req.body)));
    app.post<P>('/v1/grands-redevables/:taxpayerId/conventions', async (req, reply) => {
      const b = parse(z.object({
        reference: z.string().trim().min(3).max(80), object: z.string().trim().min(10).max(2000), sectors: z.array(z.string().regex(/^\d{2}$/)).max(10),
        periodicity: z.enum(Object.keys(PERIODICITIES) as [Periodicity, ...Periodicity[]]), legalBasis: z.object({ instrumentId: z.string().max(80), article: z.string().trim().min(1).max(80) }).strict(),
        signedSha256: z.string().regex(/^[0-9a-f]{64}$/), from: isoDateString, to: isoDateString,
      }).strict(), req.body);
      return reply.code(201).send(svc.proposeConvention(requireUser(req), req.params.taxpayerId, b));
    });
    app.post<{ Params: { id: string } }>('/v1/grands-redevables/conventions/:id/decision', async (req) => svc.decideConvention(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
    app.post<P>('/v1/grands-redevables/:taxpayerId/journal', async (req, reply) => reply.code(201).send(svc.record(requireUser(req), req.params.taxpayerId, parse(z.object({ kind: z.enum(['NOTE', 'ECHANGE', 'DECISION']), text: z.string().trim().min(5).max(4000), evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(), req.body))));
  },
});
