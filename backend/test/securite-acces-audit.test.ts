/**
 * Lot « sécurité, accès, audit » : audit structuré et corrélation (§ 29.1 / 30.1 / 36.1), scellement du journal
 * (§ 25.1), accès privilégié juste-à-temps (§ 12.1), extraction massive à trois visas (§ 12.3 / 12.5 / 31.1),
 * appareils et GPS (§ 25.1 / § 40), notification des actes du mandataire (§ 13.5), plafonds de références
 * (§ 18.4 / H.10), clés d'accès FIDO2 et mTLS (§ 31 / 30.1).
 */
import { createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, scryptSync, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuditLog, HsmAuditSigner, SoftwareHmacSigner, withCorrelation } from '../src/core/audit.js';
import { ManualClock } from '../src/core/clock.js';
import { hmacSha256Hex } from '../src/core/crypto.js';
import { verifyBackup } from '../src/persistence/backup.js';
import type { AccesService } from '../src/plugins/acces/service.js';
import type { GouvernanceService } from '../src/plugins/integrite/gouvernance/service.js';
import type { IntegriteService } from '../src/plugins/integrite/service.js';
import type { SecuriteService } from '../src/plugins/integrite/securite/plugin.js';
import { MemoryPublicationTarget, merkleRoot } from '../src/plugins/integrite/securite/horodatage.js';
import { MemoryWormStore } from '../src/plugins/integrite/securite/worm.js';
import { mtlsFromEnv } from '../src/plugins/socle/mtls.js';
import { demoTotpSecret, DEMO_PASSWORD } from '../src/plugins/socle/service.js';
import type { SocleService } from '../src/plugins/socle/plugin.js';
import { totp } from '../src/plugins/socle/tokens.js';
import { DEMO } from '../src/seed.js';

const START = '2026-09-29T09:00:00.000Z';
const SECRETS = { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} };

