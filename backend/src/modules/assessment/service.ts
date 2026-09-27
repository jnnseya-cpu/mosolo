/**
 * Liquidation (moteur de calcul) et obligations (D4).
 * Déterministe : mêmes règle, version, entrées ⇒ même montant. Chaque obligation fige la version de règle
 * appliquée et porte son explication complète (AC-ASS-01). Aucune obligation sans règle exécutable (AC-LEG-01).
 */
import { effectiveDue, isRuleExecutable, Money, type MoneyJSON, type ObligationStatus, type RevenueCategory, type TerritorialAttribution } from '@mosolo/shared';
import { isRuleExecutable, Money, refusParCategorie, type MoneyJSON, type ObligationStatus, type RevenueCategory, type TerritorialAttribution } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate, type Clock } from '../../core/clock.js';
import { badRequest, notFound, unprocessable, conflict } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import { rankConfirmed, type FiscalObject, type ObjectService } from '../objects/service.js';
import type { RuleService } from '../rules/service.js';
import type { LedgerService } from '../treasury/ledger.js';
import { recordReductionGranted, scaledDecimal } from './reductions.js';

/** Approbation d'une base inférieure aux données connues de l'objet : hiérarchie de la régie, jamais le liquidateur. */
definePolicy('assessment:base-override.approve', { R06: GRANTS.always, R07: GRANTS.always });

/**
 * Tolérance (valeur de conception À VÉRIFIER) : une base saisie inférieure de plus de 5 % à la valeur connue de
 * l'objet (dernier constat terrain, sinon attribut déclaré) exige un motif et une seconde approbation.
 */
export const BASE_OVERRIDE_TOLERANCE_PCT = 5;

/** Demande de dérogation à la base connue (saisie inférieure au-delà de la tolérance). */
export interface BaseOverrideRequest {
  id: string;
  ruleId: string;
  taxpayerId: string;
  objectId: string;
  inputs: Record<string, string>;
  /** Valeurs de référence de l'objet au moment de la demande, par champ abaissé. */
  lowered: { field: string; reference: string; referenceSource: 'CONSTAT' | 'ATTRIBUT'; declared: string }[];
  motive: string;
  requestedBy: string;
  requestedAt: string;
  status: 'DEMANDEE' | 'APPROUVEE' | 'REFUSEE' | 'UTILISEE';
  decision?: { by: string; at: string; reason: string; approved: boolean };
  usedByObligationId?: string;
}

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
  /** Entrées pré-remplies depuis l'objet (dernier constat terrain ou attribut), par champ. */
  prefilled?: Record<string, { value: string; source: 'CONSTAT' | 'ATTRIBUT' }>;
  /** Dérogation approuvée à la base connue de l'objet. */
  baseOverride?: { requestId: string; approvedBy: string; lowered: BaseOverrideRequest['lowered'] };
  /** Rang de localité provisoire (non confirmé) utilisé par un taux dépendant du rang. */
  provisionalRank?: boolean;
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
  rectification?: { supersedes: string; appealId: string; reason: string; decisionType?: RectificationType };
  /** Montant brut et exonérations appliquées (trace dans l'explication). */
  grossAmount?: MoneyJSON;
  adjustments?: AssessmentAdjustment[];
  source?: { type: 'DECLARATION'; id: string };
}

/** Nature de la décision à l'origine d'une obligation rectificative. */
export type RectificationType = 'RECLAMATION' | 'REMISE' | 'CORRECTION_DECLARATION' | 'REEVALUATION';

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
  /**
   * Liquidée sur un rang de localité PROVISOIRE (déclaré, non confirmé) : réévaluée automatiquement à la validation
   * de l'objet (rang confirmé par une personne distincte du déclarant) ou à sa correction en double validation.
   */
  reassessmentRequired?: { reason: 'RANG_PROVISOIRE'; provisionalRank: number; flaggedAt: string };
}

export interface CalculateInput {
  ruleId: string;
  taxpayerId: string;
  objectId: string;
  inputs: Record<string, string>;
  simulate: boolean;
  /** Dérogation approuvée (base inférieure aux données connues de l'objet au-delà de la tolérance). */
  baseOverrideId?: string;
}

export const PAYABLE_STATUSES: ObligationStatus[] = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];

/** Statuts qui ferment les références de paiement actives (soldée, annulée ou réduite à zéro, admise en non-valeur). */
export const ORDER_CLOSING_STATUSES: ObligationStatus[] = ['SOLDEE', 'ANNULEE', 'ADMISE_EN_NON_VALEUR'];

