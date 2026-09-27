/**
 * Spécification fonctionnelle — fiches sectorielles 13 à 25 (fiches.ts, plastique.ts) : registres géoréférencés,
 * départs et manifestes, titres à usage unique consommés au scan (types de DÉMONSTRATION [EXEMPLE] sur règles fictives
 * ACTIVES), bons de sortie de carrière, péage, liquidations AUTOMATIQUES sur règle ACTIVE (16, 22, 23 — idempotentes,
 * auditées, avec avis et suivi du règlement), proposition sans règle, livraisons de boissons, assainissement, marchés,
 * événements, forêts, contribution plastique, indicateurs.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { User } from '../src/core/auth.js';
import { signedCallbackHeaders } from '../src/modules/payments/callback-signing.js';
import type { RuleInput } from '../src/modules/rules/service.js';
import { recouvrementPlugin } from '../src/plugins/recouvrement/plugin.js';
import { titresPlugin, type TitresService } from '../src/plugins/titres/plugin.js';
import { AUTO_RUN_DEFAULT_MS, type FichesService } from '../src/plugins/verticales/fiches.js';
import { verticalesPlugin, type VerticalesService } from '../src/plugins/verticales/plugin.js';
import { SINGLE_USE_DEMO, VX_DEMO } from '../src/plugins/verticales/seed.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { DEMO } from '../src/seed.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function setup(plugins: MosoloPlugin<unknown>[] = [titresPlugin, verticalesPlugin, recouvrementPlugin]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins });
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

const U = VX_DEMO.users;
const HASH = 'c'.repeat(64);
const vx = (env: TestEnv) => env.app.ctx.ext.verticales as VerticalesService;
const fiches = (env: TestEnv) => vx(env).fiches as FichesService;
const titres = (env: TestEnv) => env.app.ctx.ext.titres as TitresService;
const audits = (env: TestEnv, action: string) => env.app.ctx.audit.list({ limit: 1e6 }).items.filter((a) => a.action === action);

/** Règle ACTIVE [EXEMPLE] publiée par le circuit des quatre visas (instrument de démonstration, non opposable). */
function publishRule(env: TestEnv, input: Pick<RuleInput, 'code' | 'formula' | 'rateTable' | 'taxableEvent' | 'baseDefinition'> & Partial<RuleInput>) {
  const ctx = env.app.ctx;
  const u = (id: string) => ctx.users.get(id)!;
  const r = ctx.rules.create(u('u-juriste-redacteur'), {
    label: `TEST [EXEMPLE] ${input.code}`, revenueCategory: 'IMPOT_PROVINCIAL', legalInstrumentIds: ['demo-instrument-001'], articles: ['Article 1 (fictif)'],
    competentAuthority: 'Ministère provincial des Finances (démonstration)', administeringEntity: 'DGTK', liableParty: 'Redevable', currency: 'CDF', rounding: 'HALF_UP',
    periodicity: 'ANNUELLE', dueRule: '30 jours (démonstration)', exemptions: [], penalties: [], effectiveFrom: '2026-01-01', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01',
    appealPath: 'Réclamation via MOSOLO (démonstration)', sourceVerification: 'OFFICIEL_CERTIFIE', ...input,
  });
  ctx.rules.approve(u('u-juriste-redacteur'), r.id, 'REDACTEUR');
  ctx.rules.approve(u('u-juriste-verificateur'), r.id, 'VERIFICATEUR_JURIDIQUE');
  ctx.rules.approve(u('u-validateur-financier'), r.id, 'VALIDATEUR_FINANCIER');
  ctx.rules.approve(u('u-autorite-publication'), r.id, 'AUTORITE_PUBLICATION');
  ctx.rules.rules.update({ ...ctx.rules.rules.get(r.id)!, demo: true });
  ctx.rules.refresh();
  return ctx.rules.get(r.id);
}

/** Confirmation signée du prestataire (même circuit que la production). */
function confirm(env: TestEnv, paymentReference: string) {
  const order = env.app.ctx.payments.byReference(paymentReference)!;
  const raw = JSON.stringify({ providerTxnId: `T-${randomUUID()}`, paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() });
  return env.app.ctx.payments.handleCallback('mm-operator-a', signedCallbackHeaders(PROVIDER_SECRET, raw, env.clock.now()), raw);
}

const configure = (env: TestEnv, module: string, body: Record<string, unknown>) =>
  env.req('POST', `/v1/verticales/fiches/${module}/configuration`, U.director, { actReference: 'Acte FICTIF de démonstration [EXEMPLE]', motif: 'Configuration de démonstration', ...body });

