/**
 * Routes des compléments de la Partie V (verticales de bout en bout) : patrimoine provincial (inventaire, évaluation,
 * appel public ou délibération, ouverture des plis, attribution motivée, revenus domaniaux, résultats publics),
 * environnement (registre des assujettis, simulation d'impact sans effet) et entreprises (détermination des obligations).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { ASSET_NATURES, EVALUATION_METHODS, type ActifsService } from './actifs.js';
import type { EntreprisesService } from './entreprises.js';
import type { EnvironnementService } from './environnement.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const motif = z.string().trim().min(10, 'motif de 10 caractères au moins').max(2000);

export function registerPartie5Routes(app: FastifyInstance, svc: { actifs: ActifsService; environnement: EnvironnementService; entreprises: EntreprisesService }): void {
  const { actifs, environnement, entreprises } = svc;

  // ------------------------------------------------------------------ Patrimoine provincial (MOSOLO Assets)
  app.get('/v1/verticales/actifs', async (req) => actifs.overview(requireUser(req)));
  app.post('/v1/verticales/actifs/inventaire', async (req, reply) => reply.code(201).send(actifs.inventory(requireUser(req), parse(z.object({
    nature: z.enum(ASSET_NATURES), designation: z.string().trim().min(3).max(200), commune: z.string().trim().min(2).max(40), quartier: z.string().trim().min(2).max(80),
    surfaceM2: z.string().regex(/^\d+(\.\d+)?$/).optional(), titleReference: z.string().trim().min(3).max(120),
    lat: z.number().min(-90).max(90).optional(), lon: z.number().min(-180).max(180).optional(),
  }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/verticales/actifs/inventaire/:id/evaluations', async (req, reply) => reply.code(201).send(actifs.evaluate(requireUser(req), req.params.id, parse(z.object({
    method: z.enum(EVALUATION_METHODS), marketValue: moneySchema, annualRevenueEstimate: moneySchema, reportSha256: sha256, note: z.string().trim().min(5).max(2000),
  }).strict(), req.body))));
  app.post('/v1/verticales/actifs/appels', async (req, reply) => reply.code(201).send(actifs.publishCall(requireUser(req), parse(z.object({
    assetId: z.string().min(3).max(40), procedure: z.enum(['APPEL_PUBLIC', 'DELIBERATION']), deliberationRef: z.string().trim().min(3).max(200).optional(),
    objet: z.string().trim().min(5).max(500), deadline: z.string().datetime({ offset: true }),
  }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/verticales/actifs/appels/:id/ouverture', async (req) => actifs.openOffers(requireUser(req), req.params.id, parse(z.object({
    offers: z.array(z.object({ caseId: z.string().min(3).max(60), amount: moneySchema }).strict()).max(200),
  }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/verticales/actifs/appels/:id/attribution', async (req) => actifs.award(requireUser(req), req.params.id, parse(z.object({ caseId: z.string().min(3).max(60), motif }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/verticales/actifs/appels/:id/infructueux', async (req) => actifs.declareUnsuccessful(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
  app.get('/v1/verticales/actifs/revenus', async (req) => actifs.revenues(requireUser(req)));
  app.get('/v1/public/verticales/actifs/appels', async () => ({ items: actifs.publicCalls(), notice: 'Résultats et motifs publiés ; offres scellées jusqu’à l’ouverture ; recours ouvert à tout candidat.' }));

  // ------------------------------------------------------------------ Environnement (MOSOLO Environment)
  app.get('/v1/verticales/environnement/registre', async (req) => environnement.registry(requireUser(req)));
  app.post('/v1/verticales/environnement/simulations', async (req, reply) => reply.code(201).send(environnement.simulate(requireUser(req), parse(z.object({
    label: z.string().trim().min(3).max(200), valuePerTonne: moneySchema, source: z.string().trim().min(3).max(300), date: isoDateString,
  }).strict(), req.body))));

  // ------------------------------------------------------------------ Entreprises (MOSOLO Business)
  app.get<{ Params: { objectId: string } }>('/v1/verticales/entreprises/etablissements/:objectId/obligations', async (req) => entreprises.obligationsFor(requireUser(req), req.params.objectId));
}
