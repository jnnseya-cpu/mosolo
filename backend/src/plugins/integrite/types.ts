/**
 * Module « Intégrité » : ligne de signalement protégée et contrôles mystère (§ 18A.8, module 69),
 * renseignement anti-fraude — signaux, alertes, dossiers d'enquête (§ 25, module 40),
 * incidents de sécurité (module 45/55), protection des données (§ 22, § 32, R25) et revue des accès (module 51).
 *
 * Doctrine : le système CONSTATE et PROPOSE ; une personne habilitée DÉCIDE, avec motif, et tout est journalisé.
 * Aucune sanction, suspension ni blocage n'est produit par un algorithme (ARB-12, § 25.1 « Contenir »).
 */
import type { RoleCode } from '@mosolo/shared';

/* ------------------------------------------------------------------ */
/* Signalements                                                        */
/* ------------------------------------------------------------------ */

export const REPORT_CHANNELS = ['WEB', 'SMS', 'SVI', 'NUMERO_GRATUIT', 'GUICHET'] as const;
export type ReportChannel = (typeof REPORT_CHANNELS)[number];

export const REPORT_CATEGORIES = [
  'DEMANDE_ESPECES', 'FAUX_AGENT', 'FAUSSE_QUITTANCE', 'POINT_PAIEMENT_IRREGULIER', 'PRELEVEMENT_WEWA',
  'SOUS_TRAITANT_ENCAISSE', 'COMPORTEMENT_AGENT', 'AUTRE',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  DEMANDE_ESPECES: "Demande d'espèces par un agent",
  FAUX_AGENT: 'Faux agent ou agent non vérifiable',
  FAUSSE_QUITTANCE: 'Fausse quittance',
  POINT_PAIEMENT_IRREGULIER: 'Point de paiement irrégulier',
  PRELEVEMENT_WEWA: 'Prélèvement irrégulier sur un wewa (moto-taxi)',
  SOUS_TRAITANT_ENCAISSE: 'Sous-traitant qui encaisse',
  COMPORTEMENT_AGENT: "Comportement abusif d'un agent",
  AUTRE: 'Autre irrégularité',
};

