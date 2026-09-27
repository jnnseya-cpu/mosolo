/**
 * Routes françaises du catalogue des API (Cahier, chapitre 31). Chaque route relaie vers la route canonique déjà
 * construite (voir core/alias.ts) : aucune règle métier n'est dupliquée ici. Seules exceptions, des contrôles
 * SUPPLÉMENTAIRES exigés par le Cahier et absents de la route canonique :
 *  - simulation : « règle publiée uniquement » (la simulation canonique accepte aussi une règle en projet, non opposable) ;
 *  - paramètres passés dans le corps (obligation, mission, contribuable, prestataire) : validés avant d'entrer dans l'URL.
 */
import { isRuleExecutable } from '@mosolo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { forwardToCanonical } from '../../core/alias.js';
import { requireUser } from '../../core/auth.js';
import { badRequest, unprocessable } from '../../core/errors.js';
import { header, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { CATALOGUE_API, CATALOGUE_REFERENCE } from './catalogue.js';

/** Identifiant passé dans le corps puis placé dans le chemin canonique : caractères sûrs uniquement. */
const pathId = z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/, 'identifiant invalide (1 à 128 caractères [A-Za-z0-9._:-])');
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const bodyObject = (req: FastifyRequest): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

/** Retire des clés d'un objet (le reste est le corps de la route canonique, validé strictement par elle). */
function without(body: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!keys.includes(k)) out[k] = v;
  return out;
}

const cfg = (canonicalRoute: string) => ({ config: { canonicalRoute } });

