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
  // Le logo a un fond blanc : sur fond sombre, il est posé sur une plaque blanche (le fichier reste intact).
  return (
    <span className={`city-logo-plate city-logo-plate-${variant}`}>
      <picture>
        <source srcSet="/logo-ville-de-kinshasa.webp" type="image/webp" />
        <img
          src="/logo-ville-de-kinshasa.png"
          alt="Ville de Kinshasa"
          className="city-logo"
          style={{ height, width: 'auto' }}
          onError={() => setFailed(true)}
        />
      </picture>
    </span>
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

/**
 * En-tête de marque des documents imprimés (30/09/2026 : « tout document généré, imprimé ou PDF est à l'image de la
 * plateforme ») : logo de la Ville de Kinshasa (inchangé), « Ville-Province de Kinshasa », « KINSHASA MOSOLO » et le
 * type de document, filet tricolore.
 */
export function PrintLetterhead({ document, compact }: { document?: string; compact?: boolean }) {
  return (
    <div className={`print-letterhead ${compact ? 'print-letterhead-compact' : ''}`}>
      <div className="print-letterhead-row">
        <CityLogo height={compact ? 26 : 40} variant="onLight" />
        <div className="print-letterhead-text">
          <strong>Ville-Province de Kinshasa</strong>
          <span>KINSHASA MOSOLO{document ? ` · ${document}` : ''}</span>
        </div>
      </div>
      <Tricolour className="print-letterhead-tri" />
    </div>
  );
}

/** Pied de marque des documents imprimés : « Plateforme KINSHASA MOSOLO — réalisée par Groupe Nseya » (logo inchangé). */
export function PrintFooterMark() {
  return (
    <div className="print-footermark">
      <img src="/logo-groupe-nseya.png" alt="" width={14} height={15} />
      <span>Plateforme KINSHASA MOSOLO — réalisée par Groupe Nseya</span>
    </div>
  );
}
