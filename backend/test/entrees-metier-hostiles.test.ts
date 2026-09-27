/**
 * Deuxième passe adverse (27/09/2026), phase « faux succès » : entrées métier hostiles sur les chemins d'argent et de
 * décision — montants négatifs, nuls, surdimensionnés ou flottants, types erronés, chaînes vides, dates impossibles
 * (30 février, mois 13), frontière de minuit à Kinshasa (UTC+1), affectation de masse sur des routes à corps.
 * Attendus : refus 4xx RFC 9457, aucun effet (aucune écriture, aucun ordre, aucune quittance), jamais de 2xx trompeur.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { isoDateString } from '../src/core/http.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function full(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }),
  };
}

const problem = (r: { statusCode: number; headers: Record<string, unknown>; body: string }) => {
  expect(r.statusCode).toBeGreaterThanOrEqual(400);
  expect(r.statusCode).toBeLessThan(500);
  expect(String(r.headers['content-type'])).toMatch(/application\/problem\+json/);
  expect(r.body).not.toMatch(/\n\s+at |\/home\/|\.ts:\d+/);
};

describe('Dates impossibles', () => {
  it('le schéma partagé AAAA-MM-JJ refuse les dates hors calendrier (30 février, mois 13, jour 00)', () => {
    for (const d of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29', '0000-01-01']) expect(isoDateString.safeParse(d).success, d).toBe(false);
    for (const d of ['2026-02-28', '2028-02-29', '2026-12-31', '2026-09-27']) expect(isoDateString.safeParse(d).success, d).toBe(true);
  });

  it('routes : clôture du jour, dérogation, délégation, export → 400 sur date impossible, jamais 500 ni date décalée', async () => {
    const e = await full();
    for (const date of ['2026-02-30', '2026-13-01']) {
      problem(await e.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date }));
      problem(await e.req('POST', '/v1/tresor/closures/daily/waivers', 'u-tresor', { date, motif: 'Motif suffisamment long (test).' }));
      problem(await e.req('POST', '/v1/postes/delegations', 'u-ministre-finances', { categorie: 'EXONERATION_DEGREVEMENT', delegataireId: 'u-dg-dgipk', fin: date, motif: 'Motif détaillé de la décision (test)', perimetre: 'Finances (test)' }));
      problem(await e.req('GET', `/v1/tresor/exports?from=${date}`, 'u-tresor'));
    }
    // Aucune délégation créée avec une échéance « 30 février » décalée au 2 mars.
    expect(e.app.ctx.audit.list({ action: 'postes.delegation.creee' }).total).toBe(0);
  });
});

describe('Montants hostiles', () => {
  it('rappel prestataire : négatif, nul, flottant, surdimensionné, trop de décimales, devise inconnue → refus sans effet', async () => {
    const e = await full();
    const ob = e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await e.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    const ledger = e.app.ctx.ledger.list({}).length;
    const receipts = e.app.ctx.receipts.receipts.count();
    for (const amount of [
      { amount: '-150.00', currency: 'USD' }, { amount: '0.00', currency: 'USD' }, { amount: 150, currency: 'USD' }, { amount: '1e3', currency: 'USD' },
      { amount: '99999999999999999999999.99', currency: 'USD' }, { amount: '150.001', currency: 'USD' }, { amount: '150.00', currency: 'XXX' },
      { amount: '', currency: 'USD' }, { amount: null, currency: 'USD' }, { amount: '150.00' }, '150.00',
    ]) {
      const r = await signedCallback(e, { ...callbackBody(e, order.paymentReference), amount } as never);
      problem(r);
    }
    expect(e.app.ctx.ledger.list({}).length).toBe(ledger);
    expect(e.app.ctx.receipts.receipts.count()).toBe(receipts);
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
  });

  it('ordre de paiement : le client ne fixe ni montant, ni bénéficiaire, ni statut (affectation de masse refusée)', async () => {
    const e = await full();
    const ob = e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    for (const extra of [{ amount: { amount: '0.01', currency: 'USD' } }, { beneficiaryAlias: 'COMPTE-PIRATE' }, { status: 'CONFIRME' }, { createdBy: 'u-gouverneur' }, { taxpayerId: 'TP-AUTRE' }]) {
      const r = await e.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY', ...extra }, { 'idempotency-key': randomUUID() });
      problem(r);
      expect(r.json().code).toBe('VALIDATION_ERROR');
    }
    for (const channel of ['', null, 42, 'ESPECES', 'CASH']) {
      problem(await e.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel }, { 'idempotency-key': randomUUID() }));
    }
    expect(e.app.ctx.payments.orders.find((o) => o.obligationId === ob.id)).toHaveLength(0);
    // Clé d'idempotence absente, trop courte ou démesurée : refus explicite.
    for (const key of [undefined, 'court', 'x'.repeat(201)]) {
      problem(await e.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, key ? { 'idempotency-key': key } : {}));
    }
  });

  it('relevé bancaire (module 29) : montant négatif, nul, date de valeur impossible → refus avant toute proposition', async () => {
    const e = await full();
    for (const line of [
      { accountAlias: DEMO.dgipkAlias, amount: { amount: '-10.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-X' },
      { accountAlias: DEMO.dgipkAlias, amount: { amount: '10.00', currency: 'USD' }, valueDate: '2026-02-30', paymentReference: 'PR-X' },
      { accountAlias: '', amount: { amount: '10.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-X' },
    ]) {
      problem(await e.req('POST', '/v1/settlements/statements', 'u-tresor', { statementId: `REL-${randomUUID().slice(0, 6)}`, lines: [line] }));
    }
    problem(await e.req('POST', '/v1/settlements/statements', 'u-tresor', { statementId: 'REL-VIDE', lines: [] }));
  });
});

describe('Frontière de minuit à Kinshasa (UTC+1)', () => {
  it('23 h 30 UTC le 30/09 = 00 h 30 le 01/10 à Kinshasa : la clôture du « jour » suit l’heure de Kinshasa', async () => {
    const e = await full();
    e.clock.set('2026-09-30T23:30:00.000Z');
    // Le 01/10 n'est pas encore achevé à Kinshasa : sa clôture est refusée ; le 30/09 est achevé.
    const tomorrow = await e.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-10-01' });
    problem(tomorrow);
    const closeToday = await e.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-30' });
    expect(closeToday.statusCode, closeToday.body).toBeLessThan(500);
  });
});
