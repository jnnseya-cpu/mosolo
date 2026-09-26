/**
 * Faits normalisés lus dans le socle (obligations, ordres de paiement, quittances, écritures du grand livre,
 * réclamations) à une date d'arrêté donnée. Lecture seule : le pilotage ne modifie jamais une donnée métier.
 *
 * Rattachement territorial : commune du FAIT GÉNÉRATEUR (obligation.attribution, § 20.3) ; lieu non établi ⇒
 * « NON_ATTRIBUE », jamais deviné. Montants : MoneyJSON (chaînes décimales), jamais de flottant.
 */
import { UNATTRIBUTED_COMMUNE, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';

export interface ObligationFact {
  id: string;
  taxpayerId: string;
  objectId: string;
  commune: string;
  category: string;
  entity: string;
  ruleCode: string;
  amount: MoneyJSON;
  status: string;
  createdAt: string;
  createdBy: string;
  dueDate: string;
  /** Annulée (rectifiée ou admise en non-valeur) à la date d'arrêté. */
  cancelled: boolean;
  /** Obligation d'origine remplacée par une rectification fondée (§ 22.2). */
  rectified: boolean;
  /** Sous réclamation non encore décidée à la date d'arrêté. */
  contested: boolean;
  /** Première confirmation prestataire d'un paiement valide (≤ date d'arrêté). */
  paidAt?: string;
}

export interface OrderFact {
  id: string;
  paymentReference: string;
  obligationId: string;
  taxpayerId: string;
  commune: string;
  category: string;
  entity: string;
  channel: string;
  provider?: string;
  amount: MoneyJSON;
  createdAt: string;
  expiresAt: string;
  /** Statut reconstitué à la date d'arrêté. */
  status: string;
  confirmedAt?: string;
  settledAt?: string;
  reconciledAt?: string;
  receiptIssuedAt?: string;
  ledgerEntryIds: string[];
}

export interface RecordedFact {
  entryId: string;
  orderId: string;
  at: string;
  amount: MoneyJSON;
  commune: string;
  category: string;
  entity: string;
  channel: string;
  taxpayerId: string;
}

export interface AppealFact {
  id: string;
  obligationId: string;
  submittedAt: string;
  decidedAt?: string;
  decision?: string;
}

export interface Facts {
  asOf: string;
  obligations: ObligationFact[];
  orders: OrderFact[];
  recorded: RecordedFact[];
  appeals: AppealFact[];
}

/** Statuts d'un paiement qui a atteint au moins la confirmation prestataire et reste valide. */
const CONFIRMED_LIKE = new Set(['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE']);
const le = (a: string | undefined, asOf: string): a is string => a !== undefined && a <= asOf;

export function collectFacts(ctx: AppContext, asOf: string): Facts {
  const appealsRaw = ctx.appeals.appeals.all().filter((a) => a.submittedAt <= asOf);
  const appeals: AppealFact[] = appealsRaw.map((a) => ({
    id: a.id,
    obligationId: a.obligationId,
    submittedAt: a.submittedAt,
    ...(a.decision && a.decision.at <= asOf ? { decidedAt: a.decision.at, decision: a.decision.decision } : {}),
  }));
  const openAppeal = new Set(appeals.filter((a) => !a.decidedAt).map((a) => a.obligationId));

  const allObligations = ctx.assessment.obligations.all();
  const byId = new Map(allObligations.map((o) => [o.id, o]));
  const receipts = new Map(ctx.receipts.receipts.all().map((r) => [r.paymentOrderId, r]));

  const orders: OrderFact[] = [];
  for (const o of ctx.payments.orders.all()) {
    if (o.createdAt > asOf) continue;
    const ob = byId.get(o.obligationId);
    const commune = o.attribution?.commune ?? ob?.attribution?.commune ?? UNATTRIBUTED_COMMUNE;
    let status = o.status as string;
    // Reconstitution du statut à la date d'arrêté à partir des horodatages (tendances).
    if (le(o.reconciledAt, asOf)) status = 'RAPPROCHE';
    else if (le(o.settledAt, asOf)) status = 'REGLE';
    else if (le(o.confirmedAt, asOf)) status = CONFIRMED_LIKE.has(o.status) ? 'CONFIRME' : o.status;
    else if (o.confirmedAt || CONFIRMED_LIKE.has(o.status)) status = 'INITIE';
    const receipt = receipts.get(o.id);
    orders.push({
      id: o.id,
      paymentReference: o.paymentReference,
      obligationId: o.obligationId,
      taxpayerId: o.taxpayerId,
      commune,
      category: ob?.revenueCategory ?? 'INCONNUE',
      entity: ob?.entity ?? 'INCONNUE',
      channel: o.channel,
      ...(o.provider ? { provider: o.provider } : {}),
      amount: o.amount,
      createdAt: o.createdAt,
      expiresAt: o.expiresAt,
      status,
      ...(le(o.confirmedAt, asOf) ? { confirmedAt: o.confirmedAt } : {}),
      ...(le(o.settledAt, asOf) ? { settledAt: o.settledAt } : {}),
      ...(le(o.reconciledAt, asOf) ? { reconciledAt: o.reconciledAt } : {}),
      ...(receipt && le(receipt.issuedAt, asOf) ? { receiptIssuedAt: receipt.issuedAt } : {}),
      ledgerEntryIds: o.ledgerEntryIds,
    });
  }
  const paidAt = new Map<string, string>();
  for (const o of orders) {
    if (!o.confirmedAt || !CONFIRMED_LIKE.has(o.status)) continue;
    const cur = paidAt.get(o.obligationId);
    if (!cur || o.confirmedAt < cur) paidAt.set(o.obligationId, o.confirmedAt);
  }

  const obligations: ObligationFact[] = [];
  for (const o of allObligations) {
    if (o.createdAt > asOf) continue;
    const successor = o.supersededBy ? byId.get(o.supersededBy) : undefined;
    const rectified = !!successor && successor.createdAt <= asOf;
    const cancelled = rectified || (o.status === 'ANNULEE' && !o.supersededBy) || o.status === 'ADMISE_EN_NON_VALEUR';
    const p = paidAt.get(o.id);
    obligations.push({
      id: o.id,
      taxpayerId: o.taxpayerId,
      objectId: o.objectId,
      commune: o.attribution?.commune ?? UNATTRIBUTED_COMMUNE,
      category: o.revenueCategory,
      entity: o.entity,
      ruleCode: o.ruleCode,
      amount: o.amount,
      status: o.status,
      createdAt: o.createdAt,
      createdBy: o.createdBy,
      dueDate: o.dueDate,
      cancelled,
      rectified,
      contested: !cancelled && (openAppeal.has(o.id) || o.status === 'CONTESTEE'),
      ...(p ? { paidAt: p } : {}),
    });
  }

  // Niveau 10 « Comptabilisé » : écriture de crédit du compte public de recettes, non contrepassée.
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const entries = ctx.ledger.list();
  const reversed = new Set(entries.filter((e) => e.reversalOf && e.at <= asOf).map((e) => e.reversalOf!));
  const recorded: RecordedFact[] = [];
  for (const e of entries) {
    if (e.at > asOf || e.reversalOf || reversed.has(e.id)) continue;
    if (e.eventType !== 'SETTLEMENT_CREDITED') continue;
    const debit = e.lines.find((l) => l.side === 'DEBIT' && l.account === 'COMPTE_PUBLIC_RECETTES');
    const order = orderById.get(e.sourceId);
    if (!debit || !order) continue;
    recorded.push({
      entryId: e.id, orderId: order.id, at: e.at, amount: debit.amount, commune: order.commune, category: order.category,
      entity: order.entity, channel: order.channel, taxpayerId: order.taxpayerId,
    });
  }
  return { asOf, obligations, orders, recorded, appeals };
}
