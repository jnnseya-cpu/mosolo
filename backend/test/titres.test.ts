import { createPublicKey, verify } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { canonicalJson, hmacSha256Hex } from '../src/core/crypto.js';
import { titresPlugin, type TitresService } from '../src/plugins/titres/plugin.js';
import type { CredentialType, ValidityPolicy } from '../src/plugins/titres/model.js';
import { computeWindow, controlResultOf, endOfKinshasaDay, statusAt } from '../src/plugins/titres/validity.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

const PROVIDER_SECRET = 'test-secret-mm-operator-a';
const CTRL = 'tt-controleur';
const DEVICE = 'dev-titres-test';
const DEVICE_KEY = 'device-key-titres-test';
const PLACE = { commune: 'Limete', label: 'Boulevard Lumumba', lat: -4.37, lon: 15.34 };
const SERVICE_PLACE = { commune: 'Limete', sourceId: 'ZONE-LMT-01', label: 'Zone de démonstration Limete', basis: 'ZONE_SERVICE' as const };

async function setup() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [titresPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }),
  };
  const ctx = app.ctx;
  const svc = ctx.ext.titres as TitresService;
  ctx.users.add({ id: CTRL, name: 'Contrôleur de test (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete', 'Lemba'] });
  ctx.users.add({ id: 'tt-controleur-gombe', name: 'Contrôleur Gombe (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Gombe'] });
  ctx.users.add({ id: 'tt-chef', name: 'Chef de service (démo)', roles: ['R07'], entity: 'DGIPK' });
  ctx.users.add({ id: 'tt-chef-autre', name: 'Chef de service autre entité (démo)', roles: ['R07'], entity: 'DGTK' });
  ctx.field.enroll(DEVICE, CTRL, DEVICE_KEY);
  // Règle de tarif certifiée et publiée par quatre personnes distinctes (fictive).
  const drafter = ctx.users.get('u-juriste-redacteur')!;
  const rule = ctx.rules.create(drafter, {
    code: 'TEST-TITRE', revenueCategory: 'REDEVANCE_SERVICE', label: 'Test — redevance de titre (fictive)', legalInstrumentIds: ['demo-instrument-001'],
    articles: ['Art. 1 (fictif)'], competentAuthority: 'Test', administeringEntity: 'DGIPK', taxableEvent: 'Usage', liableParty: 'Usager',
    baseDefinition: 'Nombre d’unités', formula: 'n * t', rateTable: { t: '2' }, currency: 'USD', rounding: 'HALF_UP', periodicity: 'PONCTUELLE',
    dueRule: 'À l’achat', exemptions: [], penalties: [], effectiveFrom: '2026-01-01', beneficiaryAccountAlias: DEMO.dgipkAlias,
    appealPath: 'Réclamation', sourceVerification: 'OFFICIEL_CERTIFIE',
  });
  ctx.rules.approve(drafter, rule.id, 'REDACTEUR');
  ctx.rules.approve(ctx.users.get('u-juriste-verificateur')!, rule.id, 'VERIFICATEUR_JURIDIQUE');
  ctx.rules.approve(ctx.users.get('u-validateur-financier')!, rule.id, 'VALIDATEUR_FINANCIER');
  ctx.rules.approve(ctx.users.get('u-autorite-publication')!, rule.id, 'AUTORITE_PUBLICATION');
  return { env, clock, ctx, svc };
}

const base: Omit<ValidityPolicy, 'model'> = { toleranceMinutes: 0, amberMinutes: 120, startMode: 'PAIEMENT', extendable: true, refundable: false };

function defineType(svc: TitresService, code: string, validity: Partial<ValidityPolicy> & { model: ValidityPolicy['model'] }, over: Partial<CredentialType> = {}) {
  return svc.defineType({
    code, module: '99', moduleLabel: 'Module de test', label: `Titre ${code}`, prefix: 'TST', entity: 'DGIPK',
    validity: { ...base, ...validity }, transferable: false, plateBound: false, supports: ['QR_DYNAMIQUE', 'QR_STATIQUE', 'PLAQUE'],
    pricing: { ruleCode: 'TEST-TITRE', inputs: { n: '1' } }, legalAct: { ref: 'J21', status: 'DEMONSTRATION', note: 'Test' }, demo: true, ...over,
  });
}

async function pay(env: TestEnv, reference: string, status: 'SUCCESS' | 'FAILED' = 'SUCCESS') {
  const order = env.app.ctx.payments.byReference(reference)!;
  const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: reference, amount: order.amount, status, completedAt: env.clock.now().toISOString() });
  return env.app.inject({
    method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw,
    headers: { 'content-type': 'application/json', 'x-signature': hmacSha256Hex(PROVIDER_SECRET, raw), 'x-nonce': randomUUID(), 'x-timestamp': env.clock.now().toISOString() },
  });
}

async function buyAndPay(s: Awaited<ReturnType<typeof setup>>, typeCode: string, subject: Record<string, string> = {}) {
  const iss = s.svc.purchase(s.ctx.users.get('u-contribuable')!, {
    payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode, holderTaxpayerId: DEMO.taxpayerId, subject, place: SERVICE_PLACE }],
  });
  expect((await pay(s.env, iss.payments[0]!.paymentReference)).statusCode).toBe(200);
  s.svc.sync();
  const done = s.svc.issuance(iss.id);
  return s.svc.credential(done.items[0]!.credentialId!);
}

