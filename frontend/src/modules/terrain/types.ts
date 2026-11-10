/** Types des réponses de l'API terrain (/v1/terrain/*, /v1/public/agent-badges/*). */
import type { MoneyJSON } from '@mosolo/shared';

export type SubcontractorStatus = 'INVITE' | 'EN_DILIGENCE' | 'ACCREDITE_PROBATOIRE' | 'ACCREDITE' | 'SUSPENDU' | 'RETIRE';
export type AgentStatus = 'INVITE' | 'HABILITE' | 'SUSPENDU' | 'REVOQUE';
export type MissionStatus = 'A_AFFECTER' | 'AFFECTEE' | 'EN_COURS' | 'TERMINEE' | 'ANNULEE';
export type FindingStatus = 'SOUMIS' | 'A_CONTRE_VISITER' | 'VALIDE' | 'REJETE';
export type FindingOutcome = 'CONSTATE' | 'ABSENT' | 'REFUS' | 'OBJET_NON_ENREGISTRE';
export type PublicBadgeResult = 'VALIDE' | 'SUSPENDU' | 'REVOQUE' | 'EXPIRE' | 'INCONNU';

export interface Badge {
  id: string; agentId: string; shortCode: string; qrToken: string; qrPath: string; module: string; communes: string[];
  validFrom: string; validUntil: string; status: 'ACTIF' | 'SUSPENDU' | 'REVOQUE';
}

export interface Habilitation {
  trainingCertificateRef: string; trainingValidUntil: string; deviceId: string; module: string; communes: string[]; validUntil: string; decidedBy: string; decidedAt: string;
}

export interface FieldAgent {
  id: string; displayName: string; subcontractorId?: string; entity: string; status: AgentStatus; invitedAt: string;
  declaredQuartiers: string[]; habilitation?: Habilitation; badge: Badge | null; demo?: boolean;
}

export interface Subcontractor {
  id: string; entity: string; name: string; rccm?: string; nif?: string; managers: string[]; capacityAgents: number; requestedModules: string[];
  status: SubcontractorStatus; selectionReference: string; invitedAt: string;
  diligence?: { legalExistence: boolean; taxClearance: boolean; noConflictOfInterest: boolean; publicAgentLinksDeclared: boolean; checkedBy: string; checkedAt: string; notes?: string };
  proposal?: { modules: string[]; communes: string[]; validUntil: string; probationUntil: string; reason: string; proposedBy: string; proposedAt: string };
  accreditation?: { modules: string[]; communes: string[]; validUntil: string; probationUntil: string; approvedBy: string; approvedAt: string; proposedBy: string };
  contract?: { reference: string; validatedFinding: MoneyJSON; missionOnTime: MoneyJSON; example: boolean };
  history: { at: string; by: string; from: string; to: string; reason: string }[];
  demo?: boolean;
}

export interface Lot {
  id: string; subcontractorId?: string; module: string; commune: string; quartiers: string[]; periodStart: string; periodEnd: string;
  maxAgents: number; probation: boolean; status: 'OUVERT' | 'CLOS'; demo?: boolean;
}

export interface MissionObject { id: string; category?: string; commune?: string; quartier?: string; lat?: number; lon?: number; status?: string; visited?: boolean; missing?: boolean }

export interface Mission {
  id: string; lotId?: string; subcontractorId?: string; module: string; kind: string; title: string; commune: string; quartier?: string;
  center: { lat: number; lon: number }; radiusM: number; objectIds: string[]; objects: MissionObject[]; objectives: { findings: number; objects?: number };
  instructions: string; periodStart: string; dueDate: string; assignedAgentId?: string; agentName: string | null; status: MissionStatus;
  toleranceM: number; overdue: boolean; demo?: boolean;
  progress: { findings: number; validated: number; rejected: number; flagged: number; objectivePct: string | null };
}

export interface Finding {
  id: string; clientRef: string; missionId: string; objectId?: string; agentId: string; agentName: string; subcontractorId?: string; commune: string;
  outcome: FindingOutcome; observations: string; gps: { lat: number; lon: number; accuracyM: number }; photoSha256?: string; capturedAt: string; receivedAt: string;
  reference: { kind: 'OBJET' | 'ZONE_MISSION'; lat: number; lon: number }; distanceM: number; toleranceM: number; flags: string[]; flagMessage?: string;
  justification?: string; seal: string; status: FindingStatus; review?: { by: string; at: string; decision: string; reason: string };
  counterVisit?: CounterVisit | null;
}

export interface CounterVisit {
  id: string; sampleId: string; findingId: string; originalAgentId: string; assignedTo?: string; assignedName?: string | null;
  status: 'A_AFFECTER' | 'A_FAIRE' | 'REALISEE'; result?: 'CONFORME' | 'NON_CONFORME'; notes?: string; performedAt?: string;
  distanceToOriginalM?: number; commune?: string; missionId?: string; objectId?: string | null; target?: { lat: number; lon: number };
}

export interface QualityRow {
  key: string; label: string; submitted: number; validated: number; rejected: number; pending: number; flagged: number;
  counterVisitsDone: number; nonConforming: number; errorRatePct: string | null; rejectionRatePct: string | null; confirmedRatePct: string | null;
  avgReviewDelayHours: string | null; mysteryChecks: number; mysteryIrregularities: number;
}

export interface QualityBoard { byAgent: QualityRow[]; bySubcontractor: QualityRow[]; samples: { id: string; ratePercent: number; population: number; randomSelected: string[]; riskSelected: string[]; createdAt: string }[]; method?: string }

export interface Indicators {
  missions: { total: number; byStatus: Record<MissionStatus, number>; overdue: number };
  findings: { total: number; validated: number; rejected: number; pending: number; flaggedPct: string | null; withPhotoPct: string | null; byDay: { date: string; count: number }[] };
  byCommune: { commune: string; missions: number; findings: number; validated: number; flagged: number; objectiveTarget: number; objectivePct: string | null; toleranceM: number }[];
  agents: { total: number; habilitated: number; invited: number; suspended: number };
  subcontractors: Record<SubcontractorStatus, number> | null;
  badgeVerifications: { total: number; byResult: Record<PublicBadgeResult, number> } | null;
  cashHandled: false;
}

export interface MeResponse {
  agent: { id: string; displayName: string; status: AgentStatus; structure: string; habilitation: Habilitation | null } | null;
  badge: Badge | null; missions: Mission[]; counterVisits: CounterVisit[]; devices: { id: string; status: string }[]; cashHandled: false;
}

export interface Remuneration {
  subcontractorId: string; available: boolean; reason?: string; indicative: true; example?: boolean; contractReference?: string; notice: string;
  deliverables: { validatedFindings: number; missionsOnTime: number; missionsLate: number; rejectedFindings: number; pendingFindings: number };
  lines?: { deliverable: string; count: number; unitPrice: MoneyJSON; amount: MoneyJSON }[]; total?: MoneyJSON | null;
}

export interface MysteryCheck {
  id: string; target: { kind: 'AGENT' | 'SOUS_TRAITANT'; id: string }; plannedFor: string; status: 'PLANIFIE' | 'REALISE';
  result?: 'SANS_IRREGULARITE' | 'IRREGULARITE'; notes?: string; performedAt?: string;
}

export interface PublicBadgeCheck {
  result: PublicBadgeResult; checkedAt: string; advice: string; reportable: boolean;
  badge?: { shortCode: string; displayName: string; structure: string; structureKind: 'REGIE' | 'SOUS_TRAITANT_ACCREDITE'; module: string; communes: string[]; validFrom: string; validUntil: string; hasPhoto: boolean; photoRef?: string };
}