describe('Fiche 16 — antennes : liquidation annuelle AUTOMATIQUE par site sur règle ACTIVE', () => {
  it('import des listes, site observé non déclaré, proposition sans règle, puis liquidation automatique idempotente avec avis et suivi du règlement', async () => {
    const env = await setup();
    const f = fiches(env);
    // Planificateur actif par défaut (paramètre technique à confirmer).
    expect(f.schedulerMs).toBe(AUTO_RUN_DEFAULT_MS);
    // Import de la liste de l'opérateur (compte propre) ; doublon reconnu.
    const imp = await env.req('POST', '/v1/verticales/fiches/antennes/imports', U.telecom, {
      source: 'OPERATEUR', operatorTaxpayerId: VX_DEMO.telecomTaxpayerId, fileSha256: HASH,
      sites: [{ reference: 'SITE-KAL-0007', commune: 'Kalamu', quartier: 'Matonge', lat: -4.33, lon: 15.31, type: 'PYLONE', emprise_m2: '64' }, { reference: 'SITE-NGL-0142', commune: 'Ngaliema', quartier: 'Mont-Fleury', lat: -4.3391, lon: 15.2502, type: 'PYLONE' }],
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json()).toMatchObject({ received: 2, created: 1, known: 1 });
    // Liste du régulateur : réservée au partenaire de données ou à la régie.
    expect((await env.req('POST', '/v1/verticales/fiches/antennes/imports', U.telecom, { source: 'REGULATEUR', operatorTaxpayerId: VX_DEMO.telecomTaxpayerId, sites: [{ reference: 'X-1', commune: 'Gombe', quartier: 'Golf', lat: -4.3, lon: 15.3, type: 'TOIT' }] })).statusCode).toBe(403);
    // Rapprochement déclarés ↔ observés : un site observé absent de la liste est détecté.
    const rec0 = (await env.req('GET', '/v1/verticales/fiches/antennes/recouvrement?exercice=2026', U.instructor)).json();
    expect(rec0.observedNotDeclared.length).toBeGreaterThanOrEqual(1);
    expect(rec0.rule.status).toBe('ACTE_REQUIS');
    // Sans règle ACTIVE : proposition seulement, sans montant.
    const site = f.objectsOf('16').find((o) => o.attributes.reference === 'SITE-KAL-0007')!;
    const prop = await env.req('POST', '/v1/verticales/fiches/liquidations', U.instructor, { module: '16', objectId: site.id, period: '2026' });
    expect(prop.statusCode).toBe(201);
    expect(prop.json()).toMatchObject({ status: 'ACTE_REQUIS', mode: 'PROPOSITION' });
    expect(prop.json().simulated).toBeUndefined();
    expect((await env.req('POST', '/v1/verticales/fiches/liquidations', U.instructor, { module: '16', objectId: site.id, period: '2026-09' })).json().code).toBe('ANNUAL_PERIOD');
    expect((await env.req('POST', '/v1/verticales/fiches/liquidations', U.instructor, { module: '16', objectId: site.id, period: '2027' })).json().code).toBe('FUTURE_PERIOD');
    const run0 = (await env.req('POST', '/v1/verticales/fiches/liquidations/automatique?exercice=2026', U.instructor)).json();
    expect(run0.modules.find((m: { module: string }) => m.module === '16')).toMatchObject({ status: 'ACTE_REQUIS', executed: 0 });
    // Configuration : directeur de la régie seulement (la cheffe de service décide, ne configure pas).
    publishRule(env, { code: 'TEST-ANTENNES', formula: 'sites * tarif_site', rateTable: { tarif_site: '250000' }, taxableEvent: 'Implantation d’un site télécom au 1er janvier (test)', baseDefinition: 'Nombre de sites' });
    expect((await configure(env, '16', { ruleCode: 'TEST-ANTENNES' }).then((r) => r)).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/verticales/fiches/16/configuration', U.chief, { ruleCode: 'TEST-ANTENNES', actReference: 'x'.repeat(5), motif: 'Tentative non habilitée' })).statusCode).toBe(403);
    // Passage automatique : chaque site déclaré (rattaché à un opérateur) est liquidé une fois ; site observé ignoré.
    const run1 = f.runAutomatic('2026', ['16']);
    const m16 = run1.modules[0]!;
    const declared = f.objectsOf('16').filter((o) => o.taxpayerId && o.probativeStatus !== 'OBSERVE').length;
    expect(m16).toMatchObject({ module: '16', status: 'ACTIVE', executed: declared });
    expect(m16.errors).toEqual([]);
    const liqs = f.liquidations.find((l) => l.module === '16' && l.status === 'EXECUTEE');
    expect(liqs).toHaveLength(declared);
    expect(liqs.every((l) => l.obligationId && l.ruleCode === 'TEST-ANTENNES' && l.ruleVersion === 1 && l.notice === 'AVIS_IMPOSITION' && l.noticeId)).toBe(true);
    expect(env.app.ctx.assessment.get(liqs[0]!.obligationId!).amount).toEqual({ amount: '250000.00', currency: 'CDF' });
    // La proposition antérieure (sans règle) est reprise, jamais doublée.
    expect(f.liquidations.find((l) => l.module === '16' && l.objectId === site.id && l.status !== 'REJETEE')).toHaveLength(1);
    const auto = audits(env, 'verticales.sector.liquidation.auto_executed');
    expect(auto.length).toBe(declared);
    expect(auto[0]!.actor).toMatchObject({ kind: 'system', id: 'fiches-liquidation-automatique' });
    // Idempotence par site et par exercice.
    expect(f.runAutomatic('2026', ['16']).modules[0]).toMatchObject({ executed: 0, skipped: f.objectsOf('16').length });
    // Suivi du règlement : paiement d'un avis, recouvrement par opérateur.
    const ob = env.app.ctx.assessment.get(liqs.find((l) => l.taxpayerId === VX_DEMO.telecomTaxpayerId)!.obligationId!);
    const order = env.app.ctx.payments.createOrder(env.app.ctx.users.get(U.telecom)!, ob.id, { channel: 'MOBILE_MONEY' });
    expect(confirm(env, order.paymentReference).status).toBe('CONFIRME');
    const list = (await env.req('GET', '/v1/verticales/fiches/liquidations?module=16', U.instructor)).json().items;
    expect(list.some((l: { payment: { state: string } | null }) => l.payment?.state === 'PAYE')).toBe(true);
    const rec = (await env.req('GET', '/v1/verticales/fiches/antennes/recouvrement?exercice=2026', U.chief)).json();
    const op = rec.operators.find((o: { taxpayerId: string }) => o.taxpayerId === VX_DEMO.telecomTaxpayerId);
    expect(op.liquidated).toBeGreaterThanOrEqual(1);
    expect(op.paid).toEqual([{ amount: '250000.00', currency: 'CDF' }]);
    expect(op.recoveryRate).not.toBeNull();
    // Cellule grands redevables (module 56) visible au suivi par opérateur.
    await env.req('POST', '/v1/verticales/secteurs/grands-redevables', U.chief, { taxpayerId: VX_DEMO.telecomTaxpayerId, sectors: ['16'], motif: 'Opérateur télécom suivi (démonstration)' });
    const rec2 = (await env.req('GET', '/v1/verticales/fiches/antennes/recouvrement?exercice=2026', U.chief)).json();
    expect(rec2.operators.find((o: { taxpayerId: string }) => o.taxpayerId === VX_DEMO.telecomTaxpayerId).largeTaxpayer).toMatchObject({ status: 'SUIVI' });
    // État de la liquidation automatique (écran de la régie).
    const st = (await env.req('GET', '/v1/verticales/fiches/liquidations/automatique', U.instructor)).json();
    expect(st.modules.find((m: { module: string }) => m.module === '16')).toMatchObject({ mode: 'AUTOMATIQUE' });
    expect(st.lastRun.exercice).toBe('2026');
  });

  it('mutation de site entre opérateurs : demande motivée, décision d’une autre personne, rattachement changé', async () => {
    const env = await setup();
    const f = fiches(env);
    const site = f.objectsOf('16').find((o) => o.taxpayerId === VX_DEMO.telecomTaxpayerId)!;
    const m = await env.req('POST', `/v1/verticales/fiches/antennes/sites/${site.id}/mutations`, U.telecom, { toTaxpayerId: DEMO.taxpayerId, dateEffet: '2026-09-01', documents: [HASH], motif: 'Cession du pylône (démonstration)' });
    expect(m.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/verticales/fiches/antennes/sites/${site.id}/mutations`, U.telecom, { toTaxpayerId: DEMO.taxpayerId, dateEffet: '2026-09-01', motif: 'Doublon de demande' })).json().code).toBe('MUTATION_PENDING');
    const d = await env.req('POST', `/v1/verticales/fiches/antennes/mutations/${m.json().id}/decision`, U.chief, { approve: true, motif: 'Acte de cession vérifié (démonstration)' });
    expect(d.statusCode).toBe(200);
    expect(env.app.ctx.objects.get(site.id).taxpayerId).toBe(DEMO.taxpayerId);
    expect(audits(env, 'verticales.telecom.mutation.accepted')).toHaveLength(1);
  });
});

describe('Fiche 22 — carrières : bons à usage unique, comptage des sorties, liquidation automatique superficie + volumes', () => {
  it('bon QR par camion consommé au premier passage, « DÉJÀ UTILISÉ » ensuite, bon d’un autre site refusé ; écart sorties / déclaration ; liquidation du mois validé', async () => {
    const env = await setup();
    const f = fiches(env);
    const reg = async (nom: string, lat: number) => (await env.req('POST', '/v1/verticales/fiches/22/objets', 'u-contribuable', { commune: 'Ngaliema', quartier: 'Binza', lat, lon: 15.24, attributes: { nom, superficie_ha: '12', titre: 'PE-0001 (fictif)' } })).json().object;
    const site = await reg('Carrière de test A', -4.35);
    const other = await reg('Carrière de test B', -4.36);
    expect((await env.req('POST', '/v1/verticales/fiches/22/objets', 'u-contribuable', { commune: 'Ngaliema', quartier: 'Binza', lat: -4.3, lon: 15.2, attributes: { nom: 'Sans superficie', titre: 'x' } })).json().code).toBe('FIELD_REQUIRED');
    // Bons : type réel « acte requis » refusé ; type [EXEMPLE] retenu par la régie.
    expect((await env.req('POST', `/v1/verticales/fiches/carrieres/${site.id}/bons`, 'u-contribuable', { plates: ['KN-1111-AA'], channel: 'MOBILE_MONEY' })).json().code).toBe('CREDENTIAL_TYPE_NOT_ACTIVABLE');
    expect((await configure(env, '22', { ruleCode: null, credentialTypeCode: SINGLE_USE_DEMO.types.bon })).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/verticales/fiches/carrieres/${site.id}/bons`, 'u-contribuable', { plates: ['KN-1111-AA'], channel: 'BANK' })).json().code).toBe('CHANNEL_NOT_ALLOWED');
    const order = await env.req('POST', `/v1/verticales/fiches/carrieres/${site.id}/bons`, 'u-contribuable', { plates: ['KN-1111-AA', 'KN-2222-BB'], channel: 'MOBILE_MONEY' });
    expect(order.statusCode).toBe(201);
    expect(order.json().issuance.payments[0].amount).toEqual({ amount: '10000.00', currency: 'CDF' });
    confirm(env, order.json().issuance.payments[0].paymentReference);
    const orderB = (await env.req('POST', `/v1/verticales/fiches/carrieres/${other.id}/bons`, 'u-contribuable', { plates: ['KN-5555-EE'], channel: 'MOBILE_MONEY' })).json();
    confirm(env, orderB.issuance.payments[0].paymentReference);
    titres(env).sync();
    const slip = titres(env).credentials.find((c) => c.subject.objectId === site.id && c.subject.plate === 'KN1111AA')[0]!;
    const slipB = titres(env).credentials.find((c) => c.subject.objectId === other.id)[0]!;
    expect(slip.model).toBe('USAGE_UNIQUE');
    const exit = (body: Record<string, unknown>) => env.req('POST', `/v1/verticales/fiches/carrieres/${site.id}/sorties`, U.fieldAgent, body);
    const e1 = await exit({ code: slip.shortCode, volume_m3: '20' });
    expect(e1.statusCode).toBe(201);
    expect(e1.json()).toMatchObject({ exit: { result: 'VALIDE' }, control: { result: 'VALIDE' } });
    const e2 = (await exit({ code: slip.shortCode })).json();
    expect(e2.exit).toMatchObject({ result: 'INVALIDE', alreadyUsed: true });
    expect(e2.control.text).toBe('DÉJÀ UTILISÉ');
    expect(e2.control.constat.id).toBeTruthy();
    const e3 = (await exit({ code: slipB.shortCode })).json();
    expect(e3.exit.result).toBe('AUTRE_SITE');
    expect(titres(env).credentials.get(slipB.id)!.state).toBe('EMIS');
    const e4 = (await exit({ plate: 'KN-9999-ZZ' })).json();
    expect(e4.exit.result).toBe('INVALIDE');
    expect((await env.req('POST', `/v1/verticales/fiches/carrieres/${site.id}/sorties`, 'u-agent-gombe', { plate: 'KN-1111-AA' })).statusCode).toBe(403);
    const exits = (await env.req('GET', `/v1/verticales/fiches/carrieres/${site.id}/sorties`, U.instructor)).json();
    expect(exits).toMatchObject({ total: 4, valid: 1 });
    // Déclaration mensuelle rapprochée des sorties comptées : 4 camions comptés, 2 déclarés.
    const decl = (await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'SORTIES_CARRIERE', objectId: site.id, period: '2026-09', lines: { camions: '2', volume_m3: '40' } })).json();
    const r = (await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.id}/rapprochement`, U.instructor)).json();
    expect(r.status).toBe('ECART_A_INSTRUIRE');
    expect(r.reconciliation.bySource[0].gaps.camions).toBe('2');
    // Règle ACTIVE : la liquidation automatique ne porte que sur un mois VALIDÉ (superficie et volumes validés).
    publishRule(env, { code: 'TEST-CARRIERES', formula: 'superficie_ha * tarif_ha + volume_m3 * tarif_m3', rateTable: { tarif_ha: '1000', tarif_m3: '50' }, taxableEvent: 'Extraction de matériaux de carrière (test)', baseDefinition: 'Superficie et volumes validés' });
    await configure(env, '22', { ruleCode: 'TEST-CARRIERES' });
    expect(f.runAutomatic('2026', ['22']).modules[0]).toMatchObject({ status: 'ACTIVE', executed: 0 });
    expect((await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.id}/decision`, U.chief, { decision: 'VALIDER', motif: 'Écart expliqué par des camions vides (démonstration)' })).statusCode).toBe(200);
    const run = f.runAutomatic('2026', ['22']).modules[0]!;
    expect(run).toMatchObject({ executed: 1 });
    const liq = f.liquidations.find((l) => l.module === '22' && l.objectId === site.id)[0]!;
    expect(liq).toMatchObject({ period: '2026-09', status: 'EXECUTEE', mode: 'AUTOMATIQUE', basis: { superficie_ha: '12', volume_m3: '40', camions: '2' } });
    expect(env.app.ctx.assessment.get(liq.obligationId!).amount).toEqual({ amount: '14000.00', currency: 'CDF' });
    expect(f.runAutomatic('2026', ['22']).modules[0]!.executed).toBe(0);
    // Double facturation refusée pour le même mois.
    expect((await env.req('POST', '/v1/verticales/fiches/liquidations', U.instructor, { module: '22', objectId: site.id, period: '2026-09' })).json().code).toBe('LIQUIDATION_EXISTS');
    const ind = (await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor)).json().modules.find((m: { module: string }) => m.module === '22');
    expect(ind.indicators.find((i: { key: string }) => i.key === 'ecartSortiesDeclarations')).toMatchObject({ measured: true, value: '2' });
    expect(ind.indicators.find((i: { key: string }) => i.key === 'sitesActifs').value).toBeGreaterThanOrEqual(1);
  });
});

