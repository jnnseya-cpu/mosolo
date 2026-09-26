import type { ReactNode } from 'react';
import { useApp } from '../context';
import { Tricolour } from './Brand';

/** Mise en page publique : visuel officiel à gauche (desktop) ou bandeau (mobile), formulaire sur carte blanche. */
export function CoverSplit({ children }: { children: ReactNode }) {
  const { tr } = useApp();
  return (
    <div className="cover-split">
      <div className="cover-side">
        <img src="/media/couverture-ville-de-kinshasa.webp" alt={tr('home.coverAlt')} width={1536} height={1024} />
        <div className="cover-caption">
          <Tricolour />
          <p className="caps-sm">{tr('footer.city')}</p>
          <p className="cover-motto">{tr('app.motto')}</p>
          <p className="cover-note">{tr('footer.langNote')}</p>
        </div>
      </div>
      <div className="cover-main">{children}</div>
    </div>
  );
}
