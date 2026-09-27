/**
 * Module d'extension « Intégrité — renseignement anti-fraude » (spécification fonctionnelle, module 40) : signaux
 * complémentaires, scores explicables, suspension conservatoire d'un accès technique, transmission à l'autorité
 * compétente, déperdition évitée, indicateurs. Construit après le module « integrite » (mêmes alertes et dossiers).
 */
import { moneySchema, parse } from '../../../core/http.js';
import { requireUser } from '../../../core/auth.js';
import { unprocessable } from '../../../core/errors.js';
import { authorize } from '../../../core/policy.js';
import { z } from 'zod';
import { definePlugin } from '../../types.js';
import type { IntegriteService } from '../service.js';
import { EnquetesService, SCORE_WEIGHTS } from './service.js';

const reason = z.string().trim().min(5).max(2000);

export const integriteEnquetesPlugin = definePlugin<EnquetesService>({
  name: 'integrite-enquetes',
  create: (ctx) => {
    const integ = ctx.ext['integrite'] as IntegriteService | undefined;
    if (!integ) throw unprocessable('INTEGRITE_MODULE_REQUIRED', 'Le module « integrite » doit être chargé avant « integrite-enquetes ».');
    return new EnquetesService(ctx, integ);
  },
  routes: (app, _ctx, svc) => {
    type P = { Params: { id: string } };
    app.addHook('onReady', async () => svc.sweep());
    app.get('/v1/integrite/scores', async (req) => ({ items: svc.scores(requireUser(req)), weights: SCORE_WEIGHTS }));
    app.get<P>('/v1/integrite/alerts/:id/score', async (req) => svc.alertScore(requireUser(req), req.params.id));
    app.get('/v1/integrite/suspensions-conservatoires', async (req) => svc.listSuspensions(requireUser(req)));
    app.post<P>('/v1/integrite/cases/:id/suspensions-conservatoires', async (req, reply) => reply.code(201).send(svc.proposeSuspension(requireUser(req), req.params.id, parse(z.object({ userId: z.string().min(1).max(80), days: z.number().int(), reason }).strict(), req.body))));
    app.post<P>('/v1/integrite/suspensions-conservatoires/:id/decision', async (req) => svc.decideSuspension(requireUser(req), req.params.id, parse(z.object({ execute: z.boolean(), reason }).strict(), req.body)));
    app.post<P>('/v1/integrite/suspensions-conservatoires/:id/levee', async (req) => svc.liftSuspension(requireUser(req), req.params.id, parse(z.object({ reason }).strict(), req.body).reason));
    app.get('/v1/integrite/transmissions', async (req) => svc.listTransmissions(requireUser(req)));
    app.post<P>('/v1/integrite/cases/:id/transmission', async (req, reply) => reply.code(201).send(svc.transmit(requireUser(req), req.params.id, parse(z.object({ authority: z.string().trim().min(3).max(200) }).strict(), req.body).authority)));
    app.post<P>('/v1/integrite/transmissions/:id/accuse', async (req) => svc.acknowledge(requireUser(req), req.params.id, parse(z.object({ reference: z.string().trim().min(3).max(200) }).strict(), req.body).reference));
    app.get<P>('/v1/integrite/transmissions/:id/verification', async (req) => {
      authorize(requireUser(req), 'integrite:case.read');
      return svc.verifyTransmission(req.params.id);
    });
    app.post<P>('/v1/integrite/cases/:id/deperdition-evitee', async (req, reply) => reply.code(201).send(svc.recordLoss(requireUser(req), req.params.id, parse(z.object({ amount: moneySchema, evidenceSha256: z.string().regex(/^[0-9a-fA-F]{64}$/), motif: reason }).strict(), req.body))));
    app.get('/v1/integrite/renseignement/indicateurs', async (req) => {
      authorize(requireUser(req), 'integrite:indicators.read');
      return svc.indicators();
    });
  },
});

export { EnquetesService } from './service.js';
