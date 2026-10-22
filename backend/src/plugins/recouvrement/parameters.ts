/**
 * Paramètres de procédure du recouvrement (§ 6.7, § 21, annexe H.12.1).
 * TOUTES les valeurs ci-dessous sont des VALEURS DE CONCEPTION, à remplacer par celles de l'Édit n° 005/2021
 * (procédure fiscale — J4) après lecture certifiée. Elles datent les étapes du parcours et ouvrent
 * l'éligibilité d'une PROPOSITION ; elles ne déclenchent jamais une mesure, une pénalité ou un blocage.
 */
import type { CurrencyCode } from '@mosolo/shared';

export const RECOVERY_PROCEDURE = {
  status: 'A_VERIFIER' as const,
  source: 'Valeurs de conception (annexe H.12.1) — Édit n° 005/2021 à lire et certifier',
  /** Rappels amiables avant échéance (jours avant). */
  reminderBeforeDays: [15, 3] as const,
  /** Avis d'échéance dépassée (jours après échéance). */
  overdueNoticeAfterDays: 1,
  /** Relance ciblée + offre d'assistance (jours après échéance). */
  followUpAfterDays: 15,
  /** Écart minimal entre deux rappels successifs (jours) : jamais de rafale. */
  minGapDays: 7,
  /** Constat et notification formelle : éligible à partir de J+30. */
  formalNoticeAfterDays: 30,
  /** Mise en demeure : éligible au plus tôt N jours après la notification formelle. */
  demandAfterFormalNoticeDays: 15,
  /** Délai laissé par la mise en demeure (paiement ou observations — droit d'être entendu). */
  demandResponseDays: 15,
  /** Prescription de l'action en recouvrement (le régime national prévoit cinq ans : applicabilité provinciale À VÉRIFIER, § 6.7). */
  limitationYears: 5,
  /** Alerte « prescription proche » (jours). */
  limitationWarningDays: 180,
  /** Échéancier : nombre maximal d'échéances et périodicité (jours). */
  maxInstallments: 12,
  installmentPeriodDays: 30,
  /** Défaillance « à constater » : échéance impayée depuis N jours (le constat reste une décision humaine). */
  installmentGraceDays: 10,
};

/**
 * Seuils de segmentation « grand redevable » — [EXEMPLE] seuils de démonstration, sans valeur réglementaire.
 * La segmentation n'a aucun effet : elle oriente le traitement proposé à un agent.
 */
export const LARGE_DEBTOR_THRESHOLD_EXAMPLE: Partial<Record<CurrencyCode, string>> = {
  USD: '5000.00',
  CDF: '14000000.00',
};

export const AGE_BANDS = [
  { code: '0-30', label: '0 à 30 jours', max: 30 },
  { code: '31-90', label: '31 à 90 jours', max: 90 },
  { code: '91-180', label: '91 à 180 jours', max: 180 },
  { code: '181-365', label: '181 à 365 jours', max: 365 },
  { code: '365+', label: 'Plus d’un an', max: Number.POSITIVE_INFINITY },
] as const;

export const SEGMENTS = {
  OUBLI: { label: 'Oubli', approach: 'Rappel simple, facilité de paiement' },
  FRICTION: { label: 'Friction', approach: 'Assistance, point de paiement proche' },
  CAPACITE_LIMITEE: { label: 'Capacité limitée', approach: 'Échéancier si la loi le permet ; orientation vers l’assistance' },
  CONTESTATION: { label: 'Contestation', approach: 'Orientation vers la réclamation ; aucune mesure pendant l’effet suspensif' },
  RETARD_REPETE: { label: 'Retards répétés', approach: 'Relance ciblée, explication, paiement simplifié' },
  REFUS_PRESUME: { label: 'Refus délibéré présumé (à vérifier)', approach: 'Procédure légale graduée, après vérification humaine' },
  GRAND_REDEVABLE: { label: 'Grand redevable', approach: 'Suivi dédié, contrôle contradictoire, décisions tracées' },
} as const;
export type SegmentCode = keyof typeof SEGMENTS;
