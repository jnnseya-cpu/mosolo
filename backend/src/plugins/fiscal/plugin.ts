/**
 * Module d'extension « fiscal » : relations contribuable–objet, hiérarchie SIG et identifiant géofiscal, QR par
 * bien, déclarations pré-remplies, registre des exonérations et remises, quitus fiscal numérique, attestation de
 * bail, carte à deux couches. Matrice d'habilitations déclarée ici ; ce qui n'est pas listé est refusé.
 */
import { definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { registerFiscalRoutes } from './routes.js';
import { FiscalService } from './service.js';

const { always, ownTaxpayer, mandant, inTerritory } = GRANTS;

// Objets et cadastre fiscal
definePolicy('fiscal:object.read', {
  R30: ownTaxpayer, R31: mandant, R06: always, R07: always, R11: always, R12: always, R22: always,
  R09: inTerritory('minimal'), R10: inTerritory('minimal'),
});
// Valider un objet (IGF) : contrôleur, chef de service, direction — jamais l'agent qui a recensé.
definePolicy('fiscal:object.validate', { R06: always, R07: always, R11: always });
definePolicy('fiscal:plate.pose', { R10: inTerritory('full'), R11: always, R07: always });
definePolicy('fiscal:plate.scan', { R06: always, R07: always, R11: always, R09: inTerritory('full'), R10: inTerritory('full') });
// « Autour de moi » : agents des modules liés aux biens et activités, sur place, dans leur secteur, sans montant.
definePolicy('fiscal:nearby', {
  R06: always, R07: always, R22: always, R24: always,
  R09: inTerritory('minimal'), R10: inTerritory('minimal'), R11: inTerritory('minimal'), R35: inTerritory('minimal'),
});
definePolicy('fiscal:map.objects', { R06: always, R07: always, R11: always, R22: always, R09: inTerritory('minimal'), R10: inTerritory('minimal') });

// Relations contribuable–objet
definePolicy('fiscal:relation.declare', { R30: ownTaxpayer, R31: mandant, R11: always, R12: always });
definePolicy('fiscal:relation.validate', { R06: always, R07: always, R11: always });
definePolicy('fiscal:relation.contest', { R30: ownTaxpayer, R31: mandant, R11: always, R20: always });
definePolicy('fiscal:relation.close', { R06: always, R07: always, R11: always });
definePolicy('fiscal:relation.resolve', { R06: always, R07: always });

// Déclarations
definePolicy('fiscal:declaration.file', { R30: ownTaxpayer, R31: mandant, R12: always });
definePolicy('fiscal:declaration.read', { R30: ownTaxpayer, R31: mandant, R06: always, R07: always, R11: always, R12: always, R22: always });
definePolicy('fiscal:declaration.instruct', { R07: always, R11: always });

// Exonérations et remises (initiateur ≠ juriste ≠ décideur ; jamais l'IA)
definePolicy('fiscal:exemption.request', { R30: ownTaxpayer, R31: mandant, R11: always, R12: always });
definePolicy('fiscal:exemption.read', { R30: ownTaxpayer, R31: mandant, R06: always, R07: always, R11: always, R12: always, R13: always, R14: always, R22: always, R24: always });
definePolicy('fiscal:exemption.queue', { R06: always, R07: always, R11: always, R12: always, R13: always, R14: always, R22: always, R24: always });
definePolicy('fiscal:exemption.instruct', { R11: always, R12: always });
definePolicy('fiscal:exemption.legal-visa', { R13: always, R14: always });
definePolicy('fiscal:exemption.decide', { R06: always, R07: always });
definePolicy('fiscal:exemption.revoke', { R06: always, R07: always });

// Quitus fiscal et attestation de bail
definePolicy('fiscal:clearance.request', { R30: ownTaxpayer, R31: mandant, R12: always });
definePolicy('fiscal:clearance.read', { R30: ownTaxpayer, R31: mandant, R06: always, R07: always, R11: always, R12: always, R22: always });
definePolicy('fiscal:clearance.revoke', { R06: always, R07: always });
definePolicy('fiscal:clearance.verify-service', { R37: always });
definePolicy('fiscal:lease-attestation.issue', { R30: always, R31: always, R12: always });

export const fiscalPlugin = definePlugin<FiscalService>({
  name: 'fiscal',
  create: (ctx) => new FiscalService(ctx),
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => registerFiscalRoutes(app, ctx, svc),
});
