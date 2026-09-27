/**
 * Liquidation (moteur de calcul) et obligations (D4).
 * Déterministe : mêmes règle, version, entrées ⇒ même montant. Chaque obligation fige la version de règle
 * appliquée et porte son explication complète (AC-ASS-01). Aucune obligation sans règle exécutable (AC-LEG-01).
 */
import { isRuleExecutable, Money, type MoneyJSON, type ObligationStatus, type RevenueCategory, type TerritorialAttribution } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, isoDate, type Clock } from '../../core/clock.js';
import { notFound, unprocessable, conflict } from '../../core/errors.js';
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
  /** Montant avant exonérations (présent seulement si une exonération s'applique). */
  grossResult?: MoneyJSON;
  /** Exonérations appliquées (registre des exonérations, décision humaine en double validation). */
  adjustments?: AssessmentAdjustment[];
  /** Origine de la liquidation (ex. déclaration déposée). */
  source?: { type: 'DECLARATION'; id: string };
}

/**
 * Réduction appliquée à la liquidation (exonération approuvée en double validation). Le moteur ne décide
 * jamais d'une exonération : il applique une décision humaine datée, fondée sur un instrument du registre.
 */
export interface AssessmentAdjustment {
  kind: 'EXONERATION';
  sourceId: string;
  label: string;
  legalBasis: { instrumentId: string; title: string; article: string };
  /** Pourcentage exonéré (chaîne décimale, 100 = exonération totale). */
  rate: string;
  reduction: MoneyJSON;
  validFrom: string;
  validTo: string;
  decidedBy: string[];
}

/** Fournisseur de réductions (branché par un module d'extension, ex. registre des exonérations). */
export type AssessmentAdjuster = (p: {
  taxpayerId: string; objectId: string; rule: { id: string; code: string; revenueCategory: RevenueCategory }; at: Date; gross: Money;
}) => AssessmentAdjustment[];

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
  rectification?: { supersedes: string; appealId: string; reason: string; decisionType?: 'RECLAMATION' | 'REMISE' | 'CORRECTION_DECLARATION' };
  /** Montant brut et exonérations appliquées (trace dans l'explication). */
  grossAmount?: MoneyJSON;
  adjustments?: AssessmentAdjustment[];
  source?: { type: 'DECLARATION'; id: string };
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

/** Services rendus par le module paiements à la liquidation (sans dépendance circulaire). */
export interface ObligationPaymentHooks {
  paidOn(obligationId: string): Money;
  onSuperseded(originalId: string, rectifiedId: string): void;
}

/** Garde appelée avant toute liquidation réelle ; lève une erreur pour l'empêcher. */
export type LiquidationGuard = (ctx: { user: User; rule: { id: string; code: string; administeringEntity: string; periodicity: string }; objectId: string; taxpayerId: string; at: Date }) => void;

export class AssessmentService {
  private readonly liquidationGuards: LiquidationGuard[] = [];

  /** Enregistre une garde de liquidation (modules d'extension). */
  addLiquidationGuard(g: LiquidationGuard): void {
    this.liquidationGuards.push(g);
  }

  readonly obligations = new InMemoryRepository<Obligation>();
  private readonly ids = new IdGenerator();
  private readonly adjusters: AssessmentAdjuster[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly rules: RuleService,
    private readonly taxpayers: TaxpayerService,
    private readonly objects: ObjectService,
    private readonly ledger: LedgerService,
  ) {}

  /** Branche un fournisseur de réductions (exonérations approuvées). */
  registerAdjuster(fn: AssessmentAdjuster): void {
    this.adjusters.push(fn);
  }

  /** Lien vers le module paiements (branché par lui) : cumul payé et fermeture des références d'une obligation remplacée. */
  private paymentHooks?: ObligationPaymentHooks;

  setPaymentHooks(h: ObligationPaymentHooks): void {
    this.paymentHooks = h;
  }

  /** Montant déjà payé sur une obligation (y compris sur celles qu'elle remplace) ; zéro sans module paiements. */
  paidAmount(id: string): Money {
    return this.paymentHooks?.paidOn(id) ?? Money.zero(this.get(id).amount.currency);
  }

  calculate(user: User, input: CalculateInput): { trace: AssessmentTrace; obligation?: Obligation } {
    authorize(user, input.simulate ? 'assessment.simulate' : 'assessment.liquidate');
    return this.compute(user, input);
  }

  /**
   * Liquidation déclenchée par le dépôt d'une déclaration (procédure déclarative). L'appelant a déjà autorisé
   * le dépôt ; la garde de la règle ACTIVE (AC-LEG-01) reste appliquée ici, sans exception.
   */
  liquidateDeclaration(user: User, input: CalculateInput, declarationId: string): { trace: AssessmentTrace; obligation?: Obligation } {
    return this.compute(user, input, { type: 'DECLARATION', id: declarationId });
  }

