/**
 * Module 8 — Cadastre fiscal géospatial (Spécification fonctionnelle ; § 17, § 17.3, § 17.4).
 *
 * Par-dessus la hiérarchie SIG et l'identifiant géofiscal du module « fiscal » (IGF, QR par bien, vagues, provenance) :
 *  - géométries versionnées (point ou polygone) avec PRÉCISION et SOURCE, en ajout seul : historique spatial ;
 *  - hiérarchie complète commune → quartier → avenue → parcelle → bâtiment → étage → unité → activité ;
 *  - détection des objets superposés (polygones qui se chevauchent) ou dupliqués (même catégorie, même position) :
 *    une LISTE DE REVUE, jamais une fusion ni une suppression ;
 *  - cas difficiles : objet sans adresse (repère + photo de façade), habitat informel (grappe provisoire, sans effet
 *    fiscal), GPS imprécis (au-delà de la tolérance de la commune), litige de limites (renvoi au service foncier) ;
 *  - couches (parcelles, bâtiments, établissements, marchés, stationnement, panneaux, antennes, ports, concessions,
 *    zones d'inspection) et cartes de chaleur (potentiel, conformité, couverture, recettes) par commune ;
 *  - couverture par zone et par catégorie.
 * Le cadastre fiscal ne tranche pas les droits réels ; les couches sensibles sont restreintes par rôle.
 */
