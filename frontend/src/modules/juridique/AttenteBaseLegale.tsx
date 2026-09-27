/**
 * Mention « en attente de base légale » : un écran affiche ce qu'il attend du registre des points juridiques
 * (J1–J30). Rien n'est désactivé par cette mention ; hors ligne, l'hypothèse prudente (point ouvert) est affichée.
 */
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { Icon } from '../../components/Icon';

export type FonctionConditionnee = 'ECHEANCIERS_MOBILE_MONEY' | 'COMMISSIONS_VERSEMENT' | 'AGREGATEURS_ACTIVATION' | 'QUITTANCE_ELECTRONIQUE' | 'RECOUPEMENT_DONNEES';

export interface EtatFonction {
  code: FonctionConditionnee; label: string; enAttente: boolean; message: string;
  points: { code: string; statut: 'OUVERT' | 'TRANCHE'; question: string }[];
}

/** Messages prudents (hors ligne) : repris du registre du serveur. */
export const ATTENTE_PAR_DEFAUT: Record<FonctionConditionnee, string> = {
  ECHEANCIERS_MOBILE_MONEY: 'Paiement fractionné en attente de base légale (J14).',
  COMMISSIONS_VERSEMENT: 'Paiement en attente de base légale (J10).',
  AGREGATEURS_ACTIVATION: 'Activation en production en attente d’habilitation BCC (J9, J20).',
  QUITTANCE_ELECTRONIQUE: 'Valeur juridique de la quittance électronique en attente de confirmation : double preuve (électronique et imprimable signée) (J7, J17).',
  RECOUPEMENT_DONNEES: 'Ingestion de données partenaires en attente de protocole et de base légale (J13, J8).',
};

export function AttenteBaseLegale({ fonction, compact = false }: { fonction: FonctionConditionnee; compact?: boolean }) {
  const q = useApi(() => api<EtatFonction>(`/v1/public/juridique/fonctions/${fonction}`), [fonction]);
  if (q.loading) return null;
  if (q.data && !q.data.enAttente) return null;
  const message = q.data?.message ?? ATTENTE_PAR_DEFAUT[fonction];
  return (
    <p className={`callout callout-warn${compact ? ' small' : ''}`} role="note" data-fonction={fonction}>
      <Icon name="scale" size={16} />
      <span>{message} <a href="/juridique/points" className="small">Registre des points juridiques</a></span>
    </p>
  );
}
