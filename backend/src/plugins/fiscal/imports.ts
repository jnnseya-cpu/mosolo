/**
 * Reprise de l'existant — e-DGRK et télédéclaration (§ 2, § 7.5, H.3.4) et import par lots de la vague 0 (§ 17.4) :
 * comptes, objets et historique, en CSV ou JSON, avec rapport de validation ligne par ligne. Chaque donnée reprise porte
 * la provenance « e-DGRK ». Aucune fusion silencieuse : les doublons probables deviennent des PROPOSITIONS (file de
 * fusion du registre d'identité, à double validation) ou des lignes en attente de décision humaine. L'historique repris
 * est une information (statut « importé — source régie ») : il ne crée ni obligation ni dette ; un impayé historique
 * se reprend par le circuit existant de reprise d'arriérés (recouvrement), sur proposition motivée.
 *
 * Deux personnes : l'agent qui dépose le lot (validation à blanc) n'est pas celui qui l'intègre.
 */
import type { User } from '../../core/auth.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { isCommune } from '../../reference/kinshasa.js';
import { OBJECT_CATEGORIES, type DataProvenance, type FiscalObject, type ObjectCategory } from '../../modules/objects/service.js';
import { actorOf, type FiscalDeps } from './common.js';
import type { RelationService } from './relations.js';
import { aiguillerObjet, aiguillerRecette, AIGUILLAGE_STATUT, type Aiguillage, type Regie } from './aiguillage.js';

const { always } = GRANTS;
definePolicy('fiscal:import.upload', { R06: always, R07: always, R11: always, R12: always });
definePolicy('fiscal:import.commit', { R06: always, R07: always, R11: always });
definePolicy('fiscal:import.read', { R06: always, R07: always, R11: always, R12: always, R22: always, R23: always });

export const IMPORT_SOURCES = { E_DGRK: 'e-DGRK', TELEDECLARATION: 'Télédéclaration DGRK', DONNEES_ADMINISTRATIVES: 'Données administratives existantes' } as const;
export type ImportSource = keyof typeof IMPORT_SOURCES;

/** Colonnes reconnues (CSV : ligne d'en-tête ; JSON : clés des objets). */
export const IMPORT_COLUMNS = [
  'type', 'ref_externe', 'nom', 'telephone', 'nif', 'forme', 'categorie', 'commune', 'quartier', 'avenue', 'rang', 'lat', 'lon',
  'superficie_m2', 'usage', 'compte_ref', 'exercice', 'recette', 'montant', 'devise', 'statut_paiement', 'quittance_ref',
] as const;

type Row = Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>;

export interface ImportLine {
  line: number; type: string; ref: string; ok: boolean; errors: string[]; outcome?: string; createdId?: string;
  /** Régie compétente après la réforme de la DGRK (DGIPK / DGTK) ; « A_ARBITRER » ⇒ décision d'une personne. */
  regie?: Aiguillage; regieMotif?: string; regieDecision?: { by: string; at: string; motif: string };
  /** Compte : régies de ses objets et recettes (un compte n'est jamais scindé). */
  regies?: Regie[];
}

export interface DedupProposal {
  line: number;
  ref: string;
  kind: 'COMPTE_MEME_TELEPHONE' | 'COMPTE_MEME_NIF' | 'COMPTE_NOM_PROCHE' | 'OBJET_MEME_IGF' | 'OBJET_MEME_EMPLACEMENT';
  candidateId: string;
  status: 'A_EXAMINER' | 'PROPOSITION_DE_FUSION' | 'RATTACHE' | 'CREE_DISTINCT';
  mergeId?: string;
  decidedBy?: string;
  reason?: string;
}

export interface ImportedHistoryItem {
  ref: string;
  taxpayerId: string | null;
  accountRef: string;
  fiscalYear: string;
  revenueLabel: string;
  amount: { amount: string; currency: string };
  paymentStatus: 'PAYE' | 'IMPAYE';
  receiptRef?: string;
  probativeStatus: 'IMPORTE_SOURCE_REGIE';
  note: string;
  /** Régie compétente (réforme de la DGRK, 30/09/2026). */
  regie?: Aiguillage;
}

