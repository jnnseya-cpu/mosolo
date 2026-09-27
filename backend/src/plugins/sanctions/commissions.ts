/**
 * Commission des agents — 10 % pour TOUS les agents, quel que soit leur module (décision du maître d'ouvrage du
 * 27/09/2026). Deux recettes seulement :
 *
 * - PÉNALITÉ : pénalité issue du constat de l'agent, vérifiée et décidée par d'autres personnes (stationnement ;
 *   la publicité n'a pas de barème de pénalités publié : ses décisions liquident des DROITS, comptés en paiement généré) ;
 * - PAIEMENT GÉNÉRÉ : paiement effectué après un contrôle de l'agent qui a révélé un défaut, dans le délai du module :
 *   · stationnement : session ouverte pour la plaque dans l'heure qui suit un contrôle rouge ;
 *   · titres et pass wewa (RakaPay) : titre acheté pour la plaque ou le titulaire dans l'heure qui suit un contrôle
 *     non valide ;
 *   · verticales (plaques d'étal, de chantier, de site…) : dette de l'objet, exigible et impayée au scan, payée dans
 *     les 72 h qui suivent un scan ROUGE (situation conservée sur le scan) ;
 *   · publicité : droits du support (autorisation, ou liquidés par la décision du dossier) payés dans les 72 h qui
 *     suivent une inspection non conforme ou « non déclaré » ;
 *   · terrain (missions) : dette de l'objet payée dans les 72 h qui suivent le constat de l'agent.
 *
 * Base : montants effectivement payés, ordre par ordre (échéances) ; chaque ligne a l'état de son ordre. Un contrôle
 * enregistré au serveur APRÈS le paiement ne peut pas se l'attribuer (contrôle hors ligne à heure déclarée).
 * Un même paiement (ordre) n'est attribué qu'UNE fois, au premier contrôle qui l'a précédé (tous modules confondus) ;
 * une pénalité l'est à l'auteur du constat. « Premier » s'entend à l'heure du SERVEUR : l'heure déclarée par un
 * terminal hors ligne ne compte que dans la limite de `DECLARED_TIME_TOLERANCE_MINUTES` avant sa réception. Une
 * attribution ACQUISE (rapprochée) est figée et conservée : une synchronisation tardive ne peut plus la déplacer.
 * Contrôles localisés (stationnement, plaques des verticales) : seule une présence attestée (GPS près du lieu)
 * ouvre droit à commission ; terrain : constat VALIDÉ, avec photo, sur une dette échue et impayée à la capture ;
 * publicité : dossier RETENU seulement. Calcul sur les recettes arrivées au compte public : acquise après
 * rapprochement, versée par le Trésor (paie). Un agent ne reçoit jamais d'argent de l'usager. Les personnes qui
 * vérifient ou décident ne perçoivent rien sur leurs décisions.
 */
import type { AppContext } from '../../context.js';
import type { Obligation } from '../../modules/assessment/service.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import type { ParkingService } from '../parking/service.js';
import { AGENT_COMMISSION_PCT, earningTotals, obligationEarningLines, type EarningLine } from '../parking/field.js';
import { Money } from '@mosolo/shared';
import { kinshasaDate } from '../../core/clock.js';
import { InMemoryRepository } from '../../core/repository.js';
import { ordersByObligation, paidOrders, PAID_STATUSES, sumByCurrency } from '../parking/support.js';
import type { TitresService } from '../titres/service.js';
import type { VerticalesService } from '../verticales/service.js';
import type { PubliciteService } from '../publicite/service.js';
import type { TerrainService } from '../terrain/service.js';

export const ATTRIBUTION_WINDOWS_MINUTES: Record<string, number> = {
  STATIONNEMENT: 60, TITRES: 60, VERTICALES: 72 * 60, PUBLICITE: 72 * 60, TERRAIN: 72 * 60,
};
export const MODULE_LABEL: Record<string, string> = {
  STATIONNEMENT: 'Stationnement', TITRES: 'Titres et pass wewa', VERTICALES: 'Verticales (plaques)', PUBLICITE: 'Publicité', TERRAIN: 'Terrain (missions)',
};

