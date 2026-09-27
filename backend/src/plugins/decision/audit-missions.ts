/**
 * Audit et investigation (module 46, § 29.1, § 25.2) — espace de travail de l'audit interne, de l'inspection et des
 * auditeurs externes, SANS aucune capacité de modification des données métier :
 *  - lecture intégrale des preuves et journaux (journal chaîné, grand livre, pistes par dossier — renvois) ;
 *  - missions d'audit, échantillonnage reproductible (tirage déterministe par graine publiée), constats et
 *    recommandations suivies (déclaration du service audité, vérification par une autre personne de l'audit) ;
 *  - export scellé (empreinte SHA-256, signature, chaîne de possession : chaque remise est tracée et revérifiée) ;
 *  - racine quotidienne : état de la chaîne vérifié à la lecture (la publication des racines relève du scellement) ;
 *  - reconstitution d'une correction : original, contre-écriture, motif, approbateurs.
 */
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { canonicalJson } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { ExportSigner, EXPORT_KEY_ID } from '../pilotage/exports.js';
import type { PilotageService } from '../pilotage/service.js';
import { pctNum } from './common.js';

export const POPULATIONS = {
  PAIEMENTS: 'Ordres de paiement',
  OBLIGATIONS: 'Obligations (liquidations)',
  ECRITURES: 'Écritures du grand livre',
  EVENEMENTS_AUDIT: 'Événements du journal d’audit chaîné',
  EXONERATIONS: 'Exonérations et remises',
} as const;
export type Population = keyof typeof POPULATIONS;
export const FINDING_SEVERITIES = ['FAIBLE', 'MOYENNE', 'ELEVEE', 'CRITIQUE'] as const;
export type RecoStatus = 'EMISE' | 'MISE_EN_OEUVRE_DECLAREE' | 'MISE_EN_OEUVRE_VERIFIEE' | 'NON_RETENUE';

export interface Sample {
  id: string; population: Population; filters: { from?: string; to?: string; commune?: string }; size: number; seed: string;
  populationSize: number; populationSha256: string; items: string[]; method: 'TIRAGE_DETERMINISTE_SHA256'; at: string; by: string;
}
export interface Recommendation {
  id: string; text: string; ownerEntity: string; deadline: string; status: RecoStatus;
  followUps: { at: string; by: string; status: RecoStatus; note: string; evidenceSha256?: string }[];
}
export interface Finding {
  id: string; title: string; description: string; severity: (typeof FINDING_SEVERITIES)[number]; evidence: string[]; at: string; by: string; recommendations: Recommendation[];
}
export interface AuditMission {
  id: string; code: string; title: string; objective: string; scope: string; lead: string; status: 'EN_COURS' | 'CLOSE';
  createdAt: string; closedAt?: string; closure?: { by: string; motif: string }; samples: Sample[]; findings: Finding[];
}
export interface SealedExport {
  id: string; missionId: string; sha256: string; signature: string; keyId: string; payload: string; sealedAt: string; sealedBy: string;
}
/** Étape de la chaîne de possession (journal en ajout seul, distinct de l'export scellé lui-même). */
export interface CustodyStep { id: string; sealedId: string; step: 'SCELLE' | 'REMISE'; at: string; by: string; from: string; to: string; motif: string; sha256Verified: string }

/** Score de tirage : SHA-256(graine ‖ identifiant) — reproductible et vérifiable par un tiers. */
export function drawSample(ids: string[], seed: string, size: number): string[] {
  const score = (id: string) => createHash('sha256').update(`${seed}|${id}`).digest('hex');
  return [...ids].sort().map((id) => ({ id, s: score(id) })).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)).slice(0, size).map((x) => x.id);
}

type Fiscal = { exemptions?: { exemptions?: { all(): { id: string; requestedAt: string }[] } } };
type Tresor = { operations?: { all(): { id: string; kind: string; status: string; input: { ledgerEntryId?: string; reason?: string }; proposedBy: string; proposedAt: string; decidedBy?: string; decidedAt?: string; approvals?: { by: string; at: string }[]; decisionNote?: string }[] } };

