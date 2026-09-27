/** Liste des modules d'extension chargés par défaut (ordre = ordre de construction). */
import type { MosoloPlugin } from './types.js';
import { accesPlugin } from './acces/plugin.js';
import { fiscalPlugin } from './fiscal/plugin.js';
import { tresorPlugin } from './tresor/plugin.js';
import { recouvrementPlugin } from './recouvrement/plugin.js';
import { titresPlugin } from './titres/plugin.js';
import { rakapayPlugin } from './rakapay/plugin.js';
import { parkingPlugin } from './parking/plugin.js';
import { publicitePlugin } from './publicite/plugin.js';
import { verticalesPlugin } from './verticales/plugin.js';
import { canauxPlugin } from './canaux/plugin.js';
import { terrainPlugin } from './terrain/plugin.js';
import { integritePlugin } from './integrite/plugin.js';
import { pilotagePlugin } from './pilotage/plugin.js';
import { iaPlugin } from './ia/plugin.js';
import { preuvesPlugin } from './preuves/plugin.js';
import { sanctionsPlugin } from './sanctions/plugin.js';
import { soclePlugin } from './socle/plugin.js';

/**
 * Ordre : `acces` en tête (garde des revendications, mandats), puis `fiscal` (il branche les exonérations sur la liquidation), `titres` avant `rakapay`,
 * `parking` avant `publicite`, `preuves` après tous les modules qui émettent des preuves, `socle` (authentification, limitation de débit) en dernier.
 */
export const DEFAULT_PLUGINS: MosoloPlugin<any>[] = [
  accesPlugin,
  fiscalPlugin,
  tresorPlugin,
  recouvrementPlugin,
  titresPlugin,
  rakapayPlugin,
  parkingPlugin,
  publicitePlugin,
  verticalesPlugin,
  canauxPlugin,
  terrainPlugin,
  integritePlugin,
  pilotagePlugin,
  iaPlugin,
  preuvesPlugin,
  sanctionsPlugin,
  soclePlugin,
];
