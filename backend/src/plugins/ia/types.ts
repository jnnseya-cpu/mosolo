/**
 * Types de la couche d'intelligence étendue (« AI Operating System », § 23.5).
 * Définis côté backend : le type partagé `AIRecommendationOutput` (shared/src/ai.ts) reste inchangé et est étendu ici.
 */
import type { AIRecommendationOutput, AutonomyLevel, RoleCode } from '@mosolo/shared';

/** Les 13 agents métier du § 23.2 + l'agent transverse Communication (§ 23.5.5). */
export const AGENT_CODES = [
  'DECOUVERTE', 'ENROLEMENT', 'APPRENTISSAGE_USAGER', 'COPILOTE', 'VEILLE_JURIDIQUE', 'INTELLIGENCE_LOCATIVE',
  'MISSIONS_TERRAIN', 'RAPPROCHEMENT', 'FRAUDE', 'PREVISION', 'DECISION_EXECUTIVE', 'ALLOCATION', 'APPRENTISSAGE_CONTINU',
  'COMMUNICATION',
] as const;
export type AgentCode = (typeof AGENT_CODES)[number];

/** Agents transverses (§ 23.5.5). */
export type CrossAgent =
  | 'Stratégie' | 'Processus' | 'Intelligence des données' | 'Prédiction' | 'Documents' | 'Communication'
  | 'Conformité' | 'Finances' | 'Automatisation' | 'Personnalisation';

/** Domaines de données qu'un agent peut lire (fiche de contrôle). Toute lecture hors liste est refusée. */
export type DataDomain =
  | 'OBJETS' | 'BAUX' | 'OBSERVATIONS_TERRAIN' | 'CONFLITS_TERRAIN' | 'EQUIPES_TERRAIN' | 'COMPTE_PROPRE' | 'OBLIGATIONS_PROPRES'
  | 'OBLIGATIONS' | 'PAIEMENTS' | 'EXCEPTIONS_TRESOR' | 'REGLES' | 'INSTRUMENTS' | 'RECOURS' | 'ALERTES' | 'JOURNAL_AUDIT'
  | 'TERMINAUX' | 'CONTRIBUABLES_AGREGES' | 'COFFRE' | 'COMMUNICATIONS' | 'DECISIONS_IA' | 'BASE_CONNAISSANCES';

/**
 * Types d'actions. Niveau A : sans effet juridique ni financier, réversibles, exécutées par l'agent (garde `draft.write`).
 * Niveau B : effet sur un tiers, exécutées au nom de l'agent public qui valide. Aucune action de niveau C n'existe :
 * une recommandation C n'est jamais exécutable (elle renvoie au circuit maker-checker du domaine).
 */
export const LEVEL_A_ACTIONS = ['CREER_TACHE', 'PREPARER_BROUILLON', 'RESUMER', 'CLASSER', 'RAPPEL_FACULTATIF'] as const;
export const LEVEL_B_ACTIONS = ['DEMANDER_PIECES', 'OUVRIR_MISSION', 'RELANCE_OBLIGATOIRE', 'OUVRIR_DOSSIER_VERIFICATION'] as const;
export type LevelAAction = (typeof LEVEL_A_ACTIONS)[number];
export type LevelBAction = (typeof LEVEL_B_ACTIONS)[number];
export type ActionType = LevelAAction | LevelBAction;

export type ActionStatus = 'PROPOSEE' | 'EXECUTEE_AUTO' | 'EXECUTEE' | 'ANNULEE' | 'ABANDONNEE' | 'NON_EXECUTEE_DESACTIVEE';

export interface ProposedAction {
  id: string;
  type: ActionType;
  level: 'A' | 'B';
  label: string;
  params: Record<string, string>;
  status: ActionStatus;
  effectId?: string;
  executedBy?: string;
  executedByKind?: 'ai' | 'user';
  executedAt?: string;
  undoneBy?: string;
  undoneAt?: string;
  undoReason?: string;
  /** Motif pour lequel l'action n'a pas été exécutée automatiquement (niveau A désactivé par l'entité). */
  blockedReason?: string;
}

/** Donnée citée : référence vérifiable de ce que l'agent a lu. */
export interface Citation {
  domain: DataDomain;
  ref: string;
  label: string;
}

