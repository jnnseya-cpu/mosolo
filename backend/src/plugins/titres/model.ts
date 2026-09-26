/**
 * Moteur de titres (modules 70 et 71 ; § 19A du Cahier ; § H.11 du document maître).
 * Un TITRE prouve qu'un droit est ouvert (stationner, circuler, embarquer…) ; il est TOUJOURS adossé à au moins
 * une quittance (ou une exonération validée). La quittance reste la preuve du paiement ; le titre porte la validité.
 */
import type { MoneyJSON, TerritorialAttribution } from '@mosolo/shared';

/** Fuseau de référence : Kinshasa (UTC+1, sans heure d'été). L'heure du terminal n'est jamais prise en compte. */
export const KINSHASA_OFFSET_MS = 3_600_000;
export const KINSHASA_TZ = 'Africa/Kinshasa';

/** Les neuf modèles de validité du § 19A.3 / § H.11.3. */
export const VALIDITY_MODELS = [
  'DUREE_COURTE', 'JOURNALIER', 'HEBDOMADAIRE_MENSUEL', 'ANNUEL_EXERCICE', 'PAR_EVENEMENT',
  'USAGE_UNIQUE', 'CARNET_USAGES', 'ABONNEMENT', 'GLISSANT_CONDITIONNEL',
] as const;
export type ValidityModel = (typeof VALIDITY_MODELS)[number];

export const VALIDITY_MODEL_LABELS: Record<ValidityModel, { label: string; rule: string; examples: string }> = {
  DUREE_COURTE: { label: 'Durée courte', rule: "Début au paiement ou à l'heure choisie ; prolongation ; plafond", examples: 'Stationnement horaire' },
  JOURNALIER: { label: 'Journalier', rule: 'Journée calendaire ou 24 heures glissantes', examples: "Droit d'étal, pass wewa jour" },
  HEBDOMADAIRE_MENSUEL: { label: 'Hebdomadaire / mensuel', rule: 'Date de début, renouvellement, rappel', examples: 'Abonnement résidentiel, pass wewa' },
  ANNUEL_EXERCICE: { label: 'Annuel / exercice', rule: 'Exercice fiscal, échéance légale, tolérance', examples: 'Vignette, patente, autorisation publicitaire' },
  PAR_EVENEMENT: { label: 'Par événement', rule: 'Dates et lieu', examples: 'Spectacle, réservation de voirie' },
  USAGE_UNIQUE: { label: 'Usage unique', rule: 'Consommé au premier contrôle valide', examples: 'Embarquement, bon de sortie de carrière' },
  CARNET_USAGES: { label: "Carnet d'usages", rule: "Nombre d'usages restant", examples: 'Péage' },
  ABONNEMENT: { label: 'Abonnement', rule: 'Renouvellement automatique avec consentement, résiliation', examples: 'Stationnement résidentiel' },
  GLISSANT_CONDITIONNEL: { label: 'Glissant conditionnel', rule: 'Valide tant que les conditions sont remplies, avec date limite', examples: 'Quitus fiscal' },
};

export interface ValidityPolicy {
  model: ValidityModel;
  /** DUREE_COURTE : durée par défaut et plafond (minutes). */
  durationMinutes?: number;
  maxDurationMinutes?: number;
  /** JOURNALIER : journée calendaire (fin à 23:59:59 heure de Kinshasa) ou 24 heures glissantes. */
  dayMode?: 'CALENDAIRE' | 'GLISSANT_24H';
  /** HEBDOMADAIRE_MENSUEL, ABONNEMENT, CARNET_USAGES, USAGE_UNIQUE, GLISSANT_CONDITIONNEL : fenêtre (jours). */
  periodDays?: number;
  /** CARNET_USAGES : nombre d'usages. */
  uses?: number;
  /** Tolérance après la fin (minutes) avant le rouge. */
  toleranceMinutes: number;
  /** Seuil de passage à l'ambre (minutes avant la fin) — paramètre de la fiche de configuration du module. */
  amberMinutes: number;
  startMode: 'PAIEMENT' | 'HEURE_CHOISIE';
  extendable: boolean;
  refundable: boolean;
}

