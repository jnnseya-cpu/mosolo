/**
 * Outils communs des tests des modules 75 à 81 et des parcours de bout en bout de la Partie V : application complète
 * (tous les modules d'extension, données de démonstration semées) ou restreinte, règles FICTIVES [EXEMPLE] publiées
 * par le circuit réel à quatre visas, paiement par rappel prestataire signé (même chemin que la production).
 */
import { randomUUID } from 'node:crypto';
import type { RuleInput } from '../src/modules/rules/service.js';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { DEMO_INSTRUMENT, DGTK_ALIAS, publishDemoRule } from '../src/plugins/parking/support.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

export async function setupApp(plugins: MosoloPlugin<unknown>[] = DEFAULT_PLUGINS, at = '2026-09-26T09:00:00.000Z'): Promise<TestEnv> {
  const clock = new ManualClock(at);
  const app = buildApp({
    clock, plugins,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
  });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req };
}

export const idem = () => ({ 'idempotency-key': randomUUID() });

/** Règle FICTIVE [EXEMPLE] publiée par les quatre visas du circuit réel, marquée démonstration (aucune valeur juridique). */
export function exampleRule(env: TestEnv, input: Pick<RuleInput, 'code' | 'formula' | 'rateTable'> & Partial<RuleInput>) {
  const rule = publishDemoRule(env.app.ctx, {
    legalInstrumentIds: [DEMO_INSTRUMENT], articles: ['Article 1 (fictif) [EXEMPLE]'], competentAuthority: 'Gouvernorat (démonstration)',
    administeringEntity: 'DGTK', currency: 'USD', rounding: 'HALF_UP', exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
    beneficiaryAccountAlias: DGTK_ALIAS, sourceVerification: 'OFFICIEL_CERTIFIE', appealPath: 'Réclamation via MOSOLO (démonstration)',
    revenueCategory: 'PROVINCIAL_SPECIFIQUE', label: `DÉMONSTRATION — ${input.code} [EXEMPLE] (fictive, non opposable)`,
    taxableEvent: 'Fait générateur fictif [EXEMPLE]', liableParty: 'Redevable', baseDefinition: 'Base fictive [EXEMPLE]',
    periodicity: 'PONCTUELLE', dueRule: '30 jours (démonstration)',
    ...input,
  } as RuleInput);
  if (!rule || rule.status !== 'ACTIVE') throw new Error(`Règle d’exemple non publiée : ${input.code}`);
  return rule;
}

/** Paiement numérique d'une obligation par le circuit commun : ordre → rappel prestataire signé → quittance. */
export async function payObligation(env: TestEnv, obligationId: string, user: string) {
  const order = await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, idem());
  if (order.statusCode !== 201) throw new Error(`Ordre refusé (${order.statusCode}) : ${order.body}`);
  const o = order.json();
  const cb = await signedCallback(env, callbackBody(env, o.paymentReference, o.amount));
  if (cb.statusCode !== 200) throw new Error(`Rappel refusé (${cb.statusCode}) : ${cb.body}`);
  return o as { paymentReference: string; amount: { amount: string; currency: string } };
}