import { haversineM, Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { actorOf } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { situationOf } from '../fiscal/situation.js';
import { extOpt, fiscalOf, parDefaut, pct, verticalesOf } from './common.js';

const { always, inTerritory } = GRANTS;
definePolicy('citoyen:cadastre.read', { R01: always, R02: always, R05: always, R06: always, R07: always, R11: always, R22: always, R24: always, R09: inTerritory('minimal'), R10: inTerritory('minimal') });
definePolicy('citoyen:cadastre.edit', { R06: always, R07: always, R11: always, R10: inTerritory('full'), R09: inTerritory('full') });
definePolicy('citoyen:cadastre.decide', { R06: always, R07: always, R11: always });
/** Couches sensibles (antennes, zones d'inspection) : direction, contrôle, audit, anti-fraude. */
definePolicy('citoyen:cadastre.sensible', { R01: always, R06: always, R07: always, R11: always, R22: always, R24: always });

export const SOURCES_GEOMETRIE = ['LEVE_GPS_TERRAIN', 'AUTO_DECLARATION', 'IMAGERIE_SOUS_LICENCE', 'CADASTRE_FONCIER', 'DONNEES_ADMINISTRATIVES', 'POSITION_DECLAREE_OBJET'] as const;
export type SourceGeometrie = (typeof SOURCES_GEOMETRIE)[number];

export interface GeometrieObjet {
  id: string;
  objectId: string;
  version: number;
  type: 'POINT' | 'POLYGONE';
  /** [longitude, latitude] ; un point = un sommet ; un polygone = anneau (≥ 3 sommets, non fermé). */
  coordonnees: [number, number][];
  precisionM: number | null;
  source: SourceGeometrie;
  motif: string;
  par: string;
  at: string;
}

export const TYPES_CAS = ['SANS_ADRESSE', 'HABITAT_INFORMEL', 'GPS_IMPRECIS', 'LITIGE_LIMITES'] as const;
export type TypeCas = (typeof TYPES_CAS)[number];
export const TYPE_CAS_LIBELLE: Record<TypeCas, string> = {
  SANS_ADRESSE: 'Objet sans adresse (repère de voisinage et photo de façade)',
  HABITAT_INFORMEL: 'Habitat informel (grappe provisoire, sans effet fiscal)',
  GPS_IMPRECIS: 'GPS imprécis (au-delà de la tolérance de la commune)',
  LITIGE_LIMITES: 'Litige de limites (renvoi au service foncier)',
};

export interface CasDifficile {
  id: string;
  type: TypeCas;
  objectId?: string;
  commune: string;
  quartier?: string;
  repere?: string;
  photoFacadeSha256?: string;
  grappe?: { identifiantProvisoire: string; unitesEstimees: number };
  precisionM?: number;
  objetsVoisins?: string[];
  statut: 'OUVERT' | 'RENVOYE_SERVICE_FONCIER' | 'RESOLU';
  ouvertPar: string;
  ouvertLe: string;
  decision?: { par: string; at: string; motif: string; statut: CasDifficile['statut'] };
  note: string;
}

export interface RevueSuperposition {
  id: string;
  cle: string;
  objets: [string, string];
  nature: 'DOUBLON_PROBABLE' | 'CHEVAUCHEMENT';
  distanceM: number | null;
  statut: 'A_EXAMINER' | 'DISTINCTS' | 'DOUBLON_CONFIRME';
  detecteLe: string;
  decision?: { par: string; at: string; motif: string };
}

/** Distance de doublon probable entre deux objets de même catégorie — valeur par défaut à confirmer. */
export const SEUIL_DOUBLON_M = parDefaut(3, 'Spécification fonctionnelle, module 8 — détection des objets dupliqués');
/** Seuil d'agrégation des cartes publiques (identique à la carte à deux couches). */
const SEUIL_AGREGATION = 20;

export const COUCHES = [
  { code: 'parcelles', libelle: 'Parcelles', sensible: false },
  { code: 'batiments', libelle: 'Bâtiments', sensible: false },
  { code: 'etablissements', libelle: 'Établissements', sensible: false },
  { code: 'marches', libelle: 'Marchés et étals', sensible: false },
  { code: 'stationnement', libelle: 'Stationnement', sensible: false },
  { code: 'panneaux', libelle: 'Panneaux publicitaires', sensible: false },
  { code: 'antennes', libelle: 'Antennes et sites télécoms', sensible: true },
  { code: 'ports', libelle: 'Ports et embarcations', sensible: false },
  { code: 'concessions', libelle: 'Concessions et emprises', sensible: false },
  { code: 'zones-inspection', libelle: 'Zones d’inspection (missions)', sensible: true },
] as const;
export type CodeCouche = (typeof COUCHES)[number]['code'];

const objectType = (o: FiscalObject) => String(o.attributes['objectType'] ?? '');
const inKinshasa = (lat: number, lon: number) => lat <= -3.9 && lat >= -5.0 && lon >= 15.0 && lon <= 16.7;

export class CadastreService {
  readonly geometries = new InMemoryAppendOnlyRepository<GeometrieObjet>();
  readonly cas = new InMemoryRepository<CasDifficile>();
  readonly revues = new InMemoryRepository<RevueSuperposition>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now() { return this.ctx.clock.now().toISOString(); }
  private objet(id: string) { return this.ctx.objects.get(id); }

  toleranceM(commune: string): number {
    const terrain = extOpt<{ toleranceFor(c: string): number }>(this.ctx, 'terrain');
    return terrain?.toleranceFor(commune) ?? 50;
  }

  // ─────────────── Géométries et historique spatial ───────────────

  geometrieCourante(objectId: string): GeometrieObjet {
    const list = this.geometries.find((g) => g.objectId === objectId);
    if (list.length) return list[list.length - 1]!;
    const o = this.objet(objectId);
    // Version 0 : position déclarée de l'objet (précision inconnue).
    return { id: `GEO0-${o.id}`, objectId: o.id, version: 0, type: 'POINT', coordonnees: [[o.lon, o.lat]], precisionM: null, source: 'POSITION_DECLAREE_OBJET', motif: 'Position enregistrée à la création de l’objet', par: o.createdBy, at: o.createdAt };
  }

  enregistrerGeometrie(user: User, objectId: string, input: { type: 'POINT' | 'POLYGONE'; coordonnees: [number, number][]; precisionM: number; source: SourceGeometrie; motif: string }) {
    const o = this.objet(objectId);
    authorize(user, 'citoyen:cadastre.edit', { communes: [o.commune] });
    if (input.type === 'POINT' && input.coordonnees.length !== 1) throw badRequest('GEOMETRIE_INVALIDE', 'Un point a exactement un sommet.');
    if (input.type === 'POLYGONE' && input.coordonnees.length < 3) throw badRequest('GEOMETRIE_INVALIDE', 'Un polygone a au moins trois sommets.');
    for (const [lon, lat] of input.coordonnees) if (!inKinshasa(lat, lon)) throw badRequest('HORS_KINSHASA', 'Sommet hors de la Ville-Province de Kinshasa.');
    const prev = this.geometries.find((g) => g.objectId === o.id);
    const g = this.geometries.append({
      id: this.ids.next('GEO'), objectId: o.id, version: prev.length + 1, type: input.type, coordonnees: input.coordonnees,
      precisionM: input.precisionM, source: input.source, motif: input.motif, par: user.id, at: this.now(),
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'cadastre.geometry.recorded', resourceType: 'fiscal_object', resourceId: o.id,
      details: { version: g.version, type: g.type, precisionM: g.precisionM, source: g.source }, before: prev.at(-1) ?? null, after: g,
    });
    // GPS imprécis : ouverture automatique d'un cas (revue humaine), jamais un rejet.
    const tol = this.toleranceM(o.commune);
    if (g.precisionM !== null && g.precisionM > tol && !this.cas.findOne((c) => c.objectId === o.id && c.type === 'GPS_IMPRECIS' && c.statut === 'OUVERT')) {
      this.ouvrirCas({ kind: 'system', id: 'cadastre' }, { type: 'GPS_IMPRECIS', objectId: o.id, commune: o.commune, quartier: o.quartier, precisionM: g.precisionM, note: `Précision ${g.precisionM} m > tolérance ${tol} m de ${o.commune}.` });
    }
    return { geometrie: g, superpositions: this.superpositionsDe(o.id) };
  }

  historique(user: User, objectId: string) {
    const o = this.objet(objectId);
    authorize(user, 'citoyen:cadastre.read', { communes: [o.commune] });
    const geos = this.geometries.find((g) => g.objectId === o.id);
    return {
      objectId: o.id, igf: o.igf?.code ?? null,
      geometries: geos.length ? geos : [this.geometrieCourante(o.id)],
      evenements: [
        ...(o.censusHistory ?? []).map((h) => ({ at: h.at, nature: 'VAGUE', detail: `Vague ${h.from ?? '—'} → ${h.to} : ${h.reason}`, par: h.by })),
        ...(o.history ?? []).map((h) => ({ at: h.at, nature: h.kind, detail: h.reason, par: h.by.join(', ') })),
        ...(o.igf ? [{ at: o.igf.assignedAt, nature: 'IGF', detail: `Identifiant géofiscal ${o.igf.code} attribué`, par: o.igf.assignedBy }] : []),
      ].sort((a, b) => a.at.localeCompare(b.at)),
      cas: this.cas.find((c) => c.objectId === o.id),
    };
  }

  // ─────────────── Hiérarchie territoriale ───────────────

  hierarchie(user: User, objectId: string) {
    const o = this.objet(objectId);
    authorize(user, 'citoyen:cadastre.read', { communes: [o.commune] });
    const fiscal = fiscalOf(this.ctx);
    const chain: FiscalObject[] = [];
    let cur: FiscalObject | undefined = o;
    while (cur) { chain.unshift(cur); cur = cur.parentObjectId ? this.ctx.objects.objects.get(cur.parentObjectId) : undefined; }
    const base = fiscal ? fiscal.geo.path(chain[0]!) : [{ level: 'COMMUNE', name: o.commune, code: '—' }, { level: 'QUARTIER', name: o.quartier, code: '—' }];
    const niveaux: { niveau: string; libelle: string; id?: string; igf?: string | null }[] = base.map((b) => ({ niveau: b.level, libelle: `${b.name} (${b.code})` }));
    const LEVEL: Record<string, string> = { PARCELLE: 'PARCELLE', BATIMENT: 'BATIMENT', UNITE_LOCATIVE: 'UNITE', ACTIVITE: 'ACTIVITE' };
    for (const x of chain) {
      const etage = x.attributes['etage'] ?? x.attributes['niveau'];
      if (x.category === 'UNITE_LOCATIVE' && etage !== undefined && etage !== '') niveaux.push({ niveau: 'ETAGE', libelle: String(etage) });
      niveaux.push({ niveau: LEVEL[x.category] ?? x.category, libelle: String(x.attributes['nom'] ?? x.attributes['objectType'] ?? x.category), id: x.id, igf: x.igf?.code ?? null });
    }
    // Activités exercées dans l'objet (enfants de catégorie ACTIVITE).
    for (const a of this.ctx.objects.objects.find((y) => y.parentObjectId === o.id && y.category === 'ACTIVITE')) {
      niveaux.push({ niveau: 'ACTIVITE', libelle: String(a.attributes['nom'] ?? a.attributes['activite'] ?? 'Activité'), id: a.id, igf: a.igf?.code ?? null });
    }
    return { objectId: o.id, niveaux, ordre: ['COMMUNE', 'QUARTIER', 'AVENUE', 'PARCELLE', 'BATIMENT', 'ETAGE', 'UNITE', 'ACTIVITE'] };
  }

  // ─────────────── Superpositions et doublons ───────────────

  private superpositionsDe(objectId: string) {
    return this.detecter({ kind: 'system', id: 'cadastre' }).filter((r) => r.objets.includes(objectId));
  }

  /** Détection (revue humaine) : chevauchement de polygones, ou même catégorie à moins du seuil de doublon. */
  detecter(actor: { kind: 'system'; id: string } | User): RevueSuperposition[] {
    const objs = this.ctx.objects.objects.all();
    const seuil = SEUIL_DOUBLON_M.valeur;
    const cell = (o: FiscalObject) => `${Math.round(o.lat * 2000)}:${Math.round(o.lon * 2000)}`;
    const grid = new Map<string, FiscalObject[]>();
    for (const o of objs) grid.set(cell(o), [...(grid.get(cell(o)) ?? []), o]);
    const found: RevueSuperposition[] = [];
    const push = (a: FiscalObject, b: FiscalObject, nature: RevueSuperposition['nature'], d: number | null) => {
      const [x, y] = [a.id, b.id].sort() as [string, string];
      const cle = `${x}|${y}|${nature}`;
      const existing = this.revues.findOne((r) => r.cle === cle);
      found.push(existing ?? this.revues.insert({ id: this.ids.next('SUP'), cle, objets: [x, y], nature, distanceM: d === null ? null : Math.round(d * 10) / 10, statut: 'A_EXAMINER', detecteLe: this.now() }));
    };
    const related = (a: FiscalObject, b: FiscalObject) => a.parentObjectId === b.id || b.parentObjectId === a.id || (!!a.parentObjectId && a.parentObjectId === b.parentObjectId && a.category !== b.category);
    for (const o of objs) {
      const [la, lo] = [Math.round(o.lat * 2000), Math.round(o.lon * 2000)];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const p of grid.get(`${la + i}:${lo + j}`) ?? []) {
          if (p.id <= o.id || related(o, p)) continue;
          if (p.category === o.category) {
            const d = haversineM({ lat: o.lat, lon: o.lon }, { lat: p.lat, lon: p.lon });
            if (d <= seuil && (p.attributes['unite'] ?? p.attributes['niveau'] ?? '') === (o.attributes['unite'] ?? o.attributes['niveau'] ?? '')) push(o, p, 'DOUBLON_PROBABLE', d);
          }
        }
      }
    }
    // Chevauchement des polygones courants (parcelles) : intersection d'arêtes ou sommet contenu.
    const polys = objs.map((o) => ({ o, g: this.geometrieCourante(o.id) })).filter((x) => x.g.type === 'POLYGONE');
    for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
      const a = polys[i]!; const b = polys[j]!;
      if (related(a.o, b.o) || a.o.category !== b.o.category) continue;
      if (polygonesSeChevauchent(a.g.coordonnees, b.g.coordonnees)) push(a.o, b.o, 'CHEVAUCHEMENT', null);
    }
    if (actor.kind === 'user') this.ctx.audit.append({ actor: actorOf(actor), action: 'cadastre.overlaps.detected', resourceType: 'cadastre', resourceId: 'superpositions', details: { trouves: found.length } });
    return found;
  }

  listeSuperpositions(user: User) {
    authorize(user, 'citoyen:cadastre.read');
    const items = this.detecter(user).map((r) => ({ ...r, objetsDetail: r.objets.map((id) => { const o = this.ctx.objects.objects.get(id); return o ? { id, igf: o.igf?.code ?? null, categorie: o.category, commune: o.commune, quartier: o.quartier } : { id }; }) }));
    const visible = items.filter((r) => r.objetsDetail.every((d) => !('commune' in d) || evaluate(user, 'citoyen:cadastre.read', { communes: [d.commune as string] })));
    return { items: visible, seuil: SEUIL_DOUBLON_M, notice: 'Liste de revue : aucune fusion ni suppression automatique ; une personne décide.' };
  }

  deciderSuperposition(user: User, id: string, input: { decision: 'DISTINCTS' | 'DOUBLON_CONFIRME'; motif: string }) {
    authorize(user, 'citoyen:cadastre.decide');
    const r = this.revues.get(id);
    if (!r) throw notFound('REVUE_INCONNUE', `Revue inconnue : ${id}`);
    if (r.statut !== 'A_EXAMINER') throw conflict('REVUE_DECIDEE', 'Revue déjà décidée.');
    const out = this.revues.update({ ...r, statut: input.decision, decision: { par: user.id, at: this.now(), motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'cadastre.overlap.decided', resourceType: 'cadastre_review', resourceId: id, details: { decision: input.decision, objets: r.objets, motif: input.motif } });
    return out;
  }

  // ─────────────── Cas difficiles ───────────────

  ouvrirCas(actor: User | { kind: 'system'; id: string }, input: { type: TypeCas; objectId?: string; commune: string; quartier?: string; repere?: string; photoFacadeSha256?: string; unitesEstimees?: number; precisionM?: number; objetsVoisins?: string[]; note: string }) {
    if (!COMMUNES.includes(input.commune as (typeof COMMUNES)[number])) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    if (actor.kind === 'user') authorize(actor, 'citoyen:cadastre.edit', { communes: [input.commune] });
    if (input.objectId) this.objet(input.objectId);
    if (input.type === 'SANS_ADRESSE' && (!input.repere || !input.photoFacadeSha256)) throw badRequest('REPERE_REQUIS', 'Objet sans adresse : repère de voisinage et empreinte de la photo de façade obligatoires.');
    if (input.type === 'HABITAT_INFORMEL' && !input.unitesEstimees) throw badRequest('GRAPPE_REQUISE', 'Habitat informel : nombre d’unités estimées de la grappe requis.');
    if (input.type === 'LITIGE_LIMITES' && (!input.objectId || !input.objetsVoisins?.length)) throw badRequest('VOISINS_REQUIS', 'Litige de limites : objet et objets voisins concernés requis.');
    const id = this.ids.next('CAS');
    const c = this.cas.insert({
      id, type: input.type, ...(input.objectId ? { objectId: input.objectId } : {}), commune: input.commune, ...(input.quartier ? { quartier: input.quartier } : {}),
      ...(input.repere ? { repere: input.repere } : {}), ...(input.photoFacadeSha256 ? { photoFacadeSha256: input.photoFacadeSha256 } : {}),
      ...(input.type === 'HABITAT_INFORMEL' ? { grappe: { identifiantProvisoire: `GRP-${id.split('-').pop()}`, unitesEstimees: input.unitesEstimees! } } : {}),
      ...(input.precisionM !== undefined ? { precisionM: input.precisionM } : {}), ...(input.objetsVoisins ? { objetsVoisins: input.objetsVoisins } : {}),
      statut: 'OUVERT', ouvertPar: actor.id, ouvertLe: this.now(), note: input.note,
    });
    this.ctx.audit.append({ actor: actor.kind === 'user' ? actorOf(actor) : { kind: 'system', id: actor.id }, action: 'cadastre.hard_case.opened', resourceType: 'cadastre_case', resourceId: c.id, details: { type: c.type, objectId: c.objectId ?? null, commune: c.commune } });
    return this.vueCas(c);
  }

  vueCas(c: CasDifficile) {
    return {
      ...c, libelle: TYPE_CAS_LIBELLE[c.type],
      effetFiscal: c.type === 'HABITAT_INFORMEL' ? 'Aucun effet fiscal avant qualification de chaque unité.' : c.type === 'LITIGE_LIMITES' ? 'Le cadastre fiscal ne tranche pas les droits réels : renvoi au service foncier.' : 'Sans effet sur les obligations ; revue humaine.',
    };
  }

  listeCas(user: User, commune?: string) {
    authorize(user, 'citoyen:cadastre.read', commune ? { communes: [commune] } : {});
    return this.cas.find((c) => (!commune || c.commune === commune) && !!evaluate(user, 'citoyen:cadastre.read', { communes: [c.commune] })).map((c) => this.vueCas(c));
  }

  deciderCas(user: User, id: string, input: { statut: 'RENVOYE_SERVICE_FONCIER' | 'RESOLU'; motif: string }) {
    const c = this.cas.get(id);
    if (!c) throw notFound('CAS_INCONNU', `Cas inconnu : ${id}`);
    authorize(user, 'citoyen:cadastre.decide', { communes: [c.commune] });
    if (c.statut === 'RESOLU') throw conflict('CAS_CLOS', 'Cas déjà résolu.');
    if (input.statut === 'RENVOYE_SERVICE_FONCIER' && c.type !== 'LITIGE_LIMITES') throw badRequest('RENVOI_INAPPLICABLE', 'Seul un litige de limites est renvoyé au service foncier.');
    const out = this.cas.update({ ...c, statut: input.statut, decision: { par: user.id, at: this.now(), motif: input.motif, statut: input.statut } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'cadastre.hard_case.decided', resourceType: 'cadastre_case', resourceId: id, details: { statut: input.statut, motif: input.motif } });
    return this.vueCas(out);
  }

  // ─────────────── Couches, chaleur, couverture ───────────────

  private membresCouche(code: CodeCouche): { id: string; lat: number; lon: number; commune: string }[] {
    const objs = this.ctx.objects.objects.all();
    const of = (pred: (o: FiscalObject) => boolean) => objs.filter(pred).map((o) => ({ id: o.id, lat: o.lat, lon: o.lon, commune: o.commune }));
    switch (code) {
      case 'parcelles': return of((o) => o.category === 'PARCELLE');
      case 'batiments': return of((o) => o.category === 'BATIMENT');
      case 'etablissements': return of((o) => o.category === 'ACTIVITE' && !['ETAL', 'SITE_TELECOM', 'CARRIERE'].includes(objectType(o)));
      case 'marches': {
        // Étals rattachés à un objet (position de l'objet) ; étals libres : position inconnue, comptés dans leur commune.
        const vx = verticalesOf(this.ctx);
        const withObject = new Set(objs.filter((o) => objectType(o) === 'ETAL' || objectType(o) === 'MARCHE').map((o) => o.id));
        const free = vx ? vx.stalls.all().filter((s) => !s.objectId || !withObject.has(s.objectId)).map((s) => ({ id: s.id, lat: 0, lon: 0, commune: vx.markets.get(s.marketId)?.commune ?? '—' })) : [];
        return [...of((o) => withObject.has(o.id)), ...free];
      }
      case 'stationnement': {
        const parking = extOpt<{ zones?: { all(): { id: string; commune: string; center: { lat: number; lon: number } }[] } }>(this.ctx, 'parking');
        return (parking?.zones?.all() ?? []).map((z) => ({ id: z.id, lat: z.center.lat, lon: z.center.lon, commune: z.commune }));
      }
      case 'panneaux': return of((o) => o.category === 'PANNEAU');
      case 'antennes': return of((o) => objectType(o) === 'SITE_TELECOM');
      case 'ports': return of((o) => ['EMBARCATION', 'QUAI', 'PORT'].includes(objectType(o)));
      case 'concessions': return of((o) => ['CONCESSION_FORESTIERE', 'EMPRISE_PERMANENTE', 'EMPRISE', 'EMPRISE_TEMPORAIRE', 'CARRIERE'].includes(objectType(o)));
      case 'zones-inspection': {
        const terrain = extOpt<{ missions?: { all(): { id: string; commune: string; center: { lat: number; lon: number } }[] } }>(this.ctx, 'terrain');
        return (terrain?.missions?.all() ?? []).map((m) => ({ id: m.id, lat: m.center.lat, lon: m.center.lon, commune: m.commune }));
      }
    }
  }

  couches(user: User | undefined) {
    const agent = !!user && !!evaluate(user, 'citoyen:cadastre.read');
    const sens = !!user && !!evaluate(user, 'citoyen:cadastre.sensible');
    return {
      couches: COUCHES.map((c) => {
        const membres = this.membresCouche(c.code);
        const restreinte = c.sensible && !sens;
        const total = membres.length;
        return {
          code: c.code, libelle: c.libelle, sensible: c.sensible, restreinte,
          total: restreinte ? null : (!agent && total > 0 && total < SEUIL_AGREGATION ? null : total),
          parCommune: restreinte ? null : COMMUNES.map((k) => ({ commune: k, total: membres.filter((m) => m.commune === k).length })).filter((x) => x.total > 0)
            .map((x) => ({ ...x, total: agent || x.total >= SEUIL_AGREGATION ? x.total : null })),
          elements: agent && !restreinte ? membres.filter((m) => m.lat !== 0 && evaluate(user!, 'citoyen:cadastre.read', { communes: [m.commune] })).slice(0, 2000) : [],
        };
      }),
      notice: agent ? 'Couches sensibles réservées aux rôles habilités ; aucun montant.' : `Vue publique : totaux seulement, masqués sous ${SEUIL_AGREGATION} éléments.`,
    };
  }

  chaleur(user: User, indicateur: 'potentiel' | 'conformite' | 'couverture' | 'recettes') {
    authorize(user, 'citoyen:cadastre.read');
    const fiscal = fiscalOf(this.ctx);
    const objs = this.ctx.objects.objects.all();
    const rows = COMMUNES.map((commune) => {
      const os = objs.filter((o) => o.commune === commune);
      let valeur: string | null = null;
      let detail = '';
      if (indicateur === 'potentiel') { valeur = String(os.length); detail = 'Objets recensés (potentiel observé ; le potentiel estimé suppose un modèle non disponible).'; }
      if (indicateur === 'conformite') {
        const green = fiscal ? os.filter((o) => situationOf(fiscal.d, o).color === 'green').length : 0;
        valeur = pct(green, os.length); detail = `${green} objet(s) en situation verte sur ${os.length}.`;
      }
      if (indicateur === 'couverture') {
        const valides = os.filter((o) => o.status === 'VALIDE').length;
        valeur = pct(valides, os.length); detail = `${valides} objet(s) validé(s) (IGF) sur ${os.length} recensé(s).`;
      }
      if (indicateur === 'recettes') {
        const paid = this.ctx.payments.orders.find((p) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status) && p.attribution?.commune === commune);
        const totals = new Map<string, Money>();
        for (const p of paid) totals.set(p.amount.currency, (totals.get(p.amount.currency) ?? Money.zero(p.amount.currency)).add(Money.fromJSON(p.amount)));
        const list: MoneyJSON[] = [...totals.values()].map((m) => m.toJSON());
        valeur = list.map((m) => `${m.amount} ${m.currency}`).join(' + ') || '0';
        detail = `${paid.length} paiement(s) confirmé(s) attribué(s) à la commune.`;
      }
      return { commune, objets: os.length, valeur, detail, masque: os.length > 0 && os.length < SEUIL_AGREGATION && !evaluate(user, 'citoyen:cadastre.read', { communes: [commune] }) };
    });
    return { indicateur, lignes: rows.map((r) => (r.masque ? { ...r, valeur: null, detail: `Masqué sous ${SEUIL_AGREGATION} objets.` } : r)), seuil: SEUIL_AGREGATION };
  }

  couverture(user: User, commune?: string) {
    authorize(user, 'citoyen:cadastre.read', commune ? { communes: [commune] } : {});
    const objs = this.ctx.objects.objects.all().filter((o) => !commune || o.commune === commune);
    const cats = [...new Set(objs.map((o) => o.category))].sort();
    const zones = [...new Set(objs.map((o) => `${o.commune}|${o.quartier}`))].sort();
    return {
      parZone: zones.map((z) => {
        const [c, q] = z.split('|') as [string, string];
        const os = objs.filter((o) => o.commune === c && o.quartier === q);
        return { commune: c, quartier: q, parCategorie: cats.map((k) => { const ks = os.filter((o) => o.category === k); const v = ks.filter((o) => o.status === 'VALIDE').length; return { categorie: k, recenses: ks.length, valides: v, taux: pct(v, ks.length) }; }) };
      }),
      categories: cats,
    };
  }

  /** Indicateurs du module 8. */
  indicateurs() {
    const objs = this.ctx.objects.objects.all();
    const geoloc = objs.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon) && inKinshasa(o.lat, o.lon));
    const precisions = objs.map((o) => this.geometrieCourante(o.id).precisionM).filter((p): p is number => p !== null);
    return {
      couvertureGeofiscale: { valeur: pct(objs.filter((o) => !!o.igf).length, objs.length), numerateur: objs.filter((o) => !!o.igf).length, denominateur: objs.length, definition: 'Objets dotés d’un identifiant géofiscal (IGF) / objets recensés.', ...(objs.length ? {} : { raison: 'Aucun objet recensé.' }) },
      objetsGeolocalises: { valeur: geoloc.length, total: objs.length },
      precisionMoyenne: precisions.length
        ? { valeur: (Math.round((precisions.reduce((s, p) => s + p, 0) / precisions.length) * 10) / 10).toFixed(1), unite: 'm', mesures: precisions.length }
        : { valeur: null, raison: 'Aucune géométrie levée avec sa précision : précision moyenne non mesurée.' },
    };
  }
}

// ─────────────── Géométrie plane (petites surfaces) ───────────────

type Pt = [number, number];
function orient(a: Pt, b: Pt, c: Pt) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function segmentsSeCoupent(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d1 = orient(q1, q2, p1); const d2 = orient(q1, q2, p2); const d3 = orient(p1, p2, q1); const d4 = orient(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
export function pointDansPolygone(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!; const [xj, yj] = poly[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function polygonesSeChevauchent(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    if (segmentsSeCoupent(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
  }
  return pointDansPolygone(a[0]!, b) || pointDansPolygone(b[0]!, a);
}
