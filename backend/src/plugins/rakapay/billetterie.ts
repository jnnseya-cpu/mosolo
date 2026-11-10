/**
 * Billetterie multi-opérateurs RakaPay (module 76) et pass wewa (module 81) — compléments de la spécification
 * fonctionnelle et décisions du maître d'ouvrage du 27/09/2026, construits PAR-DESSUS `operateurs.ts` et `service.ts` :
 *
 *  - LIMITES APPROUVÉES (supervision R06/R07, motivées) : fourchette de prix de chaque offre PRIVÉE et taux maximal de
 *    commission des agents de l'opérateur. Une offre portant une recette publique garde le prix de sa règle ACTIVE :
 *    jamais ajustable ici.
 *  - AJUSTEMENT PAR L'OPÉRATEUR, SANS nouvelle approbation, DANS les limites approuvées : prix d'une offre privée et
 *    grille de commission de ses agents (contrat opérateur-agent) ; hors limites : refus motivé (nouvelle approbation).
 *  - COMMISSION INSTANTANÉE de l'agent selon la grille contractuelle de SON opérateur, calculée à chaque vente (journal
 *    en ajout seul, restituée dans la réponse de la vente) ; due par l'opérateur à son agent, jamais par le compte public.
 *  - ANALYSE QUOTIDIENNE pour l'opérateur (ventes, montants, commissions, annulations, par heure, agent, offre ;
 *    comparaison avec la moyenne des sept jours précédents) ; l'agent ne voit que ses propres ventes.
 *  - AUDIT DU COMPORTEMENT des agents et BLOCAGE PRÉVENTIF par décision motivée de la supervision (R07, enquêteur R24),
 *    distincte de l'agent ; levée par une décision motivée d'une AUTRE personne ; l'agent bloqué ne vend plus.
 *  - PÉRIODE DE GRÂCE paramétrable (module 81, et 76) avant pénalités : proposée par le responsable (R07), approuvée
 *    par une personne distincte (R06, R05) ; appliquée par le moteur de titres (constats « pédagogiques », aucune
 *    pénalité liquidable pendant la grâce).
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { dec, decMul, decDiv, decToString } from '../../core/decimal.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { sumByCurrency } from '../parking/support.js';
import type { Offer, PrivateSale } from './operateurs.js';
import { MODULE_BILLETTERIE, MODULE_WEWA, type RakaPayService } from './service.js';

const ENTITY = 'DGTK';
definePolicy('rakapay:limits.approve', { R06: GRANTS.sameEntity, R07: GRANTS.sameEntity });
definePolicy('rakapay:agent.block', { R07: GRANTS.sameEntity, R24: GRANTS.always, R06: GRANTS.sameEntity });
definePolicy('rakapay:grace.propose', { R07: GRANTS.sameEntity });
definePolicy('rakapay:grace.approve', { R06: GRANTS.sameEntity, R05: GRANTS.always });

const PCT = /^\d{1,2}(\.\d{1,2})?$/;

export interface OperatorLimits {
  /** = operatorId */
  id: string;
  operatorId: string;
  /** Fourchettes de prix par offre privée (bornes approuvées). */
  priceBands: { offerId: string; min: MoneyJSON; max: MoneyJSON }[];
  /** Taux maximal de commission des agents (pour cent). */
  commissionMaxPct: string;
  motif: string;
  approvedBy: string;
  approvedAt: string;
  history: { at: string; by: string; motif: string; commissionMaxPct: string; priceBands: OperatorLimits['priceBands'] }[];
}

export interface CommissionGrid {
  /** = operatorId */
  id: string;
  operatorId: string;
  /** Taux par offre ; `*` = taux par défaut de l'opérateur. */
  rates: { offerId: string; pct: string }[];
  updatedBy: string;
  updatedAt: string;
  history: { at: string; by: string; rates: CommissionGrid['rates'] }[];
}

export interface AgentCommission {
  id: string;
  saleId: string;
  operatorId: string;
  agentId: string;
  offerId: string;
  base: MoneyJSON;
  pct: string;
  amount: MoneyJSON;
  gridVersionAt: string;
  at: string;
  payer: 'OPERATEUR';
}

