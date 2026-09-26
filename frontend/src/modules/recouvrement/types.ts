/** Types du contrat d'API « recouvrement » (backend/src/plugins/recouvrement) et aides d'affichage. */
import type { MoneyJSON } from '@mosolo/shared';
import type { Tone } from '../../components/StatusBadge';
import { describeError } from '../../lib/api';

export interface Blocker { code: string; detail: string }
export interface LegalBasisRef { id: string; title: string; status: string }

export interface Prescription {
  limitationYears: number; startsOn: string; prescribedOn: string; daysRemaining: number;
  state: 'EN_COURS' | 'PROCHE' | 'ATTEINTE_A_EXAMINER'; note: string;
}

export interface NextStep { kind: string | null; label: string; eligible: boolean; blockers: Blocker[] }

export interface Arrear {
  obligationId: string; taxpayerId: string; label: string; revenueCategory: string; ruleCode: string; entity: string;
  commune: string | null; amount: MoneyJSON; dueDate: string; ageDays: number; ageBand: string; status: string;
  prescription: Prescription; legalBasis: LegalBasisRef[]; caseId: string | null; plan: Plan | null; demo: boolean;
  segment?: { code: string; label: string; approach: string; reasons: string[] };
  risk?: { level: 'FAIBLE' | 'MOYEN' | 'ELEVE'; score: number; factors: string[] };
  recoverability?: { addressValid: boolean; blockers: Blocker[] };
  nextStep?: NextStep | null;
  steps?: { kind: string; label: string; doneOn: string; noticeId: string | null }[];
  pendingMeasure?: { id: string; measureType?: string; proposedAt: string }[];
}

export type MoneyByCurrency = Record<string, string>;
export interface Balance {
  count: number; total: MoneyByCurrency; byBand: Record<string, MoneyByCurrency>; byCategory: Record<string, MoneyByCurrency>;
  byCommune: Record<string, MoneyByCurrency>; bySegment: Record<string, number>; bands: { code: string; label: string }[];
}

export interface TimelineStep {
  kind: string; label: string; plannedOn: string | null; status: 'FAIT' | 'PROPOSEE' | 'ECHUE' | 'A_VENIR';
  doneOn: string | null; noticeId: string | null; proposalId: string | null; requiresDecision: boolean; demoHistoric: boolean;
}

export interface Proposal {
  id: string; caseId: string; obligationId: string; taxpayerId: string; kind: string; motivation: string;
  legalBasis?: { instrumentId: string; title: string; article: string }; measureType?: string | null;
  proposedBy: string; proposedAt: string; status: 'PROPOSEE' | 'APPROUVEE' | 'REJETEE';
  decision?: { decision: string; by: string; at: string; motivation: string } | null; noticeId?: string;
}

export interface RecoveryCase {
  id: string; obligationId: string; taxpayerId: string; openedAt: string; status: 'OUVERT' | 'REGULARISE' | 'CLASSE';
  observations: { at: string; by: string; text: string }[];
  obligation: { id: string; label: string; amount: MoneyJSON; dueDate: string; status: string; ruleCode: string; commune: string | null };
  timeline: TimelineStep[]; nextStep: NextStep; proposals: Proposal[];
  notices: { id: string; kind: string; issuedAt: string; readAt: string | null; notification: string }[];
  addressValid: boolean; demo?: boolean;
}

export interface Plan {
  id: string; taxpayerId: string; obligationId: string; requestedBy: string; requestedAt: string; requestedCount: number; reason: string;
  legalBasis: { instrumentId: string; title: string; demo: boolean };
  status: 'DEMANDE' | 'ACCORDE' | 'REFUSE' | 'DEFAILLANT' | 'SOLDE';
  decision?: { by: string; at: string; motivation: string; granted: boolean };
  installments: { seq: number; dueDate: string; amount: MoneyJSON }[];
  rows?: { seq: number; dueDate: string; amount: MoneyJSON; state: 'PAYEE' | 'A_ECHOIR' | 'ECHUE_IMPAYEE' }[];
  paid?: MoneyJSON; nextDue?: { seq: number; dueDate: string; amount: MoneyJSON } | null; defaultToExamine?: boolean;
  defaultRecord?: { by: string; at: string; motivation: string }; noticeId?: string;
}

export interface NoticeContent {
  number: string; kind: string; title: string; issuedOn: string; issuingAuthority: string; administeringEntity: string;
  taxpayer: { id: string; name: string; iuc: string };
  obligation: { id: string; label: string; ruleCode: string; ruleVersion: number; objectId: string; status: string };
  legalBasis: LegalBasisRef[]; articles: string[]; amount: MoneyJSON; dueDate: string;
  remedy: { path: string; delayDays: number; deadline: string; delayStatus: string };
  payment: { beneficiaryAccountAlias: string; paymentReference?: string; instructions: string };
  body: string[];
  decision?: { by: string; at: string; motivation: string; legalBasis?: { instrumentId: string; title: string; article: string } };
  installments?: { seq: number; dueDate: string; amount: MoneyJSON }[];
  mentions: string[]; demo: boolean;
}

