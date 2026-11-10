/**
 * Modules 70 et 71 — compléments vérifiés : visuels par module (couleur d'accent jamais confondue avec une couleur de
 * statut, pictogramme, préfixe) et « terminal enregistré obligatoire » : hors démonstration, aucun contrôle depuis un
 * poste non enrôlé ; un terminal révoqué ou affecté à un autre contrôleur est refusé ; indicateurs de contrôle.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { visualFor } from '../src/plugins/titres/model.js';
import { titresPlugin } from '../src/plugins/titres/plugin.js';
import type { TitresService } from '../src/plugins/titres/service.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

const CTRL = 'tt-ctrl-terminal';
const DEVICE = 'dev-titres-terminal';
const PLACE = { commune: 'Limete', label: 'Boulevard Lumumba', lat: -4.37, lon: 15.34 };

async function setup() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [titresPlugin] });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  app.ctx.users.add({ id: CTRL, name: 'Contrôleur terminal (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete'] });
  app.ctx.users.add({ id: 'tt-ctrl-autre', name: 'Autre contrôleur (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete'] });
  app.ctx.field.enroll(DEVICE, CTRL, 'cle-terminal-test');
  return { env, svc: app.ctx.ext.titres as TitresService };
}

describe('Module 70 — visuels par module', () => {
  it('couleur d’accent, pictogramme et préfixe propres au service ; jamais une couleur de statut', async () => {
    const STATUS_COLORS = ['#2e7d32', '#f9a825', '#c62828', '#1565c0', '#9e9e9e', '#000000'];
    for (const p of ['VIG', 'LIC', 'PAT', 'PEA', 'CAR', 'EMB', 'WEW', 'RKP', 'STA', 'IFA', 'XYZ']) {
      const v = visualFor(p);
      expect(v.prefix).toBe(p);
      expect(v.color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(STATUS_COLORS).not.toContain(v.color.toLowerCase());
      expect(v.pictogram.length).toBeGreaterThan(2);
    }
    const { env } = await setup();
    const types = (await env.req('GET', '/v1/titres/types')).json() as { prefix: string; visual: { prefix: string; color: string } }[];
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(t.visual).toMatchObject({ prefix: t.prefix.toUpperCase() });
  });
});

describe('Module 71 — terminal enregistré obligatoire', () => {
  it('terminal non enrôlé ou affecté à un autre contrôleur : refusé et journalisé', async () => {
    const { env } = await setup();
    const other = await env.req('POST', '/v1/titres/controles', 'tt-ctrl-autre', { code: 'ABCDEF', place: PLACE, deviceId: DEVICE });
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('DEVICE_NOT_ALLOWED');
    const unknown = await env.req('POST', '/v1/titres/controles', CTRL, { code: 'ABCDEF', place: PLACE, deviceId: 'dev-inconnu' });
    expect(unknown.json().code).toBe('DEVICE_NOT_ALLOWED');
    expect(env.app.ctx.audit.list({ action: 'titres.control.device_refused' }).total).toBe(2);
    // Terminal enrôlé et affecté : contrôle accepté (résultat quelconque), compté « terminal enregistré ».
    const ok = await env.req('POST', '/v1/titres/controles', CTRL, { code: 'ABCDEF', place: PLACE, deviceId: DEVICE });
    expect(ok.statusCode).toBe(201);
    // Démonstration : un navigateur sans terminal reste possible mais il est compté à part.
    expect((await env.req('POST', '/v1/titres/controles', CTRL, { code: 'ABCDEF', place: PLACE })).statusCode).toBe(201);
    const ind = (await env.req('GET', '/v1/titres/indicateurs', 'u-auditeur')).json();
    expect(ind.controls).toMatchObject({ withRegisteredTerminal: 1, withoutRegisteredTerminal: 1 });
    // Terminal révoqué : refusé.
    env.app.ctx.field.devices.update({ ...env.app.ctx.field.devices.get(DEVICE)!, status: 'REVOQUE' as never });
    expect((await env.req('POST', '/v1/titres/controles', CTRL, { code: 'ABCDEF', place: PLACE, deviceId: DEVICE })).json().code).toBe('DEVICE_NOT_ALLOWED');
  });

  it('hors démonstration : aucun contrôle sans terminal enregistré', async () => {
    const { env } = await setup();
    const prev = process.env.MOSOLO_DEMO_MODE;
    process.env.MOSOLO_DEMO_MODE = 'false';
    try {
      const { svc } = { svc: env.app.ctx.ext.titres as TitresService };
      const user = env.app.ctx.users.get(CTRL)!;
      expect(() => svc.control(user, { code: 'ABCDEF', place: PLACE } as never)).toThrow(/Terminal enregistré obligatoire/);
      expect(env.app.ctx.audit.list({ action: 'titres.control.device_refused' }).items[0]!.details).toMatchObject({ reason: 'TERMINAL_REQUIS' });
    } finally {
      process.env.MOSOLO_DEMO_MODE = prev;
    }
  });
});