/** Services rendus par le module paiements à la liquidation (sans dépendance circulaire). */
export interface ObligationPaymentHooks {
  paidOn(obligationId: string): Money;
  onSuperseded(originalId: string, rectifiedId: string): void;
  /** Obligation devenue non payable : ses références INITIE sont fermées (paiement tardif ⇒ non affecté). */
  onClosed?(obligationId: string, status: ObligationStatus): void;
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
  readonly baseOverrides = new InMemoryRepository<BaseOverrideRequest>();
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
    // Séparation des compétences (§ 6.3, § 6.11) : ACTE_REQUIS jamais liquidée, RECETTE_CENTRALE exclue, RECETTE_ETD
    // non liquidée par la province. La simulation reste possible (non opposable).
    const refusal = input.simulate ? null : refusParCategorie(rule.revenueCategory, user.entity);
    if (refusal) {
      this.audit.append({
        actor, action: 'assessment.liquidation.refused', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED',
        details: { reason: refusal.code, category: rule.revenueCategory, entity: user.entity, taxpayerId: taxpayer.id, objectId: object.id },
      });
      throw unprocessable(refusal.code, `Règle ${rule.code} v${rule.version} : ${refusal.detail}`, { category: rule.revenueCategory });
    }
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
    // Base : pré-remplie depuis l'objet (dernier constat terrain, sinon attribut déclaré). Une saisie inférieure
    // au-delà de la tolérance exige une dérogation motivée, approuvée par une seconde personne (liquidation directe ;
    // la procédure déclarative porte sa propre vérification des corrections à la baisse).
    const base = this.baseFromObject(rule, object, input.inputs);
    let override: BaseOverrideRequest | undefined;
    if (!input.simulate && !source && base.lowered.length) override = this.checkOverride(user, input, base);
    const evaluation = this.rules.evaluate(rule, base.inputs, object.localityRank);
    // Rang de localité non confirmé utilisé par un taux dépendant du rang : obligation à réévaluer à la validation.
    const provisionalRank = !rankConfirmed(object) && Object.keys(evaluation.rates).some((k) => k.includes(':'));
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
      ...(Object.keys(base.prefilled).length ? { prefilled: base.prefilled } : {}),
      ...(override ? { baseOverride: { requestId: override.id, approvedBy: override.decision!.by, lowered: override.lowered } } : {}),
      ...(provisionalRank ? { provisionalRank: true } : {}),
    };
    this.audit.append({
      actor, action: input.simulate ? 'assessment.simulated' : 'assessment.calculated', resourceType: 'rule', resourceId: rule.id,
      details: { taxpayerId: taxpayer.id, objectId: object.id, result: trace.result, nonOpposable: trace.nonOpposable, ...(adjustments.length ? { exemptions: adjustments.map((a) => a.sourceId) } : {}), ...(source ? { source } : {}) },
    });
    if (input.simulate) return { trace };

    const dueDate = kinshasaDate(new Date(now.getTime() + 30 * DAY_MS));
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
      ...(provisionalRank ? { reassessmentRequired: { reason: 'RANG_PROVISOIRE' as const, provisionalRank: object.localityRank, flaggedAt: now.toISOString() } } : {}),
    });
    if (provisionalRank) {
      this.audit.append({ actor, action: 'assessment.reassessment_required', resourceType: 'obligation', resourceId: obligation.id, details: { objectId: object.id, provisionalRank: object.localityRank, reason: 'RANG_PROVISOIRE' } });
    }
    if (override) {
      this.baseOverrides.update({ ...override, status: 'UTILISEE', usedByObligationId: obligation.id });
      this.audit.append({
        actor, action: 'assessment.base_override', resourceType: 'obligation', resourceId: obligation.id,
        details: { requestId: override.id, requestedBy: override.requestedBy, approvedBy: override.decision!.by, motive: override.motive, lowered: override.lowered, taxpayerId: taxpayer.id, objectId: object.id },
      });
    }
    if (adjustments.length) {
      // Exonération appliquée à la liquidation : réduction tracée (brut → net) pour le rapport des réductions.
      const deciders = adjustments.flatMap((a) => a.decidedBy);
      recordReductionGranted(this.audit, { kind: 'system', id: 'moteur-liquidation' }, {
        path: 'EXONERATION_LIQUIDATION', obligationId: obligation.id, fromAmount: gross.toJSON(), toAmount: result.toJSON(),
        deciderId: deciders[deciders.length - 1] ?? 'inconnu', taxpayerId: taxpayer.id, sourceId: adjustments.map((a) => a.sourceId).join(','), approvers: [...new Set(deciders)],
      });
    }
    return { trace, obligation };
  }

  /** Valeur connue d'un champ de base : dernier constat terrain, sinon attribut déclaré (décimal uniquement). */
  static referenceOf(object: FiscalObject, name: string): { value: string; source: 'CONSTAT' | 'ATTRIBUT' } | undefined {
    const asDecimal = (v: unknown): string | undefined => {
      const s = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : typeof v === 'string' ? v.trim() : undefined;
      return s !== undefined && scaledDecimal(s) !== null ? s : undefined;
    };
    const observed = asDecimal(object.observed?.[name]);
    if (observed !== undefined) return { value: observed, source: 'CONSTAT' };
    const declared = asDecimal(object.attributes?.[name]);
    return declared !== undefined ? { value: declared, source: 'ATTRIBUT' } : undefined;
  }

  /** Entrées de la formule complétées depuis l'objet ; champs saisis en deçà de la tolérance. */
  baseFromObject(rule: Parameters<RuleService['requiredInputs']>[0], object: FiscalObject, given: Record<string, string>) {
    const inputs: Record<string, string> = { ...given };
    const prefilled: Record<string, { value: string; source: 'CONSTAT' | 'ATTRIBUT' }> = {};
    const lowered: BaseOverrideRequest['lowered'] = [];
    for (const name of this.rules.requiredInputs(rule)) {
      const ref = AssessmentService.referenceOf(object, name);
      if (!ref) continue;
      if (inputs[name] === undefined) { inputs[name] = ref.value; prefilled[name] = ref; continue; }
      const d = scaledDecimal(inputs[name]!);
      const r = scaledDecimal(ref.value);
      if (d === null || r === null) continue;
      if (d * 100n < r * BigInt(100 - BASE_OVERRIDE_TOLERANCE_PCT)) {
        lowered.push({ field: name, reference: ref.value, referenceSource: ref.source, declared: inputs[name]! });
      }
    }
    return { inputs, prefilled, lowered };
  }

  /** Contrôle de la dérogation à la base : approuvée, par une autre personne, pour exactement ces entrées. */
  private checkOverride(user: User, input: CalculateInput, base: { inputs: Record<string, string>; lowered: BaseOverrideRequest['lowered'] }): BaseOverrideRequest {
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    const refuse = (detail: string, extra: Record<string, unknown> = {}) => {
      this.audit.append({ actor, action: 'assessment.base_override.refused', resourceType: 'rule', resourceId: input.ruleId, outcome: 'DENIED', details: { objectId: input.objectId, taxpayerId: input.taxpayerId, lowered: base.lowered, ...extra } });
      return unprocessable('BASE_OVERRIDE_REQUIRES_APPROVAL', detail, { lowered: base.lowered, ...extra });
    };
    const fields = base.lowered.map((l) => `${l.field} saisi ${l.declared} < connu ${l.reference} (${l.referenceSource === 'CONSTAT' ? 'constat terrain' : 'attribut de l’objet'})`).join(' ; ');
    if (!input.baseOverrideId) {
      throw refuse(`Base inférieure de plus de ${BASE_OVERRIDE_TOLERANCE_PCT} % aux données connues de l'objet (${fields}) : motif et seconde approbation requis (POST /v1/assessments/base-overrides).`);
    }
    const req = this.baseOverrides.get(input.baseOverrideId);
    if (!req) throw refuse(`Dérogation inconnue : ${input.baseOverrideId}.`);
    if (req.status !== 'APPROUVEE') throw refuse(`Dérogation ${req.id} au statut ${req.status} : seule une dérogation approuvée et non utilisée est admise.`, { requestId: req.id });
    const same = req.ruleId === input.ruleId && req.objectId === input.objectId && req.taxpayerId === input.taxpayerId
      && Object.keys(base.inputs).every((k) => req.inputs[k] === base.inputs[k]) && Object.keys(req.inputs).every((k) => req.inputs[k] === base.inputs[k]);
    if (!same) throw refuse(`La dérogation ${req.id} ne porte pas sur ces entrées, cet objet ou cette règle.`, { requestId: req.id });
    assertDistinctPerson(user.id, [req.decision!.by], 'Quatre yeux : l’approbateur de la dérogation ne liquide pas lui-même.');
    return req;
  }

  /** Demande motivée de dérogation (base inférieure aux données connues de l'objet). */
  requestBaseOverride(user: User, input: { ruleId: string; taxpayerId: string; objectId: string; inputs: Record<string, string>; motive: string }): BaseOverrideRequest {
    authorize(user, 'assessment.liquidate');
    if (input.motive.trim().length < 10) throw badRequest('MOTIVE_REQUIRED', 'Motif d’au moins 10 caractères requis.');
    const rule = this.rules.get(input.ruleId);
    const object = this.objects.get(input.objectId);
    if (object.taxpayerId !== input.taxpayerId) throw unprocessable('OBJECT_TAXPAYER_MISMATCH', `L'objet ${object.id} n'est pas rattaché au contribuable ${input.taxpayerId}.`);
    this.rules.assertInputsAllowed(rule, input.inputs);
    const base = this.baseFromObject(rule, object, input.inputs);
    if (!base.lowered.length) throw unprocessable('BASE_OVERRIDE_NOT_NEEDED', 'Les entrées ne sont pas inférieures aux données connues au-delà de la tolérance : aucune dérogation nécessaire.');
    const req = this.baseOverrides.insert({
      id: this.ids.next('DERO', 6), ruleId: rule.id, taxpayerId: input.taxpayerId, objectId: object.id, inputs: base.inputs, lowered: base.lowered,
      motive: input.motive.trim(), requestedBy: user.id, requestedAt: this.clock.now().toISOString(), status: 'DEMANDEE',
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'assessment.base_override.requested', resourceType: 'base_override', resourceId: req.id, details: { objectId: object.id, lowered: base.lowered, motive: req.motive } });
    return req;
  }

  /** Seconde approbation (hiérarchie de la régie), distincte du demandeur et sans lien avec le contribuable. */
  decideBaseOverride(user: User, id: string, input: { approve: boolean; reason: string }): BaseOverrideRequest {
    authorize(user, 'assessment:base-override.approve');
    const req = this.baseOverrides.get(id);
    if (!req) throw notFound('BASE_OVERRIDE_NOT_FOUND', `Dérogation inconnue : ${id}`);
    if (req.status !== 'DEMANDEE') throw conflict('BASE_OVERRIDE_ALREADY_DECIDED', `Dérogation au statut ${req.status}.`);
    assertDistinctPerson(user.id, [req.requestedBy], 'Quatre yeux : la dérogation est approuvée par une personne distincte du demandeur.');
    assertNotRelated(user, req.taxpayerId, 'Conflit d’intérêts : l’approbateur est lié au contribuable concerné.');
    if (input.reason.trim().length < 10) throw badRequest('MOTIVE_REQUIRED', 'Motif d’au moins 10 caractères requis.');
    const updated = this.baseOverrides.update({ ...req, status: input.approve ? 'APPROUVEE' : 'REFUSEE', decision: { by: user.id, at: this.clock.now().toISOString(), reason: input.reason.trim(), approved: input.approve } });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: input.approve ? 'assessment.base_override.approved' : 'assessment.base_override.rejected', resourceType: 'base_override', resourceId: id, details: { requestedBy: req.requestedBy, reason: input.reason } });
    return updated;
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
    reassessmentRequired?: Obligation['reassessmentRequired'];
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
      ...(p.reassessmentRequired ? { reassessmentRequired: p.reassessmentRequired } : {}),
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

  /**
   * Échéance effective (§ 6.2) : prorogation datée et tolérance portées par la fiche de règle. Aucun retard n'est constaté,
   * aucun avis J+1 ni pénalité proposé tant que `graceUntil` n'est pas dépassé. Sans ces champs : l'échéance d'origine.
   */
  dueInfo(o: Pick<Obligation, 'ruleId' | 'dueDate'>) {
    return effectiveDue(this.rules.rules.get(o.ruleId), o.dueDate);
  }

  /** L'obligation est-elle en retard à la date `today` (AAAA-MM-JJ), tolérance et prorogation comprises ? */
  isPastDue(o: Pick<Obligation, 'ruleId' | 'dueDate'>, today: string): boolean {
    return this.dueInfo(o).graceUntil < today;
  }

  /**
   * Changement d'état d'une obligation (jamais de suppression). Passage à un statut non payable (SOLDEE, ANNULEE,
   * ADMISE_EN_NON_VALEUR) : point unique de fermeture des références actives, quel que soit l'appelant (dégrèvement,
   * rectification à zéro, admission en non-valeur, annulation de commande, rapprochement soldant).
   */
  setStatus(id: string, status: ObligationStatus): Obligation {
    const o = this.get(id);
    const updated = this.obligations.update({ ...o, status });
    if (status !== o.status && ORDER_CLOSING_STATUSES.includes(status)) this.paymentHooks?.onClosed?.(id, status);
    return updated;
  }

  /**
   * Obligation rectificative (décision sur réclamation) : l'originale est conservée au statut ANNULEE,
   * sa créance est contrepassée, une nouvelle obligation liée est émise pour le montant rectifié TOTAL ;
   * ce qui a déjà été payé sur l'originale compte pour elle.
   */
  rectify(originalId: string, newAmount: MoneyJSON, ctx: {
    appealId: string; reason: string; decidedBy: User; decisionType?: RectificationType;
    /**
     * Statut d'une rectificative à montant NUL : jamais « SOLDEE » (qui ferait passer une réduction à zéro pour un
     * paiement). ANNULEE (dégrèvement total) par défaut ; ADMISE_EN_NON_VALEUR pour une admission en non-valeur.
     */
    zeroStatus?: 'ANNULEE' | 'ADMISE_EN_NON_VALEUR';
    /** Réévaluation : éléments de calcul mis à jour (rang, taux, base) ; lève le marqueur de réévaluation. */
    recompute?: { localityRank: number; rates: Record<string, string>; base: Record<string, string>; trace: Partial<AssessmentTrace> };
  }): Obligation {
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
      explanation: {
        ...original.explanation, amount, computedAt: now,
        ...(ctx.recompute ? { localityRank: ctx.recompute.localityRank, rates: ctx.recompute.rates, base: ctx.recompute.base } : {}),
        rectification: { supersedes: original.id, appealId: ctx.appealId, reason: ctx.reason, ...(ctx.decisionType ? { decisionType: ctx.decisionType } : {}) },
      },
      trace: { ...original.trace, ...(ctx.recompute?.trace ?? {}), result: amount, computedAt: now },
      supersedes: original.id,
      appealId: ctx.appealId,
      attribution: original.attribution,
      // Une remise ou une réclamation ne lève jamais le marqueur « rang provisoire » : seule une réévaluation le fait.
      ...(original.reassessmentRequired && !ctx.recompute ? { reassessmentRequired: original.reassessmentRequired } : {}),
    });
    this.obligations.update({ ...original, status: 'ANNULEE', supersededBy: rectified.id });
    // Les références non payées de l'originale sont fermées ; les paiements déjà reçus sont repris par la
    // rectificative (cumul payé sur la chaîne), qui naît donc partiellement payée ou soldée. Écritures cohérentes :
    // créance = montant rectifié − paiements déjà crédités ; un trop-perçu est signalé pour remboursement.
    this.paymentHooks?.onSuperseded(original.id, rectified.id);
    if (Money.fromJSON(amount).isZero()) return this.setStatus(rectified.id, ctx.zeroStatus ?? 'ANNULEE');
    const paid = this.paidAmount(rectified.id);
    if (!paid.isZero()) {
      return this.setStatus(rectified.id, paid.compare(Money.fromJSON(amount)) >= 0 ? 'SOLDEE' : 'PARTIELLEMENT_PAYEE');
    }
    return rectified;
  }

  /**
   * Réévaluation d'une obligation ouverte après confirmation ou correction du rang / de la base de l'objet :
   * même version de règle (figée), rang et base actuels de l'objet, mêmes exonérations (taux figés) ; les réductions
   * déjà accordées sur la chaîne (réclamation, remise) sont conservées en montant. Montant inchangé ⇒ seul le marqueur
   * de réévaluation est levé ; sinon obligation rectificative (contre-écriture), à la hausse comme à la baisse.
   */
  reassess(obligationId: string, by: User, opts: { reason: string; sourceId: string; path: 'REEVALUATION_RANG' | 'CORRECTION_OBJET'; inputs?: Record<string, string> }): { obligation: Obligation; changed: boolean } {
    const ob = this.get(obligationId);
    if (!PAYABLE_STATUSES.includes(ob.status) || ob.supersededBy) return { obligation: ob, changed: false };
    const rule = this.rules.get(ob.ruleId);
    const object = this.objects.get(ob.objectId);
    const inputs = { ...ob.trace.inputs, ...Object.fromEntries(Object.entries(opts.inputs ?? {}).filter(([k]) => Object.hasOwn(ob.trace.inputs, k))) };
    const evaluation = this.rules.evaluate(rule, inputs, object.localityRank);
    const gross = Money.of(evaluation.value, rule.currency, rule.rounding);
    let result = gross;
    const adjustments = (ob.trace.adjustments ?? []).map((a) => ({ ...a, reduction: gross.percent(a.rate).toJSON() }));
    for (const a of adjustments) {
      const r = Money.fromJSON(a.reduction);
      result = r.compare(result) >= 0 ? Money.zero(result.currency) : result.subtract(r);
    }
    const chain: Obligation[] = [];
    for (let cur: Obligation | undefined = ob; cur; cur = cur.supersedes ? this.obligations.get(cur.supersedes) : undefined) chain.unshift(cur);
    const alreadyReduced = Money.fromJSON(chain[0]!.trace.result).subtract(Money.fromJSON(ob.amount));
    if (!alreadyReduced.isNegative()) result = alreadyReduced.compare(result) >= 0 ? Money.zero(result.currency) : result.subtract(alreadyReduced);
    const actor = { kind: 'user' as const, id: by.id, roles: by.roles };
    const from = Money.fromJSON(ob.amount);
    if (result.equals(from)) {
      const { reassessmentRequired: _cleared, ...rest } = ob;
      const updated = this.obligations.update({ ...rest, explanation: { ...ob.explanation, localityRank: object.localityRank }, trace: { ...ob.trace, localityRank: object.localityRank, provisionalRank: false } });
      this.audit.append({ actor, action: 'assessment.reassessed', resourceType: 'obligation', resourceId: ob.id, details: { changed: false, localityRank: object.localityRank, sourceId: opts.sourceId, reason: opts.reason } });
      return { obligation: updated, changed: false };
    }
    const rectified = this.rectify(ob.id, result.toJSON(), {
      appealId: opts.sourceId, reason: opts.reason, decidedBy: by, decisionType: 'REEVALUATION',
      recompute: {
        localityRank: object.localityRank, rates: evaluation.rates, base: evaluation.inputs,
        trace: { inputs: evaluation.inputs, rates: evaluation.rates, localityRank: object.localityRank, rawResult: evaluation.value, provisionalRank: false, ...(adjustments.length ? { grossResult: gross.toJSON(), adjustments } : {}) },
      },
    });
    this.audit.append({ actor, action: 'assessment.reassessed', resourceType: 'obligation', resourceId: ob.id, details: { changed: true, from: ob.amount, to: rectified.amount, rectifiedObligationId: rectified.id, localityRank: object.localityRank, sourceId: opts.sourceId, reason: opts.reason } });
    if (result.compare(from) < 0) {
      recordReductionGranted(this.audit, actor, {
        path: opts.path, obligationId: ob.id, fromAmount: ob.amount, toAmount: rectified.amount, deciderId: by.id, taxpayerId: ob.taxpayerId,
        resultingObligationId: rectified.id, sourceId: opts.sourceId,
      });
    }
    return { obligation: rectified, changed: true };
  }

  /**
   * Re-liquidation justificative (sans effet) : version de règle figée sur l'obligation, entrées corrigées, rang
   * actuel de l'objet, exonérations figées. Sert de plancher à une décision de réduction.
   */
  reliquidate(obligationId: string, inputsOverride: Record<string, string>): { inputs: Record<string, string>; localityRank: number; result: MoneyJSON } {
    const ob = this.get(obligationId);
    const rule = this.rules.get(ob.ruleId);
    const object = this.objects.get(ob.objectId);
    const ev = this.rules.evaluate(rule, { ...ob.trace.inputs, ...inputsOverride }, object.localityRank);
    let res = Money.of(ev.value, rule.currency, rule.rounding);
    const gross = res;
    for (const a of ob.trace.adjustments ?? []) {
      const r = gross.percent(a.rate);
      res = r.compare(res) >= 0 ? Money.zero(res.currency) : res.subtract(r);
    }
    return { inputs: ev.inputs, localityRank: object.localityRank, result: res.toJSON() };
  }

  /** Obligations ouvertes d'un objet (non remplacées), candidates à la réévaluation. */
  openFor(objectId: string, onlyFlagged = false): Obligation[] {
    return this.obligations.find((o) => o.objectId === objectId && !o.supersededBy && PAYABLE_STATUSES.includes(o.status) && (!onlyFlagged || !!o.reassessmentRequired));
  }
}
