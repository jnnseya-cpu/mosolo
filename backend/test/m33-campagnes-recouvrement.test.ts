/**
 * Module 33 — Campagnes de recouvrement : segments du § 21.2, séquence J-15, J-3, J+1, J+15, J+30, canaux (SMS, appel,
 * visite d'information), phase de TEST avec groupe témoin, mesure (rendement du recouvrement : coût par franc récupéré,
 * taux de régularisation), proposition d'arrêt au coût disproportionné (décision humaine), aucune contrainte.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { campagnesPlugin } from '../src/plugins/recouvrement/campagnes-plugin.js';
import type { CampaignService } from '../src/plugins/recouvrement/campaigns.js';
import { drawGroup } from '../src/plugins/recouvrement/campagnes-relance.js';
import { recouvrementPlugin } from '../src/plugins/recouvrement/plugin.js';
import { callbackBody, DEMO, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

const HASH = 'd'.repeat(64);

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [recouvrementPlugin, campagnesPlugin] });
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
const campaigns = (env: TestEnv) => env.app.ctx.ext.campagnes as CampaignService;

/** Obligation fictive dans une commune, échéance fixée (jours par rapport au 2026-09-26). */
function obligation(env: TestEnv, taxpayerId: string, dueInDays: number, commune = 'Lemba') {
  const ctx = env.app.ctx;
  const rule = ctx.rules.rules.find((r) => r.code === 'DEMO-IF-BATI' && r.status === 'ACTIVE')[0]!;
  const controller = ctx.users.get('u-controleur')!;
  const object = ctx.objects.create(controller, { taxpayerId, category: 'PARCELLE', commune, quartier: 'Salongo', localityRank: 3, lat: -4.40, lon: 15.31, attributes: { superficie_m2: '200', usage: 'residentiel', batiments: 1 } });
  const { obligation: o } = ctx.assessment.calculate(controller, { ruleId: rule.id, taxpayerId, objectId: object.id, inputs: {}, simulate: false });
  const due = new Date(Date.parse('2026-09-26T00:00:00.000Z') + dueInDays * 86_400_000).toISOString().slice(0, 10);
  ctx.assessment.obligations.update({ ...o!, dueDate: due, status: dueInDays < 0 ? 'EN_RETARD' : 'EMISE', explanation: { ...o!.explanation, dueDate: due } });
  return ctx.assessment.obligations.get(o!.id)!;
}

const base = { label: 'Campagne de relance Lemba (test)', entity: 'DGIPK', communes: ['Lemba'], channels: ['SMS', 'APPEL', 'VISITE_INFORMATION'], testSharePct: 50, controlSharePct: 20 };

