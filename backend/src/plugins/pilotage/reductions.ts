/**
 * Rapport « réductions de recettes » (fuites) : du liquidé brut au net attendu, puis à l'encaissé.
 *
 *   brut liquidé − Σ réductions = net attendu   (par devise, écart toléré ≤ 0,01 ; jamais de somme entre devises)
 *
 * Sources (lecture seule) :
 *  - chaînes d'obligations (originale → rectificatives) et leurs traces de liquidation : brut avant exonération
 *    (`trace.grossResult`), exonérations appliquées à la liquidation (`trace.adjustments`), rectifications
 *    (réclamation, remise, correction de déclaration, recalcul contrôlé), annulation, admission en non-valeur ;
 *  - journal d'audit : événements `reduction.granted` {path, obligationId, fromAmount, toAmount, deciderId, taxpayerId}
 *    (décideur et voie de la réduction), `recovery.remission.granted`, et actes d'annulation pour retrouver le décideur.
 *    Une réduction sans décideur traçable est signalée « NON_TRACE » — jamais devinée.
 *
 * Section « recettes potentielles non liquidées » : objets et dispositifs taxables sans obligation faute de règle
 * ACTIVE (publicité « acte requis », verticales ACTE_REQUIS / CADRAGE_REQUIS) — nombre et assiette physique
 * (surface, unités) seulement : aucun montant n'est jamais estimé sans barème certifié.
 */
