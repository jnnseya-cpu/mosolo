/**
 * Relevés de règlement et rapprochement à trois voies (ch. 20) :
 * obligation (dû) ↔ confirmation prestataire (payé) ↔ crédit sur compte public (arrivé), puis écriture.
 * Tout ce qui ne s'apparie pas devient une exception ; rien n'est forcé.
 */
import { AmountPrecisionError, Money, type MoneyJSON } from '@mosolo/shared';
import type { AuditActor, AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import { DAY_MS, kinshasaDate, type Clock } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AssessmentService } from '../assessment/service.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient, userRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import type { PaymentOrder, PaymentService, UnappliedPayment } from '../payments/service.js';
import { receiptPdf } from '../receipts/quittance-pdf.js';
import type { ReceiptService } from '../receipts/service.js';
import type { VaultService } from '../vault/service.js';
import type { LedgerService } from './ledger.js';

export interface StatementLine {
  accountAlias: string;
  amount: MoneyJSON;
  valueDate: string;
  paymentReference: string;
  /** Contrepartie (donneur d'ordre) : empreinte fournie par la banque ou le prestataire ; destination d'une restitution. */
  counterparty?: string;
  /** Version du compte du coffre en vigueur à l'import : renseignée par le système, jamais saisie. */
  accountVersion?: number;
  /**
   * Crédit groupé d'un prestataire (§ 20.1) : détail par référence de paiement issu du fichier de détail du prestataire.
   * Apparié automatiquement seulement si chaque détail s'apparie exactement et si le total égale le crédit.
   */
  details?: { paymentReference: string; amount: MoneyJSON }[];
  /** Empreinte SHA-256 du fichier de détail du prestataire (preuve du découpage). */
  detailFileSha256?: string;
}

export type ExceptionType =
  | 'ORPHAN_CREDIT' | 'CREDIT_WITHOUT_CONFIRMATION' | 'DUPLICATE_CREDIT' | 'WRONG_ACCOUNT' | 'UNKNOWN_ACCOUNT' | 'AMOUNT_MISMATCH' | 'MISSING_SETTLEMENT' | 'PROVIDER_AMBIGUOUS'
  | 'UNAPPLIED_PAYMENT'
  /** Crédit reçu alors que le compte du coffre a changé de version depuis l'émission de la référence. */
  | 'ACCOUNT_VERSION_MISMATCH'
  /** Crédit d'un paiement confirmé dont la quittance ne peut devenir définitive (annulée, signalée…) : rien n'est passé. */
  | 'RECEIPT_NOT_FINALIZABLE'
  /** Crédit groupé dont le fichier de détail ne s'apparie pas exactement (total, référence, montant ou compte). */
  | 'CREDIT_GROUPE_ECART';

/** Cycle de traitement d'une exception (§ 20, C3-113) : ouverte → en cours → résolue ou classée avec motif. */
export type ExceptionStatus = 'OUVERTE' | 'EN_COURS' | 'RESOLUE' | 'CLASSEE';

/** Les quatre files d'exception du § 20 (Cahier) / module 30. */
export type ExceptionQueue = 'PAIEMENT_SANS_OBLIGATION' | 'OBLIGATION_SANS_REGLEMENT' | 'REGLEMENT_SANS_PAIEMENT' | 'ECART_MONTANT';

export const EXCEPTION_QUEUE: Record<ExceptionType, ExceptionQueue> = {
  DUPLICATE_CREDIT: 'PAIEMENT_SANS_OBLIGATION',
  UNAPPLIED_PAYMENT: 'PAIEMENT_SANS_OBLIGATION',
  MISSING_SETTLEMENT: 'OBLIGATION_SANS_REGLEMENT',
  PROVIDER_AMBIGUOUS: 'OBLIGATION_SANS_REGLEMENT',
  ORPHAN_CREDIT: 'REGLEMENT_SANS_PAIEMENT',
  CREDIT_WITHOUT_CONFIRMATION: 'REGLEMENT_SANS_PAIEMENT',
  UNKNOWN_ACCOUNT: 'REGLEMENT_SANS_PAIEMENT',
  AMOUNT_MISMATCH: 'ECART_MONTANT',
  WRONG_ACCOUNT: 'ECART_MONTANT',
  ACCOUNT_VERSION_MISMATCH: 'ECART_MONTANT',
  RECEIPT_NOT_FINALIZABLE: 'REGLEMENT_SANS_PAIEMENT',
  CREDIT_GROUPE_ECART: 'ECART_MONTANT',
};

export interface ReconciliationException {
  id: string;
  type: ExceptionType;
  statementId?: string;
  paymentReference?: string;
  line?: StatementLine;
  detail: string;
  status: ExceptionStatus;
  openedAt: string;
  computed?: boolean;
  queue?: ExceptionQueue;
  /** Champs de traitement ajoutés par le module Trésor (affectation, échéance, résolution). */
  [workflow: string]: unknown;
}

