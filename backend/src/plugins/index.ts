/** Liste des modules d'extension chargés par défaut (ordre = ordre de construction). */
import type { MosoloPlugin } from './types.js';
import { accesPlugin } from './acces/plugin.js';
import { fiscalPlugin } from './fiscal/plugin.js';
import { tresorPlugin } from './tresor/plugin.js';
import { tresorRelevesPlugin } from './tresor/releves.js';
import { documentsPlugin } from './documents/plugin.js';
import { communicationPlugin } from './communication/plugin.js';
import { indicateursModules2740Plugin } from './pilotage/indicateurs-modules-27-40.js';
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
import { moteurRepartitionPlugin } from './pilotage/repartition/moteur/plugin.js';
import { planificationPlugin } from './pilotage/planification/plugin.js';
import { partageLegalPlugin } from './pilotage/partage-legal/plugin.js';
import { programmePlugin } from './pilotage/programme/plugin.js';
import { recetteProgrammePlugin } from './pilotage/recette-programme/plugin.js';
import { iaPlugin } from './ia/plugin.js';
import { opportunitesPlugin } from './opportunites/plugin.js';
import { iaModelesPlugin } from './ia/modeles.js';
import { preuvesPlugin } from './preuves/plugin.js';
import { sanctionsPlugin } from './sanctions/plugin.js';
import { accesMontantsPlugin } from './acces-montants/plugin.js';
import { soclePlugin } from './socle/plugin.js';
import { chainePlugin } from './chaine/plugin.js';
import { juridiquePlugin } from './juridique/plugin.js';
import { integriteDetecteursPlugin } from './integrite/detecteurs/plugin.js';
import { catalogueApiPlugin } from './catalogue-api/plugin.js';
import { postesPlugin } from './postes/plugin.js';
import { vehiculesControlePlugin } from './vehicules-controle/plugin.js';
import { citoyenPlugin } from './citoyen/plugin.js';
import { decisionPlugin } from './decision/plugin.js';
import { plateformePlugin } from './plateforme/plugin.js';
import { accesDelegationsPlugin } from './acces/delegations-plugin.js';
import { accesDepartementsPlugin } from './acces/departements-plugin.js';
import { equipementsPlugin } from './equipements/plugin.js';
import { grandsRedevablesPlugin } from './verticales/grands-redevables-plugin.js';
import { integriteEnquetesPlugin } from './integrite/enquetes/plugin.js';

/**
 * Ordre : `acces` en tête (garde des revendications, mandats), puis `fiscal` (il branche les exonérations sur la liquidation), `titres` avant `rakapay`,
 * `parking` avant `publicite`, `preuves` après tous les modules qui émettent des preuves, `chaine` (lecture seule de la
 * chaîne opératoire) après tous les modules qu'elle relit, `socle` (authentification, limitation de débit) en dernier.
 */
export const DEFAULT_PLUGINS: MosoloPlugin<unknown>[] = [
  accesPlugin,
  fiscalPlugin,
  tresorPlugin,
  // Dépôt des fichiers de relevés (module 29) : file commune des imports à double validation.
  tresorRelevesPlugin,
  // Gestion documentaire (module 38) : stockage chiffré, versions, sceau, OCR, conservation, exports filigranés.
  documentsPlugin,
  // Notifications et communication (module 39) : modèles versionnés, préférences, accusés, canal de secours, avis sur plaque.
  communicationPlugin,
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
  // Renseignement anti-fraude (module 40) : signaux, scores explicables, suspension conservatoire, transmission.
  integriteEnquetesPlugin,
  integriteGouvernancePlugin,
  integriteSecuritePlugin,
  pilotagePlugin,
  repartitionPlugin,
  // Moteur de paiement, de règlement et de répartition (spécifications du 29/09/2026) : par-dessus la clé du § 37A.
  moteurRepartitionPlugin,
  planificationPlugin,
  programmePlugin,
  partageLegalPlugin,
  // Programme (Document maître FR 2, ch. 41–48) : après planification (circuit des instructions) et pilotage.
  recetteProgrammePlugin,
  iaPlugin,
  opportunitesPlugin,
  iaModelesPlugin,
  preuvesPlugin,
  sanctionsPlugin,
  // Accès aux montants sur autorisation préalable de la direction (décision du 29/09/2026).
  accesMontantsPlugin,
  chainePlugin,
  juridiquePlugin,
  integriteDetecteursPlugin,
  // Postes de décision des autorités et postes de travail (Cahier nouvelle version, ch. 27 ; catalogue n° 41 à 44) :
  // lecture seule des circuits de tous les modules ci-dessus, relais vers leurs routes de décision existantes.
  postesPlugin,
  // Routes françaises du catalogue des API (Cahier, ch. 31) : relais vers les routes canoniques de tous les modules.
  catalogueApiPlugin,
  // Parcours du citoyen (modules 1 à 12) : après fiscal, titres, verticales, canaux et terrain qu'il relit.
  citoyenPlugin,
  // Pilotage et décision (modules 41 à 47) : lit le pilotage, la planification, le Trésor et l'intégrité.
  decisionPlugin,
  // Accès et délégations (module 51) : délégations, ABAC expliqué, détections, révocation à la fin d'une affectation.
  accesDelegationsPlugin,
  // Types de comptes, contrats de partenariat, mandataires, modules et variables par département (27/09/2026).
  accesDepartementsPlugin,
  // Grands redevables (module 56) : portefeuille, gestionnaire dédié et rotation, conventions, journal des décisions.
  grandsRedevablesPlugin,
  // Gestion des équipements terrain (module 58) : MDM, attestation, expiration des données, appareil modifié.
  equipementsPlugin,
  // Plateforme (modules 52, 53, 55) : API partenaires, administration, supervision — avant le socle (limitation de débit).
  plateformePlugin,
  soclePlugin,
  // Indicateurs des modules 27 à 40 (spécification fonctionnelle) : lecture seule, après tous les modules.
  indicateursModules2740Plugin,
];
