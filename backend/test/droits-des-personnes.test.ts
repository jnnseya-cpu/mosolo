/**
 * Deuxième passe adverse (27/09/2026), phase « vie privée — droits des personnes » : parcours réel du contribuable
 * (accès et portabilité, rectification, limitation / retrait du consentement, effacement par anonymisation) avec
 * décision à DEUX personnes pour la limitation et l'effacement ; le journal d'audit, les écritures, les quittances et
 * les preuves ne sont jamais touchés.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

const DPO = 'integrite-u-dpo';
const DPO2 = 'vc-u-dpo';

async function full(): Promise<TestEnv> {
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

async function submit(e: TestEnv, type: string, extra: Record<string, unknown> = {}) {
  const r = await e.req('POST', '/v1/integrite/privacy/requests', 'u-contribuable', { taxpayerId: DEMO.taxpayerId, type, details: `Demande ${type} (test).`, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

describe('Droits des personnes : parcours réel du contribuable', () => {
  it('accès et portabilité : export JSON lisible par machine (profil, préférences, objets, obligations, paiements, quittances, historique)', async () => {
    const e = await full();
    const ob = e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await e.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    await signedCallback(e, callbackBody(e, order.paymentReference, order.amount));
    const id = await submit(e, 'ACCES');
    expect((await e.req('POST', `/v1/integrite/privacy/requests/${id}/respond`, DPO, { decision: 'ACCEPTEE', note: 'Export établi (test).' })).statusCode).toBe(200);
    const exp = await e.req('GET', `/v1/integrite/privacy/requests/${id}/export`, 'u-contribuable');
    expect(exp.statusCode).toBe(200);
    const x = exp.json();
    expect(x.format).toMatch(/lisible par machine/);
    expect(x.profile.id).toBe(DEMO.taxpayerId);
    expect(x.payments.some((p: { paymentReference: string }) => p.paymentReference === order.paymentReference)).toBe(true);
    expect(x.receipts.length).toBeGreaterThan(0);
    expect(x.preferences).toBeDefined();
    // Un autre contribuable ne lit pas cet export.
    expect((await e.req('GET', `/v1/integrite/privacy/requests/${id}/export`, 'u-locataire')).statusCode).toBe(403);
  });

  it('rectification : appliquée par le délégué, empreintes avant/après au journal (jamais la valeur en clair)', async () => {
    const e = await full();
    const id = await submit(e, 'RECTIFICATION', { field: 'email', requestedValue: 'nouvelle.adresse@exemple.cd' });
    expect((await e.req('POST', `/v1/integrite/privacy/requests/${id}/respond`, DPO, { decision: 'ACCEPTEE', note: 'Justificatif vérifié (test).' })).statusCode).toBe(200);
    expect(e.app.ctx.taxpayers.get(DEMO.taxpayerId).email).toBe('nouvelle.adresse@exemple.cd');
    const rec = e.app.ctx.audit.list({ action: 'integrite.privacy.rectified' }).items.at(-1)!;
    expect(JSON.stringify(rec.details)).not.toContain('nouvelle.adresse');
  });

  it('limitation (retrait du consentement) : deux personnes ; facultatif coupé, avis obligatoires maintenus', async () => {
    const e = await full();
    const tp0 = e.app.ctx.taxpayers.get(DEMO.taxpayerId);
    e.app.ctx.taxpayers.taxpayers.update({ ...tp0, prefs: { ...tp0.prefs, whatsappConsent: true, preferredChannel: 'sms' } });
    const id = await submit(e, 'LIMITATION');
    const first = await e.req('POST', `/v1/integrite/privacy/requests/${id}/respond`, DPO, { decision: 'ACCEPTEE', note: 'Demande recevable (test).' });
    expect(first.json().status).toBe('EN_ATTENTE_SECONDE_VALIDATION');
    // Rien n'est encore exécuté ; l'auteur de la première décision ne valide pas ; le contribuable non plus.
    expect(e.app.ctx.taxpayers.get(DEMO.taxpayerId).prefs.whatsappConsent).toBe(true);
    expect((await e.req('POST', `/v1/integrite/privacy/requests/${id}/validation`, DPO, { approve: true, note: 'Moi-même (test).' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await e.req('POST', `/v1/integrite/privacy/requests/${id}/validation`, 'u-contribuable', { approve: true, note: 'Moi-même (test).' })).statusCode).toBe(403);
    const ok = await e.req('POST', `/v1/integrite/privacy/requests/${id}/validation`, DPO2, { approve: true, note: 'Validation (test).' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'REPONDUE', firstDecision: { by: DPO } });
    const tp = e.app.ctx.taxpayers.get(DEMO.taxpayerId);
    expect(tp.prefs).toMatchObject({ optedOut: true, whatsappConsent: false });
    expect(tp.prefs.preferredChannel).toBeUndefined();
    const r = { id: tp.id, kind: 'taxpayer' as const, name: tp.fullName, lang: tp.language, prefs: tp.prefs };
    expect(e.app.ctx.comms.publish('obligation.due_soon', [r], { montant: '10 USD', date: '2026-10-10' }).filter((d) => d.channel !== 'in-app').every((d) => d.status === 'supprime_par_preference')).toBe(true);
    expect(e.app.ctx.comms.publish('obligation.overdue', [r], { reference: 'OBL-1' }).some((d) => d.channel !== 'in-app' && d.status !== 'supprime_par_preference')).toBe(true);
    // Deux personnes reconstituées au journal.
    expect(e.app.ctx.audit.list({ action: 'integrite.privacy.restricted' }).items.at(-1)!.details).toMatchObject({ firstBy: DPO });
    // Décision déjà prise : pas de seconde exécution.
    expect((await e.req('POST', `/v1/integrite/privacy/requests/${id}/validation`, DPO2, { approve: true, note: 'Encore (test).' })).statusCode).toBe(409);
  });

  it('effacement : anonymisation des données non exigées par la loi fiscale ; audit, écritures, quittances et identité fiscale conservés', async () => {
    const e = await full();
    const ob = e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await e.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    await signedCallback(e, callbackBody(e, order.paymentReference, order.amount));
    const tp0 = e.app.ctx.taxpayers.get(DEMO.taxpayerId);
    e.app.ctx.taxpayers.taxpayers.update({ ...tp0, email: 'contribuable@exemple.cd' });
    const ledgerHead = e.app.ctx.ledger.verifyChain().headHash;
    const receipts = JSON.stringify(e.app.ctx.receipts.receipts.all());
    const auditBefore = e.app.ctx.audit.list({ limit: 100_000 }).items.map((a) => a.hash);
    const id = await submit(e, 'EFFACEMENT');
    await e.req('POST', `/v1/integrite/privacy/requests/${id}/respond`, DPO, { decision: 'ACCEPTEE', note: 'Recevable dans les limites de la conservation légale (test).' });
    const v = await e.req('POST', `/v1/integrite/privacy/requests/${id}/validation`, DPO2, { approve: true, note: 'Validation (test).' });
    expect(v.statusCode, v.body).toBe(200);
    const tp = e.app.ctx.taxpayers.get(DEMO.taxpayerId);
    expect(tp.email).toBeUndefined();
    expect(tp.prefs).toEqual({ optedOut: true, whatsappConsent: false });
    // Identité fiscale et pièces conservées au titre de la loi.
    expect(tp.fullName).toBe(tp0.fullName);
    expect(tp.iuc).toBe(tp0.iuc);
    expect(e.app.ctx.ledger.verifyChain().headHash).toBe(ledgerHead);
    expect(JSON.stringify(e.app.ctx.receipts.receipts.all())).toBe(receipts);
    // Journal d'audit : préfixe inchangé (ajouts seulement), chaîne vérifiée.
    const after = e.app.ctx.audit.list({ limit: 100_000 }).items.map((a) => a.hash);
    expect(after.slice(0, auditBefore.length)).toEqual(auditBefore);
    expect(e.app.ctx.audit.verify().ok).toBe(true);
    expect(v.json().execution.retained.map((r: { data: string }) => r.data).join(' ')).toMatch(/Journal d’audit/);
    const rec = e.app.ctx.audit.list({ action: 'integrite.privacy.anonymised' }).items.at(-1)!;
    expect(rec.details).toMatchObject({ firstBy: DPO });
    expect(JSON.stringify(rec)).not.toContain('contribuable@exemple.cd');
    // Refus par la seconde personne : rien n'est exécuté.
    const id2 = await submit(e, 'EFFACEMENT');
    await e.req('POST', `/v1/integrite/privacy/requests/${id2}/respond`, DPO2, { decision: 'ACCEPTEE', note: 'Recevable (test).' });
    const no = await e.req('POST', `/v1/integrite/privacy/requests/${id2}/validation`, DPO, { approve: false, note: 'Contentieux en cours (test).' });
    expect(no.json().status).toBe('REJETEE');
  });
});
