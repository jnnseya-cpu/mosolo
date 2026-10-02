import type { Tone } from '../../components/StatusBadge';
import type { ActionStatus, Autonomy, Confidence, IaStatus } from './types';

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  A_AUTO: 'Niveau A — exécution automatique',
  B_VALIDATION: 'Niveau B — après validation',
  C_RECOMMANDATION: 'Niveau C — recommandation seule',
};
export const AUTONOMY_SHORT: Record<Autonomy, string> = { A_AUTO: 'A', B_VALIDATION: 'B', C_RECOMMANDATION: 'C' };
export const AUTONOMY_HELP: Record<Autonomy, string> = {
  A_AUTO: 'Sans effet juridique ni financier, réversible : exécuté et journalisé ; désactivable par le responsable de l’entité.',
  B_VALIDATION: 'Effet sur un tiers : exécuté seulement après un clic de validation d’un agent habilité, en son nom ; annulable.',
  C_RECOMMANDATION: 'Effet juridique ou financier : jamais exécuté ; la décision suit le circuit maker-checker du domaine.',
};

export const STATUS_LABEL: Record<IaStatus, string> = {
  EMISE: 'À décider', TRAITEE_AUTO: 'Traitée automatiquement', ACCEPTEE: 'Acceptée', MODIFIEE: 'Modifiée', REJETEE: 'Rejetée', ANNULEE: 'Annulée',
};
export const STATUS_TONE: Record<IaStatus, Tone> = {
  EMISE: 'warning', TRAITEE_AUTO: 'info', ACCEPTEE: 'good', MODIFIEE: 'good', REJETEE: 'critical', ANNULEE: 'neutral',
};

export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  PROPOSEE: 'Proposée', EXECUTEE_AUTO: 'Exécutée (auto)', EXECUTEE: 'Exécutée (validée)', ANNULEE: 'Annulée',
  ABANDONNEE: 'Abandonnée', NON_EXECUTEE_DESACTIVEE: 'Non exécutée — autonomie désactivée',
};
export const ACTION_STATUS_TONE: Record<ActionStatus, Tone> = {
  PROPOSEE: 'warning', EXECUTEE_AUTO: 'info', EXECUTEE: 'good', ANNULEE: 'neutral', ABANDONNEE: 'neutral', NON_EXECUTEE_DESACTIVEE: 'serious',
};

export const CONF_LABEL: Record<Confidence, string> = { HIGH: 'Élevée', MEDIUM: 'Moyenne', LOW: 'Faible' };
export const CONF_TONE: Record<Confidence, Tone> = { HIGH: 'good', MEDIUM: 'warning', LOW: 'serious' };

export const DOMAIN_LABEL: Record<string, string> = {
  OBJETS: 'Objets fiscaux', BAUX: 'Baux', OBSERVATIONS_TERRAIN: 'Constats terrain', CONFLITS_TERRAIN: 'Conflits terrain', EQUIPES_TERRAIN: 'Équipes terrain',
  COMPTE_PROPRE: 'Compte de l’usager', OBLIGATIONS_PROPRES: 'Obligations de l’usager', OBLIGATIONS: 'Obligations', PAIEMENTS: 'Paiements',
  EXCEPTIONS_TRESOR: 'Exceptions de rapprochement', REGLES: 'Règles', INSTRUMENTS: 'Textes juridiques', RECOURS: 'Réclamations', ALERTES: 'Alertes',
  JOURNAL_AUDIT: 'Journal d’audit (pseudonymisé)', TERMINAUX: 'Terminaux', CONTRIBUABLES_AGREGES: 'Contribuables (agrégats)', COFFRE: 'Comptes publics',
  COMMUNICATIONS: 'Communications', DECISIONS_IA: 'Décisions humaines', BASE_CONNAISSANCES: 'Pages d’aide',
};

export const EFFECT_LABEL: Record<string, string> = {
  TACHE: 'Tâche', BROUILLON: 'Brouillon', RESUME: 'Résumé', ETIQUETTE: 'Étiquette', RAPPEL: 'Rappel', DEMANDE_PIECES: 'Demande de pièces',
  MISSION: 'Mission terrain', RELANCE: 'Relance', DOSSIER_VERIFICATION: 'Dossier de vérification',
};

export const JOURNAL_LABEL: Record<string, string> = {
  GENERATION: 'Génération', EXECUTION_AUTO: 'Exécution automatique (A)', BLOCAGE_AUTONOMIE: 'Blocage (autonomie désactivée)',
  VALIDATION: 'Validation humaine', EXECUTION: 'Exécution au nom du validateur', DECISION: 'Décision humaine', ANNULATION: 'Annulation', REFUS: 'Coupe-circuit',
};

export const ENTITIES = ['GOUVERNORAT', 'MINFIN', 'DGIPK', 'TRESOR', 'AUDIT', 'PLATEFORME'] as const;

export function latency(ms?: number | null): string {
  if (ms === undefined || ms === null) return '—';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'moins d’une minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${Math.floor(h / 24)} j`;
}

export const short = (h?: string) => (h ? `${h.slice(0, 10)}…` : '—');
