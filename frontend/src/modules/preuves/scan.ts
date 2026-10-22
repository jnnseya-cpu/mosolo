/**
 * Où ouvrir le contenu d'un QR scanné. Les liens vers une page de vérification de l'application (quel que soit le
 * domaine imprimé) y conduisent directement, avec leurs paramètres (signature « s », duplicata) ; le reste passe par
 * le résolveur universel « Vérifier une preuve ».
 */
import { extractProofCode } from '@mosolo/shared';

const IN_APP = [/^\/verifier\//, /^\/verifier-plaque\//, /^\/verifier-agent\//, /^\/fiscal\/verifier\//, /^\/publicite\/verifier/, /^\/canaux\/verifier-carte/];

export function scanTarget(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('MOSOLO1|')) {
    const parts = s.split('|');
    const dup = /^DUPLICATA-(\d+)$/.exec(parts[3] ?? '');
    return `/verifier/${encodeURIComponent(parts[1] ?? '')}${dup ? `?duplicata=${dup[1]}` : ''}`;
  }
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/imprimer\/?$/, '');
    if (IN_APP.some((r) => r.test(path))) return `${path}${u.search}`;
  } catch { /* pas un lien */ }
  const code = extractProofCode(s);
  return code.length > 60 ? `/preuve?c=${encodeURIComponent(code)}` : `/preuve/${encodeURIComponent(code)}`;
}