import { Money, UNATTRIBUTED_COMMUNE, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { AuditRecord } from '../../core/audit.js';
import type { Obligation } from '../../modules/assessment/service.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { findVertical, LEGAL_LABEL, NO_LEVY_STATUSES, OBJECT_TYPE_VERTICAL, VERTICALS } from '../verticales/catalogue.js';

export const REDUCTION_TYPES = [
  'EXONERATION', 'MINORATION_LIQUIDATION', 'REMISE', 'RECLAMATION', 'CORRECTION_DECLARATION', 'RECALCUL',
  'AUTRE_RECTIFICATION', 'ANNULATION', 'ADMISSION_NON_VALEUR',
] as const;
export type ReductionType = (typeof REDUCTION_TYPES)[number];

export const REDUCTION_LABELS: Record<ReductionType, string> = {
  EXONERATION: 'Exonération appliquée à la liquidation',
  MINORATION_LIQUIDATION: 'Minoration à la liquidation (forçage de base)',
  REMISE: 'Remise gracieuse',
  RECLAMATION: 'Dégrèvement sur réclamation',
  CORRECTION_DECLARATION: 'Correction de déclaration',
  RECALCUL: 'Recalcul contrôlé (nouvelle version de règle)',
  AUTRE_RECTIFICATION: 'Autre rectification',
  ANNULATION: 'Annulation',
  ADMISSION_NON_VALEUR: 'Admission en non-valeur',
};

/** Décideur non retrouvé dans les traces : signalé comme tel, jamais attribué par défaut. */
export const UNTRACED_DECIDER = 'NON_TRACE';

export interface ReductionLine {
  type: ReductionType;
  /** Obligation dont le montant a été réduit. */
  obligationId: string;
  /** Obligation d'origine de la chaîne. */
  rootId: string;
  /** Obligation résultante (rectificative) le cas échéant. */
  resultingObligationId: string | null;
  amount: MoneyJSON;
  at: string;
  deciderId: string;
  commune: string;
  module: string;
  entity: string;
  ruleCode: string;
  taxpayerId: string;
  /** Voie déclarée par l'événement `reduction.granted` s'il existe. */
  path?: string;
  auditId?: string;
}

export interface ChainSummary {
  rootId: string;
  headId: string;
  currency: CurrencyCode;
  commune: string;
  module: string;
  entity: string;
  taxpayerId: string;
  createdAt: string;
  gross: MoneyJSON;
  net: MoneyJSON;
  collected: MoneyJSON;
}

export interface ReductionFilters {
  commune?: string;
  communes?: string[];
  entity?: string;
  from?: string;
  to?: string;
  /** Type de réduction et décideur : filtrent les réductions ET les chaînes (celles qui portent au moins une réduction retenue). */
  type?: ReductionType;
  decider?: string;
}

interface GrantedEvent {
  auditId: string;
  at: string;
  path: string;
  obligationId: string;
  from?: Money;
  to?: Money;
  deciderId?: string;
  taxpayerId?: string;
}

const CANCEL_ACTION = /(cancel|annul|non_valeur|nonvaleur|write_off|writeoff)/i;

/** Module d'origine d'une obligation (code de règle, source déclarative) — libellé de regroupement seulement. */
export function moduleOf(o: Pick<Obligation, 'ruleCode' | 'trace'>): string {
  const c = o.ruleCode.toUpperCase();
  if (o.trace?.source?.type === 'DECLARATION') return 'fiscal';
  if (c.includes('-PUB-')) return 'publicite';
  if (c.includes('-PARK-')) return 'parking';
  if (c.includes('-VX-') || c.startsWith('AVIA')) return 'verticales';
  if (c.includes('WEWA') || c.includes('-RKP-')) return 'rakapay';
  if (c.includes('PENAL') || c.includes('AMENDE')) return 'sanctions';
  return 'socle';
}

export function typeFromPath(path: string): ReductionType | undefined {
  const p = path.toLowerCase();
  if (/non.?valeur|write/.test(p)) return 'ADMISSION_NON_VALEUR';
  if (/exon|exempt/.test(p)) return 'EXONERATION';
  if (/remis|remission/.test(p)) return 'REMISE';
  if (/declar/.test(p)) return 'CORRECTION_DECLARATION';
  if (/appeal|reclam|recours|contentieux/.test(p)) return 'RECLAMATION';
  if (/recalc/.test(p)) return 'RECALCUL';
  if (/annul|cancel/.test(p)) return 'ANNULATION';
  if (/override|base|minor|liquidation/.test(p)) return 'MINORATION_LIQUIDATION';
  return undefined;
}

function moneyOf(v: unknown, fallback: CurrencyCode): Money | undefined {
  try {
    if (typeof v === 'string' && v.trim()) return Money.of(v, fallback);
    if (typeof v === 'number') return Money.of(v, fallback);
    if (v && typeof v === 'object' && typeof (v as MoneyJSON).amount === 'string') {
      const j = v as MoneyJSON;
      return Money.fromJSON({ amount: j.amount, currency: j.currency ?? fallback });
    }
  } catch {
    /* montant illisible : ignoré (signalé comme non rapproché) */
  }
  return undefined;
}

const same = (a: Money | undefined, b: Money): boolean => !!a && a.currency === b.currency && a.equals(b);

/** Lit les réductions déclarées (`reduction.granted`) — contrat commun des modules de réduction. */
function grantedEvents(audit: AuditRecord[], byId: Map<string, Obligation>): GrantedEvent[] {
  const out: GrantedEvent[] = [];
  for (const e of audit) {
    if (e.action !== 'reduction.granted') continue;
    const d = e.details;
    const obligationId = typeof d.obligationId === 'string' ? d.obligationId : e.resourceId ?? '';
    const ob = byId.get(obligationId);
    const cur = (ob?.amount.currency ?? 'CDF') as CurrencyCode;
    const from = moneyOf(d.fromAmount, cur);
    const to = moneyOf(d.toAmount, cur);
    out.push({
      auditId: e.id, at: e.at, path: typeof d.path === 'string' ? d.path : 'INCONNUE', obligationId,
      ...(from ? { from } : {}), ...(to ? { to } : {}),
      ...(typeof d.deciderId === 'string' ? { deciderId: d.deciderId } : e.actor.kind === 'user' ? { deciderId: e.actor.id } : {}),
      ...(typeof d.taxpayerId === 'string' ? { taxpayerId: d.taxpayerId } : {}),
    });
  }
  return out;
}

export interface ReductionData {
  chains: ChainSummary[];
  lines: ReductionLine[];
  /** Filtre type / décideur posé : toutes les réductions des chaînes retenues (rapprochement). */
  reconcileLines?: ReductionLine[];
  /** Réductions déclarées (`reduction.granted`) qu'aucune trace d'obligation ne confirme : à examiner, hors totaux. */
  unmatched: { auditId: string; at: string; path: string; obligationId: string; deciderId: string | null; reason: string }[];
  /** Chaînes dont une rectification change de devise : exclues des totaux (jamais de conversion implicite). */
  currencyAnomalies: string[];
}

/**
 * Reconstitue, pour chaque chaîne d'obligations, le brut, les réductions (typées, datées, avec décideur) et le net.
 * Filtre : chaînes dont l'obligation d'origine a été liquidée dans la période (bornes AAAA-MM-JJ incluses) et dans
 * le périmètre (commune, entité) — toutes leurs réductions sont alors incluses, pour que le rapprochement tienne.
 */
export function collectReductions(ctx: AppContext, f: ReductionFilters = {}): ReductionData {
  const all = ctx.assessment.obligations.all();
  const byId = new Map(all.map((o) => [o.id, o]));
  const audit = ctx.audit.list({ limit: 10_000_000 }).items;
  const events = grantedEvents(audit, byId);
  const eventsByObligation = new Map<string, GrantedEvent[]>();
  for (const ev of events) eventsByObligation.set(ev.obligationId, [...(eventsByObligation.get(ev.obligationId) ?? []), ev]);
  const used = new Set<string>();
  const remissionByOriginal = new Map<string, AuditRecord>();
  const cancelActs = new Map<string, AuditRecord>();
  for (const e of audit) {
    if (e.action === 'recovery.remission.granted' && e.resourceId) remissionByOriginal.set(e.resourceId, e);
    if (e.actor.kind === 'user' && CANCEL_ACTION.test(e.action)) {
      const target = typeof e.details.obligationId === 'string' ? e.details.obligationId : e.resourceId;
      if (target && byId.has(target)) cancelActs.set(target, e);
    }
  }
  const takeEvent = (obligationId: string, match: (ev: GrantedEvent) => boolean): GrantedEvent | undefined => {
    const ev = (eventsByObligation.get(obligationId) ?? []).find((x) => !used.has(x.auditId) && match(x));
    if (ev) used.add(ev.auditId);
    return ev;
  };

  const chains: ChainSummary[] = [];
  const lines: ReductionLine[] = [];
  const currencyAnomalies: string[] = [];
  const inScope = (o: Obligation) => {
    const commune = o.attribution?.commune ?? UNATTRIBUTED_COMMUNE;
    const day = o.createdAt.slice(0, 10);
    return (!f.commune || f.commune === commune) && (!f.communes || f.communes.includes(commune)) && (!f.entity || f.entity === o.entity)
      && (!f.from || day >= f.from) && (!f.to || day <= f.to);
  };

  for (const root of all) {
    if (root.supersedes && byId.has(root.supersedes)) continue;
    if (root.trace?.nonOpposable) continue;
    const chain: Obligation[] = [root];
    const seen = new Set([root.id]);
    for (let cur = root; cur.supersededBy && byId.has(cur.supersededBy) && !seen.has(cur.supersededBy);) {
      cur = byId.get(cur.supersededBy)!;
      chain.push(cur);
      seen.add(cur.id);
    }
    const currency = root.amount.currency as CurrencyCode;
    if (chain.some((o) => o.amount.currency !== currency)) {
      currencyAnomalies.push(root.id);
      continue;
    }
    const matchesScope = inScope(root);
    const base = {
      rootId: root.id, commune: root.attribution?.commune ?? UNATTRIBUTED_COMMUNE, module: moduleOf(root), entity: root.entity,
      ruleCode: root.ruleCode, taxpayerId: root.taxpayerId,
    };
    const chainLines: ReductionLine[] = [];
    const rootAmount = Money.fromJSON(root.amount);
    const preExemption = root.trace?.grossResult ? Money.fromJSON(root.trace.grossResult) : rootAmount;
    let gross = preExemption;

    // 1. Exonérations appliquées à la liquidation (brut → montant émis).
    const exempted = preExemption.subtract(rootAmount);
    if (!exempted.isZero() && !exempted.isNegative()) {
      const ev = takeEvent(root.id, (x) => same(x.to, rootAmount) && same(x.from, preExemption));
      const adj = root.trace.adjustments ?? [];
      const decider = ev?.deciderId ?? adj.at(-1)?.decidedBy.at(-1) ?? UNTRACED_DECIDER;
      chainLines.push({
        ...base, type: 'EXONERATION', obligationId: root.id, resultingObligationId: null, amount: exempted.toJSON(), at: root.createdAt,
        deciderId: decider, ...(ev ? { path: ev.path, auditId: ev.auditId } : {}),
      });
    }
    // 2. Minoration déclarée à la liquidation (ex. forçage de base) : le brut remonte au montant calculé avant forçage.
    for (let ev = takeEvent(root.id, (x) => same(x.to, preExemption) && !!x.from && x.from.currency === currency && x.from.compare(preExemption) > 0);
      ev; ev = takeEvent(root.id, (x) => same(x.to, preExemption) && !!x.from && x.from.currency === currency && x.from.compare(preExemption) > 0)) {
      const amount = ev.from!.subtract(preExemption);
      gross = gross.add(amount);
      chainLines.push({
        ...base, type: typeFromPath(ev.path) ?? 'MINORATION_LIQUIDATION', obligationId: root.id, resultingObligationId: null,
        amount: amount.toJSON(), at: ev.at, deciderId: ev.deciderId ?? UNTRACED_DECIDER, path: ev.path, auditId: ev.auditId,
      });
    }
    // 3. Rectifications successives : baisse = réduction typée ; hausse = liquidation complémentaire (ajoutée au brut).
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1]!;
      const next = chain[i]!;
      const diff = Money.fromJSON(prev.amount).subtract(Money.fromJSON(next.amount));
      if (diff.isZero()) continue;
      if (diff.isNegative()) {
        gross = gross.subtract(diff);
        continue;
      }
      const nextAmount = Money.fromJSON(next.amount);
      const ev = takeEvent(prev.id, (x) => same(x.to, nextAmount)) ?? takeEvent(prev.id, (x) => !x.to);
      const r = next.explanation?.rectification;
      const ref = r?.appealId ?? next.appealId ?? '';
      let type: ReductionType = 'AUTRE_RECTIFICATION';
      if (r?.decisionType === 'REMISE' || remissionByOriginal.has(prev.id)) type = 'REMISE';
      else if (r?.decisionType === 'CORRECTION_DECLARATION') type = 'CORRECTION_DECLARATION';
      else if (ref.startsWith('RECALC-')) type = 'RECALCUL';
      else if (ref && ctx.appeals.appeals.get(ref)) type = 'RECLAMATION';
      else if (ev) type = typeFromPath(ev.path) ?? type;
      chainLines.push({
        ...base, type, obligationId: prev.id, resultingObligationId: next.id, amount: diff.toJSON(), at: next.createdAt,
        deciderId: ev?.deciderId ?? next.createdBy ?? UNTRACED_DECIDER, ...(ev ? { path: ev.path, auditId: ev.auditId } : {}),
      });
    }
    // 4. Sort de la dernière obligation : annulée sans remplaçante, ou admise en non-valeur ⇒ réduction du solde.
    const head = chain.at(-1)!;
    const headAmount = Money.fromJSON(head.amount);
    const terminal: ReductionType | undefined = head.status === 'ADMISE_EN_NON_VALEUR' ? 'ADMISSION_NON_VALEUR' : head.status === 'ANNULEE' && !head.supersededBy ? 'ANNULATION' : undefined;
    let net = headAmount;
    if (terminal) {
      net = Money.zero(currency);
      if (!headAmount.isZero()) {
        const ev = takeEvent(head.id, (x) => !!x.to && x.to.currency === currency && (x.to.isZero() || typeFromPath(x.path) === terminal));
        const act = cancelActs.get(head.id);
        chainLines.push({
          ...base, type: ev ? (typeFromPath(ev.path) === 'ADMISSION_NON_VALEUR' ? 'ADMISSION_NON_VALEUR' : terminal) : terminal,
          obligationId: head.id, resultingObligationId: null, amount: headAmount.toJSON(), at: ev?.at ?? act?.at ?? head.createdAt,
          deciderId: ev?.deciderId ?? (act ? act.actor.id : UNTRACED_DECIDER), ...(ev ? { path: ev.path, auditId: ev.auditId } : {}),
        });
      }
    }
    if (!matchesScope) continue;
    let collected = Money.zero(currency);
    try {
      const paid = ctx.assessment.paidAmount(head.id);
      if (paid.currency === currency) collected = paid;
    } catch {
      /* module paiements absent : encaissé nul */
    }
    chains.push({
      ...base, headId: head.id, currency, createdAt: root.createdAt, gross: gross.toJSON(), net: net.toJSON(), collected: collected.toJSON(),
    });
    lines.push(...chainLines);
  }
  const unmatched = events.filter((e) => !used.has(e.auditId)).map((e) => ({
    auditId: e.auditId, at: e.at, path: e.path, obligationId: e.obligationId, deciderId: e.deciderId ?? null,
    reason: byId.has(e.obligationId) ? 'Aucune variation de montant correspondante dans la chaîne d’obligations.' : 'Obligation inconnue.',
  }));
  // Filtre type / décideur : chaînes portant au moins une réduction retenue ; leurs autres réductions restent
  // comptées pour le rapprochement (brut − toutes réductions = net), jamais dans le total des réductions affiché.
  if (f.type || f.decider) {
    const keep = (l: ReductionLine) => (!f.type || l.type === f.type) && (!f.decider || l.deciderId === f.decider);
    const roots = new Set(lines.filter(keep).map((l) => l.rootId));
    const kept = chains.filter((c) => roots.has(c.rootId));
    return { chains: kept, lines: lines.filter(keep), reconcileLines: lines.filter((l) => roots.has(l.rootId)), unmatched, currencyAnomalies };
  }
  return { chains, lines, unmatched, currencyAnomalies };
}

