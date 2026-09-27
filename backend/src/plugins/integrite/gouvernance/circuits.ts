/**
 * Catalogue des circuits à « quatre yeux » (proposition par une personne, décision par une autre) et reconstitution
 * des décisions à deux personnes depuis le journal d'audit chaîné — LECTURE SEULE : aucun service métier n'est
 * appelé ni modifié. Chaque circuit décrit les actions d'audit de proposition, d'approbation et de refus, la clé qui
 * relie la décision à sa proposition et, le cas échéant, la route HTTP de décision (garde de rotation facultative).
 *
 * Un circuit dont la proposition est émise par le système (ex. proposition automatique de suspension d'un point de
 * paiement) n'est pas un circuit à deux personnes : il n'est pas retenu.
 */
import type { AuditRecord } from '../../../core/audit.js';

export type DecisionOutcome = 'APPROUVE' | 'REFUSE';

export interface CircuitGuard {
  /** Motif de route Fastify (tel que déclaré : `req.routeOptions.url`). */
  url: string;
  /** Clé de la proposition à partir des paramètres de la route. */
  key: (params: Record<string, string>) => string;
  /** Vrai si le corps de la requête exprime un REFUS (jamais bloqué par la rotation). */
  refusal?: (body: Record<string, unknown>) => boolean;
}

export interface Circuit {
  code: string;
  label: string;
  proposals: string[];
  approvals: string[];
  refusals: string[];
  /** Clé reliant proposition et décision (défaut : identifiant de la ressource). */
  key?: (e: AuditRecord) => string | null;
  /** Issue d'une action « décidée » générique (défaut : selon la liste où figure l'action). */
  outcome?: (e: AuditRecord) => DecisionOutcome | null;
  guard?: CircuitGuard;
}

const detail = (name: string) => (e: AuditRecord): string | null => {
  const v = e.details[name];
  return typeof v === 'string' && v ? v : null;
};
const decisionIn = (approved: string[]) => (e: AuditRecord): DecisionOutcome | null => {
  const d = e.details.decision;
  if (typeof d !== 'string') return null;
  return approved.includes(d) ? 'APPROUVE' : 'REFUSE';
};
const approveFalse = (b: Record<string, unknown>) => b.approve === false;
const decisionRejected = (b: Record<string, unknown>) => b.decision === 'REJETEE';

