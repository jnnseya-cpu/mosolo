/**
 * Documents PDF de la plateforme (§ 18A.4, § 19 ; § 27A.4) : générateur PDF 1.4 minimal, sans dépendance (texte
 * Helvetica en codage WinAnsi, QR code vectoriel), et cachet électronique avancé détaché (Ed25519, clé des quittances,
 * séparation de domaine), ajouté après la fin de fichier en commentaire PDF : les lecteurs l'ignorent, la vérification
 * le relit et contrôle les octets qui le précèdent (toute modification du document est détectée).
 *
 * Signature PAdES qualifiée (certificat d'un prestataire de services de confiance) : à raccorder — acte requis.
 */
import QRCode from 'qrcode';
import { BRAND_TEXT, LOGO_NSEYA, LOGO_VILLE } from '../../core/brand-assets.js';
import type { ReceiptService } from './service.js';

export interface PdfBlock {
  text: string;
  size?: number;
  bold?: boolean;
  /** Espace vertical ajouté avant le bloc (points). */
  gap?: number;
}
export interface PdfDocumentInput {
  title: string;
  subject: string;
  blocks: PdfBlock[];
  /** Contenu du QR code dessiné en haut à droite de la première page. */
  qr?: string;
  /**
   * En-tête et pied de page de marque (30/09/2026 : « tout document généré est à l'image de la plateforme ») : logo de
   * la Ville de Kinshasa, « Ville-Province de Kinshasa · KINSHASA MOSOLO », filet tricolore ; pied « réalisée par
   * Groupe Nseya » avec son logo. Actif par défaut.
   */
  brand?: boolean;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;
const SIG_MARK = '%MOSOLO-CACHET ';
/** Hauteur réservée à l'en-tête de marque (points) et hauteur du logo. */
const HEADER_H = 70;
const LOGO_H = 44;

/** Caractères hors Latin-1 courants en français → octets WinAnsi. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  'œ': 0x9c, 'Œ': 0x8c, 'Ÿ': 0x9f,
};
const REPLACE: Record<string, string> = { ' ': ' ', ' ': ' ', '≠': '!=', '≥': '>=', '≤': '<=', '→': '->', '×': 'x', '↔': '<->' };

/** Chaîne PDF littérale échappée, en octets WinAnsi (hors table : « ? »). */
function pdfString(text: string): string {
  let out = '';
  for (const raw of text) {
    const ch = REPLACE[raw] ?? raw;
    for (const c of ch) {
      const code = WIN_ANSI[c] ?? c.charCodeAt(0);
      if (code > 0xff || (code < 0x20 && code !== 0x09)) out += '?';
      else if (c === '(' || c === ')' || c === '\\') out += `\\${c}`;
      else out += String.fromCharCode(code);
    }
  }
  return `(${out})`;
}

/** Découpe un texte en lignes selon une largeur approximative (Helvetica : ~0,52 em par caractère). */
function wrap(text: string, size: number, width: number): string[] {
  const max = Math.max(10, Math.floor(width / (size * 0.52)));
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(' ')) {
      if (!cur) cur = word;
      else if ((cur + ' ' + word).length <= max) cur += ' ' + word;
      else { lines.push(cur); cur = word; }
      while (cur.length > max) { lines.push(cur.slice(0, max)); cur = cur.slice(max); }
    }
    lines.push(cur);
  }
  return lines;
}

function qrOps(content: string, x: number, yTop: number, size: number): string {
  const qr = QRCode.create(content, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / (n + 8);
  const ops: string[] = ['q 0 0 0 rg'];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) ops.push(`${(x + (c + 4) * cell).toFixed(2)} ${(yTop - (r + 5) * cell).toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re f`);
    }
  }
  ops.push('Q');
  return ops.join('\n');
}