  private compute(user: User, input: CalculateInput, source?: { type: 'DECLARATION'; id: string }): { trace: AssessmentTrace; obligation?: Obligation } {
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
    if (!input.simulate) {
      // Jamais de double perception (§ 10A.3) : une règle annuelle ne liquide qu'une obligation par objet et par exercice.
      // Les déclarations périodiques portent leur propre contrôle de période (module fiscal).
      if (rule.periodicity === 'ANNUELLE' && !source) {
        const year = String(now.getUTCFullYear());
        const dup = this.obligations.findOne((o) => o.objectId === object.id && o.ruleCode === rule.code && o.status !== 'ANNULEE' && o.createdAt.startsWith(year));
        if (dup) {
          this.audit.append({ actor, action: 'assessment.liquidation.refused', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED', details: { reason: 'DUPLICATE_OBLIGATION', objectId: object.id, existing: dup.id } });
          throw conflict('DUPLICATE_OBLIGATION', `Une obligation ${rule.code} existe déjà pour cet objet et l'exercice ${year} (${dup.id}) : jamais de double perception.`, { obligationId: dup.id });
        }
      }
      // Gardes des modules d'extension (ex. revendication d'un fait générateur par une seule entité).
      for (const guard of this.liquidationGuards) guard({ user, rule, objectId: object.id, taxpayerId: taxpayer.id, at: now });
    }
    const evaluation = this.rules.evaluate(rule, input.inputs, object.localityRank);
    const gross = Money.of(evaluation.value, rule.currency, rule.rounding);
    if (gross.isNegative()) throw unprocessable('NEGATIVE_ASSESSMENT', 'Le calcul produit un montant négatif ; vérifier la formule.');
    const adjustments = this.adjusters.flatMap((fn) => fn({ taxpayerId: taxpayer.id, objectId: object.id, rule, at: now, gross }));
    let result = gross;
    for (const a of adjustments) {
      const r = Money.fromJSON(a.reduction);
      result = r.compare(result) >= 0 ? Money.zero(result.currency) : result.subtract(r);
    }
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
      ...(adjustments.length ? { grossResult: gross.toJSON(), adjustments } : {}),
      ...(source ? { source } : {}),
    };
    this.audit.append({
      actor, action: input.simulate ? 'assessment.simulated' : 'assessment.calculated', resourceType: 'rule', resourceId: rule.id,
      details: { taxpayerId: taxpayer.id, objectId: object.id, result: trace.result, nonOpposable: trace.nonOpposable, ...(adjustments.length ? { exemptions: adjustments.map((a) => a.sourceId) } : {}), ...(source ? { source } : {}) },
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
      ...(adjustments.length ? { grossAmount: gross.toJSON(), adjustments } : {}),
      ...(source ? { source } : {}),
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
   * sa créance est contrepassée, une nouvelle obligation liée est émise pour le montant rectifié TOTAL ;
   * ce qui a déjà été payé sur l'originale compte pour elle.
   */
  rectify(originalId: string, newAmount: MoneyJSON, ctx: { appealId: string; reason: string; decidedBy: User; decisionType?: 'RECLAMATION' | 'REMISE' | 'CORRECTION_DECLARATION' }): Obligation {
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
      explanation: { ...original.explanation, amount, computedAt: now, rectification: { supersedes: original.id, appealId: ctx.appealId, reason: ctx.reason, ...(ctx.decisionType ? { decisionType: ctx.decisionType } : {}) } },
      trace: { ...original.trace, result: amount, computedAt: now },
      supersedes: original.id,
      appealId: ctx.appealId,
      attribution: original.attribution,
    });
    this.obligations.update({ ...original, status: 'ANNULEE', supersededBy: rectified.id });
    // Les références non payées de l'originale sont fermées ; les paiements déjà reçus sont repris par la
    // rectificative (cumul payé sur la chaîne), qui naît donc partiellement payée ou soldée. Écritures cohérentes :
    // créance = montant rectifié − paiements déjà crédités ; un trop-perçu est signalé pour remboursement.
    this.paymentHooks?.onSuperseded(original.id, rectified.id);
    const paid = this.paidAmount(rectified.id);
    if (!paid.isZero()) {
      return this.setStatus(rectified.id, paid.compare(Money.fromJSON(amount)) >= 0 ? 'SOLDEE' : 'PARTIELLEMENT_PAYEE');
    }
    return rectified;
  }
}