async function setup() {
  const clock = new ManualClock(START);
  const app = buildApp({ clock, secrets: SECRETS });
  await app.ready();
  const req = (method: string, url: string, opts: { user?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => app.inject({
    method: method as 'GET', url,
    headers: {
      ...(opts.user ? { 'x-demo-user': opts.user } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
  const gov = app.ctx.ext['integrite-gouvernance'] as GouvernanceService;
  /** Fixe une valeur du registre des seuils (comme après une décision à deux personnes). */
  const setParam = (id: string, value: number | boolean) => {
    const s = { id, value, status: 'MODIFIE_A_CONFIRMER' as const, history: [] };
    if (gov.states.get(id)) gov.states.update(s); else gov.states.insert(s);
  };
  return { app, clock, req, setParam, sec: app.ctx.ext['integrite-securite'] as SecuriteService };
}

describe('Audit structuré et corrélation (§ 29.1, § 30.1)', () => {
  it('X-Request-Id accepté, renvoyé et porté par chaque enregistrement de la requête ; généré sinon', async () => {
    const { app, req } = await setup();
    const id = `test-${randomUUID()}`;
    const r = await req('POST', '/v1/integrite/collusion/run', { user: 'u-auditeur', headers: { 'x-request-id': id } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-request-id']).toBe(id);
    const recs = app.ctx.audit.list({ correlationId: id }).items;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((x) => x.trace?.correlationId === id)).toBe(true);
    const bad = await req('GET', '/health', { headers: { 'x-request-id': 'x y' } });
    expect(String(bad.headers['x-request-id'])).toMatch(/^req-/);
    const listed = await req('GET', `/v1/audit/events?correlationId=${id}`, { user: 'u-auditeur' });
    expect((listed.json() as { total: number }).total).toBe(recs.length);
    expect(app.ctx.audit.verify().ok).toBe(true);
    await app.close();
  });

  it('attributs structurés : motif, chaîne d’approbation, empreintes avant/après, appareil ; historique inchangé', () => {
    const clock = new ManualClock(START);
    const log = new AuditLog(clock, 'k-test-0123456789');
    const legacy = log.append({ actor: { kind: 'system', id: 's' }, action: 'x.legacy', resourceType: 't' });
    expect(legacy.trace).toBeUndefined();
    const r = withCorrelation('corr-12345678', () => log.append({
      actor: { kind: 'user', id: 'u2' }, action: 'x.decided', resourceType: 't', details: { motif: 'Motif précis', proposedBy: 'u1', decision: 'APPROUVEE' },
      before: { v: 1 }, after: { v: 2 }, trace: { deviceId: 'dev-1' },
    }));
    expect(r.trace).toMatchObject({ correlationId: 'corr-12345678', reason: 'Motif précis', deviceId: 'dev-1', approvalChain: [{ by: 'u1', step: 'PROPOSITION' }, { by: 'u2', step: 'DECISION', decision: 'APPROUVEE' }] });
    expect(r.trace?.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.trace?.beforeHash).not.toBe(r.trace?.afterHash);
    expect(log.verify().ok).toBe(true);
    // Rechargement d'un journal mêlant anciens enregistrements (sans attributs) et nouveaux : toujours vérifié.
    const copy = new AuditLog(clock, 'k-test-0123456789');
    copy.restore(log.list({ limit: 10 }).items);
    expect(copy.verify().ok).toBe(true);
    // Toute altération d'un attribut structuré est détectée.
    copy.unsafeRawStorageForTamperTests()[1]!.trace!.reason = 'autre motif';
    expect(copy.verify()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('signataire : logiciel rétrocompatible (même signature HMAC) ou module matériel (adaptateur HSM)', () => {
    const clock = new ManualClock(START);
    const soft = new AuditLog(clock, new SoftwareHmacSigner('k-test-0123456789'));
    const rec = soft.append({ actor: { kind: 'system', id: 's' }, action: 'x', resourceType: 't' });
    expect(rec.signature).toBe(hmacSha256Hex('k-test-0123456789', rec.hash));
    const hsm = new AuditLog(clock, new HsmAuditSigner({ label: 'hsm-test', hmacSign: (_l, d) => createHash('sha256').update('hsm-secret').update(d).digest() }, 'audit-key'));
    hsm.append({ actor: { kind: 'system', id: 's' }, action: 'x', resourceType: 't' });
    expect(hsm.verify().ok).toBe(true);
    expect(hsm.signer.kind).toBe('HSM');
  });
});

describe('Scellement du journal (§ 25.1)', () => {
  it('copie WORM, racine quotidienne horodatée et publiée, contrôle d’intégrité ; toute divergence alerte', async () => {
    const { app, clock, req, sec } = await setup();
    const copy = await req('POST', '/v1/integrite/scellement/copie', { user: 'u-rssi' });
    expect(copy.statusCode).toBe(200);
    expect(copy.json().copied).toBeGreaterThan(0);
    expect((await req('POST', '/v1/integrite/scellement/copie', { user: 'u-contribuable' })).statusCode).toBe(403);
    // Racine du jour (partielle) puis, le lendemain, racine complète de la veille.
    const partial = await req('POST', '/v1/integrite/scellement/racines', { user: 'u-rssi', body: { day: '2026-09-29' } });
    expect(partial.statusCode).toBe(201);
    expect(partial.json()).toMatchObject({ partial: true, timestamp: { policy: 'urn:mosolo:tsa:local' }, publication: { kind: 'MEMOIRE' } });
    clock.advance(24 * 3_600_000);
    const root = (await req('POST', '/v1/integrite/scellement/racines', { user: 'u-rssi', body: {} })).json();
    expect(root).toMatchObject({ day: '2026-09-29', partial: false });
    const dayHashes = app.ctx.audit.list({ limit: 100_000 }).items.filter((x) => x.seq >= root.fromSeq && x.seq <= root.toSeq).map((x) => x.hash);
    expect(root.merkleRoot).toBe(merkleRoot(dayHashes));
    expect((await req('POST', '/v1/integrite/scellement/racines', { user: 'u-rssi', body: { day: '2026-09-29' } })).statusCode).toBe(409);
    const ok = (await req('POST', '/v1/integrite/scellement/controles', { user: 'u-rssi' })).json();
    expect(ok).toMatchObject({ ok: true, live: { ok: true }, copy: { ok: true }, roots: { ok: true } });

    // Altération de la copie WORM par un initié : détectée.
    (sec.scellement.worm as MemoryWormStore).unsafeTamperForTests(3, { action: 'autre.action' });
    const bad = sec.scellement.check('system');
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f) => f.code)).toContain('COPIE_ALTEREE');
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'SCELLEMENT_COPIE_ALTEREE' && a.severity === 'CRITICAL')).toBe(true);
    // Racine altérée sur la cible externe : détectée.
    (sec.scellement.target as MemoryPublicationTarget).unsafeTamperForTests(0, { merkleRoot: '0'.repeat(64) });
    expect(sec.scellement.check('system').findings.map((f) => f.code)).toContain('PUBLICATION_DIVERGENTE');
    // Réécriture de la chaîne vivante : détectée (chaîne rompue, divergence avec la copie WORM).
    app.ctx.audit.unsafeRawStorageForTamperTests()[1]!.details = { reecrit: true };
    const live = sec.scellement.check('system');
    expect(live.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['CHAINE_ROMPUE', 'COPIE_DIVERGENTE']));
    // Suppression d'enregistrements (troncature) : la racine publiée ne se retrouve plus.
    app.ctx.audit.unsafeRawStorageForTamperTests().splice(root.toSeq - 1);
    expect(sec.scellement.check('system').findings.map((f) => f.code)).toEqual(expect.arrayContaining(['TRONCATURE', 'RACINE_DIVERGENTE']));
    const status = (await req('GET', '/v1/integrite/scellement', { user: 'u-auditeur' })).json();
    expect(status).toMatchObject({ signer: { kind: 'LOGICIEL' }, timestampAuthority: { external: false }, automaticEffect: 'AUCUN' });
    await app.close();
  });

  it('planificateur : contrôle à l’intervalle du registre, racine de la veille, revue mensuelle des accès privilégiés', async () => {
    const { app, clock, sec } = await setup();
    clock.advance(24 * 3_600_000);
    const t = sec.tick();
    expect(t).toMatchObject({ checked: true, rootPublished: true, reviewLaunched: true });
    expect(sec.tick()).toMatchObject({ checked: false, rootPublished: false, reviewLaunched: false });
    const reviews = (app.ctx.ext.integrite as IntegriteService).reviews.all();
    expect(reviews.some((c) => c.scope === 'PRIVILEGIES' && c.period === '2026-09')).toBe(true);
    await app.close();
  });
});

describe('Accès privilégié juste-à-temps (§ 12.1, § 12.3)', () => {
  it('demande motivée → approbation par une autre personne → rôle temporaire → session enregistrée → expiration automatique', async () => {
    const { app, clock, req } = await setup();
    const ops = 'acces-u-exploitation';
    expect((await req('GET', '/v1/integrite/key-health', { user: ops })).statusCode).toBe(403);
    expect((await req('POST', '/v1/acces/elevations', { user: 'u-contribuable', body: { role: 'R26', motif: 'Motif suffisamment long', durationMinutes: 30 } })).statusCode).toBe(403);
    expect((await req('POST', '/v1/acces/elevations', { user: ops, body: { role: 'R17', motif: 'Motif suffisamment long', durationMinutes: 30 } })).statusCode).toBe(422);
    expect((await req('POST', '/v1/acces/elevations', { user: ops, body: { role: 'R26', motif: 'Motif suffisamment long', durationMinutes: 9999 } })).statusCode).toBe(400);
    const e = await req('POST', '/v1/acces/elevations', { user: ops, body: { role: 'R26', motif: 'Incident INC-42 : rotation de clé en urgence', durationMinutes: 30, ticketRef: 'INC-42' } });
    expect(e.statusCode).toBe(201);
    const id = e.json().id as string;
    expect((await req('GET', '/v1/integrite/key-health', { user: ops })).statusCode).toBe(403);
    // Auto-approbation impossible (le demandeur n'a pas le droit ; même une personne habilitée ne s'approuve pas).
    expect((await req('POST', `/v1/acces/elevations/${id}/decision`, { user: ops, body: { approve: true, motif: 'Auto-approbation' } })).statusCode).toBe(403);
    // Second facteur exigé de l'approbateur.
    expect((await req('POST', `/v1/acces/elevations/${id}/decision`, { user: 'u-rssi', body: { approve: true, motif: 'Incident vérifié' } })).statusCode).toBe(401);
    const ch = (await req('POST', '/v1/acces/mfa/challenge', { user: 'u-rssi' })).json();
    const code = /(\d{6})/.exec((app.ctx.ext.acces as AccesService).sandboxMessages('app:u-rssi')[0]!.text)![1]!;
    expect((await req('POST', '/v1/acces/mfa/verify', { user: 'u-rssi', body: { challengeId: ch.challengeId, code } })).statusCode).toBe(200);
    const ok =await req('POST', `/v1/acces/elevations/${id}/decision`, { user: 'u-rssi', body: { approve: true, motif: 'Incident vérifié' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ACTIVE' });
    const kh = await req('GET', '/v1/integrite/key-health', { user: ops, headers: { 'x-request-id': 'elev-req-00000001' } });
    expect(kh.statusCode).toBe(200);
    const tagged = app.ctx.audit.list({ correlationId: 'elev-req-00000001' }).items;
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((r) => r.trace?.elevationId === id)).toBe(true);
    const session = (await req('GET', `/v1/acces/elevations/${id}/session`, { user: 'u-auditeur' })).json();
    expect(session.items.some((x: { action: string }) => x.action === 'acces.elevation.command')).toBe(true);
    expect(session.items.some((x: { action: string }) => x.action === 'integrite.keys.checked')).toBe(true);
    // L'annuaire n'a jamais été modifié.
    expect(app.ctx.users.get(ops)!.roles).toEqual(['R27']);
    // Expiration automatique.
    clock.advance(31 * 60_000);
    expect((await req('GET', '/v1/integrite/key-health', { user: ops })).statusCode).toBe(403);
    const acces = app.ctx.ext.acces as AccesService;
    expect(acces.elevations.requests.get(id)!.status).toBe('EXPIREE');
    expect(app.ctx.audit.list({ action: 'acces.elevation.expired' }).total).toBe(1);
    // Revue mensuelle des accès privilégiés : l'élévation y figure ; une seule revue par mois.
    const review = await req('POST', '/v1/integrite/access-reviews/privileged', { user: 'u-rssi', body: {} });
    expect(review.statusCode).toBe(201);
    const item = review.json().items.find((i: { userId: string }) => i.userId === ops);
    expect(item.elevations[0]).toMatchObject({ id, role: 'R26', approvedBy: 'u-rssi' });
    expect((await req('POST', '/v1/integrite/access-reviews/privileged', { user: 'u-rssi', body: {} })).statusCode).toBe(409);
    // La revue complète historique reste disponible : même liste, même circuit de décision.
    const listed = (await req('GET', '/v1/integrite/access-reviews', { user: 'u-rssi' })).json() as { scope?: string; id: string; items: { id: string; userId: string }[] }[];
    const monthly = listed.find((c) => c.scope === 'PRIVILEGIES')!;
    const line = monthly.items.find((i) => i.userId === ops)!;
    expect((await req('POST', `/v1/integrite/access-reviews/${monthly.id}/items/${encodeURIComponent(line.id)}/decision`, { user: 'u-rssi', body: { decision: 'MAINTENU', reason: 'Élévation justifiée par l’incident INC-42' } })).statusCode).toBe(200);
    // Circuit à deux personnes reconnu par la détection de collusion.
    expect((await req('GET', '/v1/integrite/collusion', { user: 'u-auditeur' })).json().circuits.some((c: { code: string; decisions: number }) => c.code === 'ACCES_ELEVATION' && c.decisions === 1)).toBe(true);
    await app.close();
  });
});

describe('Extraction massive à trois visas (§ 12.3, § 12.5, § 31.1)', () => {
  it('petit périmètre : export signé historique, filigrané ; au-delà du seuil : trois visas, paquet chiffré, filigrané, expirant', async () => {
    const { app, clock, req, setParam } = await setup();
    // Petit périmètre (sous le seuil par défaut) : une personne, motif, filigrane lié au contenu.
    const small = await req('POST', '/v1/socle/exports', { user: 'u-superadmin', body: { reason: 'Contrôle ponctuel', repos: ['ext.acces.entities'] } });
    expect(small.statusCode).toBe(200);
    const doc = small.json();
    expect(doc.watermark).toMatchObject({ requestedBy: 'u-superadmin' });
    expect(doc.watermarkSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.rows.every((r: { repo: string }) => r.repo === 'ext.acces.entities')).toBe(true);

    setParam('socle.export_massif_lignes', 10);
    const big = await req('POST', '/v1/socle/exports', { user: 'u-superadmin', body: { reason: 'Réversibilité : copie pour l’audit externe' } });
    expect(big.statusCode).toBe(202);
    const id = big.json().request.id as string;
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'DLP_EXPORT_MASSIF')).toBe(true);
    // Ordre et personnes distinctes.
    expect((await req('POST', `/v1/socle/exports/requests/${id}/committee`, { user: 'u-ministre-finances', body: { approve: true, motif: 'Trop tôt' } })).statusCode).toBe(409);
    expect((await req('POST', `/v1/socle/exports/requests/${id}/data-owner`, { user: 'u-superadmin', body: { approve: true, motif: 'Moi-même' } })).statusCode).toBe(403);
    expect((await req('POST', `/v1/socle/exports/requests/${id}/data-owner`, { user: 'integrite-u-dpo', body: { approve: true, motif: 'Finalité conforme au registre' } })).statusCode).toBe(200);
    expect((await req('POST', `/v1/socle/exports/requests/${id}/package`, { user: 'u-superadmin', body: { passphrase: 'phrase-secrete-tres-longue' } })).statusCode).toBe(409);
    const c = await req('POST', `/v1/socle/exports/requests/${id}/committee`, { user: 'u-ministre-finances', body: { approve: true, motif: 'Comité des données du 29/09' } });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ status: 'APPROUVEE', packageAvailable: true });
    expect(c.json()).not.toHaveProperty('sealed');
    // Remis au seul demandeur, rechiffré par sa phrase secrète.
    expect((await req('POST', `/v1/socle/exports/requests/${id}/package`, { user: 'u-ministre-finances', body: { passphrase: 'phrase-secrete-tres-longue' } })).statusCode).toBe(403);
    const pkg = (await req('POST', `/v1/socle/exports/requests/${id}/package`, { user: 'u-superadmin', body: { passphrase: 'phrase-secrete-tres-longue' } })).json();
    const env = pkg.envelope;
    const k = scryptSync('phrase-secrete-tres-longue', Buffer.from(env.kdf.salt, 'base64'), 32, { N: env.kdf.N, r: env.kdf.r, p: env.kdf.p });
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from(env.aad));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const plain = JSON.parse(Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8'));
    expect(plain.watermark).toMatchObject({ exportId: id, requestedBy: 'u-superadmin' });
    const { watermark: _w, watermarkSignature: _s, ...backup } = plain;
    expect(verifyBackup(backup, 'demo-backup-key-NON-PRODUCTION', 'test-audit-key')).toMatchObject({ ok: true });
    // Chaîne d'approbation structurée dans l'audit ; expiration automatique du paquet.
    const approved = app.ctx.audit.list({ action: 'socle.export.bulk_approved' }).items[0]!;
    expect(approved.trace?.approvalChain?.map((s) => s.by)).toEqual(['u-superadmin', 'integrite-u-dpo', 'u-ministre-finances']);
    clock.advance(25 * 3_600_000);
    expect((await req('POST', `/v1/socle/exports/requests/${id}/package`, { user: 'u-superadmin', body: { passphrase: 'phrase-secrete-tres-longue' } })).statusCode).toBe(409);
    expect((app.ctx.ext.socle as SocleService).bulk.requests.get(id)!.sealed).toBeUndefined();
    await app.close();
  });

  it('lecture massive de données personnelles : alerte DLP au-delà du seuil', async () => {
    const { app, req, setParam } = await setup();
    setParam('dlp.lectures_max', 5);
    for (let i = 0; i < 7; i++) await req('GET', '/v1/obligations', { user: 'u-controleur' });
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'DLP_LECTURE_MASSIVE' && a.context.userId === 'u-controleur')).toBe(true);
    await app.close();
  });
});

