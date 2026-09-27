import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from '../../core/auth.js';
import { requireUser } from '../../core/auth.js';
import { badRequest, forbidden } from '../../core/errors.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize, evaluate, hasAnyGrant } from '../../core/policy.js';
import type { AppContext } from '../../context.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { DECLARATION_KINDS, KIND_LABELS } from './declarations.js';
import type { GeoLevel } from './geo.js';
import { CLOSE_REASONS, PROOF_TYPES, RELATION_ROLES, ROLE_LABELS } from './relations.js';
import type { FiscalService } from './service.js';
import { buildNearby } from './nearby.js';
import { registerFiscalExtraRoutes } from './routes-extra.js';

const proofSchema = z.object({ type: z.enum(PROOF_TYPES), reference: z.string().trim().min(3).max(200), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
const decimal = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/, 'nombre décimal positif en chaîne attendu');
// Pièce justificative d'une correction : même forme que les justificatifs du Trésor (libellé, empreinte SHA-256 facultative).
const correctionEvidenceSchema = z.object({
  label: z.string().trim().min(3).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue').optional(),
}).strict();
const rankSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const relationSchema = z.object({
  taxpayerId: z.string().optional(),
  objectId: z.string(),
  role: z.enum(RELATION_ROLES),
  share: z.string().optional(),
  from: isoDateString,
  to: isoDateString.optional(),
  proofs: z.array(proofSchema).max(10),
}).strict();

const declarationSchema = z.object({
  objectId: z.string(),
  kind: z.enum(DECLARATION_KINDS),
  period: z.string().regex(/^\d{4}$/),
  inputs: z.record(decimal).default({}),
  attest: z.boolean(),
  // Pièce justificative FACULTATIVE (Document maître FR 2, ch. 43) : empreinte, nom et type ; jamais exigée.
  piece: z.object({
    name: z.string().trim().min(1).max(200), mediaType: z.string().trim().min(3).max(100),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'empreinte SHA-256 attendue'), sizeBytes: z.number().int().nonnegative().max(50_000_000).optional(),
  }).strict().optional(),
}).strict();

const legalBasisSchema = z.object({ instrumentId: z.string().min(1), article: z.string().trim().min(1).max(200) }).strict();

const exemptionSchema = z.object({
  taxpayerId: z.string().optional(),
  kind: z.enum(['EXONERATION', 'REMISE']),
  objectId: z.string().optional(),
  ruleCode: z.string().optional(),
  revenueCategory: z.string().optional(),
  obligationId: z.string().optional(),
  amount: moneySchema.optional(),
  rate: z.string().optional(),
  grounds: z.string().trim().min(10).max(2000),
  proofs: z.array(z.object({ type: z.string().trim().min(2).max(60), reference: z.string().trim().min(3).max(200) }).strict()).max(10),
  legalBasis: legalBasisSchema.optional(),
  validFrom: isoDateString,
  validTo: isoDateString.optional(),
}).strict();

/** Contribuables dont l'utilisateur voit les données (soi-même ou mandants). */
function viewerTaxpayers(user: User): string[] {
  if (user.roles.includes('R30')) return user.taxpayerId ? [user.taxpayerId] : [];
  if (user.roles.includes('R31')) return user.mandants ?? [];
  return [];
}

function optionalUser(req: FastifyRequest): User | undefined {
  return req.user;
}

