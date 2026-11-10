/**
 * Gestion documentaire (module 38) — liste des demandes de purge (27/09/2026) : l'approbateur décide depuis la liste
 * (plus de saisie à l'aveugle d'un identifiant) ; lecture réservée au DPO, à l'audit et à la sécurité ; la décision
 * reste à deux personnes distinctes.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { documentsPlugin } from '../src/plugins/documents/plugin.js';
import { integriteGouvernancePlugin } from '../src/plugins/integrite/gouvernance/plugin.js';
import { DEMO } from './helpers.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('Module 38 — liste des demandes de purge', () => {
  it('le DPO propose, l’audit voit la demande dans la liste et décide ; les autres rôles sont refusés', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, plugins: [integriteGouvernancePlugin, documentsPlugin], secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} } });
    await app.ready();
    app.ctx.users.add({ id: 'u-dpo-liste', name: 'DPO (test)', roles: ['R25'], entity: 'GOUVERNORAT' });
    const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
      method: method as 'GET', url, headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

    const bail = (await req('POST', '/v1/documents', 'u-guichet', { title: 'Bail', fileName: 'bail.txt', contentType: 'text/plain', contentBase64: b64('Contrat de bail entre le bailleur et le preneur.'), category: 'BAIL', taxpayerId: DEMO.taxpayerId })).json();
    const cr = (await req('POST', '/v1/integrite/thresholds/change-requests', 'u-dg-dgipk', { parameterId: 'conservation.documents.bail_jours', kind: 'MODIFICATION', proposedValue: 30, motif: 'Durée de test' })).json();
    expect((await req('POST', `/v1/integrite/thresholds/change-requests/${cr.id}/decision`, 'u-ministre-finances', { approve: true, motif: 'Approuvé pour test' })).statusCode).toBe(200);
    clock.advance(31 * 86_400_000);

    expect((await req('GET', '/v1/documents/purges', 'u-auditeur')).json()).toEqual([]);
    const p = (await req('POST', '/v1/documents/purges', 'u-dpo-liste', { documentIds: [bail.id], motif: 'Échéance de conservation atteinte' })).json();

    const list = await req('GET', '/v1/documents/purges', 'u-auditeur');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: p.id, status: 'PROPOSEE', documentIds: [bail.id], proposedBy: 'u-dpo-liste' })]);
    expect((await req('GET', '/v1/documents/purges', 'u-dpo-liste')).statusCode).toBe(200);
    expect((await req('GET', '/v1/documents/purges', 'u-rssi')).statusCode).toBe(200);
    expect((await req('GET', '/v1/documents/purges', 'u-guichet')).statusCode).toBe(403);
    expect((await req('GET', '/v1/documents/purges', 'u-contribuable')).statusCode).toBe(403);

    // Décision depuis la liste, par une personne distincte : l'état est reflété dans la liste.
    expect((await req('POST', `/v1/documents/purges/${p.id}/decision`, 'u-auditeur', { approve: true, motif: 'Aperçu vérifié' })).statusCode).toBe(200);
    expect((await req('GET', '/v1/documents/purges', 'u-rssi')).json()[0]).toMatchObject({ id: p.id, status: 'APPROUVEE', purged: [bail.id] });
  });
});