describe('Fiches 13 et 24 — embarquement, manifestes, titres consommés au scan, mouvements, embarcations', () => {
  it('point rattaché à un opérateur, départ, manifeste, titres par passager payés au compte public, « DÉJÀ UTILISÉ », rapprochement, mouvements, contrôle de l’embarcation', async () => {
    const env = await setup();
    // Point d'embarquement géoréférencé rattaché à un opérateur ; quai privé.
    expect((await env.req('POST', '/v1/verticales/fiches/references', U.instructor, { module: '13', kind: 'POINT_EMBARQUEMENT', label: 'Beach test', commune: 'Nsele', lat: -4.34, lon: 15.49 })).json().code).toBe('OPERATOR_REQUIRED');
    const pt = (await env.req('POST', '/v1/verticales/fiches/references', U.instructor, { module: '13', kind: 'POINT_EMBARQUEMENT', label: 'Beach test', commune: 'Nsele', lat: -4.34, lon: 15.49, operatorTaxpayerId: DEMO.taxpayerId })).json();
    expect(pt).toMatchObject({ module: '13', operatorTaxpayerId: DEMO.taxpayerId, demo: false });
    const quai = await env.req('POST', '/v1/verticales/fiches/references', U.instructor, { module: '24', kind: 'QUAI', label: 'Port privé test', commune: 'Nsele', lat: -4.341, lon: 15.491, privateQuay: true });
    expect(quai.json()).toMatchObject({ kind: 'QUAI', privateQuay: true });
    // Embarcation (registre 24) : identifiant, capacité, propriétaire.
    const boat = (await env.req('POST', '/v1/verticales/fiches/24/objets', 'u-contribuable', { commune: 'Nsele', quartier: 'Kinkole', lat: -4.34, lon: 15.49, attributes: { identifiant: 'BAL-TEST-01', capacite_passagers: '3', nom: 'Baleinière test' } })).json().object;
    expect((await env.req('POST', '/v1/verticales/fiches/24/objets', 'u-contribuable', { commune: 'Nsele', quartier: 'Kinkole', lat: -4.34, lon: 15.49, attributes: { identifiant: 'bal-test-01', capacite_passagers: '3' } })).json().code).toBe('SECTOR_OBJECT_EXISTS');
    const dep = (await env.req('POST', '/v1/verticales/fiches/departs', 'u-contribuable', { pointId: pt.id, embarcationId: boat.id, destination: 'Maluku', scheduledAt: '2026-09-26T12:00:00.000Z', titleMode: 'PAR_PASSAGER' })).json();
    expect(dep.status).toBe('PREVU');
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/titres`, 'u-contribuable', { channel: 'MOBILE_MONEY' })).json().code).toBe('MANIFEST_REQUIRED');
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/manifeste`, 'u-contribuable', { passengers: 5 })).json().code).toBe('OVER_CAPACITY');
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/manifeste`, 'u-contribuable', { passengers: 3, volumeT: '1.5', documents: [HASH] })).statusCode).toBe(200);
    // Jamais à l'agent de quai : canal refusé et journalisé.
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/titres`, 'u-contribuable', { channel: 'BANK' })).json().code).toBe('CHANNEL_NOT_ALLOWED');
    expect(audits(env, 'verticales.port.titles.channel_refused')).toHaveLength(1);
    // Type réel « acte requis » : aucun titre ; type [EXEMPLE] retenu par la régie : un titre par passager.
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/titres`, 'u-contribuable', { channel: 'MOBILE_MONEY' })).json().code).toBe('CREDENTIAL_TYPE_NOT_ACTIVABLE');
    await configure(env, '13', { ruleCode: null, credentialTypeCode: SINGLE_USE_DEMO.types.embarquement });
    const ord = await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/titres`, 'u-contribuable', { channel: 'MOBILE_MONEY' });
    expect(ord.statusCode).toBe(201);
    expect(ord.json().issuance.payments[0].amount).toEqual({ amount: '3000.00', currency: 'CDF' });
    const before = (await env.req('GET', `/v1/verticales/fiches/departs/${dep.id}/rapprochement`, U.instructor)).json();
    expect(before).toMatchObject({ manifested: 3, issued: 3, paid: 0 });
    expect(before.anomalies.join(' ')).toMatch(/non payé/);
    confirm(env, ord.json().issuance.payments[0].paymentReference);
    titres(env).sync();
    const creds = titres(env).credentials.find((c) => c.typeCode === SINGLE_USE_DEMO.types.embarquement);
    expect(creds).toHaveLength(3);
    // Scan au quai : consommé au premier scan valide, « DÉJÀ UTILISÉ » ensuite.
    const scan = (code: string) => env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/embarquements`, U.fieldAgent, { code });
    const s1 = (await scan(creds[0]!.shortCode)).json();
    expect(s1.control).toMatchObject({ result: 'VALIDE' });
    const s2 = (await scan(creds[0]!.shortCode)).json();
    expect(s2.control.text).toBe('DÉJÀ UTILISÉ');
    expect(s2.boarding.alreadyUsed).toBe(true);
    expect((await scan(creds[1]!.shortCode)).json().control.result).toBe('VALIDE');
    // Titre d'un autre départ : refusé sans être consommé.
    const dep2 = (await env.req('POST', '/v1/verticales/fiches/departs', 'u-contribuable', { pointId: pt.id, destination: 'Mbandaka', scheduledAt: '2026-09-27T08:00:00.000Z', titleMode: 'PAR_DEPART' })).json();
    const cross = (await env.req('POST', `/v1/verticales/fiches/departs/${dep2.id}/embarquements`, U.fieldAgent, { code: creds[2]!.shortCode })).json();
    expect(cross.boarding.result).toBe('AUTRE_DEPART');
    expect(titres(env).credentials.get(creds[2]!.id)!.state).toBe('EMIS');
    const after = (await env.req('GET', `/v1/verticales/fiches/departs/${dep.id}/rapprochement`, U.instructor)).json();
    expect(after).toMatchObject({ manifested: 3, issued: 3, paid: 3, consumed: 2, gaps: { manifesteMoinsTitres: 0, titresNonPayes: 0 } });
    expect((await env.req('GET', `/v1/verticales/fiches/departs/${dep.id}/embarquements`, U.instructor)).json().items).toHaveLength(3);
    // Mouvements (heure du serveur) et historique de l'embarcation.
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/mouvements`, 'u-contribuable', { kind: 'ARRIVEE' })).json().code).toBe('INVALID_MOVEMENT');
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/mouvements`, 'u-contribuable', { kind: 'DEPART' })).json().status).toBe('PARTI');
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/embarquements`, U.fieldAgent, { code: creds[2]!.shortCode })).json().code).toBe('DEPARTURE_CLOSED');
    env.clock.advance(3 * 3_600_000);
    expect((await env.req('POST', `/v1/verticales/fiches/departs/${dep.id}/mouvements`, U.fieldAgent, { kind: 'ARRIVEE', arrivalPointId: quai.json().id })).json().status).toBe('ARRIVE');
    const ctl = (await env.req('GET', `/v1/verticales/fiches/embarcations/${encodeURIComponent('BAL-TEST-01')}/controle?commune=Nsele`, U.fieldAgent)).json();
    expect(ctl).toMatchObject({ registered: true, identifiant: 'BAL-TEST-01' });
    expect(ctl.movements[0].events.map((e: { kind: string }) => e.kind)).toEqual(['DEPART', 'ARRIVEE']);
    expect(JSON.stringify(ctl)).not.toMatch(/Mbuyi|TP-DEMO/);
    expect((await env.req('GET', '/v1/verticales/fiches/embarcations/INCONNUE-99/controle?commune=Nsele', U.fieldAgent)).json().registered).toBe(false);
    // Embarcation recensée par l'instructeur avec plaque QR : contrôle par le QR (code de la plaque).
    const withQr = (await env.req('POST', '/v1/verticales/fiches/24/objets', U.instructor, { taxpayerId: DEMO.taxpayerId, commune: 'Nsele', quartier: 'Kinkole', lat: -4.342, lon: 15.493, attributes: { identifiant: 'BAL-TEST-QR', capacite_passagers: '20' }, withPlate: true })).json();
    expect(withQr.plate.code).toBeTruthy();
    const byQr = (await env.req('GET', `/v1/verticales/fiches/embarcations/${encodeURIComponent(withQr.plate.code)}/controle?commune=Nsele`, U.fieldAgent)).json();
    expect(byQr).toMatchObject({ registered: true, identifiant: 'BAL-TEST-QR', plate: withQr.plate.code });
    // Redevances 24 : liquidation par mouvement ou par période, jamais les deux.
    const pm = await env.req('POST', '/v1/verticales/fiches/liquidations', U.instructor, { module: '24', objectId: boat.id, period: '2026-09', movementId: dep.id });
    expect(pm.statusCode).toBe(201);
    expect(pm.json()).toMatchObject({ movementId: dep.id, basis: { mouvements: '1', passagers: '3' }, status: 'ACTE_REQUIS' });
    expect((await env.req('POST', '/v1/verticales/fiches/liquidations', U.instructor, { module: '24', objectId: boat.id, period: '2026-09' })).json().code).toBe('LIQUIDATION_EXISTS');
    const port = (await env.req('GET', '/v1/verticales/fiches/ports/rapprochement?period=2026-09', U.instructor)).json().items.find((x: { objectId: string }) => x.objectId === boat.id);
    expect(port).toMatchObject({ movements: 1, accostageTitles: 0, gap: 1 });
    const ind = (await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor)).json().modules;
    const i13 = ind.find((m: { module: string }) => m.module === '13').indicators;
    expect(i13.find((i: { key: string }) => i.key === 'departsTraces').value).toBe(1);
    expect(i13.find((i: { key: string }) => i.key === 'titresConsommes').value).toBe(2);
    expect(ind.find((m: { module: string }) => m.module === '24').indicators.find((i: { key: string }) => i.key === 'mouvementsTraces').value).toBe(2);
  });
});

