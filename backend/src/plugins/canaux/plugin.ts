/**
 * Module d'extension « canaux » : enrôlement inclusif (63), SVI (64), carte MOSOLO (65), points de paiement
 * agréés (66), vérification par code court (68), USSD (6). Réutilise le compte unique, le circuit de paiement
 * commun (référence, confirmation signée, quittance) et le coffre : aucun circuit parallèle.
 */
import { allAgentRoles, definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { registerCanauxRoutes } from './routes.js';
import { CanauxService } from './service.js';
import { contribuerCompteUnique } from './compte-unique.js';

// Enrôlement assisté : agent de terrain (dans sa zone) ou agent de guichet ; revue des doublons par un superviseur.
// Zone de l'agent contrôlée par enregistrement (refus journalisé), non au niveau du lot.
definePolicy('canaux:enrolment.create', { R10: GRANTS.always, R12: GRANTS.always });
definePolicy('canaux:enrolment.read', { R10: GRANTS.always, R12: GRANTS.always, R09: GRANTS.always, R22: GRANTS.always, R25: GRANTS.always });
definePolicy('canaux:enrolment.review', { R09: GRANTS.always });
definePolicy('canaux:notice.read', { R10: GRANTS.always, R12: GRANTS.always, R09: GRANTS.always, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });

// Carte MOSOLO : blocage immédiat (guichet, agent, titulaire, mandataire) ; réémission en double validation.
definePolicy('canaux:card.read', { R10: GRANTS.always, R12: GRANTS.always, R09: GRANTS.always, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('canaux:card.block', { R10: GRANTS.always, R12: GRANTS.always, R09: GRANTS.always, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('canaux:card.pin', { R12: GRANTS.always, R30: GRANTS.ownTaxpayer });
definePolicy('canaux:card.reissue.request', { R12: GRANTS.always });
definePolicy('canaux:card.reissue.approve', { R12: GRANTS.always, R09: GRANTS.always });

// Points de paiement agréés : référencement, activation (seconde personne) et suspension décidés par le Trésor.
definePolicy('canaux:point.reference', { R17: GRANTS.always });
definePolicy('canaux:point.activate', { R17: GRANTS.always });
definePolicy('canaux:point.suspend', { R17: GRANTS.always });
// Quatre yeux : rétablissement, écartement d'une proposition et constatation d'un versement au relevé sont DEMANDÉS
// par un membre du Trésor (R17/R18) puis DÉCIDÉS par un R17 distinct.
definePolicy('canaux:point.decision.request', { R17: GRANTS.always, R18: GRANTS.always });
definePolicy('canaux:point.deposit.confirm', { R17: GRANTS.always });
definePolicy('canaux:point.supervise', { R17: GRANTS.always, R18: GRANTS.always, R22: GRANTS.always, R24: GRANTS.always });
// Encaissement : UNIQUEMENT l'opérateur d'un point agréé (R32) — jamais un agent public ni un sous-traitant.
definePolicy('canaux:point.collect', { R32: GRANTS.always });

// Paiement NUMÉRIQUE assisté sur place : l'agent émet la référence au nom du titulaire (jamais d'espèces à l'agent).
definePolicy('canaux:payment.assist', {
  R09: GRANTS.inTerritory('minimal'), R10: GRANTS.inTerritory('minimal'), R11: GRANTS.inTerritory('minimal'), R35: GRANTS.inTerritory('minimal'),
});

// Journal des sessions USSD / SVI (audit, sécurité, protection des données) et indicateurs agrégés.
definePolicy('canaux:sessions.read', { R22: GRANTS.always, R25: GRANTS.always, R27: GRANTS.always, R28: GRANTS.always });
definePolicy('canaux:indicators', { ...allAgentRoles(GRANTS.always), R36: GRANTS.always });

export const canauxPlugin = definePlugin({
  name: 'canaux',
  create: (ctx) => {
    const svc = new CanauxService(ctx);
    // Balayage périodique des retards de versement des points agréés (MOSOLO_POINTS_SCAN_MS, défaut : 1 h ; 0 = désactivé).
    const every = Number.parseInt(process.env.MOSOLO_POINTS_SCAN_MS ?? '3600000', 10);
    if (Number.isFinite(every) && every >= 60_000) svc.points.startScheduler(every);
    // Import de relevé au Trésor : les lignes portant un bordereau de versement déclaré sont appariées automatiquement.
    ctx.treasury.addStatementClaimant((statementId, lines) => svc.points.claimStatementLines(statementId, lines));
    // Compte unique (ch. 9) : cartes MOSOLO du compte.
    contribuerCompteUnique(ctx, svc);
    return svc;
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => registerCanauxRoutes(app, ctx, svc),
});
