/**
 * Réseau des points de paiement agréés (module 66, § 18A.2, § H.10.3) et opérateur R32.
 *
 * Doctrine :
 * - le point ne saisit QUE la référence du circuit commun : le montant est lu dans l'ordre, jamais saisi ;
 * - le point agréé est un PRESTATAIRE HABILITÉ : son encaissement est confirmé par le même mécanisme signé que les
 *   autres prestataires (rappel HMAC, nonce, horodatage — PaymentService.handleCallback) ; aucune quittance
 *   n'existe hors de cette confirmation, et un point non actif n'a plus de secret de signature ;
 * - clôture de caisse journalière et versement bancaire au compte public du coffre, rapprochés : tout écart ou
 *   retard ouvre une exception et une PROPOSITION de suspension ; seul le Trésor (R17) décide, avec motif (ARB-12).
 */
import { randomUUID } from 'node:crypto';
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS } from '../../core/clock.js';
import { checkChar, hmacSha256Hex, randomCode, randomSecret } from '../../core/crypto.js';
import { ApiError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import { refSuffix } from '../../modules/receipts/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { CardRegistry } from './cards.js';
import {
  KINSHASA_OFFSET_MS, initials, kinshasaDay, type CashDay, type Collection, type GuichetMosolo, type PaymentPoint,
  type PointExceptionType, type PointException, type PointType, type SuspensionProposal,
} from './model.js';

/** Normalise une référence saisie (« pr abcd efgh » → « PR-ABCD-EFGH ») et contrôle son caractère de contrôle. */
export function normalizeReference(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^PR[0-9A-Z]{8}$/.test(s)) throw badRequest('INVALID_REFERENCE_FORMAT', 'Référence attendue au format PR-XXXX-XXXX.');
  const core = s.slice(2, 9);
  if (checkChar(core) !== s[9]) throw unprocessable('REFERENCE_CHECK_FAILED', 'Caractère de contrôle incorrect : vérifiez la référence saisie.');
  return `PR-${s.slice(2, 6)}-${s.slice(6)}`;
}

/** Code court de vérification : 5 caractères Crockford + 1 caractère de contrôle. */
export function normalizeShortCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(s)) return null;
  return checkChar(s.slice(0, 5)) === s[5] ? s : null;
}

function sumByCurrency(items: MoneyJSON[]): MoneyJSON[] {
  const m = new Map<string, Money>();
  for (const i of items) {
    const cur = m.get(i.currency);
    m.set(i.currency, cur ? cur.add(Money.fromJSON(i)) : Money.fromJSON(i));
  }
  return [...m.values()].map((x) => x.toJSON()).sort((a, b) => a.currency.localeCompare(b.currency));
}

function sameTotals(a: MoneyJSON[], b: MoneyJSON[]): boolean {
  const norm = (xs: MoneyJSON[]) => sumByCurrency(xs).filter((x) => !Money.fromJSON(x).isZero());
  const na = norm(a);
  const nb = norm(b);
  return na.length === nb.length && na.every((x, i) => x.currency === nb[i]!.currency && Money.fromJSON(x).equals(Money.fromJSON(nb[i]!)));
}

export interface ReferenceInput {
  name: string;
  type: PointType;
  operator: string;
  approval: { authority: string; reference: string; grantedOn: string };
  commune: string;
  quartier: string;
  address: string;
  lat: number;
  lon: number;
  hours: string;
  limits: { perTransaction: MoneyJSON[]; perDay: MoneyJSON[] };
  settlementDelayHours: number;
  guichetId?: string;
  operatorUserIds: string[];
  demo?: boolean;
}

/** Principal « titulaire » d'un canal (carte présentée, session USSD/SVI authentifiée) : droits du seul contribuable. */
export function holderPrincipal(taxpayerId: string, channel: string): User {
  return { kind: 'user', id: `canal-${channel.toLowerCase()}:${taxpayerId}`, name: 'Titulaire (canal assisté)', roles: ['R30'], entity: 'PUBLIC', taxpayerId };
}

export class PaymentPointService {
  readonly points = new InMemoryRepository<PaymentPoint>();
  readonly guichets = new InMemoryRepository<GuichetMosolo>();
  readonly collections = new InMemoryRepository<Collection>();
  readonly cashDays = new InMemoryRepository<CashDay>();
  readonly exceptions = new InMemoryRepository<PointException>();
  readonly proposals = new InMemoryRepository<SuspensionProposal>();
  private readonly ids = new IdGenerator();
  /** Clé maîtresse de dérivation des secrets de signature des points (production : HSM). */
  private readonly masterKey: string;

