/**
 * Formes des réponses de l'API (specs/contrat-api.md).
 * Le contrat fixe les routes et les principaux champs ; les champs marqués « ? »
 * sont des hypothèses tolérantes : l'interface s'adapte si le backend les omet.
 */
import type {
  MoneyJSON, CurrencyCode, LanguageCode, MapStatusColor, ObligationStatus, PaymentStatus, ReceiptStatus,
  PublicReceiptCheck, ProbativeStatus, VerificationLevel, RuleSheet, AIRecommendation, Channel, Severity,
  CommunicationEvent, ResidentialSituation, TerritorialAttribution,
} from '@mosolo/shared';

export interface DemoUser { id: string; name: string; roles: string[]; entity?: string; taxpayerId?: string; territory?: string[] }

export interface FiscalObject {
  id: string; category: string; label?: string; commune?: string; quartier?: string; localityRank?: number;
  mapStatus?: MapStatusColor; probativeStatus?: ProbativeStatus; identifier?: string;
}

export interface Obligation {
  id: string; label?: string; ruleCode?: string; ruleId?: string; period?: string; amount: MoneyJSON;
  indicativeAmount?: MoneyJSON | { amount: MoneyJSON; rate?: string }; dueDate?: string; status: ObligationStatus | string; objectId?: string;
  /** § 20.3 : commune du fait générateur (lieu de l'objet), jamais l'adresse du contribuable. */
  attribution?: TerritorialAttribution;
}

export interface Receipt {
  id: string; code: string; number?: string; amount?: MoneyJSON; status: ReceiptStatus | string; issuedAt?: string;
  obligationId?: string; qr?: string; qrPayload?: string; category?: string;
}

export interface TaxpayerProfile {
  id: string; iuc?: string; fullName?: string; name?: string; phone?: string; language?: LanguageCode;
  verificationLevel?: VerificationLevel; objects?: FiscalObject[]; obligations?: Obligation[]; receipts?: Receipt[];
}

export interface ObligationExplanation {
  rule?: { id?: string; code?: string; label?: string; version?: number } | string;
  ruleCode?: string; ruleVersion?: number | string; version?: number | string;
  legalBasis?: (string | { id?: string; title?: string; status?: string })[] | string; articles?: string[]; formula?: string;
  inputs?: Record<string, unknown>; base?: Record<string, unknown>; rates?: Record<string, unknown>;
  amount?: MoneyJSON; dueDate?: string; appealPath?: string; trace?: unknown;
}
export interface ObligationDetail extends Obligation { explanation?: ObligationExplanation }

export interface PaymentOrder {
  paymentReference: string; amount: MoneyJSON; indicativeAmount?: MoneyJSON | { amount: MoneyJSON; rate?: string } | null; beneficiaryAlias?: string;
  expiresAt?: string; status: PaymentStatus | string; ussdInstructions?: string | string[];
}

export interface RegistrationResult { taxpayerId: string; iuc: string; verificationLevel: VerificationLevel }
export interface RegistrationInput { phone: string; fullName: string; language: LanguageCode; situation: ResidentialSituation | '' }

export interface PublicReceiptResult {
  status: PublicReceiptCheck; message?: string; amount?: MoneyJSON; date?: string; paidAt?: string; paidOn?: string; category?: string; revenueCategory?: string;
  beneficiary?: string; administration?: string; beneficiaryAdministration?: string; taxpayerRefLast4?: string; taxpayerRefSuffix?: string;
  replacedBy?: string; reason?: string; settlementStatus?: string; verifiedAt?: string;
}

export interface DraftSaveResult { version: number; savedAt: string; changeSummary?: string }
export interface DraftVersion { version: number; savedAt: string; changeSummary?: string; data?: unknown }
export interface DraftDoc<T = unknown> { key?: string; data: T; version?: number; savedAt?: string }

export interface ExchangeRates { date: string; source?: string; example?: boolean; /** CDF pour 1 unité */ rates: Partial<Record<CurrencyCode, string>> }

export interface GovernorTile { key: string; label?: string; value: MoneyJSON | number | string; hint?: string; tone?: 'good' | 'warning' | 'serious' | 'critical' }
export interface GovernorDashboard {
  example?: boolean; asOf?: string; currency?: CurrencyCode;
  tiles: {
    confirmedToday: MoneyJSON; settled: MoneyJSON; reconciled: MoneyJSON; reconciliationRate: number;
    criticalAlerts: number; confirmedDelta?: number; reconTarget?: number;
  };
  communes: { commune: string; amount: MoneyJSON; compliance?: number; target?: number }[];
  categories: { category: string; amount: MoneyJSON }[];
  ladder: { level: string; amount: MoneyJSON }[];
  trend: { day: number | string; actual: number; target: number }[];
  scenarios: { period: string; pessimistic: number; central: number; optimistic: number }[];
  alerts: { id: string; severity: 'critical' | 'serious' | 'warning' | 'good'; title: string; detail?: string; age?: string }[];
  actions?: AIRecommendation[];
  exchange?: { rate: string; date: string; source?: string };
}

export type DeliveryStatus = 'en_file' | 'envoye' | 'delivre' | 'lu' | 'echoue' | 'journalise' | 'supprime_par_preference' | string;
export interface Delivery {
  id: string; eventCode: string; channel: Channel | string; status: DeliveryStatus; provider?: string; at?: string;
  createdAt?: string; recipient?: string; entity?: string;
}
export interface CommunicationsOverview {
  example?: boolean;
  catalogue: { events: number; categories: number; mandatory: number };
  delivered: { delivered: number; attempted: number };
  connectedChannels: number | string[];
  coverage: { channel: Channel; events: number; sent?: number }[];
  recent: Delivery[];
}
export type CatalogueEvent = CommunicationEvent;

export interface Approval { role: string; userId: string; at: string }
export type LegalRule = RuleSheet;

export interface ReconciliationException {
  id: string; type?: string; reason?: string; paymentReference?: string; amount?: MoneyJSON; ageHours?: number;
  createdAt?: string; status?: string; statementId?: string;
}
export interface LedgerBalance { balanced: boolean; debit?: MoneyJSON | MoneyJSON[]; credit?: MoneyJSON | MoneyJSON[]; byCurrency?: Record<string, { debit: string; credit: string }> }

export interface VaultChangeRequest {
  id: string; alias: string; proposed?: { bankName?: string; accountNumber?: string; holderName?: string }; reason?: string;
  status: 'EN_ATTENTE_APPROBATION' | 'EN_REFROIDISSEMENT' | 'EFFECTIF' | string; approvals?: { userId: string; at: string }[];
  requestedBy?: string; requestedAt?: string; coolingEndsAt?: string; effectiveAt?: string;
}

export interface AuditVerify { ok: boolean; length: number; brokenAt?: number; reason?: string; headHash?: string; verifiedAt?: string }
export interface AuditEvent { id?: string; seq?: number; at?: string; timestamp?: string; actor?: string; action?: string; type?: string; subject?: string; hash?: string; prevHash?: string }

export interface FieldSyncResult { batchId?: string; accepted?: string[]; rejected?: { opId: string; reason: string }[]; conflicts?: { id: string; objectId?: string; field?: string }[]; replayed?: boolean }
export type { Channel, Severity };
