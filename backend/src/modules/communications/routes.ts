import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { badRequest } from '../../core/errors.js';
import { parse, requestLang } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { getEntity } from '../../reference/kinshasa.js';
import { renderEmailPreview } from './templates.js';

const testSchema = z.object({
  eventCode: z.string().min(1),
  entity: z.string().default('DGIPK'),
  lang: z.string().optional(),
}).strict();

function entityOrThrow(code: string) {
  const e = getEntity(code);
  if (!e) throw badRequest('UNKNOWN_ENTITY', `Entité émettrice inconnue : ${code}`);
  return e;
}

export function registerCommunicationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/communications/overview', async (req) => {
    authorize(requireUser(req), 'comms.read');
    return ctx.comms.overview();
  });

  app.get<{ Querystring: { category?: string; mandatory?: string } }>('/v1/communications/events', async (req) => {
    authorize(requireUser(req), 'comms.read');
    const { category, mandatory } = req.query;
    return ctx.comms.catalogue({
      ...(category ? { category } : {}),
      ...(mandatory === 'true' ? { mandatory: true } : mandatory === 'false' ? { mandatory: false } : {}),
    });
  });

  app.get<{ Params: { eventCode: string }; Querystring: { entity?: string; lang?: string } }>('/v1/communications/preview/:eventCode', async (req, reply) => {
    authorize(requireUser(req), 'comms.read');
    const event = ctx.comms.event(req.params.eventCode);
    const entity = entityOrThrow(req.query.entity ?? 'DGIPK');
    const lang = requestLang(req);
    const { subject, html } = renderEmailPreview(event, entity, lang);
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('x-mosolo-subject', encodeURIComponent(subject))
      .header('content-language', lang)
      .send(html);
  });

  app.post('/v1/communications/test', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'comms.test');
    const body = parse(testSchema, req.body);
    const entity = entityOrThrow(body.entity);
    ctx.comms.event(body.eventCode);
    const lang = body.lang && ['fr', 'ln', 'sw', 'kg', 'lua', 'en'].includes(body.lang) ? body.lang : requestLang(req);
    // Envoi de test à soi-même, sur tous ses canaux (§ 11.4.6).
    const deliveries = ctx.comms.publish(
      body.eventCode,
      [{ id: user.id, kind: 'user', name: user.name, lang: lang as never, prefs: {} }],
      { reference: 'TEST' },
      { entity: entity.code },
    );
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'notification.test_sent', resourceType: 'event', resourceId: body.eventCode, details: { entity: entity.code, deliveries: deliveries.length } });
    return reply.code(201).send({ eventCode: body.eventCode, entity: entity.code, sandbox: deliveries.some((d) => d.status === 'journalise'), deliveries });
  });
}
