import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { ASSIST_ON_SITE_M } from '../src/plugins/canaux/assisted.js';
import { COUNTER_CHECK_RATE_PER_10K } from '../src/plugins/sanctions/counterchecks.js';
import { integritePlugin } from '../src/plugins/integrite/plugin.js';
import { collusionSchedulerEnabled, integriteGouvernancePlugin } from '../src/plugins/integrite/gouvernance/plugin.js';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { assertKeyHealthAtBoot, classifyBootKeyHealth, keyHealth } from '../src/plugins/integrite/gouvernance/cles.js';
import { ConfigurationError } from '../src/core/auth.js';
import { isOffHours } from '../src/plugins/integrite/gouvernance/collusion.js';
import { ALL_PARAMETERS, REPLICATED } from '../src/plugins/integrite/gouvernance/parametres.js';
import type { GouvernanceService } from '../src/plugins/integrite/gouvernance/service.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Mardi 29/09/2026, 10 h à Kinshasa (heures ouvrables). */
const START = '2026-09-29T09:00:00.000Z';

async function setupG(start = START, full = false): Promise<TestEnv & { svc: GouvernanceService }> {
  const clock = new ManualClock(start);
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    ...(full ? {} : { plugins: [integritePlugin, integriteGouvernancePlugin] }),
  });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req, svc: app.ctx.ext['integrite-gouvernance'] as GouvernanceService };
}

const user = (id: string) => ({ kind: 'user' as const, id, roles: ['R17'] });

/** Simule au journal une opération du Trésor proposée puis décidée `delayS` secondes plus tard. */
function treasuryDecision(env: TestEnv, n: number, proposer: string, approver: string, delayS: number, outcome: 'OK' | 'KO' = 'OK') {
  const id = `OPF-T${n}`;
  env.app.ctx.audit.append({ actor: user(proposer), action: 'treasury.operation.proposed', resourceType: 'financial_operation', resourceId: id, details: {} });
  env.clock.advance(delayS * 1000);
  env.app.ctx.audit.append({
    actor: user(approver), action: outcome === 'OK' ? 'treasury.operation.executed' : 'treasury.operation.rejected',
    resourceType: 'financial_operation', resourceId: id, details: outcome === 'OK' ? { proposedBy: proposer } : {},
  });
}

