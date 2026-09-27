import { randomUUID } from 'node:crypto';
import { isRuleExecutable, Money, SAMPLE_RULES } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { allocate, DEFAULT_SLICES, flowsOf, pctSumIs100, tutelleOf } from '../src/plugins/pilotage/repartition/model.js';
import { repartitionPlugin } from '../src/plugins/pilotage/repartition/plugin.js';
import { KEY_ID, type RepartitionService } from '../src/plugins/pilotage/repartition/service.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, publishCertifiedRule, signedCallback, type TestEnv } from './helpers.js';

async function setupRep() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [tresorPlugin, repartitionPlugin],
  });
  await app.ready();
  const env: TestEnv & { svc: RepartitionService } = {
    app, clock, svc: app.ctx.ext.repartition as RepartitionService,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}
type Env = Awaited<ReturnType<typeof setupRep>>;

/** Paiement de l'obligation de démonstration (150,00 USD) puis rapprochement au relevé du compte public. */
async function payAndReconcile(env: Env) {
  const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
  const order = (await env.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  await signedCallback(env, callbackBody(env, order.paymentReference));
  const st = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: order.paymentReference }],
  });
  expect(st.statusCode).toBeLessThan(300);
  expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('RAPPROCHE');
  return order.paymentReference as string;
}

const act = (over: Record<string, unknown> = {}) => ({
  instrumentId: 'demo-instrument-001', reference: 'ARR-2026-037A (fictif)', title: 'Arrêté provincial FICTIF instituant la clé de répartition', nature: 'ARRETE',
  signedOn: '2026-09-20', documentSha256: sha256Hex('acte-fictif'),
  conditions: { contratPpp: 'Contrat PPP n° 1 (fictif)', conformiteLofip: 'Avis LOFIP (fictif)', conventionTripartite: 'Convention tripartite (fictive)', traitementFiscal: 'Note fiscale (fictive)' },
  ...over,
});

const keyRule = {
  code: 'CLE-REPARTITION-37A', revenueCategory: 'ACTE_REQUIS', label: 'Clé de répartition — version certifiée (test)', legalInstrumentIds: ['demo-instrument-001'],
  formula: 'recettes_rapprochees * (part_groupe_nseya + part_tutelle + part_agents + part_gouvernement) / 100',
  rateTable: { part_groupe_nseya: '10', part_tutelle: '10', part_agents: '10', part_gouvernement: '70' }, rounding: 'DOWN', periodicity: 'MENSUELLE', effectiveFrom: '2026-09-26',
};

describe('Clé de répartition § 37A : calcul exact (unités mineures, arrondis au Gouvernement provincial)', () => {
  it('les parts somment à 100 % et à l’assiette exacte, quel que soit le montant', () => {
    expect(pctSumIs100(DEFAULT_SLICES)).toBe(true);
    expect(DEFAULT_SLICES.map((s) => [s.code, s.pct, s.flow])).toEqual([
      ['GROUPE_NSEYA', '10', 'FLUX_1'], ['TUTELLE', '10', 'FLUX_2'], ['AGENTS_SOUS_TRAITANTS', '10', 'FLUX_2'], ['GOUVERNEMENT_PROVINCIAL', '70', 'FLUX_2'],
    ]);
    for (const [amount, currency] of [['150.00', 'USD'], ['1234.57', 'USD'], ['0.07', 'USD'], ['0.01', 'CDF'], ['2850000.03', 'CDF'], ['999999999999.99', 'CDF'], ['0.00', 'USD']] as const) {
      const base = Money.of(amount, currency);
      const parts = allocate(base);
      expect(parts.reduce((a, p) => a.add(p.amount), Money.zero(currency)).equals(base)).toBe(true);
      expect(parts.every((p) => !p.amount.isNegative())).toBe(true);
      const flows = flowsOf(parts, DEFAULT_SLICES, currency);
      expect(flows.FLUX_1.add(flows.FLUX_2).equals(base)).toBe(true);
    }
    // Déterministe : les parts non-solde sont tronquées, le reste va au Gouvernement provincial.
    expect(allocate(Money.of('1234.57', 'USD')).map((p) => p.amount.toDecimalString())).toEqual(['123.45', '123.45', '123.45', '864.22']);
    expect(allocate(Money.of('0.07', 'USD')).map((p) => p.amount.toDecimalString())).toEqual(['0.00', '0.00', '0.00', '0.07']);
    expect(() => allocate(Money.of('-1.00', 'USD'))).toThrow();
    expect(pctSumIs100([{ pct: '10' }, { pct: '10' }, { pct: '10' }, { pct: '69.99' }])).toBe(false);
    expect(tutelleOf('IRL-KIN-R1')).toBe('Finances');
    expect(tutelleOf('DEMO-IF-BATI')).toBe('Finances');
    expect(tutelleOf('STAT-GOMBE-DEMO')).toBe('Transports et mobilité');
    expect(tutelleOf('XYZ')).toMatch(/À rattacher/);
  });
});

