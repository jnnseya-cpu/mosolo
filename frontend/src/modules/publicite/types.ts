/** Types du contrat /v1/publicite (KIN PUB CONTROL) et libellés. */
import type { MoneyJSON } from '@mosolo/shared';
import type { Tone } from '../../components/StatusBadge';

export type DeviceStatus = 'AUTORISE' | 'EXPIRE' | 'DECLARE' | 'NON_DECLARE' | 'RETIRE';

export interface Device {
  id: string; reference: string; qrToken: string; type: string; widthM: string; heightM: string; surfaceM2: string; faces: number; lighting: string;
  commune: string; quartier: string; address: string; localityRank: number; lat: number; lon: number; photos: string[]; origin: 'DECLARATION' | 'RECENSEMENT';
  placement?: string; vehiclePlate?: string | null; vehicleKind?: string | null; businessName?: string | null; businessObjectId?: string | null;
  status: DeviceStatus; expiringSoon: boolean; rights: 'A_JOUR' | 'IMPAYE' | 'ACTE_REQUIS' | 'SANS_OBJET';
  authorization: { id: string; reference: string; validFrom: string; validUntil: string } | null;
  openCase: { id: string; reference: string; finding: string } | null; inspections: number; ownerIdentified: boolean;
  owner?: { taxpayerId: string; name: string } | null; presumedOperator?: string | null; demo: boolean; createdAt: string;
}

export interface Notice {
  obligationId: string; label: string; amount: MoneyJSON; dueDate: string; status: string; ruleCode: string; ruleVersion: number; commune: string | null;
  base: Record<string, string>; formula: string; rates: Record<string, string>; appealPath: string; legalBasis: string[]; payment: string; source: string;
}

export interface AuthRequest {
  id: string; reference: string; deviceId: string; periodFrom: string; periodTo: string; status: 'DEPOSEE' | 'COMPLEMENT_DEMANDE' | 'PROPOSEE' | 'ACCORDEE' | 'REFUSEE';
  pieces: { kind: string; name: string; sha256: string; addedAt: string }[]; history: { at: string; by: string; action: string; note: string }[];
  instruction?: { by: string; proposal: string; analysis: string }; decision?: { by: string; outcome: string; reason: string; at: string };
  liquidation?: { status: 'EMISE' | 'ACTE_REQUIS'; obligationId: string | null; note: string };
  /** Liquidation différée (barème devenu actif) : proposition d'un instructeur, approbation par une autre personne. */
  liquidationProposal?: { by: string; at: string; note: string; ruleCode: string; ruleVersion: number };
  device: { id: string; reference: string; type: string; commune: string; surfaceM2: string; faces: number } | null; obligation: Notice | null; submittedAt: string;
}

/** Photo de preuve d'une inspection, versée au serveur avant le constat (sans l'image : lue par `url`). */
export interface AdPhotoMeta {
  id: string; sha256: string; mime: 'image/jpeg'; sizeBytes: number; lat: number; lon: number; accuracyM: number | null; gpsSource: 'GPS' | 'MANUEL' | 'ZONE';
  stampedAt: string; receivedAt: string; clockSkewSeconds: number; agentId: string; inspectionId: string | null; url: string; clockWarning: boolean; lowAccuracy: boolean;
}

export interface Case {
  id: string; reference: string; deviceId: string; commune: string; finding: 'NON_CONFORME' | 'NON_DECLARE' | 'RETIRE';
  status: 'CONSTATE' | 'VERIFIE' | 'REJETE_QA' | 'RETENU' | 'CLASSE'; createdAt: string;
  verification?: { by: string; outcome: string; note: string }; decision?: { by: string; outcome: string; reason: string; effect: string; obligationId: string | null; at: string };
  notifiedAt?: string; contests: { id: string; at: string; grounds: string; stage: string; appealId?: string }[];
  inspection: {
    reference: string; inspectorId: string; photos: string[]; lat: number; lon: number; observedAt: string; observations: string; ocrMatches: string[]; presumedOperator: string | null;
    /** Photos conservées au serveur (JPEG reçu, empreinte vérifiée) ; absentes des dossiers anciens. */
    serverPhotos?: AdPhotoMeta[];
    /** Preuve faible : aucune photo conservée au serveur, ou position imprécise / ajustée à la main. */
    weakEvidence?: boolean;
  } | null;
  device: { id: string; reference: string; type: string; commune: string; address: string; surfaceM2: string; faces: number; ownerIdentified: boolean } | null;
  obligation: Notice | null; appealPath: string;
}