export type IaStatus = 'EMISE' | 'TRAITEE_AUTO' | 'ACCEPTEE' | 'MODIFIEE' | 'REJETEE' | 'ANNULEE';

/** Sortie d'un agent (avant enregistrement par la passerelle). */
export interface AgentDraft extends AIRecommendationOutput {
  autonomy: AutonomyLevel;
  /** Étape recommandée (bloc de décision complet, § 23.5.7). */
  recommendedStep?: string;
  actions: Omit<ProposedAction, 'id' | 'status'>[];
  citations: Citation[];
  /** Facteurs contributifs d'un score (explicabilité). */
  factors?: { label: string; weight: string }[];
  subject?: { type: string; id: string };
  taxpayerId?: string;
  /** Recommandation fondée (en partie) sur des données d'EXEMPLE ou des hypothèses. */
  example: boolean;
  /** Circuit humain à suivre pour une recommandation de niveau C. */
  circuit?: string;
  /** Clé de dédoublonnage stable. */
  key: string;
}

export interface IaRecommendation extends AIRecommendationOutput {
  id: string;
  agentCode: AgentCode;
  agent: string;
  crossAgents: CrossAgent[];
  autonomy: AutonomyLevel;
  status: IaStatus;
  entity: string;
  taxpayerId?: string;
  subject?: { type: string; id: string };
  recommendedStep?: string;
  actions: ProposedAction[];
  citations: Citation[];
  factors?: { label: string; weight: string }[];
  circuit?: string;
  example: boolean;
  key: string;
  modelVersion: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  purpose: string;
  requestedBy: string;
  createdAt: string;
  notice: string;
  decidedBy?: string;
  decidedByRole?: RoleCode;
  decidedAt?: string;
  decisionReason?: string;
  modification?: string;
  /** Délai entre émission et décision humaine (ms). */
  decisionLatencyMs?: number;
}

export type EffectType = 'TACHE' | 'BROUILLON' | 'RESUME' | 'ETIQUETTE' | 'RAPPEL' | 'DEMANDE_PIECES' | 'MISSION' | 'RELANCE' | 'DOSSIER_VERIFICATION';

/** Effet produit par une action exécutée (tâche, brouillon, mission…). Jamais un acte juridique ou financier. */
export interface IaEffect {
  id: string;
  type: EffectType;
  recommendationId: string;
  actionId: string;
  entity: string;
  title: string;
  body: string;
  assigneeRole?: RoleCode;
  assigneeUserId?: string;
  taxpayerId?: string;
  subject?: { type: string; id: string };
  status: 'ACTIF' | 'ANNULE';
  createdAt: string;
  createdBy: string;
  createdByKind: 'ai' | 'user';
  deliveries?: number;
  undoneAt?: string;
  undoneBy?: string;
  undoReason?: string;
  notice: string;
}

export type JournalEventType = 'GENERATION' | 'EXECUTION_AUTO' | 'BLOCAGE_AUTONOMIE' | 'VALIDATION' | 'EXECUTION' | 'DECISION' | 'ANNULATION' | 'REFUS';

/** Journal IA (§ 23.3) : en ajout seul. Conservé au même niveau que le journal d'audit (§ 23.4). */
export interface IaJournalEntry {
  id: string;
  at: string;
  type: JournalEventType;
  agentCode: AgentCode;
  recommendationId?: string;
  entity: string;
  actor: { kind: 'ai' | 'user' | 'system'; id: string; role?: string };
  purpose?: string;
  modelVersion?: string;
  promptVersion?: string;
  input?: { hash: string; domains: DataDomain[]; citations: Citation[]; masked: string[] };
  output?: { hash: string; autonomy: AutonomyLevel; summary: string; actions: string[] };
  decision?: { decision: string; reason: string; role?: string; latencyMs?: number };
  action?: { id: string; type: ActionType; effectId?: string };
  detail?: string;
  auditId?: string;
}

export interface AutonomySettings {
  entity: string;
  /** Exécution automatique de niveau A autorisée pour l'entité. */
  levelAEnabled: boolean;
  disabledActions: LevelAAction[];
  disabledAgents: AgentCode[];
  updatedAt?: string;
  updatedBy?: string;
  reason?: string;
}
