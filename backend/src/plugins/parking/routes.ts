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
      photoSha256: z.array(z.string().regex(sha256Hex64, 'empreinte SHA-256 hexadécimale attendue')).min(1).max(6),
      lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), gpsAccuracyM: z.number().min(0).max(10_000).optional(),
      deviceId: z.string().max(64).optional(), observations: z.string().trim().min(3).max(2000),
    }).strict(), req.body);
    return reply.code(201).send(svc.recordViolation(requireUser(req), body));
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
