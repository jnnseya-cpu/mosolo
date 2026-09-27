/** Liste des modules d'extension chargés par défaut (ordre = ordre de construction). */
import type { MosoloPlugin } from './types.js';
import { accesPlugin } from './acces/plugin.js';
import { fiscalPlugin } from './fiscal/plugin.js';
import { tresorPlugin } from './tresor/plugin.js';
import { recouvrementPlugin } from './recouvrement/plugin.js';
import { campagnesPlugin } from './recouvrement/campagnes-plugin.js';
import { titresPlugin } from './titres/plugin.js';
import { rakapayPlugin } from './rakapay/plugin.js';
import { parkingPlugin } from './parking/plugin.js';
import { publicitePlugin } from './publicite/plugin.js';
import { verticalesPlugin } from './verticales/plugin.js';
import { referentielPlugin } from './referentiel/plugin.js';
import { canauxPlugin } from './canaux/plugin.js';
import { apprentissagePlugin } from './apprentissage/plugin.js';
import { terrainPlugin } from './terrain/plugin.js';
import { integritePlugin } from './integrite/plugin.js';
import { integriteGouvernancePlugin } from './integrite/gouvernance/plugin.js';
import { integriteSecuritePlugin } from './integrite/securite/plugin.js';
import { pilotagePlugin } from './pilotage/plugin.js';
import { repartitionPlugin } from './pilotage/repartition/plugin.js';
import { planificationPlugin } from './pilotage/planification/plugin.js';
import { partageLegalPlugin } from './pilotage/partage-legal/plugin.js';
import { programmePlugin } from './pilotage/programme/plugin.js';
import { iaPlugin } from './ia/plugin.js';
import { opportunitesPlugin } from './opportunites/plugin.js';
import { iaModelesPlugin } from './ia/modeles.js';
import { preuvesPlugin } from './preuves/plugin.js';
import { sanctionsPlugin } from './sanctions/plugin.js';
import { soclePlugin } from './socle/plugin.js';
import { chainePlugin } from './chaine/plugin.js';
import { juridiquePlugin } from './juridique/plugin.js';
import { integriteDetecteursPlugin } from './integrite/detecteurs/plugin.js';
import { catalogueApiPlugin } from './catalogue-api/plugin.js';
import { vehiculesControlePlugin } from './vehicules-controle/plugin.js';
import { citoyenPlugin } from './citoyen/plugin.js';
import { decisionPlugin } from './decision/plugin.js';
import { plateformePlugin } from './plateforme/plugin.js';
import { accesDelegationsPlugin } from './acces/delegations-plugin.js';
import { equipementsPlugin } from './equipements/plugin.js';
import { grandsRedevablesPlugin } from './verticales/grands-redevables-plugin.js';

/**
 * Ordre : `acces` en tête (garde des revendications, mandats), puis `fiscal` (il branche les exonérations sur la liquidation), `titres` avant `rakapay`,
 * `parking` avant `publicite`, `preuves` après tous les modules qui émettent des preuves, `chaine` (lecture seule de la
 * chaîne opératoire) après tous les modules qu'elle relit, `socle` (authentification, limitation de débit) en dernier.
 */
export const DEFAULT_PLUGINS: MosoloPlugin<any>[] = [
  accesPlugin,
  fiscalPlugin,
  tresorPlugin,
  recouvrementPlugin,
  campagnesPlugin,
  titresPlugin,
  rakapayPlugin,
  parkingPlugin,
  publicitePlugin,
  verticalesPlugin,
  // Chaîne véhicule RFCK (modules 82 à 84) : après titres, fiscal et verticales (vignette, quitus, objet véhicule).
  vehiculesControlePlugin,
  referentielPlugin,
  canauxPlugin,
  // Apprentissage (§ 24) avant terrain : garde « certification avant affectation » et certificats de démonstration.
  apprentissagePlugin,
  terrainPlugin,
  integritePlugin,
  integriteGouvernancePlugin,
  integriteSecuritePlugin,
  pilotagePlugin,
  repartitionPlugin,
  planificationPlugin,
  programmePlugin,
  partageLegalPlugin,
  iaPlugin,
  opportunitesPlugin,
  iaModelesPlugin,
  preuvesPlugin,
  sanctionsPlugin,
  chainePlugin,
  juridiquePlugin,
  integriteDetecteursPlugin,
  // Routes françaises du catalogue des API (Cahier, ch. 31) : relais vers les routes canoniques de tous les modules.
  catalogueApiPlugin,
  // Parcours du citoyen (modules 1 à 12) : après fiscal, titres, verticales, canaux et terrain qu'il relit.
  citoyenPlugin,
  // Pilotage et décision (modules 41 à 47) : lit le pilotage, la planification, le Trésor et l'intégrité.
  decisionPlugin,
  // Accès et délégations (module 51) : délégations, ABAC expliqué, détections, révocation à la fin d'une affectation.
  accesDelegationsPlugin,
  // Grands redevables (module 56) : portefeuille, gestionnaire dédié et rotation, conventions, journal des décisions.
  grandsRedevablesPlugin,
  // Gestion des équipements terrain (module 58) : MDM, attestation, expiration des données, appareil modifié.
  equipementsPlugin,
  // Plateforme (modules 52, 53, 55) : API partenaires, administration, supervision — avant le socle (limitation de débit).
  plateformePlugin,
  soclePlugin,
];
