/**
 * Module 26 — Moteur de règles juridiques et tarifaires : veille, archivage et indicateurs (Spécification fonctionnelle).
 *
 *  - Veille : règles expirantes (date de fin dans l'horizon demandé), conflits de normes — texte abrogé ou non en vigueur
 *    cité par une règle ACTIVE, deux règles ACTIVES qui revendiquent le même fait générateur pour des entités
 *    différentes (doublon d'administration), versions ACTIVES concurrentes d'un même code sur des périodes qui se
 *    chevauchent, catégorie non liquidable par la province (pouvoir central, ETD, acte nouveau) à l'état ACTIVE.
 *  - Archivage (cycle de vie : … suspendue, archivée) à quatre yeux : demande motivée par un juriste, confirmation par
 *    une AUTRE personne ; seule une version qui ne produit plus d'obligation (brouillon, revue, expirée, abrogée) est
 *    archivée ; le code reste réservé (jamais réutilisé) et la version reste consultable.
 *  - Indicateurs : règles actives validées (quatre visas distincts), règles expirant, délai d'approbation
 *    (création → publication), demandes en attente de visa.
 * L'horizon de veille est un paramètre d'affichage (par défaut 90 jours — à confirmer par le maître d'ouvrage).
 */
import { REQUIRED_APPROVALS, refusParCategorie } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { RuleRecord } from './service.js';

/** Horizon de veille par défaut (jours) — paramètre d'affichage, à confirmer par le maître d'ouvrage. */
export const WATCH_HORIZON_DAYS_DEFAULT = 90;
const ARCHIVABLE = ['BROUILLON', 'REVUE_JURIDIQUE', 'REVUE_FINANCIERE', 'EXPIREE', 'ABROGEE'];
const LIVE = ['ACTIVE', 'PUBLIEE'];

export interface ArchiveRequest {
  id: string; ruleId: string; ruleCode: string; version: number; statusBefore: string; motif: string;
  requestedBy: string; requestedAt: string; status: 'DEMANDEE' | 'CONFIRMEE' | 'REFUSEE';
  decision?: { by: string; at: string; motif: string };
}

export interface NormConflict { kind: 'TEXTE_ABROGE' | 'TEXTE_NON_EN_VIGUEUR' | 'DOUBLON_ADMINISTRATION' | 'VERSIONS_CONCURRENTES' | 'COMPETENCE'; ruleIds: string[]; detail: string }

