/**
 * Console « Clés et raccordements » (29/09/2026) — super-administrateur (R26) et responsable sécurité (R28).
 * Contrôles : écriture seule (aucune route ne renvoie une valeur), règle des deux personnes, audit sans valeur,
 * chiffrement au repos (bloc stocké ≠ clair, persistance), résolution environnement / console, connecteurs reconstruits
 * SANS redémarrage, refus de format sans écho de la valeur, 403 pour les autres rôles (dont R01–R05).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { AuditLog } from '../src/core/audit.js';
import { PersistenceRuntime } from '../src/persistence/runtime.js';
import { MemorySnapshotStore } from '../src/persistence/store.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { redactExportRows } from '../src/plugins/socle/routes.js';
import { signKodaWebhook } from '../src/modules/payments/connectors/koda.js';
import { IntegrationConfigService, checkFormat } from '../src/modules/integrations/service.js';
import { INVENTORY, variable } from '../src/modules/integrations/inventory.js';
import { DEMO } from '../src/seed.js';
import { ProviderSimulator } from './simulateur-prestataires.js';

const MASTER = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16) + 'd'.repeat(16); // 32 octets en hexadécimal (test)
const sim = new ProviderSimulator();
let savedMaster: string | undefined;
beforeAll(async () => {
  await sim.start();
  savedMaster = process.env.MOSOLO_CONFIG_MASTER_KEY;
  process.env.MOSOLO_CONFIG_MASTER_KEY = MASTER;
});
afterAll(async () => {
  await sim.stop();
  if (savedMaster === undefined) delete process.env.MOSOLO_CONFIG_MASTER_KEY;
  else process.env.MOSOLO_CONFIG_MASTER_KEY = savedMaster;
});
beforeEach(() => sim.reset());

// Valeurs de test (jamais réelles) : aucune ne doit ressortir d'une réponse, d'un journal ou du stockage.
const KODA_KEY = 'sk_test_CONSOLE_KODA_CLE_0000000001';
const KODA_WHSEC = 'whsec_console_koda_secret_000000001';
const SMS_SECRET = 'secret-passerelle-sms-console-0001';
const ENV_WHSEC = 'whsec_environnement_bitripay_00000001';
const SECRETS = [KODA_KEY, KODA_WHSEC, SMS_SECRET, ENV_WHSEC];

async function boot(opts: { connectorEnv?: Record<string, string>; store?: MemorySnapshotStore } = {}) {
  const clock = new ManualClock('2026-09-29T10:00:00.000Z');
  const rt = opts.store ? await PersistenceRuntime.open(opts.store) : undefined;
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    // Avec stockage : tous les modules (passerelle SMS du module « preuves » comprise) et la persistance attachée.
    ...(rt ? { plugins: [...DEFAULT_PLUGINS.filter((p) => p.name !== 'socle'), createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false }, persistence: rt })] } : { plugins: [] }),
    connectorEnv: opts.connectorEnv ?? {},
    connectorRuntime: { timeoutMs: 2_000, sleep: async () => {}, now: () => clock.now().getTime() },
  });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  /** Proposition par le super-administrateur, approbation par le responsable sécurité (deux personnes). */
  const setValue = async (name: string, value: string) => {
    const p = await req('POST', `/v1/integrations/keys/${name}/proposals`, 'u-superadmin', { kind: 'DEFINIR', value, motif: 'Raccordement de recette' });
    expect(p.statusCode, p.body).toBe(201);
    const a = await req('POST', `/v1/integrations/proposals/${p.json().id}/approve`, 'u-rssi', { motif: 'Vérifié hors bande' });
    expect(a.statusCode, a.body).toBe(200);
    return a.json();
  };
  return { app, clock, rt, req, setValue };
}

const noSecretIn = (text: string) => {
  for (const s of SECRETS) expect(text).not.toContain(s);
};