describe('Moteur de titres — modèles de validité (heure serveur, fuseau de Kinshasa)', () => {
  const t0 = new Date('2026-09-26T09:00:00.000Z').getTime();
  it('calcule les neuf modèles de validité', () => {
    expect(new Date(computeWindow({ ...base, model: 'DUREE_COURTE', durationMinutes: 60 }, { start: t0 }).until).toISOString()).toBe('2026-09-26T09:59:59.999Z');
    expect(() => computeWindow({ ...base, model: 'DUREE_COURTE', maxDurationMinutes: 120 }, { start: t0, durationMinutes: 180 })).toThrow(/plafond/);
    // Journée calendaire : fin à 23:59:59 heure de Kinshasa (UTC+1) = 22:59:59Z.
    expect(new Date(computeWindow({ ...base, model: 'JOURNALIER', dayMode: 'CALENDAIRE' }, { start: t0 }).until).toISOString()).toBe('2026-09-26T22:59:59.999Z');
    expect(new Date(endOfKinshasaDay(new Date('2026-09-26T23:30:00Z').getTime())).toISOString()).toBe('2026-09-27T22:59:59.999Z');
    expect(new Date(computeWindow({ ...base, model: 'JOURNALIER', dayMode: 'GLISSANT_24H' }, { start: t0 }).until).toISOString()).toBe('2026-09-27T08:59:59.999Z');
    expect(new Date(computeWindow({ ...base, model: 'HEBDOMADAIRE_MENSUEL', periodDays: 7 }, { start: t0 }).until).toISOString()).toBe('2026-10-03T08:59:59.999Z');
    expect(new Date(computeWindow({ ...base, model: 'ANNUEL_EXERCICE' }, { start: t0 }).until).toISOString()).toBe('2026-12-31T22:59:59.999Z');
    expect(computeWindow({ ...base, model: 'PAR_EVENEMENT' }, { start: t0, eventStart: '2026-10-01T16:00:00Z', eventEnd: '2026-10-01T22:00:00Z' }).from).toBe(new Date('2026-10-01T16:00:00Z').getTime());
    expect(() => computeWindow({ ...base, model: 'PAR_EVENEMENT' }, { start: t0 })).toThrow(/événement/);
    expect(computeWindow({ ...base, model: 'USAGE_UNIQUE' }, { start: t0 }).uses).toBe(1);
    expect(computeWindow({ ...base, model: 'CARNET_USAGES', uses: 5 }, { start: t0 }).uses).toBe(5);
    expect(new Date(computeWindow({ ...base, model: 'ABONNEMENT', periodDays: 30 }, { start: t0 }).until).toISOString()).toBe('2026-10-26T08:59:59.999Z');
    expect(computeWindow({ ...base, model: 'GLISSANT_CONDITIONNEL', periodDays: 90 }, { start: t0 }).until).toBeGreaterThan(t0);
  });

  it('passe du gris au vert (≥ 50 %), à l’ambre (1–50 %), au rouge (< 1 %) puis expiré ; couleur toujours doublée d’icône et de texte (AC-TIT-02, AC-TIT-04)', () => {
    const c = { state: 'EMIS' as const, validFrom: '2026-09-26T10:00:00.000Z', validUntil: '2026-09-26T22:59:59.999Z', toleranceMinutes: 15, amberMinutes: 120, model: 'JOURNALIER' as const };
    const at = (iso: string) => statusAt(c, new Date(iso));
    expect(at('2026-09-26T09:00:00Z')).toMatchObject({ status: 'PAS_ENCORE_ACTIF', color: 'gris' });
    expect(at('2026-09-26T09:00:00Z').text).toMatch(/VALIDE À PARTIR DU 26\/09\/2026 11:00/);
    expect(at('2026-09-26T12:00:00Z')).toMatchObject({ status: 'VALIDE', color: 'vert', icon: 'check', signal: 'COURT' });
    // Fenêtre de 13 h : 6 h restantes à 17:00 (46 %) et 1 h 30 à 21:30 (11,5 %) → ambre ; 5 min à 22:55 (0,6 %) → rouge, encore valable.
    const amber = at('2026-09-26T17:00:00Z');
    expect(amber).toMatchObject({ status: 'BIENTOT_EXPIRE', color: 'ambre', icon: 'alert', validity: { band: 'AMBRE' } });
    expect(amber.text).toMatch(/^VALIDE — expire dans 5 h 59 min/);
    expect(at('2026-09-26T21:30:00Z')).toMatchObject({ status: 'BIENTOT_EXPIRE', color: 'ambre' });
    expect(at('2026-09-26T22:50:00Z').validity.band).toBe('AMBRE'); // 1,3 % restant
    const red = at('2026-09-26T22:55:00Z');
    expect(red).toMatchObject({ status: 'CRITIQUE', color: 'rouge', icon: 'alert', validity: { band: 'ROUGE' } });
    expect(red.text).toMatch(/^EXPIRE DANS 4 min/);
    expect(controlResultOf(red.status)).toBe('VALIDE');
    expect(at('2026-09-26T16:29:00Z').validity.band).toBe('VERT'); // 50,1 % restant
    expect(at('2026-09-26T16:31:00Z').validity.band).toBe('AMBRE'); // 49,9 % restant
    expect(at('2026-09-26T23:10:00Z').status).toBe('CRITIQUE'); // tolérance
    expect(at('2026-09-26T23:30:00Z')).toMatchObject({ status: 'EXPIRE', color: 'rouge', icon: 'x', signal: 'DISTINCT' });
    expect(statusAt({ ...c, state: 'SUSPENDU', stateReason: 'Contestation' }, new Date('2026-09-26T12:00:00Z'))).toMatchObject({ status: 'SUSPENDU', color: 'bleu' });
    expect(statusAt({ ...c, state: 'CONSOMME', model: 'USAGE_UNIQUE' }, new Date('2026-09-26T12:00:00Z'))).toMatchObject({ status: 'INVALIDE', color: 'noir', text: 'DÉJÀ UTILISÉ' });
    expect(statusAt({ ...c, model: 'GLISSANT_CONDITIONNEL', conditionMet: false }, new Date('2026-09-26T12:00:00Z')).invalidReason).toBe('CONDITION_NON_REMPLIE');
  });
});