export const SUPPORTS = ['QR_DYNAMIQUE', 'QR_STATIQUE', 'PLAQUE', 'GILET', 'AUTOCOLLANT', 'CARTE', 'SMS', 'USSD', 'CODE_COURT'] as const;
export type Support = (typeof SUPPORTS)[number];

/** Statut de l'acte fondant le type de titre (J21, J28) : aucun type n'est activable sans acte. */
export type LegalActStatus = 'ACTE_REQUIS' | 'CERTIFIE' | 'DEMONSTRATION';

export interface CredentialType {
  id: string;
  code: string;
  version: number;
  /** Module émetteur (numéro de la Spécification) et libellé. */
  module: string;
  moduleLabel: string;
  label: string;
  /** Préfixe de code visuel (STA, MAR, VIG, WEW…) : un titre ne peut être présenté pour un autre service. */
  prefix: string;
  entity: string;
  validity: ValidityPolicy;
  /** Par défaut : non transférable. */
  transferable: boolean;
  /** Le titre est lié à une plaque (contrôle par plaque, sans support). */
  plateBound: boolean;
  supports: Support[];
  /** Tarif : règle du registre (code) et entrées de la formule pour UNE unité. Jamais un prix saisi. */
  pricing?: { ruleCode: string; inputs: Record<string, string> };
  legalAct: { ref: string; status: LegalActStatus; note: string };
  demo: boolean;
  createdAt: string;
  createdBy: string;
}

/** Les six statuts affichés (§ 19A.2, § H.11.2) : couleur + icône + texte, jamais la couleur seule. */
export const DISPLAY_STATUSES = ['PAS_ENCORE_ACTIF', 'VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE', 'EXPIRE', 'SUSPENDU', 'INVALIDE'] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];
export type StatusColor = 'gris' | 'vert' | 'ambre' | 'rouge' | 'bleu' | 'noir';

export const STATUS_PRESENTATION: Record<DisplayStatus, { color: StatusColor; icon: string; signal: 'COURT' | 'DISTINCT' | 'AUCUN' }> = {
  PAS_ENCORE_ACTIF: { color: 'gris', icon: 'clock', signal: 'AUCUN' },
  VALIDE: { color: 'vert', icon: 'check', signal: 'COURT' },
  BIENTOT_EXPIRE: { color: 'ambre', icon: 'alert', signal: 'AUCUN' },
  /** Encore valable, moins de 21 % de validité restante (ou tolérance après l'échéance). */
  CRITIQUE: { color: 'rouge', icon: 'alert', signal: 'AUCUN' },
  EXPIRE: { color: 'rouge', icon: 'x', signal: 'DISTINCT' },
  SUSPENDU: { color: 'bleu', icon: 'info', signal: 'AUCUN' },
  INVALIDE: { color: 'noir', icon: 'ban', signal: 'DISTINCT' },
};

/** État enregistré (cycle de vie § H.11.7) ; le statut affiché en est déduit à l'heure du serveur. */
export type CredentialState = 'EMIS' | 'SUSPENDU' | 'CONSOMME' | 'REVOQUE' | 'ANNULE' | 'REMPLACE';

export interface CredentialSubject {
  plate?: string;
  driverId?: string;
  motoId?: string;
  objectId?: string;
  label?: string;
}

export interface CredentialPlace {
  commune: string | null;
  sourceId: string;
  label: string;
  basis: TerritorialAttribution['basis'];
  lat?: number;
  lon?: number;
}

export interface UsePlace {
  lat?: number;
  lon?: number;
  label?: string;
}

