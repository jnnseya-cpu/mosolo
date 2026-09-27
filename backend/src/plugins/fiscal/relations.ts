/**
 * Gestionnaire des relations contribuable–objet (module 7, § 16.1-16.2) : rôles datés, quote-part, preuves,
 * statut probant. La réponse d'un contribuable n'est jamais une preuve suffisante de propriété : elle ouvre une
 * instruction (PROPOSÉE) ; seul un agent habilité, distinct du déclarant, valide.
 */
import type { ProbativeStatus } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { actorOf, basisToPct, pctToBasis, type FiscalDeps } from './common.js';

export const RELATION_ROLES = ['PROPRIETAIRE', 'COPROPRIETAIRE', 'USUFRUITIER', 'HERITIER_PRESUME', 'GESTIONNAIRE'] as const;
export type RelationRole = (typeof RELATION_ROLES)[number];
export const ROLE_LABELS: Record<RelationRole, string> = {
  PROPRIETAIRE: 'Propriétaire', COPROPRIETAIRE: 'Copropriétaire', USUFRUITIER: 'Usufruitier',
  HERITIER_PRESUME: 'Héritier présumé', GESTIONNAIRE: 'Gestionnaire',
};
/** Rôles dont les quotes-parts se cumulent (plafond 100 % sur une même période). */
const OWNERSHIP: RelationRole[] = ['PROPRIETAIRE', 'COPROPRIETAIRE'];

export const PROOF_TYPES = ['TITRE_FONCIER', 'CERTIFICAT_ENREGISTREMENT', 'ACTE_DE_VENTE', 'CONTRAT_DE_LOCATION', 'ATTESTATION_COUTUMIERE', 'ACTE_SUCCESSORAL', 'MANDAT_DE_GESTION', 'CONSTAT_TERRAIN', 'AUTRE'] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

export const CLOSE_REASONS = ['VENTE', 'MUTATION', 'FIN_DE_MANDAT', 'DECES', 'FERMETURE', 'ERREUR_MATERIELLE', 'AUTRE'] as const;

export interface Proof { type: ProofType; reference: string; sha256?: string; addedAt: string; addedBy: string }

export type RelationStatus = 'PROPOSEE' | 'VALIDEE' | 'CONTESTEE' | 'REJETEE' | 'CLOSE';

export interface Relationship {
  id: string;
  taxpayerId: string;
  objectId: string;
  role: RelationRole;
  /** Quote-part en pour cent (chaîne décimale) ; propriétaire unique = 100. */
  share?: string;
  from: string;
  to?: string;
  proofs: Proof[];
  probativeStatus: ProbativeStatus;
  status: RelationStatus;
  declaredBy: string;
  declaredAt: string;
  validatedBy?: string;
  validatedAt?: string;
  decisionReason?: string;
  closeReason?: string;
  disputeId?: string;
  history: { at: string; by: string; action: string; reason?: string }[];
}

export interface OwnershipDispute {
  id: string;
  objectId: string;
  relationIds: string[];
  status: 'OUVERT' | 'TRANCHE';
  openedAt: string;
  openedReason: string;
  decision?: { keptRelationIds: string[]; reason: string; decidedBy: string; at: string };
}

const ACTIVE: RelationStatus[] = ['PROPOSEE', 'VALIDEE', 'CONTESTEE'];
const overlaps = (a: { from: string; to?: string }, b: { from: string; to?: string }) =>
  a.from <= (b.to ?? '9999-12-31') && b.from <= (a.to ?? '9999-12-31');

/** Seuil « objet de forte valeur » (N2 requis pour valider un rattachement) — [paramètre de démonstration]. */
export const HIGH_VALUE_AREA_M2 = 2000;

export function isHighValue(o: FiscalObject): boolean {
  if (o.attributes['forteValeur'] === true) return true;
  const s = o.attributes['superficie_m2'];
  return typeof s === 'string' && /^\d+(\.\d+)?$/.test(s) && Number.parseFloat(s) >= HIGH_VALUE_AREA_M2;
}

export class RelationService {
  readonly relations = new InMemoryRepository<Relationship>();
  readonly disputes = new InMemoryRepository<OwnershipDispute>();
  private readonly ids = new IdGenerator();
  /**
   * Gardes et suites du détachement, branchées par d'autres modules (module 7 : blocage de mutation sans quitus
   * lorsque la règle l'exige ; revue des obligations à la date d'effet). Une garde lève une erreur pour refuser.
   */
  readonly avantDetachement: ((rel: Relationship, input: { to: string; reason: (typeof CLOSE_REASONS)[number] }) => void)[] = [];
  readonly apresDetachement: ((rel: Relationship, by: User) => void)[] = [];

  constructor(private readonly d: FiscalDeps) {}