describe('Accès : console réservée au super-administrateur (R26) et au responsable sécurité (R28)', () => {
  it('403 pour les autres rôles, dont Gouverneur, directeur de cabinet et ministres ; R28 lit et approuve mais ne propose pas', async () => {
    const e = await boot();
    for (const u of ['u-contribuable', 'u-tresor', 'u-gouverneur', 'u-dircab', 'u-ministre-finances', 'u-auditeur', 'u-agent-terrain']) {
      expect((await e.req('GET', '/v1/integrations/keys', u)).statusCode, u).toBe(403);
      expect((await e.req('GET', '/v1/integrations/webhooks', u)).statusCode, u).toBe(403);
      expect((await e.req('GET', '/v1/integrations/proposals', u)).statusCode, u).toBe(403);
      expect((await e.req('POST', '/v1/integrations/keys/KODA_API_KEY/proposals', u, { kind: 'DEFINIR', value: KODA_KEY, motif: 'essai' })).statusCode, u).toBe(403);
      expect((await e.req('POST', '/v1/integrations/koda/test', u, {})).statusCode, u).toBe(403);
    }
    expect((await e.req('GET', '/v1/integrations/keys')).statusCode).toBe(401);
    expect((await e.req('GET', '/v1/integrations/keys', 'u-superadmin')).statusCode).toBe(200);
    expect((await e.req('GET', '/v1/integrations/keys', 'u-rssi')).statusCode).toBe(200);
    expect((await e.req('POST', '/v1/integrations/keys/KODA_API_KEY/proposals', 'u-rssi', { kind: 'DEFINIR', value: KODA_KEY, motif: 'essai' })).statusCode).toBe(403);
    await e.app.close();
  });
});

