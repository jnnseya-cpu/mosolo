/**
 * Plaque fiscale immobilière NFIU (module 79) — décision du maître d'ouvrage du 27/09/2026 (« Plaque NFIU : l'agent
 * habilité voit la situation complète (§ 16.7) ; scan public minimal »), construite PAR-DESSUS les plaques existantes
 * (`service.ts` : pose, scan journalisé, vérification publique, guichet, rapport journalier) — rien n'est retiré :
 *
 *  - HABILITATION NFIU : un chef de service (R07) ou un directeur (R06) habilite nommément un agent de recouvrement
 *    (agent de terrain R10) sur des communes, motif à l'appui, avec une échéance ; jamais l'agent lui-même (aucune
 *    élévation) ; révocable ; journalisée. Sans habilitation, l'agent de terrain garde l'accès MINIMAL (inchangé).
 *  - SITUATION COMPLÈTE au scan d'une plaque NFIU (agent habilité, contrôleur, chef de service) : propriétaire,
 *    occupation (occupé ou loué, loyers déclarés), impôt foncier et IRL dus, payé / en attente / impayé, pénalités
 *    (propositions et décisions du circuit de recouvrement), historique (paiements, plaques, scans, visites).
 *    Lecture seule : AUCUN montant n'est modifiable, négociable ou estimable par l'agent (aucune route d'écriture ;
 *    chaque consultation est journalisée).
 *  - SCAN PUBLIC MINIMAL : inchangé (`publicPlate` : authenticité, commune, quartier, couleur de situation).
 *  - RAPPORTS JOURNALIERS DES AGENTS : produits automatiquement chaque jour (planificateur, idempotent) et à la demande :
 *    poses, remplacements, scans par couleur de situation, présence vérifiée, situations complètes consultées ;
 *    l'agent voit son propre rapport, l'encadrement celui de tous.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { InMemoryRepository } from '../../core/repository.js';
import type { Obligation } from '../../modules/assessment/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { Plate, VerticalesService } from './service.js';

const { always, sameEntity } = GRANTS;
export const PN = {
  habilitate: 'verticales:nfiu.habilitate',
  full: 'verticales:nfiu.full',
  report: 'verticales:nfiu.report',
} as const;

export function registerNfiuPolicies(): void {
  // Habilitation : chef de service ou directeur de la régie foncière (jamais l'agent lui-même).
  definePolicy(PN.habilitate, { R07: sameEntity, R06: sameEntity });
  // Situation complète sans habilitation nominative : contrôleur, chef de service, directeur, contentieux (inchangés).
  definePolicy(PN.full, { R11: always, R07: always, R06: always, R20: always });
  definePolicy(PN.report, { R09: always, R07: always, R06: always, R11: always, R22: always });
}

export const NFIU_ENTITY = 'DGIPK';
const CONFIRMED = ['CONFIRME', 'REGLE', 'RAPPROCHE'];

export interface NfiuHabilitation {
  id: string;
  userId: string;
  communes: string[];
  motif: string;
  validUntil: string;
  grantedBy: string;
  grantedAt: string;
  revoked?: { by: string; at: string; motif: string };
}

export interface NfiuDailyReport {
  /** Jour de Kinshasa AAAA-MM-JJ. */
  id: string;
  date: string;
  generatedAt: string;
  trigger: 'PLANIFIEE' | 'MANUELLE';
  totals: { platesIssued: number; platesReplaced: number; scans: number; fullSituations: number; red: number; amber: number; green: number; grey: number; presenceVerified: number };
  agents: {
    agentId: string; agentName: string; platesIssued: number; platesReplaced: number; scans: number; fullSituations: number;
    bySituation: { red: number; amber: number; green: number; grey: number }; presenceVerified: number; communes: string[];
  }[];
}

type PayState = 'PAYE' | 'PARTIEL' | 'EN_ATTENTE' | 'IMPAYE' | 'CONTESTE';
const PAY_LABEL: Record<PayState, string> = { PAYE: 'Payé', PARTIEL: 'Payé partiellement', EN_ATTENTE: 'En attente (non échu)', IMPAYE: 'Impayé à l’échéance', CONTESTE: 'Contesté (recours en cours)' };

