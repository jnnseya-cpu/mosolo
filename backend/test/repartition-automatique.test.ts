/**
 * Répartition des recettes (module 73) et grand livre public (module 59) — décisions du maître d'ouvrage du 27/09/2026 :
 *  - chaque répartition du § 37A est inscrite au grand livre : comptes d'ordre SIMULÉS tant que la clé est ACTE_REQUIS,
 *    écritures réelles (flux) et comptes d'ordre de la répartition arrêtée une fois la clé active, sans rompre
 *    l'équilibre du grand livre ni les clôtures ;
 *  - régularisation automatique des remboursements et contrepassations sur la répartition suivante ;
 *  - alerte sur tout écart à 100 % ;
 *  - acte + convention tripartite enregistrés et clé active : les deux flux sont EXÉCUTÉS AUTOMATIQUEMENT (quotidien après
 *    rapprochement ou périodicité de la convention), audités, vers les comptes verrouillés du coffre ; jamais un troisième.
 */
import { randomUUID } from 'node:crypto';
import { Money } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { repartitionPlugin } from '../src/plugins/pilotage/repartition/plugin.js';
import { AUTO_EXECUTOR_ID, KEY_ID, type RepartitionService } from '../src/plugins/pilotage/repartition/service.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import type { TresorService } from '../src/plugins/tresor/service.js';
import { DEMO } from '../src/seed.js';
import { postStatement, callbackBody, PROVIDER_SECRET, publishCertifiedRule, signedCallback, type TestEnv } from './helpers.js';

async function setupRep() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [tresorPlugin, repartitionPlugin],
  });
  await app.ready();
  const env: TestEnv & { svc: RepartitionService; tresor: TresorService } = {
    app, clock, svc: app.ctx.ext.repartition as RepartitionService, tresor: app.ctx.ext.tresor as TresorService,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}
type Env = Awaited<ReturnType<typeof setupRep>>;

async function payAndReconcile(env: Env, valueDate = '2026-09-26') {
  const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
  const order = (await env.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  await signedCallback(env, callbackBody(env, order.paymentReference));
  const st = await postStatement(env, 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate, paymentReference: order.paymentReference }],
  });
  expect(st.statusCode).toBeLessThan(300);
  return env.app.ctx.payments.byReference(order.paymentReference)!;
}

/** Remboursement constaté (écriture de remboursement + transition de l'ordre), puis l'obligation redevient due. */
function refund(env: Env, orderId: string) {
  const o = env.app.ctx.payments.orders.get(orderId)!;
  const entry = env.app.ctx.ledger.postPair({ eventType: 'REFUND', description: `Remboursement ${o.paymentReference} (test)`, sourceType: 'payment_order', sourceId: o.id, debit: 'RECETTES_CONSTATEES', credit: 'COMPTE_PUBLIC_RECETTES', amount: o.amount });
  env.app.ctx.payments.markRefunded(o.id, entry.id);
  env.app.ctx.assessment.setStatus(o.obligationId, 'EXIGIBLE');
}

const accountBalance = (env: Env, account: string, currency = 'USD') => {
  const a = env.app.ctx.ledger.balance().accounts.find((x) => x.account === account && x.currency === currency);
  return a ? a.balance.amount : '0.00';
};

