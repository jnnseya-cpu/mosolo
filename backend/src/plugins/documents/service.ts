/**
 * Gestion documentaire (spécification fonctionnelle, module 38 « Conserver pièces et preuves avec intégrité ») :
 *  - STOCKAGE CHIFFRÉ au repos (AES-256-GCM, clé dérivée de la clé serveur — fournisseur de clés matériel [À RACCORDER —
 *    convention requise] derrière l'interface `DocumentKeyProvider`), VERSIONS (chaque version conservée), EMPREINTES
 *    SHA-256 du contenu en clair ;
 *  - SCELLEMENT de chaque pièce : sceau HMAC (clé dérivée) sur l'empreinte et les métadonnées, inscrit au journal d'audit
 *    chaîné ; contrôle d'intégrité (déchiffrement, empreinte, sceau) avec alerte en cas d'écart ;
 *  - OCR ET CLASSIFICATION : texte natif lu par le serveur (texte, CSV, JSON, flux texte d'un PDF), texte d'une image lu
 *    par l'OCR du terminal (moteur embarqué dans l'application) ; classification PROPOSÉE par règles explicables (mots-clés
 *    reconnus, confiance), CONFIRMÉE par une personne ;
 *  - CONSERVATION par catégorie (durées au registre des seuils, 0 = non fixée ⇒ aucune purge) ; PURGE à échéance après
 *    aperçu, proposée puis approuvée par deux personnes, JAMAIS pour une preuve d'audit ni sous gel juridique : le contenu
 *    chiffré est effacé, l'empreinte et le sceau restent ;
 *  - EXPORTS FILIGRANÉS (demandeur, heure, référence, signature liée au contenu) et EXPIRABLES (durée du registre
 *    « socle.export_expiration_h », harmonisée avec les exports de données).
 */
import { checkUpload } from './controle-fichiers.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { canonicalJson, hmacSha256Hex, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { securityNum } from '../integrite/gouvernance/parametres-securite.js';
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_CODES, retentionParamId, type DocumentCategory } from './model.js';

export { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_CODES, PARAMETRES_DOCUMENTS, retentionParamId, type DocumentCategory } from './model.js';

const { always, ownTaxpayer, mandant } = GRANTS;
const STAFF = { R06: always, R07: always, R09: always, R11: always, R12: always, R17: always, R18: always, R20: always, R21: always, R22: always, R23: always, R24: always, R25: always };
definePolicy('documents:read', { ...STAFF, R30: ownTaxpayer, R31: mandant });
definePolicy('documents:upload', { ...STAFF, R10: always, R30: ownTaxpayer, R31: mandant });
definePolicy('documents:classify', { R06: always, R07: always, R11: always, R12: always, R25: always });
definePolicy('documents:export', { R06: always, R07: always, R11: always, R17: always, R20: always, R21: always, R22: always, R23: always, R24: always, R25: always, R30: ownTaxpayer, R31: mandant });
definePolicy('documents:hold', { R22: always, R24: always });
definePolicy('documents:purge.propose', { R25: always });
definePolicy('documents:purge.approve', { R22: always, R28: always });
// Liste des demandes de purge (27/09/2026) : le proposant (DPO) et les approbateurs (audit, sécurité) voient les
// demandes en cours, pour décider depuis la liste plutôt qu'en saisissant un identifiant.
definePolicy('documents:purge.read', { R25: always, R22: always, R28: always });
definePolicy('documents:integrity', { R22: always, R23: always, R26: always, R27: always, R28: always });

/** Fournisseur de clé de chiffrement au repos (interface) ; l'implémentation locale dérive la clé de la clé serveur. */
export interface DocumentKeyProvider { readonly name: string; readonly mode: 'LOCAL_DERIVEE' | 'MATERIEL'; key(): Buffer }
export class DerivedKeyProvider implements DocumentKeyProvider {
  readonly name = 'cle-derivee-serveur';
  readonly mode = 'LOCAL_DERIVEE' as const;
  private readonly k: Buffer;
  constructor(serverKey: string) { this.k = createHash('sha256').update(hmacSha256Hex(serverKey, 'mosolo:documents:chiffrement:v1')).digest(); }
  key(): Buffer { return this.k; }
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  cipher: { alg: 'AES-256-GCM'; iv: string; tag: string; data: string } | null;
  seal: string;
  ocr: { text: string; source: 'TEXTE_NATIF' | 'OCR_TERMINAL' | 'AUCUN'; chars: number };
  uploadedBy: string;
  uploadedAt: string;
}

