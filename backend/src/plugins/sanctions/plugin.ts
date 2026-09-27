/**
 * Module d'extension « sanctions » : registre transversal des pénalités impayées (visible après un contrôle, avec le
 * montant) et commission de 10 % des agents de TOUS les modules.
 */
import { requireUser } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { z } from 'zod';
import { evaluate } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { SanctionsService } from './service.js';
import { seedSanctions } from './seed.js';

/** Usagers, partenaires et observateurs : pas de commission (seuls les agents publics qui contrôlent). */
const NON_AGENT = new Set(['R30', 'R31', 'R32', 'R33', 'R34', 'R36', 'R37']);
/** Surveillance des constats par agent : superviseurs, régies, pilotage, audit, anti-fraude. */
const MONITOR = new Set(['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23', 'R24']);
/** Récapitulatif de tous les agents : pilotage, régies, Trésor, audit. */
const OVERVIEW = new Set(['R01', 'R02', 'R05', 'R06', 'R07', 'R17', 'R22', 'R23']);

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
    // Contre-vérification aléatoire des constats retenus : file et résultat (superviseur non intervenu).
    app.get<{ Querystring: { status?: string } }>('/v1/agents/counter-checks', async (req) => ({ items: svc.counterChecks.list(requireUser(req), req.query.status) }));
    app.post<{ Params: { id: string } }>('/v1/agents/counter-checks/:id/record', async (req) =>
      svc.counterChecks.record(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['CONFIRME', 'INFIRME']), note: z.string().trim().min(5).max(2000) }).strict(), req.body)));
  },
});

export { SanctionsService } from './service.js';
