/**
 * Piste d'audit par dossier (C3-123, C4-240) : chronologie fusionnée de tous les événements d'un objet fiscal,
 * d'une obligation ou d'un paiement — journal d'audit chaîné, écritures du grand livre, quittances, réclamations
 * et délivrances de communications — avec contrôles de complétude « sans trou ».
 */
import { Money } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { notFound } from '../../core/errors.js';

export type DossierKind = 'objet' | 'obligation' | 'paiement';

export interface TrailEvent {
  at: string;
  source: 'AUDIT' | 'GRAND_LIVRE' | 'QUITTANCE' | 'RECLAMATION' | 'DELIVRANCE';
  kind: string;
  label: string;
  resourceType: string;
  resourceId: string | null;
  actor?: { kind: string; id: string; roles?: string[] };
  outcome?: string;
  details: Record<string, unknown>;
  /** Empreinte chaînée (journal d'audit ou grand livre). */
  hash?: string;
  seq?: number;
}

export interface TrailControl {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

const ACTION_LABELS: Record<string, string> = {
  'object.declared': 'Objet fiscal déclaré',
  'assessment.issued': 'Obligation émise (liquidation sur règle active)',
  'assessment.rectified': 'Obligation rectificative émise',
  'receipt.issued_provisional': 'Quittance provisoire émise',
  'receipt.verified': 'Vérification publique de la quittance',
  'receipt.replaced': 'Quittance remplacée',
  'reconciliation.exception.opened': 'Exception de rapprochement ouverte',
  'payment.reference.issued': 'Référence de paiement émise',
  'payment.confirmed': 'Paiement confirmé par le prestataire (rappel signé)',
  'payment.failed': 'Paiement échoué',
  'payment.duplicate_detected': 'Doublon de paiement détecté',
  'payment.callback.replayed': 'Rappel prestataire rejoué (sans effet)',
  'receipt.finalized': 'Quittance rendue définitive',
  'reconciliation.matched': 'Rapprochement réalisé',
  'ledger.entry.posted': 'Écriture du grand livre',
  'ledger.entry.reversed': 'Contre-écriture',
  'appeal.submitted': 'Réclamation déposée',
  'appeal.instructed': 'Réclamation instruite',
  'appeal.decided': 'Réclamation décidée',
};

export interface DossierGraph {
  kind: DossierKind;
  id: string;
  objectIds: string[];
  obligationIds: string[];
  orderIds: string[];
  paymentReferences: string[];
  providerTxnIds: string[];
  receiptIds: string[];
  receiptNumbers: string[];
  ledgerEntryIds: string[];
  appealIds: string[];
  taxpayerIds: string[];
}

/** Résout une référence (objet, obligation, ordre, référence de paiement, numéro de quittance). */
export function resolveDossier(ctx: AppContext, ref: string): { kind: DossierKind; id: string } {
  if (ctx.objects.objects.get(ref)) return { kind: 'objet', id: ref };
  if (ctx.assessment.obligations.get(ref)) return { kind: 'obligation', id: ref };
  const order = ctx.payments.orders.get(ref) ?? ctx.payments.byReference(ref);
  if (order) return { kind: 'paiement', id: order.id };
  const receipt = ctx.receipts.receipts.findOne((r) => r.number === ref || r.id === ref);
  if (receipt) return { kind: 'paiement', id: receipt.paymentOrderId };
  throw notFound('DOSSIER_NOT_FOUND', `Aucun objet, obligation, paiement ou quittance ne correspond à « ${ref} ».`);
}

export function buildGraph(ctx: AppContext, kind: DossierKind, id: string): DossierGraph {
  const obligations = new Set<string>();
  const objects = new Set<string>();
  if (kind === 'objet') {
    objects.add(id);
    ctx.assessment.obligations.find((o) => o.objectId === id).forEach((o) => obligations.add(o.id));
  } else if (kind === 'obligation') {
    obligations.add(id);
  } else {
    const order = ctx.payments.orders.get(id)!;
    obligations.add(order.obligationId);
  }
  // Chaîne des rectifications (originale ↔ rectificative), dans les deux sens.
  let grew = true;
  while (grew) {
    grew = false;
    for (const oid of [...obligations]) {
      const o = ctx.assessment.obligations.get(oid);
      if (!o) continue;
      objects.add(o.objectId);
      for (const linked of [o.supersedes, o.supersededBy]) if (linked && !obligations.has(linked)) { obligations.add(linked); grew = true; }
    }
  }
  const orders = kind === 'paiement'
    ? [ctx.payments.orders.get(id)!]
    : [...obligations].flatMap((oid) => ctx.payments.byObligation(oid));
  const receipts = orders.map((o) => ctx.receipts.byPaymentOrder(o.id)).filter((r): r is NonNullable<typeof r> => !!r);
  const sourceIds = new Set<string>([...obligations, ...orders.map((o) => o.id)]);
  const ledger = ctx.ledger.list().filter((e) => sourceIds.has(e.sourceId));
  const appeals = ctx.appeals.appeals.find((a) => obligations.has(a.obligationId));
  const taxpayers = new Set<string>([...[...obligations].map((o) => ctx.assessment.obligations.get(o)?.taxpayerId).filter((x): x is string => !!x)]);
  return {
    kind, id,
    objectIds: [...objects], obligationIds: [...obligations], orderIds: orders.map((o) => o.id),
    paymentReferences: orders.map((o) => o.paymentReference), providerTxnIds: orders.map((o) => o.providerTxnId).filter((x): x is string => !!x),
    receiptIds: receipts.map((r) => r.id), receiptNumbers: receipts.map((r) => r.number), ledgerEntryIds: ledger.map((e) => e.id),
    appealIds: appeals.map((a) => a.id), taxpayerIds: [...taxpayers],
  };
}

const DELIVERY_PREFIXES = ['assessment.', 'obligation.', 'payment.', 'receipt.', 'appeal.', 'object.'];

export function buildTrail(ctx: AppContext, g: DossierGraph) {
  const ids = new Set<string>([
    ...g.objectIds, ...g.obligationIds, ...g.orderIds, ...g.paymentReferences, ...g.providerTxnIds, ...g.receiptIds, ...g.ledgerEntryIds, ...g.appealIds,
  ]);
  const events: TrailEvent[] = [];
  const audit = ctx.audit.list({ limit: Number.MAX_SAFE_INTEGER }).items;
  for (const r of audit) {
    const detailRefs = [r.details.paymentReference, r.details.obligationId, r.details.sourceId, r.details.reversalId].filter((x): x is string => typeof x === 'string');
    if (!(r.resourceId && ids.has(r.resourceId)) && !detailRefs.some((x) => ids.has(x))) continue;
    // Lectures de dossiers par des personnes (consultation de la piste) : exclues pour ne pas brouiller la chronologie métier.
    if (r.action.startsWith('pilotage.')) continue;
    events.push({
      at: r.at, source: 'AUDIT', kind: r.action, label: ACTION_LABELS[r.action] ?? r.action, resourceType: r.resourceType, resourceId: r.resourceId,
      actor: r.actor, outcome: r.outcome, details: r.details, hash: r.hash, seq: r.seq,
    });
  }
  for (const e of ctx.ledger.list().filter((x) => g.ledgerEntryIds.includes(x.id))) {
    events.push({
      at: e.at, source: 'GRAND_LIVRE', kind: e.eventType, label: e.reversalOf ? `Contre-écriture de ${e.reversalOf}` : e.description,
      resourceType: 'ledger_entry', resourceId: e.id, details: { lines: e.lines, ...(e.reason ? { reason: e.reason } : {}) }, hash: e.hash, seq: e.seq,
    });
  }
  for (const rid of g.receiptIds) {
    const r = ctx.receipts.receipts.get(rid)!;
    events.push({ at: r.issuedAt, source: 'QUITTANCE', kind: 'receipt.provisional', label: `Quittance provisoire ${r.number}`, resourceType: 'receipt', resourceId: r.id, details: { status: r.status, amount: r.amount, channel: r.channel } });
    if (r.finalizedAt) events.push({ at: r.finalizedAt, source: 'QUITTANCE', kind: 'receipt.final', label: `Quittance définitive ${r.number}`, resourceType: 'receipt', resourceId: r.id, details: { status: r.status } });
  }
  for (const aid of g.appealIds) {
    const a = ctx.appeals.appeals.get(aid)!;
    events.push({ at: a.submittedAt, source: 'RECLAMATION', kind: 'appeal.deposited', label: 'Réclamation déposée', resourceType: 'appeal', resourceId: a.id, details: { obligationId: a.obligationId, status: a.status } });
    if (a.decision) events.push({ at: a.decision.at, source: 'RECLAMATION', kind: 'appeal.decision', label: `Décision : ${a.decision.decision}`, resourceType: 'appeal', resourceId: a.id, details: { reason: a.decision.reason, decidedBy: a.decision.decidedBy } });
  }
  // Délivrances au contribuable du dossier (destinataire masqué), sur les événements de ce type de dossier.
  const firstAt = events.map((e) => e.at).sort()[0];
  if (firstAt) {
    for (const d of ctx.comms.deliveries.all()) {
      if (!g.taxpayerIds.includes(d.recipientId) || d.at < firstAt || !DELIVERY_PREFIXES.some((p) => d.eventCode.startsWith(p))) continue;
      events.push({
        at: d.at, source: 'DELIVRANCE', kind: d.eventCode, label: `Notification « ${d.eventCode} » — ${d.channel}`, resourceType: 'delivery', resourceId: d.id,
        details: { channel: d.channel, status: d.status, recipient: d.recipientMasked, contentHash: d.contentHash, correlation: 'destinataire et horodatage' },
      });
    }
  }
  const rank: Record<TrailEvent['source'], number> = { AUDIT: 0, GRAND_LIVRE: 1, QUITTANCE: 2, RECLAMATION: 3, DELIVRANCE: 4 };
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank[a.source] - rank[b.source] || (a.seq ?? 0) - (b.seq ?? 0)));
  return { events, controls: controls(ctx, g, events) };
}

