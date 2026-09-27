/**
 * Module d'extension « planification » (pilotage stratégique) : base de référence auditée et RANV (§ 38.1–38.2),
 * tableau du pilote vs communes témoins avec revues signées (§ 45.3–45.5), simulateur de scénarios (§ 38.3–38.4),
 * assignations budgétaires et carte des écarts (§ 26.1), circuit des instructions (§ 26.1–26.2), accords de service
 * entre entités (§ 10A.3), enquête de satisfaction et sondes de disponibilité (§ 39), projets publics et scénarios
 * d'emploi des fonds (§ 27.2–27.3). Aucun acte financier ; toute certification exige une seconde personne distincte.
 */
import { z } from 'zod';
import { CURRENCIES, type CurrencyCode, type RoleCode } from '@mosolo/shared';
import { ACR, requireAcr, requireUser } from '../../../core/auth.js';
import { isoDateString, moneySchema, parse } from '../../../core/http.js';
import { allAgentRoles, definePolicy, GRANTS } from '../../../core/policy.js';
import { PAYMENT_CHANNELS } from '../../../modules/payments/service.js';
import { COMMUNES } from '../../../reference/kinshasa.js';
import { definePlugin } from '../../types.js';
import {
  HYPOTHESIS_VARIABLES, INSTRUCTION_ORIGINS, MATURITY, PROCUREMENT, PROJECT_DOMAINS, SCENARIO_CODES, SET_KINDS, SLA_KINDS,
  type HypothesisVariable, type InstructionOrigin, type Maturity, type Procurement, type ProjectDomain, type ScenarioCode, type SlaKind,
} from './model.js';
import { PlanificationService } from './service.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
/** Lecteurs des tableaux de pilotage (mêmes rôles que les tableaux existants), plus la validation financière. */
const READERS: RoleCode[] = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24'];

