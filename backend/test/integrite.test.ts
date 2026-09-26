import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { integritePlugin } from '../src/plugins/integrite/plugin.js';
import type { IntegriteService } from '../src/plugins/integrite/service.js';
import { DEMO_TRACKING_CODE } from '../src/plugins/integrite/seed.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

async function setupIntegrite(): Promise<TestEnv & { svc: IntegriteService }> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [integritePlugin],
  });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req, svc: app.ctx.ext.integrite as IntegriteService };
}

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const ENQ = 'u-enqueteur';
const CHEF = 'integrite-u-chef-enquetes';
const DPO = 'integrite-u-dpo';

async function newAnonymousReport(env: TestEnv, over: Record<string, unknown> = {}) {
  const r = await env.req('POST', '/v1/public/integrite/reports', undefined, {
    category: 'DEMANDE_ESPECES', anonymous: true, commune: 'Matete',
    description: 'Un agent a exigé un paiement en espèces au marché.', target: { kind: 'AGENT', reference: 'u-agent-terrain-2' }, ...over,
  });
  expect(r.statusCode).toBe(201);
  return r.json() as { reference: string; trackingCode: string };
}

describe('Ligne de signalement — dépôt et suivi', () => {
  it('dépôt anonyme sans compte : code de suivi secret, jamais stocké en clair, suivi par le code', async () => {
    const env = await setupIntegrite();
    const { reference, trackingCode } = await newAnonymousReport(env);
    expect(trackingCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const stored = env.svc.reports.get(reference)!;
    expect(JSON.stringify(stored)).not.toContain(trackingCode);
    expect(stored.sealedIdentity).toBeUndefined();

    const t = await env.req('POST', '/v1/public/integrite/reports/track', undefined, { code: trackingCode.toLowerCase() });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ reference, status: 'RECU' });
    expect(t.json()).not.toHaveProperty('implicatedUserIds');
    expect(t.json()).not.toHaveProperty('investigatorId');

    const bad = await env.req('POST', '/v1/public/integrite/reports/track', undefined, { code: 'ZZZZ-ZZZZ-ZZZZ' });
    expect(bad.statusCode).toBe(404);
  });

  it('anonymat : aucune coordonnée conservée même si elle est saisie ; sans anonymat, identité chiffrée et jamais renvoyée', async () => {
    const env = await setupIntegrite();
    const a = await newAnonymousReport(env, { contact: { phone: '+243811111111', name: 'Témoin Secret' } });
    expect(env.svc.reports.get(a.reference)!.sealedIdentity).toBeUndefined();

    const r = await env.req('POST', '/v1/public/integrite/reports', undefined, {
      category: 'FAUX_AGENT', anonymous: false, contact: { phone: '+243822222222', name: 'Témoin Protégé' }, commune: 'Gombe',
      description: 'Faux contrôleur sans badge vérifiable au boulevard.',
    });
    expect(r.statusCode).toBe(201);
    const ref = r.json().reference as string;
    const raw = JSON.stringify(env.svc.reports.get(ref));
    expect(raw).not.toContain('Témoin Protégé');
    expect(raw).not.toContain('+243822222222');
    const view = await env.req('GET', `/v1/integrite/reports/${ref}`, ENQ);
    expect(view.statusCode).toBe(200);
    expect(view.json().reporterContact).toBe('PROTEGE');
    expect(JSON.stringify(view.json())).not.toContain('Témoin Protégé');
    expect(view.json()).not.toHaveProperty('sealedIdentity');
    expect(view.json()).not.toHaveProperty('trackingHash');
    // Accusé de réception publié sans le nom réel.
    const deliveries = env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'whistleblower.report.received');
    expect(deliveries.length).toBeGreaterThan(0);
    expect(JSON.stringify(deliveries)).not.toContain('Témoin');
    // Sans anonymat, un contact est exigé.
    const noContact = await env.req('POST', '/v1/public/integrite/reports', undefined, { category: 'AUTRE', anonymous: false, description: 'Description suffisante des faits.' });
    expect(noContact.statusCode).toBe(422);
  });

  it('canaux SMS et SVI simulés : mot-clé, catégorie, accusé avec code', async () => {
    const env = await setupIntegrite();
    const sms = await env.req('POST', '/v1/public/integrite/reports/sms', undefined, { from: '+243830000000', text: 'SIGNAL WEWA ANONYME collecteurs au rond-point Ngaba' });
    expect(sms.statusCode).toBe(201);
    expect(sms.json().reply).toContain(sms.json().trackingCode);
    const stored = env.svc.reports.get(sms.json().reference)!;
    expect(stored).toMatchObject({ channel: 'SMS', category: 'PRELEVEMENT_WEWA', anonymous: true });
    expect(stored.sealedIdentity).toBeUndefined();

    const svi = await env.req('POST', '/v1/public/integrite/reports/svi', undefined, { callerNumber: '+243840000000', digits: ['3', '2'], transcript: 'Quittance papier suspecte remise au marché central.' });
    expect(svi.statusCode).toBe(201);
    expect(env.svc.reports.get(svi.json().reference)).toMatchObject({ channel: 'SVI', category: 'FAUSSE_QUITTANCE', anonymous: false });
    expect(svi.json().script).toContain('code de suivi');
  });

  it('idempotence du dépôt web : même clé, même réponse ; clé réutilisée avec un autre contenu → 409', async () => {
    const env = await setupIntegrite();
    const body = { category: 'AUTRE', anonymous: true, description: 'Fait à signaler pour test d’idempotence.' };
    const k = { 'idempotency-key': 'cle-integrite-0001' };
    const a = await env.req('POST', '/v1/public/integrite/reports', undefined, body, k);
    const b = await env.req('POST', '/v1/public/integrite/reports', undefined, body, k);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().reference).toBe(a.json().reference);
    const c = await env.req('POST', '/v1/public/integrite/reports', undefined, { ...body, description: 'Autre contenu pour la même clé.' }, k);
    expect(c.statusCode).toBe(409);
  });

  it('code de démonstration connu et complément du signalant', async () => {
    const env = await setupIntegrite();
    const t = await env.req('POST', '/v1/public/integrite/reports/track', undefined, { code: DEMO_TRACKING_CODE });
    expect(t.statusCode).toBe(200);
    expect(t.json().status).toBe('TRANSMIS');
    const c = await env.req('POST', '/v1/public/integrite/reports/track/complement', undefined, {
      code: DEMO_TRACKING_CODE, text: 'J’ajoute une photo du gilet.', evidence: [{ sha256: h('photo'), label: 'Photo du gilet' }],
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().evidenceCount).toBe(1);
    expect(c.json().messages.at(-1).from).toBe('SIGNALANT');
  });
});