export const CIRCUITS: Circuit[] = [
  {
    code: 'TRESOR_OPERATION', label: 'Opérations financières du Trésor (contrepassation, remboursement, suspens…)',
    proposals: ['treasury.operation.proposed'],
    approvals: ['treasury.operation.approval_recorded', 'treasury.operation.executed'], refusals: ['treasury.operation.rejected'],
    guard: { url: '/v1/tresor/operations/:id/approve', key: (p) => p.id! },
  },
  {
    code: 'TRESOR_DEROGATION_CLOTURE', label: 'Dérogation à la clôture quotidienne',
    proposals: ['ledger.day_close_waiver.requested'], approvals: ['ledger.day_close_waiver.approved'], refusals: [],
    guard: { url: '/v1/tresor/closures/daily/waivers/:id/approve', key: (p) => p.id! },
  },
  {
    code: 'TRESOR_EXCEPTION', label: 'Résolution d’une exception de rapprochement',
    proposals: ['reconciliation.exception.resolution_proposed'],
    approvals: ['reconciliation.exception.resolved', 'reconciliation.exception.classified'], refusals: ['reconciliation.exception.resolution_rejected'],
    guard: { url: '/v1/tresor/exceptions/:id/resolution/approve', key: (p) => p.id! },
  },
  {
    code: 'CANAUX_CONSTAT_BANCAIRE', label: 'Constatation au relevé bancaire d’un versement de point agréé',
    proposals: ['canaux.point.deposit_match_proposed'], approvals: ['canaux.point.deposit_confirmed'], refusals: [],
    guard: { url: '/v1/payment-points/:id/cash-days/:day/bank-match/approve', key: (p) => `${p.id}:${p.day}` },
  },
  {
    code: 'CANAUX_RETABLISSEMENT', label: 'Rétablissement d’un point de paiement suspendu',
    proposals: ['canaux.point.reinstatement_requested'], approvals: ['canaux.point.reinstated'], refusals: ['canaux.point.reinstatement_rejected'],
    guard: { url: '/v1/payment-points/:id/reinstatement-request/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'CANAUX_ECARTEMENT_SUSPENSION', label: 'Écartement d’une proposition de suspension de point',
    proposals: ['canaux.point.suspension_dismissal_requested'], approvals: ['canaux.point.suspension_dismissed'], refusals: ['canaux.point.suspension_dismissal_rejected'],
    key: detail('proposalId'),
    guard: { url: '/v1/payment-point-proposals/:id/dismissal-request/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'BASE_DEROGATION', label: 'Dérogation à la base de liquidation',
    proposals: ['assessment.base_override.requested'], approvals: ['assessment.base_override.approved'], refusals: ['assessment.base_override.rejected'],
    guard: { url: '/v1/assessments/base-overrides/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'OBJET_CORRECTION', label: 'Correction d’un objet fiscal',
    proposals: ['object.correction.proposed'], approvals: ['object.correction.applied'], refusals: ['object.correction.rejected'],
    key: detail('correctionId'),
    guard: { url: '/v1/fiscal/object-corrections/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'REGLE_SUSPENSION', label: 'Suspension ou levée de suspension d’une règle',
    proposals: ['rule.suspension.proposed', 'rule.suspension.lift_proposed'],
    approvals: ['rule.suspended', 'rule.suspension.lifted'], refusals: ['rule.suspension.change_rejected'],
    guard: { url: '/v1/legal-rules/:id/suspension-change/decide', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'RECOUVREMENT_REMISE', label: 'Remise gracieuse (instruction → décision)',
    proposals: ['recovery.remission.requested', 'recovery.remission.instructed'],
    approvals: ['recovery.remission.granted'], refusals: ['recovery.remission.refused'],
    key: detail('remissionId'),
    guard: { url: '/v1/recouvrement/remises/:id/decision', key: (p) => p.id!, refusal: (b) => b.granted === false },
  },
  {
    code: 'RECOUVREMENT_NON_VALEUR', label: 'Admission en non-valeur',
    proposals: ['recovery.write_off.proposed'], approvals: ['recovery.write_off.decided'], refusals: [],
    key: detail('writeOffId'), outcome: decisionIn(['ADMISE']),
    guard: { url: '/v1/recouvrement/non-valeurs/:id/decision', key: (p) => p.id!, refusal: decisionRejected },
  },
  {
    code: 'RECOUVREMENT_PENALITE', label: 'Pénalité de recouvrement',
    proposals: ['recovery.penalty.proposed'], approvals: ['recovery.penalty.decided'], refusals: [],
    key: detail('penaltyId'), outcome: decisionIn(['APPROUVEE']),
    guard: { url: '/v1/recouvrement/penalites/:id/decision', key: (p) => p.id!, refusal: decisionRejected },
  },
  {
    code: 'RECOUVREMENT_PROPOSITION', label: 'Proposition d’étape de recouvrement',
    proposals: ['recovery.proposal.created'], approvals: ['recovery.proposal.decided'], refusals: [],
    key: detail('proposalId'), outcome: decisionIn(['APPROUVEE']),
    guard: { url: '/v1/recouvrement/propositions/:id/decision', key: (p) => p.id!, refusal: decisionRejected },
  },
  {
    code: 'RECOUVREMENT_REPRISE', label: 'Reprise d’arriérés',
    proposals: ['recovery.takeover.proposed'], approvals: ['recovery.takeover.decided'], refusals: [],
    outcome: decisionIn(['VALIDEE']),
  },
  {
    code: 'COFFRE_BENEFICIAIRE', label: 'Changement de compte bénéficiaire (coffre)',
    proposals: ['beneficiary.change.proposed'], approvals: ['beneficiary.change.approved'], refusals: ['beneficiary.change.vetoed'],
    guard: { url: '/v1/beneficiary-accounts/change-requests/:id/approve', key: (p) => p.id! },
  },
  {
    code: 'COMMISSION_VALIDATION', label: 'Validation d’une commission d’agent avant versement',
    proposals: ['agents.commission.validation_requested'], approvals: ['agents.commission.validated'], refusals: ['agents.commission.validation_refused'],
    guard: { url: '/v1/agents/commission-validations/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'REPARTITION_ACTIVATION', label: 'Activation de la clé de répartition des recettes (§ 37A)',
    proposals: ['repartition.key.activation_proposed'], approvals: ['repartition.key.activated'], refusals: ['repartition.key.activation_rejected'],
    guard: { url: '/v1/pilotage/repartition/cles/:id/activation/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'RAKAPAY_AGREMENT_OPERATEUR', label: 'Agrément d’un opérateur de billetterie RakaPay',
    proposals: ['rakapay.operator.approval_proposed'], approvals: ['rakapay.operator.approved'], refusals: ['rakapay.operator.refused'],
  },
  {
    code: 'RAKAPAY_OFFRE', label: 'Approbation d’une offre proposée par un opérateur RakaPay',
    proposals: ['rakapay.offer.proposed'], approvals: ['rakapay.offer.approved'], refusals: ['rakapay.offer.refused'],
  },
  {
    code: 'SECTEURS_RAPPROCHEMENT', label: 'Déclaration sectorielle rapprochée puis décidée (volumes, carrières, produits forestiers)',
    proposals: ['verticales.sector.reconciled'], approvals: ['verticales.sector.decided'], refusals: [],
    outcome: decisionIn(['VALIDER']),
  },
  {
    code: 'POINT_JURIDIQUE', label: 'Point juridique tranché sur acte (J1–J30)',
    proposals: ['juridique.point.decision_proposed'], approvals: ['juridique.point.tranche'], refusals: ['juridique.point.decision_rejected'],
    guard: { url: '/v1/juridique/points/:code/decision', key: (p) => (p.code ?? '').toUpperCase(), refusal: approveFalse },
  },
  {
    code: 'PURGE_CONSERVATION', label: 'Purge des données à l’échéance de conservation',
    proposals: ['privacy.purge.proposed'], approvals: ['privacy.purge.executed'], refusals: ['privacy.purge.rejected'],
    guard: { url: '/v1/juridique/donnees/purges/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'APPRENTISSAGE_PUBLICATION', label: 'Publication d’un contenu d’apprentissage (fiche d’aide, module) — § 24',
    proposals: ['apprentissage.contenu.publication_proposee'], approvals: ['apprentissage.contenu.publie'], refusals: ['apprentissage.contenu.publication_refusee'],
    guard: { url: '/v1/apprentissage/contenus/:id/publication/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'REGISTRE_SEUILS', label: 'Registre des seuils anti-fraude (confirmation ou modification)',
    proposals: ['integrite.threshold.change_proposed'], approvals: ['integrite.threshold.change_approved'], refusals: ['integrite.threshold.change_rejected'],
  },
  // Fiscalité, identité et campagnes (§ 16.4, § 10A.3, § 7.5, § 9.3, § 45, § 6.2).
  {
    code: 'FISCAL_PROTOCOLE_DONNEES', label: 'Activation d’un protocole d’échange de données (anomalies locatives)',
    proposals: ['fiscal.data_protocol.proposed'], approvals: ['fiscal.data_protocol.activated'], refusals: ['fiscal.data_protocol.rejected'],
  },
  {
    code: 'FISCAL_DEPENDANCE_ACTIVATION', label: 'Activation (ou retour en mode informatif) d’une dépendance entre services',
    proposals: ['fiscal.dependency.change_proposed'], approvals: ['fiscal.dependency.activated'], refusals: ['fiscal.dependency.change_rejected'],
  },
  {
    code: 'FISCAL_IMPORT_LOT', label: 'Intégration d’un lot repris (e-DGRK, données existantes)',
    proposals: ['fiscal.import.uploaded'], approvals: ['fiscal.import.committed'], refusals: [],
  },
  {
    code: 'ENROLEMENT_RECUPERATION', label: 'Récupération de compte (vérification au guichet, approbation)',
    proposals: ['enrolement.recovery.verified'], approvals: ['enrolement.recovery.approved'], refusals: ['enrolement.recovery.rejected'],
  },
  {
    code: 'CAMPAGNE_LANCEMENT', label: 'Lancement d’une campagne de déclaration',
    proposals: ['campaign.launch.proposed'], approvals: ['campaign.launched'], refusals: ['campaign.launch.rejected'],
  },
  {
    code: 'REGLE_PROROGATION', label: 'Prorogation d’échéance enregistrée sur une fiche de règle',
    proposals: ['rule.due_extension.proposed'], approvals: ['rule.due_extension.recorded'], refusals: ['rule.due_extension.rejected'],
  },
  {
    code: 'ACCES_ELEVATION', label: 'Élévation d’accès privilégié juste-à-temps (demande motivée → approbation sécurité)',
    proposals: ['acces.elevation.requested'], approvals: ['acces.elevation.approved'], refusals: ['acces.elevation.refused'],
    guard: { url: '/v1/acces/elevations/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'SOCLE_EXTRACTION_MASSIVE', label: 'Extraction massive de données (demandeur → responsable des données → comité des données)',
    proposals: ['socle.export.bulk_requested'], approvals: ['socle.export.bulk_data_owner_signed', 'socle.export.bulk_approved'], refusals: ['socle.export.bulk_refused'],
  },
  {
    code: 'PILOTAGE_BASE_REFERENCE', label: 'Certification de la base de référence ou d’un relevé de coûts (§ 38.1)',
    proposals: ['pilotage.baseline.imported'], approvals: ['pilotage.baseline.certified'], refusals: ['pilotage.baseline.rejected'],
    guard: { url: '/v1/pilotage/base-reference/:id/certification', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'PILOTAGE_ASSIGNATIONS', label: 'Certification des assignations budgétaires (§ 26.1)',
    proposals: ['pilotage.targets.imported'], approvals: ['pilotage.targets.certified'], refusals: ['pilotage.targets.rejected'],
    guard: { url: '/v1/pilotage/assignations/:id/certification', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'IA_MODELE_MISE_EN_SERVICE', label: 'Mise en service d’une version de modèle d’IA (§ 23.1)',
    proposals: ['ia.model.promotion_proposed'], approvals: ['ia.model.promoted'], refusals: ['ia.model.promotion_rejected'],
    key: detail('versionKey'),
  },
  // Circuits ajoutés par le lot trésorerie / recouvrement / CALCU / détecteurs (§ 15A.7, § 20.1, § 21.2, § 27A.5, § 37).
  {
    code: 'TRESOR_APPARIEMENT', label: 'Rapprochement proposé (sous le seuil d’appariement exact)',
    proposals: ['reconciliation.match.proposed'], approvals: ['reconciliation.match.confirmed'], refusals: ['reconciliation.match.rejected'],
    guard: { url: '/v1/tresor/appariements/propositions/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'TRESOR_CONTRAT_POINT', label: 'Contrat d’un point de paiement agréé (commission et pénalités)',
    proposals: ['tresor.point_contract.proposed'], approvals: ['tresor.point_contract.validated'], refusals: ['tresor.point_contract.rejected'],
    guard: { url: '/v1/tresor/points/contrats/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'TRESOR_PENALITE_POINT', label: 'Pénalité de retard de versement d’un point agréé',
    proposals: ['tresor.point_penalty.proposed'], approvals: ['tresor.point_penalty.decided'], refusals: [],
    outcome: decisionIn(['DECIDEE']),
    guard: { url: '/v1/tresor/points/penalites/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'TERRAIN_RECUPERATION', label: 'Récupération des sommes versées à un sous-traitant (objets fictifs, constats frauduleux)',
    proposals: ['terrain.clawback.proposed'], approvals: ['terrain.clawback.approved'], refusals: ['terrain.clawback.rejected'],
    key: detail('clawbackId'),
    guard: { url: '/v1/terrain/recuperations/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'RECOUVREMENT_GARANTIE', label: 'Garantie d’un grand débiteur',
    proposals: ['recovery.guarantee.proposed'], approvals: ['recovery.guarantee.decided'], refusals: [],
    key: detail('guaranteeId'), outcome: decisionIn(['VALIDEE']),
    guard: { url: '/v1/recouvrement/garanties/:id/decision', key: (p) => p.id!, refusal: (b) => b.decision === 'REJETEE' },
  },
  {
    code: 'CALCU_TRANSMISSION_JUSTICE', label: 'CALCU — transmission d’un dossier à la justice',
    proposals: ['calcu.referral.proposed'], approvals: ['calcu.referral.transmitted'], refusals: ['calcu.referral.rejected'],
    key: detail('referralId'),
    guard: { url: '/v1/verticales/calcu/transmissions/:id/decision', key: (p) => p.id!, refusal: approveFalse },
  },
  {
    code: 'CALCU_FOURNISSEUR', label: 'CALCU — validation d’un fournisseur enregistré',
    proposals: ['calcu.supplier.declared'], approvals: ['calcu.supplier.validated'], refusals: [],
    guard: { url: '/v1/verticales/calcu/fournisseurs/:id/validation', key: (p) => p.id! },
  },
  {
    code: 'CALCU_LIGNE_BUDGETAIRE', label: 'CALCU — validation d’une ligne budgétaire',
    proposals: ['calcu.budget_line.declared'], approvals: ['calcu.budget_line.validated'], refusals: [],
    guard: { url: '/v1/verticales/calcu/lignes-budgetaires/:id/validation', key: (p) => p.id! },
  },
  // Document maître FR 2, ch. 48 : décisions du Gouvernement provincial (enregistrement → validation par une autre personne).
  {
    code: 'DECISION_GOUVERNEMENT', label: 'Décision du Gouvernement provincial enregistrée sur acte (ch. 48)',
    proposals: ['programme.decision.recorded'], approvals: ['programme.decision.validated'], refusals: ['programme.decision.rejected'],
    guard: { url: '/v1/pilotage/programme/decisions/:numero/validation', key: (p) => `D${p.numero ?? ''}`, refusal: approveFalse },
  },
];

export interface TwoPersonDecision {
  circuit: string;
  circuitLabel: string;
  key: string;
  proposerId: string;
  approverId: string;
  proposedAt: string | null;
  decidedAt: string;
  /** Délai entre proposition et décision (secondes), si la proposition figure au journal. */
  delaySeconds: number | null;
  outcome: DecisionOutcome;
  auditId: string;
}

interface Pending { actorId: string; kind: string; at: string }

const byAction = new Map<string, { circuit: Circuit; role: 'P' | 'A' | 'R' }>();
for (const c of CIRCUITS) {
  for (const a of c.proposals) byAction.set(a, { circuit: c, role: 'P' });
  for (const a of c.approvals) byAction.set(a, { circuit: c, role: 'A' });
  for (const a of c.refusals) byAction.set(a, { circuit: c, role: 'R' });
}

const keyOf = (c: Circuit, e: AuditRecord): string | null => (c.key ? c.key(e) : e.resourceId);

/**
 * Reconstitue les décisions à deux personnes (ordre chronologique du journal) et les propositions encore en attente.
 * Le proposant est celui que la décision cite (`proposedBy`, `requestedBy`) ou, à défaut, l'auteur de la dernière
 * proposition portant la même clé. Seules les décisions d'un utilisateur humain SUR la proposition d'un utilisateur
 * humain sont retenues.
 */
export function reconstruct(records: AuditRecord[]): { decisions: TwoPersonDecision[]; pending: Map<string, Pending> } {
  const pending = new Map<string, Pending>();
  const decisions: TwoPersonDecision[] = [];
  for (const e of records) {
    const hit = byAction.get(e.action);
    if (!hit || e.outcome !== 'SUCCESS') continue;
    const { circuit, role } = hit;
    const key = keyOf(circuit, e);
    if (!key) continue;
    const pk = `${circuit.code}|${key}`;
    if (role === 'P') {
      if (e.actor.kind === 'user') pending.set(pk, { actorId: e.actor.id, kind: e.actor.kind, at: e.at });
      else pending.delete(pk);
      continue;
    }
    if (e.actor.kind !== 'user') continue;
    const cited = typeof e.details.proposedBy === 'string' ? e.details.proposedBy : typeof e.details.requestedBy === 'string' ? e.details.requestedBy : null;
    const p = pending.get(pk);
    const proposerId = cited ?? p?.actorId;
    if (!proposerId || proposerId === e.actor.id) continue;
    const outcome = circuit.outcome && role === 'A' ? circuit.outcome(e) : role === 'A' ? 'APPROUVE' : 'REFUSE';
    if (!outcome) continue;
    const proposedAt = p && p.actorId === proposerId ? p.at : null;
    decisions.push({
      circuit: circuit.code, circuitLabel: circuit.label, key, proposerId, approverId: e.actor.id,
      proposedAt, decidedAt: e.at, delaySeconds: proposedAt ? Math.max(0, Math.round((Date.parse(e.at) - Date.parse(proposedAt)) / 1000)) : null,
      outcome, auditId: e.id,
    });
  }
  return { decisions, pending };
}
