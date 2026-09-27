import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { isoDateString, parse } from '../../core/http.js';
import { sha256Hex64 } from '../parking/support.js';
import { AD_TYPES, FINDINGS, LIGHTING, PIECE_KINDS, type PubliciteService } from './service.js';
import { withOverdue } from '../sanctions/service.js';

const decimal = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'dimension en mètres, ex. "4.00"');
const sha = z.string().regex(sha256Hex64, 'empreinte SHA-256 hexadécimale attendue');
const reason = z.string().trim().min(5).max(2000);
const rank = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const deviceSpec = {
  type: z.enum(AD_TYPES), widthM: decimal, heightM: decimal, faces: z.number().int().min(1).max(4), lighting: z.enum(LIGHTING),
  commune: z.string().min(2), quartier: z.string().trim().min(2).max(120), address: z.string().trim().min(3).max(240), localityRank: rank,
};
const pieces = z.array(z.object({ kind: z.enum(PIECE_KINDS), name: z.string().trim().min(1).max(160), sha256: sha }).strict()).min(1).max(20);

export function registerPubliciteRoutes(app: FastifyInstance, ctx: AppContext, svc: PubliciteService): void {
  // Annonceur / exploitant
  app.post('/v1/publicite/devices', async (req, reply) => {
    const body = parse(z.object({
      ...deviceSpec, lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), photos: z.array(sha).min(1).max(6), taxpayerId: z.string().optional(),
    }).strict(), req.body);
    const user = requireUser(req);
    return reply.code(201).send(svc.deviceView(svc.declareDevice(user, body), { withOwner: true }));
  });
  app.get('/v1/publicite/devices/mine', async (req) => ({ items: svc.myDevices(requireUser(req)) }));
  app.get<{ Params: { id: string } }>('/v1/publicite/devices/:id', async (req) => svc.readDevice(requireUser(req), req.params.id));
  app.post('/v1/publicite/authorizations', async (req, reply) => {
    const body = parse(z.object({ deviceId: z.string().min(1), periodFrom: isoDateString, periodTo: isoDateString, pieces }).strict(), req.body);
    return reply.code(201).send(svc.submitRequest(requireUser(req), body));
  });
  app.get('/v1/publicite/authorizations/mine', async (req) => ({ items: svc.myRequests(requireUser(req)) }));
  app.post<{ Params: { id: string } }>('/v1/publicite/authorizations/:id/pieces', async (req) =>
    svc.addPieces(requireUser(req), req.params.id, parse(z.object({ pieces, message: z.string().trim().min(3).max(2000) }).strict(), req.body)));
  app.get('/v1/publicite/obligations/mine', async (req) => ({ items: svc.myObligations(requireUser(req)) }));
  app.get('/v1/publicite/cases/mine', async (req) => ({ items: svc.myCases(requireUser(req)) }));
  app.post<{ Params: { id: string } }>('/v1/publicite/cases/:id/contest', async (req, reply) =>
    reply.code(201).send(svc.contestCase(requireUser(req), req.params.id, parse(z.object({ grounds: z.string().trim().min(10).max(5000) }).strict(), req.body).grounds)));

  // Régie : instruction et décision des autorisations
  app.get('/v1/publicite/authorizations', async (req) => ({ items: svc.listRequests(requireUser(req)) }));
  app.post<{ Params: { id: string } }>('/v1/publicite/authorizations/:id/instruct', async (req) =>
    svc.instruct(requireUser(req), req.params.id, parse(z.object({ action: z.enum(['COMPLEMENT', 'PROPOSER']), analysis: reason, proposal: z.enum(['ACCORDER', 'REFUSER']).optional() }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/publicite/authorizations/:id/decide', async (req) =>
    svc.decideRequest(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['ACCORDEE', 'REFUSEE']), reason }).strict(), req.body)));

  // Inventaire, carte, recherche, inspections et dossiers
  app.get<{ Querystring: { commune?: string; status?: string } }>('/v1/publicite/inventory', async (req) => ({ items: svc.inventory(requireUser(req), req.query) }));
  app.get('/v1/publicite/map', async (req) => ({ items: svc.map(requireUser(req)) }));
  app.get<{ Querystring: { q?: string } }>('/v1/publicite/lookup', async (req) => svc.lookup(requireUser(req), String(req.query.q ?? '')));
  app.post('/v1/publicite/inspections', async (req, reply) => {
    const body = parse(z.object({
      deviceId: z.string().optional(), newDevice: z.object(deviceSpec).strict().optional(), finding: z.enum(FINDINGS), photos: z.array(sha).min(1).max(6),
      lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), gpsAccuracyM: z.number().min(0).max(10_000).optional(),
      qrScanned: z.string().max(64).optional(), ocrText: z.string().max(2000).optional(), presumedOperator: z.string().trim().max(160).optional(),
      observations: z.string().trim().min(3).max(2000),
    }).strict(), req.body);
    const user = requireUser(req);
    const r = svc.inspect(user, body);
    const owner = svc.devices.get(r.device.id)?.ownerTaxpayerId ?? null;
    return reply.code(201).send(withOverdue(ctx, user, r, { taxpayerId: owner }, 'PUBLICITE', r.inspection.id));
  });
  app.get<{ Querystring: { inspectorId?: string } }>('/v1/publicite/inspections', async (req) => ({ items: svc.inspectionsOf(requireUser(req), req.query.inspectorId) }));
  app.get<{ Querystring: { status?: string } }>('/v1/publicite/cases', async (req) => ({ items: svc.listCases(requireUser(req), req.query.status) }));
  app.post<{ Params: { id: string } }>('/v1/publicite/cases/:id/verify', async (req) =>
    svc.verifyCase(requireUser(req), req.params.id, parse(z.object({ confirm: z.boolean(), note: reason }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/publicite/cases/:id/decide', async (req) =>
    svc.decideCase(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['RETENU', 'CLASSE']), reason, ownerTaxpayerId: z.string().optional(), liquidateDues: z.boolean().optional() }).strict(), req.body)));

  // Accréditations et badge public
  app.get('/v1/publicite/accreditations', async (req) => ({ items: svc.listAccreditations(requireUser(req)) }));
  app.post('/v1/publicite/accreditations', async (req, reply) =>
    reply.code(201).send(svc.grantAccreditation(requireUser(req), parse(z.object({ userId: z.string().min(1), communes: z.array(z.string()).min(1).max(24), validFrom: isoDateString, validUntil: isoDateString }).strict(), req.body))));
  app.post<{ Params: { userId: string } }>('/v1/publicite/accreditations/:userId/revoke', async (req) =>
    svc.revokeAccreditation(requireUser(req), req.params.userId, parse(z.object({ reason }).strict(), req.body).reason));

  // Vérifications publiques (sans authentification, sans donnée nominative de l'exploitant)
  app.get<{ Params: { token: string } }>('/v1/publicite/public/devices/:token', async (req) => svc.publicCheck(req.params.token));
  app.get<{ Params: { userId: string } }>('/v1/publicite/public/badges/:userId', async (req) => svc.publicBadge(req.params.userId));

  // Échéances et tableau de bord
  app.post('/v1/publicite/reminders/run', async (req) => svc.runReminders(requireUser(req)));
  app.get('/v1/publicite/indicators', async (req) => svc.indicators(requireUser(req)));
}
