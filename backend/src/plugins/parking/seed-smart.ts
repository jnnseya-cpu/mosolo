/**
 * Données de DÉMONSTRATION du chapitre 11A (fictives, non opposables, valeurs marquées [EXEMPLE]) :
 * - grilles RÉELLES de chaque mode tarifaire rattachées à des codes de règle absents du registre (ACTE_REQUIS) ;
 * - grilles FICTIVES publiées par le circuit à quatre visas (démonstration) et une règle au registre non publiée (A_VERIFIER) ;
 * - abonnement résidentiel digital (titre § 19A lié à la plaque), relevés de capteur, recommandation préparée ;
 * - zone premium, reconfigurations, engagement de programmation publié, phases de déploiement.
 */
import type { AppContext } from '../../context.js';
import { demoProviderConfirm } from '../rakapay/seed.js';
import type { ParkingService } from './service.js';
import { PARKING_DEMO } from './seed.js';
import { PARKSMART_TITLE_TYPES, TARIFF_MODES, type TariffMode } from './smart.js';
import { DEMO_INSTRUMENT, DGTK, DGTK_ALIAS, publishDemoRule } from './support.js';

export const PARKSMART_DEMO = {
  dailyRule: 'DEMO-PARK-JOURNALIER',
  demandRule: 'DEMO-PARK-DEMANDE',
  eventRule: 'DEMO-PARK-EVENEMENT',
  premiumRule: 'DEMO-PARK-PREMIUM',
  residentRule: 'DEMO-PARK-RESIDENTIEL',
  proRule: 'DEMO-PARK-PROFESSIONNEL',
  shortRule: 'DEMO-PARK-COURTE-DUREE',
  longRule: 'DEMO-PARK-LONGUE-DUREE',
} as const;

/** Codes de règle RÉELS proposés pour chaque mode (absents du registre : acte requis). */
export const REAL_RULE_CODES: Record<TariffMode, string> = {
  HORAIRE_ZONE: 'PKS-HORAIRE', JOURNALIER: 'PKS-JOURNALIER', DEMANDE_DIFFERENCIEE: 'PKS-DEMANDE', EVENEMENT: 'PKS-EVENEMENT',
  PRE_RESERVATION_PREMIUM: 'PKS-PREMIUM', RESIDENTIEL: 'PKS-RESIDENTIEL', ENTREPRISES: 'PKS-PROFESSIONNEL', COURTE_DUREE: 'PKS-COURTE-DUREE',
  LONGUE_DUREE_MAJOREE: 'PKS-LONGUE-DUREE',
};

