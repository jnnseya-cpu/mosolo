/**
 * Hiérarchie SIG fiscale (commune › quartier › avenue › parcelle › bâtiment › unité) et identifiant
 * géographique fiscal (IGF, § 17.3 du document maître) :
 *   - identifiant interne ALÉATOIRE, non signifiant et permanent (UUID) ;
 *   - code territorial LISIBLE `KIN-GOM-Q012-P004517-B01-U03` (commune, quartier, parcelle, bâtiment, unité).
 * Le code lisible peut être réédité (redécoupage) sous une nouvelle version ; l'UUID ne change jamais.
 * Le cadastre fiscal ne confère aucun droit de propriété (§ 17.1).
 */
import { randomUUID } from 'node:crypto';
import { notFound, unprocessable } from '../../core/errors.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import type { FiscalObject, ObjectCategory } from '../../modules/objects/service.js';

/**
 * Codes à trois lettres des 24 communes. [Codes de DÉMONSTRATION — le référentiel officiel des codes
 * territoriaux reste à arrêter avec les services du cadastre ; seul l'exemple « GOM » figure au document maître.]
 */
export const COMMUNE_CODES: Record<(typeof COMMUNES)[number], string> = {
  Bandalungwa: 'BAN', Barumbu: 'BAR', Bumbu: 'BUM', Gombe: 'GOM', Kalamu: 'KAL', 'Kasa-Vubu': 'KAS',
  Kimbanseke: 'KIM', Kinshasa: 'KSA', Kintambo: 'KTB', Kisenso: 'KIS', Lemba: 'LEM', Limete: 'LIM',
  Lingwala: 'LIN', Makala: 'MAK', Maluku: 'MAL', Masina: 'MAS', Matete: 'MAT', 'Mont-Ngafula': 'MNG',
  Ndjili: 'NDJ', Ngaba: 'NGB', Ngaliema: 'NGL', 'Ngiri-Ngiri': 'NGN', Nsele: 'NSE', Selembao: 'SEL',
};

/** Préfixe de segment par catégorie d'objet. */
export const CATEGORY_SEGMENT: Record<ObjectCategory, string> = {
  PARCELLE: 'P', BATIMENT: 'B', UNITE_LOCATIVE: 'U', ACTIVITE: 'E', VEHICULE: 'V', PANNEAU: 'S', AUTRE: 'X',
};

export type GeoLevel = 'COMMUNE' | 'QUARTIER' | 'AVENUE';

export interface GeoUnit {
  id: string;
  level: GeoLevel;
  name: string;
  /** Code court dans son niveau (GOM, Q012, A003). */
  code: string;
  parentId?: string;
  /** Commune de rattachement (pour les filtres territoriaux). */
  commune: string;
  createdAt: string;
}

const norm = (s: string) => s.trim().toLocaleLowerCase('fr').normalize('NFD').replace(/[̀-ͯ]/g, '');

export class GeoRegistry {
  readonly units = new InMemoryRepository<GeoUnit>();
  private readonly ids = new IdGenerator();
  /** Compteurs de numéros de parcelle (ou d'objet racine) par quartier. */
  private readonly rootCounters = new Map<string, number>();

  constructor(private readonly now: () => string) {
    for (const c of COMMUNES) {
      this.units.insert({ id: `GEO-${COMMUNE_CODES[c]}`, level: 'COMMUNE', name: c, code: COMMUNE_CODES[c], commune: c, createdAt: now() });
    }
  }

  commune(name: string): GeoUnit {
    const u = this.units.findOne((g) => g.level === 'COMMUNE' && g.name === name);
    if (!u) throw notFound('UNKNOWN_COMMUNE', `Commune inconnue : ${name}`);
    return u;
  }

  /** Quartier (créé à la première validation d'un objet qui s'y trouve). */
  ensureQuartier(commune: string, name: string): GeoUnit {
    const parent = this.commune(commune);
    const found = this.units.findOne((g) => g.level === 'QUARTIER' && g.parentId === parent.id && norm(g.name) === norm(name));
    if (found) return found;
    const n = this.units.find((g) => g.level === 'QUARTIER' && g.parentId === parent.id).length + 1;
    return this.units.insert({
      id: this.ids.next(`GEO-${parent.code}-Q`, 3), level: 'QUARTIER', name: name.trim(), code: `Q${String(n).padStart(3, '0')}`,
      parentId: parent.id, commune, createdAt: this.now(),
    });
  }

  ensureAvenue(quartier: GeoUnit, name: string): GeoUnit {
    const found = this.units.findOne((g) => g.level === 'AVENUE' && g.parentId === quartier.id && norm(g.name) === norm(name));
    if (found) return found;
    const n = this.units.find((g) => g.level === 'AVENUE' && g.parentId === quartier.id).length + 1;
    return this.units.insert({
      id: this.ids.next(`${quartier.id}-A`, 3), level: 'AVENUE', name: name.trim(), code: `A${String(n).padStart(3, '0')}`,
      parentId: quartier.id, commune: quartier.commune, createdAt: this.now(),
    });
  }

  list(filter: { level?: GeoLevel; parentId?: string; commune?: string }): GeoUnit[] {
    return this.units.find((g) =>
      (!filter.level || g.level === filter.level) && (!filter.parentId || g.parentId === filter.parentId) && (!filter.commune || g.commune === filter.commune));
  }

  /**
   * Génère l'IGF d'un objet qui n'en a pas encore. Un objet enfant (bâtiment, unité, activité) prolonge le
   * code de son parent (`…-P004517-B01-U03`) ; un objet racine reçoit un numéro séquentiel dans son quartier.
   */
  generateIgf(obj: FiscalObject, parent: FiscalObject | undefined, siblingsWithIgf: number): { uuid: string; code: string; codeVersion: number } {
    const seg = CATEGORY_SEGMENT[obj.category];
    if (parent) {
      if (!parent.igf) {
        throw unprocessable('PARENT_NOT_VALIDATED', `L'objet parent ${parent.id} doit être validé (IGF attribué) avant ${obj.id}.`);
      }
      return { uuid: randomUUID(), code: `${parent.igf.code}-${seg}${String(siblingsWithIgf + 1).padStart(2, '0')}`, codeVersion: 1 };
    }
    const q = this.ensureQuartier(obj.commune, obj.quartier);
    const key = q.id;
    const n = (this.rootCounters.get(key) ?? 0) + 1;
    this.rootCounters.set(key, n);
    const communeCode = COMMUNE_CODES[obj.commune as keyof typeof COMMUNE_CODES];
    return { uuid: randomUUID(), code: `KIN-${communeCode}-${q.code}-${seg}${String(n).padStart(6, '0')}`, codeVersion: 1 };
  }

  /** Chemin hiérarchique lisible d'un objet (commune › quartier › avenue). */
  path(obj: FiscalObject): { level: string; name: string; code: string }[] {
    const c = this.commune(obj.commune);
    const out = [{ level: 'COMMUNE', name: c.name, code: c.code }];
    const q = this.units.findOne((g) => g.level === 'QUARTIER' && g.parentId === c.id && norm(g.name) === norm(obj.quartier));
    out.push({ level: 'QUARTIER', name: obj.quartier, code: q?.code ?? '—' });
    if (obj.avenue) {
      const a = q ? this.units.findOne((g) => g.level === 'AVENUE' && g.parentId === q.id && norm(g.name) === norm(obj.avenue!)) : undefined;
      out.push({ level: 'AVENUE', name: obj.avenue, code: a?.code ?? '—' });
    }
    return out;
  }
}