export interface ImportBatch {
  id: string;
  source: ImportSource;
  sourceLabel: string;
  format: 'CSV' | 'JSON';
  contentHash: string;
  uploadedBy: string;
  uploadedAt: string;
  status: 'VALIDE_A_BLANC' | 'INTEGRE' | 'REJETE';
  rows: Row[];
  report: { total: number; valid: number; invalid: number; lines: ImportLine[]; byType: Record<string, number> };
  dedup: DedupProposal[];
  committedBy?: string;
  committedAt?: string;
  mapping: Record<string, string>;
  history: ImportedHistoryItem[];
  /** Répartition des lignes reprises entre DGIPK, DGTK et « à arbitrer » (réforme de la DGRK). */
  aiguillage?: { DGIPK: number; DGTK: number; A_ARBITRER: number; statut: string };
}

/** Lecture CSV (virgule ou point-virgule, guillemets doubles). */
export function parseCsv(text: string): Row[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const sep = (lines[0]!.match(/;/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const split = (l: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]!;
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const r: Row = {};
    head.forEach((h, i) => { if ((IMPORT_COLUMNS as readonly string[]).includes(h) && cells[i] !== undefined && cells[i] !== '') r[h as keyof Row] = cells[i]; });
    return r;
  });
}

const PHONE = /^\+?[0-9 -]{9,20}$/;
const DEC = /^\d{1,15}(\.\d{1,6})?$/;

