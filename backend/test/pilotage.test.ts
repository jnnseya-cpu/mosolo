import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { callbackHeaders, postStatement } from './helpers.js';
import { runDemoFlow } from '../src/plugins/pilotage/demo-flow.js';
import { pilotagePlugin } from '../src/plugins/pilotage/plugin.js';
import type { PilotageService } from '../src/plugins/pilotage/service.js';
import { ext } from '../src/plugins/types.js';
import { DEMO } from '../src/seed.js';

const SECRET = 'test-secret-mm-operator-a';

async function setupPilotage() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': SECRET }, commsProviderKeys: {} },
    plugins: [pilotagePlugin],
  });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req, ctx: app.ctx, svc: ext<PilotageService>(app.ctx, 'pilotage') };
}
type Env = Awaited<ReturnType<typeof setupPilotage>>;

let phoneSeq = 0;
/** Contribuable FICTIF + parcelle dans une commune + obligation sur la règle de démonstration (circuit réel). */
function newObligation(env: Env, commune: string, rank: 1 | 2 | 3 | 4 = 2) {
  const { ctx } = env;
  phoneSeq++;
  const tp = ctx.taxpayers.register({ phone: `+24397${String(phoneSeq).padStart(7, '0')}`, fullName: `Fictif Pilotage ${phoneSeq}`, language: 'fr', situation: 'landlord' });
  const obj = ctx.objects.create(ctx.users.get('u-guichet')!, {
    taxpayerId: tp.id, category: 'PARCELLE', commune, quartier: 'Test', localityRank: rank, lat: -4.3, lon: 15.3, attributes: {},
  });
  const rule = ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
  const { obligation } = ctx.assessment.calculate(ctx.users.get('u-controleur')!, { ruleId: rule.id, taxpayerId: tp.id, objectId: obj.id, inputs: {}, simulate: false });
  return { taxpayer: tp, object: obj, obligation: obligation! };
}

async function pay(env: Env, obligationId: string, channel = 'MOBILE_MONEY') {
  const order = (await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, 'u-guichet', { channel }, { 'idempotency-key': randomUUID() })).json();
  expect(order.paymentReference).toBeTruthy();
  const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() });
  const cb = await env.app.inject({
    method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw,
    headers: { 'content-type': 'application/json', ...callbackHeaders(SECRET, raw, env.clock.now()) },
  });
  expect(cb.json().status).toBe('CONFIRME');
  return order as { paymentReference: string; amount: { amount: string; currency: string }; id: string; beneficiaryAlias: string };
}

async function reconcile(env: Env, orders: { paymentReference: string; amount: { amount: string; currency: string } }[]) {
  const st = await postStatement(env, 'u-tresor', {
    statementId: `REL-${randomUUID()}`,
    lines: orders.map((o) => ({ accountAlias: DEMO.dgipkAlias, amount: o.amount, valueDate: '2026-09-26', paymentReference: o.paymentReference })),
  });
  expect(st.statusCode).toBe(201);
  return st.json();
}

const level = (body: { levels: { level: string }[] }, l: string) => body.levels.find((x) => x.level === l) as unknown as {
  measured: boolean; measure: string; amounts: { amount: string; currency: string }[]; count: number | null; consolidatedCdf: unknown; note?: string;
};