// ———————————————————————————— agrégats ————————————————————————————

type Bucket = { gross: Money; reductions: Money; net: Money; collected: Money; byType: Map<ReductionType, { count: number; amount: Money }>; chains: number };

export interface CurrencyBlock {
  currency: CurrencyCode;
  chains: number;
  grossAssessed: MoneyJSON;
  reductions: { total: MoneyJSON; count: number; byType: { type: ReductionType; label: string; count: number; amount: MoneyJSON }[] };
  netExpected: MoneyJSON;
  collected: MoneyJSON;
  /** Reste à recouvrer = net attendu − encaissé. */
  outstanding: MoneyJSON;
  reconciliation: { grossMinusReductions: MoneyJSON; netExpected: MoneyJSON; gap: MoneyJSON; reconciled: boolean; tolerance: string; otherReductions?: MoneyJSON };
}

const TOLERANCE = '0.01';

function blocks(chains: ChainSummary[], lines: ReductionLine[], reconcileLines?: ReductionLine[]): CurrencyBlock[] {
  const m = new Map<CurrencyCode, Bucket>();
  const bucket = (c: CurrencyCode) => {
    let b = m.get(c);
    if (!b) m.set(c, (b = { gross: Money.zero(c), reductions: Money.zero(c), net: Money.zero(c), collected: Money.zero(c), byType: new Map(), chains: 0 }));
    return b;
  };
  for (const ch of chains) {
    const b = bucket(ch.currency);
    b.chains++;
    b.gross = b.gross.add(Money.fromJSON(ch.gross));
    b.net = b.net.add(Money.fromJSON(ch.net));
    b.collected = b.collected.add(Money.fromJSON(ch.collected));
  }
  for (const l of lines) {
    const a = Money.fromJSON(l.amount);
    const b = bucket(a.currency);
    b.reductions = b.reductions.add(a);
    const t = b.byType.get(l.type) ?? { count: 0, amount: Money.zero(a.currency) };
    b.byType.set(l.type, { count: t.count + 1, amount: t.amount.add(a) });
  }
  // Réductions des chaînes retenues écartées par le filtre type / décideur : rapprochement seulement.
  const other = new Map<CurrencyCode, Money>();
  if (reconcileLines) {
    const shown = new Set(lines);
    for (const l of reconcileLines) {
      if (shown.has(l)) continue;
      const a = Money.fromJSON(l.amount);
      bucket(a.currency);
      other.set(a.currency, (other.get(a.currency) ?? Money.zero(a.currency)).add(a));
    }
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, b]) => {
    const others = reconcileLines ? other.get(currency) ?? Money.zero(currency) : undefined;
    const expected = b.gross.subtract(b.reductions).subtract(others ?? Money.zero(currency));
    const gap = expected.subtract(b.net);
    const abs = gap.isNegative() ? gap.negate() : gap;
    return {
      currency,
      chains: b.chains,
      grossAssessed: b.gross.toJSON(),
      reductions: {
        total: b.reductions.toJSON(),
        count: [...b.byType.values()].reduce((n, t) => n + t.count, 0),
        byType: REDUCTION_TYPES.filter((t) => b.byType.has(t)).map((t) => ({ type: t, label: REDUCTION_LABELS[t], count: b.byType.get(t)!.count, amount: b.byType.get(t)!.amount.toJSON() })),
      },
      netExpected: b.net.toJSON(),
      collected: b.collected.toJSON(),
      outstanding: b.net.subtract(b.collected).toJSON(),
      reconciliation: {
        grossMinusReductions: expected.toJSON(), netExpected: b.net.toJSON(), gap: gap.toJSON(),
        reconciled: abs.compare(Money.of(TOLERANCE, currency)) <= 0, tolerance: TOLERANCE, ...(others ? { otherReductions: others.toJSON() } : {}),
      },
    };
  });
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

