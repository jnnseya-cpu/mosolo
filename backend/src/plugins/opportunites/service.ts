/**
 * Service du module « opportunités » (Cahier v2.9, chapitre 8).
 * - Registre des gisements (§ 8.1, § 8.2) instruits avec la grille du § 8.3 et le pipeline en huit étapes du § 8.4 ;
 *   chaque étape est complétée par une personne du rôle responsable, journalisée ; la décision (activation, report,
 *   abandon, motivée) appartient à l'autorité compétente et l'ACTIVATION exige une base légale (règle ACTIVE du registre
 *   ou acte EN VIGUEUR). L'activation ne crée ni règle ni obligation.
 * - Moteur de recoupement (§ 8.5) : sources sous protocole signé + vérification Code du numérique, sinon aucune
 *   ingestion ; chaque règle produit une LISTE DE TRAVAIL PRIORISÉE, jamais un avis d'imposition.
 * - Douze leviers (§ 8.6) mesurés sur les données existantes, sinon « non mesuré ».
 * - Moteur de maximisation (§ 8.7) : entrées explicites et datées, aucune entrée inventée ; inconnue ⇒ non classée.
 * Réutilise : registre des règles et des instruments, objets fiscaux, quitus (fiscal), titres par plaque, missions
 * terrain, alertes d'intégrité, concentration des exonérations, agent « Découverte des recettes » (ia), audit, alertes.
 */