describe('Moteur de titres — émission adossée au paiement confirmé', () => {
  it('commande → référence ; aucun titre avant le rappel signé ; titre actif adossé à la quittance ensuite', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER', dayMode: 'CALENDAIRE' });
    const iss = s.svc.purchase(s.ctx.users.get('u-contribuable')!, {
      payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-JOUR', holderTaxpayerId: DEMO.taxpayerId, subject: { plate: 'KN 1234 AB' }, place: SERVICE_PLACE }],
    });
    expect(iss.status).toBe('EN_ATTENTE_PAIEMENT');
    expect(iss.payments[0]!.amount).toEqual({ amount: '2.00', currency: 'USD' });
    const obligation = s.ctx.assessment.get(iss.payments[0]!.obligationId);
    expect(obligation.ruleCode).toBe('TEST-TITRE');
    expect(obligation.attribution.commune).toBe('Limete');
    expect(s.svc.credentials.count()).toBe(0);
    const res = await pay(s.env, iss.payments[0]!.paymentReference);
    expect(res.json().status).toBe('CONFIRME');
    const list = (await s.env.req('GET', '/v1/titres', 'u-contribuable')).json();
    expect(list).toHaveLength(1);
    expect(list[0].receiptNumbers[0]).toBe(res.json().receiptNumber);
    expect(list[0].status.status).toBe('VALIDE');
    expect(list[0].attribution).toMatchObject({ commune: 'Limete', basis: 'ZONE_SERVICE', sourceId: 'ZONE-LMT-01' });
    expect(list[0].staticToken).toMatch(/^MT1\./);
    expect(s.ctx.comms.deliveries.find((d) => d.eventCode === 'ticket.purchased').length).toBeGreaterThan(0);
    expect(s.ctx.audit.list({ limit: 100000 }).items.some((a) => a.action === 'titres.credential.issued')).toBe(true);
    // Rejeu du rappel : aucun second titre.
    s.svc.sync();
    expect(s.svc.credentials.count()).toBe(1);
  });

  it('refuse un type sans acte (J21) et journalise le refus', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-SANS-ACTE', { model: 'JOURNALIER' }, { legalAct: { ref: 'J21', status: 'ACTE_REQUIS', note: '' } });
    expect(() => s.svc.purchase(s.ctx.users.get('u-contribuable')!, {
      payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-SANS-ACTE', subject: {}, place: SERVICE_PLACE }],
    })).toThrow(/Acte requis/);
    expect(s.ctx.audit.list({ limit: 100000 }).items.some((a) => a.action === 'titres.issuance.refused' && a.outcome === 'DENIED')).toBe(true);
    const types = (await s.env.req('GET', '/v1/titres/types')).json();
    expect(types.find((t: { code: string }) => t.code === 'TST-SANS-ACTE').activable).toBe(false);
  });

  it('un contribuable ne commande pas pour autrui ; localisation obligatoire', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER' });
    expect(() => s.svc.purchase(s.ctx.users.get('u-locataire')!, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-JOUR', subject: {}, place: SERVICE_PLACE }] })).toThrow(/non autorisée/);
    expect(() => s.svc.purchase(s.ctx.users.get('u-contribuable')!, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-JOUR', subject: {}, place: { ...SERVICE_PLACE, commune: null } }] })).toThrow(/Localisation obligatoire/);
  });

  it('référence expirée sans paiement ⇒ commande close et obligation annulée (contre-écriture) ; paiement échoué idem', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER' });
    const u = s.ctx.users.get('u-contribuable')!;
    const a = s.svc.purchase(u, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-JOUR', subject: { plate: 'AA1' }, place: SERVICE_PLACE }] });
    s.clock.advanceHours(49);
    s.svc.sync();
    expect(s.svc.issuance(a.id).status).toBe('EXPIREE');
    const o = s.ctx.assessment.get(a.payments[0]!.obligationId);
    expect(o.status).toBe('ANNULEE');
    expect(s.ctx.ledger.isReversed(o.ledgerEntryId!)).toBe(true);
    const b = s.svc.purchase(u, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-JOUR', subject: { plate: 'AA2' }, place: SERVICE_PLACE }] });
    await pay(s.env, b.payments[0]!.paymentReference, 'FAILED');
    s.svc.sync();
    expect(s.svc.issuance(b.id).status).toBe('EXPIREE');
    expect(s.svc.credentials.count()).toBe(0);
    // Double commande en attente pour la même plaque : refus.
    s.svc.purchase(u, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-JOUR', subject: { plate: 'AA3' }, place: SERVICE_PLACE }] });
    expect(() => s.svc.purchase(u, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'TST-JOUR', subject: { plate: 'aa 3' }, place: SERVICE_PLACE }] })).toThrow(/en attente/);
  });

  it('paiement contrepassé ⇒ titre révoqué (noir) et titulaire notifié (ARB-22)', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER' });
    const c = await buyAndPay(s, 'TST-JOUR');
    const order = s.ctx.payments.orders.get(c.paymentOrderId!)!;
    s.ctx.payments.orders.update({ ...order, status: 'CONTREPASSE' }); // simulation d'une contrepassation du Trésor
    s.svc.sync();
    const after = s.svc.credential(c.id);
    expect(after.state).toBe('REVOQUE');
    expect(s.svc.status(after).color).toBe('noir');
    expect(s.svc.revocationList().entries.map((e) => e.id)).toContain(c.id);
  });
});