describe('Ligne de signalement — qualification, transmission, protection', () => {
  it('parcours : qualification → transmission avec dossier → décision → clôture → retour visible au signalant', async () => {
    const env = await setupIntegrite();
    const { reference, trackingCode } = await newAnonymousReport(env);
    const q = await env.req('POST', `/v1/integrite/reports/${reference}/qualify`, ENQ, { category: 'DEMANDE_ESPECES', severity: 'ELEVEE', receivable: true, note: 'Faits précis et datés.' });
    expect(q.statusCode).toBe(200);
    expect(q.json().status).toBe('QUALIFIE');
    expect(q.json().treatBy).toBeTruthy();
    const a = await env.req('POST', `/v1/integrite/reports/${reference}/assign`, ENQ, { investigatorId: CHEF, openCase: true });
    expect(a.statusCode).toBe(200);
    const caseId = a.json().case.id as string;
    expect(a.json().report.status).toBe('TRANSMIS');

    // Clôture impossible tant que le dossier n'est pas décidé.
    const early = await env.req('POST', `/v1/integrite/reports/${reference}/close`, CHEF, { outcome: 'FONDE', reason: 'Faits confirmés par enquête.', publicMessage: 'Merci, des suites ont été données.' });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('CASE_PENDING');

    await env.req('POST', `/v1/integrite/cases/${caseId}/evidence`, CHEF, { sha256: h('pv-audition'), label: 'Procès-verbal d’audition' });
    const concl = await env.req('POST', `/v1/integrite/cases/${caseId}/conclusions`, CHEF, { finding: 'FONDE', summary: 'Deux témoignages concordants et absence de quittance.', recommendation: 'SAISINE_AUTORITE_COMPETENTE' });
    expect(concl.statusCode).toBe(200);
    const dec = await env.req('POST', `/v1/integrite/cases/${caseId}/decision`, 'u-decideur', { decision: 'SAISINE_AUTORITE_COMPETENTE', reason: 'Éléments concordants justifiant la saisine de l’autorité compétente.' });
    expect(dec.statusCode).toBe(200);
    expect(dec.json().decision.automaticEffect).toBe('AUCUN');

    const close = await env.req('POST', `/v1/integrite/reports/${reference}/close`, CHEF, { outcome: 'FONDE', reason: 'Faits confirmés par enquête.', publicMessage: 'Merci, votre signalement a permis d’agir.' });
    expect(close.statusCode).toBe(200);
    const t = (await env.req('POST', '/v1/public/integrite/reports/track', undefined, { code: trackingCode })).json();
    expect(t.status).toBe('CLOS');
    expect(t.outcome.code).toBe('FONDE');
    expect(t.messages.at(-1).text).toContain('permis d’agir');
  });

  it('la personne mise en cause ne voit jamais le signalement, même avec le rôle d’enquêteur', async () => {
    const env = await setupIntegrite();
    const { reference } = await newAnonymousReport(env, { target: { kind: 'AGENT', reference: CHEF } });
    const direct = await env.req('GET', `/v1/integrite/reports/${reference}`, CHEF);
    expect(direct.statusCode).toBe(403);
    expect(direct.json().code).toBe('IMPLICATED_PERSON');
    const list = (await env.req('GET', '/v1/integrite/reports', CHEF)).json() as { id: string }[];
    expect(list.some((r) => r.id === reference)).toBe(false);
    expect(env.app.ctx.audit.list({ action: 'integrite.access.implicated_refused' }).total).toBeGreaterThan(0);
    // Et ne peut pas être désignée comme enquêtrice du signalement.
    await env.req('POST', `/v1/integrite/reports/${reference}/qualify`, ENQ, { category: 'DEMANDE_ESPECES', severity: 'MOYENNE', receivable: true, note: 'Recevable.' });
    const a = await env.req('POST', `/v1/integrite/reports/${reference}/assign`, ENQ, { investigatorId: CHEF });
    expect(a.statusCode).toBe(403);
    expect(a.json().code).toBe('CONFLICT_OF_INTEREST');
  });

  it('refus d’accès : agent de terrain, contribuable, public sans compte', async () => {
    const env = await setupIntegrite();
    expect((await env.req('GET', '/v1/integrite/reports', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/integrite/reports', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/integrite/reports')).statusCode).toBe(401);
    // L'auditeur lit, mais ne qualifie pas.
    expect((await env.req('GET', '/v1/integrite/reports', 'u-auditeur')).statusCode).toBe(200);
    const { reference } = await newAnonymousReport(env);
    const q = await env.req('POST', `/v1/integrite/reports/${reference}/qualify`, 'u-auditeur', { category: 'AUTRE', severity: 'FAIBLE', receivable: true, note: 'Tentative.' });
    expect(q.statusCode).toBe(403);
  });

  it('opératrice de ligne (guichet) enregistre un appel au numéro gratuit, sans pouvoir qualifier', async () => {
    const env = await setupIntegrite();
    const r = await env.req('POST', '/v1/integrite/reports/intake', 'integrite-u-operatrice', {
      channel: 'NUMERO_GRATUIT', category: 'POINT_PAIEMENT_IRREGULIER', anonymous: true, description: 'Appelant : point de paiement qui refuse la référence.',
    });
    expect(r.statusCode).toBe(201);
    expect(env.svc.reports.get(r.json().reference)!.channel).toBe('NUMERO_GRATUIT');
    const q = await env.req('POST', `/v1/integrite/reports/${r.json().reference}/qualify`, 'integrite-u-operatrice', { category: 'AUTRE', severity: 'FAIBLE', receivable: true, note: 'Tentative.' });
    expect(q.statusCode).toBe(403);
  });

  it('signalement irrecevable : clos avec message d’orientation au signalant', async () => {
    const env = await setupIntegrite();
    const { reference, trackingCode } = await newAnonymousReport(env, { category: 'AUTRE', target: undefined });
    const q = await env.req('POST', `/v1/integrite/reports/${reference}/qualify`, ENQ, { category: 'AUTRE', severity: 'FAIBLE', receivable: false, note: 'Contestation de montant : relève de la réclamation.' });
    expect(q.json().status).toBe('CLOS');
    const t = (await env.req('POST', '/v1/public/integrite/reports/track', undefined, { code: trackingCode })).json();
    expect(t.outcome.code).toBe('IRRECEVABLE');
  });
});

