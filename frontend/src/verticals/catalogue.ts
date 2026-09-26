/**
 * Espaces citoyens des verticales (§ 11.3). Chaque verticale partage le socle : compte unique,
 * registre des règles, circuit de paiement vers le compte public. Aucune verticale n'a son propre
 * compte contribuable ni son propre circuit de paiement.
 *
 * Données de démonstration — [EXEMPLE], non opposables. Aucun taux n'est affirmé : un montant n'est
 * exigible que si la règle est ACTIVE (quatre visas). Les verticales sans acte affichent « Acte requis ».
 */

export type LegalStatus = 'CONFIRME' | 'A_VERIFIER' | 'ACTE_REQUIS';
export type ObjStatus = 'VERIFIE' | 'DECLARE' | 'OBSERVE' | 'CONTESTE';
export type DueStatus = 'A_PAYER' | 'SOLDEE' | 'EN_RETARD' | 'SANS_ACTE' | 'CONTESTEE';

export interface VObject { label: string; ref: string; detail: string; status: ObjStatus }
export interface VObligation {
  label: string; period: string; amount?: number; due?: string; status: DueStatus; basis: string;
  /** § 20.3 : commune du fait générateur (lieu du bien, de l'emplacement, de la zone), jamais l'adresse du contribuable. */
  commune?: string;
}
export interface VReceipt { code: string; label: string; date: string; amount: number }

export interface Vertical {
  slug: string;
  name: string;
  short: string;
  icon: string;
  accent: string;
  modules: string;
  legal: LegalStatus;
  audience: string;
  promise: string;
  vigilance: string;
  objectsTitle: string;
  objects: VObject[];
  obligations: VObligation[];
  services: { label: string; hint: string }[];
  receipts: VReceipt[];
  rights: string[];
}

export const LEGAL_LABEL: Record<LegalStatus, string> = {
  CONFIRME: 'Base légale confirmée',
  A_VERIFIER: 'Base légale à vérifier',
  ACTE_REQUIS: 'Acte requis avant tout paiement',
};

export const OBJ_LABEL: Record<ObjStatus, string> = {
  VERIFIE: 'Vérifié', DECLARE: 'Déclaré', OBSERVE: 'Observé', CONTESTE: 'Contesté',
};

export const DUE_LABEL: Record<DueStatus, string> = {
  A_PAYER: 'À payer', SOLDEE: 'Soldée', EN_RETARD: 'En retard', SANS_ACTE: 'Aucun montant exigible', CONTESTEE: 'Contestée — recouvrement suspendu',
};

const RIGHTS_COMMON = [
  'Chaque montant est expliqué : règle, version, base légale, formule.',
  'Vous pouvez contester chaque ligne ; la contestation est tracée.',
  'Aucun paiement en espèces à un agent : seulement vers le compte public.',
];