export interface ClassificationProposal { category: DocumentCategory; confidence: 'ELEVEE' | 'MOYENNE' | 'FAIBLE'; matched: string[]; scores: Partial<Record<DocumentCategory, number>>; method: string }

export interface StoredDocument {
  id: string;
  title: string;
  category: DocumentCategory;
  classification: { status: 'PROPOSEE' | 'CONFIRMEE'; proposal: ClassificationProposal; confirmedBy?: string; confirmedAt?: string; motif?: string };
  link?: { module: string; ref: string };
  taxpayerId?: string;
  auditProof: boolean;
  legalHold?: { by: string; at: string; motif: string };
  status: 'ACTIF' | 'PURGE';
  currentVersion: number;
  createdBy: string;
  createdAt: string;
  purgedAt?: string;
}

export interface DocumentExport { id: string; documentId: string; version: number; token: string; requestedBy: string; requestedAt: string; motif: string; expiresAt: string; downloads: number; watermark: { text: string; signature: string } }
export interface PurgeRequest { id: string; documentIds: string[]; motif: string; proposedBy: string; proposedAt: string; status: 'PROPOSEE' | 'APPROUVEE' | 'REJETEE'; decision?: { by: string; at: string; motif: string }; purged?: string[]; refused?: { id: string; reason: string }[] }
export interface IntegrityRun { id: string; at: string; by: string; checked: number; ok: number; failures: { documentId: string; version: number; reason: string }[] }

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;

/** Texte natif : fichiers texte ; pour un PDF, chaînes des opérateurs de texte des flux non compressés. */
export function extractNativeText(contentType: string, buf: Buffer): string {
  if (TEXT_TYPES.test(contentType)) return buf.toString('utf8');
  if (contentType === 'application/pdf') {
    const raw = buf.toString('latin1');
    const parts = [...raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((m) => m[1]!.replace(/\\([()\\])/g, '$1'));
    for (const arr of raw.matchAll(/\[((?:\([^)]*\)\s*-?\d*\s*)+)\]\s*TJ/g)) parts.push([...arr[1]!.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(''));
    return parts.join(' ');
  }
  return '';
}

/** Classification explicable : mots-clés reconnus par catégorie ; la catégorie retenue reste une PROPOSITION. */
export function classify(text: string, contentType: string, title: string): ClassificationProposal {
  const hay = `${title}\n${text}`.toLowerCase();
  const scores: Partial<Record<DocumentCategory, number>> = {};
  const matchedBy: Partial<Record<DocumentCategory, string[]>> = {};
  for (const c of DOCUMENT_CATEGORY_CODES) {
    const found = DOCUMENT_CATEGORIES[c].keywords.filter((k) => hay.includes(k.toLowerCase()));
    if (found.length) { scores[c] = found.length; matchedBy[c] = found; }
  }
  const ranked = (Object.entries(scores) as [DocumentCategory, number][]).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    const photo = contentType.startsWith('image/');
    return { category: photo ? 'PHOTO_PREUVE' : 'AUTRE', confidence: 'FAIBLE', matched: [], scores, method: photo ? 'Image sans texte reconnu : photographie de preuve proposée.' : 'Aucun mot-clé reconnu.' };
  }
  const [best, n] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  return { category: best, confidence: n >= 3 && n > second ? 'ELEVEE' : n >= 2 && n > second ? 'MOYENNE' : 'FAIBLE', matched: matchedBy[best] ?? [], scores, method: 'Mots-clés par catégorie (règles publiées), à confirmer par une personne.' };
}

export class DocumentService {
  readonly documents = new InMemoryRepository<StoredDocument>();
  readonly versions = new InMemoryRepository<DocumentVersion>();
  readonly exports = new InMemoryRepository<DocumentExport>();
  readonly purges = new InMemoryRepository<PurgeRequest>();
  readonly integrityRuns = new InMemoryRepository<IntegrityRun>();
  private readonly ids = new IdGenerator();
  private readonly sealKey: string;
  private readonly watermarkKey: string;
  keys: DocumentKeyProvider;

