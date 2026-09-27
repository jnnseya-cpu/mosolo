/**
 * Catalogue serveur des verticales (§ 11.3, Annexe H § H.5.3 et § H.27).
 * Chaque verticale partage le socle : compte unique, registre des règles, circuit de paiement vers le compte public.
 * Aucune verticale n'a son propre compte contribuable, ses propres règles hors registre ni son propre circuit de paiement.
 *
 * Statut juridique : aucune règle sectorielle n'est certifiée à ce jour. « BASE_A_CERTIFIER » signifie que la base
 * légale existe en principe (colonne « E » du § 11.1) mais que textes et barèmes restent à certifier par le Comité
 * juridique et tarifaire : aucun montant n'est exigible tant qu'une règle ACTIVE (quatre visas) n'existe pas.
 */
import type { ObjectCategory } from '../../modules/objects/service.js';

export type LegalStatus = 'BASE_A_CERTIFIER' | 'BASE_PARTIELLE' | 'ACTE_REQUIS' | 'CADRAGE_REQUIS';

export const LEGAL_LABEL: Record<LegalStatus, string> = {
  BASE_A_CERTIFIER: 'Base légale existante — textes et barèmes à certifier',
  BASE_PARTIELLE: 'Base légale partielle — acte requis pour une partie',
  ACTE_REQUIS: 'Acte requis avant tout paiement',
  CADRAGE_REQUIS: 'Cadrage sectoriel préalable — aucun paiement',
};

/** Verticales dont les prélèvements ne peuvent produire AUCUNE obligation tant que l'acte n'est pas adopté. */
export const NO_LEVY_STATUSES: LegalStatus[] = ['ACTE_REQUIS', 'CADRAGE_REQUIS'];

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'commune' | 'textarea';

export interface ProcedureField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
}

export type ProcedureKind = 'AUTORISATION' | 'DECLARATION' | 'CESSATION' | 'SIGNALEMENT' | 'VERIFICATION' | 'QUITUS' | 'DEMANDE';

/** Effet de l'acceptation (décision humaine motivée) d'une démarche. */
export type ProcedureEffect =
  | { kind: 'NONE' }
  | { kind: 'CREATE_OBJECT'; category: ObjectCategory; objectType: string; certificate?: CertificateKind }
  | { kind: 'CERTIFICATE'; certificate: CertificateKind }
  | { kind: 'CESSATION' }
  | { kind: 'ASSIGN_STALL' };

export type CertificateKind = 'AUTORISATION_EVENEMENT' | 'PERMIS_OCCUPER_VOIE' | 'QUITUS_CHANTIER' | 'AUTORISATION_OCCUPATION' | 'AUTORISATION_ACTIVITE' | 'AUTORISATION_TRANSPORT';

export const CERTIFICATE_LABEL: Record<CertificateKind, string> = {
  AUTORISATION_EVENEMENT: 'Autorisation d’événement',
  PERMIS_OCCUPER_VOIE: 'Permis d’occuper la voie (chantier)',
  QUITUS_CHANTIER: 'Quitus de chantier',
  AUTORISATION_OCCUPATION: 'Autorisation d’occupation du domaine public',
  AUTORISATION_ACTIVITE: 'Autorisation d’exploitation',
  AUTORISATION_TRANSPORT: 'Autorisation de transport',
};

export interface ProcedureDef {
  code: string;
  label: string;
  hint: string;
  kind: ProcedureKind;
  /** La démarche porte sur un objet existant du demandeur. */
  requiresObject: boolean;
  /** Visite sur place : obligatoire avant décision (constat CONFORME exigé), optionnelle, ou sans objet. */
  visit: 'OBLIGATOIRE' | 'OPTIONNELLE' | 'SANS';
  /** Pièces attendues (déposées par empreinte SHA-256, jamais le fichier). */
  documents: string[];
  fields: ProcedureField[];
  effect: ProcedureEffect;
  /** Signalement sensible (demande d'espèces, faux agent) : transmis aussi à l'anti-fraude, identité protégée. */
  protectedReport?: boolean;
}

export interface PendingLevy {
  label: string;
  basis: string;
}

export interface VerticalDef {
  slug: string;
  name: string;
  short: string;
  icon: string;
  accent: string;
  /** Composition retenue par l'Annexe H (§ H.5.3). */
  modules: number[];
  legal: LegalStatus;
  /** Prérequis juridiques (codes J/G/D du document maître). */
  prerequisites: string[];
  /** Entité gestionnaire (instruit les démarches, reçoit les recettes sur son alias public). */
  entity: string;
  entityName: string;
  /** Tutelle indicative (Cahier § 37A, table indicative) [À VÉRIFIER]. */
  tutelle: string;
  release: string;
  audience: string;
  promise: string;
  vigilance: string;
  objectsTitle: string;
  /** Catégories d'objets du socle rattachées à la verticale (hors attribut `verticale` explicite). */
  objectCategories: ObjectCategory[];
  procedures: ProcedureDef[];
  pendingLevies: PendingLevy[];
  rights: string[];
  /** Verticale servie par un autre module (RakaPay, stationnement, publicité) : seule la carte est gérée ici. */
  managedBy?: string;
}

