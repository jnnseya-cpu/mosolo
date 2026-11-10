/** Routes du référentiel des recettes (préfixe /v1/referentiel ; lecture publique sous /v1/public/referentiel). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INVENTORY_ATTRIBUTES, REVENUE_REFERENCE, type InventoryKey } from '@mosolo/shared';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import type { ReferentielService } from './service.js';
import { authorize } from '../../core/policy.js';
import { dataModelView } from './modele-donnees.js';
import { roleMatrixView } from './matrice-roles.js';

const keys = INVENTORY_ATTRIBUTES.map((a) => a.key) as [InventoryKey, ...InventoryKey[]];

export function registerReferentielRoutes(app: FastifyInstance, svc: ReferentielService): void {
  // Transparence : lignes de recettes, compétences et statuts (aucune donnée d'inventaire interne, aucun taux).
  app.get('/v1/public/referentiel/recettes', async () => ({
    items: REVENUE_REFERENCE.map((l) => svc.publicLine(l)),
    administrative: svc.administrative(),
    spaces: svc.spaces().map((s) => ({ id: s.id, label: s.label, active: s.active, note: s.note })),
    notice: 'Toutes les lignes sont au statut A_VERIFIER : aucune n’est exigible sans règle ACTIVE du registre (quatre visas).',
  }));

  app.get('/v1/referentiel/recettes', async (req) => ({ items: svc.lines(requireUser(req)) }));

  // Document maître FR 2 (nouvelle version) : modèle de données conceptuel (ch. 30) et matrice d'habilitations (ch. 12),
  // évalués en direct (états réellement portés par le code, effectifs sans donnée personnelle ; interdits refusés).
  app.get('/v1/referentiel/modele-donnees', async (req) => {
    authorize(requireUser(req), 'referentiel:conformite.read');
    return dataModelView(svc.ctx);
  });
  app.get('/v1/referentiel/matrice-habilitations', async (req) => {
    authorize(requireUser(req), 'referentiel:conformite.read');
    return roleMatrixView();
  });
  app.get<{ Params: { code: string } }>('/v1/referentiel/recettes/:code', async (req) => {
    const user = requireUser(req);
    const line = svc.lines(user).find((l) => l.code === req.params.code);
    if (!line) svc.line(req.params.code);
    return { ...line, history: svc.inventory.get(req.params.code)?.history ?? [] };
  });
  app.post<{ Params: { code: string } }>('/v1/referentiel/recettes/:code/inventaire', async (req) => {
    const body = parse(z.object({ key: z.enum(keys), value: z.string().trim().min(1).max(500), source: z.string().trim().min(3).max(300) }).strict(), req.body);
    return svc.updateInventory(requireUser(req), req.params.code, body);
  });
  app.get('/v1/referentiel/base-de-reference', async (req) => svc.baseline(requireUser(req)));
  app.get('/v1/referentiel/recettes-administratives', async (req) => {
    requireUser(req);
    return { items: svc.administrative() };
  });
  app.get('/v1/referentiel/espaces', async () => ({ items: svc.spaces() }));

  // Registre des codes stables et non réutilisables (§ 6.2).
  app.get('/v1/referentiel/codes', async (req) => ({ items: svc.listCodes(requireUser(req)) }));
  app.post('/v1/referentiel/codes', async (req, reply) => {
    const body = parse(z.object({ code: z.string().trim().min(3).max(40), label: z.string().trim().min(3).max(200) }).strict(), req.body);
    return reply.code(201).send(svc.reserveCode(requireUser(req), body));
  });
  app.post<{ Params: { code: string } }>('/v1/referentiel/codes/:code/retrait', async (req) => {
    const body = parse(z.object({ motif: z.string().trim().min(5).max(2000) }).strict(), req.body);
    return svc.retireCode(requireUser(req), req.params.code, body.motif);
  });
}
