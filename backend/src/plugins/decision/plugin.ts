/**
 * Module d'extension « décision » — Pilotage et décision (spécification fonctionnelle, modules 41 à 47), construit
 * PAR-DESSUS le pilotage et la planification existants (mêmes faits, mêmes circuits, même vocabulaire) :
 *  - 41 Centre de commandement exécutif : carte de chaleur, alertes, décisions tracées, rapport signé ;
 *  - 42 Régie fiscale : assiette et liquidation par recette et commune, recouvrement, campagnes, contentieux, agents ;
 *  - 43 Régie des taxes : recettes par taxe, autorisations, contrôles, renouvellements à temps ;
 *  - 44 Tableaux ministériels : modules rattachés, part de 10 % calculée / rapprochée / versée ;
 *  - 45 Salle de contrôle finances et trésorerie : temps réel, incidents, paramètres sensibles, escalade ;
 *  - 46 Audit et investigation : missions, échantillonnage, constats, recommandations, export scellé, corrections ;
 *  - 47 Prévision de trésorerie hebdomadaire avec hypothèses jointes et écart prévision / réalisé.
 * Aucune route de ce module ne modifie une donnée financière ; l'IA n'y crée ni dette, ni sanction, ni transfert.
 */
import { z } from 'zod';
import { CURRENCIES, type RoleCode } from '@mosolo/shared';
import { requireUser } from '../../core/auth.js';
import { canonicalJson } from '../../core/crypto.js';
import { isoDateString, parse } from '../../core/http.js';
import { allAgentRoles, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { unprocessable } from '../../core/errors.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { definePlugin } from '../types.js';
import { ExportSigner, EXPORT_KEY_ID } from '../pilotage/exports.js';
import { SCENARIO_CODES, type ScenarioCode } from '../pilotage/planification/model.js';
import type { PlanificationService } from '../pilotage/planification/service.js';
import type { PilotageService } from '../pilotage/service.js';
import { AuditMissionService, FINDING_SEVERITIES, POPULATIONS, type Population } from './audit-missions.js';
import { commandCentre, HEAT_DIMENSIONS } from './commandement.js';
import { MinistereService } from './ministere.js';
import { PrevisionService } from './prevision.js';
import { regieFiscale } from './regie-fiscale.js';
import { regieTaxes } from './regie-taxes.js';
import { SalleControleService } from './salle.js';
import { TransparenceService } from './transparence.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));

definePolicy('decision:command.read', g(['R01', 'R02', 'R03', 'R05']));
definePolicy('decision:regie-fiscale.read', g(['R06', 'R07', 'R01', 'R02', 'R03', 'R05', 'R22', 'R23']));
definePolicy('decision:regie-taxes.read', g(['R06', 'R07', 'R01', 'R02', 'R03', 'R05', 'R22', 'R23']));
definePolicy('decision:ministere.read', g(['R04', 'R01', 'R02', 'R03', 'R05', 'R22', 'R23']));
definePolicy('decision:ministere.versement', g(['R17', 'R18']));
definePolicy('decision:salle.read', g(['R17', 'R18', 'R05', 'R15', 'R01', 'R22', 'R23']));
definePolicy('decision:salle.acknowledge', g(['R05', 'R17']));
definePolicy('decision:audit.read', g(['R22', 'R23', 'R24']));
definePolicy('decision:audit.write', g(['R22', 'R23']));
definePolicy('decision:audit.respond', allAgentRoles(always));
const FORECAST_READERS: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R15', 'R17', 'R18', 'R22', 'R23'];
definePolicy('decision:prevision.read', g(FORECAST_READERS));
definePolicy('decision:prevision.write', g(['R05', 'R06', 'R15', 'R17']));

export class DecisionService {
  readonly ministere: MinistereService;
  readonly salle: SalleControleService;
  readonly audit: AuditMissionService;
  readonly prevision: PrevisionService;
  readonly transparence: TransparenceService;
  readonly signer: ExportSigner;

  constructor(readonly ctx: import('../../context.js').AppContext) {
    const pil = () => this.pil();
    this.ministere = new MinistereService(ctx, pil);
    this.salle = new SalleControleService(ctx, pil);
    this.audit = new AuditMissionService(ctx, pil);
    this.prevision = new PrevisionService(ctx, pil, () => this.plan());
    this.transparence = new TransparenceService(ctx, pil);
    this.signer = new ExportSigner(ctx.secrets.auditHmacKey);
  }

  pil(): PilotageService {
    const p = this.ctx.ext.pilotage as PilotageService | undefined;
    if (!p) throw unprocessable('PILOTAGE_REQUIRED', 'Module de pilotage non chargé.');
    return p;
  }

  plan(): PlanificationService | undefined {
    return this.ctx.ext.planification as PlanificationService | undefined;
  }
}

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const period = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2])|-T[1-4])?$/, 'AAAA, AAAA-MM ou AAAA-Tn attendu');
const query = z.object({
  commune: z.string().trim().max(64).optional(), category: z.string().trim().regex(/^[A-Z_]{2,40}$/).optional(), entity: z.string().trim().regex(/^[A-Z0-9_-]{2,40}$/).optional(),
  period: period.optional(), from: isoDateString.optional(), to: isoDateString.optional(), dimension: z.enum(HEAT_DIMENSIONS).optional(),
}).strict();
const sha = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');

