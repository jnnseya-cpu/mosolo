import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/core/crypto.js';
import { DEMO, demoObligationId, setup, type TestEnv } from './helpers.js';

function batch(env: TestEnv, deviceId: string, ops: { opId: string; objectId: string; field: string; value: unknown }[], batchId = `LOT-${deviceId}-${ops[0]?.opId}`) {
  return JSON.stringify({ batchId, deviceId, createdAt: env.clock.now().toISOString(), operations: ops.map((o) => ({ ...o, observedAt: env.clock.now().toISOString() })) });
}
function send(env: TestEnv, user: string, raw: string, key: string) {
  return env.req('POST', '/v1/field-sync/batches', user, raw, { 'x-device-signature': hmacSha256Hex(key, raw) });
}

describe('Synchronisation terrain', () => {
  it('lot signé accepté ; terminal révoqué refusé ; signature invalide refusée', async () => {
    const env = await setup();
    const raw = batch(env, 'dev-terrain-001', [{ opId: 'op1', objectId: DEMO.unitId, field: 'surface_m2', value: '90' }]);
    const ok = await send(env, 'u-agent-terrain', raw, 'demo-device-key-001');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ accepted: ['op1'], rejected: [], conflicts: [], revokedDevices: ['dev-terrain-perdu'] });
    // Le constat n'écrase pas la valeur déclarée et ne crée aucune dette.
    const obj = env.app.ctx.objects.get(DEMO.unitId);
    expect(obj.attributes.surface_m2).toBe('85');
    expect(obj.observed.surface_m2).toBe('90');
    const obligations = env.app.ctx.assessment.obligations.count();

    const revoked = batch(env, 'dev-terrain-perdu', [{ opId: 'op9', objectId: DEMO.unitId, field: 'surface_m2', value: '1' }]);
    const r = await send(env, 'u-agent-terrain', revoked, 'demo-device-key-perdu');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('DEVICE_REVOKED');
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'REVOKED_DEVICE_SYNC')).toBe(true);

    const forged = batch(env, 'dev-terrain-001', [{ opId: 'op2', objectId: DEMO.unitId, field: 'usage', value: 'x' }]);
    const f = await send(env, 'u-agent-terrain', forged, 'mauvaise-cle');
    expect(f.json().code).toBe('INVALID_DEVICE_SIGNATURE');
    expect((await send(env, 'u-agent-terrain-2', raw, 'demo-device-key-001')).json().code).toBe('DEVICE_USER_MISMATCH');
    expect(env.app.ctx.assessment.obligations.count()).toBe(obligations);
  });

  it('deux agents divergents sur un même champ : les deux constats conservés, conflit ouvert', async () => {
    const env = await setup();
    const a = await send(env, 'u-agent-terrain', batch(env, 'dev-terrain-001', [{ opId: 'a1', objectId: DEMO.unitId, field: 'niveaux', value: 2 }]), 'demo-device-key-001');
    expect(a.json().conflicts).toHaveLength(0);
    const b = await send(env, 'u-agent-terrain-2', batch(env, 'dev-terrain-002', [{ opId: 'b1', objectId: DEMO.unitId, field: 'niveaux', value: 3 }]), 'demo-device-key-002');
    expect(b.statusCode).toBe(200);
    const conflict = b.json().conflicts[0];
    expect(conflict).toMatchObject({ objectId: DEMO.unitId, field: 'niveaux', status: 'A_ARBITRER' });
    expect(conflict.versions.map((v: { agentId: string; value: number }) => [v.agentId, v.value])).toEqual([['u-agent-terrain', 2], ['u-agent-terrain-2', 3]]);
    expect(env.app.ctx.field.observations.find((o) => o.field === 'niveaux')).toHaveLength(2);
    // Jamais « dernier écrit gagne » : la valeur observée reste celle d'avant le conflit.
    expect(env.app.ctx.objects.get(DEMO.unitId).observed.niveaux).toBe(2);
    // Objet hors du territoire de l'agent : opération rejetée.
    const gombe = env.app.ctx.objects.create(env.app.ctx.users.get('u-agent-gombe')!, { category: 'PARCELLE', commune: 'Gombe', quartier: 'Batetela', localityRank: 1, lat: -4.31, lon: 15.31, attributes: {} });
    const out = await send(env, 'u-agent-terrain-2', batch(env, 'dev-terrain-002', [{ opId: 'c1', objectId: gombe.id, field: 'x', value: 1 }], 'LOT-C'), 'demo-device-key-002');
    expect(out.json()).toMatchObject({ accepted: [], rejected: [{ opId: 'c1', reason: 'OUT_OF_TERRITORY' }] });
    expect((await env.req('POST', '/v1/field-sync/batches', 'u-contribuable', '{}')).statusCode).toBe(403);
  });

  it('lot de 500 opérations : un seul parcours du journal par lot (index objet/champ), conflits intra-lot détectés', async () => {
    const env = await setup();
    const ops = Array.from({ length: 500 }, (_, i) => ({ opId: `p${i}`, objectId: DEMO.unitId, field: `champ_${i % 50}`, value: i }));
    expect((await send(env, 'u-agent-terrain', batch(env, 'dev-terrain-001', ops, 'LOT-A'), 'demo-device-key-001')).json().accepted).toHaveLength(500);
    const obs = env.app.ctx.field.observations;
    const find = obs.find.bind(obs);
    let scans = 0;
    obs.find = (pred) => {
      scans += 1;
      return find(pred);
    };
    const other = ops.map((o) => ({ ...o, opId: `q${o.opId}`, value: -1 }));
    const b = await send(env, 'u-agent-terrain-2', batch(env, 'dev-terrain-002', other, 'LOT-B'), 'demo-device-key-002');
    expect(b.json().accepted).toHaveLength(500);
    expect(scans).toBe(1);
    // Chaque champ divergent ouvre un seul conflit, enrichi par les observations suivantes du même lot.
    expect(env.app.ctx.field.conflicts.find((c) => c.objectId === DEMO.unitId)).toHaveLength(50);
    expect(env.app.ctx.field.conflicts.findOne((c) => c.field === 'champ_0')!.versions).toHaveLength(10 + 10);
  });
});