export interface StatementResult {
  statementId: string;
  importedAt: string;
  importedBy: string;
  lines: number;
  matched: { paymentReference: string; receiptNumber: string; obligationId: string; amount: MoneyJSON; accountVersion?: number }[];
  /** Lignes ayant réglé un paiement non affecté (doublon, retard) : fonds arrivés, restitution unique ensuite. */
  settledUnapplied: { unappliedId: string; paymentReference: string; amount: MoneyJSON; ledgerEntryId: string }[];
  exceptions: ReconciliationException[];
  /** Lignes réclamées par un module (bordereau de versement d'un point agréé…) et appariées automatiquement. */
  claimed?: Record<string, unknown>[];
}

/**
 * Réclamation, SANS ÉCRITURE (phase 1), des lignes de relevé dont la référence n'est pas une référence de paiement
 * (ex. bordereau de versement d'un point agréé). Ligne réclamée : appariée par `apply` (phase 2), ou exception typée
 * (`exceptions`) à la place du « crédit orphelin » générique — jamais ignorée en silence.
 */
export interface StatementClaimant {
  (statementId: string, lines: StatementLine[]): {
    matched: StatementLine[];
    exceptions: { line: StatementLine; type: ExceptionType; detail: string }[];
    apply: (actor: AuditActor) => Record<string, unknown>[];
  };
}

type LinePlan =
  | { kind: 'EXCEPTION'; type: ExceptionType; line: StatementLine; detail: string }
  | { kind: 'MATCH'; order: PaymentOrder; line: StatementLine }
  | { kind: 'UNAPPLIED'; u: UnappliedPayment; line: StatementLine };

interface StoredStatement {
  id: string;
  fingerprint: string;
  result: StatementResult;
  /** Comptes publics crédités par le relevé (alias du coffre). */
  accounts?: string[];
  /** Total des lignes du relevé par devise (indicateur « écart grand livre / relevés », module 59). */
  lineTotals?: MoneyJSON[];
}

/** Résolution d'une exception constatée par le système (ex. versement de point agréé constaté au relevé). */
export interface ExceptionResolution { resolvedBy: string; resolvedAt: string; reference: string; motif: string }

/*
 * Double validation des imports de relevés (spécification fonctionnelle, module 29 « Contrôles : double validation des
 * imports » ; « Fonctions : contrôler l'intégrité des relevés »). Un relevé importé par une personne est une PROPOSITION :
 * rien n'est écrit (ni règlement, ni appariement, ni suspens) tant qu'une SECONDE personne habilitée, distincte, ne l'a
 * pas validé. Le contrôle d'intégrité est calculé au dépôt ; un contrôle bloquant en échec interdit la validation.
 */
const { always: ALWAYS } = GRANTS;
definePolicy('tresorerie:releve.proposer', { R17: ALWAYS, R18: ALWAYS });
definePolicy('tresorerie:releve.valider', { R17: ALWAYS, R18: ALWAYS });

export interface StatementIntegrityCheck {
  code: string;
  ok: boolean;
  /** Contrôle bloquant : en échec, la validation est impossible. Sinon : observation portée à la connaissance du valideur. */
  blocking: boolean;
  detail: string;
}

/** Métadonnées du fichier déposé (dépôt par fichier, module Trésor) : établissement, période, totaux de contrôle déclarés. */
export interface StatementFileSource {
  kind: 'BANQUE' | 'OPERATEUR';
  institution: string;
  fileName: string;
  fileSha256: string;
  period: { from: string; to: string };
  declared: { lines: number; totals: MoneyJSON[] };
  /** Erreurs de lecture du fichier (lignes illisibles) : contrôle bloquant. */
  readErrors?: string[];
}

export type StatementImportStatus = 'EN_ATTENTE_VALIDATION' | 'INTEGRITE_KO' | 'VALIDE' | 'REJETE';

export interface StatementImport {
  id: string;
  statementId: string;
  fingerprint: string;
  lines: StatementLine[];
  status: StatementImportStatus;
  integrity: { ok: boolean; checks: StatementIntegrityCheck[]; totals: MoneyJSON[] };
  source?: StatementFileSource;
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
  result?: { matched: number; exceptions: number; settledUnapplied: number; claimed: number };
}

function totalsByCurrency(lines: { amount: MoneyJSON }[]): MoneyJSON[] {
  const t = new Map<string, Money>();
  for (const l of lines) {
    const m = Money.fromJSON(l.amount);
    const prev = t.get(m.currency);
    t.set(m.currency, prev ? prev.add(m) : m);
  }
  return [...t.values()].map((m) => m.toJSON()).sort((a, b) => a.currency.localeCompare(b.currency));
}

export class TreasuryService {
  readonly statements = new InMemoryRepository<StoredStatement>();
  readonly exceptions = new InMemoryRepository<ReconciliationException>();
  /** Imports proposés (double validation) : proposition, contrôle d'intégrité, décision de la seconde personne. */
  readonly imports = new InMemoryRepository<StatementImport>();
  private readonly ids = new IdGenerator();
  /** Surcouche de traitement (affectation, statut, résolution) fournie par le module Trésor avancé. */
  private overlay: ((e: ReconciliationException) => ReconciliationException) | undefined;
  private readonly claimants: StatementClaimant[] = [];
  private readonly resolutionListeners: ((id: string, r: ExceptionResolution) => void)[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly users: UserDirectory,
    private readonly payments: PaymentService,
    private readonly assessment: AssessmentService,
    private readonly receipts: ReceiptService,
    private readonly vault: VaultService,
    private readonly ledger: LedgerService,
    private readonly taxpayers: TaxpayerService,
  ) {}

