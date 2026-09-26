/**
 * Recalcul contrôlé après une nouvelle version de règle (§ 6.2, § 11.2, module 27 — C1-157, C1-344, M27-F5) :
 *  1. SIMULATION d'impact (aucun effet) : liste des obligations touchées, ancien et nouveau montant, sens de l'écart ;
 *  2. DÉCISION motivée d'une personne distincte de l'auteur de la simulation (direction de la régie) ;
 *  3. APPLICATION par obligation rectificative : l'originale est conservée (ANNULEE + contre-écriture), jamais écrasée.
 * Non-rétroactivité : une obligation émise avant la date d'effet de la nouvelle version n'est pas touchée ;
 * une hausse en défaveur du contribuable n'est jamais appliquée sans acte autorisant la rétroactivité.
 */
import { isRuleExecutable, Money, type MoneyJSON, type ObligationStatus } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { isoDate } from '../../core/clock.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { Obligation } from '../assessment/service.js';
import type { RuleRecord } from './service.js';

export type RecalcDirection = 'FAVORABLE' | 'DEFAVORABLE' | 'NEUTRE';

export interface RecalcLine {
  obligationId: string;
  taxpayerId: string;
  objectId: string;
  fromRuleId: string;
  fromVersion: number;
  obligationStatus: ObligationStatus;
  issuedOn: string;
  oldAmount: MoneyJSON;
  newAmount?: MoneyJSON;
  delta?: MoneyJSON;
  direction?: RecalcDirection;
  treatment: 'A_APPLIQUER' | 'EXCLUE';
  reason?: string;
}

export interface Recalculation {
  id: string;
  ruleId: string;
  ruleCode: string;
  toVersion: number;
  entity: string;
  simulatedBy: string;
  simulatedAt: string;
  status: 'SIMULEE' | 'APPLIQUEE' | 'REJETEE';
  /** Toujours vrai tant qu'aucune décision n'a été appliquée. */
  nonOpposable: boolean;
  retroactivityAuthorized: boolean;
  lines: RecalcLine[];
  totals: { examined: number; toApply: number; excluded: number; favorable: number; defavorable: number; deltaToApply: MoneyJSON | null };
  decision?: {
    decision: 'APPLIQUER' | 'REJETER';
    reason: string;
    by: string;
    at: string;
    applied: { from: string; to: string }[];
    skipped: { obligationId: string; reason: string }[];
  };
}

const RECALCULABLE: ObligationStatus[] = ['EMISE', 'EXIGIBLE', 'EN_RETARD'];

const EXCLUSION_BY_STATUS: Partial<Record<ObligationStatus, string>> = {
  SOLDEE: 'Obligation soldée : tout remboursement relève d’une décision distincte.',
  PARTIELLEMENT_PAYEE: 'Paiement partiel enregistré : traitement individuel requis.',
  CONTESTEE: 'Réclamation en cours : traitement par le circuit de recours.',
  ANNULEE: 'Obligation annulée.',
  ADMISE_EN_NON_VALEUR: 'Admise en non-valeur.',
};

export class RecalculationService {
  readonly recalculations = new InMemoryRepository<Recalculation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  get(id: string): Recalculation {
    const r = this.recalculations.get(id);
    if (!r) throw notFound('RECALCULATION_NOT_FOUND', `Recalcul inconnu : ${id}`);
    return r;
  }

  list(ruleId?: string): Recalculation[] {
    return this.recalculations.find((r) => !ruleId || r.ruleId === ruleId).sort((a, b) => b.simulatedAt.localeCompare(a.simulatedAt));
  }

