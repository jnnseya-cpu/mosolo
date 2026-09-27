/**
 * Aide contextuelle « ? » (micro-apprentissage intégré au poste, § 24) : réutilisable par tout écran, par la clé de
 * l'écran ou de l'action (ex. `terrain.habilitation`). Affiche la fiche PUBLIÉE (quatre yeux) en français simple ; la
 * traduction lingala, lorsqu'elle existe, est signalée comme brouillon. Aucun suivi de lecture n'est enregistré.
 */
import { useEffect, useId, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import type { ContenuVue } from './types';
import './apprentissage.css';

export function AideContextuelle({ cle, libelle = 'Aide sur cet écran' }: { cle: string; libelle?: string }) {
  const [open, setOpen] = useState(false);
  const [fiche, setFiche] = useState<ContenuVue | null>(null);
  const [etat, setEtat] = useState<'idle' | 'loading' | 'absent' | 'erreur'>('idle');
  const [lingala, setLingala] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open || fiche || etat === 'loading') return;
    setEtat('loading');
    api<ContenuVue>(`/v1/apprentissage/aide/${encodeURIComponent(cle)}`).then(
      (f) => { setFiche(f); setEtat('idle'); },
      (e: unknown) => setEtat(e instanceof ApiError && e.status === 404 ? 'absent' : 'erreur'),
    );
  }, [open, cle, fiche, etat]);
  const texte = lingala && fiche?.lingala ? fiche.lingala : fiche;
  return (
    <span className="ap-aide">
      <button type="button" className="btn btn-ghost btn-sm ap-aide-btn" aria-expanded={open} aria-controls={id} aria-label={libelle} title={libelle} onClick={() => setOpen(!open)}>
        <Icon name="question" size={16} /> <span className="ap-aide-q" aria-hidden="true">?</span>
      </button>
      {open && (
        <div id={id} className="panel ap-aide-pop" role="dialog" aria-label={libelle}>
          {etat === 'loading' && <p className="small muted">Chargement de l’aide…</p>}
          {etat === 'absent' && <p className="small muted">Aucune aide publiée pour cet écran pour le moment.</p>}
          {etat === 'erreur' && <p className="small muted">Aide indisponible (serveur injoignable).</p>}
          {fiche && texte && (
            <>
              <p className="panel-title">{texte.titre}</p>
              <p className="small">{texte.corps}</p>
              {fiche.lingala && (
                <div className="btn-row">
                  <button type="button" className="btn btn-ghost btn-sm" aria-pressed={lingala} onClick={() => setLingala(!lingala)}>
                    {lingala ? 'Français' : 'Lingala (brouillon)'}
                  </button>
                </div>
              )}
              {lingala && <p className="small muted">{fiche.lingalaNote ?? 'Traduction lingala : brouillon à relire — le texte français fait foi.'}</p>}
              <p className="small muted">Version {fiche.version}{fiche.demo ? ' · contenu de démonstration [EXEMPLE]' : ''}</p>
            </>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Fermer</button>
        </div>
      )}
    </span>
  );
}
