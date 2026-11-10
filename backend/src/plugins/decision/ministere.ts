/**
 * Tableaux de bord ministériels (module 44, § 12A.3, § 37A.6) : chaque ministère voit SES modules (rattachés par
 * l'administrateur de la plateforme, seconde validation du Comité de pilotage), leurs recettes, leur performance et
 * la part de 10 % du ministère de tutelle — calculée, rapprochée, versée :
 *  - calculée : part « tutelle » de la clé du § 37A appliquée aux recettes RAPPROCHÉES des modules du ministère
 *    (mode SIMULATION tant que la clé n'est pas ACTIVE : valeurs par défaut à confirmer, aucun décaissement) ;
 *  - rapprochée : l'assiette est le niveau 9 (rapproché), jamais le liquidé ni le déclaré ;
 *  - versée : versements CONSTATÉS par le Trésor (référence de l'ordre de paiement budgétaire, quatre yeux) —
 *    la plateforme constate, elle ne décaisse jamais.
 * Filtrage strict : un ministre (R04) ne voit que son ministère ; aucune donnée hors compétence, aucun nom.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDay } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import type { ModuleConfig } from '../acces/model.js';
import { isReconciled, periodRange } from '../pilotage/ladder.js';
import { CurrencyTotals } from '../pilotage/money.js';
import { allocate, DEFAULT_SLICES, type SliceDef } from '../pilotage/repartition/model.js';
import type { PilotageService } from '../pilotage/service.js';
import { pctNum } from './common.js';

export interface VersementConstate {
  id: string;
  entity: string;
  period: string;
  amount: MoneyJSON;
  /** Référence de l'ordre de paiement budgétaire émis par le Trésor (hors plateforme). */
  reference: string;
  motif: string;
  status: 'PROPOSE' | 'CONSTATE' | 'REJETE';
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
}

type Acces = { modules?: { all(): ModuleConfig[] }; entities?: { get(id: string): { id: string; name: string; kind: string } | undefined; all(): { id: string; name: string; kind: string }[] } };
type Repartition = { key(): { status: string; slices: SliceDef[]; version: number } };
type Titres = { credentials?: { all(): { module: string; obligationId?: string }[] } };

/** Rôles au périmètre de TOUS les ministères (lecture) ; le ministre (R04) est borné à son ministère. */
const ALL_MINISTRIES = ['R01', 'R02', 'R03', 'R05', 'R22', 'R23'];

