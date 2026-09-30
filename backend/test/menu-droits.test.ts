/**
 * Deuxième passe adverse (27/09/2026), menu et droits : pour chaque rôle de démonstration, CHAQUE entrée visible de
 * son menu doit pouvoir lire sa donnée principale (lecture principale de l'écran → 2xx). Les entrées dont la lecture
 * est refusée sont masquées du menu (présentation seulement, shared/src/menu.ts) : aucune route, page ni droit retiré,
 * aucun droit élargi.
 *
 * Le menu est reconstitué depuis le code de l'application web (components/Shell.tsx : menu principal et sections par
 * rôle ; modules/registry.tsx : entrées des modules) ; la lecture principale de chaque écran est relevée ci-dessous
 * (premier chargement de la page). Toute nouvelle entrée de menu doit y figurer, sinon ce test échoue.
 */
import { readFileSync } from 'node:fs';
import { menuMasque, ROLES } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';

const FRONT = new URL('../../frontend/src/', import.meta.url);

/**
 * Lectures de chaque écran du menu (chargements GET de la page et de ses onglets, relevés dans le code) ; {taxpayerId} :
 * contribuable de l'utilisateur. L'entrée est « lisible » si au moins une lecture aboutit (la page affiche des données) ;
 * une entrée dont TOUTES les lectures sont refusées afficherait « accès refusé » : elle doit être masquée du menu.
 */