export interface Credential {
  id: string;
  number: string;
  shortCode: string;
  typeCode: string;
  typeVersion: number;
  module: string;
  entity: string;
  model: ValidityModel;
  holderTaxpayerId?: string;
  payerTaxpayerId: string;
  subject: CredentialSubject;
  place: CredentialPlace;
  /** Rattachement territorial de la recette (§ 20.3) : lieu où le service est consommé. */
  attribution: TerritorialAttribution;
  validFrom: string;
  validUntil: string;
  toleranceMinutes: number;
  amberMinutes: number;
  usesTotal?: number;
  usesLeft?: number;
  conditionMet?: boolean;
  autoRenew?: { consent: boolean; consentAt?: string; cancelledAt?: string };
  state: CredentialState;
  stateReason?: string;
  stateBy?: string;
  stateAt?: string;
  receiptIds: string[];
  receiptNumbers: string[];
  paymentOrderId?: string;
  paymentReference?: string;
  obligationId?: string;
  amount?: MoneyJSON;
  issuanceId?: string;
  renewsId?: string;
  replacesId?: string;
  replacedById?: string;
  firstUse?: { at: string; place: UsePlace; controlId: string };
  /** Jeton statique signé (Ed25519) : QR papier / autocollant / gilet, vérifiable hors ligne. */
  staticToken: string;
  issuedAt: string;
  amberNotifiedAt?: string;
  demo: boolean;
}

/** Ligne d'une commande de titres : un titre par ligne, activé individuellement. */
export interface IssuanceItem {
  typeCode: string;
  holderTaxpayerId?: string;
  subject: CredentialSubject;
  place: CredentialPlace;
  requestedStart?: string;
  durationMinutes?: number;
  eventStart?: string;
  eventEnd?: string;
  renewsId?: string;
  autoRenewConsent?: boolean;
  /** Rempli à la création des références de paiement (une par commune du fait générateur). */
  paymentOrderId?: string;
  credentialId?: string;
}

export interface IssuancePayment {
  commune: string | null;
  obligationId: string;
  paymentOrderId: string;
  paymentReference: string;
  amount: MoneyJSON;
  expiresAt: string;
  status: 'EN_ATTENTE' | 'PAYE' | 'EXPIRE' | 'ECHOUE';
}

export interface Issuance {
  id: string;
  status: 'EN_ATTENTE_PAIEMENT' | 'PARTIELLEMENT_EMISE' | 'EMISE' | 'EXPIREE' | 'ANNULEE';
  payerTaxpayerId: string;
  requestedBy: string;
  channel: string;
  /** Paiement groupé (coopérative) : identifiant du groupement payeur. */
  groupPayer?: { kind: string; id: string; label: string };
  items: IssuanceItem[];
  payments: IssuancePayment[];
  createdAt: string;
  context?: string;
}

export type ControlMethod = 'QR_DYNAMIQUE' | 'QR_STATIQUE' | 'PLAQUE' | 'CODE_COURT';
/** Réponse minimale d'un contrôle : valide / invalide / expiré (sans donnée personnelle). */
export type ControlResult = 'VALIDE' | 'INVALIDE' | 'EXPIRE';

export interface VerificationEvent {
  id: string;
  credentialId?: string;
  typeCode?: string;
  module?: string;
  method: ControlMethod;
  presented: string;
  controllerId: string;
  deviceId?: string;
  place: UsePlace;
  at: string;
  offline: boolean;
  offlineResult?: ControlResult;
  batchId?: string;
  result: ControlResult;
  displayStatus: DisplayStatus | 'INCONNU';
  reason?: string;
  consumedUse: boolean;
  alreadyUsed?: { at: string; place: UsePlace };
  constatId?: string;
  recordedAt: string;
}

export interface UsageEvent {
  id: string;
  credentialId: string;
  controlId: string;
  at: string;
  place: UsePlace;
  deviceId?: string;
  usesLeftAfter: number;
}

/** Constat : un contrôle négatif produit un CONSTAT à instruire, jamais une amende (RW1, ARB-12). */
export interface Constat {
  id: string;
  controlId: string;
  credentialId?: string;
  module?: string;
  entity: string;
  presented: string;
  reason: string;
  controllerId: string;
  place: UsePlace;
  at: string;
  status: 'OUVERT' | 'CLASSE' | 'TRANSMIS';
  legalEffect: 'AUCUN_MONTANT';
  notice: string;
  duringGrace: boolean;
  decision?: { by: string; at: string; outcome: 'CLASSE' | 'TRANSMIS'; motif: string };
}

export interface Revocation {
  id: string;
  credentialId: string;
  state: CredentialState;
  reason: string;
  by: string;
  at: string;
}
