/**
 * Apprentissage des utilisateurs et environnement de travail (Cahier § 24) : publics, contenus versionnés (fiches
 * d'aide contextuelle et modules), épreuves, évaluations, certificats et paramètres PAR DÉFAUT.
 *
 * Les seuils ci-dessous sont des valeurs PAR DÉFAUT — à confirmer par le maître d'ouvrage : ils sont inscrits au
 * registre des seuils (integrite/gouvernance/parametres.ts) et jamais présentés comme définitifs. Seule la
 * périodicité annuelle de la recertification des contrôleurs est donnée par le Cahier (§ 24).
 */
import type { RoleCode } from '@mosolo/shared';

/** Publics du tableau du § 24. */
export const PROFILS = ['CONTRIBUABLE', 'RECENSEUR', 'CONTROLEUR', 'GUICHET', 'CADRE', 'FINANCES', 'ADMINISTRATEUR'] as const;
export type Profil = (typeof PROFILS)[number];
/** Publics soumis à certification (le contribuable n'est jamais « certifié » : sa compréhension est mesurée). */
export const PROFILS_CERTIFIES = PROFILS.filter((p) => p !== 'CONTRIBUABLE') as Exclude<Profil, 'CONTRIBUABLE'>[];
export type ProfilCertifie = (typeof PROFILS_CERTIFIES)[number];

export const PROFIL_LIBELLE: Record<Profil, string> = {
  CONTRIBUABLE: 'Contribuables', RECENSEUR: 'Agents recenseurs', CONTROLEUR: 'Contrôleurs', GUICHET: 'Agents de guichet',
  CADRE: 'Cadres et superviseurs', FINANCES: 'Finances et trésorerie', ADMINISTRATEUR: 'Administrateurs',
};

/** Rôles de chaque public (un compte peut relever de plusieurs publics). */
export const PROFIL_ROLES: Record<Profil, RoleCode[]> = {
  CONTRIBUABLE: ['R30', 'R31'],
  RECENSEUR: ['R10', 'R35'],
  CONTROLEUR: ['R11'],
  GUICHET: ['R12'],
  CADRE: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R09'],
  FINANCES: ['R17', 'R18', 'R19'],
  ADMINISTRATEUR: ['R08', 'R26', 'R27', 'R28'],
};
export const profilsDe = (roles: RoleCode[]): Profil[] => PROFILS.filter((p) => PROFIL_ROLES[p].some((r) => roles.includes(r)));

/** Mode de validation du tableau du § 24 (colonne « Validation »). */
export type ModeValidation = 'TAUX_DOSSIERS_COMPLETS' | 'CERTIFICATION_AVANT_AFFECTATION' | 'RECERTIFICATION_ANNUELLE' | 'EVALUATION_CONTINUE'
  | 'RESULTATS_VERIFIES' | 'CONTROLE_ECHANTILLON' | 'HABILITATION_RENOUVELABLE';
export const MODE_VALIDATION: Record<Profil, { mode: ModeValidation; libelle: string; contenu: string }> = {
  CONTRIBUABLE: { mode: 'TAUX_DOSSIERS_COMPLETS', libelle: 'Compréhension mesurée par le taux de dossiers complets du premier coup', contenu: 'Explications courtes en français et en lingala, guides de paiement, droits et recours' },
  RECENSEUR: { mode: 'CERTIFICATION_AVANT_AFFECTATION', libelle: 'Certification avant affectation', contenu: 'Protocole de recensement, photographie, géolocalisation, déontologie' },
  CONTROLEUR: { mode: 'RECERTIFICATION_ANNUELLE', libelle: 'Certification et recertification annuelle', contenu: 'Procédure de constat, rédaction, droits du contribuable, usage de la preuve' },
  GUICHET: { mode: 'EVALUATION_CONTINUE', libelle: 'Évaluation continue', contenu: 'Accompagnement sans manipulation d’espèces, assistance au paiement' },
  CADRE: { mode: 'RESULTATS_VERIFIES', libelle: 'Évaluation par résultats vérifiés', contenu: 'Pilotage par indicateurs, traitement des exceptions, éthique' },
  FINANCES: { mode: 'CONTROLE_ECHANTILLON', libelle: 'Contrôle par échantillon', contenu: 'Rapprochement, imputation, gestion des écarts' },
  ADMINISTRATEUR: { mode: 'HABILITATION_RENOUVELABLE', libelle: 'Habilitation renouvelable', contenu: 'Sécurité, gestion des accès, gestion des incidents' },
};

