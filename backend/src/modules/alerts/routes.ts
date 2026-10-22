import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { authorize } from '../../core/policy.js';

export function registerAlertRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/security/alerts', async (req) => {
    authorize(requireUser(req), 'alerts.read');
    return ctx.alerts.list();
  });
}