export class ImportService {
  readonly batches = new InMemoryRepository<ImportBatch>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps, private readonly relations: RelationService) {}

  private validate(r: Row): string[] {
    const e: string[] = [];
    if (!r.ref_externe) e.push('ref_externe manquante');
    if (r.type === 'COMPTE') {
      if (!r.nom || r.nom.length < 2) e.push('nom manquant');
      if (r.telephone && !PHONE.test(r.telephone)) e.push('téléphone invalide');
      if (r.forme && !['PP', 'PM'].includes(r.forme)) e.push('forme attendue : PP ou PM');
    } else if (r.type === 'OBJET') {
      if (!r.categorie || !(OBJECT_CATEGORIES as readonly string[]).includes(r.categorie)) e.push(`categorie attendue : ${OBJECT_CATEGORIES.join(', ')}`);
      if (!r.commune || !isCommune(r.commune)) e.push('commune inconnue');
      if (!r.quartier) e.push('quartier manquant');
      if (!r.rang || !['1', '2', '3', '4'].includes(r.rang)) e.push('rang attendu : 1 à 4');
      if (!r.lat || !r.lon || Number.isNaN(Number(r.lat)) || Number.isNaN(Number(r.lon))) e.push('coordonnées lat/lon manquantes');
      if (r.superficie_m2 && !DEC.test(r.superficie_m2)) e.push('superficie_m2 : nombre attendu');
    } else if (r.type === 'HISTORIQUE') {
      if (!r.compte_ref) e.push('compte_ref manquant');
      if (!r.exercice || !/^\d{4}$/.test(r.exercice)) e.push('exercice AAAA attendu');
      if (!r.recette) e.push('recette manquante');
      if (!r.montant || !DEC.test(r.montant)) e.push('montant décimal attendu');
      if (!r.devise || !['USD', 'CDF'].includes(r.devise)) e.push('devise attendue : USD ou CDF');
      if (!r.statut_paiement || !['PAYE', 'IMPAYE'].includes(r.statut_paiement)) e.push('statut_paiement attendu : PAYE ou IMPAYE');
    } else e.push('type attendu : COMPTE, OBJET ou HISTORIQUE');
    return e;
  }

  private nifOwner(nif: string): string | undefined {
    const acces = this.d.ctx.ext['acces'] as { proofs?: { findOne(p: (x: { type: string; referenceHash: string; status: string; taxpayerId: string }) => boolean): { taxpayerId: string } | undefined } } | undefined;
    const hash = sha256Hex(`NIF:${nif.trim().toUpperCase()}`);
    return acces?.proofs?.findOne((p) => p.type === 'NIF' && p.referenceHash === hash && p.status !== 'REJETEE')?.taxpayerId;
  }

  private dedupFor(line: number, r: Row): DedupProposal | null {
    const ref = r.ref_externe!;
    if (r.type === 'COMPTE') {
      const phone = (r.telephone ?? '').replace(/[\s-]/g, '');
      const byPhone = phone ? this.d.ctx.taxpayers.taxpayers.findOne((t) => t.phone === phone) : undefined;
      if (byPhone) return { line, ref, kind: 'COMPTE_MEME_TELEPHONE', candidateId: byPhone.id, status: 'A_EXAMINER' };
      const byNif = r.nif ? this.nifOwner(r.nif) : undefined;
      if (byNif) return { line, ref, kind: 'COMPTE_MEME_NIF', candidateId: byNif, status: 'A_EXAMINER' };
      const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
      const byName = this.d.ctx.taxpayers.taxpayers.findOne((t) => t.status !== 'FUSIONNE' && norm(t.fullName) === norm(r.nom ?? ''));
      if (byName) return { line, ref, kind: 'COMPTE_NOM_PROCHE', candidateId: byName.id, status: 'A_EXAMINER' };
    } else if (r.type === 'OBJET') {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      const near = this.d.ctx.objects.objects.findOne((o) => o.category === r.categorie && o.commune === r.commune && Math.abs(o.lat - lat) < 0.0002 && Math.abs(o.lon - lon) < 0.0002);
      if (near) return { line, ref, kind: 'OBJET_MEME_EMPLACEMENT', candidateId: near.id, status: 'A_EXAMINER' };
    }
    return null;
  }

  /** Dépôt d'un lot : validation à blanc (rien n'est créé) et rapport ligne par ligne, doublons probables signalés. */
  upload(user: User, input: { source: ImportSource; format: 'CSV' | 'JSON'; content: string | Record<string, unknown>[] }): ImportBatch {
    authorize(user, 'fiscal:import.upload');
    let rows: Row[];
    if (input.format === 'CSV') {
      if (typeof input.content !== 'string') throw badRequest('INVALID_CONTENT', 'Contenu CSV attendu (texte).');
      rows = parseCsv(input.content);
    } else {
      const arr = typeof input.content === 'string' ? (JSON.parse(input.content) as unknown) : input.content;
      if (!Array.isArray(arr)) throw badRequest('INVALID_CONTENT', 'Tableau JSON attendu.');
      rows = arr.map((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k, v]) => (IMPORT_COLUMNS as readonly string[]).includes(k) && v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)])) as Row);
    }
    if (!rows.length || rows.length > 10_000) throw badRequest('INVALID_LOT', 'Un lot contient de 1 à 10 000 lignes.');
    const refs = new Set<string>();
    const lines: ImportLine[] = rows.map((r, i) => {
      const errors = this.validate(r);
      const key = `${r.type}|${r.ref_externe}`;
      if (r.ref_externe && refs.has(key)) errors.push('ref_externe en double dans le lot');
      refs.add(key);
      return { line: i + 2, type: r.type ?? '?', ref: r.ref_externe ?? '?', ok: errors.length === 0, errors };
    });
    const dedup = lines.filter((l) => l.ok).map((l) => this.dedupFor(l.line, rows[l.line - 2]!)).filter((x): x is DedupProposal => !!x);
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.type ?? '?'] = (byType[r.type ?? '?'] ?? 0) + 1;
    const b = this.batches.insert({
      id: this.ids.next('IMP'), source: input.source, sourceLabel: IMPORT_SOURCES[input.source], format: input.format,
      contentHash: sha256Hex(JSON.stringify(rows)), uploadedBy: user.id, uploadedAt: this.d.nowIso(), status: 'VALIDE_A_BLANC', rows,
      report: { total: rows.length, valid: lines.filter((l) => l.ok).length, invalid: lines.filter((l) => !l.ok).length, lines, byType },
      dedup, mapping: {}, history: [],
    });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.import.uploaded', resourceType: 'import_batch', resourceId: b.id, details: { source: b.source, rows: rows.length, invalid: b.report.invalid, duplicates: dedup.length, contentHash: b.contentHash } });
    return b;
  }

  /**
   * Arbitrage d'une ligne « à arbitrer » (ou correction d'un aiguillage) : régie DGIPK ou DGTK, motif ≥ 10 caractères,
   * personne distincte de celle qui a déposé le lot ; journalisé. L'objet repris porte ensuite sa régie responsable.
   */
  arbitrer(user: User, id: string, input: { ref: string; regie: Regie; motif: string }): ImportBatch {
    authorize(user, 'fiscal:import.commit');
    const b = this.get(id);
    if (b.status !== 'INTEGRE') throw conflict('IMPORT_BAD_STATE', 'Aiguillage arbitré après intégration du lot.');
    assertDistinctPerson(user.id, [b.uploadedBy], 'L’arbitrage est fait par une personne distincte de celle qui a déposé le lot.');
    if (input.motif.trim().length < 10) throw badRequest('MOTIF_REQUIRED', 'Motif de l’arbitrage : 10 caractères au moins.');
    const lines = b.report.lines.map((l) => ({ ...l }));
    const l = lines.find((x) => x.ref === input.ref);
    if (!l) throw notFound('IMPORT_LINE_NOT_FOUND', `Ligne inconnue : ${input.ref}`);
    const avant = l.regie ?? null;
    l.regie = input.regie; l.regieDecision = { by: user.id, at: this.d.nowIso(), motif: input.motif };
    const history = b.history.map((h) => (h.ref === input.ref ? { ...h, regie: input.regie } : h));
    if (l.createdId) { const o = this.d.ctx.objects.objects.get(l.createdId); if (o) this.d.ctx.objects.objects.update({ ...o, attributes: { ...o.attributes, regieResponsable: input.regie } }); }
    const compte = (x: Aiguillage) => lines.filter((k) => k.ok && k.regie === x).length;
    const out = this.batches.update({ ...b, report: { ...b.report, lines }, history, aiguillage: { DGIPK: compte('DGIPK'), DGTK: compte('DGTK'), A_ARBITRER: compte('A_ARBITRER'), statut: AIGUILLAGE_STATUT } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.import.aiguillage_arbitre', resourceType: 'import_batch', resourceId: id, details: { ref: input.ref, avant, apres: input.regie, motif: input.motif } });
    return out;
  }

  get(id: string): ImportBatch {
    const b = this.batches.get(id);
    if (!b) throw notFound('IMPORT_NOT_FOUND', `Lot inconnu : ${id}`);
    return b;
  }

  /**
   * Intégration du lot par une seconde personne : comptes et objets PROVISOIRES (vague 0), provenance « e-DGRK ».
   * Lignes en doublon probable : jamais créées d'office ; « même NIF » ⇒ proposition de fusion dans la file du registre
   * d'identité (double validation) ; les autres restent « à examiner ».
   */
  commit(user: User, id: string): ImportBatch {
    authorize(user, 'fiscal:import.commit');
    const b = this.get(id);
    if (b.status !== 'VALIDE_A_BLANC') throw conflict('IMPORT_BAD_STATE', `Lot au statut ${b.status}.`);
    assertDistinctPerson(user.id, [b.uploadedBy], 'L’intégration d’un lot est faite par une personne distincte de celle qui l’a déposé.');
    const at = this.d.nowIso();
    const origin = (ref: string) => ({ source: b.sourceLabel, batchId: b.id, externalRef: ref });
    const prov = (): DataProvenance => ({ source: b.source === 'E_DGRK' ? 'E_DGRK' : 'DONNEES_ADMINISTRATIVES', sourceLabel: b.sourceLabel, confidence: 'MOYENNE', recordedAt: at });
    const mapping: Record<string, string> = { ...b.mapping };
    const lines = b.report.lines.map((l) => ({ ...l }));
    const dedup = b.dedup.map((x) => ({ ...x }));
    const history: ImportedHistoryItem[] = [];
    const acces = this.d.ctx.ext['acces'] as { declareProof?(u: User, t: string, i: { type: 'NIF'; reference: string; note?: string }): unknown; proposeMerge?(u: User, i: { survivorId: string; absorbedId: string; evidence: string }): { id: string } } | undefined;
    const order = ['COMPTE', 'OBJET', 'HISTORIQUE'];
    const idx = lines.map((_, i) => i).sort((a, c) => order.indexOf(b.rows[a]!.type ?? '') - order.indexOf(b.rows[c]!.type ?? ''));
    for (const i of idx) {
      const l = lines[i]!;
      const r = b.rows[i]!;
      if (!l.ok) { l.outcome = 'REJETEE (erreurs de validation)'; continue; }
      const dup = dedup.find((x) => x.line === l.line);
      try {
        if (r.type === 'COMPTE') {
          if (dup && dup.kind !== 'COMPTE_MEME_NIF') { l.outcome = 'EN ATTENTE — doublon probable à examiner (aucune création, aucune fusion)'; continue; }
          const tp = this.d.ctx.taxpayers.register({ phone: dup ? '' : (r.telephone ?? ''), fullName: r.nom!, language: 'fr', situation: 'other', kind: r.forme === 'PM' ? 'PERSONNE_MORALE' : 'PERSONNE_PHYSIQUE' });
          this.d.ctx.taxpayers.setImportedFrom(tp.id, origin(r.ref_externe!));
          mapping[`COMPTE|${r.ref_externe}`] = tp.id;
          if (r.nif) acces?.declareProof?.(user, tp.id, { type: 'NIF', reference: r.nif, note: `NIF repris de ${b.sourceLabel} (statut probant : importé)` });
          l.createdId = tp.id;
          l.outcome = 'COMPTE CRÉÉ (N0, provenance ' + b.sourceLabel + ')';
          if (dup) {
            // Même NIF : le compte repris est créé sans téléphone et une FUSION est PROPOSÉE (vérification + approbation par deux autres personnes).
            try {
              const m = acces?.proposeMerge?.(user, { survivorId: dup.candidateId, absorbedId: tp.id, evidence: `Import ${b.sourceLabel} ${b.id} ligne ${l.line} : même NIF que le compte ${dup.candidateId}.` });
              if (m) { dup.status = 'PROPOSITION_DE_FUSION'; dup.mergeId = m.id; l.outcome += ` ; fusion proposée ${m.id}`; }
            } catch (e) {
              l.outcome += ` ; fusion non proposée (${e instanceof Error ? e.message : 'erreur'})`;
            }
          }
        } else if (r.type === 'OBJET') {
          if (dup) { l.outcome = 'EN ATTENTE — objet probablement déjà recensé (aucune création)'; continue; }
          const aig = aiguillerObjet(r.categorie as ObjectCategory);
          l.regie = aig.regie; l.regieMotif = aig.motif;
          const attributes: Record<string, unknown> = { ...(r.superficie_m2 ? { superficie_m2: r.superficie_m2 } : {}), ...(r.usage ? { usage: r.usage } : {}), ...(r.compte_ref ? { compteRepris: r.compte_ref } : {}), regieResponsable: aig.regie };
          const o = this.d.ctx.objects.create(user, {
            category: r.categorie as ObjectCategory, commune: r.commune!, quartier: r.quartier!, localityRank: Number(r.rang) as 1 | 2 | 3 | 4,
            lat: Number(r.lat), lon: Number(r.lon), attributes, ...(r.avenue ? { avenue: r.avenue } : {}),
          });
          const provenance = Object.fromEntries(Object.keys(attributes).map((k) => [k, prov()]));
          this.d.ctx.objects.setCensusMeta(o.id, { importedFrom: origin(r.ref_externe!), censusStage: 0, censusHistory: [{ at, from: null, to: 0, by: user.id, reason: `Import ${b.sourceLabel} ${b.id}` }], provenance });
          mapping[`OBJET|${r.ref_externe}`] = o.id;
          l.createdId = o.id;
          l.outcome = 'OBJET PROVISOIRE CRÉÉ (vague 0 — pré-pointé)';
          // Rattachement : une relation PROPOSÉE (instruction), jamais une propriété établie par l'import.
          const tpId = r.compte_ref ? mapping[`COMPTE|${r.compte_ref}`] : undefined;
          if (tpId && evaluate(user, 'fiscal:relation.declare', { taxpayerId: tpId, communes: [o.commune] })) {
            this.relations.declare(user, { taxpayerId: tpId, objectId: o.id, role: 'PROPRIETAIRE', from: at.slice(0, 10), proofs: [{ type: 'AUTRE', reference: `Fiche ${b.sourceLabel} ${r.ref_externe} (import ${b.id})` }] });
            l.outcome += ' ; rattachement proposé (à instruire)';
          } else if (r.compte_ref) l.outcome += ' ; rattachement à déclarer (compte repris ' + r.compte_ref + ')';
        } else if (r.type === 'HISTORIQUE') {
          const tpId = mapping[`COMPTE|${r.compte_ref}`] ?? null;
          const aigH = aiguillerRecette(r.recette ?? '', this.d.ctx.rules.list());
          l.regie = aigH.regie; l.regieMotif = aigH.motif;
          history.push({ regie: aigH.regie,
            ref: r.ref_externe!, taxpayerId: tpId, accountRef: r.compte_ref!, fiscalYear: r.exercice!, revenueLabel: r.recette!, amount: { amount: r.montant!, currency: r.devise! },
            paymentStatus: r.statut_paiement as 'PAYE' | 'IMPAYE', ...(r.quittance_ref ? { receiptRef: r.quittance_ref } : {}), probativeStatus: 'IMPORTE_SOURCE_REGIE',
            note: r.statut_paiement === 'IMPAYE' ? 'Impayé historique : information seulement ; reprise possible par le circuit de reprise d’arriérés (proposition motivée, validation).' : 'Paiement historique : information, sans quittance MOSOLO.',
          });
          l.outcome = 'HISTORIQUE REPRIS (information, aucune obligation créée)';
        }
      } catch (e) {
        l.ok = false;
        l.errors = [...l.errors, e instanceof Error ? e.message : String(e)];
        l.outcome = 'REJETEE à l’intégration';
      }
    }
    // Comptes : rattachés aux régies de leurs objets et recettes repris (jamais scindés).
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const r = b.rows[i]!;
      if (r.type !== 'COMPTE' || !l.ok) continue;
      const regies = [...new Set(b.rows.map((x, k) => (x.compte_ref === r.ref_externe ? lines[k]!.regie : undefined)).filter((x): x is Regie => x === 'DGIPK' || x === 'DGTK'))];
      l.regies = regies;
      l.regie = regies.length === 1 ? regies[0]! : regies.length > 1 ? regies[0]! : 'A_ARBITRER';
      l.regieMotif = regies.length ? `Compte rattaché à : ${regies.join(' et ')} (d'après ses objets et recettes)` : 'Aucun objet ni recette repris : régie à arbitrer';
    }
    const compte = (x: Aiguillage) => lines.filter((l) => l.ok && l.regie === x).length;
    const aiguillage = { DGIPK: compte('DGIPK'), DGTK: compte('DGTK'), A_ARBITRER: compte('A_ARBITRER'), statut: AIGUILLAGE_STATUT };
    const out = this.batches.update({ ...b, status: 'INTEGRE', committedBy: user.id, committedAt: at, report: { ...b.report, lines }, dedup, mapping, history, aiguillage });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.import.committed', resourceType: 'import_batch', resourceId: id, details: { uploadedBy: b.uploadedBy, created: lines.filter((l) => l.createdId).length, pending: dedup.filter((x) => x.status === 'A_EXAMINER').length, mergesProposed: dedup.filter((x) => x.status === 'PROPOSITION_DE_FUSION').length, history: history.length, aiguillage } });
    return out;
  }

  /** Décision humaine sur une ligne en doublon probable : rattacher à l'existant (sans écraser) ou créer un distinct. */
  decideDuplicate(user: User, id: string, line: number, input: { decision: 'RATTACHER' | 'CREER_DISTINCT'; reason: string }): ImportBatch {
    authorize(user, 'fiscal:import.commit');
    const b = this.get(id);
    if (b.status !== 'INTEGRE') throw conflict('IMPORT_BAD_STATE', 'Le lot doit être intégré avant la décision sur ses doublons.');
    const dup = b.dedup.find((x) => x.line === line);
    if (!dup || dup.status !== 'A_EXAMINER') throw conflict('NOTHING_TO_DECIDE', 'Aucun doublon à examiner sur cette ligne.');
    const r = b.rows[line - 2]!;
    const key = `${r.type}|${r.ref_externe}`;
    const mapping = { ...b.mapping };
    const lines = b.report.lines.map((l) => ({ ...l }));
    const l = lines.find((x) => x.line === line)!;
    const at = this.d.nowIso();
    if (input.decision === 'RATTACHER') {
      mapping[key] = dup.candidateId;
      if (r.type === 'COMPTE') this.d.ctx.taxpayers.setImportedFrom(dup.candidateId, { source: b.sourceLabel, batchId: b.id, externalRef: r.ref_externe! });
      l.outcome = `RATTACHÉE à ${dup.candidateId} (aucune donnée existante écrasée)`;
    } else {
      if (r.type === 'COMPTE') {
        const tp = this.d.ctx.taxpayers.register({ phone: '', fullName: r.nom!, language: 'fr', situation: 'other', kind: r.forme === 'PM' ? 'PERSONNE_MORALE' : 'PERSONNE_PHYSIQUE' });
        this.d.ctx.taxpayers.setImportedFrom(tp.id, { source: b.sourceLabel, batchId: b.id, externalRef: r.ref_externe! });
        mapping[key] = tp.id; l.createdId = tp.id;
      } else {
        const o: FiscalObject = this.d.ctx.objects.create(user, { category: r.categorie as ObjectCategory, commune: r.commune!, quartier: r.quartier!, localityRank: Number(r.rang) as 1 | 2 | 3 | 4, lat: Number(r.lat), lon: Number(r.lon), attributes: r.superficie_m2 ? { superficie_m2: r.superficie_m2 } : {} });
        this.d.ctx.objects.setCensusMeta(o.id, { importedFrom: { source: b.sourceLabel, batchId: b.id, externalRef: r.ref_externe! }, censusStage: 0, censusHistory: [{ at, from: null, to: 0, by: user.id, reason: `Import ${b.id} — doublon écarté : ${input.reason}` }] });
        mapping[key] = o.id; l.createdId = o.id;
      }
      l.outcome = `CRÉÉE DISTINCTE après examen (${l.createdId})`;
    }
    const dedup = b.dedup.map((x) => (x.line === line ? { ...x, status: input.decision === 'RATTACHER' ? 'RATTACHE' as const : 'CREE_DISTINCT' as const, decidedBy: user.id, reason: input.reason } : x));
    const out = this.batches.update({ ...b, mapping, dedup, report: { ...b.report, lines } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.import.duplicate_decided', resourceType: 'import_batch', resourceId: id, details: { line, decision: input.decision, candidateId: dup.candidateId, reason: input.reason } });
    return out;
  }

  /** Vue sans le contenu brut (minimisation). */
  view(b: ImportBatch) {
    const { rows: _rows, ...rest } = b;
    return { ...rest, notice: 'Données reprises : provenance « ' + b.sourceLabel + ' », aucune fusion silencieuse, aucune obligation créée par l’historique.' };
  }
}