export const ENTITY_NAMES: Record<string, string> = {
  DGIPK: 'Direction générale des impôts provinciaux de Kinshasa',
  DGTK: 'Direction générale des droits, taxes et redevances de Kinshasa',
  MINFIN: 'Ministère provincial des Finances',
  AUDIT: 'Organe de contrôle et d’inspection de la Ville',
};

const RIGHTS_COMMON = [
  'Chaque montant est expliqué : règle, version, base légale, formule.',
  'Vous pouvez contester chaque ligne ; la contestation est tracée.',
  'Aucun paiement en espèces à un agent : seulement vers le compte public.',
  'Aucune sanction décidée par un algorithme : une personne habilitée décide, avec motif et recours.',
];

const COMMUNE_FIELDS: ProcedureField[] = [
  { key: 'commune', label: 'Commune', type: 'commune', required: true },
  { key: 'quartier', label: 'Quartier', type: 'text', required: true },
];

const cessation = (label: string, hint: string): ProcedureDef => ({
  code: 'SIGNALEMENT_CESSATION', label, hint, kind: 'CESSATION', requiresObject: true, visit: 'OPTIONNELLE',
  documents: ['Preuve de la cessation (acte, attestation, photo datée)'],
  fields: [{ key: 'dateEffet', label: 'Date d’effet', type: 'date', required: true }, { key: 'motif', label: 'Motif', type: 'textarea', required: true }],
  effect: { kind: 'CESSATION' },
});

