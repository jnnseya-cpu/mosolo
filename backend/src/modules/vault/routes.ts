import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, requireAcr, ACR } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';

const proposeSchema = z.object({
  alias: z.string().min(1),
  bankName: z.string().trim().min(2).max(120),
  accountNumber: z.string().regex(/^[A-Z0-9 ]{8,40}$/, 'numéro de compte invalide'),
  holderName: z.string().trim().min(2).max(200),
  reason: z.string().trim().min(5).max(500),
  /** Date d'effet future (ISO 8601), au plus tôt à la fin du refroidissement de 72 h (module 60). */
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
}).strict();

const approveSchema = z.object({ outOfBandVerified: z.boolean() }).strict();
const vetoSchema = z.object({ motif: z.string().trim().min(10).max(1000) }).strict();

export function registerVaultRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/beneficiary-accounts', async (req) => {
    authorize(requireUser(req), 'beneficiary.read');
    return ctx.vault.view();
  });

  app.post('/v1/beneficiary-accounts/change-requests', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'beneficiary.propose');
    const body = parse(proposeSchema, req.body);
    return reply.code(201).send(ctx.vault.maskedRequest(ctx.vault.propose(user, body)));
  });

  app.post<{ Params: { id: string } }>('/v1/beneficiary-accounts/change-requests/:id/approve', async (req) => {
    const user = requireUser(req);
    authorize(user, 'beneficiary.approve');
    requireAcr(user, ACR.MFA); // DG-09 : authentification renforcée (levée en mode démonstration)
    const { outOfBandVerified } = parse(approveSchema, req.body);
    return ctx.vault.maskedRequest(ctx.vault.approve(user, req.params.id, outOfBandVerified));
  });

  // Veto pendant le refroidissement de 72 h (ou avant quorum) : R01, R05, R22 ou un R19 autre que le proposant.
  app.post<{ Params: { id: string } }>('/v1/beneficiary-accounts/change-requests/:id/veto', async (req) => {
    const user = requireUser(req);
    authorize(user, 'vault:beneficiary.veto');
    requireAcr(user, ACR.MFA);
    const { motif } = parse(vetoSchema, req.body);
    return ctx.vault.maskedRequest(ctx.vault.veto(user, req.params.id, motif));
  });
}
