/**
 * Liquidation (moteur de calcul) et obligations (D4).
 * Déterministe : mêmes règle, version, entrées ⇒ même montant. Chaque obligation fige la version de règle
 * appliquée et porte son explication complète (AC-ASS-01). Aucune obligation sans règle exécutable (AC-LEG-01).
 */
import { isRuleExecutable, Money, type MoneyJSON, type ObligationStatus, type RevenueCategory, type TerritorialAttribution } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, isoDate, type Clock } from '../../core/clock.js';
import { notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import type { ObjectService } from '../objects/service.js';
import type { RuleService } from '../rules/service.js';
import type { LedgerService } from '../treasury/ledger.js';

export interface AssessmentTrace {
  ruleId: string;
  ruleCode: string;
  ruleVersion: number;
  ruleStatus: string;
  legalInstrumentIds: string[];
  formula: string;
  inputs: Record<string, string>;
  rates: Record<string, string>;
  localityRank: number;
  rounding: string;
  rawResult: string;
  result: MoneyJSON;
  computedAt: string;
  simulate: boolean;
  /** Toujours vrai pour une simulation ou une règle non exécutable : aucun effet juridique. */
  nonOpposable: boolean;
  executable: boolean;
  executabilityReason?: string;
}

export interface ObligationExplanation {
  rule: { id: string; code: string; label: string; version: number };
  legalBasis: { id: string; title: string; status: string }[];
  articles: string[];
  competentAuthority: string;
  administeringEntity: string;
  taxableEvent: string;
  liableParty: string;
  baseDefinition: string;
  base: Record<string, string>;
  formula: string;
  rates: Record<string, string>;
  localityRank: number;
  rounding: string;
  amount: MoneyJSON;
  dueDate: string;
  dueRule: string;
  appealPath: string;
  computedAt: string;
  rectification?: { supersedes: string; appealId: string; reason: string };
}

export interface Obligation {
  id: string;
  taxpayerId: string;
  objectId: string;
  ruleId: string;
  ruleCode: string;
  ruleVersion: number;
  revenueCategory: RevenueCategory;
  label: string;
  entity: string;
  beneficiaryAccountAlias: string;
  amount: MoneyJSON;
  status: ObligationStatus;
  dueDate: string;
  createdAt: string;
  createdBy: string;
  explanation: ObligationExplanation;
  trace: AssessmentTrace;
  ledgerEntryId?: string;
  supersedes?: string;
  supersededBy?: string;
  appealId?: string;
  /** Commune du fait générateur (lieu de l'objet), figée à la liquidation (§ 20.3). */
  attribution: TerritorialAttribution;
}

export interface CalculateInput {
  ruleId: string;
  taxpayerId: string;
  objectId: string;
  inputs: Record<string, string>;
  simulate: boolean;
}

export const PAYABLE_STATUSES: ObligationStatus[] = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];

