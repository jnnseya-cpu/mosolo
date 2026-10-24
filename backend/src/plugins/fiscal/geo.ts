/**
 * Hiérarchie SIG fiscale (commune › quartier › avenue › parcelle › bâtiment › unité) et identifiant
 * géographique fiscal (IGF, § 17.3 du document maître) :
 *   - identifiant interne ALÉATOIRE, non signifiant et permanent (UUID) ;
 *   - code territorial LISIBLE `KIN-GOM-Q012-P004517-B01-U03` (commune, quartier, parcelle, bâtiment, unité).
 * Le code lisible peut être réédité (redécoupage) sous une nouvelle version ; l'UUID ne change jamais.
 * Le cadastre fiscal ne confère aucun droit de propriété (§ 17.1).
 *
 * AJOUT (Document maître FR 2, nouvelle version, § 17.2) : le Cahier propose un autre format lisible,
 * `KIN-<code commune>-<code quartier>-<code voie>-<numéro séquentiel>` (ex. « KIN-GOM-GOMBE-AV-MONT-001245 »).
 * Le format territorial existant est CONSERVÉ (règle n° 1 : rien n'est retiré) ; le format du Cahier est attribué EN
 * PLUS, à la validation, comme alias stable et NON RÉATTRIBUABLE (registre `cahierCodes`, ajout seul) ; les deux
 * formats désignent le même objet et se résolvent l'un vers l'autre. Différence signalée au maître d'ouvrage : le
 * format territorial porte la catégorie (P/B/U…) et non la voie ; le format du Cahier porte la voie et non la catégorie.
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

/** Alias au format du Cahier (§ 17.2) : attribué une fois, jamais réattribué ni supprimé (même si l'objet est clos). */
export interface CahierIgf {
  /** Le code lui-même sert d'identifiant (unicité garantie par le dépôt). */
  id: string;
  objectId: string;
  igfUuid: string;
  /** Code territorial de l'objet (format existant) au moment de l'attribution. */
  territorialCode: string;
  /** Préfixe `KIN-<commune>-<quartier>-<voie>` (compteur séquentiel par préfixe). */
  prefix: string;
  sequence: number;
  assignedAt: string;
}

/** Abréviations de type de voie (première lettre du code voie, ex. « AV » pour avenue). [Valeurs de conception.] */
const VOIE_TYPES: [RegExp, string][] = [
  [/^(avenue|av)$/, 'AV'], [/^(boulevard|bd|blvd)$/, 'BD'], [/^rue$/, 'RUE'], [/^(route|rte)$/, 'RTE'],
  [/^(chaussee|chee)$/, 'CH'], [/^place$/, 'PL'], [/^(allee)$/, 'AL'], [/^(impasse)$/, 'IMP'], [/^(ruelle)$/, 'RLE'],
];
const STOP_WORDS = new Set(['du', 'de', 'des', 'la', 'le', 'les', 'l', 'd', 'et']);
const alnumWords = (s: string) => norm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/** Code quartier au format du Cahier : nom normalisé en capitales (ex. « Gombe » → « GOMBE »), 12 caractères au plus. */
export function cahierQuartierCode(quartier: string): string {
  const w = alnumWords(quartier).join('').toUpperCase().slice(0, 12);
  return w || 'SQ';
}

/**
 * Code voie au format du Cahier : type abrégé + premier mot significatif (ex. « Avenue du Mont Fleury » → « AV-MONT »).
 * Objet sans adresse formelle (§ 17.3) : « SV » (sans voie) — l'identifiant repose alors sur le point GPS et le repère.
 */
export function cahierVoieCode(avenue: string | undefined): string {
  if (!avenue?.trim()) return 'SV';
  const words = alnumWords(avenue);
  let type = 'V';
  let rest = words;
  const t = VOIE_TYPES.find(([re]) => re.test(words[0] ?? ''));
  if (t) { type = t[1]; rest = words.slice(1); }
  const main = rest.find((w) => !STOP_WORDS.has(w)) ?? rest[0] ?? '';
  return main ? `${type}-${main.toUpperCase().slice(0, 8)}` : type;
}

