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
 *  - Clé ACTIVE : la répartition d'un mois clos peut être arrêtée et ses DEUX flux PROPOSÉS au Trésor comme opérations
 *    à quatre yeux (proposition, validation par une autre personne). Décision du maître d'ouvrage du 27/09/2026 : une
 *    fois l'acte ET la convention tripartite enregistrés (clé ACTIVE), les deux flux sont EXÉCUTÉS AUTOMATIQUEMENT
 *    (chaque jour après le rapprochement, ou selon la périodicité de la convention), vers les comptes verrouillés du
 *    coffre, avec piste d'audit complète ; avant l'acte : simulation quotidienne en comptes d'ordre ; un troisième
 *    flux est rejeté.
 *  - Harmonisation avec la commission des agents (sanctions/commissions, 10 %, validation par un superviseur) : les
 *    commissions sont imputées sur la réserve « agents et sous-traitants » ; le rapport montre sa consommation.
 */
import { createHash } from 'node:crypto';
import { isRuleExecutable, Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import { actorOf, type AuditActor } from '../../../core/audit.js';
import type { User } from '../../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../../core/clock.js';
import type { LedgerAccount } from '../../../modules/treasury/ledger.js';
import { canonicalJson } from '../../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../../core/repository.js';
import type { SanctionsService } from '../../sanctions/service.js';
import type { FinancialOperation, OperationInput, RepartitionGate, TresorService } from '../../tresor/service.js';
import {
  allocate, assertKeyShape, BASE_DEFINITION, DEFAULT_SLICES, FLOW_CODES, FLOWS, flowsOf, pctSumIs100, REPARTITION_DUREE_ANS, tutelleOf,
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
  /**
   * Convention tripartite de règlement (Province – banque – Groupe Nseya, § 37A.8) : périodicité d'exécution et comptes
   * bénéficiaires VERROUILLÉS du coffre (module 60), un par flux et par devise. Avec l'acte et la clé ACTIVE, elle
   * déclenche l'exécution AUTOMATIQUE des deux flux (décision du maître d'ouvrage du 27/09/2026).
   */
  convention?: SettlementConvention;
}

/** Périodicité d'exécution fixée par la convention tripartite ; « quotidienne » = chaque jour après le rapprochement. */
export type Periodicite = 'QUOTIDIENNE' | 'HEBDOMADAIRE' | 'MENSUELLE';
export const PERIODICITES: readonly Periodicite[] = ['QUOTIDIENNE', 'HEBDOMADAIRE', 'MENSUELLE'];

export interface SettlementConvention {
  reference: string;
  bank: string;
  signedOn: string;
  documentSha256: string;
  periodicite: Periodicite;
  /** Deux flux SEULEMENT ; un alias du coffre par flux et par devise (jamais un numéro de compte saisi). */
  beneficiaries: { flow: FlowCode; currency: CurrencyCode; alias: string }[];
  recordedBy: string;
  recordedAt: string;
}

/**
 * Répartition SIMULÉE (clé au statut ACTE_REQUIS) : arrêtée chaque jour sur les recettes rapprochées la veille,
 * inscrite au grand livre en COMPTES D'ORDRE (module 59) — aucun fonds ne bouge, aucune opération du Trésor.
 */
export interface SimulatedDistribution {
  id: string;
  keyId: string;
  keyVersion: number;
  /** Journée de Kinshasa (AAAA-MM-JJ) de l'exécution de la simulation. */
  period: string;
  /** Recettes rapprochées avant cet instant (début de la journée d'exécution, heure de Kinshasa). */
  cutoff: string;
  currency: CurrencyCode;
  base: MoneyJSON;
  grossBase: MoneyJSON;
  payments: number;
  orderIds: string[];
  basisSha256: string;
  slices: { slice: SliceCode; amount: MoneyJSON }[];
  flows: { flow: FlowCode; amount: MoneyJSON }[];
  regularisation?: { orderIds: string[]; amount: MoneyJSON; fromDistributions: string[]; slices: { slice: SliceCode; amount: MoneyJSON }[] };
  ledgerEntryIds: string[];
  createdAt: string;
}

/** Comptes d'ordre du grand livre par part (simulation / répartition arrêtée). */
const ORDER_ACCOUNTS: Record<'SIMULATION' | 'ARRETEE', { base: LedgerAccount; parts: Record<SliceCode, LedgerAccount> }> = {
  SIMULATION: {
    base: 'ORDRE_SIMULATION_ASSIETTE',
    parts: { GROUPE_NSEYA: 'ORDRE_SIMULATION_PART_NSEYA', TUTELLE: 'ORDRE_SIMULATION_PART_TUTELLE', AGENTS_SOUS_TRAITANTS: 'ORDRE_SIMULATION_PART_AGENTS', GOUVERNEMENT_PROVINCIAL: 'ORDRE_SIMULATION_PART_GOUVERNEMENT' },
  },
  ARRETEE: {
    base: 'ORDRE_REPARTITION_ASSIETTE',
    parts: { GROUPE_NSEYA: 'ORDRE_REPARTITION_PART_NSEYA', TUTELLE: 'ORDRE_REPARTITION_PART_TUTELLE', AGENTS_SOUS_TRAITANTS: 'ORDRE_REPARTITION_PART_AGENTS', GOUVERNEMENT_PROVINCIAL: 'ORDRE_REPARTITION_PART_GOUVERNEMENT' },
  },
};

/** Principal technique de l'exécution automatique (aucune personne : la décision est l'acte et la convention). */
export const AUTO_EXECUTOR_ID = 'SYSTEME:REPARTITION_AUTOMATIQUE';
const AUTO_USER: User = { kind: 'user', id: AUTO_EXECUTOR_ID, name: 'Exécution automatique de la répartition (§ 37A)', roles: [], entity: 'TRESOR' };
const AUTO_ACTOR: AuditActor = { kind: 'system', id: 'repartition-automatique' };

/** Début (inclus) de la journée de Kinshasa AAAA-MM-JJ, en millisecondes UTC (UTC+1, sans heure d'été). */
const kinDayStart = (day: string) => Date.parse(`${day}T00:00:00+01:00`);

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
  /** Arrêtée par une personne (proposition au Trésor, quatre yeux) ou AUTOMATIQUEMENT (acte + convention). */
  mode?: 'MANUEL' | 'AUTOMATIQUE';
  /** Exécution automatique : recettes rapprochées avant cet instant (fin de la période de la convention). */
  cutoff?: string;
  /** Écritures du grand livre (comptes d'ordre de la répartition arrêtée, régularisation). */
  ledgerEntryIds?: string[];
  /** Paiements rapprochés formant l'assiette (base des régularisations ultérieures après remboursement). */
  orderIds?: string[];
  /** Assiette brute du mois, avant déduction des régularisations. */
  grossBase?: MoneyJSON;
  /**
   * Régularisation automatique (module 73) : paiements d'une répartition antérieure remboursés ou contrepassés depuis,
   * déduits de cette répartition (parts diminuées au prorata de la clé). Proposée au Trésor comme le reste : quatre yeux.
   */
  regularisation?: { orderIds: string[]; amount: MoneyJSON; fromDistributions: string[]; slices: { slice: SliceCode; amount: MoneyJSON }[] };
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
  /** Répartitions simulées (clé non active), inscrites en comptes d'ordre (modules 59 et 73). */
  readonly simulations = new InMemoryRepository<SimulatedDistribution>();
  /** Journal des exécutions du traitement automatique (quotidien). */
  readonly runs = new InMemoryRepository<{ id: string; at: string; trigger: string; mode: 'SIMULATION' | 'EXECUTION' | 'AUCUN'; created: string[]; skipped: { currency?: string; reason: string }[] }>();
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
      notice: k.status === 'ACTIVE'
        ? (k.convention ? 'Clé active et convention enregistrée : les deux flux sont exécutés AUTOMATIQUEMENT selon la périodicité de la convention (piste d’audit complète) ; la proposition à quatre yeux reste possible.' : 'Clé active : les décaissements sont PROPOSÉS au Trésor (quatre yeux) ; l’exécution automatique attend la convention tripartite de règlement.')
        : SIMULATION_NOTICE,
      automation: this.automation(),
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
  private cells(filter: { period?: string; currency?: string }, opts: { exclude?: Set<string>; before?: number; fromMonth?: string } = {}) {
    const cells = new Map<string, Cell>();
    const regularisations = new Map<string, { currency: CurrencyCode; count: number; amount: Money }>();
    const inPeriod = (p: string) => !filter.period || p === filter.period || p.startsWith(`${filter.period}-`);
    for (const o of this.ctx.payments.orders.all()) {
      if (!o.reconciledAt) continue;
      // Paiement déjà compris dans une répartition (arrêtée ou simulée selon le cas) : jamais deux fois.
      if (opts.exclude?.has(o.id)) continue;
      if (opts.before !== undefined && Date.parse(o.reconciledAt) >= opts.before) continue;
      if (opts.fromMonth && month(o.reconciledAt) < opts.fromMonth) continue;
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
    const keyPct100 = pctSumIs100(k.slices);
    this.alertIfNot100(k, keyPct100, totals.every((t) => t.check.equalsBase && t.check.flowsEqualBase));
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.report.viewed', resourceType: 'repartition_key', resourceId: k.id, details: { period: filter.period ?? null, currency: filter.currency ?? null, mode: k.status === 'ACTIVE' ? 'CALCUL' : 'SIMULATION' } });
    return {
      generatedAt: this.now(), mode: k.status === 'ACTIVE' ? 'CALCUL' as const : 'SIMULATION' as const, disbursement: 'AUCUN' as const,
      notice: k.status === 'ACTIVE'
        ? (k.convention ? 'Calcul sur recettes rapprochées. Acte et convention enregistrés : les deux flux sont exécutés automatiquement (piste d’audit complète), jamais un troisième.' : 'Calcul sur recettes rapprochées. Aucun décaissement automatique sans convention tripartite : chaque flux est proposé au Trésor et validé par une seconde personne.')
        : SIMULATION_NOTICE,
      automation: this.automation(),
      key: { id: k.id, status: k.status, version: k.version, slices: k.slices, durationYears: k.durationYears, source: k.source },
      baseDefinition: BASE_DEFINITION, filter,
      totals, byPeriod, byTutelle,
      tutelleNote: 'Rattachement module → ministère de tutelle INDICATIF (§ 37A.5, à confirmer par arrêté ; table versionnée validée par le comité de pilotage, § 10A).',
      agents: { ...this.agentsReserve(cells, k.slices, filter), byModule: this.agentsByModule(cells, k.slices) },
      distributions: this.listDistributions(),
      check100: { keySlicesSumTo100: keyPct100, partsEqualBase: totals.every((t) => t.check.equalsBase), flowsEqualBase: totals.every((t) => t.check.flowsEqualBase) },
      regularisationsPending: this.pendingRegularisations(filter.currency),
      tableau: this.tableau(byPeriod, k.status === 'ACTIVE'),
      indicateurs: this.indicators(),
    };
  }

  /** Alerte (une fois par version de clé et par nature d'écart) sur tout écart à 100 % (module 73). */
  private readonly alerted = new Set<string>();
  private alertIfNot100(k: DistributionKey, keyPct100: boolean, partsOk: boolean): void {
    const raise = (code: string, detail: string) => {
      const key = `${k.id}:${k.version}:${code}`;
      if (this.alerted.has(key)) return;
      this.alerted.add(key);
      this.ctx.alerts.raise({ type: 'REPARTITION_ECART_100', severity: 'CRITICAL', source: 'repartition', detail, context: { keyId: k.id, version: k.version, code }, notifyRoles: ['R22', 'R17'] });
    };
    if (!keyPct100) raise('CLE', `Clé de répartition ${k.id} v${k.version} : la somme des parts n’est pas égale à 100 % (${k.slices.map((s) => `${s.code} ${s.pct} %`).join(', ')}). Aucune proposition possible.`);
    if (!partsOk) raise('PARTS', `Répartition ${k.id} v${k.version} : la somme des parts ou des flux diffère de l’assiette.`);
  }

  /** Répartition arrêtée « vivante » : au moins un de ses flux proposé ou instruit (pas entièrement rejetée). */
  private isLive(d: Distribution): boolean {
    const ops = this.tresor()?.operations.all() ?? [];
    return FLOW_CODES.some((f) => ops.some((o) => o.target.key === `repartition:${d.id}:${f}` && o.status !== 'REJETEE'));
  }

  /**
   * Paiements déjà compris dans une répartition arrêtée, depuis remboursés ou contrepassés, et pas encore régularisés :
   * ils seront déduits AUTOMATIQUEMENT de la prochaine répartition de la même devise (module 73).
   */
  pendingRegularisations(currency?: string) {
    const done = new Set(this.distributions.all().filter((d) => this.isLive(d)).flatMap((d) => d.regularisation?.orderIds ?? []));
    const out: { orderId: string; paymentReference: string; distributionId: string; period: string; currency: CurrencyCode; amount: MoneyJSON; status: string }[] = [];
    for (const d of this.distributions.all()) {
      if (currency && d.currency !== currency) continue;
      if (!this.isLive(d)) continue;
      for (const id of d.orderIds ?? []) {
        if (done.has(id)) continue;
        const o = this.ctx.payments.orders.get(id);
        if (!o || (o.status !== 'REMBOURSE' && o.status !== 'CONTREPASSE')) continue;
        out.push({ orderId: o.id, paymentReference: o.paymentReference, distributionId: d.id, period: d.period, currency: d.currency, amount: o.amount, status: o.status });
      }
    }
    return out;
  }

  /** Tableau (module 73) : rapproché, calculé, versé (instruction émise), reste à verser — par mois et devise. */
  private tableau(byPeriod: { period: string; currency: CurrencyCode; base: MoneyJSON }[], active: boolean) {
    const ops = this.tresor()?.operations.all() ?? [];
    // Une répartition (mensuelle, hebdomadaire ou quotidienne) est rattachée au mois de sa période.
    const monthOf = (period: string) => period.slice(0, 7);
    const rows = byPeriod.map((p) => {
      const cur = p.currency;
      const ds = this.distributions.find((x) => monthOf(x.period) === p.period && x.currency === cur && this.isLive(x));
      const sims = this.simulations.find((x) => monthOf(x.period) === p.period && x.currency === cur);
      const sum = (xs: MoneyJSON[]) => xs.reduce((a, m) => a.add(Money.fromJSON(m)), Money.zero(cur));
      const calcule = ds.length ? sum(ds.map((d) => d.base)) : Money.fromJSON(p.base);
      let verse = Money.zero(cur);
      for (const d of ds) for (const f of d.flows) if (ops.some((o) => o.target.key === `repartition:${d.id}:${f.flow}` && o.status === 'EXECUTEE')) verse = verse.add(Money.fromJSON(f.amount));
      const arrete = sum(ds.map((d) => d.grossBase ?? d.base));
      return {
        period: p.period, currency: cur, rapproche: p.base, calcule: calcule.toJSON(), verse: verse.toJSON(),
        resteAVerser: (active && ds.length ? calcule.subtract(verse) : Money.zero(cur)).toJSON(),
        /** Recettes rapprochées du mois pas encore comprises dans une répartition arrêtée. */
        resteAArreter: (active ? Money.fromJSON(p.base).subtract(arrete) : Money.zero(cur)).toJSON(),
        simule: sum(sims.map((s) => s.base)).toJSON(),
        distributionId: ds[0]?.id ?? null, distributionIds: ds.map((d) => d.id), simulationIds: sims.map((s) => s.id),
        etat: ds.length ? (verse.equals(calcule) ? 'VERSE' : 'ARRETE') : active ? 'A_ARRETER' : 'SIMULATION',
      };
    });
    return { rows, note: active ? 'Versé = instruction de virement émise (automatiquement après l’acte et la convention, ou après validation à quatre yeux) ; la banque exécute.' : 'Simulation : clé non active, rien n’est arrêté ni versé ; la simulation quotidienne est inscrite en comptes d’ordre du grand livre.' };
  }

  /**
   * Indicateurs du module 73 : écart de répartition (parts − assiette ; flux instruits − inscriptions au grand livre)
   * et délai de versement (arrêté de la répartition → instruction validée).
   */
  indicators() {
    const ops = this.tresor()?.operations.all() ?? [];
    const delays: number[] = [];
    const instructed = new Map<CurrencyCode, Money>();
    let partsGap = 0;
    for (const d of this.distributions.all()) {
      const sum = d.slices.reduce((a, s) => a.add(Money.fromJSON(s.amount)), Money.zero(d.currency));
      if (!sum.equals(Money.fromJSON(d.base))) partsGap += 1;
      for (const f of d.flows) {
        const op = ops.find((o) => o.target.key === `repartition:${d.id}:${f.flow}` && o.status === 'EXECUTEE');
        if (!op) continue;
        instructed.set(d.currency, (instructed.get(d.currency) ?? Money.zero(d.currency)).add(Money.fromJSON(f.amount)));
        if (op.decidedAt) delays.push((Date.parse(op.decidedAt) - Date.parse(d.createdAt)) / 86_400_000);
      }
    }
    const ledger = new Map<CurrencyCode, Money>();
    for (const e of this.ctx.ledger.list()) {
      for (const l of e.lines) {
        if ((l.account !== 'REPARTITION_FLUX_1' && l.account !== 'REPARTITION_FLUX_2') || l.side !== 'DEBIT' || e.reversalOf) continue;
        const m = Money.fromJSON(l.amount);
        ledger.set(m.currency, (ledger.get(m.currency) ?? Money.zero(m.currency)).add(m));
      }
    }
    const currencies = [...new Set<CurrencyCode>([...instructed.keys(), ...ledger.keys()])].sort();
    const round1 = (n: number) => Math.round(n * 10) / 10;
    // Délai entre le rapprochement de chaque paiement réparti et l'instruction du dernier flux de sa répartition.
    const sinceReconciliation: number[] = [];
    for (const d of this.distributions.all()) {
      const decided = d.flows.map((f) => ops.find((o) => o.target.key === `repartition:${d.id}:${f.flow}` && o.status === 'EXECUTEE')?.decidedAt);
      if (decided.some((x) => !x)) continue;
      const last = Math.max(...decided.map((x) => Date.parse(x!)));
      for (const id of d.orderIds ?? []) {
        const rec = this.ctx.payments.orders.get(id)?.reconciledAt;
        if (rec) sinceReconciliation.push((last - Date.parse(rec)) / 86_400_000);
      }
    }
    // Comptes d'ordre du grand livre (module 59) : assiette inscrite = assiette arrêtée (ou simulée), au centime.
    const orderLedger = (account: LedgerAccount) => {
      const m = new Map<CurrencyCode, Money>();
      for (const e of this.ctx.ledger.list()) for (const l of e.lines) {
        if (l.account !== account) continue;
        const a = Money.fromJSON(l.amount);
        m.set(a.currency, (m.get(a.currency) ?? Money.zero(a.currency)).add(l.side === 'CREDIT' ? a : a.negate()));
      }
      return m;
    };
    const compareOrder = (account: LedgerAccount, recs: { currency: CurrencyCode; base: MoneyJSON }[]) => {
      const gl = orderLedger(account);
      const exp = new Map<CurrencyCode, Money>();
      for (const r of recs) exp.set(r.currency, (exp.get(r.currency) ?? Money.zero(r.currency)).add(Money.fromJSON(r.base)));
      return [...new Set<CurrencyCode>([...gl.keys(), ...exp.keys()])].sort().map((c) => {
        const e = exp.get(c) ?? Money.zero(c); const g = gl.get(c) ?? Money.zero(c);
        return { currency: c, repartitions: e.toJSON(), grandLivre: g.toJSON(), gap: e.subtract(g).toJSON(), zero: e.equals(g) };
      });
    };
    return {
      grandLivre: {
        arretees: compareOrder('ORDRE_REPARTITION_ASSIETTE', this.distributions.all().filter((d) => (d.ledgerEntryIds?.length ?? 0) > 0)),
        simulees: compareOrder('ORDRE_SIMULATION_ASSIETTE', this.simulations.all()),
        simulations: this.simulations.count(),
      },
      delaiDepuisRapprochement: sinceReconciliation.length
        ? { payments: sinceReconciliation.length, averageDays: round1(sinceReconciliation.reduce((a, b) => a + b, 0) / sinceReconciliation.length), maxDays: round1(Math.max(...sinceReconciliation)) }
        : { payments: 0, averageDays: null, maxDays: null, note: 'Aucune répartition entièrement versée : délai non mesuré (aucune donnée source).' },
      ecartRepartition: {
        distributionsWithPartsGap: partsGap,
        instructedVsLedger: currencies.map((c) => {
          const i = instructed.get(c) ?? Money.zero(c);
          const g = ledger.get(c) ?? Money.zero(c);
          return { currency: c, instructed: i.toJSON(), ledger: g.toJSON(), gap: i.subtract(g).toJSON(), zero: i.equals(g) };
        }),
      },
      delaiVersement: delays.length
        ? { flowsInstructed: delays.length, averageDays: round1(delays.reduce((a, b) => a + b, 0) / delays.length), maxDays: round1(Math.max(...delays)) }
        : { flowsInstructed: 0, averageDays: null, maxDays: null, note: 'Aucun flux instruit : délai non mesuré (aucune donnée source).' },
    };
  }

  /**
   * Réserve « agents et sous-traitants » par module (code de règle), mois et devise (module 67, § 37A.5) : base de la
   * répartition entre agents au prorata des points de résultats vérifiés × note de qualité (jamais du montant liquidé).
   * Calculée sur les recettes rapprochées ; lecture interne (le module qui l'utilise contrôle l'accès).
   */
  reservePerModule(filter: { period?: string; currency?: string } = {}) {
    const k = this.key();
    const { cells } = this.cells(filter);
    const acc = new Map<string, { module: string; period: string; currency: CurrencyCode; base: Money }>();
    for (const c of cells) {
      for (const id of c.orderIds) {
        const o = this.ctx.payments.orders.get(id);
        if (!o) continue;
        const module = this.ctx.assessment.obligations.get(o.obligationId)?.ruleCode ?? 'INCONNU';
        const key = `${module}|${c.period}|${c.currency}`;
        const a = acc.get(key) ?? { module, period: c.period, currency: c.currency, base: Money.zero(c.currency) };
        acc.set(key, { ...a, base: a.base.add(Money.fromJSON(o.amount)) });
      }
    }
    return {
      mode: k.status === 'ACTIVE' ? 'CALCUL' as const : 'SIMULATION' as const,
      pct: k.slices.find((s) => s.code === 'AGENTS_SOUS_TRAITANTS')?.pct ?? null,
      rows: [...acc.values()].sort((a, b) => a.module.localeCompare(b.module) || a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency)).map((a) => ({
        module: a.module, period: a.period, currency: a.currency, base: a.base.toJSON(),
        reserve: allocate(a.base, k.slices).find((p) => p.slice === 'AGENTS_SOUS_TRAITANTS')!.amount.toJSON(),
      })),
    };
  }

  /** Réserve « agents et sous-traitants » par module (code de règle) — indicatif, calculée cellule par cellule. */
  private agentsByModule(cells: Cell[], slices: SliceDef[]) {
    const acc = new Map<string, { module: string; currency: CurrencyCode; base: Money; reserve: Money; payments: number }>();
    for (const c of cells) {
      const byRule = new Map<string, { base: Money; payments: number }>();
      for (const id of c.orderIds) {
        const o = this.ctx.payments.orders.get(id);
        if (!o) continue;
        const code = this.ctx.assessment.obligations.get(o.obligationId)?.ruleCode ?? 'INCONNU';
        const cur = byRule.get(code) ?? { base: Money.zero(c.currency), payments: 0 };
        byRule.set(code, { base: cur.base.add(Money.fromJSON(o.amount)), payments: cur.payments + 1 });
      }
      for (const [module, r] of byRule) {
        const key = `${module}|${c.currency}`;
        const part = allocate(r.base, slices).find((p) => p.slice === 'AGENTS_SOUS_TRAITANTS')!.amount;
        const a = acc.get(key) ?? { module, currency: c.currency, base: Money.zero(c.currency), reserve: Money.zero(c.currency), payments: 0 };
        acc.set(key, { ...a, base: a.base.add(r.base), reserve: a.reserve.add(part), payments: a.payments + r.payments });
      }
    }
    return [...acc.values()].sort((a, b) => a.module.localeCompare(b.module) || a.currency.localeCompare(b.currency))
      .map((a) => ({ module: a.module, tutelle: tutelleOf(a.module), currency: a.currency, base: a.base.toJSON(), reserve: a.reserve.toJSON(), payments: a.payments }));
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
        'Arbitré par le maître d’ouvrage (27/09/2026) : la réserve de chaque module est répartie au prorata des points de résultats vérifiés × note de qualité (§ 37A.5), jamais selon le montant liquidé ; la commission de 10 % par ligne n’est plus qu’une vue indicative de cette réserve (quotes-parts par agent, équipe et sous-traitant ci-dessous).',
      ],
      // Quotes-parts calculées par points (module 67) : payables = points validés ; la somme reste dans la réserve.
      pointsShares: rows.map((r) => {
        const reserve = sanctions?.reserve;
        if (!reserve) return { period: r.period, currency: r.currency, computed: false as const };
        const c = reserve.compute(r.period);
        const sum = (f: (a: (typeof c.agents)[number]) => MoneyJSON[]) => c.agents.flatMap(f).filter((m) => m.currency === r.currency).reduce((a, m) => a.add(Money.fromJSON(m)), Money.zero(r.currency));
        const distributed = sum((a) => a.share);
        return {
          period: r.period, currency: r.currency, computed: true as const, reserve: r.reserve, distributed: distributed.toJSON(), payable: sum((a) => a.payable).toJSON(),
          undistributed: Money.fromJSON(r.reserve).subtract(distributed).toJSON(), agents: c.agents.length,
          withinReserve: distributed.compare(Money.fromJSON(r.reserve)) <= 0,
        };
      }),
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
   * n'est émis ici : chaque flux attend la validation d'une seconde personne habilitée du Trésor. Voie conservée à côté
   * de l'exécution automatique (acte + convention) : les paiements déjà répartis n'entrent jamais deux fois.
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
    if (!pctSumIs100(k.slices)) {
      this.alertIfNot100(k, false, true);
      throw conflict('REPARTITION_ECART_100', 'La somme des parts de la clé n’est pas égale à 100 % : aucune proposition (alerte transmise à l’audit).');
    }
    const fixed = this.fix(k, { period: input.period, currency: input.currency, by: user.id, actor: actorOf(user), mode: 'MANUEL', filter: { period: input.period } });
    if ('error' in fixed) throw fixed.error;
    const d = fixed.distribution;
    const operations = FLOW_CODES.map((flow) => tresor.propose(user, { kind: 'DECAISSEMENT_REPARTITION', reason: input.reason, repartition: { distributionId: d.id, flow } }));
    return { distribution: this.listDistributions().find((x) => x.id === d.id)!, operations };
  }

  /** Paiements compris dans une répartition arrêtée « vivante » (au moins un flux non rejeté). */
  private liveOrderIds(): Set<string> {
    return new Set(this.distributions.all().filter((d) => this.isLive(d)).flatMap((d) => d.orderIds ?? []));
  }

  /**
   * Arrête une répartition RÉELLE (clé ACTIVE) : assiette des paiements rapprochés non encore répartis, régularisations
   * automatiques (paiements répartis puis remboursés ou contrepassés), contrôle à 100 %, inscription au grand livre en
   * comptes d'ordre de la répartition arrêtée. Retourne une erreur (sans rien écrire) si l'assiette est nulle ou
   * incohérente.
   */
  private fix(k: DistributionKey, input: {
    period: string; currency: CurrencyCode; by: string; actor: AuditActor; mode: 'MANUEL' | 'AUTOMATIQUE';
    filter?: { period?: string }; before?: number;
  }): { distribution: Distribution } | { error: Error } {
    const fromMonth = k.activatedAt ? month(k.activatedAt) : undefined;
    const { cells } = this.cells({ ...(input.filter ?? {}), currency: input.currency }, { exclude: this.liveOrderIds(), ...(input.before !== undefined ? { before: input.before } : {}), ...(fromMonth ? { fromMonth } : {}) });
    const agg = this.aggregate(cells, k.slices, input.currency);
    const pending = this.pendingRegularisations(input.currency);
    const regAmount = pending.reduce((a, p) => a.add(Money.fromJSON(p.amount)), Money.zero(input.currency));
    if (Money.fromJSON(agg.base).isZero() && (input.mode === 'MANUEL' || regAmount.isZero())) {
      return { error: unprocessable('ASSIETTE_NULLE', `Aucune recette rapprochée en ${input.currency} pour ${input.period}.`) };
    }
    if (!agg.check.equalsBase || !agg.check.flowsEqualBase) {
      this.alertIfNot100(k, true, false);
      return { error: conflict('REPARTITION_INCOHERENTE', 'La somme des parts diffère de l’assiette : aucune proposition.') };
    }
    const orderIds = cells.flatMap((c) => c.orderIds).sort();
    // Régularisation automatique : paiements d'une répartition antérieure remboursés ou contrepassés depuis.
    const regParts = regAmount.isZero() ? [] : allocate(regAmount, k.slices);
    const slices = agg.slices.map((s) => {
      const r = regParts.find((p) => p.slice === s.slice)?.amount ?? Money.zero(input.currency);
      return { slice: s.slice, label: s.label, pct: s.pct, flow: s.flow, amount: Money.fromJSON(s.amount).subtract(r).toJSON() };
    });
    if (slices.some((s) => Money.fromJSON(s.amount).isNegative())) {
      this.ctx.alerts.raise({ type: 'REPARTITION_REGULARISATION_REPORTEE', severity: 'HIGH', source: 'repartition', detail: `Régularisations en attente (${regAmount.toJSON().amount} ${input.currency}) supérieures à une part de la répartition ${input.period} : reportées, arbitrage du Trésor requis.`, context: { period: input.period, currency: input.currency }, notifyRoles: ['R17', 'R22'] });
      return { error: unprocessable('REGULARISATION_SUPERIEURE', `Les régularisations en attente (${regAmount.toJSON().amount} ${input.currency}) dépassent une part de la répartition de ${input.period} : arbitrage du Trésor requis.`, { pending }) };
    }
    const netBase = Money.fromJSON(agg.base).subtract(regAmount);
    const flowAmounts = flowsOf(slices.map((s) => ({ slice: s.slice, amount: Money.fromJSON(s.amount) })), k.slices, input.currency);
    // Contrôle à 100 % de la répartition arrêtée (parts nettes = assiette nette ; flux = assiette nette).
    const sumParts = slices.reduce((a, s) => a.add(Money.fromJSON(s.amount)), Money.zero(input.currency));
    if (!sumParts.equals(netBase) || !flowAmounts.FLUX_1.add(flowAmounts.FLUX_2).equals(netBase)) {
      this.alertIfNot100(k, true, false);
      return { error: conflict('REPARTITION_INCOHERENTE', 'La somme des parts diffère de l’assiette : aucune proposition.') };
    }
    const id = this.ids.next('REP');
    const regularisation = pending.length ? { orderIds: pending.map((p) => p.orderId), amount: regAmount.toJSON(), fromDistributions: [...new Set(pending.map((p) => p.distributionId))], slices: regParts.map((p) => ({ slice: p.slice, amount: p.amount.toJSON() })) } : undefined;
    const ledgerEntryIds = this.postAllocation('ARRETEE', { id, period: input.period, currency: input.currency }, agg.slices.map((s) => ({ slice: s.slice, amount: Money.fromJSON(s.amount) })), regParts, regularisation?.fromDistributions ?? []);
    const d = this.distributions.insert({
      id, keyId: k.id, keyVersion: k.version, period: input.period, currency: input.currency, base: netBase.toJSON(), payments: agg.payments,
      basisSha256: createHash('sha256').update(canonicalJson(orderIds)).digest('hex'),
      slices,
      flows: FLOW_CODES.map((f) => ({ flow: f, amount: flowAmounts[f].toJSON() })), createdBy: input.by, createdAt: this.now(),
      mode: input.mode, ...(input.before !== undefined ? { cutoff: new Date(input.before).toISOString() } : {}), ledgerEntryIds,
      orderIds, grossBase: agg.base,
      ...(regularisation ? { regularisation } : {}),
    });
    this.ctx.audit.append({ actor: input.actor, action: 'repartition.distribution.fixed', resourceType: 'repartition_distribution', resourceId: d.id, details: { period: d.period, currency: d.currency, base: d.base, grossBase: agg.base, regularisation: d.regularisation?.amount ?? null, basisSha256: d.basisSha256, mode: input.mode, ledgerEntryIds } });
    return { distribution: d };
  }

  /**
   * Inscription au grand livre (module 59) d'une répartition, en COMPTES D'ORDRE : assiette au crédit, quatre parts au
   * débit (écriture équilibrée) ; une régularisation (remboursement ou contrepassation d'un paiement déjà réparti) est
   * inscrite par une écriture inverse liée aux répartitions d'origine. Aucun compte de fonds n'est touché.
   */
  private postAllocation(kind: 'SIMULATION' | 'ARRETEE', rec: { id: string; period: string; currency: CurrencyCode }, gross: { slice: SliceCode; amount: Money }[], reg: { slice: SliceCode; amount: Money }[], fromDistributions: string[]): string[] {
    const acc = ORDER_ACCOUNTS[kind];
    const ids: string[] = [];
    const lines = (parts: { slice: SliceCode; amount: Money }[], sideParts: 'DEBIT' | 'CREDIT') => {
      const total = parts.reduce((a, p) => a.add(p.amount), Money.zero(rec.currency));
      return [
        ...parts.filter((p) => !p.amount.isZero()).map((p) => ({ account: acc.parts[p.slice], side: sideParts, amount: p.amount.toJSON() })),
        { account: acc.base, side: sideParts === 'DEBIT' ? 'CREDIT' as const : 'DEBIT' as const, amount: total.toJSON() },
      ];
    };
    const label = kind === 'SIMULATION' ? 'Répartition SIMULÉE (clé non active, comptes d’ordre)' : 'Répartition ARRÊTÉE (comptes d’ordre)';
    const sourceType = kind === 'SIMULATION' ? 'repartition_simulation' : 'repartition_distribution';
    if (gross.some((p) => !p.amount.isZero())) {
      ids.push(this.ctx.ledger.post({
        eventType: kind === 'SIMULATION' ? 'REPARTITION_SIMULEE' : 'REPARTITION_ARRETEE', description: `${label} ${rec.id} — ${rec.period}, ${rec.currency} (§ 37A)`,
        sourceType, sourceId: rec.id, lines: lines(gross, 'DEBIT'),
      }).id);
    }
    if (reg.some((p) => !p.amount.isZero())) {
      ids.push(this.ctx.ledger.post({
        eventType: 'REPARTITION_REGULARISATION', description: `Régularisation automatique (remboursements ou contrepassations) de ${fromDistributions.join(', ')} sur ${rec.id} — ${rec.currency}`,
        sourceType, sourceId: rec.id, lines: lines(reg, 'CREDIT'),
      }).id);
    }
    return ids;
  }

  // ————————————————————————————————————————— exécution automatique (acte + convention) et simulation quotidienne

  /** Enregistrement de la convention tripartite de règlement (périodicité, comptes bénéficiaires verrouillés du coffre). */
  recordConvention(user: User, id: string, input: Omit<SettlementConvention, 'recordedBy' | 'recordedAt'>): DistributionKey {
    authorize(user, 'repartition:act.record');
    const k = this.requireKey(id);
    if (!PERIODICITES.includes(input.periodicite)) throw badRequest('PERIODICITE_INCONNUE', `Périodicité inconnue : ${input.periodicite}.`);
    const flows = new Set<string>(input.beneficiaries.map((b) => b.flow));
    if ([...flows].some((f) => !(FLOW_CODES as readonly string[]).includes(f))) {
      throw unprocessable('FLUX_NON_AUTORISE', 'Deux flux de décaissement seulement (Flux 1 Groupe Nseya, Flux 2 Gouvernement provincial) : aucun troisième bénéficiaire (§ 37A.4).');
    }
    const seen = new Set<string>();
    for (const b of input.beneficiaries) {
      const key = `${b.flow}|${b.currency}`;
      if (seen.has(key)) throw unprocessable('BENEFICIAIRE_EN_DOUBLE', `Un seul compte bénéficiaire par flux et par devise (${b.flow}, ${b.currency}).`);
      seen.add(key);
      const acc = this.ctx.vault.current(b.alias);
      if (!acc) throw unprocessable('UNKNOWN_BENEFICIARY_ALIAS', `Alias inconnu du coffre des comptes bénéficiaires : ${b.alias} (aucun numéro de compte n’est saisi ici).`);
      if (acc.currency !== b.currency) throw unprocessable('DEVISE_COMPTE', `Le compte verrouillé ${b.alias} est en ${acc.currency}, pas en ${b.currency}.`);
    }
    // Un même compte ne reçoit jamais les deux flux (séparation des bénéficiaires, § 37A.4).
    const f1 = new Set(input.beneficiaries.filter((b) => b.flow === 'FLUX_1').map((b) => b.alias));
    if (input.beneficiaries.some((b) => b.flow === 'FLUX_2' && f1.has(b.alias))) throw unprocessable('COMPTE_COMMUN_AUX_FLUX', 'Un même compte bénéficiaire ne peut recevoir les deux flux.');
    if (!flows.has('FLUX_1') || !flows.has('FLUX_2')) throw unprocessable('BENEFICIAIRES_INCOMPLETS', 'La convention désigne un compte verrouillé pour chacun des deux flux.');
    const convention: SettlementConvention = { ...input, recordedBy: user.id, recordedAt: this.now() };
    const out = this.keys.update({ ...k, convention, history: this.history(k, user.id, k.convention ? 'CONVENTION_REMPLACEE' : 'CONVENTION_ENREGISTREE', `${input.reference} — ${input.bank}, périodicité ${input.periodicite.toLowerCase()}`) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'repartition.convention.recorded', resourceType: 'repartition_key', resourceId: k.id, details: { reference: input.reference, bank: input.bank, periodicite: input.periodicite, documentSha256: input.documentSha256, beneficiaries: input.beneficiaries } });
    this.ctx.alerts.raise({ type: 'REPARTITION_CONVENTION', severity: 'HIGH', source: 'repartition', detail: `Convention tripartite ${input.reference} enregistrée par ${user.id} (périodicité ${input.periodicite.toLowerCase()}).`, context: { keyId: k.id }, notifyRoles: ['R22', 'R17'] });
    return out;
  }

  /** Échéance courante de la convention : fin (exclusive) de la dernière période close et libellé de cette période. */
  private dueCutoff(periodicite: Periodicite, now: Date): { cutoff: number; period: string } {
    const today = kinshasaDate(now);
    const start = kinDayStart(today);
    if (periodicite === 'QUOTIDIENNE') return { cutoff: start, period: kinshasaDate(new Date(start - DAY_MS)) };
    if (periodicite === 'HEBDOMADAIRE') {
      const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = lundi
      const monday = start - dow * DAY_MS;
      return { cutoff: monday, period: `${kinshasaDate(new Date(monday - 7 * DAY_MS))}/${kinshasaDate(new Date(monday - DAY_MS))}` };
    }
    const first = kinDayStart(`${today.slice(0, 7)}-01`);
    return { cutoff: first, period: kinshasaDate(new Date(first - DAY_MS)).slice(0, 7) };
  }

  /** État de l'automatisation (écran de la répartition) : conditions réunies, prochaine exécution, dernière exécution. */
  automation() {
    const k = this.key();
    const missing: string[] = [];
    if (k.status !== 'ACTIVE') missing.push('Clé ACTIVE (acte juridique enregistré et activation décidée par deux personnes)');
    if (!k.legalAct) missing.push('Acte juridique enregistré');
    if (!k.convention) missing.push('Convention tripartite de règlement enregistrée (périodicité, comptes bénéficiaires verrouillés)');
    const last = this.runs.all().at(-1) ?? null;
    return {
      mode: k.status === 'ACTIVE' && k.convention ? 'EXECUTION_AUTOMATIQUE' as const : k.status === 'ACTIVE' ? 'PROPOSITION_QUATRE_YEUX' as const : 'SIMULATION_QUOTIDIENNE' as const,
      periodicite: k.convention?.periodicite ?? null,
      convention: k.convention ? { ...k.convention } : null,
      missing, lastRun: last,
      simulations: this.simulations.all().slice(-30).reverse(),
      rule: k.status === 'ACTIVE' && k.convention
        ? 'Exécution AUTOMATIQUE des deux flux après le rapprochement, selon la périodicité de la convention, vers les comptes verrouillés du coffre ; piste d’audit complète ; aucun troisième flux.'
        : 'Avant l’acte et la convention : simulation quotidienne inscrite en comptes d’ordre du grand livre ; aucun fonds ne bouge.',
    };
  }

  /**
   * Traitement quotidien (planifié ; déclenchable par le Trésor ou l'audit) :
   *  - clé non ACTIVE : répartition SIMULÉE des recettes rapprochées avant le jour courant, inscrite en comptes d'ordre ;
   *  - clé ACTIVE sans convention : rien d'automatique (propositions à quatre yeux seulement) ;
   *  - clé ACTIVE + convention : à l'échéance de la périodicité, répartition arrêtée puis les DEUX flux EXÉCUTÉS
   *    automatiquement (instruction de virement vers les comptes verrouillés), avec écritures au grand livre.
   * Idempotent : une période et une devise ne sont traitées qu'une fois ; un paiement n'entre qu'une fois.
   */
  runAutomatic(trigger?: User) {
    if (trigger) authorize(trigger, 'repartition:automation.run');
    const k = this.key();
    const now = this.ctx.clock.now();
    const created: string[] = [];
    const skipped: { currency?: string; reason: string }[] = [];
    const record = (mode: 'SIMULATION' | 'EXECUTION' | 'AUCUN') => {
      const run = this.runs.insert({ id: this.ids.next('RUN'), at: now.toISOString(), trigger: trigger?.id ?? 'planificateur', mode, created, skipped });
      this.ctx.audit.append({ actor: trigger ? actorOf(trigger) : AUTO_ACTOR, action: 'repartition.automation.run', resourceType: 'repartition_key', resourceId: k.id, details: { runId: run.id, mode, created, skipped } });
      return { run, automation: this.automation(), created: created.map((id) => this.distributions.get(id) ?? this.simulations.get(id)) };
    };
    if (!pctSumIs100(k.slices)) {
      this.alertIfNot100(k, false, true);
      skipped.push({ reason: 'REPARTITION_ECART_100' });
      return record('AUCUN');
    }
    const currencies = (exclude: Set<string>, before: number, fromMonth?: string) => [...new Set(this.ctx.payments.orders.all()
      .filter((o) => o.reconciledAt && !exclude.has(o.id) && Date.parse(o.reconciledAt) < before && (!fromMonth || month(o.reconciledAt) >= fromMonth))
      .map((o) => o.amount.currency))];

    if (k.status !== 'ACTIVE') {
      const day = kinshasaDate(now);
      const before = kinDayStart(day);
      const done = new Set(this.simulations.all().flatMap((x) => x.orderIds));
      const curs = new Set<CurrencyCode>([...currencies(done, before), ...this.pendingSimRegularisations().map((p) => p.currency)]);
      for (const cur of [...curs].sort()) {
        if (this.simulations.findOne((x) => x.period === day && x.currency === cur)) { skipped.push({ currency: cur, reason: 'DEJA_SIMULEE' }); continue; }
        const sim = this.simulate(k, day, cur, before, done);
        if ('error' in sim) skipped.push({ currency: cur, reason: sim.error });
        else created.push(sim.id);
      }
      return record('SIMULATION');
    }
    if (!k.convention) {
      skipped.push({ reason: 'CONVENTION_REQUISE' });
      return record('AUCUN');
    }
    const tresor = this.tresor();
    if (!tresor) { skipped.push({ reason: 'TRESOR_INDISPONIBLE' }); return record('AUCUN'); }
    const convention = k.convention;
    const { cutoff, period } = this.dueCutoff(convention.periodicite, now);
    const fromMonth = k.activatedAt ? month(k.activatedAt) : undefined;
    const curs = new Set<CurrencyCode>([...currencies(this.liveOrderIds(), cutoff, fromMonth), ...this.pendingRegularisations().map((p) => p.currency)]);
    for (const cur of [...curs].sort()) {
      if (this.distributions.findOne((d) => d.mode === 'AUTOMATIQUE' && d.period === period && d.currency === cur && this.isLive(d))) { skipped.push({ currency: cur, reason: 'DEJA_EXECUTEE' }); continue; }
      const missingAccount = FLOW_CODES.filter((f) => !convention.beneficiaries.some((b) => b.flow === f && b.currency === cur));
      if (missingAccount.length) {
        skipped.push({ currency: cur, reason: 'COMPTE_BENEFICIAIRE_ABSENT' });
        this.ctx.alerts.raise({ type: 'REPARTITION_COMPTE_ABSENT', severity: 'HIGH', source: 'repartition', detail: `Aucun compte bénéficiaire verrouillé pour ${missingAccount.join(', ')} en ${cur} : exécution automatique suspendue pour cette devise.`, context: { currency: cur }, notifyRoles: ['R17', 'R22'] });
        continue;
      }
      const fixed = this.fix(k, { period, currency: cur, by: AUTO_EXECUTOR_ID, actor: AUTO_ACTOR, mode: 'AUTOMATIQUE', before: cutoff });
      if ('error' in fixed) { skipped.push({ currency: cur, reason: (fixed.error as { code?: string }).code ?? fixed.error.message }); continue; }
      const d = fixed.distribution;
      for (const flow of FLOW_CODES) {
        tresor.executeRepartitionAutomatically(
          { kind: 'DECAISSEMENT_REPARTITION', reason: `Exécution automatique ${period} — acte ${k.legalAct?.reference ?? '?'}, convention ${convention.reference}`, repartition: { distributionId: d.id, flow } },
          AUTO_USER, AUTO_ACTOR, { acte: k.legalAct?.reference ?? '', convention: convention.reference },
        );
      }
      created.push(d.id);
    }
    return record('EXECUTION');
  }

  /** Paiements compris dans une simulation, depuis remboursés ou contrepassés, pas encore régularisés en simulation. */
  pendingSimRegularisations() {
    const done = new Set(this.simulations.all().flatMap((d) => d.regularisation?.orderIds ?? []));
    const out: { orderId: string; distributionId: string; currency: CurrencyCode; amount: MoneyJSON }[] = [];
    for (const d of this.simulations.all()) {
      for (const id of d.orderIds) {
        if (done.has(id)) continue;
        const o = this.ctx.payments.orders.get(id);
        if (!o || (o.status !== 'REMBOURSE' && o.status !== 'CONTREPASSE')) continue;
        out.push({ orderId: o.id, distributionId: d.id, currency: d.currency, amount: o.amount });
      }
    }
    return out;
  }

  /** Simulation d'une journée et d'une devise (clé non active), inscrite en comptes d'ordre. */
  private simulate(k: DistributionKey, day: string, cur: CurrencyCode, before: number, done: Set<string>): SimulatedDistribution | { error: string } {
    const { cells } = this.cells({ currency: cur }, { exclude: done, before });
    const agg = this.aggregate(cells, k.slices, cur);
    const pending = this.pendingSimRegularisations().filter((p) => p.currency === cur);
    const regAmount = pending.reduce((a, p) => a.add(Money.fromJSON(p.amount)), Money.zero(cur));
    if (Money.fromJSON(agg.base).isZero() && regAmount.isZero()) return { error: 'ASSIETTE_NULLE' };
    if (!agg.check.equalsBase || !agg.check.flowsEqualBase) { this.alertIfNot100(k, true, false); return { error: 'REPARTITION_INCOHERENTE' }; }
    const regParts = regAmount.isZero() ? [] : allocate(regAmount, k.slices);
    // Régularisation supérieure aux parts du jour : simulée quand même (comptes d'ordre) ; le solde négatif reste visible.
    const slices = agg.slices.map((s) => ({ slice: s.slice, amount: Money.fromJSON(s.amount).subtract(regParts.find((p) => p.slice === s.slice)?.amount ?? Money.zero(cur)) }));
    const flows = flowsOf(slices, k.slices, cur);
    const id = this.ids.next('SIM');
    const orderIds = cells.flatMap((c) => c.orderIds).sort();
    const fromDistributions = [...new Set(pending.map((p) => p.distributionId))];
    const ledgerEntryIds = this.postAllocation('SIMULATION', { id, period: day, currency: cur }, agg.slices.map((s) => ({ slice: s.slice, amount: Money.fromJSON(s.amount) })), regParts, fromDistributions);
    const sim = this.simulations.insert({
      id, keyId: k.id, keyVersion: k.version, period: day, cutoff: new Date(before).toISOString(), currency: cur,
      base: Money.fromJSON(agg.base).subtract(regAmount).toJSON(), grossBase: agg.base, payments: agg.payments, orderIds,
      basisSha256: createHash('sha256').update(canonicalJson(orderIds)).digest('hex'),
      slices: slices.map((s) => ({ slice: s.slice, amount: s.amount.toJSON() })), flows: FLOW_CODES.map((f) => ({ flow: f, amount: flows[f].toJSON() })),
      ...(pending.length ? { regularisation: { orderIds: pending.map((p) => p.orderId), amount: regAmount.toJSON(), fromDistributions, slices: regParts.map((p) => ({ slice: p.slice, amount: p.amount.toJSON() })) } } : {}),
      ledgerEntryIds, createdAt: this.now(),
    });
    this.ctx.audit.append({ actor: AUTO_ACTOR, action: 'repartition.simulation.posted', resourceType: 'repartition_simulation', resourceId: sim.id, details: { period: day, currency: cur, base: sim.base, regularisation: sim.regularisation?.amount ?? null, ledgerEntryIds } });
    return sim;
  }

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Planification du traitement quotidien (idempotent : chaque tick ne traite que ce qui n'a pas été traité). */
  startScheduler(intervalMs: number): void {
    this.stopScheduler();
    this.timer = setInterval(() => { try { this.runAutomatic(); } catch { /* chaque étape est journalisée */ } }, intervalMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

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
  executed(op: FinancialOperation, user: User, at: string, actor: AuditActor = actorOf(user)): Record<string, unknown> {
    const r = op.input.repartition!;
    const d = this.distributions.get(r.distributionId)!;
    const flow = r.flow as FlowCode;
    const amount = d.flows.find((f) => f.flow === flow)!.amount;
    // Compte bénéficiaire VERROUILLÉ du coffre (module 60) désigné par la convention : seul l'alias sort du coffre.
    const alias = this.key().convention?.beneficiaries.find((b) => b.flow === flow && b.currency === d.currency)?.alias;
    const beneficiaryAlias = alias ? this.ctx.vault.resolveAlias(alias) : null;
    const accountVersion = alias ? this.ctx.vault.current(alias)?.version ?? null : null;
    // Grand livre (module 59, § 37A) : chaque répartition instruite est inscrite, en partie double et en ajout seul.
    const entry = Money.fromJSON(amount).isZero() ? undefined : this.ctx.ledger.postPair({
      eventType: 'REPARTITION_INSTRUCTED', description: `${FLOWS[flow].label} — répartition ${d.id} (${d.period}, ${d.currency}), opération ${op.id}${beneficiaryAlias ? `, compte verrouillé ${beneficiaryAlias}` : ''}`,
      sourceType: 'repartition_distribution', sourceId: d.id, debit: flow === 'FLUX_1' ? 'REPARTITION_FLUX_1' : 'REPARTITION_FLUX_2', credit: 'COMPTE_PUBLIC_RECETTES', amount,
    });
    this.ctx.audit.append({ actor, action: 'repartition.flow.instructed', resourceType: 'repartition_distribution', resourceId: d.id, details: { flow, amount, operationId: op.id, proposedBy: op.proposedBy, at, beneficiaryAlias, accountVersion, automatic: op.proposedBy === AUTO_EXECUTOR_ID } });
    return {
      distributionId: d.id, flow, beneficiary: FLOWS[flow].beneficiary, beneficiaryAlias, accountVersion, amount, instruction: 'EMISE', ledgerEntryId: entry?.id ?? null,
      note: 'Instruction de virement émise vers la banque de règlement (compte bénéficiaire verrouillé) ; aucun fonds ne transite par MOSOLO.',
    };
  }
}
