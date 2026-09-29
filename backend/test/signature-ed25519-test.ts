/**
 * Clé Ed25519 de test de la « plateforme BitriPay » (29/09/2026) : la signature Ed25519 est désormais EXIGÉE dès qu'une
 * clé BitriPay est configurée (décision du maître d'ouvrage). Les tests signent donc leurs webhooks comme BitriPay :
 * en-tête « keyId,t,sig » sur « t.<corps brut> ».
 */
import { generateKeyPairSync, sign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
/** Clé publique brute (32 octets, base64), format accepté par BITRIPAY_ED25519_PUBLIC_KEY. */
export const BITRI_ED_PUBLIC = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
/** En-tête BitriPay-Signature-Ed25519 « keyId,t,sig ». */
export function bitriEdHeader(raw: string, t: number): string {
  return `k1,${t},${sign(null, Buffer.from(`${t}.${raw}`, 'utf8'), privateKey).toString('base64')}`;
}
