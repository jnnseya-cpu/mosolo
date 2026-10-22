/** Routes du contrôle qualité renforcé : doublons, objets présumés fictifs, rotation des zones, récupérations (§ 15A.5, § 15A.7). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import type { TerrainQualityService } from './qualite-fraude.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const motif = z.string().trim().min(10, 'motif de 10 caractères au moins').max(2000);
const clawback = z.object({
  subcontractorId: z.string().min(1).max(60), findingIds: z.array(z.string().min(1).max(60)).min(1).max(500),
  grounds: z.enum(['OBJET_FICTIF', 'CONSTAT_FRAUDULEUX']), motif, evidenceSha256: z.array(sha256).min(1).max(20),
}).strict();
const decision = z.object({ approve: z.boolean(), motif }).strict();

export function registerTerrainQualityRoutes(app: FastifyInstance, svc: TerrainQualityService): void {
  app.get('/v1/terrain/qualite', async (req) => svc.board(requireUser(req)));
  app.post('/v1/terrain/recuperations', async (req, reply) => reply.code(201).send(svc.proposeClawback(requireUser(req), parse(clawback, req.body))));
  app.post<{ Params: { id: string } }>('/v1/terrain/recuperations/:id/decision', async (req) => svc.decideClawback(requireUser(req), req.params.id, parse(decision, req.body)));
}
