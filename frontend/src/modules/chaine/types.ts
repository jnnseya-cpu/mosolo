/** Types des réponses « sept questions » et de la chaîne opératoire (backend/src/plugins/chaine). */
export type MaillonStatus = 'FAIT' | 'EN_ATTENTE' | 'SANS_OBJET' | 'BLOQUE';
export type AnswerStatus = 'REPONDU' | 'PARTIEL' | 'EN_ATTENTE' | 'MASQUE' | 'SANS_OBJET';

export interface Maillon {
  rang: number;
  code: string;
  label: string;
  garde: string;
  status: MaillonStatus;
  at: string | null;
  actor: { kind: string; id: string } | null;
  auditEventId: string | null;
  auditSeq: number | null;
  chainHash: string | null;
  evidence: { type: string; id: string; hash?: string }[];
  detail: string;
  reason?: string;
  rupture?: boolean;
  /** Maillon en attente ou bloqué : qui doit agir, où (écran du module) — jamais accompli depuis la chaîne. */
  aAgir?: AAgir;
}

export interface AAgir { qui: string; roles: string[]; ou: { label: string; path: string }[]; automatique: boolean; note: string }

export interface Answer {
  code: 'QUI' | 'QUOI' | 'OU' | 'REGLE' | 'COMBIEN' | 'PAYE' | 'COMPTE_PUBLIC';
  question: string;
  status: AnswerStatus;
  answer: string;
  sources: Record<string, unknown>;
}

export interface Chaine { obligationId: string | null; maillons: Maillon[]; complete: boolean; ruptures: number }

export interface SeptQuestionsView {
  objet: { id: string; ref: string; category: string; categoryLabel: string; commune: string; quartier: string; status: string; demo: boolean };
  obligation?: { id: string; label: string; status: string; ruleCode: string; ruleVersion: number };
  access: 'full' | 'minimal';
  generatedAt: string;
  questions: Answer[];
  chaine: Chaine;
  obligations?: { obligationId: string; label: string; status: string; current: boolean; complete: boolean; ruptures: number; maillons: Maillon[] }[];
  hiddenObligations?: number;
  notice?: string;
}

export interface RupturesView {
  scannedAt: string;
  total: number;
  counts: Record<string, number>;
  ruptures: { code: string; label: string; maillon: string; severity: string; resourceType: string; resourceId: string; detail: string }[];
  alertsRaised: number;
  automaticEffect: 'AUCUN';
}
