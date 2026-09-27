import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { moneySchema, parse } from '../../core/http.js';
import { authorize, evaluate } from '../../core/policy.js';
import { forbidden } from '../../core/errors.js';
import type { User } from '../../core/auth.js';
import { APPEAL_PROCEDURE, APPEAL_TYPE_LABELS, APPEAL_TYPES } from './procedure.js';
import type { Appeal } from './service.js';

const decisionEnum = z.enum(['ACCEPTEE', 'PARTIELLEMENT_ACCEPTEE', 'REJETEE']);
const documentSchema = z.object({
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'empreinte SHA-256 attendue'),
  name: z.string().trim().min(1).max(200),
  mediaType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().nonnegative().max(50_000_000).optional(),
}).strict();
const submitSchema = z.object({
  obligationId: z.string(),
  grounds: z.string().trim().min(5).max(5000),
  requestedAmount: moneySchema.optional(),
  type: z.enum(APPEAL_TYPES).optional(),
  requestSuspensiveEffect: z.boolean().optional(),
  suspensiveReason: z.string().trim().min(5).max(2000).optional(),
  documents: z.array(documentSchema).max(20).optional(),
}).strict();
const suspensiveRequestSchema = z.object({ reason: z.string().trim().min(5).max(2000) }).strict();
const suspensiveDecisionSchema = z.object({ granted: z.boolean(), reason: z.string().trim().min(10).max(2000) }).strict();

/** Accès au dossier : contribuable concerné (ou mandataire), instruction, décision, audit. */
function canRead(user: User, a: Pick<Appeal, 'taxpayerId'>): boolean {
  return !!(evaluate(user, 'appeal.submit', { taxpayerId: a.taxpayerId }) || evaluate(user, 'appeal.instruct') || evaluate(user, 'appeal.decide') || evaluate(user, 'audit.read'));
}
const isAgentReader = (user: User) => !!(evaluate(user, 'appeal.instruct') || evaluate(user, 'appeal.decide') || evaluate(user, 'audit.read'));
const instructSchema = z.object({ proposal: decisionEnum, analysis: z.string().trim().min(5).max(5000), proposedAmount: moneySchema.optional() }).strict();
const decideSchema = z.object({
  decision: decisionEnum, reason: z.string().trim().min(5).max(5000), rectifiedAmount: moneySchema.optional(),
  // Re-liquidation justificative : entrées corrigées (même règle, même version) ; son résultat est un plancher.
  reliquidationInputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().regex(/^\d{1,15}(\.\d{1,6})?$/)).optional(),
}).strict();

export function registerAppealRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/appeals', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(ctx.appeals.submit(user, parse(submitSchema, req.body)));
  });

  /** Paramètres de procédure (délais de conception À VÉRIFIER, types de contestation). */
  app.get('/v1/appeals/procedure', async (req) => {
    requireUser(req);
    return { ...APPEAL_PROCEDURE, types: APPEAL_TYPES.map((t) => ({ code: t, label: APPEAL_TYPE_LABELS[t] })) };
  });

  /**
   * Historique des réclamations : le contribuable voit les siennes (mandataire : celles de ses mandants) ;
   * instruction, décision et audit voient la file complète (le suivi des délais y est déclenché).
   */
  app.get<{ Querystring: { taxpayerId?: string; status?: string } }>('/v1/appeals', async (req) => {
    const user = requireUser(req);
    const { taxpayerId, status } = req.query;
    if (isAgentReader(user)) {
      ctx.appeals.sweepDeadlines(ctx.users);
      return ctx.appeals.list({ ...(taxpayerId ? { taxpayerId } : {}), ...(status ? { status } : {}) });
    }
    if (taxpayerId) {
      if (!evaluate(user, 'appeal.submit', { taxpayerId })) throw forbidden('FORBIDDEN', 'Historique de réclamations d’un tiers : accès refusé.');
      return ctx.appeals.list({ taxpayerId, ...(status ? { status } : {}) });
    }
    const own = [...(user.taxpayerId ? [user.taxpayerId] : []), ...(user.mandants ?? [])];
    if (!own.length) throw forbidden('FORBIDDEN', 'Aucun dossier de réclamation accessible.');
    return ctx.appeals.list({ taxpayerIds: own, ...(status ? { status } : {}) });
  });

  app.get<{ Params: { id: string } }>('/v1/appeals/:id', async (req) => {
    const user = requireUser(req);
    const a = ctx.appeals.get(req.params.id);
    if (!canRead(user, a)) throw forbidden('FORBIDDEN', 'Accès au dossier de réclamation refusé.');
    return ctx.appeals.view(a);
  });

  /** Pièce jointe par empreinte : contribuable concerné ou agent instructeur. */
  app.post<{ Params: { id: string } }>('/v1/appeals/:id/documents', async (req, reply) => {
    const user = requireUser(req);
    const a = ctx.appeals.get(req.params.id);
    if (!evaluate(user, 'appeal.submit', { taxpayerId: a.taxpayerId }) && !evaluate(user, 'appeal.instruct')) {
      throw forbidden('FORBIDDEN', 'Ajout de pièce refusé.');
    }
    return reply.code(201).send(ctx.appeals.addDocument(user, a.id, parse(documentSchema, req.body)));
  });

  /** Demande d'effet suspensif par le contribuable. */
  app.post<{ Params: { id: string } }>('/v1/appeals/:id/suspensive-effect', async (req) => {
    const user = requireUser(req);
    const a = ctx.appeals.get(req.params.id);
    authorize(user, 'appeal.submit', { taxpayerId: a.taxpayerId });
    return ctx.appeals.requestSuspensiveEffect(user, a.id, parse(suspensiveRequestSchema, req.body).reason);
  });

  /** Décision motivée sur l'effet suspensif (autorité de décision R21). */
  app.post<{ Params: { id: string } }>('/v1/appeals/:id/suspensive-effect/decision', async (req) => {
    const user = requireUser(req);
    authorize(user, 'appeal.decide');
    return ctx.appeals.decideSuspensiveEffect(user, req.params.id, parse(suspensiveDecisionSchema, req.body));
  });

  app.post<{ Params: { id: string } }>('/v1/appeals/:id/instruct', async (req) => {
    const user = requireUser(req);
    authorize(user, 'appeal.instruct');
    return ctx.appeals.view(ctx.appeals.instruct(user, req.params.id, parse(instructSchema, req.body)));
  });

  app.post<{ Params: { id: string } }>('/v1/appeals/:id/decide', async (req) => {
    const user = requireUser(req);
    authorize(user, 'appeal.decide');
    return ctx.appeals.view(ctx.appeals.decide(user, req.params.id, parse(decideSchema, req.body)));
  });
}
