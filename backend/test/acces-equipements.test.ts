import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { canonicalJson, hmacSha256Hex } from '../src/core/crypto.js';
import type { DelegationService } from '../src/plugins/acces/delegations.js';
import { DEMO_APP_SIGNATURE, type EquipementService } from '../src/plugins/equipements/service.js';

async function full() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return { app, clock, req, ctx: app.ctx, del: app.ctx.ext['acces-delegations'] as DelegationService, eq: app.ctx.ext.equipements as EquipementService };
}

describe('Module 51 — accès et délégations', () => {
  it('délégation temporaire sans élévation, approuvée par une autre personne, retirée automatiquement à l’échéance', async () => {
    const { req, ctx, clock } = await full();
    // Pas d'élévation : on ne délègue pas un rôle qu'on ne détient pas ; rôles privilégiés non délégables.
    expect((await req('POST', '/v1/acces/delegations', 'u-controleur', { delegateId: 'u-guichet', roles: ['R06'], motif: 'Congé annuel du titulaire', from: '2026-09-26', to: '2026-10-10' })).json().code).toBe('NO_ELEVATION');
    expect((await req('POST', '/v1/acces/delegations', 'u-tresor', { delegateId: 'u-analyste-rappro', roles: ['R17'], motif: 'Congé annuel du titulaire', from: '2026-09-26', to: '2026-10-10' })).json().code).toBe('NON_DELEGABLE_ROLE');
    // Durée maximale (par défaut) ; même entité.
    expect((await req('POST', '/v1/acces/delegations', 'u-controleur', { delegateId: 'u-guichet', roles: ['R11'], motif: 'Congé annuel du titulaire', from: '2026-09-26', to: '2027-03-01' })).json().code).toBe('DELEGATION_TOO_LONG');
    expect((await req('POST', '/v1/acces/delegations', 'u-controleur', { delegateId: 'u-tresor', roles: ['R11'], motif: 'Congé annuel du titulaire', from: '2026-09-26', to: '2026-10-10' })).json().code).toBe('OUT_OF_ENTITY');
    const d = (await req('POST', '/v1/acces/delegations', 'u-controleur', { delegateId: 'u-guichet', roles: ['R11'], motif: 'Congé annuel du titulaire', from: '2026-09-26', to: '2026-10-10' })).json();
    expect(d.status).toBe('PROPOSEE');
    expect((await req('POST', `/v1/acces/delegations/${d.id}/decision`, 'u-controleur', { approve: true, motif: 'Auto-approbation interdite' })).statusCode).toBe(403);
    const ok = (await req('POST', `/v1/acces/delegations/${d.id}/decision`, 'u-admin-entite', { approve: true, motif: 'Intérim validé par l’administrateur' })).json();
    expect(ok.status).toBe('ACTIVE');
    expect(ctx.users.get('u-guichet')!.roles).toContain('R11');
    clock.advance(16 * 86_400_000);
    const sw = (await req('POST', '/v1/acces/echeancier', 'u-rssi')).json();
    expect(sw.delegationsExpired).toEqual([d.id]);
    expect(ctx.users.get('u-guichet')!.roles).not.toContain('R11');
    const actions = ctx.audit.list({ limit: 1_000_000 }).items.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['acces.delegation.requested', 'acces.delegation.granted', 'acces.delegation.expired']));
  });

  it('cumul incompatible refusé (§ 12.5) ; conflits d’intérêts et privilèges excessifs détectés ; indicateurs', async () => {
    const { req, ctx } = await full();
    // Délégation qui créerait un cumul incompatible (R13 rédacteur + R14 vérificateur).
    expect((await req('POST', '/v1/acces/delegations', 'u-juriste-redacteur', { delegateId: 'u-juriste-verificateur', roles: ['R13'], motif: 'Intérim de rédaction juridique', from: '2026-09-26', to: '2026-10-10' })).json().code).toBe('INCOMPATIBLE_ROLES');
    // Dérive du répertoire (rôle ajouté hors circuit) : le cumul incompatible est détecté.
    const au = ctx.users.get('u-auditeur')! as { roles: string[] };
    au.roles = [...au.roles, 'R17'];
    const v = (await req('GET', '/v1/acces/delegations', 'u-rssi')).json();
    expect(v.detections.some((x: { kind: string; userId: string }) => x.kind === 'CONFLIT_INTERETS' && x.userId === 'u-auditeur')).toBe(true);
    expect(v.indicators.map((i: { code: string }) => i.code)).toEqual(['ACCES_REVUS', 'PRIVILEGES_EXCESSIFS']);
    expect(ctx.alerts.alerts.all().some((a) => a.type === 'ACCES_CONFLIT_INTERETS')).toBe(true);
  });

  it('comptes partagés interdits : un compte de travail utilisé depuis plusieurs appareils est signalé', async () => {
    const { req } = await full();
    for (const fp of ['fp-a1', 'fp-b2', 'fp-c3']) await req('GET', '/v1/decision/salle-controle', 'u-tresor', undefined, { 'x-mosolo-device-fingerprint': fp });
    const v = (await req('GET', '/v1/acces/delegations', 'u-rssi')).json();
    expect(v.detections.some((x: { kind: string; userId: string }) => x.kind === 'COMPTE_PARTAGE' && x.userId === 'u-tresor')).toBe(true);
  });

  it('RBAC + ABAC expliqué : rôle, territoire, période, appareil, sensibilité', async () => {
    const { req } = await full();
    const e = (body: Record<string, unknown>) => req('POST', '/v1/acces/abac/explication', 'u-rssi', body).then((r) => r.json());
    const ok = await e({ userId: 'u-agent-terrain', action: 'field.sync', commune: 'Limete', deviceId: 'dev-terrain-001' });
    expect(ok.decision).toBe('AUTORISE');
    const outside = await e({ userId: 'u-agent-terrain', action: 'field.sync', commune: 'Gombe', deviceId: 'dev-terrain-001' });
    expect(outside.checks.find((c: { attribute: string }) => c.attribute === 'TERRITOIRE').ok).toBe(false);
    const lost = await e({ userId: 'u-agent-terrain', action: 'field.sync', deviceId: 'dev-terrain-perdu' });
    expect(lost.checks.find((c: { attribute: string }) => c.attribute === 'APPAREIL').ok).toBe(false);
    const sens = await e({ userId: 'u-guichet', action: 'taxpayer.read', sensitivity: 'SENSIBLE' });
    expect(sens.checks.find((c: { attribute: string }) => c.attribute === 'SENSIBILITE').ok).toBe(false);
    expect(sens.decision).toBe('REFUSE');
    expect((await req('POST', '/v1/acces/abac/explication', 'u-guichet', { userId: 'u-guichet', action: 'taxpayer.read' })).statusCode).toBe(403);
  });

  it('révocation automatique à la fin d’une affectation : habilitation terrain échue ⇒ agent, badge et terminal révoqués', async () => {
    const { req, ctx, clock } = await full();
    const terrain = ctx.ext.terrain as { agents: { get(id: string): { status: string; habilitation?: { validUntil: string } } | undefined } };
    const until = terrain.agents.get('u-agent-terrain')!.habilitation!.validUntil;
    clock.set(`${until}T12:00:00.000Z`);
    expect((await req('POST', '/v1/acces/echeancier', 'u-rssi')).json().assignmentsRevoked).not.toContain('u-agent-terrain');
    clock.advance(2 * 86_400_000);
    const sw = (await req('POST', '/v1/acces/echeancier', 'u-rssi')).json();
    expect(sw.assignmentsRevoked).toContain('u-agent-terrain');
    expect(terrain.agents.get('u-agent-terrain')!.status).toBe('REVOQUE');
    expect(ctx.field.devices.get('dev-terrain-001')!.status).toBe('REVOQUE');
  });
});

