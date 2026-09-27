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
import { VX_DEMO_RULES, type VerticalesService } from './service.js';

export const VX_DEMO = {
  taxpayerId: 'TP-DEMO-0001',
  airlineTaxpayerId: 'TP-VX-AVIA-01',
  telecomTaxpayerId: 'TP-VX-TEL-01',
  stallId: 'MCH-GMB-C-1044',
  users: {
    instructor: 'vx-instructeur-dgtk',
    chief: 'vx-chef-service-dgtk',
    fieldAgent: 'vx-agent-terrain-dgtk',
    airline: 'vx-compagnie-aerienne',
    airport: 'vx-exploitant-aeroport',
    telecom: 'vx-operateur-telecom',
    bank: 'vx-banque-calcu',
    publicEntity: 'vx-entite-pilote-calcu',
  },
} as const;

const DEMO_USERS: Omit<User, 'kind'>[] = [
  { id: VX_DEMO.users.instructor, name: 'Instructeur DGTK — verticales (démo)', roles: ['R11'], entity: 'DGTK' },
  { id: VX_DEMO.users.chief, name: 'Cheffe de service DGTK — décisions (démo)', roles: ['R07'], entity: 'DGTK' },
  { id: VX_DEMO.users.fieldAgent, name: 'Agent de terrain DGTK (démo)', roles: ['R10'], entity: 'DGTK', territory: ['Gombe', 'Ngaliema', 'Lingwala', 'Kalamu', 'Nsele'] },
  { id: VX_DEMO.users.airline, name: 'Compagnie aérienne fictive (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: VX_DEMO.airlineTaxpayerId },
  { id: VX_DEMO.users.airport, name: 'Exploitant d’aérodrome — données d’embarquement (démo)', roles: ['R34'], entity: 'EXPLOITANT-AERO' },
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
  ctx.taxpayers.register({ phone: '+243810009902', fullName: 'Opérateur télécom fictif (démo)', language: 'fr', situation: 'other' }, VX_DEMO.telecomTaxpayerId);

  // Règles FICTIVES publiées par le circuit des quatre visas.
  for (const r of DEMO_RULES) publishDemoRule(ctx, r);

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
}