const LECTURES: Record<string, string[]> = {
  '/acces/arbitrages': ['/v1/legal-rules', '/v1/acces/arbitrations'],
  '/acces/consultation': ['/v1/acces/consultations'],
  '/acces/delegations': ['/v1/acces/delegations'],
  '/acces/departements': ['/v1/acces/departements', '/v1/acces/catalogue-modules'],
  '/acces/elevations': ['/v1/acces/elevations'],
  '/acces/entites': ['/v1/acces/entities', '/v1/acces/modules', '/v1/acces/levels'],
  '/acces/identite': ['/v1/acces/identity-proofs', '/v1/acces/duplicates'],
  '/acces/invitations': ['/v1/acces/me', '/v1/acces/levels', '/v1/acces/entities', '/v1/acces/modules', '/v1/acces/invitations', '/v1/acces/accounts', '/v1/acces/grants', '/v1/acces/journal'],
  '/acces/mandats': ['/v1/acces/mandates', '/v1/taxpayers/{taxpayerId}'],
  '/acces/types-de-comptes': ['/v1/acces/types-de-comptes'],
  '/agents/reserve': ['/v1/agents/reserve?period=2026-09', '/v1/terrain/points-resultats'],
  '/agents/surveillance': ['/v1/agents/monitoring', '/v1/agents/counter-checks'],
  '/agents/validation-commissions': ['/v1/agents/commission-validations'],
  '/application': ['/v1/titres'],
  '/apprentissage': ['/v1/apprentissage/espace'],
  '/apprentissage/certifications': ['/v1/apprentissage/certifications', '/v1/apprentissage/contenus', '/v1/apprentissage/indicateurs'],
  '/apprentissage/procedures': ['/v1/apprentissage/procedures'],
  '/audit': ['/v1/audit/verify', '/v1/audit/events', '/v1/appeals/indicateurs'],
  '/canaux/enrolement': ['/v1/assisted-enrolments'],
  '/canaux/jour-de-caisse': ['/v1/payment-points'],
  '/canaux/point-agree': ['/v1/payment-points/mine'],
  '/canaux/points-supervision': ['/v1/payment-points', '/v1/channels/indicators'],
  '/chaine': ['/v1/integrite/chaine/ruptures'],
  '/citoyen/activites': ['/v1/citoyen/activites'],
  '/citoyen/cadastre': ['/v1/citoyen/cadastre/superpositions'],
  '/citoyen/indicateurs': ['/v1/citoyen/indicateurs'],
  '/citoyen/locatif': ['/v1/citoyen/locatif/couverture?niveau=commune', '/v1/citoyen/locatif/indicateurs', '/v1/citoyen/locatif/couverture?niveau=COMMUNE'],
  '/citoyen/pieces': ['/v1/citoyen/enrolement/pieces/revues'],
  '/citoyen/relations': ['/v1/citoyen/relations/revues', '/v1/citoyen/relations/indicateurs'],
  '/citoyen/transport': ['/v1/citoyen/transport/autorisations'],
  '/citoyen/vehicules': ['/v1/citoyen/vehicules'],
  '/communication/notifications': ['/v1/communication/modeles', '/v1/communication/avis-plaque', '/v1/communication/indicateurs'],
  '/communications': ['/v1/communications/overview'],
  '/connexion': ['/v1/auth/demo-accounts'],
  '/controle/calcu': ['/v1/verticales/calcu/overview'],
  '/controle/calcu/organe': ['/v1/verticales/calcu/organe'],
  '/decision/audit': ['/v1/decision/audit/missions'],
  // Écrans des postes de décision et de la plateforme (29/09/2026) : déclarés par `.then(...)` dans le registre, jusqu'ici
  // non relevés par l'analyse du menu (expression régulière élargie ci-dessous).
  '/decision/regie-fiscale': ['/v1/decision/regie-fiscale'],
  '/decision/regie-taxes': ['/v1/decision/regie-taxes'],
  '/decision/ministere': ['/v1/decision/ministere', '/v1/decision/ministeres'],
  '/decision/salle-controle': ['/v1/decision/salle-controle'],
  '/decision/previsions': ['/v1/decision/previsions'],
  '/plateforme/partenaires': ['/v1/plateforme/partenaires'],
  '/plateforme/administration': ['/v1/plateforme/administration'],
  '/plateforme/supervision': ['/v1/plateforme/supervision'],
  '/decision/commandement': ['/v1/decision/commandement/rapport'],
  '/documents': ['/v1/documents', '/v1/documents/categories', '/v1/documents/indicateurs', '/v1/documents/purges/apercu'],
  '/donnees/extractions': ['/v1/socle/exports/requests'],
  '/espace': ['/v1/taxpayers/{taxpayerId}'],
  '/espace/biens-relations': ['/v1/moi/relations-biens', '/v1/compte-unique/me'],
  '/biens-relations/revue': ['/v1/dossiers-revue'],
  '/fiscal/anomalies-locatives': ['/v1/fiscal/anomalies/catalogue'],
  '/fiscal/assiette-2026': ['/v1/fiscal/assiette-2026'],
  '/fiscal/biens': ['/v1/fiscal/relationships/queue', '/v1/fiscal/reference'],
  '/fiscal/carte': ['/v1/fiscal/map?layer=objets', '/v1/fiscal/couches'],
  '/fiscal/corrections': ['/v1/fiscal/objects', '/v1/fiscal/object-corrections?status=EN_ATTENTE'],
  '/fiscal/declarations': ['/v1/fiscal/objects'],
  '/fiscal/dependances': ['/v1/fiscal/dependencies', '/v1/public/fiscal/dependances'],
  '/fiscal/exonerations': ['/v1/fiscal/reference', '/v1/fiscal/exemptions'],
  '/fiscal/quitus': ['/v1/fiscal/clearances/eligibility', '/v1/fiscal/clearances', '/v1/fiscal/clearances/review'],
  '/fiscal/recensement': ['/v1/fiscal/census/coverage', '/v1/fiscal/census/stages'],
  '/fiscal/reprise': ['/v1/fiscal/imports'],
  '/gouverneur': ['/v1/pilotage/tableaux/gouverneur'],
  '/grands-redevables': ['/v1/grands-redevables'],
  '/ia': ['/v1/ia/inbox'],
  '/ia/journal': ['/v1/ia/journal'],
  '/ia/modeles': ['/v1/ia/modeles'],
  '/integrite/cles': ['/v1/integrite/key-health'],
  '/integrite/collusion': ['/v1/integrite/collusion'],
  '/integrite/controles-mystere': ['/v1/public/integrite/summary', '/v1/integrite/mystery-checks'],
  '/integrite/detecteurs': ['/v1/integrite/detecteurs'],
  '/integrite/donnees': ['/v1/integrite/privacy/requests', '/v1/integrite/privacy/registry'],
  '/integrite/enquetes': ['/v1/integrite/indicators'],
  '/integrite/incidents': ['/v1/integrite/incidents'],
  '/integrite/renseignement': ['/v1/integrite/scores', '/v1/integrite/suspensions-conservatoires', '/v1/integrite/cases', '/v1/integrite/transmissions', '/v1/integrite/renseignement/indicateurs'],
  '/integrite/revue-acces': ['/v1/integrite/access-reviews'],
  '/integrite/scellement': ['/v1/integrite/scellement'],
  '/integrite/seuils': ['/v1/integrite/thresholds'],
  '/integrite/surveillance-technique': ['/v1/integrite/appareils'],
  '/juridique/donnees': ['/v1/juridique/donnees/classification'],
  '/juridique/points': ['/v1/juridique/points'],
  '/liquidation/derogations': ['/v1/assessments/base-overrides'],
  '/mes-arrieres': ['/v1/recouvrement/mes-arrieres'],
  '/mes-gains': ['/v1/agents/me/earnings', '/v1/agents/earnings'],
  '/mes-preferences': ['/v1/communication/preferences/{taxpayerId}'],
  '/mes-proces-verbaux': ['/v1/terrain/proces-verbaux/mes-proces-verbaux'],
  '/mon-espace/profils': ['/v1/enrolement/roles', '/v1/public/enrolement/profils'],
  '/opportunites': ['/v1/opportunites/decouverte/signaux-ia', '/v1/opportunites-indicateurs'],
  '/opportunites/maximisation': ['/v1/opportunites-maximisation/classement', '/v1/opportunites-maximisation/cas-usage', '/v1/opportunites-leviers'],
  '/opportunites/recoupement': ['/v1/recoupement/sources', '/v1/recoupement/blocages', '/v1/recoupement/liste-travail'],
  '/pilotage/accords-service': ['/v1/pilotage/accords-service'],
  '/pilotage/assignations': ['/v1/pilotage/assignations'],
  '/pilotage/base-reference': ['/v1/pilotage/base-reference', '/v1/pilotage/ranv'],
  '/pilotage/cent-jours': ['/v1/pilotage/programme/cent-jours'],
  '/pilotage/decisions-gouvernement': ['/v1/pilotage/programme/decisions'],
  // Console « Clés et raccordements » (29/09/2026) : R26 et R28 seulement.
  '/plateforme/cles': ['/v1/integrations/keys', '/v1/integrations/proposals', '/v1/integrations/webhooks'],
  '/pilotage/feuille-de-route': ['/v1/pilotage/feuille-de-route', '/v1/pilotage/modele-operationnel', '/v1/pilotage/gouvernance'],
  '/pilotage/indicateurs': ['/v1/pilotage/indicateurs'],
  '/pilotage/indicateurs-modules-27-40': ['/v1/pilotage/indicateurs-modules/27-40'],
  '/pilotage/instructions': ['/v1/pilotage/instructions'],
  '/pilotage/partage-legal': ['/v1/legal-shares/keys', '/v1/legal-shares', '/v1/legal-shares/incitations'],
  '/pilotage/pilote': ['/v1/pilotage/pilote'],
  '/pilotage/piste-audit': ['/v1/pilotage/piste-audit'],
  '/pilotage/projets': ['/v1/pilotage/projets'],
  '/pilotage/recette': ['/v1/pilotage/programme/recette'],
  '/pilotage/reductions': ['/v1/pilotage/reductions'],
  '/pilotage/repartition': ['/v1/pilotage/repartition', '/v1/pilotage/repartition/cle'],
  '/pilotage/moteur-repartition': ['/v1/pilotage/moteur-repartition/tableau/executif', '/v1/pilotage/moteur-repartition/tableau/entite', '/v1/pilotage/moteur-repartition/tableau/groupe-nseya', '/v1/pilotage/moteur-repartition/tableau/sous-traitant', '/v1/pilotage/moteur-repartition/tableau/agent', '/v1/pilotage/moteur-repartition/regles'],
  '/mes-preuves': ['/v1/moi/preuves'],
  '/pilotage/acces-montants': ['/v1/acces-montants'],
  '/executive/finance': ['/v1/pilotage/moteur-repartition/tableau/executif'],
  '/groupe-nseya/command-centre': ['/v1/pilotage/moteur-repartition/tableau/groupe-nseya', '/v1/pilotage/moteur-repartition/tableau/executif'],
  '/platform-admin/finance/allocation-rules': ['/v1/pilotage/moteur-repartition/regles', '/v1/pilotage/moteur-repartition/configuration'],
  '/subcontractor/finance': ['/v1/pilotage/moteur-repartition/tableau/sous-traitant'],
  '/pilotage/risques': ['/v1/pilotage/programme/risques'],
  '/pilotage/scenarios': ['/v1/pilotage/scenarios', '/v1/pilotage/scenarios/hypotheses', '/v1/pilotage/scenarios/exemple-illustratif'],
  '/pilotage/tableaux': ['/v1/pilotage/tableaux', '/v1/pilotage/base-reference', '/v1/pilotage/ranv', '/v1/pilotage/instructions'],
  '/pilotage/versions': ['/v1/pilotage/programme/versions'],
  '/points-de-paiement': ['/v1/public/payment-points'],
  '/poste-de-decision': ['/v1/postes/accueil'],
  '/poste-de-travail': ['/v1/postes/travail'],
  '/publicite': ['/v1/publicite/authorizations/mine', '/v1/publicite/obligations/mine', '/v1/publicite/cases/mine', '/v1/publicite/devices/mine'],
  '/publicite/carte': ['/v1/publicite/carte/couches', '/v1/publicite/pilote', '/v1/publicite/ia/propositions', '/v1/publicite/signalements'],
  '/publicite/contrats': ['/v1/publicite/echeances'],
  '/publicite/inspection': ['/v1/publicite/inventory', '/v1/publicite/cases?status=CONSTATE', '/v1/publicite/inspections'],
  '/publicite/regie': ['/v1/publicite/liquidations/pending', '/v1/publicite/authorizations', '/v1/publicite/cases', '/v1/publicite/accreditations'],
  '/publicite/tableau-de-bord': ['/v1/publicite/indicators'],
  '/rakapay/cooperative': ['/v1/rakapay/cooperatives'],
  '/rakapay/operateurs': ['/v1/rakapay/operateurs', '/v1/rakapay/offres', '/v1/rakapay/circuits', '/v1/rakapay/periode-grace'],
  '/rakapay/pilotage': ['/v1/rakapay/signalements', '/v1/rakapay/indicateurs', '/v1/rakapay/periode-grace'],
  '/recours': ['/v1/appeals', '/v1/appeals/indicateurs'],
  '/recouvrement': ['/v1/recouvrement/arrieres'],
  '/recouvrement/campagnes': ['/v1/prorogations', '/v1/campagnes', '/v1/campagnes/calendrier', '/v1/campagnes-recouvrement'],
  '/recouvrement/non-valeurs': ['/v1/recouvrement/non-valeurs'],
  '/recouvrement/remises': ['/v1/recouvrement/remises'],
  '/recouvrement/rendement': ['/v1/recouvrement/rendement'],
  '/recuperation-compte': ['/v1/enrolement/recuperations'],
  '/referentiel/modele-donnees': ['/v1/referentiel/modele-donnees', '/v1/referentiel/matrice-habilitations'],
  '/referentiel/recettes': ['/v1/referentiel/codes', '/v1/public/referentiel/recettes'],
  '/registre': ['/v1/legal-instruments', '/v1/legal-rules'],
  '/satisfaction': ['/v1/satisfaction'],
  '/simulateurs': ['/v1/public/simulateurs', '/v1/public/informations'],
  '/stationnement': ['/v1/parking/zones', '/v1/parking/reservations/mine', '/v1/parking/violations/mine', '/v1/parking/partners', '/v1/parking/exemptions'],
  '/stationnement/controle': ['/v1/parking/zones', '/v1/parking/exemptions'],
  '/stationnement/parksmart': ['/v1/parking/tarification-dynamique', '/v1/parking/tariff-modes'],
  '/stationnement/regie': ['/v1/parking/violations', '/v1/parking/reservations', '/v1/parking/zones', '/v1/agents/me/earnings', '/v1/agents/earnings', '/v1/parking/exemptions'],
  '/stationnement/tableau-de-bord': ['/v1/parking/indicators', '/v1/agents/me/earnings', '/v1/agents/earnings'],
  '/terrain': ['/v1/terrain/me'],
  '/terrain/equipements': ['/v1/equipements'],
  '/terrain/inspection': ['/v1/terrain/proces-verbaux', '/v1/terrain/inspection/indicateurs', '/v1/terrain/missions'],
  '/terrain/qualite': ['/v1/terrain/qualite'],
  '/terrain/sous-traitants': ['/v1/terrain/mystery-checks', '/v1/terrain/subcontractors', '/v1/terrain/agents', '/v1/terrain/lots', '/v1/agents/reserve?period=2026-09', '/v1/terrain/points-resultats'],
  '/terrain/supervision': ['/v1/terrain/indicators', '/v1/terrain/missions', '/v1/terrain/findings', '/v1/terrain/agents', '/v1/terrain/lots', '/v1/terrain/quality', '/v1/terrain/counter-visits'],
  '/titres/catalogue': ['/v1/titres/indicateurs', '/v1/titres/types'],
  '/titres/controle': ['/v1/titres/constats'],
  '/anti-fraude/preuves': ['/v1/titres/fraudes'],
  '/transparence': ['/v1/public/transparency', '/v1/public/transparence/repartition/2026-09'],
  '/tresor': ['/v1/ledger/balance', '/v1/tresor/grand-livre/indicateurs', '/v1/beneficiary-accounts'],
  '/tresor/appariements': ['/v1/tresor/appariements'],
  '/tresor/points-agrees': ['/v1/tresor/points'],
  '/tresor/prestataires': ['/v1/providers/connectors'],
  '/vehicules/centres-agrees': ['/v1/centres-agrees', '/v1/centres-agrees/analytique'],
  '/vehicules/controle-technique': ['/v1/vehicules/indicateurs', '/v1/vehicules/referentiel', '/v1/vehicules/controles-techniques', '/v1/vehicules/vignettes-securisees', '/v1/vehicules/courtoisie'],
  '/vehicules/fourrieres': ['/v1/vehicules/indicateurs', '/v1/fourrieres/dossiers', '/v1/fourrieres/sites', '/v1/fourrieres/rapprochement', '/v1/fourrieres/priorisation'],
  '/vehicules/mes-vehicules': ['/v1/vehicules/mes-vehicules'],
  '/vehicules/rfck': ['/v1/rfck/entite', '/v1/rfck/flux', '/v1/rfck/integration', '/v1/rfck/domaine', '/v1/rfck/chiffres-publies'],
  '/vehicules/scan': ['/v1/vehicules/hors-ligne/paquet'],
  '/verifier-agent': ['/v1/public/terrain/mystery-checks/summary'],
  '/verticales/actifs': ['/v1/verticales/actifs', '/v1/verticales/actifs/revenus'],
  '/verticales/console': ['/v1/verticales/avia/declarations', '/v1/verticales/avia/overview', '/v1/verticales/telecom/reconciliation', '/v1/verticales/indicators', '/v1/verticales/avia/rrh/overview', '/v1/verticales/avia/rrh/reconciliations', '/v1/verticales/avia/cadre', '/v1/verticales/avia/auto', '/v1/verticales/avia/auto/executions', '/v1/verticales/nfiu/habilitations'],
  '/verticales/environnement': ['/v1/verticales/environnement/registre'],
  '/verticales/fiches': ['/v1/verticales/plastique', '/v1/verticales/fiches/indicateurs'],
  '/verticales/secteurs': ['/v1/verticales/secteurs/declarations', '/v1/verticales/domaine-public/emprises', '/v1/verticales/secteurs'],
  // Trousse de visualisation (27/09/2026) : la galerie lit l'échelle unifiée, les indicateurs et la ventilation mensuelle.
  '/visualisation/galerie': ['/v1/pilotage/echelle', '/v1/pilotage/indicateurs', '/v1/pilotage/drill/month'],
};
/** Entrées sans lecture principale au chargement (formulaire public, saisie préalable, simulateur, page statique). */
const SANS_LECTURE = new Set([
  '/', '/inscription', '/verifier', '/services', '/connexion', '/autour-de-moi', '/preuve', '/canaux/whatsapp-sms', '/canaux/ussd',
  '/canaux/contestation', '/publicite/signaler', '/signaler', '/vehicules/verifier', '/mon-espace/situation', '/recuperation-compte',
  // Écrans de DÉPÔT (formulaire) et de revue : le dépôt reste possible au rôle même si la file de revue lui est refusée.
  '/acces/identite', '/citoyen/pieces', '/satisfaction',
  // Parcours par rôle (29/09/2026) : page d'information de l'application (téléchargement, parcours) ; la liste des titres
  // n'y apparaît que pour le contribuable — l'écran s'affiche sans elle pour les autres comptes (navigateur réel).
  '/application',
]);