export const AD_TYPE: Record<string, string> = {
  PANNEAU: 'Panneau', ENSEIGNE: 'Enseigne', ECRAN_NUMERIQUE: 'Écran numérique', BACHE: 'Bâche', BANDEROLE: 'Banderole', KAKEMONO: 'Kakémono',
  CHEVALET: 'Chevalet (devant un commerce)', AFFICHE_MURALE: 'Affiche murale', HABILLAGE_VEHICULE: 'Publicité sur véhicule', AUTRE: 'Autre',
};
/** Emplacement du support : dédié, façade ou porte d'un commerce, devant un commerce, véhicule (mobile). */
export const PLACEMENT: Record<string, string> = {
  SUPPORT_DEDIE: 'Support dédié (panneau, écran, bâche, banderole)', FACADE_COMMERCE: 'Façade ou porte d’un commerce (enseigne)',
  DEVANT_COMMERCE: 'Devant un commerce (chevalet, kakémono)', VEHICULE: 'Véhicule ou objet mobile',
};
export const VEHICLE_KIND: Record<string, string> = {
  VOITURE: 'Voiture', TAXI: 'Taxi', BUS: 'Bus / taxi-bus', CAMION: 'Camion', MOTO: 'Moto', TRICYCLE: 'Tricycle', REMORQUE: 'Remorque', AUTRE: 'Autre objet mobile',
};
export const LIGHTING: Record<string, string> = { NON_ECLAIRE: 'Non éclairé', ECLAIRE: 'Éclairé', NUMERIQUE: 'Numérique' };
export const PIECE: Record<string, string> = {
  PLAN_SITUATION: 'Plan de situation', PHOTO_MONTAGE: 'Photo-montage', TITRE_OCCUPATION: 'Titre d’occupation', ACCORD_PROPRIETAIRE: 'Accord du propriétaire', STATUTS: 'Statuts', AUTRE: 'Autre pièce',
};
export const DEVICE_STATUS: Record<DeviceStatus, { tone: Tone; label: string; color: string }> = {
  AUTORISE: { tone: 'good', label: 'Autorisé', color: '#0ca30c' },
  EXPIRE: { tone: 'warning', label: 'Autorisation expirée', color: '#c98700' },
  DECLARE: { tone: 'info', label: 'Déclaré — autorisation en attente', color: '#1E9BD7' },
  NON_DECLARE: { tone: 'critical', label: 'Non déclaré', color: '#d03b3b' },
  RETIRE: { tone: 'neutral', label: 'Retiré', color: '#8A90A0' },
};
export const RIGHTS: Record<Device['rights'], { tone: Tone; label: string }> = {
  A_JOUR: { tone: 'good', label: 'Droits payés' }, IMPAYE: { tone: 'warning', label: 'Droits à payer' },
  ACTE_REQUIS: { tone: 'neutral', label: 'Barème non publié' }, SANS_OBJET: { tone: 'neutral', label: 'Aucun droit liquidé' },
};
export const REQUEST_STATUS: Record<AuthRequest['status'], { tone: Tone; label: string }> = {
  DEPOSEE: { tone: 'neutral', label: 'Déposée — en instruction' }, COMPLEMENT_DEMANDE: { tone: 'warning', label: 'Complément demandé' },
  PROPOSEE: { tone: 'info', label: 'Instruite — décision attendue' }, ACCORDEE: { tone: 'good', label: 'Accordée' }, REFUSEE: { tone: 'critical', label: 'Refusée' },
};
export const FINDING: Record<string, string> = { CONFORME: 'Conforme', NON_CONFORME: 'Non conforme', NON_DECLARE: 'Non déclaré', RETIRE: 'Retiré' };
export const CASE_STATUS: Record<Case['status'], { tone: Tone; label: string }> = {
  CONSTATE: { tone: 'neutral', label: 'Constaté — à vérifier' }, VERIFIE: { tone: 'warning', label: 'Vérifié — décision attendue' },
  REJETE_QA: { tone: 'info', label: 'Écarté (qualité)' }, RETENU: { tone: 'serious', label: 'Retenu' }, CLASSE: { tone: 'info', label: 'Classé' },
};