  constructor(private readonly ctx: AppContext, private readonly cards: CardRegistry) {
    this.masterKey = process.env.MOSOLO_PAYMENT_POINT_MASTER_KEY ?? randomSecret();
  }

  // ---------- Habilitation de signature (prestataire habilité) ----------

  private secretFor(p: PaymentPoint): string {
    return hmacSha256Hex(this.masterKey, `point-agree:${p.providerId}`);
  }
  private habilitate(p: PaymentPoint): void {
    this.ctx.secrets.providerSecrets[p.providerId] = this.secretFor(p);
  }
  private revokeHabilitation(p: PaymentPoint): void {
    delete this.ctx.secrets.providerSecrets[p.providerId];
  }

  // ---------- Registre (Trésor) ----------

  get(id: string): PaymentPoint {
    const p = this.points.get(id);
    if (!p) throw notFound('PAYMENT_POINT_NOT_FOUND', `Point de paiement inconnu : ${id}`);
    return p;
  }

  reference(user: User, input: ReferenceInput, fixedId?: string): PaymentPoint {
    authorize(user, 'canaux:point.reference');
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    if (!input.approval.reference.trim()) throw unprocessable('APPROVAL_REQUIRED', "Référencement impossible sans numéro d'agrément de l'autorité de régulation.");
    for (const uid of input.operatorUserIds) {
      const u = this.ctx.users.get(uid);
      if (!u || !u.roles.includes('R32')) throw unprocessable('OPERATOR_NOT_R32', `L'opérateur ${uid} doit être un utilisateur habilité « Point de paiement agréé » (R32).`);
    }
    if (input.guichetId && !this.guichets.get(input.guichetId)) throw notFound('GUICHET_NOT_FOUND', `Guichet MOSOLO inconnu : ${input.guichetId}`);
    const id = fixedId ?? this.ids.next('PA');
    const now = this.clock().toISOString();
    const point = this.points.insert({
      id, name: input.name, type: input.type, operator: input.operator, approval: input.approval, commune: input.commune, quartier: input.quartier,
      address: input.address, lat: input.lat, lon: input.lon, hours: input.hours, limits: input.limits, settlementDelayHours: input.settlementDelayHours,
      ...(input.guichetId ? { guichetId: input.guichetId } : {}), providerId: `point-agree-${id.toLowerCase()}`, operatorUserIds: input.operatorUserIds,
      status: 'REFERENCE', referencedBy: user.id, referencedAt: now, history: [{ at: now, by: user.id, action: 'REFERENCE' }], demo: input.demo ?? false,
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.referenced', resourceType: 'payment_point', resourceId: id, details: { approval: input.approval, commune: input.commune, type: input.type } });
    return point;
  }

  /** Activation par une seconde personne du Trésor : le point devient prestataire habilité (secret de signature). */
  activate(user: User, id: string): PaymentPoint {
    authorize(user, 'canaux:point.activate');
    const p = this.get(id);
    if (p.status !== 'REFERENCE') throw conflict('POINT_NOT_REFERENCED', `Point au statut ${p.status} : activation impossible.`);
    assertDistinctPerson(user.id, [p.referencedBy], "Quatre yeux : la personne qui a référencé le point ne peut pas l'activer.");
    const now = this.clock().toISOString();
    const updated = this.points.update({ ...p, status: 'ACTIF', activatedBy: user.id, activatedAt: now, history: [...p.history, { at: now, by: user.id, action: 'ACTIVATION' }] });
    this.habilitate(updated);
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.activated', resourceType: 'payment_point', resourceId: id, details: { providerId: p.providerId } });
    this.ctx.comms.publish('payment_point.accredited', this.operatorRecipients(p), { point: p.name, reference: p.id }, { entity: 'TRESOR' });
    return updated;
  }

  /** Suspension : DÉCISION HUMAINE du Trésor, motivée (ARB-12) ; le point perd immédiatement son habilitation de signature. */
  suspend(user: User, id: string, motif: string, proposalId?: string): PaymentPoint {
    authorize(user, 'canaux:point.suspend');
    const p = this.get(id);
    if (p.status !== 'ACTIF') throw conflict('POINT_NOT_ACTIVE', `Point au statut ${p.status} : suspension sans objet.`);
    if (proposalId) {
      const prop = this.proposals.get(proposalId);
      if (!prop || prop.pointId !== id) throw notFound('PROPOSAL_NOT_FOUND', 'Proposition de suspension inconnue pour ce point.');
      if (prop.status !== 'PROPOSEE') throw conflict('PROPOSAL_ALREADY_DECIDED', 'Proposition déjà traitée.');
    }
    const now = this.clock().toISOString();
    const updated = this.points.update({
      ...p, status: 'SUSPENDU', suspension: { by: user.id, at: now, motif, ...(proposalId ? { proposalId } : {}) },
      history: [...p.history, { at: now, by: user.id, action: 'SUSPENSION', motif }],
    });
    this.revokeHabilitation(updated);
    if (proposalId) this.proposals.update({ ...this.proposals.get(proposalId)!, status: 'DECIDEE_SUSPENSION', decidedBy: user.id, decidedAt: now, motif });
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.suspended', resourceType: 'payment_point', resourceId: id, details: { motif, proposalId: proposalId ?? null, decision: 'HUMAINE' } });
    this.ctx.comms.publish('payment_point.suspended', [...this.operatorRecipients(p), ...this.ctx.users.withRole('R17').map(userRecipient)], { point: p.name, reference: p.id }, { entity: 'TRESOR' });
    return updated;
  }

  reinstate(user: User, id: string, motif: string): PaymentPoint {
    authorize(user, 'canaux:point.suspend');
    const p = this.get(id);
    if (p.status !== 'SUSPENDU') throw conflict('POINT_NOT_SUSPENDED', 'Seul un point suspendu peut être rétabli.');
    const now = this.clock().toISOString();
    const { suspension: _s, ...rest } = p;
    const updated = this.points.update({ ...rest, status: 'ACTIF', history: [...p.history, { at: now, by: user.id, action: 'RETABLISSEMENT', motif }] });
    this.habilitate(updated);
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.reinstated', resourceType: 'payment_point', resourceId: id, details: { motif } });
    return updated;
  }

  dismissProposal(user: User, proposalId: string, motif: string): SuspensionProposal {
    authorize(user, 'canaux:point.suspend');
    const prop = this.proposals.get(proposalId);
    if (!prop) throw notFound('PROPOSAL_NOT_FOUND', `Proposition inconnue : ${proposalId}`);
    if (prop.status !== 'PROPOSEE') throw conflict('PROPOSAL_ALREADY_DECIDED', 'Proposition déjà traitée.');
    const updated = this.proposals.update({ ...prop, status: 'ECARTEE', decidedBy: user.id, decidedAt: this.clock().toISOString(), motif });
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.suspension_dismissed', resourceType: 'payment_point', resourceId: prop.pointId, details: { proposalId, motif } });
    return updated;
  }

  /** Liste publique (portail, SVI, USSD, avis imprimé) : jamais d'identité d'opérateur ni de plafond. */
  publicList(commune?: string) {
    return this.points
      .find((p) => (p.status === 'ACTIF' || p.status === 'SUSPENDU') && (!commune || p.commune === commune))
      .sort((a, b) => a.commune.localeCompare(b.commune, 'fr') || a.name.localeCompare(b.name, 'fr'))
      .map((p) => ({
        id: p.id, name: p.name, type: p.type, operator: p.operator, commune: p.commune, quartier: p.quartier, address: p.address,
        lat: p.lat, lon: p.lon, hours: p.hours, status: p.status === 'ACTIF' ? 'ACTIF' : 'SUSPENDU', guichetId: p.guichetId ?? null, demo: p.demo,
      }));
  }

  supervision(user: User) {
    authorize(user, 'canaux:point.supervise');
    this.scanOverdue();
    const today = kinshasaDay(this.clock());
    return {
      points: this.points.all().map((p) => ({
        ...p,
        collectionsToday: this.collections.find((c) => c.pointId === p.id && c.cashDay === today).length,
        openExceptions: this.exceptions.find((e) => e.pointId === p.id).length,
        pendingProposals: this.proposals.find((x) => x.pointId === p.id && x.status === 'PROPOSEE').length,
        habilitated: this.ctx.secrets.providerSecrets[p.providerId] !== undefined,
      })),
      proposals: this.proposals.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      exceptions: this.exceptions.all().sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
    };
  }

  // ---------- Console de l'opérateur (R32) ----------

  private assertOperator(user: User, p: PaymentPoint): void {
    authorize(user, 'canaux:point.collect');
    if (!p.operatorUserIds.includes(user.id)) throw forbidden('NOT_POINT_OPERATOR', "Cet utilisateur n'est pas opérateur de ce point de paiement agréé.");
  }

  private assertActive(p: PaymentPoint): void {
    if (p.status !== 'ACTIF') {
      throw forbidden('POINT_NOT_ACTIVE', `Point au statut ${p.status} : aucun encaissement ni aucune preuve ne peut être produit.`);
    }
  }

  myPoints(user: User) {
    authorize(user, 'canaux:point.collect');
    return this.points.find((p) => p.operatorUserIds.includes(user.id));
  }

  /** Affiche la référence : montant LU dans l'ordre (non modifiable), données minimales. */
  lookup(user: User, pointId: string, rawRef: string) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    this.assertActive(p);
    const order = this.payableOrder(normalizeReference(rawRef));
    return this.orderSummary(order);
  }

  private payableOrder(ref: string): PaymentOrder {
    const order = this.ctx.payments.byReference(ref);
    if (!order) throw notFound('PAYMENT_REFERENCE_NOT_FOUND', `Référence inconnue : ${ref}`);
    if (order.status !== 'INITIE') throw conflict('REFERENCE_NOT_PAYABLE', `Référence au statut ${order.status} : aucun encaissement possible.`, { status: order.status });
    if (new Date(order.expiresAt) <= this.clock()) throw unprocessable('PAYMENT_REFERENCE_EXPIRED', 'Référence expirée : faites générer une nouvelle référence.');
    return order;
  }

  private orderSummary(order: PaymentOrder) {
    const obligation = this.ctx.assessment.get(order.obligationId);
    const tp = this.ctx.taxpayers.get(order.taxpayerId);
    return {
      paymentReference: order.paymentReference, amount: order.amount, amountEditable: false as const, expiresAt: order.expiresAt,
      status: order.status, revenue: obligation.ruleCode, revenueLabel: obligation.label, administration: obligation.entity,
      dueDate: obligation.dueDate, taxpayerRefSuffix: `…${refSuffix(tp.iuc)}`, holderInitials: initials(tp.fullName),
    };
  }

  /** Situation sur présentation de la carte MOSOLO : obligations payables (données minimales). */
  cardSituation(user: User, pointId: string, cardNumber: string) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    this.assertActive(p);
    const card = this.cards.get(cardNumber);
    this.cards.assertUsable(card);
    return {
      card: { numberSuffix: card.number.slice(-4), holderInitials: card.holderDisplayName, commune: card.commune, status: card.status },
      obligations: this.payableObligations(card.taxpayerId),
    };
  }

