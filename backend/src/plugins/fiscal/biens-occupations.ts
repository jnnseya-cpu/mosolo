/**
 * Liaison des biens et occupations (spécification « Property and Occupancy Linkage » v1.0 du 28/09/2026, décision du
 * maître d'ouvrage du même jour) — construite SUR le module 7 (relations contribuable–objet), sans système parallèle :
 *
 *  - une personne = un compte (compte unique) ; les biens (parcelle → bâtiment → unité, « MAIN » pour une maison
 *    individuelle) sont les objets fiscaux existants ; chaque REVENDICATION porte une relation du module 7 (même
 *    personne, même cible) dont elle pilote le cycle d'états (§ 6) ;
 *  - rapprochement (§ 5) : identifiant officiel dans son espace de noms, puis adresse normalisée + bâtiment/unité, puis
 *    proximité GPS + composantes d'adresse ; le nom, le téléphone, l'IP ou le GPS seul ne proposent ni ne vérifient
 *    jamais rien ; aucun score ne vérifie ;
 *  - trois circuits distincts : doublons de comptes (module accès), doublons de biens (dossier FUSION_BIENS revu,
 *    transactionnel, alias conservés, bloqué si des identifiants officiels vérifiés divergent) et vérification des
 *    relations (dossier VERIFICATION décidé par un réviseur habilité) ;
 *  - confidentialité (§ 8) : aucune réponse à un revendicateur ne révèle le nom, le téléphone, l'identifiant de compte
 *    ou les pièces de l'autre partie ; après vérification, seul le nécessaire au service est montré ;
 *  - chaque mutation : clé d'idempotence (routes), contrôle de version optimiste, événement d'audit avec empreintes
 *    avant / après.
 */
import { randomBytes } from 'node:crypto';
import type { User } from '../../core/auth.js';
import { isDemoMode } from '../../core/auth.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { maskPhone } from '../../modules/identity/service.js';
import { lifecycleOf, recordStatusOf, type FiscalObject } from '../../modules/objects/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import { CLAIM_ROLES, CONFIG_BIENS, MENTION_JURIDIQUE, type ClaimRole } from './biens-config.js';
import { actorOf, parentIdOf, type FiscalDeps } from './common.js';
import { OCCUPANCY_ROLES, type RelationRole, type RelationService, type Relationship } from './relations.js';

// ─────────────────────────────── Modèle ───────────────────────────────

export const CLAIM_STATUSES = [
  'DRAFT', 'SUBMITTED', 'MATCHED_PENDING_VERIFICATION', 'NEEDS_EVIDENCE', 'VERIFIED', 'DISPUTED', 'UNDER_REVIEW', 'REJECTED', 'SUPERSEDED', 'ENDED',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  DRAFT: 'Brouillon', SUBMITTED: 'Soumise', MATCHED_PENDING_VERIFICATION: 'Rapprochée — en attente de vérification', NEEDS_EVIDENCE: 'Preuve demandée',
  VERIFIED: 'Vérifiée', DISPUTED: 'Contestée', UNDER_REVIEW: 'En revue', REJECTED: 'Rejetée', SUPERSEDED: 'Remplacée', ENDED: 'Terminée',
};
/** Transitions permises (§ 6) ; toute autre transition est refusée (409). */
const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['MATCHED_PENDING_VERIFICATION', 'NEEDS_EVIDENCE', 'DISPUTED', 'VERIFIED', 'REJECTED'],
  MATCHED_PENDING_VERIFICATION: ['VERIFIED', 'NEEDS_EVIDENCE', 'DISPUTED', 'REJECTED'],
  NEEDS_EVIDENCE: ['MATCHED_PENDING_VERIFICATION', 'SUBMITTED', 'DISPUTED', 'REJECTED'],
  VERIFIED: ['DISPUTED', 'ENDED'],
  DISPUTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['VERIFIED', 'REJECTED', 'SUPERSEDED'],
  REJECTED: ['UNDER_REVIEW'],
  SUPERSEDED: [],
  ENDED: [],
};
/** Correspondance avec les états du module 7 (les anciens états restent disponibles et synchronisés). */
const MODULE7_STATUS: Record<ClaimStatus, Relationship['status']> = {
  DRAFT: 'PROPOSEE', SUBMITTED: 'PROPOSEE', MATCHED_PENDING_VERIFICATION: 'PROPOSEE', NEEDS_EVIDENCE: 'PROPOSEE', VERIFIED: 'VALIDEE',
  DISPUTED: 'CONTESTEE', UNDER_REVIEW: 'CONTESTEE', REJECTED: 'REJETEE', SUPERSEDED: 'REJETEE', ENDED: 'CLOSE',
};
/** État de la revendication déduit d'une relation du module 7 (relations anciennes, sans revendication). */
export function claimStatusOfRelation(r: Relationship): ClaimStatus {
  return ({ PROPOSEE: 'MATCHED_PENDING_VERIFICATION', VALIDEE: 'VERIFIED', CONTESTEE: 'DISPUTED', REJETEE: 'REJECTED', CLOSE: 'ENDED' } as const)[r.status];
}

export type TargetType = 'PLOT' | 'BUILDING' | 'UNIT';
const TARGET_CATEGORY: Record<TargetType, FiscalObject['category']> = { PLOT: 'PARCELLE', BUILDING: 'BATIMENT', UNIT: 'UNITE_LOCATIVE' };
const CATEGORY_TARGET: Partial<Record<FiscalObject['category'], TargetType>> = { PARCELLE: 'PLOT', BATIMENT: 'BUILDING', UNITE_LOCATIVE: 'UNIT', ACTIVITE: 'UNIT' };

export interface ClaimAddress {
  commune: string; quartier?: string; avenue?: string; number?: string; building_label?: string; unit_label?: string; floor?: string;
  official_ref?: string; official_namespace?: string; lat?: number; lon?: number;
}

export interface PropertyClaim {
  id: string;
  accountId: string;
  role: ClaimRole;
  share?: string;
  targetType: TargetType;
  targetId?: string;
  /** Cible d'origine (enregistrement provisoire) avant une fusion revue : toujours traçable. */
  originalTargetId?: string;
  status: ClaimStatus;
  validFrom?: string;
  validTo?: string;
  useType: 'RESIDENTIAL' | 'COMMERCIAL' | 'MIXED';
  jointTenancy?: boolean;
  address?: ClaimAddress;
  relationId?: string;
  origin: 'INSCRIPTION' | 'ESPACE' | 'DECLARATION_PROPRIETAIRE' | 'INVITATION' | 'ENROLEMENT' | 'MODULE';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: { at: string; by: string; from: ClaimStatus | null; to: ClaimStatus; reason?: string }[];
}

export interface ClaimEvidence {
  id: string; claimId: string; evidenceType: string; objectKey: string; sha256: string; submittedBy: string; submittedAt: string;
  reviewStatus: 'EN_ATTENTE' | 'ACCEPTEE' | 'REFUSEE'; retentionClass: string; documentId?: string; label?: string;
  gps?: { lat: number; lon: number; accuracyM?: number };
}

export interface PropertyInvitation {
  id: string; claimId: string; inviteRole?: ClaimRole; targetUnitId?: string; deliveryChannel: 'SMS' | 'EMAIL' | 'COURRIER';
  contactHash: string; contactMasked: string; tokenHash: string; expiresAt: string; createdAt: string;
  status: 'EN_ATTENTE' | 'ACCEPTEE' | 'REFUSEE' | 'BIEN_ERRONE_SIGNALE' | 'EXPIREE';
  respondedAt?: string; responderAccountId?: string; resultClaimId?: string;
}

export interface MatchCandidate { id: string; claimId: string; targetId: string; targetType: TargetType; unitToCreate?: string; signals: string[]; score: number; createdAt: string; expiresAt: string }

export type ReviewReason = 'VERIFICATION' | 'CONTESTATION' | 'BIEN_ERRONE_SIGNALE' | 'CHEVAUCHEMENT_LOCATION_EXCLUSIVE' | 'FUSION_BIENS' | 'APPEL';
export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  VERIFICATION: 'Vérification d’une revendication', CONTESTATION: 'Contestation', BIEN_ERRONE_SIGNALE: 'Mauvais bien signalé',
  CHEVAUCHEMENT_LOCATION_EXCLUSIVE: 'Locations exclusives qui se chevauchent', FUSION_BIENS: 'Doublon de biens (fusion à revoir)', APPEL: 'Appel d’un rejet',
};

export interface ReviewCase {
  id: string;
  reasonCode: ReviewReason;
  claimId?: string;
  relatedClaimIds: string[];
  commune: string;
  status: 'OUVERT' | 'EN_COURS' | 'ESCALADE' | 'DECIDE';
  assigneeId?: string;
  fieldAgentId?: string;
  fieldUntil?: string;
  merge?: { recordIds: [string, string]; signals: string[]; applied?: { canonicalId: string; aliasId: string; remappedClaims: string[]; remappedRelations: string[]; remappedChildren: string[]; at: string } };
  decision?: { decision: string; reason: string; by: string; at: string; validFrom?: string; validTo?: string; canonicalTargetId?: string; claimId?: string };
  openedBy: string;
  openedAt: string;
  note?: string;
  version: number;
}

export interface AuditRef { status?: string; targetId?: string | null; version?: number; [k: string]: unknown }

// ─────────────────────────────── Normalisation et distance ───────────────────────────────

