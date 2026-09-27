/**
 * Module « acces » — modèle : entités et espaces (§ 10A, § 12A.3), fiches de configuration de module (§ 10A.4, H.4.3),
 * revendications et arbitrages (§ 10A.3), invitations en cascade (§ 12A.2 à § 12A.7, H.6.4 à H.6.9),
 * identité avancée (§ 9 : OTP, niveaux N0-A à N3, personnes morales, mandats, doublons et fusion),
 * MFA simulé et consultation motivée (bris de glace, § 12.1).
 */
import type { RoleCode, VerificationLevel } from '@mosolo/shared';

// ─────────────────────────────── Entités et espaces ───────────────────────────────

export const ENTITY_KINDS = [
  'PLATEFORME', 'EXECUTIF', 'MINISTERE', 'REGIE', 'TRESOR', 'AUDIT', 'COMMUNE', 'SERVICE_TECHNIQUE',
  'OPERATEUR_DELEGUE', 'SOUS_TRAITANT', 'BANQUE_PSP', 'PARTENAIRE',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  PLATEFORME: 'Exploitation de la plateforme', EXECUTIF: 'Exécutif provincial', MINISTERE: 'Ministère provincial',
  REGIE: 'Régie financière', TRESOR: 'Trésor provincial', AUDIT: 'Audit et inspection', COMMUNE: 'Commune / ETD',
  SERVICE_TECHNIQUE: 'Service technique', OPERATEUR_DELEGUE: 'Opérateur délégué', SOUS_TRAITANT: 'Sous-traitant terrain accrédité',
  BANQUE_PSP: 'Banque ou prestataire de paiement', PARTENAIRE: 'Partenaire de données ou d’API',
};

export interface EntitySpace {
  id: string;
  name: string;
  shortName: string;
  kind: EntityKind;
  parentId: string | null;
  status: 'ACTIVE' | 'SUSPENDUE';
  createdAt: string;
  createdBy: string;
  decisionRef?: string;
  suspendedAt?: string;
  suspensionReason?: string;
  demo?: boolean;
}

// ─────────────────────────────── Fiches de configuration de module ───────────────────────────────

export const MODULE_STATUSES = [
  'BROUILLON', 'VALIDATION_PROGRAMME', 'VALIDATION_JURIDIQUE', 'RECETTE', 'SECONDE_VALIDATION', 'ACTIF', 'SUSPENDU', 'RETIRE', 'BLOQUE_ARBITRAGE',
] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];

export const VALIDITY_MODELS = ['HORAIRE', 'JOURNALIER', 'HEBDOMADAIRE', 'MENSUEL', 'ANNUEL', 'PAR_USAGE', 'PAR_EVENEMENT', 'ABONNEMENT', 'CONDITIONNEL', 'SANS_TITRE'] as const;
export const PROOF_MECHANISMS = ['QR_DYNAMIQUE', 'QR_STATIQUE', 'PLAQUE', 'VIGNETTE', 'SMS', 'CARTE', 'RECU_IMPRIME', 'LECTURE_PLAQUE'] as const;
export const CHANNELS = ['APPLICATION', 'USSD', 'SVI', 'GUICHET', 'POINT_PAIEMENT_AGREE', 'AGENT_SANS_ENCAISSEMENT', 'TERMINAL'] as const;

export interface ModuleVisa {
  step: 'SOUMISSION' | 'PROGRAMME' | 'JURIDIQUE' | 'RECETTE' | 'ACTIVATION';
  by: string;
  role: RoleCode;
  at: string;
  note?: string;
}

export interface Attachment {
  entity: string;
  from: string;
  to?: string;
  actReference: string;
  validatedBy: string;
}

