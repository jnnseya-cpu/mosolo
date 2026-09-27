/**
 * Registre transversal des pénalités impayées (décision du maître d'ouvrage du 27/09/2026) :
 * - dans son module, tout agent voit les pénalités d'un usager (ex. stationnement : au contrôle de la plaque) ;
 * - au-delà de 30 jours sans paiement après la décision, TOUT agent de TOUT module les voit à l'occasion d'un contrôle
 *   (titre, pass wewa, plaque d'étal ou de chantier, support publicitaire…).
 * Garde-fous : visibles seulement APRÈS un contrôle réel de l'agent (référence du contrôle exigée) ; divulgation
 * journalisée (qui, quoi, quand, à quel contrôle). Le montant est affiché à tous les agents (décision du maître
 * d'ouvrage du 27/09/2026) : c'est le montant fixé par la décision, non négociable ; l'agent invite l'usager à payer
 * par les canaux officiels avec sa référence, il n'encaisse rien et ne prend aucune mesure sur place.
 */
import type { MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { CommissionService } from './commissions.js';
import { AgentMonitoring } from './monitoring.js';
import { CounterChecks, type CounterCheck } from './counterchecks.js';
import { CommissionValidations } from './validations.js';
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
  /** Obligation à régler (paiement numérique assisté par l'agent, jamais d'espèces). */
  obligationId?: string;
  /** Montant fixé par la décision (non négociable). */
  amount: MoneyJSON;
  /** Solde restant dû si une partie a déjà été payée (échéances). */
  remaining?: MoneyJSON;
  /** Pénalité du module de l'agent qui contrôle (visible sans délai). */
  sameModule?: boolean;
}

export interface OverdueDisclosure {
  count: number;
  lines: OverdueLine[];
  thresholdDays: number;
  guidance: string;
}

/** Usagers, partenaires et observateurs : jamais destinataires (seuls les agents publics qui contrôlent le sont). */
const NON_AGENT_ROLES = new Set(['R30', 'R31', 'R32', 'R33', 'R34', 'R36', 'R37']);
/** Module d'origine des pénalités correspondant au module du contrôle. */
const PENALTY_MODULE_OF_CONTROL: Record<string, string> = { STATIONNEMENT: 'STATIONNEMENT', PUBLICITE: 'PUBLICITE', TITRES: 'TITRES', RAKAPAY: 'TITRES', VERTICALES: 'VERTICALES' };
const alnum = (p: string) => p.toUpperCase().replace(/[^0-9A-Z]/g, '');
const DAY_MS = 86_400_000;

