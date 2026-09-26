import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { moneySchema, parse } from '../../core/http.js';
import { authorize, evaluate } from '../../core/policy.js';
import { RECOVERY_PROCEDURE, SEGMENTS } from './parameters.js';
import type { RecoveryService } from './service.js';

const motive = z.string().trim().min(10, 'motivation d’au moins 10 caractères').max(4000);
const legalBasis = z.object({ instrumentId: z.string().min(1), article: z.string().trim().min(1).max(200) }).strict();

const schemas = {
  notice: z.object({ obligationId: z.string().min(1) }).strict(),
  openCase: z.object({ obligationId: z.string().min(1) }).strict(),
  proposal: z.object({
    kind: z.enum(['AVIS_FORMEL', 'MISE_EN_DEMEURE', 'MESURE_EXECUTION', 'LEVEE', 'CLASSEMENT']),
    motivation: motive, legalBasis: legalBasis.optional(), measureType: z.string().trim().min(3).max(300).optional(),
  }).strict(),
  decision: z.object({ decision: z.enum(['APPROUVEE', 'REJETEE']), motivation: motive }).strict(),
  observation: z.object({ text: z.string().trim().min(5).max(4000) }).strict(),
  address: z.object({ channel: z.enum(['TELEPHONE', 'COURRIEL', 'ADRESSE_POSTALE']), value: z.string().trim().min(4).max(300), proof: z.string().trim().min(5).max(500) }).strict(),
  planRequest: z.object({ obligationId: z.string().min(1), installments: z.number().int(), reason: z.string().trim().min(5).max(2000) }).strict(),
  planDecision: z.object({ granted: z.boolean(), motivation: motive, installments: z.number().int().optional() }).strict(),
  planDefault: z.object({ motivation: motive }).strict(),
  takeover: z.object({
    taxpayerId: z.string().min(1), objectId: z.string().optional(), fiscalYear: z.number().int().min(1960).max(2100),
    revenueLabel: z.string().trim().min(3).max(200), amount: moneySchema,
    instrumentIds: z.array(z.string().min(1)).min(1), articles: z.array(z.string().min(1)).min(1),
    legalOpinionRef: z.string().trim().min(3).max(200), interruptionActRef: z.string().trim().min(3).max(200).optional(),
  }).strict(),
  takeoverDecision: z.object({ decision: z.enum(['VALIDEE', 'REJETEE']), motivation: motive }).strict(),
  penalty: z.object({ obligationId: z.string().min(1), penaltyRuleId: z.string().min(1), inputs: z.record(z.string().regex(/^-?\d{1,18}(\.\d{1,18})?$/)).default({}), motivation: motive }).strict(),
  remission: z.object({ obligationId: z.string().min(1), basisRuleId: z.string().min(1), requestedAmount: moneySchema, motivation: motive }).strict(),
  remissionDecision: z.object({ granted: z.boolean(), motivation: motive, grantedAmount: moneySchema.optional() }).strict(),
};

/** Contribuables accessibles à un usager public (lui-même et ses mandants). */
function ownTaxpayers(user: User): string[] {
  return [...(user.taxpayerId ? [user.taxpayerId] : []), ...(user.mandants ?? [])];
}

