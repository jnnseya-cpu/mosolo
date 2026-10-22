/** Routes HTTP du module Intégrité. Les routes publiques n'exigent aucun compte (anonymat possible). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';
import { isoDateString, parse } from '../../core/http.js';
import { IdempotencyStore } from '../../core/idempotency.js';
import { hasAnyGrant, type ExtensionAction } from '../../core/policy.js';
import type { FastifyRequest } from 'fastify';
import { gatewayGuard, inboundRecorder } from '../preuves/routes.js';
import type { IntegriteService } from './service.js';
import {
  CASE_DECISIONS, INCIDENT_CATEGORIES, MYSTERY_TARGETS, NOTIFICATION_TARGETS, RECTIFIABLE_FIELDS, REPORT_CATEGORIES, SEVERITIES, TARGET_KINDS,
} from './types.js';

const sha = z.string().regex(/^[0-9a-fA-F]{64}$/, 'empreinte SHA-256 (64 caractères hexadécimaux) attendue');
const evidence = z.object({ sha256: sha, label: z.string().trim().min(2).max(200) }).strict();
const text = (min: number, max = 5000) => z.string().trim().min(min).max(max);
const severity = z.enum(SEVERITIES);

const reportBody = z.object({
  category: z.enum(REPORT_CATEGORIES),
  description: text(10),
  commune: z.string().trim().max(80).optional(),
  place: z.string().trim().max(200).optional(),
  occurredOn: isoDateString.optional(),
  target: z.object({ kind: z.enum(TARGET_KINDS), reference: z.string().trim().max(120).optional() }).strict().optional(),
  anonymous: z.boolean(),
  contact: z.object({
    name: z.string().trim().max(120).optional(),
    phone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'numéro de téléphone invalide').optional(),
    email: z.string().trim().email().optional(),
  }).strict().optional(),
  evidence: z.array(evidence).max(10).optional(),
}).strict();

const codeBody = z.object({ code: z.string().trim().min(12).max(20) }).strict();

/**
 * Contrôle d'accès AVANT la validation du corps : une personne sans habilitation reçoit 403 (journalisé),
 * jamais le détail des erreurs de saisie. Le service revérifie ensuite avec le périmètre exact.
 */
function pre(req: FastifyRequest, action: ExtensionAction): User {
  const u = requireUser(req);
  if (!hasAnyGrant(u, action)) throw forbidden('FORBIDDEN', `Action « ${action} » non autorisée pour les rôles ${u.roles.join(', ')}.`, { action });
  return u;
}

