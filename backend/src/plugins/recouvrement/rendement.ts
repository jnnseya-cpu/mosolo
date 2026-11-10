/**
 * Rendement du recouvrement (§ 21.1 « mesure systématique de la récupération brute et de la récupération nette des
 * coûts de recouvrement » ; § 21.2 « rendement net durable, pas le harcèlement : les campagnes sont testées, mesurées et
 * arrêtées si elles produisent un coût disproportionné » ; grand débiteur : « gestion de cas, garanties, décisions
 * tracées, supervision »).
 *
 *  - Coûts : saisis par une personne habilitée, pièce justificative par empreinte, rattachés à un dossier et/ou à une
 *    campagne ; aucun coût unitaire n'est supposé. Sans coût saisi, la récupération nette est NON_MESURE.
 *  - Récupération brute : paiements confirmés et rapprochés sur l'obligation depuis l'ouverture du dossier.
 *  - Priorisation par rendement net ESTIMÉ, à partir des seuls taux et coûts OBSERVÉS par segment (sinon NON_MESURE) :
 *    elle ordonne une file de travail proposée à un agent, elle ne déclenche rien.
 *  - Campagnes : `campaignYield` mesure le rendement d'une campagne par son identifiant (appelé par le module des
 *    campagnes) et signale un arrêt À EXAMINER si le coût dépasse la récupération ; l'arrêt reste une décision humaine.
 *  - Garanties des grands débiteurs : proposées par l'agent de recouvrement (R20), validées ou rejetées par l'autorité
 *    de décision (R21, personne distincte) ; mainlevée motivée par R21.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { RecoveryService } from './service.js';

const A = GRANTS.always;
definePolicy('recouvrement:yield.read', { R06: A, R07: A, R11: A, R17: A, R20: A, R21: A, R22: A, R23: A });
definePolicy('recouvrement:cost.record', { R06: A, R07: A, R20: A });
definePolicy('recouvrement:guarantee.propose', { R20: A });
definePolicy('recouvrement:guarantee.decide', { R21: A });

export const COST_KINDS = ['AVIS', 'SMS', 'APPEL', 'VISITE', 'HEURE_AGENT', 'DEPLACEMENT', 'HUISSIER', 'AUTRE'] as const;
export type CostKind = (typeof COST_KINDS)[number];
export const GUARANTEE_NATURES = ['CAUTION_BANCAIRE', 'HYPOTHEQUE', 'NANTISSEMENT', 'DEPOT_GARANTIE', 'CAUTION_PERSONNELLE', 'AUTRE'] as const;

export interface RecoveryCost {
  id: string;
  caseId?: string;
  campaignId?: string;
  kind: CostKind;
  quantity: number;
  amount: MoneyJSON;
  evidenceSha256: string;
  note: string;
  recordedBy: string;
  recordedAt: string;
}

export interface Guarantee {
  id: string;
  caseId: string;
  obligationId: string;
  taxpayerId: string;
  nature: (typeof GUARANTEE_NATURES)[number];
  amount: MoneyJSON;
  description: string;
  evidenceSha256: string;
  status: 'PROPOSEE' | 'VALIDEE' | 'REJETEE' | 'LEVEE';
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionMotif?: string;
  release?: { by: string; at: string; motif: string };
}

const PAID = new Set(['CONFIRME', 'REGLE', 'RAPPROCHE']);
const NON_MESURE = 'NON_MESURE' as const;

type Totals = Record<string, string>;
function add(t: Totals, m: MoneyJSON): void {
  t[m.currency] = Money.fromJSON({ amount: t[m.currency] ?? '0', currency: m.currency }).add(Money.fromJSON(m)).toDecimalString();
}
function net(gross: Totals, cost: Totals): Totals {
  const out: Totals = {};
  for (const c of new Set([...Object.keys(gross), ...Object.keys(cost)])) {
    out[c] = Money.fromJSON({ amount: gross[c] ?? '0', currency: c as CurrencyCode }).subtract(Money.fromJSON({ amount: cost[c] ?? '0', currency: c as CurrencyCode })).toDecimalString();
  }
  return out;
}

export class RecoveryYieldService {
  readonly costs = new InMemoryRepository<RecoveryCost>();
  readonly guarantees = new InMemoryRepository<Guarantee>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly recovery: RecoveryService) {}

  private now(): string { return this.ctx.clock.now().toISOString(); }

  recordCost(user: User, input: { caseId?: string; campaignId?: string; kind: CostKind; quantity: number; amount: MoneyJSON; evidenceSha256: string; note: string }): RecoveryCost {
    authorize(user, 'recouvrement:cost.record');
    if (!input.caseId && !input.campaignId) throw unprocessable('COST_TARGET_REQUIRED', 'Un coût se rattache à un dossier de recouvrement ou à une campagne.');
    if (input.caseId) this.recovery.getCase(input.caseId);
    const amount = Money.parseStrict(input.amount);
    if (amount.isNegative() || amount.isZero()) throw unprocessable('INVALID_AMOUNT', 'Coût strictement positif attendu.');
    const c = this.costs.insert({
      id: this.ids.next('CRC'), ...(input.caseId ? { caseId: input.caseId } : {}), ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      kind: input.kind, quantity: input.quantity, amount: amount.toJSON(), evidenceSha256: input.evidenceSha256, note: input.note, recordedBy: user.id, recordedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery.cost.recorded', resourceType: 'recovery_cost', resourceId: c.id, details: { caseId: c.caseId ?? null, campaignId: c.campaignId ?? null, kind: c.kind, amount: c.amount, evidenceSha256: c.evidenceSha256 } });
    return c;
  }

  /** Récupération brute d'une obligation depuis une date : paiements confirmés (dont rapprochés), par devise. */
  private collected(obligationIds: string[], since: string): { gross: Totals; reconciled: Totals; payments: number } {
    const ids = new Set(obligationIds.map((id) => this.ctx.payments.currentObligationId(id)).concat(obligationIds));
    const gross: Totals = {};
    const reconciled: Totals = {};
    let payments = 0;
    for (const o of this.ctx.payments.orders.find((p) => ids.has(p.obligationId) && PAID.has(p.status) && !!p.confirmedAt && p.confirmedAt >= since)) {
      add(gross, o.amount);
      if (o.status === 'RAPPROCHE') add(reconciled, o.amount);
      payments++;
    }
    return { gross, reconciled, payments };
  }

  private costOf(filter: (c: RecoveryCost) => boolean): Totals {
    const t: Totals = {};
    for (const c of this.costs.find(filter)) add(t, c.amount);
    return t;
  }

  /** Mesure d'un dossier : brut, coûts saisis, net (NON_MESURE sans coût). */
  caseYield(caseId: string) {
    const c = this.recovery.getCase(caseId);
    const col = this.collected([c.obligationId], c.openedAt);
    const cost = this.costOf((x) => x.caseId === caseId);
    const measured = Object.keys(cost).length > 0;
    return { caseId, obligationId: c.obligationId, status: c.status, gross: col.gross, reconciled: col.reconciled, cost, net: measured ? net(col.gross, cost) : NON_MESURE, costMeasured: measured };
  }

  /**
   * Rendement d'une campagne (§ 21.2) — fonction publique appelée par le module des campagnes : obligations ciblées,
   * date de lancement, groupe témoin facultatif. Coûts : ceux saisis avec l'identifiant de campagne. Arrêt « à examiner »
   * si le coût atteint ou dépasse la récupération brute (décision d'arrêt : humaine, motivée).
   */
  campaignYield(campaignId: string, opts: { obligationIds: string[]; since: string; controlObligationIds?: string[] }) {
    const col = this.collected(opts.obligationIds, opts.since);
    const cost = this.costOf((x) => x.campaignId === campaignId);
    const measured = Object.keys(cost).length > 0;
    const netT = measured ? net(col.gross, cost) : NON_MESURE;
    const signals: { code: string; detail: string }[] = [];
    if (measured && netT !== NON_MESURE) {
      for (const [cur, v] of Object.entries(netT)) {
        if (Money.fromJSON({ amount: v, currency: cur as CurrencyCode }).isNegative() || Money.fromJSON({ amount: v, currency: cur as CurrencyCode }).isZero()) {
          signals.push({ code: 'COUT_DISPROPORTIONNE', detail: `Coût ${cost[cur] ?? '0'} ${cur} ≥ récupération brute ${col.gross[cur] ?? '0'} ${cur} : arrêt à examiner.` });
        }
      }
    }
    const control = opts.controlObligationIds?.length ? this.collected(opts.controlObligationIds, opts.since) : undefined;
    const rate = (n: number, d: number) => (d ? `${Math.round((n * 1000) / d) / 10} %` : null);
    const payers = (ids: string[]) => new Set(this.ctx.payments.orders.find((p) => ids.includes(p.obligationId) && PAID.has(p.status) && !!p.confirmedAt && p.confirmedAt >= opts.since).map((p) => p.obligationId)).size;
    return {
      campaignId, since: opts.since, targeted: opts.obligationIds.length, payments: col.payments, gross: col.gross, reconciled: col.reconciled, cost, net: netT, costMeasured: measured,
      paymentRate: rate(payers(opts.obligationIds), opts.obligationIds.length),
      ...(control ? { control: { targeted: opts.controlObligationIds!.length, gross: control.gross, paymentRate: rate(payers(opts.controlObligationIds!), opts.controlObligationIds!.length) } } : {}),
      stopSignals: signals, stopRecommended: signals.length > 0, automaticStop: false as const,
      note: 'Mesure seule : l’arrêt d’une campagne est une décision humaine motivée (coût disproportionné, erreurs, impact social).',
    };
  }

  /** Taux observés par segment : dossiers régularisés / dossiers, coût moyen par dossier chiffré (par devise). */
  private segmentObservations() {
    const obs = new Map<string, { cases: number; regularised: number; costed: number; cost: Totals }>();
    for (const c of this.recovery.cases.all()) {
      const o = this.ctx.assessment.obligations.get(c.obligationId);
      if (!o) continue;
      const seg = this.recovery.segmentOf(o).code;
      const s = obs.get(seg) ?? { cases: 0, regularised: 0, costed: 0, cost: {} };
      s.cases++;
      if (c.status === 'REGULARISE') s.regularised++;
      const cost = this.costOf((x) => x.caseId === c.id);
      if (Object.keys(cost).length) { s.costed++; for (const [cur, v] of Object.entries(cost)) add(s.cost, { amount: v, currency: cur as CurrencyCode }); }
      obs.set(seg, s);
    }
    return obs;
  }

  /** File de travail priorisée par rendement net estimé (observé), jamais une décision. */
  priorities(user: User) {
    authorize(user, 'recouvrement:yield.read');
    const obs = this.segmentObservations();
    const today = kinshasaDate(this.ctx.clock.now());
    const rows = this.recovery.arrears().items.map((a) => {
      const seg = (a as { segment: { code: string; label: string } }).segment;
      const s = obs.get(seg.code);
      const paid = this.ctx.payments.paidOn(a.obligationId);
      const rest = Money.fromJSON(a.amount).subtract(paid.currency === a.amount.currency ? paid : Money.zero(a.amount.currency as CurrencyCode));
      const outstanding = rest.isNegative() ? Money.zero(a.amount.currency as CurrencyCode) : rest;
      const rateMeasured = !!s && s.cases > 0;
      const rate = rateMeasured ? s.regularised / s.cases : null;
      const avgCost = s && s.costed > 0 && s.cost[a.amount.currency] ? Money.fromJSON({ amount: s.cost[a.amount.currency]!, currency: a.amount.currency }).multiply((1 / s.costed).toFixed(9)) : null;
      const expected = rate !== null && avgCost ? outstanding.multiply(rate.toFixed(6)).subtract(avgCost) : null;
      let rankValue: number;
      try { rankValue = Number(this.ctx.fx.convert((expected ?? outstanding).toJSON(), 'CDF', today).amount.amount); } catch { rankValue = Number((expected ?? outstanding).toDecimalString()); }
      return {
        obligationId: a.obligationId, taxpayerId: a.taxpayerId, label: a.label, commune: a.commune, segment: seg, ageDays: a.ageDays, caseId: a.caseId,
        outstanding: outstanding.toJSON(),
        observedRecoveryRate: rate === null ? NON_MESURE : `${Math.round(rate * 1000) / 10} %`,
        observedCostPerCase: avgCost ? avgCost.toJSON() : NON_MESURE,
        expectedNetYield: expected ? expected.toJSON() : NON_MESURE,
        measured: !!expected, rankValue,
      };
    }).sort((x, y) => Number(y.measured) - Number(x.measured) || y.rankValue - x.rankValue);
    return {
      asOf: today, items: rows.map(({ rankValue: _r, ...r }, i) => ({ rank: i + 1, ...r })),
      method: 'Rendement net estimé = restant dû × taux de régularisation observé du segment − coût moyen observé par dossier du segment (même devise). Classement entre devises par contre-valeur indicative au taux du jour. Sans observation : NON_MESURE, classé après.',
      automaticDecision: false as const,
    };
  }

  /** Vue d'ensemble : brut, coûts, net par devise ; dossiers chiffrés ; campagnes vues au registre des coûts. */
  summary() {
    const cases = this.recovery.cases.all();
    const gross: Totals = {};
    const reconciled: Totals = {};
    for (const c of cases) {
      const col = this.collected([c.obligationId], c.openedAt);
      for (const [cur, v] of Object.entries(col.gross)) add(gross, { amount: v, currency: cur as CurrencyCode });
      for (const [cur, v] of Object.entries(col.reconciled)) add(reconciled, { amount: v, currency: cur as CurrencyCode });
    }
    const cost = this.costOf(() => true);
    const measured = this.costs.count() > 0;
    return {
      status: measured ? ('MESURE' as const) : NON_MESURE,
      detail: measured ? 'Coûts saisis avec pièce justificative : récupération nette = brute − coûts (par devise).' : 'Coût des actions de recouvrement non encore saisi : récupération nette non calculable.',
      gross, reconciled, cost, net: measured ? net(gross, cost) : NON_MESURE,
      costedCases: new Set(this.costs.find((c) => !!c.caseId).map((c) => c.caseId)).size, cases: cases.length,
      campaigns: [...new Set(this.costs.find((c) => !!c.campaignId).map((c) => c.campaignId!))].map((id) => ({ campaignId: id, cost: this.costOf((x) => x.campaignId === id) })),
    };
  }

  board(user: User) {
    authorize(user, 'recouvrement:yield.read');
    return {
      summary: this.summary(),
      cases: this.recovery.cases.all().map((c) => this.caseYield(c.id)),
      costs: this.costs.all().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
      largeDebtors: this.largeDebtors(),
      guarantees: this.guarantees.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      costKinds: COST_KINDS, guaranteeNatures: GUARANTEE_NATURES,
    };
  }

  /* ------------------------------------------------------------ grands débiteurs : garanties */

  private isLargeDebtor(obligationId: string): boolean {
    const o = this.ctx.assessment.obligations.get(obligationId);
    return !!o && this.recovery.segmentOf(o).code === 'GRAND_REDEVABLE';
  }

  largeDebtors() {
    return this.recovery.cases.find((c) => c.status === 'OUVERT' && this.isLargeDebtor(c.obligationId)).map((c) => {
      const o = this.ctx.assessment.obligations.get(c.obligationId)!;
      const valid = this.guarantees.find((g) => g.caseId === c.id && g.status === 'VALIDEE');
      const covered: Totals = {};
      for (const g of valid) add(covered, g.amount);
      return { caseId: c.id, obligationId: o.id, taxpayerId: o.taxpayerId, label: o.label, amount: o.amount, guarantees: valid.length, covered, pending: this.guarantees.find((g) => g.caseId === c.id && g.status === 'PROPOSEE').length };
    });
  }

  proposeGuarantee(user: User, input: { caseId: string; nature: Guarantee['nature']; amount: MoneyJSON; description: string; evidenceSha256: string }): Guarantee {
    authorize(user, 'recouvrement:guarantee.propose');
    const c = this.recovery.getCase(input.caseId);
    if (c.status !== 'OUVERT') throw conflict('CASE_NOT_OPEN', `Dossier ${c.id} au statut ${c.status}.`);
    if (!this.isLargeDebtor(c.obligationId)) throw unprocessable('NOT_LARGE_DEBTOR', 'Les garanties se gèrent au dossier d’un grand débiteur (segment GRAND_REDEVABLE).');
    const g = this.guarantees.insert({
      id: this.ids.next('GAR'), caseId: c.id, obligationId: c.obligationId, taxpayerId: c.taxpayerId, nature: input.nature, amount: Money.parseStrict(input.amount).toJSON(),
      description: input.description, evidenceSha256: input.evidenceSha256, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery.guarantee.proposed', resourceType: 'recovery_case', resourceId: c.id, details: { guaranteeId: g.id, nature: g.nature, amount: g.amount, evidenceSha256: g.evidenceSha256 } });
    return g;
  }

  decideGuarantee(user: User, id: string, input: { decision: 'VALIDEE' | 'REJETEE'; motivation: string }): Guarantee {
    authorize(user, 'recouvrement:guarantee.decide');
    const g = this.guarantees.get(id);
    if (!g) throw notFound('GUARANTEE_NOT_FOUND', `Garantie inconnue : ${id}`);
    if (g.status !== 'PROPOSEE') throw conflict('GUARANTEE_ALREADY_DECIDED', `Garantie ${id} déjà ${g.status}.`);
    assertDistinctPerson(user.id, [g.proposedBy], 'Décision tracée : la garantie est validée par une autre personne que celle qui l’a proposée.');
    const r = this.guarantees.update({ ...g, status: input.decision, decidedBy: user.id, decidedAt: this.now(), decisionMotif: input.motivation });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery.guarantee.decided', resourceType: 'recovery_case', resourceId: g.caseId, details: { guaranteeId: id, decision: input.decision, proposedBy: g.proposedBy, motivation: input.motivation } });
    return r;
  }

  releaseGuarantee(user: User, id: string, motivation: string): Guarantee {
    authorize(user, 'recouvrement:guarantee.decide');
    const g = this.guarantees.get(id);
    if (!g) throw notFound('GUARANTEE_NOT_FOUND', `Garantie inconnue : ${id}`);
    if (g.status !== 'VALIDEE') throw conflict('GUARANTEE_NOT_ACTIVE', `Seule une garantie validée fait l’objet d’une mainlevée (statut ${g.status}).`);
    const r = this.guarantees.update({ ...g, status: 'LEVEE', release: { by: user.id, at: this.now(), motif: motivation } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery.guarantee.released', resourceType: 'recovery_case', resourceId: g.caseId, details: { guaranteeId: id, motivation } });
    return r;
  }
}
