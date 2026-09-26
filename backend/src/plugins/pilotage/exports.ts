/**
 * Export signé (C4-041, § H.14.2) : CSV (séparateur « ; », UTF-8 avec BOM) et JSON canonique, empreinte SHA-256
 * du contenu exact et signature HMAC-SHA256 de l'empreinte par une clé d'export dérivée de la clé serveur
 * (en production : HSM). Chaque export est journalisé dans l'audit (qui, quoi, quels filtres, quelle empreinte).
 */
import { canonicalJson, hmacSha256Hex, safeEqualHex, sha256Hex } from '../../core/crypto.js';

export const EXPORT_KEY_ID = 'mosolo-export-v1';

export type CsvCell = string | number | boolean | null | undefined;

export function toCsv(columns: string[], rows: CsvCell[][]): string {
  const esc = (v: CsvCell) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Neutralise les formules des tableurs (injection CSV).
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [columns, ...rows].map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

export interface ExportManifest {
  exportId: string;
  kind: string;
  format: 'csv' | 'json';
  generatedAt: string;
  generatedBy: { id: string; roles: string[] };
  filters: Record<string, unknown>;
  rows: number;
  sha256: string;
  signature: string;
  algorithm: 'HMAC-SHA256';
  keyId: string;
  note: string;
}

export class ExportSigner {
  private readonly key: string;
  constructor(serverKey: string) {
    // Clé dédiée, dérivée : une signature d'export ne peut pas être confondue avec une signature d'audit.
    this.key = hmacSha256Hex(serverKey, EXPORT_KEY_ID);
  }

  sign(payload: string): { sha256: string; signature: string } {
    const sha256 = sha256Hex(Buffer.from(payload, 'utf8'));
    return { sha256, signature: hmacSha256Hex(this.key, sha256) };
  }

  verify(payload: string, sha256: string, signature: string): { integrity: boolean; authentic: boolean } {
    const actual = sha256Hex(Buffer.from(payload, 'utf8'));
    return {
      integrity: safeEqualHex(actual, sha256.toLowerCase()),
      authentic: safeEqualHex(hmacSha256Hex(this.key, actual), signature.toLowerCase()),
    };
  }
}

export function jsonPayload(data: unknown): string {
  return canonicalJson(data);
}
