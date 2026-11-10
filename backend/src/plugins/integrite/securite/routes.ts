/** Routes du scellement du journal et de la surveillance transverse (appareils, GPS, DLP, plafonds de références). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../context.js';
import { requireUser } from '../../../core/auth.js';
import { deviceOf, isoDateString, parse } from '../../../core/http.js';
import { authorize } from '../../../core/policy.js';
import type { SecuriteService } from './plugin.js';

const motif = z.string().trim().min(5).max(1000);
const point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), at: z.string().datetime({ offset: true }), action: z.string().max(80).optional() }).strict();

/** Routes de création de références de paiement soumises aux plafonds par canal et par agent (§ 18.4 / H.10). */
const REFERENCE_ROUTES = new Set(['/v1/obligations/:id/payment-orders', '/v1/agents/assist/payment-orders']);

export function registerSecuriteRoutes(app: FastifyInstance, ctx: AppContext, svc: SecuriteService): void {
  const { scellement, surveillance } = svc;

  /* ---------------- Scellement du journal ---------------- */
  app.get('/v1/integrite/scellement', async (req) => scellement.status(requireUser(req)));
  app.post('/v1/integrite/scellement/copie', async (req) => scellement.copy(requireUser(req)));
  app.post('/v1/integrite/scellement/racines', async (req, reply) => {
    const b = parse(z.object({ day: isoDateString.optional() }).strict(), req.body ?? {});
    return reply.code(201).send(scellement.publishRoot(requireUser(req), b.day));
  });
  app.post('/v1/integrite/scellement/controles', async (req, reply) => {
    const u = requireUser(req);
    authorize(u, 'integrite:scellement.run');
    scellement.copy(u);
    return reply.code(201).send(scellement.check(u, 'MANUEL'));
  });

  /* ---------------- Appareils ---------------- */
  app.get('/v1/integrite/appareils', async (req) => surveillance.listDevices(requireUser(req)));
  app.post<{ Params: { id: string } }>('/v1/integrite/appareils/:id/attestation', async (req) => {
    const b = parse(z.object({
      status: z.enum(['NON_ATTESTE', 'CONFORME', 'NON_CONFORME', 'INCONNU']), mdmEnrolled: z.boolean().optional(), rooted: z.boolean().optional(),
      source: z.enum(['MDM', 'ATTESTATION_PLATEFORME', 'DECLARATIF']), note: motif,
    }).strict(), req.body);
    return surveillance.setAttestation(requireUser(req), decodeURIComponent(req.params.id), b);
  });

  /* ---------------- Plausibilité GPS ---------------- */
  app.get('/v1/integrite/gps/anomalies', async (req) => surveillance.listGps(requireUser(req)));
  app.post('/v1/integrite/gps/plausibilite', async (req) => {
    const u = requireUser(req);
    authorize(u, 'integrite:gps.evaluate');
    return surveillance.evaluate(parse(z.object({ points: z.array(point).min(2).max(500) }).strict(), req.body).points);
  });

  /* ---------------- Plafonds de références ---------------- */
  app.get('/v1/integrite/plafonds-references', async (req) => surveillance.ceilings(requireUser(req)));

  // Plafonds bloquants AVANT la création d'une référence (0 = non fixé : aucun blocage).
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'POST' || !req.user || !REFERENCE_ROUTES.has(req.routeOptions.url ?? '')) return;
    const channel = req.body && typeof req.body === 'object' ? (req.body as { channel?: unknown }).channel : undefined;
    surveillance.guardReference(req.user, typeof channel === 'string' ? channel : undefined);
  });

  // Lecture massive (DLP) et registre des empreintes d'appareil : après chaque requête authentifiée réussie.
  app.addHook('onResponse', async (req, reply) => {
    const u = req.user;
    if (!u || reply.statusCode >= 400) return;
    try {
      if (surveillance.isPersonalRead(req.method, req.url)) surveillance.countRead(u.id, u.roles, req.correlationId ?? `${req.id}`, ctx.clock.now().toISOString());
      const device = deviceOf(req);
      if (device.deviceId || device.deviceFingerprint) {
        const socle = ctx.ext.socle as { idp?: { sessions?: { get(id: string): { sharedDevice?: boolean } | undefined } } } | undefined;
        const shared = !!(u.auth?.sessionId && socle?.idp?.sessions?.get(u.auth.sessionId)?.sharedDevice);
        surveillance.observeDevice(u, device, shared);
      }
    } catch { /* la surveillance n'interrompt jamais une réponse */ }
  });
}