describe('Contrôle des titres — QR dynamique, usage unique, plaque, constats', () => {
  it('QR dynamique régénéré toutes les 30 s : la capture présentée plus tard est refusée (AC-TIT-05)', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER' });
    const c = await buyAndPay(s, 'TST-JOUR');
    expect((await s.env.req('GET', `/v1/titres/${c.id}/qr`, 'u-locataire')).statusCode).toBe(403);
    const qr = (await s.env.req('GET', `/v1/titres/${c.id}/qr`, 'u-contribuable')).json();
    expect(qr.windowSeconds).toBe(30);
    expect(qr.token).toMatch(/^MD1\./);
    const ok = await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: qr.token, place: PLACE });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ result: 'VALIDE', color: 'vert', nothingToPay: true });
    // Réponse minimale : ni nom, ni identifiant de contribuable.
    expect(JSON.stringify(ok.json())).not.toMatch(/Mbuyi|TP-DEMO/);
    s.clock.advance(61_000);
    const late = (await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: qr.token, place: PLACE })).json();
    expect(late).toMatchObject({ result: 'INVALIDE', nothingToPay: false });
    expect(late.text).toMatch(/capture/);
    expect(late.constat.notice).toMatch(/aucune amende/);
    // Jeton falsifié.
    const forged = (await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: qr.token.replace(/.$/, (x: string) => (x === '0' ? '1' : '0')), place: PLACE })).json();
    expect(forged.result).toBe('INVALIDE');
  });

  it('usage unique : premier contrôle consomme, second « DÉJÀ UTILISÉ » avec heure et lieu du premier usage (AC-TIT-03)', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-EMB', { model: 'USAGE_UNIQUE', periodDays: 1 });
    const c = await buyAndPay(s, 'TST-EMB');
    const first = (await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: c.staticToken, place: PLACE })).json();
    expect(first.result).toBe('VALIDE');
    s.clock.advance(10 * 60_000);
    const second = (await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: c.staticToken, place: { ...PLACE, label: 'Autre quai' } })).json();
    expect(second).toMatchObject({ result: 'INVALIDE', color: 'noir', text: 'DÉJÀ UTILISÉ' });
    expect(second.alreadyUsed).toMatchObject({ at: '2026-09-26T09:00:00.000Z', place: { label: 'Boulevard Lumumba' } });
    expect(s.ctx.alerts.alerts.find((a) => a.type === 'CREDENTIAL_REUSE_ATTEMPT')).toHaveLength(1);
    expect(s.svc.usages.count()).toBe(1);
    expect(s.svc.indicators('99').controls.reuseAttempts).toBe(1);
  });

  it('carnet d’usages : décompte puis épuisement', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-CARNET', { model: 'CARNET_USAGES', uses: 2, periodDays: 30 });
    const c = await buyAndPay(s, 'TST-CARNET', { plate: 'KN-PEAGE-1' });
    const r1 = (await s.env.req('POST', '/v1/titres/controles', CTRL, { plate: 'KN PEAGE 1', place: PLACE })).json();
    expect(r1.result).toBe('VALIDE');
    expect(r1.text).toMatch(/1 restant/);
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { plate: 'KN PEAGE 1', place: PLACE })).json().result).toBe('VALIDE');
    const r3 = (await s.env.req('POST', '/v1/titres/controles', CTRL, { plate: 'KN PEAGE 1', place: PLACE })).json();
    expect(r3.result).toBe('INVALIDE');
    expect(s.svc.credential(c.id).state).toBe('CONSOMME');
  });

  it('contrôle par plaque : rouge sous 1 % de validité mais encore VALIDE, puis expiré ; constat sans montant ni obligation (AC-TIT-06)', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER', dayMode: 'CALENDAIRE' });
    await buyAndPay(s, 'TST-JOUR', { plate: 'KN 7777 BB' });
    s.clock.set('2026-09-26T22:55:00.000Z'); // 5 min avant la fin de journée (< 1 % restant)
    const list = (await s.env.req('GET', '/v1/vehicules/KN7777BB/titres?commune=Limete', CTRL)).json();
    expect(list.credentials[0]).toMatchObject({ status: 'CRITIQUE', color: 'rouge', icon: 'alert', result: 'VALIDE' });
    expect(list.credentials[0].remainingSeconds).toBeGreaterThan(0);
    expect((await s.env.req('GET', '/v1/vehicules/KN7777BB/titres?commune=Limete', 'u-contribuable')).statusCode).toBe(403);
    // Rappel ambre envoyé une seule fois.
    s.svc.sync();
    s.svc.sync();
    expect(s.ctx.comms.deliveries.find((d) => d.eventCode === 'ticket.expiring' && d.channel === 'sms')).toHaveLength(1);
    s.clock.set('2026-09-27T08:00:00.000Z');
    const obligationsBefore = s.ctx.assessment.obligations.count();
    const red = (await s.env.req('POST', '/v1/titres/controles', CTRL, { plate: 'KN 7777 BB', place: PLACE })).json();
    expect(red).toMatchObject({ result: 'EXPIRE', color: 'rouge', nothingToPay: false });
    const constat = s.svc.constats.get(red.constat.id)!;
    expect(constat).toMatchObject({ status: 'OUVERT', legalEffect: 'AUCUN_MONTANT' });
    expect(s.ctx.assessment.obligations.count()).toBe(obligationsBefore);
    // Plaque inconnue : invalide + constat.
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { plate: 'ZZ 0000', place: PLACE })).json().result).toBe('INVALIDE');
  });

  it('contrôle réservé aux contrôleurs, dans leur périmètre ; un titre d’un autre service est refusé', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER' });
    const c = await buyAndPay(s, 'TST-JOUR');
    expect((await s.env.req('POST', '/v1/titres/controles', 'u-contribuable', { qr: c.staticToken, place: PLACE })).statusCode).toBe(403);
    expect((await s.env.req('POST', '/v1/titres/controles', 'tt-controleur-gombe', { qr: c.staticToken, place: PLACE })).statusCode).toBe(403);
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: c.staticToken, place: { label: 'sans commune' } })).statusCode).toBe(400);
    const wrong = (await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: c.staticToken, place: PLACE, module: '81' })).json();
    expect(wrong.result).toBe('INVALIDE');
    // Statut public minimal (heure serveur), sans donnée personnelle.
    const pub = (await s.env.req('GET', `/v1/titres/${c.id}/statut`)).json();
    expect(pub.status).toBe('VALIDE');
    expect(pub.holderTaxpayerId).toBeUndefined();
  });
});