  constructor(private readonly ctx: AppContext) {
    this.sealKey = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:documents:sceau:v1');
    this.watermarkKey = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:documents:filigrane:v1');
    this.keys = new DerivedKeyProvider(ctx.secrets.auditHmacKey);
  }

  private now() { return this.ctx.clock.now().toISOString(); }

  private encrypt(buf: Buffer): NonNullable<DocumentVersion['cipher']> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.key(), iv);
    const data = Buffer.concat([c.update(buf), c.final()]);
    return { alg: 'AES-256-GCM', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  private decrypt(v: DocumentVersion): Buffer {
    if (!v.cipher) throw conflict('DOCUMENT_PURGED', 'Contenu purgé à l’échéance de conservation : seules l’empreinte et le sceau restent.');
    const d = createDecipheriv('aes-256-gcm', this.keys.key(), Buffer.from(v.cipher.iv, 'base64'));
    d.setAuthTag(Buffer.from(v.cipher.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(v.cipher.data, 'base64')), d.final()]);
  }
  private sealOf(v: Pick<DocumentVersion, 'documentId' | 'version' | 'sha256' | 'size' | 'contentType' | 'uploadedAt' | 'uploadedBy'>): string {
    return hmacSha256Hex(this.sealKey, canonicalJson({ documentId: v.documentId, version: v.version, sha256: v.sha256, size: v.size, contentType: v.contentType, uploadedAt: v.uploadedAt, uploadedBy: v.uploadedBy }));
  }

  get(id: string): StoredDocument {
    const d = this.documents.get(id);
    if (!d) throw notFound('DOCUMENT_NOT_FOUND', `Document inconnu : ${id}`);
    return d;
  }
  private access(u: User, action: 'documents:read' | 'documents:upload' | 'documents:export', d: StoredDocument) {
    authorize(u, action, d.taxpayerId ? { taxpayerId: d.taxpayerId } : {});
    if (u.roles.every((r) => r === 'R30' || r === 'R31') && !d.taxpayerId) throw forbidden('FORBIDDEN', 'Document hors de votre compte.');
  }

  private newVersion(u: User, documentId: string, version: number, input: { fileName: string; contentType: string; contentBase64: string; ocrText?: string }): DocumentVersion {
    // Type admis vérifié par signature, nom assaini, base64 strict (voir controle-fichiers.ts).
    const checked = checkUpload(input);
    const buf = checked.buf;
    input = { ...input, fileName: checked.fileName, contentType: checked.contentType };
    const native = extractNativeText(input.contentType, buf).slice(0, 200_000);
    const ocr: DocumentVersion['ocr'] = native.trim() ? { text: native, source: 'TEXTE_NATIF', chars: native.length }
      : input.ocrText?.trim() ? { text: input.ocrText.slice(0, 200_000), source: 'OCR_TERMINAL', chars: input.ocrText.length } : { text: '', source: 'AUCUN', chars: 0 };
    const meta = { documentId, version, sha256: sha256Hex(buf), size: buf.length, contentType: input.contentType, uploadedAt: this.now(), uploadedBy: u.id };
    const v = this.versions.insert({ id: this.ids.next('DOCV', 8), ...meta, fileName: input.fileName, cipher: this.encrypt(buf), seal: this.sealOf(meta), ocr });
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.sealed', resourceType: 'document', resourceId: documentId, details: { version, sha256: v.sha256, seal: v.seal, size: v.size, contentType: v.contentType, ocrSource: ocr.source } });
    return v;
  }

  upload(u: User, input: { title: string; fileName: string; contentType: string; contentBase64: string; ocrText?: string; category?: DocumentCategory; link?: { module: string; ref: string }; taxpayerId?: string }) {
    authorize(u, 'documents:upload', input.taxpayerId ? { taxpayerId: input.taxpayerId } : {});
    if ((u.roles.includes('R30') || u.roles.includes('R31')) && !input.taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Un contribuable dépose une pièce sur son propre compte.');
    const id = this.ids.next('DOC', 8);
    const v = this.newVersion(u, id, 1, input);
    // Doublon : même contenu déjà déposé dans le MÊME périmètre (même contribuable, ou pièces internes) — signalé,
    // jamais refusé (une même pièce peut justifier deux dossiers) ; aucun document d'un autre périmètre n'est révélé.
    const dup = this.versions.findOne((x) => x.sha256 === v.sha256 && x.documentId !== id && (this.documents.get(x.documentId)?.taxpayerId ?? null) === (input.taxpayerId ?? null) && this.documents.get(x.documentId)?.status !== 'PURGE');
    const proposal = classify(v.ocr.text, input.contentType, input.title);
    const category = input.category ?? proposal.category;
    const d = this.documents.insert({
      id, title: input.title.trim(), category, classification: input.category ? { status: 'CONFIRMEE', proposal, confirmedBy: u.id, confirmedAt: this.now(), motif: 'Catégorie choisie au dépôt' } : { status: 'PROPOSEE', proposal },
      ...(input.link ? { link: input.link } : {}), ...(input.taxpayerId ? { taxpayerId: input.taxpayerId } : {}), auditProof: DOCUMENT_CATEGORIES[category].auditProof,
      status: 'ACTIF', currentVersion: 1, createdBy: u.id, createdAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.uploaded', resourceType: 'document', resourceId: id, details: { category, classification: d.classification.status, proposed: proposal.category, confidence: proposal.confidence, link: input.link ?? null, ...(dup ? { duplicateOf: dup.documentId } : {}) } });
    return { ...this.view(d), ...(dup ? { doublon: { documentId: dup.documentId, version: dup.version, detail: 'Contenu identique déjà déposé : vérifiez qu’il ne s’agit pas d’un double dépôt.' } } : {}) };
  }

  addVersion(u: User, id: string, input: { fileName: string; contentType: string; contentBase64: string; ocrText?: string }) {
    const d = this.get(id);
    this.access(u, 'documents:upload', d);
    if (d.status === 'PURGE') throw conflict('DOCUMENT_PURGED', 'Document purgé : aucune nouvelle version.');
    const v = this.newVersion(u, id, d.currentVersion + 1, input);
    const out = this.documents.update({ ...d, currentVersion: v.version });
    return this.view(out);
  }

  confirmClassification(u: User, id: string, input: { category: DocumentCategory; motif: string }) {
    authorize(u, 'documents:classify');
    const d = this.get(id);
    if (input.motif.trim().length < 3) throw badRequest('MOTIF_REQUIRED', 'Motif requis.');
    const auditProof = d.auditProof || DOCUMENT_CATEGORIES[input.category].auditProof;
    const out = this.documents.update({ ...d, category: input.category, auditProof, classification: { ...d.classification, status: 'CONFIRMEE', confirmedBy: u.id, confirmedAt: this.now(), motif: input.motif.trim() } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.classification.confirmed', resourceType: 'document', resourceId: id, details: { proposed: d.classification.proposal.category, confirmed: input.category, motif: input.motif.trim() } });
    return this.view(out);
  }

  setLegalHold(u: User, id: string, motif: string) {
    authorize(u, 'documents:hold');
    const d = this.get(id);
    const out = this.documents.update({ ...d, legalHold: { by: u.id, at: this.now(), motif } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.legal_hold', resourceType: 'document', resourceId: id, details: { motif } });
    return this.view(out);
  }

  view(d: StoredDocument) {
    const versions = this.versions.find((v) => v.documentId === d.id).sort((a, b) => a.version - b.version)
      .map((v) => ({ id: v.id, version: v.version, fileName: v.fileName, contentType: v.contentType, size: v.size, sha256: v.sha256, seal: v.seal, encrypted: !!v.cipher, ocr: { source: v.ocr.source, chars: v.ocr.chars, excerpt: v.ocr.text.slice(0, 280) }, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt }));
    return { ...d, categoryLabel: DOCUMENT_CATEGORIES[d.category].label, retention: this.retention(d), versions };
  }

  list(u: User, filter: { category?: string; taxpayerId?: string; module?: string; ref?: string } = {}) {
    authorize(u, 'documents:read', filter.taxpayerId ? { taxpayerId: filter.taxpayerId } : u.taxpayerId ? { taxpayerId: u.taxpayerId } : {});
    const own = u.roles.every((r) => r === 'R30' || r === 'R31');
    return this.documents.find((d) => (!filter.category || d.category === filter.category) && (!filter.taxpayerId || d.taxpayerId === filter.taxpayerId)
      && (!filter.module || d.link?.module === filter.module) && (!filter.ref || d.link?.ref === filter.ref)
      && (!own || (!!d.taxpayerId && (d.taxpayerId === u.taxpayerId || (u.mandants ?? []).includes(d.taxpayerId)))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((d) => this.view(d));
  }

  /** Lecture du contenu (déchiffré, empreinte contrôlée) — consultation interne tracée. */
  content(u: User, id: string, version?: number) {
    const d = this.get(id);
    this.access(u, 'documents:read', d);
    const v = this.versions.findOne((x) => x.documentId === id && x.version === (version ?? d.currentVersion));
    if (!v) throw notFound('VERSION_NOT_FOUND', `Version inconnue : ${version}`);
    const buf = this.decrypt(v);
    if (sha256Hex(buf) !== v.sha256) throw conflict('INTEGRITY_FAILURE', 'Empreinte du contenu différente de l’empreinte scellée : lecture refusée, alerte levée.');
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.read', resourceType: 'document', resourceId: id, details: { version: v.version } });
    return { documentId: id, version: v.version, fileName: v.fileName, contentType: v.contentType, sha256: v.sha256, contentBase64: buf.toString('base64') };
  }

  private retention(d: StoredDocument): { days: number; until: string | null; status: 'PREUVE_AUDIT' | 'GEL_JURIDIQUE' | 'DUREE_NON_FIXEE' | 'EN_COURS' | 'ECHUE' | 'PURGE'; detail: string } {
    if (d.status === 'PURGE') return { days: 0, until: null, status: 'PURGE', detail: `Purgé le ${d.purgedAt ?? '—'} : empreinte et sceau conservés.` };
    if (d.auditProof) return { days: 0, until: null, status: 'PREUVE_AUDIT', detail: 'Preuve d’audit : jamais purgée.' };
    if (d.legalHold) return { days: 0, until: null, status: 'GEL_JURIDIQUE', detail: `Gel juridique : ${d.legalHold.motif}` };
    const gov = this.ctx.ext['integrite-gouvernance'] as { value?: (id: string) => number | boolean } | undefined;
    let days: number;
    try { const v = gov?.value?.(retentionParamId(d.category)); days = typeof v === 'number' && v > 0 ? v : 0; } catch { days = 0; }
    if (!days) return { days: 0, until: null, status: 'DUREE_NON_FIXEE', detail: 'Durée de conservation non fixée (registre des seuils) : aucune purge.' };
    const until = new Date(Date.parse(d.createdAt) + days * 86_400_000).toISOString();
    return { days, until, status: until <= this.now() ? 'ECHUE' : 'EN_COURS', detail: `Conservation ${days} jours (registre des seuils).` };
  }

  purgePreview(u: User) {
    authorize(u, 'documents:purge.propose');
    return this.documents.all().map((d) => ({ id: d.id, title: d.title, category: d.category, retention: this.retention(d) })).filter((x) => x.retention.status === 'ECHUE');
  }

  proposePurge(u: User, input: { documentIds: string[]; motif: string }): PurgeRequest {
    authorize(u, 'documents:purge.propose');
    const bad = input.documentIds.map((id) => ({ id, r: this.retention(this.get(id)) })).filter((x) => x.r.status !== 'ECHUE');
    if (bad.length) throw unprocessable('PURGE_NOT_ELIGIBLE', `Non purgeable(s) : ${bad.map((b) => `${b.id} (${b.r.status})`).join(', ')}.`);
    const r = this.purges.insert({ id: this.ids.next('PURG', 6), documentIds: input.documentIds, motif: input.motif, proposedBy: u.id, proposedAt: this.now(), status: 'PROPOSEE' });
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.purge.proposed', resourceType: 'document_purge', resourceId: r.id, details: { documentIds: r.documentIds, motif: r.motif } });
    return r;
  }

  /** Demandes de purge, les plus récentes d'abord (lecture seule ; la décision reste à deux personnes). */
  listPurges(u: User): PurgeRequest[] {
    authorize(u, 'documents:purge.read');
    return this.purges.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  decidePurge(u: User, id: string, input: { approve: boolean; motif: string }): PurgeRequest {
    authorize(u, 'documents:purge.approve');
    const r = this.purges.get(id);
    if (!r) throw notFound('PURGE_NOT_FOUND', `Demande de purge inconnue : ${id}`);
    if (r.status !== 'PROPOSEE') throw conflict('PURGE_DECIDED', `Demande au statut ${r.status}.`);
    assertDistinctPerson(u.id, [r.proposedBy], 'La purge est approuvée par une personne distincte de celle qui l’a proposée.');
    const at = this.now();
    const purged: string[] = [];
    const refused: { id: string; reason: string }[] = [];
    if (input.approve) {
      for (const docId of r.documentIds) {
        const d = this.get(docId);
        const ret = this.retention(d);
        if (ret.status !== 'ECHUE') { refused.push({ id: docId, reason: ret.detail }); continue; }
        for (const v of this.versions.find((x) => x.documentId === docId)) this.versions.update({ ...v, cipher: null, ocr: { text: '', source: v.ocr.source, chars: 0 } });
        this.documents.update({ ...d, status: 'PURGE', purgedAt: at });
        purged.push(docId);
      }
    }
    const out = this.purges.update({ ...r, status: input.approve ? 'APPROUVEE' : 'REJETEE', decision: { by: u.id, at, motif: input.motif }, ...(input.approve ? { purged, refused } : {}) });
    this.ctx.audit.append({ actor: actorOf(u), action: input.approve ? 'document.purge.executed' : 'document.purge.rejected', resourceType: 'document_purge', resourceId: id, details: { proposedBy: r.proposedBy, purged, refused, motif: input.motif } });
    return out;
  }

  /** Export filigrané et expirable : filigrane (demandeur, heure, référence) signé et lié à l'empreinte du contenu. */
  requestExport(u: User, id: string, motif: string) {
    const d = this.get(id);
    this.access(u, 'documents:export', d);
    if (d.status === 'PURGE') throw conflict('DOCUMENT_PURGED', 'Document purgé.');
    if (motif.trim().length < 5) throw badRequest('MOTIF_REQUIRED', 'Motif de l’export requis (5 caractères au moins).');
    const v = this.versions.findOne((x) => x.documentId === id && x.version === d.currentVersion)!;
    const at = this.now();
    const expiresAt = new Date(Date.parse(at) + securityNum(this.ctx, 'socle.export_expiration_h') * 3_600_000).toISOString();
    const exportId = this.ids.next('DEXP', 6);
    const text = `COPIE EXPORTÉE — ${u.name} (${u.id}) — ${at} — réf. ${exportId} — document ${id} v${v.version} — expire le ${expiresAt}`;
    const token = randomBytes(24).toString('base64url');
    const e = this.exports.insert({ id: exportId, documentId: id, version: v.version, token: sha256Hex(token), requestedBy: u.id, requestedAt: at, motif: motif.trim(), expiresAt, downloads: 0, watermark: { text, signature: hmacSha256Hex(this.watermarkKey, canonicalJson({ text, sha256: v.sha256 })) } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.export.issued', resourceType: 'document', resourceId: id, details: { exportId, version: v.version, expiresAt, motif: e.motif } });
    return { exportId, token, expiresAt, watermark: e.watermark.text };
  }

  /** Remise de l'export au seul demandeur, avant expiration ; contenu textuel filigrané en tête, sinon filigrane joint signé. */
  fetchExport(u: User, token: string) {
    const e = this.exports.findOne((x) => x.token === sha256Hex(token));
    if (!e) throw notFound('EXPORT_NOT_FOUND', 'Export inconnu.');
    if (e.requestedBy !== u.id) throw forbidden('EXPORT_NOT_YOURS', 'Export remis au seul demandeur.');
    if (e.expiresAt <= this.now()) throw conflict('EXPORT_EXPIRED', 'Export expiré : une nouvelle demande est nécessaire.');
    const v = this.versions.findOne((x) => x.documentId === e.documentId && x.version === e.version)!;
    const buf = this.decrypt(v);
    this.exports.update({ ...e, downloads: e.downloads + 1 });
    this.ctx.audit.append({ actor: actorOf(u), action: 'document.export.downloaded', resourceType: 'document', resourceId: e.documentId, details: { exportId: e.id } });
    const textual = TEXT_TYPES.test(v.contentType);
    const content = textual ? Buffer.concat([Buffer.from(`${e.watermark.text}\n\n`, 'utf8'), buf]) : buf;
    return { exportId: e.id, fileName: v.fileName, contentType: v.contentType, sha256: v.sha256, watermark: e.watermark, watermarkEmbedded: textual, expiresAt: e.expiresAt, contentBase64: content.toString('base64') };
  }

  /** Vérification du filigrane présenté (lié au contenu : un filigrane détaché ou modifié ne vérifie plus). */
  verifyWatermark(input: { text: string; signature: string; sha256: string }): boolean {
    return hmacSha256Hex(this.watermarkKey, canonicalJson({ text: input.text, sha256: input.sha256 })) === input.signature;
  }

  /** Contrôle d'intégrité : déchiffrement, empreinte, sceau ; alerte à chaque écart. */
  verifyIntegrity(by: User | 'systeme'): IntegrityRun {
    if (by !== 'systeme') authorize(by, 'documents:integrity');
    const failures: IntegrityRun['failures'] = [];
    let checked = 0;
    for (const v of this.versions.all()) {
      if (!v.cipher) continue;
      checked++;
      let reason: string | null = null;
      if (this.sealOf(v) !== v.seal) reason = 'Sceau invalide (métadonnées modifiées).';
      else {
        try { if (sha256Hex(this.decrypt(v)) !== v.sha256) reason = 'Empreinte du contenu différente.'; } catch { reason = 'Déchiffrement impossible (contenu ou étiquette d’authenticité altérés).'; }
      }
      if (reason) {
        failures.push({ documentId: v.documentId, version: v.version, reason });
        this.ctx.alerts.raiseOnce(`DOC_INTEGRITE:${v.id}:${v.seal.slice(0, 12)}`, { type: 'DOCUMENT_INTEGRITE', severity: 'HIGH', source: 'documents', detail: `Document ${v.documentId} v${v.version} : ${reason}` });
      }
    }
    const run = this.integrityRuns.insert({ id: this.ids.next('DINT', 6), at: this.now(), by: by === 'systeme' ? 'systeme' : by.id, checked, ok: checked - failures.length, failures });
    this.ctx.audit.append({ actor: by === 'systeme' ? { kind: 'system', id: 'documents' } : actorOf(by), action: 'document.integrity.verified', resourceType: 'documents', resourceId: run.id, details: { checked, failures: failures.length } });
    return run;
  }

  /** Indicateurs du module 38 : volume stocké, intégrité vérifiée. */
  indicators() {
    const docs = this.documents.all();
    const versions = this.versions.all();
    const byCategory: Record<string, { documents: number; bytes: number }> = {};
    for (const d of docs) {
      const bytes = versions.filter((v) => v.documentId === d.id && !!v.cipher).reduce((s, v) => s + v.size, 0);
      const e = (byCategory[d.category] ??= { documents: 0, bytes: 0 });
      e.documents++; e.bytes += bytes;
    }
    const runs = this.integrityRuns.all();
    const last = runs[runs.length - 1];
    return {
      volume: { documents: docs.length, actifs: docs.filter((d) => d.status === 'ACTIF').length, purges: docs.filter((d) => d.status === 'PURGE').length, versions: versions.length, octets: versions.filter((v) => !!v.cipher).reduce((s, v) => s + v.size, 0), byCategory },
      classification: { proposees: docs.filter((d) => d.classification.status === 'PROPOSEE').length, confirmees: docs.filter((d) => d.classification.status === 'CONFIRMEE').length },
      integrite: last ? { statut: 'MESURE' as const, derniereVerification: last.at, verifiees: last.checked, conformes: last.ok, ecarts: last.failures.length } : { statut: 'NON_MESURE' as const, motif: 'Aucun contrôle d’intégrité exécuté.' },
      chiffrement: { algorithme: 'AES-256-GCM', fournisseurCle: this.keys.name, mode: this.keys.mode, raccordement: this.keys.mode === 'LOCAL_DERIVEE' ? '[À RACCORDER — convention requise] module matériel de sécurité (HSM) ; clé dérivée de la clé serveur en attendant.' : 'Module matériel raccordé.' },
    };
  }
}