  /** Examine une obligation d'une version antérieure au regard de la nouvelle version. */
  private examine(rule: RuleRecord, o: Obligation): RecalcLine {
    const base = {
      obligationId: o.id, taxpayerId: o.taxpayerId, objectId: o.objectId, fromRuleId: o.ruleId, fromVersion: o.ruleVersion,
      obligationStatus: o.status, issuedOn: o.createdAt.slice(0, 10), oldAmount: o.amount,
    };
    if (!RECALCULABLE.includes(o.status)) {
      return { ...base, treatment: 'EXCLUE', reason: EXCLUSION_BY_STATUS[o.status] ?? `Statut ${o.status} : hors recalcul.` };
    }
    if (base.issuedOn < rule.effectiveFrom && !rule.retroactivity) {
      return { ...base, treatment: 'EXCLUE', reason: `Émise le ${base.issuedOn}, avant la date d’effet (${rule.effectiveFrom}) : l’ancienne version reste applicable (non-rétroactivité).` };
    }
    if (o.amount.currency !== rule.currency) {
      return { ...base, treatment: 'EXCLUE', reason: `Devise différente (${o.amount.currency} → ${rule.currency}) : recalcul individuel requis.` };
    }
    let newMoney: Money;
    try {
      const ev = this.ctx.rules.evaluate(rule, o.trace.inputs, o.trace.localityRank);
      newMoney = Money.of(ev.value, rule.currency, rule.rounding);
    } catch (e) {
      return { ...base, treatment: 'EXCLUE', reason: `Recalcul impossible : ${(e as Error).message}` };
    }
    if (newMoney.isNegative()) return { ...base, treatment: 'EXCLUE', reason: 'Le recalcul produit un montant négatif.' };
    const old = Money.fromJSON(o.amount);
    const delta = newMoney.subtract(old);
    const direction: RecalcDirection = delta.isZero() ? 'NEUTRE' : delta.isNegative() ? 'FAVORABLE' : 'DEFAVORABLE';
    const line = { ...base, newAmount: newMoney.toJSON(), delta: delta.toJSON(), direction };
    if (direction === 'NEUTRE') return { ...line, treatment: 'EXCLUE', reason: 'Aucun écart.' };
    if (direction === 'DEFAVORABLE' && !rule.retroactivity) {
      return { ...line, treatment: 'EXCLUE', reason: 'Hausse en défaveur du contribuable sur une obligation déjà établie : aucun acte n’autorise la rétroactivité.' };
    }
    return { ...line, treatment: 'A_APPLIQUER' };
  }

