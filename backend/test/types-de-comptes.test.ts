/**
 * Types de comptes (27/09/2026) — « tous les types de comptes sont créés » : UN TEST PAR RÔLE (R01 à R37) prouvant,
 * de bout en bout par l'API, que le compte est créé par sa voie RÉELLE (invitation → acceptation → seconde validation ;
 * inscription publique ; inscription du mandataire ; contrat de partenariat ; accréditation du sous-traitant) et que le
 * compte obtenu lit une route propre à son rôle (refusée à un compte sans rôle).
 * Toutes les gardes existantes restent actives (pas d'élévation, seconde validation par une personne distincte, MFA).
 */
import { ROLES, type RoleCode } from '@mosolo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

let env: TestEnv;
const mfaDone = new Set<string>();
let seq = 0;

beforeAll(async () => {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} } });
  await app.ready();
  env = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  // Compte témoin sans rôle : chaque route de lecture choisie lui est refusée.
  app.ctx.users.add({ id: 'temoin-sans-role', name: 'Témoin sans rôle (test)', roles: [], entity: 'DGIPK' });
}, 120_000);

async function outbox(to: string): Promise<{ text: string; purpose: string }[]> {
  const r = await env.req('GET', `/v1/acces/sandbox/outbox?to=${encodeURIComponent(to)}`);
  expect(r.statusCode).toBe(200);
  return r.json().items;
}

async function mfa(user: string) {
  if (mfaDone.has(user)) return;
  const c = await env.req('POST', '/v1/acces/mfa/challenge', user);
  expect(c.statusCode).toBe(200);
  const code = /(\d{6})/.exec((await outbox(`app:${user}`))[0]!.text)![1]!;
  expect((await env.req('POST', '/v1/acces/mfa/verify', user, { challengeId: c.json().challengeId, code })).statusCode).toBe(200);
  mfaDone.add(user);
}

const nextPhone = () => `+2438120${String(++seq).padStart(5, '0')}`;

/** Invitation → acceptation (lien, code, pièce, photo, MFA) → seconde validation si requise. Renvoie l'identifiant du compte. */
async function inviteAndActivate(role: RoleCode, entity: string, level: string, opts: { inviter?: string; extraScope?: Record<string, unknown> } = {}) {
  const phone = nextPhone();
  const inv = await env.req('POST', '/v1/acces/invitations', opts.inviter ?? 'u-superadmin', {
    fullName: `Titulaire ${role} (test)`, phone, entity, accessLevel: level, roles: [role], motif: `Création du type de compte ${role} (test)`,
    ...(opts.extraScope ? { scope: opts.extraScope } : {}),
  });
  expect(inv.statusCode, JSON.stringify(inv.json())).toBe(201);
  const items = await outbox(phone);
  const token = /jeton=([0-9a-f]+)/.exec(items.find((m) => m.text.includes('jeton='))!.text)![1]!;
  const code = /: (\d{6})\./.exec(items.find((m) => m.text.startsWith('Code d’invitation'))!.text)![1]!;
  const look = (await env.req('GET', `/v1/acces/invitations/lookup?token=${token}`)).json();
  const acc = await env.req('POST', '/v1/acces/invitations/accept', undefined, {
    token, phone, code, identityDocument: { type: 'Carte d’électeur', number: `CE-TYPES-${role}-${seq}` }, photoTaken: true,
    mfaMethod: look.passkeyRequired ? 'PASSKEY' : 'TOTP', ...(look.deviceRequired ? { deviceId: `dev-types-${role}` } : {}),
  });
  expect(acc.statusCode, JSON.stringify(acc.json())).toBe(201);
  const a = acc.json();
  if (a.requirement) {
    // Le compte reste sans aucun rôle tant que la seconde validation n'est pas donnée.
    expect(env.app.ctx.users.get(a.accountId)!.roles).toEqual([]);
    const validator = { SECURITE: 'u-rssi', HORS_BANDE_CABINET: 'acces-u-sg', AUTORITE_AUDIT: 'u-auditeur', HABILITATION_REGIE: 'u-dg-dgipk' }[a.requirement as string]!;
    await mfa(validator);
    const d = await env.req('POST', `/v1/acces/validations/${a.validationId}/decision`, validator, {
      decision: 'APPROUVEE', note: 'Seconde validation (test)', outOfBandConfirmed: true, certificationRef: 'CERT-TEST-TYPES',
    });
    expect(d.statusCode, JSON.stringify(d.json())).toBe(200);
  }
  expect(env.app.ctx.users.get(a.accountId)!.roles).toEqual([role]);
  return a.accountId as string;
}

