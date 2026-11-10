import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { kinshasaMonth, paymentState } from '../src/plugins/parking/support.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { PUB_DEMO } from '../src/plugins/publicite/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function env(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}

async function pay(e: TestEnv, user: string, obligationId: string) {
  const order = await e.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  expect(order.statusCode, order.body).toBe(201);
  const o = order.json();
  const cb = await signedCallback(e, callbackBody(e, o.paymentReference, o.amount));
  expect(cb.json().status).toBe('CONFIRME');
  return o as { id: string; paymentReference: string };
}

type Line = { module: string; source: string; state: string; agentId: string; obligationId: string; base: { amount: string }; commission: { amount: string }; paidAt: string | null };
type Sanctions = {
  unpaid(s: { taxpayerId?: string | null; plate?: string | null }): { module: string; obligationId?: string; remaining?: { amount: string } }[];
  commissions: { lines(a?: string): Line[] };
};

describe('Commission et registre des pénalités — règles du terrain', () => {
  it('publicité : les droits liquidés par la décision ne sont pas une pénalité ; payés dans les 72 h, ils sont un paiement généré par l’inspection', async () => {
    const e = await env();
    const s = e.app.ctx.ext.sanctions as Sanctions;
    const c = (await e.req('GET', '/v1/publicite/cases?status=CONSTATE', 'pb-superviseur')).json().items.find((x: { finding: string }) => x.finding === 'NON_DECLARE');
    await e.req('POST', `/v1/publicite/cases/${c.id}/verify`, 'pb-superviseur', { confirm: true, note: 'Photographies probantes.' });
    const d = (await e.req('POST', `/v1/publicite/cases/${c.id}/decide`, 'pb-autorite', {
      outcome: 'RETENU', reason: 'Support non déclaré établi.', ownerTaxpayerId: PUB_DEMO.advertiserTaxpayerId, liquidateDues: true,
    })).json();
    const obId = d.decision.obligationId as string;
    expect(e.app.ctx.assessment.get(obId).revenueCategory).not.toBe('PENALITE');
    // Jamais au registre des pénalités impayées.
    expect(s.unpaid({ taxpayerId: PUB_DEMO.advertiserTaxpayerId }).some((l) => l.obligationId === obId)).toBe(false);
    expect(s.commissions.lines().some((l) => l.obligationId === obId)).toBe(false);
    await pay(e, 'pb-annonceur', obId);
    const lines = s.commissions.lines().filter((l) => l.obligationId === obId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ module: 'PUBLICITE', source: 'PAIEMENT', state: 'CONFIRMEE', agentId: c.inspection.inspectorId });
  });

  it('paiement par échéances : jamais « payé » tant qu’un solde reste dû ; commission sur la seule part payée', async () => {
    const e = await env();
    const s = e.app.ctx.ext.sanctions as Sanctions;
    const v = (await e.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    const obId = (await e.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes.' })).json().obligation.id as string;
    const o = await pay(e, 'u-locataire', obId);
    // Échéance : la moitié seulement du montant (20 000 CDF) a été payée.
    const order = e.app.ctx.payments.byReference(o.paymentReference)!;
    e.app.ctx.payments.orders.update({ ...order, amount: { amount: '10000.00', currency: 'CDF' } });
    const st = paymentState(e.app.ctx, obId);
    expect(st).toMatchObject({ state: 'PARTIEL', amount: { amount: '10000.00', currency: 'CDF' }, remaining: { amount: '10000.00', currency: 'CDF' } });
    // Toujours au registre (avec le solde) et toujours « impayée » au contrôle.
    expect(s.unpaid({ plate: PARKING_DEMO.plateTenant }).find((l) => l.obligationId === obId)?.remaining).toEqual({ amount: '10000.00', currency: 'CDF' });
    const ctl = (await e.req('GET', `/v1/parking/control/${PARKING_DEMO.plateTenant}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect(ctl.penalties.find((p: { obligationId: string }) => p.obligationId === obId)).toMatchObject({ unpaid: true, payment: 'PARTIEL' });
    // Pénalités du stationnement dans `penalties` ; `penalitesImpayees` réservé aux autres modules.
    expect(ctl.penalitesImpayees).toBeUndefined();
    // Commission : 10 % de la part payée (confirmée), le solde en attente.
    const lines = s.commissions.lines('pk-controleur').filter((l) => l.obligationId === obId);
    expect(lines.map((l) => [l.state, l.base.amount, l.commission.amount]).sort()).toEqual([['CONFIRMEE', '10000.00', '1000.00'], ['EN_ATTENTE', '10000.00', '1000.00']]);
    const summary = (await e.req('GET', '/v1/agents/me/earnings', 'pk-controleur')).json();
    expect(summary.lines.filter((l: Line) => l.state === 'CONFIRMEE' && l.obligationId === obId).map((l: Line) => l.commission.amount)).toEqual(['1000.00']);
    // Ce mois : les commissions payées (confirmées ou acquises) ce mois-ci, jamais le solde en attente.
    expect(summary.totals.ceMois).toEqual(summary.totals.confirmee);
  });

  it('« ce mois » : mois civil de Kinshasa (UTC+1)', () => {
    expect(kinshasaMonth('2026-09-30T22:59:00.000Z')).toBe('2026-09');
    expect(kinshasaMonth('2026-09-30T23:30:00.000Z')).toBe('2026-10');
  });

  it('constat non décidé : aucun montant proposé montré aux agents', async () => {
    const e = await env();
    const ctl = (await e.req('GET', `/v1/parking/control/${PARKING_DEMO.plateUnknown}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    const p = ctl.penalties.find((x: { status: string }) => x.status === 'CONSTATE');
    expect(p).toBeDefined();
    expect(p.amount).toBeNull();
  });

  it('contrôle hors ligne à heure déclarée : enregistré après le paiement, il ne se l’attribue pas', async () => {
    const e = await env();
    const s = e.app.ctx.ext.sanctions as Sanctions;
    const ti = e.app.ctx.ext.titres as {
      credentials: { all(): { id: string; obligationId?: string; issuedAt: string; subject: { plate?: string } }[] };
      controls: { append(ev: unknown): unknown };
    };
    const attributed = new Set(s.commissions.lines().map((l) => l.obligationId));
    const c = ti.credentials.all().find((x) => x.obligationId && x.subject.plate && !attributed.has(x.obligationId)
      && e.app.ctx.payments.byObligation(x.obligationId).some((o) => o.status === 'CONFIRME' && o.confirmedAt))!;
    expect(c).toBeDefined();
    const paidAt = Date.parse(e.app.ctx.payments.byObligation(c.obligationId!).find((o) => o.confirmedAt)!.confirmedAt!);
    const at = new Date(Math.min(paidAt, Date.parse(c.issuedAt)) - 60_000).toISOString();
    const ev = (id: string, recordedAt: string) => ({
      id, method: 'PLAQUE', presented: c.subject.plate!.toUpperCase().replace(/[^0-9A-Z]/g, ''), controllerId: `test-${id}`, place: { label: 'Test' },
      at, offline: true, result: 'INVALIDE', displayStatus: 'INCONNU', consumedUse: false, recordedAt,
    });
    // Reçu au serveur une heure APRÈS le paiement : rien.
    ti.controls.append(ev('CTL-LATE', new Date(paidAt + 3_600_000).toISOString()));
    expect(s.commissions.lines('test-CTL-LATE')).toHaveLength(0);
  });

  it('surveillance : un superviseur territorial ne voit que son périmètre', async () => {
    const e = await env();
    const pk = e.app.ctx.ext.parking as { checks: { append(c: unknown): unknown } };
    const now = e.clock.now().toISOString();
    pk.checks.append({ id: 'T-CHK-KAL', plate: 'KN-3333-TS', zoneId: null, commune: 'Kalamu', light: 'VERT', title: null, agentId: 'pk-kalamu', at: now });
    const rows = (who: string) => e.req('GET', '/v1/agents/monitoring', who).then((r) => r.json().rows as { agentId: string }[]);
    expect((await rows('pk-superviseur')).some((r) => r.agentId === 'pk-kalamu')).toBe(false);
    expect((await rows('pk-regie')).some((r) => r.agentId === 'pk-kalamu')).toBe(true);
  });
});