describe('Fiche 25 — péage : passage consommé à chaque franchissement, solde du carnet, fraude détectée', () => {
  it('passage unique et carnet [EXEMPLE] liés à la plaque ; second franchissement sans titre = fraude (constat sans montant)', async () => {
    const env = await setup();
    // Sans configuration : acte requis, passage enregistré sans constat.
    const p0 = (await env.req('POST', '/v1/verticales/fiches/peage/passages', U.fieldAgent, { pointId: 'AXE-EX-02', plate: 'KN-7777-GG' })).json();
    expect(p0.passage.result).toBe('ACTE_REQUIS');
    await configure(env, '25', { ruleCode: null, credentialTypeCode: SINGLE_USE_DEMO.types.passage, extraCredentialTypeCodes: [SINGLE_USE_DEMO.types.carnet] });
    const types = (await env.req('GET', '/v1/verticales/fiches/25/types-titres', U.instructor)).json();
    expect(types.items.filter((t: { activable: boolean }) => t.activable).map((t: { code: string }) => t.code)).toEqual([SINGLE_USE_DEMO.types.passage, SINGLE_USE_DEMO.types.carnet]);
    const buy = await env.req('POST', '/v1/verticales/fiches/peage/titres', 'u-contribuable', { typeCode: SINGLE_USE_DEMO.types.passage, plate: 'KN-7777-GG', pointId: 'AXE-EX-02', channel: 'MOBILE_MONEY' });
    expect(buy.statusCode).toBe(201);
    confirm(env, buy.json().issuance.payments[0].paymentReference);
    const pass = () => env.req('POST', '/v1/verticales/fiches/peage/passages', U.fieldAgent, { pointId: 'AXE-EX-02', plate: 'KN-7777-GG' });
    const p1 = (await pass()).json();
    expect(p1.passage).toMatchObject({ result: 'VALIDE', fraud: false });
    const p2 = (await pass()).json();
    expect(p2.passage).toMatchObject({ result: 'INVALIDE', fraud: true });
    expect(p2.passage.constatId).toBeTruthy();
    // Carnet : solde affiché, un passage consommé à chaque franchissement.
    const c = (await env.req('POST', '/v1/verticales/fiches/peage/titres', 'u-contribuable', { typeCode: SINGLE_USE_DEMO.types.carnet, plate: 'KN-8888-HH', pointId: 'AXE-EX-02', channel: 'MOBILE_MONEY' })).json();
    expect(c.issuance.payments[0].amount).toEqual({ amount: '20000.00', currency: 'CDF' });
    confirm(env, c.issuance.payments[0].paymentReference);
    titres(env).sync();
    expect((await env.req('POST', '/v1/verticales/fiches/peage/passages', U.fieldAgent, { pointId: 'AXE-EX-02', plate: 'KN-8888-HH' })).json().passage.result).toBe('VALIDE');
    const bal = (await env.req('GET', `/v1/verticales/fiches/peage/carnets/${encodeURIComponent('KN-8888-HH')}`, 'u-contribuable')).json();
    expect(bal.titles[0]).toMatchObject({ usesTotal: SINGLE_USE_DEMO.carnetUses, usesLeft: SINGLE_USE_DEMO.carnetUses - 1 });
    expect((await env.req('GET', `/v1/verticales/fiches/peage/carnets/${encodeURIComponent('KN-8888-HH')}`, 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/verticales/fiches/peage/titres', 'u-contribuable', { typeCode: SINGLE_USE_DEMO.types.passage, plate: 'KN-1', pointId: 'AXE-EX-02', channel: 'BANK' })).json().code).toBe('CHANNEL_NOT_ALLOWED');
    const ind = (await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor)).json().modules.find((m: { module: string }) => m.module === '25').indicators;
    expect(ind.find((i: { key: string }) => i.key === 'passages').value).toBe(4);
    expect(ind.find((i: { key: string }) => i.key === 'fraudeDetectee').value).toBe(1);
    expect(ind.find((i: { key: string }) => i.key === 'recettesParAxe')).toMatchObject({ measured: true });
  });
});

describe('Fiche 17 — boissons : livraisons, carte restreinte, points non autorisés transmis au module 10, cohérence, relances', () => {
  it('le partenaire verse les livraisons ; seuls la régie et le contrôle voient la carte ; un point non identifié devient un établissement observé', async () => {
    const env = await setup();
    const f = fiches(env);
    const r = await env.req('POST', '/v1/verticales/fiches/boissons/livraisons', U.airport, {
      taxpayerId: DEMO.taxpayerId, period: '2026-08', fileSha256: HASH,
      points: [{ label: 'Terrasse Victoire (test)', commune: 'Kalamu', quartier: 'Matonge', lat: -4.3301, lon: 15.3101, volumeLitres: '900' }, { label: 'Boutique d’électroménager', commune: 'Gombe', quartier: 'Commerce', lat: -4.3062, lon: 15.3021, volumeLitres: '100' }],
    });
    expect(r.statusCode).toBe(201);
    expect((await env.req('POST', '/v1/verticales/fiches/boissons/livraisons', 'u-contribuable', { taxpayerId: DEMO.taxpayerId, period: '2026-08', points: [{ label: 'Point X', commune: 'Gombe', lat: -4.3, lon: 15.3, volumeLitres: '1' }] })).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/verticales/fiches/boissons/points-livraison', U.fieldAgent)).statusCode).toBe(403);
    const map = (await env.req('GET', '/v1/verticales/fiches/boissons/points-livraison', U.chief)).json().items;
    expect(map).toHaveLength(2);
    expect(audits(env, 'verticales.beverage.map.consulted')).toHaveLength(1);
    const un = (await env.req('GET', '/v1/verticales/fiches/boissons/points-non-autorises', U.chief)).json().items;
    const terrasse = un.find((p: { label: string }) => p.label.startsWith('Terrasse'));
    expect(terrasse.status).toBe('A_IDENTIFIER');
    const tr = await env.req('POST', '/v1/verticales/fiches/boissons/transmissions', U.chief, { pointIds: un.map((p: { id: string }) => p.id), motif: 'Points livrés sans autorisation (démonstration)' });
    expect(tr.statusCode).toBe(201);
    const est = env.app.ctx.objects.objects.find((o) => o.attributes.source === 'POINT_DE_LIVRAISON_BOISSONS');
    expect(est).toHaveLength(1);
    expect(est[0]).toMatchObject({ probativeStatus: 'OBSERVE', attributes: { objectType: 'ETABLISSEMENT', verticale: 'entreprises' } });
    expect(f.deliveryPoints.get(terrasse.id)!.establishmentRef).toBe(est[0]!.id);
    // Cohérence mensuelle : mois non déclaré ; livraisons supérieures au déclaré.
    await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'VOLUMES_BAT', period: '2026-08', lines: { biere_litres: '500' } });
    const coh = (await env.req('GET', '/v1/verticales/fiches/boissons/coherence', U.chief)).json().items[0];
    expect(coh.months.find((m: { period: string }) => m.period === '2026-08').flags).toContain('LIVRAISONS_SUPERIEURES_AU_DECLARE');
    const rl = await env.req('POST', `/v1/verticales/fiches/boissons/redevables/${DEMO.taxpayerId}/relances`, U.chief, { kind: 'DECLARATION', motif: 'Déclaration de septembre attendue' });
    expect(rl.statusCode).toBe(201);
    const fu = (await env.req('GET', '/v1/verticales/fiches/boissons/suivi', U.chief)).json().items[0];
    expect(fu.reminders).toHaveLength(1);
    const ind = (await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor)).json().modules.find((m: { module: string }) => m.module === '17').indicators;
    expect(ind.find((i: { key: string }) => i.key === 'volumesDeclares').value).toBe('500');
  });
});