function reductionTotals(lines: ReductionLine[]) {
  const byCur = groupBy(lines, (l) => l.amount.currency);
  return [...byCur.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, ls]) => ({
    currency,
    count: ls.length,
    amount: ls.reduce((acc, l) => acc.add(Money.fromJSON(l.amount)), Money.zero(currency as CurrencyCode)).toJSON(),
    byType: REDUCTION_TYPES.filter((t) => ls.some((l) => l.type === t)).map((t) => {
      const lt = ls.filter((l) => l.type === t);
      return { type: t, count: lt.length, amount: lt.reduce((acc, l) => acc.add(Money.fromJSON(l.amount)), Money.zero(currency as CurrencyCode)).toJSON() };
    }),
  }));
}

export function buildReductionReport(data: ReductionData) {
  const { chains, lines, reconcileLines: rl } = data;
  const totals = blocks(chains, lines, rl);
  const dims = (keyChain: (c: ChainSummary) => string, keyLine: (l: ReductionLine) => string) => {
    const keys = new Set([...chains.map(keyChain), ...lines.map(keyLine)]);
    return [...keys].sort().map((k) => ({ key: k, totals: blocks(chains.filter((c) => keyChain(c) === k), lines.filter((l) => keyLine(l) === k), rl?.filter((l) => keyLine(l) === k)) }));
  };
  const byDecider = [...groupBy(lines, (l) => l.deciderId).entries()]
    .map(([deciderId, ls]) => ({ deciderId, traced: deciderId !== UNTRACED_DECIDER, count: ls.length, communes: [...new Set(ls.map((l) => l.commune))].sort(), totals: reductionTotals(ls) }))
    .sort((a, b) => b.count - a.count || a.deciderId.localeCompare(b.deciderId));
  return {
    totals,
    reconciled: totals.every((t) => t.reconciliation.reconciled),
    byCommune: dims((c) => c.commune, (l) => l.commune).map(({ key, totals: t }) => ({ commune: key, totals: t })),
    byModule: dims((c) => c.module, (l) => l.module).map(({ key, totals: t }) => ({ module: key, totals: t })),
    byDecider,
    untracedDeciders: lines.filter((l) => l.deciderId === UNTRACED_DECIDER).length,
    unmatchedDeclaredReductions: data.unmatched,
    currencyAnomalies: data.currencyAnomalies,
  };
}