/**
 * Parcours par rôle (29/09/2026) : lecture qui DÉCIDE de l'écran (l'écran affiche « accès réservé » si elle est
 * refusée, relevé dans le navigateur réel), quand ce n'est pas la première lecture listée ci-dessus. Pour les autres
 * écrans, la lecture principale est satisfaite si l'une des lectures aboutit (écrans adaptés au rôle).
 */
const LECTURE_DECISIVE: Record<string, string> = {
  '/stationnement/parksmart': '/v1/parking/occupancy',
  '/stationnement/regie': '/v1/parking/reservations',
  '/stationnement/tableau-de-bord': '/v1/parking/indicators',
  '/tresor': '/v1/tresor/overview',
  '/terrain/sous-traitants': '/v1/terrain/points-resultats',
  '/verticales/fiches': '/v1/verticales/fiches/indicateurs',
  '/rakapay/pilotage': '/v1/rakapay/indicateurs',
  '/fiscal/recensement': '/v1/fiscal/census/coverage',
  '/audit': '/v1/audit/events',
};
/**
 * Écrans dont la lecture listée est refusée mais qui restent utiles au rôle (lecture partielle assumée, relevée dans
 * le navigateur réel le 29/09/2026) : registre du coffre sur l'écran du Trésor (R19) ; « Sept questions » sans la liste
 * des ruptures (R06, R07, R11) ; cadastre par objet de son territoire (R09) ; indicateurs d'enquêtes présentés sans le
 * tableau réservé (R06, R21).
 */
