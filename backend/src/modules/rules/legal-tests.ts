/**
 * Cas de tests juridiques et simulation sur échantillon réel (§ 11.2, § 44, § 6.2 « quatre contrôles » — contrôle
 * fiscal) : chaque version de règle porte ses cas (entrées → résultat attendu, validés par un juriste vérificateur
 * distinct de leur auteur) et une simulation sur un échantillon de dossiers réels (traces des liquidations antérieures
 * du même code, ou dossiers anonymisés versés par le juriste). Résultats conservés avec la version (ajout seul).
 *
 * Porte de publication : pour une catégorie exécutable, la publication est BLOQUÉE si aucun cas n'est attaché, si un
 * cas n'est pas validé, si un cas échoue, ou si aucune simulation sur échantillon n'est jointe. Règle de démonstration
 * (tous ses textes sont des instruments FICTIFS) : dispense de pièces tracée, mais un cas attaché doit toujours réussir.
 */
import {
  CATEGORIES_NON_EXECUTABLES, Money, type LegalTestCase, type LegalTestResult, type LegalTestRun, type RoleCode,
} from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { ApiError, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import type { RuleRecord, RuleService } from './service.js';

const { always } = GRANTS;
/** Rédaction des cas : juristes (rédacteur, vérificateur). Validation : juriste vérificateur seulement. */
definePolicy('rules:tests.write', { R13: always, R14: always });
definePolicy('rules:tests.validate', { R14: always });
definePolicy('rules:tests.run', { R13: always, R14: always, R15: always, R16: always, R22: always });
definePolicy('rules:sample.simulate', { R13: always, R14: always, R15: always, R16: always, R06: always, R07: always, R11: always, R22: always });

/** Une version publiée (ou au-delà) est figée : ses cas et ses simulations ne changent plus. */
const FROZEN = ['PUBLIEE', 'ACTIVE', 'SUSPENDUE', 'EXPIREE', 'ABROGEE', 'ARCHIVEE'];

export interface SampleLine {
  ref: string;
  origin: 'LIQUIDATION_ANTERIEURE' | 'DOSSIER_VERSE';
  inputs: Record<string, string>;
  localityRank: number;
  previousAmount?: string;
  amount?: string;
  errorCode?: string;
}

export interface SampleSimulation {
  id: string;
  at: string;
  by: string;
  ruleId: string;
  ruleVersion: number;
  source: string;
  size: number;
  computed: number;
  errors: number;
  lines: SampleLine[];
  totals: { amount: string; previousAmount: string | null; currency: string };
  nonOpposable: true;
}

export interface SampleRowInput { ref: string; inputs: Record<string, string>; localityRank: number; previousAmount?: string }

export interface TestGateStatus {
  required: boolean;
  dispense: boolean;
  cases: number;
  validated: number;
  lastRun: LegalTestRun | null;
  sample: { id: string; at: string; size: number; computed: number; errors: number } | null;
  blocker: { code: string; detail: string } | null;
}

export class LegalTestBench {
  private seq = 0;

  constructor(
    private readonly rules: RuleService,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  private now(): string {
    return this.clock.now().toISOString();
  }

  private editable(rule: RuleRecord): void {
    if (FROZEN.includes(rule.status)) throw conflict('RULE_VERSION_FROZEN', `Version ${rule.code} v${rule.version} au statut ${rule.status} : cas et simulations figés ; créer une nouvelle version.`);
  }

  addCase(user: User, ruleId: string, input: { label: string; inputs: Record<string, string>; localityRank: number; expected: LegalTestCase['expected'] }): RuleRecord {
    authorize(user, 'rules:tests.write');
    const rule = this.rules.get(ruleId);
    this.editable(rule);
    this.rules.assertInputsAllowed(rule, input.inputs);
    if ('amount' in input.expected) Money.of(input.expected.amount, rule.currency); // montant attendu bien formé
    const c: LegalTestCase = {
      id: `CAS-${String(++this.seq).padStart(4, '0')}-${rule.version}`, label: input.label.trim(), inputs: { ...input.inputs },
      localityRank: input.localityRank, expected: input.expected, addedBy: user.id, addedAt: this.now(),
    };
    while ((rule.legalTestCases ?? []).some((x) => x.id === c.id)) c.id = `CAS-${String(++this.seq).padStart(4, '0')}-${rule.version}`;
    this.rules.rules.update({ ...rule, legalTestCases: [...(rule.legalTestCases ?? []), c] });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.test_case.added', resourceType: 'rule', resourceId: rule.id, details: { caseId: c.id, label: c.label, expected: c.expected } });
    return this.rules.get(ruleId);
  }

  /** Validation par un juriste vérificateur (R14), distinct de l'auteur du cas (quatre yeux). */
  validateCase(user: User, ruleId: string, caseId: string): RuleRecord {
    authorize(user, 'rules:tests.validate');
    const rule = this.rules.get(ruleId);
    this.editable(rule);
    const c = (rule.legalTestCases ?? []).find((x) => x.id === caseId);
    if (!c) throw notFound('TEST_CASE_NOT_FOUND', `Cas inconnu : ${caseId}`);
    if (c.validatedBy) throw conflict('TEST_CASE_ALREADY_VALIDATED', `Cas déjà validé par ${c.validatedBy}.`);
    assertDistinctPerson(user.id, [c.addedBy], 'Le cas de test est validé par un juriste distinct de son auteur.');
    const cases = (rule.legalTestCases ?? []).map((x) => (x.id === caseId ? { ...x, validatedBy: user.id, validatedAt: this.now() } : x));
    this.rules.rules.update({ ...rule, legalTestCases: cases });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.test_case.validated', resourceType: 'rule', resourceId: rule.id, details: { caseId, addedBy: c.addedBy } });
    return this.rules.get(ruleId);
  }

  private evaluateCase(rule: RuleRecord, c: LegalTestCase): LegalTestResult {
    let actual: LegalTestResult['actual'];
    try {
      const ev = this.rules.evaluate(rule, c.inputs, c.localityRank);
      actual = { amount: Money.of(ev.value, rule.currency, rule.rounding).toDecimalString() };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      actual = { errorCode: e.code, message: e.message };
    }
    const passed = 'amount' in c.expected
      ? 'amount' in actual && Money.of(c.expected.amount, rule.currency).toDecimalString() === actual.amount
      : 'errorCode' in actual && actual.errorCode === c.expected.errorCode;
    return { caseId: c.id, label: c.label, passed, expected: c.expected, actual };
  }

  /** Exécute tous les cas de la version et conserve le résultat avec elle (journal en ajout seul). */
  run(by: { id: string; roles?: RoleCode[] }, ruleId: string): LegalTestRun {
    const rule = this.rules.get(ruleId);
    const results = (rule.legalTestCases ?? []).map((c) => this.evaluateCase(rule, c));
    const run: LegalTestRun = {
      at: this.now(), by: by.id, ruleId: rule.id, ruleVersion: rule.version, total: results.length,
      passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results,
    };
    this.rules.rules.update({ ...this.rules.rules.get(rule.id)!, legalTestRuns: [...(rule.legalTestRuns ?? []), run] });
    this.audit.append({
      actor: by.roles ? { kind: 'user', id: by.id, roles: by.roles } : { kind: 'system', id: by.id },
      action: 'rule.test_cases.run', resourceType: 'rule', resourceId: rule.id, details: { total: run.total, passed: run.passed, failed: run.failed },
    });
    return run;
  }

  runAs(user: User, ruleId: string): LegalTestRun {
    authorize(user, 'rules:tests.run');
    return this.run({ id: user.id, roles: user.roles }, ruleId);
  }

  /**
   * Simulation sur échantillon réel : traces des liquidations antérieures du même code (entrées et rang figés à la
   * liquidation) et/ou dossiers anonymisés versés. Non opposable : aucune obligation n'est créée ni modifiée.
   */
  simulateSample(user: User, ruleId: string, input: { source: string; rows?: SampleRowInput[] }, prior: SampleRowInput[]): SampleSimulation {
    authorize(user, 'rules:sample.simulate');
    const rule = this.rules.get(ruleId);
    this.editable(rule);
    const rows: (SampleRowInput & { origin: SampleLine['origin'] })[] = [
      ...prior.map((r) => ({ ...r, inputs: this.rules.pickRequiredInputs(rule, r.inputs), origin: 'LIQUIDATION_ANTERIEURE' as const })),
      ...(input.rows ?? []).map((r) => ({ ...r, origin: 'DOSSIER_VERSE' as const })),
    ];
    if (!rows.length) throw unprocessable('SAMPLE_EMPTY', 'Échantillon vide : aucune liquidation antérieure de ce code ; verser des dossiers réels anonymisés.');
    let total = Money.zero(rule.currency);
    let previous: Money | null = null;
    const lines: SampleLine[] = rows.map((r) => {
      const base: SampleLine = { ref: r.ref, origin: r.origin, inputs: r.inputs, localityRank: r.localityRank, ...(r.previousAmount ? { previousAmount: r.previousAmount } : {}) };
      try {
        const ev = this.rules.evaluate(rule, r.inputs, r.localityRank);
        const m = Money.of(ev.value, rule.currency, rule.rounding);
        total = total.add(m);
        if (r.previousAmount) {
          try { const p = Money.of(r.previousAmount, rule.currency); previous = previous ? previous.add(p) : p; } catch { /* devise différente : non cumulé */ }
        }
        return { ...base, amount: m.toDecimalString() };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        return { ...base, errorCode: e.code };
      }
    });
    const sim: SampleSimulation = {
      id: `ECH-${rule.id}-${(rule.sampleSimulations?.length ?? 0) + 1}`, at: this.now(), by: user.id, ruleId: rule.id, ruleVersion: rule.version,
      source: input.source.trim(), size: lines.length, computed: lines.filter((l) => l.amount !== undefined).length,
      errors: lines.filter((l) => l.errorCode).length, lines,
      totals: { amount: total.toDecimalString(), previousAmount: (previous as Money | null)?.toDecimalString() ?? null, currency: rule.currency }, nonOpposable: true,
    };
    const fresh = this.rules.rules.get(rule.id)!;
    this.rules.rules.update({ ...fresh, sampleSimulations: [...(fresh.sampleSimulations ?? []), sim] });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.sample_simulation.recorded', resourceType: 'rule', resourceId: rule.id, details: { simulationId: sim.id, source: sim.source, size: sim.size, computed: sim.computed, errors: sim.errors } });
    return sim;
  }

  private demoOnly(rule: RuleRecord): boolean {
    return rule.legalInstrumentIds.length > 0 && rule.legalInstrumentIds.every((id) => this.rules.instrument(id)?.demo === true);
  }

  /** État de la porte (sans exécution). */
  status(rule: RuleRecord): TestGateStatus {
    const required = !CATEGORIES_NON_EXECUTABLES.includes(rule.revenueCategory);
    const cases = rule.legalTestCases ?? [];
    const last = rule.sampleSimulations?.at(-1);
    const lastRun = rule.legalTestRuns?.at(-1) ?? null;
    return {
      required, dispense: required && this.demoOnly(rule), cases: cases.length, validated: cases.filter((c) => c.validatedBy).length, lastRun,
      sample: last ? { id: last.id, at: last.at, size: last.size, computed: last.computed, errors: last.errors } : null,
      blocker: required ? this.blockerOf(rule, lastRun) : null,
    };
  }

  private blockerOf(rule: RuleRecord, run: LegalTestRun | null): { code: string; detail: string } | null {
    const cases = rule.legalTestCases ?? [];
    const dispense = this.demoOnly(rule);
    if (!cases.length) {
      return dispense ? null : { code: 'LEGAL_TEST_CASES_MISSING', detail: `Aucun cas de test juridique attaché à ${rule.code} v${rule.version} : publication impossible (§ 11.2, § 44).` };
    }
    const unvalidated = cases.filter((c) => !c.validatedBy);
    if (unvalidated.length) return { code: 'LEGAL_TEST_CASE_NOT_VALIDATED', detail: `${unvalidated.length} cas non validé(s) par un juriste vérificateur : ${unvalidated.map((c) => c.id).join(', ')}.` };
    if (!run || run.total !== cases.length) return { code: 'LEGAL_TEST_CASES_NOT_RUN', detail: 'Les cas de test n’ont pas été exécutés sur la version courante.' };
    if (run.failed) return { code: 'LEGAL_TEST_CASES_FAILED', detail: `${run.failed} cas de test juridique en échec sur ${run.total} : ${run.results.filter((r) => !r.passed).map((r) => r.caseId).join(', ')}.` };
    if (!dispense && !(rule.sampleSimulations ?? []).some((s) => s.computed > 0)) {
      return { code: 'SAMPLE_SIMULATION_MISSING', detail: 'Aucune simulation sur échantillon réel jointe à la version (contrôle fiscal, § 6.2).' };
    }
    return null;
  }

  /**
   * Porte de publication : exécute les cas (résultat conservé avec la version), puis renvoie le blocage éventuel.
   * Catégories non exécutables (ACTE_REQUIS, RECETTE_CENTRALE) : aucune pièce exigée (elles ne liquident jamais).
   */
  gate(rule: RuleRecord, by: User): { code: string; detail: string } | null {
    if (CATEGORIES_NON_EXECUTABLES.includes(rule.revenueCategory)) return null;
    const run = (rule.legalTestCases ?? []).length ? this.run({ id: by.id, roles: by.roles }, rule.id) : null;
    return this.blockerOf(this.rules.rules.get(rule.id)!, run);
  }
}
