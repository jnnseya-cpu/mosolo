/**
 * Accès privilégié juste-à-temps (§ 12.1 « élévation temporaire, motivée, tracée et expirant automatiquement »,
 * § 12.3 « Élévation d'accès privilégié : Administrateur → Responsable sécurité — motif, expiration automatique,
 * enregistrement de session », § 12.5, Annexe C « JIT ») pour le personnel d'exploitation de la plateforme.
 *
 *  demande motivée (rôle, durée ≤ plafond du registre) → approbation par le responsable sécurité, personne distincte,
 *  second facteur → élévation ACTIVE : le rôle s'ajoute aux requêtes de la personne, sans jamais modifier l'annuaire →
 *  expiration automatique à l'échéance (ou fin anticipée) → session enregistrée : chaque requête est journalisée
 *  (commande), et chaque enregistrement d'audit émis porte l'identifiant d'élévation (trace.elevationId).
 * La consultation « bris de glace » (acces/service.ts, 30 min) reste inchangée et disponible.
 */
import { hasIncompatibility, ROLES, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { securityNum } from '../integrite/gouvernance/parametres-securite.js';

/** Rôles privilégiés obtenables par élévation (administration et exploitation de la plateforme). */
export const ELEVATABLE_ROLES: RoleCode[] = ['R26', 'R27'];

export type ElevationStatus = 'DEMANDEE' | 'ACTIVE' | 'REFUSEE' | 'EXPIREE' | 'TERMINEE' | 'REVOQUEE';

export interface Elevation {
  id: string;
  userId: string;
  userEntity: string;
  role: RoleCode;
  motif: string;
  ticketRef?: string;
  durationMinutes: number;
  status: ElevationStatus;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionMotif?: string;
  startsAt?: string;
  expiresAt?: string;
  endedAt?: string;
  endReason?: string;
  endedBy?: string;
}

export interface ElevationHost {
  requireMfa(user: User, always?: boolean): void;
}

export class ElevationService {
  readonly requests = new InMemoryRepository<Elevation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly host: ElevationHost) {}

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  private log(actor: User | 'system', action: string, e: Elevation, details: Record<string, unknown> = {}, outcome?: 'SUCCESS' | 'DENIED') {
    this.ctx.audit.append({
      actor: actor === 'system' ? { kind: 'system', id: 'echeancier' } : actorOf(actor), action: `acces.elevation.${action}`, resourceType: 'elevation', resourceId: e.id,
      details: { entity: e.userEntity, subject: e.userId, role: e.role, ...details }, ...(outcome ? { outcome } : {}),
    });
  }

  /** Expiration automatique à l'échéance (heure serveur). */
  sweep(): void {
    const now = this.now();
    for (const e of this.requests.find((x) => x.status === 'ACTIVE' && !!x.expiresAt && x.expiresAt <= now)) {
      const out = this.requests.update({ ...e, status: 'EXPIREE', endedAt: e.expiresAt!, endReason: 'Expiration automatique' });
      this.log('system', 'expired', out, { expiresAt: e.expiresAt, actions: this.actions(e.id) });
      const subject = this.ctx.users.get(e.userId);
      if (subject) this.ctx.comms.publish('auth.privileged_access.expired', [userRecipient(subject)], {}, { entity: e.userEntity });
    }
  }

  /** Élévation active d'une personne (après balayage des échéances). */
  active(userId: string): Elevation | undefined {
    const now = this.now();
    const e = this.requests.findOne((x) => x.userId === userId && x.status === 'ACTIVE');
    if (e && e.expiresAt && e.expiresAt <= now) {
      this.sweep();
      return undefined;
    }
    return e;
  }

  actions(id: string): number {
    return this.ctx.audit.list({ elevationId: id, limit: 1 }).total;
  }

  view(e: Elevation) {
    return { ...e, roleLabel: ROLES[e.role], actions: this.actions(e.id), remainingSeconds: e.status === 'ACTIVE' && e.expiresAt ? Math.max(0, Math.round((Date.parse(e.expiresAt) - Date.parse(this.now())) / 1000)) : 0 };
  }

  request(user: User, input: { role: RoleCode; motif: string; durationMinutes: number; ticketRef?: string }) {
    authorize(user, 'acces:elevation.request');
    this.sweep();
    if (!ELEVATABLE_ROLES.includes(input.role)) throw unprocessable('ROLE_NOT_ELEVATABLE', `Rôle non obtenable par élévation : ${input.role}. Rôles admis : ${ELEVATABLE_ROLES.join(', ')}.`);
    if (user.roles.includes(input.role)) throw unprocessable('ROLE_ALREADY_HELD', 'Vous détenez déjà ce rôle de façon permanente.');
    const clash = hasIncompatibility([...user.roles, input.role]);
    if (clash) throw forbidden('ROLE_INCOMPATIBILITY', `Élévation refusée : cumul interdit des rôles ${clash[0]} et ${clash[1]} (§ 12.5).`);
    const max = securityNum(this.ctx, 'acces.elevation_duree_max_min');
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > max) {
      throw unprocessable('DURATION_OUT_OF_RANGE', `Durée d’élévation entre 5 et ${max} minutes (plafond du registre, par défaut — à confirmer).`);
    }
    if (this.requests.findOne((x) => x.userId === user.id && (x.status === 'DEMANDEE' || x.status === 'ACTIVE'))) {
      throw conflict('ELEVATION_PENDING', 'Une élévation est déjà demandée ou active pour vous.');
    }
    const e = this.requests.insert({
      id: this.ids.next('ELV', 5), userId: user.id, userEntity: user.entity, role: input.role, motif: input.motif.trim(),
      ...(input.ticketRef ? { ticketRef: input.ticketRef.trim() } : {}), durationMinutes: input.durationMinutes, status: 'DEMANDEE', requestedAt: this.now(),
    });
    this.log(user, 'requested', e, { motif: e.motif, durationMinutes: e.durationMinutes, ticketRef: e.ticketRef ?? null });
    const approvers = this.ctx.users.withRole('R28').filter((u) => u.id !== user.id);
    if (approvers.length) this.ctx.comms.publish('audit.access_review.due', approvers.map(userRecipient), {}, { entity: 'PLATEFORME' });
    return this.view(e);
  }

  decide(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'acces:elevation.approve');
    this.sweep();
    const e = this.requests.get(id);
    if (!e) throw notFound('ELEVATION_NOT_FOUND', `Élévation inconnue : ${id}`);
    if (e.status !== 'DEMANDEE') throw conflict('ELEVATION_ALREADY_DECIDED', `Élévation au statut ${e.status}.`);
    assertDistinctPerson(user.id, [e.userId], 'Élévation privilégiée : approuvée par une personne distincte du demandeur.');
    this.host.requireMfa(user, true);
    const at = this.now();
    if (!input.approve) {
      const out = this.requests.update({ ...e, status: 'REFUSEE', decidedBy: user.id, decidedAt: at, decisionMotif: input.motif.trim() });
      this.log(user, 'refused', out, { requestedBy: e.userId, motif: input.motif.trim() });
      return this.view(out);
    }
    const expiresAt = new Date(Date.parse(at) + e.durationMinutes * 60_000).toISOString();
    const out = this.requests.update({ ...e, status: 'ACTIVE', decidedBy: user.id, decidedAt: at, decisionMotif: input.motif.trim(), startsAt: at, expiresAt });
    this.log(user, 'approved', out, { requestedBy: e.userId, expiresAt, durationMinutes: e.durationMinutes, motif: input.motif.trim() });
    const subject = this.ctx.users.get(e.userId);
    if (subject) this.ctx.comms.publish('auth.privileged_access.granted', [userRecipient(subject)], {}, { entity: e.userEntity });
    this.ctx.alerts.raise({
      type: 'ELEVATION_PRIVILEGIEE_ACTIVE', severity: 'MEDIUM', source: 'acces:elevation', actor: actorOf(user),
      detail: `Élévation ${e.id} : ${e.userId} détient ${e.role} jusqu’à ${expiresAt} (motif : ${e.motif}). Session enregistrée.`,
      context: { elevationId: e.id, automaticEffect: 'AUCUN' }, notifyRoles: ['R22'],
    });
    return this.view(out);
  }

  /** Fin anticipée : par le bénéficiaire (TERMINEE) ou par la sécurité (REVOQUEE). */
  end(user: User, id: string, motif: string) {
    this.sweep();
    const e = this.requests.get(id);
    if (!e) throw notFound('ELEVATION_NOT_FOUND', `Élévation inconnue : ${id}`);
    const own = e.userId === user.id;
    if (!own) authorize(user, 'acces:elevation.approve');
    if (e.status === 'DEMANDEE' && own) {
      const out = this.requests.update({ ...e, status: 'TERMINEE', endedAt: this.now(), endReason: `Demande retirée : ${motif}`, endedBy: user.id });
      this.log(user, 'withdrawn', out, { motif });
      return this.view(out);
    }
    if (e.status !== 'ACTIVE') throw conflict('ELEVATION_NOT_ACTIVE', `Élévation au statut ${e.status}.`);
    const out = this.requests.update({ ...e, status: own ? 'TERMINEE' : 'REVOQUEE', endedAt: this.now(), endReason: motif, endedBy: user.id });
    this.log(user, own ? 'ended' : 'revoked', out, { motif, actions: this.actions(e.id) });
    return this.view(out);
  }

  list(user: User) {
    this.sweep();
    const oversight = user.roles.some((r) => ['R28', 'R22', 'R23', 'R26'].includes(r));
    const items = this.requests.all().filter((e) => oversight || e.userId === user.id).reverse().map((e) => this.view(e));
    return { items, elevatableRoles: ELEVATABLE_ROLES.map((r) => ({ code: r, label: ROLES[r] })), maxMinutes: securityNum(this.ctx, 'acces.elevation_duree_max_min') };
  }

  /** Session enregistrée : toutes les actions journalisées pendant l'élévation. */
  session(user: User, id: string) {
    const e = this.requests.get(id);
    if (!e) throw notFound('ELEVATION_NOT_FOUND', `Élévation inconnue : ${id}`);
    if (e.userId !== user.id) authorize(user, 'acces:elevation.session.read');
    const items = this.ctx.audit.list({ elevationId: id, limit: 5000 }).items.map((r) => ({
      seq: r.seq, at: r.at, action: r.action, resourceType: r.resourceType, resourceId: r.resourceId, outcome: r.outcome,
      correlationId: r.trace?.correlationId ?? null, details: r.action === 'acces.elevation.command' ? r.details : undefined, hash: r.hash,
    }));
    return { elevation: this.view(e), items };
  }

  /** Élévations d'un mois (revue mensuelle des accès privilégiés, module integrite). */
  elevationsOfPeriod(period: string) {
    this.sweep();
    return this.requests.all().filter((e) => e.requestedAt.startsWith(period) && ['ACTIVE', 'EXPIREE', 'TERMINEE', 'REVOQUEE'].includes(e.status))
      .map((e) => ({ id: e.id, userId: e.userId, role: e.role, motif: e.motif, ...(e.decidedBy ? { decidedBy: e.decidedBy } : {}), ...(e.startsAt ? { startsAt: e.startsAt } : {}), ...(e.endedAt ? { endedAt: e.endedAt } : {}), actions: this.actions(e.id) }));
  }
}
