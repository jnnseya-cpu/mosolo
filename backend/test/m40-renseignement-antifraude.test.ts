/**
 * Module 40 — Renseignement anti-fraude : signaux (réutilisation d'appareils, annulations et exonérations anormales,
 * quittances manipulées), scores explicables (variables, sources, confiance), dossier ouvert à partir d'un signal,
 * suspension conservatoire d'un accès technique (proposée, exécutée par une personne distincte, levée, échue),
 * transmission à l'autorité compétente (bordereau scellé, accusé), déperdition évitée, indicateurs.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { integriteEnquetesPlugin } from '../src/plugins/integrite/enquetes/plugin.js';
import { integritePlugin } from '../src/plugins/integrite/plugin.js';
import type { TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: [integritePlugin, integriteEnquetesPlugin], secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} } });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}

/** Signaux fabriqués : un terminal partagé par deux agents, des exonérations en série, une fausse quittance présentée. */
function plantSignals(env: TestEnv) {
  const ctx = env.app.ctx;
  ctx.field.enroll('dev-partage-01', 'u-agent-terrain', 'cle-terminal-test-0123456789abcdef0123');
  ctx.field.observations.append({ id: 'OBS-T-1', objectId: 'OBJ-X', field: 'occupation', value: 'occupe', agentId: 'u-agent-terrain-2', deviceId: 'dev-partage-01', batchId: 'B1', opId: 'op1', observedAt: '2026-09-26T08:00:00.000Z', receivedAt: '2026-09-26T08:01:00.000Z', probativeStatus: 'OBSERVE' });
  const dg = ctx.users.get('u-dg-dgipk')!;
  for (let i = 0; i < 5; i++) ctx.audit.append({ actor: { kind: 'user', id: dg.id, roles: dg.roles }, action: 'exemption.granted', resourceType: 'exemption', resourceId: `EXO-${i}`, details: {} });
  for (let i = 0; i < 3; i++) ctx.audit.append({ actor: { kind: 'public', id: 'verification-publique' }, action: 'receipt.verified', resourceType: 'receipt', resourceId: 'Q-FAUX-0001', details: { found: false } });
}