  get(id: string): Relationship {
    const r = this.relations.get(id);
    if (!r) throw notFound('RELATION_NOT_FOUND', `Relation inconnue : ${id}`);
    return r;
  }

  ofObject(objectId: string): Relationship[] {
    return this.relations.find((r) => r.objectId === objectId);
  }

  ofTaxpayer(taxpayerId: string): Relationship[] {
    return this.relations.find((r) => r.taxpayerId === taxpayerId);
  }

  /** Objets d'un contribuable : redevable principal ou relation active. */
  objectIdsOf(taxpayerId: string): string[] {
    const ids = new Set(this.d.ctx.objects.byTaxpayer(taxpayerId).map((o) => o.id));
    for (const r of this.ofTaxpayer(taxpayerId)) if (ACTIVE.includes(r.status)) ids.add(r.objectId);
    return [...ids];
  }

  declare(user: User, input: {
    taxpayerId?: string; objectId: string; role: RelationRole; share?: string; from: string; to?: string;
    proofs: { type: ProofType; reference: string; sha256?: string }[];
  }): Relationship {
    const taxpayerId = input.taxpayerId ?? (user.roles.includes('R30') ? user.taxpayerId : undefined);
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable concerné requis.');
    const obj = this.d.ctx.objects.get(input.objectId);
    authorize(user, 'fiscal:relation.declare', { taxpayerId, communes: [obj.commune] });
    this.d.ctx.taxpayers.get(taxpayerId);
    // M07-C1 : aucune relation sans preuve minimale.
    if (input.proofs.length === 0) throw unprocessable('PROOF_REQUIRED', 'Au moins une pièce justificative est requise pour toute relation contribuable–objet.');
    if (input.to && input.to < input.from) throw badRequest('INVALID_PERIOD', 'La date de fin précède la date de début.');
    let share: number | undefined;
    if (input.role === 'COPROPRIETAIRE' && !input.share) throw badRequest('SHARE_REQUIRED', 'La quote-part est obligatoire pour un copropriétaire.');
    if (input.role === 'PROPRIETAIRE') share = input.share ? pctToBasis(input.share) : 10000;
    else if (input.share) share = pctToBasis(input.share);

    const mine = this.ofObject(obj.id).filter((r) => r.taxpayerId === taxpayerId && r.role === input.role && ACTIVE.includes(r.status) && overlaps(r, input));
    if (mine.length) throw conflict('RELATION_EXISTS', 'Une relation de même rôle existe déjà pour ce contribuable sur cette période.', { relationId: mine[0]!.id });

    const now = this.d.nowIso();
    const isAgent = !user.roles.some((r) => r === 'R30' || r === 'R31');
    let rel: Relationship = this.relations.insert({
      id: this.ids.next('REL'),
      taxpayerId,
      objectId: obj.id,
      role: input.role,
      ...(share !== undefined ? { share: basisToPct(share) } : {}),
      from: input.from,
      ...(input.to ? { to: input.to } : {}),
      proofs: input.proofs.map((p) => ({ ...p, addedAt: now, addedBy: user.id })),
      probativeStatus: isAgent && input.proofs.some((p) => p.type === 'CONSTAT_TERRAIN') ? 'OBSERVE' : 'DECLARE',
      status: 'PROPOSEE',
      declaredBy: user.id,
      declaredAt: now,
      history: [{ at: now, by: user.id, action: 'DECLAREE' }],
    });
    this.d.ctx.audit.append({
      actor: actorOf(user), action: 'relationship.declared', resourceType: 'relationship', resourceId: rel.id,
      details: { objectId: obj.id, role: rel.role, share: rel.share ?? null, proofs: rel.proofs.length },
    });
    const tp = this.d.ctx.taxpayers.get(taxpayerId);
    this.d.ctx.comms.publish('object.link.requested', [taxpayerRecipient(tp)], { objet: obj.igf?.code ?? obj.id }, { entity: 'DGIPK' });

    // Conflit : revendications de propriété concurrentes au-delà de 100 % sur la même période.
    if (OWNERSHIP.includes(rel.role)) {
      const others = this.ofObject(obj.id).filter((r) => r.id !== rel.id && r.taxpayerId !== taxpayerId && OWNERSHIP.includes(r.role) && ACTIVE.includes(r.status) && overlaps(r, rel));
      const total = others.reduce((s, r) => s + pctToBasis(r.share ?? '100'), 0) + (share ?? 0);
      if (others.length && total > 10000) rel = this.openDispute(user, obj, [rel, ...others], 'Revendications de propriété concurrentes au-delà de 100 % sur la même période');
    }
    return rel;
  }