/** Construit un PDF 1.4 (octets) : pagination automatique, polices standard (aucune incorporation). */
export function buildPdf(doc: PdfDocumentInput): Buffer {
  const brand = doc.brand !== false;
  const top = PAGE_H - MARGIN + 20 - (brand ? HEADER_H : 20);
  const bottom = brand ? MARGIN + 12 : MARGIN;
  const pages: string[][] = [[]];
  let y = top;
  const textWidth = PAGE_W - 2 * MARGIN - (doc.qr ? 130 : 0);
  let first = true;
  if (doc.qr) pages[0]!.push(qrOps(doc.qr, PAGE_W - MARGIN - 120, top + 10, 130));
  for (const b of doc.blocks) {
    const size = b.size ?? 10;
    y -= b.gap ?? 0;
    for (const line of wrap(b.text, size, first && y > top - 140 ? textWidth : PAGE_W - 2 * MARGIN)) {
      if (y - size * 1.4 < bottom) { pages.push([]); y = top; first = false; }
      y -= size * 1.4;
      pages[pages.length - 1]!.push(`BT /${b.bold ? 'F2' : 'F1'} ${size} Tf ${MARGIN} ${y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
    }
  }
  // En-tête et pied de page de marque, puis numéro de page.
  const logoW = (LOGO_VILLE.width * LOGO_H) / LOGO_VILLE.height;
  const third = (PAGE_W - 2 * MARGIN) / 3;
  pages.forEach((ops, i) => {
    if (brand) {
      const yLogo = PAGE_H - 22 - LOGO_H;
      ops.unshift(
        `q ${logoW.toFixed(2)} 0 0 ${LOGO_H} ${MARGIN} ${yLogo} cm /LogoVille Do Q`,
        `BT /F2 11 Tf ${(MARGIN + logoW + 12).toFixed(2)} ${yLogo + 26} Td ${pdfString(BRAND_TEXT.institution)} Tj ET`,
        `BT /F1 9 Tf ${(MARGIN + logoW + 12).toFixed(2)} ${yLogo + 12} Td ${pdfString(BRAND_TEXT.plateforme)} Tj ET`,
        // Filet tricolore (bleu, jaune, rouge).
        `q 0.118 0.608 0.843 rg ${MARGIN} ${yLogo - 8} ${third.toFixed(2)} 3 re f 0.969 0.839 0.094 rg ${(MARGIN + third).toFixed(2)} ${yLogo - 8} ${third.toFixed(2)} 3 re f 0.843 0.078 0.102 rg ${(MARGIN + 2 * third).toFixed(2)} ${yLogo - 8} ${third.toFixed(2)} 3 re f Q`,
      );
      const nH = 14;
      const nW = (LOGO_NSEYA.width * nH) / LOGO_NSEYA.height;
      ops.push(
        `q ${nW.toFixed(2)} 0 0 ${nH} ${MARGIN} 16 cm /LogoNseya Do Q`,
        `BT /F1 7 Tf ${(MARGIN + nW + 6).toFixed(2)} 20 Td ${pdfString(BRAND_TEXT.realisation)} Tj ET`,
      );
    }
    ops.push(`BT /F1 8 Tf ${MARGIN} ${brand ? 38 : 30} Td ${pdfString(`${doc.title} — page ${i + 1}/${pages.length}`)} Tj ET`);
  });

  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const image = (img: { width: number; height: number; jpegBase64: string }) => {
    const bytes = Buffer.from(img.jpegBase64, 'base64');
    return add(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`);
  };
  const xobjects = brand ? ` /XObject << /LogoVille ${image(LOGO_VILLE)} 0 R /LogoNseya ${image(LOGO_NSEYA)} 0 R >>` : '';
  const pageIds: number[] = [];
  for (const ops of pages) {
    const content = Buffer.from(ops.join('\n'), 'latin1');
    const cid = add(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xobjects} >> /Contents ${cid} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Title ${pdfString(doc.title)} /Subject ${pdfString(doc.subject)} /Producer (KINSHASA MOSOLO) >>`);

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface SealedPdf { bytes: Buffer; sha256: string; signature: string; keyId: string; algorithm: 'Ed25519' }

/** Appose le cachet (signature Ed25519 des octets du PDF) en commentaire final. */
export function sealPdf(pdf: Buffer, receipts: ReceiptService): SealedPdf {
  const s = receipts.signDocument(pdf);
  const trailer = Buffer.from(`${SIG_MARK}Ed25519 keyId=${s.keyId} sha256=${s.sha256} sig=${s.signature}\n`, 'latin1');
  return { bytes: Buffer.concat([pdf, trailer]), sha256: s.sha256, signature: s.signature, keyId: s.keyId, algorithm: 'Ed25519' };
}

/** Vérifie le cachet d'un PDF produit par la plateforme : octets signés intacts et clé connue du trousseau. */
export function verifySealedPdf(bytes: Buffer, receipts: ReceiptService): { valid: boolean; keyId?: string; sha256?: string; reason?: string } {
  const text = bytes.toString('latin1');
  const at = text.lastIndexOf(SIG_MARK);
  if (at < 0) return { valid: false, reason: 'Aucun cachet MOSOLO dans ce fichier.' };
  const m = /^%MOSOLO-CACHET Ed25519 keyId=(\S+) sha256=([0-9a-f]{64}) sig=(\S+)\n?$/.exec(text.slice(at));
  if (!m) return { valid: false, reason: 'Cachet illisible.' };
  const signed = bytes.subarray(0, at);
  const valid = receipts.verifyDocument(signed, m[3]!, m[1]!);
  return valid ? { valid, keyId: m[1]!, sha256: m[2]! } : { valid, keyId: m[1]!, reason: 'Document modifié ou cachet non émis par une clé du trousseau.' };
}
