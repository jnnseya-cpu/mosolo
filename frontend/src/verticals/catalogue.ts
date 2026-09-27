/**
 * Verticales (§ 11.3) — types et appels du contrat d'API du module « verticales ».
 * Le catalogue, les objets, obligations, quittances et démarches viennent du serveur (plus aucune donnée statique) :
 * chaque verticale partage le socle (compte unique, registre des règles, circuit de paiement vers le compte public).
 * Aucune règle sectorielle n'est certifiée : les montants proviennent de règles FICTIVES de démonstration, non opposables.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { api } from '../lib/api';

export type LegalStatus = 'BASE_A_CERTIFIER' | 'BASE_PARTIELLE' | 'ACTE_REQUIS' | 'CADRAGE_REQUIS';

export const LEGAL_TONE: Record<LegalStatus, 'good' | 'warning' | 'info' | 'neutral'> = {
  BASE_A_CERTIFIER: 'warning', BASE_PARTIELLE: 'warning', ACTE_REQUIS: 'info', CADRAGE_REQUIS: 'neutral',
};

export interface VerticalSummary {
  slug: string; name: string; short: string; icon: string; accent: string; modules: number[];
  legal: LegalStatus; legalLabel: string; acceptsLevies: boolean; entity: string; entityName: string; tutelle: string; release: string;
  audience: string; promise: string; vigilance: string; managedBy: string | null;
}

export interface ProcedureField { key: string; label: string; type: 'text' | 'number' | 'date' | 'select' | 'commune' | 'textarea'; required?: boolean; options?: { value: string; label: string }[]; hint?: string }
export interface Procedure {
  code: string; label: string; hint: string; kind: string; requiresObject: boolean; visit: 'OBLIGATOIRE' | 'OPTIONNELLE' | 'SANS';
  documents: string[]; fields: ProcedureField[]; protectedReport?: boolean;
}
export interface VerticalRule { code: string; version: number; label: string; status: string; demo: boolean; executable: boolean; notice: string }
export interface VerticalDetail extends VerticalSummary {
  prerequisites: string[]; objectsTitle: string; procedures: Procedure[]; pendingLevies: { label: string; basis: string }[]; rights: string[]; rules: VerticalRule[];
}

export interface VObject {
  id: string; label: string; ref: string; detail: string; category: string; objectType: string | null; commune: string; quartier: string;
  probativeStatus: 'DECLARE' | 'OBSERVE' | 'VERIFIE' | 'CONTESTE'; status: string;
  plate: { code: string; kind: string; status: string } | null; cessation: { dateEffet: string; caseId: string } | null;
}
export interface VObligation {
  id: string; label: string; objectId: string; ruleCode: string; ruleVersion: number; ruleStatus: string; demo: boolean; ruleNotice: string;
  amount: MoneyJSON; status: string; dueDate: string; commune: string | null; createdAt: string; payable: boolean;
  payment: { status: string; paymentReference: string; confirmedAt: string | null } | null;
}
export interface VReceipt { number: string; code: string; status: string; amount: MoneyJSON; paidAt: string; obligationId: string; label: string }
export interface CaseView {
  id: string; vertical: string; type: string; typeLabel: string; kind: string; status: string; statusLabel: string; entity: string; commune: string | null;
  objectId: string | null; createdAt: string; updatedAt: string; details: Record<string, string>; taxpayerId: string | null;
  documents: { label: string; sha256: string; addedAt: string; addedBy: string }[];
  visits: { id: string; date: string; result: string; observations: string; evidenceSha256?: string; by: string; at: string }[];
  history: { at: string; by: string; action: string; status: string; note?: string }[];
  proposal: { outcome: string; reason: string; by: string; at: string } | null; decision: { outcome: string; reason: string; by: string; at: string } | null;
  instructorId: string | null; createdObjectId: string | null; certificateCode: string | null; protectedReport: boolean; masked?: boolean;
  conditions?: { code: string; label: string; met: boolean }[];
}
export interface CertificateView { code: string; kind: string; label: string; vertical: string; caseId: string; objectId: string | null; commune: string | null; validFrom: string; validUntil: string | null; status: string }
export interface TitleView { id: string; period: 'JOUR' | 'SEMAINE' | 'MOIS'; days: number; obligationId: string; amount: MoneyJSON | null; status: string; statusLabel: string; validFrom: string | null; validUntil: string | null; createdAt: string }
export interface StallView {
  id: string; market: string; commune: string; row: string; number: string; category: string; objectId: string | null; plateCode: string | null;
  current: { status: string; statusLabel: string; validFrom?: string | null; validUntil: string | null }; titles: TitleView[];
}
export interface TicketingView { id: string; eventObjectId: string; ticketsSold: number; source: string; declaredAt: string; obligationId?: string; controls: { observedAttendance: number; gap: number; note: string; at: string }[] }

export interface VerticalSpaceData {
  vertical: VerticalDetail; taxpayerId: string; objects: VObject[]; obligations: VObligation[]; receipts: VReceipt[];
  cases: CaseView[]; certificates: CertificateView[]; stalls?: StallView[]; ticketing?: TicketingView[];
}

export interface AviaDeclaration {
  id: string; taxpayerId: string; period: string; status: string; statusLabel: string; declared: { flights: number; passengersDeparting: number; freightKg: number };
  declaredAt: string; aircraftObjectIds: string[];
  reconciliation?: { at: string; by: string; observed: { flights: number; passengersBoarded: number; passengersExited: number | null; freightKg: number }; gaps: { flights: number; passengers: number; passengersExited: number | null; freightKg: number }; passengerGapRate: string };
  contradictory?: { openedAt: string; deadline: string; observations: { at: string; by: string; text: string; documents: string[] }[] };
  validation?: { by: string; at: string; reason: string };
  billing: { at: string; by: string; outcome: string; reason: string; obligationId?: string }[];
}

export const OBJ_LABEL: Record<string, string> = { VERIFIE: 'Vérifié', DECLARE: 'Déclaré', OBSERVE: 'Observé', CONTESTE: 'Contesté' };
export const OBJ_MAP: Record<string, 'green' | 'amber' | 'red' | 'grey'> = { VERIFIE: 'green', DECLARE: 'amber', OBSERVE: 'amber', CONTESTE: 'red' };

export const OBLIGATION_LABEL: Record<string, string> = {
  EMISE: 'À payer', EXIGIBLE: 'Exigible', PARTIELLEMENT_PAYEE: 'Partiellement payée', SOLDEE: 'Soldée', EN_RETARD: 'En retard',
  CONTESTEE: 'Contestée — recouvrement suspendu', ANNULEE: 'Annulée', ADMISE_EN_NON_VALEUR: 'Admise en non-valeur',
};
export const OBLIGATION_TONE: Record<string, 'good' | 'warning' | 'serious' | 'info' | 'neutral'> = {
  EMISE: 'warning', EXIGIBLE: 'warning', PARTIELLEMENT_PAYEE: 'warning', SOLDEE: 'good', EN_RETARD: 'serious', CONTESTEE: 'info', ANNULEE: 'neutral', ADMISE_EN_NON_VALEUR: 'neutral',
};
export const CASE_TONE: Record<string, 'good' | 'warning' | 'serious' | 'info' | 'neutral'> = {
  DEPOSE: 'info', EN_INSTRUCTION: 'info', COMPLEMENT_DEMANDE: 'warning', PROPOSE: 'warning', ACCEPTE: 'good', REFUSE: 'serious',
};
/** Titres d'étal — règle 50 % / 1 % : VERT, AMBRE, ROUGE (< 1 %, encore valable), ECHU (validité échue). */
export const TITLE_TONE: Record<string, 'good' | 'warning' | 'serious' | 'critical' | 'info' | 'neutral'> = {
  VERT: 'good', AMBRE: 'warning', ROUGE: 'critical', ECHU: 'critical', GRIS: 'neutral', AUCUN: 'neutral', ANNULE: 'neutral',
};
export const TITLE_LABEL: Record<string, string> = {
  VERT: 'Valide', AMBRE: 'Valide — expire bientôt', ROUGE: 'Valide — expire très bientôt', ECHU: 'Échu', GRIS: 'En attente de paiement', AUCUN: 'Aucun titre',
};
export const PAYMENT_LABEL: Record<string, string> = { INITIE: 'Référence émise', CONFIRME: 'Paiement confirmé', REGLE: 'Réglé au compte public', RAPPROCHE: 'Rapproché' };
export const RECEIPT_LABEL: Record<string, string> = { PROVISOIRE: 'Provisoire — règlement en cours', DEFINITIVE: 'Définitive — rapprochée', ANNULEE: 'Annulée', REMPLACEE: 'Remplacée', SUSPECTE: 'Vérification en cours' };

