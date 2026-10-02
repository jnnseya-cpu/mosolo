/**
 * Opérations de terrain — modèle de données (§ 15, § 15A ; document maître § H.8, § H.10.9, § H.24.4).
 *
 * Doctrine :
 *  - aucun agent, superviseur, sous-traitant ni responsable de module ne manipule d'argent : ce module
 *    ne contient AUCUN montant encaissé, aucune référence de paiement, aucune fonction d'encaissement ;
 *  - un constat terrain est une observation (statut probant OBSERVÉ) : il ne crée jamais d'obligation ;
 *  - toute suspension, tout retrait, toute validation est une décision humaine motivée, tracée dans l'audit ;
 *  - la rémunération des sous-traitants est un calcul INDICATIF sur livrables vérifiés, aux prix unitaires
 *    du contrat (RW6), jamais un pourcentage des recettes ni un montant lié à ce qu'ont payé les contribuables.
 */
import type { MoneyJSON } from '@mosolo/shared';

/** Modules ouverts à la sous-traitance (§ 15A.1 ; H.8.2, sous réserve de J19). */
export const TERRAIN_MODULES = [
  'FONCIER_LOCATIF', 'PATENTES', 'VEHICULES', 'STATIONNEMENT', 'PUBLICITE', 'ANTENNES',
  'MARCHES_DOMAINE_PUBLIC', 'CARRIERES', 'PORTS', 'SPECTACLES', 'ENROLEMENT_ASSISTE', 'RECOUVREMENT_AMIABLE',
] as const;
export type TerrainModule = (typeof TERRAIN_MODULES)[number];

/** États d'un sous-traitant (H.8.4). */
export type SubcontractorStatus = 'INVITE' | 'EN_DILIGENCE' | 'ACCREDITE_PROBATOIRE' | 'ACCREDITE' | 'SUSPENDU' | 'RETIRE';

export interface Diligence {
  legalExistence: boolean;
  taxClearance: boolean;
  noConflictOfInterest: boolean;
  publicAgentLinksDeclared: boolean;
  notes?: string;
  checkedBy: string;
  checkedAt: string;
}

export interface AccreditationProposal {
  modules: TerrainModule[];
  communes: string[];
  validUntil: string;
  probationUntil: string;
  reason: string;
  proposedBy: string;
  proposedAt: string;
}

export interface StatusChange {
  at: string;
  by: string;
  from: SubcontractorStatus;
  to: SubcontractorStatus;
  reason: string;
}

/** Prix unitaires contractuels (après mise en concurrence, hors plateforme) — base du calcul indicatif. */
export interface ContractUnitPrices {
  reference: string;
  /** Prix par constat validé après contrôle qualité. */
  validatedFinding: MoneyJSON;
  /** Prix par mission achevée dans les délais. */
  missionOnTime: MoneyJSON;
  /** Données de démonstration : prix fictifs, sans valeur contractuelle. */
  example: boolean;
}

export interface Subcontractor {
  id: string;
  /** Code d'entité des comptes de la structure (ex. ST-KIN-RECENS). */
  entity: string;
  name: string;
  rccm?: string;
  nif?: string;
  managers: string[];
  references?: string;
  capacityAgents: number;
  requestedModules: TerrainModule[];
  status: SubcontractorStatus;
  /** Statut avant suspension (pour une levée motivée). */
  statusBeforeSuspension?: SubcontractorStatus;
  invitedBy: string;
  invitedAt: string;
  selectionReference: string;
  diligence?: Diligence;
  proposal?: AccreditationProposal;
  accreditation?: AccreditationProposal & { approvedBy: string; approvedAt: string };
  contract?: ContractUnitPrices;
  history: StatusChange[];
  demo?: boolean;
}

export interface Lot {
  id: string;
  /** Absent : lot d'une équipe interne de la régie. */
  subcontractorId?: string;
  module: TerrainModule;
  commune: string;
  quartiers: string[];
  periodStart: string;
  periodEnd: string;
  maxAgents: number;
  /** Lot réduit de période probatoire (H.24.4). */
  probation: boolean;
  status: 'OUVERT' | 'CLOS';
  createdBy: string;
  createdAt: string;
  demo?: boolean;
}

export type AgentStatus = 'INVITE' | 'HABILITE' | 'SUSPENDU' | 'REVOQUE';

export interface Habilitation {
  identityVerified: boolean;
  trainingCertificateRef: string;
  trainingValidUntil: string;
  ethicsSignedAt: string;
  deviceId: string;
  module: TerrainModule;
  communes: string[];
  validUntil: string;
  decidedBy: string;
  decidedAt: string;
}

export interface FieldAgent {
  /** = identifiant du compte nominatif. */
  id: string;
  /** Nom d'usage affiché sur le badge (jamais de téléphone ni d'adresse). */
  displayName: string;
  subcontractorId?: string;
  entity: string;
  status: AgentStatus;
  invitedBy: string;
  invitedAt: string;
  /** Quartiers déclarés (résidence, proches) : interdiction d'affectation (§ 15A.5). */
  declaredQuartiers: string[];
  /** Objets déclarés liés à ses proches. */
  declaredObjectIds: string[];
  habilitation?: Habilitation;
  /** Photo du badge : référence d'un document (jamais le binaire), ou absente. */
  photoRef?: string;
  history: { at: string; by: string; to: AgentStatus; reason: string }[];
  demo?: boolean;
}

