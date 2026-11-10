/**
 * Éléments partagés des écrans de la chaîne véhicule (RFCK) : tuiles d'indicateurs, libellés d'état, types de réponse.
 * Modules 82 à 84 — n° 59–61 dans le catalogue du maître d'ouvrage du 27/09/2026.
 */
import type { ReactNode } from 'react';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import './vehicules.css';

export const NOTE_NUMEROTATION = 'n° 59–61 dans le catalogue du maître d’ouvrage du 27/09/2026';

export interface Indicators {
  controleTechnique: {
    vehiculesConnus: number; ctAJour: number; ctAJourPct: number | null; ctBientotEchus: number; ctEchus: number; defavorables: number; procesVerbaux: number;
    vignettesEnStock: number; vignettesEmises: number; vignettesAnnulees: number; courtoisieEnCours: number; prochainesEcheances30j: number;
  };
  fourriere: {
    enFourriere: number; constatsEnAttente: number; enlevementsDecides: number; sorties: number; mainlevees: number; dureeMoyenneGardeJours: number | null;
    destinationsExecutees: number; gardeLongue: number; recetteLiquidee: { currency: string; amount: string }[]; recettePayee: { currency: string; amount: string }[];
  };
  centres: { actifs: number; suspendus: number; enInstruction: number; alertesAnalytique: number };
  tauxConformite: { peerRatePct: number | null; centres: { centreId: string; name: string; passRate: number | null }[] } | null;
  scan: { scans: number; decisions: number; constatsTransmis: number };
  generatedAt: string;
}

export const hasRole = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'non mesuré' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
export const amounts = (list: { currency: string; amount: string }[] | undefined) => (list && list.length ? list.map((m) => `${Number(m.amount).toLocaleString('fr-FR')} ${m.currency}`).join(' · ') : '—');

/** Tuile d'indicateur : valeur, libellé, précision. */
export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="vc-tile" role="group" aria-label={label}>
      <span className="vc-tile-value">{value}</span>
      <span className="vc-tile-label">{label}</span>
      {hint && <span className="vc-tile-hint small muted">{hint}</span>}
    </div>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="vc-tiles">{children}</div>;
}

export const STATE: Record<string, { tone: Tone; label: string }> = {
  A_JOUR: { tone: 'good', label: 'À jour' }, BIENTOT_ECHU: { tone: 'warning', label: 'Échéance proche' }, ECHU: { tone: 'critical', label: 'Échu' },
  DEFAVORABLE: { tone: 'serious', label: 'Défavorable — contre-visite' }, AUCUN_CONTROLE: { tone: 'neutral', label: 'Aucun contrôle' },
  PAYEE: { tone: 'good', label: 'Payée' }, ECHUE: { tone: 'critical', label: 'Échue' }, CONTESTEE: { tone: 'info', label: 'Contestée' }, AUCUNE: { tone: 'neutral', label: 'Aucune' },
  NON_APPLICABLE: { tone: 'neutral', label: 'Sans objet' }, INDISPONIBLE: { tone: 'neutral', label: 'Indisponible' },
  DISPONIBLE: { tone: 'good', label: 'Disponible' }, BLOQUE: { tone: 'serious', label: 'Bloqué' }, PROPRIETAIRE_NON_RATTACHE: { tone: 'neutral', label: 'Propriétaire non rattaché' },
  AGREE: { tone: 'good', label: 'Agréé' }, SUSPENDU: { tone: 'critical', label: 'Suspendu' }, INVITE: { tone: 'info', label: 'Invité' }, DOSSIER_DEPOSE: { tone: 'info', label: 'Dossier déposé' },
  DILIGENCE_FAITE: { tone: 'info', label: 'Diligences faites' }, PROPOSE: { tone: 'warning', label: 'Proposé (seconde décision attendue)' }, REFUSE: { tone: 'neutral', label: 'Refusé' },
  CONSTATE: { tone: 'info', label: 'Constaté (décision attendue)' }, ENLEVEMENT_DECIDE: { tone: 'warning', label: 'Enlèvement décidé' }, EN_GARDE: { tone: 'warning', label: 'En garde' },
  SORTI: { tone: 'good', label: 'Sorti' }, DESTINATION_PROPOSEE: { tone: 'serious', label: 'Destination légale proposée' }, DESTINATION_EXECUTEE: { tone: 'neutral', label: 'Destination exécutée' },
  LIQUIDEE: { tone: 'info', label: 'Liquidée' }, ACTE_REQUIS: { tone: 'neutral', label: 'Acte requis — aucun montant' }, PROPRIETAIRE_A_IDENTIFIER: { tone: 'neutral', label: 'Propriétaire à identifier' },
  A_RACCORDER: { tone: 'neutral', label: 'À RACCORDER — convention requise' }, CONVENTION_ACTIVE: { tone: 'good', label: 'Convention active' },
  FRANCHIE: { tone: 'good', label: 'Franchie' }, PRETE_A_VALIDER: { tone: 'warning', label: 'Prête à valider' }, CONDITIONS_NON_REMPLIES: { tone: 'neutral', label: 'Conditions non remplies' },
  EN_ATTENTE_ETAPE_PRECEDENTE: { tone: 'neutral', label: 'Attend l’étape précédente' }, CONFORME: { tone: 'good', label: 'Conforme' }, A_FAIRE: { tone: 'warning', label: 'À faire' },
  A_VERIFIER: { tone: 'warning', label: 'À vérifier' }, CONFIRME: { tone: 'good', label: 'Confirmé' }, DEMANDE: { tone: 'info', label: 'Demandé' }, ANNULE: { tone: 'neutral', label: 'Annulé' }, EN_ATTENTE: { tone: 'warning', label: 'En attente' }, RETIRE: { tone: 'neutral', label: 'Retiré' },
};

export function StateBadge({ state, label }: { state: string; label?: string }) {
  const s = STATE[state] ?? { tone: 'neutral' as Tone, label: state };
  return <StatusBadge tone={s.tone} label={label ?? s.label} />;
}

export function stateLabel(state: string): string {
  return STATE[state]?.label ?? state;
}

/** Âge lisible d'un horodatage (fraîcheur du paquet hors ligne). */
export function ageText(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `il y a ${h} h ${String(min % 60).padStart(2, '0')}` : `il y a ${Math.floor(h / 24)} jours`;
}