describe('Contrôle hors ligne — paquet signé, lot signé, reconfirmation', () => {
  it('paquet signé Ed25519 ; lot HMAC du terminal ; reconfirmation ; double usage détecté entre hors ligne et en ligne', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-EMB', { model: 'USAGE_UNIQUE', periodDays: 1 });
    const c = await buyAndPay(s, 'TST-EMB');
    const pack = (await s.env.req('GET', `/v1/titres/hors-ligne/paquet?deviceId=${DEVICE}`, CTRL)).json();
    const pub = createPublicKey(pack.publicKeyPem);
    const { signature, algorithm, ...doc } = pack.revocations;
    expect(algorithm).toBe('Ed25519');
    expect(verify(null, Buffer.from(canonicalJson(doc)), pub, Buffer.from(signature, 'base64url'))).toBe(true);
    expect((await s.env.req('GET', '/v1/titres/hors-ligne/paquet?deviceId=dev-terrain-001', CTRL)).statusCode).toBe(403);

    s.clock.advance(5 * 60_000);
    const batch = { batchId: 'LOT-TT-0001', deviceId: DEVICE, createdAt: s.clock.now().toISOString(), controls: [
      { opId: 'op1', token: c.staticToken, controlledAt: '2026-09-26T09:02:00.000Z', place: { label: 'Quai 1', lat: -4.3, lon: 15.3 }, offlineResult: 'VALIDE' },
      { opId: 'op2', token: c.staticToken, controlledAt: '2026-09-26T09:03:00.000Z', place: { label: 'Quai 2' }, offlineResult: 'VALIDE' },
      { opId: 'op3', token: 'MT1.faux.jeton', controlledAt: '2026-09-26T09:03:30.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'op4', token: c.staticToken, controlledAt: '2026-09-29T09:03:30.000Z', place: {}, offlineResult: 'VALIDE' },
    ] };
    const raw = JSON.stringify(batch);
    const bad = await s.env.req('POST', '/v1/titres/controles/lots', CTRL, raw, { 'x-device-signature': hmacSha256Hex('mauvaise-cle', raw) });
    expect(bad.statusCode).toBe(401);
    const res = await s.env.req('POST', '/v1/titres/controles/lots', CTRL, raw, { 'x-device-signature': hmacSha256Hex(DEVICE_KEY, raw) });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    const byOp = Object.fromEntries(out.results.map((r: { opId: string }) => [r.opId, r]));
    expect(byOp.op1).toMatchObject({ reconfirmed: 'VALIDE', divergent: false });
    expect(byOp.op2).toMatchObject({ reconfirmed: 'INVALIDE', divergent: true });
    expect(byOp.op2.alreadyUsed.place.label).toBe('Quai 1');
    expect(byOp.op3).toMatchObject({ reconfirmed: 'INVALIDE' });
    expect(byOp.op4.rejected).toBe('HORODATAGE_INCOHERENT');
    expect(out.revocations.entries.map((e: { id: string }) => e.id)).toContain(c.id);
    // Rejeu du même lot : aucune double écriture.
    const replay = (await s.env.req('POST', '/v1/titres/controles/lots', CTRL, raw, { 'x-device-signature': hmacSha256Hex(DEVICE_KEY, raw) })).json();
    expect(replay.replayed).toBe(true);
    expect(s.svc.controls.find((e) => e.offline)).toHaveLength(3);
    // Puis en ligne : DÉJÀ UTILISÉ.
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: c.staticToken, place: PLACE })).json().text).toBe('DÉJÀ UTILISÉ');
  });
});