/**
 * Heure déclarée par un terminal (hors ligne) : prise en compte au plus ce délai avant la réception au serveur pour
 * classer les contrôles (« premier contrôle »). Au-delà, c'est l'heure de réception moins ce délai qui compte.
 */
export const DECLARED_TIME_TOLERANCE_MINUTES = 15;

/** Instant de classement d'un contrôle : max(heure déclarée, heure serveur − tolérance). */
export function rankInstant(declared: string, recorded: string | null | undefined): string {
  if (!recorded) return declared;
  const floor = Date.parse(recorded) - DECLARED_TIME_TOLERANCE_MINUTES * 60_000;
  return Date.parse(declared) >= floor ? declared : new Date(floor).toISOString();
}

export type CommissionLine = EarningLine & {
  module: string; moduleLabel: string; obligationId: string; triggerAt: string; agentId: string;
  /** Instant de classement pour « le premier contrôle » (heure serveur, tolérance comprise). */
  rankAt: string;
  /** Attribution figée (commission acquise) : ne peut plus être déplacée. */
  frozen?: boolean;
};

/** Attribution figée d'un paiement (ordre) : conservée dès que sa commission est acquise (rapprochée). */
export interface FrozenAttribution {
  /** Identifiant de l'ordre de paiement. */
  id: string;
  agentId: string;
  module: string;
  obligationId: string;
  frozenAt: string;
  line: CommissionLine;
}

