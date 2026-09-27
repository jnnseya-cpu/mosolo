/**
 * Routes des compléments ParkSmart du chapitre 11A (smart.ts) : grilles tarifaires (registre), occupation et
 * recommandations, sources de recettes, zones premium, données urbaines, plaque, surréservation, reconfigurations,
 * affectation (transparence) et phases de déploiement. Aucune route ne modifie un tarif ni ne décide une mesure.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { DGTK } from './support.js';
import type { ParkingService } from './service.js';
import {
  AFFECTATION_DOMAINS, ENFORCEMENT_MEASURES, GUARANTEES, PREMIUM_CATEGORIES, RECONFIG_KINDS, RECONFIG_STATUSES, TARIFF_MODE_CODES,
} from './smart.js';

const reason = z.string().trim().min(5).max(2000);
const money = z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/), currency: z.enum(['CDF', 'USD']) }).strict();

export function registerParkSmartRoutes(app: FastifyInstance, svc: ParkingService): void {
  const s = svc.smart;

  // Module 75 — tarification dynamique AUTOMATIQUE dans les fourchettes de l'acte (15 à 25 % de places libres) ;
  // hors fourchette ou sans acte : recommandation seulement.
  app.get('/v1/parking/tarification-dynamique', async (req) => svc.tarification.view(requireUser(req)));
  app.post('/v1/parking/tarification-dynamique/run', async (req, reply) => reply.code(201).send(svc.tarification.run(requireUser(req), parse(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), hour: z.number().int().min(0).max(23).optional(),
  }).strict(), req.body ?? {}))));

  // § 11A.2 — Modes tarifaires et grilles (règles du registre ; jamais de montant saisi)
  app.get('/v1/parking/tariff-modes', async (req) => {
    authorize(requireUser(req), 'parking:zone.read');
    return { items: s.tariffModes() };
  });
  app.post('/v1/parking/tariff-grids', async (req, reply) => {
    const body = parse(z.object({
      mode: z.enum(TARIFF_MODE_CODES), ruleCode: z.string().trim().min(2).max(64), zoneIds: z.array(z.string().min(1)).max(200).optional(),
      scope: z.enum(['REEL', 'DEMO']).optional(), titleTypeCode: z.string().max(64).nullable().optional(), note: z.string().max(500).optional(),
    }).strict(), req.body);
    return reply.code(201).send(s.linkGrid(requireUser(req), body));
  });
  app.post('/v1/parking/tariff-simulations', async (req) => s.simulate(requireUser(req), parse(z.object({
    mode: z.enum(TARIFF_MODE_CODES), zoneId: z.string().min(1), durationMinutes: z.number().int().min(15).max(43_200),
    places: z.number().int().min(1).max(500).optional(), at: z.string().datetime({ offset: true }).optional(),
    days: z.number().int().min(1).max(31).optional(), months: z.number().int().min(1).max(12).optional(),
  }).strict(), req.body)));

  // Occupation (cible 15–25 % de places libres), capteurs (maquette), recommandations tarifaires (jamais appliquées)
  app.get<{ Querystring: { date?: string } }>('/v1/parking/occupancy', async (req) => s.occupancy(requireUser(req), req.query.date || undefined));
  app.post<{ Params: { id: string } }>('/v1/parking/zones/:id/sensor-readings', async (req, reply) =>
    reply.code(201).send(s.recordSensor(requireUser(req), req.params.id, parse(z.object({
      sensorId: z.string().trim().min(2).max(64), occupied: z.number().int().min(0), at: z.string().datetime({ offset: true }).optional(),
    }).strict(), req.body))));
  app.get('/v1/parking/pricing-recommendations', async (req) => ({ items: s.listRecommendations(requireUser(req)) }));
  app.post<{ Querystring: { date?: string } }>('/v1/parking/pricing-recommendations/run', async (req) => s.runRecommendations(requireUser(req), req.query.date || undefined));
  app.post<{ Params: { id: string } }>('/v1/parking/pricing-recommendations/:id/decide', async (req) =>
    s.decideRecommendation(requireUser(req), req.params.id, parse(z.object({ outcome: z.enum(['RETENUE_POUR_NOUVELLE_VERSION', 'ECARTEE']), reason }).strict(), req.body)));

  // § 11A.3 — Sources de recettes, zones premium, données urbaines anonymisées
  app.get('/v1/parking/revenue-sources', async (req) => s.revenueSources(requireUser(req)));
  app.post<{ Params: { id: string } }>('/v1/parking/zones/:id/premium', async (req) =>
    s.setPremium(requireUser(req), req.params.id, parse(z.object({ category: z.enum(PREMIUM_CATEGORIES).nullable(), reason }).strict(), req.body)));
  app.get<{ Querystring: { date?: string } }>('/v1/parking/urban-data', async (req) => s.urbanData(requireUser(req), req.query.date || undefined));

  // § 11A.4 / 11A.6 — Plaque : profil explicable et priorités (aucune mesure automatique), transmission au contentieux
  app.get('/v1/parking/plates/priorities', async (req) => s.platePriorities(requireUser(req)));
  app.get<{ Params: { plate: string } }>('/v1/parking/plates/:plate/profile', async (req) => s.plateProfile(requireUser(req), req.params.plate));
  app.post<{ Params: { plate: string } }>('/v1/parking/plates/:plate/referrals', async (req, reply) =>
    reply.code(201).send(s.refer(requireUser(req), req.params.plate, parse(z.object({ measure: z.enum(ENFORCEMENT_MEASURES), grounds: reason }).strict(), req.body))));

  // § 11A.5 — Surréservation contrôlée (désactivée sans validation juridique), indisponibilité et compensation
  app.get('/v1/parking/overbooking', async (req) => {
    authorize(requireUser(req), 'parking:indicators', { entity: DGTK });
    return s.overbookingState();
  });
  app.post('/v1/parking/overbooking/legal-validation', async (req, reply) =>
    reply.code(201).send(s.validateOverbooking(requireUser(req), parse(z.object({ reference: z.string().trim().min(3).max(200), guarantee: z.enum(GUARANTEES), reason }).strict(), req.body))));
  app.post('/v1/parking/overbooking/activation', async (req) =>
    s.setOverbooking(requireUser(req), parse(z.object({ enabled: z.boolean(), ratePct: z.number().int().min(0).max(100).optional(), reason }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/parking/reservations/:id/unavailability', async (req, reply) =>
    reply.code(201).send(s.declareUnavailable(requireUser(req), req.params.id, parse(z.object({ reason }).strict(), req.body).reason)));

  // § 11A.5 — Registre des reconfigurations (épi, baies, livraison, rotation, longue durée en périphérie)
  app.get('/v1/parking/reconfigurations', async (req) => ({ items: s.listReconfigurations(requireUser(req)) }));
  app.post('/v1/parking/reconfigurations', async (req, reply) =>
    reply.code(201).send(s.createReconfiguration(requireUser(req), parse(z.object({
      zoneId: z.string().min(1), kind: z.enum(RECONFIG_KINDS), description: z.string().trim().min(5).max(2000), expectedEffect: z.string().trim().min(3).max(1000),
    }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/parking/reconfigurations/:id/status', async (req) =>
    s.setReconfigurationStatus(requireUser(req), req.params.id, parse(z.object({ status: z.enum(RECONFIG_STATUSES), reason }).strict(), req.body)));

  // § 11A.7 — Affectation : engagements de programmation ; tableau de transparence public
  app.get('/v1/parking/affectation', async () => s.publicAffectation());
  app.get('/v1/parking/affectation/commitments', async (req) => ({ items: s.listCommitments(requireUser(req)) }));
  app.post('/v1/parking/affectation/commitments', async (req, reply) =>
    reply.code(201).send(s.createCommitment(requireUser(req), parse(z.object({
      domain: z.enum(AFFECTATION_DOMAINS), label: z.string().trim().min(5).max(300), legalForm: z.enum(['ENGAGEMENT_DE_PROGRAMMATION', 'ACTE_JURIDIQUE']).optional(),
      actReference: z.string().trim().min(3).max(200).nullable().optional(), period: z.string().trim().min(4).max(40), programmedAmount: money.nullable().optional(),
    }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/parking/affectation/commitments/:id/publish', async (req) => s.publishCommitment(requireUser(req), req.params.id));

  // § 11A.8 — Phases de déploiement conditionnées par l'acte réglementaire
  app.get('/v1/parking/deployment', async (req) => s.deployment(requireUser(req)));
  app.post<{ Params: { n: string } }>('/v1/parking/deployment/phases/:n/zones', async (req) =>
    s.addPhaseZone(requireUser(req), Number(req.params.n), parse(z.object({ zoneId: z.string().min(1) }).strict(), req.body).zoneId));
  app.post<{ Params: { n: string } }>('/v1/parking/deployment/phases/:n/activation', async (req) =>
    s.activatePhase(requireUser(req), Number(req.params.n), parse(z.object({ actReference: z.string().trim().min(3).max(200), reason }).strict(), req.body)));
}
