/**
 * Module 38 — Gestion documentaire : stockage chiffré (versions, empreintes), sceau, OCR et classification proposée puis
 * confirmée, conservation par catégorie (registre des seuils), purge à deux personnes sauf preuves d'audit, exports
 * filigranés et expirables, contrôle d'intégrité (alerte), indicateurs (volume stocké, intégrité vérifiée).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { documentsPlugin, type DocumentService } from '../src/plugins/documents/plugin.js';
import { classify, extractNativeText } from '../src/plugins/documents/service.js';
import { integriteGouvernancePlugin } from '../src/plugins/integrite/gouvernance/plugin.js';
import { DEMO, type TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: [integriteGouvernancePlugin, documentsPlugin], secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} } });
  await app.ready();
  app.ctx.users.add({ id: 'u-dpo-test', name: 'Délégué à la protection des données (test)', roles: ['R25'], entity: 'GOUVERNORAT' });
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}
const svc = (env: TestEnv) => env.app.ctx.ext.documents as DocumentService;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const BAIL = 'Contrat de bail entre le bailleur et le preneur. Loyer mensuel payable au compte public désigné.';

describe('Module 38 — gestion documentaire', () => {
  it('dépôt chiffré et scellé, OCR natif, classification proposée puis confirmée, versions conservées, cloisonnement', async () => {
    const env = await setup();
    const up = await env.req('POST', '/v1/documents', 'u-guichet', { title: 'Bail de l’unité 01', fileName: 'bail.txt', contentType: 'text/plain', contentBase64: b64(BAIL), taxpayerId: DEMO.taxpayerId });
    expect(up.statusCode).toBe(201);
    const doc = up.json();
    expect(doc.classification).toMatchObject({ status: 'PROPOSEE', proposal: { category: 'BAIL' } });
    expect(doc.classification.proposal.matched).toEqual(expect.arrayContaining(['bail', 'bailleur']));
    expect(doc.versions[0]).toMatchObject({ version: 1, encrypted: true, ocr: { source: 'TEXTE_NATIF' } });
    expect(doc.versions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // Chiffré au repos : le texte clair n'apparaît pas dans le stockage.
    const stored = svc(env).versions.all()[0]!;
    expect(Buffer.from(stored.cipher!.data, 'base64').toString('utf8')).not.toContain('bailleur');
    expect(stored.cipher!.alg).toBe('AES-256-GCM');
    // Scellement inscrit au journal chaîné.
    expect(env.app.ctx.audit.list({ resourceId: doc.id, limit: 10 }).items.map((e) => e.action)).toContain('document.sealed');
    // Lecture : contenu identique à l'original.
    const read = (await env.req('GET', `/v1/documents/${doc.id}/contenu`, 'u-controleur')).json();
    expect(Buffer.from(read.contentBase64, 'base64').toString('utf8')).toBe(BAIL);
    // Nouvelle version : l'ancienne est conservée et lisible.
    const v2 = (await env.req('POST', `/v1/documents/${doc.id}/versions`, 'u-guichet', { fileName: 'bail-v2.txt', contentType: 'text/plain', contentBase64: b64(`${BAIL} Avenant n° 1.`) })).json();
    expect(v2.currentVersion).toBe(2);
    expect(v2.versions).toHaveLength(2);
    expect(Buffer.from((await env.req('GET', `/v1/documents/${doc.id}/contenu?version=1`, 'u-controleur')).json().contentBase64, 'base64').toString('utf8')).toBe(BAIL);
    // Classification confirmée par une personne.
    const conf = (await env.req('POST', `/v1/documents/${doc.id}/classification`, 'u-controleur', { category: 'BAIL', motif: 'Bail vérifié' })).json();
    expect(conf.classification).toMatchObject({ status: 'CONFIRMEE', confirmedBy: 'u-controleur' });
    // Cloisonnement : le propriétaire voit sa pièce ; un autre contribuable non.
    expect((await env.req('GET', '/v1/documents', 'u-contribuable')).json()).toHaveLength(1);
    expect((await env.req('GET', `/v1/documents/${doc.id}`, 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/documents', 'u-locataire')).json()).toHaveLength(0);
  });

  it('OCR du terminal pour une image ; quittance classée preuve d’audit ; lecture de texte PDF natif', async () => {
    const env = await setup();
    const img = (await env.req('POST', '/v1/documents', 'u-controleur', { title: 'Photo', fileName: 'q.jpg', contentType: 'image/jpeg', contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]).toString('base64'), ocrText: 'QUITTANCE — référence de paiement PR-123 — montant payé 50 USD' })).json();
    expect(img.versions[0].ocr.source).toBe('OCR_TERMINAL');
    expect(img.category).toBe('QUITTANCE_JUSTIFICATIF');
    expect(img.auditProof).toBe(true);
    expect(img.retention.status).toBe('PREUVE_AUDIT');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> stream\nBT (PROCES-VERBAL de constat) Tj [(agent ) (verbalisant)] TJ ET\nendstream', 'latin1');
    expect(extractNativeText('application/pdf', pdf)).toContain('PROCES-VERBAL de constat');
    expect(classify(extractNativeText('application/pdf', pdf), 'application/pdf', 'Scan').category).toBe('PROCES_VERBAL');
    expect(classify('', 'image/png', 'Façade').category).toBe('PHOTO_PREUVE');
  });

  it('export filigrané remis au seul demandeur, vérifiable, expirant ; intégrité vérifiée puis écart détecté (alerte)', async () => {
    const env = await setup();
    const doc = (await env.req('POST', '/v1/documents', 'u-guichet', { title: 'Bail', fileName: 'bail.txt', contentType: 'text/plain', contentBase64: b64(BAIL), taxpayerId: DEMO.taxpayerId })).json();
    const ex = await env.req('POST', `/v1/documents/${doc.id}/exports`, 'u-controleur', { motif: 'Transmission au juriste' });
    expect(ex.statusCode).toBe(201);
    const { token, expiresAt } = ex.json();
    expect(Date.parse(expiresAt) - Date.parse('2026-09-26T09:00:00.000Z')).toBe(24 * 3_600_000);
    expect((await env.req('GET', `/v1/documents/exports/${token}`, 'u-guichet')).json().code).toBe('EXPORT_NOT_YOURS');
    const got = (await env.req('GET', `/v1/documents/exports/${token}`, 'u-controleur')).json();
    const text = Buffer.from(got.contentBase64, 'base64').toString('utf8');
    expect(text.startsWith('COPIE EXPORTÉE — ')).toBe(true);
    expect(text).toContain(BAIL);
    expect((await env.req('POST', '/v1/documents/filigranes/verification', 'u-controleur', { text: got.watermark.text, signature: got.watermark.signature, sha256: got.sha256 })).json().valid).toBe(true);
    expect((await env.req('POST', '/v1/documents/filigranes/verification', 'u-controleur', { text: `${got.watermark.text} modifié`, signature: got.watermark.signature, sha256: got.sha256 })).json().valid).toBe(false);
    env.clock.advance(25 * 3_600_000);
    expect((await env.req('GET', `/v1/documents/exports/${token}`, 'u-controleur')).json().code).toBe('EXPORT_EXPIRED');

    expect((await env.req('POST', '/v1/documents/integrite/verification', 'u-guichet')).statusCode).toBe(403);
    const ok = (await env.req('POST', '/v1/documents/integrite/verification', 'u-auditeur')).json();
    expect(ok).toMatchObject({ checked: 1, ok: 1, failures: [] });
    const v = svc(env).versions.all()[0]!;
    const data = Buffer.from(v.cipher!.data, 'base64');
    data[0] = data[0]! ^ 0xff;
    svc(env).versions.update({ ...v, cipher: { ...v.cipher!, data: data.toString('base64') } });
    const ko = (await env.req('POST', '/v1/documents/integrite/verification', 'u-auditeur')).json();
    expect(ko.failures).toHaveLength(1);
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'DOCUMENT_INTEGRITE')).toBe(true);
    expect((await env.req('GET', `/v1/documents/${doc.id}/contenu`, 'u-controleur')).statusCode).toBeGreaterThanOrEqual(400);
    const ind = (await env.req('GET', '/v1/documents/indicateurs', 'u-auditeur')).json();
    expect(ind.volume).toMatchObject({ documents: 1, versions: 1 });
    expect(ind.volume.octets).toBe(Buffer.byteLength(BAIL));
    expect(ind.integrite).toMatchObject({ statut: 'MESURE', ecarts: 1 });
  });

  it('conservation par catégorie (registre) : purge à échéance après aperçu, deux personnes ; jamais une preuve d’audit ni sous gel', async () => {
    const env = await setup();
    const bail = (await env.req('POST', '/v1/documents', 'u-guichet', { title: 'Bail', fileName: 'bail.txt', contentType: 'text/plain', contentBase64: b64(BAIL), category: 'BAIL', taxpayerId: DEMO.taxpayerId })).json();
    const gel = (await env.req('POST', '/v1/documents', 'u-guichet', { title: 'Bail litigieux', fileName: 'b2.txt', contentType: 'text/plain', contentBase64: b64(`${BAIL} litige`), category: 'BAIL', taxpayerId: DEMO.taxpayerId })).json();
    const pv = (await env.req('POST', '/v1/documents', 'u-controleur', { title: 'PV de constat', fileName: 'pv.txt', contentType: 'text/plain', contentBase64: b64('Procès-verbal de constat'), category: 'PROCES_VERBAL' })).json();
    expect(bail.retention.status).toBe('DUREE_NON_FIXEE');
    // Durée fixée au registre des seuils par deux personnes.
    const cr = (await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-dg-dgipk', { parameterId: 'conservation.documents.bail_jours', kind: 'MODIFICATION', proposedValue: 30, motif: 'Durée de test' })).json();
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${cr.id}/decision`, 'u-ministre-finances', { approve: true, motif: 'Approuvé pour test' })).statusCode).toBe(200);
    await env.req('POST', `/v1/documents/${gel.id}/gel-juridique`, 'u-auditeur', { motif: 'Réclamation en cours' });
    env.clock.advance(31 * 86_400_000);
    const preview = (await env.req('GET', '/v1/documents/purges/apercu', 'u-dpo-test')).json();
    expect(preview.map((p: { id: string }) => p.id)).toEqual([bail.id]);
    const inel = (await env.req('POST', '/v1/documents/purges', 'u-dpo-test', { documentIds: [pv.id], motif: 'Tentative' })).json(); expect(inel.code, JSON.stringify(inel)).toBe('PURGE_NOT_ELIGIBLE');
    const req = (await env.req('POST', '/v1/documents/purges', 'u-dpo-test', { documentIds: [bail.id], motif: 'Échéance de conservation atteinte' })).json();
    expect((await env.req('POST', `/v1/documents/purges/${req.id}/decision`, 'u-dpo-test', { approve: true, motif: 'auto-validation' })).statusCode).toBe(403);
    const done = (await env.req('POST', `/v1/documents/purges/${req.id}/decision`, 'u-auditeur', { approve: true, motif: 'Aperçu vérifié' })).json();
    expect(done.purged).toEqual([bail.id]);
    const after = (await env.req('GET', `/v1/documents/${bail.id}`, 'u-auditeur')).json();
    expect(after.status).toBe('PURGE');
    expect(after.versions[0]).toMatchObject({ encrypted: false, sha256: bail.versions[0].sha256, seal: bail.versions[0].seal });
    expect((await env.req('GET', `/v1/documents/${bail.id}/contenu`, 'u-auditeur')).json().code).toBe('DOCUMENT_PURGED');
    expect((await env.req('GET', `/v1/documents/${pv.id}`, 'u-auditeur')).json().status).toBe('ACTIF');
  });
});
