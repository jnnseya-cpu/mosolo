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
import { assertDistinctPerson, authorize, PUBLIC_AGENT_ROLES } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { signedCallbackHeaders } from '../../modules/payments/callback-signing.js';
import type { PaymentOrder, UnappliedPayment } from '../../modules/payments/service.js';
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

/** Rôles d'agent public (R01–R29, R35) : jamais opérateur d'un point qui reçoit des espèces (aucun agent ne reçoit d'argent). */
const PUBLIC_AGENT_ROLE_SET = new Set<string>([...PUBLIC_AGENT_ROLES, 'R35']);
export function holdsPublicAgentRole(roles: readonly string[]): boolean {
  return roles.some((r) => PUBLIC_AGENT_ROLE_SET.has(r));
}

/** Délai laissé au relevé bancaire pour constater un versement déclaré, au-delà du délai contractuel (heures). */
export const BANK_CONFIRMATION_GRACE_HOURS = 48;
/** Encaissement confirmé non rapproché au relevé au-delà de ce nombre de jours : exception de vieillissement. */
export const UNRECONCILED_AGING_DAYS = 3;

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

/** Référence de bordereau normalisée (espaces et casse ignorés) : un bordereau ne sert qu'une fois. */
export function normalizeSlipRef(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** Égalité des montants par compte public et devise. */
function sameByAccount(a: { accountAlias: string; amount: MoneyJSON }[], b: { accountAlias: string; amount: MoneyJSON }[]): boolean {
  const keyed = (xs: { accountAlias: string; amount: MoneyJSON }[]) => {
    const m = new Map<string, MoneyJSON[]>();
    for (const x of xs) m.set(x.accountAlias, [...(m.get(x.accountAlias) ?? []), x.amount]);
    return m;
  };
  const ka = keyed(a);
  const kb = keyed(b);
  return [...new Set([...ka.keys(), ...kb.keys()])].every((k) => sameTotals(ka.get(k) ?? [], kb.get(k) ?? []));
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
  /**
   * Habilitation d'un point ACTIF restauré depuis la persistance : le secret (dérivé, jamais stocké) est rétabli.
   * Un point non actif n'en reçoit jamais.
   */
  private ensureHabilitated(p: PaymentPoint): string | undefined {
    if (p.status === 'ACTIF' && this.ctx.secrets.providerSecrets[p.providerId] === undefined) this.habilitate(p);
    return this.ctx.secrets.providerSecrets[p.providerId];
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
      // Aucun agent public ne reçoit d'espèces : un titulaire d'un rôle d'agent (R01–R29, R35) n'est jamais opérateur.
      if (holdsPublicAgentRole(u.roles)) {
        throw unprocessable('OPERATOR_IS_PUBLIC_AGENT', `L'utilisateur ${uid} détient un rôle d'agent public : il ne peut pas être opérateur d'un point qui encaisse des espèces.`);
      }
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

  /**
   * Rétablissement à QUATRE YEUX (comme l'activation) : le premier appel (R17 ou R18) enregistre la demande motivée ;
   * seul un R17 DISTINCT du demandeur (et de celui qui a suspendu) la décide. Un R17 seul ne rend jamais la signature.
   */
  reinstate(user: User, id: string, motif: string): PaymentPoint {
    const p = this.get(id);
    if (p.status !== 'SUSPENDU') throw conflict('POINT_NOT_SUSPENDED', 'Seul un point suspendu peut être rétabli.');
    const now = this.clock().toISOString();
    if (!p.reinstatementRequest) {
      authorize(user, 'canaux:point.decision.request');
      const updated = this.points.update({ ...p, reinstatementRequest: { by: user.id, at: now, motif }, history: [...p.history, { at: now, by: user.id, action: 'DEMANDE_RETABLISSEMENT', motif }] });
      this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.reinstatement_requested', resourceType: 'payment_point', resourceId: id, details: { motif, decision: 'EN_ATTENTE_SECONDE_PERSONNE' } });
      return updated;
    }
    authorize(user, 'canaux:point.suspend');
    assertDistinctPerson(user.id, [p.reinstatementRequest.by, ...(p.suspension ? [p.suspension.by] : [])], 'Quatre yeux : le rétablissement est décidé par une personne distincte du demandeur et de celle qui a suspendu.');
    const { suspension: _s, reinstatementRequest: req, ...rest } = p;
    const updated = this.points.update({ ...rest, status: 'ACTIF', history: [...p.history, { at: now, by: user.id, action: 'RETABLISSEMENT', motif }] });
    this.habilitate(updated);
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.reinstated', resourceType: 'payment_point', resourceId: id, details: { motif, requestedBy: req.by, requestMotif: req.motif } });
    return updated;
  }

  /** Écartement d'une proposition de suspension à QUATRE YEUX : demande (R17/R18), puis décision par un R17 distinct. */
  dismissProposal(user: User, proposalId: string, motif: string): SuspensionProposal {
    const prop = this.proposals.get(proposalId);
    if (!prop) throw notFound('PROPOSAL_NOT_FOUND', `Proposition inconnue : ${proposalId}`);
    if (prop.status !== 'PROPOSEE') throw conflict('PROPOSAL_ALREADY_DECIDED', 'Proposition déjà traitée.');
    const now = this.clock().toISOString();
    if (!prop.dismissalRequest) {
      authorize(user, 'canaux:point.decision.request');
      const updated = this.proposals.update({ ...prop, dismissalRequest: { by: user.id, at: now, motif } });
      this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.suspension_dismissal_requested', resourceType: 'payment_point', resourceId: prop.pointId, details: { proposalId, motif, decision: 'EN_ATTENTE_SECONDE_PERSONNE' } });
      return updated;
    }
    authorize(user, 'canaux:point.suspend');
    assertDistinctPerson(user.id, [prop.dismissalRequest.by], 'Quatre yeux : la proposition est écartée par une personne distincte du demandeur.');
    const updated = this.proposals.update({ ...prop, status: 'ECARTEE', decidedBy: user.id, decidedAt: now, motif });
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.suspension_dismissed', resourceType: 'payment_point', resourceId: prop.pointId, details: { proposalId, motif, requestedBy: prop.dismissalRequest.by } });
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
        habilitated: this.ensureHabilitated(p) !== undefined,
      })),
      proposals: this.proposals.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      exceptions: this.exceptions.all().sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
    };
  }

  // ---------- Console de l'opérateur (R32) ----------

  private assertOperator(user: User, p: PaymentPoint): void {
    authorize(user, 'canaux:point.collect');
    if (!p.operatorUserIds.includes(user.id)) throw forbidden('NOT_POINT_OPERATOR', "Cet utilisateur n'est pas opérateur de ce point de paiement agréé.");
    // Rôle d'agent ajouté après le référencement : refus au moment de l'acte (aucun agent ne manipule d'espèces).
    if (holdsPublicAgentRole(user.roles)) throw forbidden('OPERATOR_IS_PUBLIC_AGENT', "Un agent public ne peut pas opérer un point qui encaisse des espèces.");
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
    // Obligation annulée, admise en non-valeur, soldée ou rectifiée : aucune espèce ne doit être reçue sur la référence
    // (elle finirait en paiement non affecté, à rembourser, pendant que l'opérateur garde l'argent).
    const obligation = this.ctx.assessment.get(order.obligationId);
    if (obligation.supersededBy || !PAYABLE_STATUSES.includes(obligation.status)) {
      throw conflict('OBLIGATION_NOT_PAYABLE', `Obligation ${obligation.supersededBy ? 'rectifiée' : `au statut ${obligation.status}`} : aucun encaissement sur cette référence.`, { status: obligation.status, supersededBy: obligation.supersededBy ?? null });
    }
    // Une référence liée à une intention d'un prestataire connecté ne se paie que chez lui : le point ne peut pas
    // la confirmer (la confirmation serait refusée après encaissement des espèces).
    if (order.providerIntentId) {
      throw conflict('REFERENCE_PROVIDER_LINKED', `Référence liée au prestataire ${order.provider ?? ''} : elle se paie uniquement chez lui, pas en espèces au point.`, { provider: order.provider ?? null });
    }
    return order;
  }

  private orderSummary(order: PaymentOrder) {
    const obligation = this.ctx.assessment.get(order.obligationId);
    const tp = this.ctx.taxpayers.get(order.taxpayerId);
    return {
      paymentReference: order.paymentReference, amount: order.amount, amountEditable: false as const, createdAt: order.createdAt, expiresAt: order.expiresAt,
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
    // Payable = solde restant positif (un paiement partiel laisse le solde payable) ; montant affiché = montant de
    // l'ordre à payer : celui de la référence active, sinon le solde restant.
    return this.ctx.assessment.byTaxpayer(taxpayerId)
      .filter((o) => PAYABLE_STATUSES.includes(o.status))
      .map((o) => ({ o, remaining: Money.fromJSON(o.amount).subtract(this.ctx.payments.paidOn(o.id)) }))
      .filter(({ remaining }) => !remaining.isZero() && !remaining.isNegative())
      .map(({ o, remaining }) => {
        const active = this.ctx.payments.byObligation(o.id).find((x) => x.status === 'INITIE' && new Date(x.expiresAt) > now);
        return {
          obligationId: o.id, revenue: o.ruleCode, label: o.label, amount: active?.amount ?? remaining.toJSON(), obligationAmount: o.amount, dueDate: o.dueDate, entity: o.entity,
          activeReference: active?.paymentReference ?? null, activeReferenceCreatedAt: active?.createdAt ?? null, activeReferenceExpiresAt: active?.expiresAt ?? null,
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
    const secret = this.ensureHabilitated(p);
    if (!secret) throw forbidden('POINT_NOT_HABILITATED', "Point sans habilitation de signature active : aucune preuve valable ne peut être émise.");

    // Confirmation serveur à serveur signée (HMAC du corps brut, nonce unique, horodatage) — circuit commun.
    const providerTxnId = `${p.id}-${this.ids.next('TX', 8)}`;
    const raw = JSON.stringify({ providerTxnId, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: now.toISOString() });
    const res = this.ctx.payments.handleCallback(p.providerId, signedCallbackHeaders(secret, raw, now), raw);
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

  /**
   * Paiements non affectés reçus par le point (référence fermée, obligation non payable, doublon) : les espèces sont
   * au point tant que le Trésor ne les a pas restituées ; elles comptent dans l'attendu de leur jour de caisse.
   */
  private unappliedFor(p: PaymentPoint, day: string): UnappliedPayment[] {
    const tresor = this.ctx.ext.tresor as { suspense?: { findOne(fn: (s: { unappliedId?: string; status: string }) => boolean): unknown } } | undefined;
    const refunded = (u: UnappliedPayment) =>
      this.ctx.payments.orders.get(u.paymentOrderId)?.status === 'REMBOURSE'
      || !!tresor?.suspense?.findOne((s) => s.unappliedId === u.id && s.status === 'APURE');
    return this.ctx.payments.unappliedPayments.all().filter((u) => u.provider === p.providerId && kinshasaDay(new Date(u.receivedAt)) === day && !refunded(u));
  }

  private computeExpected(pointId: string, day: string) {
    const p = this.get(pointId);
    const cols = this.collections.find((c) => c.pointId === pointId && c.cashDay === day);
    const unapplied = this.unappliedFor(p, day);
    const byAccount = new Map<string, Money>();
    const add = (alias: string, amount: MoneyJSON) => {
      const key = `${alias}|${amount.currency}`;
      const cur = byAccount.get(key);
      byAccount.set(key, cur ? cur.add(Money.fromJSON(amount)) : Money.fromJSON(amount));
    };
    for (const c of cols) add(this.ctx.payments.orders.get(c.paymentOrderId)!.beneficiaryAlias, c.amount);
    for (const u of unapplied) add(u.beneficiaryAlias, u.amount);
    return {
      collections: cols,
      unapplied,
      expected: sumByCurrency([...cols.map((c) => c.amount), ...unapplied.map((u) => u.amount)]),
      expectedByAccount: [...byAccount.entries()].map(([k, m]) => ({ accountAlias: k.split('|')[0]!, amount: m.toJSON() })),
    };
  }

  cashDayView(user: User, pointId: string, day: string) {
    const p = this.get(pointId);
    if (!p.operatorUserIds.includes(user.id)) authorize(user, 'canaux:point.supervise');
    else this.assertOperator(user, p);
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
      depositDeadline: this.deadline(p, day).toISOString(),
      collections, reconciledCount: collections.filter((c) => c.orderStatus === 'RAPPROCHE').length,
      unapplied: live.unapplied.map((u) => ({ id: u.id, paymentReference: u.paymentReference, amount: u.amount, reason: u.reason, receivedAt: u.receivedAt })),
      exceptions: this.exceptions.find((e) => e.pointId === pointId && e.day === day),
    };
  }

  /**
   * Échéance de versement : fin du jour de caisse (minuit, heure de Kinshasa, horloge serveur) + délai contractuel.
   * Jamais comptée depuis la clôture : clôturer tard ne repousse pas l'échéance (espèces gardées hors banque).
   */
  private deadline(p: PaymentPoint, day: string): Date {
    const endOfDay = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 24 * HOUR_MS - KINSHASA_OFFSET_MS);
    return new Date(endOfDay.getTime() + p.settlementDelayHours * HOUR_MS);
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

  /**
   * Déclaration du versement bancaire par l'opérateur : statut DECLAREE (en attente du relevé), jamais VERSEE.
   * La date déclarée est bornée (après la clôture, pas dans le futur) ; un bordereau ne sert qu'une fois.
   */
  deposit(user: User, pointId: string, day: string, input: { bankSlipRef: string; depositedAt: string; lines: { accountAlias: string; amount: MoneyJSON }[] }) {
    const p = this.get(pointId);
    this.assertOperator(user, p);
    // Retard constaté à l'horloge serveur AVANT que la déclaration ne puisse le masquer.
    this.scanOverdue();
    const cd = this.cashDays.get(`${pointId}:${day}`);
    if (!cd || cd.status === 'OUVERTE') throw conflict('CASH_DAY_NOT_CLOSED', 'Clôturez la caisse du jour avant de déclarer le versement.');
    if (cd.deposit) throw conflict('DEPOSIT_ALREADY_DECLARED', 'Versement déjà déclaré pour ce jour.');
    const now = this.clock();
    const depositedAt = new Date(input.depositedAt);
    if (Number.isNaN(depositedAt.getTime()) || depositedAt < new Date(cd.closedAt!)) {
      throw unprocessable('DEPOSIT_BEFORE_CLOSE', 'Date de versement antérieure à la clôture de caisse : refusée.');
    }
    if (depositedAt > now) throw unprocessable('DEPOSIT_IN_FUTURE', 'Date de versement dans le futur : refusée.');
    const slip = normalizeSlipRef(input.bankSlipRef);
    const reused = this.cashDays.findOne((d) => d.id !== cd.id && !!d.deposit && normalizeSlipRef(d.deposit.bankSlipRef) === slip);
    if (reused) throw conflict('BANK_SLIP_ALREADY_USED', `Bordereau ${input.bankSlipRef} déjà déclaré pour une autre caisse (${reused.pointId}, ${reused.day}).`);
    for (const l of input.lines) {
      if (!this.ctx.vault.aliasExists(l.accountAlias)) {
        this.ctx.alerts.raise({
          type: 'DEPOSIT_TO_NON_PUBLIC_ACCOUNT', severity: 'CRITICAL', source: 'canaux:points', actor: this.actor(user),
          detail: `Versement déclaré vers ${l.accountAlias}, compte inconnu du coffre : refusé.`, context: { pointId, day },
        });
        throw unprocessable('NOT_A_PUBLIC_ACCOUNT', `Le compte ${l.accountAlias} n'est pas un compte public du coffre : versement refusé.`);
      }
    }
    let updated = this.cashDays.update({ ...cd, deposit: { bankSlipRef: slip, lines: input.lines, depositedAt: depositedAt.toISOString(), declaredBy: user.id, declaredAt: now.toISOString() } });
    const ids: string[] = [];
    if (!sameByAccount(cd.expectedByAccount, input.lines)) {
      ids.push(this.openException(p, day, 'ECART_VERSEMENT', 'Versement bancaire différent des encaissements confirmés, par compte public.', cd.expected, input.lines.map((l) => l.amount)).id);
    }
    const late = depositedAt > this.deadline(p, day);
    if (late && !this.exceptions.findOne((e) => e.pointId === p.id && e.day === day && e.type === 'VERSEMENT_EN_RETARD')) {
      ids.push(this.openException(p, day, 'VERSEMENT_EN_RETARD', `Versement effectué après le délai contractuel de ${p.settlementDelayHours} h.`, cd.expected, input.lines.map((l) => l.amount)).id);
    }
    const hasOpen = cd.exceptionIds.length + ids.length > 0;
    updated = this.cashDays.update({ ...updated, status: hasOpen ? 'ECART' : 'DECLAREE', exceptionIds: [...updated.exceptionIds, ...ids] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.deposit_declared', resourceType: 'cash_day', resourceId: cd.id, details: { bankSlipRef: slip, lines: input.lines, status: updated.status, depositedAt: depositedAt.toISOString() } });
    return this.cashDayView(user, pointId, day);
  }

  /**
   * Appariement d'un versement déclaré avec le relevé du compte public (appelable par l'import du Trésor) : ligne(s)
   * portant la référence du bordereau, montants par compte ÉGAUX aux lignes déclarées, date de valeur plausible.
   * Ne modifie rien : renvoie la caisse concernée ou lève une erreur explicite.
   */
  matchDepositFromStatement(slipRef: string, lines: { accountAlias: string; amount: MoneyJSON }[], valueDate: string): CashDay {
    const slip = normalizeSlipRef(slipRef);
    const cd = this.cashDays.findOne((d) => !!d.deposit && normalizeSlipRef(d.deposit.bankSlipRef) === slip);
    if (!cd?.deposit) throw notFound('DEPOSIT_NOT_FOUND', `Aucun versement déclaré avec le bordereau ${slipRef}.`);
    if (cd.deposit.bankMatch?.approvedAt) throw conflict('DEPOSIT_ALREADY_CONFIRMED', 'Versement déjà constaté au relevé bancaire.');
    if (valueDate < cd.day || valueDate > kinshasaDay(this.clock())) {
      throw unprocessable('STATEMENT_VALUE_DATE_INVALID', `Date de valeur ${valueDate} incohérente avec le jour de caisse ${cd.day}.`);
    }
    if (!sameByAccount(cd.deposit.lines, lines)) {
      throw unprocessable('STATEMENT_AMOUNT_MISMATCH', 'Montants crédités au relevé différents du versement déclaré (par compte public) : constatation refusée.');
    }
    return cd;
  }

  /** Lignes du relevé importé portant la référence du bordereau (crédit orphelin du Trésor), non encore consommées. */
  private statementLinesFor(statementId: string, slip: string, excludeCashDayId: string) {
    const used = new Set(this.cashDays.find((d) => d.id !== excludeCashDayId).flatMap((d) => d.deposit?.bankMatch?.exceptionIds ?? []));
    return this.ctx.treasury.exceptions
      .find((e) => e.statementId === statementId && e.type === 'ORPHAN_CREDIT' && !!e.line && normalizeSlipRef(e.line.paymentReference) === slip && !used.has(e.id))
      .map((e) => ({ exceptionId: e.id, line: e.line! }));
  }

  /** Constatation au relevé, étape 1 : un membre du Trésor (R17/R18) propose l'appariement avec les lignes d'un relevé importé. */
  proposeBankMatch(user: User, pointId: string, day: string, statementId: string) {
    authorize(user, 'canaux:point.decision.request');
    const cd = this.cashDays.get(`${pointId}:${day}`);
    if (!cd?.deposit) throw conflict('DEPOSIT_NOT_DECLARED', 'Aucun versement déclaré pour cette caisse.');
    if (cd.deposit.bankMatch) throw conflict('BANK_MATCH_ALREADY_PROPOSED', 'Constatation déjà proposée ou approuvée pour ce versement.');
    const found = this.statementLinesFor(statementId, normalizeSlipRef(cd.deposit.bankSlipRef), cd.id);
    if (found.length === 0) throw notFound('STATEMENT_LINE_NOT_FOUND', `Aucune ligne du relevé ${statementId} ne porte le bordereau ${cd.deposit.bankSlipRef}.`);
    const lines = found.map((f) => ({ accountAlias: f.line.accountAlias, amount: f.line.amount }));
    const valueDate = found.map((f) => f.line.valueDate).sort().at(-1)!;
    const matched = this.matchDepositFromStatement(cd.deposit.bankSlipRef, lines, valueDate);
    if (matched.id !== cd.id) throw conflict('BANK_SLIP_MISMATCH', 'Le bordereau du relevé correspond à une autre caisse.');
    const now = this.clock().toISOString();
    const updated = this.cashDays.update({ ...cd, deposit: { ...cd.deposit, bankMatch: { statementId, exceptionIds: found.map((f) => f.exceptionId), valueDate, lines, proposedBy: user.id, proposedAt: now } } });
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.deposit_match_proposed', resourceType: 'cash_day', resourceId: cd.id, details: { statementId, valueDate, lines, decision: 'EN_ATTENTE_SECONDE_PERSONNE' } });
    return updated;
  }

  /**
   * Constatation au relevé, étape 2 (quatre yeux) : un R17 distinct du proposant et du déclarant approuve. La caisse
   * passe VERSEE et, si le versement couvre exactement l'attendu, chaque encaissement du jour est rapproché (quittance
   * définitive) par le circuit commun du Trésor.
   */
  approveBankMatch(user: User, pointId: string, day: string) {
    authorize(user, 'canaux:point.deposit.confirm');
    const p = this.get(pointId);
    const cd = this.cashDays.get(`${pointId}:${day}`);
    const bm = cd?.deposit?.bankMatch;
    if (!cd?.deposit || !bm) throw conflict('BANK_MATCH_NOT_PROPOSED', 'Aucune constatation au relevé proposée pour ce versement.');
    if (bm.approvedAt) throw conflict('DEPOSIT_ALREADY_CONFIRMED', 'Versement déjà constaté au relevé bancaire.');
    assertDistinctPerson(user.id, [bm.proposedBy, cd.deposit.declaredBy], 'Quatre yeux : la constatation est approuvée par une personne distincte du proposant et du déclarant.');
    this.matchDepositFromStatement(cd.deposit.bankSlipRef, bm.lines, bm.valueDate);
    const now = this.clock().toISOString();
    const ids: string[] = [];
    if (bm.valueDate > kinshasaDay(this.deadline(p, day)) && !this.exceptions.findOne((e) => e.pointId === p.id && e.day === day && e.type === 'VERSEMENT_EN_RETARD')) {
      ids.push(this.openException(p, day, 'VERSEMENT_EN_RETARD', `Crédit au relevé (valeur ${bm.valueDate}) après le délai contractuel de ${p.settlementDelayHours} h.`, cd.expected, bm.lines.map((l) => l.amount)).id);
    }
    const exceptionIds = [...cd.exceptionIds, ...ids];
    const updated = this.cashDays.update({ ...cd, status: exceptionIds.length > 0 ? 'ECART' : 'VERSEE', exceptionIds, deposit: { ...cd.deposit, bankMatch: { ...bm, approvedBy: user.id, approvedAt: now } } });
    const reconciled: string[] = [];
    if (sameByAccount(cd.expectedByAccount, bm.lines)) {
      for (const c of this.collections.find((x) => x.pointId === pointId && x.cashDay === day)) {
        if (this.ctx.payments.orders.get(c.paymentOrderId)?.status !== 'CONFIRME') continue;
        this.ctx.treasury.completeMatch(c.paymentOrderId, {
          debit: 'COMPTE_PUBLIC_RECETTES', description: `Versement ${cd.deposit.bankSlipRef} du point ${p.id} (${day}), relevé ${bm.statementId}`,
          actor: this.actor(user), details: { statementId: bm.statementId, bankSlipRef: cd.deposit.bankSlipRef, pointId, day },
        });
        reconciled.push(c.paymentReference);
      }
    }
    this.ctx.audit.append({ actor: this.actor(user), action: 'canaux.point.deposit_confirmed', resourceType: 'cash_day', resourceId: cd.id, details: { statementId: bm.statementId, proposedBy: bm.proposedBy, reconciled, status: updated.status } });
    return this.cashDayView(user, pointId, day);
  }

  /**
   * Balayage (à chaque consultation, à chaque déclaration et périodiquement) :
   * - versement non déclaré après l'échéance, ou déclaré mais non constaté au relevé après l'échéance + délai de relevé ;
   * - encaissements confirmés non rapprochés au-delà de N jours (vieillissement).
   * Exception + proposition, jamais de suspension automatique.
   */
  scanOverdue(): void {
    const now = this.clock();
    for (const p of this.points.all()) {
      const days = new Set([
        ...this.collections.find((c) => c.pointId === p.id).map((c) => c.cashDay),
        ...this.ctx.payments.unappliedPayments.all().filter((u) => u.provider === p.providerId).map((u) => kinshasaDay(new Date(u.receivedAt))),
      ]);
      for (const day of days) {
        const cd = this.cashDays.get(`${p.id}:${day}`);
        if (cd?.deposit?.bankMatch?.approvedAt) continue;
        // Encaissements tous rapprochés un à un au relevé (crédits par référence) : l'argent est arrivé.
        const cols = this.collections.find((c) => c.pointId === p.id && c.cashDay === day);
        const allReconciled = cols.length > 0 && cols.every((c) => ['RAPPROCHE', 'REGLE'].includes(this.ctx.payments.orders.get(c.paymentOrderId)?.status ?? ''));
        if (allReconciled && this.unappliedFor(p, day).length === 0) continue;
        const limit = new Date(this.deadline(p, day).getTime() + (cd?.deposit ? BANK_CONFIRMATION_GRACE_HOURS * HOUR_MS : 0));
        if (now <= limit) continue;
        if (this.exceptions.findOne((e) => e.pointId === p.id && e.day === day && e.type === 'VERSEMENT_EN_RETARD')) continue;
        const expected = cd && cd.status !== 'OUVERTE' ? cd.expected : this.computeExpected(p.id, day).expected;
        const detail = cd?.deposit
          ? `Versement déclaré (bordereau ${cd.deposit.bankSlipRef}) non constaté au relevé du compte public ${BANK_CONFIRMATION_GRACE_HOURS} h après le délai contractuel.`
          : `Aucun versement au compte public dans le délai contractuel de ${p.settlementDelayHours} h : espèces conservées hors circuit bancaire.`;
        const ex = this.openException(p, day, 'VERSEMENT_EN_RETARD', detail, expected, []);
        const cur = this.cashDays.get(`${p.id}:${day}`);
        if (cur) this.cashDays.update({ ...cur, status: cur.status === 'OUVERTE' ? cur.status : 'ECART', exceptionIds: [...cur.exceptionIds, ex.id] });
        this.ctx.comms.publish('payment_point.settlement_overdue', this.ctx.users.withRole('R17').map(userRecipient), { point: p.name, reference: p.id }, { entity: 'TRESOR' });
      }
      // Vieillissement : encaissements CONFIRME (quittance provisoire) non rapprochés depuis plus de N jours.
      const aged = new Map<string, Collection[]>();
      for (const c of this.collections.find((x) => x.pointId === p.id)) {
        if (now.getTime() - new Date(c.collectedAt).getTime() <= UNRECONCILED_AGING_DAYS * 24 * HOUR_MS) continue;
        if (this.ctx.payments.orders.get(c.paymentOrderId)?.status !== 'CONFIRME') continue;
        aged.set(c.cashDay, [...(aged.get(c.cashDay) ?? []), c]);
      }
      for (const [day, cols] of aged) {
        if (this.exceptions.findOne((e) => e.pointId === p.id && e.day === day && e.type === 'ENCAISSEMENT_NON_RAPPROCHE')) continue;
        const ex = this.openException(p, day, 'ENCAISSEMENT_NON_RAPPROCHE', `${cols.length} encaissement(s) confirmé(s) non rapproché(s) au relevé depuis plus de ${UNRECONCILED_AGING_DAYS} jours.`, sumByCurrency(cols.map((c) => c.amount)), []);
        const cd = this.cashDays.get(`${p.id}:${day}`);
        if (cd) this.cashDays.update({ ...cd, status: cd.status === 'OUVERTE' ? cd.status : 'ECART', exceptionIds: [...cd.exceptionIds, ex.id] });
      }
    }
  }

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Balayage périodique des retards de versement et du vieillissement (sans dépendre d'une consultation). */
  startScheduler(intervalMs: number): void {
    this.stopScheduler();
    this.timer = setInterval(() => { try { this.scanOverdue(); } catch { /* exceptions journalisées par l'audit */ } }, intervalMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

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
      // Une référence liée à un prestataire connecté (BitriPay, KODA) ne se paie que chez lui : jamais réutilisée
      // pour le point agréé, l'USSD ou la monnaie mobile générique. Le contribuable est clairement orienté.
      if (existing?.providerIntentId) {
        throw conflict(
          'PROVIDER_LINKED_REFERENCE_ACTIVE',
          `Une référence ${existing.paymentReference} liée au prestataire ${existing.provider ?? ''} est en cours jusqu'au ${existing.expiresAt.slice(0, 10)} : payez-la chez ce prestataire, ou attendez son expiration pour obtenir une nouvelle référence.`,
          { paymentReference: existing.paymentReference, provider: existing.provider ?? null, expiresAt: existing.expiresAt },
        );
      }
      if (existing) return existing;
    }
    throw e;
  }
}
