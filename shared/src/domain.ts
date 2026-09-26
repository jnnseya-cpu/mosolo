/** Types et états du domaine partagés entre backend et frontend. */

/** Statuts probants (§ 16.2) */
export type ProbativeStatus = 'DECLARE' | 'OBSERVE' | 'VERIFIE' | 'CONTESTE';

/** Situation déclarée à une adresse (§ 16.3) */
export const RESIDENTIAL_SITUATIONS = [
  'owner_occupier', 'landlord', 'tenant', 'subtenant', 'authorised_occupier', 'property_manager', 'business_tenant', 'other',
] as const;
export type ResidentialSituation = (typeof RESIDENTIAL_SITUATIONS)[number];

/** Niveaux de vérification (§ 9.3) */
export type VerificationLevel = 'N0' | 'N0A' | 'N1' | 'N2' | 'N3';

/** Catégories de recettes (§ 6.11) */
export type RevenueCategory =
  | 'IMPOT_PROVINCIAL' | 'INTERET_COMMUN' | 'PROVINCIAL_SPECIFIQUE' | 'RECETTE_ETD' | 'RECETTE_CENTRALE'
  | 'PARTAGEE' | 'DROIT_ADMINISTRATIF' | 'REDEVANCE_SERVICE' | 'PENALITE' | 'CONCESSION_DOMANIALE'
  | 'RECETTE_COMMERCIALE' | 'ACTE_REQUIS';

/** Cycle de vie d'une règle (§ 6.12) */
export type RuleStatus =
  | 'A_VERIFIER' | 'BROUILLON' | 'REVUE_JURIDIQUE' | 'REVUE_FINANCIERE' | 'APPROUVEE' | 'PUBLIEE'
  | 'ACTIVE' | 'SUSPENDUE' | 'EXPIREE' | 'ABROGEE' | 'ARCHIVEE';

/** Statut d'un instrument juridique */
export type LegalInstrumentStatus = 'A_VERIFIER' | 'EN_VIGUEUR' | 'MODIFIE' | 'ABROGE';

/** États de l'obligation */
export type ObligationStatus =
  | 'EMISE' | 'EXIGIBLE' | 'PARTIELLEMENT_PAYEE' | 'SOLDEE' | 'EN_RETARD' | 'CONTESTEE' | 'ANNULEE' | 'ADMISE_EN_NON_VALEUR';

/** États du paiement (§ 18.4) */
export type PaymentStatus =
  | 'INITIE' | 'CONFIRME' | 'REGLE' | 'RAPPROCHE' | 'ECHOUE' | 'DOUBLON' | 'CONTREPASSE' | 'REMBOURSE' | 'CONTESTE';

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  INITIE: ['CONFIRME', 'ECHOUE'],
  CONFIRME: ['REGLE', 'CONTREPASSE', 'DOUBLON'],
  REGLE: ['RAPPROCHE', 'CONTESTE'],
  RAPPROCHE: ['CONTESTE', 'REMBOURSE'],
  CONTESTE: ['RAPPROCHE', 'CONTREPASSE'],
  DOUBLON: ['REMBOURSE'],
  ECHOUE: [],
  CONTREPASSE: [],
  REMBOURSE: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Statut d'une quittance (§ 19) */
export type ReceiptStatus = 'PROVISOIRE' | 'DEFINITIVE' | 'ANNULEE' | 'REMPLACEE' | 'SUSPECTE' | 'CONTREPASSEE' | 'REMBOURSEE';

/** Résultat de vérification publique (§ 19.2) */
export type PublicReceiptCheck = 'VALID' | 'PENDING' | 'CANCELLED' | 'REPLACED' | 'FRAUD_SUSPECTED' | 'REVERSED' | 'REFUNDED' | 'UNKNOWN';

/**
 * Échelle unifiée de la recette (§ 26.1, Cahier v2 : onze états) : potentiel estimé, assiette vérifiée, liquidé,
 * exigible, en retard, paiement initié, confirmé, réglé en compte public, rapproché, comptabilisé, disponible.
 * Les niveaux ne s'additionnent jamais entre eux. Le montant contesté est un indicateur séparé, hors échelle.
 */