export const TARGET_KINDS = ['AGENT', 'POINT_PAIEMENT', 'QUITTANCE', 'SOUS_TRAITANT', 'GUICHET', 'AUTRE'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** REÇU → QUALIFIÉ → TRANSMIS → CLOS (annexe H, entité Report). */
export type ReportStatus = 'RECU' | 'QUALIFIE' | 'TRANSMIS' | 'CLOS';
export type Severity = 'FAIBLE' | 'MOYENNE' | 'ELEVEE' | 'CRITIQUE';
export const SEVERITIES = ['FAIBLE', 'MOYENNE', 'ELEVEE', 'CRITIQUE'] as const;
export type ReportOutcome = 'FONDE' | 'NON_FONDE' | 'INSUFFISANT' | 'IRRECEVABLE';

export interface EvidenceRef {
  id: string;
  /** Empreinte SHA-256 de la pièce (le fichier lui-même reste chez son détenteur ou au coffre documentaire). */
  sha256: string;
  label: string;
  addedAt: string;
  /** « signalant », identifiant d'agent, « système »… */
  addedBy: string;
}

/** Identité du signalant, chiffrée (AES-256-GCM). Jamais renvoyée par aucune route. */
export interface SealedIdentity {
  iv: string;
  tag: string;
  ct: string;
}

export interface ReporterMessage {
  at: string;
  from: 'SIGNALANT' | 'LIGNE';
  text: string;
}

export interface Report {
  id: string;
  reference: string;
  /** HMAC du code de suivi : le code lui-même n'est jamais stocké. */
  trackingHash: string;
  channel: ReportChannel;
  category: ReportCategory;
  description: string;
  commune?: string;
  place?: string;
  occurredOn?: string;
  target?: { kind: TargetKind; reference?: string };
  anonymous: boolean;
  sealedIdentity?: SealedIdentity;
  /** Personnes mises en cause (agents) : elles ne voient JAMAIS le signalement. */
  implicatedUserIds: string[];
  linkedReceiptId?: string;
  evidence: EvidenceRef[];
  status: ReportStatus;
  receivedAt: string;
  recordedBy: string;
  qualifyBy: string;
  qualification?: { category: ReportCategory; severity: Severity; receivable: boolean; note: string; by: string; at: string };
  treatBy?: string;
  investigatorId?: string;
  assignedAt?: string;
  caseId?: string;
  closure?: { outcome: ReportOutcome; reason: string; by: string; at: string };
  messages: ReporterMessage[];
  updatedAt: string;
  /** Donnée de démonstration (fictive). */
  demo?: boolean;
}

/* ------------------------------------------------------------------ */
/* Signaux et alertes                                                  */
/* ------------------------------------------------------------------ */

export type ObservationType = 'VERIFICATION_QUITTANCE' | 'PAIEMENT_POINT';

/** Observation brute (flux des terminaux de vérification et des points de paiement). */
export interface Observation {
  id: string;
  type: ObservationType;
  at: string;
  source: string;
  receiptRef?: string;
  lat?: number;
  lon?: number;
  commune?: string;
  pointRef?: string;
  obligationRef?: string;
  amount?: { amount: string; currency: string };
  demo?: boolean;
}

export type AlertStatus = 'A_EXAMINER' | 'EN_EXAMEN' | 'CLOTURE_PROPOSEE' | 'CLASSEE' | 'DOSSIER_OUVERT';

export interface AlertVariable {
  name: string;
  value: string;
  source: string;
}

export interface FraudAlert {
  id: string;
  ruleCode: string;
  ruleLabel: string;
  /** Clé de déduplication : une même situation ne produit qu'une alerte ouverte. */
  fingerprint: string;
  severity: Severity;
  explanation: string;
  variables: AlertVariable[];
  confidence: 'FAIBLE' | 'MOYENNE' | 'ELEVEE';
  subjects: { kind: string; ref: string }[];
  status: AlertStatus;
  /** Toujours « AUCUN » : une alerte n'a aucun effet automatique (ARB-12). */
  automaticEffect: 'AUCUN';
  raisedAt: string;
  examinedBy?: string;
  closureProposal?: { by: string; at: string; reason: string };
  closure?: { by: string; at: string; reason: string };
  caseId?: string;
  history: { at: string; by: string; action: string; note?: string }[];
}

/* ------------------------------------------------------------------ */
/* Dossiers d'enquête                                                  */
/* ------------------------------------------------------------------ */

export type CaseStatus = 'OUVERT' | 'EN_INSTRUCTION' | 'CONCLUSIONS_DEPOSEES' | 'DECIDE';
export type CaseFinding = 'FONDE' | 'NON_FONDE' | 'INSUFFISANT';
export const CASE_DECISIONS = ['CLASSEMENT_SANS_SUITE', 'SAISINE_AUTORITE_COMPETENTE', 'SUSPENSION_CONSERVATOIRE_ACCES', 'RENVOI_DISCIPLINAIRE'] as const;
export type CaseDecision = (typeof CASE_DECISIONS)[number];

export interface CaseEvent {
  at: string;
  by: string;
  kind: 'OUVERTURE' | 'PIECE' | 'NOTE' | 'DEMANDE_PIECES' | 'LIEN' | 'CONCLUSIONS' | 'DECISION' | 'SIGNAL_LIE';
  text: string;
}

export interface FraudCase {
  id: string;
  title: string;
  openingReason: string;
  openedBy: string;
  openedAt: string;
  investigatorId: string;
  status: CaseStatus;
  alertIds: string[];
  reportIds: string[];
  mysteryCheckIds: string[];
  /** Personnes mises en cause : aucun accès au dossier. */
  implicatedUserIds: string[];
  links: { kind: string; ref: string; note?: string }[];
  evidence: EvidenceRef[];
  timeline: CaseEvent[];
  contributors: string[];
  conclusions?: { finding: CaseFinding; summary: string; recommendation: CaseDecision; by: string; at: string };
  decision?: {
    decision: CaseDecision; reason: string; by: string; at: string;
    /** Rappel : l'exécution relève de l'autorité compétente, jamais d'un automate. */
    execution: string; automaticEffect: 'AUCUN';
  };
}

/* ------------------------------------------------------------------ */
/* Contrôles mystère                                                   */
/* ------------------------------------------------------------------ */

export const MYSTERY_TARGETS = ['AGENT', 'SOUS_TRAITANT', 'POINT_PAIEMENT', 'GUICHET'] as const;
export type MysteryTarget = (typeof MYSTERY_TARGETS)[number];
export type MysteryStatus = 'PLANIFIE' | 'REALISE' | 'SUITE_DONNEE';
export type MysteryResult = 'CONFORME' | 'NON_CONFORME' | 'NON_REALISABLE';
export type MysteryFollowUp = 'AUCUNE_SUITE' | 'RAPPEL_PROCEDURE' | 'OUVRIR_DOSSIER';

export interface MysteryCheck {
  id: string;
  programme: string;
  targetKind: MysteryTarget;
  targetRef: string;
  commune: string;
  scenario: string;
  plannedFor: string;
  controllerId: string;
  plannedBy: string;
  plannedAt: string;
  status: MysteryStatus;
  result?: {
    outcome: MysteryResult; cashRequested: boolean; officialAmountShown: boolean | null; receiptIssued: boolean | null;
    observations: string; by: string; at: string; evidence: EvidenceRef[];
  };
  alertId?: string;
  followUp?: { action: MysteryFollowUp; note: string; by: string; at: string; caseId?: string };
  demo?: boolean;
}

/* ------------------------------------------------------------------ */
/* Incidents de sécurité                                               */
/* ------------------------------------------------------------------ */

export const INCIDENT_CATEGORIES = ['ACCES_NON_AUTORISE', 'FUITE_DONNEES', 'COMPROMISSION_APPAREIL', 'INDISPONIBILITE', 'FRAUDE_TECHNIQUE', 'INTEGRITE_JOURNAL', 'AUTRE'] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export type IncidentStatus = 'DECLARE' | 'EN_COURS' | 'CONTENU' | 'RESOLU' | 'CLOS';
export const NOTIFICATION_TARGETS = ['DPO', 'COMITE_SECURITE', 'AUTORITE_COMPETENTE', 'PERSONNES_CONCERNEES'] as const;
export type NotificationTarget = (typeof NOTIFICATION_TARGETS)[number];

export interface Incident {
  id: string;
  title: string;
  description: string;
  category: IncidentCategory;
  severity: Severity;
  declaredBy: string;
  declaredAt: string;
  detectedAt: string;
  ownerId?: string;
  dueAt: string;
  status: IncidentStatus;
  personalDataImpacted: boolean;
  affectedTaxpayerIds: string[];
  fromAlertId?: string;
  notifications: { target: NotificationTarget; by: string; at: string; note: string; deliveries: number }[];
  log: { at: string; by: string; status: IncidentStatus; note: string }[];
  closure?: { proofSha256: string; summary: string; by: string; at: string };
  demo?: boolean;
}

/* ------------------------------------------------------------------ */
/* Protection des données                                              */
/* ------------------------------------------------------------------ */

/**
 * ACCES et RECTIFICATION (existants) ; LIMITATION (limitation du traitement / retrait du consentement) et EFFACEMENT
 * (anonymisation des données non exigées par la loi fiscale) ajoutés le 27/09/2026 (deuxième passe adverse) : décidés
 * par DEUX personnes distinctes ; jamais d'effacement du journal d'audit, des écritures, des quittances ni des preuves.
 */
export type PrivacyRequestType = 'ACCES' | 'RECTIFICATION' | 'LIMITATION' | 'EFFACEMENT';
export type PrivacyRequestStatus = 'RECUE' | 'EN_TRAITEMENT' | 'EN_ATTENTE_SECONDE_VALIDATION' | 'REPONDUE' | 'REJETEE';
/** Types exigeant une seconde validation par une autre personne habilitée. */
export const PRIVACY_TWO_PERSON_TYPES: readonly PrivacyRequestType[] = ['LIMITATION', 'EFFACEMENT'];
export const RECTIFIABLE_FIELDS = ['fullName', 'email', 'language'] as const;
export type RectifiableField = (typeof RECTIFIABLE_FIELDS)[number];

export interface PrivacyRequest {
  id: string;
  taxpayerId: string;
  type: PrivacyRequestType;
  details: string;
  field?: RectifiableField;
  requestedValue?: string;
  submittedBy: string;
  submittedAt: string;
  dueAt: string;
  status: PrivacyRequestStatus;
  handledBy?: string;
  response?: { decision: 'ACCEPTEE' | 'REJETEE'; note: string; by: string; at: string };
  exportReady?: boolean;
  /** Première décision (LIMITATION, EFFACEMENT) : en attente de la seconde validation par une autre personne. */
  firstDecision?: { by: string; at: string; note: string };
  /** Exécution d'une limitation ou d'une anonymisation : champs traités (empreintes avant), données conservées et motif légal. */
  execution?: { at: string; by: string; treated: { field: string; beforeHash: string | null }[]; retained: { data: string; reason: string }[] };
}

export interface ProcessingRecord {
  id: string;
  version: number;
  name: string;
  purpose: string;
  legalBasis: string;
  dataCategories: string[];
  dataSubjects: string[];
  recipients: string[];
  retention: string;
  security: string[];
  module: string;
  sensitive: boolean;
  updatedAt: string;
  updatedBy: string;
}

/* ------------------------------------------------------------------ */
/* Revue des accès                                                     */
/* ------------------------------------------------------------------ */

export type ReviewDecision = 'A_CONFIRMER' | 'MAINTENU' | 'RETRAIT_A_EXECUTER';

export interface AccessReviewItem {
  id: string;
  userId: string;
  userName: string;
  entity: string;
  role: RoleCode;
  roleLabel: string;
  privileged: boolean;
  decision: ReviewDecision;
  reason?: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Revue des accès privilégiés : élévations juste-à-temps de la période obtenues par cette personne. */
  elevations?: { id: string; role: RoleCode; motif: string; approvedBy?: string; startedAt?: string; endedAt?: string; actions: number }[];
}

export interface AccessReviewCampaign {
  id: string;
  label: string;
  launchedBy: string;
  launchedAt: string;
  dueAt: string;
  nextReviewAt: string;
  status: 'OUVERTE' | 'CLOTUREE';
  items: AccessReviewItem[];
  closedBy?: string;
  closedAt?: string;
  /** Portée : revue complète (historique, défaut) ou revue MENSUELLE des accès privilégiés (§ 12.5). */
  scope?: 'COMPLETE' | 'PRIVILEGIES';
  /** Mois revu (AAAA-MM) pour une revue des accès privilégiés. */
  period?: string;
}