describe('Module 33 — campagnes de recouvrement', () => {
  it('référentiel : 7 segments du § 21.2, séquence J-15…J+30 PAR DÉFAUT ; aucune contrainte admise', async () => {
    const env = await setup();
    const ref = (await env.req('GET', '/v1/campagnes-recouvrement/referentiel', 'u-dg-dgipk')).json();
    expect(Object.keys(ref.segments)).toEqual(['CONFORME', 'RETARD', 'DIFFICULTE', 'LITIGE', 'NON_DECLARANT', 'FRAUDE', 'GRAND_DEBITEUR']);
    expect(ref.sequence.map((s: { code: string }) => s.code)).toEqual(['J-15', 'J-3', 'J+1', 'J+15', 'J+30']);
    expect(ref.channels).toEqual(['SMS', 'APPEL', 'VISITE_INFORMATION']);
    // Action coercitive refusée ; première étape coercitive refusée ; groupes invalides refusés.
    const coercive = await env.req('POST', '/v1/campagnes-recouvrement', 'u-dg-dgipk', { ...base, code: 'CREC-COERC', segments: ['RETARD'], sequence: [{ code: 'J+1', offsetDays: 1, action: 'MISE_EN_DEMEURE', channels: ['SMS'] }] });
    expect(coercive.statusCode).toBe(422);
    expect(coercive.json().code).toBe('COERCION_FORBIDDEN');
    const first = await env.req('POST', '/v1/campagnes-recouvrement', 'u-dg-dgipk', { ...base, code: 'CREC-FIRST', segments: ['RETARD'], sequence: [{ code: 'J+30', offsetDays: 30, action: 'ORIENTATION_AGENT_HABILITE', channels: [] }] });
    expect(first.json().code).toBe('COERCION_FORBIDDEN');
    expect((await env.req('POST', '/v1/campagnes-recouvrement', 'u-dg-dgipk', { ...base, code: 'CREC-GRP', segments: ['RETARD'], testSharePct: 90, controlSharePct: 20 })).json().code).toBe('INVALID_GROUPS');
    // Droits : un contribuable ne crée pas de campagne.
    expect((await env.req('POST', '/v1/campagnes-recouvrement', 'u-locataire', { ...base, code: 'CREC-X', segments: ['RETARD'] })).statusCode).toBe(403);
    // Tirage déterministe et vérifiable des groupes.
    expect(drawGroup('CREC-1', 'OBL-1', 50, 20)).toBe(drawGroup('CREC-1', 'OBL-1', 50, 20));
  });

  it('parcours : simulation, test à deux personnes, étapes J-15/J+1/J+15/J+30 (témoin non contacté), idempotence, visite, mesure, arrêt proposé puis décidé, généralisation', async () => {
    const env = await setup();
    const soon = obligation(env, DEMO.taxpayerId, 10); // J-15
    const late = obligation(env, DEMO.taxpayerId, -5); // J+1
    const later = obligation(env, DEMO.taxpayerId, -20); // J+15
    const litige = obligation(env, DEMO.taxpayerId, -8);
    env.app.ctx.assessment.obligations.update({ ...litige, status: 'CONTESTEE' });
    const created = await env.req('POST', '/v1/campagnes-recouvrement', 'u-dg-dgipk', { ...base, code: 'CREC-LEMBA-01', segments: ['CONFORME', 'RETARD', 'DIFFICULTE', 'LITIGE', 'GRAND_DEBITEUR'] });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().sequenceStatus).toMatch(/PAR DÉFAUT/);

    const sim = (await env.req('POST', `/v1/campagnes-recouvrement/${id}/simulation`, 'u-dg-dgipk')).json();
    expect(sim.status).toBe('SIMULEE');
    const refs = sim.targets.map((t: { ref: string }) => t.ref);
    expect(refs).toEqual(expect.arrayContaining([soon.id, late.id, later.id]));
    // Litige : aucun contact de campagne (procédure de réclamation).
    expect(refs).not.toContain(litige.id);
    expect(sim.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ ref: litige.id, segment: 'LITIGE' })]));
    for (const t of sim.targets) expect(['CONFORME', 'RETARD', 'DIFFICULTE', 'GRAND_DEBITEUR']).toContain(t.segment);

    // Groupes fixés pour le test : la dernière obligation (J+15) en groupe témoin.
    const svc = campaigns(env).relances;
    const c0 = svc.get(id);
    const controlRef = later.id;
    svc.relances.update({ ...c0, targets: c0.targets.map((t) => ({ ...t, group: t.ref === controlRef ? 'TEMOIN' as const : 'TEST' as const })) });

    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/execution`, 'u-dg-dgipk')).json().code).toBe('CAMPAIGN_NOT_ACTIVE');
    await env.req('POST', `/v1/campagnes-recouvrement/${id}/lancement`, 'u-dg-dgipk');
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/lancement/decision`, 'u-dg-dgipk', { approve: true, reason: 'Auto-validation' })).statusCode).toBe(403);
    const launched = (await env.req('POST', `/v1/campagnes-recouvrement/${id}/lancement/decision`, 'u-ministre-finances', { approve: true, reason: 'Phase de test sur Lemba' })).json();
    expect(launched.status).toBe('EN_TEST');

    const run = (await env.req('POST', `/v1/campagnes-recouvrement/${id}/execution`, 'u-dg-dgipk')).json();
    const byRef = (ref: string) => run.contacts.filter((c: { ref: string }) => c.ref === ref);
    expect(byRef(soon.id)[0]).toMatchObject({ step: 'J-15', channel: 'SMS', outcome: 'ENVOYE' });
    expect(byRef(late.id)[0]).toMatchObject({ step: 'J+1', channel: 'SMS', outcome: 'ENVOYE' });
    expect(byRef(controlRef)).toHaveLength(0); // groupe témoin : jamais contacté
    // Tenant de démonstration (échéance à J-73, étapes J+1 et J+15 déjà faites) : orientation vers un agent habilité à J+30.
    const tenantOb = env.app.ctx.assessment.byTaxpayer(DEMO.tenantTaxpayerId)[0]!;
    if (refs.includes(tenantOb.id)) expect(byRef(tenantOb.id)[0]).toMatchObject({ step: 'J+30', outcome: 'ORIENTE_AGENT', channel: 'AUCUN' });
    // Aucune mise en demeure, aucune proposition de mesure créée par la campagne.
    const rec = env.app.ctx.ext.recouvrement as { proposals: { all(): unknown[] } };
    expect(rec.proposals.all()).toHaveLength(0);
    // Idempotence : aucune étape rejouée.
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/execution`, 'u-dg-dgipk')).json().contacts).toHaveLength(0);

    // J+15 pour une cible TEST : appel (SVI) et visite d'information à faire, rapportée par l'agent de contentieux.
    const c1 = svc.get(id);
    svc.relances.update({ ...c1, targets: c1.targets.map((t) => ({ ...t, group: t.ref === soon.id ? 'TEMOIN' as const : 'TEST' as const })) });
    const run2 = (await env.req('POST', `/v1/campagnes-recouvrement/${id}/execution`, 'u-dg-dgipk')).json();
    expect(run2.contacts.filter((c: { ref: string }) => c.ref === later.id).map((c: { channel: string }) => c.channel).sort()).toEqual(['APPEL', 'VISITE_INFORMATION']);
    const visit = run2.visits[0];
    const todo = (await env.req('GET', '/v1/campagnes-recouvrement/visites-a-faire', 'u-agent-terrain')).json();
    expect(todo[0]).not.toHaveProperty('amount');
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/visites/${visit.id}`, 'u-contentieux', { outcome: 'RENCONTRE_INFORME', note: 'Contribuable informé, orienté vers le point agréé' })).json().visits[0].status).toBe('FAITE');

    // Régularisation d'une cible test (paiement confirmé) ; mesure : coût non saisi ⇒ coût par franc NON_MESURE.
    const order = (await env.req('POST', `/v1/obligations/${late.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    await signedCallback(env, callbackBody(env, order.paymentReference, order.amount));
    const m1 = (await env.req('POST', `/v1/campagnes-recouvrement/${id}/mesure`, 'u-dg-dgipk')).json().measures.at(-1);
    expect(m1.test.paying).toBe(1);
    expect(m1.costPerFranc.statut).toBe('NON_MESURE');
    expect(m1.control.targets).toBe(1);

    // Coût saisi supérieur à la récupération ⇒ arrêt PROPOSÉ (jamais automatique) ; généralisation bloquée tant qu'il n'est pas décidé.
    await env.req('POST', '/v1/recouvrement/couts', 'u-contentieux', { campaignId: id, kind: 'SMS', quantity: 1000, amount: { amount: '5000.00', currency: order.amount.currency }, evidenceSha256: HASH, note: 'Facture SMS de la campagne (test)' });
    const measured = (await env.req('POST', `/v1/campagnes-recouvrement/${id}/mesure`, 'u-dg-dgipk')).json();
    const m2 = measured.measures.at(-1);
    expect(Number(m2.costPerFranc.byCurrency[order.amount.currency])).toBeGreaterThan(1);
    expect(measured.stopProposal.reasons.length).toBeGreaterThan(0);
    expect(measured.status).toBe('EN_TEST');
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/generalisation`, 'u-dg-dgipk', { reason: 'Résultats du test' })).json().code).toBe('STOP_PROPOSAL_PENDING');
    const kept = (await env.req('POST', `/v1/campagnes-recouvrement/${id}/arret/decision`, 'u-ministre-finances', { stop: false, reason: 'Coût d’amorçage ponctuel, poursuite motivée' })).json();
    expect(kept.status).toBe('EN_TEST');
    await env.req('POST', `/v1/campagnes-recouvrement/${id}/generalisation`, 'u-dg-dgipk', { reason: 'Test mesuré : régularisation supérieure au témoin' });
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/generalisation/decision`, 'u-dg-dgipk', { approve: true, reason: 'x auto' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/generalisation/decision`, 'u-ministre-finances', { approve: true, reason: 'Généralisation décidée' })).json().status).toBe('GENERALISEE');

    // Indicateurs du module : taux de régularisation et coût par franc récupéré.
    const ind = (await env.req('GET', '/v1/campagnes-recouvrement/indicateurs', 'u-dg-dgipk')).json();
    expect(ind.statut).toBe('MESURE');
    expect(ind.rows[0]).toMatchObject({ code: 'CREC-LEMBA-01', regularisationTest: expect.any(String) });
    // Calendrier commun aux campagnes de déclaration et de recouvrement.
    const cal = (await env.req('GET', '/v1/campagnes/calendrier', 'u-dg-dgipk')).json();
    expect(JSON.stringify(cal)).toContain('CREC-LEMBA-01');
    // Audit : proposition d'arrêt système, décision humaine.
    const actions = env.app.ctx.audit.list({ resourceId: id, limit: 100 }).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['recovery_campaign.stop.proposed', 'recovery_campaign.stop.declined', 'recovery_campaign.generalised']));
  });

  it('arrêt motivé à l’initiative d’une personne habilitée ; plus aucune étape ensuite', async () => {
    const env = await setup();
    obligation(env, DEMO.taxpayerId, -5);
    const id = (await env.req('POST', '/v1/campagnes-recouvrement', 'u-dg-dgipk', { ...base, code: 'CREC-STOP', segments: ['RETARD', 'CONFORME'] })).json().id;
    await env.req('POST', `/v1/campagnes-recouvrement/${id}/simulation`, 'u-dg-dgipk');
    await env.req('POST', `/v1/campagnes-recouvrement/${id}/lancement`, 'u-dg-dgipk');
    await env.req('POST', `/v1/campagnes-recouvrement/${id}/lancement/decision`, 'u-ministre-finances', { approve: true, reason: 'Test' });
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/arret`, 'u-contentieux', { reason: 'Impact social' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/arret`, 'u-ministre-finances', { reason: 'Erreurs de données constatées' })).json().status).toBe('ARRETEE');
    expect((await env.req('POST', `/v1/campagnes-recouvrement/${id}/execution`, 'u-dg-dgipk')).json().code).toBe('CAMPAIGN_NOT_ACTIVE');
  });
});
