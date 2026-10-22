/**
 * Indicateurs des modules 72 (espaces d'entité et configuration des modules) et 74 (invitations et gestion des accès),
 * calculés sur les données réelles, dans le périmètre d'entités visible de la personne qui consulte.
 *
 *  - Module 72 : modules activés (fiches au statut ACTIF), par statut ; délai d'activation (création de la fiche →
 *    activation après recette et seconde validation) ; arbitrages ouverts, instruits, décidés, délai de décision.
 *  - Module 74 : invitations envoyées, acceptées (finalisées par lien ou par l'opérateur d'accès), expirées, refusées,
 *    révoquées ; délai d'acceptation ; comptes révoqués ; secondes validations (en attente, approuvées, rejetées) et délai.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { authorize } from '../../core/policy.js';
import { ACCES } from './policy.js';
import type { AccesService } from './service.js';

const H = 3_600_000;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

export function accesIndicators(ctx: AppContext, svc: AccesService, user: User) {
  authorize(user, ACCES.invitationRead, { entity: user.entity });
  const scope = svc.visibleScope(user);
  const inScope = (entity: string) => !scope || scope.has(entity);

  // ── Module 72 ──
  const modules = svc.modules.all().filter((m) => inScope(m.responsibleEntity));
  const activationHours = modules.flatMap((m) => {
    const act = m.history.find((h) => h.to === 'ACTIF');
    return act ? [(Date.parse(act.at) - Date.parse(m.createdAt)) / H] : [];
  });
  const arbitrations = svc.arbitrations.all().filter((a) => a.claimants.some((c) => inScope(c.entity)));
  const arbitrationHours = arbitrations.flatMap((a) => (a.decision ? [(Date.parse(a.decision.at) - Date.parse(a.openedAt)) / H] : []));
  const statuses = [...new Set(modules.map((m) => m.status))].sort();

  // ── Module 74 ──
  const invitations = svc.invitations.all().filter((i) => inScope(i.entity));
  const finalized = invitations.filter((i) => i.status === 'FINALISEE');
  const acceptHours = finalized.flatMap((i) => (i.finalizedAt ? [(Date.parse(i.finalizedAt) - Date.parse(i.createdAt)) / H] : []));
  const accounts = svc.accounts.all().filter((a) => inScope(a.entity));
  const validations = svc.validations.all().filter((v) => inScope(v.entity));
  const validationHours = validations.flatMap((v) => (v.decidedAt ? [(Date.parse(v.decidedAt) - Date.parse(v.createdAt)) / H] : []));

  return {
    generatedAt: ctx.clock.now().toISOString(),
    perimetre: scope ? [...scope].sort() : 'toutes les entités',
    modules72: {
      entities: svc.entities.all().filter((e) => inScope(e.id)).length,
      modules: { total: modules.length, actifs: modules.filter((m) => m.status === 'ACTIF').length, parStatut: Object.fromEntries(statuses.map((s) => [s, modules.filter((m) => m.status === s).length])) },
      delaiActivationHeures: { moyenne: avg(activationHours), activations: activationHours.length, ...(activationHours.length ? {} : { note: 'Aucune activation : délai non mesuré (aucune donnée source).' }) },
      arbitrages: {
        total: arbitrations.length, ouverts: arbitrations.filter((a) => a.status === 'OUVERT').length, instruits: arbitrations.filter((a) => a.status === 'INSTRUIT').length,
        decides: arbitrations.filter((a) => a.status === 'DECIDE').length, delaiDecisionHeures: avg(arbitrationHours),
      },
    },
    acces74: {
      invitations: {
        envoyees: invitations.length, acceptees: finalized.length, tauxAcceptationPct: pct(finalized.length, invitations.length),
        enAttente: invitations.filter((i) => i.status === 'ENVOYEE').length, expirees: invitations.filter((i) => i.status === 'EXPIREE').length,
        refusees: invitations.filter((i) => i.status === 'REFUSEE').length, revoquees: invitations.filter((i) => i.status === 'REVOQUEE').length,
        parLien: finalized.filter((i) => i.finalizedVia === 'LIEN').length, parOperateurAcces: finalized.filter((i) => i.finalizedVia === 'OPERATEUR_ACCES').length,
        delaiAcceptationHeures: avg(acceptHours),
      },
      comptes: {
        total: accounts.length, actifs: accounts.filter((a) => a.status === 'ACTIF').length, revoques: accounts.filter((a) => a.status === 'REVOQUE').length,
        suspendus: accounts.filter((a) => a.status === 'SUSPENDU').length, enAttente: accounts.filter((a) => a.status === 'ATTENTE_VALIDATION' || a.status === 'ATTENTE_SECRETS').length,
      },
      validations: {
        enAttente: validations.filter((v) => v.status === 'EN_ATTENTE').length, approuvees: validations.filter((v) => v.status === 'APPROUVEE').length,
        rejetees: validations.filter((v) => v.status === 'REJETEE').length, delaiDecisionHeures: avg(validationHours),
      },
    },
  };
}

export function registerAccesIndicatorRoutes(app: FastifyInstance, ctx: AppContext, svc: AccesService): void {
  app.get('/v1/acces/indicateurs', async (req) => accesIndicators(ctx, svc, requireUser(req)));
}
