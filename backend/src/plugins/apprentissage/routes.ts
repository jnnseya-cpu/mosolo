/**
 * Routes HTTP du module d'apprentissage (§ 24). Corps validés strictement (champ inconnu ⇒ 400) : aucune mesure
 * d'activité (temps d'écran, clics, position…) ne peut être transmise.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { PROFILS, PROFILS_CERTIFIES, type ProfilCertifie } from './model.js';
import type { ApprentissageService } from './service.js';

type P = { Params: { id: string } };
const cle = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/i, 'clé d’écran ou d’action attendue (ex. terrain.habilitation)');
const texte = (max: number) => z.string().trim().min(3).max(max);
const question = z.object({ id: z.string().trim().min(1).max(20), enonce: texte(500), choix: z.array(texte(300)).min(2).max(6), bonne: z.number().int().min(0).max(5) }).strict();
const contenu = z.object({
  titre: texte(200), corps: texte(4000), lingala: z.object({ titre: texte(200), corps: texte(4000) }).strict().optional(),
  lecons: z.array(cle).max(20).optional(), epreuve: z.array(question).max(30).optional(), controlePratique: texte(1000).optional(),
}).strict();
const creation = contenu.extend({ type: z.enum(['FICHE', 'MODULE']), cle, publics: z.array(z.enum(PROFILS)).min(1) }).strict();
const profilCertifie = z.enum(PROFILS_CERTIFIES as [ProfilCertifie, ...ProfilCertifie[]]);
const evaluation = z.object({
  userId: z.string().trim().min(1).max(100), profil: profilCertifie, resultat: z.enum(['CONFORME', 'NON_CONFORME']).optional(),
  observations: texte(2000), references: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  echantillon: z.object({ taille: z.number().int().min(1).max(1000), conformes: z.number().int().min(0).max(1000) }).strict().optional(),
}).strict();
const motif = z.object({ motif: z.string().trim().min(5).max(2000) }).strict();

export function registerApprentissageRoutes(app: FastifyInstance, svc: ApprentissageService): void {
  // Aide contextuelle publiée : lecture libre (aucune donnée personnelle), utilisable sur les écrans publics.
  app.get<{ Params: { cle: string } }>('/v1/apprentissage/aide/:cle', async (req) => svc.aide(parse(cle, req.params.cle)));
  app.get('/v1/apprentissage/espace', async (req) => svc.espace(requireUser(req)));
  app.get('/v1/apprentissage/mes-certificats', async (req) => svc.mesCertificats(requireUser(req)));
  app.post<P>('/v1/apprentissage/modules/:id/epreuve', async (req) =>
    svc.soumettreEpreuve(requireUser(req), req.params.id, parse(z.object({ reponses: z.record(z.string(), z.number().int().min(0).max(5)) }).strict(), req.body).reponses));

  app.get('/v1/apprentissage/contenus', async (req) => svc.listeContenus(requireUser(req)));
  app.post('/v1/apprentissage/contenus', async (req, reply) => reply.code(201).send(svc.creerContenu(requireUser(req), parse(creation, req.body))));
  app.post<P>('/v1/apprentissage/contenus/:id/versions', async (req) => svc.nouvelleVersion(requireUser(req), req.params.id, parse(contenu, req.body)));
  app.post<P>('/v1/apprentissage/contenus/:id/publication/propose', async (req) => svc.proposerPublication(requireUser(req), req.params.id));
  app.post<P>('/v1/apprentissage/contenus/:id/publication/decision', async (req) =>
    svc.deciderPublication(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif: z.string().trim().min(5).max(2000) }).strict(), req.body)));

  app.get('/v1/apprentissage/certifications', async (req) => svc.registre(requireUser(req)));
  app.get<{ Params: { userId: string }; Querystring: { profil?: string } }>('/v1/apprentissage/certifications/:userId', async (req) =>
    svc.etat(requireUser(req), req.params.userId, parse(profilCertifie, req.query.profil)));
  app.post('/v1/apprentissage/evaluations', async (req, reply) => reply.code(201).send(svc.enregistrerEvaluation(requireUser(req), parse(evaluation, req.body))));
  app.get<{ Params: { userId: string } }>('/v1/apprentissage/echantillon/:userId', async (req) => svc.echantillon(requireUser(req), req.params.userId));
  app.post('/v1/apprentissage/certificats', async (req, reply) => {
    const b = parse(z.object({ userId: z.string().trim().min(1).max(100), profil: profilCertifie }).strict(), req.body);
    return reply.code(201).send(svc.delivrerCertificat(requireUser(req), b.userId, b.profil));
  });
  app.post<P>('/v1/apprentissage/certificats/:id/retrait', async (req) => svc.retirerCertificat(requireUser(req), req.params.id, parse(motif, req.body).motif));
  app.get('/v1/apprentissage/indicateurs', async (req) => svc.indicateurs(requireUser(req)));
}