async function enableRotation(env: TestEnv, max?: number) {
  const propose = async (parameterId: string, proposedValue: number | boolean) => {
    const r = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { parameterId, kind: 'MODIFICATION', proposedValue, motif: 'Activation décidée en comité de contrôle interne (test).' });
    expect(r.statusCode).toBe(201);
    const d = await env.req('POST', `/v1/integrite/thresholds/change-requests/${r.json().id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Approuvé par la direction générale (test).' });
    expect(d.statusCode).toBe(200);
  };
  await propose('rotation.blocage_actif', true);
  if (max !== undefined) await propose('rotation.max_par_paire', max);
}

describe('Collusion sous quatre yeux — détection (alertes seulement)', () => {
  it('reconstitue les décisions à deux personnes depuis le journal et ignore les propositions du système', async () => {
    const env = await setupG();
    treasuryDecision(env, 1, 'u-a', 'u-b', 30);
    env.app.ctx.audit.append({ actor: { kind: 'system', id: 'canaux' }, action: 'canaux.point.suspension_dismissal_requested', resourceType: 'payment_point', resourceId: 'PT-1', details: { proposalId: 'P1' } });
    env.app.ctx.audit.append({ actor: user('u-c'), action: 'canaux.point.suspension_dismissed', resourceType: 'payment_point', resourceId: 'PT-1', details: { proposalId: 'P1' } });
    env.app.ctx.audit.append({ actor: user('u-a'), action: 'object.correction.proposed', resourceType: 'fiscal_object', resourceId: 'OBJ-1', details: { correctionId: 'C1' } });
    env.app.ctx.audit.append({ actor: user('u-d'), action: 'object.correction.rejected', resourceType: 'fiscal_object', resourceId: 'OBJ-1', details: { correctionId: 'C1' } });
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.map((d) => [d.circuit, d.proposerId, d.approverId, d.outcome, d.delaySeconds])).toEqual([
      ['TRESOR_OPERATION', 'u-a', 'u-b', 'APPROUVE', 30],
      ['OBJET_CORRECTION', 'u-a', 'u-d', 'REFUSE', 0],
    ]);
    expect(new Set(CIRCUITS.map((c) => c.code)).size).toBe(CIRCUITS.length);
  });

  it('paire concentrée, validations express, hors heures, jamais de refus : constats explicables, masqués pour la personne visée', async () => {
    const env = await setupG();
    // u-a propose 10 fois ; u-b décide 9 fois (dont 4 en 10 s), u-c une fois. u-b ne refuse jamais.
    for (let i = 0; i < 9; i++) treasuryDecision(env, i, 'u-a', 'u-b', i < 4 ? 10 : 900);
    treasuryDecision(env, 9, 'u-a', 'u-c', 900, 'KO');
    // Trois validations un samedi soir (hors heures ouvrables).
    env.clock.set('2026-10-03T20:00:00.000Z');
    for (let i = 10; i < 13; i++) treasuryDecision(env, i, 'u-e', 'u-b', 600);
    env.clock.set('2026-10-05T09:00:00.000Z');

    const r = await env.req('GET', '/v1/integrite/collusion', 'u-auditeur');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const codes = body.findings.map((f: { code: string; subjects: string[] }) => `${f.code}:${f.subjects.join('>')}`);
    expect(codes).toContain('PAIRE_CONCENTREE:u-a>u-b');
    expect(codes).toContain('VALIDATION_EXPRESS:u-b');
    expect(codes).toContain('HORS_HEURES:u-b');
    expect(codes).toContain('JAMAIS_DE_REFUS:u-b');
    expect(codes).toContain('ROTATION_DEPASSEE:u-a>u-b');
    expect(codes.some((c: string) => c.includes('u-c'))).toBe(false);
    expect(body.automaticEffect).toBe('AUCUN');
    expect(body.totals).toMatchObject({ decisions: 13, approvals: 12, refusals: 1 });
    expect(body.params.statut).toMatch(/à confirmer par le maître d’ouvrage/);
    expect(body.rotation.enforced).toBe(false);

    // Détection : alertes dans le mécanisme commun, une seule fois par constat et par jour, aucune sanction.
    const run = await env.req('POST', '/v1/integrite/collusion/run', 'u-enqueteur');
    expect(run.statusCode).toBe(200);
    expect(run.json().raised).toBeGreaterThanOrEqual(5);
    const alerts = env.app.ctx.alerts.list().filter((a) => a.source === 'integrite:collusion');
    expect(alerts.map((a) => a.type)).toContain('COLLUSION_PAIRE_CONCENTREE');
    expect(alerts.every((a) => a.context.automaticEffect === 'AUCUN')).toBe(true);
    expect((await env.req('POST', '/v1/integrite/collusion/run', 'u-enqueteur')).json().raised).toBe(0);

    // Accès : ni contribuable ni agent de guichet.
    expect((await env.req('GET', '/v1/integrite/collusion', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/integrite/collusion/run', 'u-dg-dgipk')).statusCode).toBe(403);
  });

  it('la personne visée ne voit pas les constats qui la concernent', async () => {
    const env = await setupG();
    for (let i = 0; i < 6; i++) treasuryDecision(env, i, 'u-tresor', 'u-auditeur', 5);
    const body = (await env.req('GET', '/v1/integrite/collusion', 'u-auditeur')).json();
    expect(body.findings.filter((f: { subjects: string[] }) => f.subjects.includes('u-auditeur'))).toEqual([]);
    expect(body.masked).toBeGreaterThan(0);
    const other = (await env.req('GET', '/v1/integrite/collusion', 'u-enqueteur')).json();
    expect(other.findings.some((f: { subjects: string[] }) => f.subjects.includes('u-auditeur'))).toBe(true);
  });

  it('heures ouvrables à l’heure de Kinshasa (UTC+1), week-end hors heures', () => {
    const p = { workStartHour: 7, workEndHour: 18 };
    expect(isOffHours('2026-09-29T06:30:00.000Z', p)).toBe(false); // 7 h 30 à Kinshasa
    expect(isOffHours('2026-09-29T05:30:00.000Z', p)).toBe(true); // 6 h 30
    expect(isOffHours('2026-09-29T17:00:00.000Z', p)).toBe(true); // 18 h
    expect(isOffHours('2026-09-26T10:00:00.000Z', p)).toBe(true); // samedi
  });
});

describe('Rotation obligatoire (désactivée par défaut)', () => {
  const proposal = { alias: DEMO.dgipkAlias, bankName: 'Banque de recettes C (démo)', accountNumber: 'CD00 1111 2222 3333 4444 5555', holderName: 'DGIPK — nouveau compte (démo)', reason: 'Migration bancaire (test)' };
  const priorPairApprovals = (env: TestEnv, n: number) => {
    for (let i = 0; i < n; i++) {
      env.app.ctx.audit.append({ actor: user('u-tresor'), action: 'beneficiary.change.proposed', resourceType: 'beneficiary_change', resourceId: `CHG-OLD-${i}`, details: {} });
      env.app.ctx.audit.append({ actor: user('u-coffre-1'), action: 'beneficiary.change.approved', resourceType: 'beneficiary_change', resourceId: `CHG-OLD-${i}`, details: {} });
    }
  };

  it('par défaut : la paire au plafond peut encore valider, une alerte est levée', async () => {
    const env = await setupG();
    priorPairApprovals(env, 5);
    const p = await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal);
    expect(p.statusCode).toBe(201);
    const a = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${p.json().id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    expect(a.statusCode).toBe(200);
    expect(env.app.ctx.alerts.list().some((x) => x.type === 'COLLUSION_ROTATION_DEPASSEE' && x.context.automaticEffect === 'AUCUN')).toBe(true);
  });

  it('activée à deux personnes : la même paire est bloquée (409), une autre personne habilitée peut décider', async () => {
    const env = await setupG();
    await enableRotation(env);
    priorPairApprovals(env, 5);
    const p = await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal);
    const blocked = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${p.json().id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('ROTATION_REQUIRED');
    expect(env.app.ctx.audit.list({ action: 'integrite.rotation.blocked' }).total).toBe(1);
    const ok = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${p.json().id}/approve`, 'u-coffre-2', { outOfBandVerified: true });
    expect(ok.statusCode).toBe(200);
  });

  it('la fenêtre glissante libère la paire', async () => {
    const env = await setupG();
    await enableRotation(env, 2);
    priorPairApprovals(env, 2);
    env.clock.advance(31 * 86_400_000);
    const p = await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal);
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${p.json().id}/approve`, 'u-coffre-1', { outOfBandVerified: true })).statusCode).toBe(200);
  });
});

describe('Registre des seuils anti-fraude', () => {
  it('liste chaque paramètre avec valeur, unité, source et statut par défaut à confirmer', async () => {
    const env = await setupG();
    const r = await env.req('GET', '/v1/integrite/thresholds', 'u-auditeur');
    expect(r.statusCode).toBe(200);
    const { entries, summary } = r.json();
    const assist = entries.find((e: { id: string }) => e.id === 'canaux.assist_sur_place_m');
    expect(assist).toMatchObject({ value: ASSIST_ON_SITE_M, unit: 'm', owner: 'CODE', status: 'PAR_DEFAUT', source: { file: 'backend/src/plugins/canaux/assisted.ts', constant: 'ASSIST_ON_SITE_M' } });
    expect(assist.statusLabel).toBe('PAR_DEFAUT — à confirmer par le maître d’ouvrage');
    expect(entries.find((e: { id: string }) => e.id === 'sanctions.contre_verification_pct').value).toBe(COUNTER_CHECK_RATE_PER_10K / 100);
    expect(entries.find((e: { id: string }) => e.id === 'rotation.blocage_actif').value).toBe(false);
    expect(summary.parDefaut).toBe(entries.length);
    expect(new Set(entries.map((e: { id: string }) => e.id)).size).toBe(entries.length);
    expect((await env.req('GET', '/v1/integrite/thresholds', 'u-contribuable')).statusCode).toBe(403);
  });

  it('confirmation par acte : proposée, approuvée par une AUTRE personne, journalisée', async () => {
    const env = await setupG();
    const body = { parameterId: 'canaux.assist_sur_place_m', kind: 'CONFIRMATION', acte: 'Arrêté provincial n° 001/2026 (test)', motif: 'Seuil validé par le comité de pilotage (test).' };
    const p = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-enqueteur', body);
    expect(p.statusCode).toBe(201);
    const id = p.json().id;
    expect((await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', body)).statusCode).toBe(409);
    // L'auteur ne s'approuve pas ; un rôle non habilité non plus.
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${id}/decision`, 'u-auditeur', { approve: true, motif: 'Approbation par l’audit (test).' })).statusCode).toBe(403);
    const self = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { ...body, parameterId: 'tresor.suspens_age_max_j' });
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${self.json().id}/decision`, 'u-rssi', { approve: true, motif: 'Auto-approbation interdite (test).' })).statusCode).toBe(403);
    const d = await env.req('POST', `/v1/integrite/thresholds/change-requests/${id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Conforme à l’acte (test).' });
    expect(d.statusCode).toBe(200);
    const entry = (await env.req('GET', '/v1/integrite/thresholds', 'u-auditeur')).json().entries.find((e: { id: string }) => e.id === 'canaux.assist_sur_place_m');
    expect(entry.status).toBe('CONFIRME');
    expect(entry.statusLabel).toBe('CONFIRME (acte Arrêté provincial n° 001/2026 (test))');
    expect(entry.confirmation).toMatchObject({ proposedBy: 'u-enqueteur', approvedBy: 'u-dg-dgipk', value: ASSIST_ON_SITE_M });
    expect(env.app.ctx.audit.list({ action: 'integrite.threshold.change_' }).items.map((e) => e.action)).toEqual([
      'integrite.threshold.change_proposed', 'integrite.threshold.change_proposed', 'integrite.threshold.change_approved',
    ]);
    // Le circuit du registre est lui-même suivi par la détection de collusion.
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.some((x) => x.circuit === 'REGISTRE_SEUILS' && x.proposerId === 'u-enqueteur' && x.approverId === 'u-dg-dgipk')).toBe(true);
  });

  it('une constante du code ne se modifie pas par le registre ; une valeur du registre, dans ses bornes', async () => {
    const env = await setupG();
    const code = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { parameterId: 'canaux.assist_sur_place_m', kind: 'MODIFICATION', proposedValue: 500, motif: 'Tentative de modification directe (test).' });
    expect(code.statusCode).toBe(422);
    expect(code.json().code).toBe('CODE_PARAMETER');
    const out = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { parameterId: 'rotation.max_par_paire', kind: 'MODIFICATION', proposedValue: 0, motif: 'Valeur hors bornes (test).' });
    expect(out.json().code).toBe('VALUE_OUT_OF_RANGE');
    const conf = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { parameterId: 'rotation.max_par_paire', kind: 'CONFIRMATION', motif: 'Confirmation sans acte (test).' });
    expect(conf.json().code).toBe('ACTE_REQUIRED');
    await enableRotation(env, 3);
    const entries = (await env.req('GET', '/v1/integrite/thresholds', 'u-auditeur')).json().entries;
    const max = entries.find((e: { id: string }) => e.id === 'rotation.max_par_paire');
    expect(max).toMatchObject({ value: 3, defaultValue: 5, status: 'MODIFIE_A_CONFIRMER' });
    expect(env.svc.params()).toMatchObject({ rotationEnforced: true, rotationMaxPerPair: 3 });
  });

  it('constantes non exportées recopiées : égales à la source (toute dérive fait échouer ce test)', () => {
    const titres = readFileSync(join(SRC, 'plugins', 'titres', 'service.ts'), 'utf8');
    expect(Number(/const MAX_PACKS_PER_DEVICE = (\d+);/.exec(titres)?.[1])).toBe(REPLICATED.MAX_PACKS_PER_DEVICE);
    expect(Number(/const OFFLINE_MAX_AGE_MS = (\d+) \* HOUR_MS;/.exec(titres)?.[1])).toBe(REPLICATED.OFFLINE_MAX_AGE_HOURS);
  });

  it('chaque paramètre du code cite un fichier source existant qui contient sa constante', () => {
    for (const p of ALL_PARAMETERS) {
      const file = readFileSync(join(SRC, '..', '..', p.source.file), 'utf8');
      const name = p.source.constant.split('.')[0]!;
      expect(file, `${p.id} → ${p.source.file}`).toMatch(new RegExp(`${p.source.exported ? 'export ' : ''}const ${name}\\b`));
    }
  });
});

