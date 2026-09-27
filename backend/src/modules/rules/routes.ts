import { REQUIRED_APPROVALS } from '@mosolo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, requireAcr, ACR } from '../../core/auth.js';
import { currencySchema, decimalString, isoDateString, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { recalculationsFor } from './recalculation.js';
import type { RuleInput } from './service.js';

const REVENUE_CATEGORIES = [
  'IMPOT_PROVINCIAL', 'INTERET_COMMUN', 'PROVINCIAL_SPECIFIQUE', 'RECETTE_ETD', 'RECETTE_CENTRALE', 'PARTAGEE',
  'DROIT_ADMINISTRATIF', 'REDEVANCE_SERVICE', 'PENALITE', 'CONCESSION_DOMANIALE', 'RECETTE_COMMERCIALE', 'ACTE_REQUIS',
] as const;

const ruleSchema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{2,40}$/),
  revenueCategory: z.enum(REVENUE_CATEGORIES),
  label: z.string().min(3).max(200),
  legalInstrumentIds: z.array(z.string()).min(1),
  articles: z.array(z.string()).min(1),
  competentAuthority: z.string().min(1),
  administeringEntity: z.string().min(1),
  taxableEvent: z.string().min(1),
  liableParty: z.string().min(1),
  withholdingAgent: z.string().optional(),
  baseDefinition: z.string().min(1),
  formula: z.string().min(1).max(1000),
  rateTable: z.record(decimalString),
  currency: currencySchema,
  rounding: z.enum(['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP']),
  periodicity: z.enum(['ANNUELLE', 'MENSUELLE', 'PONCTUELLE']),
  dueRule: z.string().min(1),
  exemptions: z.array(z.object({ basis: z.string(), proof: z.string() })).default([]),
  penalties: z.array(z.object({ basis: z.string(), description: z.string() })).default([]),
  effectiveFrom: isoDateString,
  effectiveTo: isoDateString.optional(),
  beneficiaryAccountAlias: z.string().min(1),
  appealPath: z.string().min(1),
  sourceVerification: z.enum(['OFFICIEL_CERTIFIE', 'PRESSE', 'DOCUMENT_DE_TRAVAIL', 'AUCUNE']),
  changeReason: z.string().optional(),
  /** Acte autorisant expressément la rétroactivité (exigé pour une nouvelle version à effet antérieur à sa publication). */
  retroactivity: z.object({
    instrumentId: z.string().min(1),
    article: z.string().trim().min(1).max(200),
    justification: z.string().trim().min(10).max(2000),
  }).strict().optional(),
}).strict();

const motive = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const suspendSchema = z.object({ reason: motive, authority: z.string().trim().min(3).max(200), instrumentRef: z.string().optional() }).strict();
const liftSchema = z.object({ reason: motive }).strict();
const suspensionDecisionSchema = z.object({ approve: z.boolean(), reason: motive }).strict();
const abrogateSchema = z.object({ date: isoDateString, instrumentId: z.string().min(1), reason: motive }).strict();
const instrumentAbrogateSchema = z.object({ date: isoDateString, abrogatedBy: z.string().min(1), reason: motive }).strict();
const recalcDecisionSchema = z.object({ decision: z.enum(['APPLIQUER', 'REJETER']), reason: motive }).strict();

const approveSchema = z.object({ role: z.enum(REQUIRED_APPROVALS as [string, ...string[]]) }).strict();