export interface AgentBlock {
  id: string;
  operatorId: string;
  agentId: string;
  status: 'BLOQUE' | 'LEVE';
  motif: string;
  reviewId: string | null;
  decidedBy: string;
  decidedAt: string;
  lifted?: { by: string; at: string; motif: string };
}

export interface GraceProposal {
  id: string;
  module: string;
  until: string;
  motif: string;
  status: 'PROPOSEE' | 'APPROUVEE' | 'REJETEE';
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
}

export class BilletterieRakaPay {
  readonly limits = new InMemoryRepository<OperatorLimits>();
  readonly grids = new InMemoryRepository<CommissionGrid>();
  readonly commissions = new InMemoryAppendOnlyRepository<AgentCommission>();
  readonly blocks = new InMemoryRepository<AgentBlock>();
  readonly graceProposals = new InMemoryRepository<GraceProposal>();
  readonly priceHistory = new InMemoryAppendOnlyRepository<{ id: string; offerId: string; operatorId: string; from: MoneyJSON | null; to: MoneyJSON; by: string; at: string }>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly rk: RakaPayService) {}

  private now() { return this.ctx.clock.now(); }
  /** Jour de Kinshasa selon l'heure du serveur. */
  today(): string { return kinshasaDate(this.now()); }
  private isAdmin(user: User, operatorId: string) {
    const op = this.rk.operator(operatorId);
    return !!op.taxpayerId && !!evaluate(user, 'rakapay:operator.admin', { taxpayerId: op.taxpayerId });
  }
  private offer(id: string): Offer {
    const o = this.rk.operateurs.offers.get(id);
    if (!o) throw notFound('OFFER_NOT_FOUND', `Offre inconnue : ${id}`);
    return o;
  }

  // ------------------------------------------------------------------------------------------ limites approuvées

  approveLimits(user: User, operatorId: string, input: { commissionMaxPct: string; priceBands: { offerId: string; min: MoneyJSON; max: MoneyJSON }[]; motif: string }): OperatorLimits {
    const op = this.rk.operator(operatorId);
    authorize(user, 'rakapay:limits.approve', { entity: op.entity });
    if (this.isAdmin(user, operatorId)) throw forbidden('SEPARATION_OF_DUTIES', 'L’opérateur ne fixe pas ses propres limites.');
    if (!PCT.test(input.commissionMaxPct) || Number(input.commissionMaxPct) > 100) throw badRequest('INVALID_PCT', 'Taux maximal de commission en pour cent (0 à 100).');
    for (const b of input.priceBands) {
      const o = this.offer(b.offerId);
      if (o.operatorId !== op.id) throw unprocessable('OFFER_NOT_OF_OPERATOR', `Offre ${o.id} d’un autre opérateur.`);
      if (o.publicRevenue) throw unprocessable('PRICE_FROM_RULE', 'Recette publique : le prix vient de la règle ACTIVE du registre, aucune fourchette ici.');
      if (b.min.currency !== b.max.currency || Money.fromJSON(b.min).compare(Money.fromJSON(b.max)) > 0) throw badRequest('INVALID_BAND', 'Fourchette invalide (minimum ≤ maximum, même devise).');
    }
    const at = this.now().toISOString();
    const prev = this.limits.get(op.id);
    const rec: OperatorLimits = {
      id: op.id, operatorId: op.id, priceBands: input.priceBands, commissionMaxPct: input.commissionMaxPct, motif: input.motif.trim(), approvedBy: user.id, approvedAt: at,
      history: [...(prev?.history ?? []), { at, by: user.id, motif: input.motif.trim(), commissionMaxPct: input.commissionMaxPct, priceBands: input.priceBands }],
    };
    const saved = prev ? this.limits.update(rec) : this.limits.insert(rec);
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.limits.approved', resourceType: 'rakapay_operator', resourceId: op.id, details: { commissionMaxPct: rec.commissionMaxPct, bands: rec.priceBands.length, motif: rec.motif } });
    return saved;
  }

  private limitsOf(operatorId: string): OperatorLimits {
    const l = this.limits.get(operatorId);
    if (!l) throw unprocessable('NO_APPROVED_LIMITS', 'Aucune limite approuvée pour cet opérateur : tout ajustement suppose des limites approuvées par la supervision.');
    return l;
  }

  /** Ajustement du prix d'une offre privée par l'opérateur, dans la fourchette approuvée (sans nouvelle approbation). */
  adjustPrice(user: User, offerId: string, price: MoneyJSON): Offer {
    const o = this.offer(offerId);
    if (!this.isAdmin(user, o.operatorId)) throw forbidden('NOT_OPERATOR_ADMIN', 'Seul l’exploitant ajuste le prix de ses offres.');
    if (o.publicRevenue) throw unprocessable('PRICE_FROM_RULE', 'Recette publique : prix fixé par la règle ACTIVE du registre, jamais ajusté par l’opérateur.');
    if (o.status !== 'APPROUVEE') throw conflict('OFFER_NOT_APPROVED', 'Seule une offre approuvée s’ajuste dans ses limites.');
    const band = this.limitsOf(o.operatorId).priceBands.find((b) => b.offerId === o.id);
    if (!band) throw unprocessable('NO_PRICE_BAND', 'Aucune fourchette de prix approuvée pour cette offre : nouvelle approbation requise.');
    const p = Money.fromJSON(price);
    if (price.currency !== band.min.currency || p.compare(Money.fromJSON(band.min)) < 0 || p.compare(Money.fromJSON(band.max)) > 0) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.offer.price_refused', resourceType: 'rakapay_offer', resourceId: o.id, outcome: 'DENIED', details: { price, band } });
      throw unprocessable('OUTSIDE_APPROVED_LIMITS', `Prix hors de la fourchette approuvée (${band.min.amount} à ${band.max.amount} ${band.min.currency}) : nouvelle approbation requise.`);
    }
    const saved = this.rk.operateurs.offers.update({ ...o, price: p.toJSON() });
    this.priceHistory.append({ id: this.ids.next('PRX'), offerId: o.id, operatorId: o.operatorId, from: o.price ?? null, to: p.toJSON(), by: user.id, at: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.offer.price_adjusted', resourceType: 'rakapay_offer', resourceId: o.id, details: { before: o.price ?? null, after: p.toJSON(), band } });
    return saved;
  }

  /** Grille de commission des agents (contrat de l'opérateur), plafonnée par le taux maximal approuvé. */
  setGrid(user: User, operatorId: string, rates: { offerId: string; pct: string }[]): CommissionGrid {
    const op = this.rk.operator(operatorId);
    if (!this.isAdmin(user, op.id)) throw forbidden('NOT_OPERATOR_ADMIN', 'Seul l’exploitant fixe la grille de commission de ses agents.');
    const max = this.limitsOf(op.id).commissionMaxPct;
    for (const r of rates) {
      if (!PCT.test(r.pct)) throw badRequest('INVALID_PCT', `Taux invalide : ${r.pct}`);
      if (r.offerId !== '*' && this.offer(r.offerId).operatorId !== op.id) throw unprocessable('OFFER_NOT_OF_OPERATOR', `Offre ${r.offerId} d’un autre opérateur.`);
      if (Number(r.pct) > Number(max)) {
        this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.commission_grid.refused', resourceType: 'rakapay_operator', resourceId: op.id, outcome: 'DENIED', details: { pct: r.pct, max } });
        throw unprocessable('OUTSIDE_APPROVED_LIMITS', `Taux ${r.pct} % supérieur au maximum approuvé (${max} %) : nouvelle approbation requise.`);
      }
    }
    const at = this.now().toISOString();
    const prev = this.grids.get(op.id);
    const rec: CommissionGrid = { id: op.id, operatorId: op.id, rates, updatedBy: user.id, updatedAt: at, history: [...(prev?.history ?? []), { at, by: user.id, rates }] };
    const saved = prev ? this.grids.update(rec) : this.grids.insert(rec);
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.commission_grid.updated', resourceType: 'rakapay_operator', resourceId: op.id, details: { rates, max } });
    return saved;
  }

  // ------------------------------------------------------------------------------------------ vente : blocage, commission

  /** Refus de vente d'un agent sous blocage préventif (appelé par le circuit de vente). */
  assertNotBlocked(operatorId: string, agentId: string): void {
    const b = this.blocks.find((x) => x.operatorId === operatorId && x.agentId === agentId && x.status === 'BLOQUE')[0];
    if (b) throw forbidden('AGENT_BLOCKED', `Agent bloqué à titre préventif le ${kinshasaDate(new Date(b.decidedAt))} (décision motivée) : aucune vente.`);
  }

  /** Commission instantanée de l'agent selon la grille de son opérateur (aucune grille : aucune commission). */
  onSale(sale: PrivateSale): AgentCommission | null {
    const grid = this.grids.get(sale.operatorId);
    const rate = grid?.rates.find((r) => r.offerId === sale.offerId) ?? grid?.rates.find((r) => r.offerId === '*');
    if (!grid || !rate) return null;
    const amount = decToString(decDiv(decMul(dec(sale.amount.amount), dec(rate.pct)), dec('100')));
    const c = this.commissions.append({
      id: this.ids.next('CMA'), saleId: sale.id, operatorId: sale.operatorId, agentId: sale.agentId, offerId: sale.offerId, base: sale.amount, pct: rate.pct,
      amount: Money.of(amount, sale.amount.currency, 'HALF_UP').toJSON(), gridVersionAt: grid.updatedAt, at: sale.soldAt, payer: 'OPERATEUR',
    });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'rakapay:commissions' }, action: 'rakapay.agent_commission.computed', resourceType: 'rakapay_private_sale', resourceId: sale.id, details: { agentId: sale.agentId, pct: rate.pct, amount: c.amount } });
    return c;
  }

  /** Blocage préventif d'un agent par décision motivée (supervision, jamais l'algorithme ; jamais l'agent lui-même). */
  block(user: User, operatorId: string, agentId: string, input: { motif: string; reviewId?: string }): AgentBlock {
    const op = this.rk.operator(operatorId);
    authorize(user, 'rakapay:agent.block', { entity: op.entity });
    if (user.id === agentId) throw forbidden('SEPARATION_OF_DUTIES', 'Une personne ne décide pas de son propre blocage.');
    const a = this.rk.operateurs.agentOf(agentId);
    if (!a || a.operatorId !== op.id) throw notFound('AGENT_NOT_ATTACHED', 'Agent non rattaché à cet opérateur.');
    if (input.motif.trim().length < 15) throw badRequest('MOTIF_REQUIRED', 'Décision motivée : 15 caractères au moins.');
    if (this.blocks.findOne((b) => b.operatorId === op.id && b.agentId === agentId && b.status === 'BLOQUE')) throw conflict('ALREADY_BLOCKED', 'Agent déjà bloqué.');
    if (input.reviewId && !this.rk.operateurs.reviews.get(input.reviewId)) throw notFound('REVIEW_NOT_FOUND', `Revue inconnue : ${input.reviewId}`);
    const b = this.blocks.insert({ id: this.ids.next('BLQ'), operatorId: op.id, agentId, status: 'BLOQUE', motif: input.motif.trim(), reviewId: input.reviewId ?? null, decidedBy: user.id, decidedAt: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.agent.blocked', resourceType: 'rakapay_operator', resourceId: op.id, details: { agentId, motif: b.motif, reviewId: b.reviewId } });
    const u = this.ctx.users.get(agentId);
    if (u) this.ctx.comms.publish('access.expiring', [userRecipient(u)], { reference: b.id }, { entity: op.entity });
    return b;
  }

  /** Levée motivée par une personne distincte de celle qui a bloqué. */
  lift(user: User, blockId: string, motif: string): AgentBlock {
    const b = this.blocks.get(blockId);
    if (!b || b.status !== 'BLOQUE') throw notFound('BLOCK_NOT_FOUND', 'Aucun blocage en cours.');
    authorize(user, 'rakapay:agent.block', { entity: this.rk.operator(b.operatorId).entity });
    assertDistinctPerson(user.id, [b.decidedBy, b.agentId], 'La levée est décidée par une personne distincte de celle qui a bloqué (et de l’agent).');
    if (motif.trim().length < 15) throw badRequest('MOTIF_REQUIRED', 'Décision motivée : 15 caractères au moins.');
    const saved = this.blocks.update({ ...b, status: 'LEVE', lifted: { by: user.id, at: this.now().toISOString(), motif: motif.trim() } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.agent.unblocked', resourceType: 'rakapay_operator', resourceId: b.operatorId, details: { agentId: b.agentId, motif: motif.trim() } });
    return saved;
  }

  // ------------------------------------------------------------------------------------------ analyse quotidienne

  dailyAnalysis(user: User, operatorId: string, date: string) {
    const op = this.rk.operator(operatorId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('INVALID_DATE', 'Jour AAAA-MM-JJ attendu.');
    const admin = this.isAdmin(user, op.id);
    const supervisor = !!evaluate(user, 'rakapay:operator.supervise', { entity: op.entity });
    const agent = this.rk.operateurs.agentOf(user.id);
    if (!admin && !supervisor && agent?.operatorId !== op.id) throw forbidden('NO_CROSS_VISIBILITY', 'Analyse réservée à l’opérateur, à ses agents et à la supervision.');
    const cancelled = new Set(this.rk.operateurs.privateCancellations.find((c) => c.operatorId === op.id).map((c) => c.saleId));
    const mineOnly = !admin && !supervisor;
    const all = this.rk.operateurs.privateSales.find((s) => s.operatorId === op.id && (!mineOnly || s.agentId === user.id));
    const dayOf = (iso: string) => kinshasaDate(new Date(iso));
    const live = all.filter((s) => !cancelled.has(s.id));
    const today = live.filter((s) => dayOf(s.soldAt) === date);
    const commissions = this.commissions.find((c) => c.operatorId === op.id && dayOf(c.at) === date && !cancelled.has(c.saleId) && (!mineOnly || c.agentId === user.id));
    const hour = (iso: string) => String(new Date(new Date(iso).getTime() + 3_600_000).getUTCHours()).padStart(2, '0');
    const group = (key: (s: PrivateSale) => string) => {
      const m = new Map<string, PrivateSale[]>();
      for (const s of today) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
      return [...m.entries()].map(([k, list]) => ({ key: k, count: list.length, amounts: sumByCurrency(list.map((x) => x.amount)) })).sort((a, b) => a.key.localeCompare(b.key));
    };
    const d0 = Date.parse(`${date}T00:00:00.000Z`);
    const prev7 = Array.from({ length: 7 }, (_, i) => kinshasaDate(new Date(d0 - (i + 1) * DAY_MS + 12 * 3_600_000)));
    const avg7 = Math.round((live.filter((s) => prev7.includes(dayOf(s.soldAt))).length * 10) / 7) / 10;
    const cancellationsToday = all.filter((s) => cancelled.has(s.id) && this.rk.operateurs.privateCancellations.findOne((c) => c.saleId === s.id && dayOf(c.at) === date)).length;
    const byAgentCommission = new Map<string, MoneyJSON[]>();
    for (const c of commissions) byAgentCommission.set(c.agentId, [...(byAgentCommission.get(c.agentId) ?? []), c.amount]);
    const result = {
      operator: { id: op.id, name: op.name, kind: op.kind }, date, viewer: admin ? 'EXPLOITANT' : supervisor ? 'SUPERVISION' : 'AGENT',
      sales: today.length, amounts: sumByCurrency(today.map((s) => s.amount)), cancellations: cancellationsToday,
      commissions: { count: commissions.length, amounts: sumByCurrency(commissions.map((c) => c.amount)), payer: 'Opérateur (contrat opérateur-agent) — jamais le compte public' },
      previous7DaysAverage: avg7, trend: avg7 === 0 ? (today.length ? 'HAUSSE' : 'STABLE') : today.length > avg7 * 1.2 ? 'HAUSSE' : today.length < avg7 * 0.8 ? 'BAISSE' : 'STABLE',
      byHour: group((s) => hour(s.soldAt)), byOffer: group((s) => s.offerId), byAgent: mineOnly ? [] : group((s) => s.agentId).map((g) => ({ ...g, commissions: sumByCurrency(byAgentCommission.get(g.key) ?? []), blocked: !!this.blocks.findOne((b) => b.agentId === g.key && b.status === 'BLOQUE') })),
      reviews: mineOnly ? [] : this.rk.operateurs.reviews.find((r) => r.operatorId === op.id && r.day === date),
      limits: this.limits.get(op.id) ?? null, grid: this.grids.get(op.id) ?? null,
      generatedAt: this.now().toISOString(),
    };
    return result;
  }

  // ------------------------------------------------------------------------------------------ période de grâce (81, 76)

  proposeGrace(user: User, input: { module: string; until: string; motif: string }): GraceProposal {
    authorize(user, 'rakapay:grace.propose', { entity: ENTITY });
    if (input.module !== MODULE_WEWA && input.module !== MODULE_BILLETTERIE) throw badRequest('UNKNOWN_MODULE', 'Module 76 ou 81 attendu.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) throw badRequest('INVALID_DATE', 'Échéance AAAA-MM-JJ attendue.');
    if (input.motif.trim().length < 10) throw badRequest('MOTIF_REQUIRED', 'Motif de 10 caractères au moins.');
    if (this.graceProposals.findOne((g) => g.module === input.module && g.status === 'PROPOSEE')) throw conflict('GRACE_PENDING', 'Une proposition attend déjà sa décision.');
    const g = this.graceProposals.insert({ id: this.ids.next('GRC'), module: input.module, until: input.until, motif: input.motif.trim(), status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'rakapay.grace.proposed', resourceType: 'rakapay_grace', resourceId: g.id, details: { module: g.module, until: g.until, current: this.rk.titres.gracePeriods.get(g.module) ?? null } });
    return g;
  }

  decideGrace(user: User, id: string, input: { approve: boolean; motif: string }): GraceProposal {
    authorize(user, 'rakapay:grace.approve', { entity: ENTITY });
    const g = this.graceProposals.get(id);
    if (!g || g.status !== 'PROPOSEE') throw notFound('GRACE_NOT_PENDING', 'Aucune proposition en attente.');
    assertDistinctPerson(user.id, [g.proposedBy], 'La période de grâce est approuvée par une personne distincte de celle qui la propose.');
    const saved = this.graceProposals.update({ ...g, status: input.approve ? 'APPROUVEE' : 'REJETEE', decision: { by: user.id, at: this.now().toISOString(), approve: input.approve, motif: input.motif.trim() } });
    const before = this.rk.titres.gracePeriods.get(g.module) ?? null;
    if (input.approve) this.rk.titres.gracePeriods.set(g.module, g.until);
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'rakapay.grace.approved' : 'rakapay.grace.rejected', resourceType: 'rakapay_grace', resourceId: id, details: { module: g.module, before, after: input.approve ? g.until : before } });
    return saved;
  }

  graceView() {
    const today = kinshasaDate(this.now());
    return {
      modules: [MODULE_BILLETTERIE, MODULE_WEWA].map((m) => {
        const until = this.rk.titres.gracePeriods.get(m) ?? null;
        return { module: m, until, active: !!until && today <= until, pending: this.graceProposals.findOne((g) => g.module === m && g.status === 'PROPOSEE') ?? null };
      }),
      history: this.graceProposals.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      notice: 'Pendant la période de grâce, les constats sont pédagogiques : aucune pénalité ne peut être liquidée. Échéance proposée par le responsable, approuvée par une personne distincte.',
    };
  }
}
