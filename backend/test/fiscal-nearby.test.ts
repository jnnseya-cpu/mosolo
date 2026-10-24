import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function env(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-27T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user) => app.inject({ method: method as 'GET', url, headers: user ? { 'x-demo-user': user } : {} });
  return { app, clock, req };
}
const LIMETE = { lat: -4.3712, lon: 15.3441 };
const GOMBE = { lat: -4.305, lon: 15.3 };
const url = (p: { lat: number; lon: number }, acc = 8, radius = 400) => `/v1/fiscal/nearby?lat=${p.lat}&lon=${p.lon}&accuracyM=${acc}&radiusM=${radius}`;

describe('Autour de moi — biens et commerces proches en vert, ambre ou rouge', () => {
  it('agent sur place dans son secteur : objets proches triés par distance, colorés, sans montant ni contribuable', async () => {
    const e = await env();
    const r = await e.req('GET', url(LIMETE), 'u-agent-terrain');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ inArea: true, commune: 'Limete', radiusM: 400 });
    expect(b.items.length).toBeGreaterThan(0);
    const ds = b.items.map((i: { distanceM: number }) => i.distanceM);
    expect(ds).toEqual([...ds].sort((a: number, c: number) => a - c));
    expect(Math.max(...ds)).toBeLessThanOrEqual(400);
    for (const i of b.items) {
      expect(['green', 'amber', 'red', 'grey', 'blue']).toContain(i.color);
      expect(i.commune).toMatch(/Limete|Lemba|Matete/);
      expect(i).not.toHaveProperty('amount');
      expect(i).not.toHaveProperty('taxpayerId');
      expect(i.category).not.toBe('VEHICULE');
    }
    expect(Object.values(b.counts as Record<string, number>).reduce((a, c) => a + c, 0)).toBe(b.items.length);
    expect(JSON.stringify(b)).not.toMatch(/"amount"/);
    expect(e.app.ctx.audit.list({ action: 'fiscal.nearby.viewed' }).total).toBe(1);
    // Accès minimal : aucun nom ni raison sociale, seulement le type ou la catégorie ; jamais une publicité de véhicule.
    const objects = e.app.ctx.objects.objects;
    for (const i of b.items as { id: string; label: string }[]) {
      const o = objects.get(i.id)!;
      for (const k of ['nom', 'raisonSociale']) if (typeof o.attributes[k] === 'string') expect(i.label).not.toContain(o.attributes[k] as string);
      expect(o.attributes['placement']).not.toBe('VEHICULE');
    }
  });

  it('hors de son secteur : rien n’est montré (et la tentative est journalisée)', async () => {
    const e = await env();
    const b = (await e.req('GET', url(GOMBE), 'u-agent-terrain')).json();
    expect(b).toMatchObject({ inArea: false, commune: 'Gombe', items: [] });
    // L'agent de Gombe, lui, voit les objets de Gombe.
    const g = (await e.req('GET', url(GOMBE, 8, 1000), 'u-agent-gombe')).json();
    expect(g.inArea).toBe(true);
    expect(g.items.every((i: { commune: string }) => i.commune === 'Gombe')).toBe(true);
    expect(e.app.ctx.audit.list({ action: 'fiscal.nearby.viewed' }).total).toBe(2);
  });

  it('position imprécise refusée, rayon plafonné, rôles non habilités refusés', async () => {
    const e = await env();
    expect((await e.req('GET', url(LIMETE, 150), 'u-agent-terrain')).json().code).toBe('GPS_TOO_IMPRECISE');
    expect((await e.req('GET', url(LIMETE, 8, 50_000), 'u-agent-terrain')).json().radiusM).toBe(1000);
    expect((await e.req('GET', url({ lat: 48.85, lon: 2.35 }), 'u-agent-terrain')).statusCode).toBe(400);
    expect((await e.req('GET', url(LIMETE), 'u-contribuable')).statusCode).toBe(403);
    expect((await e.req('GET', url(LIMETE))).statusCode).toBe(401);
  });
});
