import { VALIDITY_AMBER_MIN_PCT, VALIDITY_GREEN_MIN_PCT } from '@mosolo/shared';

/** Preuves — types de la réponse du résolveur universel (GET /v1/public/preuves?c=…). */
export interface ProofValidity { band: string; pct: number | null; from: string | null; until: string | null; remainingSeconds: number | null; text: string; serverTime: string }

export interface ProofResult {
  found: boolean;
  kind: string;
  kindLabel: string;
  code: string;
  authentic: boolean;
  state: 'VALIDE' | 'EXPIRE' | 'PAS_ACTIF' | 'REVOQUE' | 'SUSPENDU' | 'INVALIDE' | 'REMPLACE' | 'EN_ATTENTE' | 'INCONNU';
  stateLabel: string;
  title: string;
  facts: { label: string; value: string }[];
  validity: ProofValidity | null;
  situation?: { color: string; label: string } | null;
  message: string;
  verifyPath: string;
  checkedAt: string;
  advice: string;
  print?: { qrValue: string; prefix: string; pictogram: string };
  printedAt?: string;
  channels?: { ussd: string; sms: string; whatsapp: string; lite: string };
}

/** États sans compte à rebours : la preuve ne vaut pas (texte explicite à la place). */
export const BLOCKING: Partial<Record<ProofResult['state'], string>> = {
  REVOQUE: 'NON VALABLE — révoqué', SUSPENDU: 'SUSPENDU', INVALIDE: 'NON VALABLE', REMPLACE: 'REMPLACÉ — seule la nouvelle preuve fait foi',
  EN_ATTENTE: 'EN ATTENTE DE PAIEMENT — ne vaut pas titre', INCONNU: 'CODE INCONNU',
};

export const proofUrl = (code: string) => `/preuve/${encodeURIComponent(code)}`;
export const proofPrintUrl = (code: string) => `/preuve/${encodeURIComponent(code)}/imprimer`;

/** Échéancier des couleurs (support papier : un compte à rebours ne peut pas s'y dérouler). */
export function colourSchedule(from: string, until: string): { green: number; amber: number; end: number } {
  const f = Date.parse(from); const u = Date.parse(until);
  const total = u - f;
  return { green: f + total * (1 - VALIDITY_GREEN_MIN_PCT / 100), amber: f + total * (1 - VALIDITY_AMBER_MIN_PCT / 100), end: u };
}
