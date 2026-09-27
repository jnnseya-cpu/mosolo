/**
 * Registre des modèles d'IA (§ 23.1, § 40) — module « ia-modeles », ajouté au module « ia » sans le modifier :
 * modèles, versions, jeux de données (approuvés, datés, documentés, validés par le délégué à la protection des données),
 * évaluations, tests de biais, suivi de dérive et d'explicabilité, mise en service par deux personnes, retour arrière.
 * Le suivi (dérive, biais) est CALCULÉ sur le journal réel des recommandations et des décisions humaines ; il lève des
 * alertes à examiner, jamais d'action automatique. Aucun nom commercial de modèle n'est enregistré.
 */
import { z } from 'zod';
import type { RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { DAY_MS } from '../../core/clock.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { isoDateString, parse } from '../../core/http.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { definePlugin } from '../types.js';
import { AGENTS, PROVIDER_MODEL_VERSION, promptVersion } from './catalogue.js';
import type { IaService } from './service.js';

/** Seuils de suivi — valeurs PAR DÉFAUT, à confirmer par le maître d'ouvrage (registre des seuils). */
export const IA_DERIVE_SEUIL_POINTS = 20;
export const IA_BIAIS_ECART_POINTS = 20;
export const IA_FENETRE_JOURS = 30;
export const IA_DECISIONS_MIN = 10;

export const MODEL_KINDS = {
  REGLES_DETERMINISTES: 'Moteur de règles déterministes',
  STATISTIQUE: 'Modèle statistique',
  APPRENTISSAGE: 'Modèle appris sur données',
  LANGAGE: 'Modèle de langage (via la passerelle IA)',
} as const;
type ModelKind = keyof typeof MODEL_KINDS;

export interface ModelRecord { id: string; code: string; label: string; kind: ModelKind; purpose: string; agents: string[]; owner: string; builtin?: boolean; createdAt: string }
export interface Dataset {
  id: string; code: string; label: string; source: string; legalBasis: string; periodFrom: string; periodTo: string; sha256: string; minimisation: string;
  sensitive: boolean; status: 'PROPOSE' | 'APPROUVE' | 'REFUSE'; proposedBy: string; proposedAt: string; decision?: { by: string; at: string; approve: boolean; motif: string };
}
export interface Evaluation { at: string; by: string; metric: string; value: string; datasetId?: string; reportSha256: string; conclusion: string }
export interface BiasTest { at: string; by: string; dimension: string; method: string; result: string; passed: boolean; reportSha256: string }
export type VersionStatus = 'ENREGISTREE' | 'MISE_EN_SERVICE_PROPOSEE' | 'EN_SERVICE' | 'RETIREE';
export interface ModelVersion {
  id: string; modelCode: string; version: string; status: VersionStatus; datasetIds: string[]; promptVersions: string[]; explainability: string;
  evaluations: Evaluation[]; biasTests: BiasTest[]; registeredBy: string; registeredAt: string; builtin?: boolean;
  promotion?: { proposedBy: string; proposedAt: string; motif: string; decidedBy?: string; decidedAt?: string; approve?: boolean; decisionMotif?: string };
  replaces?: string; retired?: { by: string; at: string; motif: string; rollback: boolean };
}

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
definePolicy('ia:models.read', g(['R01', 'R02', 'R05', 'R22', 'R23', 'R25', 'R26', 'R28', 'R29']));
definePolicy('ia:models.write', g(['R29']));
definePolicy('ia:models.evaluate', g(['R29', 'R22']));
/** Décision de mise en service (seconde personne) : gestionnaire des modèles, audit interne ou responsable sécurité. */
definePolicy('ia:models.decide', g(['R29', 'R22', 'R28']));
definePolicy('ia:models.rollback', g(['R29', 'R28']));
definePolicy('ia:datasets.propose', g(['R29']));
definePolicy('ia:datasets.decide', g(['R25']));

export class ModelRegistryService {
  readonly models = new InMemoryRepository<ModelRecord>();
  readonly versions = new InMemoryRepository<ModelVersion>();
  readonly datasets = new InMemoryRepository<Dataset>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {
    // Modèles réellement en service au démarrage (déclarés par le système) : évaluation et tests restent à documenter.
    const at = ctx.clock.now().toISOString();
    const builtin = (code: string, label: string, purpose: string, agents: string[], version: string, prompts: string[]) => {
      this.models.insert({ id: code, code, label, kind: 'REGLES_DETERMINISTES', purpose, agents, owner: 'R29', builtin: true, createdAt: at });
      this.versions.insert({ id: `${code}@${version}`, modelCode: code, version, status: 'EN_SERVICE', datasetIds: [], promptVersions: prompts, explainability: 'Règles explicites : chaque sortie cite ses sources et ses facteurs.', evaluations: [], biasTests: [], registeredBy: 'systeme', registeredAt: at, builtin: true });
    };
    builtin('AGENTS-METIER', 'Agents métier de la couche d’intelligence', 'Recommandations des agents (§ 23.2) — l’IA propose, une personne décide.', Object.keys(AGENTS), PROVIDER_MODEL_VERSION, Object.values(AGENTS).map(promptVersion));
    builtin('ASSISTANT-SOCLE', 'Assistant du socle (recommandations du Gouverneur)', 'Actions recommandées du tableau de bord (§ 26.1).', [], 'regles-deterministes-1.0', []);
  }

  private get ia(): IaService | undefined { return this.ctx.ext.ia as IaService | undefined; }
  private now() { return this.ctx.clock.now().toISOString(); }
  private audit(user: User, action: string, id: string, details: Record<string, unknown> = {}) {
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action, resourceType: 'ia_model', resourceId: id, details });
  }

  registerVersion(user: User, code: string, input: { version: string; datasetIds: string[]; promptVersions: string[]; explainability: string; kind?: ModelKind; label?: string; purpose?: string }) {
    authorize(user, 'ia:models.write');
    if (!this.models.get(code)) {
      if (!input.kind || !input.label || !input.purpose) throw badRequest('MODEL_DETAILS_REQUIRED', 'Nouveau modèle : nature, libellé et finalité requis.');
      this.models.insert({ id: code, code, label: input.label, kind: input.kind, purpose: input.purpose, agents: [], owner: 'R29', createdAt: this.now() });
    }
    if (this.versions.get(`${code}@${input.version}`)) throw conflict('VERSION_EXISTS', 'Version déjà enregistrée (immuable).');
    const unknown = input.datasetIds.filter((d) => !this.datasets.get(d));
    if (unknown.length) throw badRequest('UNKNOWN_DATASET', `Jeux inconnus : ${unknown.join(', ')}.`);
    const v = this.versions.insert({ id: `${code}@${input.version}`, modelCode: code, version: input.version, status: 'ENREGISTREE', datasetIds: input.datasetIds, promptVersions: input.promptVersions, explainability: input.explainability, evaluations: [], biasTests: [], registeredBy: user.id, registeredAt: this.now() });
    this.audit(user, 'ia.model.version_registered', v.id, { datasetIds: v.datasetIds });
    return v;
  }

  private version(id: string): ModelVersion {
    const v = this.versions.get(id);
    if (!v) throw notFound('MODEL_VERSION_NOT_FOUND', `Version inconnue : ${id}.`);
    return v;
  }

  addEvaluation(user: User, id: string, input: Omit<Evaluation, 'at' | 'by'>) {
    authorize(user, 'ia:models.evaluate');
    const v = this.version(id);
    const out = this.versions.update({ ...v, evaluations: [...v.evaluations, { ...input, at: this.now(), by: user.id }] });
    this.audit(user, 'ia.model.evaluated', id, { metric: input.metric, value: input.value, reportSha256: input.reportSha256 });
    return out;
  }

  addBiasTest(user: User, id: string, input: Omit<BiasTest, 'at' | 'by'>) {
    authorize(user, 'ia:models.evaluate');
    const v = this.version(id);
    const out = this.versions.update({ ...v, biasTests: [...v.biasTests, { ...input, at: this.now(), by: user.id }] });
    this.audit(user, 'ia.model.bias_tested', id, { dimension: input.dimension, passed: input.passed, reportSha256: input.reportSha256 });
    return out;
  }

  /** Proposition de mise en service : jeux approuvés, au moins une évaluation et un test de biais réussi. */
  proposePromotion(user: User, id: string, motif: string) {
    authorize(user, 'ia:models.write');
    const v = this.version(id);
    if (v.status !== 'ENREGISTREE') throw conflict('INVALID_STATE', `Version au statut ${v.status}.`);
    const missing: string[] = [];
    if (v.datasetIds.some((d) => this.datasets.get(d)?.status !== 'APPROUVE')) missing.push('jeux de données approuvés par le délégué à la protection des données');
    if (v.evaluations.length === 0) missing.push('au moins une évaluation documentée');
    if (!v.biasTests.some((b) => b.passed)) missing.push('au moins un test de biais réussi');
    if (missing.length) throw conflict('PROMOTION_PREREQUISITES', `Mise en service impossible : ${missing.join(' ; ')}.`, { missing });
    const out = this.versions.update({ ...v, status: 'MISE_EN_SERVICE_PROPOSEE', promotion: { proposedBy: user.id, proposedAt: this.now(), motif } });
    this.audit(user, 'ia.model.promotion_proposed', id, { versionKey: id, motif });
    return out;
  }

  /** Décision par une seconde personne distincte ; la version en service précédente est retirée (retour arrière possible). */
  decidePromotion(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'ia:models.decide');
    const v = this.version(id);
    if (v.status !== 'MISE_EN_SERVICE_PROPOSEE' || !v.promotion) throw conflict('INVALID_STATE', 'Aucune mise en service proposée.');
    assertDistinctPerson(user.id, [v.promotion.proposedBy, v.registeredBy], 'La mise en service exige une personne distincte du proposant et de l’auteur de la version.');
    const at = this.now();
    let replaces: string | undefined;
    if (input.approve) {
      for (const cur of this.versions.find((x) => x.modelCode === v.modelCode && x.status === 'EN_SERVICE')) {
        replaces = cur.id;
        this.versions.update({ ...cur, status: 'RETIREE', retired: { by: user.id, at, motif: `Remplacée par ${v.version}`, rollback: false } });
      }
    }
    const out = this.versions.update({ ...v, status: input.approve ? 'EN_SERVICE' : 'ENREGISTREE', ...(replaces ? { replaces } : {}), promotion: { ...v.promotion, decidedBy: user.id, decidedAt: at, approve: input.approve, decisionMotif: input.motif } });
    this.audit(user, input.approve ? 'ia.model.promoted' : 'ia.model.promotion_rejected', id, { versionKey: id, proposedBy: v.promotion.proposedBy, motif: input.motif, replaces: replaces ?? null });
    return out;
  }

  /** Retour arrière : la version en service est retirée, la version qu'elle remplaçait est remise en service. */
  rollback(user: User, id: string, motif: string) {
    authorize(user, 'ia:models.rollback');
    const v = this.version(id);
    if (v.status !== 'EN_SERVICE' || !v.replaces) throw conflict('NO_ROLLBACK', 'Retour arrière possible seulement sur une version en service qui en a remplacé une autre.');
    const prev = this.version(v.replaces);
    const at = this.now();
    this.versions.update({ ...v, status: 'RETIREE', retired: { by: user.id, at, motif, rollback: true } });
    const { retired: _gone, ...restored } = prev;
    const out = this.versions.update({ ...restored, status: 'EN_SERVICE' });
    this.audit(user, 'ia.model.rolled_back', id, { restored: prev.id, motif });
    return out;
  }

  proposeDataset(user: User, input: Omit<Dataset, 'id' | 'status' | 'proposedBy' | 'proposedAt' | 'decision'>) {
    authorize(user, 'ia:datasets.propose');
    if (input.periodFrom > input.periodTo) throw badRequest('INVALID_PERIOD', 'Période du jeu invalide.');
    if (this.datasets.findOne((d) => d.code === input.code)) throw conflict('DUPLICATE_CODE', 'Code de jeu déjà utilisé.');
    const d = this.datasets.insert({ id: this.ids.next('JEU'), ...input, status: 'PROPOSE', proposedBy: user.id, proposedAt: this.now() });
    this.audit(user, 'ia.dataset.proposed', d.id, { code: d.code, sensitive: d.sensitive, sha256: d.sha256 });
    return d;
  }

  /** Approbation par le délégué à la protection des données (personne distincte) ; données sensibles refusées sans base légale. */
  decideDataset(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'ia:datasets.decide');
    const d = this.datasets.get(id);
    if (!d) throw notFound('DATASET_NOT_FOUND', 'Jeu inconnu.');
    if (d.status !== 'PROPOSE') throw conflict('ALREADY_DECIDED', 'Jeu déjà décidé.');
    assertDistinctPerson(user.id, [d.proposedBy], 'L’approbation d’un jeu exige une personne distincte du proposant.');
    if (input.approve && d.sensitive && !/loi|arr[êe]t[ée]|d[ée]cret|convention|protocole/i.test(d.legalBasis)) throw conflict('SENSITIVE_WITHOUT_BASIS', 'Données sensibles : base légale explicite requise (§ 23.1).');
    const out = this.datasets.update({ ...d, status: input.approve ? 'APPROUVE' : 'REFUSE', decision: { by: user.id, at: this.now(), ...input } });
    this.audit(user, input.approve ? 'ia.dataset.approved' : 'ia.dataset.refused', id, { motif: input.motif });
    return out;
  }

  /**
   * Suivi calculé sur le journal réel : taux d'acceptation par version (fenêtre récente vs précédente) ⇒ dérive ;
   * écart d'acceptation entre entités ⇒ biais ; versions observées non enregistrées. Alertes idempotentes, aucun effet.
   */
  monitoring(raise = true) {
    const now = this.ctx.clock.now().getTime();
    const w = IA_FENETRE_JOURS * DAY_MS;
    const recs = this.ia?.recommendations.all() ?? [];
    const decided = recs.filter((r) => r.decidedAt && r.status !== 'EMISE');
    const rate = (xs: { status: string }[]) => (xs.length ? Math.round((xs.filter((r) => r.status === 'ACCEPTEE').length * 1000) / xs.length) / 10 : null);
    const versionsSeen = [...new Set(recs.map((r) => r.modelVersion))];
    const registered = new Set(this.versions.all().map((v) => v.version));
    const rows = versionsSeen.map((ver) => {
      const mine = decided.filter((r) => r.modelVersion === ver);
      const recent = mine.filter((r) => now - Date.parse(r.decidedAt!) <= w);
      const before = mine.filter((r) => { const age = now - Date.parse(r.decidedAt!); return age > w && age <= 2 * w; });
      const rRecent = recent.length >= IA_DECISIONS_MIN ? rate(recent) : null; const rBefore = before.length >= IA_DECISIONS_MIN ? rate(before) : null;
      const drift = rRecent !== null && rBefore !== null ? Math.round((rRecent - rBefore) * 10) / 10 : null;
      const byEntity = new Map<string, { status: string }[]>();
      mine.forEach((r) => byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r]));
      const groups = [...byEntity.entries()].filter(([, xs]) => xs.length >= IA_DECISIONS_MIN).map(([entity, xs]) => ({ entity, decisions: xs.length, acceptancePct: rate(xs) }));
      const accs = groups.map((x) => x.acceptancePct!).filter((x) => x !== null);
      const biasGap = accs.length >= 2 ? Math.round((Math.max(...accs) - Math.min(...accs)) * 10) / 10 : null;
      const latencies = mine.map((r) => r.decisionLatencyMs).filter((x): x is number => typeof x === 'number');
      return {
        modelVersion: ver, registered: registered.has(ver), recommendations: recs.filter((r) => r.modelVersion === ver).length, decisions: mine.length,
        acceptancePct: rate(mine), window: { days: IA_FENETRE_JOURS, recentPct: rRecent, previousPct: rBefore, driftPoints: drift, driftAlert: drift !== null && Math.abs(drift) >= IA_DERIVE_SEUIL_POINTS },
        bias: { dimension: 'ENTITE', groups, gapPoints: biasGap, alert: biasGap !== null && biasGap >= IA_BIAIS_ECART_POINTS },
        humanDecisionLatencyMedianMs: latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)]! : null,
      };
    });
    let raised = 0;
    if (raise) {
      for (const r of rows) {
        const push = (fp: string, type: string, detail: string) => { if (this.ctx.alerts.raiseOnce(fp, { type, severity: 'MEDIUM', source: 'ia:modeles', detail, context: { modelVersion: r.modelVersion }, notifyRoles: ['R29', 'R22'] })) raised++; };
        if (!r.registered) push(`ia-version-non-enregistree:${r.modelVersion}`, 'IA_VERSION_NON_ENREGISTREE', `Version ${r.modelVersion} observée au journal sans inscription au registre.`);
        if (r.window.driftAlert) push(`ia-derive:${r.modelVersion}:${new Date(now).toISOString().slice(0, 10)}`, 'IA_DERIVE', `Acceptation passée de ${r.window.previousPct} % à ${r.window.recentPct} % (${r.window.driftPoints} points).`);
        if (r.bias.alert) push(`ia-biais:${r.modelVersion}:${new Date(now).toISOString().slice(0, 10)}`, 'IA_BIAIS', `Écart d’acceptation de ${r.bias.gapPoints} points entre entités.`);
      }
    }
    return {
      params: { derivePoints: IA_DERIVE_SEUIL_POINTS, biasPoints: IA_BIAIS_ECART_POINTS, windowDays: IA_FENETRE_JOURS, minDecisions: IA_DECISIONS_MIN, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      rows, raised, automaticEffect: 'AUCUN' as const,
      note: 'Acceptation = recommandations acceptées / décidées par une personne habilitée. Mesures sous le minimum de décisions : non calculées.',
    };
  }

  view(user: User) {
    authorize(user, 'ia:models.read');
    return {
      kinds: MODEL_KINDS,
      models: this.models.all().map((m) => ({ ...m, versions: this.versions.find((v) => v.modelCode === m.code) })),
      datasets: this.datasets.all(),
      monitoring: this.monitoring(),
      governance: [
        'Jeux d’entraînement approuvés, datés et documentés ; aucune donnée sensible non autorisée.',
        'Versionnage, validation humaine à deux personnes avant mise en service, tests de biais, suivi de dérive, explicabilité, retour arrière.',
        'Journal intégral des décisions assistées : entrée, version du modèle, sortie, personne qui a tranché (journal IA).',
      ],
    };
  }
}

