/**
 * Module 35 — Inspection et constat : dossier d'inspection préparé par objet, paquet hors ligne signé de la mission,
 * procès-verbal selon les pouvoirs légaux (signature ou refus), géorepérage repris du constat, transmission au
 * superviseur, validation par une personne distincte, constat et procès-verbal validés jamais modifiés, contestation.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { terrainPlugin, type TerrainService } from '../src/plugins/terrain/plugin.js';
import type { TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: [terrainPlugin], secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} } });
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
const terrain = (env: TestEnv) => env.app.ctx.ext.terrain as TerrainService;
const SIG = 'e'.repeat(64);

describe('Module 35 — inspection et constat', () => {
  it('dossiers préparés avant visite, paquet hors ligne signé (sans montant), vérifiable ; agent non affecté refusé', async () => {
    const env = await setup();
    expect((await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/dossiers-inspection', 'u-agent-terrain')).statusCode).toBe(403);
    const prep = await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/dossiers-inspection', 'u-superviseur');
    expect(prep.statusCode).toBe(201);
    const dossiers = prep.json();
    expect(dossiers).toHaveLength(2);
    expect(dossiers[0]).toMatchObject({ version: 1, content: { object: { commune: expect.any(String) }, checklist: expect.any(Array) } });
    expect(dossiers[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Nouvelle préparation : nouvelle version, l'ancienne est conservée.
    const again = (await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/dossiers-inspection', 'u-superviseur')).json();
    expect(again[0].version).toBe(2);
    expect(terrain(env).inspection!.dossiers.count()).toBe(4);

    const pkg = await env.req('GET', '/v1/terrain/missions/MIS-LIM-014/paquet-hors-ligne', 'u-agent-terrain');
    expect(pkg.statusCode).toBe(200);
    const body = pkg.json();
    expect(body.dossiers).toHaveLength(2);
    expect(body.dossiers.every((d: { version: number }) => d.version === 2)).toBe(true);
    expect(body.templates.map((t: { id: string }) => t.id)).toEqual(['PV-CONSTAT-OBJET']);
    expect(body.validUntil.startsWith(body.mission.dueDate)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"amount"|paymentReference/);
    expect((await env.req('POST', '/v1/terrain/paquets/verification', 'u-agent-terrain', body)).json()).toEqual({ valid: true });
    const tampered = { ...body, dossiers: body.dossiers.slice(1) };
    expect((await env.req('POST', '/v1/terrain/paquets/verification', 'u-agent-terrain', tampered)).json().valid).toBe(false);
    expect((await env.req('GET', '/v1/terrain/missions/MIS-LIM-014/paquet-hors-ligne', 'u-agent-gombe')).json().code).toBe('MISSION_NOT_ASSIGNED');
  });

  it('procès-verbal selon les pouvoirs, signature ou refus, validation distincte, figé après validation, contestation et réponse', async () => {
    const env = await setup();
    const f = terrain(env).findings.findOne((x) => x.clientRef === 'demo-2')!;
    const base = { clientRef: 'pv-1', findingId: f.id, personDeclaration: 'Le locataire déclare occuper l’unité depuis 2024.', signedAt: '2026-09-26T08:30:00.000Z' };
    // Pouvoir non détenu (agent R10 : constat seulement).
    expect((await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain', { ...base, templateId: 'PV-CONTROLE', signature: { kind: 'SIGNE', signerName: 'X Y', signatureImageSha256: SIG } })).json().code).toBe('POWER_NOT_HELD');
    // Refus de signer sans mention : refusé.
    expect((await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain', { ...base, templateId: 'PV-CONSTAT-OBJET', signature: { kind: 'REFUS_DE_SIGNER' } })).json().code).toBe('REFUSAL_NOTE_REQUIRED');
    // Un autre agent que l'auteur du constat : refusé.
    expect((await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain-2', { ...base, templateId: 'PV-CONSTAT-OBJET', signature: { kind: 'PERSONNE_ABSENTE' } })).statusCode).toBe(403);
    const created = await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain', { ...base, templateId: 'PV-CONSTAT-OBJET', signature: { kind: 'REFUS_DE_SIGNER', refusalNote: 'La personne refuse de signer mais accepte la remise d’une copie.' } });
    expect(created.statusCode).toBe(201);
    const pv = created.json();
    expect(pv.number).toMatch(/^PV-2026-\d{6}$/);
    expect(pv).toMatchObject({ status: 'TRANSMIS', power: 'CONSTAT_OBJET', findingSeal: f.seal, gps: f.gps, distanceM: f.distanceM });
    // Rejeu identique : même procès-verbal ; contenu différent sous la même référence : 409.
    expect((await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain', { ...base, templateId: 'PV-CONSTAT-OBJET', signature: { kind: 'REFUS_DE_SIGNER', refusalNote: 'La personne refuse de signer mais accepte la remise d’une copie.' } })).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain', { ...base, templateId: 'PV-CONSTAT-OBJET', signature: { kind: 'PERSONNE_ABSENTE' } })).json().code).toBe('CLIENT_REF_REUSED');

    // Rectification avant validation : nouvelle version, l'ancienne remplacée et conservée.
    const v2 = (await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain', { ...base, clientRef: 'pv-1b', supersedes: pv.id, templateId: 'PV-CONSTAT-OBJET', signature: { kind: 'SIGNE', signerName: 'Nzuzi Makiese', signatureImageSha256: SIG } })).json();
    expect(v2).toMatchObject({ version: 2, supersedes: pv.id, status: 'TRANSMIS' });
    expect(terrain(env).inspection!.getPv(pv.id).status).toBe('REMPLACE');

    // Validation : jamais par l'auteur ; par le superviseur.
    expect((await env.req('POST', `/v1/terrain/proces-verbaux/${v2.id}/decision`, 'u-agent-terrain', { decision: 'VALIDE', reason: 'Auto-validation' })).statusCode).toBe(403);
    const ok = (await env.req('POST', `/v1/terrain/proces-verbaux/${v2.id}/decision`, 'u-superviseur', { decision: 'VALIDE', reason: 'Constat géorepéré et signé : conforme.' })).json();
    expect(ok.status).toBe('VALIDE');
    // Procès-verbal validé : jamais modifié (ni décision nouvelle, ni rectification).
    expect((await env.req('POST', `/v1/terrain/proces-verbaux/${v2.id}/decision`, 'u-controleur', { decision: 'REJETE', reason: 'Tentative de modification' })).json().code).toBe('PV_VALIDATED_IMMUTABLE');
    expect((await env.req('POST', '/v1/terrain/proces-verbaux', 'u-agent-terrain', { ...base, clientRef: 'pv-1c', supersedes: v2.id, templateId: 'PV-CONSTAT-OBJET', signature: { kind: 'PERSONNE_ABSENTE' } })).json().code).toBe('PV_VALIDATED_IMMUTABLE');

    // Contestation par la personne concernée (propriétaire de l'objet) ; réponse motivée par une personne distincte de l'auteur.
    const obj = env.app.ctx.objects.objects.get(f.objectId!)!;
    const owner = env.app.ctx.users.all().find((u) => u.taxpayerId === obj.taxpayerId && u.roles.includes('R30'));
    const contester = owner?.id ?? 'u-guichet';
    const contested = (await env.req('POST', `/v1/terrain/proces-verbaux/${v2.id}/contestations`, contester, { text: 'Je conteste : l’unité est vacante depuis août.' })).json();
    expect(contested.contestations[0].acknowledgement).toMatch(/^Accusé de réception/);
    if (owner) expect((await env.req('POST', `/v1/terrain/proces-verbaux/${v2.id}/contestations`, 'u-contribuable', { text: 'Contestation d’un tiers non concerné.' })).statusCode).toBe(owner.id === 'u-contribuable' ? 201 : 403);
    const cid = contested.contestations[0].id;
    expect((await env.req('POST', `/v1/terrain/proces-verbaux/${v2.id}/contestations/${cid}/reponse`, 'u-controleur', { text: 'Contre-visite programmée ; la situation sera revue.' })).json().contestations[0].answer.by).toBe('u-controleur');

    // Indicateurs : constats, taux de validation, contestations.
    const ind = (await env.req('GET', '/v1/terrain/inspection/indicateurs', 'u-superviseur')).json();
    expect(ind.procesVerbaux).toMatchObject({ valides: 1, refusDeSigner: 0 });
    expect(ind.contestations.total).toBeGreaterThanOrEqual(1);
    expect(ind.tauxValidation.statut).toBe('MESURE');
  });

  it('constat validé jamais modifié : nouvelle revue refusée, référence réutilisée avec un autre contenu refusée', async () => {
    const env = await setup();
    const f = terrain(env).findings.findOne((x) => x.clientRef === 'demo-1')!;
    expect(f.status).toBe('VALIDE');
    expect((await env.req('POST', `/v1/terrain/findings/${f.id}/review`, 'u-superviseur', { decision: 'REJETE', reason: 'Tentative de modification' })).json().code).toBe('FINDING_ALREADY_REVIEWED');
    const res = await env.req('POST', `/v1/terrain/missions/${f.missionId}/findings`, 'u-agent-terrain', { clientRef: 'demo-1', objectId: f.objectId, outcome: 'ABSENT', observations: 'Contenu modifié', gps: f.gps, capturedAt: f.capturedAt });
    expect(res.json().code).toBe('CLIENT_REF_REUSED');
  });

  it('module 34 : itinéraire de la mission ; objet « non enregistré » : fiche provisoire à identifiant provisoire, sans effet fiscal', async () => {
    const env = await setup();
    const it1 = (await env.req('GET', '/v1/terrain/missions/MIS-LIM-014/itineraire', 'u-agent-terrain')).json();
    expect(it1.steps.map((s: { order: number }) => s.order)).toEqual([1, 2]);
    expect(it1.steps[1].cumulativeM).toBeGreaterThanOrEqual(it1.steps[0].cumulativeM);
    const f = terrain(env).findings.findOne((x) => x.clientRef === 'demo-st-1')!;
    const author = f.agentId;
    expect((await env.req('POST', `/v1/terrain/findings/${f.id}/objet-provisoire`, 'u-agent-gombe', { category: 'ACTIVITE', quartier: 'Kingabwa', localityRank: 3 })).statusCode).toBe(403);
    const created = await env.req('POST', `/v1/terrain/findings/${f.id}/objet-provisoire`, author === 'terrain-st-agent-1' ? 'u-controleur' : author, { category: 'ACTIVITE', quartier: 'Kingabwa', localityRank: 3 });
    expect(created.statusCode).toBe(201);
    const obj = created.json();
    expect(obj).toMatchObject({ id: `OBJ-PROV-${f.id}`, status: 'PROVISOIRE', commune: f.commune, lat: f.gps.lat, lon: f.gps.lon });
    expect(obj.taxpayerId).toBeUndefined();
    expect(env.app.ctx.assessment.obligations.find((o) => o.objectId === obj.id)).toHaveLength(0);
    expect((await env.req('POST', `/v1/terrain/findings/${f.id}/objet-provisoire`, 'u-controleur', { category: 'ACTIVITE', quartier: 'Kingabwa', localityRank: 3 })).statusCode).toBe(200);
    const demo1 = terrain(env).findings.findOne((x) => x.clientRef === 'demo-1')!;
    expect((await env.req('POST', `/v1/terrain/findings/${demo1.id}/objet-provisoire`, 'u-controleur', { category: 'ACTIVITE', quartier: 'Kingabwa', localityRank: 3 })).json().code).toBe('NOT_UNREGISTERED_FINDING');
  });
});
