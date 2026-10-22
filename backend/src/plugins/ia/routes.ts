import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { notFound } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { MEMORY_LEVELS } from './memory.js';
import type { IaService } from './service.js';
import { AGENT_CODES, LEVEL_A_ACTIONS } from './types.js';

const reason = z.string().trim().min(3).max(1000);
const runSchema = z.object({
  purpose: z.string().trim().min(3).max(300),
  subject: z.object({ type: z.string().min(1).max(40), id: z.string().min(1).max(120) }).strict().optional(),
  question: z.string().trim().max(500).optional(),
  taxpayerId: z.string().max(80).optional(),
}).strict();
const validateSchema = z.object({ reason, actionIds: z.array(z.string().max(20)).max(20).optional() }).strict();
const decideSchema = z.object({ decision: z.enum(['ACCEPTEE', 'MODIFIEE', 'REJETEE']), reason, modification: z.string().trim().max(2000).optional() }).strict();
const stateSchema = z.object({ enabled: z.boolean(), reason }).strict();
const autonomySchema = z.object({
  levelAEnabled: z.boolean(),
  disabledActions: z.array(z.enum(LEVEL_A_ACTIONS)).max(10).default([]),
  disabledAgents: z.array(z.enum(AGENT_CODES)).max(20).default([]),
  reason,
}).strict();
const memValue = z.union([z.string().max(500), z.array(z.string().max(500)).max(20)]);
const userMemSchema = z.object({ key: z.string().min(1).max(60), value: memValue }).strict();
const entityItemSchema = z.object({ kind: z.enum(['HYPOTHESE', 'MODELE']), title: z.string().trim().min(3).max(200), content: z.string().trim().min(3).max(2000), refs: z.array(z.string().max(120)).max(20).optional() }).strict();
const eraseSchema = z.object({ reason }).strict();
const intelEraseSchema = z.object({ reason, agentCode: z.enum(AGENT_CODES).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).strict();

export function registerIaRoutes(app: FastifyInstance, ctx: AppContext, svc: IaService): void {
  // Agents
  app.get('/v1/ia/agents', async (req) => svc.catalogue(requireUser(req)));
  app.post<{ Params: { code: string } }>('/v1/ia/agents/:code/run', async (req, reply) => {
    const user = requireUser(req);
    return reply.code(201).send(svc.run(user, req.params.code, parse(runSchema, req.body)));
  });
  app.post<{ Params: { code: string } }>('/v1/ia/agents/:code/state', async (req) => {
    const body = parse(stateSchema, req.body);
    return svc.setAgentState(requireUser(req), req.params.code, body.enabled, body.reason);
  });
  app.post('/v1/ia/sweep', async (req) => svc.sweepByUser(requireUser(req)));

  // Boîte de réception et décisions
  app.get<{ Querystring: { agent?: string; autonomy?: string; status?: string } }>('/v1/ia/inbox', async (req) => {
    const q = req.query;
    return svc.inbox(requireUser(req), { ...(q.agent ? { agent: q.agent } : {}), ...(q.autonomy ? { autonomy: q.autonomy } : {}), ...(q.status ? { status: q.status } : {}) });
  });
  app.get<{ Params: { id: string } }>('/v1/ia/recommendations/:id', async (req) => svc.get(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/ia/recommendations/:id/validate', async (req) => svc.validate(requireUser(req), req.params.id, parse(validateSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/ia/recommendations/:id/decide', async (req) => {
    const b = parse(decideSchema, req.body);
    return svc.decide(requireUser(req), req.params.id, { decision: b.decision, reason: b.reason, ...(b.modification ? { modification: b.modification } : {}) });
  });
  app.post<{ Params: { id: string; actionId: string } }>('/v1/ia/recommendations/:id/actions/:actionId/undo', async (req) =>
    svc.undo(requireUser(req), req.params.id, req.params.actionId, parse(eraseSchema, req.body).reason));
  app.get<{ Querystring: { type?: string; status?: string } }>('/v1/ia/effects', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:inbox.read');
    return svc.effectsFor(user, { ...(req.query.type ? { type: req.query.type } : {}), ...(req.query.status ? { status: req.query.status } : {}) });
  });

  // Autonomie par entité
  app.get<{ Params: { entity: string } }>('/v1/ia/autonomy/:entity', async (req) => svc.getAutonomy(requireUser(req), req.params.entity));
  app.put<{ Params: { entity: string } }>('/v1/ia/autonomy/:entity', async (req) => svc.putAutonomy(requireUser(req), req.params.entity, parse(autonomySchema, req.body)));

  // Journal IA
  app.get<{ Querystring: { agent?: string; recommendationId?: string; type?: string } }>('/v1/ia/journal', async (req) => {
    const q = req.query;
    return svc.journalFor(requireUser(req), { ...(q.agent ? { agent: q.agent } : {}), ...(q.recommendationId ? { recommendationId: q.recommendationId } : {}), ...(q.type ? { type: q.type } : {}) });
  });
  app.get<{ Params: { id: string } }>('/v1/ia/journal/:id', async (req) => svc.reconstitute(requireUser(req), req.params.id));

  // Mémoire à quatre niveaux
  app.get('/v1/ia/memory/levels', async (req) => { requireUser(req); return MEMORY_LEVELS; });
  app.get('/v1/ia/memory/me', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.user');
    return svc.memory.getUser(user);
  });
  app.put('/v1/ia/memory/me', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.user');
    const b = parse(userMemSchema, req.body);
    return svc.memory.putUser(user, b.key, b.value);
  });
  app.post<{ Params: { id: string } }>('/v1/ia/memory/me/outputs/:id', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.user');
    svc.get(user, req.params.id);
    return svc.memory.saveOutput(user, req.params.id);
  });
  app.delete<{ Querystring: { key?: string } }>('/v1/ia/memory/me', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.user');
    return svc.memory.eraseUser(user, req.query.key);
  });
  app.get<{ Params: { userId: string } }>('/v1/ia/memory/users/:userId', async (req) => {
    const user = requireUser(req);
    if (req.params.userId === user.id) return svc.memory.getUser(user);
    return svc.memory.getOtherUser(user, req.params.userId);
  });
  app.get<{ Params: { entity: string } }>('/v1/ia/memory/entities/:entity', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.entity.read', { entity: req.params.entity });
    return svc.memory.entity(req.params.entity);
  });
  app.post<{ Params: { entity: string } }>('/v1/ia/memory/entities/:entity/items', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.entity.write', { entity: req.params.entity });
    const b = parse(entityItemSchema, req.body);
    return reply.code(201).send(svc.memory.addEntityItem(user, req.params.entity, { kind: b.kind, title: b.title, content: b.content, ...(b.refs ? { refs: b.refs } : {}) }));
  });
  app.post<{ Params: { entity: string; id: string } }>('/v1/ia/memory/entities/:entity/items/:id/erase', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.entity.erase', { entity: req.params.entity });
    const item = svc.memory.entityItems.get(req.params.id);
    if (!item || item.entity !== req.params.entity) throw notFound('MEMORY_ITEM_NOT_FOUND', `Élément de mémoire inconnu : ${req.params.id}`);
    return svc.memory.eraseEntityItem(user, req.params.id, parse(eraseSchema, req.body).reason);
  });
  app.get<{ Params: { type: string; id: string } }>('/v1/ia/memory/processes/:type/:id', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.process');
    return svc.memory.process(user, req.params.type, req.params.id, (id) => svc.iaProcess(user, id));
  });
  app.get<{ Querystring: { agent?: string } }>('/v1/ia/memory/intelligence', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.intelligence.read');
    return svc.memory.intelligence(req.query.agent ? { agentCode: req.query.agent } : {});
  });
  app.post('/v1/ia/memory/intelligence/erase', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.intelligence.erase');
    const b = parse(intelEraseSchema, req.body);
    return svc.memory.eraseIntelligence(user, { ...(b.agentCode ? { agentCode: b.agentCode } : {}), ...(b.period ? { period: b.period } : {}) }, b.reason);
  });
  app.get('/v1/ia/memory/register', async (req) => {
    authorize(requireUser(req), 'ia:memory.register');
    return svc.memory.register();
  });
  app.post('/v1/ia/memory/purge', async (req) => {
    const user = requireUser(req);
    authorize(user, 'ia:memory.purge');
    return svc.memory.purge(user.id);
  });
  void ctx;
}
