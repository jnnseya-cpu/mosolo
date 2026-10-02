/**
 * Module d'extension « partage-legal » (§ 27.1, § 29.2, § 30.6, § 10A.3) : clés légales de partage entre province,
 * ETD et pouvoir central, fiches versionnées du registre juridique (A_VERIFIER tant que non certifiées), calcul sur
 * recettes rapprochées et comptabilisées, vue par entité ; registre des cadres d'incitation de performance.
 * Distinct de la clé du § 37A (module « repartition », inchangé). Aucun virement, aucun versement.
 */
import { z } from 'zod';
import { requireUser } from '../../../core/auth.js';
import { parse } from '../../../core/http.js';
import { definePolicy, GRANTS } from '../../../core/policy.js';
import { definePlugin } from '../../types.js';
import { LEGAL_SHARE_READERS, PartageLegalService } from './service.js';

const { always, inTerritory } = GRANTS;
definePolicy('legalshares:read', { ...Object.fromEntries(LEGAL_SHARE_READERS.map((r) => [r, always])), R08: inTerritory('minimal') });
/** Calcul : Finances, validation financière, Trésor et analyste de rapprochement. */
definePolicy('legalshares:calculate', { R05: always, R15: always, R17: always, R18: always });
definePolicy('legalshares:incentive.record', { R05: always, R15: always, R13: always });
definePolicy('legalshares:incentive.act', { R14: always, R16: always });

const period = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2])|-T[1-4])?$/, 'AAAA, AAAA-MM ou AAAA-Tn attendu');
const calcSchema = z.object({ period }).strict();
const t = (min: number, max: number) => z.string().trim().min(min).max(max);
const incentiveSchema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{3,40}$/), label: t(3, 200), legalBasis: t(5, 500), approvedFormula: t(3, 1000), conditions: t(3, 1000), cap: t(1, 300),
  antiGamingControl: t(5, 1000), taxTreatment: t(3, 500), approvalCircuit: t(5, 500), accounting: t(3, 500),
}).strict();
const actSchema = z.object({ reference: t(3, 200) }).strict();

export const partageLegalPlugin = definePlugin<PartageLegalService>({
  name: 'partage-legal',
  create: (ctx) => new PartageLegalService(ctx),
  routes: (app, _ctx, svc) => {
    app.get('/v1/legal-shares', async (req) => svc.list(requireUser(req)));
    app.get('/v1/legal-shares/keys', async (req) => svc.keysView(requireUser(req)));
    app.get<{ Params: { id: string } }>('/v1/legal-shares/calculations/:id', async (req) => svc.get(requireUser(req), req.params.id));
    // Nom du Cahier : POST /v1/legal-shares:calculate (deux-points littéral, échappé) ; alias sans deux-points.
    const calculate = async (req: { body: unknown; user?: unknown } & Parameters<typeof requireUser>[0], reply: { code(n: number): { send(x: unknown): unknown } }) =>
      reply.code(201).send(svc.calculate(requireUser(req), parse(calcSchema, req.body)));
    app.post('/v1/legal-shares::calculate', calculate);
    app.post('/v1/legal-shares/calculate', calculate);
    app.get('/v1/legal-shares/incitations', async (req) => svc.incentivesView(requireUser(req)));
    app.post('/v1/legal-shares/incitations', async (req, reply) => reply.code(201).send(svc.recordIncentive(requireUser(req), parse(incentiveSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/legal-shares/incitations/:id/acte', async (req) => svc.recordIncentiveAct(requireUser(req), req.params.id, parse(actSchema, req.body).reference));
  },
});
