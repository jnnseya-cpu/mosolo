import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { verifySealedPdf } from '../src/modules/receipts/pdf.js';
import { canauxPlugin } from '../src/plugins/canaux/plugin.js';
import type { CanauxService } from '../src/plugins/canaux/service.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { APPARIEMENT_SEUIL_PROPOSITION, editDistance } from '../src/plugins/tresor/appariement.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv, postStatement } from './helpers.js';

async function setup(withCanaux = false) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: withCanaux ? [tresorPlugin, canauxPlugin] : [tresorPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}

/** Paiement d'une obligation du contribuable par le circuit commun (ordre → rappel signé) : ordre CONFIRMÉ. */
async function pay(env: TestEnv, second = false) {
  const user = 'u-contribuable';
  const first = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
  // Seconde obligation de test (copie de l'obligation de démonstration) : deux paiements confirmés distincts.
  const ob = second ? (env.app.ctx.assessment.obligations.get(`${first.id}-B`) ?? env.app.ctx.assessment.obligations.insert({ ...first, id: `${first.id}-B`, status: 'EMISE' })) : first;
  const order = (await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  if (!order.paymentReference) throw new Error(JSON.stringify(order));
  const cb = (await signedCallback(env, callbackBody(env, order.paymentReference, order.amount))).json();
  return { order, receiptNumber: cb.receiptNumber as string };
}

const statement = (env: TestEnv, lines: unknown[]) => postStatement(env, 'u-tresor', { statementId: `REL-${randomUUID().slice(0, 8)}`, lines });

describe('Rapprochement proposé sous le seuil d’appariement exact (§ 20.1)', () => {
  it('distance d’édition : une transposition compte pour une erreur', () => {
    expect(editDistance('PRABCD1234', 'PRABDC1234')).toBe(1);
    expect(editDistance('PRABCD1234', 'PRABCD123')).toBe(1);
    expect(editDistance('PRABCD1234', 'PRZZZZ1234')).toBe(4);
  });

  it('le chemin exact reste automatique ; une référence mal saisie est PROPOSÉE puis confirmée par une autre personne', async () => {
    const env = await setup();
    const a = await pay(env);
    // Chemin exact : inchangé (automatique).
    const exact = (await statement(env, [{ accountAlias: DEMO.dgipkAlias, amount: a.order.amount, valueDate: '2026-09-26', paymentReference: a.order.paymentReference }])).json();
    expect(exact.matched).toHaveLength(1);

    const b = await pay(env, true);
    const ref: string = b.order.paymentReference;
    const typo = `${ref.slice(0, -2)}${ref.at(-1)}${ref.at(-2)}`; // deux derniers caractères inversés
    const imp = (await statement(env, [{ accountAlias: b.order.beneficiaryAlias ?? DEMO.dgipkAlias, amount: b.order.amount, valueDate: '2026-09-26', paymentReference: typo }])).json();
    expect(imp.matched).toHaveLength(0);
    expect(imp.exceptions[0].type).toBe('ORPHAN_CREDIT');
    const exId = imp.exceptions[0].id as string;

    const board = (await env.req('GET', '/v1/tresor/appariements', 'u-analyste-rappro')).json();
    expect(board.policy).toMatchObject({ automaticOnlyForExactMatch: true, threshold: APPARIEMENT_SEUIL_PROPOSITION });
    const item = board.items.find((i: { exceptionId: string }) => i.exceptionId === exId);
    expect(item.candidates[0]).toMatchObject({ paymentReference: ref, proposable: true });
    expect(item.candidates[0].score).toBeGreaterThanOrEqual(APPARIEMENT_SEUIL_PROPOSITION);

    // Le contribuable ne propose rien ; l'analyste propose ; l'auteur ne confirme pas lui-même.
    expect((await env.req('POST', '/v1/tresor/appariements/propositions', 'u-contribuable', { exceptionId: exId, paymentReference: ref, motif: 'Tentative non habilitée (test).' })).statusCode).toBe(403);
    const p = await env.req('POST', '/v1/tresor/appariements/propositions', 'u-tresor', { exceptionId: exId, paymentReference: ref, motif: 'Inversion de deux caractères constatée sur le bordereau (test).' });
    expect(p.statusCode).toBe(201);
    const self = await env.req('POST', `/v1/tresor/appariements/propositions/${p.json().id}/decision`, 'u-tresor', { approve: true, motif: 'Auto-validation interdite (test).' });
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const ok = await env.req('POST', `/v1/tresor/appariements/propositions/${p.json().id}/decision`, 'tresor-chef-comptable', { approve: true, motif: 'Bordereau et relevé concordent (test).' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'CONFIRMEE', result: { receiptNumber: b.receiptNumber } });
    expect(env.app.ctx.payments.byReference(ref)!.status).toBe('RAPPROCHE');
    expect(env.app.ctx.receipts.find(b.receiptNumber)!.status).toBe('DEFINITIVE');
    const ex = env.app.ctx.treasury.exceptions.get(exId)!;
    expect(ex.status).toBe('RESOLUE');
    expect(env.app.ctx.audit.list({ action: 'reconciliation.match.confirmed' }).total).toBe(1);
    // Circuit à deux personnes déclaré.
    expect(CIRCUITS.find((c) => c.code === 'TRESOR_APPARIEMENT')).toBeTruthy();
  });

  it('sous le seuil : rien n’est proposé ; même devise, montant différent : jamais apparié', async () => {
    const env = await setup();
    const b = await pay(env);
    const other = (await statement(env, [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '149.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: b.order.paymentReference }])).json();
    expect(other.exceptions[0].type).toBe('AMOUNT_MISMATCH');
    const r = await env.req('POST', '/v1/tresor/appariements/propositions', 'u-tresor', { exceptionId: other.exceptions[0].id, paymentReference: b.order.paymentReference, motif: 'Écart de montant réel (test).' });
    expect(r.json().code).toBe('MATCH_BELOW_THRESHOLD');
  });

  it('tolérance de change : crédit en CDF d’un ordre en USD proposé avec l’écart de change enregistré', async () => {
    const env = await setup();
    const b = await pay(env);
    const usd = Number(b.order.amount.amount);
    const cdf = (usd * 2850).toFixed(2); // taux de démonstration
    const imp = (await statement(env, [{ accountAlias: DEMO.dgipkAlias, amount: { amount: cdf, currency: 'CDF' }, valueDate: '2026-09-26', paymentReference: b.order.paymentReference }])).json();
    const exId = imp.exceptions[0].id;
    const board = (await env.req('GET', '/v1/tresor/appariements', 'u-tresor')).json();
    const c = board.items.find((i: { exceptionId: string }) => i.exceptionId === exId).candidates[0];
    expect(c.fx).toMatchObject({ rate: '0.000350877193', gap: { amount: '0.00', currency: 'USD' } });
    expect(c.proposable).toBe(true);
    const p = (await env.req('POST', '/v1/tresor/appariements/propositions', 'u-analyste-rappro', { exceptionId: exId, paymentReference: b.order.paymentReference, motif: 'Crédit converti par la banque (test).' })).json();
    const d = (await env.req('POST', `/v1/tresor/appariements/propositions/${p.id}/decision`, 'u-tresor', { approve: true, motif: 'Écart de change dans la tolérance (test).' })).json();
    expect(d.result.ecartChange).toEqual({ amount: '0.00', currency: 'USD' });
  });
});

describe('Crédit groupé d’un prestataire découpé par le fichier de détail (§ 20.1)', () => {
  it('total et détails exacts : appariement automatique de chaque paiement ; total faux : exception CREDIT_GROUPE_ECART', async () => {
    const env = await setup();
    const a = await pay(env);
    const b = await pay(env, true);
    const sum = (Number(a.order.amount.amount) + Number(b.order.amount.amount)).toFixed(2);
    const bad = (await statement(env, [{
      accountAlias: DEMO.dgipkAlias, amount: { amount: '1.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'LOT-PRESTATAIRE-1',
      details: [{ paymentReference: a.order.paymentReference, amount: a.order.amount }], detailFileSha256: sha256Hex('fichier-1'),
    }])).json();
    expect(bad.exceptions[0]).toMatchObject({ type: 'CREDIT_GROUPE_ECART' });
    const good = await statement(env, [{
      accountAlias: DEMO.dgipkAlias, amount: { amount: sum, currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'LOT-PRESTATAIRE-2',
      details: [{ paymentReference: a.order.paymentReference, amount: a.order.amount }, { paymentReference: b.order.paymentReference, amount: b.order.amount }], detailFileSha256: sha256Hex('fichier-2'),
    }]);
    expect(good.statusCode).toBe(201);
    expect(good.json().claimed[0]).toMatchObject({ kind: 'CREDIT_GROUPE', groupedReference: 'LOT-PRESTATAIRE-2' });
    expect(env.app.ctx.payments.byReference(a.order.paymentReference)!.status).toBe('RAPPROCHE');
    expect(env.app.ctx.payments.byReference(b.order.paymentReference)!.status).toBe('RAPPROCHE');
  });

  it('fichier de détail reçu après le relevé : rattaché au crédit orphelin, apparié et exception résolue', async () => {
    const env = await setup();
    const a = await pay(env);
    const imp = (await statement(env, [{ accountAlias: DEMO.dgipkAlias, amount: a.order.amount, valueDate: '2026-09-26', paymentReference: 'LOT-PRESTATAIRE-9' }])).json();
    const exId = imp.exceptions[0].id;
    const wrong = await env.req('POST', `/v1/tresor/exceptions/${exId}/detail-prestataire`, 'u-analyste-rappro', { details: [{ paymentReference: a.order.paymentReference, amount: { amount: '1.00', currency: 'USD' } }], detailFileSha256: sha256Hex('d0') });
    expect(wrong.json().code).toBe('GROUPED_CREDIT_MISMATCH');
    const ok = await env.req('POST', `/v1/tresor/exceptions/${exId}/detail-prestataire`, 'u-analyste-rappro', { details: [{ paymentReference: a.order.paymentReference, amount: a.order.amount }], detailFileSha256: sha256Hex('d1') });
    expect(ok.statusCode).toBe(200);
    expect(env.app.ctx.treasury.exceptions.get(exId)!.status).toBe('RESOLUE');
    expect(env.app.ctx.payments.byReference(a.order.paymentReference)!.status).toBe('RAPPROCHE');
  });
});

describe('Quittance PDF signée (§ 18A.4, § 19)', () => {
  it('PDF téléchargeable par le contribuable, cachet vérifiable, altération détectée ; envoyé par courriel à la quittance définitive', async () => {
    const env = await setup();
    const a = await pay(env);
    expect((await env.req('GET', `/v1/tresor/receipts/${a.receiptNumber}/pdf`, 'u-locataire')).statusCode).toBe(403);
    const res = await env.req('GET', `/v1/tresor/receipts/${a.receiptNumber}/pdf`, 'u-contribuable');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const bytes = res.rawPayload;
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    const text = bytes.toString('latin1');
    for (const m of ['Référence du contribuable', 'Référence de paiement', 'Nature de la recette', 'Administration bénéficiaire', 'Identifiant de transaction', 'Signature électronique', a.receiptNumber]) {
      expect(text).toContain(Buffer.from(m, 'latin1').toString('latin1').replace(/’/g, '\x92'));
    }
    expect(verifySealedPdf(bytes, env.app.ctx.receipts)).toMatchObject({ valid: true, keyId: env.app.ctx.receipts.keyId });
    const tampered = Buffer.from(bytes);
    tampered[200] = tampered[200]! ^ 1;
    expect(verifySealedPdf(tampered, env.app.ctx.receipts).valid).toBe(false);
    const pub = (await env.req('POST', '/v1/public/receipts/pdf-verification', undefined, { pdfBase64: bytes.toString('base64') })).json();
    expect(pub.valid).toBe(true);

    await statement(env, [{ accountAlias: DEMO.dgipkAlias, amount: a.order.amount, valueDate: '2026-09-26', paymentReference: a.order.paymentReference }]);
    const mail = env.app.ctx.comms.deliveries.all().filter((d) => d.eventCode === 'receipt.finalized' && d.channel === 'email');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.attachments?.[0]).toMatchObject({ name: `quittance-${a.receiptNumber}.pdf` });
    expect(mail[0]!.attachments?.[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Points de paiement agréés : commission contractuelle et pénalités de retard (§ 37)', () => {
  it('ACTE_REQUIS sans contrat ; contrat à quatre yeux ; commission calculée à part ; pénalité proposée puis décidée par une autre personne', async () => {
    const env = await setup(true);
    const canaux = env.app.ctx.ext.canaux as CanauxService;
    const pointId = 'PA-LIMETE-MM01';
    const before = (await env.req('GET', `/v1/tresor/points/${pointId}/commission?month=2026-09`, 'u-tresor')).json();
    expect(before.status).toBe('ACTE_REQUIS');
    // Retard de versement constaté (exception du module canaux).
    canaux.points.exceptions.insert({ id: 'PEX-T1', pointId, day: '2026-09-20', type: 'VERSEMENT_EN_RETARD', detail: 'Retard (test)', expected: [{ amount: '1000.00', currency: 'USD' }], observed: [], status: 'OUVERTE', openedAt: '2026-09-22T09:00:00.000Z' });
    const late0 = (await env.req('GET', '/v1/tresor/points', 'u-tresor')).json().late.find((l: { day: string }) => l.day === '2026-09-20');
    expect(late0.status).toBe('ACTE_REQUIS');
    expect((await env.req('POST', '/v1/tresor/points/penalites', 'u-analyste-rappro', { pointId, day: '2026-09-20', motif: 'Retard constaté au relevé (test).' })).json().code).toBe('CONTRACT_REQUIRED');

    const c = await env.req('POST', `/v1/tresor/points/${pointId}/contrats`, 'u-tresor', {
      reference: 'CONV-PT-TEST-001', sha256: sha256Hex('contrat'), signedOn: '2026-06-01',
      terms: { commission: { basis: 'POURCENTAGE', value: '1' }, penalty: { basis: 'POURCENTAGE_PAR_JOUR', value: '0.1', capPct: '2' } },
    });
    expect(c.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/tresor/points/contrats/${c.json().id}/decision`, 'u-tresor', { approve: true, motif: 'Auto-validation (test refusé).' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', `/v1/tresor/points/contrats/${c.json().id}/decision`, 'canaux-tresor-2', { approve: true, motif: 'Contrat signé conforme (test).' })).json().status).toBe('EN_VIGUEUR');

    const late = (await env.req('GET', '/v1/tresor/points', 'u-tresor')).json().late.find((l: { day: string }) => l.day === '2026-09-20');
    expect(late.status).toBe('CALCULEE');
    expect(late.daysLate).toBeGreaterThan(0);
    const p = await env.req('POST', '/v1/tresor/points/penalites', 'u-analyste-rappro', { pointId, day: '2026-09-20', motif: 'Retard constaté au relevé (test).' });
    expect(p.statusCode).toBe(201);
    expect(p.json().amounts[0].currency).toBe('USD');
    const d = await env.req('POST', `/v1/tresor/points/penalites/${p.json().id}/decision`, 'u-tresor', { approve: true, motif: 'Pénalité contractuelle retenue (test).' });
    expect(d.json().status).toBe('DECIDEE');
    const com = (await env.req('GET', `/v1/tresor/points/${pointId}/commission?month=2026-09`, 'u-tresor')).json();
    expect(com.status).toBe('CALCULEE');
    expect(com.notice).toMatch(/jamais prélevée sur le montant dû/);
    expect(CIRCUITS.map((x) => x.code)).toEqual(expect.arrayContaining(['TRESOR_CONTRAT_POINT', 'TRESOR_PENALITE_POINT']));
    expect(ALL_PARAMETERS.map((x) => x.id)).toEqual(expect.arrayContaining(['tresor.appariement_seuil_proposition', 'tresor.tolerance_change_pct']));
  });
});
