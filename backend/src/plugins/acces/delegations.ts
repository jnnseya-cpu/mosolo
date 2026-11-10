/**
 * Accès et délégations (module 51, § 12, § 12.5) — ajouté au module « acces » sans le modifier :
 *  - DÉLÉGATIONS temporaires et expirantes : un titulaire délègue un ou plusieurs de SES rôles (jamais plus : pas
 *    d'élévation), pour une période bornée (PAR DÉFAUT 90 jours au plus, à confirmer), approuvée par une personne distincte ;
 *    rôles privilégiés non délégables (l'accès juste-à-temps motivé et journalisé passe par les élévations) ;
 *    incompatibilités de rôles (§ 12.5) vérifiées sur le cumul ;
 *  - ABAC : décision expliquée par attribut (rôle, territoire, module, dossier, période, appareil, sensibilité) ;
 *  - DÉTECTION : conflits d'intérêts (cumul incompatible, agent lié à un contribuable et titulaire d'un rôle de
 *    décision dans la même entité), privilèges excessifs (rôles jamais exercés depuis 90 jours, délégations
 *    échues encore actives), comptes partagés présumés (un compte de travail utilisé depuis plusieurs appareils) ;
 *  - RÉVOCATION AUTOMATIQUE à la fin d'une affectation (habilitations terrain échues, délégations échues) ;
 *  - indicateurs : accès revus (campagnes de revue du module d'intégrité) ; privilèges excessifs détectés.
 * Aucune sanction automatique : les détections ouvrent des alertes à examiner par une personne.
 */
import { hasIncompatibility, ROLES, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate, type AnyAction } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AccesService } from './service.js';

/** Durée maximale d'une délégation (jours) — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const DELEGATION_MAX_DAYS = 90;
/** Rôles jamais délégables (accès privilégiés : élévation juste-à-temps motivée à la place). */
export const NON_DELEGABLE: RoleCode[] = ['R17', 'R19', 'R25', 'R26', 'R27', 'R28', 'R29'];
/** Inactivité au-delà de laquelle un rôle détenu est signalé comme privilège excessif (jours) — PAR DÉFAUT. */
export const UNUSED_ROLE_DAYS = 90;
/** Nombre d'appareils distincts par compte de travail au-delà duquel un partage est présumé (24 h) — PAR DÉFAUT. */
export const SHARED_ACCOUNT_DEVICES = 3;
const DECISION_ROLES: RoleCode[] = ['R06', 'R07', 'R11', 'R20', 'R21'];

export interface Delegation {
  id: string;
  delegatorId: string;
  delegateId: string;
  entity: string;
  roles: RoleCode[];
  scope: { territory?: string[]; modules?: string[] };
  motif: string;
  from: string;
  to: string;
  status: 'PROPOSEE' | 'ACTIVE' | 'REFUSEE' | 'TERMINEE' | 'EXPIREE';
  requestedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
  /** Rôles effectivement ajoutés au délégataire (retirés à la fin). */
  granted: RoleCode[];
  ended?: { by: string; at: string; reason: string };
}

export interface Detection { kind: 'CONFLIT_INTERETS' | 'PRIVILEGE_EXCESSIF' | 'COMPTE_PARTAGE'; userId: string; detail: string; severity: 'ELEVEE' | 'MOYENNE' }

export type Sensitivity = 'PUBLIC' | 'INTERNE' | 'CONFIDENTIEL' | 'SENSIBLE';

type Terrain = { expireAssignments?: () => string[] };
type Surveillance = { devices?: { all(): { id: string; kind: string; accounts: { userId: string; lastSeen: string }[] }[] } };
type Reviews = { reviews?: { all(): { status: string; scope?: string; launchedAt: string; items: { decision: string }[] }[] } };