export class NfiuService {
  readonly habilitations = new InMemoryRepository<NfiuHabilitation>();
  readonly reports = new InMemoryRepository<NfiuDailyReport>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ctx: AppContext, private readonly vx: VerticalesService) {}

  private now() { return this.ctx.clock.now(); }

  // ------------------------------------------------------------------------------------------ habilitation

  habilitate(user: User, input: { userId: string; communes: string[]; motif: string; validUntil: string }): NfiuHabilitation {
    authorize(user, PN.habilitate, { entity: NFIU_ENTITY });
    const agent = this.ctx.users.get(input.userId);
    if (!agent) throw notFound('USER_NOT_FOUND', `Utilisateur inconnu : ${input.userId}`);
    if (!agent.roles.includes('R10')) throw unprocessable('NOT_A_FIELD_AGENT', 'Seul un agent de terrain (recouvrement) reçoit une habilitation NFIU ; les autres rôles gardent leur accès.');
    try { assertDistinctPerson(user.id, [agent.id], 'Aucune élévation : un agent ne s’habilite jamais lui-même.'); } catch (e) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'nfiu.habilitation.refused', resourceType: 'user', resourceId: agent.id, outcome: 'DENIED', details: { reason: 'SELF_ELEVATION' } });
      throw e;
    }
    if (!input.communes.length || input.communes.some((c) => !isCommune(c))) throw badRequest('UNKNOWN_COMMUNE', 'Communes de Kinshasa attendues.');
    const outside = agent.territory ? input.communes.filter((c) => !agent.territory!.includes(c)) : [];
    if (outside.length) throw unprocessable('OUTSIDE_TERRITORY', `Hors du secteur de l’agent : ${outside.join(', ')}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil) || input.validUntil < kinshasaDate(this.now())) throw unprocessable('INVALID_VALIDITY', 'Échéance future AAAA-MM-JJ requise.');
    if (input.motif.trim().length < 10) throw badRequest('MOTIF_REQUIRED', 'Motif de 10 caractères au moins.');
    const rec: NfiuHabilitation = { id: agent.id, userId: agent.id, communes: input.communes, motif: input.motif.trim(), validUntil: input.validUntil, grantedBy: user.id, grantedAt: this.now().toISOString() };
    const saved = this.habilitations.get(agent.id) ? this.habilitations.update(rec) : this.habilitations.insert(rec);
    this.ctx.audit.append({ actor: actorOf(user), action: 'nfiu.habilitation.granted', resourceType: 'user', resourceId: agent.id, details: { communes: input.communes, validUntil: input.validUntil, motif: rec.motif } });
    return saved;
  }

  revoke(user: User, userId: string, motif: string): NfiuHabilitation {
    authorize(user, PN.habilitate, { entity: NFIU_ENTITY });
    const h = this.habilitations.get(userId);
    if (!h || h.revoked) throw notFound('HABILITATION_NOT_FOUND', 'Aucune habilitation NFIU active pour cet agent.');
    const saved = this.habilitations.update({ ...h, revoked: { by: user.id, at: this.now().toISOString(), motif: motif.trim() } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'nfiu.habilitation.revoked', resourceType: 'user', resourceId: userId, details: { motif: motif.trim() } });
    return saved;
  }

  list(user: User) {
    authorize(user, PN.habilitate, { entity: NFIU_ENTITY });
    return this.habilitations.all().map((h) => ({ ...h, agentName: this.ctx.users.get(h.userId)?.name ?? h.userId, active: this.isActive(h) }));
  }

  private isActive(h: NfiuHabilitation | undefined): boolean {
    return !!h && !h.revoked && h.validUntil >= kinshasaDate(this.now());
  }

  /** L'utilisateur voit-il la situation complète d'une plaque NFIU de cette commune ? */
  canSeeFull(user: User, commune: string): boolean {
    if (evaluate(user, PN.full, { communes: [commune] })) return true;
    const h = this.habilitations.get(user.id);
    return user.roles.includes('R10') && this.isActive(h) && h!.communes.includes(commune) && (!user.territory || user.territory.includes(commune));
  }

  // ------------------------------------------------------------------------------------------ situation complète

  private kindOf(o: Obligation): 'IF' | 'IRL' | 'AUTRE' {
    const rule = this.ctx.rules.rules.get(o.ruleId);
    const text = `${o.ruleCode} ${rule?.label ?? ''} ${o.label}`;
    if (/(^|[^A-Z])IRL|revenus locatifs/i.test(text)) return 'IRL';
    if (/(^|[^A-Z])IF([^A-Z]|$)|foncier/i.test(text)) return 'IF';
    return 'AUTRE';
  }

  private payState(o: Obligation): { state: PayState; paid: MoneyJSON; remaining: MoneyJSON; lastPaymentAt: string | null } {
    const orders = this.ctx.payments.byObligation(o.id).filter((p) => CONFIRMED.includes(p.status));
    const paid = orders.reduce((m, p) => m.add(Money.fromJSON(p.amount)), Money.zero(o.amount.currency));
    const total = Money.fromJSON(o.amount);
    const remaining = paid.compare(total) >= 0 ? Money.zero(o.amount.currency) : total.subtract(paid);
    const last = orders.map((p) => p.confirmedAt ?? '').sort().at(-1) || null;
    let state: PayState;
    if (o.status === 'SOLDEE' || remaining.isZero()) state = 'PAYE';
    else if (o.status === 'CONTESTEE') state = 'CONTESTE';
    else if (!paid.isZero()) state = 'PARTIEL';
    else if (o.dueDate < kinshasaDate(this.now()) || o.status === 'EN_RETARD') state = 'IMPAYE';
    else state = 'EN_ATTENTE';
    return { state, paid: paid.toJSON(), remaining: remaining.toJSON(), lastPaymentAt: last };
  }

  /** Pénalités du circuit de recouvrement rattachées à l'obligation (proposées, décidées, liquidées). */
  private penaltiesOf(o: Obligation) {
    const rec = this.ctx.ext.recouvrement as { penalties?: { find(f: (p: { obligationId: string }) => boolean): { id: string; status: string; previewAmount: MoneyJSON; liquidatedObligationId?: string; decision?: { at: string } }[] } } | undefined;
    const days = o.dueDate < kinshasaDate(this.now()) ? Math.floor((Date.parse(kinshasaDate(this.now())) - Date.parse(o.dueDate)) / DAY_MS) : 0;
    const items = (rec?.penalties?.find((p) => p.obligationId === o.id) ?? []).map((p) => {
      const liq = p.liquidatedObligationId ? this.ctx.assessment.obligations.get(p.liquidatedObligationId) : undefined;
      return { id: p.id, status: p.status, amount: liq?.amount ?? p.previewAmount, obligationId: p.liquidatedObligationId ?? null, payment: liq ? this.payState(liq).state : null };
    });
    return { overdueDays: days, items };
  }

  /**
   * Situation complète d'un bien plaqué NFIU (lecture seule, journalisée). Refus pour tout rôle non habilité : son accès
   * reste celui du scan (minimal pour l'agent de terrain non habilité).
   */
  fullSituation(user: User, plate: Plate) {
    if (plate.kind !== 'NFIU') throw unprocessable('NOT_NFIU', 'Situation complète réservée aux plaques fiscales immobilières (NFIU).');
    if (!this.canSeeFull(user, plate.commune)) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'nfiu.full_situation.refused', resourceType: 'plate', resourceId: plate.code, outcome: 'DENIED', details: { commune: plate.commune } });
      throw forbidden('NFIU_HABILITATION_REQUIRED', 'Situation complète réservée aux agents habilités NFIU (et aux contrôleurs) : accès minimal maintenu.');
    }
    const o = this.ctx.objects.get(plate.objectId);
    const related = [o, ...this.ctx.objects.objects.find((x) => x.attributes.parcelleId === o.id || x.attributes.batimentId === o.id)];
    const ids = new Set(related.map((x) => x.id));
    const owner = o.taxpayerId ? this.ctx.taxpayers.taxpayers.get(o.taxpayerId) : undefined;
    const leases = this.ctx.objects.leases.find((l) => ids.has(l.unitObjectId));
    const obligations = this.ctx.assessment.obligations.find((ob) => ids.has(ob.objectId) && ob.status !== 'ANNULEE')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((ob) => {
        const p = this.payState(ob);
        return {
          id: ob.id, kind: this.kindOf(ob), label: ob.label, objectId: ob.objectId, ruleCode: ob.ruleCode, ruleVersion: ob.ruleVersion, period: ob.createdAt.slice(0, 4),
          amount: ob.amount, dueDate: ob.dueDate, status: ob.status, payment: p.state, paymentLabel: PAY_LABEL[p.state], paid: p.paid, remaining: p.remaining, lastPaymentAt: p.lastPaymentAt,
          penalties: this.penaltiesOf(ob), editable: false as const,
        };
      });
    const sum = (kind: 'IF' | 'IRL', f: (x: (typeof obligations)[number]) => MoneyJSON, filter: (x: (typeof obligations)[number]) => boolean = () => true) => {
      const m = new Map<string, Money>();
      for (const x of obligations.filter((y) => y.kind === kind && filter(y))) { const v = f(x); m.set(v.currency, (m.get(v.currency) ?? Money.zero(v.currency)).add(Money.fromJSON(v))); }
      return [...m.values()].map((v) => v.toJSON());
    };
    const payments = obligations.flatMap((ob) => this.ctx.payments.byObligation(ob.id).filter((p) => CONFIRMED.includes(p.status))
      .map((p) => ({ obligationId: ob.id, kind: ob.kind, amount: p.amount, confirmedAt: p.confirmedAt ?? null, reference: p.paymentReference, channel: p.channel })))
      .sort((a, b) => (b.confirmedAt ?? '').localeCompare(a.confirmedAt ?? ''));
    const scans = this.vx.scans.find((s) => s.plateCode === plate.code).sort((a, b) => b.at.localeCompare(a.at));
    const platesHistory = this.vx.plates.find((p) => p.objectId === o.id).map((p) => ({ code: p.code, status: p.status, issuedAt: p.issuedAt, replacedBy: p.replacedBy ?? null, reason: p.replacementReason ?? null }));
    const visits = this.vx.cases.find((c) => !!c.objectId && ids.has(c.objectId)).flatMap((c) => c.visits.map((v) => ({ caseId: c.id, date: v.date, result: v.result }))).sort((a, b) => b.date.localeCompare(a.date));
    this.ctx.audit.append({ actor: actorOf(user), action: 'nfiu.full_situation.viewed', resourceType: 'plate', resourceId: plate.code, details: { objectId: o.id, obligations: obligations.length, habilitation: !evaluate(user, PN.full, { communes: [plate.commune] }) } });
    return {
      owner: owner ? { taxpayerId: owner.id, name: owner.fullName, kind: owner.kind } : null,
      occupation: {
        status: leases.length ? 'LOUE' as const : 'OCCUPE_OU_NON_DECLARE' as const,
        label: leases.length ? 'Loué (bail déclaré)' : 'Occupé par le propriétaire ou bail non déclaré',
        leases: leases.map((l) => ({ id: l.id, unitObjectId: l.unitObjectId, rent: l.rent, periodicity: l.periodicity, start: l.start, end: l.end ?? null, probativeStatus: l.probativeStatus, declaredByRole: l.declaredByRole })),
      },
      obligations,
      totals: {
        IF: { due: sum('IF', (x) => x.amount), paid: sum('IF', (x) => x.paid), remaining: sum('IF', (x) => x.remaining), unpaid: obligations.filter((x) => x.kind === 'IF' && x.payment === 'IMPAYE').length },
        IRL: { due: sum('IRL', (x) => x.amount), paid: sum('IRL', (x) => x.paid), remaining: sum('IRL', (x) => x.remaining), unpaid: obligations.filter((x) => x.kind === 'IRL' && x.payment === 'IMPAYE').length },
      },
      history: { payments, plates: platesHistory, scans: scans.slice(0, 20).map((s) => ({ at: s.at, by: s.by, situation: s.situation ?? null })), visits },
      editable: false as const,
      notice: 'Situation complète en lecture seule : aucun montant n’est modifiable, négociable ou estimable par l’agent ; paiement numérique au compte public uniquement.',
    };
  }

  // ------------------------------------------------------------------------------------------ rapports journaliers

  private compute(date: string, trigger: NfiuDailyReport['trigger']): NfiuDailyReport {
    const inDay = (iso: string) => kinshasaDate(new Date(iso)) === date;
    const issued = this.vx.plates.find((p) => inDay(p.issuedAt));
    const scans = this.vx.scans.find((s) => inDay(s.at));
    const full = this.ctx.audit.list({ action: 'nfiu.full_situation.viewed', limit: Number.MAX_SAFE_INTEGER }).items.filter((r) => inDay(r.at));
    const agents = [...new Set([...issued.map((p) => p.issuedBy), ...scans.map((s) => s.by), ...full.map((r) => r.actor.id)])].sort();
    const color = (list: typeof scans, c: string) => list.filter((s) => (s.situation ?? 'grey') === c).length;
    const rows = agents.map((id) => {
      const mine = scans.filter((s) => s.by === id);
      const mineIssued = issued.filter((p) => p.issuedBy === id);
      return {
        agentId: id, agentName: this.ctx.users.get(id)?.name ?? id, platesIssued: mineIssued.length,
        platesReplaced: mineIssued.filter((p) => this.vx.plates.findOne((x) => x.replacedBy === p.code)).length,
        scans: mine.length, fullSituations: full.filter((r) => r.actor.id === id).length,
        bySituation: { red: color(mine, 'red'), amber: color(mine, 'amber'), green: color(mine, 'green'), grey: color(mine, 'grey') },
        presenceVerified: mine.filter((s) => s.presenceVerified).length,
        communes: [...new Set([...mineIssued.map((p) => p.commune), ...mine.map((s) => this.vx.plates.get(s.plateCode)?.commune ?? '').filter(Boolean)])].sort(),
      };
    });
    return {
      id: date, date, generatedAt: this.now().toISOString(), trigger,
      totals: {
        platesIssued: issued.length, platesReplaced: rows.reduce((n, r) => n + r.platesReplaced, 0), scans: scans.length, fullSituations: full.length,
        red: color(scans, 'red'), amber: color(scans, 'amber'), green: color(scans, 'green'), grey: color(scans, 'grey'), presenceVerified: scans.filter((s) => s.presenceVerified).length,
      },
      agents: rows,
    };
  }

  /** Production (ou reproduction) du rapport d'un jour : conservé, journalisé ; un jour échu n'est produit qu'une fois. */
  generate(user: User | 'system', date: string): NfiuDailyReport {
    if (user !== 'system') authorize(user, PN.report, {});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('INVALID_DATE', 'Jour AAAA-MM-JJ attendu.');
    const today = kinshasaDate(this.now());
    if (date > today) throw unprocessable('FUTURE_DATE', 'Aucun rapport pour un jour futur.');
    const existing = this.reports.get(date);
    if (existing && date < today) return existing;
    const r = this.compute(date, user === 'system' ? 'PLANIFIEE' : 'MANUELLE');
    const saved = existing ? this.reports.update(r) : this.reports.insert(r);
    this.ctx.audit.append({ actor: user === 'system' ? { kind: 'system', id: 'nfiu:rapports' } : actorOf(user), action: 'nfiu.daily_report.generated', resourceType: 'nfiu_daily_report', resourceId: date, details: { agents: r.agents.length, scans: r.totals.scans, trigger: r.trigger } });
    return saved;
  }

  /** Rapport d'un jour : l'encadrement voit tous les agents ; l'agent ne voit que sa ligne. */
  report(user: User, date: string) {
    const r = this.reports.get(date) ?? this.compute(date, 'MANUELLE');
    if (evaluate(user, PN.report, {})) return r;
    if (!user.roles.some((x) => x === 'R10' || x === 'R35')) throw forbidden('FORBIDDEN', 'Rapport réservé aux agents et à leur encadrement.');
    const mine = r.agents.filter((a) => a.agentId === user.id);
    return { ...r, agents: mine, totals: undefined, scope: 'AGENT' as const };
  }

  /** Planificateur : le rapport de la veille est produit une fois (reprise après redémarrage). */
  scheduledTick(): { ran: boolean } {
    const yesterday = kinshasaDate(new Date(this.now().getTime() - DAY_MS));
    if (this.reports.get(yesterday)) return { ran: false };
    try { this.generate('system', yesterday); return { ran: true }; } catch { return { ran: false }; }
  }

  startScheduler(tickMs = 900_000): void {
    this.stopScheduler();
    this.timer = setInterval(() => { try { this.scheduledTick(); } catch { /* journalisé */ } }, tickMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Indicateurs du module 79 : maisons immatriculées ; conformité IF et IRL (objets plaqués à jour / dus). */
  indicators() {
    const nfiu = this.vx.plates.find((p) => p.kind === 'NFIU' && p.status === 'POSEE');
    const today = kinshasaDate(this.now());
    const byKind = (kind: 'IF' | 'IRL') => {
      let due = 0; let upToDate = 0;
      for (const p of nfiu) {
        const ids = new Set([p.objectId, ...this.ctx.objects.objects.find((x) => x.attributes.parcelleId === p.objectId).map((x) => x.id)]);
        const obs = this.ctx.assessment.obligations.find((o) => ids.has(o.objectId) && o.status !== 'ANNULEE' && this.kindOf(o) === kind);
        if (!obs.length) continue;
        due += 1;
        if (obs.every((o) => { const s = this.payState(o).state; return s === 'PAYE' || (s === 'EN_ATTENTE' && o.dueDate >= today) || s === 'CONTESTE'; })) upToDate += 1;
      }
      return { housesWithObligation: due, upToDate, rate: due ? `${Math.round((upToDate * 1000) / due) / 10}` : null };
    };
    return { housesRegistered: nfiu.length, IF: byKind('IF'), IRL: byKind('IRL') };
  }
}

/** Planificateur des rapports journaliers : actif par défaut, désactivé sous les tests ; MOSOLO_NFIU_REPORT_SCHEDULER. */
export function nfiuReportSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.MOSOLO_NFIU_REPORT_SCHEDULER ?? '').trim().toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return !env.VITEST;
}
