/**
 * Module d'extension « acces-montants » : accès aux montants SUR AUTORISATION PRÉALABLE (décision du maître d'ouvrage
 * du 29/09/2026). Trésor, rapprochement, validation financière, contrôle qualité, audit et anti-fraude voient les
 * montants nécessaires à leur travail (moteur de répartition, rapport § 37A, gains et réserve des agents) seulement
 * après l'approbation d'un membre de la direction (Gouverneur, directeur de cabinet, secrétaire exécutif, ministre des
 * Finances), distinct du demandeur, sur motif déclaré et pour une durée limitée. Chaque utilisation est journalisée.
 */
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import { ACR, requireAcr, requireUser, type User } from '../../core/auth.js';
import { conflict, forbidden, notFound } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { assertDistinctPerson, authorize, definePolicy, evaluate, GRANTS, registerAutorisationMontantsResolver, type PorteeMontants } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { definePlugin } from '../types.js';

const { always } = GRANTS;
/** Demandeurs : validation financière, Trésor, rapprochement, contrôle qualité, audit interne et externe, anti-fraude. */
export const ROLES_DEMANDEURS_MONTANTS = ['R11', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24'] as const;
/** Membres de la direction qui approuvent (jamais Groupe Nseya, bénéficiaire d'une part). */
export const ROLES_APPROBATEURS_MONTANTS = ['R01', 'R02', 'R03', 'R05'] as const;
definePolicy('montants:autorisation.demander', Object.fromEntries(ROLES_DEMANDEURS_MONTANTS.map((r) => [r, always])));
definePolicy('montants:autorisation.decider', Object.fromEntries(ROLES_APPROBATEURS_MONTANTS.map((r) => [r, always])));

export const PORTEES: Record<PorteeMontants, string> = {
  MOTEUR: 'Moteur de répartition : tableaux, droits, transactions et export',
  REPARTITION: 'Répartition § 37A : montants par bénéficiaire',
  AGENTS: 'Agents : gains, réserve et file de validation des commissions',
};
/** Durée d'une autorisation — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const DUREE_PAR_DEFAUT_JOURS = 7;
export const DUREE_MAX_JOURS = 30;
/** Une utilisation est journalisée au plus une fois par minute et par autorisation (évite le bruit). */
const PAS_JOURNAL_MS = 60_000;
const DAY_MS = 86_400_000;

export interface AutorisationMontants {
  id: string;
  requesterId: string; requesterName: string; requesterRoles: string[];
  portees: PorteeMontants[];
  motif: string; mission: string | null; dureeJours: number;
  status: 'DEMANDEE' | 'APPROUVEE' | 'REFUSEE' | 'REVOQUEE';
  requestedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
  validFrom?: string; validUntil?: string;
  revocation?: { by: string; at: string; motif: string };
  utilisations: number; lastUsedAt: string | null;
}

export class AccesMontantsService {
  readonly autorisations = new InMemoryRepository<AutorisationMontants>();
  private readonly ids = new IdGenerator();
  private readonly lastLog = new Map<string, number>();

  constructor(readonly ctx: AppContext) {}

  private now() { return this.ctx.clock.now(); }

  /** État à l'instant présent (une autorisation approuvée échue est « expirée »). */
  etat(a: AutorisationMontants): AutorisationMontants['status'] | 'EXPIREE' {
    if (a.status === 'APPROUVEE' && a.validUntil && Date.parse(a.validUntil) <= this.now().getTime()) return 'EXPIREE';
    return a.status;
  }

  /** Résolveur branché sur core/policy : autorisation active couvrant la portée ; journalise l'utilisation. */
  resolve(userId: string, portee: PorteeMontants): string | null {
    const t = this.now().getTime();
    const a = this.autorisations.find((x) => x.requesterId === userId && x.status === 'APPROUVEE' && x.portees.includes(portee)
      && !!x.validFrom && Date.parse(x.validFrom) <= t && !!x.validUntil && Date.parse(x.validUntil) > t)[0];
    if (!a) return null;
    const last = this.lastLog.get(`${a.id}:${portee}`) ?? 0;
    if (t - last >= PAS_JOURNAL_MS) {
      this.lastLog.set(`${a.id}:${portee}`, t);
      this.autorisations.update({ ...a, utilisations: a.utilisations + 1, lastUsedAt: this.now().toISOString() });
      this.ctx.audit.append({ actor: { kind: 'user', id: userId, roles: a.requesterRoles as User['roles'] }, action: 'montants.autorisation.utilisee', resourceType: 'autorisation_montants', resourceId: a.id, details: { portee, motif: a.motif, approuvePar: a.decision?.by ?? null } });
    }
    return a.id;
  }

  demander(user: User, input: { portees: PorteeMontants[]; motif: string; mission?: string; dureeJours?: number }): AutorisationMontants {
    authorize(user, 'montants:autorisation.demander');
    const portees = [...new Set(input.portees)];
    if (this.autorisations.find((a) => a.requesterId === user.id && a.status === 'DEMANDEE').length) {
      throw conflict('DEMANDE_EN_COURS', 'Une demande est déjà en attente de décision : attendez-la ou faites-la retirer.');
    }
    const a: AutorisationMontants = {
      id: this.ids.next('AUTM'), requesterId: user.id, requesterName: user.name, requesterRoles: [...user.roles],
      portees, motif: input.motif, mission: input.mission ?? null, dureeJours: input.dureeJours ?? DUREE_PAR_DEFAUT_JOURS,
      status: 'DEMANDEE', requestedAt: this.now().toISOString(), utilisations: 0, lastUsedAt: null,
    };
    this.autorisations.insert(a);
    this.ctx.audit.append({ actor: actorOf(user), action: 'montants.autorisation.demandee', resourceType: 'autorisation_montants', resourceId: a.id, details: { portees, motif: a.motif, mission: a.mission, dureeJours: a.dureeJours } });
    this.ctx.alerts.raise({ type: 'ACCES_MONTANTS_DEMANDE', severity: 'MEDIUM', source: 'acces-montants', detail: `${user.name} demande l'accès aux montants (${portees.join(', ')}) pour ${a.dureeJours} jour(s) : ${a.motif}`, context: { id: a.id }, notifyRoles: [...ROLES_APPROBATEURS_MONTANTS] });
    return a;
  }

  decider(user: User, id: string, input: { approve: boolean; motif: string }): AutorisationMontants {
    authorize(user, 'montants:autorisation.decider');
    requireAcr(user, ACR.MFA); // ouvre l'accès à des données financières nominatives : authentification forte
    const a = this.get(id);
    if (a.status !== 'DEMANDEE') throw conflict('ETAPE_INVALIDE', `Autorisation au statut ${a.status} : aucune décision attendue.`);
    assertDistinctPerson(user.id, [a.requesterId], 'Le demandeur ne peut pas approuver sa propre demande.');
    const at = this.now();
    const out = this.autorisations.update({
      ...a, status: input.approve ? 'APPROUVEE' : 'REFUSEE', decision: { by: user.id, at: at.toISOString(), approve: input.approve, motif: input.motif },
      ...(input.approve ? { validFrom: at.toISOString(), validUntil: new Date(at.getTime() + a.dureeJours * DAY_MS).toISOString() } : {}),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'montants.autorisation.approuvee' : 'montants.autorisation.refusee', resourceType: 'autorisation_montants', resourceId: a.id, details: { demandeur: a.requesterId, portees: a.portees, motif: input.motif, validUntil: out.validUntil ?? null } });
    return out;
  }

  /** Révocation anticipée : un membre de la direction, ou le demandeur lui-même (renonciation). */
  revoquer(user: User, id: string, motif: string): AutorisationMontants {
    const a = this.get(id);
    const own = a.requesterId === user.id;
    if (!own) authorize(user, 'montants:autorisation.decider');
    if (a.status !== 'APPROUVEE' && a.status !== 'DEMANDEE') throw conflict('ETAPE_INVALIDE', `Autorisation au statut ${a.status} : rien à révoquer.`);
    const out = this.autorisations.update({ ...a, status: 'REVOQUEE', revocation: { by: user.id, at: this.now().toISOString(), motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'montants.autorisation.revoquee', resourceType: 'autorisation_montants', resourceId: a.id, details: { demandeur: a.requesterId, motif } });
    return out;
  }

  liste(user: User) {
    const decideur = evaluate(user, 'montants:autorisation.decider', {}) !== false;
    const demandeur = evaluate(user, 'montants:autorisation.demander', {}) !== false;
    if (!decideur && !demandeur) throw forbidden('FORBIDDEN', 'Autorisations d’accès aux montants : réservées aux demandeurs habilités et à la direction.');
    const items = this.autorisations.find((a) => decideur || a.requesterId === user.id)
      .map((a) => ({ ...a, etat: this.etat(a) }))
      .sort((x, y) => (x.etat === 'DEMANDEE' ? 0 : 1) - (y.etat === 'DEMANDEE' ? 0 : 1) || y.requestedAt.localeCompare(x.requestedAt));
    const actives = items.filter((a) => a.requesterId === user.id && a.etat === 'APPROUVEE').flatMap((a) => a.portees);
    return {
      items, peutDemander: demandeur, peutDecider: decideur, portees: PORTEES,
      mesPorteesActives: [...new Set(actives)],
      duree: { parDefautJours: DUREE_PAR_DEFAUT_JOURS, maxJours: DUREE_MAX_JOURS, statut: 'par défaut — à confirmer par le maître d’ouvrage' },
      regle: 'Accès aux montants sur autorisation préalable d’un membre de la direction (Gouverneur, directeur de cabinet, secrétaire exécutif, ministre des Finances), distinct du demandeur ; motif déclaré, durée limitée, chaque utilisation journalisée. Lecture seulement : aucune écriture financière.',
    };
  }

  private get(id: string): AutorisationMontants {
    const a = this.autorisations.get(id);
    if (!a) throw notFound('AUTORISATION_INCONNUE', `Autorisation inconnue : ${id}`);
    return a;
  }
}

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);

export const accesMontantsPlugin = definePlugin<AccesMontantsService>({
  name: 'acces-montants',
  create: (ctx) => {
    const svc = new AccesMontantsService(ctx);
    registerAutorisationMontantsResolver((userId, portee) => svc.resolve(userId, portee));
    return svc;
  },
  routes: (app, _ctx, svc) => {
    const B = '/v1/acces-montants';
    app.get(B, async (req) => svc.liste(requireUser(req)));
    app.post(B, async (req, reply) => {
      const b = parse(z.object({
        portees: z.array(z.enum(['MOTEUR', 'REPARTITION', 'AGENTS'])).min(1).max(3), motif,
        mission: z.string().trim().max(200).optional(), dureeJours: z.number().int().min(1).max(DUREE_MAX_JOURS).optional(),
      }).strict(), req.body);
      return reply.code(201).send(svc.demander(requireUser(req), b as Parameters<AccesMontantsService['demander']>[1]));
    });
    app.post<{ Params: { id: string } }>(`${B}/:id/decision`, async (req) => svc.decider(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
    app.post<{ Params: { id: string } }>(`${B}/:id/revocation`, async (req) => svc.revoquer(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
  },
});