const PARTIEL_ASSUME: [string, string][] = [
  ['R19', '/tresor'], ['R06', '/chaine'], ['R07', '/chaine'], ['R11', '/chaine'], ['R09', '/citoyen/cadastre'],
  ['R06', '/integrite/enquetes'], ['R21', '/integrite/enquetes'],
];
/**
 * Rôles parcourus par le premier audit (Playwright, 9 rôles) : l'alignement y est EXIGÉ. Pour les autres rôles, les
 * écarts sont relevés dans le rapport (sortie du test) : ils dépendent souvent de l'ENTITÉ (ex. directeur général de la
 * DGIPK et écrans de la DGTK ou de la RFCK), qu'un menu par rôle ne peut pas exprimer — arbitrage demandé.
 */
const ROLES_AUDITES = ['R02', 'R03', 'R04', 'R05', 'R10', 'R17', 'R22', 'R30'];

/**
 * Écarts relevés le 27/09/2026 hors des rôles audités (entités) : ne doit pas augmenter. 78 le 27/09/2026 ; ramené le
 * 29/09/2026 (parcours par rôle : masques par rôle ET par entité) aux seuls écrans dont une lecture renvoie 400
 * (saisie préalable attendue, ex. choix d'un contribuable au guichet) — aucun refus 403 (voir le test suivant).
 */
