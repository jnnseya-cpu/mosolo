/**
 * Modèle du module « opportunités » (Cahier v2.9, chapitre 8) : registre des gisements (§ 8.1, § 8.2), grille
 * d'évaluation (§ 8.3), pipeline de découverte en huit étapes (§ 8.4), moteur de recoupement (§ 8.5), douze leviers
 * (§ 8.6) et moteur de maximisation (§ 8.7).
 * Garde-fou (§ 8.4) : aucune opportunité ne devient une taxe par simple décision algorithmique. Aucun potentiel,
 * taux ni coût n'est inventé : valeur absente ⇒ `null` et « à estimer par le recensement pilote ».
 */
import type { MoneyJSON, RoleCode } from '@mosolo/shared';

export const SOURCE_CAHIER = 'Cahier des charges v2.9, chapitre 8';
export const POTENTIAL_TODO = 'à estimer par le recensement pilote';

// ─────────────────────────── § 8.4 : champ d'analyse du moteur de découverte ───────────────────────────

export interface DiscoveryDomain {
  code: string;
  label: string;
  /** Verticales du catalogue (plugins/verticales/catalogue.ts) qui couvrent ce domaine. */
  verticals: string[];
  /** Modules terrain (plugins/terrain/model.ts) mobilisables pour la vérification. */
  terrainModules: string[];
}

/** Les vingt domaines du champ d'analyse (§ 8.4), dans l'ordre du cahier. */
export const DISCOVERY_DOMAINS: DiscoveryDomain[] = [
  { code: 'FONCIER', label: 'Foncier', verticals: ['propriete'], terrainModules: ['FONCIER_LOCATIF'] },
  { code: 'IMMOBILIER_LOCATIF', label: 'Immobilier locatif', verticals: ['locatif'], terrainModules: ['FONCIER_LOCATIF'] },
  { code: 'ACTIVITES_ECONOMIQUES', label: 'Activités économiques', verticals: ['entreprises'], terrainModules: ['PATENTES'] },
  { code: 'VEHICULES_MOBILITE', label: 'Véhicules et mobilité', verticals: ['mobilite', 'rakapay'], terrainModules: ['VEHICULES'] },
  { code: 'STATIONNEMENT', label: 'Stationnement', verticals: ['stationnement'], terrainModules: ['STATIONNEMENT'] },
  { code: 'PUBLICITE', label: 'Publicité', verticals: ['publicite'], terrainModules: ['PUBLICITE'] },
  { code: 'TELECOMS_ANTENNES', label: 'Télécoms et antennes', verticals: ['telecom'], terrainModules: ['ANTENNES'] },
  { code: 'MARCHES', label: 'Marchés', verticals: ['marches'], terrainModules: ['MARCHES_DOMAINE_PUBLIC'] },
  { code: 'DOMAINE_PUBLIC', label: 'Domaine public', verticals: ['marches'], terrainModules: ['MARCHES_DOMAINE_PUBLIC'] },
  { code: 'LICENCES', label: 'Licences', verticals: ['entreprises'], terrainModules: ['PATENTES'] },
  { code: 'DECHETS_ENVIRONNEMENT', label: 'Déchets et environnement', verticals: ['environnement'], terrainModules: [] },
  { code: 'PORTS', label: 'Ports', verticals: ['ports'], terrainModules: ['PORTS'] },
  { code: 'TOURISME', label: 'Tourisme', verticals: [], terrainModules: [] },
  { code: 'EVENEMENTS', label: 'Événements', verticals: ['evenements'], terrainModules: ['SPECTACLES'] },
  { code: 'CONSTRUCTION', label: 'Construction', verticals: ['construction'], terrainModules: [] },
  { code: 'CARRIERES', label: 'Carrières', verticals: [], terrainModules: ['CARRIERES'] },
  { code: 'CONCESSIONS', label: 'Concessions', verticals: ['actifs'], terrainModules: [] },
  { code: 'ACTIFS_PUBLICS', label: 'Actifs publics', verticals: ['actifs'], terrainModules: [] },
  { code: 'SERVICES_PREMIUM', label: 'Services premium', verticals: [], terrainModules: [] },
  { code: 'ARRIERES', label: 'Arriérés', verticals: ['recouvrement'], terrainModules: ['RECOUVREMENT_AMIABLE'] },
];

