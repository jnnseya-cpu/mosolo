/**
 * Routes des extensions du module fiscal : anomalies locatives (§ 16.4), élargissement d'assiette 2026 (§ 16.3),
 * dépendances entre services (§ 8.1, § 10A.3), recensement et provenance (§ 17.4), reprise e-DGRK (§ 7.5),
 * enrôlement par profil (§ 9.3). Toute décision d'accès passe par la politique (`authorize`) côté serveur.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, type User } from '../../core/auth.js';
import { isoDateString, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { CENSUS_STAGES, PROVENANCE_SOURCES, type CensusStage } from '../../modules/objects/service.js';
import type { AppContext } from '../../context.js';
import { PARTNER_SOURCES, SOURCE_LABELS, type PartnerSource } from './anomalies.js';
import { ASSIETTE_2026_CASES } from './assiette2026.js';
import { CENSUS_STAGE_LABELS } from './census.js';
import { DEPENDENT_SERVICES } from './dependencies.js';
import { IMPORT_COLUMNS, IMPORT_SOURCES } from './imports.js';
import type { FiscalService } from './service.js';

type P = { Params: { id: string } };
const reason = z.string().trim().min(3).max(1000);

/** Contribuable visé : soi-même (R30), un mandant (R31), ou celui indiqué par un agent. */
function subjectOf(user: User, given?: string): string | undefined {
  if (given) return given;
  if (user.roles.includes('R30')) return user.taxpayerId;
  if (user.roles.includes('R31')) return user.mandants?.[0];
  return undefined;
}

