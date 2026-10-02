/**
 * Rapprochement PROPOSÉ et crédits groupés (§ 20, § 20.1 ; critère d'acceptation Finance : « le rapprochement est
 * proposé ou automatique selon la politique, et audité »).
 *
 *  - L'appariement AUTOMATIQUE reste réservé à la correspondance exacte (référence, montant, devise, compte, version du
 *    compte) : il est fait à l'import du relevé par le socle (modules/treasury) et n'est pas modifié ici.
 *  - Sous la correspondance exacte, un score d'appariement déterministe (facteurs visibles) désigne des candidats ; au-delà
 *    du seuil de la politique, une personne PROPOSE l'appariement et une autre le CONFIRME (quatre yeux, circuit
 *    TRESOR_APPARIEMENT). Sous le seuil : rien n'est proposé, l'exception reste dans sa file.
 *  - Tolérance de change : un crédit dans une autre devise que l'ordre n'est jamais apparié automatiquement ; il peut
 *    être proposé si la contre-valeur au taux du jour de valeur reste dans la tolérance ; l'écart de change est enregistré.
 *  - Crédit groupé d'un prestataire : une ligne unique découpée par le fichier de détail du prestataire ; appariée
 *    automatiquement seulement si CHAQUE détail s'apparie exactement et si le total égale le crédit ; sinon exception
 *    CREDIT_GROUPE_ECART, jamais ignorée.
 * Toutes les files d'exception et les chemins exacts existants restent inchangés.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf, type AuditActor } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS } from '../../core/clock.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import type { ReconciliationException, StatementLine } from '../../modules/treasury/service.js';
import { PROVIDER_SETTLEMENT_DELAY_DAYS } from './service.js';

/** Score minimal (sur 100) pour qu'un appariement soit PROPOSÉ à une confirmation humaine — PAR_DEFAUT, à confirmer. */
export const APPARIEMENT_SEUIL_PROPOSITION = 70;
/** Tolérance de change (écart relatif de la contre-valeur, en %) d'un crédit en autre devise — PAR_DEFAUT, à confirmer. */
export const TOLERANCE_CHANGE_PCT = 0.5;
/** Nombre maximal de candidats affichés par exception. */
const MAX_CANDIDATES = 3;
/** Système : appariement exact d'un crédit groupé (aucune personne ne l'a décidé). */
export const GROUPED_AUTO_ACTOR = 'SYSTEME:RAPPROCHEMENT_AUTOMATIQUE';

const { always } = GRANTS;
definePolicy('tresor:matching.read', { R17: always, R18: always, R22: always, R23: always });
definePolicy('tresor:matching.propose', { R17: always, R18: always });
definePolicy('tresor:matching.decide', { R17: always });

/** Types d'exception de relevé pour lesquels un appariement peut être proposé (jamais entre deux comptes publics). */
const PROPOSABLE = new Set(['ORPHAN_CREDIT', 'AMOUNT_MISMATCH', 'CREDIT_GROUPE_ECART']);

export interface ScoreFactor { code: 'REFERENCE' | 'MONTANT' | 'COMPTE' | 'DATE'; points: number; max: number; detail: string }
export interface MatchCandidate {
  exceptionId: string;
  paymentReference: string;
  orderAmount: MoneyJSON;
  lineAmount: MoneyJSON;
  score: number;
  factors: ScoreFactor[];
  /** Crédit en autre devise : contre-valeur au taux du jour de valeur et écart de change (à enregistrer). */
  fx?: { rate: string; rateDate: string; converted: MoneyJSON; gap: MoneyJSON; gapPct: string; source: string; demo: boolean };
  proposable: boolean;
}

export interface MatchProposal {
  id: string;
  exceptionId: string;
  statementId?: string;
  paymentReference: string;
  score: number;
  factors: ScoreFactor[];
  fx?: MatchCandidate['fx'];
  motif: string;
  status: 'PROPOSEE' | 'CONFIRMEE' | 'REJETEE';
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionMotif?: string;
  result?: { receiptNumber: string; ledgerEntryId: string; ecartChange?: MoneyJSON };
}

