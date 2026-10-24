/**
 * Génère les icônes PWA : carré bleu marine (#232C6B) portant un monogramme « M » blanc
 * et un filet tricolore (bleu, jaune, rouge). L'emblème de la Ville n'est JAMAIS redessiné.
 * Aucune dépendance externe (zlib natif). Usage : node scripts/make-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAVY = [0x23, 0x2c, 0x6b], WHITE = [255, 255, 255];
const BLUE = [0x1e, 0x9b, 0xd7], YELLOW = [0xf7, 0xd6, 0x18], RED = [0xd7, 0x14, 0x1a];
// Monogramme sur une grille de 512
const M = [[128, 356], [128, 132], [180, 132], [256, 250], [332, 132], [384, 132], [384, 356], [338, 356], [338, 212], [272, 312], [240, 312], [174, 212], [174, 356]];

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function colorAt(x, y) {
  if (inPoly(x, y, M)) return WHITE;
  if (y >= 388 && y < 396) {
    if (x >= 184 && x < 232) return BLUE;
    if (x >= 232 && x < 280) return YELLOW;
    if (x >= 280 && x < 328) return RED;
  }
  return NAVY;
}

function render(size) {
  const ss = 4, out = Buffer.alloc(size * size * 3), k = 512 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = colorAt((x + (sx + 0.5) / ss) * k, (y + (sy + 0.5) / ss) * k);
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    for (let i = 0; i < 3; i++) out[(y * size + x) * 3 + i] = Math.round(acc[i] / (ss * ss));
  }
  return out;
}

function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 255; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function encode(size, rgb) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(join(root, 'public/icons'), { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512], ['apple-touch-icon-180.png', 180], ['favicon-48.png', 48]]) {
  writeFileSync(join(root, 'public/icons', name), encode(size, render(size)));
  console.log('icône', name);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#232C6B"/><path fill="#fff" d="M${M.map((p) => p.join(' ')).join(' L')} Z"/><rect x="184" y="388" width="48" height="8" fill="#1E9BD7"/><rect x="232" y="388" width="48" height="8" fill="#F7D618"/><rect x="280" y="388" width="48" height="8" fill="#D7141A"/></svg>\n`;
writeFileSync(join(root, 'public/icons/monogram.svg'), svg);
console.log('icône monogram.svg');