describe('Réclamations', () => {
  it('décideur ≠ instructeur ; décision favorable = obligation rectificative, originale conservée', async () => {
    const env = await setup();
    const obl = demoObligationId(env);
    const sub = await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obl, grounds: 'Rang de localité erroné : la parcelle est en 3e rang.' });
    expect(sub.statusCode).toBe(201);
    const id = sub.json().id;
    expect(env.app.ctx.assessment.get(obl).status).toBe('CONTESTEE');
    expect((await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'ACCEPTEE', reason: 'Sans instruction' })).json().code).toBe('APPEAL_NOT_INSTRUCTED');

    // Un agent cumulant R20 et R21 (cumul non interdit par § 12.5) ne peut pas décider de son propre dossier.
    env.app.ctx.users.add({ id: 'u-mixte', name: 'Agent mixte', roles: ['R20', 'R21'], entity: 'DGIPK' });
    await env.req('POST', `/v1/appeals/${id}/instruct`, 'u-mixte', { proposal: 'PARTIELLEMENT_ACCEPTEE', analysis: 'Rang 3 confirmé par le cadastre.', proposedAmount: { amount: '50.00', currency: 'USD' } });
    const self = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-mixte', { decision: 'PARTIELLEMENT_ACCEPTEE', reason: 'Rang 3', rectifiedAmount: { amount: '50.00', currency: 'USD' } });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', `/v1/appeals/${id}/decide`, 'u-superadmin', { decision: 'REJETEE', reason: 'Tentative' })).statusCode).toBe(403);

    const decided = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'PARTIELLEMENT_ACCEPTEE', reason: 'Rang 3 confirmé', rectifiedAmount: { amount: '50.00', currency: 'USD' } });
    expect(decided.statusCode).toBe(200);
    const newId = decided.json().rectifyingObligationId;
    const original = env.app.ctx.assessment.get(obl);
    const rectified = env.app.ctx.assessment.get(newId);
    expect(original).toMatchObject({ status: 'ANNULEE', supersededBy: newId, amount: { amount: '150.00', currency: 'USD' } });
    expect(rectified).toMatchObject({ status: 'EMISE', supersedes: obl, amount: { amount: '50.00', currency: 'USD' } });
    expect(rectified.explanation.rectification).toMatchObject({ supersedes: obl, appealId: id });
    // La créance initiale est contrepassée par une écriture liée ; le livre reste équilibré.
    expect(env.app.ctx.ledger.list().some((e) => e.reversalOf === original.ledgerEntryId)).toBe(true);
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    const view = (await env.req('GET', `/v1/obligations/${newId}`, 'u-contribuable')).json();
    expect(view.explanation.rectification.appealId).toBe(id);
  });
});
