/**
 * « Rien à traiter » suivi de la prochaine action utile (29/09/2026, parcours par rôle) : sur un écran vide pour la
 * personne, propose les autres écrans de son travail du jour (shared/src/menu.ts, TRAVAIL_DU_JOUR) présents dans son
 * menu. Présentation seulement : aucun écran ajouté au-delà de son menu, aucun droit élargi.
 */
import { Link, useInRouterContext, useLocation } from 'react-router-dom';
import { travailDuJour } from '@mosolo/shared';
import { useApp } from '../context';
import { menuDe, selonRattachement } from './Shell';

export function SuiteDuTravail({ texte = 'Prochaine action utile :' }: { texte?: string }) {
  // Hors routeur (composant rendu seul, tests) : rien à proposer.
  return useInRouterContext() ? <Suite texte={texte} /> : null;
}

function Suite({ texte }: { texte: string }) {
  const { user, tr } = useApp();
  const loc = useLocation();
  if (!user) return null;
  const items = selonRattachement(menuDe(user.roles, user.entity), user);
  const suite = travailDuJour(user.roles)
    .filter((p) => p !== loc.pathname)
    .map((p) => items.find((n) => n.to === p))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .slice(0, 4);
  if (!suite.length) return null;
  return (
    <div className="suite-travail">
      <p className="small">{texte}</p>
      <div className="btn-row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        {suite.map((n) => <Link key={n.to} className="btn btn-secondary btn-sm" to={n.to}>{n.label ?? tr(n.key)}</Link>)}
      </div>
    </div>
  );
}