export const REVENUE_LADDER = [
  'potential', 'verified_base', 'assessed', 'due', 'overdue',
  'initiated', 'confirmed', 'settled', 'reconciled', 'recorded', 'available',
] as const;
export type RevenueLadderLevel = (typeof REVENUE_LADDER)[number];

/** Couleurs de situation fiscale sur la carte (§ 16.6) */
export type MapStatusColor = 'green' | 'amber' | 'red' | 'grey' | 'blue';

/** Rôles (§ 12.3) — codes stables */
export const ROLES = {
  R01: 'Gouverneur', R02: 'Directeur de cabinet', R03: 'Secrétaire général', R04: 'Ministre provincial',
  R05: 'Ministre provincial des Finances', R06: 'Directeur général de régie', R07: 'Chef de service de régie',
  R08: "Administrateur d'entité", R09: 'Superviseur terrain', R10: 'Agent de terrain', R11: 'Contrôleur',
  R12: 'Agent de guichet', R13: 'Juriste rédacteur', R14: 'Juriste vérificateur', R15: 'Validateur financier',
  R16: 'Autorité de publication', R17: 'Comptable public / Trésor', R18: 'Analyste de rapprochement',
  R19: 'Gestionnaire du coffre des bénéficiaires', R20: 'Agent de contentieux', R21: 'Autorité de décision contentieuse',
  R22: 'Auditeur interne', R23: 'Auditeur externe', R24: 'Enquêteur anti-fraude', R25: 'Délégué à la protection des données',
  R26: 'Super-administrateur de la plateforme', R27: "Ingénieur d'exploitation", R28: 'Responsable sécurité',
  R29: 'Gestionnaire des modèles IA', R30: 'Contribuable', R31: 'Mandataire', R32: 'Point de paiement agréé',
  R33: 'Partenaire bancaire / monnaie mobile', R34: 'Partenaire de données', R35: 'Sous-traitant terrain',
  R36: 'Observateur société civile', R37: 'Service vérificateur du quitus',
} as const;
export type RoleCode = keyof typeof ROLES;

/** Paires de rôles incompatibles (§ 12.5) */
export const INCOMPATIBLE_ROLES: [RoleCode, RoleCode][] = [
  ['R13', 'R14'], ['R13', 'R15'], ['R13', 'R16'], ['R14', 'R16'],
  ['R10', 'R17'], ['R19', 'R17'], ['R26', 'R17'], ['R26', 'R19'], ['R26', 'R13'], ['R26', 'R06'],
  ['R22', 'R17'], ['R22', 'R10'], ['R22', 'R06'], ['R29', 'R06'],
];

export function hasIncompatibility(roles: RoleCode[]): [RoleCode, RoleCode] | null {
  const set = new Set(roles);
  return INCOMPATIBLE_ROLES.find(([a, b]) => set.has(a) && set.has(b)) ?? null;
}

/**
 * Rattachement territorial d'une recette (§ 20.3). Règle : la commune du FAIT GÉNÉRATEUR — lieu de l'objet taxé
 * (parcelle, unité locative, étal, dispositif, établissement, chantier) ou lieu où le service est consommé
 * (zone de stationnement, station de départ d'un ticket). Jamais l'adresse du contribuable ni le lieu du paiement.
 * Figé à la liquidation ; une correction de localisation passe par rectification tracée, jamais par réécriture.
 */
export const ATTRIBUTION_BASES = ['LIEU_OBJET', 'ZONE_SERVICE', 'STATION_DEPART', 'NON_LOCALISE'] as const;
export type AttributionBasis = (typeof ATTRIBUTION_BASES)[number];

export interface TerritorialAttribution {
  /** null si le lieu n'est pas établi : la recette est alors « non attribuée », jamais devinée. */
  commune: string | null;
  quartier?: string;
  basis: AttributionBasis;
  /** Objet, zone ou station d'où provient le rattachement. */
  sourceId?: string;
  attributedAt: string;
}

/** Libellé de regroupement d'une recette sans lieu établi. */
export const UNATTRIBUTED_COMMUNE = 'NON_ATTRIBUE';
