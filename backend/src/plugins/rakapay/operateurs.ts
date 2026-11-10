/**
 * RakaPay multi-opérateurs (§ 11D.1, 11D.2, 11D.6, 11D.7 ; AC-TKT-01 ; ARB-08).
 *
 *  - Agrément des opérateurs : candidature de l'exploitant → proposition motivée (R07) → décision d'une AUTRE personne
 *    (R06/R07) ; suspension et réactivation restent des décisions motivées.
 *  - Offres proposées par l'opérateur (nom commercial, durée du § 11D.1, localisation obligatoire) : une offre portant une
 *    recette publique tire son prix d'un type de titre dont la règle est ACTIVE au registre (jamais d'un prix saisi) ;
 *    elle n'est approuvée que si la règle l'est. Une offre privée porte le prix commercial de l'opérateur privé.
 *  - Agents rattachés à UN SEUL opérateur (exclusivité, aucune visibilité croisée) ; un agent public ne peut pas l'être.
 *  - Ventes des opérateurs privés : CIRCUIT COMPTABLE SÉPARÉ (journal « ventes privées »), réglées directement à
 *    l'opérateur, JAMAIS par le compte public, le coffre ni le grand livre public (AC-TKT-01) ; aucune vente en espèces.
 *  - Redevance d'usage de la plateforme par les opérateurs privés (ARB-08) : recette de la Province fixée par acte —
 *    paramètre ACTE_REQUIS sans valeur ; simulation seulement, sur un taux HYPOTHÉTIQUE saisi par l'utilisateur.
 *  - Revue des ventes atypiques : signal explicable, examiné par une personne, jamais une sanction.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { divideDecimalStrings } from '../../core/decimal.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { isCommune } from '../../reference/kinshasa.js';
import { sumByCurrency } from '../parking/support.js';
import type { RakaPayService, Operator } from './service.js';

const ENTITY = 'DGTK';
const MODULE_TICKETS = '76';

definePolicy('rakapay:operator.apply', { R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('rakapay:operator.admin', { R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('rakapay:operator.propose', { R07: GRANTS.sameEntity });
definePolicy('rakapay:operator.decide', { R06: GRANTS.sameEntity, R07: GRANTS.sameEntity });
definePolicy('rakapay:offer.decide', { R06: GRANTS.sameEntity, R07: GRANTS.sameEntity });
definePolicy('rakapay:operator.supervise', {
  R01: GRANTS.always, R02: GRANTS.always, R05: GRANTS.always, R06: GRANTS.sameEntity, R07: GRANTS.sameEntity, R22: GRANTS.always, R23: GRANTS.always, R24: GRANTS.always,
});
definePolicy('rakapay:sales.review', { R07: GRANTS.sameEntity, R24: GRANTS.always });

/** Durées configurables du § 11D.1 (Cahier). */
export const OFFER_DURATIONS = {
  ACCES: { JOUR: [1, 7, 15, 30] },
  STATIONNEMENT: { HEURE: [1, 3, 6, 9, 12, 15, 18, 24], JOUR: [7, 15, 30] },
} as const;

/**
 * ARB-08 : toute redevance d'usage de la plateforme par les opérateurs privés est une recette de la Province fixée par
 * acte et publiée ; le prestataire technique ne perçoit rien sur les flux. Aucune valeur tant que l'acte n'existe pas.
 */
export const PLATFORM_FEE_ARB08 = {
  code: 'RAKAPAY.REDEVANCE_USAGE_OPERATEURS_PRIVES', label: 'Redevance d’usage de la plateforme par les opérateurs privés',
  status: 'ACTE_REQUIS' as const, value: null, beneficiary: 'Province (recette publique fixée par acte, ARB-08)',
  note: 'Paramètre acte requis : simulation seulement, sur un taux hypothétique saisi ; aucune perception.',
};

/** Revue des ventes atypiques — valeurs PAR DÉFAUT, à confirmer par le maître d'ouvrage (registre des seuils). */
export const ATYPICAL_SALES_FACTOR = 3;
export const ATYPICAL_SALES_MIN = 10;
export const ATYPICAL_CANCELLATIONS_MIN = 3;

export const PRIVATE_CHANNELS = ['MOBILE_MONEY', 'CARTE', 'QR', 'APPLICATION', 'USSD'] as const;
export type PrivateChannel = (typeof PRIVATE_CHANNELS)[number];

