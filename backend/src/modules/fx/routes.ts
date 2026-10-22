import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';

export function registerFxRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { date: string } }>('/v1/exchange-rates/:date', async (req) => ctx.fx.ratesFor(req.params.date));
}
