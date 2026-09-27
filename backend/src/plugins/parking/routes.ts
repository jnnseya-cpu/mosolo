import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import {
  PARTNER_KINDS, RESERVATION_PURPOSES, VIOLATION_NATURES, ZONE_KINDS, type ParkingService,
} from './service.js';
import { sha256Hex64 } from './support.js';
import { AGENT_COMMISSION_PCT, EVIDENCE_SLOTS } from './field.js';

const lonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const reason = z.string().trim().min(5).max(2000);

const zoneSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9-]{3,32}$/, 'code en majuscules, chiffres et tirets'),
  name: z.string().trim().min(3).max(160),
  commune: z.string().min(2),
  quartier: z.string().trim().min(2).max(120),
  kind: z.enum(ZONE_KINDS),
  geometry: z.object({ type: z.enum(['Polygon', 'LineString']), coordinates: z.array(lonLat).min(2).max(500) }).strict(),
  localityRank: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  capacity: z.object({ standard: z.number().int().min(0).max(100_000), livraison: z.number().int().min(0).max(10_000), pmr: z.number().int().min(0).max(10_000) }).strict(),
  linearMeters: z.number().int().min(1).max(1_000_000).nullable().optional(),
  actReference: z.string().trim().min(3).max(200).nullable().optional(),
  tariffRuleCode: z.string().trim().min(2).max(64).nullable().optional(),
  penaltyRuleCode: z.string().trim().min(2).max(64).nullable().optional(),
  maxDurationMinutes: z.number().int().min(15).max(10_080).nullable().optional(),
  note: z.string().max(500).optional(),
}).strict();

const tariffSchema = z.object({
  tariffRuleCode: z.string().trim().min(2).max(64).nullable(),
  penaltyRuleCode: z.string().trim().min(2).max(64).nullable().optional(),
  actReference: z.string().trim().min(3).max(200).nullable(),
  maxDurationMinutes: z.number().int().min(15).max(10_080).nullable().optional(),
}).strict();

const plate = z.string().trim().min(4).max(20);
const minutes = z.number().int().min(15).max(1440);

