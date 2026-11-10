import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { Secrets } from '../src/context.js';
import { accesPlugin, type AccesService } from '../src/plugins/acces/plugin.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

async function setupAcces(overrides: Partial<Secrets> = {}) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {}, ...overrides },
    plugins: [accesPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      }),
  };
  return env;
}

const svcOf = (env: TestEnv) => env.app.ctx.ext.acces as AccesService;

async function outbox(env: TestEnv, to: string): Promise<{ text: string; purpose: string }[]> {
  const r = await env.req('GET', `/v1/acces/sandbox/outbox?to=${encodeURIComponent(to)}`);
  expect(r.statusCode).toBe(200);
  return r.json().items;
}

async function mfa(env: TestEnv, user: string) {
  const c = await env.req('POST', '/v1/acces/mfa/challenge', user);
  expect(c.statusCode).toBe(200);
  const msg = (await outbox(env, `app:${user}`))[0]!;
  const code = /(\d{6})/.exec(msg.text)![1]!;
  const v = await env.req('POST', '/v1/acces/mfa/verify', user, { challengeId: c.json().challengeId, code });
  expect(v.statusCode).toBe(200);
}

async function invite(env: TestEnv, inviter: string, body: Record<string, unknown>) {
  const r = await env.req('POST', '/v1/acces/invitations', inviter, { motif: 'Affectation au service (démo)', ...body });
  return r;
}

/** Lien et code reçus par l'invité (boîte d'envoi du bac à sable). */
async function received(env: TestEnv, phone: string) {
  const items = await outbox(env, phone);
  const token = /jeton=([0-9a-f]+)/.exec(items.find((m) => m.text.includes('jeton='))!.text)![1]!;
  const code = /: (\d{6})\./.exec(items.find((m) => m.text.startsWith('Code d’invitation'))!.text)![1]!;
  return { token, code };
}

const acceptBody = (token: string, phone: string, code: string, extra: Record<string, unknown> = {}) => ({
  // Pièce FICTIVE distincte par numéro invité : une personne = un compte de travail.
  token, phone, code, identityDocument: { type: 'Carte d’électeur', number: `CE-TEST-${phone.slice(-6)}` }, photoTaken: true, mfaMethod: 'TOTP', ...extra,
});

