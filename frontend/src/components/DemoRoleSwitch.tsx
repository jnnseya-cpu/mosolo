/**
 * Démonstration (29/09/2026) : sur un écran refusé ou vide pour le rôle fictif choisi, indique les rôles qui utilisent
 * cet écran et propose de passer, en un clic, à un utilisateur de démonstration qui les détient. Présentation seulement :
 * aucun droit n'est élargi (le serveur décide toujours). Hors démonstration, la liste des utilisateurs fictifs est vide
 * et rien n'est affiché.
 */
import { useApp } from '../context';
import { MODULE_ROUTES } from '../modules/registry';
import { NAV } from './Shell';

/** Rôles déclarés d'un écran (registre des modules, puis menu principal) ; [] = écran public. */
export function rolesDeLEcran(path: string): string[] {
  const match = (p: string) => new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}/?$`).test(path);
  const m = MODULE_ROUTES.find((r) => match(r.path));
  if (m?.nav?.roles?.length) return m.nav.roles;
  const n = NAV.find((x) => match(x.to));
  return (n as { roles?: string[] } | undefined)?.roles ?? [];
}

export function DemoRoleSwitch({ hint }: { hint?: string }) {
  const { users, user, setUserId } = useApp();
  if (!users.length || typeof window === 'undefined') return null;
  const roles = rolesDeLEcran(window.location.pathname);
  if (!roles.length) return null;
  const candidats = users.filter((u) => u.id !== user?.id && u.roles.some((r) => roles.includes(r))).slice(0, 6);
  if (!candidats.length) return null;
  return (
    <div className="state-body small" style={{ marginTop: 8 }}>
      <p>{hint ?? 'Démonstration : cet écran est utilisé par d’autres rôles. Voir l’écran en tant que :'}</p>
      <div className="btn-row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        {candidats.map((u) => (
          <button key={u.id} type="button" className="btn btn-secondary btn-sm" onClick={() => setUserId(u.id)}>{u.name}</button>
        ))}
      </div>
    </div>
  );
}
