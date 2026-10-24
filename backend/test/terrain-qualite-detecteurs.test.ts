import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DAY_MS, ManualClock } from '../src/core/clock.js';
import { chainePlugin } from '../src/plugins/chaine/plugin.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { integriteDetecteursPlugin } from '../src/plugins/integrite/detecteurs/plugin.js';
import { DETECTEURS_PARAMS, detecteursSchedulerEnabled, type DetecteursService } from '../src/plugins/integrite/detecteurs/service.js';
import { ROTATION_ZONE_MAX_JOURS } from '../src/plugins/terrain/qualite-fraude.js';
import { terrainPlugin } from '../src/plugins/terrain/plugin.js';
import type { TerrainService } from '../src/plugins/terrain/service.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import type { TestEnv } from './helpers.js';

const HASH = 'd'.repeat(64);

async function setup(extra: 'detecteurs' | 'tresor' = 'tresor') {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} },
    plugins: extra === 'tresor' ? [tresorPlugin, terrainPlugin] : [terrainPlugin, chainePlugin, integriteDetecteursPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body) => app.inject({
      method: method as 'GET', url, headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return { env, terrain: app.ctx.ext.terrain as TerrainService };
}

describe('Sous-traitance : doublons, objets fictifs, rotation, récupération (§ 15A.5, § 15A.7)', () => {
  it('doublons et objets présumés fictifs détectés comme présomptions, sans effet automatique', async () => {
    const { env, terrain } = await setup();
    const st = terrain.findings.find((f) => f.subcontractorId === 'ST-0001');
    expect(st.length).toBeGreaterThanOrEqual(3);
    terrain.findings.update({ ...st[1]!, photoSha256: st[0]!.photoSha256! });
    const { photoSha256: _p, ...noPhoto } = st[2]!;
    terrain.findings.update({ ...noPhoto, gps: { ...st[2]!.gps, source: 'MANUEL' } });
    const board = (await env.req('GET', '/v1/terrain/qualite', 'u-controleur')).json();
    const codes = board.suspicions.map((s: { code: string }) => s.code);
    expect(codes).toEqual(expect.arrayContaining(['PHOTO_EN_DOUBLE', 'NOUVEL_OBJET_SANS_PREUVE']));
    expect(board.params).toMatchObject({ rotationMaxDays: ROTATION_ZONE_MAX_JOURS, rotationBlocking: false });
    expect(board.note).toMatch(/aucune sanction/);
    expect((await env.req('GET', '/v1/terrain/qualite', 'u-agent-terrain')).statusCode).toBe(403);
  });

  it('rotation des zones : alerte à l’affectation au-delà de la durée maximale, sans blocage par défaut', async () => {
    const { env, terrain } = await setup();
    const m = terrain.missions.get('MIS-LIM-014')!;
    terrain.missions.update({ ...m, assignedAt: new Date(env.clock.now().getTime() - (ROTATION_ZONE_MAX_JOURS + 5) * DAY_MS).toISOString() });
    const nm = terrain.createMission(env.app.ctx.users.get('u-superviseur')!, { title: 'Nouvelle mission Limete (test)', commune: 'Limete', quartier: 'Kingabwa', objectives: { findings: 1 }, periodStart: '2026-09-26', dueDate: '2026-10-10', center: { lat: -4.37, lon: 15.34 }, radiusM: 300 });
    const r = await env.req('POST', `/v1/terrain/missions/${nm.id}/assignment`, 'u-superviseur', { agentId: 'u-agent-terrain' });
    expect(r.statusCode).toBeLessThan(300);
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'TERRAIN_ROTATION_ZONE_DEPASSEE')).toBe(true);
    const rot = (await env.req('GET', '/v1/terrain/qualite', 'u-dg-dgipk')).json().rotation;
    expect(rot.items.find((i: { id: string }) => i.id === 'u-agent-terrain').overdue).toBe(true);
  });

  it('récupération : proposition du contrôle qualité, décision de la régie, ordre de reversement du Trésor à quatre yeux', async () => {
    const { env, terrain } = await setup();
    const [f1, f2] = terrain.findings.find((f) => f.subcontractorId === 'ST-0001');
    for (const f of [f1!, f2!]) terrain.findings.update({ ...f, status: 'VALIDE', review: { by: 'u-controleur', at: env.clock.now().toISOString(), decision: 'VALIDE', reason: 'Validé (test)' } });
    const body = { subcontractorId: 'ST-0001', findingIds: [f1!.id, f2!.id], grounds: 'OBJET_FICTIF', motif: 'Contre-visite : locaux inexistants à l’adresse (test).', evidenceSha256: [HASH] };
    expect((await env.req('POST', '/v1/terrain/recuperations', 'terrain-st-resp', body)).statusCode).toBe(403);
    const p = await env.req('POST', '/v1/terrain/recuperations', 'u-controleur', body);
    expect(p.statusCode).toBe(201);
    expect(p.json().amount).toEqual({ amount: '5000.00', currency: 'CDF' });
    expect((await env.req('POST', '/v1/terrain/recuperations', 'u-controleur', body)).json().code).toBe('FINDING_ALREADY_CLAIMED');
    // Trésor : impossible avant la décision de la régie.
    expect((await env.req('POST', '/v1/tresor/operations', 'u-tresor', { kind: 'RECUPERATION_SOUS_TRAITANT', reason: 'Ordre de reversement (test anticipé)', recuperation: { clawbackId: p.json().id } })).json().code).toBe('CLAWBACK_NOT_DECIDED');
    const d = await env.req('POST', `/v1/terrain/recuperations/${p.json().id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Objets fictifs établis par contre-visite (test).' });
    expect(d.json().status).toBe('DECIDEE');
    const rem = (await env.req('GET', '/v1/terrain/subcontractors/ST-0001/remuneration', 'u-dg-dgipk')).json();
    expect(rem.recoveries[0]).toMatchObject({ amount: { amount: '-5000.00', currency: 'CDF' } });
    const op = await env.req('POST', '/v1/tresor/operations', 'u-tresor', { kind: 'RECUPERATION_SOUS_TRAITANT', reason: 'Ordre de reversement des sommes indûment versées (test)', recuperation: { clawbackId: p.json().id } });
    expect(op.statusCode).toBe(201);
    const ex = await env.req('POST', `/v1/tresor/operations/${op.json().id}/approve`, 'tresor-chef-comptable', {});
    expect(ex.json()).toMatchObject({ status: 'EXECUTEE', result: { order: 'ORDRE_DE_REVERSEMENT' } });
    expect((await env.req('GET', '/v1/terrain/qualite', 'u-controleur')).json().clawbacks[0].status).toBe('ORDONNEE');
    expect(CIRCUITS.find((c) => c.code === 'TERRAIN_RECUPERATION')).toBeTruthy();
  });
});

describe('Détecteurs complémentaires (§ 25) et contrôle planifié des ruptures de chaîne', () => {
  it('planificateur désactivé sous les tests ; forcé par variable', () => {
    expect(detecteursSchedulerEnabled({ VITEST: 'true' })).toBe(false);
    expect(detecteursSchedulerEnabled({ VITEST: 'true', MOSOLO_DETECTEURS_SCHEDULER: 'on' })).toBe(true);
    expect(detecteursSchedulerEnabled({})).toBe(true);
    expect(detecteursSchedulerEnabled({ MOSOLO_DETECTEURS_SCHEDULER: 'off' })).toBe(false);
  });

  it('proximité agent–objet et écart constats / paiements : alertes seulement ; exécution planifiée journalisée avec ruptures de chaîne', async () => {
    const { env, terrain } = await setup('detecteurs');
    const svc = env.app.ctx.ext['integrite-detecteurs'] as DetecteursService;
    expect(svc.schedulerActive).toBe(false);
    const base = terrain.findings.find((f) => f.objectId === 'OBJ-DEMO-PARCELLE-01')[0]!;
    const old = new Date(env.clock.now().getTime() - 40 * DAY_MS).toISOString();
    for (let i = 0; i < DETECTEURS_PARAMS.proximiteMinInterventions + 2; i++) {
      terrain.findings.insert({ ...base, id: `F-TEST-${i}`, clientRef: `t-${i}`, status: 'VALIDE', capturedAt: old });
    }
    const run = await env.req('POST', '/v1/integrite/detecteurs/executions', 'u-auditeur');
    expect(run.statusCode).toBe(200);
    const codes = run.json().signals.map((s: { code: string }) => s.code);
    expect(codes).toEqual(expect.arrayContaining(['PROXIMITE_AGENT_OBJET', 'ECART_CONSTATS_PAIEMENTS']));
    expect(run.json()).toMatchObject({ automaticEffect: 'AUCUN', chaine: { total: expect.any(Number) } });
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'DETECTEUR_PROXIMITE_AGENT_OBJET')).toBe(true);
    expect((await env.req('POST', '/v1/integrite/detecteurs/executions', 'u-agent-terrain')).statusCode).toBe(403);
    // Exécution planifiée : une fois par intervalle, journalisée.
    expect(svc.scheduledTick().ran).toBe(true);
    expect(svc.scheduledTick().ran).toBe(false);
    env.clock.advance(DETECTEURS_PARAMS.intervalleHeures * 3_600_000 + 1000);
    expect(svc.scheduledTick().ran).toBe(true);
    expect(env.app.ctx.audit.list({ action: 'integrite.detecteurs.run' }).items.filter((e) => e.details.trigger === 'PLANIFIEE')).toHaveLength(2);
    const ov = (await env.req('GET', '/v1/integrite/detecteurs', 'u-auditeur')).json();
    expect(ov.detectors).toHaveLength(4);
    expect(ov.schedule.includesChainRuptures).toBe(true);
    expect(ALL_PARAMETERS.map((p) => p.id)).toEqual(expect.arrayContaining(['detecteurs.ecart_part_min_pct', 'terrain.rotation_zone_max_j']));
  });

  it('baisse inexpliquée des recettes d’une zone', async () => {
    const { env } = await setup('detecteurs');
    const svc = env.app.ctx.ext['integrite-detecteurs'] as DetecteursService;
    const now = env.clock.now().getTime();
    const mk = (i: number, daysAgo: number, amount: string) => env.app.ctx.payments.orders.insert({
      id: `PO-TEST-${i}`, paymentReference: `PR-TEST-${i}`, obligationId: 'X', taxpayerId: 'X', amount: { amount, currency: 'USD' }, status: 'RAPPROCHE',
      confirmedAt: new Date(now - daysAgo * DAY_MS).toISOString(), attribution: { commune: 'Kalamu' },
    } as never);
    for (let i = 0; i < 6; i++) mk(i, 40, '100.00');
    mk(99, 5, '100.00');
    const s = svc.baisseRecettesZone();
    expect(s[0]).toMatchObject({ code: 'BAISSE_RECETTES_ZONE', subject: 'Kalamu' });
  });
});
