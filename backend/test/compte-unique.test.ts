/**
 * Compte unique (Cahier, ch. 9 « Modèle un utilisateur, un compte » ; demande du maître d'ouvrage du 28/09/2026) —
 * test de bout en bout : UNE inscription (téléphone + code), puis la même personne déclare une parcelle et un bail,
 * revendique son logement, enregistre une entreprise, achète une session de stationnement, un ticket et un pass wewa,
 * enregistre un véhicule (contrôle technique), déclare une enseigne, paie et dépose un recours. Tout se retrouve sous
 * UN identifiant de compte dans GET /v1/compte-unique/me ; aucun module ne crée de seconde fiche « personne » ni ne
 * redemande l'identité ; une seconde inscription (même téléphone ou même NIF) est refusée et orientée vers la
 * récupération ; le mandataire ne voit que le périmètre de son mandat ; une personne sans lien reçoit 403.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import type { AccesService } from '../src/plugins/acces/service.js';
import type { RakaPayService } from '../src/plugins/rakapay/service.js';
import { RK_DEMO } from '../src/plugins/rakapay/seed.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { callbackHeaders, PROVIDER_SECRET } from './helpers.js';

/** Champs d'identité qu'aucun module ne doit redemander après l'inscription. */
const IDENTITY_KEYS = ['fullName', 'phone', 'telephone', 'nif', 'displayName', 'ownerLabel', 'nomDeclare', 'raisonSociale', 'holderName', 'name'];

