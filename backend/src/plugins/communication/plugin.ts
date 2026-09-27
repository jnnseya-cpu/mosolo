/**
 * Module d'extension « communication » (spécification fonctionnelle, module 39) : modèles versionnés par recette et par
 * langue, préférences et consentements, preuves de remise (accusés), canal de secours, avis apposé sur la plaque,
 * indicateurs (délivrance, délai, ouverture). S'appuie sur le service de communication du socle.
 */
import { CHANNELS, type Channel, type LanguageCode } from '@mosolo/shared';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { CommunicationExtService, LEGAL_EVENTS, TEMPLATE_MAX_CHARS } from './service.js';

const LANGS = ['fr', 'ln', 'sw', 'kg', 'lua', 'en'] as const;
const channel = z.enum(CHANNELS as [Channel, ...Channel[]]);
const motif = z.string().trim().min(3).max(1000);

export const communicationPlugin = definePlugin<CommunicationExtService>({
  name: 'communication',
  create: (ctx) => new CommunicationExtService(ctx),
  routes: (app, _ctx, svc) => {
    type P = { Params: { id: string } };
    app.get('/v1/communication/modeles', async (req) => ({ items: svc.listTemplates(requireUser(req)), legalEvents: LEGAL_EVENTS, maxChars: TEMPLATE_MAX_CHARS, languages: LANGS }));
    app.post('/v1/communication/modeles', async (req, reply) => reply.code(201).send(svc.proposeTemplate(requireUser(req), parse(z.object({
      eventCode: z.string().min(3).max(80), revenueCategory: z.string().min(2).max(60).optional(), lang: z.enum(LANGS), text: z.string().trim().min(5).max(2000),
      legalBasis: z.object({ instrumentId: z.string().min(2).max(80), article: z.string().trim().min(1).max(80) }).strict().optional(),
    }).strict(), req.body) as { eventCode: string; revenueCategory?: string; lang: LanguageCode; text: string; legalBasis?: { instrumentId: string; article: string } })));
    app.post<P>('/v1/communication/modeles/:id/decision', async (req) => svc.decideTemplate(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));

    app.get<P>('/v1/communication/preferences/:id', async (req) => svc.preferences(requireUser(req), req.params.id));
    app.put<P>('/v1/communication/preferences/:id', async (req) => svc.setPreferences(requireUser(req), req.params.id, parse(z.object({
      preferredChannel: channel.nullable().optional(), disabledChannels: z.array(channel).max(8).optional(), whatsappConsent: z.boolean().optional(),
      optedOut: z.boolean().optional(), language: z.enum(LANGS).optional(),
    }).strict(), req.body)));

    // Accusés de remise des fournisseurs de canaux (signés HMAC ; convention par fournisseur à raccorder).
    app.post('/v1/communication/accuses', async (req) => {
      const raw = req.rawBody ?? JSON.stringify(req.body);
      const sig = req.headers['x-signature'];
      return svc.providerReceipt(raw, Array.isArray(sig) ? sig[0] : sig, parse(z.object({ deliveryId: z.string().min(3).max(60), status: z.enum(['delivre', 'lu', 'echoue']), at: z.string().datetime({ offset: true }) }).strict(), req.body));
    });
    app.post<P>('/v1/communication/messages/:id/lecture', async (req) => svc.readReceipt(requireUser(req), req.params.id));
    app.get<P>('/v1/communication/envois/:id/preuve', async (req) => svc.proof(requireUser(req), req.params.id));

    app.get<{ Querystring: { status?: string } }>('/v1/communication/avis-plaque', async (req) => svc.listPlateNotices(requireUser(req), req.query));
    app.post('/v1/communication/avis-plaque', async (req, reply) => reply.code(201).send(svc.createPlateNotice(requireUser(req), parse(z.object({ objectId: z.string().min(1).max(80), eventCode: z.string().min(3).max(80), text: z.string().trim().min(5).max(TEMPLATE_MAX_CHARS) }).strict(), req.body))));
    app.post<P>('/v1/communication/avis-plaque/:id/apposition', async (req) => svc.postPlateNotice(requireUser(req), req.params.id, parse(z.object({
      gps: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(1000) }).strict(), photoSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    }).strict(), req.body)));
    app.get<{ Params: { code: string } }>('/v1/public/avis-plaque/:code', async (req) => svc.verifyPlateNotice(req.params.code));

    app.get('/v1/communication/indicateurs', async (req) => {
      authorize(requireUser(req), 'communication:read');
      return svc.indicators();
    });
  },
});

export { CommunicationExtService } from './service.js';
