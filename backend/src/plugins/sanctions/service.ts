/**
 * Registre transversal des pénalités impayées (décision du maître d'ouvrage du 27/09/2026) :
 * - dans son module, tout agent voit les pénalités d'un usager (ex. stationnement : au contrôle de la plaque) ;
 * - au-delà de 30 jours sans paiement après la décision, TOUT agent de TOUT module les voit à l'occasion d'un contrôle
 *   (titre, pass wewa, plaque d'étal ou de chantier, support publicitaire…).
 * Garde-fous : visibles seulement APRÈS un contrôle réel de l'agent (référence du contrôle exigée) ; divulgation
 * journalisée (qui, quoi, quand, à quel contrôle) ; hors du module d'origine, aucun montant n'est affiché — l'agent
 * invite l'usager à régulariser par les canaux officiels, il n'encaisse rien et ne prend aucune mesure sur place.
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import type { ParkingService } from '../parking/service.js';
import { OVERDUE_VISIBILITY_DAYS } from '../parking/field.js';
import { paymentState } from '../parking/support.js';
import type { PubliciteService } from '../publicite/service.js';

export interface OverdueLine {
  module: string;
  moduleLabel: string;
  reference: string;
  nature: string;
  decidedAt: string;
  overdueDays: number;
}

export interface OverdueDisclosure {
  count: number;
  lines: OverdueLine[];
  thresholdDays: number;
  guidance: string;
}

/** Usagers, partenaires et observateurs : jamais destinataires (seuls les agents publics qui contrôlent le sont). */
const NON_AGENT_ROLES = new Set(['R30', 'R31', 'R32', 'R33', 'R34', 'R36', 'R37']);
const alnum = (p: string) => p.toUpperCase().replace(/[^0-9A-Z]/g, '');
const DAY_MS = 86_400_000;

export class SanctionsService {
  constructor(private readonly ctx: AppContext) {}

  /** Pénalités impayées depuis plus de 30 jours (sans montant), pour un titulaire et/ou une plaque. */
  overdue(subject: { taxpayerId?: string | null; plate?: string | null }): OverdueLine[] {
    const out: OverdueLine[] = [];
    const now = this.ctx.clock.now().getTime();
    const parking = this.ctx.ext.parking as ParkingService | undefined;
    if (parking && (subject.plate || subject.taxpayerId)) {
      const plates = new Set<string>();
      if (subject.plate) plates.add(alnum(subject.plate));
      if (subject.taxpayerId) for (const v of parking.vehicles.find((x) => x.taxpayerId === subject.taxpayerId)) plates.add(alnum(v.plate));
      for (const v of parking.violations.all()) {
        if (!(plates.has(alnum(v.plate)) || (subject.taxpayerId && v.holderTaxpayerId === subject.taxpayerId))) continue;
        const line = this.fromDecision('STATIONNEMENT', 'Stationnement (ParkSmart)', v.reference, v.nature, v.status === 'RETENU' ? v.decision : undefined, now);
        if (line) out.push(line);
      }
    }
    const pub = this.ctx.ext.publicite as PubliciteService | undefined;
    if (pub && subject.taxpayerId) {
      for (const c of pub.cases.all()) {
        const d = pub.devices.get(c.deviceId);
        if (d?.ownerTaxpayerId !== subject.taxpayerId) continue;
        const line = this.fromDecision('PUBLICITE', 'Publicité (KIN PUB CONTROL)', c.reference, c.finding, c.status === 'RETENU' ? c.decision : undefined, now);
        if (line) out.push(line);
      }
    }
    return out.sort((a, b) => b.overdueDays - a.overdueDays);
  }

  private fromDecision(module: string, moduleLabel: string, reference: string, nature: string, decision: { at: string; obligationId: string | null } | undefined, now: number): OverdueLine | null {
    if (!decision?.obligationId) return null;
    const ob = this.ctx.assessment.obligations.get(decision.obligationId);
    if (!ob || ob.status === 'ANNULEE' || ob.status === 'SOLDEE' || ob.status === 'CONTESTEE') return null;
    const pay = paymentState(this.ctx, ob.id).state;
    if (pay === 'PAYE' || pay === 'RAPPROCHE') return null;
    const days = Math.floor((now - Date.parse(decision.at)) / DAY_MS);
    if (days < OVERDUE_VISIBILITY_DAYS) return null;
    return { module, moduleLabel, reference, nature: nature.replace(/_/g, ' ').toLowerCase(), decidedAt: decision.at, overdueDays: days };
  }

  /**
   * À la suite d'un contrôle effectué par l'agent (tout module) : pénalités impayées depuis plus de 30 jours.
   * Rien pour un usager public ; divulgation journalisée seulement s'il y a quelque chose à montrer.
   */
  afterControl(user: User, subject: { taxpayerId?: string | null; plate?: string | null }, module: string, controlRef: string): OverdueDisclosure | null {
    if (user.roles.every((r) => NON_AGENT_ROLES.has(r))) return null;
    const lines = this.overdue(subject);
    if (!lines.length) return null;
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'penalties.overdue.disclosed', resourceType: 'control', resourceId: controlRef,
      details: { module, count: lines.length, references: lines.map((l) => l.reference), subject: subject.taxpayerId ? 'titulaire' : 'plaque' },
    });
    return {
      count: lines.length, lines, thresholdDays: OVERDUE_VISIBILITY_DAYS,
      guidance: `Pénalité(s) impayée(s) depuis plus de ${OVERDUE_VISIBILITY_DAYS} jours. Informez l’usager qu’il peut régulariser par les canaux officiels (USSD, application, banque, point agréé). Aucun encaissement, aucune mesure sur place ; le montant n’est affiché qu’à l’usager et au module d’origine.`,
    };
  }
}

/** Ajoute `penalitesImpayees` à la réponse d'un contrôle si le registre est chargé et qu'il y a quelque chose à montrer. */
export function withOverdue<T extends object>(ctx: AppContext, user: User, result: T, subject: { taxpayerId?: string | null; plate?: string | null }, module: string, controlRef: string): T & { penalitesImpayees?: OverdueDisclosure } {
  const s = ctx.ext.sanctions as SanctionsService | undefined;
  const d = s?.afterControl(user, subject, module, controlRef);
  return d ? { ...result, penalitesImpayees: d } : result;
}