  /**
   * PROPOSITION d'import (première personne) : lecture stricte des montants, empreinte, contrôle d'intégrité ; AUCUNE
   * écriture. Rejeu idempotent : relevé déjà appliqué avec le même contenu ⇒ résultat d'origine ; même proposition en
   * attente ⇒ la même proposition. Contenu différent sous un même identifiant ⇒ 409.
   */
  proposeImport(user: User, input: { statementId: string; lines: StatementLine[]; source?: StatementFileSource }):
    { replayed: true; result: StatementResult } | { replayed: false; pending: StatementImport } {
    authorize(user, 'tresorerie:releve.proposer');
    input.lines.forEach((line, i) => {
      try {
        Money.parseStrict(line.amount);
      } catch (e) {
        throw unprocessable(e instanceof AmountPrecisionError ? 'AMOUNT_PRECISION' : 'INVALID_AMOUNT', `Ligne ${i + 1} du relevé ${input.statementId} : ${(e as Error).message}. Aucune ligne importée.`, { line: i + 1 });
      }
    });
    const fingerprint = sha256Hex(canonicalJson(input.lines));
    const applied = this.statements.get(input.statementId);
    if (applied) {
      if (applied.fingerprint !== fingerprint) throw conflict('STATEMENT_ALREADY_IMPORTED', `Relevé ${input.statementId} déjà importé avec un contenu différent.`);
      return { replayed: true, result: applied.result };
    }
    const open = this.imports.findOne((i) => i.statementId === input.statementId && i.status === 'EN_ATTENTE_VALIDATION');
    if (open) {
      if (open.fingerprint !== fingerprint) throw conflict('STATEMENT_PENDING_DIFFERENT', `Relevé ${input.statementId} déjà proposé avec un contenu différent : attendre la décision sur la proposition ${open.id}.`);
      return { replayed: false, pending: open };
    }
    const now = this.clock.now();
    const today = kinshasaDate(now);
    const checks: StatementIntegrityCheck[] = [];
    const check = (code: string, ok: boolean, blocking: boolean, detail: string) => checks.push({ code, ok, blocking, detail });
    const totals = totalsByCurrency(input.lines);
    check('EMPREINTE', true, true, `Empreinte SHA-256 du contenu : ${fingerprint.slice(0, 16)}… (${input.lines.length} ligne(s)).`);
    const src = input.source;
    if (src) {
      check('LECTURE_FICHIER', !src.readErrors?.length, true, src.readErrors?.length ? src.readErrors.slice(0, 5).join(' ') : `Fichier ${src.fileName} lu sans erreur.`);
      check('NOMBRE_LIGNES', src.declared.lines === input.lines.length, true, `${input.lines.length} ligne(s) lue(s) pour ${src.declared.lines} déclarée(s) par l’établissement.`);
      const declared = [...src.declared.totals].map((m) => Money.parseStrict(m).toJSON()).sort((a, b) => a.currency.localeCompare(b.currency));
      const same = canonicalJson(declared) === canonicalJson(totals);
      check('TOTAUX_CONTROLE', same, true, same ? 'Totaux par devise égaux aux totaux de contrôle déclarés.'
        : `Totaux lus ${totals.map((m) => `${m.amount} ${m.currency}`).join(', ') || '—'} ≠ totaux déclarés ${declared.map((m) => `${m.amount} ${m.currency}`).join(', ') || '—'}.`);
      const out = input.lines.filter((l) => l.valueDate < src.period.from || l.valueDate > src.period.to);
      check('PERIODE', out.length === 0 && src.period.from <= src.period.to, true, out.length ? `${out.length} ligne(s) hors de la période ${src.period.from} → ${src.period.to}.` : `Dates de valeur dans la période ${src.period.from} → ${src.period.to}.`);
      const replay = this.imports.findOne((i) => i.source?.fileSha256 === src.fileSha256 && i.statementId !== input.statementId && i.status !== 'REJETE' && i.status !== 'INTEGRITE_KO');
      check('REJEU_FICHIER', !replay, true, replay ? `Fichier identique déjà déposé sous le relevé ${replay.statementId}.` : 'Fichier jamais déposé sous un autre relevé.');
    } else {
      check('TOTAUX', true, false, `Totaux calculés : ${totals.map((m) => `${m.amount} ${m.currency}`).join(', ') || '—'} (aucun total de contrôle déclaré : dépôt par fichier recommandé).`);
    }
    const seen = new Set<string>();
    const dup = input.lines.filter((l) => { const k = `${l.accountAlias}|${l.paymentReference}|${l.amount.amount}|${l.amount.currency}|${l.valueDate}`; if (seen.has(k)) return true; seen.add(k); return false; }).length;
    check('DOUBLONS', dup === 0, false, dup ? `${dup} ligne(s) répétée(s) à l’identique : elles deviendront des exceptions « crédit en double » si elles sont validées.` : 'Aucune ligne répétée.');
    const future = input.lines.filter((l) => l.valueDate > today).length;
    check('DATES_FUTURES', future === 0, false, future ? `${future} ligne(s) datée(s) après le jour du serveur (${today}).` : `Aucune date de valeur après le jour du serveur (${today}).`);
    const unknown = [...new Set(input.lines.filter((l) => !this.vault.current(l.accountAlias)).map((l) => l.accountAlias))];
    check('COMPTES_COFFRE', unknown.length === 0, false, unknown.length ? `Compte(s) inconnu(s) du coffre : ${unknown.join(', ')} (exception « compte inconnu » si validé).` : 'Comptes crédités connus du coffre des bénéficiaires.');
    const ok = checks.every((c) => c.ok || !c.blocking);
    const pending = this.imports.insert({
      id: this.ids.next('IMP-REL'), statementId: input.statementId, fingerprint, lines: input.lines, status: ok ? 'EN_ATTENTE_VALIDATION' : 'INTEGRITE_KO',
      integrity: { ok, checks, totals }, ...(src ? { source: src } : {}), proposedBy: user.id, proposedAt: now.toISOString(),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: ok ? 'settlement.import.proposed' : 'settlement.import.integrity_failed',
      resourceType: 'statement_import', resourceId: pending.id, outcome: ok ? 'SUCCESS' : 'FAILURE',
      details: { statementId: input.statementId, fingerprint, lines: input.lines.length, failed: checks.filter((c) => !c.ok).map((c) => c.code), ...(src ? { fileSha256: src.fileSha256, institution: src.institution } : {}) },
    });
    if (ok) {
      const validators = [...this.users.withRole('R17'), ...this.users.withRole('R18')].filter((u) => u.id !== user.id);
      this.comms.publish('approval.requested', validators.map(userRecipient), { objet: `Validation du relevé ${input.statementId} (${input.lines.length} ligne(s))` }, { entity: 'TRESOR' });
    }
    return { replayed: false, pending };
  }