export const COMMUNES = [
  'Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa', 'Kintambo', 'Kisenso', 'Lemba', 'Limete',
  'Lingwala', 'Makala', 'Maluku', 'Masina', 'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', 'Nsele', 'Selembao',
];

export const fetchCatalogue = () => api<{ items: VerticalSummary[]; notice: string }>('/v1/verticales');
export const fetchVertical = (slug: string) => api<VerticalDetail>(`/v1/verticales/${encodeURIComponent(slug)}`);
export const fetchSpace = (slug: string, taxpayerId?: string) =>
  api<VerticalSpaceData>(`/v1/verticales/${encodeURIComponent(slug)}/space${taxpayerId ? `?taxpayerId=${encodeURIComponent(taxpayerId)}` : ''}`);
export const fetchSummary = () => api<{ taxpayerId: string; items: { slug: string; objects: number; obligations: number; toPay: number; openCases: number }[] }>('/v1/verticales/me/summary');

/** Lien public de vérification d'une plaque ou d'un titre (QR). */
export const verifyPath = (code: string) => `/verifier-plaque/${encodeURIComponent(code)}`;

/** Montant en CDF, chaîne décimale (jamais de flottant pour un montant) — utilisé par la page RakaPay. */
export const cdf = (n: number) => ({ amount: `${n}.00`, currency: 'CDF' as const });

