/**
 * Points de paiement agréés — clauses contractuelles (§ 37 « Clauses propres aux points de paiement », § 18A.2, § 25) :
 *  - commission contractuelle PAR POINT, distincte des recettes publiques, jamais prélevée sur le montant dû : calculée à
 *    part, sur les encaissements confirmés du point, aux conditions du contrat enregistré ;
 *  - pénalités de retard de versement vers le compte public : CALCULÉES sur chaque retard constaté (exception
 *    VERSEMENT_EN_RETARD du module canaux), PROPOSÉES par une personne, DÉCIDÉES par une autre (quatre yeux) ; aucune
 *    retenue ni prélèvement automatique.
 * Tant qu'aucun contrat n'est enregistré et validé pour un point : statut ACTE_REQUIS, aucun montant n'est calculé.
 * Aucun taux ni barème n'est fixé ici : toutes les valeurs viennent du contrat signé (empreinte de la pièce).
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, HOUR_MS } from '../../core/clock.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { CanauxService } from '../canaux/service.js';
import type { PaymentPoint } from '../canaux/model.js';

const { always } = GRANTS;
definePolicy('tresor:points.read', { R17: always, R18: always, R22: always, R23: always, R05: always });
definePolicy('tresor:points.contract', { R17: always });
definePolicy('tresor:points.penalty.propose', { R17: always, R18: always });
definePolicy('tresor:points.penalty.decide', { R17: always });

/** Décalage de Kinshasa (UTC+1) : fin du jour de caisse. */
const KIN_OFFSET_MS = HOUR_MS;

export interface PointContractTerms {
  /** Commission : pourcentage des encaissements du point, ou forfait par opération (devise du forfait). */
  commission: { basis: 'POURCENTAGE' | 'FORFAIT_PAR_OPERATION'; value: string; currency?: CurrencyCode };
  /** Pénalité de retard : pourcentage du montant versé en retard par jour, ou forfait par jour ; plafond facultatif (%). */
  penalty: { basis: 'POURCENTAGE_PAR_JOUR' | 'FORFAIT_PAR_JOUR'; value: string; currency?: CurrencyCode; capPct?: string };
}

export interface PointContract {
  id: string;
  pointId: string;
  reference: string;
  /** Empreinte SHA-256 du contrat signé (la pièce reste hors plateforme). */
  sha256: string;
  signedOn: string;
  terms: PointContractTerms;
  status: 'PROPOSE' | 'EN_VIGUEUR' | 'REJETE' | 'REMPLACE';
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionMotif?: string;
}

export interface LatePenalty {
  id: string;
  /** Clé : point et jour de caisse (une pénalité au plus par retard). */
  key: string;
  pointId: string;
  day: string;
  exceptionId: string;
  contractId: string;
  daysLate: number;
  base: MoneyJSON[];
  amounts: MoneyJSON[];
  computation: string;
  motif: string;
  status: 'PROPOSEE' | 'DECIDEE' | 'ECARTEE';
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionMotif?: string;
}

const isDecimal = (v: string) => /^\d{1,12}(\.\d{1,6})?$/.test(v);

export class PointContractsService {
  readonly contracts = new InMemoryRepository<PointContract>();
  readonly penalties = new InMemoryRepository<LatePenalty>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private canaux(): CanauxService | undefined {
    return this.ctx.ext.canaux as CanauxService | undefined;
  }
  private now(): string { return this.ctx.clock.now().toISOString(); }
  private point(id: string): PaymentPoint {
    const p = this.canaux()?.points.points.get(id);
    if (!p) throw notFound('PAYMENT_POINT_NOT_FOUND', `Point de paiement inconnu : ${id}`);
    return p;
  }
  inForce(pointId: string): PointContract | undefined {
    return this.contracts.findOne((c) => c.pointId === pointId && c.status === 'EN_VIGUEUR');
  }

  /** Enregistrement d'un contrat (proposition) : conditions saisies depuis le contrat signé, empreinte obligatoire. */
  proposeContract(user: User, pointId: string, input: { reference: string; sha256: string; signedOn: string; terms: PointContractTerms }): PointContract {
    authorize(user, 'tresor:points.contract');
    this.point(pointId);
    const t = input.terms;
    if (!isDecimal(t.commission.value) || !isDecimal(t.penalty.value) || (t.penalty.capPct !== undefined && !isDecimal(t.penalty.capPct))) throw unprocessable('INVALID_TERMS', 'Valeurs contractuelles décimales positives attendues.');
    if (t.commission.basis === 'FORFAIT_PAR_OPERATION' && !t.commission.currency) throw unprocessable('CURRENCY_REQUIRED', 'Forfait par opération : devise requise.');
    if (t.penalty.basis === 'FORFAIT_PAR_JOUR' && !t.penalty.currency) throw unprocessable('CURRENCY_REQUIRED', 'Forfait par jour : devise requise.');
    if (this.contracts.findOne((c) => c.pointId === pointId && c.status === 'PROPOSE')) throw conflict('CONTRACT_ALREADY_PROPOSED', 'Un contrat attend déjà validation pour ce point.');
    const c = this.contracts.insert({ id: this.ids.next('CPT'), pointId, reference: input.reference, sha256: input.sha256, signedOn: input.signedOn, terms: t, status: 'PROPOSE', proposedBy: user.id, proposedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'tresor.point_contract.proposed', resourceType: 'point_contract', resourceId: c.id, details: { pointId, reference: c.reference, sha256: c.sha256, terms: t } });
    return c;
  }