const alnum = (p: string | undefined | null) => (p ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

export class CommissionService {
  /** Attributions figées (ordres dont la commission est acquise) : persistées, jamais recalculées. */
  readonly frozen = new InMemoryRepository<FrozenAttribution>();

  constructor(private readonly ctx: AppContext) {}

  /**
   * Lignes « paiement généré » : ordres payés de l'obligation dans la fenêtre du module qui suit le contrôle, et
   * confirmés APRÈS l'enregistrement du contrôle au serveur (`recordedAt`).
   */
  private generated(orders: Map<string, PaymentOrder[]>, module: string, agentId: string, triggerAt: string, ob: Obligation | undefined, reference: string, plate: string, zone: string, recordedAt = triggerAt): CommissionLine[] {
    if (!ob) return [];
    const t = Date.parse(triggerAt); const rec = Date.parse(recordedAt);
    const win = ATTRIBUTION_WINDOWS_MINUTES[module]! * 60_000;
    const rankAt = rankInstant(triggerAt, recordedAt);
    return obligationEarningLines(this.ctx, ob, orders, { module, moduleLabel: MODULE_LABEL[module]!, obligationId: ob.id, triggerAt, agentId, source: 'PAIEMENT', reference, plate, zone, at: triggerAt }, {
      withBalance: false,
      accept: (o) => { const at = Date.parse(o.at); return at >= t && at - t <= win && rec <= at; },
    }).map((l) => ({ ...l, at: l.paidAt ?? l.at, module, moduleLabel: MODULE_LABEL[module]!, obligationId: ob.id, triggerAt, agentId, rankAt }));
  }

  /** Dette échue et impayée à l'instant `at` : échéance dépassée, émise avant, non soldée par des paiements antérieurs. */
  private dueAndUnpaidAt(ob: Obligation, orders: Map<string, PaymentOrder[]>, at: string): boolean {
    if (ob.status === 'CONTESTEE' || Date.parse(ob.createdAt) > Date.parse(at)) return false;
    if (!(ob.dueDate < kinshasaDate(new Date(at)))) return false;
    const before = paidOrders(this.ctx, ob.id, orders).filter((o) => Date.parse(o.at) < Date.parse(at));
    const paid = before.reduce((m, o) => m.add(Money.fromJSON(o.amount)), Money.zero(ob.amount.currency));
    return paid.compare(Money.fromJSON(ob.amount)) < 0;
  }

  /** Toutes les lignes candidates, tous modules, tous agents (avant attribution unique) — une seule passe, indexée. */
  private candidates(orders: Map<string, PaymentOrder[]>): CommissionLine[] {
    const out: CommissionLine[] = [];
    const add = (ls: CommissionLine[]) => { for (const l of ls) out.push(l); };
    const obligations = this.ctx.assessment.obligations;

    // Stationnement : logique du module (pénalités des constats, sessions dans l'heure d'un contrôle rouge).
    const pk = this.ctx.ext.parking as ParkingService | undefined;
    if (pk) {
      for (const l of pk.field.allEarningsLines(orders)) {
        // Heure du contrôle ou du constat : heure du serveur.
        if (l.obligationId && l.triggerAt && l.agentId) out.push({ ...l, module: 'STATIONNEMENT', moduleLabel: MODULE_LABEL.STATIONNEMENT!, obligationId: l.obligationId, triggerAt: l.triggerAt, agentId: l.agentId, rankAt: l.triggerAt });
      }
    }

    // Titres et pass wewa : titre acheté dans l'heure qui suit un contrôle non valide (même plaque ou même titulaire).
    const ti = this.ctx.ext.titres as TitresService | undefined;
    if (ti) {
      type Cred = ReturnType<TitresService['credentials']['all']>[number];
      const byPlate = new Map<string, Cred[]>(); const byHolder = new Map<string, Cred[]>();
      for (const c of ti.credentials.all()) {
        if (!c.obligationId) continue;
        if (c.subject.plate) push(byPlate, alnum(c.subject.plate), c);
        if (c.holderTaxpayerId) push(byHolder, c.holderTaxpayerId, c);
      }
      for (const ev of ti.controls.all()) {
        if (ev.result === 'VALIDE' || !ev.controllerId) continue;
        const controlled = ev.credentialId ? ti.credentials.get(ev.credentialId) : undefined;
        const plate = alnum(ev.method === 'PLAQUE' ? ev.presented : controlled?.subject.plate);
        const holder = controlled?.holderTaxpayerId;
        if (!plate && !holder) continue;
        const creds = new Set([...(plate ? byPlate.get(plate) ?? [] : []), ...(holder ? byHolder.get(holder) ?? [] : [])]);
        for (const c of creds) {
          if (c.id === ev.credentialId || Date.parse(c.issuedAt) < Date.parse(ev.at)) continue;
          // Heure déclarée par l'appareil (hors ligne) : l'enregistrement au serveur doit précéder le paiement.
          add(this.generated(orders, 'TITRES', ev.controllerId, ev.at, obligations.get(c.obligationId!), c.number, c.subject.plate ?? '', c.place?.label ?? '', ev.recordedAt ?? ev.at));
        }
      }
    }

    // Verticales : seul un scan ROUGE a révélé un défaut ; seules les obligations ÉCHUES et impayées AU SCAN comptent ;
    // le scan doit attester la présence de l'agent près de l'objet (GPS).
    const vx = this.ctx.ext.verticales as VerticalesService | undefined;
    if (vx) {
      for (const sc of vx.scans.all()) {
        if (sc.situation !== 'red' || !sc.dueObligationIds?.length || sc.presenceVerified !== true) continue;
        const p = vx.plates.get(sc.plateCode);
        if (!p) continue;
        for (const id of sc.dueObligationIds) add(this.generated(orders, 'VERTICALES', sc.by, sc.at, obligations.get(id), `Scan ${p.code} · ${id}`, '', p.commune));
      }
    }
    // Terrain : constat VALIDÉ par la régie, avec photo ; dette de l'objet ÉCHUE et impayée à la capture, payée dans les
    // 72 h qui suivent (obligations indexées par objet).
    const te = this.ctx.ext.terrain as TerrainService | undefined;
    if (te) {
      const byObject = new Map<string, Obligation[]>();
      for (const o of obligations.all()) push(byObject, o.objectId, o);
      for (const f of te.findings.all()) {
        if (!f.objectId || !(f.outcome === 'CONSTATE' || f.outcome === 'OBJET_NON_ENREGISTRE')) continue;
        if (f.status !== 'VALIDE' || !f.photoSha256) continue;
        for (const ob of byObject.get(f.objectId) ?? []) {
          if (!this.dueAndUnpaidAt(ob, orders, f.capturedAt)) continue;
          add(this.generated(orders, 'TERRAIN', f.agentId, f.capturedAt, ob, `Constat terrain ${f.id} · ${ob.id}`, '', f.commune, f.receivedAt));
        }
      }
    }

    // Publicité : droits du support payés après une inspection non conforme ou « non déclaré » — droits de
    // l'autorisation en cours, ou droits liquidés par la décision du dossier ouvert par CETTE inspection (ce ne sont
    // pas des pénalités : aucun barème de pénalités n'est publié).
    const pub = this.ctx.ext.publicite as PubliciteService | undefined;
    if (pub) {
      for (const insp of pub.inspections.all()) {
        if (insp.finding === 'CONFORME') continue;
        const d = pub.devices.get(insp.deviceId);
        if (!d) continue;
        // Seul un dossier RETENU (vérifié puis décidé par deux autres personnes) fonde une commission : jamais un constat
        // écarté à la vérification (REJETE_QA), classé, ou encore en cours.
        const kase = insp.caseId ? pub.cases.get(insp.caseId) : undefined;
        if (kase?.status !== 'RETENU') continue;
        const ids = new Set<string>();
        const authOb = pub.currentAuthorization(d)?.liquidation?.obligationId;
        if (authOb) ids.add(authOb);
        if (kase.decision?.obligationId) ids.add(kase.decision.obligationId);
        for (const id of ids) add(this.generated(orders, 'PUBLICITE', insp.inspectorId, insp.observedAt, obligations.get(id), `${insp.reference} · ${d.reference}`, d.vehiclePlate ?? '', kase?.commune ?? d.commune));
      }
    }
    return out;
  }

  /**
   * Attribution unique, calculée une fois pour tous les agents : une pénalité à son auteur (le paiement d'une pénalité
   * n'est jamais aussi un « paiement généré ») ; chaque ordre payé au PREMIER contrôle qui l'a précédé, classé à l'heure
   * du serveur (`rankAt`). Une attribution acquise est figée : elle est conservée telle quelle aux calculs suivants.
   */
  private attributed(): CommissionLine[] {
    const orders = ordersByObligation(this.ctx);
    const cands = this.candidates(orders);
    const penalties = new Set(cands.filter((l) => l.source === 'PENALITE').map((l) => l.obligationId));
    const best = new Map<string, CommissionLine>();
    const frozen = new Map(this.frozen.all().map((f) => [f.id, f]));
    for (const l of cands) {
      if (l.source === 'PAIEMENT' && penalties.has(l.obligationId)) continue;
      const key = l.source === 'PENALITE' ? `P:${l.obligationId}:${l.orderId ?? l.state}` : `G:${l.orderId}`;
      const fz = l.source === 'PAIEMENT' && l.orderId ? frozen.get(l.orderId) : undefined;
      // Attribution figée : seule une ligne du même agent et du même module peut la représenter (état à jour).
      if (fz && (fz.agentId !== l.agentId || fz.module !== l.module)) continue;
      const cur = best.get(key);
      if (!cur || l.rankAt < cur.rankAt || (l.rankAt === cur.rankAt && l.triggerAt < cur.triggerAt)) best.set(key, fz ? { ...l, frozen: true } : l);
    }
    // Attributions figées dont le contrôle d'origine n'apparaît plus (resynchronisation, données modifiées) : conservées
    // tant que l'ordre reste payé.
    const paid = new Set<string>(PAID_STATUSES);
    for (const f of frozen.values()) {
      if (best.has(`G:${f.id}`) || penalties.has(f.obligationId)) continue;
      const o = (orders.get(f.obligationId) ?? []).find((x) => x.id === f.id);
      if (o && paid.has(o.status)) best.set(`G:${f.id}`, { ...f.line, frozen: true });
    }
    // Figer les nouvelles attributions acquises (rapprochées au compte public).
    const now = this.ctx.clock.now().toISOString();
    for (const [key, l] of best) {
      if (!key.startsWith('G:') || l.state !== 'ACQUISE' || !l.orderId || frozen.has(l.orderId)) continue;
      this.frozen.insert({ id: l.orderId, agentId: l.agentId, module: l.module, obligationId: l.obligationId, frozenAt: now, line: { ...l, frozen: true } });
      best.set(key, { ...l, frozen: true });
      this.ctx.audit.append({
        actor: { kind: 'system', id: 'commissions' }, action: 'agents.commission.attribution_frozen', resourceType: 'payment_order', resourceId: l.orderId,
        details: { agentId: l.agentId, module: l.module, obligationId: l.obligationId, triggerAt: l.triggerAt, rankAt: l.rankAt },
      });
    }
    return [...best.values()].sort((a, b) => b.at.localeCompare(a.at));
  }

  lines(agentId?: string): CommissionLine[] {
    const all = this.attributed();
    return agentId ? all.filter((l) => l.agentId === agentId) : all;
  }

  /** Lignes de tous les agents, groupées par agent (un seul calcul). */
  byAgent(): Map<string, CommissionLine[]> {
    const m = new Map<string, CommissionLine[]>();
    for (const l of this.attributed()) push(m, l.agentId, l);
    return m;
  }

  summary(agentId: string, lines: CommissionLine[] = this.lines(agentId)) {
    const modules = [...new Set(lines.map((l) => l.module))].map((m) => ({
      module: m, moduleLabel: MODULE_LABEL[m] ?? m, lines: lines.filter((l) => l.module === m).length,
      commission: sumByCurrency(lines.filter((l) => l.module === m && l.state !== 'ANNULEE').map((l) => l.commission)),
    }));
    return {
      agentId, ratePct: AGENT_COMMISSION_PCT,
      totals: earningTotals(lines, this.ctx.clock.now()),
      counts: { penalites: lines.filter((l) => l.source === 'PENALITE').length, paiements: lines.filter((l) => l.source === 'PAIEMENT').length },
      modules, lines,
      windows: Object.entries(ATTRIBUTION_WINDOWS_MINUTES).map(([m, min]) => ({ module: m, moduleLabel: MODULE_LABEL[m], minutes: min })),
      rules: [
        `Commission de ${AGENT_COMMISSION_PCT} % pour tout agent, quel que soit son module : uniquement sur les pénalités issues de vos constats et sur les paiements provoqués par vos contrôles.`,
        'Paiement provoqué : effectué après votre contrôle qui a révélé un défaut — dans l’heure (stationnement, titres, pass wewa) ou dans les 72 h (plaques des verticales, publicité, missions de terrain). Un paiement n’est attribué qu’une fois, au premier contrôle (heure du serveur) ; acquise, l’attribution est figée.',
        'Contrôle ouvrant droit : position GPS attestée près de la zone ou de l’objet (stationnement, plaques) ; dossier retenu (publicité) ; constat validé et photographié sur une dette échue (terrain). Aucun paiement dans les premières minutes suivant l’arrivée du véhicule.',
        'Calculée sur des recettes arrivées au compte public, échéance par échéance ; acquise après rapprochement bancaire ; versée par le Trésor (paie). Vous ne recevez jamais d’argent de l’usager.',
        'Une pénalité n’existe qu’après vérification et décision par d’autres personnes ; annulée sur recours, elle annule la commission.',
        'Taux fixé par décision du maître d’ouvrage : un acte (arrêté) est requis avant tout versement réel.',
      ],
    };
  }

  /** Récapitulatif par agent (régie, pilotage, Trésor) — un seul calcul pour tous les agents. */
  all() {
    return {
      ratePct: AGENT_COMMISSION_PCT,
      items: [...this.byAgent()].map(([a, lines]) => {
        const s = this.summary(a, lines);
        return { agentId: a, agentName: this.ctx.users.get(a)?.name ?? a, totals: s.totals, counts: s.counts, modules: s.modules };
      }).sort((x, y) => x.agentName.localeCompare(y.agentName, 'fr')),
    };
  }
}
