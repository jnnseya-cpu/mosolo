/**
 * Service de pilotage (§ 26–27) : échelle de la recette, indicateurs, tableaux par profil, consultation détaillée,
 * transparence publique, piste d'audit par dossier et exports signés — calculés sur les données RÉELLES du socle.
 * Lecture seule sur le socle ; aucun acte financier ni juridique (C1-267). Agrégats seulement dans les tableaux.
 */
import type { MoneyJSON, RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository } from '../../core/repository.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { ExportSigner, EXPORT_KEY_ID, jsonPayload, toCsv, type CsvCell, type ExportManifest } from './exports.js';
import { collectFacts, type Facts } from './facts.js';
import { computeKpis, type KpiInputs, type KpiResult } from './kpis.js';
import {
  computeLadder, contestedIndicator, drill, isConfirmed, kinshasaDay, isReconciled, isSettled, matchesDims, monthlySeries, periodRange, quarterOf,
  selectLevel, selectionTotals, type DrillDimension, type Filters, type LadderContext,
} from './ladder.js';
import { CurrencyTotals } from './money.js';
import {
  buildReductionReport, collectReductions, potentialUnassessed, REDUCTION_ALERT_PARAMS, reductionSignals, type ReductionFilters, type ReductionType,
} from './reductions.js';
import { buildTransparency, reidentificationCheck, type ReidentificationCheck, type TransparencyContent } from './transparency.js';
import { buildGraph, buildTrail, resolveDossier } from './trail.js';

export const PROFILES = {
  gouverneur: { label: 'Gouverneur', description: 'Centre de commandement : échelle de la recette, communes, catégories, intégrité.' },
  'dg-regie': { label: 'Direction générale de régie', description: 'Assiette, liquidation, recouvrement, contentieux, performance des services.' },
  tresor: { label: 'Trésor', description: 'Confirmé, réglé, rapproché, suspens par âge, exceptions, prestataires.' },
  commune: { label: 'Commune', description: 'Recettes attribuées à la commune (fait générateur), couverture, catégories.' },
  audit: { label: 'Audit', description: 'Intégrité des chaînes, opérations sensibles, extractions, pistes par dossier.' },
  ministre: { label: 'Ministre', description: 'Recettes et indicateurs du périmètre légal propre.' },
} as const;
export type ProfileCode = keyof typeof PROFILES;
export const PROFILE_CODES = Object.keys(PROFILES) as ProfileCode[];

/** Rôles au périmètre complet (toute la province, toutes les administrations). */
const FULL_SCOPE: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R17', 'R18', 'R22', 'R23', 'R24'];
/** Rôles limités à leur administration (entité). */
const ENTITY_SCOPE: RoleCode[] = ['R04', 'R06', 'R07'];

export interface Scope {
  kind: 'PROVINCE' | 'ENTITE' | 'TERRITOIRE';
  label: string;
  entity?: string;
  communes?: string[];
}

export interface Query {
  commune?: string;
  category?: string;
  entity?: string;
  channel?: string;
  period?: string;
  from?: string;
  to?: string;
}

interface Publication {
  id: string;
  period: string;
  version: number;
  publishedAt: string;
  publishedBy: string;
  authority: string;
  motif: string;
  content: TransparencyContent;
  check: ReidentificationCheck;
  sha256: string;
  signature: string;
}

type ExportKind = 'echelle' | 'indicateurs' | 'drill' | 'piste-audit' | 'transparence';
export const EXPORT_KINDS: ExportKind[] = ['echelle', 'indicateurs', 'drill', 'piste-audit', 'transparence'];

const OPEN_EXCEPTION = (s: unknown) => s !== 'RESOLUE' && s !== 'CLASSEE';

export class PilotageService {
  readonly publications = new InMemoryAppendOnlyRepository<Publication>();
  readonly exportsLog = new InMemoryAppendOnlyRepository<ExportManifest & { id: string }>();
  private readonly ids = new IdGenerator();
  private readonly signer: ExportSigner;

  constructor(private readonly ctx: AppContext) {
    this.signer = new ExportSigner(ctx.secrets.auditHmacKey);
  }

  // ————————————————————————— périmètre et filtres —————————————————————————

  scopeOf(user: User): Scope {
    if (user.roles.some((r) => FULL_SCOPE.includes(r))) return { kind: 'PROVINCE', label: 'Toute la Ville-Province' };
    if (user.roles.some((r) => ENTITY_SCOPE.includes(r))) return { kind: 'ENTITE', label: `Administration ${user.entity}`, entity: user.entity };
    if (user.territory?.length) return { kind: 'TERRITOIRE', label: `Commune(s) : ${user.territory.join(', ')}`, communes: [...user.territory] };
    return { kind: 'ENTITE', label: `Administration ${user.entity}`, entity: user.entity };
  }

