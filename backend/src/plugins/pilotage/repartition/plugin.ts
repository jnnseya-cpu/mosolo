/**
 * Module d'extension « repartition » (pilotage, § 37A) : clé de répartition des recettes au statut ACTE_REQUIS,
 * simulation sur recettes rapprochées, activation sur acte enregistré et décision à deux personnes, décaissements
 * PROPOSÉS au Trésor (quatre yeux) — jamais automatiques.
 */
import { z } from 'zod';
import { CURRENCIES, type CurrencyCode } from '@mosolo/shared';
import { ACR, requireAcr, requireUser } from '../../../core/auth.js';
import { isoDateString, parse } from '../../../core/http.js';
import { definePolicy, GRANTS } from '../../../core/policy.js';
import type { TresorService } from '../../tresor/service.js';
import { definePlugin } from '../../types.js';
import { RepartitionService, type LegalActRecord } from './service.js';

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
const decisionSchema = z.object({ approve: z.boolean(), motif }).strict();
const currency = z.string().refine((c) => c in CURRENCIES, 'devise inconnue');
const reportQuery = z.object({ period: z.string().trim().max(7).optional(), currency: currency.optional() }).strict();
const proposalSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'mois AAAA-MM attendu'), currency, reason: motif }).strict();

export const repartitionPlugin = definePlugin<RepartitionService>({
  name: 'repartition',
  create: (ctx) => {
    const svc = new RepartitionService(ctx);
    // Le Trésor ne décaisse une répartition que par cette passerelle (clé ACTIVE, deux flux seulement).
    (ctx.ext.tresor as TresorService | undefined)?.attachRepartition(svc);
    return svc;
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
