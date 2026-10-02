/**
 * Passerelle et orchestrateur de la couche d'intelligence (« AI Operating System », § 23.3 et § 23.5).
 *
 * - Chaque agent ne lit que les domaines de sa fiche (passerelle en lecture seule, masquage).
 * - Chaque sortie est une recommandation au format standard (8 rubriques + bloc de décision), journalisée avec la
 *   finalité déclarée, la version du modèle et de la fiche (« prompt »), l'empreinte des données lues, les données citées
 *   et l'empreinte de la sortie ; la décision humaine et son délai sont liés.
 * - Niveau A : actions sans effet juridique ni financier, exécutées par l'agent (garde `assertAiMay(…, 'draft.write')`),
 *   journalisées, réversibles et désactivables par le responsable d'entité.
 * - Niveau B : actions à effet sur un tiers, exécutées AU NOM de l'agent public qui valide (un clic), annulables.
 * - Niveau C : recommandation seulement ; jamais exécutée ; renvoi au circuit maker-checker du domaine.
 */
import { runScheduledJob } from '../../core/jobs.js';
import { ROLES, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { AiActor, User } from '../../core/auth.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { ApiError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertAiMay, authorize, evaluate, type Resource } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { kinshasaDate } from '../../core/clock.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { ACTION_LABELS, AGENTS, promptVersion, type AgentSheet } from './catalogue.js';
import { DataGateway } from './gateway.js';
import { MemoryService, type ProcessState } from './memory.js';
import { DeterministicAgentProvider, roleLabel, type AgentRunOptions, type IaAgentProvider } from './provider.js';
import {
  AGENT_CODES, LEVEL_A_ACTIONS, type ActionType, type AgentCode, type AgentDraft, type AutonomySettings, type EffectType, type IaEffect,
  type IaJournalEntry, type IaRecommendation, type IaStatus, type JournalEventType, type LevelAAction, type ProposedAction,
} from './types.js';

export const IA_NOTICE = 'Préparé avec l’assistance de l’IA — sans effet tant qu’un agent habilité ne l’a pas validé.';
const EFFECT_NOTICE = 'Préparé avec l’assistance de l’IA — ce n’est pas un acte : aucun effet juridique ni financier.';

const EFFECT_OF: Record<ActionType, EffectType> = {
  CREER_TACHE: 'TACHE', PREPARER_BROUILLON: 'BROUILLON', RESUMER: 'RESUME', CLASSER: 'ETIQUETTE', RAPPEL_FACULTATIF: 'RAPPEL',
  DEMANDER_PIECES: 'DEMANDE_PIECES', OUVRIR_MISSION: 'MISSION', RELANCE_OBLIGATOIRE: 'RELANCE', OUVRIR_DOSSIER_VERIFICATION: 'DOSSIER_VERIFICATION',
};

/** Rôles qui voient toutes les recommandations et tous les effets (contrôle). */
const OVERSIGHT: RoleCode[] = ['R22', 'R23', 'R29'];

type Requester = { kind: 'user' | 'system'; id: string; role?: RoleCode };

export class IaService {
  readonly recommendations = new InMemoryRepository<IaRecommendation>();
  readonly effects = new InMemoryRepository<IaEffect>();
  readonly journal = new InMemoryAppendOnlyRepository<IaJournalEntry>();
  readonly autonomy = new InMemoryRepository<AutonomySettings & { id: string }>();
  readonly agentState = new Map<AgentCode, { enabled: boolean; reason?: string; by?: string; at?: string }>();
  readonly memory: MemoryService;
  /** Balayage initial des données semées, effectué à la première consultation (aucun effet au démarrage). */
  demoSweepPending = false;
  private readonly ids = new IdGenerator();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: AppContext, private readonly provider: IaAgentProvider = new DeterministicAgentProvider()) {
    this.memory = new MemoryService(ctx);
  }

  private now(): string { return this.ctx.clock.now().toISOString(); }
  private sheet(code: string): AgentSheet {
    const s = (AGENTS as Record<string, AgentSheet | undefined>)[code];
    if (!s) throw notFound('IA_AGENT_NOT_FOUND', `Agent inconnu : ${code}`);
    return s;
  }
  private aiActor(sheet: AgentSheet): AiActor { return { kind: 'ai', id: `agent:${sheet.code}`, agent: sheet.name }; }
  private primaryRole(u: User, among: RoleCode[]): RoleCode { return u.roles.find((r) => among.includes(r)) ?? u.roles[0]!; }
  private isOversight(u: User): boolean { return u.roles.some((r) => OVERSIGHT.includes(r)); }

  private log(e: Omit<IaJournalEntry, 'id' | 'at'>): IaJournalEntry {
    return this.journal.append({ id: this.ids.next('IAJ'), at: this.now(), ...e });
  }

  // ---------------------------------------------------------------- Catalogue et coupe-circuit
  catalogue(user: User) {
    authorize(user, 'ia:agents.read');
    const taxpayer = user.roles.every((r) => r === 'R30' || r === 'R31');
    return Object.values(AGENTS)
      .filter((a) => !taxpayer || a.personal)
      .map((a) => ({
        ...a,
        promptVersion: promptVersion(a),
        modelVersion: this.provider.modelVersion,
        enabled: this.agentState.get(a.code)?.enabled ?? true,
        disabledReason: this.agentState.get(a.code)?.enabled === false ? this.agentState.get(a.code)?.reason : undefined,
        canRun: user.roles.some((r) => a.runners.includes(r)),
        canValidate: user.roles.some((r) => a.validators.includes(r)),
        allowedActions: a.allowedActions.map((t) => ({ type: t, label: ACTION_LABELS[t], level: (LEVEL_A_ACTIONS as readonly string[]).includes(t) ? 'A' : 'B' })),
        stats: this.agentStats(a.code),
      }));
  }

  setAgentState(user: User, code: string, enabled: boolean, reason: string) {
    authorize(user, 'ia:agent.kill');
    const s = this.sheet(code);
    const state = { enabled, reason, by: user.id, at: this.now() };
    this.agentState.set(s.code, state);
    const audit = this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: enabled ? 'ia.agent.enabled' : 'ia.agent.disabled',
      resourceType: 'ia_agent', resourceId: s.code, details: { reason },
    });
    this.log({ type: 'REFUS', agentCode: s.code, entity: s.homeEntity, actor: { kind: 'user', id: user.id, role: this.primaryRole(user, ['R28', 'R29']) }, detail: `${enabled ? 'Réactivation' : 'Coupe-circuit'} : ${reason}`, auditId: audit.id });
    return { code: s.code, ...state };
  }

  // ---------------------------------------------------------------- Exécution d'un agent
  run(user: User, code: string, input: { purpose: string; subject?: { type: string; id: string }; question?: string; taxpayerId?: string }): IaRecommendation[] {
    const sheet = this.sheet(code);
    let taxpayerId: string | undefined;
    if (sheet.personal) {
      taxpayerId = user.roles.includes('R30') && user.taxpayerId ? user.taxpayerId : input.taxpayerId;
      if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Cet agent travaille sur un compte : indiquez le contribuable (taxpayerId).');
      authorize(user, `ia:run.${sheet.code}`, { taxpayerId });
    } else {
      authorize(user, `ia:run.${sheet.code}`, { entity: sheet.homeEntity });
    }
    this.memory.touchTask(user, sheet.code);
    return this.generate(sheet, 'demande', { kind: 'user', id: user.id, role: this.primaryRole(user, sheet.runners) }, input.purpose, {
      ...(taxpayerId ? { taxpayerId } : {}), ...(input.subject ? { subject: input.subject } : {}), ...(input.question ? { question: input.question } : {}),
    });
  }

  /** Balayage proactif (§ 23.5.8) : agents non personnels, sans attendre que l'utilisateur interroge. */
  sweep(by: Requester = { kind: 'system', id: 'balayage-ia' }): { agent: AgentCode; created: number; skipped?: string }[] {
    const out: { agent: AgentCode; created: number; skipped?: string }[] = [];
    for (const code of AGENT_CODES) {
      const s = AGENTS[code];
      if (!s.proactive) continue;
      if (this.agentState.get(code)?.enabled === false) { out.push({ agent: code, created: 0, skipped: 'Agent désactivé (coupe-circuit)' }); continue; }
      const before = this.recommendations.count();
      this.generate(s, 'balayage', by, 'Balayage proactif (§ 23.5.8)', {});
      out.push({ agent: code, created: this.recommendations.count() - before });
    }
    return out;
  }

  sweepByUser(user: User) {
    authorize(user, 'ia:sweep');
    return this.sweep({ kind: 'user', id: user.id, role: this.primaryRole(user, ['R22', 'R26', 'R29']) });
  }

  startScheduler(intervalMs: number): void {
    this.stopScheduler();
    this.timer = setInterval(() => { runScheduledJob(this.ctx, 'ia.balayage', () => { this.sweep(); }); }, intervalMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private generate(sheet: AgentSheet, mode: AgentRunOptions['mode'], by: Requester, purpose: string, scope: { taxpayerId?: string; subject?: { type: string; id: string }; question?: string }): IaRecommendation[] {
    if (this.agentState.get(sheet.code)?.enabled === false) {
      throw new ApiError(503, 'IA_AGENT_DISABLED', `L’agent « ${sheet.name} » est désactivé (coupe-circuit) : ${this.agentState.get(sheet.code)?.reason ?? ''}`.trim());
    }
    const ai = this.aiActor(sheet);
    assertAiMay(ai, 'ai.insight');
    const gw = new DataGateway(this.ctx, sheet, kinshasaDate(this.ctx.clock.now()), {
      ...(scope.taxpayerId ? { taxpayerId: scope.taxpayerId } : {}),
      decisions: () => this.recommendations.all().map((r) => ({ agentCode: r.agentCode, status: r.status, autonomy: r.autonomy })),
    });
    const opts: AgentRunOptions = { mode, ...(scope.subject ? { subject: scope.subject } : {}), ...(scope.question ? { question: scope.question } : {}) };
    let drafts = this.runProvider(sheet, gw, opts, by);
    if (mode === 'balayage') drafts = drafts.filter((d) => !d.quiet);
    const inputHash = gw.inputHash();
    const serialized = drafts.map((d) => JSON.stringify(d));
    const out: IaRecommendation[] = [];
    for (const [i, draft] of drafts.entries()) {
      this.checkDraft(sheet, draft);
      const entity = sheet.personal ? 'PUBLIC' : sheet.homeEntity;
      const existing = this.recommendations.findOne((r) => r.agentCode === sheet.code && r.key === draft.key && r.entity === entity && (r.status === 'EMISE' || r.status === 'TRAITEE_AUTO') && r.taxpayerId === draft.taxpayerId);
      if (existing) { out.push(existing); continue; }
      // Données citées : celles mentionnées par cette sortie, plus les références générales de l'exécution.
      const citations = gw.citations.filter((c) => serialized[i]!.includes(c.ref) || !serialized.some((s) => s.includes(c.ref)));
      const { quiet: _q, actions, citations: _c, ...output } = draft as AgentDraft & { quiet?: boolean };
      const rec: IaRecommendation = {
        ...output,
        id: this.ids.next('IAR'),
        agentCode: sheet.code, agent: sheet.name, crossAgents: sheet.crossAgents, status: 'EMISE', entity,
        actions: actions.map((a, n) => ({ ...a, id: `ACT-${n + 1}`, status: 'PROPOSEE' as const })),
        citations,
        modelVersion: this.provider.modelVersion, promptVersion: promptVersion(sheet),
        inputHash, outputHash: '', purpose, requestedBy: by.id, createdAt: this.now(), notice: IA_NOTICE,
      };
      rec.outputHash = this.outputHash(rec);
      const stored = this.recommendations.insert(rec);
      const audit = this.ctx.audit.append({
        actor: { kind: 'ai', id: ai.id }, action: 'ia.recommendation.generated', resourceType: 'ia_recommendation', resourceId: stored.id,
        details: { agent: sheet.code, autonomy: stored.autonomy, purpose, requestedBy: by.id, modelVersion: stored.modelVersion, promptVersion: stored.promptVersion, inputHash, outputHash: stored.outputHash, citations: citations.map((c) => c.ref) },
      });
      this.log({
        type: 'GENERATION', agentCode: sheet.code, recommendationId: stored.id, entity, actor: { kind: by.kind, id: by.id, ...(by.role ? { role: by.role } : {}) },
        purpose, modelVersion: stored.modelVersion, promptVersion: stored.promptVersion,
        input: { hash: inputHash, domains: [...gw.used], citations, masked: [...gw.masked] },
        output: { hash: stored.outputHash, autonomy: stored.autonomy, summary: stored.situation.slice(0, 280), actions: stored.actions.map((a) => `${a.level}:${a.type}`) },
        auditId: audit.id,
      });
      this.memory.signal(sheet.code, 'recommandations_emises', stored.autonomy);
      out.push(this.autoExecute(stored));
    }
    return out;
  }

  /** Contrôles de la passerelle sur la sortie (fiche de contrôle). */
  /**
   * Appel du fournisseur d'IA (deuxième passe adverse, 27/09/2026) : une panne ou une sortie mal formée ne devient
   * jamais une « erreur interne » opaque ni une recommandation partielle. Refus 503 IA_INDISPONIBLE avec un message
   * exact, trace d'audit et alerte de l'exploitant (une par agent et par jour) ; le travail continue sans IA.
   */
  private runProvider(sheet: AgentSheet, gw: DataGateway, opts: AgentRunOptions, by: Requester): (AgentDraft & { quiet?: boolean })[] {
    let drafts: unknown;
    let failure: string | null = null;
    try {
      drafts = this.provider.run(sheet, gw, opts);
      if (!Array.isArray(drafts)) failure = 'SORTIE_MAL_FORMEE';
      else if (!drafts.every((d) => IaService.wellFormed(d))) failure = 'SORTIE_MAL_FORMEE';
    } catch (e) {
      if (e instanceof ApiError) throw e;
      failure = 'FOURNISSEUR_EN_ERREUR';
    }
    if (failure) {
      this.ctx.audit.append({
        actor: { kind: 'system', id: 'ia' }, action: 'ia.provider.failed', resourceType: 'ia_agent', resourceId: sheet.code, outcome: 'FAILURE',
        details: { agent: sheet.code, cause: failure, modelVersion: this.provider.modelVersion, requestedBy: by.id },
      });
      this.ctx.alerts.raiseOnce(`ia:${sheet.code}:${failure}:${kinshasaDate(this.ctx.clock.now())}`, {
        type: 'IA_FOURNISSEUR_EN_ECHEC', severity: 'MEDIUM', source: `ia:${sheet.code}`,
        detail: `Agent « ${sheet.name} » : ${failure === 'SORTIE_MAL_FORMEE' ? 'sortie mal formée rejetée' : 'fournisseur en erreur'} ; aucune recommandation produite.`,
        context: { agent: sheet.code, cause: failure, automaticEffect: 'AUCUN' },
      });
      throw new ApiError(503, 'IA_INDISPONIBLE', `L’assistant « ${sheet.name} » est momentanément indisponible (${failure === 'SORTIE_MAL_FORMEE' ? 'réponse non conforme rejetée' : 'fournisseur en erreur'}) : aucune recommandation n’a été produite. Poursuivez le traitement sans l’assistant ou réessayez plus tard.`);
    }
    return drafts as (AgentDraft & { quiet?: boolean })[];
  }

  /** Forme minimale d'une sortie d'agent (champs lus par la suite du traitement). */
  private static wellFormed(d: unknown): boolean {
    if (!d || typeof d !== 'object') return false;
    const x = d as Record<string, unknown>;
    return typeof x.key === 'string' && typeof x.situation === 'string' && typeof x.owner === 'string'
      && typeof x.autonomy === 'string' && ['A_AUTO', 'B_VALIDATION', 'C_RECOMMANDATION'].includes(x.autonomy) && Array.isArray(x.actions)
      && x.actions.every((a) => !!a && typeof a === 'object' && typeof (a as Record<string, unknown>).type === 'string' && typeof (a as Record<string, unknown>).level === 'string');
  }

  private checkDraft(sheet: AgentSheet, d: AgentDraft): void {
    for (const a of d.actions) {
      if (!sheet.allowedActions.includes(a.type)) throw forbidden('IA_ACTION_NOT_IN_SHEET', `Action ${a.type} hors de la fiche de l’agent ${sheet.name}.`);
      const isA = (LEVEL_A_ACTIONS as readonly string[]).includes(a.type);
      if ((a.level === 'A') !== isA) throw forbidden('IA_ACTION_LEVEL_MISMATCH', `Niveau incohérent pour ${a.type}.`);
    }
    if (!/\bR\d{2}\b/.test(d.owner) || /^\s*(l['’])?(IA|intelligence artificielle)\b/i.test(d.owner)) throw unprocessable('IA_OWNER_INVALID', 'Le responsable doit être un rôle humain, jamais « l’IA ».');
  }

  private outputHash(r: IaRecommendation): string {
    return sha256Hex(canonicalJson({
      situation: r.situation, insight: r.insight, risk: r.risk, recommendation: r.recommendation, nextAction: r.nextAction, owner: r.owner,
      deadline: r.deadline, confidence: r.confidence, sources: r.sources, decision: r.decision ?? null, recommendedStep: r.recommendedStep ?? null,
      autonomy: r.autonomy, actions: r.actions.map((a) => ({ type: a.type, level: a.level, label: a.label, params: a.params })),
    }));
  }

  // ---------------------------------------------------------------- Niveau A
  settings(entity: string): AutonomySettings {
    const s = this.autonomy.get(entity);
    if (s) { const { id: _id, ...rest } = s; return rest; }
    return { entity, levelAEnabled: true, disabledActions: [], disabledAgents: [] };
  }

  getAutonomy(user: User, entity: string) {
    authorize(user, 'ia:autonomy.read');
    return { ...this.settings(entity), canEdit: Boolean(evaluate(user, 'ia:autonomy.write', { entity })), actions: LEVEL_A_ACTIONS.map((t) => ({ type: t, label: ACTION_LABELS[t] })) };
  }

  putAutonomy(user: User, entity: string, input: { levelAEnabled: boolean; disabledActions: LevelAAction[]; disabledAgents: AgentCode[]; reason: string }) {
    authorize(user, 'ia:autonomy.write', { entity });
    const next = { id: entity, entity, levelAEnabled: input.levelAEnabled, disabledActions: input.disabledActions, disabledAgents: input.disabledAgents, updatedAt: this.now(), updatedBy: user.id, reason: input.reason };
    if (this.autonomy.get(entity)) this.autonomy.update(next); else this.autonomy.insert(next);
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'ia.autonomy.updated', resourceType: 'ia_autonomy', resourceId: entity, details: { levelAEnabled: input.levelAEnabled, disabledActions: input.disabledActions, disabledAgents: input.disabledAgents, reason: input.reason } });
    return this.getAutonomy(user, entity);
  }

  private autoAllowed(entity: string, code: AgentCode, type: ActionType): string | null {
    const s = this.settings(entity);
    if (!s.levelAEnabled) return `Exécution automatique de niveau A désactivée pour l’entité ${entity}.`;
    if (s.disabledAgents.includes(code)) return `Exécution automatique désactivée pour l’agent ${AGENTS[code].name} (${entity}).`;
    if ((s.disabledActions as string[]).includes(type)) return `Action « ${ACTION_LABELS[type]} » désactivée pour l’entité ${entity}.`;
    return null;
  }

  private autoExecute(rec: IaRecommendation): IaRecommendation {
    let current = rec;
    for (const a of rec.actions) {
      if (a.level !== 'A') continue;
      const blocked = this.autoAllowed(rec.entity, rec.agentCode, a.type);
      if (blocked) {
        current = this.patchAction(current, a.id, { status: 'NON_EXECUTEE_DESACTIVEE', blockedReason: blocked });
        this.log({ type: 'BLOCAGE_AUTONOMIE', agentCode: rec.agentCode, recommendationId: rec.id, entity: rec.entity, actor: { kind: 'system', id: 'politique-autonomie' }, action: { id: a.id, type: a.type }, detail: blocked });
        continue;
      }
      current = this.execute(current, a.id, { kind: 'ai', actor: this.aiActor(AGENTS[rec.agentCode]) });
    }
    const allAuto = current.actions.length > 0 && current.actions.every((a) => a.status === 'EXECUTEE_AUTO') && current.autonomy === 'A_AUTO';
    return allAuto ? this.recommendations.update({ ...current, status: 'TRAITEE_AUTO' }) : current;
  }

  private patchAction(rec: IaRecommendation, actionId: string, patch: Partial<ProposedAction>): IaRecommendation {
    return this.recommendations.update({ ...rec, actions: rec.actions.map((a) => (a.id === actionId ? { ...a, ...patch } : a)) });
  }

  // ---------------------------------------------------------------- Exécution d'une action (A par l'IA, A/B par un humain)
  private execute(rec: IaRecommendation, actionId: string, by: { kind: 'ai'; actor: AiActor } | { kind: 'user'; user: User }): IaRecommendation {
    const a = rec.actions.find((x) => x.id === actionId);
    if (!a) throw notFound('IA_ACTION_NOT_FOUND', `Action inconnue : ${actionId}`);
    if (by.kind === 'ai') {
      // Garde : l'IA ne peut exécuter qu'une action de niveau A assimilée à un brouillon (aucun effet juridique ni financier).
      if (a.level !== 'A') assertAiMay(by.actor, `ia:action.${a.type}`);
      assertAiMay(by.actor, 'draft.write');
    } else {
      authorize(by.user, `ia:action.${a.type}`, this.resourceOf(rec));
    }
    const actorId = by.kind === 'ai' ? by.actor.id : by.user.id;
    const p = a.params;
    const now = this.now();
    const base = {
      id: this.ids.next('IAE'), type: EFFECT_OF[a.type], recommendationId: rec.id, actionId: a.id, entity: rec.entity,
      status: 'ACTIF' as const, createdAt: now, createdBy: actorId, createdByKind: by.kind, notice: EFFECT_NOTICE,
      ...(rec.subject ? { subject: rec.subject } : {}),
    };
    let effect: IaEffect;
    switch (a.type) {
      case 'CREER_TACHE':
      case 'RAPPEL_FACULTATIF':
        effect = { ...base, title: p['title'] ?? a.label, body: p['body'] ?? '', ...(p['assigneeRole'] ? { assigneeRole: p['assigneeRole'] as RoleCode } : {}) };
        break;
      case 'PREPARER_BROUILLON':
      case 'RESUMER':
      case 'CLASSER':
        effect = { ...base, title: p['title'] ?? a.label, body: p['body'] ?? '', ...(rec.taxpayerId ? { taxpayerId: rec.taxpayerId } : {}), ...(p['subjectId'] ? { subject: { type: p['subjectType'] ?? 'dossier', id: p['subjectId'] } } : {}) };
        break;
      case 'DEMANDER_PIECES': {
        const t = this.ctx.taxpayers.taxpayers.get(p['taxpayerId'] ?? '');
        if (!t) throw unprocessable('TAXPAYER_NOT_FOUND', 'Redevable introuvable pour la demande de pièces.');
        const d = this.ctx.comms.publish('rental.occupancy.inconsistency', [taxpayerRecipient(t)], { objet: p['objectId'] ?? '', reference: rec.id }, { entity: rec.entity });
        effect = { ...base, title: `Demande de pièces — ${p['objectId']}`, body: 'Invitation à déclarer le bail ou la vacance, avec pièces justificatives.', taxpayerId: t.id, subject: { type: 'object', id: p['objectId'] ?? '' }, deliveries: d.length };
        break;
      }
      case 'OUVRIR_MISSION': {
        const agent = this.ctx.users.get(p['agentUserId'] ?? '');
        const commune = p['commune'] ?? '';
        if (!agent || !agent.roles.includes('R10') || !(agent.territory ?? []).includes(commune)) {
          throw forbidden('MISSION_OUT_OF_PERIMETER', `L’agent désigné n’est pas habilité sur ${commune} : aucune affectation hors périmètre.`);
        }
        if (by.kind === 'user' && by.user.territory && !by.user.territory.includes(commune)) {
          throw forbidden('MISSION_OUT_OF_PERIMETER', `La commune ${commune} n’est pas dans votre périmètre.`);
        }
        const d = this.ctx.comms.publish('mission.assigned', [userRecipient(agent)], { reference: rec.id, commune }, { entity: rec.entity });
        effect = { ...base, title: `Mission de vérification — ${commune}`, body: `Objets : ${p['objectIds'] ?? ''}`, assigneeUserId: agent.id, assigneeRole: 'R10', subject: { type: 'commune', id: commune }, deliveries: d.length };
        break;
      }
      case 'RELANCE_OBLIGATOIRE': {
        const o = this.ctx.assessment.obligations.get(p['obligationId'] ?? '');
        if (!o) throw notFound('OBLIGATION_NOT_FOUND', 'Obligation introuvable.');
        if (!['EMISE', 'EXIGIBLE', 'PARTIELLEMENT_PAYEE', 'EN_RETARD'].includes(o.status) || o.appealId || o.dueDate >= kinshasaDate(this.ctx.clock.now())) {
          throw conflict('RELANCE_NO_LONGER_APPLICABLE', `Relance sans objet : obligation au statut ${o.status}${o.appealId ? ', contestée' : ''}.`);
        }
        const t = this.ctx.taxpayers.get(o.taxpayerId);
        const d = this.ctx.comms.publish('recovery.reminder.1', [taxpayerRecipient(t)], { reference: o.id }, { entity: rec.entity });
        effect = { ...base, title: `Relance n° 1 — ${o.id}`, body: 'Rappel du montant, de la référence de paiement et des voies de recours. Aucune pénalité.', taxpayerId: o.taxpayerId, subject: { type: 'obligation', id: o.id }, deliveries: d.length };
        break;
      }
      case 'OUVRIR_DOSSIER_VERIFICATION':
        effect = { ...base, title: `Dossier de vérification — ${p['title'] ?? ''}`, body: `${p['body'] ?? ''}\nConfidentiel. Un signal n’est pas une preuve : aucune personne n’est mise en cause.`, assigneeRole: 'R24', subject: { type: 'signal', id: p['ref'] ?? '' } };
        break;
    }
    const stored = this.effects.insert(effect);
    const status = by.kind === 'ai' ? 'EXECUTEE_AUTO' : 'EXECUTEE';
    const updated = this.patchAction(rec, a.id, { status, effectId: stored.id, executedBy: actorId, executedByKind: by.kind, executedAt: now, blockedReason: undefined });
    const audit = this.ctx.audit.append({
      actor: by.kind === 'ai' ? { kind: 'ai', id: actorId } : { kind: 'user', id: actorId, roles: by.user.roles },
      action: 'ia.action.executed', resourceType: 'ia_recommendation', resourceId: rec.id,
      details: { actionId: a.id, type: a.type, level: a.level, effectId: stored.id, auto: by.kind === 'ai' },
    });
    this.log({
      type: by.kind === 'ai' ? 'EXECUTION_AUTO' : 'EXECUTION', agentCode: rec.agentCode, recommendationId: rec.id, entity: rec.entity,
      actor: by.kind === 'ai' ? { kind: 'ai', id: actorId } : { kind: 'user', id: actorId, role: by.user.roles[0] },
      action: { id: a.id, type: a.type, effectId: stored.id }, auditId: audit.id,
    });
    this.memory.signal(rec.agentCode, by.kind === 'ai' ? 'actions_auto' : 'actions_validees', a.type);
    return updated;
  }

  private resourceOf(rec: IaRecommendation): Resource {
    return { entity: rec.entity, ...(rec.taxpayerId ? { taxpayerId: rec.taxpayerId } : {}) };
  }

  // ---------------------------------------------------------------- Consultation
  visible(user: User, rec: IaRecommendation): boolean {
    if (this.isOversight(user)) return true;
    if (rec.entity === 'PUBLIC') {
      return rec.requestedBy === user.id || Boolean(evaluate(user, `ia:run.${rec.agentCode}`, this.resourceOf(rec)) && (user.roles.includes('R30') || user.roles.includes('R31')));
    }
    if (user.roles.every((r) => r === 'R30' || r === 'R31')) return false;
    const s = AGENTS[rec.agentCode];
    return user.entity === rec.entity || user.roles.some((r) => s.runners.includes(r) || s.validators.includes(r));
  }

  inbox(user: User, f: { agent?: string; autonomy?: string; status?: string } = {}) {
    authorize(user, 'ia:inbox.read');
    if (this.demoSweepPending) { this.demoSweepPending = false; this.sweep({ kind: 'system', id: 'balayage-initial' }); }
    return this.recommendations.all()
      .filter((r) => this.visible(user, r))
      .filter((r) => (!f.agent || r.agentCode === f.agent) && (!f.autonomy || r.autonomy === f.autonomy) && (!f.status || r.status === f.status))
      .map((r) => this.present(user, r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  get(user: User, id: string) {
    const r = this.recommendations.get(id);
    if (!r || !this.visible(user, r)) throw notFound('IA_RECOMMENDATION_NOT_FOUND', `Recommandation inconnue : ${id}`);
    return this.present(user, r);
  }

  private present(user: User, r: IaRecommendation) {
    const canDecide = Boolean(evaluate(user, `ia:decide.${r.agentCode}`, this.resourceOf(r)));
    return {
      ...r,
      crossAgents: r.crossAgents,
      canDecide,
      canValidate: canDecide && r.actions.some((a) => a.status === 'PROPOSEE' || a.status === 'NON_EXECUTEE_DESACTIVEE'),
      canUndo: r.actions.some((a) => (a.status === 'EXECUTEE' || a.status === 'EXECUTEE_AUTO') && Boolean(evaluate(user, `ia:action.${a.type}`, this.resourceOf(r)))),
      effects: this.effects.find((e) => e.recommendationId === r.id),
    };
  }

  private load(user: User, id: string): IaRecommendation {
    const r = this.recommendations.get(id);
    if (!r || !this.visible(user, r)) throw notFound('IA_RECOMMENDATION_NOT_FOUND', `Recommandation inconnue : ${id}`);
    return r;
  }

  // ---------------------------------------------------------------- Décisions humaines
  /** Validation (niveau B, ou A non exécutée) : exécute les actions au nom du validateur. */
  validate(user: User, id: string, input: { reason: string; actionIds?: string[] }) {
    let rec = this.load(user, id);
    authorize(user, `ia:decide.${rec.agentCode}`, this.resourceOf(rec));
    if (rec.status !== 'EMISE' && rec.status !== 'TRAITEE_AUTO') throw conflict('ALREADY_DECIDED', `Recommandation déjà décidée (${rec.status}).`);
    const pending = rec.actions.filter((a) => (a.status === 'PROPOSEE' || a.status === 'NON_EXECUTEE_DESACTIVEE') && (!input.actionIds || input.actionIds.includes(a.id)));
    if (pending.length === 0) throw conflict('NOTHING_TO_EXECUTE', rec.autonomy === 'C_RECOMMANDATION' ? 'Recommandation de niveau C : rien n’est exécutable ; utilisez la décision (acceptée, modifiée, rejetée) puis le circuit du domaine.' : 'Aucune action en attente de validation.');
    for (const a of pending) rec = this.execute(rec, a.id, { kind: 'user', user });
    const remaining = rec.actions.filter((a) => a.status === 'PROPOSEE' || a.status === 'NON_EXECUTEE_DESACTIVEE');
    rec = this.recommendations.update({ ...rec, actions: rec.actions.map((a) => (remaining.includes(a) ? { ...a, status: 'ABANDONNEE' as const } : a)) });
    return this.close(user, rec, 'ACCEPTEE', input.reason, 'VALIDATION');
  }

  decide(user: User, id: string, input: { decision: 'ACCEPTEE' | 'MODIFIEE' | 'REJETEE'; reason: string; modification?: string }) {
    let rec = this.load(user, id);
    authorize(user, `ia:decide.${rec.agentCode}`, this.resourceOf(rec));
    if (rec.status !== 'EMISE' && rec.status !== 'TRAITEE_AUTO') throw conflict('ALREADY_DECIDED', `Recommandation déjà décidée (${rec.status}).`);
    const pendingExec = rec.actions.filter((a) => a.status === 'PROPOSEE' && a.level === 'B');
    if (input.decision === 'ACCEPTEE' && pendingExec.length > 0) {
      throw conflict('VALIDATION_REQUIRED', 'Cette recommandation comporte des actions de niveau B : utilisez « Valider et exécuter » (un clic) pour qu’elles soient exécutées en votre nom.');
    }
    if (input.decision === 'MODIFIEE' && !input.modification?.trim()) throw badRequest('MODIFICATION_REQUIRED', 'Décrivez la modification retenue.');
    if (input.decision === 'REJETEE') {
      // Rejet : les effets automatiques de niveau A sont retirés (ils étaient réversibles par construction).
      for (const a of rec.actions.filter((x) => x.status === 'EXECUTEE_AUTO')) rec = this.revert(rec, a.id, user, `Recommandation rejetée : ${input.reason}`);
    }
    rec = this.recommendations.update({ ...rec, actions: rec.actions.map((a) => (a.status === 'PROPOSEE' || a.status === 'NON_EXECUTEE_DESACTIVEE' ? { ...a, status: 'ABANDONNEE' as const } : a)) });
    return this.close(user, rec, input.decision, input.reason, 'DECISION', input.modification);
  }

  private close(user: User, rec: IaRecommendation, decision: 'ACCEPTEE' | 'MODIFIEE' | 'REJETEE', reason: string, type: JournalEventType, modification?: string) {
    const s = AGENTS[rec.agentCode];
    const role = this.primaryRole(user, s.validators);
    const at = this.now();
    const latency = Date.parse(at) - Date.parse(rec.createdAt);
    const updated = this.recommendations.update({
      ...rec, status: decision, decidedBy: user.id, decidedByRole: role, decidedAt: at, decisionReason: reason, decisionLatencyMs: latency,
      ...(modification ? { modification } : {}),
      notice: decision === 'REJETEE' ? `Préparé avec l’assistance de l’IA — rejeté par ${roleLabel(role)}.` : `Préparé avec l’assistance de l’IA — validé par ${roleLabel(role)}.`,
    });
    const audit = this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: type === 'VALIDATION' ? 'ia.recommendation.validated' : 'ia.recommendation.decided',
      resourceType: 'ia_recommendation', resourceId: rec.id, details: { decision, reason, autonomy: rec.autonomy, agent: rec.agentCode, latencyMs: latency, ...(modification ? { modification } : {}) },
    });
    this.log({
      type, agentCode: rec.agentCode, recommendationId: rec.id, entity: rec.entity, actor: { kind: 'user', id: user.id, role },
      decision: { decision, reason, role, latencyMs: latency }, auditId: audit.id,
      ...(rec.autonomy === 'C_RECOMMANDATION' && rec.circuit ? { detail: `Aucune exécution (niveau C). Circuit : ${rec.circuit}` } : {}),
    });
    if (rec.entity !== 'PUBLIC') this.memory.recordDecision(rec.entity, { recommendationId: rec.id, agent: rec.agent, decision, reasonSummary: reason, decidedByRole: roleLabel(role) });
    this.memory.signal(rec.agentCode, 'decisions', decision);
    return this.present(user, updated);
  }

  /** Annulation d'une action exécutée (A ou B) : l'effet est retiré, jamais détruit ; journalisé. */
  undo(user: User, id: string, actionId: string, reason: string) {
    const rec = this.load(user, id);
    const a = rec.actions.find((x) => x.id === actionId);
    if (!a) throw notFound('IA_ACTION_NOT_FOUND', `Action inconnue : ${actionId}`);
    if (a.status !== 'EXECUTEE' && a.status !== 'EXECUTEE_AUTO') throw conflict('ACTION_NOT_EXECUTED', `Action au statut ${a.status} : rien à annuler.`);
    authorize(user, `ia:action.${a.type}`, this.resourceOf(rec));
    let updated = this.revert(rec, actionId, user, reason);
    const executed = updated.actions.filter((x) => x.executedAt);
    if (executed.length > 0 && executed.every((x) => x.status === 'ANNULEE') && (updated.status === 'ACCEPTEE' || updated.status === 'TRAITEE_AUTO')) {
      updated = this.recommendations.update({ ...updated, status: 'ANNULEE' as IaStatus });
    }
    return this.present(user, updated);
  }

  private revert(rec: IaRecommendation, actionId: string, user: User, reason: string): IaRecommendation {
    const a = rec.actions.find((x) => x.id === actionId)!;
    const now = this.now();
    if (a.effectId) {
      const e = this.effects.get(a.effectId);
      if (e) this.effects.update({ ...e, status: 'ANNULE', undoneAt: now, undoneBy: user.id, undoReason: reason });
    }
    const updated = this.patchAction(rec, actionId, { status: 'ANNULEE', undoneAt: now, undoneBy: user.id, undoReason: reason });
    const audit = this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'ia.action.undone', resourceType: 'ia_recommendation', resourceId: rec.id, details: { actionId, type: a.type, effectId: a.effectId, reason } });
    this.log({ type: 'ANNULATION', agentCode: rec.agentCode, recommendationId: rec.id, entity: rec.entity, actor: { kind: 'user', id: user.id, role: user.roles[0] }, action: { id: actionId, type: a.type, ...(a.effectId ? { effectId: a.effectId } : {}) }, detail: reason, auditId: audit.id });
    return updated;
  }

  // ---------------------------------------------------------------- Effets, journal, statistiques
  effectsFor(user: User, f: { type?: string; status?: string } = {}) {
    const all = Boolean(evaluate(user, 'ia:effects.all'));
    return this.effects.all().filter((e) => {
      if ((f.type && e.type !== f.type) || (f.status && e.status !== f.status)) return false;
      if (all) return true;
      if (e.taxpayerId && (user.taxpayerId === e.taxpayerId || (user.mandants ?? []).includes(e.taxpayerId)) && ['BROUILLON', 'RESUME'].includes(e.type)) return true;
      if (user.roles.every((r) => r === 'R30' || r === 'R31')) return false;
      return e.entity === user.entity || e.assigneeUserId === user.id || (e.assigneeRole !== undefined && user.roles.includes(e.assigneeRole));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  journalFor(user: User, f: { agent?: string; recommendationId?: string; type?: string } = {}) {
    const all = Boolean(evaluate(user, 'ia:journal.all'));
    if (!all) authorize(user, 'ia:journal.read', { entity: user.entity });
    return this.journal.all()
      .filter((j) => all || j.entity === user.entity)
      .filter((j) => (!f.agent || j.agentCode === f.agent) && (!f.recommendationId || j.recommendationId === f.recommendationId) && (!f.type || j.type === f.type))
      .reverse();
  }

  /** Reconstitution d'une recommandation : journal, effets, audit lié et contrôle d'intégrité de la sortie (C3-188). */
  reconstitute(user: User, id: string) {
    const rec = this.recommendations.get(id);
    if (!rec) throw notFound('IA_RECOMMENDATION_NOT_FOUND', `Recommandation inconnue : ${id}`);
    const all = Boolean(evaluate(user, 'ia:journal.all'));
    if (!all) authorize(user, 'ia:journal.read', { entity: rec.entity });
    return {
      recommendation: rec,
      outputIntact: this.outputHash(rec) === rec.outputHash,
      journal: this.journal.find((j) => j.recommendationId === id),
      effects: this.effects.find((e) => e.recommendationId === id),
      audit: this.ctx.audit.list({ resourceId: id, limit: 1000 }).items.map((a) => ({ id: a.id, at: a.at, action: a.action, actorKind: a.actor.kind, hash: a.hash })),
    };
  }

  agentStats(code: AgentCode) {
    const recs = this.recommendations.find((r) => r.agentCode === code);
    const decided = recs.filter((r) => r.decidedAt);
    const latencies = decided.map((r) => r.decisionLatencyMs ?? 0);
    return {
      total: recs.length,
      pending: recs.filter((r) => r.status === 'EMISE').length,
      auto: recs.filter((r) => r.status === 'TRAITEE_AUTO').length,
      accepted: recs.filter((r) => r.status === 'ACCEPTEE').length,
      modified: recs.filter((r) => r.status === 'MODIFIEE').length,
      rejected: recs.filter((r) => r.status === 'REJETEE').length,
      undone: recs.filter((r) => r.status === 'ANNULEE').length,
      medianLatencyMs: latencies.length ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)]! : null,
    };
  }

  /** Mémoire de processus d'une recommandation (type « ia »). */
  iaProcess(user: User, id: string): Omit<ProcessState, 'key' | 'history' | 'recentChanges' | 'computedAt' | 'retention'> | null {
    const r = this.recommendations.get(id);
    if (!r || !this.visible(user, r)) return null;
    const pending = r.actions.filter((a) => a.status === 'PROPOSEE' || a.status === 'NON_EXECUTEE_DESACTIVEE');
    return {
      resourceType: 'ia', resourceId: id, step: r.status,
      done: ['Émission', ...r.actions.filter((a) => a.executedAt).map((a) => `${ACTION_LABELS[a.type]} (${a.status === 'ANNULEE' ? 'annulée' : a.executedByKind === 'ai' ? 'auto' : 'validée'})`), ...(r.decidedAt ? [`Décision : ${r.status}`] : [])],
      pending: r.decidedAt ? [] : [...pending.map((a) => ACTION_LABELS[a.type]), 'Décision humaine'],
      blockedBy: r.actions.find((a) => a.status === 'NON_EXECUTEE_DESACTIVEE')?.blockedReason ?? null,
      nextDecision: r.decidedAt ? null : r.autonomy === 'C_RECOMMANDATION' ? 'Accepter, modifier ou rejeter (puis circuit du domaine)' : 'Valider et exécuter, ou rejeter',
      owner: r.decidedAt ? null : AGENTS[r.agentCode].validators.join(', '),
    };
  }

  seedDemo(): void {
    const add = (u: Omit<User, 'kind'>) => { if (!this.ctx.users.get(u.id)) this.ctx.users.add(u); };
    add({ id: 'ia-gestionnaire-modeles', name: 'Gestionnaire des modèles IA (démo)', roles: ['R29'], entity: 'PLATEFORME' });
    add({ id: 'ia-dpo', name: 'Délégué à la protection des données (démo)', roles: ['R25'], entity: 'PLATEFORME' });
    add({ id: 'ia-admin-tresor', name: "Administrateur d'entité Trésor (démo)", roles: ['R08'], entity: 'TRESOR' });
    add({ id: 'ia-chef-service', name: 'Chef de service de régie DGIPK (démo)', roles: ['R07'], entity: 'DGIPK' });
    const admin = this.ctx.users.get('u-admin-entite');
    if (admin) {
      this.memory.addEntityItem(admin, 'DGIPK', { kind: 'HYPOTHESE', title: 'Seuil de vérification locative (démonstration)', content: 'Une unité est proposée à la vérification à partir d’un score indicatif de 0,50 (hypothèse de travail de démonstration, à valider).' }, { silent: true });
      this.memory.addEntityItem(admin, 'DGIPK', { kind: 'MODELE', title: 'Modèle de demande de pièces (démonstration)', content: 'Objet : déclaration du bail ou de la vacance. Pièces : bail signé ou attestation de vacance. Délai de réponse : 15 jours.' }, { silent: true });
    }
    this.demoSweepPending = true;
  }
}

export { ROLES };
