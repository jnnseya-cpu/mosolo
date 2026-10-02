/** Types de la couche d'intelligence (module « ia ») côté interface — miroir du contrat /v1/ia. */
export type Autonomy = 'A_AUTO' | 'B_VALIDATION' | 'C_RECOMMANDATION';
export type IaStatus = 'EMISE' | 'TRAITEE_AUTO' | 'ACCEPTEE' | 'MODIFIEE' | 'REJETEE' | 'ANNULEE';
export type ActionStatus = 'PROPOSEE' | 'EXECUTEE_AUTO' | 'EXECUTEE' | 'ANNULEE' | 'ABANDONNEE' | 'NON_EXECUTEE_DESACTIVEE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface IaAction {
  id: string; type: string; level: 'A' | 'B'; label: string; params: Record<string, string>; status: ActionStatus;
  effectId?: string; executedBy?: string; executedByKind?: 'ai' | 'user'; executedAt?: string;
  undoneBy?: string; undoneAt?: string; undoReason?: string; blockedReason?: string;
}

export interface IaCitation { domain: string; ref: string; label: string }

export interface IaEffect {
  id: string; type: string; recommendationId: string; actionId: string; entity: string; title: string; body: string;
  assigneeRole?: string; assigneeUserId?: string; taxpayerId?: string; subject?: { type: string; id: string };
  status: 'ACTIF' | 'ANNULE'; createdAt: string; createdBy: string; createdByKind: 'ai' | 'user'; deliveries?: number;
  undoneAt?: string; undoneBy?: string; undoReason?: string; notice: string;
}

export interface IaRec {
  id: string; agentCode: string; agent: string; crossAgents: string[]; autonomy: Autonomy; status: IaStatus; entity: string;
  taxpayerId?: string; subject?: { type: string; id: string };
  situation: string; insight: string; risk: string; recommendation: string; nextAction: string; owner: string; deadline: string;
  confidence: Confidence; sources: string[];
  decision?: { bestOption: string; alternativeOption: string; riskOfInaction: string; financialImpact: string; operationalImpact: string };
  recommendedStep?: string; actions: IaAction[]; citations: IaCitation[]; factors?: { label: string; weight: string }[]; circuit?: string;
  example: boolean; modelVersion: string; promptVersion: string; inputHash: string; outputHash: string; purpose: string; requestedBy: string;
  createdAt: string; notice: string; decidedBy?: string; decidedByRole?: string; decidedAt?: string; decisionReason?: string;
  modification?: string; decisionLatencyMs?: number;
  canDecide: boolean; canValidate: boolean; canUndo: boolean; effects: IaEffect[];
}

export interface IaAgent {
  code: string; name: string; technicalName: string; mission: string; crossAgents: string[]; homeEntity: string; allowedData: string[];
  autonomy: Autonomy; allowedActions: { type: string; label: string; level: 'A' | 'B' }[]; runners: string[]; validators: string[];
  humanValidation: string; outputs: string; never: string; personal?: boolean; proactive: boolean; version: number;
  promptVersion: string; modelVersion: string; enabled: boolean; disabledReason?: string; canRun: boolean; canValidate: boolean;
  stats: { total: number; pending: number; auto: number; accepted: number; modified: number; rejected: number; undone: number; medianLatencyMs: number | null };
}

export interface AutonomySettings {
  entity: string; levelAEnabled: boolean; disabledActions: string[]; disabledAgents: string[]; updatedAt?: string; updatedBy?: string; reason?: string;
  canEdit: boolean; actions: { type: string; label: string }[];
}

export interface JournalEntry {
  id: string; at: string; type: string; agentCode: string; recommendationId?: string; entity: string;
  actor: { kind: 'ai' | 'user' | 'system'; id: string; role?: string }; purpose?: string; modelVersion?: string; promptVersion?: string;
  input?: { hash: string; domains: string[]; citations: IaCitation[]; masked: string[] };
  output?: { hash: string; autonomy: Autonomy; summary: string; actions: string[] };
  decision?: { decision: string; reason: string; role?: string; latencyMs?: number };
  action?: { id: string; type: string; effectId?: string }; detail?: string; auditId?: string;
}

export interface MemoryLevel { level: string; label: string; contenu: string; limites: string; conservation: string; consultation: string; effacement: string }