  /** Imports proposés (plus récents d'abord), avec leur contrôle d'intégrité et leur décision. */
  listImports(user: User): StatementImport[] {
    authorize(user, 'reconciliation.read');
    return this.imports.all().slice().reverse();
  }

  /**
   * SECONDE validation : une personne habilitée DISTINCTE du proposant approuve (le relevé est alors appliqué :
   * appariement, règlement, suspens, quittances définitives) ou rejette avec motif. Intégrité en échec : impossible.
   */
  validateImport(user: User, statementId: string, input: { approve: boolean; motif: string }): { pending: StatementImport; result?: StatementResult } {
    authorize(user, 'tresorerie:releve.valider');
    const pending = this.imports.findOne((i) => i.statementId === statementId && (i.status === 'EN_ATTENTE_VALIDATION' || i.status === 'INTEGRITE_KO'))
      ?? this.imports.find((i) => i.statementId === statementId).at(-1);
    if (!pending) throw notFound('STATEMENT_IMPORT_NOT_FOUND', `Aucun import proposé pour le relevé ${statementId}.`);
    if (pending.status === 'INTEGRITE_KO') throw conflict('STATEMENT_INTEGRITY_FAILED', `Intégrité du relevé ${statementId} en échec : validation impossible ; déposer un relevé conforme.`);
    if (pending.status !== 'EN_ATTENTE_VALIDATION') throw conflict('STATEMENT_IMPORT_DECIDED', `Import du relevé ${statementId} déjà décidé (${pending.status}).`);
    assertDistinctPerson(user.id, [pending.proposedBy], 'Double validation : la personne qui a proposé l’import du relevé ne peut pas le valider.');
    if (input.motif.trim().length < 5) throw unprocessable('MOTIF_REQUIRED', 'Motif de la décision obligatoire (5 caractères au moins).');
    const at = this.clock.now().toISOString();
    let result: StatementResult | undefined;
    if (input.approve) result = this.applyStatement(user, { statementId, lines: pending.lines }).result;
    const updated = this.imports.update({
      ...pending, status: input.approve ? 'VALIDE' : 'REJETE', decision: { by: user.id, at, approve: input.approve, motif: input.motif.trim() },
      ...(result ? { result: { matched: result.matched.length, exceptions: result.exceptions.length, settledUnapplied: result.settledUnapplied.length, claimed: result.claimed?.length ?? 0 } } : {}),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: input.approve ? 'settlement.import.validated' : 'settlement.import.rejected',
      resourceType: 'statement_import', resourceId: pending.id, reason: input.motif.trim(),
      approvalChain: [{ by: pending.proposedBy, step: 'PROPOSITION', at: pending.proposedAt }, { by: user.id, step: 'VALIDATION', at, decision: input.approve ? 'APPROUVE' : 'REFUSE' }],
      details: { statementId, fingerprint: pending.fingerprint, proposedBy: pending.proposedBy, motif: input.motif.trim() },
    });
    return { pending: updated, ...(result ? { result } : {}) };
  }

  /**
   * Application directe d'un relevé (usage interne des modules et des outils d'exploitation habilités « settlement.import ») ;
   * la route publique passe par la proposition puis la seconde validation.
   */
  importStatement(user: User, input: { statementId: string; lines: StatementLine[] }): { replayed: boolean; result: StatementResult } {
    authorize(user, 'settlement.import');
    return this.applyStatement(user, input);
  }

