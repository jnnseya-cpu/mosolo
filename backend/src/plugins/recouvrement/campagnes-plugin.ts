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
import { CAMPAIGN_CHANNELS, CAMPAIGN_SEGMENT_CODES, CAMPAIGN_SEGMENTS, defaultSequence } from './campagnes-relance.js';

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

    // ——— Campagnes de recouvrement (module 33) : segments § 21.2, séquence J-15…J+30, test / témoin, mesure, arrêt ———
    const rel = svc.relances;
    app.get('/v1/campagnes-recouvrement', async (req) => rel.list(requireUser(req)));
    app.get('/v1/campagnes-recouvrement/referentiel', async (req) => {
      authorize(requireUser(req), 'campagnes:read');
      return { segments: CAMPAIGN_SEGMENTS, channels: CAMPAIGN_CHANNELS, sequence: defaultSequence(), note: 'Séquence du Cahier (§ 21) ; décalages de conception PAR DÉFAUT, à confirmer. Aucune action coercitive admise.' };
    });
    app.get('/v1/campagnes-recouvrement/indicateurs', async (req) => {
      authorize(requireUser(req), 'campagnes:read');
      return rel.indicators();
    });
    app.get('/v1/campagnes-recouvrement/visites-a-faire', async (req) => rel.visitsToDo(requireUser(req)));
    app.get<P>('/v1/campagnes-recouvrement/:id', async (req) => {
      authorize(requireUser(req), 'campagnes:read');
      const c = rel.get(req.params.id);
      return { ...c, summary: rel.summary(c) };
    });
    app.post('/v1/campagnes-recouvrement', async (req, reply) => {
      const b = parse(z.object({
        code: z.string().regex(/^[A-Z0-9-]{4,60}$/), label: z.string().trim().min(5).max(200), entity: z.string().min(2).max(40),
        communes: z.array(z.string()).min(1).max(24), segments: z.array(z.enum(CAMPAIGN_SEGMENT_CODES as [string, ...string[]])).min(1).max(7),
        channels: z.array(z.enum(CAMPAIGN_CHANNELS)).min(1).max(3),
        testSharePct: z.number().int().min(1).max(99), controlSharePct: z.number().int().min(1).max(99),
        sequence: z.array(z.object({
          code: z.enum(['J-15', 'J-3', 'J+1', 'J+15', 'J+30']), offsetDays: z.number().int().min(-120).max(180), action: z.string().min(3).max(60),
          channels: z.array(z.enum(CAMPAIGN_CHANNELS)).max(3), segments: z.array(z.enum(CAMPAIGN_SEGMENT_CODES as [string, ...string[]])).max(7).optional(),
        }).strict()).max(5).optional(),
      }).strict(), req.body);
      return reply.code(201).send(rel.create(requireUser(req), b as Parameters<typeof rel.create>[1]));
    });
    app.post<P>('/v1/campagnes-recouvrement/:id/simulation', async (req) => rel.simulate(requireUser(req), req.params.id));
    app.post<P>('/v1/campagnes-recouvrement/:id/lancement', async (req) => rel.proposeLaunch(requireUser(req), req.params.id));
    app.post<P>('/v1/campagnes-recouvrement/:id/lancement/decision', async (req) => rel.decideLaunch(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), reason }).strict(), req.body)));
    app.post<P>('/v1/campagnes-recouvrement/:id/execution', async (req) => rel.runSteps(requireUser(req), req.params.id));
    app.post<{ Params: { id: string; visitId: string } }>('/v1/campagnes-recouvrement/:id/visites/:visitId', async (req) => rel.recordVisit(requireUser(req), req.params.id, req.params.visitId, parse(z.object({
      outcome: z.enum(['RENCONTRE_INFORME', 'ABSENT', 'ADRESSE_INTROUVABLE', 'ORIENTE_ASSISTANCE']), note: z.string().trim().min(3).max(1000),
      gps: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000) }).strict().optional(),
    }).strict(), req.body)));
    app.post<P>('/v1/campagnes-recouvrement/:id/mesure', async (req) => rel.measure(requireUser(req), req.params.id));
    app.post<P>('/v1/campagnes-recouvrement/:id/arret/decision', async (req) => rel.decideStop(requireUser(req), req.params.id, parse(z.object({ stop: z.boolean(), reason }).strict(), req.body)));
    app.post<P>('/v1/campagnes-recouvrement/:id/arret', async (req) => rel.stopNow(requireUser(req), req.params.id, parse(z.object({ reason }).strict(), req.body).reason));
    app.post<P>('/v1/campagnes-recouvrement/:id/generalisation', async (req) => rel.proposeGeneralisation(requireUser(req), req.params.id, parse(z.object({ reason }).strict(), req.body).reason));
    app.post<P>('/v1/campagnes-recouvrement/:id/generalisation/decision', async (req) => rel.decideGeneralisation(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), reason }).strict(), req.body)));

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
