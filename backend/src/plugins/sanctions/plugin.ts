/**
 * Module d'extension « sanctions » : registre transversal des pénalités impayées (visible après un contrôle, avec le
 * montant) et commission de 10 % des agents de TOUS les modules.
 */
import { requireUser } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { z } from 'zod';
import { definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { SanctionsService } from './service.js';
import { seedSanctions } from './seed.js';

/** Usagers, partenaires et observateurs : pas de commission (seuls les agents publics qui contrôlent). */
const NON_AGENT = new Set(['R30', 'R31', 'R32', 'R33', 'R34', 'R36', 'R37']);
/** Surveillance des constats par agent : superviseurs, régies, pilotage, audit, anti-fraude. */
const MONITOR = new Set(['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23', 'R24']);
/** Récapitulatif de tous les agents : pilotage, régies, Trésor, audit. */
const OVERVIEW = new Set(['R01', 'R02', 'R05', 'R06', 'R07', 'R17', 'R22', 'R23']);

// Validation des commissions avant versement : superviseurs (R09), chefs de service (R07), directions de régie (R06) ;
// consultation de la file : Trésor (paie), pilotage et audit.
definePolicy('sanctions:commission.validate', { R09: GRANTS.always, R07: GRANTS.always, R06: GRANTS.always });
definePolicy('sanctions:commission.validations.read', { R01: GRANTS.always, R02: GRANTS.always, R05: GRANTS.always, R17: GRANTS.always, R22: GRANTS.always, R23: GRANTS.always, R24: GRANTS.always });

const decisionBody = z.object({ approve: z.boolean(), motif: z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000) }).strict();
const requestBody = z.object({ lineKeys: z.array(z.string().min(3).max(200)).max(500).optional(), motif: z.string().trim().max(2000).optional() }).strict();

export const sanctionsPlugin = definePlugin<SanctionsService>({
  name: 'sanctions',
  create: (ctx) => {
    const svc = new SanctionsService(ctx);
    // Surveillance périodique facultative (MOSOLO_AGENT_MONITORING_MS, 1 minute au moins) : alertes dédoublonnées.
    const every = Number.parseInt(process.env.MOSOLO_AGENT_MONITORING_MS ?? '', 10);
    if (Number.isFinite(every) && every >= 60_000) svc.startScheduler(every);
    return svc;
  },
  seed: (ctx) => seedSanctions(ctx),
  routes: (app, ctx, svc) => {
    app.get('/v1/agents/me/earnings', async (req) => {
      const user = requireUser(req);
      if (user.roles.every((r) => NON_AGENT.has(r))) throw forbidden('NOT_AN_AGENT', 'Commission réservée aux agents publics qui contrôlent.');
      return svc.commissions.summary(user.id);
    });
    app.get('/v1/agents/earnings', async (req) => {
      const user = requireUser(req);
      if (!user.roles.some((r) => OVERVIEW.has(r)) && !evaluate(user, 'parking:indicators', { entity: 'DGTK' })) throw forbidden('FORBIDDEN', 'Récapitulatif réservé au pilotage, aux régies, au Trésor et à l’audit.');
      ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'agents.earnings.viewed', resourceType: 'commission', resourceId: 'tous' });
      return svc.commissions.all();
    });
    app.get('/v1/agents/monitoring', async (req) => {
      const user = requireUser(req);
      if (!user.roles.some((r) => MONITOR.has(r))) throw forbidden('FORBIDDEN', 'Surveillance réservée aux superviseurs, aux régies, au pilotage, à l’audit et à l’anti-fraude.');
      ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'agents.monitoring.viewed', resourceType: 'agents', resourceId: 'tous' });
      return svc.monitoring.report(user);
    });
    // Validation à deux personnes des commissions acquises : demande par l'agent bénéficiaire, décision par un
    // superviseur distinct (garde de rotation du module Intégrité sur la route de décision).
    app.post('/v1/agents/me/commission-validations', async (req, reply) => {
      const user = requireUser(req);
      if (user.roles.every((r) => NON_AGENT.has(r))) throw forbidden('NOT_AN_AGENT', 'Commission réservée aux agents publics qui contrôlent.');
      return reply.code(201).send(svc.validations.request(user, parse(requestBody, req.body ?? {})));
    });
    app.get<{ Querystring: { status?: string } }>('/v1/agents/commission-validations', async (req) => svc.validations.queue(requireUser(req), req.query.status));
    app.post<{ Params: { id: string } }>('/v1/agents/commission-validations/:id/decision', async (req) =>
      svc.validations.decide(requireUser(req), req.params.id, parse(decisionBody, req.body)));
    // Contre-vérification aléatoire des constats retenus : file et résultat (superviseur non intervenu).
    app.get<{ Querystring: { status?: string } }>('/v1/agents/counter-checks', async (req) => ({ items: svc.counterChecks.list(requireUser(req), req.query.status) }));
    app.post<{ Params: { id: string } }>('/v1/agents/counter-checks/:id/record', async (req) =>
      svc.counterChecks.record(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['CONFIRME', 'INFIRME']), note: z.string().trim().min(5).max(2000) }).strict(), req.body)));
  },
});

export { SanctionsService } from './service.js';
