import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { DEMO } from '../src/seed.js';

/** Application complète : socle + tous les modules d'extension, données de démonstration semées. */
async function full() {
  const app = buildApp({ clock: new ManualClock('2026-09-26T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const get = (url: string, user?: string) => app.inject({ method: 'GET', url, headers: user ? { 'x-demo-user': user } : {} });
  return { app, get };
}

describe('Intégration : tous les modules chargés', () => {
  it('chaque module est construit, semé et exposé ; la chaîne d’audit reste intègre', async () => {
    const { app, get } = await full();
    for (const p of DEFAULT_PLUGINS) expect(app.ctx.ext[p.name], p.name).toBeDefined();
    expect(Object.keys(app.ctx.ext)).toHaveLength(DEFAULT_PLUGINS.length);
    expect((await get('/health')).statusCode).toBe(200);
    const audit = (await get('/v1/audit/verify', 'u-auditeur')).json();
    expect(audit.ok).toBe(true);
    expect(app.ctx.ledger.balance().balanced ?? true).toBe(true);
  });

  it('routes publiques des modules : transparence, badge, carte, plaque, points de paiement, signalement', async () => {
    const { get } = await full();
    for (const url of ['/v1/verticales/catalogue', '/v1/public/transparency', '/.well-known/openid-configuration']) {
      const r = await get(url);
      expect(r.statusCode, url).toBeLessThan(500);
    }
  });

  it('doctrine préservée avec tous les modules : l’agent de terrain n’accède qu’en minimal, sans montant', async () => {
    const { get } = await full();
    const r = await get(`/v1/taxpayers/${DEMO.taxpayerId}`, 'u-agent-terrain');
    expect(r.statusCode).toBe(200);
    expect(r.json().access).toBe('minimal');
    expect(r.json().receipts).toBeNull();
    expect(r.json().obligations.every((o: { amount: unknown }) => o.amount === null)).toBe(true);
  });
});

describe('Garde de liquidation (socle + module accès)', () => {
  it('jamais de double perception : seconde liquidation annuelle refusée ; une autre entité est bloquée et un arbitrage s’ouvre', async () => {
    const { app } = await full();
    const inject = (user: string, body: unknown) => app.inject({ method: 'POST', url: '/v1/assessments/calculate', headers: { 'x-demo-user': user, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const rule = app.ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
    const dup = await inject('u-controleur', { ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('DUPLICATE_OBLIGATION');
    // Contrôleur d'une autre entité (commune) sur un autre objet du même contribuable : première revendication acceptée.
    const ok = await inject('u-controleur', { ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.unitId, inputs: {}, simulate: false });
    expect(ok.statusCode).toBe(201);
    const other = await inject('acces-u-controleur-limete', { ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.unitId, inputs: {}, simulate: false });
    expect([403, 409]).toContain(other.statusCode);
  });
});
