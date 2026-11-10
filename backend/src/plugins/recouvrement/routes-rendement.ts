/** Routes du rendement du recouvrement : coûts, brut et net, priorisation, rendement des campagnes, garanties (§ 21.1, § 21.2). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { COST_KINDS, GUARANTEE_NATURES, type RecoveryYieldService } from './rendement.js';

const motive = z.string().trim().min(10, 'motivation d’au moins 10 caractères').max(4000);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const costSchema = z.object({
  caseId: z.string().min(1).max(60).optional(), campaignId: z.string().min(1).max(60).optional(), kind: z.enum(COST_KINDS),
  quantity: z.number().int().min(1).max(1_000_000), amount: moneySchema, evidenceSha256: sha256, note: z.string().trim().min(5).max(1000),
}).strict();
const guaranteeSchema = z.object({ caseId: z.string().min(1).max(60), nature: z.enum(GUARANTEE_NATURES), amount: moneySchema, description: z.string().trim().min(5).max(1000), evidenceSha256: sha256 }).strict();
const guaranteeDecision = z.object({ decision: z.enum(['VALIDEE', 'REJETEE']), motivation: motive }).strict();
const campaignQuery = z.object({ obligationIds: z.string().min(1).max(20_000), since: isoDateString, controlObligationIds: z.string().max(20_000).optional() }).strict();

export function registerRecoveryYieldRoutes(app: FastifyInstance, svc: RecoveryYieldService): void {
  app.get('/v1/recouvrement/rendement', async (req) => svc.board(requireUser(req)));
  app.get('/v1/recouvrement/priorites', async (req) => svc.priorities(requireUser(req)));
  app.post('/v1/recouvrement/couts', async (req, reply) => reply.code(201).send(svc.recordCost(requireUser(req), parse(costSchema, req.body))));
  app.get<{ Params: { id: string } }>('/v1/recouvrement/dossiers/:id/rendement', async (req) => {
    authorize(requireUser(req), 'recouvrement:yield.read');
    return svc.caseYield(req.params.id);
  });
  // Rendement d'une campagne par identifiant (obligations ciblées et date de lancement fournies par le module des campagnes).
  app.get<{ Params: { id: string } }>('/v1/recouvrement/campagnes/:id/rendement', async (req) => {
    authorize(requireUser(req), 'recouvrement:yield.read');
    const q = parse(campaignQuery, req.query);
    const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
    return svc.campaignYield(req.params.id, { obligationIds: list(q.obligationIds), since: `${q.since}T00:00:00.000Z`, ...(q.controlObligationIds ? { controlObligationIds: list(q.controlObligationIds) } : {}) });
  });
  app.post('/v1/recouvrement/garanties', async (req, reply) => reply.code(201).send(svc.proposeGuarantee(requireUser(req), parse(guaranteeSchema, req.body))));
  app.post<{ Params: { id: string } }>('/v1/recouvrement/garanties/:id/decision', async (req) => svc.decideGuarantee(requireUser(req), req.params.id, parse(guaranteeDecision, req.body)));
  app.post<{ Params: { id: string } }>('/v1/recouvrement/garanties/:id/mainlevee', async (req) => svc.releaseGuarantee(requireUser(req), req.params.id, parse(z.object({ motivation: motive }).strict(), req.body).motivation));
}
