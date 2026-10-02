/**
 * Catalogue des agents (§ 23.2, § 23.5.5) et fiche de contrôle de chacun (C3-179) : mission, données autorisées,
 * niveau d'autonomie maximal, actions permises, rôles qui l'interrogent et rôles qui valident.
 * La « version de prompt » est l'empreinte de la fiche : toute modification de la fiche change la version journalisée.
 */
import type { AutonomyLevel, RoleCode } from '@mosolo/shared';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import type { ActionType, AgentCode, CrossAgent, DataDomain } from './types.js';

export interface AgentSheet {
  code: AgentCode;
  name: string;
  /** Désignation technique (C3-178). */
  technicalName: string;
  mission: string;
  crossAgents: CrossAgent[];
  /** Entité de rattachement des recommandations. */
  homeEntity: string;
  allowedData: DataDomain[];
  /** Niveau d'autonomie maximal de ses sorties. */
  autonomy: AutonomyLevel;
  allowedActions: ActionType[];
  /** Rôles qui peuvent solliciter l'agent. */
  runners: RoleCode[];
  /** Rôles habilités à valider / décider ses recommandations. */
  validators: RoleCode[];
  humanValidation: string;
  outputs: string;
  /** Interdits explicites de la fiche (rappel de § 23.1). */
  never: string;
  /** L'agent travaille sur le compte de l'usager authentifié (contribuable / mandataire / guichet). */
  personal?: boolean;
  /** Peut tourner lors du balayage proactif (aucun sujet nominatif requis). */
  proactive: boolean;
  version: number;
}

const S = (s: Omit<AgentSheet, 'version'>): AgentSheet => ({ ...s, version: 1 });

