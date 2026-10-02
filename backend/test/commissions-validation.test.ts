/**
 * Validation humaine à deux personnes des commissions avant versement : demande par l'agent bénéficiaire, décision
 * motivée par un superviseur distinct de l'agent et des personnes qui ont vérifié ou décidé le constat ; journalisée ;
 * garde de rotation de l'intégrité sur la route de décision.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function env(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-29T09:00:00.000Z');
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

/** Pénalité du stationnement (constat de pk-controleur vérifié par pk-superviseur) décidée par pk-autorite, payée ; rapprochée si demandé. */
async function acquiredPenalty(e: TestEnv, reconciled = true): Promise<string> {
  const v = (await e.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
  const obId = (await e.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes.' })).json().obligation.id as string;
  const order = await e.req('POST', `/v1/obligations/${obId}/payment-orders`, 'u-locataire', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  const o = order.json();
  expect((await signedCallback(e, callbackBody(e, o.paymentReference, o.amount))).json().status).toBe('CONFIRME');
  if (reconciled) reconcile(e, obId);
  return obId;
}
function reconcile(e: TestEnv, obligationId: string) {
  for (const o of e.app.ctx.payments.byObligation(obligationId)) if (o.status === 'CONFIRME') e.app.ctx.payments.orders.update({ ...o, status: 'RAPPROCHE' });
}
const mine = async (e: TestEnv) => (await e.req('GET', '/v1/agents/me/earnings', 'pk-controleur')).json();
const DECIDE = (id: string) => `/v1/agents/commission-validations/${id}/decision`;

describe('Validation des commissions avant versement (quatre yeux)', () => {
  it('acquise ≠ payable : demande de l’agent, décision par un superviseur distinct de l’agent, du vérificateur et du décideur', async () => {
    const e = await env();
    const obId = await acquiredPenalty(e, false);
    // Payée mais non rapprochée : rien à faire valider.
    expect((await e.req('POST', '/v1/agents/me/commission-validations', 'pk-controleur', {})).json().code).toBe('NO_ACQUIRED_COMMISSION');
    reconcile(e, obId);
    let s = await mine(e);
    const line = s.lines.find((l: { obligationId: string; state: string }) => l.obligationId === obId && l.state === 'ACQUISE');
    expect(line).toMatchObject({ validation: 'A_DEMANDER', verifierIds: ['pk-superviseur', 'pk-autorite'] });
    expect(s.totals.payable).toEqual([]);
    expect(s.validation.aDemander).toBeGreaterThan(0);

    // Un usager n'est pas un agent ; l'agent dépose sa demande.
    expect((await e.req('POST', '/v1/agents/me/commission-validations', 'u-locataire', {})).statusCode).toBe(403);
    const r = await e.req('POST', '/v1/agents/me/commission-validations', 'pk-controleur', { lineKeys: [line.validationKey] });
    expect(r.statusCode).toBe(201);
    const req = r.json();
    expect(req).toMatchObject({ agentId: 'pk-controleur', status: 'DEMANDEE', total: [{ amount: '2000.00', currency: 'CDF' }] });
    expect(req.excluded).toEqual(expect.arrayContaining(['pk-controleur', 'pk-superviseur', 'pk-autorite']));
    // Déjà demandée : pas de seconde demande.
    expect((await e.req('POST', '/v1/agents/me/commission-validations', 'pk-controleur', { lineKeys: [line.validationKey] })).json().code).toBe('COMMISSION_LINE_NOT_OPEN');
    expect((await mine(e)).lines.find((l: { validationKey: string }) => l.validationKey === line.validationKey).validation).toBe('DEMANDEE');

    // File : le vérificateur du constat voit la demande mais ne peut pas décider.
    const q = (await e.req('GET', '/v1/agents/commission-validations', 'pk-superviseur')).json();
    expect(q.pending).toBe(1);
    expect(q.items[0].blockReason).toMatch(/vérifié ou décidé un constat/);
    expect((await e.req('GET', '/v1/agents/commission-validations', 'pk-controleur')).statusCode).toBe(403);
    // Le vérificateur (R09), le décideur (R06) et l'agent lui-même ne valident pas.
    expect((await e.req('POST', DECIDE(req.id), 'pk-superviseur', { approve: true, motif: 'Constat vérifié par moi-même.' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await e.req('POST', DECIDE(req.id), 'pk-autorite', { approve: true, motif: 'Pénalité décidée par moi-même.' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await e.req('POST', DECIDE(req.id), 'pk-controleur', { approve: true, motif: 'Je valide ma propre commission.' })).statusCode).toBe(403);
    // Motif obligatoire.
    expect((await e.req('POST', DECIDE(req.id), 'pk-regie', { approve: true, motif: 'ok' })).statusCode).toBe(400);

    // Une personne distincte (cheffe de service, R07) valide : payable, journalisé.
    const ok = await e.req('POST', DECIDE(req.id), 'pk-regie', { approve: true, motif: 'Pièces du constat et rapprochement contrôlés.' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'VALIDEE', decision: { by: 'pk-regie', approve: true } });
    s = await mine(e);
    expect(s.lines.find((l: { validationKey: string }) => l.validationKey === line.validationKey).validation).toBe('VALIDEE');
    expect(s.totals.payable).toEqual([{ amount: '2000.00', currency: 'CDF' }]);
    expect(e.app.ctx.audit.list({ action: 'agents.commission.validated' }).items[0]).toMatchObject({ actor: { id: 'pk-regie' }, details: { agentId: 'pk-controleur', payable: true } });
    expect((await e.req('POST', DECIDE(req.id), 'u-superviseur', { approve: true, motif: 'Seconde validation superflue.' })).json().code).toBe('COMMISSION_VALIDATION_ALREADY_DECIDED');
    // Décision à deux personnes reconstituée pour la détection de collusion.
    const { decisions } = reconstruct(e.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.find((d) => d.circuit === 'COMMISSION_VALIDATION')).toMatchObject({ proposerId: 'pk-controleur', approverId: 'pk-regie', outcome: 'APPROUVE' });
    // Récapitulatif : montant payable par agent.
    const all = (await e.req('GET', '/v1/agents/earnings', 'pk-regie')).json();
    expect(all.items.find((a: { agentId: string }) => a.agentId === 'pk-controleur').totals.payable).toEqual([{ amount: '2000.00', currency: 'CDF' }]);
  });

  it('refus motivé : la ligne redevient à demander ; une ligne qui n’est plus acquise n’est jamais validée', async () => {
    const e = await env();
    const obId = await acquiredPenalty(e);
    const r1 = (await e.req('POST', '/v1/agents/me/commission-validations', 'pk-controleur', {})).json();
    const refused = await e.req('POST', DECIDE(r1.id), 'pk-regie', { approve: false, motif: 'Rapprochement à confirmer au relevé.' });
    expect(refused.json().status).toBe('REFUSEE');
    expect(e.app.ctx.audit.list({ action: 'agents.commission.validation_refused' }).total).toBe(1);
    expect((await mine(e)).lines.find((l: { obligationId: string; state: string }) => l.obligationId === obId && l.state === 'ACQUISE').validation).toBe('REFUSEE');
    const r2 = (await e.req('POST', '/v1/agents/me/commission-validations', 'pk-controleur', {})).json();
    expect(r2.status).toBe('DEMANDEE');
    // Le rapprochement est défait (ordre revenu à CONFIRME) : la commission n'est plus acquise.
    for (const o of e.app.ctx.payments.byObligation(obId)) if (o.status === 'RAPPROCHE') e.app.ctx.payments.orders.update({ ...o, status: 'CONFIRME' });
    expect((await e.req('POST', DECIDE(r2.id), 'pk-regie', { approve: true, motif: 'Validation sur une ligne modifiée.' })).json().code).toBe('COMMISSION_LINE_CHANGED');
  });

  it('garde de rotation : la paire agent → superviseur au plafond est bloquée (rotation activée), une autre personne décide', async () => {
    const e = await env();
    const propose = async (parameterId: string, proposedValue: number | boolean) => {
      const r = await e.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { parameterId, kind: 'MODIFICATION', proposedValue, motif: 'Activation décidée en comité de contrôle interne (test).' });
      await e.req('POST', `/v1/integrite/thresholds/change-requests/${r.json().id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Approuvé par la direction générale (test).' });
    };
    await propose('rotation.blocage_actif', true);
    await propose('rotation.max_par_paire', 1);
    e.app.ctx.audit.append({ actor: { kind: 'user', id: 'pk-controleur', roles: ['R11'] }, action: 'agents.commission.validation_requested', resourceType: 'commission_validation', resourceId: 'COMV-ANCIEN', details: {} });
    e.app.ctx.audit.append({ actor: { kind: 'user', id: 'pk-regie', roles: ['R07'] }, action: 'agents.commission.validated', resourceType: 'commission_validation', resourceId: 'COMV-ANCIEN', details: { proposedBy: 'pk-controleur' } });
    await acquiredPenalty(e);
    const r = (await e.req('POST', '/v1/agents/me/commission-validations', 'pk-controleur', {})).json();
    const blocked = await e.req('POST', DECIDE(r.id), 'pk-regie', { approve: true, motif: 'Pièces du constat et rapprochement contrôlés.' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('ROTATION_REQUIRED');
    expect((await e.req('POST', DECIDE(r.id), 'u-superviseur', { approve: true, motif: 'Pièces du constat et rapprochement contrôlés.' })).json().status).toBe('VALIDEE');
  });
});
