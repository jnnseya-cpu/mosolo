/**
 * Clé de répartition du § 37A — paramètre gouverné, NON ACTIF tant que l'acte juridique n'est pas enregistré.
 *
 *  - Clé (entité versionnée) au statut ACTE_REQUIS ; sa fiche figure au registre juridique (CLE-REPARTITION-37A,
 *    A_VERIFIER). Activation : acte enregistré (instrument du registre en vigueur + conditions du § 37A.8), fiche du
 *    registre EXÉCUTABLE (quatre visas, source certifiée, acte cité), proposition motivée, puis décision d'une seconde
 *    personne distincte du proposant et de celle qui a enregistré l'acte.
 *  - Simulation : calculée sur les recettes RAPPROCHÉES (jamais liquidées, déclarées ni initiées), par part, par période,
 *    par devise, exacte au centime (unités mineures), arrondis au Gouvernement provincial — « simulation, aucun
 *    décaissement » tant que la clé n'est pas ACTIVE.
 *  - Clé ACTIVE : la répartition d'un mois clos est arrêtée et les DEUX flux sont PROPOSÉS au Trésor comme opérations
 *    à quatre yeux (proposition, validation par une autre personne) ; jamais de décaissement automatique ; un troisième
 *    flux est rejeté.
 *  - Harmonisation avec la commission des agents (sanctions/commissions, 10 %, validation par un superviseur) : les
 *    commissions sont imputées sur la réserve « agents et sous-traitants » ; le rapport montre sa consommation.
 */