export interface OperatorApproval {
  id: string;
  operatorId: string;
  proposal?: { by: string; at: string; outcome: 'ACCREDITER' | 'REFUSER'; motif: string };
  decision?: { by: string; at: string; approve: boolean; motif: string };
}

export interface Offer {
  id: string;
  operatorId: string;
  family: 'ACCES' | 'STATIONNEMENT';
  commercialName: string;
  duration: { unit: 'HEURE' | 'JOUR'; value: number };
  place: { commune: string; label: string; lat: number; lon: number };
  publicRevenue: boolean;
  typeCode?: string;
  price?: MoneyJSON;
  status: 'PROPOSEE' | 'APPROUVEE' | 'REFUSEE' | 'RETIREE';
  productId?: string;
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
}

export interface OperatorAgent {
  id: string;
  userId: string;
  operatorId: string;
  status: 'ACTIF' | 'RETIRE';
  attachedBy: string;
  attachedAt: string;
  detachedAt?: string;
}

/** Vente d'un opérateur privé : journal du CIRCUIT PRIVÉ, jamais le compte public. */
export interface PrivateSale {
  id: string;
  code: string;
  offerId: string;
  operatorId: string;
  agentId: string;
  channel: PrivateChannel;
  amount: MoneyJSON;
  commune: string;
  soldAt: string;
  validUntil: string;
  circuit: 'PRIVE';
  settlement: 'REGLEMENT_DIRECT_OPERATEUR';
}
export interface PrivateSaleCancellation { id: string; saleId: string; operatorId: string; by: string; at: string; motif: string }
export interface ProductSale { id: string; issuanceId: string; productId: string; operatorId: string; at: string }

export interface SalesReview {
  id: string;
  operatorId: string;
  agentId: string;
  day: string;
  signal: 'VOLUME_ATYPIQUE' | 'ANNULATIONS_REPETEES';
  explanation: string;
  variables: { name: string; value: string }[];
  status: 'A_EXAMINER' | 'CLASSEE' | 'TRANSMISE_INTEGRITE';
  decision?: { by: string; at: string; outcome: 'CLASSER' | 'TRANSMETTRE_INTEGRITE'; motif: string };
  raisedAt: string;
}

const PUBLIC_ROLE = /^R(0[1-9]|1\d|2\d)$/;