  /** Validation par une seconde personne du Trésor (quatre yeux) : le contrat précédent est remplacé, jamais effacé. */
  decideContract(user: User, id: string, input: { approve: boolean; motif: string }): PointContract {
    authorize(user, 'tresor:points.contract');
    const c = this.contracts.get(id);
    if (!c) throw notFound('CONTRACT_NOT_FOUND', `Contrat inconnu : ${id}`);
    if (c.status !== 'PROPOSE') throw conflict('CONTRACT_ALREADY_DECIDED', `Contrat ${id} déjà ${c.status}.`);
    assertDistinctPerson(user.id, [c.proposedBy], 'Quatre yeux : le contrat est validé par une autre personne que celle qui l’a saisi.');
    const at = this.now();
    if (input.approve) {
      const prev = this.inForce(c.pointId);
      if (prev) this.contracts.update({ ...prev, status: 'REMPLACE' });
    }
    const r = this.contracts.update({ ...c, status: input.approve ? 'EN_VIGUEUR' : 'REJETE', decidedBy: user.id, decidedAt: at, decisionMotif: input.motif });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'tresor.point_contract.validated' : 'tresor.point_contract.rejected', resourceType: 'point_contract', resourceId: id, details: { proposedBy: c.proposedBy, pointId: c.pointId, motif: input.motif } });
    return r;
  }

  /** Relevé de commission d'un point sur un mois (AAAA-MM) : calcul distinct des recettes, jamais déduit du montant dû. */
  commission(user: User, pointId: string, month: string) {
    authorize(user, 'tresor:points.read');
    const p = this.point(pointId);
    const contract = this.inForce(pointId);
    const cols = this.canaux()!.points.collections.find((c) => c.pointId === pointId && c.cashDay.startsWith(month));
    const byCur = new Map<string, Money>();
    for (const c of cols) byCur.set(c.amount.currency, (byCur.get(c.amount.currency) ?? Money.zero(c.amount.currency as CurrencyCode)).add(Money.fromJSON(c.amount)));
    const collected = [...byCur.values()].map((m) => m.toJSON());
    const base = { pointId, pointName: p.name, operator: p.operator, month, operations: cols.length, collected, notice: 'Commission contractuelle distincte des recettes publiques : jamais prélevée sur le montant dû par le contribuable ; réglée selon le contrat, hors du compte public de recettes.' };
    if (!contract) return { ...base, status: 'ACTE_REQUIS' as const, detail: 'Aucun contrat enregistré et validé pour ce point : commission non calculable (acte requis).', commission: [] as MoneyJSON[] };
    const t = contract.terms.commission;
    const commission = t.basis === 'POURCENTAGE'
      ? [...byCur.values()].map((m) => m.percent(t.value).toJSON())
      : [Money.fromJSON({ amount: t.value, currency: t.currency! }).multiply(String(cols.length)).toJSON()];
    return { ...base, status: 'CALCULEE' as const, contract: { id: contract.id, reference: contract.reference, sha256: contract.sha256 }, terms: t, commission };
  }

  private deadline(p: PaymentPoint, day: string): number {
    return new Date(`${day}T00:00:00.000Z`).getTime() + DAY_MS - KIN_OFFSET_MS + p.settlementDelayHours * HOUR_MS;
  }

  /** Retards de versement constatés (exceptions VERSEMENT_EN_RETARD) et pénalité calculée selon le contrat du point. */
  lateComputations(user: User, pointId?: string) {
    authorize(user, 'tresor:points.read');
    const pts = this.canaux()?.points;
    if (!pts) return [];
    return pts.exceptions.find((e) => e.type === 'VERSEMENT_EN_RETARD' && (!pointId || e.pointId === pointId)).map((e) => {
      const p = pts.points.get(e.pointId)!;
      const cd = pts.cashDays.findOne((c) => c.pointId === e.pointId && c.day === e.day);
      const done = cd?.deposit?.bankMatch?.valueDate ? new Date(`${cd.deposit.bankMatch.valueDate}T12:00:00.000Z`).getTime()
        : cd?.deposit?.depositedAt ? new Date(cd.deposit.depositedAt).getTime() : this.ctx.clock.now().getTime();
      const daysLate = Math.max(1, Math.ceil((done - this.deadline(p, e.day)) / DAY_MS));
      const contract = this.inForce(e.pointId);
      const key = `${e.pointId}:${e.day}`;
      const existing = this.penalties.findOne((x) => x.key === key && x.status !== 'ECARTEE');
      const view = { key, pointId: e.pointId, pointName: p.name, day: e.day, exceptionId: e.id, daysLate, base: e.expected, ongoing: !cd?.deposit, penaltyId: existing?.id ?? null, penaltyStatus: existing?.status ?? null };
      if (!contract) return { ...view, status: 'ACTE_REQUIS' as const, amounts: [] as MoneyJSON[], computation: 'Aucun contrat en vigueur : pénalité non calculable (acte requis).' };
      const { amounts, computation } = this.compute(contract, e.expected, daysLate);
      return { ...view, status: 'CALCULEE' as const, contractId: contract.id, amounts, computation };
    });
  }

  private compute(contract: PointContract, base: MoneyJSON[], daysLate: number): { amounts: MoneyJSON[]; computation: string } {
    const t = contract.terms.penalty;
    if (t.basis === 'FORFAIT_PAR_JOUR') {
      return { amounts: [Money.fromJSON({ amount: t.value, currency: t.currency! }).multiply(String(daysLate)).toJSON()], computation: `${t.value} ${t.currency} × ${daysLate} jour(s) (contrat ${contract.reference}).` };
    }
    const pct = (Number(t.value) * daysLate).toFixed(6);
    const capped = t.capPct !== undefined && Number(pct) > Number(t.capPct) ? t.capPct : pct;
    return {
      amounts: base.map((m) => Money.fromJSON(m).percent(capped).toJSON()),
      computation: `${t.value} % × ${daysLate} jour(s) = ${Number(pct)} %${capped !== pct ? `, plafonné à ${t.capPct} %` : ''} du montant attendu (contrat ${contract.reference}).`,
    };
  }

  /** Proposition de pénalité sur un retard constaté (calcul du système, décision humaine ensuite). */
  proposePenalty(user: User, input: { pointId: string; day: string; motif: string }): LatePenalty {
    authorize(user, 'tresor:points.penalty.propose');
    const row = this.lateComputations(user, input.pointId).find((r) => r.day === input.day);
    if (!row) throw notFound('LATE_SETTLEMENT_NOT_FOUND', `Aucun retard de versement constaté pour ${input.pointId} le ${input.day}.`);
    if (row.status !== 'CALCULEE') throw unprocessable('CONTRACT_REQUIRED', row.computation);
    if (row.penaltyId) throw conflict('PENALTY_ALREADY_PROPOSED', `Pénalité ${row.penaltyId} déjà enregistrée pour ce retard.`);
    const p = this.penalties.insert({
      id: this.ids.next('PEN-PT'), key: row.key, pointId: row.pointId, day: row.day, exceptionId: row.exceptionId, contractId: row.contractId!, daysLate: row.daysLate,
      base: row.base, amounts: row.amounts, computation: row.computation, motif: input.motif, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'tresor.point_penalty.proposed', resourceType: 'point_penalty', resourceId: p.id, details: { pointId: p.pointId, day: p.day, amounts: p.amounts, daysLate: p.daysLate } });
    return p;
  }

  /** Décision motivée par une autre personne du Trésor : pénalité retenue (recouvrée selon le contrat) ou écartée. */
  decidePenalty(user: User, id: string, input: { approve: boolean; motif: string }): LatePenalty {
    authorize(user, 'tresor:points.penalty.decide');
    const p = this.penalties.get(id);
    if (!p) throw notFound('PENALTY_NOT_FOUND', `Pénalité inconnue : ${id}`);
    if (p.status !== 'PROPOSEE') throw conflict('PENALTY_ALREADY_DECIDED', `Pénalité ${id} déjà ${p.status}.`);
    assertDistinctPerson(user.id, [p.proposedBy], 'Quatre yeux : la pénalité est décidée par une autre personne que celle qui l’a proposée.');
    const r = this.penalties.update({ ...p, status: input.approve ? 'DECIDEE' : 'ECARTEE', decidedBy: user.id, decidedAt: this.now(), decisionMotif: input.motif });
    this.ctx.audit.append({ actor: actorOf(user), action: 'tresor.point_penalty.decided', resourceType: 'point_penalty', resourceId: id, details: { proposedBy: p.proposedBy, decision: r.status, motif: input.motif, amounts: p.amounts } });
    return r;
  }

  board(user: User) {
    authorize(user, 'tresor:points.read');
    const pts = this.canaux()?.points.points.all() ?? [];
    return {
      points: pts.map((p) => {
        const c = this.inForce(p.id);
        return { pointId: p.id, name: p.name, operator: p.operator, commune: p.commune, status: p.status, settlementDelayHours: p.settlementDelayHours, contract: c ?? null, contractStatus: c ? 'EN_VIGUEUR' : 'ACTE_REQUIS', pending: this.contracts.findOne((x) => x.pointId === p.id && x.status === 'PROPOSE') ?? null };
      }),
      late: this.lateComputations(user),
      penalties: this.penalties.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      notice: 'Commission et pénalités selon le contrat signé de chaque point (acte requis tant qu’aucun contrat n’est enregistré). Le système calcule et propose ; une personne du Trésor décide. Aucun prélèvement automatique.',
    };
  }
}
