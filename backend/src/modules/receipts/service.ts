/**
 * Quittances électroniques (ch. 19) : numérotation, signature Ed25519, charge utile QR,
 * vérification publique minimale. Une quittance n'est émise QUE sur confirmation prestataire vérifiée
 * (appel interne du module paiements) — aucune route ne permet d'en émettre sur preuve visuelle (AC-PAY-03).
 */
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { type MoneyJSON, type PublicReceiptCheck, type ReceiptStatus } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { Clock } from '../../core/clock.js';
import { canonicalJson } from '../../core/crypto.js';
import { conflict, notFound } from '../../core/errors.js';
import { VerificationGate, type GateDecision } from './limiter.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AlertService } from '../alerts/service.js';
import type { FxConversion } from '../fx/service.js';

/**
 * États internes de la quittance (H.10.10) : ceux du socle partagé + CONTREPASSEE (paiement contrepassé)
 * et REMBOURSEE (restitution approuvée). Une quittance n'expire jamais ; elle n'est jamais supprimée.
 */
export type ReceiptLifecycleStatus = ReceiptStatus | 'CONTREPASSEE' | 'REMBOURSEE';
/** Résultat public étendu : REVERSED (contrepassée) et REFUNDED (remboursée) s'ajoutent au vocabulaire du socle. */
export type PublicReceiptStatus = PublicReceiptCheck | 'REVERSED' | 'REFUNDED';

/** Décision humaine (quatre yeux) à l'origine d'un changement d'état. */
export interface ReceiptDecision {
  operationId: string;
  proposedBy: string;
  approvedBy: string;
  reason: string;
  /** Motif générique affiché publiquement (jamais le motif détaillé). */
  publicReason: string;
  at: string;
}

export interface Receipt {
  id: string;
  number: string;
  code: string;
  status: ReceiptLifecycleStatus;
  paymentOrderId: string;
  paymentReference: string;
  obligationId: string;
  taxpayerId: string;
  taxpayerRef: string;
  revenueCategory: string;
  administration: string;
  beneficiaryAlias: string;
  amount: MoneyJSON;
  payerAmount?: MoneyJSON;
  indicativeAmount?: FxConversion;
  channel: string;
  provider: string;
  providerTxnId: string;
  confirmationMethod?: string;
  paidAt: string;
  issuedAt: string;
  finalizedAt?: string;
  mention: string;
  signature: string;
  signatureAlgorithm: 'Ed25519';
  qrPayload: string;
  verificationPath: string;
  /** Numéro de la quittance qui remplace celle-ci (état REMPLACEE). */
  replacedBy?: string;
  /** Numéro de la quittance remplacée par celle-ci. */
  replaces?: string;
  /** Dernier changement d'état décidé par deux personnes distinctes. */
  decision?: ReceiptDecision;
  statusChangedAt?: string;
  /** Nombre de duplicata délivrés (même numéro, mention DUPLICATA). */
  duplicates?: number;
  lastDuplicateAt?: string;
}

/** Exemplaire réimprimé : même numéro, même signature, mention DUPLICATA horodatée. */
export interface ReceiptDuplicate {
  duplicateNo: number;
  printedAt: string;
  printedBy: string;
  mention: string;
  qrPayload: string;
  receipt: Receipt;
}

/** Transitions autorisées par décision (le reste passe par le paiement : provisoire → définitive). */
const DECIDED_TRANSITIONS: Record<'ANNULEE' | 'CONTREPASSEE' | 'REMBOURSEE' | 'SUSPECTE', ReceiptLifecycleStatus[]> = {
  ANNULEE: ['PROVISOIRE', 'SUSPECTE'],
  CONTREPASSEE: ['PROVISOIRE', 'DEFINITIVE', 'SUSPECTE'],
  REMBOURSEE: ['DEFINITIVE'],
  SUSPECTE: ['PROVISOIRE', 'DEFINITIVE'],
};

const MENTIONS: Record<ReceiptLifecycleStatus, string> = {
  PROVISOIRE: 'Quittance provisoire — en attente de règlement',
  DEFINITIVE: 'Quittance définitive — paiement réglé et rapproché',
  ANNULEE: 'Quittance annulée — non valable',
  REMPLACEE: 'Quittance remplacée — non valable',
  SUSPECTE: 'Quittance signalée — vérification auprès de la régie',
  CONTREPASSEE: 'Quittance contrepassée — paiement inversé, non valable',
  REMBOURSEE: 'Quittance remboursée — paiement restitué, non valable',
};