// ———————————————————— recettes potentielles non liquidées ————————————————————

/** Surface en centièmes de m² (chaîne décimale positive) ; illisible ⇒ null. */
function hundredths(v: unknown): bigint | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  return BigInt(m[1]!) * 100n + BigInt(frac);
}
const fmtHundredths = (v: bigint): string => `${v / 100n}.${String(v % 100n).padStart(2, '0')}`;

const SURFACE_KEYS = ['surface_m2', 'superficie_m2', 'surfaceM2', 'superficie', 'surface'];

function verticalOf(o: FiscalObject): string | undefined {
  const explicit = typeof o.attributes.verticale === 'string' ? o.attributes.verticale : undefined;
  if (explicit && findVertical(explicit)) return explicit;
  const t = typeof o.attributes.objectType === 'string' ? o.attributes.objectType : undefined;
  if (t && OBJECT_TYPE_VERTICAL[t]) return OBJECT_TYPE_VERTICAL[t];
  return VERTICALS.find((v) => v.objectCategories.includes(o.category))?.slug;
}

/** Vue minimale du module publicité (chargé ou non). */
interface PubliciteView {
  devices: { all(): { id: string; commune: string; surfaceM2: string; faces: number; registration: string; placement: string }[] };
  deviceStatus(d: unknown): { rights: string };
}