  private applyStatement(user: User, input: { statementId: string; lines: StatementLine[] }): { replayed: boolean; result: StatementResult } {
    const fingerprint = sha256Hex(canonicalJson(input.lines));
    const existing = this.statements.get(input.statementId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw conflict('STATEMENT_ALREADY_IMPORTED', `Relevé ${input.statementId} déjà importé avec un contenu différent.`);
      return { replayed: true, result: existing.result };
    }
    const now = this.clock.now().toISOString();
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    this.audit.append({ actor, action: 'settlement.received', resourceType: 'statement', resourceId: input.statementId, details: { lines: input.lines.length } });

    // Phase 1 — validation et plan, SANS AUCUNE ÉCRITURE : tout le relevé est accepté ou rien ne l'est.
    // Montants lus strictement (aucun arrondi : « 149.995 » n'est jamais 150.00).
    input.lines.forEach((line, i) => {
      try {
        Money.parseStrict(line.amount);
      } catch (e) {
        throw unprocessable(e instanceof AmountPrecisionError ? 'AMOUNT_PRECISION' : 'INVALID_AMOUNT', `Ligne ${i + 1} du relevé ${input.statementId} : ${(e as Error).message}. Aucune ligne importée.`, { line: i + 1 });
      }
    });
    const plans: LinePlan[] = [];
    const matchedOrders = new Set<string>();
    const usedUnapplied = new Set<string>();
    for (const raw of input.lines) {
      const account = this.vault.current(raw.accountAlias);
      const line: StatementLine = { ...raw, ...(account ? { accountVersion: account.version } : {}) };
      const exception = (type: ExceptionType, detail: string) => plans.push({ kind: 'EXCEPTION', type, line, detail });
      if (!account) {
        exception('UNKNOWN_ACCOUNT', `Compte ${line.accountAlias} inconnu du coffre.`);
        continue;
      }
      const credited = Money.parseStrict(line.amount);
      const order = this.payments.byReference(line.paymentReference);
      if (!order) {
        exception('ORPHAN_CREDIT', 'Crédit sans référence de paiement connue : recherche prestataire.');
        continue;
      }
      if (order.status === 'CONFIRME' && !matchedOrders.has(order.id)) {
        if (order.beneficiaryAlias !== line.accountAlias) {
          exception('WRONG_ACCOUNT', `Crédit sur ${line.accountAlias} au lieu de ${order.beneficiaryAlias}.`);
          continue;
        }
        if (!credited.equals(Money.fromJSON(order.amount))) {
          exception('AMOUNT_MISMATCH', `Montant crédité ${line.amount.amount} ${line.amount.currency} ≠ ${order.amount.amount} ${order.amount.currency}.`);
          continue;
        }
        if (order.beneficiaryAccountVersion !== undefined && order.beneficiaryAccountVersion !== account.version) {
          exception('ACCOUNT_VERSION_MISMATCH', `Référence ${order.paymentReference} émise sous la version ${order.beneficiaryAccountVersion} du compte ${line.accountAlias}, crédit reçu sous la version ${account.version} : vérification du changement de compte requise.`);
          continue;
        }
        const blocker = this.matchBlocker(order);
        if (blocker) {
          exception('RECEIPT_NOT_FINALIZABLE', blocker);
          continue;
        }
        matchedOrders.add(order.id);
        plans.push({ kind: 'MATCH', order, line });
        continue;
      }
      // Doublon ou paiement tardif déjà en compte d'attente : la ligne RÈGLE ce paiement non affecté (un seul suspens,
      // une seule restitution possible), elle n'ouvre jamais un second suspens.
      const u = this.payments.findSettleableUnapplied(line.paymentReference, credited, line.accountAlias, usedUnapplied);
      if (u) {
        usedUnapplied.add(u.id);
        plans.push({ kind: 'UNAPPLIED', u, line });
        continue;
      }
      if (order.status === 'RAPPROCHE' || order.status === 'REGLE' || matchedOrders.has(order.id)) {
        exception('DUPLICATE_CREDIT', `Crédit en double pour ${order.paymentReference}.`);
        continue;
      }
      exception('CREDIT_WITHOUT_CONFIRMATION', `Crédit reçu sans confirmation prestataire vérifiée (statut ${order.status}).`);
    }
    // Crédits orphelins soumis aux modules (bordereaux de versement) : appariés ou requalifiés, toujours sans écriture ici.
    const applies: ((a: AuditActor) => Record<string, unknown>[])[] = [];
    for (const claim of this.claimants) {
      const orphans = plans.filter((p): p is Extract<LinePlan, { kind: 'EXCEPTION' }> => p.kind === 'EXCEPTION' && p.type === 'ORPHAN_CREDIT').map((p) => p.line);
      if (orphans.length === 0) break;
      const r = claim(input.statementId, orphans);
      const matched = new Set(r.matched);
      const requalified = new Map(r.exceptions.map((e) => [e.line, e]));
      for (let i = plans.length - 1; i >= 0; i--) {
        const p = plans[i]!;
        if (p.kind !== 'EXCEPTION' || p.type !== 'ORPHAN_CREDIT') continue;
        if (matched.has(p.line)) plans.splice(i, 1);
        else if (requalified.has(p.line)) plans[i] = { kind: 'EXCEPTION', ...requalified.get(p.line)! };
      }
      applies.push(r.apply);
    }

    // Phase 2 — application.
    const result: StatementResult = { statementId: input.statementId, importedAt: now, importedBy: user.id, lines: input.lines.length, matched: [], settledUnapplied: [], exceptions: [] };
    for (const p of plans) {
      if (p.kind === 'EXCEPTION') {
        const ex = this.exceptions.insert({
          id: this.ids.next('EXC'), type: p.type, statementId: input.statementId, paymentReference: p.line.paymentReference, line: p.line, detail: p.detail, status: 'OUVERTE', openedAt: now,
        });
        result.exceptions.push(ex);
        this.audit.append({ actor, action: 'reconciliation.exception.opened', resourceType: 'reconciliation_exception', resourceId: ex.id, outcome: 'FAILURE', details: { type: p.type, paymentReference: p.line.paymentReference } });
      } else if (p.kind === 'MATCH') {
        // Appariement complet : écriture, RAPPROCHE, quittance définitive, obligation soldée.
        const m = this.completeMatch(p.order.id, {
          debit: 'COMPTE_PUBLIC_RECETTES', description: `Crédit ${p.line.accountAlias} (${input.statementId}) pour ${p.order.paymentReference}`,
          actor, details: { statementId: input.statementId, accountVersion: p.line.accountVersion ?? null },
        });
        const { ledgerEntryId: _l, ...matched } = m;
        result.matched.push({ ...matched, ...(p.line.accountVersion !== undefined ? { accountVersion: p.line.accountVersion } : {}) });
      } else {
        result.settledUnapplied.push(this.settleUnapplied(p.u, { statementId: input.statementId, ...(p.line.accountVersion !== undefined ? { accountVersion: p.line.accountVersion } : {}), actor }));
      }
    }
    const claimed = applies.flatMap((a) => a(actor));
    if (claimed.length > 0) result.claimed = claimed;
    if (result.exceptions.length > 0) {
      this.comms.publish('reconciliation.exception.opened', this.users.withRole('R18').map(userRecipient), { reference: input.statementId }, { entity: 'TRESOR' });
    }
    const totals = new Map<string, Money>();
    for (const l of input.lines) {
      const m = Money.parseStrict(l.amount);
      totals.set(m.currency, (totals.get(m.currency) ?? Money.zero(m.currency)).add(m));
    }
    this.statements.insert({
      id: input.statementId, fingerprint, result, accounts: [...new Set(input.lines.map((l) => l.accountAlias))].sort(),
      lineTotals: [...totals.values()].map((m) => m.toJSON()).sort((a, b) => a.currency.localeCompare(b.currency)),
    });
    return { replayed: false, result };
  }

