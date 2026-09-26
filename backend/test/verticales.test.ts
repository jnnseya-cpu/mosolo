import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { verticalesPlugin, type VerticalesService } from '../src/plugins/verticales/plugin.js';
import { VX_DEMO } from '../src/plugins/verticales/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setupVx(): Promise<TestEnv & { svc: VerticalesService }> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [verticalesPlugin],
  });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req, svc: app.ctx.ext.verticales as VerticalesService };
}

const idem = () => ({ 'idempotency-key': randomUUID() });
const HASH = 'a'.repeat(64);

async function pay(env: TestEnv, obligationId: string, user = 'u-contribuable') {
  const order = await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, idem());
  expect(order.statusCode).toBe(201);
  const o = order.json();
  const cb = await signedCallback(env, callbackBody(env, o.paymentReference, o.amount));
  expect(cb.statusCode).toBe(200);
  return o;
}

describe('verticales — catalogue et espaces branchés sur le socle', () => {
  it('catalogue public : seize verticales (§ 11.3), statut juridique honnête, cartes des modules externes conservées', async () => {
    const env = await setupVx();
    const res = await env.req('GET', '/v1/verticales');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { slug: string; legal: string; managedBy: string | null; entity: string }[];
    expect(items).toHaveLength(16); // § 11.3 v3.0 : Markets & Public Domain fusionnés
    expect(items.map((v) => v.slug)).toEqual(expect.arrayContaining(['rakapay', 'stationnement', 'publicite', 'avia', 'marches', 'evenements', 'construction', 'environnement', 'telecom', 'ports', 'mobilite']));
    expect(items.find((v) => v.slug === 'rakapay')!.managedBy).toBe('rakapay');
    expect(items.find((v) => v.slug === 'avia')!.legal).toBe('ACTE_REQUIS');
    expect(items.find((v) => v.slug === 'ports')!.legal).toBe('CADRAGE_REQUIS');
    // Aucune verticale ne se déclare « confirmée » : aucune règle sectorielle n'est certifiée.
    expect(items.some((v) => v.legal === 'CONFIRME')).toBe(false);
    const marches = (await env.req('GET', '/v1/verticales/marches')).json();
    expect(marches.rules[0]).toMatchObject({ code: 'DEMO-VX-MCH-ETAL', status: 'ACTIVE', demo: true, notice: 'Règle fictive de démonstration, non opposable' });
    expect((await env.req('GET', '/v1/verticales/inconnue')).statusCode).toBe(404);
  });

  it('espace du contribuable démo : objets dans plusieurs verticales et communes, obligations issues de règles fictives publiées', async () => {
    const env = await setupVx();
    const summary = (await env.req('GET', '/v1/verticales/me/summary', 'u-contribuable')).json().items as { slug: string; objects: number; obligations: number }[];
    const withObjects = summary.filter((s) => s.objects > 0).map((s) => s.slug);
    expect(withObjects).toEqual(expect.arrayContaining(['propriete', 'locatif', 'entreprises', 'mobilite', 'marches', 'evenements', 'construction', 'ports']));
    const communes = new Set<string>();
    for (const slug of ['marches', 'mobilite', 'evenements', 'construction']) {
      const s = (await env.req('GET', `/v1/verticales/${slug}/space`, 'u-contribuable')).json();
      expect(s.obligations.length).toBeGreaterThan(0);
      for (const o of s.obligations) {
        expect(o.demo).toBe(true);
        expect(o.ruleNotice).toBe('Règle fictive de démonstration, non opposable');
        expect(o.ruleStatus).toBe('ACTIVE');
        expect(typeof o.amount.amount).toBe('string');
        communes.add(o.commune);
      }
    }
    expect([...communes].sort()).toEqual(['Gombe', 'Kalamu', 'Lingwala', 'Ngaliema']);
    const marches = (await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json();
    expect(marches.obligations[0].amount).toEqual({ amount: '15000.00', currency: 'CDF' });
    expect(marches.stalls[0]).toMatchObject({ id: VX_DEMO.stallId, current: { status: 'GRIS' } });
    expect(marches.stalls[0].plateCode).toMatch(/^MCH-GMB-\d{6}-[0-9A-Z]$/);
  });

  it('verticales « acte requis » : aucune obligation, liquidation et facturation refusées et journalisées', async () => {
    const env = await setupVx();
    for (const slug of ['environnement', 'ports', 'stationnement', 'rakapay']) {
      const s = (await env.req('GET', `/v1/verticales/${slug}/space`, 'u-contribuable')).json();
      expect(s.obligations).toHaveLength(0);
    }
    const avia = (await env.req('GET', '/v1/verticales/avia/space', VX_DEMO.users.airline)).json();
    expect(avia.objects).toHaveLength(1);
    expect(avia.obligations).toHaveLength(0);
    const boat = (await env.req('GET', '/v1/verticales/ports/space', 'u-contribuable')).json().objects[0];
    const refused = await env.req('POST', `/v1/verticales/ports/objects/${boat.id}/liquidate`, VX_DEMO.users.instructor, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('ACTE_REQUIS');
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.some((e) => e.action === 'vertical.liquidation.refused' && e.outcome === 'DENIED')).toBe(true);
  });

  it('accès : un autre contribuable est refusé, le mandataire voit l’espace de son mandant', async () => {
    const env = await setupVx();
    expect((await env.req('GET', '/v1/verticales/marches/space?taxpayerId=TP-DEMO-0001', 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/verticales/marches/space?taxpayerId=TP-DEMO-0001', 'u-mandataire')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/verticales/marches/space')).statusCode).toBe(401);
  });
});

describe('verticales — marchés sans espèces : titre d’étal par le circuit commun', () => {
  it('paiement du titre → quittance provisoire dans l’espace ; titre VERT seulement après confirmation signée', async () => {
    const env = await setupVx();
    const space = (await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json();
    const obligationId = space.obligations[0].id as string;
    expect(space.receipts).toHaveLength(0);
    await pay(env, obligationId);
    const after = (await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json();
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0].status).toBe('PROVISOIRE');
    expect(after.stalls[0].current.status).toBe('VERT');
    expect(after.obligations[0].payable).toBe(false);
    // Règle 50 % / 1 % sur 30 jours : ambre à 16 j (47 % restant) et à 29 j (3 %), rouge encore valable à 29 j 20 h (0,6 %), puis échu.
    env.clock.advance(16 * 86_400_000);
    expect((await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json().stalls[0].current.status).toBe('AMBRE');
    env.clock.advance(13 * 86_400_000);
    expect((await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json().stalls[0].current.status).toBe('AMBRE');
    env.clock.advance(20 * 3_600_000);
    expect((await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json().stalls[0].current).toMatchObject({ status: 'ROUGE', validity: { band: 'ROUGE' } });
    env.clock.advance(86_400_000);
    expect((await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json().stalls[0].current.status).toBe('ECHU');
  });

  it('un seul titre en attente de paiement ; idempotence de la demande ; refus pour un tiers', async () => {
    const env = await setupVx();
    const dup = await env.req('POST', `/v1/verticales/marches/stalls/${VX_DEMO.stallId}/titles`, 'u-contribuable', { period: 'JOUR' }, idem());
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('TITLE_PENDING_PAYMENT');
    const obl = (await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json().obligations[0].id;
    await pay(env, obl);
    const key = idem();
    const first = await env.req('POST', `/v1/verticales/marches/stalls/${VX_DEMO.stallId}/titles`, 'u-contribuable', { period: 'JOUR' }, key);
    expect(first.statusCode).toBe(201);
    expect(first.json().obligation.amount).toEqual({ amount: '500.00', currency: 'CDF' });
    const replay = await env.req('POST', `/v1/verticales/marches/stalls/${VX_DEMO.stallId}/titles`, 'u-contribuable', { period: 'JOUR' }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().obligation.id).toBe(first.json().obligation.id);
    expect((await env.req('POST', `/v1/verticales/marches/stalls/${VX_DEMO.stallId}/titles`, 'u-locataire', { period: 'JOUR' }, idem())).statusCode).toBe(403);
  });

  it('demande d’emplacement : instruction, décision motivée par une autre personne, étal attribué', async () => {
    const env = await setupVx();
    const sub = await env.req('POST', '/v1/verticales/marches/cases', 'u-locataire', { type: 'DEMANDE_EMPLACEMENT', details: { stallId: 'MCH-GMB-C-1045', categorie: 'Pagne' }, documents: [{ label: 'Pièce d’identité', sha256: HASH }] }, idem());
    expect(sub.statusCode).toBe(201);
    const id = sub.json().id as string;
    expect((await env.req('POST', `/v1/verticales/cases/${id}/take`, VX_DEMO.users.chief)).statusCode).toBe(200);
    expect((await env.req('POST', `/v1/verticales/cases/${id}/propose`, VX_DEMO.users.chief, { outcome: 'ACCEPTER', reason: 'Étal libre, pièces conformes.' })).statusCode).toBe(200);
    const self = await env.req('POST', `/v1/verticales/cases/${id}/decide`, VX_DEMO.users.chief, { decision: 'ACCEPTE', reason: 'Je valide ma propre proposition.' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    // Aucun agent R11 ne décide ; la décision revient au chef de service (R07) ou au DG (R06).
    expect((await env.req('POST', `/v1/verticales/cases/${id}/decide`, VX_DEMO.users.instructor, { decision: 'ACCEPTE', reason: 'Tentative.' })).statusCode).toBe(403);
    env.app.ctx.users.add({ id: 'vx-dg-dgtk', name: 'DG DGTK (test)', roles: ['R06'], entity: 'DGTK' });
    const ok = await env.req('POST', `/v1/verticales/cases/${id}/decide`, 'vx-dg-dgtk', { decision: 'ACCEPTE', reason: 'Conforme à la proposition.' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().createdObjectId).toBeTruthy();
    const plan = (await env.req('GET', '/v1/verticales/marches/plan')).json().markets[0];
    expect(plan.stalls.find((s: { id: string }) => s.id === 'MCH-GMB-C-1045').occupied).toBe(true);
  });

  it('signalement de demande d’espèces : protégé, instruit par l’anti-fraude, invisible des agents de la régie', async () => {
    const env = await setupVx();
    const cases = (await env.req('GET', '/v1/verticales/cases?vertical=marches', VX_DEMO.users.instructor)).json() as { type: string }[];
    expect(cases.some((c) => c.type === 'SIGNALEMENT_DEMANDE_ESPECES')).toBe(false);
    const inv = (await env.req('GET', '/v1/verticales/cases?vertical=marches', 'u-enqueteur')).json() as { type: string; taxpayerId: string | null; protectedReport: boolean }[];
    const report = inv.find((c) => c.type === 'SIGNALEMENT_DEMANDE_ESPECES')!;
    expect(report.protectedReport).toBe(true);
    expect(report.taxpayerId).toBeNull();
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'fraud.cash_request_reported').length).toBeGreaterThan(0);
  });
});

describe('verticales — démarches génériques', () => {
  it('dépôt idempotent avec pièces par empreinte, complément demandé, reprise automatique de l’instruction', async () => {
    const env = await setupVx();
    const obj = (await env.req('GET', '/v1/verticales/entreprises/space', 'u-contribuable')).json().objects[0];
    const key = idem();
    const body = { type: 'SIGNALEMENT_CESSATION', objectId: obj.id, details: { dateEffet: '2026-10-01', motif: 'Fermeture définitive de la boutique.' }, documents: [{ label: 'Attestation', sha256: HASH }] };
    const a = await env.req('POST', '/v1/verticales/entreprises/cases', 'u-contribuable', body, key);
    const b = await env.req('POST', '/v1/verticales/entreprises/cases', 'u-contribuable', body, key);
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect((await env.req('POST', '/v1/verticales/entreprises/cases', 'u-contribuable', { ...body, documents: [{ label: 'x', sha256: 'pas-une-empreinte' }] }, idem())).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/verticales/entreprises/cases', 'u-contribuable', body)).json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const id = a.json().id;
    await env.req('POST', `/v1/verticales/cases/${id}/take`, VX_DEMO.users.instructor);
    const info = await env.req('POST', `/v1/verticales/cases/${id}/request-info`, VX_DEMO.users.instructor, { note: 'Merci de joindre l’acte de radiation.' });
    expect(info.json().status).toBe('COMPLEMENT_DEMANDE');
    const docs = await env.req('POST', `/v1/verticales/cases/${id}/documents`, 'u-contribuable', { documents: [{ label: 'Acte de radiation', sha256: 'b'.repeat(64) }] });
    expect(docs.json().status).toBe('EN_INSTRUCTION');
    await env.req('POST', `/v1/verticales/cases/${id}/propose`, VX_DEMO.users.instructor, { outcome: 'ACCEPTER', reason: 'Cessation prouvée.' });
    const dec = await env.req('POST', `/v1/verticales/cases/${id}/decide`, VX_DEMO.users.chief, { decision: 'ACCEPTE', reason: 'Cessation constatée.' });
    expect(dec.statusCode).toBe(200);
    const space = (await env.req('GET', '/v1/verticales/entreprises/space', 'u-contribuable')).json();
    expect(space.objects[0].cessation).toMatchObject({ dateEffet: '2026-10-01' });
    // Motif obligatoire pour toute décision.
    expect((await env.req('POST', `/v1/verticales/cases/${id}/decide`, VX_DEMO.users.chief, { decision: 'REFUSE', reason: '' })).statusCode).toBe(400);
  });

  it('un contribuable ne dépose pas pour l’objet d’un autre ; un agent hors entité ne peut pas instruire', async () => {
    const env = await setupVx();
    const obj = (await env.req('GET', '/v1/verticales/entreprises/space', 'u-contribuable')).json().objects[0];
    const r = await env.req('POST', '/v1/verticales/entreprises/cases', 'u-locataire', { type: 'SIGNALEMENT_CESSATION', objectId: obj.id, details: { dateEffet: '2026-10-01', motif: 'Tentative.' } }, idem());
    expect(r.statusCode).toBe(403);
    const pending = (await env.req('GET', '/v1/verticales/cases?vertical=propriete', 'u-controleur')).json()[0];
    expect((await env.req('POST', `/v1/verticales/cases/${pending.id}/take`, VX_DEMO.users.instructor)).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/verticales/cases/${pending.id}/take`, 'u-controleur')).statusCode).toBe(200);
  });
});

describe('verticales — construction : visite et quitus de chantier', () => {
  it('quitus refusé tant que la visite conforme et le paiement des droits manquent ; délivré ensuite, vérifiable publiquement', async () => {
    const env = await setupVx();
    const quitus = (await env.req('GET', '/v1/verticales/cases?vertical=construction&status=EN_INSTRUCTION', VX_DEMO.users.instructor)).json()[0];
    const blocked = await env.req('POST', `/v1/verticales/cases/${quitus.id}/propose`, VX_DEMO.users.instructor, { outcome: 'ACCEPTER', reason: 'Fin de travaux.' });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('CONDITIONS_UNMET');
    expect(blocked.json().unmet.map((u: { code: string }) => u.code).sort()).toEqual(['DUES_SETTLED', 'VISIT_CONFORME', 'VISIT_DONE']);
    // Un agent hors territoire ne peut pas consigner la visite.
    expect((await env.req('POST', `/v1/verticales/cases/${quitus.id}/visits`, 'u-agent-terrain', { date: '2026-09-26', result: 'CONFORME', observations: 'Constat hors zone.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/verticales/cases/${quitus.id}/visits`, VX_DEMO.users.fieldAgent, { date: '2026-09-26', result: 'CONFORME', observations: 'Travaux achevés, voie libérée.', evidenceSha256: HASH })).statusCode).toBe(201);
    const space = (await env.req('GET', '/v1/verticales/construction/space', 'u-contribuable')).json();
    await pay(env, space.obligations[0].id);
    const ok = await env.req('POST', `/v1/verticales/cases/${quitus.id}/propose`, VX_DEMO.users.instructor, { outcome: 'ACCEPTER', reason: 'Visite conforme, droits réglés.' });
    expect(ok.statusCode).toBe(200);
    // Le visiteur ne peut pas décider (séparation des tâches) — ici l'agent de terrain n'a pas le rôle ; la cheffe décide.
    const dec = await env.req('POST', `/v1/verticales/cases/${quitus.id}/decide`, VX_DEMO.users.chief, { decision: 'ACCEPTE', reason: 'Conditions remplies.' });
    expect(dec.statusCode).toBe(200);
    const code = dec.json().certificateCode as string;
    expect(code).toMatch(/^QTC-2026-/);
    const pub = (await env.req('GET', `/v1/public/verticales/certificates/${code}`)).json();
    expect(pub).toMatchObject({ authentique: true, statut: 'VALIDE', type: 'Quitus de chantier', commune: 'Ngaliema' });
    expect(JSON.stringify(pub)).not.toMatch(/Mbuyi|TP-DEMO/);
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'clearance.issued').length).toBeGreaterThan(0);
  });
});

describe('verticales — événements : certificat QR, billetterie, contrôle', () => {
  it('certificat public minimal, double liquidation refusée, contrôle de jauge sans sanction', async () => {
    const env = await setupVx();
    const space = (await env.req('GET', '/v1/verticales/evenements/space', 'u-contribuable')).json();
    const cert = space.certificates[0];
    expect(cert.kind).toBe('AUTORISATION_EVENEMENT');
    expect((await env.req('GET', `/v1/public/verticales/certificates/${cert.code}`)).json()).toMatchObject({ authentique: true, commune: 'Lingwala' });
    expect((await env.req('GET', '/v1/public/verticales/certificates/EVT-0000-00000-X')).json().authentique).toBe(false);
    const evt = space.objects[0].id;
    expect(space.obligations[0].amount).toEqual({ amount: '2400000.00', currency: 'CDF' });
    const again = await env.req('POST', `/v1/verticales/evenements/objects/${evt}/liquidate`, VX_DEMO.users.instructor, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('DOUBLE_BILLING');
    const ctl = await env.req('POST', `/v1/verticales/evenements/events/${evt}/controls`, VX_DEMO.users.fieldAgent, { observedAttendance: 15000 });
    expect(ctl.statusCode).toBe(201);
    expect(ctl.json().controls[0]).toMatchObject({ gap: 3000 });
    expect(ctl.json().controls[0].note).toMatch(/aucune sanction automatique/);
    const after = (await env.req('GET', '/v1/verticales/evenements/space', 'u-contribuable')).json();
    expect(after.obligations).toHaveLength(1);
    expect(after.obligations[0].amount).toEqual(space.obligations[0].amount);
    expect((await env.req('POST', `/v1/verticales/evenements/events/${evt}/ticketing`, 'u-contribuable', { ticketsSold: 1, source: 'DECLARATION_MANUELLE' })).json().code).toBe('TICKETING_ALREADY_LIQUIDATED');
  });
});

describe('verticales — plaques NFIU', () => {
  it('vérification publique : ni nom, ni adresse, ni montant ; couleur de situation (le Cahier prévaut)', async () => {
    const env = await setupVx();
    const plate = (env.app.ctx.ext.verticales as VerticalesService).plates.findOne((p) => p.kind === 'NFIU')!;
    const pub = (await env.req('GET', `/v1/public/verticales/plates/${plate.code}`)).json();
    expect(pub).toEqual({
      code: plate.code, authentique: true, type: 'Plaque fiscale immobilière (NFIU)', statut: 'EN_SERVICE', enregistre: true, commune: 'Limete', quartier: 'Kingabwa',
      situation: { color: expect.stringMatching(/^(green|amber|red|grey)$/), label: expect.any(String) }, message: 'Plaque authentique, objet enregistré.',
    });
    expect(JSON.stringify(pub)).not.toMatch(/Mbuyi|TP-DEMO|"amount"|lastPayment/);
    expect((await env.req('GET', '/v1/public/verticales/plates/KIN-LMT-999999-Z')).json().authentique).toBe(false);
  });

  it('pose dans le territoire seulement, une plaque par objet, remplacement tracé', async () => {
    const env = await setupVx();
    const unit = 'OBJ-DEMO-UNITE-01';
    expect((await env.req('POST', '/v1/verticales/plates', 'u-agent-terrain', { objectId: unit })).json().code).toBe('PLATE_NOT_APPLICABLE');
    const parcel = 'OBJ-DEMO-PARCELLE-01';
    expect((await env.req('POST', '/v1/verticales/plates', 'u-agent-gombe', { objectId: parcel })).statusCode).toBe(403);
    const dup = await env.req('POST', '/v1/verticales/plates', 'u-agent-terrain', { objectId: parcel });
    expect(dup.statusCode).toBe(409);
    const old = dup.json().plateCode as string;
    const rep = await env.req('POST', `/v1/verticales/plates/${old}/replace`, 'u-agent-terrain', { reason: 'Plaque endommagée par la pluie.' });
    expect(rep.statusCode).toBe(201);
    expect((await env.req('GET', `/v1/public/verticales/plates/${old}`)).json().statut).toBe('REMPLACEE');
    const report = (await env.req('GET', '/v1/verticales/plates-report/daily?date=2026-09-26', 'u-superviseur')).json();
    expect(report.agents.find((a: { agentId: string }) => a.agentId === 'u-agent-terrain')).toMatchObject({ platesIssued: 2, scans: 1 });
    expect((await env.req('GET', '/v1/verticales/plates-report/daily', 'u-contribuable')).statusCode).toBe(403);
  });

  it('scan agent journalisé : accès minimal sans montant pour l’agent de terrain ; guichet : obligations payables par plaque', async () => {
    const env = await setupVx();
    const plate = (env.app.ctx.ext.verticales as VerticalesService).plates.findOne((p) => p.kind === 'ETAL')!;
    const field = (await env.req('GET', `/v1/verticales/plates/${plate.code}/scan`, VX_DEMO.users.fieldAgent)).json();
    expect(field.access).toBe('minimal');
    expect(field.obligations).toBeUndefined();
    expect(field.situation.color).toBe('amber');
    expect(field.stallTitle.status).toBe('GRIS');
    const ctrl = (await env.req('GET', `/v1/verticales/plates/${plate.code}/scan`, VX_DEMO.users.instructor)).json();
    expect(ctrl.access).toBe('full');
    expect(ctrl.obligations[0].amount).toEqual({ amount: '15000.00', currency: 'CDF' });
    expect((await env.req('GET', `/v1/verticales/plates/${plate.code}/scan`, 'u-contribuable')).statusCode).toBe(403);
    const counter = (await env.req('GET', `/v1/verticales/plates/${plate.code}/counter`, 'u-guichet')).json();
    expect(counter.obligations).toHaveLength(1);
    const order = await env.req('POST', `/v1/obligations/${counter.obligations[0].id}/payment-orders`, 'u-guichet', { channel: 'AGENT_POINT' }, idem());
    expect(order.statusCode).toBe(201);
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.filter((e) => e.action === 'vertical.plate.scanned').length).toBeGreaterThanOrEqual(3);
  });
});

describe('verticales — AVIA : rapprochement, contradictoire, validation, jamais de facturation automatique', () => {
  it('écart constaté → procédure contradictoire → observations → validation par une autre personne → facturation refusée (acte requis)', async () => {
    const env = await setupVx();
    const list = (await env.req('GET', '/v1/verticales/avia/declarations', VX_DEMO.users.airline)).json() as { id: string; status: string; reconciliation: { gaps: { passengers: number }; passengerGapRate: string } }[];
    const gap = list.find((d) => d.status === 'ECART_CONSTATE')!;
    expect(gap.reconciliation.gaps.passengers).toBe(376);
    expect(gap.reconciliation.passengerGapRate).toBe('11.1');
    const early = await env.req('POST', `/v1/verticales/avia/declarations/${gap.id}/validate`, VX_DEMO.users.chief, { reason: 'Validation anticipée.' });
    expect(early.json().code).toBe('CONTRADICTORY_PROCEDURE_OPEN');
    expect((await env.req('POST', `/v1/verticales/avia/declarations/${gap.id}/validate`, VX_DEMO.users.instructor, { reason: 'Par l’analyste.' })).statusCode).toBe(403);
    const obs = await env.req('POST', `/v1/verticales/avia/declarations/${gap.id}/observations`, VX_DEMO.users.airline, { text: 'Écart dû à des passagers en correspondance, pièces jointes.', documents: [HASH] });
    expect(obs.json().status).toBe('OBSERVATIONS_RECUES');
    expect((await env.req('POST', `/v1/verticales/avia/declarations/${gap.id}/billing`, VX_DEMO.users.chief)).json().code).toBe('AVIA_NOT_VALIDATED');
    const val = await env.req('POST', `/v1/verticales/avia/declarations/${gap.id}/validate`, VX_DEMO.users.chief, { reason: 'Observations examinées ; écart maintenu pour 376 passagers.' });
    expect(val.json().status).toBe('VALIDEE');
    const bill = await env.req('POST', `/v1/verticales/avia/declarations/${gap.id}/billing`, VX_DEMO.users.chief);
    expect(bill.statusCode).toBe(422);
    expect(bill.json().code).toBe('ACTE_REQUIS');
    expect(env.app.ctx.assessment.byTaxpayer(VX_DEMO.airlineTaxpayerId)).toHaveLength(0);
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.some((e) => e.action === 'avia.billing.refused')).toBe(true);
  });

  it('données de l’exploitant : partenaire de données seulement ; déclaration d’un mois non échu refusée ; aperçu sans montant', async () => {
    const env = await setupVx();
    expect((await env.req('POST', '/v1/verticales/avia/operator-data', VX_DEMO.users.airline, { period: '2026-08', airlineTaxpayerId: VX_DEMO.airlineTaxpayerId, source: 'DGM', flights: 1, passengersBoarded: 1, freightKg: 0 })).statusCode).toBe(403);
    const dgm = await env.req('POST', '/v1/verticales/avia/operator-data', VX_DEMO.users.airport, { period: '2026-08', airlineTaxpayerId: VX_DEMO.airlineTaxpayerId, source: 'DGM', flights: 54, passengersBoarded: 3386, passengersExited: 3380, freightKg: 1850 });
    expect(dgm.statusCode).toBe(201);
    const cur = await env.req('POST', '/v1/verticales/avia/declarations', VX_DEMO.users.airline, { period: '2026-09', aircraftObjectIds: [], flights: 1, passengersDeparting: 1, freightKg: 0 });
    expect(cur.json().code).toBe('PERIOD_NOT_CLOSED');
    const ov = (await env.req('GET', '/v1/verticales/avia/overview', VX_DEMO.users.instructor)).json();
    expect(ov.periods.length).toBe(2);
    expect(JSON.stringify(ov)).not.toMatch(/"amount"/);
    expect((await env.req('GET', '/v1/verticales/avia/overview', VX_DEMO.users.airline)).statusCode).toBe(403);
  });
});

describe('verticales — CALCU : ne bloque aucun paiement, gel seulement par décision humaine', () => {
  it('scores vert / ambre / rouge, rapports numérotés, jamais de blocage', async () => {
    const env = await setupVx();
    const ov = (await env.req('GET', '/v1/verticales/calcu/overview', 'u-auditeur')).json();
    expect(ov.totals).toMatchObject({ transactions: 3, vert: 1, ambre: 1, rouge: 1, blocked: 0 });
    expect(ov.transactions.every((t: { blocked: boolean }) => t.blocked === false)).toBe(true);
    const tx = await env.req('POST', '/v1/verticales/calcu/gateway/transactions', VX_DEMO.users.bank, { bank: 'Banque A', accountNumber: 'CD00 5555 0000', amount: { amount: '100.00', currency: 'CDF' }, at: '2026-09-26T08:00:00.000Z', beneficiary: 'Fournisseur Z', reference: 'R-1' });
    expect(tx.statusCode).toBe(201);
    expect(tx.json()).toMatchObject({ score: 'ROUGE', blocked: false });
    expect(tx.json().reportId).toMatch(/^CALCU-RPT-2026-/);
    expect((await env.req('GET', '/v1/verticales/calcu/overview', VX_DEMO.users.bank)).statusCode).toBe(403);
  });

  it('gel d’un dossier : organe de contrôle seulement, motif et base légale ; clôture par une autre personne', async () => {
    const env = await setupVx();
    const report = (await env.req('GET', '/v1/verticales/calcu/overview', 'u-auditeur')).json().reports[0];
    expect((await env.req('POST', `/v1/verticales/calcu/reports/${report.id}/freeze`, VX_DEMO.users.bank, { reason: 'Tentative de gel.', legalBasis: 'Aucune' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/verticales/calcu/reports/${report.id}/freeze`, 'u-auditeur', { reason: 'Gel.' })).statusCode).toBe(400);
    const frozen = await env.req('POST', `/v1/verticales/calcu/reports/${report.id}/freeze`, 'u-auditeur', { reason: 'Dossier à risque : pièces manquantes.', legalBasis: 'Texte instituant CALCU (J26) — démonstration' });
    expect(frozen.json().status).toBe('GELE');
    expect((await env.req('POST', `/v1/verticales/calcu/reports/${report.id}/close`, 'u-auditeur', { reason: 'Clôture par la même personne.' })).json().code).toBe('SEPARATION_OF_DUTIES');
  });

  it('validation conjointe d’un compte : trois personnes distinctes', async () => {
    const env = await setupVx();
    const acc = await env.req('POST', '/v1/verticales/calcu/accounts', VX_DEMO.users.publicEntity, { entityName: 'Entité test', bank: 'Banque A', accountNumber: 'CD00 7777 0001', currency: 'CDF', type: 'PROJET', signatories: ['Ordonnateur'] });
    expect(acc.statusCode).toBe(201);
    expect(acc.json().accountNumberMasked).toBe('•••• 0001');
    expect(JSON.stringify(acc.json())).not.toMatch(/7777/);
    expect((await env.req('POST', `/v1/verticales/calcu/accounts/${acc.json().id}/validate`, 'u-validateur-financier', { as: 'CONTROLE' })).statusCode).toBe(403);
    const v1 = await env.req('POST', `/v1/verticales/calcu/accounts/${acc.json().id}/validate`, 'u-validateur-financier', { as: 'FINANCES' });
    expect(v1.json().status).toBe('DECLARE');
    const v2 = await env.req('POST', `/v1/verticales/calcu/accounts/${acc.json().id}/validate`, 'u-auditeur', { as: 'CONTROLE' });
    expect(v2.json().status).toBe('VALIDE');
  });
});

describe('verticales — télécom et indicateurs', () => {
  it('site observé absent des listes : vérification contradictoire proposée, jamais de taxation', async () => {
    const env = await setupVx();
    const r = (await env.req('GET', '/v1/verticales/telecom/reconciliation', VX_DEMO.users.instructor)).json();
    expect(r).toMatchObject({ declared: 2, observed: 2, matched: 1 });
    expect(r.observedNotDeclared[0]).toMatchObject({ commune: 'Lingwala' });
    expect(r.observedNotDeclared[0].proposal).toMatch(/aucune taxation automatique/);
    expect(env.app.ctx.assessment.byTaxpayer(VX_DEMO.telecomTaxpayerId)).toHaveLength(0);
    expect((await env.req('GET', '/v1/verticales/telecom/reconciliation', VX_DEMO.users.telecom)).statusCode).toBe(403);
  });

  it('indicateurs agrégés réservés aux agents', async () => {
    const env = await setupVx();
    const ind = (await env.req('GET', '/v1/verticales/indicators', VX_DEMO.users.chief)).json();
    expect(ind.markets).toMatchObject({ stalls: 6, occupied: 1, paidOccupied: 0 });
    expect(ind.plates.nfiuInService).toBe(1);
    expect((await env.req('GET', '/v1/verticales/indicators', 'u-contribuable')).statusCode).toBe(403);
  });
});
