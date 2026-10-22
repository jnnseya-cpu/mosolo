/**
 * Ancre EXTERNE de la tête du journal d'audit (C4-211) : la chaîne rechargée depuis la base est cohérente par
 * construction (sa tête est prise dans les données restaurées), donc une troncature ou la réinjection d'une ancienne
 * sauvegarde signée passeraient inaperçues. L'ancre — rang, empreinte, heure, signée HMAC par une clé dérivée de
 * MOSOLO_AUDIT_HMAC_KEY — est écrite HORS de la base (fichier MOSOLO_AUDIT_ANCHOR_PATH, idéalement sur un volume
 * distinct / répliqué WORM) après chaque écriture persistée du journal, et recopiée dans les traces du serveur.
 * Au démarrage et à la restauration, la chaîne doit PROLONGER l'ancre : même empreinte au rang ancré, longueur ≥.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, hmacSha256Hex, safeEqualHex, sha256Hex } from '../core/crypto.js';

export const ANCHOR_FORMAT = 'mosolo-ancre-audit/1';

export interface AuditHead {
  seq: number;
  hash: string;
}

export interface AuditAnchorRecord extends AuditHead {
  format: typeof ANCHOR_FORMAT;
  at: string;
  keyId: string;
  signature: string;
}

export class AnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorError';
  }
}

function anchorKey(auditHmacKey: string): string {
  return hmacSha256Hex(auditHmacKey, ANCHOR_FORMAT);
}

function payload(r: Pick<AuditAnchorRecord, 'seq' | 'hash' | 'at'>): string {
  return canonicalJson({ format: ANCHOR_FORMAT, seq: r.seq, hash: r.hash, at: r.at });
}

export function signAnchor(head: AuditHead, at: Date, auditHmacKey: string): AuditAnchorRecord {
  const base = { seq: head.seq, hash: head.hash, at: at.toISOString() };
  return {
    format: ANCHOR_FORMAT, ...base,
    keyId: sha256Hex(`mosolo-anchor-key:${anchorKey(auditHmacKey)}`).slice(0, 16),
    signature: hmacSha256Hex(anchorKey(auditHmacKey), payload(base)),
  };
}

/** Contrôle la signature d'une ancre lue ; lève AnchorError si elle est illisible, d'une autre clé ou altérée. */
export function checkAnchor(raw: unknown, auditHmacKey: string): AuditAnchorRecord {
  const r = raw as Partial<AuditAnchorRecord> | null;
  if (!r || r.format !== ANCHOR_FORMAT || !Number.isInteger(r.seq) || (r.seq as number) < 0 || typeof r.hash !== 'string' || typeof r.at !== 'string' || typeof r.signature !== 'string') {
    throw new AnchorError('Ancre d’audit illisible (format inconnu).');
  }
  if (!safeEqualHex(hmacSha256Hex(anchorKey(auditHmacKey), payload(r as AuditAnchorRecord)), r.signature)) {
    throw new AnchorError('Ancre d’audit à signature invalide (autre clé MOSOLO_AUDIT_HMAC_KEY ou fichier altéré).');
  }
  return r as AuditAnchorRecord;
}

/** Vue minimale d'une chaîne : longueur et empreinte à un rang. */
export interface ChainView {
  length: number;
  hashAt(seq: number): string | undefined;
}

export function chainOf(records: { seq: number; hash: string }[]): ChainView {
  const sorted = records.slice().sort((a, b) => a.seq - b.seq);
  return { length: sorted.length, hashAt: (seq) => sorted[seq - 1]?.hash };
}

export interface AnchorComparison {
  ok: boolean;
  /** Retour arrière / troncature : la chaîne est plus courte que l'ancre. */
  shorter: boolean;
  reason?: string;
}

/** La chaîne prolonge-t-elle l'ancre ? (longueur ≥ rang ancré ET même empreinte à ce rang.) */
export function compareWithAnchor(anchor: AuditHead, chain: ChainView): AnchorComparison {
  if (anchor.seq === 0) return { ok: true, shorter: false };
  if (chain.length < anchor.seq) {
    return { ok: false, shorter: true, reason: `chaîne de ${chain.length} enregistrement(s), plus courte que l’ancre (rang ${anchor.seq}) : troncature ou retour à une ancienne sauvegarde` };
  }
  const h = chain.hashAt(anchor.seq);
  if (!h || !safeEqualHex(h, anchor.hash)) {
    return { ok: false, shorter: false, reason: `empreinte différente de l’ancre au rang ${anchor.seq} : chaîne réécrite ou substituée` };
  }
  return { ok: true, shorter: false };
}

export interface AuditAnchorStore {
  readonly location: string;
  /** Dernière ancre (null : aucune encore écrite). Lève AnchorError si elle est illisible ou mal signée. */
  read(): AuditAnchorRecord | null;
  write(head: AuditHead, at: Date): AuditAnchorRecord;
}

/** Ancre en fichier : écriture atomique (fichier temporaire puis renommage), droits 0600. */
export class FileAuditAnchor implements AuditAnchorStore {
  constructor(readonly location: string, private readonly auditHmacKey: string) {}

  read(): AuditAnchorRecord | null {
    let text: string;
    try {
      text = readFileSync(this.location, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new AnchorError(`Ancre d’audit illisible (${this.location}) : ${(e as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AnchorError(`Ancre d’audit illisible (${this.location}) : JSON invalide.`);
    }
    return checkAnchor(raw, this.auditHmacKey);
  }

  write(head: AuditHead, at: Date): AuditAnchorRecord {
    const rec = signAnchor(head, at, this.auditHmacKey);
    mkdirSync(dirname(this.location), { recursive: true });
    const tmp = `${this.location}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, this.location);
    return rec;
  }
}

/** Ancre en mémoire (tests). */
export class MemoryAuditAnchor implements AuditAnchorStore {
  readonly location = 'memoire';
  current: unknown = null;
  constructor(private readonly auditHmacKey: string) {}
  read(): AuditAnchorRecord | null {
    return this.current === null ? null : checkAnchor(this.current, this.auditHmacKey);
  }
  write(head: AuditHead, at: Date): AuditAnchorRecord {
    const rec = signAnchor(head, at, this.auditHmacKey);
    this.current = structuredClone(rec);
    return rec;
  }
}

/** Ligne de trace de l'ancre (copie hors base dans les journaux du serveur). */
export function anchorLogLine(rec: AuditAnchorRecord): string {
  return `Ancre d'audit : rang ${rec.seq}, empreinte ${rec.hash}, ${rec.at}, signature ${rec.signature.slice(0, 16)}…`;
}
