import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { fiscalPlugin } from '../src/plugins/fiscal/plugin.js';
import type { FiscalService } from '../src/plugins/fiscal/service.js';
import { callbackBody, DEMO, signedCallback, type TestEnv } from './helpers.js';

const DAY = 86_400_000;

async function setupFiscal() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [fiscalPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return { ...env, svc: app.ctx.ext['fiscal'] as FiscalService };
}

type Env = Awaited<ReturnType<typeof setupFiscal>>;

function advance(env: Env, days: number) {
  env.clock.set(new Date(env.clock.now().getTime() + days * DAY).toISOString());
}

/** Nouvel objet recensé par l'agent de Limete (provisoire, sans rattachement). */
function census(env: Env, attrs: Record<string, unknown> = { superficie_m2: '300' }, extra: Record<string, unknown> = {}) {
  return env.app.ctx.objects.create(env.app.ctx.users.get('u-agent-terrain')!, {
    category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.345, attributes: attrs, ...extra,
  });
}

describe('Fiscal — hiérarchie SIG, identifiant géofiscal et QR par bien', () => {
  it('IGF au format du document maître, stable, prolongé par les sous-objets ; QR émis à la validation', async () => {
    const env = await setupFiscal();
    const parcel = env.app.ctx.objects.get(DEMO.parcelId);
    const unit = env.app.ctx.objects.get(DEMO.unitId);
    expect(parcel.igf?.code).toMatch(/^KIN-LIM-Q\d{3}-P\d{6}$/);
    expect(unit.igf?.code).toBe(`${parcel.igf!.code}-U01`);
    expect(parcel.igf?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(parcel.status).toBe('VALIDE');

    const o = census(env);
    const v = await env.req('POST', `/v1/fiscal/objects/${o.id}/validate`, 'u-controleur');
    expect(v.statusCode).toBe(200);
    const igf = v.json().object.igf;
    expect(igf.code).toMatch(/^KIN-LIM-Q001-P\d{6}$/);
    expect(v.json().plate.verifyPath).toMatch(/^\/fiscal\/verifier\/bien\/[0-9A-Z]{9}\?s=[0-9a-f]{24}$/);
    // Revalidation : l'IGF ne change jamais.
    const again = await env.req('POST', `/v1/fiscal/objects/${o.id}/validate`, 'u-fiscal-chef-service');
    expect(again.json().object.igf).toEqual(igf);

    const tree = (await env.req('GET', `/v1/fiscal/objects/${DEMO.unitId}`, 'u-contribuable')).json().tree;
    expect(tree.geo.map((g: { level: string }) => g.level)).toEqual(['COMMUNE', 'QUARTIER']);
    expect(tree.objects.map((x: { category: string }) => x.category)).toEqual(['PARCELLE', 'UNITE_LOCATIVE']);
    const quartiers = (await env.req('GET', '/v1/fiscal/geo-units?level=QUARTIER&commune=Limete')).json();
    expect(quartiers.some((q: { name: string; parentId: string }) => q.name === 'Kingabwa' && q.parentId === 'GEO-LIM')).toBe(true);
  });

  it('séparation des tâches : l’agent de terrain ne valide pas, l’auteur du recensement non plus', async () => {
    const env = await setupFiscal();
    const o = census(env);
    expect((await env.req('POST', `/v1/fiscal/objects/${o.id}/validate`, 'u-agent-terrain')).statusCode).toBe(403);
    const self = env.app.ctx.objects.create(env.app.ctx.users.get('u-controleur')!, { category: 'PARCELLE', commune: 'Gombe', quartier: 'Golf', localityRank: 1, lat: -4.30, lon: 15.30, attributes: {} });
    const r = await env.req('POST', `/v1/fiscal/objects/${self.id}/validate`, 'u-controleur');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('SEPARATION_OF_DUTIES');
    // Un sous-objet ne reçoit pas d'IGF avant son parent.
    const child = env.app.ctx.objects.create(env.app.ctx.users.get('u-agent-terrain')!, { category: 'BATIMENT', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.345, attributes: {}, parentObjectId: o.id });
    expect((await env.req('POST', `/v1/fiscal/objects/${child.id}/validate`, 'u-controleur')).json().code).toBe('PARENT_NOT_VALIDATED');
  });

  it('vérification publique minimale : authenticité, commune, quartier — ni nom, ni situation de paiement', async () => {
    const env = await setupFiscal();
    const plate = env.svc.properties.currentPlate(DEMO.parcelId)!;
    const ok = await env.req('GET', `/v1/public/fiscal/plates/${plate.shortCode}?s=${plate.signature}`);
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body).toMatchObject({ result: 'AUTHENTIQUE', nfiu: plate.nfiu, commune: 'Limete', quartier: 'Kingabwa', registered: true });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('Mbuyi');
    expect(raw).not.toContain('TP-DEMO');
    // Le Cahier prévaut (décision de la Ville) : couleur de situation publique, sans nom, montant ni motif détaillé.
    expect(body.situation).toMatchObject({ color: expect.stringMatching(/^(green|amber|red|grey|blue)$/), label: expect.any(String) });
    expect(Object.keys(body.situation).sort()).toEqual(['color', 'label']);
    expect(raw).not.toMatch(/"amount"|150\.00/);

    const forged = (await env.req('GET', `/v1/public/fiscal/plates/${plate.shortCode}?s=${'0'.repeat(24)}`)).json();
    expect(forged.result).toBe('SIGNATURE_INVALIDE');
    const typo = (await env.req('GET', `/v1/public/fiscal/plates/${plate.shortCode.slice(0, 8)}${plate.shortCode[8] === '0' ? '1' : '0'}`)).json();
    expect(typo.result).toBe('INCONNU');

    // Remplacement : l'ancien QR ne fait plus foi, l'IGF est inchangé.
    const repl = await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/plate/replace`, 'u-controleur', { reason: 'Plaque endommagée (démo)' });
    expect(repl.json().nfiu).toBe(plate.nfiu);
    expect((await env.req('GET', `/v1/public/fiscal/plates/${plate.shortCode}`)).json().result).toBe('REMPLACEE');
    expect(env.app.ctx.audit.list({ action: 'object.plate.public_check' }).total).toBeGreaterThan(0);
  });

  it('scan agent : situation et occupation sans montant ; hors périmètre refusé ; pose de plaque', async () => {
    const env = await setupFiscal();
    const plate = env.svc.properties.currentPlate(DEMO.parcelId)!;
    const scan = await env.req('GET', `/v1/fiscal/plates/${plate.shortCode}/scan`, 'u-agent-terrain');
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({ nfiu: plate.nfiu, occupancy: { code: 'MIS_EN_BAIL' }, situation: { color: 'amber' } });
    expect(JSON.stringify(scan.json())).not.toMatch(/"amount"/);
    expect((await env.req('GET', `/v1/fiscal/plates/${plate.shortCode}/scan`, 'u-agent-gombe')).statusCode).toBe(403);
    expect((await env.req('GET', `/v1/fiscal/plates/${plate.shortCode}/scan`, 'u-contribuable')).statusCode).toBe(403);
    const pose = await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/plate/pose`, 'u-agent-terrain', { gps: { lat: -4.3712, lon: 15.3441 } });
    expect(pose.json().status).toBe('POSEE');
    expect((await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/plate/pose`, 'u-agent-terrain', {})).statusCode).toBe(409);
  });
});

describe('Fiscal — relations contribuable–objet', () => {
  it('aucune relation sans preuve ; quote-part obligatoire pour un copropriétaire', async () => {
    const env = await setupFiscal();
    const o = census(env);
    const noProof = await env.req('POST', '/v1/fiscal/relationships', 'u-contribuable', { objectId: o.id, role: 'PROPRIETAIRE', from: '2020-01-01', proofs: [] });
    expect(noProof.json().code).toBe('PROOF_REQUIRED');
    const noShare = await env.req('POST', '/v1/fiscal/relationships', 'u-contribuable', { objectId: o.id, role: 'COPROPRIETAIRE', from: '2020-01-01', proofs: [{ type: 'ACTE_DE_VENTE', reference: 'AV-1' }] });
    expect(noShare.json().code).toBe('SHARE_REQUIRED');
    const other = await env.req('POST', '/v1/fiscal/relationships', 'u-contribuable', { taxpayerId: DEMO.tenantTaxpayerId, objectId: o.id, role: 'PROPRIETAIRE', from: '2020-01-01', proofs: [{ type: 'ACTE_DE_VENTE', reference: 'AV-1' }] });
    expect(other.statusCode).toBe(403);
  });

  it('revendication d’un objet provisoire → validation par un agent distinct → redevable rattaché', async () => {
    const env = await setupFiscal();
    const o = census(env);
    const rel = await env.req('POST', '/v1/fiscal/relationships', 'u-contribuable', { objectId: o.id, role: 'PROPRIETAIRE', from: '2020-01-01', proofs: [{ type: 'TITRE_FONCIER', reference: 'TF-9' }] });
    expect(rel.statusCode).toBe(201);
    expect(rel.json()).toMatchObject({ status: 'PROPOSEE', probativeStatus: 'DECLARE', share: '100' });
    const queue = (await env.req('GET', '/v1/fiscal/relationships/queue', 'u-controleur')).json();
    expect(queue.relations.some((r: { id: string }) => r.id === rel.json().id)).toBe(true);
    expect((await env.req('GET', '/v1/fiscal/relationships/queue', 'u-contribuable')).statusCode).toBe(403);
    const v = await env.req('POST', `/v1/fiscal/relationships/${rel.json().id}/validate`, 'u-controleur', { approve: true, reason: 'Titre concordant' });
    expect(v.json()).toMatchObject({ status: 'VALIDEE', probativeStatus: 'VERIFIE', validatedBy: 'u-controleur' });
    expect(env.app.ctx.objects.get(o.id).taxpayerId).toBe(DEMO.taxpayerId);
    // Détachement daté (vente) : relation close, jamais supprimée.
    const c = await env.req('POST', `/v1/fiscal/relationships/${rel.json().id}/close`, 'u-fiscal-chef-service', { to: '2026-09-01', reason: 'VENTE' });
    expect(c.json()).toMatchObject({ status: 'CLOSE', to: '2026-09-01' });
    expect(env.svc.relations.get(rel.json().id).history.map((h) => h.action)).toEqual(['DECLAREE', 'VALIDEE', 'CLOSE']);
  });

  it('le déclarant (agent) ne valide pas sa propre déclaration ; objet de forte valeur ⇒ niveau N2', async () => {
    const env = await setupFiscal();
    const o = census(env, { superficie_m2: '5000' });
    const byAgent = await env.req('POST', '/v1/fiscal/relationships', 'u-controleur', { taxpayerId: DEMO.taxpayerId, objectId: o.id, role: 'PROPRIETAIRE', from: '2020-01-01', proofs: [{ type: 'TITRE_FONCIER', reference: 'TF-10' }] });
    expect((await env.req('POST', `/v1/fiscal/relationships/${byAgent.json().id}/validate`, 'u-controleur', { approve: true, reason: 'Conforme' })).json().code).toBe('SEPARATION_OF_DUTIES');
    const n2 = await env.req('POST', `/v1/fiscal/relationships/${byAgent.json().id}/validate`, 'u-fiscal-chef-service', { approve: true, reason: 'Conforme' });
    expect(n2.statusCode).toBe(403);
    expect(n2.json()).toMatchObject({ code: 'VERIFICATION_LEVEL_REQUIRED', required: 'N2' });
  });

  it('revendications concurrentes au-delà de 100 % : conflit ouvert, aucune donnée de l’autre partie, décision motivée', async () => {
    const env = await setupFiscal();
    const claim = await env.req('POST', '/v1/fiscal/relationships', 'u-locataire', { objectId: DEMO.parcelId, role: 'PROPRIETAIRE', from: '2022-01-01', proofs: [{ type: 'ATTESTATION_COUTUMIERE', reference: 'ATT-C-1' }] });
    expect(claim.json()).toMatchObject({ status: 'CONTESTEE', probativeStatus: 'CONTESTE' });
    const disputeId = claim.json().disputeId as string;
    expect(env.app.ctx.objects.get(DEMO.parcelId).probativeStatus).toBe('CONTESTE');
    const seen = (await env.req('GET', `/v1/fiscal/objects/${DEMO.parcelId}`, 'u-locataire')).json();
    expect(seen.situation.color).toBe('blue');
    const raw = JSON.stringify(seen.relations);
    expect(raw).not.toContain(DEMO.taxpayerId);
    expect(raw).not.toContain('CE-DEMO-0001');
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'object.ownership.conflict').length).toBeGreaterThanOrEqual(2);
    expect((await env.req('POST', `/v1/fiscal/disputes/${disputeId}/resolve`, 'u-controleur', { keepRelationIds: [], reason: 'Motif test' })).statusCode).toBe(403);
    const keep = env.svc.relations.ofObject(DEMO.parcelId).find((r) => r.taxpayerId === DEMO.taxpayerId)!.id;
    const res = await env.req('POST', `/v1/fiscal/disputes/${disputeId}/resolve`, 'u-fiscal-chef-service', { keepRelationIds: [keep], reason: 'Certificat d’enregistrement antérieur et concordant' });
    expect(res.json()).toMatchObject({ status: 'TRANCHE' });
    expect(env.svc.relations.get(claim.json().id).status).toBe('REJETEE');
    expect(env.app.ctx.objects.get(DEMO.parcelId).probativeStatus).toBe('VERIFIE');
  });

  it('copropriété : quotes-parts visibles du copropriétaire, contestation par l’intéressé', async () => {
    const env = await setupFiscal();
    const mine = (await env.req('GET', '/v1/fiscal/objects', 'u-locataire')).json();
    const bat = mine.find((o: { id: string }) => o.id === 'OBJ-FISC-DEMO-COPRO-01');
    const shares = bat.relations.map((r: { share: string }) => r.share).sort();
    expect(shares).toEqual(['40', '60']);
    const own = bat.relations.find((r: { own: boolean }) => r.own);
    expect(own.taxpayerId).toBe(DEMO.tenantTaxpayerId);
    const other = bat.relations.find((r: { own: boolean }) => !r.own);
    expect(other.taxpayerId).toBeUndefined();
    const c = await env.req('POST', `/v1/fiscal/relationships/${own.id}/contest`, 'u-locataire', { reason: 'Quote-part erronée' });
    expect(c.json().status).toBe('CONTESTEE');
    // On ne conteste que ses propres relations.
    expect((await env.req('POST', `/v1/fiscal/relationships/${own.id}/contest`, 'u-contribuable', { reason: 'Motif test' })).statusCode).toBe(403);
  });
});

describe('Fiscal — déclarations pré-remplies', () => {
  it('pré-remplissage IRL depuis le bail déclaré ; règle À VÉRIFIER ⇒ simulation non opposable, sans obligation', async () => {
    const env = await setupFiscal();
    const pre = await env.req('GET', `/v1/fiscal/declarations/prefill?objectId=${DEMO.unitId}&kind=IRL&period=2026`, 'u-contribuable');
    expect(pre.statusCode).toBe(200);
    const rent = pre.json().fields.find((f: { name: string }) => f.name === 'loyers_percus');
    expect(rent).toMatchObject({ value: '5400.00', probativeStatus: 'DECLARE' });
    expect(pre.json().rule).toMatchObject({ code: 'IRL-KIN-R234', executable: false });
    // Déclaration déposée par le seed : accusé de réception, simulation non opposable.
    const list = (await env.req('GET', '/v1/fiscal/declarations', 'u-contribuable')).json();
    const irl = list.find((x: { kind: string }) => x.kind === 'IRL');
    expect(irl.acknowledgement.number).toMatch(/^ACR-2026-/);
    expect(irl.liquidation.mode).toBe('SIMULATION_NON_OPPOSABLE');
    expect(irl.liquidation.trace).toMatchObject({ nonOpposable: true, result: { amount: '918.00', currency: 'USD' } });
    expect(irl.liquidation.obligationId).toBeUndefined();
    // Un second dépôt pour la même période est refusé : il faut une correction.
    const dup = await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.unitId, kind: 'IRL', period: '2026', inputs: {}, attest: true });
    expect(dup.json().code).toBe('DECLARATION_ALREADY_FILED');
    // Correction (non liquidée) : nouvelle version, l'ancienne est remplacée.
    const corr = await env.req('POST', `/v1/fiscal/declarations/${irl.id}/corrections`, 'u-contribuable', { inputs: { loyers_percus: '4950.00' }, reason: 'Un mois de vacance', attest: true });
    expect(corr.statusCode).toBe(201);
    expect(corr.json()).toMatchObject({ version: 2, supersedes: irl.id, status: 'DEPOSEE' });
    expect(corr.json().changes[0]).toMatchObject({ field: 'loyers_percus', prefilled: '5400.00', declared: '4950.00', lowered: true });
    expect(env.svc.declarations.get(irl.id).status).toBe('REMPLACEE');
  });

  it('IF : règle ACTIVE ⇒ obligation opposable ; même fait générateur et période ⇒ aucune double facturation', async () => {
    const env = await setupFiscal();
    const same = await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.parcelId, kind: 'IF', period: '2026', inputs: {}, attest: true });
    expect(same.statusCode).toBe(201);
    expect(same.json().liquidation.mode).toBe('DEJA_LIQUIDEE');
    const before = env.app.ctx.assessment.obligations.count();
    const next = await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.parcelId, kind: 'IF', period: '2027', inputs: {}, attest: true });
    expect(next.json().liquidation.mode).toBe('OPPOSABLE');
    expect(env.app.ctx.assessment.obligations.count()).toBe(before + 1);
    const ob = env.app.ctx.assessment.get(next.json().liquidation.obligationId);
    expect(ob.explanation.source).toEqual({ type: 'DECLARATION', id: next.json().id });
    expect(ob.amount).toEqual({ amount: '150.00', currency: 'USD' });
    // Attestation obligatoire ; un tiers ne déclare pas pour autrui.
    expect((await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.parcelId, kind: 'IF', period: '2028', inputs: {}, attest: false })).json().code).toBe('ATTESTATION_REQUIRED');
    expect((await env.req('POST', '/v1/fiscal/declarations', 'u-locataire', { objectId: DEMO.parcelId, kind: 'IF', period: '2028', inputs: {}, attest: true })).statusCode).toBe(403);

    // Correction d'une déclaration liquidée : instruction par un contrôleur distinct → obligation rectificative.
    const corr = await env.req('POST', `/v1/fiscal/declarations/${next.json().id}/corrections`, 'u-contribuable', { inputs: {}, reason: 'Rang de localité contesté', attest: true });
    expect(corr.json()).toMatchObject({ status: 'A_INSTRUIRE', liquidation: { mode: 'EN_INSTRUCTION' } });
    expect((await env.req('POST', `/v1/fiscal/declarations/${corr.json().id}/instruction`, 'u-contribuable', { decision: 'ACCEPTEE', reason: 'Auto-instruction' })).statusCode).toBe(403);
    const ins = await env.req('POST', `/v1/fiscal/declarations/${corr.json().id}/instruction`, 'u-controleur', { decision: 'ACCEPTEE', reason: 'Vérifié sur pièces' });
    expect(ins.json().status).toBe('LIQUIDEE');
    const rect = env.app.ctx.assessment.get(ins.json().liquidation.obligationId);
    expect(rect.supersedes).toBe(ob.id);
    expect(rect.explanation.rectification?.decisionType).toBe('CORRECTION_DECLARATION');
    expect(env.app.ctx.assessment.get(ob.id).status).toBe('ANNULEE');
  });
});

describe('Fiscal — exonérations et remises', () => {
  const base = {
    kind: 'EXONERATION', objectId: DEMO.parcelId, ruleCode: 'DEMO-IF-BATI', rate: '100', grounds: 'Bien affecté à un usage d’intérêt général (test).',
    proofs: [{ type: 'ATTESTATION', reference: 'ATT-TEST-1' }], validFrom: '2026-09-26', validTo: '2027-12-31',
  };

  it('base légale obligatoire (instrument en vigueur du registre) ; quatre yeux ; jamais l’IA', async () => {
    const env = await setupFiscal();
    const req = await env.req('POST', '/v1/fiscal/exemptions', 'u-contribuable', base);
    expect(req.statusCode).toBe(201);
    const id = req.json().id as string;
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Pièces complètes' })).json().code).toBe('LEGAL_BASIS_REQUIRED');
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Conforme', legalBasis: { instrumentId: 'arrete-taux-if-2026', article: 'Art. 3' } })).json().code).toBe('LEGAL_BASIS_NOT_IN_FORCE');
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Conforme', legalBasis: { instrumentId: 'inexistant', article: 'Art. 3' } })).json().code).toBe('LEGAL_BASIS_UNKNOWN');
    const ins = await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Pièces complètes', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Article 2 (fictif)' } });
    expect(ins.json().status).toBe('INSTRUITE');
    // La décision ne peut précéder le visa juridique ; le juriste ne décide pas.
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-fiscal-chef-service', { decision: 'APPROUVEE', reason: 'Conforme' })).json().code).toBe('INVALID_EXEMPTION_STATE');
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/legal-visa`, 'u-contribuable', { decision: 'FAVORABLE', reason: 'Visa test' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/legal-visa`, 'u-juriste-verificateur', { decision: 'FAVORABLE', reason: 'Fondement vérifié' })).json().status).toBe('VISA_JURIDIQUE');
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-juriste-verificateur', { decision: 'APPROUVEE', reason: 'Conforme' })).statusCode).toBe(403);
    // Garde constitutionnelle : un agent d'IA ne peut jamais approuver une exonération.
    expect(() => env.svc.exemptions.decide({ kind: 'ai', id: 'agent-ia', agent: 'fraude' }, id, { decision: 'APPROUVEE', reason: 'IA' })).toThrow(/APPROVE_EXEMPTION/);
    const dec = await env.req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-fiscal-chef-service', { decision: 'APPROUVEE', reason: 'Conditions réunies' });
    expect(dec.json()).toMatchObject({ status: 'APPROUVEE', legalBasis: { instrumentId: 'demo-instrument-001' } });
    expect(new Set(dec.json().steps.map((s: { userId: string }) => s.userId)).size).toBe(3);
    expect(env.app.ctx.audit.list({ action: 'exemption.granted', resourceId: id }).total).toBe(1);

    // Application à la liquidation suivante, tracée dans l'explication.
    const decl = await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.parcelId, kind: 'IF', period: '2027', inputs: {}, attest: true });
    const ob = env.app.ctx.assessment.get(decl.json().liquidation.obligationId);
    expect(ob.amount.amount).toBe('0.00');
    expect(ob.status).toBe('SOLDEE');
    expect(ob.explanation.grossAmount).toEqual({ amount: '150.00', currency: 'USD' });
    expect(ob.explanation.adjustments?.[0]).toMatchObject({ sourceId: id, rate: '100.00', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Article 2 (fictif)' } });
  });

  it('même personne à deux étapes refusée ; rétroactivité seulement sur décision expresse', async () => {
    const env = await setupFiscal();
    const id = (await env.req('POST', '/v1/fiscal/exemptions', 'u-controleur', { ...base, taxpayerId: DEMO.taxpayerId, validFrom: '2026-01-01', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 2' } })).json().id;
    // L'initiateur (contrôleur) n'instruit pas sa propre demande : instruction par le guichet.
    const selfInstruct = await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-controleur', { decision: 'FAVORABLE', reason: 'Conforme' });
    expect(selfInstruct.json().code).toBe('SEPARATION_OF_DUTIES');
    await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Conforme' });
    await env.req('POST', `/v1/fiscal/exemptions/${id}/legal-visa`, 'u-juriste-verificateur', { decision: 'FAVORABLE', reason: 'Conforme' });
    const noRetro = await env.req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-fiscal-chef-service', { decision: 'APPROUVEE', reason: 'Conforme' });
    expect(noRetro.json().code).toBe('RETROACTIVITY_REQUIRES_DECISION');
    const retro = await env.req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-fiscal-chef-service', { decision: 'APPROUVEE', reason: 'Conforme', retroactivity: { decisionReference: 'Décision fictive n° 12', reason: 'Demande déposée en temps utile' } });
    expect(retro.json().retroactivity.decisionReference).toBe('Décision fictive n° 12');
    // Révocation motivée.
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/revoke`, 'u-fiscal-directeur', { reason: 'Conditions disparues' })).json().status).toBe('REVOQUEE');

    const id2 = (await env.req('POST', '/v1/fiscal/exemptions', 'u-contribuable', base)).json().id;
    await env.req('POST', `/v1/fiscal/exemptions/${id2}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Conforme', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 2' } });
    // Le juriste ne peut être l'instructeur (quatre yeux) — ici l'instructeur n'a pas le rôle, on vérifie via le service.
    const guichet = env.app.ctx.users.get('u-guichet')!;
    expect(() => env.svc.exemptions.legalVisa({ ...guichet, roles: ['R14'] }, id2, { decision: 'FAVORABLE', reason: 'Visa test' })).toThrow(/distincte/);
  });

  it('remise sur une obligation devenue non payable : décision refusée et JAMAIS enregistrée comme approuvée', async () => {
    const env = await setupFiscal();
    const obA = env.app.ctx.assessment.byTaxpayer('TP-FISC-DEMO-01')[0]!;
    const id = (await env.req('POST', '/v1/fiscal/exemptions', 'u-guichet', {
      kind: 'REMISE', obligationId: obA.id, amount: { amount: '50.00', currency: 'USD' }, grounds: 'Sinistre (exemple fictif).',
      proofs: [{ type: 'PV', reference: 'PV-2' }], validFrom: '2026-09-26', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 5 (fictif)' },
    })).json().id;
    await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-controleur', { decision: 'FAVORABLE', reason: 'Conforme' });
    await env.req('POST', `/v1/fiscal/exemptions/${id}/legal-visa`, 'u-juriste-verificateur', { decision: 'FAVORABLE', reason: 'Conforme' });
    env.app.ctx.assessment.setStatus(obA.id, 'SOLDEE');
    const d = await env.req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-fiscal-directeur', { decision: 'APPROUVEE', reason: 'Sinistre constaté' });
    expect(d.json().code).toBe('OBLIGATION_NOT_REMITTABLE');
    expect(env.svc.exemptions.get(id).status).toBe('VISA_JURIDIQUE');
    expect(env.app.ctx.assessment.get(obA.id).supersededBy).toBeUndefined();
  });

  it('remise : double validation puis obligation rectifiée par contre-écriture ; exonération appliquée à la liquidation du seed', async () => {
    const env = await setupFiscal();
    // Seed : contribuable B exonéré à 50 % ⇒ 75,00 au lieu de 150,00, avec base légale dans l'explication.
    const obB = env.app.ctx.assessment.byTaxpayer('TP-FISC-DEMO-02')[0]!;
    expect(obB.amount.amount).toBe('75.00');
    expect(obB.explanation.adjustments?.[0]?.legalBasis.instrumentId).toBe('demo-instrument-001');

    const obA = env.app.ctx.assessment.byTaxpayer('TP-FISC-DEMO-01')[0]!;
    const r = await env.req('POST', '/v1/fiscal/exemptions', 'u-guichet', {
      kind: 'REMISE', obligationId: obA.id, amount: { amount: '50.00', currency: 'USD' }, grounds: 'Sinistre (exemple fictif) — remise partielle.',
      proofs: [{ type: 'PV', reference: 'PV-SINISTRE-1' }], validFrom: '2026-09-26', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 5 (fictif)' },
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-controleur', { decision: 'FAVORABLE', reason: 'Conforme' });
    await env.req('POST', `/v1/fiscal/exemptions/${id}/legal-visa`, 'u-juriste-verificateur', { decision: 'FAVORABLE', reason: 'Conforme' });
    const d = await env.req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-fiscal-directeur', { decision: 'APPROUVEE', reason: 'Sinistre constaté' });
    const rect = env.app.ctx.assessment.get(d.json().rectifiedObligationId);
    expect(rect.amount.amount).toBe('100.00');
    expect(rect.explanation.rectification).toMatchObject({ supersedes: obA.id, decisionType: 'REMISE' });
    expect(env.app.ctx.assessment.get(obA.id).status).toBe('ANNULEE');
    const excessive = await env.req('POST', '/v1/fiscal/exemptions', 'u-guichet', { kind: 'REMISE', obligationId: rect.id, amount: { amount: '999.00', currency: 'USD' }, grounds: 'Remise excessive (test).', proofs: [{ type: 'PV', reference: 'X-1' }], validFrom: '2026-09-26' });
    expect(excessive.json().code).toBe('REMISE_EXCEEDS_OBLIGATION');
    // File des agents : vue d'ensemble ; contribuable : les siennes seulement.
    expect((await env.req('GET', '/v1/fiscal/exemptions', 'u-fiscal-chef-service')).json().items.length).toBeGreaterThanOrEqual(3);
    const own = (await env.req('GET', '/v1/fiscal/exemptions', 'u-contribuable')).json().items;
    expect(own.every((x: { taxpayerId: string }) => x.taxpayerId === DEMO.taxpayerId)).toBe(true);
    expect((await env.req('GET', '/v1/fiscal/exemptions?taxpayerId=TP-FISC-DEMO-02', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Fiscal — quitus fiscal numérique', () => {
  it('délivré sans obligation exigible impayée ; vérification publique sans donnée sensible ; service R37', async () => {
    const env = await setupFiscal();
    const q = await env.req('POST', '/v1/fiscal/clearances', 'u-contribuable', {});
    expect(q.statusCode).toBe(200); // quitus actif du seed réutilisé
    expect(q.json()).toMatchObject({ reused: true, status: 'ACTIF', informative: true, check: 'VALIDE', validUntil: '2026-12-25' });
    const c = env.svc.clearances.clearances.all()[0]!;
    const pub = await env.req('GET', `/v1/public/fiscal/clearances/${c.shortCode}?s=${c.signature}`);
    expect(pub.json()).toMatchObject({ result: 'VALIDE', number: c.number });
    const raw = JSON.stringify(pub.json());
    expect(raw).not.toContain('Mbuyi');
    expect(raw).not.toContain(env.app.ctx.taxpayers.get(DEMO.taxpayerId).iuc);
    expect((await env.req('GET', `/v1/public/fiscal/clearances/${c.shortCode}?s=${'a'.repeat(24)}`)).json().result).toBe('SIGNATURE_INVALIDE');
    const svc = await env.req('GET', `/v1/fiscal/clearances/verify/${c.shortCode}`, 'u-fiscal-urbanisme');
    expect(svc.json()).toMatchObject({ valid: true, result: 'VALIDE' });
    expect((await env.req('GET', `/v1/fiscal/clearances/verify/${c.shortCode}`, 'u-agent-terrain')).statusCode).toBe(403);
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'clearance.verified_by_service').length).toBeGreaterThan(0);
    // Validité limitée : ambre à 15 jours, expiré ensuite.
    advance(env, 80);
    expect((await env.req('GET', `/v1/public/fiscal/clearances/${c.shortCode}`)).json().result).toBe('BIENTOT_EXPIRE');
    advance(env, 11);
    expect((await env.req('GET', `/v1/public/fiscal/clearances/${c.shortCode}`)).json().result).toBe('EXPIRE');
  });

  it('refusé si obligation exigible impayée ; paiement non rapproché insuffisant ; recours en cours exclu', async () => {
    const env = await setupFiscal();
    advance(env, 31); // l'obligation de démonstration (échéance 2026-10-26) devient exigible
    const e = (await env.req('GET', '/v1/fiscal/clearances/eligibility', 'u-contribuable')).json();
    expect(e.eligible).toBe(false);
    expect(e.blockers[0]).toMatchObject({ reason: 'IMPAYEE' });
    // Le quitus du seed reste actif mais la revue PROPOSE sa révocation (aucune révocation automatique).
    const review = (await env.req('GET', '/v1/fiscal/clearances/review', 'u-fiscal-chef-service')).json();
    expect(review.some((x: { taxpayerId: string }) => x.taxpayerId === DEMO.taxpayerId)).toBe(true);
    expect(env.svc.clearances.clearances.all()[0]!.status).toBe('ACTIF');
    const rev = await env.req('POST', `/v1/fiscal/clearances/${env.svc.clearances.clearances.all()[0]!.id}/revoke`, 'u-fiscal-chef-service', { reason: 'Obligation échue non régularisée' });
    expect(rev.json().check).toBe('REVOQUE');
    expect((await env.req('POST', `/v1/fiscal/clearances/${rev.json().id}/revoke`, 'u-contribuable', { reason: 'test' })).statusCode).toBe(403);

    const refused = await env.req('POST', '/v1/fiscal/clearances', 'u-contribuable', {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('CLEARANCE_NOT_ELIGIBLE');

    // Paiement confirmé (quittance provisoire) : insuffisant tant que non rapproché.
    const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    const cb = await signedCallback(env, callbackBody(env, order.paymentReference));
    expect(cb.statusCode).toBe(200);
    const e2 = (await env.req('GET', '/v1/fiscal/clearances/eligibility', 'u-contribuable')).json();
    expect(e2.blockers[0]).toMatchObject({ reason: 'EN_ATTENTE_DE_RAPPROCHEMENT' });

    // Contribuable A (échéance dépassée) : un recours en cours suspend l'effet bloquant.
    const obA = env.app.ctx.assessment.byTaxpayer('TP-FISC-DEMO-01')[0]!;
    env.app.ctx.users.add({ id: 'u-test-tp-a', name: 'Contribuable A (test)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-FISC-DEMO-01' });
    expect((await env.req('GET', '/v1/fiscal/clearances/eligibility', 'u-test-tp-a')).json().eligible).toBe(false);
    const appeal = await env.req('POST', '/v1/appeals', 'u-test-tp-a', { obligationId: obA.id, grounds: 'Je ne suis pas propriétaire de ce bien.' });
    expect(appeal.statusCode).toBe(201);
    const ok = await env.req('POST', '/v1/fiscal/clearances', 'u-test-tp-a', {});
    expect(ok.statusCode).toBe(201);
    expect(ok.json().basis.contestedExcluded).toContain(obA.id);
    expect((await env.req('GET', '/v1/fiscal/clearances?taxpayerId=TP-FISC-DEMO-01', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Fiscal — attestation de bail', () => {
  it('délivrée aux parties du bail, vérifiable sans nom ni loyer ; refusée à un tiers', async () => {
    const env = await setupFiscal();
    const leases = (await env.req('GET', '/v1/fiscal/leases', 'u-locataire')).json();
    expect(leases[0]).toMatchObject({ id: DEMO.leaseId, role: 'LOCATAIRE' });
    expect(leases[0].attestation.issuedToRole).toBe('LOCATAIRE');
    const a = await env.req('POST', `/v1/fiscal/leases/${DEMO.leaseId}/attestations`, 'u-contribuable');
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ issuedToRole: 'BAILLEUR', lease: { lessee: 'Nzuzi Makiese', rent: { amount: '450.00' } } });
    const att = env.svc.clearances.attestations.findOne((x) => x.issuedTo === DEMO.taxpayerId)!;
    const pub = (await env.req('GET', `/v1/public/fiscal/lease-attestations/${att.shortCode}?s=${att.signature}`)).json();
    expect(pub).toMatchObject({ result: 'VALIDE', commune: 'Limete' });
    expect(JSON.stringify(pub)).not.toMatch(/Nzuzi|Mbuyi|450/);
    env.app.ctx.users.add({ id: 'u-test-tiers', name: 'Tiers (test)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-FISC-DEMO-01' });
    expect((await env.req('POST', `/v1/fiscal/leases/${DEMO.leaseId}/attestations`, 'u-test-tiers')).json().code).toBe('NOT_A_LEASE_PARTY');
  });
});

describe('Fiscal — carte à deux couches', () => {
  it('public : agrégats par commune, masqués sous 20 objets ; contribuable : ses biens ; agent : son périmètre', async () => {
    const env = await setupFiscal();
    const pub = (await env.req('GET', '/v1/fiscal/map?layer=situation')).json();
    expect(pub.scope).toBe('PUBLIC');
    expect(pub.objects).toHaveLength(0);
    const lim = pub.communes.find((c: { commune: string }) => c.commune === 'Limete');
    expect(lim.masked).toBe(false);
    expect(lim.total).toBeGreaterThanOrEqual(20);
    expect(pub.communes.find((c: { commune: string }) => c.commune === 'Matete')).toMatchObject({ masked: true, total: null, byColor: null });

    const tp = (await env.req('GET', '/v1/fiscal/map?layer=couverture', 'u-contribuable')).json();
    expect(tp.scope).toBe('CONTRIBUABLE');
    expect(tp.legend.find((l: { color: string }) => l.color === 'green').label).toMatch(/Vérifié/);
    expect(tp.objects.every((o: { id: string }) => ['OBJ-DEMO-PARCELLE-01', 'OBJ-DEMO-UNITE-01', 'OBJ-FISC-DEMO-COPRO-01'].includes(o.id))).toBe(true);

    const agent = (await env.req('GET', '/v1/fiscal/map?layer=situation', 'u-agent-terrain')).json();
    expect(agent.scope).toBe('AGENT');
    expect(agent.objects.every((o: { commune: string }) => ['Limete', 'Lemba', 'Matete'].includes(o.commune))).toBe(true);
    expect(agent.objects.some((o: { color: string }) => o.color === 'red')).toBe(true);
    expect(JSON.stringify(agent)).not.toMatch(/"amount"/);
  });
});

describe('Fiscal — non-régression du socle', () => {
  it('le seed du module ne modifie pas les obligations du contribuable de démonstration', async () => {
    const env = await setupFiscal();
    expect((await env.req('GET', '/v1/obligations', 'u-contribuable')).json()).toHaveLength(1);
    const o = (await env.req('GET', `/v1/obligations/${env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id}`, 'u-contribuable')).json();
    expect(o.trace.adjustments).toBeUndefined();
    expect(o.explanation.adjustments).toBeUndefined();
  });
});
