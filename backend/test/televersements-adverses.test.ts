/**
 * Deuxième passe adverse (27/09/2026), phase « téléversement et stockage » : gestion documentaire (module 38) et
 * photos de preuve. Fichier vide, surdimensionné, exécutable renommé, double extension, type déclaré faux, SVG avec
 * script, HTML, noms Unicode / très longs / traversée de chemin, JPEG corrompu, doublons, document d'autrui (IDOR),
 * lien d'export expiré ou d'un autre demandeur.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sanitizeFileName } from '../src/plugins/documents/controle-fichiers.js';
import { documentsPlugin } from '../src/plugins/documents/plugin.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: [documentsPlugin], secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
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

const b64 = (x: string | Buffer | number[]) => (Buffer.isBuffer(x) ? x : Array.isArray(x) ? Buffer.from(x) : Buffer.from(x, 'utf8')).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\nBT (Bail commercial) Tj ET\n%%EOF');
const up = (e: TestEnv, user: string, body: Record<string, unknown>) => e.req('POST', '/v1/documents', user, { title: 'Pièce de test', ...body });

describe('Gestion documentaire : fichiers hostiles', () => {
  it('refuse vide, exécutable renommé, double extension, type faux, SVG/HTML actifs, base64 invalide ; rien n’est stocké', async () => {
    const e = await setup();
    const before = (e.app.ctx.ext.documents as { versions: { count(): number } }).versions.count();
    const cases: [string, Record<string, unknown>, number, string][] = [
      ['vide', { fileName: 'a.pdf', contentType: 'application/pdf', contentBase64: '' }, 400, 'VALIDATION_ERROR'],
      ['vide (base64 de zéro octet)', { fileName: 'a.pdf', contentType: 'application/pdf', contentBase64: '====' }, 400, 'BASE64_INVALIDE'],
      ['exécutable renommé en PDF', { fileName: 'facture.pdf', contentType: 'application/pdf', contentBase64: b64([0x4d, 0x5a, 0x90, 0x00, 0x03]) }, 400, 'FICHIER_CONTENU_ACTIF'],
      ['ELF renommé en JPEG', { fileName: 'photo.jpg', contentType: 'image/jpeg', contentBase64: b64([0x7f, 0x45, 0x4c, 0x46, 0x02]) }, 400, 'FICHIER_CONTENU_ACTIF'],
      ['double extension', { fileName: 'quittance.pdf.exe', contentType: 'application/pdf', contentBase64: b64(PDF) }, 400, 'FICHIER_EXTENSION_INTERDITE'],
      ['double extension inversée', { fileName: 'quittance.exe.pdf', contentType: 'application/pdf', contentBase64: b64(PDF) }, 400, 'FICHIER_EXTENSION_INTERDITE'],
      ['type déclaré faux (texte déclaré PDF)', { fileName: 'bail.pdf', contentType: 'application/pdf', contentBase64: b64('Bail en texte brut') }, 400, 'FICHIER_SIGNATURE_INCOHERENTE'],
      ['extension incohérente', { fileName: 'bail.png', contentType: 'application/pdf', contentBase64: b64(PDF) }, 400, 'FICHIER_EXTENSION_INCOHERENTE'],
      ['SVG avec script', { fileName: 'logo.svg', contentType: 'image/svg+xml', contentBase64: b64('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, 400, 'FICHIER_EXTENSION_INTERDITE'],
      ['SVG déguisé en texte', { fileName: 'logo.txt', contentType: 'text/plain', contentBase64: b64('<svg onload="alert(1)"></svg>') }, 400, 'FICHIER_CONTENU_ACTIF'],
      ['HTML', { fileName: 'page.txt', contentType: 'text/plain', contentBase64: b64('<!DOCTYPE html><html><script>fetch("/v1/auth/me")</script></html>') }, 400, 'FICHIER_CONTENU_ACTIF'],
      ['type HTML déclaré', { fileName: 'page', contentType: 'text/html', contentBase64: b64('bonjour') }, 415, 'TYPE_FICHIER_NON_ADMIS'],
      ['type inconnu', { fileName: 'archive', contentType: 'application/octet-stream', contentBase64: b64(PDF) }, 415, 'TYPE_FICHIER_NON_ADMIS'],
      ['script #!', { fileName: 'notes.txt', contentType: 'text/plain', contentBase64: b64('#!/bin/sh\nrm -rf /') }, 400, 'FICHIER_CONTENU_ACTIF'],
      ['base64 invalide', { fileName: 'a.txt', contentType: 'text/plain', contentBase64: 'ceci n’est pas du base64 !' }, 400, 'BASE64_INVALIDE'],
      ['texte binaire', { fileName: 'a.txt', contentType: 'text/plain', contentBase64: b64(Buffer.from([0x41, 0x00, 0x42, 0x43])) }, 400, 'FICHIER_SIGNATURE_INCOHERENTE'],
      ['traversée seule', { fileName: '../..', contentType: 'text/plain', contentBase64: b64('x') }, 400, 'NOM_FICHIER_INVALIDE'],
    ];
    for (const [label, body, status, code] of cases) {
      const r = await up(e, 'u-guichet', body);
      expect(r.statusCode, `${label} : ${r.body}`).toBe(status);
      expect(r.json().code, label).toBe(code);
      expect(r.headers['content-type']).toMatch(/problem\+json/);
    }
    expect((e.app.ctx.ext.documents as { versions: { count(): number } }).versions.count()).toBe(before);
  });

  it('surdimensionné : 413 au-delà de la limite de la route (15 Mo), sans lecture du contenu', async () => {
    const e = await setup();
    const r = await e.app.inject({
      method: 'POST', url: '/v1/documents', headers: { 'x-demo-user': 'u-guichet', 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'Trop gros', fileName: 'a.pdf', contentType: 'application/pdf', contentBase64: 'A'.repeat(16 * 1024 * 1024) }),
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe('CORPS_TROP_VOLUMINEUX');
  });

  it('noms Unicode, très longs, traversée de chemin, caractères de contrôle et inversion bidirectionnelle : assainis', async () => {
    expect(sanitizeFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFileName('..\\..\\Windows\\system.ini.txt')).toBe('system.ini.txt');
    expect(sanitizeFileName('facture‮txt.pdf')).toBe('facturetxt.pdf');
    expect(sanitizeFileName('rapport\u0000\u0007.pdf')).toBe('rapport.pdf');
    expect(sanitizeFileName('Procès-verbal Ngaliema — Kinshasa n°12.pdf')).toBe('Procès-verbal Ngaliema — Kinshasa n°12.pdf');
    const long = sanitizeFileName(`${'é'.repeat(500)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.pdf')).toBe(true);
    const e = await setup();
    const r = await up(e, 'u-guichet', { fileName: '../../../var/lib/mosolo/bail‮fdp.txt', contentType: 'text/plain', contentBase64: b64('Bail de l’unité 01') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().versions[0].fileName).toBe('bailfdp.txt');
  });

  it('JPEG corrompu de signature correcte : accepté (jamais décodé par le serveur) ; doublon signalé dans le même périmètre seulement', async () => {
    const e = await setup();
    const jpeg = b64([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);
    const a = await up(e, 'u-guichet', { fileName: 'scan.jpg', contentType: 'image/jpeg', contentBase64: jpeg, taxpayerId: DEMO.taxpayerId });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().doublon).toBeUndefined();
    const b = await up(e, 'u-guichet', { fileName: 'scan-bis.jpg', contentType: 'image/jpeg', contentBase64: jpeg, taxpayerId: DEMO.taxpayerId });
    expect(b.statusCode).toBe(201);
    expect(b.json().doublon).toMatchObject({ documentId: a.json().id });
    // Même contenu pour un AUTRE périmètre : aucun renvoi vers le document du premier contribuable.
    const c = await up(e, 'u-guichet', { fileName: 'scan.jpg', contentType: 'image/jpeg', contentBase64: jpeg });
    expect(c.json().doublon).toBeUndefined();
    expect(e.app.ctx.audit.list({ action: 'document.uploaded' }).items.some((x) => x.details.duplicateOf === a.json().id)).toBe(true);
  });

  it('IDOR : un contribuable ne lit ni la fiche, ni le contenu, ni l’export d’un document qui n’est pas le sien ; export expiré refusé', async () => {
    const e = await setup();
    const internal = (await up(e, 'u-guichet', { fileName: 'interne.txt', contentType: 'text/plain', contentBase64: b64('Note interne de la régie') })).json();
    const other = e.app.ctx.taxpayers.taxpayers.all().find((t) => t.id !== DEMO.taxpayerId)!;
    const foreign = (await up(e, 'u-guichet', { fileName: 'autrui.txt', contentType: 'text/plain', contentBase64: b64('Pièce d’un autre contribuable'), taxpayerId: other.id })).json();
    for (const id of [internal.id, foreign.id]) {
      for (const [m, url, body] of [['GET', `/v1/documents/${id}`], ['GET', `/v1/documents/${id}/contenu`], ['POST', `/v1/documents/${id}/exports`, { motif: 'Tentative d’accès' }], ['POST', `/v1/documents/${id}/versions`, { fileName: 'x.txt', contentType: 'text/plain', contentBase64: b64('écrasement') }]] as const) {
        const r = await e.req(m, url, 'u-contribuable', body);
        expect(r.statusCode, `${m} ${url}`).toBe(403);
      }
    }
    expect((await e.req('GET', '/v1/documents', 'u-contribuable')).json().map((d: { id: string }) => d.id)).not.toContain(foreign.id);
    // Export : remis au seul demandeur, et jamais après expiration.
    const ex = (await e.req('POST', `/v1/documents/${internal.id}/exports`, 'u-controleur', { motif: 'Transmission au contentieux' })).json();
    expect((await e.req('GET', `/v1/documents/exports/${ex.token}`, 'u-contribuable')).statusCode).toBe(403);
    expect((await e.req('GET', `/v1/documents/exports/${ex.token}`, 'u-guichet')).json().code).toBe('EXPORT_NOT_YOURS');
    expect((await e.req('GET', `/v1/documents/exports/${ex.token}`, 'u-controleur')).statusCode).toBe(200);
    e.clock.set(new Date(Date.parse(ex.expiresAt) + 1000).toISOString());
    const expired = await e.req('GET', `/v1/documents/exports/${ex.token}`, 'u-controleur');
    expect(expired.statusCode).toBe(409);
    expect(expired.json().code).toBe('EXPORT_EXPIRED');
    expect((await e.req('GET', '/v1/documents/exports/jeton-invente', 'u-controleur')).statusCode).toBe(404);
  });
});

describe('Photos de preuve (stationnement, publicité, contrôle technique)', () => {
  it('seul le JPEG de signature correcte est admis (vérification commune aux trois modules)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['parking/field.ts', 'publicite/service.ts', 'vehicules-controle/common.ts']) {
      const src = readFileSync(new URL(`../src/plugins/${f}`, import.meta.url), 'utf8');
      expect(src, f).toMatch(/JPEG_MAGIC = Buffer\.from\(\[0xff, 0xd8, 0xff\]\)/);
      expect(src, f).toMatch(/PHOTO_FORMAT/);
    }
  });
});