export interface PotentialRow {
  vertical: string;
  commune: string;
  legalStatus: string;
  reason: string;
  ruleCode: string | null;
  units: number;
  /** Surface cumulée (m², surface × faces pour la publicité) des unités dont la surface est connue. */
  surfaceM2: string | null;
  unitsWithSurface: number;
}

export function potentialUnassessed(ctx: AppContext, f: ReductionFilters = {}) {
  const rows = new Map<string, PotentialRow & { _surface: bigint }>();
  const keep = (commune: string) => (!f.commune || f.commune === commune) && (!f.communes || f.communes.includes(commune));
  const add = (vertical: string, commune: string, legalStatus: string, reason: string, ruleCode: string | null, surface: bigint | null) => {
    if (!keep(commune)) return;
    const k = `${vertical}|${commune}|${legalStatus}`;
    const r = rows.get(k) ?? { vertical, commune, legalStatus, reason, ruleCode, units: 0, surfaceM2: null, unitsWithSurface: 0, _surface: 0n };
    r.units++;
    if (surface !== null) {
      r._surface += surface;
      r.unitsWithSurface++;
    }
    rows.set(k, r);
  };

  // Publicité : dispositifs autorisés dont la liquidation est restée « acte requis » (barème non ACTIF).
  const pub = ctx.ext.publicite as PubliciteView | undefined;
  if (pub && typeof pub.deviceStatus === 'function') {
    for (const d of pub.devices.all()) {
      if (d.registration === 'RETIRE') continue;
      if (pub.deviceStatus(d).rights !== 'ACTE_REQUIS') continue;
      const face = hundredths(d.surfaceM2);
      add('publicite', d.commune, 'ACTE_REQUIS', 'Barème de la taxe non publié (aucune règle ACTIVE)',
        d.placement === 'VEHICULE' ? 'DEMO-PUB-MOBILE' : 'DEMO-PUB-SURFACE', face === null ? null : face * BigInt(d.faces));
    }
  }
  // Verticales dont le statut juridique interdit tout prélèvement (ACTE_REQUIS, CADRAGE_REQUIS).
  for (const o of ctx.objects.objects.all()) {
    const slug = verticalOf(o);
    const v = slug ? findVertical(slug) : undefined;
    if (!v || !NO_LEVY_STATUSES.includes(v.legal)) continue;
    let surface: bigint | null = null;
    for (const k of SURFACE_KEYS) {
      surface = hundredths(o.attributes[k]);
      if (surface !== null) break;
    }
    add(v.slug, o.commune || UNATTRIBUTED_COMMUNE, v.legal, LEGAL_LABEL[v.legal], null, surface);
  }
  const list = [...rows.values()].map(({ _surface, ...r }) => ({ ...r, surfaceM2: r.unitsWithSurface ? fmtHundredths(_surface) : null }))
    .sort((a, b) => a.vertical.localeCompare(b.vertical) || a.commune.localeCompare(b.commune));
  const byVertical = [...groupBy(list, (r) => r.vertical).entries()].map(([vertical, rs]) => ({
    vertical, units: rs.reduce((n, r) => n + r.units, 0), communes: rs.length,
  }));
  return {
    note: 'Aucun montant estimé : sans règle ACTIVE certifiée, seule l’assiette physique (unités, surface) est indiquée.',
    units: list.reduce((n, r) => n + r.units, 0),
    byVertical,
    rows: list,
  };
}