function controls(ctx: AppContext, g: DossierGraph, events: TrailEvent[]): TrailControl[] {
  const out: TrailControl[] = [];
  const v = ctx.audit.verify();
  out.push({ code: 'CHAINE_AUDIT', label: 'Intégrité du journal d’audit chaîné', passed: v.ok, detail: v.ok ? `${v.length} événements vérifiés, tête ${v.headHash.slice(0, 12)}…` : `Rupture au rang ${v.brokenAt} : ${v.reason}` });
  const balance = ctx.ledger.balance();
  out.push({ code: 'GRAND_LIVRE_EQUILIBRE', label: 'Grand livre équilibré par devise', passed: balance.balanced, detail: `${balance.entries} écriture(s).` });
  const missingEntry: string[] = [];
  for (const oid of g.obligationIds) {
    const o = ctx.assessment.obligations.get(oid)!;
    if (!Money.fromJSON(o.amount).isZero() && (!o.ledgerEntryId || !ctx.ledger.get(o.ledgerEntryId))) missingEntry.push(oid);
  }
  out.push({ code: 'ECRITURE_EMISSION', label: 'Chaque obligation émise a son écriture de constatation', passed: missingEntry.length === 0, detail: missingEntry.length ? `Sans écriture : ${missingEntry.join(', ')}` : `${g.obligationIds.length} obligation(s) contrôlée(s).` });
  const gaps: string[] = [];
  for (const orderId of g.orderIds) {
    const o = ctx.payments.orders.get(orderId)!;
    const confirmedLike = ['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE'].includes(o.status);
    if (confirmedLike) {
      if (!ctx.receipts.byPaymentOrder(o.id)) gaps.push(`${o.paymentReference} : confirmé sans quittance`);
      if (!ctx.ledger.list({ sourceId: o.id }).some((e) => e.eventType === 'PAYMENT_CONFIRMED')) gaps.push(`${o.paymentReference} : confirmé sans écriture`);
      if (!events.some((e) => e.kind === 'payment.confirmed' && e.resourceId === o.id)) gaps.push(`${o.paymentReference} : confirmation absente du journal`);
    }
    if (o.status === 'RAPPROCHE') {
      if (!ctx.ledger.list({ sourceId: o.id }).some((e) => e.eventType === 'SETTLEMENT_CREDITED')) gaps.push(`${o.paymentReference} : rapproché sans écriture de crédit`);
      if (ctx.receipts.byPaymentOrder(o.id)?.status !== 'DEFINITIVE') gaps.push(`${o.paymentReference} : rapproché sans quittance définitive`);
    }
  }
  out.push({ code: 'CHAINE_PAIEMENT', label: 'Paiement → quittance → écritures → rapprochement sans trou', passed: gaps.length === 0, detail: gaps.length ? gaps.join(' ; ') : `${g.orderIds.length} paiement(s) contrôlé(s).` });
  const reversals = ctx.ledger.list().filter((e) => e.reversalOf && g.ledgerEntryIds.includes(e.reversalOf));
  const unmotivated = reversals.filter((e) => !e.reason);
  out.push({ code: 'CONTRE_ECRITURES_MOTIVEES', label: 'Toute contre-écriture est liée à l’original et motivée', passed: unmotivated.length === 0, detail: `${reversals.length} contre-écriture(s).` });
  return out;
}