import type { PilotResultsService } from './pilotes.js';
import { createHash } from 'node:crypto';
import { distanceM, Money, normalizePlate, type CurrencyCode, type MoneyJSON, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { Principal, User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertAiMay, assertDistinctPerson, authorize, type Access } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { DEMO } from '../../seed.js';
import { certifiedRankOf } from '../../reference/locality-ranks.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { FiscalService } from '../fiscal/service.js';
import type { IaService } from '../ia/service.js';
import type { IntegriteService } from '../integrite/service.js';
import type { TerrainService } from '../terrain/service.js';
import type { TitresService } from '../titres/service.js';
import type { VerticalesService } from '../verticales/service.js';
import {
  BAR_LICENCE_RADIUS_M, CODE_NUMERIQUE, CROSS_RULES, DEFAULT_CROSS_PARAMS, DISCOVERY_DOMAINS, GRID_FIELD_ROLES, GRID_FIELDS, GRID_LABELS,
  LEADS_8_1, LEADS_8_2, LEVERS, MAX_INPUT_KEYS, MAX_INPUT_LABELS, PIPELINE, POTENTIAL_TODO, REVENUE_KIND_LABELS, REVENUE_KINDS, SOURCE_CAHIER,
  type CrossParams, type DecisionOutcome, type GridField, type GridValue, type Hypothesis, type IngestBatch, type LeadSeed, type LegalBasis,
  type MaxInput, type MaxInputKey, type MaxInputs, type Opportunity, type PartnerSource, type RevenueKind, type ServiceBlock, type SignalOrigin,
  type SourceKind, type WorklistItem,
} from './model.js';
import { OPP_ACTIONS as A } from './policy.js';

const CAHIER_AUTHOR = 'cahier-v2.9';
const PAID = ['CONFIRME', 'REGLE', 'RAPPROCHE'];
const UNPAID = ['EMISE', 'EXIGIBLE', 'PARTIELLEMENT_PAYEE', 'EN_RETARD'];

export interface BarRecord { pointRef: string; commune: string; quartier?: string | undefined; lat: number; lon: number; deliveries: number; period?: string | undefined }
export interface MerchantRecord { merchantRef: string; commune: string; quartier?: string | undefined; lat: number; lon: number; active: boolean; lastActivity: string }
export interface PlateRecord { plate: string; checkpoint: string; commune: string; readAt: string }
export interface TenderRecord { taxpayerId: string; service: 'MARCHE_PUBLIC' | 'AUTORISATION'; reference: string; commune?: string | undefined }
export interface BuildingRecord {
  buildingRef: string; buildingObjectId?: string | undefined; commune: string; quartier?: string | undefined; lat: number; lon: number; units: number;
  anomalies: ('VACANT_DECLARE' | 'BAUX_EXPIRES' | 'LOYERS_ATYPIQUES' | 'DOUBLONS')[]; detail?: string | undefined;
}
export type IngestRecord = BarRecord | MerchantRecord | PlateRecord | TenderRecord | BuildingRecord;

export interface SimulationInput {
  label: string; opportunityId?: string | undefined; commune?: string | undefined; targets: number; averageDue: MoneyJSON; complianceProbability: string;
  collectionSpeed: string; censusCostPerTarget: MoneyJSON; controlCostPerTarget: MoneyJSON; contestRisk: MoneyJSON; socialRisk: MoneyJSON;
  hypotheses: { text: string; source: string; date: string }[];
}
export interface Simulation extends SimulationInput { id: string; by: string; at: string; result: Record<string, unknown>; effect: 'AUCUN' }

const ANOMALY_LABELS: Record<BuildingRecord['anomalies'][number], string> = {
  VACANT_DECLARE: 'Déclaré vacant', BAUX_EXPIRES: 'Baux expirés', LOYERS_ATYPIQUES: 'Loyers atypiques', DOUBLONS: 'Doublons',
};

const emptyMax = (kind: RevenueKind): MaxInputs => {
  const e = <T>(): MaxInput<T> => ({ value: null, date: null, source: null, updatedBy: null, updatedAt: null });
  return { revenueKind: kind, legalPotential: e(), complianceProbability: e(), collectionSpeed: e(), censusCost: e(), controlCost: e(), contestRisk: e(), socialRisk: e() };
};
const isFraction = (s: string) => /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(s);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class OpportunitesService {
  readonly opportunities = new InMemoryRepository<Opportunity>();
  readonly sources = new InMemoryRepository<PartnerSource>();
  readonly batches = new InMemoryAppendOnlyRepository<IngestBatch>();
  readonly worklist = new InMemoryRepository<WorklistItem>();
  readonly blocks = new InMemoryRepository<ServiceBlock>();
  readonly simulations = new InMemoryAppendOnlyRepository<Simulation>();
  readonly params = new InMemoryRepository<CrossParams & { id: string }>();
  /** Résultats des pilotes et indicateurs (module 61) — branché par le module (plugin.ts). */
  pilots!: PilotResultsService;
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {
    this.params.insert({ id: 'recoupement', ...DEFAULT_CROSS_PARAMS });
    // Registre du cahier (§ 8.1, § 8.2) : contenu du cahier des charges, présent même sans données de démonstration.
    [...LEADS_8_1, ...LEADS_8_2].forEach((l) => this.opportunities.insert(this.fromLead(l)));
  }

  // ─────────────────────────── utilitaires ───────────────────────────

  private now(): string { return this.ctx.clock.now().toISOString(); }
  private today(): string { return kinshasaDate(this.ctx.clock.now()); }
  private audit(u: User | null, action: string, type: string, id: string, details: Record<string, unknown> = {}, outcome?: 'DENIED') {
    this.ctx.audit.append({ actor: u ? actorOf(u) : { kind: 'system', id: 'opportunites' }, action, resourceType: type, resourceId: id, details, ...(outcome ? { outcome } : {}) });
  }
  private roleIn(u: User, roles: RoleCode[]): RoleCode {
    return u.roles.find((r) => roles.includes(r)) ?? u.roles[0]!;
  }
  private ext<S>(name: string): S | undefined { return this.ctx.ext[name] as S | undefined; }
  get crossParams(): CrossParams & { id: string } { return this.params.get('recoupement')!; }

  private fromLead(l: LeadSeed): Opportunity {
    const at = this.now();
    const src = `${SOURCE_CAHIER}, § ${l.section}`;
    const g = (value: string | null): GridValue => ({ value, source: value ? src : 'À instruire', updatedAt: at, updatedBy: CAHIER_AUTHOR });
    const is81 = l.section === '8.1';
    const grid = Object.fromEntries(GRID_FIELDS.map((f) => [f, g(null)])) as Record<GridField, GridValue>;
    grid.faisabiliteJuridique = g(is81 ? 'Activable à droit constant (§ 8.1) — base légale existante à confirmer par le juriste provincial' : `Acte provincial requis (§ 8.2) — voie juridique : ${l.legalPath}`);
    grid.objectif = g(is81 ? l.nature! : l.objective!);
    grid.texteRequis = g(is81 ? (l.code === 'G81-02' ? 'Aucun texte nouveau pour le principe ; extension par arrêté aux permis de bâtir, mutations et mutations de véhicules' : 'Aucun texte nouveau (§ 8.1)') : l.legalPath!);
    grid.priorite = g(l.priority ? `Priorité ${l.priority} (§ 8.1)` : null);
    return {
      id: `OPP-${l.code}`, code: l.code, title: l.title, section: l.section, track: is81 ? 'SANS_TEXTE_NOUVEAU' : 'ACTE_PROVINCIAL',
      nature: l.nature ?? null, condition: l.condition ?? null, objective: l.objective ?? null, legalPath: l.legalPath ?? null, risksToControl: l.risks ?? null,
      cahierPriority: l.priority ?? null, origin: 'CAHIER', originRef: src, discoveryDomains: l.domains, verticals: l.verticals,
      grid, gridHistory: [],
      potential: { prudent: null, attendu: null, ambitieux: null, hypothesisIds: [], note: POTENTIAL_TODO, updatedAt: at, updatedBy: CAHIER_AUTHOR },
      hypotheses: [
        { id: `${l.code}-H1`, text: 'Les estimations de potentiel restent des ordres de grandeur à confirmer par le recensement pilote.', source: `${SOURCE_CAHIER} (préambule)`, date: this.today(), author: CAHIER_AUTHOR, status: 'ACTIVE', createdAt: at },
        { id: `${l.code}-H2`, text: 'Aucune piste ne peut être activée sans base légale ; lorsqu’un acte nouveau est nécessaire, la voie juridique est indiquée.', source: `${SOURCE_CAHIER} (préambule)`, date: this.today(), author: CAHIER_AUTHOR, status: 'ACTIVE', createdAt: at },
      ],
      steps: [], status: 'EN_INSTRUCTION', decision: null, max: emptyMax(l.revenueKind), source: src, createdAt: at, createdBy: CAHIER_AUTHOR,
    };
  }

  private getOpp(id: string): Opportunity {
    const o = this.opportunities.get(id);
    if (!o) throw notFound('OPPORTUNITY_NOT_FOUND', `Opportunité inconnue : ${id}`);
    return o;
  }

  // ─────────────────────────── référentiels (§ 8.3, § 8.4) ───────────────────────────

  pipeline(u: User) {
    authorize(u, A.read);
    return {
      steps: PIPELINE, grid: { fields: GRID_LABELS, roles: GRID_FIELD_ROLES },
      guardrail: 'Aucune opportunité ne devient une taxe par simple décision algorithmique (§ 8.4).',
      note: 'Chaque étape est complétée par une personne du rôle responsable ; l’IA ne complète ni ne décide aucune étape.',
    };
  }

  discoveryScope(u: User) {
    authorize(u, A.read);
    const ia = this.ext<IaService>('ia');
    const all = this.opportunities.all();
    return {
      agent: { code: 'DECOUVERTE', name: 'Découverte des recettes', loaded: !!ia, never: 'Ne crée aucune règle, aucune obligation, aucune taxe.' },
      domains: DISCOVERY_DOMAINS.map((d) => ({ ...d, opportunities: all.filter((o) => o.discoveryDomains.includes(d.code)).map((o) => ({ id: o.id, title: o.title })) })),
    };
  }

  /** Signaux de l'agent « Découverte des recettes » non encore versés au registre (étape 1 à enregistrer par une personne). */
  iaSignals(u: User) {
    authorize(u, A.read);
    const ia = this.ext<IaService>('ia');
    if (!ia) return { available: false, items: [] };
    const imported = new Set(this.opportunities.find((o) => o.origin === 'IA_DECOUVERTE').map((o) => o.originRef));
    const items = ia.recommendations.find((r) => r.agentCode === 'DECOUVERTE' && !imported.has(r.id))
      .map((r) => ({ id: r.id, situation: r.situation, insight: r.insight, createdAt: r.createdAt, status: r.status }));
    return { available: true, items };
  }

  // ─────────────────────────── registre et pipeline ───────────────────────────

  private progress(o: Opportunity) {
    const done = new Set(o.steps.map((s) => s.n));
    const next = PIPELINE.find((s) => !done.has(s.n) && s.n < 8);
    return {
      completed: o.steps.length + (o.decision ? 1 : 0),
      nextStep: o.decision ? null : next ? { n: next.n, label: next.label, responsible: next.responsible, roles: next.roles } : { n: 8, label: 'Décision', responsible: 'Autorité compétente', roles: PIPELINE[7]!.roles },
    };
  }

  view(o: Opportunity) {
    return {
      ...o, ...this.progress(o),
      stepsView: PIPELINE.map((p) => {
        const s = o.steps.find((x) => x.n === p.n);
        return { ...p, done: p.n === 8 ? !!o.decision : !!s, record: p.n === 8 ? o.decision : s ?? null };
      }),
    };
  }

  list(u: User, f: { section?: string; status?: string; domain?: string } = {}) {
    authorize(u, A.read);
    return this.opportunities.all()
      .filter((o) => (!f.section || o.section === f.section) && (!f.status || o.status === f.status) && (!f.domain || o.discoveryDomains.includes(f.domain)))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((o) => ({ id: o.id, code: o.code, title: o.title, section: o.section, track: o.track, origin: o.origin, cahierPriority: o.cahierPriority, status: o.status, decision: o.decision?.outcome ?? null, domains: o.discoveryDomains, ...this.progress(o) }));
  }

  get(u: User, id: string) {
    authorize(u, A.read);
    return this.view(this.getOpp(id));
  }

  /** Étape 1 (nouveau signal) : une personne habilitée verse au registre un signal de l'IA, du terrain, d'un partenaire ou une anomalie. */
  createSignal(u: User, input: { title: string; origin: Exclude<SignalOrigin, 'CAHIER'>; originRef?: string | undefined; summary: string; domains: string[]; verticals?: string[] | undefined; revenueKind?: RevenueKind | undefined }) {
    authorize(u, A.signal);
    for (const d of input.domains) if (!DISCOVERY_DOMAINS.some((x) => x.code === d)) throw badRequest('UNKNOWN_DOMAIN', `Domaine hors du champ d’analyse (§ 8.4) : ${d}`);
    if (input.origin === 'IA_DECOUVERTE') {
      const rec = input.originRef ? this.ext<IaService>('ia')?.recommendations.get(input.originRef) : undefined;
      if (!rec || rec.agentCode !== 'DECOUVERTE') throw unprocessable('IA_SIGNAL_NOT_FOUND', 'Recommandation de l’agent « Découverte des recettes » introuvable.');
      if (this.opportunities.findOne((o) => o.origin === 'IA_DECOUVERTE' && o.originRef === rec.id)) throw conflict('SIGNAL_ALREADY_IMPORTED', 'Ce signal est déjà au registre.');
    }
    if (input.origin === 'DONNEES_PARTENAIRES' && (!input.originRef || !this.worklist.get(input.originRef))) throw unprocessable('WORKLIST_ITEM_NOT_FOUND', 'Élément de liste de travail du recoupement requis.');
    const at = this.now();
    const n = this.opportunities.find((o) => o.section === 'SIGNAL').length + 1;
    const code = `SIG-${String(n).padStart(3, '0')}`;
    const o: Opportunity = {
      ...this.fromLead({ code, title: input.title, section: '8.1', domains: input.domains, verticals: input.verticals ?? [], revenueKind: input.revenueKind ?? 'RECETTE_NOUVELLE' }),
      id: `OPP-${code}`, section: 'SIGNAL', track: 'A_QUALIFIER', origin: input.origin, originRef: input.originRef ?? null, source: `Signal ${input.origin}`, createdBy: u.id,
    };
    for (const f of GRID_FIELDS) o.grid[f] = { value: null, source: 'À instruire', updatedAt: at, updatedBy: u.id };
    o.hypotheses = o.hypotheses.slice(0, 1).map((h) => ({ ...h, id: `${code}-H1` }));
    o.steps = [{ n: 1, code: 'SIGNAL', completedBy: u.id, role: this.roleIn(u, PIPELINE[0]!.roles), completedAt: at, summary: input.summary }];
    this.opportunities.insert(o);
    this.audit(u, 'opportunite.signal.created', 'opportunite', o.id, { origin: input.origin, originRef: input.originRef ?? null });
    this.audit(u, 'opportunite.step.completed', 'opportunite', o.id, { step: 1, code: 'SIGNAL' });
    return this.view(o);
  }

  /** Étapes 1 à 7 : dans l'ordre, par une personne du rôle responsable. */
  completeStep(p: Principal, id: string, n: number, input: { summary: string; data?: Record<string, unknown> | undefined; scenarios?: { prudent: MoneyJSON | null; attendu: MoneyJSON | null; ambitieux: MoneyJSON | null; hypothesisIds: string[] } | undefined }) {
    assertAiMay(p, 'CREATE_TAX');
    if (!Number.isInteger(n) || n < 1 || n > 7) throw badRequest('INVALID_STEP', 'Étapes 1 à 7 ; la décision (étape 8) passe par la route de décision.');
    const step = PIPELINE[n - 1]!;
    authorize(p, `opportunites:step.${n}`);
    const u = p as User;
    const o = this.getOpp(id);
    if (o.status === 'DECIDEE') throw conflict('OPPORTUNITY_DECIDED', 'Opportunité déjà décidée : son instruction est close.');
    if (o.steps.some((s) => s.n === n)) throw conflict('STEP_ALREADY_COMPLETED', `Étape ${n} (${step.label}) déjà complétée.`);
    const missing = PIPELINE.filter((s) => s.n < n && !o.steps.some((x) => x.n === s.n)).map((s) => `${s.n}. ${s.label}`);
    if (missing.length) throw conflict('STEP_OUT_OF_ORDER', `Étapes préalables non complétées : ${missing.join(', ')}.`, { missing });
    const at = this.now();
    if (n === 3) {
      if (!input.scenarios) throw badRequest('SCENARIOS_REQUIRED', 'Estimation : scénarios conservateur, attendu, ambitieux requis (null si non estimé).');
      this.applyScenarios(u, o, input.scenarios);
    }
    o.steps.push({ n, code: step.code, completedBy: u.id, role: this.roleIn(u, step.roles), completedAt: at, summary: input.summary, ...(input.data ? { data: input.data } : {}) });
    this.opportunities.update(o);
    this.audit(u, 'opportunite.step.completed', 'opportunite', o.id, { step: n, code: step.code });
    return this.view(o);
  }

  /** Scénarios : établis seulement à partir d'hypothèses explicitement documentées (§ 8.4) ; null = à estimer. */
  private applyScenarios(u: User, o: Opportunity, s: { prudent: MoneyJSON | null; attendu: MoneyJSON | null; ambitieux: MoneyJSON | null; hypothesisIds: string[] }) {
    const given = [s.prudent, s.attendu, s.ambitieux].filter((x): x is MoneyJSON => !!x);
    if (given.length) {
      const active = new Set(o.hypotheses.filter((h) => h.status === 'ACTIVE').map((h) => h.id));
      if (!s.hypothesisIds.length || s.hypothesisIds.some((h) => !active.has(h))) {
        throw unprocessable('HYPOTHESES_REQUIRED', 'Tout montant de scénario doit citer au moins une hypothèse ACTIVE, datée et sourcée, de la fiche.');
      }
      if (new Set(given.map((m) => m.currency)).size > 1) throw unprocessable('CURRENCY_MISMATCH', 'Scénarios dans une seule devise.');
    }
    o.potential = {
      prudent: s.prudent, attendu: s.attendu, ambitieux: s.ambitieux, hypothesisIds: s.hypothesisIds,
      note: given.length === 3 ? 'Ordres de grandeur à confirmer par le recensement pilote — non acquis.' : POTENTIAL_TODO, updatedAt: this.now(), updatedBy: u.id,
    };
  }

  /**
   * Étape 8 — décision motivée de l'autorité compétente. ACTIVATION impossible sans base légale : règle ACTIVE du
   * registre ou acte EN VIGUEUR. L'activation ne crée aucune règle ni obligation (garde-fou § 8.4).
   */
  decide(p: Principal, id: string, input: { outcome: DecisionOutcome; motivation: string; legalBasis?: { kind: 'REGLE' | 'ACTE'; ref: string } | undefined }) {
    assertAiMay(p, 'CREATE_TAX');
    authorize(p, A.decide);
    const u = p as User;
    const o = this.getOpp(id);
    if (o.status === 'DECIDEE') throw conflict('OPPORTUNITY_DECIDED', 'Décision déjà rendue.');
    const missing = PIPELINE.filter((s) => s.n < 8 && !o.steps.some((x) => x.n === s.n)).map((s) => `${s.n}. ${s.label}`);
    if (missing.length) throw conflict('PIPELINE_INCOMPLETE', `Décision impossible : étapes non complétées (${missing.join(', ')}).`, { missing });
    assertDistinctPerson(u.id, o.steps.map((s) => s.completedBy), 'L’autorité qui décide ne peut pas avoir instruit une étape de la même opportunité.');
    let legalBasis: LegalBasis | null = null;
    if (input.legalBasis) legalBasis = this.checkLegalBasis(input.legalBasis);
    if (input.outcome === 'ACTIVATION' && !legalBasis) {
      this.audit(u, 'opportunite.activation.refused', 'opportunite', o.id, { reason: 'LEGAL_BASIS_REQUIRED' }, 'DENIED');
      throw unprocessable('LEGAL_BASIS_REQUIRED', 'Activation impossible sans base légale : citer une règle ACTIVE du registre ou un acte EN VIGUEUR. Aucune piste ne devient une taxe sans texte.');
    }
    o.decision = { outcome: input.outcome, motivation: input.motivation, decidedBy: u.id, role: this.roleIn(u, PIPELINE[7]!.roles), at: this.now(), legalBasis, effect: 'AUCUNE_OBLIGATION_CREEE' };
    o.status = 'DECIDEE';
    this.opportunities.update(o);
    this.audit(u, 'opportunite.decided', 'opportunite', o.id, { outcome: input.outcome, legalBasis: legalBasis ? `${legalBasis.kind}:${legalBasis.ref}` : null });
    return this.view(o);
  }

  private checkLegalBasis(b: { kind: 'REGLE' | 'ACTE'; ref: string }): LegalBasis {
    const checkedAt = this.now();
    if (b.kind === 'REGLE') {
      const r = this.ctx.rules.rules.get(b.ref) ?? this.ctx.rules.list().find((x) => x.code === b.ref && x.status === 'ACTIVE');
      if (!r) throw unprocessable('LEGAL_BASIS_NOT_FOUND', `Règle inconnue du registre : ${b.ref}`);
      const fresh = this.ctx.rules.get(r.id);
      if (fresh.status !== 'ACTIVE') throw unprocessable('LEGAL_BASIS_NOT_ACTIVE', `La règle ${fresh.code} v${fresh.version} est au statut ${fresh.status} : seule une règle ACTIVE (quatre visas) fonde une activation.`);
      return { kind: 'REGLE', ref: fresh.id, label: `${fresh.code} v${fresh.version}`, status: fresh.status, checkedAt };
    }
    const i = this.ctx.rules.instrument(b.ref);
    if (!i) throw unprocessable('LEGAL_BASIS_NOT_FOUND', `Acte inconnu du registre juridique : ${b.ref}`);
    if (i.status !== 'EN_VIGUEUR') throw unprocessable('LEGAL_BASIS_NOT_ACTIVE', `L’acte ${i.id} est au statut ${i.status} : seul un acte EN VIGUEUR fonde une activation.`);
    return { kind: 'ACTE', ref: i.id, label: i.title, status: i.status, checkedAt };
  }

  setGridField(u: User, id: string, field: string, input: { value: string | null; reason: string }) {
    authorize(u, A.grid);
    if (!(GRID_FIELDS as readonly string[]).includes(field)) throw badRequest('UNKNOWN_GRID_FIELD', `Rubrique inconnue de la grille (§ 8.3) : ${field}. Le potentiel passe par l’étape 3 (Estimation).`);
    const f = field as GridField;
    if (!u.roles.some((r) => GRID_FIELD_ROLES[f].includes(r))) throw unprocessable('GRID_FIELD_ROLE', `« ${GRID_LABELS[f]} » est instruit par les rôles ${GRID_FIELD_ROLES[f].join(', ')}.`);
    const o = this.getOpp(id);
    if (o.status === 'DECIDEE') throw conflict('OPPORTUNITY_DECIDED', 'Opportunité décidée : la fiche est figée.');
    const at = this.now();
    o.gridHistory.push({ field: f, before: o.grid[f].value, after: input.value, by: u.id, at, reason: input.reason });
    o.grid[f] = { value: input.value, source: `Instruction — ${u.id}`, updatedAt: at, updatedBy: u.id };
    this.opportunities.update(o);
    this.audit(u, 'opportunite.grid.updated', 'opportunite', o.id, { field: f });
    return this.view(o);
  }

  addHypothesis(u: User, id: string, input: { text: string; source: string; date: string; revises?: string | undefined }) {
    authorize(u, A.hypothesis);
    const o = this.getOpp(id);
    if (o.status === 'DECIDEE') throw conflict('OPPORTUNITY_DECIDED', 'Opportunité décidée : la fiche est figée.');
    const hid = `${o.code}-H${o.hypotheses.length + 1}`;
    if (input.revises) {
      const old = o.hypotheses.find((h) => h.id === input.revises);
      if (!old || old.status !== 'ACTIVE') throw unprocessable('HYPOTHESIS_NOT_ACTIVE', 'Seule une hypothèse ACTIVE peut être révisée.');
      old.status = 'REVISEE';
      old.revisedBy = hid;
    }
    const h: Hypothesis = { id: hid, text: input.text, source: input.source, date: input.date, author: u.id, status: 'ACTIVE', createdAt: this.now(), ...(input.revises ? { revises: input.revises } : {}) };
    o.hypotheses.push(h);
    this.opportunities.update(o);
    this.audit(u, input.revises ? 'opportunite.hypothesis.revised' : 'opportunite.hypothesis.added', 'opportunite', o.id, { hypothesisId: hid, revises: input.revises ?? null });
    return this.view(o);
  }

  // ─────────────────────────── § 8.7 : moteur de maximisation ───────────────────────────

  setMaxInput(u: User, id: string, key: MaxInputKey | 'revenueKind', input: { value: MoneyJSON | string | null; date?: string | undefined; source?: string | undefined }) {
    authorize(u, A.maxWrite);
    const o = this.getOpp(id);
    if (key === 'revenueKind') {
      if (typeof input.value !== 'string' || !(REVENUE_KINDS as readonly string[]).includes(input.value)) throw badRequest('INVALID_REVENUE_KIND', `Nature attendue : ${REVENUE_KINDS.join(', ')}`);
      o.max.revenueKind = input.value as RevenueKind;
    } else {
      if (!(MAX_INPUT_KEYS as readonly string[]).includes(key)) throw badRequest('UNKNOWN_INPUT', `Entrée inconnue : ${key}`);
      const fraction = key === 'complianceProbability' || key === 'collectionSpeed';
      if (input.value !== null) {
        if (!input.date || !input.source) throw badRequest('INPUT_UNSOURCED', 'Toute entrée est datée et sourcée (jamais inventée).');
        if (fraction && (typeof input.value !== 'string' || !isFraction(input.value))) throw badRequest('INVALID_FRACTION', 'Valeur décimale entre 0 et 1 attendue (ex. "0.6").');
        if (!fraction && (typeof input.value !== 'object' || !input.value?.currency)) throw badRequest('INVALID_AMOUNT', 'Montant { amount, currency } attendu.');
      }
      (o.max as unknown as Record<string, MaxInput<unknown>>)[key] = { value: input.value, date: input.value === null ? null : input.date!, source: input.value === null ? null : input.source!, updatedBy: u.id, updatedAt: this.now() };
    }
    this.opportunities.update(o);
    this.audit(u, 'opportunite.max_input.updated', 'opportunite', o.id, { key });
    return this.rankOne(o);
  }

  /** Revenu net ajusté au risque = potentiel × conformité × vitesse − recensement − contrôle − contestation − social. */
  private rankOne(o: Opportunity) {
    const m = o.max;
    const missing = MAX_INPUT_KEYS.filter((k) => m[k].value === null).map((k) => MAX_INPUT_LABELS[k]);
    const base = { id: o.id, code: o.code, title: o.title, revenueKind: m.revenueKind, revenueKindLabel: REVENUE_KIND_LABELS[m.revenueKind], inputs: m, decision: o.decision?.outcome ?? null };
    if (missing.length) return { ...base, ranked: false as const, reason: `Non classée — entrées manquantes : ${missing.join(', ')}.`, missing, net: null };
    const money = [m.legalPotential, m.censusCost, m.controlCost, m.contestRisk, m.socialRisk].map((x) => Money.fromJSON(x.value as MoneyJSON));
    if (new Set(money.map((x) => x.currency)).size > 1) return { ...base, ranked: false as const, reason: 'Non classée — entrées en devises différentes (jamais additionnées).', missing: [], net: null };
    const [pot, census, control, contest, social] = money as [Money, Money, Money, Money, Money];
    const gross = pot.multiply(m.complianceProbability.value!).multiply(m.collectionSpeed.value!);
    const net = gross.subtract(census).subtract(control).subtract(contest).subtract(social);
    return {
      ...base, ranked: true as const, reason: null, missing: [],
      grossAdjusted: gross.toJSON(), net: net.toJSON(),
      formula: `${pot.toDecimalString()} × ${m.complianceProbability.value} × ${m.collectionSpeed.value} − ${census.toDecimalString()} − ${control.toDecimalString()} − ${contest.toDecimalString()} − ${social.toDecimalString()} = ${net.toDecimalString()} ${net.currency}`,
    };
  }

  ranking(u: User) {
    authorize(u, A.maxRead);
    const rows = this.opportunities.all().map((o) => this.rankOne(o));
    const ranked = rows.filter((r) => r.ranked).sort((a, b) => {
      const x = Money.fromJSON(a.net as MoneyJSON); const y = Money.fromJSON(b.net as MoneyJSON);
      return x.currency === y.currency ? (y.minor > x.minor ? 1 : y.minor < x.minor ? -1 : 0) : x.currency.localeCompare(y.currency);
    });
    // Tableaux toujours séparés : recettes nouvelles / arriérés / rapprochement / reclassement ; jamais additionnés entre devises.
    const dashboards = REVENUE_KINDS.map((k) => {
      const items = ranked.filter((r) => r.revenueKind === k);
      const totals = new Map<CurrencyCode, Money>();
      for (const r of items) { const n = Money.fromJSON(r.net as MoneyJSON); totals.set(n.currency, (totals.get(n.currency) ?? Money.zero(n.currency)).add(n)); }
      return { kind: k, label: REVENUE_KIND_LABELS[k], ranked: items.length, notRanked: rows.filter((r) => !r.ranked && r.revenueKind === k).length, netByCurrency: [...totals.values()].map((x) => x.toJSON()) };
    });
    return {
      method: 'Revenu net ajusté au risque = potentiel légal × probabilité de conformité × vitesse d’encaissement − coût de recensement − coût de contrôle − risque de contestation − risque social (§ 8.7).',
      rule: 'Entrées explicites, datées, sourcées, modifiables par l’analyste ; une entrée inconnue exclut l’opportunité du classement (jamais d’estimation implicite).',
      ranked, notRanked: rows.filter((r) => !r.ranked), dashboards,
    };
  }

  simulate(u: User, input: SimulationInput): Simulation {
    authorize(u, A.simulate);
    if (!input.hypotheses.length) throw badRequest('HYPOTHESES_REQUIRED', 'Une simulation repose sur des hypothèses explicites, datées et sourcées.');
    if (!isFraction(input.complianceProbability) || !isFraction(input.collectionSpeed)) throw badRequest('INVALID_FRACTION', 'Probabilité et vitesse entre 0 et 1.');
    const ms = [input.averageDue, input.censusCostPerTarget, input.controlCostPerTarget, input.contestRisk, input.socialRisk].map((x) => Money.fromJSON(x));
    if (new Set(ms.map((x) => x.currency)).size > 1) throw unprocessable('CURRENCY_MISMATCH', 'Une simulation se fait dans une seule devise.');
    if (input.opportunityId) this.getOpp(input.opportunityId);
    const [avg, census, control, contest, social] = ms as [Money, Money, Money, Money, Money];
    const t = String(input.targets);
    const potential = avg.multiply(t);
    const expected = potential.multiply(input.complianceProbability).multiply(input.collectionSpeed);
    const costs = census.multiply(t).add(control.multiply(t));
    const net = expected.subtract(costs).subtract(contest).subtract(social);
    const sim: Simulation = {
      ...input, id: this.ids.next('SIM', 4), by: u.id, at: this.now(), effect: 'AUCUN',
      result: {
        potential: potential.toJSON(), expectedCollected: expected.toJSON(), operatingCosts: costs.toJSON(), risks: contest.add(social).toJSON(), net: net.toJSON(),
        notice: 'Simulation avant lancement : aucune campagne, aucune obligation, aucun envoi. Hypothèses à confirmer.',
      },
    };
    this.simulations.append(sim);
    this.audit(u, 'opportunite.campaign.simulated', 'simulation', sim.id, { opportunityId: input.opportunityId ?? null, targets: input.targets });
    return sim;
  }

  // ─────────────────────────── § 8.6 : douze leviers ───────────────────────────

  levers(u: User) {
    authorize(u, A.read);
    const objs = this.ctx.objects.objects.all();
    const orders = this.ctx.payments.orders.all();
    const appeals = this.ctx.appeals.appeals.all().filter((a) => !!a.decision);
    const exc = this.ctx.treasury.exceptions.find((e) => e.status !== 'RESOLUE');
    const pct = (n: number, d: number) => (d === 0 ? null : `${((n * 100) / d).toFixed(1)} %`);
    type Metric = { measured: boolean; value: string; basis: string; source: string | null };
    const measured = (value: string, basis: string, source: string): Metric => ({ measured: true, value, basis, source });
    const none = (why: string): Metric => ({ measured: false, value: 'non mesuré', basis: why, source: null });
    const valid = objs.filter((o) => o.status === 'VALIDE').length;
    const attached = objs.filter((o) => !!o.taxpayerId).length;
    const founded = appeals.filter((a) => a.decision!.decision !== 'REJETEE').length;
    const converted = orders.filter((o) => PAID.includes(o.status)).length;
    const matches = this.worklist.count();
    const metric: Record<string, Metric> = {
      COUVERTURE: measured(String(valid), `${valid} objet(s) VALIDE(S) au registre sur ${objs.length}`, 'Registre des objets fiscaux'),
      RATTACHEMENT: objs.length ? measured(pct(attached, objs.length)!, `${attached}/${objs.length} objets rattachés à un redevable`, 'Registre des objets fiscaux') : none('Aucun objet au registre.'),
      QUALITE: appeals.length ? measured(`${founded} recours fondé(s)`, `${founded}/${appeals.length} réclamations décidées accueillies (niveau courant ; la baisse se lit entre deux périodes)`, 'Réclamations') : none('Aucune réclamation décidée.'),
      REGLES: none('L’écart de liquidation exige un contrôle de liquidation échantillonné non encore instrumenté.'),
      DECLARATION: none('Taux de dépôt à temps non instrumenté (échéances déclaratives à relier aux dépôts).'),
      PAIEMENT: orders.length ? measured(pct(converted, orders.length)!, `${converted}/${orders.length} ordres confirmés, réglés ou rapprochés`, 'Ordres de paiement') : none('Aucun ordre de paiement.'),
      RAPPROCHEMENT: measured(`${exc.length} exception(s) ouverte(s)`, 'Exceptions de rapprochement non résolues (montants par devise au Trésor)', 'Rapprochement'),
      RECOUVREMENT: none('Le coût de recouvrement n’est pas saisi : rendement par coût non calculable.'),
      FRAUDE: none('La déperdition évitée suppose un contrefactuel ; aucune valeur n’est inventée.'),
      SERVICE: none('Satisfaction et délais : enquête et horodatage de bout en bout à instrumenter.'),
      DONNEES: measured(String(matches), `${matches} correspondance(s) produite(s) par le moteur de recoupement (§ 8.5)`, 'Recoupement'),
      PILOTAGE: none('Aucune cible par zone et catégorie n’est fixée : écart cible / réalisé non calculable.'),
    };
    return { levers: LEVERS.map((l) => ({ ...l, ...metric[l.code]! })), rule: 'Mesure calculée sur les données existantes ; sinon « non mesuré » (jamais de valeur inventée).' };
  }

  // ─────────────────────────── § 8.7 : cas d'usage prioritaires ───────────────────────────

  useCases(u: User) {
    authorize(u, A.maxRead);
    const today = this.today();
    const P = this.crossParams;
    const horizon = new Date(new Date(`${today}T00:00:00Z`).getTime() + P.expiryHorizonDays * 86_400_000).toISOString().slice(0, 10);
    const objs = this.ctx.objects.objects.all();
    const leases = this.ctx.objects.leases.all();
    const obligations = this.ctx.assessment.obligations.all().filter((o) => !o.supersededBy);
    const items = this.worklist.all();

    // 1. Carte des immeubles à forte probabilité de location non recensée (signaux convergents, jamais une dette).
    const layer = new Map<string, { id: string; lat: number; lon: number; commune: string; signals: string[] }>();
    for (const unit of objs.filter((o) => o.category === 'UNITE_LOCATIVE' && !leases.some((l) => l.unitObjectId === o.id))) {
      const key = unit.parentObjectId ?? unit.id;
      const parent = unit.parentObjectId ? objs.find((x) => x.id === unit.parentObjectId) : undefined;
      const e = layer.get(key) ?? { id: key, lat: (parent ?? unit).lat, lon: (parent ?? unit).lon, commune: unit.commune, signals: [] };
      e.signals.push(`Unité ${unit.id} sans bail déclaré`);
      layer.set(key, e);
    }
    for (const it of items.filter((i) => i.ruleCode === 'INCOHERENCE_LOCATIVE' && i.lat !== null && i.lon !== null)) {
      const key = it.subject.ref;
      const e = layer.get(key) ?? { id: key, lat: it.lat!, lon: it.lon!, commune: it.commune ?? '—', signals: [] };
      e.signals.push(`Déclaration partenaire : ${it.variables.find((v) => v.name === 'anomalies')?.value ?? 'incohérence'}`);
      layer.set(key, e);
    }
    const rentalLayer = [...layer.values()].map((e) => ({ ...e, level: e.signals.length >= 2 ? 'FORTE' : 'A_VERIFIER' })).sort((a, b) => b.signals.length - a.signals.length);

    // 2. Commerces visibles × patentes actives, par commune.
    const communes = new Map<string, { commune: string; visible: number; activePatentes: number }>();
    const bump = (c: string | null, k: 'visible' | 'activePatentes') => { if (!c) return; const e = communes.get(c) ?? { commune: c, visible: 0, activePatentes: 0 }; e[k]++; communes.set(c, e); };
    for (const i of items.filter((x) => x.ruleCode === 'COMMERCE_NON_ENREGISTRE' || x.ruleCode === 'BAR_SANS_LICENCE')) bump(i.commune, 'visible');
    const terrain = this.ext<TerrainService>('terrain');
    for (const f of terrain?.findings.find((x) => x.outcome === 'OBJET_NON_ENREGISTRE') ?? []) bump(terrain?.missions.get(f.missionId)?.commune ?? null, 'visible');
    for (const o of objs.filter((x) => x.category === 'ACTIVITE' && obligations.some((ob) => ob.objectId === x.id && ob.status !== 'ANNULEE'))) bump(o.commune, 'activePatentes');

    // 3. Véhicules et autorisations arrivant à échéance.
    const expiring: { kind: string; ref: string; label: string; validUntil: string; commune: string | null }[] = [];
    const titres = this.ext<TitresService>('titres');
    for (const c of titres?.credentials.all() ?? []) {
      const s = titres!.status(c).status;
      if (['EXPIRE', 'INVALIDE', 'SUSPENDU'].includes(s)) continue;
      if (c.validUntil.slice(0, 10) <= horizon && c.validUntil.slice(0, 10) >= today) expiring.push({ kind: c.subject.plate ? 'VEHICULE' : 'TITRE', ref: c.number, label: `${c.module} — ${s}`, validUntil: c.validUntil.slice(0, 10), commune: c.place?.commune ?? null });
    }
    for (const c of this.ext<VerticalesService>('verticales')?.certificates.find((x) => x.status === 'VALIDE' && !!x.validUntil && x.validUntil <= horizon && x.validUntil >= today) ?? []) {
      expiring.push({ kind: 'AUTORISATION', ref: c.code, label: c.label, validUntil: c.validUntil!, commune: c.commune });
    }
    for (const c of this.ext<FiscalService>('fiscal')?.clearances.clearances.find((x) => x.status === 'ACTIF' && x.validUntil <= horizon && x.validUntil >= today) ?? []) {
      expiring.push({ kind: 'QUITUS', ref: c.number, label: 'Quitus fiscal', validUntil: c.validUntil, commune: null });
    }
    expiring.sort((a, b) => a.validUntil.localeCompare(b.validUntil));

    // 4. Paiements confirmés mais non rapprochés.
    const confirmed = this.ctx.payments.orders.find((o) => o.status === 'CONFIRME');
    const confirmedSums = new Map<CurrencyCode, Money>();
    for (const o of confirmed) { const m = Money.fromJSON(o.amount); confirmedSums.set(m.currency, (confirmedSums.get(m.currency) ?? Money.zero(m.currency)).add(m)); }
    const oldest = confirmed.map((o) => o.confirmedAt).filter((x): x is string => !!x).sort()[0] ?? null;

    // 5. Annulations ou exonérations concentrées sur un agent ou une zone (signaux existants d'intégrité et du registre des exonérations).
    const integrite = this.ext<IntegriteService>('integrite');
    const concentrations = [
      ...(integrite?.alerts.find((a) => a.ruleCode === 'CONCENTRATION_ACTES_SENSIBLES' && a.status !== 'CLASSEE').map((a) => ({ source: 'Intégrité', ref: a.id, detail: a.explanation, dimension: 'AGENT' })) ?? []),
      ...(this.ext<FiscalService>('fiscal')?.exemptions.concentrationAlerts().map((c) => ({ source: 'Registre des exonérations', ref: `${c.dimension}:${c.key}`, detail: c.message, dimension: c.dimension === 'COMMUNE' ? 'ZONE' : 'AGENT' })) ?? []),
    ];

    // 6. Prévision hebdomadaire de trésorerie par catégorie et commune (méthode de l'agent Prévision : exigible × taux observé).
    const live = obligations.filter((o) => o.status !== 'ANNULEE' && o.status !== 'ADMISE_EN_NON_VALEUR');
    const paidIds = new Set(this.ctx.payments.orders.find((p) => PAID.includes(p.status)).map((p) => p.obligationId));
    const paidCount = live.filter((o) => o.status === 'SOLDEE' || paidIds.has(o.id)).length;
    const rate = live.length ? (paidCount / live.length).toFixed(4) : null;
    const weeks = new Map<string, { week: number; weekStart: string; category: string; commune: string; due: Money; count: number }>();
    const t0 = new Date(`${today}T00:00:00Z`).getTime();
    for (const o of live.filter((x) => UNPAID.includes(x.status) && !paidIds.has(x.id) && x.dueDate >= today)) {
      const w = Math.floor((new Date(`${o.dueDate}T00:00:00Z`).getTime() - t0) / (7 * 86_400_000));
      if (w >= P.forecastWeeks) continue;
      const m = Money.fromJSON(o.amount);
      const commune = o.attribution?.commune ?? 'Non attribuée';
      const key = `${w}|${o.revenueCategory}|${commune}|${m.currency}`;
      const e = weeks.get(key) ?? { week: w + 1, weekStart: new Date(t0 + w * 7 * 86_400_000).toISOString().slice(0, 10), category: o.revenueCategory, commune, due: Money.zero(m.currency), count: 0 };
      e.due = e.due.add(m); e.count++;
      weeks.set(key, e);
    }
    const forecast = [...weeks.values()].sort((a, b) => a.week - b.week || a.category.localeCompare(b.category) || a.commune.localeCompare(b.commune))
      .map((e) => ({ week: e.week, weekStart: e.weekStart, category: e.category, commune: e.commune, obligations: e.count, due: e.due.toJSON(), expected: rate === null ? null : e.due.multiply(rate).toJSON() }));

    return {
      generatedAt: this.now(), params: P,
      rentalLayer: { note: 'Couche de carte : signaux convergents à vérifier sur le terrain — jamais une dette.', points: rentalLayer },
      shopsVsPatentes: { note: 'Commerces visibles (recoupement, constats terrain) face aux patentes actives (objets « activité » avec obligation liquidée).', rows: [...communes.values()].sort((a, b) => b.visible - b.activePatentes - (a.visible - a.activePatentes)) },
      expiring: { horizonDays: P.expiryHorizonDays, items: expiring },
      confirmedNotReconciled: { count: confirmed.length, byCurrency: [...confirmedSums.values()].map((m) => m.toJSON()), oldestConfirmedAt: oldest },
      concentrations: { note: 'Signaux proposés à l’examen humain (audit, anti-fraude) ; aucune mesure automatique.', items: concentrations },
      forecast: { weeks: P.forecastWeeks, observedPaymentRate: rate, method: 'Exigible par semaine × taux de paiement observé (même méthode que l’agent Prévision) ; indicatif, jamais une assignation.', rows: forecast },
      simulations: this.simulations.all().slice(-10).reverse(),
    };
  }

  // ─────────────────────────── § 8.5 : sources partenaires ───────────────────────────

  listSources(u: User) {
    authorize(u, A.sourceRead);
    return this.sources.all().map((s) => ({ ...s, rule: CROSS_RULES[s.kind], batches: this.batches.find((b) => b.sourceId === s.id).length }));
  }

  createSource(u: User, input: { kind: SourceKind; partnerName: string; description: string }, opts: { demo?: boolean } = {}) {
    authorize(u, A.sourceCreate);
    const s: PartnerSource = {
      id: this.ids.next('SRC', 3), kind: input.kind, partnerName: input.partnerName, description: input.description, protocol: null, compliance: null,
      status: 'PROTOCOLE_A_SIGNER', createdAt: this.now(), createdBy: u.id, ...(opts.demo ? { demo: true } : {}),
    };
    this.sources.insert(s);
    this.audit(u, 'recoupement.source.created', 'source_donnees', s.id, { kind: s.kind });
    return s;
  }

  private getSource(id: string): PartnerSource {
    const s = this.sources.get(id);
    if (!s) throw notFound('SOURCE_NOT_FOUND', `Source inconnue : ${id}`);
    return s;
  }

  recordProtocol(u: User, id: string, input: { reference: string; signedOn: string; signatories: string; documentSha256: string }) {
    authorize(u, A.sourceProtocol);
    const s = this.getSource(id);
    if (s.protocol) throw conflict('PROTOCOL_ALREADY_RECORDED', 'Protocole déjà enregistré.');
    s.protocol = { ...input, recordedBy: u.id, recordedAt: this.now() };
    s.status = 'CONFORMITE_A_VERIFIER';
    this.sources.update(s);
    this.audit(u, 'recoupement.protocol.recorded', 'source_donnees', s.id, { reference: input.reference });
    return s;
  }

  /** Vérification Code du numérique par le délégué à la protection des données — personne distincte de celle qui a enregistré le protocole. */
  recordCompliance(u: User, id: string, input: { personalData: boolean; lawfulBasis: string; minimisation: string; retention: string; security: string; conclusion: 'CONFORME' | 'NON_CONFORME'; note: string }) {
    authorize(u, A.sourceCompliance);
    const s = this.getSource(id);
    if (!s.protocol) throw conflict('PROTOCOL_REQUIRED', 'Protocole signé requis avant la vérification de conformité.');
    assertDistinctPerson(u.id, [s.protocol.recordedBy], 'La conformité est vérifiée par une autre personne que celle qui a enregistré le protocole.');
    s.compliance = { framework: CODE_NUMERIQUE, ...input, checkedBy: u.id, checkedAt: this.now() };
    s.status = input.conclusion === 'CONFORME' ? 'ACTIVE' : 'NON_CONFORME';
    this.sources.update(s);
    this.audit(u, 'recoupement.compliance.recorded', 'source_donnees', s.id, { conclusion: input.conclusion, personalData: input.personalData });
    return s;
  }

  suspendSource(u: User, id: string, reason: string) {
    authorize(u, A.sourceSuspend);
    const s = this.getSource(id);
    s.status = 'SUSPENDUE';
    this.sources.update(s);
    this.audit(u, 'recoupement.source.suspended', 'source_donnees', s.id, { reason });
    return s;
  }

  /** Ingestion : refusée tant que protocole signé ET vérification Code du numérique conforme ne sont pas enregistrés. */
  ingest(u: User, sourceId: string, records: IngestRecord[], opts: { demo?: boolean } = {}) {
    authorize(u, A.ingest);
    const s = this.getSource(sourceId);
    if (s.status !== 'ACTIVE') {
      const missing = [...(s.protocol ? [] : ['protocole signé']), ...(s.compliance?.conclusion === 'CONFORME' ? [] : [`vérification ${CODE_NUMERIQUE}`]), ...(s.status === 'SUSPENDUE' ? ['levée de la suspension'] : [])];
      this.audit(u, 'recoupement.ingestion.refused', 'source_donnees', s.id, { status: s.status, missing }, 'DENIED');
      this.ctx.alerts.raise({ type: 'INGESTION_SANS_PROTOCOLE', severity: 'MEDIUM', source: 'opportunites', detail: `Ingestion refusée pour la source ${s.id} (${s.partnerName}) : ${missing.join(', ')}.`, context: { sourceId: s.id }, actor: actorOf(u) });
      throw conflict('SOURCE_NOT_AUTHORISED', `Aucune donnée n’est reçue de cette source : ${missing.join(', ')} manquant(s).`, { missing });
    }
    const batchId = this.ids.next('LOT', 4);
    const created: WorklistItem[] = [];
    for (const r of records) {
      const item = this.evaluate(u, s, batchId, r, !!opts.demo);
      if (item) created.push(this.worklist.insert(item));
    }
    const batch: IngestBatch = { id: batchId, sourceId: s.id, kind: s.kind, records: records.length, worklistItems: created.length, ingestedBy: u.id, at: this.now(), sha256: sha(records), ...(opts.demo ? { demo: true } : {}) };
    this.batches.append(batch);
    this.audit(u, 'recoupement.batch.ingested', 'source_donnees', s.id, { batchId, records: records.length, worklistItems: created.length, sha256: batch.sha256 });
    return { batch, items: created, notice: 'Liste de travail priorisée pour les agents — aucun avis d’imposition automatique (§ 8.5).' };
  }

  private item(s: PartnerSource, batchId: string, demo: boolean, x: Omit<WorklistItem, 'id' | 'ruleCode' | 'kind' | 'sourceId' | 'batchId' | 'automaticAssessment' | 'createdAt' | 'priority'>): WorklistItem {
    const priority = Math.min(100, x.priorityFactors.reduce((a, f) => a + f.points, 0));
    return { id: this.ids.next('LT', 5), ruleCode: CROSS_RULES[s.kind].ruleCode, kind: s.kind, sourceId: s.id, batchId, automaticAssessment: 'AUCUN', createdAt: this.now(), priority, ...x, ...(demo ? { demo: true } : {}) };
  }

  private evaluate(u: User, s: PartnerSource, batchId: string, rec: IngestRecord, demo: boolean): WorklistItem | null {
    const objs = this.ctx.objects.objects.all();
    switch (s.kind) {
      case 'LIVRAISONS_BRASSERIE': {
        const r = rec as BarRecord;
        const here = { lat: r.lat, lon: r.lon };
        const licensed = objs.some((o) => distanceM(here, o) <= BAR_LICENCE_RADIUS_M && (o.attributes.objectType === 'DEBIT_BOISSONS' || o.attributes.licenceDebitBoissons === true))
          || (this.ext<VerticalesService>('verticales')?.certificates.find((c) => c.kind === 'AUTORISATION_ACTIVITE' && c.status === 'VALIDE' && (!c.validUntil || c.validUntil >= this.today()) && !!c.objectId)
            .some((c) => { const o = objs.find((x) => x.id === c.objectId); return !!o && distanceM(here, o) <= BAR_LICENCE_RADIUS_M; }) ?? false);
        if (licensed) return null;
        return this.item(s, batchId, demo, {
          commune: r.commune, quartier: r.quartier ?? null, lat: r.lat, lon: r.lon, subject: { kind: 'POINT_DE_VENTE', ref: r.pointRef },
          explanation: `Point de vente livré par un dépôt brassicole sans autorisation de débit de boissons à moins de ${BAR_LICENCE_RADIUS_M} m : objet provisoire « bar » proposé et visite de vérification.`,
          variables: [{ name: 'livraisons', value: String(r.deliveries) }, { name: 'rayon_m', value: String(BAR_LICENCE_RADIUS_M) }, ...(r.period ? [{ name: 'periode', value: r.period }] : [])],
          priorityFactors: [{ label: 'Règle § 8.5 — débit de boissons sans autorisation', points: 50 }, { label: `Livraisons observées (${r.deliveries})`, points: Math.min(40, r.deliveries * 2) }],
          status: 'A_EXAMINER', proposedObject: { category: 'ACTIVITE', objectType: 'BAR', label: 'Objet provisoire « bar »' },
        });
      }
      case 'CODES_MARCHANDS_MOMO': {
        const r = rec as MerchantRecord;
        if (!r.active) return null;
        const radius = this.crossParams.merchantMatchRadiusM;
        if (objs.some((o) => o.category === 'ACTIVITE' && distanceM({ lat: r.lat, lon: r.lon }, o) <= radius)) return null;
        const ageDays = Math.max(0, Math.floor((new Date(`${this.today()}T00:00:00Z`).getTime() - new Date(`${r.lastActivity}T00:00:00Z`).getTime()) / 86_400_000));
        return this.item(s, batchId, demo, {
          commune: r.commune, quartier: r.quartier ?? null, lat: r.lat, lon: r.lon, subject: { kind: 'CODE_MARCHAND', ref: r.merchantRef },
          explanation: 'Code marchand Mobile Money actif sans objet patente à cet emplacement : commerce probablement non enregistré (à vérifier).',
          variables: [{ name: 'derniere_activite', value: r.lastActivity }, { name: 'tolerance_m', value: `${radius} (${this.crossParams.status})` }],
          priorityFactors: [{ label: 'Règle § 8.5 — commerce probablement non enregistré', points: 40 }, { label: 'Activité récente', points: ageDays <= 30 ? 20 : ageDays <= 90 ? 10 : 0 }],
          status: 'A_EXAMINER', proposedObject: null,
        });
      }
      case 'LECTURES_PLAQUES': {
        const r = rec as PlateRecord;
        const st = this.plateState(r.plate);
        if (st.result === 'VERT') return null;
        return this.item(s, batchId, demo, {
          commune: r.commune, quartier: null, lat: null, lon: null, subject: { kind: 'PLAQUE', ref: normalizePlate(r.plate) },
          explanation: st.result === 'ROUGE' ? 'Vignette ou taxe de circulation impayée : statut instantané pour le contrôleur (aucune sanction automatique).' : 'Plaque inconnue du registre : enrôlement à proposer au contrôleur.',
          variables: [{ name: 'point_de_controle', value: r.checkpoint }, { name: 'lu_le', value: r.readAt }, { name: 'statut', value: st.result }],
          priorityFactors: [{ label: st.result === 'ROUGE' ? 'Impayé exigible' : 'Plaque non rattachée', points: st.result === 'ROUGE' ? 70 : 40 }],
          status: 'STATUT_INSTANTANE', proposedObject: null,
        });
      }
      case 'SOUMISSIONS_AUTORISATIONS': {
        const r = rec as TenderRecord;
        const fiscal = this.ext<FiscalService>('fiscal');
        if (!this.ctx.taxpayers.taxpayers.get(r.taxpayerId)) {
          return this.item(s, batchId, demo, {
            commune: r.commune ?? null, quartier: null, lat: null, lon: null, subject: { kind: 'CONTRIBUABLE', ref: r.taxpayerId },
            explanation: 'Demandeur inconnu du compte unique : rapprochement d’identité à examiner (aucun blocage sans identification).',
            variables: [{ name: 'service', value: r.service }, { name: 'reference', value: r.reference }],
            priorityFactors: [{ label: 'Identification à établir', points: 30 }], status: 'A_EXAMINER', proposedObject: null,
          });
        }
        const valid = fiscal?.clearances.active(r.taxpayerId);
        if (valid) return null;
        const { opposable, note } = this.quitusOpposability();
        const block: ServiceBlock = { id: this.ids.next('BLQ', 4), taxpayerId: r.taxpayerId, service: r.service, reference: r.reference, status: 'BLOQUE', opposable, basisNote: note, createdAt: this.now(), ...(demo ? { demo: true } : {}) };
        this.blocks.insert(block);
        this.audit(u, 'recoupement.service.blocked', 'blocage_service', block.id, { taxpayerId: r.taxpayerId, service: r.service, opposable });
        return this.item(s, batchId, demo, {
          commune: r.commune ?? null, quartier: null, lat: null, lon: null, subject: { kind: 'CONTRIBUABLE', ref: r.taxpayerId },
          explanation: `Demande (${r.service === 'MARCHE_PUBLIC' ? 'marché provincial' : 'autorisation'} ${r.reference}) sans quitus fiscal valide : service bloqué jusqu’à régularisation${opposable ? '' : ' — blocage INFORMATIF tant que l’acte J6 n’est pas en vigueur (ARB-17)'}.`,
          variables: [{ name: 'service', value: r.service }, { name: 'reference', value: r.reference }, { name: 'quitus', value: fiscal ? 'absent ou expiré' : 'module fiscal non chargé' }],
          priorityFactors: [{ label: 'Règle § 8.5 — pas de quitus valide', points: 60 }],
          status: 'SERVICE_BLOQUE', proposedObject: null, blockId: block.id,
        });
      }
      case 'DECLARATIONS_IMMEUBLES': {
        const r = rec as BuildingRecord;
        if (!r.anomalies.length) return null;
        return this.item(s, batchId, demo, {
          commune: r.commune, quartier: r.quartier ?? null, lat: r.lat, lon: r.lon, subject: { kind: 'IMMEUBLE', ref: r.buildingObjectId ?? r.buildingRef },
          explanation: 'Incohérence de déclaration locative : examen humain, puis mission autorisée si l’examen le justifie.',
          variables: [{ name: 'unites', value: String(r.units) }, { name: 'anomalies', value: r.anomalies.map((a) => ANOMALY_LABELS[a]).join(', ') }, ...(r.detail ? [{ name: 'detail', value: r.detail }] : [])],
          priorityFactors: [{ label: 'Règle § 8.5 — incohérence locative', points: 30 }, { label: `${r.anomalies.length} anomalie(s)`, points: r.anomalies.length * 15 }, { label: `${r.units} unité(s)`, points: Math.min(20, r.units) }],
          status: 'A_EXAMINER', proposedObject: null,
        });
      }
    }
  }

  private quitusOpposability(): { opposable: boolean; note: string } {
    const id = this.crossParams.quitusActInstrumentId;
    const i = id ? this.ctx.rules.instrument(id) : undefined;
    if (i && i.status === 'EN_VIGUEUR') return { opposable: true, note: `Conditionnalité fondée sur l’acte ${i.id} (EN VIGUEUR).` };
    return { opposable: false, note: 'Blocage INFORMATIF : l’acte instituant la conditionnalité du quitus (J6) n’est pas désigné en vigueur (ARB-17). Le service vérificateur est informé, la décision reste humaine.' };
  }

  // ─────────────────────────── listes de travail ───────────────────────────

  listWorklist(u: User, f: { status?: string; ruleCode?: string; commune?: string } = {}) {
    const access: Access = authorize(u, A.worklistRead, { communes: f.commune ? [f.commune] : u.territory ?? [] });
    const rows = this.worklist.all()
      .filter((i) => (!f.status || i.status === f.status) && (!f.ruleCode || i.ruleCode === f.ruleCode) && (!f.commune || i.commune === f.commune))
      .filter((i) => !u.territory || (i.commune !== null && u.territory.includes(i.commune)))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    const items = access === 'minimal'
      ? rows.map((i) => ({ id: i.id, ruleCode: i.ruleCode, commune: i.commune, quartier: i.quartier, lat: i.lat, lon: i.lon, priority: i.priority, status: i.status, explanation: i.explanation, automaticAssessment: i.automaticAssessment }))
      : rows;
    return { access, rules: Object.values(CROSS_RULES), items, notice: 'Liste de travail priorisée — jamais un avis d’imposition automatique.' };
  }

  private getItem(id: string): WorklistItem {
    const i = this.worklist.get(id);
    if (!i) throw notFound('WORKLIST_ITEM_NOT_FOUND', `Élément inconnu : ${id}`);
    return i;
  }

  /** Examen humain : vérification requise (avec, pour la règle « bar », création de l'objet PROVISOIRE au registre) ou sans suite motivée. */
  review(u: User, id: string, input: { decision: 'VERIFICATION_REQUISE' | 'SANS_SUITE'; reason: string; localityRank?: 1 | 2 | 3 | 4 | undefined }) {
    authorize(u, A.worklistReview);
    const i = this.getItem(id);
    if (i.status !== 'A_EXAMINER') throw conflict('ITEM_NOT_REVIEWABLE', `Élément au statut ${i.status} : seul un élément « à examiner » est examiné.`);
    if (input.decision === 'VERIFICATION_REQUISE' && i.proposedObject && i.lat !== null && i.lon !== null && i.commune) {
      const quartier = i.quartier ?? 'À préciser';
      const rank = certifiedRankOf(i.commune, quartier)?.rank ?? input.localityRank;
      if (!rank) throw unprocessable('RANK_REQUIRED', 'Rang de localité à déclarer (quartier absent de la table certifiée) : il restera PROVISOIRE.');
      if (!isCommune(i.commune)) throw unprocessable('UNKNOWN_COMMUNE', `Commune inconnue : ${i.commune}`);
      const obj = this.ctx.objects.create(u, {
        category: i.proposedObject.category, commune: i.commune, quartier, localityRank: rank, lat: i.lat, lon: i.lon,
        attributes: { verticale: 'entreprises', objectType: i.proposedObject.objectType, nom: i.proposedObject.label, source: 'recoupement § 8.5', worklistItemId: i.id, ...(i.demo ? { demo: true } : {}) },
      });
      i.createdObjectId = obj.id;
    }
    i.review = { decision: input.decision, reason: input.reason, by: u.id, at: this.now() };
    i.status = input.decision === 'VERIFICATION_REQUISE' ? 'VERIFICATION_REQUISE' : 'CLOS_SANS_SUITE';
    this.worklist.update(i);
    this.audit(u, 'recoupement.item.reviewed', 'liste_travail', i.id, { decision: input.decision, objectId: i.createdObjectId ?? null });
    return i;
  }

  /** Mission autorisée (module terrain) après examen humain seulement. */
  openMission(u: User, id: string, input: { dueDate: string; instructions?: string | undefined }) {
    authorize(u, A.worklistMission);
    const i = this.getItem(id);
    if (i.status !== 'VERIFICATION_REQUISE') throw conflict('REVIEW_REQUIRED', 'Mission possible seulement après examen humain concluant à une vérification requise.');
    const terrain = this.ext<TerrainService>('terrain');
    if (!terrain) throw conflict('TERRAIN_UNAVAILABLE', 'Module terrain non chargé.');
    const module = CROSS_RULES[i.kind].terrainModule;
    if (!module || !i.commune || i.lat === null || i.lon === null) throw unprocessable('MISSION_NOT_APPLICABLE', 'Cette règle ne donne pas lieu à une visite sur place.');
    const objectIds = [i.createdObjectId, i.kind === 'DECLARATIONS_IMMEUBLES' ? i.subject.ref : undefined].filter((x): x is string => !!x && this.ctx.objects.objects.get(x)?.commune === i.commune);
    const mission = terrain.createMission(u, {
      module: module as never, kind: 'CONTROLE', title: `Vérification — ${CROSS_RULES[i.kind].result} (${i.id})`, commune: i.commune, ...(i.quartier ? { quartier: i.quartier } : {}),
      center: { lat: i.lat, lon: i.lon }, radiusM: 100, objectIds, objectives: { findings: 1 },
      instructions: `${i.explanation}\n${input.instructions ?? ''}\nAucun montant n’est exigé sur place.`.trim(), periodStart: this.today(), dueDate: input.dueDate,
    });
    i.missionId = mission.id;
    i.status = 'MISSION_OUVERTE';
    this.worklist.update(i);
    this.audit(u, 'recoupement.mission.opened', 'liste_travail', i.id, { missionId: mission.id });
    return { item: i, mission };
  }

  // ─────────────────────────── plaque : statut instantané ───────────────────────────

  private plateState(raw: string): { plate: string; result: 'VERT' | 'ROUGE' | 'INCONNU'; unpaid: number; validTitles: number; known: boolean } {
    const plate = normalizePlate(raw);
    const today = this.today();
    const vehicles = this.ctx.objects.objects.find((o) => o.category === 'VEHICULE' && typeof o.attributes.immatriculation === 'string' && normalizePlate(o.attributes.immatriculation) === plate);
    const unpaid = this.ctx.assessment.obligations.find((ob) => vehicles.some((v) => v.id === ob.objectId) && !ob.supersededBy && UNPAID.includes(ob.status)
      && (ob.status !== 'EMISE' || ob.dueDate < today) && !this.ctx.payments.byObligation(ob.id).some((p) => PAID.includes(p.status))).length;
    const titres = this.ext<TitresService>('titres');
    const creds = titres?.byPlate(plate) ?? [];
    const validTitles = creds.filter((c) => ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'].includes(titres!.status(c).status)).length;
    const known = vehicles.length > 0 || creds.length > 0;
    return { plate, result: unpaid > 0 ? 'ROUGE' : known ? 'VERT' : 'INCONNU', unpaid, validTitles, known };
  }

  /** Statut minimal pour le contrôleur : vert / rouge / inconnu, sans nom, adresse ni montant. */
  plateStatus(u: User, raw: string, commune?: string) {
    authorize(u, A.plateStatus, commune ? { communes: [commune] } : {});
    const st = this.plateState(raw);
    this.audit(u, 'recoupement.plate.consulted', 'plaque', st.plate, { result: st.result });
    return {
      plate: st.plate, result: st.result, unpaidObligations: st.unpaid, validTitles: st.validTitles, serverTime: this.now(),
      message: st.result === 'ROUGE' ? 'Vignette ou taxe de circulation impayée — informer, orienter vers le paiement numérique ; aucune sanction automatique.'
        : st.result === 'VERT' ? 'Aucun impayé exigible connu.' : 'Plaque inconnue du registre — proposer l’enrôlement.',
    };
  }

  // ─────────────────────────── blocages (quitus) ───────────────────────────

  listBlocks(u: User, taxpayerId?: string) {
    authorize(u, A.blockRead);
    return this.blocks.all().filter((b) => !taxpayerId || b.taxpayerId === taxpayerId);
  }

  /** Réexamen : le blocage est levé dès qu'un quitus valide existe (régularisation). */
  recheckBlock(u: User, id: string) {
    authorize(u, A.blockRecheck);
    const b = this.blocks.get(id);
    if (!b) throw notFound('BLOCK_NOT_FOUND', `Blocage inconnu : ${id}`);
    if (b.status === 'LEVE') return b;
    const c = this.ext<FiscalService>('fiscal')?.clearances.active(b.taxpayerId);
    if (!c) return { ...b, message: 'Aucun quitus valide : le blocage est maintenu jusqu’à régularisation.' };
    b.status = 'LEVE'; b.liftedAt = this.now(); b.liftedBy = u.id; b.clearanceNumber = c.number;
    this.blocks.update(b);
    for (const i of this.worklist.find((x) => x.blockId === b.id)) this.worklist.update({ ...i, status: 'REGULARISE' });
    this.audit(u, 'recoupement.service.unblocked', 'blocage_service', b.id, { clearance: c.number });
    return b;
  }

  setParams(u: User, input: Partial<Pick<CrossParams, 'merchantMatchRadiusM' | 'expiryHorizonDays' | 'forecastWeeks' | 'quitusActInstrumentId'>> & { reason: string }) {
    authorize(u, A.params);
    if (input.quitusActInstrumentId) {
      const i = this.ctx.rules.instrument(input.quitusActInstrumentId);
      if (!i || i.status !== 'EN_VIGUEUR') throw unprocessable('INSTRUMENT_NOT_IN_FORCE', 'Seul un acte EN VIGUEUR du registre juridique peut fonder la conditionnalité du quitus.');
    }
    const { reason, ...rest } = input;
    const next = { ...this.crossParams, ...rest, status: 'modifié — motivé et journalisé', updatedBy: u.id, updatedAt: this.now() };
    this.params.update(next);
    this.audit(u, 'recoupement.params.updated', 'parametres', 'recoupement', { ...rest, reason });
    return next;
  }

  // ─────────────────────────── données de démonstration ───────────────────────────

  seedDemo(): void {
    const ctx = this.ctx;
    const add = (x: Omit<User, 'kind'>) => ctx.users.get(x.id) ?? ctx.users.add(x);
    const analyste = add({ id: 'opp-analyste', name: 'Analyste du programme — régie DGIPK (démo)', roles: ['R07'], entity: 'DGIPK' });
    const dpo = add({ id: 'opp-dpo', name: 'Délégué à la protection des données — recoupement (démo)', roles: ['R25'], entity: 'PLATEFORME' });
    const partner = add({ id: 'opp-partenaire', name: 'Partenaire de données [EXEMPLE] (démo)', roles: ['R34'], entity: 'PARTENAIRE-DONNEES' });
    const dg = ctx.users.get('u-dg-dgipk')!;
    const juriste = ctx.users.get('u-juriste-redacteur')!;
    const auditeur = ctx.users.get('u-auditeur')!;
    // Instruction de démonstration : recensement locatif, étapes 1 à 3 (aucun montant : potentiel « à estimer »).
    const opp = 'OPP-G81-01';
    this.completeStep(dg, opp, 1, { summary: '[EXEMPLE] Signal confirmé : unités locatives sans bail déclaré (agent Découverte des recettes, registre).' });
    this.completeStep(juriste, opp, 2, { summary: '[EXEMPLE] Base légale existante (IRL) — à droit constant ; aucun acte nouveau requis.', data: { qualification: 'BASE_EXISTANTE' } });
    this.completeStep(analyste, opp, 3, { summary: '[EXEMPLE] Potentiel non chiffré : à estimer par le recensement pilote.', scenarios: { prudent: null, attendu: null, ambitieux: null, hypothesisIds: [] } });
    void auditeur;
    // Sources : une source active (protocole + conformité), une source sans protocole (ingestion refusée).
    const mk = (kind: SourceKind, partnerName: string, description: string, active: boolean) => {
      const s = this.createSource(analyste, { kind, partnerName: `${partnerName} [EXEMPLE]`, description }, { demo: true });
      if (!active) return s;
      this.recordProtocol(dg, s.id, { reference: `[EXEMPLE] PROT-${kind}`, signedOn: this.today(), signatories: 'DGIPK / partenaire [EXEMPLE]', documentSha256: 'e'.repeat(64) });
      return this.recordCompliance(dpo, s.id, { personalData: kind !== 'LIVRAISONS_BRASSERIE', lawfulBasis: '[EXEMPLE] Mission d’intérêt public — protocole', minimisation: 'Pseudonymes, position, date', retention: '[EXEMPLE] 12 mois', security: 'Chiffrement, accès journalisé', conclusion: 'CONFORME', note: '[EXEMPLE] Données non contractuelles.' });
    };
    const bar = mk('LIVRAISONS_BRASSERIE', 'Dépôt brassicole', 'Points de livraison (sans nom de client)', true);
    const momo = mk('CODES_MARCHANDS_MOMO', 'Opérateur Mobile Money', 'Codes marchands actifs pseudonymisés et position', true);
    const plates = mk('LECTURES_PLAQUES', 'Points de contrôle routier', 'Lectures de plaques horodatées', true);
    const tenders = mk('SOUMISSIONS_AUTORISATIONS', 'Service des marchés provinciaux', 'Soumissions et demandes d’autorisation', true);
    const buildings = mk('DECLARATIONS_IMMEUBLES', 'Syndics d’immeubles', 'Déclarations d’immeubles multi-unités', true);
    mk('DECLARATIONS_IMMEUBLES', 'Agence immobilière', 'Registre des baux gérés (protocole en négociation)', false);
    this.ingest(partner, bar.id, [
      { pointRef: '[EXEMPLE] PDV-LIM-001', commune: 'Limete', quartier: 'Industriel', lat: -4.3702, lon: 15.3431, deliveries: 12, period: '2026-09' },
      { pointRef: '[EXEMPLE] PDV-LIM-002', commune: 'Limete', quartier: 'Mososo', lat: -4.3811, lon: 15.3502, deliveries: 4, period: '2026-09' },
    ], { demo: true });
    this.ingest(partner, momo.id, [
      { merchantRef: '[EXEMPLE] MCH-7F3A', commune: 'Lemba', quartier: 'Salongo', lat: -4.4005, lon: 15.3222, active: true, lastActivity: this.today() },
    ], { demo: true });
    this.ingest(partner, plates.id, [{ plate: 'KN-9999-ZZ', checkpoint: '[EXEMPLE] Échangeur de Limete', commune: 'Limete', readAt: this.now() }], { demo: true });
    this.ingest(partner, tenders.id, [{ taxpayerId: DEMO.tenantTaxpayerId, service: 'MARCHE_PUBLIC', reference: '[EXEMPLE] AO-2026-014', commune: 'Gombe' }], { demo: true });
    this.ingest(partner, buildings.id, [
      { buildingRef: '[EXEMPLE] IMM-NGA-12', commune: 'Ngaba', quartier: 'Mukulua', lat: -4.3931, lon: 15.3159, units: 12, anomalies: ['VACANT_DECLARE', 'LOYERS_ATYPIQUES'], detail: '[EXEMPLE] 10 unités sur 12 déclarées vacantes' },
    ], { demo: true });
  }
}
