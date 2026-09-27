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
 * une pénalité l'est à l'auteur du constat. Calcul sur les recettes arrivées au compte public : acquise après
 * rapprochement, versée par le Trésor (paie). Un agent ne reçoit jamais d'argent de l'usager. Les personnes qui
 * vérifient ou décident ne perçoivent rien sur leurs décisions.
 */
import type { AppContext } from '../../context.js';
import type { Obligation } from '../../modules/assessment/service.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import type { ParkingService } from '../parking/service.js';
import { AGENT_COMMISSION_PCT, earningTotals, obligationEarningLines, type EarningLine } from '../parking/field.js';
import { ordersByObligation, sumByCurrency } from '../parking/support.js';
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

export type CommissionLine = EarningLine & { module: string; moduleLabel: string; obligationId: string; triggerAt: string; agentId: string };

const alnum = (p: string | undefined | null) => (p ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

export class CommissionService {
  constructor(private readonly ctx: AppContext) {}

  /**
   * Lignes « paiement généré » : ordres payés de l'obligation dans la fenêtre du module qui suit le contrôle, et
   * confirmés APRÈS l'enregistrement du contrôle au serveur (`recordedAt`).
   */
  private generated(orders: Map<string, PaymentOrder[]>, module: string, agentId: string, triggerAt: string, ob: Obligation | undefined, reference: string, plate: string, zone: string, recordedAt = triggerAt): CommissionLine[] {
    if (!ob) return [];
    const t = Date.parse(triggerAt); const rec = Date.parse(recordedAt);
    const win = ATTRIBUTION_WINDOWS_MINUTES[module]! * 60_000;
    return obligationEarningLines(this.ctx, ob, orders, { module, moduleLabel: MODULE_LABEL[module]!, obligationId: ob.id, triggerAt, agentId, source: 'PAIEMENT', reference, plate, zone, at: triggerAt }, {
      withBalance: false,
      accept: (o) => { const at = Date.parse(o.at); return at >= t && at - t <= win && rec <= at; },
    }).map((l) => ({ ...l, at: l.paidAt ?? l.at, module, moduleLabel: MODULE_LABEL[module]!, obligationId: ob.id, triggerAt, agentId }));
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
        if (l.obligationId && l.triggerAt && l.agentId) out.push({ ...l, module: 'STATIONNEMENT', moduleLabel: MODULE_LABEL.STATIONNEMENT!, obligationId: l.obligationId, triggerAt: l.triggerAt, agentId: l.agentId });
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

    // Verticales : seul un scan ROUGE a révélé un défaut ; seules les obligations exigibles et impayées AU SCAN comptent.
    const vx = this.ctx.ext.verticales as VerticalesService | undefined;
    if (vx) {
      for (const sc of vx.scans.all()) {
        if (sc.situation !== 'red' || !sc.dueObligationIds?.length) continue;
        const p = vx.plates.get(sc.plateCode);
        if (!p) continue;
        for (const id of sc.dueObligationIds) add(this.generated(orders, 'VERTICALES', sc.by, sc.at, obligations.get(id), `Scan ${p.code} · ${id}`, '', p.commune));
      }
    }
    // Terrain : dette existante de l'objet payée dans les 72 h qui suivent le constat (obligations indexées par objet).
    const te = this.ctx.ext.terrain as TerrainService | undefined;
    if (te) {
      const byObject = new Map<string, Obligation[]>();
      for (const o of obligations.all()) push(byObject, o.objectId, o);
      for (const f of te.findings.all()) {
        if (!f.objectId || !(f.outcome === 'CONSTATE' || f.outcome === 'OBJET_NON_ENREGISTRE')) continue;
        for (const ob of byObject.get(f.objectId) ?? []) {
          if (Date.parse(ob.createdAt) > Date.parse(f.capturedAt)) continue;
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
        const ids = new Set<string>();
        const authOb = pub.currentAuthorization(d)?.liquidation?.obligationId;
        if (authOb) ids.add(authOb);
        const kase = insp.caseId ? pub.cases.get(insp.caseId) : undefined;
        if (kase?.status === 'RETENU' && kase.decision?.obligationId) ids.add(kase.decision.obligationId);
        for (const id of ids) add(this.generated(orders, 'PUBLICITE', insp.inspectorId, insp.observedAt, obligations.get(id), `${insp.reference} · ${d.reference}`, d.vehiclePlate ?? '', kase?.commune ?? d.commune));
      }
    }
    return out;
  }

  /**
   * Attribution unique, calculée une fois pour tous les agents : une pénalité à son auteur (le paiement d'une pénalité
   * n'est jamais aussi un « paiement généré ») ; chaque ordre payé au PREMIER contrôle qui l'a précédé.
   */
  private attributed(): CommissionLine[] {
    const cands = this.candidates(ordersByObligation(this.ctx));
    const penalties = new Set(cands.filter((l) => l.source === 'PENALITE').map((l) => l.obligationId));
    const best = new Map<string, CommissionLine>();
    for (const l of cands) {
      if (l.source === 'PAIEMENT' && penalties.has(l.obligationId)) continue;
      const key = l.source === 'PENALITE' ? `P:${l.obligationId}:${l.orderId ?? l.state}` : `G:${l.orderId}`;
      const cur = best.get(key);
      if (!cur || l.triggerAt < cur.triggerAt) best.set(key, l);
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
        'Paiement provoqué : effectué après votre contrôle qui a révélé un défaut — dans l’heure (stationnement, titres, pass wewa) ou dans les 72 h (plaques des verticales, publicité, missions de terrain). Un paiement n’est attribué qu’une fois, au premier contrôle.',
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
