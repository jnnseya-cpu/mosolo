/**
 * Traduction automatique (30/09/2026) : `GET /v1/traduction/etat` et `POST /v1/traduction` (publics : visiteurs et
 * comptes ; seuls des textes d'interface sont envoyés, limités en nombre et en taille, avec un débit par adresse).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { LANGUES_TRADUITES, type TraductionService } from './service.js';

const schema = z.object({
  langue: z.enum(LANGUES_TRADUITES),
  textes: z.array(z.string().min(1).max(1000)).min(1).max(150),
}).strict();

export function registerTraductionRoutes(app: FastifyInstance, svc: TraductionService): void {
  const debit = new Map<string, { n: number; depuis: number }>();
  app.get('/v1/traduction/etat', async () => svc.etat());
  app.post('/v1/traduction', async (req) => {
    const body = parse(schema, req.body);
    if (body.textes.reduce((n, t) => n + t.length, 0) > 30_000) throw new ApiError(413, 'TROP_DE_TEXTE', 'Trop de texte dans une seule demande.');
    const ip = req.ip ?? 'inconnu';
    const now = Date.now();
    const d = debit.get(ip);
    if (!d || now - d.depuis > 60_000) debit.set(ip, { n: 1, depuis: now });
    else if (++d.n > 120) throw new ApiError(429, 'TROP_DE_DEMANDES', 'Trop de demandes de traduction : réessayez dans une minute.');
    if (!svc.disponible) throw new ApiError(503, 'TRADUCTION_INDISPONIBLE', 'Traduction automatique non configurée : l’interface reste en français.');
    try {
      return { langue: body.langue, traductions: await svc.traduire(body.textes, body.langue), mention: 'Traduction automatique — la version française fait foi.' };
    } catch {
      throw new ApiError(502, 'TRADUCTION_ECHEC', 'Service de traduction momentanément indisponible : l’interface reste en français.');
    }
  });
}
