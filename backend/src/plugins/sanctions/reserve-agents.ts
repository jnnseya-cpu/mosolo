/**
 * Réserve des agents et sous-traitants (module 67, § 37A.5) — décision du maître d'ouvrage du 27/09/2026.
 *
 * Les 10 % « agents et sous-traitants » de la clé du § 37A forment une RÉSERVE PAR MODULE (code de règle de la recette
 * rapprochée, mois, devise). Elle est répartie au prorata des POINTS DE RÉSULTATS VÉRIFIÉS × NOTE DE QUALITÉ, jamais
 * selon le montant liquidé ou payé :
 *
 *  - OBJET CONFIRMÉ : constat terrain « constaté » ou « objet non enregistré » VALIDÉ après contrôle qualité par une autre
 *    personne que l'agent ;
 *  - ENRÔLEMENT VALIDE : enrôlement assisté ayant créé le compte (ou dossier « à revoir » déclaré distinct par un
 *    superviseur) ;
 *  - RÉGULARISATION CONFIRMÉE : paiement provoqué par un contrôle de l'agent (ou pénalité issue de son constat), rapproché
 *    au compte public et confirmé par la QUITTANCE DÉFINITIVE — une régularisation = un point, quel que soit son montant.
 *
 * Module d'un point : code de règle de l'obligation régularisée, ou des obligations de l'objet / du contribuable enrôlé
 * (point partagé à parts égales) ; sans obligation, le point attend son rattachement (« non rattaché »).
 * Note de qualité d'un agent sur le mois : résultats confirmés / résultats jugés (constats validés ou rejetés,
 * constats de stationnement confirmés ou rejetés à la vérification, enrôlements distincts ou doublons, points repris) ;
 * sans résultat jugé : note par défaut (1).
 * Quote-part = réserve du module × points pondérés de l'agent / points pondérés du module (unités mineures, troncature ;
 * le reliquat reste dans la réserve). Payable : part des points validés (validation à deux personnes des régularisations,
 * contrôle qualité des constats). Reprise (points fictifs ou frauduleux) : proposée par le contrôle qualité ou
 * l'anti-fraude, décidée par une autre personne de la régie ; les montants déjà calculés sont récupérés sur les
 * quotes-parts suivantes. L'IA et les détecteurs signalent (présomptions), une personne décide. Aucun versement ici :
 * le Trésor verse (paie) ; zéro espèce.
 *
 * Les écrans de la commission de 10 % (stationnement, verticales, validations) restent en place et deviennent des
 * VUES de cette réserve (quote-part par agent, équipe et sous-traitant).
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { ParkingService } from '../parking/service.js';
import type { TerrainService } from '../terrain/service.js';
import type { CommissionService } from './commissions.js';
import type { CommissionValidations } from './validations.js';

/** Points d'un objet confirmé après contrôle qualité — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const POINTS_OBJET_CONFIRME = 1;
/** Points d'un enrôlement valide — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const POINTS_ENROLEMENT_VALIDE = 1;
/** Points d'une régularisation confirmée par quittance définitive — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const POINTS_REGULARISATION_CONFIRMEE = 1;
/** Note de qualité appliquée sans aucun résultat jugé sur le mois — PAR DÉFAUT (neutre), à confirmer. */
export const NOTE_QUALITE_SANS_JUGEMENT = 1;

const { always } = GRANTS;
/** Lecture de la réserve : pilotage, régies, superviseurs, Trésor (paie), audit, anti-fraude. */
definePolicy('reserve:read', { R01: always, R02: always, R05: always, R06: always, R07: always, R09: always, R11: always, R17: always, R22: always, R23: always, R24: always });
/** Reprise de points : proposée par le contrôle qualité ou l'anti-fraude, décidée par une autre personne de la régie. */
definePolicy('reserve:clawback.propose', { R09: always, R11: always, R22: always, R24: always });
definePolicy('reserve:clawback.decide', { R06: always, R07: always });

export type PointKind = 'OBJET_CONFIRME' | 'ENROLEMENT_VALIDE' | 'REGULARISATION_CONFIRMEE';
export const POINT_LABEL: Record<PointKind, string> = {
  OBJET_CONFIRME: 'Objet confirmé après contrôle qualité',
  ENROLEMENT_VALIDE: 'Enrôlement valide',
  REGULARISATION_CONFIRMEE: 'Régularisation confirmée par quittance définitive',
};
const WEIGHT: Record<PointKind, number> = { OBJET_CONFIRME: POINTS_OBJET_CONFIRME, ENROLEMENT_VALIDE: POINTS_ENROLEMENT_VALIDE, REGULARISATION_CONFIRMEE: POINTS_REGULARISATION_CONFIRMEE };

