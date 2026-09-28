/**
 * Alignement du MENU sur les droits de LECTURE (deuxième passe adverse, 27/09/2026) — changement de PRÉSENTATION
 * seulement : les entrées ci-dessous ne s'affichent plus dans le menu des rôles dont la lecture principale de l'écran
 * est refusée par le serveur. Aucune route, aucune page, aucun droit n'est retiré ni élargi : l'écran reste
 * accessible par son adresse (il affiche alors « accès refusé »), et un élargissement des droits en lecture reste une
 * décision du maître d'ouvrage (arbitrage demandé dans docs/production-readiness.md).
 *
 * Clé : chemin de l'écran ; valeur : rôles pour lesquels l'entrée de menu est masquée.
 */
export const MENU_MASQUE_SANS_LECTURE: Readonly<Record<string, readonly string[]>> = {
  // Trésor (R17) : la liste des sous-traitants est réservée à la régie ; le Trésor ne lit que la rémunération.
  '/terrain/sous-traitants': ['R17'],
  // Agent de terrain (R10) : fourrières, cadastre, activités, véhicules et transport du référentiel citoyen refusés.
  '/vehicules/fourrieres': ['R10'],
  '/citoyen/cadastre': ['R10'],
  '/citoyen/activites': ['R10'],
  '/citoyen/vehicules': ['R10'],
  '/citoyen/transport': ['R10'],
  // Contribuable (R30) : gestion documentaire interne, indicateurs des fiches sectorielles, coopérative (gérant seul).
  '/documents': ['R30'],
  '/verticales/fiches': ['R30'],
  '/rakapay/cooperative': ['R30'],
  // Secrétaire exécutif et ministres (R03, R04) : tableau du Gouverneur refusé (leur poste de décision reste au menu).
  '/gouverneur': ['R03', 'R04'],
  // Trésor (R17) : « Sept questions et chaîne » — ruptures de la chaîne opératoire réservées à l'audit et à la régie
  // (relevé par la deuxième passe, test menu-droits).
  '/chaine': ['R17'],
  // Ministre des Finances (R05) : Trésor et pilotage RakaPay refusés en lecture.
  '/tresor': ['R05'],
  '/rakapay/pilotage': ['R05'],
  // Super-administrateur (R26) : les trois lectures de l'écran d'audit lui sont refusées (séparation des tâches :
  // l'administrateur technique ne lit pas la piste d'audit) — relevé par la troisième passe (D3-08, navigateur réel).
  '/audit': ['R26'],
};

/** Vrai si l'entrée de menu `path` est masquée pour une personne portant `roles` (tous ses rôles doivent être concernés). */
export function menuMasque(path: string, roles: readonly string[]): boolean {
  const masked = MENU_MASQUE_SANS_LECTURE[path];
  if (!masked || roles.length === 0) return false;
  return roles.every((r) => masked.includes(r));
}
