/**
 * Registre des exonérations et remises (module 57, § 12.6) :
 *   demande (contribuable ou agent) → instruction par un agent de régie (base légale OBLIGATOIRE, instrument
 *   du registre juridique en vigueur) → visa juridique (juriste) → décision (chef de service ou directeur).
 * Double validation par deux personnes distinctes entre elles et distinctes de l'initiateur ; effet daté,
 * jamais rétroactif sans décision expresse ; jamais décidée par l'IA (APPROVE_EXEMPTION est un interdit
 * constitutionnel). Une exonération approuvée s'applique à la liquidation et figure dans l'explication ;
 * une remise approuvée rectifie l'obligation visée par contre-écriture (jamais par modification directe).
 */
import { Money, type MoneyJSON, type RevenueCategory } from '@mosolo/shared';
import type { Principal, User } from '../../core/auth.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertAiMay, assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AssessmentAdjuster, AssessmentAdjustment } from '../../modules/assessment/service.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { actorOf, pctToBasis, type FiscalDeps } from './common.js';

export type ExemptionKind = 'EXONERATION' | 'REMISE';
export type ExemptionStatus = 'DEMANDEE' | 'INSTRUITE' | 'VISA_JURIDIQUE' | 'APPROUVEE' | 'REFUSEE' | 'REVOQUEE';

export interface LegalBasis { instrumentId: string; article: string; title: string; instrumentStatus: string; demo: boolean }

export interface ExemptionStep {
  step: 'INSTRUCTION' | 'VISA_JURIDIQUE' | 'DECISION' | 'REVOCATION';
  userId: string;
  roles: string[];
  decision: 'FAVORABLE' | 'DEFAVORABLE';
  reason: string;
  at: string;
}

export interface Exemption {
  id: string;
  kind: ExemptionKind;
  taxpayerId: string;
  objectId?: string;
  /** Portée d'une exonération : code de règle ou catégorie de recette. */
  ruleCode?: string;
  revenueCategory?: RevenueCategory;
  /** Remise : obligation visée et montant remis. */
  obligationId?: string;
  amount?: MoneyJSON;
  /** Exonération : pourcentage exonéré (100 = totale). */
  rate?: string;
  grounds: string;
  proofs: { type: string; reference: string }[];
  legalBasis?: LegalBasis;
  validFrom: string;
  validTo?: string;
  status: ExemptionStatus;
  requestedBy: string;
  requestedAt: string;
  steps: ExemptionStep[];
  retroactivity?: { decisionReference: string; reason: string };
  rectifiedObligationId?: string;
}

