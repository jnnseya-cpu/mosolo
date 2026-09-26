/**
 * Module « socle » : authentification réelle (fournisseur d'identité local compatible OIDC, jetons de session),
 * limitation de débit globale, rattachement de la persistance PostgreSQL optionnelle (DATABASE_URL).
 *
 * Ordre : peut être placé n'importe où dans DEFAULT_PLUGINS (la persistance s'attache dans `routes`, après toutes les
 * données de démonstration de tous les modules) ; recommandé EN DERNIER pour que la limitation de débit s'ajoute
 * après tous les crochets des autres modules.
 */
import type { AppContext } from '../../context.js';
import { registerBearerVerifier } from '../../core/auth.js';
import { getActivePersistence, type PersistenceRuntime } from '../../persistence/runtime.js';
import { definePlugin, type MosoloPlugin } from '../types.js';
import { installRateLimit, rateLimitFromEnv, type RateLimitConfig } from './rate-limit.js';
import { registerSocleRoutes } from './routes.js';
import { IdentityProviderService, type IdpOptions } from './service.js';

export interface SocleOptions {
  idp?: IdpOptions;
  /** Configuration de limitation ; défaut : variables d'environnement (désactivée sous vitest sauf MOSOLO_RATE_LIMIT=on). */
  rateLimit?: RateLimitConfig;
  /** Moteur de persistance ; défaut : celui préparé par persistence/boot.ts (DATABASE_URL), sinon aucun. */
  persistence?: PersistenceRuntime | null;
}

export interface SocleService {
  idp: IdentityProviderService;
  rateLimit: RateLimitConfig;
  persistence: PersistenceRuntime | null;
}

export function createSoclePlugin(opts: SocleOptions = {}): MosoloPlugin<SocleService> {
  return definePlugin<SocleService>({
    name: 'socle',
    create: (ctx: AppContext) => {
      const idp = new IdentityProviderService(ctx, {
        issuer: process.env.MOSOLO_OIDC_ISSUER,
        jwtPrivateKeyPem: process.env.MOSOLO_JWT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        ...opts.idp,
      });
      registerBearerVerifier(ctx.users, (token) => idp.verifyAccessToken(token));
      const persistence = opts.persistence === undefined ? getActivePersistence() ?? null : opts.persistence;
      return { idp, rateLimit: opts.rateLimit ?? rateLimitFromEnv(), persistence };
    },
    routes: (app, ctx, svc) => {
      // Identifiants de démonstration : après les utilisateurs semés par TOUS les modules (les `routes` suivent les `seed`).
      svc.idp.seedDemo();
      // Persistance : après les données de démonstration de TOUS les modules (les `routes` suivent tous les `seed`).
      if (svc.persistence && !svc.persistence.attached) {
        svc.persistence.attach(ctx);
        app.addHook('onClose', async () => {
          await svc.persistence?.flush().catch(() => undefined);
        });
      }
      installRateLimit(app, ctx, svc.rateLimit);
      registerSocleRoutes(app, ctx, svc);
    },
  });
}

export const soclePlugin = createSoclePlugin();