// ─────────────────────────── § 8.4 : pipeline en huit étapes ───────────────────────────

export interface PipelineStep {
  n: number;
  code: 'SIGNAL' | 'QUALIFICATION_JURIDIQUE' | 'ESTIMATION' | 'IMPACT_SOCIO_ECONOMIQUE' | 'RISQUE_CORRUPTION' | 'COUT' | 'PILOTE' | 'DECISION';
  label: string;
  content: string;
  responsible: string;
  /** Rôles habilités à compléter l'étape (matrice `opportunites:step.<n>`). Jamais un agent d'IA. */
  roles: RoleCode[];
}

export const PIPELINE: PipelineStep[] = [
  { n: 1, code: 'SIGNAL', label: 'Signal', content: 'Anomalie, objet non enregistré, écart de rapprochement, donnée partenaire', responsible: 'Agent IA, terrain, données partenaires — enregistré par une personne habilitée', roles: ['R06', 'R07', 'R09', 'R11'] },
  { n: 2, code: 'QUALIFICATION_JURIDIQUE', label: 'Qualification juridique', content: 'Base légale existante ou acte nouveau requis', responsible: 'Juriste provincial', roles: ['R13', 'R14'] },
  { n: 3, code: 'ESTIMATION', label: 'Estimation', content: 'Scénarios conservateur, attendu, ambitieux, hypothèses datées', responsible: 'Analyste du programme', roles: ['R06', 'R07', 'R15'] },
  { n: 4, code: 'IMPACT_SOCIO_ECONOMIQUE', label: 'Impact socio-économique', content: 'Effets sur ménages, entreprises, prix, informel', responsible: 'Programme et régie', roles: ['R06', 'R07'] },
  { n: 5, code: 'RISQUE_CORRUPTION', label: 'Risque de corruption', content: 'Points de contact, discrétion, espèces, collusion', responsible: 'Contrôle interne', roles: ['R22', 'R24'] },
  { n: 6, code: 'COUT', label: 'Coût d’implémentation', content: 'Données, terrain, développement, exploitation', responsible: 'Programme', roles: ['R06', 'R07'] },
  { n: 7, code: 'PILOTE', label: 'Pilote', content: 'Périmètre, durée, indicateurs, groupe de comparaison', responsible: 'Comité de pilotage', roles: ['R02', 'R05', 'R06'] },
  { n: 8, code: 'DECISION', label: 'Décision', content: 'Activation, report ou abandon, motivé', responsible: 'Autorité compétente', roles: ['R01', 'R04', 'R05'] },
];

// ─────────────────────────── § 8.3 : grille d'évaluation ───────────────────────────

export const GRID_FIELDS = [
  'faisabiliteJuridique', 'objectif', 'autorite', 'faitGenerateur', 'population', 'methodeCalcul', 'coutMiseEnOeuvre',
  'impactSocial', 'impactEconomique', 'risqueCorruption', 'exigencesControle', 'texteRequis', 'priorite', 'recommandationPilote',
] as const;
export type GridField = (typeof GRID_FIELDS)[number];

export const GRID_LABELS: Record<GridField | 'potentiel', string> = {
  faisabiliteJuridique: 'Faisabilité juridique', objectif: 'Objectif de politique publique', autorite: 'Autorité responsable',
  faitGenerateur: 'Fait générateur', population: 'Population concernée', methodeCalcul: 'Méthode de calcul',
  coutMiseEnOeuvre: 'Coût de mise en œuvre', impactSocial: 'Impact social', impactEconomique: 'Impact économique',
  potentiel: 'Potentiel de recettes (prudent, attendu, ambitieux)', risqueCorruption: 'Risque de corruption',
  exigencesControle: 'Exigences de contrôle', texteRequis: 'Texte requis', priorite: 'Priorité', recommandationPilote: 'Recommandation de pilote',
};

