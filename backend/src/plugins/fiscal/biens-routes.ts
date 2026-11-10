/**
 * Routes de la liaison des biens et occupations (spécification v1.0 du 28/09/2026, § 7) — chemins FRANÇAIS
 * (canoniques) ; les chemins anglais de la spécification sont des alias qui relaient vers eux (core/alias.ts).
 * Toute mutation : authentification, autorisation, clé d'idempotence (409 si la clé est réutilisée avec un autre
 * contenu), contrôle de version (409), dates (422), audit. Le compte est toujours déduit de la session.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { forwardToCanonical } from '../../core/alias.js';
import { requireUser } from '../../core/auth.js';
import { badRequest } from '../../core/errors.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { parse } from '../../core/http.js';
import { CLAIM_ROLE_LABELS, CLAIM_ROLES, CONFIG_BIENS, MENTION_JURIDIQUE, MENTION_PARAMETRE } from './biens-config.js';
import { CLAIM_STATUS_LABELS, CLAIM_STATUSES, REVIEW_REASON_LABELS, ROLE_ALIASES } from './biens-occupations.js';
import { RELATION_ROLES } from './relations.js';
import type { FiscalService } from './service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ attendue');
const role = z.string().trim().refine((r) => (CLAIM_ROLES as readonly string[]).includes(r.toUpperCase()) || r.toUpperCase() in ROLE_ALIASES, 'rôle inconnu');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 attendue');
const addressSchema = z.object({
  commune: z.string().trim().min(2).max(60), quartier: z.string().trim().max(80).optional(), avenue: z.string().trim().max(120).optional(), number: z.string().trim().max(30).optional(),
  building_label: z.string().trim().max(30).optional(), unit_label: z.string().trim().max(30).optional(), floor: z.string().trim().max(10).optional(),
  official_ref: z.string().trim().max(80).optional(), official_namespace: z.string().trim().max(40).optional(),
  lat: z.number().min(-5.2).max(-3.9).optional(), lon: z.number().min(15.0).max(16.6).optional(),
}).strict();
const version = z.number().int().min(1).optional();
const reason = z.string().trim().min(5).max(2000);

const claimSchema = z.object({
  role, target_type: z.enum(['PLOT', 'BUILDING', 'UNIT']).optional(), address: addressSchema.optional(),
  valid_from: day.optional(), valid_to: day.optional(), use_type: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED']).optional(),
  share: z.string().trim().max(6).optional(), joint_tenancy: z.boolean().optional(), submit: z.boolean().optional(),
  claim_id: z.string().max(60).optional(), version,
  origin: z.enum(['ESPACE', 'MODULE']).optional(),
  // Indices acceptés mais JAMAIS utilisés pour rapprocher (spécification § 5) : ils sont signalés comme ignorés.
  indices: z.object({ nom: z.string().max(120).optional(), telephone: z.string().max(30).optional() }).strict().optional(),
}).strict();

type P = { Params: { id: string } };

export function registerBiensRoutes(app: FastifyInstance, ctx: AppContext, svc: FiscalService): void {
  const b = svc.biens;

  /** Mutation idempotente : même clé + même contenu ⇒ même réponse, sans refaire le travail ; autre contenu ⇒ 409. */
  const mutate = (req: FastifyRequest, reply: FastifyReply, scope: string, payload: unknown, code: number, fn: () => unknown) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const res = ctx.idempotency.execute(`biens:${scope}:${user.id}`, key, payload, () => ({ statusCode: code, body: fn() }));
    if (res.replayed) void reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  };
  const ifMatch = (req: FastifyRequest): number | undefined => {
    const h = req.headers['if-match'];
    const v = Array.isArray(h) ? h[0] : h;
    return v && /^\d+$/.test(v.replace(/"/g, '')) ? Number.parseInt(v.replace(/"/g, ''), 10) : undefined;
  };

  // ───────── Référentiel et paramètres (§ 10) ─────────
  app.get('/v1/biens-relations/configuration', async (req) => ({
    lecteur: requireUser(req).id,
    roles: CLAIM_ROLES.map((r) => ({ code: r, libelle: CLAIM_ROLE_LABELS[r] })), rolesModule7: RELATION_ROLES,
    statuts: CLAIM_STATUSES.map((s) => ({ code: s, libelle: CLAIM_STATUS_LABELS[s] })), motifsRevue: REVIEW_REASON_LABELS,
    parametres: CONFIG_BIENS, mentionParametres: MENTION_PARAMETRE, mentionJuridique: MENTION_JURIDIQUE,
  }));

  // ───────── Revendications ─────────
  app.post('/v1/revendications-biens', async (req, reply) => {
    const body = parse(claimSchema, req.body);
    return mutate(req, reply, 'claim', body, 201, () => b.submit(requireUser(req), {
      role: body.role, ...(body.target_type ? { targetType: body.target_type } : {}), ...(body.address ? { address: body.address } : {}),
      ...(body.valid_from ? { validFrom: body.valid_from } : {}), ...(body.valid_to ? { validTo: body.valid_to } : {}), ...(body.use_type ? { useType: body.use_type } : {}),
      ...(body.share ? { share: body.share } : {}), ...(body.joint_tenancy ? { jointTenancy: true } : {}), ...(body.submit === false ? { submit: false } : {}),
      ...(body.claim_id ? { claimId: body.claim_id } : {}), ...((body.version ?? ifMatch(req)) !== undefined ? { version: body.version ?? ifMatch(req)! } : {}),
      ...(body.origin ? { origin: body.origin } : {}), ...(body.indices ? { indices: body.indices } : {}),
    }));
  });
  app.get<{ Querystring: { revendication?: string; claim_id?: string } }>('/v1/biens-candidats', async (req) => {
    const id = req.query.revendication ?? req.query.claim_id;
    if (!id) throw badRequest('CLAIM_REQUIRED', 'Paramètre « revendication » (ou claim_id) requis.');
    return b.candidatesOf(requireUser(req), id);
  });
  app.post<P>('/v1/revendications-biens/:id/choix-candidat', async (req, reply) => {
    const body = parse(z.object({ candidate_id: z.string().max(60).optional(), aucun: z.boolean().optional(), version }).strict().refine((x) => !!x.candidate_id !== !!x.aucun, 'candidate_id OU aucun'), req.body);
    return mutate(req, reply, `select:${req.params.id}`, body, 200, () => b.selectCandidate(requireUser(req), req.params.id, {
      ...(body.candidate_id ? { candidateId: body.candidate_id } : {}), ...(body.aucun ? { aucun: true } : {}), ...((body.version ?? ifMatch(req)) !== undefined ? { version: body.version ?? ifMatch(req)! } : {}),
    }));
  });
  app.post<P>('/v1/revendications-biens/:id/preuves', async (req, reply) => {
    const body = parse(z.object({ evidence_type: z.string().trim().min(3).max(40), sha256: hex64, document_id: z.string().max(60).optional(), label: z.string().trim().max(200).optional(), version }).strict(), req.body);
    return mutate(req, reply, `evidence:${req.params.id}`, body, 201, () => b.addEvidence(requireUser(req), req.params.id, {
      evidenceType: body.evidence_type, sha256: body.sha256, ...(body.document_id ? { documentId: body.document_id } : {}), ...(body.label ? { label: body.label } : {}),
      ...((body.version ?? ifMatch(req)) !== undefined ? { version: body.version ?? ifMatch(req)! } : {}),
    }));
  });
  app.post<P>('/v1/revendications-biens/:id/invitations', async (req, reply) => {
    const body = parse(z.object({ contact: z.string().trim().min(6).max(120), channel: z.enum(['SMS', 'EMAIL', 'COURRIER']).optional(), invite_role: role.optional(), target_unit_id: z.string().max(60).optional() }).strict(), req.body);
    return mutate(req, reply, `invite:${req.params.id}`, body, 201, () => b.invite(requireUser(req), req.params.id, {
      contact: body.contact, ...(body.channel ? { channel: body.channel } : {}), ...(body.invite_role ? { inviteRole: body.invite_role } : {}), ...(body.target_unit_id ? { targetUnitId: body.target_unit_id } : {}),
    }));
  });
  app.post<{ Params: { jeton: string } }>('/v1/invitations-biens/:jeton/reponse', async (req, reply) => {
    const body = parse(z.object({ reponse: z.enum(['ACCEPTER', 'REFUSER', 'BIEN_ERRONE']), creer_ma_revendication: z.boolean().optional(), valid_from: day.optional() }).strict(), req.body);
    return mutate(req, reply, 'respond', { jeton: req.params.jeton, ...body }, 200, () => b.respond(requireUser(req), req.params.jeton, {
      response: body.reponse, ...(body.creer_ma_revendication ? { creerMaRevendication: true } : {}), ...(body.valid_from ? { validFrom: body.valid_from } : {}),
    }));
  });
  app.post<P>('/v1/revendications-biens/:id/contestations', async (req, reply) => {
    const body = parse(z.object({ motif: reason, version }).strict(), req.body);
    return mutate(req, reply, `dispute:${req.params.id}`, body, 201, () => b.dispute(requireUser(req), req.params.id, { reason: body.motif, ...(body.version !== undefined ? { version: body.version } : {}) }));
  });
  app.post<P>('/v1/revendications-biens/:id/appel', async (req, reply) => {
    const body = parse(z.object({ motif: reason }).strict(), req.body);
    return mutate(req, reply, `appeal:${req.params.id}`, body, 201, () => b.appeal(requireUser(req), req.params.id, { reason: body.motif }));
  });
  app.post<P>('/v1/revendications-biens/:id/fin', async (req, reply) => {
    const body = parse(z.object({ valid_to: z.string().max(10), motif: reason, version }).strict(), req.body);
    return mutate(req, reply, `end:${req.params.id}`, body, 200, () => b.end(requireUser(req), req.params.id, { validTo: body.valid_to, reason: body.motif, ...((body.version ?? ifMatch(req)) !== undefined ? { version: body.version ?? ifMatch(req)! } : {}) }));
  });
  app.get('/v1/moi/relations-biens', async (req) => b.mine(requireUser(req)));

  // ───────── Propriétaire d'abord : bien, bâtiment, unités, locataires connus (invitations) ─────────
  app.post('/v1/biens-declares', async (req, reply) => {
    const body = parse(z.object({
      plot: z.object({
        commune: z.string().trim().min(2).max(60), quartier: z.string().trim().min(1).max(80), avenue: z.string().trim().max(120).optional(), number: z.string().trim().max(30).optional(),
        official_ref: z.string().trim().max(80).optional(), official_namespace: z.string().trim().max(40).optional(), lat: z.number().min(-5.2).max(-3.9), lon: z.number().min(15.0).max(16.6),
        locality_rank: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
      }).strict(),
      building: z.object({ label: z.string().trim().max(30).optional() }).strict().optional(),
      units: z.array(z.object({
        label: z.string().trim().min(1).max(30), floor: z.string().trim().max(10).optional(), use_type: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED']).optional(),
        locataire_connu: z.object({ contact: z.string().trim().min(6).max(120), channel: z.enum(['SMS', 'EMAIL', 'COURRIER']).optional() }).strict().optional(),
      }).strict()).max(200).optional(),
      role: role.optional(), share: z.string().trim().max(6).optional(), valid_from: day.optional(), target: z.enum(['PLOT', 'BUILDING']).optional(),
    }).strict(), req.body);
    const { locality_rank: lr, ...plot } = body.plot;
    return mutate(req, reply, 'declare', body, 201, () => b.declareProperty(requireUser(req), {
      plot: { ...plot, ...(lr ? { localityRank: lr } : {}) }, ...(body.building ? { building: body.building } : {}),
      ...(body.units ? { units: body.units.map((u) => ({ label: u.label, ...(u.floor ? { floor: u.floor } : {}), ...(u.use_type ? { useType: u.use_type } : {}), ...(u.locataire_connu ? { locataireConnu: u.locataire_connu } : {}) })) } : {}),
      ...(body.role ? { role: body.role } : {}), ...(body.share ? { share: body.share } : {}), ...(body.valid_from ? { validFrom: body.valid_from } : {}), ...(body.target ? { target: body.target } : {}),
    }));
  });
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>('/v1/biens/:id/vue-proprietaire', async (req) => b.ownerView(requireUser(req), req.params.id, req.query.date));

  // ───────── Dossiers de revue (réviseurs habilités, agents de terrain affectés) ─────────
  app.get<{ Querystring: { statut?: string } }>('/v1/dossiers-revue', async (req) => ({ items: b.listCases(requireUser(req), { ...(req.query.statut ? { status: req.query.statut } : {}) }) }));
  app.get<P>('/v1/dossiers-revue/:id', async (req) => b.caseDetail(requireUser(req), req.params.id));
  app.post<P>('/v1/dossiers-revue/:id/affectation', async (req, reply) => {
    const body = parse(z.object({ agent_id: z.string().min(1).max(80), heures: z.number().int().min(1).max(720).optional(), version }).strict(), req.body);
    return mutate(req, reply, `assign:${req.params.id}`, body, 200, () => b.assignField(requireUser(req), req.params.id, { agentId: body.agent_id, ...(body.heures ? { hours: body.heures } : {}), ...(body.version !== undefined ? { version: body.version } : {}) }));
  });
  app.post<P>('/v1/dossiers-revue/:id/constat-terrain', async (req, reply) => {
    const body = parse(z.object({
      gps: z.object({ lat: z.number().min(-5.2).max(-3.9), lon: z.number().min(15.0).max(16.6), accuracy_m: z.number().min(0).max(10_000).optional() }).strict(),
      photo_sha256: hex64, observations: z.string().trim().min(5).max(2000), confirme: z.boolean(),
    }).strict(), req.body);
    return mutate(req, reply, `field:${req.params.id}`, body, 201, () => b.fieldVerification(requireUser(req), req.params.id, {
      gps: { lat: body.gps.lat, lon: body.gps.lon, ...(body.gps.accuracy_m !== undefined ? { accuracyM: body.gps.accuracy_m } : {}) }, photoSha256: body.photo_sha256, observations: body.observations, confirme: body.confirme,
    }));
  });
  app.post<P>('/v1/dossiers-revue/:id/decision', async (req, reply) => {
    const body = parse(z.object({
      decision: z.string().trim().min(3).max(20), motif: reason, valid_from: z.string().max(10).optional(), valid_to: z.string().max(10).optional(),
      canonical_target_id: z.string().max(60).optional(), claim_id: z.string().max(60).optional(), version,
    }).strict(), req.body);
    return mutate(req, reply, `decide:${req.params.id}`, body, 200, () => b.decide(requireUser(req), req.params.id, {
      decision: body.decision, reason: body.motif, ...(body.valid_from ? { validFrom: body.valid_from } : {}), ...(body.valid_to ? { validTo: body.valid_to } : {}),
      ...(body.canonical_target_id ? { canonicalTargetId: body.canonical_target_id } : {}), ...(body.claim_id ? { claimId: body.claim_id } : {}),
      ...((body.version ?? ifMatch(req)) !== undefined ? { version: body.version ?? ifMatch(req)! } : {}),
    }));
  });

  // ───────── Vue datée des modules en aval (IRL, IF, baux) ─────────
  app.get<{ Querystring: { objet?: string; date?: string; roles?: string } }>('/v1/relations-biens/effectives', async (req) => {
    const q = parse(z.object({ objet: z.string().min(1).max(60), date: z.string().max(10), roles: z.string().max(200).optional() }).strict(), req.query);
    const roles = q.roles ? q.roles.split(',').map((r) => r.trim().toUpperCase()).filter((r): r is (typeof RELATION_ROLES)[number] => (RELATION_ROLES as readonly string[]).includes(r)) : undefined;
    return b.effective(requireUser(req), { objectId: q.objet, date: q.date, ...(roles ? { roles } : {}) });
  });

  // ───────── Alias anglais de la spécification (§ 7) → routes françaises canoniques ─────────
  const alias = (method: 'GET' | 'POST', en: string, fr: (req: FastifyRequest) => { path: string; query?: string }, transform?: (body: Record<string, unknown>) => Record<string, unknown>) => {
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const t = fr(req);
      const raw = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
      const body = method === 'POST' ? (transform ? { json: transform(raw) } : { raw: true as const }) : undefined;
      return forwardToCanonical(app, req, reply, { method, path: t.path, ...(t.query !== undefined ? { query: t.query } : {}), ...(body ? { body } : {}) });
    };
    const opts = { config: { canonicalRoute: `${method} ${en}` } };
    if (method === 'GET') app.get(en, opts, handler); else app.post(en, opts, handler);
  };
  const id = (req: FastifyRequest) => encodeURIComponent((req.params as { id?: string; token?: string }).id ?? (req.params as { token?: string }).token ?? '');
  alias('POST', '/v1/property-claims', () => ({ path: '/v1/revendications-biens' }));
  alias('GET', '/v1/property-candidates', (req) => ({ path: '/v1/biens-candidats', query: `revendication=${encodeURIComponent(String((req.query as { claim_id?: string }).claim_id ?? ''))}` }));
  alias('POST', '/v1/property-claims/:id/select-candidate', (req) => ({ path: `/v1/revendications-biens/${id(req)}/choix-candidat` }));
  alias('POST', '/v1/property-claims/:id/evidence', (req) => ({ path: `/v1/revendications-biens/${id(req)}/preuves` }));
  alias('POST', '/v1/property-claims/:id/invitations', (req) => ({ path: `/v1/revendications-biens/${id(req)}/invitations` }));
  const RESPONSES: Record<string, string> = { ACCEPT: 'ACCEPTER', DECLINE: 'REFUSER', REPORT_WRONG_PROPERTY: 'BIEN_ERRONE', REPORT_INCORRECT: 'BIEN_ERRONE' };
  const reasonToMotif = ({ reason: r, ...rest }: Record<string, unknown>) => ({ ...rest, ...(r !== undefined ? { motif: r } : {}) });
  alias('POST', '/v1/invitations/:token/respond', (req) => ({ path: `/v1/invitations-biens/${id(req)}/reponse` }),
    ({ response, create_my_claim: create, ...rest }) => ({ ...rest, ...(response !== undefined ? { reponse: RESPONSES[String(response).toUpperCase()] ?? response } : {}), ...(create !== undefined ? { creer_ma_revendication: create } : {}) }));
  alias('POST', '/v1/property-claims/:id/disputes', (req) => ({ path: `/v1/revendications-biens/${id(req)}/contestations` }), reasonToMotif);
  alias('POST', '/v1/review-cases/:id/decision', (req) => ({ path: `/v1/dossiers-revue/${id(req)}/decision` }), reasonToMotif);
  alias('POST', '/v1/property-claims/:id/end', (req) => ({ path: `/v1/revendications-biens/${id(req)}/fin` }), reasonToMotif);
  alias('GET', '/v1/me/property-relationships', () => ({ path: '/v1/moi/relations-biens' }));
}