  /** Filtres effectifs : la demande est bornée par le périmètre ; hors périmètre ⇒ 403 journalisé. */
  filtersFor(user: User, q: Query): { filters: Filters; scope: Scope } {
    const scope = this.scopeOf(user);
    if (q.commune && q.commune !== 'NON_ATTRIBUE' && !(COMMUNES as readonly string[]).includes(q.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${q.commune}`);
    const f: Filters = {};
    if (q.commune) f.commune = q.commune;
    if (q.category) f.category = q.category;
    if (q.entity) f.entity = q.entity;
    if (q.channel) f.channel = q.channel;
    if (q.period) {
      Object.assign(f, periodRange(q.period));
      f.period = q.period;
    }
    if (q.from) f.from = q.from;
    if (q.to) f.to = q.to;
    if (f.from && f.to && f.from > f.to) throw badRequest('INVALID_PERIOD', 'Début de période postérieur à la fin.');
    if (scope.entity) {
      if (q.entity && q.entity !== scope.entity) throw forbidden('FORBIDDEN_SCOPE', `Périmètre limité à l’administration ${scope.entity}.`);
      f.entity = scope.entity;
    }
    if (scope.communes) {
      if (q.commune && !scope.communes.includes(q.commune)) throw forbidden('FORBIDDEN_SCOPE', `Périmètre limité à : ${scope.communes.join(', ')}.`);
      f.communes = scope.communes;
    }
    return { filters: f, scope };
  }

  private convert = (m: MoneyJSON): MoneyJSON => this.ctx.fx.convert(m, 'CDF').amount;

  currentQuarter(): string {
    return quarterOf(this.now().slice(0, 10));
  }

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  facts(asOf = this.now()): Facts {
    return collectFacts(this.ctx, asOf);
  }

  private objectsIn(f: Filters) {
    return this.ctx.objects.objects.all().filter((o) => (!f.commune || f.commune === o.commune) && (!f.communes || f.communes.includes(o.commune)));
  }

  private ladderContext(facts: Facts, f: Filters): LadderContext {
    return {
      facts, filters: f, convert: this.convert,
      verifiedObjects: this.objectsIn(f).filter((o) => o.status === 'VALIDE' && (!f.from || o.createdAt.slice(0, 10) >= f.from) && (!f.to || o.createdAt.slice(0, 10) <= f.to)).length,
    };
  }

  private viewed(user: User, what: string, filters: Filters | Record<string, unknown>) {
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'pilotage.viewed', resourceType: 'dashboard', resourceId: what, details: { filters } });
  }

  private gate(user: User, action: string) {
    authorize(user, `pilotage:${action}`);
  }

  // ————————————————————————— réductions de recettes (fuites) —————————————————————————

  /**
   * Rapport « réductions de recettes » : brut liquidé, réductions par voie, net attendu, encaissé — par devise, par
   * commune, par module et par décideur ; rapprochement brut − réductions = net (≤ 0,01 par devise). Complété par les
   * « recettes potentielles non liquidées » (assiette sans règle ACTIVE, sans montant). La lecture rejoue aussi la
   * détection de concentration (signaux idempotents, examen humain).
   */
  reductions(user: User, q: Query, rq: { type?: ReductionType; decider?: string } = {}) {
    this.gate(user, 'reductions.read');
    const { filters, scope } = this.filtersFor(user, q);
    const rf: ReductionFilters = {
      ...(filters.commune ? { commune: filters.commune } : {}), ...(filters.communes ? { communes: filters.communes } : {}),
      ...(filters.entity ? { entity: filters.entity } : {}), ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}),
      ...(rq.type ? { type: rq.type } : {}), ...(rq.decider ? { decider: rq.decider } : {}),
    };
    this.viewed(user, 'reductions', { ...filters, ...(rq.type ? { type: rq.type } : {}), ...(rq.decider ? { decideur: rq.decider } : {}) });
    const data = collectReductions(this.ctx, rf);
    const detection = this.detectReductionSignals();
    return {
      generatedAt: this.now(), scope, filters: { ...filters, ...(rq.type ? { type: rq.type } : {}), ...(rq.decider ? { decideur: rq.decider } : {}) },
      method: 'Obligations liquidées sur la période (date de l’obligation d’origine) et toutes leurs réductions ; montants par devise, jamais additionnés entre devises.',
      formula: 'brut liquidé − réductions = net attendu ; net attendu − encaissé = reste à recouvrer',
      ...buildReductionReport(data),
      potentialUnassessed: potentialUnassessed(this.ctx, rf),
      signals: { raised: detection.raised, open: detection.signals.length, params: REDUCTION_ALERT_PARAMS },
    };
  }

  /**
   * Détection de concentration des réductions sur l'ensemble du socle : un décideur > 50 % des réductions d'une
   * commune sur un mois (nombre ou montant), ou cumul par contribuable au-delà du seuil. Chaque signal lève une alerte
   * du socle (R22, R24 notifiés) une seule fois par empreinte. Aucune mesure automatique.
   */
  detectReductionSignals(user?: User) {
    if (user) this.gate(user, 'reductions.detect');
    const signals = reductionSignals(collectReductions(this.ctx).lines);
    let raised = 0;
    for (const s of signals) {
      const a = this.ctx.alerts.raiseOnce(s.fingerprint, {
        type: s.kind === 'DECIDEUR_CONCENTRE' ? 'REDUCTION_CONCENTRATION_DECIDEUR' : 'REDUCTION_CUMUL_CONTRIBUABLE',
        severity: 'MEDIUM', source: 'pilotage:reductions', detail: s.detail, context: s.context, notifyRoles: ['R22', 'R24'],
        ...(user ? { actor: { kind: 'user' as const, id: user.id, roles: user.roles } } : {}),
      });
      if (a) raised++;
    }
    return { signals, raised, params: REDUCTION_ALERT_PARAMS, automaticEffect: 'AUCUN' as const };
  }

  // ————————————————————————— échelle, drill-down, série —————————————————————————

  ladder(user: User, q: Query) {
    this.gate(user, 'dashboard.read');
    const { filters, scope } = this.filtersFor(user, q);
    const facts = this.facts();
    const c = this.ladderContext(facts, filters);
    this.viewed(user, 'echelle', filters);
    return {
      generatedAt: facts.asOf, example: false, scope, filters, currency: 'CDF',
      rule: 'Les onze niveaux sont emboîtés et ne s’additionnent jamais. Montants par devise légale ; contre-valeur CDF indicative.',
      levels: computeLadder(c),
      contested: contestedIndicator(facts, filters, this.convert),
    };
  }

  drill(user: User, dimension: DrillDimension, q: Query) {
    this.gate(user, 'dashboard.read');
    const { filters, scope } = this.filtersFor(user, q);
    const facts = this.facts();
    this.viewed(user, `drill:${dimension}`, filters);
    return { generatedAt: facts.asOf, scope, filters, ...drill(dimension, this.ladderContext(facts, filters)) };
  }

  series(user: User, q: Query, months = 12) {
    this.gate(user, 'dashboard.read');
    const { filters, scope } = this.filtersFor(user, q);
    const facts = this.facts();
    return { generatedAt: facts.asOf, scope, filters, months: monthlySeries(this.ladderContext(facts, filters), months) };
  }

  // ————————————————————————— indicateurs —————————————————————————

  private kpiInputs(facts: Facts, f: Filters): KpiInputs {
    const asOf = facts.asOf;
    const scopedRefs = new Set(facts.orders.filter((o) => matchesDims(o, f)).map((o) => o.paymentReference));
    const fullScope = !f.entity && !f.commune && !f.communes && !f.category;
    const treasury = this.ctx.treasury as unknown as { rawExceptions?: () => { type: string; openedAt: string; status: unknown; paymentReference?: string; computed?: boolean }[] };
    const rawExc = treasury.rawExceptions ? treasury.rawExceptions() : this.ctx.treasury.exceptions.all();
    const exceptions = rawExc
      .filter((e) => OPEN_EXCEPTION(e.status) && e.openedAt <= asOf)
      .filter((e) => (e.paymentReference ? scopedRefs.has(e.paymentReference) || fullScope : fullScope));
    const objects = this.objectsIn(f).filter((o) => o.createdAt <= asOf);
    const unitIds = new Set(objects.map((o) => o.id));
    const overview = this.ctx.comms.overview();
    return {
      facts, filters: f,
      objects: objects.map((o) => ({ id: o.id, commune: o.commune, category: o.category, status: o.status, createdAt: o.createdAt })),
      leases: this.ctx.objects.leases.all().filter((l) => unitIds.has(l.unitObjectId) && l.createdAt <= asOf),
      rules: this.ctx.rules.rules.all().map((r) => ({ status: r.status, sourceVerification: r.sourceVerification, demo: (r as { demo?: boolean }).demo === true })),
      exceptions,
      comms: { attempted: overview.attempted, delivered: overview.delivered, sandboxLogged: overview.sandboxLogged },
      alerts: this.ctx.alerts.alerts.all().filter((a) => a.at <= asOf).map((a) => ({ severity: a.severity, at: a.at })),
      ai: this.ctx.ai.recommendations.all().filter((r) => !r.createdAt || r.createdAt <= asOf).map((r) => ({ status: r.status, createdAt: r.createdAt })),
    };
  }

  computeKpis(f: Filters): KpiResult[] {
    const now = this.ctx.clock.now();
    const current = this.kpiInputs(this.facts(now.toISOString()), f);
    const previous = this.kpiInputs(this.facts(new Date(now.getTime() - 7 * DAY_MS).toISOString()), f);
    return computeKpis(current, previous, '7 jours');
  }

  kpis(user: User, q: Query) {
    this.gate(user, 'dashboard.read');
    const { filters, scope } = this.filtersFor(user, q);
    this.viewed(user, 'indicateurs', filters);
    const kpis = this.computeKpis(filters);
    return {
      generatedAt: this.now(), scope, filters,
      summary: {
        total: kpis.length, measured: kpis.filter((k) => k.status !== 'NON_MESURE').length,
        onTarget: kpis.filter((k) => k.status === 'ATTEINTE').length, offTarget: kpis.filter((k) => k.status === 'NON_ATTEINTE').length,
      },
      kpis,
    };
  }

  // ————————————————————————— tableaux par profil —————————————————————————

  profilesFor(user: User) {
    return PROFILE_CODES.filter((p) => evaluate(user, `pilotage:profile.${p}`)).map((p) => ({ code: p, ...PROFILES[p] }));
  }

  private dayTiles(facts: Facts, f: Filters) {
    const today = kinshasaDay(facts.asOf);
    const yesterday = kinshasaDate(new Date(new Date(facts.asOf).getTime() - DAY_MS));
    const at = (day: string, level: 'confirmed' | 'settled' | 'reconciled') => {
      const { totals, count } = selectionTotals(selectLevel(level, facts, { ...f, from: day, to: day })!);
      return { amounts: totals.toJSON(), consolidatedCdf: totals.consolidated(this.convert), count };
    };
    return {
      today, yesterday,
      confirmed: { today: at(today, 'confirmed'), yesterday: at(yesterday, 'confirmed') },
      settled: { today: at(today, 'settled'), yesterday: at(yesterday, 'settled') },
      reconciled: { today: at(today, 'reconciled'), yesterday: at(yesterday, 'reconciled') },
    };
  }

  profile(user: User, code: string, q: Query) {
    if (!(code in PROFILES)) throw notFound('PROFILE_NOT_FOUND', `Tableau inconnu : ${code}. Tableaux : ${PROFILE_CODES.join(', ')}.`);
    const profil = code as ProfileCode;
    authorize(user, `pilotage:profile.${profil}`, { communes: q.commune ? [q.commune] : user.territory ?? [] });
    if (profil === 'commune' && !q.commune && !user.territory?.length) throw badRequest('COMMUNE_REQUIRED', 'Préciser la commune (paramètre commune).');
    const { filters, scope } = this.filtersFor(user, q);
    if (profil === 'commune' && !filters.commune && filters.communes?.length === 1) filters.commune = filters.communes[0]!;
    const facts = this.facts();
    const c = this.ladderContext(facts, filters);
    const kpis = this.computeKpis(filters);
    const pick = (...codes: string[]) => kpis.filter((k) => codes.includes(k.code));
    const base = {
      profile: profil, ...PROFILES[profil], generatedAt: facts.asOf, example: false, aggregatesOnly: true, scope, filters,
      rule: 'Agrégats seulement ; les niveaux de l’échelle ne s’additionnent jamais. Contre-valeur CDF indicative (taux du jour).',
      ladder: computeLadder(c), contested: contestedIndicator(facts, filters, this.convert),
    };
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'pilotage.profile.viewed', resourceType: 'dashboard', resourceId: profil, details: { filters } });

    switch (profil) {
      case 'gouverneur':
        return {
          ...base, tiles: this.dayTiles(facts, filters),
          criticalAlerts: this.ctx.alerts.alerts.all().filter((a) => a.severity === 'CRITICAL').length,
          byCommune: drill('commune', c), byCategory: drill('category', c), byEntity: drill('entity', c), byChannel: drill('channel', c),
          series: monthlySeries(c, 12), kpis,
        };
      case 'dg-regie':
        return {
          ...base, byCategory: drill('category', c), byCommune: drill('commune', c), series: monthlySeries(c, 12),
          recovery: this.recovery(facts, filters), litigation: this.litigation(facts, filters), performance: this.performance(facts, filters),
          kpis: pick('PAIEMENT_ECHEANCE', 'PAIEMENT_EMISES', 'EXACTITUDE_LIQUIDATION', 'OBLIGATIONS_CONTESTEES', 'DELAI_RECOURS', 'RECOURS_FONDES', 'COUVERTURE_LOCATIVE', 'REGLES_CERTIFIEES'),
        };
      case 'tresor':
        return {
          ...base, tiles: this.dayTiles(facts, filters), suspense: this.suspense(facts, filters), exceptions: this.exceptionSummary(facts, filters),
          providers: this.providers(facts, filters), byChannel: drill('channel', c), ledger: this.ctx.ledger.balance(),
          kpis: pick('RAPPROCHEMENT_J1', 'ECART_RAPPROCHEMENT_J2', 'DELAI_REGLEMENT', 'DELAI_QUITTANCE', 'EXCEPTIONS_OUVERTES', 'EXCEPTIONS_ANCIENNES', 'PART_NUMERIQUE'),
        };
      case 'commune': {
        const objects = this.objectsIn(filters);
        const byCat = new Map<string, number>();
        objects.forEach((o) => byCat.set(o.category, (byCat.get(o.category) ?? 0) + 1));
        return {
          ...base, commune: filters.commune ?? null, byCategory: drill('category', c), byEntity: drill('entity', c), series: monthlySeries(c, 12),
          objects: { total: objects.length, validated: objects.filter((o) => o.status === 'VALIDE').length, byCategory: [...byCat.entries()].map(([category, count]) => ({ category, count })) },
          kpis: pick('COUVERTURE_LOCATIVE', 'VALIDATION_OBJETS', 'TAUX_RECENSEMENT', 'PAIEMENT_ECHEANCE', 'PAIEMENT_EMISES', 'PARCOURS_ASSISTES', 'PART_NUMERIQUE', 'OBLIGATIONS_CONTESTEES'),
        };
      }
      case 'audit':
        return { ...base, integrity: this.integrity(), sensitive: this.sensitiveOperations(), exports: this.exportsLog.all().slice(-20).reverse(), kpis: pick('ALERTES_CRITIQUES', 'EXCEPTIONS_OUVERTES', 'EXCEPTIONS_ANCIENNES', 'EXACTITUDE_LIQUIDATION', 'REGLES_CERTIFIEES', 'ESPECES_AGENTS', 'ECART_RAPPROCHEMENT_J2') };
      case 'ministre':
        return { ...base, byEntity: drill('entity', c), byCategory: drill('category', c), byCommune: drill('commune', c), series: monthlySeries(c, 12), kpis: pick('PAIEMENT_ECHEANCE', 'RAPPROCHEMENT_J1', 'PART_NUMERIQUE', 'REGLES_CERTIFIEES', 'OBLIGATIONS_CONTESTEES', 'COMMUNES_RECETTE') };
    }
  }

  private recovery(facts: Facts, f: Filters) {
    const today = facts.asOf.slice(0, 10);
    const overdue = selectLevel('overdue', facts, f)!.obligations!;
    const buckets = [
      { code: '0-30', label: '0 à 30 jours de retard', min: 0, max: 30 },
      { code: '31-90', label: '31 à 90 jours', min: 31, max: 90 },
      { code: '90+', label: 'Plus de 90 jours', min: 91, max: Number.MAX_SAFE_INTEGER },
    ];
    const daysLate = (due: string) => Math.floor((new Date(today).getTime() - new Date(due).getTime()) / DAY_MS);
    return {
      note: 'Aucune pénalité ni mesure automatique : le système constate et propose ; une personne habilitée décide.',
      buckets: buckets.map((b) => {
        const t = new CurrencyTotals(); let n = 0;
        overdue.filter((o) => { const d = daysLate(o.dueDate); return d >= b.min && d <= b.max; }).forEach((o) => { t.add(o.amount); n++; });
        return { code: b.code, label: b.label, count: n, amounts: t.toJSON(), consolidatedCdf: t.consolidated(this.convert) };
      }),
    };
  }

  private litigation(facts: Facts, f: Filters) {
    const scope = new Set(facts.obligations.filter((o) => matchesDims(o, f)).map((o) => o.id));
    const appeals = facts.appeals.filter((a) => scope.has(a.obligationId));
    const byDecision = new Map<string, number>();
    appeals.filter((a) => a.decision).forEach((a) => byDecision.set(a.decision!, (byDecision.get(a.decision!) ?? 0) + 1));
    return { open: appeals.filter((a) => !a.decidedAt).length, decided: appeals.filter((a) => a.decidedAt).length, byDecision: [...byDecision.entries()].map(([decision, count]) => ({ decision, count })) };
  }

  /** Performance des services : résultats vérifiables (émissions, rectifications fondées), jamais de mesure intrusive. */
  private performance(facts: Facts, f: Filters) {
    const rows = new Map<string, { issued: number; rectified: number }>();
    facts.obligations.filter((o) => matchesDims(o, f)).forEach((o) => {
      const r = rows.get(o.createdBy) ?? { issued: 0, rectified: 0 };
      r.issued++; if (o.rectified) r.rectified++;
      rows.set(o.createdBy, r);
    });
    return {
      note: 'Résultats vérifiables par service émetteur (§ 24.2) : pas de surveillance des personnes.',
      rows: [...rows.entries()].map(([id, r]) => {
        const u = this.ctx.users.get(id);
        return { issuer: u ? u.roles.map((x) => x).join(', ') + ` — ${u.entity}` : id === 'moteur-liquidation' ? 'Moteur de liquidation' : 'Service émetteur', issuerId: id, ...r };
      }),
    };
  }

  private suspense(facts: Facts, f: Filters) {
    const now = new Date(facts.asOf).getTime();
    const pending = facts.orders.filter((o) => matchesDims(o, f) && isConfirmed(o) && !isReconciled(o));
    const buckets = [
      { code: 'lt24', label: 'Moins de 24 h', min: 0, max: DAY_MS },
      { code: '24-48', label: '24 à 48 h', min: DAY_MS + 1, max: 2 * DAY_MS },
      { code: 'gt48', label: 'Plus de 48 h', min: 2 * DAY_MS + 1, max: Number.MAX_SAFE_INTEGER },
    ];
    return buckets.map((b) => {
      const t = new CurrencyTotals(); let n = 0;
      pending.filter((o) => { const age = now - new Date(o.confirmedAt!).getTime(); return age >= b.min && age <= b.max; }).forEach((o) => { t.add(o.amount); n++; });
      return { code: b.code, label: b.label, count: n, amounts: t.toJSON(), consolidatedCdf: t.consolidated(this.convert) };
    });
  }

  private exceptionSummary(facts: Facts, f: Filters) {
    const inputs = this.kpiInputs(facts, f);
    const byType = new Map<string, { count: number; over30: number }>();
    const now = new Date(facts.asOf).getTime();
    inputs.exceptions.forEach((e) => {
      const r = byType.get(e.type) ?? { count: 0, over30: 0 };
      r.count++; if (now - new Date(e.openedAt).getTime() > 30 * DAY_MS) r.over30++;
      byType.set(e.type, r);
    });
    return { open: inputs.exceptions.length, byType: [...byType.entries()].map(([type, r]) => ({ type, ...r })) };
  }

  private providers(facts: Facts, f: Filters) {
    const rows = new Map<string, { confirmed: number; settled: number; reconciled: number; awaiting: number }>();
    facts.orders.filter((o) => matchesDims(o, f) && isConfirmed(o)).forEach((o) => {
      const key = o.provider ?? 'inconnu';
      const r = rows.get(key) ?? { confirmed: 0, settled: 0, reconciled: 0, awaiting: 0 };
      r.confirmed++; if (isSettled(o)) r.settled++; if (isReconciled(o)) r.reconciled++; else r.awaiting++;
      rows.set(key, r);
    });
    return [...rows.entries()].map(([provider, r]) => ({ provider, ...r }));
  }

  private integrity() {
    const v = this.ctx.audit.verify();
    const b = this.ctx.ledger.balance();
    return {
      audit: { ok: v.ok, length: v.length, headHash: v.headHash, verifiedAt: v.verifiedAt, ...(v.ok ? {} : { brokenAt: v.brokenAt, reason: v.reason }) },
      ledger: { balanced: b.balanced, entries: b.entries, headHash: b.headHash },
    };
  }

  private sensitiveOperations() {
    const families: { code: string; label: string; prefix: string }[] = [
      { code: 'ACCES_REFUSES', label: 'Accès refusés', prefix: 'access.denied' },
      { code: 'CONTRE_ECRITURES', label: 'Contre-écritures', prefix: 'ledger.entry.reversed' },
      { code: 'BENEFICIAIRES', label: 'Changements de compte bénéficiaire', prefix: 'beneficiary.' },
      { code: 'REGLES', label: 'Cycle de vie des règles', prefix: 'rule.' },
      { code: 'RECTIFICATIONS', label: 'Obligations rectifiées', prefix: 'assessment.rectified' },
      { code: 'ALERTES', label: 'Alertes de sécurité', prefix: 'security.alert' },
      { code: 'EXPORTS', label: 'Exports signés', prefix: 'pilotage.export' },
      { code: 'PUBLICATIONS', label: 'Publications de transparence', prefix: 'pilotage.transparency.published' },
      { code: 'PISTES', label: 'Consultations de pistes d’audit', prefix: 'pilotage.audit_trail' },
    ];
    return families.map((fam) => ({ ...fam, count: this.ctx.audit.list({ action: fam.prefix, limit: 0 }).total }));
  }

  // ————————————————————————— consultation jusqu'au paiement (rôles habilités) —————————————————————————

  payments(user: User, q: Query, limit = 200) {
    this.gate(user, 'drill.payments');
    const { filters, scope } = this.filtersFor(user, q);
    const facts = this.facts();
    const rows = facts.orders
      .filter((o) => matchesDims(o, filters) && (!filters.channel || filters.channel === o.channel))
      .filter((o) => !filters.from && !filters.to ? true : (o.createdAt.slice(0, 10) >= (filters.from ?? '0000') && o.createdAt.slice(0, 10) <= (filters.to ?? '9999')))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    this.viewed(user, 'drill:paiements', filters);
    return {
      generatedAt: facts.asOf, scope, filters, total: rows.length,
      note: 'Traçabilité jusqu’aux écritures sources, sans nom ni coordonnée du contribuable.',
      items: rows.slice(0, limit).map((o) => ({
        paymentReference: o.paymentReference, orderId: o.id, obligationId: o.obligationId, commune: o.commune, category: o.category, entity: o.entity,
        channel: o.channel, provider: o.provider ?? null, amount: o.amount, status: o.status, createdAt: o.createdAt,
        confirmedAt: o.confirmedAt ?? null, settledAt: o.settledAt ?? null, reconciledAt: o.reconciledAt ?? null, ledgerEntryIds: o.ledgerEntryIds,
      })),
    };
  }

  // ————————————————————————— piste d'audit par dossier —————————————————————————

  dossiers(user: User) {
    this.gate(user, 'audit_trail.read');
    const obligations = this.ctx.assessment.obligations.all().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30);
    return {
      items: obligations.map((o) => {
        const orders = this.ctx.payments.byObligation(o.id);
        return {
          obligationId: o.id, objectId: o.objectId, label: o.label, commune: o.attribution?.commune ?? 'NON_ATTRIBUE', status: o.status, amount: o.amount,
          createdAt: o.createdAt, payments: orders.map((p) => ({ orderId: p.id, paymentReference: p.paymentReference, status: p.status })),
        };
      }),
    };
  }

  auditTrail(user: User, ref: string) {
    this.gate(user, 'audit_trail.read');
    const { kind, id } = resolveDossier(this.ctx, ref);
    const graph = buildGraph(this.ctx, kind, id);
    const { events, controls } = buildTrail(this.ctx, graph);
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'pilotage.audit_trail.viewed', resourceType: kind === 'objet' ? 'fiscal_object' : kind === 'obligation' ? 'obligation' : 'payment_order', resourceId: id,
      details: { ref, events: events.length },
    });
    return {
      dossier: { ref, kind, id }, generatedAt: this.now(),
      graph: { ...graph, taxpayerIds: undefined, taxpayerCount: graph.taxpayerIds.length },
      complete: controls.every((c) => c.passed), controls, events,
      note: 'Chronologie fusionnée : journal d’audit chaîné, grand livre, quittances, réclamations et délivrances (destinataire masqué).',
    };
  }

  // ————————————————————————— transparence publique —————————————————————————

  private personalTokens(): string[] {
    const out: string[] = [];
    for (const t of this.ctx.taxpayers.taxpayers.all()) out.push(t.id, t.iuc, t.fullName, t.phone, ...(t.email ? [t.email] : []));
    for (const o of this.ctx.payments.orders.all()) out.push(o.paymentReference, o.obligationId);
    return out.filter((x) => typeof x === 'string' && x.length > 0);
  }

  transparencyBuild(period: string) {
    const range = periodRange(period);
    if (!/-T[1-4]$|-Q[1-4]$/.test(period)) throw badRequest('INVALID_PERIOD', 'La transparence publique est trimestrielle : AAAA-Tn attendu.');
    const norm = period.replace('-Q', '-T');
    const build = buildTransparency(this.facts(), norm, range);
    return { build, check: reidentificationCheck(build, this.personalTokens()) };
  }

  transparencyPreview(user: User, period: string) {
    this.gate(user, 'transparency.preview');
    const { build, check } = this.transparencyBuild(period);
    return { status: 'APERCU_NON_PUBLIE', content: build.content, check, published: this.publicationsFor(build.content.period).map((p) => ({ version: p.version, publishedAt: p.publishedAt, sha256: p.sha256 })) };
  }

  private publicationsFor(period: string) {
    return this.publications.find((p) => p.period === period).sort((a, b) => a.version - b.version);
  }

  publishTransparency(user: User, period: string, motif: string) {
    this.gate(user, 'transparency.publish');
    const { build, check } = this.transparencyBuild(period);
    const quarterNow = quarterOf(this.now().slice(0, 10));
    if (build.content.period > quarterNow) throw conflict('PERIOD_NOT_STARTED', `Le trimestre ${build.content.period} n’a pas commencé.`);
    if (!check.passed) {
      this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'pilotage.transparency.refused', resourceType: 'transparency', resourceId: build.content.period, outcome: 'DENIED', details: { checks: check.checks } });
      throw conflict('REIDENTIFICATION_RISK', 'Publication refusée : le test anti-ré-identification a échoué.', { checks: check.checks });
    }
    const previous = this.publicationsFor(build.content.period);
    const { sha256, signature } = this.signer.sign(jsonPayload(build.content));
    if (previous.at(-1)?.sha256 === sha256) throw conflict('ALREADY_PUBLISHED', `Le tableau ${build.content.period} est déjà publié à l’identique (version ${previous.at(-1)!.version}).`);
    const pub = this.publications.append({
      id: this.ids.next('PUB'), period: build.content.period, version: previous.length + 1, publishedAt: this.now(), publishedBy: user.id,
      authority: user.roles.includes('R01') ? 'Gouverneur' : 'Ministre provincial des Finances', motif, content: build.content, check, sha256, signature,
    });
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'pilotage.transparency.published', resourceType: 'transparency', resourceId: pub.period,
      details: { version: pub.version, sha256, motif },
    });
    return this.publicView(pub);
  }

  private publicView(p: Publication) {
    return {
      period: p.period, version: p.version, publishedAt: p.publishedAt, authority: p.authority, content: p.content,
      check: p.check, integrity: { sha256: p.sha256, signature: p.signature, algorithm: 'HMAC-SHA256', keyId: EXPORT_KEY_ID, payload: 'JSON canonique du champ content' },
    };
  }

  publicIndex() {
    const all = this.publications.all();
    const latestByPeriod = new Map<string, Publication>();
    all.forEach((p) => latestByPeriod.set(p.period, p));
    const periods = [...latestByPeriod.values()].sort((a, b) => b.period.localeCompare(a.period));
    return {
      title: 'Transparence publique des recettes de la Ville-Province de Kinshasa',
      note: 'Agrégats trimestriels des recettes rapprochées, sans aucune donnée personnelle.',
      periods: periods.map((p) => ({ period: p.period, version: p.version, publishedAt: p.publishedAt })),
      latest: periods[0] ? this.publicView(periods[0]) : null,
    };
  }

  publicPeriod(period: string) {
    const norm = period.replace('-Q', '-T');
    const p = this.publicationsFor(norm).at(-1);
    if (!p) throw notFound('NOT_PUBLISHED', `Aucun tableau publié pour ${norm}.`);
    return this.publicView(p);
  }

  // ————————————————————————— exports signés —————————————————————————

  private exportData(user: User, kind: ExportKind, q: Query & { dimension?: string; ref?: string }) {
    const { filters } = kind === 'piste-audit' || kind === 'transparence' ? { filters: {} as Filters } : this.filtersFor(user, q);
    switch (kind) {
      case 'echelle': {
        const l = this.ladder(user, q);
        const rows: CsvCell[][] = [];
        for (const lv of l.levels) {
          if (lv.amounts.length === 0) rows.push([lv.rank, lv.level, lv.label, lv.measure, '', '', lv.count, lv.consolidatedCdf?.amount ?? '', lv.source, lv.note ?? '']);
          for (const m of lv.amounts) rows.push([lv.rank, lv.level, lv.label, lv.measure, m.currency, m.amount, lv.count, lv.consolidatedCdf?.amount ?? '', lv.source, lv.note ?? '']);
        }
        for (const m of l.contested.amounts) rows.push(['—', 'contested', l.contested.label, 'INDICATEUR_SEPARE', m.currency, m.amount, l.contested.count, '', 'Réclamations', l.contested.note]);
        return { filters, data: l, columns: ['rang', 'niveau', 'libelle', 'mesure', 'devise', 'montant', 'nombre', 'contre_valeur_cdf_indicative', 'source', 'note'], rows };
      }
      case 'indicateurs': {
        const k = this.kpis(user, q);
        return {
          filters, data: k, columns: ['code', 'domaine', 'libelle', 'valeur', 'unite', 'numerateur', 'denominateur', 'cible', 'statut', 'tendance', 'valeur_precedente', 'formule', 'source'],
          rows: k.kpis.map((x) => [x.code, x.domain, x.label, x.value ?? 'non mesuré', x.unit, x.numerator ?? '', x.denominator ?? '', x.targetLabel, x.status, x.trend.direction, x.trend.previous ?? '', x.formula, x.source]),
        };
      }
      case 'drill': {
        const dim = (q.dimension ?? 'commune') as DrillDimension;
        if (!['commune', 'category', 'entity', 'channel', 'month'].includes(dim)) throw badRequest('INVALID_DIMENSION', `Dimension inconnue : ${dim}`);
        const d = this.drill(user, dim, q);
        const rows: CsvCell[][] = [];
        for (const r of d.rows) for (const lv of d.levels) for (const m of (r.values[lv.level] as { amounts: MoneyJSON[]; count: number }).amounts) rows.push([r.key, lv.level, lv.label, m.currency, m.amount, (r.values[lv.level] as { count: number }).count]);
        return { filters, data: d, columns: [dim, 'niveau', 'libelle', 'devise', 'montant', 'nombre'], rows };
      }
      case 'piste-audit': {
        if (!q.ref) throw badRequest('REF_REQUIRED', 'Référence de dossier requise (paramètre ref).');
        const t = this.auditTrail(user, q.ref);
        return {
          filters: { ref: q.ref }, data: t, columns: ['horodatage', 'source', 'type', 'libelle', 'ressource', 'acteur', 'resultat', 'empreinte'],
          rows: t.events.map((e) => [e.at, e.source, e.kind, e.label, `${e.resourceType}:${e.resourceId ?? ''}`, e.actor ? `${e.actor.kind}:${e.actor.id}` : '', e.outcome ?? '', e.hash ?? '']),
        };
      }
      case 'transparence': {
        const period = q.period ?? quarterOf(this.now().slice(0, 10));
        this.gate(user, 'transparency.preview');
        const { build, check } = this.transparencyBuild(period);
        const rows: CsvCell[][] = [];
        for (const [dim, list] of [['commune', build.content.byCommune], ['categorie', build.content.byCategory]] as const) {
          for (const r of list) for (const c of r.cells) rows.push([dim, r.key, r.label, c.currency, c.amount ?? '', c.contributors ?? '', c.suppressed ? 'oui' : 'non', c.reason ?? '']);
        }
        for (const c of build.content.totals) rows.push(['total', 'TOTAL', 'Total', c.currency, c.amount ?? '', c.contributors ?? '', c.suppressed ? 'oui' : 'non', c.reason ?? '']);
        return { filters: { period }, data: { content: build.content, check }, columns: ['dimension', 'cle', 'libelle', 'devise', 'montant', 'contribuables', 'masque', 'motif'], rows };
      }
    }
  }

  export(user: User, kind: string, q: Query & { dimension?: string; ref?: string }) {
    if (!EXPORT_KINDS.includes(kind as ExportKind)) throw notFound('EXPORT_KIND_NOT_FOUND', `Export inconnu : ${kind}. Exports : ${EXPORT_KINDS.join(', ')}.`);
    this.gate(user, kind === 'piste-audit' ? 'audit_trail.read' : 'export');
    const { filters, data, columns, rows } = this.exportData(user, kind as ExportKind, q);
    const generatedAt = this.now();
    const exportId = this.ids.next('EXP');
    const csv = toCsv(columns, rows);
    const json = jsonPayload({ exportId, kind, generatedAt, filters, data });
    const manifest = (format: 'csv' | 'json', payload: string): ExportManifest => ({
      exportId, kind, format, generatedAt, generatedBy: { id: user.id, roles: user.roles }, filters: filters as Record<string, unknown>, rows: rows.length,
      ...this.signer.sign(payload), algorithm: 'HMAC-SHA256', keyId: EXPORT_KEY_ID,
      note: format === 'csv' ? 'Empreinte SHA-256 des octets UTF-8 du fichier CSV (BOM inclus).' : 'Empreinte SHA-256 du JSON canonique (clés triées) du fichier.',
    });
    const mCsv = manifest('csv', csv);
    const mJson = manifest('json', json);
    this.exportsLog.append({ ...mCsv, id: `${exportId}-csv` });
    this.exportsLog.append({ ...mJson, id: `${exportId}-json` });
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'pilotage.export.generated', resourceType: 'export', resourceId: exportId,
      details: { kind, filters, rows: rows.length, csvSha256: mCsv.sha256, jsonSha256: mJson.sha256 },
    });
    return { exportId, csv: { filename: `mosolo-${kind}-${exportId}.csv`, content: csv, manifest: mCsv }, json: { filename: `mosolo-${kind}-${exportId}.json`, content: json, manifest: mJson } };
  }

  verifyExport(payload: string, sha256: string, signature: string) {
    const r = this.signer.verify(payload, sha256, signature);
    const known = this.exportsLog.findOne((m) => m.sha256 === sha256.toLowerCase());
    return {
      valid: r.integrity && r.authentic, integrity: r.integrity, authentic: r.authentic,
      registered: known ? { exportId: known.exportId, kind: known.kind, format: known.format, generatedAt: known.generatedAt } : null,
    };
  }
}
