import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../core/errors.js';

/** Clé de client pour la limitation de débit : adresse réseau vue par le serveur (jamais conservée en clair). */
function clientKey(req: FastifyRequest): string {
  return req.ip || 'inconnu';
}

export function registerReceiptRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Liste de révocation signée pour la vérification hors ligne (§ 19.3) : codes et statuts seulement.
  app.get('/v1/public/receipts/revocations', async () => ({ ...ctx.receipts.revocationList(), publicKeyPem: ctx.receipts.publicKeyPem() }));

  // Vérification publique : aucune authentification, résultat minimal, débit limité par client (anti-énumération).
  app.get<{ Params: { code: string }; Querystring: { duplicata?: string } }>('/v1/public/receipts/:code', async (req, reply) => {
    const gate = ctx.receipts.admit(clientKey(req));
    if (!gate.allowed) {
      void reply.header('retry-after', String(gate.retryAfter ?? 60));
      throw new ApiError(429, 'VERIFICATION_RATE_LIMITED',
        gate.reason === 'ECHECS'
          ? 'Trop de codes inconnus depuis ce poste : vérifications suspendues temporairement (protection contre l’énumération).'
          : 'Trop de vérifications depuis ce poste : réessayez dans un instant.',
        { retryAfter: gate.retryAfter });
    }
    const dup = req.query.duplicata !== undefined ? Number.parseInt(req.query.duplicata, 10) : undefined;
    return ctx.receipts.publicVerify(req.params.code, { clientKey: clientKey(req), ...(dup !== undefined && Number.isFinite(dup) ? { duplicateNo: dup } : {}) });
  });
}
