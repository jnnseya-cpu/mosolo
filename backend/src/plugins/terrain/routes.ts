/**
 * Routes HTTP du module terrain. Les corps sont validés strictement (champ inconnu ⇒ 400) : aucun champ
 * de montant, d'encaissement ou de binaire photo n'est accepté.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { ApiError } from '../../core/errors.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { OBJECT_CATEGORIES } from '../../modules/objects/service.js';
import { TERRAIN_MODULES } from './model.js';
import type { TerrainService } from './service.js';

const moduleEnum = z.enum(TERRAIN_MODULES);
const commune = z.string().trim().min(2).max(40);
const reasonSchema = z.object({ reason: z.string().trim().min(5).max(2000) }).strict();
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/, 'empreinte SHA-256 hexadécimale attendue (64 caractères) — jamais le fichier');
// `source` : GPS mesuré, point ajusté à la main (MANUEL) ou position de repli (ZONE) — signalé au vérificateur.
const gps = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000), source: z.enum(['GPS', 'MANUEL', 'ZONE']).optional() }).strict();
const photoRef = z.string().trim().min(1).max(300).refine((s) => !s.startsWith('data:'), 'référence de document attendue, jamais le binaire de la photo');

const inviteSubcontractor = z.object({
  name: z.string().trim().min(2).max(200), selectionReference: z.string().trim().min(3).max(200),
  requestedModules: z.array(moduleEnum).min(1), capacityAgents: z.number().int().min(1).max(2000), managerName: z.string().trim().min(2).max(120),
}).strict();
const dossier = z.object({
  rccm: z.string().trim().min(3).max(100), nif: z.string().trim().min(3).max(100), references: z.string().max(2000).optional(),
  capacityAgents: z.number().int().min(1).max(2000).optional(), requestedModules: z.array(moduleEnum).min(1).optional(),
}).strict();
const diligence = z.object({
  legalExistence: z.boolean(), taxClearance: z.boolean(), noConflictOfInterest: z.boolean(), publicAgentLinksDeclared: z.boolean(), notes: z.string().max(2000).optional(),
}).strict();
const proposal = z.object({
  modules: z.array(moduleEnum).min(1), communes: z.array(commune).min(1), validUntil: isoDateString, probationUntil: isoDateString, reason: z.string().trim().min(5).max(2000),
}).strict();
const contract = z.object({
  reference: z.string().trim().min(3).max(200), validatedFinding: moneySchema, missionOnTime: moneySchema, example: z.boolean(),
}).strict();
const lot = z.object({
  subcontractorId: z.string().optional(), module: moduleEnum, commune, quartiers: z.array(z.string().trim().min(1).max(60)).default([]),
  periodStart: isoDateString, periodEnd: isoDateString, maxAgents: z.number().int().min(1).max(500),
}).strict();
const inviteAgent = z.object({
  displayName: z.string().trim().min(2).max(80), declaredQuartiers: z.array(z.string().max(60)).optional(),
  declaredObjectIds: z.array(z.string().max(60)).optional(), photoRef: photoRef.optional(),
}).strict();
const habilitation = z.object({
  identityVerified: z.boolean(), trainingCertificateRef: z.string().trim().max(120), trainingValidUntil: isoDateString, ethicsSigned: z.boolean(),
  deviceId: z.string().trim().min(3).max(100).optional(), module: moduleEnum, communes: z.array(commune).min(1), validUntil: isoDateString,
}).strict();
const mission = z.object({
  lotId: z.string().optional(), module: moduleEnum.optional(), kind: z.enum(['RECENSEMENT', 'CONTROLE', 'ENROLEMENT_ASSISTE', 'CONTRE_VISITE']).optional(),
  title: z.string().trim().min(3).max(200), commune, quartier: z.string().trim().min(1).max(60).optional(),
  center: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict().optional(),
  radiusM: z.number().int().min(20).max(20_000).optional(), objectIds: z.array(z.string()).max(500).optional(),
  objectives: z.object({ findings: z.number().int().min(1).max(10_000), objects: z.number().int().min(0).max(10_000).optional() }).strict(),
  instructions: z.string().max(4000).optional(), periodStart: isoDateString, dueDate: isoDateString,
}).strict();
const finding = z.object({
  clientRef: z.string().trim().min(1).max(100), objectId: z.string().max(60).optional(),
  outcome: z.enum(['CONSTATE', 'ABSENT', 'REFUS', 'OBJET_NON_ENREGISTRE']), observations: z.string().max(2000),
  gps, photoSha256: sha256.optional(), capturedAt: z.string().datetime({ offset: true }), deviceId: z.string().max(100).optional(),
  justification: z.string().trim().max(1000).optional(),
  // Catégorie de l'objet non enregistré (Document maître FR 2, ch. 43 : « objet provisoire avec GPS, photo, catégorie »).
  category: z.enum(OBJECT_CATEGORIES).optional(),
}).strict();
const review = z.object({ decision: z.enum(['VALIDE', 'REJETE']), reason: z.string().trim().min(5).max(2000) }).strict();
const sample = z.object({
  subcontractorId: z.string().optional(), agentId: z.string().optional(), missionId: z.string().optional(), ratePercent: z.number().int().min(1).max(100),
}).strict();
const assign = z.object({ agentId: z.string().min(1) }).strict();
const counterResult = z.object({ result: z.enum(['CONFORME', 'NON_CONFORME']), notes: z.string().trim().min(3).max(2000), gps, photoSha256: sha256.optional() }).strict();
const mysteryPlan = z.object({ targetKind: z.enum(['AGENT', 'SOUS_TRAITANT']), targetId: z.string().min(1), plannedFor: isoDateString }).strict();
const mysteryResult = z.object({ result: z.enum(['SANS_IRREGULARITE', 'IRREGULARITE']), notes: z.string().trim().min(3).max(2000) }).strict();
const tolerance = z.object({ meters: z.number().int().min(5).max(1000), reason: z.string().trim().min(5).max(2000) }).strict();
const report = z.object({
  kind: z.enum(['FAUX_AGENT', 'HORS_ZONE', 'DEMANDE_ESPECES']), place: z.string().trim().min(2).max(200), description: z.string().trim().max(2000).default(''),
}).strict();

type P = { Params: { id: string } };

/** Limitation de débit des vérifications publiques (anti-énumération), par poste, en mémoire. */
class PublicGate {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  admit(key: string, limit = 30, windowMs = 60_000): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }
}

