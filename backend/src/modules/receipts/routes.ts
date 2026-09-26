import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';

export function registerReceiptRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Vérification publique : aucune authentification, résultat minimal.
  app.get<{ Params: { code: string } }>('/v1/public/receipts/:code', async (req) => ctx.receipts.publicVerify(req.params.code));
}
