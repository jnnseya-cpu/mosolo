/**
 * Données de DÉMONSTRATION ParkSmart (fictives, non opposables) :
 * - deux zones RÉELLES proposées par le dossier source (Gombe intégrale, boulevard du 30 Juin) au statut ACTE_REQUIS ;
 * - deux zones FICTIVES liées à une grille et à un barème fictifs publiés par le circuit à quatre visas ;
 * - sessions payées par le circuit commun (rappel prestataire signé), contrôles, constats, réservation, partenaires.
 */
import type { AppContext } from '../../context.js';
import { sha256Hex } from '../../core/crypto.js';
import type { User } from '../../core/auth.js';
import { EVIDENCE_SLOTS } from './field.js';
import type { ParkingService } from './service.js';
import { demoPay, DEMO_INSTRUMENT, DGTK, DGTK_ALIAS, publishDemoRule } from './support.js';
import { seedParkSmart } from './seed-smart.js';

export const PARKING_DEMO = {
  tariffRule: 'DEMO-PARK-HORAIRE',
  penaltyRule: 'DEMO-PARK-PENALITE',
  merchantTaxpayerId: 'TP-PK-0001',
  zoneGombe: 'PKZ-DEMO-GOMBE',
  zoneLimete: 'PKZ-DEMO-LIMETE',
  zoneGombeReal: 'PKZ-GOMBE-INTEGRALE',
  zone30Juin: 'PKZ-BD-30-JUIN',
  plateOwner: 'KN-0001-DM',
  plateTenant: 'KN-0002-DM',
  plateMerchant: 'KN-0100-DM',
  plateUnknown: 'KN-0777-DM',
} as const;

/**
 * Photos de DÉMONSTRATION versées par le vrai chemin de la caméra de preuve (images JPEG fictives, empreinte vérifiée,
 * rattachées au contrôle rouge de l'agent) : le constat de démonstration suit le même circuit que la production.
 */
export function demoEvidencePhotos(svc: ParkingService, agent: User, checkId: string, seeds: string[], at: { lat: number; lon: number; place: string }): string[] {
  return seeds.map((seed, i) => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`MOSOLO-DEMO-${seed}`), Buffer.from([0xff, 0xd9])]);
    return svc.field.upload(agent, {
      checkId, slot: EVIDENCE_SLOTS[i % EVIDENCE_SLOTS.length]!, imageBase64: buf.toString('base64'), sha256: sha256Hex(buf),
      lat: at.lat, lon: at.lon, accuracyM: 6, gpsSource: 'GPS', place: at.place, stampedAt: svc.now().toISOString(),
    }).id;
  });
}