export type PointStatus = 'VERIFIE' | 'EN_ATTENTE' | 'REPRIS';
export type PointValidation = 'VALIDE' | 'A_VALIDER' | 'DEMANDEE' | 'REFUSEE';

export interface ResultPoint {
  key: string;
  kind: PointKind;
  kindLabel: string;
  agentId: string;
  subcontractorId: string | null;
  team: string;
  /** Mois de Kinshasa du résultat vérifié (AAAA-MM). */
  month: string;
  at: string;
  /** Modules (codes de règle) auxquels le point est rattaché ; vide : non rattaché. */
  modules: string[];
  points: number;
  reference: string;
  status: PointStatus;
  statusReason?: string;
  validation: PointValidation;
  /** Présomption (doublon, objet présumé fictif) : à contre-visiter, jamais une reprise automatique. */
  suspicion?: string;
  clawbackId?: string;
}

export interface PointClawback {
  id: string;
  pointKeys: string[];
  agentId: string;
  grounds: 'POINT_FICTIF' | 'POINT_FRAUDULEUX';
  motif: string;
  evidenceSha256: string[];
  proposedBy: string;
  proposedAt: string;
  status: 'PROPOSEE' | 'DECIDEE' | 'REJETEE';
  decision?: { by: string; at: string; approve: boolean; motif: string };
  /** Quotes-parts déjà calculées pour ces points au moment de la décision : à récupérer sur les quotes-parts suivantes. */
  toRecover?: MoneyJSON[];
  month?: string;
}

