/** Routes des compléments KIN PUB CONTROL (§ 11B.2, § 11B.5). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { isoDateString, parse } from '../../core/http.js';
import { sha256Hex64 } from '../parking/support.js';
import { CITIZEN_REPORT_KINDS } from './complements.js';
import { PIECE_KINDS, type PubliciteService } from './service.js';

const sha = z.string().regex(sha256Hex64, 'empreinte SHA-256 hexadécimale attendue');
const reason = z.string().trim().min(5).max(2000);
const decimal = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'dimension en mètres, ex. "4.00"');
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

export function registerComplementsRoutes(app: FastifyInstance, svc: PubliciteService): void {
  const c = svc.complements;
  // Carte : couches (supports, zones saturées, zones à contrôler, espaces disponibles, interventions, signalements).
  app.get('/v1/publicite/carte/couches', async (req) => c.layers(requireUser(req)));
  app.post('/v1/publicite/zones', async (req, reply) =>
    reply.code(201).send(c.declareZone(requireUser(req), parse(z.object({ kind: z.enum(['SATUREE', 'A_CONTROLER']), label: z.string().trim().min(3).max(160), commune: z.string().min(2).max(40), lat, lon, radiusM: z.number().int().positive().max(20_000), motif: reason }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/publicite/zones/:id/cloture', async (req) => c.closeZone(requireUser(req), req.params.id, parse(z.object({ motif: reason }).strict(), req.body).motif));
  app.post('/v1/publicite/espaces', async (req, reply) =>
    reply.code(201).send(c.registerSpace(requireUser(req), parse(z.object({ label: z.string().trim().min(3).max(160), commune: z.string().min(2).max(40), lat, lon, widthM: decimal, heightM: decimal, notes: z.string().trim().max(500).default('') }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/publicite/espaces/:id/statut', async (req) => {
    const body = parse(z.object({ status: z.enum(['DISPONIBLE', 'RESERVE', 'ATTRIBUE', 'RETIRE']), note: reason }).strict(), req.body);
    return c.setSpaceStatus(requireUser(req), req.params.id, body.status, body.note);
  });

  // Renouvellement d'autorisation en ligne.
  app.post<{ Params: { id: string } }>('/v1/publicite/authorizations/:id/renewal', async (req, reply) => {
    const body = parse(z.object({
      periodFrom: isoDateString.optional(), periodTo: isoDateString,
      pieces: z.array(z.object({ kind: z.enum(PIECE_KINDS), name: z.string().trim().min(1).max(160), sha256: sha }).strict()).max(20).default([]),
    }).strict(), req.body);
    return reply.code(201).send(c.renew(requireUser(req), req.params.id, body));
  });

  // Contrats publicitaires et suivi des échéances.
  app.get('/v1/publicite/contrats', async (req) => ({ items: c.myContracts(requireUser(req)) }));
  app.post('/v1/publicite/contrats', async (req, reply) =>
    reply.code(201).send(c.addContract(requireUser(req), parse(z.object({ deviceId: z.string().min(1).max(64), advertiser: z.string().trim().min(2).max(160), reference: z.string().trim().min(2).max(64), from: isoDateString, to: isoDateString, sha256: sha }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/publicite/contrats/:id/resiliation', async (req) => c.terminateContract(requireUser(req), req.params.id, parse(z.object({ motif: reason }).strict(), req.body).motif));
  app.get('/v1/publicite/echeances', async (req) => c.expiries(requireUser(req)));

  // Portail citoyen de signalement (public, sans donnée nominative ; espèces et faux contrôleurs → ligne d'intégrité).
  app.post('/v1/public/publicite/signalements', async (req, reply) => {
    const body = parse(z.object({
      kind: z.enum(CITIZEN_REPORT_KINDS), description: z.string().trim().min(10).max(2000), lat: z.number().min(-5.2).max(-3.9), lon: z.number().min(15).max(16.6),
      commune: z.string().max(40).optional(), photoSha256: sha.optional(), qrToken: z.string().max(64).optional(),
    }).strict(), req.body);
    return reply.code(201).send(c.citizenReport(body));
  });
  app.get<{ Querystring: { status?: string } }>('/v1/publicite/signalements', async (req) => ({ items: c.listCitizenReports(requireUser(req), req.query.status) }));
  app.post<{ Params: { id: string } }>('/v1/publicite/signalements/:id/tri', async (req) =>
    c.triageReport(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['A_INSPECTER', 'CLASSE', 'DOUBLON']), motif: reason }).strict(), req.body)));

  // Pilote en sept étapes.
  app.get('/v1/publicite/pilote', async (req) => ({ steps: c.pilotView(requireUser(req)) }));
  app.post<{ Params: { rank: string } }>('/v1/publicite/pilote/:rank', async (req) =>
    c.updatePilotStep(requireUser(req), Number.parseInt(req.params.rank, 10), parse(z.object({ status: z.enum(['A_FAIRE', 'EN_COURS', 'TERMINEE']), note: reason, evidenceSha256: sha.optional() }).strict(), req.body)));

  // Analyse d'image : propositions à vérifier par une personne.
  app.get('/v1/publicite/ia/propositions', async (req) => ({ items: c.listProposals(requireUser(req)) }));
  app.post<{ Params: { photoId: string } }>('/v1/publicite/ia/analyses/:photoId', async (req, reply) => reply.code(201).send(c.analysePhoto(requireUser(req), req.params.photoId)));
  app.post<{ Params: { id: string } }>('/v1/publicite/ia/propositions/:id/verification', async (req) =>
    c.verifyProposal(requireUser(req), req.params.id, parse(z.object({ confirm: z.boolean(), motif: reason }).strict(), req.body)));
}
