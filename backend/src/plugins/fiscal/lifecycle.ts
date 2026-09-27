/**
 * Cycle de vie de l'objet fiscal (Document maître FR 2, nouvelle version, § 30 : « provisoire, actif, suspendu, clos » ;
 * § 17.3 : « Litige de limites : objet marqué en litige, obligations suspendues selon la règle applicable, renvoi au
 * service foncier »). AJOUT à l'existant : le statut de validation (PROVISOIRE / VALIDE) et le statut probant restent
 * inchangés ; l'état du cycle de vie s'y superpose.
 *
 *  - SUSPENSION : décision humaine motivée (contrôleur, chef de service, direction) ; aucune NOUVELLE liquidation
 *    n'est possible tant qu'elle dure (garde de liquidation) ; les obligations déjà émises ne sont ni annulées ni
 *    modifiées d'office (leur sort relève de la règle applicable et du circuit de réclamation). Levée motivée.
 *  - CLÔTURE (démolition, cessation, doublon, fusion) : proposition puis approbation par une SECONDE personne (quatre
 *    yeux) ; l'objet reste au registre, son IGF n'est jamais réattribué ; aucune nouvelle liquidation.
 *  - Aucune suspension ni clôture automatique : ni l'IA, ni une règle de score ne peut en décider (§ 22, § 24.1).
 */
import type { User } from '../../core/auth.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { lifecycleOf, OBJECT_LIFECYCLE_LABELS, type FiscalObject, type ObjectLifecycleState } from '../../modules/objects/service.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { FiscalDeps } from './common.js';

const { always } = GRANTS;

definePolicy('fiscal:object.lifecycle.suspend', { R06: always, R07: always, R11: always });
definePolicy('fiscal:object.lifecycle.close', { R06: always, R07: always, R11: always });
definePolicy('fiscal:object.lifecycle.close.approve', { R06: always, R07: always });
definePolicy('fiscal:object.lifecycle.read', { R06: always, R07: always, R11: always, R22: always, R23: always });

export const SUSPENSION_MOTIFS = ['LITIGE_LIMITES', 'CONTESTATION_EXISTENCE', 'HABITAT_INFORMEL_A_QUALIFIER', 'AUTRE'] as const;
export type SuspensionMotif = (typeof SUSPENSION_MOTIFS)[number];
export const SUSPENSION_MOTIF_LABELS: Record<SuspensionMotif, string> = {
  LITIGE_LIMITES: 'Litige de limites — renvoi au service foncier',
  CONTESTATION_EXISTENCE: 'Existence ou consistance de l’objet contestée',
  HABITAT_INFORMEL_A_QUALIFIER: 'Habitat informel en attente de qualification juridique',
  AUTRE: 'Autre motif',
};

export const CLOSURE_MOTIFS = ['DEMOLITION', 'CESSATION_ACTIVITE', 'DOUBLON', 'FUSION_OBJETS', 'AUTRE'] as const;
export type ClosureMotif = (typeof CLOSURE_MOTIFS)[number];
export const CLOSURE_MOTIF_LABELS: Record<ClosureMotif, string> = {
  DEMOLITION: 'Démolition ou disparition du bien',
  CESSATION_ACTIVITE: 'Cessation de l’activité',
  DOUBLON: 'Doublon d’un autre objet',
  FUSION_OBJETS: 'Fusion d’objets',
  AUTRE: 'Autre motif',
};

export interface ClosureRequest {
  id: string;
  objectId: string;
  motif: ClosureMotif;
  reason: string;
  effectiveDate: string;
  proposedBy: string;
  proposedAt: string;
  status: 'PROPOSEE' | 'APPROUVEE' | 'REJETEE';
  decision?: { by: string; at: string; reason: string };
}

/** Vue du cycle de vie d'un objet (état, depuis quand, motif, clôture en attente). */
export interface LifecycleView {
  state: ObjectLifecycleState;
  label: string;
  since: string | null;
  motif: string | null;
  reason: string | null;
  pendingClosureId: string | null;
  liquidationAllowed: boolean;
}