describe('Appareils et plausibilité GPS (§ 25.1, § 40)', () => {
  it('une empreinte d’appareil servant plusieurs comptes alerte ; attestation MDM enregistrée', async () => {
    const { app, req } = await setup();
    const h = { 'x-mosolo-device-fingerprint': 'fp-navigateur-123456' };
    await req('GET', '/v1/auth/me', { user: 'u-guichet', headers: h });
    await req('GET', '/v1/auth/me', { user: 'u-controleur', headers: h });
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'APPAREIL_MULTI_COMPTES')).toBe(true);
    const list = (await req('GET', '/v1/integrite/appareils', { user: 'u-rssi' })).json();
    expect(list.items.find((d: { id: string }) => d.id === 'empreinte:fp-navigateur-123456').multiAccounts).toBe(true);
    const att = await req('POST', '/v1/integrite/appareils/dev-terrain-001/attestation', { user: 'u-rssi', body: { status: 'NON_CONFORME', rooted: true, source: 'MDM', note: 'Système modifié détecté' } });
    expect(att.statusCode).toBe(200);
    expect(att.json().attestation).toMatchObject({ status: 'NON_CONFORME', rooted: true });
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'APPAREIL_NON_CONFORME')).toBe(true);
    // L'appareil est repris dans le contexte d'audit de la requête.
    await req('GET', '/v1/auth/me', { user: 'u-guichet', headers: { ...h, 'x-mosolo-device-id': 'dev-terrain-001', 'x-request-id': 'dev-req-00000001' } });
    await app.close();
  });

  it('vitesse impossible entre deux actions de terrain successives : alerte, jamais de sanction', async () => {
    const { app, clock, req } = await setup();
    const actor = { kind: 'user' as const, id: 'u-agent-terrain', roles: ['R10' as const] };
    app.ctx.audit.append({ actor, action: 'terrain.constat', resourceType: 'objet', details: { lat: -4.33, lon: 15.31 } });
    clock.advance(60_000);
    app.ctx.audit.append({ actor, action: 'terrain.constat', resourceType: 'objet', details: { gps: { lat: -5.0, lon: 15.9 } } });
    const a = app.ctx.alerts.alerts.all().find((x) => x.type === 'GPS_VITESSE_IMPLAUSIBLE');
    expect(a?.context.automaticEffect).toBe('AUCUN');
    expect((await req('GET', '/v1/integrite/gps/anomalies', { user: 'u-rssi' })).json().items).toHaveLength(1);
    const ev = (await req('POST', '/v1/integrite/gps/plausibilite', { user: 'u-rssi', body: { points: [
      { lat: -4.33, lon: 15.31, at: '2026-09-29T09:00:00Z' }, { lat: -4.331, lon: 15.311, at: '2026-09-29T09:05:00Z' }, { lat: -5.2, lon: 15.9, at: '2026-09-29T09:06:00Z' },
    ] } })).json();
    expect(ev.plausible).toBe(false);
    expect(ev.segments.map((s: { implausible: boolean }) => s.implausible)).toEqual([false, true]);
    await app.close();
  });
});

