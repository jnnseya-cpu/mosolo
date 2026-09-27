/**
 * Service de l'application web (PWA construite) par l'API elle-même, pour un déploiement en un seul service
 * (démonstration hébergée). Activé seulement si `MOSOLO_STATIC_DIR` désigne le dossier `frontend/dist`.
 * Toute requête GET hors `/v1/` sans fichier correspondant renvoie `index.html` (routage côté client).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.pmtiles': 'application/octet-stream', '.pbf': 'application/x-protobuf', '.traineddata': 'application/octet-stream', '.gz': 'application/gzip',
};

export interface StaticFile { body: Buffer; type: string; immutable: boolean }

export function staticSiteFromEnv(env: NodeJS.ProcessEnv = process.env): ((url: string) => StaticFile | null) | null {
  const dir = env.MOSOLO_STATIC_DIR?.trim();
  if (!dir) return null;
  const root = resolve(dir);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`MOSOLO_STATIC_DIR : index.html introuvable dans ${root} (construire d'abord : npm run build -w frontend).`);
  const index = readFileSync(join(root, 'index.html'));
  return (url: string) => {
    let path: string;
    try {
      path = decodeURIComponent(url.split('?')[0] ?? '/');
    } catch {
      return null; // Encodage invalide (« %E0%A4%A ») : 404, jamais une erreur interne.
    }
    // Octet nul : jamais transmis au système de fichiers.
    if (path.includes('\0')) return null;
    if (path.startsWith('/v1/') || path === '/v1') return null;
    const file = normalize(join(root, path));
    // Jamais hors du dossier publié (« ../ »).
    if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      return { body: readFileSync(file), type: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', immutable: path.startsWith('/assets/') };
    }
    return { body: index, type: TYPES['.html']!, immutable: false };
  };
}
