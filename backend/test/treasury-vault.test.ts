import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertBalanced } from '../src/modules/treasury/ledger.js';
import { createOrder, DEMO, payDemoObligation, setup } from './helpers.js';

describe('Grand livre et rapprochement', () => {
  it('AC-LED-01 : aucune suppression ; correction par contre-écriture liée ; livre équilibré', async () => {
    const env = await setup();
    await payDemoObligation(env);
    const entries = (await env.req('GET', '/v1/ledger/entries', 'u-tresor')).json();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const target = entries.at(-1);
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const res = await env.req(method, `/v1/ledger/entries/${target.id}`, 'u-tresor', method === 'DELETE' ? undefined : {});
      expect(res.statusCode).toBe(405);
      expect(res.json().code).toBe('LEDGER_APPEND_ONLY');
    }
    expect((await env.req('GET', '/v1/ledger/entries', 'u-tresor')).json()).toHaveLength(entries.length);
    expect(env.app.ctx.audit.list({ action: 'ledger.tamper.attempt' }).total).toBe(3);

    // Une seule personne ne contrepasse jamais : sans le circuit de double validation du Trésor, la route refuse.
    const alone = await env.req('POST', `/v1/ledger/entries/${target.id}/reversals`, 'u-tresor', { reason: 'Contrepassement prestataire (test)' });
    expect(alone.statusCode).toBe(422);
    expect(alone.json().code).toBe('FOUR_EYES_REQUIRED');
    expect(env.app.ctx.ledger.isReversed(target.id)).toBe(false);
    // Contre-écriture liée à l'original (passée par le circuit à quatre yeux, voir tresor.test.ts).
    const rev = env.app.ctx.ledger.reverse(target.id, 'Contrepassement prestataire (test)', { kind: 'user', id: 'u-tresor' });
    expect(rev).toMatchObject({ reversalOf: target.id, eventType: 'REVERSAL' });
    expect(rev.lines[0]!.side).toBe(target.lines[0].side === 'DEBIT' ? 'CREDIT' : 'DEBIT');
    expect(() => env.app.ctx.ledger.reverse(target.id, 'Deuxième tentative', { kind: 'user', id: 'u-tresor' })).toThrow(/déjà contrepassée/);
    const balance = (await env.req('GET', '/v1/ledger/balance', 'u-auditeur')).json();
    expect(balance.balanced).toBe(true);
    expect(balance.byCurrency.find((c: { currency: string }) => c.currency === 'USD').debit).toEqual(
      balance.byCurrency.find((c: { currency: string }) => c.currency === 'USD').credit,
    );
    // L'original est toujours présent (non supprimé).
    expect(env.app.ctx.ledger.get(target.id)).toBeDefined();
    // Une écriture déséquilibrée est refusée par construction.
    expect(() => assertBalanced([
      { account: 'COMPTE_PUBLIC_RECETTES', side: 'DEBIT', amount: { amount: '10.00', currency: 'USD' } },
      { account: 'RECETTES_CONSTATEES', side: 'CREDIT', amount: { amount: '9.99', currency: 'USD' } },
    ])).toThrow(/déséquilibrée/);
  });

  it('les lignes non appariées deviennent des exceptions (crédit orphelin, mauvais compte, montant)', async () => {
    const env = await setup();
    const { order } = await payDemoObligation(env);
    const res = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-EXC',
      lines: [
        { accountAlias: DEMO.dgipkAlias, amount: { amount: '99.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-ORPH-ELIN' },
        { accountAlias: DEMO.dgtkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: order.paymentReference },
        { accountAlias: DEMO.dgipkAlias, amount: { amount: '149.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: order.paymentReference },
      ],
    });
    expect(res.json().matched).toHaveLength(0);
    expect(res.json().exceptions.map((e: { type: string }) => e.type)).toEqual(['ORPHAN_CREDIT', 'WRONG_ACCOUNT', 'AMOUNT_MISMATCH']);
    expect(env.app.ctx.receipts.byPaymentOrder(order.paymentOrderId)!.status).toBe('PROVISOIRE');
    // Confirmation sans crédit à J+1 → « règlement manquant ».
    env.clock.advanceHours(25);
    const exc = (await env.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json();
    expect(exc.some((e: { type: string }) => e.type === 'MISSING_SETTLEMENT')).toBe(true);
    expect((await env.req('GET', '/v1/reconciliation/exceptions', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Coffre des comptes bénéficiaires', () => {
  const proposal = { alias: DEMO.dgipkAlias, bankName: 'Banque de recettes C (démo)', accountNumber: 'CD00 1111 2222 3333 4444 5555', holderName: 'DGIPK — nouveau compte (démo)', reason: 'Migration bancaire (test)' };

  it('AC-BEN-01 : deux approbateurs distincts, vérification hors bande, effet après 72 h', async () => {
    const env = await setup();
    const req = await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal);
    expect(req.statusCode).toBe(201);
    expect(req.json().proposed.accountNumber).toBe('•••• 5555');
    const id = req.json().id;
    const noOob = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: false });
    expect(noOob.json().code).toBe('OUT_OF_BAND_VERIFICATION_REQUIRED');
    const byTreasury = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-tresor', { outOfBandVerified: true });
    expect(byTreasury.statusCode).toBe(403);
    const a1 = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    expect(a1.json().status).toBe('EN_ATTENTE_APPROBATION');
    const again = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    expect(again.json().code).toBe('SEPARATION_OF_DUTIES');
    const a2 = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-2', { outOfBandVerified: true });
    expect(a2.json().status).toBe('EN_REFROIDISSEMENT');
    expect(a2.json().coolingEndsAt).toBe('2026-09-29T09:00:00.000Z');

    const accountBefore = env.app.ctx.vault.current(DEMO.dgipkAlias)!;
    env.clock.advanceHours(71);
    expect(env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber).toBe(accountBefore.accountNumber);
    expect(env.app.ctx.vault.getRequest(id).status).toBe('EN_REFROIDISSEMENT');
    env.clock.advanceHours(1);
    expect(env.app.ctx.vault.getRequest(id).status).toBe('EFFECTIF');
    expect(env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber).toBe(proposal.accountNumber);
    // L'alias ne change pas pour les canaux.
    const env2Order = (await createOrder(env, randomUUID())).json();
    expect(env2Order.beneficiaryAlias).toBe(DEMO.dgipkAlias);
    // Notifications multiples (Gouverneur, ministre des Finances, audit, coffre).
    const notified = new Set(env.app.ctx.comms.deliveries.find((d) => d.eventCode.startsWith('beneficiary.change')).map((d) => d.recipientId));
    for (const u of ['u-gouverneur', 'u-ministre-finances', 'u-auditeur', 'u-coffre-3']) expect(notified.has(u)).toBe(true);
    for (const e of ['beneficiary.change.proposed', 'beneficiary.change.cooling_off', 'beneficiary.change.effective']) {
      expect(env.app.ctx.audit.list({ action: e.replace('cooling_off', 'approved') }).total).toBeGreaterThan(0);
    }
  });

  it('personne d’autre ne peut proposer ni approuver', async () => {
    const env = await setup();
    for (const u of ['u-gouverneur', 'u-superadmin', 'u-coffre-1', 'u-ministre-finances', 'u-dg-dgipk']) {
      expect((await env.req('POST', '/v1/beneficiary-accounts/change-requests', u, proposal)).statusCode).toBe(403);
    }
    const id = (await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal)).json().id;
    for (const u of ['u-gouverneur', 'u-superadmin', 'u-auditeur']) {
      expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, u, { outOfBandVerified: true })).statusCode).toBe(403);
    }
  });
});