describe('Fiche 19 — assainissement : rattachement automatique au portefeuille, avis unique, aucune double facturation', () => {
  it('la règle s’applique aux objets existants ; toutes les obligations de l’objet figurent sur un même avis', async () => {
    const env = await setup();
    publishRule(env, { code: 'TEST-ASSAINISSEMENT', formula: 'superficie_m2 * tarif_m2', rateTable: { tarif_m2: '10' }, taxableEvent: 'Raccordement au réseau d’assainissement (test)', baseDefinition: 'Superficie de la parcelle' });
    const pf0 = (await env.req('GET', '/v1/verticales/fiches/assainissement/portefeuille?exercice=2026', U.instructor)).json();
    expect(pf0.total).toBe(0);
    await configure(env, '19', { ruleCode: 'TEST-ASSAINISSEMENT', objectCategories: ['PARCELLE'] });
    const pf = (await env.req('GET', '/v1/verticales/fiches/assainissement/portefeuille?exercice=2026', U.instructor)).json();
    expect(pf.items.find((i: { objectId: string }) => i.objectId === DEMO.parcelId).state).toBe('A_LIQUIDER');
    expect((await env.req('POST', '/v1/verticales/fiches/assainissement/application', U.instructor, { exercice: '2026', motif: 'Application annuelle' })).statusCode).toBe(403);
    const ap = (await env.req('POST', '/v1/verticales/fiches/assainissement/application', U.chief, { exercice: '2026', motif: 'Application annuelle (démonstration)' })).json();
    expect(ap.executed).toBeGreaterThanOrEqual(1);
    const again = (await env.req('POST', '/v1/verticales/fiches/assainissement/application', U.chief, { exercice: '2026', motif: 'Second passage (démonstration)' })).json();
    expect(again.executed).toBe(0);
    expect(again.skipped.find((s: { objectId: string }) => s.objectId === DEMO.parcelId).reason).toBe('DEJA_LIQUIDE');
    const notice = (await env.req('GET', `/v1/verticales/fiches/objets/${DEMO.parcelId}/avis-unique?exercice=2026`, 'u-contribuable')).json();
    expect(notice.lines.length).toBeGreaterThanOrEqual(2);
    expect(notice.lines.map((l: { ruleCode: string }) => l.ruleCode)).toContain('TEST-ASSAINISSEMENT');
    const ind = (await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor)).json().modules.find((m: { module: string }) => m.module === '19').indicators;
    expect(ind.find((i: { key: string }) => i.key === 'tauxPaiementGroupe')).toMatchObject({ measured: true });
    expect(ind.find((i: { key: string }) => i.key === 'recettesParObjet')).toMatchObject({ measured: true });
  });
});

