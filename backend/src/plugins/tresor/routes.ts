import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { header, isoDateString, parse } from '../../core/http.js';
import type { OperationInput, TresorService } from './service.js';

const motif = z.string().trim().min(10, 'motif de 10 caractères au moins').max(1000);

const assignSchema = z.object({ assignee: z.string().min(1).max(100) }).strict();
const evidenceSchema = z.object({
  label: z.string().trim().min(3).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue').optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();
const resolutionSchema = z.object({
  outcome: z.enum(['RESOLUE', 'CLASSEE']),
  motif,
  action: z.enum(['AUCUNE', 'MISE_EN_SUSPENS', 'RAPPROCHEMENT', 'OPERATION']).default('AUCUNE'),
  operationId: z.string().min(3).max(40).optional(),
}).strict();
const rejectSchema = z.object({ motif }).strict();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
/** Exécution d'un remboursement / d'une restitution : référence du prestataire ou de la banque et empreinte de la pièce. */
const approveSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  refundReference: z.string().trim().min(3).max(100).optional(),
  evidenceSha256: sha256.optional(),
}).strict();
/** Empreinte de l'instrument de destination : doit être celle de l'instrument d'origine (jamais un compte saisi). */
const destination = z.string().trim().min(8).max(128);
const waiverSchema = z.object({ date: isoDateString, motif }).strict();

const REVENUE_CATEGORIES = [
  'IMPOT_PROVINCIAL', 'INTERET_COMMUN', 'PROVINCIAL_SPECIFIQUE', 'RECETTE_ETD', 'RECETTE_CENTRALE', 'PARTAGEE', 'DROIT_ADMINISTRATIF',
  'REDEVANCE_SERVICE', 'PENALITE', 'CONCESSION_DOMANIALE', 'RECETTE_COMMERCIALE', 'ACTE_REQUIS',
] as const;

/** Proposition d'opération : aucune destination de fonds saisissable (remboursement : instrument d'origine uniquement). */
const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ANNULATION_QUITTANCE'), receipt: z.string().min(3).max(60), reason: motif, publicReason: z.string().trim().min(5).max(200).optional() }).strict(),
  z.object({ kind: z.literal('REMPLACEMENT_QUITTANCE'), receipt: z.string().min(3).max(60), reason: motif, publicReason: z.string().trim().min(5).max(200).optional() }).strict(),
  z.object({ kind: z.literal('CONTREPASSATION'), paymentReference: z.string().min(3).max(60), reason: motif, publicReason: z.string().trim().min(5).max(200).optional() }).strict(),
  z.object({ kind: z.literal('REMBOURSEMENT'), paymentReference: z.string().min(3).max(60), destination: destination.optional(), reason: motif, publicReason: z.string().trim().min(5).max(200).optional() }).strict(),
  z.object({ kind: z.literal('CONTRE_ECRITURE'), ledgerEntryId: z.string().min(3).max(40), reason: motif }).strict(),
  z.object({
    kind: z.literal('APUREMENT_SUSPENS'), suspenseId: z.string().min(3).max(40), mode: z.enum(['AFFECTATION', 'RESTITUTION']),
    paymentReference: z.string().min(3).max(60).optional(), destination: destination.optional(), reason: motif,
  }).strict(),
  z.object({
    kind: z.literal('PARAMETRE_NOMENCLATURE'), reason: motif,
    nomenclature: z.object({
      revenueCategory: z.enum(REVENUE_CATEGORIES), code: z.string().trim().min(2).max(40), label: z.string().trim().min(3).max(200),
      officialAct: z.string().trim().min(3).max(200).optional(),
    }).strict(),
  }).strict(),
  // Décaissement de la clé de répartition (§ 37A.4) : répartition arrêtée et flux ; un troisième flux est rejeté.
  z.object({
    kind: z.literal('DECAISSEMENT_REPARTITION'), reason: motif,
    repartition: z.object({ distributionId: z.string().min(3).max(60), flow: z.string().min(3).max(40) }).strict(),
  }).strict(),
  // Récupération auprès d'un sous-traitant (§ 15A.7) : décision de récupération du contrôle qualité terrain.
  z.object({
    kind: z.literal('RECUPERATION_SOUS_TRAITANT'), reason: motif,
    recuperation: z.object({ clawbackId: z.string().min(3).max(60) }).strict(),
  }).strict(),
]);

const closeDaySchema = z.object({ date: isoDateString }).strict();
const closeMonthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'mois AAAA-MM attendu') }).strict();
const exportQuery = z.object({ format: z.enum(['csv', 'json']).default('json'), from: isoDateString.optional(), to: isoDateString.optional() }).strict();

