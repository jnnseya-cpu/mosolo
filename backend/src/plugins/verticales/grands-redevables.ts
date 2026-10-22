/**
 * Grands redevables (module 56) — suivi rapproché des redevables à fort enjeu, construit PAR-DESSUS la désignation
 * existante (verticales/secteurs : « cellule des grands redevables ») et les circuits existants (déclarations
 * sectorielles rapprochées, garanties du recouvrement) :
 *  - PORTEFEUILLE DÉDIÉ : brasseries (module 17), télécoms (16), carrières (22), grandes entreprises (56) — obligations,
 *    paiements, retards, écarts de déclaration, garanties ;
 *  - GESTIONNAIRE DÉDIÉ par redevable, jamais lié au redevable ; ROTATION des gestionnaires : durée d'affectation
 *    maximale PAR DÉFAUT (à confirmer), rotation due signalée, retour immédiat de l'ancien gestionnaire interdit ;
 *  - CONVENTIONS par redevable : objet, périodicité des déclarations, base légale au registre juridique (aucune
 *    obligation sans règle publiée), document signé (empreinte), approbation par une seconde personne ; déclaration
 *    et rapprochement : périodes attendues / déclarées / validées, écarts ouverts ;
 *  - GESTION DE CAS : journal des décisions tracées (notes, échanges, décisions motivées par un cadre), garanties ;
 *  - indicateurs : recettes des grands redevables (paiements confirmés) ; délais de paiement (retard moyen, part payée à
 *    l'échéance).
 * Aucune taxation automatique : un écart ouvre une procédure contradictoire (circuit sectoriel existant).
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { SecteursService } from './secteurs.js';

export const CELL_ENTITY = 'DGTK';
/** Durée maximale d'affectation d'un gestionnaire (mois) — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const MANAGER_MAX_TENURE_MONTHS = 24;
export const PORTFOLIO_SECTORS: Record<string, string> = { '17': 'Brasseries, boissons, alcools et tabac', '16': 'Télécommunications (antennes)', '22': 'Carrières', '56': 'Grandes entreprises' };
export const PERIODICITIES = { MENSUELLE: 1, TRIMESTRIELLE: 3, ANNUELLE: 12 } as const;
export type Periodicity = keyof typeof PERIODICITIES;

export interface ManagerAssignment { id: string; taxpayerId: string; managerId: string; from: string; to?: string; assignedBy: string; motif: string; endReason?: 'ROTATION' | 'LEVEE' | 'REAFFECTATION' }
export interface Convention {
  id: string; taxpayerId: string; reference: string; object: string; sectors: string[]; periodicity: Periodicity;
  legalBasis: { instrumentId: string; article: string; title: string }; signedSha256: string; from: string; to: string;
  status: 'PROPOSEE' | 'ACTIVE' | 'REFUSEE' | 'RESILIEE'; proposedBy: string; proposedAt: string; decision?: { by: string; at: string; approve: boolean; motif: string };
}
export interface CaseEntry { id: string; taxpayerId: string; at: string; by: string; kind: 'NOTE' | 'ECHANGE' | 'DECISION'; text: string; evidenceSha256?: string }

type Rendement = { guarantees?: { all(): { taxpayerId: string; status: string; amount: MoneyJSON; nature: string }[] } };

export class GrandsRedevablesService {
  readonly assignments = new InMemoryRepository<ManagerAssignment>();
  readonly conventions = new InMemoryRepository<Convention>();
  readonly journal = new InMemoryAppendOnlyRepository<CaseEntry>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly secteurs: () => SecteursService | undefined) {}

  private now() { return this.ctx.clock.now().toISOString(); }
  private today() { return kinshasaDate(this.ctx.clock.now()); }
  private followed(taxpayerId: string) {
    const e = this.secteurs()?.largeTaxpayers.get(taxpayerId);
    if (!e || e.status !== 'SUIVI') throw notFound('LARGE_TAXPAYER_NOT_FOUND', 'Redevable non suivi par la cellule des grands redevables (désignation préalable).');
    return e;
  }
  current(taxpayerId: string) { return this.assignments.findOne((a) => a.taxpayerId === taxpayerId && !a.to); }
  private rotationDue(a: ManagerAssignment) {
    const d = new Date(a.from); d.setUTCMonth(d.getUTCMonth() + MANAGER_MAX_TENURE_MONTHS);
    return { dueAt: d.toISOString().slice(0, 10), due: d.toISOString() <= this.now() };
  }

  /** Affectation (ou rotation) du gestionnaire dédié : cadre de la cellule, gestionnaire non lié au redevable. */
  assignManager(user: User, taxpayerId: string, input: { managerId: string; motif: string }) {
    authorize(user, 'grands-redevables:manage', { entity: CELL_ENTITY });
    this.followed(taxpayerId);
    const m = this.ctx.users.get(input.managerId);
    if (!m || m.entity !== CELL_ENTITY || !m.roles.some((r) => ['R07', 'R11'].includes(r))) throw badRequest('INVALID_MANAGER', 'Gestionnaire : agent de la cellule (contrôleur ou chef de service de la DGTK).');
    assertNotRelated(m, taxpayerId, 'Conflit d’intérêts : le gestionnaire est lié au redevable.');
    const cur = this.current(taxpayerId);
    if (cur?.managerId === input.managerId) throw conflict('SAME_MANAGER', 'Ce gestionnaire suit déjà ce redevable.');
    const previous = this.assignments.find((a) => a.taxpayerId === taxpayerId && !!a.to).sort((a, b) => (a.to! < b.to! ? 1 : -1))[0];
    if (previous?.managerId === input.managerId || (cur && cur.managerId === input.managerId)) throw forbidden('ROTATION_REQUIRED', 'Rotation des gestionnaires : l’ancien gestionnaire ne reprend pas immédiatement le même redevable.');
    const at = this.now();
    if (cur) this.assignments.update({ ...cur, to: at, endReason: this.rotationDue(cur).due ? 'ROTATION' : 'REAFFECTATION' });
    const a = this.assignments.insert({ id: this.ids.next('AFF'), taxpayerId, managerId: m.id, from: at, assignedBy: user.id, motif: input.motif });
    this.ctx.audit.append({ actor: actorOf(user), action: 'grands_redevables.manager.assigned', resourceType: 'taxpayer', resourceId: taxpayerId, details: { managerId: m.id, previous: cur?.managerId ?? null, motif: input.motif } });
    return a;
  }

  proposeConvention(user: User, taxpayerId: string, input: { reference: string; object: string; sectors: string[]; periodicity: Periodicity; legalBasis: { instrumentId: string; article: string }; signedSha256: string; from: string; to: string }) {
    authorize(user, 'grands-redevables:convention', { entity: CELL_ENTITY });
    this.followed(taxpayerId);
    const inst = this.ctx.rules.instrument(input.legalBasis.instrumentId);
    if (!inst) throw unprocessable('LEGAL_BASIS_UNKNOWN', 'Instrument absent du registre juridique : aucune convention sans base légale publiée.');
    if (inst.status !== 'EN_VIGUEUR') throw unprocessable('LEGAL_BASIS_NOT_IN_FORCE', `Instrument au statut ${inst.status}.`);
    if (input.to <= input.from) throw badRequest('INVALID_PERIOD', 'Période invalide.');
    if (this.conventions.findOne((c) => c.reference === input.reference)) throw conflict('DUPLICATE_REFERENCE', 'Référence de convention déjà utilisée.');
    const c = this.conventions.insert({ id: this.ids.next('CONV'), taxpayerId, ...input, legalBasis: { ...input.legalBasis, title: inst.title }, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'grands_redevables.convention.proposed', resourceType: 'convention', resourceId: c.id, details: { taxpayerId, reference: c.reference, signedSha256: c.signedSha256 } });
    return c;
  }

  decideConvention(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'grands-redevables:decide', { entity: CELL_ENTITY });
    const c = this.conventions.get(id);
    if (!c) throw notFound('CONVENTION_NOT_FOUND', `Convention inconnue : ${id}`);
    if (c.status !== 'PROPOSEE') throw conflict('ALREADY_DECIDED', `Convention au statut ${c.status}.`);
    assertDistinctPerson(user.id, [c.proposedBy], 'Convention : approuvée par une personne distincte de celle qui l’a proposée.');
    assertNotRelated(user, c.taxpayerId, 'Conflit d’intérêts : le décideur est lié au redevable.');
    const out = this.conventions.update({ ...c, status: input.approve ? 'ACTIVE' : 'REFUSEE', decision: { by: user.id, at: this.now(), ...input } });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'grands_redevables.convention.approved' : 'grands_redevables.convention.refused', resourceType: 'convention', resourceId: id, details: { motif: input.motif, proposedBy: c.proposedBy } });
    return out;
  }

  /** Journal du dossier : notes et échanges (gestionnaire ou cadre) ; décisions motivées réservées aux cadres. */
  record(user: User, taxpayerId: string, input: { kind: CaseEntry['kind']; text: string; evidenceSha256?: string }) {
    authorize(user, input.kind === 'DECISION' ? 'grands-redevables:decide' : 'grands-redevables:manage', { entity: CELL_ENTITY });
    this.followed(taxpayerId);
    const cur = this.current(taxpayerId);
    if (input.kind !== 'DECISION' && cur && cur.managerId !== user.id && !user.roles.includes('R07') && !user.roles.includes('R06')) throw forbidden('NOT_ASSIGNED_MANAGER', 'Seul le gestionnaire dédié (ou un cadre) inscrit au journal du dossier.');
    const e = this.journal.append({ id: this.ids.next('JRN'), taxpayerId, at: this.now(), by: user.id, kind: input.kind, text: input.text, ...(input.evidenceSha256 ? { evidenceSha256: input.evidenceSha256 } : {}) });
    this.ctx.audit.append({ actor: actorOf(user), action: `grands_redevables.case.${input.kind.toLowerCase()}`, resourceType: 'taxpayer', resourceId: taxpayerId, details: { entryId: e.id } });
    return e;
  }

  /** Conformité déclarative d'une convention : périodes attendues (depuis le début) vs déclarées / validées. */
  private compliance(c: Convention) {
    const step = PERIODICITIES[c.periodicity];
    const periods: string[] = [];
    const d = new Date(`${c.from.slice(0, 7)}-01T00:00:00Z`);
    const end = (c.to < this.today() ? c.to : this.today()).slice(0, 7);
    while (d.toISOString().slice(0, 7) < end) { periods.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + step); }
    const decls = (this.secteurs()?.declarations.all() ?? []).filter((x) => x.taxpayerId === c.taxpayerId && (!c.sectors.length || c.sectors.includes(x.module)));
    const declared = periods.filter((p) => decls.some((x) => x.period.startsWith(p)));
    const validated = periods.filter((p) => decls.some((x) => x.period.startsWith(p) && x.status === 'VALIDEE'));
    return { expected: periods.length, declared: declared.length, validated: validated.length, missing: periods.filter((p) => !declared.includes(p)), openGaps: decls.filter((x) => x.status === 'ECART_A_INSTRUIRE' || x.status === 'EN_CONTRADICTOIRE').length };
  }

  private payments(taxpayerIds: Set<string>) {
    const today = this.today();
    const totals = new Map<string, Money>();
    const delays: number[] = [];
    let onTime = 0; let paidDue = 0; let overdue = 0;
    for (const o of this.ctx.assessment.obligations.all()) {
      if (!taxpayerIds.has(o.taxpayerId) || ['ANNULEE', 'ADMISE_EN_NON_VALEUR'].includes(o.status) || !!o.supersededBy) continue;
      const orders = this.ctx.payments.orders.find((p) => p.obligationId === o.id && !!p.confirmedAt && ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status));
      for (const p of orders) totals.set(p.amount.currency, (totals.get(p.amount.currency) ?? Money.zero(p.amount.currency)).add(Money.fromJSON(p.amount)));
      const first = orders.map((p) => p.confirmedAt!).sort()[0];
      if (first) {
        paidDue++;
        const late = Math.max(0, Math.floor((Date.parse(first.slice(0, 10)) - Date.parse(o.dueDate)) / DAY_MS));
        delays.push(late); if (late === 0) onTime++;
      } else if (o.dueDate < today) overdue++;
    }
    return { revenue: [...totals.values()].map((m) => m.toJSON()), delays, onTime, paidDue, overdue };
  }

  view(user: User) {
    authorize(user, 'grands-redevables:read', { entity: CELL_ENTITY });
    const sec = this.secteurs();
    const followed = (sec?.largeTaxpayers.all() ?? []).filter((e) => e.status === 'SUIVI');
    const guarantees = (this.ctx.ext.recouvrement as { rendement?: Rendement } | undefined)?.rendement?.guarantees?.all() ?? [];
    const portfolio = followed.map((e) => {
      const cur = this.current(e.taxpayerId);
      const pay = this.payments(new Set([e.taxpayerId]));
      const convs = this.conventions.find((c) => c.taxpayerId === e.taxpayerId);
      return {
        taxpayerId: e.taxpayerId, name: this.ctx.taxpayers.taxpayers.get(e.taxpayerId)?.fullName ?? e.taxpayerId,
        sectors: e.sectors.map((s) => ({ code: s, label: PORTFOLIO_SECTORS[s] ?? `Module ${s}` })),
        manager: cur ? { id: cur.managerId, name: this.ctx.users.get(cur.managerId)?.name ?? cur.managerId, since: cur.from, rotation: this.rotationDue(cur) } : null,
        managers: this.assignments.find((a) => a.taxpayerId === e.taxpayerId).map((a) => ({ managerId: a.managerId, from: a.from, to: a.to ?? null, endReason: a.endReason ?? null })),
        conventions: convs.map((c) => ({ ...c, compliance: c.status === 'ACTIVE' ? this.compliance(c) : null })),
        revenue: pay.revenue, overdueObligations: pay.overdue,
        guarantees: guarantees.filter((g) => g.taxpayerId === e.taxpayerId).map((g) => ({ nature: g.nature, status: g.status, amount: g.amount })),
        journal: this.journal.find((j) => j.taxpayerId === e.taxpayerId).slice(-20).reverse(),
      };
    });
    const all = this.payments(new Set(followed.map((e) => e.taxpayerId)));
    const meanDelay = all.delays.length ? (all.delays.reduce((a, b) => a + b, 0) / all.delays.length).toFixed(1) : null;
    const rotationsDue = portfolio.filter((p) => p.manager?.rotation.due).length;
    if (rotationsDue) this.ctx.alerts.raiseOnce(`grands-redevables:rotation:${this.today()}`, { type: 'ROTATION_GESTIONNAIRES_DUE', severity: 'MEDIUM', source: 'grands-redevables', detail: `${rotationsDue} gestionnaire(s) au-delà de la durée d’affectation (${MANAGER_MAX_TENURE_MONTHS} mois, par défaut) : rotation à décider.`, context: { automaticEffect: 'AUCUN' }, notifyRoles: ['R07', 'R06'] });
    return {
      entity: CELL_ENTITY, sectors: PORTFOLIO_SECTORS, periodicities: Object.keys(PERIODICITIES),
      params: { managerMaxTenureMonths: MANAGER_MAX_TENURE_MONTHS, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      portfolio, withoutManager: portfolio.filter((p) => !p.manager).length, rotationsDue,
      rule: 'Suivi par gestionnaire dédié, rotation des gestionnaires ; un écart ouvre une procédure contradictoire, jamais une taxation automatique.',
      indicators: [
        { code: 'RECETTES_GRANDS_REDEVABLES', label: 'Recettes des grands redevables (paiements confirmés)', measured: true, value: all.revenue.map((m) => `${m.amount} ${m.currency}`).join(' · ') || '0', unit: '', amounts: all.revenue },
        meanDelay === null
          ? { code: 'DELAIS_PAIEMENT', label: 'Délais de paiement (retard moyen)', measured: false, value: null, unit: 'jours', reason: 'Aucune obligation payée dans le portefeuille.' }
          : { code: 'DELAIS_PAIEMENT', label: 'Délais de paiement (retard moyen)', measured: true, value: meanDelay, unit: 'jours', basis: { paid: all.paidDue, onTimePct: ((all.onTime * 100) / all.paidDue).toFixed(1), overdueUnpaid: all.overdue } },
      ],
    };
  }
}