export function registerCatalogueApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Table du catalogue (documentation lisible par machine) : aucune donnée personnelle.
  app.get('/v1/catalogue-api', async () => ({
    reference: CATALOGUE_REFERENCE,
    principe: 'Chaque route française relaie la route canonique existante : mêmes contrôles d’accès, même idempotence, même journal d’audit (même X-Request-Id). Les routes canoniques restent disponibles.',
    routes: CATALOGUE_API,
  }));

  // 1. Créer un compte (public) — vérification du téléphone, anti-doublon, journal.
  app.post('/v1/comptes', cfg('POST /v1/registrations'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/registrations', body: { raw: true } }));

  // 2. Élever le niveau de vérification — circuit des preuves d'identité du module « acces ».
  const verification = z.discriminatedUnion('etape', [
    z.object({ etape: z.literal('ENVOI_CODE'), taxpayerId: pathId }).strict(),
    z.object({ etape: z.literal('VERIFICATION_CODE'), taxpayerId: pathId }).passthrough(),
    z.object({ etape: z.literal('PIECE'), taxpayerId: pathId }).passthrough(),
    z.object({ etape: z.literal('CONTROLE'), proofId: pathId }).passthrough(),
  ]);
  app.post('/v1/identites/verification', cfg('POST /v1/acces/identity/:id/proofs'), async (req, reply) => {
    const raw = bodyObject(req);
    const b = parse(verification, raw);
    switch (b.etape) {
      case 'ENVOI_CODE':
        return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/acces/identity/${encodeURIComponent(b.taxpayerId)}/otp`, query: '' });
      case 'VERIFICATION_CODE':
        return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/acces/identity/${encodeURIComponent(b.taxpayerId)}/otp/verify`, query: '', body: { json: without(raw, 'etape', 'taxpayerId') } });
      case 'PIECE':
        return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/acces/identity/${encodeURIComponent(b.taxpayerId)}/proofs`, query: '', body: { json: without(raw, 'etape', 'taxpayerId') } });
      case 'CONTROLE':
        return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/acces/identity-proofs/${encodeURIComponent(b.proofId)}/review`, query: '', body: { json: without(raw, 'etape', 'proofId') } });
    }
  });

  // 3. Déclarer un objet.
  app.post('/v1/objets', cfg('POST /v1/fiscal-objects'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/fiscal-objects', body: { raw: true } }));

  // 4. Déclarer un bail.
  app.post('/v1/baux', cfg('POST /v1/leases'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/leases', body: { raw: true } }));

  // 5. Obligations applicables à un objet — filtrage par rôle et territoire de la route canonique.
  app.get<{ Params: { id: string } }>('/v1/objets/:id/obligations', cfg('GET /v1/obligations'), async (req, reply) => {
    const id = parse(pathId, req.params.id);
    return forwardToCanonical(app, req, reply, { method: 'GET', path: '/v1/obligations', query: `objectId=${encodeURIComponent(id)}` });
  });

  // 6. Simuler une liquidation — règle publiée (ACTIVE, en vigueur) uniquement ; jamais d'obligation créée.
  app.post('/v1/liquidations/simulation', cfg('POST /v1/assessments/calculate'), async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'assessment.simulate');
    const raw = bodyObject(req);
    const b = parse(z.object({ ruleId: pathId, simulate: z.literal(true).optional() }).passthrough(), raw);
    const rule = ctx.rules.get(b.ruleId);
    const exec = isRuleExecutable(rule, ctx.clock.now());
    if (!exec.ok) {
      ctx.audit.append({
        actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'assessment.simulation.refused', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED',
        details: { reason: 'RULE_NOT_PUBLISHED', status: rule.status, executability: exec.reason },
      });
      throw unprocessable('RULE_NOT_PUBLISHED', `Règle ${rule.code} v${rule.version} non publiée ou hors vigueur (${exec.reason}) : la simulation du catalogue n’utilise que des règles publiées.`, { ruleStatus: rule.status, reason: exec.reason });
    }
    return forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/assessments/calculate', query: '', body: { json: { ...raw, simulate: true } } });
  });

  // 7. Proposer une règle (juriste).
  app.post('/v1/regles', cfg('POST /v1/legal-rules'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/legal-rules', body: { raw: true } }));

  // 8. Publier une règle — visa du circuit à quatre personnes distinctes.
  app.post<{ Params: { id: string } }>('/v1/regles/:id/publication', cfg('POST /v1/legal-rules/:id/approve'), async (req, reply) => {
    const id = parse(pathId, req.params.id);
    return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/legal-rules/${encodeURIComponent(id)}/approve`, body: { raw: true } });
  });

  // 9. Créer un ordre de paiement — obligation dans le corps, Idempotency-Key relayée.
  app.post('/v1/paiements/ordres', cfg('POST /v1/obligations/:id/payment-orders'), async (req, reply) => {
    const raw = bodyObject(req);
    const b = parse(z.object({ obligationId: pathId }).passthrough(), raw);
    return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/obligations/${encodeURIComponent(b.obligationId)}/payment-orders`, query: '', body: { json: without(raw, 'obligationId') } });
  });

  // 10. Confirmation prestataire — corps brut relayé octet pour octet (signature et anti-rejeu vérifiés par la route canonique).
  app.post('/v1/paiements/callback', cfg('POST /v1/providers/:provider/callbacks'), async (req, reply) => {
    const fromBody = bodyObject(req).provider;
    const provider = (header(req, 'x-provider') ?? header(req, 'x-mosolo-provider') ?? (typeof fromBody === 'string' ? fromBody : '')).trim();
    if (!PROVIDER_RE.test(provider)) throw badRequest('PROVIDER_REQUIRED', 'Prestataire attendu dans l’en-tête X-Provider ou le champ « provider » du corps (identifiant du prestataire habilité).');
    return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/providers/${provider}/callbacks`, query: '', body: { raw: true } });
  });

  // 11. Relevé de compte public.
  app.post('/v1/reglements/import', cfg('POST /v1/settlements/statements'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/settlements/statements', body: { raw: true } }));

  // 12. Files d'exception du rapprochement (lecture seule).
  app.get('/v1/rapprochements/exceptions', cfg('GET /v1/reconciliation/exceptions'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'GET', path: '/v1/reconciliation/exceptions' }));

  // 13. Vérifier une quittance (public, divulgation minimale).
  app.get<{ Params: { ref: string } }>('/v1/quittances/:ref/verification', cfg('GET /v1/public/receipts/:code'), async (req, reply) => {
    const ref = parse(pathId, req.params.ref);
    return forwardToCanonical(app, req, reply, { method: 'GET', path: `/v1/public/receipts/${encodeURIComponent(ref)}` });
  });

  // 14. Synchroniser le terrain — lot signé par le terminal, corps brut relayé.
  app.post('/v1/missions/synchronisation', cfg('POST /v1/field-sync/batches'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/field-sync/batches', body: { raw: true } }));

  // 15. Enregistrer un constat — mission dans le corps.
  app.post('/v1/constats', cfg('POST /v1/terrain/missions/:id/findings'), async (req, reply) => {
    const raw = bodyObject(req);
    const b = parse(z.object({ missionId: pathId }).passthrough(), raw);
    return forwardToCanonical(app, req, reply, { method: 'POST', path: `/v1/terrain/missions/${encodeURIComponent(b.missionId)}/findings`, query: '', body: { json: without(raw, 'missionId') } });
  });

  // 16. Introduire une contestation.
  app.post('/v1/recours', cfg('POST /v1/appeals'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/appeals', body: { raw: true } }));

  // 17. Alertes de fraude (lecture seule, aucune action automatique).
  app.get<{ Querystring: Record<string, string> }>('/v1/alertes-fraude', cfg('GET /v1/integrite/alerts'), async (req, reply) => {
    const q = parse(z.object({ source: z.enum(['integrite', 'securite']).default('integrite'), status: z.string().regex(/^[A-Z_]{2,40}$/).optional() }).strict(), req.query);
    if (q.source === 'securite') return forwardToCanonical(app, req, reply, { method: 'GET', path: '/v1/security/alerts', query: '' });
    return forwardToCanonical(app, req, reply, { method: 'GET', path: '/v1/integrite/alerts', query: q.status ? `status=${encodeURIComponent(q.status)}` : '' });
  });

  // 18. GET /v1/tableaux/:profil : déjà construite par le module « pilotage » (listée dans le catalogue).

  // 19. Scénarios de recettes (hypothèses jointes).
  app.get('/v1/previsions', cfg('GET /v1/pilotage/scenarios'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'GET', path: '/v1/pilotage/scenarios' }));

  // 20. Scénarios d'affectation (proposés ; aucune exécution de dépense).
  app.post('/v1/affectations/scenarios', cfg('POST /v1/pilotage/projets/recommandations'), async (req, reply) =>
    forwardToCanonical(app, req, reply, { method: 'POST', path: '/v1/pilotage/projets/recommandations', body: { raw: true } }));
}