export class DelegationService {
  readonly delegations = new InMemoryRepository<Delegation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly acces: () => AccesService) {}

  private now() { return this.ctx.clock.now().toISOString(); }
  private today() { return kinshasaDate(this.ctx.clock.now()); }

  request(user: User, input: { delegateId: string; roles: RoleCode[]; scope?: { territory?: string[]; modules?: string[] }; motif: string; from: string; to: string }) {
    authorize(user, 'acces:delegation.request');
    const delegate = this.ctx.users.get(input.delegateId);
    if (!delegate) throw notFound('USER_NOT_FOUND', `Délégataire inconnu : ${input.delegateId}`);
    if (delegate.id === user.id) throw badRequest('SELF_DELEGATION', 'Délégation à soi-même impossible.');
    if (delegate.entity !== user.entity) throw forbidden('OUT_OF_ENTITY', 'Délégation limitée aux personnes de la même entité (cloisonnement).');
    const notHeld = input.roles.filter((r) => !user.roles.includes(r));
    if (notHeld.length) throw forbidden('NO_ELEVATION', `Pas d’élévation : vous ne détenez pas ${notHeld.join(', ')}.`);
    const privileged = input.roles.filter((r) => NON_DELEGABLE.includes(r));
    if (privileged.length) throw forbidden('NON_DELEGABLE_ROLE', `Rôles privilégiés non délégables (${privileged.join(', ')}) : demander un accès juste-à-temps motivé.`);
    const incompatible = hasIncompatibility([...new Set([...delegate.roles, ...input.roles])]);
    if (incompatible) throw conflict('INCOMPATIBLE_ROLES', `Cumul incompatible (§ 12.5) : ${incompatible.join(' / ')}.`);
    if (input.to <= input.from || input.from < this.today()) throw badRequest('INVALID_PERIOD', 'Période invalide : début aujourd’hui ou après, fin après le début.');
    if ((Date.parse(input.to) - Date.parse(input.from)) / DAY_MS > DELEGATION_MAX_DAYS) throw unprocessable('DELEGATION_TOO_LONG', `Durée maximale d’une délégation : ${DELEGATION_MAX_DAYS} jours (par défaut, à confirmer).`);
    if (input.scope?.territory && user.territory && input.scope.territory.some((c) => !user.territory!.includes(c))) throw forbidden('NO_ELEVATION', 'Le territoire délégué excède le vôtre.');
    const d = this.delegations.insert({ id: this.ids.next('DEL'), delegatorId: user.id, delegateId: delegate.id, entity: user.entity, roles: input.roles, scope: input.scope ?? {}, motif: input.motif, from: input.from, to: input.to, status: 'PROPOSEE', requestedAt: this.now(), granted: [] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'acces.delegation.requested', resourceType: 'delegation', resourceId: d.id, details: { delegateId: d.delegateId, roles: d.roles, from: d.from, to: d.to, motif: d.motif } });
    return d;
  }

  private get(id: string) {
    const d = this.delegations.get(id);
    if (!d) throw notFound('DELEGATION_NOT_FOUND', `Délégation inconnue : ${id}`);
    return d;
  }

  decide(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'acces:delegation.approve', { entity: this.get(id).entity });
    const d = this.get(id);
    if (d.status !== 'PROPOSEE') throw conflict('ALREADY_DECIDED', `Délégation au statut ${d.status}.`);
    assertDistinctPerson(user.id, [d.delegatorId, d.delegateId], 'Une délégation est approuvée par une personne distincte du délégant et du délégataire.');
    const decision = { by: user.id, at: this.now(), ...input };
    if (!input.approve) {
      const out = this.delegations.update({ ...d, status: 'REFUSEE', decision });
      this.ctx.audit.append({ actor: actorOf(user), action: 'acces.delegation.refused', resourceType: 'delegation', resourceId: id, details: { motif: input.motif } });
      return out;
    }
    const delegate = this.ctx.users.get(d.delegateId)!;
    const granted = d.roles.filter((r) => !delegate.roles.includes(r));
    this.ctx.users.setRoles(delegate.id, [...delegate.roles, ...granted]);
    const out = this.delegations.update({ ...d, status: 'ACTIVE', decision, granted });
    this.ctx.audit.append({ actor: actorOf(user), action: 'acces.delegation.granted', resourceType: 'delegation', resourceId: id, details: { delegateId: d.delegateId, granted, to: d.to }, before: { roles: delegate.roles.filter((r) => !granted.includes(r)) }, after: { roles: [...delegate.roles] } });
    return out;
  }

  end(user: User | 'system', id: string, reason: string) {
    const d = this.get(id);
    if (user !== 'system') {
      if (user.id !== d.delegatorId) authorize(user, 'acces:delegation.approve', { entity: d.entity });
    }
    if (d.status !== 'ACTIVE') throw conflict('NOT_ACTIVE', `Délégation au statut ${d.status}.`);
    const delegate = this.ctx.users.get(d.delegateId);
    // Retrait des seuls rôles accordés par cette délégation (sauf s'ils restent accordés par une autre délégation active).
    const stillGranted = new Set(this.delegations.find((x) => x.id !== d.id && x.status === 'ACTIVE' && x.delegateId === d.delegateId).flatMap((x) => x.granted));
    if (delegate) this.ctx.users.setRoles(delegate.id, delegate.roles.filter((r) => !d.granted.includes(r) || stillGranted.has(r)));
    const out = this.delegations.update({ ...d, status: user === 'system' ? 'EXPIREE' : 'TERMINEE', ended: { by: user === 'system' ? 'echeancier' : user.id, at: this.now(), reason } });
    this.ctx.audit.append({ actor: user === 'system' ? { kind: 'system', id: 'echeancier' } : actorOf(user), action: user === 'system' ? 'acces.delegation.expired' : 'acces.delegation.ended', resourceType: 'delegation', resourceId: id, details: { removed: d.granted, reason } });
    return out;
  }

  /**
   * Échéancier (heure du serveur) : délégations échues retirées ; habilitations terrain échues révoquées (fin
   * d'affectation) ; comptes de travail à échéance expirés (module acces).
   */
  sweep() {
    const today = this.today();
    const expired = this.delegations.find((d) => d.status === 'ACTIVE' && d.to < today).map((d) => this.end('system', d.id, `Échéance de la délégation (${d.to})`).id);
    const assignments = (this.ctx.ext.terrain as Terrain | undefined)?.expireAssignments?.() ?? [];
    this.acces().sweep();
    return { delegationsExpired: expired, assignmentsRevoked: assignments };
  }

  /**
   * Décision ABAC expliquée : chaque attribut est évalué séparément (rôle et territoire par le point de décision des
   * politiques ; module et période par la portée du compte de travail ; appareil : terminal enrôlé, actif et affecté
   * pour un agent de terrain ; sensibilité : donnée sensible ⇒ consultation motivée en cours ou rôle d'audit).
   */
  explain(viewer: User, input: { userId: string; action: string; commune?: string; module?: string; taxpayerId?: string; date?: string; deviceId?: string; sensitivity?: Sensitivity }) {
    authorize(viewer, 'acces:abac.explain');
    const u = this.ctx.users.get(input.userId);
    if (!u) throw notFound('USER_NOT_FOUND', `Personne inconnue : ${input.userId}`);
    const acc = this.acces().accounts.get(u.id);
    const checks: { attribute: string; ok: boolean; detail: string }[] = [];
    const role = evaluate({ ...u, territory: undefined }, input.action as AnyAction, { ...(input.taxpayerId ? { taxpayerId: input.taxpayerId } : {}), entity: u.entity });
    checks.push({ attribute: 'ROLE', ok: !!role, detail: role ? `Rôle(s) ${u.roles.join(', ')} habilité(s) pour « ${input.action} ».` : `Aucun rôle de ${u.roles.join(', ')} n’ouvre « ${input.action} ».` });
    const terr = !input.commune || !u.territory || u.territory.includes(input.commune);
    checks.push({ attribute: 'TERRITOIRE', ok: terr, detail: input.commune ? (terr ? `${input.commune} dans le périmètre.` : `${input.commune} hors du périmètre (${u.territory?.join(', ')}).`) : 'Sans objet.' });
    const mods = acc?.scope.modules;
    const modOk = !input.module || !mods?.length || mods.includes(input.module);
    checks.push({ attribute: 'MODULE', ok: modOk, detail: input.module ? (modOk ? `Module ${input.module} ouvert.` : `Module ${input.module} hors de la portée du compte (${mods!.join(', ')}).`) : 'Sans objet.' });
    const dossier = !input.taxpayerId || !!evaluate(u, input.action as AnyAction, { taxpayerId: input.taxpayerId, entity: u.entity });
    checks.push({ attribute: 'DOSSIER', ok: dossier, detail: input.taxpayerId ? (dossier ? 'Dossier accessible.' : 'Dossier hors du rattachement de la personne.') : 'Sans objet.' });
    const date = input.date ?? this.today();
    const until = acc?.scope.validUntil;
    const periodOk = (!until || date <= until) && acc?.status !== 'EXPIRE' && acc?.status !== 'REVOQUE';
    checks.push({ attribute: 'PERIODE', ok: periodOk, detail: until ? `Compte valable jusqu’au ${until}.` : acc ? `Compte ${acc.status}.` : 'Compte hors registre des comptes de travail.' });
    const field = u.roles.some((r) => ['R10', 'R11', 'R35'].includes(r));
    const dev = input.deviceId ? this.ctx.field.devices.get(input.deviceId) : undefined;
    const devOk = !field || (!!dev && dev.status === 'ACTIF' && dev.agentUserId === u.id);
    checks.push({ attribute: 'APPAREIL', ok: devOk, detail: field ? (devOk ? `Terminal ${input.deviceId} enrôlé, actif et affecté.` : 'Agent de terrain : terminal enrôlé, actif et affecté exigé.') : 'Sans objet (hors terrain).' });
    const sens = input.sensitivity ?? 'INTERNE';
    const audit = u.roles.some((r) => ['R22', 'R23', 'R24', 'R25'].includes(r));
    const consult = this.acces().consultations.find((c) => c.userId === u.id && c.expiresAt > this.now() && (!input.taxpayerId || c.taxpayerId === input.taxpayerId)).length;
    const sensOk = sens !== 'SENSIBLE' || audit || consult > 0;
    checks.push({ attribute: 'SENSIBILITE', ok: sensOk, detail: sens === 'SENSIBLE' ? (sensOk ? 'Donnée sensible : consultation motivée en cours ou rôle de contrôle.' : 'Donnée sensible : consultation motivée préalable exigée.') : `Classification ${sens}.` });
    return { userId: u.id, action: input.action, decision: checks.every((c) => c.ok) ? 'AUTORISE' : 'REFUSE', checks };
  }

  /** Détections (conflits d'intérêts, privilèges excessifs, comptes partagés) — alertes à examiner, aucun effet. */
  detect(raise = true): Detection[] {
    const out: Detection[] = [];
    const now = this.ctx.clock.now().getTime();
    const records = this.ctx.audit.list({ limit: 10_000_000 }).items;
    const lastAct = new Map<string, string>();
    for (const r of records) if (r.actor.kind === 'user') lastAct.set(r.actor.id, r.at);
    for (const u of this.ctx.users.all()) {
      const pair = hasIncompatibility(u.roles);
      if (pair) out.push({ kind: 'CONFLIT_INTERETS', userId: u.id, severity: 'ELEVEE', detail: `Cumul incompatible (§ 12.5) : ${ROLES[pair[0]]} / ${ROLES[pair[1]]}.` });
      const acc = this.acces().accounts.get(u.id);
      if (acc?.linkedTaxpayerIds.length && u.roles.some((r) => DECISION_ROLES.includes(r))) {
        out.push({ kind: 'CONFLIT_INTERETS', userId: u.id, severity: 'MOYENNE', detail: `Agent titulaire d’un rôle de décision et lié à ${acc.linkedTaxpayerIds.length} profil(s) contribuable : récusation à vérifier sur ses dossiers.` });
      }
      const internal = u.roles.filter((r) => r < 'R30');
      const last = lastAct.get(u.id);
      if (internal.length && acc && acc.status === 'ACTIF' && acc.activatedAt && now - Date.parse(acc.activatedAt) > UNUSED_ROLE_DAYS * DAY_MS && (!last || now - Date.parse(last) > UNUSED_ROLE_DAYS * DAY_MS)) {
        out.push({ kind: 'PRIVILEGE_EXCESSIF', userId: u.id, severity: 'MOYENNE', detail: `Aucune action depuis plus de ${UNUSED_ROLE_DAYS} jours avec ${internal.join(', ')} : retrait à examiner en revue d’accès.` });
      }
    }
    for (const d of this.delegations.find((x) => x.status === 'ACTIVE' && x.to < this.today())) out.push({ kind: 'PRIVILEGE_EXCESSIF', userId: d.delegateId, severity: 'ELEVEE', detail: `Délégation ${d.id} échue le ${d.to} encore active.` });
    // Comptes partagés présumés : un compte de travail vu depuis plusieurs empreintes d'appareil en 24 h.
    const sv = (this.ctx.ext['integrite-securite'] as { surveillance?: Surveillance } | undefined)?.surveillance;
    const byAccount = new Map<string, Set<string>>();
    for (const d of sv?.devices?.all() ?? []) {
      if (d.kind !== 'EMPREINTE') continue;
      for (const a of d.accounts) if (now - Date.parse(a.lastSeen) <= DAY_MS) byAccount.set(a.userId, (byAccount.get(a.userId) ?? new Set()).add(d.id));
    }
    for (const [userId, devs] of byAccount) {
      const u = this.ctx.users.get(userId);
      if (u && u.roles.some((r) => r < 'R30') && devs.size >= SHARED_ACCOUNT_DEVICES) out.push({ kind: 'COMPTE_PARTAGE', userId, severity: 'ELEVEE', detail: `Compte de travail utilisé depuis ${devs.size} appareils en 24 h : comptes partagés interdits, vérification requise.` });
    }
    if (raise) {
      const day = this.today();
      for (const x of out) this.ctx.alerts.raiseOnce(`acces:${x.kind}:${x.userId}:${day}`, { type: `ACCES_${x.kind}`, severity: x.severity === 'ELEVEE' ? 'HIGH' : 'MEDIUM', source: 'acces:delegations', detail: x.detail, context: { userId: x.userId, automaticEffect: 'AUCUN' }, notifyRoles: ['R28', 'R22'] });
    }
    return out;
  }

  view(user: User) {
    authorize(user, 'acces:delegation.read');
    const detections = this.detect();
    const rv = (this.ctx.ext.integrite as Reviews | undefined)?.reviews?.all() ?? [];
    const items = rv.flatMap((c) => c.items);
    const decided = items.filter((i) => i.decision !== 'A_CONFIRMER').length;
    const visible = this.delegations.all().filter((d) => user.roles.some((r) => ['R22', 'R23', 'R28'].includes(r)) || d.entity === user.entity || d.delegatorId === user.id || d.delegateId === user.id);
    return {
      params: { maxDays: DELEGATION_MAX_DAYS, nonDelegable: NON_DELEGABLE, unusedRoleDays: UNUSED_ROLE_DAYS, sharedAccountDevices: SHARED_ACCOUNT_DEVICES, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      delegations: visible.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1)),
      detections,
      links: { justeATemps: '/acces/elevations', revues: '/integrite/revue-acces', invitations: '/acces/invitations' },
      rule: 'RBAC + ABAC ; délégations temporaires sans élévation ; comptes partagés interdits ; révocation automatique à la fin d’une affectation.',
      indicators: [
        items.length
          ? { code: 'ACCES_REVUS', label: 'Accès revus (lignes de revue décidées)', measured: true, value: ((decided * 100) / items.length).toFixed(1), unit: '%', basis: { decided, total: items.length, campaigns: rv.length } }
          : { code: 'ACCES_REVUS', label: 'Accès revus (lignes de revue décidées)', measured: false, value: null, unit: '%', reason: 'Aucune campagne de revue des accès lancée.' },
        { code: 'PRIVILEGES_EXCESSIFS', label: 'Privilèges excessifs détectés', measured: true, value: String(detections.filter((d) => d.kind === 'PRIVILEGE_EXCESSIF').length), unit: 'cas', detail: { conflits: detections.filter((d) => d.kind === 'CONFLIT_INTERETS').length, comptesPartages: detections.filter((d) => d.kind === 'COMPTE_PARTAGE').length } },
      ],
    };
  }
}
