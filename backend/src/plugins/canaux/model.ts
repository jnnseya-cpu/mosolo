/**
 * Canaux inclusifs (modules 6, 63, 64, 65, 66, 68) : types, constantes et catalogue de pictogrammes.
 * Aucune valeur ici n'est un tarif : les montants viennent toujours d'une obligation liquidée sur règle ACTIVE.
 */
import type { LanguageCode, MoneyJSON } from '@mosolo/shared';

/** Fuseau de Kinshasa (UTC+1, sans heure d'été) : jour de caisse et horaires d'enrôlement. */
export const KINSHASA_OFFSET_MS = 60 * 60 * 1000;

/** Communes du pilote (§ H.24.1) : au moins un guichet MOSOLO avec guichet bancaire par commune (§ H.24.4, D15). */
export const PILOT_COMMUNES = ['Gombe', 'Limete', 'Kalamu', 'Ngaliema'] as const;

/** Code USSD et numéro SVI : attribués par convention avec les opérateurs (J29) — jamais inventés. */
export const USSD_CODE_LABEL = '*[code court À CONFIGURER]#';
export const IVR_NUMBER_LABEL = '[numéro vert SVI À CONFIGURER]';

/** Plage horaire d'enrôlement assisté (heure de Kinshasa) : hors plage ⇒ refus journalisé (§ H.13, agent d'enrôlement). */
export const ENROLMENT_HOURS = { from: 7, to: 19 } as const;

/**
 * Empreinte digitale comme marque de consentement : seulement si J18 est certifié (ARB-24).
 * Tant que ce n'est pas le cas, seules la voix enregistrée et le témoin identifié sont acceptés.
 */
export const FINGERPRINT_CONSENT_CERTIFIED = false;

/** Durée d'inactivité d'une session USSD / SVI avant expiration (contrainte opérateur). */
export const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
/** Tentatives de code secret avant verrouillage temporaire du canal pour ce compte. */
export const MAX_PIN_ATTEMPTS = 3;
export const PIN_LOCK_MS = 15 * 60 * 1000;

/** Limitation anti-énumération des vérifications par code court (module 68). */
export const VERIFY_WINDOW_MS = 10 * 60 * 1000;
export const VERIFY_MAX_PER_WINDOW = 10;
export const VERIFY_MAX_FAILURES_PER_WINDOW = 5;

export type SessionChannel = 'USSD' | 'SVI';

export interface ChannelSession {
  id: string;
  channel: SessionChannel;
  /** Empreinte du numéro appelant (jamais le numéro en clair dans le journal). */
  msisdnHash: string;
  msisdnMasked: string;
  lang: LanguageCode;
  node: string;
  /** Contexte de navigation (index → identifiant), jamais de donnée sensible. */
  data: Record<string, string>;
  taxpayerId?: string;
  cardNumber?: string;
  authenticated: boolean;
  status: 'ACTIVE' | 'TERMINEE' | 'EXPIREE';
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string;
  steps: number;
  /** Menu choisi avant identification (reprise après saisie du code secret). */
  pendingIntent?: string;
}

/** Entrée du journal de session : la saisie d'un code secret est toujours masquée. */
export interface SessionJournalEntry {
  id: string;
  sessionId: string;
  channel: SessionChannel;
  seq: number;
  at: string;
  node: string;
  input: string | null;
  /** Écran USSD (texte) ou invites vocales SVI concaténées. */
  output: string;
  end: boolean;
}

export interface ScreenOut {
  sessionId: string;
  channel: SessionChannel;
  lang: LanguageCode;
  /** Texte d'écran USSD (≤ 182 caractères par écran). */
  text: string;
  /** Invites vocales du SVI (texte à lire ; audio pré-enregistré validé en production, § 11.5). */
  prompts: string[];
  /** Touches attendues (SVI) ou options du menu (USSD). */
  options: { key: string; label: string }[];
  end: boolean;
  translationPending: boolean;
}

