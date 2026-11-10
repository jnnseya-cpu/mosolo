/**
 * Spécification fonctionnelle, module 29 — Règlement en trésorerie : import des relevés (banques et opérateurs) à
 * DOUBLE VALIDATION, contrôle d'intégrité, paiements « réglés », indicateurs (délai de règlement, imports en attente).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import { parseStatementFile, tresorRelevesPlugin } from '../src/plugins/tresor/releves.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [tresorPlugin, tresorRelevesPlugin] });
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

async function confirmedOrder(env: TestEnv) {
  const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
  const order = (await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  expect((await signedCallback(env, callbackBody(env, order.paymentReference, order.amount))).statusCode).toBe(200);
  return order as { id: string; paymentReference: string; amount: { amount: string; currency: 'USD' } };
}

describe('Module 29 — import des relevés à double validation', () => {
  it('la proposition n’écrit rien ; le proposant ne valide pas ; une seconde personne valide : réglé puis rapproché, quittance définitive', async () => {
    const env = await setup();
    const order = await confirmedOrder(env);
    const ledgerBefore = env.app.ctx.ledger.list({}).length;
    const body = { statementId: 'REL-M29-01', lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }] };
    const p = await env.req('POST', '/v1/settlements/statements', 'u-tresor', body);
    expect(p.statusCode).toBe(202);
    expect(p.json()).toMatchObject({ status: 'EN_ATTENTE_VALIDATION', statementId: 'REL-M29-01', proposedBy: 'u-tresor', integrity: { ok: true } });
    // Rien n'est appliqué avant la seconde validation.
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONFIRME');
    expect(env.app.ctx.ledger.list({}).length).toBe(ledgerBefore);
    expect(env.app.ctx.treasury.statements.get('REL-M29-01')).toBeUndefined();
    // Même proposition rejouée : même proposition (idempotent) ; contenu différent : 409.
    expect((await env.req('POST', '/v1/settlements/statements', 'u-tresor', body)).json().id).toBe(p.json().id);
    const altered = { ...body, lines: [{ ...body.lines[0]!, amount: { amount: '1.00', currency: 'USD' } }] };
    expect((await env.req('POST', '/v1/settlements/statements', 'u-tresor', altered)).statusCode).toBe(409);
    // Le proposant ne peut pas valider (séparation des tâches).
    const self = await env.req('POST', '/v1/settlements/statements/REL-M29-01/validation', 'u-tresor', { approve: true, motif: 'Je valide mon propre import' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    // Rôle non habilité : refus.
    expect((await env.req('POST', '/v1/settlements/statements/REL-M29-01/validation', 'u-contribuable', { approve: true, motif: 'Tentative interdite' })).statusCode).toBe(403);
    // Seconde personne (analyste de rapprochement) : application.
    const v = await env.req('POST', '/v1/settlements/statements/REL-M29-01/validation', 'u-analyste-rappro', { approve: true, motif: 'Relevé contrôlé contre l’avis de crédit.' });
    expect(v.statusCode).toBe(201);
    expect(v.json().matched).toHaveLength(1);
    const o = env.app.ctx.payments.byReference(order.paymentReference)!;
    expect(o.status).toBe('RAPPROCHE');
    expect(o.settledAt).toBeTruthy();
    expect(env.app.ctx.receipts.byPaymentOrder(env.app.ctx.payments.byReference(order.paymentReference)!.id)!.status).toBe('DEFINITIVE');
    // Rejeu du relevé appliqué : résultat d'origine (200), jamais une seconde écriture.
    const replay = await env.req('POST', '/v1/settlements/statements', 'u-tresor', body);
    expect(replay.statusCode).toBe(200);
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    // Décision déjà prise : une seconde validation est refusée.
    expect((await env.req('POST', '/v1/settlements/statements/REL-M29-01/validation', 'u-analyste-rappro', { approve: true, motif: 'Deuxième validation' })).statusCode).toBe(409);
    // Journal : proposition et validation par deux personnes, reconstituées par le circuit.
    const imports = (await env.req('GET', '/v1/settlements/imports', 'u-auditeur')).json();
    expect(imports[0]).toMatchObject({ status: 'VALIDE', decision: { by: 'u-analyste-rappro', approve: true }, result: { matched: 1 } });
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 10_000 }).items);
    expect(decisions.find((d) => d.circuit === 'TRESOR_IMPORT_RELEVE')).toMatchObject({ proposerId: 'u-tresor', approverId: 'u-analyste-rappro', outcome: 'APPROUVE' });
    expect(CIRCUITS.find((c) => c.code === 'TRESOR_IMPORT_RELEVE')?.guard?.url).toBe('/v1/settlements/statements/:statementId/validation');
  });

  it('rejet motivé : rien n’est écrit ; une nouvelle proposition reste possible', async () => {
    const env = await setup();
    const order = await confirmedOrder(env);
    const body = { statementId: 'REL-M29-REJ', lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }] };
    expect((await env.req('POST', '/v1/settlements/statements', 'u-analyste-rappro', body)).statusCode).toBe(202);
    const r = await env.req('POST', '/v1/settlements/statements/REL-M29-REJ/validation', 'u-tresor', { approve: false, motif: 'Avis de crédit illisible : demander un nouveau relevé.' });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('REJETE');
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONFIRME');
    expect((await env.req('POST', '/v1/settlements/statements', 'u-analyste-rappro', body)).statusCode).toBe(202);
  });

  it('contrôle d’intégrité : observations non bloquantes (doublons, compte inconnu, date future) portées au valideur', async () => {
    const env = await setup();
    const line = { accountAlias: DEMO.dgipkAlias, amount: { amount: '5.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-OBS-1' };
    const p = (await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-M29-OBS', lines: [line, line, { ...line, accountAlias: 'COMPTE-INCONNU' }, { ...line, valueDate: '2026-12-31', paymentReference: 'PR-OBS-2' }],
    })).json();
    expect(p.status).toBe('EN_ATTENTE_VALIDATION');
    const byCode = Object.fromEntries((p.integrity.checks as { code: string; ok: boolean; blocking: boolean }[]).map((c) => [c.code, c]));
    expect(byCode.DOUBLONS).toMatchObject({ ok: false, blocking: false });
    expect(byCode.COMPTES_COFFRE).toMatchObject({ ok: false, blocking: false });
    expect(byCode.DATES_FUTURES).toMatchObject({ ok: false, blocking: false });
    expect(p.integrity.totals).toEqual([{ amount: '20.00', currency: 'USD' }]);
  });

  it('dépôt de fichier : empreinte, totaux de contrôle, période, lecture ; intégrité en échec ⇒ validation impossible ; rejeu d’un fichier refusé', async () => {
    const env = await setup();
    const order = await confirmedOrder(env);
    const content = `compte;montant;devise;date_valeur;reference\n${DEMO.dgipkAlias};${order.amount.amount};USD;2026-09-26;${order.paymentReference}\n`;
    const base = { source: 'BANQUE', institution: 'Banque de règlement (démo)', periodFrom: '2026-09-25', periodTo: '2026-09-26', fileName: 'releve-2026-09-26.csv', fileContent: content };
    // Totaux déclarés faux : intégrité en échec, rien n'est applicable.
    const bad = await env.req('POST', '/v1/tresor/releves/depots', 'u-analyste-rappro', { ...base, statementId: 'REL-F-KO', declared: { lines: 1, totals: [{ amount: '999.00', currency: 'USD' }] } });
    expect(bad.statusCode).toBe(202);
    expect(bad.json()).toMatchObject({ status: 'INTEGRITE_KO', source: { fileSha256: sha256Hex(Buffer.from(content, 'utf8')) } });
    expect(bad.json().integrity.checks.find((c: { code: string }) => c.code === 'TOTAUX_CONTROLE').ok).toBe(false);
    const refused = await env.req('POST', '/v1/settlements/statements/REL-F-KO/validation', 'u-tresor', { approve: true, motif: 'Validation malgré tout' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('STATEMENT_INTEGRITY_FAILED');
    // Hors période : échec.
    const outOfPeriod = (await env.req('POST', '/v1/tresor/releves/depots', 'u-analyste-rappro', { ...base, statementId: 'REL-F-PER', periodFrom: '2026-09-01', periodTo: '2026-09-02', declared: { lines: 1, totals: [order.amount] } })).json();
    expect(outOfPeriod.integrity.checks.find((c: { code: string }) => c.code === 'PERIODE').ok).toBe(false);
    // Ligne illisible : échec de lecture.
    const unreadable = (await env.req('POST', '/v1/tresor/releves/depots', 'u-analyste-rappro', { ...base, statementId: 'REL-F-LEC', fileContent: `${content}ligne;cassée\n`, declared: { lines: 1, totals: [order.amount] } })).json();
    expect(unreadable.status).toBe('INTEGRITE_KO');
    // Fichier conforme : proposé, puis validé par une autre personne.
    const ok = (await env.req('POST', '/v1/tresor/releves/depots', 'u-analyste-rappro', { ...base, statementId: 'REL-F-OK', declared: { lines: 1, totals: [order.amount] } })).json();
    expect(ok.status).toBe('EN_ATTENTE_VALIDATION');
    // Le même fichier sous un autre identifiant de relevé : rejeu refusé.
    const replay = (await env.req('POST', '/v1/tresor/releves/depots', 'u-analyste-rappro', { ...base, statementId: 'REL-F-BIS', declared: { lines: 1, totals: [order.amount] } })).json();
    expect(replay.integrity.checks.find((c: { code: string }) => c.code === 'REJEU_FICHIER').ok).toBe(false);
    expect((await env.req('POST', '/v1/settlements/statements/REL-F-OK/validation', 'u-tresor', { approve: true, motif: 'Totaux et empreinte conformes.' })).statusCode).toBe(201);
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('RAPPROCHE');
    // Indicateurs du module : délai de règlement mesuré sur données réelles, imports par statut.
    const ind = (await env.req('GET', '/v1/tresor/releves/indicateurs', 'u-tresor')).json();
    expect(ind.delaiReglement.statut).toBe('MESURE');
    expect(ind.imports).toMatchObject({ valides: 1, integriteKo: 4 });
    // Un contribuable ne dépose rien.
    expect((await env.req('POST', '/v1/tresor/releves/depots', 'u-contribuable', { ...base, statementId: 'X', declared: { lines: 1, totals: [order.amount] } })).statusCode).toBe(403);
  });

  it('lecture du fichier : séparateurs, en-tête, précision des montants', () => {
    expect(parseStatementFile('compte;montant;devise;date_valeur;reference\nA;1.00;USD;2026-09-26;R1').lines).toHaveLength(1);
    expect(parseStatementFile('A\t1.00\tUSD\t2026-09-26\tR1').lines[0]).toMatchObject({ accountAlias: 'A', paymentReference: 'R1' });
    expect(parseStatementFile('A;1.001;USD;2026-09-26;R1').errors[0]).toMatch(/trop précis/);
    expect(parseStatementFile('A;1.00;XYZ;2026-09-26;R1').errors[0]).toMatch(/devise inconnue/);
  });
});
