/** Types et petits utilitaires partagés par les écrans du Trésor avancé. */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import type { Tone } from '../../components/StatusBadge';
import { api, describeError } from '../../lib/api';

export type ExceptionStatus = 'OUVERTE' | 'EN_COURS' | 'RESOLUE' | 'CLASSEE';
export type Queue = 'PAIEMENT_SANS_OBLIGATION' | 'OBLIGATION_SANS_REGLEMENT' | 'REGLEMENT_SANS_PAIEMENT' | 'ECART_MONTANT';

export interface TreasuryException {
  id: string; type: string; queue?: Queue; status: ExceptionStatus; paymentReference?: string; statementId?: string;
  line?: { accountAlias: string; amount: MoneyJSON; valueDate: string; paymentReference: string };
  detail: string; openedAt: string; dueAt?: string; ageHours?: number; overdue?: boolean; computed?: boolean;
  assignee?: string; assigneeName?: string;
  proposal?: { outcome: 'RESOLUE' | 'CLASSEE'; motif: string; action: 'AUCUNE' | 'MISE_EN_SUSPENS'; proposedBy: string; proposedAt: string };
  decision?: { approvedBy: string; approvedAt: string; suspenseId?: string };
  evidence?: { label: string; sha256?: string; note?: string; addedBy: string; addedAt: string }[];
  history?: { at: string; by: string; action: string; note?: string }[];
}
export interface ExceptionList { items: TreasuryException[]; queues: { queue: Queue; open: number; inProgress: number; closed: number; overdue: number }[]; slaHours: number }

export interface SuspenseItem {
  id: string; accountAlias: string; amount: MoneyJSON; valueDate: string; statementId?: string; paymentReference?: string; exceptionId?: string;
  justification: string; openedAt: string; openedBy: string; approvedBy?: string; ledgerEntryId: string; status: 'OUVERT' | 'APURE';
  clearing?: { operationId: string; mode: 'AFFECTATION' | 'RESTITUTION'; paymentReference?: string; at: string };
  demo?: boolean; ageDays?: number; bucket?: string; overSla?: boolean; overMax?: boolean;
}
export interface SuspenseList { items: SuspenseItem[]; open: number; totals: MoneyJSON[]; buckets: { bucket: string; count: number; amounts: MoneyJSON[] }[]; slaDays: number; maxDays: number }

export type OperationKind = 'ANNULATION_QUITTANCE' | 'REMPLACEMENT_QUITTANCE' | 'CONTREPASSATION' | 'REMBOURSEMENT' | 'CONTRE_ECRITURE' | 'APUREMENT_SUSPENS' | 'PARAMETRE_NOMENCLATURE';
export interface Operation {
  id: string; kind: OperationKind; status: 'PROPOSEE' | 'EXECUTEE' | 'REJETEE';
  input: { reason: string; publicReason?: string; receipt?: string; paymentReference?: string; ledgerEntryId?: string; suspenseId?: string; mode?: string };
  target: { label: string; amount?: MoneyJSON };
  proposedBy: string; proposedAt: string; decidedBy?: string; decidedAt?: string; decisionNote?: string; result?: Record<string, unknown>;
}

export interface DailyClosure {
  id: string; date: string; fromSeq: number; toSeq: number; entries: number; balanced: boolean;
  totals: { currency: string; debit: MoneyJSON; credit: MoneyJSON; balanced: boolean }[];
  openExceptions: number; openSuspense: number; unimputed: number; prevHash: string; hash: string; signature: string; closedBy: string; closedAt: string;
}
export interface MonthlyClosure { id: string; month: string; dailyClosures: string[]; imputed: number; prevHash: string; hash: string; closedBy: string; closedAt: string }
export interface Closures {
  daily: DailyClosure[]; monthly: MonthlyClosure[]; chain: { valid: boolean; brokenAt?: string }; today: string;
  lastClosedDate: string | null; unclosedEntries: number; oldestUnclosedDate: string | null; publicKeyPem: string;
}

export interface Overview {
  exceptions: { open: number; overdue: number; unassigned: number };
  suspense: { open: number; totals: MoneyJSON[]; oldestDays: number };
  operations: { pending: number };
  closures: { lastClosedDate: string | null; lastHash: string | null; chainValid: boolean };
  accounting: { imputed: number; unimputed: number };
}

export const QUEUE_LABEL: Record<Queue, string> = {
  PAIEMENT_SANS_OBLIGATION: 'Paiement sans obligation',
  OBLIGATION_SANS_REGLEMENT: 'Obligation payée sans règlement',
  REGLEMENT_SANS_PAIEMENT: 'Règlement sans paiement identifié',
  ECART_MONTANT: 'Écart de montant, de devise ou de compte',
};

export const EXC_STATUS: Record<ExceptionStatus, { label: string; tone: Tone }> = {
  OUVERTE: { label: 'Ouverte', tone: 'warning' },
  EN_COURS: { label: 'En cours', tone: 'info' },
  RESOLUE: { label: 'Résolue', tone: 'good' },
  CLASSEE: { label: 'Classée', tone: 'neutral' },
};

export const TYPE_LABEL: Record<string, string> = {
  ORPHAN_CREDIT: 'Crédit orphelin', CREDIT_WITHOUT_CONFIRMATION: 'Crédit sans confirmation', DUPLICATE_CREDIT: 'Crédit en double',
  WRONG_ACCOUNT: 'Mauvais compte', UNKNOWN_ACCOUNT: 'Compte inconnu du coffre', AMOUNT_MISMATCH: 'Écart de montant',
  MISSING_SETTLEMENT: 'Règlement manquant (J+1)', PROVIDER_AMBIGUOUS: 'Résultat opérateur inconnu',
};

export const OP_LABEL: Record<OperationKind, string> = {
  ANNULATION_QUITTANCE: 'Annulation de quittance',
  REMPLACEMENT_QUITTANCE: 'Remplacement de quittance',
  CONTREPASSATION: 'Contrepassation de paiement',
  REMBOURSEMENT: 'Remboursement',
  CONTRE_ECRITURE: 'Contre-écriture',
  APUREMENT_SUSPENS: 'Apurement de suspens',
  PARAMETRE_NOMENCLATURE: 'Paramètre de nomenclature',
};

export const OP_STATUS: Record<Operation['status'], { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'À valider', tone: 'warning' },
  EXECUTEE: { label: 'Validée et exécutée', tone: 'good' },
  REJETEE: { label: 'Rejetée', tone: 'neutral' },
};

export const hasRole = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));

/** Exécute une action et garde le message de retour (succès ou erreur RFC 9457). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run<T>(path: string, body: unknown, okText: string, onDone?: (r: T) => void): Promise<void> {
    setBusy(true); setMsg(null);
    try {
      const r = await api<T>(path, { method: 'POST', body });
      setMsg({ ok: true, text: okText });
      onDone?.(r);
    } catch (e) {
      const d = describeError(e);
      setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') });
    } finally { setBusy(false); }
  }
  return { busy, msg, setMsg, run };
}

export function Message({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>;
}

export const shortHash = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');
