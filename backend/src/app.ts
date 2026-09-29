/**
 * Construction de l'application Fastify. `buildApp({ clock, secrets })` : horloge et secrets injectables (tests).
 */
import { loggerOptions } from './plugins/plateforme/supervision.js';
import { staticSiteFromEnv } from './core/static-site.js';
import { installDemoAccessGate } from './core/demo-gate.js';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { createContext, type AppContext, type AppOptions } from './context.js';
import { assertSafeDeployment, ConfigurationError, isDemoMode, resolveDemoUser } from './core/auth.js';
import { ApiError } from './core/errors.js';
import { installRequestCorrelation } from './core/http.js';
import { applySecurityHeaders } from './core/security-headers.js';
import { httpsOptionsFromEnv } from './plugins/socle/mtls.js';
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
import { registerCompteUniqueRoutes } from './modules/identity/compte-unique-routes.js';
import { registerObjectRoutes } from './modules/objects/routes.js';
import { registerPaymentRoutes } from './modules/payments/routes.js';
import { registerIntegrationRoutes } from './modules/integrations/routes.js';
import { registerReceiptRoutes } from './modules/receipts/routes.js';
import { registerRuleRoutes } from './modules/rules/routes.js';
import { registerSystemRoutes } from './modules/system/routes.js';
import { registerTreasuryRoutes } from './modules/treasury/routes.js';
import { registerVaultRoutes } from './modules/vault/routes.js';
import { seed } from './seed.js';
import { applyBootstrap, loadBootstrapFile, type BootstrapDocument, type BootstrapReport } from './persistence/bootstrap.js';
import { DEFAULT_PLUGINS } from './plugins/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    /** Compte rendu de l'amorçage hors démonstration (null : aucun fichier d'amorçage). */
    bootstrapReport: BootstrapReport | null;
  }
}