export class OperateursRakaPay {
  readonly approvals = new InMemoryRepository<OperatorApproval>();
  readonly offers = new InMemoryRepository<Offer>();
  readonly agents = new InMemoryRepository<OperatorAgent>();
  /** Journal séparé des ventes privées (AC-TKT-01) et de leurs annulations (ajout seul). */
  readonly privateSales = new InMemoryAppendOnlyRepository<PrivateSale>();
  readonly privateCancellations = new InMemoryAppendOnlyRepository<PrivateSaleCancellation>();
  /** Ventes publiques par produit (rattachement opérateur des commandes du moteur de titres). */
  readonly productSales = new InMemoryAppendOnlyRepository<ProductSale>();
  readonly reviews = new InMemoryRepository<SalesReview>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly rk: RakaPayService) {}

  private now() { return this.ctx.clock.now(); }

  private isAdmin(user: User, op: Operator): boolean {
    return !!op.taxpayerId && !!evaluate(user, 'rakapay:operator.admin', { taxpayerId: op.taxpayerId });
  }

  agentOf(userId: string): OperatorAgent | undefined {
    return this.agents.findOne((a) => a.userId === userId && a.status === 'ACTIF');
  }

  // ------------------------------------------------------------------ agrément des opérateurs (quatre yeux)

  apply(user: User, input: { name: string; kind: 'PUBLIC' | 'PRIVE'; commune: string; taxpayerId?: string }): Operator {
    const taxpayerId = input.taxpayerId ?? user.taxpayerId;
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Compte unique de l’exploitant requis.');
    this.ctx.taxpayers.get(taxpayerId);
    authorize(user, 'rakapay:operator.apply', { taxpayerId });
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    const open = this.rk.operators.findOne((o) => o.taxpayerId === taxpayerId && ['CANDIDAT', 'ACCREDITE', 'INVITE'].includes(o.status));
    if (open) throw conflict('OPERATOR_ALREADY_REGISTERED', `Exploitant déjà enregistré (${open.code}, ${open.status}).`);
    const seq = this.ids.next('OPR', 4);
    const at = this.now().toISOString();
    const op = this.rk.operators.insert({
      id: seq, code: seq, name: input.name.trim(), kind: input.kind, entity: ENTITY, commune: input.commune, status: 'CANDIDAT', taxpayerId, stationIds: [],
      decisions: [{ decision: 'CANDIDATURE', motif: 'Candidature déposée par l’exploitant', by: user.id, at }], demo: false, createdAt: at,
    });
    this.approvals.insert({ id: op.id, operatorId: op.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.operator.applied', resourceType: 'rakapay_operator', resourceId: op.id, details: { kind: op.kind, commune: op.commune } });
    return op;
  }

  proposeApproval(user: User, operatorId: string, input: { outcome: 'ACCREDITER' | 'REFUSER'; motif: string }) {
    const op = this.rk.operator(operatorId);
    authorize(user, 'rakapay:operator.propose', { entity: op.entity });
    if (op.status !== 'CANDIDAT') throw conflict('INVALID_OPERATOR_STATE', `Proposition impossible au statut ${op.status}.`);
    const a = this.approvals.get(op.id) ?? this.approvals.insert({ id: op.id, operatorId: op.id });
    if (a.proposal && !a.decision) throw conflict('PROPOSAL_PENDING', 'Une proposition attend déjà sa décision.');
    const saved = this.approvals.update({ ...a, proposal: { by: user.id, at: this.now().toISOString(), outcome: input.outcome, motif: input.motif }, decision: undefined });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.operator.approval_proposed', resourceType: 'rakapay_operator', resourceId: op.id, details: { outcome: input.outcome, motif: input.motif } });
    return saved;
  }

  decideApproval(user: User, operatorId: string, input: { approve: boolean; motif: string }): Operator {
    const op = this.rk.operator(operatorId);
    authorize(user, 'rakapay:operator.decide', { entity: op.entity });
    const a = this.approvals.get(op.id);
    if (!a?.proposal || a.decision || op.status !== 'CANDIDAT') throw conflict('NO_PENDING_PROPOSAL', 'Aucune proposition d’agrément en attente.');
    try {
      assertDistinctPerson(user.id, [a.proposal.by], 'La personne qui décide de l’agrément doit être distincte de celle qui l’a proposé.');
    } catch (e) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.operator.decision.refused', resourceType: 'rakapay_operator', resourceId: op.id, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    const accredit = input.approve && a.proposal.outcome === 'ACCREDITER';
    const at = this.now().toISOString();
    this.approvals.update({ ...a, decision: { by: user.id, at, approve: input.approve, motif: input.motif } });
    const updated = this.rk.operators.update({
      ...op, status: accredit ? 'ACCREDITE' : 'REFUSE', decisions: [...op.decisions, { decision: accredit ? 'ACCREDITER' : 'REFUSER', motif: input.motif, by: user.id, at }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: accredit ? 'rakapay.operator.approved' : 'rakapay.operator.refused', resourceType: 'rakapay_operator', resourceId: op.id, details: { motif: input.motif, proposal: a.proposal.outcome } });
    return updated;
  }

  // ------------------------------------------------------------------ offres proposées par l'opérateur

  private checkDuration(family: Offer['family'], d: Offer['duration']) {
    const allowed = (OFFER_DURATIONS[family] as Record<string, readonly number[]>)[d.unit];
    if (!allowed?.includes(d.value)) throw badRequest('DURATION_NOT_ALLOWED', `Durée non prévue au § 11D.1 pour ${family} : ${d.value} ${d.unit.toLowerCase()}(s).`);
  }

  proposeOffer(user: User, operatorId: string, input: { family: Offer['family']; commercialName: string; duration: Offer['duration']; place: Offer['place']; typeCode?: string; price?: MoneyJSON }): Offer {
    const op = this.rk.operator(operatorId);
    if (!this.isAdmin(user, op)) throw forbidden('NOT_OPERATOR_ADMIN', 'Seul l’exploitant crée les offres de son périmètre.');
    if (op.status !== 'ACCREDITE') throw unprocessable('OPERATOR_NOT_ACCREDITED', 'Opérateur non accrédité.');
    this.checkDuration(input.family, input.duration);
    if (!isCommune(input.place.commune)) throw badRequest('LOCATION_REQUIRED', 'Localisation cartographique obligatoire (commune de Kinshasa).');
    const publicRevenue = op.kind !== 'PRIVE';
    if (publicRevenue) {
      if (input.price) throw badRequest('PRICE_FROM_RULE', 'Recette publique : le prix vient de la règle approuvée du registre, jamais d’une saisie.');
      if (!input.typeCode) throw badRequest('TYPE_REQUIRED', 'Recette publique : choisir le type de titre dont la règle fixe le tarif.');
      const t = this.rk.titres.type(input.typeCode);
      if (t.module !== MODULE_TICKETS) throw unprocessable('TYPE_NOT_TICKET', 'Le type choisi n’est pas un ticket de la billetterie urbaine.');
    } else {
      if (input.typeCode) throw badRequest('PRIVATE_NO_PUBLIC_TYPE', 'Opérateur privé : ses tickets ne sont pas des recettes publiques.');
      if (!input.price || !(Number(input.price.amount) > 0)) throw badRequest('PRICE_REQUIRED', 'Prix commercial de l’opérateur privé requis.');
    }
    const offer = this.offers.insert({
      id: this.ids.next('OFR'), operatorId: op.id, family: input.family, commercialName: input.commercialName.trim(), duration: input.duration, place: input.place,
      publicRevenue, ...(input.typeCode ? { typeCode: input.typeCode } : {}), ...(input.price ? { price: input.price } : {}), status: 'PROPOSEE',
      proposedBy: user.id, proposedAt: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.offer.proposed', resourceType: 'rakapay_offer', resourceId: offer.id, details: { operatorId: op.id, publicRevenue, typeCode: input.typeCode ?? null } });
    return offer;
  }

  decideOffer(user: User, id: string, input: { approve: boolean; motif: string }): Offer {
    const offer = this.offers.get(id);
    if (!offer) throw notFound('OFFER_NOT_FOUND', `Offre inconnue : ${id}`);
    const op = this.rk.operator(offer.operatorId);
    authorize(user, 'rakapay:offer.decide', { entity: op.entity });
    if (offer.status !== 'PROPOSEE') throw conflict('OFFER_NOT_PENDING', `Offre au statut ${offer.status}.`);
    assertDistinctPerson(user.id, [offer.proposedBy], 'La personne qui approuve l’offre doit être distincte de celle qui l’a proposée.');
    let productId: string | undefined;
    if (input.approve && offer.publicRevenue) {
      const t = this.rk.titres.type(offer.typeCode!);
      const act = this.rk.titres.activation(t);
      if (!act.ok) {
        this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.offer.approval_blocked', resourceType: 'rakapay_offer', resourceId: id, outcome: 'DENIED', details: { reason: act.reason } });
        throw unprocessable('RULE_NOT_ACTIVE', `Offre publique non approuvable : ${act.reason}`);
      }
      productId = `PRD-${offer.id}`;
      this.rk.products.insert({ id: productId, operatorId: op.id, commercialName: offer.commercialName, typeCode: t.code, serviceType: 'BUS', publicRevenue: true, status: 'ACTIF' });
    }
    const saved = this.offers.update({ ...offer, status: input.approve ? 'APPROUVEE' : 'REFUSEE', ...(productId ? { productId } : {}), decision: { by: user.id, at: this.now().toISOString(), approve: input.approve, motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'rakapay.offer.approved' : 'rakapay.offer.refused', resourceType: 'rakapay_offer', resourceId: id, details: { motif: input.motif, productId: productId ?? null } });
    return saved;
  }

  listOffers(user: User | undefined, operatorId?: string) {
    return this.offers.find((o) => !operatorId || o.operatorId === operatorId).filter((o) => {
      if (o.status === 'APPROUVEE') return true;
      if (!user) return false;
      const op = this.rk.operators.get(o.operatorId);
      return !!op && (this.isAdmin(user, op) || !!evaluate(user, 'rakapay:offer.decide', { entity: op.entity }));
    });
  }

  // ------------------------------------------------------------------ agents exclusifs d'un opérateur

  attachAgent(user: User, operatorId: string, agentUserId: string): OperatorAgent {
    const op = this.rk.operator(operatorId);
    if (!this.isAdmin(user, op) && !evaluate(user, 'rakapay:operator.propose', { entity: op.entity })) throw forbidden('NOT_OPERATOR_ADMIN', 'Seul l’exploitant (ou le responsable du module) rattache ses agents.');
    if (op.status !== 'ACCREDITE') throw unprocessable('OPERATOR_NOT_ACCREDITED', 'Opérateur non accrédité.');
    const agent = this.ctx.users.get(agentUserId);
    if (!agent) throw notFound('USER_NOT_FOUND', `Utilisateur inconnu : ${agentUserId}`);
    if (agent.roles.some((r) => PUBLIC_ROLE.test(r))) throw forbidden('PUBLIC_AGENT_NOT_ALLOWED', 'Un agent public ne peut pas être agent d’un opérateur.');
    const current = this.agentOf(agent.id);
    if (current && current.operatorId !== op.id) throw conflict('AGENT_EXCLUSIVE', 'Cet agent est déjà rattaché à un autre opérateur : un agent est exclusif à un seul opérateur.');
    if (current) return current;
    const existing = this.agents.get(agent.id);
    const rec: OperatorAgent = { id: agent.id, userId: agent.id, operatorId: op.id, status: 'ACTIF', attachedBy: user.id, attachedAt: this.now().toISOString() };
    const saved = existing ? this.agents.update(rec) : this.agents.insert(rec);
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.operator.agent_attached', resourceType: 'rakapay_operator', resourceId: op.id, details: { agentId: agent.id } });
    return saved;
  }

  detachAgent(user: User, operatorId: string, agentUserId: string): OperatorAgent {
    const op = this.rk.operator(operatorId);
    if (!this.isAdmin(user, op) && !evaluate(user, 'rakapay:operator.propose', { entity: op.entity })) throw forbidden('NOT_OPERATOR_ADMIN', 'Seul l’exploitant (ou le responsable du module) retire ses agents.');
    const a = this.agentOf(agentUserId);
    if (!a || a.operatorId !== op.id) throw notFound('AGENT_NOT_ATTACHED', 'Agent non rattaché à cet opérateur.');
    const saved = this.agents.update({ ...a, status: 'RETIRE', detachedAt: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.operator.agent_detached', resourceType: 'rakapay_operator', resourceId: op.id, details: { agentId: agentUserId } });
    return saved;
  }

  // ------------------------------------------------------------------ circuit privé (AC-TKT-01)

  recordPrivateSale(user: User, input: { offerId: string; channel: string }): PrivateSale & { commission?: { pct: string; amount: MoneyJSON } | null } {
    const offer = this.offers.get(input.offerId);
    if (!offer || offer.status !== 'APPROUVEE') throw notFound('OFFER_NOT_FOUND', 'Offre inconnue ou non approuvée.');
    if (offer.publicRevenue) throw unprocessable('PUBLIC_REVENUE_OFFER', 'Recette publique : la vente passe par le circuit commun (référence de paiement → compte public).');
    const op = this.rk.operator(offer.operatorId);
    if (op.status !== 'ACCREDITE') throw unprocessable('OPERATOR_NOT_ACCREDITED', 'Opérateur suspendu ou non accrédité : vente impossible.');
    const mine = this.agentOf(user.id);
    if (!this.isAdmin(user, op) && mine?.operatorId !== op.id) throw forbidden('NOT_OPERATOR_AGENT', 'Vente réservée aux agents de cet opérateur.');
    if (!(PRIVATE_CHANNELS as readonly string[]).includes(input.channel)) throw unprocessable('CASH_NOT_ALLOWED', 'Aucune vente en espèces par un agent (§ 11D.4) : paiement numérique uniquement.');
    // Module 76 : blocage préventif décidé par la supervision (décision motivée).
    this.rk.billetterie.assertNotBlocked(op.id, user.id);
    const at = this.now();
    const ms = offer.duration.unit === 'HEURE' ? offer.duration.value * 3_600_000 : offer.duration.value * 86_400_000;
    const id = this.ids.next('VPR');
    const sale = this.privateSales.append({
      id, code: `PRV-${id.slice(4)}`, offerId: offer.id, operatorId: op.id, agentId: user.id, channel: input.channel as PrivateChannel, amount: offer.price!, commune: offer.place.commune,
      soldAt: at.toISOString(), validUntil: new Date(at.getTime() + ms).toISOString(), circuit: 'PRIVE', settlement: 'REGLEMENT_DIRECT_OPERATEUR',
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.private_sale.recorded', resourceType: 'rakapay_private_sale', resourceId: sale.id, details: { operatorId: op.id, offerId: offer.id, amount: sale.amount, circuit: 'PRIVE' } });
    // Module 76 : commission de l'agent calculée instantanément selon la grille contractuelle de l'opérateur.
    const c = this.rk.billetterie.onSale(sale);
    return { ...sale, commission: c ? { pct: c.pct, amount: c.amount } : null };
  }

  cancelPrivateSale(user: User, saleId: string, motif: string): PrivateSaleCancellation {
    const sale = this.privateSales.get(saleId);
    if (!sale) throw notFound('SALE_NOT_FOUND', `Vente inconnue : ${saleId}`);
    const op = this.rk.operator(sale.operatorId);
    if (!this.isAdmin(user, op) && this.agentOf(user.id)?.operatorId !== op.id) throw forbidden('NOT_OPERATOR_AGENT', 'Annulation réservée à l’opérateur de la vente.');
    if (this.privateCancellations.findOne((c) => c.saleId === saleId)) throw conflict('SALE_ALREADY_CANCELLED', 'Vente déjà annulée.');
    const c = this.privateCancellations.append({ id: this.ids.next('ANP'), saleId, operatorId: op.id, by: user.id, at: this.now().toISOString(), motif });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.private_sale.cancelled', resourceType: 'rakapay_private_sale', resourceId: saleId, details: { motif } });
    return c;
  }

  private liveSales(operatorId?: string) {
    const cancelled = new Set(this.privateCancellations.all().map((c) => c.saleId));
    return this.privateSales.find((s) => (!operatorId || s.operatorId === operatorId) && !cancelled.has(s.id));
  }

  // ------------------------------------------------------------------ tableaux (opérateur, supervision)

  private publicSalesOf(operatorId: string) {
    const out: { commune: string | null; amount: MoneyJSON; at: string }[] = [];
    for (const ps of this.productSales.find((s) => s.operatorId === operatorId)) {
      const iss = this.rk.titres.issuances.get(ps.issuanceId);
      for (const p of iss?.payments ?? []) if (p.status === 'PAYE') out.push({ commune: p.commune, amount: p.amount, at: ps.at });
    }
    return out;
  }

  dashboard(user: User, operatorId: string) {
    const op = this.rk.operator(operatorId);
    const admin = this.isAdmin(user, op);
    const agent = this.agentOf(user.id);
    const supervisor = !!evaluate(user, 'rakapay:operator.supervise', { entity: op.entity });
    if (!admin && !supervisor && agent?.operatorId !== op.id) throw forbidden('NO_CROSS_VISIBILITY', 'Tableau réservé à l’opérateur, à ses agents et à la supervision : aucune visibilité croisée.');
    // Un agent ne voit que ses propres ventes.
    const sales = this.liveSales(op.id).filter((s) => admin || supervisor || s.agentId === user.id);
    const hour = (iso: string) => String(new Date(new Date(iso).getTime() + 3_600_000).getUTCHours()).padStart(2, '0');
    const group = <K extends string>(key: (s: PrivateSale) => K) => {
      const m = new Map<K, PrivateSale[]>();
      for (const s of sales) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
      return [...m.entries()].map(([k, list]) => ({ key: k, count: list.length, amounts: sumByCurrency(list.map((x) => x.amount)) })).sort((a, b) => a.key.localeCompare(b.key));
    };
    const pub = op.kind === 'PRIVE' ? [] : this.publicSalesOf(op.id);
    return {
      operator: { id: op.id, code: op.code, name: op.name, kind: op.kind, status: op.status, commune: op.commune },
      viewer: admin ? 'EXPLOITANT' : supervisor ? 'SUPERVISION' : 'AGENT',
      offers: this.offers.find((o) => o.operatorId === op.id).map((o) => ({ id: o.id, commercialName: o.commercialName, status: o.status, family: o.family, duration: o.duration, publicRevenue: o.publicRevenue, price: o.price ?? null, typeCode: o.typeCode ?? null, place: o.place })),
      agents: admin || supervisor ? this.agents.find((a) => a.operatorId === op.id).map((a) => ({ userId: a.userId, name: this.ctx.users.get(a.userId)?.name ?? a.userId, status: a.status })) : [],
      privateCircuit: op.kind === 'PRIVE' ? {
        circuit: 'PRIVE', settlement: 'Réglé directement à l’opérateur privé — hors compte public (AC-TKT-01)',
        sales: sales.length, amounts: sumByCurrency(sales.map((s) => s.amount)), byZone: group((s) => s.commune), byHour: group((s) => hour(s.soldAt)),
        byAgent: admin || supervisor ? group((s) => s.agentId) : [], cancellations: this.privateCancellations.find((c) => c.operatorId === op.id).length,
      } : null,
      publicCircuit: op.kind === 'PRIVE' ? null : {
        circuit: 'PUBLIC', settlement: 'Paiement direct au compte public (circuit commun, quittance)', paidReferences: pub.length, amounts: sumByCurrency(pub.map((p) => p.amount)),
        controls: this.rk.titres.controls.find((c) => c.module === MODULE_TICKETS).length,
      },
      reviews: admin || supervisor ? this.reviews.find((r) => r.operatorId === op.id) : [],
      generatedAt: this.now().toISOString(),
    };
  }

  /** Les deux circuits, côte à côte et JAMAIS additionnés (§ 11D.7, AC-TKT-01). */
  circuits(user: User) {
    authorize(user, 'rakapay:operator.supervise', { entity: ENTITY });
    const pub: MoneyJSON[] = [];
    for (const c of this.rk.titres.credentials.find((x) => (x.module === '76' || x.module === '81') && !x.replacesId)) {
      const order = c.paymentOrderId ? this.ctx.payments.orders.get(c.paymentOrderId) : undefined;
      if (order && ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(order.status) && c.amount) pub.push(c.amount);
    }
    const priv = this.liveSales();
    return {
      public: { label: 'Recettes publiques — compte public (clé du § 37A)', amounts: sumByCurrency(pub), credentials: pub.length },
      private: {
        label: 'Ventes des opérateurs privés — réglées à l’opérateur, hors compte public', amounts: sumByCurrency(priv.map((s) => s.amount)), sales: priv.length,
        byOperator: [...new Set(priv.map((s) => s.operatorId))].map((id) => ({ operatorId: id, name: this.rk.operators.get(id)?.name ?? id, amounts: sumByCurrency(priv.filter((s) => s.operatorId === id).map((s) => s.amount)) })),
      },
      separated: true, notice: 'Deux circuits comptables séparés : aucun total ne les additionne ; aucune vente privée ne passe par le compte public, le coffre ni le grand livre public.',
      platformFee: PLATFORM_FEE_ARB08,
    };
  }

  /** ARB-08 : simulation seulement, sur un taux HYPOTHÉTIQUE saisi (jamais une valeur par défaut). */
  simulatePlatformFee(user: User, hypotheticalPct: string) {
    authorize(user, 'rakapay:operator.supervise', { entity: ENTITY });
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(hypotheticalPct)) throw badRequest('HYPOTHESIS_REQUIRED', 'Taux hypothétique en pourcentage requis (ex. « 2.5 ») : aucune valeur par défaut.');
    const rate = divideDecimalStrings(hypotheticalPct, '100', 8);
    const base = sumByCurrency(this.liveSales().map((s) => s.amount));
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.platform_fee.simulated', resourceType: 'rakapay_parameter', resourceId: PLATFORM_FEE_ARB08.code, details: { hypotheticalPct } });
    return {
      parameter: PLATFORM_FEE_ARB08, simulation: true, activable: false, hypotheticalPct,
      base, simulated: base.map((m) => Money.fromJSON(m).multiply(rate).toJSON()),
      notice: 'Simulation non opposable sur un taux hypothétique : aucune perception tant que l’acte (ARB-08) n’a pas fixé et publié la redevance, recette de la Province.',
    };
  }

  // ------------------------------------------------------------------ revue des ventes atypiques (signal, jamais sanction)

  detectUnusualSales(user: User) {
    authorize(user, 'rakapay:sales.review', { entity: ENTITY });
    const raised: SalesReview[] = [];
    const sales = this.liveSales();
    const byOpDay = new Map<string, PrivateSale[]>();
    for (const s of sales) {
      const k = `${s.operatorId}|${kinshasaDate(new Date(s.soldAt))}`;
      byOpDay.set(k, [...(byOpDay.get(k) ?? []), s]);
    }
    const raise = (r: Omit<SalesReview, 'id' | 'status' | 'raisedAt'>) => {
      const id = `REV-${r.operatorId}-${r.agentId}-${r.day}-${r.signal}`;
      if (this.reviews.get(id)) return;
      raised.push(this.reviews.insert({ ...r, id, status: 'A_EXAMINER', raisedAt: this.now().toISOString() }));
    };
    for (const [k, list] of byOpDay) {
      const [operatorId, day] = k.split('|') as [string, string];
      const perAgent = new Map<string, number>();
      for (const s of list) perAgent.set(s.agentId, (perAgent.get(s.agentId) ?? 0) + 1);
      if (perAgent.size < 2) continue;
      for (const [agentId, n] of perAgent) {
        // Médiane des AUTRES agents de l'opérateur le même jour (l'agent examiné n'influence pas sa référence).
        const counts = [...perAgent.entries()].filter(([a]) => a !== agentId).map(([, c]) => c).sort((a, b) => a - b);
        const median = counts.length % 2 ? counts[(counts.length - 1) / 2]! : (counts[counts.length / 2 - 1]! + counts[counts.length / 2]!) / 2;
        if (n >= ATYPICAL_SALES_MIN && n > ATYPICAL_SALES_FACTOR * median) {
          raise({ operatorId, agentId, day, signal: 'VOLUME_ATYPIQUE', explanation: `L’agent a enregistré ${n} ventes le ${day}, plus de ${ATYPICAL_SALES_FACTOR} fois la médiane des autres agents de l’opérateur (${median}). À examiner ; ne vaut pas preuve d’abus.`, variables: [{ name: 'Ventes', value: String(n) }, { name: 'Médiane', value: String(median) }] });
        }
      }
    }
    const cancelsByAgentDay = new Map<string, number>();
    for (const c of this.privateCancellations.all()) {
      const sale = this.privateSales.get(c.saleId);
      if (!sale) continue;
      const k = `${sale.operatorId}|${sale.agentId}|${kinshasaDate(new Date(c.at))}`;
      cancelsByAgentDay.set(k, (cancelsByAgentDay.get(k) ?? 0) + 1);
    }
    for (const [k, n] of cancelsByAgentDay) {
      const [operatorId, agentId, day] = k.split('|') as [string, string, string];
      if (n >= ATYPICAL_CANCELLATIONS_MIN) raise({ operatorId, agentId, day, signal: 'ANNULATIONS_REPETEES', explanation: `${n} ventes de l’agent annulées le ${day}. À examiner ; ne vaut pas preuve d’abus.`, variables: [{ name: 'Annulations', value: String(n) }] });
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.sales_review.detection_run', resourceType: 'rakapay_sales_review', resourceId: 'detection', details: { raised: raised.length } });
    return { raised, open: this.reviews.find((r) => r.status === 'A_EXAMINER'), parameters: { factor: ATYPICAL_SALES_FACTOR, minSales: ATYPICAL_SALES_MIN, minCancellations: ATYPICAL_CANCELLATIONS_MIN, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' } };
  }

  listReviews(user: User) {
    authorize(user, 'rakapay:sales.review', { entity: ENTITY });
    return this.reviews.all().sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }

  decideReview(user: User, id: string, input: { outcome: 'CLASSER' | 'TRANSMETTRE_INTEGRITE'; motif: string }): SalesReview {
    authorize(user, 'rakapay:sales.review', { entity: ENTITY });
    const r = this.reviews.get(id);
    if (!r) throw notFound('REVIEW_NOT_FOUND', `Revue inconnue : ${id}`);
    if (r.status !== 'A_EXAMINER') throw conflict('REVIEW_CLOSED', 'Revue déjà examinée.');
    if (user.id === r.agentId) throw forbidden('SEPARATION_OF_DUTIES', 'Une personne ne peut pas examiner ses propres ventes.');
    const saved = this.reviews.update({ ...r, status: input.outcome === 'CLASSER' ? 'CLASSEE' : 'TRANSMISE_INTEGRITE', decision: { by: user.id, at: this.now().toISOString(), ...input } });
    this.ctx.audit.append({ actor: actorOf(user), action: input.outcome === 'CLASSER' ? 'rakapay.sales_review.closed' : 'rakapay.sales_review.transmitted', resourceType: 'rakapay_sales_review', resourceId: id, details: { motif: input.motif, agentId: r.agentId } });
    return saved;
  }
}