definePolicy('planification:baseline.read', g(READERS));
/** Import de la base de référence ou d'un relevé de coûts : Finances, validation financière, Trésor, direction de régie. */
definePolicy('planification:baseline.import', g(['R05', 'R06', 'R15', 'R17', 'R18']));
/** Certification (seconde personne) : audit interne ou externe, ministre des Finances. */
definePolicy('planification:baseline.certify', g(['R05', 'R22', 'R23']));
definePolicy('planification:pilot.read', g([...READERS, 'R36']));
definePolicy('planification:pilot.configure', g(['R01', 'R05']));
definePolicy('planification:pilot.snapshot', g(['R01', 'R05', 'R22', 'R23']));
definePolicy('planification:scenario.read', g(READERS));
definePolicy('planification:scenario.hypothesis', g(['R05', 'R06', 'R15']));
definePolicy('planification:targets.read', g(READERS));
definePolicy('planification:targets.import', g(['R05', 'R06', 'R15']));
definePolicy('planification:targets.certify', g(['R01', 'R02', 'R05']));
definePolicy('planification:instruction.read', allAgentRoles(always));
definePolicy('planification:instruction.issue', g(['R01', 'R02', 'R03']));
definePolicy('planification:instruction.respond', allAgentRoles(always));
definePolicy('planification:instruction.close', g(['R01', 'R02', 'R03']));
definePolicy('planification:sla.read', allAgentRoles(always));
definePolicy('planification:sla.write', g(['R02', 'R03', 'R05', 'R08']));
definePolicy('planification:sla.request', allAgentRoles(always));
definePolicy('planification:satisfaction.respond', g(['R30', 'R31']));
definePolicy('planification:satisfaction.read', g(READERS));
definePolicy('planification:availability.write', g(['R26', 'R27']));
definePolicy('planification:availability.read', g(['R01', 'R02', 'R05', 'R22', 'R23', 'R26', 'R27', 'R28']));
definePolicy('planification:project.read', g([...READERS, 'R16']));
definePolicy('planification:project.write', g(['R03', 'R05', 'R06', 'R08', 'R15']));
definePolicy('planification:project.recommend', g(['R01', 'R05', 'R15']));
definePolicy('planification:project.decide', g(['R01', 'R05']));
definePolicy('planification:project.progress', g(['R05', 'R06', 'R07', 'R08']));

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const sha = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const period = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2])|-T[1-4])?$/, 'AAAA, AAAA-MM ou AAAA-Tn attendu');
const commune = z.string().refine((c) => c === '*' || (COMMUNES as readonly string[]).includes(c), 'commune inconnue');
const currency = z.string().refine((c) => c in CURRENCIES, 'devise inconnue');
const entrySchema = z.object({
  metric: z.string().min(2).max(40), revenue: z.string().max(40).default('*'), commune: z.string().max(40).default('*'),
  channel: z.string().refine((c) => c === '*' || (PAYMENT_CHANNELS as readonly string[]).includes(c), 'canal inconnu').default('*'),
  value: z.string().max(30), currency: currency.optional(),
}).strict();
const setSchema = z.object({
  kind: z.enum(SET_KINDS), label: z.string().trim().min(3).max(200), period,
  source: z.object({ document: z.string().trim().min(3).max(300), reference: z.string().trim().min(2).max(200), sha256: sha.optional() }).strict(),
  entries: z.array(entrySchema).max(5000).optional(), csv: z.string().max(2_000_000).optional(),
}).strict().refine((b) => !!b.entries !== (b.csv !== undefined), 'fournir soit entries, soit csv');
const decisionSchema = z.object({ approve: z.boolean(), motif }).strict();
const query = z.object({
  commune: z.string().trim().max(64).optional(), category: z.string().trim().regex(/^[A-Z_]{2,40}$/).optional(), entity: z.string().trim().regex(/^[A-Z0-9_-]{2,40}$/).optional(),
  channel: z.enum(PAYMENT_CHANNELS).optional(), period: period.optional(), from: isoDateString.optional(), to: isoDateString.optional(), annee: z.string().regex(/^\d{4}$/).optional(),
}).strict();
const pilotSchema = z.object({ startDate: isoDateString, controls: z.array(z.string()).max(20), motif }).strict();
const hypSchema = z.object({
  scenario: z.enum(SCENARIO_CODES as [ScenarioCode, ...ScenarioCode[]]), variable: z.enum(Object.keys(HYPOTHESIS_VARIABLES) as [HypothesisVariable, ...HypothesisVariable[]]),
  revenue: z.string().regex(/^(\*|[A-Z_]{2,40})$/).default('*'), value: z.string().max(30), source: z.string().trim().min(5).max(500), sourceDate: isoDateString,
}).strict();
const simSchema = z.object({ hypotheses: z.array(hypSchema).min(1).max(200) }).strict();
const targetsSchema = z.object({
  fiscalYear: z.string().regex(/^\d{4}$/), label: z.string().trim().min(3).max(200),
  act: z.object({ reference: z.string().trim().min(3).max(200), title: z.string().trim().min(3).max(300), sha256: sha.optional() }).strict(),
  entries: z.array(z.object({ commune, category: z.string().regex(/^(\*|[A-Z_]{2,40})$/), amount: moneySchema }).strict()).min(1).max(2000),
}).strict();
const instructionSchema = z.object({
  origin: z.enum(Object.keys(INSTRUCTION_ORIGINS) as [InstructionOrigin, ...InstructionOrigin[]]), subject: z.string().trim().min(5).max(200), body: z.string().trim().min(10).max(4000),
  context: z.object({ commune: z.string().max(64).optional(), category: z.string().max(40).optional(), entity: z.string().max(40).optional() }).strict().optional(),
  assignee: z.object({ entity: z.string().regex(/^[A-Z0-9_-]{2,40}$/), role: z.string().regex(/^R\d{2}$/).optional(), userId: z.string().max(80).optional() }).strict(),
  deadline: isoDateString,
}).strict();
const reportSchema = z.object({ text: z.string().trim().min(10).max(4000), evidenceSha256: sha.optional() }).strict();
const closeSchema = z.object({ motif }).strict();
const reopenSchema = z.object({ motif, deadline: isoDateString }).strict();
const slaSchema = z.object({
  fromEntity: z.string().regex(/^[A-Z0-9_-]{2,40}$/), toEntity: z.string().regex(/^[A-Z0-9_-]{2,40}$/), kind: z.enum(Object.keys(SLA_KINDS) as [SlaKind, ...SlaKind[]]),
  delayHours: z.number().int().min(1).max(24 * 365), act: z.object({ reference: z.string().trim().min(3).max(200), title: z.string().trim().min(3).max(300) }).strict(),
}).strict();
const slaReqSchema = z.object({ reference: z.string().trim().min(3).max(120) }).strict();
const satSchema = z.object({ moment: z.enum(['APRES_PAIEMENT', 'APRES_VISITE']), note: z.number().int().min(1).max(5), channel: z.string().max(30).default('WEB'), receiptNumber: z.string().max(80).optional() }).strict();
const probeSchema = z.object({ target: z.string().trim().min(2).max(120), ok: z.boolean(), latencyMs: z.number().int().min(0).max(600_000).optional(), at: z.string().datetime().optional() }).strict();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const projectSchema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{3,40}$/), title: text(5, 200), domain: z.enum(Object.keys(PROJECT_DOMAINS) as [ProjectDomain, ...ProjectDomain[]]),
  communes: z.array(z.string()).min(1).max(24), areas: text(2, 300).optional(), beneficiaries: text(5, 500), expectedResult: text(5, 1000),
  maturity: z.enum(Object.keys(MATURITY) as [Maturity, ...Maturity[]]), cost: moneySchema, recurringCost: moneySchema,
  procurement: z.enum(Object.keys(PROCUREMENT) as [Procurement, ...Procurement[]]), risks: text(5, 1000), approvalAuthority: text(3, 200), legalFundSource: text(5, 500),
}).strict();
const recommendSchema = z.object({ period, currency: currency, legalFundSource: text(5, 500) }).strict();
const scenarioDecisionSchema = z.object({ retain: z.boolean(), motif }).strict();
const fundingSchema = z.object({ decisionReference: text(3, 200), amount: moneySchema, motif }).strict();
const progressSchema = z.object({ progressPct: z.string().regex(/^(100(\.0)?|\d{1,2}(\.\d)?)$/, 'pourcentage 0 à 100'), status: z.enum(['EN_COURS', 'ACHEVE']).optional(), note: text(3, 1000) }).strict();

