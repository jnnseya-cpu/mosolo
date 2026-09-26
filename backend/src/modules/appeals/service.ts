/**
 * Réclamations (§ 22.2) : dépôt par le contribuable → instruction (R20) → décision par une autorité distincte (R21).
 * Une décision favorable crée une obligation RECTIFICATIVE ; l'originale est conservée (jamais supprimée).
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { PAYABLE_STATUSES, type AssessmentService } from '../assessment/service.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';

export type AppealDecision = 'ACCEPTEE' | 'PARTIELLEMENT_ACCEPTEE' | 'REJETEE';

export interface Appeal {
  id: string;
  obligationId: string;
  taxpayerId: string;
  grounds: string;
  requestedAmount?: MoneyJSON;
  status: 'DEPOSEE' | 'PROPOSITION' | AppealDecision;
  submittedBy: string;
  submittedAt: string;
  instructorId?: string;
  proposal?: { decision: AppealDecision; analysis: string; proposedAmount?: MoneyJSON; at: string };
  decision?: { decision: AppealDecision; reason: string; decidedBy: string; at: string; rectifiedAmount?: MoneyJSON };
  rectifyingObligationId?: string;
  previousObligationStatus: string;
}

export class AppealService {
  readonly appeals = new InMemoryRepository<Appeal>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly assessment: AssessmentService,
    private readonly taxpayers: TaxpayerService,
  ) {}

  get(id: string): Appeal {
    const a = this.appeals.get(id);
    if (!a) throw notFound('APPEAL_NOT_FOUND', `Réclamation inconnue : ${id}`);
    return a;
  }

  submit(user: User, input: { obligationId: string; grounds: string; requestedAmount?: MoneyJSON }): Appeal {
    const obligation = this.assessment.get(input.obligationId);
    authorize(user, 'appeal.submit', { taxpayerId: obligation.taxpayerId });
    if (this.appeals.findOne((a) => a.obligationId === obligation.id && (a.status === 'DEPOSEE' || a.status === 'PROPOSITION'))) {
      throw conflict('APPEAL_ALREADY_OPEN', 'Une réclamation est déjà en cours sur cette obligation.');
    }
    if (!PAYABLE_STATUSES.includes(obligation.status)) {
      throw unprocessable('OBLIGATION_NOT_APPEALABLE', `Obligation au statut ${obligation.status} : réclamation impossible par ce circuit.`);
    }
    if (input.requestedAmount && input.requestedAmount.currency !== obligation.amount.currency) {
      throw badRequest('CURRENCY_MISMATCH', `Montant demandé attendu en ${obligation.amount.currency}.`);
    }
    const appeal = this.appeals.insert({
      id: this.ids.next('REC'),
      obligationId: obligation.id,
      taxpayerId: obligation.taxpayerId,
      grounds: input.grounds,
      ...(input.requestedAmount ? { requestedAmount: Money.fromJSON(input.requestedAmount).toJSON() } : {}),
      status: 'DEPOSEE',
      submittedBy: user.id,
      submittedAt: this.clock.now().toISOString(),
      previousObligationStatus: obligation.status,
    });
    this.assessment.setStatus(obligation.id, 'CONTESTEE');
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'appeal.submitted', resourceType: 'appeal', resourceId: appeal.id, details: { obligationId: obligation.id } });
    this.comms.publish('appeal.submitted', [taxpayerRecipient(this.taxpayers.get(obligation.taxpayerId))], { reference: appeal.id }, { entity: 'CONTENTIEUX' });
    return appeal;
  }

  instruct(user: User, id: string, input: { proposal: AppealDecision; analysis: string; proposedAmount?: MoneyJSON }): Appeal {
    authorize(user, 'appeal.instruct');
    const appeal = this.get(id);
    if (appeal.status !== 'DEPOSEE') throw conflict('INVALID_APPEAL_STATE', `Réclamation au statut ${appeal.status}.`);
    const updated = this.appeals.update({
      ...appeal,
      status: 'PROPOSITION',
      instructorId: user.id,
      proposal: {
        decision: input.proposal, analysis: input.analysis, at: this.clock.now().toISOString(),
        ...(input.proposedAmount ? { proposedAmount: Money.fromJSON(input.proposedAmount).toJSON() } : {}),
      },
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'appeal.instructed', resourceType: 'appeal', resourceId: id, details: { proposal: input.proposal } });
    return updated;
  }

  decide(user: User, id: string, input: { decision: AppealDecision; reason: string; rectifiedAmount?: MoneyJSON }): Appeal {
    authorize(user, 'appeal.decide');
    const appeal = this.get(id);
    if (appeal.status === 'DEPOSEE') throw conflict('APPEAL_NOT_INSTRUCTED', 'La réclamation doit être instruite avant décision.');
    if (appeal.status !== 'PROPOSITION') throw conflict('INVALID_APPEAL_STATE', `Réclamation déjà décidée (${appeal.status}).`);
    assertDistinctPerson(user.id, appeal.instructorId ? [appeal.instructorId] : [], "L'autorité de décision doit être distincte de l'agent instructeur.");
    const obligation = this.assessment.get(appeal.obligationId);
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    const now = this.clock.now().toISOString();
    let rectifyingObligationId: string | undefined;
    let rectifiedAmount: MoneyJSON | undefined;

    if (input.decision === 'REJETEE') {
      this.assessment.setStatus(obligation.id, 'EMISE');
    } else {
      const original = Money.fromJSON(obligation.amount);
      let amount: Money;
      if (input.decision === 'ACCEPTEE') {
        amount = input.rectifiedAmount ? Money.fromJSON(input.rectifiedAmount) : Money.zero(original.currency);
      } else {
        if (!input.rectifiedAmount) throw badRequest('RECTIFIED_AMOUNT_REQUIRED', 'Montant rectifié obligatoire pour une acceptation partielle.');
        amount = Money.fromJSON(input.rectifiedAmount);
      }
      if (amount.currency !== original.currency) throw badRequest('CURRENCY_MISMATCH', `Montant rectifié attendu en ${original.currency}.`);
      if (amount.isNegative() || amount.compare(original) >= 0) {
        throw unprocessable('INVALID_RECTIFIED_AMOUNT', 'Le montant rectifié doit être positif et inférieur au montant initial.');
      }
      const rectified = this.assessment.rectify(obligation.id, amount.toJSON(), { appealId: appeal.id, reason: input.reason, decidedBy: user });
      rectifyingObligationId = rectified.id;
      rectifiedAmount = amount.toJSON();
    }
    const updated = this.appeals.update({
      ...appeal,
      status: input.decision,
      decision: { decision: input.decision, reason: input.reason, decidedBy: user.id, at: now, ...(rectifiedAmount ? { rectifiedAmount } : {}) },
      ...(rectifyingObligationId ? { rectifyingObligationId } : {}),
    });
    this.audit.append({ actor, action: 'appeal.decided', resourceType: 'appeal', resourceId: id, details: { decision: input.decision, rectifyingObligationId: rectifyingObligationId ?? null } });
    this.comms.publish('appeal.decided', [taxpayerRecipient(this.taxpayers.get(appeal.taxpayerId))], { reference: appeal.id }, { entity: 'CONTENTIEUX' });
    return updated;
  }
}