  /**
   * Clôt la chaîne d'un paiement confirmé : écriture de règlement, RAPPROCHE, quittance définitive, obligation soldée.
   * `debit` : compte public (relevé) ou compte d'attente (apurement d'un suspens décidé à quatre yeux).
   */
  completeMatch(orderId: string, opts: { debit: 'COMPTE_PUBLIC_RECETTES' | 'COMPTE_ATTENTE'; description: string; actor: AuditActor; details?: Record<string, unknown> }) {
    const order = this.payments.orders.get(orderId);
    if (!order || order.status !== 'CONFIRME') throw conflict('PAYMENT_NOT_CONFIRMED', `Le paiement ${order?.paymentReference ?? orderId} n'est pas au statut confirmé.`);
    // Tout est vérifié AVANT la moindre écriture : jamais d'écriture ni de RAPPROCHE sans quittance définitive.
    const blocker = this.matchBlocker(order);
    if (blocker) throw conflict('RECEIPT_NOT_FINALIZABLE', blocker);
    const entry = this.ledger.postPair({
      eventType: 'SETTLEMENT_CREDITED', description: opts.description,
      sourceType: 'payment_order', sourceId: order.id, debit: opts.debit, credit: 'FONDS_A_RECEVOIR_PRESTATAIRES', amount: order.amount,
    });
    this.payments.settleAndReconcile(order.id, entry.id);
    const receipt = this.receipts.finalize(order.id);
    // Échéancier : l'obligation n'est soldée que lorsque le cumul payé atteint son montant. Un paiement reçu sur une
    // obligation depuis rectifiée compte pour l'obligation en vigueur ; une obligation ANNULEE ne change jamais d'état.
    const ob = this.assessment.get(this.payments.currentObligationId(order.obligationId));
    const fully = this.payments.paidOn(ob.id).compare(Money.fromJSON(ob.amount)) >= 0;
    const obligation = ob.status === 'ANNULEE' ? ob : this.assessment.setStatus(ob.id, fully ? 'SOLDEE' : 'PARTIELLEMENT_PAYEE');
    this.audit.append({ actor: opts.actor, action: 'reconciliation.matched', resourceType: 'payment_order', resourceId: order.id, details: { ...opts.details, receipt: receipt.number, ledgerEntryId: entry.id } });
    // Quittance définitive envoyée par courriel avec son PDF signé (§ 18A.4) ; la page web imprimable reste disponible.
    const pdf = receiptPdf(receipt, this.receipts, { paymentStatus: 'RAPPROCHE', generatedAt: this.clock.now().toISOString() });
    this.comms.publish('receipt.finalized', [taxpayerRecipient(this.taxpayers.get(order.taxpayerId))], { reference: receipt.number }, {
      entity: obligation.entity, attachments: [{ name: pdf.fileName, contentType: 'application/pdf', sha256: sha256Hex(pdf.bytes), size: pdf.bytes.length, content: pdf.bytes }],
    });
    return { paymentReference: order.paymentReference, receiptNumber: receipt.number, obligationId: obligation.id, amount: order.amount, ledgerEntryId: entry.id };
  }