export function registerRecoveryRoutes(app: FastifyInstance, ctx: AppContext, svc: RecoveryService): void {
  app.get('/v1/recouvrement/parametres', async (req) => {
    requireUser(req);
    return { procedure: RECOVERY_PROCEDURE, segments: SEGMENTS, planBasis: svc.planBasis() };
  });

  // ── Arriérés et file de recouvrement (agents) ──
  app.get<{ Querystring: { segment?: string; commune?: string; revenueCategory?: string; taxpayerId?: string } }>('/v1/recouvrement/arrieres', async (req) => {
    authorize(requireUser(req), 'recouvrement:read');
    return svc.arrears(req.query);
  });

  app.get('/v1/recouvrement/indicateurs', async (req) => {
    authorize(requireUser(req), 'recouvrement:read');
    return svc.indicators();
  });

  app.post('/v1/recouvrement/planification', async (req) => {
    return svc.runSchedule(requireUser(req));
  });

  app.get<{ Querystring: { status?: string } }>('/v1/recouvrement/dossiers', async (req) => {
    authorize(requireUser(req), 'recouvrement:read');
    return svc.cases.find((c) => !req.query.status || c.status === req.query.status).map((c) => svc.caseView(c));
  });

  app.post('/v1/recouvrement/dossiers', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(svc.caseView(svc.openCase(user, parse(schemas.openCase, req.body).obligationId)));
  });

  app.get<{ Params: { id: string } }>('/v1/recouvrement/dossiers/:id', async (req) => {
    const user = requireUser(req);
    const c = svc.getCase(req.params.id);
    if (!evaluate(user, 'recouvrement:read') && !evaluate(user, 'recouvrement:mine', { taxpayerId: c.taxpayerId })) throw forbidden('FORBIDDEN', 'Dossier de recouvrement : accès refusé.');
    const view = svc.caseView(c);
    if (evaluate(user, 'recouvrement:read')) return view;
    // Vue contribuable : ni segment ni profil de risque ; propositions en cours visibles (droit d'être entendu).
    const { proposals, ...rest } = view;
    return { ...rest, proposals: proposals.map((p) => ({ id: p.id, kind: p.kind, status: p.status, proposedAt: p.proposedAt, measureType: p.measureType ?? null, decision: p.decision ?? null })) };
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/dossiers/:id/rappel', async (req) => {
    return svc.caseView(svc.manualReminder(requireUser(req), req.params.id));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/dossiers/:id/propositions', async (req, reply) => {
    return reply.code(201).send(svc.propose(requireUser(req), req.params.id, parse(schemas.proposal, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/dossiers/:id/observations', async (req, reply) => {
    return reply.code(201).send(svc.addObservation(requireUser(req), req.params.id, parse(schemas.observation, req.body).text));
  });

  app.get('/v1/recouvrement/propositions', async (req) => {
    authorize(requireUser(req), 'recouvrement:read');
    return svc.proposals.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/propositions/:id/decision', async (req) => {
    return svc.decide(requireUser(req), req.params.id, parse(schemas.decision, req.body));
  });

  // ── Adresse de notification ──
  app.post<{ Params: { id: string } }>('/v1/recouvrement/contribuables/:id/adresse-notification', async (req, reply) => {
    return reply.code(201).send(svc.verifyAddress(requireUser(req), req.params.id, parse(schemas.address, req.body)));
  });

  // ── Avis légaux ──
  app.post('/v1/recouvrement/avis', async (req, reply) => {
    return reply.code(201).send(svc.issueAssessmentNotice(requireUser(req), parse(schemas.notice, req.body).obligationId));
  });

  app.get<{ Querystring: { taxpayerId?: string; obligationId?: string } }>('/v1/recouvrement/avis', async (req) => {
    const user = requireUser(req);
    const { taxpayerId, obligationId } = req.query;
    if (evaluate(user, 'recouvrement:read')) return svc.listNotices({ ...(taxpayerId ? { taxpayerId } : {}), ...(obligationId ? { obligationId } : {}) });
    const own = ownTaxpayers(user);
    if (taxpayerId && !own.includes(taxpayerId)) throw forbidden('FORBIDDEN', 'Avis d’un tiers : accès refusé.');
    if (!own.length) throw forbidden('FORBIDDEN', 'Aucun avis accessible.');
    return svc.listNotices({ taxpayerIds: taxpayerId ? [taxpayerId] : own, ...(obligationId ? { obligationId } : {}) });
  });

  app.get<{ Params: { id: string } }>('/v1/recouvrement/avis/:id', async (req) => {
    return svc.noticeFor(requireUser(req), req.params.id);
  });

  app.get<{ Params: { id: string } }>('/v1/recouvrement/avis/:id/preuve', async (req) => {
    return svc.noticeProof(requireUser(req), req.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/avis/:id/lecture', async (req) => {
    return svc.acknowledgeRead(requireUser(req), req.params.id);
  });

  // ── Espace contribuable : mes arriérés, échéances, avis, échéanciers ──
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/recouvrement/mes-arrieres', async (req) => {
    const user = requireUser(req);
    const own = ownTaxpayers(user);
    const ids = req.query.taxpayerId ? [req.query.taxpayerId] : own;
    if (!ids.length) throw forbidden('FORBIDDEN', 'Espace réservé aux contribuables et à leurs mandataires.');
    for (const id of ids) authorize(user, 'recouvrement:mine', { taxpayerId: id });
    return svc.mine(ids);
  });

  // ── Échéanciers ──
  app.post('/v1/recouvrement/echeanciers', async (req, reply) => {
    return reply.code(201).send(svc.planView(svc.requestPlan(requireUser(req), parse(schemas.planRequest, req.body))));
  });

  app.get('/v1/recouvrement/echeanciers', async (req) => {
    const user = requireUser(req);
    if (evaluate(user, 'recouvrement:read') || evaluate(user, 'recouvrement:plan.decide')) return svc.plans.all().map((p) => svc.planView(p));
    const own = ownTaxpayers(user);
    if (!own.length) throw forbidden('FORBIDDEN', 'Aucun échéancier accessible.');
    return svc.plans.find((p) => own.includes(p.taxpayerId)).map((p) => svc.planView(p));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/echeanciers/:id/decision', async (req) => {
    return svc.planView(svc.decidePlan(requireUser(req), req.params.id, parse(schemas.planDecision, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/echeanciers/:id/defaillance', async (req) => {
    return svc.planView(svc.recordDefault(requireUser(req), req.params.id, parse(schemas.planDefault, req.body).motivation));
  });

  // ── Reprise d'arriérés historiques ──
  app.get('/v1/recouvrement/reprises', async (req) => {
    authorize(requireUser(req), 'recouvrement:read');
    return svc.takeovers.all();
  });

  app.post('/v1/recouvrement/reprises', async (req, reply) => {
    return reply.code(201).send(svc.proposeTakeover(requireUser(req), parse(schemas.takeover, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/reprises/:id/validation', async (req) => {
    return svc.validateTakeover(requireUser(req), req.params.id, parse(schemas.takeoverDecision, req.body));
  });

  // ── Pénalités et remises ──
  app.get('/v1/recouvrement/penalites', async (req) => {
    authorize(requireUser(req), 'recouvrement:read');
    return svc.penalties.all();
  });

  app.post('/v1/recouvrement/penalites', async (req, reply) => {
    return reply.code(201).send(svc.proposePenalty(requireUser(req), parse(schemas.penalty, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/penalites/:id/decision', async (req) => {
    return svc.decidePenalty(requireUser(req), req.params.id, parse(schemas.decision, req.body));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/penalites/:id/liquidation', async (req) => {
    return svc.liquidatePenalty(requireUser(req), req.params.id);
  });

  app.get('/v1/recouvrement/remises', async (req) => {
    authorize(requireUser(req), 'recouvrement:read');
    return svc.remissions.all();
  });

  app.post('/v1/recouvrement/remises', async (req, reply) => {
    return reply.code(201).send(svc.requestRemission(requireUser(req), parse(schemas.remission, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/recouvrement/remises/:id/decision', async (req) => {
    return svc.decideRemission(requireUser(req), req.params.id, parse(schemas.remissionDecision, req.body));
  });
}
