/**
 * Marque des documents HTML générés par le serveur (30/09/2026 : « tout document généré, imprimé, PDF… est à l'image de
 * la plateforme ») : en-tête (logo de la Ville de Kinshasa, « Ville-Province de Kinshasa · KINSHASA MOSOLO », filet
 * tricolore) et pied (« réalisée par Groupe Nseya » avec son logo). Logos incorporés en « data: » (compatibles avec la
 * politique de sécurité des pages légères), variantes légères pour le faible débit ; logos jamais modifiés.
 */
import { BRAND_TEXT, dataUri, LOGO_NSEYA_PETIT, LOGO_VILLE_MINI, LOGO_VILLE_PETIT } from './brand-assets.js';

/** Styles de l'en-tête et du pied de marque (à insérer dans le <style> de la page). */
export const BRAND_CSS = `.mb-head{display:flex;align-items:center;gap:10px;padding:6px 0 8px}.mb-head img{height:40px;width:auto}
.mb-head b{display:block;font-size:14px}.mb-head span{font-size:12px;letter-spacing:.06em}
.mb-tri{display:flex;height:4px;margin-bottom:8px}.mb-tri i{flex:1}.mb-tri i:nth-child(1){background:#1E9BD7}.mb-tri i:nth-child(2){background:#F7D618}.mb-tri i:nth-child(3){background:#D7141A}
.mb-foot{display:flex;align-items:center;gap:6px;font-size:11px;color:#555;margin-top:10px}.mb-foot img{height:14px;width:auto}
@media print{.mb-head,.mb-tri,.mb-foot{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

/** `leger` : pages « version légère » (limite de 10 Ko) — logo minimal. */
export function brandHeaderHtml(sousTitre?: string, leger = false): string {
  const logo = leger ? LOGO_VILLE_MINI : LOGO_VILLE_PETIT;
  return `<div class="mb-head"><img src="${dataUri(logo)}" alt="Ville de Kinshasa" width="${logo.width}" height="${logo.height}"><div><b>${BRAND_TEXT.institution}</b><span>${BRAND_TEXT.plateforme}${sousTitre ? ` · ${sousTitre}` : ''}</span></div></div><div class="mb-tri" aria-hidden="true"><i></i><i></i><i></i></div>`;
}

/** `leger` : mention texte seule (pages « version légère », limite de 10 Ko). */
export function brandFooterHtml(leger = false): string {
  if (leger) return `<div class="mb-foot"><span>${BRAND_TEXT.realisation}</span></div>`;
  return `<div class="mb-foot"><img src="${dataUri(LOGO_NSEYA_PETIT)}" alt="" width="${LOGO_NSEYA_PETIT.width}" height="${LOGO_NSEYA_PETIT.height}"><span>${BRAND_TEXT.realisation}</span></div>`;
}
