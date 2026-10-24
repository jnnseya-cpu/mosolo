/**
 * Sauvegarde → vérification par l'OUTIL D'EXPLOITATION (backup-cli.ts verify) → restauration dans une base vierge →
 * redémarrage → contrôle d'intégrité (chaîne d'audit, grand livre, ordre de paiement), sur PostgreSQL simulé (pg-mem).
 * Une sauvegarde altérée est refusée par l'outil (code de sortie 2). Le parcours PostgreSQL réel (déclencheurs d'ajout
 * seul, rôle de restauration) est couvert par la CI (.github/workflows/ci.yml, job persistance-postgresql).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { backupStore, restoreStore } from '../src/persistence/backup.js';
import { PersistenceRuntime } from '../src/persistence/runtime.js';
import { PgSnapshotStore, type PgPoolLike } from '../src/persistence/store.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import { DEMO } from '../src/seed.js';
import { callbackHeaders, PROVIDER_SECRET } from './helpers.js';

const AUDIT_KEY = 'cle-audit-sauvegarde-de-test-0123456789';
const BACKUP_KEY = 'cle-de-sauvegarde-de-test-0123456789';
const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const pool = (): PgPoolLike => {
  const { Pool } = newDb().adapters.createPg();
  // Conversion justifiée : l'adaptateur pg-mem expose le sous-ensemble du pool utilisé (query, connect, end).
  return new Pool() as unknown as PgPoolLike;
};

async function boot(store: PgSnapshotStore, clock: ManualClock) {
  const rt = await PersistenceRuntime.open(store);
  const app = buildApp({
    clock, secrets: { auditHmacKey: AUDIT_KEY, providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [createSoclePlugin({ persistence: rt, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })],
  });
  await app.ready();
  return { app, rt };
}

function cli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(BACKEND, '../node_modules/.bin/tsx'), 'src/persistence/backup-cli.ts', ...args], {
      cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOSOLO_BACKUP_KEY: BACKUP_KEY, MOSOLO_AUDIT_HMAC_KEY: AUDIT_KEY },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe('Sauvegarde, vérification par l’outil d’exploitation, restauration et intégrité', () => {
  it('pg-mem : sauvegarde signée → verify (CLI) CONFORME → restauration → redémarrage identique ; altération refusée', async () => {
    const clock = new ManualClock('2026-09-27T09:00:00.000Z');
    const source = new PgSnapshotStore(pool(), { dialect: 'pg-mem' });
    const a = await boot(source, clock);
    const obligationId = a.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const order = (await a.app.inject({
      method: 'POST', url: `/v1/obligations/${obligationId}/payment-orders`, payload: { channel: 'MOBILE_MONEY' },
      headers: { 'x-demo-user': 'u-contribuable', 'idempotency-key': randomUUID() },
    })).json() as { paymentOrderId: string; paymentReference: string };
    const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: order.paymentReference, amount: { amount: '150.00', currency: 'USD' }, status: 'SUCCESS', completedAt: clock.now().toISOString() });
    const cb = await a.app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw, headers: { 'content-type': 'application/json', ...callbackHeaders(PROVIDER_SECRET, raw, clock.now()) } });
    expect(cb.json().status).toBe('CONFIRME');
    const before = { balance: a.app.ctx.ledger.balance(), audit: a.app.ctx.audit.length, order: a.app.ctx.payments.orders.get(order.paymentOrderId)!.status };
    await a.app.close();
    await a.rt.flush();

    // Sauvegarde signée, puis vérification par l'outil d'exploitation lui-même.
    const dir = mkdtempSync(join(tmpdir(), 'mosolo-sauvegarde-'));
    const file = join(dir, 'sauvegarde.json');
    const doc = await backupStore(source, BACKUP_KEY);
    writeFileSync(file, JSON.stringify(doc, null, 1));
    const ok = cli(['verify', file]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Vérification : CONFORME .* chaîne d'audit intègre/);

    // Sauvegarde altérée (montant d'une écriture) : refusée par l'outil.
    const tampered = JSON.parse(readFileSync(file, 'utf8')) as typeof doc;
    const row = tampered.rows.find((r) => JSON.stringify(r.doc).includes('150.00'))!;
    row.doc = JSON.parse(JSON.stringify(row.doc).replace('150.00', '15.00'));
    const bad = join(dir, 'alteree.json');
    writeFileSync(bad, JSON.stringify(tampered));
    const ko = cli(['verify', bad]);
    expect(ko.code).toBe(2);
    expect(ko.out).toContain('NON CONFORME');

    // Restauration dans une base VIERGE, puis redémarrage : état identique, chaîne d'audit vérifiée.
    const target = new PgSnapshotStore(pool(), { dialect: 'pg-mem' });
    await target.migrate();
    const r = await restoreStore(target, doc, BACKUP_KEY, AUDIT_KEY);
    expect(r.ok).toBe(true);
    const b = await boot(target, clock);
    expect(b.rt.status().report?.audit?.ok).toBe(true);
    const after = b.app.ctx.ledger.balance();
    expect(after.balanced).toBe(true);
    expect(after.headHash).toBe(before.balance.headHash);
    expect(after.entries).toBe(before.balance.entries);
    expect(b.app.ctx.payments.orders.get(order.paymentOrderId)!.status).toBe(before.order);
    expect(b.app.ctx.audit.length).toBeGreaterThanOrEqual(before.audit);
    expect(b.app.ctx.audit.verify().ok).toBe(true);
    console.log(JSON.stringify({ rapport: 'sauvegarde-restauration pg-mem', documents: doc.manifest.rows, depots: Object.keys(doc.manifest.repos).length, cliVerify: ok.out.trim(), cliAlteree: ko.out.trim().split('\n')[0], ecrituresGrandLivre: after.entries, teteGrandLivreIdentique: after.headHash === before.balance.headHash, auditIntegre: true }));
    await b.app.close();
    await b.rt.flush();
  });
});
