/**
 * En-têtes de sécurité HTTP (OWASP) posés sur chaque réponse, sans écraser ceux qu'une route fixe elle-même
 * (p. ex. la politique de contenu des pages légères /l du module « preuves »).
 *
 *  - toutes les réponses : pas de reniflage de type, pas d'intégration en cadre, aucun référent transmis, HTTPS strict
 *    (HSTS ignoré par les navigateurs sur HTTP simple : sans effet en développement local), isolation de la fenêtre,
 *    permissions du navigateur limitées à ce que l'application utilise (caméra : lecture de QR et de plaques ;
 *    géolocalisation : contrôles de terrain) ;
 *  - pages HTML de l'application web (servie par MOSOLO_STATIC_DIR) : politique de contenu (CSP) limitée à l'origine
 *    elle-même — aucun script tiers ; 'wasm-unsafe-eval' pour le moteur de lecture de plaques (WebAssembly) ;
 *    styles en ligne tolérés (attributs `style` de React, écran d'attente) ; images et travailleurs `blob:` (photos
 *    de preuve, carte) ;
 *  - réponses JSON de l'API : politique de contenu fermée (aucune ressource, aucun cadre).
 */
import type { FastifyReply } from 'fastify';

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const PERMISSIONS_POLICY = 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=()';

export function applySecurityHeaders(reply: FastifyReply): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('strict-transport-security', 'max-age=31536000');
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('permissions-policy', PERMISSIONS_POLICY);
  if (!reply.hasHeader('content-security-policy')) {
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) reply.header('content-security-policy', APP_CSP);
    else if (type.includes('json')) reply.header('content-security-policy', API_CSP);
  }
}
