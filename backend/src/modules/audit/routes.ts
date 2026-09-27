import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { ApiError } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { action?: string; resourceId?: string; correlationId?: string; elevationId?: string; limit?: string; offset?: string } }>('/v1/audit/events', async (req) => {
    const user = requireUser(req);
    authorize(user, 'audit.read');
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '100', 10) || 100, 1), 1000);
    const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);
    return ctx.audit.list({
      ...(req.query.action ? { action: req.query.action } : {}), ...(req.query.resourceId ? { resourceId: req.query.resourceId } : {}),
      // Corrélation (§ 30.1 X-Request-Id) et session privilégiée (§ 12.1) : filtres sur les attributs structurés.
      ...(req.query.correlationId ? { correlationId: req.query.correlationId } : {}), ...(req.query.elevationId ? { elevationId: req.query.elevationId } : {}),
      limit, offset,
    });
  });

  app.get('/v1/audit/verify', async (req) => {
    const user = requireUser(req);
    authorize(user, 'audit.read');
    return ctx.audit.verify();
  });

  // Journal en ajout seul : aucune route ne permet de modifier ou supprimer un événement.
  for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
    app.route<{ Params: { id: string } }>({
      method,
      url: '/v1/audit/events/:id',
      handler: async (req) => {
        ctx.audit.append({
          actor: { kind: req.user ? 'user' : 'public', id: req.user?.id ?? 'anonyme', ...(req.user ? { roles: req.user.roles } : {}) },
          action: 'audit.tamper.attempt', resourceType: 'audit_event', resourceId: req.params.id, outcome: 'DENIED', details: { method },
        });
        throw new ApiError(405, 'AUDIT_APPEND_ONLY', 'Journal d’audit en ajout seul : aucun événement ne peut être modifié ou supprimé.');
      },
    });
  }
}