describe('Clé de répartition § 37A : ACTE_REQUIS, simulation seulement', () => {
  it('simulation sur recettes RAPPROCHÉES, par part, période et devise ; jamais de décaissement', async () => {
    const env = await setupRep();
    // Recette seulement confirmée (non rapprochée) : hors assiette.
    const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const o1 = (await env.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    await signedCallback(env, callbackBody(env, o1.paymentReference));
    expect((await env.req('GET', '/v1/pilotage/repartition', 'u-ministre-finances')).json().totals).toEqual([]);
    await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-TEST-1', lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: o1.paymentReference }],
    });
    const res = await env.req('GET', '/v1/pilotage/repartition', 'u-ministre-finances');
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ mode: 'SIMULATION', disbursement: 'AUCUN', key: { id: KEY_ID, status: 'ACTE_REQUIS' } });
    expect(r.notice).toMatch(/Simulation — aucun décaissement/);
    expect(r.totals).toHaveLength(1);
    expect(r.totals[0]).toMatchObject({ currency: 'USD', base: { amount: '150.00', currency: 'USD' }, payments: 1, check: { equalsBase: true, flowsEqualBase: true } });
    expect(r.totals[0].slices.map((s: { amount: { amount: string } }) => s.amount.amount)).toEqual(['15.00', '15.00', '15.00', '105.00']);
    expect(r.totals[0].flows.map((f: { flow: string; amount: { amount: string } }) => [f.flow, f.amount.amount])).toEqual([['FLUX_1', '15.00'], ['FLUX_2', '135.00']]);
    expect(r.byPeriod.map((p: { period: string }) => p.period)).toEqual(['2026-09']);
    expect(r.byTutelle[0]).toMatchObject({ tutelle: 'Finances' });
    expect((await env.req('GET', '/v1/pilotage/repartition?period=2026-08', 'u-auditeur')).json().totals).toEqual([]);
    expect((await env.req('GET', '/v1/pilotage/repartition?period=2026', 'u-auditeur')).json().totals).toHaveLength(1);
    // Contribuable, agent : refusés.
    expect((await env.req('GET', '/v1/pilotage/repartition', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/pilotage/repartition', 'u-agent-terrain')).statusCode).toBe(403);
    // Aucun décaissement tant que la clé est ACTE_REQUIS : ni par la répartition, ni directement au Trésor.
    const prop = await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-analyste-rappro', { period: '2026-08', currency: 'USD', reason: 'Proposition de décaissement (test)' });
    expect(prop.statusCode).toBe(422);
    expect(prop.json().code).toBe('ACTE_REQUIS');
    const direct = await env.req('POST', '/v1/tresor/operations', 'u-analyste-rappro', { kind: 'DECAISSEMENT_REPARTITION', reason: 'Décaissement direct (test)', repartition: { distributionId: 'REP-000001', flow: 'FLUX_1' } });
    expect(direct.statusCode).toBe(422);
    expect(direct.json().code).toBe('ACTE_REQUIS');
    expect(env.app.ctx.ext.tresor && (env.app.ctx.ext.tresor as { operations: { all(): unknown[] } }).operations.all()).toHaveLength(0);
  });

  it('la clé est portée au registre juridique (A_VERIFIER) et ses paramètres au registre des seuils (par défaut)', async () => {
    const env = await setupRep();
    const view = (await env.req('GET', '/v1/pilotage/repartition/cle', 'u-auditeur')).json();
    expect(view.key.status).toBe('ACTE_REQUIS');
    expect(view.registry).toEqual([expect.objectContaining({ id: 'rule-cle-repartition-37a-v1', status: 'A_VERIFIER', executable: false })]);
    const ids = ALL_PARAMETERS.filter((p) => p.category === 'Répartition des recettes (§ 37A)').map((p) => [p.id, p.value]);
    expect(ids).toEqual([
      ['repartition.part_groupe_nseya_pct', 10], ['repartition.part_tutelle_pct', 10], ['repartition.part_agents_pct', 10], ['repartition.part_gouvernement_pct', 70],
      ['repartition.duree_ans', 30], ['repartition.nombre_flux', 2],
    ]);
    for (const p of ALL_PARAMETERS.filter((x) => x.id.startsWith('repartition.'))) {
      expect(p).toMatchObject({ owner: 'CODE', source: { file: 'backend/src/plugins/pilotage/repartition/model.ts' } });
    }
  });
});