describe('Décisions humaines motivées', () => {
  it('suspendre, lever, remplacer, annuler : personne habilitée de l’entité, motif obligatoire', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-MOIS', { model: 'HEBDOMADAIRE_MENSUEL', periodDays: 30 });
    const c = await buyAndPay(s, 'TST-MOIS', { plate: 'KN 1 A' });
    expect((await s.env.req('POST', `/v1/titres/${c.id}/decisions`, CTRL, { decision: 'SUSPENDRE', motif: 'Contestation en cours' })).statusCode).toBe(403);
    expect((await s.env.req('POST', `/v1/titres/${c.id}/decisions`, 'tt-chef-autre', { decision: 'SUSPENDRE', motif: 'Contestation en cours' })).statusCode).toBe(403);
    expect((await s.env.req('POST', `/v1/titres/${c.id}/decisions`, 'tt-chef', { decision: 'SUSPENDRE', motif: 'x' })).statusCode).toBe(400);
    const sus = (await s.env.req('POST', `/v1/titres/${c.id}/decisions`, 'tt-chef', { decision: 'SUSPENDRE', motif: 'Contestation en cours' })).json();
    expect(sus.credential.status).toMatchObject({ status: 'SUSPENDU', color: 'bleu' });
    expect(sus.credential.status.text).toMatch(/Contestation/);
    const lift = (await s.env.req('POST', `/v1/titres/${c.id}/decisions`, 'tt-chef', { decision: 'LEVER', motif: 'Contestation rejetée' })).json();
    expect(lift.credential.status.status).toBe('VALIDE');
    const rep = (await s.env.req('POST', `/v1/titres/${c.id}/decisions`, 'tt-chef', { decision: 'REMPLACER', motif: 'Téléphone perdu, QR réémis' })).json();
    expect(rep.credential.state).toBe('REMPLACE');
    expect(rep.replacement.status.status).toBe('VALIDE');
    expect(rep.replacement.validUntil).toBe(c.validUntil);
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: c.staticToken, place: PLACE })).json().result).toBe('INVALIDE');
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: rep.replacement.staticToken, place: PLACE })).json().result).toBe('VALIDE');
    // Changement de plaque sans motif de correction : refusé (non transférable).
    expect((await s.env.req('POST', `/v1/titres/${rep.replacement.id}/decisions`, 'tt-chef', { decision: 'REMPLACER', motif: 'Revente de la moto', subject: { plate: 'KN 2 B' } })).statusCode).toBe(422);
    const cancel = (await s.env.req('POST', `/v1/titres/${rep.replacement.id}/decisions`, 'tt-chef', { decision: 'ANNULER', motif: 'Titre émis par erreur' })).json();
    expect(cancel.credential.state).toBe('ANNULE');
    expect(cancel.notice).toMatch(/contre-écriture/);
    expect(s.ctx.audit.list({ limit: 100000 }).items.filter((a) => a.action.startsWith('titres.credential.')).length).toBeGreaterThan(4);
  });

  it('constat : le contrôleur auteur ne décide pas ; décision motivée par le chef de service', async () => {
    const s = await setup();
    const ctl = (await s.env.req('POST', '/v1/titres/controles', CTRL, { plate: 'XX 1', place: PLACE })).json();
    expect((await s.env.req('POST', `/v1/titres/constats/${ctl.constat.id}/decision`, CTRL, { outcome: 'CLASSE', motif: 'Erreur de saisie' })).statusCode).toBe(403);
    const list = (await s.env.req('GET', '/v1/titres/constats', CTRL)).json();
    expect(list).toHaveLength(1);
    const d = await s.env.req('POST', `/v1/titres/constats/${ctl.constat.id}/decision`, 'tt-chef', { outcome: 'CLASSE', motif: 'Plaque mal lue, classement' });
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ status: 'CLASSE', legalEffect: 'AUCUN_MONTANT' });
    expect((await s.env.req('POST', `/v1/titres/constats/${ctl.constat.id}/decision`, 'tt-chef', { outcome: 'TRANSMIS', motif: 'Nouvel avis' })).statusCode).toBe(409);
  });

  it('prolongation (nouveau paiement, continuité) et abonnement avec consentement', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-HEURE', { model: 'DUREE_COURTE', durationMinutes: 60, maxDurationMinutes: 240, amberMinutes: 15 });
    defineType(s.svc, 'TST-ABO', { model: 'ABONNEMENT', periodDays: 30 });
    const c = await buyAndPay(s, 'TST-HEURE', { plate: 'KN 5 C' });
    const ext = await s.env.req('POST', `/v1/titres/${c.id}/prolongations`, 'u-contribuable', { channel: 'USSD', durationMinutes: 120 }, { 'idempotency-key': 'prolongation-0001' });
    expect(ext.statusCode).toBe(201);
    const again = await s.env.req('POST', `/v1/titres/${c.id}/prolongations`, 'u-contribuable', { channel: 'USSD', durationMinutes: 120 }, { 'idempotency-key': 'prolongation-0001' });
    expect(again.headers['idempotent-replayed']).toBe('true');
    await pay(s.env, ext.json().payments[0].paymentReference);
    s.svc.sync();
    const next = s.svc.credential(s.svc.issuance(ext.json().id).items[0]!.credentialId!);
    expect(next.renewsId).toBe(c.id);
    expect(new Date(next.validFrom).getTime()).toBe(new Date(c.validUntil).getTime() + 1);
    expect(new Date(next.validUntil).getTime() - new Date(next.validFrom).getTime()).toBe(120 * 60_000 - 1);
    const abo = await buyAndPay(s, 'TST-ABO');
    expect(abo.autoRenew?.consent).toBe(false);
    const on = (await s.env.req('POST', `/v1/titres/${abo.id}/abonnement`, 'u-contribuable', { consent: true })).json();
    expect(on.autoRenew.consent).toBe(true);
    const off = (await s.env.req('POST', `/v1/titres/${abo.id}/abonnement`, 'u-contribuable', { consent: false })).json();
    expect(off.autoRenew.cancelledAt).toBeDefined();
    expect((await s.env.req('GET', '/v1/titres/indicateurs', 'u-contribuable')).statusCode).toBe(403);
    expect((await s.env.req('GET', '/v1/titres/indicateurs', 'u-gouverneur')).json().renewals.total).toBe(1);
  });
});

