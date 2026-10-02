import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { LEASE_PERIODICITIES, OBJECT_CATEGORIES, type CreateObjectInput } from './service.js';

const objectSchema = z.object({
  taxpayerId: z.string().optional(),
  category: z.enum(OBJECT_CATEGORIES),
  commune: z.string(),
  quartier: z.string().trim().min(1).max(120),
  localityRank: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  lat: z.number().min(-5.2).max(-3.9),
  lon: z.number().min(15.0).max(16.6),
  attributes: z.record(z.unknown()).default({}),
  parentObjectId: z.string().optional(),
  avenue: z.string().trim().min(1).max(120).optional(),
}).strict();

const leaseSchema = z.object({
  unitObjectId: z.string(),
  lessorId: z.string().optional(),
  lesseeId: z.string().optional(),
  rent: moneySchema,
  periodicity: z.enum(LEASE_PERIODICITIES),
  start: isoDateString,
  end: isoDateString.optional(),
}).strict();

export function registerObjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/fiscal-objects', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(objectSchema, req.body) as CreateObjectInput;
    return reply.code(201).send(ctx.objects.create(user, body));
  });

  app.post('/v1/leases', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(leaseSchema, req.body);
    return reply.code(201).send(ctx.objects.declareLease(user, body));
  });
}