describe('Fiches 20 et 21 — abonnement d’étal, rapprochement des marchés, taxe sur billetterie déclarée ou contrôlée', () => {
  it('abonnement du droit d’étal : consentement, renouvellement idempotent à l’échéance, résiliation', async () => {
    const env = await setup();
    const f = fiches(env);
    const sub = await env.req('POST', `/v1/verticales/fiches/marches/etals/${VX_DEMO.stallId}/abonnement`, 'u-contribuable', { consent: true });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().renewals).toHaveLength(0); // titre du seed en attente de paiement : aucune demande en double
    expect((await env.req('POST', `/v1/verticales/fiches/marches/etals/${VX_DEMO.stallId}/abonnement`, 'u-locataire', { consent: true })).statusCode).toBe(403);
    const pending = vx(env).titles.find((t) => t.stallId === VX_DEMO.stallId)[0]!;
    const owner = env.app.ctx.users.get('u-contribuable')!;
    const o = env.app.ctx.payments.createOrder(owner, pending.obligationId, { channel: 'MOBILE_MONEY' });
    confirm(env, o.paymentReference);
    expect(f.runStallSubscriptions().renewed).toBe(0);
    env.clock.advance(31 * 86_400_000);
    expect(f.runStallSubscriptions().renewed).toBe(1);
    expect(f.runStallSubscriptions().renewed).toBe(0);
    expect((await env.req('GET', '/v1/verticales/fiches/marches/abonnements/mine', 'u-contribuable')).json().items[0].renewals).toHaveLength(1);
    expect((await env.req('POST', `/v1/verticales/fiches/marches/etals/${VX_DEMO.stallId}/abonnement`, 'u-contribuable', { consent: false })).json().status).toBe('RESILIE');
    const mk = (await env.req('GET', '/v1/verticales/fiches/marches/rapprochement', U.chief)).json().items.find((m: { marketId: string }) => m.marketId === 'MKT-CENTRAL');
    expect(mk.titles).toBeGreaterThanOrEqual(2);
    expect(mk.paidTitles).toBe(1);
  });

  it('événement : enregistrement préalable exigé, liquidation sur la fréquentation contrôlée par une autre personne que le contrôleur', async () => {
    const env = await setup();
    const v = vx(env);
    // Sans compte contribuable (enregistrement préalable), aucune demande d'autorisation.
    expect((await env.req('POST', '/v1/verticales/evenements/cases', 'u-mandataire', { type: 'DEMANDE_AUTORISATION_EVENEMENT', details: {}, documents: [] }, { 'idempotency-key': randomUUID() })).json().code).toBe('TAXPAYER_REQUIRED');
    const owner = env.app.ctx.users.get('u-contribuable')!;
    const chief = env.app.ctx.users.get(U.chief)!;
    const instructor = env.app.ctx.users.get(U.instructor)!;
    const c = v.submitCase(owner, 'evenements', { type: 'DEMANDE_AUTORISATION_EVENEMENT', details: { nom: 'Festival test', lieu: 'Salle test', dateDebut: '2026-10-10', dateFin: '2026-10-10', jauge: '1000', commune: 'Gombe', quartier: 'Golf' }, documents: [{ label: 'Contrat ou accord du lieu', sha256: HASH }, { label: 'Plan de sécurité', sha256: HASH }] });
    v.take(instructor, c.id);
    v.propose(instructor, c.id, { outcome: 'ACCEPTER', reason: 'Dossier complet (test).' });
    const ok = v.decide(chief, c.id, { decision: 'ACCEPTE', reason: 'Conforme (test).' });
    const evt = ok.createdObjectId!;
    v.declareTicketing(owner, evt, { ticketsSold: 400, source: 'DECLARATION' as never });
    expect((await env.req('POST', `/v1/verticales/fiches/evenements/${evt}/liquidation`, U.chief, { basis: 'CONTROLEE', motif: 'Écart constaté sur place' })).json().code).toBe('NO_CONTROL');
    v.controlEvent(instructor, evt, 650);
    const liq = await env.req('POST', `/v1/verticales/fiches/evenements/${evt}/liquidation`, U.chief, { basis: 'CONTROLEE', motif: 'Fréquentation contrôlée supérieure à la billetterie déclarée' });
    expect(liq.statusCode).toBe(201);
    expect(liq.json().obligation.amount).toEqual({ amount: '130000.00', currency: 'CDF' });
    expect((await env.req('POST', `/v1/verticales/fiches/evenements/${evt}/liquidation`, U.chief, { basis: 'DECLAREE', motif: 'Seconde liquidation' })).json().code).toBe('DOUBLE_BILLING');
    const rev = (await env.req('GET', '/v1/verticales/fiches/evenements/recettes', U.instructor)).json().items.find((e: { objectId: string }) => e.objectId === evt);
    expect(rev).toMatchObject({ authorized: true, ticketsDeclared: 400, attendanceObserved: 650, gap: 250, obligations: 1 });
  });
});

