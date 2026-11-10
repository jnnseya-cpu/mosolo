/**
 * Modules 72 (espaces d'entité et configuration des modules) et 74 (invitations et gestion des accès) — indicateurs
 * calculés sur les données réelles, dans le périmètre d'entités de la personne qui consulte : modules activés,
 * arbitrages et délais ; invitations acceptées, délais, révocations, secondes validations.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { accesPlugin, type AccesService } from '../src/plugins/acces/plugin.js';
import type { TestEnv } from './helpers.js';

async function setupAcces() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} }, plugins: [accesPlugin] });
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

async function outbox(env: TestEnv, to: string): Promise<{ text: string }[]> {
  return (await env.req('GET', `/v1/acces/sandbox/outbox?to=${encodeURIComponent(to)}`)).json().items;
}
async function mfa(env: TestEnv, user: string) {
  const c = await env.req('POST', '/v1/acces/mfa/challenge', user);
  const msg = (await outbox(env, `app:${user}`))[0]!;
  const code = /(\d{6})/.exec(msg.text)![1]!;
  expect((await env.req('POST', '/v1/acces/mfa/verify', user, { challengeId: c.json().challengeId, code })).statusCode).toBe(200);
}
async function received(env: TestEnv, phone: string) {
  const items = await outbox(env, phone);
  const token = /jeton=([0-9a-f]+)/.exec(items.find((m) => m.text.includes('jeton='))!.text)![1]!;
  const code = /: (\d{6})\./.exec(items.find((m) => m.text.startsWith('Code d’invitation'))!.text)![1]!;
  return { token, code };
}
const acceptBody = (token: string, phone: string, code: string) => ({
  token, phone, code, identityDocument: { type: 'Carte d’électeur', number: `CE-IND-${phone.slice(-6)}` }, photoTaken: true, mfaMethod: 'TOTP',
});

describe('Modules 72 et 74 — indicateurs', () => {
  it('invitations envoyées, acceptées (délai), secondes validations et révocations ; modules et arbitrages', async () => {
    const env = await setupAcces();
    const svc = env.app.ctx.ext.acces as AccesService;
    const base = (await env.req('GET', '/v1/acces/indicateurs', 'u-rssi')).json();
    expect(base.modules72.modules.total).toBe(svc.modules.count());
    expect(base.modules72.arbitrages.total).toBe(svc.arbitrations.count());
    // Invitation acceptée 3 h plus tard, puis seconde validation (rôle sensible R11).
    await env.req('POST', '/v1/acces/invitations', 'u-admin-entite', { motif: 'Affectation au service (test)', fullName: 'Kabeya Test', phone: '+243811000701', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R11'] });
    await env.req('POST', '/v1/acces/invitations', 'u-admin-entite', { motif: 'Affectation au service (test)', fullName: 'Invité en attente', phone: '+243811000702', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R36'] });
    env.clock.advanceHours(3);
    const { token, code } = await received(env, '+243811000701');
    const ok = (await env.req('POST', '/v1/acces/invitations/accept', undefined, acceptBody(token, '+243811000701', code))).json();
    expect(ok.status).toBe('ATTENTE_VALIDATION');
    await mfa(env, 'u-rssi');
    expect((await env.req('POST', `/v1/acces/validations/${ok.validationId}/decision`, 'u-rssi', { decision: 'APPROUVEE' })).statusCode).toBe(200);
    const after = (await env.req('GET', '/v1/acces/indicateurs', 'u-rssi')).json();
    const i = after.acces74.invitations;
    expect(i.envoyees - base.acces74.invitations.envoyees).toBe(2);
    expect(i.acceptees - base.acces74.invitations.acceptees).toBe(1);
    expect(i.enAttente - base.acces74.invitations.enAttente).toBe(1);
    expect(i.delaiAcceptationHeures).not.toBeNull();
    expect(after.acces74.validations.approuvees - base.acces74.validations.approuvees).toBe(1);
    // Révocation d'un compte : comptée.
    await env.req('POST', `/v1/acces/accounts/${ok.accountId}/revoke`, 'u-rssi', { motif: 'Fin de mission (test)' });
    const rev = (await env.req('GET', '/v1/acces/indicateurs', 'u-rssi')).json();
    expect(rev.acces74.comptes.revoques - after.acces74.comptes.revoques).toBe(1);
    // Contribuable : refusé.
    expect((await env.req('GET', '/v1/acces/indicateurs', 'u-contribuable')).statusCode).toBe(403);
  });

  it('cloisonnement : l’administrateur d’entité ne voit que son périmètre', async () => {
    const env = await setupAcces();
    const oversight = (await env.req('GET', '/v1/acces/indicateurs', 'u-rssi')).json();
    const entity = await env.req('GET', '/v1/acces/indicateurs', 'u-admin-entite');
    expect(entity.statusCode).toBe(200);
    const e = entity.json();
    expect(Array.isArray(e.perimetre)).toBe(true);
    expect(e.perimetre).toContain('DGIPK');
    expect(e.modules72.modules.total).toBeLessThanOrEqual(oversight.modules72.modules.total);
    expect(e.acces74.invitations.envoyees).toBeLessThanOrEqual(oversight.acces74.invitations.envoyees);
  });
});