describe('Santé des clés (administration)', () => {
  const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

  it('empreintes sans secret, réservée à l’administration et à la sécurité', async () => {
    const env = await setupG();
    const r = await env.req('GET', '/v1/integrite/key-health', 'u-superadmin');
    expect(r.statusCode).toBe(200);
    const raw = r.body;
    expect(raw).not.toContain('test-audit-key');
    expect(raw).not.toContain('test-secret-mm-operator-a');
    const audit = r.json().keys.find((k: { id: string }) => k.id === 'audit-hmac');
    expect(audit.fingerprint).toBe(fp('test-audit-key'));
    expect(audit.warnings.map((w: { code: string }) => w.code)).toContain('TROP_COURTE');
    expect(r.json().mode).toBe('DEMONSTRATION');
    expect((await env.req('GET', '/v1/integrite/key-health', 'u-rssi')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/integrite/key-health', 'u-auditeur')).statusCode).toBe(403);
  });

  it('hors démonstration : clés absentes critiques, réutilisation, âge dépassé', async () => {
    const env = await setupG();
    const strong = 'k'.repeat(40);
    const out = keyHealth(env.app.ctx, {
      env: { MOSOLO_DEMO_MODE: 'false', MOSOLO_AUDIT_HMAC_KEY: strong, MOSOLO_BACKUP_KEY: 'test-audit-key', MOSOLO_KEY_DATES: 'MOSOLO_AUDIT_HMAC_KEY=2024-01-01', DATABASE_URL: 'postgres://x' },
      minLength: 32, maxAgeDays: 365,
    });
    expect(out.mode).toBe('EXPLOITATION');
    const w = (id: string) => out.keys.find((k) => k.id === id)!.warnings.map((x) => x.code);
    expect(w('audit-hmac')).toEqual(expect.arrayContaining(['REUTILISEE', 'AGE_DEPASSE']));
    expect(w('sauvegardes')).toContain('REUTILISEE');
    expect(w('clotures')).toContain('EPHEMERE');
    expect(w('integrite')).toContain('REPLI_SUR_AUTRE_CLE');
    expect(w('ancre-audit')).toContain('ABSENTE_HORS_DEMONSTRATION');
    expect(out.keys.find((k) => k.id === 'audit-hmac')!.ageDays).toBeGreaterThan(365);
    expect(out.summary.critical).toBeGreaterThan(0);
  });
});

describe('Application complète (tous les modules)', () => {
  it('les trois vues répondent sur les données de démonstration ; la chaîne d’audit reste intègre', async () => {
    const app = buildApp({ clock: new ManualClock(START), secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} } });
    await app.ready();
    const get = (url: string, u: string) => app.inject({ method: 'GET', url, headers: { 'x-demo-user': u } });
    expect((await get('/v1/integrite/collusion', 'u-auditeur')).statusCode).toBe(200);
    expect((await get('/v1/integrite/thresholds', 'u-auditeur')).statusCode).toBe(200);
    const keys = await get('/v1/integrite/key-health', 'u-rssi');
    expect(keys.statusCode).toBe(200);
    expect(keys.json().keys.some((k: { id: string; fingerprint: string | null }) => k.id === 'clotures' && k.fingerprint)).toBe(true);
    expect((await get('/v1/audit/verify', 'u-auditeur')).json().ok).toBe(true);
  });
});

