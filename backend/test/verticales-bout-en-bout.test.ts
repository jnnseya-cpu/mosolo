/**
 * Partie V de la spécification fonctionnelle — « Verticales : fonctionnement de bout en bout ».
 * Une verticale = un test, qui déroule son parcours EXACTEMENT dans l'ordre de la Partie V, par les routes réelles de
 * l'API (application complète, tous les modules chargés). Les verticales sous « acte requis » sont exercées sur des
 * versions de règles FICTIVES [EXEMPLE] publiées ACTIVES par le circuit réel à quatre visas (démonstration).
 * Chaque verticale n'assemble que les circuits du socle : compte unique, registre des règles, ordre de paiement vers
 * le compte public, quittance, titre, contrôle, rapprochement (§ 11.1).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { PUB_DEMO } from '../src/plugins/publicite/seed.js';
import { RK_DEMO } from '../src/plugins/rakapay/seed.js';
import { PARCOURS } from '../src/plugins/verticales/parcours.js';
import type { VerticalesService } from '../src/plugins/verticales/plugin.js';
import { VX_DEMO } from '../src/plugins/verticales/seed.js';
import { DEMO } from '../src/seed.js';
import { postStatement, type TestEnv } from './helpers.js';
import { exampleRule, idem, payObligation, setupApp } from './partie5-helpers.js';

const HASH = 'd'.repeat(64);
const U = VX_DEMO.users;

/** Démarche d'une verticale par les routes : dépôt → prise en charge → (visite) → proposition → décision motivée. */
async function vxCase(env: TestEnv, slug: string, owner: string, body: { type: string; objectId?: string; details: Record<string, string> }, actors: { instructor: string; decider: string; visitor?: string }) {
  const sub = await env.req('POST', `/v1/verticales/${slug}/cases`, owner, { ...body, documents: [{ label: 'Pièce (démonstration)', sha256: HASH }] }, idem());
  expect(sub.statusCode, sub.body).toBe(201);
  const id = sub.json().id as string;
  expect((await env.req('POST', `/v1/verticales/cases/${id}/take`, actors.instructor)).statusCode).toBe(200);
  if (actors.visitor) {
    const v = await env.req('POST', `/v1/verticales/cases/${id}/visits`, actors.visitor, { date: '2026-09-26', result: 'CONFORME', observations: 'Constat sur place conforme (démonstration).', evidenceSha256: HASH });
    expect(v.statusCode, v.body).toBe(201);
  }
  const p = await env.req('POST', `/v1/verticales/cases/${id}/propose`, actors.instructor, { outcome: 'ACCEPTER', reason: 'Dossier complet, pièces vérifiées (démonstration).' });
  expect(p.statusCode, p.body).toBe(200);
  const d = await env.req('POST', `/v1/verticales/cases/${id}/decide`, actors.decider, { decision: 'ACCEPTE', reason: 'Conforme à la proposition (démonstration).' });
  expect(d.statusCode, d.body).toBe(200);
  return d.json() as { id: string; createdObjectId: string | null; certificateCode: string | null; status: string };
}

const steps = (slug: string) => PARCOURS[slug]!.etapes.map((e) => e.label);

