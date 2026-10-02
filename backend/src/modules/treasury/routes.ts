import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, requireAcr, ACR } from '../../core/auth.js';
import { ApiError } from '../../core/errors.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';

const statementSchema = z.object({
  statementId: z.string().min(1).max(100),
  lines: z.array(z.object({
    accountAlias: z.string().min(1),
    amount: moneySchema,
    valueDate: isoDateString,
    paymentReference: z.string().min(1),
    /** Empreinte du donneur d'ordre (fournie par la banque ou le prestataire) : destination d'une éventuelle restitution. */
    counterparty: z.string().trim().min(8).max(128).optional(),
    /** Crédit groupé : fichier de détail du prestataire (référence et montant par paiement) et son empreinte. */
    details: z.array(z.object({ paymentReference: z.string().min(1).max(100), amount: moneySchema }).strict()).min(1).max(5000).optional(),
    detailFileSha256: z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue').optional(),
  }).strict()).min(1).max(5000),
}).strict();

const reversalSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
const validationSchema = z.object({ approve: z.boolean(), motif: z.string().trim().min(5).max(1000) }).strict();

export function registerTreasuryRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Double validation des imports (module 29) : la route PROPOSE l'import (202, aucune écriture) avec son contrôle
  // d'intégrité ; une seconde personne habilitée, distincte, le valide (POST …/:statementId/validation), et seulement
  // alors le relevé est appliqué (appariement, règlement, suspens, quittances définitives). Rejeu d'un relevé déjà
  // appliqué avec le même contenu : 200 et résultat d'origine (idempotent).
  app.post('/v1/settlements/statements', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'tresorerie:releve.proposer');
    const body = parse(statementSchema, req.body);
    const r = ctx.treasury.proposeImport(user, body);
    if (r.replayed) return reply.code(200).send(r.result);
    return reply.code(202).send({
      ...r.pending, lines: r.pending.lines.length,
      notice: r.pending.status === 'INTEGRITE_KO'
        ? 'Intégrité du relevé en échec : aucune validation possible ; rien n’a été écrit.'
        : 'Import proposé : rien n’est écrit tant qu’une seconde personne habilitée ne l’a pas validé.',
    });
  });

  // Imports proposés : contrôle d'intégrité, proposant, décision (Trésor, analyste, audit).
  app.get('/v1/settlements/imports', async (req) => ctx.treasury.listImports(requireUser(req)));

  // Seconde validation : approbation (le relevé est appliqué, 201 et résultat) ou rejet motivé (200).
  app.post<{ Params: { statementId: string } }>('/v1/settlements/statements/:statementId/validation', async (req, reply) => {
    const user = requireUser(req);
    const { pending, result } = ctx.treasury.validateImport(user, req.params.statementId, parse(validationSchema, req.body));
    return result ? reply.code(201).send(result) : reply.code(200).send({ ...pending, lines: pending.lines.length });
  });

  // Relevés importés (Trésor, analyste, audit) : comptes crédités, lignes, lignes encore en exception ouverte.
  app.get('/v1/settlements/statements', async (req) => ctx.treasury.listStatements(requireUser(req)));

  app.get('/v1/reconciliation/exceptions', async (req) => ctx.treasury.listExceptions(requireUser(req)));

  app.get<{ Querystring: { sourceId?: string } }>('/v1/ledger/entries', async (req) => {
    authorize(requireUser(req), 'ledger.read');
    return ctx.ledger.list(req.query.sourceId ? { sourceId: req.query.sourceId } : {});
  });

  app.get('/v1/ledger/balance', async (req) => {
    authorize(requireUser(req), 'ledger.read');
    return ctx.ledger.balance();
  });

  // Correction : uniquement par contre-écriture liée à l'original, décidée à QUATRE YEUX. Cette route ne passe plus
  // l'écriture : elle PROPOSE une opération CONTRE_ECRITURE au circuit de double validation du Trésor (202), qu'une
  // autre personne habilitée valide (POST /v1/tresor/operations/:id/approve). Sans ce circuit : refus.
  app.post<{ Params: { id: string } }>('/v1/ledger/entries/:id/reversals', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'ledger.reverse');
    requireAcr(user, ACR.MFA); // DG-09
    const { reason } = parse(reversalSchema, req.body);
    const tresor = ctx.ext.tresor as { propose(u: typeof user, input: { kind: 'CONTRE_ECRITURE'; ledgerEntryId: string; reason: string }): unknown } | undefined;
    if (!tresor) {
      throw new ApiError(422, 'FOUR_EYES_REQUIRED', 'Contre-écriture impossible sans le circuit de double validation du Trésor (module « tresor »).');
    }
    const operation = tresor.propose(user, { kind: 'CONTRE_ECRITURE', ledgerEntryId: req.params.id, reason });
    return reply.code(202).send({
      operation, notice: 'Contre-écriture proposée : elle ne sera passée qu’après validation par une autre personne habilitée (quatre yeux).',
    });
  });

  // Grand livre en ajout seul : aucune modification ni suppression, quel que soit le rôle.
  for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
    app.route<{ Params: { id: string } }>({
      method,
      url: '/v1/ledger/entries/:id',
      handler: async (req) => {
        ctx.audit.append({
          actor: { kind: req.user ? 'user' : 'public', id: req.user?.id ?? 'anonyme', ...(req.user ? { roles: req.user.roles } : {}) },
          action: 'ledger.tamper.attempt', resourceType: 'ledger_entry', resourceId: req.params.id, outcome: 'DENIED', details: { method },
        });
        throw new ApiError(405, 'LEDGER_APPEND_ONLY', 'Grand livre en ajout seul : aucune écriture ne peut être modifiée ou supprimée ; utiliser une contre-écriture.');
      },
    });
  }
}
