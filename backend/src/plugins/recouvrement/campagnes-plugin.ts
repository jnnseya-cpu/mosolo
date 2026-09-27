/**
 * Module d'extension « campagnes » (§ 8, § 10A.2, § 21.4, § 45) : campagnes de déclaration pré-remplie par entité,
 * calendrier, simulation sur données réelles, lancement à deux personnes, relances, arrêt motivé ; prorogations
 * d'échéance (§ 6.2) enregistrées sur la fiche de règle. Construit après « fiscal » et « recouvrement ».
 */
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { isoDateString, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { CampaignService } from './campaigns.js';

const reason = z.string().trim().min(3).max(1000);

export const campagnesPlugin = definePlugin<CampaignService>({
  name: 'campagnes',
  create: (ctx) => new CampaignService(ctx),
  seed: (ctx, svc) => {
    const planner = ctx.users.get('u-dg-dgipk');
    if (planner) svc.seedFebruary2027(planner);
  },
  routes: (app, _ctx, svc) => {
    type P = { Params: { id: string } };
    app.get('/v1/campagnes', async (req) => {
      authorize(requireUser(req), 'campagnes:read');
      return svc.campaigns.all().reverse();
    });
    app.get('/v1/campagnes/calendrier', async (req) => svc.calendar(requireUser(req)));
    app.get<P>('/v1/campagnes/:id', async (req) => {
      authorize(requireUser(req), 'campagnes:read');
      return svc.get(req.params.id);
    });
    app.post('/v1/campagnes', async (req, reply) => {
      const b = parse(z.object({
        code: z.string().regex(/^[A-Z0-9-]{4,60}$/), label: z.string().trim().min(5).max(200), entity: z.string().min(2).max(40),
        kinds: z.array(z.enum(['IF', 'IRL'])).min(1).max(2), period: z.string().regex(/^\d{4}$/), communes: z.array(z.string()).min(1).max(24),
        dueDate: isoDateString, dueDateStatus: z.enum(['A_VERIFIER', 'CONFIRMEE']).optional(), dueDateSource: z.string().trim().min(3).max(300),
        reminderOffsets: z.array(z.number().int().min(1).max(120)).max(6).optional(), stopCriteria: z.array(z.string().trim().min(3).max(200)).max(10).optional(),
      }).strict(), req.body);
      return reply.code(201).send(svc.create(requireUser(req), b as Parameters<CampaignService['create']>[1]));
    });
    app.post<P>('/v1/campagnes/:id/simulation', async (req) => svc.simulate(requireUser(req), req.params.id));
    app.post<P>('/v1/campagnes/:id/pre-remplissage', async (req) => svc.prepareBatch(requireUser(req), req.params.id));
    app.post<P>('/v1/campagnes/:id/lancement', async (req) => svc.proposeLaunch(requireUser(req), req.params.id));
    app.post<P>('/v1/campagnes/:id/lancement/decision', async (req) => svc.decideLaunch(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), reason }).strict(), req.body)));
    app.post<P>('/v1/campagnes/:id/relances', async (req) => svc.runReminders(requireUser(req), req.params.id));
    app.post<P>('/v1/campagnes/:id/arret', async (req) => svc.stop(requireUser(req), req.params.id, parse(z.object({ reason }).strict(), req.body).reason));

    app.get('/v1/prorogations', async (req) => {
      authorize(requireUser(req), 'campagnes:read');
      return svc.extensions.all().reverse();
    });
    app.post('/v1/prorogations', async (req, reply) => {
      const b = parse(z.object({ ruleCode: z.string().min(2).max(60), appliesFrom: isoDateString, appliesTo: isoDateString, extendedTo: isoDateString, actReference: z.string().trim().min(3).max(200), actDate: isoDateString, reason }).strict(), req.body);
      return reply.code(201).send(svc.proposeExtension(requireUser(req), b));
    });
    app.post<P>('/v1/prorogations/:id/decision', async (req) => svc.decideExtension(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), reason }).strict(), req.body)));
  },
});
