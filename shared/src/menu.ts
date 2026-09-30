/**
 * Alignement du MENU sur les droits de LECTURE (deuxième passe adverse, 27/09/2026) — changement de PRÉSENTATION
 * seulement : les entrées ci-dessous ne s'affichent plus dans le menu des rôles dont la lecture principale de l'écran
 * est refusée par le serveur. Aucune route, aucune page, aucun droit n'est retiré ni élargi : l'écran reste
 * accessible par son adresse (il affiche alors « accès refusé »), et un élargissement des droits en lecture reste une
 * décision du maître d'ouvrage (arbitrage demandé dans docs/production-readiness.md).
 *
 * Parcours par rôle (29/09/2026, revue « chacun ne voit que ce qu'il a à faire ») : listes COMPLÉTÉES (jamais réduites)
 * à partir d'un parcours réel dans le navigateur de chaque rôle de démonstration et du test
 * backend/test/menu-droits.test.ts étendu aux 113 comptes de démonstration.
 *
 * Clé : chemin de l'écran ; valeur : rôles pour lesquels l'entrée de menu est masquée.
 */
export const MENU_MASQUE_SANS_LECTURE: Readonly<Record<string, readonly string[]>> = {
  // Trésor (R17) : la liste des sous-traitants est réservée à la régie ; le Trésor ne lit que la rémunération.
  // 29/09/2026 : points de résultats refusés aussi à l'administrateur d'entité, au superviseur, au contrôleur et à
  // l'enquêteur (R08, R09, R11, R24).
  '/terrain/sous-traitants': ['R17', 'R08', 'R09', 'R11', 'R24'],
  // Agent de terrain (R10) : fourrières, cadastre, activités, véhicules et transport du référentiel citoyen refusés.
  // 29/09/2026 : activités, véhicules et transport refusés aussi au superviseur terrain (R09) — le cadastre lui reste
  // (recherche par objet de son territoire) ; véhicules refusés au gardien de fourrière (R35).
  '/vehicules/fourrieres': ['R10'],
  '/citoyen/cadastre': ['R10'],
  '/citoyen/activites': ['R10', 'R09'],
  '/citoyen/vehicules': ['R10', 'R09', 'R35'],
  '/citoyen/transport': ['R10', 'R09'],
  // Contribuable (R30) : gestion documentaire interne, indicateurs des fiches sectorielles, coopérative (gérant seul).
  // 29/09/2026 : mêmes refus pour le mandataire (R31) ; fiches sectorielles refusées à l'exploitant (R34) et au
  // gardien de fourrière (R35).
  '/documents': ['R30', 'R31'],
  '/verticales/fiches': ['R30', 'R31', 'R34', 'R35'],
  '/rakapay/cooperative': ['R30'],
  // Secrétaire exécutif et ministres (R03, R04) : tableau du Gouverneur refusé (leur poste de décision reste au menu).
  '/gouverneur': ['R03', 'R04'],
  // Trésor (R17) : « Sept questions et chaîne » — ruptures de la chaîne opératoire réservées à l'audit et à la régie
  // (relevé par la deuxième passe, test menu-droits).
  '/chaine': ['R17'],
  // Ministre des Finances (R05) : Trésor et pilotage RakaPay refusés en lecture.
  // 29/09/2026 : vue d'ensemble du Trésor refusée aussi à l'auditeur externe (R23) ; l'enquêteur (R24) et la sécurité
  // (R28) n'y voient que des mentions « réservé » (aucune donnée) ; le détenteur de clé (R19) garde l'entrée (registre
  // du coffre). Pilotage RakaPay refusé à R24.
  '/tresor': ['R05', 'R23', 'R24', 'R28'],
  '/rakapay/pilotage': ['R05', 'R24'],
  // Super-administrateur (R26) : les trois lectures de l'écran d'audit lui sont refusées (séparation des tâches :
  // l'administrateur technique ne lit pas la piste d'audit) — relevé par la troisième passe (D3-08, navigateur réel).
  // 29/09/2026 : de même pour l'enquêteur (R24) et le responsable de la sécurité (R28).
  '/audit': ['R26', 'R24', 'R28'],
  // ── Ajouts du 29/09/2026 (parcours par rôle) ──
  // Mandataire (R31) : les écrans « mes dispositifs publicitaires » exigent un compte contribuable propre.
  '/publicite': ['R31'],
  '/publicite/contrats': ['R31'],
  // Partenaires (point agréé, banque, exploitant, autorité habilitée, service fiscal) : espace d'apprentissage et base
  // de procédures réservés aux agents publics.
  '/apprentissage': ['R32', 'R33', 'R34', 'R36', 'R37'],
  '/apprentissage/procedures': ['R32', 'R33', 'R34', 'R36', 'R37'],
  // Superviseur terrain (R09) : locatif, anomalies locatives et couverture du recensement refusés en lecture.
  '/citoyen/locatif': ['R09'],
  '/fiscal/anomalies-locatives': ['R09'],
  '/fiscal/recensement': ['R09'],
  // Trésor et rapprochement (R17, R18) : le tableau ministériel leur est refusé.
  '/decision/ministere': ['R17', 'R18'],
  // ParkSmart : occupation refusée au contentieux (R20) et au décideur (R21).
  '/stationnement/parksmart': ['R20', 'R21'],
};

