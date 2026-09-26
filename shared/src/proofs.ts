/**
 * Contenu d'un QR MOSOLO → code de la preuve. Un QR peut porter :
 * - un lien de vérification (…/preuve/CODE, …/preuve?c=CODE, …/l/v?c=CODE, …/verifier/CODE, …/verifier-plaque/CODE,
 *   …/verifier-agent/CODE, …/fiscal/verifier/bien|quitus|bail/CODE?s=…, …/publicite/verifier?plaque=JETON) ;
 * - la charge utile signée d'une quittance « MOSOLO1|CODE|SIGNATURE[|DUPLICATA-n] » ;
 * - un jeton signé de titre ou de gilet « MT1.… » (rendu tel quel : le serveur vérifie la signature) ;
 * - un code nu.
 * Utilisé par le scanner de l'application et par le serveur (SMS, WhatsApp, pages légères : un lien collé est accepté).
 */
const TRAILING = new Set(['imprimer']);

export function extractProofCode(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('MOSOLO1|')) return s.split('|')[1] ?? '';
  if (s.startsWith('MT1.')) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  for (const k of ['c', 'code', 'plaque']) {
    const v = u.searchParams.get(k);
    if (v) return v.trim();
  }
  const parts = u.pathname.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  while (parts.length && TRAILING.has(parts[parts.length - 1]!)) parts.pop();
  return parts[parts.length - 1] ?? s;
}