export class AuditMissionService {
  readonly missions = new InMemoryRepository<AuditMission>();
  readonly sealed = new InMemoryAppendOnlyRepository<SealedExport>();
  readonly custody = new InMemoryAppendOnlyRepository<CustodyStep>();
  private readonly ids = new IdGenerator();
  private readonly signer: ExportSigner;

  constructor(private readonly ctx: AppContext, private readonly pil: () => PilotageService) {
    this.signer = new ExportSigner(ctx.secrets.auditHmacKey);
  }

  private now() { return this.ctx.clock.now().toISOString(); }
  private log(user: User, action: string, type: string, id: string, details: Record<string, unknown> = {}) {
    this.ctx.audit.append({ actor: actorOf(user), action: `decision.audit.${action}`, resourceType: type, resourceId: id, details });
  }
  private mission(id: string) {
    const m = this.missions.get(id);
    if (!m) throw notFound('MISSION_NOT_FOUND', `Mission d’audit inconnue : ${id}`);
    return m;
  }
  private open(id: string) {
    const m = this.mission(id);
    if (m.status === 'CLOSE') throw conflict('MISSION_CLOSED', 'Mission close : aucun ajout possible.');
    return m;
  }

  create(user: User, input: { title: string; objective: string; scope: string }) {
    authorize(user, 'decision:audit.write');
    const n = this.missions.count() + 1;
    const m = this.missions.insert({ id: this.ids.next('MIS'), code: `AUD-${this.now().slice(0, 4)}-${String(n).padStart(3, '0')}`, ...input, lead: user.id, status: 'EN_COURS', createdAt: this.now(), samples: [], findings: [] });
    this.log(user, 'mission_opened', 'audit_mission', m.id, { code: m.code, title: m.title });
    return m;
  }