export const planificationPlugin = definePlugin<PlanificationService>({
  name: 'planification',
  create: (ctx) => new PlanificationService(ctx),
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, _ctx, svc) => {
    const q = (raw: unknown) => { const { annee: _a, ...rest } = parse(query, raw); return rest; };
    // Base de référence (§ 38.1) et RANV (§ 38.2)
    app.get('/v1/pilotage/base-reference', async (req) => svc.listSets(requireUser(req)));
    app.post('/v1/pilotage/base-reference', async (req, reply) => reply.code(201).send(svc.importSet(requireUser(req), parse(setSchema, req.body) as Parameters<PlanificationService['importSet']>[1])));
    app.post<{ Params: { id: string } }>('/v1/pilotage/base-reference/:id/certification', async (req) => {
      const user = requireUser(req);
      requireAcr(user, ACR.MFA);
      return svc.decideSet(user, req.params.id, parse(decisionSchema, req.body));
    });
    app.get('/v1/pilotage/ranv', async (req) => svc.ranvView(requireUser(req), q(req.query)));
    // Pilote de 180 jours (§ 45)
    app.get('/v1/pilotage/pilote', async (req) => svc.pilotView(requireUser(req)));
    app.post('/v1/pilotage/pilote/configuration', async (req) => svc.configurePilot(requireUser(req), parse(pilotSchema, req.body)));
    app.post<{ Params: { jalon: string } }>('/v1/pilotage/pilote/revues/:jalon', async (req, reply) => reply.code(201).send(svc.signMilestone(requireUser(req), req.params.jalon)));
    // Scénarios (§ 38.3–38.4)
    app.get('/v1/pilotage/scenarios', async (req) => svc.simulate(requireUser(req), q(req.query)));
    app.post('/v1/pilotage/scenarios/simulation', async (req) => svc.simulate(requireUser(req), {}, parse(simSchema, req.body).hypotheses));
    app.get('/v1/pilotage/scenarios/hypotheses', async (req) => svc.listHypotheses(requireUser(req)));
    app.post('/v1/pilotage/scenarios/hypotheses', async (req, reply) => reply.code(201).send(svc.recordHypothesis(requireUser(req), parse(hypSchema, req.body))));
    // Assignations budgétaires (§ 26.1)
    app.get('/v1/pilotage/assignations', async (req) => svc.listTargets(requireUser(req)));
    app.post('/v1/pilotage/assignations', async (req, reply) => reply.code(201).send(svc.importTargets(requireUser(req), parse(targetsSchema, req.body) as Parameters<PlanificationService['importTargets']>[1])));
    app.post<{ Params: { id: string } }>('/v1/pilotage/assignations/:id/certification', async (req) => {
      const user = requireUser(req);
      requireAcr(user, ACR.MFA);
      return svc.decideTargets(user, req.params.id, parse(decisionSchema, req.body));
    });
    app.get('/v1/pilotage/assignations/ecarts', async (req) => {
      const raw = parse(query, req.query);
      return svc.gapMap(requireUser(req), { ...q(req.query), ...(raw.annee ? { year: raw.annee } : {}) });
    });
    // Instructions (§ 26.1–26.2)
    app.get('/v1/pilotage/instructions', async (req) => svc.listInstructions(requireUser(req)));
    app.post('/v1/pilotage/instructions', async (req, reply) => reply.code(201).send(svc.issueInstruction(requireUser(req), parse(instructionSchema, req.body) as Parameters<PlanificationService['issueInstruction']>[1])));
    app.post<{ Params: { id: string } }>('/v1/pilotage/instructions/:id/accuse', async (req) => svc.acknowledgeInstruction(requireUser(req), req.params.id));
    app.post<{ Params: { id: string } }>('/v1/pilotage/instructions/:id/rapport', async (req) => svc.reportInstruction(requireUser(req), req.params.id, parse(reportSchema, req.body)));
    app.post<{ Params: { id: string } }>('/v1/pilotage/instructions/:id/cloture', async (req) => svc.closeInstruction(requireUser(req), req.params.id, parse(closeSchema, req.body).motif));
    app.post<{ Params: { id: string } }>('/v1/pilotage/instructions/:id/reouverture', async (req) => svc.reopenInstruction(requireUser(req), req.params.id, parse(reopenSchema, req.body)));
    // Accords de niveau de service entre entités (§ 10A.3)
    app.get('/v1/pilotage/accords-service', async (req) => svc.slaBoard(requireUser(req)));
    app.post('/v1/pilotage/accords-service', async (req, reply) => reply.code(201).send(svc.recordAgreement(requireUser(req), parse(slaSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/pilotage/accords-service/:id/demandes', async (req, reply) => reply.code(201).send(svc.openSlaRequest(requireUser(req), req.params.id, parse(slaReqSchema, req.body).reference)));
    app.post<{ Params: { id: string } }>('/v1/pilotage/accords-service/demandes/:id/cloture', async (req) => svc.closeSlaRequest(requireUser(req), req.params.id));
    // Satisfaction (enquête facultative) et disponibilité (§ 39)
    app.post('/v1/satisfaction', async (req, reply) => reply.code(201).send(svc.respondSatisfaction(requireUser(req), parse(satSchema, req.body))));
    app.get('/v1/pilotage/satisfaction', async (req) => svc.satisfactionSummary(requireUser(req)));
    app.post('/v1/pilotage/disponibilite/sondes', async (req, reply) => reply.code(201).send(svc.recordProbe(requireUser(req), parse(probeSchema, req.body))));
    app.get('/v1/pilotage/disponibilite', async (req) => svc.availability(requireUser(req)));
    // Projets publics et emploi des fonds (§ 27.2–27.3)
    app.get('/v1/pilotage/projets', async (req) => svc.listProjects(requireUser(req)));
    app.post('/v1/pilotage/projets', async (req, reply) => reply.code(201).send(svc.createProject(requireUser(req), parse(projectSchema, req.body) as Parameters<PlanificationService['createProject']>[1])));
    app.post('/v1/pilotage/projets/recommandations', async (req, reply) => {
      const b = parse(recommendSchema, req.body);
      return reply.code(201).send(svc.recommend(requireUser(req), { period: b.period, currency: b.currency as CurrencyCode, legalFundSource: b.legalFundSource }));
    });
    app.post<{ Params: { id: string } }>('/v1/pilotage/projets/scenarios/:id/decision', async (req) => svc.decideScenario(requireUser(req), req.params.id, parse(scenarioDecisionSchema, req.body)));
    app.post<{ Params: { id: string } }>('/v1/pilotage/projets/:id/financement', async (req) => svc.recordFunding(requireUser(req), req.params.id, parse(fundingSchema, req.body) as Parameters<PlanificationService['recordFunding']>[2]));
    app.post<{ Params: { id: string } }>('/v1/pilotage/projets/:id/avancement', async (req) => svc.recordProgress(requireUser(req), req.params.id, parse(progressSchema, req.body)));
  },
});

export { PlanificationService } from './service.js';