const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00.000Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const overlap = (a: RuleRecord, b: RuleRecord) => a.effectiveFrom <= (b.effectiveTo ?? '9999-12-31') && b.effectiveFrom <= (a.effectiveTo ?? '9999-12-31');
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class RuleWatchService {
  readonly archives = new InMemoryRepository<ArchiveRequest>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private today(): string { return kinshasaDate(this.ctx.clock.now()); }

  expiring(horizonDays: number) {
    const today = this.today();
    const limit = addDays(today, horizonDays);
    return this.ctx.rules.list().filter((r) => LIVE.includes(r.status) && !!r.effectiveTo && r.effectiveTo >= today && r.effectiveTo <= limit)
      .map((r) => ({ ruleId: r.id, code: r.code, version: r.version, label: r.label, status: r.status, effectiveTo: r.effectiveTo!, daysLeft: Math.round((Date.parse(`${r.effectiveTo}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000), successor: this.ctx.rules.list().some((x) => x.code === r.code && x.version > r.version) }))
      .sort((a, b) => a.effectiveTo.localeCompare(b.effectiveTo));
  }

  conflicts(): NormConflict[] {
    const rules = this.ctx.rules.list();
    const live = rules.filter((r) => LIVE.includes(r.status));
    const out: NormConflict[] = [];
    for (const r of live) {
      for (const id of r.legalInstrumentIds) {
        const inst = this.ctx.rules.instrument(id);
        if (!inst) continue;
        if (inst.status === 'ABROGE') out.push({ kind: 'TEXTE_ABROGE', ruleIds: [r.id], detail: `${r.code} v${r.version} cite ${inst.id} (${inst.title}), abrogé${inst.abrogatedOn ? ` le ${inst.abrogatedOn}` : ''}.` });
        else if (!['EN_VIGUEUR', 'MODIFIE'].includes(inst.status)) out.push({ kind: 'TEXTE_NON_EN_VIGUEUR', ruleIds: [r.id], detail: `${r.code} v${r.version} cite ${inst.id} au statut ${inst.status}.` });
      }
      const refusal = refusParCategorie(r.revenueCategory, r.administeringEntity);
      if (refusal) out.push({ kind: 'COMPETENCE', ruleIds: [r.id], detail: `${r.code} v${r.version} : ${refusal.detail}` });
    }
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i]!; const b = live[j]!;
        if (!overlap(a, b)) continue;
        if (a.code === b.code) { out.push({ kind: 'VERSIONS_CONCURRENTES', ruleIds: [a.id, b.id], detail: `Deux versions en vigueur de ${a.code} (v${a.version}, v${b.version}) sur des périodes qui se chevauchent.` }); continue; }
        // Même fait générateur : libellé normalisé identique (et même nature si les deux fiches la renseignent).
        const sameEvent = norm(a.taxableEvent) === norm(b.taxableEvent) && (!a.taxableEventKind || !b.taxableEventKind || a.taxableEventKind === b.taxableEventKind);
        if (sameEvent && a.administeringEntity !== b.administeringEntity && a.revenueCategory !== 'PENALITE' && b.revenueCategory !== 'PENALITE') {
          out.push({ kind: 'DOUBLON_ADMINISTRATION', ruleIds: [a.id, b.id], detail: `Même fait générateur (« ${a.taxableEvent} ») revendiqué par ${a.administeringEntity} (${a.code}) et ${b.administeringEntity} (${b.code}) : arbitrage requis, aucune obligation en double.` });
        }
      }
    }
    return out;
  }

  indicators(horizonDays: number) {
    const rules = this.ctx.rules.list();
    const validated = rules.filter((r) => r.status === 'ACTIVE' && REQUIRED_APPROVALS.every((role) => r.approvals.some((a) => a.role === role)) && new Set(r.approvals.map((a) => a.userId)).size >= 4);
    const delays = rules.filter((r) => r.publishedAt && r.createdAt).map((r) => (Date.parse(r.publishedAt!) - Date.parse(r.createdAt)) / 86_400_000).sort((a, b) => a - b);
    const round1 = (x: number) => Math.round(x * 10) / 10;
    const pending = rules.filter((r) => ['BROUILLON', 'REVUE_JURIDIQUE', 'REVUE_FINANCIERE', 'APPROUVEE'].includes(r.status));
    const now = this.ctx.clock.now().getTime();
    return {
      activeValidated: validated.length, active: rules.filter((r) => r.status === 'ACTIVE').length,
      expiring: this.expiring(horizonDays).length, horizonDays,
      approvalDelayDays: delays.length ? { measured: true, count: delays.length, mean: round1(delays.reduce((a, b) => a + b, 0) / delays.length), median: round1(delays[Math.floor(delays.length / 2)]!), max: round1(delays[delays.length - 1]!) }
        : { measured: false, reason: 'Aucune règle publiée par le circuit à quatre visas : délai non mesurable.' },
      pendingApprovals: pending.map((r) => ({ ruleId: r.id, code: r.code, version: r.version, status: r.status, ageDays: round1((now - Date.parse(r.createdAt)) / 86_400_000), nextVisa: REQUIRED_APPROVALS[r.approvals.length] ?? null })),
      archived: rules.filter((r) => r.status === 'ARCHIVEE').length,
    };
  }

  view(user: User, horizonDays = WATCH_HORIZON_DAYS_DEFAULT) {
    authorize(user, 'rule.read');
    if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 3650) throw badRequest('INVALID_HORIZON', 'Horizon de veille : 1 à 3650 jours.');
    return {
      generatedAt: this.ctx.clock.now().toISOString(), horizonDays, horizonNote: `Horizon de veille par défaut ${WATCH_HORIZON_DAYS_DEFAULT} jours — à confirmer par le maître d’ouvrage.`,
      expiring: this.expiring(horizonDays), conflicts: this.conflicts(), indicators: this.indicators(horizonDays),
      archives: this.archives.all().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    };
  }

  requestArchive(user: User, ruleId: string, motif: string) {
    authorize(user, 'rule.approve');
    if (!user.roles.some((r) => r === 'R13' || r === 'R14')) throw badRequest('ARCHIVE_REQUESTER', 'La demande d’archivage est portée par un juriste (rédaction ou vérification).');
    const r = this.ctx.rules.get(ruleId);
    if (!ARCHIVABLE.includes(r.status)) throw conflict('RULE_NOT_ARCHIVABLE', `Version au statut ${r.status} : seule une version qui ne produit plus d’obligation (${ARCHIVABLE.join(', ')}) est archivée.`);
    if (this.archives.findOne((a) => a.ruleId === ruleId && a.status === 'DEMANDEE')) throw conflict('ARCHIVE_PENDING', 'Une demande d’archivage est déjà en attente.');
    const a = this.archives.insert({ id: this.ids.next('ARC-REG'), ruleId, ruleCode: r.code, version: r.version, statusBefore: r.status, motif, requestedBy: user.id, requestedAt: this.ctx.clock.now().toISOString(), status: 'DEMANDEE' });
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.archive.requested', resourceType: 'rule', resourceId: ruleId, details: { requestId: a.id, statusBefore: r.status, motif } });
    return a;
  }

  decideArchive(user: User, requestId: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'rule.approve');
    const a = this.archives.get(requestId);
    if (!a) throw notFound('ARCHIVE_REQUEST_NOT_FOUND', `Demande inconnue : ${requestId}`);
    if (a.status !== 'DEMANDEE') throw conflict('ARCHIVE_CLOSED', 'Demande déjà décidée.');
    try {
      assertDistinctPerson(user.id, [a.requestedBy], 'Quatre yeux : l’archivage est confirmé par une personne distincte de l’auteur de la demande.');
    } catch (e) {
      this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.archive.refused', resourceType: 'rule', resourceId: a.ruleId, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    const at = this.ctx.clock.now().toISOString();
    const r = this.ctx.rules.get(a.ruleId);
    if (input.approve && !ARCHIVABLE.includes(r.status)) throw conflict('RULE_NOT_ARCHIVABLE', `Version passée au statut ${r.status} depuis la demande.`);
    const saved = this.archives.update({ ...a, status: input.approve ? 'CONFIRMEE' : 'REFUSEE', decision: { by: user.id, at, motif: input.motif } });
    if (input.approve) {
      this.ctx.rules.rules.update({ ...r, status: 'ARCHIVEE', history: [...(r.history ?? []), { at, action: 'rule.archived', by: user.id, status: 'ARCHIVEE', detail: `Demande ${a.id} (${a.requestedBy}) — ${input.motif}` }] });
    }
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: input.approve ? 'rule.archived' : 'rule.archive.rejected', resourceType: 'rule', resourceId: a.ruleId, details: { requestId, motif: input.motif } });
    return saved;
  }
}

const cache = new WeakMap<AppContext, RuleWatchService>();
export function ruleWatchFor(ctx: AppContext): RuleWatchService {
  let s = cache.get(ctx);
  if (!s) { s = new RuleWatchService(ctx); cache.set(ctx, s); }
  return s;
}