// ———————————————————— signaux de concentration des réductions ————————————————————

/** Paramètres de DÉMONSTRATION (à fixer par le comité anti-fraude). Seuils cumulés par contribuable, par devise. */
export const REDUCTION_ALERT_PARAMS = {
  demo: true,
  /** Part strictement supérieure à 50 % des réductions (nombre OU montant) d'une commune sur un mois. */
  deciderShare: '0.5',
  /** Nombre minimal de réductions dans la commune et le mois pour qu'une part ait un sens. */
  minReductionsInGroup: 3,
  /** Cumul des réductions accordées à un même contribuable (toutes voies confondues), par devise. */
  taxpayerThreshold: { USD: '1000', CDF: '2500000' } as Partial<Record<CurrencyCode, string>>,
};

export interface ReductionSignal {
  kind: 'DECIDEUR_CONCENTRE' | 'CUMUL_CONTRIBUABLE';
  fingerprint: string;
  detail: string;
  context: Record<string, unknown>;
}

const sumMinor = (ls: ReductionLine[], currency: string): bigint =>
  ls.filter((l) => l.amount.currency === currency).reduce((acc, l) => acc + Money.fromJSON(l.amount).minor, 0n);

/**
 * Signaux (jamais de sanction) : (1) un décideur détient plus de 50 % des réductions d'une commune sur un mois,
 * en nombre ou en montant (par devise) ; (2) le cumul des réductions d'un contribuable dépasse le seuil de la devise.
 */
