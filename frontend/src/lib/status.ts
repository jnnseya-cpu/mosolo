import type { MapStatusColor } from '@mosolo/shared';
import type { Tone } from '../components/StatusBadge';
import type { UIKey } from './i18n';

export const OBLIGATION_TONE: Record<string, Tone> = {
  EMISE: 'neutral', EXIGIBLE: 'warning', PARTIELLEMENT_PAYEE: 'info', SOLDEE: 'good', EN_RETARD: 'critical',
  CONTESTEE: 'serious', ANNULEE: 'neutral', ADMISE_EN_NON_VALEUR: 'neutral',
};
export const RECEIPT_TONE: Record<string, { tone: Tone; key: UIKey }> = {
  PROVISOIRE: { tone: 'warning', key: 'receipt.provisional' }, DEFINITIVE: { tone: 'good', key: 'receipt.final' },
  ANNULEE: { tone: 'critical', key: 'receipt.cancelled' }, REMPLACEE: { tone: 'info', key: 'receipt.replaced' },
  SUSPECTE: { tone: 'serious', key: 'receipt.suspect' },
};
export const PAYMENT_TONE: Record<string, Tone> = {
  INITIE: 'neutral', CONFIRME: 'info', REGLE: 'info', RAPPROCHE: 'good', ECHOUE: 'critical', DOUBLON: 'serious',
  CONTREPASSE: 'serious', REMBOURSE: 'neutral', CONTESTE: 'warning',
};
/** Couleurs de situation cartographique (§ 16.6) — toujours avec icône et libellé. */
export const MAP_STATUS: Record<MapStatusColor, { color: string; icon: string; key: UIKey }> = {
  green: { color: '#0ca30c', icon: 'check', key: 'map.green' },
  amber: { color: '#fab219', icon: 'alert', key: 'map.amber' },
  red: { color: '#d03b3b', icon: 'x', key: 'map.red' },
  grey: { color: '#8A90A0', icon: 'question', key: 'map.grey' },
  blue: { color: '#1E9BD7', icon: 'file', key: 'map.blue' },
};
export function obligationKey(s: string): UIKey {
  return `obligation.status.${s}` as UIKey;
}
