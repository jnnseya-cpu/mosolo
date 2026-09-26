import { useState } from 'react';

/**
 * Logo officiel de la Ville de Kinshasa, utilisé SANS modification (mise à l'échelle seule).
 * Si le fichier n'est pas encore fourni, repli sur un mot-symbole texte et un filet tricolore —
 * l'emblème n'est jamais redessiné ni imité.
 */
export function CityLogo({ height = 40, variant = 'onDark' }: { height?: number; variant?: 'onDark' | 'onLight' }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className={`wordmark wordmark-${variant}`} style={{ height }} aria-label="Ville de Kinshasa">
        <span className="tricolour-v" aria-hidden="true"><i /><i /><i /></span>
        <span className="wordmark-text" aria-hidden="true">VILLE DE<br />KINSHASA</span>
      </span>
    );
  }
  return (
    <img
      src="/logo-ville-de-kinshasa.png"
      alt="Ville de Kinshasa"
      className="city-logo"
      style={{ height, width: 'auto' }}
      onError={() => setFailed(true)}
    />
  );
}

/** Marque secondaire du réalisateur (logo inchangé, pied de page uniquement). */
export function MakerMark() {
  return (
    <span className="maker">
      <img src="/logo-groupe-nseya.png" alt="" className="maker-logo" width={19} height={20} />
      <span>Réalisé par Groupe Nseya</span>
    </span>
  );
}

export function Tricolour({ className }: { className?: string }) {
  return <div className={`tricolour ${className ?? ''}`} aria-hidden="true"><i /><i /><i /></div>;
}