export function registerParkingRoutes(app: FastifyInstance, ctx: AppContext, svc: ParkingService): void {
  // Zones
  app.get('/v1/parking/zones', async (req) => {
    authorize(requireUser(req), 'parking:zone.read');
    return { items: svc.listZones(), overbookingEnabled: false };
  });
  app.get<{ Params: { id: string } }>('/v1/parking/zones/:id', async (req) => {
    authorize(requireUser(req), 'parking:zone.read');
    return svc.zoneView(svc.getZone(req.params.id));
  });
  app.post('/v1/parking/zones', async (req, reply) => {
    const user = requireUser(req);
    const zone = svc.createZone(user, parse(zoneSchema, req.body));
    return reply.code(201).send(svc.zoneView(zone));
  });
  app.post<{ Params: { id: string } }>('/v1/parking/zones/:id/tariff', async (req) => svc.setTariff(requireUser(req), req.params.id, parse(tariffSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/parking/zones/:id/suspension', async (req) =>
    svc.setSuspension(requireUser(req), req.params.id, parse(z.object({ suspended: z.boolean(), reason }).strict(), req.body)));

  // Véhicules déclarés
  app.post('/v1/parking/vehicles', async (req, reply) => reply.code(201).send(svc.declareVehicle(requireUser(req), parse(z.object({ plate }).strict(), req.body).plate)));
  app.get('/v1/parking/vehicles/mine', async (req) => ({ items: svc.myVehicles(requireUser(req)) }));

  // Sessions : création financière ⇒ clé d'idempotence obligatoire (rejeu sans double obligation).
  app.post('/v1/parking/sessions', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(z.object({ zoneId: z.string().min(1), plate, durationMinutes: minutes }).strict(), req.body);
    const res = ctx.idempotency.execute(`parking-session:${user.id}`, key, body, () => ({ statusCode: 201, body: svc.startSession(user, body) }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.get('/v1/parking/sessions/mine', async (req) => ({ items: svc.mySessions(requireUser(req)) }));
  app.get<{ Params: { id: string } }>('/v1/parking/sessions/:id', async (req) => svc.readSession(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/parking/sessions/:id/extend', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(z.object({ durationMinutes: minutes }).strict(), req.body);
    const res = ctx.idempotency.execute(`parking-extend:${user.id}`, key, { id: req.params.id, ...body }, () => ({ statusCode: 201, body: svc.extendSession(user, req.params.id, body.durationMinutes) }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });
  app.post<{ Params: { id: string } }>('/v1/parking/sessions/:id/end', async (req) => svc.endSession(requireUser(req), req.params.id));
  app.post('/v1/parking/reminders/run', async (req) => svc.runReminders(requireUser(req)));

  // Contrôle par plaque (résultat minimal)
  app.get<{ Params: { plate: string }; Querystring: { zoneId?: string } }>('/v1/parking/control/:plate', async (req) =>
    svc.control(requireUser(req), req.params.plate, req.query.zoneId || undefined));

  // Constats (RW1)
  app.post('/v1/parking/violations', async (req, reply) => {
    const body = parse(z.object({
      zoneId: z.string().min(1), plate, nature: z.enum(VIOLATION_NATURES), checkId: z.string().optional(),
      photoSha256: z.array(z.string().regex(sha256Hex64, 'empreinte SHA-256 hexadécimale attendue')).min(1).max(6).optional(),
      photoIds: z.array(z.string().min(1).max(40)).min(1).max(5).optional(), place: z.string().trim().min(3).max(200).optional(),
      lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), gpsAccuracyM: z.number().min(0).max(10_000).optional(),
      deviceId: z.string().max(64).optional(), observations: z.string().trim().min(3).max(2000),
    }).strict().refine((b) => (b.photoSha256?.length ?? 0) > 0 || (b.photoIds?.length ?? 0) > 0, 'Au moins une photographie (photoIds ou photoSha256).'), req.body);
    return reply.code(201).send(svc.recordViolation(requireUser(req), body));
  });

  // Caméra de preuve : photo horodatée et géolocalisée (JPEG en base64, empreinte SHA-256 vérifiée), 5 par contrôle rouge.
  app.post('/v1/parking/evidence-photos', { bodyLimit: 1_600_000 }, async (req, reply) => {
    const body = parse(z.object({
      checkId: z.string().min(1).max(40), slot: z.enum(EVIDENCE_SLOTS), imageBase64: z.string().min(100).max(1_300_000),
      sha256: z.string().regex(sha256Hex64, 'empreinte SHA-256 hexadécimale attendue'),
      lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).optional(),
      gpsSource: z.enum(['GPS', 'MANUEL', 'ZONE']), place: z.string().trim().min(3).max(200), stampedAt: z.string().datetime({ offset: true }),
    }).strict(), req.body);
    return reply.code(201).send(svc.field.upload(requireUser(req), body));
  });
  app.get<{ Params: { id: string } }>('/v1/parking/evidence-photos/:id', async (req, reply) => {
    const p = svc.field.read(requireUser(req), req.params.id);
    return reply.type(p.mime).header('cache-control', 'private, no-store').header('x-mosolo-sha256', p.sha256).send(p.data);
  });

  // Pénalités d'un usager (agents du module) et commission des agents.
  app.get<{ Querystring: { plate?: string } }>('/v1/parking/penalties', async (req) => {
    const user = requireUser(req);
    authorize(user, 'parking:control', { communes: user.territory ?? [] });
    const plateQ = parse(plate, req.query.plate ?? '');
    const holder = svc.vehicles.findOne((v) => v.plate === svc.plate(plateQ));
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'parking.penalties.viewed', resourceType: 'plate', resourceId: svc.plate(plateQ), details: {} });
    return { items: svc.field.penaltiesFor({ plate: plateQ, taxpayerId: holder?.taxpayerId ?? null }) };
  });
  app.get('/v1/parking/agents/me/earnings', async (req) => {
    const user = requireUser(req);
    authorize(user, 'parking:violation.record', { communes: user.territory ?? [] });
    // Commission de tous les modules si le registre transversal est chargé ; sinon, celle du stationnement seul.
    const all = ctx.ext.sanctions as { commissions: { summary(a: string): unknown } } | undefined;
    return all ? all.commissions.summary(user.id) : svc.field.earningsSummary(user.id);
  });
  app.get('/v1/parking/agents/earnings', async (req) => {
    const user = requireUser(req);
    authorize(user, 'parking:indicators', { entity: 'DGTK' });
    const agents = [...new Set([...svc.checks.all().map((c) => c.agentId), ...svc.violations.all().map((v) => v.agentId)])];
    return { items: agents.map((a) => { const e = svc.field.earningsSummary(a); return { agentId: a, agentName: ctx.users.get(a)?.name ?? a, totals: e.totals, counts: e.counts }; }), ratePct: AGENT_COMMISSION_PCT };
  });
  app.get<{ Querystring: { status?: string } }>('/v1/parking/violations', async (req) => ({ items: svc.listViolations(requireUser(req), req.query.status) }));
  app.get('/v1/parking/violations/mine', async (req) => ({ items: svc.myViolations(requireUser(req)) }));
  app.get<{ Params: { id: string } }>('/v1/parking/violations/:id', async (req) => svc.readViolation(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/parking/violations/:id/verify', async (req) =>
    svc.verifyViolation(requireUser(req), req.params.id, parse(z.object({ confirm: z.boolean(), note: reason }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/parking/violations/:id/decide', async (req) =>
    svc.decideViolation(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['RETENUE', 'CLASSEE']), reason }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/parking/violations/:id/contest', async (req, reply) =>
    reply.code(201).send(svc.contestViolation(requireUser(req), req.params.id, parse(z.object({ grounds: z.string().trim().min(10).max(5000) }).strict(), req.body).grounds)));

  // Réservations de voirie
  app.post('/v1/parking/reservations', async (req, reply) => {
    const body = parse(z.object({
      zoneId: z.string().min(1), purpose: z.enum(RESERVATION_PURPOSES), places: z.number().int().min(1).max(500),
      startAt: z.string().datetime(), endAt: z.string().datetime(), plate: plate.optional(), notes: z.string().max(1000).optional(),
    }).strict(), req.body);
    return reply.code(201).send(svc.requestReservation(requireUser(req), body));
  });
  app.get('/v1/parking/reservations/mine', async (req) => ({ items: svc.myReservations(requireUser(req)) }));
  app.get('/v1/parking/reservations', async (req) => ({ items: svc.listReservations(requireUser(req)) }));
  app.post<{ Params: { id: string } }>('/v1/parking/reservations/:id/decide', async (req) =>
    svc.decideReservation(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), reason }).strict(), req.body)));

  // Parkings privés et marchands partenaires
  app.get('/v1/parking/partners', async (req) => {
    authorize(requireUser(req), 'parking:zone.read');
    return { items: svc.listPartners() };
  });
  app.get('/v1/parking/partners/mine', async (req) => ({ items: svc.myPartners(requireUser(req)) }));
  app.post('/v1/parking/partners', async (req, reply) => {
    const body = parse(z.object({
      name: z.string().trim().min(3).max(160), kind: z.enum(PARTNER_KINDS), commune: z.string().min(2), quartier: z.string().trim().min(2).max(120),
      lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), capacity: z.number().int().min(1).max(10_000), operatorTaxpayerId: z.string().optional(),
    }).strict(), req.body);
    return reply.code(201).send(svc.createPartner(requireUser(req), body));
  });
  app.post<{ Params: { id: string } }>('/v1/parking/partners/:id/status', async (req) =>
    svc.setPartnerStatus(requireUser(req), req.params.id, parse(z.object({ status: z.enum(['CONVENTION_EN_COURS', 'PARTENAIRE', 'SUSPENDU']), reason }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/parking/partners/:id/occupancy', async (req) =>
    svc.declarePartnerOccupancy(requireUser(req), req.params.id, parse(z.object({ freePlaces: z.number().int().min(0) }).strict(), req.body).freePlaces));

  // Tableau de bord (agrégats)
  app.get('/v1/parking/indicators', async (req) => svc.indicators(requireUser(req)));
}
