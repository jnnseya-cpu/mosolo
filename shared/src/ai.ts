/** Format de sortie standard de la couche d'intelligence (§ 23.5.7). */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type AutonomyLevel = 'A_AUTO' | 'B_VALIDATION' | 'C_RECOMMANDATION';

export interface AIRecommendationOutput {
  situation: string;
  insight: string;
  risk: string;
  recommendation: string;
  nextAction: string;
  /** Rôle responsable — jamais « l'IA » */
  owner: string;
  deadline: string;
  confidence: Confidence;
  sources: string[];
  decision?: {
    bestOption: string;
    alternativeOption: string;
    riskOfInaction: string;
    financialImpact: string;
    operationalImpact: string;
  };
}

export interface AIRecommendation extends AIRecommendationOutput {
  id: string;
  agent: string;
  modelVersion: string;
  autonomy: AutonomyLevel;
  createdAt: string;
  status: 'EMISE' | 'ACCEPTEE' | 'MODIFIEE' | 'REJETEE';
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
}

/** Actions que l'IA ne peut jamais exécuter (§ 23.1) */
export const AI_FORBIDDEN_ACTIONS = [
  'CREATE_TAX', 'IMPOSE_PENALTY', 'DETERMINE_OWNERSHIP', 'SEIZE_PROPERTY', 'SUSPEND_RIGHT',
  'APPROVE_EXEMPTION', 'CLOSE_APPEAL', 'TRANSFER_MONEY', 'CHANGE_BENEFICIARY', 'DESTROY_AUDIT',
] as const;