async function sendBatch(s: Awaited<ReturnType<typeof setup>>, batchId: string, controls: Record<string, unknown>[]) {
  const raw = JSON.stringify({ batchId, deviceId: DEVICE, createdAt: s.clock.now().toISOString(), controls });
  const res = await s.env.req('POST', '/v1/titres/controles/lots', CTRL, raw, { 'x-device-signature': hmacSha256Hex(DEVICE_KEY, raw) });
  expect(res.statusCode).toBe(200);
  return Object.fromEntries(res.json().results.map((r: { opId: string }) => [r.opId, r])) as Record<string, { reconfirmed?: string; divergent?: boolean; rejected?: string }>;
}

describe('Contrôle hors ligne — historique des paquets et même verdict qu’en ligne', () => {
  it('un contrôle fait sous un paquet antérieur est accepté après un nouveau téléchargement ; l’usage unique passe CONSOMME', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-EMB', { model: 'USAGE_UNIQUE', periodDays: 1 });
    const c = await buyAndPay(s, 'TST-EMB');
    expect((await s.env.req('GET', `/v1/titres/hors-ligne/paquet?deviceId=${DEVICE}`, CTRL)).statusCode).toBe(200);
    s.clock.set('2026-09-26T11:00:00.000Z'); // second paquet, sans synchronisation entre les deux
    await s.env.req('GET', `/v1/titres/hors-ligne/paquet?deviceId=${DEVICE}`, CTRL);
    s.clock.set('2026-09-26T11:10:00.000Z');
    const r = await sendBatch(s, 'LOT-HIST-1', [{ opId: 'o1', token: c.staticToken, controlledAt: '2026-09-26T09:30:00.000Z', place: { label: 'Quai 1' }, offlineResult: 'VALIDE' }]);
    expect(r.o1).toMatchObject({ reconfirmed: 'VALIDE', divergent: false });
    expect(s.svc.credential(c.id).state).toBe('CONSOMME');
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { qr: c.staticToken, place: PLACE })).json().text).toBe('DÉJÀ UTILISÉ');
  });

  it('âge maximal : aucun contrôle de plus de 72 h avant la création du lot', async () => {
    const s = await setup();
    await s.env.req('GET', `/v1/titres/hors-ligne/paquet?deviceId=${DEVICE}`, CTRL);
    s.clock.set('2026-09-29T17:00:00.000Z'); // 80 h plus tard
    const r = await sendBatch(s, 'LOT-AGE-1', [
      { opId: 'vieux', plate: 'KN 1 A', controlledAt: '2026-09-26T10:00:00.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'recent', plate: 'KN 1 A', controlledAt: '2026-09-27T19:00:00.000Z', place: {}, offlineResult: 'INVALIDE' },
    ]);
    expect(r.vieux!.rejected).toBe('HORODATAGE_INCOHERENT');
    expect(r.recent).toMatchObject({ reconfirmed: 'INVALIDE', divergent: false });
  });

  it('QR dynamique vérifié à l’instant du contrôle, code court, lien /preuve/, et titre d’un autre service refusé', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-JOUR', { model: 'JOURNALIER' });
    const c = await buyAndPay(s, 'TST-JOUR', { plate: 'KN 42 ZZ' });
    await s.env.req('GET', `/v1/titres/hors-ligne/paquet?deviceId=${DEVICE}`, CTRL);
    s.clock.set('2026-09-26T09:20:00.000Z');
    const qr = (await s.env.req('GET', `/v1/titres/${c.id}/qr`, 'u-contribuable')).json();
    s.clock.set('2026-09-26T10:00:00.000Z');
    const r = await sendBatch(s, 'LOT-RES-1', [
      { opId: 'dyn', token: qr.token, controlledAt: '2026-09-26T09:20:05.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'capture', token: qr.token, controlledAt: '2026-09-26T09:25:00.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'code', token: c.shortCode, controlledAt: '2026-09-26T09:30:00.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'url', token: `https://mosolo.example/preuve/${c.shortCode}`, controlledAt: '2026-09-26T09:31:00.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'autre', token: c.staticToken, module: '81', controlledAt: '2026-09-26T09:32:00.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'plaque-autre', plate: 'KN 42 ZZ', module: '81', controlledAt: '2026-09-26T09:33:00.000Z', place: {}, offlineResult: 'VALIDE' },
      { opId: 'plaque', plate: 'KN 42 ZZ', module: '99', controlledAt: '2026-09-26T09:34:00.000Z', place: {}, offlineResult: 'VALIDE' },
    ]);
    expect(r.dyn).toMatchObject({ reconfirmed: 'VALIDE', divergent: false });
    expect(r.capture).toMatchObject({ reconfirmed: 'INVALIDE', divergent: true });
    expect(r.code!.reconfirmed).toBe('VALIDE');
    expect(r.url!.reconfirmed).toBe('VALIDE');
    expect(r.autre).toMatchObject({ reconfirmed: 'INVALIDE', divergent: true });
    expect(r['plaque-autre']!.reconfirmed).toBe('INVALIDE');
    expect(r.plaque!.reconfirmed).toBe('VALIDE');
    // Même verdict en ligne pour la présentation dans un autre service.
    expect((await s.env.req('POST', '/v1/titres/controles', CTRL, { plate: 'KN 42 ZZ', module: '81', place: PLACE })).json().result).toBe('INVALIDE');
  });
});

