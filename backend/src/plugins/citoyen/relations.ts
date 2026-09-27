/**
 * Module 7 — Gestionnaire de relations contribuable–objet : compléments (Spécification fonctionnelle).
 *
 * Le rattachement, le détachement, la revendication, l'historique et les conflits sont servis par le module « fiscal »
 * (relations datées, preuves, N2 pour les objets de forte valeur, dossier de litige). Ce service y branche :
 *  - le BLOCAGE DE MUTATION SANS QUITUS lorsque la règle l'exige : une vente ou une mutation passe par le moteur de
 *    dépendances (mutation foncière, mutation de véhicule) — informatif tant que l'acte n'est pas publié, bloquant ensuite ;
 *  - la MISE À JOUR DES OBLIGATIONS À LA DATE D'EFFET : les obligations ouvertes de l'ancien titulaire échues après la
 *    date d'effet sont placées en revue ; une personne décide (rectification par le circuit de réclamation, jamais une
 *    annulation automatique).
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { actorOf } from '../../core/audit.js';
import { conflict, notFound } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { Relationship } from '../fiscal/relations.js';
import { fiscalOf, hoursBetween, median, pct } from './common.js';

const { always } = GRANTS;
definePolicy('citoyen:relations.revue', { R06: always, R07: always, R11: always, R22: always });

export interface RevueObligation {
  id: string;
  obligationId: string;
  relationId: string;
  objectId: string;
  ancienTitulaire: string;
  dateEffet: string;
  echeance: string;
  motifDetachement: string;
  statut: 'A_REVOIR' | 'MAINTENUE' | 'A_RECTIFIER';
  ouverteLe: string;
  decision?: { par: string; at: string; motif: string };
}

export class RelationsSuiviService {
  readonly revues = new InMemoryRepository<RevueObligation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  /** Branche les gardes et suites du détachement sur le service des relations (appelé à la création du module). */
  brancher(): void {
    const fiscal = fiscalOf(this.ctx);
    if (!fiscal) return;
    fiscal.relations.avantDetachement.push((rel, input) => {
      if (input.reason !== 'VENTE' && input.reason !== 'MUTATION') return;
      const obj = this.ctx.objects.get(rel.objectId);
      const plate = typeof obj.attributes['plaque'] === 'string' ? obj.attributes['plaque'] : typeof obj.attributes['immatriculation'] === 'string' ? obj.attributes['immatriculation'] : undefined;
      fiscal.dependencies.assertSatisfied(obj.category === 'VEHICULE' ? 'MUTATION_VEHICULE' : 'MUTATION_FONCIERE', rel.taxpayerId, plate ? { plate } : {});
    });
    fiscal.relations.apresDetachement.push((rel, by) => this.ouvrirRevues(rel, by));
  }

  private ouvrirRevues(rel: Relationship, by: User): void {
    if (!rel.to) return;
    const at = this.ctx.clock.now().toISOString();
    const obligations = this.ctx.assessment.obligations.find((o) => o.objectId === rel.objectId && o.taxpayerId === rel.taxpayerId && !o.supersededBy && PAYABLE_STATUSES.includes(o.status) && o.dueDate > rel.to!);
    for (const o of obligations) {
      if (this.revues.findOne((r) => r.obligationId === o.id && r.statut === 'A_REVOIR')) continue;
      this.revues.insert({
        id: this.ids.next('RVO'), obligationId: o.id, relationId: rel.id, objectId: rel.objectId, ancienTitulaire: rel.taxpayerId, dateEffet: rel.to,
        echeance: o.dueDate, motifDetachement: rel.closeReason ?? '—', statut: 'A_REVOIR', ouverteLe: at,
      });
    }
    if (obligations.length) {
      this.ctx.audit.append({ actor: actorOf(by), action: 'relationship.obligations_review_opened', resourceType: 'relationship', resourceId: rel.id, details: { dateEffet: rel.to, obligations: obligations.map((o) => o.id) } });
    }
  }

  liste(user: User, statut?: string) {
    authorize(user, 'citoyen:relations.revue');
    return this.revues.find((r) => !statut || r.statut === statut).map((r) => {
      const o = this.ctx.assessment.obligations.get(r.obligationId);
      return { ...r, obligation: o ? { id: o.id, label: o.label, amount: o.amount, status: o.status, dueDate: o.dueDate } : null };
    });
  }

  decider(user: User, id: string, input: { statut: 'MAINTENUE' | 'A_RECTIFIER'; motif: string }) {
    authorize(user, 'citoyen:relations.revue');
    const r = this.revues.get(id);
    if (!r) throw notFound('REVUE_INCONNUE', `Revue inconnue : ${id}`);
    if (r.statut !== 'A_REVOIR') throw conflict('REVUE_DECIDEE', 'Revue déjà décidée.');
    const out = this.revues.update({ ...r, statut: input.statut, decision: { par: user.id, at: this.ctx.clock.now().toISOString(), motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'relationship.obligation_review.decided', resourceType: 'obligation', resourceId: r.obligationId, details: { statut: input.statut, motif: input.motif, relationId: r.relationId } });
    if (input.statut === 'A_RECTIFIER') {
      // Le contribuable est invité à déposer une réclamation (circuit commun) : la rectification suit la décision.
      const tp = this.ctx.taxpayers.taxpayers.get(r.ancienTitulaire);
      if (tp) this.ctx.comms.publish('object.characteristics.changed', [taxpayerRecipient(tp)], { reference: r.obligationId }, { entity: 'DGIPK' });
    }
    return out;
  }

  /** Indicateurs du module 7 : taux d'objets rattachés, délai de rattachement, litiges ouverts. */
  indicateurs() {
    const fiscal = fiscalOf(this.ctx);
    const objs = this.ctx.objects.objects.all();
    const rels = fiscal?.relations.relations.all() ?? [];
    const rattaches = objs.filter((o) => !!o.taxpayerId || rels.some((r) => r.objectId === o.id && r.status === 'VALIDEE'));
    const delais = rels.filter((r) => r.validatedAt && r.status !== 'REJETEE').map((r) => hoursBetween(r.declaredAt, r.validatedAt!));
    const med = median(delais);
    return {
      tauxObjetsRattaches: { valeur: pct(rattaches.length, objs.length), numerateur: rattaches.length, denominateur: objs.length },
      delaiRattachement: med === null ? { valeur: null, raison: 'Aucun rattachement validé : délai non mesuré.' } : { valeur: med.toFixed(1), unite: 'h (médiane déclaration → validation)', mesures: delais.length },
      litigesOuverts: { valeur: fiscal?.relations.disputes.find((d) => d.status === 'OUVERT').length ?? 0 },
      obligationsARevoir: { valeur: this.revues.find((r) => r.statut === 'A_REVOIR').length },
    };
  }
}