export const VERTICALS: VerticalDef[] = [
  {
    slug: 'rakapay', name: 'Billetterie RakaPay', short: 'RakaPay', icon: 'ticket', accent: '#1E9BD7', modules: [12, 14, 20, 25, 66, 70, 71, 76, 81],
    legal: 'ACTE_REQUIS', prerequisites: ['J28 — tarif du pass wewa et des tickets fixé par acte'], entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!,
    tutelle: 'Transports et mobilité [À VÉRIFIER]', release: 'R3',
    audience: 'Usagers des transports, conducteurs de moto-taxi (wewa), coopératives',
    promise: 'Tickets urbains et pass des moto-taxis : achetés par téléphone, contrôlés par QR, rapprochés au compte public.',
    vigilance: 'Le pass wewa fait partie de RakaPay : même moteur de tickets, mêmes paiements, mêmes contrôles ; tarif fixé par acte (J28).',
    objectsTitle: 'Mes titres', objectCategories: [], procedures: [], pendingLevies: [{ label: 'Pass wewa et tickets urbains', basis: 'ACTE REQUIS (J28)' }],
    rights: RIGHTS_COMMON, managedBy: 'rakapay',
  },
  {
    slug: 'propriete', name: 'MOSOLO Property', short: 'Propriété', icon: 'building', accent: '#232C6B', modules: [7, 8, 9, 34, 79, 82],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J3 — barèmes IF 2026', 'J4 — Édit n° 005/2021', 'J27 — acte NFIU (obligation de plaque)', 'J6 — quitus'],
    entity: 'DGIPK', entityName: ENTITY_NAMES.DGIPK!, tutelle: 'Finances', release: 'R0 à R2',
    audience: 'Propriétaires, occupants, mandataires',
    promise: 'Vos biens, leur plaque NFIU, leur situation vérifiée et l’impôt foncier expliqué ligne par ligne.',
    vigilance: 'Distinguer propriété déclarée, observée, vérifiée et contestée : déclarer n’est pas prouver.',
    objectsTitle: 'Mes biens', objectCategories: ['PARCELLE', 'BATIMENT'],
    procedures: [
      { code: 'DEMANDE_VERIFICATION', label: 'Demander une vérification sur place', hint: 'Rendez-vous avec un agent recenseur', kind: 'VERIFICATION', requiresObject: true, visit: 'OBLIGATOIRE', documents: ['Titre ou preuve d’occupation (facultatif)'], fields: [{ key: 'disponibilites', label: 'Disponibilités', type: 'text' }], effect: { kind: 'NONE' } },
      { code: 'SIGNALEMENT_ERREUR', label: 'Signaler une erreur de surface ou d’usage', hint: 'Pièces justificatives en ligne', kind: 'SIGNALEMENT', requiresObject: true, visit: 'OPTIONNELLE', documents: ['Pièce justificative'], fields: [{ key: 'champ', label: 'Donnée concernée', type: 'select', required: true, options: [{ value: 'superficie', label: 'Superficie' }, { value: 'usage', label: 'Usage' }, { value: 'batiments', label: 'Nombre de bâtiments' }] }, { key: 'valeurProposee', label: 'Valeur proposée', type: 'text', required: true }], effect: { kind: 'NONE' } },
      { code: 'DEMANDE_PLAQUE', label: 'Demander la pose de la plaque NFIU', hint: 'Numéro fiscal immobilier unique, QR signé', kind: 'DEMANDE', requiresObject: true, visit: 'OBLIGATOIRE', documents: [], fields: [], effect: { kind: 'NONE' } },
    ],
    pendingLevies: [], rights: RIGHTS_COMMON,
  },
  {
    slug: 'locatif', name: 'MOSOLO Rental', short: 'Locatif', icon: 'home', accent: '#E0A526', modules: [9, 61, 79],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J3 — arrêté des taux IRL et agents de retenue', 'J13 — protocoles énergie, eau, employeurs'],
    entity: 'DGIPK', entityName: ENTITY_NAMES.DGIPK!, tutelle: 'Finances', release: 'R0 à R1',
    audience: 'Bailleurs, locataires, gestionnaires',
    promise: 'Baux enregistrés, loyers prouvés, impôt sur les revenus locatifs calculé sur preuve.',
    vigilance: 'Distinguer le taux de l’impôt et le taux de la retenue ; aucune liquidation sans preuve du bail, aucune dette sur un signal.',
    objectsTitle: 'Mes unités louées', objectCategories: ['UNITE_LOCATIVE'],
    procedures: [
      { code: 'DECLARATION_VACANCE', label: 'Déclarer une vacance', hint: 'Aucun impôt sur un loyer non perçu, sur preuve', kind: 'DECLARATION', requiresObject: true, visit: 'OPTIONNELLE', documents: ['Preuve de vacance (état des lieux, relevé)'], fields: [{ key: 'debut', label: 'Début de la vacance', type: 'date', required: true }], effect: { kind: 'NONE' } },
      { code: 'SIGNALEMENT_ERREUR', label: 'Signaler une erreur sur l’unité', hint: 'Surface, niveau, occupation', kind: 'SIGNALEMENT', requiresObject: true, visit: 'OPTIONNELLE', documents: ['Pièce justificative'], fields: [{ key: 'champ', label: 'Donnée concernée', type: 'text', required: true }, { key: 'valeurProposee', label: 'Valeur proposée', type: 'text', required: true }], effect: { kind: 'NONE' } },
    ],
    pendingLevies: [], rights: RIGHTS_COMMON,
  },
  {
    slug: 'entreprises', name: 'MOSOLO Business', short: 'Entreprises', icon: 'store', accent: '#4453b5', modules: [10, 17, 56],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J1 — taxes d’intérêt commun et clés', 'J13 — protocoles brasseries et opérateurs'],
    entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!, tutelle: 'Économie et commerce [À VÉRIFIER]', release: 'R2',
    audience: 'Commerçants, entreprises, professions libérales',
    promise: 'Un dossier unique par activité : déclarations, autorisations et paiements au même endroit.',
    vigilance: 'L’existence d’une activité ne vaut pas assujettissement : chaque obligation cite sa règle.',
    objectsTitle: 'Mes établissements', objectCategories: ['ACTIVITE'],
    procedures: [
      { code: 'DECLARATION_ACTIVITE', label: 'Déclarer une activité', hint: 'Une seule saisie pour tous les services', kind: 'DECLARATION', requiresObject: false, visit: 'OPTIONNELLE', documents: ['RCCM ou pièce d’identité', 'Photo de l’établissement'],
        fields: [{ key: 'nom', label: 'Nom de l’établissement', type: 'text', required: true }, { key: 'activite', label: 'Activité', type: 'text', required: true }, ...COMMUNE_FIELDS, { key: 'adresse', label: 'Avenue et numéro', type: 'text' }],
        effect: { kind: 'CREATE_OBJECT', category: 'ACTIVITE', objectType: 'ETABLISSEMENT' } },
      { code: 'DEMANDE_AUTORISATION', label: 'Demander une autorisation d’exploitation', hint: 'Débit de boissons : catégorie et horaires', kind: 'AUTORISATION', requiresObject: true, visit: 'OPTIONNELLE', documents: ['Licence ou autorisation existante'], fields: [{ key: 'categorie', label: 'Catégorie', type: 'text', required: true }, { key: 'horaires', label: 'Horaires', type: 'text', required: true }], effect: { kind: 'CERTIFICATE', certificate: 'AUTORISATION_ACTIVITE' } },
      cessation('Signaler une cessation', 'Arrêt des obligations futures, sur preuve'),
    ],
    pendingLevies: [], rights: RIGHTS_COMMON,
  },
  {
    slug: 'mobilite', name: 'MOSOLO Mobility', short: 'Mobilité', icon: 'car', accent: '#8a5cc2', modules: [11, 12, 25, 76, 82],
    legal: 'BASE_PARTIELLE', prerequisites: ['J3 — barèmes véhicules', 'J1 — taxe spéciale de circulation', 'Protocole avec le pouvoir central (immatriculations)', 'J1 — péage (acte)'],
    entity: 'DGIPK', entityName: ENTITY_NAMES.DGIPK!, tutelle: 'Finances ; Transports et mobilité (autorisations, péage) [À VÉRIFIER]', release: 'R2 (péage : R4)',
    audience: 'Propriétaires de véhicules, transporteurs',
    promise: 'Vos véhicules et leurs droits provinciaux, sans double paiement avec le pouvoir central.',
    vigilance: 'Coordination avec le pouvoir central (immatriculation) : aucun droit n’est dupliqué ; aucune immobilisation décidée par l’algorithme.',
    objectsTitle: 'Mes véhicules', objectCategories: ['VEHICULE'],
    procedures: [
      { code: 'DEMANDE_AUTORISATION_TRANSPORT', label: 'Demander une autorisation de transport', hint: 'Taxi, bus, minibus : instruite par un agent', kind: 'AUTORISATION', requiresObject: true, visit: 'SANS', documents: ['Carte grise', 'Permis de conduire'], fields: [{ key: 'service', label: 'Type de service', type: 'select', required: true, options: [{ value: 'TAXI', label: 'Taxi' }, { value: 'BUS', label: 'Bus' }, { value: 'MINIBUS', label: 'Minibus' }, { value: 'POIDS_LOURD', label: 'Poids lourd' }] }, { key: 'itineraire', label: 'Ligne ou zone', type: 'text' }], effect: { kind: 'CERTIFICATE', certificate: 'AUTORISATION_TRANSPORT' } },
      cessation('Déclarer une vente ou une mise hors service', 'Fin des obligations à la date prouvée'),
    ],
    pendingLevies: [{ label: 'Taxe journalière des transports', basis: 'ACTE REQUIS — titre journalier via RakaPay (J28)' }, { label: 'Péage provincial', basis: 'ACTE REQUIS (J1)' }],
    rights: RIGHTS_COMMON,
  },
  {
    slug: 'stationnement', name: 'MOSOLO Parking', short: 'Stationnement', icon: 'parking', accent: '#1E8C3A', modules: [14, 70, 71, 75, 76],
    legal: 'ACTE_REQUIS', prerequisites: ['J24 — acte de zonage et barème'], entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!,
    tutelle: 'Transports et mobilité [À VÉRIFIER]', release: 'R2, après acte',
    audience: 'Automobilistes, gestionnaires de parkings',
    promise: 'Stationner, payer au temps passé par téléphone, recevoir une preuve immédiate.',
    vigilance: 'Acte de zonage et barème requis : aucun ticket vendu avant publication ; aucune fourrière décidée par un algorithme.',
    objectsTitle: 'Mes véhicules enregistrés', objectCategories: [], procedures: [],
    pendingLevies: [{ label: 'Stationnement payant', basis: 'ACTE REQUIS (J24)' }], rights: RIGHTS_COMMON, managedBy: 'parking',
  },
  {
    slug: 'publicite', name: 'MOSOLO Advertising', short: 'Publicité', icon: 'megaphone', accent: '#eb6834', modules: [15, 35, 77],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J1 — base légale de la taxe', 'J19 — procédure de constat et accréditation des contrôleurs'],
    entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!, tutelle: 'Infrastructures et urbanisme [À VÉRIFIER]', release: 'R2',
    audience: 'Annonceurs, régies publicitaires, commerçants',
    promise: 'Vos dispositifs publicitaires géolocalisés, autorisés et payés en ligne.',
    vigilance: 'Constat humain obligatoire : aucune sanction automatique à partir d’une photo.',
    objectsTitle: 'Mes dispositifs', objectCategories: ['PANNEAU'], procedures: [], pendingLevies: [], rights: RIGHTS_COMMON, managedBy: 'publicite',
  },
  {
    slug: 'telecom', name: 'MOSOLO Telecom', short: 'Télécom', icon: 'antenna', accent: '#e87ba4', modules: [16, 56],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J1, J3 — base légale et barème', 'J13 — protocole avec les opérateurs et l’ARPTC'],
    entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!, tutelle: 'Finances (cellule grands redevables) [À VÉRIFIER]', release: 'R2',
    audience: 'Opérateurs de télécommunications, propriétaires de sites',
    promise: 'Un inventaire contradictoire des sites et un dialogue tracé avec les opérateurs.',
    vigilance: 'Contentieux possible sur l’assiette : un site observé absent des listes ouvre une vérification contradictoire, jamais une taxation automatique.',
    objectsTitle: 'Mes sites', objectCategories: [],
    procedures: [
      { code: 'DECLARATION_SITE', label: 'Déclarer un site', hint: 'Pylône, toiture, emprise', kind: 'DECLARATION', requiresObject: false, visit: 'OPTIONNELLE', documents: ['Autorisation d’implantation'],
        fields: [{ key: 'reference', label: 'Référence opérateur', type: 'text', required: true }, { key: 'type', label: 'Type de site', type: 'select', required: true, options: [{ value: 'PYLONE', label: 'Pylône' }, { value: 'TOITURE', label: 'Site en toiture' }, { value: 'AUTRE', label: 'Autre' }] }, { key: 'hauteur_m', label: 'Hauteur (m)', type: 'number' }, ...COMMUNE_FIELDS],
        effect: { kind: 'CREATE_OBJECT', category: 'AUTRE', objectType: 'SITE_TELECOM' } },
      { code: 'DIALOGUE_TECHNIQUE', label: 'Ouvrir un dialogue technique', hint: 'Échanges et décisions horodatés', kind: 'DEMANDE', requiresObject: false, visit: 'SANS', documents: [], fields: [{ key: 'objet', label: 'Objet du dialogue', type: 'textarea', required: true }], effect: { kind: 'NONE' } },
      cessation('Déclarer un démantèlement ou une cession de site', 'Mutation entre opérateurs ou retrait, sur preuve'),
    ],
    pendingLevies: [{ label: 'Redevance annuelle sur les sites', basis: 'Règle à certifier — assiette en dialogue avec les opérateurs' }], rights: RIGHTS_COMMON,
  },
  {
    slug: 'marches', name: 'MOSOLO Markets & Public Domain', short: 'Marchés', icon: 'basket', accent: '#e34948', modules: [19, 20, 70, 71, 76],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J22 — décision de perception numérique exclusive ; compétences province, communes, gestionnaires', 'J21 — titres dématérialisés', 'J1, J3 — tarifs du domaine public'],
    entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!, tutelle: 'Économie et commerce [À VÉRIFIER]', release: 'R2',
    audience: 'Vendeurs des marchés, occupants du domaine public',
    promise: 'Votre étal payé par téléphone, au jour, à la semaine ou au mois : fin des perceptions en espèces.',
    vigilance: 'Collecte historiquement en espèces : aucun placier n’encaisse ; le contrôle se fait en scannant la plaque de l’étal, sans téléphone du commerçant.',
    objectsTitle: 'Mes emplacements', objectCategories: [],
    procedures: [
      { code: 'DEMANDE_EMPLACEMENT', label: 'Demander un emplacement', hint: 'Étal libre sur le plan du marché', kind: 'DEMANDE', requiresObject: false, visit: 'SANS', documents: ['Pièce d’identité'], fields: [{ key: 'stallId', label: 'Étal souhaité (référence du plan)', type: 'text', required: true }, { key: 'categorie', label: 'Marchandises', type: 'text', required: true }], effect: { kind: 'ASSIGN_STALL' } },
      { code: 'DEMANDE_OCCUPATION', label: 'Demander une occupation du domaine public', hint: 'Terrasse, étal hors marché, emprise temporaire', kind: 'AUTORISATION', requiresObject: false, visit: 'OPTIONNELLE', documents: ['Plan ou photo de l’emprise'],
        fields: [{ key: 'usage', label: 'Usage', type: 'text', required: true }, { key: 'surface_m2', label: 'Surface (m²)', type: 'number', required: true }, { key: 'debut', label: 'Début', type: 'date', required: true }, { key: 'fin', label: 'Fin', type: 'date', required: true }, ...COMMUNE_FIELDS],
        effect: { kind: 'CREATE_OBJECT', category: 'AUTRE', objectType: 'EMPRISE', certificate: 'AUTORISATION_OCCUPATION' } },
      { code: 'SIGNALEMENT_DEMANDE_ESPECES', label: 'Signaler une demande d’argent irrégulière', hint: 'Signalement protégé, suivi garanti', kind: 'SIGNALEMENT', requiresObject: false, visit: 'SANS', documents: [], fields: [{ key: 'lieu', label: 'Marché ou lieu', type: 'text', required: true }, { key: 'date', label: 'Date', type: 'date', required: true }, { key: 'description', label: 'Ce qui s’est passé', type: 'textarea', required: true }], effect: { kind: 'NONE' }, protectedReport: true },
      cessation('Libérer mon emplacement', 'Fin du droit d’étal à la date indiquée'),
    ],
    pendingLevies: [], rights: RIGHTS_COMMON,
  },
  {
    slug: 'environnement', name: 'MOSOLO Environment', short: 'Environnement', icon: 'leaf', accent: '#1E8C3A', modules: [18, 19, 92],
    legal: 'BASE_PARTIELLE', prerequisites: ['J15, J16 — contribution plastique (acte requis) ; voie REP recommandée (§ 8.5)'],
    entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!, tutelle: 'Environnement [À VÉRIFIER]', release: 'R3 (assainissement) ; R4 après acte (plastique)',
    audience: 'Ménages, entreprises, producteurs et importateurs d’emballages',
    promise: 'Collecte des déchets et registre des metteurs en marché suivis de bout en bout.',
    vigilance: 'Contribution plastique non activable sans acte : le module 18 reste désactivé et aucun montant n’est affiché.',
    objectsTitle: 'Mes points de collecte et déclarations', objectCategories: [],
    procedures: [
      { code: 'DECLARATION_METTEUR_EN_MARCHE', label: 'S’inscrire au registre des metteurs en marché', hint: 'Registre seulement : aucun montant sans acte', kind: 'DECLARATION', requiresObject: false, visit: 'SANS', documents: ['RCCM'],
        fields: [{ key: 'raisonSociale', label: 'Raison sociale', type: 'text', required: true }, { key: 'categorie', label: 'Catégorie', type: 'select', required: true, options: [{ value: 'PRODUCTEUR', label: 'Producteur' }, { value: 'IMPORTATEUR', label: 'Importateur' }, { value: 'DISTRIBUTEUR', label: 'Distributeur' }] }, ...COMMUNE_FIELDS],
        effect: { kind: 'CREATE_OBJECT', category: 'AUTRE', objectType: 'METTEUR_EN_MARCHE' } },
      { code: 'SIGNALEMENT_DEPOT_SAUVAGE', label: 'Signaler un dépôt sauvage', hint: 'Photo et position, sans sanction automatique', kind: 'SIGNALEMENT', requiresObject: false, visit: 'OPTIONNELLE', documents: ['Photo datée'], fields: [...COMMUNE_FIELDS, { key: 'description', label: 'Description', type: 'textarea', required: true }], effect: { kind: 'NONE' } },
    ],
    pendingLevies: [{ label: 'Contribution plastique', basis: 'ACTE REQUIS (J15, J16) — module 18 désactivé' }], rights: RIGHTS_COMMON,
  },
  {
    slug: 'ports', name: 'MOSOLO Ports', short: 'Ports', icon: 'anchor', accent: '#232C6B', modules: [13, 24, 70, 71],
    legal: 'CADRAGE_REQUIS', prerequisites: ['J30 — cadrage sectoriel et base légale'], entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!,
    tutelle: 'Transports et mobilité [À VÉRIFIER]', release: 'R3 après J30',
    audience: 'Armateurs, transporteurs fluviaux, opérateurs portuaires',
    promise: 'Embarcations, quais et mouvements déclarés et suivis au même endroit.',
    vigilance: 'Cadrage sectoriel préalable : aucune perception avant accord des autorités compétentes ; jamais de paiement à l’agent de quai.',
    objectsTitle: 'Mes embarcations', objectCategories: [],
    procedures: [
      { code: 'DECLARATION_EMBARCATION', label: 'Déclarer une embarcation', hint: 'Identifiant, capacité, port d’attache', kind: 'DECLARATION', requiresObject: false, visit: 'OPTIONNELLE', documents: ['Document de navigation'],
        fields: [{ key: 'nom', label: 'Nom de l’embarcation', type: 'text', required: true }, { key: 'type', label: 'Type', type: 'text', required: true }, { key: 'capacite_t', label: 'Capacité (t)', type: 'number', required: true }, { key: 'passagers', label: 'Passagers autorisés', type: 'number' }, { key: 'port', label: 'Port d’attache', type: 'text', required: true }, ...COMMUNE_FIELDS],
        effect: { kind: 'CREATE_OBJECT', category: 'AUTRE', objectType: 'EMBARCATION' } },
      { code: 'DECLARATION_MOUVEMENT', label: 'Déclarer un mouvement', hint: 'Arrivée, départ, passagers, tonnage (manifeste)', kind: 'DECLARATION', requiresObject: true, visit: 'SANS', documents: ['Manifeste (facultatif)'],
        fields: [{ key: 'sens', label: 'Sens', type: 'select', required: true, options: [{ value: 'DEPART', label: 'Départ' }, { value: 'ARRIVEE', label: 'Arrivée' }] }, { key: 'date', label: 'Date', type: 'date', required: true }, { key: 'passagers', label: 'Passagers', type: 'number', required: true }, { key: 'tonnage_t', label: 'Tonnage (t)', type: 'number', required: true }, { key: 'destination', label: 'Provenance ou destination', type: 'text', required: true }],
        effect: { kind: 'NONE' } },
    ],
    pendingLevies: [{ label: 'Droits portuaires et d’embarquement', basis: 'CADRAGE REQUIS (J30)' }], rights: RIGHTS_COMMON,
  },
  {
    slug: 'evenements', name: 'MOSOLO Events', short: 'Événements', icon: 'star', accent: '#8a5cc2', modules: [21, 70, 76],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J1, J3 — base légale et tarif'], entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!,
    tutelle: 'Culture [À VÉRIFIER]', release: 'R3',
    audience: 'Organisateurs de spectacles et d’événements',
    promise: 'Autorisation en ligne, certificat QR affiché sur le lieu, déclaration de billetterie simplifiée.',
    vigilance: 'Assiette déclarative sur billetterie : rapprochement déclaration ↔ contrôle sur place, sans sanction automatique.',
    objectsTitle: 'Mes événements', objectCategories: [],
    procedures: [
      { code: 'DEMANDE_AUTORISATION_EVENEMENT', label: 'Demander une autorisation', hint: 'Pièces en ligne, suivi du dossier, certificat QR', kind: 'AUTORISATION', requiresObject: false, visit: 'SANS', documents: ['Contrat ou accord du lieu', 'Plan de sécurité'],
        fields: [{ key: 'nom', label: 'Nom de l’événement', type: 'text', required: true }, { key: 'lieu', label: 'Lieu', type: 'text', required: true }, { key: 'dateDebut', label: 'Date de début', type: 'date', required: true }, { key: 'dateFin', label: 'Date de fin', type: 'date', required: true }, { key: 'jauge', label: 'Jauge déclarée', type: 'number', required: true }, ...COMMUNE_FIELDS],
        effect: { kind: 'CREATE_OBJECT', category: 'AUTRE', objectType: 'EVENEMENT', certificate: 'AUTORISATION_EVENEMENT' } },
      cessation('Déclarer une annulation', 'Arrêt des obligations liées à l’événement'),
    ],
    pendingLevies: [], rights: RIGHTS_COMMON,
  },
  {
    slug: 'construction', name: 'MOSOLO Construction', short: 'Construction', icon: 'crane', accent: '#E0A526', modules: [19, 22, 82],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['J1 — base légale des carrières', 'G17 — arrêté et barème des droits de voirie', 'J6 — quitus (conditionnalité du permis)'],
    entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!, tutelle: 'Infrastructures et urbanisme ; Mines (carrières) [À VÉRIFIER]', release: 'R3 (quitus : R1)',
    audience: 'Maîtres d’ouvrage, entreprises du bâtiment, exploitants de carrières',
    promise: 'Votre chantier suivi de la demande au quitus : visite de conformité, droits expliqués, attestation vérifiable.',
    vigilance: 'Quitus et droits liés aux chantiers : l’un ne se substitue pas à l’autre ; la conditionnalité du permis n’est appliquée qu’après l’acte (J6).',
    objectsTitle: 'Mes chantiers', objectCategories: [],
    procedures: [
      { code: 'DEMANDE_AUTORISATION_CHANTIER', label: 'Déposer une demande de chantier', hint: 'Plans et pièces en ligne, visite sur place', kind: 'AUTORISATION', requiresObject: false, visit: 'OBLIGATOIRE', documents: ['Plans', 'Titre de la parcelle'],
        fields: [{ key: 'nature', label: 'Nature des travaux', type: 'text', required: true }, { key: 'emprise_voie_m2', label: 'Emprise sur la voie (m²)', type: 'number', required: true }, { key: 'dureeMois', label: 'Durée (mois)', type: 'number', required: true }, ...COMMUNE_FIELDS],
        effect: { kind: 'CREATE_OBJECT', category: 'AUTRE', objectType: 'CHANTIER', certificate: 'PERMIS_OCCUPER_VOIE' } },
      { code: 'DEMANDE_QUITUS_CHANTIER', label: 'Demander le quitus de chantier', hint: 'Après visite de conformité et droits réglés', kind: 'QUITUS', requiresObject: true, visit: 'OBLIGATOIRE', documents: ['Procès-verbal de fin de travaux'], fields: [], effect: { kind: 'CERTIFICATE', certificate: 'QUITUS_CHANTIER' } },
      cessation('Déclarer la fin du chantier', 'Libération de la voie à la date indiquée'),
    ],
    pendingLevies: [{ label: 'Bons de sortie des carrières', basis: 'Base légale des carrières à certifier (J1)' }], rights: RIGHTS_COMMON,
  },
  {
    slug: 'actifs', name: 'MOSOLO Assets', short: 'Actifs', icon: 'bank', accent: '#4453b5', modules: [48, 61, 92],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['Régime du domaine ; loi PPP n° 18/016 (G21, G32)'], entity: 'MINFIN', entityName: ENTITY_NAMES.MINFIN!,
    tutelle: 'Finances', release: 'R3 à R4',
    audience: 'Candidats à la valorisation des actifs provinciaux',
    promise: 'Les actifs provinciaux proposés par mise en concurrence publique et traçable.',
    vigilance: 'Valorisation par mise en concurrence uniquement : aucune attribution de gré à gré.',
    objectsTitle: 'Mes candidatures', objectCategories: [],
    procedures: [
      { code: 'MANIFESTATION_INTERET', label: 'Manifester un intérêt', hint: 'Horodatée ; offre scellée jusqu’à l’ouverture', kind: 'DEMANDE', requiresObject: false, visit: 'SANS', documents: ['Offre (empreinte scellée)'], fields: [{ key: 'appel', label: 'Référence de l’appel', type: 'text', required: true }], effect: { kind: 'NONE' } },
    ],
    pendingLevies: [], rights: ['Offres scellées jusqu’à l’ouverture publique.', 'Résultats et motifs publiés.', 'Recours ouvert à tout candidat.'],
  },
  {
    slug: 'recouvrement', name: 'MOSOLO Recovery', short: 'Recouvrement', icon: 'scale', accent: '#e34948', modules: [32, 33, 36, 83, 90],
    legal: 'BASE_A_CERTIFIER', prerequisites: ['Procédure de recouvrement et régime des échéanciers à certifier'], entity: 'DGIPK', entityName: ENTITY_NAMES.DGIPK!,
    tutelle: 'Finances', release: 'R2',
    audience: 'Contribuables ayant un arriéré',
    promise: 'Régulariser simplement : échéancier, remise prévue par la loi, recours garanti.',
    vigilance: 'Proportionnalité et recours : aucune mesure sans décision humaine motivée.',
    objectsTitle: 'Mes dossiers', objectCategories: [],
    procedures: [
      { code: 'DEMANDE_ECHEANCIER', label: 'Demander un échéancier', hint: 'Réponse motivée', kind: 'DEMANDE', requiresObject: false, visit: 'SANS', documents: ['Justificatif de situation (facultatif)'], fields: [{ key: 'obligation', label: 'Obligation concernée', type: 'text', required: true }, { key: 'mensualites', label: 'Nombre de mensualités proposé', type: 'number', required: true }], effect: { kind: 'NONE' } },
    ],
    pendingLevies: [], rights: RIGHTS_COMMON,
  },
  {
    slug: 'avia', name: 'MOSOLO AVIA', short: 'AVIA', icon: 'plane', accent: '#1E9BD7', modules: [52, 62, 78],
    legal: 'ACTE_REQUIS', prerequisites: ['J23, D21 — arrêtés sur les taxes aériennes provinciales', 'Compétences Ville / RVA / DGM / aviation civile', 'Accords d’accès aux données BSP/GDS'],
    entity: 'DGTK', entityName: ENTITY_NAMES.DGTK!, tutelle: 'Finances ; Transports [À VÉRIFIER]', release: 'R4',
    audience: 'Compagnies aériennes, agences, exploitants d’aérodromes',
    promise: 'Déclarations mensuelles de mouvements, rapprochées avec les données de l’exploitant et validées avant toute facturation.',
    vigilance: 'Validation juridique et coordination multi-acteurs préalables : procédure contradictoire, aucune facturation automatique, aucune interférence avec Go-Pass.',
    objectsTitle: 'Mes aéronefs', objectCategories: [],
    procedures: [
      { code: 'DECLARATION_AERONEF', label: 'Déclarer un aéronef', hint: 'Immatriculation, capacité, base', kind: 'DECLARATION', requiresObject: false, visit: 'SANS', documents: ['Certificat d’immatriculation'],
        fields: [{ key: 'immatriculation', label: 'Immatriculation', type: 'text', required: true }, { key: 'type', label: 'Type d’appareil', type: 'text', required: true }, { key: 'sieges', label: 'Sièges', type: 'number', required: true }, ...COMMUNE_FIELDS],
        effect: { kind: 'CREATE_OBJECT', category: 'AUTRE', objectType: 'AERONEF' } },
    ],
    pendingLevies: [{ label: 'Taxe urbaine sur le billet et taxe d’embarquement du fret', basis: 'ACTE REQUIS (J23, D21)' }], rights: RIGHTS_COMMON,
  },
];

