/** Routes des compléments CALCU (§ 27A.4, § 27A.5) : fournisseurs, lignes budgétaires, justificatifs géolocalisés, PDF, organe de contrôle. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { isCommune } from '../../reference/kinshasa.js';
import { DOCUMENT_TYPES } from './calcu.js';
import type { CalcuControlService } from './calcu-controle.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const motif = z.string().trim().min(10, 'motif de 10 caractères au moins').max(2000);
const document = z.object({
  accountId: z.string(), operationRef: z.string().trim().min(2).max(64), type: z.enum(DOCUMENT_TYPES), supplier: z.string().trim().min(2).max(160),
  amount: moneySchema, date: isoDateString, sha256,
  geo: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000), capturedAt: z.string().datetime({ offset: true }) }).strict().optional(),
  commune: z.string().trim().refine(isCommune, 'commune de Kinshasa attendue').optional(),
  budgetLineId: z.string().min(3).max(60).optional(), supplierId: z.string().min(3).max(60).optional(),
}).strict();

export function registerCalcuControlRoutes(app: FastifyInstance, svc: CalcuControlService): void {
  app.get('/v1/verticales/calcu/organe', async (req) => svc.dashboard(requireUser(req)));
  app.post('/v1/verticales/calcu/fournisseurs', async (req, reply) => reply.code(201).send(svc.declareSupplier(requireUser(req), parse(z.object({ name: z.string().trim().min(2).max(160), nif: z.string().trim().min(3).max(60), rccm: z.string().trim().min(3).max(60).optional() }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/fournisseurs/:id/validation', async (req) => svc.validateSupplier(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/fournisseurs/:id/radiation', async (req) => svc.strikeSupplier(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
  app.post('/v1/verticales/calcu/lignes-budgetaires', async (req, reply) => reply.code(201).send(svc.declareBudgetLine(requireUser(req), parse(z.object({
    entityName: z.string().trim().min(2).max(160), exercice: z.number().int().min(2000).max(2100), code: z.string().trim().min(2).max(40), label: z.string().trim().min(3).max(200),
    allotted: moneySchema, actRef: z.string().trim().min(3).max(200),
  }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/lignes-budgetaires/:id/validation', async (req) => svc.validateBudgetLine(requireUser(req), req.params.id));
  app.post('/v1/verticales/calcu/justificatifs', async (req, reply) => reply.code(201).send(svc.registerDocument(requireUser(req), parse(document, req.body))));
  app.get<{ Params: { id: string } }>('/v1/verticales/calcu/reports/:id/pdf', async (req, reply) => {
    const pdf = svc.reportPdf(requireUser(req), req.params.id);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${pdf.fileName}"`)
      .header('x-mosolo-cachet', `Ed25519 keyId=${pdf.keyId} sha256=${pdf.sha256}`).send(pdf.bytes);
  });
  app.post('/v1/verticales/calcu/missions', async (req, reply) => reply.code(201).send(svc.openMission(requireUser(req), parse(z.object({
    reportId: z.string().min(3).max(60).optional(), entityName: z.string().trim().min(2).max(160), objet: z.string().trim().min(5).max(500), scope: z.string().trim().min(5).max(2000),
  }).strict(), req.body))));
  app.get<{ Params: { id: string } }>('/v1/verticales/calcu/missions/:id/preuves', async (req) => svc.missionEvidence(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/missions/:id/cloture', async (req) => svc.closeMission(requireUser(req), req.params.id, parse(z.object({ conclusions: motif }).strict(), req.body).conclusions));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/reports/:id/transmission-justice', async (req, reply) => reply.code(201).send(svc.proposeReferral(requireUser(req), req.params.id, parse(z.object({
    motif, authority: z.string().trim().min(3).max(200), pieces: z.array(sha256).min(1).max(50),
  }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/transmissions/:id/decision', async (req) => svc.decideReferral(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/reports/:id/recuperations', async (req, reply) => reply.code(201).send(svc.recordRecovery(requireUser(req), req.params.id, parse(z.object({ amount: moneySchema, evidenceSha256: sha256, note: z.string().trim().min(5).max(1000) }).strict(), req.body))));
  app.post('/v1/verticales/calcu/recommandations', async (req, reply) => reply.code(201).send(svc.issueRecommendation(requireUser(req), parse(z.object({
    reportId: z.string().min(3).max(60).optional(), entityName: z.string().trim().min(2).max(160), text: z.string().trim().min(10).max(2000), dueDate: isoDateString,
  }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/verticales/calcu/recommandations/:id/suivi', async (req) => svc.followRecommendation(requireUser(req), req.params.id, parse(z.object({ status: z.enum(['EN_COURS', 'EXECUTEE', 'NON_EXECUTEE']), note: z.string().trim().min(5).max(2000) }).strict(), req.body)));
}
