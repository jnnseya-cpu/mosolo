/**
 * Deuxième passe adverse (27/09/2026), phase « injection de pannes » : magasin persistant qui échoue, prestataire de
 * paiement en erreur ou hors délai, fournisseur de communication qui lève une exception, fournisseur d'IA défaillant,
 * tâche planifiée qui lève une exception. Attendus : message exact à l'usager, aucune corruption, nouvelles tentatives
 * bornées, alerte ou trace d'audit pour l'exploitant, processus jamais arrêté (aucun rejet de promesse non géré).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { runScheduledJob } from '../src/core/jobs.js';
import { installProcessGuards } from '../src/core/process-guards.js';
import { PersistenceRuntime } from '../src/persistence/runtime.js';
import { MemorySnapshotStore, type SnapshotRow } from '../src/persistence/store.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import { DEMO } from '../src/seed.js';
import { PROVIDER_SECRET } from './helpers.js';
import { BITRI_ED_PUBLIC } from './signature-ed25519-test.js';

const SECRETS = { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Magasin qui échoue tant que `down` est vrai (panne de la base). */
class FlakyStore extends MemorySnapshotStore {
  down = false;
  failures = 0;
  override async write(rows: SnapshotRow[], at: Date): Promise<void> {
    if (this.down) {
      this.failures++;
      throw new Error('connexion refusée (panne simulée)');
    }
    return super.write(rows, at);
  }
}

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };
process.on('unhandledRejection', onUnhandled);
afterEach(() => { unhandled.length = 0; });

async function persistentApp(store: FlakyStore) {
  const rt = await PersistenceRuntime.open(store, { flushDelayMs: 5, retryBaseMs: 5, retryMaxMs: 40 });
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: SECRETS, plugins: [createSoclePlugin({ persistence: rt, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })] });
  await app.ready();
  await rt.flush();
  return { app, rt, clock };
}

describe('Panne du stockage persistant', () => {
  it('écriture en échec : aucun rejet non géré, nouvelles tentatives bornées, alerte, écritures refusées (503) puis reprise sans perte', async () => {
    const store = new FlakyStore();
    const { app, rt } = await persistentApp(store);
    const obligationId = app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    store.down = true;
    // Première écriture acceptée (tampon d'écriture différée) ; la base tombe.
    const first = await app.inject({ method: 'POST', url: `/v1/obligations/${obligationId}/payment-orders`, headers: { 'x-demo-user': 'u-contribuable', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: JSON.stringify({ channel: 'MOBILE_MONEY' }) });
    expect(first.statusCode).toBe(201);
    await wait(150);
    // Aucun rejet de promesse non géré (qui arrêterait le processus sous Node 22).
    expect(unhandled).toEqual([]);
    const st = rt.status();
    expect(st.lastError).toMatch(/panne simulée/);
    expect(st.consecutiveFailures).toBeGreaterThanOrEqual(3);
    // Tentatives bornées : délai exponentiel plafonné (au plus ~1 tentative / 40 ms ici, jamais une boucle serrée).
    expect(store.failures).toBeLessThan(20);
    expect(st.pendingWrites).toBeGreaterThan(0);
    // L'exploitant est alerté (une fois), la santé l'indique.
    expect(app.ctx.alerts.list().filter((a) => a.type === 'PERSISTANCE_EN_ECHEC')).toHaveLength(1);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ status: 'degraded', storage: 'EN_ECHEC' });
    // Écriture refusée tant que le stockage est en échec : message exact, jamais un faux succès.
    const refused = await app.inject({ method: 'POST', url: `/v1/obligations/${obligationId}/payment-orders`, headers: { 'x-demo-user': 'u-contribuable', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: JSON.stringify({ channel: 'MOBILE_MONEY' }) });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    expect(refused.json()).toMatchObject({ code: 'STOCKAGE_INDISPONIBLE', status: 503 });
    expect(refused.headers['retry-after']).toBeDefined();
    expect(JSON.stringify(refused.json())).not.toMatch(/panne simulée|at .*\.ts|\/home\//);
    // Les lectures restent servies.
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { 'x-demo-user': 'u-contribuable' } })).statusCode).toBe(200);
    // Reprise : tout ce qui était en attente est écrit, sans perte ; les écritures sont de nouveau acceptées.
    store.down = false;
    await wait(120);
    expect(rt.status()).toMatchObject({ pendingWrites: 0, consecutiveFailures: 0, lastError: null });
    const rows = await store.loadAll();
    expect(rows.some((r) => r.repo.endsWith('orders') && (r.doc as { id?: string }).id === first.json().id) || rows.some((r) => JSON.stringify(r.doc).includes(first.json().paymentReference))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/health' })).json().status).toBe('ok');
    await app.close();
    expect(unhandled).toEqual([]);
  });
});

