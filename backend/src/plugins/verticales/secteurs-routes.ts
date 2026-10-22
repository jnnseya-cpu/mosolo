/** Routes des modules sectoriels « acte requis » (préfixe /v1/verticales/secteurs) et du domaine public. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { DECLARATION_KINDS, OBSERVATION_SOURCES, type DeclarationKind } from './secteurs.js';
import type { VerticalesService } from './service.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const reason = z.string().trim().min(5).max(2000);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'période AAAA-MM attendue');
const qty = z.record(z.string().max(20)).default({});
const kinds = Object.keys(DECLARATION_KINDS) as [DeclarationKind, ...DeclarationKind[]];
const gps = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).optional() }).strict();

export function registerSecteursRoutes(app: FastifyInstance, svc: VerticalesService): void {
  const s = svc.secteurs;
  // Catalogue public des modules sectoriels (statut ACTE_REQUIS, types de titres, sources de données).
  app.get('/v1/verticales/secteurs', async () => ({
    items: s.catalogue(),
    notice: 'Modules sous ACTE_REQUIS : déclarations, relevés et rapprochements sont enregistrés ; aucune obligation ni aucun montant avant l’acte.',
  }));
  app.get<{ Params: { module: string } }>('/v1/verticales/secteurs/modules/:module', async (req) => s.moduleDetail(requireUser(req), req.params.module));

  // Déclarations du redevable (volumes mensuels, sorties de carrière, produits non ligneux).
  app.post('/v1/verticales/secteurs/declarations', async (req, reply) => {
    const body = parse(z.object({ kind: z.enum(kinds), taxpayerId: z.string().max(64).optional(), objectId: z.string().max(64).optional(), period, lines: qty, documents: z.array(sha256).max(20).default([]) }).strict(), req.body);
    return reply.code(201).send(s.declare(requireUser(req), body));
  });
  app.get<{ Querystring: { module?: string; status?: string } }>('/v1/verticales/secteurs/declarations', async (req) => ({ items: s.listDeclarations(requireUser(req), req.query) }));
  app.get<{ Params: { id: string } }>('/v1/verticales/secteurs/declarations/:id', async (req) => s.readDeclaration(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/verticales/secteurs/declarations/:id/observations', async (req) => {
    const body = parse(z.object({ text: reason, documents: z.array(sha256).max(20).default([]) }).strict(), req.body);
    return s.contest(requireUser(req), req.params.id, body);
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/secteurs/declarations/:id/rapprochement', async (req) => s.reconcile(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/verticales/secteurs/declarations/:id/decision', async (req) => {
    const body = parse(z.object({ decision: z.enum(['VALIDER', 'OUVRIR_CONTRADICTOIRE']), motif: reason }).strict(), req.body);
    return s.decide(requireUser(req), req.params.id, body);
  });

  // Relevés de terrain (sorties de camions, passages au péage, points de contrôle, quais) et données tierces sous protocole.
  app.post<{ Params: { module: string } }>('/v1/verticales/secteurs/:module/releves', async (req, reply) => {
    const body = parse(z.object({
      source: z.enum(OBSERVATION_SOURCES), referenceId: z.string().max(64).optional(), objectId: z.string().max(64).optional(), plate: z.string().trim().min(2).max(20).optional(),
      period: period.optional(), lines: qty, gps: gps.optional(), commune: z.string().max(40).optional(),
    }).strict(), req.body);
    return reply.code(201).send(s.observe(requireUser(req), req.params.module, body));
  });
  app.post('/v1/verticales/secteurs/donnees-tierces', async (req, reply) => {
    const body = parse(z.object({ module: z.string().max(4), source: z.enum(OBSERVATION_SOURCES), taxpayerId: z.string().max(64), period, lines: qty, fileSha256: sha256.optional() }).strict(), req.body);
    return reply.code(201).send(s.thirdPartyData(requireUser(req), body));
  });

  // Grands redevables (module 56).
  app.get('/v1/verticales/secteurs/grands-redevables', async (req) => ({ items: s.listLargeTaxpayers(requireUser(req)) }));
  app.post('/v1/verticales/secteurs/grands-redevables', async (req, reply) => {
    const body = parse(z.object({ taxpayerId: z.string().max(64), sectors: z.array(z.string().max(4)).min(1).max(10), motif: reason }).strict(), req.body);
    return reply.code(201).send(s.designateLargeTaxpayer(requireUser(req), body));
  });
  app.post<{ Params: { taxpayerId: string } }>('/v1/verticales/secteurs/grands-redevables/:taxpayerId/levee', async (req) =>
    s.liftLargeTaxpayer(requireUser(req), req.params.taxpayerId, parse(z.object({ motif: reason }).strict(), req.body).motif));

  // Antennes : liquidation annuelle proposée (module 16).
  app.get<{ Querystring: { exercice?: string } }>('/v1/verticales/secteurs/antennes/liquidation-annuelle', async (req) =>
    s.antennesAnnual(requireUser(req), req.query.exercice ?? String(svc.now().getUTCFullYear())));
  // Avis annuel d'un opérateur : exécuté par une personne habilitée, règle ACTIVE seulement (et automatiquement, ci-dessous).
  app.post('/v1/verticales/secteurs/antennes/liquidation-annuelle', async (req, reply) => {
    const body = parse(z.object({ exercice: z.string().regex(/^\d{4}$/), taxpayerId: z.string().min(1).max(64) }).strict(), req.body);
    return reply.code(201).send(s.antennesExecute(requireUser(req), body.exercice, body.taxpayerId));
  });

  // Avis annuel AUTOMATIQUE sur règle ACTIVE (décision du maître d'ouvrage) : passage manuel du même chemin que le planificateur.
  app.post('/v1/verticales/secteurs/antennes/liquidation-annuelle/automatique', async (req, reply) => reply.code(201).send(s.antennesAuto('MANUELLE', requireUser(req))));

  // Contrôle d'un véhicule par plaque (modules 11, 12, 25) : réponse minimale.
  app.get<{ Params: { plaque: string }; Querystring: Record<string, string> }>('/v1/verticales/vehicules/:plaque/controle', async (req) => {
    const q = parse(z.object({ commune: z.string().min(2).max(40), lat: z.coerce.number().min(-90).max(90).optional(), lon: z.coerce.number().min(-180).max(180).optional() }), req.query);
    return s.vehicleControl(requireUser(req), decodeURIComponent(req.params.plaque), q);
  });

  // Domaine public : plan géoréférencé des emprises (modules 19, 20).
  app.get('/v1/verticales/domaine-public/emprises', async (req) => ({ items: s.domainPlan(requireUser(req)), notice: 'Positions indicatives tant que la visite sur place ne les a pas précisées.' }));
}