describe('Inventaire, écriture seule, deux personnes, audit', () => {
  it('inventaire groupé (paiement, IA, SMS, e-mail, WhatsApp, cartes, MDM, identité…) : noms, présence, source — jamais une valeur', async () => {
    const e = await boot({ connectorEnv: { BITRIPAY_WEBHOOK_SECRET: ENV_WHSEC } });
    const inv = (await e.req('GET', '/v1/integrations/keys', 'u-superadmin')).json();
    expect(inv.groups.map((g: { id: string }) => g.id)).toEqual(expect.arrayContaining(['bitripay', 'koda', 'ia', 'sms-ussd', 'email', 'whatsapp', 'cartes', 'mdm', 'identite', 'socle']));
    const all = inv.groups.flatMap((g: { variables: unknown[] }) => g.variables) as { name: string; activeSource: string; envPresent: boolean; settable: boolean; proposedName: boolean }[];
    expect(all.find((v) => v.name === 'BITRIPAY_WEBHOOK_SECRET')).toMatchObject({ envPresent: true, activeSource: 'ENVIRONNEMENT' });
    expect(all.find((v) => v.name === 'DATABASE_URL')).toMatchObject({ settable: false });
    expect(all.find((v) => v.name === 'MOSOLO_AI_PROVIDER_KEY')).toMatchObject({ settable: true, proposedName: true });
    expect(inv.masterKey).toMatchObject({ state: 'PRESENTE', writable: true });
    expect(inv.resolutionRule).toMatch(/environnement prévaut/);
    noSecretIn(JSON.stringify(inv));
    expect(JSON.stringify(inv)).not.toMatch(/…[A-Za-z0-9]{2,}"/); // pas même une valeur masquée
    // Toute lecture process.env d'un service externe figure à l'inventaire (contrôle de complétude minimal).
    for (const name of ['SMS_GATEWAY_SECRET', 'SVI_GATEWAY_SECRET', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'MOSOLO_SMS_PROVIDER_KEY', 'MOSOLO_EMAIL_PROVIDER_KEY', 'KODA_API_KEY', 'BITRIPAY_API_KEY', 'MOSOLO_PUBLIC_URL', 'MOSOLO_PROVIDER_SECRET_BANK_A']) {
      expect(variable(name), name).toBeDefined();
    }
    await e.app.close();
  });

  it('écriture seule + deux personnes : la personne qui propose ne peut pas approuver ; aucune réponse ni audit ne contient la valeur', async () => {
    const e = await boot();
    const p = await e.req('POST', '/v1/integrations/keys/KODA_WEBHOOK_SECRET/proposals', 'u-superadmin', { kind: 'DEFINIR', value: KODA_WHSEC, motif: 'Secret fourni par KODA' });
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ status: 'EN_ATTENTE', variable: 'KODA_WEBHOOK_SECRET', valueHeld: true });
    // Rien ne s'applique avant l'approbation.
    expect(e.app.ctx.integrations.sourceOf('KODA_WEBHOOK_SECRET')).toBe('ABSENTE');
    const same = await e.req('POST', `/v1/integrations/proposals/${p.json().id}/approve`, 'u-superadmin', {});
    expect(same.statusCode).toBe(403);
    expect(same.json().code).toBe('SAME_PERSON');
    const ok = await e.req('POST', `/v1/integrations/proposals/${p.json().id}/approve`, 'u-rssi', { motif: 'Contrôlé' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ effective: true, activeSource: 'CONSOLE', proposal: { status: 'APPROUVEE', valueHeld: false, decidedBy: 'u-rssi' } });
    // Décision déjà prise : plus de seconde approbation.
    expect((await e.req('POST', `/v1/integrations/proposals/${p.json().id}/approve`, 'u-rssi', {})).statusCode).toBe(409);
    const bodies = [
      p.body, ok.body,
      (await e.req('GET', '/v1/integrations/keys', 'u-rssi')).body,
      (await e.req('GET', '/v1/integrations/proposals', 'u-superadmin')).body,
      (await e.req('GET', '/v1/integrations/webhooks', 'u-superadmin')).body,
      (await e.req('GET', '/v1/providers/readiness', 'u-superadmin')).body,
      (await e.req('GET', '/v1/providers/connectors', 'u-superadmin')).body,
      JSON.stringify(e.app.ctx.audit.unsafeRawStorageForTamperTests()),
    ];
    for (const b of bodies) noSecretIn(b);
    const actions = e.app.ctx.audit.list({ action: 'integration.config.proposed' });
    expect(actions.total).toBe(1);
    expect(e.app.ctx.audit.list({ action: 'integration.config.approved' }).total).toBe(1);
    expect(e.app.ctx.audit.list({ action: 'integration.config.refused' }).total).toBe(1); // tentative de la même personne
    // Aucune route ne permet de relire la valeur : pas de GET sur une variable.
    expect((await e.req('GET', '/v1/integrations/keys/KODA_WEBHOOK_SECRET', 'u-superadmin')).statusCode).toBe(404);
    await e.app.close();
  });

  it('rejet : la valeur chiffrée en attente est effacée ; nouvelle proposition : l’ancienne est remplacée', async () => {
    const e = await boot();
    const p1 = (await e.req('POST', '/v1/integrations/keys/KODA_API_KEY/proposals', 'u-superadmin', { kind: 'DEFINIR', value: KODA_KEY, motif: 'Première saisie' })).json();
    const p2 = (await e.req('POST', '/v1/integrations/keys/KODA_API_KEY/proposals', 'u-superadmin', { kind: 'DEFINIR', value: `${KODA_KEY}X`, motif: 'Correction' })).json();
    expect(e.app.ctx.integrations.proposals.get(p1.id)).toMatchObject({ status: 'REMPLACEE', blob: null });
    const r = await e.req('POST', `/v1/integrations/proposals/${p2.id}/reject`, 'u-rssi', { motif: 'Clé non vérifiée hors bande' });
    expect(r.json()).toMatchObject({ status: 'REJETEE', valueHeld: false });
    expect(e.app.ctx.integrations.proposals.get(p2.id)!.blob).toBeNull();
    expect(e.app.ctx.integrations.sourceOf('KODA_API_KEY')).toBe('ABSENTE');
    await e.app.close();
  });

  it('formats refusés sans écho de la valeur ; variables réservées à l’environnement et inconnues refusées', async () => {
    const e = await boot();
    const cases: [string, string, RegExp][] = [
      ['KODA_API_KEY', 'pk_test_CLE_PUBLIABLE_000000000001', /pk_… refusée/],
      ['KODA_API_KEY', 'rk_test_LECTURE_SEULE_00000000001', /rk_… refusée/],
      ['BITRIPAY_API_KEY', 'sk_test_court', /trop courte/],
      ['BITRIPAY_WEBHOOK_SECRET', 'secret-sans-prefixe-whsec-0000001', /whsec_/],
      ['KODA_WEBHOOK_SECRET', 'demo-whsec-koda-public-000000001', /démonstration/],
      ['KODA_BASE_URL', 'ftp://kodajnn.com/v1', /https/],
      ['SMS_GATEWAY_SECRET', 'xq9', /trop court/],
    ];
    for (const [name, value, msg] of cases) {
      const r = await e.req('POST', `/v1/integrations/keys/${name}/proposals`, 'u-superadmin', { kind: 'DEFINIR', value, motif: 'essai de format' });
      expect(r.statusCode, `${name}`).toBe(422);
      expect(r.json().code).toBe('INVALID_VALUE_FORMAT');
      expect(r.json().detail).toMatch(msg);
      expect(r.body).not.toContain(value);
    }
    expect(JSON.stringify(e.app.ctx.audit.unsafeRawStorageForTamperTests())).not.toContain('pk_test_CLE_PUBLIABLE');
    const envOnly = await e.req('POST', '/v1/integrations/keys/DATABASE_URL/proposals', 'u-superadmin', { kind: 'DEFINIR', value: 'postgres://x', motif: 'essai' });
    expect(envOnly.statusCode).toBe(409);
    expect(envOnly.json().code).toBe('ENVIRONMENT_ONLY');
    expect((await e.req('POST', '/v1/integrations/keys/INCONNUE/proposals', 'u-superadmin', { kind: 'DEFINIR', value: 'x', motif: 'essai' })).statusCode).toBe(404);
    // Production déclarée : une clé de test sk_test_… est refusée (par défaut — à confirmer).
    expect(checkFormat(variable('KODA_API_KEY')!, KODA_KEY, { production: true })).toMatch(/production/);
    expect(checkFormat(variable('KODA_API_KEY')!, KODA_KEY, { production: false })).toBeNull();
    await e.app.close();
  });

  it('clé maîtresse absente hors démonstration : la console refuse toute écriture avec un message clair', () => {
    const svc = new IntegrationConfigService(new ManualClock('2026-09-29T10:00:00.000Z'), new AuditLog(new ManualClock('2026-09-29T10:00:00.000Z'), 'k'), { processEnv: {}, demo: false });
    expect(svc.masterKeyState).toBe('ABSENTE');
    const admin = { id: 'u-superadmin', name: 'x', roles: ['R26'], entity: 'PLATEFORME' } as unknown as Parameters<typeof svc.propose>[0];
    expect(() => svc.propose(admin, 'KODA_API_KEY', { kind: 'DEFINIR', value: KODA_KEY, motif: 'essai' })).toThrow(/MOSOLO_CONFIG_MASTER_KEY est absente/);
    // Démonstration sans clé : clé éphémère signalée.
    const demo = new IntegrationConfigService(new ManualClock('2026-09-29T10:00:00.000Z'), new AuditLog(new ManualClock('2026-09-29T10:00:00.000Z'), 'k'), { processEnv: {}, demo: true });
    expect(demo.masterKeyState).toBe('EPHEMERE_DEMO');
  });
});

