/**
 * Module d'extension « repartition » (pilotage, § 37A) : clé de répartition des recettes au statut ACTE_REQUIS,
 * simulation sur recettes rapprochées, activation sur acte enregistré et décision à deux personnes, décaissements
 * PROPOSÉS au Trésor (quatre yeux) ; une fois l'acte et la convention tripartite enregistrés (clé ACTIVE), les deux
 * flux sont EXÉCUTÉS AUTOMATIQUEMENT (décision du maître d'ouvrage du 27/09/2026), avec piste d'audit complète ; avant
 * l'acte, simulation quotidienne inscrite en comptes d'ordre du grand livre (module 59).
 */
import { z } from 'zod';
import { CURRENCIES, type CurrencyCode } from '@mosolo/shared';
import { ACR, requireAcr, requireUser } from '../../../core/auth.js';
import { isoDateString, parse } from '../../../core/http.js';
import { definePolicy, GRANTS } from '../../../core/policy.js';
import type { TresorService } from '../../tresor/service.js';
import { definePlugin } from '../../types.js';
import { PERIODICITES, RepartitionService, type LegalActRecord, type SettlementConvention } from './service.js';

const { always } = GRANTS;

/** Lecture : direction (Gouverneur, cabinet, secrétariat), Finances, validation financière, Trésor, audit, anti-fraude. */
definePolicy('repartition:read', {
  R01: always, R02: always, R03: always, R05: always, R15: always, R16: always, R17: always, R18: always, R22: always, R23: always, R24: always,
});
/** Enregistrement de l'acte juridique : juriste vérificateur ou autorité de publication. */
definePolicy('repartition:act.record', { R14: always, R16: always });
/** Proposition d'activation : ministre des Finances ou autorité de publication. */
definePolicy('repartition:activation.propose', { R05: always, R16: always });
/** Décision d'activation (seconde personne distincte) : Gouverneur, ministre des Finances ou autorité de publication. */
definePolicy('repartition:activation.decide', { R01: always, R05: always, R16: always });
/** Déclenchement manuel du traitement automatique (idempotent) : Trésor, validation financière, audit. */
definePolicy('repartition:automation.run', { R17: always, R18: always, R05: always, R22: always });

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const condition = z.string().trim().min(3).max(300);
const actSchema = z.object({
  instrumentId: z.string().trim().min(2).max(80),
  reference: z.string().trim().min(3).max(120),
  title: z.string().trim().min(5).max(300),
  nature: z.enum(['EDIT', 'ARRETE']),
  signedOn: isoDateString,
  documentSha256: sha256,
  conditions: z.object({ contratPpp: condition, conformiteLofip: condition, conventionTripartite: condition, traitementFiscal: condition }).partial().strict().default({}),
}).strict();
const proposeSchema = z.object({ motif }).strict();
const conventionSchema = z.object({
  reference: z.string().trim().min(3).max(120),
  bank: z.string().trim().min(2).max(200),
  signedOn: isoDateString,
  documentSha256: sha256,
  periodicite: z.enum(PERIODICITES as unknown as [string, ...string[]]),
  beneficiaries: z.array(z.object({ flow: z.string().trim().min(1).max(20), currency: z.string().refine((c) => c in CURRENCIES, 'devise inconnue'), alias: z.string().trim().min(3).max(80) }).strict()).min(2).max(8),
}).strict();
const decisionSchema = z.object({ approve: z.boolean(), motif }).strict();
const currency = z.string().refine((c) => c in CURRENCIES, 'devise inconnue');
const reportQuery = z.object({ period: z.string().trim().max(7).optional(), currency: currency.optional() }).strict();
const proposalSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'mois AAAA-MM attendu'), currency, reason: motif }).strict();

export const DEMO_FLOW_ACCOUNTS = [
  { alias: 'NSEYA-FLUX1-USD', entity: 'GROUPE_NSEYA', bankName: 'Banque de règlement (démo) [EXEMPLE]', accountNumber: 'CD00 0000 0000 0037 0001 0840', holderName: 'Groupe Nseya — Flux 1 (démo)', currency: 'USD' as const },
  { alias: 'NSEYA-FLUX1-CDF', entity: 'GROUPE_NSEYA', bankName: 'Banque de règlement (démo) [EXEMPLE]', accountNumber: 'CD00 0000 0000 0037 0001 0976', holderName: 'Groupe Nseya — Flux 1 (démo)', currency: 'CDF' as const },
  { alias: 'GVT-PROV-FLUX2-USD', entity: 'TRESOR', bankName: 'Banque de règlement (démo) [EXEMPLE]', accountNumber: 'CD00 0000 0000 0037 0002 0840', holderName: 'Gouvernement provincial — compte au Trésor, Flux 2 (démo)', currency: 'USD' as const },
  { alias: 'GVT-PROV-FLUX2-CDF', entity: 'TRESOR', bankName: 'Banque de règlement (démo) [EXEMPLE]', accountNumber: 'CD00 0000 0000 0037 0002 0976', holderName: 'Gouvernement provincial — compte au Trésor, Flux 2 (démo)', currency: 'CDF' as const },
];

