/**
 * Compte à rebours de validité d'une preuve — règle unique 49 % / 21 % (shared/validity.ts) :
 * vert ≥ 49 % de validité restante, ambre 21–49 %, rouge < 21 %, puis « EXPIRÉ ».
 * La couleur n'est jamais seule (icône + texte + barre + pourcentage) ; l'heure de référence est celle du serveur
 * (écart mesuré à chaque réponse d'API, § H.11.6) : changer l'heure du téléphone ne change rien.
 */
import { useEffect, useState } from 'react';
import { formatValidityDuration, readValidity, type ValidityBand } from '@mosolo/shared';
import { serverNow } from '../lib/api';
import { Icon } from './Icon';

export interface ValidityLike { from?: string | null; until?: string | null }

const ICON: Record<ValidityBand, string> = { VERT: 'check', AMBRE: 'alert', ROUGE: 'alert', EXPIRE: 'x', PAS_ACTIF: 'clock', PERMANENT: 'check' };
const WORD: Record<ValidityBand, string> = { VERT: 'VALIDE', AMBRE: 'VALIDE', ROUGE: 'VALIDE', EXPIRE: 'EXPIRÉ', PAS_ACTIF: 'PAS ENCORE ACTIF', PERMANENT: 'VALABLE' };

/** Horloge serveur rafraîchie chaque seconde (ou chaque minute pour les longues durées). */
export function useServerClock(periodMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = window.setInterval(() => setNow(serverNow()), periodMs);
    return () => window.clearInterval(t);
  }, [periodMs]);
  return now;
}

function fmt(v: string | null | undefined): string {
  if (!v) return '—';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T12:00:00Z` : v);
  return d.toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa', day: '2-digit', month: 'short', year: 'numeric', ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }) });
}

export function ValidityCountdown({ from, until, blocked, compact, label }: ValidityLike & {
  /** Statut bloquant (révoqué, suspendu, invalide) : aucun compte à rebours, texte explicite. */
  blocked?: string | null;
  compact?: boolean;
  label?: string;
}) {
  const now = useServerClock(1000);
  if (blocked) {
    return (
      <div className={`vc vc-NOIR${compact ? ' vc-compact' : ''}`} role="status">
        <div className="vc-head"><Icon name="ban" size={compact ? 14 : 18} /><strong>{blocked}</strong></div>
      </div>
    );
  }
  const r = readValidity(from ?? null, until ?? null, now);
  const pct = r.pct === null ? 100 : Math.max(0, Math.min(100, r.pct));
  const pctLabel = r.pct === null ? '' : `${pct >= 10 ? Math.floor(pct) : pct.toFixed(1)} %`;
  let text: string;
  switch (r.band) {
    case 'PERMANENT': text = 'Sans date de fin'; break;
    case 'PAS_ACTIF': text = `début dans ${formatValidityDuration((r.remainingMs ?? 0) - (r.totalMs ?? 0))}`; break;
    case 'EXPIRE': text = `depuis ${formatValidityDuration(r.remainingMs ?? 0)}`; break;
    case 'ROUGE': text = `expire dans ${formatValidityDuration(r.remainingMs ?? 0)}`; break;
    default: text = `encore ${formatValidityDuration(r.remainingMs ?? 0)}`;
  }
  const aria = `${label ? `${label} : ` : ''}${WORD[r.band]}, ${text}${pctLabel ? `, ${pctLabel} de validité restante` : ''}`;
  if (compact) {
    return (
      <span className={`vc vc-compact vc-${r.band}`} role="timer" aria-label={aria} title={aria}>
        <Icon name={ICON[r.band]} size={13} />
        <span className="vc-word">{WORD[r.band]}</span>
        <span className="vc-time">{text}</span>
        {r.pct !== null && r.band !== 'EXPIRE' && <span className="vc-mini" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>}
      </span>
    );
  }
  return (
    <div className={`vc vc-${r.band}`} role="timer" aria-label={aria}>
      <div className="vc-head">
        <span className="vc-icon" aria-hidden="true"><Icon name={ICON[r.band]} size={18} /></span>
        <div className="vc-main">
          {label && <span className="vc-label">{label}</span>}
          <span className="vc-line"><strong className="vc-word">{WORD[r.band]}</strong> <span className="vc-time">{text}</span></span>
        </div>
        {pctLabel && r.band !== 'EXPIRE' && r.band !== 'PAS_ACTIF' && <span className="vc-pct">{pctLabel}</span>}
      </div>
      {r.pct !== null && (
        <div className="vc-bar" aria-hidden="true">
          <i style={{ width: `${r.band === 'PAS_ACTIF' ? 0 : pct}%` }} />
          <b style={{ left: '49%' }} /><b style={{ left: '21%' }} />
        </div>
      )}
      {(from || until) && (
        <div className="vc-dates small"><span>Du {fmt(from)}</span><span>au {fmt(until)}</span></div>
      )}
    </div>
  );
}

/** Légende de la règle, pour les pages de vérification et les preuves imprimées. */
export function ValidityLegend() {
  return (
    <p className="vc-legend small">
      <span className="vc-dot vc-VERT" /> ≥ 49 % de validité restante
      <span className="vc-dot vc-AMBRE" /> 21 – 49 %
      <span className="vc-dot vc-ROUGE" /> &lt; 21 %
      <span className="muted"> · heure du serveur (Kinshasa)</span>
    </p>
  );
}