export interface ModuleConfig {
  id: string;
  code: string;
  label: string;
  /** Domaine de compétence revendiqué (ex. STATIONNEMENT) : une seule entité responsable à la fois. */
  revenueScope: string;
  responsibleEntity: string;
  moduleManagerId?: string;
  /** Comptes bénéficiaires : alias du coffre uniquement (comptes publics). */
  beneficiaryAliases: string[];
  objectTypes: string[];
  ruleCodes: string[];
  credentialTypes: string[];
  validityModel: (typeof VALIDITY_MODELS)[number];
  proofMechanisms: (typeof PROOF_MECHANISMS)[number][];
  usageRules: string;
  channels: (typeof CHANNELS)[number][];
  fieldWorkflows: string[];
  dashboards: string[];
  /** Dépendances en texte libre (historique, conservé). */
  dependencies: string[];
  /** Dépendances STRUCTURÉES (§ 10A.3) : codes des règles de dépendance versionnées (ex. DEP-PERMIS-QUITUS), évaluées par le moteur. */
  dependencyRefs?: string[];
  sharedReadWith: string[];
  actReferences: string[];
  status: ModuleStatus;
  visas: ModuleVisa[];
  recette?: { passed: boolean; report: string; by: string; at: string };
  history: { at: string; from: ModuleStatus | null; to: ModuleStatus; by: string; note?: string }[];
  attachments: Attachment[];
  pendingReattachment?: { newEntity: string; beneficiaryAliases: string[]; actReference: string; motif: string; proposedBy: string; at: string };
  arbitrationId?: string;
  createdBy: string;
  createdAt: string;
  demo?: boolean;
}

// ─────────────────────────────── Revendications et arbitrages ───────────────────────────────

/** Faits générateurs (clé de revendication, avec l'objet et la période). */
export const TAXABLE_FACTS = [
  'PROPRIETE_BATIE', 'PROPRIETE_NON_BATIE', 'REVENU_LOCATIF', 'STATIONNEMENT', 'AFFICHAGE_PUBLICITAIRE',
  'OCCUPATION_DOMAINE_PUBLIC', 'ACTIVITE_COMMERCIALE', 'MARCHE_ETAL', 'TRANSPORT_PUBLIC', 'VEHICULE', 'AUTRE',
] as const;
export type TaxableFact = (typeof TAXABLE_FACTS)[number];

export interface Claim {
  id: string;
  entity: string;
  objectId: string;
  factCode: TaxableFact;
  period: string;
  ruleCode?: string;
  basis: string;
  status: 'ACCEPTEE' | 'BLOQUEE' | 'REJETEE' | 'RETIREE';
  arbitrationId?: string;
  createdBy: string;
  createdAt: string;
  demo?: boolean;
}

export interface ArbitrationClaimant {
  entity: string;
  claimId?: string;
  moduleConfigId?: string;
  /** Entité qui détenait déjà la revendication (ou dont l'obligation existe déjà). */
  holder: boolean;
}

export interface ArbitrationCase {
  id: string;
  kind: 'FAIT_GENERATEUR' | 'COMPETENCE_MODULE';
  subject: { objectId?: string; factCode?: TaxableFact; period?: string; revenueScope?: string; ruleCodes?: string[] };
  claimants: ArbitrationClaimant[];
  status: 'OUVERT' | 'INSTRUIT' | 'DECIDE';
  openedAt: string;
  openedBy: string;
  opinion?: { by: string; at: string; text: string; recommendedEntity?: string };
  decision?: { by: string; at: string; winnerEntity: string; motif: string; actReference: string; rectificationRequired: boolean };
  /** Obligations déjà émises par le détenteur (aucune seconde obligation n'est jamais créée). */
  existingObligationIds: string[];
  demo?: boolean;
}

// ─────────────────────────────── Niveaux d'accès et invitations ───────────────────────────────

export const ACCESS_LEVELS = [
  'CONSULTATION', 'AGENT_TERRAIN', 'OPERATEUR', 'SUPERVISEUR', 'OPERATEUR_ACCES', 'RESPONSABLE_MODULE',
  'ADMIN_ENTITE', 'DIRECTION', 'AUDIT', 'ADMIN_TECHNIQUE',
] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Rang des niveaux (pas d'élévation : rang accordé ≤ rang de l'invitant). AUDIT et ADMIN_TECHNIQUE sont hors échelle. */
export const LEVEL_RANK: Record<AccessLevel, number> = {
  CONSULTATION: 1, AGENT_TERRAIN: 1, OPERATEUR: 2, SUPERVISEUR: 3, OPERATEUR_ACCES: 3, RESPONSABLE_MODULE: 4,
  ADMIN_ENTITE: 5, DIRECTION: 6, AUDIT: 90, ADMIN_TECHNIQUE: 99,
};