describe('Clé de répartition § 37A : activation (acte + deux personnes) et décaissements proposés au Trésor', () => {
  it('activation : acte enregistré, conditions du § 37A.8, règle certifiée du registre, décideur distinct', async () => {
    const env = await setupRep();
    const base = `/v1/pilotage/repartition/cles/${KEY_ID}`;
    const motif = { motif: 'Acte provincial publié, conditions réunies (test).' };
    // Sans acte : refus.
    let r = await env.req('POST', `${base}/activation`, 'u-ministre-finances', motif);
    expect(r.json().code).toBe('ACTE_REQUIS');
    // L'acte doit être un instrument du registre ; le contribuable ne l'enregistre pas.
    expect((await env.req('POST', `${base}/acte`, 'u-contribuable', act())).statusCode).toBe(403);
    expect((await env.req('POST', `${base}/acte`, 'u-autorite-publication', act({ instrumentId: 'inconnu-001' }))).json().code).toBe('UNKNOWN_LEGAL_INSTRUMENT');
    expect((await env.req('POST', `${base}/acte`, 'u-autorite-publication', act({ instrumentId: 'ol-13-001' }))).json().code).toBe('INSTRUMENT_NOT_IN_FORCE');
    // Conditions préalables incomplètes : activation refusée.
    expect((await env.req('POST', `${base}/acte`, 'u-autorite-publication', act({ conditions: { contratPpp: 'Contrat PPP (fictif)' } }))).statusCode).toBe(200);
    r = await env.req('POST', `${base}/activation`, 'u-ministre-finances', motif);
    expect(r.json().code).toBe('CONDITIONS_PREALABLES');
    expect((await env.req('POST', `${base}/acte`, 'u-autorite-publication', act())).json().legalAct.recordedBy).toBe('u-autorite-publication');
    // Sans version exécutable de la règle au registre (quatre visas) : refus.
    r = await env.req('POST', `${base}/activation`, 'u-ministre-finances', motif);
    expect(r.json().code).toBe('ACTE_REQUIS');
    const pub = await publishCertifiedRule(env, keyRule);
    expect(pub.create.statusCode, JSON.stringify(pub.create.json())).toBe(201);
    expect(pub.responses.map((x) => x.statusCode), JSON.stringify(pub.responses.map((x) => x.json()))).toEqual([200, 200, 200, 200]);
    r = await env.req('POST', `${base}/activation`, 'u-ministre-finances', motif);
    expect(r.statusCode, JSON.stringify(r.json())).toBe(202);
    expect(r.json().status).toBe('ACTIVATION_PROPOSEE');
    // Le proposant ne décide pas ; celui qui a enregistré l'acte non plus ; un rôle non habilité non plus.
    const decide = (u: string, approve = true) => env.req('POST', `${base}/activation/decision`, u, { approve, motif: 'Décision motivée de seconde lecture (test).' });
    expect((await decide('u-ministre-finances')).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await decide('u-autorite-publication')).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await decide('u-tresor')).statusCode).toBe(403);
    // Refus : retour à ACTE_REQUIS ; nouvelle proposition puis approbation par le Gouverneur.
    expect((await decide('u-gouverneur', false)).json().status).toBe('ACTE_REQUIS');
    expect((await env.req('POST', `${base}/activation`, 'u-ministre-finances', motif)).statusCode).toBe(202);
    const ok = await decide('u-gouverneur');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ACTIVE', ruleId: pub.id, decision: { by: 'u-gouverneur', proposedBy: 'u-ministre-finances', approve: true } });
    // Circuit à deux personnes reconstitué depuis le journal (collusion).
    expect(CIRCUITS.find((c) => c.code === 'REPARTITION_ACTIVATION')?.guard?.url).toBe('/v1/pilotage/repartition/cles/:id/activation/decision');
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.filter((d) => d.circuit === 'REPARTITION_ACTIVATION').map((d) => [d.proposerId, d.approverId, d.outcome])).toEqual([
      ['u-ministre-finances', 'u-gouverneur', 'REFUSE'], ['u-ministre-finances', 'u-gouverneur', 'APPROUVE'],
    ]);
  });

  it('clé active : deux flux PROPOSÉS au Trésor, validés par une autre personne ; troisième flux rejeté', async () => {
    const env = await setupRep();
    await payAndReconcile(env);
    const base = `/v1/pilotage/repartition/cles/${KEY_ID}`;
    await env.req('POST', `${base}/acte`, 'u-autorite-publication', act());
    await publishCertifiedRule(env, keyRule);
    await env.req('POST', `${base}/activation`, 'u-ministre-finances', { motif: 'Acte provincial publié, conditions réunies (test).' });
    expect((await env.req('POST', `${base}/activation/decision`, 'u-gouverneur', { approve: true, motif: 'Activation décidée en seconde lecture (test).' })).json().status).toBe('ACTIVE');
    const body = { period: '2026-09', currency: 'USD', reason: 'Répartition mensuelle de septembre (test)' };
    // Mois non clos : refus.
    expect((await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-analyste-rappro', body)).json().code).toBe('PERIODE_NON_CLOSE');
    env.clock.set('2026-10-02T09:00:00.000Z');
    expect((await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-contribuable', body)).statusCode).toBe(403);
    const p = await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-analyste-rappro', body);
    expect(p.statusCode).toBe(201);
    const { distribution, operations } = p.json();
    expect(distribution).toMatchObject({ period: '2026-09', currency: 'USD', base: { amount: '150.00', currency: 'USD' } });
    expect(operations.map((o: { kind: string; status: string; target: { amount: { amount: string } } }) => [o.kind, o.status, o.target.amount.amount])).toEqual([
      ['DECAISSEMENT_REPARTITION', 'PROPOSEE', '15.00'], ['DECAISSEMENT_REPARTITION', 'PROPOSEE', '135.00'],
    ]);
    // Rien n'est instruit sans seconde validation.
    let list = (await env.req('GET', '/v1/pilotage/repartition/distributions', 'u-auditeur')).json().items;
    expect(list[0].flows.map((f: { status: string }) => f.status)).toEqual(['PROPOSEE', 'PROPOSEE']);
    // Arrêté une seule fois par mois et devise.
    expect((await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-analyste-rappro', body)).json().code).toBe('REPARTITION_DEJA_ARRETEE');
    // L'auteur ne valide pas ; une autre personne du Trésor valide : instruction de virement émise (aucun fonds dans MOSOLO).
    expect((await env.req('POST', `/v1/tresor/operations/${operations[0].id}/approve`, 'u-analyste-rappro', {})).statusCode).toBe(403);
    const ok = await env.req('POST', `/v1/tresor/operations/${operations[0].id}/approve`, 'u-tresor', {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'EXECUTEE', result: { flow: 'FLUX_1', beneficiary: 'Groupe Nseya', instruction: 'EMISE', amount: { amount: '15.00' } } });
    list = (await env.req('GET', '/v1/pilotage/repartition/distributions', 'u-auditeur')).json().items;
    expect(list[0].flows.map((f: { status: string }) => f.status)).toEqual(['INSTRUCTION_EMISE', 'PROPOSEE']);
    // Un flux instruit ne se propose pas deux fois ; un troisième flux est rejeté.
    const again = await env.req('POST', '/v1/tresor/operations', 'u-analyste-rappro', { kind: 'DECAISSEMENT_REPARTITION', reason: 'Nouvelle proposition du flux 1 (test)', repartition: { distributionId: distribution.id, flow: 'FLUX_1' } });
    expect(again.json().code).toBe('FLUX_DEJA_INSTRUIT');
    const third = await env.req('POST', '/v1/tresor/operations', 'u-analyste-rappro', { kind: 'DECAISSEMENT_REPARTITION', reason: 'Troisième flux vers un tiers (test)', repartition: { distributionId: distribution.id, flow: 'FLUX_3' } });
    expect(third.statusCode).toBe(422);
    expect(third.json().code).toBe('FLUX_NON_AUTORISE');
    // Le rapport passe en mode calcul, toujours sans décaissement automatique.
    const rep = (await env.req('GET', '/v1/pilotage/repartition?period=2026-09', 'u-ministre-finances')).json();
    expect(rep).toMatchObject({ mode: 'CALCUL', disbursement: 'AUCUN', key: { status: 'ACTIVE' } });
  });
});

describe('Réserve « agents et sous-traitants » et commissions validées des agents', () => {
  it('les commissions validées consomment la tranche des 10 % ; dépassement signalé', async () => {
    const env = await setupRep();
    await payAndReconcile(env);
    const line = (amount: string, orderId: string) => ({ state: 'ACQUISE', paidAt: '2026-09-26T10:00:00.000Z', orderId, source: 'PENALITE', commission: { amount, currency: 'USD' } });
    const lines = [line('10.00', 'O-1'), line('3.00', 'O-2')];
    const states: Record<string, string> = { 'PENALITE:O-1': 'VALIDEE', 'PENALITE:O-2': 'DEMANDEE' };
    env.app.ctx.ext.sanctions = { commissions: { lines: () => lines }, validations: { stateOf: (k: string) => states[k] ?? 'A_DEMANDER' } };
    let a = (await env.req('GET', '/v1/pilotage/repartition', 'u-auditeur')).json().agents;
    expect(a.commissionModuleLoaded).toBe(true);
    expect(a.totals).toEqual([expect.objectContaining({
      currency: 'USD', reserve: { amount: '15.00', currency: 'USD' }, commissionsValidated: { amount: '10.00', currency: 'USD' },
      commissionsRequested: { amount: '3.00', currency: 'USD' }, commissionsAcquired: { amount: '13.00', currency: 'USD' },
      remaining: { amount: '5.00', currency: 'USD' }, consumptionPct: '66.7', status: 'DANS_LA_RESERVE',
    })]);
    expect(a.rules.join(' ')).toMatch(/prélevées sur la réserve/);
    states['PENALITE:O-2'] = 'VALIDEE';
    lines.push(line('4.00', 'O-3'));
    states['PENALITE:O-3'] = 'VALIDEE';
    a = (await env.req('GET', '/v1/pilotage/repartition', 'u-auditeur')).json().agents;
    expect(a.totals[0]).toMatchObject({ commissionsValidated: { amount: '17.00' }, remaining: { amount: '-2.00' }, status: 'DEPASSEMENT' });
    expect(a.rows[0]).toMatchObject({ period: '2026-09', status: 'DEPASSEMENT' });
  });
});

describe('IRL : position du Cahier v2.9 (22 % ; retenue de premier rang 20 %) — versions ajoutées, jamais actives', () => {
  it('versions 2 au statut A_VERIFIER, source « Cahier v2.9 », lecture certifiée de l’OL 18/004 prévalente ; versions 1 conservées', async () => {
    const v = (id: string) => SAMPLE_RULES.find((r) => r.id === id)!;
    expect(v('rule-irl-kin-r1-v1')).toBeDefined();
    expect(v('rule-irl-kin-r234-v1').rateTable).toEqual({ taux: '17', taux_retenue: '15' });
    for (const [id, retenue, prev] of [['rule-irl-kin-r1-v2', '20', 'rule-irl-kin-r1-v1'], ['rule-irl-kin-r234-v2', '15', 'rule-irl-kin-r234-v1']] as const) {
      const r = v(id);
      expect(r).toMatchObject({ version: 2, status: 'A_VERIFIER', rateTable: { taux: '22', taux_retenue: retenue }, supersedesVersionId: prev, promoterPosition: true });
      expect(r.sourceReference).toMatch(/Cahier des exigences v2\.9/);
      expect(r.readingNote).toMatch(/OL 18\/004 .* prévaut/);
      expect(isRuleExecutable(r, new Date('2027-02-01')).ok).toBe(false);
    }
    const env = await setupRep();
    // Aucune version IRL n'est ACTIVE ; la version 2 ne peut pas recevoir de visa (fiche modèle hors circuit).
    const irl = env.app.ctx.rules.list().filter((r) => r.code.startsWith('IRL-KIN-'));
    expect(irl.map((r) => r.id).sort()).toEqual(['rule-irl-kin-r1-v1', 'rule-irl-kin-r1-v2', 'rule-irl-kin-r234-v1', 'rule-irl-kin-r234-v2']);
    expect(irl.every((r) => r.status === 'A_VERIFIER')).toBe(true);
    expect((await env.req('POST', '/v1/legal-rules/rule-irl-kin-r1-v2/approve', 'u-juriste-redacteur', { role: 'REDACTEUR' })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