export function registerRuleRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Alertes du registre (suspension brève, décisions pendant une suspension) : service d'alertes du socle.
  ctx.rules.attachAlerts(ctx.alerts);

  app.get('/v1/legal-rules', async (req) => {
    authorize(requireUser(req), 'rule.read');
    return ctx.rules.list();
  });

  app.get<{ Params: { id: string } }>('/v1/legal-rules/:id', async (req) => {
    authorize(requireUser(req), 'rule.read');
    const rule = ctx.rules.get(req.params.id);
    return { ...rule, requiredInputs: ctx.rules.requiredInputs(rule) };
  });

  app.get('/v1/legal-instruments', async (req) => {
    authorize(requireUser(req), 'rule.read');
    return ctx.rules.instruments.all();
  });

  app.post('/v1/legal-rules', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'rule.create');
    const body = parse(ruleSchema, req.body) as RuleInput;
    return reply.code(201).send(ctx.rules.create(user, body));
  });

  app.post<{ Params: { id: string } }>('/v1/legal-rules/:id/approve', async (req) => {
    const user = requireUser(req);
    const { role } = parse(approveSchema, req.body);
    requireAcr(user, ACR.MFA); // DG-09 : visa d'une règle = acte sensible
    return ctx.rules.approve(user, req.params.id, role as (typeof REQUIRED_APPROVALS)[number]);
  });

  // ── Cycle de vie complémentaire : suspension, abrogation, versions ──
  // Quatre yeux : suspension et levée sont PROPOSÉES (202), puis approuvées par une seconde personne distincte.
  app.post<{ Params: { id: string } }>('/v1/legal-rules/:id/suspend', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'rules:suspend');
    return reply.code(202).send(ctx.rules.suspend(user, req.params.id, parse(suspendSchema, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/legal-rules/:id/lift-suspension', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'rules:suspend');
    return reply.code(202).send(ctx.rules.liftSuspension(user, req.params.id, parse(liftSchema, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/legal-rules/:id/suspension-change/decide', async (req) => {
    const user = requireUser(req);
    authorize(user, 'rules:suspend.approve');
    requireAcr(user, ACR.MFA); // acte sensible : effet immédiat sur la production d'obligations
    return ctx.rules.decideSuspensionChange(user, req.params.id, parse(suspensionDecisionSchema, req.body));
  });

  app.post<{ Params: { id: string } }>('/v1/legal-rules/:id/abrogate', async (req) => {
    const user = requireUser(req);
    authorize(user, 'rules:abrogate');
    const input = parse(abrogateSchema, req.body);
    const rule = ctx.rules.abrogate(user, req.params.id, input);
    // Abrogation à date passée : les obligations émises depuis sont signalées pour examen (jamais annulées d'office).
    const obligationsToReview = ctx.assessment.obligations
      .find((o) => o.ruleId === rule.id && o.createdAt.slice(0, 10) >= input.date && o.status !== 'ANNULEE')
      .map((o) => ({ id: o.id, status: o.status, issuedOn: o.createdAt.slice(0, 10), amount: o.amount }));
    return { rule, obligationsToReview };
  });

  app.get<{ Params: { id: string } }>('/v1/legal-rules/:id/versions', async (req) => {
    authorize(requireUser(req), 'rule.read');
    const versions = ctx.rules.versions(req.params.id);
    return { code: versions[0]?.code, versions };
  });

  app.post<{ Params: { id: string } }>('/v1/legal-instruments/:id/abrogate', async (req) => {
    const user = requireUser(req);
    authorize(user, 'rules:instrument.abrogate');
    return ctx.rules.abrogateInstrument(user, req.params.id, parse(instrumentAbrogateSchema, req.body));
  });

  // ── Recalcul contrôlé : simulation d'impact → décision motivée → obligations rectificatives ──
  app.post<{ Params: { id: string } }>('/v1/legal-rules/:id/impact-simulations', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(recalculationsFor(ctx).simulate(user, req.params.id));
  });

  app.get<{ Querystring: { ruleId?: string } }>('/v1/recalculations', async (req) => {
    authorize(requireUser(req), 'rules:recalc.simulate');
    return recalculationsFor(ctx).list(req.query.ruleId);
  });

  app.get<{ Params: { id: string } }>('/v1/recalculations/:id', async (req) => {
    authorize(requireUser(req), 'rules:recalc.simulate');
    return recalculationsFor(ctx).get(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/recalculations/:id/decide', async (req) => {
    const user = requireUser(req);
    return recalculationsFor(ctx).decide(user, req.params.id, parse(recalcDecisionSchema, req.body));
  });
}
