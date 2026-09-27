/**
 * Registre des seuils anti-fraude : chaque paramètre qui conditionne un contrôle anti-fraude, avec sa valeur, son
 * unité, son fichier source et son statut (« PAR_DEFAUT — à confirmer par le maître d'ouvrage » tant qu'aucun acte
 * n'a été enregistré).
 *
 * Deux natures :
 *  - CODE : la valeur vit dans le code du module (constante importée ici, JAMAIS recopiée quand elle est exportée) ;
 *    le registre en enregistre la confirmation par acte, il ne la modifie pas (une modification passe par une
 *    livraison logicielle puis une confirmation ici). Les constantes non exportées sont recopiées ET un test vérifie
 *    l'égalité avec le fichier source (toute dérive est détectée).
 *  - REGISTRE : paramètres propres à ce module (détection de collusion, rotation obligatoire, contrôle des clés) ;
 *    leur valeur en vigueur est celle du registre, modifiable par le circuit à deux personnes.
 *
 * Aucune valeur n'est présentée comme définitive : toutes restent des valeurs par défaut à confirmer.
 */
import { BASE_OVERRIDE_TOLERANCE_PCT } from '../../../modules/assessment/service.js';
import { SHORT_SUSPENSION_DAYS } from '../../../modules/rules/service.js';
import { COOLING_OFF_HOURS, REQUIRED_VAULT_APPROVALS } from '../../../modules/vault/service.js';
import { OTP_MAX_ATTEMPTS } from '../../acces/service.js';
import { ASSIST_MAX_ACCURACY_M, ASSIST_ON_SITE_M } from '../../canaux/assisted.js';
import { MAX_PIN_ATTEMPTS, VERIFY_MAX_FAILURES_PER_WINDOW, VERIFY_MAX_PER_WINDOW } from '../../canaux/model.js';
import { BANK_CONFIRMATION_GRACE_HOURS, UNRECONCILED_AGING_DAYS } from '../../canaux/points.js';
import { NEARBY_MAX_ACCURACY_M, NEARBY_MAX_RADIUS_M } from '../../fiscal/nearby.js';
import { MULTIPLE_METERS_MIN, NEW_BUILDING_NO_UNIT_MONTHS } from '../../fiscal/anomalies.js';
import { AGENT_COMMISSION_PCT, CLOCK_SKEW_WARN_SECONDS, PHOTO_WINDOW_MINUTES, PRESENCE_MAX_ACCURACY_M, PRESENCE_MAX_DISTANCE_M } from '../../parking/field.js';
import { AD_NEARBY_MAX_ACCURACY_M, AD_NEARBY_MAX_RADIUS_M } from '../../publicite/terrain.js';
import { ATTRIBUTION_WINDOWS_MINUTES, DECLARED_TIME_TOLERANCE_MINUTES } from '../../sanctions/commissions.js';
import { COUNTER_CHECK_RATE_PER_10K } from '../../sanctions/counterchecks.js';
import { MAX_CODE_ATTEMPTS, MAX_PASSWORD_FAILURES } from '../../socle/service.js';
import { DEFAULT_GPS_TOLERANCE_M, MIN_SAMPLE_RATE } from '../../terrain/model.js';
import { DYNAMIC_GRACE_SECONDS, DYNAMIC_WINDOW_SECONDS } from '../../titres/tokens.js';
import { EXCEPTION_SLA_HOURS, PROVIDER_SETTLEMENT_DELAY_DAYS, REFUND_EXTRA_APPROVAL_THRESHOLDS, SUSPENSE_MAX_DAYS, SUSPENSE_SLA_DAYS } from '../../tresor/service.js';
import { DETECTION_PARAMS } from '../service.js';
import {
  ECHANTILLON_CONFORMITE_MIN_PCT, ECHANTILLON_TAILLE, EVALUATION_CONTINUE_INTERVALLE_JOURS, SEUIL_REUSSITE_EPREUVE_PCT, VALIDITE_CERTIFICAT_JOURS,
} from '../../apprentissage/model.js';
import {
  REPARTITION_DUREE_ANS, REPARTITION_NOMBRE_FLUX, REPARTITION_PART_AGENTS_PCT, REPARTITION_PART_GOUVERNEMENT_PCT, REPARTITION_PART_NSEYA_PCT,
  REPARTITION_PART_TUTELLE_PCT,
} from '../../pilotage/repartition/model.js';
import { ATYPICAL_CANCELLATIONS_MIN, ATYPICAL_SALES_FACTOR, ATYPICAL_SALES_MIN } from '../../rakapay/operateurs.js';
import { PARAMETRES_SECURITE } from './parametres-securite.js';