/** Preuve interne qu'une confirmation prestataire a passé toutes les vérifications. */
export interface VerifiedProviderConfirmation {
  kind: 'VERIFIED_PROVIDER_CONFIRMATION';
  paymentOrderId: string;
  paymentReference: string;
  obligationId: string;
  taxpayerId: string;
  taxpayerRef: string;
  revenueCategory: string;
  administration: string;
  beneficiaryAlias: string;
  amount: MoneyJSON;
  payerAmount?: MoneyJSON;
  indicativeAmount?: FxConversion;
  channel: string;
  provider: string;
  providerTxnId: string;
  paidAt: string;
  /** Méthode de confirmation (rappel HMAC générique, rail BitriPay, registre opérateur KODA…). */
  confirmationMethod?: string;
  signatureVerified: true;
  nonceUnique: true;
  /** Garde anti-rejeu : nonce (rappel générique) ou identifiant d'événement unique (webhook prestataire). */
  replayGuard?: 'NONCE' | 'EVENT_ID';
  /** NON_APPLICABLE : le prestataire ne signe pas d'horodatage ; l'anti-rejeu repose alors sur l'identifiant d'événement. */
  timestampInWindow: true | 'NON_APPLICABLE';
}

/** Quatre derniers caractères alphanumériques de la référence du contribuable (§ 19.2). */
export function refSuffix(ref: string): string {
  return ref.replace(/[^0-9A-Za-z]/g, '').slice(-4);
}

export const PUBLIC_STATUS: Record<ReceiptLifecycleStatus, PublicReceiptStatus> = {
  PROVISOIRE: 'PENDING',
  DEFINITIVE: 'VALID',
  ANNULEE: 'CANCELLED',
  REMPLACEE: 'REPLACED',
  SUSPECTE: 'FRAUD_SUSPECTED',
  CONTREPASSEE: 'REVERSED',
  REMBOURSEE: 'REFUNDED',
};

const PUBLIC_MESSAGE: Record<PublicReceiptStatus, string> = {
  VALID: 'Quittance authentique.',
  PENDING: 'Paiement confirmé, règlement en cours.',
  CANCELLED: 'Quittance non valable.',
  REPLACED: 'Quittance remplacée.',
  REVERSED: 'Quittance non valable (contrepassée).',
  REFUNDED: 'Quittance non valable (paiement remboursé).',
  FRAUD_SUSPECTED: 'Vérification impossible — contactez la régie.',
  UNKNOWN: 'Aucune quittance ne correspond.',
};

/** Contrôle du chiffre de Luhn d'un code court ou d'un numéro de quittance (anti-faute de frappe, § 18A.6). */
export function hasValidCheckDigit(codeOrNumber: string): boolean | undefined {
  const short = /^Q(\d{2})KIN(\d{9})(\d)$/.exec(codeOrNumber);
  if (short) return luhnDigit(`20${short[1]}${short[2]}`) === Number(short[3]);
  const long = /^Q-(\d{4})-KIN-(\d{9})-(\d)$/.exec(codeOrNumber);
  if (long) return luhnDigit(`${long[1]}${long[2]}`) === Number(long[3]);
  return undefined;
}

function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Journal agrégé des vérifications publiques : compteurs par jour et par résultat, jamais d'identité. */
export interface VerificationDayStats {
  date: string;
  total: number;
  byStatus: Partial<Record<PublicReceiptStatus | 'THROTTLED' | 'INVALID_CHECK_DIGIT', number>>;
  /** Nombre de clients distincts (empreintes tronquées, non réversibles). */
  distinctClients: number;
}

export interface SignedRevocationList {
  issuedAt: string;
  algorithm: 'Ed25519';
  entries: { code: string; number: string; status: PublicReceiptStatus; since: string }[];
  signature: string;
}

