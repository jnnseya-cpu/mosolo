/**
 * Enregistrement automatique (§ 23.5.3) : chaque PUT crée une nouvelle version, l'historique complet est conservé,
 * avec un résumé des changements champ par champ. Un brouillon n'est pas un acte.
 */
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { sha256Hex, canonicalJson } from '../../core/crypto.js';
import { badRequest, notFound } from '../../core/errors.js';

export interface FieldChange {
  field: string;
  kind: 'ajoute' | 'modifie' | 'supprime';
  before?: unknown;
  after?: unknown;
}

export interface DraftVersion {
  key: string;
  version: number;
  savedAt: string;
  savedBy: string;
  data: Record<string, unknown>;
  changes: FieldChange[];
  changeSummary: string;
  contentHash: string;
}

export const DRAFT_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_DRAFT_BYTES = 256 * 1024;

/** Aplatit un objet en chemins pointés (« adresse.quartier »). Les tableaux sont comparés en bloc. */
export function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) flatten(v as Record<string, unknown>, path, out);
    else out[path] = v;
  }
  return out;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 37) + '…' : s;
}

export function diff(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const a = flatten(before);
  const b = flatten(after);
  const changes: FieldChange[] = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) changes.push({ field: k, kind: 'ajoute', after: b[k] });
    else if (canonicalJson(a[k]) !== canonicalJson(b[k])) changes.push({ field: k, kind: 'modifie', before: a[k], after: b[k] });
  }
  for (const k of Object.keys(a)) if (!(k in b)) changes.push({ field: k, kind: 'supprime', before: a[k] });
  return changes;
}

export function summarize(changes: FieldChange[], first: boolean): string {
  if (first) return changes.length === 0 ? 'Premier enregistrement (vide)' : `Premier enregistrement : ${changes.length} champ${changes.length > 1 ? 's' : ''} saisi${changes.length > 1 ? 's' : ''}`;
  if (changes.length === 0) return 'Aucune modification';
  const parts = changes.slice(0, 5).map((c) =>
    c.kind === 'modifie' ? `${c.field} (${show(c.before)} → ${show(c.after)})` : c.kind === 'ajoute' ? `${c.field} ajouté` : `${c.field} supprimé`,
  );
  const more = changes.length > 5 ? `, et ${changes.length - 5} autre${changes.length - 5 > 1 ? 's' : ''}` : '';
  return `${changes.length} champ${changes.length > 1 ? 's' : ''} modifié${changes.length > 1 ? 's' : ''} : ${parts.join(', ')}${more}`;
}

export class DraftService {
  /** Versions par (propriétaire, clé) — en ajout seul. */
  private readonly versions = new Map<string, DraftVersion[]>();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  private id(owner: string, key: string): string {
    return `${owner}::${key}`;
  }

  private assertKey(key: string): void {
    if (!DRAFT_KEY_PATTERN.test(key)) throw badRequest('INVALID_DRAFT_KEY', 'Clé de brouillon invalide (1 à 120 caractères : lettres, chiffres, . _ : -).');
  }

  save(user: User, key: string, data: Record<string, unknown>): DraftVersion {
    this.assertKey(key);
    const raw = canonicalJson(data);
    if (Buffer.byteLength(raw) > MAX_DRAFT_BYTES) throw badRequest('DRAFT_TOO_LARGE', 'Brouillon trop volumineux (256 Kio max).');
    const list = this.versions.get(this.id(user.id, key)) ?? [];
    const prev = list.at(-1);
    const changes = diff(prev?.data ?? {}, data);
    const version: DraftVersion = {
      key,
      version: list.length + 1,
      savedAt: this.clock.now().toISOString(),
      savedBy: user.id,
      data: structuredClone(data),
      changes,
      changeSummary: summarize(changes, !prev),
      contentHash: sha256Hex(raw),
    };
    list.push(version);
    this.versions.set(this.id(user.id, key), list);
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'draft.autosaved', resourceType: 'draft', resourceId: key,
      details: { version: version.version, changedFields: changes.map((c) => c.field), contentHash: version.contentHash },
    });
    return structuredClone(version);
  }

  latest(user: User, key: string): DraftVersion {
    this.assertKey(key);
    const v = this.versions.get(this.id(user.id, key))?.at(-1);
    if (!v) throw notFound('DRAFT_NOT_FOUND', `Aucun brouillon « ${key} ».`);
    return structuredClone(v);
  }

  history(user: User, key: string): DraftVersion[] {
    this.assertKey(key);
    const list = this.versions.get(this.id(user.id, key));
    if (!list) throw notFound('DRAFT_NOT_FOUND', `Aucun brouillon « ${key} ».`);
    return structuredClone(list);
  }
}
