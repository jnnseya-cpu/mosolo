import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { verifySealedPdf } from '../src/modules/receipts/pdf.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import { verticalesPlugin } from '../src/plugins/verticales/plugin.js';
import { VX_DEMO } from '../src/plugins/verticales/seed.js';
import type { TestEnv } from './helpers.js';

const H = (c: string) => c.repeat(64);

async function setup() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} }, plugins: [verticalesPlugin] });
  await app.ready();
  app.ctx.users.add({ id: 'u-auditeur-2', name: 'Auditrice interne n° 2 (test)', roles: ['R22'], entity: 'AUDIT' });
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body) => app.inject({
      method: method as 'GET', url, headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}

async function account(env: TestEnv, n: string) {
  const acc = (await env.req('POST', '/v1/verticales/calcu/accounts', VX_DEMO.users.publicEntity, { entityName: 'Entité pilote test', bank: 'Banque A', accountNumber: `CD00 8888 ${n}`, currency: 'CDF', type: 'PROJET', signatories: ['Ordonnateur'] })).json();
  await env.req('POST', `/v1/verticales/calcu/accounts/${acc.id}/validate`, 'u-validateur-financier', { as: 'FINANCES' });
  await env.req('POST', `/v1/verticales/calcu/accounts/${acc.id}/validate`, 'u-auditeur', { as: 'CONTROLE' });
  return acc;
}

describe('CALCU — registre des fournisseurs, conformité budgétaire, justificatifs géolocalisés (§ 27A.4)', () => {
  it('fournisseur hors registre ⇒ ambre ; dépassement de la ligne budgétaire ⇒ rouge ; paiement jamais bloqué', async () => {
    const env = await setup();
    const acc = await account(env, '0001');
    const f = (await env.req('POST', '/v1/verticales/calcu/fournisseurs', VX_DEMO.users.publicEntity, { name: 'Fournisseur Alpha', nif: 'NIF-ALPHA' })).json();
    expect((await env.req('POST', `/v1/verticales/calcu/fournisseurs/${f.id}/validation`, 'u-auditeur', {})).json().status).toBe('VALIDE');
    const lb = (await env.req('POST', '/v1/verticales/calcu/lignes-budgetaires', VX_DEMO.users.publicEntity, { entityName: 'Entité pilote test', exercice: 2026, code: '6.1.1', label: 'Fournitures (test)', allotted: { amount: '1000.00', currency: 'CDF' }, actRef: 'Budget voté 2026 (fictif)' })).json();
    expect((await env.req('POST', `/v1/verticales/calcu/lignes-budgetaires/${lb.id}/validation`, 'u-validateur-financier', {})).json().status).toBe('VALIDEE');
    const doc = (type: string, extra: Record<string, unknown> = {}) => env.req('POST', '/v1/verticales/calcu/justificatifs', VX_DEMO.users.publicEntity, {
      accountId: acc.id, operationRef: 'OP-1', type, supplier: 'Fournisseur Alpha', amount: { amount: '2000.00', currency: 'CDF' }, date: '2026-09-20', sha256: H(type[0]!.toLowerCase().replace(/[^a-f]/, 'a')),
      geo: { lat: -4.32, lon: 15.31, accuracyM: 10, capturedAt: '2026-09-20T10:00:00.000Z' }, commune: 'Gombe', ...extra,
    });
    expect((await doc('ENGAGEMENT', { budgetLineId: lb.id, supplierId: f.id })).statusCode).toBe(201);
    for (const t of ['DEVIS', 'BON_COMMANDE', 'FOURNISSEUR']) await doc(t, { supplierId: f.id });
    const tx = (await env.req('POST', '/v1/verticales/calcu/gateway/transactions', VX_DEMO.users.bank, { bank: 'Banque A', accountNumber: 'CD00 8888 0001', amount: { amount: '1500.00', currency: 'CDF' }, at: '2026-09-26T08:00:00.000Z', beneficiary: 'Fournisseur Alpha', reference: 'OP-1' })).json();
    expect(tx).toMatchObject({ score: 'ROUGE', blocked: false });
    const rec = env.app.ctx.ext.verticales as { calcu: { transactions: { get(id: string): { findings: string[] } | undefined } } };
    expect(rec.calcu.transactions.get(tx.id)!.findings.join(' ')).toMatch(/Dépassement de la ligne budgétaire/);
    const tx2 = (await env.req('POST', '/v1/verticales/calcu/gateway/transactions', VX_DEMO.users.bank, { bank: 'Banque A', accountNumber: 'CD00 8888 0001', amount: { amount: '10.00', currency: 'CDF' }, at: '2026-09-26T09:00:00.000Z', beneficiary: 'Inconnu SARL', reference: 'OP-2' })).json();
    expect(rec.calcu.transactions.get(tx2.id)!.findings.join(' ')).toMatch(/absent du registre des fournisseurs/);
  });
});

describe('CALCU — organe de contrôle : PDF, missions, justice, recommandations, tableaux (§ 27A.4, § 27A.5)', () => {
  it('rapport PDF cacheté ; mission sans déplacement ; transmission à la justice à deux personnes ; tableaux', async () => {
    const env = await setup();
    await account(env, '0002');
    const tx = (await env.req('POST', '/v1/verticales/calcu/gateway/transactions', VX_DEMO.users.bank, { bank: 'Banque A', accountNumber: 'CD00 8888 0002', amount: { amount: '300.00', currency: 'CDF' }, at: '2026-09-26T08:00:00.000Z', beneficiary: 'Fournisseur Z', reference: 'R-9' })).json();
    expect(tx.reportId).toBeTruthy();
    const pdf = await env.req('GET', `/v1/verticales/calcu/reports/${tx.reportId}/pdf`, 'u-auditeur');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(verifySealedPdf(pdf.rawPayload, env.app.ctx.receipts).valid).toBe(true);
    expect((await env.req('GET', `/v1/verticales/calcu/reports/${tx.reportId}/pdf`, VX_DEMO.users.bank)).statusCode).toBe(403);

    const m = (await env.req('POST', '/v1/verticales/calcu/missions', 'u-auditeur', { reportId: tx.reportId, entityName: 'Entité pilote test', objet: 'Vérification des pièces (test)', scope: 'Transactions de septembre (test)' })).json();
    expect(m).toMatchObject({ mode: 'SANS_DEPLACEMENT', status: 'OUVERTE' });
    expect((await env.req('GET', `/v1/verticales/calcu/missions/${m.id}/preuves`, 'u-auditeur')).json().transactions).toHaveLength(1);
    expect((await env.req('POST', `/v1/verticales/calcu/missions/${m.id}/cloture`, 'u-auditeur', { conclusions: 'Pièces absentes confirmées (test).' })).json().status).toBe('CLOTUREE');

    const j = (await env.req('POST', `/v1/verticales/calcu/reports/${tx.reportId}/transmission-justice`, 'u-auditeur', { motif: 'Paiement sans aucune pièce justificative (test).', authority: 'Parquet (fictif)', pieces: [H('e')] })).json();
    expect((await env.req('POST', `/v1/verticales/calcu/transmissions/${j.id}/decision`, 'u-auditeur', { approve: true, motif: 'Auto-décision (refusée).' })).json().code).toBe('SEPARATION_OF_DUTIES');
    const t = (await env.req('POST', `/v1/verticales/calcu/transmissions/${j.id}/decision`, 'u-auditeur-2', { approve: true, motif: 'Transmission décidée (test).' })).json();
    expect(t.status).toBe('TRANSMISE');
    expect(t.bordereau.sha256).toMatch(/^[0-9a-f]{64}$/);

    await env.req('POST', `/v1/verticales/calcu/reports/${tx.reportId}/recuperations`, 'u-auditeur', { amount: { amount: '300.00', currency: 'CDF' }, evidenceSha256: H('f'), note: 'Reversement constaté (test)' });
    const r = (await env.req('POST', '/v1/verticales/calcu/recommandations', 'u-auditeur', { entityName: 'Entité pilote test', text: 'Joindre les devis à chaque engagement (test).', dueDate: '2026-09-25' })).json();
    await env.req('POST', `/v1/verticales/calcu/recommandations/${r.id}/suivi`, 'u-auditeur', { status: 'EXECUTEE', note: 'Procédure mise à jour (test).' });
    const dash = (await env.req('GET', '/v1/verticales/calcu/organe', 'u-auditeur')).json();
    expect(dash.recovered.amounts).toEqual([{ amount: '300.00', currency: 'CDF' }]);
    expect(dash.controlled.transactions).toBeGreaterThan(0);
    expect(dash.recommendations).toMatchObject({ issued: 1, executed: 1, executionRate: '100 %' });
    expect(dash.institutionsAtRisk.map((x: { entityName: string }) => x.entityName)).toContain('Entité pilote test');
    expect(dash.exposedZones.map((x: { commune: string }) => x.commune)).toContain('NON_LOCALISE');
    expect(CIRCUITS.map((c) => c.code)).toEqual(expect.arrayContaining(['CALCU_TRANSMISSION_JUSTICE', 'CALCU_FOURNISSEUR', 'CALCU_LIGNE_BUDGETAIRE']));
  });
});
