/** Routes des fiches sectorielles 13 à 25 (préfixe /v1/verticales/fiches) et du module 18 (contribution plastique). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { PAYMENT_CHANNELS } from '../../modules/payments/service.js';
import { PLASTIC_ROLES } from './plastique.js';
import type { VerticalesService } from './service.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const reason = z.string().trim().min(5).max(2000);
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'nombre positif attendu');
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const commune = z.string().min(2).max(40);

export function registerFichesRoutes(app: FastifyInstance, vx: VerticalesService): void {
  const f = vx.fiches!;
  const pl = vx.plastique!;

  // Configuration d'une fiche : règle du registre et type de titre, avec la référence de l'acte (régie).
  app.get<{ Params: { module: string } }>('/v1/verticales/fiches/:module/configuration', async (req) => { requireUser(req); return { ...f.config(req.params.module), rule: f.ruleStatus(req.params.module).status }; });
  app.post<{ Params: { module: string } }>('/v1/verticales/fiches/:module/configuration', async (req) => {
    const body = parse(z.object({
      ruleCode: z.string().trim().min(2).max(64).nullable(), credentialTypeCode: z.string().trim().min(2).max(64).nullable().optional(),
      extraCredentialTypeCodes: z.array(z.string().trim().min(2).max(64)).max(10).optional(),
      objectCategories: z.array(z.enum(['PARCELLE', 'BATIMENT', 'UNITE_LOCATIVE', 'ACTIVITE', 'VEHICULE', 'PANNEAU', 'AUTRE'])).max(7).optional(), actReference: z.string().trim().min(2).max(200), motif: reason,
    }).strict(), req.body);
    return f.setConfig(requireUser(req), req.params.module, body);
  });
  app.get('/v1/verticales/fiches/indicateurs', async (req) => f.indicators(requireUser(req)));

  // Registres géoréférencés (points d'embarquement, quais, axes et points de péage, points de contrôle) et objets sectoriels.
  app.post('/v1/verticales/fiches/references', async (req, reply) => {
    const body = parse(z.object({
      module: z.enum(['13', '23', '24', '25']), kind: z.enum(['POINT_EMBARQUEMENT', 'QUAI', 'AXE', 'POINT_PEAGE', 'POINT_CONTROLE']), label: z.string().trim().min(3).max(160),
      commune, lat, lon, operatorTaxpayerId: z.string().max(64).optional(), privateQuay: z.boolean().optional(),
    }).strict(), req.body);
    return reply.code(201).send(f.registerReference(requireUser(req), body));
  });
  app.get<{ Querystring: { module?: string } }>('/v1/verticales/fiches/references', async (req) => {
    requireUser(req);
    return { items: vx.secteurs.references.find((r) => !req.query.module || r.module === req.query.module) };
  });
  app.post<{ Params: { module: string } }>('/v1/verticales/fiches/:module/objets', async (req, reply) => {
    const body = parse(z.object({
      taxpayerId: z.string().max(64).optional(), commune, quartier: z.string().trim().min(2).max(80), lat, lon,
      attributes: z.record(z.string().max(120)), withPlate: z.boolean().optional(),
    }).strict(), req.body);
    return reply.code(201).send(f.registerObject(requireUser(req), { module: req.params.module, ...body }));
  });
  app.get<{ Params: { module: string } }>('/v1/verticales/fiches/:module/objets', async (req) => ({ items: f.listObjects(requireUser(req), req.params.module) }));

  // 13 / 24 — départs, manifestes, titres, mouvements, contrôle des embarcations.
  app.post('/v1/verticales/fiches/departs', async (req, reply) => {
    const body = parse(z.object({
      pointId: z.string().max(64), embarcationId: z.string().max(64).optional(), operatorTaxpayerId: z.string().max(64).optional(), destination: z.string().trim().min(2).max(120),
      scheduledAt: z.string().max(40), titleMode: z.enum(['PAR_PASSAGER', 'PAR_DEPART']),
    }).strict(), req.body);
    return reply.code(201).send(f.declareDeparture(requireUser(req), body));
  });
  app.get<{ Querystring: { embarcationId?: string; status?: string } }>('/v1/verticales/fiches/departs', async (req) => ({ items: f.listDepartures(requireUser(req), req.query) }));
  app.post<{ Params: { id: string } }>('/v1/verticales/fiches/departs/:id/manifeste', async (req) => {
    const body = parse(z.object({ passengers: z.number().int().min(0).max(100_000), volumeT: decimal.optional(), documents: z.array(sha256).max(20).default([]) }).strict(), req.body);
    return f.submitManifest(requireUser(req), req.params.id, body);
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/fiches/departs/:id/titres', async (req, reply) => {
    const body = parse(z.object({ channel: z.enum(PAYMENT_CHANNELS) }).strict(), req.body);
    return reply.code(201).send(f.orderTitles(requireUser(req), req.params.id, body));
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/fiches/departs/:id/mouvements', async (req) => {
    const body = parse(z.object({ kind: z.enum(['DEPART', 'ARRIVEE', 'ANNULE']), arrivalPointId: z.string().max(64).optional(), note: z.string().max(500).optional() }).strict(), req.body);
    return f.recordMovement(requireUser(req), req.params.id, body);
  });
  app.get<{ Params: { id: string } }>('/v1/verticales/fiches/departs/:id/rapprochement', async (req) => f.reconcileDeparture(requireUser(req), req.params.id));
  app.get<{ Params: { ref: string }; Querystring: { commune?: string } }>('/v1/verticales/fiches/embarcations/:ref/controle', async (req) =>
    f.boatControl(requireUser(req), decodeURIComponent(req.params.ref), req.query.commune || undefined));
  app.get<{ Querystring: { period?: string } }>('/v1/verticales/fiches/ports/rapprochement', async (req) =>
    ({ items: f.portReconciliation(requireUser(req), req.query.period ?? vx.now().toISOString().slice(0, 7)) }));

  // Liquidations : proposition (bases tirées des données), décision d'une autre personne, passage automatique idempotent.
  app.post('/v1/verticales/fiches/liquidations', async (req, reply) => {
    const body = parse(z.object({ module: z.enum(['16', '17', '19', '22', '23', '24']), objectId: z.string().max(64), period: z.string().max(7), movementId: z.string().max(64).optional() }).strict(), req.body);
    return reply.code(201).send(f.propose(requireUser(req), body));
  });
  app.get<{ Querystring: { module?: string; status?: string } }>('/v1/verticales/fiches/liquidations', async (req) => ({ items: f.listLiquidations(requireUser(req), req.query) }));
  app.post<{ Params: { id: string } }>('/v1/verticales/fiches/liquidations/:id/decision', async (req) => {
    const body = parse(z.object({ decision: z.enum(['EXECUTER', 'REJETER']), motif: reason }).strict(), req.body);
    return f.decide(requireUser(req), req.params.id, body);
  });
  app.post<{ Querystring: { exercice?: string } }>('/v1/verticales/fiches/liquidations/automatique', async (req) => f.runAutomaticAs(requireUser(req), req.query.exercice || undefined));
  app.get('/v1/verticales/fiches/liquidations/automatique', async (req) => f.automaticStatus(requireUser(req)));

  // 16 — antennes : import des listes, mutations, recouvrement par opérateur.
  app.post('/v1/verticales/fiches/antennes/imports', async (req, reply) => {
    const body = parse(z.object({
      source: z.enum(['OPERATEUR', 'REGULATEUR']), operatorTaxpayerId: z.string().max(64), fileSha256: sha256.optional(),
      sites: z.array(z.object({ reference: z.string().trim().min(2).max(64), commune, quartier: z.string().trim().min(2).max(80), lat, lon, type: z.string().trim().min(2).max(40), emprise_m2: decimal.optional() }).strict()).min(1).max(2000),
    }).strict(), req.body);
    return reply.code(201).send(f.importSites(requireUser(req), body));
  });
  app.get<{ Querystring: { exercice?: string } }>('/v1/verticales/fiches/antennes/recouvrement', async (req) => f.telecomRecovery(requireUser(req), req.query.exercice || undefined));
  app.post<{ Params: { objectId: string } }>('/v1/verticales/fiches/antennes/sites/:objectId/mutations', async (req, reply) => {
    const body = parse(z.object({ toTaxpayerId: z.string().max(64), dateEffet: z.string().max(10), documents: z.array(sha256).max(20).default([]), motif: reason }).strict(), req.body);
    return reply.code(201).send(f.proposeMutation(requireUser(req), req.params.objectId, body));
  });
  app.get('/v1/verticales/fiches/antennes/mutations', async (req) => ({ items: f.listMutations(requireUser(req)) }));
  app.post<{ Params: { id: string } }>('/v1/verticales/fiches/antennes/mutations/:id/decision', async (req) => {
    const body = parse(z.object({ approve: z.boolean(), motif: reason }).strict(), req.body);
    return f.decideMutation(requireUser(req), req.params.id, body);
  });

  // 13 — embarquement : scan du titre à usage unique (consommé au premier scan valide, « DÉJÀ UTILISÉ » ensuite).
  app.post<{ Params: { id: string } }>('/v1/verticales/fiches/departs/:id/embarquements', async (req, reply) => {
    const body = parse(z.object({ qr: z.string().max(2000).optional(), code: z.string().max(40).optional(), lat: lat.optional(), lon: lon.optional(), deviceId: z.string().max(100).optional() }).strict(), req.body);
    return reply.code(201).send(f.boardingScan(requireUser(req), req.params.id, body));
  });
  app.get<{ Params: { id: string } }>('/v1/verticales/fiches/departs/:id/embarquements', async (req) => ({ items: f.listBoardings(requireUser(req), req.params.id) }));

  // 22 — carrières : bons de sortie par camion, point de contrôle de sortie (comptage + bon consommé).
  app.post<{ Params: { objectId: string } }>('/v1/verticales/fiches/carrieres/:objectId/bons', async (req, reply) => {
    const body = parse(z.object({ plates: z.array(z.string().trim().min(2).max(20)).min(1).max(100), channel: z.enum(PAYMENT_CHANNELS) }).strict(), req.body);
    return reply.code(201).send(f.orderExitSlips(requireUser(req), req.params.objectId, body));
  });
  app.post<{ Params: { objectId: string } }>('/v1/verticales/fiches/carrieres/:objectId/sorties', async (req, reply) => {
    const body = parse(z.object({ qr: z.string().max(2000).optional(), code: z.string().max(40).optional(), plate: z.string().trim().min(2).max(20).optional(), volume_m3: decimal.optional(), lat: lat.optional(), lon: lon.optional(), deviceId: z.string().max(100).optional() }).strict(), req.body);
    return reply.code(201).send(f.exitCheckpoint(requireUser(req), req.params.objectId, body));
  });
  app.get<{ Params: { objectId: string } }>('/v1/verticales/fiches/carrieres/:objectId/sorties', async (req) => f.quarryExits(requireUser(req), req.params.objectId));

  // 23 — forêts : déclaration enregistrée au point de contrôle ; lecture réservée aux services compétents.
  app.post('/v1/verticales/fiches/forets/declarations', async (req, reply) => {
    const body = parse(z.object({ pointId: z.string().max(64), produit: z.string().trim().min(2).max(120), quantiteKg: decimal, taxpayerId: z.string().max(64).optional(), declarant: z.string().trim().min(2).max(160), plate: z.string().trim().min(2).max(20).optional() }).strict(), req.body);
    return reply.code(201).send(f.checkpointDeclaration(requireUser(req), body));
  });
  app.get('/v1/verticales/fiches/forets/declarations', async (req) => ({ items: f.listForestDeclarations(requireUser(req)) }));

  // 21 — événements : liquidation sur billetterie déclarée ou contrôlée (décision motivée).
  app.post<{ Params: { objectId: string } }>('/v1/verticales/fiches/evenements/:objectId/liquidation', async (req, reply) => {
    const body = parse(z.object({ basis: z.enum(['DECLAREE', 'CONTROLEE']), motif: reason }).strict(), req.body);
    return reply.code(201).send(f.liquidateEvent(requireUser(req), req.params.objectId, body));
  });

  // 20 — marchés : abonnement du droit d'étal (consentement du titulaire), renouvellement idempotent.
  app.post<{ Params: { stallId: string } }>('/v1/verticales/fiches/marches/etals/:stallId/abonnement', async (req) =>
    f.subscribeStall(requireUser(req), req.params.stallId, parse(z.object({ consent: z.boolean() }).strict(), req.body)));
  app.get('/v1/verticales/fiches/marches/abonnements/mine', async (req) => ({ items: f.mySubscriptions(requireUser(req)) }));

  // Types de titres d'un module (catalogue « acte requis » et types déclarés, dont démonstration [EXEMPLE]).
  app.get<{ Params: { module: string } }>('/v1/verticales/fiches/:module/types-titres', async (req) => {
    requireUser(req);
    return { items: vx.secteurs.credentialTypesOf(req.params.module), available: vx.secteurs.availableCredentialTypes(req.params.module) };
  });

  // 25 — péage : achat d'un titre lié à la plaque.
  app.post('/v1/verticales/fiches/peage/titres', async (req, reply) => {
    const body = parse(z.object({ typeCode: z.string().max(64), plate: z.string().trim().min(2).max(20), pointId: z.string().max(64), channel: z.enum(PAYMENT_CHANNELS), payerTaxpayerId: z.string().max(64).optional() }).strict(), req.body);
    return reply.code(201).send(f.buyToll(requireUser(req), body));
  });

  // 25 — péage : passage consommé, solde d'un carnet.
  app.post('/v1/verticales/fiches/peage/passages', async (req, reply) => {
    const body = parse(z.object({ pointId: z.string().max(64), plate: z.string().trim().min(2).max(20), lat: lat.optional(), lon: lon.optional() }).strict(), req.body);
    return reply.code(201).send(f.passage(requireUser(req), body));
  });
  app.get<{ Params: { plaque: string } }>('/v1/verticales/fiches/peage/carnets/:plaque', async (req) => f.carnet(requireUser(req), decodeURIComponent(req.params.plaque)));

  // 17 — boissons : livraisons (partenaire), carte restreinte, points non autorisés → module 10, cohérence, suivi, relances.
  app.post('/v1/verticales/fiches/boissons/livraisons', async (req, reply) => {
    const body = parse(z.object({
      taxpayerId: z.string().max(64), period: z.string().max(7), fileSha256: sha256.optional(),
      points: z.array(z.object({ label: z.string().trim().min(2).max(160), commune, quartier: z.string().max(80).optional(), lat, lon, volumeLitres: decimal, establishmentRef: z.string().max(64).optional() }).strict()).min(1).max(5000),
    }).strict(), req.body);
    return reply.code(201).send(f.recordDeliveries(requireUser(req), body));
  });
  app.get('/v1/verticales/fiches/boissons/points-livraison', async (req) => ({ items: f.deliveryMap(requireUser(req)) }));
  app.get('/v1/verticales/fiches/boissons/points-non-autorises', async (req) => ({ items: f.unauthorizedPoints(requireUser(req)) }));
  app.post('/v1/verticales/fiches/boissons/transmissions', async (req, reply) => {
    const body = parse(z.object({ pointIds: z.array(z.string().max(64)).min(1).max(500), motif: reason }).strict(), req.body);
    return reply.code(201).send(f.transmitToActivities(requireUser(req), body));
  });
  app.get('/v1/verticales/fiches/boissons/transmissions', async (req) => ({ items: f.listTransmissions(requireUser(req)) }));
  app.get('/v1/verticales/fiches/boissons/coherence', async (req) => ({ items: f.volumeCoherence(requireUser(req)) }));
  app.get('/v1/verticales/fiches/boissons/suivi', async (req) => ({ items: f.beverageFollowUp(requireUser(req)) }));
  app.post<{ Params: { taxpayerId: string } }>('/v1/verticales/fiches/boissons/redevables/:taxpayerId/relances', async (req, reply) => {
    const body = parse(z.object({ kind: z.enum(['DECLARATION', 'PAIEMENT']), motif: reason }).strict(), req.body);
    return reply.code(201).send(f.remind(requireUser(req), req.params.taxpayerId, body));
  });

  // 19 — assainissement : portefeuille, application de la règle, avis unique.
  app.get<{ Querystring: { exercice?: string } }>('/v1/verticales/fiches/assainissement/portefeuille', async (req) => f.portfolio(requireUser(req), req.query.exercice || undefined));
  app.post('/v1/verticales/fiches/assainissement/application', async (req) => {
    const body = parse(z.object({ exercice: z.string().regex(/^\d{4}$/).optional(), motif: reason }).strict(), req.body);
    return f.applyPortfolio(requireUser(req), body);
  });
  app.get<{ Params: { objectId: string }; Querystring: { exercice?: string } }>('/v1/verticales/fiches/objets/:objectId/avis-unique', async (req) =>
    f.groupedNotice(requireUser(req), req.params.objectId, req.query.exercice || undefined));

  // 20, 21 — marchés et événements.
  app.get('/v1/verticales/fiches/marches/rapprochement', async (req) => ({ items: f.marketReconciliation(requireUser(req)) }));
  app.get('/v1/verticales/fiches/evenements/recettes', async (req) => ({ items: f.eventsRevenue(requireUser(req)) }));

  // 18 — contribution plastique (désactivée tant que la règle n'est pas publiée).
  app.get('/v1/verticales/plastique', async (req) => pl.view(requireUser(req)));
  app.post('/v1/verticales/plastique/assujettis', async (req, reply) => {
    const body = parse(z.object({ taxpayerId: z.string().max(64), roles: z.array(z.enum(PLASTIC_ROLES)).min(1).max(3), categories: z.array(z.string().max(40)).max(10).default([]), source: z.string().trim().min(2).max(200), motif: reason }).strict(), req.body);
    return reply.code(201).send(pl.registerLiable(requireUser(req), body));
  });
  app.post('/v1/verticales/plastique/etude', async (req, reply) => {
    const body = parse(z.object({ taxpayerId: z.string().max(64).optional(), period: z.string().max(7), lines: z.record(z.string().max(20)), source: z.string().trim().min(2).max(200), fileSha256: sha256.optional() }).strict(), req.body);
    return reply.code(201).send(pl.addStudyData(requireUser(req), body));
  });
  app.post('/v1/verticales/plastique/simulations', async (req, reply) => {
    const body = parse(z.object({ ruleId: z.string().max(80), scenario: z.string().trim().min(3).max(200), period: z.string().max(7).optional() }).strict(), req.body);
    return reply.code(201).send(pl.simulate(requireUser(req), body));
  });
  app.post('/v1/verticales/plastique/declarations', async (req, reply) => {
    const body = parse(z.object({ taxpayerId: z.string().max(64).optional(), objectId: z.string().max(64), period: z.string().max(7), lines: z.record(z.string().max(20)) }).strict(), req.body);
    return reply.code(201).send(pl.declare(requireUser(req), body));
  });
  app.post<{ Params: { id: string } }>('/v1/verticales/plastique/declarations/:id/reversement', async (req, reply) => reply.code(201).send(pl.liquidate(requireUser(req), req.params.id)));
}