describe('Pilotage — échelle de la recette sur données réelles (§ 26.1)', () => {
  it('onze niveaux, mesurés sur le socle ; potentiel et disponible déclarés non mesurés ; jamais additionnés', async () => {
    const env = await setupPilotage();
    const r = await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur');
    expect(r.statusCode).toBe(200);
    let body = r.json();
    expect(body.example).toBe(false);
    expect(body.levels.map((l: { level: string }) => l.level)).toEqual([
      'potential', 'verified_base', 'assessed', 'due', 'overdue', 'initiated', 'confirmed', 'settled', 'reconciled', 'recorded', 'available',
    ]);
    expect(level(body, 'potential')).toMatchObject({ measured: false, measure: 'NON_MESURE', amounts: [], count: null });
    expect(level(body, 'available')).toMatchObject({ measured: false, measure: 'NON_MESURE' });
    expect(level(body, 'verified_base')).toMatchObject({ measure: 'COMPTE' });
    // Socle semé : une obligation fictive de 150 USD à Limete, non payée, non échue.
    expect(level(body, 'assessed').amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    expect(level(body, 'due').amounts).toEqual([]);
    expect(level(body, 'confirmed').amounts).toEqual([]);
    expect(body.rule).toMatch(/ne s’additionnent jamais/);
    expect(body.contested).toMatchObject({ separate: true, count: 0 });

    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = await pay(env, ob.id);
    body = (await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur')).json();
    expect(level(body, 'confirmed').amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    expect(level(body, 'settled').amounts).toEqual([]);
    expect(level(body, 'initiated').amounts).toEqual([]);
    await reconcile(env, [order]);
    body = (await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur')).json();
    for (const l of ['confirmed', 'settled', 'reconciled', 'recorded']) expect(level(body, l).amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    // Contre-valeur CDF indicative (taux de démonstration), montant décimal en chaîne.
    expect((level(body, 'reconciled').consolidatedCdf as { currency: string; amount: string }).currency).toBe('CDF');
    expect(typeof (level(body, 'reconciled').consolidatedCdf as { amount: string }).amount).toBe('string');

    // Filtres : commune du fait générateur, canal, catégorie, période.
    const masina = (await env.req('GET', '/v1/pilotage/echelle?commune=Masina', 'u-gouverneur')).json();
    expect(level(masina, 'reconciled').amounts).toEqual([]);
    const card = (await env.req('GET', '/v1/pilotage/echelle?channel=CARD', 'u-gouverneur')).json();
    expect(level(card, 'reconciled').amounts).toEqual([]);
    expect(level(card, 'assessed').amounts).toEqual([{ amount: '150.00', currency: 'USD' }]); // canal sans objet pour la liquidation
    const q = (await env.req('GET', '/v1/pilotage/echelle?period=2026-T2', 'u-gouverneur')).json();
    expect(level(q, 'reconciled').amounts).toEqual([]);
    const q3 = (await env.req('GET', '/v1/pilotage/echelle?period=2026-T3&category=IMPOT_PROVINCIAL&entity=DGIPK', 'u-gouverneur')).json();
    expect(level(q3, 'reconciled').amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    expect((await env.req('GET', '/v1/pilotage/echelle?period=2026-13', 'u-gouverneur')).statusCode).toBe(400);
    expect((await env.req('GET', '/v1/pilotage/echelle?commune=Paris', 'u-gouverneur')).statusCode).toBe(400);
  });

  it('exigible, en retard et contesté (indicateur séparé) suivent l’échéance et les réclamations', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    env.clock.set(new Date(new Date(ob.dueDate).getTime() + 2 * 86_400_000));
    let body = (await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur')).json();
    expect(level(body, 'due').amounts).toEqual([ob.amount]);
    expect(level(body, 'overdue').amounts).toEqual([ob.amount]);
    const ap = await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: ob.id, grounds: 'Surface contestée (test)' });
    expect(ap.statusCode).toBe(201);
    body = (await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur')).json();
    expect(level(body, 'due').amounts).toEqual([]);
    expect(body.contested).toMatchObject({ count: 1, amounts: [ob.amount] });
  });

  it('drill-down par commune, catégorie, canal et mois ; série mensuelle réelle', async () => {
    const env = await setupPilotage();
    const a = newObligation(env, 'Gombe', 1);
    const o = await pay(env, a.obligation.id, 'CARD');
    await reconcile(env, [o]);
    const d = (await env.req('GET', '/v1/pilotage/drill/commune', 'u-gouverneur')).json();
    expect(d.rows.map((r: { key: string }) => r.key)).toEqual(['Gombe', 'Limete']);
    expect(d.rows[0].values.reconciled.amounts).toEqual([{ amount: '450.00', currency: 'USD' }]);
    expect(d.rule).toMatch(/ne jamais additionner/);
    const ch = (await env.req('GET', '/v1/pilotage/drill/channel', 'u-gouverneur')).json();
    expect(ch.rows.map((r: { key: string }) => r.key)).toContain('CARD');
    expect(Object.keys(ch.rows[0].values)).not.toContain('assessed');
    expect((await env.req('GET', '/v1/pilotage/drill/month', 'u-gouverneur')).json().rows[0].key).toBe('2026-09');
    expect((await env.req('GET', '/v1/pilotage/drill/quartier', 'u-gouverneur')).statusCode).toBe(400);
    const s = (await env.req('GET', '/v1/pilotage/serie?months=3', 'u-gouverneur')).json();
    expect(s.months.map((m: { month: string }) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(s.months[2].reconciled.amounts).toEqual([{ amount: '450.00', currency: 'USD' }]);
  });
});

describe('Pilotage — contrôle d’accès et périmètres', () => {
  it('refuse contribuable, agent de terrain et anonyme ; journalise le refus', async () => {
    const env = await setupPilotage();
    expect((await env.req('GET', '/v1/pilotage/echelle')).statusCode).toBe(401);
    for (const u of ['u-contribuable', 'u-agent-terrain', 'u-juriste-redacteur']) {
      const r = await env.req('GET', '/v1/pilotage/echelle', u);
      expect(r.statusCode).toBe(403);
    }
    expect(env.ctx.audit.list({ action: 'access.denied' }).total).toBeGreaterThanOrEqual(3);
  });

  it('administration limitée à son entité ; commune limitée à son territoire', async () => {
    const env = await setupPilotage();
    // Ministre de tutelle DGTK (périmètre de son administration) : l'obligation semée est administrée par la DGIPK ⇒ invisible.
    const dgtk = (await env.req('GET', '/v1/pilotage/echelle', 'pilotage-u-ministre-tutelle')).json();
    expect(dgtk.scope).toMatchObject({ kind: 'ENTITE', entity: 'DGTK' });
    expect(level(dgtk, 'assessed').amounts).toEqual([]);
    const denied = await env.req('GET', '/v1/pilotage/echelle?entity=DGIPK', 'pilotage-u-ministre-tutelle');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('FORBIDDEN_SCOPE');
    const dgipk = (await env.req('GET', '/v1/pilotage/echelle', 'u-dg-dgipk')).json();
    expect(level(dgipk, 'assessed').amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);

    newObligation(env, 'Gombe', 1);
    const limR = await env.req('GET', '/v1/pilotage/tableaux/commune', 'pilotage-u-commune-limete');
    expect(limR.statusCode, limR.body).toBe(200);
    const lim = limR.json();
    expect(lim.scope).toMatchObject({ kind: 'TERRITOIRE', communes: ['Limete'] });
    expect(lim.commune).toBe('Limete');
    expect(level({ levels: lim.ladder }, 'assessed').amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    expect((await env.req('GET', '/v1/pilotage/tableaux/commune?commune=Gombe', 'pilotage-u-commune-limete')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/pilotage/tableaux/commune', 'u-gouverneur')).statusCode).toBe(400);
    const gombe = (await env.req('GET', '/v1/pilotage/tableaux/commune?commune=Gombe', 'u-gouverneur')).json();
    expect(level({ levels: gombe.ladder }, 'assessed').amounts).toEqual([{ amount: '450.00', currency: 'USD' }]);
  });

  it('tableaux par profil : bons rôles, agrégats sans donnée personnelle', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const o = await pay(env, ob.id);
    await reconcile(env, [o]);
    const cases: [string, string, number][] = [
      ['gouverneur', 'u-gouverneur', 200], ['gouverneur', 'u-tresor', 403], ['gouverneur', 'pilotage-u-sg', 200],
      ['dg-regie', 'u-dg-dgipk', 200], ['dg-regie', 'u-tresor', 403],
      ['tresor', 'u-tresor', 200], ['tresor', 'u-analyste-rappro', 200], ['tresor', 'u-dg-dgipk', 403],
      ['audit', 'u-auditeur', 200], ['audit', 'pilotage-u-auditeur-externe', 200], ['audit', 'u-gouverneur', 403],
      ['ministre', 'u-ministre-finances', 200], ['ministre', 'pilotage-u-ministre-tutelle', 200], ['ministre', 'u-contribuable', 403],
      ['inconnu', 'u-gouverneur', 404],
    ];
    for (const [p, u, code] of cases) expect((await env.req('GET', `/v1/pilotage/tableaux/${p}`, u)).statusCode, `${p} / ${u}`).toBe(code);

    const gov = (await env.req('GET', '/v1/pilotage/tableaux/gouverneur', 'u-gouverneur')).json();
    expect(gov).toMatchObject({ profile: 'gouverneur', aggregatesOnly: true, example: false });
    expect(gov.tiles.reconciled.today.amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    expect(gov.tiles.reconciled.yesterday.amounts).toEqual([]);
    expect(gov.byCommune.rows[0].key).toBe('Limete');
    const text = JSON.stringify(gov);
    for (const secret of [DEMO.taxpayerId, 'Mbuyi', '+243810000001', o.paymentReference]) expect(text).not.toContain(secret);

    const tres = (await env.req('GET', '/v1/pilotage/tableaux/tresor', 'u-tresor')).json();
    expect(tres.providers).toEqual([{ provider: 'mm-operator-a', confirmed: 1, settled: 1, reconciled: 1, awaiting: 0 }]);
    expect(tres.ledger.balanced).toBe(true);
    const aud = (await env.req('GET', '/v1/tableaux/audit', 'u-auditeur')).json(); // alias du contrat
    expect(aud.integrity.audit.ok).toBe(true);
    expect(aud.sensitive.find((s: { code: string }) => s.code === 'ACCES_REFUSES').count).toBeGreaterThanOrEqual(1);
    const dg = (await env.req('GET', '/v1/pilotage/tableaux/dg-regie', 'u-dg-dgipk')).json();
    expect(dg.recovery.note).toMatch(/Aucune pénalité/);
    expect(dg.performance.rows.length).toBeGreaterThan(0);

    const list = (await env.req('GET', '/v1/pilotage/tableaux', 'u-ministre-finances')).json();
    expect(list.profiles.map((p: { code: string }) => p.code)).toEqual(['gouverneur', 'dg-regie', 'tresor', 'commune', 'ministre']);
  });
});

describe('Pilotage — indicateurs calculés', () => {
  it('définition, formule, source, valeur, cible, statut et tendance ; non mesurés déclarés', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const o = await pay(env, ob.id);
    env.clock.advance(3_600_000); // règlement 1 h après la confirmation
    await reconcile(env, [o]);
    const r = (await env.req('GET', '/v1/pilotage/indicateurs', 'u-gouverneur')).json();
    const k = (code: string) => r.kpis.find((x: { code: string }) => x.code === code);
    for (const x of r.kpis) {
      expect(x.definition).toBeTruthy(); expect(x.formula).toBeTruthy(); expect(x.source).toBeTruthy(); expect(x.targetLabel).toBeTruthy();
      expect(x.trend).toHaveProperty('direction');
    }
    expect(k('RAPPROCHEMENT_J1')).toMatchObject({ value: '100.0', numerator: 1, denominator: 1, status: 'ATTEINTE' });
    expect(k('DELAI_REGLEMENT')).toMatchObject({ value: '1.0', unit: 'h', status: 'ATTEINTE' });
    expect(k('PART_NUMERIQUE')).toMatchObject({ value: '100.0', status: 'ATTEINTE' });
    expect(k('PAIEMENT_EMISES')).toMatchObject({ value: '100.0' });
    expect(k('PAIEMENT_ECHEANCE')).toMatchObject({ value: null, status: 'NON_CALCULABLE' }); // aucune obligation échue
    expect(k('TAUX_RECENSEMENT')).toMatchObject({ value: null, status: 'NON_MESURE', measurable: false });
    expect(k('COUT_COLLECTE').status).toBe('NON_MESURE');
    expect(k('COMMUNES_RECETTE')).toMatchObject({ value: '1', denominator: 24 });
    expect(k('COUVERTURE_LOCATIVE')).toMatchObject({ value: '100.0', numerator: 1, denominator: 1 });
    expect(k('REGLES_CERTIFIEES').detail).toMatch(/FICTIVE/);
    expect(k('OBLIGATIONS_CONTESTEES')).toMatchObject({ value: '0' });
    // Tendance sur 7 jours : aucun rapprochement il y a 7 jours ⇒ non calculable avant, donc indisponible.
    expect(k('RAPPROCHEMENT_J1').trend.direction).toBe('INDISPONIBLE');
    expect(k('PAIEMENT_EMISES').trend).toMatchObject({ direction: 'INDISPONIBLE' });
    expect(r.summary.total).toBe(r.kpis.length);
  });

  it('écart de rapprochement à J+2 et exceptions : paiement confirmé sans crédit', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    await pay(env, ob.id);
    env.clock.advance(3 * 86_400_000);
    const r = (await env.req('GET', '/v1/pilotage/indicateurs', 'u-tresor')).json();
    const k = (code: string) => r.kpis.find((x: { code: string }) => x.code === code);
    expect(k('ECART_RAPPROCHEMENT_J2')).toMatchObject({ value: '100.0', status: 'NON_ATTEINTE' });
    expect(k('RAPPROCHEMENT_J1')).toMatchObject({ value: '0.0', status: 'NON_ATTEINTE' });
    expect(Number(k('EXCEPTIONS_OUVERTES').value)).toBeGreaterThanOrEqual(1);
    const t = (await env.req('GET', '/v1/pilotage/tableaux/tresor', 'u-tresor')).json();
    expect(t.suspense.find((b: { code: string }) => b.code === 'gt48').count).toBe(1);
  });
});

describe('Pilotage — transparence publique trimestrielle', () => {
  it('suppression des petites cellules, masquage complémentaire, test anti-ré-identification, publication par l’autorité', async () => {
    const env = await setupPilotage();
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push(await pay(env, newObligation(env, 'Gombe', 1).obligation.id));
    for (let i = 0; i < 5; i++) orders.push(await pay(env, newObligation(env, 'Ngaliema', 2).obligation.id));
    orders.push(await pay(env, newObligation(env, 'Masina', 3).obligation.id)); // un seul contribuable : masqué
    await reconcile(env, orders);

    // Aperçu interne (non publié) ; le public ne voit rien tant que l'autorité n'a pas publié.
    expect((await env.req('GET', '/v1/public/transparency/2026-T3')).statusCode).toBe(404);
    expect((await env.req('GET', '/v1/pilotage/transparence/2026-T3', 'u-gouverneur')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/pilotage/transparence/2026-T3', 'u-tresor')).statusCode).toBe(403);
    const preview = (await env.req('GET', '/v1/pilotage/transparence/2026-T3', 'u-ministre-finances')).json();
    expect(preview.status).toBe('APERCU_NON_PUBLIE');
    expect(preview.check.passed).toBe(true);
    const row = (key: string) => preview.content.byCommune.find((r: { key: string }) => r.key === key);
    expect(row('Masina').cells[0]).toMatchObject({ suppressed: true, reason: 'SEUIL', amount: null, contributors: null });
    // Masquage complémentaire : la plus petite cellule publiable (Ngaliema) est masquée aussi.
    expect(row('Ngaliema').cells[0]).toMatchObject({ suppressed: true, reason: 'SECONDAIRE' });
    expect(row('Gombe').cells[0]).toMatchObject({ suppressed: false, amount: '2700.00', contributors: '5 à 9' });
    expect(preview.content.totals[0]).toMatchObject({ suppressed: false, amount: '3500.00', currency: 'USD' });
    expect(preview.content.appeals.suppressed).toBe(true);

    // Seules les autorités publient (décision humaine motivée), jamais l'audit ni le Trésor.
    expect((await env.req('POST', '/v1/pilotage/transparence/2026-T3/publier', 'u-auditeur', { motif: 'Publication trimestrielle T3' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/pilotage/transparence/2026-T3/publier', 'u-ministre-finances', { motif: 'court' })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/pilotage/transparence/2026-T4/publier', 'u-ministre-finances', { motif: 'Publication trimestrielle T4' })).statusCode).toBe(409);
    const pub = await env.req('POST', '/v1/pilotage/transparence/2026-T3/publier', 'u-ministre-finances', { motif: 'Publication trimestrielle T3 (test)' });
    expect(pub.statusCode).toBe(201);
    expect(pub.json()).toMatchObject({ period: '2026-T3', version: 1, authority: 'Ministre provincial des Finances' });
    const again = await env.req('POST', '/v1/pilotage/transparence/2026-T3/publier', 'u-ministre-finances', { motif: 'Publication trimestrielle T3 (test)' });
    expect(again.statusCode).toBe(409);
    expect(env.ctx.audit.list({ action: 'pilotage.transparency.published' }).total).toBe(1);

    // Route publique : sans utilisateur, sans aucune donnée personnelle.
    const pubView = await env.req('GET', '/v1/public/transparency/2026-T3');
    expect(pubView.statusCode).toBe(200);
    const text = pubView.body;
    for (const t of env.ctx.taxpayers.taxpayers.all()) {
      expect(text).not.toContain(t.id); expect(text).not.toContain(t.fullName); expect(text).not.toContain(t.phone); expect(text).not.toContain(t.iuc);
    }
    for (const o of orders) expect(text).not.toContain(o.paymentReference);
    const idx = (await env.req('GET', '/v1/public/transparency')).json();
    expect(idx.periods).toEqual([expect.objectContaining({ period: '2026-T3', version: 1 })]);
    // L'empreinte publiée correspond au contenu publié ; la signature se vérifie publiquement.
    const v = pubView.json();
    const verify = (await env.req('POST', '/v1/pilotage/exports/verify', undefined, { data: v.content, sha256: v.integrity.sha256, signature: v.integrity.signature })).json();
    expect(verify).toMatchObject({ valid: true, integrity: true, authentic: true });
    expect((await env.req('GET', '/v1/public/transparency/2026-13')).statusCode).toBe(400);
  });

  it('règle de dominance : un contribuable ne peut représenter plus de 85 % d’une cellule', async () => {
    const env = await setupPilotage();
    const orders = [await pay(env, newObligation(env, 'Gombe', 1).obligation.id)]; // 450 USD
    for (let i = 0; i < 4; i++) orders.push(await pay(env, newObligation(env, 'Gombe', 4).obligation.id)); // 4 × 10 USD
    await reconcile(env, orders);
    const svc = env.svc;
    const { build, check } = svc.transparencyBuild('2026-T3');
    expect(build.content.byCommune[0]!.cells[0]).toMatchObject({ suppressed: true, reason: 'DOMINANCE' });
    expect(build.content.totals[0]).toMatchObject({ suppressed: true, amount: null });
    // Le total, seul autre agrégat, est masqué lui aussi (sinon il révélerait la cellule).
    expect(check.passed).toBe(true);
    expect(check.checks.find((c) => c.code === 'DIFFERENCE')!.passed).toBe(true);
  });
});

describe('Pilotage — piste d’audit par dossier', () => {
  it('chronologie fusionnée audit + grand livre + quittances + délivrances, contrôles sans trou, accès réservé', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const o = await pay(env, ob.id);
    env.clock.advance(60_000);
    await reconcile(env, [o]);

    expect((await env.req('GET', `/v1/pilotage/piste-audit/${ob.id}`, 'u-gouverneur')).statusCode).toBe(403);
    expect((await env.req('GET', `/v1/pilotage/piste-audit/${ob.id}`, 'u-tresor')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/pilotage/piste-audit/INCONNU-123', 'u-auditeur')).statusCode).toBe(404);

    for (const ref of [ob.id, o.paymentReference, DEMO.parcelId]) {
      const r = await env.req('GET', `/v1/pilotage/piste-audit/${ref}`, 'u-auditeur');
      expect(r.statusCode, ref).toBe(200);
      const t = r.json();
      expect(t.complete).toBe(true);
      const sources = new Set(t.events.map((e: { source: string }) => e.source));
      for (const s of ['AUDIT', 'GRAND_LIVRE', 'QUITTANCE', 'DELIVRANCE']) expect(sources, `${ref} ${s}`).toContain(s);
      const kinds = t.events.map((e: { kind: string }) => e.kind);
      for (const k of ['assessment.issued', 'payment.reference.issued', 'payment.confirmed', 'reconciliation.matched', 'ASSESSMENT', 'PAYMENT_CONFIRMED', 'SETTLEMENT_CREDITED', 'receipt.final']) expect(kinds).toContain(k);
      // Ordre chronologique.
      const ats = t.events.map((e: { at: string }) => e.at);
      expect([...ats].sort()).toEqual(ats);
      expect(t.controls.every((c: { passed: boolean }) => c.passed)).toBe(true);
      // Délivrances : destinataire masqué.
      const d = t.events.find((e: { source: string }) => e.source === 'DELIVRANCE');
      expect(JSON.stringify(d)).not.toContain('Mbuyi Kalala');
    }
    expect(env.ctx.audit.list({ action: 'pilotage.audit_trail.viewed' }).total).toBe(3);
    const list = (await env.req('GET', '/v1/pilotage/piste-audit', 'u-enqueteur')).json();
    expect(list.items[0].payments[0].paymentReference).toBe(o.paymentReference);
  });

  it('détecte un trou : paiement rapproché sans quittance définitive', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const o = await pay(env, ob.id);
    await reconcile(env, [o]);
    const receipt = env.ctx.receipts.byPaymentOrder(env.ctx.payments.byReference(o.paymentReference)!.id)!;
    env.ctx.receipts.receipts.update({ ...receipt, status: 'PROVISOIRE' }); // altération simulée « en base »
    const t = (await env.req('GET', `/v1/pilotage/piste-audit/${o.paymentReference}`, 'u-auditeur')).json();
    expect(t.complete).toBe(false);
    expect(t.controls.find((c: { code: string }) => c.code === 'CHAINE_PAIEMENT')).toMatchObject({ passed: false });
  });
});

describe('Pilotage — exports signés et consultation jusqu’au paiement', () => {
  it('CSV + JSON, empreinte SHA-256, signature HMAC vérifiable ; altération détectée ; export journalisé', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    await reconcile(env, [await pay(env, ob.id)]);
    const r = await env.req('GET', '/v1/pilotage/exports/echelle?commune=Limete', 'u-gouverneur');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.csv.content.startsWith('﻿rang;niveau')).toBe(true);
    expect(b.csv.content).toContain('reconciled;Rapproché;MONTANT;USD;150.00');
    expect(b.csv.manifest.sha256).toBe(sha256Hex(Buffer.from(b.csv.content, 'utf8')));
    expect(b.csv.manifest).toMatchObject({ algorithm: 'HMAC-SHA256', keyId: 'mosolo-export-v1', format: 'csv', filters: { commune: 'Limete' } });
    expect(b.json.manifest.sha256).toBe(sha256Hex(b.json.content));
    const ok = (await env.req('POST', '/v1/pilotage/exports/verify', undefined, { payload: b.csv.content, sha256: b.csv.manifest.sha256, signature: b.csv.manifest.signature })).json();
    expect(ok).toMatchObject({ valid: true, registered: { exportId: b.exportId, kind: 'echelle', format: 'csv' } });
    const tampered = (await env.req('POST', '/v1/pilotage/exports/verify', undefined, { payload: b.csv.content.replace('150.00', '1500.00'), sha256: b.csv.manifest.sha256, signature: b.csv.manifest.signature })).json();
    expect(tampered).toMatchObject({ valid: false, integrity: false });
    const forged = (await env.req('POST', '/v1/pilotage/exports/verify', undefined, { payload: 'x', sha256: sha256Hex('x'), signature: 'a'.repeat(64) })).json();
    expect(forged).toMatchObject({ valid: false, integrity: true, authentic: false });
    expect(env.ctx.audit.list({ action: 'pilotage.export.generated' }).items[0]!.details).toMatchObject({ kind: 'echelle', csvSha256: b.csv.manifest.sha256 });

    const csv = await env.req('GET', '/v1/pilotage/exports/indicateurs?format=csv', 'u-tresor');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['x-mosolo-sha256']).toBe(sha256Hex(Buffer.from(csv.body, 'utf8')));
    expect(csv.body).toContain('RAPPROCHEMENT_J1');
    // Formule neutralisée (injection CSV) : aucune cellule ne commence par « = ».
    expect(csv.body.split(/\r\n/).every((l) => l.split(';').every((c) => !c.startsWith('=')))).toBe(true);
    expect((await env.req('GET', '/v1/pilotage/exports/drill?dimension=commune', 'u-dg-dgipk')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/pilotage/exports/echelle', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/pilotage/exports/inconnu', 'u-gouverneur')).statusCode).toBe(404);
    expect((await env.req('GET', `/v1/pilotage/exports/piste-audit?ref=${ob.id}`, 'u-gouverneur')).statusCode).toBe(403);
    const trail = (await env.req('GET', `/v1/pilotage/exports/piste-audit?ref=${ob.id}`, 'u-auditeur')).json();
    expect(trail.csv.content).toContain('horodatage;source;type');
  });

  it('paiements individuels (sans nom) pour Trésor et audit, jamais pour le Gouverneur', async () => {
    const env = await setupPilotage();
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const o = await pay(env, ob.id);
    expect((await env.req('GET', '/v1/pilotage/drill/paiements', 'u-gouverneur')).statusCode).toBe(403);
    const r = (await env.req('GET', '/v1/pilotage/drill/paiements', 'u-auditeur')).json();
    expect(r.items[0]).toMatchObject({ paymentReference: o.paymentReference, status: 'CONFIRME', commune: 'Limete' });
    expect(r.items[0].ledgerEntryIds.length).toBe(1);
    expect(JSON.stringify(r)).not.toContain('Mbuyi');
    expect(JSON.stringify(r)).not.toContain(DEMO.taxpayerId);
  });
});

describe('Pilotage — doctrine', () => {
  it('lecture seule : aucun effet sur obligations, paiements, grand livre ; l’IA ne peut rien publier', async () => {
    const env = await setupPilotage();
    const before = { o: env.ctx.assessment.obligations.count(), p: env.ctx.payments.orders.count(), l: env.ctx.ledger.list().length };
    for (const url of ['/v1/pilotage/echelle', '/v1/pilotage/indicateurs', '/v1/pilotage/tableaux/gouverneur', '/v1/pilotage/drill/commune', '/v1/pilotage/exports/echelle']) {
      expect((await env.req('GET', url, 'u-gouverneur')).statusCode).toBe(200);
    }
    expect({ o: env.ctx.assessment.obligations.count(), p: env.ctx.payments.orders.count(), l: env.ctx.ledger.list().length }).toEqual(before);
    expect(() => env.svc.publishTransparency({ kind: 'ai', id: 'agent', agent: 'pilotage' } as never, '2026-T3', 'Publication par un agent IA')).toThrow();
    expect(env.ctx.audit.verify().ok).toBe(true);
  });

  it('flux de démonstration par le circuit réel : tableaux alimentés, publication conforme', async () => {
    const env = await setupPilotage();
    const res = runDemoFlow(env.ctx);
    expect(res.obligations).toBe(28);
    expect(res.reconciled).toBeGreaterThan(10);
    const gov = (await env.req('GET', '/v1/pilotage/tableaux/gouverneur', 'u-gouverneur')).json();
    expect(gov.byCommune.rows.length).toBeGreaterThanOrEqual(6);
    const kpi = gov.kpis.find((k: { code: string }) => k.code === 'COMMUNES_RECETTE');
    expect(Number(kpi.value)).toBe(6);
    const pub = await env.req('POST', '/v1/pilotage/transparence/2026-T3/publier', 'u-gouverneur', { motif: 'Publication de démonstration (test)' });
    expect(pub.statusCode).toBe(201);
    expect(pub.json().check.passed).toBe(true);
  });
});