export class SanctionsService {
  /** Commission de 10 % des agents de tous les modules. */
  readonly commissions: CommissionService;
  /** Surveillance des constats par agent (incitation liée à la commission). */
  readonly monitoring: AgentMonitoring;
  /** Contre-vérification aléatoire des constats retenus (stationnement, publicité). */
  readonly counterChecks: CounterChecks;
  /** Validation à deux personnes des commissions acquises avant versement. */
  readonly validations: CommissionValidations;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: AppContext) {
    this.commissions = new CommissionService(ctx);
    this.monitoring = new AgentMonitoring(ctx, this.commissions);
    this.counterChecks = new CounterChecks(ctx);
    this.validations = new CommissionValidations(ctx, this.commissions);
    this.commissions.validationState = (key) => this.validations.stateOf(key);
  }

  /** Calcul périodique de la surveillance : les signaux « à examiner » ouvrent des alertes (dédoublonnées). */
  startScheduler(intervalMs: number): void {
    this.stopScheduler();
    this.timer = setInterval(() => { try { this.monitoring.report(); } catch { /* journalisé par l'audit */ } }, intervalMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Pénalités impayées depuis plus de 30 jours (tous modules), pour un titulaire et/ou une plaque. */
  overdue(subject: { taxpayerId?: string | null; plate?: string | null }): OverdueLine[] {
    return this.unpaid(subject).filter((l) => l.overdueDays >= OVERDUE_VISIBILITY_DAYS);
  }

  /** Toutes les pénalités décidées et impayées d'un titulaire et/ou d'une plaque, quelle que soit leur ancienneté. */
  unpaid(subject: { taxpayerId?: string | null; plate?: string | null }): OverdueLine[] {
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
    // Publicité : par exploitant, ou par plaque pour une publicité mobile (véhicule).
    const pub = this.ctx.ext.publicite as PubliciteService | undefined;
    const plate = subject.plate ? alnum(subject.plate) : null;
    if (pub && (subject.taxpayerId || plate)) {
      for (const c of pub.cases.all()) {
        const d = pub.devices.get(c.deviceId);
        if (!d) continue;
        const byOwner = !!subject.taxpayerId && d.ownerTaxpayerId === subject.taxpayerId;
        const byPlate = !!plate && d.placement === 'VEHICULE' && !!d.vehiclePlate && alnum(d.vehiclePlate) === plate;
        if (!byOwner && !byPlate) continue;
        const line = this.fromDecision('PUBLICITE', 'Publicité (KIN PUB CONTROL)', c.reference, c.finding, c.status === 'RETENU' ? c.decision : undefined, now);
        if (line) out.push(line);
      }
    }
    return out.sort((a, b) => b.overdueDays - a.overdueDays);
  }

  private fromDecision(module: string, moduleLabel: string, reference: string, nature: string, decision: { at: string; obligationId: string | null } | undefined, now: number): OverdueLine | null {
    if (!decision?.obligationId) return null;
    const ob = this.ctx.assessment.obligations.get(decision.obligationId);
    // Seules les obligations nées d'une décision de PÉNALITÉ figurent au registre (jamais des droits ou redevances :
    // la liquidation des droits d'un support publicitaire n'est pas une pénalité).
    if (!ob || ob.revenueCategory !== 'PENALITE') return null;
    if (ob.status === 'ANNULEE' || ob.status === 'SOLDEE' || ob.status === 'CONTESTEE') return null;
    // Paiement par échéances : la pénalité reste affichée tant qu'un solde est dû.
    const pay = paymentState(this.ctx, ob.id);
    if (pay.state === 'PAYE' || pay.state === 'RAPPROCHE') return null;
    const days = Math.floor((now - Date.parse(decision.at)) / DAY_MS);
    return {
      module, moduleLabel, reference, nature: nature.replace(/_/g, ' ').toLowerCase(), decidedAt: decision.at, overdueDays: days, amount: ob.amount, obligationId: ob.id,
      ...(pay.state === 'PARTIEL' && pay.remaining ? { remaining: pay.remaining } : {}),
    };
  }

  /**
   * À la suite d'un contrôle effectué par l'agent (décision du maître d'ouvrage du 27/09/2026) :
   * - pénalités de SON module : visibles dès la décision, quelle que soit leur ancienneté ;
   * - pénalités des AUTRES modules : visibles seulement après 30 jours d'impayé.
   * Le montant est affiché dans les deux cas. Rien pour un usager ; divulgation journalisée.
   */
  afterControl(user: User, subject: { taxpayerId?: string | null; plate?: string | null }, module: string, controlRef: string, opts: { otherModulesOnly?: boolean } = {}): OverdueDisclosure | null {
    if (user.roles.every((r) => NON_AGENT_ROLES.has(r))) return null;
    const own = PENALTY_MODULE_OF_CONTROL[module] ?? module;
    // otherModulesOnly : le module montre déjà ses propres pénalités dans sa réponse (ex. stationnement).
    const lines = this.unpaid(subject)
      .map((l) => ({ ...l, sameModule: l.module === own }))
      .filter((l) => (l.sameModule && !opts.otherModulesOnly) || (!l.sameModule && l.overdueDays >= OVERDUE_VISIBILITY_DAYS));
    if (!lines.length) return null;
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'penalties.overdue.disclosed', resourceType: 'control', resourceId: controlRef,
      details: { module, count: lines.length, references: lines.map((l) => l.reference), sameModule: lines.filter((l) => l.sameModule).length, subject: subject.taxpayerId ? 'titulaire' : 'plaque' },
    });
    return {
      count: lines.length, lines, thresholdDays: OVERDUE_VISIBILITY_DAYS,
      guidance: `Pénalité(s) impayée(s) : celles de votre module dès la décision, celles des autres modules après ${OVERDUE_VISIBILITY_DAYS} jours. Le montant est celui fixé par la décision : il ne se négocie pas. Invitez l’usager à payer par les canaux officiels (USSD, application, banque, point agréé) avec sa référence. N’encaissez rien ; aucune mesure sur place.`,
    };
  }
}

/** Ajoute `penalitesImpayees` à la réponse d'un contrôle si le registre est chargé et qu'il y a quelque chose à montrer. */
export function withOverdue<T extends object>(ctx: AppContext, user: User, result: T, subject: { taxpayerId?: string | null; plate?: string | null }, module: string, controlRef: string, opts: { otherModulesOnly?: boolean } = {}): T & { penalitesImpayees?: OverdueDisclosure } {
  const s = ctx.ext.sanctions as SanctionsService | undefined;
  const d = s?.afterControl(user, subject, module, controlRef, opts);
  return d ? { ...result, penalitesImpayees: d } : result;
}

/** Tirage au sort d'un constat retenu pour contre-vérification, si le registre transversal est chargé. */
export function sampleForCounterCheck(ctx: AppContext, input: Omit<CounterCheck, 'id' | 'sampledAt' | 'status' | 'outcome'>): CounterCheck | null {
  const s = ctx.ext.sanctions as SanctionsService | undefined;
  return s?.counterChecks.maybeSample(input) ?? null;
}