describe('Détection — alertes à examiner, jamais de sanction', () => {
  it('signaux explicables : lieux éloignés, paiements fractionnés, agent visé plusieurs fois', async () => {
    const env = await setupIntegrite();
    const alerts = (await env.req('GET', '/v1/integrite/alerts', ENQ)).json() as { ruleCode: string; automaticEffect: string; variables: unknown[] }[];
    const codes = alerts.map((a) => a.ruleCode);
    expect(codes).toContain('QUITTANCE_LIEUX_ELOIGNES');
    expect(codes).toContain('PAIEMENTS_FRACTIONNES');
    expect(codes).toContain('AGENT_SIGNALEMENTS_MULTIPLES');
    expect(codes).toContain('CONTROLE_MYSTERE_NON_CONFORME');
    for (const a of alerts) {
      expect(a.automaticEffect).toBe('AUCUN');
      expect(a.variables.length).toBeGreaterThan(0);
    }
    // Rejeu : relancer la détection ne duplique pas les alertes ouvertes.
    const again = await env.req('POST', '/v1/integrite/detection/run', ENQ);
    expect(again.statusCode).toBe(200);
    expect(again.json().raised).toBe(0);
  });

  it('observations entrantes : nouvelle quittance vérifiée à 30 km en 20 min → une alerte', async () => {
    const env = await setupIntegrite();
    const t0 = env.clock.now().getTime();
    const obs = await env.req('POST', '/v1/integrite/observations', ENQ, { observations: [
      { type: 'VERIFICATION_QUITTANCE', at: new Date(t0 - 20 * 60_000).toISOString(), source: 'test', receiptRef: 'Q-TEST', lat: -4.30, lon: 15.30, commune: 'Gombe' },
      { type: 'VERIFICATION_QUITTANCE', at: new Date(t0).toISOString(), source: 'test', receiptRef: 'Q-TEST', lat: -4.38, lon: 15.55, commune: 'Masina' },
    ] });
    expect(obs.statusCode).toBe(201);
    const run = (await env.req('POST', '/v1/integrite/detection/run', ENQ)).json();
    expect(run.raised).toBe(1);
    expect(run.alerts[0].subjects[0]).toEqual({ kind: 'QUITTANCE', ref: 'Q-TEST' });
    expect((await env.req('POST', '/v1/integrite/observations', 'u-agent-terrain', { observations: [{ type: 'PAIEMENT_POINT', at: new Date(t0).toISOString(), source: 'x' }] })).statusCode).toBe(403);
  });

  it('agent au taux anormal de non-conformité : alerte produite, aucune suspension ni sanction', async () => {
    const env = await setupIntegrite();
    for (const d of ['2026-09-24', '2026-09-25']) {
      const m = (await env.req('POST', '/v1/integrite/mystery-checks', 'u-auditeur', { programme: 'Test', targetKind: 'AGENT', targetRef: 'u-agent-gombe', commune: 'Gombe', scenario: 'Proposer des espèces à l’agent.', plannedFor: d, controllerId: 'u-auditeur' })).json();
      await env.req('POST', `/v1/integrite/mystery-checks/${m.id}/result`, 'u-auditeur', { outcome: 'NON_CONFORME', cashRequested: true, officialAmountShown: null, receiptIssued: false, observations: 'Espèces acceptées.' });
    }
    const run = (await env.req('POST', '/v1/integrite/detection/run', CHEF)).json();
    expect(run.alerts.map((a: { ruleCode: string }) => a.ruleCode)).toContain('TAUX_NON_CONFORMITE');
    expect(run.automaticEffect).toBe('AUCUN');
    // L'agent reste pleinement actif : aucun effet sur l'annuaire.
    expect(env.app.ctx.users.get('u-agent-gombe')!.roles).toEqual(['R10']);
  });

  it('clôture d’alerte : proposée par l’enquêteur, validée par un responsable DISTINCT', async () => {
    const env = await setupIntegrite();
    const alert = env.svc.alerts.find((a) => a.ruleCode === 'QUITTANCE_LIEUX_ELOIGNES')[0]!;
    expect((await env.req('POST', `/v1/integrite/alerts/${alert.id}/examine`, ENQ, {})).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/integrite/alerts/${alert.id}/propose-closure`, ENQ, { reason: 'Double vérification par un contrôleur itinérant, légitime.' })).statusCode).toBe(200);
    const self = await env.req('POST', `/v1/integrite/alerts/${alert.id}/validate-closure`, ENQ, { approve: true, reason: 'Je valide.' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const ok = await env.req('POST', `/v1/integrite/alerts/${alert.id}/validate-closure`, 'u-rssi', { approve: true, reason: 'Explication vérifiée.' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('CLASSEE');
  });

  it('garde de l’IA : un agent d’IA ne clôt, ne qualifie ni ne décide rien', () => {
    return setupIntegrite().then((env) => {
      const ai = { kind: 'ai' as const, id: 'ia-fraude', agent: 'detection-fraude' };
      const alert = env.svc.alerts.all()[0]!;
      expect(() => env.svc.validateAlertClosure(ai, alert.id, { approve: true, reason: 'auto' })).toThrow(/IA|recommandation/);
      const caseId = env.svc.cases.all()[0]!.id;
      expect(() => env.svc.decide(ai, caseId, { decision: 'SUSPENSION_CONSERVATOIRE_ACCES', reason: 'Décision automatique interdite par la doctrine.' })).toThrow(/IA|recommandation/);
      const rep = env.svc.reports.all()[0]!;
      expect(() => env.svc.qualify(ai, rep.id, { category: 'AUTRE', severity: 'FAIBLE', receivable: true, note: 'auto' })).toThrow();
    });
  });
});

describe('Dossiers d’enquête — séparation enquêteur / décideur', () => {
  it('pièces par empreinte, chronologie, conclusions puis décision motivée par une personne distincte', async () => {
    const env = await setupIntegrite();
    const alertId = env.svc.alerts.find((a) => a.ruleCode === 'PAIEMENTS_FRACTIONNES')[0]!.id;
    const open = await env.req('POST', '/v1/integrite/cases', ENQ, { title: 'Fractionnement au point PPA-DEMO-014', reason: 'Trois paiements en moins d’une heure.', alertIds: [alertId] });
    expect(open.statusCode).toBe(201);
    const id = open.json().id as string;
    expect(env.svc.alerts.get(alertId)!.status).toBe('DOSSIER_OUVERT');

    expect((await env.req('POST', `/v1/integrite/cases/${id}/evidence`, ENQ, { sha256: h('releve'), label: 'Relevé du point' })).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/integrite/cases/${id}/evidence`, ENQ, { sha256: h('releve'), label: 'Doublon' })).statusCode).toBe(409);
    // Un autre enquêteur ne peut pas instruire ce dossier.
    expect((await env.req('POST', `/v1/integrite/cases/${id}/notes`, CHEF, { kind: 'NOTE', text: 'Intrusion.' })).statusCode).toBe(403);
    await env.req('POST', `/v1/integrite/cases/${id}/notes`, ENQ, { kind: 'DEMANDE_PIECES', text: 'Demande du journal du terminal au prestataire.' });
    // Décision avant conclusions : refusée.
    expect((await env.req('POST', `/v1/integrite/cases/${id}/decision`, 'u-decideur', { decision: 'CLASSEMENT_SANS_SUITE', reason: 'Trop tôt pour décider de quoi que ce soit.' })).statusCode).toBe(409);
    await env.req('POST', `/v1/integrite/cases/${id}/conclusions`, ENQ, { finding: 'INSUFFISANT', summary: 'Les paiements correspondent à trois échéances légitimes.', recommendation: 'CLASSEMENT_SANS_SUITE' });
    // L'enquêteur n'a pas le droit de décider ; motif trop court refusé.
    expect((await env.req('POST', `/v1/integrite/cases/${id}/decision`, ENQ, { decision: 'CLASSEMENT_SANS_SUITE', reason: 'Je classe mon propre dossier.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/integrite/cases/${id}/decision`, 'u-decideur', { decision: 'CLASSEMENT_SANS_SUITE', reason: 'Court.' })).statusCode).toBe(400);
    const dec = await env.req('POST', `/v1/integrite/cases/${id}/decision`, 'u-dg-dgipk', { decision: 'CLASSEMENT_SANS_SUITE', reason: 'Échéances légitimes, justificatifs concordants versés au dossier.' });
    expect(dec.statusCode).toBe(200);
    const c = dec.json();
    expect(c.status).toBe('DECIDE');
    expect(c.timeline.map((e: { kind: string }) => e.kind)).toEqual(['OUVERTURE', 'PIECE', 'DEMANDE_PIECES', 'CONCLUSIONS', 'DECISION']);
    expect(c.auditTrail.length).toBeGreaterThanOrEqual(4);
    // Plus aucune pièce après décision.
    expect((await env.req('POST', `/v1/integrite/cases/${id}/evidence`, ENQ, { sha256: h('tard'), label: 'Pièce tardive' })).statusCode).toBe(409);
  });

  it('personne mise en cause : aucun accès au dossier ; l’enquêteur ne peut être mis en cause dans son dossier', async () => {
    const env = await setupIntegrite();
    const open = (await env.req('POST', '/v1/integrite/cases', ENQ, { title: 'Dossier test', reason: 'Ouverture pour test de protection.' })).json();
    await env.req('POST', `/v1/integrite/cases/${open.id}/links`, ENQ, { kind: 'AGENT', ref: 'u-decideur', implicated: true });
    const r = await env.req('GET', `/v1/integrite/cases/${open.id}`, 'u-decideur');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('IMPLICATED_PERSON');
    expect((await env.req('POST', `/v1/integrite/cases/${open.id}/links`, ENQ, { kind: 'AGENT', ref: ENQ, implicated: true })).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/integrite/cases', 'u-agent-terrain')).statusCode).toBe(403);
  });
});

describe('Contrôles mystère', () => {
  it('planification, résultat par le contrôleur désigné, suite (dossier), publication agrégée sans nom', async () => {
    const env = await setupIntegrite();
    const m = await env.req('POST', '/v1/integrite/mystery-checks', 'u-auditeur', {
      programme: 'Programme test', targetKind: 'POINT_PAIEMENT', targetRef: 'PPA-TEST-1', commune: 'Kalamu', scenario: 'Payer sur référence, vérifier la preuve.', plannedFor: '2026-10-01', controllerId: ENQ,
    });
    expect(m.statusCode).toBe(201);
    const id = m.json().id as string;
    expect((await env.req('POST', `/v1/integrite/mystery-checks/${id}/result`, 'u-auditeur', { outcome: 'CONFORME', cashRequested: false, officialAmountShown: true, receiptIssued: true, observations: 'Rien à signaler.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/integrite/mystery-checks/${id}/result`, ENQ, { outcome: 'CONFORME', cashRequested: true, officialAmountShown: true, receiptIssued: true, observations: 'Incohérent.' })).statusCode).toBe(422);
    const res = await env.req('POST', `/v1/integrite/mystery-checks/${id}/result`, ENQ, { outcome: 'NON_CONFORME', cashRequested: true, officialAmountShown: false, receiptIssued: false, observations: 'Espèces demandées au comptoir.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().alertId).toBeTruthy();
    const f = await env.req('POST', `/v1/integrite/mystery-checks/${id}/follow-up`, ENQ, { action: 'OUVRIR_DOSSIER', note: 'Instruction nécessaire, demande d’espèces.' });
    expect(f.statusCode).toBe(200);
    expect(f.json().followUp.caseId).toMatch(/^DOS-/);

    const pub = await env.req('GET', '/v1/public/integrite/summary');
    expect(pub.statusCode).toBe(200);
    const s = JSON.stringify(pub.json());
    expect(s).not.toContain('PPA-TEST-1');
    expect(s).not.toContain('u-agent');
    expect(pub.json().controlesMystere.byTarget.find((x: { targetKind: string }) => x.targetKind === 'POINT_PAIEMENT').realises).toBeGreaterThanOrEqual(2);
  });

  it('un contrôleur ne peut pas être la cible ; agent de terrain refusé', async () => {
    const env = await setupIntegrite();
    const r = await env.req('POST', '/v1/integrite/mystery-checks', 'u-auditeur', { programme: 'Programme test', targetKind: 'AGENT', targetRef: ENQ, commune: 'Gombe', scenario: 'Scénario de test valable.', plannedFor: '2026-10-01', controllerId: ENQ });
    expect(r.statusCode).toBe(403);
    expect((await env.req('GET', '/v1/integrite/mystery-checks', 'u-agent-terrain')).statusCode).toBe(403);
  });
});

describe('Incidents de sécurité', () => {
  it('déclaration, propriétaire, cycle, DPO obligatoire si données personnelles, clôture avec preuve', async () => {
    const env = await setupIntegrite();
    const d = await env.req('POST', '/v1/integrite/incidents', 'u-guichet', { title: 'Poste de guichet compromis', description: 'Logiciel inconnu détecté sur le poste.', category: 'COMPROMISSION_APPAREIL', severity: 'CRITIQUE', personalDataImpacted: true, affectedTaxpayerIds: [DEMO.taxpayerId] });
    expect(d.statusCode).toBe(201);
    const id = d.json().id as string;
    expect(new Date(d.json().dueAt).getTime() - env.clock.now().getTime()).toBe(24 * 3_600_000);
    expect((await env.req('GET', '/v1/integrite/incidents', 'u-guichet')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/integrite/incidents/${id}/status`, 'u-rssi', { status: 'EN_COURS', note: 'Analyse.' })).statusCode).toBe(409);
    await env.req('POST', `/v1/integrite/incidents/${id}/assign`, 'u-rssi', { ownerId: 'integrite-u-ingenieur' });
    for (const s of ['EN_COURS', 'CONTENU', 'RESOLU']) expect((await env.req('POST', `/v1/integrite/incidents/${id}/status`, 'integrite-u-ingenieur', { status: s, note: `Passage ${s}.` })).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/integrite/incidents/${id}/status`, 'integrite-u-ingenieur', { status: 'CONTENU', note: 'Retour arrière.' })).statusCode).toBe(409);
    env.clock.advanceHours(30);
    expect((await env.req('GET', '/v1/integrite/incidents', 'u-rssi')).json().find((i: { id: string }) => i.id === id).overdue).toBe(true);
    const noDpo = await env.req('POST', `/v1/integrite/incidents/${id}/close`, 'u-rssi', { proofSha256: h('rapport'), summary: 'Poste réinstallé, clés révoquées.' });
    expect(noDpo.json().code).toBe('DPO_NOT_NOTIFIED');
    // Seul le DPO informe les personnes concernées.
    expect((await env.req('POST', `/v1/integrite/incidents/${id}/notifications`, 'u-rssi', { target: 'PERSONNES_CONCERNEES', note: 'Info.' })).statusCode).toBe(403);
    await env.req('POST', `/v1/integrite/incidents/${id}/notifications`, 'u-rssi', { target: 'DPO', note: 'Information du DPO.' });
    const pers = await env.req('POST', `/v1/integrite/incidents/${id}/notifications`, DPO, { target: 'PERSONNES_CONCERNEES', note: 'Notification décidée par le DPO.' });
    expect(pers.statusCode).toBe(200);
    expect(pers.json().notifications.at(-1).deliveries).toBeGreaterThan(0);
    const closed = await env.req('POST', `/v1/integrite/incidents/${id}/close`, 'u-rssi', { proofSha256: h('rapport'), summary: 'Poste réinstallé, clés révoquées.' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('CLOS');
  });
});

describe('Protection des données', () => {
  it('demande d’accès : dépôt par la personne, export par le DPO, lecture réservée', async () => {
    const env = await setupIntegrite();
    const sub = await env.req('POST', '/v1/integrite/privacy/requests', 'u-contribuable', { taxpayerId: DEMO.taxpayerId, type: 'ACCES', details: 'Mes données, svp.' });
    expect(sub.statusCode).toBe(201);
    expect((await env.req('POST', '/v1/integrite/privacy/requests', 'u-contribuable', { taxpayerId: DEMO.tenantTaxpayerId, type: 'ACCES', details: 'Données d’un tiers.' })).statusCode).toBe(403);
    const id = sub.json().id as string;
    expect((await env.req('POST', `/v1/integrite/privacy/requests/${id}/respond`, 'u-contribuable', { decision: 'ACCEPTEE', note: 'Moi-même.' })).statusCode).toBe(403);
    await env.req('POST', `/v1/integrite/privacy/requests/${id}/take`, DPO);
    const resp = await env.req('POST', `/v1/integrite/privacy/requests/${id}/respond`, DPO, { decision: 'ACCEPTEE', note: 'Export établi.' });
    expect(resp.json().exportReady).toBe(true);
    const exp = await env.req('GET', `/v1/integrite/privacy/requests/${id}/export`, 'u-contribuable');
    expect(exp.statusCode).toBe(200);
    expect(exp.json().profile.id).toBe(DEMO.taxpayerId);
    expect((await env.req('GET', `/v1/integrite/privacy/requests/${id}/export`, 'u-locataire')).statusCode).toBe(403);
    const mine = (await env.req('GET', '/v1/integrite/privacy/requests', 'u-contribuable')).json() as { taxpayerId: string }[];
    expect(mine.every((r) => r.taxpayerId === DEMO.taxpayerId)).toBe(true);
  });

  it('rectification acceptée : donnée rectifiée, journalisée par empreintes, notifiée', async () => {
    const env = await setupIntegrite();
    const req = env.svc.privacyRequests.find((r) => r.type === 'RECTIFICATION')[0]!;
    const r = await env.req('POST', `/v1/integrite/privacy/requests/${req.id}/respond`, DPO, { decision: 'ACCEPTEE', note: 'Pièce d’identité vérifiée au guichet.' });
    expect(r.statusCode).toBe(200);
    expect(env.app.ctx.taxpayers.get(DEMO.tenantTaxpayerId).fullName).toBe('Nzuzi Makiese Mbala');
    const ev = env.app.ctx.audit.list({ action: 'integrite.privacy.rectified' }).items[0]!;
    expect(JSON.stringify(ev.details)).not.toContain('Nzuzi');
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'privacy.rectification.done').length).toBeGreaterThan(0);
  });

  it('registre des traitements versionné (l’ancienne version est conservée) ; écriture réservée au DPO', async () => {
    const env = await setupIntegrite();
    const reg = (await env.req('GET', '/v1/integrite/privacy/registry', DPO)).json() as Record<string, unknown>[];
    expect(reg.length).toBeGreaterThanOrEqual(7);
    const first = reg[0]!;
    const upd = await env.req('POST', '/v1/integrite/privacy/registry', DPO, { ...Object.fromEntries(Object.entries(first).filter(([k]) => !['version', 'updatedAt', 'updatedBy'].includes(k))), retention: 'Durée fixée par l’arrêté X (exemple)' });
    expect(upd.statusCode).toBe(201);
    expect(upd.json().version).toBe(2);
    const hist = (await env.req('GET', `/v1/integrite/privacy/registry/${first.id}/history`, 'u-auditeur')).json();
    expect(hist).toHaveLength(2);
    expect((await env.req('POST', '/v1/integrite/privacy/registry', 'u-rssi', { name: 'x', purpose: 'Finalité de test', legalBasis: 'x', dataCategories: [], dataSubjects: [], recipients: [], retention: 'x', security: [], module: 'x', sensitive: false })).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/integrite/privacy/access-log', DPO)).statusCode).toBe(200);
  });
});

describe('Revue périodique des accès', () => {
  it('campagne : responsable distinct, périmètre de l’entité, retrait tracé, clôture complète exigée', async () => {
    const env = await setupIntegrite();
    const camp = (await env.req('GET', '/v1/integrite/access-reviews', 'u-rssi')).json()[0];
    expect(camp.status).toBe('OUVERTE');
    const own = camp.items.find((i: { userId: string }) => i.userId === 'u-rssi');
    const self = await env.req('POST', `/v1/integrite/access-reviews/${camp.id}/items/${own.id}/decision`, 'u-rssi', { decision: 'MAINTENU', reason: 'Moi.' });
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    // L'administrateur d'entité Trésor ne voit et ne revoit que son entité.
    const adminView = (await env.req('GET', '/v1/integrite/access-reviews', 'integrite-u-admin-tresor')).json()[0];
    expect(adminView.items.every((i: { entity: string }) => i.entity === 'TRESOR')).toBe(true);
    const dgi = camp.items.find((i: { userId: string }) => i.userId === 'u-dg-dgipk');
    expect((await env.req('POST', `/v1/integrite/access-reviews/${camp.id}/items/${dgi.id}/decision`, 'integrite-u-admin-tresor', { decision: 'MAINTENU', reason: 'ok' })).statusCode).toBe(403);
    const tres = camp.items.find((i: { userId: string }) => i.userId === 'u-coffre-3');
    expect((await env.req('POST', `/v1/integrite/access-reviews/${camp.id}/items/${tres.id}/decision`, 'integrite-u-admin-tresor', { decision: 'RETRAIT_A_EXECUTER', reason: 'Mutation hors du Trésor.' })).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/integrite/access-reviews/${camp.id}/close`, 'u-rssi')).json().code).toBe('REVIEW_INCOMPLETE');
    env.app.ctx.users.add({ id: 'test-admin-plateforme', name: 'Admin plateforme (test)', roles: ['R08'], entity: 'PLATEFORME' });
    for (const i of camp.items) {
      if (i.id === tres.id) continue;
      const by = i.userId === 'u-rssi' ? 'test-admin-plateforme' : 'u-rssi';
      const r = await env.req('POST', `/v1/integrite/access-reviews/${camp.id}/items/${i.id}/decision`, by, { decision: 'MAINTENU', reason: 'Accès justifié.' });
      expect(r.statusCode).toBe(200);
    }
    const closed = await env.req('POST', `/v1/integrite/access-reviews/${camp.id}/close`, 'u-rssi');
    expect(closed.statusCode).toBe(200);
    expect(closed.json().removals).toEqual([{ userId: 'u-coffre-3', role: 'R19', reason: 'Mutation hors du Trésor.' }]);
    // Le retrait est une décision tracée ; l'exécution relève de l'administrateur de l'annuaire.
    expect(env.app.ctx.users.get('u-coffre-3')!.roles).toEqual(['R19']);
  });
});

describe('Indicateurs agrégés', () => {
  it('gouverneur : agrégats seulement ; agent de terrain refusé', async () => {
    const env = await setupIntegrite();
    const r = await env.req('GET', '/v1/integrite/indicators', 'u-gouverneur');
    expect(r.statusCode).toBe(200);
    expect(r.json().signalements.total).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(r.json())).not.toContain('u-agent-terrain');
    expect((await env.req('GET', '/v1/integrite/indicators', 'u-agent-terrain')).statusCode).toBe(403);
    // Chaque refus d'accès est journalisé par le socle.
    expect(env.app.ctx.audit.list({ action: 'access.denied' }).total).toBeGreaterThan(0);
  });
});
