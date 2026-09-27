/** Routes de l'inspection et du constat (module 35) : dossiers, paquet hors ligne, procès-verbaux, contestations, indicateurs. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { OBJECT_CATEGORIES } from '../../modules/objects/service.js';
import { LEGAL_POWERS, PV_TEMPLATES, type InspectionService } from './inspection.js';

const sha = z.string().regex(/^[0-9a-fA-F]{64}$/);
const draftSchema = z.object({
  clientRef: z.string().min(1).max(100), findingId: z.string().min(1).max(60), templateId: z.string().min(1).max(60),
  personDeclaration: z.string().trim().max(4000), signedAt: z.string().datetime({ offset: true }),
  signature: z.object({
    kind: z.enum(['SIGNE', 'REFUS_DE_SIGNER', 'PERSONNE_ABSENTE']), signerName: z.string().trim().max(200).optional(),
    signatureImageSha256: sha.optional(), refusalNote: z.string().trim().max(1000).optional(),
  }).strict(),
  extraPhotoSha256: z.array(sha).max(10).optional(), supersedes: z.string().min(1).max(60).optional(),
}).strict();

export function registerInspectionRoutes(app: FastifyInstance, svc: InspectionService): void {
  type P = { Params: { id: string } };
  app.get('/v1/terrain/inspection/modeles', async (req) => {
    const u = requireUser(req);
    authorize(u, 'terrain:inspection.read');
    return { powers: LEGAL_POWERS, templates: PV_TEMPLATES, mine: svc.powersOf(u) };
  });
  app.post<P>('/v1/terrain/missions/:id/dossiers-inspection', async (req, reply) => reply.code(201).send(svc.prepare(requireUser(req), req.params.id)));
  app.get<P>('/v1/terrain/missions/:id/itineraire', async (req) => svc.missionItinerary(requireUser(req), req.params.id));
  app.post<P>('/v1/terrain/findings/:id/objet-provisoire', async (req, reply) => {
    const r = svc.registerUnregistered(requireUser(req), req.params.id, parse(z.object({
      category: z.enum(OBJECT_CATEGORIES), quartier: z.string().trim().min(2).max(80), localityRank: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    }).strict(), req.body));
    return reply.code(r.replayed ? 200 : 201).send(r.object);
  });
  app.get<P>('/v1/terrain/missions/:id/paquet-hors-ligne', async (req) => svc.offlinePackage(requireUser(req), req.params.id));
  app.post('/v1/terrain/paquets/verification', async (req) => {
    authorize(requireUser(req), 'terrain:inspection.read');
    return svc.verifyPackage(req.body as { packageHash: string; signature: string });
  });
  app.get<{ Querystring: { status?: string; missionId?: string } }>('/v1/terrain/proces-verbaux', async (req) => svc.list(requireUser(req), req.query));
  app.get('/v1/terrain/proces-verbaux/mes-proces-verbaux', async (req) => svc.mine(requireUser(req)));
  app.post('/v1/terrain/proces-verbaux', async (req, reply) => {
    const r = svc.draft(requireUser(req), parse(draftSchema, req.body) as Parameters<InspectionService['draft']>[1]);
    return reply.code(r.replayed ? 200 : 201).send(r.pv);
  });
  app.post<P>('/v1/terrain/proces-verbaux/:id/decision', async (req) => svc.review(requireUser(req), req.params.id, parse(z.object({ decision: z.enum(['VALIDE', 'REJETE']), reason: z.string().trim().min(5).max(1000) }).strict(), req.body)));
  app.post<P>('/v1/terrain/proces-verbaux/:id/contestations', async (req, reply) => reply.code(201).send(svc.contest(requireUser(req), req.params.id, parse(z.object({ text: z.string().trim().min(10).max(4000) }).strict(), req.body).text)));
  app.post<{ Params: { id: string; cid: string } }>('/v1/terrain/proces-verbaux/:id/contestations/:cid/reponse', async (req) => svc.answer(requireUser(req), req.params.id, req.params.cid, parse(z.object({ text: z.string().trim().min(10).max(4000) }).strict(), req.body).text));
  app.get('/v1/terrain/inspection/indicateurs', async (req) => svc.indicators(requireUser(req)));
}
