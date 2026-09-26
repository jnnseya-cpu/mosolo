/**
 * Couche d'intelligence (§ 23.5) : produit des AIRecommendation, SANS AUCUN effet tant qu'un humain habilité
 * ne l'a pas acceptée (AC-AI-01). Même acceptée, une recommandation de niveau C n'est jamais exécutée
 * automatiquement : elle doit suivre le circuit maker-checker du domaine concerné.
 */
import type { AIRecommendation } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { AiActor, User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { conflict, notFound } from '../../core/errors.js';
import { assertAiMay, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AIContext, AIDataSnapshot, AIDraft, AIProvider } from './provider.js';

export interface StoredRecommendation extends AIRecommendation {
  context: AIContext;
  subjectId?: string;
  /** Recommandation fondée sur des données d'EXEMPLE */
  example: boolean;
  /** Clé de dédoublonnage (recommandations du tableau de bord) */
  key?: string;
  aiAssistedNotice: string;
}

export const AI_NOTICE = 'Préparé avec l’assistance de l’IA — sans effet tant qu’un agent habilité ne l’a pas validé.';

export class AIService {
  readonly recommendations = new InMemoryRepository<StoredRecommendation>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly provider: AIProvider,
    private readonly snapshot: () => AIDataSnapshot,
  ) {}

  private actor(agent: string): AiActor {
    return { kind: 'ai', id: `agent:${agent}`, agent };
  }

  private store(context: AIContext, draft: AIDraft, opts: { subjectId?: string; key?: string; example: boolean }): StoredRecommendation {
    const ai = this.actor(draft.agent);
    // Garde : l'agent ne peut qu'émettre une recommandation (niveau A, sans effet).
    assertAiMay(ai, 'ai.insight');
    const rec = this.recommendations.insert({
      ...draft,
      id: this.ids.next('AIR'),
      modelVersion: this.provider.modelVersion,
      createdAt: this.clock.now().toISOString(),
      status: 'EMISE',
      context,
      ...(opts.subjectId ? { subjectId: opts.subjectId } : {}),
      ...(opts.key ? { key: opts.key } : {}),
      example: opts.example,
      aiAssistedNotice: AI_NOTICE,
    });
    this.audit.append({
      actor: { kind: 'ai', id: ai.id }, action: 'ai.insight_generated', resourceType: 'ai_recommendation', resourceId: rec.id,
      details: { context, autonomy: rec.autonomy, modelVersion: rec.modelVersion },
    });
    return rec;
  }

  generate(user: User, context: AIContext, subjectId?: string): StoredRecommendation {
    authorize(user, 'ai.insight', { context });
    const [draft] = this.provider.generate(context, this.snapshot(), subjectId);
    // Pas de doublon : si une recommandation identique (même contexte, sujet et situation) attend encore
    // une décision humaine, elle est réutilisée au lieu d'en créer une nouvelle à chaque consultation.
    const pending = this.recommendations.find(
      (r) => r.status === 'EMISE' && r.context === context && r.subjectId === subjectId && r.situation === draft!.situation,
    )[0];
    if (pending) return pending;
    return this.store(context, draft!, { ...(subjectId ? { subjectId } : {}), example: context === 'governor' });
  }

  /** Actions recommandées du tableau de bord du Gouverneur (créées une fois, puis réutilisées). */
  governorActions(): StoredRecommendation[] {
    const existing = this.recommendations.find((r) => r.key !== undefined && r.key.startsWith('governor-dashboard:'));
    if (existing.length > 0) return existing;
    return this.provider.generate('governor', this.snapshot()).map((d, i) => this.store('governor', d, { key: `governor-dashboard:${i}`, example: true }));
  }

  list(user: User, filter: { status?: string; context?: string } = {}): StoredRecommendation[] {
    authorize(user, 'ai.read');
    return this.recommendations.find((r) => (!filter.status || r.status === filter.status) && (!filter.context || r.context === filter.context));
  }

  decide(user: User, id: string, decision: 'ACCEPTEE' | 'REJETEE' | 'MODIFIEE', reason: string): StoredRecommendation {
    const rec = this.recommendations.get(id);
    if (!rec) throw notFound('AI_RECOMMENDATION_NOT_FOUND', `Recommandation inconnue : ${id}`);
    authorize(user, 'ai.decide', { context: rec.context });
    if (rec.status !== 'EMISE') throw conflict('ALREADY_DECIDED', `Recommandation déjà décidée (${rec.status}).`);
    const updated = this.recommendations.update({
      ...rec, status: decision, decidedBy: user.id, decidedAt: this.clock.now().toISOString(), decisionReason: reason,
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'ai.recommendation.decided', resourceType: 'ai_recommendation', resourceId: id,
      details: { decision, reason, autonomy: rec.autonomy, context: rec.context },
    });
    return updated;
  }
}