export const decisionPlugin = definePlugin<DecisionService>({
  name: 'decision',
  create: (ctx) => new DecisionService(ctx),
  seed(ctx) {
    // Ministre de démonstration (fictif) : périmètre strict de son ministère (module 44).
    if (!ctx.users.get('u-ministre-transports')) ctx.users.add({ id: 'u-ministre-transports', name: 'Ministre provincial des Transports (démo)', roles: ['R04'], entity: 'MIN-TRANSPORTS' });
  },
  routes(app, ctx, svc) {
    // ── Module 54 (compléments) : parts de répartition publiques, consultations, publications à temps ──
    app.addHook('onResponse', async (req, reply) => {
      if (req.method === 'GET' && reply.statusCode === 200 && (req.url.startsWith('/v1/public/transparency') || req.url.startsWith('/v1/public/transparence'))) svc.transparence.count();
    });
    app.get<{ Params: { period: string } }>('/v1/public/transparence/repartition/:period', async (req) => svc.transparence.shares(req.params.period));
    app.get('/v1/decision/transparence', async (req) => svc.transparence.indicators(requireUser(req)));

    // ── Module 41 : centre de commandement exécutif ──
    app.get('/v1/decision/commandement', async (req) => {
      const user = requireUser(req);
      authorize(user, 'decision:command.read');
      return commandCentre(ctx, svc.pil(), svc.plan(), user, parse(query, req.query));
    });
    app.get('/v1/decision/commandement/rapport', async (req) => {
      const user = requireUser(req);
      authorize(user, 'decision:command.read');
      const content = commandCentre(ctx, svc.pil(), svc.plan(), user, parse(query, req.query));
      const payload = canonicalJson(content);
      const { sha256, signature } = svc.signer.sign(payload);
      const exportId = `CMD-${ctx.clock.now().toISOString().replace(/\D/g, '').slice(0, 14)}`;
      svc.pil().exportsLog.append({ id: `${exportId}-${svc.pil().exportsLog.count() + 1}`, exportId, kind: 'commandement', format: 'json', generatedAt: content.generatedAt, generatedBy: { id: user.id, roles: user.roles }, filters: content.filters as Record<string, unknown>, rows: content.heatmap.rows.length, sha256, signature, algorithm: 'HMAC-SHA256', keyId: EXPORT_KEY_ID, note: 'Rapport signé du centre de commandement : empreinte SHA-256 du JSON canonique.' });
      ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'pilotage.export.generated', resourceType: 'export', resourceId: exportId, details: { kind: 'commandement', sha256 } });
      return { exportId, manifest: { sha256, signature, keyId: EXPORT_KEY_ID, algorithm: 'HMAC-SHA256', verify: 'POST /v1/pilotage/exports/verify' }, payload, content };
    });
    app.post('/v1/decision/commandement/decisions', async (req, reply) => {
      const user = requireUser(req);
      authorize(user, 'decision:command.read');
      const plan = svc.plan();
      if (!plan) throw unprocessable('PLANIFICATION_REQUIRED', 'Circuit des instructions indisponible (module de planification non chargé).');
      const b = parse(z.object({
        kind: z.enum(['EXPLICATION', 'PLAN_ACTION']), subject: z.string().trim().min(5).max(200), body: z.string().trim().min(10).max(4000),
        context: z.object({ commune: z.string().max(64).optional(), category: z.string().max(40).optional(), entity: z.string().max(40).optional() }).strict().optional(),
        assignee: z.object({ entity: z.string().trim().regex(/^[A-Z0-9_-]{2,40}$/), role: z.string().regex(/^R\d{2}$/).optional() }).strict(), deadline: isoDateString,
      }).strict(), req.body);
      const instruction = plan.issueInstruction(user, {
        origin: b.kind === 'EXPLICATION' ? 'COMMUNE' : 'REGIE', subject: `${b.kind === 'EXPLICATION' ? 'Demande d’explication' : 'Demande de plan d’action'} — ${b.subject}`, body: b.body,
        ...(b.context ? { context: Object.fromEntries(Object.entries(b.context).filter(([, v]) => v !== undefined)) as { commune?: string } } : {}),
        assignee: { entity: b.assignee.entity, ...(b.assignee.role ? { role: b.assignee.role as RoleCode } : {}) }, deadline: b.deadline,
      });
      return reply.code(201).send({ instruction, financialEffect: 'AUCUN' });
    });

    // ── Module 42 : régie fiscale ──
    app.get('/v1/decision/regie-fiscale', async (req) => regieFiscale(ctx, svc.pil(), requireUser(req), parse(z.object({
      entity: z.string().regex(/^[A-Z0-9_-]{2,40}$/).optional(), period: period.optional(), from: isoDateString.optional(), to: isoDateString.optional(), commune: z.string().trim().max(64).optional(),
    }).strict(), req.query)));

    // ── Module 43 : régie des taxes ──
    app.get('/v1/decision/regie-taxes', async (req) => regieTaxes(ctx, svc.pil(), requireUser(req), parse(query, req.query)));

    // ── Module 44 : tableaux ministériels ──
    app.get('/v1/decision/ministeres', async (req) => svc.ministere.ministries(requireUser(req)));
    app.get('/v1/decision/ministere', async (req) => svc.ministere.view(requireUser(req), parse(z.object({ entity: z.string().regex(/^[A-Z0-9_-]{2,40}$/).optional(), period: period.optional() }).strict(), req.query)));
    app.post('/v1/decision/ministere/versements', async (req, reply) => {
      const b = parse(z.object({
        entity: z.string().regex(/^[A-Z0-9_-]{2,40}$/), period, reference: z.string().trim().min(3).max(120), motif,
        amount: z.object({ amount: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/), currency: z.string().refine((c) => c in CURRENCIES, 'devise inconnue') }).strict(),
      }).strict(), req.body);
      return reply.code(201).send(svc.ministere.proposeVersement(requireUser(req), { ...b, amount: b.amount as { amount: string; currency: 'CDF' } }));
    });
    app.post<{ Params: { id: string } }>('/v1/decision/ministere/versements/:id/decision', async (req) => svc.ministere.decideVersement(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));

    // ── Module 45 : salle de contrôle ──
    app.get('/v1/decision/salle-controle', async (req) => svc.salle.view(requireUser(req)));
    app.post('/v1/decision/salle-controle/escalades', async (req) => {
      const user = requireUser(req);
      authorize(user, 'decision:salle.read');
      return { created: svc.salle.escalate(user) };
    });
    app.post<{ Params: { id: string } }>('/v1/decision/salle-controle/escalades/:id/prise-en-charge', async (req) => svc.salle.acknowledge(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));

    // ── Module 46 : audit et investigation ──
    app.get('/v1/decision/audit/missions', async (req) => svc.audit.list(requireUser(req)));
    app.post('/v1/decision/audit/missions', async (req, reply) => reply.code(201).send(svc.audit.create(requireUser(req), parse(z.object({ title: z.string().trim().min(5).max(200), objective: z.string().trim().min(10).max(2000), scope: z.string().trim().min(3).max(500) }).strict(), req.body))));
    app.post<{ Params: { id: string } }>('/v1/decision/audit/missions/:id/echantillons', async (req, reply) => {
      const b = parse(z.object({
        population: z.enum(Object.keys(POPULATIONS) as [Population, ...Population[]]), size: z.number().int().min(1).max(500), seed: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/).optional(),
        from: isoDateString.optional(), to: isoDateString.optional(), commune: z.string().refine((c) => (COMMUNES as readonly string[]).includes(c), 'commune inconnue').optional(),
      }).strict(), req.body);
      return reply.code(201).send(svc.audit.sample(requireUser(req), req.params.id, b));
    });
    app.post<{ Params: { id: string } }>('/v1/decision/audit/missions/:id/constats', async (req, reply) => reply.code(201).send(svc.audit.addFinding(requireUser(req), req.params.id, parse(z.object({ title: z.string().trim().min(5).max(200), description: z.string().trim().min(10).max(4000), severity: z.enum(FINDING_SEVERITIES), evidence: z.array(z.string().max(120)).max(200).default([]) }).strict(), req.body))));
    app.post<{ Params: { id: string; findingId: string } }>('/v1/decision/audit/missions/:id/constats/:findingId/recommandations', async (req, reply) => reply.code(201).send(svc.audit.addRecommendation(requireUser(req), req.params.id, req.params.findingId, parse(z.object({ text: z.string().trim().min(10).max(2000), ownerEntity: z.string().regex(/^[A-Z0-9_-]{2,40}$/), deadline: isoDateString }).strict(), req.body))));
    app.post<{ Params: { id: string } }>('/v1/decision/audit/recommandations/:id/suivi', async (req) => svc.audit.followUp(requireUser(req), req.params.id, parse(z.object({ status: z.enum(['MISE_EN_OEUVRE_DECLAREE', 'MISE_EN_OEUVRE_VERIFIEE', 'NON_RETENUE']), note: z.string().trim().min(5).max(2000), evidenceSha256: sha.optional() }).strict(), req.body)));
    app.post<{ Params: { id: string } }>('/v1/decision/audit/missions/:id/cloture', async (req) => svc.audit.close(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post<{ Params: { id: string } }>('/v1/decision/audit/missions/:id/scelle', async (req, reply) => reply.code(201).send(svc.audit.seal(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif)));
    app.get('/v1/decision/audit/scelles', async (req) => svc.audit.listSealed(requireUser(req)));
    app.get<{ Params: { id: string } }>('/v1/decision/audit/scelles/:id', async (req) => svc.audit.getSealed(requireUser(req), req.params.id));
    app.post<{ Params: { id: string } }>('/v1/decision/audit/scelles/:id/remise', async (req) => svc.audit.handOver(requireUser(req), req.params.id, parse(z.object({ to: z.string().trim().min(3).max(200), motif }).strict(), req.body)));
    app.get<{ Params: { ref: string } }>('/v1/decision/audit/corrections/:ref', async (req) => svc.audit.correction(requireUser(req), req.params.ref));

    // ── Module 47 : prévision de trésorerie ──
    app.get('/v1/decision/previsions', async (req) => svc.prevision.list(requireUser(req)));
    app.post('/v1/decision/previsions', async (req, reply) => {
      const b = parse(z.object({ weeks: z.number().int().min(1).max(26).optional(), scenario: z.enum(SCENARIO_CODES as [ScenarioCode, ...ScenarioCode[]]).optional(), commune: z.string().max(64).optional(), category: z.string().regex(/^[A-Z_]{2,40}$/).optional() }).strict(), req.body ?? {});
      return reply.code(201).send(svc.prevision.generate(requireUser(req), b));
    });
    app.get<{ Params: { id: string } }>('/v1/decision/previsions/:id', async (req) => svc.prevision.get(requireUser(req), req.params.id));
    app.get<{ Params: { id: string } }>('/v1/decision/previsions/:id/ecart', async (req) => svc.prevision.gap(requireUser(req), req.params.id));
  },
});
