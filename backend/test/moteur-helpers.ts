/**
 * Aides des tests du moteur de répartition (spécifications du 29/09/2026) : application réduite (accès, Trésor, clé du
 * § 37A, moteur), paiement + rapprochement, activation de la clé du § 37A puis de la V1 KIN-DEFAULT par quatre personnes.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { accesPlugin } from '../src/plugins/acces/plugin.js';
import { moteurRepartitionPlugin } from '../src/plugins/pilotage/repartition/moteur/plugin.js';
import type { MoteurRepartitionService } from '../src/plugins/pilotage/repartition/moteur/service.js';
import { repartitionPlugin } from '../src/plugins/pilotage/repartition/plugin.js';
import { KEY_ID, type RepartitionService } from '../src/plugins/pilotage/repartition/service.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, postStatement, PROVIDER_SECRET, publishCertifiedRule, signedCallback, type TestEnv } from './helpers.js';

export const B = '/v1/pilotage/moteur-repartition';

export async function setupMoteur(at = '2026-10-02T09:00:00.000Z') {
  const clock = new ManualClock(at);
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [accesPlugin, tresorPlugin, repartitionPlugin, moteurRepartitionPlugin] as MosoloPlugin<unknown>[],
  });
  await app.ready();
  const env: TestEnv & { svc: MoteurRepartitionService; rep: RepartitionService } = {
    app, clock, svc: app.ctx.ext['moteur-repartition'] as MoteurRepartitionService, rep: app.ctx.ext.repartition as RepartitionService,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}
export type MEnv = Awaited<ReturnType<typeof setupMoteur>>;

/** Paiement de l'obligation de démonstration (150,00 USD, règle DEMO-IF-BATI) puis rapprochement au relevé. */
export async function payAndReconcile(env: MEnv, channel = 'MOBILE_MONEY', obligationId?: string) {
  const ob = obligationId ?? env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
  const r = await env.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel }, { 'idempotency-key': randomUUID() });
  expect(r.statusCode, r.body).toBeLessThan(300);
  const order = r.json();
  await signedCallback(env, callbackBody(env, order.paymentReference));
  const st = await postStatement(env, 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: env.clock.now().toISOString().slice(0, 10), paymentReference: order.paymentReference }],
  });
  expect(st.statusCode, st.body).toBeLessThan(300);
  const o = env.app.ctx.payments.byReference(order.paymentReference)!;
  expect(o.status).toBe('RAPPROCHE');
  return o;
}

/** Remboursement constaté (écriture de remboursement + transition de l'ordre), comme dans les tests du § 37A. */
export function refund(env: MEnv, orderId: string) {
  const o = env.app.ctx.payments.orders.get(orderId)!;
  const entry = env.app.ctx.ledger.postPair({ eventType: 'REFUND', description: `Remboursement ${o.paymentReference} (test)`, sourceType: 'payment_order', sourceId: o.id, debit: 'RECETTES_CONSTATEES', credit: 'COMPTE_PUBLIC_RECETTES', amount: o.amount });
  env.app.ctx.payments.markRefunded(o.id, entry.id);
  env.app.ctx.assessment.setStatus(o.obligationId, 'EXIGIBLE');
}

export const act = {
  instrumentId: 'demo-instrument-001', reference: 'ARR-2026-037A (fictif)', title: 'Arrêté provincial FICTIF instituant la clé de répartition', nature: 'ARRETE',
  signedOn: '2026-09-20', documentSha256: sha256Hex('acte-fictif'),
  conditions: { contratPpp: 'Contrat PPP n° 1 (fictif)', conformiteLofip: 'Avis LOFIP (fictif)', conventionTripartite: 'Convention tripartite (fictive)', traitementFiscal: 'Note fiscale (fictive)' },
};
export const keyRule = (rates = { part_groupe_nseya: '10', part_tutelle: '10', part_agents: '10', part_gouvernement: '70' }, effectiveFrom = '2026-09-26') => ({
  code: 'CLE-REPARTITION-37A', revenueCategory: 'ACTE_REQUIS', label: 'Clé de répartition — version certifiée (test)', legalInstrumentIds: ['demo-instrument-001'],
  formula: 'recettes_rapprochees * (part_groupe_nseya + part_tutelle + part_agents + part_gouvernement) / 100',
  rateTable: rates, rounding: 'DOWN', periodicity: 'MENSUELLE', effectiveFrom,
});

/** Clé du § 37A ACTIVE (acte enregistré, règle certifiée, deux personnes). */
export async function activateKey(env: MEnv) {
  const base = `/v1/pilotage/repartition/cles/${KEY_ID}`;
  await env.req('POST', `${base}/acte`, 'u-autorite-publication', act);
  await publishCertifiedRule(env, keyRule(undefined, env.clock.now().toISOString().slice(0, 10)));
  await env.req('POST', `${base}/activation`, 'u-ministre-finances', { motif: 'Acte provincial publié, conditions réunies (test).' });
  const r = await env.req('POST', `${base}/activation/decision`, 'u-gouverneur', { approve: true, motif: 'Activation décidée en seconde lecture (test).' });
  expect(r.json().status).toBe('ACTIVE');
}

const MOTIF = { approve: true, motif: 'Contrôle effectué sur pièces (test).' };
/** V1 KIN-DEFAULT activée : vérification (R15), approbation (R02), activation (R01) — personnes distinctes du rédacteur. */
export async function activateV1(env: MEnv, id = 'KIN-DEFAULT-V1') {
  for (const [step, user] of [['verification', 'u-validateur-financier'], ['approbation', 'u-dircab'], ['activation', 'u-gouverneur']] as const) {
    const r = await env.req('POST', `${B}/regles/${id}/${step}`, user, MOTIF);
    expect(r.statusCode, `${step} : ${r.body}`).toBe(200);
  }
}

export const money = (amount: string, currency = 'USD') => ({ amount, currency });
