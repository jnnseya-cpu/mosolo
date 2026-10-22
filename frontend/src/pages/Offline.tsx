import { Link } from 'react-router-dom';
import { useApp } from '../context';
import { Icon } from '../components/Icon';

/** Écran d'attente : visuel institutionnel centré, contenu (jamais recadré). */
export function Splash({ compact }: { compact?: boolean }) {
  const { tr } = useApp();
  return (
    <div className={`splash ${compact ? 'splash-compact' : ''}`} role="status" aria-live="polite">
      <img src="/media/couverture-ville-de-kinshasa.webp" alt="" className="splash-cover" />
      <p className="splash-text"><span className="spinner" aria-hidden="true" /> {tr('common.loading')}</p>
    </div>
  );
}

export default function OfflinePage() {
  const { tr } = useApp();
  return (
    <div className="page offline-page">
      <img src="/media/couverture-ville-de-kinshasa.webp" alt={tr('home.coverAlt')} className="offline-cover" />
      <h1><Icon name="offline" size={24} /> {tr('offline.title')}</h1>
      <p className="lead">{tr('offline.body')}</p>
      <ul className="plain-list">
        <li>{tr('offline.item.drafts')}</li>
        <li>{tr('offline.item.field')}</li>
        <li>{tr('offline.item.demo')}</li>
      </ul>
      <div className="btn-row">
        <Link className="btn btn-primary" to="/terrain">{tr('nav.field')}</Link>
        <Link className="btn btn-secondary" to="/gouverneur">{tr('nav.governor')}</Link>
      </div>
    </div>
  );
}