/** Distance d'édition (Damerau restreinte : une transposition compte pour une erreur). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}
const normRef = (r: string) => r.toUpperCase().replace(/[^0-9A-Z]/g, '');

export class MatchingService {
  readonly proposals = new InMemoryRepository<MatchProposal>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {
    // Crédit groupé présent dans le relevé (fichier de détail joint à la ligne) : réclamé SANS écriture, apparié à
    // l'application seulement si tout est exact ; sinon requalifié en CREDIT_GROUPE_ECART.
    ctx.treasury.addStatementClaimant((_statementId, lines) => {
      const matched: StatementLine[] = [];
      const exceptions: { line: StatementLine; type: 'CREDIT_GROUPE_ECART'; detail: string }[] = [];
      const plans: { line: StatementLine; orders: PaymentOrder[] }[] = [];
      const used = new Set<string>();
      for (const line of lines) {
        if (!line.details?.length) continue;
        const r = this.checkGrouped(line, used);
        if (r.ok) { matched.push(line); plans.push({ line, orders: r.orders }); r.orders.forEach((o) => used.add(o.id)); } else exceptions.push({ line, type: 'CREDIT_GROUPE_ECART', detail: r.detail });
      }
      return { matched, exceptions, apply: (actor) => plans.map((p) => this.applyGrouped(p.line, p.orders, actor)) };
    });
  }

  private now(): string { return this.ctx.clock.now().toISOString(); }

  /* ------------------------------------------------------------- crédits groupés */

  /** Contrôle exact d'un crédit groupé : total = crédit, chaque détail = un ordre CONFIRMÉ, même montant, même compte. */
  checkGrouped(line: StatementLine, used = new Set<string>()): { ok: true; orders: PaymentOrder[] } | { ok: false; detail: string } {
    const details = line.details ?? [];
    if (!details.length) return { ok: false, detail: 'Fichier de détail absent.' };
    let credited: Money;
    try {
      credited = Money.parseStrict(line.amount);
    } catch (e) {
      return { ok: false, detail: `Montant du crédit illisible : ${(e as Error).message}` };
    }
    const bad = details.find((d) => d.amount.currency !== credited.currency);
    if (bad) return { ok: false, detail: `Détail ${bad.paymentReference} en ${bad.amount.currency}, crédit en ${credited.currency} : aucun appariement automatique entre devises.` };
    let total: Money;
    try {
      total = details.reduce((m, d) => m.add(Money.parseStrict(d.amount)), Money.zero(credited.currency as CurrencyCode));
    } catch (e) {
      return { ok: false, detail: `Montant de détail illisible : ${(e as Error).message}` };
    }
    if (!total.equals(credited)) return { ok: false, detail: `Total du fichier de détail ${total.toDecimalString()} ${total.currency} ≠ crédit groupé ${credited.toDecimalString()} ${credited.currency}.` };
    const refs = new Set<string>();
    const orders: PaymentOrder[] = [];
    for (const d of details) {
      if (refs.has(d.paymentReference)) return { ok: false, detail: `Référence ${d.paymentReference} présente deux fois dans le fichier de détail.` };
      refs.add(d.paymentReference);
      const o = this.ctx.payments.byReference(d.paymentReference);
      if (!o) return { ok: false, detail: `Référence ${d.paymentReference} inconnue.` };
      if (o.status !== 'CONFIRME' || used.has(o.id)) return { ok: false, detail: `Paiement ${d.paymentReference} au statut ${o.status}${used.has(o.id) ? ' (déjà apparié dans ce relevé)' : ''} : confirmation prestataire requise, une seule fois.` };
      if (!Money.fromJSON(o.amount).equals(Money.parseStrict(d.amount))) return { ok: false, detail: `Détail ${d.paymentReference} : ${d.amount.amount} ${d.amount.currency} ≠ montant confirmé ${o.amount.amount} ${o.amount.currency}.` };
      if (o.beneficiaryAlias !== line.accountAlias) return { ok: false, detail: `Détail ${d.paymentReference} destiné à ${o.beneficiaryAlias}, crédit sur ${line.accountAlias}.` };
      if (o.beneficiaryAccountVersion !== undefined && line.accountVersion !== undefined && o.beneficiaryAccountVersion !== line.accountVersion) {
        return { ok: false, detail: `Détail ${d.paymentReference} émis sous la version ${o.beneficiaryAccountVersion} du compte, crédit sous la version ${line.accountVersion}.` };
      }
      const blocker = this.ctx.treasury.matchBlocker(o);
      if (blocker) return { ok: false, detail: blocker };
      orders.push(o);
    }
    return { ok: true, orders };
  }

  private applyGrouped(line: StatementLine, orders: PaymentOrder[], actor: AuditActor): Record<string, unknown> {
    const matched = orders.map((o) => this.ctx.treasury.completeMatch(o.id, {
      debit: 'COMPTE_PUBLIC_RECETTES', description: `Crédit groupé ${line.paymentReference} (${line.accountAlias}) — détail ${o.paymentReference}`,
      actor, details: { groupedCredit: line.paymentReference, detailFileSha256: line.detailFileSha256 ?? null },
    }));
    this.ctx.audit.append({ actor, action: 'reconciliation.grouped_credit.matched', resourceType: 'statement_line', resourceId: line.paymentReference, details: { accountAlias: line.accountAlias, count: matched.length, amount: line.amount, detailFileSha256: line.detailFileSha256 ?? null } });
    return { kind: 'CREDIT_GROUPE', groupedReference: line.paymentReference, amount: line.amount, details: matched.map(({ ledgerEntryId: _l, ...m }) => m) };
  }

  /**
   * Fichier de détail reçu APRÈS le relevé : sur un crédit orphelin (ou un écart de crédit groupé) encore ouvert,
   * appariement automatique si tout est exact (exception résolue par le système, référence du fichier) ; sinon refus
   * motivé, l'exception reste dans sa file.
   */
  attachDetail(user: User, exceptionId: string, input: { details: { paymentReference: string; amount: MoneyJSON }[]; detailFileSha256: string }) {
    authorize(user, 'tresor:matching.propose');
    const e = this.ctx.treasury.openStatementExceptions((x) => x.id === exceptionId)[0];
    if (!e || !e.line) throw notFound('EXCEPTION_NOT_FOUND', `Exception de relevé ouverte inconnue : ${exceptionId}`);
    if (e.type !== 'ORPHAN_CREDIT' && e.type !== 'CREDIT_GROUPE_ECART') throw unprocessable('NOT_A_GROUPED_CREDIT', `L'exception ${e.id} (${e.type}) n'est pas un crédit non identifié : aucun fichier de détail à rattacher.`);
    const line: StatementLine = { ...e.line, details: input.details, detailFileSha256: input.detailFileSha256 };
    const r = this.checkGrouped(line);
    const actor = actorOf(user);
    if (!r.ok) {
      this.ctx.audit.append({ actor, action: 'reconciliation.grouped_credit.rejected', resourceType: 'reconciliation_exception', resourceId: e.id, outcome: 'FAILURE', details: { detail: r.detail, detailFileSha256: input.detailFileSha256 } });
      throw unprocessable('GROUPED_CREDIT_MISMATCH', `${r.detail} Aucun appariement : l'exception reste dans sa file.`);
    }
    const out = this.applyGrouped(line, r.orders, actor);
    this.ctx.treasury.resolveExceptions([e.id], { resolvedBy: GROUPED_AUTO_ACTOR, reference: `DETAIL-${input.detailFileSha256.slice(0, 12)}`, motif: `Crédit groupé découpé par le fichier de détail du prestataire (${r.orders.length} paiement(s)), transmis par ${user.id}.` }, actor);
    return out;
  }

  /* -------------------------------------------------------------- score et candidats */

  private score(e: ReconciliationException, o: PaymentOrder): MatchCandidate | undefined {
    const line = e.line!;
    if (o.beneficiaryAlias !== line.accountAlias) return undefined; // jamais d'appariement entre deux comptes publics
    const factors: ScoreFactor[] = [];
    const a = normRef(line.paymentReference);
    const b = normRef(o.paymentReference);
    const dist = a === b ? 0 : editDistance(a, b);
    factors.push({ code: 'REFERENCE', max: 40, points: dist === 0 ? 40 : dist === 1 ? 25 : 0, detail: dist === 0 ? 'Référence identique.' : dist === 1 ? 'Référence à une erreur de saisie près (caractère omis, ajouté, substitué ou inversé).' : 'Référence différente.' });
    let fx: MatchCandidate['fx'];
    let credited: Money;
    try { credited = Money.parseStrict(line.amount); } catch { return undefined; }
    const due = Money.fromJSON(o.amount);
    if (credited.currency === due.currency) {
      factors.push({ code: 'MONTANT', max: 35, points: credited.equals(due) ? 35 : 0, detail: credited.equals(due) ? 'Montant identique.' : `Montant différent (${credited.toDecimalString()} ≠ ${due.toDecimalString()} ${due.currency}) : écart réel, jamais apparié.` });
    } else {
      try {
        const conv = this.ctx.fx.convert(credited.toJSON(), due.currency as CurrencyCode, line.valueDate);
        const converted = Money.fromJSON(conv.amount);
        const gap = converted.subtract(due);
        const absGap = gap.isNegative() ? gap.negate() : gap;
        const tol = due.percent(String(TOLERANCE_CHANGE_PCT));
        const within = absGap.compare(tol) <= 0;
        const gapPct = due.isZero() ? '0' : ((Number(absGap.toDecimalString()) * 100) / Number(due.toDecimalString())).toFixed(3);
        fx = { rate: conv.rate, rateDate: conv.rateDate, converted: conv.amount, gap: gap.toJSON(), gapPct, source: conv.source, demo: conv.demo };
        factors.push({ code: 'MONTANT', max: 35, points: within ? 20 : 0, detail: within
          ? `Crédit en ${credited.currency} : contre-valeur ${converted.toDecimalString()} ${due.currency} (taux ${conv.rate} du ${conv.rateDate}), écart ${gapPct} % dans la tolérance de change de ${TOLERANCE_CHANGE_PCT} % [PAR_DEFAUT — à confirmer].`
          : `Crédit en ${credited.currency} : écart de change ${gapPct} % hors tolérance (${TOLERANCE_CHANGE_PCT} %).` });
      } catch {
        factors.push({ code: 'MONTANT', max: 35, points: 0, detail: `Aucun taux publié pour ${credited.currency}/${due.currency} au ${line.valueDate}.` });
      }
    }
    factors.push({ code: 'COMPTE', max: 15, points: 15, detail: `Même compte public (${line.accountAlias}).` });
    const confirmed = o.confirmedAt ? new Date(o.confirmedAt).getTime() : undefined;
    const value = new Date(`${line.valueDate}T12:00:00.000Z`).getTime();
    const near = confirmed !== undefined && Math.abs(value - confirmed) <= (PROVIDER_SETTLEMENT_DELAY_DAYS + 1) * DAY_MS;
    factors.push({ code: 'DATE', max: 10, points: near ? 10 : 0, detail: near ? `Date de valeur compatible avec la confirmation (délai de règlement ${PROVIDER_SETTLEMENT_DELAY_DAYS} j).` : 'Date de valeur éloignée de la confirmation.' });
    const score = factors.reduce((s, f) => s + f.points, 0);
    // Un montant différent dans la même devise ne se propose jamais (écart réel), une référence sans rapport non plus.
    const amountOk = factors.find((f) => f.code === 'MONTANT')!.points > 0;
    const refOk = factors.find((f) => f.code === 'REFERENCE')!.points > 0;
    const blocked = !!this.ctx.treasury.matchBlocker(o) || (o.beneficiaryAccountVersion !== undefined && line.accountVersion !== undefined && o.beneficiaryAccountVersion !== line.accountVersion);
    return {
      exceptionId: e.id, paymentReference: o.paymentReference, orderAmount: o.amount, lineAmount: line.amount, score, factors, ...(fx ? { fx } : {}),
      proposable: amountOk && refOk && !blocked && score >= APPARIEMENT_SEUIL_PROPOSITION,
    };
  }

  private candidatesFor(e: ReconciliationException): MatchCandidate[] {
    const pendingOrders = new Set(this.proposals.find((p) => p.status === 'PROPOSEE').map((p) => p.paymentReference));
    return this.ctx.payments.orders.find((o) => o.status === 'CONFIRME' && !pendingOrders.has(o.paymentReference))
      .map((o) => this.score(e, o)).filter((c): c is MatchCandidate => !!c && c.score > 0)
      .sort((x, y) => y.score - x.score).slice(0, MAX_CANDIDATES);
  }

  /** Tableau du rapprochement proposé : exceptions éligibles, candidats notés, propositions et politique. */
  board(user: User) {
    authorize(user, 'tresor:matching.read');
    const pendingEx = new Set(this.proposals.find((p) => p.status === 'PROPOSEE').map((p) => p.exceptionId));
    const items = this.ctx.treasury.openStatementExceptions((e) => PROPOSABLE.has(e.type) && !pendingEx.has(e.id)).map((e) => ({
      exceptionId: e.id, type: e.type, statementId: e.statementId ?? null, line: e.line, detail: e.detail, candidates: this.candidatesFor(e),
    }));
    return {
      policy: {
        mode: 'PROPOSE_SOUS_SEUIL', automaticOnlyForExactMatch: true, threshold: APPARIEMENT_SEUIL_PROPOSITION, fxTolerancePct: TOLERANCE_CHANGE_PCT,
        statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage',
        note: 'Appariement automatique uniquement sur correspondance exacte. Au-delà du seuil, une personne propose et une autre confirme ; sous le seuil, rien n’est proposé.',
      },
      items,
      proposals: this.proposals.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
    };
  }

  propose(user: User, input: { exceptionId: string; paymentReference: string; motif: string }): MatchProposal {
    authorize(user, 'tresor:matching.propose');
    const e = this.ctx.treasury.openStatementExceptions((x) => x.id === input.exceptionId)[0];
    if (!e || !PROPOSABLE.has(e.type)) throw notFound('EXCEPTION_NOT_FOUND', `Exception de relevé ouverte et appariable inconnue : ${input.exceptionId}`);
    if (this.proposals.findOne((p) => p.status === 'PROPOSEE' && (p.exceptionId === e.id || p.paymentReference === input.paymentReference))) {
      throw conflict('MATCH_ALREADY_PROPOSED', 'Un appariement attend déjà confirmation pour cette exception ou ce paiement.');
    }
    const o = this.ctx.payments.byReference(input.paymentReference);
    if (!o || o.status !== 'CONFIRME') throw unprocessable('PAYMENT_NOT_CONFIRMED', `Paiement ${input.paymentReference} inconnu ou non confirmé par le prestataire.`);
    const c = this.score(e, o);
    if (!c?.proposable) throw unprocessable('MATCH_BELOW_THRESHOLD', `Score ${c?.score ?? 0}/100 sous le seuil de proposition (${APPARIEMENT_SEUIL_PROPOSITION}) ou appariement exclu : l'exception reste dans sa file.`, { factors: c?.factors ?? [] });
    const p = this.proposals.insert({
      id: this.ids.next('APP'), exceptionId: e.id, ...(e.statementId ? { statementId: e.statementId } : {}), paymentReference: o.paymentReference,
      score: c.score, factors: c.factors, ...(c.fx ? { fx: c.fx } : {}), motif: input.motif, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.match.proposed', resourceType: 'match_proposal', resourceId: p.id, details: { exceptionId: e.id, paymentReference: o.paymentReference, score: c.score, fx: c.fx ?? null } });
    return p;
  }

  decide(user: User, id: string, input: { approve: boolean; motif: string }): MatchProposal {
    authorize(user, 'tresor:matching.decide');
    const p = this.proposals.get(id);
    if (!p) throw notFound('MATCH_PROPOSAL_NOT_FOUND', `Proposition d'appariement inconnue : ${id}`);
    if (p.status !== 'PROPOSEE') throw conflict('MATCH_ALREADY_DECIDED', `Proposition ${id} déjà ${p.status}.`);
    assertDistinctPerson(user.id, [p.proposedBy], 'Quatre yeux : l’appariement proposé est confirmé ou rejeté par une autre personne que son auteur.');
    const at = this.now();
    if (!input.approve) {
      const r = this.proposals.update({ ...p, status: 'REJETEE', decidedBy: user.id, decidedAt: at, decisionMotif: input.motif });
      this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.match.rejected', resourceType: 'match_proposal', resourceId: id, details: { proposedBy: p.proposedBy, motif: input.motif } });
      return r;
    }
    // Contrôles rejoués : l'exception et le paiement ont pu changer depuis la proposition.
    const e = this.ctx.treasury.openStatementExceptions((x) => x.id === p.exceptionId)[0];
    if (!e) throw conflict('EXCEPTION_NO_LONGER_OPEN', `L'exception ${p.exceptionId} n'est plus ouverte.`);
    const o = this.ctx.payments.byReference(p.paymentReference);
    const c = o && o.status === 'CONFIRME' ? this.score(e, o) : undefined;
    if (!o || !c?.proposable) throw conflict('MATCH_NO_LONGER_ELIGIBLE', 'L’appariement n’est plus éligible (paiement, compte ou score modifié).');
    const actor = actorOf(user);
    const m = this.ctx.treasury.completeMatch(o.id, {
      debit: 'COMPTE_PUBLIC_RECETTES', description: `Rapprochement proposé ${p.id} (${e.line!.accountAlias}, ${e.statementId ?? '—'}) pour ${o.paymentReference}`,
      actor, details: { matchProposalId: p.id, proposedBy: p.proposedBy, score: c.score, ecartChange: c.fx?.gap ?? null },
    });
    this.ctx.treasury.resolveExceptions([e.id], { resolvedBy: user.id, reference: p.id, motif: `Appariement proposé par ${p.proposedBy} (score ${c.score}/100), confirmé : ${input.motif}` }, actor);
    const r = this.proposals.update({
      ...p, status: 'CONFIRMEE', decidedBy: user.id, decidedAt: at, decisionMotif: input.motif,
      result: { receiptNumber: m.receiptNumber, ledgerEntryId: m.ledgerEntryId, ...(c.fx ? { ecartChange: c.fx.gap } : {}) },
    });
    this.ctx.audit.append({ actor, action: 'reconciliation.match.confirmed', resourceType: 'match_proposal', resourceId: id, details: { proposedBy: p.proposedBy, exceptionId: e.id, paymentReference: o.paymentReference, ledgerEntryId: m.ledgerEntryId, ecartChange: c.fx?.gap ?? null } });
    return r;
  }
}
