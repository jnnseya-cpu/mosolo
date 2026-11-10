/**
 * Routes complémentaires du Trésor : rapprochement proposé et crédits groupés (§ 20.1), quittance PDF signée
 * (§ 18A.4, § 19), clauses contractuelles des points de paiement agréés (§ 37).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { ApiError } from '../../core/errors.js';
import { currencySchema, isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { verifySealedPdf } from '../../modules/receipts/pdf.js';
import { receiptPdf } from '../../modules/receipts/quittance-pdf.js';
import type { TresorService } from './service.js';

const motif = z.string().trim().min(10, 'motif de 10 caractères au moins').max(1000);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'nombre décimal positif attendu');
const decisionSchema = z.object({ approve: z.boolean(), motif }).strict();
const matchSchema = z.object({ exceptionId: z.string().min(3).max(60), paymentReference: z.string().min(3).max(60), motif }).strict();
const detailSchema = z.object({
  details: z.array(z.object({ paymentReference: z.string().min(1).max(100), amount: moneySchema }).strict()).min(1).max(5000),
  detailFileSha256: sha256,
}).strict();
const contractSchema = z.object({
  reference: z.string().trim().min(3).max(100), sha256, signedOn: isoDateString,
  terms: z.object({
    commission: z.object({ basis: z.enum(['POURCENTAGE', 'FORFAIT_PAR_OPERATION']), value: decimal, currency: currencySchema.optional() }).strict(),
    penalty: z.object({ basis: z.enum(['POURCENTAGE_PAR_JOUR', 'FORFAIT_PAR_JOUR']), value: decimal, currency: currencySchema.optional(), capPct: decimal.optional() }).strict(),
  }).strict(),
}).strict();
const penaltySchema = z.object({ pointId: z.string().min(3).max(60), day: isoDateString, motif }).strict();
const pdfVerifySchema = z.object({ pdfBase64: z.string().min(20).max(1_000_000) }).strict();

export function registerTresorComplementRoutes(app: FastifyInstance, ctx: AppContext, svc: TresorService): void {
  // ── Rapprochement proposé (sous le seuil d'appariement exact) et crédits groupés ──
  app.get('/v1/tresor/appariements', async (req) => svc.matching.board(requireUser(req)));
  app.post('/v1/tresor/appariements/propositions', async (req, reply) => reply.code(201).send(svc.matching.propose(requireUser(req), parse(matchSchema, req.body))));
  app.post<{ Params: { id: string } }>('/v1/tresor/appariements/propositions/:id/decision', async (req) => svc.matching.decide(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/tresor/exceptions/:id/detail-prestataire', async (req) => svc.matching.attachDetail(requireUser(req), req.params.id, parse(detailSchema, req.body)));

  // ── Quittance PDF signée (téléchargement) et vérification publique d'un PDF ──
  app.get<{ Params: { ref: string } }>('/v1/tresor/receipts/:ref/pdf', async (req, reply) => {
    const user = requireUser(req);
    const r = ctx.receipts.require(req.params.ref);
    authorize(user, 'tresor:receipt.read', { taxpayerId: r.taxpayerId });
    const pdf = receiptPdf(r, ctx.receipts, { paymentStatus: ctx.payments.orders.get(r.paymentOrderId)?.status ?? '', generatedAt: ctx.clock.now().toISOString() });
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'receipt.pdf.downloaded', resourceType: 'receipt', resourceId: r.id, details: { number: r.number, sha256: pdf.sha256, keyId: pdf.keyId } });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${pdf.fileName}"`)
      .header('x-mosolo-cachet', `Ed25519 keyId=${pdf.keyId} sha256=${pdf.sha256}`).send(pdf.bytes);
  });
  app.post('/v1/public/receipts/pdf-verification', async (req, reply) => {
    const gate = ctx.receipts.admit(req.ip || 'inconnu');
    if (!gate.allowed) {
      void reply.header('retry-after', String(gate.retryAfter ?? 60));
      throw new ApiError(429, 'VERIFICATION_RATE_LIMITED', 'Trop de vérifications depuis ce poste : réessayez dans un instant.');
    }
    const body = parse(pdfVerifySchema, req.body);
    const r = verifySealedPdf(Buffer.from(body.pdfBase64, 'base64'), ctx.receipts);
    return { ...r, note: 'Le cachet prouve l’intégrité du fichier ; le statut de la quittance fait foi sur la vérification publique par code.' };
  });

  // ── Points de paiement agréés : contrat, commission, pénalités de retard (§ 37) ──
  app.get('/v1/tresor/points', async (req) => svc.pointContracts.board(requireUser(req)));
  app.post<{ Params: { id: string } }>('/v1/tresor/points/:id/contrats', async (req, reply) => reply.code(201).send(svc.pointContracts.proposeContract(requireUser(req), req.params.id, parse(contractSchema, req.body))));
  app.post<{ Params: { id: string } }>('/v1/tresor/points/contrats/:id/decision', async (req) => svc.pointContracts.decideContract(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
  app.get<{ Params: { id: string }; Querystring: { month?: string } }>('/v1/tresor/points/:id/commission', async (req) => {
    const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : ctx.clock.now().toISOString().slice(0, 7);
    return svc.pointContracts.commission(requireUser(req), req.params.id, month);
  });
  app.post('/v1/tresor/points/penalites', async (req, reply) => reply.code(201).send(svc.pointContracts.proposePenalty(requireUser(req), parse(penaltySchema, req.body))));
  app.post<{ Params: { id: string } }>('/v1/tresor/points/penalites/:id/decision', async (req) => svc.pointContracts.decidePenalty(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
}
