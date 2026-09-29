/**
 * Garde d'écran (29/09/2026) : un écran de travail réservé à des rôles d'agents (registre des modules) n'affiche pas ses
 * outils à un compte PUBLIC (contribuable, mandataire, R30/R31/R36) — par exemple l'écran de contrôle des titres.
 * Les comptes de travail ne sont pas concernés (leur accès reste décidé par le serveur, écran par écran).
 * Présentation seulement : le serveur décide toujours et refuse de son côté (aucun droit élargi). Le Gouverneur, le
 * directeur de cabinet et le secrétaire exécutif (R01–R03) voient tous les modules (décision du 27/09/2026) ; les
 * écrans publics (aucun rôle déclaré) ne sont jamais gardés ; utilisateur inconnu (hors ligne) : écran affiché.
 */
import type { ReactNode } from 'react';
import { ROLES } from '@mosolo/shared';
import { useApp } from '../context';
import { DemoRoleSwitch } from './DemoRoleSwitch';
import { Icon } from './Icon';

const TOUS_MODULES = ['R01', 'R02', 'R03'];
const PUBLICS = ['R30', 'R31', 'R36'];

export function RouteGuard({ roles, children }: { roles?: readonly string[]; children: ReactNode }) {
  const { user } = useApp();
  if (!roles?.length || !user) return <>{children}</>;
  if (!user.roles.every((r) => PUBLICS.includes(r))) return <>{children}</>;
  if (user.roles.some((r) => roles.includes(r) || TOUS_MODULES.includes(r))) return <>{children}</>;
  const libelles = roles.map((r) => (ROLES as Record<string, string>)[r] ?? r);
  return (
    <div className="page">
      <div className="state state-empty" role="status">
        <Icon name="lock" size={28} />
        <p className="state-title">Écran réservé</p>
        <p className="state-body">Cet écran sert aux personnes habilitées : {libelles.join(', ')}. Il n’est pas proposé à votre compte ; chaque démarche qui vous concerne est accessible depuis votre espace.</p>
        <DemoRoleSwitch />
      </div>
    </div>
  );
}