describe('Chiffrement au repos, persistance, résolution et prise en compte à chaud', () => {
  it('bloc stocké ≠ clair (AES-256-GCM lié au nom de la variable) ; persistance : valeur relue après redémarrage, illisible avec une autre clé maîtresse ; export sans bloc', async () => {
    const store = new MemorySnapshotStore();
    const e1 = await boot({ store });
    await e1.setValue('SMS_GATEWAY_SECRET', SMS_SECRET);
    const stored = e1.app.ctx.integrations.values.get('SMS_GATEWAY_SECRET')!;
    expect(stored.blob).toMatchObject({ alg: 'AES-256-GCM' });
    expect(JSON.stringify(stored)).not.toContain(SMS_SECRET);
    expect(Buffer.from(stored.blob!.ct, 'base64').toString('utf8')).not.toContain(SMS_SECRET);
    await e1.app.close();
    await e1.rt!.flush();
    const rows = await store.loadAll();
    expect(rows.some((r) => r.repo === 'integrations.values')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(SMS_SECRET);
    // Export massif : le bloc chiffré n'est jamais recopié.
    const redacted = redactExportRows(rows);
    expect(redacted.redacted).toContain('integrations.values.blob');
    expect(redacted.rows.filter((r) => r.repo === 'integrations.values').every((r) => !('blob' in (r.doc as Record<string, unknown>)))).toBe(true);

    // Redémarrage, même clé maîtresse : la passerelle SMS vérifie avec le secret de la console, sans redéploiement.
    const e2 = await boot({ store });
    expect(e2.app.ctx.integrations.sourceOf('SMS_GATEWAY_SECRET')).toBe('CONSOLE');
    const body = JSON.stringify({ from: '+243810000001', text: 'SOLDE' });
    const good = await e2.app.inject({ method: 'POST', url: '/v1/sms/inbound', payload: body, headers: { 'content-type': 'application/json', 'x-mosolo-signature': createHmac('sha256', SMS_SECRET).update(body).digest('hex') } });
    expect(good.statusCode).toBe(200);
    expect(good.json().simulated).toBe(false);
    const bad = await e2.app.inject({ method: 'POST', url: '/v1/sms/inbound', payload: body, headers: { 'content-type': 'application/json', 'x-mosolo-signature': createHmac('sha256', 'autre-secret-000000000000').update(body).digest('hex') } });
    expect(bad.statusCode).toBe(403);
    const hooks = (await e2.req('GET', '/v1/integrations/webhooks', 'u-rssi')).json();
    expect(hooks.webhooks.find((w: { id: string }) => w.id === 'sms')).toMatchObject({ secretVariable: 'SMS_GATEWAY_SECRET', secretSource: 'CONSOLE', lastDelivery: { verification: 'REFUSEE', code: 'BAD_SIGNATURE' } });
    await e2.app.close();
    await e2.rt!.flush();

    // Autre clé maîtresse : la valeur est présente mais illisible — jamais appliquée.
    process.env.MOSOLO_CONFIG_MASTER_KEY = 'e'.repeat(64);
    try {
      const e3 = await boot({ store });
      const inv = (await e3.req('GET', '/v1/integrations/keys', 'u-superadmin')).json();
      const v = inv.groups.flatMap((g: { variables: unknown[] }) => g.variables).find((x: { name: string }) => x.name === 'SMS_GATEWAY_SECRET');
      expect(v).toMatchObject({ consolePresent: true, consoleUnreadable: true, activeSource: 'ABSENTE' });
      await e3.app.close();
    } finally {
      process.env.MOSOLO_CONFIG_MASTER_KEY = MASTER;
    }
  });

  it('résolution : la variable d’environnement prévaut ; la console ne s’applique qu’en son absence (source affichée)', async () => {
    const e = await boot({ connectorEnv: { BITRIPAY_WEBHOOK_SECRET: ENV_WHSEC } });
    const a = await e.setValue('BITRIPAY_WEBHOOK_SECRET', 'whsec_console_bitripay_00000000001');
    expect(a).toMatchObject({ effective: false, activeSource: 'ENVIRONNEMENT' });
    expect(e.app.ctx.integrations.value('BITRIPAY_WEBHOOK_SECRET')).toBe(ENV_WHSEC);
    const b = await e.setValue('MOSOLO_PUBLIC_URL', 'https://mosolo.kinshasa.cd');
    expect(b).toMatchObject({ effective: true, activeSource: 'CONSOLE' });
    const hooks = (await e.req('GET', '/v1/integrations/webhooks', 'u-superadmin')).json();
    expect(hooks.webhooks.find((w: { id: string }) => w.id === 'koda').url).toBe('https://mosolo.kinshasa.cd/v1/providers/koda/webhooks');
    expect(hooks.webhooks.find((w: { id: string }) => w.id === 'whatsapp').url).toBe('https://mosolo.kinshasa.cd/v1/whatsapp/webhook');
    expect(hooks.webhooks.find((w: { id: string }) => w.id === 'bitripay')).toMatchObject({ secretSource: 'ENVIRONNEMENT', urlReady: true });
    await e.app.close();
  });

  it('connecteur KODA raccordé depuis la console SANS redémarrage : clé, secret, URL ; configuration partielle refusée sans casser le service ; retrait', async () => {
    const e = await boot();
    expect(e.app.ctx.connectors.get('koda')!.mode).toBe('SANDBOX_LOCAL');
    await e.setValue('MOSOLO_PUBLIC_URL', 'https://mosolo.kinshasa.cd');
    await e.setValue('KODA_BASE_URL', `${sim.base}/koda/v1`);
    // Clé sans secret de webhook : configuration invalide ⇒ signalée (sans valeur), connecteur précédent maintenu.
    const partial = await e.setValue('KODA_API_KEY', KODA_KEY);
    expect(partial.configurationWarning).toMatch(/KODA : secret de webhook obligatoire/);
    noSecretIn(JSON.stringify(partial));
    expect(e.app.ctx.connectors.get('koda')!.mode).toBe('SANDBOX_LOCAL');
    const done = await e.setValue('KODA_WEBHOOK_SECRET', KODA_WHSEC);
    expect(done.configurationWarning).toBeNull();
    const koda = e.app.ctx.connectors.get('koda')!;
    expect(koda.mode).toBe('TEST');
    expect(e.app.ctx.connectors.reloads).toBeGreaterThan(0);

    // Paiement réel (simulateur) avec la clé de la console : Authorization, success_url, webhook signé avec le secret.
    const ob = e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const order = (await e.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY', provider: 'koda' }, { 'idempotency-key': randomUUID() })).json();
    const create = sim.calls.find((c) => c.method === 'POST' && c.path === '/koda/v1/intents')!;
    expect(create.headers.authorization).toBe(`Bearer ${KODA_KEY}`);
    expect(JSON.parse(create.body).success_url).toBe(`https://mosolo.kinshasa.cd/paiement/retour?ref=${encodeURIComponent(order.paymentReference)}`);
    sim.kodaCheckout(order.providerIntentId, 'TEST-OK-25000', e.clock.now().getTime());
    const raw = JSON.stringify({ id: `evt_${randomUUID().slice(0, 12)}`, type: 'payment.verified', data: { intent_id: order.providerIntentId, amount: 15000, currency: 'USD', receipt_id: 'KR-CONSOLE-1', metadata: { payment_reference: order.paymentReference } } });
    const w = await e.app.inject({ method: 'POST', url: '/v1/providers/koda/webhooks', payload: raw, headers: { 'content-type': 'application/json', 'x-koda-signature': signKodaWebhook(KODA_WHSEC, raw) } });
    expect(w.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    // « Tester » depuis la console : appel réel inoffensif GET /ping avec la clé de la console.
    const t = (await e.req('POST', '/v1/integrations/koda/test', 'u-rssi', {})).json();
    expect(t).toMatchObject({ integration: 'koda', kind: 'APPEL_REEL', endpoint: 'GET /ping', ok: true });
    const hooks = (await e.req('GET', '/v1/integrations/webhooks', 'u-superadmin')).json();
    expect(hooks.webhooks.find((x: { id: string }) => x.id === 'koda')).toMatchObject({ secretSource: 'CONSOLE', lastDelivery: { verification: 'VALIDE', httpStatus: 200 } });
    const readiness = (await e.req('GET', '/v1/providers/readiness', 'u-superadmin')).json();
    const kv = readiness.providers.find((p: { id: string }) => p.id === 'koda');
    expect(kv.variables.find((v: { name: string }) => v.name === 'KODA_API_KEY')).toMatchObject({ present: true, source: 'CONSOLE' });
    noSecretIn(JSON.stringify(readiness));

    // Retrait (deux personnes) : retour au bac à sable local, sans redémarrage.
    for (const name of ['KODA_API_KEY', 'KODA_WEBHOOK_SECRET']) {
      const p = (await e.req('POST', `/v1/integrations/keys/${name}/proposals`, 'u-superadmin', { kind: 'RETIRER', motif: 'Fin de recette' })).json();
      expect((await e.req('POST', `/v1/integrations/proposals/${p.id}/approve`, 'u-rssi', {})).statusCode).toBe(200);
    }
    expect(e.app.ctx.connectors.get('koda')!.mode).toBe('SANDBOX_LOCAL');
    await e.app.close();
  });

  it('canaux de communication : une clé de fournisseur approuvée raccorde le canal sans redémarrage ; « Tester » dit qu’il s’agit d’une validation de configuration', async () => {
    const e = await boot();
    const sms = () => e.app.ctx.comms.channelStatus().find((c) => c.channel === 'sms')!;
    expect(sms().wired).toBe(false);
    await e.setValue('MOSOLO_SMS_PROVIDER_KEY', 'cle-fournisseur-sms-console-000001');
    expect(sms().wired).toBe(true);
    const t = (await e.req('POST', '/v1/integrations/sms-ussd/test', 'u-superadmin', {})).json();
    expect(t).toMatchObject({ kind: 'VALIDATION_A_BLANC' });
    expect(t.proves).toMatch(/Aucun appel/);
    expect(t.checks).toEqual(expect.arrayContaining([expect.objectContaining({ label: expect.stringMatching(/Canal « sms » : raccordé/) })]));
    const ia = (await e.req('POST', '/v1/integrations/ia/test', 'u-superadmin', {})).json();
    expect(ia.checks[0].detail).toMatch(/nom proposé — à confirmer/);
    expect(e.app.ctx.audit.list({ action: 'integration.config.tested' }).total).toBe(2);
    await e.app.close();
  });

  it('inventaire : chaque variable a un groupe connu, un rôle et un effet ; aucune en double', () => {
    const names = INVENTORY.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of INVENTORY) expect(v.purpose.length).toBeGreaterThan(5);
  });
});