export function registerFiscalRoutes(app: FastifyInstance, ctx: AppContext, svc: FiscalService): void {
  // ——— Référentiels (publics, sans donnée personnelle) ———
  app.get<{ Querystring: { level?: GeoLevel; parentId?: string; commune?: string } }>('/v1/fiscal/geo-units', async (req) => {
    const { level, parentId, commune } = req.query;
    if (level && !['COMMUNE', 'QUARTIER', 'AVENUE'].includes(level)) throw badRequest('INVALID_LEVEL', 'Niveau attendu : COMMUNE, QUARTIER ou AVENUE.');
    return svc.geo.list({ ...(level ? { level } : {}), ...(parentId ? { parentId } : {}), ...(commune ? { commune } : {}) });
  });

  app.get('/v1/fiscal/reference', async () => ({
    communes: COMMUNES,
    relationRoles: RELATION_ROLES.map((r) => ({ code: r, label: ROLE_LABELS[r] })),
    proofTypes: PROOF_TYPES,
    closeReasons: CLOSE_REASONS,
    declarationKinds: DECLARATION_KINDS.map((k) => ({ code: k, label: KIND_LABELS[k] })),
    legalBases: ctx.rules.instruments.all().filter((i) => i.status === 'EN_VIGUEUR').map((i) => ({ id: i.id, title: i.title, demo: i.demo === true })),
  }));

  // ——— Objets, IGF et QR par bien ———
  app.get<{ Querystring: { commune?: string; status?: string } }>('/v1/fiscal/objects', async (req) => {
    const user = requireUser(req);
    const mine = viewerTaxpayers(user);
    if (mine.length || user.roles.some((r) => r === 'R30' || r === 'R31')) {
      const ids = new Set(mine.flatMap((t) => svc.relations.objectIdsOf(t)));
      return [...ids].map((id) => svc.objectView(ctx.objects.get(id), user, mine));
    }
    const objs = ctx.objects.objects.all().filter((o) =>
      (!req.query.commune || o.commune === req.query.commune) && (!req.query.status || o.status === req.query.status) &&
      evaluate(user, 'fiscal:object.read', { communes: [o.commune] }));
    if (!hasAnyGrant(user, 'fiscal:object.read')) authorize(user, 'fiscal:object.read');
    return objs.map((o) => svc.objectView(o, user, []));
  });

  app.get<{ Params: { id: string } }>('/v1/fiscal/objects/:id', async (req) => {
    const user = requireUser(req);
    const o = ctx.objects.get(req.params.id);
    const mine = viewerTaxpayers(user);
    const related = mine.some((t) => svc.relations.objectIdsOf(t).includes(o.id));
    if (!related) authorize(user, 'fiscal:object.read', { communes: [o.commune], ...(o.taxpayerId ? { taxpayerId: o.taxpayerId } : {}) });
    return svc.objectView(o, user, mine);
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/objects/:id/validate', async (req) => {
    const user = requireUser(req);
    // Le validateur confirme le rang déclaré (provisoire) ou le rectifie ; la table certifiée s'impose si elle existe.
    const body = parse(z.object({ localityRank: rankSchema.optional(), reason: z.string().trim().min(3).max(1000).optional() }).strict(), req.body ?? {});
    const r = svc.properties.validateObject(user, req.params.id, { ...(body.localityRank !== undefined ? { localityRank: body.localityRank } : {}), ...(body.reason ? { reason: body.reason } : {}) });
    return { object: svc.objectView(r.object, user, []), plate: svc.properties.qrOf(r.plate) };
  });

  // Correction du rang ou d'attributs de base (surface…) : proposition puis approbation par une seconde personne.
  app.post<{ Params: { id: string } }>('/v1/fiscal/objects/:id/corrections', async (req, reply) => {
    const body = parse(z.object({
      localityRank: rankSchema.optional(), attributes: z.record(decimal).optional(), reason: z.string().trim().min(10).max(1000),
      evidence: z.array(correctionEvidenceSchema).max(10).optional(),
    }).strict(), req.body);
    return reply.code(201).send(svc.properties.proposeCorrection(requireUser(req), req.params.id, {
      reason: body.reason, ...(body.localityRank !== undefined ? { localityRank: body.localityRank } : {}), ...(body.attributes ? { attributes: body.attributes } : {}),
      ...(body.evidence?.length ? { evidence: body.evidence } : {}),
    }));
  });

  app.get<{ Params: { id: string } }>('/v1/fiscal/objects/:id/corrections', async (req) => {
    const user = requireUser(req);
    const o = ctx.objects.get(req.params.id);
    authorize(user, 'fiscal:object.read', { communes: [o.commune], ...(o.taxpayerId ? { taxpayerId: o.taxpayerId } : {}) });
    return { corrections: svc.properties.corrections.find((c) => c.objectId === o.id), history: o.history ?? [] };
  });

  // File des corrections toutes objets confondus (approbateurs, proposants) : limitée aux communes du périmètre de l'agent.
  app.get<{ Querystring: { status?: string } }>('/v1/fiscal/object-corrections', async (req) => {
    const user = requireUser(req);
    const { status } = parse(z.object({ status: z.enum(['EN_ATTENTE', 'PROPOSEE', 'APPLIQUEE', 'REJETEE']).optional() }).strict(), req.query ?? {});
    if (!hasAnyGrant(user, 'fiscal:object.correct') && !hasAnyGrant(user, 'fiscal:object.correct.approve')) authorize(user, 'fiscal:object.correct.approve');
    const wanted = status === 'EN_ATTENTE' ? 'PROPOSEE' : status;
    return svc.properties.corrections.find((c) => !wanted || c.status === wanted).flatMap((c) => {
      const o = ctx.objects.objects.get(c.objectId);
      if (!o) return [];
      const scope = { communes: [o.commune] };
      if (!evaluate(user, 'fiscal:object.correct', scope) && !evaluate(user, 'fiscal:object.correct.approve', scope)) return [];
      return [{ ...c, object: { id: o.id, category: o.category, commune: o.commune, quartier: o.quartier, localityRank: o.localityRank, createdBy: o.createdBy } }];
    });
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/object-corrections/:id/decision', async (req) => {
    const body = parse(z.object({ approve: z.boolean(), reason: z.string().trim().min(10).max(1000) }).strict(), req.body);
    return svc.properties.decideCorrection(requireUser(req), req.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/objects/:id/plate/pose', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ gps: z.object({ lat: z.number().min(-5.2).max(-3.9), lon: z.number().min(15).max(16.6) }).strict().optional() }).strict(), req.body);
    return svc.properties.qrOf(svc.properties.posePlate(user, req.params.id, body.gps ? { gps: body.gps } : {}));
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/objects/:id/plate/replace', async (req) => {
    const user = requireUser(req);
    const body = parse(reasonSchema, req.body);
    return svc.properties.qrOf(svc.properties.replacePlate(user, req.params.id, body.reason));
  });

  app.get<{ Params: { code: string } }>('/v1/fiscal/plates/:code/scan', async (req) => svc.properties.agentScan(requireUser(req), req.params.code));

  app.get<{ Params: { code: string }; Querystring: { s?: string } }>('/v1/public/fiscal/plates/:code', async (req) => svc.properties.publicCheck(req.params.code, req.query.s));

  // ——— Relations contribuable–objet ———
  app.post('/v1/fiscal/relationships', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(relationSchema, req.body);
    return reply.code(201).send(svc.relations.declare(user, {
      objectId: body.objectId, role: body.role, from: body.from, proofs: body.proofs.map((p) => ({ type: p.type, reference: p.reference, ...(p.sha256 ? { sha256: p.sha256 } : {}) })),
      ...(body.taxpayerId ? { taxpayerId: body.taxpayerId } : {}), ...(body.share ? { share: body.share } : {}), ...(body.to ? { to: body.to } : {}),
    }));
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/relationships/:id/validate', async (req) => {
    const body = parse(z.object({ approve: z.boolean(), reason: z.string().trim().min(3).max(1000) }).strict(), req.body);
    return svc.relations.validate(requireUser(req), req.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/relationships/:id/contest', async (req) => {
    const body = parse(reasonSchema, req.body);
    const r = svc.relations.contest(requireUser(req), req.params.id, body.reason);
    return { id: r.id, status: r.status, disputeId: r.disputeId };
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/relationships/:id/close', async (req) => {
    const body = parse(z.object({ to: isoDateString, reason: z.enum(CLOSE_REASONS), comment: z.string().max(500).optional() }).strict(), req.body);
    return svc.relations.close(requireUser(req), req.params.id, { to: body.to, reason: body.reason, ...(body.comment ? { comment: body.comment } : {}) });
  });

  /** File de validation des agents : rattachements proposés et conflits ouverts dans le périmètre. */
  app.get('/v1/fiscal/relationships/queue', async (req) => {
    const user = requireUser(req);
    const inScope = (objectId: string) => {
      const o = ctx.objects.objects.get(objectId);
      return !!o && !!evaluate(user, 'fiscal:relation.validate', { communes: [o.commune] });
    };
    if (!hasAnyGrant(user, 'fiscal:relation.validate')) authorize(user, 'fiscal:relation.validate');
    const pending = svc.relations.relations.find((r) => r.status === 'PROPOSEE' && inScope(r.objectId));
    const disputes = svc.relations.disputes.find((x) => x.status === 'OUVERT' && inScope(x.objectId));
    const objects = ctx.objects.objects.find((o) => o.status === 'PROVISOIRE' && !!evaluate(user, 'fiscal:object.validate', { communes: [o.commune] }));
    const tpName = (id: string) => ctx.taxpayers.taxpayers.get(id)?.fullName ?? id;
    return {
      relations: pending.map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.role], taxpayerName: tpName(r.taxpayerId), object: svc.objectView(ctx.objects.get(r.objectId), user, []) })),
      disputes: disputes.map((x) => ({ ...x, relations: x.relationIds.map((id) => { const r = svc.relations.get(id); return { ...r, roleLabel: ROLE_LABELS[r.role], taxpayerName: tpName(r.taxpayerId) }; }) })),
      objectsToValidate: objects.map((o) => ({ id: o.id, category: o.category, commune: o.commune, quartier: o.quartier, createdBy: o.createdBy, probativeStatus: o.probativeStatus })),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/disputes/:id/resolve', async (req) => {
    const body = parse(z.object({ keepRelationIds: z.array(z.string()).max(20), reason: z.string().trim().min(3).max(1000) }).strict(), req.body);
    return svc.relations.resolveDispute(requireUser(req), req.params.id, body);
  });

  // ——— Déclarations pré-remplies ———
  app.get<{ Querystring: { objectId?: string; kind?: string; period?: string } }>('/v1/fiscal/declarations/prefill', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ objectId: z.string(), kind: z.enum(DECLARATION_KINDS), period: z.string() }).strict(), req.query);
    return svc.declarations.prefill(user, q);
  });

  app.post('/v1/fiscal/declarations', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(declarationSchema, req.body);
    return reply.code(201).send(svc.declarations.file(user, body));
  });

  app.get<{ Querystring: { taxpayerId?: string; status?: string } }>('/v1/fiscal/declarations', async (req) => {
    const user = requireUser(req);
    const mine = viewerTaxpayers(user);
    const taxpayerId = req.query.taxpayerId ?? (mine.length === 1 ? mine[0] : undefined);
    if (taxpayerId) authorize(user, 'fiscal:declaration.read', { taxpayerId });
    else authorize(user, 'fiscal:declaration.instruct');
    return svc.declarations.list({ ...(taxpayerId ? { taxpayerId } : {}), ...(req.query.status ? { status: req.query.status } : {}) });
  });

  app.get<{ Params: { id: string } }>('/v1/fiscal/declarations/:id', async (req) => {
    const user = requireUser(req);
    const d = svc.declarations.get(req.params.id);
    authorize(user, 'fiscal:declaration.read', { taxpayerId: d.taxpayerId });
    return d;
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/declarations/:id/corrections', async (req, reply) => {
    const body = parse(z.object({ inputs: z.record(decimal), reason: z.string().trim().min(3).max(1000), attest: z.boolean() }).strict(), req.body);
    return reply.code(201).send(svc.declarations.correct(requireUser(req), req.params.id, body));
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/declarations/:id/instruction', async (req) => {
    const body = parse(z.object({ decision: z.enum(['ACCEPTEE', 'REJETEE']), reason: z.string().trim().min(3).max(1000) }).strict(), req.body);
    return svc.declarations.instruct(requireUser(req), req.params.id, body);
  });

  // ——— Exonérations et remises ———
  app.post('/v1/fiscal/exemptions', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(exemptionSchema, req.body);
    const { revenueCategory, ...rest } = body;
    const input = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Parameters<FiscalService['exemptions']['request']>[1];
    if (revenueCategory) (input as { revenueCategory?: string }).revenueCategory = revenueCategory;
    return reply.code(201).send(svc.exemptions.request(user, input));
  });

  app.get<{ Querystring: { taxpayerId?: string; status?: string } }>('/v1/fiscal/exemptions', async (req) => {
    const user = requireUser(req);
    const mine = viewerTaxpayers(user);
    const taxpayerId = req.query.taxpayerId ?? (mine.length === 1 ? mine[0] : undefined);
    if (taxpayerId) authorize(user, 'fiscal:exemption.read', { taxpayerId });
    else authorize(user, 'fiscal:exemption.queue');
    const list = svc.exemptions.list({ ...(taxpayerId ? { taxpayerId } : {}), ...(req.query.status ? { status: req.query.status } : {}) });
    const tpName = (id: string) => ctx.taxpayers.taxpayers.get(id)?.fullName ?? id;
    return {
      items: list.map((x) => ({ ...x, effectiveStatus: svc.exemptions.effectiveStatus(x), ...(taxpayerId ? {} : { taxpayerName: tpName(x.taxpayerId) }) })),
      alerts: taxpayerId ? [] : svc.exemptions.concentrationAlerts(),
    };
  });

  // Registre des exonérations (module 57) : indicateurs, rappels d'échéance et de révision, alertes de concentration.
  app.get('/v1/fiscal/exemptions/registre', async (req) => {
    authorize(requireUser(req), 'fiscal:exemption.queue');
    return {
      indicators: svc.exemptions.indicators(), alerts: svc.exemptions.concentrationAlerts(),
      reminders: svc.exemptions.reminders.all().sort((a, b) => (a.at < b.at ? 1 : -1)),
      upcoming: svc.exemptions.exemptions.find((x) => x.status === 'APPROUVEE').map((x) => ({ id: x.id, kind: x.kind, effectiveStatus: svc.exemptions.effectiveStatus(x), validTo: x.validTo ?? null, reviewDate: svc.exemptions.reviewDate(x) })).sort((a, b) => a.reviewDate.localeCompare(b.reviewDate)),
      params: { reminderDays: 30, reviewMonths: 12, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
    };
  });
  app.post('/v1/fiscal/exemptions/rappels', async (req) => {
    authorize(requireUser(req), 'fiscal:exemption.revoke');
    return { created: svc.exemptions.runReminders() };
  });
  app.get<{ Params: { id: string } }>('/v1/fiscal/exemptions/:id', async (req) => {
    const user = requireUser(req);
    const x = svc.exemptions.get(req.params.id);
    authorize(user, 'fiscal:exemption.read', { taxpayerId: x.taxpayerId });
    return { ...x, effectiveStatus: svc.exemptions.effectiveStatus(x) };
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/exemptions/:id/instruction', async (req) => {
    const body = parse(z.object({ legalBasis: legalBasisSchema.optional(), decision: z.enum(['FAVORABLE', 'DEFAVORABLE']), reason: z.string().trim().min(3).max(1000) }).strict(), req.body);
    return svc.exemptions.instruct(requireUser(req), req.params.id, { decision: body.decision, reason: body.reason, ...(body.legalBasis ? { legalBasis: body.legalBasis } : {}) });
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/exemptions/:id/legal-visa', async (req) => {
    const body = parse(z.object({ decision: z.enum(['FAVORABLE', 'DEFAVORABLE']), reason: z.string().trim().min(3).max(1000) }).strict(), req.body);
    return svc.exemptions.legalVisa(requireUser(req), req.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/exemptions/:id/decision', async (req) => {
    const body = parse(z.object({
      decision: z.enum(['APPROUVEE', 'REFUSEE']), reason: z.string().trim().min(3).max(1000),
      retroactivity: z.object({ decisionReference: z.string().trim().min(3).max(200), reason: z.string().trim().min(3).max(1000) }).strict().optional(),
    }).strict(), req.body);
    return svc.exemptions.decide(requireUser(req), req.params.id, { decision: body.decision, reason: body.reason, ...(body.retroactivity ? { retroactivity: body.retroactivity } : {}) });
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/exemptions/:id/revoke', async (req) => {
    const body = parse(reasonSchema, req.body);
    return svc.exemptions.revoke(requireUser(req), req.params.id, body.reason);
  });

  // ——— Quitus fiscal numérique ———
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/fiscal/clearances/eligibility', async (req) => {
    const user = requireUser(req);
    const taxpayerId = req.query.taxpayerId ?? viewerTaxpayers(user)[0];
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable requis.');
    authorize(user, 'fiscal:clearance.read', { taxpayerId });
    return svc.clearances.eligibility(taxpayerId);
  });

  app.post('/v1/fiscal/clearances', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ taxpayerId: z.string().optional() }).strict(), req.body);
    const r = svc.clearances.request(user, body.taxpayerId);
    return reply.code(r.reused ? 200 : 201).send({ ...svc.clearances.view(r.clearance), reused: r.reused });
  });

  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/fiscal/clearances', async (req) => {
    const user = requireUser(req);
    const taxpayerId = req.query.taxpayerId ?? viewerTaxpayers(user)[0];
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable requis.');
    authorize(user, 'fiscal:clearance.read', { taxpayerId });
    return svc.clearances.clearances.find((c) => c.taxpayerId === taxpayerId).map((c) => svc.clearances.view(c)).reverse();
  });

  app.get('/v1/fiscal/clearances/review', async (req) => svc.clearances.review(requireUser(req)));

  app.post<{ Params: { id: string } }>('/v1/fiscal/clearances/:id/revoke', async (req) => {
    const body = parse(reasonSchema, req.body);
    return svc.clearances.view(svc.clearances.revoke(requireUser(req), req.params.id, body.reason));
  });

  app.get<{ Params: { code: string } }>('/v1/fiscal/clearances/verify/:code', async (req) => svc.clearances.serviceCheck(requireUser(req), req.params.code));

  app.get<{ Params: { code: string }; Querystring: { s?: string } }>('/v1/public/fiscal/clearances/:code', async (req) => svc.clearances.publicCheck(req.params.code, req.query.s));

  // ——— Attestation de bail ———
  app.get('/v1/fiscal/leases', async (req) => {
    const user = requireUser(req);
    const mine = viewerTaxpayers(user);
    if (!mine.length) throw forbidden('FORBIDDEN', 'Réservé au bailleur, au locataire ou à leur mandataire.');
    return mine.flatMap((tp) => ctx.objects.leasesOf(tp).map((l) => {
      const unit = ctx.objects.objects.get(l.unitObjectId);
      const att = svc.clearances.attestations.findOne((a) => a.leaseId === l.id && a.issuedTo === tp && a.status === 'VALIDE');
      return {
        id: l.id, role: l.lessorId === tp ? 'BAILLEUR' : 'LOCATAIRE', unitIgf: unit?.igf?.code ?? l.unitObjectId, commune: unit?.commune ?? null, quartier: unit?.quartier ?? null,
        rent: l.rent, periodicity: l.periodicity, start: l.start, end: l.end ?? null, probativeStatus: l.probativeStatus,
        attestation: att ? svc.clearances.attestationView(att) : null,
      };
    }));
  });

  app.post<{ Params: { id: string } }>('/v1/fiscal/leases/:id/attestations', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(svc.clearances.attestationView(svc.clearances.issueLeaseAttestation(user, req.params.id)));
  });

  app.get<{ Params: { code: string }; Querystring: { s?: string } }>('/v1/public/fiscal/lease-attestations/:code', async (req) => svc.clearances.publicCheckAttestation(req.params.code, req.query.s));

  // ——— Autour de moi (agents sur place, dans leur secteur) ———
  app.get<{ Querystring: Record<string, string> }>('/v1/fiscal/nearby', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({
      lat: z.coerce.number().min(-5.2).max(-3.9), lon: z.coerce.number().min(15).max(16.6),
      accuracyM: z.coerce.number().positive().max(100_000), radiusM: z.coerce.number().positive().max(100_000).optional(),
    }), req.query);
    return buildNearby(svc.d, svc.properties, user, q);
  });

  // ——— Carte à deux couches ———
  app.get<{ Querystring: { layer?: string; commune?: string } }>('/v1/fiscal/map', async (req) => {
    const layer = req.query.layer === 'couverture' ? 'couverture' : 'situation';
    if (req.query.commune && !(COMMUNES as readonly string[]).includes(req.query.commune)) throw badRequest('UNKNOWN_COMMUNE', 'Commune inconnue.');
    return svc.map(optionalUser(req), layer, req.query.commune);
  });

  // ——— Extensions : anomalies locatives, assiette 2026, dépendances, recensement, reprise e-DGRK, enrôlement par profil ———
  registerFiscalExtraRoutes(app, ctx, svc);
}
