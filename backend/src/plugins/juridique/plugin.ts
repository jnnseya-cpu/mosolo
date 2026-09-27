/**
 * Module d'extension « juridique » : registre des points juridiques à trancher (J1–J30, § 6.4, annexe B) avec
 * décision à deux personnes sur acte (référence + empreinte), registre de conditionnement consulté par les autres
 * modules (`pointJuridiqueTranche`, `etatFonction`), classification des données C1–C5 et purge par durée de
 * conservation (aperçu, puis deux personnes ; jamais de données financières, d'audit ou de preuve).
 */
import { definePolicy, GRANTS, PUBLIC_AGENT_ROLES } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { registerJuridiqueRoutes } from './routes.js';
import { JuridiqueService } from './service.js';

const { always } = GRANTS;

// Lecture du registre des points : tous les agents publics (R01 à R29) et l'observateur de la société civile.
definePolicy('juridique:points.read', { ...Object.fromEntries(PUBLIC_AGENT_ROLES.map((r) => [r, always])), R36: always });
// Proposition (acte à l'appui) : juristes ; décision : autorité de publication, ministre des Finances, Gouverneur.
definePolicy('juridique:points.propose', { R13: always, R14: always });
definePolicy('juridique:points.decide', { R16: always, R05: always, R01: always });
// Gouvernance des données : DPO, sécurité, administration, audit (lecture) ; purge proposée par le DPO ou la sécurité,
// approuvée par une autre personne (DPO, sécurité ou administration de la plateforme).
definePolicy('juridique:donnees.read', { R25: always, R28: always, R26: always, R22: always, R23: always });
definePolicy('juridique:purge.propose', { R25: always, R28: always });
definePolicy('juridique:purge.decide', { R25: always, R28: always, R26: always });

export const juridiquePlugin = definePlugin<JuridiqueService>({
  name: 'juridique',
  create: (ctx) => {
    const svc = new JuridiqueService(ctx);
    // Aperçu planifié facultatif (MOSOLO_PURGE_APERCU_MS, 1 minute au moins) : simulation journalisée, jamais d'effacement.
    const every = Number.parseInt(process.env.MOSOLO_PURGE_APERCU_MS ?? '', 10);
    if (Number.isFinite(every) && every >= 60_000) svc.startScheduler(every);
    return svc;
  },
  routes: (app, _ctx, svc) => {
    registerJuridiqueRoutes(app, svc);
    app.addHook('onClose', async () => svc.stopScheduler());
  },
});

export { JuridiqueService } from './service.js';
export { etatFonction, pointJuridiqueTranche, recoupementDonneesAutorise, statutPointJuridique } from './gates.js';