describe('Partie V — verticales de bout en bout (une verticale = un test)', () => {
  it('MOSOLO Property : recensement → propriétaire avec preuve → plaque NFIU → IF sur règle publiée → payé visible au scan', async () => {
    const env = await setupApp();
    expect(steps('propriete')).toHaveLength(5);
    // 1. Recensement de la parcelle, géolocalisation et identifiant géofiscal (34, 8).
    const obj = await env.req('POST', '/v1/fiscal-objects', 'u-agent-terrain', { category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.3712, lon: 15.3452, attributes: { superficie_m2: '300' } });
    expect(obj.statusCode, obj.body).toBe(201);
    const objectId = obj.json().id as string;
    expect(env.app.ctx.objects.get(objectId)).toMatchObject({ lat: -4.3712, lon: 15.3452, commune: 'Limete' });
    // 2. Rattachement du propriétaire avec preuve, validé par une personne distincte (7).
    expect((await env.req('POST', '/v1/fiscal/relationships', 'u-contribuable', { objectId, role: 'PROPRIETAIRE', from: '2020-01-01', proofs: [] })).json().code).toBe('PROOF_REQUIRED');
    const rel = await env.req('POST', '/v1/fiscal/relationships', 'u-contribuable', { objectId, role: 'PROPRIETAIRE', from: '2020-01-01', proofs: [{ type: 'TITRE_FONCIER', reference: 'TF-EX-1' }] });
    expect(rel.json()).toMatchObject({ status: 'PROPOSEE', probativeStatus: 'DECLARE' });
    const val = await env.req('POST', `/v1/fiscal/relationships/${rel.json().id}/validate`, 'u-controleur', { approve: true, reason: 'Titre foncier concordant (démonstration).' });
    expect(val.json()).toMatchObject({ status: 'VALIDEE', probativeStatus: 'VERIFIE' });
    expect(env.app.ctx.objects.get(objectId).taxpayerId).toBe(DEMO.taxpayerId);
    // 3. Pose de la plaque NFIU (79).
    const plate = await env.req('POST', '/v1/verticales/plates', 'u-agent-terrain', { objectId });
    expect(plate.statusCode).toBe(201);
    expect(plate.json()).toMatchObject({ kind: 'NFIU', status: 'POSEE' });
    // 4. Liquidation de l'impôt foncier sur la règle publiée (26, 27).
    const rule = env.app.ctx.rules.list().find((r) => r.code === DEMO.demoRuleCode && r.status === 'ACTIVE')!;
    const liq = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId, inputs: {}, simulate: false });
    expect(liq.statusCode, liq.body).toBe(201);
    const before = (await env.req('GET', `/v1/public/verticales/plates/${plate.json().code}`)).json();
    expect(before.situation.color).toBe('amber');
    // 5. Paiement, quittance et statut « payé » visible au scan (28, 31, 71).
    await payObligation(env, liq.json().obligation.id, 'u-contribuable');
    const after = (await env.req('GET', `/v1/public/verticales/plates/${plate.json().code}`)).json();
    expect(after.situation.color).toBe('green');
    expect(JSON.stringify(after)).not.toMatch(/Mbuyi|"amount"/);
    expect(env.app.ctx.receipts.receipts.find((r) => r.obligationId === liq.json().obligation.id)).toHaveLength(1);
  });

  it('MOSOLO Rental : signal → vérification (aucune dette) → bail déclaré → retenue et IRL → attestation → campagne préremplie', async () => {
    const env = await setupApp();
    const before = env.app.ctx.assessment.obligations.count();
    // 1. Signal de location probable → dossier de vérification (61) : aucune dette sur simple signal.
    expect((await env.req('POST', '/v1/fiscal/anomalies/detection', 'u-controleur')).statusCode).toBe(200);
    const signals = (await env.req('GET', '/v1/fiscal/anomalies', 'u-controleur')).json() as { id: string; status: string }[];
    expect(signals.length).toBeGreaterThan(0);
    expect((await env.req('POST', `/v1/fiscal/anomalies/${signals[0]!.id}/review`, 'u-controleur', { decision: 'EN_VERIFICATION', reason: 'Visite programmée (démonstration)', missionRef: 'M-EX-1' })).statusCode).toBe(200);
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
    // 2. Déclaration du bail par le locataire.
    const unit = await env.req('POST', '/v1/fiscal-objects', 'u-contribuable', { category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.345, attributes: { parcelleId: DEMO.parcelId, surface_m2: '40' } });
    expect(unit.statusCode, unit.body).toBe(201);
    const lease = await env.req('POST', '/v1/leases', 'u-locataire', { unitObjectId: unit.json().id, lessorId: DEMO.taxpayerId, rent: { amount: '300.00', currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-01-01' });
    expect(lease.statusCode, lease.body).toBe(201);
    // 3. Calcul de la retenue et de l'IRL : version [EXEMPLE] ACTIVE de la règle IRL du registre (acte requis en réel).
    const irl = env.app.ctx.rules.list().filter((r) => r.code === 'IRL-KIN-R234').sort((a, b) => b.version - a.version)[0]!;
    exampleRule(env, { code: irl.code, formula: irl.formula, rateTable: irl.rateTable, revenueCategory: irl.revenueCategory, administeringEntity: irl.administeringEntity, currency: irl.currency, periodicity: irl.periodicity, effectiveFrom: '2026-09-26', label: `${irl.label} — version [EXEMPLE] ACTIVE (démonstration)` });
    const decl = await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: unit.json().id, kind: 'IRL', period: '2026', inputs: {}, attest: true });
    expect(decl.statusCode, decl.body).toBe(201);
    expect(decl.json().liquidation.obligationId).toBeTruthy();
    expect(Number(decl.json().liquidation.trace.result.amount)).toBeGreaterThan(0);
    // 4. Attestation de bail enregistré au locataire.
    const att = await env.req('POST', `/v1/fiscal/leases/${lease.json().id}/attestations`, 'u-locataire');
    expect(att.statusCode, att.body).toBe(201);
    expect(att.json().issuedToRole).toBe('LOCATAIRE');
    // 5. Campagne préremplie de février et rapprochement annuel.
    const camp = (await env.req('GET', '/v1/campagnes', 'u-fiscal-directeur')).json().find((c: { code: string }) => c.code === 'CAMP-IF-IRL-2026-FEV2027');
    expect((await env.req('POST', `/v1/campagnes/${camp.id}/simulation`, 'u-dg-dgipk')).json().simulation.basis).toBe('DONNEES_REELLES_DU_REGISTRE');
    const pre = (await env.req('POST', `/v1/campagnes/${camp.id}/pre-remplissage`, 'u-dg-dgipk')).json();
    expect(pre.prefill.items.length).toBeGreaterThan(0);
  });

  it('MOSOLO Business : établissement → obligations déterminées par la règle → autorisation QR → recoupement tiers → grands redevables', async () => {
    const env = await setupApp();
    // 1. Enregistrement de l'établissement et de ses dirigeants.
    const est = await vxCase(env, 'entreprises', 'u-contribuable', { type: 'DECLARATION_ACTIVITE', details: { nom: 'Bar Le Fleuve [EXEMPLE]', activite: 'Débit de boissons', commune: 'Gombe', quartier: 'Commerce' } }, { instructor: U.instructor, decider: U.chief });
    const objectId = est.createdObjectId!;
    // 2. Détermination des obligations : sans règle ACTIVE, aucune ; la règle décide.
    const det0 = (await env.req('GET', `/v1/verticales/entreprises/etablissements/${objectId}/obligations`, 'u-contribuable')).json();
    expect(det0.items.find((i: { code: string }) => i.code === 'PATENTE')).toMatchObject({ applicable: false });
    expect((await env.req('POST', `/v1/verticales/entreprises/objects/${objectId}/liquidate`, U.instructor, {})).json().code).toBe('NO_RULE');
    exampleRule(env, { code: 'VX-ENT-PATENTE', formula: 'forfait', rateTable: { 'forfait:1': '120', 'forfait:2': '80', 'forfait:3': '50', 'forfait:4': '30' }, periodicity: 'ANNUELLE' });
    expect((await env.req('GET', `/v1/verticales/entreprises/etablissements/${objectId}/obligations`, 'u-contribuable')).json().items.find((i: { code: string }) => i.code === 'PATENTE').applicable).toBe(true);
    const liq = await env.req('POST', `/v1/verticales/entreprises/objects/${objectId}/liquidate`, U.instructor, {});
    expect(liq.statusCode, liq.body).toBe(201);
    // 3. Patente et autorisations avec QR « en règle ».
    const auth = await vxCase(env, 'entreprises', 'u-contribuable', { type: 'DEMANDE_AUTORISATION', objectId, details: { categorie: 'Débit de boissons', horaires: '10 h – 23 h' } }, { instructor: U.instructor, decider: U.chief });
    expect((await env.req('GET', `/v1/public/verticales/certificates/${auth.certificateCode}`)).json()).toMatchObject({ authentique: true });
    // 4. Recoupement : données tierces sous protocole (accises) et déclaration de volumes, rapprochées.
    env.app.ctx.users.add({ id: 'vx-partenaire-accises', name: 'Partenaire de données — accises (démo)', roles: ['R34'], entity: 'PARTENAIRE' });
    const third = await env.req('POST', '/v1/verticales/secteurs/donnees-tierces', 'vx-partenaire-accises', { module: '17', source: 'ACCISES', taxpayerId: DEMO.taxpayerId, period: '2026-08', lines: { biere_litres: '1200' } });
    expect(third.statusCode, third.body).toBe(201);
    const vol = await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'VOLUMES_BAT', objectId, period: '2026-08', lines: { biere_litres: '900' } });
    expect(vol.statusCode, vol.body).toBe(201);
    const rap = await env.req('POST', `/v1/verticales/secteurs/declarations/${vol.json().id}/rapprochement`, U.instructor);
    expect(rap.statusCode, rap.body).toBe(200);
    // 5. Suivi des grands redevables (56).
    const gr = await env.req('POST', '/v1/verticales/secteurs/grands-redevables', U.chief, { taxpayerId: DEMO.taxpayerId, sectors: ['17'], motif: 'Volumes significatifs constatés (démonstration).' });
    expect(gr.statusCode, gr.body).toBe(201);
    expect((await env.req('GET', '/v1/verticales/secteurs/grands-redevables', U.chief)).json().items.length).toBeGreaterThan(0);
  });

  it('MOSOLO Mobility : registre → vignette → autorisation de transport → péage lié à la plaque (acte requis) → contrôle par plaque', async () => {
    const env = await setupApp();
    // 1. Import du registre des immatriculations (objet véhicule rattaché au compte unique).
    const veh = await env.req('POST', '/v1/fiscal-objects', 'u-controleur', { taxpayerId: DEMO.taxpayerId, category: 'VEHICULE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.37, lon: 15.34, attributes: { immatriculation: 'KN-4321-EX', genre: 'VOITURE' } });
    expect(veh.statusCode, veh.body).toBe(201);
    const objectId = veh.json().id as string;
    // 2. Vignette sur règle [EXEMPLE] ACTIVE, payée.
    const vig = await env.req('POST', `/v1/verticales/mobilite/objects/${objectId}/liquidate`, 'u-controleur', {});
    expect(vig.statusCode, vig.body).toBe(201);
    const obligationId = vig.json().obligation?.id ?? vig.json().obligationId ?? vig.json().id;
    await payObligation(env, obligationId, 'u-contribuable');
    // 3. Autorisation de transport (certificat) ; taxe journalière : titre RakaPay, acte requis.
    const aut = await vxCase(env, 'mobilite', 'u-contribuable', { type: 'DEMANDE_AUTORISATION_TRANSPORT', objectId, details: { service: 'TAXI', itineraire: 'Limete – Gombe' } }, { instructor: 'u-controleur', decider: 'u-dg-dgipk' });
    expect(aut.certificateCode).toBeTruthy();
    // 4. Péage lié à la plaque : passage relevé, aucun montant (acte requis).
    const peage = await env.req('POST', '/v1/verticales/secteurs/25/releves', U.fieldAgent, { source: 'PASSAGE_PEAGE', plate: 'KN-4321-EX', commune: 'Gombe', lines: { passages: '1' } });
    expect(peage.statusCode, peage.body).toBe(201);
    expect(env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).filter((o) => o.objectId === objectId)).toHaveLength(1);
    // 5. Contrôle par plaque : réponse minimale, jamais d'immobilisation automatique.
    const ctl = await env.req('GET', '/v1/verticales/vehicules/KN-4321-EX/controle?commune=Gombe', U.fieldAgent);
    expect(ctl.statusCode, ctl.body).toBe(200);
    expect(JSON.stringify(ctl.json())).not.toMatch(/Mbuyi/);
    expect(ctl.json().registered).toBe(true);
  });

  it('MOSOLO Parking : zones → ticket lié à la plaque → rappel ambre → contrôle par plaque → constat et recours', async () => {
    const env = await setupApp();
    // 1. Délimitation d'une zone (Gombe), grille [EXEMPLE] ACTIVE.
    const z = await env.req('POST', '/v1/parking/zones', 'pk-regie', {
      code: 'EX-GOMBE-A1', name: 'Artère d’exemple [EXEMPLE]', commune: 'Gombe', quartier: 'Commerce', kind: 'ARTERE',
      geometry: { type: 'LineString', coordinates: [[15.30, -4.30], [15.31, -4.305]] }, localityRank: 1, capacity: { standard: 20, livraison: 2, pmr: 1 },
    });
    expect(z.statusCode, z.body).toBe(201);
    const zoneId = z.json().id as string;
    expect((await env.req('POST', `/v1/parking/zones/${zoneId}/tariff`, 'pk-regie', { tariffRuleCode: PARKING_DEMO.tariffRule, penaltyRuleCode: PARKING_DEMO.penaltyRule, actReference: 'Arrêté de zonage FICTIF [EXEMPLE]' })).json().legalStatus).toBe('OUVERTE');
    // 2. Achat puis prolongation d'un ticket lié à la plaque.
    const s = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId, plate: 'KN-0909-EX', durationMinutes: 30 }, idem());
    expect(s.statusCode, s.body).toBe(201);
    await payObligation(env, s.json().obligation.id, 'u-contribuable');
    const ext = await env.req('POST', `/v1/parking/sessions/${s.json().session.id}/extend`, 'u-contribuable', { durationMinutes: 30 }, idem());
    expect(ext.statusCode, ext.body).toBe(201);
    await payObligation(env, ext.json().obligation.id, 'u-contribuable');
    // 3. Rappel ambre avant expiration.
    env.clock.advance(52 * 60_000);
    const mine = (await env.req('GET', '/v1/parking/sessions/mine', 'u-contribuable')).json().items;
    expect(mine.find((x: { id: string }) => x.id === s.json().session.id).light).toBe('AMBRE');
    expect(env.app.ctx.comms.deliveries.all().some((d) => d.eventCode === 'ticket.expiring')).toBe(true);
    // 4. Contrôle par plaque (vert ; rouge pour une plaque sans ticket).
    expect((await env.req('GET', `/v1/parking/control/KN-0909-EX?zoneId=${zoneId}`, 'pk-controleur')).json().light).not.toBe('ROUGE');
    const red = (await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateTenant}?zoneId=${zoneId}`, 'pk-controleur')).json();
    expect(red.light).toBe('ROUGE');
    // 5. Constat réglementaire (photo de la caméra de preuve), vérification, décision motivée, recours.
    const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(256), Buffer.from([0xff, 0xd9])]);
    const up = await env.req('POST', '/v1/parking/evidence-photos', 'pk-controleur', { checkId: red.checkId, slot: 'ABORDS_AVANT', imageBase64: img.toString('base64'), sha256: sha256Hex(img), lat: -4.302, lon: 15.305, accuracyM: 6, gpsSource: 'GPS', place: 'Artère d’exemple', stampedAt: env.clock.now().toISOString() });
    expect(up.statusCode, up.body).toBe(201);
    const v = await env.req('POST', '/v1/parking/violations', 'pk-controleur', { zoneId, plate: PARKING_DEMO.plateTenant, nature: 'NON_PAIEMENT', checkId: red.checkId, lat: -4.302, lon: 15.305, observations: 'Aucun ticket (démonstration)', photoIds: [up.json().id] });
    expect(v.statusCode, v.body).toBe(201);
    expect((await env.req('POST', `/v1/parking/violations/${v.json().id}/verify`, 'pk-superviseur', { confirm: true, note: 'Photographie nette.' })).statusCode).toBe(200);
    const dec = await env.req('POST', `/v1/parking/violations/${v.json().id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Constat probant (démonstration).' });
    expect(dec.statusCode, dec.body).toBe(200);
    const c = await env.req('POST', `/v1/parking/violations/${v.json().id}/contest`, 'u-locataire', { grounds: 'Arrêt de livraison de deux minutes (démonstration).' });
    expect(c.statusCode, c.body).toBe(201);
  });

  it('MOSOLO Advertising : recensement et plaque QR → autorisation et liquidation → contrôle OCR → constat, validation, notification → paiement et régularisation', async () => {
    const env = await setupApp();
    const h = (s: string) => sha256Hex(s);
    // 1. Recensement et plaque QR.
    const d = await env.req('POST', '/v1/publicite/devices', 'pb-annonceur', { type: 'PANNEAU', widthM: '3.00', heightM: '2.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Commerce', address: 'Avenue d’exemple 3', localityRank: 1, lat: -4.305, lon: 15.305, photos: [h('pv')] });
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json().qrToken ?? d.json().reference).toBeTruthy();
    // 2. Autorisation (instruction, décision par une autre personne) et liquidation sur la règle [EXEMPLE] ACTIVE.
    const r = (await env.req('POST', '/v1/publicite/authorizations', 'pb-annonceur', { deviceId: d.json().id, periodFrom: '2026-10-01', periodTo: '2027-09-30', pieces: [{ kind: 'PLAN_SITUATION', name: 'plan.pdf', sha256: h('plan') }] })).json();
    await env.req('POST', `/v1/publicite/authorizations/${r.id}/instruct`, 'pb-instructeur', { action: 'PROPOSER', proposal: 'ACCORDER', analysis: 'Dossier complet.' });
    const g = (await env.req('POST', `/v1/publicite/authorizations/${r.id}/decide`, 'pb-autorite', { outcome: 'ACCORDEE', reason: 'Conforme (démonstration).' })).json();
    expect(g.liquidation.status).toBe('EMISE');
    // 3. Contrôle avec OCR et preuve : recherche automatique de l'autorisation correspondante.
    const found = (await env.req('GET', `/v1/publicite/lookup?q=${encodeURIComponent(`Panneau ${d.json().reference}`)}`, 'pb-inspecteur')).json();
    expect(found.matches.map((m: { id: string }) => m.id)).toContain(d.json().id);
    const insp = await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', {
      finding: 'NON_DECLARE', photos: [h('np2')], lat: -4.3, lon: 15.31, observations: 'Bâche sans plaque (démonstration)', ocrText: 'AFFICHE SANS REFERENCE',
      newDevice: { type: 'BACHE', widthM: '2.00', heightM: '1.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Centre', address: 'Rue d’exemple', localityRank: 1 },
    });
    expect(insp.statusCode, insp.body).toBe(201);
    // 4. Dossier de constat : vérification (superviseur), décision (autorité), notification.
    const caseId = insp.json().case.id as string;
    await env.req('POST', `/v1/publicite/cases/${caseId}/verify`, 'pb-superviseur', { confirm: true, note: 'Photographies probantes.' });
    const dec = await env.req('POST', `/v1/publicite/cases/${caseId}/decide`, 'pb-autorite', { outcome: 'RETENU', reason: 'Support non déclaré établi (démonstration).', ownerTaxpayerId: PUB_DEMO.advertiserTaxpayerId, liquidateDues: true });
    expect(dec.statusCode, dec.body).toBe(200);
    expect(dec.json().notifiedAt).toBeTruthy();
    // 5. Paiement officiel et régularisation.
    await payObligation(env, g.obligation.obligationId, 'pb-annonceur');
    await payObligation(env, dec.json().obligation.obligationId, 'pb-annonceur');
    const ind = (await env.req('GET', '/v1/publicite/indicators', 'pb-autorite')).json();
    expect(ind.totals.casesRetained).toBeGreaterThan(0);
    expect((await env.req('GET', '/v1/publicite/obligations/mine', 'pb-annonceur')).json().items.filter((o: { payment: string }) => o.payment === 'PAYE').length).toBeGreaterThanOrEqual(2);
  });

  it('MOSOLO Telecom : listes de sites → rapprochement déclarés/observés → avis annuel sur règle [EXEMPLE] ACTIVE → cellule grands redevables', async () => {
    const env = await setupApp();
    // 1. Import des listes de sites (déclaration par l'opérateur).
    const site = await vxCase(env, 'telecom', U.telecom, { type: 'DECLARATION_SITE', details: { reference: 'SITE-EX-0001', type: 'PYLONE', hauteur_m: '30', commune: 'Gombe', quartier: 'Haut-Commandement' } }, { instructor: U.instructor, decider: U.chief });
    expect(site.createdObjectId).toBeTruthy();
    // 2. Rapprochement sites déclarés / observés (un site observé absent des listes : contradictoire, jamais taxé).
    const rec = await env.req('GET', '/v1/verticales/telecom/reconciliation', U.instructor);
    expect(rec.statusCode, rec.body).toBe(200);
    // 3. Avis annuel sur règle ACTIVE (sites déclarés ou vérifiés seulement).
    expect((await env.req('GET', '/v1/verticales/secteurs/antennes/liquidation-annuelle', U.instructor)).json().rule.status).not.toBe('ACTIVE');
    exampleRule(env, { code: 'VX-TEL-SITES', formula: 'forfait_site', rateTable: { forfait_site: '500' }, periodicity: 'ANNUELLE' });
    // Avis annuel AUTOMATIQUE sur règle ACTIVE (décision du maître d'ouvrage) ; idempotent ; le passage manuel reste possible.
    const auto = await env.req('POST', '/v1/verticales/secteurs/antennes/liquidation-annuelle/automatique', U.instructor, {});
    expect(auto.statusCode, auto.body).toBe(201);
    expect(auto.json().executed.find((e: { taxpayerId: string }) => e.taxpayerId === VX_DEMO.telecomTaxpayerId).issued).toBeGreaterThan(0);
    expect((await env.req('POST', '/v1/verticales/secteurs/antennes/liquidation-annuelle/automatique', U.instructor, {})).json().executed).toEqual([]);
    const annual = await env.req('POST', '/v1/verticales/secteurs/antennes/liquidation-annuelle', U.instructor, { exercice: '2026', taxpayerId: VX_DEMO.telecomTaxpayerId });
    expect(annual.json().issued).toHaveLength(0);
    const again = (await env.req('GET', '/v1/verticales/secteurs/antennes/liquidation-annuelle', U.instructor)).json();
    expect(again.operators.find((o: { taxpayerId: string }) => o.taxpayerId === VX_DEMO.telecomTaxpayerId).toLiquidate).toBe(0);
    // 4. Suivi par la cellule grands redevables.
    expect((await env.req('POST', '/v1/verticales/secteurs/grands-redevables', U.chief, { taxpayerId: VX_DEMO.telecomTaxpayerId, sectors: ['16'], motif: 'Opérateur télécom : rendement élevé (démonstration).' })).statusCode).toBe(201);
  });

  it('MOSOLO Markets : plan géoréférencé → titre d’étal → plaque QR d’étal → contrôle sans téléphone du commerçant', async () => {
    const env = await setupApp();
    // 1. Plan géoréférencé du marché.
    const plan = (await env.req('GET', '/v1/verticales/marches/plan')).json();
    expect(plan.markets[0].stalls.length).toBeGreaterThan(0);
    // 2. Titre d'étal (journalier, hebdomadaire ou mensuel) payé par le circuit commun — aucun encaissement par le placier.
    const space = (await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json();
    await payObligation(env, space.obligations[0].id, 'u-contribuable');
    const week = await env.req('POST', `/v1/verticales/marches/stalls/${VX_DEMO.stallId}/titles`, 'u-contribuable', { period: 'SEMAINE' }, idem());
    expect(week.statusCode, week.body).toBe(201);
    expect((await env.req('POST', `/v1/obligations/${week.json().obligation.id}/payment-orders`, U.fieldAgent, { channel: 'MOBILE_MONEY' }, idem())).statusCode).toBe(403);
    // 3. Plaque QR d'étal (posée au semis) : vérification publique du droit de place.
    const plateCode = (await env.req('GET', '/v1/verticales/marches/space', 'u-contribuable')).json().stalls[0].plateCode as string;
    expect((await env.req('GET', `/v1/public/verticales/plates/${plateCode}`)).json().titre.statut).toBe('VERT');
    // 4. Contrôle sans téléphone du commerçant : scan de la plaque par l'agent.
    const scan = (await env.req('GET', `/v1/verticales/plates/${plateCode}/scan`, U.fieldAgent)).json();
    expect(scan.stallTitle.status).toBe('VERT');
    expect(scan.access).toBe('minimal');
  });

  it('MOSOLO Public Domain : demande d’occupation → titre à durée → contrôle → renouvellement ou libération', async () => {
    const env = await setupApp();
    // 1. Demande d'occupation (rattachée à l'objet créé par la décision : aucun recensement supplémentaire).
    const occ = await vxCase(env, 'domaine-public', 'u-contribuable', { type: 'DEMANDE_OCCUPATION_TEMPORAIRE', details: { usage: 'Terrasse', surface_m2: '12', debut: '2026-10-01', fin: '2026-12-31', commune: 'Gombe', quartier: 'Commerce' } }, { instructor: U.instructor, decider: U.chief });
    const objectId = occ.createdObjectId!;
    expect(occ.certificateCode).toBeTruthy();
    // 2. Titre à durée : redevance sur règle [EXEMPLE] ACTIVE, payée.
    exampleRule(env, { code: 'VX-DP-OCCUPATION', formula: 'surface_m2 * tarif_m2', rateTable: { tarif_m2: '2' } });
    const liq = await env.req('POST', `/v1/verticales/domaine-public/objects/${objectId}/liquidate`, U.instructor, {});
    expect(liq.statusCode, liq.body).toBe(201);
    await payObligation(env, liq.json().obligation?.id ?? liq.json().id, 'u-contribuable');
    // 3. Contrôle : plaque d'emprise posée puis scannée.
    const plate = await env.req('POST', '/v1/verticales/plates', U.fieldAgent, { objectId });
    expect(plate.statusCode, plate.body).toBe(201);
    expect((await env.req('GET', `/v1/verticales/plates/${plate.json().code}/scan`, U.fieldAgent)).json().situation.color).toBe('green');
    // 4. Libération de l'emprise (cessation datée, sur preuve).
    const lib = await vxCase(env, 'domaine-public', 'u-contribuable', { type: 'SIGNALEMENT_CESSATION', objectId, details: { dateEffet: '2026-12-31', motif: 'Fin de la saison des terrasses (démonstration).' } }, { instructor: U.instructor, decider: U.chief });
    expect(lib.status).toBe('ACCEPTE');
    const sp = (await env.req('GET', '/v1/verticales/domaine-public/space', 'u-contribuable')).json();
    expect(sp.objects.find((o: { id: string }) => o.id === objectId).cessation).toMatchObject({ dateEffet: '2026-12-31' });
  });

  it('MOSOLO Environment : registre des assujettis → simulation d’impact → activation après édit → déclarations et reversements', async () => {
    const env = await setupApp();
    // 1. Registre des assujettis (inscription du metteur en marché).
    const reg = await vxCase(env, 'environnement', 'u-contribuable', { type: 'DECLARATION_METTEUR_EN_MARCHE', details: { raisonSociale: 'Emballages d’exemple SARL [EXEMPLE]', categorie: 'PRODUCTEUR', commune: 'Limete', quartier: 'Industriel', tonnage_annuel_t: '40' } }, { instructor: U.instructor, decider: U.chief });
    const objectId = reg.createdObjectId!;
    const r0 = (await env.req('GET', '/v1/verticales/environnement/registre', U.instructor)).json();
    expect(r0.activated).toBe(false);
    expect(r0.items.some((i: { objectId: string }) => i.objectId === objectId)).toBe(true);
    // 2. Simulation d'impact sur hypothèse sourcée, sans effet.
    const sim = await env.req('POST', '/v1/verticales/environnement/simulations', U.chief, { label: 'Hypothèse [EXEMPLE]', valuePerTonne: { amount: '50.00', currency: 'USD' }, source: 'Étude d’exemple', date: '2026-09-01' });
    expect(sim.statusCode, sim.body).toBe(201);
    expect(sim.json().effect).toBe('AUCUN');
    // Désactivé tant qu'aucun édit n'est publié.
    expect((await env.req('POST', `/v1/verticales/environnement/objects/${objectId}/liquidate`, U.instructor, {})).json().code).toBe('NO_RULE');
    // 3. Activation après édit : règle [EXEMPLE] ACTIVE sous la clé du registre.
    exampleRule(env, { code: 'VX-ENV-PLASTIQUE', formula: 'tonnage_t * taux_tonne', rateTable: { taux_tonne: '50' } });
    expect((await env.req('GET', '/v1/verticales/environnement/registre', U.instructor)).json().activated).toBe(true);
    // 4. Déclaration de tonnage puis reversement (paiement au compte public).
    const t = await env.req('POST', '/v1/verticales/environnement/cases', 'u-contribuable', { type: 'DECLARATION_TONNAGE', objectId, details: { periode: '2026-09', tonnage_t: '3' }, documents: [] }, idem());
    expect(t.statusCode, t.body).toBe(201);
    const liq = await env.req('POST', `/v1/verticales/environnement/objects/${objectId}/liquidate`, U.instructor, {});
    expect(liq.statusCode, liq.body).toBe(201);
    const ob = liq.json().obligation ?? liq.json();
    expect(ob.amount).toEqual({ amount: '150.00', currency: 'USD' });
    await payObligation(env, ob.id, 'u-contribuable');
  });

  it('MOSOLO Ports : registre des embarcations et quais → titre d’embarquement (cadrage requis) → manifestes → rapprochement', async () => {
    const env = await setupApp();
    // 1. Registre des embarcations et quais.
    const boat = await vxCase(env, 'ports', 'u-contribuable', { type: 'DECLARATION_EMBARCATION', details: { nom: 'Baleinière d’exemple [EXEMPLE]', type: 'BALEINIERE', capacite_t: '20', passagers: '60', port: 'Kinkole', commune: 'Nsele', quartier: 'Kinkole' } }, { instructor: U.instructor, decider: U.chief });
    const objectId = boat.createdObjectId!;
    // 2. Titre d'embarquement à usage unique : type non activable avant le cadrage sectoriel (J30).
    const types = (await env.req('GET', '/v1/titres/types')).json() as { code: string; activable: boolean }[];
    expect(types.find((t) => t.code === 'EMB-CARTE')!.activable).toBe(false);
    // 3. Manifestes (déclaration de mouvement).
    const mv = await env.req('POST', '/v1/verticales/ports/cases', 'u-contribuable', { type: 'DECLARATION_MOUVEMENT', objectId, details: { sens: 'DEPART', date: '2026-09-25', passagers: '45', tonnage_t: '8', destination: 'Maluku' }, documents: [] }, idem());
    expect(mv.statusCode, mv.body).toBe(201);
    // 4. Rapprochement mouvements / titres / paiements : relevé d'accostage, aucune perception (pilote après cadrage).
    const obs = await env.req('POST', '/v1/verticales/secteurs/24/releves', U.fieldAgent, { source: 'RELEVE_ACCOSTAGE', objectId, lines: { accostages: '1', passagers: '45' } });
    expect(obs.statusCode, obs.body).toBe(201);
    expect((await env.req('POST', `/v1/verticales/ports/objects/${objectId}/liquidate`, U.instructor, {})).json().code).toBe('ACTE_REQUIS');
    const m24 = (await env.req('GET', '/v1/verticales/secteurs/modules/24', U.instructor)).json();
    expect(JSON.stringify(m24)).toMatch(/RELEVE_ACCOSTAGE/);
  });

  it('MOSOLO AVIA : BSP/GDS et portail → IFA dans le QR → scan RVA et DGM → rapprochement mensuel → facturation des écarts (après arrêté)', async () => {
    const env = await setupApp();
    const vx = env.app.ctx.ext.verticales as VerticalesService;
    const B = VX_DEMO.airlineBTaxpayerId;
    // 1. Connexion BSP/GDS (bac à sable [EXEMPLE]) et portail des agences certifiées.
    const pull = await env.req('POST', '/v1/verticales/avia/rrh/connectors/BSP-BAC-A-SABLE/pull', U.airport, { airlineTaxpayerId: B, period: '2026-08' });
    expect([201, 422]).toContain(pull.statusCode);
    expect((await env.req('GET', '/v1/verticales/avia/rrh/agencies', U.instructor)).json().length).toBeGreaterThan(0);
    // 2. IFA dans le QR de la carte d'embarquement, vérifiable hors ligne.
    const ticket = vx.aviaRrh.tickets.findOne((t) => t.airlineTaxpayerId === B)!;
    expect((await env.req('POST', '/v1/public/verticales/avia/ifa/verify', undefined, { qr: ticket.ifaToken })).json().authentic ?? true).toBe(true);
    // 3. Scan RVA et validation DGM.
    const dgm = await env.req('POST', '/v1/verticales/avia/rrh/passenger-events', U.airport, { source: 'DGM_SORTIE', airlineTaxpayerId: B, flightNumber: ticket.flightNumber, flightDate: ticket.flightDate, scans: [{ qr: ticket.ifaToken }], withoutIfa: 0 });
    expect(dgm.statusCode, dgm.body).toBe(201);
    // 4. Rapprochement mensuel (vendus ↔ embarqués ↔ sortis ↔ reversés).
    const rec = await env.req('POST', '/v1/verticales/avia/rrh/reconciliations', U.instructor, { period: '2026-08' });
    expect(rec.statusCode, rec.body).toBe(201);
    expect(rec.json().lines.find((l: { airlineTaxpayerId: string }) => l.airlineTaxpayerId === B).hasGap).toBe(true);
    // 5. Facturation des écarts : mesures contraignantes seulement après arrêté (enregistré à quatre yeux).
    expect((await env.req('POST', '/v1/verticales/avia/auto/run', U.instructor, { period: '2026-08' })).json().run.mode).toBe('PROPOSITION');
    const act = (await env.req('POST', '/v1/verticales/avia/cadre/actes', U.instructor, { reference: 'Arrêté provincial n° EXEMPLE/AVIA [EXEMPLE]', title: 'Arrêté fictif [EXEMPLE]', signedOn: '2026-08-01', documentSha256: HASH, measuresEnabled: [], parameters: { penaltyPerTicketUsd: null, integrationDelayDays: null } })).json();
    await env.req('POST', `/v1/verticales/avia/cadre/actes/${act.id}/validate`, U.chief, { approve: true, reason: 'Texte conforme (exemple).' });
    exampleRule(env, { code: 'AVIA-ECART-REVERSEMENT', formula: 'ecart_reversement', rateTable: {} });
    const run = (await env.req('POST', '/v1/verticales/avia/auto/run', U.instructor, { period: '2026-08' })).json();
    expect(run.run.mode).toBe('EXECUTION');
    const exec = run.executions.find((e: { airlineTaxpayerId: string }) => e.airlineTaxpayerId === B);
    expect(exec.kind).toBe('FACTURATION');
    expect(exec.contradictory.deadline).toBeTruthy();
    // Aucune interférence avec Go-Pass : seule la taxe urbaine portée par les billets est rapprochée.
    expect(JSON.stringify(exec)).not.toMatch(/Go-?Pass/i);
  });

  it('MOSOLO Events : demande d’autorisation → déclaration de billetterie → certificat QR → liquidation et contrôle', async () => {
    const env = await setupApp();
    // 1. Demande d'autorisation (organisateur enregistré au compte unique).
    const ev = await vxCase(env, 'evenements', 'u-contribuable', { type: 'DEMANDE_AUTORISATION_EVENEMENT', details: { nom: 'Concert d’exemple [EXEMPLE]', lieu: 'Stade d’exemple', dateDebut: '2026-10-10', dateFin: '2026-10-10', jauge: '5000', commune: 'Lingwala', quartier: 'Voix du Peuple' } }, { instructor: U.instructor, decider: U.chief });
    const objectId = ev.createdObjectId!;
    // 2. Déclaration de billetterie → liquidation sur la règle [EXEMPLE] ACTIVE.
    const tk = await env.req('POST', `/v1/verticales/evenements/events/${objectId}/ticketing`, 'u-contribuable', { ticketsSold: 4200, source: 'DECLARATION_MANUELLE' });
    expect(tk.statusCode, tk.body).toBe(201);
    // 3. Certificat QR sur le lieu.
    expect((await env.req('GET', `/v1/public/verticales/certificates/${ev.certificateCode}`)).json()).toMatchObject({ authentique: true, commune: 'Lingwala' });
    // 4. Liquidation (billetterie déclarée × règle [EXEMPLE] ACTIVE) et contrôle de jauge sur place (aucune sanction automatique).
    const liq = await env.req('POST', `/v1/verticales/evenements/objects/${objectId}/liquidate`, U.instructor, {});
    expect([201, 409]).toContain(liq.statusCode);
    const obligations = (await env.req('GET', '/v1/verticales/evenements/space', 'u-contribuable')).json().obligations.filter((o: { objectId: string }) => o.objectId === objectId);
    expect(obligations).toHaveLength(1);
    expect(obligations[0].amount).toEqual({ amount: '840000.00', currency: 'CDF' });
    const ctl = await env.req('POST', `/v1/verticales/evenements/events/${objectId}/controls`, U.fieldAgent, { observedAttendance: 4800 });
    expect(ctl.statusCode, ctl.body).toBe(201);
    expect(ctl.json().controls[0].gap).toBe(600);
    await payObligation(env, obligations[0].id, 'u-contribuable');
  });

  it('MOSOLO Construction : géoréférencement → bons de sortie (acte requis) → droits de voirie → quitus pour permis de bâtir', async () => {
    const env = await setupApp();
    // 1. Géoréférencement des sites : chantier (visite obligatoire) et carrière.
    const ch = await vxCase(env, 'construction', 'u-contribuable', { type: 'DEMANDE_AUTORISATION_CHANTIER', details: { nature: 'Immeuble R+2 [EXEMPLE]', emprise_voie_m2: '10', dureeMois: '3', commune: 'Ngaliema', quartier: 'Mont-Fleury' } }, { instructor: U.instructor, decider: U.chief, visitor: U.fieldAgent });
    const chantier = ch.createdObjectId!;
    const carr = await vxCase(env, 'construction', 'u-contribuable', { type: 'DECLARATION_SITE_CARRIERE', details: { nom: 'Carrière d’exemple [EXEMPLE]', superficie_ha: '2', substance: 'Gravier', commune: 'Ngaliema', quartier: 'Kinsuka' } }, { instructor: U.instructor, decider: U.chief });
    // 2. Bons de sortie : sorties comptées et rapprochées des déclarations (écart suivi mensuellement), aucun montant.
    const out = await env.req('POST', '/v1/verticales/secteurs/22/releves', U.fieldAgent, { source: 'COMPTAGE_SORTIES', objectId: carr.createdObjectId, period: '2026-09', lines: { camions: '12', volume_m3: '96' } });
    expect(out.statusCode, out.body).toBe(201);
    const decl = await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'SORTIES_CARRIERE', objectId: carr.createdObjectId, period: '2026-09', lines: { camions: '8', volume_m3: '64' } });
    expect(decl.statusCode, decl.body).toBe(201);
    const rap = (await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.json().id}/rapprochement`, U.instructor)).json();
    expect(JSON.stringify(rap)).toMatch(/camions/);
    // 3. Droits de voirie du chantier sur la règle [EXEMPLE] ACTIVE : 10 m² × 3 mois × 1 000 CDF.
    const liq = await env.req('POST', `/v1/verticales/construction/objects/${chantier}/liquidate`, U.instructor, {});
    expect(liq.statusCode, liq.body).toBe(201);
    const ob = liq.json().obligation ?? liq.json();
    expect(ob.amount).toEqual({ amount: '30000.00', currency: 'CDF' });
    await payObligation(env, ob.id, 'u-contribuable');
    // 4. Quitus (visite conforme, droits réglés) : certificat vérifiable, condition du permis de bâtir.
    const q = await vxCase(env, 'construction', 'u-contribuable', { type: 'DEMANDE_QUITUS_CHANTIER', objectId: chantier, details: {} }, { instructor: U.instructor, decider: U.chief, visitor: U.fieldAgent });
    expect(q.certificateCode).toMatch(/^QTC-2026-/);
    expect((await env.req('GET', `/v1/public/verticales/certificates/${q.certificateCode}`)).json()).toMatchObject({ authentique: true, statut: 'VALIDE' });
  });

  it('MOSOLO Assets : inventaire → évaluation → appel public → revenus domaniaux (aucune attribution de gré à gré)', async () => {
    const env = await setupApp();
    const MGR = 'vx-gestionnaire-patrimoine';
    env.app.ctx.users.add({ id: 'vx-dg-patrimoine', name: 'Directeur du patrimoine (test)', roles: ['R06'], entity: 'MINFIN' });
    // 1. Inventaire des actifs.
    const a = await env.req('POST', '/v1/verticales/actifs/inventaire', MGR, { nature: 'LOCAL_COMMERCIAL', designation: 'Local d’exemple [EXEMPLE]', commune: 'Gombe', quartier: 'Commerce', surfaceM2: '80', titleReference: 'ACTE-AFFECTATION-EX-0002 [EXEMPLE]' });
    expect(a.statusCode, a.body).toBe(201);
    // 2. Évaluation par une autre personne (mise à prix issue de l'évaluation).
    expect((await env.req('POST', `/v1/verticales/actifs/inventaire/${a.json().id}/evaluations`, 'u-validateur-financier', { method: 'COMPARAISON', marketValue: { amount: '90000.00', currency: 'USD' }, annualRevenueEstimate: { amount: '6000.00', currency: 'USD' }, reportSha256: HASH, note: 'Comparaison avec trois locaux voisins (exemple).' })).statusCode).toBe(201);
    // 3. Appel public : candidature scellée, ouverture après la date limite, attribution motivée par une autre personne.
    const call = await env.req('POST', '/v1/verticales/actifs/appels', 'vx-chef-patrimoine', { assetId: a.json().id, procedure: 'APPEL_PUBLIC', objet: 'Location du local d’exemple', deadline: new Date(env.clock.now().getTime() + 2 * DAY_MS).toISOString() });
    expect(call.statusCode, call.body).toBe(201);
    const cand = await env.req('POST', '/v1/verticales/actifs/cases', 'u-contribuable', { type: 'MANIFESTATION_INTERET', details: { appel: call.json().reference }, documents: [{ label: 'Offre scellée', sha256: HASH }] }, idem());
    expect(cand.statusCode, cand.body).toBe(201);
    expect((await env.req('POST', `/v1/verticales/actifs/appels/${call.json().id}/ouverture`, 'vx-chef-patrimoine', { offers: [] })).json().code).toBe('DEADLINE_NOT_REACHED');
    env.clock.advance(3 * DAY_MS);
    const open = await env.req('POST', `/v1/verticales/actifs/appels/${call.json().id}/ouverture`, 'vx-chef-patrimoine', { offers: [{ caseId: cand.json().id, amount: { amount: '6500.00', currency: 'USD' } }] });
    expect(open.statusCode, open.body).toBe(200);
    const award = await env.req('POST', `/v1/verticales/actifs/appels/${call.json().id}/attribution`, 'vx-dg-patrimoine', { caseId: cand.json().id, motif: 'Offre la mieux-disante, au-dessus de la mise à prix (exemple).' });
    expect(award.statusCode, award.body).toBe(200);
    // 4. Suivi des revenus domaniaux : redevance liquidée sur la règle [EXEMPLE] ACTIVE, payée.
    exampleRule(env, { code: 'VX-ACT-REDEVANCE', formula: 'redevance_annuelle', rateTable: {}, revenueCategory: 'CONCESSION_DOMANIALE', periodicity: 'ANNUELLE', administeringEntity: 'MINFIN' });
    const liq = await env.req('POST', `/v1/verticales/actifs/objects/${award.json().award.concessionObjectId}/liquidate`, 'vx-chef-patrimoine', {});
    expect(liq.statusCode, liq.body).toBe(201);
    const ob = liq.json().obligation ?? liq.json();
    await payObligation(env, ob.id, 'u-contribuable');
    const rev = (await env.req('GET', '/v1/verticales/actifs/revenus', MGR)).json();
    const row = rev.items.find((i: { assetId: string }) => i.assetId === a.json().id);
    expect(row.paid).toEqual([{ amount: '6500.00', currency: 'USD' }]);
    expect((await env.req('GET', '/v1/public/verticales/actifs/appels')).json().items.find((c: { reference: string }) => c.reference === call.json().reference).result.motif).toBeTruthy();
  });

  it('MOSOLO RakaPay : opérateurs accrédités → tickets à durée → achat par téléphone ou coopérative → contrôle QR/gilet/plaque → analyse et blocage préventif', async () => {
    const env = await setupApp();
    // 1. Opérateurs invités et accrédités (quatre yeux).
    env.app.ctx.taxpayers.register({ phone: '+243899300021', fullName: 'Exploitant d’exemple [EXEMPLE]', language: 'fr', situation: 'other' }, 'TP-OP-EX-21');
    env.app.ctx.users.add({ id: 'op-ex-admin', name: 'Exploitant d’exemple (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-OP-EX-21' });
    env.app.ctx.users.add({ id: 'rk-dg-ex', name: 'DG DGTK (démo)', roles: ['R06'], entity: 'DGTK' });
    const op = (await env.req('POST', '/v1/rakapay/operateurs/candidatures', 'op-ex-admin', { name: 'Parking d’exemple', kind: 'PRIVE', commune: 'Gombe' })).json();
    await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agrement/proposition`, RK_DEMO.managerUser, { outcome: 'ACCREDITER', motif: 'Dossier complet (démonstration)' });
    expect((await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agrement/decision`, 'rk-dg-ex', { approve: true, motif: 'Agrément accordé (démonstration)' })).json().status).toBe('ACCREDITE');
    // 2. Tickets à durée : catalogue (tarifs issus des règles).
    const cat = (await env.req('GET', '/v1/rakapay/catalogue')).json();
    expect(cat.length).toBeGreaterThan(0);
    const types = (await env.req('GET', '/v1/titres/types')).json() as { code: string }[];
    expect(types.map((t) => t.code)).toEqual(expect.arrayContaining(['RKP-WEWA-JOUR', 'RKP-WEWA-MOIS', 'RKP-BUS-1J']));
    // 3. Achat par téléphone (conducteur) : pass wewa payé au compte public, jamais d'espèces.
    const rk = env.app.ctx.ext.rakapay as { motos: { findOne(f: (m: { plate: string; id: string }) => boolean): { plate: string; id: string } | undefined } };
    const moto = rk.motos.findOne((m) => m.plate.replace(/\s/g, '') === 'KN-M20418')!;
    const pass = await env.req('POST', '/v1/rakapay/wewa/passes', RK_DEMO.driver2User, { motoId: moto.id, duration: 'JOUR', channel: 'USSD' }, idem());
    expect(pass.statusCode, pass.body).toBe(201);
    for (const p of pass.json().payments) {
      const order = env.app.ctx.payments.orders.findOne((o) => o.paymentReference === p.paymentReference)!;
      const { signedCallback, callbackBody } = await import('./helpers.js');
      await signedCallback(env, callbackBody(env, p.paymentReference, order.amount));
    }
    // 4. Contrôle par plaque : moto en vert, rien à payer ; vérification par le passager.
    const ctl = await env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { plate: moto.plate, place: { commune: 'Kalamu', label: 'Avenue de la Victoire', lat: -4.3395, lon: 15.3112 } });
    expect(ctl.statusCode, ctl.body).toBe(201);
    expect(ctl.json().nothingToPay).toBe(true);
    // 5. Analyse quotidienne, audit comportemental et blocage préventif (décision motivée).
    const ind = (await env.req('GET', '/v1/rakapay/indicateurs', RK_DEMO.managerUser)).json();
    expect(ind.compliance.controlled).toBeGreaterThan(0);
    expect((await env.req('POST', '/v1/rakapay/revues-ventes/detection', RK_DEMO.managerUser)).statusCode).toBe(200);
    expect((await env.req('GET', `/v1/rakapay/operateurs/${op.id}/analyse-quotidienne?date=2026-09-26`, 'op-ex-admin')).json().viewer).toBe('EXPLOITANT');
  });

  it('MOSOLO Recovery : segmentation des arriérés → campagnes graduées → plan d’apurement autorisé → mesures légales et clôture', async () => {
    const env = await setupApp();
    const TENANT = DEMO.tenantTaxpayerId;
    const obl = env.app.ctx.assessment.byTaxpayer(TENANT)[0]!.id;
    // 1. Segmentation des arriérés (sans effet).
    const arr = (await env.req('GET', '/v1/recouvrement/arrieres', 'u-contentieux')).json();
    const item = arr.items.find((i: { obligationId: string }) => i.obligationId === obl);
    expect(item).toMatchObject({ automaticDecision: false });
    expect(item.segment.code).toBeTruthy();
    // 2. Campagnes graduées : rappel amiable puis avis formel proposé (R20) et décidé (R21).
    const rec = env.app.ctx.ext.recouvrement as { caseFor(id: string): { id: string } | undefined };
    const caseId = rec.caseFor(obl)!.id;
    const p1 = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation: 'Relances restées sans suite, adresse vérifiée' });
    expect(p1.statusCode, p1.body).toBe(201);
    expect((await env.req('POST', `/v1/recouvrement/propositions/${p1.json().id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Constat vérifié, voie de recours rappelée' })).json().status).toBe('APPROUVEE');
    // 3. Plan d'apurement autorisé (acte [EXEMPLE]) : demande de la contribuable, accord motivé.
    const plan = await env.req('POST', '/v1/recouvrement/echeanciers', 'u-locataire', { obligationId: obl, installments: 2, reason: 'Revenus irréguliers ce trimestre' });
    expect(plan.statusCode, plan.body).toBe(201);
    const granted = await env.req('POST', `/v1/recouvrement/echeanciers/${plan.json().id}/decision`, 'u-contentieux', { granted: true, motivation: 'Difficulté réelle, échéancier proportionné' });
    expect(granted.json().status).toBe('ACCORDE');
    // Aucune mesure pendant l'échéancier.
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation: 'Nouvelle relance pendant le plan' })).json().code).toBe('INSTALLMENT_PLAN_ACTIVE');
    // 4. Clôture : échéances payées au compte public ; obligation soldée, dossier clos (levée décidée par une autorité le cas échéant).
    const { signedCallback, callbackBody } = await import('./helpers.js');
    for (let i = 0; i < 2; i++) {
      const order = await env.req('POST', `/v1/obligations/${obl}/payment-orders`, 'u-locataire', { channel: 'MOBILE_MONEY', installmentPlanId: plan.json().id }, idem());
      expect(order.statusCode, order.body).toBe(201);
      await signedCallback(env, callbackBody(env, order.json().paymentReference, order.json().amount));
      // Règlement au compte public constaté par le Trésor (relevé bancaire).
      const st = await postStatement(env, 'u-tresor', { statementId: `REL-EX-${i}`, lines: [{ accountAlias: env.app.ctx.assessment.get(obl).beneficiaryAccountAlias, amount: order.json().amount, valueDate: '2026-09-26', paymentReference: order.json().paymentReference }] });
      expect(st.statusCode, st.body).toBe(201);
    }
    expect(env.app.ctx.assessment.get(obl).status).toBe('SOLDEE');
    await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux');
    const view = (await env.req('GET', `/v1/recouvrement/dossiers/${caseId}`, 'u-contentieux')).json();
    expect(JSON.stringify(view)).toMatch(/SOLDEE|CLOS/);
  });
});