/**
 * Lecture réservée aux personnes d'ENTITÉS précises (29/09/2026) : pour les rôles listés, l'écran lit des données dont
 * l'entité exploitante est fixée (règle serveur « même entité ») ; l'entrée n'apparaît donc qu'aux personnes de ces
 * entités. Correspondance relevée sur les comptes de démonstration — PAR DÉFAUT, à confirmer par le maître d'ouvrage ;
 * les rattachements de modules aux entités (§ 12A, écran /acces/departements) restent la voie de gestion en production.
 * Présentation seulement : aucune route, page ni droit retiré ou élargi.
 */
export const MENU_LECTURE_PAR_ENTITE: Readonly<Record<string, { roles: readonly string[]; entites: readonly string[] }>> = {
  // Régie fiscale (DGIPK) et régie des taxes (DGTK) : chaque poste de travail lit les données de sa régie.
  '/decision/regie-fiscale': { roles: ['R06', 'R07'], entites: ['DGIPK'] },
  '/decision/regie-taxes': { roles: ['R06', 'R07'], entites: ['DGTK'] },
  // Stationnement, publicité, environnement, fiches sectorielles, grands redevables : exploités par la DGTK.
  '/stationnement/regie': { roles: ['R06', 'R07'], entites: ['DGTK'] },
  '/stationnement/tableau-de-bord': { roles: ['R06', 'R07', 'R09'], entites: ['DGTK'] },
  '/stationnement/parksmart': { roles: ['R06', 'R07', 'R09'], entites: ['DGTK'] },
  '/publicite/regie': { roles: ['R06', 'R07'], entites: ['DGTK'] },
  '/publicite/inspection': { roles: ['R06', 'R07', 'R09', 'R11'], entites: ['DGTK'] },
  '/publicite/tableau-de-bord': { roles: ['R06', 'R07', 'R09'], entites: ['DGTK'] },
  '/publicite/carte': { roles: ['R06', 'R07', 'R09', 'R11'], entites: ['DGTK'] },
  '/verticales/environnement': { roles: ['R06', 'R07', 'R11'], entites: ['DGTK'] },
  '/verticales/fiches': { roles: ['R06', 'R07', 'R11'], entites: ['DGTK'] },
  '/grands-redevables': { roles: ['R06', 'R07', 'R11'], entites: ['DGTK'] },
  // Coopérative wewa : la fiche d'une coopérative est lue par la régie des transports (DGTK).
  '/rakapay/cooperative': { roles: ['R06', 'R07'], entites: ['DGTK'] },
  // Patrimoine provincial (MOSOLO Assets) : géré au ministère des Finances.
  '/verticales/actifs': { roles: ['R06', 'R07', 'R11'], entites: ['MINFIN'] },
  // Contrôle technique, fourrières, centres agréés, raccordement : exploités par la RFCK.
  '/vehicules/controle-technique': { roles: ['R06', 'R07', 'R08'], entites: ['RFCK'] },
  '/vehicules/fourrieres': { roles: ['R06', 'R07'], entites: ['RFCK'] },
  '/vehicules/centres-agrees': { roles: ['R06', 'R07'], entites: ['RFCK'] },
  '/vehicules/rfck': { roles: ['R06', 'R07', 'R08'], entites: ['RFCK'] },
  // Vagues de recensement : couverture refusée aux agents de terrain hors RFCK (relevé du 29/09/2026).
  '/fiscal/recensement': { roles: ['R10'], entites: ['RFCK'] },
};

/**
 * Vrai si l'entrée de menu `path` est masquée pour une personne portant `roles` (tous ses rôles doivent être concernés).
 * `entity` (facultatif, 29/09/2026) : entité de la personne ; sans elle, seules les règles par rôle s'appliquent.
 */
export function menuMasque(path: string, roles: readonly string[], entity?: string): boolean {
  if (roles.length === 0) return false;
  const masked = MENU_MASQUE_SANS_LECTURE[path];
  if (masked && roles.every((r) => masked.includes(r))) return true;
  const parEntite = MENU_LECTURE_PAR_ENTITE[path];
  return !!parEntite && !!entity && !parEntite.entites.includes(entity) && roles.every((r) => parEntite.roles.includes(r));
}