export class MinistereService {
  readonly versements = new InMemoryRepository<VersementConstate>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly pil: () => PilotageService) {}

  private now() { return this.ctx.clock.now().toISOString(); }
  private acces() { return this.ctx.ext.acces as Acces | undefined; }

  /** Entité ministérielle effective : strictement celle du ministre ; les autres rôles habilités choisissent. */
  private entityFor(user: User, requested?: string): string {
    authorize(user, 'decision:ministere.read');
    if (user.roles.some((r) => ALL_MINISTRIES.includes(r))) {
      if (!requested) throw badRequest('ENTITY_REQUIRED', 'Préciser le ministère (paramètre entity).');
      return requested;
    }
    if (requested && requested !== user.entity) {
      throw forbidden('OUT_OF_COMPETENCE', 'Aucune consultation de données hors de la compétence de votre ministère (module 44).');
    }
    return user.entity;
  }

  private modulesOf(entity: string): ModuleConfig[] {
    return (this.acces()?.modules?.all() ?? []).filter((m) => m.responsibleEntity === entity);
  }

  ministries(user: User) {
    authorize(user, 'decision:ministere.read');
    const all = (this.acces()?.entities?.all() ?? []).filter((e) => e.kind === 'MINISTERE');
    return { items: user.roles.some((r) => ALL_MINISTRIES.includes(r)) ? all : all.filter((e) => e.id === user.entity) };
  }

  view(user: User, q: { entity?: string; period?: string }) {
    const entity = this.entityFor(user, q.entity);
    const range = q.period ? periodRange(q.period) : null;
    const inRange = (ts?: string) => !!ts && (!range || (kinshasaDay(ts) >= range.from && kinshasaDay(ts) <= range.to));
    const facts = this.pil().facts();
    const modules = this.modulesOf(entity);
    const objects = new Map(this.ctx.objects.objects.all().map((o) => [o.id, o.category as string]));
    const credentials = (this.ctx.ext.titres as Titres | undefined)?.credentials?.all() ?? [];
    const rep = this.ctx.ext.repartition as Repartition | undefined;
    const key = rep?.key();
    const slices = key?.slices ?? DEFAULT_SLICES;
    const tutelle = slices.find((s) => s.code === 'TUTELLE');
    const mode = key?.status === 'ACTIVE' ? 'CALCUL' : 'SIMULATION';
    const today = kinshasaDay(facts.asOf);

    const rows = modules.map((m) => {
      const credObligations = new Set(credentials.filter((c) => c.module === m.code || c.module === m.revenueScope).map((c) => c.obligationId).filter((x): x is string => !!x));
      const match = (o: { id: string; ruleCode: string; objectId: string }) => m.ruleCodes.includes(o.ruleCode) || m.objectTypes.includes(objects.get(o.objectId) ?? '') || credObligations.has(o.id);
      const obs = facts.obligations.filter((o) => !o.cancelled && match(o));
      const ids = new Set(obs.map((o) => o.id));
      const assessed = new CurrencyTotals(); const reconciled = new CurrencyTotals();
      obs.filter((o) => inRange(o.createdAt)).forEach((o) => assessed.add(o.amount));
      const recOrders = facts.orders.filter((o) => ids.has(o.obligationId) && isReconciled(o) && inRange(o.reconciledAt));
      recOrders.forEach((o) => reconciled.add(o.amount));
      const due = obs.filter((o) => !o.contested && o.dueDate <= today);
      const share = reconciled.toJSON().map((mny) => {
        const part = tutelle ? allocate(Money.fromJSON(mny), slices).find((p) => p.slice === 'TUTELLE')?.amount : undefined;
        return part ? part.toJSON() : Money.zero(mny.currency).toJSON();
      });
      return {
        moduleId: m.id, code: m.code, label: m.label, status: m.status, revenueScope: m.revenueScope,
        attachedSince: m.attachments.find((a) => a.entity === entity && !a.to)?.from ?? null,
        actReference: m.attachments.find((a) => a.entity === entity && !a.to)?.actReference ?? null,
        revenue: { assessed: assessed.toJSON(), reconciled: reconciled.toJSON(), payments: recOrders.length },
        performance: {
          obligations: obs.length, due: due.length, paid: due.filter((o) => !!o.paidAt).length,
          paymentRatePct: pctNum(due.filter((o) => !!o.paidAt).length, due.length),
          overdue: due.filter((o) => !o.paidAt && o.dueDate < today).length,
        },
        tutelleShare: share,
      };
    });
    const sumShare = new CurrencyTotals();
    rows.forEach((r) => r.tutelleShare.forEach((m) => sumShare.add(m)));
    const paid = new CurrencyTotals();
    const versements = this.versements.find((v) => v.entity === entity && (!q.period || v.period === q.period || v.period.startsWith(`${q.period}-`)));
    versements.filter((v) => v.status === 'CONSTATE').forEach((v) => paid.add(v.amount));
    const currencies = [...new Set([...sumShare.currencies(), ...paid.currencies()])] as CurrencyCode[];
    this.ctx.audit.append({ actor: actorOf(user), action: 'decision.ministry.viewed', resourceType: 'dashboard', resourceId: entity, details: { period: q.period ?? null, modules: rows.length } });
    return {
      entity, entityName: this.acces()?.entities?.get(entity)?.name ?? entity, period: q.period ?? null, generatedAt: facts.asOf, aggregatesOnly: true,
      rule: 'Filtrage strict sur le périmètre du ministère : modules rattachés par l’administrateur (§ 12A.3) ; le rattachement ne détermine aucune part de recettes (ARB-05) — la part de 10 % relève de la clé du § 37A.',
      modules: rows,
      share: {
        mode, keyStatus: key?.status ?? 'NON_CHARGEE', pct: tutelle?.pct ?? null,
        notice: mode === 'CALCUL' ? 'Calcul sur recettes rapprochées ; versement par le Trésor selon les procédures budgétaires.' : 'Simulation — clé du § 37A non active (acte juridique requis) ; pourcentage par défaut à confirmer par le maître d’ouvrage ; aucun décaissement.',
        byCurrency: currencies.map((c) => {
          const calc = sumShare.get(c) ?? Money.zero(c); const vers = paid.get(c) ?? Money.zero(c);
          return { currency: c, calculated: calc.toJSON(), reconciledBase: true, paid: vers.toJSON(), remaining: calc.subtract(vers).toJSON() };
        }),
        versements,
      },
      indicators: [
        { code: 'RECETTES_PAR_MODULE', label: 'Recettes rapprochées par module', measured: rows.length > 0, value: rows.length ? (() => { const t = new CurrencyTotals(); rows.forEach((r) => r.revenue.reconciled.forEach((m) => t.add(m))); return t.toJSON().map((m) => `${m.amount} ${m.currency}`).join(' · ') || '0'; })() : null, unit: '', byModule: rows.map((r) => ({ code: r.code, reconciled: r.revenue.reconciled })), ...(rows.length ? {} : { reason: 'Aucun module rattaché à ce ministère.' }) },
        { code: 'PART_VERSEE', label: 'Part de 10 % versée (constatée)', measured: versements.some((v) => v.status === 'CONSTATE'), value: paid.toJSON().map((m) => `${m.amount} ${m.currency}`).join(' · ') || null, unit: '', ...(versements.some((v) => v.status === 'CONSTATE') ? {} : { reason: 'Aucun versement constaté par le Trésor pour la période.' }) },
      ],
    };
  }

  /** Constat d'un versement de la part de tutelle (Trésor) : proposition, puis validation par une seconde personne. */
  proposeVersement(user: User, input: { entity: string; period: string; amount: MoneyJSON; reference: string; motif: string }) {
    authorize(user, 'decision:ministere.versement');
    const ent = this.acces()?.entities?.get(input.entity);
    if (this.acces()?.entities && (!ent || ent.kind !== 'MINISTERE')) throw badRequest('NOT_A_MINISTRY', `Entité ${input.entity} inconnue ou qui n’est pas un ministère.`);
    Money.parseStrict(input.amount);
    if (this.versements.findOne((v) => v.reference === input.reference && v.status !== 'REJETE')) throw conflict('DUPLICATE_REFERENCE', `Versement ${input.reference} déjà constaté ou proposé.`);
    const v = this.versements.insert({ id: this.ids.next('VERS'), ...input, status: 'PROPOSE', proposedBy: user.id, proposedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'decision.ministry.payment_proposed', resourceType: 'versement', resourceId: v.id, details: { entity: v.entity, period: v.period, amount: v.amount, reference: v.reference, motif: v.motif } });
    return v;
  }

  decideVersement(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'decision:ministere.versement');
    const v = this.versements.get(id);
    if (!v) throw notFound('VERSEMENT_NOT_FOUND', `Versement inconnu : ${id}`);
    if (v.status !== 'PROPOSE') throw conflict('ALREADY_DECIDED', 'Versement déjà décidé.');
    assertDistinctPerson(user.id, [v.proposedBy], 'Constat d’un versement : validé par une personne distincte de celle qui l’a saisi.');
    const out = this.versements.update({ ...v, status: input.approve ? 'CONSTATE' : 'REJETE', decision: { by: user.id, at: this.now(), approve: input.approve, motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'decision.ministry.payment_confirmed' : 'decision.ministry.payment_rejected', resourceType: 'versement', resourceId: id, details: { proposedBy: v.proposedBy, motif: input.motif, automaticEffect: 'AUCUN' } });
    if (input.approve) {
      const ministers = this.ctx.users.all().filter((u) => u.entity === v.entity && u.roles.includes('R04'));
      if (ministers.length) this.ctx.comms.publish('approval.approved', ministers.map(userRecipient), { objet: `Versement de la part de tutelle ${v.reference}` }, { entity: 'TRESOR' });
    }
    return out;
  }
}