describe('Module 58 — gestion des équipements terrain', () => {
  const signed = (key: string, body: unknown) => { const raw = JSON.stringify(body); return { raw, sig: hmacSha256Hex(key, raw) }; };
  const clean = { osVersion: 13, appSignatureSha256: DEMO_APP_SIGNATURE, rooted: false, bootloaderUnlocked: false, emulator: false, debuggable: false, encrypted: true };

  it('enrôlement MDM (bac à sable), liaison appareil–utilisateur attestée, politique et purge des données', async () => {
    const { req } = await full();
    const en = await req('POST', '/v1/equipements/terminaux', 'u-rssi', { deviceId: 'dev-test-58', userId: 'u-agent-terrain-2', model: 'Terminal de test', os: 'Android 13' });
    expect(en.statusCode).toBe(201);
    const key = en.json().deviceKeyOnce as string;
    expect(en.json().equipment.mdm.ref).toMatch(/^sandbox-mdm-/);
    const ch = (await req('POST', '/v1/equipements/terminaux/dev-test-58/attestation/defi', 'u-agent-terrain-2')).json();
    expect((await req('POST', '/v1/equipements/terminaux/dev-test-58/attestation', 'u-agent-terrain', { nonce: ch.nonce, signature: hmacSha256Hex(key, `dev-test-58|u-agent-terrain|${ch.nonce}`) })).statusCode).toBe(403);
    expect((await req('POST', '/v1/equipements/terminaux/dev-test-58/attestation', 'u-agent-terrain-2', { nonce: ch.nonce, signature: 'f'.repeat(64) })).statusCode).toBe(401);
    const ch2 = (await req('POST', '/v1/equipements/terminaux/dev-test-58/attestation/defi', 'u-agent-terrain-2')).json();
    const at = await req('POST', '/v1/equipements/terminaux/dev-test-58/attestation', 'u-agent-terrain-2', { nonce: ch2.nonce, signature: hmacSha256Hex(key, `dev-test-58|u-agent-terrain-2|${ch2.nonce}`) });
    expect(at.json().binding.status).toBe('ATTESTEE');
    const s = signed(key, clean);
    const r = await req('POST', '/v1/equipements/terminaux/dev-test-58/signalement', 'u-agent-terrain-2', s.raw, { 'x-device-signature': s.sig });
    expect(r.statusCode).toBe(200);
    expect(r.json().verdict).toBe('CONFORME');
    expect(r.json().dataExpiry.purgeBefore).toBe('2026-09-19T09:00:00.000Z');
    // Signalement non signé : refusé.
    expect((await req('POST', '/v1/equipements/terminaux/dev-test-58/signalement', 'u-agent-terrain-2', s.raw, { 'x-device-signature': '0'.repeat(64) })).statusCode).toBe(401);
  });

  it('appareil modifié détecté ⇒ quarantaine, synchronisation refusée, alerte ; levée par une personne après remise en état', async () => {
    const { req, ctx } = await full();
    const key = 'demo-device-key-001';
    const bad = signed(key, { ...clean, rooted: true, appSignatureSha256: 'e'.repeat(64) });
    const r = (await req('POST', '/v1/equipements/terminaux/dev-terrain-001/signalement', 'u-agent-terrain', bad.raw, { 'x-device-signature': bad.sig })).json();
    expect(r.verdict).toBe('MODIFIE');
    expect(r.state).toBe('QUARANTAINE');
    expect(r.reasons.join(' ')).toMatch(/racine/);
    expect(ctx.alerts.alerts.all().some((a) => a.type === 'APPAREIL_MODIFIE')).toBe(true);
    const batch = { batchId: 'B-58-1', deviceId: 'dev-terrain-001', createdAt: '2026-09-26T09:00:00.000Z', operations: [] };
    const raw = JSON.stringify(batch);
    const sync = await req('POST', '/v1/field-sync/batches', 'u-agent-terrain', raw, { 'x-device-signature': hmacSha256Hex(key, raw) });
    expect(sync.statusCode).toBe(403);
    expect(sync.json().code).toBe('DEVICE_QUARANTINED');
    // Levée refusée tant que le dernier signalement est non conforme ; puis décidée par la sécurité.
    expect((await req('POST', '/v1/equipements/terminaux/dev-terrain-001/levee-quarantaine', 'u-rssi', { motif: 'Remise en état vérifiée' })).statusCode).toBe(409);
    const good = signed(key, clean);
    await req('POST', '/v1/equipements/terminaux/dev-terrain-001/signalement', 'u-agent-terrain', good.raw, { 'x-device-signature': good.sig });
    expect((await req('POST', '/v1/equipements/terminaux/dev-terrain-001/levee-quarantaine', 'u-rssi', { motif: 'Terminal réinitialisé et vérifié' })).json().state).toBe('ACTIF');
    expect((await req('POST', '/v1/field-sync/batches', 'u-agent-terrain', raw, { 'x-device-signature': hmacSha256Hex(key, raw) })).statusCode).toBe(200);
    void canonicalJson;
  });

  it('expiration automatique des données (terminal silencieux), effacement à distance acquitté, révocation et indicateurs', async () => {
    const { req, clock, eq } = await full();
    clock.advance(8 * 86_400_000);
    const exp = (await req('POST', '/v1/equipements/echeancier', 'u-rssi')).json();
    expect(exp.dataExpired).toContain('dev-terrain-002');
    const w = (await req('POST', '/v1/equipements/terminaux/dev-terrain-002/effacement', 'u-rssi', { motif: 'Terminal remis au magasin' })).json();
    const cmds = w.commands.filter((c: { status: string }) => c.status === 'EN_ATTENTE').map((c: { id: string }) => c.id);
    expect(cmds.length).toBe(2);
    const s = signed('demo-device-key-002', { ...clean, acknowledgedCommands: cmds });
    const r = (await req('POST', '/v1/equipements/terminaux/dev-terrain-002/signalement', 'u-agent-terrain-2', s.raw, { 'x-device-signature': s.sig })).json();
    expect(r.pendingCommands).toHaveLength(0);
    expect(r.state).toBe('ACTIF');
    // Perte déclarée par l'agent : révocation, effacement programmé, incident.
    expect((await req('POST', '/v1/equipements/terminaux/dev-terrain-002/perte', 'u-agent-terrain-2', { motif: 'Terminal perdu au marché' })).json().state).toBe('REVOQUE');
    expect(eq.equipments.get('dev-terrain-002')!.commands.at(-1)!.kind).toBe('EFFACEMENT');
    const v = (await req('GET', '/v1/equipements', 'u-rssi')).json();
    expect(v.mdm.label).toMatch(/À RACCORDER — convention requise/);
    expect(v.indicators.map((i: { code: string }) => i.code)).toEqual(['TERMINAUX_ACTIFS', 'INCIDENTS', 'REVOCATIONS']);
    expect(Number(v.indicators.find((i: { code: string }) => i.code === 'REVOCATIONS').value)).toBeGreaterThanOrEqual(2);
    expect((await req('GET', '/v1/equipements', 'u-contribuable')).statusCode).toBe(403);
  });

  it('révocation en masse : la suspension d’un agent (ou de son sous-traitant) révoque ses terminaux et programme l’effacement', async () => {
    const { req, eq } = await full();
    const r = await req('POST', '/v1/terrain/agents/u-agent-gombe/suspend', 'terrain-resp-module', { reason: 'Suspension conservatoire (test)' });
    expect(r.statusCode).toBe(200);
    const e = eq.equipments.get('dev-u-agent-gombe')!;
    expect(e.state).toBe('REVOQUE');
    expect(e.commands.some((c) => c.kind === 'EFFACEMENT' && c.status === 'EN_ATTENTE')).toBe(true);
  });

  it('téléphone personnel (29/09/2026) : défaut à l’enrôlement, politique au périmètre APPLICATION, effacement des seules données MOSOLO, charte acceptée par l’agent', async () => {
    const { req, eq } = await full();
    const en = (await req('POST', '/v1/equipements/terminaux', 'u-rssi', { deviceId: 'dev-perso-01', userId: 'u-agent-terrain-2', model: 'Téléphone de l’agent', os: 'Android 14' })).json();
    expect(en.equipment.ownership).toBe('PERSONNEL');
    expect(en.equipment.policyCode).toBe('TERRAIN-PERSONNEL');
    expect(en.charte.texte.join(' ')).toMatch(/seules les données de l’application MOSOLO/);
    // Jamais de politique « appareil entier » sur un téléphone personnel.
    expect((await req('POST', '/v1/equipements/terminaux', 'u-rssi', { deviceId: 'dev-perso-02', userId: 'u-agent-terrain-2', model: 'Téléphone', os: 'iOS 17', policyCode: 'TERRAIN-STANDARD' })).json().code).toBe('POLICY_SCOPE_PERSONAL');
    // Charte : acceptée par l'agent affecté seulement.
    expect((await req('POST', '/v1/equipements/terminaux/dev-perso-01/charte', 'u-rssi', { version: '1' })).statusCode).toBe(403);
    expect((await req('POST', '/v1/equipements/terminaux/dev-perso-01/charte', 'u-agent-terrain-2', { version: '1' })).json().charte.version).toBe('1');
    // Effacement et perte : données MOSOLO seulement.
    const w = (await req('POST', '/v1/equipements/terminaux/dev-perso-01/effacement', 'u-rssi', { motif: 'Départ de l’agent du programme' })).json();
    expect(w.commands.at(-1)).toMatchObject({ kind: 'EFFACEMENT', perimetre: 'APPLICATION' });
    await req('POST', '/v1/equipements/terminaux/dev-perso-01/perte', 'u-agent-terrain-2', { motif: 'Téléphone volé au marché' });
    expect(eq.equipments.get('dev-perso-01')!.commands.at(-1)).toMatchObject({ kind: 'EFFACEMENT', perimetre: 'APPLICATION' });
    // Terminal de la Province : mode antérieur conservé (appareil entier).
    await req('POST', '/v1/equipements/terminaux', 'u-rssi', { deviceId: 'dev-prov-01', userId: 'u-agent-terrain-2', model: 'Terminal Province', os: 'Android 13', ownership: 'PROVINCE' });
    const wp = (await req('POST', '/v1/equipements/terminaux/dev-prov-01/effacement', 'u-rssi', { motif: 'Terminal remis au magasin' })).json();
    expect(wp.policyCode).toBe('TERRAIN-STANDARD');
    expect(wp.commands.at(-1)).toMatchObject({ kind: 'EFFACEMENT', perimetre: 'APPAREIL' });
    const v = (await req('GET', '/v1/equipements', 'u-rssi')).json();
    expect(v.personnel.chartesAcceptees).toBeGreaterThanOrEqual(1);
    expect(v.personnel.terminauxProvince).toBe(1);
  });
});
