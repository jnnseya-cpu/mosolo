import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/dashboards/governor', async (req) => ctx.dashboards.governor(requireUser(req)));
}
