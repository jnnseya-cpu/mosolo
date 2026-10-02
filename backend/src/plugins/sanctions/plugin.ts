/**
 * Module d'extension « sanctions » : registre transversal des pénalités impayées (visible après un contrôle, avec le
 * montant) et commission de 10 % des agents de TOUS les modules — vue de la réserve des agents par module (module 67,
 * § 37A.5 : points de résultats vérifiés × note de qualité, décision du maître d'ouvrage du 27/09/2026).
 */
import { requireUser } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { z } from 'zod';
import { definePolicy, evaluate, GRANTS, voitTousLesGains } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { SanctionsService } from './service.js';
import { seedSanctions } from './seed.js';

/** Usagers, partenaires et observateurs : pas de commission (seuls les agents publics qui contrôlent). */
const NON_AGENT = new Set(['R30', 'R31', 'R32', 'R33', 'R34', 'R36', 'R37']);
/** Surveillance des constats par agent : superviseurs, régies, pilotage, audit, anti-fraude. */
const MONITOR = new Set(['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23', 'R24']);
/**
 * Récapitulatif des gains des agents (décision du 29/09/2026) : tous les agents pour R01, R02, R03, R05 et R38 ;
 * régies (R06, R07) et pilotage du stationnement (DGTK) : les agents de leur propre entité seulement.
 */
const OVERVIEW_ENTITE = new Set(['R06', 'R07']);

// Validation des commissions avant versement : superviseurs (R09), chefs de service (R07), directions de régie (R06) ;
// consultation de toute la file : Gouverneur, cabinet, secrétariat exécutif, ministre des Finances (et R38) — décision du 29/09/2026.
definePolicy('sanctions:commission.validate', { R09: GRANTS.always, R07: GRANTS.always, R06: GRANTS.always });
definePolicy('sanctions:commission.validations.read', { R01: GRANTS.always, R02: GRANTS.always, R03: GRANTS.always, R05: GRANTS.always });

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
      const full = voitTousLesGains(user, 'AGENTS');
      const entite = user.roles.some((r) => OVERVIEW_ENTITE.has(r)) ? user.entity : user.entity === 'DGTK' && evaluate(user, 'parking:indicators', { entity: 'DGTK' }) ? 'DGTK' : null;
      if (!full && !entite) throw forbidden('FORBIDDEN', 'Gains des autres agents : réservés au Gouverneur, au cabinet, au secrétariat exécutif, au ministre des Finances et à Groupe Nseya ; une régie voit ses propres agents.');
      ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'agents.earnings.viewed', resourceType: 'commission', resourceId: full ? 'tous' : `entite:${entite}` });
      const all = svc.commissions.all();
      return full ? { ...all, perimetre: 'COMPLET' } : { ...all, perimetre: 'ENTITE', items: all.items.filter((i) => ctx.users.get(i.agentId)?.entity === entite) };
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
    // Réserve des agents et sous-traitants (module 67, § 37A.5) : points de résultats vérifiés × note de qualité,
    // quote-part par agent, équipe et sous-traitant ; reprises de points fictifs ou frauduleux à deux personnes.
    const periodQuery = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'mois AAAA-MM attendu').optional() }).strict();
    app.get('/v1/agents/reserve', async (req) => svc.reserve.view(requireUser(req), parse(periodQuery, req.query).period));
    app.get('/v1/agents/me/reserve', async (req) => {
      const user = requireUser(req);
      if (user.roles.every((r) => NON_AGENT.has(r))) throw forbidden('NOT_AN_AGENT', 'Réserve des agents : réservée aux agents publics et aux agents des sous-traitants.');
      return svc.reserve.mine(user, parse(periodQuery, req.query).period);
    });
    app.post('/v1/agents/reserve/reprises', async (req, reply) => reply.code(201).send(svc.reserve.proposeClawback(requireUser(req), parse(z.object({
      pointKeys: z.array(z.string().min(3).max(200)).min(1).max(200),
      grounds: z.enum(['POINT_FICTIF', 'POINT_FRAUDULEUX']),
      motif: z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000),
      evidenceSha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(20).default([]),
    }).strict(), req.body))));
    app.post<{ Params: { id: string } }>('/v1/agents/reserve/reprises/:id/decision', async (req) => svc.reserve.decideClawback(requireUser(req), req.params.id, parse(decisionBody, req.body)));
    // Contre-vérification aléatoire des constats retenus : file et résultat (superviseur non intervenu).
    app.get<{ Querystring: { status?: string } }>('/v1/agents/counter-checks', async (req) => ({ items: svc.counterChecks.list(requireUser(req), req.query.status) }));
    app.post<{ Params: { id: string } }>('/v1/agents/counter-checks/:id/record', async (req) =>
      svc.counterChecks.record(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['CONFIRME', 'INFIRME']), note: z.string().trim().min(5).max(2000) }).strict(), req.body)));
  },
});

export { SanctionsService } from './service.js';