export type ParamValue = number | boolean;
export type ParamOwner = 'CODE' | 'REGISTRE';

export interface ParamDefinition {
  id: string;
  label: string;
  category: string;
  value: ParamValue;
  unit: string;
  owner: ParamOwner;
  source: { file: string; constant: string; exported: boolean };
  description?: string;
  /** Bornes admises pour une modification (paramètres du registre). */
  min?: number;
  max?: number;
}

/**
 * Constantes NON exportées de leur module : recopiées ici (le module est en cours d'évolution par ailleurs et n'est
 * pas modifié). `test/integrite-gouvernance.test.ts` relit le fichier source et échoue si la valeur y diffère.
 */
export const REPLICATED = {
  /** backend/src/plugins/titres/service.ts — `const MAX_PACKS_PER_DEVICE = 50;` */
  MAX_PACKS_PER_DEVICE: 50,
  /** backend/src/plugins/titres/service.ts — `const OFFLINE_MAX_AGE_MS = 72 * HOUR_MS;` (en heures ici). */
  OFFLINE_MAX_AGE_HOURS: 72,
} as const;

const code = (file: string, constant: string, exported = true) => ({ file: `backend/src/${file}`, constant, exported });
const GOUV = 'plugins/integrite/gouvernance/parametres.ts';

const C = (id: string, label: string, category: string, value: ParamValue, unit: string, source: ParamDefinition['source'], description?: string): ParamDefinition => ({
  id, label, category, value, unit, owner: 'CODE', source, ...(description ? { description } : {}),
});
const R = (id: string, label: string, category: string, value: ParamValue, unit: string, bounds: { min?: number; max?: number } = {}, description?: string): ParamDefinition => ({
  id, label, category, value, unit, owner: 'REGISTRE', source: code(GOUV, 'REGISTRE_DEFAUTS'), ...bounds, ...(description ? { description } : {}),
});

/** Paramètres propres au registre (valeurs PAR DÉFAUT, à confirmer par le maître d'ouvrage). */
export const REGISTRE_DEFAUTS: ParamDefinition[] = [
  R('collusion.fenetre_jours', 'Fenêtre d’analyse de la collusion', 'Collusion (quatre yeux)', 90, 'jours', { min: 7, max: 730 }),
  R('collusion.paire_part_min_pct', 'Part des validations d’un proposant faites par un même valideur (seuil d’alerte)', 'Collusion (quatre yeux)', 60, '%', { min: 10, max: 100 }),
  R('collusion.paire_decisions_min', 'Nombre minimal de décisions d’un proposant pour mesurer la concentration', 'Collusion (quatre yeux)', 5, 'décisions', { min: 2, max: 1000 }),
  R('collusion.validation_rapide_s', 'Validation « express » : décision prise moins de … après la proposition', 'Collusion (quatre yeux)', 120, 's', { min: 5, max: 86_400 }),
  R('collusion.validation_rapide_nombre_min', 'Nombre de validations express d’un valideur avant alerte', 'Collusion (quatre yeux)', 3, 'décisions', { min: 1, max: 1000 }),
  R('collusion.heure_debut', 'Début des heures ouvrables (heure de Kinshasa, lundi au vendredi)', 'Collusion (quatre yeux)', 7, 'h', { min: 0, max: 23 }),
  R('collusion.heure_fin', 'Fin des heures ouvrables (heure de Kinshasa, lundi au vendredi)', 'Collusion (quatre yeux)', 18, 'h', { min: 1, max: 24 }),
  R('collusion.hors_heures_nombre_min', 'Nombre de validations hors heures ouvrables d’un valideur avant alerte', 'Collusion (quatre yeux)', 3, 'décisions', { min: 1, max: 1000 }),
  R('collusion.jamais_refus_decisions_min', 'Décisions d’un valideur sans aucun refus avant alerte', 'Collusion (quatre yeux)', 10, 'décisions', { min: 2, max: 10_000 }),
  R('collusion.detection_intervalle_h', 'Détection planifiée de la collusion : intervalle entre deux exécutions (0 = désactivée)', 'Collusion (quatre yeux)', 24, 'h', { min: 0, max: 720 },
    'Exécution automatique journalisée ; elle lève des alertes à examiner par un humain, jamais de sanction.'),
  R('rotation.blocage_actif', 'Rotation obligatoire : bloquer la paire au-delà du plafond (sinon alerte seulement)', 'Rotation obligatoire', false, 'oui/non', {},
    'Désactivé par défaut : une alerte est levée, aucune validation n’est bloquée tant que le maître d’ouvrage n’a pas décidé l’activation.'),
  R('rotation.max_par_paire', 'Plafond de validations par une même paire proposant → valideur', 'Rotation obligatoire', 5, 'validations', { min: 1, max: 1000 }),
  R('rotation.fenetre_jours', 'Fenêtre glissante du plafond de rotation', 'Rotation obligatoire', 30, 'jours', { min: 1, max: 365 }),
  R('cles.longueur_min', 'Longueur minimale d’une clé symétrique (HMAC, sauvegarde)', 'Gestion des clés', 32, 'caractères', { min: 16, max: 256 }),
  R('cles.age_max_jours', 'Âge maximal d’une clé avant rotation recommandée', 'Gestion des clés', 365, 'jours', { min: 30, max: 3650 }),
  // Sécurité, accès et audit (élévation, extraction massive, DLP, appareils, GPS, plafonds, clés d'accès, scellement).
  ...PARAMETRES_SECURITE,
  // Conservation des données (§ 32) : 0 = durée non fixée ⇒ aucune purge. Durées à fixer par acte (J4, J8).
  R('conservation.codes_otp_jours', 'Conservation des codes à usage unique et défis de connexion (0 = non fixée : aucune purge)', 'Conservation des données (§ 32)', 0, 'jours', { min: 0, max: 3650 },
    'Durée à fixer par acte (prescription, archives publiques, J4, J8) ; purge par effacement des champs personnels, après aperçu et approbation à deux personnes.'),
  R('conservation.sessions_canaux_jours', 'Conservation des sessions USSD / SVI terminées (0 = non fixée : aucune purge)', 'Conservation des données (§ 32)', 0, 'jours', { min: 0, max: 3650 },
    'Durée à fixer par acte (J8) ; seules les sessions terminées sont concernées.'),
];