describe('Module 40 — renseignement anti-fraude', () => {
  it('signaux complémentaires dans la file commune ; scores explicables (variables, sources, confiance) ; jamais d’effet', async () => {
    const env = await setup();
    plantSignals(env);
    const run = (await env.req('POST', '/v1/integrite/detection/run', 'u-enqueteur')).json();
    expect(run.automaticEffect).toBe('AUCUN');
    const codes = run.alerts.map((a: { ruleCode: string }) => a.ruleCode);
    expect(codes).toEqual(expect.arrayContaining(['REUTILISATION_APPAREIL', 'ANNULATIONS_EXONERATIONS_ANORMALES', 'QUITTANCE_MANIPULEE']));
    // Idempotence : une même situation ne produit qu'une alerte ouverte.
    const again = (await env.req('POST', '/v1/integrite/detection/run', 'u-enqueteur')).json();
    expect(again.alerts.filter((a: { ruleCode: string }) => a.ruleCode === 'REUTILISATION_APPAREIL')).toHaveLength(0);
    const scores = (await env.req('GET', '/v1/integrite/scores', 'u-enqueteur')).json();
    expect(scores.items.length).toBeGreaterThan(0);
    for (let i = 1; i < scores.items.length; i++) expect(scores.items[i - 1].score).toBeGreaterThanOrEqual(scores.items[i].score);
    const reuse = scores.items.find((s: { ruleLabel: string }) => s.ruleLabel === 'Réutilisation d’un appareil entre comptes');
    expect(reuse).toMatchObject({ score: 56, band: 'MOYEN', confidence: 'MOYENNE', automaticEffect: 'AUCUN' });
    expect(reuse.factors.map((f: { factor: string }) => f.factor)).toEqual(['Gravité', 'Confiance']);
    expect(reuse.variables.every((v: { source: string }) => v.source.length > 0)).toBe(true);
    expect(scores.weights.statut).toMatch(/PAR_DEFAUT/);
    expect((await env.req('GET', '/v1/integrite/scores', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', `/v1/integrite/alerts/${reuse.alertId}/score`, 'u-enqueteur')).json().score).toBe(56);
  });

  it('dossier ouvert à partir d’un signal ; suspension conservatoire proposée, exécutée par une personne distincte, effective, levée ; échéance', async () => {
    const env = await setup();
    plantSignals(env);
    const run = (await env.req('POST', '/v1/integrite/detection/run', 'u-enqueteur')).json();
    const alert = run.alerts.find((a: { ruleCode: string }) => a.ruleCode === 'REUTILISATION_APPAREIL');
    const c = (await env.req('POST', '/v1/integrite/cases', 'u-enqueteur', { title: 'Terminal partagé', reason: 'Signal de réutilisation d’appareil à instruire', alertIds: [alert.id] })).json();
    expect(c.implicatedUserIds).toEqual(expect.arrayContaining(['u-agent-terrain', 'u-agent-terrain-2']));
    const base = `/v1/integrite/cases/${c.id}/suspensions-conservatoires`;
    expect((await env.req('POST', base, 'u-enqueteur', { userId: 'u-agent-terrain-2', days: 99, reason: 'Mesure conservatoire pendant l’instruction du dossier' })).json().code).toBe('DURATION_OUT_OF_RANGE');
    expect((await env.req('POST', base, 'u-enqueteur', { userId: 'u-controleur', days: 5, reason: 'Mesure conservatoire pendant l’instruction du dossier' })).json().code).toBe('NOT_IMPLICATED');
    const s = (await env.req('POST', base, 'u-enqueteur', { userId: 'u-agent-terrain-2', days: 5, reason: 'Mesure conservatoire pendant l’instruction du dossier' })).json();
    expect(s.status).toBe('PROPOSEE');
    // Avant exécution, le compte fonctionne encore.
    expect((await env.req('GET', '/v1/obligations', 'u-agent-terrain-2')).json().code).not.toBe('ACCESS_SUSPENDED_PRECAUTIONARY');
    expect((await env.req('POST', `/v1/integrite/suspensions-conservatoires/${s.id}/decision`, 'u-enqueteur', { execute: true, reason: 'Auto-exécution' })).statusCode).toBe(403);
    const ex = (await env.req('POST', `/v1/integrite/suspensions-conservatoires/${s.id}/decision`, 'u-rssi', { execute: true, reason: 'Mesure conservatoire exécutée' })).json();
    expect(ex.status).toBe('EN_VIGUEUR');
    const blocked = await env.req('GET', '/v1/obligations', 'u-agent-terrain-2');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('ACCESS_SUSPENDED_PRECAUTIONARY');
    await env.req('POST', `/v1/integrite/suspensions-conservatoires/${s.id}/levee`, 'u-rssi', { reason: 'Instruction avancée : mesure plus nécessaire' });
    expect((await env.req('GET', '/v1/obligations', 'u-agent-terrain-2')).json().code).not.toBe('ACCESS_SUSPENDED_PRECAUTIONARY');
    // Nouvelle mesure, échue à la date prévue (heure du serveur).
    const s2 = (await env.req('POST', base, 'u-enqueteur', { userId: 'u-agent-terrain', days: 2, reason: 'Mesure conservatoire pendant l’instruction du dossier' })).json();
    await env.req('POST', `/v1/integrite/suspensions-conservatoires/${s2.id}/decision`, 'u-rssi', { execute: true, reason: 'Mesure conservatoire exécutée' });
    expect((await env.req('GET', '/v1/obligations', 'u-agent-terrain')).statusCode).toBe(403);
    env.clock.advance(3 * 86_400_000);
    const list = (await env.req('GET', '/v1/integrite/suspensions-conservatoires', 'u-rssi')).json();
    expect(list.find((x: { id: string }) => x.id === s2.id).status).toBe('EXPIREE');
    expect((await env.req('GET', '/v1/obligations', 'u-agent-terrain')).json().code).not.toBe('ACCESS_SUSPENDED_PRECAUTIONARY');
  });

  it('transmission à l’autorité compétente après décision de saisine : bordereau scellé, accusé ; déperdition évitée ; indicateurs', async () => {
    const env = await setup();
    plantSignals(env);
    const run = (await env.req('POST', '/v1/integrite/detection/run', 'u-enqueteur')).json();
    const alert = run.alerts.find((a: { ruleCode: string }) => a.ruleCode === 'QUITTANCE_MANIPULEE');
    const c = (await env.req('POST', '/v1/integrite/cases', 'u-enqueteur', { title: 'Fausse quittance', reason: 'Code présenté plusieurs fois sans correspondance', alertIds: [alert.id] })).json();
    await env.req('POST', `/v1/integrite/cases/${c.id}/evidence`, 'u-enqueteur', { sha256: 'b'.repeat(64), label: 'Photographie de la fausse quittance' });
    expect((await env.req('POST', `/v1/integrite/cases/${c.id}/transmission`, 'u-decideur', { authority: 'Parquet de Kinshasa/Gombe' })).json().code).toBe('NO_REFERRAL_DECISION');
    await env.req('POST', `/v1/integrite/cases/${c.id}/conclusions`, 'u-enqueteur', { finding: 'FONDE', summary: 'Quittance contrefaite en circulation, auteur non identifié.', recommendation: 'SAISINE_AUTORITE_COMPETENTE' });
    expect((await env.req('POST', `/v1/integrite/cases/${c.id}/decision`, 'u-decideur', { decision: 'SAISINE_AUTORITE_COMPETENTE', reason: 'Contrefaçon de quittance : saisine du parquet compétent.' })).statusCode).toBe(200);
    const t = (await env.req('POST', `/v1/integrite/cases/${c.id}/transmission`, 'u-decideur', { authority: 'Parquet de Kinshasa/Gombe' })).json();
    expect(t.bordereau.pieces).toEqual([{ sha256: 'b'.repeat(64), label: 'Photographie de la fausse quittance' }]);
    expect(t.bordereauHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await env.req('GET', `/v1/integrite/transmissions/${t.id}/verification`, 'u-enqueteur')).json().valid).toBe(true);
    expect((await env.req('POST', `/v1/integrite/cases/${c.id}/transmission`, 'u-decideur', { authority: 'Autre' })).json().code).toBe('ALREADY_TRANSMITTED');
    expect((await env.req('POST', `/v1/integrite/transmissions/${t.id}/accuse`, 'u-decideur', { reference: 'RP 1234/2026' })).json().acknowledgement.reference).toBe('RP 1234/2026');
    await env.req('POST', `/v1/integrite/cases/${c.id}/deperdition-evitee`, 'u-enqueteur', { amount: { amount: '120.00', currency: 'USD' }, evidenceSha256: 'c'.repeat(64), motif: 'Paiements détournés évités après retrait de la fausse quittance' });
    const ind = (await env.req('GET', '/v1/integrite/renseignement/indicateurs', 'u-enqueteur')).json();
    expect(ind.alertes.ouvertes).toBeGreaterThan(0);
    expect(ind.alertes.resolues).toBeGreaterThanOrEqual(1);
    expect(ind.delaiInstruction.statut).toBe('MESURE');
    expect(ind.deperditionEvitee).toMatchObject({ statut: 'MESURE', montants: { USD: '120.00' } });
    expect(ind.transmissions).toEqual({ total: 1, accusees: 1 });
  });
});
