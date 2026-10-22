/**
 * Contrôle des fichiers déposés dans la gestion documentaire (module 38) — deuxième passe adverse (27/09/2026).
 *
 * Avant ce contrôle, tout type déclaré était accepté (HTML, SVG avec script, exécutable renommé en PDF…), le nom de
 * fichier était conservé tel quel (chemins « ../ », caractères de contrôle, inversion bidirectionnelle) et un
 * base64 invalide était décodé partiellement sans erreur. Désormais :
 *  - liste FERMÉE de types admis, chacun vérifié par sa signature d'en-tête (le type déclaré ne suffit jamais) ;
 *  - refus des exécutables, scripts, HTML et SVG quel que soit le type déclaré ;
 *  - nom de fichier assaini (dernier segment, caractères de contrôle et de direction retirés, longueur bornée),
 *    double extension exécutable refusée, extension cohérente avec le type ;
 *  - base64 strict.
 * Aucune image n'est décodée côté serveur : une image corrompue mais de signature correcte reste acceptée (elle
 * n'est jamais interprétée par le serveur, servie avec son type et `nosniff`).
 */
import { badRequest, ApiError } from '../../core/errors.js';

interface AllowedType { label: string; extensions: string[]; magic: (b: Buffer) => boolean }

const starts = (b: Buffer, bytes: number[]) => bytes.every((x, i) => b[i] === x);
const ZIP = (b: Buffer) => starts(b, [0x50, 0x4b, 0x03, 0x04]);
const OLE = (b: Buffer) => starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Types admis (liste fermée) — à compléter par décision de l'exploitant, jamais par simple déclaration du client. */
export const ALLOWED_DOCUMENT_TYPES: Record<string, AllowedType> = {
  'application/pdf': { label: 'PDF', extensions: ['pdf'], magic: (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  'image/jpeg': { label: 'Image JPEG', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'], magic: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  'image/png': { label: 'Image PNG', extensions: ['png'], magic: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/webp': { label: 'Image WebP', extensions: ['webp'], magic: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  'text/plain': { label: 'Texte', extensions: ['txt', 'text', 'log'], magic: () => true },
  'text/csv': { label: 'CSV', extensions: ['csv'], magic: () => true },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { label: 'Word (DOCX)', extensions: ['docx'], magic: ZIP },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { label: 'Excel (XLSX)', extensions: ['xlsx'], magic: ZIP },
  'application/vnd.oasis.opendocument.text': { label: 'Texte OpenDocument', extensions: ['odt'], magic: ZIP },
  'application/vnd.oasis.opendocument.spreadsheet': { label: 'Classeur OpenDocument', extensions: ['ods'], magic: ZIP },
  'application/msword': { label: 'Word 97-2003', extensions: ['doc'], magic: OLE },
  'application/vnd.ms-excel': { label: 'Excel 97-2003', extensions: ['xls'], magic: OLE },
};

/** Extensions exécutables ou actives : refusées où qu'elles figurent dans le nom (double extension). */
const DANGEROUS_EXT = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'scr', 'pif', 'msi', 'msp', 'cpl', 'jar', 'js', 'mjs', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'sh', 'bash', 'zsh', 'py', 'pl', 'rb', 'php', 'phtml', 'asp', 'aspx', 'jsp', 'cgi', 'html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'hta',
  'lnk', 'reg', 'apk', 'app', 'dmg', 'deb', 'rpm', 'elf', 'bin', 'so', 'dylib', 'swf', 'xml', 'xsl', 'xslt',
]);

/** Contenu actif ou exécutable reconnu par son en-tête, quel que soit le type déclaré. */
function activeContent(b: Buffer): string | null {
  if (starts(b, [0x4d, 0x5a])) return 'exécutable Windows (MZ)';
  if (starts(b, [0x7f, 0x45, 0x4c, 0x46])) return 'exécutable ELF';
  if (starts(b, [0xcf, 0xfa, 0xed, 0xfe]) || starts(b, [0xfe, 0xed, 0xfa, 0xce]) || starts(b, [0xca, 0xfe, 0xba, 0xbe])) return 'exécutable Mach-O / Java';
  if (starts(b, [0x23, 0x21])) return 'script (#!)';
  const head = stripBom(b.subarray(0, 1024).toString('utf8')).trimStart().toLowerCase();
  if (/^<(!doctype\s+html|html|svg|\?xml|script|iframe|object|embed)\b/.test(head)) return 'HTML, SVG ou XML actif';
  if (/<script\b|javascript:|onload\s*=|onerror\s*=/.test(head)) return 'script embarqué';
  return null;
}

const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** Caractères de contrôle (C0, C1), séparateurs invisibles et marques ou inversions bidirectionnelles. */
function isInvisibleOrControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff;
}

/** Nom de fichier assaini : dernier segment, sans caractère de contrôle ni de direction, 120 caractères au plus. */
export function sanitizeFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  // Caractères de contrôle (C0, C1), inversions bidirectionnelles et séparateurs invisibles retirés.
  const clean = [...last.normalize('NFC')].filter((c) => !isInvisibleOrControl(c.codePointAt(0)!)).join('').replace(/[<>:"|?*]/g, '_').trim().replace(/^\.+/, '');
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, 120 - ext.length) + ext;
}

/** Base64 strict (alphabet standard, remplissage correct) ; les retours à la ligne sont tolérés. */
export function decodeStrictBase64(s: string): Buffer {
  const compact = s.replace(/[\r\n]/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw badRequest('BASE64_INVALIDE', 'Contenu base64 invalide : fichier illisible, rien n’a été enregistré.');
  return Buffer.from(compact, 'base64');
}

export interface CheckedFile { fileName: string; contentType: string; buf: Buffer }

/** Contrôle complet d'un dépôt : renvoie le nom assaini, le type normalisé et le contenu ; refus 400/415 sinon. */
export function checkUpload(input: { fileName: string; contentType: string; contentBase64: string }): CheckedFile {
  const buf = decodeStrictBase64(input.contentBase64);
  if (!buf.length) throw badRequest('EMPTY_DOCUMENT', 'Document vide.');
  const contentType = input.contentType.trim().toLowerCase();
  const fileName = sanitizeFileName(input.fileName);
  if (!fileName || fileName === '.' || fileName === '..') throw badRequest('NOM_FICHIER_INVALIDE', 'Nom de fichier invalide.');
  const parts = fileName.toLowerCase().split('.');
  const exts = parts.length > 1 ? parts.slice(1) : [];
  const bad = exts.find((e) => DANGEROUS_EXT.has(e));
  if (bad) throw badRequest('FICHIER_EXTENSION_INTERDITE', `Extension « .${bad} » interdite (exécutable ou contenu actif) : dépôt refusé.`);
  const allowed = ALLOWED_DOCUMENT_TYPES[contentType];
  if (!allowed) {
    throw new ApiError(415, 'TYPE_FICHIER_NON_ADMIS', `Type de fichier « ${contentType} » non admis. Types acceptés : ${Object.values(ALLOWED_DOCUMENT_TYPES).map((t) => t.label).join(', ')}.`);
  }
  const ext = exts.at(-1);
  if (ext && !allowed.extensions.includes(ext)) {
    throw badRequest('FICHIER_EXTENSION_INCOHERENTE', `L’extension « .${ext} » ne correspond pas au type déclaré (${allowed.label}) : dépôt refusé.`);
  }
  const active = activeContent(buf);
  if (active) throw badRequest('FICHIER_CONTENU_ACTIF', `Contenu refusé (${active}) : seuls des documents inertes sont conservés.`);
  if (!allowed.magic(buf)) throw badRequest('FICHIER_SIGNATURE_INCOHERENTE', `Le contenu ne correspond pas au type déclaré (${allowed.label}) : fichier renommé ou corrompu, dépôt refusé.`);
  if (contentType.startsWith('text/') && buf.includes(0)) throw badRequest('FICHIER_SIGNATURE_INCOHERENTE', 'Fichier texte contenant des octets binaires : dépôt refusé.');
  return { fileName, contentType, buf };
}
