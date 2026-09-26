/**
 * Dépôts de données. Le socle fournit une implémentation en mémoire ;
 * un adaptateur PostgreSQL (voir backend/db/schema.sql) implémentera les mêmes interfaces.
 */
export interface Entity {
  id: string;
}

export interface ReadRepository<T extends Entity> {
  get(id: string): T | undefined;
  find(predicate: (t: T) => boolean): T[];
  findOne(predicate: (t: T) => boolean): T | undefined;
  all(): T[];
  count(): number;
}

export interface Repository<T extends Entity> extends ReadRepository<T> {
  insert(item: T): T;
  update(item: T): T;
}

/** Dépôt en ajout seul : aucune méthode de mise à jour ni de suppression n'existe. */
export interface AppendOnlyRepository<T extends Entity> extends ReadRepository<T> {
  append(item: T): T;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class InMemoryRepository<T extends Entity> implements Repository<T> {
  protected readonly items = new Map<string, T>();

  get(id: string): T | undefined {
    const v = this.items.get(id);
    return v ? clone(v) : undefined;
  }
  find(predicate: (t: T) => boolean): T[] {
    return [...this.items.values()].filter(predicate).map(clone);
  }
  findOne(predicate: (t: T) => boolean): T | undefined {
    for (const v of this.items.values()) if (predicate(v)) return clone(v);
    return undefined;
  }
  all(): T[] {
    return [...this.items.values()].map(clone);
  }
  count(): number {
    return this.items.size;
  }
  insert(item: T): T {
    if (this.items.has(item.id)) throw new Error(`Identifiant déjà utilisé : ${item.id}`);
    this.items.set(item.id, clone(item));
    return clone(item);
  }
  update(item: T): T {
    if (!this.items.has(item.id)) throw new Error(`Identifiant inconnu : ${item.id}`);
    this.items.set(item.id, clone(item));
    return clone(item);
  }
}

export class InMemoryAppendOnlyRepository<T extends Entity> implements AppendOnlyRepository<T> {
  private readonly items: T[] = [];
  private readonly index = new Map<string, number>();

  append(item: T): T {
    if (this.index.has(item.id)) throw new Error(`Identifiant déjà utilisé : ${item.id}`);
    this.index.set(item.id, this.items.length);
    this.items.push(clone(item));
    return clone(item);
  }
  get(id: string): T | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : clone(this.items[i]!);
  }
  find(predicate: (t: T) => boolean): T[] {
    return this.items.filter(predicate).map(clone);
  }
  findOne(predicate: (t: T) => boolean): T | undefined {
    const v = this.items.find(predicate);
    return v ? clone(v) : undefined;
  }
  all(): T[] {
    return this.items.map(clone);
  }
  count(): number {
    return this.items.length;
  }
}

/** Générateur d'identifiants séquentiels lisibles, par préfixe. */
export class IdGenerator {
  private readonly counters = new Map<string, number>();
  next(prefix: string, pad = 6): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(pad, '0')}`;
  }
}
