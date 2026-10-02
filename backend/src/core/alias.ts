/**
 * Routes-alias du catalogue des API (Cahier, chapitre 31) : routes en français qui RELAIENT la requête, en interne,
 * vers la route canonique existante (même gestionnaire, mêmes gardes, même politique d'accès, même audit).
 *
 * Le relais passe par le pipeline Fastify complet (`app.inject`) : les crochets indexés sur l'URL canonique
 * (plafonds de références, rotation des circuits à quatre yeux, TLS mutuel, lecture massive, élévations) s'appliquent
 * donc à l'identique. En-têtes conservés (Authorization, Idempotency-Key, X-Request-Id, cookies, signatures du
 * prestataire ou du terminal), corps brut conservé octet pour octet quand il n'est pas transformé, adresse du client
 * conservée (limitation de débit et anti-énumération par poste).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route canonique relayée par une route-alias du catalogue des API (ex. « POST /v1/registrations »). */
    canonicalRoute?: string;
  }
}

/** La requête vise-t-elle une route-alias ? (la requête relayée porte seule la limitation de débit et les notifications). */
export function isAliasRoute(req: FastifyRequest): boolean {
  const config = req.routeOptions?.config as { canonicalRoute?: string } | undefined;
  return typeof config?.canonicalRoute === 'string';
}

/** En-têtes de requête NON relayés : transport, longueur recalculée, et en-têtes de mandataire (l'adresse est relayée à part). */
const REQUEST_DROP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip',
]);
/** En-têtes de réponse NON recopiés : transport, et en-têtes posés par la réponse extérieure elle-même (CORS, sécurité, heure). */
const RESPONSE_DROP = new Set([
  'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'date', 'vary',
  'x-request-id', 'x-mosolo-server-time', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
]);

export interface ForwardTarget {
  method: 'GET' | 'POST';
  /** Chemin canonique (paramètres déjà encodés). */
  path: string;
  /** Chaîne de requête à ajouter (sans « ? »). Défaut : celle de la requête reçue. */
  query?: string;
  /** Corps : `raw` = corps brut reçu, relayé octet pour octet ; `json` = corps transformé ; absent = aucun corps. */
  body?: { raw: true } | { json: unknown };
}

/** Relaie la requête vers la route canonique et renvoie sa réponse telle quelle (statut, en-têtes utiles, corps). */
export async function forwardToCanonical(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, target: ForwardTarget): Promise<FastifyReply> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || REQUEST_DROP.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  // Même identifiant de corrélation : les enregistrements d'audit de la route canonique rejoignent la requête reçue.
  if (req.correlationId) headers['x-request-id'] = req.correlationId;
  let payload: string | undefined;
  if (target.body && 'raw' in target.body) {
    payload = req.rawBody;
  } else if (target.body && 'json' in target.body) {
    payload = JSON.stringify(target.body.json);
    headers['content-type'] = 'application/json';
  }
  if (payload === undefined) delete headers['content-type'];
  const originalQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  const query = target.query ?? originalQuery;
  const res = await app.inject({
    method: target.method,
    url: query ? `${target.path}?${query}` : target.path,
    headers,
    remoteAddress: req.ip,
    ...(payload !== undefined ? { payload } : {}),
  });
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || RESPONSE_DROP.has(k.toLowerCase())) continue;
    void reply.header(k, v);
  }
  void reply.header('x-mosolo-route-canonique', `${target.method} ${target.path}`);
  return reply.code(res.statusCode).send(res.rawPayload);
}
