import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Moteur de lecture des plaques (OCR, Tesseract) servi par MOSOLO lui-même depuis /ocr/ : aucun appel à un service
 * externe, utilisable hors réseau une fois chargé. Les fichiers sont copiés depuis node_modules au démarrage.
 */
function ocrAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const files: [string, string][] = [];
  const add = (pkg: string, rel: string, as?: string) => {
    try {
      const dir = dirname(require.resolve(`${pkg}/package.json`));
      files.push([join(dir, rel), as ?? rel.split('/').pop()!]);
    } catch { /* paquet absent : lecture de plaque indisponible, saisie manuelle */ }
  };
  add('tesseract.js', 'dist/worker.min.js');
  for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) add('tesseract.js-core', f);
  add('@tesseract.js-data/eng', '4.0.0_best_int/eng.traineddata.gz');
  return {
    name: 'mosolo-ocr-assets',
    buildStart() {
      const out = join(__dirname, 'public', 'ocr');
      mkdirSync(out, { recursive: true });
      for (const [src, name] of files) {
        const dest = join(out, name);
        if (existsSync(src) && (!existsSync(dest) || statSync(dest).size !== statSync(src).size)) copyFileSync(src, dest);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    ocrAssets(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['logo-groupe-nseya.png', 'logo-ville-de-kinshasa.png', 'icons/*.png', 'icons/*.svg', 'media/*'],
      manifest: {
        name: 'KINSHASA MOSOLO',
        short_name: 'MOSOLO',
        description: 'Plateforme souveraine des recettes de la Ville Province de Kinshasa — une ville, un contribuable, une donnée, une quittance.',
        lang: 'fr',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#232C6B',
        background_color: '#F5F7FB',
        categories: ['finance', 'government', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest,woff2}'],
        // Moteur OCR (~7 Mo) : hors du pré-cache d'installation, mis en cache à la première lecture de plaque.
        globIgnores: ['**/ocr/**'],
        navigateFallback: '/index.html',
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/ocr/'),
            handler: 'CacheFirst',
            options: { cacheName: 'mosolo-ocr', cacheableResponse: { statuses: [0, 200] }, expiration: { maxEntries: 10 } },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/v1/meta',
            handler: 'NetworkFirst',
            options: { cacheName: 'mosolo-meta', networkTimeoutSeconds: 4, cacheableResponse: { statuses: [0, 200] } },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/v1/public/receipts/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'mosolo-receipt-checks',
              networkTimeoutSeconds: 4,
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