export const LEVEL_INFO: Record<AccessLevel, { label: string; usage: string; invite: string }> = {
  CONSULTATION: { label: 'Consultation', usage: 'Lecture des tableaux de bord et dossiers du périmètre', invite: 'Non' },
  AGENT_TERRAIN: { label: 'Agent de terrain', usage: 'Missions, constats, enrôlement assisté, contrôle des titres', invite: 'Non' },
  OPERATEUR: { label: 'Opérateur', usage: 'Traitement des dossiers, déclarations, notifications', invite: 'Non' },
  SUPERVISEUR: { label: 'Superviseur', usage: 'Encadrement, affectation des missions, contrôle qualité', invite: 'Sur délégation' },
  OPERATEUR_ACCES: { label: 'Opérateur d’accès désigné', usage: 'Inscription assistée des invités de son entité', invite: 'Non, sauf délégation expresse' },
  RESPONSABLE_MODULE: { label: 'Responsable de module', usage: 'Pilotage du module, équipes, sous-traitants', invite: 'Dans le module' },
  ADMIN_ENTITE: { label: 'Administrateur d’entité', usage: 'Comptes et rôles de l’entité (sans accès aux montants)', invite: 'Dans l’entité' },
  DIRECTION: { label: 'Direction et exécutif', usage: 'Vision, décisions, arbitrages', invite: 'Dans l’entité' },
  AUDIT: { label: 'Audit et inspection', usage: 'Lecture intégrale des preuves', invite: 'Non (créé par l’administrateur, validé par l’autorité d’audit)' },
  ADMIN_TECHNIQUE: { label: 'Administration technique', usage: 'Exploitation sans pouvoir fiscal ni financier', invite: 'Selon § 12A.6' },
};

/** Niveau standard porté par chaque rôle (R30 et R31 : comptes publics, jamais invités). */
export const ROLE_LEVEL: Record<RoleCode, AccessLevel | null> = {
  R01: 'DIRECTION', R02: 'DIRECTION', R03: 'DIRECTION', R04: 'DIRECTION', R05: 'DIRECTION', R06: 'DIRECTION',
  R07: 'RESPONSABLE_MODULE', R08: 'ADMIN_ENTITE', R09: 'SUPERVISEUR', R10: 'AGENT_TERRAIN', R11: 'OPERATEUR', R12: 'OPERATEUR',
  R13: 'OPERATEUR', R14: 'OPERATEUR', R15: 'OPERATEUR', R16: 'OPERATEUR', R17: 'OPERATEUR', R18: 'OPERATEUR', R19: 'OPERATEUR',
  R20: 'OPERATEUR', R21: 'DIRECTION', R22: 'AUDIT', R23: 'AUDIT', R24: 'AUDIT', R25: 'AUDIT',
  R26: 'ADMIN_TECHNIQUE', R27: 'ADMIN_TECHNIQUE', R28: 'ADMIN_TECHNIQUE', R29: 'ADMIN_TECHNIQUE',
  R30: null, R31: null, R32: 'OPERATEUR', R33: 'OPERATEUR', R34: 'OPERATEUR', R35: 'AGENT_TERRAIN', R36: 'CONSULTATION', R37: 'CONSULTATION',
};

/**
 * Rôles sensibles (§ 12A.5) : activation après seconde validation par une personne distincte de l'invitant ;
 * MFA résistante au hameçonnage (clé d'accès) exigée.
 */
