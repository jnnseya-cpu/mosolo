import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { Secrets } from '../src/context.js';
import { signedCallbackHeaders } from '../src/modules/payments/callback-signing.js';
import { DEMO } from '../src/seed.js';

export const PROVIDER_SECRET = 'test-secret-mm-operator-a';

export interface TestEnv {
  app: FastifyInstance;
  clock: ManualClock;
  req: (method: string, url: string, user?: string, body?: unknown, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
}

export async function setup(overrides: Partial<Secrets> = {}): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  // Tests du socle : sans modules d'extension (leurs données de démonstration changeraient les comptages).
  // L'application complète est couverte par test/integration.test.ts et par les tests de chaque module.
  const app = buildApp({
    clock,
    plugins: [],
    secrets: {
      auditHmacKey: 'test-audit-key',
      providerSecrets: { 'mm-operator-a': PROVIDER_SECRET },
      commsProviderKeys: {},
      ...overrides,
    },
  });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
  return { app, clock, req };
}

export function demoObligationId(env: TestEnv): string {
  return env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
}

export async function createOrder(env: TestEnv, key = randomUUID(), body: unknown = { channel: 'MOBILE_MONEY' }) {
  return env.req('POST', `/v1/obligations/${demoObligationId(env)}/payment-orders`, 'u-contribuable', body, { 'idempotency-key': key });
}

/** En-têtes HTTP d'un rappel générique signé v2 (horodatage et nonce couverts par la signature). */
export function callbackHeaders(secret: string, raw: string, at: Date, opts: { nonce?: string; kid?: string } = {}): Record<string, string> {
  const h = signedCallbackHeaders(secret, raw, at, opts);
  return { 'x-signature': h.signature, 'x-nonce': h.nonce, 'x-timestamp': h.timestamp, ...(h.keyId ? { 'x-key-id': h.keyId } : {}) };
}

export function signedCallback(env: TestEnv, body: Record<string, unknown>, opts: { secret?: string; nonce?: string; timestamp?: string; provider?: string; kid?: string } = {}) {
  const raw = JSON.stringify(body);
  return env.app.inject({
    method: 'POST',
    url: `/v1/providers/${opts.provider ?? 'mm-operator-a'}/callbacks`,
    headers: {
      'content-type': 'application/json',
      ...callbackHeaders(opts.secret ?? PROVIDER_SECRET, raw, new Date(opts.timestamp ?? env.clock.now().toISOString()), { nonce: opts.nonce ?? randomUUID(), ...(opts.kid ? { kid: opts.kid } : {}) }),
    },
    payload: raw,
  });
}

export function callbackBody(env: TestEnv, paymentReference: string, amount = { amount: '150.00', currency: 'USD' }, txn = `TXN-${randomUUID()}`) {
  return { providerTxnId: txn, paymentReference, amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() };
}

/** Parcours complet : ordre → confirmation prestataire. Renvoie la référence et la réponse du rappel. */
export async function payDemoObligation(env: TestEnv) {
  const order = (await createOrder(env)).json();
  const cb = await signedCallback(env, callbackBody(env, order.paymentReference));
  return { order, callback: cb.json(), status: cb.statusCode };
}

/** Règle certifiée (instrument fictif en vigueur) créée puis approuvée par quatre personnes distinctes. */
export async function publishCertifiedRule(env: TestEnv, overrides: Record<string, unknown> = {}, stepsToRun = 4) {
  const create = await env.req('POST', '/v1/legal-rules', 'u-juriste-redacteur', {
    code: 'TEST-IF-PM', revenueCategory: 'IMPOT_PROVINCIAL', label: 'Test — impôt foncier personnes morales',
    legalInstrumentIds: ['demo-instrument-001'], articles: ['Art. 1 (fictif)'], competentAuthority: 'Ministère provincial des Finances',
    administeringEntity: 'DGIPK', taxableEvent: 'Propriété', liableParty: 'Propriétaire', baseDefinition: 'Superficie en m²',
    formula: 'superficie_m2 * tarif_m2', rateTable: { 'tarif_m2:1': '3.5', 'tarif_m2:2': '2.5', 'tarif_m2:3': '2', 'tarif_m2:4': '1.5' },
    currency: 'USD', rounding: 'HALF_UP', periodicity: 'ANNUELLE', dueRule: '30 jours', effectiveFrom: '2026-01-01',
    beneficiaryAccountAlias: DEMO.dgipkAlias, appealPath: 'Réclamation DGIPK', sourceVerification: 'OFFICIEL_CERTIFIE',
    ...overrides,
  });
  const id = create.json().id as string;
  const steps: [string, string][] = [
    ['u-juriste-redacteur', 'REDACTEUR'], ['u-juriste-verificateur', 'VERIFICATEUR_JURIDIQUE'],
    ['u-validateur-financier', 'VALIDATEUR_FINANCIER'], ['u-autorite-publication', 'AUTORITE_PUBLICATION'],
  ];
  const responses = [];
  for (const [user, role] of steps.slice(0, stepsToRun)) responses.push(await env.req('POST', `/v1/legal-rules/${id}/approve`, user, { role }));
  return { create, id, responses };
}

export { DEMO };

/**
 * Import d'un relevé en DOUBLE VALIDATION (module 29) : proposition par `proposer`, puis validation par une autre
 * personne habilitée (analyste de rapprochement ou comptable public). Réponse finale : résultat de l'application (201),
 * rejeu (200) ou erreur de la proposition / de la validation.
 */
export async function postStatement(env: Pick<TestEnv, 'req'>, proposer: string, body: { statementId: string; lines: unknown[] }, validator?: string) {
  const p = await env.req('POST', '/v1/settlements/statements', proposer, body);
  if (p.statusCode !== 202) return p;
  const v = validator ?? (proposer === 'u-analyste-rappro' ? 'u-tresor' : 'u-analyste-rappro');
  return env.req('POST', `/v1/settlements/statements/${encodeURIComponent(body.statementId)}/validation`, v, { approve: true, motif: 'Relevé vérifié ligne à ligne (test).' });
}
