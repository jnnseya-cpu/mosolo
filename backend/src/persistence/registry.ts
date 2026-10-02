/**
 * Découverte des dépôts de l'application (socle + modules d'extension) par parcours en largeur du contexte :
 * le nom persistant d'un dépôt est son chemin le plus court depuis le contexte (ex. `payments.orders`,
 * `ext.parking.sessions`). Le parcours est déterministe (ordre des propriétés), donc stable d'un démarrage à l'autre
 * tant que la composition du contexte ne change pas.
 */
import type { AuditRecord } from '../core/audit.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository, type Entity } from '../core/repository.js';
import { encodeDoc } from './codec.js';
import type { SnapshotRow } from './store.js';

export type AnyRepo = InMemoryRepository<Entity> | InMemoryAppendOnlyRepository<Entity>;

export interface Discovery {
  repos: Map<string, AnyRepo>;
  idGenerators: IdGenerator[];
}

/** Journal d'audit chaîné : persisté comme journal en ajout seul sous ce nom. */
export const AUDIT_REPO = 'core.audit';

/** Racines non parcourues : horloge, secrets (jamais persistés), annuaire (données de configuration). */
const SKIP_ROOTS = new Set(['clock', 'secrets', 'users', 'connectors']);
const MAX_DEPTH = 4;

export function discover(ctx: object): Discovery {
  const repos = new Map<string, AnyRepo>();
  const idGenerators: IdGenerator[] = [];
  const seen = new WeakSet<object>();
  seen.add(ctx);
  let frontier: [string, unknown][] = Object.entries(ctx).filter(([k]) => !SKIP_ROOTS.has(k));
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: [string, unknown][] = [];
    for (const [path, value] of frontier) {
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (value instanceof InMemoryRepository || value instanceof InMemoryAppendOnlyRepository) {
        repos.set(path, value as AnyRepo);
        continue;
      }
      if (value instanceof IdGenerator) {
        idGenerators.push(value);
        continue;
      }
      if (value instanceof Map || value instanceof Set || Array.isArray(value) || ArrayBuffer.isView(value)) continue;
      for (const [k, v] of Object.entries(value)) {
        if (v && typeof v === 'object') next.push([`${path}.${k}`, v]);
      }
    }
    frontier = next;
  }
  return { repos, idGenerators };
}

export function isAppendOnly(repo: AnyRepo): repo is InMemoryAppendOnlyRepository<Entity> {
  return repo instanceof InMemoryAppendOnlyRepository;
}

/** Lignes d'instantané de l'état vivant (dépôts + journal d'audit), encodées. */
export function collectRows(ctx: { audit: { unsafeRawStorageForTamperTests(): AuditRecord[] } }, discovery: Discovery = discover(ctx)): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const [repo, r] of discovery.repos) {
    const kind = isAppendOnly(r) ? 'append' : 'mutable';
    r.all().forEach((item, i) => rows.push({ repo, id: item.id, kind, seq: i + 1, doc: encodeDoc(item) }));
  }
  ctx.audit.unsafeRawStorageForTamperTests().forEach((rec) => rows.push({ repo: AUDIT_REPO, id: rec.id, kind: 'append', seq: rec.seq, doc: encodeDoc(structuredClone(rec)) }));
  return rows;
}

/** Identifiants lisibles `PREFIXE-000123` rencontrés dans un document (champs de premier niveau). */
export function readableIds(doc: Record<string, unknown>): [string, number][] {
  const out: [string, number][] = [];
  for (const v of Object.values(doc)) {
    if (typeof v !== 'string' || v.length > 80) continue;
    const m = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)-(\d{3,})$/.exec(v);
    if (m) out.push([m[1]!, Number.parseInt(m[2]!, 10)]);
  }
  return out;
}