/** Type d'évaluation humaine exigé par public (en plus des épreuves des modules). */
export type TypeEvaluation = 'PRATIQUE' | 'CONTINUE' | 'RESULTATS_VERIFIES' | 'ECHANTILLON' | 'HABILITATION';
export const EVALUATION_EXIGEE: Record<ProfilCertifie, { type: TypeEvaluation; libelle: string }> = {
  RECENSEUR: { type: 'PRATIQUE', libelle: 'Vérification pratique sur le terrain (protocole, photo, position)' },
  CONTROLEUR: { type: 'PRATIQUE', libelle: 'Vérification pratique (constat rédigé, droits du contribuable, preuve)' },
  GUICHET: { type: 'CONTINUE', libelle: 'Évaluation continue au guichet (accompagnement, aucune espèce)' },
  CADRE: { type: 'RESULTATS_VERIFIES', libelle: 'Évaluation sur résultats vérifiés (indicateurs existants, lecture seule)' },
  FINANCES: { type: 'ECHANTILLON', libelle: 'Contrôle d’un échantillon d’actes (rapprochement, imputation, écarts)' },
  ADMINISTRATEUR: { type: 'HABILITATION', libelle: 'Vérification de l’habilitation (sécurité, accès, incidents)' },
};

/** Évaluateurs admis par public (personne distincte de l'évalué, contrôlée par ailleurs). */
export const EVALUATEURS: Record<ProfilCertifie, RoleCode[]> = {
  RECENSEUR: ['R06', 'R07', 'R08', 'R09'],
  CONTROLEUR: ['R06', 'R07', 'R08'],
  GUICHET: ['R06', 'R07', 'R08', 'R09'],
  CADRE: ['R06', 'R07', 'R08'],
  FINANCES: ['R17', 'R06'],
  ADMINISTRATEUR: ['R28', 'R26'],
};

// ─────────────── paramètres PAR DÉFAUT — à confirmer par le maître d'ouvrage (registre des seuils) ───────────────

/** Score minimal d'une épreuve de module (en %). PAR DÉFAUT. */
export const SEUIL_REUSSITE_EPREUVE_PCT = 80;
/**
 * Durée de validité d'un certificat, par public (jours). PAR DÉFAUT, sauf la périodicité annuelle des contrôleurs
 * (Cahier § 24 « recertification annuelle »).
 */
export const VALIDITE_CERTIFICAT_JOURS: Record<ProfilCertifie, number> = {
  RECENSEUR: 365, CONTROLEUR: 365, GUICHET: 180, CADRE: 365, FINANCES: 365, ADMINISTRATEUR: 365,
};
/** Évaluation continue du guichet : ancienneté maximale de la dernière évaluation conforme (jours). PAR DÉFAUT. */
export const EVALUATION_CONTINUE_INTERVALLE_JOURS = 90;
/** Contrôle par échantillon (finances) : nombre d'actes tirés. PAR DÉFAUT. */
export const ECHANTILLON_TAILLE = 10;
/** Contrôle par échantillon : part minimale d'actes conformes (en %). PAR DÉFAUT. */
export const ECHANTILLON_CONFORMITE_MIN_PCT = 90;
/** Préfixes d'actions d'audit retenus pour l'échantillon des finances (actes professionnels uniquement). */
export const ACTES_FINANCES = ['reconciliation.', 'ledger.', 'treasury.', 'settlement.', 'beneficiary.'];

export const STATUT_PARAMETRE = 'PAR_DEFAUT — à confirmer par le maître d’ouvrage';

/**
 * Garde de confidentialité (§ 24) : ce que le module enregistre, et ce qu'il n'enregistre JAMAIS.
 * Affichée à l'écran et renvoyée par l'API.
 */