/** Rôles habilités à renseigner chaque rubrique (qui instruit quoi, § 8.4). */
export const GRID_FIELD_ROLES: Record<GridField, RoleCode[]> = {
  faisabiliteJuridique: ['R13', 'R14'], texteRequis: ['R13', 'R14'],
  objectif: ['R06', 'R07', 'R15'], autorite: ['R06', 'R07', 'R13', 'R14'], faitGenerateur: ['R13', 'R14'],
  population: ['R06', 'R07', 'R15'], methodeCalcul: ['R06', 'R07', 'R15'], coutMiseEnOeuvre: ['R06', 'R07'],
  impactSocial: ['R06', 'R07'], impactEconomique: ['R06', 'R07', 'R15'],
  risqueCorruption: ['R22', 'R24'], exigencesControle: ['R22', 'R24'],
  priorite: ['R02', 'R05', 'R06'], recommandationPilote: ['R02', 'R05', 'R06'],
};

export interface GridValue {
  value: string | null;
  source: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PotentialScenarios {
  prudent: MoneyJSON | null;
  attendu: MoneyJSON | null;
  ambitieux: MoneyJSON | null;
  /** Hypothèses (identifiants) sur lesquelles reposent les montants — obligatoires dès qu'un montant est donné. */
  hypothesisIds: string[];
  note: string;
  updatedAt: string;
  updatedBy: string;
}

export interface Hypothesis {
  id: string;
  text: string;
  source: string;
  /** Date de l'hypothèse (AAAA-MM-JJ). */
  date: string;
  author: string;
  status: 'ACTIVE' | 'REVISEE';
  /** Hypothèse remplacée (révision : jamais d'écrasement). */
  revises?: string;
  revisedBy?: string;
  createdAt: string;
}

export interface StepRecord {
  n: number;
  code: PipelineStep['code'];
  completedBy: string;
  role: RoleCode;
  completedAt: string;
  summary: string;
  data?: Record<string, unknown>;
}

export type DecisionOutcome = 'ACTIVATION' | 'REPORT' | 'ABANDON';
export interface LegalBasis { kind: 'REGLE' | 'ACTE'; ref: string; label: string; status: string; checkedAt: string }
export interface OpportunityDecision {
  outcome: DecisionOutcome;
  motivation: string;
  decidedBy: string;
  role: RoleCode;
  at: string;
  legalBasis: LegalBasis | null;
  /** Effet : l'activation n'ouvre ni règle ni obligation — elle constate une base légale existante. */
  effect: 'AUCUNE_OBLIGATION_CREEE';
}

export const REVENUE_KINDS = ['RECETTE_NOUVELLE', 'REGULARISATION_ARRIERES', 'AMELIORATION_RAPPROCHEMENT', 'RECLASSEMENT'] as const;
export type RevenueKind = (typeof REVENUE_KINDS)[number];
export const REVENUE_KIND_LABELS: Record<RevenueKind, string> = {
  RECETTE_NOUVELLE: 'Recettes nouvelles', REGULARISATION_ARRIERES: 'Régularisation d’arriérés',
  AMELIORATION_RAPPROCHEMENT: 'Amélioration du rapprochement', RECLASSEMENT: 'Simple reclassement',
};

/** Entrée du moteur de maximisation : explicite, datée, sourcée, modifiable par l'analyste — jamais inventée. */
export interface MaxInput<T> { value: T | null; date: string | null; source: string | null; updatedBy: string | null; updatedAt: string | null }
export const MAX_INPUT_KEYS = ['legalPotential', 'complianceProbability', 'collectionSpeed', 'censusCost', 'controlCost', 'contestRisk', 'socialRisk'] as const;
export type MaxInputKey = (typeof MAX_INPUT_KEYS)[number];
export const MAX_INPUT_LABELS: Record<MaxInputKey, string> = {
  legalPotential: 'Potentiel légal', complianceProbability: 'Probabilité de conformité (0 à 1)', collectionSpeed: 'Vitesse d’encaissement (0 à 1)',
  censusCost: 'Coût de recensement', controlCost: 'Coût de contrôle', contestRisk: 'Risque de contestation (montant)', socialRisk: 'Risque social (montant)',
};
export interface MaxInputs {
  revenueKind: RevenueKind;
  legalPotential: MaxInput<MoneyJSON>;
  complianceProbability: MaxInput<string>;
  collectionSpeed: MaxInput<string>;
  censusCost: MaxInput<MoneyJSON>;
  controlCost: MaxInput<MoneyJSON>;
  contestRisk: MaxInput<MoneyJSON>;
  socialRisk: MaxInput<MoneyJSON>;
}

export type OpportunitySection = '8.1' | '8.2' | 'SIGNAL';
export type SignalOrigin = 'CAHIER' | 'IA_DECOUVERTE' | 'TERRAIN' | 'DONNEES_PARTENAIRES' | 'ANOMALIE';

export interface Opportunity {
  id: string;
  code: string;
  title: string;
  section: OpportunitySection;
  /** « Sans texte nouveau » (§ 8.1) ou « acte provincial » (§ 8.2), ou signal à qualifier. */
  track: 'SANS_TEXTE_NOUVEAU' | 'ACTE_PROVINCIAL' | 'A_QUALIFIER';
  nature: string | null;
  condition: string | null;
  objective: string | null;
  legalPath: string | null;
  risksToControl: string | null;
  cahierPriority: number | null;
  origin: SignalOrigin;
  originRef: string | null;
  discoveryDomains: string[];
  verticals: string[];
  grid: Record<GridField, GridValue>;
  gridHistory: { field: string; before: string | null; after: string | null; by: string; at: string; reason: string }[];
  potential: PotentialScenarios;
  hypotheses: Hypothesis[];
  steps: StepRecord[];
  status: 'EN_INSTRUCTION' | 'DECIDEE';
  decision: OpportunityDecision | null;
  max: MaxInputs;
  source: string;
  createdAt: string;
  createdBy: string;
  demo?: boolean;
}

// ─────────────────────────── Gisements du cahier (§ 8.1, § 8.2) ───────────────────────────

export interface LeadSeed {
  code: string;
  title: string;
  section: '8.1' | '8.2';
  nature?: string;
  condition?: string;
  priority?: number;
  objective?: string;
  legalPath?: string;
  risks?: string;
  domains: string[];
  verticals: string[];
  revenueKind: RevenueKind;
}

/** § 8.1 : gisements sans texte nouveau, activables immédiatement (7 pistes). */
export const LEADS_8_1: LeadSeed[] = [
  { code: 'G81-01', title: 'Recensement locatif systématique', section: '8.1', nature: 'Élargissement d’assiette IRL à droit constant', condition: 'Protocoles de données, recensement terrain', priority: 1, domains: ['IMMOBILIER_LOCATIF'], verticals: ['locatif'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G81-02', title: 'Généralisation du quitus fiscal numérique', section: '8.1', nature: 'Conditionnalité d’accès aux services publics provinciaux', condition: 'Extension par arrêté aux permis de bâtir, mutations et mutations de véhicules', priority: 1, domains: ['FONCIER', 'CONSTRUCTION', 'VEHICULES_MOBILITE'], verticals: ['propriete', 'construction', 'mobilite'], revenueKind: 'REGULARISATION_ARRIERES' },
  { code: 'G81-03', title: 'Cellule grands redevables (brasseries, tabac, antennes, carrières)', section: '8.1', nature: 'Fiabilisation de recettes existantes', condition: 'Conventions de déclaration et de rapprochement', priority: 1, domains: ['ACTIVITES_ECONOMIQUES', 'TELECOMS_ANTENNES', 'CARRIERES'], verticals: ['entreprises', 'telecom'], revenueKind: 'AMELIORATION_RAPPROCHEMENT' },
  { code: 'G81-04', title: 'Recouvrement des arriérés et régularisation volontaire', section: '8.1', nature: 'Recettes historiques', condition: 'Campagne encadrée, échéanciers, abandon de pénalités si la loi le permet', priority: 2, domains: ['ARRIERES'], verticals: ['recouvrement'], revenueKind: 'REGULARISATION_ARRIERES' },
  { code: 'G81-05', title: 'Panneaux publicitaires non déclarés', section: '8.1', nature: 'Assiette existante non captée', condition: 'Inventaire géoréférencé et plaques QR', priority: 2, domains: ['PUBLICITE'], verticals: ['publicite'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G81-06', title: 'Occupation du domaine public et parkings', section: '8.1', nature: 'Redevances existantes mal suivies', condition: 'Plan des emprises, redevance mobile', priority: 2, domains: ['DOMAINE_PUBLIC', 'STATIONNEMENT'], verticals: ['marches', 'stationnement'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G81-07', title: 'Réduction des exonérations et annulations irrégulières', section: '8.1', nature: 'Récupération de base', condition: 'Registre des exonérations avec preuve et double validation', priority: 2, domains: [], verticals: [], revenueKind: 'RECLASSEMENT' },
];

/** § 8.2 : gisements exigeant un acte provincial (8 pistes). */
export const LEADS_8_2: LeadSeed[] = [
  { code: 'G82-01', title: 'Contribution environnementale sur les plastiques', section: '8.2', objective: 'Réduction des déchets plastiques et financement de l’assainissement', legalPath: 'Édit provincial, après étude d’impact et consultation ; vérifier l’articulation avec la fiscalité centrale', risks: 'Double imposition, report de charge sur le consommateur, contrebande interprovinciale', domains: ['DECHETS_ENVIRONNEMENT'], verticals: ['environnement'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G82-02', title: 'Redevance d’accès logistique urbain pour poids lourds', section: '8.2', objective: 'Protection de la voirie et régulation des flux', legalPath: 'Édit, avec horaires et corridors définis', risks: 'Effet inflationniste sur les biens, contournement', domains: ['VEHICULES_MOBILITE'], verticals: ['mobilite'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G82-03', title: 'Droits de voirie liés aux chantiers et aux permis de bâtir', section: '8.2', objective: 'Financement de la réfection après travaux', legalPath: 'Arrêté et barème', risks: 'Blocage de l’investissement si mal calibré', domains: ['CONSTRUCTION'], verticals: ['construction'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G82-04', title: 'Captation de plus-value foncière liée aux infrastructures', section: '8.2', objective: 'Financement des équipements par la valorisation induite', legalPath: 'Édit et méthode d’évaluation certifiée', risks: 'Contentieux d’évaluation, acceptabilité', domains: ['FONCIER'], verticals: ['propriete'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G82-05', title: 'Droits de dénomination et d’usage commercial d’actifs publics', section: '8.2', objective: 'Valorisation d’actifs existants', legalPath: 'Délibération et mise en concurrence', risks: 'Opacité si attribution de gré à gré', domains: ['ACTIFS_PUBLICS'], verticals: ['actifs'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G82-06', title: 'Location et mise en valeur du patrimoine provincial sous-utilisé', section: '8.2', objective: 'Revenu domanial récurrent', legalPath: 'Inventaire, évaluation, appel public', risks: 'Bradage, conflits d’intérêts', domains: ['ACTIFS_PUBLICS', 'CONCESSIONS'], verticals: ['actifs'], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G82-07', title: 'Services administratifs numériques premium (délais garantis)', section: '8.2', objective: 'Qualité de service financée', legalPath: 'Arrêté tarifaire', risks: 'Création d’un service à deux vitesses', domains: ['SERVICES_PREMIUM'], verticals: [], revenueKind: 'RECETTE_NOUVELLE' },
  { code: 'G82-08', title: 'Produits de données urbaines anonymisées', section: '8.2', objective: 'Valorisation statistique non personnelle', legalPath: 'Cadre de gouvernance des données et avis de conformité', risks: 'Ré-identification, atteinte à la vie privée', domains: [], verticals: [], revenueKind: 'RECETTE_NOUVELLE' },
];

// ─────────────────────────── § 8.5 : moteur de recoupement ───────────────────────────

export const SOURCE_KINDS = ['LIVRAISONS_BRASSERIE', 'CODES_MARCHANDS_MOMO', 'LECTURES_PLAQUES', 'SOUMISSIONS_AUTORISATIONS', 'DECLARATIONS_IMMEUBLES'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface CrossRule { kind: SourceKind; ruleCode: string; signal: string; rule: string; result: string; terrainModule: string | null }
/** Règles du § 8.5, exactement comme le tableau du cahier. */
export const CROSS_RULES: Record<SourceKind, CrossRule> = {
  LIVRAISONS_BRASSERIE: { kind: 'LIVRAISONS_BRASSERIE', ruleCode: 'BAR_SANS_LICENCE', signal: 'Dépôt brassicole livrant un point de vente', rule: 'Aucune autorisation de débit de boissons à moins de 50 m', result: 'Objet provisoire « bar » et visite de vérification', terrainModule: 'PATENTES' },
  CODES_MARCHANDS_MOMO: { kind: 'CODES_MARCHANDS_MOMO', ruleCode: 'COMMERCE_NON_ENREGISTRE', signal: 'Code marchand Mobile Money actif à Kinshasa', rule: 'Aucun objet patente à cet emplacement', result: 'Commerce probablement non enregistré', terrainModule: 'PATENTES' },
  LECTURES_PLAQUES: { kind: 'LECTURES_PLAQUES', ruleCode: 'VEHICULE_IMPAYE', signal: 'Plaque contrôlée à un point de contrôle', rule: 'Vignette ou taxe de circulation impayée', result: 'Statut instantané pour le contrôleur', terrainModule: null },
  SOUMISSIONS_AUTORISATIONS: { kind: 'SOUMISSIONS_AUTORISATIONS', ruleCode: 'SANS_QUITUS_VALIDE', signal: 'Entreprise soumissionnant à un marché provincial ou demandant une autorisation', rule: 'Aucun quitus fiscal valide', result: 'Service bloqué jusqu’à régularisation', terrainModule: null },
  DECLARATIONS_IMMEUBLES: { kind: 'DECLARATIONS_IMMEUBLES', ruleCode: 'INCOHERENCE_LOCATIVE', signal: 'Immeuble multi-unités déclaré vacant, baux expirés, loyers atypiques, doublons', rule: 'Incohérence de déclaration locative', result: 'Examen humain puis mission autorisée', terrainModule: 'FONCIER_LOCATIF' },
};

/** Distance fixée par le cahier (§ 8.5) pour la règle « débit de boissons ». */
export const BAR_LICENCE_RADIUS_M = 50;
export const CODE_NUMERIQUE = 'Code du numérique — Ordonnance-loi n° 23/010 du 13 mars 2023';

export interface PartnerSource {
  id: string;
  kind: SourceKind;
  partnerName: string;
  description: string;
  protocol: { reference: string; signedOn: string; signatories: string; documentSha256: string; recordedBy: string; recordedAt: string } | null;
  compliance: {
    framework: string; personalData: boolean; lawfulBasis: string; minimisation: string; retention: string; security: string;
    conclusion: 'CONFORME' | 'NON_CONFORME'; note: string; checkedBy: string; checkedAt: string;
  } | null;
  status: 'PROTOCOLE_A_SIGNER' | 'CONFORMITE_A_VERIFIER' | 'ACTIVE' | 'NON_CONFORME' | 'SUSPENDUE';
  createdAt: string;
  createdBy: string;
  demo?: boolean;
}

export interface IngestBatch {
  id: string;
  sourceId: string;
  kind: SourceKind;
  records: number;
  worklistItems: number;
  ingestedBy: string;
  at: string;
  sha256: string;
  demo?: boolean;
}

export type WorklistStatus = 'A_EXAMINER' | 'VERIFICATION_REQUISE' | 'MISSION_OUVERTE' | 'CLOS_SANS_SUITE' | 'STATUT_INSTANTANE' | 'SERVICE_BLOQUE' | 'REGULARISE';
export interface WorklistItem {
  id: string;
  ruleCode: string;
  kind: SourceKind;
  sourceId: string;
  batchId: string;
  commune: string | null;
  quartier: string | null;
  lat: number | null;
  lon: number | null;
  subject: { kind: string; ref: string };
  explanation: string;
  variables: { name: string; value: string }[];
  priority: number;
  priorityFactors: { label: string; points: number }[];
  status: WorklistStatus;
  /** Le recoupement ne produit JAMAIS d'avis d'imposition automatique (§ 8.5). */
  automaticAssessment: 'AUCUN';
  proposedObject?: { category: 'ACTIVITE'; objectType: string; label: string } | null;
  createdObjectId?: string;
  missionId?: string;
  blockId?: string;
  review?: { decision: 'VERIFICATION_REQUISE' | 'SANS_SUITE'; reason: string; by: string; at: string };
  createdAt: string;
  demo?: boolean;
}

export interface ServiceBlock {
  id: string;
  taxpayerId: string;
  service: 'MARCHE_PUBLIC' | 'AUTORISATION';
  reference: string;
  status: 'BLOQUE' | 'LEVE';
  /** Opposable seulement si l'acte instituant la conditionnalité du quitus est en vigueur (ARB-17) ; sinon informatif. */
  opposable: boolean;
  basisNote: string;
  createdAt: string;
  liftedAt?: string;
  liftedBy?: string;
  clearanceNumber?: string;
  demo?: boolean;
}

// ─────────────────────────── § 8.6 : les douze leviers ───────────────────────────

export const LEVERS: { n: number; code: string; label: string; action: string; gainMeasure: string }[] = [
  { n: 1, code: 'COUVERTURE', label: 'Couverture', action: 'Recenser objets et activités invisibles', gainMeasure: 'Nouveaux objets vérifiés' },
  { n: 2, code: 'RATTACHEMENT', label: 'Rattachement', action: 'Associer les objets à la bonne personne', gainMeasure: 'Taux d’identification' },
  { n: 3, code: 'QUALITE', label: 'Qualité', action: 'Corriger adresses, catégories, dimensions', gainMeasure: 'Baisse des rejets et recours fondés' },
  { n: 4, code: 'REGLES', label: 'Règles', action: 'Appliquer exactement la règle en vigueur', gainMeasure: 'Écart de liquidation' },
  { n: 5, code: 'DECLARATION', label: 'Déclaration', action: 'Formulaires préremplis et rappels', gainMeasure: 'Taux de dépôt à temps' },
  { n: 6, code: 'PAIEMENT', label: 'Paiement', action: 'Canaux simples et références uniques', gainMeasure: 'Conversion ordre → paiement' },
  { n: 7, code: 'RAPPROCHEMENT', label: 'Rapprochement', action: 'Automatiser le dénouement', gainMeasure: 'Sommes en exception' },
  { n: 8, code: 'RECOUVREMENT', label: 'Recouvrement', action: 'Prioriser le rendement net', gainMeasure: 'Montant récupéré par coût' },
  { n: 9, code: 'FRAUDE', label: 'Fraude', action: 'Détecter exonérations, annulations, collusions', gainMeasure: 'Déperdition évitée' },
  { n: 10, code: 'SERVICE', label: 'Service', action: 'Réduire erreurs et déplacements', gainMeasure: 'Satisfaction et délais' },
  { n: 11, code: 'DONNEES', label: 'Données', action: 'Partager légalement les signaux utiles', gainMeasure: 'Nouvelles correspondances' },
  { n: 12, code: 'PILOTAGE', label: 'Pilotage', action: 'Responsabiliser par zone et catégorie', gainMeasure: 'Écart cible / réalisé' },
];

/** Paramètres techniques du recoupement (tri et appariement) — jamais un taux ni un tarif. */
export interface CrossParams {
  /** Tolérance d'appariement d'un code marchand avec un objet patente (m). */
  merchantMatchRadiusM: number;
  /** Horizon des échéances à surveiller (jours). */
  expiryHorizonDays: number;
  /** Semaines de la prévision de trésorerie. */
  forecastWeeks: number;
  /**
   * Acte instituant la conditionnalité du quitus (J6) : tant qu'aucun instrument EN VIGUEUR n'est désigné, le blocage
   * de service reste INFORMATIF (ARB-17, plugins/fiscal/clearances.ts) — harmonisation avec le quitus existant.
   */
  quitusActInstrumentId: string | null;
  status: string;
  updatedBy: string | null;
  updatedAt: string | null;
}
export const DEFAULT_CROSS_PARAMS: CrossParams = {
  merchantMatchRadiusM: 25, expiryHorizonDays: 30, forecastWeeks: 8, quitusActInstrumentId: null,
  status: 'par défaut — à confirmer par le maître d’ouvrage', updatedBy: null, updatedAt: null,
};