export const repartitionPlugin = definePlugin<RepartitionService>({
  name: 'repartition',
  create: (ctx) => {
    const svc = new RepartitionService(ctx);
    // Le Trésor ne décaisse une répartition que par cette passerelle (clé ACTIVE, deux flux seulement).
    (ctx.ext.tresor as TresorService | undefined)?.attachRepartition(svc);
    // Traitement quotidien (simulation en comptes d'ordre, ou exécution automatique après acte et convention) :
    // MOSOLO_REPARTITION_TICK_MS (défaut : 1 h ; 0 = désactivé). Idempotent : chaque période n'est traitée qu'une fois.
    const every = Number.parseInt(process.env.MOSOLO_REPARTITION_TICK_MS ?? '3600000', 10);
    if (Number.isFinite(every) && every >= 60_000) svc.startScheduler(every);
    return svc;
  },
  // Comptes bénéficiaires des deux flux au coffre (numéros FICTIFS, [EXEMPLE] non contractuels) : la convention
  // tripartite désigne ces alias verrouillés ; aucun numéro de compte n'est jamais saisi dans la répartition.
  seed: (ctx) => {
    for (const a of DEMO_FLOW_ACCOUNTS) if (!ctx.vault.aliasExists(a.alias)) ctx.vault.seedAccount(a);
  },
  routes: (app, _ctx, svc) => {
    app.get('/v1/pilotage/repartition', async (req) => {
      const q = parse(reportQuery, req.query);
      return svc.report(requireUser(req), { ...(q.period ? { period: q.period } : {}), ...(q.currency ? { currency: q.currency } : {}) });
    });
    app.get('/v1/pilotage/repartition/cle', async (req) => svc.view(requireUser(req)));
    app.get('/v1/pilotage/repartition/distributions', async (req) => {
      const user = requireUser(req);
      svc.view(user);
      return { items: svc.listDistributions() };
    });
    app.post<{ Params: { id: string } }>('/v1/pilotage/repartition/cles/:id/acte', async (req) => {
      const body = parse(actSchema, req.body) as Omit<LegalActRecord, 'recordedBy' | 'recordedAt'>;
      return svc.recordAct(requireUser(req), req.params.id, body);
    });
    app.post<{ Params: { id: string } }>('/v1/pilotage/repartition/cles/:id/convention', async (req) => {
      const body = parse(conventionSchema, req.body) as Omit<SettlementConvention, 'recordedBy' | 'recordedAt'>;
      return svc.recordConvention(requireUser(req), req.params.id, body);
    });
    app.get('/v1/pilotage/repartition/automatisation', async (req) => {
      svc.view(requireUser(req));
      return svc.automation();
    });
    app.post('/v1/pilotage/repartition/automatisation/executer', async (req) => svc.runAutomatic(requireUser(req)));
    app.post<{ Params: { id: string } }>('/v1/pilotage/repartition/cles/:id/activation', async (req, reply) =>
      reply.code(202).send(svc.proposeActivation(requireUser(req), req.params.id, parse(proposeSchema, req.body).motif)));
    app.post<{ Params: { id: string } }>('/v1/pilotage/repartition/cles/:id/activation/decision', async (req) => {
      const user = requireUser(req);
      requireAcr(user, ACR.MFA); // acte sensible : effet sur la répartition des recettes publiques pendant 30 ans
      return svc.decideActivation(user, req.params.id, parse(decisionSchema, req.body));
    });
    app.post('/v1/pilotage/repartition/propositions', async (req, reply) => {
      const body = parse(proposalSchema, req.body);
      return reply.code(201).send(svc.propose(requireUser(req), { period: body.period, currency: body.currency as CurrencyCode, reason: body.reason }));
    });
  },
});

export { RepartitionService } from './service.js';