export const CONFIDENTIALITE = {
  principe: 'Le suivi d’activité est limité à ce qui est nécessaire à la sécurité et à l’exploitation : traçabilité des actes professionnels, pas surveillance permanente des personnes. Les indicateurs individuels portent sur des résultats vérifiables, pas sur des mesures intrusives.',
  enregistre: [
    'Les épreuves soumises (module, version, score, réussite) — un acte volontaire de la personne.',
    'Les évaluations décidées par un évaluateur distinct (type, résultat, motif, références d’actes ou d’indicateurs).',
    'Les certificats (délivrance, validité, retrait motivé) et les publications de contenus (quatre yeux).',
  ],
  jamais: [
    'Aucun temps d’écran, aucun suivi des clics, des pages vues ni de la durée de lecture.',
    'Aucune géolocalisation, aucune capture d’écran ou de caméra, aucun enregistrement de frappe.',
    'Aucun classement nominatif des personnes ; les indicateurs d’ensemble sont agrégés par public.',
    'Aucune sanction automatique : un résultat insuffisant ouvre une proposition de reprise de formation, décidée par une personne.',
  ],
} as const;

// ───────────────────────────────────────────── contenus versionnés ─────────────────────────────────────────────

/** FICHE (aide contextuelle), MODULE (micro-apprentissage + épreuve), PROCEDURE (base de procédures versionnée, module 50). */
export type TypeContenu = 'FICHE' | 'MODULE' | 'PROCEDURE';
export type StatutVersion = 'BROUILLON' | 'PROPOSEE' | 'PUBLIEE' | 'REFUSEE' | 'REMPLACEE';

export interface Question {
  id: string;
  enonce: string;
  choix: string[];
  /** Index de la bonne réponse — JAMAIS renvoyé à l'apprenant. */
  bonne: number;
}

export interface VersionContenu {
  version: number;
  titre: string;
  /** Texte en français simple (langue de référence). */
  corps: string;
  /** Traduction lingala : toujours un BROUILLON à relire par un locuteur avant tout usage opposable. */
  lingala?: { titre: string; corps: string; statut: 'BROUILLON' };
  /** Modules : micro-leçons (clés des fiches), épreuve et vérification pratique attendue. */
  lecons?: string[];
  epreuve?: Question[];
  controlePratique?: string;
  statut: StatutVersion;
  auteur: string;
  creeLe: string;
  proposition?: { par: string; le: string };
  decision?: { par: string; le: string; approuve: boolean; motif: string };
}

export interface Contenu {
  id: string;
  type: TypeContenu;
  /** Fiche : clé d'écran ou d'action (ex. `terrain.habilitation`) ; module : code du module. */
  cle: string;
  publics: Profil[];
  versions: VersionContenu[];
  demo?: boolean;
}

export interface Epreuve {
  id: string;
  userId: string;
  moduleId: string;
  version: number;
  scorePct: number;
  reussie: boolean;
  le: string;
}

export interface Evaluation {
  id: string;
  userId: string;
  profil: ProfilCertifie;
  type: TypeEvaluation;
  resultat: 'CONFORME' | 'NON_CONFORME';
  observations: string;
  /** Références d'actes professionnels ou d'indicateurs existants (lecture seule). */
  references: string[];
  echantillon?: { taille: number; conformes: number; conformitePct: number; seuilPct: number };
  evaluateur: string;
  le: string;
  demo?: boolean;
}

export interface Certificat {
  id: string;
  userId: string;
  profil: ProfilCertifie;
  delivreLe: string;
  valableJusquau: string;
  delivrePar: string;
  fondement: { epreuves: string[]; evaluations: string[]; note?: string };
  statut: 'DELIVRE' | 'RETIRE';
  retrait?: { par: string; le: string; motif: string };
  demo?: boolean;
}

/** Liens en lecture seule vers les indicateurs EXISTANTS (évaluation des cadres par résultats vérifiés). */
export const LIENS_INDICATEURS = [
  { libelle: 'Indicateurs de pilotage', chemin: '/pilotage/indicateurs' },
  { libelle: 'Tableaux par profil', chemin: '/pilotage/tableaux' },
  { libelle: 'Supervision terrain (production vérifiée)', chemin: '/terrain/supervision' },
] as const;
