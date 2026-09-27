/**
 * Commission des agents — 10 % pour TOUS les agents, quel que soit leur module (décision du maître d'ouvrage du
 * 27/09/2026). Deux recettes seulement :
 *
 * - PÉNALITÉ : pénalité issue du constat de l'agent, vérifiée et décidée par d'autres personnes
 *   (stationnement : constat ; publicité : inspection non conforme retenue) ;
 * - PAIEMENT GÉNÉRÉ : paiement effectué après un contrôle de l'agent qui a révélé un défaut, dans le délai du module :
 *   · stationnement : session ouverte pour la plaque dans l'heure qui suit un contrôle rouge ;
 *   · titres et pass wewa (RakaPay) : titre acheté pour la plaque ou le titulaire dans l'heure qui suit un contrôle
 *     non valide ;
 *   · verticales (plaques d'étal, de chantier, de site…) : dette de l'objet payée dans les 72 h qui suivent le scan ;
 *   · publicité : dette du support payée dans les 72 h qui suivent une inspection non conforme ;
 *   · terrain (missions) : dette de l'objet payée dans les 72 h qui suivent le constat de l'agent.
 *
 * Un même paiement n'est attribué qu'UNE fois, au premier contrôle qui l'a précédé (tous modules confondus) ; une
 * pénalité l'est à l'auteur du constat. Calcul sur les recettes arrivées au compte public : acquise après
 * rapprochement, versée par le Trésor (paie). Un agent ne reçoit jamais d'argent de l'usager. Les personnes qui
 * vérifient ou décident ne perçoivent rien sur leurs décisions.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { ParkingService } from '../parking/service.js';
import { AGENT_COMMISSION_PCT, type EarningLine } from '../parking/field.js';
import { sumByCurrency } from '../parking/support.js';
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
const STATE_LABEL: Record<EarningLine['state'], string> = {
  EN_ATTENTE: 'En attente du paiement de l’usager', CONFIRMEE: 'Payé — rapprochement bancaire en cours', ACQUISE: 'Acquise — à verser par le Trésor', ANNULEE: 'Annulée (pénalité annulée)',
};

export class CommissionService {
  constructor(private readonly ctx: AppContext) {}

  private pct(m: MoneyJSON): MoneyJSON {
    return Money.fromJSON(m).multiply(`${AGENT_COMMISSION_PCT / 100}`).toJSON();
  }

  /** Paiement d'une obligation : instant de confirmation et état de rapprochement (null si impayée). */
  private paid(obligationId: string): { at: string; reconciled: boolean } | null {
    const o = this.ctx.payments.byObligation(obligationId).find((x) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(x.status));
    return o ? { at: o.confirmedAt ?? o.createdAt, reconciled: o.status === 'RAPPROCHE' } : null;
  }

  /** Ligne « paiement généré » si l'obligation a été payée dans la fenêtre qui suit le contrôle. */
  private generated(module: string, agentId: string, triggerAt: string, obligationId: string, reference: string, plate: string, zone: string): CommissionLine | null {
    const ob = this.ctx.assessment.obligations.get(obligationId);
    if (!ob || ob.status === 'ANNULEE') return null;
    const p = this.paid(obligationId);
    if (!p) return null;
    const t = Date.parse(triggerAt); const at = Date.parse(p.at);
    if (at < t || at - t > ATTRIBUTION_WINDOWS_MINUTES[module]! * 60_000) return null;
    const state: EarningLine['state'] = p.reconciled ? 'ACQUISE' : 'CONFIRMEE';
    return { module, moduleLabel: MODULE_LABEL[module]!, obligationId, triggerAt, agentId, source: 'PAIEMENT', reference, plate, zone, at: p.at, base: ob.amount, commission: this.pct(ob.amount), state, stateLabel: STATE_LABEL[state] };
  }

  /** Toutes les lignes candidates, tous modules, tous agents (avant attribution unique). */
  private candidates(): CommissionLine[] {
    const out: CommissionLine[] = [];
    const push = (l: CommissionLine | null) => { if (l) out.push(l); };

    // Stationnement : logique du module (pénalités des constats, sessions dans l'heure d'un contrôle rouge).
    const pk = this.ctx.ext.parking as ParkingService | undefined;
    if (pk) {
      const agents = new Set([...pk.checks.all().map((c) => c.agentId), ...pk.violations.all().map((v) => v.agentId)]);
      for (const a of agents) for (const l of pk.field.earningsLines(a)) if (l.obligationId && l.triggerAt) out.push({ ...l, module: 'STATIONNEMENT', moduleLabel: MODULE_LABEL.STATIONNEMENT!, obligationId: l.obligationId, triggerAt: l.triggerAt, agentId: a });
    }

    // Titres et pass wewa : titre acheté dans l'heure qui suit un contrôle non valide (même plaque ou même titulaire).
    const ti = this.ctx.ext.titres as TitresService | undefined;
    if (ti) {
      const creds = ti.credentials.all().filter((c) => !!c.obligationId);
      for (const ev of ti.controls.all()) {
        if (ev.result === 'VALIDE' || !ev.controllerId) continue;
        const controlled = ev.credentialId ? ti.credentials.get(ev.credentialId) : undefined;
        const plate = alnum(ev.method === 'PLAQUE' ? ev.presented : controlled?.subject.plate);
        const holder = controlled?.holderTaxpayerId;
        if (!plate && !holder) continue;
        for (const c of creds) {
          if (c.id === ev.credentialId || Date.parse(c.issuedAt) < Date.parse(ev.at)) continue;
          if (!((plate && alnum(c.subject.plate) === plate) || (holder && c.holderTaxpayerId === holder))) continue;
          push(this.generated('TITRES', ev.controllerId, ev.at, c.obligationId!, c.number, c.subject.plate ?? '', c.place?.label ?? ''));
        }
      }
    }

    // Objets (verticales, terrain) : dette existante de l'objet payée dans les 72 h qui suivent le passage de l'agent.
    const objectDebts = (module: string, agentId: string, at: string, objectId: string, reference: string, zone: string) => {
      for (const ob of this.ctx.assessment.obligations.find((o) => o.objectId === objectId && Date.parse(o.createdAt) <= Date.parse(at))) {
        push(this.generated(module, agentId, at, ob.id, `${reference} · ${ob.id}`, '', zone));
      }
    };
    const vx = this.ctx.ext.verticales as VerticalesService | undefined;
    if (vx) {
      for (const sc of vx.scans.all()) {
        const p = vx.plates.get(sc.plateCode);
        if (p) objectDebts('VERTICALES', sc.by, sc.at, p.objectId, `Scan ${p.code}`, p.commune);
      }
    }
    const te = this.ctx.ext.terrain as TerrainService | undefined;
    if (te) {
      for (const f of te.findings.all()) {
        if (f.objectId && (f.outcome === 'CONSTATE' || f.outcome === 'OBJET_NON_ENREGISTRE')) objectDebts('TERRAIN', f.agentId, f.capturedAt, f.objectId, `Constat terrain ${f.id}`, f.commune);
      }
    }

    // Publicité : pénalité de l'inspection retenue (inspecteur) ; dette du support payée après une inspection non conforme.
    const pub = this.ctx.ext.publicite as PubliciteService | undefined;
    if (pub) {
      for (const c of pub.cases.all()) {
        const insp = pub.inspections.get(c.inspectionId);
        if (!insp || c.status !== 'RETENU' || !c.decision?.obligationId) continue;
        const ob = this.ctx.assessment.obligations.get(c.decision.obligationId);
        if (!ob) continue;
        const p = this.paid(ob.id);
        const state: EarningLine['state'] = ob.status === 'ANNULEE' ? 'ANNULEE' : p?.reconciled ? 'ACQUISE' : p ? 'CONFIRMEE' : 'EN_ATTENTE';
        out.push({ module: 'PUBLICITE', moduleLabel: MODULE_LABEL.PUBLICITE!, obligationId: ob.id, triggerAt: insp.observedAt, agentId: insp.inspectorId, source: 'PENALITE', reference: c.reference, plate: '', zone: c.commune, at: c.decision.at, base: ob.amount, commission: this.pct(ob.amount), state, stateLabel: STATE_LABEL[state] });
      }
      for (const insp of pub.inspections.all()) {
        if (insp.finding === 'CONFORME') continue;
        const d = pub.devices.get(insp.deviceId);
        const obId = d ? pub.currentAuthorization(d)?.liquidation?.obligationId : null;
        if (obId) push(this.generated('PUBLICITE', insp.inspectorId, insp.observedAt, obId, `${insp.reference} · ${d!.reference}`, '', d!.commune));
      }
    }
    return out;
  }

  /** Attribution unique : une obligation → une seule ligne (pénalité à son auteur ; paiement au premier contrôle). */
  lines(agentId?: string): CommissionLine[] {
    const best = new Map<string, CommissionLine>();
    for (const l of this.candidates()) {
      const cur = best.get(l.obligationId);
      const better = !cur || (l.source === 'PENALITE' && cur.source !== 'PENALITE') || (l.source === cur.source && l.triggerAt < cur.triggerAt);
      if (better) best.set(l.obligationId, l);
    }
    return [...best.values()].filter((l) => !agentId || l.agentId === agentId).sort((a, b) => b.at.localeCompare(a.at));
  }

  summary(agentId: string) {
    const lines = this.lines(agentId);
    const by = (st: EarningLine['state']) => sumByCurrency(lines.filter((l) => l.state === st).map((l) => l.commission));
    const month = this.ctx.clock.now().toISOString().slice(0, 7);
    const modules = [...new Set(lines.map((l) => l.module))].map((m) => ({
      module: m, moduleLabel: MODULE_LABEL[m] ?? m, lines: lines.filter((l) => l.module === m).length,
      commission: sumByCurrency(lines.filter((l) => l.module === m && l.state !== 'ANNULEE').map((l) => l.commission)),
    }));
    return {
      agentId, ratePct: AGENT_COMMISSION_PCT,
      totals: {
        acquise: by('ACQUISE'), confirmee: by('CONFIRMEE'), enAttente: by('EN_ATTENTE'), annulee: by('ANNULEE'),
        base: sumByCurrency(lines.filter((l) => l.state !== 'ANNULEE').map((l) => l.base)),
        ceMois: sumByCurrency(lines.filter((l) => l.state !== 'ANNULEE' && l.at.startsWith(month)).map((l) => l.commission)),
      },
      counts: { penalites: lines.filter((l) => l.source === 'PENALITE').length, paiements: lines.filter((l) => l.source === 'PAIEMENT').length },
      modules, lines,
      windows: Object.entries(ATTRIBUTION_WINDOWS_MINUTES).map(([m, min]) => ({ module: m, moduleLabel: MODULE_LABEL[m], minutes: min })),
      rules: [
        `Commission de ${AGENT_COMMISSION_PCT} % pour tout agent, quel que soit son module : uniquement sur les pénalités issues de vos constats et sur les paiements provoqués par vos contrôles.`,
        'Paiement provoqué : effectué après votre contrôle qui a révélé un défaut — dans l’heure (stationnement, titres, pass wewa) ou dans les 72 h (plaques des verticales, publicité, missions de terrain). Un paiement n’est attribué qu’une fois, au premier contrôle.',
        'Calculée sur des recettes arrivées au compte public ; acquise après rapprochement bancaire ; versée par le Trésor (paie). Vous ne recevez jamais d’argent de l’usager.',
        'Une pénalité n’existe qu’après vérification et décision par d’autres personnes ; annulée sur recours, elle annule la commission.',
        'Taux fixé par décision du maître d’ouvrage : un acte (arrêté) est requis avant tout versement réel.',
      ],
    };
  }

  /** Récapitulatif par agent (régie, pilotage, Trésor). */
  all() {
    const lines = this.lines();
    const agents = [...new Set(lines.map((l) => l.agentId))];
    return {
      ratePct: AGENT_COMMISSION_PCT,
      items: agents.map((a) => {
        const s = this.summary(a);
        return { agentId: a, agentName: this.ctx.users.get(a)?.name ?? a, totals: s.totals, counts: s.counts, modules: s.modules };
      }).sort((x, y) => x.agentName.localeCompare(y.agentName, 'fr')),
    };
  }
}