/** Forme du code au format du Cahier (racine) et de ses prolongements (sous-objets : « …-001245-B01-U03 »). */
export const CAHIER_IGF_PATTERN = /^KIN-[A-Z]{3}-[A-Z0-9]{1,12}-[A-Z0-9]+(?:-[A-Z0-9]{1,8})?-\d{6}(?:-[A-Z]\d{2})*$/;
/** Forme du code territorial existant. */
export const TERRITORIAL_IGF_PATTERN = /^KIN-[A-Z]{3}-Q\d{3}-[A-Z]\d{6}(?:-[A-Z]\d{2})*$/;

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
  /** Alias au format du Cahier (§ 17.2), stables et non réattribuables. */
  readonly cahierCodes = new InMemoryRepository<CahierIgf>();
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
  generateIgf(obj: FiscalObject, parent: FiscalObject | undefined, siblingsWithIgf: number): { uuid: string; code: string; codeVersion: number; cahierCode?: string } {
    const seg = CATEGORY_SEGMENT[obj.category];
    const uuid = randomUUID();
    if (parent) {
      if (!parent.igf) {
        throw unprocessable('PARENT_NOT_VALIDATED', `L'objet parent ${parent.id} doit être validé (IGF attribué) avant ${obj.id}.`);
      }
      const suffix = `-${seg}${String(siblingsWithIgf + 1).padStart(2, '0')}`;
      const code = `${parent.igf.code}${suffix}`;
      const cahierCode = parent.igf.cahierCode ? this.reserveCahier(`${parent.igf.cahierCode}${suffix}`, obj, uuid, code) : undefined;
      return { uuid, code, codeVersion: 1, ...(cahierCode ? { cahierCode } : {}) };
    }
    const q = this.ensureQuartier(obj.commune, obj.quartier);
    const key = q.id;
    const n = (this.rootCounters.get(key) ?? 0) + 1;
    this.rootCounters.set(key, n);
    const communeCode = COMMUNE_CODES[obj.commune as keyof typeof COMMUNE_CODES];
    const code = `KIN-${communeCode}-${q.code}-${seg}${String(n).padStart(6, '0')}`;
    return { uuid, code, codeVersion: 1, cahierCode: this.nextCahierCode(obj, uuid, code) };
  }

  /**
   * Alias au format du Cahier pour un objet racine : `KIN-<commune>-<quartier>-<voie>-<n° séquentiel sur 6 chiffres>`.
   * Le numéro repart au-delà du plus grand numéro déjà attribué pour le préfixe (jamais de réattribution, même après
   * redémarrage ou clôture de l'objet).
   */
  nextCahierCode(obj: FiscalObject, igfUuid: string, territorialCode: string): string {
    const communeCode = COMMUNE_CODES[obj.commune as keyof typeof COMMUNE_CODES];
    const prefix = `KIN-${communeCode}-${cahierQuartierCode(obj.quartier)}-${cahierVoieCode(obj.avenue)}`;
    const max = this.cahierCodes.find((c) => c.prefix === prefix).reduce((m, c) => Math.max(m, c.sequence), 0);
    const sequence = max + 1;
    return this.reserveCahier(`${prefix}-${String(sequence).padStart(6, '0')}`, obj, igfUuid, territorialCode, prefix, sequence);
  }

  private reserveCahier(code: string, obj: FiscalObject, igfUuid: string, territorialCode: string, prefix = code, sequence = 0): string {
    if (this.cahierCodes.get(code)) throw unprocessable('IGF_ALREADY_ASSIGNED', `Identifiant ${code} déjà attribué : jamais réattribué.`);
    this.cahierCodes.insert({ id: code, objectId: obj.id, igfUuid, territorialCode, prefix, sequence, assignedAt: this.now() });
    return code;
  }

  /** Objet désigné par un code, quel que soit son format (territorial existant ou format du Cahier). */
  resolveCode(code: string, objects: { findOne: (p: (o: FiscalObject) => boolean) => FiscalObject | undefined }): FiscalObject | undefined {
    const c = code.trim().toUpperCase();
    const alias = this.cahierCodes.get(c);
    if (alias) return objects.findOne((o) => o.id === alias.objectId);
    return objects.findOne((o) => o.igf?.code === c || o.igf?.cahierCode === c);
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
