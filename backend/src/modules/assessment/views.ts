import type { Access } from '../../core/policy.js';
import type { Obligation } from './service.js';

/** Vue d'une obligation selon le niveau d'accès : un accès minimal ne montre aucun montant. */
export function obligationSummary(o: Obligation, access: Access) {
  const base = {
    id: o.id, taxpayerId: o.taxpayerId, objectId: o.objectId, label: o.label, revenueCategory: o.revenueCategory,
    entity: o.entity, status: o.status, dueDate: o.dueDate, ruleCode: o.ruleCode, ruleVersion: o.ruleVersion,
    ...(o.supersedes ? { supersedes: o.supersedes } : {}), ...(o.supersededBy ? { supersededBy: o.supersededBy } : {}),
  };
  return access === 'full' ? { ...base, amount: o.amount, createdAt: o.createdAt, attribution: o.attribution } : { ...base, amount: null, masked: true };
}

export function obligationDetail(o: Obligation) {
  return {
    ...obligationSummary(o, 'full'),
    beneficiaryAccountAlias: o.beneficiaryAccountAlias,
    explanation: o.explanation,
    trace: o.trace,
    ...(o.appealId ? { appealId: o.appealId } : {}),
  };
}