export const VERTICALS: Vertical[] = [
  {
    slug: 'rakapay', name: 'Billetterie RakaPay', short: 'RakaPay', icon: 'ticket', accent: '#1E9BD7', modules: '76 · 70 · 71 · 81',
    legal: 'ACTE_REQUIS', audience: 'Usagers des transports, conducteurs de moto-taxi (wewa), coopératives',
    promise: 'Tickets urbains et pass des moto-taxis : achetés par téléphone, contrôlés par QR, rapprochés au compte public.',
    vigilance: 'Le pass wewa fait partie de RakaPay : même moteur de tickets, mêmes paiements, mêmes contrôles ; tarif fixé par acte (J28).',
    objectsTitle: 'Mes titres', objects: [], obligations: [], services: [], receipts: [], rights: [],
  },
  {
    slug: 'propriete', name: 'MOSOLO Property', short: 'Propriété', icon: 'building', accent: '#232C6B', modules: '7 · 8 · 9 · 79',
    legal: 'CONFIRME', audience: 'Propriétaires, occupants, mandataires',
    promise: 'Vos biens, leur situation vérifiée et l’impôt foncier expliqué ligne par ligne.',
    vigilance: 'Distinguer propriété déclarée, observée, vérifiée et contestée : déclarer n’est pas prouver.',
    objectsTitle: 'Mes biens',
    objects: [
      { label: 'Parcelle résidentielle', ref: 'KIN-LMT-04-1182', detail: 'Limete · Quartier Industriel · rang 2', status: 'VERIFIE' },
      { label: 'Immeuble à usage mixte', ref: 'KIN-KAL-11-0457', detail: 'Kalamu · Matonge · rang 2', status: 'DECLARE' },
    ],
    obligations: [
      { label: 'Impôt foncier', period: 'Exercice 2027', amount: 216000, due: '2027-02-01', status: 'SOLDEE', commune: 'Limete', basis: 'Règle IF-RES v3 — ACTIVE' },
      { label: 'Impôt foncier', period: 'Exercice 2027', amount: 540000, due: '2027-02-01', status: 'A_PAYER', commune: 'Kalamu', basis: 'Règle IF-MIX v2 — ACTIVE' },
    ],
    services: [
      { label: 'Déclarer un nouveau bien', hint: 'Statut « déclaré » jusqu’à vérification' },
      { label: 'Demander une vérification sur place', hint: 'Rendez-vous avec un agent recenseur' },
      { label: 'Signaler une erreur de surface ou d’usage', hint: 'Pièces justificatives en ligne' },
      { label: 'Télécharger une attestation de situation', hint: 'Signée, vérifiable par QR' },
    ],
    receipts: [{ code: 'Q7K2-P4MX', label: 'Impôt foncier 2027 — KIN-LMT-04-1182', date: '2027-01-18', amount: 216000 }],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'locatif', name: 'MOSOLO Rental', short: 'Locatif', icon: 'home', accent: '#E0A526', modules: '9',
    legal: 'CONFIRME', audience: 'Bailleurs, locataires, gestionnaires',
    promise: 'Baux enregistrés, loyers prouvés, impôt sur les revenus locatifs calculé sur preuve.',
    vigilance: 'Distinguer le taux de l’impôt et le taux de la retenue ; aucune liquidation sans preuve du bail.',
    objectsTitle: 'Mes baux',
    objects: [
      { label: 'Appartement A2 — bail d’habitation', ref: 'BAIL-2026-00931', detail: 'Ngaliema · Binza Ozone · loyer mensuel', status: 'VERIFIE' },
      { label: 'Local commercial — rez-de-chaussée', ref: 'BAIL-2026-01207', detail: 'Gombe · boulevard du 30 Juin', status: 'DECLARE' },
    ],
    obligations: [
      { label: 'Impôt sur les revenus locatifs', period: 'Janvier 2027', amount: 66000, due: '2027-02-15', status: 'A_PAYER', commune: 'Ngaliema', basis: 'Règle IRL v4 — ACTIVE' },
      { label: 'Impôt sur les revenus locatifs', period: 'Décembre 2026', amount: 66000, due: '2027-01-15', status: 'SOLDEE', commune: 'Ngaliema', basis: 'Règle IRL v4 — ACTIVE' },
    ],
    services: [
      { label: 'Enregistrer un bail', hint: 'Bailleur et locataire confirment chacun' },
      { label: 'Déclarer une vacance', hint: 'Aucun impôt sur un loyer non perçu, sur preuve' },
      { label: 'Attestation de retenue pour le locataire', hint: 'Téléchargeable et vérifiable' },
    ],
    receipts: [{ code: 'R3N8-L6QA', label: 'IRL décembre 2026 — BAIL-2026-00931', date: '2027-01-09', amount: 66000 }],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'entreprises', name: 'MOSOLO Business', short: 'Entreprises', icon: 'store', accent: '#4453b5', modules: '10 · 17 · 56',
    legal: 'A_VERIFIER', audience: 'Commerçants, entreprises, professions libérales',
    promise: 'Un dossier unique par activité : déclarations, autorisations et paiements au même endroit.',
    vigilance: 'L’existence d’une activité ne vaut pas assujettissement : chaque obligation cite sa règle.',
    objectsTitle: 'Mes établissements',
    objects: [
      { label: 'Boutique d’électroménager', ref: 'ETB-KIN-GMB-00412', detail: 'Gombe · avenue du Commerce', status: 'VERIFIE' },
      { label: 'Dépôt secondaire', ref: 'ETB-KIN-LMT-01877', detail: 'Limete · 7e rue', status: 'OBSERVE' },
    ],
    obligations: [
      { label: 'Déclaration d’activité annuelle', period: '2027', due: '2027-03-31', status: 'A_PAYER', amount: 150000, commune: 'Gombe', basis: 'Règle ACT-DEC v1 — À VÉRIFIER : non exigible tant que non ACTIVE' },
    ],
    services: [
      { label: 'Déclarer une activité', hint: 'Une seule saisie pour tous les services' },
      { label: 'Signaler une cessation', hint: 'Arrêt des obligations futures, sur preuve' },
      { label: 'Désigner un mandataire', hint: 'Comptable ou gestionnaire habilité' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'mobilite', name: 'MOSOLO Mobility', short: 'Mobilité', icon: 'car', accent: '#8a5cc2', modules: '11 · 12 · 13 · 25',
    legal: 'A_VERIFIER', audience: 'Propriétaires de véhicules, transporteurs',
    promise: 'Vos véhicules et leurs droits provinciaux, sans double paiement avec le pouvoir central.',
    vigilance: 'Coordination avec le pouvoir central (immatriculation) : aucun droit n’est dupliqué.',
    objectsTitle: 'Mes véhicules',
    objects: [
      { label: 'Minibus 18 places', ref: 'KN-4471-BD', detail: 'Transport en commun · ligne Victoire–Kintambo', status: 'VERIFIE' },
      { label: 'Véhicule particulier', ref: 'KN-0932-AF', detail: 'Usage personnel', status: 'VERIFIE' },
    ],
    obligations: [
      { label: 'Taxe journalière des transports', period: 'Minibus KN-4471-BD', status: 'SANS_ACTE', basis: 'Règle TJT — ACTE REQUIS (J25)' },
    ],
    services: [
      { label: 'Ajouter un véhicule', hint: 'Lien avec l’immatriculation nationale' },
      { label: 'Déclarer une vente ou une mise hors service', hint: 'Fin des obligations à la date prouvée' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'stationnement', name: 'MOSOLO Parking', short: 'Stationnement', icon: 'parking', accent: '#1E8C3A', modules: '14 · 75',
    legal: 'ACTE_REQUIS', audience: 'Automobilistes, gestionnaires de parkings',
    promise: 'Stationner, payer au temps passé par téléphone, recevoir une preuve immédiate.',
    vigilance: 'Acte de zonage et barème requis : aucun ticket vendu avant publication.',
    objectsTitle: 'Mes véhicules enregistrés',
    objects: [{ label: 'Véhicule particulier', ref: 'KN-0932-AF', detail: 'Plaque associée au compte', status: 'VERIFIE' }],
    obligations: [{ label: 'Stationnement payant — zone Gombe centre', period: 'Barème en attente', status: 'SANS_ACTE', commune: 'Gombe', basis: 'Règle PARK-Z1 — ACTE REQUIS' }],
    services: [
      { label: 'Consulter les zones et horaires', hint: 'Carte publiée avec l’acte de zonage' },
      { label: 'Contester un constat', hint: 'Aucune fourrière décidée par un algorithme' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'publicite', name: 'MOSOLO Advertising', short: 'Publicité', icon: 'megaphone', accent: '#eb6834', modules: '15 · 77',
    legal: 'CONFIRME', audience: 'Annonceurs, régies publicitaires, commerçants',
    promise: 'Vos dispositifs publicitaires géolocalisés, autorisés et payés en ligne.',
    vigilance: 'Constat humain obligatoire : aucune sanction automatique à partir d’une photo.',
    objectsTitle: 'Mes dispositifs',
    objects: [
      { label: 'Panneau 12 m² double face', ref: 'PUB-GMB-0088', detail: 'Gombe · boulevard du 30 Juin', status: 'VERIFIE' },
      { label: 'Enseigne lumineuse', ref: 'PUB-KAL-0311', detail: 'Kalamu · avenue Victoire', status: 'OBSERVE' },
    ],
    obligations: [
      { label: 'Taxe sur la publicité', period: '2027', amount: 1200000, due: '2027-03-31', status: 'A_PAYER', commune: 'Gombe', basis: 'Règle PUB-PAN v2 — ACTIVE' },
      { label: 'Taxe sur la publicité', period: '2027', amount: 180000, due: '2027-03-31', status: 'CONTESTEE', commune: 'Kalamu', basis: 'Règle PUB-ENS v2 — ACTIVE' },
    ],
    services: [
      { label: 'Demander une autorisation d’affichage', hint: 'Emplacement, format, durée' },
      { label: 'Déclarer un retrait de dispositif', hint: 'Photo datée, constat de retrait' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'telecom', name: 'MOSOLO Telecom', short: 'Télécom', icon: 'antenna', accent: '#e87ba4', modules: '16',
    legal: 'A_VERIFIER', audience: 'Opérateurs de télécommunications, propriétaires de sites',
    promise: 'Un inventaire partagé des sites et un dialogue tracé avec les opérateurs.',
    vigilance: 'Contentieux possible sur l’assiette : dialogue avec les opérateurs avant toute émission.',
    objectsTitle: 'Mes sites',
    objects: [
      { label: 'Pylône 36 m', ref: 'SITE-NGL-0142', detail: 'Ngaliema · Mont-Fleury', status: 'VERIFIE' },
      { label: 'Site en toiture', ref: 'SITE-GMB-0901', detail: 'Gombe · immeuble Sozacom', status: 'DECLARE' },
    ],
    obligations: [{ label: 'Redevance sur les sites', period: '2027', status: 'SANS_ACTE', basis: 'Règle TEL-SITE — À VÉRIFIER : assiette en discussion' }],
    services: [
      { label: 'Rapprocher l’inventaire des sites', hint: 'Fichier de l’opérateur contre relevé terrain' },
      { label: 'Ouvrir un dialogue technique', hint: 'Échanges et décisions horodatés' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'marches', name: 'MOSOLO Markets & Public Domain', short: 'Marchés', icon: 'basket', accent: '#e34948', modules: '20',
    legal: 'CONFIRME', audience: 'Vendeurs des marchés, occupants du domaine public',
    promise: 'Votre étal payé par téléphone, sans espèces : fin des perceptions multiples.',
    vigilance: 'Collecte historiquement en espèces : priorité anti-fraude, aucun agent n’encaisse.',
    objectsTitle: 'Mes emplacements',
    objects: [{ label: 'Étal — pagne et tissus', ref: 'MCH-GMB-C-1044', detail: 'Marché central · rangée C', status: 'VERIFIE' }],
    obligations: [
      { label: 'Droit d’étal — mensuel', period: 'Février 2027', amount: 15000, due: '2027-02-05', status: 'A_PAYER', commune: 'Gombe', basis: 'Règle MCH-ETAL v1 — ACTIVE' },
      { label: 'Droit d’étal — mensuel', period: 'Janvier 2027', amount: 15000, due: '2027-01-05', status: 'SOLDEE', commune: 'Gombe', basis: 'Règle MCH-ETAL v1 — ACTIVE' },
    ],
    services: [
      { label: 'Payer au jour, à la semaine ou au mois', hint: 'USSD, Mobile Money, point agréé' },
      { label: 'Signaler une demande d’argent irrégulière', hint: 'Signalement protégé, suivi garanti' },
    ],
    receipts: [{ code: 'M5D1-E8TR', label: 'Droit d’étal janvier 2027 — MCH-GMB-C-1044', date: '2027-01-03', amount: 15000 }],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'environnement', name: 'MOSOLO Environment', short: 'Environnement', icon: 'leaf', accent: '#1E8C3A', modules: '18 · 19',
    legal: 'ACTE_REQUIS', audience: 'Ménages, entreprises, producteurs d’emballages',
    promise: 'Collecte des déchets et contributions environnementales suivies de bout en bout.',
    vigilance: 'Contribution plastique non activable sans acte : aucun montant n’est affiché.',
    objectsTitle: 'Mes points de collecte',
    objects: [{ label: 'Point de collecte résidentiel', ref: 'ENV-LMT-2231', detail: 'Limete · Quartier Industriel', status: 'DECLARE' }],
    obligations: [{ label: 'Contribution plastique', period: '—', status: 'SANS_ACTE', basis: 'Règle ENV-PLAST — ACTE REQUIS' }],
    services: [
      { label: 'Signaler un dépôt sauvage', hint: 'Photo et position, sans sanction automatique' },
      { label: 'Consulter le calendrier de collecte', hint: 'Par quartier' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'ports', name: 'MOSOLO Ports', short: 'Ports', icon: 'anchor', accent: '#232C6B', modules: '13 · 24',
    legal: 'A_VERIFIER', audience: 'Armateurs, transporteurs fluviaux, opérateurs portuaires',
    promise: 'Mouvements et droits portuaires provinciaux déclarés et suivis au même endroit.',
    vigilance: 'Cadrage sectoriel préalable : aucune perception avant accord des autorités compétentes.',
    objectsTitle: 'Mes embarcations',
    objects: [{ label: 'Baleinière 40 t', ref: 'EMB-KIN-0519', detail: 'Port de Kinkole', status: 'DECLARE' }],
    obligations: [{ label: 'Droits portuaires provinciaux', period: '—', status: 'SANS_ACTE', basis: 'Cadrage sectoriel en cours — À VÉRIFIER' }],
    services: [{ label: 'Déclarer un mouvement', hint: 'Arrivée, départ, tonnage' }],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'evenements', name: 'MOSOLO Events', short: 'Événements', icon: 'star', accent: '#8a5cc2', modules: '21',
    legal: 'A_VERIFIER', audience: 'Organisateurs de spectacles et d’événements',
    promise: 'Autorisation en ligne, certificat QR affiché, déclaration de billetterie simplifiée.',
    vigilance: 'Assiette déclarative sur billetterie : rapprochement déclaration ↔ contrôle.',
    objectsTitle: 'Mes événements',
    objects: [{ label: 'Concert — Stade des Martyrs', ref: 'EVT-2027-0042', detail: '14 février 2027 · jauge déclarée 38 000', status: 'DECLARE' }],
    obligations: [{ label: 'Droit sur les spectacles', period: 'EVT-2027-0042', amount: 2400000, due: '2027-02-21', status: 'A_PAYER', commune: 'Lingwala', basis: 'Règle EVT-SPEC v1 — À VÉRIFIER : non exigible tant que non ACTIVE' }],
    services: [
      { label: 'Demander une autorisation', hint: 'Pièces en ligne, suivi du dossier' },
      { label: 'Déclarer la billetterie', hint: 'Import du fichier RakaPay ou d’un autre opérateur' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'construction', name: 'MOSOLO Construction', short: 'Construction', icon: 'crane', accent: '#E0A526', modules: '22 · 82',
    legal: 'CONFIRME', audience: 'Maîtres d’ouvrage, entreprises du bâtiment',
    promise: 'Votre chantier suivi du dépôt au quitus, chaque droit expliqué.',
    vigilance: 'Quitus et droits liés aux chantiers : l’un ne se substitue pas à l’autre.',
    objectsTitle: 'Mes chantiers',
    objects: [{ label: 'Immeuble R+4 — logements', ref: 'CHT-NGL-2026-117', detail: 'Ngaliema · Ma Campagne · en cours', status: 'VERIFIE' }],
    obligations: [{ label: 'Droits liés au chantier', period: 'Phase gros œuvre', amount: 3600000, due: '2027-04-30', status: 'A_PAYER', commune: 'Ngaliema', basis: 'Règle CHT-DRT v2 — ACTIVE' }],
    services: [
      { label: 'Déposer une demande', hint: 'Plans et pièces en ligne' },
      { label: 'Demander le quitus', hint: 'Après visite de conformité' },
    ],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'actifs', name: 'MOSOLO Assets', short: 'Actifs', icon: 'bank', accent: '#4453b5', modules: '61 · 92',
    legal: 'A_VERIFIER', audience: 'Candidats à la valorisation des actifs provinciaux',
    promise: 'Les actifs provinciaux proposés par mise en concurrence publique et traçable.',
    vigilance: 'Valorisation par mise en concurrence uniquement : aucune attribution de gré à gré.',
    objectsTitle: 'Mes candidatures',
    objects: [{ label: 'Terrain provincial — lot 7', ref: 'ACT-2027-AO-003', detail: 'Nsele · appel à manifestation d’intérêt', status: 'DECLARE' }],
    obligations: [],
    services: [
      { label: 'Consulter les appels ouverts', hint: 'Cahiers des charges publiés' },
      { label: 'Déposer une offre', hint: 'Horodatée, scellée jusqu’à l’ouverture' },
    ],
    receipts: [],
    rights: ['Offres scellées jusqu’à l’ouverture publique.', 'Résultats et motifs publiés.', 'Recours ouvert à tout candidat.'],
  },
  {
    slug: 'recouvrement', name: 'MOSOLO Recovery', short: 'Recouvrement', icon: 'scale', accent: '#e34948', modules: '32 · 33 · 36 · 83 · 90',
    legal: 'CONFIRME', audience: 'Contribuables ayant un arriéré',
    promise: 'Régulariser simplement : échéancier, remise prévue par la loi, recours garanti.',
    vigilance: 'Proportionnalité et recours : aucune mesure sans décision humaine motivée.',
    objectsTitle: 'Mes dossiers',
    objects: [{ label: 'Arriéré impôt foncier 2025', ref: 'REC-2026-08812', detail: 'Échéancier proposé en 4 mensualités', status: 'VERIFIE' }],
    obligations: [
      { label: 'Échéance 2/4', period: 'Février 2027', amount: 125000, due: '2027-02-28', status: 'A_PAYER', commune: 'Limete', basis: 'Échéancier REC-2026-08812 — accordé' },
      { label: 'Échéance 1/4', period: 'Janvier 2027', amount: 125000, due: '2027-01-31', status: 'SOLDEE', commune: 'Limete', basis: 'Échéancier REC-2026-08812 — accordé' },
    ],
    services: [
      { label: 'Demander un échéancier', hint: 'Réponse motivée' },
      { label: 'Former un recours', hint: 'Instruit par une autre personne que l’auteur de la décision' },
    ],
    receipts: [{ code: 'C9W4-R2KE', label: 'Échéance 1/4 — REC-2026-08812', date: '2027-01-29', amount: 125000 }],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'avia', name: 'MOSOLO AVIA', short: 'AVIA', icon: 'plane', accent: '#1E9BD7', modules: '62 · 78',
    legal: 'ACTE_REQUIS', audience: 'Compagnies aériennes, exploitants d’aérodromes',
    promise: 'Déclarations de mouvements et redevances provinciales, validées avant toute facturation.',
    vigilance: 'Validation juridique et coordination multi-acteurs préalables : aucune facturation automatique.',
    objectsTitle: 'Mes aéronefs',
    objects: [{ label: 'Aéronef régional 70 places', ref: '9S-AXK', detail: 'Base N’Djili', status: 'DECLARE' }],
    obligations: [{ label: 'Redevance provinciale', period: '—', status: 'SANS_ACTE', basis: 'Règle AVIA — ACTE REQUIS' }],
    services: [{ label: 'Déclarer les mouvements du mois', hint: 'Rapprochés avec les données de l’exploitant' }],
    receipts: [],
    rights: RIGHTS_COMMON,
  },
];

export function findVertical(slug: string | undefined): Vertical | undefined {
  return VERTICALS.find((v) => v.slug === slug);
}

/** Montant en CDF, chaîne décimale (jamais de flottant pour un montant). */
export const cdf = (n: number) => ({ amount: `${n}.00`, currency: 'CDF' as const });