describe('Tâche planifiée qui lève une exception', () => {
  it('journalisée (sans pile), alerte unique par tâche et par jour, jamais propagée', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, secrets: SECRETS, plugins: [] });
    await app.ready();
    const boom = () => { throw new Error('division par zéro dans la clé (panne simulée)'); };
    const r1 = runScheduledJob(app.ctx, 'pilotage.repartition-automatique', boom);
    const r2 = runScheduledJob(app.ctx, 'pilotage.repartition-automatique', boom);
    expect(r1).toMatchObject({ ok: false, error: { code: 'Error' } });
    expect(r2.ok).toBe(false);
    const audit = app.ctx.audit.list({ action: 'system.job.failed' });
    expect(audit.total).toBe(2);
    expect(JSON.stringify(audit.items)).not.toMatch(/\n\s+at /);
    expect(app.ctx.alerts.list().filter((a) => a.type === 'TACHE_PLANIFIEE_EN_ECHEC')).toHaveLength(1);
    // Jour suivant : une nouvelle alerte (la panne persiste).
    clock.set('2026-09-27T09:00:00.000Z');
    runScheduledJob(app.ctx, 'pilotage.repartition-automatique', boom);
    expect(app.ctx.alerts.list().filter((a) => a.type === 'TACHE_PLANIFIEE_EN_ECHEC')).toHaveLength(2);
    expect(runScheduledJob(app.ctx, 'x', () => undefined)).toEqual({ ok: true });
  });

  it('les planificateurs réels passent par la garde (répartition, ParkSmart, liquidation automatique, réserve/surveillance)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['pilotage/repartition/service.ts', 'parking/tarification-dynamique.ts', 'verticales/fiches.ts', 'verticales/secteurs.ts', 'sanctions/service.ts', 'verticales/avia-auto.ts']) {
      const src = readFileSync(new URL(`../src/plugins/${f}`, import.meta.url), 'utf8');
      expect(src, f).toMatch(/setInterval\(\(\) => \{ runScheduledJob\(/);
      expect(src, f).not.toMatch(/setInterval\(\(\) => \{ try \{/);
    }
  });
});

describe('Gardes du processus', () => {
  it('rejet non géré : journalisé et alerté, le processus continue ; exception non capturée : arrêt propre après vidage', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, secrets: SECRETS, plugins: [] });
    await app.ready();
    const handlers: Record<string, (e: unknown) => void> = {};
    const logs: string[] = [];
    const exits: number[] = [];
    let flushed = 0;
    const fakeProcess = { on: (ev: string, fn: (e: unknown) => void) => { handlers[ev] = fn; } };
    installProcessGuards(fakeProcess, {
      ctx: app.ctx, log: (m) => logs.push(m), exit: (c) => { exits.push(c); }, shutdown: async () => { flushed++; },
    });
    handlers.unhandledRejection!(new Error('promesse oubliée (panne simulée)'));
    expect(exits).toEqual([]);
    expect(logs.join(' ')).toMatch(/promesse oubliée/);
    expect(app.ctx.alerts.list().filter((a) => a.type === 'REJET_NON_GERE')).toHaveLength(1);
    handlers.uncaughtException!(new Error('état incohérent (panne simulée)'));
    await wait(10);
    expect(flushed).toBe(1);
    expect(exits).toEqual([1]);
  });
});

describe('Prestataire de paiement en erreur ou hors délai', () => {
  it('réseau coupé puis délai dépassé : 502 exact, tentatives bornées, aucun ordre, trace d’audit, nouvelle tentative possible', async () => {
    let calls = 0;
    let mode: 'reseau' | 'delai' = 'reseau';
    const fetch = async (_url: string, init: { signal?: AbortSignal }) => {
      calls++;
      if (mode === 'reseau') throw new TypeError('fetch failed');
      // Ne répond jamais : seul le délai du client coupe l'appel.
      return new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({
      clock, plugins: [], secrets: SECRETS,
      connectorEnv: { BITRIPAY_ED25519_PUBLIC_KEY: BITRI_ED_PUBLIC, BITRIPAY_API_KEY: 'sk_live_BITRISECRET99887766', BITRIPAY_WEBHOOK_SECRET: 'whsec_live' },
      // Conversion justifiée : faux `fetch` minimal de test (seuls signal et rejet sont utilisés).
      connectorRuntime: { fetch: fetch as never, sleep: async () => {}, timeoutMs: 20 },
    });
    await app.ready();
    const obligationId = app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const create = () => app.inject({ method: 'POST', url: `/v1/obligations/${obligationId}/payment-orders`, headers: { 'x-demo-user': 'u-contribuable', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: JSON.stringify({ channel: 'QR', provider: 'bitripay' }) });
    const r1 = await create();
    expect(r1.statusCode).toBe(502);
    expect(r1.json()).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 502 });
    expect(r1.json().detail).toMatch(/erreur réseau/);
    expect(JSON.stringify(r1.json())).not.toMatch(/BITRISECRET|\n\s+at /);
    expect(calls).toBe(3); // 1 + 2 nouvelles tentatives, jamais plus
    mode = 'delai';
    const r2 = await create();
    expect(r2.statusCode).toBe(502);
    expect(r2.json().detail).toMatch(/délai de 20 ms dépassé/);
    expect(calls).toBe(6);
    expect(app.ctx.payments.orders.count()).toBe(0);
    expect(app.ctx.audit.list({ action: 'payment.provider_intent.failed' }).total).toBe(2);
    expect(unhandled).toEqual([]);
  });
});

