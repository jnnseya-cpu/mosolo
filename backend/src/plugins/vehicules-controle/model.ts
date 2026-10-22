/**
 * Chaîne véhicule (Cahier, chapitre 18 « La RFCK, le contrôle technique et la chaîne véhicule ») — référentiel du module.
 *
 * Trois modules ajoutés au catalogue (§ 11) : contrôle technique et vignette sécurisée, fourrières (enlèvement et
 * gardiennage), centres agréés et tiers de confiance. Ils se construisent PAR-DESSUS l'existant : objet véhicule du
 * socle, moteur de titres (vignette VIG, taxe TSC, licences), quitus fiscal, dépendances de services, circuit de
 * paiement vers le compte public, quittances, alertes et journal d'audit. Aucun tarif, taux ni seuil n'est inventé :
 * les redevances et frais sont des fiches du registre juridique au statut A_VERIFIER (aucun montant tant qu'une règle
 * ACTIVE n'existe pas) et les seuils d'analyse sont des valeurs « par défaut — à confirmer par le maître d'ouvrage ».
 */

// ─────────────────────────────── Numérotation des modules ───────────────────────────────

export const NOTE_NUMEROTATION = 'n° 59–61 dans le catalogue du maître d’ouvrage du 27/09/2026';
/**
 * Collision signalée au maître d'ouvrage : dans le document maître v3.0 (§ 11.2), les n° 82, 83 et 84 désignent déjà
 * le quitus fiscal numérique, les échéanciers et les remboursements. La numérotation 82–84 est appliquée sur
 * instruction ; elle reste « à arbitrer » (le code stable de chaque module fait foi dans la plateforme).
 */
export const COLLISION_NUMEROTATION = 'À arbitrer : les n° 82 à 84 désignent déjà, dans le document maître v3.0 (§ 11.2), le quitus fiscal numérique, les échéanciers et les remboursements. Le code stable du module fait foi.';

export const MODULES_VEHICULES = [
  { numero: 82, numeroMaitreOuvrage: 59, code: 'CT-VIGNETTE-SECURISEE', label: 'Contrôle technique et vignette sécurisée', entity: 'RFCK' },
  { numero: 83, numeroMaitreOuvrage: 60, code: 'FOURRIERES', label: 'Fourrières, enlèvement et gardiennage', entity: 'RFCK' },
  { numero: 84, numeroMaitreOuvrage: 61, code: 'CENTRES-AGREES', label: 'Centres agréés et tiers de confiance', entity: 'RFCK' },
] as const;

// ─────────────────────────────── Entité et texte ───────────────────────────────

export const RFCK = {
  id: 'RFCK',
  name: 'Régie des Fourrières et de Contrôle Technique des Véhicules de Kinshasa',
  shortName: 'RFCK',
  nature: 'Établissement public provincial',
  tutelleEntity: 'MIN-TRANSPORTS',
  tutelle: 'Ministère provincial des Transports et de la Mobilité urbaine',
} as const;

export const ARRETE_CT = {
  id: 'INS-ARRETE-CT-2025-11-12',
  title: 'Arrêté ministériel du 12 novembre 2025 réglementant le contrôle technique des véhicules automobiles et des remorques [texte À VÉRIFIER]',
  status: 'A_VERIFIER' as const,
  scope: [
    'Véhicules des particuliers',
    'Véhicules des entreprises',
    'Véhicules des missions diplomatiques et des organisations internationales',
    'Motos à deux, trois et quatre roues',
    'Véhicules administratifs de moins de 20 tonnes, sans exemption',
  ],
};