export class ObjectLifecycleService {
  readonly closures = new InMemoryRepository<ClosureRequest>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps) {
    // Garde de liquidation : aucune nouvelle obligation sur un objet suspendu ou clos (tentative journalisée).
    d.ctx.assessment.addLiquidationGuard(({ user, rule, objectId }) => {
      const o = d.ctx.objects.objects.get(objectId);
      if (!o) return;
      const state = lifecycleOf(o);
      if (state !== 'SUSPENDU' && state !== 'CLOS') return;
      d.ctx.audit.append({
        actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'assessment.liquidation.refused', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED',
        details: { reason: state === 'CLOS' ? 'OBJECT_CLOSED' : 'OBJECT_SUSPENDED', objectId, motif: o.lifecycle?.motif ?? null },
      });
      throw conflict(state === 'CLOS' ? 'OBJECT_CLOSED' : 'OBJECT_SUSPENDED',
        `Objet ${objectId} ${state === 'CLOS' ? 'clos' : 'suspendu'} (${o.lifecycle?.motif ?? '—'}) : aucune nouvelle liquidation tant que cet état dure.`, { objectId, state });
    });
  }

  view(o: FiscalObject): LifecycleView {
    const state = lifecycleOf(o);
    const pending = this.closures.findOne((c) => c.objectId === o.id && c.status === 'PROPOSEE');
    return {
      state, label: OBJECT_LIFECYCLE_LABELS[state], since: o.lifecycle?.since ?? null, motif: o.lifecycle?.motif ?? null, reason: o.lifecycle?.reason ?? null,
      pendingClosureId: pending?.id ?? null, liquidationAllowed: state === 'ACTIF' || state === 'PROVISOIRE',
    };
  }

  /** Suspension motivée (litige de limites, contestation, habitat informel à qualifier). */
  suspend(user: User, objectId: string, input: { motif: SuspensionMotif; reason: string }): FiscalObject {
    const o = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:object.lifecycle.suspend', { communes: [o.commune] });
    assertNotRelated(user, o.taxpayerId, 'Conflit d’intérêts : l’agent est lié au contribuable redevable de l’objet.');
    const state = lifecycleOf(o);
    if (state === 'SUSPENDU') throw conflict('OBJECT_ALREADY_SUSPENDED', 'Objet déjà suspendu.');
    if (state === 'CLOS') throw conflict('OBJECT_CLOSED', 'Objet clos : aucune suspension possible.');
    const updated = this.d.ctx.objects.setLifecycle(objectId, { state: 'SUSPENDU', motif: input.motif, reason: input.reason, by: [user] });
    // Un litige est affiché en bleu sur la carte (§ 16.5) : le statut probant passe à CONTESTÉ, sans autre effet.
    if (input.motif === 'LITIGE_LIMITES' || input.motif === 'CONTESTATION_EXISTENCE') this.d.ctx.objects.setProbativeStatus(objectId, 'CONTESTE');
    this.notifyHolder(updated);
    return this.d.ctx.objects.get(objectId);
  }

  /** Levée motivée de la suspension ; le statut probant redevient celui que justifie la validation. */
  reactivate(user: User, objectId: string, reason: string): FiscalObject {
    const o = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:object.lifecycle.suspend', { communes: [o.commune] });
    if (lifecycleOf(o) !== 'SUSPENDU') throw conflict('OBJECT_NOT_SUSPENDED', 'Seul un objet suspendu peut être réactivé.');
    const wasContested = o.lifecycle?.motif === 'LITIGE_LIMITES' || o.lifecycle?.motif === 'CONTESTATION_EXISTENCE';
    const updated = this.d.ctx.objects.setLifecycle(objectId, { state: 'ACTIF', motif: 'LEVEE', reason, by: [user] });
    if (wasContested && updated.probativeStatus === 'CONTESTE') this.d.ctx.objects.setProbativeStatus(objectId, updated.status === 'VALIDE' ? 'VERIFIE' : 'OBSERVE');
    this.notifyHolder(updated);
    return this.d.ctx.objects.get(objectId);
  }

  /** Proposition de clôture (quatre yeux : approuvée par une autre personne). */
  proposeClosure(user: User, objectId: string, input: { motif: ClosureMotif; reason: string; effectiveDate: string }): ClosureRequest {
    const o = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:object.lifecycle.close', { communes: [o.commune] });
    assertNotRelated(user, o.taxpayerId, 'Conflit d’intérêts : l’agent est lié au contribuable redevable de l’objet.');
    if (lifecycleOf(o) === 'CLOS') throw conflict('OBJECT_CLOSED', 'Objet déjà clos.');
    if (this.closures.findOne((c) => c.objectId === objectId && c.status === 'PROPOSEE')) throw conflict('CLOSURE_ALREADY_PROPOSED', 'Une clôture est déjà proposée pour cet objet.');
    if (input.effectiveDate > this.d.today()) throw badRequest('INVALID_EFFECTIVE_DATE', 'La date d’effet d’une clôture ne peut pas être future.');
    const req = this.closures.insert({
      id: this.ids.next('CLO'), objectId, motif: input.motif, reason: input.reason, effectiveDate: input.effectiveDate,
      proposedBy: user.id, proposedAt: this.d.nowIso(), status: 'PROPOSEE',
    });
    this.d.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'object.lifecycle.closure_proposed', resourceType: 'fiscal_object', resourceId: objectId, details: { closureId: req.id, motif: input.motif, effectiveDate: input.effectiveDate } });
    return req;
  }

  /** Décision de clôture par une seconde personne, distincte du proposant. */
  decideClosure(user: User, closureId: string, input: { approve: boolean; reason: string }): { closure: ClosureRequest; lifecycle: LifecycleView } {
    const req = this.closures.get(closureId);
    if (!req) throw notFound('CLOSURE_NOT_FOUND', `Proposition de clôture inconnue : ${closureId}`);
    const o = this.d.ctx.objects.get(req.objectId);
    authorize(user, 'fiscal:object.lifecycle.close.approve', { communes: [o.commune] });
    if (req.status !== 'PROPOSEE') throw conflict('CLOSURE_ALREADY_DECIDED', 'Proposition déjà décidée.');
    assertDistinctPerson(user.id, [req.proposedBy], 'Quatre yeux : la personne qui propose la clôture ne l’approuve pas.');
    assertNotRelated(user, o.taxpayerId, 'Conflit d’intérêts : le décideur est lié au contribuable redevable de l’objet.');
    const decided = this.closures.update({ ...req, status: input.approve ? 'APPROUVEE' : 'REJETEE', decision: { by: user.id, at: this.d.nowIso(), reason: input.reason } });
    if (input.approve) {
      const proposer = this.d.ctx.users.get(req.proposedBy);
      const updated = this.d.ctx.objects.setLifecycle(req.objectId, { state: 'CLOS', motif: req.motif, reason: `${req.reason} — date d’effet ${req.effectiveDate}`, by: [...(proposer ? [proposer] : []), user] });
      this.notifyHolder(updated);
    } else {
      this.d.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'object.lifecycle.closure_rejected', resourceType: 'fiscal_object', resourceId: req.objectId, details: { closureId, reason: input.reason } });
    }
    return { closure: decided, lifecycle: this.view(this.d.ctx.objects.get(req.objectId)) };
  }

  listClosures(user: User, status?: string): (ClosureRequest & { commune: string; category: string })[] {
    authorize(user, 'fiscal:object.lifecycle.read');
    return this.closures.find((c) => !status || c.status === status)
      .map((c) => ({ c, o: this.d.ctx.objects.objects.get(c.objectId) }))
      .filter(({ o }) => !!o && !!evaluate(user, 'fiscal:object.lifecycle.read', { communes: [o.commune] }))
      .map(({ c, o }) => ({ ...c, commune: o!.commune, category: o!.category }))
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  private notifyHolder(o: FiscalObject): void {
    if (!o.taxpayerId) return;
    const t = this.d.ctx.taxpayers.taxpayers.get(o.taxpayerId);
    if (!t) return;
    this.d.ctx.comms.publish('object.characteristics.changed', [taxpayerRecipient(t)], { objet: o.igf?.code ?? o.id }, { entity: 'DGIPK' });
  }
}