describe('Mandats et plafonds de références (§ 13.5, § 18.4 / H.10)', () => {
  it('un acte du mandataire est notifié au mandant (événement mandate.action_performed) et journalisé', async () => {
    const { app, req } = await setup();
    const obligations = app.ctx.assessment.byTaxpayer(DEMO.taxpayerId);
    let created = false;
    for (const o of obligations) {
      const r = await req('POST', `/v1/obligations/${o.id}/payment-orders`, { user: 'u-mandataire', body: { channel: 'MOBILE_MONEY' }, headers: { 'idempotency-key': randomUUID() } });
      if (r.statusCode === 201) { created = true; break; }
    }
    expect(created).toBe(true);
    const logged = app.ctx.audit.list({ action: 'acces.mandate.action_performed' }).items;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ resourceId: DEMO.taxpayerId, details: { mandataire: 'u-mandataire', actions: expect.arrayContaining(['payment.reference.issued']) } });
    expect(app.ctx.comms.deliveries.all().some((d) => d.eventCode === 'mandate.action_performed' && d.recipientId === DEMO.taxpayerId)).toBe(true);
    await app.close();
  });

  it('plafond par agent : seuil d’alerte puis plafond bloquant (0 = non fixé) ; vue harmonisée avec les points agréés', async () => {
    const { app, req, setParam, sec } = await setup();
    setParam('plafonds.agent.alerte_jour', 2);
    setParam('plafonds.agent.max_jour', 2);
    const guichet = app.ctx.users.get('u-guichet')!;
    const issue = () => app.ctx.audit.append({ actor: { kind: 'user', id: guichet.id, roles: guichet.roles }, action: 'payment.reference.issued', resourceType: 'payment_order', resourceId: randomUUID(), details: { channel: 'MOBILE_MONEY' } });
    issue();
    expect(() => sec.surveillance.guardReference(guichet, 'MOBILE_MONEY')).not.toThrow();
    issue();
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'PLAFOND_REFERENCES_AGENT')).toBe(true);
    const o = app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const refused = await req('POST', `/v1/obligations/${o.id}/payment-orders`, { user: 'u-guichet', body: { channel: 'MOBILE_MONEY' }, headers: { 'idempotency-key': randomUUID() } });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'AGENT_REFERENCE_CEILING' });
    // Un contribuable n'est pas un agent : le plafond par agent ne s'applique pas à lui.
    expect(() => sec.surveillance.guardReference(app.ctx.users.get('u-contribuable')!, 'MOBILE_MONEY')).not.toThrow();
    setParam('plafonds.canal.mobile_money.max_jour', 1);
    expect(() => sec.surveillance.guardReference(app.ctx.users.get('u-contribuable')!, 'MOBILE_MONEY')).toThrow(/canal MOBILE_MONEY/);
    const view = (await req('GET', '/v1/integrite/plafonds-references', { user: 'u-rssi' })).json();
    expect(view.agent).toMatchObject({ alertPerDay: 2, maxPerDay: 2 });
    expect(view.points.length).toBeGreaterThan(0);
    await app.close();
  });
});

