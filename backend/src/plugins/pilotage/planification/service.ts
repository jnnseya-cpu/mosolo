/**
 * Service de planification et de pilotage stratégique (§ 26.1–26.2, § 27.2–27.3, § 38, § 45, § 10A.3, § 39).
 * Lit le socle et le pilotage ; n'exécute aucun acte financier : aucune affectation, aucun transfert, aucun engagement.
 * Les imports (base de référence, coûts, assignations) sont certifiés par une seconde personne distincte
 * (assertDistinctPerson ; circuits de gouvernance PILOTAGE_BASE_REFERENCE et PILOTAGE_ASSIGNATIONS).
 */
import { Money, type CurrencyCode, type MoneyJSON, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import type { User } from '../../../core/auth.js';
import { DAY_MS, kinshasaDay } from '../../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../../core/repository.js';
import { COMMUNES } from '../../../reference/kinshasa.js';
import { ext } from '../../types.js';
import { ExportSigner, EXPORT_KEY_ID, jsonPayload } from '../exports.js';
import type { Facts } from '../facts.js';
import type { KpiExtra, KpiResult } from '../kpis.js';
import { isReconciled, matchesChannel, matchesDims, periodRange, type Filters } from '../ladder.js';
import { CurrencyTotals } from '../money.js';
import { collectReductions } from '../reductions.js';
import type { PilotagePlanningHooks, PilotageService, Query } from '../service.js';
import { MIN_CONTRIBUTORS, type FundedProjectsSection } from '../transparency.js';
import {
  additionalGrossMinor, addDays, amountsOf, EXEMPLE_ILLUSTRATIF, BASELINE_METRICS, dayCount, HYPOTHESIS_VARIABLES, INSTRUCTION_ORIGINS, MATURITY, meetsThreshold, moneyOfMinor, parseEntriesCsv,
  pickHypothesis, PILOT_COMMUNES, PILOT_CRITERIA, PILOT_MILESTONES, PROCUREMENT, PROJECT_DOMAINS, prorate, RANV_COMPONENTS, SCENARIO_CODES, SCENARIOS,
  selectEntries, SLA_KINDS, tenths, validateEntry,
  type BaselineEntry, type BaselineSet, type FundScenario, type FundScenarioItem, type Hypothesis, type HypothesisVariable, type Instruction, type InstructionOrigin,
  type Maturity, type Milestone, type Procurement, type ProjectDomain, type PublicProject, type RanvComponent, type ScenarioCode, type SetKind, type SlaAgreement,
  type SlaKind, type SlaRequest, type TargetEntry, type TargetSet,
} from './model.js';

const OVERSIGHT_ROLES: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R22', 'R23'];
const CORRECTION_TYPES = ['RECLAMATION', 'CORRECTION_DECLARATION', 'RECALCUL', 'AUTRE_RECTIFICATION'];

interface PilotConfig { id: string; startDate: string | null; communes: string[]; controls: string[]; setBy: string | null; setAt: string | null; motif: string | null; history: { at: string; by: string; startDate: string | null; controls: string[]; motif: string }[] }
interface PilotSnapshot { id: string; milestone: Milestone; dueDate: string; takenAt: string; takenBy: string; content: unknown; sha256: string; signature: string; keyId: string }
interface SatisfactionResponse { id: string; moment: 'APRES_PAIEMENT' | 'APRES_VISITE'; note: number; channel: string; at: string; respondentHash: string; receiptHash?: string }
interface AvailabilityProbe { id: string; at: string; target: string; ok: boolean; latencyMs?: number; recordedBy: string }

type Cur = Map<CurrencyCode, bigint>;
const addTo = (m: Cur, c: CurrencyCode, v: bigint) => m.set(c, (m.get(c) ?? 0n) + v);
const curJson = (m: Cur) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => moneyOfMinor(v, c));
const minorOf = (m: MoneyJSON) => Money.fromJSON(m).minor;

export class PlanificationService implements PilotagePlanningHooks {
  readonly baselines = new InMemoryRepository<BaselineSet>();
  readonly targets = new InMemoryRepository<TargetSet>();
  readonly hypotheses = new InMemoryRepository<Hypothesis>();
  readonly instructions = new InMemoryRepository<Instruction>();
  readonly slaAgreements = new InMemoryRepository<SlaAgreement>();
  readonly slaRequests = new InMemoryRepository<SlaRequest>();
  readonly satisfaction = new InMemoryAppendOnlyRepository<SatisfactionResponse>();
  readonly probes = new InMemoryAppendOnlyRepository<AvailabilityProbe>();
  readonly projects = new InMemoryRepository<PublicProject>();
  readonly fundScenarios = new InMemoryRepository<FundScenario>();
  readonly pilot = new InMemoryRepository<PilotConfig>();
  readonly snapshots = new InMemoryAppendOnlyRepository<PilotSnapshot>();
  private readonly ids = new IdGenerator();
  private readonly signer: ExportSigner;

  constructor(private readonly ctx: AppContext) {
    this.signer = new ExportSigner(ctx.secrets.auditHmacKey);
  }