const motif = z.string().trim().min(10).max(2000);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const versionSchema = z.object({
  version: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,60}$/), datasetIds: z.array(z.string().max(40)).max(50).default([]), promptVersions: z.array(z.string().max(120)).max(100).default([]),
  explainability: z.string().trim().min(5).max(2000), kind: z.enum(Object.keys(MODEL_KINDS) as [ModelKind, ...ModelKind[]]).optional(), label: z.string().trim().min(3).max(200).optional(), purpose: z.string().trim().min(5).max(1000).optional(),
}).strict();
const evalSchema = z.object({ metric: z.string().trim().min(2).max(120), value: z.string().trim().min(1).max(60), datasetId: z.string().max(40).optional(), reportSha256: sha, conclusion: z.string().trim().min(3).max(2000) }).strict();
const biasSchema = z.object({ dimension: z.string().trim().min(2).max(60), method: z.string().trim().min(3).max(500), result: z.string().trim().min(1).max(500), passed: z.boolean(), reportSha256: sha }).strict();
const datasetSchema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{3,40}$/), label: z.string().trim().min(3).max(200), source: z.string().trim().min(3).max(500), legalBasis: z.string().trim().min(3).max(500),
  periodFrom: isoDateString, periodTo: isoDateString, sha256: sha, minimisation: z.string().trim().min(3).max(1000), sensitive: z.boolean(),
}).strict();
const decisionSchema = z.object({ approve: z.boolean(), motif }).strict();

