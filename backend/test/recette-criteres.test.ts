/**
 * Recette — critères d'acceptation du Document maître FR 2 (ch. 42), un test par critère, plus deux tests de la
 * stratégie de tests (ch. 45 : paiement de bout en bout avec échec, doublon et rappel frauduleux ; élévation de
 * privilèges). Les titres sont repris par le référentiel du programme (backend/src/plugins/pilotage/programme/
 * referentiels.ts) et vérifiés par test/programme.test.ts : ne pas les renommer sans mettre le référentiel à jour.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { accesPlugin } from '../src/plugins/acces/plugin.js';
import { pilotagePlugin } from '../src/plugins/pilotage/plugin.js';
import { terrainPlugin } from '../src/plugins/terrain/plugin.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { postStatement, callbackBody, createOrder, DEMO, demoObligationId, payDemoObligation, PROVIDER_SECRET, publishCertifiedRule, setup, signedCallback, type TestEnv } from './helpers.js';

async function withPlugins(plugins: MosoloPlugin<unknown>[]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }),
  };
}

const calculate = (env: TestEnv, ruleId: string) => env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
  ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '100' }, simulate: false,
});

describe('Recette — critères d’acceptation du ch. 42', () => {
  it('C42-01 — aucune obligation sans règle publiée portant une référence légale valide (test négatif)', async () => {
    const env = await setup();
    const before = env.app.ctx.assessment.obligations.count();
    // 1. Fiche au statut À VÉRIFIER (non publiée) : refus, journalisé.
    const a = await calculate(env, 'rule-if-pp-bati-v1');
    expect(a.statusCode).toBe(422);
    expect(a.json().code).toBe('RULE_NOT_EXECUTABLE');
    // 2. Fiche citant l'OL 13/001 (abrogée) : publication impossible, donc aucune liquidation.
    const abrogated = await publishCertifiedRule(env, { code: 'RECETTE-OL13', legalInstrumentIds: ['ol-13-001'] });
    expect(abrogated.responses.at(-1)!.json().code).toBe('ABROGATED_INSTRUMENT');
    expect(env.app.ctx.rules.rules.get(abrogated.id)!.status).not.toBe('PUBLIEE');
    expect((await calculate(env, abrogated.id)).json().code).toBe('RULE_NOT_EXECUTABLE');
    // 3. Fiche citant un texte non certifié en vigueur (arrêté À VÉRIFIER) : publication bloquée.
    const unverified = await publishCertifiedRule(env, { code: 'RECETTE-A-VERIFIER', legalInstrumentIds: ['arrete-taux-if-2026'] });
    expect(unverified.responses.at(-1)!.json().code).toBe('INSTRUMENT_NOT_IN_FORCE');
    expect((await calculate(env, unverified.id)).statusCode).toBe(422);
    // 4. Fiche sans référence légale, ou citant un texte inconnu : refusée dès la création.
    expect((await publishCertifiedRule(env, { code: 'RECETTE-SANS-TEXTE', legalInstrumentIds: [] }, 0)).create.statusCode).toBe(400);
    expect((await publishCertifiedRule(env, { code: 'RECETTE-INCONNU', legalInstrumentIds: ['texte-inexistant'] }, 0)).create.json().code).toBe('UNKNOWN_LEGAL_INSTRUMENT');
    // Aucune obligation créée ; chaque refus de liquidation est journalisé.
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
    expect(env.app.ctx.audit.list({ action: 'assessment.liquidation.refused' }).total).toBeGreaterThanOrEqual(3);
    // Contre-épreuve : la même fiche, citant un texte en vigueur et publiée par quatre personnes, liquide.
    const ok = await publishCertifiedRule(env, { code: 'RECETTE-VALIDE' });
    expect(ok.responses.at(-1)!.json().status).toMatch(/^(PUBLIEE|ACTIVE)$/);
    // (entrées lues sur la fiche de l'objet : aucune assiette saisie)
    const liq = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId: ok.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false });
    expect(liq.statusCode).toBe(201);
    expect(env.app.ctx.assessment.obligations.count()).toBe(before + 1);
  });

  it('C42-02 — aucune quittance sans confirmation serveur à serveur d’un prestataire agréé', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    const receipts = () => env.app.ctx.receipts.receipts.count();
    const before = receipts();
    const raw = JSON.stringify(callbackBody(env, order.paymentReference));
    // Prestataire inconnu (non agréé) : refus.
    const unknown = await env.app.inject({ method: 'POST', url: '/v1/providers/prestataire-non-agree/callbacks', payload: raw, headers: { 'content-type': 'application/json' } });
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
    // Rappel sans signature, ou signé avec une autre clé : refus et alerte.
    const unsigned = await env.app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw, headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBeGreaterThanOrEqual(400);
    const forged = await signedCallback(env, JSON.parse(raw), { secret: 'cle-de-quelqu-un-d-autre' });
    expect(forged.statusCode).toBeGreaterThanOrEqual(400);
    // Aucune route ne permet de créer une quittance depuis le client (capture d'écran, déclaration de paiement).
    expect((await env.req('POST', '/v1/receipts', 'u-contribuable', { paymentReference: order.paymentReference })).statusCode).toBeGreaterThanOrEqual(400);
    expect(receipts()).toBe(before);
    expect(env.app.ctx.receipts.byPaymentOrder(order.paymentOrderId)).toBeUndefined();
    // Seule la confirmation signée du prestataire agréé produit la quittance.
    const ok = await signedCallback(env, JSON.parse(raw));
    expect(ok.json().status).toBe('CONFIRME');
    expect(env.app.ctx.receipts.byPaymentOrder(order.paymentOrderId)).toBeDefined();
  });

  it('C42-03 — aucun compte bénéficiaire modifié par un seul utilisateur, quel que soit son rôle', async () => {
    const env = await setup();
    const proposal = { alias: DEMO.dgipkAlias, bankName: 'Banque de recettes (recette)', accountNumber: 'CD00 9999 8888 7777 6666 5555', holderName: 'DGIPK — compte de recette (démo)', reason: 'Recette du critère C42-03' };
    const before = env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber;
    // Aucun rôle, pas même le super-administrateur, ne modifie seul ; le proposant n'approuve pas.
    for (const u of ['u-superadmin', 'u-gouverneur', 'u-ministre-finances']) expect((await env.req('POST', '/v1/beneficiary-accounts/change-requests', u, proposal)).statusCode).toBe(403);
    const id = (await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal)).json().id as string;
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-tresor', { outOfBandVerified: true })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: true })).json().status).toBe('EN_ATTENTE_APPROBATION');
    // Une seule approbation (même répétée par la même personne) ne suffit jamais.
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: true })).json().code).toBe('SEPARATION_OF_DUTIES');
    env.clock.advanceHours(100);
    expect(env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber).toBe(before);
    // Aucune route de modification directe du compte.
    expect((await env.req('PUT', `/v1/beneficiary-accounts/${DEMO.dgipkAlias}`, 'u-superadmin', proposal)).statusCode).toBeGreaterThanOrEqual(400);
    expect(env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber).toBe(before);
  });

  it('C42-04 — aucun événement d’audit modifié ou supprimé, même par le super-administrateur (test d’altération)', async () => {
    const env = await setup();
    await payDemoObligation(env);
    const first = env.app.ctx.audit.list({ limit: 1 }).items[0]!;
    const total = env.app.ctx.audit.verify().length;
    // Par l'API : suppression et modification refusées (405), tentative elle-même journalisée, pour tout rôle.
    for (const user of ['u-superadmin', 'u-auditeur', 'u-gouverneur']) {
      for (const method of ['DELETE', 'PUT', 'PATCH']) {
        const r = await env.req(method, `/v1/audit/events/${first.id}`, user, method === 'DELETE' ? undefined : { action: 'falsifie' });
        expect(r.statusCode).toBe(405);
        expect(r.json().code).toBe('AUDIT_APPEND_ONLY');
      }
    }
    const attempts = env.app.ctx.audit.list({ action: 'audit.tamper.attempt' });
    expect(attempts.total).toBe(9);
    expect(attempts.items.some((x) => x.actor.id === 'u-superadmin' && x.outcome === 'DENIED')).toBe(true);
    // Le super-administrateur ne lit même pas le journal ; le service n'expose aucune méthode d'effacement.
    env.app.ctx.users.add({ id: 'test-admin-technique', name: 'Administrateur technique (test, R26 seul)', roles: ['R26'], entity: 'PLATEFORME' });
    expect((await env.req('GET', '/v1/audit/events', 'test-admin-technique')).statusCode).toBe(403);
    const auditApi = env.app.ctx.audit as unknown as Record<string, unknown>;
    for (const m of ['delete', 'remove', 'update', 'truncate', 'clear']) expect(auditApi[m]).toBeUndefined();
    expect(env.app.ctx.audit.verify()).toMatchObject({ ok: true });
    // Les tentatives (et le refus de lecture) s'ajoutent au journal ; rien n'en est retiré.
    expect(env.app.ctx.audit.verify().length).toBeGreaterThanOrEqual(total + 9);
    // Altération « en base » (contournant l'API) : détectée par la vérification de la chaîne.
    const raw = env.app.ctx.audit.unsafeRawStorageForTamperTests();
    raw[1]!.details = { ...raw[1]!.details, modifiePar: 'u-superadmin' };
    expect(env.app.ctx.audit.verify().ok).toBe(false);
    expect((await env.req('GET', '/v1/audit/verify', 'u-auditeur')).json()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('C42-05 — toute consultation d’un dossier individuel est journalisée avec acteur, motif et horodatage', async () => {
    const env = await withPlugins([accesPlugin as MosoloPlugin<unknown>]);
    // Lecture directe du dossier par un agent dans son périmètre, avec motif déclaré.
    const r = await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-controleur', undefined, { 'x-motif-consultation': encodeURIComponent('Vérification d’une déclaration IRL (recette)') });
    expect(r.statusCode).toBe(200);
    const viewed = env.app.ctx.audit.list({ action: 'taxpayer.viewed' }).items.at(-1)!;
    expect(viewed).toMatchObject({ actor: { kind: 'user', id: 'u-controleur' }, resourceId: DEMO.taxpayerId, details: { motif: 'Vérification d’une déclaration IRL (recette)', motifDeclare: true } });
    expect(Date.parse(viewed.at)).toBe(env.clock.now().getTime());
    // Sans motif déclaré : la finalité du rôle est enregistrée (jamais un motif vide).
    await env.req('GET', `/v1/obligations/${demoObligationId(env)}`, 'u-controleur');
    const ob = env.app.ctx.audit.list({ action: 'obligation.viewed' }).items.at(-1)!;
    expect(ob.details).toMatchObject({ motifDeclare: false, motif: expect.stringMatching(/Finalité du rôle \(R11\)/) });
    // Consultation motivée du module d'accès (finalité + motif), puis lecture du dossier : deux enregistrements datés.
    const c = await env.req('POST', '/v1/acces/consultations', 'u-controleur', { taxpayerId: DEMO.taxpayerId, purpose: 'CONTROLE', motif: 'Contrôle sur pièces de la parcelle (recette)' });
    expect(c.statusCode).toBe(201);
    await env.req('GET', `/v1/acces/consultations/${c.json().id}/dossier`, 'u-controleur');
    const motivated = env.app.ctx.audit.list({ action: c.json().mode === 'PERIMETRE' ? 'acces.consultation.motivated' : 'acces.consultation.break_glass' }).items.at(-1)!;
    expect(motivated).toMatchObject({ actor: { id: 'u-controleur' }, details: { motif: 'Contrôle sur pièces de la parcelle (recette)', purpose: 'CONTROLE' } });
    const read = env.app.ctx.audit.list({ action: 'acces.consultation.read' }).items.at(-1)!;
    expect(read).toMatchObject({ actor: { id: 'u-controleur' }, details: { consultationId: c.json().id } });
    expect(read.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('C42-06 — journée complète hors réseau : constats capturés toute la journée, synchronisés sans perte ni doublon', async () => {
    const env = await withPlugins([terrainPlugin as MosoloPlugin<unknown>]);
    const obj = env.app.ctx.objects.objects.get('OBJ-DEMO-UNITE-01')!;
    // Fin de journée : l'agent retrouve le réseau à 18 h 30 (heure de Kinshasa) après une mission commencée à 8 h.
    env.clock.set('2026-09-26T17:30:00.000Z');
    const captures = Array.from({ length: 12 }, (_, i) => {
      const at = new Date(Date.parse('2026-09-26T07:00:00.000Z') + i * 50 * 60_000).toISOString();
      return i % 3 === 2
        ? { clientRef: `jour-${i}`, outcome: 'OBJET_NON_ENREGISTRE', category: 'ACTIVITE', observations: `Commerce non enregistré n° ${i} (recette)`, gps: { lat: obj.lat, lon: obj.lon, accuracyM: 8 }, photoSha256: String(i % 10).repeat(64), capturedAt: at, deviceId: 'dev-terrain-001' }
        : { clientRef: `jour-${i}`, objectId: obj.id, outcome: 'CONSTATE', observations: `Passage n° ${i} (recette)`, gps: { lat: obj.lat, lon: obj.lon, accuracyM: 6 }, photoSha256: String(i % 10).repeat(64), capturedAt: at, deviceId: 'dev-terrain-001' };
    });
    const svc = env.app.ctx.ext.terrain as { findings: { find(p: (f: { agentId: string; clientRef: string }) => boolean): unknown[] } };
    const mine = () => svc.findings.find((f) => f.agentId === 'u-agent-terrain' && f.clientRef.startsWith('jour-')).length;
    const obligations = env.app.ctx.assessment.obligations.count();
    for (const c of captures) expect((await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', c)).statusCode).toBe(201);
    expect(mine()).toBe(12);
    // Coupure pendant la synchronisation : l'application renvoie toute la file ; aucun doublon, aucune perte.
    for (const c of captures) {
      const r = await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', c);
      expect(r.statusCode).toBe(200);
      expect(r.json().replayed).toBe(true);
      expect(r.json().finding.capturedAt).toBe(c.capturedAt);
    }
    expect(mine()).toBe(12);
    // Aucun effet fiscal : un constat n'est jamais une dette.
    expect(env.app.ctx.assessment.obligations.count()).toBe(obligations);
  });

  it('C42-07 — le rapprochement quotidien produit des files d’exception exploitables et traçables', async () => {
    const env = await setup();
    const { order } = await payDemoObligation(env);
    const st = await postStatement(env, 'u-tresor', {
      statementId: 'REL-RECETTE-C42-07', lines: [
        { accountAlias: DEMO.dgipkAlias, amount: { amount: '99.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-INCONNUE-01' },
        { accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference },
      ],
    });
    expect(st.statusCode).toBe(201);
    expect(st.json().matched).toHaveLength(1);
    const list = (await env.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json() as { id: string; type: string; statementId: string; status: string; openedAt: string; line: unknown }[];
    const exc = list.find((e) => e.statementId === 'REL-RECETTE-C42-07')!;
    // Exploitable : type, relevé, ligne source, date d'ouverture, statut ; traçable : audit chaîné et notification.
    expect(exc).toMatchObject({ type: 'ORPHAN_CREDIT', status: 'OUVERTE', line: { paymentReference: 'PR-INCONNUE-01' } });
    expect(exc.openedAt).toBe(env.clock.now().toISOString());
    const opened = env.app.ctx.audit.list({ action: 'reconciliation.exception.opened' }).items.find((x) => x.resourceId === exc.id);
    expect(opened).toBeDefined();
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'reconciliation.exception.opened').length).toBeGreaterThan(0);
    expect((await env.req('GET', '/v1/reconciliation/exceptions', 'u-contribuable')).statusCode).toBe(403);
    expect(env.app.ctx.audit.verify().ok).toBe(true);
  });

  it('C42-08 — la vérification publique d’une quittance ne divulgue aucune donnée personnelle', async () => {
    const env = await setup();
    const { callback } = await payDemoObligation(env);
    const tp = env.app.ctx.taxpayers.get(DEMO.taxpayerId);
    const body = (await env.req('GET', `/v1/public/receipts/${callback.receiptCode}`)).json();
    const text = JSON.stringify(body);
    for (const secret of [tp.fullName, tp.phone, tp.iuc, tp.id, DEMO.parcelId]) expect(text).not.toContain(secret);
    expect(body).not.toHaveProperty('taxpayerId');
    expect(body).not.toHaveProperty('fullName');
    expect(body.status).toBeDefined();
  });

  it('C42-09 — un recours est horodaté, affecté et suivi jusqu’à décision motivée', async () => {
    const env = await setup();
    const obligation = env.app.ctx.assessment.get(demoObligationId(env));
    const sub = await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obligation.id, type: 'MONTANT_ERRONE', grounds: 'Superficie déclarée erronée : 300 m² et non 400 m² (recette).' });
    expect(sub.statusCode).toBe(201);
    const a = sub.json();
    // Horodaté : accusé numéroté, empreinte du contenu ; affecté : file d'instruction de l'entité administratrice.
    expect(a.acknowledgement).toMatchObject({ number: `AR-${a.id}`, at: env.clock.now().toISOString(), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(a.affectation).toMatchObject({ entity: obligation.entity, file: 'INSTRUCTION_RECOURS', roles: ['R20'] });
    // Suivi : délai légal calculé (heure serveur), état affiché.
    expect(a.deadlines).toMatchObject({ state: 'DANS_LE_DELAI', decisionDueBy: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    await env.req('POST', `/v1/appeals/${a.id}/instruct`, 'u-contentieux', { proposal: 'REJETEE', analysis: 'Superficie confirmée par le relevé cadastral (recette).' });
    // Décision motivée par une personne distincte de l'instructeur.
    const d = await env.req('POST', `/v1/appeals/${a.id}/decide`, 'u-decideur', { decision: 'REJETEE', reason: 'Superficie de 400 m² confirmée par le relevé cadastral (recette).' });
    expect(d.statusCode).toBe(200);
    const done = (await env.req('GET', `/v1/appeals/${a.id}`, 'u-contribuable')).json();
    expect(done.decision).toMatchObject({ decision: 'REJETEE', decidedBy: 'u-decideur', reason: expect.stringMatching(/relevé cadastral/) });
    expect(done.deadlines.state).toBe('DECIDE_DANS_LE_DELAI');
    expect(done.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['appeal.submitted']));
    for (const action of ['appeal.submitted', 'appeal.decided']) expect(env.app.ctx.audit.list({ action }).total).toBeGreaterThan(0);
  });

  it('C42-10 — les tableaux de bord distinguent les six états : potentiel, constaté, encaissé, réglé, rapproché, disponible', async () => {
    const env = await withPlugins([pilotagePlugin as MosoloPlugin<unknown>]);
    await payDemoObligation(env);
    const l = (await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur')).json();
    expect(l.sixEtats.map((s: { etat: string }) => s.etat)).toEqual(['POTENTIEL', 'CONSTATE', 'ENCAISSE', 'REGLE', 'RAPPROCHE', 'DISPONIBLE']);
    expect(l.sixEtats.map((s: { libelle: string }) => s.libelle)).toEqual(['Potentiel', 'Constaté', 'Encaissé', 'Réglé', 'Rapproché', 'Disponible']);
    const by = (code: string) => l.sixEtats.find((s: { etat: string }) => s.etat === code);
    expect(by('POTENTIEL').mesure).toBe(false);
    expect(by('DISPONIBLE').mesure).toBe(false);
    expect(by('CONSTATE').mesure).toBe(true);
    expect(by('ENCAISSE').montants.length).toBeGreaterThan(0);
    // Distincts et emboîtés : jamais additionnés (un paiement confirmé non réglé n'apparaît pas en « réglé »).
    expect(by('REGLE').montants).toEqual([]);
    expect(new Set(l.sixEtats.map((s: { rang: number }) => s.rang)).size).toBe(6);
  });
});

describe('Stratégie de tests (ch. 45) — sécurité et paiement', () => {
  it('S45-3 — paiement de bout en bout : échec, doublon et rappel frauduleux, sans quittance indue', async () => {
    const env = await setup();
    // Échec signalé par le prestataire : aucune quittance.
    const o1 = (await createOrder(env)).json();
    const failed = await signedCallback(env, { ...callbackBody(env, o1.paymentReference), status: 'FAILED' });
    expect(failed.statusCode).toBe(200);
    expect(env.app.ctx.receipts.byPaymentOrder(o1.paymentOrderId)).toBeUndefined();
    // Rappel frauduleux (montant falsifié) : rejet et alerte, aucune quittance.
    const alerts = env.app.ctx.alerts.alerts.count();
    const o2 = (await createOrder(env, randomUUID())).json();
    const fraud = await signedCallback(env, callbackBody(env, o2.paymentReference, { amount: '1.00', currency: 'USD' }));
    expect(fraud.statusCode).toBeGreaterThanOrEqual(400);
    expect(env.app.ctx.alerts.alerts.count()).toBeGreaterThan(alerts);
    expect(env.app.ctx.receipts.byPaymentOrder(o2.paymentOrderId)).toBeUndefined();
    // Doublon : même transaction rejouée (nouveau nonce) → aucun double effet.
    const o3 = (await createOrder(env, randomUUID())).json();
    const body = callbackBody(env, o3.paymentReference);
    expect((await signedCallback(env, body)).json().status).toBe('CONFIRME');
    const receiptsAfter = env.app.ctx.receipts.receipts.count();
    expect((await signedCallback(env, body)).statusCode).toBe(200);
    expect(env.app.ctx.receipts.receipts.count()).toBe(receiptsAfter);
  });

  it('S45-6 — élévation de privilèges refusée : un rôle ne s’attribue ni ne s’accorde de droits', async () => {
    const env = await withPlugins([accesPlugin as MosoloPlugin<unknown>]);
    // Un agent de terrain ne s'invite pas avec un rôle de travail supérieur et n'invite personne.
    expect((await env.req('POST', '/v1/acces/invitations', 'u-agent-terrain', { motif: 'Tentative d’élévation (recette)', fullName: 'Agent test', phone: '+243811999001', entity: 'DGIPK', accessLevel: 'CONSULTATION', roles: ['R26'] })).statusCode).toBe(403);
    // Le super-administrateur ne publie pas de règle, ne décide pas de recours, ne modifie pas un bénéficiaire.
    const { id } = await publishCertifiedRule(env, { code: 'RECETTE-ELEVATION' }, 0);
    expect((await env.req('POST', `/v1/legal-rules/${id}/approve`, 'u-superadmin', { role: 'AUTORITE_PUBLICATION' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-superadmin', { alias: DEMO.dgipkAlias, bankName: 'x', accountNumber: 'CD00 0000 0000 0000 0000 0001', holderName: 'x', reason: 'Élévation (recette)' })).statusCode).toBe(403);
    // Élévation juste-à-temps : le demandeur ne s'approuve jamais lui-même.
    const e = await env.req('POST', '/v1/acces/elevations', 'acces-u-exploitation', { role: 'R26', motif: 'Incident de recette : rotation de clé', durationMinutes: 30, ticketRef: 'INC-RECETTE' });
    expect(e.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/acces/elevations/${e.json().id}/decision`, 'acces-u-exploitation', { approve: true, motif: 'Auto-approbation (refusée)' })).statusCode).toBe(403);
    expect(env.app.ctx.audit.verify().ok).toBe(true);
  });
});