async function canRead(userId: string, url: string, headers: Record<string, string> = {}) {
  const r = await env.req('GET', url, userId, undefined, headers);
  expect(r.statusCode, `${userId} → ${url} : ${r.body.slice(0, 200)}`).toBe(200);
  expect((await env.req('GET', url, 'temoin-sans-role')).statusCode, `témoin → ${url}`).toBe(403);
}

/** Rôles créés par invitation : entité, niveau et route de lecture propre au rôle. */
const INVITATION_PLAN: [RoleCode, string, string, string][] = [
  ['R01', 'GOUVERNORAT', 'DIRECTION', '/v1/dashboards/governor'],
  ['R02', 'GOUVERNORAT', 'DIRECTION', '/v1/dashboards/governor'],
  ['R03', 'GOUVERNORAT', 'DIRECTION', '/v1/legal-rules/veille'],
  ['R04', 'MIN-TRANSPORTS', 'DIRECTION', '/v1/communications/overview'],
  ['R05', 'MINFIN', 'DIRECTION', '/v1/dashboards/governor'],
  ['R06', 'DGIPK', 'DIRECTION', '/v1/appeals/indicateurs'],
  ['R07', 'DGIPK', 'RESPONSABLE_MODULE', '/v1/assessments/base-overrides'],
  ['R08', 'DGIPK', 'ADMIN_ENTITE', '/v1/acces/types-de-comptes'],
  ['R09', 'DGIPK', 'SUPERVISEUR', '/v1/communications/overview'],
  ['R10', 'DGIPK', 'AGENT_TERRAIN', '/v1/obligations'],
  ['R11', 'DGIPK', 'OPERATEUR', '/v1/assessments/base-overrides'],
  ['R12', 'DGIPK', 'OPERATEUR', '/v1/obligations'],
  ['R13', 'MINFIN', 'OPERATEUR', '/v1/recalculations'],
  ['R14', 'MINFIN', 'OPERATEUR', '/v1/recalculations'],
  ['R15', 'MINFIN', 'OPERATEUR', '/v1/recalculations'],
  ['R16', 'MINFIN', 'OPERATEUR', '/v1/recalculations'],
  ['R17', 'TRESOR', 'OPERATEUR', '/v1/providers/connectors'],
  ['R18', 'TRESOR', 'OPERATEUR', '/v1/providers/connectors'],
  ['R19', 'TRESOR', 'OPERATEUR', '/v1/communications/overview'],
  ['R20', 'DGIPK', 'OPERATEUR', '/v1/appeals'],
  ['R21', 'DGIPK', 'DIRECTION', '/v1/appeals'],
  ['R22', 'AUDIT', 'AUDIT', '/v1/audit/verify'],
  ['R23', 'AUDIT', 'AUDIT', '/v1/audit/verify'],
  ['R24', 'AUDIT', 'AUDIT', '/v1/security/alerts'],
  ['R25', 'AUDIT', 'AUDIT', '/v1/communications/overview'],
  ['R26', 'PLATEFORME', 'ADMIN_TECHNIQUE', '/v1/acces/types-de-comptes'],
  ['R27', 'PLATEFORME', 'ADMIN_TECHNIQUE', '/v1/providers/connectors'],
  ['R28', 'PLATEFORME', 'ADMIN_TECHNIQUE', '/v1/security/alerts'],
  ['R29', 'PLATEFORME', 'ADMIN_TECHNIQUE', '/v1/communications/overview'],
  ['R36', 'GOUVERNORAT', 'CONSULTATION', '/v1/juridique/points'],
  ['R37', 'SERVICE-URBANISME', 'CONSULTATION', '/v1/fiscal/dependencies'],
];