export const iaModelesPlugin = definePlugin<ModelRegistryService>({
  name: 'ia-modeles',
  create: (ctx) => new ModelRegistryService(ctx),
  routes: (app, _ctx, svc) => {
    app.get('/v1/ia/modeles', async (req) => svc.view(requireUser(req)));
    app.post<{ Params: { code: string } }>('/v1/ia/modeles/:code/versions', async (req, reply) => reply.code(201).send(svc.registerVersion(requireUser(req), parse(z.string().regex(/^[A-Z0-9-]{3,40}$/), req.params.code), parse(versionSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/ia/modeles/versions/:id/evaluations', async (req) => svc.addEvaluation(requireUser(req), req.params.id, parse(evalSchema, req.body)));
    app.post<{ Params: { id: string } }>('/v1/ia/modeles/versions/:id/tests-biais', async (req) => svc.addBiasTest(requireUser(req), req.params.id, parse(biasSchema, req.body)));
    app.post<{ Params: { id: string } }>('/v1/ia/modeles/versions/:id/mise-en-service', async (req, reply) => reply.code(202).send(svc.proposePromotion(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif)));
    app.post<{ Params: { id: string } }>('/v1/ia/modeles/versions/:id/mise-en-service/decision', async (req) => svc.decidePromotion(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
    app.post<{ Params: { id: string } }>('/v1/ia/modeles/versions/:id/retour-arriere', async (req) => svc.rollback(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.get('/v1/ia/modeles/surveillance', async (req) => { authorize(requireUser(req), 'ia:models.read'); return svc.monitoring(); });
    app.get('/v1/ia/jeux-donnees', async (req) => { authorize(requireUser(req), 'ia:models.read'); return { items: svc.datasets.all() }; });
    app.post('/v1/ia/jeux-donnees', async (req, reply) => reply.code(201).send(svc.proposeDataset(requireUser(req), parse(datasetSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/ia/jeux-donnees/:id/decision', async (req) => svc.decideDataset(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
  },
});