export const AGENTS: Record<AgentCode, AgentSheet> = {
  DECOUVERTE: S({
    code: 'DECOUVERTE', name: 'Découverte des recettes', technicalName: 'Revenue Discovery Agent',
    mission: 'Identifier le sous-enregistrement, les activités non déclarées et les actifs publics non valorisés.',
    crossAgents: ['Stratégie', 'Finances'], homeEntity: 'DGIPK', allowedData: ['OBJETS', 'BAUX'],
    autonomy: 'C_RECOMMANDATION', allowedActions: ['PREPARER_BROUILLON'],
    runners: ['R01', 'R05', 'R06', 'R07', 'R22'], validators: ['R06', 'R07'],
    humanValidation: 'Analyste + juriste + comité', outputs: 'Fiches d’opportunité (brouillon)',
    never: 'Ne crée aucune règle, aucune obligation, aucune taxe.', proactive: true,
  }),
  ENROLEMENT: S({
    code: 'ENROLEMENT', name: 'Enrôlement', technicalName: 'Registration Agent',
    mission: 'Guider l’inscription, détecter les pièces manquantes, réutiliser les données vérifiées.',
    crossAgents: ['Processus', 'Personnalisation'], homeEntity: 'PUBLIC', allowedData: ['COMPTE_PROPRE'],
    autonomy: 'A_AUTO', allowedActions: ['PREPARER_BROUILLON'],
    runners: ['R30', 'R31', 'R12'], validators: ['R30', 'R31', 'R12'],
    humanValidation: 'Le contribuable confirme', outputs: 'Suggestions, pré-remplissage (brouillon)',
    never: 'Ne valide jamais seul une identité ; ne fusionne aucun compte.', personal: true, proactive: false,
  }),
  APPRENTISSAGE_USAGER: S({
    code: 'APPRENTISSAGE_USAGER', name: 'Apprentissage de l’usager', technicalName: 'User Learning Agent',
    mission: 'Expliquer obligations, échéances, pièces, moyens de paiement, droits de recours et usage de la plateforme.',
    crossAgents: ['Communication', 'Personnalisation'], homeEntity: 'PUBLIC', allowedData: ['COMPTE_PROPRE', 'OBLIGATIONS_PROPRES', 'BASE_CONNAISSANCES'],
    autonomy: 'A_AUTO', allowedActions: ['RESUMER'],
    runners: ['R30', 'R31', 'R12'], validators: ['R30', 'R31', 'R12'],
    humanValidation: 'Réponses sans effet juridique ; renvoi vers un humain', outputs: 'Réponses sourcées',
    never: 'Aucun conseil juridique opposable ; ne modifie aucune obligation.', personal: true, proactive: false,
  }),
  COPILOTE: S({
    code: 'COPILOTE', name: 'Copilote des agents publics', technicalName: 'Public Agent Copilot',
    mission: 'Résumer les dossiers, guider la procédure, préparer les projets de documents et l’étape suivante.',
    crossAgents: ['Processus', 'Documents'], homeEntity: 'DGIPK', allowedData: ['RECOURS', 'OBLIGATIONS'],
    autonomy: 'C_RECOMMANDATION', allowedActions: ['RESUMER', 'PREPARER_BROUILLON', 'CLASSER'],
    runners: ['R20', 'R21', 'R06', 'R07', 'R11'], validators: ['R20', 'R21'],
    humanValidation: 'L’agent public signe', outputs: 'Résumés, projets de décision motivée',
    never: 'Ne signe ni ne notifie ; ne clôt aucun recours.', proactive: true,
  }),
  VEILLE_JURIDIQUE: S({
    code: 'VEILLE_JURIDIQUE', name: 'Veille juridique', technicalName: 'Legal Watch Agent',
    mission: 'Suivre les textes, repérer les règles expirées, à vérifier ou en conflit.',
    crossAgents: ['Conformité', 'Documents'], homeEntity: 'MINFIN', allowedData: ['REGLES', 'INSTRUMENTS'],
    autonomy: 'C_RECOMMANDATION', allowedActions: ['PREPARER_BROUILLON', 'CREER_TACHE'],
    runners: ['R13', 'R14', 'R15', 'R16', 'R22'], validators: ['R13', 'R14'],
    humanValidation: 'Juristes ; aucune publication', outputs: 'Alertes, propositions de fiches (brouillon)',
    never: 'Ne publie ni n’active aucune règle.', proactive: true,
  }),
  INTELLIGENCE_LOCATIVE: S({
    code: 'INTELLIGENCE_LOCATIVE', name: 'Intelligence locative', technicalName: 'Rental Intelligence Agent',
    mission: 'Repérer les biens probablement loués, les incohérences d’occupation et les zones à vérifier.',
    crossAgents: ['Intelligence des données', 'Prédiction'], homeEntity: 'DGIPK', allowedData: ['OBJETS', 'BAUX', 'OBSERVATIONS_TERRAIN'],
    autonomy: 'B_VALIDATION', allowedActions: ['DEMANDER_PIECES', 'CREER_TACHE'],
    runners: ['R06', 'R07', 'R09', 'R11'], validators: ['R09', 'R06'],
    humanValidation: 'Superviseur', outputs: 'Listes de vérification avec scores expliqués',
    never: 'Ne conclut ni propriété ni fraude ; ne crée aucune dette.', proactive: true,
  }),
  MISSIONS_TERRAIN: S({
    code: 'MISSIONS_TERRAIN', name: 'Missions terrain', technicalName: 'Field Mission Agent',
    mission: 'Planifier des tournées efficaces, prioriser les objets, préparer les dossiers.',
    crossAgents: ['Processus'], homeEntity: 'DGIPK', allowedData: ['OBJETS', 'BAUX', 'CONFLITS_TERRAIN', 'EQUIPES_TERRAIN'],
    autonomy: 'B_VALIDATION', allowedActions: ['OUVRIR_MISSION'],
    runners: ['R09', 'R06'], validators: ['R09'],
    humanValidation: 'Superviseur', outputs: 'Plans de mission',
    never: 'N’affecte jamais un agent hors de son périmètre ; aucune visite sans validation.', proactive: true,
  }),
  RAPPROCHEMENT: S({
    code: 'RAPPROCHEMENT', name: 'Rapprochement', technicalName: 'Reconciliation Agent',
    mission: 'Proposer des appariements, expliquer les écarts de rapprochement.',
    crossAgents: ['Intelligence des données', 'Finances'], homeEntity: 'TRESOR', allowedData: ['PAIEMENTS', 'EXCEPTIONS_TRESOR'],
    autonomy: 'C_RECOMMANDATION', allowedActions: ['CREER_TACHE'],
    runners: ['R17', 'R18'], validators: ['R17', 'R18'],
    humanValidation: 'Analyste (quatre yeux au-delà des tolérances)', outputs: 'Propositions d’appariement',
    never: 'Ne corrige aucune écriture ; ne déplace aucun fonds.', proactive: true,
  }),
  FRAUDE: S({
    code: 'FRAUDE', name: 'Détection de fraude', technicalName: 'Fraud Detection Agent',
    mission: 'Détecter identités dupliquées, accès refusés répétés, appareils révoqués, changements de bénéficiaire, anomalies.',
    crossAgents: ['Prédiction', 'Conformité'], homeEntity: 'AUDIT', allowedData: ['JOURNAL_AUDIT', 'ALERTES', 'TERMINAUX', 'CONTRIBUABLES_AGREGES', 'COFFRE'],
    autonomy: 'B_VALIDATION', allowedActions: ['OUVRIR_DOSSIER_VERIFICATION'],
    runners: ['R24', 'R22'], validators: ['R24'],
    humanValidation: 'Enquêteur', outputs: 'Alertes expliquées (pseudonymisées)',
    never: 'N’accuse personne ; ne suspend aucun compte ; ne bloque aucun paiement.', proactive: true,
  }),
  PREVISION: S({
    code: 'PREVISION', name: 'Prévision', technicalName: 'Forecasting Agent',
    mission: 'Scénarios prudent, attendu, ambitieux avec hypothèses explicites et intervalles.',
    crossAgents: ['Prédiction', 'Finances'], homeEntity: 'MINFIN', allowedData: ['OBLIGATIONS', 'PAIEMENTS'],
    autonomy: 'C_RECOMMANDATION', allowedActions: [],
    runners: ['R01', 'R05', 'R06', 'R17'], validators: ['R05', 'R17'],
    humanValidation: 'Direction financière', outputs: 'Prévisions + intervalles',
    never: 'Ne fixe aucune assignation ni objectif opposable.', proactive: true,
  }),
  DECISION_EXECUTIVE: S({
    code: 'DECISION_EXECUTIVE', name: 'Aide à la décision exécutive', technicalName: 'Executive Decision Agent',
    mission: 'Transformer les données en notes de décision (options, effets, risques).',
    crossAgents: ['Stratégie'], homeEntity: 'GOUVERNORAT', allowedData: ['OBLIGATIONS', 'PAIEMENTS', 'EXCEPTIONS_TRESOR', 'RECOURS', 'REGLES'],
    autonomy: 'C_RECOMMANDATION', allowedActions: [],
    runners: ['R01', 'R02', 'R05'], validators: ['R01', 'R02', 'R05'],
    humanValidation: 'Gouverneur et autorités', outputs: 'Notes de décision',
    never: 'Ne décide pas ; aucun effet sans acte de l’autorité.', proactive: true,
  }),
  ALLOCATION: S({
    code: 'ALLOCATION', name: 'Allocation des investissements', technicalName: 'Investment Allocation Agent',
    mission: 'Proposer des scénarios d’emploi des fonds disponibles (ch. 27).',
    crossAgents: ['Finances', 'Stratégie'], homeEntity: 'MINFIN', allowedData: ['PAIEMENTS', 'COFFRE'],
    autonomy: 'C_RECOMMANDATION', allowedActions: [],
    runners: ['R01', 'R05', 'R17'], validators: ['R05', 'R01'],
    humanValidation: 'Autorités budgétaires', outputs: 'Scénarios (sans clé de répartition inventée)',
    never: 'N’approuve ni ne déplace aucun fonds ; aucune répartition vers des personnes.', proactive: true,
  }),
  APPRENTISSAGE_CONTINU: S({
    code: 'APPRENTISSAGE_CONTINU', name: 'Apprentissage continu', technicalName: 'Continuous Learning Agent',
    mission: 'Proposer des versions candidates à partir des corrections et décisions humaines validées.',
    crossAgents: ['Automatisation'], homeEntity: 'PLATEFORME', allowedData: ['DECISIONS_IA'],
    autonomy: 'C_RECOMMANDATION', allowedActions: ['PREPARER_BROUILLON'],
    runners: ['R29', 'R22'], validators: ['R29'],
    humanValidation: 'Comité des modèles', outputs: 'Versions candidates (jamais mises en service seules)',
    never: 'Aucun réentraînement ni auto-modification silencieux.', proactive: true,
  }),
  COMMUNICATION: S({
    code: 'COMMUNICATION', name: 'Communication', technicalName: 'Communication Agent',
    mission: 'Rédiger avis, rappels et réponses ; proposer les relances obligatoires des échéances dépassées.',
    crossAgents: ['Communication'], homeEntity: 'DGIPK', allowedData: ['COMMUNICATIONS', 'OBLIGATIONS'],
    autonomy: 'B_VALIDATION', allowedActions: ['PREPARER_BROUILLON', 'RELANCE_OBLIGATOIRE'],
    runners: ['R06', 'R07', 'R08', 'R12'], validators: ['R06', 'R07', 'R08'],
    humanValidation: 'Un clic de validation par un agent habilité', outputs: 'Brouillons de messages, relances',
    never: 'N’envoie aucun avis obligatoire sans validation humaine ; aucune pénalité.', proactive: true,
  }),
};

export const PROVIDER_MODEL_VERSION = 'regles-deterministes-ia-2.0';

export function promptVersion(sheet: AgentSheet): string {
  const { code, mission, allowedData, autonomy, allowedActions, never, version } = sheet;
  return `${code.toLowerCase()}-v${version}-${sha256Hex(canonicalJson({ code, mission, allowedData, autonomy, allowedActions, never, version })).slice(0, 10)}`;
}

/** Libellés des actions. */
export const ACTION_LABELS: Record<ActionType, string> = {
  CREER_TACHE: 'Créer une tâche', PREPARER_BROUILLON: 'Préparer un brouillon', RESUMER: 'Résumer', CLASSER: 'Classer / étiqueter',
  RAPPEL_FACULTATIF: 'Rappel facultatif', DEMANDER_PIECES: 'Envoyer une demande de pièces', OUVRIR_MISSION: 'Ouvrir une mission terrain',
  RELANCE_OBLIGATOIRE: 'Envoyer une relance', OUVRIR_DOSSIER_VERIFICATION: 'Ouvrir un dossier de vérification',
};
