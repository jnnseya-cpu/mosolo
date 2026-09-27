/**
 * Module d'extension « pilotage » (§ 26–27, modules 41–44, 46, 54) : tableaux de bord sur données réelles,
 * indicateurs calculés, tableaux par profil, transparence publique, piste d'audit par dossier, exports signés.
 * Lecture seule sur le socle ; aucun acte financier (C1-267) ; agrégats seulement dans les tableaux.
 */
import { definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { runDemoFlow } from './demo-flow.js';
import { registerPilotageRoutes } from './routes.js';
import { PilotageService } from './service.js';

const { always, inTerritory } = GRANTS;

/** Lecture des tableaux (agrégats) — le périmètre (province, administration, territoire) est appliqué par le service. */
definePolicy('pilotage:dashboard.read', {
  R01: always, R02: always, R03: always, R04: always, R05: always, R06: always, R07: always, R08: always,
  R17: always, R18: always, R22: always, R23: always, R24: always,
});
definePolicy('pilotage:export', {
  R01: always, R02: always, R03: always, R04: always, R05: always, R06: always, R07: always, R08: always,
  R17: always, R18: always, R22: always, R23: always, R24: always,
});
definePolicy('pilotage:profile.gouverneur', { R01: always, R02: always, R03: always, R05: always });
definePolicy('pilotage:profile.dg-regie', { R06: always, R07: always, R01: always, R02: always, R05: always });
definePolicy('pilotage:profile.tresor', { R17: always, R18: always, R01: always, R05: always });
definePolicy('pilotage:profile.commune', { R08: inTerritory('full'), R01: always, R02: always, R05: always });
definePolicy('pilotage:profile.audit', { R22: always, R23: always, R24: always });
definePolicy('pilotage:profile.ministre', { R04: always, R05: always, R01: always });
/** Consultation jusqu'au paiement individuel (sans nom) : Trésor et audit seulement — jamais le Gouverneur (C2-263). */
definePolicy('pilotage:drill.payments', { R17: always, R18: always, R22: always, R23: always });
/** Piste d'audit par dossier : auditeurs et enquêteur anti-fraude. */
definePolicy('pilotage:audit_trail.read', { R22: always, R23: always, R24: always });
/** Rapport des réductions de recettes (fuites) : autorités, cabinet, ministre des Finances, audit, anti-fraude. */
definePolicy('pilotage:reductions.read', { R01: always, R02: always, R05: always, R22: always, R23: always, R24: always });
/** Rejouer la détection de concentration des réductions : audit interne et anti-fraude. */
definePolicy('pilotage:reductions.detect', { R22: always, R24: always });
definePolicy('pilotage:transparency.preview', { R01: always, R05: always, R22: always, R23: always });
/** Publication trimestrielle : décision humaine de l'autorité (après test anti-ré-identification). */
definePolicy('pilotage:transparency.publish', { R01: always, R05: always });

const inTest = (): boolean => process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';

export const pilotagePlugin = definePlugin<PilotageService>({
  name: 'pilotage',
  create: (ctx) => new PilotageService(ctx),
  seed: (ctx, svc) => {
    // Aucun rôle destinataire de notifications automatiques (R06, R13, R16, R22…) n'est ajouté : le socle reste inchangé.
    const users = [
      { id: 'pilotage-u-sg', name: 'Secrétaire général du Gouvernement (démo)', roles: ['R03' as const], entity: 'GOUVERNORAT' },
      { id: 'pilotage-u-ministre-tutelle', name: 'Ministre provincial — tutelle DGTK (démo)', roles: ['R04' as const], entity: 'DGTK' },
      { id: 'pilotage-u-commune-limete', name: 'Administrateur de la commune de Limete (démo)', roles: ['R08' as const], entity: 'COMMUNE-LIMETE', territory: ['Limete'] },
      { id: 'pilotage-u-auditeur-externe', name: 'Auditeur externe (démo)', roles: ['R23' as const], entity: 'AUDIT-EXTERNE' },
    ];
    for (const u of users) if (!ctx.users.get(u.id)) ctx.users.add(u);
    // Flux de démonstration par le circuit réel (hors tests : les autres suites attendent un socle inchangé).
    if (!inTest() && process.env.MOSOLO_PILOTAGE_DEMO_FLOW !== '0') {
      try {
        runDemoFlow(ctx);
      } catch (e) {
        // Le démarrage ne dépend jamais des données de démonstration.
        console.warn(`[pilotage] flux de démonstration non exécuté : ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const minister = ctx.users.get('u-ministre-finances');
      const quarter = svc.currentQuarter();
      if (minister) {
        try {
          svc.publishTransparency(minister, quarter, 'Publication de démonstration — données fictives issues du circuit réel.');
        } catch {
          /* publication refusée (test anti-ré-identification) : rien n'est publié */
        }
      }
    }
  },
  routes: (app, ctx, svc) => registerPilotageRoutes(app, ctx, svc),
});
