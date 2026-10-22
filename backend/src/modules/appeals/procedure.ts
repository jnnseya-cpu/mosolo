/**
 * Paramètres de procédure des réclamations (§ 6.7, § 22 ; modules 37 et 36).
 * VALEURS DE CONCEPTION, à remplacer par celles de l'Édit n° 005/2021 (procédure fiscale — J4) après lecture
 * certifiée : aucune n'a de valeur juridique. Elles servent au décompte affiché et au suivi du délai de réponse ;
 * elles ne rendent jamais une réclamation irrecevable d'office (la recevabilité est une décision humaine motivée).
 */
export const APPEAL_PROCEDURE = {
  status: 'A_VERIFIER' as const,
  source: 'Valeurs de conception — Édit n° 005/2021 (procédure fiscale) à lire et certifier',
  /** Délai d'introduction d'une réclamation après la notification de l'obligation (jours calendaires). */
  filingDelayDays: 30,
  /** Délai de décision de l'administration après dépôt (jours calendaires). */
  decisionDelayDays: 60,
  /** Seuil d'alerte « décision attendue bientôt » (jours restants). */
  approachingDays: 7,
  /** Voie suivante après décision de l'administration. */
  nextRemedy: {
    hierarchical: 'Recours hiérarchique auprès du Ministre provincial des Finances [autorité et délai À VÉRIFIER]',
    judicial: 'Recours juridictionnel devant la juridiction compétente [délai À VÉRIFIER]',
  },
  /** L'effet suspensif est demandé par le contribuable et décidé par l'autorité (jamais accordé d'office). */
  suspensiveEffect: 'SUR_DEMANDE_DECISION_AUTORITE' as const,
};

export const APPEAL_TYPES = [
  'BIEN_NON_DETENU', 'ACTIVITE_FERMEE', 'VEHICULE_VENDU', 'INFORMATION_ERRONEE', 'DOUBLE_IMPOSITION', 'MONTANT_ERRONE', 'AUTRE',
] as const;
export type AppealType = (typeof APPEAL_TYPES)[number];

export const APPEAL_TYPE_LABELS: Record<AppealType, string> = {
  BIEN_NON_DETENU: 'Bien non détenu',
  ACTIVITE_FERMEE: 'Activité fermée',
  VEHICULE_VENDU: 'Véhicule vendu',
  INFORMATION_ERRONEE: 'Information erronée',
  DOUBLE_IMPOSITION: 'Double imposition',
  MONTANT_ERRONE: 'Montant erroné',
  AUTRE: 'Autre motif',
};
