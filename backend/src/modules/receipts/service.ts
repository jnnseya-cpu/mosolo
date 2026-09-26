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
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AlertService } from '../alerts/service.js';
import type { FxConversion } from '../fx/service.js';

export interface Receipt {
  id: string;
  number: string;
  code: string;
  status: ReceiptStatus;
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
  issuedAt: string;
  finalizedAt?: string;
  mention: string;
  signature: string;
  signatureAlgorithm: 'Ed25519';
  qrPayload: string;
  verificationPath: string;
}

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
  signatureVerified: true;
  nonceUnique: true;
  timestampInWindow: true;
}

const PUBLIC_STATUS: Record<ReceiptStatus, PublicReceiptCheck> = {
  PROVISOIRE: 'PENDING',
  DEFINITIVE: 'VALID',
  ANNULEE: 'CANCELLED',
  REMPLACEE: 'REPLACED',
  SUSPECTE: 'FRAUD_SUSPECTED',
};

const PUBLIC_MESSAGE: Record<PublicReceiptCheck, string> = {
  VALID: 'Quittance authentique.',
  PENDING: 'Paiement confirmé, règlement en cours.',
  CANCELLED: 'Quittance non valable.',
  REPLACED: 'Quittance remplacée.',
  FRAUD_SUSPECTED: 'Vérification impossible — contactez la régie.',
  UNKNOWN: 'Aucune quittance ne correspond.',
};

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

export class ReceiptService {
  readonly receipts = new InMemoryRepository<Receipt>();
  private readonly ids = new IdGenerator();
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private seq = 0;

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
  }

  private signedPayload(r: Pick<Receipt, 'number' | 'code' | 'paymentReference' | 'amount' | 'taxpayerRef' | 'administration' | 'paidAt' | 'revenueCategory'>): string {
    return canonicalJson({
      number: r.number, code: r.code, paymentReference: r.paymentReference, amount: r.amount,
      taxpayerRefSuffix: r.taxpayerRef.slice(-4), administration: r.administration, paidAt: r.paidAt, revenueCategory: r.revenueCategory,
    });
  }

  issueProvisional(c: VerifiedProviderConfirmation): Receipt {
    if (c.kind !== 'VERIFIED_PROVIDER_CONFIRMATION' || !c.signatureVerified || !c.nonceUnique || !c.timestampInWindow) {
      throw conflict('RECEIPT_REQUIRES_VERIFIED_CONFIRMATION', 'Une quittance exige une confirmation prestataire vérifiée.');
    }
    if (this.receipts.findOne((r) => r.paymentOrderId === c.paymentOrderId)) {
      throw conflict('RECEIPT_ALREADY_ISSUED', `Quittance déjà émise pour ${c.paymentReference}.`);
    }
    const now = this.clock.now();
    const year = now.getUTCFullYear();
    const n = String(++this.seq).padStart(9, '0');
    const check = luhnDigit(`${year}${n}`);
    const number = `Q-${year}-KIN-${n}-${check}`;
    const code = `Q${String(year).slice(2)}KIN${n}${check}`;
    const base = {
      number, code, paymentReference: c.paymentReference, amount: c.amount, taxpayerRef: c.taxpayerRef,
      administration: c.administration, paidAt: c.paidAt, revenueCategory: c.revenueCategory,
    };
    const signature = sign(null, Buffer.from(this.signedPayload(base)), this.privateKey).toString('base64url');
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
      issuedAt: now.toISOString(),
      mention: 'Quittance provisoire — en attente de règlement',
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
    const r = this.receipts.findOne((x) => x.paymentOrderId === paymentOrderId);
    if (!r) throw notFound('RECEIPT_NOT_FOUND', `Aucune quittance pour l'ordre ${paymentOrderId}`);
    if (r.status === 'DEFINITIVE') return r;
    const updated = this.receipts.update({ ...r, status: 'DEFINITIVE', finalizedAt: this.clock.now().toISOString(), mention: 'Quittance définitive — paiement réglé et rapproché' });
    this.audit.append({ actor: { kind: 'system', id: 'quittances' }, action: 'receipt.finalized', resourceType: 'receipt', resourceId: r.id, details: { number: r.number } });
    return updated;
  }

  byPaymentOrder(paymentOrderId: string): Receipt | undefined {
    return this.receipts.findOne((r) => r.paymentOrderId === paymentOrderId);
  }

  byTaxpayer(taxpayerId: string): Receipt[] {
    return this.receipts.find((r) => r.taxpayerId === taxpayerId);
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

  /** Vérification publique : résultat MINIMAL (§ 19.2, AC-RCP-01). */
  publicVerify(codeOrNumber: string) {
    const verifiedAt = this.clock.now().toISOString();
    const r = this.receipts.findOne((x) => x.code === codeOrNumber || x.number === codeOrNumber);
    this.audit.append({ actor: { kind: 'public', id: 'verification-publique' }, action: 'receipt.verified', resourceType: 'receipt', resourceId: r?.id ?? codeOrNumber, details: { found: !!r } });
    if (!r) return { status: 'UNKNOWN' as PublicReceiptCheck, message: PUBLIC_MESSAGE.UNKNOWN, verifiedAt };
    let status = PUBLIC_STATUS[r.status];
    if (!this.verifySignature(r)) {
      status = 'FRAUD_SUSPECTED';
      this.alerts.raise({ type: 'RECEIPT_SIGNATURE_INVALID', severity: 'CRITICAL', source: 'quittances', detail: `Signature invalide pour la quittance ${r.number}`, context: { receiptId: r.id } });
    }
    if (status !== 'VALID' && status !== 'PENDING') return { status, message: PUBLIC_MESSAGE[status], verifiedAt };
    return {
      status,
      message: PUBLIC_MESSAGE[status],
      settlementStatus: r.status === 'DEFINITIVE' ? 'RECONCILED' : 'PENDING_SETTLEMENT',
      revenueCategory: r.revenueCategory,
      amount: r.amount,
      paidOn: r.paidAt.slice(0, 10),
      beneficiaryAdministration: r.administration,
      taxpayerRefSuffix: '…' + r.taxpayerRef.slice(-4),
      verifiedAt,
    };
  }
}
