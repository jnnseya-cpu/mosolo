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
  soclePlugin,
];