  list(user: User) {
    authorize(user, 'decision:audit.read');
    const all = this.missions.all();
    const recos = all.flatMap((m) => m.findings.flatMap((f) => f.recommendations));
    const verified = recos.filter((r) => r.status === 'MISE_EN_OEUVRE_VERIFIEE').length;
    const followed = recos.filter((r) => r.status !== 'NON_RETENUE');
    const head = this.ctx.audit.verify();
    // Racine quotidienne : dernières racines publiées et dernier contrôle d'intégrité (module de scellement, lecture seule).
    const sc = (this.ctx.ext['integrite-securite'] as { scellement?: { roots: { all(): { day: string; partial: boolean; count: number; merkleRoot: string; headHash: string; toSeq: number; timestamp: unknown; publication: unknown }[] }; checks: { all(): { at: string; ok: boolean; findings: unknown[] }[] } } } | undefined)?.scellement;
    const roots = sc ? sc.roots.all().sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 7).map((r) => ({ day: r.day, partial: r.partial, count: r.count, merkleRoot: r.merkleRoot, toSeq: r.toSeq, timestamped: !!r.timestamp, published: !!r.publication })) : [];
    const lastCheck = sc ? sc.checks.all().sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null : null;
    return {
      dailyRoots: { available: !!sc, roots, lastCheck: lastCheck ? { at: lastCheck.at, ok: lastCheck.ok, findings: lastCheck.findings.length } : null, link: '/integrite/scellement' },
      items: all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), populations: POPULATIONS,
      integrity: { ok: head.ok, length: head.length, headHash: head.headHash, verifiedAt: head.verifiedAt, note: 'Vérification intégrale de la chaîne à la lecture ; racines quotidiennes publiées et contrôlées dans « Scellement du journal d’audit ».' },
      indicators: [
        { code: 'MISSIONS_AUDIT', label: 'Missions d’audit', measured: true, value: String(all.length), unit: 'missions', detail: { enCours: all.filter((m) => m.status === 'EN_COURS').length, closes: all.filter((m) => m.status === 'CLOSE').length } },
        { code: 'CONSTATS', label: 'Constats', measured: true, value: String(all.reduce((a, m) => a + m.findings.length, 0)), unit: 'constats' },
        followed.length
          ? { code: 'RECOMMANDATIONS_SUIVIES', label: 'Recommandations suivies (mise en œuvre vérifiée)', measured: true, value: pctNum(verified, followed.length), unit: '%', detail: { verifiees: verified, retenues: followed.length } }
          : { code: 'RECOMMANDATIONS_SUIVIES', label: 'Recommandations suivies (mise en œuvre vérifiée)', measured: false, value: null, unit: '%', reason: 'Aucune recommandation émise : pas encore mesurable.' },
      ],
    };
  }

  /** Population d'échantillonnage (identifiants seulement), filtrée par période et commune. */
  population(pop: Population, f: { from?: string; to?: string; commune?: string }): string[] {
    const inRange = (ts: string) => (!f.from || ts.slice(0, 10) >= f.from) && (!f.to || ts.slice(0, 10) <= f.to);
    const facts = this.pil().facts();
    switch (pop) {
      case 'PAIEMENTS': return facts.orders.filter((o) => inRange(o.createdAt) && (!f.commune || o.commune === f.commune)).map((o) => o.id);
      case 'OBLIGATIONS': return facts.obligations.filter((o) => inRange(o.createdAt) && (!f.commune || o.commune === f.commune)).map((o) => o.id);
      case 'ECRITURES': return this.ctx.ledger.list().filter((e) => inRange(e.at)).map((e) => e.id);
      case 'EVENEMENTS_AUDIT': return this.ctx.audit.list({ limit: 1_000_000 }).items.filter((r) => inRange(r.at)).map((r) => `seq:${r.seq}`);
      case 'EXONERATIONS': return ((this.ctx.ext.fiscal as Fiscal | undefined)?.exemptions?.exemptions?.all() ?? []).filter((x) => inRange(x.requestedAt)).map((x) => x.id);
    }
  }

  sample(user: User, id: string, input: { population: Population; size: number; seed?: string; from?: string; to?: string; commune?: string }) {
    authorize(user, 'decision:audit.write');
    const m = this.open(id);
    const filters = { ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}), ...(input.commune ? { commune: input.commune } : {}) };
    const ids = this.population(input.population, filters);
    if (ids.length === 0) throw conflict('EMPTY_POPULATION', 'Population vide pour ces filtres : aucun échantillon.');
    const seed = input.seed ?? createHash('sha256').update(`${m.id}|${this.now()}|${m.samples.length}`).digest('hex').slice(0, 16);
    const s: Sample = {
      id: this.ids.next('ECH'), population: input.population, filters, size: Math.min(input.size, ids.length), seed, populationSize: ids.length,
      populationSha256: createHash('sha256').update(canonicalJson([...ids].sort())).digest('hex'), items: drawSample(ids, seed, input.size),
      method: 'TIRAGE_DETERMINISTE_SHA256', at: this.now(), by: user.id,
    };
    const out = this.missions.update({ ...m, samples: [...m.samples, s] });
    this.log(user, 'sample_drawn', 'audit_mission', m.id, { sampleId: s.id, population: s.population, size: s.size, seed, populationSize: s.populationSize, populationSha256: s.populationSha256 });
    return { mission: out, sample: s, reproducibility: 'Même graine + même population (empreinte) ⇒ même échantillon : tri par SHA-256(graine|identifiant).' };
  }

  addFinding(user: User, id: string, input: { title: string; description: string; severity: Finding['severity']; evidence: string[] }) {
    authorize(user, 'decision:audit.write');
    const m = this.open(id);
    const f: Finding = { id: this.ids.next('CST'), ...input, at: this.now(), by: user.id, recommendations: [] };
    const out = this.missions.update({ ...m, findings: [...m.findings, f] });
    this.log(user, 'finding_recorded', 'audit_mission', m.id, { findingId: f.id, severity: f.severity });
    return out;
  }

  addRecommendation(user: User, missionId: string, findingId: string, input: { text: string; ownerEntity: string; deadline: string }) {
    authorize(user, 'decision:audit.write');
    const m = this.open(missionId);
    const f = m.findings.find((x) => x.id === findingId);
    if (!f) throw notFound('FINDING_NOT_FOUND', `Constat inconnu : ${findingId}`);
    const r: Recommendation = { id: this.ids.next('REC'), ...input, status: 'EMISE', followUps: [] };
    const out = this.missions.update({ ...m, findings: m.findings.map((x) => (x.id === findingId ? { ...x, recommendations: [...x.recommendations, r] } : x)) });
    this.log(user, 'recommendation_issued', 'audit_mission', m.id, { findingId, recommendationId: r.id, ownerEntity: r.ownerEntity, deadline: r.deadline });
    return out;
  }

  /**
   * Suivi d'une recommandation : le service audité DÉCLARE la mise en œuvre (preuve) ; une personne de l'audit, distincte
   * de celle qui a émis le constat, la VÉRIFIE ou la juge non retenue. Aucune correction des données par l'audit.
   */
  followUp(user: User, recoId: string, input: { status: RecoStatus; note: string; evidenceSha256?: string }) {
    const m = this.missions.all().find((x) => x.findings.some((f) => f.recommendations.some((r) => r.id === recoId)));
    if (!m) throw notFound('RECOMMENDATION_NOT_FOUND', `Recommandation inconnue : ${recoId}`);
    const f = m.findings.find((x) => x.recommendations.some((r) => r.id === recoId))!;
    const r = f.recommendations.find((x) => x.id === recoId)!;
    if (input.status === 'MISE_EN_OEUVRE_DECLAREE') {
      authorize(user, 'decision:audit.respond');
      if (user.entity !== r.ownerEntity) throw forbidden('NOT_OWNER_ENTITY', 'Seul le service destinataire déclare la mise en œuvre.');
      if (!input.evidenceSha256) throw badRequest('EVIDENCE_REQUIRED', 'Preuve de mise en œuvre (empreinte SHA-256) requise.');
    } else if (input.status === 'MISE_EN_OEUVRE_VERIFIEE' || input.status === 'NON_RETENUE') {
      authorize(user, 'decision:audit.write');
      assertDistinctPerson(user.id, [f.by], 'Vérification du suivi : par une personne de l’audit distincte de l’auteur du constat.');
      if (input.status === 'MISE_EN_OEUVRE_VERIFIEE' && r.status !== 'MISE_EN_OEUVRE_DECLAREE') throw conflict('NOT_DECLARED', 'La mise en œuvre doit d’abord être déclarée par le service audité.');
    } else throw badRequest('INVALID_STATUS', 'Statut de suivi invalide.');
    const nr: Recommendation = { ...r, status: input.status, followUps: [...r.followUps, { at: this.now(), by: user.id, status: input.status, note: input.note, ...(input.evidenceSha256 ? { evidenceSha256: input.evidenceSha256 } : {}) }] };
    const out = this.missions.update({ ...m, findings: m.findings.map((x) => (x.id === f.id ? { ...x, recommendations: x.recommendations.map((y) => (y.id === recoId ? nr : y)) } : x)) });
    this.log(user, 'recommendation_followed', 'audit_mission', m.id, { recommendationId: recoId, status: input.status });
    return out;
  }

  close(user: User, id: string, motif: string) {
    authorize(user, 'decision:audit.write');
    const m = this.open(id);
    const out = this.missions.update({ ...m, status: 'CLOSE', closedAt: this.now(), closure: { by: user.id, motif } });
    this.log(user, 'mission_closed', 'audit_mission', id, { motif });
    return out;
  }

  /** Éléments d'un échantillon, sans donnée nominative (références, montants, statuts, dates). */
  private resolve(pop: Population, ids: string[]) {
    const facts = this.pil().facts();
    const set = new Set(ids);
    switch (pop) {
      case 'PAIEMENTS': return facts.orders.filter((o) => set.has(o.id)).map((o) => ({ id: o.id, reference: o.paymentReference, amount: o.amount, status: o.status, commune: o.commune, createdAt: o.createdAt, confirmedAt: o.confirmedAt ?? null, reconciledAt: o.reconciledAt ?? null, ledgerEntryIds: o.ledgerEntryIds }));
      case 'OBLIGATIONS': return facts.obligations.filter((o) => set.has(o.id)).map((o) => ({ id: o.id, ruleCode: o.ruleCode, amount: o.amount, status: o.status, commune: o.commune, createdAt: o.createdAt, dueDate: o.dueDate, rectified: o.rectified }));
      case 'ECRITURES': return this.ctx.ledger.list().filter((e) => set.has(e.id)).map((e) => ({ id: e.id, seq: e.seq, at: e.at, eventType: e.eventType, reversalOf: e.reversalOf ?? null, hash: e.hash }));
      case 'EVENEMENTS_AUDIT': return this.ctx.audit.list({ limit: 1_000_000 }).items.filter((r) => set.has(`seq:${r.seq}`)).map((r) => ({ seq: r.seq, at: r.at, action: r.action, resourceType: r.resourceType, hash: r.hash }));
      case 'EXONERATIONS': return ids.map((id) => ({ id }));
    }
  }

  seal(user: User, id: string, motif: string) {
    authorize(user, 'decision:audit.write');
    const m = this.mission(id);
    const head = this.ctx.audit.verify();
    const content = {
      mission: { id: m.id, code: m.code, title: m.title, objective: m.objective, scope: m.scope, status: m.status },
      samples: m.samples.map((s) => ({ ...s, records: this.resolve(s.population, s.items) })),
      findings: m.findings, auditChain: { ok: head.ok, length: head.length, headHash: head.headHash, verifiedAt: head.verifiedAt },
      sealedAt: this.now(), motif,
    };
    const payload = canonicalJson(content);
    const { sha256, signature } = this.signer.sign(payload);
    const holder = `${user.id} (${user.entity})`;
    const e = this.sealed.append({ id: this.ids.next('SCL'), missionId: m.id, sha256, signature, keyId: EXPORT_KEY_ID, payload, sealedAt: this.now(), sealedBy: user.id });
    this.custody.append({ id: this.ids.next('POS'), sealedId: e.id, step: 'SCELLE', at: this.now(), by: user.id, from: holder, to: holder, motif, sha256Verified: sha256 });
    this.pil().exportsLog.append({ id: `${e.id}-json`, exportId: e.id, kind: 'audit-scelle', format: 'json', generatedAt: e.sealedAt, generatedBy: { id: user.id, roles: user.roles }, filters: { missionId: m.id }, rows: m.samples.reduce((a, s) => a + s.items.length, 0), sha256, signature, algorithm: 'HMAC-SHA256', keyId: EXPORT_KEY_ID, note: 'Export scellé d’une mission d’audit : empreinte du JSON canonique, chaîne de possession tracée.' });
    this.log(user, 'export_sealed', 'sealed_export', e.id, { missionId: m.id, sha256, motif });
    return this.sealedView(e);
  }

  /** Remise de l'export scellé à un destinataire : l'empreinte est RECALCULÉE et doit être identique (chaîne de possession). */
  handOver(user: User, sealedId: string, input: { to: string; motif: string }) {
    authorize(user, 'decision:audit.write');
    const e = this.sealed.get(sealedId);
    if (!e) throw notFound('SEALED_NOT_FOUND', `Export scellé inconnu : ${sealedId}`);
    const v = this.signer.verify(e.payload, e.sha256, e.signature);
    if (!v.integrity || !v.authentic) throw conflict('SEAL_BROKEN', 'Scellé rompu : empreinte ou signature invalide — remise refusée.');
    const last = this.custody.find((c) => c.sealedId === e.id).at(-1)!;
    const step = this.custody.append({ id: this.ids.next('POS'), sealedId: e.id, step: 'REMISE', at: this.now(), by: user.id, from: last.to, to: input.to, motif: input.motif, sha256Verified: e.sha256 });
    this.log(user, 'export_handed_over', 'sealed_export', e.id, { from: step.from, to: step.to, sha256: e.sha256, motif: input.motif });
    return this.sealedView(e);
  }

  sealedView(e: SealedExport) {
    const v = this.signer.verify(e.payload, e.sha256, e.signature);
    return { id: e.id, missionId: e.missionId, sha256: e.sha256, signature: e.signature, keyId: e.keyId, sealedAt: e.sealedAt, sealedBy: e.sealedBy, custody: this.custody.find((c) => c.sealedId === e.id), verification: { integrity: v.integrity, authentic: v.authentic }, payload: e.payload };
  }

  getSealed(user: User, id: string) {
    authorize(user, 'decision:audit.read');
    const e = this.sealed.get(id);
    if (!e) throw notFound('SEALED_NOT_FOUND', `Export scellé inconnu : ${id}`);
    return this.sealedView(e);
  }

  listSealed(user: User) {
    authorize(user, 'decision:audit.read');
    return { items: this.sealed.all().map((e) => { const { payload: _p, ...rest } = this.sealedView(e); return rest; }) };
  }

  /**
   * Reconstitution d'une correction (§ 29.1) : écriture d'origine, contre-écriture, motif et approbateurs (circuit à
   * quatre yeux du Trésor) ; ou obligation rectifiée, obligation de remplacement, décision et journal.
   */
  correction(user: User, ref: string) {
    authorize(user, 'decision:audit.read');
    const events = (id: string) => this.ctx.audit.list({ resourceId: id, limit: 1000 }).items.map((r) => ({ seq: r.seq, at: r.at, action: r.action, actor: r.actor.kind === 'user' ? r.actor.id : r.actor.kind, reason: r.trace?.reason ?? null, approvalChain: r.trace?.approvalChain ?? null, hash: r.hash }));
    const entry = this.ctx.ledger.get(ref);
    if (entry) {
      const original = entry.reversalOf ? this.ctx.ledger.get(entry.reversalOf)! : entry;
      const reversal = this.ctx.ledger.list().find((e) => e.reversalOf === original.id) ?? null;
      const ops = ((this.ctx.ext.tresor as Tresor | undefined)?.operations?.all() ?? []).filter((o) => o.kind === 'CONTRE_ECRITURE' && o.input.ledgerEntryId === original.id);
      const op = ops.find((o) => o.status === 'EXECUTEE') ?? ops[0];
      this.log(user, 'correction_reconstructed', 'ledger_entry', original.id, { kind: 'ECRITURE' });
      return {
        kind: 'ECRITURE', corrected: !!reversal,
        original: { id: original.id, seq: original.seq, at: original.at, eventType: original.eventType, description: original.description, lines: original.lines, hash: original.hash },
        reversal: reversal ? { id: reversal.id, seq: reversal.seq, at: reversal.at, description: reversal.description, lines: reversal.lines, hash: reversal.hash } : null,
        motif: reversal?.reason ?? op?.input.reason ?? null,
        approvers: op ? { proposedBy: op.proposedBy, proposedAt: op.proposedAt, approvals: op.approvals ?? [], decidedBy: op.decidedBy ?? null, decidedAt: op.decidedAt ?? null, operationId: op.id, status: op.status } : null,
        events: [...events(original.id), ...(reversal ? events(reversal.id) : [])],
      };
    }
    const ob = this.ctx.assessment.obligations.get(ref);
    if (ob) {
      const successor = ob.supersededBy ? this.ctx.assessment.obligations.get(ob.supersededBy) ?? null : null;
      const appeal = this.ctx.appeals.appeals.all().find((a) => a.obligationId === ob.id && a.decision);
      this.log(user, 'correction_reconstructed', 'obligation', ob.id, { kind: 'OBLIGATION' });
      return {
        kind: 'OBLIGATION', corrected: !!successor,
        original: { id: ob.id, ruleCode: ob.ruleCode, amount: ob.amount, status: ob.status, createdAt: ob.createdAt, createdBy: ob.createdBy },
        reversal: successor ? { id: successor.id, amount: successor.amount, status: successor.status, createdAt: successor.createdAt, createdBy: successor.createdBy } : null,
        motif: appeal?.decision ? `${appeal.decision.decision} — ${appeal.decision.reason}` : null,
        approvers: appeal?.decision ? { decidedBy: appeal.decision.decidedBy, decidedAt: appeal.decision.at, appealId: appeal.id } : null,
        events: [...events(ob.id), ...(successor ? events(successor.id) : [])],
      };
    }
    throw notFound('CORRECTION_REF_NOT_FOUND', `Référence inconnue (écriture du grand livre ou obligation) : ${ref}`);
  }
}