export function registerTresorRoutes(app: FastifyInstance, _ctx: AppContext, svc: TresorService): void {
  const ctx = _ctx;

  app.get('/v1/tresor/overview', async (req) => svc.overview(requireUser(req)));

  // Files d'exception (§ 20) : affectation, prise en charge, justificatif, résolution à quatre yeux.
  app.get<{ Querystring: { queue?: string; status?: string } }>('/v1/tresor/exceptions', async (req) =>
    svc.listExceptions(requireUser(req), { ...(req.query.queue ? { queue: req.query.queue } : {}), ...(req.query.status ? { status: req.query.status } : {}) }));
  app.post<{ Params: { id: string } }>('/v1/tresor/exceptions/:id/assign', async (req) => svc.assign(requireUser(req), req.params.id, parse(assignSchema, req.body).assignee));
  app.post<{ Params: { id: string } }>('/v1/tresor/exceptions/:id/start', async (req) => svc.start(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/tresor/exceptions/:id/evidence', async (req, reply) => reply.code(201).send(svc.addEvidence(requireUser(req), req.params.id, parse(evidenceSchema, req.body))));
  app.post<{ Params: { id: string } }>('/v1/tresor/exceptions/:id/resolution', async (req) => svc.proposeResolution(requireUser(req), req.params.id, parse(resolutionSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/tresor/exceptions/:id/resolution/approve', async (req) => svc.approveResolution(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/tresor/exceptions/:id/resolution/reject', async (req) => svc.rejectResolution(requireUser(req), req.params.id, parse(rejectSchema, req.body).motif));

  // Compte d'attente (suspens).
  app.get('/v1/tresor/suspense', async (req) => svc.listSuspense(requireUser(req)));

  // Opérations financières en double validation.
  app.get<{ Querystring: { status?: string } }>('/v1/tresor/operations', async (req) => svc.listOperations(requireUser(req), req.query.status));
  app.post('/v1/tresor/operations', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(operationSchema, req.body) as OperationInput;
    const key = header(req, 'idempotency-key');
    if (!key) return reply.code(201).send(svc.propose(user, body));
    const res = ctx.idempotency.execute(`tresor-operation:${user.id}`, IdempotencyStore.requireKey(key), body, () => ({ statusCode: 201, body: svc.propose(user, body) }));
    if (res.replayed) void reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.post<{ Params: { id: string } }>('/v1/tresor/operations/:id/approve', async (req) => svc.approve(requireUser(req), req.params.id, parse(approveSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/tresor/operations/:id/reject', async (req) => svc.reject(requireUser(req), req.params.id, parse(rejectSchema, req.body).motif));

  // Nomenclature, imputation (« Comptabilisé »), clôtures, export.
  app.get('/v1/tresor/nomenclature', async (req) => svc.listNomenclature(requireUser(req)));
  app.post('/v1/tresor/imputations/run', async (req) => svc.runImputation(requireUser(req)));
  app.get('/v1/tresor/accounting', async (req) => svc.accountingStatus(requireUser(req)));
  app.get('/v1/tresor/closures', async (req) => svc.listClosures(requireUser(req)));
  app.post('/v1/tresor/closures/daily', async (req, reply) => reply.code(201).send(svc.closeDay(requireUser(req), parse(closeDaySchema, req.body).date)));
  // Dérogation de clôture (exceptions d'argent ouvertes, créances prestataire en retard) : demande motivée, second R17.
  app.post('/v1/tresor/closures/daily/waivers', async (req, reply) => {
    const body = parse(waiverSchema, req.body);
    return reply.code(201).send(svc.requestClosureWaiver(requireUser(req), body.date, body.motif));
  });
  app.post<{ Params: { id: string } }>('/v1/tresor/closures/daily/waivers/:id/approve', async (req) => svc.approveClosureWaiver(requireUser(req), req.params.id));
  // Balance âgée des créances sur prestataires ; contrôle de cohérence grand livre / états métier.
  app.get('/v1/tresor/provider-receivables', async (req) => svc.providerReceivables(requireUser(req)));
  app.get('/v1/tresor/consistency', async (req) => svc.consistency(requireUser(req)));
  app.post('/v1/tresor/closures/monthly', async (req, reply) => reply.code(201).send(svc.closeMonth(requireUser(req), parse(closeMonthSchema, req.body).month)));
  app.get('/v1/tresor/exports', async (req, reply) => {
    const q = parse(exportQuery, req.query);
    const out = svc.exportAccounting(requireUser(req), { format: q.format, ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) });
    void reply.header('x-mosolo-sha256', out.sha256).header('x-mosolo-signature', out.signature);
    if (q.format === 'csv') {
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="mosolo-export-${out.from ?? 'debut'}-${out.to ?? 'fin'}.csv"`)
        .send(out.body);
    }
    const { body: _b, ...json } = out;
    return { ...json, publicKeyPem: svc.publicKeyPem() };
  });

  // Quittances : vue interne, duplicata horodaté, journal agrégé des vérifications publiques.
  app.get<{ Params: { ref: string } }>('/v1/tresor/receipts/:ref', async (req) => svc.receiptView(requireUser(req), req.params.ref));
  app.post<{ Params: { ref: string } }>('/v1/receipts/:ref/duplicates', async (req, reply) => reply.code(201).send(svc.duplicate(requireUser(req), req.params.ref)));
  app.get('/v1/tresor/verification-journal', async (req) => svc.verificationJournal(requireUser(req)));
}