/**
 * Origines CORS autorisées : liste explicite MOSOLO_CORS_ORIGINS (« https://a.example,https://b.example »).
 * Sans liste : toute origine en mode démonstration (développement local), AUCUNE hors démonstration (même origine).
 */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] | boolean {
  const list = (env.MOSOLO_CORS_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  if (list.includes('*')) {
    if (!isDemoMode(env)) throw new ConfigurationError('MOSOLO_CORS_ORIGINS=* est refusé hors mode démonstration : listez les origines autorisées.');
    return true;
  }
  if (list.length > 0) return list;
  return isDemoMode(env);
}

/**
 * Mandataires inverses de confiance (MOSOLO_TRUST_PROXY) : « true », nombre de sauts, ou liste d'adresses/CIDR.
 * Défaut : aucun — `req.ip` est l'adresse du pair TCP et X-Forwarded-For est ignoré (limitation de débit non contournable).
 */
export function trustProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | string[] | ((address: string, hop: number) => boolean) {
  const v = (env.MOSOLO_TRUST_PROXY ?? '').trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) {
    const hops = Number.parseInt(v, 10);
    return (_address: string, hop: number) => hop < hops;
  }
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Données de démonstration : semées UNIQUEMENT en mode démonstration (ou sur demande explicite `seed: true`, tests).
 * Hors démonstration, la plateforme démarre VIDE : aucun ordre, quittance, écriture, suspens, utilisateur ni compte
 * fictif — l'amorçage réel passe par le fichier MOSOLO_BOOTSTRAP_FILE (voir persistence/bootstrap.ts).
 */
export function shouldSeed(opts: { seed?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return opts.seed ?? isDemoMode(env);
}

/** Erreurs du cadriciel Fastify traduites (deuxième passe adverse, 27/09/2026 : messages anglais exposés à l'usager). */
const FRAMEWORK_ERRORS: Record<string, { code: string; detail: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { code: 'CORPS_TROP_VOLUMINEUX', detail: 'Corps de requête trop volumineux (limite : 1 Mo). Pour un fichier, utilisez le téléversement prévu.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { code: 'TYPE_CONTENU_NON_PRIS_EN_CHARGE', detail: 'Type de contenu non pris en charge : envoyez du JSON (application/json).' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { code: 'CORPS_JSON_VIDE', detail: 'Corps JSON vide alors qu’un type application/json est annoncé.' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { code: 'LONGUEUR_INVALIDE', detail: 'Longueur de contenu annoncée incohérente avec le corps reçu.' },
  FST_ERR_CTP_INVALID_TYPE: { code: 'TYPE_CONTENU_INVALIDE', detail: 'En-tête Content-Type invalide.' },
};

export interface BuildOptions extends AppOptions {
  logger?: boolean;
  /** Amorçage hors démonstration (défaut : fichier MOSOLO_BOOTSTRAP_FILE s'il est défini). Ignoré si les données de démonstration sont semées. */
  bootstrap?: BootstrapDocument;
}

export function buildApp(opts: BuildOptions = {}): FastifyInstance {
  // Sûr par défaut : démonstration refusée en production, secrets de démonstration refusés hors démonstration.
  assertSafeDeployment(process.env);
  const origin = corsOrigins(process.env);
  // TLS mutuel direct (§ 30.1) : certificat client demandé si MOSOLO_TLS_CERT_FILE / MOSOLO_TLS_KEY_FILE sont fournis.
  const https = httpsOptionsFromEnv(process.env);
  // Conversion justifiée : l'instance HTTPS (TLS mutuel facultatif) a un type générique différent de l'instance HTTP ;
  // les routes n'utilisent que l'interface commune de FastifyInstance.
  const app = Fastify({ logger: opts.logger ? loggerOptions() : false, bodyLimit: 1_048_576, trustProxy: trustProxyFromEnv(process.env), ...(https ? { https } : {}) }) as unknown as FastifyInstance;
  // Corrélation (X-Request-Id) et contexte d'audit : PREMIER crochet, avant l'authentification.
  installRequestCorrelation(app);
  // Démonstration hébergée : mot de passe d'accès commun si MOSOLO_DEMO_ACCESS_PASSWORD est fournie (troisième passe, D3-06).
  installDemoAccessGate(app);
  const ctx = createContext(opts);
  const plugins = opts.plugins ?? DEFAULT_PLUGINS;
  const seeded = shouldSeed(opts);
  // Connu des modules dès leur création : hors démonstration, aucun élément fictif de configuration n'est défini.
  ctx.demoData = seeded;
  for (const p of plugins) ctx.ext[p.name] = p.create(ctx);
  // Un amorçage réel et des données fictives ne se mélangent jamais.
  const bootstrap = seeded ? undefined : opts.bootstrap ?? (process.env.MOSOLO_BOOTSTRAP_FILE?.trim() ? loadBootstrapFile(process.env.MOSOLO_BOOTSTRAP_FILE.trim()) : undefined);
  if (seeded) {
    seed(ctx);
    for (const p of plugins) p.seed?.(ctx, ctx.ext[p.name]);
    // Doctrine (§ 18.1) : l'alias de règlement de chaque connecteur doit exister dans le coffre — sinon, pas de démarrage.
    // (Sans données semées, le contrôle est refait à chaque création d'intention par la résolution d'alias.)
    ctx.connectors.validate((alias) => ctx.vault.aliasExists(alias));
  }
  app.decorate('ctx', ctx);

  void app.register(cors, {
    origin,
    exposedHeaders: ['idempotent-replayed', 'x-mosolo-subject', 'content-language', 'retry-after', 'x-mosolo-sha256', 'x-mosolo-signature', 'x-mosolo-server-time', 'x-request-id'],
  });

  // Heure de référence = heure du SERVEUR (§ H.11.6) : chaque réponse la porte ; le client s'y cale pour ses comptes à rebours.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-mosolo-server-time', ctx.clock.now().toISOString());
    // En-têtes de sécurité (API JSON, pages légères, application web) : voir core/security-headers.ts.
    applySecurityHeaders(reply);
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
      // Erreurs du cadriciel (corps trop volumineux, type de contenu…) : code stable et message en français.
      const fr = e.code ? FRAMEWORK_ERRORS[e.code] : undefined;
      apiErr = fr ? new ApiError(e.statusCode, fr.code, fr.detail) : new ApiError(e.statusCode, e.code ?? 'BAD_REQUEST', e.message);
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
    // Prestataire déclaré indisponible (disjoncteur, confirmation serveur à serveur) : délai de nouvelle tentative explicite.
    const retryAfter = apiErr.extensions.retryAfterSeconds;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) reply.header('retry-after', String(Math.ceil(retryAfter)));
    return reply.code(apiErr.status).type('application/problem+json').send(apiErr.toProblem(req.url));
  });

  const site = staticSiteFromEnv();
  app.setNotFoundHandler((req, reply) => {
    // Démonstration hébergée en un seul service : l'API sert aussi l'application web construite.
    const f = site && (req.method === 'GET' || req.method === 'HEAD') ? site(req.url) : null;
    if (f) return reply.code(200).type(f.type).header('cache-control', f.immutable ? 'public, max-age=31536000, immutable' : 'no-cache').send(f.body);
    const e = new ApiError(404, 'ROUTE_NOT_FOUND', `Route inconnue : ${req.method} ${req.url}`);
    return reply.code(404).type('application/problem+json').send(e.toProblem(req.url));
  });

  registerSystemRoutes(app, ctx);
  registerIdentityRoutes(app, ctx);
  registerCompteUniqueRoutes(app, ctx);
  registerObjectRoutes(app, ctx);
  registerRuleRoutes(app, ctx);
  registerAssessmentRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  // « Clés et raccordements » (29/09/2026) : console du super-administrateur, écriture seule, deux personnes.
  registerIntegrationRoutes(app, ctx);
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
  // Amorçage APRÈS le rattachement de la persistance (dans les `routes` du socle) : les comptes du coffre déjà
  // persistés prévalent (jamais écrasés — toute modification passe par la double validation du coffre) et les
  // événements d'amorçage entrent dans la chaîne d'audit restaurée au lieu d'être remplacés par elle.
  let bootstrapReport: BootstrapReport | null = null;
  if (bootstrap) bootstrapReport = applyBootstrap(ctx, bootstrap);
  app.decorate('bootstrapReport', bootstrapReport);
  return app;
}
