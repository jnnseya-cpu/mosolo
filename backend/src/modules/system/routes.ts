import { CURRENCIES, CURRENCY_CODES, EVENT_CATEGORIES, EVENTS, LANGUAGES, PRIMARY_CURRENCY, REFERENCE_LANGUAGE, completeness, LANGUAGE_CODES, ROLES } from '@mosolo/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { COMMUNES, ENTITIES } from '../../reference/kinshasa.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async () => ({ status: 'ok', service: 'kinshasa-mosolo-backend', time: ctx.clock.now().toISOString() }));

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
    demo: { auth: 'x-demo-user', storage: 'in-memory', ai: 'deterministic-rules', fxSource: 'BCC (démo)' },
    receiptVerificationKey: { algorithm: 'Ed25519', publicKeyPem: ctx.receipts.publicKeyPem() },
  }));

  app.get('/v1/demo/users', async () =>
    ctx.users.all().map((u) => ({
      id: u.id, name: u.name, roles: u.roles, roleLabels: u.roles.map((r) => ROLES[r]), entity: u.entity,
      ...(u.taxpayerId ? { taxpayerId: u.taxpayerId } : {}), ...(u.territory ? { territory: u.territory } : {}),
    })),
  );
}
