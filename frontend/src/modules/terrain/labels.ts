/** Libellés et tons d'état du module terrain (français, langue de référence). */
import type { Tone } from '../../components/StatusBadge';
import type { AgentStatus, FindingOutcome, FindingStatus, MissionStatus, PublicBadgeResult, SubcontractorStatus } from './types';

export const MODULE_LABEL: Record<string, string> = {
  FONCIER_LOCATIF: 'Foncier et locatif', PATENTES: 'Activités et patentes', VEHICULES: 'Véhicules', STATIONNEMENT: 'Stationnement',
  PUBLICITE: 'Publicité extérieure', ANTENNES: 'Antennes', MARCHES_DOMAINE_PUBLIC: 'Marchés et domaine public', CARRIERES: 'Carrières',
  PORTS: 'Ports et embarcations', SPECTACLES: 'Spectacles', ENROLEMENT_ASSISTE: 'Enrôlement assisté', RECOUVREMENT_AMIABLE: 'Recouvrement amiable',
};
export const moduleLabel = (m: string) => MODULE_LABEL[m] ?? m;

export const ST_STATUS: Record<SubcontractorStatus, { label: string; tone: Tone }> = {
  INVITE: { label: 'Invité', tone: 'neutral' },
  EN_DILIGENCE: { label: 'En diligence', tone: 'info' },
  ACCREDITE_PROBATOIRE: { label: 'Accrédité — probatoire', tone: 'warning' },
  ACCREDITE: { label: 'Accrédité', tone: 'good' },
  SUSPENDU: { label: 'Suspendu', tone: 'critical' },
  RETIRE: { label: 'Retiré', tone: 'critical' },
};

export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone }> = {
  INVITE: { label: 'Invité — inactif', tone: 'neutral' },
  HABILITE: { label: 'Habilité', tone: 'good' },
  SUSPENDU: { label: 'Suspendu', tone: 'critical' },
  REVOQUE: { label: 'Révoqué', tone: 'critical' },
};

export const MISSION_STATUS: Record<MissionStatus, { label: string; tone: Tone }> = {
  A_AFFECTER: { label: 'À affecter', tone: 'warning' },
  AFFECTEE: { label: 'Affectée', tone: 'info' },
  EN_COURS: { label: 'En cours', tone: 'info' },
  TERMINEE: { label: 'Terminée', tone: 'good' },
  ANNULEE: { label: 'Annulée', tone: 'neutral' },
};

export const FINDING_STATUS: Record<FindingStatus, { label: string; tone: Tone }> = {
  SOUMIS: { label: 'À revoir', tone: 'warning' },
  A_CONTRE_VISITER: { label: 'Contre-visite', tone: 'serious' },
  VALIDE: { label: 'Validé', tone: 'good' },
  REJETE: { label: 'Rejeté', tone: 'critical' },
};

export const OUTCOME_LABEL: Record<FindingOutcome, string> = {
  CONSTATE: 'Objet constaté', ABSENT: 'Occupant absent', REFUS: 'Refus consigné', OBJET_NON_ENREGISTRE: 'Objet non enregistré',
};

export const FLAG_LABEL: Record<string, string> = {
  DISTANCE: 'Écart au point enregistré', HORS_ZONE: 'Hors zone de mission', GPS_IMPRECIS: 'GPS imprécis', SANS_PHOTO: 'Sans photo',
};

export const BADGE_RESULT: Record<PublicBadgeResult, { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral' | 'serious'; icon: string; lead: string }> = {
  VALIDE: { label: 'Agent habilité', tone: 'good', icon: 'check', lead: 'Ce badge est valide : la personne est habilitée pour la zone et la période indiquées.' },
  SUSPENDU: { label: 'Agent suspendu', tone: 'critical', icon: 'ban', lead: 'Cet agent est suspendu : il ne peut effectuer aucune opération.' },
  REVOQUE: { label: 'Badge révoqué', tone: 'critical', icon: 'ban', lead: 'Ce badge a été révoqué ou remplacé : il n’est plus valable.' },
  EXPIRE: { label: 'Badge expiré', tone: 'warning', icon: 'clock', lead: 'L’habilitation de cet agent est arrivée à échéance.' },
  INCONNU: { label: 'Badge inconnu', tone: 'serious', icon: 'alert', lead: 'Aucun agent habilité ne correspond à ce code.' },
};

/** Pourcentage (chaîne décimale renvoyée par l'API) → affichage français. */
export const fmtPct = (p: string | null | undefined) => (p == null ? '—' : `${p.replace('.', ',')} %`);