export function registerIntegriteRoutes(app: FastifyInstance, ctx: AppContext, svc: IntegriteService): void {
  /* ---------------- Public : ligne de signalement ---------------- */
  app.post('/v1/public/integrite/reports', async (req, reply) => {
    const body = parse(reportBody, req.body);
    const key = req.headers['idempotency-key'];
    if (key) {
      const k = IdempotencyStore.requireKey(key);
      const res = ctx.idempotency.execute('integrite:report', k, body, () => ({ statusCode: 201, body: svc.submit(body, 'WEB', 'public') }));
      if (res.replayed) void reply.header('idempotent-replayed', 'true');
      return reply.code(res.statusCode).send(res.body);
    }
    return reply.code(201).send(svc.submit(body, 'WEB', 'public'));
  });

  // Passerelles opérateur (SMS entrant, SVI) : signature HMAC du corps brut, comme /v1/sms/inbound. Sans secret configuré,
  // simulateur de démonstration seulement — sinon n'importe qui déposerait un signalement au nom d'un numéro tiers.
  app.post('/v1/public/integrite/reports/sms', async (req, reply) => {
    gatewayGuard(req, ctx.integrations.value('SMS_GATEWAY_SECRET'), 'x-mosolo-signature', '', inboundRecorder(ctx, 'integrite-sms'));
    const b = parse(z.object({ from: z.string().trim().regex(/^\+?[0-9]{8,15}$/), text: text(3, 640) }).strict(), req.body);
    return reply.code(201).send(svc.fromSms(b));
  });

  app.post('/v1/public/integrite/reports/svi', async (req, reply) => {
    gatewayGuard(req, ctx.integrations.value('SVI_GATEWAY_SECRET'), 'x-mosolo-signature', '', inboundRecorder(ctx, 'integrite-svi'));
    const b = parse(z.object({
      callerNumber: z.string().trim().regex(/^\+?[0-9]{8,15}$/).optional(),
      digits: z.array(z.string().regex(/^[0-9]$/)).min(1).max(4),
      transcript: text(10),
      commune: z.string().trim().max(80).optional(),
    }).strict(), req.body);
    return reply.code(201).send(svc.fromSvi(b));
  });

  // Le code de suivi circule dans le corps (POST), jamais dans l'URL (journaux, historique du navigateur).
  app.post('/v1/public/integrite/reports/track', async (req) => svc.track(parse(codeBody, req.body).code));

  app.post('/v1/public/integrite/reports/track/complement', async (req) => {
    const b = parse(z.object({ code: z.string().trim().min(12).max(20), text: text(5), evidence: z.array(evidence).max(10).optional() }).strict(), req.body);
    return svc.complement(b.code, b);
  });

  app.get('/v1/public/integrite/summary', async () => svc.publicSummary());

  /* ---------------- Signalements (console) ---------------- */
  app.get<{ Querystring: { status?: string; category?: string } }>('/v1/integrite/reports', async (req) => svc.listReports(requireUser(req), req.query));
  app.get<{ Params: { id: string } }>('/v1/integrite/reports/:id', async (req) => svc.getReportFor(requireUser(req), req.params.id));

  app.post('/v1/integrite/reports/intake', async (req, reply) => {
    const user = pre(req, 'integrite:report.intake');
    const b = parse(reportBody.extend({ channel: z.enum(['NUMERO_GRATUIT', 'GUICHET']) }), req.body);
    return reply.code(201).send(svc.intake(user, b));
  });

  app.post<{ Params: { id: string } }>('/v1/integrite/reports/:id/qualify', async (req) => {
    const user = pre(req, 'integrite:report.qualify');
    const b = parse(z.object({
      category: z.enum(REPORT_CATEGORIES), severity, receivable: z.boolean(), note: text(5),
      implicatedUserIds: z.array(z.string().max(80)).max(10).optional(),
    }).strict(), req.body);
    return svc.qualify(user, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>('/v1/integrite/reports/:id/assign', async (req) => {
    const user = pre(req, 'integrite:report.assign');
    const b = parse(z.object({ investigatorId: z.string().min(1), note: z.string().trim().max(2000).optional(), openCase: z.boolean().optional() }).strict(), req.body);
    return svc.assign(user, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>('/v1/integrite/reports/:id/messages', async (req) => {
    const user = pre(req, 'integrite:report.respond');
    const b = parse(z.object({ text: text(5, 2000) }).strict(), req.body);
    return svc.respond(user, req.params.id, b.text);
  });

  app.post<{ Params: { id: string } }>('/v1/integrite/reports/:id/close', async (req) => {
    const user = pre(req, 'integrite:report.close');
    const b = parse(z.object({ outcome: z.enum(['FONDE', 'NON_FONDE', 'INSUFFISANT']), reason: text(10), publicMessage: text(10, 2000) }).strict(), req.body);
    return svc.closeReport(user, req.params.id, b);
  });

  /* ---------------- Signaux et alertes ---------------- */
  app.post('/v1/integrite/observations', async (req, reply) => {
    const user = pre(req, 'integrite:observation.submit');
    const obs = z.object({
      type: z.enum(['VERIFICATION_QUITTANCE', 'PAIEMENT_POINT']),
      at: z.string().datetime(),
      source: z.string().trim().min(2).max(120),
      receiptRef: z.string().max(80).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lon: z.number().min(-180).max(180).optional(),
      commune: z.string().max(80).optional(),
      pointRef: z.string().max(80).optional(),
      obligationRef: z.string().max(80).optional(),
      amount: z.object({ amount: z.string().regex(/^\d{1,18}(\.\d{1,6})?$/), currency: z.string().length(3) }).strict().optional(),
    }).strict();
    const b = parse(z.object({ observations: z.array(obs).min(1).max(500) }).strict(), req.body);
    return reply.code(201).send(svc.ingest(user, b.observations));
  });

  app.post('/v1/integrite/detection/run', async (req) => svc.runDetection(requireUser(req)));
  app.get<{ Querystring: { status?: string } }>('/v1/integrite/alerts', async (req) => svc.listAlerts(requireUser(req), req.query));
  app.post<{ Params: { id: string } }>('/v1/integrite/alerts/:id/examine', async (req) => {
    const user = pre(req, 'integrite:alert.examine');
    return svc.examineAlert(user, req.params.id, parse(z.object({ note: z.string().trim().max(2000).optional() }).strict(), req.body).note);
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/alerts/:id/propose-closure', async (req) => {
    const user = pre(req, 'integrite:alert.examine');
    return svc.proposeAlertClosure(user, req.params.id, parse(z.object({ reason: text(10) }).strict(), req.body).reason);
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/alerts/:id/validate-closure', async (req) => {
    const user = pre(req, 'integrite:alert.validate');
    return svc.validateAlertClosure(user, req.params.id, parse(z.object({ approve: z.boolean(), reason: text(5) }).strict(), req.body));
  });

  /* ---------------- Dossiers d'enquête ---------------- */
  app.get('/v1/integrite/cases', async (req) => svc.listCases(requireUser(req)));
  app.get<{ Params: { id: string } }>('/v1/integrite/cases/:id', async (req) => svc.getCaseFor(requireUser(req), req.params.id));
  app.post('/v1/integrite/cases', async (req, reply) => {
    const user = pre(req, 'integrite:case.open');
    const b = parse(z.object({
      title: text(5, 200), reason: text(10),
      alertIds: z.array(z.string()).max(50).optional(), reportIds: z.array(z.string()).max(50).optional(),
      mysteryCheckIds: z.array(z.string()).max(50).optional(), investigatorId: z.string().optional(),
    }).strict(), req.body);
    const c = svc.openCase(user, b);
    return reply.code(201).send(svc.caseView(c));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/cases/:id/evidence', async (req) => {
    const user = pre(req, 'integrite:case.instruct');
    return svc.addCaseEvidence(user, req.params.id, parse(evidence, req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/cases/:id/notes', async (req) => {
    const user = pre(req, 'integrite:case.instruct');
    return svc.addCaseNote(user, req.params.id, parse(z.object({ kind: z.enum(['NOTE', 'DEMANDE_PIECES']), text: text(5) }).strict(), req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/cases/:id/links', async (req) => {
    const user = pre(req, 'integrite:case.instruct');
    return svc.addCaseLink(user, req.params.id, parse(z.object({ kind: z.string().trim().min(2).max(40), ref: z.string().trim().min(1).max(120), note: z.string().trim().max(500).optional(), implicated: z.boolean().optional() }).strict(), req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/cases/:id/conclusions', async (req) => {
    const user = pre(req, 'integrite:case.instruct');
    return svc.conclude(user, req.params.id, parse(z.object({ finding: z.enum(['FONDE', 'NON_FONDE', 'INSUFFISANT']), summary: text(20), recommendation: z.enum(CASE_DECISIONS) }).strict(), req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/cases/:id/decision', async (req) => {
    const user = pre(req, 'integrite:case.decide');
    return svc.decide(user, req.params.id, parse(z.object({ decision: z.enum(CASE_DECISIONS), reason: text(1) }).strict(), req.body));
  });

  /* ---------------- Contrôles mystère ---------------- */
  app.get('/v1/integrite/mystery-checks', async (req) => svc.listMystery(requireUser(req)));
  app.post('/v1/integrite/mystery-checks', async (req, reply) => {
    const user = pre(req, 'integrite:mystery.plan');
    const b = parse(z.object({
      programme: text(3, 120), targetKind: z.enum(MYSTERY_TARGETS), targetRef: text(2, 120), commune: text(2, 80),
      scenario: text(10, 1000), plannedFor: isoDateString, controllerId: z.string().min(1),
    }).strict(), req.body);
    return reply.code(201).send(svc.planMystery(user, b));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/mystery-checks/:id/result', async (req) => {
    const user = pre(req, 'integrite:mystery.record');
    return svc.recordMystery(user, req.params.id, parse(z.object({
      outcome: z.enum(['CONFORME', 'NON_CONFORME', 'NON_REALISABLE']), cashRequested: z.boolean(),
      officialAmountShown: z.boolean().nullable(), receiptIssued: z.boolean().nullable(), observations: text(5), evidence: z.array(evidence).max(10).optional(),
    }).strict(), req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/mystery-checks/:id/follow-up', async (req) => {
    const user = pre(req, 'integrite:mystery.plan');
    return svc.followUpMystery(user, req.params.id, parse(z.object({ action: z.enum(['AUCUNE_SUITE', 'RAPPEL_PROCEDURE', 'OUVRIR_DOSSIER']), note: text(10) }).strict(), req.body));
  });

  /* ---------------- Incidents de sécurité ---------------- */
  app.get('/v1/integrite/incidents', async (req) => svc.listIncidents(requireUser(req)));
  app.get('/v1/integrite/incidents/candidates', async (req) => svc.incidentCandidates(requireUser(req)));
  app.post('/v1/integrite/incidents', async (req, reply) => {
    const user = pre(req, 'integrite:incident.declare');
    const b = parse(z.object({
      title: text(5, 200), description: text(10), category: z.enum(INCIDENT_CATEGORIES), severity,
      detectedAt: z.string().datetime().optional(), personalDataImpacted: z.boolean(),
      affectedTaxpayerIds: z.array(z.string()).max(10_000).optional(), fromAlertId: z.string().optional(),
    }).strict(), req.body);
    return reply.code(201).send(svc.declareIncident(user, b));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/incidents/:id/assign', async (req) => {
    const user = pre(req, 'integrite:incident.manage');
    return svc.assignIncident(user, req.params.id, parse(z.object({ ownerId: z.string().min(1) }).strict(), req.body).ownerId);
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/incidents/:id/status', async (req) => {
    const user = pre(req, 'integrite:incident.manage');
    return svc.moveIncident(user, req.params.id, parse(z.object({ status: z.enum(['EN_COURS', 'CONTENU', 'RESOLU']), note: text(5) }).strict(), req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/incidents/:id/notifications', async (req) => {
    const user = pre(req, 'integrite:incident.notify');
    return svc.notifyIncident(user, req.params.id, parse(z.object({ target: z.enum(NOTIFICATION_TARGETS), note: text(5) }).strict(), req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/incidents/:id/close', async (req) => {
    const user = pre(req, 'integrite:incident.close');
    return svc.closeIncident(user, req.params.id, parse(z.object({ proofSha256: sha, summary: text(10) }).strict(), req.body));
  });

  /* ---------------- Protection des données ---------------- */
  app.get('/v1/integrite/privacy/requests', async (req) => svc.listPrivacy(requireUser(req)));
  app.post('/v1/integrite/privacy/requests', async (req, reply) => {
    const user = pre(req, 'integrite:privacy.submit');
    const b = parse(z.object({
      taxpayerId: z.string().min(1), type: z.enum(['ACCES', 'RECTIFICATION', 'LIMITATION', 'EFFACEMENT']), details: text(5),
      field: z.enum(RECTIFIABLE_FIELDS).optional(), requestedValue: z.string().trim().min(1).max(200).optional(),
    }).strict(), req.body);
    return reply.code(201).send(svc.submitPrivacy(user, b));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/privacy/requests/:id/take', async (req) => svc.takePrivacy(requireUser(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/integrite/privacy/requests/:id/respond', async (req) => {
    const user = pre(req, 'integrite:privacy.process');
    return svc.respondPrivacy(user, req.params.id, parse(z.object({ decision: z.enum(['ACCEPTEE', 'REJETEE']), note: text(5) }).strict(), req.body));
  });
  // Seconde validation (deux personnes) d'une limitation ou d'un effacement (anonymisation) — 27/09/2026.
  app.post<{ Params: { id: string } }>('/v1/integrite/privacy/requests/:id/validation', async (req) => {
    const user = pre(req, 'integrite:privacy.process');
    return svc.validatePrivacy(user, req.params.id, parse(z.object({ approve: z.boolean(), note: text(5) }).strict(), req.body));
  });
  app.get<{ Params: { id: string } }>('/v1/integrite/privacy/requests/:id/export', async (req) => svc.getExport(requireUser(req), req.params.id));
  app.get('/v1/integrite/privacy/registry', async (req) => svc.registry(requireUser(req)));
  app.get<{ Params: { id: string } }>('/v1/integrite/privacy/registry/:id/history', async (req) => svc.registryHistory(requireUser(req), req.params.id));
  app.post('/v1/integrite/privacy/registry', async (req, reply) => {
    const user = pre(req, 'integrite:privacy.registry.write');
    const list = z.array(z.string().trim().min(1).max(200)).max(30);
    const b = parse(z.object({
      id: z.string().optional(), name: text(3, 200), purpose: text(10, 2000), legalBasis: text(3, 500), dataCategories: list, dataSubjects: list,
      recipients: list, retention: text(3, 300), security: list, module: text(2, 80), sensitive: z.boolean(),
    }).strict(), req.body);
    return reply.code(201).send(svc.upsertRegistry(user, b));
  });
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/integrite/privacy/access-log', async (req) => svc.accessLog(requireUser(req), req.query.taxpayerId));

  /* ---------------- Revue des accès ---------------- */
  app.get('/v1/integrite/access-reviews', async (req) => svc.listReviews(requireUser(req)));
  app.post('/v1/integrite/access-reviews', async (req, reply) => {
    const user = pre(req, 'integrite:access-review.launch');
    return reply.code(201).send(svc.launchReview(user, parse(z.object({ label: text(3, 120) }).strict(), req.body).label));
  });
  // Revue MENSUELLE des accès privilégiés (rôles privilégiés + élévations juste-à-temps du mois).
  app.post('/v1/integrite/access-reviews/privileged', async (req, reply) => {
    const user = pre(req, 'integrite:access-review.launch');
    const b = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).strict(), req.body ?? {});
    return reply.code(201).send(svc.launchPrivilegedReview(user, b.period));
  });
  app.post<{ Params: { id: string; itemId: string } }>('/v1/integrite/access-reviews/:id/items/:itemId/decision', async (req) => {
    const user = pre(req, 'integrite:access-review.decide');
    return svc.decideReviewItem(user, req.params.id, req.params.itemId, parse(z.object({ decision: z.enum(['MAINTENU', 'RETRAIT_A_EXECUTER']), reason: z.string().trim().max(1000) }).strict(), req.body));
  });
  app.post<{ Params: { id: string } }>('/v1/integrite/access-reviews/:id/close', async (req) => svc.closeReview(requireUser(req), req.params.id));

  /* ---------------- Indicateurs ---------------- */
  app.get('/v1/integrite/indicators', async (req) => svc.indicators(requireUser(req)));
}
