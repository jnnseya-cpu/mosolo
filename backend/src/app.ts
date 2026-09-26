/**
 * Construction de l'application Fastify. `buildApp({ clock, secrets })` : horloge et secrets injectables (tests).
 */
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { createContext, type AppContext, type AppOptions } from './context.js';
import { resolveDemoUser } from './core/auth.js';
import { ApiError } from './core/errors.js';
import { registerAiRoutes } from './modules/ai/routes.js';
import { registerAlertRoutes } from './modules/alerts/routes.js';
import { registerAppealRoutes } from './modules/appeals/routes.js';
import { registerAssessmentRoutes } from './modules/assessment/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import { registerCommunicationRoutes } from './modules/communications/routes.js';
import { registerDashboardRoutes } from './modules/dashboards/routes.js';
import { registerDraftRoutes } from './modules/drafts/routes.js';
import { registerFieldRoutes } from './modules/field/routes.js';
import { registerFxRoutes } from './modules/fx/routes.js';
import { registerIdentityRoutes } from './modules/identity/routes.js';
import { registerObjectRoutes } from './modules/objects/routes.js';
import { registerPaymentRoutes } from './modules/payments/routes.js';
import { registerReceiptRoutes } from './modules/receipts/routes.js';
import { registerRuleRoutes } from './modules/rules/routes.js';
import { registerSystemRoutes } from './modules/system/routes.js';
import { registerTreasuryRoutes } from './modules/treasury/routes.js';
import { registerVaultRoutes } from './modules/vault/routes.js';
import { seed } from './seed.js';
import { DEFAULT_PLUGINS } from './plugins/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export function buildApp(opts: AppOptions & { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_048_576 });
  const ctx = createContext(opts);
  const plugins = opts.plugins ?? DEFAULT_PLUGINS;
  for (const p of plugins) ctx.ext[p.name] = p.create(ctx);
  if (opts.seed !== false) {
    seed(ctx);
    for (const p of plugins) p.seed?.(ctx, ctx.ext[p.name]);
    // Doctrine (§ 18.1) : l'alias de règlement de chaque connecteur doit exister dans le coffre — sinon, pas de démarrage.
    // (Sans données semées, le contrôle est refait à chaque création d'intention par la résolution d'alias.)
    ctx.connectors.validate((alias) => ctx.vault.aliasExists(alias));
  }
  app.decorate('ctx', ctx);

  void app.register(cors, {
    origin: true,
    exposedHeaders: ['idempotent-replayed', 'x-mosolo-subject', 'content-language'],
  });

  // Corps brut conservé : nécessaire à la vérification des signatures (prestataires, terminaux).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    if (raw.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new ApiError(400, 'INVALID_JSON', 'Corps JSON invalide.'), undefined);
    }
  });

  app.addHook('onRequest', async (req) => {
    req.user = resolveDemoUser(req, ctx.users);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    let apiErr: ApiError;
    if (err instanceof ApiError) apiErr = err;
    else if (err && typeof err === 'object' && 'statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number' && (err as { statusCode: number }).statusCode < 500) {
      const e = err as { statusCode: number; message: string; code?: string };
      apiErr = new ApiError(e.statusCode, e.code ?? 'BAD_REQUEST', e.message);
    } else {
      req.log.error(err);
      apiErr = new ApiError(500, 'INTERNAL_ERROR', 'Erreur interne.');
    }
    if (apiErr.status === 403) {
      // Tout refus d'accès est journalisé (qui, quoi, pourquoi).
      ctx.audit.append({
        actor: req.user ? { kind: 'user', id: req.user.id, roles: req.user.roles } : { kind: 'public', id: 'anonyme' },
        action: 'access.denied', resourceType: 'route', resourceId: `${req.method} ${req.routeOptions.url ?? req.url}`, outcome: 'DENIED',
        details: { code: apiErr.code, detail: apiErr.message },
      });
    }
    return reply.code(apiErr.status).type('application/problem+json').send(apiErr.toProblem(req.url));
  });

  app.setNotFoundHandler((req, reply) => {
    const e = new ApiError(404, 'ROUTE_NOT_FOUND', `Route inconnue : ${req.method} ${req.url}`);
    return reply.code(404).type('application/problem+json').send(e.toProblem(req.url));
  });

  registerSystemRoutes(app, ctx);
  registerIdentityRoutes(app, ctx);
  registerObjectRoutes(app, ctx);
  registerRuleRoutes(app, ctx);
  registerAssessmentRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  registerTreasuryRoutes(app, ctx);
  registerReceiptRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerCommunicationRoutes(app, ctx);
  registerDraftRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerFxRoutes(app, ctx);
  registerFieldRoutes(app, ctx);
  registerAppealRoutes(app, ctx);
  registerAlertRoutes(app, ctx);
  for (const p of plugins) p.routes?.(app, ctx, ctx.ext[p.name]);
  return app;
}