interface ReserveSource {
  reservePerModule(filter: { period?: string; currency?: string }): { mode: 'CALCUL' | 'SIMULATION'; pct: string | null; rows: { module: string; period: string; currency: CurrencyCode; base: MoneyJSON; reserve: MoneyJSON }[] };
}
interface CanauxLike { enrolment: { enrolments: { all(): { id: string; agentId: string; status: string; taxpayerId?: string; receivedAt: string; commune: string; review?: { decision: string; at: string } }[] } } }

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = (iso: string) => kinshasaDate(new Date(iso)).slice(0, 7);
const SCALE = 10_000n; // note de qualité en dix-millièmes ; points en millièmes
const addTo = (m: Map<CurrencyCode, Money>, v: Money) => m.set(v.currency, (m.get(v.currency) ?? Money.zero(v.currency)).add(v));
const toList = (m: Map<CurrencyCode, Money>): MoneyJSON[] => [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((x) => x.toJSON());

export class AgentReserveService {
  readonly clawbacks = new InMemoryRepository<PointClawback>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly commissions: CommissionService, private readonly validations: CommissionValidations) {}

  private obligationRules(filter: (o: { objectId: string; taxpayerId: string }) => boolean): string[] {
    return [...new Set(this.ctx.assessment.obligations.all().filter((o) => filter(o) && o.status !== 'ANNULEE').map((o) => o.ruleCode))].sort();
  }

  private teamOf(agentId: string, subcontractorId: string | null): string {
    if (subcontractorId) return `ST:${subcontractorId}`;
    return `REGIE:${this.ctx.users.get(agentId)?.entity ?? 'INCONNUE'}`;
  }

  private teamLabel(team: string): string {
    if (team.startsWith('ST:')) {
      const te = this.ctx.ext.terrain as TerrainService | undefined;
      const id = team.slice(3);
      return `Sous-traitant ${te?.subcontractors.get(id)?.name ?? id}`;
    }
    return `Équipe de la régie ${team.slice(6)}`;
  }

  /** Tous les points de résultats (vérifiés, en attente, repris), tous agents, tous mois. */
  points(): ResultPoint[] {
    const out: ResultPoint[] = [];
    const reclaimed = new Map<string, string>();
    for (const c of this.clawbacks.find((x) => x.status === 'DECIDEE')) for (const k of c.pointKeys) reclaimed.set(k, c.id);
    const te = this.ctx.ext.terrain as TerrainService | undefined;
    // Reprises décidées par le contrôle qualité terrain (objets fictifs, constats frauduleux) : points repris aussi.
    const qcReclaimed = new Set((te?.qualite?.clawbacks.all() ?? []).filter((c) => c.status === 'DECIDEE' || c.status === 'ORDONNEE').flatMap((c) => c.findingIds));
    const suspected = new Map<string, string>();
    for (const s of te?.qualite?.suspicions() ?? []) for (const f of s.findingIds) if (!suspected.has(`OBJ:${f}`)) suspected.set(`OBJ:${f}`, s.label);

    // 1. Objets confirmés après contrôle qualité.
    for (const f of te?.findings.all() ?? []) {
      if (f.status !== 'VALIDE' || !f.review || (f.outcome !== 'CONSTATE' && f.outcome !== 'OBJET_NON_ENREGISTRE')) continue;
      const key = `OBJ:${f.id}`;
      const selfReviewed = f.review.by === f.agentId;
      const claw = reclaimed.get(key) ?? (qcReclaimed.has(f.id) ? 'CONTROLE_QUALITE' : undefined);
      out.push({
        key, kind: 'OBJET_CONFIRME', kindLabel: POINT_LABEL.OBJET_CONFIRME, agentId: f.agentId, subcontractorId: f.subcontractorId ?? null,
        team: this.teamOf(f.agentId, f.subcontractorId ?? null), month: month(f.review.at), at: f.review.at,
        modules: f.objectId ? this.obligationRules((o) => o.objectId === f.objectId) : [], points: WEIGHT.OBJET_CONFIRME,
        reference: `Constat ${f.id}${f.objectId ? ` · objet ${f.objectId}` : ''}`,
        status: claw ? 'REPRIS' : selfReviewed ? 'EN_ATTENTE' : 'VERIFIE',
        ...(claw ? { statusReason: claw === 'CONTROLE_QUALITE' ? 'Repris par décision du contrôle qualité terrain' : `Repris (${claw})`, clawbackId: claw } : selfReviewed ? { statusReason: 'Auto-validation : aucun point' } : {}),
        validation: 'VALIDE', ...(suspected.has(key) ? { suspicion: suspected.get(key)! } : {}),
      });
    }

    // 2. Enrôlements valides.
    const cx = this.ctx.ext.canaux as CanauxLike | undefined;
    for (const e of cx?.enrolment.enrolments.all() ?? []) {
      if (e.status === 'DOUBLON_CONFIRME' || !e.taxpayerId) continue;
      const key = `ENR:${e.id}`;
      const valid = e.status === 'CREE' || e.review?.decision === 'DISTINCT';
      const at = e.review?.at ?? e.receivedAt;
      const claw = reclaimed.get(key);
      out.push({
        key, kind: 'ENROLEMENT_VALIDE', kindLabel: POINT_LABEL.ENROLEMENT_VALIDE, agentId: e.agentId, subcontractorId: null, team: this.teamOf(e.agentId, null),
        month: month(at), at, modules: this.obligationRules((o) => o.taxpayerId === e.taxpayerId), points: WEIGHT.ENROLEMENT_VALIDE,
        reference: `Enrôlement ${e.id} · ${e.commune}`, status: claw ? 'REPRIS' : valid ? 'VERIFIE' : 'EN_ATTENTE',
        ...(claw ? { statusReason: `Repris (${claw})`, clawbackId: claw } : valid ? {} : { statusReason: 'Doublon possible : décision du superviseur attendue' }),
        validation: valid ? 'VALIDE' : 'A_VALIDER',
      });
    }

    // 3. Régularisations confirmées par quittance définitive (paiements provoqués, pénalités des constats).
    for (const l of this.commissions.lines()) {
      if (!l.orderId || l.state === 'ANNULEE' || l.state === 'EN_ATTENTE') continue;
      const key = `${l.source}:${l.orderId}`;
      const order = this.ctx.payments.orders.get(l.orderId);
      const receipt = this.ctx.receipts.byPaymentOrder(l.orderId);
      const final = l.state === 'ACQUISE' && receipt?.status === 'DEFINITIVE';
      const at = order?.reconciledAt ?? l.paidAt ?? l.at;
      const st = this.validations.stateOf(key);
      const claw = reclaimed.get(key);
      const ob = this.ctx.assessment.obligations.get(l.obligationId);
      out.push({
        key, kind: 'REGULARISATION_CONFIRMEE', kindLabel: POINT_LABEL.REGULARISATION_CONFIRMEE, agentId: l.agentId, subcontractorId: null, team: this.teamOf(l.agentId, null),
        month: month(at), at, modules: ob ? [ob.ruleCode] : [], points: WEIGHT.REGULARISATION_CONFIRMEE,
        reference: `${l.moduleLabel} · ${l.reference}`, status: claw ? 'REPRIS' : final ? 'VERIFIE' : 'EN_ATTENTE',
        ...(claw ? { statusReason: `Repris (${claw})`, clawbackId: claw } : final ? {} : { statusReason: 'Quittance définitive attendue (rapprochement au compte public)' }),
        validation: st === 'VALIDEE' ? 'VALIDE' : st === 'DEMANDEE' ? 'DEMANDEE' : st === 'REFUSEE' ? 'REFUSEE' : 'A_VALIDER',
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Note de qualité par agent sur un mois (dix-millièmes) : confirmés / jugés ; défaut sans jugement. */
  quality(monthKey: string, points: ResultPoint[]): Map<string, { q: bigint; confirmed: number; judged: number; byDefault: boolean }> {
    const acc = new Map<string, { ok: number; ko: number }>();
    const hit = (agentId: string, ok: boolean) => { const a = acc.get(agentId) ?? { ok: 0, ko: 0 }; if (ok) a.ok += 1; else a.ko += 1; acc.set(agentId, a); };
    const te = this.ctx.ext.terrain as TerrainService | undefined;
    for (const f of te?.findings.all() ?? []) if (f.review && month(f.review.at) === monthKey && f.review.by !== f.agentId) hit(f.agentId, f.review.decision === 'VALIDE');
    const pk = this.ctx.ext.parking as ParkingService | undefined;
    for (const v of pk?.violations.all() ?? []) if (v.verification && month(v.verification.at) === monthKey) hit(v.agentId, v.verification.outcome === 'CONFIRME');
    const cx = this.ctx.ext.canaux as CanauxLike | undefined;
    for (const e of cx?.enrolment.enrolments.all() ?? []) {
      const at = e.review?.at ?? e.receivedAt;
      if (month(at) !== monthKey) continue;
      if (e.status === 'CREE' || e.review?.decision === 'DISTINCT') hit(e.agentId, true);
      else if (e.status === 'DOUBLON_CONFIRME') hit(e.agentId, false);
    }
    for (const p of points) if (p.month === monthKey && p.status === 'REPRIS') hit(p.agentId, false);
    const out = new Map<string, { q: bigint; confirmed: number; judged: number; byDefault: boolean }>();
    const agents = new Set([...acc.keys(), ...points.filter((p) => p.month === monthKey).map((p) => p.agentId)]);
    for (const a of agents) {
      const s = acc.get(a) ?? { ok: 0, ko: 0 };
      const judged = s.ok + s.ko;
      out.set(a, judged ? { q: (BigInt(s.ok) * SCALE) / BigInt(judged), confirmed: s.ok, judged, byDefault: false } : { q: BigInt(Math.round(NOTE_QUALITE_SANS_JUGEMENT * 10_000)), confirmed: 0, judged: 0, byDefault: true });
    }
    return out;
  }

  /**
   * Répartition de la réserve d'un mois : par module, par agent, par équipe et par sous-traitant ; reprises et montants
   * à récupérer. Aucune écriture, aucun versement : un calcul.
   */
  compute(monthKey: string, scope?: { agentId?: string; subcontractorId?: string }) {
    if (!MONTH_RE.test(monthKey)) throw badRequest('INVALID_PERIOD', 'Mois attendu : AAAA-MM.');
    const all = this.points();
    const pts = all.filter((p) => p.month === monthKey);
    const quality = this.quality(monthKey, all);
    const rep = this.ctx.ext.repartition as ReserveSource | undefined;
    const reserve = rep ? rep.reservePerModule({ period: monthKey }) : null;
    // Points pondérés (millièmes de point × dix-millièmes de note) par module et par agent ; points validés à part.
    type Cell = { weighted: bigint; validated: bigint; points: number; byKind: Record<PointKind, number> };
    const perModule = new Map<string, Map<string, Cell>>();
    const unattached: ResultPoint[] = [];
    for (const p of pts) {
      if (p.status !== 'VERIFIE') continue;
      if (!p.modules.length) { unattached.push(p); continue; }
      const q = quality.get(p.agentId)?.q ?? SCALE;
      const milli = BigInt(Math.round(p.points * 1000)) / BigInt(p.modules.length);
      for (const m of p.modules) {
        const byAgent = perModule.get(m) ?? new Map<string, Cell>();
        const c = byAgent.get(p.agentId) ?? { weighted: 0n, validated: 0n, points: 0, byKind: { OBJET_CONFIRME: 0, ENROLEMENT_VALIDE: 0, REGULARISATION_CONFIRMEE: 0 } };
        c.weighted += milli * q;
        if (p.validation === 'VALIDE') c.validated += milli * q;
        c.points += p.points / p.modules.length;
        c.byKind[p.kind] += p.points / p.modules.length;
        byAgent.set(p.agentId, c);
        perModule.set(m, byAgent);
      }
    }
    const agents = new Map<string, { share: Map<CurrencyCode, Money>; payable: Map<CurrencyCode, Money>; points: number; weighted: bigint; byKind: Record<PointKind, number>; modules: Set<string> }>();
    const agentAcc = (a: string) => {
      let x = agents.get(a);
      if (!x) agents.set(a, (x = { share: new Map(), payable: new Map(), points: 0, weighted: 0n, byKind: { OBJET_CONFIRME: 0, ENROLEMENT_VALIDE: 0, REGULARISATION_CONFIRMEE: 0 }, modules: new Set() }));
      return x;
    };
    const moduleRows: {
      module: string; currency: CurrencyCode | null; reserve: MoneyJSON | null; base: MoneyJSON | null; weightedPoints: number; points: number; distributed: MoneyJSON | null; undistributed: MoneyJSON | null;
      status: 'REPARTIE' | 'SANS_POINTS' | 'SANS_RESERVE' | 'NON_CALCULEE';
      holders: { agentId: string; name: string; team: string; points: number; weightedPoints: number; sharePct: string | null; share: MoneyJSON | null; payable: MoneyJSON | null }[];
    }[] = [];
    const modules = new Set<string>([...perModule.keys(), ...(reserve?.rows.map((r) => r.module) ?? [])]);
    for (const m of [...modules].sort()) {
      const byAgent = perModule.get(m) ?? new Map<string, Cell>();
      const total = [...byAgent.values()].reduce((a, c) => a + c.weighted, 0n);
      const totalPoints = [...byAgent.values()].reduce((a, c) => a + c.points, 0);
      for (const [a, c] of byAgent) { const x = agentAcc(a); x.points += c.points; x.weighted += c.weighted; x.modules.add(m); for (const k of Object.keys(c.byKind) as PointKind[]) x.byKind[k] += c.byKind[k]; }
      const rows = reserve?.rows.filter((r) => r.module === m) ?? [];
      const holdersBase = [...byAgent.entries()].sort((x, y) => (y[1].weighted > x[1].weighted ? 1 : y[1].weighted < x[1].weighted ? -1 : x[0].localeCompare(y[0])));
      const pctOf = (w: bigint) => (total > 0n ? `${(w * 1000n) / total / 10n}.${((w * 1000n) / total) % 10n}` : null);
      if (!rows.length) {
        moduleRows.push({
          module: m, currency: null, reserve: null, base: null, weightedPoints: Number(total) / 1e7, points: totalPoints, distributed: null, undistributed: null,
          status: reserve ? 'SANS_RESERVE' : 'NON_CALCULEE',
          holders: holdersBase.map(([a, c]) => ({ agentId: a, name: this.ctx.users.get(a)?.name ?? a, team: this.teamLabel(this.teamOfAgent(a, pts)), points: c.points, weightedPoints: Number(c.weighted) / 1e7, sharePct: pctOf(c.weighted), share: null, payable: null })),
        });
        continue;
      }
      for (const r of rows) {
        const R = Money.fromJSON(r.reserve);
        let distributed = Money.zero(r.currency);
        const holders = holdersBase.map(([a, c]) => {
          const share = total > 0n ? Money.fromMinor((R.minor * c.weighted) / total, r.currency) : Money.zero(r.currency);
          const payable = c.weighted > 0n ? Money.fromMinor((share.minor * c.validated) / c.weighted, r.currency) : Money.zero(r.currency);
          distributed = distributed.add(share);
          const x = agentAcc(a);
          addTo(x.share, share);
          addTo(x.payable, payable);
          return { agentId: a, name: this.ctx.users.get(a)?.name ?? a, team: this.teamLabel(this.teamOfAgent(a, pts)), points: c.points, weightedPoints: Number(c.weighted) / 1e7, sharePct: pctOf(c.weighted), share: share.toJSON(), payable: payable.toJSON() };
        });
        moduleRows.push({
          module: m, currency: r.currency, reserve: r.reserve, base: r.base, weightedPoints: Number(total) / 1e7, points: totalPoints,
          distributed: distributed.toJSON(), undistributed: R.subtract(distributed).toJSON(), status: total > 0n ? 'REPARTIE' : 'SANS_POINTS', holders,
        });
      }
    }
    // Reprises décidées : montants à récupérer sur les quotes-parts payables de l'agent.
    const recover = new Map<string, Map<CurrencyCode, Money>>();
    for (const c of this.clawbacks.find((x) => x.status === 'DECIDEE')) {
      const m = recover.get(c.agentId) ?? new Map<CurrencyCode, Money>();
      for (const v of c.toRecover ?? []) addTo(m, Money.fromJSON(v));
      recover.set(c.agentId, m);
    }
    const agentRows = [...agents.entries()].map(([a, x]) => {
      const q = quality.get(a);
      const team = this.teamOfAgent(a, pts);
      const toRecover = recover.get(a) ?? new Map<CurrencyCode, Money>();
      const net = new Map(x.payable);
      for (const [cur, v] of toRecover) net.set(cur, (net.get(cur) ?? Money.zero(cur)).subtract(v));
      return {
        agentId: a, name: this.ctx.users.get(a)?.name ?? a, team, teamLabel: this.teamLabel(team), subcontractorId: team.startsWith('ST:') ? team.slice(3) : null,
        points: Math.round(x.points * 1000) / 1000, byKind: x.byKind, weightedPoints: Number(x.weighted) / 1e7,
        quality: q ? { score: Number(q.q) / 10_000, confirmed: q.confirmed, judged: q.judged, byDefault: q.byDefault } : { score: NOTE_QUALITE_SANS_JUGEMENT, confirmed: 0, judged: 0, byDefault: true },
        modules: [...x.modules].sort(), share: toList(x.share), payable: toList(x.payable), toRecover: toList(toRecover), netPayable: toList(net),
      };
    }).filter((r) => (!scope?.agentId || r.agentId === scope.agentId) && (!scope?.subcontractorId || r.subcontractorId === scope.subcontractorId))
      .sort((x, y) => y.weightedPoints - x.weightedPoints || x.name.localeCompare(y.name, 'fr'));
    const group = (keyOf: (r: (typeof agentRows)[number]) => string | null, labelOf: (k: string) => string) => {
      const g = new Map<string, { key: string; label: string; agents: number; points: number; share: Map<CurrencyCode, Money>; payable: Map<CurrencyCode, Money> }>();
      for (const r of agentRows) {
        const k = keyOf(r);
        if (!k) continue;
        const e = g.get(k) ?? { key: k, label: labelOf(k), agents: 0, points: 0, share: new Map(), payable: new Map() };
        e.agents += 1; e.points += r.points;
        for (const s of r.share) addTo(e.share, Money.fromJSON(s));
        for (const s of r.payable) addTo(e.payable, Money.fromJSON(s));
        g.set(k, e);
      }
      return [...g.values()].map((e) => ({ key: e.key, label: e.label, agents: e.agents, points: Math.round(e.points * 1000) / 1000, share: toList(e.share), payable: toList(e.payable) })).sort((a, b) => b.points - a.points);
    };
    const visiblePoints = pts.filter((p) => (!scope?.agentId || p.agentId === scope.agentId) && (!scope?.subcontractorId || p.subcontractorId === scope.subcontractorId));
    return {
      period: monthKey, generatedAt: this.ctx.clock.now().toISOString(),
      mode: reserve?.mode ?? null,
      notice: !reserve
        ? 'Réserve non calculée : module de répartition des recettes (§ 37A) non chargé — points et notes seulement.'
        : reserve.mode === 'SIMULATION'
          ? 'Simulation : clé du § 37A non active (acte requis) — quotes-parts indicatives, aucun versement.'
          : 'Calcul sur recettes rapprochées ; quotes-parts versées par le Trésor (paie), jamais d’espèces.',
      reservePct: reserve?.pct ?? null,
      weights: { objetConfirme: POINTS_OBJET_CONFIRME, enrolementValide: POINTS_ENROLEMENT_VALIDE, regularisationConfirmee: POINTS_REGULARISATION_CONFIRMEE, noteSansJugement: NOTE_QUALITE_SANS_JUGEMENT, status: 'par défaut — à confirmer par le maître d’ouvrage' },
      modules: scope ? moduleRows.map((m) => ({ ...m, holders: m.holders.filter((h) => agentRows.some((r) => r.agentId === h.agentId)) })).filter((m) => m.holders.length) : moduleRows,
      agents: agentRows,
      teams: group((r) => r.team, (k) => this.teamLabel(k)),
      subcontractors: group((r) => r.subcontractorId, (k) => this.teamLabel(`ST:${k}`)),
      points: {
        verified: visiblePoints.filter((p) => p.status === 'VERIFIE').length, pending: visiblePoints.filter((p) => p.status === 'EN_ATTENTE').length,
        reclaimed: visiblePoints.filter((p) => p.status === 'REPRIS').length, suspected: visiblePoints.filter((p) => !!p.suspicion && p.status !== 'REPRIS').length,
        unattached: unattached.filter((p) => visiblePoints.includes(p)).length,
      },
      items: visiblePoints,
      clawbacks: this.clawbacks.all().filter((c) => !scope?.agentId || c.agentId === scope.agentId).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      rules: [
        'Réserve de 10 % par module (§ 37A.5) : répartie au prorata des points de résultats vérifiés × note de qualité — jamais selon le montant liquidé ou payé.',
        `Points : objet confirmé après contrôle qualité (${POINTS_OBJET_CONFIRME}), enrôlement valide (${POINTS_ENROLEMENT_VALIDE}), régularisation confirmée par quittance définitive (${POINTS_REGULARISATION_CONFIRMEE}) — valeurs par défaut, à confirmer par le maître d’ouvrage.`,
        'Note de qualité du mois : résultats confirmés / résultats jugés (constats validés ou rejetés, vérifications de stationnement, enrôlements distincts ou doublons, points repris).',
        'Payable : quote-part des points validés (validation à deux personnes des régularisations ; constats validés par le contrôle qualité). Versée par le Trésor (paie) ; aucun agent ne reçoit d’argent de l’usager.',
        'Points fictifs ou frauduleux : reprise proposée par le contrôle qualité ou l’anti-fraude, décidée par une autre personne de la régie ; les montants déjà calculés sont récupérés sur les quotes-parts suivantes. Les détecteurs signalent, une personne décide.',
      ],
      cashHandled: false,
    };
  }

  private teamOfAgent(agentId: string, pts: ResultPoint[]): string {
    return pts.find((p) => p.agentId === agentId && p.subcontractorId)?.team ?? this.teamOf(agentId, null);
  }

  view(user: User, monthKey?: string) {
    authorize(user, 'reserve:read');
    const m = monthKey ?? kinshasaDate(this.ctx.clock.now()).slice(0, 7);
    const out = this.compute(m);
    this.ctx.audit.append({ actor: actorOf(user), action: 'agents.reserve.viewed', resourceType: 'agents_reserve', resourceId: m, details: { agents: out.agents.length } });
    return out;
  }

  /** Vue de l'agent : ses seuls points, sa note et sa quote-part (écran de la commission harmonisé). */
  mine(user: User, monthKey?: string) {
    const m = monthKey ?? kinshasaDate(this.ctx.clock.now()).slice(0, 7);
    return this.compute(m, { agentId: user.id });
  }

  /** Vue d'une structure sous-traitante (ses agents seulement). */
  forSubcontractor(subcontractorId: string, monthKey?: string) {
    const m = monthKey ?? kinshasaDate(this.ctx.clock.now()).slice(0, 7);
    return this.compute(m, { subcontractorId });
  }

  proposeClawback(user: User, input: { pointKeys: string[]; grounds: PointClawback['grounds']; motif: string; evidenceSha256: string[] }): PointClawback {
    authorize(user, 'reserve:clawback.propose');
    const all = this.points();
    const selected = input.pointKeys.map((k) => all.find((p) => p.key === k));
    const missing = input.pointKeys.filter((_, i) => !selected[i]);
    if (missing.length) throw notFound('POINT_INCONNU', `Points inconnus : ${missing.join(', ')}.`);
    const agents = new Set(selected.map((p) => p!.agentId));
    if (agents.size !== 1) throw unprocessable('UN_AGENT_PAR_REPRISE', 'Une reprise porte sur les points d’un seul agent.');
    if (selected.some((p) => p!.status === 'REPRIS')) throw conflict('POINT_DEJA_REPRIS', 'Un des points est déjà repris.');
    const open = new Set(this.clawbacks.find((c) => c.status === 'PROPOSEE').flatMap((c) => c.pointKeys));
    if (input.pointKeys.some((k) => open.has(k))) throw conflict('REPRISE_EN_COURS', 'Une reprise est déjà proposée pour un de ces points.');
    const agentId = [...agents][0]!;
    assertDistinctPerson(user.id, [agentId], 'Séparation des pouvoirs : un agent ne propose pas la reprise de ses propres points.');
    const c = this.clawbacks.insert({
      id: this.ids.next('RPT'), pointKeys: [...new Set(input.pointKeys)], agentId, grounds: input.grounds, motif: input.motif, evidenceSha256: input.evidenceSha256,
      proposedBy: user.id, proposedAt: this.ctx.clock.now().toISOString(), status: 'PROPOSEE', month: selected[0]!.month,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'agents.reserve.clawback_proposed', resourceType: 'agents_reserve', resourceId: c.id, details: { agentId, pointKeys: c.pointKeys, grounds: c.grounds, evidence: c.evidenceSha256.length } });
    return c;
  }

  decideClawback(user: User, id: string, input: { approve: boolean; motif: string }): PointClawback {
    authorize(user, 'reserve:clawback.decide');
    const c = this.clawbacks.get(id);
    if (!c) throw notFound('REPRISE_INCONNUE', `Reprise inconnue : ${id}`);
    if (c.status !== 'PROPOSEE') throw conflict('REPRISE_DEJA_DECIDEE', `Reprise ${id} déjà ${c.status}.`);
    assertDistinctPerson(user.id, [c.proposedBy, c.agentId], 'Deux personnes : la reprise est décidée par une personne distincte de celle qui l’a proposée et de l’agent concerné.');
    const at = this.ctx.clock.now().toISOString();
    const decision = { by: user.id, at, approve: input.approve, motif: input.motif };
    let toRecover: MoneyJSON[] = [];
    let out: PointClawback;
    if (input.approve) {
      // Mois CLOS (quotes-parts réputées versées par le Trésor) : quote-part payable avant la reprise − après la reprise,
      // à récupérer sur les quotes-parts suivantes. Mois en cours : le calcul exclut déjà les points repris.
      const current = kinshasaDate(this.ctx.clock.now()).slice(0, 7);
      const months = [...new Set(this.points().filter((p) => c.pointKeys.includes(p.key)).map((p) => p.month))].filter((m) => m < current);
      const before = new Map(months.map((m) => [m, this.compute(m, { agentId: c.agentId }).agents[0]?.payable ?? []]));
      out = this.clawbacks.update({ ...c, status: 'DECIDEE', decision });
      const acc = new Map<CurrencyCode, Money>();
      for (const m of months) {
        const after = this.compute(m, { agentId: c.agentId }).agents[0]?.payable ?? [];
        for (const b of before.get(m) ?? []) {
          const a = after.find((x) => x.currency === b.currency);
          const diff = Money.fromJSON(b).subtract(a ? Money.fromJSON(a) : Money.zero(b.currency));
          if (!diff.isNegative() && !diff.isZero()) addTo(acc, diff);
        }
      }
      toRecover = toList(acc);
      out = this.clawbacks.update({ ...out, toRecover });
    } else {
      out = this.clawbacks.update({ ...c, status: 'REJETEE', decision });
    }
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'agents.reserve.clawback_decided' : 'agents.reserve.clawback_rejected', resourceType: 'agents_reserve', resourceId: id, details: { agentId: c.agentId, proposedBy: c.proposedBy, motif: input.motif, toRecover } });
    if (input.approve) {
      this.ctx.alerts.raise({ type: 'RESERVE_POINTS_REPRIS', severity: 'MEDIUM', source: 'sanctions:reserve', detail: `Reprise ${id} : ${c.pointKeys.length} point(s) de ${c.agentId} repris (${c.grounds === 'POINT_FICTIF' ? 'point fictif' : 'point frauduleux'}).`, context: { clawbackId: id, agentId: c.agentId }, notifyRoles: ['R22', 'R17'] });
    }
    return out;
  }
}
