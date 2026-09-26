import { REQUIRED_APPROVALS } from '@mosolo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { currencySchema, decimalString, isoDateString, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
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
}).strict();

const approveSchema = z.object({ role: z.enum(REQUIRED_APPROVALS as [string, ...string[]]) }).strict();

export function registerRuleRoutes(app: FastifyInstance, ctx: AppContext): void {
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
    return ctx.rules.approve(user, req.params.id, role as (typeof REQUIRED_APPROVALS)[number]);
  });
}