  /**
   * Motif empêchant d'apparier un paiement confirmé (sans rien écrire) : quittance absente ou non finalisable,
   * obligation ou contribuable introuvable. `undefined` : appariement possible.
   */
  matchBlocker(order: PaymentOrder): string | undefined {
    const r = this.receipts.byPaymentOrder(order.id);
    if (!r) return `Aucune quittance pour ${order.paymentReference} : appariement impossible.`;
    if (r.status !== 'PROVISOIRE' && r.status !== 'DEFINITIVE') return `Quittance ${r.number} au statut ${r.status} pour ${order.paymentReference} : elle ne peut devenir définitive, aucun appariement.`;
    try {
      this.assessment.get(this.payments.currentObligationId(order.obligationId));
      this.taxpayers.get(order.taxpayerId);
    } catch (e) {
      return `Paiement ${order.paymentReference} : ${(e as Error).message}`;
    }
    return undefined;
  }

  /**
   * Règlement par le prestataire d'un paiement non affecté (doublon, retard) : les fonds arrivent sur le compte public
   * (débit compte public, crédit créance sur le prestataire). Le suspens déjà ouvert reste le SEUL restituable.
   */
  settleUnapplied(u: UnappliedPayment, opts: { statementId: string; accountVersion?: number; actor: AuditActor }) {
    const st = this.payments.unappliedState(u.id);
    if (st?.settled) throw conflict('UNAPPLIED_ALREADY_SETTLED', `Le paiement non affecté ${u.id} est déjà réglé (${st.settled.statementId}).`);
    if (st?.restituted) throw conflict('UNAPPLIED_ALREADY_RESTITUTED', `Le paiement non affecté ${u.id} est déjà restitué.`);
    const entry = this.ledger.postPair({
      eventType: 'UNAPPLIED_SETTLED', description: `Règlement prestataire du paiement non affecté ${u.id} (${u.paymentReference}) sur relevé ${opts.statementId}`,
      sourceType: 'unapplied_payment', sourceId: u.id, debit: 'COMPTE_PUBLIC_RECETTES', credit: 'FONDS_A_RECEVOIR_PRESTATAIRES', amount: u.amount,
    });
    this.payments.markUnappliedSettled(u.id, {
      statementId: opts.statementId, ledgerEntryId: entry.id, at: this.clock.now().toISOString(), ...(opts.accountVersion !== undefined ? { accountVersion: opts.accountVersion } : {}),
    });
    this.audit.append({ actor: opts.actor, action: 'reconciliation.unapplied_settled', resourceType: 'unapplied_payment', resourceId: u.id, details: { statementId: opts.statementId, paymentReference: u.paymentReference, ledgerEntryId: entry.id } });
    return { unappliedId: u.id, paymentReference: u.paymentReference, amount: u.amount, ledgerEntryId: entry.id };
  }

  /** Branche un module réclamant des lignes de relevé à référence non-paiement (bordereaux des points agréés). */
  addStatementClaimant(fn: StatementClaimant): void {
    this.claimants.push(fn);
  }

  /** Exception vue avec sa surcouche de traitement (statut, proposition), sans contrôle d'accès : usage interne des modules. */
  private view(e: ReconciliationException): ReconciliationException {
    return this.overlay ? this.overlay(e) : e;
  }

  /**
   * Crédits orphelins d'un relevé encore disponibles pour un appariement : ni résolus ni classés, sans proposition de
   * résolution en cours (mise en suspens…), filtrés par `fn`.
   */
  openOrphanCredits(fn: (e: ReconciliationException) => boolean): ReconciliationException[] {
    return this.exceptions.find((e) => e.type === 'ORPHAN_CREDIT' && !!e.line && fn(e)).map((e) => this.view(e))
      .filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE' && !e.proposal);
  }

  /**
   * Exceptions de relevé (ligne constatée) encore ouvertes, sans proposition de résolution en cours, filtrées par `fn` :
   * base du rapprochement PROPOSÉ (§ 20.1), qui n'apparie jamais sans confirmation humaine.
   */
  openStatementExceptions(fn: (e: ReconciliationException) => boolean = () => true): ReconciliationException[] {
    return this.exceptions.find((e) => !!e.line && fn(e)).map((e) => this.view(e))
      .filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE' && !e.proposal);
  }

