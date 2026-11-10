/**
 * Module d'extension « acces-delegations » (module 51) : délégations temporaires, décision ABAC expliquée, détection des
 * conflits d'intérêts, privilèges excessifs et comptes partagés, révocation automatique à la fin d'une affectation.
 * Échéancier : toutes les heures hors tests (MOSOLO_ACCES_ECHEANCIER=off le désactive, =on le force).
 */
import { runScheduledJob } from '../../core/jobs.js';
import { z } from 'zod';
import type { RoleCode } from '@mosolo/shared';
import { requireUser } from '../../core/auth.js';
import { isoDateString, parse } from '../../core/http.js';
import { allAgentRoles, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { definePlugin } from '../types.js';
import { DelegationService, type Sensitivity } from './delegations.js';
import type { AccesService } from './service.js';

const { always, sameEntity } = GRANTS;
definePolicy('acces:delegation.read', allAgentRoles(always));
definePolicy('acces:delegation.request', allAgentRoles(always));
definePolicy('acces:delegation.approve', { R08: sameEntity, R06: sameEntity, R07: sameEntity, R28: always });
definePolicy('acces:abac.explain', { R08: always, R28: always, R22: always, R23: always, R26: always });
definePolicy('acces:echeancier.run', { R08: always, R28: always, R26: always });
// Rattachement des agents de terrain à leurs modules de contrôle (30/09/2026) : administrateur de l'entité de l'agent.
definePolicy('acces:agent.modules', { R08: sameEntity, R07: sameEntity });

export function echeancierEnabled(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const f = (flag ?? '').trim().toLowerCase();
  if (f === 'off') return false;
  if (f === 'on') return true;
  return !env.VITEST;
}

const motif = z.string().trim().min(10).max(2000);
const roleCode = z.string().regex(/^R\d{2}$/);

export const accesDelegationsPlugin = definePlugin<DelegationService>({
  name: 'acces-delegations',
  create: (ctx) => new DelegationService(ctx, () => ctx.ext.acces as AccesService),
  routes: (app, ctx, svc) => {
    if (echeancierEnabled(process.env.MOSOLO_ACCES_ECHEANCIER)) {
      const t = setInterval(() => { runScheduledJob(ctx, 'acces.delegations-echeances', () => { svc.sweep(); svc.detect(); }); }, 3_600_000);
      t.unref();
      app.addHook('onClose', async () => clearInterval(t));
    }
    app.get('/v1/acces/delegations', async (req) => svc.view(requireUser(req)));
    app.post('/v1/acces/delegations', async (req, reply) => {
      const b = parse(z.object({
        delegateId: z.string().max(80), roles: z.array(roleCode).min(1).max(10), motif, from: isoDateString, to: isoDateString,
        scope: z.object({ territory: z.array(z.string().refine((c) => (COMMUNES as readonly string[]).includes(c), 'commune inconnue')).max(24).optional(), modules: z.array(z.string().max(40)).max(40).optional() }).strict().optional(),
      }).strict(), req.body);
      return reply.code(201).send(svc.request(requireUser(req), { ...b, roles: b.roles as RoleCode[], ...(b.scope ? { scope: Object.fromEntries(Object.entries(b.scope).filter(([, v]) => v !== undefined)) } : {}) }));
    });
    app.post<{ Params: { id: string } }>('/v1/acces/delegations/:id/decision', async (req) => svc.decide(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
    app.post<{ Params: { id: string } }>('/v1/acces/delegations/:id/fin', async (req) => svc.end(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post('/v1/acces/echeancier', async (req) => { authorize(requireUser(req), 'acces:echeancier.run'); return svc.sweep(); });
    app.post('/v1/acces/abac/explication', async (req) => {
      const b = parse(z.object({
        userId: z.string().max(80), action: z.string().regex(/^[a-z][a-z0-9_.-]*(:[a-z0-9_.-]+)?$/i).max(80), commune: z.string().max(64).optional(), module: z.string().max(40).optional(),
        taxpayerId: z.string().max(80).optional(), date: isoDateString.optional(), deviceId: z.string().max(100).optional(), sensitivity: z.enum(['PUBLIC', 'INTERNE', 'CONFIDENTIEL', 'SENSIBLE']).optional(),
      }).strict(), req.body);
      return svc.explain(requireUser(req), { ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)), userId: b.userId, action: b.action } as { userId: string; action: string; sensitivity?: Sensitivity });
    });
  },
});
