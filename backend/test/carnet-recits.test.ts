/**
 * Carnet de développement — Document maître FR 2, ch. 43 : un test par récit utilisateur, de bout en bout par l'API,
 * vérifiant chacun des critères d'acceptation du récit. Titres repris par le référentiel du programme
 * (backend/src/plugins/pilotage/recette-programme/referentiels.ts, RECITS_43) et vérifiés par test/programme.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { fiscalPlugin } from '../src/plugins/fiscal/plugin.js';
import type { FiscalService } from '../src/plugins/fiscal/service.js';
import { pilotagePlugin } from '../src/plugins/pilotage/plugin.js';
import { planificationPlugin } from '../src/plugins/pilotage/planification/plugin.js';
import { recetteProgrammePlugin } from '../src/plugins/pilotage/recette-programme/plugin.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import { terrainPlugin } from '../src/plugins/terrain/plugin.js';
import { titresPlugin, type TitresService } from '../src/plugins/titres/plugin.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { callbackHeaders, DEMO, demoObligationId, payDemoObligation, PROVIDER_SECRET, publishCertifiedRule, setup, type TestEnv } from './helpers.js';

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
const list = <T>(b: unknown): T[] => (Array.isArray(b) ? b : (b as { items?: T[] }).items ?? []) as T[];

describe('Carnet de développement (ch. 43) — récits de bout en bout', () => {
  it('R43-01 — Kinois : compte par téléphone et code à usage unique, N0 sans pièce, aucune obligation sans objet rattaché', async () => {
    const env = await withPlugins([createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false }, persistence: null }) as MosoloPlugin<unknown>]);
    const phone = '+243899100201';
    // Inscription sans aucune pièce d'identité : niveau N0.
    const reg = await env.req('POST', '/v1/registrations', undefined, { phone, fullName: 'Titulaire du récit un (fictif)', language: 'fr', situation: 'tenant' });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ verificationLevel: 'N0' });
    const taxpayerId = reg.json().taxpayerId ?? reg.json().id;
    // Connexion par code à usage unique envoyé au téléphone (bac à sable : code affiché en démonstration).
    const ch = (await env.req('POST', '/v1/auth/login', undefined, { method: 'phone', phone })).json();
    expect(ch).toMatchObject({ method: 'sms-otp', challengeId: expect.any(String) });
    expect((await env.req('POST', '/v1/auth/otp', undefined, { challengeId: ch.challengeId, code: '000000' === ch.demoCode ? '111111' : '000000' })).statusCode).toBeGreaterThanOrEqual(400);
    const ok = await env.req('POST', '/v1/auth/otp', undefined, { challengeId: ch.challengeId, code: ch.demoCode });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().acr).toBe('urn:mosolo:acr:otp');
    const token = ok.json().accessToken as string;
    const auth = { authorization: `Bearer ${token}` };
    // Code à usage unique : le même défi ne sert pas deux fois.
    expect((await env.req('POST', '/v1/auth/otp', undefined, { challengeId: ch.challengeId, code: ch.demoCode })).statusCode).toBeGreaterThanOrEqual(400);
    // « Voir ce que je dois » : aucun objet rattaché ⇒ aucune obligation affichée.
    const mine = await env.req('GET', `/v1/obligations?taxpayerId=${taxpayerId}`, undefined, undefined, auth);
    expect(mine.statusCode).toBe(200);
    expect(list(mine.json())).toHaveLength(0);
    const profile = (await env.req('GET', `/v1/taxpayers/${taxpayerId}`, undefined, undefined, auth)).json();
    expect(profile.taxpayer.verificationLevel).toBe('N0');
    expect(profile.obligations).toEqual([]);
    expect(env.app.ctx.objects.byTaxpayer(taxpayerId)).toHaveLength(0);
    expect(env.app.ctx.assessment.byTaxpayer(taxpayerId)).toHaveLength(0);
    await env.app.close();
  });

  it('R43-02 — bailleur : déclaration IRL d’une unité, calcul avec taux, retenue et référence de l’arrêté, pièce facultative', async () => {
    const env = await withPlugins([fiscalPlugin as MosoloPlugin<unknown>]);
    const svc = env.app.ctx.ext.fiscal as FiscalService;
    const unit = env.app.ctx.objects.objects.get(DEMO.unitId)!;
    expect(unit.category).toBe('UNITE_LOCATIVE');
    // Pré-remplissage : calcul affiché avec taux, retenue et arrêté, lus dans la fiche de règle (jamais saisis).
    const pre = (await env.req('GET', `/v1/fiscal/declarations/prefill?objectId=${DEMO.unitId}&kind=IRL&period=2025`, 'u-contribuable')).json();
    expect(pre.calcul).toMatchObject({ taux: expect.stringMatching(/^\d+$/), tauxRetenue: expect.stringMatching(/^\d+$/), arretes: [{ id: 'arrete-taux-irl-2026', statut: expect.any(String) }] });
    expect(pre.calcul.mention).toMatch(/à vérifier|fixés par/);
    // Une unité par déclaration, pièce justificative facultative (empreinte).
    const piece = { name: 'contrat-de-bail.pdf', mediaType: 'application/pdf', sha256: 'b'.repeat(64) };
    const d = await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.unitId, kind: 'IRL', period: '2025', inputs: {}, attest: true, piece });
    expect(d.statusCode).toBe(201);
    expect(d.json()).toMatchObject({ objectId: DEMO.unitId, kind: 'IRL', piece: { sha256: 'b'.repeat(64) }, calcul: { taux: pre.calcul.taux, tauxRetenue: pre.calcul.tauxRetenue } });
    expect(d.json().acknowledgement.number).toMatch(/^ACR-2025-/);
    // Sans pièce : dépôt accepté (la pièce reste facultative).
    const d2 = await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.unitId, kind: 'IRL', period: '2024', inputs: {}, attest: true });
    expect(d2.statusCode).toBe(201);
    expect(d2.json().piece).toBeUndefined();
    // Règle non active : simulation non opposable, aucune obligation.
    expect(d2.json().liquidation.mode).toBe('SIMULATION_NON_OPPOSABLE');
    expect(svc.declarations.get(d.json().id).calcul?.arretes[0]?.id).toBe('arrete-taux-irl-2026');
    expect(env.app.ctx.audit.list({ action: 'declaration.submitted' }).items.some((x) => x.details.pieceSha256 === 'b'.repeat(64))).toBe(true);
  });

  it('R43-03 — locataire : bail enregistré, bailleur notifié, attestation avec QR sans donnée sensible', async () => {
    const env = await withPlugins([fiscalPlugin as MosoloPlugin<unknown>]);
    const unit = (await env.req('POST', '/v1/fiscal-objects', 'u-contribuable', { category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.345, attributes: { surface_m2: '35' } })).json();
    const lease = await env.req('POST', '/v1/leases', 'u-locataire', { unitObjectId: unit.id, lessorId: DEMO.taxpayerId, rent: { amount: '140.00', currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-09-01' });
    expect(lease.statusCode).toBe(201);
    // Notification au bailleur (avis obligatoire).
    expect(env.app.ctx.comms.deliveries.find((x) => x.eventCode === 'lease.declared_by_tenant' && x.recipientId === DEMO.taxpayerId).length).toBeGreaterThan(0);
    // Attestation générée avec QR (chemin de vérification signé encodé dans le QR).
    const att = await env.req('POST', `/v1/fiscal/leases/${lease.json().id}/attestations`, 'u-locataire');
    expect(att.statusCode).toBe(201);
    expect(att.json()).toMatchObject({ issuedToRole: 'LOCATAIRE', verifyPath: expect.stringMatching(/^\/fiscal\/verifier\/bail\/[0-9A-Z]+\?s=/) });
    const [, code, sig] = /\/bail\/([^?]+)\?s=(.+)$/.exec(att.json().verifyPath)!;
    const pub = (await env.req('GET', `/v1/public/fiscal/lease-attestations/${code}?s=${sig}`)).json();
    expect(pub.result).toBe('VALIDE');
    // Aucune donnée sensible exposée : ni nom, ni loyer, ni téléphone, ni identifiant du contribuable.
    const text = JSON.stringify(pub);
    for (const secret of ['140.00', DEMO.taxpayerId, DEMO.tenantTaxpayerId, env.app.ctx.taxpayers.get(DEMO.taxpayerId).fullName, env.app.ctx.taxpayers.get(DEMO.tenantTaxpayerId).fullName, '+243']) expect(text).not.toContain(secret);
  });

  it('R43-04 — agent recenseur : objet non enregistré créé hors ligne (GPS, photo, catégorie), sans effet fiscal, synchronisé sans perte', async () => {
    const env = await withPlugins([terrainPlugin as MosoloPlugin<unknown>]);
    const objects = env.app.ctx.objects.objects.count();
    const obligations = env.app.ctx.assessment.obligations.count();
    const capturedAt = env.clock.now().toISOString();
    env.clock.advance(6 * 3_600_000); // capturé hors réseau à 10 h, synchronisé à 16 h
    const c = { clientRef: 'recit-4-objet', outcome: 'OBJET_NON_ENREGISTRE', category: 'ACTIVITE', observations: 'Boutique non enregistrée, enseigne visible (fictif).', gps: { lat: -4.3712, lon: 15.3441, accuracyM: 7 }, photoSha256: 'c'.repeat(64), capturedAt, deviceId: 'dev-terrain-001' };
    const r = await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', c);
    expect(r.statusCode).toBe(201);
    expect(r.json().finding).toMatchObject({ outcome: 'OBJET_NON_ENREGISTRE', category: 'ACTIVITE', photoSha256: 'c'.repeat(64), capturedAt, status: 'SOUMIS', probativeStatus: 'OBSERVE' });
    expect(r.json().finding.gps).toMatchObject({ lat: -4.3712, lon: 15.3441 });
    // Synchronisation sans perte : le renvoi identique est reconnu, le contenu scellé ne peut être réécrit.
    expect((await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', c)).json()).toMatchObject({ replayed: true, finding: { id: r.json().finding.id } });
    expect((await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...c, category: 'PANNEAU' })).statusCode).toBe(409);
    expect((await env.req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...c, clientRef: 'recit-4-cat', outcome: 'CONSTATE', objectId: 'OBJ-DEMO-UNITE-01' })).json().code).toBe('CATEGORY_ONLY_FOR_NEW_OBJECT');
    // Aucun effet fiscal avant qualification : ni objet au registre, ni obligation.
    expect(env.app.ctx.objects.objects.count()).toBe(objects);
    expect(env.app.ctx.assessment.obligations.count()).toBe(obligations);
    // Qualification par une personne distincte (jamais l'agent auteur) ; toujours sans effet fiscal.
    expect((await env.req('POST', `/v1/terrain/findings/${r.json().finding.id}/review`, 'u-agent-terrain', { decision: 'VALIDE', reason: 'Auto-validation' })).statusCode).toBe(403);
    const q = await env.req('POST', `/v1/terrain/findings/${r.json().finding.id}/review`, 'u-controleur', { decision: 'VALIDE', reason: 'Objet retrouvé sur la photo et la position (fictif)' });
    expect(q.json().status).toBe('VALIDE');
    expect(env.app.ctx.assessment.obligations.count()).toBe(obligations);
  });

  it('R43-05 — contrôleur : plaque vérifiée en moins de 3 s en ligne, statut minimal hors ligne, consultation journalisée', async () => {
    const env = await withPlugins([titresPlugin as MosoloPlugin<unknown>]);
    const ctx = env.app.ctx;
    const svc = ctx.ext.titres as TitresService;
    ctx.users.add({ id: 'recit-controleur', name: 'Contrôleur du récit 5 (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete'] });
    ctx.field.enroll('dev-recit-5', 'recit-controleur', 'cle-terminal-recit-5');
    const { id: ruleId } = await publishCertifiedRule(env, { code: 'RECIT5-TITRE', revenueCategory: 'REDEVANCE_SERVICE', formula: 'n * t', rateTable: { t: '2' }, periodicity: 'PONCTUELLE', baseDefinition: 'Nombre d’unités' });
    expect(ctx.rules.get(ruleId).status).toMatch(/PUBLIEE|ACTIVE/);
    svc.defineType({
      code: 'RECIT5-JOUR', module: '99', moduleLabel: 'Module de test', label: 'Titre journalier (récit 5)', prefix: 'RCQ', entity: 'DGIPK',
      validity: { model: 'JOURNALIER', toleranceMinutes: 0, amberMinutes: 120, startMode: 'PAIEMENT', extendable: true, refundable: false },
      transferable: false, plateBound: true, supports: ['QR_STATIQUE', 'PLAQUE'], pricing: { ruleCode: 'RECIT5-TITRE', inputs: { n: '1' } },
      legalAct: { ref: 'J21', status: 'DEMONSTRATION', note: 'Test du récit 5' }, demo: true,
    });
    const iss = svc.purchase(ctx.users.get('u-contribuable')!, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'RECIT5-JOUR', holderTaxpayerId: DEMO.taxpayerId, subject: { plate: 'KN 5555 RC' }, place: { commune: 'Limete', sourceId: 'ZONE-LMT-01', label: 'Zone de démonstration Limete', basis: 'ZONE_SERVICE' } }] });
    const order = ctx.payments.byReference(iss.payments[0]!.paymentReference)!;
    const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() });
    expect((await env.app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw, headers: { 'content-type': 'application/json', ...callbackHeaders(PROVIDER_SECRET, raw, env.clock.now()) } })).statusCode).toBe(200);
    svc.sync();
    // En ligne : réponse en moins de 3 secondes.
    const t0 = performance.now();
    const online = await env.req('POST', '/v1/titres/controles', 'recit-controleur', { plate: 'KN 5555 RC', place: { commune: 'Limete', label: 'Boulevard Lumumba', lat: -4.37, lon: 15.34 } });
    const elapsed = performance.now() - t0;
    expect(online.json().result).toBe('VALIDE');
    expect(elapsed).toBeLessThan(3000);
    const t1 = performance.now();
    const byPlate = await env.req('GET', '/v1/vehicules/KN5555RC/titres?commune=Limete', 'recit-controleur');
    expect(performance.now() - t1).toBeLessThan(3000);
    expect(byPlate.json().credentials[0]).toMatchObject({ result: 'VALIDE' });
    // Consultation journalisée (qui, quelle plaque, quand).
    const consulted = ctx.audit.list({ action: 'titres.plate.consulted' }).items.at(-1)!;
    expect(consulted).toMatchObject({ actor: { id: 'recit-controleur' }, resourceId: 'KN5555RC' });
    // Hors ligne : paquet signé ne portant que le statut minimal (plaque, numéro, validité) — ni nom ni contribuable.
    const pack = (await env.req('GET', '/v1/titres/hors-ligne/paquet?deviceId=dev-recit-5', 'recit-controleur')).json();
    const entry = pack.plates.plates.find((p: { plate: string }) => p.plate === 'KN5555RC');
    expect(Object.keys(entry).sort()).toEqual(['amberMinutes', 'number', 'plate', 'toleranceMinutes', 'typeCode', 'validFrom', 'validUntil'].sort());
    const packText = JSON.stringify(pack.plates);
    expect(packText).not.toContain(DEMO.taxpayerId);
    expect(packText).not.toContain(ctx.taxpayers.get(DEMO.taxpayerId).fullName);
    expect(ctx.audit.list({ action: 'titres.offline_pack.downloaded' }).total).toBe(1);
  });

  it('R43-06 — juriste : ni création, ni validation, ni publication par la même personne ; version et dates obligatoires', async () => {
    const env = await setup();
    // Dates obligatoires : sans date d'effet, la fiche est refusée.
    const { create: noDate } = await publishCertifiedRule(env, { code: 'RECIT6-SANS-DATE', effectiveFrom: undefined }, 0);
    expect(noDate.statusCode).toBe(400);
    const { id, create } = await publishCertifiedRule(env, { code: 'RECIT6' }, 1);
    expect(create.json()).toMatchObject({ version: 1, effectiveFrom: '2026-01-01' });
    // La rédactrice ne valide pas (visa du vérificateur) et ne publie pas.
    expect((await env.req('POST', `/v1/legal-rules/${id}/approve`, 'u-juriste-redacteur', { role: 'VERIFICATEUR_JURIDIQUE' })).statusCode).toBe(403);
    await env.req('POST', `/v1/legal-rules/${id}/approve`, 'u-juriste-verificateur', { role: 'VERIFICATEUR_JURIDIQUE' });
    await env.req('POST', `/v1/legal-rules/${id}/approve`, 'u-validateur-financier', { role: 'VALIDATEUR_FINANCIER' });
    for (const u of ['u-juriste-redacteur', 'u-juriste-verificateur']) {
      const r = await env.req('POST', `/v1/legal-rules/${id}/approve`, u, { role: 'AUTORITE_PUBLICATION' });
      expect(r.statusCode).toBe(403);
    }
    const pub = await env.req('POST', `/v1/legal-rules/${id}/approve`, 'u-autorite-publication', { role: 'AUTORITE_PUBLICATION' });
    expect(pub.json().status).toMatch(/PUBLIEE|ACTIVE/);
    expect(new Set(pub.json().approvals.map((a: { userId: string }) => a.userId)).size).toBe(4);
    expect(pub.json().publishedAt).toBeDefined();
    // Nouvelle version : numérotée, l'ancienne conservée.
    const { create: v2 } = await publishCertifiedRule(env, { code: 'RECIT6', effectiveFrom: '2027-01-01', changeReason: 'Nouvelle version (récit 6)' }, 0);
    expect(v2.statusCode).toBe(201);
    expect(v2.json()).toMatchObject({ version: 2, supersedesVersionId: id, effectiveFrom: '2027-01-01', status: 'BROUILLON' });
    expect(env.app.ctx.rules.get(id).version).toBe(1);
  });

  it('R43-07 — comptable public : import de relevé, appariement automatique, file d’exception, aucune modification silencieuse', async () => {
    const env = await setup();
    const { order } = await payDemoObligation(env);
    const statement = {
      statementId: 'REL-RECIT-7', lines: [
        { accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference },
        { accountAlias: DEMO.dgipkAlias, amount: { amount: '42.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-SANS-ORDRE-7' },
      ],
    };
    const r = await env.req('POST', '/v1/settlements/statements', 'u-tresor', statement);
    expect(r.statusCode).toBe(201);
    // Appariement automatique et file d'exception.
    expect(r.json().matched).toHaveLength(1);
    expect(r.json().exceptions.map((e: { type: string }) => e.type)).toEqual(['ORPHAN_CREDIT']);
    expect(env.app.ctx.receipts.byPaymentOrder(order.paymentOrderId)!.status).toBe('DEFINITIVE');
    // Aucune modification silencieuse : même relevé rejoué = même résultat ; contenu différent = refus explicite.
    const again = await env.req('POST', '/v1/settlements/statements', 'u-tresor', statement);
    expect(again.statusCode).toBeLessThan(300);
    const changed = await env.req('POST', '/v1/settlements/statements', 'u-tresor', { ...statement, lines: [{ ...statement.lines[1]!, amount: { amount: '43.00', currency: 'USD' } }] });
    expect(changed.json().code).toBe('STATEMENT_ALREADY_IMPORTED');
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    expect(env.app.ctx.audit.list({ action: 'settlement.received' }).total).toBeGreaterThanOrEqual(1);
    // Aucune suppression d'écriture : correction par contre-écriture proposée seulement.
    const entry = env.app.ctx.ledger.list()[0]!;
    expect((await env.req('DELETE', `/v1/ledger/entries/${entry.id}`, 'u-tresor')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('R43-08 — Gouverneur : écart assignation / rapproché par commune, six états distingués, exportation signée vérifiable', async () => {
    const env = await withPlugins([pilotagePlugin, planificationPlugin, recetteProgrammePlugin] as MosoloPlugin<unknown>[]);
    const { order } = await payDemoObligation(env);
    await env.req('POST', '/v1/settlements/statements', 'u-tresor', { statementId: 'REL-RECIT-8', lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }] });
    const t = (await env.req('POST', '/v1/pilotage/assignations', 'u-validateur-financier', {
      fiscalYear: '2026', label: 'Assignations 2026 (fictives, récit 8)', act: { reference: 'CONTRAT-PERF-2026 (fictif)', title: 'Contrat de performance (fictif)' },
      entries: [{ commune: 'Limete', category: '*', amount: { amount: '600.00', currency: 'USD' } }, { commune: 'Gombe', category: '*', amount: { amount: '100.00', currency: 'USD' } }],
    })).json();
    await env.req('POST', `/v1/pilotage/assignations/${t.id}/certification`, 'u-ministre-finances', { approve: true, motif: 'Assignations conformes au budget voté (fictif)' });
    // Tableau et carte : écart par commune.
    const g = (await env.req('GET', '/v1/pilotage/assignations/ecarts?annee=2026', 'u-gouverneur')).json();
    expect(g.byCommune.map((c: { commune: string }) => c.commune)).toEqual(expect.arrayContaining(['Limete', 'Gombe']));
    // Six états distingués sur le tableau du Gouverneur.
    const l = (await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur')).json();
    expect(l.sixEtats.map((s: { etat: string }) => s.etat)).toEqual(['POTENTIEL', 'CONSTATE', 'ENCAISSE', 'REGLE', 'RAPPROCHE', 'DISPONIBLE']);
    // Exportation signée : écarts et six états par commune, vérifiable publiquement, journalisée.
    const x = await env.req('GET', '/v1/pilotage/assignations/ecarts/export?annee=2026', 'u-gouverneur');
    expect(x.statusCode).toBe(200);
    const e = x.json();
    expect(e.content.sixEtats.find((c: { commune: string }) => c.commune === 'Limete').etats.map((s: { etat: string }) => s.etat)).toHaveLength(6);
    const v = (await env.req('POST', '/v1/pilotage/exports/verify', undefined, { payload: e.payload, sha256: e.sha256, signature: e.signature })).json();
    expect(v).toMatchObject({ valid: true, registered: { kind: 'ecarts-assignation' } });
    const tampered = (await env.req('POST', '/v1/pilotage/exports/verify', undefined, { payload: e.payload.replace('Limete', 'Lemba'), sha256: e.sha256, signature: e.signature })).json();
    expect(tampered.valid).toBe(false);
    expect((await env.req('GET', '/v1/pilotage/assignations/ecarts/export', 'u-contribuable')).statusCode).toBe(403);
    expect(env.app.ctx.audit.list({ action: 'pilotage.export.generated' }).items.some((a) => a.details.kind === 'ecarts-assignation')).toBe(true);
  });

  it('R43-09 — auditeur : chaîne complète d’un objet, de la création à la comptabilisation, avec acteurs, horodatages et preuves', async () => {
    const env = await withPlugins([pilotagePlugin as MosoloPlugin<unknown>]);
    const { order } = await payDemoObligation(env);
    env.clock.advance(60_000);
    await env.req('POST', '/v1/settlements/statements', 'u-tresor', { statementId: 'REL-RECIT-9', lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }] });
    const r = await env.req('GET', `/v1/pilotage/piste-audit/${DEMO.parcelId}`, 'u-auditeur');
    expect(r.statusCode).toBe(200);
    const t = r.json();
    const kinds = t.events.map((e: { kind: string }) => e.kind);
    // De la création de l'objet (déclaration) à la comptabilisation (écritures du grand livre).
    expect(kinds[0]).toBe('object.declared');
    for (const k of ['object.declared', 'assessment.issued', 'payment.confirmed', 'reconciliation.matched', 'receipt.final']) expect(kinds).toContain(k);
    expect(t.events.some((e: { source: string }) => e.source === 'GRAND_LIVRE')).toBe(true);
    // Acteurs, horodatages ordonnés, preuves (empreintes chaînées).
    expect(t.events.filter((e: { source: string }) => e.source === 'AUDIT').every((e: { actor?: { id: string } }) => !!e.actor?.id)).toBe(true);
    const ats = t.events.map((e: { at: string }) => e.at);
    expect([...ats].sort()).toEqual(ats);
    expect(t.events.filter((e: { source: string; hash?: string }) => (e.source === 'AUDIT' || e.source === 'GRAND_LIVRE') && /^[0-9a-f]{64}$/.test(e.hash ?? '')).length).toBeGreaterThan(3);
    expect(t.complete).toBe(true);
    expect((await env.req('GET', `/v1/pilotage/piste-audit/${DEMO.parcelId}`, 'u-gouverneur')).statusCode).toBe(403);
  });

  it('R43-10 — contribuable : contestation typée, accusé horodaté, délai légal suivi, décision motivée', async () => {
    const env = await setup();
    const obl = demoObligationId(env);
    // Formulaire typé : un type inconnu est refusé.
    expect((await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obl, type: 'HUMEUR', grounds: 'Type inconnu (récit 10).' })).statusCode).toBe(400);
    const sub = await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obl, type: 'INFORMATION_ERRONEE', grounds: 'Le rang de localité enregistré est erroné (récit 10).' });
    expect(sub.statusCode).toBe(201);
    const a = sub.json();
    expect(a.type).toBe('INFORMATION_ERRONEE');
    // Accusé horodaté (numéro + empreinte), délai légal suivi à l'heure serveur.
    expect(a.acknowledgement).toMatchObject({ number: `AR-${a.id}`, at: env.clock.now().toISOString() });
    expect(a.deadlines).toMatchObject({ state: 'DANS_LE_DELAI', daysRemaining: expect.any(Number) });
    env.clock.advance(5 * 86_400_000);
    const later = (await env.req('GET', `/v1/appeals/${a.id}`, 'u-contribuable')).json();
    expect(later.deadlines.daysRemaining).toBe(a.deadlines.daysRemaining - 5);
    // Décision motivée (motif obligatoire), par une autorité distincte de l'instructeur.
    await env.req('POST', `/v1/appeals/${a.id}/instruct`, 'u-contentieux', { proposal: 'ACCEPTEE', analysis: 'Rang 3 confirmé par le cadastre (récit 10).' });
    expect((await env.req('POST', `/v1/appeals/${a.id}/decide`, 'u-decideur', { decision: 'REJETEE', reason: '' })).statusCode).toBe(400);
    const d = await env.req('POST', `/v1/appeals/${a.id}/decide`, 'u-decideur', { decision: 'REJETEE', reason: 'Rang 2 confirmé par la fiche cadastrale certifiée (récit 10).' });
    expect(d.statusCode).toBe(200);
    expect(d.json().decision).toMatchObject({ decision: 'REJETEE', reason: expect.stringMatching(/fiche cadastrale/) });
    expect(d.json().nextRemedy).toBeDefined();
    // Notification du contribuable à chaque étape clé.
    expect(env.app.ctx.comms.deliveries.find((x) => x.eventCode === 'appeal.submitted' && x.recipientId === DEMO.taxpayerId).length).toBeGreaterThan(0);
  });
});