async function fullApp() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const plugins = DEFAULT_PLUGINS.map((p) => (p.name === 'socle' ? createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false }, persistence: null }) as MosoloPlugin<unknown> : p));
  const app = buildApp({ clock, plugins, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const sent: { url: string; body: unknown }[] = [];
  const call = async (method: string, url: string, opts: { user?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    if (opts.token && opts.body !== undefined) sent.push({ url, body: opts.body });
    return app.inject({
      method: method as 'GET', url,
      headers: {
        ...(opts.user ? { 'x-demo-user': opts.user } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  };
  const pay = async (reference: string) => {
    const order = app.ctx.payments.byReference(reference)!;
    const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: reference, amount: order.amount, status: 'SUCCESS', completedAt: clock.now().toISOString() });
    return app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw, headers: { 'content-type': 'application/json', ...callbackHeaders(PROVIDER_SECRET, raw, clock.now()) } });
  };
  return { app, clock, call, sent, pay };
}

/** Inscription + vérification du téléphone par code + connexion par code : retourne le compte et le jeton de session. */
async function registerAndLogin(env: Awaited<ReturnType<typeof fullApp>>, phone: string, fullName: string, extra: Record<string, unknown> = {}) {
  const reg = await env.call('POST', '/v1/registrations', { body: { phone, fullName, language: 'fr', situation: 'tenant', ...extra } });
  expect(reg.statusCode, reg.body).toBe(201);
  const taxpayerId = reg.json().taxpayerId as string;
  const otp = await env.call('POST', `/v1/acces/identity/${taxpayerId}/otp`);
  expect(otp.statusCode, otp.body).toBe(201);
  const acces = env.app.ctx.ext.acces as AccesService;
  const code = /(\d{6})/.exec(acces.sandboxMessages(phone).at(-1)!.text)![1]!;
  const ok = await env.call('POST', `/v1/acces/identity/${taxpayerId}/otp/verify`, { body: { challengeId: otp.json().challengeId, code } });
  expect(ok.json().phoneVerified).toBe(true);
  const ch = (await env.call('POST', '/v1/auth/login', { body: { method: 'phone', phone } })).json();
  const login = await env.call('POST', '/v1/auth/otp', { body: { challengeId: ch.challengeId, code: ch.demoCode } });
  expect(login.statusCode, login.body).toBe(200);
  return { taxpayerId, token: login.json().accessToken as string };
}

describe('Compte unique (ch. 9) — une inscription, toutes les démarches', () => {
  it('bout en bout : tout sous UN compte, aucune seconde fiche, aucune identité redemandée, anti-doublon, mandat, 403', async () => {
    const env = await fullApp();
    const { app, call } = env;
    const tpCountBefore = app.ctx.taxpayers.taxpayers.count();
    const phone = '+243899500001';
    const { taxpayerId: tp, token } = await registerAndLogin(env, phone, 'Mwamba Kasongo (fictif, test compte unique)', { intention: 'LOCATAIRE' });
    const idem = () => ({ 'idempotency-key': randomUUID() });

    // 1. Parcelle, unité et bail (le compte est déduit de la session : aucun taxpayerId, aucune identité).
    const parcel = await call('POST', '/v1/fiscal-objects', { token, body: { category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.345, attributes: { superficie_m2: '400' } } });
    expect(parcel.statusCode, parcel.body).toBe(201);
    expect(parcel.json().taxpayerId).toBe(tp);
    const unit = await call('POST', '/v1/fiscal-objects', { token, body: { category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.345, attributes: { surface_m2: '40' }, parentObjectId: parcel.json().id } });
    const lease = await call('POST', '/v1/leases', { token, body: { unitObjectId: unit.json().id, rent: { amount: '120.00', currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-09-01' } });
    expect(lease.statusCode, lease.body).toBe(201);
    // Revendication de son logement (le choix « locataire » de l'inscription a ouvert un brouillon).
    const draft = (await call('GET', '/v1/moi/relations-biens', { token })).json();
    expect(draft.actuelles.some((c: { role: string; statut: string }) => c.role === 'TENANT' && c.statut === 'DRAFT')).toBe(true);
    const claim = await call('POST', '/v1/revendications-biens', { token, headers: idem(), body: { role: 'TENANT', address: { commune: 'Ngaliema', quartier: 'Binza', avenue: 'des Tests', number: '7', unit_label: '2' }, valid_from: '2026-01-01' } });
    expect(claim.statusCode, claim.body).toBe(201);

    // 2. Entreprise (verticale « entreprises ») : identité reprise du compte.
    const biz = await call('POST', '/v1/verticales/entreprises/cases', { token, headers: idem(), body: { type: 'DECLARATION_ACTIVITE', details: { nom: 'Atelier fictif Mwamba', activite: 'Couture', commune: 'Limete', quartier: 'Kingabwa' } } });
    expect(biz.statusCode, biz.body).toBe(201);

    // 3. Stationnement, ticket de bus et pass wewa.
    const park = await call('POST', '/v1/parking/sessions', { token, headers: idem(), body: { zoneId: PARKING_DEMO.zoneLimete, plate: 'KN-5001-CU', durationMinutes: 60 } });
    expect(park.statusCode, park.body).toBe(201);
    const ticket = await call('POST', '/v1/rakapay/tickets', { token, headers: idem(), body: { productId: 'PRD-BUS-1J', departureStationId: 'ST-KAL-VICTOIRE', channel: 'MOBILE_MONEY' } });
    expect(ticket.statusCode, ticket.body).toBe(201);
    // La moto et la fiche de conducteur sont enregistrées par le responsable : identité REPRISE du compte (ni nom, ni téléphone).
    const moto = await call('POST', '/v1/rakapay/wewa/motos', { user: RK_DEMO.managerUser, body: { plate: 'KN-M 50001', orderNumber: 'KAL-5001', make: 'TVS (test)', ownerTaxpayerId: tp, stationId: 'ST-KAL-VICTOIRE' } });
    expect(moto.statusCode, moto.body).toBe(201);
    expect(moto.json().ownerLabel).toBe(app.ctx.taxpayers.get(tp).fullName);
    const driver = await call('POST', '/v1/rakapay/wewa/conducteurs', { user: RK_DEMO.managerUser, body: { licenceNo: 'PC-KIN-TEST-5001', taxpayerId: tp, motoId: moto.json().id } });
    expect(driver.statusCode, driver.body).toBe(201);
    expect(driver.json().displayName).toBe(app.ctx.taxpayers.get(tp).fullName);
    const pass = await call('POST', '/v1/rakapay/wewa/passes', { token, headers: idem(), body: { motoId: moto.json().id, duration: 'JOUR', channel: 'MOBILE_MONEY' } });
    expect(pass.statusCode, pass.body).toBe(201);

    // 4. Véhicule et contrôle technique.
    const car = await call('POST', '/v1/fiscal-objects', { token, body: { category: 'VEHICULE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.345, attributes: { immatriculation: 'KN-5002-CU', categorie_vehicule: 'VOITURE' } } });
    expect(car.statusCode, car.body).toBe(201);
    const mine = await call('GET', '/v1/vehicules/mes-vehicules', { token });
    expect(mine.statusCode, mine.body).toBe(200);
    const v = mine.json().vehicles.find((x: { plate: string }) => x.plate.replace(/[^A-Z0-9]/g, '') === 'KN5002CU');
    expect(v?.controleTechnique).toBeDefined();

    // 5. Enseigne publicitaire.
    const sign = await call('POST', '/v1/publicite/devices', { token, body: { type: 'ENSEIGNE', widthM: '2.00', heightM: '1.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Limete', quartier: 'Kingabwa', address: 'Avenue fictive 12', localityRank: 2, lat: -4.371, lon: 15.345, photos: ['a'.repeat(64)] } });
    expect(sign.statusCode, sign.body).toBe(201);

    // 6. Paiement (session et pass) puis recours.
    const parkObl = park.json().obligation.id as string;
    const order = await call('POST', `/v1/obligations/${parkObl}/payment-orders`, { token, headers: idem(), body: { channel: 'MOBILE_MONEY' } });
    expect(order.statusCode, order.body).toBe(201);
    expect((await env.pay(order.json().paymentReference)).statusCode).toBe(200);
    for (const p of pass.json().payments as { paymentReference: string }[]) expect((await env.pay(p.paymentReference)).statusCode).toBe(200);
    const appeal = await call('POST', '/v1/appeals', { token, body: { obligationId: parkObl, type: 'INFORMATION_ERRONEE', grounds: 'Durée de stationnement contestée (test compte unique).' } });
    expect(appeal.statusCode, appeal.body).toBe(201);

    // ── Tout apparaît sous UN compte dans « Mon compte unique ».
    const cu = await call('GET', '/v1/compte-unique/me', { token });
    expect(cu.statusCode, cu.body).toBe(200);
    const view = cu.json();
    expect(view.viewer).toBe('self');
    expect(view.compte.taxpayerId).toBe(tp);
    expect(view.compte.telephone).toBe(phone);
    const els = (view.sections as { module: string; elements: { rubrique: string; id: string; nature?: string }[] }[]).flatMap((s) => s.elements.map((e) => ({ ...e, module: s.module })));
    const has = (rubrique: string, pred: (e: { id: string; nature?: string; module: string }) => boolean = () => true) => els.some((e) => e.rubrique === rubrique && pred(e));
    expect(has('OBJET', (e) => e.id === parcel.json().id)).toBe(true);
    expect(has('BAIL', (e) => e.id === lease.json().id)).toBe(true);
    expect(has('RELATION', (e) => e.id === claim.json().claimId)).toBe(true);
    expect(has('DEMARCHE', (e) => e.id === biz.json().id)).toBe(true);
    expect(has('SESSION', (e) => e.id === park.json().session.id)).toBe(true);
    expect(has('PASS', (e) => e.nature === '81')).toBe(true);
    expect(has('FICHE_METIER', (e) => e.id === driver.json().id)).toBe(true);
    expect(has('VEHICULE', (e) => e.id === car.json().id)).toBe(true);
    expect(has('TITRE', (e) => e.module === 'vehicules')).toBe(true);
    expect(has('ENSEIGNE')).toBe(true);
    expect(has('QUITTANCE')).toBe(true);
    expect(has('RECOURS', (e) => e.id === appeal.json().id)).toBe(true);
    expect(has('DOCUMENT', (e) => e.nature === 'OTP_TELEPHONE')).toBe(true);
    expect(view.identite.niveaux.find((n: { code: string }) => n.code === 'N0').atteint).toBe(true);
    expect(view.synthese.obligationsParStatutEtDevise.length).toBeGreaterThan(0);
    // Tout est au même compte : aucune section ne renvoie un autre identifiant de compte.
    expect(JSON.stringify(view.sections)).not.toMatch(/TP-DEMO-/);

    // ── Aucune seconde fiche « personne » : un seul nouveau compte, un seul utilisateur public, fiche de métier rattachée.
    expect(app.ctx.taxpayers.taxpayers.count()).toBe(tpCountBefore + 1);
    expect(app.ctx.users.all().filter((u) => u.taxpayerId === tp)).toHaveLength(1);
    const rk = app.ctx.ext.rakapay as RakaPayService;
    expect(rk.drivers.find((d) => d.taxpayerId === tp)).toHaveLength(1);
    expect(app.ctx.compteUnique.fiches().filter((f) => f.taxpayerId === tp).map((f) => f.type)).toEqual(['CONDUCTEUR_WEWA']);

    // ── Aucun module n'a redemandé l'identité : aucun corps envoyé par la personne ne contient de champ d'identité.
    const offending = env.sent.filter((s) => JSON.stringify(s.body).match(new RegExp(`"(${IDENTITY_KEYS.join('|')})"\\s*:`)));
    expect(offending.map((o) => o.url)).toEqual([]);

    // ── Seconde inscription : même téléphone ⇒ refus et récupération ; même NIF ⇒ refus et récupération.
    const dupPhone = await call('POST', '/v1/registrations', { body: { phone, fullName: 'Autre nom', language: 'fr', situation: 'tenant' } });
    expect(dupPhone.statusCode).toBe(409);
    expect(dupPhone.json()).toMatchObject({ code: 'PHONE_ALREADY_REGISTERED', recovery: '/v1/public/enrolement/recuperations' });
    const withNif = await call('POST', '/v1/registrations', { body: { phone: '+243899500002', fullName: 'Titulaire NIF (fictif)', language: 'fr', situation: 'owner_occupier', nif: 'A1234567Z' } });
    expect(withNif.statusCode).toBe(201);
    const dupNif = await call('POST', '/v1/registrations', { body: { phone: '+243899500003', fullName: 'Titulaire NIF bis', language: 'fr', situation: 'owner_occupier', nif: ' a1234567z ' } });
    expect(dupNif.statusCode).toBe(409);
    expect(dupNif.json()).toMatchObject({ code: 'NIF_ALREADY_REGISTERED', recovery: '/v1/public/enrolement/recuperations' });
    expect(app.ctx.taxpayers.taxpayers.count()).toBe(tpCountBefore + 2);

    // ── Mandataire : seulement le périmètre du mandat (objet « parcelle »), sans consentements ni notifications.
    const acces = app.ctx.ext.acces as AccesService;
    const piece = await call('POST', `/v1/acces/identity/${tp}/proofs`, { token, body: { type: 'PIECE_IDENTITE', reference: 'CE-TEST-500001' } });
    await call('POST', `/v1/acces/identity/${tp}/proofs`, { token, body: { type: 'ADRESSE', reference: 'Limete, Kingabwa (test)' } });
    await call('POST', `/v1/acces/identity-proofs/${piece.json().id}/review`, { user: 'u-guichet', body: { decision: 'VALIDEE', note: 'Pièce contrôlée (test)' } });
    expect(app.ctx.taxpayers.get(tp).verificationLevel).toBe('N1');
    acces.certifiedMandataires.add('u-mandataire');
    // Opération sensible (mandat) : second facteur validé par la personne elle-même.
    const mfa = await call('POST', '/v1/acces/mfa/challenge', { token });
    const mfaCode = /(\d{6})/.exec(acces.sandboxMessages(`app:u-tp-${tp}`).at(-1)!.text)![1]!;
    expect((await call('POST', '/v1/acces/mfa/verify', { token, body: { challengeId: mfa.json().challengeId, code: mfaCode } })).statusCode).toBe(200);
    const mdt = await call('POST', '/v1/acces/mandates', { token, body: { mandataireUserId: 'u-mandataire', kind: 'CONFIANCE', scope: ['CONSULTER'], objectIds: [parcel.json().id], validTo: '2027-09-01' } });
    expect(mdt.statusCode, mdt.body).toBe(201);
    const asMandataire = await call('GET', `/v1/compte-unique/${tp}`, { user: 'u-mandataire' });
    expect(asMandataire.statusCode, asMandataire.body).toBe(200);
    const mv = asMandataire.json();
    expect(mv.viewer).toBe('mandataire');
    const mEls = (mv.sections as { elements: { rubrique: string; objectId?: string }[] }[]).flatMap((s) => s.elements);
    expect(mEls.length).toBeGreaterThan(0);
    expect(mEls.every((e) => e.objectId === parcel.json().id)).toBe(true);
    expect(mEls.some((e) => ['CONSENTEMENT', 'NOTIFICATION', 'DOCUMENT', 'MANDAT_DONNE'].includes(e.rubrique))).toBe(false);
    expect(mv.compte.telephone).not.toBe(phone);
    // Mandat sans « CONSULTER » : 403.
    await call('POST', `/v1/acces/mandates/${mdt.json().id}/revoke`, { token, body: { motif: 'Fin du test' } });
    await call('POST', '/v1/acces/mandates', { token, body: { mandataireUserId: 'u-mandataire', kind: 'CONFIANCE', scope: ['PAYER'], validTo: '2027-09-01' } });
    expect((await call('GET', `/v1/compte-unique/${tp}`, { user: 'u-mandataire' })).statusCode).toBe(403);

    // ── Personne sans lien : 403 ; agent sans consultation motivée : 403 ; avec consultation motivée : 200.
    expect((await call('GET', `/v1/compte-unique/${tp}`, { user: 'u-locataire' })).statusCode).toBe(403);
    expect((await call('GET', `/v1/compte-unique/${tp}`, { user: 'u-controleur' })).json().code).toBe('CONSULTATION_MOTIVEE_REQUISE');
    const csl = await call('POST', '/v1/acces/consultations', { user: 'u-controleur', body: { taxpayerId: tp, purpose: 'CONTROLE', motif: 'Contrôle de cohérence (test)' } });
    expect(csl.statusCode, csl.body).toBe(201);
    const asAgent = await call('GET', `/v1/compte-unique/${tp}?consultation=${csl.json().id}`, { user: 'u-controleur' });
    expect(asAgent.statusCode, asAgent.body).toBe(200);
    expect(asAgent.json().viewer).toBe('agent');
    expect(app.ctx.audit.list({ action: 'compte_unique.viewed', limit: 50 }).items.some((r) => r.details.viewer === 'agent' && r.details.consultationId === csl.json().id)).toBe(true);
    await app.close();
  });

  it('organisation : la personne connectée se désigne représentante sans ressaisir son identité ; même NIF ou RCCM refusé', async () => {
    const env = await fullApp();
    const { taxpayerId: tp, token } = await registerAndLogin(env, '+243899500010', 'Kalala Ntumba (fictive, test)');
    const org = await env.call('POST', '/v1/acces/organisations', { token, body: { raisonSociale: 'Société fictive Compte Unique SARL', forme: 'SARL', rccm: 'CD/KIN/RCCM/TEST-CU-1', nif: 'B7654321X', phone: '+243899500011', language: 'fr', moiCommeRepresentant: { fonction: 'Gérante', habilitation: 'DIRIGEANT' } } });
    expect(org.statusCode, org.body).toBe(201);
    const view = (await env.call('GET', '/v1/compte-unique/me', { token })).json();
    expect(view.identite.representeAupres[0]).toMatchObject({ raisonSociale: 'Société fictive Compte Unique SARL', fonction: 'Gérante', habilitation: 'DIRIGEANT' });
    expect((view.sections as { elements: { rubrique: string }[] }[]).flatMap((s) => s.elements).some((e) => e.rubrique === 'ROLE')).toBe(true);
    // Le représentant n'accède pas pour autant aux données de l'organisation : l'accès passe par un mandat.
    expect((await env.call('GET', `/v1/compte-unique/${org.json().taxpayerId}`, { token })).statusCode).toBe(403);
    const again = await env.call('POST', '/v1/acces/organisations', { body: { raisonSociale: 'Doublon SARL', forme: 'SARL', nif: 'b7654321x', phone: '+243899500012', language: 'fr', representatives: [{ fullName: 'Quelqu’un', fonction: 'Gérant', habilitation: 'DIRIGEANT' }], declarant: { fullName: 'Quelqu’un', fonction: 'Gérant' } } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('NIF_ALREADY_REGISTERED');
    const againRccm = await env.call('POST', '/v1/acces/organisations', { body: { raisonSociale: 'Doublon 2 SARL', forme: 'SARL', rccm: 'cd/kin/rccm/test-cu-1', phone: '+243899500013', language: 'fr', representatives: [{ fullName: 'Quelqu’un', fonction: 'Gérant', habilitation: 'DIRIGEANT' }], declarant: { fullName: 'Quelqu’un', fonction: 'Gérant' } } });
    expect(againRccm.json().code).toBe('RCCM_ALREADY_REGISTERED');
    expect(tp).toMatch(/^TP-/);
    await env.app.close();
  });

  it('fiche de métier : un conducteur enregistré par sa coopérative avec un téléphone est rattaché au compte quand ce téléphone est vérifié par code — jamais sur le nom', async () => {
    const env = await fullApp();
    const rk = env.app.ctx.ext.rakapay as RakaPayService;
    const phone = '+243899500020';
    const m = await env.call('POST', '/v1/rakapay/wewa/motos', { user: RK_DEMO.managerUser, body: { plate: 'KN-M 50020', orderNumber: 'KAL-5020', make: 'Bajaj (test)', ownerLabel: 'Propriétaire fictif', stationId: 'ST-KAL-VICTOIRE' } });
    const d = await env.call('POST', '/v1/rakapay/wewa/conducteurs', { user: RK_DEMO.managerUser, body: { displayName: 'Tshala M.', licenceNo: 'PC-KIN-TEST-5020', phone, motoId: m.json().id } });
    expect(d.statusCode, d.body).toBe(201);
    expect(rk.drivers.get(d.json().id)!.taxpayerId).toBeUndefined();
    // Homonyme sans lien de téléphone : jamais rattaché.
    await registerAndLogin(env, '+243899500021', 'Tshala M.');
    expect(rk.drivers.get(d.json().id)!.taxpayerId).toBeUndefined();
    const { taxpayerId } = await registerAndLogin(env, phone, 'Tshala Mbuyi (fictive)');
    expect(rk.drivers.get(d.json().id)!.taxpayerId).toBe(taxpayerId);
    expect(env.app.ctx.audit.list({ action: 'rakapay.driver.linked_to_account', limit: 10 }).items.some((r) => r.resourceId === d.json().id && r.details.basis === 'TELEPHONE_VERIFIE_PAR_CODE')).toBe(true);
    // Contrôle des fiches de métier : réservé au guichet, à l'audit et à l'administration.
    expect((await env.call('GET', '/v1/compte-unique/fiches-metier', { user: 'u-locataire' })).statusCode).toBe(403);
    const f = (await env.call('GET', '/v1/compte-unique/fiches-metier', { user: 'u-guichet' })).json();
    expect(f.total).toBeGreaterThan(0);
    expect(f.regle).toMatch(/jamais/);
    await env.app.close();
  });

  it('canaux : l’USSD d’un numéro connu sert le même compte (aucune création) ; compte fusionné ⇒ compte conservé', async () => {
    const env = await fullApp();
    const t = env.app.ctx.taxpayers;
    const a = t.register({ phone: '+243899500030', fullName: 'Compte conservé (test)', language: 'fr', situation: 'other' });
    const b = t.register({ phone: '+243899500031', fullName: 'Compte absorbé (test)', language: 'fr', situation: 'other' });
    t.setMergeState(b.id, a.id);
    expect(t.resolve(b.id).id).toBe(a.id);
    expect(t.findByPhone('+243 899 500 031')!.id).toBe(a.id);
    const before = t.taxpayers.count();
    const s = await env.call('POST', '/v1/ussd/sessions', { body: { msisdn: '+243899500030' } });
    expect(s.statusCode, s.body).toBe(201);
    // Numéro du compte absorbé : la session sert le compte conservé (jamais une nouvelle inscription).
    const s2 = await env.call('POST', '/v1/ussd/sessions', { body: { msisdn: '+243899500031' } });
    expect(s2.statusCode, s2.body).toBe(201);
    expect(JSON.stringify(s2.json())).not.toMatch(/Créer votre compte/);
    expect(t.taxpayers.count()).toBe(before);
    await env.app.close();
  });
});
