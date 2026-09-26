import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { header } from '../../core/http.js';

export function registerFieldRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Lot signé : x-device-signature = HMAC-SHA256(clé de l'appareil, corps brut) en hexadécimal.
  app.post('/v1/field-sync/batches', async (req) => ctx.field.sync(requireUser(req), req.rawBody ?? '', header(req, 'x-device-signature')));
}