/**
 * Écrans de travail qui servent AUSSI des usagers, sans entrée dans leur menu (29/09/2026) : proposés depuis leur espace
 * (ex. « Carte de mes biens » de l'espace contribuable, lecture serveur autorisée au contribuable et au mandataire). La
 * garde d'écran des comptes publics les laisse passer pour ces rôles. Présentation seulement ; aucun droit élargi.
 */
export const ECRANS_USAGERS_HORS_MENU: Readonly<Record<string, readonly string[]>> = {
  '/fiscal/carte': ['R30', 'R31'],
};

/** Vrai si l'écran `path` est proposé hors menu à l'un des `roles` (voir ECRANS_USAGERS_HORS_MENU). */
export function ecranUsagerHorsMenu(path: string, roles: readonly string[]): boolean {
  return !!ECRANS_USAGERS_HORS_MENU[path]?.some((r) => roles.includes(r));
}

/**
 * Menu des usagers (contribuable R30, mandataire R31) — 30/09/2026, demande du maître d'ouvrage : « l'usager n'a rien à
 * vérifier ; il doit trouver en un seul endroit ce qui le concerne et pouvoir agir ». Ces écrans ne figurent plus dans
 * le MENU d'un compte dont tous les rôles sont des rôles d'usager : outils de vérification (quittance, preuve, vignette,
 * agent), pages de connexion et d'inscription (déjà connecté), référentiels et outils des agents, doublons. Présentation
 * seulement : aucune route ni page n'est retirée (pages publiques inchangées pour le public non connecté) ; tout ce qui
 * concerne l'usager est dans « Mon espace » (bloc « À faire ») et dans « Mes démarches » (services).
 */
export const ROLES_USAGERS: readonly string[] = ['R30', 'R31'];
export const MENU_USAGER_HORS_MENU: readonly string[] = [
  '/', '/connexion', '/inscription', '/recuperation-compte',
  '/verifier', '/preuve', '/vehicules/verifier', '/verifier-agent',
  '/canaux/ussd', '/canaux/whatsapp-sms', '/referentiel/recettes', '/fiscal/assiette-2026', '/fiscal/dependances',
  '/verticales/secteurs', '/citoyen/pieces', '/fiscal/carte', '/apprentissage', '/apprentissage/procedures',
  '/rakapay/operateurs', '/publicite/signaler', '/fiscal/biens',
];
/** Vrai si `path` est hors du menu d'un compte d'usager (tous ses rôles sont R30 ou R31). */
export function horsMenuUsager(path: string, roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every((r) => ROLES_USAGERS.includes(r)) && MENU_USAGER_HORS_MENU.includes(path);
}

/**
 * Écrans où le Gouverneur, le directeur de cabinet et le secrétaire exécutif ne lisent qu'un AGRÉGAT (le serveur leur
 * refuse les dossiers détaillés ; l'écran affiche « Lecture agrégée »). Relevé par le parcours du 30/09/2026. Leurs
 * MENUS restent inchangés (décision du 27/09/2026 : tous les modules) ; seuls les liens À L'INTÉRIEUR des écrans vers
 * ces pages ne sont plus proposés (ils menaient à une page sans contenu). Présentation seulement.
 */
export const ECRANS_LECTURE_AGREGEE_AUTORITES: readonly string[] = [
  '/apprentissage/certifications', '/integrite/enquetes', '/audit', '/recouvrement', '/recouvrement/campagnes', '/terrain/supervision', '/integrite/revue-acces',
];

/** Gouverneur, directeur de cabinet, secrétaire exécutif : tous les modules (décision du 27/09/2026), en lecture agrégée. */
export const ROLES_TOUS_MODULES: readonly string[] = ['R01', 'R02', 'R03'];

/**
 * « Mon travail du jour » (29/09/2026) : pour chaque rôle, les écrans de ses tâches quotidiennes, dans l'ordre. Ils
 * s'affichent en tête du menu et le premier écran accessible devient l'écran d'accueil du rôle. Présentation
 * seulement : une entrée n'apparaît que si elle figure DÉJÀ dans le menu de la personne (droits inchangés) ; tous les
 * autres écrans restent dans « Tous mes écrans » et dans la recherche du menu. Liste par défaut — à confirmer par le
 * maître d'ouvrage.
 */