export function findVertical(slug: string): VerticalDef | undefined {
  return VERTICALS.find((v) => v.slug === slug);
}

/** Types d'objets portés par l'attribut `objectType` et leur verticale (objets de catégorie AUTRE, ACTIVITE). */
export const OBJECT_TYPE_VERTICAL: Record<string, string> = {
  ETABLISSEMENT: 'entreprises', ETAL: 'marches', EMPRISE: 'marches', SITE_TELECOM: 'telecom', METTEUR_EN_MARCHE: 'environnement',
  POINT_COLLECTE: 'environnement', EMBARCATION: 'ports', EVENEMENT: 'evenements', CHANTIER: 'construction', AERONEF: 'avia',
};

/** Position indicative (centre approximatif) de chaque commune — à préciser sur le terrain. */
export const COMMUNE_CENTROIDS: Record<string, [number, number]> = {
  Bandalungwa: [-4.343, 15.285], Barumbu: [-4.31, 15.325], Bumbu: [-4.37, 15.285], Gombe: [-4.305, 15.3], Kalamu: [-4.345, 15.315],
  'Kasa-Vubu': [-4.335, 15.3], Kimbanseke: [-4.44, 15.39], Kinshasa: [-4.325, 15.31], Kintambo: [-4.33, 15.265], Kisenso: [-4.41, 15.34],
  Lemba: [-4.395, 15.32], Limete: [-4.36, 15.345], Lingwala: [-4.32, 15.3], Makala: [-4.375, 15.3], Maluku: [-4.07, 15.56],
  Masina: [-4.385, 15.39], Matete: [-4.385, 15.335], 'Mont-Ngafula': [-4.45, 15.27], Ndjili: [-4.395, 15.365], Ngaba: [-4.38, 15.32],
  Ngaliema: [-4.35, 15.24], 'Ngiri-Ngiri': [-4.35, 15.3], Nsele: [-4.38, 15.5], Selembao: [-4.39, 15.28],
};