export function registerTerrainRoutes(app: FastifyInstance, ctx: AppContext, svc: TerrainService): void {
  const gate = new PublicGate(() => ctx.clock.now().getTime());
  const guard = (req: FastifyRequest) => {
    if (!gate.admit(req.ip || 'inconnu')) throw new ApiError(429, 'VERIFICATION_RATE_LIMITED', 'Trop de vérifications depuis ce poste : réessayez dans un instant.');
  };

  // ── Espace de l'agent
  app.get('/v1/terrain/me', async (req) => svc.me(requireUser(req)));

  // ── Sous-traitants
  app.get('/v1/terrain/subcontractors', async (req) => ({ items: svc.listSubcontractors(requireUser(req)) }));
  app.post('/v1/terrain/subcontractors', async (req, reply) => reply.code(201).send(svc.inviteSubcontractor(requireUser(req), parse(inviteSubcontractor, req.body))));
  app.get<P>('/v1/terrain/subcontractors/:id', async (req) => svc.getSubcontractor(requireUser(req), req.params.id));
  app.post<P>('/v1/terrain/subcontractors/:id/dossier', async (req) => svc.submitDossier(requireUser(req), req.params.id, parse(dossier, req.body)));
  app.post<P>('/v1/terrain/subcontractors/:id/diligence', async (req) => svc.recordDiligence(requireUser(req), req.params.id, parse(diligence, req.body)));
  app.post<P>('/v1/terrain/subcontractors/:id/accreditation/propose', async (req) => svc.proposeAccreditation(requireUser(req), req.params.id, parse(proposal, req.body)));
  app.post<P>('/v1/terrain/subcontractors/:id/accreditation/approve', async (req) => svc.approveAccreditation(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.post<P>('/v1/terrain/subcontractors/:id/accreditation/confirm', async (req) => svc.confirmAccreditation(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.put<P>('/v1/terrain/subcontractors/:id/contract', async (req) => svc.setContract(requireUser(req), req.params.id, parse(contract, req.body)));
  app.post<P>('/v1/terrain/subcontractors/:id/suspend', async (req) => svc.suspendSubcontractor(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.post<P>('/v1/terrain/subcontractors/:id/reinstate', async (req) => svc.reinstateSubcontractor(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.post<P>('/v1/terrain/subcontractors/:id/withdraw', async (req) => svc.withdrawSubcontractor(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.get<P>('/v1/terrain/subcontractors/:id/remuneration', async (req) => svc.remuneration(requireUser(req), req.params.id));
  app.post<P>('/v1/terrain/subcontractors/:id/agents', async (req, reply) => reply.code(201).send(svc.inviteAgent(requireUser(req), req.params.id, parse(inviteAgent, req.body))));

  // ── Lots
  app.get('/v1/terrain/lots', async (req) => ({ items: svc.listLots(requireUser(req)) }));
  app.post('/v1/terrain/lots', async (req, reply) => reply.code(201).send(svc.createLot(requireUser(req), parse(lot, req.body))));
  app.post<P>('/v1/terrain/lots/:id/close', async (req) => svc.closeLot(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));

  // ── Agents et badges
  app.get('/v1/terrain/agents', async (req) => ({ items: svc.listAgents(requireUser(req)) }));
  app.post('/v1/terrain/agents', async (req, reply) => reply.code(201).send(svc.inviteAgent(requireUser(req), undefined, parse(inviteAgent, req.body))));
  app.post<P>('/v1/terrain/agents/:id/habilitation', async (req) => svc.habilitateAgent(requireUser(req), req.params.id, parse(habilitation, req.body)));
  app.post<P>('/v1/terrain/agents/:id/suspend', async (req) => svc.suspendAgent(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.post<P>('/v1/terrain/agents/:id/revoke', async (req) => svc.revokeAgent(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.post<P>('/v1/terrain/agents/:id/badge/reissue', async (req) => svc.reissueBadge(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));

  // ── Missions et constats
  app.get<{ Querystring: { status?: string; commune?: string } }>('/v1/terrain/missions', async (req) => ({
    items: svc.listMissions(requireUser(req), {
      ...(req.query.status ? { status: req.query.status as never } : {}), ...(req.query.commune ? { commune: req.query.commune } : {}),
    }),
  }));
  app.post('/v1/terrain/missions', async (req, reply) => reply.code(201).send(svc.createMission(requireUser(req), parse(mission, req.body))));
  app.get<P>('/v1/terrain/missions/:id', async (req) => svc.getMission(requireUser(req), req.params.id));
  app.post<P>('/v1/terrain/missions/:id/assignment', async (req) => svc.assignMission(requireUser(req), req.params.id, parse(assign, req.body).agentId));
  app.post<P>('/v1/terrain/missions/:id/complete', async (req) => svc.completeMission(requireUser(req), req.params.id));
  app.post<P>('/v1/terrain/missions/:id/cancel', async (req) => svc.cancelMission(requireUser(req), req.params.id, parse(reasonSchema, req.body).reason));
  app.post<P>('/v1/terrain/missions/:id/findings', async (req, reply) => {
    const r = svc.submitFinding(requireUser(req), req.params.id, parse(finding, req.body));
    return reply.code(r.replayed ? 200 : 201).send(r);
  });
  app.get<{ Querystring: { missionId?: string; status?: string; agentId?: string; flagged?: string } }>('/v1/terrain/findings', async (req) => ({
    items: svc.listFindings(requireUser(req), {
      ...(req.query.missionId ? { missionId: req.query.missionId } : {}), ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.agentId ? { agentId: req.query.agentId } : {}), ...(req.query.flagged !== undefined ? { flagged: req.query.flagged === 'true' } : {}),
    }),
  }));
  app.post<P>('/v1/terrain/findings/:id/review', async (req) => {
    const b = parse(review, req.body);
    return svc.reviewFinding(requireUser(req), req.params.id, b.decision, b.reason);
  });

  // ── Contrôle qualité
  app.get('/v1/terrain/quality', async (req) => svc.qualityBoard(requireUser(req)));
  app.post('/v1/terrain/quality/samples', async (req, reply) => reply.code(201).send(svc.createSample(requireUser(req), parse(sample, req.body))));
  app.get('/v1/terrain/counter-visits', async (req) => ({ items: svc.listCounterVisits(requireUser(req)) }));
  app.post<P>('/v1/terrain/counter-visits/:id/assignment', async (req) => svc.assignCounterVisit(requireUser(req), req.params.id, parse(assign, req.body).agentId));
  app.post<P>('/v1/terrain/counter-visits/:id/result', async (req) => svc.performCounterVisit(requireUser(req), req.params.id, parse(counterResult, req.body)));

  // ── Contrôles mystère
  app.get('/v1/terrain/mystery-checks', async (req) => ({ items: svc.listMysteryChecks(requireUser(req)) }));
  app.post('/v1/terrain/mystery-checks', async (req, reply) => reply.code(201).send(svc.planMysteryCheck(requireUser(req), parse(mysteryPlan, req.body))));
  app.post<P>('/v1/terrain/mystery-checks/:id/result', async (req) => svc.recordMysteryCheck(requireUser(req), req.params.id, parse(mysteryResult, req.body)));

  // ── Indicateurs et paramètres
  app.get('/v1/terrain/indicators', async (req) => svc.indicators(requireUser(req)));
  app.get('/v1/terrain/settings/gps-tolerance', async (req) => {
    requireUser(req);
    return svc.tolerancesView();
  });
  app.put<{ Params: { commune: string } }>('/v1/terrain/settings/gps-tolerance/:commune', async (req) => {
    const b = parse(tolerance, req.body);
    return svc.setTolerance(requireUser(req), req.params.commune, b.meters, b.reason);
  });

  // ── Public (sans authentification) : vérification de badge, signalement, résultats agrégés des contrôles mystère
  app.get<{ Params: { code: string }; Querystring: { t?: string; channel?: string } }>('/v1/public/agent-badges/:code', async (req) => {
    guard(req);
    const channel = (['WEB', 'SMS', 'SVI', 'SCAN'] as const).find((c) => c === req.query.channel) ?? (req.query.t ? 'SCAN' : 'WEB');
    return svc.publicVerify(req.params.code, req.query.t, channel);
  });
  app.post<{ Params: { code: string } }>('/v1/public/agent-badges/:code/reports', async (req, reply) => {
    guard(req);
    return reply.code(201).send(svc.reportAgent(req.params.code, parse(report, req.body)));
  });
  app.get('/v1/public/terrain/mystery-checks/summary', async () => svc.publicMysterySummary());
}