const ECARTS_AUTRES_ROLES_MAX = 2;

interface Entry { path: string; roles: string[] | null }

function parseMenu() {
  const shell = readFileSync(new URL('components/Shell.tsx', FRONT), 'utf8');
  const registry = readFileSync(new URL('modules/registry.tsx', FRONT), 'utf8');
  const consts = new Map<string, string[]>();
  for (const m of registry.matchAll(/^const (\w+) = \[([^\]]*)\];/gm)) consts.set(m[1]!, [...m[2]!.matchAll(/'(R\d{2})'/g)].map((x) => x[1]!));
  // 29/09/2026 : les entrées déclarées par `import(...).then((m) => ({ default: m.X }))` (postes de décision, plateforme)
  // sont désormais relevées aussi.
  const modules: Entry[] = [...registry.matchAll(/\{ path: '([^']+)', element: lazy\(\(\) => import\('[^']+'\)(?:\.then\(\(m\) => \(\{ default: m\.\w+ \}\)\))?\), nav: \{[^}]*roles: (\[[^\]]*\]|[A-Z_]+)/g)].map((m) => ({
    path: m[1]!, roles: m[2]!.startsWith('[') ? [...m[2]!.matchAll(/'(R\d{2})'/g)].map((x) => x[1]!) : consts.get(m[2]!) ?? [],
  }));
  const core = [...shell.slice(shell.indexOf('export const NAV'), shell.indexOf('const GROUPS')).matchAll(/to: '([^']+)'/g)].map((m) => m[1]!);
  const roleRoutes = [...shell.slice(shell.indexOf('const ROLE_ROUTES'), shell.indexOf('const PUBLIC_USER_ROLES')).matchAll(/\[\[([^\]]*)\], \[([^\]]*)\]\]/g)]
    .map((m) => [[...m[1]!.matchAll(/'(R\d{2})'/g)].map((x) => x[1]!), [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)] as [string[], string[]]);
  const publicRoles = [...(/const PUBLIC_USER_ROLES = \[([^\]]*)\]/.exec(shell)?.[1] ?? '').matchAll(/'(R\d{2})'/g)].map((x) => x[1]!);
  return { modules, core, roleRoutes, publicRoles };
}