export function seedParking(ctx: AppContext, svc: ParkingService): void {
  const add = (u: Parameters<typeof ctx.users.add>[0]) => (ctx.users.get(u.id) ? ctx.users.get(u.id)! : ctx.users.add(u));
  const regie = add({ id: 'pk-regie', name: 'Cheffe de service Stationnement — DGTK (démo)', roles: ['R07'], entity: DGTK });
  const autorite = add({ id: 'pk-autorite', name: 'Directeur général DGTK — décisions stationnement (démo)', roles: ['R06'], entity: DGTK });
  const controleur = add({ id: 'pk-controleur', name: 'Contrôleuse de stationnement Gombe–Limete (démo)', roles: ['R11'], entity: DGTK, territory: ['Gombe', 'Limete'] });
  const superviseur = add({ id: 'pk-superviseur', name: 'Superviseur stationnement Gombe–Limete (démo)', roles: ['R09'], entity: DGTK, territory: ['Gombe', 'Limete'] });
  if (!ctx.taxpayers.taxpayers.get(PARKING_DEMO.merchantTaxpayerId)) {
    ctx.taxpayers.register({ phone: '+243890000101', fullName: 'Boulangerie de la Gare (marchand fictif)', language: 'fr', situation: 'business_tenant' }, PARKING_DEMO.merchantTaxpayerId);
  }
  const marchand = add({ id: 'pk-marchand', name: 'Boulangerie de la Gare — marchand partenaire (fictif)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: PARKING_DEMO.merchantTaxpayerId, lang: 'fr' });
  void autorite;

  // Règles FICTIVES publiées par le circuit réel (4 visas distincts), marquées démonstration.
  const common = {
    legalInstrumentIds: [DEMO_INSTRUMENT], articles: ['Article 1 (fictif)'], competentAuthority: 'Gouvernorat — Transports et mobilité (démonstration)',
    administeringEntity: DGTK, currency: 'CDF' as const, rounding: 'HALF_UP' as const, exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
    beneficiaryAccountAlias: DGTK_ALIAS, sourceVerification: 'OFFICIEL_CERTIFIE' as const,
    appealPath: 'Réclamation auprès de la DGTK via MOSOLO (démonstration)',
  };
  publishDemoRule(ctx, {
    ...common, code: PARKING_DEMO.tariffRule, revenueCategory: 'REDEVANCE_SERVICE',
    label: 'DÉMONSTRATION — redevance de stationnement horaire (grille fictive, non opposable)',
    taxableEvent: 'Occupation d’une place de stationnement en zone payante (démonstration)', liableParty: 'Usager (payeur de la session)',
    baseDefinition: 'Durée en minutes × nombre de places × tarif horaire du rang de la zone', formula: 'duree_minutes / 60 * places * tarif_horaire',
    rateTable: { 'tarif_horaire:1': '2000', 'tarif_horaire:2': '1000', 'tarif_horaire:3': '500', 'tarif_horaire:4': '500' },
    periodicity: 'PONCTUELLE', dueRule: 'Paiement immédiat ; la validité court dès la confirmation (démonstration)',
  });
  publishDemoRule(ctx, {
    ...common, code: PARKING_DEMO.penaltyRule, revenueCategory: 'PENALITE',
    label: 'DÉMONSTRATION — barème de pénalité de stationnement (fictif, non opposable)',
    taxableEvent: 'Constat retenu par décision motivée (démonstration)', liableParty: 'Titulaire déclaré de la plaque',
    baseDefinition: 'Forfait selon le rang de la zone', formula: 'forfait',
    rateTable: { 'forfait:1': '20000', 'forfait:2': '10000', 'forfait:3': '5000', 'forfait:4': '5000' },
    periodicity: 'PONCTUELLE', dueRule: '30 jours après la décision (démonstration)',
  });

  // Zones proposées par le dossier source (décision D20) : ACTE REQUIS tant que zonage et grille ne sont pas publiés.
  svc.createZone(regie, {
    code: 'GOMBE-INTEGRALE', name: 'Gombe — zone payante intégrale (proposée, D20)', commune: 'Gombe', quartier: 'Toute la commune', kind: 'ZONE_INTEGRALE',
    geometry: { type: 'Polygon', coordinates: [[15.284, -4.296], [15.326, -4.290], [15.335, -4.312], [15.312, -4.330], [15.286, -4.318]] },
    localityRank: 1, capacity: { standard: 0, livraison: 0, pmr: 0 }, linearMeters: null, actReference: null, tariffRuleCode: null,
    note: 'Géométrie indicative. Capacité à relever lors du recensement. Acte de zonage et grille requis (J24).',
  }, { id: PARKING_DEMO.zoneGombeReal });
  svc.createZone(regie, {
    code: 'BD-30-JUIN', name: 'Boulevard du 30 Juin — artère payante (proposée, D20)', commune: 'Gombe', quartier: 'Boulevard du 30 Juin', kind: 'ARTERE',
    geometry: { type: 'LineString', coordinates: [[15.296, -4.301], [15.309, -4.305], [15.322, -4.309]] },
    localityRank: 1, capacity: { standard: 0, livraison: 0, pmr: 0 }, linearMeters: null, actReference: null, tariffRuleCode: null,
    note: 'Tracé indicatif. Acte de zonage et grille requis (J24).',
  }, { id: PARKING_DEMO.zone30Juin });

  // Zones FICTIVES de démonstration (règles fictives publiées).
  svc.createZone(regie, {
    code: 'DEMO-GOMBE-CENTRE', name: 'DÉMO — secteur fictif Gombe-Centre', commune: 'Gombe', quartier: 'Secteur fictif', kind: 'SECTEUR',
    geometry: { type: 'Polygon', coordinates: [[15.305, -4.303], [15.312, -4.302], [15.313, -4.308], [15.306, -4.309]] },
    localityRank: 1, capacity: { standard: 40, livraison: 4, pmr: 2 }, linearMeters: 320, actReference: 'Acte FICTIF de démonstration n° DEMO-001',
    tariffRuleCode: PARKING_DEMO.tariffRule, penaltyRuleCode: PARKING_DEMO.penaltyRule, maxDurationMinutes: 240,
    note: 'Zone de démonstration : aucune valeur juridique.',
  }, { demo: true, id: PARKING_DEMO.zoneGombe });
  svc.createZone(regie, {
    code: 'DEMO-LIMETE-LUMUMBA', name: 'DÉMO — tronçon fictif boulevard Lumumba (Limete)', commune: 'Limete', quartier: 'Kingabwa', kind: 'ARTERE',
    geometry: { type: 'LineString', coordinates: [[15.338, -4.366], [15.346, -4.372], [15.355, -4.379]] },
    localityRank: 2, capacity: { standard: 60, livraison: 6, pmr: 3 }, linearMeters: 800, actReference: 'Acte FICTIF de démonstration n° DEMO-002',
    tariffRuleCode: PARKING_DEMO.tariffRule, penaltyRuleCode: PARKING_DEMO.penaltyRule, maxDurationMinutes: 480,
    note: 'Zone de démonstration : aucune valeur juridique.',
  }, { demo: true, id: PARKING_DEMO.zoneLimete });

  const owner = ctx.users.get('u-contribuable');
  const tenant = ctx.users.get('u-locataire');
  if (owner) svc.declareVehicle(owner, PARKING_DEMO.plateOwner);
  if (tenant) svc.declareVehicle(tenant, PARKING_DEMO.plateTenant);
  svc.declareVehicle(marchand, PARKING_DEMO.plateMerchant);

  // Sessions payées par le circuit commun (ordre + rappel signé du prestataire de démonstration).
  if (owner) {
    const s = svc.startSession(owner, { zoneId: PARKING_DEMO.zoneGombe, plate: PARKING_DEMO.plateOwner, durationMinutes: 120 });
    demoPay(ctx, owner, s.obligation.id);
  }
  if (tenant) {
    const s = svc.startSession(tenant, { zoneId: PARKING_DEMO.zoneLimete, plate: PARKING_DEMO.plateTenant, durationMinutes: 60 });
    demoPay(ctx, tenant, s.obligation.id);
  }
  const m = svc.startSession(marchand, { zoneId: PARKING_DEMO.zoneLimete, plate: PARKING_DEMO.plateMerchant, durationMinutes: 180 });
  demoPay(ctx, marchand, m.obligation.id);
  // Session offerte par le marchand à un client (plaque du client) : en attente de paiement.
  svc.startSession(marchand, { zoneId: PARKING_DEMO.zoneGombe, plate: 'KN-0555-DM', durationMinutes: 60 });

  // Contrôles et constats (circuit RW1).
  svc.control(controleur, PARKING_DEMO.plateOwner, PARKING_DEMO.zoneGombe);
  const red = svc.control(controleur, PARKING_DEMO.plateUnknown, PARKING_DEMO.zoneGombe);
  const at1 = { lat: -4.3055, lon: 15.3088, place: 'Secteur fictif Gombe-Centre (démonstration)' };
  svc.recordViolation(controleur, {
    zoneId: PARKING_DEMO.zoneGombe, plate: PARKING_DEMO.plateUnknown, nature: 'NON_PAIEMENT', checkId: red.checkId,
    photoIds: demoEvidencePhotos(svc, controleur, red.checkId, ['constat-1'], at1), lat: at1.lat, lon: at1.lon, gpsAccuracyM: 6, deviceId: 'dev-terrain-001',
    observations: 'Véhicule stationné sans titre sur place standard (démonstration).',
  });
  const red2 = svc.control(controleur, PARKING_DEMO.plateTenant, PARKING_DEMO.zoneGombe);
  const at2 = { lat: -4.3062, lon: 15.3091, place: 'Aire de livraison, secteur fictif Gombe-Centre (démonstration)' };
  const v2 = svc.recordViolation(controleur, {
    zoneId: PARKING_DEMO.zoneGombe, plate: PARKING_DEMO.plateTenant, nature: 'PLACE_RESERVEE', checkId: red2.checkId,
    photoIds: demoEvidencePhotos(svc, controleur, red2.checkId, ['constat-2', 'constat-3'], at2), lat: at2.lat, lon: at2.lon, gpsAccuracyM: 8,
    observations: 'Véhicule sur l’aire de livraison pendant les heures réservées (démonstration).',
  });
  svc.verifyViolation(superviseur, v2.id, { confirm: true, note: 'Photographies nettes, aire de livraison signalée (démonstration).' });

  // Réservation de voirie demandée par le marchand (livraison), en attente de décision de la régie.
  const start = new Date(ctx.clock.now().getTime() + 24 * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  svc.requestReservation(marchand, {
    zoneId: PARKING_DEMO.zoneGombe, purpose: 'LIVRAISON', places: 2, startAt: start.toISOString(), endAt: new Date(start.getTime() + 2 * 3_600_000).toISOString(),
    plate: PARKING_DEMO.plateMerchant, notes: 'Livraison de farine (démonstration).',
  });

  // Parkings privés et marchands partenaires (fictifs).
  const p1 = svc.createPartner(regie, { name: 'Parking privé de la Gare (fictif)', kind: 'PARKING_PRIVE', commune: 'Gombe', quartier: 'Gare centrale', lat: -4.3015, lon: 15.3125, capacity: 120, operatorTaxpayerId: PARKING_DEMO.merchantTaxpayerId }, { demo: true });
  svc.setPartnerStatus(regie, p1.id, { status: 'PARTENAIRE', reason: 'Convention de démonstration signée (fictive).' });
  svc.declarePartnerOccupancy(marchand, p1.id, 34);
  svc.createPartner(regie, { name: 'Galerie commerciale du Fleuve (fictive)', kind: 'MARCHAND', commune: 'Gombe', quartier: 'Centre-ville', lat: -4.3040, lon: 15.3150, capacity: 45 }, { demo: true });

  // Chapitre 11A : grilles tarifaires, abonnement lié à la plaque, occupation, affectation, déploiement (seed-smart.ts).
  seedParkSmart(ctx, svc);
}
