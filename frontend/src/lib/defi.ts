/**
 * Résolution du défi anti-robots du portail public (module 5) : trouver `nonce` tel que SHA-256(`sel:nonce`) commence
 * par `difficulte` bits nuls. Calcul local (WebCrypto), sans traceur ni service tiers ; quelques dixièmes de seconde.
 */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) { bits += 8; continue; }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
}

export async function solveChallenge(sel: string, difficulte: number, max = 5_000_000): Promise<string> {
  const enc = new TextEncoder();
  for (let n = 0; n < max; n++) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${sel}:${n}`)));
    if (leadingZeroBits(h) >= difficulte) return String(n);
  }
  throw new Error('Défi anti-robots non résolu');
}
