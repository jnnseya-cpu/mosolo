/**
 * Routes du moteur de titres (convention § H.14 : `/v1/titres`, `/v1/vehicules/{plaque}/titres`).
 * Toute décision d'accès passe par `authorize` ; réponse de contrôle minimale ; aucune route n'émet de titre
 * sans quittance ni ne crée de pénalité.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { header, parse } from '../../core/http.js';
import { authorize, evaluate } from '../../core/policy.js';
import { PAYMENT_CHANNELS } from '../../modules/payments/service.js';
import { placeSchema, type TitresService } from './service.js';
import { statusAt } from './validity.js';
import { withOverdue } from '../sanctions/service.js';

const subjectSchema = z.object({
  plate: z.string().trim().min(2).max(20).optional(),
  objectId: z.string().max(64).optional(),
  label: z.string().trim().max(120).optional(),
}).strict();

const credentialPlaceSchema = z.object({
  commune: z.string().trim().min(2).max(40),
  sourceId: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  basis: z.enum(['LIEU_OBJET', 'ZONE_SERVICE', 'STATION_DEPART']),
  lat: z.number().optional(),
  lon: z.number().optional(),
}).strict();

const controlSchema = z.object({
  qr: z.string().trim().min(4).max(2000).optional(),
  code: z.string().trim().min(4).max(40).optional(),
  plate: z.string().trim().min(2).max(20).optional(),
  place: placeSchema,
  deviceId: z.string().max(100).optional(),
  module: z.string().max(10).optional(),
}).strict().refine((b) => b.qr || b.code || b.plate, { message: 'qr, code ou plate requis' });

const decisionSchema = z.object({
  decision: z.enum(['SUSPENDRE', 'LEVER', 'ANNULER', 'REMPLACER']),
  motif: z.string().trim().min(5).max(2000),
  subject: subjectSchema.optional(),
}).strict();

const extendSchema = z.object({ channel: z.enum(PAYMENT_CHANNELS), durationMinutes: z.number().int().positive().max(60 * 24 * 31).optional() }).strict();
const issueOnReceiptSchema = z.object({
  typeCode: z.string().min(2).max(60), receiptNumber: z.string().min(4).max(64), subject: subjectSchema, place: credentialPlaceSchema,
  holderTaxpayerId: z.string().max(64).optional(),
}).strict();
const constatSchema = z.object({ outcome: z.enum(['CLASSE', 'TRANSMIS']), motif: z.string().trim().min(5).max(2000) }).strict();

export function registerTitresRoutes(app: FastifyInstance, ctx: AppContext, svc: TitresService): void {
  // Catalogue des types (public : transparence des titres, tarifs issus des règles publiées).
  app.get('/v1/titres/types', async () => svc.types.all().map((t) => svc.typeView(t)));

  // Mes titres (titulaire ou payeur).
  app.get('/v1/titres', async (req) => {
    const user = requireUser(req);
    svc.sync();
    const tid = user.taxpayerId;
    if (!tid) throw forbidden('FORBIDDEN', 'Liste réservée aux titulaires (compte contribuable).');
    authorize(user, 'titres:read.own', { taxpayerId: tid });
    return svc.byHolder(tid).map((c) => svc.holderView(c));
  });

  // Mes commandes (références de paiement, statut).
  app.get('/v1/titres/commandes', async (req) => {
    const user = requireUser(req);
    svc.sync();
    const tid = user.taxpayerId;
    if (!tid) throw forbidden('FORBIDDEN', 'Liste réservée aux titulaires (compte contribuable).');
    authorize(user, 'titres:read.own', { taxpayerId: tid });
    return svc.issuances.find((i) => i.payerTaxpayerId === tid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.post<{ Params: { id: string } }>('/v1/titres/commandes/:id/annulation', async (req) => svc.cancelIssuance(requireUser(req), req.params.id));

  // Émission sur quittance existante (guichet R12, point agréé R32).
  app.post('/v1/titres', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(issueOnReceiptSchema, req.body);
    return reply.code(201).send(svc.holderView(svc.issueOnReceipt(user, body)));
  });

  app.get<{ Params: { id: string } }>('/v1/titres/:id', async (req) => {
    const user = requireUser(req);
    svc.sync();
    const c = svc.credential(req.params.id);
    svc.assertCanRead(user, c);
    return svc.holderView(c);
  });

  // Statut minimal : public (aucune donnée personnelle), heure serveur.
  app.get<{ Params: { id: string } }>('/v1/titres/:id/statut', async (req) => {
    svc.sync();
    const c = svc.credential(req.params.id);
    const s = statusAt(c, ctx.clock.now());
    ctx.audit.append({ actor: { kind: 'public', id: 'verification-publique' }, action: 'titres.status.checked', resourceType: 'credential', resourceId: c.id });
    return { number: c.number, module: c.module, validFrom: c.validFrom, validUntil: c.validUntil, ...s };
  });

  // QR dynamique (titulaire) : jeton de la fenêtre courante de 30 s.
  app.get<{ Params: { id: string } }>('/v1/titres/:id/qr', async (req) => svc.dynamicQr(requireUser(req), req.params.id));

  app.post<{ Params: { id: string } }>('/v1/titres/:id/prolongations', async (req, reply) => {
    const user = requireUser(req);
    const key = IdempotencyStore.requireKey(req.headers['idempotency-key']);
    const body = parse(extendSchema, req.body);
    const res = ctx.idempotency.execute(`titres-extend:${user.id}`, key, { id: req.params.id, body }, () => ({ statusCode: 201, body: svc.extend(user, req.params.id, body) }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(res.statusCode).send(res.body);
  });

  app.post<{ Params: { id: string } }>('/v1/titres/:id/abonnement', async (req) => {
    const body = parse(z.object({ consent: z.boolean() }).strict(), req.body);
    return svc.holderView(svc.setAutoRenew(requireUser(req), req.params.id, body.consent));
  });

  // Décision humaine motivée : suspendre, lever, annuler, remplacer.
  app.post<{ Params: { id: string } }>('/v1/titres/:id/decisions', async (req) => {
    const user = requireUser(req);
    const res = svc.decide(user, req.params.id, parse(decisionSchema, req.body));
    return {
      credential: svc.holderView(res.credential),
      ...('replacement' in res && res.replacement ? { replacement: svc.holderView(res.replacement) } : {}),
      ...('notice' in res ? { notice: res.notice } : {}),
    };
  });

  // Contrôle en ligne (QR dynamique ou statique, code court, plaque).
  app.post('/v1/titres/controles', async (req, reply) => {
    const user = requireUser(req);
    const view = svc.control(user, parse(controlSchema, req.body));
    // Pénalités impayées depuis plus de 30 jours (tous modules), visibles après ce contrôle.
    const ev = svc.controls.get(view.controlId);
    const cred = ev?.credentialId ? svc.credentials.get(ev.credentialId) : undefined;
    return reply.code(201).send(withOverdue(ctx, user, view, { plate: view.plate ?? cred?.subject.plate ?? null, taxpayerId: cred?.holderTaxpayerId ?? null }, 'TITRES', view.controlId));
  });

  // Paquet hors ligne : clé publique, liste de révocation signée, plaques actives.
  app.get<{ Querystring: { deviceId?: string; module?: string } }>('/v1/titres/hors-ligne/paquet', async (req) =>
    svc.offlinePack(requireUser(req), req.query.deviceId, req.query.module));

  app.get('/v1/titres/revocations', async (req) => {
    const user = requireUser(req);
    authorize(user, 'titres:control', user.territory ? { communes: user.territory } : {});
    svc.sync();
    return svc.revocationList();
  });

  // Lot signé de contrôles hors ligne (x-device-signature = HMAC-SHA256 du corps brut par la clé du terminal).
  app.post('/v1/titres/controles/lots', async (req) => {
    const user = requireUser(req);
    return svc.syncOffline(user, req.rawBody ?? '', header(req, 'x-device-signature'));
  });

  // Titres d'une plaque (contrôleur, journalisé).
  app.get<{ Params: { plaque: string }; Querystring: { module?: string; commune?: string } }>('/v1/vehicules/:plaque/titres', async (req) =>
    svc.listPlate(requireUser(req), req.params.plaque, req.query.module, req.query.commune));

  // Constats : liste (décideurs, auditeurs, contrôleur auteur) et décision.
  app.get<{ Querystring: { module?: string } }>('/v1/titres/constats', async (req) => {
    const user = requireUser(req);
    const canDecide = evaluate(user, 'titres:decide', { entities: [user.entity] }) || evaluate(user, 'titres:read.any', { entity: user.entity });
    const isController = evaluate(user, 'titres:control', user.territory ? { communes: user.territory } : {});
    if (!canDecide && !isController) throw forbidden('FORBIDDEN', 'Accès aux constats refusé.');
    return svc.constats
      .find((k) => (!req.query.module || k.module === req.query.module) && (canDecide ? (user.roles.some((r) => ['R22', 'R23', 'R24'].includes(r)) || k.entity === user.entity) : k.controllerId === user.id))
      .sort((a, b) => b.at.localeCompare(a.at));
  });

  app.post<{ Params: { id: string } }>('/v1/titres/constats/:id/decision', async (req) =>
    svc.decideConstat(requireUser(req), req.params.id, parse(constatSchema, req.body)));

  app.get<{ Querystring: { module?: string } }>('/v1/titres/indicateurs', async (req) => {
    const user = requireUser(req);
    authorize(user, 'titres:indicators');
    return svc.indicators(req.query.module);
  });

  app.get('/v1/titres/cle-publique', async () => ({ algorithm: 'Ed25519', publicKeyPem: svc.signer.publicKeyPem() }));
}