export const TRAVAIL_DU_JOUR: Readonly<Record<string, readonly string[]>> = {
  R01: ['/poste-de-decision'],
  R02: ['/poste-de-decision', '/pilotage/instructions', '/pilotage/decisions-gouvernement', '/acces/types-de-comptes', '/decision/commandement', '/pilotage/tableaux'],
  R03: ['/poste-de-decision', '/pilotage/instructions', '/pilotage/decisions-gouvernement', '/juridique/points', '/decision/commandement'],
  R04: ['/poste-de-decision', '/decision/ministere', '/pilotage/indicateurs', '/pilotage/instructions', '/vehicules/controle-technique'],
  R05: ['/poste-de-decision', '/decision/ministere', '/decision/salle-controle', '/pilotage/indicateurs', '/pilotage/repartition', '/decision/regie-fiscale'],
  R06: ['/poste-de-travail', '/decision/regie-fiscale', '/decision/regie-taxes', '/recouvrement', '/terrain/supervision', '/agents/validation-commissions', '/fiscal/quitus'],
  R07: ['/poste-de-travail', '/decision/regie-fiscale', '/decision/regie-taxes', '/fiscal/biens', '/biens-relations/revue', '/recouvrement', '/terrain/supervision'],
  R08: ['/acces/invitations', '/acces/departements', '/acces/entites', '/integrite/revue-acces', '/acces/delegations', '/poste-de-travail'],
  R09: ['/terrain/supervision', '/terrain', '/terrain/qualite', '/agents/validation-commissions', '/terrain/inspection', '/poste-de-travail'],
  R10: ['/terrain', '/terrain/inspection', '/titres/controle', '/vehicules/scan', '/canaux/enrolement', '/mes-gains'],
  R11: ['/poste-de-travail', '/terrain', '/terrain/inspection', '/fiscal/declarations', '/titres/controle', '/stationnement/controle'],
  R12: ['/poste-de-travail', '/canaux/enrolement', '/citoyen/pieces', '/fiscal/declarations', '/canaux/contestation', '/verifier'],
  R13: ['/registre', '/juridique/points', '/fiscal/exonerations', '/poste-de-travail'],
  R14: ['/registre', '/juridique/points', '/poste-de-travail'],
  R15: ['/registre', '/pilotage/repartition', '/decision/salle-controle', '/controle/calcu', '/poste-de-travail'],
  R16: ['/registre', '/juridique/points', '/pilotage/decisions-gouvernement', '/poste-de-travail'],
  R17: ['/tresor', '/tresor/appariements', '/canaux/points-supervision', '/tresor/points-agrees', '/tresor/prestataires', '/decision/previsions'],
  R18: ['/tresor/appariements', '/tresor', '/canaux/jour-de-caisse', '/canaux/points-supervision'],
  R19: ['/poste-de-travail', '/tresor'],
  R20: ['/recours', '/recouvrement', '/recouvrement/remises', '/poste-de-travail'],
  R21: ['/recours', '/recouvrement/remises', '/recouvrement/non-valeurs', '/integrite/renseignement', '/poste-de-travail'],
  R22: ['/audit', '/pilotage/piste-audit', '/decision/audit', '/integrite/scellement', '/tresor', '/chaine'],
  R23: ['/audit', '/pilotage/piste-audit', '/decision/audit', '/integrite/scellement'],
  R24: ['/integrite/enquetes', '/integrite/renseignement', '/integrite/collusion', '/integrite/controles-mystere', '/decision/audit'],
  R25: ['/integrite/donnees', '/donnees/extractions', '/juridique/donnees', '/integrite/incidents'],
  R26: ['/plateforme/administration', '/acces/invitations', '/acces/departements', '/plateforme/supervision', '/tresor/prestataires'],
  R27: ['/plateforme/supervision', '/integrite/incidents', '/plateforme/administration', '/acces/elevations'],
  R28: ['/integrite/incidents', '/integrite/revue-acces', '/integrite/cles', '/acces/elevations', '/integrite/scellement'],
  R29: ['/ia/modeles', '/ia/journal', '/ia'],
  R30: ['/espace', '/mes-arrieres', '/espace/biens-relations', '/vehicules/mes-vehicules', '/fiscal/declarations', '/services', '/mon-espace/situation'],
  R31: ['/acces/mandats', '/fiscal/declarations', '/mes-arrieres', '/fiscal/biens', '/points-de-paiement'],
  R32: ['/canaux/point-agree', '/verifier', '/preuve'],
  R33: ['/verifier', '/preuve', '/transparence'],
  R34: ['/vehicules/controle-technique', '/vehicules/centres-agrees', '/opportunites/recoupement', '/verifier'],
  R35: ['/vehicules/fourrieres', '/terrain/supervision', '/terrain/sous-traitants', '/titres/controle', '/mes-gains'],
  R36: ['/poste-de-decision', '/juridique/points', '/pilotage/pilote', '/rakapay/pilotage'],
  R37: ['/fiscal/quitus', '/fiscal/dependances', '/verifier'],
};

/** Écrans du travail du jour d'une personne (rôles cumulés, sans doublon, dans l'ordre des rôles). */
export function travailDuJour(roles: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of roles) for (const p of TRAVAIL_DU_JOUR[r] ?? []) if (!out.includes(p)) out.push(p);
  return out;
}