  payableObligations(taxpayerId: string) {
    const now = this.clock();
    return this.ctx.assessment.byTaxpayer(taxpayerId)
      .filter((o) => PAYABLE_STATUSES.includes(o.status))
      .filter((o) => !this.ctx.payments.byObligation(o.id).some((x) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(x.status)))
      .map((o) => {
        const active = this.ctx.payments.byObligation(o.id).find((x) => x.status === 'INITIE' && new Date(x.expiresAt) > now);
        return {
          obligationId: o.id, revenue: o.ruleCode, label: o.label, amount: o.amount, dueDate: o.dueDate, entity: o.entity,
          activeReference: active?.paymentReference ?? null, activeReferenceExpiresAt: active?.expiresAt ?? null,
        };
      });
  }

  /**
   * Référence générée par le circuit commun sur présentation de la carte (mode « au guichet ») : l'ordre est créé
   * au nom du titulaire (droits du seul contribuable), montant = solde de l'obligation. Le point ne crée jamais de montant.
   */
  cardReference(user: User, pointId: string, cardNumber: string, obligationId: string) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    this.assertActive(p);
    const card = this.cards.get(cardNumber);
    this.cards.assertUsable(card);
    const obligation = this.ctx.assessment.get(obligationId);
    if (obligation.taxpayerId !== card.taxpayerId) throw forbidden('OBLIGATION_NOT_CARD_HOLDER', "Cette obligation n'appartient pas au titulaire de la carte.");
    const order = issueOrReuseReference(this.ctx, card.taxpayerId, obligationId, 'AGENT_POINT');
    this.ctx.audit.append({
      actor: this.actor(user), action: 'canaux.point.card_reference', resourceType: 'payment_order', resourceId: order.id,
      details: { pointId, cardSuffix: card.number.slice(-4), paymentReference: order.paymentReference },
    });
    return this.orderSummary(order);
  }

  private cashDayFor(pointId: string, day: string): CashDay {
    const id = `${pointId}:${day}`;
    return this.cashDays.get(id) ?? this.cashDays.insert({ id, pointId, day, status: 'OUVERTE', expected: [], expectedByAccount: [], exceptionIds: [] });
  }

  private limitFor(list: MoneyJSON[], currency: string): Money | undefined {
    const l = list.find((x) => x.currency === currency);
    return l ? Money.fromJSON(l) : undefined;
  }

  /**
   * Encaissement contre référence : contrôles (point actif, opérateur, référence payable, plafonds, caisse ouverte),
   * puis confirmation SIGNÉE par le mécanisme commun des prestataires ⇒ quittance provisoire émise par MOSOLO seul.
   */
  collect(user: User, pointId: string, rawRef: string) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    this.assertActive(p);
    const order = this.payableOrder(normalizeReference(rawRef));
    const now = this.clock();
    const day = kinshasaDay(now);
    const cashDay = this.cashDayFor(p.id, day);
    if (cashDay.status !== 'OUVERTE') throw conflict('CASH_DAY_CLOSED', `La caisse du ${day} est clôturée : aucun nouvel encaissement ce jour.`);
    const amount = Money.fromJSON(order.amount);
    const perTx = this.limitFor(p.limits.perTransaction, order.amount.currency);
    const perDay = this.limitFor(p.limits.perDay, order.amount.currency);
    if (!perTx || !perDay) throw unprocessable('CURRENCY_NOT_ACCEPTED', `Ce point n'est pas agréé pour encaisser en ${order.amount.currency}.`);
    if (amount.compare(perTx) > 0) throw unprocessable('POINT_LIMIT_EXCEEDED', `Montant supérieur au plafond par opération du point (${perTx.toDecimalString()} ${order.amount.currency}).`);
    const dayTotal = this.collections.find((c) => c.pointId === p.id && c.cashDay === day && c.amount.currency === order.amount.currency)
      .reduce((acc, c) => acc.add(Money.fromJSON(c.amount)), Money.zero(order.amount.currency as CurrencyCode));
    if (dayTotal.add(amount).compare(perDay) > 0) throw unprocessable('POINT_DAILY_LIMIT_EXCEEDED', `Plafond journalier du point atteint (${perDay.toDecimalString()} ${order.amount.currency}).`);
    const secret = this.ctx.secrets.providerSecrets[p.providerId];
    if (!secret) throw forbidden('POINT_NOT_HABILITATED', "Point sans habilitation de signature active : aucune preuve valable ne peut être émise.");

    // Confirmation serveur à serveur signée (HMAC du corps brut, nonce unique, horodatage) — circuit commun.
    const providerTxnId = `${p.id}-${this.ids.next('TX', 8)}`;
    const raw = JSON.stringify({ providerTxnId, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: now.toISOString() });
    const res = this.ctx.payments.handleCallback(p.providerId, { signature: hmacSha256Hex(secret, raw), nonce: randomUUID(), timestamp: now.toISOString() }, raw);
    if (res.status !== 'CONFIRME' || !res.receiptNumber || !res.receiptCode) {
      throw conflict('COLLECTION_NOT_CONFIRMED', `Encaissement non confirmé par le circuit commun (${res.status}) : aucune quittance, ne remettez aucun reçu.`);
    }
    let shortCode: string;
    do {
      const core = randomCode(5);
      shortCode = core + checkChar(core);
    } while (this.collections.findOne((c) => c.shortCode === shortCode));
    const obligation = this.ctx.assessment.get(order.obligationId);
    const collection = this.collections.insert({
      id: this.ids.next('ENC'), pointId: p.id, operatorUserId: user.id, paymentReference: order.paymentReference, paymentOrderId: order.id,
      obligationLabel: obligation.ruleCode, amount: order.amount, providerTxnId, receiptNumber: res.receiptNumber, receiptCode: res.receiptCode,
      shortCode, cashDay: day, collectedAt: now.toISOString(), printCount: 0,
    });
    this.ctx.audit.append({
      actor: this.actor(user), action: 'canaux.point.collection', resourceType: 'payment_order', resourceId: order.id,
      details: { pointId: p.id, collectionId: collection.id, providerTxnId, receipt: res.receiptNumber, amount: order.amount, cashDay: day },
    });
    this.ctx.comms.publish('payment_point.cash_receipt', [taxpayerRecipient(this.ctx.taxpayers.get(order.taxpayerId))], { ref_paiement: order.paymentReference, reference: order.paymentReference }, { entity: obligation.entity });
    return { collection, receipt: this.receiptView(collection, false) };
  }

  /** Reçu imprimable : la réimpression porte la mention DUPLICATA et la même référence (§ H.10.7). */
  print(user: User, pointId: string, collectionId: string) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    const c = this.collections.get(collectionId);
    if (!c || c.pointId !== p.id) throw notFound('COLLECTION_NOT_FOUND', `Encaissement inconnu : ${collectionId}`);
    const updated = this.collections.update({ ...c, printCount: c.printCount + 1 });
    const duplicata = updated.printCount > 1;
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.receipt_printed', resourceType: 'collection', resourceId: c.id, details: { duplicata, printCount: updated.printCount } });
    return this.receiptView(updated, duplicata);
  }

  receiptView(c: Collection, duplicata: boolean) {
    const p = this.get(c.pointId);
    const r = this.ctx.receipts.byPaymentOrder(c.paymentOrderId);
    if (!r) throw notFound('RECEIPT_NOT_FOUND', 'Aucune quittance émise par MOSOLO pour cet encaissement.');
    return {
      duplicata, collectionId: c.id, shortCode: c.shortCode, receiptNumber: r.number, receiptCode: r.code, receiptStatus: r.status, mention: r.mention,
      amount: r.amount, indicativeAmount: r.indicativeAmount ?? null, paymentReference: r.paymentReference, revenueCategory: r.revenueCategory, revenue: c.obligationLabel,
      administration: r.administration, beneficiaryAlias: r.beneficiaryAlias, taxpayerRefSuffix: `…${refSuffix(r.taxpayerRef)}`,
      paidAt: r.paidAt, collectedAt: c.collectedAt, qrPayload: r.qrPayload, verificationPath: r.verificationPath,
      point: { id: p.id, name: p.name, operator: p.operator, commune: p.commune, approvalReference: p.approval.reference },
      pictograms: ['PAYER', 'VERIFIER', 'ZERO_ESPECES_AGENT'],
      notices: [
        'Quittance émise par MOSOLO après confirmation signée ; le point de paiement n’émet aucun numéro.',
        r.status === 'DEFINITIVE' ? 'Quittance définitive : paiement versé au compte public et rapproché.' : 'Quittance provisoire : définitive après versement au compte public et rapprochement.',
        `Vérifiez gratuitement avec le code court ${c.shortCode} (USSD, SVI, SMS) ou en scannant le QR.`,
        'Un papier seul, sans enregistrement dans MOSOLO, n’a aucune valeur.',
      ],
    };
  }

  // ---------- Clôture de caisse et versement bancaire ----------

  private computeExpected(pointId: string, day: string) {
    const cols = this.collections.find((c) => c.pointId === pointId && c.cashDay === day);
    const byAccount = new Map<string, Money>();
    for (const c of cols) {
      const order = this.ctx.payments.orders.get(c.paymentOrderId)!;
      const key = `${order.beneficiaryAlias}|${c.amount.currency}`;
      const cur = byAccount.get(key);
      byAccount.set(key, cur ? cur.add(Money.fromJSON(c.amount)) : Money.fromJSON(c.amount));
    }
    return {
      collections: cols,
      expected: sumByCurrency(cols.map((c) => c.amount)),
      expectedByAccount: [...byAccount.entries()].map(([k, m]) => ({ accountAlias: k.split('|')[0]!, amount: m.toJSON() })),
    };
  }

  cashDayView(user: User, pointId: string, day: string) {
    const p = this.get(pointId);
    if (!p.operatorUserIds.includes(user.id)) authorize(user, 'canaux:point.supervise');
    else authorize(user, 'canaux:point.collect');
    this.scanOverdue();
    const cd = this.cashDays.get(`${pointId}:${day}`);
    const live = this.computeExpected(pointId, day);
    const collections = live.collections.map((c) => {
      const o = this.ctx.payments.orders.get(c.paymentOrderId);
      const r = this.ctx.receipts.byPaymentOrder(c.paymentOrderId);
      return { ...c, orderStatus: o?.status ?? 'INCONNU', receiptStatus: r?.status ?? null };
    });
    return {
      pointId, day, status: cd?.status ?? 'OUVERTE',
      expected: cd && cd.status !== 'OUVERTE' ? cd.expected : live.expected,
      expectedByAccount: cd && cd.status !== 'OUVERTE' ? cd.expectedByAccount : live.expectedByAccount,
      counted: cd?.counted ?? null, closedAt: cd?.closedAt ?? null, deposit: cd?.deposit ?? null,
      depositDeadline: this.deadline(p, day, cd).toISOString(),
      collections, reconciledCount: collections.filter((c) => c.orderStatus === 'RAPPROCHE').length,
      exceptions: this.exceptions.find((e) => e.pointId === pointId && e.day === day),
    };
  }

  private deadline(p: PaymentPoint, day: string, cd?: CashDay): Date {
    const endOfDay = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 24 * HOUR_MS - KINSHASA_OFFSET_MS);
    const base = cd?.closedAt ? new Date(cd.closedAt) : endOfDay;
    return new Date(base.getTime() + p.settlementDelayHours * HOUR_MS);
  }

  close(user: User, pointId: string, day: string, counted: MoneyJSON[]) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    if (day > kinshasaDay(this.clock())) throw unprocessable('CASH_DAY_IN_FUTURE', 'Impossible de clôturer un jour futur.');
    const cd = this.cashDayFor(pointId, day);
    if (cd.status !== 'OUVERTE') throw conflict('CASH_DAY_ALREADY_CLOSED', `Caisse du ${day} déjà clôturée.`);
    const live = this.computeExpected(pointId, day);
    const now = this.clock().toISOString();
    let updated = this.cashDays.update({ ...cd, status: 'CLOTUREE', expected: live.expected, expectedByAccount: live.expectedByAccount, counted: sumByCurrency(counted), closedAt: now, closedBy: user.id });
    if (!sameTotals(live.expected, counted)) {
      const ex = this.openException(p, day, 'ECART_CAISSE', 'Espèces comptées à la clôture différentes des encaissements confirmés du jour.', live.expected, counted);
      updated = this.cashDays.update({ ...updated, status: 'ECART', exceptionIds: [...updated.exceptionIds, ex.id] });
    }
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.cash_day_closed', resourceType: 'cash_day', resourceId: cd.id, details: { expected: live.expected, counted, status: updated.status } });
    return this.cashDayView(user, pointId, day);
  }

  /** Versement bancaire au(x) compte(s) public(s) du coffre, rapproché des encaissements confirmés. */
  deposit(user: User, pointId: string, day: string, input: { bankSlipRef: string; depositedAt: string; lines: { accountAlias: string; amount: MoneyJSON }[] }) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    const cd = this.cashDays.get(`${pointId}:${day}`);
    if (!cd || cd.status === 'OUVERTE') throw conflict('CASH_DAY_NOT_CLOSED', 'Clôturez la caisse du jour avant de déclarer le versement.');
    if (cd.deposit) throw conflict('DEPOSIT_ALREADY_DECLARED', 'Versement déjà déclaré pour ce jour.');
    for (const l of input.lines) {
      if (!this.ctx.vault.aliasExists(l.accountAlias)) {
        this.ctx.alerts.raise({
          type: 'DEPOSIT_TO_NON_PUBLIC_ACCOUNT', severity: 'CRITICAL', source: 'canaux:points', actor: this.actor(user),
          detail: `Versement déclaré vers ${l.accountAlias}, compte inconnu du coffre : refusé.`, context: { pointId, day },
        });
        throw unprocessable('NOT_A_PUBLIC_ACCOUNT', `Le compte ${l.accountAlias} n'est pas un compte public du coffre : versement refusé.`);
      }
    }
    const now = this.clock();
    let updated = this.cashDays.update({ ...cd, deposit: { bankSlipRef: input.bankSlipRef, lines: input.lines, depositedAt: input.depositedAt, declaredBy: user.id, declaredAt: now.toISOString() } });
    const keyed = (xs: { accountAlias: string; amount: MoneyJSON }[]) => {
      const m = new Map<string, MoneyJSON[]>();
      for (const x of xs) m.set(x.accountAlias, [...(m.get(x.accountAlias) ?? []), x.amount]);
      return m;
    };
    const exp = keyed(cd.expectedByAccount);
    const got = keyed(input.lines);
    const aliases = new Set([...exp.keys(), ...got.keys()]);
    const mismatch = [...aliases].some((a) => !sameTotals(exp.get(a) ?? [], got.get(a) ?? []));
    const ids: string[] = [];
    if (mismatch) {
      ids.push(this.openException(p, day, 'ECART_VERSEMENT', 'Versement bancaire différent des encaissements confirmés, par compte public.', cd.expected, input.lines.map((l) => l.amount)).id);
    }
    const late = new Date(input.depositedAt) > this.deadline(p, day, cd);
    if (late && !this.exceptions.findOne((e) => e.pointId === p.id && e.day === day && e.type === 'VERSEMENT_EN_RETARD')) {
      ids.push(this.openException(p, day, 'VERSEMENT_EN_RETARD', `Versement effectué après le délai contractuel de ${p.settlementDelayHours} h.`, cd.expected, input.lines.map((l) => l.amount)).id);
    }
    const hasOpen = cd.exceptionIds.length + ids.length > 0;
    updated = this.cashDays.update({ ...updated, status: hasOpen ? 'ECART' : 'VERSEE', exceptionIds: [...updated.exceptionIds, ...ids] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.deposit_declared', resourceType: 'cash_day', resourceId: cd.id, details: { bankSlipRef: input.bankSlipRef, lines: input.lines, status: updated.status } });
    return this.cashDayView(user, pointId, day);
  }

  /** Versements manquants au-delà du délai contractuel : exception + proposition (jamais de suspension automatique). */
  scanOverdue(): void {
    const now = this.clock();
    for (const p of this.points.all()) {
      const days = new Set(this.collections.find((c) => c.pointId === p.id).map((c) => c.cashDay));
      for (const day of days) {
        const cd = this.cashDays.get(`${p.id}:${day}`);
        if (cd?.deposit) continue;
        if (now <= this.deadline(p, day, cd)) continue;
        if (this.exceptions.findOne((e) => e.pointId === p.id && e.day === day && e.type === 'VERSEMENT_EN_RETARD')) continue;
        const expected = cd && cd.status !== 'OUVERTE' ? cd.expected : this.computeExpected(p.id, day).expected;
        const ex = this.openException(p, day, 'VERSEMENT_EN_RETARD', `Aucun versement au compte public dans le délai contractuel de ${p.settlementDelayHours} h : espèces conservées hors circuit bancaire.`, expected, []);
        if (cd) this.cashDays.update({ ...cd, exceptionIds: [...cd.exceptionIds, ex.id] });
        this.ctx.comms.publish('payment_point.settlement_overdue', this.ctx.users.withRole('R17').map(userRecipient), { point: p.name, reference: p.id }, { entity: 'TRESOR' });
      }
    }
  }

  private openException(p: PaymentPoint, day: string, type: PointExceptionType, detail: string, expected: MoneyJSON[], observed: MoneyJSON[]): PointException {
    const now = this.clock().toISOString();
    const ex = this.exceptions.insert({ id: this.ids.next('EXCPA'), pointId: p.id, day, type, detail, expected, observed: sumByCurrency(observed), status: 'OUVERTE', openedAt: now });
    this.ctx.alerts.raise({
      type: `PAYMENT_POINT_${type}`, severity: type === 'ECART_CAISSE' ? 'MEDIUM' : 'HIGH', source: 'canaux:points',
      detail: `${p.name} (${p.id}), ${day} : ${detail}`, context: { pointId: p.id, day, exceptionId: ex.id },
    });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'canaux:rapprochement-points' }, action: 'canaux.point.exception_opened', resourceType: 'payment_point', resourceId: p.id, outcome: 'FAILURE', details: { exceptionId: ex.id, type, day } });
    if (p.status === 'ACTIF' && !this.proposals.findOne((x) => x.pointId === p.id && x.status === 'PROPOSEE')) {
      const prop = this.proposals.insert({ id: this.ids.next('PROPSUSP'), pointId: p.id, reason: type, detail, exceptionId: ex.id, status: 'PROPOSEE', proposedAt: now });
      this.ctx.audit.append({ actor: { kind: 'system', id: 'canaux:rapprochement-points' }, action: 'canaux.point.suspension_proposed', resourceType: 'payment_point', resourceId: p.id, details: { proposalId: prop.id, reason: type, decision: 'EN_ATTENTE_DU_TRESOR' } });
    }
    return ex;
  }

  private operatorRecipients(p: PaymentPoint) {
    return p.operatorUserIds.map((id) => this.ctx.users.get(id)).filter((u): u is User => !!u).map(userRecipient);
  }

  private actor(user: User) {
    return { kind: 'user' as const, id: user.id, roles: user.roles };
  }

  private clock(): Date {
    return this.ctx.clock.now();
  }
}

/**
 * Émet (ou ré-affiche) la référence du circuit commun pour une obligation, au nom du seul titulaire.
 * Une référence active existante est réutilisée : jamais deux références actives pour une même obligation.
 */
export function issueOrReuseReference(ctx: AppContext, taxpayerId: string, obligationId: string, channel: 'USSD' | 'AGENT_POINT' | 'MOBILE_MONEY'): PaymentOrder {
  const principal = holderPrincipal(taxpayerId, channel);
  try {
    return ctx.payments.createOrder(principal, obligationId, { channel });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'ACTIVE_PAYMENT_REFERENCE_EXISTS') {
      const ref = String(e.extensions.paymentReference ?? '');
      const existing = ctx.payments.byReference(ref);
      if (existing) return existing;
    }
    throw e;
  }
}