/* ------------------------------------------------------------------ */
/* Authentificateur logiciel WebAuthn (tests)                          */
/* ------------------------------------------------------------------ */

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const ORIGIN = 'http://localhost:5173';

class SoftAuthenticator {
  readonly credId = randomBytes(16);
  private readonly priv: KeyObject;
  private readonly jwk: { x: string; y: string };
  private counter = 0;
  constructor() {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = kp.privateKey;
    this.jwk = kp.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }
  private rpHash() {
    return createHash('sha256').update('localhost').digest();
  }
  register(challenge: string) {
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, Buffer.from(cose)]);
    const att = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(att), transports: ['internal'] }, clientExtensionResults: {} };
  }
  assert(challenge: string) {
    this.counter++;
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x05]), c]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.priv);
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) }, clientExtensionResults: {} };
  }
}

describe('Clés d’accès FIDO2 (§ 31) et TLS mutuel (§ 30.1)', () => {
  it('enregistrement puis connexion par clé (niveau PHR) ; rôle sensible : TOTP en secours motivé seulement, alerté', async () => {
    const { app, clock, req } = await setup();
    const H = { origin: ORIGIN };
    const totpLogin = async (fallbackReason?: string) => {
      const r = await req('POST', '/v1/auth/login', { body: { method: 'password', login: 'u-tresor', password: DEMO_PASSWORD, ...(fallbackReason ? { fallbackReason } : {}) } });
      if (r.statusCode !== 200) return r;
      clock.advance(30_000);
      return req('POST', '/v1/auth/otp', { body: { challengeId: r.json().challengeId, code: totp(demoTotpSecret('u-tresor'), clock.now()) } });
    };
    const first = await totpLogin();
    expect(first.statusCode).toBe(200);
    const token = first.json().accessToken as string;
    const opts = (await req('POST', '/v1/auth/passkeys/registration', { token, body: {} })).json();
    const authn = new SoftAuthenticator();
    const reg = await req('POST', '/v1/auth/passkeys/registration/verify', { token, headers: H, body: { challengeId: opts.challengeId, response: authn.register(opts.options.challenge), label: 'Clé du poste Trésor' } });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).not.toHaveProperty('publicKey');
    // Défi à usage unique.
    expect((await req('POST', '/v1/auth/passkeys/registration/verify', { token, headers: H, body: { challengeId: opts.challengeId, response: authn.register(opts.options.challenge) } })).statusCode).toBe(401);
    // Connexion par clé : niveau résistant au hameçonnage.
    const ao = (await req('POST', '/v1/auth/passkeys/authentication/options', { body: { login: 'u-tresor' } })).json();
    const login = await req('POST', '/v1/auth/passkeys/authentication/verify', { headers: H, body: { challengeId: ao.challengeId, response: authn.assert(ao.options.challenge) } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ acr: 'urn:mosolo:acr:phr', user: { id: 'u-tresor' } });
    // Signature d'un autre défi refusée.
    const ao2 = (await req('POST', '/v1/auth/passkeys/authentication/options', { body: {} })).json();
    expect((await req('POST', '/v1/auth/passkeys/authentication/verify', { headers: H, body: { challengeId: ao2.challengeId, response: authn.assert('mauvais-defi') } })).statusCode).toBe(401);
    // Rôle sensible muni d'une clé : TOTP refusé sans motif, admis en secours motivé (journalisé, alerté).
    const noFallback = await totpLogin();
    expect(noFallback.statusCode).toBe(403);
    expect(noFallback.json()).toMatchObject({ code: 'PASSKEY_REQUIRED' });
    clock.advance(30_000);
    const fb = await totpLogin('Clé oubliée au bureau, intervention urgente');
    expect(fb.statusCode).toBe(200);
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'CONNEXION_SECOURS_TOTP')).toBe(true);
    const me = (await req('GET', '/v1/auth/me', { token: login.json().accessToken })).json();
    expect(me).toMatchObject({ passkeyStatus: 'ACTIVE', passkeys: 1 });
    await app.close();
  });

  it('mTLS (mode mandataire) : empreinte de certificat client exigée sur les interfaces partenaires quand il est activé', async () => {
    expect(mtlsFromEnv({}).mode).toBe('off');
    expect(() => mtlsFromEnv({ MOSOLO_MTLS_MODE: 'proxy' })).toThrow(/MOSOLO_MTLS_ALLOWLIST/);
    const fp = 'ab'.repeat(32);
    const prev = { mode: process.env.MOSOLO_MTLS_MODE, list: process.env.MOSOLO_MTLS_ALLOWLIST };
    process.env.MOSOLO_MTLS_MODE = 'proxy';
    process.env.MOSOLO_MTLS_ALLOWLIST = `${fp}=operateur-a`;
    try {
      const { app, req } = await setup();
      const denied = await req('POST', '/v1/providers/mm-operator-a/callbacks', { body: {} });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: 'MTLS_REQUIRED' });
      const passed = await req('POST', '/v1/providers/mm-operator-a/callbacks', { body: {}, headers: { 'x-client-cert-sha256': fp.toUpperCase().match(/.{2}/g)!.join(':') } });
      expect(passed.json().code).not.toBe('MTLS_REQUIRED');
      // Les autres routes ne sont pas concernées.
      expect((await req('GET', '/health')).statusCode).toBe(200);
      expect(app.ctx.audit.list({ action: 'socle.mtls.refused' }).total).toBe(1);
      await app.close();
    } finally {
      if (prev.mode === undefined) delete process.env.MOSOLO_MTLS_MODE; else process.env.MOSOLO_MTLS_MODE = prev.mode;
      if (prev.list === undefined) delete process.env.MOSOLO_MTLS_ALLOWLIST; else process.env.MOSOLO_MTLS_ALLOWLIST = prev.list;
    }
  });
});
