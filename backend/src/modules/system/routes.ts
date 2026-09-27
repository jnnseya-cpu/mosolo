import { isDemoMode } from '../../core/auth.js';
import { notFound } from '../../core/errors.js';
import { getActivePersistence } from '../../persistence/runtime.js';
import { CURRENCIES, CURRENCY_CODES, EVENT_CATEGORIES, EVENTS, LANGUAGES, PRIMARY_CURRENCY, REFERENCE_LANGUAGE, completeness, LANGUAGE_CODES, ROLES } from '@mosolo/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { COMMUNES, ENTITIES } from '../../reference/kinshasa.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Sonde de vie : toujours 200 (le processus répond) ; « degraded » quand le stockage persistant est en échec
  // (les écritures sont alors refusées en 503 par le module « socle », les lectures restent servies).
  app.get('/health', async () => {
    const storage = ctx.storageHealth?.();
    return {
      status: storage?.degraded ? 'degraded' : 'ok', service: 'kinshasa-mosolo-backend', time: ctx.clock.now().toISOString(),
      ...(storage ? { storage: storage.degraded ? 'EN_ECHEC' : 'OK' } : {}),
    };
  });

  app.get('/v1/meta', async () => ({
    name: 'KINSHASA MOSOLO',
    apiVersion: 'v1',
    primaryCurrency: PRIMARY_CURRENCY,
    currencies: CURRENCY_CODES.map((c) => CURRENCIES[c]),
    referenceLanguage: REFERENCE_LANGUAGE,
    languages: LANGUAGE_CODES.map((l) => ({ ...LANGUAGES[l], completeness: completeness(l) })),
    catalogue: {
      events: EVENTS.length,
      categories: EVENT_CATEGORIES.length,
      mandatory: EVENTS.filter((e) => e.obligatoire).length,
    },
    communes: COMMUNES,
    entities: Object.values(ENTITIES).map(({ code, name, shortName }) => ({ code, name, shortName })),
    roles: ROLES,
    demo: { auth: isDemoMode() ? 'x-demo-user + OIDC local' : 'OIDC local (jetons porteurs)', storage: getActivePersistence() ? 'postgresql' : 'in-memory', ai: 'deterministic-rules', fxSource: 'BCC (démo)' },
    receiptVerificationKey: { algorithm: 'Ed25519', keyId: ctx.receipts.keyId, publicKeyPem: ctx.receipts.publicKeyPem(), keys: ctx.receipts.verificationKeys() },
  }));

  // Annuaire de démonstration (sélecteur x-demo-user) : démonstration UNIQUEMENT — hors démonstration, 404.
  app.get('/v1/demo/users', async (req) => {
    if (!isDemoMode()) throw notFound('ROUTE_NOT_FOUND', `Route inconnue : GET ${req.url}`);
    return ctx.users.all().map((u) => ({
      id: u.id, name: u.name, roles: u.roles, roleLabels: u.roles.map((r) => ROLES[r]), entity: u.entity,
      ...(u.taxpayerId ? { taxpayerId: u.taxpayerId } : {}), ...(u.territory ? { territory: u.territory } : {}),
    }));
  });
}
