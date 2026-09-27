/**
 * Outils communs des photos de preuve (stationnement, publicité) : image redessinée avec un bandeau d'horodatage
 * incrusté, ré-encodée en JPEG sous la limite du serveur, empreinte SHA-256 calculée sur l'appareil (le serveur la
 * recalcule et refuse toute image altérée en transit).
 */

/** Taille maximale visée d'une photo (le serveur refuse au-delà de 900 Ko). */
export const MAX_JPEG_BYTES = 880_000;

/** Date et heure de Kinshasa, pour l'incrustation. */
export const kinTime = (t: number) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Dessine l'image puis le bandeau d'horodatage incrusté (lisible, non détachable de l'image). */
export function stamp(canvas: HTMLCanvasElement, source: CanvasImageSource, sw: number, sh: number, lines: string[]) {
  const scale = Math.min(1, 1280 / Math.max(sw, sh));
  const w = Math.round(sw * scale); const h = Math.round(sh * scale);
  const fs = Math.max(14, Math.round(w / 48));
  const band = lines.length * (fs + 6) + 12;
  canvas.width = w; canvas.height = h + band;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, w, h);
  ctx.fillStyle = '#10163a'; ctx.fillRect(0, h, w, band);
  ctx.fillStyle = '#F7D618'; ctx.fillRect(0, h, w, 3);
  ctx.fillStyle = '#ffffff'; ctx.font = `600 ${fs}px system-ui, Arial, sans-serif`; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, 10, h + 8 + i * (fs + 6), w - 20));
  // Filigrane discret dans l'image : l'heure reste visible même si le bandeau est recadré.
  ctx.save(); ctx.globalAlpha = 0.35; ctx.font = `700 ${Math.round(fs * 0.9)}px system-ui, Arial`; ctx.fillStyle = '#ffffff';
  ctx.fillText(lines[1] ?? '', 10, 10, w - 20); ctx.restore();
}

/** JPEG de qualité décroissante jusqu'à passer sous la limite du serveur. */
export async function encode(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  for (const q of [0.82, 0.7, 0.58, 0.45]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= MAX_JPEG_BYTES) return blob.arrayBuffer();
  }
  throw new Error('Photo trop lourde.');
}