export type BadgeStatus = 'ACTIF' | 'SUSPENDU' | 'REVOQUE';

export interface AgentBadge {
  id: string;
  agentId: string;
  shortCode: string;
  qrToken: string;
  module: TerrainModule;
  communes: string[];
  validFrom: string;
  validUntil: string;
  status: BadgeStatus;
  issuedAt: string;
  issuedBy: string;
  revokedAt?: string;
  revocationReason?: string;
}

export type MissionStatus = 'A_AFFECTER' | 'AFFECTEE' | 'EN_COURS' | 'TERMINEE' | 'ANNULEE';

export interface Mission {
  id: string;
  lotId?: string;
  subcontractorId?: string;
  module: TerrainModule;
  kind: 'RECENSEMENT' | 'CONTROLE' | 'ENROLEMENT_ASSISTE' | 'CONTRE_VISITE';
  title: string;
  commune: string;
  quartier?: string;
  center: { lat: number; lon: number };
  radiusM: number;
  objectIds: string[];
  objectives: { findings: number; objects?: number };
  instructions: string;
  periodStart: string;
  dueDate: string;
  assignedAgentId?: string;
  status: MissionStatus;
  createdBy: string;
  createdAt: string;
  assignedBy?: string;
  assignedAt?: string;
  completedAt?: string;
  demo?: boolean;
}

export type FindingOutcome = 'CONSTATE' | 'ABSENT' | 'REFUS' | 'OBJET_NON_ENREGISTRE';
export type FindingStatus = 'SOUMIS' | 'A_CONTRE_VISITER' | 'VALIDE' | 'REJETE';

/** Constat terrain scellé : son contenu est figé (empreinte), seul son statut de revue évolue. */
export interface Finding {
  id: string;
  clientRef: string;
  missionId: string;
  objectId?: string;
  agentId: string;
  subcontractorId?: string;
  deviceId?: string;
  commune: string;
  outcome: FindingOutcome;
  observations: string;
  gps: { lat: number; lon: number; accuracyM: number; source?: 'GPS' | 'MANUEL' | 'ZONE' };
  photoSha256?: string;
  capturedAt: string;
  receivedAt: string;
  /** Catégorie déclarée d'un objet non enregistré (Document maître FR 2, ch. 43). */
  category?: 'PARCELLE' | 'BATIMENT' | 'UNITE_LOCATIVE' | 'ACTIVITE' | 'VEHICULE' | 'PANNEAU' | 'AUTRE';
  reference: { kind: 'OBJET' | 'ZONE_MISSION'; lat: number; lon: number };
  distanceM: number;
  toleranceM: number;
  flags: ('DISTANCE' | 'GPS_IMPRECIS' | 'SANS_PHOTO' | 'HORS_ZONE')[];
  flagMessage?: string;
  justification?: string;
  /** SHA-256 du contenu canonique du constat (scellement). */
  seal: string;
  probativeStatus: 'OBSERVE';
  status: FindingStatus;
  review?: { by: string; at: string; decision: 'VALIDE' | 'REJETE'; reason: string };
  demo?: boolean;
}

export interface QualitySample {
  id: string;
  scope: { subcontractorId?: string; agentId?: string; missionId?: string };
  ratePercent: number;
  population: number;
  randomSelected: string[];
  riskSelected: string[];
  createdBy: string;
  createdAt: string;
}

export interface CounterVisit {
  id: string;
  sampleId: string;
  findingId: string;
  originalAgentId: string;
  assignedTo?: string;
  status: 'A_AFFECTER' | 'A_FAIRE' | 'REALISEE';
  result?: 'CONFORME' | 'NON_CONFORME';
  notes?: string;
  gps?: { lat: number; lon: number; accuracyM: number; source?: 'GPS' | 'MANUEL' | 'ZONE' };
  photoSha256?: string;
  performedAt?: string;
  distanceToOriginalM?: number;
}

export interface MysteryCheck {
  id: string;
  target: { kind: 'AGENT' | 'SOUS_TRAITANT'; id: string };
  plannedFor: string;
  status: 'PLANIFIE' | 'REALISE';
  result?: 'SANS_IRREGULARITE' | 'IRREGULARITE';
  notes?: string;
  plannedBy: string;
  performedBy?: string;
  performedAt?: string;
}

export interface BadgeVerification {
  id: string;
  at: string;
  shortCode: string;
  result: PublicBadgeResult;
  channel: 'WEB' | 'SMS' | 'SVI' | 'SCAN';
}

export type PublicBadgeResult = 'VALIDE' | 'SUSPENDU' | 'REVOQUE' | 'EXPIRE' | 'INCONNU';

/** Tolérance GPS par commune (mètres) — PARAMÈTRE de démonstration, à fixer par la régie. */
export const DEFAULT_GPS_TOLERANCE_M = 50;

/** Taux minimal d'échantillonnage pour la contre-visite (H.8.5 : ≥ 5 %). */
export const MIN_SAMPLE_RATE = 5;

/** Nombre maximal d'agents sur un lot probatoire (paramètre de démonstration). */
export const PROBATION_MAX_AGENTS = 5;