  simulate(user: User, ruleId: string): Recalculation {
    authorize(user, 'rules:recalc.simulate');
    const rule = this.ctx.rules.get(ruleId);
    if (!rule.supersedesVersionId) throw unprocessable('NOT_A_NEW_VERSION', 'La simulation d’impact porte sur une nouvelle version d’une règle existante.');
    if (!['APPROUVEE', 'PUBLIEE', 'ACTIVE'].includes(rule.status)) {
      throw conflict('INVALID_RULE_STATE', `Simulation possible sur une version approuvée, publiée ou active (statut ${rule.status}).`);
    }
    const previousIds = new Set(this.ctx.rules.rules.find((r) => r.code === rule.code && r.version < rule.version).map((r) => r.id));
    const obligations = this.ctx.assessment.obligations.find((o) => previousIds.has(o.ruleId) && !o.supersededBy);
    const lines = obligations.map((o) => this.examine(rule, o));
    const rec = this.recalculations.insert({
      id: this.ids.next(`RECALC-${rule.code}-v${rule.version}`, 4),
      ruleId: rule.id, ruleCode: rule.code, toVersion: rule.version, entity: rule.administeringEntity,
      simulatedBy: user.id, simulatedAt: this.ctx.clock.now().toISOString(), status: 'SIMULEE', nonOpposable: true,
      retroactivityAuthorized: !!rule.retroactivity, lines, totals: this.totals(lines, rule.currency),
    });
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.recalculation.simulated', resourceType: 'rule', resourceId: rule.id,
      details: { recalculationId: rec.id, examined: lines.length, toApply: rec.totals.toApply },
    });
    return rec;
  }

  private totals(lines: RecalcLine[], currency: RuleRecord['currency']): Recalculation['totals'] {
    const toApply = lines.filter((l) => l.treatment === 'A_APPLIQUER');
    let delta: Money | null = null;
    for (const l of toApply) {
      if (!l.delta) continue;
      const d = Money.fromJSON(l.delta);
      if (d.currency !== currency) continue;
      delta = delta ? delta.add(d) : d;
    }
    return {
      examined: lines.length,
      toApply: toApply.length,
      excluded: lines.length - toApply.length,
      favorable: lines.filter((l) => l.direction === 'FAVORABLE').length,
      defavorable: lines.filter((l) => l.direction === 'DEFAVORABLE').length,
      deltaToApply: delta ? delta.toJSON() : null,
    };
  }

  /** Décision motivée : APPLIQUER (obligations rectificatives) ou REJETER. Décideur ≠ auteur de la simulation. */
  decide(user: User, id: string, input: { decision: 'APPLIQUER' | 'REJETER'; reason: string }): Recalculation {
    const rec = this.get(id);
    authorize(user, 'rules:recalc.decide', { entity: rec.entity });
    if (rec.status !== 'SIMULEE') throw conflict('RECALCULATION_ALREADY_DECIDED', `Recalcul déjà traité (${rec.status}).`);
    assertDistinctPerson(user.id, [rec.simulatedBy], 'La décision d’appliquer un recalcul appartient à une personne distincte de l’auteur de la simulation.');
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    const now = this.ctx.clock.now().toISOString();
    if (input.decision === 'REJETER') {
      const updated = this.recalculations.update({ ...rec, status: 'REJETEE', decision: { decision: 'REJETER', reason: input.reason, by: user.id, at: now, applied: [], skipped: [] } });
      this.ctx.audit.append({ actor, action: 'rule.recalculation.rejected', resourceType: 'rule', resourceId: rec.ruleId, details: { recalculationId: id, reason: input.reason } });
      return updated;
    }
    const rule = this.ctx.rules.get(rec.ruleId);
    const exec = isRuleExecutable(rule, this.ctx.clock.now());
    if (!exec.ok) {
      this.ctx.audit.append({ actor, action: 'rule.recalculation.refused', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED', details: { recalculationId: id, reason: exec.reason } });
      throw unprocessable('RULE_NOT_EXECUTABLE', `La nouvelle version doit être ACTIVE pour être appliquée : ${exec.reason}.`, { ruleStatus: rule.status });
    }
    const applied: { from: string; to: string }[] = [];
    const skipped: { obligationId: string; reason: string }[] = [];
    for (const line of rec.lines.filter((l) => l.treatment === 'A_APPLIQUER')) {
      const o = this.ctx.assessment.obligations.get(line.obligationId);
      // Contrôle de fraîcheur : l'obligation peut avoir changé depuis la simulation (paiement, réclamation…).
      const fresh = o && !o.supersededBy ? this.examine(rule, o) : undefined;
      if (!o || !fresh || fresh.treatment !== 'A_APPLIQUER' || !fresh.newAmount || fresh.newAmount.amount !== line.newAmount?.amount) {
        skipped.push({ obligationId: line.obligationId, reason: fresh?.reason ?? 'Obligation modifiée depuis la simulation : nouvelle simulation requise.' });
        continue;
      }
      const rectified = this.ctx.assessment.rectify(o.id, fresh.newAmount, {
        appealId: id, reason: `Recalcul contrôlé ${rule.code} v${rule.version} — ${input.reason}`, decidedBy: user,
      });
      // La nouvelle obligation porte la version de règle appliquée (explication complète).
      const ev = this.ctx.rules.evaluate(rule, o.trace.inputs, o.trace.localityRank);
      const current = this.ctx.assessment.obligations.get(rectified.id)!;
      this.ctx.assessment.obligations.update({
        ...current,
        ruleId: rule.id, ruleCode: rule.code, ruleVersion: rule.version, label: rule.label, beneficiaryAccountAlias: rule.beneficiaryAccountAlias,
        explanation: {
          ...current.explanation,
          rule: { id: rule.id, code: rule.code, label: rule.label, version: rule.version },
          legalBasis: rule.legalInstrumentIds.map((iid) => {
            const inst = this.ctx.rules.instrument(iid);
            return { id: iid, title: inst?.title ?? iid, status: inst?.status ?? 'INCONNU' };
          }),
          articles: rule.articles, formula: rule.formula, rates: ev.rates, rounding: rule.rounding, dueRule: rule.dueRule, appealPath: rule.appealPath,
        },
        trace: { ...current.trace, ruleId: rule.id, ruleCode: rule.code, ruleVersion: rule.version, ruleStatus: rule.status, formula: rule.formula, rates: ev.rates, rawResult: ev.value, legalInstrumentIds: rule.legalInstrumentIds },
      });
      applied.push({ from: o.id, to: rectified.id });
    }
    const updated = this.recalculations.update({
      ...rec, status: 'APPLIQUEE', nonOpposable: false,
      decision: { decision: 'APPLIQUER', reason: input.reason, by: user.id, at: now, applied, skipped },
    });
    this.ctx.audit.append({
      actor, action: 'rule.recalculation.applied', resourceType: 'rule', resourceId: rule.id,
      details: { recalculationId: id, reason: input.reason, applied: applied.length, skipped: skipped.length, at: isoDate(this.ctx.clock.now()) },
    });
    return updated;
  }
}

const services = new WeakMap<AppContext, RecalculationService>();

/** Service de recalcul rattaché au contexte (une instance par application). */
export function recalculationsFor(ctx: AppContext): RecalculationService {
  let s = services.get(ctx);
  if (!s) {
    s = new RecalculationService(ctx);
    services.set(ctx, s);
  }
  return s;
}
