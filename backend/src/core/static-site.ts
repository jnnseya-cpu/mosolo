/**
 * Service de l'application web (PWA construite) par l'API elle-même, pour un déploiement en un seul service
 * (démonstration hébergée). Activé seulement si `MOSOLO_STATIC_DIR` désigne le dossier `frontend/dist`.
 * Toute requête GET hors `/v1/` sans fichier correspondant renvoie `index.html` (routage côté client).
 * Fond de carte OpenStreetMap de Kinshasa (`/tiles/kinshasa.pmtiles`, ~24 Mo, fabriqué par tools/maps) : lu par
 * plages d'octets (`Range`, réponse 206) sans charger le fichier entier ; un fichier absent sous `/tiles/` répond 404
 * (jamais `index.html`), pour que l'application affiche le message « non encore installé ».
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.pmtiles': 'application/octet-stream', '.pbf': 'application/x-protobuf', '.traineddata': 'application/octet-stream', '.gz': 'application/gzip',
};

export interface StaticFile {
  body: Buffer; type: string; immutable: boolean;
  /** Fichier sur disque (absent pour index.html en repli) : sert les plages d'octets et l'ETag. */
  file?: string; size?: number; mtimeMs?: number;
  /** En-tête cache-control imposé (fond de carte) ; sinon immutable / no-cache. */
  cacheControl?: string;
}

/** Fond de carte : revalidé au plus toutes les heures (même nom de fichier à chaque reconstruction mensuelle). */
export const TILES_CACHE_CONTROL = 'public, max-age=3600';

/** Plage d'octets demandée (une seule plage « bytes=a-b », « bytes=a- » ou « bytes=-n ») ; null = en-tête ignoré. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalide' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // Plusieurs plages ou syntaxe inconnue : fichier entier (RFC 9110).
  let start: number; let end: number;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'invalide'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return 'invalide';
  return { start, end };
}

/** Lit seulement la plage demandée (jamais le fichier entier). */
export function readRange(file: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start + 1);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  return buf;
}

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
      const st = statSync(file);
      const tiles = path.startsWith('/tiles/');
      return {
        // Lecture paresseuse : une requête par plage d'octets ne charge jamais le fichier entier.
        get body() { return readFileSync(file); },
        type: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', immutable: path.startsWith('/assets/'),
        file, size: st.size, mtimeMs: st.mtimeMs, ...(tiles ? { cacheControl: TILES_CACHE_CONTROL } : {}),
      };
    }
    // Fond de carte absent : 404 (l'application affiche alors « Fond OpenStreetMap de Kinshasa non encore installé »).
    if (path.startsWith('/tiles/')) return null;
    return { body: index, type: TYPES['.html']!, immutable: false };
  };
}
