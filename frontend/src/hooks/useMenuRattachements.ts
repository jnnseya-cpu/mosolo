/**
 * Menu reflétant les rattachements de modules aux entités (27/09/2026, § 12A) — PRÉSENTATION seulement : les écrans
 * d'un module rattaché à d'autres entités que celle de la personne ne figurent plus dans son menu ; la route reste
 * accessible par son adresse et le serveur continue d'appliquer les droits (ABAC).
 * En cas d'échec (hors ligne, serveur ancien) : aucun masquage, le menu reste celui du rôle.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const EMPTY: ReadonlySet<string> = new Set();

export function useMenuRattachements(userId: string | undefined): ReadonlySet<string> {
  const [state, setState] = useState<{ userId: string | undefined; hidden: ReadonlySet<string> }>({ userId: undefined, hidden: EMPTY });
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    api<{ hiddenPaths?: string[] }>('/v1/acces/menu-rattachements')
      .then((r) => { if (alive) setState({ userId, hidden: new Set(Array.isArray(r?.hiddenPaths) ? r.hiddenPaths : []) }); })
      .catch(() => { if (alive) setState({ userId, hidden: EMPTY }); });
    return () => { alive = false; };
  }, [userId]);
  return state.userId === userId ? state.hidden : EMPTY;
}

/** Retire du menu les entrées masquées par les rattachements (jamais l'accueil). */
export function sansMasques<T extends { to: string }>(items: T[], hidden: ReadonlySet<string>): T[] {
  return hidden.size === 0 ? items : items.filter((n) => n.to === '/' || !hidden.has(n.to));
}
