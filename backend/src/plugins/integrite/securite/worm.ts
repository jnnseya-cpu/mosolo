/**
 * Copie du journal d'audit en écriture unique (WORM, § 25.1 « copie en stockage WORM »).
 *
 * La copie est faite par SEGMENTS : chaque passage écrit un NOUVEAU segment (enregistrements de rang supérieur au dernier
 * copié) ; un segment écrit n'est jamais réécrit ni complété. Sur fichier (MOSOLO_AUDIT_WORM_DIR, idéalement un volume
 * distinct à rétention verrouillée — Object Lock, bande, disque WORM) : création exclusive (`wx`) puis droits en
 * lecture seule (0444). En mémoire (défaut, démonstration et tests) : segments figés.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditRecord } from '../../../core/audit.js';

export interface WormSegmentInfo {
  name: string;
  fromSeq: number;
  toSeq: number;
  count: number;
}

export interface WormStore {
  readonly kind: 'FICHIER' | 'MEMOIRE';
  readonly location: string;
  /** Écrit un nouveau segment (jamais une réécriture). */
  appendSegment(records: AuditRecord[]): WormSegmentInfo;
  /** Relit toute la copie, dans l'ordre des rangs. */
  readAll(): AuditRecord[];
  segments(): WormSegmentInfo[];
  /** Rang du dernier enregistrement copié (0 : copie vide). */
  lastSeq(): number;
}

const segName = (from: number, to: number) => `audit-${String(from).padStart(10, '0')}-${String(to).padStart(10, '0')}.jsonl`;
const parseName = (name: string): WormSegmentInfo | null => {
  const m = /^audit-(\d{10})-(\d{10})\.jsonl$/.exec(name);
  if (!m) return null;
  const fromSeq = Number(m[1]);
  const toSeq = Number(m[2]);
  return { name, fromSeq, toSeq, count: toSeq - fromSeq + 1 };
};

export class MemoryWormStore implements WormStore {
  readonly kind = 'MEMOIRE' as const;
  readonly location = 'memoire';
  private readonly segs: { info: WormSegmentInfo; lines: readonly string[] }[] = [];

  appendSegment(records: AuditRecord[]): WormSegmentInfo {
    if (!records.length) throw new Error('Segment vide');
    const info = { name: segName(records[0]!.seq, records.at(-1)!.seq), fromSeq: records[0]!.seq, toSeq: records.at(-1)!.seq, count: records.length };
    this.segs.push({ info, lines: Object.freeze(records.map((r) => JSON.stringify(r))) });
    return info;
  }
  readAll(): AuditRecord[] {
    return this.segs.flatMap((s) => s.lines.map((l) => JSON.parse(l) as AuditRecord));
  }
  segments(): WormSegmentInfo[] {
    return this.segs.map((s) => ({ ...s.info }));
  }
  lastSeq(): number {
    return this.segs.at(-1)?.info.toSeq ?? 0;
  }
  /** Tests uniquement : simule une altération de la copie par un initié technique. */
  unsafeTamperForTests(seq: number, patch: Partial<AuditRecord>): void {
    for (const s of this.segs) {
      const i = s.lines.findIndex((l) => (JSON.parse(l) as AuditRecord).seq === seq);
      if (i >= 0) {
        const lines = [...s.lines];
        lines[i] = JSON.stringify({ ...(JSON.parse(lines[i]!) as AuditRecord), ...patch });
        s.lines = Object.freeze(lines);
      }
    }
  }
}

export class FileWormStore implements WormStore {
  readonly kind = 'FICHIER' as const;
  constructor(readonly location: string) {
    mkdirSync(location, { recursive: true });
  }
  appendSegment(records: AuditRecord[]): WormSegmentInfo {
    if (!records.length) throw new Error('Segment vide');
    const info = { name: segName(records[0]!.seq, records.at(-1)!.seq), fromSeq: records[0]!.seq, toSeq: records.at(-1)!.seq, count: records.length };
    const file = join(this.location, info.name);
    // Création exclusive : un segment existant n'est jamais écrasé.
    writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, { flag: 'wx', mode: 0o444 });
    try { chmodSync(file, 0o444); } catch { /* système sans droits POSIX */ }
    return info;
  }
  segments(): WormSegmentInfo[] {
    return readdirSync(this.location).map(parseName).filter((x): x is WormSegmentInfo => x !== null).sort((a, b) => a.fromSeq - b.fromSeq);
  }
  readAll(): AuditRecord[] {
    return this.segments().flatMap((s) => readFileSync(join(this.location, s.name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord));
  }
  lastSeq(): number {
    return this.segments().at(-1)?.toSeq ?? 0;
  }
}

export function wormFromEnv(env: NodeJS.ProcessEnv = process.env): WormStore {
  const dir = env.MOSOLO_AUDIT_WORM_DIR?.trim();
  return dir ? new FileWormStore(dir) : new MemoryWormStore();
}