const act = {
  instrumentId: 'demo-instrument-001', reference: 'ARR-2026-037A (fictif)', title: 'Arrêté provincial FICTIF instituant la clé de répartition', nature: 'ARRETE',
  signedOn: '2026-09-20', documentSha256: sha256Hex('acte-fictif'),
  conditions: { contratPpp: 'Contrat PPP n° 1 (fictif)', conformiteLofip: 'Avis LOFIP (fictif)', conventionTripartite: 'Convention tripartite (fictive)', traitementFiscal: 'Note fiscale (fictive)' },
};
const keyRule = {
  code: 'CLE-REPARTITION-37A', revenueCategory: 'ACTE_REQUIS', label: 'Clé de répartition — version certifiée (test)', legalInstrumentIds: ['demo-instrument-001'],
  formula: 'recettes_rapprochees * (part_groupe_nseya + part_tutelle + part_agents + part_gouvernement) / 100',
  rateTable: { part_groupe_nseya: '10', part_tutelle: '10', part_agents: '10', part_gouvernement: '70' }, rounding: 'DOWN', periodicity: 'MENSUELLE', effectiveFrom: '2026-09-26',
};
const convention = (over: Record<string, unknown> = {}) => ({
  reference: 'CONV-TRIP-2026-01 (fictive)', bank: 'Banque de règlement (démo)', signedOn: '2026-09-21', documentSha256: sha256Hex('convention-fictive'), periodicite: 'QUOTIDIENNE',
  beneficiaries: [
    { flow: 'FLUX_1', currency: 'USD', alias: 'NSEYA-FLUX1-USD' }, { flow: 'FLUX_2', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' },
    { flow: 'FLUX_1', currency: 'CDF', alias: 'NSEYA-FLUX1-CDF' }, { flow: 'FLUX_2', currency: 'CDF', alias: 'GVT-PROV-FLUX2-CDF' },
  ],
  ...over,
});

async function activate(env: Env) {
  const base = `/v1/pilotage/repartition/cles/${KEY_ID}`;
  await env.req('POST', `${base}/acte`, 'u-autorite-publication', act);
  await publishCertifiedRule(env, keyRule);
  await env.req('POST', `${base}/activation`, 'u-ministre-finances', { motif: 'Acte provincial publié, conditions réunies (test).' });
  const r = await env.req('POST', `${base}/activation/decision`, 'u-gouverneur', { approve: true, motif: 'Activation décidée en seconde lecture (test).' });
  expect(r.json().status).toBe('ACTIVE');
}

describe('Module 59 / 73 : clé ACTE_REQUIS — simulation quotidienne inscrite en comptes d’ordre', () => {
  it('chaque répartition simulée est inscrite en partie double (comptes d’ordre), sans toucher aux fonds ni aux clôtures', async () => {
    const env = await setupRep();
    const o = await payAndReconcile(env);
    const publicBefore = accountBalance(env, 'COMPTE_PUBLIC_RECETTES');
    // Le jour même : le rapprochement de la journée n'est pas encore clos, rien n'est simulé.
    let run = (await env.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-tresor', {})).json();
    expect(run.run.mode).toBe('SIMULATION');
    expect(run.run.created).toEqual([]);
    // Le lendemain : simulation de la veille, inscrite au grand livre.
    env.clock.set('2026-09-27T08:00:00.000Z');
    run = (await env.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-tresor', {})).json();
    expect(run.run.created).toHaveLength(1);
    const sim = env.svc.simulations.get(run.run.created[0])!;
    expect(sim).toMatchObject({ period: '2026-09-27', currency: 'USD', base: { amount: '150.00' }, orderIds: [o.id] });
    expect(sim.slices.map((s) => s.amount.amount)).toEqual(['15.00', '15.00', '15.00', '105.00']);
    expect(sim.ledgerEntryIds).toHaveLength(1);
    const entry = env.app.ctx.ledger.get(sim.ledgerEntryIds[0]!)!;
    expect(entry.eventType).toBe('REPARTITION_SIMULEE');
    expect(entry.lines.map((l) => [l.account, l.side, l.amount.amount])).toEqual([
      ['ORDRE_SIMULATION_PART_NSEYA', 'DEBIT', '15.00'], ['ORDRE_SIMULATION_PART_TUTELLE', 'DEBIT', '15.00'], ['ORDRE_SIMULATION_PART_AGENTS', 'DEBIT', '15.00'],
      ['ORDRE_SIMULATION_PART_GOUVERNEMENT', 'DEBIT', '105.00'], ['ORDRE_SIMULATION_ASSIETTE', 'CREDIT', '150.00'],
    ]);
    // Équilibre, fonds et chaîne intacts ; aucune opération du Trésor.
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    expect(accountBalance(env, 'COMPTE_PUBLIC_RECETTES')).toBe(publicBefore);
    expect(env.app.ctx.ledger.verifyChain().valid).toBe(true);
    expect(env.tresor.operations.all()).toHaveLength(0);
    // Idempotent : une seconde exécution le même jour ne réinscrit rien.
    run = (await env.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-auditeur', {})).json();
    expect(run.run.created).toEqual([]);
    expect(env.svc.simulations.count()).toBe(1);
    // Les clôtures quotidiennes restent possibles et couvrent les écritures d'ordre.
    const c1 = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' });
    expect(c1.statusCode, JSON.stringify(c1.json())).toBe(201);
    const c2 = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-27' });
    expect(c2.statusCode, JSON.stringify(c2.json())).toBe(201);
    expect(c2.json()).toMatchObject({ balanced: true });
    // Le rapport montre la simulation, l'automatisation et l'indicateur grand livre / répartitions (écart nul).
    const rep = (await env.req('GET', '/v1/pilotage/repartition', 'u-ministre-finances')).json();
    expect(rep.automation).toMatchObject({ mode: 'SIMULATION_QUOTIDIENNE', periodicite: null });
    expect(rep.tableau.rows[0]).toMatchObject({ period: '2026-09', simule: { amount: '150.00' }, etat: 'SIMULATION' });
    expect(rep.indicateurs.grandLivre.simulees).toEqual([expect.objectContaining({ currency: 'USD', zero: true, grandLivre: { amount: '150.00', currency: 'USD' } })]);
    // Contribuable ou agent : pas de déclenchement.
    expect((await env.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-contribuable', {})).statusCode).toBe(403);
  });

  it('remboursement d’un paiement déjà simulé : régularisé automatiquement à la simulation suivante (écriture inverse liée)', async () => {
    const env = await setupRep();
    const o = await payAndReconcile(env);
    env.clock.set('2026-09-27T08:00:00.000Z');
    const first = env.svc.runAutomatic();
    const simId = first.run.created[0]!;
    refund(env, o.id);
    expect(env.svc.pendingSimRegularisations()).toEqual([expect.objectContaining({ orderId: o.id, distributionId: simId })]);
    env.clock.set('2026-09-28T08:00:00.000Z');
    const second = env.svc.runAutomatic();
    expect(second.run.created).toHaveLength(1);
    const sim = env.svc.simulations.get(second.run.created[0]!)!;
    expect(sim).toMatchObject({ grossBase: { amount: '0.00' }, base: { amount: '-150.00' }, regularisation: { orderIds: [o.id], fromDistributions: [simId], amount: { amount: '150.00' } } });
    const reg = env.app.ctx.ledger.get(sim.ledgerEntryIds.at(-1)!)!;
    expect(reg.eventType).toBe('REPARTITION_REGULARISATION');
    expect(reg.description).toContain(simId);
    // Les comptes d'ordre sont soldés : la recette remboursée ne compte plus.
    expect(accountBalance(env, 'ORDRE_SIMULATION_ASSIETTE')).toBe('0.00');
    expect(accountBalance(env, 'ORDRE_SIMULATION_PART_NSEYA')).toBe('0.00');
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    expect(env.svc.pendingSimRegularisations()).toEqual([]);
  });

  it('tout écart à 100 % est signalé (alerte critique) et bloque le traitement', async () => {
    const env = await setupRep();
    await payAndReconcile(env);
    const k = env.svc.key();
    env.svc.keys.update({ ...k, slices: k.slices.map((s) => (s.code === 'GOUVERNEMENT_PROVINCIAL' ? { ...s, pct: '69' } : s)) });
    const rep = (await env.req('GET', '/v1/pilotage/repartition', 'u-ministre-finances')).json();
    expect(rep.check100.keySlicesSumTo100).toBe(false);
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'REPARTITION_ECART_100' && a.severity === 'CRITICAL')).toBe(true);
    env.clock.set('2026-09-27T08:00:00.000Z');
    const run = env.svc.runAutomatic();
    expect(run.run).toMatchObject({ mode: 'AUCUN', skipped: [{ reason: 'REPARTITION_ECART_100' }] });
    expect(env.svc.simulations.count()).toBe(0);
  });
});

describe('Module 73 : acte + convention tripartite, clé active — exécution AUTOMATIQUE des deux flux', () => {
  it('convention : deux flux seulement, comptes verrouillés du coffre, un compte par flux et par devise', async () => {
    const env = await setupRep();
    const url = `/v1/pilotage/repartition/cles/${KEY_ID}/convention`;
    expect((await env.req('POST', url, 'u-contribuable', convention())).statusCode).toBe(403);
    const third = await env.req('POST', url, 'u-autorite-publication', convention({ beneficiaries: [{ flow: 'FLUX_1', currency: 'USD', alias: 'NSEYA-FLUX1-USD' }, { flow: 'FLUX_2', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' }, { flow: 'FLUX_3', currency: 'USD', alias: DEMO.dgipkAlias }] }));
    expect(third.json().code).toBe('FLUX_NON_AUTORISE');
    expect((await env.req('POST', url, 'u-autorite-publication', convention({ beneficiaries: [{ flow: 'FLUX_1', currency: 'USD', alias: 'INCONNU-01' }, { flow: 'FLUX_2', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' }] }))).json().code).toBe('UNKNOWN_BENEFICIARY_ALIAS');
    expect((await env.req('POST', url, 'u-autorite-publication', convention({ beneficiaries: [{ flow: 'FLUX_1', currency: 'CDF', alias: 'NSEYA-FLUX1-USD' }, { flow: 'FLUX_2', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' }] }))).json().code).toBe('DEVISE_COMPTE');
    expect((await env.req('POST', url, 'u-autorite-publication', convention({ beneficiaries: [{ flow: 'FLUX_1', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' }, { flow: 'FLUX_2', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' }] }))).json().code).toBe('COMPTE_COMMUN_AUX_FLUX');
    expect((await env.req('POST', url, 'u-autorite-publication', convention({ beneficiaries: [{ flow: 'FLUX_1', currency: 'USD', alias: 'NSEYA-FLUX1-USD' }, { flow: 'FLUX_1', currency: 'CDF', alias: 'NSEYA-FLUX1-CDF' }] }))).json().code).toBe('BENEFICIAIRES_INCOMPLETS');
    const ok = await env.req('POST', url, 'u-autorite-publication', convention());
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(ok.json().convention).toMatchObject({ periodicite: 'QUOTIDIENNE', recordedBy: 'u-autorite-publication' });
    // Enregistrée avant l'acte : aucune exécution automatique tant que la clé n'est pas active.
    const auto = (await env.req('GET', '/v1/pilotage/repartition/automatisation', 'u-auditeur')).json();
    expect(auto.mode).toBe('SIMULATION_QUOTIDIENNE');
    expect(auto.missing.join(' ')).toMatch(/Clé ACTIVE/);
  });

  it('exécution automatique quotidienne après rapprochement : deux flux instruits vers les comptes verrouillés, audités, inscrits', async () => {
    const env = await setupRep();
    const o = await payAndReconcile(env);
    await activate(env);
    // Clé active SANS convention : pas d'exécution automatique (propositions à quatre yeux seulement).
    env.clock.set('2026-09-27T08:00:00.000Z');
    let run = env.svc.runAutomatic();
    expect(run.run).toMatchObject({ mode: 'AUCUN', skipped: [{ reason: 'CONVENTION_REQUISE' }] });
    expect((await env.req('POST', `/v1/pilotage/repartition/cles/${KEY_ID}/convention`, 'u-autorite-publication', convention())).statusCode).toBe(200);
    run = (await env.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-tresor', {})).json();
    expect(run.run.mode).toBe('EXECUTION');
    expect(run.run.created).toHaveLength(1);
    const d = env.svc.distributions.get(run.run.created[0]!)!;
    expect(d).toMatchObject({ mode: 'AUTOMATIQUE', period: '2026-09-26', currency: 'USD', base: { amount: '150.00' }, orderIds: [o.id], createdBy: AUTO_EXECUTOR_ID });
    // Deux opérations EXÉCUTÉES automatiquement, fondées sur l'acte et la convention ; aucune troisième.
    const ops = env.tresor.operations.all();
    expect(ops.map((x) => [x.status, x.input.repartition?.flow, x.target.amount?.amount, x.proposedBy])).toEqual([
      ['EXECUTEE', 'FLUX_1', '15.00', AUTO_EXECUTOR_ID], ['EXECUTEE', 'FLUX_2', '135.00', AUTO_EXECUTOR_ID],
    ]);
    expect(ops[0]!.automatic).toEqual({ acte: act.reference, convention: 'CONV-TRIP-2026-01 (fictive)' });
    expect(ops[0]!.result).toMatchObject({ beneficiary: 'Groupe Nseya', beneficiaryAlias: 'NSEYA-FLUX1-USD', instruction: 'EMISE' });
    expect(ops[1]!.result).toMatchObject({ beneficiary: 'Gouvernement provincial', beneficiaryAlias: 'GVT-PROV-FLUX2-USD' });
    // Grand livre : flux réels + comptes d'ordre de la répartition arrêtée ; équilibre et chaîne intacts.
    expect(accountBalance(env, 'REPARTITION_FLUX_1')).toBe('15.00');
    expect(accountBalance(env, 'REPARTITION_FLUX_2')).toBe('135.00');
    expect(accountBalance(env, 'ORDRE_REPARTITION_ASSIETTE')).toBe('-150.00');
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    expect(env.app.ctx.ledger.verifyChain().valid).toBe(true);
    // Piste d'audit complète.
    const actions = env.app.ctx.audit.list({ limit: 1e6 }).items.map((e) => e.action);
    for (const a of ['repartition.convention.recorded', 'repartition.distribution.fixed', 'repartition.flow.instructed', 'treasury.operation.executed_automatically', 'repartition.automation.run']) expect(actions).toContain(a);
    // Idempotent ; la voie manuelle ne reprend pas les paiements déjà répartis.
    run = env.svc.runAutomatic();
    expect(run.run.created).toEqual([]);
    env.clock.set('2026-10-02T09:00:00.000Z');
    const manual = await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-analyste-rappro', { period: '2026-09', currency: 'USD', reason: 'Répartition mensuelle de septembre (test)' });
    expect(manual.json().code).toBe('ASSIETTE_NULLE');
    // Tableau : calculé = versé, reste à verser nul ; indicateurs mesurés.
    const rep = (await env.req('GET', '/v1/pilotage/repartition?period=2026-09', 'u-ministre-finances')).json();
    expect(rep.tableau.rows[0]).toMatchObject({ calcule: { amount: '150.00' }, verse: { amount: '150.00' }, resteAVerser: { amount: '0.00' }, etat: 'VERSE' });
    expect(rep.indicateurs.ecartRepartition.instructedVsLedger[0]).toMatchObject({ currency: 'USD', zero: true });
    expect(rep.indicateurs.grandLivre.arretees[0]).toMatchObject({ zero: true });
    expect(rep.indicateurs.delaiDepuisRapprochement.payments).toBe(1);
    expect(rep.automation.mode).toBe('EXECUTION_AUTOMATIQUE');
    // Aucun troisième flux, même par l'exécution automatique.
    expect(() => env.tresor.executeRepartitionAutomatically({ kind: 'DECAISSEMENT_REPARTITION', reason: 'Troisième flux (test)', repartition: { distributionId: d.id, flow: 'FLUX_3' } }, { kind: 'user', id: AUTO_EXECUTOR_ID, name: 'x', roles: [], entity: 'TRESOR' }, { kind: 'system', id: 'test' }, { acte: 'a', convention: 'c' })).toThrow(/Deux flux/);
  });

  it('remboursement après versement : régularisé automatiquement sur la répartition suivante ; au-delà des parts : reporté et signalé', async () => {
    const env = await setupRep();
    const o = await payAndReconcile(env);
    await activate(env);
    await env.req('POST', `/v1/pilotage/repartition/cles/${KEY_ID}/convention`, 'u-autorite-publication', convention());
    env.clock.set('2026-09-27T08:00:00.000Z');
    const first = env.svc.runAutomatic().run.created[0]!;
    refund(env, o.id);
    expect(env.svc.pendingRegularisations('USD')).toEqual([expect.objectContaining({ orderId: o.id, distributionId: first })]);
    // Aucune recette nouvelle : la régularisation dépasse les parts du jour → reportée, alerte au Trésor.
    env.clock.set('2026-09-28T08:00:00.000Z');
    let run = env.svc.runAutomatic();
    expect(run.run.skipped).toEqual([{ currency: 'USD', reason: 'REGULARISATION_SUPERIEURE' }]);
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'REPARTITION_REGULARISATION_REPORTEE')).toBe(true);
    // Nouveau paiement de 150,00 : la répartition suivante absorbe la régularisation (assiette nette nulle).
    const o2 = await payAndReconcile(env, '2026-09-28');
    env.clock.set('2026-09-29T08:00:00.000Z');
    run = env.svc.runAutomatic();
    expect(run.run.created).toHaveLength(1);
    const d2 = env.svc.distributions.get(run.run.created[0]!)!;
    expect(d2).toMatchObject({ grossBase: { amount: '150.00' }, base: { amount: '0.00' }, orderIds: [o2.id], regularisation: { orderIds: [o.id], fromDistributions: [first] } });
    expect(d2.flows.map((f) => f.amount.amount)).toEqual(['0.00', '0.00']);
    expect(env.svc.pendingRegularisations('USD')).toEqual([]);
    // Comptes d'ordre de la répartition arrêtée : 150 (1re) + 150 (2e) − 150 (régularisation).
    expect(accountBalance(env, 'ORDRE_REPARTITION_ASSIETTE')).toBe('-150.00');
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    expect(Money.fromJSON(d2.base).isZero()).toBe(true);
  });

  it('périodicité hebdomadaire ou mensuelle de la convention : exécution à l’échéance seulement', async () => {
    const env = await setupRep();
    await payAndReconcile(env);
    await activate(env);
    await env.req('POST', `/v1/pilotage/repartition/cles/${KEY_ID}/convention`, 'u-autorite-publication', convention({ periodicite: 'MENSUELLE' }));
    env.clock.set('2026-09-30T08:00:00.000Z');
    expect(env.svc.runAutomatic().run.created).toEqual([]);
    env.clock.set('2026-10-01T08:00:00.000Z');
    const run = env.svc.runAutomatic();
    expect(run.run.created).toHaveLength(1);
    expect(env.svc.distributions.get(run.run.created[0]!)!.period).toBe('2026-09');
    // Hebdomadaire : le lundi, la semaine précédente (paiement rapproché le jeudi 1er octobre).
    const env2 = await setupRep();
    await activate(env2);
    await env2.req('POST', `/v1/pilotage/repartition/cles/${KEY_ID}/convention`, 'u-autorite-publication', convention({ periodicite: 'HEBDOMADAIRE' }));
    env2.clock.set('2026-10-01T09:00:00.000Z');
    const o = await payAndReconcile(env2, '2026-10-01');
    env2.clock.set('2026-10-04T08:00:00.000Z'); // dimanche : semaine en cours
    expect(env2.svc.runAutomatic().run.created).toEqual([]);
    env2.clock.set('2026-10-05T08:00:00.000Z'); // lundi
    const w = env2.svc.runAutomatic();
    expect(w.run.created).toHaveLength(1);
    expect(env2.svc.distributions.get(w.run.created[0]!)!).toMatchObject({ period: '2026-09-28/2026-10-04', orderIds: [o.id] });
  });
});