  private get pil(): PilotageService { return ext<PilotageService>(this.ctx, 'pilotage'); }
  private now(): string { return this.ctx.clock.now().toISOString(); }
  private today(): string { return kinshasaDay(this.now()); }
  private audit(user: User | { kind: 'ai' | 'system'; id: string }, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}, outcome?: 'DENIED') {
    const actor = 'roles' in user ? { kind: 'user' as const, id: user.id, roles: user.roles } : { kind: user.kind, id: user.id };
    this.ctx.audit.append({ actor, action, resourceType, resourceId, details, ...(outcome ? { outcome } : {}) });
  }
  private gate(user: User, action: string, resource: Record<string, unknown> = {}) { authorize(user, `planification:${action}`, resource); }
  private cdf(m: MoneyJSON): bigint { return m.currency === 'CDF' ? minorOf(m) : minorOf(this.ctx.fx.convert(m, 'CDF').amount); }

  // ————————————————————————— base de référence et relevés de coûts (§ 38.1) —————————————————————————

  importSet(user: User, input: { kind: SetKind; label: string; period: string; source: { document: string; reference: string; sha256?: string }; entries?: BaselineEntry[]; csv?: string }): BaselineSet {
    this.gate(user, 'baseline.import');
    const range = periodRange(input.period);
    const raw = input.csv !== undefined ? parseEntriesCsv(input.csv) : input.entries ?? [];
    if (raw.length === 0) throw badRequest('EMPTY_IMPORT', 'Aucune ligne à importer.');
    const entries = raw.map(validateEntry);
    if (input.kind === 'COUTS_CONSTATES' && entries.some((e) => !['COUT_COLLECTE', 'COUT_RECOUVREMENT'].includes(e.metric))) throw badRequest('INVALID_COST_SET', 'Un relevé de coûts ne contient que COUT_COLLECTE et COUT_RECOUVREMENT.');
    const seen = new Set<string>();
    for (const e of entries) {
      const k = `${e.metric}|${e.revenue}|${e.commune}|${e.channel}|${e.currency ?? ''}`;
      if (seen.has(k)) throw badRequest('DUPLICATE_LINE', `Ligne en double : ${k}.`);
      seen.add(k);
    }
    const set = this.baselines.insert({
      id: this.ids.next(input.kind === 'BASE_REFERENCE' ? 'BREF' : 'COUT'), kind: input.kind, label: input.label, period: input.period, from: range.from, to: range.to,
      source: input.source, entries, status: 'IMPORTEE', importedBy: user.id, importedAt: this.now(),
    });
    this.audit(user, 'pilotage.baseline.imported', 'baseline', set.id, { kind: set.kind, period: set.period, lines: entries.length, contentSha256: sha256Hex(canonicalJson(entries)) });
    return set;
  }

  /** Certification (ou rejet) par une seconde personne distincte de celle qui a importé (quatre yeux). */
  decideSet(user: User, id: string, input: { approve: boolean; motif: string }): BaselineSet {
    this.gate(user, 'baseline.certify');
    const set = this.baselines.get(id);
    if (!set) throw notFound('BASELINE_NOT_FOUND', `Jeu inconnu : ${id}.`);
    if (set.status !== 'IMPORTEE') throw conflict('ALREADY_DECIDED', `Jeu déjà ${set.status.toLowerCase()}.`);
    assertDistinctPerson(user.id, [set.importedBy], 'La certification exige une personne distincte de celle qui a importé le jeu.');
    const decision = { by: user.id, at: this.now(), approve: input.approve, motif: input.motif };
    let out: BaselineSet;
    if (input.approve) {
      for (const prev of this.baselines.find((b) => b.kind === set.kind && b.period === set.period && b.status === 'CERTIFIEE')) this.baselines.update({ ...prev, status: 'REMPLACEE', supersededBy: set.id });
      out = this.baselines.update({ ...set, status: 'CERTIFIEE', decision });
    } else out = this.baselines.update({ ...set, status: 'REJETEE', decision });
    this.audit(user, input.approve ? 'pilotage.baseline.certified' : 'pilotage.baseline.rejected', 'baseline', set.id, { proposedBy: set.importedBy, motif: input.motif, kind: set.kind, period: set.period });
    return out;
  }

  listSets(user: User) {
    this.gate(user, 'baseline.read');
    return { metrics: BASELINE_METRICS, items: this.baselines.all().sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1)) };
  }

  /** Base de référence certifiée en vigueur (la plus récente). */
  certifiedBase(): BaselineSet | undefined {
    return this.baselines.find((b) => b.kind === 'BASE_REFERENCE' && b.status === 'CERTIFIEE').sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : a.decision!.at < b.decision!.at ? 1 : -1))[0];
  }
  private certifiedCosts(): BaselineSet | undefined {
    return this.baselines.find((b) => b.kind === 'COUTS_CONSTATES' && b.status === 'CERTIFIEE').sort((a, b) => (a.to < b.to ? 1 : -1))[0];
  }

  referenceDate(): string | null {
    const b = this.certifiedBase();
    return b ? addDays(b.to, 1) : null;
  }

  // ————————————————————————— RANV (§ 38.2) —————————————————————————

  private comparisonRange(f: Filters): { from: string; to: string } {
    const today = this.today();
    return { from: f.from ?? `${today.slice(0, 4)}-01-01`, to: f.to && f.to < today ? f.to : today };
  }

  /** RANV : composantes par devise, sur la base certifiée ; « non mesurée » sans base certifiée. */
  ranv(f: Filters, facts: Facts = this.pil.facts()) {
    const base = this.certifiedBase();
    const range = this.comparisonRange(f);
    if (!base) {
      return { certified: false as const, measured: false, period: range, note: 'Non mesurée : aucune base de référence certifiée (§ 38.1). Aucune valeur n’est estimée.', components: [], ranv: [] as MoneyJSON[] };
    }
    const dims = { ...(f.commune ? { commune: f.commune } : {}), ...(f.communes ? { communes: f.communes } : {}), ...(f.category ? { revenue: f.category } : {}), ...(f.channel ? { channel: f.channel } : {}) };
    const daysP = dayCount(range.from, range.to); const daysB = dayCount(base.from, base.to);
    const pf: Filters = { ...f, from: range.from, to: range.to };
    const origins = this.pil.origins(facts, pf);
    const byOrigin = (o: string): Cur => new Map((origins.rows.find((r) => r.origin === o)?.amounts ?? []).map((m) => [m.currency, minorOf(m)] as [CurrencyCode, bigint]));
    const baseEnc = amountsOf(base.entries, 'ENCAISSEMENTS', dims);
    const baseEncP: Cur = new Map([...baseEnc.entries()].map(([c, v]) => [c, prorate(v, daysP, daysB)]));
    const comp = new Map<RanvComponent, { measured: boolean; amounts: Cur; note?: string }>();
    comp.set('ASSIETTE_SUPPLEMENTAIRE', { measured: true, amounts: byOrigin('NOUVELLE') });
    const conf: Cur = new Map(byOrigin('COURANTE'));
    for (const [c, v] of baseEncP) addTo(conf, c, -v);
    comp.set('GAINS_CONFORMITE', { measured: baseEnc.size > 0, amounts: baseEnc.size ? conf : new Map(), ...(baseEnc.size ? {} : { note: 'Encaissements absents de la base pour ce périmètre.' }) });
    comp.set('ARRIERES_RECOUVRES', { measured: true, amounts: byOrigin('ARRIERES') });
    comp.set('DEPERDITION_EVITEE', { measured: false, amounts: new Map(), note: 'Non mesurée.' });
    comp.set('GAINS_RAPPROCHEMENT', { measured: true, amounts: byOrigin('RAPPROCHEMENT') });
    const costs = this.certifiedCosts();
    if (costs) {
      const cur: Cur = new Map();
      for (const m of ['COUT_COLLECTE', 'COUT_RECOUVREMENT']) {
        for (const [c, v] of amountsOf(costs.entries, m, dims)) addTo(cur, c, prorate(v, daysP, dayCount(costs.from, costs.to)));
        for (const [c, v] of amountsOf(base.entries, m, dims)) addTo(cur, c, -prorate(v, daysP, daysB));
      }
      comp.set('COUTS_ADDITIONNELS', { measured: true, amounts: cur, note: `Relevé certifié ${costs.period}, ramené à la période.` });
    } else comp.set('COUTS_ADDITIONNELS', { measured: false, amounts: new Map(), note: 'Aucun relevé de coûts certifié : composante non mesurée.' });
    const refunds: Cur = new Map();
    const scopeOb = new Map(facts.obligations.map((o) => [o.id, o]));
    for (const o of this.ctx.payments.orders.all()) {
      if (o.status !== 'REMBOURSE' || !o.confirmedAt) continue;
      const d = kinshasaDay(o.confirmedAt); const ob = scopeOb.get(o.obligationId);
      if (d < range.from || d > range.to || !ob || !matchesDims(ob, f) || !matchesChannel(o, f)) continue;
      addTo(refunds, o.amount.currency, minorOf(o.amount));
    }
    comp.set('REMBOURSEMENTS', { measured: true, amounts: refunds });
    const corr: Cur = new Map();
    const red = collectReductions(this.ctx, { ...(f.commune ? { commune: f.commune } : {}), ...(f.communes ? { communes: f.communes } : {}), ...(f.entity ? { entity: f.entity } : {}), from: range.from, to: range.to });
    for (const l of red.lines) if (CORRECTION_TYPES.includes(l.type)) addTo(corr, l.amount.currency, minorOf(l.amount));
    comp.set('CORRECTIONS', { measured: true, amounts: corr });
    const total: Cur = new Map();
    for (const def of RANV_COMPONENTS) {
      const c = comp.get(def.code)!;
      if (!c.measured) continue;
      for (const [cur, v] of c.amounts) addTo(total, cur, def.sign === 1 ? v : -v);
    }
    const unmeasured = RANV_COMPONENTS.filter((d) => !comp.get(d.code)!.measured).map((d) => d.label);
    const toCdf = (m: Cur) => [...m.entries()].reduce((a, [c, v]) => a + this.cdf(moneyOfMinor(v, c)), 0n);
    return {
      certified: true as const, measured: true, period: range, base: { id: base.id, period: base.period, from: base.from, to: base.to, source: base.source, certifiedBy: base.decision!.by, certifiedAt: base.decision!.at },
      prorata: { daysCompared: daysP, daysBase: daysB }, formula: 'RANV = assiette vérifiée supplémentaire + gains de conformité + arriérés recouvrés + déperdition évitée + gains de rapprochement − coûts additionnels − remboursements − corrections (§ 38.2).',
      components: RANV_COMPONENTS.map((d) => { const c = comp.get(d.code)!; return { code: d.code, label: d.label, sign: d.sign, method: d.method, measured: c.measured, amounts: curJson(c.amounts), ...(c.note ? { note: c.note } : {}) }; }),
      ranv: curJson(total), ranvCdf: moneyOfMinor(toCdf(total), 'CDF'), baseEncaissementsCdf: moneyOfMinor(toCdf(baseEncP), 'CDF'),
      partial: unmeasured.length > 0, unmeasured,
      origins,
      note: 'Montants par devise légale, jamais additionnés entre devises ; contre-valeur CDF indicative. La clé du § 37A s’applique, elle, à l’ensemble des recettes rapprochées.',
    };
  }

  ranvView(user: User, q: Query) {
    this.gate(user, 'baseline.read');
    const { filters, scope } = this.pil.filtersFor(user, q);
    this.audit(user, 'pilotage.viewed', 'dashboard', 'ranv', { filters });
    return { generatedAt: this.now(), scope, filters, ...this.ranv(filters) };
  }

  // ————————————————————————— points d'extension du pilotage —————————————————————————

  kpiExtra(f: Filters, asOf: string): Partial<KpiExtra> {
    const out: Partial<KpiExtra> = {};
    // RANV : base certifiée à la date d'arrêté seulement.
    const base = this.certifiedBase();
    if (base && base.decision!.at <= asOf) {
      const r = this.ranv(f);
      const den = minorOf(r.baseEncaissementsCdf!);
      const num = minorOf(r.ranvCdf!);
      const pct = den > 0n ? (() => { const n = (num < 0n ? -num : num) * 1000n; const q = (n * 2n + den) / (2n * den); return `${num < 0n && q > 0n ? '-' : ''}${q / 10n}.${q % 10n}`; })() : null;
      out.ranv = { certified: true, value: pct, detail: `RANV ${r.ranv.map((m) => `${m.amount} ${m.currency}`).join(' · ') || '0'} du ${r.period.from} au ${r.period.to} ; base ${base.period} certifiée${r.partial ? ` ; non mesuré : ${r.unmeasured.join(', ')}` : ''}.` };
    }
    const costs = this.certifiedCosts();
    if (costs && costs.decision!.at <= asOf) {
      const sum = (metric: string) => { const e = selectEntries(costs.entries, metric, { ...(f.commune ? { commune: f.commune } : {}), ...(f.category ? { revenue: f.category } : {}) }); return e.length ? e.reduce((a, x) => a + this.cdf(Money.of(x.value, x.currency!).toJSON()), 0n) : null; };
      const facts = this.pil.facts(asOf);
      let rec = 0n; let arr = 0n;
      for (const o of facts.orders) {
        if (!isReconciled(o) || !matchesDims(o, f)) continue;
        const d = kinshasaDay(o.reconciledAt!);
        if (d < costs.from || d > costs.to) continue;
        rec += this.cdf(o.amount);
      }
      for (const ob of facts.obligations) {
        if (!ob.paidAt || ob.cancelled || !matchesDims(ob, f) || ob.paidAt.slice(0, 10) <= ob.dueDate) continue;
        const d = kinshasaDay(ob.paidAt);
        if (d >= costs.from && d <= costs.to) arr += this.cdf(ob.amount);
      }
      out.costs = { collectionCdfMinor: sum('COUT_COLLECTE'), recoveryCdfMinor: sum('COUT_RECOUVREMENT'), reconciledCdfMinor: rec, recoveredArrearsCdfMinor: arr, period: costs.period };
    }
    const sat = this.satisfaction.all().filter((s) => s.at <= asOf);
    if (sat.length) out.satisfaction = { count: sat.length, sumTenths: sat.reduce((a, s) => a + s.note * 10, 0) };
    const probes = this.probes.all().filter((p) => p.at <= asOf);
    if (probes.length) out.availability = { probes: probes.length, ok: probes.filter((p) => p.ok).length };
    const agreements = this.slaAgreements.all().filter((a) => a.recordedAt <= asOf);
    if (agreements.length) {
      const reqs = this.slaRequests.all().filter((r) => r.openedAt <= asOf);
      const closed = reqs.filter((r) => r.closedAt && r.closedAt <= asOf);
      out.sla = { definitions: agreements.length, onTime: closed.filter((r) => r.onTime).length, late: closed.filter((r) => !r.onTime).length + reqs.filter((r) => !(r.closedAt && r.closedAt <= asOf) && r.dueAt < asOf).length };
    }
    const ins = this.instructions.all().filter((i) => i.issuedAt <= asOf);
    if (ins.length) {
      const day = kinshasaDay(asOf);
      const closed = ins.filter((i) => i.closure && i.closure.at <= asOf);
      const open = ins.filter((i) => !(i.closure && i.closure.at <= asOf));
      out.instructions = { onTime: closed.filter((i) => i.closure!.onTime).length, late: closed.filter((i) => !i.closure!.onTime).length + open.filter((i) => i.deadline < day).length, open: open.length };
    }
    const year = kinshasaDay(asOf).slice(0, 4);
    const t = this.certifiedTargets(year);
    if (t && t.decision!.at <= asOf) {
      const g = this.gaps(t, f, asOf);
      out.targets = { year, realisedCdfMinor: g.totals.realisedCdf, targetCdfMinor: g.totals.targetCdf };
    }
    return out;
  }

  // ————————————————————————— pilote de 180 jours (§ 45) —————————————————————————

  private pilotConfig(): PilotConfig {
    return this.pilot.get('PILOTE') ?? { id: 'PILOTE', startDate: null, communes: [...PILOT_COMMUNES], controls: [], setBy: null, setAt: null, motif: null, history: [] };
  }

  configurePilot(user: User, input: { startDate: string; controls: string[]; motif: string }) {
    this.gate(user, 'pilot.configure');
    const bad = input.controls.filter((c) => !(COMMUNES as readonly string[]).includes(c));
    if (bad.length) throw badRequest('UNKNOWN_COMMUNE', `Communes inconnues : ${bad.join(', ')}.`);
    const overlap = input.controls.filter((c) => (PILOT_COMMUNES as readonly string[]).includes(c));
    if (overlap.length) throw badRequest('CONTROL_IS_PILOT', `Une commune pilote ne peut pas être témoin : ${overlap.join(', ')}.`);
    if (this.snapshots.count() > 0 && this.pilotConfig().startDate !== input.startDate) throw conflict('PILOT_STARTED', 'Des revues signées existent : la date de démarrage ne peut plus changer.');
    const cur = this.pilotConfig();
    const next: PilotConfig = { ...cur, startDate: input.startDate, controls: [...new Set(input.controls)], setBy: user.id, setAt: this.now(), motif: input.motif, history: [...cur.history, { at: this.now(), by: user.id, startDate: input.startDate, controls: input.controls, motif: input.motif }] };
    if (this.pilot.get('PILOTE')) this.pilot.update(next); else this.pilot.insert(next);
    this.audit(user, 'pilotage.pilot.configured', 'pilot', 'PILOTE', { startDate: input.startDate, controls: next.controls, motif: input.motif });
    return this.pilotConfig();
  }

  private groupGrowth(communes: string[], facts: Facts, range: { from: string; to: string }): { value: string | null; note: string } {
    const base = this.certifiedBase();
    if (!base) return { value: null, note: 'Base de référence certifiée absente.' };
    let now = 0n;
    for (const o of facts.orders) {
      if (!isReconciled(o) || !communes.includes(o.commune)) continue;
      const d = kinshasaDay(o.reconciledAt!);
      if (d >= range.from && d <= range.to) now += this.cdf(o.amount);
    }
    const enc = amountsOf(base.entries, 'ENCAISSEMENTS', { communes });
    if (enc.size === 0) return { value: null, note: 'Encaissements des communes absents de la base certifiée.' };
    const baseP = [...enc.entries()].reduce((a, [c, v]) => a + this.cdf(moneyOfMinor(prorate(v, dayCount(range.from, range.to), dayCount(base.from, base.to)), c)), 0n);
    if (baseP <= 0n) return { value: null, note: 'Base nulle.' };
    const diff = now - baseP; const n = (diff < 0n ? -diff : diff) * 1000n; const q = (n * 2n + baseP) / (2n * baseP);
    return { value: `${diff < 0n && q > 0n ? '-' : ''}${q / 10n}.${q % 10n}`, note: `Rapproché ${now / 100n} CDF contre ${baseP / 100n} CDF de base ramenée à la même durée (contre-valeur indicative).` };
  }

  pilotBoard() {
    const cfg = this.pilotConfig();
    const today = this.today();
    const start = cfg.startDate;
    const range = { from: start ?? `${today.slice(0, 4)}-01-01`, to: today };
    const facts = this.pil.facts();
    const kpisOf = (communes: string[]): KpiResult[] | null => (communes.length ? this.pil.computeKpis({ communes, from: range.from, to: range.to }) : null);
    const pk = kpisOf(cfg.communes); const ck = kpisOf(cfg.controls);
    const val = (ks: KpiResult[] | null, code: string | null) => (ks && code ? ks.find((k) => k.code === code) ?? null : null);
    const growthP = this.groupGrowth(cfg.communes, facts, range);
    const growthC = cfg.controls.length ? this.groupGrowth(cfg.controls, facts, range) : { value: null, note: 'Aucune commune témoin désignée.' };
    const criteria = PILOT_CRITERIA.map((c) => {
      if (c.code === 'PROGRESSION_RECETTES') {
        const gap = growthP.value !== null && growthC.value !== null ? (Number(growthP.value) - Number(growthC.value)).toFixed(1) : null;
        return { code: c.code, label: c.label, threshold: c.threshold, pilot: { value: growthP.value, unit: '%', met: null, note: growthP.note }, controls: { value: growthC.value, unit: '%', note: growthC.note }, gapPoints: gap,
          status: gap === null ? 'NON_MESURE' : 'A_APPRECIER', note: 'Significativité appréciée par l’évaluation indépendante (§ 45.5) : aucun seuil statistique n’est présumé.' };
      }
      if (!c.kpi) return { code: c.code, label: c.label, threshold: c.threshold, pilot: { value: null, unit: '%', met: null }, controls: { value: null, unit: '%' }, gapPoints: null, status: 'NON_MESURE', note: 'Délai légal de traitement des contestations à confirmer (A_VERIFIER) : non mesuré.' };
      const p = val(pk, c.kpi); const k = val(ck, c.kpi);
      const pv = p && p.status !== 'NON_MESURE' ? p.value : null; const kv = k && k.status !== 'NON_MESURE' ? k.value : null;
      const met = meetsThreshold(c.op, c.value, pv);
      return { code: c.code, label: c.label, threshold: c.threshold, pilot: { value: pv, unit: p?.unit ?? '%', met }, controls: { value: kv, unit: k?.unit ?? '%' }, gapPoints: pv !== null && kv !== null ? (Number(pv) - Number(kv)).toFixed(1) : null,
        status: pv === null ? 'NON_MESURE' : met ? 'ATTEINT' : 'NON_ATTEINT', note: p?.status === 'NON_MESURE' ? `Source non disponible (${p.source}).` : '' };
    });
    const day = start ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) : null;
    return {
      generatedAt: this.now(), reference: '§ 45.1, § 45.3, § 45.5', config: cfg, day, period: range,
      milestones: Object.entries(PILOT_MILESTONES).map(([m, n]) => {
        const due = start ? addDays(start, n) : null;
        const snap = this.snapshots.findOne((s) => s.milestone === m);
        return { milestone: m, days: n, dueDate: due, reached: !!due && due <= today, signed: snap ? { id: snap.id, takenAt: snap.takenAt, sha256: snap.sha256 } : null };
      }),
      criteria,
      protocol: 'Base de référence auditée avant démarrage ; communes pilotes comparées aux communes témoins ; revues signées à chaque jalon ; décision de généralisation sur résultats vérifiés de façon indépendante.',
      baseline: this.certifiedBase() ? { id: this.certifiedBase()!.id, period: this.certifiedBase()!.period } : null,
    };
  }

  pilotView(user: User) {
    this.gate(user, 'pilot.read');
    return { ...this.pilotBoard(), snapshots: this.snapshots.all().map((s) => ({ id: s.id, milestone: s.milestone, dueDate: s.dueDate, takenAt: s.takenAt, takenBy: s.takenBy, sha256: s.sha256, signature: s.signature, keyId: s.keyId })) };
  }

  /** Revue signée à un jalon (J30 … J180) : instantané figé, signé par la clé d'export du pilotage, vérifiable publiquement. */
  signMilestone(user: User, milestone: string) {
    this.gate(user, 'pilot.snapshot');
    if (!(milestone in PILOT_MILESTONES)) throw notFound('MILESTONE_NOT_FOUND', `Jalon inconnu : ${milestone} (${Object.keys(PILOT_MILESTONES).join(', ')}).`);
    const cfg = this.pilotConfig();
    if (!cfg.startDate) throw conflict('PILOT_NOT_STARTED', 'Date de démarrage du pilote non fixée.');
    const due = addDays(cfg.startDate, PILOT_MILESTONES[milestone as Milestone]);
    if (due > this.today()) throw conflict('MILESTONE_NOT_REACHED', `Jalon ${milestone} atteint le ${due}.`);
    if (this.snapshots.findOne((s) => s.milestone === milestone)) throw conflict('ALREADY_SIGNED', `Revue ${milestone} déjà signée (instantané immuable).`);
    const content = { milestone, dueDate: due, board: this.pilotBoard() };
    const payload = jsonPayload(content);
    const { sha256, signature } = this.signer.sign(payload);
    const snap = this.snapshots.append({ id: this.ids.next('REVUE'), milestone: milestone as Milestone, dueDate: due, takenAt: this.now(), takenBy: user.id, content, sha256, signature, keyId: EXPORT_KEY_ID });
    // Enregistré au journal des exports du pilotage : vérifiable par POST /v1/pilotage/exports/verify.
    this.pil.exportsLog.append({ id: `${snap.id}-json`, exportId: snap.id, kind: 'pilote', format: 'json', generatedAt: snap.takenAt, generatedBy: { id: user.id, roles: user.roles }, filters: { milestone }, rows: 0, sha256, signature, algorithm: 'HMAC-SHA256', keyId: EXPORT_KEY_ID, note: 'Revue du pilote : empreinte SHA-256 du JSON canonique de l’instantané.' });
    this.audit(user, 'pilotage.pilot.review_signed', 'pilot', snap.id, { milestone, sha256 });
    return { ...snap, payload };
  }

  // ————————————————————————— scénarios (§ 38.3–38.4) —————————————————————————

  recordHypothesis(user: User, input: { scenario: ScenarioCode; variable: HypothesisVariable; revenue: string; value: string; source: string; sourceDate: string }) {
    this.gate(user, 'scenario.hypothesis');
    if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(input.value)) throw badRequest('INVALID_VALUE', 'Valeur décimale attendue.');
    if (input.sourceDate > this.today()) throw badRequest('FUTURE_SOURCE', 'La date de la source ne peut pas être future.');
    for (const prev of this.hypotheses.find((h) => h.status === 'EN_VIGUEUR' && h.scenario === input.scenario && h.variable === input.variable && h.revenue === input.revenue)) this.hypotheses.update({ ...prev, status: 'REMPLACEE' });
    const h = this.hypotheses.insert({ id: this.ids.next('HYP'), ...input, recordedBy: user.id, recordedAt: this.now(), status: 'EN_VIGUEUR' });
    this.audit(user, 'pilotage.scenario.hypothesis_recorded', 'hypothesis', h.id, { ...input });
    return h;
  }

  /** Base réelle par catégorie : objets connus, montant légal moyen dû, conformité observée (§ 38.2). */
  private scenarioBase(facts: Facts, f: Filters) {
    const since = addDays(this.today(), -365);
    const cert = this.certifiedBase();
    const rows = new Map<string, { objects: Set<string>; assessed: Map<CurrencyCode, { sum: bigint; n: number }>; due: number; paid: number }>();
    for (const o of facts.obligations) {
      if (o.cancelled || !matchesDims(o, f) || o.createdAt.slice(0, 10) < since) continue;
      const r = rows.get(o.category) ?? { objects: new Set(), assessed: new Map(), due: 0, paid: 0 };
      r.objects.add(o.objectId);
      const a = r.assessed.get(o.amount.currency) ?? { sum: 0n, n: 0 };
      a.sum += minorOf(o.amount); a.n++; r.assessed.set(o.amount.currency, a);
      if (!o.contested && o.dueDate <= this.today()) { r.due++; if (o.paidAt) r.paid++; }
      rows.set(o.category, r);
    }
    return [...rows.entries()].map(([revenue, r]) => {
      const certObjects = cert ? selectEntries(cert.entries, 'OBJETS_CONNUS', { revenue, ...(f.commune ? { commune: f.commune } : {}) }) : [];
      const objects = certObjects.length ? certObjects.reduce((a, e) => a + Number(e.value.split('.')[0]), 0) : r.objects.size;
      const compliance = r.due ? (() => { const q = (BigInt(r.paid) * 2000n + BigInt(r.due)) / (2n * BigInt(r.due)); return `${q / 10n}.${q % 10n}`; })() : null;
      return {
        revenue, objects, objectsSource: certObjects.length ? 'BASE_CERTIFIEE' : 'OBSERVE_12_MOIS',
        meanDue: [...r.assessed.entries()].map(([c, a]) => moneyOfMinor(a.sum / BigInt(a.n), c)),
        potential: [...r.assessed.entries()].map(([c, a]) => moneyOfMinor((a.sum / BigInt(a.n)) * BigInt(objects), c)),
        compliance, dueCount: r.due,
      };
    });
  }

  /** Simulation des trois scénarios avec analyse de sensibilité ; hypothèses du registre, ou fournies (non enregistrées). */
  simulate(user: User, q: Query, adhoc?: Omit<Hypothesis, 'id' | 'recordedBy' | 'recordedAt' | 'status'>[]) {
    this.gate(user, 'scenario.read');
    const { filters, scope } = this.pil.filtersFor(user, q);
    const facts = this.pil.facts();
    const base = this.scenarioBase(facts, filters);
    const hyps: Hypothesis[] = adhoc ? adhoc.map((h, i) => ({ ...h, id: `ADHOC-${i + 1}`, recordedBy: user.id, recordedAt: this.now(), status: 'EN_VIGUEUR' as const })) : this.hypotheses.all();
    const officialRate = () => { try { return this.ctx.fx.convert({ amount: '1.00', currency: 'USD' }, 'CDF').amount.amount; } catch { return null; } };
    const scenarios = SCENARIO_CODES.map((code) => {
      const fxH = pickHypothesis(hyps, code, 'TAUX_CHANGE', '*');
      const rate = fxH?.value ?? officialRate();
      const toCdf = (m: MoneyJSON): bigint | null => (m.currency === 'CDF' ? minorOf(m) : m.currency === 'USD' && rate ? Money.fromJSON(m).convert('CDF', rate).minor : null);
      const delayH = pickHypothesis(hyps, code, 'DELAI_PROTOCOLES_MOIS', '*');
      const delay = delayH ? Math.max(0, Math.min(12, Math.round(Number(delayH.value)))) : 0;
      const frac = BigInt(12 - delay);
      const used: Hypothesis[] = [fxH, delayH].filter((x): x is Hypothesis => !!x);
      const missing: string[] = [];
      const lines = base.map((b) => {
        const t = pickHypothesis(hyps, code, 'TAUX_CONFORMITE_CIBLE', b.revenue);
        const cost = pickHypothesis(hyps, code, 'COUT_MARGINAL', b.revenue);
        if (t) used.push(t); if (cost) used.push(cost);
        if (!t) { missing.push(`Taux de conformité cible — ${b.revenue}`); return { revenue: b.revenue, available: false as const, reason: 'Hypothèse de conformité cible non renseignée.' }; }
        if (b.compliance === null) return { revenue: b.revenue, available: false as const, reason: 'Aucune obligation échue : conformité actuelle non mesurable.' };
        const dPts = tenths(t.value) - tenths(b.compliance); // points × 10
        const gross = b.potential.map((p) => moneyOfMinor(additionalGrossMinor(minorOf(p), dPts, frac), p.currency));
        const costCdf = cost ? Money.of(cost.value, 'CDF').minor : 0n;
        const perPoint = b.potential.map((p) => moneyOfMinor((minorOf(p) / 100n) * frac / 12n, p.currency));
        const grossCdf = gross.reduce<bigint | null>((a, m) => { const v = toCdf(m); return a === null || v === null ? null : a + v; }, 0n);
        return {
          revenue: b.revenue, available: true as const, currentCompliance: b.compliance, targetCompliance: t.value, deltaPoints: `${dPts / 10n}.${(dPts < 0n ? -dPts : dPts) % 10n}`,
          potential: b.potential, additionalGross: gross, marginalCostCdf: moneyOfMinor(costCdf, 'CDF'),
          additionalNetCdf: grossCdf === null ? null : moneyOfMinor(grossCdf - costCdf, 'CDF'), perCompliancePoint: perPoint,
        };
      });
      const ok = lines.filter((l): l is Extract<typeof l, { available: true }> => l.available);
      const sumCdf = (pick: (l: (typeof ok)[number]) => MoneyJSON[]) => ok.reduce<bigint | null>((a, l) => pick(l).reduce<bigint | null>((b, m) => { const v = toCdf(m); return b === null || v === null ? null : b + v; }, a), 0n);
      const netCdf = ok.reduce<bigint | null>((a, l) => (a === null || l.additionalNetCdf === null ? null : a + minorOf(l.additionalNetCdf)), 0n);
      const usdGross = ok.reduce((a, l) => a + l.additionalGross.filter((m) => m.currency === 'USD').reduce((b, m) => b + minorOf(m), 0n), 0n);
      const perPointCdf = sumCdf((l) => l.perCompliancePoint);
      const grossCdfAll = sumCdf((l) => l.additionalGross);
      return {
        code, ...SCENARIOS[code], exchangeRate: rate, exchangeRateSource: fxH ? 'HYPOTHESE' : 'TAUX_OFFICIEL_DU_JOUR', protocolDelayMonths: delay, protocolDelaySource: delayH ? 'HYPOTHESE' : 'NON_RENSEIGNE',
        lines, additionalNetCdf: netCdf === null ? null : moneyOfMinor(netCdf, 'CDF'), complete: missing.length === 0 && ok.length === base.length,
        missing, hypotheses: [...new Map(used.map((h) => [h.id, h])).values()],
        sensitivity: {
          note: 'Dérivées exactes du calcul, sans hypothèse supplémentaire (§ 38.4 : conformité, change, délai des protocoles).',
          compliancePlusOnePointCdf: perPointCdf === null ? null : moneyOfMinor(perPointCdf, 'CDF'),
          exchangeRatePlusOnePctCdf: rate ? moneyOfMinor(Money.fromMinor(usdGross, 'USD').convert('CDF', rate).minor / 100n, 'CDF') : null,
          protocolDelayPlusOneMonthCdf: grossCdfAll === null || frac === 0n ? null : moneyOfMinor(-(grossCdfAll / frac), 'CDF'),
        },
      };
    });
    this.audit(user, 'pilotage.viewed', 'dashboard', 'scenarios', { filters, adhoc: !!adhoc });
    return {
      generatedAt: this.now(), scope, filters, nonContractual: true, notice: 'Simulation non opposable, construite sur la base réelle ; ni prévision ni engagement (§ 38.3).',
      basis: this.certifiedBase() ? 'BASE_CERTIFIEE' : 'DONNEES_OBSERVEES_NON_CERTIFIEES',
      basisNote: this.certifiedBase() ? 'Objets connus de la base certifiée lorsque disponibles ; montants et conformité observés sur 12 mois.' : 'Aucune base certifiée : objets, montants et conformité observés sur les 12 derniers mois (données réelles, non certifiées).',
      formula: 'Recette additionnelle = potentiel × (conformité cible − conformité actuelle) × (12 − délai des protocoles) / 12 − coût marginal ; potentiel = objets × montant légal moyen dû (§ 38.2).',
      equivalence: { PRUDENT: 'conservateur', TRANSFORMATIONNEL: 'ambitieux' }, variables: HYPOTHESIS_VARIABLES,
      base, scenarios,
    };
  }

  /**
   * Exemple illustratif du Cahier (§ 39.3), en lecture seule : chaque ligne est recalculée avec la formule du
   * simulateur (potentiel × (cible − actuelle), sans coût marginal) et comparée au chiffre arrondi du Cahier.
   * Rien n'est enregistré : l'exemple n'alimente ni le registre des hypothèses, ni les scénarios, ni les tableaux.
   */
  illustrativeExample(user: User) {
    this.gate(user, 'scenario.read');
    const lignes = EXEMPLE_ILLUSTRATIF.lignes.map((l) => {
      const potentiel = BigInt(l.objets) * Money.of(l.montantAnnuel, 'USD').minor;
      const ecart = tenths(l.cible) - tenths(l.actuelle);
      const gain = additionalGrossMinor(potentiel, ecart);
      const million = 100_000_000n; // 1 M USD en unités mineures
      const arrondi = Number((gain + million / 2n) / million);
      return {
        ...l, marque: '[EXEMPLE] hypothèse', potentiel: moneyOfMinor(potentiel, 'USD'), ecartPoints: `${ecart / 10n}.${ecart % 10n}`,
        gainCalcule: moneyOfMinor(gain, 'USD'), gainMillionsCalcule: arrondi, concordance: arrondi === l.gainMillionsCahier,
      };
    });
    this.audit(user, 'pilotage.viewed', 'dashboard', 'exemple-illustratif', {});
    return {
      ...EXEMPLE_ILLUSTRATIF, lignes, example: true, nonContractual: true, stored: false,
      formula: 'Gain illustratif = objets × montant annuel moyen × (conformité cible − conformité actuelle) — même fonction que le simulateur (§ 38.2), sans coût marginal.',
      concordance: lignes.every((l) => l.concordance),
    };
  }

  listHypotheses(user: User) {
    this.gate(user, 'scenario.read');
    return { variables: HYPOTHESIS_VARIABLES, scenarios: SCENARIOS, items: this.hypotheses.all().sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)) };
  }

  // ————————————————————————— assignations budgétaires (§ 26.1) —————————————————————————

  importTargets(user: User, input: { fiscalYear: string; label: string; act: { reference: string; title: string; sha256?: string }; entries: TargetEntry[] }) {
    this.gate(user, 'targets.import');
    if (input.entries.length === 0) throw badRequest('EMPTY_IMPORT', 'Aucune assignation.');
    const seen = new Set<string>();
    for (const [i, e] of input.entries.entries()) {
      if (e.commune !== '*' && !(COMMUNES as readonly string[]).includes(e.commune)) throw badRequest('UNKNOWN_COMMUNE', `ligne ${i + 1} : commune inconnue ${e.commune}.`);
      if (e.category !== '*' && !/^[A-Z_]{2,40}$/.test(e.category)) throw badRequest('INVALID_CATEGORY', `ligne ${i + 1} : catégorie attendue.`);
      if (Money.fromJSON(e.amount).isNegative()) throw badRequest('INVALID_AMOUNT', `ligne ${i + 1} : montant positif attendu.`);
      const k = `${e.commune}|${e.category}|${e.amount.currency}`;
      if (seen.has(k)) throw badRequest('DUPLICATE_LINE', `Assignation en double : ${k}.`);
      seen.add(k);
    }
    const t = this.targets.insert({ id: this.ids.next('ASSIG'), fiscalYear: input.fiscalYear, label: input.label, act: input.act, entries: input.entries, status: 'IMPORTEE', importedBy: user.id, importedAt: this.now() });
    this.audit(user, 'pilotage.targets.imported', 'targets', t.id, { fiscalYear: t.fiscalYear, lines: t.entries.length, act: t.act.reference });
    return t;
  }

  decideTargets(user: User, id: string, input: { approve: boolean; motif: string }) {
    this.gate(user, 'targets.certify');
    const t = this.targets.get(id);
    if (!t) throw notFound('TARGETS_NOT_FOUND', `Assignations inconnues : ${id}.`);
    if (t.status !== 'IMPORTEE') throw conflict('ALREADY_DECIDED', `Assignations déjà ${t.status.toLowerCase()}.`);
    assertDistinctPerson(user.id, [t.importedBy], 'La certification des assignations exige une personne distincte de celle qui les a importées.');
    const decision = { by: user.id, at: this.now(), approve: input.approve, motif: input.motif };
    if (input.approve) for (const prev of this.targets.find((x) => x.fiscalYear === t.fiscalYear && x.status === 'CERTIFIEE')) this.targets.update({ ...prev, status: 'REMPLACEE', supersededBy: t.id });
    const out = this.targets.update({ ...t, status: input.approve ? 'CERTIFIEE' : 'REJETEE', decision });
    this.audit(user, input.approve ? 'pilotage.targets.certified' : 'pilotage.targets.rejected', 'targets', t.id, { proposedBy: t.importedBy, motif: input.motif, fiscalYear: t.fiscalYear });
    return out;
  }

  private certifiedTargets(year: string): TargetSet | undefined {
    return this.targets.findOne((t) => t.fiscalYear === year && t.status === 'CERTIFIEE');
  }

  /** Écart assignation / rapproché par ligne (commune × catégorie), dans la devise de l'assignation. */
  private gaps(t: TargetSet, f: Filters, asOf = this.now()) {
    const facts = this.pil.facts(asOf);
    const from = `${t.fiscalYear}-01-01`; const to = `${t.fiscalYear}-12-31`;
    const rec = facts.orders.filter((o) => isReconciled(o) && kinshasaDay(o.reconciledAt!) >= from && kinshasaDay(o.reconciledAt!) <= to);
    let realisedCdf = 0n; let targetCdf = 0n;
    const rows = t.entries.filter((e) => (!f.commune || e.commune === f.commune || e.commune === '*') && (!f.communes || e.commune === '*' || f.communes.includes(e.commune)) && (!f.category || e.category === f.category || e.category === '*')).map((e) => {
      let r = 0n;
      for (const o of rec) {
        if (o.amount.currency !== e.amount.currency) continue;
        if (e.commune !== '*' && o.commune !== e.commune) continue;
        if (e.category !== '*' && o.category !== e.category) continue;
        if (f.communes && !f.communes.includes(o.commune)) continue;
        r += minorOf(o.amount);
      }
      const tgt = minorOf(e.amount);
      realisedCdf += this.cdf(moneyOfMinor(r, e.amount.currency)); targetCdf += this.cdf(e.amount);
      const rate = tgt > 0n ? (() => { const q = (r * 2000n + tgt) / (2n * tgt); return `${q / 10n}.${q % 10n}`; })() : null;
      return { commune: e.commune, category: e.category, target: e.amount, realised: moneyOfMinor(r, e.amount.currency), gap: moneyOfMinor(tgt - r, e.amount.currency), ratePct: rate };
    });
    return { rows, totals: { realisedCdf, targetCdf } };
  }

  gapMap(user: User, q: Query & { year?: string }) {
    this.gate(user, 'targets.read');
    const { filters, scope } = this.pil.filtersFor(user, q);
    const year = q.year ?? this.today().slice(0, 4);
    const t = this.certifiedTargets(year);
    this.audit(user, 'pilotage.viewed', 'dashboard', 'assignations', { year, filters });
    if (!t) return { generatedAt: this.now(), scope, year, certified: false, note: 'Aucune assignation certifiée pour cet exercice : écart non mesuré.', rows: [], byCommune: [], sets: this.targets.find((x) => x.fiscalYear === year) };
    const g = this.gaps(t, filters);
    const byCommune = new Map<string, { target: CurrencyTotals; realised: CurrencyTotals }>();
    for (const r of g.rows) {
      const c = byCommune.get(r.commune) ?? { target: new CurrencyTotals(), realised: new CurrencyTotals() };
      c.target.add(r.target); c.realised.add(r.realised); byCommune.set(r.commune, c);
    }
    const pctOf = (a: bigint, b: bigint) => (b > 0n ? (() => { const q = (a * 2000n + b) / (2n * b); return `${q / 10n}.${q % 10n}`; })() : null);
    return {
      generatedAt: this.now(), scope, year, certified: true, set: { id: t.id, label: t.label, act: t.act, certifiedBy: t.decision!.by, certifiedAt: t.decision!.at },
      rule: 'Écart = assignation − rapproché (niveau 9), dans la devise de l’assignation ; contre-valeur CDF indicative pour la carte.',
      rows: g.rows,
      byCommune: [...byCommune.entries()].map(([commune, c]) => {
        const tc = [...c.target.toJSON()].reduce((a, m) => a + this.cdf(m), 0n); const rc = [...c.realised.toJSON()].reduce((a, m) => a + this.cdf(m), 0n);
        return { commune, target: c.target.toJSON(), realised: c.realised.toJSON(), ratePctCdf: pctOf(rc, tc) };
      }),
      totals: { targetCdf: moneyOfMinor(g.totals.targetCdf, 'CDF'), realisedCdf: moneyOfMinor(g.totals.realisedCdf, 'CDF'), ratePct: pctOf(g.totals.realisedCdf, g.totals.targetCdf) },
      sets: this.targets.find((x) => x.fiscalYear === year),
    };
  }

  listTargets(user: User) {
    this.gate(user, 'targets.read');
    return { items: this.targets.all().sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1)) };
  }

  // ————————————————————————— instructions du Gouverneur et du cabinet (§ 26.1–26.2) —————————————————————————

  issueInstruction(user: User, input: { origin: InstructionOrigin; subject: string; body: string; context?: { commune?: string; category?: string; entity?: string }; assignee: { entity: string; role?: RoleCode; userId?: string }; deadline: string }) {
    this.gate(user, 'instruction.issue');
    if (input.deadline < this.today()) throw badRequest('DEADLINE_PAST', 'L’échéance doit être postérieure ou égale à aujourd’hui.');
    if (input.assignee.userId) {
      const u = this.ctx.users.get(input.assignee.userId);
      if (!u || u.entity !== input.assignee.entity) throw badRequest('INVALID_ASSIGNEE', 'Destinataire inconnu ou hors de l’entité désignée.');
    }
    const authority = user.roles.includes('R01') ? 'Gouverneur' : user.roles.includes('R02') ? 'Directeur de cabinet' : 'Secrétaire général';
    const n = this.instructions.count() + 1;
    const i = this.instructions.insert({
      id: this.ids.next('INSTR'), number: `INS-${this.today().slice(0, 4)}-${String(n).padStart(4, '0')}`, issuedBy: user.id, authority, origin: input.origin, subject: input.subject, body: input.body,
      context: input.context ?? {}, assignee: input.assignee, deadline: input.deadline, status: 'EMISE', issuedAt: this.now(), reports: [],
      history: [{ at: this.now(), by: user.id, action: 'EMISE' }],
    });
    this.audit(user, 'pilotage.instruction.issued', 'instruction', i.id, { number: i.number, origin: i.origin, assignee: i.assignee, deadline: i.deadline });
    return this.viewInstruction(i);
  }

  private canSee(user: User, i: Instruction): boolean {
    if (user.roles.some((r) => OVERSIGHT_ROLES.includes(r))) return true;
    return i.assignee.userId ? i.assignee.userId === user.id || (user.entity === i.assignee.entity && user.roles.some((r) => ['R06', 'R08'].includes(r))) : user.entity === i.assignee.entity;
  }

  private viewInstruction(i: Instruction) {
    const today = this.today();
    return { ...i, originLabel: INSTRUCTION_ORIGINS[i.origin], overdue: i.status !== 'CLOSE' && i.deadline < today, daysLeft: Math.round((Date.parse(`${i.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) };
  }

  listInstructions(user: User) {
    this.gate(user, 'instruction.read');
    return { origins: INSTRUCTION_ORIGINS, items: this.instructions.all().filter((i) => this.canSee(user, i)).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1)).map((i) => this.viewInstruction(i)) };
  }

  private instruction(user: User, id: string): Instruction {
    const i = this.instructions.get(id);
    if (!i || !this.canSee(user, i)) throw notFound('INSTRUCTION_NOT_FOUND', `Instruction inconnue : ${id}.`);
    return i;
  }

  private isAssignee(user: User, i: Instruction): boolean {
    return i.assignee.userId ? i.assignee.userId === user.id : user.entity === i.assignee.entity && (!i.assignee.role || user.roles.includes(i.assignee.role as RoleCode));
  }

  acknowledgeInstruction(user: User, id: string) {
    this.gate(user, 'instruction.respond');
    const i = this.instruction(user, id);
    if (!this.isAssignee(user, i)) throw forbidden('NOT_ASSIGNEE', 'Seul le service destinataire accuse réception.');
    if (i.status !== 'EMISE') throw conflict('INVALID_STATE', 'Instruction déjà accusée.');
    const out = this.instructions.update({ ...i, status: 'ACCUSEE', history: [...i.history, { at: this.now(), by: user.id, action: 'ACCUSEE' }] });
    this.audit(user, 'pilotage.instruction.acknowledged', 'instruction', i.id);
    return this.viewInstruction(out);
  }

  reportInstruction(user: User, id: string, input: { text: string; evidenceSha256?: string }) {
    this.gate(user, 'instruction.respond');
    const i = this.instruction(user, id);
    if (!this.isAssignee(user, i)) throw forbidden('NOT_ASSIGNEE', 'Seul le service destinataire rend compte.');
    if (i.status === 'CLOSE') throw conflict('INVALID_STATE', 'Instruction close.');
    const out = this.instructions.update({ ...i, status: 'RAPPORT_DEPOSE', reports: [...i.reports, { by: user.id, at: this.now(), ...input }], history: [...i.history, { at: this.now(), by: user.id, action: 'RAPPORT_DEPOSE', text: input.text.slice(0, 200) }] });
    this.audit(user, 'pilotage.instruction.reported', 'instruction', i.id, { evidenceSha256: input.evidenceSha256 ?? null });
    return this.viewInstruction(out);
  }

  /** Clôture par l'autorité (preuve de clôture) : jamais par le service destinataire lui-même. */
  closeInstruction(user: User, id: string, motif: string) {
    this.gate(user, 'instruction.close');
    const i = this.instruction(user, id);
    if (i.status !== 'RAPPORT_DEPOSE') throw conflict('REPORT_REQUIRED', 'Clôture sur rapport déposé seulement.');
    if (this.isAssignee(user, i)) throw forbidden('SEPARATION_OF_DUTIES', 'Le destinataire ne clôt pas sa propre instruction.');
    const at = this.now();
    const out = this.instructions.update({ ...i, status: 'CLOSE', closure: { by: user.id, at, motif, onTime: kinshasaDay(at) <= i.deadline }, history: [...i.history, { at, by: user.id, action: 'CLOSE', text: motif }] });
    this.audit(user, 'pilotage.instruction.closed', 'instruction', i.id, { onTime: out.closure!.onTime, motif });
    return this.viewInstruction(out);
  }

  reopenInstruction(user: User, id: string, input: { motif: string; deadline: string }) {
    this.gate(user, 'instruction.close');
    const i = this.instruction(user, id);
    if (i.status !== 'RAPPORT_DEPOSE') throw conflict('INVALID_STATE', 'Réouverture sur rapport déposé seulement (rapport jugé insuffisant).');
    if (input.deadline < this.today()) throw badRequest('DEADLINE_PAST', 'Nouvelle échéance passée.');
    const out = this.instructions.update({ ...i, status: 'ACCUSEE', deadline: input.deadline, history: [...i.history, { at: this.now(), by: user.id, action: 'REOUVERTE', text: input.motif }] });
    this.audit(user, 'pilotage.instruction.reopened', 'instruction', i.id, { motif: input.motif, deadline: input.deadline });
    return this.viewInstruction(out);
  }

  instructionsSummary(entity?: string) {
    const today = this.today();
    const all = this.instructions.all().filter((i) => !entity || i.assignee.entity === entity);
    const byStatus = new Map<string, number>();
    all.forEach((i) => byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1));
    const overdue = all.filter((i) => i.status !== 'CLOSE' && i.deadline < today);
    return {
      total: all.length, byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
      overdue: overdue.map((i) => ({ id: i.id, number: i.number, subject: i.subject, entity: i.assignee.entity, deadline: i.deadline })),
      closedOnTime: all.filter((i) => i.closure?.onTime).length, closedLate: all.filter((i) => i.closure && !i.closure.onTime).length,
      recent: all.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1)).slice(0, 8).map((i) => ({ id: i.id, number: i.number, subject: i.subject, entity: i.assignee.entity, status: i.status, deadline: i.deadline })),
    };
  }

  // ————————————————————————— accords de niveau de service entre entités (§ 10A.3) —————————————————————————

  recordAgreement(user: User, input: { fromEntity: string; toEntity: string; kind: SlaKind; delayHours: number; act: { reference: string; title: string } }) {
    this.gate(user, 'sla.write');
    if (input.fromEntity === input.toEntity) throw badRequest('SAME_ENTITY', 'Un accord de service lie deux entités distinctes.');
    for (const prev of this.slaAgreements.find((a) => a.active && a.fromEntity === input.fromEntity && a.toEntity === input.toEntity && a.kind === input.kind)) this.slaAgreements.update({ ...prev, active: false });
    const a = this.slaAgreements.insert({ id: this.ids.next('SLA'), ...input, recordedBy: user.id, recordedAt: this.now(), active: true });
    this.audit(user, 'pilotage.sla.recorded', 'sla', a.id, { ...input });
    return a;
  }

  openSlaRequest(user: User, agreementId: string, reference: string) {
    this.gate(user, 'sla.request');
    const a = this.slaAgreements.get(agreementId);
    if (!a || !a.active) throw notFound('SLA_NOT_FOUND', 'Accord de service inconnu ou inactif.');
    if (user.entity !== a.fromEntity && !user.roles.some((r) => OVERSIGHT_ROLES.includes(r))) throw forbidden('FORBIDDEN_SCOPE', `Demande ouverte par l’entité ${a.fromEntity} seulement.`);
    const openedAt = this.now();
    const r = this.slaRequests.insert({ id: this.ids.next('DEM'), agreementId, reference, openedBy: user.id, openedAt, dueAt: new Date(Date.parse(openedAt) + a.delayHours * 3_600_000).toISOString() });
    this.audit(user, 'pilotage.sla.request_opened', 'sla_request', r.id, { agreementId, reference, dueAt: r.dueAt });
    return r;
  }

  closeSlaRequest(user: User, id: string) {
    this.gate(user, 'sla.request');
    const r = this.slaRequests.get(id);
    if (!r) throw notFound('SLA_REQUEST_NOT_FOUND', 'Demande inconnue.');
    const a = this.slaAgreements.get(r.agreementId)!;
    if (user.entity !== a.toEntity) throw forbidden('FORBIDDEN_SCOPE', `Réponse de l’entité ${a.toEntity} seulement.`);
    if (r.closedAt) throw conflict('ALREADY_CLOSED', 'Demande déjà close.');
    const at = this.now();
    const out = this.slaRequests.update({ ...r, closedBy: user.id, closedAt: at, onTime: at <= r.dueAt });
    this.audit(user, 'pilotage.sla.request_closed', 'sla_request', r.id, { onTime: out.onTime });
    return out;
  }

  slaBoard(user: User) {
    this.gate(user, 'sla.read');
    const now = this.now();
    return {
      kinds: SLA_KINDS,
      agreements: this.slaAgreements.all().map((a) => {
        const reqs = this.slaRequests.find((r) => r.agreementId === a.id);
        const closed = reqs.filter((r) => r.closedAt);
        return { ...a, kindLabel: SLA_KINDS[a.kind], requests: reqs.length, open: reqs.length - closed.length, onTime: closed.filter((r) => r.onTime).length, late: closed.filter((r) => !r.onTime).length + reqs.filter((r) => !r.closedAt && r.dueAt < now).length };
      }),
      requests: this.slaRequests.all().sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1)).slice(0, 100).map((r) => ({ ...r, overdue: !r.closedAt && r.dueAt < now })),
    };
  }

  // ————————————————————————— satisfaction et disponibilité (§ 39) —————————————————————————

  respondSatisfaction(user: User, input: { moment: 'APRES_PAIEMENT' | 'APRES_VISITE'; note: number; channel: string; receiptNumber?: string }) {
    this.gate(user, 'satisfaction.respond');
    const respondentHash = sha256Hex(`${this.ctx.secrets.auditHmacKey}|sat|${user.taxpayerId ?? user.id}`);
    const receiptHash = input.receiptNumber ? sha256Hex(`${this.ctx.secrets.auditHmacKey}|rcpt|${input.receiptNumber}`) : undefined;
    if (receiptHash && this.satisfaction.findOne((s) => s.receiptHash === receiptHash && s.moment === input.moment)) throw conflict('ALREADY_ANSWERED', 'Réponse déjà enregistrée pour cette quittance.');
    const s = this.satisfaction.append({ id: this.ids.next('SAT'), moment: input.moment, note: input.note, channel: input.channel, at: this.now(), respondentHash, ...(receiptHash ? { receiptHash } : {}) });
    return { id: s.id, recorded: true, note: 'Merci. Réponse facultative et anonyme (agrégée, jamais nominative).' };
  }

  satisfactionSummary(user: User) {
    this.gate(user, 'satisfaction.read');
    const all = this.satisfaction.all();
    const by = (m: string) => { const xs = all.filter((s) => s.moment === m); return xs.length < MIN_CONTRIBUTORS ? { count: null, mean: null, masked: true } : { count: xs.length, mean: (xs.reduce((a, s) => a + s.note, 0) / xs.length).toFixed(1), masked: false }; };
    return { total: all.length, threshold: MIN_CONTRIBUTORS, afterPayment: by('APRES_PAIEMENT'), afterVisit: by('APRES_VISITE'), note: `Agrégats masqués sous ${MIN_CONTRIBUTORS} réponses (même seuil que la transparence publique).` };
  }

  recordProbe(user: User, input: { target: string; ok: boolean; latencyMs?: number; at?: string }) {
    this.gate(user, 'availability.write');
    const at = input.at && input.at <= this.now() ? input.at : this.now();
    const p = this.probes.append({ id: this.ids.next('SONDE'), at, target: input.target, ok: input.ok, ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}), recordedBy: user.id });
    this.audit(user, 'pilotage.availability.probe_recorded', 'probe', p.id, { target: p.target, ok: p.ok });
    return p;
  }

  availability(user: User) {
    this.gate(user, 'availability.read');
    const all = this.probes.all();
    const byTarget = new Map<string, { probes: number; ok: number }>();
    all.forEach((p) => { const t = byTarget.get(p.target) ?? { probes: 0, ok: 0 }; t.probes++; if (p.ok) t.ok++; byTarget.set(p.target, t); });
    return { probes: all.length, ok: all.filter((p) => p.ok).length, byTarget: [...byTarget.entries()].map(([target, t]) => ({ target, ...t })), recent: all.slice(-50).reverse() };
  }

  // ————————————————————————— projets publics et emploi des fonds (§ 27.2–27.3) —————————————————————————

  createProject(user: User, input: Omit<PublicProject, 'id' | 'status' | 'createdBy' | 'createdAt' | 'history' | 'funding' | 'progressPct'>) {
    this.gate(user, 'project.write');
    if (this.projects.findOne((p) => p.code === input.code)) throw conflict('DUPLICATE_CODE', `Code de projet déjà utilisé : ${input.code}.`);
    const bad = input.communes.filter((c) => !(COMMUNES as readonly string[]).includes(c));
    if (bad.length) throw badRequest('UNKNOWN_COMMUNE', `Communes inconnues : ${bad.join(', ')}.`);
    if (input.cost.currency !== input.recurringCost.currency) throw badRequest('CURRENCY_MISMATCH', 'Coût et coût récurrent dans la même devise.');
    const p = this.projects.insert({ id: this.ids.next('PROJ'), ...input, status: 'PROPOSE', createdBy: user.id, createdAt: this.now(), history: [{ at: this.now(), by: user.id, action: 'PROPOSE' }] });
    this.audit(user, 'pilotage.project.created', 'project', p.id, { code: p.code, domain: p.domain, communes: p.communes });
    return p;
  }

  listProjects(user: User) {
    this.gate(user, 'project.read');
    return { domains: PROJECT_DOMAINS, maturity: MATURITY, procurement: PROCUREMENT, items: this.projects.all(), scenarios: this.fundScenarios.all().sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : -1)) };
  }

  /**
   * Recommandation d'emploi des fonds (agent d'allocation) : PROPOSE jusqu'à trois scénarios classés sur les fonds
   * RAPPROCHÉS de la période. N'approuve aucune dépense, ne déplace aucun franc (§ 27.2, limite de l'IA d'affectation).
   */
  recommend(user: User, input: { period: string; currency: CurrencyCode; legalFundSource: string }) {
    this.gate(user, 'project.recommend');
    const range = periodRange(input.period);
    const facts = this.pil.facts();
    let available = 0n;
    const byCommune = new Map<string, bigint>();
    for (const o of facts.orders) {
      if (!isReconciled(o) || o.amount.currency !== input.currency) continue;
      const d = kinshasaDay(o.reconciledAt!);
      if (d < range.from || d > range.to) continue;
      available += minorOf(o.amount);
      byCommune.set(o.commune, (byCommune.get(o.commune) ?? 0n) + minorOf(o.amount));
    }
    const candidates = this.projects.find((p) => ['PROPOSE', 'RETENU'].includes(p.status) && p.cost.currency === input.currency);
    if (candidates.length === 0) throw conflict('NO_CANDIDATE', `Aucun projet proposé ou retenu en ${input.currency}.`);
    const share = (p: PublicProject) => p.communes.reduce((a, c) => a + (byCommune.get(c) ?? 0n), 0n);
    const variants: { variant: string; label: string; sort: (a: PublicProject, b: PublicProject) => number; factors: (p: PublicProject) => { label: string; value: string }[] }[] = [
      { variant: 'MATURITE', label: 'Priorité à la maturité des projets', sort: (a, b) => MATURITY[b.maturity] - MATURITY[a.maturity] || (minorOf(a.cost) < minorOf(b.cost) ? -1 : 1), factors: (p) => [{ label: 'Maturité', value: p.maturity }] },
      { variant: 'CONTRIBUTION', label: 'Lien visible impôt payé – service rendu (communes contributrices)', sort: (a, b) => (share(b) > share(a) ? 1 : share(b) < share(a) ? -1 : 0), factors: (p) => [{ label: 'Rapproché des communes du projet', value: moneyOfMinor(share(p), input.currency).amount }] },
      { variant: 'COUT_RECURRENT', label: 'Soutenabilité : coût récurrent le plus faible', sort: (a, b) => (minorOf(a.recurringCost) < minorOf(b.recurringCost) ? -1 : minorOf(a.recurringCost) > minorOf(b.recurringCost) ? 1 : 0), factors: (p) => [{ label: 'Coût récurrent', value: p.recurringCost.amount }] },
    ];
    const batchId = this.ids.next('LOT');
    const notice = 'L’IA propose des scénarios classés ; elle n’approuve aucune dépense et ne déplace aucun franc. La décision appartient aux autorités budgétaires (collecte → comptabilité → partage légal → Trésor → budget → autorisation → engagement → dépense).';
    const out = variants.map((v) => {
      let left = available;
      const items: FundScenarioItem[] = [];
      [...candidates].sort(v.sort).forEach((p) => {
        const c = minorOf(p.cost);
        if (c > left) return;
        left -= c;
        items.push({
          projectId: p.id, code: p.code, title: p.title, domain: PROJECT_DOMAINS[p.domain], communes: p.communes, beneficiaries: p.beneficiaries, expectedResult: p.expectedResult,
          maturity: p.maturity, recurringCost: p.recurringCost, procurement: PROCUREMENT[p.procurement], risks: p.risks, approvalAuthority: p.approvalAuthority, legalFundSource: p.legalFundSource,
          proposedAmount: p.cost, rank: items.length + 1, factors: v.factors(p),
        });
      });
      const s = this.fundScenarios.insert({
        id: this.ids.next('SCEN'), batchId, variant: v.variant, label: v.label, currency: input.currency, period: input.period, available: moneyOfMinor(available, input.currency),
        availableBasis: `Recettes rapprochées (niveau 9) de ${input.period} ; source légale : ${input.legalFundSource}. La disponibilité budgétaire (niveau 11) relève du budget voté.`,
        items, unallocated: moneyOfMinor(left, input.currency), proposedBy: { kind: 'ai', agent: 'ALLOCATION' }, proposedAt: this.now(), requestedBy: user.id, status: 'PROPOSE', notice,
      });
      this.audit({ kind: 'ai', id: 'agent:ALLOCATION' }, 'pilotage.fund_scenario.proposed', 'fund_scenario', s.id, { requestedBy: user.id, variant: v.variant, items: items.length, available: s.available });
      return s;
    });
    return { batchId, notice, scenarios: out };
  }

  /** Décision humaine motivée sur un scénario (retenu ou écarté) : aucun effet financier. */
  decideScenario(user: User, id: string, input: { retain: boolean; motif: string }) {
    this.gate(user, 'project.decide');
    const s = this.fundScenarios.get(id);
    if (!s) throw notFound('SCENARIO_NOT_FOUND', 'Scénario inconnu.');
    if (s.status !== 'PROPOSE') throw conflict('ALREADY_DECIDED', 'Scénario déjà décidé.');
    const out = this.fundScenarios.update({ ...s, status: input.retain ? 'RETENU' : 'ECARTE', decision: { by: user.id, at: this.now(), motif: input.motif } });
    if (input.retain) {
      for (const it of s.items) {
        const p = this.projects.get(it.projectId);
        if (p && p.status === 'PROPOSE') this.projects.update({ ...p, status: 'RETENU', history: [...p.history, { at: this.now(), by: user.id, action: 'RETENU', text: `Scénario ${s.id}` }] });
      }
      for (const other of this.fundScenarios.find((x) => x.batchId === s.batchId && x.id !== s.id && x.status === 'PROPOSE')) this.fundScenarios.update({ ...other, status: 'ECARTE', decision: { by: user.id, at: this.now(), motif: `Scénario ${s.id} retenu.` } });
    }
    this.audit(user, input.retain ? 'pilotage.fund_scenario.decided' : 'pilotage.fund_scenario.rejected', 'fund_scenario', s.id, { retain: input.retain, motif: input.motif, automaticEffect: 'AUCUN' });
    return out;
  }

  /** Financement constaté sur acte budgétaire (référence obligatoire) : la plateforme enregistre, elle ne décaisse pas. */
  recordFunding(user: User, id: string, input: { decisionReference: string; amount: MoneyJSON; motif: string }) {
    this.gate(user, 'project.decide');
    const p = this.projects.get(id);
    if (!p) throw notFound('PROJECT_NOT_FOUND', 'Projet inconnu.');
    if (p.status !== 'RETENU') throw conflict('INVALID_STATE', 'Seul un projet retenu peut être constaté financé.');
    if (input.amount.currency !== p.cost.currency) throw badRequest('CURRENCY_MISMATCH', 'Devise du financement différente de celle du projet.');
    const out = this.projects.update({ ...p, status: 'FINANCE', funding: { ...input, decidedBy: user.id, decidedAt: this.now() }, history: [...p.history, { at: this.now(), by: user.id, action: 'FINANCE', text: input.decisionReference }] });
    this.audit(user, 'pilotage.project.funding_recorded', 'project', p.id, { decisionReference: input.decisionReference, amount: input.amount });
    return out;
  }

  recordProgress(user: User, id: string, input: { progressPct: string; status?: 'EN_COURS' | 'ACHEVE'; note: string }) {
    this.gate(user, 'project.progress');
    const p = this.projects.get(id);
    if (!p) throw notFound('PROJECT_NOT_FOUND', 'Projet inconnu.');
    if (!['FINANCE', 'EN_COURS'].includes(p.status)) throw conflict('INVALID_STATE', 'Avancement d’un projet financé seulement.');
    const status = input.status ?? 'EN_COURS';
    const out = this.projects.update({ ...p, status, progressPct: input.progressPct, history: [...p.history, { at: this.now(), by: user.id, action: status, text: `${input.progressPct} % — ${input.note}` }] });
    this.audit(user, 'pilotage.project.progress_recorded', 'project', p.id, { progressPct: input.progressPct, status });
    return out;
  }

  /** Section publique « réalisations financées » (§ 27.3) : projets financés à la fin de la période, sans donnée personnelle. */
  fundedProjects(range: { from: string; to: string }): FundedProjectsSection | null {
    const funded = this.projects.find((p) => ['FINANCE', 'EN_COURS', 'ACHEVE'].includes(p.status) && !!p.funding && kinshasaDay(p.funding.decidedAt) <= range.to && !p.example);
    if (funded.length === 0) return null;
    const byCommune = new Map<string, FundedProjectsSection['byCommune'][number]['projects']>();
    for (const p of funded) {
      for (const c of p.communes) {
        const list = byCommune.get(c) ?? [];
        list.push({ code: p.code, title: p.title, domain: PROJECT_DOMAINS[p.domain], status: p.status, progressPct: p.progressPct ?? null, amounts: [{ currency: p.funding!.amount.currency, amount: p.funding!.amount.amount }], decisionReference: p.funding!.decisionReference });
        byCommune.set(c, list);
      }
    }
    return {
      note: 'Réalisations financées sur acte budgétaire, par commune d’impact, avec leur avancement ; aucune donnée individuelle (§ 27.3).',
      byCommune: [...byCommune.entries()].sort(([a], [b]) => a.localeCompare(b, 'fr')).map(([commune, projects]) => ({ commune, projects })),
    };
  }

  // ————————————————————————— démonstration —————————————————————————

  /** Données de démonstration marquées [EXEMPLE] : jamais publiées, jamais certifiées d'office. */
  seedDemo(): void {
    if (this.projects.count() > 0) return;
    const demo = { kind: 'system' as const, id: 'seed:planification' };
    const at = this.now();
    const mk = (code: string, title: string, domain: ProjectDomain, communes: string[], maturity: Maturity, procurement: Procurement, cost: string, rec: string) => this.projects.insert({
      id: this.ids.next('PROJ'), code, title: `[EXEMPLE] ${title}`, domain, communes, beneficiaries: 'Habitants et usagers des quartiers desservis (description collective)', expectedResult: 'Résultat attendu à préciser par le service porteur',
      maturity, cost: { amount: cost, currency: 'USD' }, recurringCost: { amount: rec, currency: 'USD' }, procurement, risks: 'Risques à documenter (passation, exécution, entretien)', approvalAuthority: 'Autorité budgétaire provinciale',
      legalFundSource: 'Recettes propres rapprochées — budget provincial voté', status: 'PROPOSE', createdBy: demo.id, createdAt: at, history: [{ at, by: demo.id, action: 'PROPOSE', text: 'Donnée de démonstration non contractuelle' }], example: true,
    });
    mk('EX-DRAIN-KALAMU', 'Curage des collecteurs de Matonge', 'DRAINAGE', ['Kalamu'], 'ETUDE_DETAILLEE', 'APPEL_OFFRES_OUVERT', '120.00', '10.00');
    mk('EX-ECLAIR-LIMETE', 'Éclairage public du boulevard Lumumba', 'ECLAIRAGE', ['Limete'], 'PRET_A_LANCER', 'APPEL_OFFRES_RESTREINT', '90.00', '15.00');
    mk('EX-MARCHE-GOMBE', 'Modernisation d’un marché municipal', 'MARCHES', ['Gombe'], 'ETUDE_PREALABLE', 'A_DETERMINER', '300.00', '25.00');
    this.ctx.audit.append({ actor: demo, action: 'pilotage.project.demo_seeded', resourceType: 'project', resourceId: 'EXEMPLE', details: { count: 3, note: '[EXEMPLE] non contractuel' } });
  }
}
