/**
 * Module d'extension « plateforme » — Plateforme et accès (spécification fonctionnelle) :
 *  - 52 Intégration et API : registre des interfaces, clients OAuth2 à portées contractées, mTLS, quotas, journal des
 *    appels, rejet hors objet, rappels signés (partenaires.ts) ;
 *  - 53 Administration de la plateforme : environnements, déploiements et retours arrière validés par le comité de
 *    contrôle des changements, configuration technique non financière (deploiements.ts) ;
 *  - 55 Supervision et santé : métriques (format Prometheus), alertes disponibilité / latence / erreurs, incidents et
 *    astreinte, délai de rétablissement contre le RTO (supervision.ts).
 * Aucune route de ce module n'a de pouvoir fiscal ou financier.
 */
import { z } from 'zod';
import type { RoleCode } from '@mosolo/shared';
import { registerMachineTokenPrefix, requireUser } from '../../core/auth.js';
import { kinshasaDay } from '../../core/clock.js';
import { isoDateString, parse } from '../../core/http.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { notFound, unauthorized } from '../../core/errors.js';
import { safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { definePlugin } from '../types.js';
import type { MtlsConfig } from '../socle/mtls.js';
import { PlatformAdminService, ENVIRONMENTS, type EnvCode } from './deploiements.js';
import { PARTNER_EVENTS, PARTNER_KINDS, PARTNER_SCOPES, PARTNER_TOKEN_PREFIX, PartnerApiService, type PartnerEvent, type PartnerKind, type PartnerScope } from './partenaires.js';
import { RTO_HOURS, SEVERITIES, SupervisionService, type Phase } from './supervision.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
definePolicy('plateforme:partenaires.read', g(['R26', 'R27', 'R28', 'R25', 'R22', 'R23']));
definePolicy('plateforme:partenaires.manage', g(['R26', 'R27']));
/** Approbation du protocole d'échange et révocation : sécurité ou délégué à la protection des données. */
definePolicy('plateforme:partenaires.approve', g(['R28', 'R25']));
definePolicy('plateforme:admin.read', g(['R26', 'R27', 'R28', 'R22', 'R23']));
definePolicy('plateforme:admin.request', g(['R26', 'R27']));
/** Comité de contrôle des changements : super-administrateur, sécurité, exploitation (personnes distinctes du demandeur). */
definePolicy('plateforme:admin.cab', g(['R26', 'R27', 'R28']));
definePolicy('plateforme:admin.execute', g(['R26', 'R27']));
definePolicy('plateforme:supervision.read', g(['R26', 'R27', 'R28', 'R22']));
definePolicy('plateforme:supervision.manage', g(['R26', 'R27']));
definePolicy('plateforme:supervision.incident', g(['R26', 'R27', 'R28']));

export interface PlateformeService {
  partenaires: PartnerApiService;
  admin: PlatformAdminService;
  supervision: SupervisionService;
}

const motif = z.string().trim().min(10).max(2000);
const sha = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const scopeEnum = z.enum(Object.keys(PARTNER_SCOPES) as [PartnerScope, ...PartnerScope[]]);

export const plateformePlugin = definePlugin<PlateformeService>({
  name: 'plateforme',
  create: (ctx) => {
    registerMachineTokenPrefix(PARTNER_TOKEN_PREFIX);
    const supervision = new SupervisionService(ctx);
    const partenaires = new PartnerApiService(ctx, () => (ctx.ext.socle as { mtls?: MtlsConfig } | undefined)?.mtls);
    const admin = new PlatformAdminService(ctx, () => supervision.incidents.all());
    // Événements partenaires dérivés du journal d'audit (paiement confirmé, quittance émise) : aucun effet sur le journal.
    ctx.audit.onAppend((r) => {
      if (r.action === 'payment.confirmed' && r.resourceId) {
        const o = ctx.payments.orders.get(r.resourceId);
        if (o) void partenaires.emit('paiement.confirme', { paymentReference: o.paymentReference, status: 'CONFIRME', ...(o.provider ? { provider: o.provider } : {}), ...(typeof r.details.receipt === 'string' ? { receiptNumber: r.details.receipt } : {}) });
      } else if (r.action === 'receipt.finalized' && r.resourceId) {
        const q = ctx.receipts.receipts.get(r.resourceId);
        const o = q ? ctx.payments.orders.get(q.paymentOrderId) : undefined;
        if (q && o) void partenaires.emit('quittance.emise', { paymentReference: o.paymentReference, status: 'QUITTANCE_DEFINITIVE', receiptNumber: q.number, ...(o.provider ? { provider: o.provider } : {}) });
      }
    });
    return { partenaires, admin, supervision };
  },
  seed: (ctx) => {
    // Contrat d'interface de démonstration (fictif, non contractuel) : en attente d'approbation par une seconde personne.
    const svc = ctx.ext.plateforme as PlateformeService;
    const admin = ctx.users.get('u-superadmin');
    if (admin && !svc.partenaires.contracts.count()) {
      svc.partenaires.proposeContract(admin, {
        code: 'ITF-DEMO-BANQUE-A', partnerName: 'Banque partenaire A [EXEMPLE — non contractuel]', partnerKind: 'BANQUE',
        object: 'Statut des ordres de paiement réglés par la banque A et événements de confirmation (démonstration).',
        scopes: ['paiements:statut', 'quittances:verifier', 'evenements:paiements'], dataCategories: ['Référence de paiement', 'Statut', 'Montant'], providerId: 'bank-a',
        protocol: { reference: 'PROTO-DEMO-001 [EXEMPLE]', sha256: sha256Hex('protocole de démonstration non contractuel'), signedAt: '2026-09-01' },
        consentRequired: false, validFrom: '2026-09-01', validTo: '2027-08-31',
      });
    }
  },
  routes: (app, ctx, svc) => {
    svc.supervision.install(app);
    const { partenaires: P, admin: A, supervision: S } = svc;

    // ── Module 52 : jeton OAuth2 et API partenaire versionnée ──
    app.post('/v1/oauth/token', async (req) => P.issueToken(req, (req.body ?? {}) as Record<string, string>));
    app.get('/v1/partenaires/api/v1', async () => ({ version: 'v1', format: 'REST/JSON', auth: 'OAuth2 client credentials (POST /v1/oauth/token), TLS mutuel facultatif', scopes: PARTNER_SCOPES, events: PARTNER_EVENTS }));
    app.get<{ Params: { numero: string } }>('/v1/partenaires/api/v1/quittances/:numero', async (req) => P.guard(req, '/v1/partenaires/api/v1/quittances/:numero', 'quittances:verifier', () => {
      const r = ctx.receipts.find(req.params.numero);
      if (!r) throw notFound('RECEIPT_NOT_FOUND', 'Quittance inconnue.');
      return { number: r.number, status: r.status, signatureValid: ctx.receipts.verifySignature(r), revenueCategory: r.revenueCategory, amount: r.amount };
    }));
    app.get<{ Params: { reference: string } }>('/v1/partenaires/api/v1/paiements/:reference', async (req) => P.guard(req, '/v1/partenaires/api/v1/paiements/:reference', 'paiements:statut', (p) => {
      const o = ctx.payments.byReference(req.params.reference);
      if (!o) throw notFound('PAYMENT_NOT_FOUND', 'Référence de paiement inconnue.');
      if (!p.contract.providerId || o.provider !== p.contract.providerId) P.outOfObject('Cet ordre de paiement ne relève pas du prestataire couvert par votre contrat.');
      return { paymentReference: o.paymentReference, status: o.status, amount: o.amount, confirmedAt: o.confirmedAt ?? null, settledAt: o.settledAt ?? null };
    }));
    app.get<{ Querystring: { period?: string } }>('/v1/partenaires/api/v1/statistiques', async (req) => P.guard(req, '/v1/partenaires/api/v1/statistiques', 'statistiques:agregees', () => {
      const period = parse(z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/).optional(), req.query.period);
      const pil = ctx.ext.pilotage as { facts(): { orders: { reconciledAt?: string; commune: string; amount: { amount: string; currency: string } }[] } } | undefined;
      const m = new Map<string, { commune: string; currency: string; count: number }>();
      for (const o of pil?.facts().orders ?? []) {
        if (!o.reconciledAt || (period && !kinshasaDay(o.reconciledAt).startsWith(period))) continue;
        const k = `${o.commune}|${o.amount.currency}`;
        const r = m.get(k) ?? { commune: o.commune, currency: o.amount.currency, count: 0 };
        r.count++; m.set(k, r);
      }
      // Petits effectifs masqués (anti-ré-identification) : moins de 5 paiements ⇒ « < 5 ».
      return { period: period ?? null, rows: [...m.values()].map((r) => ({ commune: r.commune, currency: r.currency, payments: r.count < 5 ? '< 5' : r.count })), note: 'Agrégats seulement ; aucune donnée individuelle.' };
    }));
    app.post('/v1/partenaires/api/v1/abonnements', async (req, reply) => {
      const b = parse(z.object({ url: z.string().url().max(500), events: z.array(z.enum(Object.keys(PARTNER_EVENTS) as [PartnerEvent, ...PartnerEvent[]])).min(1) }).strict(), req.body);
      return reply.code(201).send(await P.guard(req, '/v1/partenaires/api/v1/abonnements', 'evenements:paiements', (p) => P.subscribe(p, b)));
    });

    // ── Module 52 : administration (registre des interfaces, clients, journal) ──
    app.get('/v1/plateforme/partenaires', async (req) => P.view(requireUser(req)));
    app.post('/v1/plateforme/partenaires/contrats', async (req, reply) => {
      const b = parse(z.object({
        code: z.string().regex(/^[A-Z0-9-]{3,40}$/), partnerName: z.string().trim().min(3).max(200), partnerKind: z.enum(Object.keys(PARTNER_KINDS) as [PartnerKind, ...PartnerKind[]]),
        object: z.string().trim().min(10).max(2000), scopes: z.array(scopeEnum).min(1), dataCategories: z.array(z.string().trim().min(2).max(120)).min(1).max(30),
        providerId: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), protocol: z.object({ reference: z.string().trim().min(3).max(120), sha256: sha, signedAt: isoDateString }).strict(),
        consentRequired: z.boolean(), validFrom: isoDateString, validTo: isoDateString,
      }).strict(), req.body);
      return reply.code(201).send(P.proposeContract(requireUser(req), { ...b, ...(b.providerId ? { providerId: b.providerId } : {}) } as Parameters<PartnerApiService['proposeContract']>[1]));
    });
    app.post<{ Params: { id: string } }>('/v1/plateforme/partenaires/contrats/:id/decision', async (req) => P.decideContract(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
    app.post<{ Params: { id: string } }>('/v1/plateforme/partenaires/contrats/:id/suspension', async (req) => P.suspendContract(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post('/v1/plateforme/partenaires/clients', async (req, reply) => {
      const b = parse(z.object({ contractId: z.string().max(40), label: z.string().trim().min(3).max(120), certFingerprint: z.string().max(120).optional(), quota: z.object({ perMinute: z.number().int().min(1).max(10_000), perDay: z.number().int().min(1).max(10_000_000) }).strict().optional() }).strict(), req.body);
      return reply.code(201).send(P.createClient(requireUser(req), { contractId: b.contractId, label: b.label, ...(b.certFingerprint ? { certFingerprint: b.certFingerprint } : {}), ...(b.quota ? { quota: b.quota } : {}) }));
    });
    app.post<{ Params: { id: string } }>('/v1/plateforme/partenaires/clients/:id/revocation', async (req) => P.revokeClient(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));

    // ── Module 53 : environnements, déploiements, configuration technique ──
    app.get('/v1/plateforme/administration', async (req) => A.view(requireUser(req)));
    app.post('/v1/plateforme/changements', async (req, reply) => {
      const b = parse(z.object({
        kind: z.enum(['DEPLOIEMENT', 'RETOUR_ARRIERE', 'CONFIGURATION']), environment: z.enum(Object.keys(ENVIRONMENTS) as [EnvCode, ...EnvCode[]]),
        version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,40}$/).optional(), config: z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/), value: z.string().max(500) }).strict().optional(),
        motif, rollbackPlan: z.string().trim().min(10).max(2000),
      }).strict(), req.body);
      return reply.code(201).send(A.request(requireUser(req), { kind: b.kind, environment: b.environment, motif: b.motif, rollbackPlan: b.rollbackPlan, ...(b.version ? { version: b.version } : {}), ...(b.config ? { config: b.config } : {}) }));
    });
    app.post<{ Params: { id: string } }>('/v1/plateforme/changements/:id/avis', async (req) => A.review(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
    app.post<{ Params: { id: string } }>('/v1/plateforme/changements/:id/execution', async (req) => A.execute(requireUser(req), req.params.id, parse(z.object({ result: z.enum(['SUCCES', 'ECHEC']), report: z.string().trim().min(5).max(4000) }).strict(), req.body)));

    // ── Module 55 : supervision, métriques, incidents, astreinte ──
    app.get('/v1/plateforme/metrics', async (req, reply) => {
      const token = process.env.MOSOLO_METRICS_TOKEN?.trim();
      const bearer = typeof req.headers.authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization)?.[1] : undefined;
      if (!(token && bearer && token.length >= 16 && safeEqualHex(sha256Hex(bearer), sha256Hex(token)))) {
        if (!req.user) throw unauthorized('AUTH_REQUIRED', 'Métriques : jeton de collecte (MOSOLO_METRICS_TOKEN) ou compte d’exploitation requis.');
        authorize(req.user, 'plateforme:supervision.read');
      }
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(S.prometheus());
    });
    app.get('/v1/plateforme/supervision', async (req) => {
      const user = requireUser(req);
      const plan = ctx.ext.planification as { probes?: { all(): { ok: boolean }[] } } | undefined;
      const probes = plan?.probes?.all();
      return S.view(user, probes && probes.length ? { total: probes.length, ok: probes.filter((p) => p.ok).length } : null);
    });
    app.post('/v1/plateforme/supervision/alertes', async (req) => { authorize(requireUser(req), 'plateforme:supervision.read'); return { evaluated: S.evaluateAlerts() }; });
    app.post('/v1/plateforme/supervision/phase', async (req) => S.setPhase(requireUser(req), parse(z.object({ phase: z.enum(Object.keys(RTO_HOURS) as [Phase, ...Phase[]]) }).strict(), req.body).phase));
    app.post('/v1/plateforme/astreintes', async (req, reply) => reply.code(201).send(S.addShift(requireUser(req), parse(z.object({ userId: z.string().max(80), level: z.enum(['PRINCIPAL', 'SECOURS']), from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).strict(), req.body))));
    app.post('/v1/plateforme/incidents', async (req, reply) => {
      const b = parse(z.object({ title: z.string().trim().min(5).max(200), service: z.string().trim().min(2).max(120), severity: z.enum(SEVERITIES), detectedAt: z.string().datetime({ offset: true }).optional(), deploymentId: z.string().max(40).optional() }).strict(), req.body);
      return reply.code(201).send(S.declare(requireUser(req), { title: b.title, service: b.service, severity: b.severity, ...(b.detectedAt ? { detectedAt: new Date(b.detectedAt).toISOString() } : {}), ...(b.deploymentId ? { deploymentId: b.deploymentId } : {}) }));
    });
    app.post<{ Params: { id: string } }>('/v1/plateforme/incidents/:id/etapes', async (req) => {
      const b = parse(z.object({ step: z.enum(['PRISE_EN_CHARGE', 'RETABLI', 'CLOS']), note: z.string().trim().min(5).max(2000), rootCause: z.string().trim().min(5).max(2000).optional(), postMortemSha256: sha.optional() }).strict(), req.body);
      return S.step(requireUser(req), req.params.id, { step: b.step, note: b.note, ...(b.rootCause ? { rootCause: b.rootCause } : {}), ...(b.postMortemSha256 ? { postMortemSha256: b.postMortemSha256 } : {}) });
    });
  },
});