describe('Émission — fenêtre vérifiée avant l’obligation, émission robuste article par article', () => {
  it('durée hors plafond, dates d’événement manquantes, début invalide : 400 sans aucune obligation créée', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-HEURE', { model: 'DUREE_COURTE', durationMinutes: 60, maxDurationMinutes: 240, startMode: 'HEURE_CHOISIE' });
    defineType(s.svc, 'TST-EVT', { model: 'PAR_EVENEMENT' });
    const user = s.ctx.users.get('u-contribuable')!;
    const obligations = s.ctx.assessment.obligations.count();
    const buy = (item: Record<string, unknown>) => () => s.svc.purchase(user, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ subject: {}, place: SERVICE_PLACE, ...item } as never] });
    expect(buy({ typeCode: 'TST-HEURE', durationMinutes: 500 })).toThrow(expect.objectContaining({ status: 400, code: 'DURATION_ABOVE_CAP' }));
    expect(buy({ typeCode: 'TST-EVT' })).toThrow(expect.objectContaining({ status: 400, code: 'EVENT_DATES_REQUIRED' }));
    expect(buy({ typeCode: 'TST-HEURE', requestedStart: 'demain matin' })).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_REQUESTED_START' }));
    expect(s.ctx.assessment.obligations.count()).toBe(obligations);
    // Prolongation : même contrôle avant toute obligation.
    const c = await buyAndPay(s, 'TST-HEURE', { plate: 'KN 9 P' });
    const before = s.ctx.assessment.obligations.count();
    const ext = await s.env.req('POST', `/v1/titres/${c.id}/prolongations`, 'u-contribuable', { channel: 'USSD', durationMinutes: 600 }, { 'idempotency-key': 'prolongation-plafond' });
    expect(ext.statusCode).toBe(400);
    expect(ext.json().code).toBe('DURATION_ABOVE_CAP');
    expect(s.ctx.assessment.obligations.count()).toBe(before);
  });

  it('une erreur d’émission n’interrompt pas la synchronisation et ne ré-émet jamais un titre déjà inséré', async () => {
    const s = await setup();
    defineType(s.svc, 'TST-HEURE', { model: 'DUREE_COURTE', durationMinutes: 60, maxDurationMinutes: 240 });
    const user = s.ctx.users.get('u-contribuable')!;
    const iss = s.svc.purchase(user, {
      payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY',
      items: [1, 2, 3].map((i) => ({ typeCode: 'TST-HEURE', subject: { label: `Article ${i}` }, place: SERVICE_PLACE })),
    });
    // Article 3 devenu non émissible (donnée stockée hors plafond) ; l'écouteur d'un module échoue une fois.
    s.svc.issuances.update({ ...iss, items: iss.items.map((it, i) => (i === 2 ? { ...it, durationMinutes: 999 } : it)) });
    let fail = true;
    s.svc.onIssued(() => {
      if (fail) {
        fail = false;
        throw new Error('écouteur en panne');
      }
    });
    expect((await pay(s.env, iss.payments[0]!.paymentReference)).statusCode).toBe(200);
    expect(() => s.svc.sync()).not.toThrow();
    const after = s.svc.issuance(iss.id);
    expect(after.items.map((it) => !!it.credentialId)).toEqual([true, true, false]);
    expect(after.items[2]!.issueError).toMatch(/plafond/);
    expect(after.status).toBe('PARTIELLEMENT_EMISE');
    expect(s.ctx.alerts.alerts.find((a) => a.type === 'CREDENTIAL_ISSUANCE_FAILED')).toHaveLength(1);
    s.svc.sync();
    s.svc.sync();
    expect(s.svc.credentials.count()).toBe(2);
  });
});