/** Paramètres anti-fraude du code (constantes importées : la valeur affichée est TOUJOURS celle du code en service). */
export const PARAMETRES_CODE: ParamDefinition[] = [
  // Géolocalisation et présence sur place
  C('canaux.assist_sur_place_m', 'Paiement assisté : distance maximale agent ↔ objet fixe', 'Géolocalisation', ASSIST_ON_SITE_M, 'm', code('plugins/canaux/assisted.ts', 'ASSIST_ON_SITE_M')),
  C('canaux.assist_precision_max_m', 'Paiement assisté : précision GPS maximale admise', 'Géolocalisation', ASSIST_MAX_ACCURACY_M, 'm', code('plugins/canaux/assisted.ts', 'ASSIST_MAX_ACCURACY_M')),
  C('fiscal.autour_precision_max_m', '« Autour de moi » : précision GPS maximale admise', 'Géolocalisation', NEARBY_MAX_ACCURACY_M, 'm', code('plugins/fiscal/nearby.ts', 'NEARBY_MAX_ACCURACY_M')),
  C('fiscal.autour_rayon_max_m', '« Autour de moi » : rayon maximal de recherche', 'Géolocalisation', NEARBY_MAX_RADIUS_M, 'm', code('plugins/fiscal/nearby.ts', 'NEARBY_MAX_RADIUS_M')),
  C('publicite.autour_precision_max_m', 'Publicité — supports à proximité : précision GPS maximale', 'Géolocalisation', AD_NEARBY_MAX_ACCURACY_M, 'm', code('plugins/publicite/terrain.ts', 'AD_NEARBY_MAX_ACCURACY_M')),
  C('publicite.autour_rayon_max_m', 'Publicité — supports à proximité : rayon maximal', 'Géolocalisation', AD_NEARBY_MAX_RADIUS_M, 'm', code('plugins/publicite/terrain.ts', 'AD_NEARBY_MAX_RADIUS_M')),
  C('parking.presence_precision_max_m', 'Stationnement : précision GPS maximale d’une présence attestée', 'Géolocalisation', PRESENCE_MAX_ACCURACY_M, 'm', code('plugins/parking/field.ts', 'PRESENCE_MAX_ACCURACY_M')),
  C('parking.presence_distance_max_m', 'Stationnement : distance maximale au lieu contrôlé', 'Géolocalisation', PRESENCE_MAX_DISTANCE_M, 'm', code('plugins/parking/field.ts', 'PRESENCE_MAX_DISTANCE_M')),
  C('terrain.tolerance_gps_m', 'Terrain : tolérance GPS par commune', 'Géolocalisation', DEFAULT_GPS_TOLERANCE_M, 'm', code('plugins/terrain/model.ts', 'DEFAULT_GPS_TOLERANCE_M')),
  // Contrôles et preuves
  C('sanctions.contre_verification_pct', 'Contre-vérification aléatoire des constats retenus', 'Contrôles et preuves', COUNTER_CHECK_RATE_PER_10K / 100, '%', code('plugins/sanctions/counterchecks.ts', 'COUNTER_CHECK_RATE_PER_10K'), 'Exprimé pour dix mille dans le code (500 = 5 %).'),
  C('terrain.contre_visite_min_pct', 'Terrain : taux minimal d’échantillonnage de contre-visite', 'Contrôles et preuves', MIN_SAMPLE_RATE, '%', code('plugins/terrain/model.ts', 'MIN_SAMPLE_RATE')),
  C('parking.fenetre_photo_min', 'Stationnement : fenêtre de prise des photos d’un contrôle', 'Contrôles et preuves', PHOTO_WINDOW_MINUTES, 'min', code('plugins/parking/field.ts', 'PHOTO_WINDOW_MINUTES')),
  C('parking.derive_horloge_s', 'Stationnement : dérive d’horloge du terminal signalée au-delà de', 'Contrôles et preuves', CLOCK_SKEW_WARN_SECONDS, 's', code('plugins/parking/field.ts', 'CLOCK_SKEW_WARN_SECONDS')),
  C('titres.fenetre_dynamique_s', 'Titres : période du code dynamique anti-capture', 'Contrôles et preuves', DYNAMIC_WINDOW_SECONDS, 's', code('plugins/titres/tokens.ts', 'DYNAMIC_WINDOW_SECONDS')),
  C('titres.grace_dynamique_s', 'Titres : tolérance du code dynamique', 'Contrôles et preuves', DYNAMIC_GRACE_SECONDS, 's', code('plugins/titres/tokens.ts', 'DYNAMIC_GRACE_SECONDS')),
  C('titres.controle_hors_ligne_age_max_h', 'Titres : âge maximal d’un contrôle hors ligne accepté', 'Contrôles et preuves', REPLICATED.OFFLINE_MAX_AGE_HOURS, 'h', code('plugins/titres/service.ts', 'OFFLINE_MAX_AGE_MS', false), 'Constante non exportée, recopiée (72 × HOUR_MS) ; égalité vérifiée par test.'),
  C('titres.paquets_max_par_terminal', 'Titres : paquets de vérification hors ligne par terminal', 'Contrôles et preuves', REPLICATED.MAX_PACKS_PER_DEVICE, 'paquets', code('plugins/titres/service.ts', 'MAX_PACKS_PER_DEVICE', false), 'Constante non exportée, recopiée ; égalité vérifiée par test.'),
  // Commissions des agents
  C('commissions.taux_pct', 'Commission des agents', 'Commissions', AGENT_COMMISSION_PCT, '%', code('plugins/parking/field.ts', 'AGENT_COMMISSION_PCT'),
    'Le code cite une décision du maître d’ouvrage : l’acte doit être enregistré ici pour passer au statut confirmé.'),
  C('commissions.tolerance_heure_declaree_min', 'Commissions : tolérance de l’heure déclarée hors ligne', 'Commissions', DECLARED_TIME_TOLERANCE_MINUTES, 'min', code('plugins/sanctions/commissions.ts', 'DECLARED_TIME_TOLERANCE_MINUTES')),
  ...Object.entries(ATTRIBUTION_WINDOWS_MINUTES).map(([m, v]) =>
    C(`commissions.delai_attribution.${m.toLowerCase()}`, `Commissions : délai d’attribution d’un paiement — ${m.toLowerCase()}`, 'Commissions', v, 'min', code('plugins/sanctions/commissions.ts', `ATTRIBUTION_WINDOWS_MINUTES.${m}`))),
  // Répartition des recettes (§ 37A, position du promoteur) : clé NON ACTIVE, acte juridique requis (§ 37A.8)
  ...([
    ['repartition.part_groupe_nseya_pct', 'Répartition § 37A : part de Groupe Nseya (Flux 1)', REPARTITION_PART_NSEYA_PCT, 'REPARTITION_PART_NSEYA_PCT'],
    ['repartition.part_tutelle_pct', 'Répartition § 37A : part du ministère de tutelle du module (Flux 2)', REPARTITION_PART_TUTELLE_PCT, 'REPARTITION_PART_TUTELLE_PCT'],
    ['repartition.part_agents_pct', 'Répartition § 37A : réserve des agents et sous-traitants, par module (Flux 2) — les commissions des agents y sont imputées', REPARTITION_PART_AGENTS_PCT, 'REPARTITION_PART_AGENTS_PCT'],
    ['repartition.part_gouvernement_pct', 'Répartition § 37A : solde du Gouvernement provincial (Flux 2, reçoit les arrondis)', REPARTITION_PART_GOUVERNEMENT_PCT, 'REPARTITION_PART_GOUVERNEMENT_PCT'],
  ] as const).map(([id, label, v, constant]) => C(id, label, 'Répartition des recettes (§ 37A)', v, '%', code('plugins/pilotage/repartition/model.ts', constant),
    'Position du promoteur (Cahier v2.9) : clé au statut ACTE_REQUIS, simulation seulement ; la table de taux de la règle CLE-REPARTITION-37A certifiée par acte prévaut.')),
  C('repartition.duree_ans', 'Répartition § 37A : durée du modèle à compter de la mise en service du pilote', 'Répartition des recettes (§ 37A)', REPARTITION_DUREE_ANS, 'ans', code('plugins/pilotage/repartition/model.ts', 'REPARTITION_DUREE_ANS')),
  C('repartition.nombre_flux', 'Répartition § 37A : flux de décaissement admis (tout troisième flux est rejeté)', 'Répartition des recettes (§ 37A)', REPARTITION_NOMBRE_FLUX, 'flux', code('plugins/pilotage/repartition/model.ts', 'REPARTITION_NOMBRE_FLUX')),
  // Trésor et quatre yeux
  C('tresor.remboursement_seuil_usd', 'Remboursement : seuil d’une troisième personne (USD)', 'Trésor et quatre yeux', Number(REFUND_EXTRA_APPROVAL_THRESHOLDS.USD?.amount ?? 0), 'USD', code('plugins/tresor/service.ts', 'REFUND_EXTRA_APPROVAL_THRESHOLDS.USD')),
  C('tresor.remboursement_seuil_cdf', 'Remboursement : seuil d’une troisième personne (CDF)', 'Trésor et quatre yeux', Number(REFUND_EXTRA_APPROVAL_THRESHOLDS.CDF?.amount ?? 0), 'CDF', code('plugins/tresor/service.ts', 'REFUND_EXTRA_APPROVAL_THRESHOLDS.CDF')),
  C('tresor.exception_delai_h', 'Exception de rapprochement : délai de traitement', 'Trésor et quatre yeux', EXCEPTION_SLA_HOURS, 'h', code('plugins/tresor/service.ts', 'EXCEPTION_SLA_HOURS')),
  C('tresor.suspens_delai_j', 'Suspens : délai de traitement', 'Trésor et quatre yeux', SUSPENSE_SLA_DAYS, 'jours', code('plugins/tresor/service.ts', 'SUSPENSE_SLA_DAYS')),
  C('tresor.suspens_age_max_j', 'Suspens : ancienneté maximale', 'Trésor et quatre yeux', SUSPENSE_MAX_DAYS, 'jours', code('plugins/tresor/service.ts', 'SUSPENSE_MAX_DAYS')),
  C('tresor.reglement_prestataire_j', 'Règlement prestataire : délai avant retard', 'Trésor et quatre yeux', PROVIDER_SETTLEMENT_DELAY_DAYS, 'jours', code('plugins/tresor/service.ts', 'PROVIDER_SETTLEMENT_DELAY_DAYS')),
  C('liquidation.derogation_base_pct', 'Liquidation : écart de base au-delà duquel une seconde approbation est requise', 'Trésor et quatre yeux', BASE_OVERRIDE_TOLERANCE_PCT, '%', code('modules/assessment/service.ts', 'BASE_OVERRIDE_TOLERANCE_PCT')),
  C('coffre.refroidissement_h', 'Coffre : refroidissement d’un changement de compte bénéficiaire', 'Trésor et quatre yeux', COOLING_OFF_HOURS, 'h', code('modules/vault/service.ts', 'COOLING_OFF_HOURS')),
  C('coffre.approbations', 'Coffre : approbations requises (hors proposant)', 'Trésor et quatre yeux', REQUIRED_VAULT_APPROVALS, 'personnes', code('modules/vault/service.ts', 'REQUIRED_VAULT_APPROVALS')),
  C('regles.suspension_courte_j', 'Règles : durée d’une suspension courte', 'Trésor et quatre yeux', SHORT_SUSPENSION_DAYS, 'jours', code('modules/rules/service.ts', 'SHORT_SUSPENSION_DAYS')),
  // Points de paiement et canaux
  C('canaux.constat_bancaire_grace_h', 'Points agréés : délai de grâce du relevé bancaire', 'Canaux et points agréés', BANK_CONFIRMATION_GRACE_HOURS, 'h', code('plugins/canaux/points.ts', 'BANK_CONFIRMATION_GRACE_HOURS')),
  C('canaux.non_rapproche_age_j', 'Points agréés : vieillissement d’un encaissement non rapproché', 'Canaux et points agréés', UNRECONCILED_AGING_DAYS, 'jours', code('plugins/canaux/points.ts', 'UNRECONCILED_AGING_DAYS')),
  C('canaux.code_secret_essais', 'USSD / SVI : essais de code secret avant verrouillage', 'Canaux et points agréés', MAX_PIN_ATTEMPTS, 'essais', code('plugins/canaux/model.ts', 'MAX_PIN_ATTEMPTS')),
  C('canaux.verifications_max', 'Vérifications par code court : maximum par fenêtre', 'Canaux et points agréés', VERIFY_MAX_PER_WINDOW, 'vérifications', code('plugins/canaux/model.ts', 'VERIFY_MAX_PER_WINDOW')),
  C('canaux.verifications_echecs_max', 'Vérifications par code court : échecs maximum par fenêtre', 'Canaux et points agréés', VERIFY_MAX_FAILURES_PER_WINDOW, 'échecs', code('plugins/canaux/model.ts', 'VERIFY_MAX_FAILURES_PER_WINDOW')),
  // Authentification
  C('socle.code_essais', 'Connexion : essais de code avant blocage', 'Authentification', MAX_CODE_ATTEMPTS, 'essais', code('plugins/socle/service.ts', 'MAX_CODE_ATTEMPTS')),
  C('socle.mot_de_passe_echecs', 'Connexion : échecs de mot de passe avant blocage', 'Authentification', MAX_PASSWORD_FAILURES, 'échecs', code('plugins/socle/service.ts', 'MAX_PASSWORD_FAILURES')),
  C('acces.otp_essais', 'Invitations : essais de code à usage unique', 'Authentification', OTP_MAX_ATTEMPTS, 'essais', code('plugins/acces/service.ts', 'OTP_MAX_ATTEMPTS')),
  // Apprentissage et certification (§ 24) : certification avant affectation des agents recenseurs
  C('apprentissage.epreuve_seuil_pct', 'Apprentissage : score minimal d’une épreuve de module', 'Apprentissage et certification (§ 24)', SEUIL_REUSSITE_EPREUVE_PCT, '%', code('plugins/apprentissage/model.ts', 'SEUIL_REUSSITE_EPREUVE_PCT')),
  ...Object.entries(VALIDITE_CERTIFICAT_JOURS).map(([p, v]) =>
    C(`apprentissage.validite_certificat_j.${p.toLowerCase()}`, `Apprentissage : validité d’un certificat — ${p.toLowerCase()}`, 'Apprentissage et certification (§ 24)', v, 'jours', code('plugins/apprentissage/model.ts', `VALIDITE_CERTIFICAT_JOURS.${p}`),
      p === 'CONTROLEUR' ? 'Recertification annuelle : périodicité donnée par le Cahier (§ 24).' : undefined)),
  C('apprentissage.evaluation_continue_j', 'Apprentissage : ancienneté maximale de l’évaluation continue du guichet', 'Apprentissage et certification (§ 24)', EVALUATION_CONTINUE_INTERVALLE_JOURS, 'jours', code('plugins/apprentissage/model.ts', 'EVALUATION_CONTINUE_INTERVALLE_JOURS')),
  C('apprentissage.echantillon_taille', 'Apprentissage : actes tirés pour le contrôle par échantillon (finances)', 'Apprentissage et certification (§ 24)', ECHANTILLON_TAILLE, 'actes', code('plugins/apprentissage/model.ts', 'ECHANTILLON_TAILLE')),
  C('apprentissage.echantillon_conformite_pct', 'Apprentissage : conformité minimale de l’échantillon (finances)', 'Apprentissage et certification (§ 24)', ECHANTILLON_CONFORMITE_MIN_PCT, '%', code('plugins/apprentissage/model.ts', 'ECHANTILLON_CONFORMITE_MIN_PCT')),
  // Détection explicable (module Intégrité)
  C('detection.verifications_repetees', 'Détection : vérifications répétées d’une quittance', 'Détection (Intégrité)', DETECTION_PARAMS.repeatedVerificationCount, 'vérifications', code('plugins/integrite/service.ts', 'DETECTION_PARAMS.repeatedVerificationCount')),
  C('detection.lieux_eloignes_km', 'Détection : quittance vérifiée depuis des lieux distants de', 'Détection (Intégrité)', DETECTION_PARAMS.distantVerificationKm, 'km', code('plugins/integrite/service.ts', 'DETECTION_PARAMS.distantVerificationKm')),
  C('detection.paiements_fractionnes', 'Détection : paiements fractionnés sur une obligation', 'Détection (Intégrité)', DETECTION_PARAMS.splitPaymentCount, 'paiements', code('plugins/integrite/service.ts', 'DETECTION_PARAMS.splitPaymentCount')),
  C('detection.acces_refuses', 'Détection : refus d’accès répétés', 'Détection (Intégrité)', DETECTION_PARAMS.deniedAccessCount, 'refus', code('plugins/integrite/service.ts', 'DETECTION_PARAMS.deniedAccessCount')),
  C('detection.concentration_part_pct', 'Détection : concentration d’actes sensibles sur une personne', 'Détection (Intégrité)', DETECTION_PARAMS.sensitiveConcentrationShare * 100, '%', code('plugins/integrite/service.ts', 'DETECTION_PARAMS.sensitiveConcentrationShare')),
  // Billetterie RakaPay multi-opérateurs : revue des ventes atypiques (signal examiné par une personne, jamais une sanction).
  C('rakapay.ventes_atypiques_facteur', 'RakaPay : ventes d’un agent au-delà de … fois la médiane des autres agents de l’opérateur', 'Détection (Intégrité)', ATYPICAL_SALES_FACTOR, 'fois', code('plugins/rakapay/operateurs.ts', 'ATYPICAL_SALES_FACTOR')),
  C('rakapay.ventes_atypiques_min', 'RakaPay : nombre minimal de ventes journalières d’un agent avant signal', 'Détection (Intégrité)', ATYPICAL_SALES_MIN, 'ventes', code('plugins/rakapay/operateurs.ts', 'ATYPICAL_SALES_MIN')),
  C('rakapay.annulations_repetees_min', 'RakaPay : annulations journalières d’un agent avant signal', 'Détection (Intégrité)', ATYPICAL_CANCELLATIONS_MIN, 'annulations', code('plugins/rakapay/operateurs.ts', 'ATYPICAL_CANCELLATIONS_MIN')),
  // Anomalies locatives (§ 16.4) : listes de travail pour vérification humaine, jamais une dette.
  C('anomalies.compteurs_multiples_min', 'Anomalies locatives : nombre de compteurs constituant « plusieurs compteurs »', 'Détection (Intégrité)', MULTIPLE_METERS_MIN, 'compteurs', code('plugins/fiscal/anomalies.ts', 'MULTIPLE_METERS_MIN'), 'Cahier § 16.4 : « plusieurs compteurs ».'),
  C('anomalies.immeuble_neuf_mois', 'Anomalies locatives : délai sans unité déclarée après réception d’un immeuble', 'Détection (Intégrité)', NEW_BUILDING_NO_UNIT_MONTHS, 'mois', code('plugins/fiscal/anomalies.ts', 'NEW_BUILDING_NO_UNIT_MONTHS'), 'Cahier § 16.4 : « après douze mois ».'),
];

export const ALL_PARAMETERS: ParamDefinition[] = [...REGISTRE_DEFAUTS, ...PARAMETRES_CODE];
