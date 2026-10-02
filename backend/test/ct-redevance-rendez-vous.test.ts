/**
 * Redevance de contrôle technique liée au rendez-vous (30/09/2026, demande du maître d'ouvrage : « rien n'est gratuit ;
 * comment paie-t-on ? en espèces au centre ? ») : non — la prise de rendez-vous liquide la redevance par la fiche
 * ACTIVE du registre ; l'usager la paie par le circuit commun (référence, quittance) ; le centre ne confirme le créneau
 * qu'une fois le paiement confirmé et n'encaisse jamais rien.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { VC_DEMO } from '../src/plugins/vehicules-controle/seed.js';

let saved: string | undefined;
beforeEach(() => { saved = process.env.MOSOLO_DEMO_MODE; process.env.MOSOLO_DEMO_MODE = '1'; });
afterEach(() => { if (saved === undefined) delete process.env.MOSOLO_DEMO_MODE; else process.env.MOSOLO_DEMO_MODE = saved; });

describe('Rendez-vous de contrôle technique : redevance payée par le circuit commun, jamais au centre', () => {
  it('rendez-vous → redevance liquidée → « Payer la redevance » dans À faire → confirmation refusée avant paiement → paiement → créneau confirmé', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'demo-secret-mm-operator-a', 'bank-a': 'demo-secret-bank-a', 'card-gateway': 'demo-secret-card-gateway' }, commsProviderKeys: {} } });
    await app.ready();
    const req = (method: string, url: string, user: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
      method: method as 'GET', url, headers: { 'x-demo-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

    const b = await req('POST', '/v1/vehicules/rendez-vous', 'u-contribuable', { plate: VC_DEMO.plates.aJour, centreId: VC_DEMO.centres.ct1, date: '2026-10-05' });
    expect(b.statusCode, b.body).toBe(201);
    const rdv = b.json() as { id: string; fee: { status: string; obligationId: string; amount: { amount: string; currency: string } }; redevancePayee: boolean; notice: string };
    expect(rdv.fee.status).toBe('LIQUIDEE');
    expect(rdv.fee.amount.currency).toBe('CDF');
    expect(rdv.redevancePayee).toBe(false);
    expect(rdv.notice).toMatch(/espèces/);

    // « À faire » : une seule ligne, sur le rendez-vous, avec le paiement direct de sa redevance.
    const af = (await req('GET', '/v1/moi/a-faire', 'u-contribuable')).json() as { aFaire: { libelle: string; action: { libelle: string; obligationId?: string } | null }[] };
    const lignes = af.aFaire.filter((l) => l.action?.obligationId === rdv.fee.obligationId);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.action!.libelle).toBe('Payer la redevance');

    // Le centre ne peut pas confirmer tant que la redevance n'est pas payée.
    const c1 = await req('POST', `/v1/vehicules/rendez-vous/${rdv.id}/confirmation`, VC_DEMO.users.centre1, {});
    expect(c1.json().code).toBe('REDEVANCE_NON_PAYEE');

    // Paiement par le circuit commun (référence + confirmation signée de l'opérateur).
    const o = await req('POST', `/v1/obligations/${rdv.fee.obligationId}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
    expect(o.statusCode, o.body).toBe(201);
    const c = await req('POST', '/v1/providers/mm-operator-a/demo-operator-confirmation', 'u-tresor', { paymentReference: o.json().paymentReference });
    expect(c.statusCode, c.body).toBe(200);

    const list = (await req('GET', '/v1/vehicules/rendez-vous', VC_DEMO.users.centre1)).json() as { items: { id: string; redevancePayee: boolean }[] };
    expect(list.items.find((a) => a.id === rdv.id)?.redevancePayee).toBe(true);
    const c2 = await req('POST', `/v1/vehicules/rendez-vous/${rdv.id}/confirmation`, VC_DEMO.users.centre1, {});
    expect(c2.statusCode, c2.body).toBe(200);
    expect(c2.json()).toMatchObject({ status: 'CONFIRME', redevancePayee: true });
  });
});

describe('Redevance CT de démonstration — date d’effet au jour de Kinshasa', () => {
  it('démarrage entre 23 h et minuit UTC (déjà le lendemain à Kinshasa) : la règle de démonstration est publiée sans erreur', async () => {
    const { buildApp: build } = await import('../src/app.js');
    const { ManualClock: Clock } = await import('../src/core/clock.js');
    const { DEFAULT_PLUGINS: plugins } = await import('../src/plugins/index.js');
    expect(() => build({ clock: new Clock('2026-09-30T23:30:00.000Z'), seed: true, plugins, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } })).not.toThrow();
  });
});