  /** Requalifie une exception de relevé (type et motif) : elle reste dans la file, jamais supprimée ; journalisé. */
  requalifyException(id: string, type: ExceptionType, detail: string, actor: AuditActor): void {
    const e = this.exceptions.get(id);
    if (!e) throw conflict('EXCEPTION_NOT_FOUND', `Exception inconnue : ${id}`);
    this.exceptions.update({ ...e, type, detail, requalifiedFrom: e.type });
    this.audit.append({ actor, action: 'reconciliation.exception.requalified', resourceType: 'reconciliation_exception', resourceId: id, details: { from: e.type, to: type } });
  }

  /**
   * Résout des exceptions de relevé dont le crédit est expliqué (ex. versement constaté au relevé) : statut RESOLUE avec
   * référence et approbateur, jamais supprimées ; journalisé. La surcouche de traitement (module Trésor) est notifiée.
   */
  resolveExceptions(ids: string[], r: Omit<ExceptionResolution, 'resolvedAt'>, actor: AuditActor): void {
    const resolvedAt = this.clock.now().toISOString();
    for (const id of ids) {
      const e = this.exceptions.get(id);
      if (!e || e.status === 'RESOLUE') continue;
      const resolution: ExceptionResolution = { ...r, resolvedAt };
      this.exceptions.update({ ...e, status: 'RESOLUE', resolution });
      for (const fn of this.resolutionListeners) fn(id, resolution);
      this.audit.append({ actor, action: 'reconciliation.exception.resolved', resourceType: 'reconciliation_exception', resourceId: id, details: { ...resolution, type: e.type, statementId: e.statementId ?? null } });
    }
  }

  /** Branche un module notifié des résolutions système (le module Trésor clôt le dossier de l'exception). */
  onExceptionResolved(fn: (id: string, r: ExceptionResolution) => void): void {
    this.resolutionListeners.push(fn);
  }

  /** Relevés importés (plus récents d'abord) : comptes, nombre de lignes, lignes encore en exception ouverte. */
  listStatements(user: User) {
    authorize(user, 'reconciliation.read');
    return this.statements.all().map((s) => {
      const ex = this.exceptions.find((e) => e.statementId === s.id).map((e) => this.view(e));
      return {
        statementId: s.id, importedAt: s.result.importedAt, importedBy: s.result.importedBy,
        accounts: s.accounts ?? [...new Set(ex.flatMap((e) => (e.line ? [e.line.accountAlias] : [])))].sort(),
        lines: s.result.lines, matched: s.result.matched.length + (s.result.claimed?.length ?? 0),
        unmatched: ex.filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE').length,
      };
    }).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  /** Branche la surcouche de traitement des exceptions (module Trésor avancé). */
  setExceptionOverlay(fn: (e: ReconciliationException) => ReconciliationException): void {
    this.overlay = fn;
  }

  /** Exceptions brutes (stockées + calculées), avant surcouche de traitement. */
  rawExceptions(): ReconciliationException[] {
    const now = this.clock.now();
    const missing: ReconciliationException[] = this.payments.orders
      .find((o) => o.status === 'CONFIRME' && !!o.confirmedAt && now.getTime() - new Date(o.confirmedAt).getTime() > DAY_MS)
      .map((o) => ({
        id: `EXC-MS-${o.id}`, type: 'MISSING_SETTLEMENT', paymentReference: o.paymentReference,
        detail: `Confirmation du ${o.confirmedAt} sans crédit constaté à J+1 : relance prestataire.`, status: 'OUVERTE', openedAt: new Date(new Date(o.confirmedAt!).getTime() + DAY_MS).toISOString(), computed: true,
      }));
    // Attente prestataire (résultat opérateur inconnu) non résolue : aucune quittance tant qu'elle reste ouverte.
    const held: ReconciliationException[] = this.payments.unresolvedHolds().map((h) => ({
      id: `EXC-HOLD-${h.id}`, type: 'PROVIDER_AMBIGUOUS', ...(h.paymentReference ? { paymentReference: h.paymentReference } : {}),
      detail: `Résultat opérateur inconnu signalé par ${h.provider} le ${h.receivedAt} : interroger la résolution prestataire, puis attendre la confirmation signée ou le relevé.`,
      status: 'OUVERTE', openedAt: h.receivedAt, computed: true,
    }));
    // Paiement reçu mais non affecté (doublon, référence expirée, obligation couverte ou rectifiée) : à rembourser.
    const unapplied: ReconciliationException[] = this.payments.unappliedPayments.all().map((u) => ({
      id: `EXC-NAFF-${u.id}`, type: 'UNAPPLIED_PAYMENT', paymentReference: u.paymentReference,
      detail: `Paiement ${u.provider} ${u.providerTxnId} de ${u.amount.amount} ${u.amount.currency} non affecté (${u.reason}) : fonds en compte d'attente, remboursement vers l'instrument d'origine à décider.`,
      status: 'OUVERTE', openedAt: u.receivedAt, computed: true, unappliedId: u.id,
    }));
    return [...this.exceptions.all(), ...missing, ...held, ...unapplied].map((e) => ({ ...e, queue: EXCEPTION_QUEUE[e.type] }));
  }

  /** Exceptions ouvertes + « règlement manquant » calculé (confirmation sans crédit après J+1). */
  listExceptions(user: User): ReconciliationException[] {
    authorize(user, 'reconciliation.read');
    const all = this.rawExceptions();
    return this.overlay ? all.map(this.overlay) : all;
  }

}