describe('Types de comptes — un test par rôle : création par la voie réelle, lecture d’une route du rôle', () => {
  for (const [role, entity, level, url] of INVITATION_PLAN) {
    it(`${role} (${ROLES[role]}) : invitation → acceptation → seconde validation si requise → compte actif`, async () => {
      const id = await inviteAndActivate(role, entity, level);
      await canRead(id, url);
    });
  }

  it('R30 (Contribuable) : inscription publique, téléphone vérifié par code, connexion par code, lecture de ses mandats', async () => {
    const phone = nextPhone();
    const reg = await env.req('POST', '/v1/registrations', undefined, { phone, fullName: 'Contribuable du type R30 (test)', language: 'fr', situation: 'tenant' });
    expect(reg.statusCode).toBe(201);
    const taxpayerId = reg.json().taxpayerId as string;
    const send = await env.req('POST', `/v1/acces/identity/${taxpayerId}/otp`);
    const code = /(\d{6})/.exec((await outbox(phone))[0]!.text)![1]!;
    expect((await env.req('POST', `/v1/acces/identity/${taxpayerId}/otp/verify`, undefined, { challengeId: send.json().challengeId, code })).json().phoneVerified).toBe(true);
    const ch = (await env.req('POST', '/v1/auth/login', undefined, { method: 'phone', phone })).json();
    const ok = await env.req('POST', '/v1/auth/otp', undefined, { challengeId: ch.challengeId, code: ch.demoCode });
    expect(ok.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${ok.json().accessToken as string}` };
    const r = await env.req('GET', '/v1/acces/mandates', undefined, undefined, auth);
    expect(r.statusCode).toBe(200);
    const user = env.app.ctx.users.all().find((u) => u.taxpayerId === taxpayerId)!;
    expect(user.roles).toEqual(['R30']);
    expect((await env.req('GET', '/v1/acces/mandates', 'temoin-sans-role')).statusCode).toBe(403);
  });

  it('R31 (Mandataire) : inscription publique vérifiée par code, compte public, puis mandat accordé par un contribuable', async () => {
    const phone = nextPhone();
    const reg = await env.req('POST', '/v1/acces/mandataires/inscriptions', undefined, { fullName: 'Cabinet mandataire du type R31 (test)', phone, kind: 'CABINET' });
    expect(reg.statusCode).toBe(201);
    expect(JSON.stringify(reg.json())).not.toMatch(/"code"/);
    const code = /(\d{6})/.exec((await outbox(phone))[0]!.text)![1]!;
    const bad = await env.req('POST', `/v1/acces/mandataires/inscriptions/${reg.json().registrationId}/verification`, undefined, { challengeId: reg.json().challengeId, code: code === '000000' ? '111111' : '000000' });
    expect(bad.json().code).toBe('OTP_INVALID');
    const ok = await env.req('POST', `/v1/acces/mandataires/inscriptions/${reg.json().registrationId}/verification`, undefined, { challengeId: reg.json().challengeId, code });
    expect(ok.statusCode).toBe(200);
    const userId = ok.json().userId as string;
    expect(env.app.ctx.users.get(userId)).toMatchObject({ roles: ['R31'], entity: 'PUBLIC' });
    // Deuxième inscription pour le même numéro : refusée.
    expect((await env.req('POST', '/v1/acces/mandataires/inscriptions', undefined, { fullName: 'Doublon', phone })).json().code).toBe('MANDATAIRE_EXISTS');
    // Le contribuable (N2) désigne ce mandataire de confiance ; le mandataire lit ses mandats.
    const m = await env.req('POST', '/v1/acces/mandates', 'u-contribuable', { mandataireUserId: userId, kind: 'CONFIANCE', scope: ['CONSULTER'], validTo: '2027-06-30' });
    expect(m.statusCode, m.body).toBe(201);
    await canRead(userId, '/v1/acces/mandates');
    expect((await env.req('GET', '/v1/acces/mandates', userId)).json().items.some((x: { mandantTaxpayerId: string }) => x.mandantTaxpayerId === DEMO.taxpayerId)).toBe(true);
  });

  for (const [role, kind, url] of [['R32', 'BANQUE_PSP', '/v1/postes/travail'], ['R33', 'BANQUE_PSP', '/v1/postes/travail'], ['R34', 'PARTENAIRE', '/v1/recoupement/sources']] as [RoleCode, string, string][]) {
    it(`${role} (${ROLES[role]}) : contrat de partenariat enregistré à deux personnes, puis invitation dans l’entité partenaire`, async () => {
      const entity = `PART-TEST-${role}`;
      await mfa('u-superadmin');
      expect((await env.req('POST', '/v1/acces/entities', 'u-superadmin', { id: entity, name: `Partenaire ${role} (test)`, shortName: `Part. ${role}`, kind, parentId: null, decisionRef: 'Décision FICTIVE CP-TEST' })).statusCode).toBe(201);
      // Sans contrat : invitation refusée.
      const refused = await env.req('POST', '/v1/acces/invitations', 'u-superadmin', { fullName: 'Sans contrat', phone: nextPhone(), entity, accessLevel: 'OPERATEUR', roles: [role], motif: 'Tentative sans contrat (test)' });
      expect(refused.json().code).toBe('PARTNER_CONTRACT_REQUIRED');
      const c = await env.req('POST', '/v1/acces/contrats-partenaires', 'u-superadmin', { entity, reference: `CONV-FICTIVE-${role}`, roles: [role], object: 'Convention de partenariat fictive (test)' });
      expect(c.statusCode).toBe(201);
      // L'auteur de l'enregistrement ne l'approuve pas (et n'en a pas le droit) ; le ministre des Finances approuve.
      expect((await env.req('POST', `/v1/acces/contrats-partenaires/${c.json().id}/decision`, 'u-superadmin', { approve: true, note: 'Auto-approbation' })).statusCode).toBe(403);
      await mfa('u-ministre-finances');
      const d = await env.req('POST', `/v1/acces/contrats-partenaires/${c.json().id}/decision`, 'u-ministre-finances', { approve: true, note: 'Convention signée (test)' });
      expect(d.json().status).toBe('ACTIF');
      const id = await inviteAndActivate(role, entity, 'OPERATEUR');
      await canRead(id, url);
    });
  }

  it('R35 (Sous-traitant terrain) : invitation par la régie, dossier, diligences, accréditation à deux personnes', async () => {
    const inv = await env.req('POST', '/v1/terrain/subcontractors', 'u-dg-dgipk', {
      name: 'Sous-traitant du type R35 SARL (test)', selectionReference: 'AMI-TYPES-R35', requestedModules: ['FONCIER_LOCATIF'], capacityAgents: 2, managerName: 'Gestionnaire R35 (test)',
    });
    expect(inv.statusCode).toBe(201);
    const { subcontractor, managerUserId } = inv.json();
    expect(env.app.ctx.users.get(managerUserId)!.roles).toEqual(['R35']);
    expect((await env.req('POST', `/v1/terrain/subcontractors/${subcontractor.id}/dossier`, managerUserId, { rccm: 'RCCM-TYPES', nif: 'NIF-TYPES' })).statusCode).toBe(200);
    await env.req('POST', `/v1/terrain/subcontractors/${subcontractor.id}/diligence`, 'u-dg-dgipk', { legalExistence: true, taxClearance: true, noConflictOfInterest: true, publicAgentLinksDeclared: true });
    const proposal = { modules: ['FONCIER_LOCATIF'], communes: ['Limete'], validUntil: '2027-09-26', probationUntil: '2026-10-26', reason: 'Sélection AMI (test)' };
    expect((await env.req('POST', `/v1/terrain/subcontractors/${subcontractor.id}/accreditation/propose`, 'u-dg-dgipk', proposal)).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/terrain/subcontractors/${subcontractor.id}/accreditation/approve`, 'u-dg-dgipk', { reason: 'Auto-approbation (test)' })).json().code).toBe('SEPARATION_OF_DUTIES');
    const ok = await env.req('POST', `/v1/terrain/subcontractors/${subcontractor.id}/accreditation/approve`, 'acces-u-chef-service', { reason: 'Dossier complet (test)' });
    expect(ok.json().status).toBe('ACCREDITE_PROBATOIRE');
    await canRead(managerUserId, '/v1/agents/me/earnings');
    expect((await env.req('GET', `/v1/terrain/subcontractors/${subcontractor.id}`, managerUserId)).statusCode).toBe(200);
  });

  it('couverture : les 37 rôles ont un parcours testé ci-dessus et au moins un compte de démonstration [EXEMPLE]', async () => {
    const tested = new Set<string>([...INVITATION_PLAN.map(([r]) => r), 'R30', 'R31', 'R32', 'R33', 'R34', 'R35']);
    expect([...tested].sort()).toEqual(Object.keys(ROLES).sort());
    const demo = (await env.req('GET', '/v1/demo/users')).json() as { roles: string[] }[];
    for (const r of Object.keys(ROLES)) expect(demo.some((u) => u.roles.includes(r)), `utilisateur de démonstration ${r}`).toBe(true);
    const types = (await env.req('GET', '/v1/acces/types-de-comptes', 'u-superadmin')).json();
    expect(types.types).toHaveLength(37);
    expect(types.families).toHaveLength(10);
    for (const t of types.types) {
      expect(t.exemples.length, `exemple ${t.code}`).toBeGreaterThan(0);
      expect(t.exemples[0].tag).toBe('[EXEMPLE]');
      expect(t.count, `décompte ${t.code}`).toBeGreaterThan(0);
    }
  });
});