export function registerFiscalExtraRoutes(app: FastifyInstance, _ctx: AppContext, svc: FiscalService): void {
  // ——— § 16.4 Anomalies locatives ———
  app.get('/v1/fiscal/anomalies/catalogue', async (req) => {
    authorize(requireUser(req), 'fiscal:anomaly.read');
    return { signals: svc.anomalies.catalogue(), sources: PARTNER_SOURCES.map((s) => ({ code: s, label: SOURCE_LABELS[s], protocol: svc.anomalies.protocolStatus(s) })) };
  });
  app.get<{ Querystring: { signal?: string; status?: string; commune?: string } }>('/v1/fiscal/anomalies', async (req) => svc.anomalies.list(requireUser(req), req.query));
  app.post('/v1/fiscal/anomalies/detection', async (req) => svc.anomalies.detect(requireUser(req)));
  app.post<P>('/v1/fiscal/anomalies/:id/review', async (req) => {
    const b = parse(z.object({ decision: z.enum(['EN_VERIFICATION', 'CONFIRMEE', 'ECARTEE']), reason, missionRef: z.string().trim().max(60).optional() }).strict(), req.body);
    return svc.anomalies.view(svc.anomalies.review(requireUser(req), req.params.id, { decision: b.decision, reason: b.reason, ...(b.missionRef ? { missionRef: b.missionRef } : {}) }));
  });
  app.get('/v1/fiscal/data-protocols', async (req) => {
    authorize(requireUser(req), 'fiscal:data-protocol.read');
    return { items: svc.anomalies.protocols.all().reverse(), lots: svc.anomalies.lots.all().reverse() };
  });
  app.post('/v1/fiscal/data-protocols', async (req, reply) => {
    const b = parse(z.object({ source: z.enum(PARTNER_SOURCES), partner: z.string().trim().min(2).max(120), actReference: z.string().trim().min(3).max(200), purpose: z.string().trim().min(5).max(500), validFrom: isoDateString, validTo: isoDateString }).strict(), req.body);
    return reply.code(201).send(svc.anomalies.proposeProtocol(requireUser(req), b));
  });
  app.post<P>('/v1/fiscal/data-protocols/:id/decision', async (req) => {
    const b = parse(z.object({ approve: z.boolean(), reason }).strict(), req.body);
    return svc.anomalies.decideProtocol(requireUser(req), req.params.id, b);
  });
  app.post<{ Params: { source: string } }>('/v1/fiscal/partner-data/:source/lots', async (req, reply) => {
    const source = parse(z.enum(PARTNER_SOURCES), req.params.source) as PartnerSource;
    const b = parse(z.object({ records: z.array(z.unknown()).min(1).max(5000) }).strict(), req.body);
    return reply.code(201).send(svc.anomalies.ingest(requireUser(req), source, b.records));
  });

  // ——— § 16.3 Élargissement d'assiette 2026 ———
  app.get('/v1/fiscal/assiette-2026', async () => ({ cases: svc.assiette2026.catalogue(), notice: 'Règles au statut À VÉRIFIER : aucune n’est active ; aucune liquidation.' }));
  app.post('/v1/fiscal/assiette-2026/declarations', async (req, reply) => {
    const b = parse(z.object({ case: z.enum(ASSIETTE_2026_CASES), taxpayerId: z.string().optional(), objectId: z.string().optional(), period: z.string().regex(/^\d{4}$/), values: z.record(z.string().max(200)), attest: z.boolean() }).strict(), req.body);
    const { taxpayerId, objectId, ...rest } = b;
    return reply.code(201).send(svc.assiette2026.declare(requireUser(req), { ...rest, ...(taxpayerId ? { taxpayerId } : {}), ...(objectId ? { objectId } : {}) }));
  });
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/fiscal/assiette-2026/declarations', async (req) => {
    const user = requireUser(req);
    return svc.assiette2026.list(user, subjectOf(user, req.query.taxpayerId));
  });

  // ——— § 8.1 / § 10A.3 Dépendances entre services (quitus, vignette) ———
  app.get('/v1/public/fiscal/dependances', async () => ({ services: svc.dependencies.publicCatalogue(), notice: 'Conditions visibles de tous (§ 10A.3). « Informatif » : la condition est indiquée mais ne bloque pas tant que l’acte n’est pas publié.' }));
  app.get('/v1/fiscal/dependencies', async (req) => svc.dependencies.agentView(requireUser(req)));
  app.post('/v1/fiscal/dependencies/check', async (req) => {
    const user = requireUser(req);
    const b = parse(z.object({ service: z.enum(DEPENDENT_SERVICES), taxpayerId: z.string().optional(), plate: z.string().trim().max(20).optional() }).strict(), req.body);
    const tp = subjectOf(user, b.taxpayerId);
    if (!tp) authorize(user, 'fiscal:dependency.check', {});
    return svc.dependencies.check(user, b.service, tp!, b.plate ? { plate: b.plate } : {});
  });
  app.post<{ Params: { code: string } }>('/v1/fiscal/dependencies/:code/change', async (req, reply) => {
    const b = parse(z.object({ targetMode: z.enum(['INFORMATIF', 'BLOQUANT']), instrumentId: z.string().min(1), article: z.string().trim().max(200).optional(), reason }).strict(), req.body);
    return reply.code(201).send(svc.dependencies.proposeChange(requireUser(req), req.params.code, { targetMode: b.targetMode, instrumentId: b.instrumentId, reason: b.reason, ...(b.article ? { article: b.article } : {}) }));
  });
  app.post<{ Params: { code: string } }>('/v1/fiscal/dependencies/:code/change/decision', async (req) => {
    const b = parse(z.object({ approve: z.boolean(), reason }).strict(), req.body);
    return svc.dependencies.decideChange(requireUser(req), req.params.code, b);
  });

  // ——— § 17.4 Recensement : vagues et provenance ———
  app.get<{ Querystring: { commune?: string } }>('/v1/fiscal/census/coverage', async (req) => svc.census.coverage(requireUser(req), req.query.commune));
  app.get('/v1/fiscal/census/stages', async () => CENSUS_STAGES.map((s) => ({ stage: s, ...CENSUS_STAGE_LABELS[s] })));
  app.post<P>('/v1/fiscal/objects/:id/census-stage', async (req) => {
    const b = parse(z.object({ to: z.number().int().min(0).max(5), reason }).strict(), req.body);
    const user = requireUser(req);
    return svc.objectView(svc.census.advance(user, req.params.id, { to: b.to as CensusStage, reason: b.reason }), user, []);
  });
  app.post<P>('/v1/fiscal/objects/:id/provenance', async (req) => {
    const b = parse(z.object({ field: z.string().min(1).max(60), source: z.enum(PROVENANCE_SOURCES), sourceLabel: z.string().trim().max(120).optional(), confidence: z.enum(['FAIBLE', 'MOYENNE', 'ELEVEE']), verifiedAt: isoDateString.optional() }).strict(), req.body);
    const user = requireUser(req);
    const { sourceLabel, verifiedAt, ...rest } = b;
    return svc.objectView(svc.census.recordProvenance(user, req.params.id, { ...rest, ...(sourceLabel ? { sourceLabel } : {}), ...(verifiedAt ? { verifiedAt } : {}) }), user, []);
  });

  // ——— § 2 / § 7.5 Reprise e-DGRK et import par lots ———
  app.get('/v1/fiscal/imports/format', async () => ({ sources: Object.entries(IMPORT_SOURCES).map(([code, label]) => ({ code, label })), columns: IMPORT_COLUMNS, types: ['COMPTE', 'OBJET', 'HISTORIQUE'] }));
  app.get('/v1/fiscal/imports', async (req) => {
    authorize(requireUser(req), 'fiscal:import.read');
    return svc.imports.batches.all().reverse().map((b) => svc.imports.view(b));
  });
  app.get<P>('/v1/fiscal/imports/:id', async (req) => {
    authorize(requireUser(req), 'fiscal:import.read');
    return svc.imports.view(svc.imports.get(req.params.id));
  });
  app.post('/v1/fiscal/imports', async (req, reply) => {
    const b = parse(z.object({ source: z.enum(Object.keys(IMPORT_SOURCES) as [keyof typeof IMPORT_SOURCES, ...(keyof typeof IMPORT_SOURCES)[]]), format: z.enum(['CSV', 'JSON']), content: z.union([z.string().max(900_000), z.array(z.record(z.unknown())).max(10_000)]) }).strict(), req.body);
    return reply.code(201).send(svc.imports.view(svc.imports.upload(requireUser(req), b as Parameters<typeof svc.imports.upload>[1])));
  });
  app.post<P>('/v1/fiscal/imports/:id/commit', async (req) => svc.imports.view(svc.imports.commit(requireUser(req), req.params.id)));
  app.post<{ Params: { id: string; line: string } }>('/v1/fiscal/imports/:id/duplicates/:line/decision', async (req) => {
    const b = parse(z.object({ decision: z.enum(['RATTACHER', 'CREER_DISTINCT']), reason }).strict(), req.body);
    return svc.imports.view(svc.imports.decideDuplicate(requireUser(req), req.params.id, Number(req.params.line), b));
  });

  // ——— § 9.3 Enrôlement par profil, espaces, NIF, récupération ———
  app.get('/v1/public/enrolement/profils', async () => ({ profiles: svc.enrolment.profiles(), notice: 'Déclarer un rôle n’établit ni la propriété ni une dette : cela ouvre une instruction.' }));
  app.post('/v1/enrolement/roles', async (req, reply) => {
    const b = parse(z.object({ taxpayerId: z.string().optional(), profile: z.string().min(2).max(40), answers: z.record(z.string().max(200)).default({}) }).strict(), req.body);
    return reply.code(201).send(svc.enrolment.declare(requireUser(req), { profile: b.profile, answers: b.answers, ...(b.taxpayerId ? { taxpayerId: b.taxpayerId } : {}) }));
  });
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/enrolement/roles', async (req) => {
    const user = requireUser(req);
    const tp = subjectOf(user, req.query.taxpayerId);
    return { items: svc.enrolment.list(user, tp), nif: tp ? svc.enrolment.nifOf(tp) : svc.enrolment.nifRequests.all() };
  });
  app.post<P>('/v1/enrolement/roles/:id/instruction', async (req) => {
    const b = parse(z.object({ decision: z.enum(['CONFIRMEE', 'REJETEE', 'COMPLEMENT_DEMANDE']), reason }).strict(), req.body);
    return svc.enrolment.instruct(requireUser(req), req.params.id, b);
  });
  app.post<P>('/v1/enrolement/nif/:id', async (req) => {
    const b = parse(z.object({ status: z.enum(['TRANSMISE', 'ATTRIBUEE', 'REJETEE']), nif: z.string().trim().min(3).max(40).optional(), note: reason }).strict(), req.body);
    return svc.enrolment.updateNif(requireUser(req), req.params.id, { status: b.status, note: b.note, ...(b.nif ? { nif: b.nif } : {}) });
  });
  app.get('/v1/enrolement/espaces', async (req) => svc.enrolment.spaces(requireUser(req)));
  app.post('/v1/public/enrolement/recuperations', async (req, reply) => {
    const b = parse(z.object({ iuc: z.string().trim().min(5).max(30), newPhone: z.string().regex(/^\+?[0-9 -]{9,20}$/), idDocumentRef: z.string().trim().min(3).max(60) }).strict(), req.body);
    return reply.code(202).send(svc.enrolment.requestRecovery(b));
  });
  app.get('/v1/enrolement/recuperations', async (req) => svc.enrolment.pendingRecoveries(requireUser(req)));
  app.post<P>('/v1/enrolement/recuperations/:id/verification', async (req) => svc.enrolment.verifyRecovery(requireUser(req), req.params.id, parse(z.object({ note: reason }).strict(), req.body)));
  app.post<P>('/v1/enrolement/recuperations/:id/decision', async (req) => svc.enrolment.decideRecovery(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), reason }).strict(), req.body)));
}