import { createHash } from 'node:crypto';
import { isRuleExecutable, Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import { actorOf } from '../../../core/audit.js';
import type { User } from '../../../core/auth.js';
import { kinshasaDate } from '../../../core/clock.js';
import { canonicalJson } from '../../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../../core/repository.js';
import type { SanctionsService } from '../../sanctions/service.js';
import type { FinancialOperation, OperationInput, RepartitionGate, TresorService } from '../../tresor/service.js';
import {
  allocate, assertKeyShape, BASE_DEFINITION, DEFAULT_SLICES, FLOW_CODES, FLOWS, flowsOf, REPARTITION_DUREE_ANS, tutelleOf,
  type FlowCode, type SliceCode, type SliceDef,
} from './model.js';

export const KEY_ID = 'CLE-37A-v1';
export const KEY_RULE_CODE = 'CLE-REPARTITION-37A';
export const SIMULATION_NOTICE = 'Simulation — aucun décaissement. Clé du § 37A non active : acte juridique provincial et conditions du § 37A.8 requis ; valeurs par défaut à confirmer par le maître d’ouvrage.';

export type KeyStatus = 'ACTE_REQUIS' | 'ACTIVATION_PROPOSEE' | 'ACTIVE';

/** Conditions préalables de validité (§ 37A.8), en plus de l'acte instituant la clé. */
export const CONDITIONS = {
  contratPpp: 'Contrat conclu selon le régime des partenariats public-privé et des marchés publics (30 ans)',
  conformiteLofip: 'Conformité du mécanisme de répartition à la source avec la LOFIP et les règles du Trésor provincial',
  conventionTripartite: 'Convention tripartite de règlement (Province – banque – Groupe Nseya) approuvée, dont BCC si requis',
  traitementFiscal: 'Traitement fiscal des sommes versées à Groupe Nseya et aux sous-traitants',
} as const;
export type ConditionCode = keyof typeof CONDITIONS;

export interface LegalActRecord {
  instrumentId: string;
  reference: string;
  title: string;
  nature: 'EDIT' | 'ARRETE';
  signedOn: string;
  documentSha256: string;
  conditions: Record<ConditionCode, string>;
  recordedBy: string;
  recordedAt: string;
}

export interface KeyHistoryEntry { at: string; by: string; action: string; detail?: string }

export interface DistributionKey {
  id: string;
  code: string;
  version: number;
  label: string;
  slices: SliceDef[];
  durationYears: number;
  status: KeyStatus;
  source: string;
  legalAct?: LegalActRecord;
  activation?: { proposedBy: string; proposedAt: string; motif: string; ruleId: string; ruleVersion: number };
  decision?: { by: string; at: string; approve: boolean; motif: string; proposedBy: string };
  activatedAt?: string;
  /** Fiche du registre juridique qui porte la clé active (règle versionnée, § 37A.7). */
  ruleId?: string;
  ruleVersion?: number;
  history: KeyHistoryEntry[];
}

/** Répartition arrêtée d'un mois clos (clé ACTIVE) : figée, base des deux propositions de décaissement. */
export interface Distribution {
  id: string;
  keyId: string;
  keyVersion: number;
  period: string;
  currency: CurrencyCode;
  base: MoneyJSON;
  payments: number;
  basisSha256: string;
  slices: { slice: SliceCode; label: string; pct: string; flow: FlowCode; amount: MoneyJSON }[];
  flows: { flow: FlowCode; amount: MoneyJSON }[];
  createdBy: string;
  createdAt: string;
}

interface Cell { period: string; currency: CurrencyCode; tutelle: string; base: Money; payments: number; orderIds: string[] }

const PERIOD_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const month = (iso: string) => kinshasaDate(new Date(iso)).slice(0, 7);
const pctOf = (num: Money, den: Money): string | null => {
  if (den.minor <= 0n) return null;
  const q = (num.minor * 2000n + den.minor) / (2n * den.minor); // dixièmes de pour cent, arrondi au plus proche
  return `${q / 10n}.${q % 10n}`;
};

export class RepartitionService implements RepartitionGate {
  readonly keys = new InMemoryRepository<DistributionKey>();
  readonly distributions = new InMemoryRepository<Distribution>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  private tresor(): TresorService | undefined {
    return this.ctx.ext.tresor as TresorService | undefined;
  }

  /** Clé courante (créée au premier accès, au statut ACTE_REQUIS : position du promoteur, non active). */
  key(): DistributionKey {
    const k = this.keys.get(KEY_ID);
    if (k) return k;
    return this.keys.insert({
      id: KEY_ID, code: KEY_RULE_CODE, version: 1,
      label: 'Clé de répartition des recettes générées par le système (§ 37A)',
      slices: structuredClone(DEFAULT_SLICES), durationYears: REPARTITION_DUREE_ANS, status: 'ACTE_REQUIS',
      source: 'Cahier des exigences v2.9 (24/09/2026), § 37A — position du promoteur, valeurs par défaut à confirmer',
      history: [{ at: this.now(), by: 'systeme', action: 'CLE_ENREGISTREE', detail: 'Statut ACTE_REQUIS : aucune exécution avant l’acte juridique (§ 37A.8).' }],
    });
  }

  private requireKey(id: string): DistributionKey {
    const k = this.key();
    if (id !== k.id) throw notFound('CLE_INCONNUE', `Clé de répartition inconnue : ${id}`);
    return k;
  }

  private registryVersions() {
    return this.ctx.rules.list().filter((r) => r.code === KEY_RULE_CODE).sort((a, b) => b.version - a.version);
  }

  /** Fiche du registre exécutable qui cite l'acte enregistré, avec ses quatre parts (somme 100 %). */
  private executableRule(act: LegalActRecord | undefined) {
    const now = this.ctx.clock.now();
    const rule = this.registryVersions().find((r) => isRuleExecutable(r, now).ok);
    if (!rule) throw unprocessable('ACTE_REQUIS', `Aucune version exécutable de la règle ${KEY_RULE_CODE} au registre juridique (quatre visas, source officielle certifiée, date d’effet atteinte).`);
    if (!act || !rule.legalInstrumentIds.includes(act.instrumentId)) {
      throw unprocessable('ACTE_NON_CITE', `La règle ${KEY_RULE_CODE} v${rule.version} ne cite pas l’acte enregistré (${act?.instrumentId ?? 'aucun'}).`);
    }
    const slices = DEFAULT_SLICES.map((s) => ({ ...s, pct: rule.rateTable[s.rateKey] ?? '' }));
    try {
      assertKeyShape(slices);
    } catch (e) {
      throw unprocessable('CLE_INVALIDE', `Table de taux de ${KEY_RULE_CODE} v${rule.version} : ${e instanceof Error ? e.message : String(e)}`);
    }
    return { rule, slices };
  }

  private history(k: DistributionKey, by: string, action: string, detail?: string): KeyHistoryEntry[] {
    return [...k.history, { at: this.now(), by, action, ...(detail ? { detail } : {}) }];
  }

  // ————————————————————————————————————————— gouvernance de la clé

  view(user: User) {
    authorize(user, 'repartition:read');
    const k = this.key();
    const rules = this.registryVersions().map((r) => ({ id: r.id, version: r.version, status: r.status, sourceVerification: r.sourceVerification, executable: isRuleExecutable(r, this.ctx.clock.now()).ok, rateTable: r.rateTable, sourceReference: r.sourceReference ?? null }));
    return {
      key: k, flows: FLOWS, baseDefinition: BASE_DEFINITION, conditions: CONDITIONS, registry: rules,
      notice: k.status === 'ACTIVE' ? 'Clé active : les décaissements sont PROPOSÉS au Trésor (quatre yeux), jamais automatiques.' : SIMULATION_NOTICE,
      activationPath: [
        'Enregistrer l’acte juridique provincial (instrument en vigueur du registre, empreinte du document) et les références des conditions du § 37A.8.',
        `Publier au registre juridique une version de ${KEY_RULE_CODE} citant l’acte, avec ses quatre visas (rédaction, vérification juridique, validation financière, publication).`,
        'Proposer l’activation (motif), puis décision d’une seconde personne distincte du proposant et de celle qui a enregistré l’acte.',
      ],
    };
  }

  recordAct(user: User, id: string, input: Omit<LegalActRecord, 'recordedBy' | 'recordedAt'>): DistributionKey {
    authorize(user, 'repartition:act.record');
    const k = this.requireKey(id);
    if (k.status !== 'ACTE_REQUIS') throw conflict('CLE_NON_MODIFIABLE', `Clé au statut ${k.status} : l’acte ne se remplace pas (nouvelle version de clé requise).`);
    const inst = this.ctx.rules.instrument(input.instrumentId);
    if (!inst) throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument juridique inconnu du registre : ${input.instrumentId}`);
    if (inst.status !== 'EN_VIGUEUR' && inst.status !== 'MODIFIE') throw unprocessable('INSTRUMENT_NOT_IN_FORCE', `Instrument ${inst.id} au statut ${inst.status} : acte en vigueur requis.`);
    const act: LegalActRecord = { ...input, recordedBy: user.id, recordedAt: this.now() };
    const out = this.keys.update({ ...k, legalAct: act, history: this.history(k, user.id, k.legalAct ? 'ACTE_REMPLACE' : 'ACTE_ENREGISTRE', `${act.nature} ${act.reference} (${act.instrumentId})`) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.key.act_recorded', resourceType: 'repartition_key', resourceId: k.id, details: { instrumentId: act.instrumentId, reference: act.reference, documentSha256: act.documentSha256 } });
    return out;
  }

  proposeActivation(user: User, id: string, motif: string): DistributionKey {
    authorize(user, 'repartition:activation.propose');
    const k = this.requireKey(id);
    if (k.status !== 'ACTE_REQUIS') throw conflict('ACTIVATION_IMPOSSIBLE', `Clé au statut ${k.status}.`);
    if (!k.legalAct) throw unprocessable('ACTE_REQUIS', 'Aucun acte juridique enregistré : la clé ne peut pas être activée (§ 37A.8).');
    const missing = (Object.keys(CONDITIONS) as ConditionCode[]).filter((c) => !k.legalAct!.conditions[c]?.trim());
    if (missing.length) throw unprocessable('CONDITIONS_PREALABLES', `Conditions du § 37A.8 non documentées : ${missing.map((c) => CONDITIONS[c]).join(' ; ')}.`, { missing });
    const { rule } = this.executableRule(k.legalAct);
    const out = this.keys.update({
      ...k, status: 'ACTIVATION_PROPOSEE', activation: { proposedBy: user.id, proposedAt: this.now(), motif, ruleId: rule.id, ruleVersion: rule.version },
      history: this.history(k, user.id, 'ACTIVATION_PROPOSEE', motif),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.key.activation_proposed', resourceType: 'repartition_key', resourceId: k.id, details: { motif, ruleId: rule.id, instrumentId: k.legalAct.instrumentId } });
    return out;
  }

  decideActivation(user: User, id: string, input: { approve: boolean; motif: string }): DistributionKey {
    authorize(user, 'repartition:activation.decide');
    const k = this.requireKey(id);
    if (k.status !== 'ACTIVATION_PROPOSEE' || !k.activation) throw conflict('AUCUNE_ACTIVATION_PROPOSEE', `Clé au statut ${k.status} : aucune activation à décider.`);
    const proposedBy = k.activation.proposedBy;
    assertDistinctPerson(user.id, [proposedBy, k.legalAct?.recordedBy ?? ''].filter(Boolean),
      'Deux personnes : l’activation est décidée par une personne distincte du proposant et de celle qui a enregistré l’acte.');
    const at = this.now();
    if (!input.approve) {
      const { activation: _a, ...rest } = k;
      const out = this.keys.update({ ...rest, status: 'ACTE_REQUIS', decision: { by: user.id, at, approve: false, motif: input.motif, proposedBy }, history: this.history(k, user.id, 'ACTIVATION_REFUSEE', input.motif) });
      this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.key.activation_rejected', resourceType: 'repartition_key', resourceId: k.id, details: { proposedBy, motif: input.motif } });
      return out;
    }
    // Conditions rejouées à la décision : la fiche du registre a pu être suspendue ou abrogée entre-temps.
    const { rule, slices } = this.executableRule(k.legalAct);
    const out = this.keys.update({
      ...k, status: 'ACTIVE', slices, ruleId: rule.id, ruleVersion: rule.version, activatedAt: at,
      decision: { by: user.id, at, approve: true, motif: input.motif, proposedBy }, history: this.history(k, user.id, 'CLE_ACTIVEE', input.motif),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.key.activated', resourceType: 'repartition_key', resourceId: k.id, details: { proposedBy, motif: input.motif, ruleId: rule.id, slices: slices.map((s) => `${s.code}:${s.pct}`) } });
    this.ctx.alerts.raise({ type: 'REPARTITION_CLE_ACTIVEE', severity: 'HIGH', source: 'repartition', detail: `Clé de répartition du § 37A activée (${rule.code} v${rule.version}) par ${user.id} sur proposition de ${proposedBy}.`, context: { keyId: k.id }, notifyRoles: ['R22'] });
    return out;
  }

  // ————————————————————————————————————————— calcul (recettes rapprochées)

  /** Cellules (mois × devise × tutelle indicative) de l'assiette, et régularisations (rapprochées puis remboursées). */
  private cells(filter: { period?: string; currency?: string }) {
    const cells = new Map<string, Cell>();
    const regularisations = new Map<string, { currency: CurrencyCode; count: number; amount: Money }>();
    const inPeriod = (p: string) => !filter.period || p === filter.period || p.startsWith(`${filter.period}-`);
    for (const o of this.ctx.payments.orders.all()) {
      if (!o.reconciledAt) continue;
      const period = month(o.reconciledAt);
      const currency = o.amount.currency;
      if (!inPeriod(period) || (filter.currency && currency !== filter.currency)) continue;
      const amount = Money.fromJSON(o.amount);
      if (o.status === 'REMBOURSE' || o.status === 'CONTREPASSE') {
        const r = regularisations.get(currency) ?? { currency, count: 0, amount: Money.zero(currency) };
        regularisations.set(currency, { ...r, count: r.count + 1, amount: r.amount.add(amount) });
        continue;
      }
      const ob = this.ctx.assessment.obligations.get(o.obligationId);
      const tutelle = tutelleOf(ob?.ruleCode ?? '');
      const key = `${period}|${currency}|${tutelle}`;
      const c = cells.get(key) ?? { period, currency, tutelle, base: Money.zero(currency), payments: 0, orderIds: [] };
      c.base = c.base.add(amount);
      c.payments += 1;
      c.orderIds.push(o.id);
      cells.set(key, c);
    }
    return { cells: [...cells.values()].sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency) || a.tutelle.localeCompare(b.tutelle)), regularisations: [...regularisations.values()] };
  }

  /** Agrège des cellules : parts calculées CELLULE PAR CELLULE puis sommées (la somme des parts reste l'assiette). */
  private aggregate(cells: Cell[], slices: SliceDef[], currency: CurrencyCode) {
    let base = Money.zero(currency);
    const bySlice = new Map<SliceCode, Money>(slices.map((s) => [s.code, Money.zero(currency)]));
    let payments = 0;
    for (const c of cells) {
      base = base.add(c.base);
      payments += c.payments;
      for (const p of allocate(c.base, slices)) bySlice.set(p.slice, bySlice.get(p.slice)!.add(p.amount));
    }
    const parts = slices.map((s) => ({ slice: s.code, amount: bySlice.get(s.code)! }));
    const flows = flowsOf(parts, slices, currency);
    const sum = parts.reduce((a, p) => a.add(p.amount), Money.zero(currency));
    return {
      currency, base: base.toJSON(), payments,
      slices: slices.map((s) => ({ slice: s.code, label: s.label, pct: s.pct, flow: s.flow, amount: bySlice.get(s.code)!.toJSON() })),
      flows: FLOW_CODES.map((f) => ({ flow: f, label: FLOWS[f].label, amount: flows[f].toJSON() })),
      check: { sumOfSlices: sum.toJSON(), equalsBase: sum.equals(base), flowsEqualBase: flows.FLUX_1.add(flows.FLUX_2).equals(base) },
    };
  }

  /** Rapport de répartition : simulation (clé non active) ou calcul (clé active), jamais un décaissement. */
  report(user: User, filter: { period?: string; currency?: string } = {}) {
    authorize(user, 'repartition:read');
    if (filter.period && !PERIOD_RE.test(filter.period)) throw badRequest('INVALID_PERIOD', 'Période attendue : AAAA ou AAAA-MM.');
    const k = this.key();
    const { cells, regularisations } = this.cells(filter);
    const currencies = [...new Set(cells.map((c) => c.currency))].sort();
    const periods = [...new Set(cells.map((c) => c.period))].sort();
    const tutelles = [...new Set(cells.map((c) => c.tutelle))].sort((a, b) => a.localeCompare(b, 'fr'));
    const totals = currencies.map((cur) => ({
      ...this.aggregate(cells.filter((c) => c.currency === cur), k.slices, cur),
      regularisations: (() => { const r = regularisations.find((x) => x.currency === cur); return { count: r?.count ?? 0, amount: (r?.amount ?? Money.zero(cur)).toJSON() }; })(),
    }));
    const byPeriod = periods.flatMap((p) => currencies.filter((cur) => cells.some((c) => c.period === p && c.currency === cur))
      .map((cur) => ({ period: p, ...this.aggregate(cells.filter((c) => c.period === p && c.currency === cur), k.slices, cur) })));
    const byTutelle = tutelles.flatMap((t) => currencies.filter((cur) => cells.some((c) => c.tutelle === t && c.currency === cur))
      .map((cur) => ({ tutelle: t, ...this.aggregate(cells.filter((c) => c.tutelle === t && c.currency === cur), k.slices, cur) })));
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.report.viewed', resourceType: 'repartition_key', resourceId: k.id, details: { period: filter.period ?? null, currency: filter.currency ?? null, mode: k.status === 'ACTIVE' ? 'CALCUL' : 'SIMULATION' } });
    return {
      generatedAt: this.now(), mode: k.status === 'ACTIVE' ? 'CALCUL' as const : 'SIMULATION' as const, disbursement: 'AUCUN' as const,
      notice: k.status === 'ACTIVE' ? 'Calcul sur recettes rapprochées. Aucun décaissement automatique : chaque flux est proposé au Trésor et validé par une seconde personne.' : SIMULATION_NOTICE,
      key: { id: k.id, status: k.status, version: k.version, slices: k.slices, durationYears: k.durationYears, source: k.source },
      baseDefinition: BASE_DEFINITION, filter,
      totals, byPeriod, byTutelle,
      tutelleNote: 'Rattachement module → ministère de tutelle INDICATIF (§ 37A.5, à confirmer par arrêté ; table versionnée validée par le comité de pilotage, § 10A).',
      agents: this.agentsReserve(cells, k.slices, filter),
      distributions: this.listDistributions(),
    };
  }

  /**
   * Réserve « agents et sous-traitants » (10 %) et commissions des agents (sanctions/commissions) : les commissions
   * validées par un superviseur sont imputées sur la réserve ; consommation par devise et par mois.
   */
  private agentsReserve(cells: Cell[], slices: SliceDef[], filter: { period?: string; currency?: string }) {
    const sanctions = this.ctx.ext.sanctions as SanctionsService | undefined;
    const lines = sanctions ? sanctions.commissions.lines() : [];
    const inPeriod = (p: string) => !filter.period || p === filter.period || p.startsWith(`${filter.period}-`);
    type Acc = { reserve: Money; validated: Money; requested: Money; acquired: Money; lines: number };
    const acc = new Map<string, Acc & { period: string; currency: CurrencyCode }>();
    const get = (period: string, currency: CurrencyCode) => {
      const key = `${period}|${currency}`;
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { period, currency, reserve: Money.zero(currency), validated: Money.zero(currency), requested: Money.zero(currency), acquired: Money.zero(currency), lines: 0 }));
      return a;
    };
    for (const c of cells) {
      const part = allocate(c.base, slices).find((p) => p.slice === 'AGENTS_SOUS_TRAITANTS')!;
      const a = get(c.period, c.currency);
      a.reserve = a.reserve.add(part.amount);
    }
    for (const l of lines) {
      if (l.state !== 'ACQUISE' || !l.paidAt || !l.orderId) continue;
      const period = month(l.paidAt);
      if (!inPeriod(period) || (filter.currency && l.commission.currency !== filter.currency)) continue;
      const state = sanctions!.validations.stateOf(`${l.source}:${l.orderId}`);
      const a = get(period, l.commission.currency);
      const m = Money.fromJSON(l.commission);
      a.acquired = a.acquired.add(m);
      a.lines += 1;
      if (state === 'VALIDEE') a.validated = a.validated.add(m);
      else if (state === 'DEMANDEE') a.requested = a.requested.add(m);
    }
    const rows = [...acc.values()].sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency)).map((a) => ({
      period: a.period, currency: a.currency, reserve: a.reserve.toJSON(), commissionsValidated: a.validated.toJSON(), commissionsRequested: a.requested.toJSON(),
      commissionsAcquired: a.acquired.toJSON(), lines: a.lines, remaining: a.reserve.subtract(a.validated).toJSON(), consumptionPct: pctOf(a.validated, a.reserve),
      status: a.validated.isZero() ? 'SANS_CONSOMMATION' as const : a.reserve.isZero() ? 'SANS_RESERVE' as const : a.validated.compare(a.reserve) > 0 ? 'DEPASSEMENT' as const : 'DANS_LA_RESERVE' as const,
    }));
    const currencies = [...new Set(rows.map((r) => r.currency))].sort();
    const totals = currencies.map((cur) => {
      const rs = rows.filter((r) => r.currency === cur);
      const sum = (f: (r: (typeof rows)[number]) => MoneyJSON) => rs.reduce((m, r) => m.add(Money.fromJSON(f(r))), Money.zero(cur));
      const reserve = sum((r) => r.reserve); const validated = sum((r) => r.commissionsValidated);
      return {
        currency: cur, reserve: reserve.toJSON(), commissionsValidated: validated.toJSON(), commissionsRequested: sum((r) => r.commissionsRequested).toJSON(),
        commissionsAcquired: sum((r) => r.commissionsAcquired).toJSON(), remaining: reserve.subtract(validated).toJSON(), consumptionPct: pctOf(validated, reserve),
        status: validated.isZero() ? 'SANS_CONSOMMATION' as const : reserve.isZero() ? 'SANS_RESERVE' as const : validated.compare(reserve) > 0 ? 'DEPASSEMENT' as const : 'DANS_LA_RESERVE' as const,
      };
    });
    return {
      slice: 'AGENTS_SOUS_TRAITANTS' as const, commissionModuleLoaded: !!sanctions, rows, totals,
      rules: [
        'Les commissions des agents (10 % des pénalités issues de leurs constats et des paiements provoqués par leurs contrôles, décision du maître d’ouvrage du 27/09/2026) sont prélevées sur la réserve « agents et sous-traitants » de la clé du § 37A : elles ne s’y ajoutent pas.',
        'Seules les commissions VALIDÉES par un superviseur distinct (quatre yeux) consomment la réserve ; les commissions demandées ou acquises non validées sont indiquées pour information.',
        'Réserve calculée sur les recettes rapprochées du mois ; commissions rattachées au mois de leur paiement. Un dépassement est signalé pour arbitrage ; il n’entraîne aucun versement.',
        'À arbitrer : le § 37A.5 répartit la réserve au prorata de points de résultats vérifiés pondérés par la qualité ; la commission de 10 % par ligne en est une modalité distincte (signalée au maître d’ouvrage).',
      ],
    };
  }

  // ————————————————————————————————————————— décaissements proposés (clé ACTIVE)

  listDistributions() {
    const ops = this.tresor()?.operations.all() ?? [];
    return this.distributions.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((d) => ({
      ...d,
      flows: d.flows.map((f) => {
        const mine = ops.filter((o) => o.target.key === `repartition:${d.id}:${f.flow}`).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
        const executed = mine.find((o) => o.status === 'EXECUTEE');
        const last = executed ?? mine[0];
        return { ...f, label: FLOWS[f.flow].label, status: executed ? 'INSTRUCTION_EMISE' : last?.status === 'PROPOSEE' ? 'PROPOSEE' : last?.status === 'REJETEE' ? 'REJETEE' : 'A_PROPOSER', operationId: last?.id ?? null };
      }),
    }));
  }

  /**
   * Arrête la répartition d'un mois CLOS (clé ACTIVE) et PROPOSE les deux flux au Trésor (quatre yeux). Aucun virement
   * n'est émis ici : chaque flux attend la validation d'une seconde personne habilitée du Trésor.
   */
  propose(user: User, input: { period: string; currency: CurrencyCode; reason: string }) {
    authorize(user, 'tresor:finance.propose');
    const tresor = this.tresor();
    if (!tresor) throw unprocessable('TRESOR_INDISPONIBLE', 'Module Trésor non chargé : aucune proposition de décaissement.');
    const k = this.key();
    if (k.status !== 'ACTIVE') throw unprocessable('ACTE_REQUIS', `Clé de répartition au statut ${k.status} : simulation seulement, aucun décaissement (§ 37A.8).`, { status: k.status });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw badRequest('INVALID_PERIOD', 'Mois attendu : AAAA-MM.');
    const current = month(this.now());
    if (input.period >= current) throw unprocessable('PERIODE_NON_CLOSE', `Le mois ${input.period} n’est pas clos : répartition arrêtée après la fin du mois.`);
    if (k.activatedAt && input.period < month(k.activatedAt)) throw unprocessable('AVANT_ACTIVATION', `Le mois ${input.period} précède l’activation de la clé (${month(k.activatedAt)}).`);
    const existing = this.listDistributions().find((d) => d.period === input.period && d.currency === input.currency && d.flows.some((f) => f.status !== 'REJETEE'));
    if (existing) throw conflict('REPARTITION_DEJA_ARRETEE', `Répartition ${existing.id} déjà arrêtée pour ${input.period} (${input.currency}).`);
    const { cells } = this.cells({ period: input.period, currency: input.currency });
    const agg = this.aggregate(cells, k.slices, input.currency);
    if (Money.fromJSON(agg.base).isZero()) throw unprocessable('ASSIETTE_NULLE', `Aucune recette rapprochée en ${input.currency} pour ${input.period}.`);
    if (!agg.check.equalsBase || !agg.check.flowsEqualBase) throw conflict('REPARTITION_INCOHERENTE', 'La somme des parts diffère de l’assiette : aucune proposition.');
    const orderIds = cells.flatMap((c) => c.orderIds).sort();
    const d = this.distributions.insert({
      id: this.ids.next('REP'), keyId: k.id, keyVersion: k.version, period: input.period, currency: input.currency, base: agg.base, payments: agg.payments,
      basisSha256: createHash('sha256').update(canonicalJson(orderIds)).digest('hex'),
      slices: agg.slices.map((s) => ({ slice: s.slice, label: s.label, pct: s.pct, flow: s.flow, amount: s.amount })),
      flows: agg.flows.map((f) => ({ flow: f.flow, amount: f.amount })), createdBy: user.id, createdAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.distribution.fixed', resourceType: 'repartition_distribution', resourceId: d.id, details: { period: d.period, currency: d.currency, base: d.base, basisSha256: d.basisSha256 } });
    const operations = FLOW_CODES.map((flow) => tresor.propose(user, { kind: 'DECAISSEMENT_REPARTITION', reason: input.reason, repartition: { distributionId: d.id, flow } }));
    return { distribution: this.listDistributions().find((x) => x.id === d.id)!, operations };
  }

  /** Passerelle Trésor : cible d'un décaissement (refus hors clé ACTIVE, hors des deux flux, ou flux déjà instruit). */
  target(input: OperationInput): { key: string; label: string; amount: MoneyJSON } {
    const r = input.repartition;
    if (!r) throw badRequest('REPARTITION_REQUIRED', 'Répartition et flux requis.');
    if (!(FLOW_CODES as readonly string[]).includes(r.flow)) {
      throw unprocessable('FLUX_NON_AUTORISE', `Deux flux de décaissement seulement (Flux 1 Groupe Nseya, Flux 2 Gouvernement provincial) : « ${r.flow} » est rejeté (§ 37A.4).`);
    }
    const flow = r.flow as FlowCode;
    const k = this.key();
    if (k.status !== 'ACTIVE') throw unprocessable('ACTE_REQUIS', `Clé de répartition au statut ${k.status} : aucun décaissement.`, { status: k.status });
    const d = this.distributions.get(r.distributionId);
    if (!d) throw notFound('REPARTITION_INCONNUE', `Répartition inconnue : ${r.distributionId}`);
    if (k.version !== d.keyVersion) throw conflict('CLE_MODIFIEE', `La répartition ${d.id} a été arrêtée sous la version ${d.keyVersion} de la clé.`);
    const key = `repartition:${d.id}:${flow}`;
    const done = this.tresor()?.operations.findOne((o) => o.status === 'EXECUTEE' && o.target.key === key);
    if (done) throw conflict('FLUX_DEJA_INSTRUIT', `${FLOWS[flow].label} de la répartition ${d.id} déjà instruit (${done.id}).`);
    const amount = d.flows.find((f) => f.flow === flow)!.amount;
    return { key, label: `${FLOWS[flow].label} — répartition ${d.id} (${d.period}, ${d.currency})`, amount };
  }

  /** Passerelle Trésor : après la seconde validation, l'instruction de virement est constatée (la banque exécute). */
  executed(op: FinancialOperation, user: User, at: string): Record<string, unknown> {
    const r = op.input.repartition!;
    const d = this.distributions.get(r.distributionId)!;
    const flow = r.flow as FlowCode;
    const amount = d.flows.find((f) => f.flow === flow)!.amount;
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.flow.instructed', resourceType: 'repartition_distribution', resourceId: d.id, details: { flow, amount, operationId: op.id, proposedBy: op.proposedBy, at } });
    return { distributionId: d.id, flow, beneficiary: FLOWS[flow].beneficiary, amount, instruction: 'EMISE', note: 'Instruction de virement émise vers la banque de règlement (compte bénéficiaire verrouillé) ; aucun fonds ne transite par MOSOLO.' };
  }
}
