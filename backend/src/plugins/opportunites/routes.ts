/**
 * Routes du module « opportunités » (§ 8.1 – § 8.7). Corps validés strictement (champ inconnu ⇒ 400).
 * Toute route exige une personne authentifiée ; aucune route n'est ouverte à un agent d'IA.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { DISCOVERY_DOMAINS, MAX_INPUT_KEYS, REVENUE_KINDS, SOURCE_KINDS, type SourceKind } from './model.js';
import type { IngestRecord, OpportunitesService } from './service.js';

type P = { Params: { id: string } };
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/, 'empreinte SHA-256 hexadécimale attendue (64 caractères)');
const commune = text(2, 40);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

const signal = z.object({
  title: text(5, 200), origin: z.enum(['IA_DECOUVERTE', 'TERRAIN', 'DONNEES_PARTENAIRES', 'ANOMALIE']), originRef: text(1, 100).optional(),
  summary: text(10, 2000), domains: z.array(z.enum(DISCOVERY_DOMAINS.map((d) => d.code) as [string, ...string[]])).min(1), verticals: z.array(text(2, 40)).max(10).optional(),
  revenueKind: z.enum(REVENUE_KINDS).optional(),
}).strict();
const step = z.object({
  summary: text(10, 4000), data: z.record(z.unknown()).optional(),
  scenarios: z.object({ prudent: moneySchema.nullable(), attendu: moneySchema.nullable(), ambitieux: moneySchema.nullable(), hypothesisIds: z.array(text(1, 40)).max(20) }).strict().optional(),
}).strict();
const decision = z.object({
  outcome: z.enum(['ACTIVATION', 'REPORT', 'ABANDON']), motivation: text(20, 4000),
  legalBasis: z.object({ kind: z.enum(['REGLE', 'ACTE']), ref: text(1, 100) }).strict().optional(),
}).strict();
const gridBody = z.object({ value: z.string().trim().max(4000).nullable(), reason: text(5, 1000) }).strict();
const hypothesis = z.object({ text: text(10, 2000), source: text(3, 500), date: isoDateString, revises: text(1, 40).optional() }).strict();
const maxInput = z.object({ value: z.union([moneySchema, z.string().trim().max(40), z.null()]), date: isoDateString.optional(), source: text(3, 500).optional() }).strict();
const simulation = z.object({
  label: text(3, 200), opportunityId: text(1, 60).optional(), commune: commune.optional(), targets: z.number().int().min(1).max(10_000_000),
  averageDue: moneySchema, complianceProbability: z.string(), collectionSpeed: z.string(), censusCostPerTarget: moneySchema, controlCostPerTarget: moneySchema,
  contestRisk: moneySchema, socialRisk: moneySchema, hypotheses: z.array(z.object({ text: text(5, 1000), source: text(3, 500), date: isoDateString }).strict()).min(1).max(20),
}).strict();
const source = z.object({ kind: z.enum(SOURCE_KINDS), partnerName: text(2, 200), description: text(5, 1000) }).strict();
const protocol = z.object({ reference: text(3, 200), signedOn: isoDateString, signatories: text(3, 500), documentSha256: sha256 }).strict();
const compliance = z.object({
  personalData: z.boolean(), lawfulBasis: text(5, 1000), minimisation: text(3, 1000), retention: text(3, 500), security: text(3, 1000),
  conclusion: z.enum(['CONFORME', 'NON_CONFORME']), note: z.string().max(2000),
}).strict();
const reason = z.object({ reason: text(5, 2000) }).strict();
const RECORDS: Record<SourceKind, z.ZodTypeAny> = {
  LIVRAISONS_BRASSERIE: z.object({ pointRef: text(1, 100), commune, quartier: text(1, 60).optional(), lat, lon, deliveries: z.number().int().min(1).max(100_000), period: text(4, 20).optional() }).strict(),
  CODES_MARCHANDS_MOMO: z.object({ merchantRef: text(1, 100), commune, quartier: text(1, 60).optional(), lat, lon, active: z.boolean(), lastActivity: isoDateString }).strict(),
  LECTURES_PLAQUES: z.object({ plate: text(2, 20), checkpoint: text(2, 200), commune, readAt: z.string().datetime({ offset: true }) }).strict(),
  SOUMISSIONS_AUTORISATIONS: z.object({ taxpayerId: text(1, 60), service: z.enum(['MARCHE_PUBLIC', 'AUTORISATION']), reference: text(1, 100), commune: commune.optional() }).strict(),
  DECLARATIONS_IMMEUBLES: z.object({
    buildingRef: text(1, 100), buildingObjectId: text(1, 60).optional(), commune, quartier: text(1, 60).optional(), lat, lon, units: z.number().int().min(2).max(5000),
    anomalies: z.array(z.enum(['VACANT_DECLARE', 'BAUX_EXPIRES', 'LOYERS_ATYPIQUES', 'DOUBLONS'])).max(4), detail: z.string().max(1000).optional(),
  }).strict(),
};
const review = z.object({ decision: z.enum(['VERIFICATION_REQUISE', 'SANS_SUITE']), reason: text(5, 2000), localityRank: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional() }).strict();
const mission = z.object({ dueDate: isoDateString, instructions: z.string().max(2000).optional() }).strict();
const params = z.object({
  merchantMatchRadiusM: z.number().int().min(5).max(500).optional(), expiryHorizonDays: z.number().int().min(1).max(365).optional(),
  forecastWeeks: z.number().int().min(1).max(52).optional(), quitusActInstrumentId: text(1, 100).nullable().optional(), reason: text(5, 1000),
}).strict();

export function registerOpportunitesRoutes(app: FastifyInstance, _ctx: AppContext, svc: OpportunitesService): void {
  // Registre, grille et pipeline (§ 8.1 – § 8.4)
  app.get('/v1/opportunites/pipeline', async (req) => svc.pipeline(requireUser(req)));
  app.get('/v1/opportunites/decouverte/champ', async (req) => svc.discoveryScope(requireUser(req)));
  app.get('/v1/opportunites/decouverte/signaux-ia', async (req) => svc.iaSignals(requireUser(req)));
  app.get<{ Querystring: { section?: string; status?: string; domain?: string } }>('/v1/opportunites', async (req) => ({ items: svc.list(requireUser(req), req.query) }));
  app.post('/v1/opportunites', async (req, reply) => reply.code(201).send(svc.createSignal(requireUser(req), parse(signal, req.body))));
  app.get<P>('/v1/opportunites/:id', async (req) => svc.get(requireUser(req), req.params.id));
  app.post<{ Params: { id: string; n: string } }>('/v1/opportunites/:id/etapes/:n', async (req) => svc.completeStep(requireUser(req), req.params.id, Number(req.params.n), parse(step, req.body)));
  app.post<P>('/v1/opportunites/:id/decision', async (req) => svc.decide(requireUser(req), req.params.id, parse(decision, req.body)));
  app.put<{ Params: { id: string; field: string } }>('/v1/opportunites/:id/grille/:field', async (req) => svc.setGridField(requireUser(req), req.params.id, req.params.field, parse(gridBody, req.body)));
  app.post<P>('/v1/opportunites/:id/hypotheses', async (req, reply) => reply.code(201).send(svc.addHypothesis(requireUser(req), req.params.id, parse(hypothesis, req.body))));

  // Maximisation (§ 8.7) et leviers (§ 8.6)
  app.put<{ Params: { id: string; key: string } }>('/v1/opportunites/:id/maximisation/:key', async (req) => {
    const key = req.params.key as (typeof MAX_INPUT_KEYS)[number] | 'revenueKind';
    return svc.setMaxInput(requireUser(req), req.params.id, key, parse(maxInput, req.body));
  });
  app.get('/v1/opportunites-maximisation/classement', async (req) => svc.ranking(requireUser(req)));
  app.get('/v1/opportunites-maximisation/cas-usage', async (req) => svc.useCases(requireUser(req)));
  app.post('/v1/opportunites-maximisation/simulations', async (req, reply) => reply.code(201).send(svc.simulate(requireUser(req), parse(simulation, req.body))));
  app.get('/v1/opportunites-leviers', async (req) => svc.levers(requireUser(req)));

  // Recoupement (§ 8.5)
  app.get('/v1/recoupement/sources', async (req) => ({ items: svc.listSources(requireUser(req)) }));
  app.post('/v1/recoupement/sources', async (req, reply) => reply.code(201).send(svc.createSource(requireUser(req), parse(source, req.body))));
  app.post<P>('/v1/recoupement/sources/:id/protocole', async (req) => svc.recordProtocol(requireUser(req), req.params.id, parse(protocol, req.body)));
  app.post<P>('/v1/recoupement/sources/:id/conformite', async (req) => svc.recordCompliance(requireUser(req), req.params.id, parse(compliance, req.body)));
  app.post<P>('/v1/recoupement/sources/:id/suspendre', async (req) => svc.suspendSource(requireUser(req), req.params.id, parse(reason, req.body).reason));
  app.post<P>('/v1/recoupement/sources/:id/lots', async (req, reply) => {
    const user = requireUser(req);
    const kind = svc.sources.get(req.params.id)?.kind;
    const body = parse(z.object({ records: z.array(kind ? RECORDS[kind] : z.unknown()).min(1).max(5000) }).strict(), req.body);
    return reply.code(201).send(svc.ingest(user, req.params.id, body.records as IngestRecord[]));
  });
  app.get<{ Querystring: { status?: string; ruleCode?: string; commune?: string } }>('/v1/recoupement/liste-travail', async (req) => svc.listWorklist(requireUser(req), req.query));
  app.post<P>('/v1/recoupement/liste-travail/:id/examen', async (req) => svc.review(requireUser(req), req.params.id, parse(review, req.body)));
  app.post<P>('/v1/recoupement/liste-travail/:id/mission', async (req, reply) => reply.code(201).send(svc.openMission(requireUser(req), req.params.id, parse(mission, req.body))));
  app.get<{ Params: { plaque: string }; Querystring: { commune?: string } }>('/v1/recoupement/plaques/:plaque', async (req) => svc.plateStatus(requireUser(req), req.params.plaque, req.query.commune));
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/recoupement/blocages', async (req) => ({ items: svc.listBlocks(requireUser(req), req.query.taxpayerId) }));
  app.post<P>('/v1/recoupement/blocages/:id/reexamen', async (req) => svc.recheckBlock(requireUser(req), req.params.id));
  app.get('/v1/recoupement/parametres', async (req) => { requireUser(req); return svc.crossParams; });
  app.put('/v1/recoupement/parametres', async (req) => svc.setParams(requireUser(req), parse(params, req.body)));
}
