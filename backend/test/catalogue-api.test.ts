/**
 * Catalogue des API (Cahier, chapitre 31) : les 20 routes françaises relaient les routes canoniques existantes,
 * avec les mêmes contrôles (accès, idempotence, signature, audit). Application complète, données de démonstration.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { hmacSha256Hex } from '../src/core/crypto.js';
import { CATALOGUE_API } from '../src/plugins/catalogue-api/catalogue.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { callbackBody, callbackHeaders, DEMO, PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function full(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
  return { app, clock, req };
}

const demoObligation = (env: TestEnv) => env.app.ctx.assessment.obligations.find((o) => o.objectId === DEMO.parcelId && !o.supersededBy)[0]!;

async function outbox(env: TestEnv, to: string): Promise<{ text: string }[]> {
  return (await env.req('GET', `/v1/acces/sandbox/outbox?to=${encodeURIComponent(to)}`)).json().items;
}

/** Ordre de paiement par la route française puis confirmation signée par la route française. */
async function payViaFrench(env: TestEnv) {
  const ob = demoObligation(env);
  const order = await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  expect(order.statusCode).toBe(201);
  const raw = JSON.stringify(callbackBody(env, order.json().paymentReference, ob.amount));
  const cb = await env.req('POST', '/v1/paiements/callback', undefined, raw, { 'x-provider': 'mm-operator-a', ...callbackHeaders(PROVIDER_SECRET, raw, env.clock.now(), { nonce: randomUUID() }) });
  return { ob, order: order.json(), cb };
}

describe('Catalogue des API — table et enregistrement', () => {
  it('GET /v1/catalogue-api : 20 lignes du Cahier, chaque route française existe réellement', async () => {
    const env = await full();
    const r = await env.req('GET', '/v1/catalogue-api');
    expect(r.statusCode).toBe(200);
    const rows = r.json().routes as { numero: number; methode: string; routeFr: string; objet: string; acteurAutorise: string; controles: string; routeCanonique: string }[];
    expect(rows).toHaveLength(20);
    expect(rows.map((x) => x.numero)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const row of rows) {
      for (const k of ['objet', 'acteurAutorise', 'controles', 'routeCanonique'] as const) expect(row[k], `${row.routeFr} ${k}`).toBeTruthy();
      expect(env.app.hasRoute({ method: row.methode as 'GET', url: row.routeFr }), row.routeFr).toBe(true);
    }
    expect(rows.find((x) => x.routeFr === '/v1/comptes')).toMatchObject({ methode: 'POST', objet: 'Créer un compte', acteurAutorise: 'Public', controles: 'Vérification téléphone, anti-doublon, journal' });
    expect(CATALOGUE_API.find((x) => x.routeFr === '/v1/tableaux/:profil')!.routeCanonique).toContain('/v1/pilotage/tableaux/:profil');
    // Les routes canoniques restent disponibles (règle n° 1 : rien n'est retiré).
    for (const [m, u] of [['POST', '/v1/registrations'], ['POST', '/v1/fiscal-objects'], ['POST', '/v1/leases'], ['GET', '/v1/obligations'], ['POST', '/v1/assessments/calculate'],
      ['POST', '/v1/legal-rules'], ['POST', '/v1/legal-rules/:id/approve'], ['POST', '/v1/obligations/:id/payment-orders'], ['POST', '/v1/providers/:provider/callbacks'],
      ['POST', '/v1/settlements/statements'], ['GET', '/v1/reconciliation/exceptions'], ['GET', '/v1/public/receipts/:code'], ['POST', '/v1/field-sync/batches'],
      ['POST', '/v1/terrain/missions/:id/findings'], ['POST', '/v1/appeals'], ['GET', '/v1/integrite/alerts'], ['GET', '/v1/pilotage/scenarios'], ['POST', '/v1/pilotage/projets/recommandations']] as const) {
      expect(env.app.hasRoute({ method: m, url: u }), `${m} ${u}`).toBe(true);
    }
  });
});