export const VEHICLE_CATEGORIES = [
  'PARTICULIER', 'ENTREPRISE', 'MISSION_DIPLOMATIQUE_OI', 'MOTO_2_ROUES', 'MOTO_3_ROUES', 'MOTO_4_ROUES', 'ADMINISTRATIF_MOINS_20T', 'REMORQUE',
] as const;
export type VehicleCategory = (typeof VEHICLE_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<VehicleCategory, string> = {
  PARTICULIER: 'Véhicule de particulier', ENTREPRISE: 'Véhicule d’entreprise', MISSION_DIPLOMATIQUE_OI: 'Mission diplomatique ou organisation internationale',
  MOTO_2_ROUES: 'Moto à deux roues', MOTO_3_ROUES: 'Moto à trois roues (tricycle)', MOTO_4_ROUES: 'Moto à quatre roues (quadricycle)',
  ADMINISTRATIF_MOINS_20T: 'Véhicule administratif de moins de 20 t (sans exemption)', REMORQUE: 'Remorque',
};

// ─────────────────────────────── Procès-verbal de contrôle technique ───────────────────────────────

/** Un champ structuré par point de l'arrêté (conforme / non conforme + note). */
export const CT_POINTS = [
  'ECLAIRAGE_SIGNALISATION', 'RETROVISEURS', 'AVERTISSEUR_SONORE', 'ESSUIE_GLACES', 'PARE_BRISE', 'VITRES', 'PNEUMATIQUES', 'NORMES_EMISSION',
  'RESERVOIR_CANALISATIONS', 'DIODES_NON_HOMOLOGUEES',
] as const;
export type CtPoint = (typeof CT_POINTS)[number];
export const CT_POINT_LABELS: Record<CtPoint, string> = {
  ECLAIRAGE_SIGNALISATION: 'Éclairage et signalisation',
  RETROVISEURS: 'Rétroviseurs intérieur et extérieur',
  AVERTISSEUR_SONORE: 'Avertisseur sonore',
  ESSUIE_GLACES: 'Essuie-glaces',
  PARE_BRISE: 'Pare-brise',
  VITRES: 'Vitres',
  PNEUMATIQUES: 'Pneumatiques',
  NORMES_EMISSION: 'Normes d’émission',
  RESERVOIR_CANALISATIONS: 'Réservoir et canalisations de carburant',
  DIODES_NON_HOMOLOGUEES: 'Éclairage à diodes non homologué (prohibé)',
};

export type CtResult = 'FAVORABLE' | 'DEFAVORABLE';
export interface CtPointResult { conforme: boolean; note?: string }

export interface ProcesVerbal {
  id: string;
  number: string;
  plate: string;
  category: VehicleCategory;
  centreId: string;
  /** Identifiant de l'inspecteur au centre (jamais un nom saisi librement). */
  inspecteur: string;
  startedAt: string;
  endedAt: string;
  points: Record<CtPoint, CtPointResult>;
  result: CtResult;
  echeance: string;
  transmittedAt: string;
  transmittedBy: string;
  channel: 'API_CENTRE' | 'FLUX_RFCK';
  supersedes?: string;
  supersededBy?: string;
  rectificationReason?: string;
  stickerNumber?: string;
  incoherence?: string;
  demo?: boolean;
}

// ─────────────────────────────── Vignettes sécurisées (autocollants numérotés) ───────────────────────────────

export type StickerStatus = 'EN_STOCK' | 'ATTRIBUEE' | 'ANNULEE' | 'REVOQUEE';
export interface SecureSticker {
  id: string;
  number: string;
  lotId: string;
  centreId: string;
  status: StickerStatus;
  plate?: string;
  pvId?: string;
  attributedAt?: string;
  attributedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  /** Anti-fraude (30/09/2026) : vignette vue sur un autre véhicule que le sien — signalée, vérification en cours. */
  suspectedCopy?: { at: string; observedPlate: string; by: string; caseId?: string };
  demo?: boolean;
}
export interface StickerLot { id: string; centreId: string; first: string; last: string; quantity: number; issuedBy: string; issuedAt: string; demo?: boolean }

// ─────────────────────────────── Mode courtoisie ───────────────────────────────

export interface CourtesyPeriod {
  id: string;
  categories: VehicleCategory[];
  communes: string[];
  from: string;
  to: string;
  authority: string;
  decisionRef: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
  endedEarly?: { by: string; at: string; reason: string };
  exemple?: boolean;
}

/** Calendrier annoncé 2026 : paramètres [EXEMPLE], jamais codés en dur dans un contrôle. */
export const PHASES_2026_EXEMPLE = [
  { code: 'DEUXIEME_ECHEANCE', label: '2e échéance [EXEMPLE]', date: '2026-04-01', statut: 'EXEMPLE — paramètre à confirmer par l’autorité compétente' },
  { code: 'BOUCLAGE_GENERALISE', label: 'Bouclage généralisé annoncé [EXEMPLE]', date: '2026-08-10', statut: 'EXEMPLE — paramètre à confirmer par l’autorité compétente' },
];

// ─────────────────────────────── Six lignes de recettes du véhicule ───────────────────────────────

export const REVENUE_LINES = [
  { code: 'VIGNETTE_FISCALE', label: 'Vignette fiscale', nature: 'Impôt provincial exclusif', administration: 'Régie fiscale (DGIPK)', legalBasis: 'Barème à certifier (J3)', beneficiary: 'Compte public de la régie fiscale (coffre des bénéficiaires)', credentialPrefix: 'VIG' },
  { code: 'TAXE_CIRCULATION', label: 'Taxe spéciale de circulation routière', nature: 'Taxe d’intérêt commun', administration: 'Régie fiscale (clé de partage légale)', legalBasis: 'Clé et barème à certifier (J1)', beneficiary: 'Compte public désigné par la clé légale de partage', credentialPrefix: 'TSC' },
  { code: 'REDEVANCE_CT', label: 'Redevance de contrôle technique', nature: 'Redevance', administration: 'RFCK et centres agréés', legalBasis: 'Arrêté du 12 novembre 2025 [À VÉRIFIER] — fiche RFCK-REDEVANCE-CT', beneficiary: 'Compte public de la RFCK (coffre des bénéficiaires)', credentialPrefix: null },
  { code: 'FRAIS_FOURRIERE', label: 'Frais d’enlèvement et de gardiennage', nature: 'Recette non fiscale', administration: 'RFCK', legalBasis: 'Acte à certifier — fiches RFCK-FRAIS-ENLEVEMENT et RFCK-FRAIS-GARDIENNAGE', beneficiary: 'Compte public de la RFCK (coffre des bénéficiaires)', credentialPrefix: null },
  { code: 'AUTORISATION_TRANSPORT', label: 'Taxe d’autorisation de transport', nature: 'Taxe', administration: 'Service des transports', legalBasis: 'Acte à certifier (J1)', beneficiary: 'Compte public du service des transports', credentialPrefix: 'LIC' },
  { code: 'AMENDES_CIRCULATION', label: 'Amendes et pénalités de circulation', nature: 'Amende', administration: 'Autorité verbalisatrice', legalBasis: 'Barème de l’acte ; décision motivée et contestable', beneficiary: 'Compte public de l’autorité verbalisatrice', credentialPrefix: null },
] as const;
export type RevenueLineCode = (typeof REVENUE_LINES)[number]['code'];

/** Fiches du registre juridique amorcées A_VERIFIER (table de taux vide : aucun montant). */
export const RULE_CODES = {
  redevanceCt: 'RFCK-REDEVANCE-CT',
  enlevement: 'RFCK-FRAIS-ENLEVEMENT',
  gardiennage: 'RFCK-FRAIS-GARDIENNAGE',
} as const;

// ─────────────────────────────── Fourrière ───────────────────────────────

export const FOURRIERE_STEPS = [
  { code: 'CONSTAT', label: 'Constat et immobilisation' },
  { code: 'ENTREE', label: 'Entrée en fourrière (inventaire contradictoire)' },
  { code: 'GARDIENNAGE', label: 'Gardiennage (compteur de jours)' },
  { code: 'LIQUIDATION', label: 'Liquidation détaillée' },
  { code: 'PAIEMENT', label: 'Paiement vers le compte public' },
  { code: 'MAINLEVEE_SORTIE', label: 'Mainlevée et sortie' },
  { code: 'DESTINATION_LEGALE', label: 'Destination légale (vente ou destruction)' },
] as const;

export const ENTRY_PHOTO_SLOTS = ['AVANT', 'ARRIERE', 'GAUCHE', 'DROITE', 'INTERIEUR'] as const;
export type EntryPhotoSlot = (typeof ENTRY_PHOTO_SLOTS)[number];
export const SLOT_LABELS: Record<EntryPhotoSlot, string> = { AVANT: 'Avant', ARRIERE: 'Arrière', GAUCHE: 'Côté gauche', DROITE: 'Côté droit', INTERIEUR: 'Intérieur et compteur' };

export interface PhotoRef { slot: string; sha256: string; bytes: number; at: string; lat?: number; lon?: number }

export type DossierStatus = 'CONSTATE' | 'ENLEVEMENT_DECIDE' | 'EN_GARDE' | 'SORTI' | 'DESTINATION_PROPOSEE' | 'DESTINATION_EXECUTEE' | 'CLASSE';

export interface RemovalDecision {
  id: string;
  dossierId: string;
  motifLegal: string;
  legalBasis: string;
  source: { kind: 'DECISION_AUTORITE' | 'CONSTAT_STATIONNEMENT' | 'RECOUVREMENT'; ref: string };
  decidedBy: string;
  decidedRole: string;
  decidedAt: string;
}

export interface FeeLine {
  code: 'ENLEVEMENT' | 'GARDIENNAGE' | 'AUTRES';
  label: string;
  ruleCode: string;
  status: 'LIQUIDEE' | 'ACTE_REQUIS' | 'PROPRIETAIRE_A_IDENTIFIER';
  obligationId?: string;
  amount?: { amount: string; currency: string };
  legalReference?: string;
  reason?: string;
  inputs?: Record<string, string>;
}

export interface FourriereDossier {
  id: string;
  plate: string;
  category?: VehicleCategory;
  taxpayerId?: string;
  objectId?: string;
  status: DossierStatus;
  constat: { by: string; at: string; motifLegal: string; gps: { lat: number; lon: number; accuracyM?: number }; commune: string; photos: PhotoRef[]; etat: string };
  decision?: RemovalDecision;
  entry?: {
    siteId: string; orderNumber: string; at: string; by: string; photos: PhotoRef[]; conditionReport: string;
    inventory: { label: string; quantity: number }[]; contradictoire: { kind: 'PROPRIETAIRE_PRESENT' | 'TEMOIN'; ref: string };
  };
  corrections: TimestampCorrection[];
  liquidation?: { at: string; by: string; days: number; lines: FeeLine[] };
  mainleveeDecision?: { by: string; at: string; motif: string; kind: 'DECISION_MOTIVEE' | 'CONTESTATION_ACCUEILLIE' };
  contestation?: { by: string; at: string; motif: string; status: 'EN_COURS' | 'ACCUEILLIE' | 'REJETEE'; decidedBy?: string; decidedAt?: string; decisionMotif?: string };
  exit?: { at: string; by: string; receiptNumber?: string; basis: 'QUITTANCE_APPARIEE' | 'DECISION_MOTIVEE'; photos: PhotoRef[]; collector: { pieceType: string; pieceHash: string; qualite: string } };
  disposal?: DisposalProposal;
  demo?: boolean;
}

export interface TimestampCorrection {
  id: string;
  field: 'entryAt' | 'exitAt';
  from: string;
  to: string;
  reason: string;
  proposedBy: string;
  proposedAt: string;
  status: 'PROPOSEE' | 'VALIDEE' | 'REJETEE';
  decidedBy?: string;
  decidedAt?: string;
}

export interface DisposalProposal {
  kind: 'VENTE' | 'DESTRUCTION';
  authorityDecisionRef: string;
  legalBasis: string;
  motif: string;
  notification: { sentAt: string; receivedAt: string; proofSha256: string };
  appealDeadline: string;
  proposedBy: string;
  proposedAt: string;
  validations: { level: 1 | 2; by: string; role: string; at: string }[];
  executedAt?: string;
  executedBy?: string;
}

export interface FourriereSite {
  id: string;
  objectId?: string;
  name: string;
  commune: string;
  lat: number;
  lon: number;
  capacity: number;
  operatorCentreId?: string;
  status: 'OUVERT' | 'FERME';
  demo?: boolean;
}

/** Maillon de la chaîne de garde (empreintes chaînées). */
export interface CustodyLink { id: string; dossierId: string; seq: number; at: string; by: string; step: string; details: Record<string, unknown>; prevHash: string; hash: string }

// ─────────────────────────────── Centres agréés et tiers de confiance ───────────────────────────────

export const CENTRE_KINDS = ['CONTROLE_TECHNIQUE', 'FOURRIERE_OPERATEUR', 'AUTRE_TIERS'] as const;
export type CentreKind = (typeof CENTRE_KINDS)[number];
export const CENTRE_KIND_LABELS: Record<CentreKind, string> = {
  CONTROLE_TECHNIQUE: 'Centre de contrôle technique', FOURRIERE_OPERATEUR: 'Opérateur de fourrière', AUTRE_TIERS: 'Autre tiers de confiance',
};
export const CENTRE_ACTIVITIES = ['CONTROLE_TECHNIQUE', 'EMISSION_VIGNETTES', 'GARDIENNAGE', 'ENROLEMENT'] as const;
export type CentreActivity = (typeof CENTRE_ACTIVITIES)[number];
export type CentreStatus = 'INVITE' | 'DOSSIER_DEPOSE' | 'DILIGENCE_FAITE' | 'PROPOSE' | 'AGREE' | 'SUSPENDU' | 'REFUSE';

export interface Centre {
  id: string;
  publicCode: string;
  kind: CentreKind;
  name: string;
  commune: string;
  lat: number;
  lon: number;
  objectId?: string;
  status: CentreStatus;
  categories: VehicleCategory[];
  activities: CentreActivity[];
  habilitation?: { from: string; to: string };
  quotas: { stockVignettes: number; inspectionsParJour: number };
  declaredHours: { open: string; close: string };
  invitation: { codeHash: string; by: string; at: string };
  dossier?: { legalExistence: string; quitusRef: string; conflictDeclaration: string; linksWithOfficials: string; at: string; by: string };
  diligence?: { checks: { code: string; label: string; ok: boolean; note?: string }[]; by: string; at: string };
  proposal?: { by: string; at: string; motif: string };
  decision?: { by: string; at: string; motif: string; approve: boolean };
  suspension?: { by: string; at: string; motif: string; legalRef: string };
  reinstatementRequest?: { by: string; at: string; motif: string };
  history: { at: string; from: CentreStatus | null; to: CentreStatus; by: string; motif?: string }[];
  exemple?: boolean;
}

// ─────────────────────────────── Interfaces RFCK ↔ MOSOLO ───────────────────────────────

export const INTERFACE_FLOWS = [
  { code: 'REGISTRE_VEHICULES', label: 'Registre des véhicules', direction: 'BIDIRECTIONNEL', cadence: 'Continu, avec rapprochement quotidien' },
  { code: 'PROCES_VERBAUX', label: 'Procès-verbaux de contrôle technique', direction: 'RFCK_VERS_MOSOLO', cadence: 'À l’établissement du procès-verbal' },
  { code: 'STATUT_VIGNETTE_TECHNIQUE', label: 'Statut de la vignette technique', direction: 'RFCK_VERS_MOSOLO', cadence: 'Temps réel' },
  { code: 'VERIFICATION_PUBLIQUE', label: 'Vérification publique fusionnée', direction: 'BIDIRECTIONNEL', cadence: 'Temps réel' },
  { code: 'STATUT_FISCAL', label: 'Statut fiscal du véhicule', direction: 'MOSOLO_VERS_RFCK', cadence: 'À la demande' },
  { code: 'RENDEZ_VOUS_ATTESTATIONS', label: 'Rendez-vous et attestations', direction: 'BIDIRECTIONNEL', cadence: 'Temps réel' },
  { code: 'MOUVEMENTS_FOURRIERE', label: 'Mouvements de fourrière', direction: 'RFCK_VERS_MOSOLO', cadence: 'Temps réel' },
  { code: 'PAIEMENTS_QUITTANCES', label: 'Paiements et quittances', direction: 'MOSOLO_VERS_RFCK', cadence: 'Temps réel' },
  { code: 'CENTRES_STOCKS', label: 'Centres et stocks de vignettes', direction: 'RFCK_VERS_MOSOLO', cadence: 'Quotidien' },
  { code: 'ALERTES_FRAUDE', label: 'Alertes de fraude', direction: 'BIDIRECTIONNEL', cadence: 'Temps réel' },
] as const;
export type FlowCode = (typeof INTERFACE_FLOWS)[number]['code'];

export const INTEGRATION_STEPS = [
  { code: 'CONVENTION', label: 'Convention RFCK – Ville signée', conditions: ['Au moins une convention de flux enregistrée et déclarée conforme par une seconde personne'] },
  { code: 'DOMAINE_OFFICIEL', label: 'Domaine officiel de vérification', conditions: ['Domaine désigné, détenu par la Ville et validé par une seconde personne'] },
  { code: 'REPRISE_REGISTRES', label: 'Reprise des registres', conditions: ['Lot de reprise contrôlé par échantillon (seconde personne)', 'Compteurs publiés confirmés ou retirés'] },
  { code: 'AFFICHAGE_UNIFIE', label: 'Affichage unifié au contrôle', conditions: ['Scan unique en service (plaque, vignette fiscale, vignette technique)', 'Au moins un contrôle enregistré par le scan unique'] },
  { code: 'PAIEMENT_ELECTRONIQUE', label: 'Paiement électronique', conditions: ['Fiche de frais de fourrière ACTIVE au registre', 'Au moins une sortie de fourrière sur quittance appariée'] },
  { code: 'FERMETURE_ESPECES', label: 'Fermeture du circuit espèces', conditions: ['Attestation motivée du Trésor : aucun encaissement en espèces par la RFCK, ses gestionnaires, caissières ou pointeurs'] },
  { code: 'ANALYTIQUE', label: 'Analytique des centres', conditions: ['Au moins 12 semaines d’historique de procès-verbaux'] },
] as const;
export type StepCode = (typeof INTEGRATION_STEPS)[number]['code'];

export const DOMAIN_REQUIREMENTS = [
  { code: 'D1', label: 'Domaine officiel de vérification désigné, détenu par la Ville' },
  { code: 'D2', label: 'Le QR encode l’adresse complète de vérification sur ce domaine (jamais un tiers ni une redirection)' },
  { code: 'D3', label: 'La vérification refuse ou signale tout QR pointant vers un autre domaine' },
  { code: 'D4', label: 'Registre des anciens domaines, conservés en redirection pour une période fixée' },
  { code: 'D5', label: 'Veille des domaines ressemblants, avec signalement et retrait' },
  { code: 'D6', label: 'Chiffres publiés par la RFCK conservés « À VÉRIFIER », jamais comme base de référence' },
] as const;

/** Chiffres publiés par la RFCK : sources à vérifier, jamais une base de référence. */
export const RFCK_PUBLISHED_FIGURES = [
  { code: 'VEHICULES_CONTROLES', label: 'Véhicules contrôlés (chiffre publié par la RFCK)', value: '2 500', status: 'A_VERIFIER' as const },
  { code: 'TAUX_PUBLIE', label: 'Taux publié par la RFCK', value: '95 %', status: 'A_VERIFIER' as const },
];

// ─────────────────────────────── Seuils (par défaut — à confirmer) ───────────────────────────────

/** Délai maximal entre la fin du contrôle et la transmission du procès-verbal (au-delà : ressaisie refusée). */
export const PV_TRANSMISSION_MAX_MINUTES = 120;
/** Garde en fourrière au-delà de laquelle une alerte est levée (jamais une mesure). */
export const FOURRIERE_ALERTE_GARDE_JOURS = 30;
/** Analytique des centres (alertes seulement, jamais une suspension). */
export const ANALYTIQUE_PARAMS = {
  tauxReussiteAlertePct: 98,
  echantillonMin: 10,
  dureeInspectionMinMinutes: 10,
  serieMemeInspecteur: 8,
  serieFenetreMinutes: 60,
};
/** Taille de l'échantillon contrôlé d'un lot de reprise. */
export const REPRISE_ECHANTILLON = 5;
/** Profondeur d'historique exigée avant l'analytique (semaines). */
export const ANALYTIQUE_HISTORIQUE_SEMAINES = 12;

export const DEFAULT_NOTICE = 'Valeur par défaut — à confirmer par le maître d’ouvrage.';