export class ExemptionService {
  readonly exemptions = new InMemoryRepository<Exemption>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps) {}

  get(id: string): Exemption {
    const x = this.exemptions.get(id);
    if (!x) throw notFound('EXEMPTION_NOT_FOUND', `Exonération inconnue : ${id}`);
    return x;
  }

  /** Statut effectif (une exonération approuvée dont la durée est échue est EXPIRÉE — échéance automatique). */
  effectiveStatus(x: Exemption): ExemptionStatus | 'EXPIREE' {
    if (x.status === 'APPROUVEE' && x.validTo && x.validTo < this.d.today()) return 'EXPIREE';
    return x.status;
  }

  /** Base légale : instrument du registre juridique, EN VIGUEUR, avec article cité. */
  private legalBasis(input: { instrumentId: string; article: string }): LegalBasis {
    const inst = this.d.ctx.rules.instrument(input.instrumentId);
    if (!inst) throw unprocessable('LEGAL_BASIS_UNKNOWN', `Instrument ${input.instrumentId} absent du registre juridique : aucune exonération sans base légale.`);
    if (inst.status !== 'EN_VIGUEUR') throw unprocessable('LEGAL_BASIS_NOT_IN_FORCE', `Instrument ${inst.id} au statut ${inst.status} : il ne peut fonder une exonération.`);
    if (!input.article.trim()) throw badRequest('ARTICLE_REQUIRED', 'L’article fondant l’exonération doit être cité.');
    return { instrumentId: inst.id, article: input.article.trim(), title: inst.title, instrumentStatus: inst.status, demo: inst.demo === true };
  }

  request(user: User, input: {
    taxpayerId?: string; kind: ExemptionKind; objectId?: string; ruleCode?: string; revenueCategory?: RevenueCategory;
    obligationId?: string; amount?: MoneyJSON; rate?: string; grounds: string; proofs: { type: string; reference: string }[];
    legalBasis?: { instrumentId: string; article: string }; validFrom: string; validTo?: string;
  }): Exemption {
    let taxpayerId = input.taxpayerId ?? (user.roles.includes('R30') ? user.taxpayerId : undefined);
    if (input.kind === 'REMISE') {
      if (!input.obligationId || !input.amount) throw badRequest('REMISE_FIELDS_REQUIRED', 'Une remise vise une obligation et un montant.');
      const ob = this.d.ctx.assessment.get(input.obligationId);
      taxpayerId = taxpayerId ?? ob.taxpayerId;
      if (ob.taxpayerId !== taxpayerId) throw unprocessable('OBLIGATION_TAXPAYER_MISMATCH', 'L’obligation visée n’appartient pas à ce contribuable.');
      if (!PAYABLE_STATUSES.includes(ob.status)) throw unprocessable('OBLIGATION_NOT_REMITTABLE', `Obligation au statut ${ob.status} : remise impossible.`);
      const amt = Money.fromJSON(input.amount);
      if (amt.currency !== ob.amount.currency) throw badRequest('CURRENCY_MISMATCH', `Montant attendu en ${ob.amount.currency}.`);
      if (amt.isZero() || amt.compare(Money.fromJSON(ob.amount)) > 0) throw unprocessable('REMISE_EXCEEDS_OBLIGATION', 'La remise doit être positive et au plus égale au montant de l’obligation.');
    } else {
      if (!input.rate) throw badRequest('RATE_REQUIRED', 'Pourcentage exonéré requis (100 = exonération totale).');
      pctToBasis(input.rate, 'taux d’exonération');
      if (!input.ruleCode && !input.revenueCategory) throw badRequest('SCOPE_REQUIRED', 'Portée requise : code de règle ou catégorie de recette.');
      if (!input.validTo) throw badRequest('DURATION_REQUIRED', 'Une exonération a toujours une durée (date de fin).');
      if (input.validTo < input.validFrom) throw badRequest('INVALID_PERIOD', 'La date de fin précède la date de début.');
    }
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable bénéficiaire requis.');
    const tp = this.d.ctx.taxpayers.get(taxpayerId);
    const communes = input.objectId ? [this.d.ctx.objects.get(input.objectId).commune] : [];
    if (input.objectId && this.d.ctx.objects.get(input.objectId).taxpayerId !== taxpayerId) throw unprocessable('OBJECT_TAXPAYER_MISMATCH', 'L’objet visé n’est pas rattaché à ce contribuable.');
    authorize(user, 'fiscal:exemption.request', { taxpayerId, communes });
    if (input.proofs.length === 0) throw unprocessable('PROOF_REQUIRED', 'Au moins une pièce justificative est requise.');
    const legalBasis = input.legalBasis ? this.legalBasis(input.legalBasis) : undefined;
    const x = this.exemptions.insert({
      id: this.ids.next(input.kind === 'REMISE' ? 'REM' : 'EXO'),
      kind: input.kind, taxpayerId,
      ...(input.objectId ? { objectId: input.objectId } : {}),
      ...(input.ruleCode ? { ruleCode: input.ruleCode } : {}),
      ...(input.revenueCategory ? { revenueCategory: input.revenueCategory } : {}),
      ...(input.obligationId ? { obligationId: input.obligationId } : {}),
      ...(input.amount ? { amount: Money.fromJSON(input.amount).toJSON() } : {}),
      ...(input.rate ? { rate: input.rate } : {}),
      grounds: input.grounds, proofs: input.proofs,
      ...(legalBasis ? { legalBasis } : {}),
      validFrom: input.validFrom, ...(input.validTo ? { validTo: input.validTo } : {}),
      status: 'DEMANDEE', requestedBy: user.id, requestedAt: this.d.nowIso(), steps: [],
    });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'exemption.requested', resourceType: 'exemption', resourceId: x.id, details: { kind: x.kind, taxpayerId, legalBasis: legalBasis?.instrumentId ?? null } });
    this.d.ctx.comms.publish('exemption.requested', [taxpayerRecipient(tp)], { reference: x.id }, { entity: 'DGIPK' });
    return x;
  }

  private participants(x: Exemption): string[] {
    return [x.requestedBy, ...x.steps.map((s) => s.userId)];
  }

  private step(user: User, x: Exemption, step: ExemptionStep['step'], decision: ExemptionStep['decision'], reason: string): ExemptionStep {
    if (!reason.trim()) throw badRequest('REASON_REQUIRED', 'Motif obligatoire.');
    return { step, userId: user.id, roles: user.roles, decision, reason: reason.trim(), at: this.d.nowIso() };
  }

  /** Instruction (agent de régie) : pièces vérifiées, base légale fixée — obligatoire. */
  instruct(user: User, id: string, input: { legalBasis?: { instrumentId: string; article: string }; decision: 'FAVORABLE' | 'DEFAVORABLE'; reason: string }): Exemption {
    const x = this.get(id);
    authorize(user, 'fiscal:exemption.instruct');
    if (x.status !== 'DEMANDEE') throw conflict('INVALID_EXEMPTION_STATE', `Demande au statut ${x.status}.`);
    const basis = input.legalBasis ? this.legalBasis(input.legalBasis) : x.legalBasis;
    if (input.decision === 'FAVORABLE' && !basis) throw unprocessable('LEGAL_BASIS_REQUIRED', 'Aucune exonération sans base légale : citez l’instrument du registre et l’article.');
    const s = this.step(user, x, 'INSTRUCTION', input.decision, input.reason);
    const updated = this.exemptions.update({ ...x, ...(basis ? { legalBasis: basis } : {}), status: input.decision === 'FAVORABLE' ? 'INSTRUITE' : 'REFUSEE', steps: [...x.steps, s] });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'exemption.instructed', resourceType: 'exemption', resourceId: id, details: { decision: input.decision, legalBasis: basis?.instrumentId ?? null } });
    if (updated.status === 'REFUSEE') this.notifyRefused(updated);
    return updated;
  }

  /** Visa juridique : un juriste vérifie le fondement ; personne distincte de l'initiateur et de l'instructeur. */
  legalVisa(user: User, id: string, input: { decision: 'FAVORABLE' | 'DEFAVORABLE'; reason: string }): Exemption {
    const x = this.get(id);
    authorize(user, 'fiscal:exemption.legal-visa');
    if (x.status !== 'INSTRUITE') throw conflict('INVALID_EXEMPTION_STATE', `Demande au statut ${x.status} : le visa juridique suit l’instruction.`);
    assertDistinctPerson(user.id, this.participants(x), 'Quatre yeux : le visa juridique est donné par une personne distincte de l’initiateur et de l’instructeur.');
    const s = this.step(user, x, 'VISA_JURIDIQUE', input.decision, input.reason);
    const updated = this.exemptions.update({ ...x, status: input.decision === 'FAVORABLE' ? 'VISA_JURIDIQUE' : 'REFUSEE', steps: [...x.steps, s] });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'exemption.legal_visa', resourceType: 'exemption', resourceId: id, details: { decision: input.decision } });
    if (updated.status === 'REFUSEE') this.notifyRefused(updated);
    return updated;
  }

  /**
   * Décision (chef de service / directeur), seconde validation. Jamais par l'IA. Effet daté : une date d'effet
   * antérieure à la décision exige une décision expresse de rétroactivité (référence + motif).
   */
  decide(principal: Principal, id: string, input: { decision: 'APPROUVEE' | 'REFUSEE'; reason: string; retroactivity?: { decisionReference: string; reason: string } }): Exemption {
    assertAiMay(principal, 'APPROVE_EXEMPTION');
    const user = principal as User;
    const x = this.get(id);
    authorize(user, 'fiscal:exemption.decide');
    if (x.status !== 'VISA_JURIDIQUE') throw conflict('INVALID_EXEMPTION_STATE', `Demande au statut ${x.status} : la décision suit le visa juridique.`);
    assertDistinctPerson(user.id, this.participants(x), 'Quatre yeux : la décision est prise par une personne distincte de l’initiateur, de l’instructeur et du juriste.');
    const today = this.d.today();
    const s = this.step(user, x, 'DECISION', input.decision === 'APPROUVEE' ? 'FAVORABLE' : 'DEFAVORABLE', input.reason);
    if (input.decision === 'REFUSEE') {
      const r = this.exemptions.update({ ...x, status: 'REFUSEE', steps: [...x.steps, s] });
      this.d.ctx.audit.append({ actor: actorOf(user), action: 'exemption.refused', resourceType: 'exemption', resourceId: id, details: { reason: input.reason } });
      this.notifyRefused(r);
      return r;
    }
    if (!x.legalBasis) throw unprocessable('LEGAL_BASIS_REQUIRED', 'Aucune exonération sans base légale.');
    if (x.validFrom < today && !input.retroactivity) {
      throw unprocessable('RETROACTIVITY_REQUIRES_DECISION', `Date d’effet ${x.validFrom} antérieure à la décision : une décision expresse de rétroactivité (référence et motif) est requise.`);
    }
    let approved = this.exemptions.update({ ...x, status: 'APPROUVEE', steps: [...x.steps, s], ...(input.retroactivity ? { retroactivity: input.retroactivity } : {}) });
    if (x.kind === 'REMISE' && x.obligationId && x.amount) {
      const ob = this.d.ctx.assessment.get(x.obligationId);
      if (!PAYABLE_STATUSES.includes(ob.status)) throw unprocessable('OBLIGATION_NOT_REMITTABLE', `Obligation au statut ${ob.status} : remise impossible.`);
      const remaining = Money.fromJSON(ob.amount).subtract(Money.fromJSON(x.amount));
      const rectified = this.d.ctx.assessment.rectify(ob.id, (remaining.isNegative() ? Money.zero(remaining.currency) : remaining).toJSON(), {
        appealId: x.id, reason: `Remise ${x.id} — ${x.legalBasis.title}, ${x.legalBasis.article}`, decidedBy: user, decisionType: 'REMISE',
      });
      approved = this.exemptions.update({ ...approved, rectifiedObligationId: rectified.id });
    }
    this.d.ctx.audit.append({
      actor: actorOf(user), action: 'exemption.granted', resourceType: 'exemption', resourceId: id,
      details: { kind: x.kind, legalBasis: x.legalBasis.instrumentId, article: x.legalBasis.article, validFrom: x.validFrom, validTo: x.validTo ?? null, approvers: this.participants(approved), retroactive: !!input.retroactivity },
    });
    this.d.ctx.comms.publish('exemption.granted', [taxpayerRecipient(this.d.ctx.taxpayers.get(x.taxpayerId))], { reference: x.id, date: x.validTo ?? x.validFrom }, { entity: 'DGIPK' });
    return approved;
  }

  /** Révocation motivée (effet à compter de la décision, jamais sur les liquidations passées). */
  revoke(user: User, id: string, reason: string): Exemption {
    const x = this.get(id);
    authorize(user, 'fiscal:exemption.revoke');
    if (x.status !== 'APPROUVEE') throw conflict('INVALID_EXEMPTION_STATE', `Exonération au statut ${x.status}.`);
    const s = this.step(user, x, 'REVOCATION', 'DEFAVORABLE', reason);
    const today = this.d.today();
    const r = this.exemptions.update({ ...x, status: 'REVOQUEE', steps: [...x.steps, s], validTo: x.validTo && x.validTo < today ? x.validTo : today });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'exemption.revoked', resourceType: 'exemption', resourceId: id, details: { reason } });
    return r;
  }

  private notifyRefused(x: Exemption): void {
    this.d.ctx.comms.publish('exemption.refused', [taxpayerRecipient(this.d.ctx.taxpayers.get(x.taxpayerId))], { reference: x.id }, { entity: 'DGIPK' });
  }

  /** Branchement sur le moteur de liquidation : exonérations approuvées, en vigueur à la date du calcul. */
  adjuster(): AssessmentAdjuster {
    return ({ taxpayerId, objectId, rule, at, gross }) => {
      const day = at.toISOString().slice(0, 10);
      const applicable = this.exemptions.find((x) =>
        x.kind === 'EXONERATION' && x.status === 'APPROUVEE' && x.taxpayerId === taxpayerId && !!x.legalBasis &&
        (!x.objectId || x.objectId === objectId) &&
        ((x.ruleCode && x.ruleCode === rule.code) || (!x.ruleCode && x.revenueCategory === rule.revenueCategory)) &&
        x.validFrom <= day && (!x.validTo || x.validTo >= day));
      let remaining = 10000;
      const out: AssessmentAdjustment[] = [];
      for (const x of applicable) {
        const b = Math.min(pctToBasis(x.rate!), remaining);
        if (b <= 0) break;
        remaining -= b;
        const rate = `${Math.floor(b / 100)}.${String(b % 100).padStart(2, '0')}`;
        out.push({
          kind: 'EXONERATION', sourceId: x.id, label: `Exonération ${x.id} (${x.rate} %)`,
          legalBasis: { instrumentId: x.legalBasis!.instrumentId, title: x.legalBasis!.title, article: x.legalBasis!.article },
          rate, reduction: gross.percent(rate).toJSON(), validFrom: x.validFrom, validTo: x.validTo ?? '',
          decidedBy: x.steps.filter((s) => s.step !== 'INSTRUCTION').map((s) => s.userId),
        });
      }
      return out;
    };
  }

  /**
   * Alerte de concentration (M57-S1) : un décideur ou une commune concentrant la majorité des exonérations
   * accordées. Proposition d'examen pour l'audit — aucune mesure automatique.
   */
  concentrationAlerts(): { dimension: 'DECIDEUR' | 'COMMUNE'; key: string; count: number; total: number; message: string }[] {
    const granted = this.exemptions.find((x) => x.status === 'APPROUVEE' || x.status === 'REVOQUEE');
    const total = granted.length;
    const out: { dimension: 'DECIDEUR' | 'COMMUNE'; key: string; count: number; total: number; message: string }[] = [];
    if (total < 3) return out;
    const tally = (dim: 'DECIDEUR' | 'COMMUNE', keyOf: (x: Exemption) => string | undefined) => {
      const m = new Map<string, number>();
      for (const x of granted) { const k = keyOf(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
      for (const [k, n] of m) if (n >= 3 && n * 2 > total) out.push({ dimension: dim, key: k, count: n, total, message: `${n} exonérations sur ${total} concentrées (${dim === 'DECIDEUR' ? 'même décideur' : 'même commune'}) : examen proposé à l’audit.` });
    };
    tally('DECIDEUR', (x) => x.steps.find((s) => s.step === 'DECISION')?.userId);
    tally('COMMUNE', (x) => (x.objectId ? this.d.ctx.objects.objects.get(x.objectId)?.commune : undefined));
    return out;
  }

  list(filter: { taxpayerId?: string; status?: string }): Exemption[] {
    return this.exemptions.find((x) => (!filter.taxpayerId || x.taxpayerId === filter.taxpayerId) && (!filter.status || x.status === filter.status));
  }
}