describe('Catalogue des API — compte, identité, objets, baux, obligations', () => {
  it('POST /v1/comptes : inscription publique ; anti-doublon du téléphone ; journal corrélé par X-Request-Id', async () => {
    const env = await full();
    const body = { phone: '+243899777001', fullName: 'Compte Catalogue', language: 'fr', situation: 'tenant' };
    const r = await env.req('POST', '/v1/comptes', undefined, body, { 'x-request-id': 'req-catalogue-0001' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ verificationLevel: 'N0' });
    expect(r.headers['x-request-id']).toBe('req-catalogue-0001');
    expect(r.headers['x-mosolo-route-canonique']).toBe('POST /v1/registrations');
    expect(env.app.ctx.audit.list({ correlationId: 'req-catalogue-0001', limit: 50 }).items.length).toBeGreaterThan(0);
    // Même téléphone : refus de la route canonique, à l'identique.
    const dup = await env.req('POST', '/v1/comptes', undefined, body);
    const canon = await env.req('POST', '/v1/registrations', undefined, body);
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
    expect(dup.statusCode).toBe(canon.statusCode);
    expect(dup.json().code).toBe(canon.json().code);
    // Validation stricte conservée (aucun rôle ne peut être demandé à l'inscription).
    expect((await env.req('POST', '/v1/comptes', undefined, { ...body, phone: '+243899777002', roles: ['R17'] })).statusCode).toBe(400);
  });

  it('POST /v1/identites/verification : code SMS, pièces, contrôle par une personne distincte (double validation)', async () => {
    const env = await full();
    const tp = DEMO.tenantTaxpayerId;
    const piece = await env.req('POST', '/v1/identites/verification', 'u-locataire', { etape: 'PIECE', taxpayerId: tp, type: 'PIECE_IDENTITE', reference: 'PASSEPORT-CAT1234' });
    expect(piece.statusCode).toBe(201);
    await env.req('POST', '/v1/identites/verification', 'u-locataire', { etape: 'PIECE', taxpayerId: tp, type: 'ADRESSE', reference: 'Limete, Kingabwa, avenue fictive 12' });
    // Contribuable sur le dossier d'un autre : refusé.
    expect((await env.req('POST', '/v1/identites/verification', 'u-locataire', { etape: 'PIECE', taxpayerId: DEMO.taxpayerId, type: 'NIF', reference: 'XXXXX' })).statusCode).toBe(403);
    const rev = await env.req('POST', '/v1/identites/verification', 'u-guichet', { etape: 'CONTROLE', proofId: piece.json().id, decision: 'VALIDEE', note: 'Pièce contrôlée au guichet' });
    expect(rev.statusCode).toBe(200);
    const sent = await env.req('POST', '/v1/identites/verification', undefined, { etape: 'ENVOI_CODE', taxpayerId: tp });
    expect(sent.statusCode).toBe(201);
    const code = /(\d{6})/.exec((await outbox(env, '+243820000002'))[0]!.text)![1]!;
    const ok = await env.req('POST', '/v1/identites/verification', undefined, { etape: 'VERIFICATION_CODE', taxpayerId: tp, challengeId: sent.json().challengeId, code });
    expect(ok.json().verificationLevel).toBe('N1');
    // Pièce saisie puis contrôlée par la même personne : refus (séparation des tâches, exigée jusqu'à N3).
    const own = await env.req('POST', '/v1/identites/verification', 'u-guichet', { etape: 'PIECE', taxpayerId: tp, type: 'NIF', reference: 'A7654321T' });
    expect(own.statusCode).toBe(201);
    const self = await env.req('POST', '/v1/identites/verification', 'u-guichet', { etape: 'CONTROLE', proofId: own.json().id, decision: 'VALIDEE', note: 'auto-contrôle' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    // Contrôle réservé aux rôles habilités.
    expect((await env.req('POST', '/v1/identites/verification', 'u-locataire', { etape: 'CONTROLE', proofId: own.json().id, decision: 'VALIDEE', note: 'je me valide' })).statusCode).toBe(403);
    // Étape inconnue : 400.
    expect((await env.req('POST', '/v1/identites/verification', 'u-guichet', { etape: 'AUTRE', taxpayerId: tp })).statusCode).toBe(400);
  });

  it('POST /v1/objets et /v1/baux ; GET /v1/objets/:id/obligations filtré par rôle et territoire', async () => {
    const env = await full();
    const obj = await env.req('POST', '/v1/objets', 'u-contribuable', { category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.37, lon: 15.34, attributes: { surface_m2: '40' } });
    expect(obj.statusCode).toBe(201);
    expect(obj.headers['x-mosolo-route-canonique']).toBe('POST /v1/fiscal-objects');
    expect((await env.req('POST', '/v1/objets', 'u-contribuable', { category: 'PARCELLE', commune: 'Paris', quartier: 'x', localityRank: 1, lat: -4.3, lon: 15.3 })).json().code).toBe('UNKNOWN_COMMUNE');
    expect((await env.req('POST', '/v1/objets', 'u-agent-gombe', { taxpayerId: DEMO.taxpayerId, category: 'PARCELLE', commune: 'Limete', quartier: 'x', localityRank: 1, lat: -4.3, lon: 15.3 })).statusCode).toBe(403);
    const lease = await env.req('POST', '/v1/baux', 'u-locataire', { unitObjectId: obj.json().id, lessorId: DEMO.taxpayerId, rent: { amount: '120.00', currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-09-01' });
    expect(lease.statusCode).toBe(201);
    expect(lease.json()).toMatchObject({ lesseeId: DEMO.tenantTaxpayerId, declaredByRole: 'LOCATAIRE' });

    const ob = demoObligation(env);
    const mine = await env.req('GET', `/v1/objets/${DEMO.parcelId}/obligations`, 'u-contribuable');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().length).toBeGreaterThan(0);
    expect(mine.json().every((o: { objectId?: string; id: string }) => env.app.ctx.assessment.get(o.id).objectId === DEMO.parcelId)).toBe(true);
    expect(mine.json().map((o: { id: string }) => o.id)).toContain(ob.id);
    // Autre contribuable : refus explicite.
    expect((await env.req('GET', `/v1/objets/${DEMO.parcelId}/obligations`, 'u-locataire')).statusCode).toBe(403);
    // Agent hors territoire : refus ; agent du territoire : accès minimal (sans montant).
    expect((await env.req('GET', `/v1/objets/${DEMO.parcelId}/obligations`, 'u-agent-gombe')).statusCode).toBe(403);
    const agent = await env.req('GET', `/v1/objets/${DEMO.parcelId}/obligations`, 'u-agent-terrain');
    expect(agent.statusCode).toBe(200);
    expect(agent.json().every((o: { amount: unknown }) => o.amount === null)).toBe(true);
    // Rôle d'agrégats seulement : refus.
    expect((await env.req('GET', `/v1/objets/${DEMO.parcelId}/obligations`, 'u-gouverneur')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/objets/OBJ-INCONNU/obligations', 'u-controleur')).statusCode).toBe(404);
    // Le filtre objectId est aussi disponible sur la route canonique, sans changer son comportement par défaut.
    const canon = await env.req('GET', `/v1/obligations?objectId=${DEMO.parcelId}`, 'u-contribuable');
    expect(canon.json()).toEqual(mine.json());
    expect((await env.req('GET', '/v1/obligations', 'u-contribuable')).json().length).toBeGreaterThanOrEqual(mine.json().length);
  });
});

describe('Catalogue des API — règles et simulation', () => {
  it('POST /v1/regles puis /v1/regles/:id/publication : quatre personnes distinctes, même personne refusée', async () => {
    const env = await full();
    const create = await env.req('POST', '/v1/regles', 'u-juriste-redacteur', {
      code: 'TEST-CAT-01', revenueCategory: 'IMPOT_PROVINCIAL', label: 'Test catalogue — impôt foncier',
      legalInstrumentIds: ['demo-instrument-001'], articles: ['Art. 1 (fictif)'], competentAuthority: 'Ministère provincial des Finances',
      administeringEntity: 'DGIPK', taxableEvent: 'Propriété', liableParty: 'Propriétaire', baseDefinition: 'Superficie en m²',
      formula: 'superficie_m2 * tarif_m2', rateTable: { 'tarif_m2:1': '3.5', 'tarif_m2:2': '2.5', 'tarif_m2:3': '2', 'tarif_m2:4': '1.5' },
      currency: 'USD', rounding: 'HALF_UP', periodicity: 'ANNUELLE', dueRule: '30 jours', effectiveFrom: '2026-01-01',
      beneficiaryAccountAlias: DEMO.dgipkAlias, appealPath: 'Réclamation DGIPK', sourceVerification: 'OFFICIEL_CERTIFIE',
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;
    // Un rôle non juriste ne peut pas proposer de règle.
    expect((await env.req('POST', '/v1/regles', 'u-contribuable', { code: 'X' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await env.req('POST', '/v1/regles', 'u-tresor', create.json())).statusCode).toBe(403);
    // Texte légal obligatoire : aucun instrument ⇒ refus.
    expect((await env.req('POST', '/v1/regles', 'u-juriste-redacteur', { code: 'TEST-CAT-02', legalInstrumentIds: [] })).statusCode).toBe(400);

    const r1 = await env.req('POST', `/v1/regles/${id}/publication`, 'u-juriste-redacteur', { role: 'REDACTEUR' });
    expect(r1.statusCode).toBe(200);
    // La même personne ne peut pas viser une seconde fois (créer, valider et publier) : refus.
    const same = await env.req('POST', `/v1/regles/${id}/publication`, 'u-juriste-redacteur', { role: 'VERIFICATEUR_JURIDIQUE' });
    expect(same.statusCode).toBe(403);
    // Simulation du catalogue : règle non publiée refusée, aucune obligation.
    const before = env.app.ctx.assessment.obligations.count();
    const notPub = await env.req('POST', '/v1/liquidations/simulation', 'u-controleur', { ruleId: id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '100' } });
    expect(notPub.statusCode).toBe(422);
    expect(notPub.json().code).toBe('RULE_NOT_PUBLISHED');
    for (const [u, role] of [['u-juriste-verificateur', 'VERIFICATEUR_JURIDIQUE'], ['u-validateur-financier', 'VALIDATEUR_FINANCIER'], ['u-autorite-publication', 'AUTORITE_PUBLICATION']] as const) {
      expect((await env.req('POST', `/v1/regles/${id}/publication`, u, { role })).statusCode, role).toBe(200);
    }
    expect(env.app.ctx.rules.rules.get(id)!.status).toBe('ACTIVE');
    const sim = await env.req('POST', '/v1/liquidations/simulation', 'u-controleur', { ruleId: id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '100' } });
    expect(sim.statusCode).toBe(200);
    expect(sim.json().obligation).toBeNull();
    expect(sim.json().trace).toMatchObject({ simulate: true, nonOpposable: true, ruleStatus: 'ACTIVE' });
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
    expect(notPub.statusCode).toBe(422);
  });

  it('POST /v1/liquidations/simulation : jamais d’obligation (simulate:false refusé), rôle non habilité refusé', async () => {
    const env = await full();
    const ob = demoObligation(env);
    const before = env.app.ctx.assessment.obligations.count();
    const body = { ruleId: ob.ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {} };
    const sim = await env.req('POST', '/v1/liquidations/simulation', 'u-controleur', body);
    expect(sim.statusCode).toBe(200);
    expect(sim.json().obligation).toBeNull();
    expect(sim.json().trace.simulate).toBe(true);
    expect((await env.req('POST', '/v1/liquidations/simulation', 'u-controleur', { ...body, simulate: false })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/liquidations/simulation', 'u-agent-terrain', body)).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/liquidations/simulation', undefined, body)).statusCode).toBe(401);
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
    expect(env.app.ctx.audit.list({ action: 'assessment.simulated', limit: 5 }).items.length).toBeGreaterThan(0);
  });
});

describe('Catalogue des API — paiement, confirmation, règlement, rapprochement, quittance', () => {
  it('POST /v1/paiements/ordres : idempotence (rejeu ⇒ même ordre), clé obligatoire, contribuable seulement', async () => {
    const env = await full();
    const ob = demoObligation(env);
    const key = randomUUID();
    const a = await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'MOBILE_MONEY' }, { 'idempotency-key': key });
    expect(a.statusCode).toBe(201);
    expect(a.json().paymentReference).toBeTruthy();
    expect(a.json().expiresAt).toBeTruthy();
    const b = await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'MOBILE_MONEY' }, { 'idempotency-key': key });
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    // Même clé, contenu différent : 409 (idempotence de la route canonique).
    expect((await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'CARD' }, { 'idempotency-key': key })).statusCode).toBe(409);
    // Sans clé : refus ; sans obligation : 400 ; montant fourni par le client : refusé (schéma strict).
    expect((await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'MOBILE_MONEY' })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'MOBILE_MONEY', amount: { amount: '1.00', currency: 'USD' } }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    // Autre contribuable : refusé.
    expect((await env.req('POST', '/v1/paiements/ordres', 'u-locataire', { obligationId: ob.id, channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: '../../v1/registrations', channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
  });

  it('POST /v1/paiements/callback : prestataire dans le corps, signature vérifiée sur le corps brut, anti-rejeu', async () => {
    const env = await full();
    const ob = demoObligation(env);
    const order = (await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    // Prestataire dans le corps (champ « provider », couvert par la signature ; ignoré par le schéma du rappel).
    const signedRaw = JSON.stringify({ ...callbackBody(env, order.paymentReference, ob.amount), provider: 'mm-operator-a' });
    const cb = await env.req('POST', '/v1/paiements/callback', undefined, signedRaw, callbackHeaders(PROVIDER_SECRET, signedRaw, env.clock.now(), { nonce: randomUUID() }));
    expect(cb.statusCode, cb.body).toBe(200);
    expect(cb.json()).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    expect(cb.headers['x-mosolo-route-canonique']).toBe('POST /v1/providers/mm-operator-a/callbacks');
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONFIRME');
    // Rejeu du même nonce : refusé (409).
    const raw = JSON.stringify(callbackBody(env, order.paymentReference, ob.amount));
    const h = callbackHeaders(PROVIDER_SECRET, raw, env.clock.now(), { nonce: 'nonce-catalogue-001' });
    await env.req('POST', '/v1/paiements/callback', undefined, raw, { 'x-provider': 'mm-operator-a', ...h });
    const replay = await env.req('POST', '/v1/paiements/callback', undefined, raw, { 'x-provider': 'mm-operator-a', ...h });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe('NONCE_REPLAYED');
    // Signature invalide : 401 ; corps altéré d'un seul octet après signature : 401.
    const bad = await env.req('POST', '/v1/paiements/callback', undefined, raw, { 'x-provider': 'mm-operator-a', ...callbackHeaders('mauvais-secret', raw, env.clock.now(), { nonce: randomUUID() }) });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('INVALID_SIGNATURE');
    const h2 = callbackHeaders(PROVIDER_SECRET, raw, env.clock.now(), { nonce: randomUUID() });
    const altered = await env.req('POST', '/v1/paiements/callback', undefined, raw.replace('"SUCCESS"', ' "SUCCESS"'), { 'x-provider': 'mm-operator-a', ...h2 });
    expect(altered.statusCode).toBe(401);
    // Prestataire absent ou mal formé : 400 ; inconnu : 404 (route canonique).
    expect((await env.req('POST', '/v1/paiements/callback', undefined, raw, h2)).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/paiements/callback', undefined, raw, { 'x-provider': '../registrations', ...h2 })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/paiements/callback', undefined, raw, { 'x-provider': 'inconnu-xyz', ...h2 })).statusCode).toBe(404);
  });

  it('POST /v1/reglements/import, GET /v1/rapprochements/exceptions, GET /v1/quittances/:ref/verification', async () => {
    const env = await full();
    const { ob, order, cb } = await payViaFrench(env);
    const receiptCode = cb.json().receiptCode as string;
    const pending = await env.req('GET', `/v1/quittances/${receiptCode}/verification`);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ status: 'PENDING' });
    // Divulgation minimale : identique à la route publique canonique, sans nom ni téléphone.
    const canon = await env.req('GET', `/v1/public/receipts/${receiptCode}`);
    expect(pending.json()).toEqual(canon.json());
    const text = JSON.stringify(pending.json());
    expect(text).not.toContain('Mbuyi');
    expect(text).not.toContain('+243');
    const unknownFr = await env.req('GET', '/v1/quittances/CODE-INCONNU/verification');
    const unknownCanon = await env.req('GET', '/v1/public/receipts/CODE-INCONNU');
    expect(unknownFr.statusCode).toBe(unknownCanon.statusCode);
    expect(unknownFr.json()).toEqual(unknownCanon.json());
    // Accès public : aucune authentification requise ; identifiant hors format refusé avant relais.
    expect((await env.req('GET', `/v1/quittances/${encodeURIComponent('a/b')}/verification`)).statusCode).toBe(400);

    const statement = { statementId: 'REL-CAT-0001', lines: [{ accountAlias: DEMO.dgipkAlias, amount: ob.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }] };
    expect((await env.req('POST', '/v1/reglements/import', 'u-contribuable', statement)).statusCode).toBe(403);
    const st = await env.req('POST', '/v1/reglements/import', 'u-tresor', statement);
    expect(st.statusCode).toBe(201);
    expect(st.json().matched).toHaveLength(1);
    // Relevé rejoué : idempotent (200), aucun double effet.
    expect((await env.req('POST', '/v1/reglements/import', 'u-tresor', statement)).statusCode).toBe(200);
    expect((await env.req('GET', `/v1/quittances/${receiptCode}/verification`)).json()).toMatchObject({ status: 'VALID' });

    // Ligne inconnue ⇒ exception visible dans la file (lecture seule, rôles du Trésor et du contrôle).
    await env.req('POST', '/v1/reglements/import', 'u-tresor', { statementId: 'REL-CAT-0002', lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '7.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-INCONNUE' }] });
    const ex = await env.req('GET', '/v1/rapprochements/exceptions', 'u-analyste-rappro');
    expect(ex.statusCode).toBe(200);
    expect(ex.json()).toEqual((await env.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json());
    expect(JSON.stringify(ex.json())).toContain('PR-INCONNUE');
    expect((await env.req('GET', '/v1/rapprochements/exceptions', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/rapprochements/exceptions')).statusCode).toBe(401);
  });
});

describe('Catalogue des API — terrain, recours, alertes, pilotage', () => {
  it('POST /v1/missions/synchronisation : lot signé par le terminal (corps brut), signature invalide refusée', async () => {
    const env = await full();
    const raw = JSON.stringify({ batchId: 'LOT-CAT-01', deviceId: 'dev-terrain-001', createdAt: env.clock.now().toISOString(), operations: [{ opId: 'cat1', objectId: DEMO.unitId, field: 'surface_m2', value: '90', observedAt: env.clock.now().toISOString() }] });
    const ok = await env.req('POST', '/v1/missions/synchronisation', 'u-agent-terrain', raw, { 'x-device-signature': hmacSha256Hex('demo-device-key-001', raw) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accepted).toEqual(['cat1']);
    const forged = await env.req('POST', '/v1/missions/synchronisation', 'u-agent-terrain', raw.replace('cat1', 'cat2'), { 'x-device-signature': hmacSha256Hex('demo-device-key-001', raw) });
    expect(forged.json().code).toBe('INVALID_DEVICE_SIGNATURE');
    expect((await env.req('POST', '/v1/missions/synchronisation', 'u-contribuable', '{}')).statusCode).toBe(403);
  });

  it('POST /v1/constats : GPS, photo, horodatage ; rejeu idempotent ; contribuable refusé', async () => {
    const env = await full();
    const obj = env.app.ctx.objects.objects.get(DEMO.unitId)!;
    const finding = { missionId: 'MIS-LIM-014', clientRef: 'cat-constat-1', objectId: obj.id, outcome: 'CONSTATE', observations: 'Occupé', gps: { lat: obj.lat, lon: obj.lon, accuracyM: 6 }, photoSha256: 'a'.repeat(64), capturedAt: env.clock.now().toISOString(), deviceId: 'dev-terrain-001' };
    const r = await env.req('POST', '/v1/constats', 'u-agent-terrain', finding);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().finding.seal).toMatch(/^[a-f0-9]{64}$/);
    const replay = await env.req('POST', '/v1/constats', 'u-agent-terrain', finding);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, finding: { id: r.json().finding.id } });
    expect((await env.req('POST', '/v1/constats', 'u-agent-terrain', { ...finding, observations: 'Autre' })).statusCode).toBe(409);
    expect((await env.req('POST', '/v1/constats', 'u-contribuable', { ...finding, clientRef: 'cat-2' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/constats', 'u-agent-terrain', { ...finding, missionId: undefined, clientRef: 'cat-3' })).statusCode).toBe(400);
  });

  it('POST /v1/recours : contestation du contribuable, accusé de réception ; tiers refusé', async () => {
    const env = await full();
    const ob = demoObligation(env);
    const r = await env.req('POST', '/v1/recours', 'u-contribuable', { obligationId: ob.id, grounds: 'Surface contestée (test du catalogue).' });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBeTruthy();
    expect((await env.req('POST', '/v1/recours', 'u-locataire', { obligationId: ob.id, grounds: 'Je conteste pour autrui (test).' })).statusCode).toBe(403);
  });

  it('GET /v1/alertes-fraude : enquêteur et audit en lecture seule, aucune action automatique ; autres rôles refusés', async () => {
    const env = await full();
    const r = await env.req('GET', '/v1/alertes-fraude', 'u-enqueteur');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual((await env.req('GET', '/v1/integrite/alerts', 'u-enqueteur')).json());
    for (const a of r.json() as { automaticEffect?: string }[]) if (a.automaticEffect !== undefined) expect(a.automaticEffect).toMatch(/AUCUN/i);
    expect((await env.req('GET', '/v1/alertes-fraude', 'u-auditeur')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/alertes-fraude?source=securite', 'u-auditeur')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/alertes-fraude', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/alertes-fraude', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/alertes-fraude?source=autre', 'u-enqueteur')).statusCode).toBe(400);
    // Lecture sans effet : aucune alerte ne change d'état.
    const again = await env.req('GET', '/v1/alertes-fraude', 'u-enqueteur');
    expect(again.json()).toEqual(r.json());
  });

  it('GET /v1/tableaux/:profil, GET /v1/previsions (hypothèses jointes), POST /v1/affectations/scenarios (aucune dépense)', async () => {
    const env = await full();
    expect((await env.req('GET', '/v1/tableaux/gouverneur', 'u-gouverneur')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/tableaux/juridique', 'u-tresor')).statusCode).toBe(403);
    const prev = await env.req('GET', '/v1/previsions', 'u-gouverneur');
    expect(prev.statusCode).toBe(200);
    expect(prev.json()).toEqual((await env.req('GET', '/v1/pilotage/scenarios', 'u-gouverneur')).json());
    expect(JSON.stringify(prev.json()).toLowerCase()).toContain('hypoth');
    expect((await env.req('GET', '/v1/previsions', 'u-contribuable')).statusCode).toBe(403);

    const ledger = env.app.ctx.ledger.balance();
    const proj = await env.req('POST', '/v1/pilotage/projets', 'u-ministre-finances', {
      code: 'CAT-ECL-01', title: 'Éclairage public avenue catalogue (fictif)', domain: 'ECLAIRAGE', communes: ['Limete'], beneficiaries: 'Riverains et usagers de l’avenue',
      expectedResult: 'Avenue éclairée la nuit', maturity: 'PRET_A_LANCER', cost: { amount: '100.00', currency: 'USD' }, recurringCost: { amount: '5.00', currency: 'USD' },
      procurement: 'APPEL_OFFRES_OUVERT', risks: 'Retard de passation', approvalAuthority: 'Ministre provincial des Finances', legalFundSource: 'Budget provincial voté 2026 (fictif)',
    });
    expect(proj.statusCode).toBe(201);
    const rec = await env.req('POST', '/v1/affectations/scenarios', 'u-ministre-finances', { period: '2026-T3', currency: 'USD', legalFundSource: 'Recettes propres rapprochées (fictif)' });
    expect(rec.statusCode, rec.body).toBe(201);
    // Scénarios PROPOSÉS par l'IA ; la décision appartient à l'autorité ; aucune dépense exécutée.
    expect(rec.json().scenarios).toHaveLength(3);
    expect(rec.json().scenarios.every((sc: { status: string; proposedBy: { kind: string } }) => sc.status === 'PROPOSE' && sc.proposedBy.kind === 'ai')).toBe(true);
    expect(env.app.ctx.audit.list({ action: 'pilotage.fund_scenario.proposed', limit: 5 }).items.length).toBeGreaterThan(0);
    expect(env.app.ctx.ledger.balance()).toEqual(ledger);
    expect((await env.req('POST', '/v1/affectations/scenarios', 'u-contribuable', { period: '2026-T3', currency: 'USD', legalFundSource: 'Tentative non habilitée' })).statusCode).toBe(403);
  });
});

describe('Catalogue des API — relais sans double comptage', () => {
  it('limitation de débit : une requête française compte une seule fois, au palier de la route canonique', async () => {
    const socle = createSoclePlugin({
      persistence: null,
      rateLimit: { enabled: true, global: { limit: 4, windowMs: 60_000 }, public: { limit: 2, windowMs: 60_000 }, auth: { limit: 10, windowMs: 60_000 }, exempt: ['/health'] },
    });
    const app = buildApp({
      clock: new ManualClock('2026-09-26T09:00:00.000Z'),
      secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
      plugins: [...DEFAULT_PLUGINS.filter((p) => p.name !== 'socle'), socle],
    });
    await app.ready();
    const get = (url: string, user?: string) => app.inject({ method: 'GET', url, headers: user ? { 'x-demo-user': user } : {} });
    // Palier global (4) : quatre lectures françaises passent (une seule unité chacune), la cinquième est limitée.
    for (let i = 0; i < 4; i++) expect((await get('/v1/rapprochements/exceptions', 'u-analyste-rappro')).statusCode, `appel ${i + 1}`).toBe(200);
    const limited = await get('/v1/rapprochements/exceptions', 'u-analyste-rappro');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    // Palier public (2) de la vérification de quittance : appliqué via la route canonique.
    for (let i = 0; i < 2; i++) expect((await get('/v1/quittances/CODE-X/verification')).statusCode).not.toBe(429);
    expect((await get('/v1/quittances/CODE-X/verification')).statusCode).toBe(429);
    await app.close();
  });

  it('corrélation : la route canonique journalise sous le X-Request-Id de la requête française', async () => {
    const env = await full();
    const ob = demoObligation(env);
    const r = await env.req('POST', '/v1/paiements/ordres', 'u-contribuable', { obligationId: ob.id, channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID(), 'x-request-id': 'req-catalogue-ordre-01' });
    expect(r.statusCode).toBe(201);
    const items = env.app.ctx.audit.list({ correlationId: 'req-catalogue-ordre-01', limit: 50 }).items;
    expect(items.some((e) => e.resourceId === r.json().paymentOrderId || JSON.stringify(e.details).includes(r.json().paymentReference))).toBe(true);
  });
});
