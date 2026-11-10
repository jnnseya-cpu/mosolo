/**
 * Données de DÉMONSTRATION du module « verticales » — fictives, non opposables.
 * Les obligations sont produites par le circuit réel : règles FICTIVES publiées par quatre personnes distinctes
 * (marquées `demo`), liquidation par un agent habilité, sur des objets du contribuable démo (TP-DEMO-0001) répartis
 * dans plusieurs verticales et communes. Les verticales « acte requis » (AVIA, environnement — plastique —, ports,
 * stationnement, RakaPay) n'ont AUCUNE obligation. Aucun paiement n'est semé : les quittances naissent du vrai circuit.
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import type { RuleInput } from '../../modules/rules/service.js';
import type { CredentialType } from '../titres/model.js';
import type { TitresService } from '../titres/service.js';
import { VX_DEMO_RULES, type VerticalesService } from './service.js';

export const VX_DEMO = {
  taxpayerId: 'TP-DEMO-0001',
  airlineTaxpayerId: 'TP-VX-AVIA-01',
  /** Seconde compagnie fictive raccordée au pôle de rapprochement (RRH) par le bac à sable [EXEMPLE]. */
  airlineBTaxpayerId: 'TP-VX-AVIA-02',
  agencyTaxpayerId: 'TP-VX-AGV-01',
  telecomTaxpayerId: 'TP-VX-TEL-01',
  stallId: 'MCH-GMB-C-1044',
  users: {
    instructor: 'vx-instructeur-dgtk',
    chief: 'vx-chef-service-dgtk',
    /** Directeur DGTK : configuration des fiches sectorielles (règle et type de titre, avec l'acte). */
    director: 'vx-directeur-dgtk',
    fieldAgent: 'vx-agent-terrain-dgtk',
    airline: 'vx-compagnie-aerienne',
    airport: 'vx-exploitant-aeroport',
    airlineB: 'vx-compagnie-aerienne-b',
    agency: 'vx-agence-voyages',
    telecom: 'vx-operateur-telecom',
    bank: 'vx-banque-calcu',
    publicEntity: 'vx-entite-pilote-calcu',
  },
} as const;