describe('Fiche 23 — recettes forestières : accès limité, déclaration au point de contrôle, liquidation automatique sur superficie', () => {
  it('concessions liquidées une fois par exercice sur règle ACTIVE ; déclarations enregistrées au point de contrôle', async () => {
    const env = await setup();
    const f = fiches(env);
    const con = (await env.req('POST', '/v1/verticales/fiches/23/objets', 'u-contribuable', { commune: 'Maluku', quartier: 'Mbankana', lat: -4.2, lon: 15.9, attributes: { nom: 'Concession test', superficie_ha: '1500', titre: 'CCF-0001 (fictif)' } })).json().object;
    expect((await env.req('GET', '/v1/verticales/fiches/23/objets', U.fieldAgent)).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/verticales/fiches/23/objets', U.chief)).statusCode).toBe(200);
    expect(audits(env, 'verticales.forest.consulted').length).toBeGreaterThanOrEqual(1);
    const d = await env.req('POST', '/v1/verticales/fiches/forets/declarations', U.instructor, { pointId: 'PCF-EX-02', produit: 'Chenilles séchées', quantiteKg: '120', declarant: 'Vendeuse non enregistrée (démonstration)' });
    expect(d.statusCode).toBe(201);
    expect((await env.req('POST', '/v1/verticales/fiches/forets/declarations', U.fieldAgent, { pointId: 'PCF-EX-02', produit: 'Miel', quantiteKg: '5', declarant: 'X Y' })).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/verticales/fiches/forets/declarations', U.fieldAgent)).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/verticales/fiches/forets/declarations', U.chief)).json().items[0]).toMatchObject({ produit: 'Chenilles séchées', quantiteKg: '120' });
    publishRule(env, { code: 'TEST-FORETS', formula: 'superficie_ha * tarif_ha', rateTable: { tarif_ha: '100' }, taxableEvent: 'Titularité d’une concession forestière (test)', baseDefinition: 'Superficie concédée' });
    await configure(env, '23', { ruleCode: 'TEST-FORETS' });
    // La lecture de la liste déclenche le passage idempotent ; puis le passage explicite ne refait rien.
    const list = (await env.req('GET', '/v1/verticales/fiches/liquidations?module=23', U.chief)).json().items;
    expect(list.find((l: { objectId: string }) => l.objectId === con.id)).toMatchObject({ status: 'EXECUTEE', mode: 'AUTOMATIQUE', period: '2026' });
    expect(env.app.ctx.assessment.get(list.find((l: { objectId: string }) => l.objectId === con.id).obligationId).amount).toEqual({ amount: '150000.00', currency: 'CDF' });
    expect(f.runAutomatic('2026', ['23']).modules[0]!.executed).toBe(0);
    const ind = (await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor)).json().modules.find((m: { module: string }) => m.module === '23').indicators;
    expect(ind.find((i: { key: string }) => i.key === 'concessionsLiquidees').value).toBe(1);
    expect(ind.find((i: { key: string }) => i.key === 'declarationsEnregistrees').value).toBeGreaterThanOrEqual(1);
  });
});