export const SENSITIVE_ROLES: RoleCode[] = [
  'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19', 'R21',
  'R22', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28', 'R29',
];
/**
 * Rôles de la chaîne constat → vérification → décision (chef de service, superviseur, contrôleur, contentieux) :
 * non « sensibles » au sens de la clé d'accès, mais activés seulement après seconde validation par une personne
 * distincte de l'invitant — un invitant seul ne peut pas fabriquer les maillons successifs d'un même dossier.
 */
export const SECOND_VALIDATION_ROLES: RoleCode[] = ['R07', 'R09', 'R11', 'R20'];
/** Agents de terrain : actifs seulement après habilitation par la régie (formation certifiée, § 15A.4). */
export const FIELD_ROLES: RoleCode[] = ['R10', 'R35'];

export type InvitationStatus = 'ENVOYEE' | 'FINALISEE' | 'EXPIREE' | 'REFUSEE' | 'REVOQUEE';

export interface InvitationScope {
  territory?: string[];
  modules?: string[];
  validUntil?: string;
}

export interface Invitation {
  id: string;
  inviterId: string;
  inviterEntity: string;
  fullName: string;
  phone: string;
  email?: string;
  entity: string;
  accessLevel: AccessLevel;
  roles: RoleCode[];
  scope: InvitationScope;
  canInvite: boolean;
  motif: string;
  tokenHash: string;
  codeHash: string;
  expiresAt: string;
  createdAt: string;
  status: InvitationStatus;
  failedAttempts: number;
  finalizedAt?: string;
  finalizedVia?: 'LIEN' | 'OPERATEUR_ACCES';
  accountId?: string;
  /** Personne physique ayant finalisé l'invitation (empreinte à clé de la pièce d'identité). */
  personId?: string;
  revokedAt?: string;
  revokedReason?: string;
}

export type AccountStatus = 'ATTENTE_VALIDATION' | 'ATTENTE_SECRETS' | 'ACTIF' | 'SUSPENDU' | 'REVOQUE' | 'EXPIRE';

export interface WorkAccount {
  id: string;
  fullName: string;
  phone?: string;
  entity: string;
  accessLevel: AccessLevel;
  roles: RoleCode[];
  scope: InvitationScope;
  canInvite: boolean;
  status: AccountStatus;
  origin: 'INVITATION' | 'AMORCAGE_DEMO';
  invitationId?: string;
  sponsorId?: string;
  mfaMethod?: 'PASSKEY' | 'TOTP' | 'SMS';
  /** Secrets définis par la personne elle-même (jamais par l'opérateur d'accès, § 12A.7). */
  secretsPending: boolean;
  deviceId?: string;
  /**
   * Personne physique : empreinte HMAC (clé serveur) du numéro de pièce d'identité normalisé — jamais le numéro.
   * Un seul compte de travail non clos par personne.
   */
  personId?: string;
  /** Date de naissance déclarée à la finalisation (détection de doublons nom + date de naissance). */
  birthDate?: string;
  /** Profil contribuable de la même personne (deux profils distincts, sans croisement, § 12A.1). */
  linkedTaxpayerIds: string[];
  createdAt: string;
  activatedAt?: string;
  revokedAt?: string;
  revokedReason?: string;
}

export type ValidationKind = 'ACTIVATION_COMPTE' | 'DROIT_INVITER' | 'OPERATEUR_ACCES';
export type ValidatorRequirement = 'SECURITE' | 'HORS_BANDE_CABINET' | 'HABILITATION_REGIE' | 'AUTORITE_AUDIT';