export function seedParkSmart(ctx: AppContext, svc: ParkingService): void {
  const s = svc.smart;
  if (s.grids.count() > 0) return;
  const regie = ctx.users.get('pk-regie')!;
  const autorite = ctx.users.get('pk-autorite')!;

  const common = {
    legalInstrumentIds: [DEMO_INSTRUMENT], articles: ['Article 1 (fictif)'], competentAuthority: 'Gouvernorat — Transports et mobilité (démonstration)',
    administeringEntity: DGTK, currency: 'CDF' as const, rounding: 'HALF_UP' as const, exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
    beneficiaryAccountAlias: DGTK_ALIAS, sourceVerification: 'OFFICIEL_CERTIFIE' as const, appealPath: 'Réclamation auprès de la DGTK via MOSOLO (démonstration)',
    revenueCategory: 'REDEVANCE_SERVICE' as const, periodicity: 'PONCTUELLE' as const, dueRule: 'Paiement immédiat ; validité dès la confirmation (démonstration)',
    liableParty: 'Usager (payeur)',
  };
  const demo = (code: string, label: string, event: string, base: string, formula: string, rateTable: Record<string, string>) =>
    publishDemoRule(ctx, { ...common, code, label: `DÉMONSTRATION — ${label} [EXEMPLE] (grille fictive, non opposable)`, taxableEvent: event, baseDefinition: base, formula, rateTable });

  // Heures de pointe lues dans la TABLE de la règle (jamais dans le code) : 07–09 h et 16–18 h [EXEMPLE].
  const peak = Object.fromEntries(['07', '08', '09', '16', '17', '18'].map((h) => [`heure_pointe_${h}`, '1']));
  demo(PARKSMART_DEMO.dailyRule, 'forfait journalier par zone', 'Stationnement à la journée', 'Jours × forfait du rang', 'jours * forfait_jour', { 'forfait_jour:1': '12000', 'forfait_jour:2': '6000', 'forfait_jour:3': '3000', 'forfait_jour:4': '3000' });
  demo(PARKSMART_DEMO.demandRule, 'tarif différencié selon la demande (heures de pointe)', 'Stationnement en zone de forte demande', 'Durée × (tarif de base + supplément aux heures de pointe de la table)',
    'duree_minutes / 60 * places * (tarif_base + pointe * supplement_pointe)', { 'tarif_base:1': '2000', 'tarif_base:2': '1000', 'tarif_base:3': '500', 'tarif_base:4': '500', 'supplement_pointe:1': '1000', 'supplement_pointe:2': '500', 'supplement_pointe:3': '250', 'supplement_pointe:4': '250', ...peak });
  demo(PARKSMART_DEMO.eventRule, 'tarif spécial événement', 'Stationnement lors d’un événement', 'Jours × tarif événement', 'jours * tarif_evenement_jour', { tarif_evenement_jour: '5000' });
  demo(PARKSMART_DEMO.premiumRule, 'pré-réservation premium (place garantie avec prime)', 'Pré-réservation d’une place garantie', 'Heures × tarif horaire + prime de garantie', 'heures * tarif_horaire + prime_reservation', { tarif_horaire: '2000', prime_reservation: '1500' });
  demo(PARKSMART_DEMO.residentRule, 'abonnement résidentiel digital', 'Stationnement résidentiel lié à la plaque', 'Mois × tarif résidentiel', 'mois * tarif_residentiel_mois', { tarif_residentiel_mois: '15000' });
  demo(PARKSMART_DEMO.proRule, 'abonnement professionnel', 'Stationnement professionnel lié à la plaque', 'Mois × tarif professionnel', 'mois * tarif_professionnel_mois', { tarif_professionnel_mois: '40000' });
  demo(PARKSMART_DEMO.shortRule, 'courte durée (rotation devant les commerces)', 'Stationnement de courte durée', 'Durée × tarif courte durée, plafond de durée par la zone', 'duree_minutes / 60 * places * tarif_courte_duree', { 'tarif_courte_duree:1': '1500', 'tarif_courte_duree:2': '750', 'tarif_courte_duree:3': '400', 'tarif_courte_duree:4': '400' });

  // Longue durée majorée : règle au registre NON publiée (A_VERIFIER) — rédigée, en attente des visas.
  const drafter = ctx.users.get('u-juriste-redacteur');
  if (drafter && !ctx.rules.list().some((r) => r.code === PARKSMART_DEMO.longRule)) {
    const r = ctx.rules.create(drafter, {
      ...common, code: PARKSMART_DEMO.longRule, label: 'DÉMONSTRATION — longue durée majorée [EXEMPLE] (projet, à vérifier)', taxableEvent: 'Stationnement prolongé',
      baseDefinition: 'Durée × tarif de base + majoration horaire au-delà du seuil de longue durée', formula: 'duree_minutes / 60 * tarif_base + max(0, duree_minutes - seuil_minutes) / 60 * majoration_horaire',
      rateTable: { tarif_base: '1000', seuil_minutes: '180', majoration_horaire: '1000' },
    });
    ctx.rules.rules.update({ ...ctx.rules.rules.get(r.id)!, demo: true });
  }

  // Grilles : une RÉELLE par mode (acte requis) et une de DÉMONSTRATION.
  const demoCodes: Record<TariffMode, string> = {
    HORAIRE_ZONE: PARKING_DEMO.tariffRule, JOURNALIER: PARKSMART_DEMO.dailyRule, DEMANDE_DIFFERENCIEE: PARKSMART_DEMO.demandRule, EVENEMENT: PARKSMART_DEMO.eventRule,
    PRE_RESERVATION_PREMIUM: PARKSMART_DEMO.premiumRule, RESIDENTIEL: PARKSMART_DEMO.residentRule, ENTREPRISES: PARKSMART_DEMO.proRule,
    COURTE_DUREE: PARKSMART_DEMO.shortRule, LONGUE_DUREE_MAJOREE: PARKSMART_DEMO.longRule,
  };
  const titleOf = (m: TariffMode) => (PARKSMART_TITLE_TYPES as Record<string, { real: string; demo: string } | undefined>)[m];
  for (const m of TARIFF_MODES) {
    s.grids.insert({
      id: `PKG-${m.mode}`, mode: m.mode, ruleCode: REAL_RULE_CODES[m.mode], scope: 'REEL', zoneIds: [PARKING_DEMO.zoneGombeReal, PARKING_DEMO.zone30Juin],
      titleTypeCode: titleOf(m.mode)?.real ?? null, note: 'Grille réelle : zonage et tarifs fixés par l’acte réglementaire (acte requis).', createdBy: regie.id, createdAt: ctx.clock.now().toISOString(),
    });
    s.grids.insert({
      id: `PKG-DEMO-${m.mode}`, mode: m.mode, ruleCode: demoCodes[m.mode], scope: 'DEMO', zoneIds: [PARKING_DEMO.zoneGombe, PARKING_DEMO.zoneLimete],
      titleTypeCode: titleOf(m.mode)?.demo ?? null, note: 'Grille FICTIVE de démonstration [EXEMPLE].', createdBy: regie.id, createdAt: ctx.clock.now().toISOString(),
    });
  }

  // Zone premium (démonstration) et relevés de capteur (maquette de flux).
  s.setPremium(regie, PARKING_DEMO.zoneGombe, { category: 'COMMERCIALE', reason: 'Secteur commercial à forte demande (démonstration).' });
  const now = ctx.clock.now().getTime();
  s.recordSensor(regie, PARKING_DEMO.zoneGombe, { sensorId: 'CAP-DEMO-GC-01', occupied: 38, at: new Date(now - 2 * 3_600_000).toISOString() });
  s.recordSensor(regie, PARKING_DEMO.zoneGombe, { sensorId: 'CAP-DEMO-GC-01', occupied: 39, at: new Date(now - 60_000).toISOString() });
  s.recordSensor(regie, PARKING_DEMO.zoneLimete, { sensorId: 'CAP-DEMO-LL-01', occupied: 12, at: new Date(now - 60_000).toISOString() });
  s.runRecommendations(regie);

  // Abonnement résidentiel digital lié à la plaque (titre § 19A, sans papier) payé par le circuit commun.
  const owner = ctx.users.get('u-contribuable');
  if (s.titres && owner?.taxpayerId) {
    const iss = s.titres.purchase(owner, {
      payerTaxpayerId: owner.taxpayerId, channel: 'MOBILE_MONEY', context: 'PARKSMART_ABONNEMENT',
      items: [{ typeCode: PARKSMART_TITLE_TYPES.RESIDENTIEL.demo, subject: { plate: PARKING_DEMO.plateOwner }, place: { commune: 'Gombe', sourceId: PARKING_DEMO.zoneGombe, label: 'DÉMO — secteur fictif Gombe-Centre', basis: 'ZONE_SERVICE' }, autoRenewConsent: false }],
    });
    for (const p of iss.payments) demoProviderConfirm(ctx, p.paymentReference);
    s.titres.sync();
  }

  // Reconfigurations (planification), affectation (engagement publié), déploiement (phases).
  s.createReconfiguration(regie, { zoneId: PARKING_DEMO.zoneLimete, kind: 'STATIONNEMENT_EN_EPI', description: 'Passage du stationnement parallèle au stationnement en épi sur le tronçon fictif (démonstration).', expectedEffect: 'Places supplémentaires à relever après étude [EXEMPLE]' }, { demo: true });
  s.createReconfiguration(regie, { zoneId: PARKING_DEMO.zoneGombe, kind: 'ZONE_LIVRAISON', description: 'Aire de livraison dédiée aux heures creuses devant les commerces (démonstration).', expectedEffect: 'Réduction du double stationnement [EXEMPLE]' }, { demo: true });
  const c = s.createCommitment(regie, { domain: 'SIGNALISATION', label: 'Signalisation et marquage des zones payantes de la Gombe (engagement fictif) [EXEMPLE]', period: '2027', programmedAmount: null }, { demo: true });
  s.publishCommitment(autorite, c.id);
  s.createCommitment(regie, { domain: 'ENTRETIEN_ROUTIER', label: 'Entretien des chaussées des axes payants (projet d’engagement fictif) [EXEMPLE]', period: '2027' }, { demo: true });
  s.addPhaseZone(regie, 1, PARKING_DEMO.zoneGombeReal);
  s.addPhaseZone(regie, 1, PARKING_DEMO.zone30Juin);
}