describe('Fournisseur de communication qui lève une exception', () => {
  it('canal en panne : envoi marqué échoué, canal de secours utilisé, opération métier jamais interrompue', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, plugins: [], secrets: SECRETS });
    await app.ready();
    let thrown = 0;
    app.ctx.comms.setProvider('sms', { channel: 'sms', name: 'sms-en-panne', mode: 'sandbox', send: () => { thrown++; throw new Error('délai opérateur dépassé (panne simulée)'); } });
    const obligationId = app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const r = await app.inject({ method: 'POST', url: `/v1/obligations/${obligationId}/payment-orders`, headers: { 'x-demo-user': 'u-contribuable', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: JSON.stringify({ channel: 'MOBILE_MONEY' }) });
    expect(r.statusCode).toBe(201);
    const ds = app.ctx.comms.deliveries.all().filter((d) => d.eventCode === 'payment.reference.issued');
    const failed = ds.filter((d) => d.channel === 'sms' && d.status === 'echoue');
    expect(thrown).toBeGreaterThan(0);
    expect(failed.length).toBeGreaterThan(0);
    // Secours : un autre canal a été essayé pour le message en échec (jamais le même canal deux fois).
    expect(ds.some((d) => d.fallbackOf === failed[0]!.id && d.channel !== 'sms')).toBe(true);
    expect(ds.filter((d) => d.channel === 'sms').length).toBe(failed.length);
  });
});

describe('Fournisseur d’IA en panne ou sortie mal formée', () => {
  it('503 IA_INDISPONIBLE (jamais « erreur interne »), aucune recommandation, audit et alerte ; les données ne changent pas', async () => {
    const { iaPlugin } = await import('../src/plugins/ia/plugin.js');
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, plugins: [iaPlugin], secrets: SECRETS });
    await app.ready();
    const svc = app.ctx.ext.ia as { recommendations: { count(): number } };
    const setProvider = (p: unknown) => { (svc as unknown as { provider: unknown }).provider = p; };
    const before = svc.recommendations.count();
    const run = () => app.inject({ method: 'POST', url: '/v1/ia/agents/DECOUVERTE/run', headers: { 'x-demo-user': 'u-dg-dgipk', 'content-type': 'application/json' }, payload: JSON.stringify({ purpose: 'Test de panne du fournisseur' }) });
    setProvider({ modelVersion: 'panne', run: () => { throw new Error('ECONNRESET (panne simulée)'); } });
    const r1 = await run();
    expect(r1.statusCode).toBe(503);
    expect(r1.json()).toMatchObject({ code: 'IA_INDISPONIBLE' });
    expect(r1.json().detail).toMatch(/fournisseur en erreur/);
    expect(JSON.stringify(r1.json())).not.toMatch(/ECONNRESET|\n\s+at /);
    setProvider({ modelVersion: 'mal-forme', run: () => [{ key: 'k', situation: 42, actions: 'tout exécuter' }] });
    const r2 = await run();
    expect(r2.statusCode).toBe(503);
    expect(r2.json().detail).toMatch(/réponse non conforme rejetée/);
    setProvider({ modelVersion: 'mal-forme-2', run: () => ({ not: 'an array' }) });
    expect((await run()).statusCode).toBe(503);
    expect(svc.recommendations.count()).toBe(before);
    expect(app.ctx.audit.list({ action: 'ia.provider.failed' }).total).toBe(3);
    expect(app.ctx.alerts.list().filter((a) => a.type === 'IA_FOURNISSEUR_EN_ECHEC')).toHaveLength(2);
  });
});
