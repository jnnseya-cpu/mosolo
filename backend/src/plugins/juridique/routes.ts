/** Routes du registre des points juridiques, des fonctions conditionnées et de la gouvernance des données. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACR, requireAcr, requireUser } from '../../core/auth.js';
import { notFound } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { FONCTIONS_CONDITIONNEES, type FonctionConditionnee } from './points.js';
import type { JuridiqueService } from './service.js';

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const propositionBody = z.object({
  acte: z.object({
    reference: z.string().trim().min(3).max(200),
    titre: z.string().trim().min(3).max(300),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'empreinte SHA-256 de l’acte (64 caractères hexadécimaux)'),
  }).strict(),
  motif,
}).strict();
const decisionBody = z.object({ approve: z.boolean(), motif }).strict();
const purgeBody = z.object({ motif }).strict();

function fonctionCode(raw: string): FonctionConditionnee {
  const f = raw.toUpperCase().replace(/-/g, '_');
  if (!(f in FONCTIONS_CONDITIONNEES)) throw notFound('FONCTION_INCONNUE', `Fonction conditionnée inconnue : ${raw}`);
  return f as FonctionConditionnee;
}

export function registerJuridiqueRoutes(app: FastifyInstance, svc: JuridiqueService): void {
  // ── Points juridiques J1–J30, sept questions du § 6.4, 29 points de l'annexe B ──
  app.get('/v1/juridique/points', async (req) => svc.register(requireUser(req)));
  app.get<{ Params: { code: string } }>('/v1/juridique/points/:code', async (req) => {
    svc.register(requireUser(req)); // habilitation de lecture
    return svc.view(svc.definition(req.params.code));
  });
  app.post<{ Params: { code: string } }>('/v1/juridique/points/:code/propositions', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(propositionBody, req.body);
    svc.assertActe(body.acte);
    return reply.code(201).send(svc.proposeDecision(user, req.params.code, body));
  });
  app.post<{ Params: { code: string } }>('/v1/juridique/points/:code/decision', async (req) => {
    const user = requireUser(req);
    requireAcr(user, ACR.MFA); // trancher un point juridique : acte sensible
    return svc.decide(user, req.params.code, parse(decisionBody, req.body));
  });

  // ── Fonctions conditionnées : état public (aucune donnée personnelle), pour l'affichage « en attente de base légale » ──
  app.get('/v1/public/juridique/fonctions', async () => ({ items: (Object.keys(FONCTIONS_CONDITIONNEES) as FonctionConditionnee[]).map((f) => svc.fonction(f)) }));
  app.get<{ Params: { code: string } }>('/v1/public/juridique/fonctions/:code', async (req) => svc.fonction(fonctionCode(req.params.code)));

  // ── Gouvernance des données : classification C1–C5 et purge par durée de conservation ──
  app.get('/v1/juridique/donnees/classification', async (req) => svc.classification(requireUser(req)));
  app.get('/v1/juridique/donnees/purges', async (req) => svc.list(requireUser(req)));
  app.get('/v1/juridique/donnees/purges/apercu', async (req) => svc.apercuAs(requireUser(req)));
  app.post('/v1/juridique/donnees/purges', async (req, reply) => reply.code(201).send(svc.proposePurge(requireUser(req), parse(purgeBody, req.body))));
  app.post<{ Params: { id: string } }>('/v1/juridique/donnees/purges/:id/decision', async (req) => {
    const user = requireUser(req);
    requireAcr(user, ACR.MFA);
    return svc.decidePurge(user, req.params.id, parse(decisionBody, req.body));
  });
}