export interface Notice {
  id: string; number: string; kind: string; taxpayerId: string; obligationId: string; issuedAt: string; issuedBy: string;
  content: NoticeContent; contentHash: string; eventCode: string; deliveryIds: string[]; notification: string;
  readAt?: string; readBy?: string; demo: boolean;
}

export interface NoticeProof {
  notice: { id: string; number: string; kind: string; issuedAt: string; contentHash: string; eventCode: string };
  deliveries: { id: string; at: string; channel: string; status: string; provider: string; providerMode: string; recipientMasked: string; contentHash: string }[];
  readAcknowledgement: { at: string; by: string } | null;
}

export interface Appeal {
  id: string; obligationId: string; taxpayerId: string; grounds: string; status: string; submittedAt: string; type?: string;
  documents?: { sha256: string; name: string; mediaType: string; addedAt: string }[];
  history?: { at: string; action: string; by: string; detail?: string }[];
  suspensiveEffect?: { status: 'NON_DEMANDE' | 'DEMANDE' | 'ACCORDE' | 'REFUSE'; decisionReason?: string };
  acknowledgement?: { number: string; at: string; contentHash: string };
  decision?: { decision: string; reason: string; at: string };
  nextRemedy?: { hierarchical: string; judicial: string };
  deadlines: { notifiedOn: string; filingDeadline: string; filedLate: boolean; decisionDueBy: string; daysRemaining: number | null; state: string };
}

export const NOTICE_KIND_LABEL: Record<string, string> = {
  AVIS_IMPOSITION: 'Avis d’imposition', RAPPEL: 'Rappel amiable', AVIS_ECHEANCE_DEPASSEE: 'Avis d’échéance dépassée',
  RELANCE: 'Relance et assistance', AVIS_FORMEL: 'Notification formelle', MISE_EN_DEMEURE: 'Mise en demeure',
  MESURE_ENVISAGEE: 'Mesure envisagée — vos droits', DECISION_MESURE: 'Décision de mesure', LEVEE_MESURE: 'Levée de mesure', ECHEANCIER: 'Échéancier',
};

export const PROPOSAL_KIND_LABEL: Record<string, string> = {
  AVIS_FORMEL: 'Notification formelle', MISE_EN_DEMEURE: 'Mise en demeure', MESURE_EXECUTION: 'Mesure d’exécution',
  LEVEE: 'Levée de mesure', CLASSEMENT: 'Classement motivé',
};

export const RISK_TONE: Record<string, Tone> = { FAIBLE: 'good', MOYEN: 'warning', ELEVE: 'serious' };
export const PLAN_TONE: Record<string, Tone> = { DEMANDE: 'info', ACCORDE: 'good', REFUSE: 'neutral', DEFAILLANT: 'critical', SOLDE: 'good' };
export const PLAN_LABEL: Record<string, string> = { DEMANDE: 'Demandé', ACCORDE: 'Accordé', REFUSE: 'Refusé', DEFAILLANT: 'Défaillance constatée', SOLDE: 'Soldé' };
export const INSTALLMENT_LABEL: Record<string, { label: string; tone: Tone }> = {
  PAYEE: { label: 'Payée', tone: 'good' }, A_ECHOIR: { label: 'À échoir', tone: 'neutral' }, ECHUE_IMPAYEE: { label: 'Échue impayée', tone: 'critical' },
};
export const STEP_TONE: Record<string, Tone> = { FAIT: 'good', PROPOSEE: 'info', ECHUE: 'warning', A_VENIR: 'neutral' };
export const STEP_STATUS_LABEL: Record<string, string> = { FAIT: 'Fait', PROPOSEE: 'Proposé — décision attendue', ECHUE: 'Date atteinte', A_VENIR: 'À venir' };
export const APPEAL_STATE: Record<string, { label: string; tone: Tone }> = {
  DANS_LE_DELAI: { label: 'Dans le délai', tone: 'good' }, ECHEANCE_PROCHE: { label: 'Échéance proche', tone: 'warning' },
  DELAI_DEPASSE: { label: 'Délai dépassé', tone: 'critical' }, DECIDE_DANS_LE_DELAI: { label: 'Décidé dans le délai', tone: 'good' },
  DECIDE_HORS_DELAI: { label: 'Décidé hors délai', tone: 'serious' },
};
export const SUSPENSIVE_LABEL: Record<string, string> = { NON_DEMANDE: 'Non demandé', DEMANDE: 'Demandé — décision attendue', ACCORDE: 'Accordé', REFUSE: 'Refusé' };

/** Message d'erreur lisible (code RFC 9457 entre parenthèses). */
export function errText(e: unknown): string {
  const d = describeError(e);
  return d.message + (d.code ? ` (${d.code})` : '');
}

export const hasRole = (roles: string[] | undefined, ...codes: string[]) => !!roles?.some((r) => codes.includes(r));

/** Montants par devise (chaînes décimales), jamais additionnés entre devises. */
export function moneyEntries(m: MoneyByCurrency | undefined): MoneyJSON[] {
  return Object.entries(m ?? {}).map(([currency, amount]) => ({ amount, currency }) as MoneyJSON);
}