export class ReceiptService {
  readonly receipts = new InMemoryRepository<Receipt>();
  private readonly ids = new IdGenerator();
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private seq = 0;
  /** Limitation de débit des vérifications publiques par client (anti-énumération, § 18A.6). */
  readonly gate: VerificationGate;
  private readonly stats = new Map<string, { total: number; byStatus: VerificationDayStats['byStatus']; clients: Set<string> }>();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly alerts: AlertService,
    signingKey?: KeyObject,
  ) {
    if (signingKey) {
      this.privateKey = signingKey;
      this.publicKey = createPublicKey(signingKey);
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    this.gate = new VerificationGate(clock);
  }

  private signedPayload(r: Pick<Receipt, 'number' | 'code' | 'paymentReference' | 'amount' | 'taxpayerRef' | 'administration' | 'paidAt' | 'revenueCategory'>): string {
    return canonicalJson({
      number: r.number, code: r.code, paymentReference: r.paymentReference, amount: r.amount,
      taxpayerRefSuffix: refSuffix(r.taxpayerRef), administration: r.administration, paidAt: r.paidAt, revenueCategory: r.revenueCategory,
    });
  }

  /** Numérotation exclusive du système (numéro long + code court, chiffre de contrôle de Luhn). */
  private nextNumber(): { number: string; code: string } {
    const year = this.clock.now().getUTCFullYear();
    const n = String(++this.seq).padStart(9, '0');
    const check = luhnDigit(`${year}${n}`);
    return { number: `Q-${year}-KIN-${n}-${check}`, code: `Q${String(year).slice(2)}KIN${n}${check}` };
  }

  private sign(base: Parameters<ReceiptService['signedPayload']>[0]): string {
    return sign(null, Buffer.from(this.signedPayload(base)), this.privateKey).toString('base64url');
  }

  issueProvisional(c: VerifiedProviderConfirmation): Receipt {
    if (
      c.kind !== 'VERIFIED_PROVIDER_CONFIRMATION' || c.signatureVerified !== true || c.nonceUnique !== true ||
      !(c.timestampInWindow === true || (c.timestampInWindow === 'NON_APPLICABLE' && c.replayGuard === 'EVENT_ID'))
    ) {
      throw conflict('RECEIPT_REQUIRES_VERIFIED_CONFIRMATION', 'Une quittance exige une confirmation prestataire vérifiée.');
    }
    if (this.receipts.findOne((r) => r.paymentOrderId === c.paymentOrderId)) {
      throw conflict('RECEIPT_ALREADY_ISSUED', `Quittance déjà émise pour ${c.paymentReference}.`);
    }
    const now = this.clock.now();
    const { number, code } = this.nextNumber();
    const base = {
      number, code, paymentReference: c.paymentReference, amount: c.amount, taxpayerRef: c.taxpayerRef,
      administration: c.administration, paidAt: c.paidAt, revenueCategory: c.revenueCategory,
    };
    const signature = this.sign(base);
    const receipt = this.receipts.insert({
      id: this.ids.next('RCP'),
      ...base,
      status: 'PROVISOIRE',
      paymentOrderId: c.paymentOrderId,
      obligationId: c.obligationId,
      taxpayerId: c.taxpayerId,
      beneficiaryAlias: c.beneficiaryAlias,
      ...(c.payerAmount ? { payerAmount: c.payerAmount } : {}),
      ...(c.indicativeAmount ? { indicativeAmount: c.indicativeAmount } : {}),
      channel: c.channel,
      provider: c.provider,
      providerTxnId: c.providerTxnId,
      ...(c.confirmationMethod ? { confirmationMethod: c.confirmationMethod } : {}),
      issuedAt: now.toISOString(),
      mention: MENTIONS.PROVISOIRE,
      signature,
      signatureAlgorithm: 'Ed25519',
      qrPayload: `MOSOLO1|${code}|${signature}`,
      verificationPath: `/v1/public/receipts/${code}`,
    });
    this.audit.append({
      actor: { kind: 'system', id: 'quittances' }, action: 'receipt.issued_provisional', resourceType: 'receipt', resourceId: receipt.id,
      details: { number, paymentReference: c.paymentReference, providerTxnId: c.providerTxnId },
    });
    return receipt;
  }

  finalize(paymentOrderId: string): Receipt {
    const r = this.byPaymentOrder(paymentOrderId);
    if (!r) throw notFound('RECEIPT_NOT_FOUND', `Aucune quittance pour l'ordre ${paymentOrderId}`);
    if (r.status === 'DEFINITIVE') return r;
    if (r.status !== 'PROVISOIRE') throw conflict('RECEIPT_NOT_FINALIZABLE', `La quittance ${r.number} est ${r.status} : elle ne peut devenir définitive.`);
    const updated = this.receipts.update({ ...r, status: 'DEFINITIVE', finalizedAt: this.clock.now().toISOString(), mention: MENTIONS.DEFINITIVE });
    this.audit.append({ actor: { kind: 'system', id: 'quittances' }, action: 'receipt.finalized', resourceType: 'receipt', resourceId: r.id, details: { number: r.number } });
    return updated;
  }

  /** Quittance EN VIGUEUR d'un ordre de paiement (la dernière de la chaîne de remplacement). */
  byPaymentOrder(paymentOrderId: string): Receipt | undefined {
    const all = this.receipts.find((r) => r.paymentOrderId === paymentOrderId);
    return all.find((r) => !r.replacedBy) ?? all.at(-1);
  }

  byTaxpayer(taxpayerId: string): Receipt[] {
    return this.receipts.find((r) => r.taxpayerId === taxpayerId);
  }

  /** Recherche par identifiant interne, numéro long ou code court. */
  find(ref: string): Receipt | undefined {
    return this.receipts.get(ref) ?? this.receipts.findOne((x) => x.code === ref || x.number === ref);
  }

  require(ref: string): Receipt {
    const r = this.find(ref);
    if (!r) throw notFound('RECEIPT_NOT_FOUND', `Quittance inconnue : ${ref}`);
    return r;
  }

  /**
   * Changement d'état décidé par deux personnes distinctes (annulation, contrepassation, remboursement, signalement).
   * Appelé uniquement par le circuit de double validation du Trésor, jamais par une route directe.
   */
  applyDecision(ref: string, to: keyof typeof DECIDED_TRANSITIONS, decision: ReceiptDecision): Receipt {
    const r = this.require(ref);
    this.assertTransition(r, to);
    const updated = this.receipts.update({ ...r, status: to, mention: MENTIONS[to], decision, statusChangedAt: decision.at });
    this.audit.append({
      actor: { kind: 'user', id: decision.approvedBy }, action: `receipt.${to === 'ANNULEE' ? 'cancelled' : to === 'CONTREPASSEE' ? 'reversed' : to === 'REMBOURSEE' ? 'refunded' : 'flagged'}`,
      resourceType: 'receipt', resourceId: r.id,
      details: { number: r.number, from: r.status, to, operationId: decision.operationId, proposedBy: decision.proposedBy, reason: decision.reason },
    });
    return updated;
  }

  /** Vérifie qu'une transition décidée est permise (sans rien modifier). */
  assertTransition(r: Receipt, to: keyof typeof DECIDED_TRANSITIONS): void {
    if (!DECIDED_TRANSITIONS[to].includes(r.status)) {
      throw conflict('RECEIPT_INVALID_TRANSITION', `Quittance ${r.number} : passage ${r.status} → ${to} interdit.`, { from: r.status, to });
    }
  }

  /**
   * Remplacement (quatre yeux) : nouvelle quittance, nouveau numéro, mêmes données de paiement (montant, référence,
   * transaction : jamais modifiables) ; les mentions d'identification sont reprises des données faisant foi.
   * L'ancienne passe REMPLACEE et renvoie publiquement vers la nouvelle.
   */
  replace(ref: string, current: { taxpayerRef: string; revenueCategory: string; administration: string }, decision: ReceiptDecision): { original: Receipt; replacement: Receipt } {
    const r = this.require(ref);
    this.assertReplaceable(r);
    const { number, code } = this.nextNumber();
    const base = {
      number, code, paymentReference: r.paymentReference, amount: r.amount, taxpayerRef: current.taxpayerRef,
      administration: current.administration, paidAt: r.paidAt, revenueCategory: current.revenueCategory,
    };
    const signature = this.sign(base);
    const { replacedBy: _rb, replaces: _rp, decision: _d, statusChangedAt: _s, duplicates: _dup, lastDuplicateAt: _l, ...rest } = r;
    const replacement = this.receipts.insert({
      ...rest,
      ...base,
      id: this.ids.next('RCP'),
      issuedAt: decision.at,
      replaces: r.number,
      signature,
      qrPayload: `MOSOLO1|${code}|${signature}`,
      verificationPath: `/v1/public/receipts/${code}`,
      decision,
    });
    const original = this.receipts.update({ ...r, status: 'REMPLACEE', mention: MENTIONS.REMPLACEE, replacedBy: number, decision, statusChangedAt: decision.at });
    this.audit.append({
      actor: { kind: 'user', id: decision.approvedBy }, action: 'receipt.replaced', resourceType: 'receipt', resourceId: r.id,
      details: { number: r.number, replacedBy: number, operationId: decision.operationId, proposedBy: decision.proposedBy, reason: decision.reason },
    });
    return { original, replacement };
  }

  assertReplaceable(r: Receipt): void {
    if (r.status !== 'PROVISOIRE' && r.status !== 'DEFINITIVE') {
      throw conflict('RECEIPT_INVALID_TRANSITION', `Quittance ${r.number} (${r.status}) : seule une quittance en vigueur se remplace.`, { from: r.status, to: 'REMPLACEE' });
    }
  }

  /** Duplicata horodaté : même numéro, même signature, mention DUPLICATA, compteur audité (§ 18A.6). */
  duplicate(ref: string, printedBy: string): ReceiptDuplicate {
    const r = this.require(ref);
    if (r.status !== 'PROVISOIRE' && r.status !== 'DEFINITIVE') {
      throw conflict('RECEIPT_NOT_IN_FORCE', `La quittance ${r.number} est ${r.status} : aucun duplicata ne peut en être délivré${r.replacedBy ? ` (quittance en vigueur : ${r.replacedBy})` : ''}.`);
    }
    const now = this.clock.now().toISOString();
    const duplicateNo = (r.duplicates ?? 0) + 1;
    const updated = this.receipts.update({ ...r, duplicates: duplicateNo, lastDuplicateAt: now });
    this.audit.append({ actor: { kind: 'user', id: printedBy }, action: 'receipt.duplicate_issued', resourceType: 'receipt', resourceId: r.id, details: { number: r.number, duplicateNo } });
    return {
      duplicateNo, printedAt: now, printedBy,
      mention: `DUPLICATA n° ${duplicateNo} — délivré le ${now} — même numéro ${r.number} ; l'original seul ne fait pas double preuve de paiement`,
      qrPayload: `${r.qrPayload}|DUPLICATA-${duplicateNo}`,
      receipt: updated,
    };
  }

  verifySignature(r: Receipt): boolean {
    try {
      return verify(null, Buffer.from(this.signedPayload(r)), this.publicKey, Buffer.from(r.signature, 'base64url'));
    } catch {
      return false;
    }
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** Contrôle de débit d'un client (clé réseau) avant vérification publique. */
  admit(clientKey: string): GateDecision {
    const d = this.gate.admit(clientKey);
    if (!d.allowed) this.count('THROTTLED', clientKey);
    return d;
  }

  private count(status: PublicReceiptStatus | 'THROTTLED' | 'INVALID_CHECK_DIGIT', clientKey?: string): void {
    const day = this.clock.now().toISOString().slice(0, 10);
    const s = this.stats.get(day) ?? { total: 0, byStatus: {}, clients: new Set<string>() };
    s.total += 1;
    s.byStatus[status] = (s.byStatus[status] ?? 0) + 1;
    if (clientKey) s.clients.add(VerificationGate.fingerprint(clientKey));
    this.stats.set(day, s);
  }

  /** Journal AGRÉGÉ des vérifications publiques (§ 19.2 « limitées en fréquence et journalisées »). */
  verificationJournal(): { days: VerificationDayStats[]; totals: VerificationDayStats['byStatus'] & { total: number }; limits: VerificationGate['limits'] } {
    const days = [...this.stats.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, s]) => ({ date, total: s.total, byStatus: { ...s.byStatus }, distinctClients: s.clients.size }));
    const totals: VerificationDayStats['byStatus'] & { total: number } = { total: 0 };
    for (const d of days) {
      totals.total += d.total;
      for (const [k, v] of Object.entries(d.byStatus) as [keyof VerificationDayStats['byStatus'], number][]) totals[k] = (totals[k] ?? 0) + v;
    }
    return { days, totals, limits: this.gate.limits };
  }

  /**
   * Liste de révocation signée (§ 19.3) : téléchargée au départ de mission par l'application terrain,
   * elle permet d'afficher « authentique — statut vérifié au … » hors connexion. Codes seulement, aucun nom.
   */
  revocationList(): SignedRevocationList {
    const entries = this.receipts
      .find((r) => r.status !== 'PROVISOIRE' && r.status !== 'DEFINITIVE')
      .map((r) => ({ code: r.code, number: r.number, status: PUBLIC_STATUS[r.status], since: r.statusChangedAt ?? r.issuedAt }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const issuedAt = this.clock.now().toISOString();
    const signature = sign(null, Buffer.from(canonicalJson({ issuedAt, entries })), this.privateKey).toString('base64url');
    return { issuedAt, algorithm: 'Ed25519', entries, signature };
  }

  /** Vérification publique : résultat MINIMAL (§ 19.2, AC-RCP-01). `duplicateNo` : contrôle d'un duplicata présenté. */
  publicVerify(codeOrNumber: string, opts: { clientKey?: string; duplicateNo?: number } = {}) {
    const verifiedAt = this.clock.now().toISOString();
    const check = hasValidCheckDigit(codeOrNumber);
    if (check === false) {
      this.count('INVALID_CHECK_DIGIT', opts.clientKey);
      if (opts.clientKey) this.gate.recordMiss(opts.clientKey);
      this.audit.append({ actor: { kind: 'public', id: 'verification-publique' }, action: 'receipt.verified', resourceType: 'receipt', resourceId: codeOrNumber, details: { found: false, checkDigit: 'INVALIDE' } });
      return { status: 'UNKNOWN' as PublicReceiptStatus, message: 'Code invalide : chiffre de contrôle erroné. Vérifiez la saisie.', verifiedAt };
    }
    const r = this.receipts.findOne((x) => x.code === codeOrNumber || x.number === codeOrNumber);
    this.audit.append({ actor: { kind: 'public', id: 'verification-publique' }, action: 'receipt.verified', resourceType: 'receipt', resourceId: r?.id ?? codeOrNumber, details: { found: !!r } });
    if (!r) {
      this.count('UNKNOWN', opts.clientKey);
      if (opts.clientKey) this.gate.recordMiss(opts.clientKey);
      return { status: 'UNKNOWN' as PublicReceiptStatus, message: PUBLIC_MESSAGE.UNKNOWN, verifiedAt };
    }
    let status = PUBLIC_STATUS[r.status];
    if (!this.verifySignature(r)) {
      status = 'FRAUD_SUSPECTED';
      this.alerts.raise({ type: 'RECEIPT_SIGNATURE_INVALID', severity: 'CRITICAL', source: 'quittances', detail: `Signature invalide pour la quittance ${r.number}`, context: { receiptId: r.id } });
    }
    this.count(status, opts.clientKey);
    // Duplicata présenté : il doit avoir été réellement délivré (numéro ≤ compteur), sinon il est suspect.
    const duplicate = opts.duplicateNo !== undefined
      ? { duplicateNo: opts.duplicateNo, issued: opts.duplicateNo >= 1 && opts.duplicateNo <= (r.duplicates ?? 0) }
      : undefined;
    if (duplicate && !duplicate.issued && (status === 'VALID' || status === 'PENDING')) {
      this.alerts.raise({ type: 'RECEIPT_DUPLICATE_UNKNOWN', severity: 'HIGH', source: 'quittances', detail: `Duplicata n° ${opts.duplicateNo} jamais délivré pour ${r.number}`, context: { receiptId: r.id } });
      return { status: 'FRAUD_SUSPECTED' as PublicReceiptStatus, message: PUBLIC_MESSAGE.FRAUD_SUSPECTED, verifiedAt, duplicate };
    }
    if (status !== 'VALID' && status !== 'PENDING') {
      return {
        status, message: PUBLIC_MESSAGE[status], verifiedAt,
        ...(status === 'REPLACED' && r.replacedBy ? { replacedBy: r.replacedBy, message: `Remplacée par la quittance n° ${r.replacedBy}.` } : {}),
        ...(r.decision && status !== 'FRAUD_SUSPECTED' ? { reason: r.decision.publicReason, statusSince: r.statusChangedAt?.slice(0, 10) } : {}),
        ...(duplicate ? { duplicate } : {}),
      };
    }
    return {
      status,
      message: PUBLIC_MESSAGE[status],
      settlementStatus: r.status === 'DEFINITIVE' ? 'RECONCILED' : 'PENDING_SETTLEMENT',
      revenueCategory: r.revenueCategory,
      amount: r.amount,
      paidOn: r.paidAt.slice(0, 10),
      beneficiaryAdministration: r.administration,
      taxpayerRefSuffix: '…' + refSuffix(r.taxpayerRef),
      ...(r.replaces ? { replaces: r.replaces } : {}),
      ...(duplicate ? { duplicate } : {}),
      verifiedAt,
    };
  }
}