describe('Fiche 18 — contribution plastique : désactivée tant que la règle n’est pas publiée, simulation d’impact', () => {
  it('registre des assujettis et étude sans obligation ; simulation non opposable ; déclaration et reversement après règle ACTIVE, par une autre personne', async () => {
    const env = await setup();
    const view0 = (await env.req('GET', '/v1/verticales/plastique', U.chief)).json();
    expect(view0).toMatchObject({ active: false, ruleStatus: 'ACTE_REQUIS' });
    const owner = env.app.ctx.users.get('u-contribuable')!;
    const obj = env.app.ctx.objects.create(owner, { taxpayerId: DEMO.taxpayerId, category: 'ACTIVITE', commune: 'Limete', quartier: 'Industriel', localityRank: 2, lat: -4.36, lon: 15.34, attributes: { objectType: 'ETABLISSEMENT', nom: 'Usine d’emballages (test)' } });
    expect((await env.req('POST', '/v1/verticales/plastique/declarations', 'u-contribuable', { objectId: obj.id, period: '2026-08', lines: { emballages_kg: '1000' } })).json().code).toBe('MODULE_DESACTIVE');
    expect(audits(env, 'verticales.plastic.declaration.refused')).toHaveLength(1);
    expect((await env.req('POST', '/v1/verticales/plastique/assujettis', U.director, { taxpayerId: DEMO.taxpayerId, roles: ['PRODUCTEUR'], categories: ['emballages_kg'], source: 'Registre des metteurs en marché', motif: 'Identification (démonstration)' })).statusCode).toBe(201);
    expect((await env.req('POST', '/v1/verticales/plastique/etude', U.director, { taxpayerId: DEMO.taxpayerId, period: '2026', lines: { emballages_kg: '12000', sachets_kg: '3000' }, source: 'Enquête (démonstration)' })).statusCode).toBe(201);
    // Simulation sur une fiche ACTE_REQUIS (jamais publiable) : taux de la fiche seulement, non opposable.
    const draft = env.app.ctx.rules.create(env.app.ctx.users.get('u-juriste-redacteur')!, {
      code: 'TEST-PLASTIQUE-SIM', label: 'Contribution plastique — projet (test)', revenueCategory: 'ACTE_REQUIS', legalInstrumentIds: ['demo-instrument-001'], articles: ['Art. 1 (projet)'],
      competentAuthority: 'Assemblée provinciale (projet)', administeringEntity: 'DGTK', taxableEvent: 'Mise en marché d’emballages plastiques (projet)', liableParty: 'Producteur ou importateur',
      baseDefinition: 'Masse mise en marché', formula: 'emballages_kg * taux_kg + sachets_kg * taux_sachet', rateTable: { taux_kg: '2', taux_sachet: '5' }, currency: 'CDF', rounding: 'HALF_UP',
      periodicity: 'ANNUELLE', dueRule: 'Projet', exemptions: [], penalties: [], effectiveFrom: '2027-01-01', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01', appealPath: 'Projet', sourceVerification: 'OFFICIEL_CERTIFIE',
    });
    const sim = await env.req('POST', '/v1/verticales/plastique/simulations', U.director, { ruleId: draft.id, scenario: 'Taux du projet d’édit' });
    expect(sim.statusCode).toBe(201);
    expect(sim.json()).toMatchObject({ total: '39000', nonOpposable: true, ruleStatus: 'BROUILLON' });
    expect(env.app.ctx.assessment.obligations.find((o) => o.ruleCode === 'TEST-PLASTIQUE-SIM')).toHaveLength(0);
    // Après publication d'une règle ACTIVE retenue par la régie : module activé.
    publishRule(env, { code: 'TEST-PLASTIQUE', formula: 'emballages_kg * taux_kg', rateTable: { taux_kg: '2' }, taxableEvent: 'Mise en marché d’emballages plastiques (test)', baseDefinition: 'Masse (kg)' });
    await configure(env, '18', { ruleCode: 'TEST-PLASTIQUE' });
    expect((await env.req('GET', '/v1/verticales/plastique', U.chief)).json().active).toBe(true);
    const dec = await env.req('POST', '/v1/verticales/plastique/declarations', 'u-contribuable', { objectId: obj.id, period: '2026-08', lines: { emballages_kg: '1000' } });
    expect(dec.statusCode).toBe(201);
    const liq = await env.req('POST', `/v1/verticales/plastique/declarations/${dec.json().id}/reversement`, U.instructor);
    expect(liq.statusCode).toBe(201);
    expect(env.app.ctx.assessment.get(liq.json().obligationId).amount).toEqual({ amount: '2000.00', currency: 'CDF' });
    expect((await env.req('POST', `/v1/verticales/plastique/declarations/${dec.json().id}/reversement`, U.instructor)).json().code).toBe('ALREADY_LIQUIDATED');
    const ind = (await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor)).json().modules.find((m: { module: string }) => m.module === '18').indicators;
    expect(ind).toEqual([expect.objectContaining({ key: 'assujettisIdentifies', value: 1 }), expect.objectContaining({ key: 'simulations', value: 1 })]);
  });
});

describe('Indicateurs des fiches 13 à 25', () => {
  it('chaque fiche a ses indicateurs, mesurés ou « non mesuré » avec la raison (donnée source absente)', async () => {
    const env = await setup();
    const r = await env.req('GET', '/v1/verticales/fiches/indicateurs', U.instructor);
    expect(r.statusCode).toBe(200);
    const mods = r.json().modules as { module: string; indicators: { measured: boolean; reason?: string }[] }[];
    expect(mods.map((m) => m.module)).toEqual(['13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25']);
    for (const m of mods) {
      expect(m.indicators.length).toBeGreaterThan(0);
      for (const i of m.indicators) if (!i.measured) expect(i.reason).toBeTruthy();
    }
    expect((await env.req('GET', '/v1/verticales/fiches/indicateurs', 'u-contribuable')).statusCode).toBe(403);
    // Un acteur système ne peut pas se faire passer pour un utilisateur.
    const u: User | undefined = env.app.ctx.users.get('fiches-liquidation-automatique');
    expect(u).toBeUndefined();
  });
});