export interface ValidationRequest {
  id: string;
  kind: ValidationKind;
  subjectUserId: string;
  entity: string;
  requestedBy: string;
  requirement: ValidatorRequirement;
  motif: string;
  status: 'EN_ATTENTE' | 'APPROUVEE' | 'REJETEE';
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface Grant {
  id: string;
  userId: string;
  kind: 'DROIT_INVITER' | 'OPERATEUR_ACCES';
  entity: string;
  grantedBy: string;
  status: 'EN_ATTENTE' | 'ACTIF' | 'REVOQUE';
  createdAt: string;
  validationId?: string;
}

// ─────────────────────────────── Identité avancée ───────────────────────────────

export const PROOF_TYPES = [
  'OTP_TELEPHONE', 'PIECE_IDENTITE', 'ADRESSE', 'CONTROLE_DOCUMENTAIRE', 'VISITE_TERRAIN', 'NIF', 'RCCM', 'ID_NAT', 'MANDAT_NOTARIE', 'ENROLEMENT_ASSISTE',
] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

export interface IdentityProof {
  id: string;
  taxpayerId: string;
  type: ProofType;
  /** Référence masquée (jamais le numéro complet dans les réponses). */
  referenceMasked: string;
  referenceHash: string;
  note?: string;
  status: 'DECLAREE' | 'VALIDEE' | 'REJETEE';
  declaredBy: string;
  declaredAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

export const LEVEL_RIGHTS: Record<VerificationLevel, { label: string; proof: string; rights: string }> = {
  N0: { label: 'N0 — déclaratif', proof: 'Téléphone vérifié par code à usage unique', rights: 'Consulter, simuler, signaler, payer une référence reçue' },
  N0A: { label: 'N0-A — assisté', proof: 'Enrôlement assisté (guichet ou agent habilité), consentement oral ou témoin', rights: 'Droits N0 et paiement assisté' },
  N1: { label: 'N1 — identifié', proof: 'Pièce d’identité contrôlée et adresse déclarée', rights: 'Déclarer des objets, recevoir des obligations, obtenir des quittances, désigner un mandataire de confiance' },
  N2: { label: 'N2 — vérifié', proof: 'Contrôle documentaire approfondi ou visite de terrain', rights: 'Rattacher des objets de forte valeur, contestation formelle, mandat simple' },
  N3: { label: 'N3 — certifié', proof: 'NIF vérifié ; RCCM pour les personnes morales ; mandat écrit ou notarié', rights: 'Opérations d’entreprise, mandat de tiers professionnel, quitus fiscal' },
};

export const LEVEL_ORDER: Record<VerificationLevel, number> = { N0: 0, N0A: 0, N1: 1, N2: 2, N3: 3 };

export const LEGAL_FORMS = ['SARL', 'SA', 'SAS', 'SNC', 'ETS', 'ASBL', 'COOPERATIVE', 'INSTITUTION_PUBLIQUE', 'AUTRE'] as const;

export interface Representative {
  fullName: string;
  fonction: string;
  phoneMasked?: string;
  /** Habilitation nominative (mandataire de la personne morale). */
  habilitation: 'DIRIGEANT' | 'MANDATAIRE_HABILITE';
}

export interface Organisation {
  id: string;
  taxpayerId: string;
  raisonSociale: string;
  forme: (typeof LEGAL_FORMS)[number];
  /** Identifiants DÉCLARÉS (statut probant DECLARE) tant qu'une preuve n'est pas validée. */
  rccmDeclared?: string;
  idNatDeclared?: string;
  nifDeclared?: string;
  representatives: Representative[];
  createdAt: string;
  demo?: boolean;
}

export interface OtpChallenge {
  id: string;
  purpose: 'VERIFICATION_TELEPHONE' | 'MFA';
  subjectId: string;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  status: 'EN_ATTENTE' | 'VERIFIE' | 'EXPIRE' | 'BLOQUE';
  createdAt: string;
}

/** Boîte d'envoi du bac à sable : les codes n'y figurent que tant qu'aucun fournisseur SMS n'est branché. */
export interface SandboxMessage {
  id: string;
  at: string;
  to: string;
  purpose: string;
  text: string;
}

export interface MergeRequest {
  id: string;
  survivorId: string;
  absorbedId: string;
  reasons: string[];
  evidence: string;
  documentRef?: string;
  status: 'PROPOSEE' | 'VERIFIEE' | 'EFFECTUEE' | 'REJETEE' | 'ANNULEE';
  proposedBy: string;
  proposedAt: string;
  verifiedBy?: string;
  verifiedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  closedBy?: string;
  closedAt?: string;
  closeReason?: string;
}

export const CONSULTATION_PURPOSES = ['CONTROLE', 'RECOURS', 'AUDIT', 'ENQUETE'] as const;

export interface Consultation {
  id: string;
  userId: string;
  userEntity: string;
  taxpayerId: string;
  purpose: (typeof CONSULTATION_PURPOSES)[number];
  motif: string;
  mode: 'PERIMETRE' | 'BRIS_DE_GLACE';
  grantedAt: string;
  expiresAt: string;
  reads: number;
  review?: { by: string; at: string; conclusion: 'JUSTIFIEE' | 'INJUSTIFIEE'; note: string };
}

export const MANDATE_ACTIONS = ['CONSULTER', 'DECLARER', 'PAYER', 'CONTESTER'] as const;
export type MandateAction = (typeof MANDATE_ACTIONS)[number];

export interface Mandate {
  id: string;
  mandantTaxpayerId: string;
  mandataireUserId: string;
  kind: 'CONFIANCE' | 'PROFESSIONNEL';
  scope: MandateAction[];
  objectIds: string[];
  validFrom: string;
  validTo: string;
  proofRef?: string;
  status: 'ACTIF' | 'REVOQUE' | 'EXPIRE';
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
  demo?: boolean;
}

// ─────────────────────────────── Types de comptes (27/09/2026) ───────────────────────────────

/**
 * Contrat de partenariat (R32 point de paiement agréé, R33 partenaire bancaire / monnaie mobile, R34 partenaire de
 * données) : enregistré par une personne, approuvé par une personne DISTINCTE ; tant qu'il n'est pas actif, aucune
 * invitation d'un rôle partenaire n'est possible dans l'entité.
 */
export interface PartnerContract {
  id: string;
  entity: string;
  reference: string;
  roles: RoleCode[];
  object: string;
  validFrom: string;
  validTo?: string;
  status: 'PROPOSE' | 'ACTIF' | 'REJETE' | 'RESILIE';
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  history: { at: string; by: string; action: string; note?: string }[];
  demo?: boolean;
}

/** Inscription publique d'un mandataire (R31) : téléphone vérifié par code, puis compte public de mandataire. */
export interface MandataireRegistration {
  id: string;
  fullName: string;
  phone: string;
  kind: 'PERSONNE_PHYSIQUE' | 'CABINET';
  language: string;
  status: 'EN_ATTENTE_CODE' | 'ACTIF';
  userId?: string;
  createdAt: string;
  activatedAt?: string;
}

// ─────────────────────────────── Départements : modules rattachés (27/09/2026) ───────────────────────────────

export type ModuleLinkStatus = 'ACTIF' | 'DETACHE' | 'EN_ATTENTE' | 'REFUSE' | 'CLOS';

/**
 * Lien « module fonctionnel du catalogue ↔ entité » (§ 12A, ajout du 27/09/2026).
 * - Module SANS compétence de recette : une personne habilitée (R26, ou R08 dans son sous-arbre) rattache ou détache,
 *   avec motif, date d'effet et date de fin facultative ; chaque acte est journalisé et historisé.
 * - Module PORTEUR DE RECETTES : le lien ne fait que tracer la demande ; la compétence passe par le circuit EXISTANT
 *   des fiches de module (création de fiche, visas, activation ou réattribution approuvée par une personne distincte).
 *   Un retrait est proposé ici puis décidé par une personne distincte habilitée à changer l'état d'une fiche.
 */
export interface ModuleLink {
  id: string;
  moduleCode: string;
  entity: string;
  revenue: boolean;
  action: 'RATTACHEMENT' | 'DETACHEMENT';
  status: ModuleLinkStatus;
  from: string;
  to?: string;
  motif: string;
  actReference?: string;
  moduleConfigId?: string;
  circuit?: 'FICHE' | 'REATTRIBUTION' | 'RETRAIT' | 'DIRECT';
  createdBy: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  history: { at: string; by: string; action: string; note?: string }[];
  demo?: boolean;
}