const DEMO_USERS: Omit<User, 'kind'>[] = [
  { id: VX_DEMO.users.instructor, name: 'Instructeur DGTK — verticales (démo)', roles: ['R11'], entity: 'DGTK' },
  { id: VX_DEMO.users.chief, name: 'Cheffe de service DGTK — décisions (démo)', roles: ['R07'], entity: 'DGTK' },
  { id: VX_DEMO.users.director, name: 'Directeur DGTK — configuration des fiches sectorielles (démo)', roles: ['R06'], entity: 'DGTK' },
  { id: VX_DEMO.users.fieldAgent, name: 'Agent de terrain DGTK (démo)', roles: ['R10'], entity: 'DGTK', territory: ['Gombe', 'Ngaliema', 'Lingwala', 'Kalamu', 'Nsele'] },
  { id: VX_DEMO.users.airline, name: 'Compagnie aérienne fictive (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: VX_DEMO.airlineTaxpayerId },
  { id: VX_DEMO.users.airport, name: 'Exploitant d’aérodrome — données d’embarquement (démo)', roles: ['R34'], entity: 'EXPLOITANT-AERO' },
  { id: VX_DEMO.users.airlineB, name: 'Compagnie aérienne fictive B (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: VX_DEMO.airlineBTaxpayerId },
  { id: VX_DEMO.users.agency, name: 'Agence de voyages fictive — portail certifié (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: VX_DEMO.agencyTaxpayerId },
  { id: VX_DEMO.users.telecom, name: 'Opérateur télécom fictif (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: VX_DEMO.telecomTaxpayerId },
  { id: VX_DEMO.users.bank, name: 'Banque partenaire — passerelle CALCU (démo)', roles: ['R33'], entity: 'BANQUE-A' },
  { id: VX_DEMO.users.publicEntity, name: 'Entité publique pilote CALCU (démo)', roles: ['R08'], entity: 'ENTITE-PILOTE' },
];

type DemoRule = Pick<RuleInput, 'code' | 'label' | 'administeringEntity' | 'taxableEvent' | 'liableParty' | 'baseDefinition' | 'formula' | 'rateTable' | 'currency' | 'periodicity' | 'beneficiaryAccountAlias' | 'revenueCategory'>;

/** Règles FICTIVES : montants inventés pour la démonstration du circuit, sans aucune valeur juridique. */
const DEMO_RULES: DemoRule[] = [
  {
    code: VX_DEMO_RULES.marches!, revenueCategory: 'REDEVANCE_SERVICE', administeringEntity: 'DGTK', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01',
    label: 'DÉMONSTRATION — droit d’étal au jour (règle fictive, non opposable)', taxableEvent: 'Occupation d’un étal de marché (démonstration)',
    liableParty: 'Titulaire de l’étal', baseDefinition: 'Nombre de jours du titre (1, 7 ou 30)', formula: 'tarif_jour * jours', rateTable: { tarif_jour: '500' },
    currency: 'CDF', periodicity: 'PONCTUELLE',
  },
  {
    code: VX_DEMO_RULES.evenements!, revenueCategory: 'DROIT_ADMINISTRATIF', administeringEntity: 'DGTK', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01',
    label: 'DÉMONSTRATION — droit sur les spectacles (règle fictive, non opposable)', taxableEvent: 'Tenue d’un spectacle payant (démonstration)',
    liableParty: 'Organisateur', baseDefinition: 'Billets vendus déclarés', formula: 'billets_vendus * taux_billet', rateTable: { taux_billet: '200' },
    currency: 'CDF', periodicity: 'PONCTUELLE',
  },
  {
    code: VX_DEMO_RULES.construction!, revenueCategory: 'DROIT_ADMINISTRATIF', administeringEntity: 'DGTK', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01',
    label: 'DÉMONSTRATION — droits de voirie de chantier (règle fictive, non opposable)', taxableEvent: 'Occupation de la voie par un chantier (démonstration)',
    liableParty: 'Maître d’ouvrage', baseDefinition: 'Emprise sur la voie (m²) × durée (mois)', formula: 'emprise_voie_m2 * duree_mois * tarif_m2_mois', rateTable: { tarif_m2_mois: '1000' },
    currency: 'CDF', periodicity: 'PONCTUELLE',
  },
  {
    code: VX_DEMO_RULES.mobilite!, revenueCategory: 'IMPOT_PROVINCIAL', administeringEntity: 'DGIPK', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01',
    label: 'DÉMONSTRATION — vignette automobile forfaitaire (règle fictive, non opposable)', taxableEvent: 'Détention d’un véhicule au 1er janvier (démonstration)',
    liableParty: 'Propriétaire du véhicule', baseDefinition: 'Forfait selon le rang de localité', formula: 'forfait',
    rateTable: { 'forfait:1': '60', 'forfait:2': '40', 'forfait:3': '30', 'forfait:4': '20' }, currency: 'USD', periodicity: 'ANNUELLE',
  },
];

function publishDemoRule(ctx: AppContext, r: DemoRule): void {
  const u = (id: string) => ctx.users.get(id)!;
  const drafter = u('u-juriste-redacteur');
  const rule = ctx.rules.create(drafter, {
    ...r, legalInstrumentIds: ['demo-instrument-001'], articles: ['Article 1 (fictif)'], competentAuthority: 'Ministère provincial des Finances (démonstration)',
    rounding: 'HALF_UP', dueRule: '30 jours après émission (démonstration)', exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
    appealPath: 'Réclamation via MOSOLO (démonstration)', sourceVerification: 'OFFICIEL_CERTIFIE',
  });
  ctx.rules.approve(drafter, rule.id, 'REDACTEUR');
  ctx.rules.approve(u('u-juriste-verificateur'), rule.id, 'VERIFICATEUR_JURIDIQUE');
  ctx.rules.approve(u('u-validateur-financier'), rule.id, 'VALIDATEUR_FINANCIER');
  ctx.rules.approve(u('u-autorite-publication'), rule.id, 'AUTORITE_PUBLICATION');
  ctx.rules.rules.update({ ...ctx.rules.rules.get(rule.id)!, demo: true });
}

/** Parcours complet d'une démarche : dépôt → prise en charge → (visite) → proposition → décision motivée. */
function runCase(
  svc: VerticalesService,
  actors: { owner: User; instructor: User; chief: User; visitor?: User },
  slug: string,
  input: { type: string; objectId?: string; details: Record<string, string>; documents?: { label: string; sha256: string }[] },
  stopAt: 'DEPOSE' | 'EN_INSTRUCTION' | 'ACCEPTE' = 'ACCEPTE',
) {
  const c = svc.submitCase(actors.owner, slug, { ...input, documents: input.documents ?? [] });
  if (stopAt === 'DEPOSE') return c;
  svc.take(actors.instructor, c.id);
  if (actors.visitor) svc.recordVisit(actors.visitor, c.id, { date: kinshasaDate(svc.now()), result: 'CONFORME', observations: 'Constat sur place conforme au dossier (démonstration).' });
  if (stopAt === 'EN_INSTRUCTION') return svc.getCase(c.id);
  svc.propose(actors.instructor, c.id, { outcome: 'ACCEPTER', reason: 'Dossier complet, pièces vérifiées (démonstration).' });
  return svc.decide(actors.chief, c.id, { decision: 'ACCEPTE', reason: 'Conforme à la proposition d’instruction (démonstration).' });
}

const fakeHash = (seed: string) => Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(seed.charCodeAt(i % seed.length) + i * 7) % 16]).join('');

export function seedVerticales(ctx: AppContext, svc: VerticalesService): void {
  seedSecteursReferences(svc);
  for (const u of DEMO_USERS) ctx.users.add(u);
  const user = (id: string) => ctx.users.get(id)!;
  const owner = user('u-contribuable');
  const instructor = user(VX_DEMO.users.instructor);
  const chief = user(VX_DEMO.users.chief);
  const field = user(VX_DEMO.users.fieldAgent);
  const now = svc.now();
  const day = (offset: number) => kinshasaDate(new Date(now.getTime() + offset * DAY_MS));

  // Contribuables fictifs supplémentaires (compagnie aérienne, opérateur télécom).
  ctx.taxpayers.register({ phone: '+243810009901', fullName: 'Compagnie aérienne fictive (démo)', language: 'fr', situation: 'other' }, VX_DEMO.airlineTaxpayerId);
  ctx.taxpayers.register({ phone: '+243810009903', fullName: 'Compagnie aérienne fictive B (démo)', language: 'fr', situation: 'other' }, VX_DEMO.airlineBTaxpayerId);
  ctx.taxpayers.register({ phone: '+243810009904', fullName: 'Agence de voyages fictive (démo)', language: 'fr', situation: 'other' }, VX_DEMO.agencyTaxpayerId);
  ctx.taxpayers.register({ phone: '+243810009902', fullName: 'Opérateur télécom fictif (démo)', language: 'fr', situation: 'other' }, VX_DEMO.telecomTaxpayerId);

  // Règles FICTIVES publiées par le circuit des quatre visas.
  for (const r of DEMO_RULES) publishDemoRule(ctx, r);
  // Titres à usage unique de DÉMONSTRATION [EXEMPLE] (embarquement, bons de sortie, péage) sur règles fictives ACTIVES.
  seedSingleUseDemoTypes(ctx);

  // ---------------------------------------------------------------- Marchés : plan, étals, titre d'étal
  svc.seedMarket({ id: 'MKT-CENTRAL', name: 'Marché central', commune: 'Gombe', quartier: 'Commerce' });
  svc.seedMarket({ id: 'MKT-LIBERTE', name: 'Marché de la Liberté', commune: 'Masina', quartier: 'Petro-Congo' });
  svc.seedMarket({ id: 'MKT-GAMBELA', name: 'Marché Gambela', commune: 'Kasa-Vubu', quartier: 'Assossa' });
  const stalls: [string, string, string, string, string, string][] = [
    [VX_DEMO.stallId, 'MKT-CENTRAL', 'C', '1044', 'Pagne et tissus', '4'],
    ['MCH-GMB-C-1045', 'MKT-CENTRAL', 'C', '1045', 'Pagne et tissus', '4'],
    ['MCH-GMB-A-0012', 'MKT-CENTRAL', 'A', '0012', 'Vivres frais', '3'],
    ['MCH-MSN-B-0210', 'MKT-LIBERTE', 'B', '0210', 'Quincaillerie', '6'],
    ['MCH-MSN-B-0211', 'MKT-LIBERTE', 'B', '0211', 'Quincaillerie', '6'],
    ['MCH-KSV-D-0033', 'MKT-GAMBELA', 'D', '0033', 'Poissons fumés', '3'],
  ];
  for (const [id, marketId, row, number, category, surfaceM2] of stalls) svc.seedStall({ id, marketId, row, number, category, surfaceM2 });
  const stallObj = svc.assignStall(svc.stalls.get(VX_DEMO.stallId)!, VX_DEMO.taxpayerId, 'Pagne et tissus');
  svc.issuePlate(field, stallObj.id);
  svc.requestStallTitle(owner, VX_DEMO.stallId, 'MOIS');

  // ---------------------------------------------------------------- Mobilité : véhicule + vignette (règle fictive)
  const vehicle = ctx.objects.create(owner, {
    category: 'VEHICULE', commune: 'Kalamu', quartier: 'Matonge', localityRank: 2, lat: -4.3445, lon: 15.3152,
    attributes: { verticale: 'mobilite', nom: 'Minibus 18 places', immatriculation: 'KN-4471-BD', usage_vehicule: 'Transport en commun', demo: true },
  });
  svc.liquidateObject(user('u-controleur'), 'mobilite', vehicle.id);
  runCase(svc, { owner, instructor: user('u-controleur'), chief }, 'mobilite', {
    type: 'DEMANDE_AUTORISATION_TRANSPORT', objectId: vehicle.id, details: { service: 'MINIBUS', itineraire: 'Victoire – Kintambo' },
    documents: [{ label: 'Carte grise', sha256: fakeHash('carte-grise') }],
  }, 'DEPOSE');

  // ---------------------------------------------------------------- Entreprises : établissement déclaré (sans obligation)
  ctx.objects.create(owner, {
    category: 'ACTIVITE', commune: 'Gombe', quartier: 'Commerce', localityRank: 1, lat: -4.3062, lon: 15.3021,
    attributes: { verticale: 'entreprises', objectType: 'ETABLISSEMENT', nom: 'Boutique d’électroménager', activite: 'Commerce de détail', demo: true },
  });

  // ---------------------------------------------------------------- Événements : autorisation, certificat QR, billetterie, liquidation
  const evt = runCase(svc, { owner, instructor, chief }, 'evenements', {
    type: 'DEMANDE_AUTORISATION_EVENEMENT',
    details: { nom: 'Concert de la rentrée', lieu: 'Stade Tata Raphaël', dateDebut: day(20), dateFin: day(20), jauge: '38000', commune: 'Lingwala', quartier: 'Singa Mopepe' },
    documents: [{ label: 'Contrat ou accord du lieu', sha256: fakeHash('contrat-lieu') }, { label: 'Plan de sécurité', sha256: fakeHash('plan-securite') }],
  });
  svc.declareTicketing(owner, evt.createdObjectId!, { ticketsSold: 12000, source: 'RAKAPAY' });
  svc.liquidateObject(instructor, 'evenements', evt.createdObjectId!);

  // ---------------------------------------------------------------- Construction : demande, visite, permis, droits, quitus en instruction
  const cht = runCase(svc, { owner, instructor, chief, visitor: field }, 'construction', {
    type: 'DEMANDE_AUTORISATION_CHANTIER',
    details: { nature: 'Immeuble R+4 — logements', emprise_voie_m2: '60', dureeMois: '6', commune: 'Ngaliema', quartier: 'Ma Campagne' },
    documents: [{ label: 'Plans', sha256: fakeHash('plans') }, { label: 'Titre de la parcelle', sha256: fakeHash('titre') }],
  });
  svc.liquidateObject(instructor, 'construction', cht.createdObjectId!);
  svc.issuePlate(field, cht.createdObjectId!);
  runCase(svc, { owner, instructor, chief }, 'construction', {
    type: 'DEMANDE_QUITUS_CHANTIER', objectId: cht.createdObjectId!, details: {}, documents: [{ label: 'Procès-verbal de fin de travaux', sha256: fakeHash('pv-fin') }],
  }, 'EN_INSTRUCTION');

  // ---------------------------------------------------------------- Ports : embarcation déclarée (cadrage requis : aucune obligation)
  const emb = runCase(svc, { owner, instructor, chief }, 'ports', {
    type: 'DECLARATION_EMBARCATION',
    details: { nom: 'Baleinière Espoir', type: 'Baleinière', capacite_t: '40', passagers: '60', port: 'Port de Kinkole', commune: 'Nsele', quartier: 'Kinkole' },
    documents: [{ label: 'Document de navigation', sha256: fakeHash('navigation') }],
  });
  runCase(svc, { owner, instructor, chief }, 'ports', {
    type: 'DECLARATION_MOUVEMENT', objectId: emb.createdObjectId!, details: { sens: 'DEPART', date: day(-2), passagers: '48', tonnage_t: '22', destination: 'Maluku' },
  }, 'DEPOSE');

  // ---------------------------------------------------------------- Propriété : plaque NFIU sur la parcelle démo, scan, vérification demandée
  const nfiu = svc.issuePlate(user('u-agent-terrain'), 'OBJ-DEMO-PARCELLE-01');
  svc.scanPlate(user('u-agent-terrain'), nfiu.code);
  runCase(svc, { owner, instructor: user('u-controleur'), chief }, 'propriete', {
    type: 'DEMANDE_VERIFICATION', objectId: 'OBJ-DEMO-PARCELLE-01', details: { disponibilites: 'En semaine, après 14 h' },
  }, 'DEPOSE');

  // ---------------------------------------------------------------- Environnement : signalement (acte requis pour le plastique)
  runCase(svc, { owner, instructor, chief }, 'environnement', {
    type: 'SIGNALEMENT_DEPOT_SAUVAGE', details: { commune: 'Limete', quartier: 'Kingabwa', description: 'Dépôt d’ordures au bord de la route, près du rond-point (démonstration).' },
    documents: [{ label: 'Photo datée', sha256: fakeHash('photo-depot') }],
  }, 'DEPOSE');
  runCase(svc, { owner, instructor, chief }, 'marches', {
    type: 'SIGNALEMENT_DEMANDE_ESPECES', details: { lieu: 'Marché central, rangée C', date: day(-1), description: 'Une personne se présentant comme placier a demandé 1 000 FC en espèces (démonstration).' },
  }, 'DEPOSE');

  // ---------------------------------------------------------------- Télécom : sites déclarés par l'opérateur, site observé non déclaré
  const tel = user(VX_DEMO.users.telecom);
  ctx.objects.create(tel, { category: 'AUTRE', commune: 'Ngaliema', quartier: 'Mont-Fleury', localityRank: 1, lat: -4.3391, lon: 15.2502, attributes: { verticale: 'telecom', objectType: 'SITE_TELECOM', reference: 'SITE-NGL-0142', type: 'PYLONE', hauteur_m: '36', demo: true } });
  ctx.objects.create(tel, { category: 'AUTRE', commune: 'Gombe', quartier: 'Haut-Commandement', localityRank: 1, lat: -4.3035, lon: 15.3078, attributes: { verticale: 'telecom', objectType: 'SITE_TELECOM', reference: 'SITE-GMB-0901', type: 'TOITURE', demo: true } });
  ctx.objects.create(field, { category: 'AUTRE', commune: 'Ngaliema', quartier: 'Mont-Fleury', localityRank: 1, lat: -4.3392, lon: 15.2503, attributes: { verticale: 'telecom', objectType: 'SITE_TELECOM', type: 'PYLONE', observation: 'Relevé terrain (démonstration)', demo: true } });
  ctx.objects.create(field, { category: 'AUTRE', commune: 'Lingwala', quartier: 'Voix du Peuple', localityRank: 1, lat: -4.3221, lon: 15.2987, attributes: { verticale: 'telecom', objectType: 'SITE_TELECOM', type: 'TOITURE', observation: 'Site observé absent des listes (démonstration)', demo: true } });

  // ---------------------------------------------------------------- AVIA : aéronef, déclarations mensuelles, données de l'exploitant
  const airline = user(VX_DEMO.users.airline);
  const aircraft = ctx.objects.create(airline, {
    category: 'AUTRE', commune: 'Nsele', quartier: 'Aéroport de N’Djili', localityRank: 2, lat: -4.3858, lon: 15.4446,
    attributes: { verticale: 'avia', objectType: 'AERONEF', immatriculation: '9S-AXK', type: 'Régional 70 places', sieges: '70', demo: true },
  });
  const month = (back: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return d.toISOString().slice(0, 7); };
  const [m2, m1] = [month(2), month(1)];
  const d2 = svc.avia.declare(airline, { period: m2, aircraftObjectIds: [aircraft.id], flights: 52, passengersDeparting: 3120, freightKg: 0 });
  const d1 = svc.avia.declare(airline, { period: m1, aircraftObjectIds: [aircraft.id], flights: 54, passengersDeparting: 3010, freightKg: 0 });
  const airport = user(VX_DEMO.users.airport);
  svc.avia.submitOperatorData(airport, { period: m2, airlineTaxpayerId: VX_DEMO.airlineTaxpayerId, source: 'RVA', flights: 52, passengersBoarded: 3120, freightKg: 0 });
  svc.avia.submitOperatorData(airport, { period: m1, airlineTaxpayerId: VX_DEMO.airlineTaxpayerId, source: 'RVA', flights: 54, passengersBoarded: 3386, freightKg: 1850 });
  svc.avia.reconcile(instructor, d2.id);
  svc.avia.validate(chief, d2.id, 'Rapprochement sans écart ; données de l’exploitant concordantes (démonstration).');
  svc.avia.reconcile(instructor, d1.id);

  // ---------------------------------------------------------------- AVIA — pôle de rapprochement (RRH), IFA (§ 11C) [EXEMPLE]
  // Billets FICTIFS du bac à sable BSP/GDS/TTBS : la taxe portée par le billet (5.00 USD) est une valeur d'exemple
  // reprise de la taxe moyenne du dossier source [À VÉRIFIER], non contractuelle. Aucun mois déclaré par la compagnie B :
  // le RRH le constate et PROPOSE un constat ; l'analyste décide de l'ouvrir.
  const rrh = svc.aviaRrh;
  const B = VX_DEMO.airlineBTaxpayerId;
  const tax = { amount: '5.00', currency: 'USD' as const };
  const tk = (n: number, flightNumber: string, flightDate: string, destination: string) => ({ ticketNumber: `99900000${String(n).padStart(5, '0')}`, flightNumber, flightDate, destination, passengerRef: `PNR-DEMO-${n}`, urbanTax: tax });
  const f1 = `${m1}-12`;
  const f2 = `${m1}-19`;
  rrh.sandbox.load(B, m1, [...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => tk(n, 'XB101', f1, 'LBV')), ...[11, 12, 13, 14, 15].map((n) => tk(n, 'XB103', f2, 'JNB'))]);
  const pulled = rrh.pullConnector(airport, 'BSP-BAC-A-SABLE', { airlineTaxpayerId: B, period: m1 });
  const agencyUser = user(VX_DEMO.users.agency);
  const agency = rrh.requestAgency(agencyUser, { name: 'Agence de voyages fictive (démo)', kind: 'AGENCE_VOYAGES', iataCode: '9999999', taxpayerId: VX_DEMO.agencyTaxpayerId });
  rrh.decideAgency(chief, agency.id, { decision: 'CERTIFIEE', reason: 'Pièces vérifiées, compte certifié (démonstration).' });
  const viaAgency = rrh.agencyDeclareTickets(agencyUser, agency.id, { airlineTaxpayerId: B, period: m1, tickets: [tk(16, 'XB103', f2, 'JNB')] });
  const qr = (i: number) => ({ qr: pulled.ifas[i]!.qr });
  rrh.recordPassengerEvents(airport, { source: 'RVA_EMBARQUEMENT', airlineTaxpayerId: B, flightNumber: 'XB101', flightDate: f1, scans: [0, 1, 2, 3, 4, 5, 6].map(qr), withoutIfa: 1 });
  rrh.recordPassengerEvents(airport, { source: 'RVA_EMBARQUEMENT', airlineTaxpayerId: B, flightNumber: 'XB103', flightDate: f2, scans: [...[8, 9, 10, 11, 12].map(qr), { qr: viaAgency.ifas[0]!.qr }], withoutIfa: 0 });
  rrh.recordPassengerEvents(airport, { source: 'DGM_SORTIE', airlineTaxpayerId: B, flightNumber: 'XB101', flightDate: f1, scans: [0, 1, 2, 3, 4, 5, 6].map(qr), withoutIfa: 0 });
  rrh.recordPassengerEvents(airport, { source: 'DGM_SORTIE', airlineTaxpayerId: B, flightNumber: 'XB103', flightDate: f2, scans: [8, 9, 10, 11, 12].map(qr), withoutIfa: 0 });
  const airlineB = user(VX_DEMO.users.airlineB);
  rrh.recordFreight(airlineB, { source: 'COMPAGNIE', airlineTaxpayerId: B, flightNumber: 'XB101', flightDate: f1, awbNumber: '999-10000001', weightKg: 500 });
  rrh.recordFreight(airport, { source: 'RVA_MANIFESTE', airlineTaxpayerId: B, flightNumber: 'XB101', flightDate: f1, awbNumber: '999-10000001', weightKg: 500 });
  rrh.recordFreight(airport, { source: 'RVA_MANIFESTE', airlineTaxpayerId: B, flightNumber: 'XB101', flightDate: f1, awbNumber: '999-10000002', weightKg: 750 });
  rrh.recordRemittance(airport, { source: 'BSP', airlineTaxpayerId: B, period: m1, amount: { amount: '65.00', currency: 'USD' }, reference: `BSP-DEMO-${m1}`, nature: 'COURANT' });
  rrh.recordRemittance(user(VX_DEMO.users.bank), { source: 'BANQUE_COLLECTRICE', airlineTaxpayerId: B, period: m1, amount: { amount: '40.00', currency: 'USD' }, reference: `BQ-DEMO-${m1}`, bank: 'Banque collectrice fictive (démo)', nature: 'COURANT' });
  rrh.runDueMonthly();

  // ---------------------------------------------------------------- CALCU : entité pilote, comptes, justificatifs, opérations
  const entity = user(VX_DEMO.users.publicEntity);
  const acc = svc.calcu.declareAccount(entity, { entityName: 'Entité publique pilote (démo)', bank: 'Banque partenaire A (démo)', accountNumber: 'CD00 1111 2222 3333 4444 0001', currency: 'CDF', type: 'INVESTISSEMENT', signatories: ['Ordonnateur (démo)', 'Comptable (démo)'] });
  svc.calcu.validateAccount(user('u-validateur-financier'), acc.id, 'FINANCES');
  svc.calcu.validateAccount(user('u-auditeur'), acc.id, 'CONTROLE');
  svc.calcu.declareAccount(entity, { entityName: 'Entité publique pilote (démo)', bank: 'Banque partenaire A (démo)', accountNumber: 'CD00 1111 2222 3333 4444 0002', currency: 'CDF', type: 'FONCTIONNEMENT', signatories: ['Ordonnateur (démo)'] });
  const supplier = 'Société de travaux fictive (démo)';
  for (const [type, amount] of [['DEVIS', '12500000'], ['BON_COMMANDE', '12500000'], ['ENGAGEMENT', '12500000'], ['FOURNISSEUR', '0']] as const) {
    svc.calcu.registerDocument(entity, { accountId: acc.id, operationRef: 'OP-DEMO-0012', type, supplier, amount: { amount, currency: 'CDF' }, date: day(-10), sha256: fakeHash(`op12-${type}`) });
  }
  svc.calcu.registerDocument(entity, { accountId: acc.id, operationRef: 'OP-DEMO-0013', type: 'ENGAGEMENT', supplier, amount: { amount: '4000000', currency: 'CDF' }, date: day(-8), sha256: fakeHash('op13-eng') });
  const bank = user(VX_DEMO.users.bank);
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  svc.calcu.receiveTransaction(bank, { bank: 'Banque partenaire A (démo)', accountNumber: 'CD00 1111 2222 3333 4444 0001', amount: { amount: '12500000', currency: 'CDF' }, at: at(30), beneficiary: supplier, reference: 'OP-DEMO-0012' });
  svc.calcu.receiveTransaction(bank, { bank: 'Banque partenaire A (démo)', accountNumber: 'CD00 1111 2222 3333 4444 0001', amount: { amount: '4000000', currency: 'CDF' }, at: at(20), beneficiary: supplier, reference: 'OP-DEMO-0013' });
  svc.calcu.receiveTransaction(bank, { bank: 'Banque partenaire A (démo)', accountNumber: 'CD00 9999 8888 7777 6666 0009', amount: { amount: '2300000', currency: 'CDF' }, at: at(6), beneficiary: 'Bénéficiaire inconnu (démo)', reference: 'SANS-REF' });

  // Modules sectoriels « acte requis » : déclarations, relevés et rapprochements [EXEMPLE] (démonstration seulement).
  seedSecteursExemples(ctx, svc);
}

/**
 * Références des modules sectoriels (axes de péage, quais, points d'embarquement, points de contrôle forestiers) :
 * libellés et positions [EXEMPLE], non contractuels, à remplacer par le relevé officiel.
 */
function seedSecteursReferences(svc: VerticalesService): void {
  const r = svc.secteurs;
  r.seedReference({ id: 'AXE-EX-01', module: '25', kind: 'AXE', label: 'Axe de péage [EXEMPLE] — sortie ouest', commune: 'Mont-Ngafula', lat: -4.47, lon: 15.26 });
  r.seedReference({ id: 'AXE-EX-02', module: '25', kind: 'AXE', label: 'Axe de péage [EXEMPLE] — sortie est', commune: 'Nsele', lat: -4.37, lon: 15.52 });
  r.seedReference({ id: 'QUAI-EX-01', module: '24', kind: 'QUAI', label: 'Quai privé [EXEMPLE] — fleuve, Ngaliema', commune: 'Ngaliema', lat: -4.3, lon: 15.25 });
  r.seedReference({ id: 'QUAI-EX-02', module: '24', kind: 'QUAI', label: 'Quai privé [EXEMPLE] — Kinkole', commune: 'Nsele', lat: -4.34, lon: 15.49 });
  r.seedReference({ id: 'EMB-EX-01', module: '13', kind: 'POINT_EMBARQUEMENT', label: 'Point d’embarquement [EXEMPLE] — Kinkole', commune: 'Nsele', lat: -4.341, lon: 15.492 });
  r.seedReference({ id: 'PCF-EX-01', module: '23', kind: 'POINT_CONTROLE', label: 'Point de contrôle forestier [EXEMPLE] — entrée sud', commune: 'Mont-Ngafula', lat: -4.48, lon: 15.28 });
  r.seedReference({ id: 'PCF-EX-02', module: '23', kind: 'POINT_CONTROLE', label: 'Point de contrôle forestier [EXEMPLE] — entrée est', commune: 'Maluku', lat: -4.07, lon: 15.56 });
}

/**
 * Titres à usage unique de DÉMONSTRATION [EXEMPLE] — embarquement (13), bon de sortie de carrière (22), passage et carnet
 * de péage (25) — adossés à des règles FICTIVES publiées par le circuit des quatre visas (marquées demo, non
 * opposables). Les types réels du catalogue (EMB-CARTE, CAR-BON, PEA-*) restent « acte requis » ; la régie ne choisit un
 * type [EXEMPLE] que pour la démonstration. Montants d'exemple non contractuels.
 */
export const SINGLE_USE_DEMO = {
  rules: { embarquement: 'DEMO-EMB-EX', carriere: 'DEMO-CAR-BON-EX', peage: 'DEMO-PEA-EX' },
  types: { embarquement: 'EMB-CARTE-EX', bon: 'CAR-BON-EX', passage: 'PEA-PASSAGE-EX', carnet: 'PEA-CARNET-EX' },
  carnetUses: 10,
} as const;

function seedSingleUseDemoTypes(ctx: AppContext): void {
  const t = ctx.ext.titres as TitresService | undefined;
  if (!t) return;
  const rule = (code: string, label: string, event: string, rate: string) => publishDemoRule(ctx, {
    code, revenueCategory: 'REDEVANCE_SERVICE', administeringEntity: 'DGTK', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01',
    label: `DÉMONSTRATION [EXEMPLE] — ${label} (règle fictive, non opposable)`, taxableEvent: `${event} (démonstration)`, liableParty: 'Usager ou exploitant',
    baseDefinition: 'Nombre de titres (unités)', formula: 'unites * tarif_unite', rateTable: { tarif_unite: rate }, currency: 'CDF', periodicity: 'PONCTUELLE',
  });
  if (!ctx.rules.rules.findOne((r) => r.code === SINGLE_USE_DEMO.rules.embarquement)) rule(SINGLE_USE_DEMO.rules.embarquement, 'titre d’embarquement', 'Embarquement à un point de départ', '1000');
  if (!ctx.rules.rules.findOne((r) => r.code === SINGLE_USE_DEMO.rules.carriere)) rule(SINGLE_USE_DEMO.rules.carriere, 'bon de sortie de carrière', 'Sortie d’un camion d’un site d’extraction', '5000');
  if (!ctx.rules.rules.findOne((r) => r.code === SINGLE_USE_DEMO.rules.peage)) rule(SINGLE_USE_DEMO.rules.peage, 'passage de péage', 'Franchissement d’un point de péage', '2000');
  const act = (ref: string): CredentialType['legalAct'] => ({ ref, status: 'DEMONSTRATION', note: 'Type de DÉMONSTRATION [EXEMPLE] sur règle fictive : aucun titre réel avant l’acte.' });
  const once = { model: 'USAGE_UNIQUE' as const, periodDays: 1, amberMinutes: 0, toleranceMinutes: 0, startMode: 'PAIEMENT' as const, extendable: false, refundable: false };
  const def = (d: Omit<CredentialType, 'id' | 'version' | 'createdAt' | 'createdBy'>) => { if (!t.types.findOne((x) => x.code === d.code)) t.defineType(d, 'fiches-demonstration'); };
  def({ code: SINGLE_USE_DEMO.types.embarquement, module: '13', moduleLabel: 'Embarquement et débarquement', label: 'Carte d’embarquement — DÉMONSTRATION [EXEMPLE]', prefix: 'EMB', entity: 'DGTK',
    validity: once, transferable: false, plateBound: false, supports: ['QR_STATIQUE', 'CODE_COURT', 'SMS'], pricing: { ruleCode: SINGLE_USE_DEMO.rules.embarquement, inputs: { unites: '1' } }, legalAct: act('J30'), demo: true });
  def({ code: SINGLE_USE_DEMO.types.bon, module: '22', moduleLabel: 'Carrières et recettes minières', label: 'Bon de sortie (camion) — DÉMONSTRATION [EXEMPLE]', prefix: 'CAR', entity: 'DGTK',
    validity: once, transferable: false, plateBound: true, supports: ['QR_STATIQUE', 'CODE_COURT', 'PLAQUE'], pricing: { ruleCode: SINGLE_USE_DEMO.rules.carriere, inputs: { unites: '1' } }, legalAct: act('J1'), demo: true });
  def({ code: SINGLE_USE_DEMO.types.passage, module: '25', moduleLabel: 'Péage provincial', label: 'Péage — passage unique — DÉMONSTRATION [EXEMPLE]', prefix: 'PEA', entity: 'DGTK',
    validity: once, transferable: false, plateBound: true, supports: ['PLAQUE', 'QR_STATIQUE', 'SMS'], pricing: { ruleCode: SINGLE_USE_DEMO.rules.peage, inputs: { unites: '1' } }, legalAct: act('J1'), demo: true });
  def({ code: SINGLE_USE_DEMO.types.carnet, module: '25', moduleLabel: 'Péage provincial', label: `Péage — carnet de ${SINGLE_USE_DEMO.carnetUses} passages — DÉMONSTRATION [EXEMPLE]`, prefix: 'PEA', entity: 'DGTK',
    validity: { ...once, model: 'CARNET_USAGES', periodDays: 365, uses: SINGLE_USE_DEMO.carnetUses }, transferable: false, plateBound: true, supports: ['PLAQUE', 'QR_STATIQUE', 'SMS'],
    pricing: { ruleCode: SINGLE_USE_DEMO.rules.peage, inputs: { unites: String(SINGLE_USE_DEMO.carnetUses) } }, legalAct: act('J1'), demo: true });
}

/**
 * Patrimoine provincial (Partie V, MOSOLO Assets) — gestionnaire et chef du service du patrimoine (MINFIN, démo), et un
 * actif inventorié [EXEMPLE] sans évaluation ni appel : aucune valeur, aucune mise à prix, aucune redevance semée.
 */
export const ACT_DEMO = { manager: 'vx-gestionnaire-patrimoine', chief: 'vx-chef-patrimoine' } as const;

export function seedActifs(ctx: AppContext, svc: VerticalesService): void {
  if (!ctx.users.get(ACT_DEMO.manager)) ctx.users.add({ id: ACT_DEMO.manager, name: 'Gestionnaire du patrimoine provincial (démo)', roles: ['R11'], entity: 'MINFIN' });
  if (!ctx.users.get(ACT_DEMO.chief)) ctx.users.add({ id: ACT_DEMO.chief, name: 'Chef du service du patrimoine provincial (démo)', roles: ['R07'], entity: 'MINFIN' });
  if (!svc.actifs || svc.actifs.assets.count() > 0) return;
  svc.actifs.inventory(ctx.users.get(ACT_DEMO.manager)!, {
    nature: 'LOCAL_COMMERCIAL', designation: 'Local commercial provincial [EXEMPLE] — boulevard du 30 Juin', commune: 'Gombe', quartier: 'Commerce',
    surfaceM2: '120', titleReference: 'ACTE-AFFECTATION-DEMO-0001 [EXEMPLE]',
  }, true);
}

/** Redevable et partenaire FICTIFS des exemples sectoriels (distincts du contribuable démo : aucun effet sur ses dossiers). */
export const SECTEURS_DEMO = {
  taxpayerId: 'TP-VX-SECT-01',
  user: 'vx-redevable-sectoriel',
  partner: 'vx-partenaire-accises-exemple',
} as const;

/**
 * Exemples des modules sectoriels « acte requis » (29/09/2026) — DÉMONSTRATION seulement, [EXEMPLE] non contractuels :
 * un redevable fictif déclare (boissons 17, sorties de carrière 22, produits non ligneux 23), l'agent de terrain relève
 * (embarquement 13, carrière 22, accostage 24, péage 25), le contrôleur relève au point forestier (23), un partenaire de
 * données fictif verse des données d'accises (17), le contrôleur rapproche deux déclarations — les décisions restent à
 * prendre par une AUTRE personne (cheffe de service). Aucune obligation, aucun montant (ACTE_REQUIS). Quantités
 * d'exemple, sans valeur de référence. Le mode production (sans --demo) ne charge rien de tout cela.
 */
function seedSecteursExemples(ctx: AppContext, svc: VerticalesService): void {
  const s = svc.secteurs;
  // Exemples COMPLÉMENTAIRES : seulement si le point d'entrée de démonstration les demande (ctx.demoExamples) — les tests
  // historiques, qui comptent les dépôts sectoriels à vide, ne les reçoivent pas.
  if (!ctx.demoExamples || !svc.fiches || s.declarations.count() > 0 || ctx.taxpayers.taxpayers.get(SECTEURS_DEMO.taxpayerId)) return;
  ctx.taxpayers.register({ phone: '+243810009905', fullName: 'Entreprise sectorielle fictive [EXEMPLE] (démo)', language: 'fr', situation: 'other' }, SECTEURS_DEMO.taxpayerId);
  if (!ctx.users.get(SECTEURS_DEMO.user)) ctx.users.add({ id: SECTEURS_DEMO.user, name: 'Redevable sectoriel fictif [EXEMPLE] (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: SECTEURS_DEMO.taxpayerId });
  if (!ctx.users.get(SECTEURS_DEMO.partner)) ctx.users.add({ id: SECTEURS_DEMO.partner, name: 'Partenaire de données — accises [EXEMPLE] (démo)', roles: ['R34'], entity: 'PARTENAIRE-DONNEES' });
  const u = (id: string) => ctx.users.get(id)!;
  const owner = u(SECTEURS_DEMO.user);
  const instructor = u(VX_DEMO.users.instructor);
  const field = u(VX_DEMO.users.fieldAgent);
  const period = kinshasaDate(svc.now()).slice(0, 7);

  // Carrière (module 22) du redevable fictif, enregistrée par le contrôleur (cadastre commun).
  const quarry = svc.fiches.registerObject(instructor, {
    module: '22', taxpayerId: SECTEURS_DEMO.taxpayerId, commune: 'Nsele', quartier: 'Kinkole', lat: -4.345, lon: 15.505,
    attributes: { nom: 'Carrière de sable [EXEMPLE] — Nsele', superficie_ha: '4', titre: '[EXEMPLE] Titre d’exploitation fictif' },
  }).object;

  // Déclarations du redevable (quantités [EXEMPLE]).
  const d17 = s.declare(owner, { kind: 'VOLUMES_BAT', period, lines: { biere_litres: '12000', spiritueux_litres: '800' }, documents: [] });
  const d22 = s.declare(owner, { kind: 'SORTIES_CARRIERE', objectId: quarry.id, period, lines: { camions: '40', volume_m3: '480' }, documents: [] });
  s.declare(owner, { kind: 'PFNL', period, lines: { quantite_kg: '800' }, documents: [] });

  // Données tierces sous protocole (partenaire fictif) et relevés de terrain.
  s.thirdPartyData(u(SECTEURS_DEMO.partner), { module: '17', source: 'ACCISES', taxpayerId: SECTEURS_DEMO.taxpayerId, period, lines: { biere_litres: '12000', spiritueux_litres: '800' } });
  s.observe(field, '22', { source: 'COMPTAGE_SORTIES', objectId: quarry.id, period, lines: { camions: '46', volume_m3: '552' } });
  s.observe(field, '13', { source: 'RELEVE_EMBARQUEMENT', referenceId: 'EMB-EX-01', period, lines: { passagers: '64' } });
  s.observe(field, '24', { source: 'RELEVE_ACCOSTAGE', referenceId: 'QUAI-EX-01', period, lines: { accostages: '3', passagers: '120' } });
  s.observe(field, '25', { source: 'PASSAGE_PEAGE', referenceId: 'AXE-EX-02', period, lines: { passages: '210' } });
  s.observe(instructor, '23', { source: 'POINT_CONTROLE', referenceId: 'PCF-EX-01', period, lines: { quantite_kg: '750' } });

  // Rapprochements par le contrôleur : boissons sans écart, carrière avec écart défavorable (contradictoire à décider par
  // une autre personne) ; la déclaration forestière reste à rapprocher.
  s.reconcile(instructor, d17.id);
  s.reconcile(instructor, d22.id);
}