/** Pilier de consentement sans écriture (§ 13A.3, § H.7.3). */
export const CONSENT_METHODS = ['VOIX', 'TEMOIN', 'EMPREINTE'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export const DECLARED_OBJECT_TYPES = ['PARCELLE', 'LOGEMENT_LOUE', 'COMMERCE', 'VEHICULE', 'PANNEAU'] as const;
export type DeclaredObjectType = (typeof DECLARED_OBJECT_TYPES)[number];

export interface AssistedEnrolment {
  id: string;
  localId: string;
  batchId: string;
  channel: 'DOMICILE' | 'SITE' | 'GUICHET_MOSOLO';
  agentId: string;
  deviceId: string;
  missionId: string;
  capturedAt: string;
  receivedAt: string;
  gps: { lat: number; lon: number; accuracyM: number };
  commune: string;
  quartier: string;
  /** Adresse informelle (repère) : pas d'adresse formelle exigée. */
  landmark: string;
  person: { fullName: string; sex?: 'F' | 'M'; birthYear?: number; language: LanguageCode; photoSha256?: string; hasPhone: boolean };
  /** Téléphone d'un proche : canal de contact, jamais identité (§ 12, parcours sans téléphone). */
  proxyPhoneMasked?: string;
  declaredObjects: { type: DeclaredObjectType; description: string }[];
  consent: {
    method: ConsentMethod;
    summaryLanguage: LanguageCode;
    summaryAudioVersion: string;
    summaryReadAt: string;
    givenAt: string;
    voiceRecordingSha256?: string;
    witness?: { name: string; relation: string; idRef?: string };
    /** Horodatage serveur + mission : le consentement est lié à la mission (AC-INC-02). */
    missionId: string;
  };
  /** Attestation de l'agent : aucun paiement demandé ni reçu (AC-INC-02). */
  noPaymentAttested: true;
  status: 'CREE' | 'A_REVOIR' | 'DOUBLON_CONFIRME';
  duplicateCandidates: { taxpayerId: string; reason: string }[];
  review?: { decision: 'DISTINCT' | 'DOUBLON'; motif: string; by: string; at: string };
  taxpayerId?: string;
  iuc?: string;
  cardNumber?: string;
  pinSet: boolean;
}

export type CardStatus = 'ACTIVE' | 'BLOQUEE' | 'REVOQUEE';

export interface MosoloCard {
  id: string;
  number: string;
  taxpayerId: string;
  iuc: string;
  commune: string;
  holderDisplayName: string;
  photoSha256?: string;
  status: CardStatus;
  issuedAt: string;
  issuedBy: string;
  enrolmentId?: string;
  previousCardNumber?: string;
  replacedByNumber?: string;
  blockedAt?: string;
  blockedReason?: string;
  revokedAt?: string;
  /** Jeton signé (Ed25519) porté par le QR : ne contient aucune donnée personnelle. */
  qrToken: string;
  version: number;
}

export interface CardReissueRequest {
  id: string;
  cardNumber: string;
  motif: string;
  requestedBy: string;
  requestedAt: string;
  status: 'EN_ATTENTE' | 'APPROUVEE';
  approvedBy?: string;
  approvedAt?: string;
  newCardNumber?: string;
}

export const POINT_TYPES = ['GUICHET_BANCAIRE_MOSOLO', 'AGENCE_BANCAIRE', 'AGENT_MONNAIE_MOBILE', 'TPE_PRESTATAIRE'] as const;
export type PointType = (typeof POINT_TYPES)[number];
export type PointStatus = 'REFERENCE' | 'ACTIF' | 'SUSPENDU' | 'RETIRE';

export interface PaymentPoint {
  id: string;
  name: string;
  type: PointType;
  /** Établissement régulé (banque, émetteur de monnaie mobile, prestataire habilité). */
  operator: string;
  approval: { authority: string; reference: string; grantedOn: string };
  commune: string;
  quartier: string;
  address: string;
  lat: number;
  lon: number;
  hours: string;
  /** Plafonds par devise (contractuels, [EXEMPLE] en démonstration). */
  limits: { perTransaction: MoneyJSON[]; perDay: MoneyJSON[] };
  /** Délai contractuel de versement au compte public (heures après la fin du jour de caisse, heure de Kinshasa — jamais après la clôture). */
  settlementDelayHours: number;
  /** Guichet MOSOLO hôte (guichet bancaire partenaire au kiosque communal). */
  guichetId?: string;
  /** Identifiant de prestataire habilité utilisé pour la confirmation signée (circuit commun). */
  providerId: string;
  operatorUserIds: string[];
  status: PointStatus;
  referencedBy: string;
  referencedAt: string;
  activatedBy?: string;
  activatedAt?: string;
  suspension?: { by: string; at: string; motif: string; proposalId?: string };
  /** Demande de rétablissement en attente : un second membre du Trésor (R17), distinct du demandeur, décide (quatre yeux). */
  reinstatementRequest?: { by: string; at: string; motif: string };
  history: { at: string; by: string; action: string; motif?: string }[];
  demo: boolean;
}

export interface Collection {
  id: string;
  pointId: string;
  operatorUserId: string;
  paymentReference: string;
  paymentOrderId: string;
  obligationLabel: string;
  amount: MoneyJSON;
  providerTxnId: string;
  receiptNumber: string;
  receiptCode: string;
  /** Code court de vérification (5 caractères + 1 caractère de contrôle). */
  shortCode: string;
  cashDay: string;
  collectedAt: string;
  printCount: number;
}

export interface CashDay {
  id: string;
  pointId: string;
  day: string;
  /**
   * DECLAREE : versement déclaré par l'opérateur, en attente du relevé bancaire ; VERSEE UNIQUEMENT après
   * constatation au relevé du compte public (ligne du bordereau, montants) confirmée à quatre yeux par le Trésor.
   */
  status: 'OUVERTE' | 'CLOTUREE' | 'DECLAREE' | 'VERSEE' | 'ECART';
  /** Totaux attendus par devise (somme des encaissements confirmés du jour), figés à la clôture. */
  expected: MoneyJSON[];
  /** Attendus par compte public bénéficiaire (alias du coffre) et devise. */
  expectedByAccount: { accountAlias: string; amount: MoneyJSON }[];
  counted?: MoneyJSON[];
  closedAt?: string;
  closedBy?: string;
  deposit?: {
    bankSlipRef: string; lines: { accountAlias: string; amount: MoneyJSON }[]; depositedAt: string; declaredBy: string; declaredAt: string;
    /** Constatation au relevé bancaire : proposée par R17/R18, approuvée par un R17 distinct. */
    bankMatch?: {
      statementId: string; exceptionIds: string[]; valueDate: string; lines: { accountAlias: string; amount: MoneyJSON }[];
      proposedBy: string; proposedAt: string; approvedBy?: string; approvedAt?: string;
      /** Appariement automatique à l'import (bordereau, montants et comptes identiques) : aucune décision humaine requise. */
      auto?: true;
    };
  };
  exceptionIds: string[];
}

export type PointExceptionType = 'ECART_CAISSE' | 'ECART_VERSEMENT' | 'VERSEMENT_EN_RETARD' | 'COMPTE_NON_PUBLIC' | 'ENCAISSEMENT_NON_RAPPROCHE';

export interface PointException {
  id: string;
  pointId: string;
  day: string;
  type: PointExceptionType;
  detail: string;
  expected: MoneyJSON[];
  observed: MoneyJSON[];
  status: 'OUVERTE';
  openedAt: string;
}

/** Proposition de suspension : le système PROPOSE, le Trésor (R17) DÉCIDE avec motif (ARB-12). */
export interface SuspensionProposal {
  id: string;
  pointId: string;
  reason: PointExceptionType;
  detail: string;
  exceptionId: string;
  status: 'PROPOSEE' | 'DECIDEE_SUSPENSION' | 'ECARTEE';
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  motif?: string;
  /** Demande d'écartement en attente : un second membre du Trésor (R17), distinct du demandeur, décide (quatre yeux). */
  dismissalRequest?: { by: string; at: string; motif: string };
}

export interface GuichetMosolo {
  id: string;
  name: string;
  commune: string;
  address: string;
  hours: string;
  services: string[];
  bankPointId: string;
  demo: boolean;
}

/**
 * Pictogrammes normalisés (§ 13A.4, § H.7.4) : un pictogramme par type d'objet et par action,
 * identique sur l'application, l'avis imprimé, la plaque et le guichet ; la couleur est toujours doublée d'une forme.
 */
export const PICTOGRAMS = {
  PARCELLE: { label: 'Parcelle', shape: 'carre', color: 'palm', icon: 'grid' },
  LOGEMENT_LOUE: { label: 'Logement loué', shape: 'maison', color: 'flag-blue', icon: 'home' },
  COMMERCE: { label: 'Commerce', shape: 'etal', color: 'gold', icon: 'store' },
  VEHICULE: { label: 'Véhicule', shape: 'roue', color: 'navy', icon: 'car' },
  PANNEAU: { label: 'Panneau publicitaire', shape: 'rectangle', color: 'flag-red', icon: 'megaphone' },
  PAYER: { label: 'Payer', shape: 'cercle', color: 'palm', icon: 'cash' },
  CONTESTER: { label: 'Contester', shape: 'triangle', color: 'gold', icon: 'scale' },
  VERIFIER: { label: 'Vérifier', shape: 'bouclier', color: 'flag-blue', icon: 'shieldCheck' },
  ECHEANCE: { label: 'Échéance', shape: 'horloge', color: 'navy', icon: 'clock' },
  LIEU_PAIEMENT: { label: 'Où payer', shape: 'repere', color: 'navy', icon: 'pin' },
  ZERO_ESPECES_AGENT: { label: "Aucun agent ne reçoit d'argent", shape: 'barre', color: 'flag-red', icon: 'ban' },
  GRATUIT: { label: 'Enrôlement gratuit', shape: 'etoile', color: 'palm', icon: 'star' },
} as const;
export type PictogramCode = keyof typeof PICTOGRAMS;

/** Catégorie d'objet fiscal → pictogramme. */
export function pictogramForCategory(category: string): PictogramCode {
  switch (category) {
    case 'UNITE_LOCATIVE':
    case 'BATIMENT':
      return 'LOGEMENT_LOUE';
    case 'ACTIVITE':
      return 'COMMERCE';
    case 'VEHICULE':
      return 'VEHICULE';
    case 'PANNEAU':
      return 'PANNEAU';
    default:
      return 'PARCELLE';
  }
}

/** Jour de caisse (heure de Kinshasa) d'un instant. */
export function kinshasaDay(d: Date): string {
  return new Date(d.getTime() + KINSHASA_OFFSET_MS).toISOString().slice(0, 10);
}

export function kinshasaHour(d: Date): number {
  return new Date(d.getTime() + KINSHASA_OFFSET_MS).getUTCHours();
}

/** Masque un numéro de téléphone : indicatif + 2 derniers chiffres. */
export function maskMsisdn(msisdn: string): string {
  const s = msisdn.replace(/[^\d+]/g, '');
  return s.length > 6 ? `${s.slice(0, 4)}${'•'.repeat(s.length - 6)}${s.slice(-2)}` : '••••';
}

/** Nom affiché sur les canaux publics : prénom/nom réduits aux initiales (jamais le nom complet, AC-INC-03). */
export function initials(fullName: string): string {
  return fullName.split(/\s+/).filter(Boolean).map((p) => `${p[0]!.toUpperCase()}.`).join(' ');
}