  private openDispute(user: User, obj: FiscalObject, rels: Relationship[], reason: string): Relationship {
    const now = this.d.nowIso();
    const existing = this.disputes.findOne((x) => x.objectId === obj.id && x.status === 'OUVERT');
    const dispute = existing
      ? this.disputes.update({ ...existing, relationIds: [...new Set([...existing.relationIds, ...rels.map((r) => r.id)])] })
      : this.disputes.insert({ id: this.ids.next('LIT-OBJ'), objectId: obj.id, relationIds: rels.map((r) => r.id), status: 'OUVERT', openedAt: now, openedReason: reason });
    // Le nouveau venu passe au statut CONTESTÉ ; les relations déjà validées le restent jusqu'à décision.
    const first = rels[0]!;
    const updated = this.relations.update({
      ...first, status: 'CONTESTEE', probativeStatus: 'CONTESTE', disputeId: dispute.id,
      history: [...first.history, { at: now, by: user.id, action: 'CONFLIT_OUVERT', reason }],
    });
    for (const r of rels.slice(1)) this.relations.update({ ...r, disputeId: dispute.id });
    this.d.ctx.objects.setProbativeStatus(obj.id, 'CONTESTE');
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'object.ownership.dispute_opened', resourceType: 'fiscal_object', resourceId: obj.id, details: { disputeId: dispute.id, relations: dispute.relationIds.length } });
    // Chaque partie est informée sans qu'aucune donnée de l'autre compte ne lui soit montrée.
    for (const tpId of new Set(rels.map((r) => r.taxpayerId))) {
      this.d.ctx.comms.publish('object.ownership.conflict', [taxpayerRecipient(this.d.ctx.taxpayers.get(tpId))], { objet: obj.igf?.code ?? obj.id }, { entity: 'DGIPK' });
    }
    return updated;
  }

  validate(user: User, id: string, decision: { approve: boolean; reason: string }): Relationship {
    const rel = this.get(id);
    const obj = this.d.ctx.objects.get(rel.objectId);
    authorize(user, 'fiscal:relation.validate', { communes: [obj.commune] });
    if (rel.status !== 'PROPOSEE') throw conflict('INVALID_RELATION_STATE', `Relation au statut ${rel.status} : validation impossible (un conflit se tranche par décision).`);
    assertDistinctPerson(user.id, [rel.declaredBy], 'Le déclarant ne peut pas valider sa propre déclaration de relation.');
    const now = this.d.nowIso();
    const tp = this.d.ctx.taxpayers.get(rel.taxpayerId);
    if (!decision.approve) {
      const r = this.relations.update({ ...rel, status: 'REJETEE', decisionReason: decision.reason, validatedBy: user.id, validatedAt: now, history: [...rel.history, { at: now, by: user.id, action: 'REJETEE', reason: decision.reason }] });
      this.d.ctx.audit.append({ actor: actorOf(user), action: 'relationship.rejected', resourceType: 'relationship', resourceId: id, details: { reason: decision.reason } });
      this.d.ctx.comms.publish('object.link.rejected', [taxpayerRecipient(tp)], { objet: obj.igf?.code ?? obj.id }, { entity: 'DGIPK' });
      return r;
    }
    // M07-C2 : rattachement d'un objet de forte valeur réservé au niveau N2 (ou N3).
    if (isHighValue(obj) && !['N2', 'N3'].includes(tp.verificationLevel)) {
      throw forbidden('VERIFICATION_LEVEL_REQUIRED', `Objet de forte valeur : le contribuable doit être vérifié au niveau N2 (actuel : ${tp.verificationLevel}).`, { required: 'N2', current: tp.verificationLevel });
    }
    if (OWNERSHIP.includes(rel.role)) {
      const validated = this.ofObject(obj.id).filter((r) => r.id !== rel.id && r.status === 'VALIDEE' && OWNERSHIP.includes(r.role) && overlaps(r, rel));
      const total = validated.reduce((s, r) => s + pctToBasis(r.share ?? '100'), 0) + pctToBasis(rel.share ?? '100');
      if (total > 10000) throw unprocessable('SHARES_EXCEED_100', 'La somme des quotes-parts validées dépasserait 100 % sur la période.');
    }
    const r = this.relations.update({
      ...rel, status: 'VALIDEE', probativeStatus: 'VERIFIE', decisionReason: decision.reason, validatedBy: user.id, validatedAt: now,
      history: [...rel.history, { at: now, by: user.id, action: 'VALIDEE', reason: decision.reason }],
    });
    // Revendication d'un objet provisoire : le propriétaire validé devient le redevable principal.
    if (OWNERSHIP.includes(rel.role) && !obj.taxpayerId) this.d.ctx.objects.setHolder(obj.id, rel.taxpayerId);
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'relationship.validated', resourceType: 'relationship', resourceId: id, details: { objectId: obj.id, role: rel.role, share: rel.share ?? null, reason: decision.reason } });
    this.d.ctx.comms.publish('object.link.approved', [taxpayerRecipient(tp)], { objet: obj.igf?.code ?? obj.id }, { entity: 'DGIPK' });
    return r;
  }

  /** Le contribuable conteste une relation qui le concerne (« je ne suis pas propriétaire »…). */
  contest(user: User, id: string, reason: string): Relationship {
    const rel = this.get(id);
    const obj = this.d.ctx.objects.get(rel.objectId);
    authorize(user, 'fiscal:relation.contest', { taxpayerId: rel.taxpayerId, communes: [obj.commune] });
    if (!ACTIVE.includes(rel.status) || rel.status === 'CONTESTEE') throw conflict('INVALID_RELATION_STATE', `Relation au statut ${rel.status}.`);
    return this.openDispute(user, obj, [rel], `Contestation : ${reason}`);
  }

  /** Décision sur un conflit : relations maintenues (validées), autres rejetées ; motif obligatoire. */
  resolveDispute(user: User, disputeId: string, input: { keepRelationIds: string[]; reason: string }): OwnershipDispute {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) throw notFound('DISPUTE_NOT_FOUND', `Dossier de conflit inconnu : ${disputeId}`);
    const obj = this.d.ctx.objects.get(dispute.objectId);
    authorize(user, 'fiscal:relation.resolve', { communes: [obj.commune] });
    if (dispute.status !== 'OUVERT') throw conflict('DISPUTE_CLOSED', 'Dossier déjà tranché.');
    for (const k of input.keepRelationIds) if (!dispute.relationIds.includes(k)) throw badRequest('NOT_IN_DISPUTE', `Relation ${k} étrangère au dossier.`);
    const keptOwners = input.keepRelationIds.map((k) => this.get(k)).filter((r) => OWNERSHIP.includes(r.role));
    if (keptOwners.reduce((s, r) => s + pctToBasis(r.share ?? '100'), 0) > 10000) throw unprocessable('SHARES_EXCEED_100', 'Les relations maintenues dépassent 100 %.');
    const now = this.d.nowIso();
    for (const rid of dispute.relationIds) {
      const r = this.get(rid);
      const keep = input.keepRelationIds.includes(rid);
      this.relations.update({
        ...r, status: keep ? 'VALIDEE' : 'REJETEE', probativeStatus: keep ? 'VERIFIE' : r.probativeStatus === 'CONTESTE' ? 'CONTESTE' : r.probativeStatus,
        validatedBy: user.id, validatedAt: now, decisionReason: input.reason,
        history: [...r.history, { at: now, by: user.id, action: keep ? 'MAINTENUE_APRES_CONFLIT' : 'REJETEE_APRES_CONFLIT', reason: input.reason }],
      });
    }
    this.d.ctx.objects.setProbativeStatus(obj.id, obj.status === 'VALIDE' ? 'VERIFIE' : 'DECLARE');
    const updated = this.disputes.update({ ...dispute, status: 'TRANCHE', decision: { keptRelationIds: input.keepRelationIds, reason: input.reason, decidedBy: user.id, at: now } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'object.ownership.dispute_resolved', resourceType: 'fiscal_object', resourceId: obj.id, details: { disputeId, kept: input.keepRelationIds, reason: input.reason } });
    return updated;
  }

  /** Détachement daté (vente, mutation, fin de mandat…) : la relation est close, jamais supprimée. */
  close(user: User, id: string, input: { to: string; reason: (typeof CLOSE_REASONS)[number]; comment?: string }): Relationship {
    const rel = this.get(id);
    const obj = this.d.ctx.objects.get(rel.objectId);
    authorize(user, 'fiscal:relation.close', { communes: [obj.commune] });
    if (rel.status !== 'VALIDEE') throw conflict('INVALID_RELATION_STATE', 'Seule une relation validée peut être close.');
    if (input.to < rel.from) throw badRequest('INVALID_PERIOD', 'La date de fin précède la date de début.');
    for (const guard of this.avantDetachement) guard(rel, input);
    const now = this.d.nowIso();
    const r = this.relations.update({ ...rel, status: 'CLOSE', to: input.to, closeReason: input.reason, history: [...rel.history, { at: now, by: user.id, action: 'CLOSE', reason: `${input.reason}${input.comment ? ` — ${input.comment}` : ''}` }] });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'relationship.closed', resourceType: 'relationship', resourceId: id, details: { to: input.to, reason: input.reason } });
    for (const after of this.apresDetachement) after(r, user);
    return r;
  }

  /** Vue d'une relation pour un contribuable tiers : ni nom, ni identifiant, ni pièce. */
  static anonymized(r: Relationship) {
    return { role: r.role, share: r.share ?? null, status: r.status, from: r.from, to: r.to ?? null, own: false };
  }
}
