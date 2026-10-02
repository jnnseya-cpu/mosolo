/**
 * Liens vers un autre écran, adaptés au compte (29/09/2026, « chacun ne voit que ce qu'il a à faire ») — généralise le
 * motif des parcours des verticales (modules/verticales/Parcours.tsx) : un lien vers un écran que le rôle courant
 * n'utilise pas est remplacé par « Réalisé par : <rôle> » (ou masqué), au lieu de mener à « Accès réservé ».
 *
 * Un écran est considéré comme utilisable si :
 *  - il n'est pas masqué du menu pour la personne (shared/src/menu.ts : lecture refusée par rôle ou par entité) ;
 *  - il est public (aucun rôle déclaré), ou l'un des rôles de la personne figure parmi ceux qui l'utilisent ;
 *  - ou la personne est Gouverneur, directeur de cabinet ou secrétaire exécutif (tous les modules, lecture agrégée).
 * Présentation seulement : le serveur décide toujours ; aucun droit n'est élargi ni retiré, l'écran reste joignable par
 * son adresse. Utilisateur inconnu (hors ligne) : le lien est conservé.
 */
import type { ReactNode } from 'react';
import { Link, useInRouterContext, type LinkProps } from 'react-router-dom';
import { ecranUsagerHorsMenu, menuMasque, ROLES, ECRANS_LECTURE_AGREGEE_AUTORITES } from '@mosolo/shared';
import { useApp } from '../context';
import { rolesDeLEcran } from './DemoRoleSwitch';
import { lectureAgregee } from './Shell';

/** Chemin nu (sans requête ni ancre) d'une destination de lien. */
function cheminDe(to: LinkProps['to']): string | null {
  const s = typeof to === 'string' ? to : to.pathname ?? null;
  if (!s || !s.startsWith('/')) return null;
  return s.split(/[?#]/)[0] || '/';
}

/** Vrai si l'écran `path` est utilisable par une personne portant `roles` (entité facultative). */
export function ecranAccessible(path: string, roles: readonly string[] | undefined, entity?: string): boolean {
  if (!roles) return true;
  if (ecranUsagerHorsMenu(path, roles)) return true;
  // Espace contribuable : propre au contribuable et au mandataire (un agent y verrait « accès réservé »).
  if (path === '/espace' && !roles.some((r) => r === 'R30' || r === 'R31')) return false;
  if (menuMasque(path, roles, entity)) return false;
  const declares = rolesDeLEcran(path);
  if (!declares.length) return true;
  if (roles.some((r) => declares.includes(r))) return true;
  // Autorités (R01–R03) : lecture agrégée, sauf les écrans dont le détail leur est refusé (lien sans contenu).
  return lectureAgregee(roles) && !ECRANS_LECTURE_AGREGEE_AUTORITES.includes(path);
}

/** Libellé des rôles qui utilisent un écran (trois au plus). */
export function realisePar(path: string): string {
  const rs = rolesDeLEcran(path);
  const noms = rs.map((r) => (ROLES as Record<string, string>)[r] ?? r);
  return noms.length > 3 ? `${noms.slice(0, 3).join(', ')}…` : noms.join(', ') || 'un agent habilité';
}

/** Fonction « écran utilisable ? » pour la personne connectée. */
export function useEcranAccessible(): (path: string) => boolean {
  const { user } = useApp();
  return (path: string) => ecranAccessible(path.split(/[?#]/)[0] || '/', user?.roles, user?.entity);
}

/**
 * Remplace `Link` : même usage ; si l'écran n'est pas utilisable par la personne, affiche « Réalisé par : … »
 * (`masquer` : n'affiche rien). Les liens externes ou relatifs sont rendus tels quels.
 */
export function LienEcran({ masquer, ...props }: LinkProps & { masquer?: boolean }) {
  const accessible = useEcranAccessible();
  const routeur = useInRouterContext();
  const path = cheminDe(props.to);
  if (!path || accessible(path)) {
    if (routeur) return <Link {...props} />;
    // Hors routeur (composant rendu seul) : lien HTML simple, comme avant.
    const { to, className, title, children } = props;
    return <a href={typeof to === 'string' ? to : to.pathname ?? '#'} className={className} title={title} aria-label={props['aria-label']}>{children}</a>;
  }
  if (masquer) return null;
  return <span className="realise-par" title="Écran utilisé par d’autres rôles (présentation seulement)">Réalisé par : {realisePar(path)}</span>;
}

/** Variante pour une liste d'entrées (tuiles, onglets) : ne garde que les écrans utilisables. */
export function useEntreesUtilisables<T extends { to: string }>(items: T[]): T[] {
  const accessible = useEcranAccessible();
  return items.filter((i) => accessible(i.to));
}

/** Enveloppe facultative : n'affiche `children` que si l'écran est utilisable. */
export function SiEcranUtilisable({ to, children }: { to: string; children: ReactNode }) {
  const accessible = useEcranAccessible();
  return accessible(to) ? <>{children}</> : null;
}
