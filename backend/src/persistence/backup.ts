/**
 * Sauvegarde / restauration : export JSON complet signé (HMAC-SHA256) avec manifeste par dépôt (nombre, SHA-256),
 * vérification avant toute restauration, et contrôle de la chaîne d'audit restaurée (C4-211, C4-316).
 * La clé de signature des sauvegardes (MOSOLO_BACKUP_KEY) est distincte de la clé du journal d'audit.
 */
import { AuditLog, type AuditRecord, type AuditVerification } from '../core/audit.js';
import { systemClock } from '../core/clock.js';
import { canonicalJson, hmacSha256Hex, safeEqualHex, sha256Hex } from '../core/crypto.js';
import { decodeDoc } from './codec.js';
import { AUDIT_REPO } from './registry.js';
import { restoreAuditLog } from './runtime.js';
import { sortRows, type RowKind, type SnapshotRow, type SnapshotStore } from './store.js';

export const BACKUP_FORMAT = 'mosolo-sauvegarde/1';

export interface BackupManifest {
  rows: number;
  repos: Record<string, { kind: RowKind; count: number; sha256: string }>;
}

export interface BackupDocument {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  source: string;
  manifest: BackupManifest;
  rows: SnapshotRow[];
  contentSha256: string;
  signature: { alg: 'HMAC-SHA256'; keyId: string; value: string };
}

export interface BackupVerification {
  ok: boolean;
  reasons: string[];
  rows: number;
  repos: number;
  audit: AuditVerification | null;
}

export function keyId(key: string): string {
  return sha256Hex(`mosolo-backup-key:${key}`).slice(0, 16);
}

function manifestOf(rows: SnapshotRow[]): BackupManifest {
  const repos: BackupManifest['repos'] = {};
  const groups = new Map<string, SnapshotRow[]>();
  for (const r of rows) groups.set(r.repo, [...(groups.get(r.repo) ?? []), r]);
  for (const [name, list] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    repos[name] = { kind: list[0]!.kind, count: list.length, sha256: sha256Hex(canonicalJson(list)) };
  }
  return { rows: rows.length, repos };
}

export function createBackup(rows: SnapshotRow[], key: string, opts: { source: string; now?: Date }): BackupDocument {
  if (!key || key.length < 16) throw new Error('Clé de sauvegarde absente ou trop courte (MOSOLO_BACKUP_KEY, 16 caractères minimum).');
  const sorted = sortRows(structuredClone(rows));
  const manifest = manifestOf(sorted);
  const contentSha256 = sha256Hex(canonicalJson({ manifest, rows: sorted }));
  return {
    format: BACKUP_FORMAT,
    createdAt: (opts.now ?? new Date()).toISOString(),
    source: opts.source,
    manifest,
    rows: sorted,
    contentSha256,
    signature: { alg: 'HMAC-SHA256', keyId: keyId(key), value: hmacSha256Hex(key, contentSha256) },
  };
}

/** Vérifie format, signature, empreinte globale, manifeste par dépôt et — si la clé d'audit est fournie — la chaîne d'audit. */
export function verifyBackup(doc: BackupDocument, key: string, auditHmacKey?: string): BackupVerification {
  const reasons: string[] = [];
  if (doc?.format !== BACKUP_FORMAT) reasons.push(`Format inconnu : ${String(doc?.format)}`);
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const sorted = sortRows(structuredClone(rows));
  const manifest = manifestOf(sorted);
  const content = sha256Hex(canonicalJson({ manifest, rows: sorted }));
  if (content !== doc?.contentSha256) reasons.push('Empreinte du contenu différente : sauvegarde altérée ou incomplète.');
  if (canonicalJson(manifest) !== canonicalJson(doc?.manifest)) reasons.push('Manifeste incohérent avec le contenu.');
  if (doc?.signature?.keyId !== keyId(key)) reasons.push('Sauvegarde signée avec une autre clé.');
  if (!doc?.signature?.value || !safeEqualHex(hmacSha256Hex(key, String(doc?.contentSha256 ?? '')), doc.signature.value)) reasons.push('Signature invalide.');
  let audit: AuditVerification | null = null;
  if (auditHmacKey) {
    audit = verifyAuditRows(sorted.filter((r) => r.repo === AUDIT_REPO), auditHmacKey);
    if (!audit.ok) reasons.push(`Chaîne d'audit non vérifiée : ${audit.reason ?? 'inconnu'}.`);
  }
  return { ok: reasons.length === 0, reasons, rows: rows.length, repos: Object.keys(manifest.repos).length, audit };
}

export function verifyAuditRows(rows: SnapshotRow[], auditHmacKey: string): AuditVerification {
  const log = new AuditLog(systemClock, auditHmacKey);
  const records = rows.slice().sort((a, b) => a.seq - b.seq).map((r) => decodeDoc(r.doc) as AuditRecord);
  restoreAuditLog(log, records);
  return log.verify();
}

export async function backupStore(store: SnapshotStore, key: string, now = new Date()): Promise<BackupDocument> {
  return createBackup(await store.loadAll(), key, { source: store.kind, now });
}

/** Restauration : refusée si la vérification échoue. Remplace tout le contenu du magasin dans une transaction. */
export async function restoreStore(store: SnapshotStore, doc: BackupDocument, key: string, auditHmacKey?: string, now = new Date()): Promise<BackupVerification> {
  // Une restauration sans contrôle de la chaîne d'audit accepterait en silence un journal altéré : clé exigée.
  if (!auditHmacKey) throw new Error('Restauration refusée : MOSOLO_AUDIT_HMAC_KEY obligatoire pour vérifier la chaîne d’audit avant restauration.');
  const v = verifyBackup(doc, key, auditHmacKey);
  if (!v.ok) throw new Error(`Restauration refusée : ${v.reasons.join(' ')}`);
  await store.migrate();
  await store.replaceAll(doc.rows, now);
  return v;
}