export function reductionSignals(lines: ReductionLine[], params = REDUCTION_ALERT_PARAMS): ReductionSignal[] {
  const out: ReductionSignal[] = [];
  const [intPart, fracPart = ''] = params.deciderShare.split('.');
  const num = BigInt(`${intPart}${fracPart}`);
  const den = 10n ** BigInt(fracPart.length);
  for (const [key, group] of groupBy(lines, (l) => `${l.commune}|${l.at.slice(0, 7)}`)) {
    if (group.length < params.minReductionsInGroup) continue;
    const [commune, month] = key.split('|') as [string, string];
    const currencies = [...new Set(group.map((l) => l.amount.currency))];
    for (const [decider, mine] of groupBy(group, (l) => l.deciderId)) {
      if (decider === UNTRACED_DECIDER) continue;
      const byCount = BigInt(mine.length) * den > BigInt(group.length) * num;
      const byAmount = currencies.filter((c) => {
        const total = sumMinor(group, c);
        return total > 0n && sumMinor(mine, c) * den > total * num;
      });
      if (!byCount && !byAmount.length) continue;
      out.push({
        kind: 'DECIDEUR_CONCENTRE',
        fingerprint: `RED-DEC:${commune}:${month}:${decider}`,
        detail: `${decider} a décidé ${mine.length} des ${group.length} réductions de recettes de ${commune} en ${month}${byAmount.length ? ` (plus de la moitié du montant en ${byAmount.join(', ')})` : ''} : examen humain proposé, aucune mesure automatique.`,
        context: {
          commune, month, deciderId: decider, count: mine.length, groupCount: group.length, byCount, byAmountCurrencies: byAmount,
          amounts: currencies.map((c) => ({ currency: c, decider: Money.fromMinor(sumMinor(mine, c), c as CurrencyCode).toJSON(), total: Money.fromMinor(sumMinor(group, c), c as CurrencyCode).toJSON() })),
          types: [...new Set(mine.map((l) => l.type))],
        },
      });
    }
  }
  for (const [taxpayerId, mine] of groupBy(lines, (l) => l.taxpayerId)) {
    for (const c of new Set(mine.map((l) => l.amount.currency))) {
      const threshold = params.taxpayerThreshold[c as CurrencyCode];
      if (!threshold) continue;
      const total = Money.fromMinor(sumMinor(mine, c), c as CurrencyCode);
      if (total.compare(Money.of(threshold, c as CurrencyCode)) <= 0) continue;
      const ls = mine.filter((l) => l.amount.currency === c);
      out.push({
        kind: 'CUMUL_CONTRIBUABLE',
        // L'empreinte suit le nombre de réductions : un nouveau cumul au-delà du seuil rouvre un signal.
        fingerprint: `RED-TP:${taxpayerId}:${c}:${ls.length}`,
        detail: `Réductions cumulées de ${total.toDecimalString()} ${c} pour un même contribuable (seuil ${threshold} ${c}, ${ls.length} réduction(s)) : examen humain proposé.`,
        context: {
          taxpayerId, currency: c, total: total.toJSON(), threshold, count: ls.length,
          deciders: [...new Set(ls.map((l) => l.deciderId))], types: [...new Set(ls.map((l) => l.type))], obligations: [...new Set(ls.map((l) => l.rootId))],
        },
      });
    }
  }
  return out;
}
