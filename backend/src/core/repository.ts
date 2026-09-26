/**
 * Dépôts de données. Le socle fournit une implémentation en mémoire ;
 * la persistance PostgreSQL optionnelle (DATABASE_URL, voir backend/src/persistence) s'y branche par
 * `onWrite` / `restoreSnapshot` sans changer les interfaces publiques.
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

/**
 * Observation des écritures (ajout au socle, sans changement des interfaces publiques) :
 * utilisée par la couche de persistance (backend/src/persistence) pour journaliser chaque écriture.
 */
export type RepositoryWriteOp = 'insert' | 'update' | 'append';
export type RepositoryWriteListener<T> = (item: T, op: RepositoryWriteOp) => void;

class WriteListeners<T> {
  private readonly listeners: RepositoryWriteListener<T>[] = [];
  add(fn: RepositoryWriteListener<T>): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  emit(item: T, op: RepositoryWriteOp): void {
    for (const fn of this.listeners) fn(clone(item), op);
  }
}

export class InMemoryRepository<T extends Entity> implements Repository<T> {
  protected readonly items = new Map<string, T>();
  private readonly writeListeners = new WriteListeners<T>();

  /** Abonnement aux écritures (persistance). Retourne la fonction de désabonnement. */
  onWrite(fn: RepositoryWriteListener<T>): () => void {
    return this.writeListeners.add(fn);
  }

  /**
   * Remplace tout le contenu par un instantané restauré (chargement au démarrage, restauration).
   * Réservé à la couche de persistance ; aucune route HTTP n'y donne accès. Ne notifie pas les abonnés.
   */
  restoreSnapshot(items: T[]): void {
    this.items.clear();
    for (const it of items) this.items.set(it.id, clone(it));
  }

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
    this.writeListeners.emit(item, 'insert');
    return clone(item);
  }
  update(item: T): T {
    if (!this.items.has(item.id)) throw new Error(`Identifiant inconnu : ${item.id}`);
    this.items.set(item.id, clone(item));
    this.writeListeners.emit(item, 'update');
    return clone(item);
  }
}

export class InMemoryAppendOnlyRepository<T extends Entity> implements AppendOnlyRepository<T> {
  private readonly items: T[] = [];
  private readonly index = new Map<string, number>();
  private readonly writeListeners = new WriteListeners<T>();

  /** Abonnement aux ajouts (persistance). Retourne la fonction de désabonnement. */
  onWrite(fn: RepositoryWriteListener<T>): () => void {
    return this.writeListeners.add(fn);
  }

  /**
   * Recharge le journal depuis un instantané persistant (démarrage, restauration), dans l'ordre fourni.
   * Réservé à la couche de persistance ; aucune route HTTP n'y donne accès. Ne notifie pas les abonnés.
   */
  restoreSnapshot(items: T[]): void {
    this.items.length = 0;
    this.index.clear();
    for (const it of items) {
      if (this.index.has(it.id)) throw new Error(`Identifiant en double dans l'instantané : ${it.id}`);
      this.index.set(it.id, this.items.length);
      this.items.push(clone(it));
    }
  }

  append(item: T): T {
    if (this.index.has(item.id)) throw new Error(`Identifiant déjà utilisé : ${item.id}`);
    this.index.set(item.id, this.items.length);
    this.items.push(clone(item));
    this.writeListeners.emit(item, 'append');
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

  /** Après restauration d'un instantané : garantit que le prochain numéro du préfixe dépasse `n`. */
  advanceTo(prefix: string, n: number): void {
    if ((this.counters.get(prefix) ?? 0) < n) this.counters.set(prefix, n);
  }
}