export class AssessmentService {
  readonly obligations = new InMemoryRepository<Obligation>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly rules: RuleService,
    private readonly taxpayers: TaxpayerService,
    private readonly objects: ObjectService,
    private readonly ledger: LedgerService,
  ) {}

  calculate(user: User, input: CalculateInput): { trace: AssessmentTrace; obligation?: Obligation } {
    authorize(user, input.simulate ? 'assessment.simulate' : 'assessment.liquidate');
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    const rule = this.rules.get(input.ruleId);
    const taxpayer = this.taxpayers.get(input.taxpayerId);
    const object = this.objects.get(input.objectId);
    if (object.taxpayerId !== taxpayer.id) {
      throw unprocessable('OBJECT_TAXPAYER_MISMATCH', `L'objet ${object.id} n'est pas rattaché au contribuable ${taxpayer.id}.`);
    }
    const now = this.clock.now();
    const exec = isRuleExecutable(rule, now);
    if (!input.simulate && !exec.ok) {
      // AC-LEG-01 : aucune obligation, tentative journalisée.
      this.audit.append({
        actor, action: 'assessment.liquidation.refused', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED',
        details: { reason: exec.reason, status: rule.status, taxpayerId: taxpayer.id, objectId: object.id },
      });
      throw unprocessable('RULE_NOT_EXECUTABLE', `Règle ${rule.code} v${rule.version} non exécutable : ${exec.reason}.`, { ruleStatus: rule.status, reason: exec.reason });
    }
    const evaluation = this.rules.evaluate(rule, input.inputs, object.localityRank);
    const result = Money.of(evaluation.value, rule.currency, rule.rounding);
    if (result.isNegative()) throw unprocessable('NEGATIVE_ASSESSMENT', 'Le calcul produit un montant négatif ; vérifier la formule.');
    const trace: AssessmentTrace = {
      ruleId: rule.id,
      ruleCode: rule.code,
      ruleVersion: rule.version,
      ruleStatus: rule.status,
      legalInstrumentIds: rule.legalInstrumentIds,
      formula: rule.formula,
      inputs: evaluation.inputs,
      rates: evaluation.rates,
      localityRank: object.localityRank,
      rounding: rule.rounding,
      rawResult: evaluation.value,
      result: result.toJSON(),
      computedAt: now.toISOString(),
      simulate: input.simulate,
      nonOpposable: input.simulate || !exec.ok,
      executable: exec.ok,
      ...(exec.ok ? {} : { executabilityReason: exec.reason }),
    };
    this.audit.append({
      actor, action: input.simulate ? 'assessment.simulated' : 'assessment.calculated', resourceType: 'rule', resourceId: rule.id,
      details: { taxpayerId: taxpayer.id, objectId: object.id, result: trace.result, nonOpposable: trace.nonOpposable },
    });
    if (input.simulate) return { trace };

    const dueDate = isoDate(new Date(now.getTime() + 30 * DAY_MS));
    const explanation: ObligationExplanation = {
      rule: { id: rule.id, code: rule.code, label: rule.label, version: rule.version },
      legalBasis: rule.legalInstrumentIds.map((id) => {
        const inst = this.rules.instrument(id);
        return { id, title: inst?.title ?? id, status: inst?.status ?? 'INCONNU' };
      }),
      articles: rule.articles,
      competentAuthority: rule.competentAuthority,
      administeringEntity: rule.administeringEntity,
      taxableEvent: rule.taxableEvent,
      liableParty: rule.liableParty,
      baseDefinition: rule.baseDefinition,
      base: evaluation.inputs,
      formula: rule.formula,
      rates: evaluation.rates,
      localityRank: object.localityRank,
      rounding: rule.rounding,
      amount: result.toJSON(),
      dueDate,
      dueRule: rule.dueRule,
      appealPath: rule.appealPath,
      computedAt: now.toISOString(),
    };
    const obligation = this.issue({
      taxpayerId: taxpayer.id, objectId: object.id, rule, amount: result.toJSON(), dueDate, createdBy: user.id, explanation, trace,
    });
    return { trace, obligation };
  }

  /**
   * Règle d'attribution (§ 20.3) : commune où se situe l'objet taxé, jamais l'adresse du contribuable.
   * Objet sans commune établie ⇒ NON_LOCALISE (commune null), sans aucune déduction.
   */
  private attributeFromObject(objectId: string, now: Date): TerritorialAttribution {
    const o = this.objects.get(objectId);
    const commune = typeof o.commune === 'string' && o.commune.trim() ? o.commune.trim() : null;
    return commune
      ? { commune, ...(o.quartier ? { quartier: o.quartier } : {}), basis: 'LIEU_OBJET', sourceId: o.id, attributedAt: now.toISOString() }
      : { commune: null, basis: 'NON_LOCALISE', sourceId: o.id, attributedAt: now.toISOString() };
  }

  private issue(p: {
    taxpayerId: string; objectId: string; rule: { id: string; code: string; version: number; revenueCategory: RevenueCategory; label: string; administeringEntity: string; beneficiaryAccountAlias: string; currency: string };
    amount: MoneyJSON; dueDate: string; createdBy: string; explanation: ObligationExplanation; trace: AssessmentTrace; supersedes?: string; appealId?: string;
    /** Repris tel quel lors d'une rectification : le fait générateur n'a pas changé de lieu. */
    attribution?: TerritorialAttribution;
  }): Obligation {
    const now = this.clock.now();
    const attribution = p.attribution ?? this.attributeFromObject(p.objectId, now);
    const id = this.ids.next(`OBL-${now.getUTCFullYear()}-${p.rule.code}`);
    const zero = Money.fromJSON(p.amount).isZero();
    const ledgerEntry = zero
      ? undefined
      : this.ledger.postPair({
          eventType: 'ASSESSMENT', description: `Émission de l'obligation ${id}`, sourceType: 'obligation', sourceId: id,
          debit: 'CREANCES_CONTRIBUABLES', credit: 'RECETTES_CONSTATEES', amount: p.amount,
        });
    const obligation = this.obligations.insert({
      id,
      taxpayerId: p.taxpayerId,
      objectId: p.objectId,
      ruleId: p.rule.id,
      ruleCode: p.rule.code,
      ruleVersion: p.rule.version,
      revenueCategory: p.rule.revenueCategory,
      label: p.rule.label,
      entity: p.rule.administeringEntity,
      beneficiaryAccountAlias: p.rule.beneficiaryAccountAlias,
      amount: p.amount,
      status: zero ? 'SOLDEE' : 'EMISE',
      dueDate: p.dueDate,
      createdAt: now.toISOString(),
      createdBy: p.createdBy,
      explanation: p.explanation,
      trace: p.trace,
      ...(ledgerEntry ? { ledgerEntryId: ledgerEntry.id } : {}),
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      ...(p.appealId ? { appealId: p.appealId } : {}),
      attribution,
    });
    this.audit.append({
      actor: { kind: 'system', id: 'moteur-liquidation' }, action: p.supersedes ? 'assessment.rectified' : 'assessment.issued',
      resourceType: 'obligation', resourceId: id, details: { ruleId: p.rule.id, ruleVersion: p.rule.version, amount: p.amount, supersedes: p.supersedes ?? null, commune: attribution.commune, attributionBasis: attribution.basis },
    });
    const tp = this.taxpayers.get(p.taxpayerId);
    this.comms.publish(p.supersedes ? 'assessment.rectified' : 'assessment.issued', [taxpayerRecipient(tp)], { reference: id }, { entity: p.rule.administeringEntity });
    return obligation;
  }

  get(id: string): Obligation {
    const o = this.obligations.get(id);
    if (!o) throw notFound('OBLIGATION_NOT_FOUND', `Obligation inconnue : ${id}`);
    return o;
  }

  byTaxpayer(taxpayerId: string): Obligation[] {
    return this.obligations.find((o) => o.taxpayerId === taxpayerId);
  }

  /** Changement d'état d'une obligation (jamais de suppression). */
  setStatus(id: string, status: ObligationStatus): Obligation {
    const o = this.get(id);
    return this.obligations.update({ ...o, status });
  }

  /**
   * Obligation rectificative (décision sur réclamation) : l'originale est conservée au statut ANNULEE,
   * sa créance est contrepassée, une nouvelle obligation liée est émise.
   */
  rectify(originalId: string, newAmount: MoneyJSON, ctx: { appealId: string; reason: string; decidedBy: User }): Obligation {
    const original = this.get(originalId);
    const rule = this.rules.get(original.ruleId);
    if (original.ledgerEntryId && !this.ledger.isReversed(original.ledgerEntryId)) {
      this.ledger.reverse(original.ledgerEntryId, `Rectification sur réclamation ${ctx.appealId}`, { kind: 'user', id: ctx.decidedBy.id, roles: ctx.decidedBy.roles });
    }
    const now = this.clock.now().toISOString();
    const amount = Money.fromJSON(newAmount).toJSON();
    const rectified = this.issue({
      taxpayerId: original.taxpayerId,
      objectId: original.objectId,
      rule,
      amount,
      dueDate: original.dueDate,
      createdBy: ctx.decidedBy.id,
      explanation: { ...original.explanation, amount, computedAt: now, rectification: { supersedes: original.id, appealId: ctx.appealId, reason: ctx.reason } },
      trace: { ...original.trace, result: amount, computedAt: now },
      supersedes: original.id,
      appealId: ctx.appealId,
      attribution: original.attribution,
    });
    this.obligations.update({ ...original, status: 'ANNULEE', supersededBy: rectified.id });
    return rectified;
  }
}