describe('Module acces — référentiels et amorçage', () => {
  it('sème entités, fiches de module et un arbitrage de compétence ouvert', async () => {
    const env = await setupAcces();
    const ents = (await env.req('GET', '/v1/acces/entities', 'u-admin-entite')).json().items;
    expect(ents.find((e: { id: string }) => e.id === 'ST-RECENSEMENT-DEMO').parentId).toBe('DGIPK');
    const mods = (await env.req('GET', '/v1/acces/modules', 'u-admin-entite')).json().items;
    expect(mods.find((m: { code: string }) => m.code === 'STAT-GOMBE-DEMO').status).toBe('BLOQUE_ARBITRAGE');
    const arbs = (await env.req('GET', '/v1/acces/arbitrations', 'u-dircab')).json().items;
    expect(arbs.some((a: { kind: string; status: string }) => a.kind === 'COMPETENCE_MODULE' && a.status === 'OUVERT')).toBe(true);
    const levels = (await env.req('GET', '/v1/acces/levels')).json();
    expect(levels.accessLevels).toHaveLength(10);
    expect((await env.req('GET', '/v1/acces/entities', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Identité : inscription publique, OTP, personnes morales, niveaux', () => {
  it('AC-INV-01 : le parcours public refuse tout rôle de travail', async () => {
    const env = await setupAcces();
    const r = await env.req('POST', '/v1/registrations', undefined, { phone: '+243899111222', fullName: 'Test Public', language: 'fr', situation: 'tenant', roles: ['R17'] });
    expect(r.statusCode).toBe(400);
    const org = await env.req('POST', '/v1/acces/organisations', undefined, {
      raisonSociale: 'Société test', forme: 'SARL', phone: '+243899111223', language: 'fr', role: 'R26',
      representatives: [{ fullName: 'Dirigeant Test', fonction: 'Gérant', habilitation: 'DIRIGEANT' }], declarant: { fullName: 'Dirigeant Test', fonction: 'Gérant' },
    });
    expect(org.statusCode).toBe(400);
  });

  it('vérifie le téléphone par code à usage unique (bac à sable) : code jamais renvoyé par l’API, essai erroné compté, usage unique', async () => {
    const env = await setupAcces();
    const reg = (await env.req('POST', '/v1/registrations', undefined, { phone: '+243 899 000 333', fullName: 'Lukusa Mbala', language: 'fr', situation: 'tenant' })).json();
    const send = await env.req('POST', `/v1/acces/identity/${reg.taxpayerId}/otp`);
    expect(send.statusCode).toBe(201);
    const code = /(\d{6})/.exec((await outbox(env, '+243899000333'))[0]!.text)![1]!;
    expect(send.json()).not.toHaveProperty('code');
    expect(JSON.stringify(send.json())).not.toContain(`"${code}"`);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await env.req('POST', `/v1/acces/identity/${reg.taxpayerId}/otp/verify`, undefined, { challengeId: send.json().challengeId, code: wrong });
    expect(bad.json().code).toBe('OTP_INVALID');
    const ok = await env.req('POST', `/v1/acces/identity/${reg.taxpayerId}/otp/verify`, undefined, { challengeId: send.json().challengeId, code });
    expect(ok.json()).toMatchObject({ phoneVerified: true, verificationLevel: 'N0' });
    const replay = await env.req('POST', `/v1/acces/identity/${reg.taxpayerId}/otp/verify`, undefined, { challengeId: send.json().challengeId, code });
    expect(replay.statusCode).toBe(409);
    expect(env.app.ctx.audit.list({ action: 'acces.identity.phone_verified' }).items.some((r) => JSON.stringify(r).includes(code))).toBe(false);
  });

  it('production (fournisseur SMS branché) : aucune boîte d’envoi, aucun code en clair', async () => {
    const env = await setupAcces({ commsProviderKeys: { sms: 'cle-fournisseur-test' } });
    const reg = (await env.req('POST', '/v1/registrations', undefined, { phone: '+243899000444', fullName: 'Test Prod', language: 'fr', situation: 'tenant' })).json();
    const send = await env.req('POST', `/v1/acces/identity/${reg.taxpayerId}/otp`);
    expect(send.json().sandbox).toBe(false);
    expect((await env.req('GET', '/v1/acces/sandbox/outbox?to=%2B243899000444')).statusCode).toBe(404);
    expect(svcOf(env).outbox.count()).toBe(0);
  });

  it('personne morale : identifiants déclarés (non vérifiés), représentants nommément habilités', async () => {
    const env = await setupAcces();
    const r = await env.req('POST', '/v1/acces/organisations', undefined, {
      raisonSociale: 'Transports du Fleuve SA (test)', forme: 'SA', rccm: 'CD/KIN/RCCM/TEST-01', nif: 'A1234567T', phone: '+243899000555', language: 'fr',
      representatives: [{ fullName: 'Mbala Tshala', fonction: 'Directeur général', habilitation: 'DIRIGEANT' }], declarant: { fullName: 'Mbala Tshala', fonction: 'Directeur général' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ kind: 'PERSONNE_MORALE', verificationLevel: 'N0' });
    const id = await env.req('GET', `/v1/acces/identity/${r.json().taxpayerId}`, 'u-guichet');
    expect(id.json().organisation.representatives[0].habilitation).toBe('DIRIGEANT');
    expect(id.json().proofs.map((p: { type: string; status: string }) => `${p.type}:${p.status}`).sort()).toEqual(['NIF:DECLAREE', 'RCCM:DECLAREE']);
    expect(id.json().proofs.every((p: { referenceMasked: string }) => p.referenceMasked.includes('•'))).toBe(true);
  });

  it('niveaux par preuves : contrôle par une personne distincte ; N1 exige le téléphone vérifié', async () => {
    const env = await setupAcces();
    const tp = DEMO.tenantTaxpayerId;
    const piece = await env.req('POST', `/v1/acces/identity/${tp}/proofs`, 'u-locataire', { type: 'PIECE_IDENTITE', reference: 'PASSEPORT-OP1234567' });
    expect(piece.statusCode).toBe(201);
    await env.req('POST', `/v1/acces/identity/${tp}/proofs`, 'u-locataire', { type: 'ADRESSE', reference: 'Limete, Kingabwa, avenue fictive 12' });
    expect((await env.req('POST', `/v1/acces/identity/${DEMO.taxpayerId}/proofs`, 'u-locataire', { type: 'NIF', reference: 'X' .repeat(5) })).statusCode).toBe(403);
    const rev = await env.req('POST', `/v1/acces/identity-proofs/${piece.json().id}/review`, 'u-guichet', { decision: 'VALIDEE', note: 'Pièce contrôlée au guichet' });
    expect(rev.json().verificationLevel).toBe('N0');
    const send = (await env.req('POST', `/v1/acces/identity/${tp}/otp`)).json();
    const code = /(\d{6})/.exec((await outbox(env, '+243820000002'))[0]!.text)![1]!;
    const ok = await env.req('POST', `/v1/acces/identity/${tp}/otp/verify`, undefined, { challengeId: send.challengeId, code });
    expect(ok.json().verificationLevel).toBe('N1');
    // Pièce saisie au guichet puis contrôlée par la même personne : refusé.
    const own = await env.req('POST', `/v1/acces/identity/${tp}/proofs`, 'u-guichet', { type: 'CONTROLE_DOCUMENTAIRE', reference: 'DOSSIER-TEST-01' });
    expect((await env.req('POST', `/v1/acces/identity-proofs/${own.json().id}/review`, 'u-guichet', { decision: 'VALIDEE', note: 'auto' })).json().code).toBe('SEPARATION_OF_DUTIES');
  });

  it('enrôlement assisté N0-A : empreinte désactivée (J18), zone de l’agent respectée, aucun paiement', async () => {
    const env = await setupAcces();
    const base = { fullName: 'Mama Ngalula', language: 'ln', commune: 'Limete', consent: { method: 'EMPREINTE' } };
    expect((await env.req('POST', '/v1/acces/assisted-enrolments', 'u-agent-terrain', base)).json().code).toBe('FINGERPRINT_DISABLED');
    const out = await env.req('POST', '/v1/acces/assisted-enrolments', 'u-agent-terrain', { ...base, commune: 'Gombe', consent: { method: 'TEMOIN', witnessName: 'Chef de quartier (fictif)' } });
    expect(out.json().code).toBe('OUT_OF_TERRITORY');
    const ok = await env.req('POST', '/v1/acces/assisted-enrolments', 'u-agent-terrain', { ...base, consent: { method: 'TEMOIN', witnessName: 'Chef de quartier (fictif)' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().verificationLevel).toBe('N0A');
    expect(env.app.ctx.payments.orders.count()).toBe(0);
  });
});

describe('Invitations en cascade (§ 12A)', () => {
  it('parcours nominal : lien lié au numéro, code, usage unique ; contrôleur actif après seconde validation, avec ses seuls rôles', async () => {
    const env = await setupAcces();
    const r = await invite(env, 'u-admin-entite', { fullName: 'Kasongo Ilunga', phone: '+243811000001', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R11'] });
    expect(r.statusCode).toBe(201);
    expect(JSON.stringify(r.json())).not.toMatch(/jeton|codeHash|tokenHash/);
    const { token, code } = await received(env, '+243811000001');
    const look = await env.req('GET', `/v1/acces/invitations/lookup?token=${token}`);
    expect(look.json()).toMatchObject({ status: 'ENVOYEE', accessLevel: 'OPERATEUR' });
    // AC-INV-03 : autre numéro refusé.
    const other = await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811999999', code));
    expect(other.json().code).toBe('INVITATION_PHONE_MISMATCH');
    const ok = await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000001', code));
    expect(ok.statusCode).toBe(201);
    // Contrôleur (R11) : maillon de la chaîne constat → décision ⇒ seconde validation par une personne distincte.
    expect(ok.json()).toMatchObject({ status: 'ATTENTE_VALIDATION', requirement: 'SECURITE' });
    await mfa(env, 'u-rssi');
    expect((await env.req('POST', `/v1/acces/validations/${ok.json().validationId}/decision`, 'u-rssi', { decision: 'APPROUVEE' })).statusCode).toBe(200);
    const me = (await env.req('GET', '/v1/acces/me', ok.json().accountId)).json();
    expect(me.user.roles).toEqual(['R11']);
    expect(me.user.entity).toBe('DGIPK');
    // AC-INV-03 : second usage refusé.
    const again = await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000001', code));
    expect(again.json().code).toBe('INVITATION_ALREADY_USED');
    expect(env.app.ctx.audit.list({ action: 'acces.invitation.finalized' }).total).toBe(1);
  });

  it('AC-INV-03 : lien refusé après expiration', async () => {
    const env = await setupAcces();
    await invite(env, 'u-admin-entite', { fullName: 'Agent Expiré', phone: '+243811000002', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R36'] });
    const { token, code } = await received(env, '+243811000002');
    env.clock.advance(73 * 3_600_000);
    const r = await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000002', code));
    expect(r.json().code).toBe('INVITATION_EXPIRED');
  });

  it('AC-INV-02 : pas d’élévation, pas de sortie de périmètre, droit d’inviter explicite, rôles incompatibles refusés', async () => {
    const env = await setupAcces();
    const chef = 'acces-u-chef-service';
    expect((await invite(env, chef, { fullName: 'Directeur X', phone: '+243811000010', entity: 'DGIPK', accessLevel: 'DIRECTION', roles: ['R06'] })).json().code).toBe('NO_ELEVATION');
    expect((await invite(env, chef, { fullName: 'Superviseur Y', phone: '+243811000011', entity: 'DGIPK', accessLevel: 'SUPERVISEUR', roles: ['R09'] })).json().code).toBe('OUT_OF_PERIMETER');
    const inModule = await invite(env, chef, { fullName: 'Superviseur Y', phone: '+243811000011', entity: 'DGIPK', accessLevel: 'SUPERVISEUR', roles: ['R09'], scope: { modules: ['MOD-DEMO-IF'] } });
    expect(inModule.statusCode).toBe(201);
    expect((await invite(env, chef, { fullName: 'Agent Z', phone: '+243811000012', entity: 'DGIPK', accessLevel: 'SUPERVISEUR', roles: ['R09'], scope: { modules: ['MOD-DEMO-STAT'] } })).json().code).toBe('OUT_OF_PERIMETER');
    expect((await invite(env, 'u-admin-entite', { fullName: 'Agent communal', phone: '+243811000013', entity: 'COMMUNE-LIMETE', accessLevel: 'OPERATEUR', roles: ['R11'] })).json().code).toBe('OUT_OF_PERIMETER');
    expect((await invite(env, 'u-controleur', { fullName: 'Collègue', phone: '+243811000014', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R11'] })).json().code).toBe('NO_INVITE_RIGHT');
    expect((await invite(env, 'u-superadmin', { fullName: 'Juriste', phone: '+243811000015', entity: 'MINFIN', accessLevel: 'OPERATEUR', roles: ['R13', 'R14'] })).json().code).toBe('ROLE_INCOMPATIBILITY');
    expect((await invite(env, 'u-superadmin', { fullName: 'Public', phone: '+243811000016', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R30'] })).json().code).toBe('PUBLIC_ROLE_NOT_INVITABLE');
    expect((await invite(env, 'u-admin-entite', { fullName: 'Auditeur', phone: '+243811000017', entity: 'DGIPK', accessLevel: 'AUDIT', roles: ['R22'] })).json().code).toBe('NO_ELEVATION');
    expect(env.app.ctx.audit.list({ action: 'acces.invitation.refused' }).total).toBeGreaterThanOrEqual(5);
  });

  it('AC-INV-05 : rôle sensible inactif jusqu’à la seconde validation par une personne distincte, avec MFA', async () => {
    const env = await setupAcces();
    await invite(env, 'u-superadmin', { fullName: 'Comptable Test', phone: '+243811000020', entity: 'TRESOR', accessLevel: 'OPERATEUR', roles: ['R17'] });
    const { token, code } = await received(env, '+243811000020');
    expect((await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000020', code))).json().code).toBe('PHISHING_RESISTANT_MFA_REQUIRED');
    const acc = await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000020', code, { mfaMethod: 'PASSKEY' }));
    expect(acc.json()).toMatchObject({ status: 'ATTENTE_VALIDATION', requirement: 'SECURITE' });
    const id = acc.json().accountId as string;
    expect(env.app.ctx.users.get(id)!.roles).toEqual([]);
    expect((await env.req('GET', '/v1/ledger/balance', id)).statusCode).toBe(403);
    const vid = acc.json().validationId as string;
    expect((await env.req('POST', `/v1/acces/validations/${vid}/decision`, 'u-superadmin', { decision: 'APPROUVEE' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/acces/validations/${vid}/decision`, 'u-rssi', { decision: 'APPROUVEE' })).json().code).toBe('MFA_REQUIRED');
    await mfa(env, 'u-rssi');
    const ok = await env.req('POST', `/v1/acces/validations/${vid}/decision`, 'u-rssi', { decision: 'APPROUVEE', note: 'Vérification hors bande effectuée' });
    expect(ok.statusCode).toBe(200);
    expect(env.app.ctx.users.get(id)!.roles).toEqual(['R17']);
  });

  it('compte du Gouverneur : confirmation hors bande par le Cabinet ou le Secrétariat général', async () => {
    const env = await setupAcces();
    await invite(env, 'u-superadmin', { fullName: 'Gouverneur (test)', phone: '+243811000030', entity: 'GOUVERNORAT', accessLevel: 'DIRECTION', roles: ['R01'] });
    const { token, code } = await received(env, '+243811000030');
    const acc = (await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000030', code, { mfaMethod: 'PASSKEY' }))).json();
    expect(acc.requirement).toBe('HORS_BANDE_CABINET');
    await mfa(env, 'u-rssi');
    expect((await env.req('POST', `/v1/acces/validations/${acc.validationId}/decision`, 'u-rssi', { decision: 'APPROUVEE' })).json().code).toBe('VALIDATOR_NOT_QUALIFIED');
    await mfa(env, 'acces-u-sg');
    expect((await env.req('POST', `/v1/acces/validations/${acc.validationId}/decision`, 'acces-u-sg', { decision: 'APPROUVEE' })).json().code).toBe('OUT_OF_BAND_REQUIRED');
    const ok = await env.req('POST', `/v1/acces/validations/${acc.validationId}/decision`, 'acces-u-sg', { decision: 'APPROUVEE', outOfBandConfirmed: true });
    expect(ok.statusCode).toBe(200);
    expect(env.app.ctx.users.get(acc.accountId)!.roles).toEqual(['R01']);
  });

  it('agent de terrain : terminal requis, habilité par la régie sur formation certifiée', async () => {
    const env = await setupAcces();
    await invite(env, 'u-admin-entite', { fullName: 'Agent Terrain Test', phone: '+243811000040', entity: 'DGIPK', accessLevel: 'AGENT_TERRAIN', roles: ['R10'], scope: { territory: ['Limete'] } });
    const { token, code } = await received(env, '+243811000040');
    expect((await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000040', code))).json().code).toBe('DEVICE_REQUIRED');
    const acc = (await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000040', code, { deviceId: 'dev-terrain-099' }))).json();
    expect(acc.requirement).toBe('HABILITATION_REGIE');
    await mfa(env, 'u-dg-dgipk');
    expect((await env.req('POST', `/v1/acces/validations/${acc.validationId}/decision`, 'u-dg-dgipk', { decision: 'APPROUVEE' })).json().code).toBe('CERTIFICATION_REQUIRED');
    const ok = await env.req('POST', `/v1/acces/validations/${acc.validationId}/decision`, 'u-dg-dgipk', { decision: 'APPROUVEE', certificationRef: 'CERT-FORMATION-DEMO-01' });
    expect(ok.statusCode).toBe(200);
    expect(env.app.ctx.users.get(acc.accountId)).toMatchObject({ roles: ['R10'], territory: ['Limete'] });
  });

  it('AC-INV-04 : inscription assistée — invitation préalable, même entité, niveau conservé, secrets définis par la personne', async () => {
    const env = await setupAcces();
    const inv = (await invite(env, 'u-admin-entite', { fullName: 'Agente Guichet', phone: '+243811000050', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R12'] })).json().invitation;
    const { code } = await received(env, '+243811000050');
    const body = { identityDocument: { type: 'Carte d’électeur', number: 'CE-ASSIST-01' }, photoTaken: true, otpCode: code, gps: { lat: -4.37, lon: 15.34 }, operatorDeviceId: 'poste-guichet-01' };
    expect((await env.req('POST', `/v1/acces/invitations/${inv.id}/assisted`, 'u-controleur', body)).json().code).toBe('NOT_ACCESS_OPERATOR');
    expect((await env.req('POST', `/v1/acces/invitations/${inv.id}/assisted`, 'u-guichet', { ...body, accessLevel: 'DIRECTION' })).statusCode).toBe(400);
    expect((await env.req('POST', `/v1/acces/invitations/${inv.id}/assisted`, 'u-guichet', { ...body, mfaMethod: 'SMS' })).statusCode).toBe(400);
    const listed = await env.req('GET', '/v1/acces/invitations', 'u-guichet');
    expect(listed.json().items.some((i: { id: string }) => i.id === inv.id)).toBe(true);
    const ok = await env.req('POST', `/v1/acces/invitations/${inv.id}/assisted`, 'u-guichet', body);
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'ATTENTE_SECRETS', secretsPending: true });
    const id = ok.json().accountId as string;
    expect(env.app.ctx.users.get(id)!.roles).toEqual([]);
    const secrets = await env.req('POST', '/v1/acces/accounts/me/secrets', id, { mfaMethod: 'TOTP' });
    expect(secrets.json()).toMatchObject({ status: 'ACTIF', accessLevel: 'OPERATEUR', roles: ['R12'] });
    // Personne invitée d'une autre entité : refusée.
    const other = (await invite(env, 'acces-u-admin-limete', { fullName: 'Agent communal', phone: '+243811000051', entity: 'COMMUNE-LIMETE', accessLevel: 'OPERATEUR', roles: ['R11'] })).json().invitation;
    const c2 = (await received(env, '+243811000051')).code;
    expect((await env.req('POST', `/v1/acces/invitations/${other.id}/assisted`, 'u-guichet', { ...body, otpCode: c2 })).json().code).toBe('OUT_OF_PERIMETER');
    expect(env.app.ctx.audit.list({ action: 'acces.invitation.assisted_registration' }).total).toBe(1);
  });

  it('révocation : invités rattachés au successeur ; suspension d’une entité ⇒ révocation en cascade', async () => {
    const env = await setupAcces();
    await invite(env, 'u-admin-entite', { fullName: 'Recenseur ST', phone: '+243811000060', entity: 'ST-RECENSEMENT-DEMO', accessLevel: 'CONSULTATION', roles: ['R36'] });
    const { token, code } = await received(env, '+243811000060');
    const acc = (await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000060', code))).json();
    expect(acc.status).toBe('ACTIF');
    await invite(env, 'u-admin-entite', { fullName: 'Invité en attente', phone: '+243811000061', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R36'] });
    await mfa(env, 'u-rssi');
    const rev = await env.req('POST', '/v1/acces/accounts/u-admin-entite/revoke', 'u-rssi', { motif: 'Départ du responsable (démo)', successorId: 'u-dg-dgipk' });
    expect(rev.json().status).toBe('REVOQUE');
    const s = svcOf(env);
    expect(s.accounts.get(acc.accountId)!.sponsorId).toBe('u-dg-dgipk');
    expect(s.invitations.findOne((i) => i.phone === '+243811000061')!.status).toBe('REVOQUEE');
    expect(env.app.ctx.users.get('u-admin-entite')!.roles).toEqual([]);
    await mfa(env, 'u-superadmin');
    const sus = await env.req('POST', '/v1/acces/entities/ST-RECENSEMENT-DEMO/suspend', 'u-superadmin', { motif: 'Fin de convention (démo)', decisionRef: 'Décision FICTIVE CP-02' });
    expect(sus.json().revokedAccounts).toBe(1);
    expect(env.app.ctx.users.get(acc.accountId)!.roles).toEqual([]);
  });
});

describe('Une personne physique = un compte de travail (séparation des tâches par personne)', () => {
  async function acceptAs(env: TestEnv, inviter: string, body: Record<string, unknown>, doc: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    expect((await invite(env, inviter, body)).statusCode).toBe(201);
    const phone = body.phone as string;
    const { token, code } = await received(env, phone);
    return env.req('POST', '/v1/acces/invitations/accept', undefined, { ...acceptBody(token, phone, code, extra), identityDocument: doc });
  }

  it('ATTAQUE : même pièce d’identité sous deux téléphones ⇒ second compte refusé (DUPLICATE_PERSON), alerte ; possible après clôture', async () => {
    const env = await setupAcces();
    const s = svcOf(env);
    const first = await acceptAs(env, 'u-admin-entite', { fullName: 'Kabila Mutombo', phone: '+243811000101', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R11'] },
      { type: 'Carte d’électeur', number: 'CE-4455-6677' });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().accountId as string;
    // Même numéro, autre téléphone, autre libellé de pièce, séparateurs et casse différents : même personne.
    const second = await acceptAs(env, 'u-admin-entite', { fullName: 'K. Mutombo', phone: '+243822000102', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R36'] },
      { type: 'Passeport', number: 'ce 4455 6677' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'DUPLICATE_PERSON', existingAccountId: firstId });
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'DUPLICATE_PERSON_ATTEMPT')).toBe(true);
    expect(s.accounts.find((a) => a.personId === s.accounts.get(firstId)!.personId)).toHaveLength(1);
    // Le numéro n'est jamais conservé en clair ; l'empreinte n'est pas exposée par l'API.
    expect(JSON.stringify(s.accounts.get(firstId))).not.toMatch(/4455/);
    const listed = await env.req('GET', '/v1/acces/accounts', 'u-admin-entite');
    expect(JSON.stringify(listed.json())).not.toContain(s.accounts.get(firstId)!.personId!);
    // Après clôture (révocation) du premier compte, la personne peut recevoir un nouveau compte.
    await mfa(env, 'u-rssi');
    expect((await env.req('POST', `/v1/acces/accounts/${firstId}/revoke`, 'u-rssi', { motif: 'Changement d’affectation (test)' })).statusCode).toBe(200);
    const { token, code } = await received(env, '+243822000102');
    const again = await env.req('POST', '/v1/acces/invitations/accept', undefined, { ...acceptBody(token, '+243822000102', code), identityDocument: { type: 'Passeport', number: 'CE44556677' } });
    expect(again.statusCode).toBe(201);
  });

  it('ATTAQUE : une personne, deux comptes (données antérieures) ne peut pas vérifier ce qu’elle a constaté', async () => {
    const env = await setupAcces();
    const s = svcOf(env);
    const pid = s.personIdFor('CE-DOUBLE-0001');
    env.app.ctx.users.add({ id: 'test-auteur', name: 'Auteur', roles: ['R10'], entity: 'DGIPK', personId: pid });
    env.app.ctx.users.add({ id: 'test-verificateur', name: 'Vérificateur (autre téléphone)', roles: ['R09'], entity: 'DGIPK', personId: pid });
    env.app.ctx.users.add({ id: 'test-autre', name: 'Autre personne', roles: ['R09'], entity: 'DGIPK', personId: s.personIdFor('CE-AUTRE-0002') });
    const { assertDistinctPerson } = await import('../src/core/policy.js');
    expect(() => assertDistinctPerson('test-verificateur', ['test-auteur'], 'personne distincte')).toThrow(/personne distincte/);
    expect(() => assertDistinctPerson('test-autre', ['test-auteur'], 'personne distincte')).not.toThrow();
    // Sans empreinte connue : comparaison par compte (comportement historique inchangé pour les comptes amorcés).
    expect(() => assertDistinctPerson('u-controleur', ['u-agent-terrain'], 'x')).not.toThrow();
    expect(() => assertDistinctPerson('u-controleur', ['u-controleur'], 'x')).toThrow();
  });

  it('seconde validation désormais requise pour chef de service, superviseur, contrôleur et contentieux', async () => {
    const env = await setupAcces();
    for (const [i, role, lvl] of [[1, 'R07', 'RESPONSABLE_MODULE'], [2, 'R09', 'SUPERVISEUR'], [3, 'R11', 'OPERATEUR'], [4, 'R20', 'OPERATEUR']] as const) {
      const phone = `+24381100020${i}`;
      const r = await acceptAs(env, 'u-superadmin', { fullName: `Agent ${role}`, phone, entity: 'DGIPK', accessLevel: lvl, roles: [role] }, { type: 'CNI', number: `CNI-SV-${i}000` });
      expect(r.json()).toMatchObject({ status: 'ATTENTE_VALIDATION', requirement: 'SECURITE' });
      expect(env.app.ctx.users.get(r.json().accountId)!.roles).toEqual([]);
    }
  });

  it('détection : même nom et date de naissance, ou même terminal, sur un autre compte ⇒ alerte (sans blocage)', async () => {
    const env = await setupAcces();
    const a = await acceptAs(env, 'u-admin-entite', { fullName: 'Ngalula Mbuyi', phone: '+243811000301', entity: 'DGIPK', accessLevel: 'AGENT_TERRAIN', roles: ['R10'], scope: { territory: ['Limete'] } },
      { type: 'CNI', number: 'CNI-AAA-111', birthDate: '1990-04-12' }, { deviceId: 'dev-terrain-301' });
    expect(a.statusCode).toBe(201);
    expect(env.app.ctx.alerts.list().some((x) => x.type === 'POSSIBLE_DUPLICATE_PERSON')).toBe(false);
    const b = await acceptAs(env, 'u-admin-entite', { fullName: 'MBUYI Ngalula', phone: '+243822000302', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R36'] },
      { type: 'Passeport', number: 'OP-BBB-222', birthDate: '1990-04-12' });
    expect(b.statusCode).toBe(201);
    const c = await acceptAs(env, 'u-admin-entite', { fullName: 'Autre Nom', phone: '+243833000303', entity: 'DGIPK', accessLevel: 'AGENT_TERRAIN', roles: ['R10'], scope: { territory: ['Limete'] } },
      { type: 'CNI', number: 'CNI-CCC-333' }, { deviceId: 'dev-terrain-301' });
    expect(c.statusCode).toBe(201);
    const alerts = env.app.ctx.alerts.list().filter((x) => x.type === 'POSSIBLE_DUPLICATE_PERSON');
    expect(alerts).toHaveLength(2);
    const byAccount = (id: string) => JSON.stringify(alerts.find((x) => x.context?.accountId === id)?.context);
    expect(byAccount(b.json().accountId)).toContain('NOM_ET_DATE_DE_NAISSANCE');
    expect(byAccount(c.json().accountId)).toContain('MEME_TERMINAL');
    expect(byAccount(c.json().accountId)).toContain(a.json().accountId);
  });

  it('ATTAQUE : un agent public (terrain) ne peut pas être opérateur de point de paiement (R32), ni à l’invitation ni par attribution', async () => {
    const env = await setupAcces();
    const r = await invite(env, 'u-superadmin', { fullName: 'Agent-caissier', phone: '+243811000401', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R10', 'R32'] });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('ROLE_INCOMPATIBILITY');
    const r2 = await invite(env, 'u-superadmin', { fullName: 'Sous-traitant-caissier', phone: '+243811000402', entity: 'ST-RECENSEMENT-DEMO', accessLevel: 'OPERATEUR', roles: ['R35', 'R32'] });
    expect(r2.json().code).toBe('ROLE_INCOMPATIBILITY');
    expect(() => env.app.ctx.users.setRoles('u-agent-terrain', ['R10', 'R32'])).toThrow(/Cumul interdit/);
    expect(() => env.app.ctx.users.add({ id: 'test-agent-caisse', name: 'x', roles: ['R11', 'R32'], entity: 'DGIPK' })).toThrow(/Cumul interdit/);
  });
});

describe('Fiches de module et multi-entités (§ 10A)', () => {
  it('fiche validée en maker-checker, recette, activation sur référence d’arrêté ; règle non active refusée', async () => {
    const env = await setupAcces();
    const alias = await env.req('POST', '/v1/acces/modules', 'u-admin-entite', { code: 'PUB-TEST', label: 'Test', revenueScope: 'AFFICHAGE', responsibleEntity: 'DGIPK', beneficiaryAliases: ['COMPTE-PRIVE-X'] });
    expect(alias.json().code).toBe('BENEFICIARY_NOT_IN_VAULT');
    const other = await env.req('POST', '/v1/acces/modules', 'u-admin-entite', { code: 'PUB-TEST', label: 'Test', revenueScope: 'AFFICHAGE', responsibleEntity: 'COMMUNE-LIMETE' });
    expect(other.statusCode).toBe(403);
    const inactive = env.app.ctx.rules.list().find((r) => r.status !== 'ACTIVE')!.code;
    const m = (await env.req('POST', '/v1/acces/modules', 'u-admin-entite', {
      code: 'IF-TEST', label: 'Impôt foncier — test', revenueScope: 'IMPOT_FONCIER_TEST', responsibleEntity: 'DGIPK', beneficiaryAliases: [DEMO.dgipkAlias], ruleCodes: [DEMO.demoRuleCode, inactive],
    })).json().module;
    expect(m.status).toBe('BROUILLON');
    await mfa(env, 'u-admin-entite');
    expect((await env.req('POST', `/v1/acces/modules/${m.id}/submit`, 'u-admin-entite', {})).json().status).toBe('VALIDATION_PROGRAMME');
    expect((await env.req('POST', `/v1/acces/modules/${m.id}/activate`, 'u-gouverneur', { actReference: 'Arrêté test' })).json().code).toBe('MODULE_BAD_STATE');
    await mfa(env, 'u-dircab');
    expect((await env.req('POST', `/v1/acces/modules/${m.id}/visa-programme`, 'u-dircab', {})).json().status).toBe('VALIDATION_JURIDIQUE');
    await mfa(env, 'u-juriste-verificateur');
    expect((await env.req('POST', `/v1/acces/modules/${m.id}/visa-juridique`, 'u-juriste-verificateur', { actReferences: ['Instrument fictif'] })).json().status).toBe('RECETTE');
    await mfa(env, 'acces-u-exploitation');
    expect((await env.req('POST', `/v1/acces/modules/${m.id}/recette`, 'acces-u-exploitation', { passed: true, report: 'Scénarios de recette passés' })).json().status).toBe('SECONDE_VALIDATION');
    expect((await env.req('POST', `/v1/acces/modules/${m.id}/activate`, 'u-dircab', { actReference: 'Arrêté test' })).json().code).toBe('SEPARATION_OF_DUTIES');
    await mfa(env, 'u-gouverneur');
    const act = await env.req('POST', `/v1/acces/modules/${m.id}/activate`, 'u-gouverneur', { actReference: 'Arrêté FICTIF test' });
    expect(act.json().code).toBe('RULE_NOT_ACTIVE');
  });

  it('double revendication de compétence : la seconde fiche est bloquée et un arbitrage est ouvert', async () => {
    const env = await setupAcces();
    const r = await env.req('POST', '/v1/acces/modules', 'acces-u-admin-limete', { code: 'IF-LIMETE', label: 'Impôt foncier communal', revenueScope: 'IMPOT_FONCIER', responsibleEntity: 'COMMUNE-LIMETE' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ blocked: true, module: { status: 'BLOQUE_ARBITRAGE' } });
  });

  it('AC § 10A.4 : même fait générateur, même objet, même période ⇒ seconde obligation bloquée, arbitrage, aucune double obligation', async () => {
    const env = await setupAcces();
    const before = env.app.ctx.assessment.obligations.count();
    const citizenBefore = (await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-contribuable')).json().obligations.length;
    const claim = await env.req('POST', '/v1/acces/claims', 'acces-u-controleur-limete', {
      objectId: DEMO.parcelId, factCode: 'PROPRIETE_BATIE', period: '2026', basis: 'Taxe communale sur la propriété bâtie (revendication de test)',
    });
    expect(claim.statusCode).toBe(409);
    expect(claim.json().code).toBe('CLAIM_BLOCKED');
    const arbId = claim.json().arbitrationId as string;
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-contribuable')).json().obligations).toHaveLength(citizenBefore);
    const arb = (await env.req('GET', `/v1/acces/arbitrations/${arbId}`, 'acces-u-controleur-limete')).json();
    expect(arb.claimants.map((c: { entity: string }) => c.entity).sort()).toEqual(['COMMUNE-LIMETE', 'DGIPK']);
    expect(arb.existingObligationIds).toHaveLength(1);
    expect((await env.req('GET', `/v1/acces/arbitrations/${arbId}`, 'acces-u-admin-transports')).statusCode).toBe(403);
    // Liquidation sous garde par la commune avec une règle d'une autre entité : refusée.
    const rule = env.app.ctx.rules.list().find((r) => r.code === DEMO.demoRuleCode)!;
    expect((await env.req('POST', '/v1/acces/claims/liquidations', 'acces-u-controleur-limete', { ruleId: rule.id, objectId: DEMO.parcelId, factCode: 'PROPRIETE_BATIE', period: '2026', basis: 'Tentative' })).json().code).toBe('OUT_OF_ENTITY');
    // Décision humaine : avis juridique puis autorité distincte, hors des parties, avec MFA.
    expect((await env.req('POST', `/v1/acces/arbitrations/${arbId}/decision`, 'u-ministre-finances', { winnerEntity: 'DGIPK', motif: 'Compétence provinciale', actReference: 'Décision test' })).json().code).toBe('OPINION_REQUIRED');
    await env.req('POST', `/v1/acces/arbitrations/${arbId}/opinion`, 'u-juriste-verificateur', { text: 'L’impôt foncier relève de la province (avis de test).', recommendedEntity: 'DGIPK' });
    expect((await env.req('POST', `/v1/acces/arbitrations/${arbId}/decision`, 'u-ministre-finances', { winnerEntity: 'DGIPK', motif: 'Compétence provinciale', actReference: 'Décision test' })).json().code).toBe('MFA_REQUIRED');
    await mfa(env, 'u-ministre-finances');
    const dec = await env.req('POST', `/v1/acces/arbitrations/${arbId}/decision`, 'u-ministre-finances', { winnerEntity: 'DGIPK', motif: 'Compétence provinciale (test)', actReference: 'Décision FICTIVE CJT-01' });
    expect(dec.json()).toMatchObject({ status: 'DECIDE', decision: { winnerEntity: 'DGIPK', rectificationRequired: false } });
    const again = await env.req('POST', '/v1/acces/claims', 'acces-u-controleur-limete', { objectId: DEMO.parcelId, factCode: 'PROPRIETE_BATIE', period: '2026', basis: 'Nouvelle tentative' });
    expect(again.json().code).toBe('CLAIM_REJECTED_BY_ARBITRATION');
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
  });

  it('liquidation sous garde : jamais de double perception pour le même fait et la même période', async () => {
    const env = await setupAcces();
    const rule = env.app.ctx.rules.list().find((r) => r.code === DEMO.demoRuleCode)!;
    const dup = await env.req('POST', '/v1/acces/claims/liquidations', 'u-controleur', { ruleId: rule.id, objectId: DEMO.parcelId, factCode: 'PROPRIETE_BATIE', period: '2026', basis: 'Règle fictive' });
    expect(dup.json().code).toBe('DUPLICATE_OBLIGATION');
    const obj = await env.req('POST', '/v1/fiscal-objects', 'u-controleur', {
      taxpayerId: DEMO.taxpayerId, category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.372, lon: 15.345, attributes: { superficie_m2: '300' },
    });
    expect(obj.statusCode).toBe(201);
    const ok = await env.req('POST', '/v1/acces/claims/liquidations', 'u-controleur', { ruleId: rule.id, objectId: obj.json().id, factCode: 'PROPRIETE_BATIE', period: '2026', basis: 'Règle fictive' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().obligation.entity).toBe('DGIPK');
  });
});

describe('Doublons, fusion, consultation motivée, mandats', () => {
  it('fusion sur preuve avec double validation par des personnes distinctes, réversible', async () => {
    const env = await setupAcces();
    const d = (await env.req('GET', '/v1/acces/duplicates', 'u-guichet')).json().items;
    const pair = d.find((c: { reasons: string[] }) => c.reasons.includes('MEME_PIECE_IDENTITE'));
    expect(pair).toBeDefined();
    const [a, b] = [pair.a.id as string, pair.b.id as string];
    const survivor = a === DEMO.taxpayerId ? a : b;
    const absorbed = survivor === a ? b : a;
    const p = await env.req('POST', '/v1/acces/merges', 'u-guichet', { survivorId: survivor, absorbedId: absorbed, evidence: 'Même carte d’électeur présentée au guichet (fictif)' });
    expect(p.statusCode).toBe(201);
    const id = p.json().id as string;
    expect((await env.req('POST', `/v1/acces/merges/${id}/approve`, 'acces-u-chef-service')).json().code).toBe('MERGE_BAD_STATE');
    expect((await env.req('POST', `/v1/acces/merges/${id}/verify`, 'u-superviseur', {})).json().status).toBe('VERIFIEE');
    expect((await env.req('POST', `/v1/acces/merges/${id}/approve`, 'u-superviseur')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/acces/merges/${id}/approve`, 'acces-u-chef-service')).json().code).toBe('MFA_REQUIRED');
    await mfa(env, 'acces-u-chef-service');
    expect((await env.req('POST', `/v1/acces/merges/${id}/approve`, 'acces-u-chef-service')).json().status).toBe('EFFECTUEE');
    expect(env.app.ctx.taxpayers.get(absorbed)).toMatchObject({ status: 'FUSIONNE', mergedInto: survivor });
    const rev = await env.req('POST', `/v1/acces/merges/${id}/close`, 'acces-u-chef-service', { action: 'ANNULER', motif: 'Erreur constatée (test)' });
    expect(rev.json().status).toBe('ANNULEE');
    expect(env.app.ctx.taxpayers.get(absorbed).status).toBe('ACTIF');
  });

  it('aucune fusion sur la seule similitude de noms sans pièce justificative', async () => {
    const env = await setupAcces();
    const x = (await env.req('POST', '/v1/registrations', undefined, { phone: '+243899000701', fullName: 'Tshisekedi Mbuyi Kabongo', language: 'fr', situation: 'tenant' })).json();
    const y = (await env.req('POST', '/v1/registrations', undefined, { phone: '+243899000702', fullName: 'Mbuyi Kabongo', language: 'fr', situation: 'tenant' })).json();
    const r = await env.req('POST', '/v1/acces/merges', 'u-guichet', { survivorId: x.taxpayerId, absorbedId: y.taxpayerId, evidence: 'Noms proches seulement' });
    expect(r.json().code).toBe('NAME_ONLY_MATCH');
  });

  it('motif de consultation : bris de glace hors périmètre (MFA, alerte, durée limitée), récusation des proches', async () => {
    const env = await setupAcces();
    const body = { taxpayerId: DEMO.taxpayerId, purpose: 'CONTROLE', motif: 'Vérification d’une revendication communale sur la parcelle' };
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'acces-u-controleur-limete')).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/acces/consultations', 'acces-u-controleur-limete', { ...body, motif: 'court' })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/acces/consultations', 'acces-u-controleur-limete', body)).json().code).toBe('MFA_REQUIRED');
    await mfa(env, 'acces-u-controleur-limete');
    const alerts = env.app.ctx.alerts.alerts.count();
    const c = await env.req('POST', '/v1/acces/consultations', 'acces-u-controleur-limete', body);
    expect(c.json().mode).toBe('BRIS_DE_GLACE');
    expect(env.app.ctx.alerts.alerts.count()).toBe(alerts + 1);
    const dossier = await env.req('GET', `/v1/acces/consultations/${c.json().id}/dossier`, 'acces-u-controleur-limete');
    expect(dossier.json().taxpayer.phoneMasked).not.toBe('+243810000001');
    expect(dossier.json().obligations).toHaveLength(1);
    env.clock.advance(31 * 60_000);
    expect((await env.req('GET', `/v1/acces/consultations/${c.json().id}/dossier`, 'acces-u-controleur-limete')).json().code).toBe('CONSULTATION_EXPIRED');
    expect((await env.req('POST', '/v1/acces/consultations', 'u-controleur', { ...body, taxpayerId: DEMO.tenantTaxpayerId })).json().code).toBe('SELF_OR_RELATIVE_CASE');
    env.app.ctx.users.add({ id: 'test-admin-technique', name: 'Administrateur technique (test, R26 seul)', roles: ['R26'], entity: 'PLATEFORME' });
    expect((await env.req('POST', '/v1/acces/consultations', 'test-admin-technique', body)).statusCode).toBe(403);
    const review = await env.req('POST', `/v1/acces/consultations/${c.json().id}/review`, 'u-auditeur', { conclusion: 'JUSTIFIEE', note: 'Motif cohérent avec le dossier d’arbitrage' });
    expect(review.json().review.conclusion).toBe('JUSTIFIEE');
  });

  it('mandats : périmètre, durée, révocation, niveau requis ; la politique commune suit l’état du mandat', async () => {
    const env = await setupAcces();
    const seeded = (await env.req('GET', '/v1/acces/mandates', 'u-contribuable')).json().items[0];
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-mandataire')).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/acces/mandates/${seeded.id}/revoke`, 'u-locataire', { motif: 'tiers' })).statusCode).toBe(403);
    await env.req('POST', `/v1/acces/mandates/${seeded.id}/revoke`, 'u-contribuable', { motif: 'Changement de cabinet' });
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-mandataire')).statusCode).toBe(403);
    const m = await env.req('POST', '/v1/acces/mandates', 'u-contribuable', { mandataireUserId: 'u-mandataire', kind: 'CONFIANCE', scope: ['CONSULTER'], validTo: '2026-10-15' });
    expect(m.statusCode).toBe(201);
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-mandataire')).statusCode).toBe(200);
    expect((await env.req('GET', `/v1/acces/mandates/check?taxpayerId=${DEMO.taxpayerId}&action=PAYER`, 'u-mandataire')).json().allowed).toBe(false);
    expect((await env.req('GET', `/v1/acces/mandates/check?taxpayerId=${DEMO.taxpayerId}&action=CONSULTER`, 'u-mandataire')).json().allowed).toBe(true);
    env.clock.set('2026-10-16T09:00:00.000Z');
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-mandataire')).statusCode).toBe(403);
    const low = await env.req('POST', '/v1/acces/mandates', 'u-locataire', { mandataireUserId: 'u-mandataire', kind: 'CONFIANCE', scope: ['CONSULTER'], validTo: '2027-01-01' });
    expect(low.json().code).toBe('LEVEL_TOO_LOW');
  });

  it('journal des accès visible de l’administrateur de l’entité concernée, cloisonné entre entités', async () => {
    const env = await setupAcces();
    await invite(env, 'u-admin-entite', { fullName: 'Consultant', phone: '+243811000070', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R36'] });
    const mine = (await env.req('GET', '/v1/acces/journal', 'u-admin-entite')).json().items;
    expect(mine.some((e: { action: string }) => e.action === 'acces.invitation.sent')).toBe(true);
    const limete = (await env.req('GET', '/v1/acces/journal', 'acces-u-admin-limete')).json().items;
    expect(limete.some((e: { entity: string }) => e.entity === 'DGIPK')).toBe(false);
    expect((await env.req('GET', '/v1/acces/journal?entity=DGIPK', 'acces-u-admin-limete')).statusCode).toBe(403);
  });
});