describe('Circuits canaux : demande et décision séparées, sous garde de rotation', () => {
  const priorPairs = (env: TestEnv, n: number) => {
    for (let i = 0; i < n; i++) {
      env.app.ctx.audit.append({ actor: { kind: 'user', id: 'u-analyste-rappro', roles: ['R18'] }, action: 'canaux.point.reinstatement_requested', resourceType: 'payment_point', resourceId: `PA-OLD-${i}`, details: {} });
      env.app.ctx.audit.append({ actor: user('canaux-tresor-2'), action: 'canaux.point.reinstated', resourceType: 'payment_point', resourceId: `PA-OLD-${i}`, details: { requestedBy: 'u-analyste-rappro' } });
    }
  };

  it('les deux circuits canaux et la validation des commissions sont gardés ; leurs refus sont reconstitués', () => {
    const c = (code: string) => CIRCUITS.find((x) => x.code === code)!;
    expect(c('CANAUX_RETABLISSEMENT').guard?.url).toBe('/v1/payment-points/:id/reinstatement-request/decision');
    expect(c('CANAUX_ECARTEMENT_SUSPENSION').guard?.url).toBe('/v1/payment-point-proposals/:id/dismissal-request/decision');
    expect(c('CANAUX_RETABLISSEMENT').refusals).toContain('canaux.point.reinstatement_rejected');
    expect(c('COMMISSION_VALIDATION').guard?.url).toBe('/v1/agents/commission-validations/:id/decision');
  });

  it('rotation activée : la paire demandeur → décideur au plafond est bloquée ; le refus ne l’est jamais', async () => {
    const env = await setupG(START, true);
    await enableRotation(env, 2);
    priorPairs(env, 2);
    const base = '/v1/payment-points/PA-KALAMU-MM01/reinstatement-request';
    expect((await env.req('POST', base, 'u-analyste-rappro', { motif: 'Écart régularisé, pièces justificatives reçues.' })).statusCode).toBe(201);
    const blocked = await env.req('POST', `${base}/decision`, 'canaux-tresor-2', { approve: true, motif: 'Rétablissement validé en seconde lecture.' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('ROTATION_REQUIRED');
    expect(env.app.ctx.audit.list({ action: 'integrite.rotation.blocked' }).items[0]!.resourceId).toBe('CANAUX_RETABLISSEMENT:PA-KALAMU-MM01');
    const refused = await env.req('POST', `${base}/decision`, 'canaux-tresor-2', { approve: false, motif: 'Refus motivé, pièces insuffisantes.' });
    expect(refused.statusCode).toBe(200);
    // Le refus figure au journal comme décision à deux personnes.
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.filter((d) => d.circuit === 'CANAUX_RETABLISSEMENT' && d.outcome === 'REFUSE').map((d) => [d.proposerId, d.approverId])).toEqual([['u-analyste-rappro', 'canaux-tresor-2']]);
  });
});

describe('Détection planifiée de la collusion (journalisée, alertes seulement)', () => {
  it('s’exécute à l’intervalle du registre (24 h par défaut), chaque exécution journalisée ; 0 la désactive', async () => {
    const env = await setupG();
    expect(env.svc.schedulerActive).toBe(false);
    const def = ALL_PARAMETERS.find((p) => p.id === 'collusion.detection_intervalle_h')!;
    expect(def).toMatchObject({ value: 24, owner: 'REGISTRE' });
    expect(env.svc.entry(def).statusLabel).toBe('PAR_DEFAUT — à confirmer par le maître d’ouvrage');
    for (let i = 0; i < 12; i++) treasuryDecision(env, i, 'u-a', 'u-b', 20);
    expect(env.svc.scheduledTick()).toMatchObject({ ran: true });
    const runs = () => env.app.ctx.audit.list({ action: 'integrite.collusion.run' }).items.filter((e) => e.details.trigger === 'PLANIFIEE');
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ actor: { kind: 'system' }, details: { automaticEffect: 'AUCUN' } });
    expect(env.app.ctx.alerts.list().some((a) => a.source === 'integrite:collusion')).toBe(true);
    env.clock.advance(23 * 3_600_000);
    expect(env.svc.scheduledTick().ran).toBe(false);
    env.clock.advance(2 * 3_600_000);
    expect(env.svc.scheduledTick().ran).toBe(true);
    expect(runs()).toHaveLength(2);
    // Vue : intervalle, statut et dernière exécution.
    const view = (await env.req('GET', '/v1/integrite/collusion', 'u-auditeur')).json();
    expect(view.schedule).toMatchObject({ intervalHours: 24, lastRunAt: env.clock.now().toISOString() });
    // Désactivation par le registre (circuit à deux personnes).
    const r = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { parameterId: 'collusion.detection_intervalle_h', kind: 'MODIFICATION', proposedValue: 0, motif: 'Suspension temporaire décidée en comité (test).' });
    expect(r.statusCode).toBe(201);
    await env.req('POST', `/v1/integrite/thresholds/change-requests/${r.json().id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Approuvé par la direction générale (test).' });
    env.clock.advance(48 * 3_600_000);
    expect(env.svc.scheduledTick().ran).toBe(false);
  });

  it('reprise après redémarrage : la dernière exécution planifiée est relue au journal', async () => {
    const env = await setupG();
    env.app.ctx.audit.append({ actor: { kind: 'system', id: 'integrite:collusion' }, action: 'integrite.collusion.run', resourceType: 'collusion', resourceId: '*', details: { trigger: 'PLANIFIEE' } });
    env.clock.advance(3_600_000);
    expect(env.svc.scheduledTick().ran).toBe(false);
  });

  it('désactivée sous les tests, forçable ou coupée par variable', () => {
    expect(collusionSchedulerEnabled({ VITEST: 'true' })).toBe(false);
    expect(collusionSchedulerEnabled({})).toBe(true);
    expect(collusionSchedulerEnabled({ MOSOLO_COLLUSION_SCHEDULER: 'off' })).toBe(false);
    expect(collusionSchedulerEnabled({ VITEST: 'true', MOSOLO_COLLUSION_SCHEDULER: 'on' })).toBe(true);
  });
});

describe('Santé des clés au démarrage (hors démonstration)', () => {
  const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const AUDIT = 'a'.repeat(20) + 'audit-cle-stable-0123456789';
  async function bootApp() {
    const app = buildApp({
      clock: new ManualClock(START),
      secrets: { auditHmacKey: AUDIT, providerSecrets: { 'mm-operator-a': 'p'.repeat(40) }, deviceKeys: {}, commsProviderKeys: {} },
      plugins: [integritePlugin, integriteGouvernancePlugin],
    });
    await app.ready();
    return app;
  }
  const goodEnv = (): NodeJS.ProcessEnv => ({
    MOSOLO_DEMO_MODE: 'false', MOSOLO_AUDIT_HMAC_KEY: AUDIT, MOSOLO_RECEIPT_SIGNING_KEY: pem(), MOSOLO_CLOSURE_SIGNING_KEY: pem(), MOSOLO_JWT_PRIVATE_KEY: pem(),
    MOSOLO_BACKUP_KEY: 'b'.repeat(40), MOSOLO_INTEGRITE_KEY: 'i'.repeat(40), MOSOLO_PAYMENT_POINT_MASTER_KEY: 'm'.repeat(40),
  });
  const silent = { info: () => undefined, warn: () => undefined };

  it('en démonstration : aucun contrôle bloquant', async () => {
    const app = await bootApp();
    expect(assertKeyHealthAtBoot(app.ctx, { MOSOLO_DEMO_MODE: 'true' }, silent)).toBeNull();
  });

  it('clés stables et distinctes : démarrage accepté ; âge dépassé journalisé et alerté, jamais bloquant', async () => {
    const app = await bootApp();
    const warns: string[] = [];
    const h = assertKeyHealthAtBoot(app.ctx, { ...goodEnv(), MOSOLO_KEY_DATES: 'MOSOLO_BACKUP_KEY=2024-01-01' }, { info: () => undefined, warn: (m) => warns.push(m) });
    expect(h?.mode).toBe('EXPLOITATION');
    expect(warns.some((w) => w.includes('MOSOLO_BACKUP_KEY (AGE_DEPASSE)'))).toBe(true);
    expect(app.ctx.alerts.list().some((a) => a.type === 'CLE_AGE_DEPASSE' && a.context.automaticEffect === 'AUCUN')).toBe(true);
    expect(app.ctx.audit.list({ action: 'integrite.keys.boot_checked' }).items[0]).toMatchObject({ outcome: 'SUCCESS' });
  });

  it('clé absente, éphémère, de démonstration ou réutilisée : démarrage refusé, message clair, aucun secret', async () => {
    const app = await bootApp();
    const refuse = (env: NodeJS.ProcessEnv, re: RegExp) => {
      let err: unknown;
      try { assertKeyHealthAtBoot(app.ctx, env, silent); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as Error).message).toMatch(/^Démarrage refusé hors mode démonstration/);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).not.toContain(AUDIT);
    };
    refuse({ ...goodEnv(), MOSOLO_JWT_PRIVATE_KEY: undefined }, /MOSOLO_JWT_PRIVATE_KEY \(EPHEMERE\)/);
    refuse({ ...goodEnv(), MOSOLO_BACKUP_KEY: undefined }, /MOSOLO_BACKUP_KEY \(ABSENTE_HORS_DEMONSTRATION\)/);
    refuse({ ...goodEnv(), MOSOLO_BACKUP_KEY: 'demo-' + 'x'.repeat(40) }, /VALEUR_DEMONSTRATION/);
    refuse({ ...goodEnv(), MOSOLO_BACKUP_KEY: AUDIT }, /MOSOLO_BACKUP_KEY \(REUTILISEE\)/);
    refuse({ ...goodEnv(), MOSOLO_AUDIT_HMAC_KEY: undefined }, /MOSOLO_AUDIT_HMAC_KEY \(EPHEMERE\)/);
    expect(app.ctx.audit.list({ action: 'integrite.keys.boot_checked' }).items.every((e) => e.outcome === 'DENIED')).toBe(true);
  });

  it('clé éphémère hors audit/quittances/clôtures/jetons : signalée, non bloquante', async () => {
    const app = await bootApp();
    const { blocking, reported } = classifyBootKeyHealth(keyHealth(app.ctx, { env: { ...goodEnv(), MOSOLO_PAYMENT_POINT_MASTER_KEY: undefined }, minLength: 32, maxAgeDays: 365 }));
    expect(blocking).toEqual([]);
    expect(reported.map((r) => `${r.id}:${r.code}`)).toContain('points-maitresse:EPHEMERE');
  });
});