/** Normalisation d'une composante d'adresse : minuscules, sans accents ni ponctuation, mots-outils retirés. */
export function normAddr(s: string | undefined): string {
  if (!s) return '';
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(avenue|av|rue|boulevard|bd|n|no|numero|num|parcelle|batiment|bat|unite|appartement|appt|porte|quartier|q)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const ROLE_TO_RELATION: Record<ClaimRole, RelationRole> = {
  OWNER: 'PROPRIETAIRE', TENANT: 'LOCATAIRE', SUBTENANT: 'SOUS_LOCATAIRE', OCCUPANT: 'OCCUPANT', MANAGER: 'GESTIONNAIRE', OPERATOR: 'EXPLOITANT',
};
/** Alias français acceptés à la saisie (même vocabulaire que le module 7). */
export const ROLE_ALIASES: Record<string, ClaimRole> = {
  PROPRIETAIRE: 'OWNER', COPROPRIETAIRE: 'OWNER', LOCATAIRE: 'TENANT', SOUS_LOCATAIRE: 'SUBTENANT', OCCUPANT: 'OCCUPANT',
  GESTIONNAIRE: 'MANAGER', MANDATAIRE: 'MANAGER', EXPLOITANT: 'OPERATOR',
};
export function toClaimRole(r: string): ClaimRole {
  const up = r.trim().toUpperCase();
  if ((CLAIM_ROLES as readonly string[]).includes(up)) return up as ClaimRole;
  const alias = ROLE_ALIASES[up];
  if (!alias) throw badRequest('UNKNOWN_ROLE', `Rôle inconnu : ${r}`);
  return alias;
}
const EXCLUSIVE_TENANCY: ClaimRole[] = ['TENANT'];
const OWNERSHIP_CLAIMS: ClaimRole[] = ['OWNER', 'MANAGER'];

const OPEN_STATUSES: ClaimStatus[] = ['DRAFT', 'SUBMITTED', 'MATCHED_PENDING_VERIFICATION', 'NEEDS_EVIDENCE', 'DISPUTED', 'UNDER_REVIEW'];

// ─────────────────────────────── Service ───────────────────────────────

export class BiensOccupationsService {
  readonly claims = new InMemoryRepository<PropertyClaim>();
  /** Pièces : ajout seul, jamais écrasées ni supprimées ; aucune adresse publique. */
  readonly evidence = new InMemoryAppendOnlyRepository<ClaimEvidence>();
  readonly invitations = new InMemoryRepository<PropertyInvitation>();
  /** Candidats : usage interne seulement (jamais renvoyés avec leurs signaux ni leur score). */
  readonly candidates = new InMemoryRepository<MatchCandidate>();
  readonly cases = new InMemoryRepository<ReviewCase>();
  private readonly ids = new IdGenerator();
  /** Jetons d'invitation du bac à sable (démonstration sans fournisseur SMS) : jamais hors démonstration. */
  readonly sandboxTokens = new Map<string, string>();

  constructor(private readonly d: FiscalDeps, private readonly relations: RelationService) {}

  private now(): string { return this.d.nowIso(); }
  private get ctx() { return this.d.ctx; }

  // ─────────── Audit (empreintes avant / après) ───────────

  private event(actor: User | { kind: 'system'; id: string }, action: string, entityType: string, entityId: string, before: unknown, after: unknown, reason?: string, extra: Record<string, unknown> = {}): void {
    const ref = (v: unknown): AuditRef | null => {
      if (!v || typeof v !== 'object') return null;
      const o = v as Record<string, unknown>;
      return { ...(o.status !== undefined ? { status: String(o.status) } : {}), ...(o.targetId !== undefined ? { targetId: (o.targetId as string | null) ?? null } : {}), ...(o.version !== undefined ? { version: Number(o.version) } : {}), ...(o.recordStatus !== undefined ? { recordStatus: String(o.recordStatus) } : {}) };
    };
    this.ctx.audit.append({
      actor: 'kind' in actor && actor.kind === 'system' ? actor : actorOf(actor as User), action, resourceType: entityType, resourceId: entityId,
      details: {
        beforeHash: before === null || before === undefined ? null : sha256Hex(canonicalJson(before)), afterHash: after === null || after === undefined ? null : sha256Hex(canonicalJson(after)),
        before: ref(before), after: ref(after), reason: reason ?? null, ...extra,
      },
    });
  }

  // ─────────── Accès aux enregistrements ───────────

  claim(id: string): PropertyClaim {
    const c = this.claims.get(id);
    if (!c) throw notFound('CLAIM_NOT_FOUND', `Revendication inconnue : ${id}`);
    return c;
  }

  reviewCase(id: string): ReviewCase {
    const c = this.cases.get(id);
    if (!c) throw notFound('REVIEW_CASE_NOT_FOUND', `Dossier de revue inconnu : ${id}`);
    return c;
  }

  private selfAccount(user: User): string {
    if (!user.roles.includes('R30') || !user.taxpayerId) throw forbidden('ACCOUNT_REQUIRED', 'Revendication réservée au titulaire d’un compte (le compte est déduit de la session).');
    return this.ctx.taxpayers.resolve(user.taxpayerId).id;
  }

  private ownClaim(user: User, id: string): PropertyClaim {
    const c = this.claim(id);
    if (!user.taxpayerId || this.ctx.taxpayers.resolve(user.taxpayerId).id !== c.accountId) throw forbidden('NOT_YOUR_CLAIM', 'Cette revendication n’est pas la vôtre.');
    return c;
  }

  private checkVersion(c: { version: number }, expected: number | undefined): void {
    if (expected !== undefined && expected !== c.version) throw conflict('STALE_VERSION', `Version périmée (attendue ${c.version}, reçue ${expected}) : rechargez puis recommencez.`, { currentVersion: c.version });
  }

  private checkDates(from?: string, to?: string): void {
    const d = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !d.test(from)) || (to && !d.test(to))) throw unprocessable('INVALID_DATES', 'Dates attendues au format AAAA-MM-JJ.');
    if (from && to && to < from) throw unprocessable('INVALID_DATES', 'La date de fin précède la date de début.');
  }

  /** Transition contrôlée + synchronisation de la relation du module 7 + audit. */
  private transition(c: PropertyClaim, to: ClaimStatus, by: User | { kind: 'system'; id: string }, reason?: string, patch: Partial<PropertyClaim> = {}): PropertyClaim {
    if (c.status !== to && !TRANSITIONS[c.status].includes(to)) throw conflict('INVALID_CLAIM_TRANSITION', `Transition refusée : ${c.status} → ${to}.`);
    const byId = 'kind' in by && by.kind === 'system' ? by.id : (by as User).id;
    const at = this.now();
    const next: PropertyClaim = { ...c, ...patch, status: to, updatedAt: at, version: c.version + 1, history: [...c.history, { at, by: byId, from: c.status, to, ...(reason ? { reason } : {}) }] };
    const saved = this.claims.update(next);
    if (saved.relationId && MODULE7_STATUS[to] !== MODULE7_STATUS[c.status] && to !== 'VERIFIED') {
      this.relations.setFromClaim(saved.relationId, { status: MODULE7_STATUS[to], ...(to === 'ENDED' && saved.validTo ? { to: saved.validTo } : {}), ...(to === 'DISPUTED' ? { probativeStatus: 'CONTESTE' as const } : {}) }, byId, `REVENDICATION_${to}`, reason);
    }
    this.event(by, `property_claim.${to.toLowerCase()}`, 'property_claim', c.id, c, saved, reason);
    return saved;
  }

  // ─────────── Rapprochement (§ 5) ───────────

  private ancestors(o: FiscalObject): { unit?: FiscalObject; building?: FiscalObject; plot?: FiscalObject } {
    const byCat: { unit?: FiscalObject; building?: FiscalObject; plot?: FiscalObject } = {};
    let cur: FiscalObject | undefined = o;
    for (let i = 0; cur && i < 4; i++) {
      if (cur.category === 'UNITE_LOCATIVE' || cur.category === 'ACTIVITE') byCat.unit ??= cur;
      else if (cur.category === 'BATIMENT') byCat.building ??= cur;
      else if (cur.category === 'PARCELLE') byCat.plot ??= cur;
      const pid = parentIdOf(cur);
      cur = pid ? this.ctx.objects.objects.get(pid) : undefined;
    }
    return byCat;
  }

  private childrenOf(o: FiscalObject): FiscalObject[] {
    return this.ctx.objects.objects.find((c) => c.id !== o.id && parentIdOf(c) === o.id && recordStatusOf(c) !== 'ARCHIVED_ALIAS');
  }

  private addrOf(o: FiscalObject) {
    const a = this.ancestors(o);
    const src = [o, a.building, a.plot].filter((x): x is FiscalObject => !!x);
    const pick = (k: string) => { for (const x of src) { const v = x.attributes[k] ?? x.addressEntered?.[k]; if (typeof v === 'string' && v) return v; } return undefined; };
    const officialRefs = src.flatMap((x) => [
      ...(x.officialRef ? [{ value: x.officialRef.value, namespace: x.officialRef.namespace, verified: x.officialRef.verified }] : []),
      ...(x.igf?.code ? [{ value: x.igf.code, namespace: 'MOSOLO-IGF', verified: true }] : []),
      ...(x.igf?.cahierCode ? [{ value: x.igf.cahierCode, namespace: 'MOSOLO-IGF', verified: true }] : []),
    ]);
    return {
      commune: o.commune, quartier: o.quartier, avenue: o.avenue ?? a.building?.avenue ?? a.plot?.avenue ?? pick('avenue'), number: pick('numero') ?? pick('number'),
      buildingLabel: a.building?.buildingLabel ?? (typeof a.building?.attributes['libelle'] === 'string' ? String(a.building.attributes['libelle']) : undefined),
      unitLabel: a.unit?.unitLabel ?? (typeof a.unit?.attributes['unite'] === 'string' ? String(a.unit.attributes['unite']) : undefined),
      lat: o.lat, lon: o.lon, officialRefs,
    };
  }

  /** Libellé NEUTRE d'un bien (adresse et libellés d'unité seulement ; jamais un nom, un compte ou une pièce). */
  safeLabel(o: FiscalObject): string {
    const a = this.addrOf(o);
    const parts = [
      a.unitLabel ? `Unité ${a.unitLabel}` : undefined, a.buildingLabel ? `bâtiment ${a.buildingLabel}` : undefined,
      a.number ? `n° ${a.number}` : undefined, a.avenue ? `avenue ${a.avenue}` : undefined, a.quartier, a.commune,
    ].filter(Boolean);
    return parts.join(', ');
  }

  /**
   * Candidats d'une adresse saisie. Signaux : IDENTIFIANT_OFFICIEL (espace de noms), ADRESSE_EXACTE (+ bâtiment,
   * + unité), GPS + composantes. Indices ignorés : nom, téléphone (jamais un critère). Score : classement seulement.
   */
  findCandidates(addr: ClaimAddress, targetType: TargetType, exclude: Set<string> = new Set()): { target: FiscalObject; targetType: TargetType; unitToCreate?: string; score: number; signals: string[] }[] {
    const minScore = CONFIG_BIENS.scoreMinimalCandidat.valeur;
    const near = CONFIG_BIENS.seuilDistanceGpsM.valeur;
    const wide = CONFIG_BIENS.seuilDistanceGpsLargeM.valeur;
    const pool = this.ctx.objects.objects.find((o) => !exclude.has(o.id) && recordStatusOf(o) !== 'ARCHIVED_ALIAS' && lifecycleOf(o) !== 'CLOS'
      && (o.category === 'PARCELLE' || o.category === 'BATIMENT' || o.category === 'UNITE_LOCATIVE'));
    const out = new Map<string, { target: FiscalObject; targetType: TargetType; unitToCreate?: string; score: number; signals: string[] }>();
    const refIn = normAddr(addr.official_ref).replace(/\s/g, '');
    for (const o of pool) {
      const a = this.addrOf(o);
      const signals: string[] = [];
      let score = 0;
      if (refIn && a.officialRefs.some((r) => r.value.toLowerCase().replace(/[^a-z0-9]/g, '') === refIn && (!addr.official_namespace || addr.official_namespace === r.namespace))) {
        score += 100; signals.push('IDENTIFIANT_OFFICIEL');
      }
      const communeOk = !!addr.commune && normAddr(addr.commune) === normAddr(a.commune);
      const quartierOk = !!addr.quartier && !!a.quartier && normAddr(addr.quartier) === normAddr(a.quartier);
      const avenueOk = !!addr.avenue && !!a.avenue && normAddr(addr.avenue) === normAddr(a.avenue);
      const numberOk = !!addr.number && !!a.number && normAddr(addr.number) === normAddr(a.number);
      const quartierConflict = !!addr.quartier && !!a.quartier && !quartierOk;
      if (communeOk && avenueOk && numberOk && !quartierConflict) { score += 60; signals.push('ADRESSE_EXACTE'); }
      if (addr.lat !== undefined && addr.lon !== undefined && communeOk && (avenueOk || quartierOk)) {
        const dist = distanceM({ lat: addr.lat, lon: addr.lon }, { lat: o.lat, lon: o.lon });
        if (dist <= near) { score += 25; signals.push('GPS_PROCHE'); } else if (dist <= wide) { score += 10; signals.push('GPS_VOISIN'); }
        if (signals.some((s) => s.startsWith('GPS'))) { score += 5 + (avenueOk ? 10 : 0) + (quartierOk ? 5 : 0); signals.push('COMPOSANTES_ADRESSE'); }
      }
      if (!signals.includes('IDENTIFIANT_OFFICIEL') && !signals.includes('ADRESSE_EXACTE') && !signals.includes('COMPOSANTES_ADRESSE')) continue;
      // Libellés : bâtiment et unité (une étiquette contradictoire écarte la cible).
      if (addr.building_label && a.buildingLabel) {
        if (normAddr(addr.building_label) === normAddr(a.buildingLabel)) { score += 10; signals.push('BATIMENT'); } else if (o.category !== 'PARCELLE') continue;
      }
      if (score < minScore) continue;
      // Cible du niveau demandé : l'unité portant le libellé, sinon le bâtiment (unité à créer), sinon la parcelle.
      if (targetType === 'UNIT') {
        if (o.category === 'UNITE_LOCATIVE') {
          if (addr.unit_label && a.unitLabel && normAddr(addr.unit_label) !== normAddr(a.unitLabel)) continue;
          const s = addr.unit_label && a.unitLabel ? score + 20 : score;
          const prev = out.get(o.id);
          if (!prev || prev.score < s) out.set(o.id, { target: o, targetType: 'UNIT', score: s, signals: addr.unit_label && a.unitLabel ? [...signals, 'UNITE'] : signals });
        } else if (o.category === 'BATIMENT') {
          const units = this.childrenOf(o).filter((c) => c.category === 'UNITE_LOCATIVE');
          const hit = addr.unit_label ? units.find((u) => normAddr(this.addrOf(u).unitLabel) === normAddr(addr.unit_label)) : undefined;
          if (hit) { if (!out.has(hit.id)) out.set(hit.id, { target: hit, targetType: 'UNIT', score: score + 20, signals: [...signals, 'UNITE'] }); }
          else if (!units.some((u) => out.has(u.id))) out.set(o.id, { target: o, targetType: 'BUILDING', ...(addr.unit_label ? { unitToCreate: addr.unit_label } : {}), score, signals });
        }
      } else if (TARGET_CATEGORY[targetType] === o.category) {
        out.set(o.id, { target: o, targetType, score, signals });
      }
    }
    return [...out.values()].sort((x, y) => y.score - x.score).slice(0, 5);
  }

  // ─────────── Revendications ───────────

  private newClaim(accountId: string, by: string, input: { role: ClaimRole; targetType: TargetType; share?: string; validFrom?: string; validTo?: string; useType?: PropertyClaim['useType']; jointTenancy?: boolean; address?: ClaimAddress; origin: PropertyClaim['origin'] }): PropertyClaim {
    const at = this.now();
    const c = this.claims.insert({
      id: `PCL-${randomBytes(9).toString('hex').toUpperCase()}`, accountId, role: input.role, targetType: input.targetType,
      ...(input.share ? { share: input.share } : {}), ...(input.validFrom ? { validFrom: input.validFrom } : {}), ...(input.validTo ? { validTo: input.validTo } : {}),
      useType: input.useType ?? 'RESIDENTIAL', ...(input.jointTenancy ? { jointTenancy: true } : {}), ...(input.address ? { address: input.address } : {}),
      status: 'DRAFT', origin: input.origin, createdBy: by, createdAt: at, updatedAt: at, version: 1, history: [{ at, by, from: null, to: 'DRAFT' }],
    });
    this.event({ kind: 'system', id: by }, 'property_claim.draft', 'property_claim', c.id, null, c, `Revendication ${input.role} (${input.origin})`);
    return c;
  }

  /** Brouillon ouvert par le choix fait à l'inscription ou au parcours d'enrôlement : jamais vérifié, jamais relié. */
  draftFromIntention(accountId: string, role: ClaimRole, origin: 'INSCRIPTION' | 'ENROLEMENT'): PropertyClaim {
    const existing = this.claims.findOne((c) => c.accountId === accountId && c.role === role && c.status === 'DRAFT' && !c.address);
    return existing ?? this.newClaim(accountId, 'inscription', { role, targetType: role === 'OWNER' || role === 'MANAGER' ? 'BUILDING' : 'UNIT', origin });
  }

  /**
   * POST /v1/revendications-biens : revendication d'un rôle sur un bien. Le compte est celui de la session. Sans
   * cible choisie : rapprochement ; aucun candidat ⇒ enregistrements PROVISOIRES (SELF_REPORTED) et revendication
   * soumise ; sinon, la personne choisit un candidat ou « Mon adresse n'y figure pas ». Jamais VERIFIED.
   */
  submit(user: User, input: {
    claimId?: string; version?: number; role: string; targetType?: TargetType; address?: ClaimAddress; validFrom?: string; validTo?: string;
    useType?: PropertyClaim['useType']; share?: string; jointTenancy?: boolean; origin?: PropertyClaim['origin']; submit?: boolean;
    indices?: { nom?: string; telephone?: string };
  }) {
    const accountId = this.selfAccount(user);
    const role = toClaimRole(input.role);
    this.checkDates(input.validFrom, input.validTo);
    if (input.address && !isCommune(input.address.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.address.commune}`);
    if (input.share && !/^\d{1,3}(\.\d{1,2})?$/.test(input.share)) throw badRequest('INVALID_PERCENT', 'Quote-part : pourcentage décimal attendu.');
    const targetType: TargetType = input.targetType ?? (role === 'OWNER' || role === 'MANAGER' ? 'BUILDING' : 'UNIT');
    let c: PropertyClaim;
    if (input.claimId) {
      c = this.ownClaim(user, input.claimId);
      this.checkVersion(c, input.version);
      if (c.status !== 'DRAFT') throw conflict('INVALID_CLAIM_TRANSITION', 'Seul un brouillon se complète.');
      c = this.claims.update({ ...c, role, targetType, ...(input.address ? { address: input.address } : {}), ...(input.validFrom ? { validFrom: input.validFrom } : {}), ...(input.validTo ? { validTo: input.validTo } : {}), ...(input.useType ? { useType: input.useType } : {}), ...(input.share ? { share: input.share } : {}), ...(input.jointTenancy ? { jointTenancy: true } : {}), version: c.version + 1, updatedAt: this.now() });
    } else {
      c = this.newClaim(accountId, user.id, { role, targetType, ...(input.share ? { share: input.share } : {}), ...(input.validFrom ? { validFrom: input.validFrom } : {}), ...(input.validTo ? { validTo: input.validTo } : {}), ...(input.useType ? { useType: input.useType } : {}), ...(input.jointTenancy ? { jointTenancy: true } : {}), ...(input.address ? { address: input.address } : {}), origin: input.origin ?? 'ESPACE' });
    }
    const ignored = Object.entries(input.indices ?? {}).filter(([, v]) => !!v).map(([k]) => k);
    if (input.submit === false || !c.address) {
      return { ...this.claimantView(c), candidats: 0, suite: c.address ? 'SOUMETTRE' : 'COMPLETER_ADRESSE', indicesIgnores: ignored };
    }
    c = this.transition(c, 'SUBMITTED', user, 'Revendication soumise par la personne');
    const found = this.findCandidates(c.address!, c.targetType, this.ownRecordIds(accountId));
    const exp = new Date(this.ctx.clock.now().getTime() + CONFIG_BIENS.dureeCandidatMinutes.valeur * 60_000).toISOString();
    for (const f of found) {
      this.candidates.insert({ id: `CAND-${randomBytes(8).toString('hex').toUpperCase()}`, claimId: c.id, targetId: f.target.id, targetType: f.targetType, ...(f.unitToCreate ? { unitToCreate: f.unitToCreate } : {}), signals: f.signals, score: f.score, createdAt: this.now(), expiresAt: exp });
    }
    if (!found.length) {
      // Adresse non résolue : enregistrements provisoires auto-déclarés et revendication rattachée (spécification § 4.1).
      const target = this.createProvisionalHierarchy(user, c);
      c = this.attachTarget(user, c, target, false);
      return { ...this.claimantView(c), candidats: 0, suite: 'PREUVE_OU_INVITATION', indicesIgnores: ignored };
    }
    return { ...this.claimantView(c), candidats: found.length, suite: 'CHOISIR_CANDIDAT', indicesIgnores: ignored };
  }

  /** Enregistrements propres à la personne (biens qu'elle a elle-même déclarés) : jamais proposés comme candidats. */
  private ownRecordIds(accountId: string): Set<string> {
    const ids = new Set<string>();
    for (const c of this.claims.find((x) => x.accountId === accountId)) if (c.targetId && this.ctx.objects.objects.get(c.targetId)?.recordProvenance === 'SELF_REPORTED') {
      const o = this.ctx.objects.objects.get(c.targetId)!;
      const a = this.ancestors(o);
      for (const x of [a.unit, a.building, a.plot]) if (x?.recordProvenance === 'SELF_REPORTED') ids.add(x.id);
    }
    return ids;
  }

  /** Candidats masqués d'une revendication (GET /v1/biens-candidats) : libellés neutres, jamais de signal ni de personne. */
  candidatesOf(user: User, claimId: string) {
    const c = this.ownClaim(user, claimId);
    const nowIso = this.now();
    const list = this.candidates.find((x) => x.claimId === c.id && x.expiresAt > nowIso).sort((a, b) => b.score - a.score);
    this.event(user, 'property_candidates.read', 'property_claim', c.id, null, null, undefined, { count: list.length });
    return {
      claimId: c.id, statut: c.status,
      candidats: list.map((x, i) => {
        const o = this.ctx.objects.get(x.targetId);
        return {
          candidateId: x.id, rang: i + 1, libelle: x.unitToCreate ? `${this.safeLabel(o)} — unité « ${x.unitToCreate} » à ajouter` : this.safeLabel(o),
          typeCible: x.unitToCreate ? 'UNIT' : x.targetType, statutEnregistrement: recordStatusOf(o), expireLe: x.expiresAt,
        };
      }),
      aucun: { libelle: 'Mon adresse n’y figure pas', action: 'POST /v1/revendications-biens/:id/choix-candidat { "aucun": true }' },
      avertissement: 'Choisir un candidat ne vérifie rien : la relation reste à vérifier par une personne habilitée.',
    };
  }

  /** Choix d'un candidat ou « Mon adresse n'y figure pas » (POST …/choix-candidat). */
  selectCandidate(user: User, claimId: string, input: { candidateId?: string; aucun?: boolean; version?: number }) {
    let c = this.ownClaim(user, claimId);
    this.checkVersion(c, input.version);
    if (c.targetId) throw conflict('TARGET_ALREADY_SET', 'Cette revendication a déjà une cible.');
    if (c.status !== 'SUBMITTED') throw conflict('INVALID_CLAIM_TRANSITION', `Revendication au statut ${c.status}.`);
    if (input.aucun) {
      const target = this.createProvisionalHierarchy(user, c);
      c = this.attachTarget(user, c, target, false);
      return this.claimantView(c);
    }
    const cand = input.candidateId ? this.candidates.get(input.candidateId) : undefined;
    if (!cand || cand.claimId !== c.id || cand.expiresAt <= this.now()) throw notFound('CANDIDATE_INVALID', 'Candidat inconnu ou expiré : relancez la recherche.');
    let target = this.ctx.objects.get(cand.targetId);
    if (cand.unitToCreate) {
      // Bâtiment reconnu, unité absente : unité PROVISOIRE créée sous le bâtiment (aucune fusion, aucune vérification).
      target = this.ctx.objects.createSelfReported(user.id, {
        category: 'UNITE_LOCATIVE', commune: target.commune, quartier: target.quartier, localityRank: target.localityRank, lat: c.address?.lat ?? target.lat, lon: c.address?.lon ?? target.lon,
        attributes: {}, parentObjectId: target.id, unitLabel: cand.unitToCreate, useType: c.useType, ...(c.address ? { addressEntered: this.enteredAddress(c.address) } : {}),
      });
    }
    c = this.attachTarget(user, c, target, true);
    return this.claimantView(c);
  }

  private enteredAddress(a: ClaimAddress): Record<string, string> {
    return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  }

  /** Parcelle → bâtiment → unité PROVISOIRES (SELF_REPORTED), sans identifiant officiel vérifié. */
  private createProvisionalHierarchy(user: User, c: PropertyClaim): FiscalObject {
    const a = c.address!;
    const lat = a.lat ?? -4.325;
    const lon = a.lon ?? 15.322;
    const base = { commune: a.commune, quartier: a.quartier ?? 'À préciser', localityRank: 4 as const, lat, lon, ...(a.avenue ? { avenue: a.avenue } : {}), useType: c.useType, addressEntered: this.enteredAddress(a) };
    const plot = this.ctx.objects.createSelfReported(user.id, {
      ...base, category: 'PARCELLE', attributes: { ...(a.number ? { numero: a.number } : {}), ...(a.avenue ? { avenue: a.avenue } : {}) },
      ...(a.official_ref ? { officialRef: { value: a.official_ref, namespace: a.official_namespace ?? 'KIN-CADASTRE', issuer: 'Déclaré par la personne', verified: false } } : {}),
    });
    const building = this.ctx.objects.createSelfReported(user.id, { ...base, category: 'BATIMENT', attributes: {}, parentObjectId: plot.id, buildingLabel: a.building_label ?? 'A' });
    const unit = this.ctx.objects.createSelfReported(user.id, { ...base, category: 'UNITE_LOCATIVE', attributes: {}, parentObjectId: building.id, unitLabel: a.unit_label ?? 'MAIN', ...(a.floor ? { floor: a.floor } : {}) });
    this.queueDuplicateReview(user, [plot, building, unit]);
    return c.targetType === 'PLOT' ? plot : c.targetType === 'BUILDING' ? building : unit;
  }

  /**
   * Doublons de biens : un enregistrement provisoire qui ressemble à un autre enregistrement (autre déclarant) ouvre un
   * dossier FUSION_BIENS — jamais de fusion automatique.
   */
  private queueDuplicateReview(user: User | { kind: 'system'; id: string }, created: FiscalObject[]): ReviewCase[] {
    const out: ReviewCase[] = [];
    const exclude = new Set(created.map((o) => o.id));
    for (const o of created) {
      const tt = CATEGORY_TARGET[o.category];
      if (!tt) continue;
      const a = this.addrOf(o);
      const found = this.findCandidates({ commune: a.commune, ...(a.quartier ? { quartier: a.quartier } : {}), ...(a.avenue ? { avenue: a.avenue } : {}), ...(a.number ? { number: a.number } : {}), ...(a.buildingLabel ? { building_label: a.buildingLabel } : {}), ...(a.unitLabel ? { unit_label: a.unitLabel } : {}), lat: o.lat, lon: o.lon, ...(o.officialRef ? { official_ref: o.officialRef.value } : {}) }, tt, exclude)
        .filter((f) => f.targetType === tt && f.target.category === o.category && !f.unitToCreate);
      for (const f of found) {
        const pair: [string, string] = [f.target.id, o.id];
        if (this.cases.findOne((x) => x.reasonCode === 'FUSION_BIENS' && x.status !== 'DECIDE' && !!x.merge && x.merge.recordIds.includes(pair[0]) && x.merge.recordIds.includes(pair[1]))) continue;
        out.push(this.openCase(user, { reasonCode: 'FUSION_BIENS', commune: o.commune, relatedClaimIds: this.claims.find((c) => !!c.targetId && pair.includes(c.targetId)).map((c) => c.id), merge: { recordIds: pair, signals: f.signals } }));
      }
    }
    return out;
  }

  /** Rattache la cible (candidat choisi ou provisoire), crée la relation du module 7 et le dossier de vérification. */
  private attachTarget(user: User, c: PropertyClaim, target: FiscalObject, matched: boolean): PropertyClaim {
    const tt = CATEGORY_TARGET[target.category] ?? c.targetType;
    const rel = this.relations.insertFromClaim({
      claimId: c.id, taxpayerId: c.accountId, objectId: target.id, role: c.role === 'OWNER' && c.share && c.share !== '100' ? 'COPROPRIETAIRE' : ROLE_TO_RELATION[c.role],
      ...(c.share ? { share: c.share } : {}), from: c.validFrom ?? this.d.today(), ...(c.validTo ? { to: c.validTo } : {}), ...(c.jointTenancy ? { jointTenancy: true } : {}), declaredBy: user.id,
    });
    let saved = this.claims.update({ ...c, targetId: target.id, targetType: tt, relationId: rel.id, version: c.version + 1, updatedAt: this.now() });
    this.event(user, 'property_claim.target_attached', 'property_claim', c.id, c, saved, matched ? 'Candidat choisi par la personne' : 'Enregistrement provisoire auto-déclaré', { recordStatus: recordStatusOf(target) });
    if (matched) saved = this.transition(saved, 'MATCHED_PENDING_VERIFICATION', user, 'Cible choisie parmi les candidats — à vérifier');
    this.openCase(user, { reasonCode: 'VERIFICATION', claimId: saved.id, relatedClaimIds: [saved.id], commune: target.commune });
    return saved;
  }

  // ─────────── Preuves ───────────

  addEvidence(user: User, claimId: string, input: { evidenceType: string; sha256: string; documentId?: string; label?: string; version?: number }) {
    let c = this.ownClaim(user, claimId);
    this.checkVersion(c, input.version);
    if (['REJECTED', 'SUPERSEDED', 'ENDED'].includes(c.status)) throw conflict('CLAIM_CLOSED', `Revendication au statut ${c.status}.`);
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw badRequest('INVALID_SHA256', 'Empreinte SHA-256 attendue (64 caractères hexadécimaux).');
    if (input.evidenceType === 'INVITATION_ACCEPTEE' || input.evidenceType === 'CONSTAT_TERRAIN') throw unprocessable('SYSTEM_EVIDENCE', 'Cette preuve est établie par le circuit (invitation, agent de terrain), pas déposée.');
    if (this.evidence.findOne((e) => e.claimId === c.id && e.sha256 === input.sha256)) throw conflict('EVIDENCE_EXISTS', 'Cette pièce est déjà jointe : une pièce n’est jamais remplacée ni écrasée.');
    const e = this.appendEvidence(c, user.id, { evidenceType: input.evidenceType, sha256: input.sha256, ...(input.documentId ? { documentId: input.documentId } : {}), ...(input.label ? { label: input.label } : {}) });
    if (c.status === 'NEEDS_EVIDENCE') c = this.transition(c, c.targetId && recordStatusOf(this.ctx.objects.get(c.targetId)) === 'CANONICAL' ? 'MATCHED_PENDING_VERIFICATION' : 'SUBMITTED', user, 'Pièce déposée');
    else c = this.claims.update({ ...c, version: c.version + 1, updatedAt: this.now() });
    return { evidenceId: e.id, reviewStatus: e.reviewStatus, claim: this.claimantView(c) };
  }

  private appendEvidence(c: PropertyClaim, by: string, input: { evidenceType: string; sha256: string; documentId?: string; label?: string; gps?: ClaimEvidence['gps'] }): ClaimEvidence {
    const id = `PRV-BIEN-${randomBytes(6).toString('hex').toUpperCase()}`;
    const e = this.evidence.append({
      id, claimId: c.id, evidenceType: input.evidenceType, objectKey: `preuves-biens/${c.id}/${id}`, sha256: input.sha256, submittedBy: by, submittedAt: this.now(),
      reviewStatus: 'EN_ATTENTE', retentionClass: CONFIG_BIENS.conservationPreuves.valeur, ...(input.documentId ? { documentId: input.documentId } : {}), ...(input.label ? { label: input.label } : {}), ...(input.gps ? { gps: input.gps } : {}),
    });
    if (c.relationId) {
      const rel = this.relations.get(c.relationId);
      const proofType = (['TITRE_FONCIER', 'CERTIFICAT_ENREGISTREMENT', 'ACTE_DE_VENTE', 'CONTRAT_DE_LOCATION', 'ATTESTATION_COUTUMIERE', 'ACTE_SUCCESSORAL', 'MANDAT_DE_GESTION', 'CONSTAT_TERRAIN', 'QUITTANCE_LOYER', 'FACTURE_SERVICE', 'INVITATION_ACCEPTEE', 'AUTORISATION_EXPLOITATION'] as const).find((t) => t === input.evidenceType) ?? 'AUTRE';
      this.relations.setFromClaim(rel.id, { proofs: [...rel.proofs, { type: proofType, reference: e.id, sha256: e.sha256, addedAt: e.submittedAt, addedBy: by }] }, by, 'PIECE_AJOUTEE', input.evidenceType);
    }
    this.event({ kind: 'system', id: by }, 'property_claim.evidence_added', 'property_claim', c.id, null, { id: e.id, sha256: e.sha256, type: e.evidenceType }, input.evidenceType);
    return e;
  }

  // ─────────── Invitations ───────────

  invite(user: User, claimId: string, input: { contact: string; channel?: PropertyInvitation['deliveryChannel']; inviteRole?: string; targetUnitId?: string }) {
    const c = this.ownClaim(user, claimId);
    if (['REJECTED', 'SUPERSEDED', 'ENDED', 'DRAFT'].includes(c.status)) throw conflict('INVALID_CLAIM_TRANSITION', `Revendication au statut ${c.status} : invitation impossible.`);
    return this.createInvitation(user.id, c, input);
  }

  private createInvitation(by: string, c: PropertyClaim, input: { contact: string; channel?: PropertyInvitation['deliveryChannel']; inviteRole?: string; targetUnitId?: string }) {
    const contact = input.contact.replace(/[\s-]/g, '').toLowerCase();
    if (contact.length < 6) throw badRequest('INVALID_CONTACT', 'Contact invalide.');
    // Troisième passe (D3-01) : le bien visé par l'invitation appartient à la branche du bien revendiqué (même parcelle,
    // bâtiment ou unité) ; un bien étranger ou inexistant est refusé avec la MÊME erreur (aucune sonde d'existence).
    if (input.targetUnitId && !this.onClaimBranch(c, input.targetUnitId)) {
      throw unprocessable('INVITATION_TARGET_OUT_OF_CLAIM', 'Le bien visé par l’invitation doit appartenir au bien de la revendication (même parcelle, bâtiment ou unité).');
    }
    const token = randomBytes(24).toString('base64url');
    const at = this.now();
    const inv = this.invitations.insert({
      id: `INV-BIEN-${randomBytes(6).toString('hex').toUpperCase()}`, claimId: c.id, ...(input.inviteRole ? { inviteRole: toClaimRole(input.inviteRole) } : {}),
      ...(input.targetUnitId ? { targetUnitId: input.targetUnitId } : {}), deliveryChannel: input.channel ?? (contact.includes('@') ? 'EMAIL' : 'SMS'),
      contactHash: sha256Hex(`contact:${contact}`), contactMasked: contact.includes('@') ? `•••@${contact.split('@')[1]}` : maskPhone(contact),
      tokenHash: sha256Hex(`invitation-bien:${token}`), expiresAt: new Date(this.ctx.clock.now().getTime() + CONFIG_BIENS.dureeInvitationJours.valeur * 86_400_000).toISOString(),
      createdAt: at, status: 'EN_ATTENTE',
    });
    // Envoi opaque : le message ne contient qu'un lien à jeton ; aucune donnée de la personne qui invite.
    const sandbox = isDemoMode() && !this.ctx.comms.channelStatus().some((s) => s.channel === 'sms' && s.wired);
    if (sandbox) this.sandboxTokens.set(inv.id, token);
    this.event({ kind: 'system', id: by }, 'property_invitation.created', 'property_invitation', inv.id, null, { status: inv.status, claimId: c.id }, 'Invitation d’une partie connue', { channel: inv.deliveryChannel });
    // Réponse identique qu'un compte existe ou non pour ce contact (aucune découverte de compte).
    return { invitationId: inv.id, expiresAt: inv.expiresAt, statut: 'ENVOYEE', contact: inv.contactMasked, ...(sandbox ? { jetonBacASable: token } : {}) };
  }

  /** Le bien `objectId` est-il la cible de la revendication, l'un de ses ancêtres ou l'un de ses descendants ? */
  private onClaimBranch(c: PropertyClaim, objectId: string): boolean {
    if (!c.targetId) return false;
    const o = this.ctx.objects.objects.get(objectId);
    const t = this.ctx.objects.objects.get(c.targetId);
    if (!o || !t || recordStatusOf(o) === 'ARCHIVED_ALIAS') return false;
    const up = (x: FiscalObject): Set<string> => {
      const ids = new Set<string>([x.id]);
      let cur: FiscalObject | undefined = x;
      for (let i = 0; cur && i < 4; i++) { const pid = parentIdOf(cur); cur = pid ? this.ctx.objects.objects.get(pid) : undefined; if (cur) ids.add(cur.id); }
      return ids;
    };
    return up(o).has(t.id) || up(t).has(o.id);
  }

  /** Réponse à une invitation (jeton à usage unique) : jamais de vérification automatique, jamais de divulgation. */
  respond(user: User, token: string, input: { response: 'ACCEPTER' | 'REFUSER' | 'BIEN_ERRONE'; creerMaRevendication?: boolean; validFrom?: string }) {
    const accountId = this.selfAccount(user);
    const hash = sha256Hex(`invitation-bien:${token}`);
    const inv = this.invitations.findOne((i) => i.tokenHash === hash);
    const nowIso = this.now();
    if (!inv || inv.status !== 'EN_ATTENTE' || inv.expiresAt <= nowIso) {
      if (inv && inv.status === 'EN_ATTENTE' && inv.expiresAt <= nowIso) this.invitations.update({ ...inv, status: 'EXPIREE' });
      this.event(user, 'property_invitation.invalid_token', 'property_invitation', inv?.id ?? 'inconnue', null, null, 'Jeton invalide, expiré ou déjà utilisé');
      throw notFound('INVITATION_INVALID', 'Invitation invalide, expirée ou déjà utilisée.');
    }
    const c = this.claim(inv.claimId);
    if (c.accountId === accountId) throw forbidden('INVITATION_OWN_CLAIM', 'Vous ne pouvez pas répondre à votre propre invitation.');
    this.checkDates(input.validFrom);
    const status: PropertyInvitation['status'] = input.response === 'ACCEPTER' ? 'ACCEPTEE' : input.response === 'REFUSER' ? 'REFUSEE' : 'BIEN_ERRONE_SIGNALE';
    let resultClaimId: string | undefined;
    if (input.response === 'ACCEPTER') {
      // Troisième passe (D3-01) : la cible de la revendication à créer est résolue AVANT toute écriture (aucune pièce
      // ajoutée si la réponse échoue ensuite).
      const targetId = input.creerMaRevendication && inv.inviteRole ? inv.targetUnitId ?? c.targetId : undefined;
      if (targetId && (!this.ctx.objects.objects.get(targetId) || (inv.targetUnitId && !this.onClaimBranch(c, inv.targetUnitId)))) {
        throw unprocessable('INVITATION_TARGET_OUT_OF_CLAIM', 'Le bien visé par l’invitation n’appartient plus au bien de la revendication : aucune réponse enregistrée.');
      }
      // Preuve d'APPUI seulement : la revendication reste à vérifier par un réviseur habilité.
      const sha = sha256Hex(`${inv.id}:${accountId}:${nowIso}`);
      this.appendEvidence(c, user.id, { evidenceType: 'INVITATION_ACCEPTEE', sha256: sha });
      if (c.status === 'NEEDS_EVIDENCE') this.transition(c, c.targetId ? 'MATCHED_PENDING_VERIFICATION' : 'SUBMITTED', { kind: 'system', id: 'invitation' }, 'Invitation acceptée par l’autre partie (preuve d’appui)');
      if (input.creerMaRevendication && inv.inviteRole && (inv.targetUnitId ?? c.targetId)) {
        const target = this.ctx.objects.get(inv.targetUnitId ?? c.targetId!);
        let mine = this.newClaim(accountId, user.id, { role: inv.inviteRole, targetType: CATEGORY_TARGET[target.category] ?? 'UNIT', ...(input.validFrom ? { validFrom: input.validFrom } : {}), origin: 'INVITATION' });
        mine = this.transition(mine, 'SUBMITTED', user, 'Revendication créée en réponse à une invitation');
        mine = this.attachTarget(user, mine, target, true);
        this.appendEvidence(mine, user.id, { evidenceType: 'INVITATION_ACCEPTEE', sha256: sha256Hex(`${inv.id}:reponse:${accountId}`) });
        resultClaimId = mine.id;
      }
    } else if (input.response === 'BIEN_ERRONE') {
      const cur = this.claim(c.id);
      if (TRANSITIONS[cur.status].includes('DISPUTED')) this.transition(cur, 'DISPUTED', { kind: 'system', id: 'invitation' }, 'Mauvais bien signalé par la personne invitée');
      this.openCase({ kind: 'system', id: 'invitation' }, { reasonCode: 'BIEN_ERRONE_SIGNALE', claimId: c.id, relatedClaimIds: [c.id], commune: c.targetId ? this.ctx.objects.get(c.targetId).commune : c.address?.commune ?? '' });
    }
    const saved = this.invitations.update({ ...inv, status, respondedAt: nowIso, responderAccountId: accountId, ...(resultClaimId ? { resultClaimId } : {}) });
    this.event(user, 'property_invitation.responded', 'property_invitation', inv.id, inv, saved, input.response);
    return {
      invitationId: inv.id, reponse: input.response, statut: status, ...(resultClaimId ? { maRevendication: resultClaimId } : {}),
      message: input.response === 'ACCEPTER' ? 'Réponse enregistrée. La relation reste à vérifier par une personne habilitée.' : 'Réponse enregistrée.',
    };
  }

  // ─────────── Contestation, appel, fin ───────────

  /** Le revendicateur, ou le titulaire d'une relation VÉRIFIÉE sur la même cible (ou un niveau supérieur), conteste. */
  dispute(user: User, claimId: string, input: { reason: string; version?: number }) {
    let c = this.claim(claimId);
    const me = user.taxpayerId ? this.ctx.taxpayers.resolve(user.taxpayerId).id : undefined;
    const own = me === c.accountId;
    const party = !own && me && c.targetId ? this.verifiedHolderOnBranch(me, c.targetId) : false;
    if (!own && !party) throw forbidden('NOT_A_PARTY', 'Seules les parties concernées peuvent contester cette revendication.');
    // Troisième passe (D3-02) : version contrôlée APRÈS l'autorisation (un tiers n'apprend pas la version courante).
    this.checkVersion(c, input.version);
    if (!TRANSITIONS[c.status].includes('DISPUTED')) throw conflict('INVALID_CLAIM_TRANSITION', `Revendication au statut ${c.status} : contestation impossible.`);
    c = this.transition(c, 'DISPUTED', user, input.reason);
    const rc = this.openCase(user, { reasonCode: 'CONTESTATION', claimId: c.id, relatedClaimIds: [c.id], commune: c.targetId ? this.ctx.objects.get(c.targetId).commune : c.address?.commune ?? '', note: input.reason });
    return { caseId: rc.id, statut: c.status };
  }

  /** Un rejet se conteste par un NOUVEAU dossier de revue (APPEL) ; la revendication rejetée reste à l'historique. */
  appeal(user: User, claimId: string, input: { reason: string }) {
    const c = this.ownClaim(user, claimId);
    if (c.status !== 'REJECTED') throw conflict('INVALID_CLAIM_TRANSITION', 'Seule une revendication rejetée fait l’objet d’un appel.');
    const rc = this.openCase(user, { reasonCode: 'APPEL', claimId: c.id, relatedClaimIds: [c.id], commune: c.targetId ? this.ctx.objects.get(c.targetId).commune : c.address?.commune ?? '', note: input.reason });
    return { caseId: rc.id, statut: c.status };
  }

  /** Fin d'une relation (déménagement, cession) : datée, jamais supprimée ; l'historique reste interrogeable. */
  end(user: User, claimId: string, input: { validTo: string; reason: string; version?: number }) {
    const c = this.claim(claimId);
    const me = user.taxpayerId ? this.ctx.taxpayers.resolve(user.taxpayerId).id : undefined;
    const reviewer = this.isReviewer(user);
    if (me !== c.accountId && !reviewer) throw forbidden('NOT_YOUR_CLAIM', 'Seul le titulaire de la revendication, ou un réviseur habilité, la termine.');
    // Troisième passe (D3-03) : un réviseur qui n'est pas le titulaire termine seulement dans son territoire et sans
    // conflit d'intérêts (mêmes gardes que la décision).
    if (me !== c.accountId) {
      const commune = c.targetId ? this.ctx.objects.objects.get(c.targetId)?.commune ?? c.address?.commune ?? '' : c.address?.commune ?? '';
      if (!this.inTerritory(user, commune)) throw forbidden('OUT_OF_TERRITORY', 'Revendication hors de votre territoire.');
      assertNotRelated(user, c.accountId, 'Conflit d’intérêts : le réviseur est lié à la personne titulaire de la revendication.');
    }
    this.checkVersion(c, input.version);
    this.checkDates(c.validFrom, input.validTo);
    if (c.status !== 'VERIFIED') throw conflict('INVALID_CLAIM_TRANSITION', 'Seule une relation vérifiée se termine (les autres se retirent ou se contestent).');
    const ended = this.transition(c, 'ENDED', user, input.reason, { validTo: input.validTo });
    return this.claimantView(ended);
  }

  // ─────────── Dossiers de revue ───────────

  private openCase(by: User | { kind: 'system'; id: string }, input: { reasonCode: ReviewReason; claimId?: string; relatedClaimIds: string[]; commune: string; merge?: ReviewCase['merge']; note?: string }): ReviewCase {
    const byId = 'kind' in by && by.kind === 'system' ? by.id : (by as User).id;
    const rc = this.cases.insert({
      id: `DRV-${randomBytes(6).toString('hex').toUpperCase()}`, reasonCode: input.reasonCode, ...(input.claimId ? { claimId: input.claimId } : {}), relatedClaimIds: input.relatedClaimIds,
      commune: input.commune, status: 'OUVERT', openedBy: byId, openedAt: this.now(), ...(input.merge ? { merge: input.merge } : {}), ...(input.note ? { note: input.note } : {}), version: 1,
    });
    this.event(by, 'review_case.opened', 'review_case', rc.id, null, rc, REVIEW_REASON_LABELS[input.reasonCode], { reasonCode: input.reasonCode, claimId: input.claimId ?? null });
    return rc;
  }

  isReviewer(user: User): boolean {
    // Un administrateur technique (R26 à R29) n'approuve jamais un changement juridique ou financier.
    if (user.roles.some((r) => ['R26', 'R27', 'R28', 'R29'].includes(r)) && !user.roles.some((r) => CONFIG_BIENS.verificateurs.valeur.includes(r))) return false;
    return user.roles.some((r) => CONFIG_BIENS.verificateurs.valeur.includes(r));
  }

  private inTerritory(user: User, commune: string): boolean {
    return !user.territory || user.territory.includes(commune);
  }

  listCases(user: User, filter: { status?: string } = {}) {
    const nowIso = this.now();
    let list: ReviewCase[];
    if (this.isReviewer(user) || user.roles.some((r) => ['R12', 'R22', 'R23'].includes(r))) list = this.cases.all().filter((c) => this.inTerritory(user, c.commune));
    else if (user.roles.includes('R10') || user.roles.includes('R35')) {
      // Agent de terrain : seulement les dossiers qui lui sont affectés, dans son territoire, jusqu'à l'échéance.
      list = this.cases.find((c) => c.fieldAgentId === user.id && (c.fieldUntil ?? '') > nowIso && this.inTerritory(user, c.commune));
    } else throw forbidden('FORBIDDEN', 'File de revue réservée aux réviseurs habilités et aux agents affectés.');
    this.event(user, 'review_cases.listed', 'review_case', 'file', null, null, undefined, { count: list.length });
    return list.filter((c) => !filter.status || c.status === filter.status).sort((a, b) => b.openedAt.localeCompare(a.openedAt)).map((c) => this.caseSummary(c));
  }

  private caseSummary(c: ReviewCase) {
    const claim = c.claimId ? this.claims.get(c.claimId) : undefined;
    return {
      id: c.id, motif: c.reasonCode, motifLibelle: REVIEW_REASON_LABELS[c.reasonCode], statut: c.status, commune: c.commune, ouvertLe: c.openedAt,
      revendication: claim ? { id: claim.id, role: claim.role, statut: claim.status } : null, agentTerrain: c.fieldAgentId ?? null, echeanceTerrain: c.fieldUntil ?? null,
      decision: c.decision ?? null, version: c.version,
    };
  }

  /** Arbre d'un enregistrement (parcelle → bâtiments → unités) pour l'écran de revue de fusion. */
  private tree(rootId: string) {
    const root = this.ctx.objects.get(rootId);
    const top = this.ancestors(root).plot ?? this.ancestors(root).building ?? root;
    const node = (o: FiscalObject): Record<string, unknown> => ({
      id: o.id, categorie: o.category, libelle: o.unitLabel ?? o.buildingLabel ?? this.safeLabel(o), statutEnregistrement: recordStatusOf(o), provenance: o.recordProvenance ?? (o.status === 'VALIDE' ? 'ADMINISTRATION' : 'DECLARATION'),
      identifiantOfficiel: o.officialRef ?? (o.igf ? { value: o.igf.code, namespace: 'MOSOLO-IGF', verified: true } : null), position: { lat: o.lat, lon: o.lon },
      revendications: this.claims.find((c) => c.targetId === o.id).length, conflits: this.claims.find((c) => c.targetId === o.id && (c.status === 'DISPUTED' || c.status === 'UNDER_REVIEW')).length,
      enfants: this.childrenOf(o).map(node), dossierVise: o.id === rootId,
    });
    return node(top);
  }

  caseDetail(user: User, id: string) {
    const c = this.reviewCase(id);
    const nowIso = this.now();
    const field = c.fieldAgentId === user.id && (c.fieldUntil ?? '') > nowIso;
    if (!(this.isReviewer(user) || user.roles.some((r) => ['R12', 'R22', 'R23'].includes(r)) || field) || !this.inTerritory(user, c.commune)) {
      throw forbidden('FORBIDDEN', 'Dossier hors de votre périmètre ou de votre affectation.');
    }
    const claims = [...new Set([...(c.claimId ? [c.claimId] : []), ...c.relatedClaimIds])].map((cid) => this.claims.get(cid)).filter((x): x is PropertyClaim => !!x);
    // Lecture sensible journalisée ; pièces : type, empreinte et date — jamais le contenu (preuve minimale).
    this.event(user, 'review_case.read', 'review_case', c.id, null, null, undefined, { reasonCode: c.reasonCode, field });
    return {
      ...this.caseSummary(c), note: c.note ?? null,
      revendications: claims.map((x) => {
        const target = x.targetId ? this.ctx.objects.objects.get(x.targetId) : undefined;
        const tp = this.ctx.taxpayers.taxpayers.get(x.accountId);
        return {
          id: x.id, role: x.role, statut: x.status, du: x.validFrom ?? null, au: x.validTo ?? null, colocation: !!x.jointTenancy, quotePart: x.share ?? null,
          compte: field ? null : { id: x.accountId, nom: tp?.fullName ?? x.accountId, niveau: tp?.verificationLevel ?? null },
          cible: target ? { id: target.id, libelle: this.safeLabel(target), statutEnregistrement: recordStatusOf(target), provenance: target.recordProvenance ?? null } : null,
          adresseSaisie: x.address ?? null,
          pieces: field ? [] : this.evidence.find((e) => e.claimId === x.id).map((e) => ({ id: e.id, type: e.evidenceType, sha256: e.sha256, deposeeLe: e.submittedAt, statut: e.reviewStatus })),
        };
      }),
      fusion: c.merge ? { enregistrements: c.merge.recordIds.map((rid) => this.tree(rid)), signaux: c.merge.signals, appliquee: c.merge.applied ?? null } : null,
      mentionJuridique: MENTION_JURIDIQUE,
    };
  }

  /** Affectation d'un dossier à un agent de terrain (territoire, durée limitée). */
  assignField(user: User, id: string, input: { agentId: string; hours?: number; version?: number }) {
    if (!this.isReviewer(user)) throw forbidden('FORBIDDEN', 'Affectation réservée aux réviseurs habilités.');
    const c = this.reviewCase(id);
    this.checkVersion(c, input.version);
    const agent = this.ctx.users.get(input.agentId);
    if (!agent || !agent.roles.some((r) => r === 'R10' || r === 'R35')) throw unprocessable('NOT_A_FIELD_AGENT', 'L’agent désigné n’est pas un agent de terrain.');
    if (agent.territory && !agent.territory.includes(c.commune)) throw unprocessable('OUT_OF_TERRITORY', 'Dossier hors du territoire de l’agent.');
    const hours = Math.min(input.hours ?? CONFIG_BIENS.dureeAffectationTerrainHeures.valeur, CONFIG_BIENS.dureeAffectationTerrainHeures.valeur);
    const saved = this.cases.update({ ...c, fieldAgentId: agent.id, fieldUntil: new Date(this.ctx.clock.now().getTime() + hours * 3_600_000).toISOString(), status: c.status === 'OUVERT' ? 'EN_COURS' : c.status, version: c.version + 1 });
    this.event(user, 'review_case.field_assigned', 'review_case', c.id, c, saved, `Affectation terrain (${hours} h)`, { agentId: agent.id });
    return this.caseSummary(saved);
  }

  /** Constat de terrain (GPS + photo) par l'agent affecté : pièce CONSTAT_TERRAIN ; la décision reste au réviseur. */
  fieldVerification(user: User, id: string, input: { gps: { lat: number; lon: number; accuracyM?: number }; photoSha256: string; observations: string; confirme: boolean }) {
    const c = this.reviewCase(id);
    if (c.fieldAgentId !== user.id || (c.fieldUntil ?? '') <= this.now()) throw forbidden('NOT_ASSIGNED', 'Dossier non affecté à vous, ou affectation échue.');
    if (!evaluate(user, 'biens:field.verify', { communes: [c.commune] })) throw forbidden('OUT_OF_TERRITORY', 'Constat hors de votre territoire.');
    const claim = c.claimId ? this.claim(c.claimId) : undefined;
    if (!claim?.targetId) throw unprocessable('NO_TARGET', 'Revendication sans bien cible : constat impossible.');
    const target = this.ctx.objects.get(claim.targetId);
    const dist = distanceM(input.gps, { lat: target.lat, lon: target.lon });
    if (dist > CONFIG_BIENS.seuilConstatTerrainM.valeur) throw unprocessable('GPS_TOO_FAR', `Constat à ${Math.round(dist)} m du bien (maximum ${CONFIG_BIENS.seuilConstatTerrainM.valeur} m, ${'par défaut'}).`);
    if (!/^[0-9a-f]{64}$/.test(input.photoSha256)) throw badRequest('INVALID_SHA256', 'Empreinte de la photo attendue.');
    const e = this.appendEvidence(claim, user.id, { evidenceType: input.confirme ? 'CONSTAT_TERRAIN' : 'CONSTAT_TERRAIN_NEGATIF', sha256: input.photoSha256, gps: input.gps, label: input.observations.slice(0, 300) });
    const saved = this.cases.update({ ...c, note: `${c.note ? `${c.note} · ` : ''}Constat terrain ${input.confirme ? 'confirmant' : 'infirmant'} (${Math.round(dist)} m)`, version: c.version + 1 });
    this.event(user, 'review_case.field_verified', 'review_case', c.id, c, saved, input.observations, { confirme: input.confirme, distanceM: Math.round(dist) });
    return { evidenceId: e.id, dossier: this.caseSummary(saved), decision: 'Réservée au réviseur habilité (paramètre « agentTerrainPeutVerifier » : par défaut non).' };
  }

  private acceptedEvidence(c: PropertyClaim): ClaimEvidence[] {
    const accepted = CONFIG_BIENS.preuvesAccepteesParRole.valeur[c.role];
    return this.evidence.find((e) => e.claimId === c.id && accepted.includes(e.evidenceType));
  }

  /** Décision d'un réviseur habilité sur un dossier (vérification, rejet, pièce demandée, remplacement, fusion). */
  decide(user: User, id: string, input: { decision: string; reason: string; validFrom?: string; validTo?: string; canonicalTargetId?: string; claimId?: string; version?: number }) {
    if (!this.isReviewer(user)) throw forbidden('FORBIDDEN', 'Décision réservée aux réviseurs habilités (jamais un administrateur technique, jamais l’IA).');
    const rc = this.reviewCase(id);
    this.checkVersion(rc, input.version);
    if (rc.status === 'DECIDE') throw conflict('CASE_DECIDED', 'Dossier déjà décidé : un nouveau dossier (appel) est nécessaire.');
    if (!this.inTerritory(user, rc.commune)) throw forbidden('OUT_OF_TERRITORY', 'Dossier hors de votre territoire.');
    if (!input.reason || input.reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Motif obligatoire.');
    this.checkDates(input.validFrom, input.validTo);
    if (rc.reasonCode === 'FUSION_BIENS') return this.decideMerge(user, rc, input);
    if (rc.reasonCode === 'CHEVAUCHEMENT_LOCATION_EXCLUSIVE') return this.decideOverlap(user, rc, input);
    let c = this.claim(rc.claimId!);
    assertDistinctPerson(user.id, [c.createdBy], 'Le déclarant ne décide pas de sa propre revendication.');
    assertNotRelated(user, c.accountId, 'Conflit d’intérêts : le réviseur est lié à la personne qui revendique.');
    const decision = input.decision.toUpperCase();
    // Contestation, bien signalé erroné, appel : le dossier passe d'abord « en revue ».
    if (c.status === 'DISPUTED') c = this.transition(c, 'UNDER_REVIEW', user, 'Dossier pris en revue');
    if (rc.reasonCode === 'APPEL' && c.status === 'REJECTED') c = this.transition(c, 'UNDER_REVIEW', user, 'Appel instruit');
    if (decision === 'VERIFIED') {
      if (!c.relationId || !c.targetId) throw unprocessable('NO_TARGET', 'Revendication sans bien cible : choisir un candidat ou déclarer le bien.');
      if (!this.acceptedEvidence(c).length) throw unprocessable('EVIDENCE_INSUFFICIENT', `Aucune pièce acceptée pour le rôle ${c.role} (${CONFIG_BIENS.preuvesAccepteesParRole.valeur[c.role].join(', ')}) — une invitation acceptée ou un rapprochement ne suffisent pas.`);
      const from = input.validFrom ?? c.validFrom ?? this.d.today();
      const to = input.validTo ?? c.validTo;
      this.checkDates(from, to);
      const rel = this.relations.get(c.relationId);
      const method = this.acceptedEvidence(c).some((e) => e.evidenceType === 'CONSTAT_TERRAIN') ? 'AGENT_TERRAIN' as const : 'PREUVE_DOCUMENTAIRE' as const;
      // Dates retenues par le réviseur ; même circuit de validation que le module 7 (M07-C2, quotes-parts, redevable).
      const relNow = this.relations.relations.update({ ...rel, from, ...(to ? { to } : {}), history: [...rel.history, { at: this.now(), by: user.id, action: 'DATES_RETENUES', reason: `Du ${from}${to ? ` au ${to}` : ''}` }] });
      this.relations.applyValidation(user, relNow, input.reason, method);
      c = this.transition(c, 'VERIFIED', user, input.reason, { validFrom: from, ...(to ? { validTo: to } : {}) });
      this.flagExclusiveOverlap(user, c);
    } else if (decision === 'REJECTED') {
      c = this.transition(c, 'REJECTED', user, input.reason);
      if (c.relationId) this.relations.setFromClaim(c.relationId, { status: 'REJETEE', decisionReason: input.reason, validatedBy: user.id, validatedAt: this.now() }, user.id, 'REJETEE', input.reason);
    } else if (decision === 'NEEDS_EVIDENCE') {
      c = this.transition(c, 'NEEDS_EVIDENCE', user, input.reason);
    } else if (decision === 'SUPERSEDED') {
      c = this.transition(c, 'SUPERSEDED', user, input.reason);
      if (c.relationId) this.relations.setFromClaim(c.relationId, { status: 'REJETEE', decisionReason: input.reason }, user.id, 'REMPLACEE', input.reason);
    } else throw badRequest('UNKNOWN_DECISION', 'Décision attendue : VERIFIED, REJECTED, NEEDS_EVIDENCE ou SUPERSEDED.');
    const closed = decision !== 'NEEDS_EVIDENCE';
    const saved = this.cases.update({ ...rc, status: closed ? 'DECIDE' : 'EN_COURS', assigneeId: user.id, decision: { decision, reason: input.reason, by: user.id, at: this.now(), ...(c.validFrom ? { validFrom: c.validFrom } : {}), ...(c.validTo ? { validTo: c.validTo } : {}) }, version: rc.version + 1 });
    this.event(user, `review_case.decided`, 'review_case', rc.id, rc, saved, input.reason, { decision, claimId: c.id });
    return { dossier: this.caseSummary(saved), revendication: { id: c.id, statut: c.status, du: c.validFrom ?? null, au: c.validTo ?? null }, reviseur: user.id, motif: input.reason };
  }

  /** Nouvelle occupation vérifiée qui chevauche une location exclusive vérifiée : dossier de revue, rien n'est retiré. */
  private flagExclusiveOverlap(user: User, c: PropertyClaim): void {
    if (!EXCLUSIVE_TENANCY.includes(c.role) || c.jointTenancy || !c.targetId) return;
    const overl = this.claims.find((x) => x.id !== c.id && x.targetId === c.targetId && EXCLUSIVE_TENANCY.includes(x.role) && !x.jointTenancy && x.status === 'VERIFIED'
      && (x.validFrom ?? '0000') <= (c.validTo ?? '9999-12-31') && (c.validFrom ?? '0000') <= (x.validTo ?? '9999-12-31'));
    if (!overl.length) return;
    this.openCase(user, { reasonCode: 'CHEVAUCHEMENT_LOCATION_EXCLUSIVE', claimId: c.id, relatedClaimIds: [c.id, ...overl.map((x) => x.id)], commune: this.ctx.objects.get(c.targetId).commune, note: 'Deux locations exclusives vérifiées se chevauchent : aucune n’est retirée d’office.' });
  }

  private decideOverlap(user: User, rc: ReviewCase, input: { decision: string; reason: string; claimId?: string }) {
    const decision = input.decision.toUpperCase();
    if (decision === 'SUPERSEDED') {
      if (!input.claimId || !rc.relatedClaimIds.includes(input.claimId)) throw badRequest('CLAIM_REQUIRED', 'Préciser la revendication remplacée (claimId) parmi celles du dossier.');
      let c = this.claim(input.claimId);
      c = this.transition(c, 'DISPUTED', user, input.reason);
      c = this.transition(c, 'UNDER_REVIEW', user, input.reason);
      c = this.transition(c, 'SUPERSEDED', user, input.reason);
      if (c.relationId) this.relations.setFromClaim(c.relationId, { status: 'REJETEE', decisionReason: input.reason }, user.id, 'REMPLACEE', input.reason);
    } else if (decision !== 'MAINTENIR') throw badRequest('UNKNOWN_DECISION', 'Décision attendue : MAINTENIR ou SUPERSEDED (avec claimId).');
    const saved = this.cases.update({ ...rc, status: 'DECIDE', assigneeId: user.id, decision: { decision, reason: input.reason, by: user.id, at: this.now(), ...(input.claimId ? { claimId: input.claimId } : {}) }, version: rc.version + 1 });
    this.event(user, 'review_case.decided', 'review_case', rc.id, rc, saved, input.reason, { decision });
    return { dossier: this.caseSummary(saved), reviseur: user.id, motif: input.reason };
  }

  /**
   * Fusion de biens revue : cible canonique explicite, motif, identité du réviseur, audit ; transactionnelle (tout est
   * contrôlé avant la première écriture) ; alias et anciens identifiants conservés ; bloquée si des identifiants
   * officiels VÉRIFIÉS divergent (dossier escaladé).
   */
  private decideMerge(user: User, rc: ReviewCase, input: { decision: string; reason: string; canonicalTargetId?: string }) {
    const decision = input.decision.toUpperCase();
    const [a, b] = rc.merge!.recordIds;
    if (decision === 'REJETER' || decision === 'REJECTED') {
      const saved = this.cases.update({ ...rc, status: 'DECIDE', assigneeId: user.id, decision: { decision: 'REJETER', reason: input.reason, by: user.id, at: this.now() }, version: rc.version + 1 });
      this.event(user, 'property_merge.rejected', 'review_case', rc.id, rc, saved, input.reason);
      return { dossier: this.caseSummary(saved), reviseur: user.id, motif: input.reason };
    }
    if (decision !== 'FUSIONNER' && decision !== 'MERGE') throw badRequest('UNKNOWN_DECISION', 'Décision attendue : FUSIONNER (avec canonicalTargetId) ou REJETER.');
    if (!input.canonicalTargetId || ![a, b].includes(input.canonicalTargetId)) throw badRequest('CANONICAL_TARGET_REQUIRED', 'Cible canonique explicite requise (l’un des deux enregistrements du dossier).');
    const canonical = this.ctx.objects.get(input.canonicalTargetId);
    const alias = this.ctx.objects.get(input.canonicalTargetId === a ? b : a);
    if (recordStatusOf(canonical) !== 'CANONICAL') throw conflict('CANONICAL_TARGET_NOT_CANONICAL', 'La cible choisie doit être un bien de référence (validé) : validez-le d’abord.');
    if (recordStatusOf(alias) === 'ARCHIVED_ALIAS') throw conflict('ALREADY_MERGED', 'Enregistrement déjà archivé comme alias.');
    if (alias.category !== canonical.category) throw unprocessable('CATEGORY_MISMATCH', 'Deux enregistrements de niveaux différents ne se fusionnent pas.');
    const refsA = this.addrOf(canonical).officialRefs.filter((r) => r.verified && r.namespace !== 'MOSOLO-IGF');
    const refsB = this.addrOf(alias).officialRefs.filter((r) => r.verified && r.namespace !== 'MOSOLO-IGF');
    const conflictRef = refsA.some((x) => refsB.some((y) => y.namespace === x.namespace && y.value !== x.value));
    const igfConflict = !!canonical.igf && !!alias.igf && canonical.igf.code !== alias.igf.code && alias.status === 'VALIDE';
    if (conflictRef || igfConflict) {
      const escalated = this.cases.update({ ...rc, status: 'ESCALADE', note: `${rc.note ? `${rc.note} · ` : ''}Fusion bloquée : identifiants officiels vérifiés divergents.`, version: rc.version + 1 });
      this.event(user, 'property_merge.blocked', 'review_case', rc.id, rc, escalated, 'Identifiants officiels vérifiés divergents');
      throw conflict('MERGE_BLOCKED_OFFICIAL_REF_CONFLICT', 'Fusion bloquée : les identifiants officiels vérifiés des deux enregistrements divergent. Dossier escaladé.', { caseId: rc.id });
    }
    // Plan complet (aucune écriture avant contrôle) : revendications, relations et enfants rattachés à l'alias.
    const claimsToMove = this.claims.find((c) => c.targetId === alias.id);
    const relsToMove = this.relations.ofObject(alias.id);
    const children = this.ctx.objects.objects.find((o) => o.id !== alias.id && parentIdOf(o) === alias.id);
    const at = this.now();
    for (const c of claimsToMove) {
      const moved = this.claims.update({ ...c, targetId: canonical.id, originalTargetId: c.originalTargetId ?? alias.id, version: c.version + 1, updatedAt: at });
      this.event(user, 'property_claim.remapped', 'property_claim', c.id, c, moved, input.reason, { from: alias.id, to: canonical.id, caseId: rc.id });
    }
    for (const r of relsToMove) this.relations.setFromClaim(r.id, { objectId: canonical.id, originalObjectId: r.originalObjectId ?? alias.id }, user.id, 'TRANSFEREE_PAR_FUSION', `${alias.id} → ${canonical.id} (${rc.id})`);
    for (const ch of children) this.ctx.objects.setRecordMeta(ch.id, { parentObjectId: canonical.id });
    const beforeAlias = { ...alias };
    const archived = this.ctx.objects.setRecordMeta(alias.id, { recordStatus: 'ARCHIVED_ALIAS', aliasOf: canonical.id });
    const applied = { canonicalId: canonical.id, aliasId: alias.id, remappedClaims: claimsToMove.map((c) => c.id), remappedRelations: relsToMove.map((r) => r.id), remappedChildren: children.map((c) => c.id), at };
    const saved = this.cases.update({ ...rc, status: 'DECIDE', assigneeId: user.id, merge: { ...rc.merge!, applied }, decision: { decision: 'FUSIONNER', reason: input.reason, by: user.id, at, canonicalTargetId: canonical.id }, version: rc.version + 1 });
    this.event(user, 'property_merge.applied', 'fiscal_object', alias.id, { ...beforeAlias, recordStatus: recordStatusOf(beforeAlias) }, archived, input.reason, { canonicalId: canonical.id, caseId: rc.id, remappedClaims: applied.remappedClaims.length, remappedRelations: applied.remappedRelations.length });
    return { dossier: this.caseSummary(saved), fusion: applied, reviseur: user.id, motif: input.reason };
  }

  // ─────────── Déclaration du propriétaire (propriétaire d'abord) ───────────

  declareProperty(user: User, input: {
    plot: { commune: string; quartier: string; avenue?: string; number?: string; official_ref?: string; official_namespace?: string; lat: number; lon: number; localityRank?: 1 | 2 | 3 | 4 };
    building?: { label?: string };
    units?: { label: string; floor?: string; useType?: PropertyClaim['useType']; locataireConnu?: { contact: string; channel?: PropertyInvitation['deliveryChannel'] } }[];
    role?: string; share?: string; validFrom?: string; target?: 'PLOT' | 'BUILDING';
  }) {
    const accountId = this.selfAccount(user);
    const role = toClaimRole(input.role ?? 'OWNER');
    if (!OWNERSHIP_CLAIMS.includes(role)) throw badRequest('ROLE_NOT_ALLOWED', 'Déclaration d’un bien : rôle propriétaire ou gestionnaire.');
    if (!isCommune(input.plot.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.plot.commune}`);
    this.checkDates(input.validFrom);
    const labels = (input.units ?? []).map((u) => normAddr(u.label));
    if (new Set(labels).size !== labels.length) throw unprocessable('DUPLICATE_UNIT_LABEL', 'Chaque libellé d’unité est unique dans un bâtiment.');
    const entered = Object.fromEntries(Object.entries(input.plot).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const base = { commune: input.plot.commune, quartier: input.plot.quartier, localityRank: input.plot.localityRank ?? 4 as const, lat: input.plot.lat, lon: input.plot.lon, ...(input.plot.avenue ? { avenue: input.plot.avenue } : {}), addressEntered: entered };
    const plot = this.ctx.objects.createSelfReported(user.id, {
      ...base, category: 'PARCELLE', attributes: { ...(input.plot.number ? { numero: input.plot.number } : {}), ...(input.plot.avenue ? { avenue: input.plot.avenue } : {}) },
      ...(input.plot.official_ref ? { officialRef: { value: input.plot.official_ref, namespace: input.plot.official_namespace ?? 'KIN-CADASTRE', issuer: 'Déclaré par la personne', verified: false } } : {}),
    });
    const building = this.ctx.objects.createSelfReported(user.id, { ...base, category: 'BATIMENT', attributes: {}, parentObjectId: plot.id, buildingLabel: input.building?.label ?? 'A' });
    const unitsIn = input.units?.length ? input.units : [{ label: 'MAIN' }];
    const units = unitsIn.map((u) => this.ctx.objects.createSelfReported(user.id, { ...base, category: 'UNITE_LOCATIVE', attributes: {}, parentObjectId: building.id, unitLabel: u.label, ...(u.floor ? { floor: u.floor } : {}), ...('useType' in u && u.useType ? { useType: u.useType } : {}) }));
    const target = input.target === 'PLOT' ? plot : building;
    let c = this.newClaim(accountId, user.id, { role, targetType: input.target ?? 'BUILDING', ...(input.share ? { share: input.share } : {}), ...(input.validFrom ? { validFrom: input.validFrom } : {}), origin: 'DECLARATION_PROPRIETAIRE', address: { commune: input.plot.commune, quartier: input.plot.quartier, ...(input.plot.avenue ? { avenue: input.plot.avenue } : {}), ...(input.plot.number ? { number: input.plot.number } : {}), ...(input.plot.official_ref ? { official_ref: input.plot.official_ref } : {}) } });
    c = this.transition(c, 'SUBMITTED', user, 'Bien déclaré par le propriétaire');
    c = this.attachTarget(user, c, target, false);
    // Locataires connus : invitations opaques (aucun compte créé, aucune donnée de la personne invitée conservée en clair).
    const invitations = unitsIn.flatMap((u, i) => ('locataireConnu' in u && u.locataireConnu ? [this.createInvitation(user.id, c, { contact: u.locataireConnu.contact, ...(u.locataireConnu.channel ? { channel: u.locataireConnu.channel } : {}), inviteRole: 'TENANT', targetUnitId: units[i]!.id })] : []));
    const doublons = this.queueDuplicateReview(user, [plot, building, ...units]);
    return {
      ...this.claimantView(c), plotId: plot.id, buildingId: building.id, units: units.map((u) => ({ id: u.id, label: u.unitLabel })), invitations,
      doublonsEnRevue: doublons.length, statutEnregistrement: 'PROVISIONAL',
    };
  }

  // ─────────── Vues (confidentialité § 8) ───────────

  private verifiedHolderOnBranch(accountId: string, objectId: string): boolean {
    const o = this.ctx.objects.objects.get(objectId);
    if (!o) return false;
    const a = this.ancestors(o);
    const ids = new Set([o.id, a.building?.id, a.plot?.id].filter(Boolean) as string[]);
    return this.claims.find((c) => c.accountId === accountId && c.status === 'VERIFIED' && OWNERSHIP_CLAIMS.includes(c.role) && !!c.targetId && ids.has(c.targetId)).length > 0
      || this.relations.ofTaxpayer(accountId).some((r) => r.status === 'VALIDEE' && ['PROPRIETAIRE', 'COPROPRIETAIRE', 'GESTIONNAIRE', 'USUFRUITIER'].includes(r.role) && ids.has(r.objectId));
  }

  /** Vue du revendicateur : jamais le nom, le téléphone, le compte ou les pièces d'une autre partie. */
  claimantView(c: PropertyClaim) {
    const target = c.targetId ? this.ctx.objects.objects.get(c.targetId) : undefined;
    const nowIso = this.now();
    const counterpart = c.status === 'VERIFIED' && target && (['TENANT', 'SUBTENANT', 'OCCUPANT', 'OPERATOR'] as ClaimRole[]).includes(c.role) && CONFIG_BIENS.divulgation.valeur.locataireVoitDesignationProprietaire
      ? this.ownerDesignation(target) : null;
    return {
      claimId: c.id, role: c.role, statut: c.status, statutLibelle: CLAIM_STATUS_LABELS[c.status], typeCible: c.targetType, version: c.version,
      du: c.validFrom ?? null, au: c.validTo ?? null, usage: c.useType, colocation: !!c.jointTenancy, quotePart: c.share ?? null, origine: c.origin,
      bien: target ? {
        id: target.id, libelle: this.safeLabel(target), statutEnregistrement: recordStatusOf(target), provenance: target.recordProvenance ?? (target.status === 'VALIDE' ? 'ADMINISTRATION' : 'DECLARATION'),
        confiance: recordStatusOf(target) === 'CANONICAL' ? 'ELEVEE' : 'FAIBLE',
      } : null,
      adresseSaisie: c.address ?? null,
      pieces: this.evidence.find((e) => e.claimId === c.id && (e.submittedBy === c.createdBy || e.evidenceType === 'INVITATION_ACCEPTEE' || e.evidenceType.startsWith('CONSTAT_TERRAIN'))).map((e) => ({ id: e.id, type: e.evidenceType, sha256: e.sha256, deposeeLe: e.submittedAt, statut: e.reviewStatus })),
      invitations: this.invitations.find((i) => i.claimId === c.id).map((i) => ({
        id: i.id, contact: i.contactMasked, expireLe: i.expiresAt,
        // Un refus ne se distingue pas d'une expiration : on ne révèle pas l'existence d'un compte.
        statut: i.status === 'ACCEPTEE' ? 'ACCEPTEE' : i.status === 'EN_ATTENTE' && i.expiresAt > nowIso ? 'EN_ATTENTE' : 'SANS_SUITE',
      })),
      designationProprietaire: counterpart,
      historique: c.history,
      mentionJuridique: MENTION_JURIDIQUE,
    };
  }

  /** Désignation du propriétaire (pour l'attestation du locataire), après vérification seulement. */
  private ownerDesignation(target: FiscalObject): string | null {
    const a = this.ancestors(target);
    const ids = new Set([target.id, a.building?.id, a.plot?.id].filter(Boolean) as string[]);
    const owners = this.relations.relations.find((r) => ids.has(r.objectId) && r.status === 'VALIDEE' && (r.role === 'PROPRIETAIRE' || r.role === 'COPROPRIETAIRE'));
    if (!owners.length) return null;
    return owners.map((r) => this.ctx.taxpayers.taxpayers.get(r.taxpayerId)?.fullName ?? '—').join(' ; ');
  }

  /** GET /v1/moi/relations-biens : revendications en cours et historiques de la personne (compte de la session). */
  mine(user: User) {
    const accountId = this.selfAccount(user);
    const claims = this.claims.find((c) => c.accountId === accountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Relations anciennes du module 7 (sans revendication) : affichées avec leur état équivalent.
    const legacy = this.relations.ofTaxpayer(accountId).filter((r) => !r.claimId).map((r) => {
      const o = this.ctx.objects.objects.get(r.objectId);
      return { relationId: r.id, role: r.role, statut: claimStatusOfRelation(r), statutModule7: r.status, du: r.from, au: r.to ?? null, bien: o ? { id: o.id, libelle: this.safeLabel(o), statutEnregistrement: recordStatusOf(o) } : null };
    });
    const views = claims.map((c) => this.claimantView(c));
    this.event(user, 'property_relationships.read', 'taxpayer', accountId, null, null);
    return {
      compte: accountId,
      actuelles: views.filter((v) => v.statut !== 'ENDED' && v.statut !== 'REJECTED' && v.statut !== 'SUPERSEDED'),
      historiques: views.filter((v) => v.statut === 'ENDED' || v.statut === 'REJECTED' || v.statut === 'SUPERSEDED'),
      relationsModule7: legacy,
      parStatut: CLAIM_STATUSES.map((s) => ({ statut: s, libelle: CLAIM_STATUS_LABELS[s], nombre: claims.filter((c) => c.status === s).length })),
      mentionJuridique: MENTION_JURIDIQUE,
    };
  }

  /**
   * Vue du propriétaire (bâtiment) : unités, occupation VÉRIFIÉE (rôle et période, loyer du bail qu'il a lui-même
   * déclaré pour l'IRL), revendications en attente MASQUÉES — jamais l'identité, le foyer, les revenus ni les pièces
   * des occupants. Réservée au titulaire d'une relation de propriété ou de gestion VÉRIFIÉE.
   */
  ownerView(user: User, objectId: string, date?: string) {
    const accountId = this.selfAccount(user);
    const o = this.ctx.objects.get(objectId);
    if (!this.verifiedHolderOnBranch(accountId, o.id)) {
      this.event(user, 'owner_view.denied', 'fiscal_object', o.id, null, null, 'Relation de propriété non vérifiée');
      throw forbidden('RELATION_NOT_VERIFIED', 'Vue réservée au propriétaire ou gestionnaire dont la relation est vérifiée.');
    }
    const day = date ?? this.d.today();
    const a = this.ancestors(o);
    const building = o.category === 'BATIMENT' ? o : a.building ?? o;
    const unitList = building.category === 'BATIMENT' ? this.childrenOf(building).filter((u) => u.category === 'UNITE_LOCATIVE') : [o];
    const units = unitList.map((u) => {
      const occ = this.relations.effectiveAt(u.id, day, OCCUPANCY_ROLES);
      const pending = this.claims.find((c) => c.targetId === u.id && OPEN_STATUSES.includes(c.status) && c.accountId !== accountId);
      const leases = this.ctx.objects.leases.find((l) => l.unitObjectId === u.id && l.lessorId === accountId && l.start <= day && (!l.end || l.end >= day));
      return {
        id: u.id, libelle: u.unitLabel ?? this.safeLabel(u), statutEnregistrement: recordStatusOf(u),
        occupation: occ.length ? 'OCCUPEE' : 'VACANTE',
        occupationsVerifiees: occ.map((r) => ({ role: r.role, du: r.from, au: r.to ?? null, colocation: !!r.jointTenancy })),
        revendicationsEnAttente: pending.map((c) => ({ reference: c.id, role: c.role, statut: c.status })),
        loyerIRL: leases.map((l) => ({ bail: l.id, loyer: l.rent, periodicite: l.periodicity, du: l.start, au: l.end ?? null })),
      };
    });
    this.event(user, 'owner_view.read', 'fiscal_object', building.id, null, null, undefined, { units: units.length, date: day });
    return {
      bien: { id: building.id, libelle: this.safeLabel(building), statutEnregistrement: recordStatusOf(building), provenance: building.recordProvenance ?? null },
      date: day, unites: units,
      synthese: { unites: units.length, occupees: units.filter((u) => u.occupation === 'OCCUPEE').length, vacantes: units.filter((u) => u.occupation === 'VACANTE').length, enAttente: units.reduce((s, u) => s + u.revendicationsEnAttente.length, 0) },
      confidentialite: 'Aucune identité, aucun foyer, aucun revenu ni aucune pièce des occupants n’est affiché.',
    };
  }

  /** Vue datée des modules en aval (IRL, IF, baux) : relations VÉRIFIÉES à la date, rôles permis. */
  effective(user: User, input: { objectId: string; date: string; roles?: RelationRole[] }) {
    if (!evaluate(user, 'biens:effective.read')) throw forbidden('FORBIDDEN', 'Vue datée réservée aux agents habilités des modules en aval.');
    this.checkDates(input.date);
    const o = this.ctx.objects.get(input.objectId);
    const rels = this.relations.effectiveAt(o.id, input.date, input.roles);
    this.event(user, 'effective_relationships.read', 'fiscal_object', o.id, null, null, undefined, { date: input.date, count: rels.length });
    return {
      objectId: o.id, date: input.date, statut: 'VERIFIED',
      relations: rels.map((r) => ({ relationId: r.id, compte: r.taxpayerId, role: r.role, quotePart: r.share ?? null, du: r.from, au: r.to ?? null, methode: r.verificationMethod ?? 'PREUVE_DOCUMENTAIRE' })),
      avertissement: 'Seules les relations VÉRIFIÉES à la date sont servies ; une revendication non vérifiée n’alimente aucune liquidation définitive.',
    };
  }

  /** Éléments du compte unique (rubrique RELATION) : ses propres revendications seulement. */
  compteElements(accountId: string) {
    return this.claims.find((c) => c.accountId === accountId).map((c) => {
      const target = c.targetId ? this.ctx.objects.objects.get(c.targetId) : undefined;
      return {
        rubrique: 'RELATION' as const, id: c.id, libelle: `${c.role} — ${target ? this.safeLabel(target) : (c.address ? `${c.address.avenue ?? ''} ${c.address.number ?? ''}, ${c.address.commune}`.trim() : 'adresse à compléter')}`,
        nature: c.role, statut: c.status, ...(c.validFrom ? { date: c.validFrom } : {}), ...(c.validTo ? { echeance: c.validTo } : {}), ...(c.targetId ? { objectId: c.targetId } : {}), lien: '/espace/biens-relations',
      };
    });
  }
}