/** Même calcul que visibleNav (components/Shell.tsx), masque de présentation compris (entité facultative, 29/09/2026). */
function visible(menu: ReturnType<typeof parseMenu>, roles: string[], entity?: string): string[] {
  const allowed = new Set<string>(['/']);
  for (const [rs, routes] of menu.roleRoutes) if (roles.some((r) => rs.includes(r))) routes.forEach((x) => allowed.add(x));
  if (allowed.size === 1) allowed.add('/verifier');
  const core = menu.core.filter((p) => allowed.has(p));
  const isPublicUser = roles.length === 0 || roles.some((r) => menu.publicRoles.includes(r));
  const extra = menu.modules.filter((n) => (n.roles!.length === 0 ? isPublicUser : n.roles!.some((r) => roles.includes(r)))).map((n) => n.path);
  return [...core, ...extra].filter((p) => !menuMasque(p, roles, entity));
}

describe('Menu aligné sur les droits de lecture', () => {
  it('pour chaque rôle de démonstration, chaque entrée visible lit sa donnée principale (2xx)', async () => {
    const menu = parseMenu();
    expect(menu.modules.length).toBeGreaterThan(100);
    expect(menu.core).toContain('/gouverneur');
    const app = buildApp({ clock: new ManualClock('2026-09-27T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    const users = app.ctx.users.all();
    const failures: string[] = [];
    const others: string[] = [];
    const missing = new Set<string>();
    let checked = 0;
    const roles = Object.keys(ROLES).filter((r) => r !== 'R01');
    for (const role of roles) {
      // Un compte de démonstration portant ce seul rôle (sinon le premier qui le porte). Conversion justifiée : le code
      // de rôle vient du catalogue partagé (chaîne) ; la liste des rôles d'un utilisateur est typée par ce catalogue.
      const u = users.find((x) => x.roles.length === 1 && x.roles[0] === role) ?? users.find((x) => (x.roles as string[]).includes(role));
      if (!u) continue;
      for (const path of visible(menu, u.roles, u.entity)) {
        if (SANS_LECTURE.has(path)) continue;
        // Lecture partielle assumée (29/09/2026, relevée dans le navigateur réel) : voir PARTIEL_ASSUME.
        if (PARTIEL_ASSUME.some(([r, p]) => p === path && (u.roles as string[]).includes(r))) continue;
        const reads = LECTURES[path];
        if (!reads) { missing.add(path); continue; }
        const outcomes: string[] = [];
        let ok = false;
        for (const read of reads) {
          if (read.includes('{taxpayerId}') && !u.taxpayerId) continue;
          const url = read.replace('{taxpayerId}', encodeURIComponent(u.taxpayerId ?? ''));
          const res = await app.inject({ method: 'GET', url, headers: { 'x-demo-user': u.id } });
          checked++;
          if (res.statusCode < 400) { ok = true; break; }
          outcomes.push(`${url} → ${res.statusCode} ${String(res.json().code ?? '')}`);
        }
        if (!ok && outcomes.length) (ROLES_AUDITES.includes(role) ? failures : others).push(`${role} (${u.id}) : ${path} — ${outcomes.join(' ; ')}`);
      }
    }
    console.log(JSON.stringify({ rapport: 'menu ↔ droits de lecture', roles: roles.length, lectures: checked, echecs: failures, ecartsAutresRoles: others.length, autresRoles: others }, null, 1));
    expect([...missing]).toEqual([]);
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(200);
    // Écarts des autres rôles : bornés (non régression) en attendant l'arbitrage d'un menu par entité.
    expect(others.length).toBeLessThanOrEqual(ECARTS_AUTRES_ROLES_MAX);
  }, 300_000);

  it('parcours par rôle (29/09/2026) : pour CHAQUE compte de démonstration, aucune entrée de son menu n’est refusée (403) sur sa lecture principale', async () => {
    const menu = parseMenu();
    const app = buildApp({ clock: new ManualClock('2026-09-27T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    // Rattachements de modules aux entités (menu réel : /v1/acces/menu-rattachements).
    const dep = app.ctx.ext['acces-departements'] as { menuFor(u: unknown): { hiddenPaths: string[] } };
    const refus: string[] = [];
    const parRole = new Map<string, { comptes: number; entrees: number }>();
    let lectures = 0;
    for (const u of app.ctx.users.all()) {
      const roles = u.roles as string[];
      // Gouverneur, directeur de cabinet, secrétaire exécutif : tous les modules, écran « lecture agrégée » en cas de
      // refus (décision du 27/09/2026) — hors du périmètre de ce contrôle.
      if (!roles.length || roles.some((r) => ['R01', 'R02', 'R03'].includes(r))) continue;
      const cache = new Set(dep.menuFor(u).hiddenPaths);
      const entrees = visible(menu, roles, u.entity).filter((p) => !cache.has(p));
      const k = roles.join('+');
      const st = parRole.get(k) ?? { comptes: 0, entrees: 0 };
      parRole.set(k, { comptes: st.comptes + 1, entrees: st.entrees + entrees.length });
      for (const path of entrees) {
        if (SANS_LECTURE.has(path)) continue;
        if (PARTIEL_ASSUME.some(([r, p]) => p === path && roles.includes(r))) continue;
        const reads = LECTURE_DECISIVE[path] ? [LECTURE_DECISIVE[path]!] : LECTURES[path] ?? [];
        expect(reads.length, `lecture principale inconnue pour ${path}`).toBeGreaterThan(0);
        const statuts: number[] = [];
        for (const read of reads) {
          if (read.includes('{taxpayerId}') && !u.taxpayerId) continue;
          const res = await app.inject({ method: 'GET', url: read.replace('{taxpayerId}', encodeURIComponent(u.taxpayerId ?? '')), headers: { 'x-demo-user': u.id } });
          lectures++;
          statuts.push(res.statusCode);
          if (res.statusCode !== 403) break;
        }
        if (statuts.length && statuts.every((c) => c === 403)) refus.push(`${k} (${u.id}, ${u.entity}) : ${path}`);
      }
    }
    console.log(JSON.stringify({ rapport: 'parcours par rôle — menu de chaque compte', comptes: [...parRole.values()].reduce((a, b) => a + b.comptes, 0), lectures, refus }, null, 1));
    expect(refus).toEqual([]);
    expect(lectures).toBeGreaterThan(1000);
  }, 300_000);

  it('Gouverneur (R01) : les cinq vues de son menu se chargent', async () => {
    const app = buildApp({ clock: new ManualClock('2026-09-27T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    for (const url of ['/v1/postes/accueil', '/v1/postes/corbeille', '/v1/postes/vues/recettes', '/v1/postes/vues/alertes', '/v1/postes/vues/communes', '/v1/postes/recherche?q=Gombe']) {
      const r = await app.inject({ method: 'GET', url, headers: { 'x-demo-user': 'u-gouverneur' } });
      expect(r.statusCode, `${url} ${r.body.slice(0, 200)}`).toBe(200);
    }
  });

  it('entrées signalées par le premier audit : masquées pour ces rôles, pages et routes conservées', () => {
    const menu = parseMenu();
    const cases: [string[], string][] = [
      [['R17'], '/terrain/sous-traitants'], [['R10'], '/vehicules/fourrieres'], [['R10'], '/citoyen/cadastre'], [['R10'], '/citoyen/activites'],
      [['R10'], '/citoyen/vehicules'], [['R10'], '/citoyen/transport'], [['R30'], '/documents'], [['R30'], '/verticales/fiches'],
      [['R30'], '/rakapay/cooperative'], [['R03'], '/gouverneur'], [['R04'], '/gouverneur'], [['R05'], '/tresor'], [['R05'], '/rakapay/pilotage'],
      // Troisième passe (28/09/2026, D3-08) : écran d'audit entièrement refusé au super-administrateur.
      [['R26'], '/audit'],
    ];
    const registry = readFileSync(new URL('modules/registry.tsx', FRONT), 'utf8');
    for (const [roles, path] of cases) {
      expect(visible(menu, roles), `${roles} ${path}`).not.toContain(path);
      // La page reste déclarée (route conservée).
      expect(registry.includes(`path: '${path}'`) || readFileSync(new URL('App.tsx', FRONT), 'utf8').includes(`path="${path}"`), path).toBe(true);
    }
    // Un rôle qui lit la donnée garde l'entrée (aucun masque au-delà du nécessaire).
    expect(visible(menu, ['R06'])).toContain('/terrain/sous-traitants');
    expect(visible(menu, ['R17'])).toContain('/tresor');
  });

  it('parcours par rôle (29/09/2026) : masques par entité — l’entité exploitante garde l’entrée, les autres non', () => {
    const menu = parseMenu();
    // Publicité et stationnement : DGTK ; contrôle technique : RFCK ; régie fiscale : DGIPK.
    expect(visible(menu, ['R06'], 'DGTK')).toEqual(expect.arrayContaining(['/publicite/regie', '/stationnement/regie', '/decision/regie-taxes']));
    expect(visible(menu, ['R06'], 'DGIPK')).not.toContain('/publicite/regie');
    expect(visible(menu, ['R06'], 'DGIPK')).toContain('/decision/regie-fiscale');
    expect(visible(menu, ['R06'], 'DGTK')).not.toContain('/decision/regie-fiscale');
    expect(visible(menu, ['R07'], 'RFCK')).toContain('/vehicules/controle-technique');
    expect(visible(menu, ['R07'], 'DGIPK')).not.toContain('/vehicules/controle-technique');
    // Sans entité connue : seules les règles par rôle s'appliquent (comportement antérieur conservé).
    expect(visible(menu, ['R06'])).toContain('/publicite/regie');
    // Autorités R01–R03 : jamais concernées par ces masques.
    expect(visible(menu, ['R02'], 'GOUVERNORAT')).toEqual(expect.arrayContaining(['/publicite/tableau-de-bord', '/vehicules/rfck']));
    // Les pages restent déclarées (routes conservées).
    const registry = readFileSync(new URL('modules/registry.tsx', FRONT), 'utf8');
    for (const p of ['/publicite/regie', '/stationnement/regie', '/vehicules/controle-technique', '/decision/regie-fiscale', '/decision/regie-taxes']) expect(registry).toContain(`path: '${p}'`);
  });
});
