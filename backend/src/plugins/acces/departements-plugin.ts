/**
 * Module d'extension « acces-departements » (27/09/2026) : référentiel des types de comptes, contrats de partenariat
 * (R32 à R34), inscription publique des mandataires (R31), catalogue des modules fonctionnels rattachables et
 * rattachements aux entités (§ 12A), menu reflétant les rattachements. Ajouté au module « acces » sans le modifier
 * (hors la garde « contrat de partenariat » de l'invitation et l'inscription du mandataire, ajoutées au service).
 */
import { LANGUAGE_CODES, type RoleCode } from '@mosolo/shared';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { isoDateString, parse } from '../../core/http.js';
import { definePlugin } from '../types.js';
import { DepartementsService } from './departements.js';
import type { AccesService } from './service.js';

const motif = z.string().trim().min(5, 'motif obligatoire').max(500);
const phone = z.string().regex(/^\+?[0-9 -]{9,20}$/, 'numéro de téléphone invalide');
const code6 = z.string().regex(/^\d{6}$/, 'code à 6 chiffres attendu');
type P = { Params: { id: string } };

/** Rattachements de démonstration (modules sans écran de menu : aucun effet sur les menus existants). */
const DEMO_LINKS: { moduleCode: string; entity: string; motif: string }[] = [
  { moduleCode: 'M36', entity: 'DGIPK', motif: 'Dossiers d’exécution instruits par la DGIPK (démonstration, non contractuel)' },
  { moduleCode: 'M43', entity: 'DGTK', motif: 'Tableau de bord de la régie des taxes (démonstration, non contractuel)' },
  { moduleCode: 'M44', entity: 'MINFIN', motif: 'Tableaux de bord ministériels — Finances (démonstration, non contractuel)' },
];

export const accesDepartementsPlugin = definePlugin<DepartementsService>({
  name: 'acces-departements',
  create: (ctx) => new DepartementsService(ctx, ctx.ext.acces as AccesService),
  seed: (ctx, svc) => {
    const acces = ctx.ext.acces as AccesService | undefined;
    if (!acces) return;
    const at = ctx.clock.now().toISOString();
    const day = at.slice(0, 10);
    DEMO_LINKS.forEach((l, i) => {
      if (!acces.entities.get(l.entity)) return;
      svc.links.insert({
        id: `LNK-DEMO-${String(i + 1).padStart(2, '0')}`, moduleCode: l.moduleCode, entity: l.entity, revenue: false, action: 'RATTACHEMENT', status: 'ACTIF', from: day,
        motif: l.motif, circuit: 'DIRECT', createdBy: 'u-superadmin', createdAt: at, history: [{ at, by: 'u-superadmin', action: 'RATTACHE', note: l.motif }], demo: true,
      });
    });
  },
  routes: (app, _ctx, svc) => {
    const acces = () => _ctx.ext.acces as AccesService;

    // ───────── Types de comptes ─────────
    app.get('/v1/acces/types-de-comptes', async (req) => svc.typesDeComptes(requireUser(req)));

    // ───────── Contrats de partenariat (R32 à R34) ─────────
    app.get('/v1/acces/contrats-partenaires', async (req) => ({ items: svc.listContracts(requireUser(req)) }));
    app.post('/v1/acces/contrats-partenaires', async (req, reply) => {
      const b = parse(z.object({
        entity: z.string().min(2).max(40), reference: z.string().trim().min(3).max(200), roles: z.array(z.enum(['R32', 'R33', 'R34'])).min(1).max(3),
        object: z.string().trim().min(5).max(500), validFrom: isoDateString.optional(), validTo: isoDateString.optional(),
      }).strict(), req.body);
      return reply.code(201).send(svc.proposeContract(requireUser(req), { ...b, roles: b.roles as RoleCode[] }));
    });
    app.post<P>('/v1/acces/contrats-partenaires/:id/decision', async (req) => svc.decideContract(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), note: motif }).strict(), req.body)));

    // ───────── Inscription publique du mandataire (R31) ─────────
    app.post('/v1/acces/mandataires/inscriptions', async (req, reply) => {
      const b = parse(z.object({
        fullName: z.string().trim().min(3).max(120), phone, kind: z.enum(['PERSONNE_PHYSIQUE', 'CABINET']).default('PERSONNE_PHYSIQUE'),
        language: z.enum(LANGUAGE_CODES as [string, ...string[]]).default('fr'),
      }).strict(), req.body);
      return reply.code(201).send(acces().registerMandataire(b));
    });
    app.post<P>('/v1/acces/mandataires/inscriptions/:id/verification', async (req) => {
      const b = parse(z.object({ challengeId: z.string().min(3).max(60), code: code6 }).strict(), req.body);
      return acces().verifyMandataire(req.params.id, b.challengeId, b.code);
    });

    // ───────── Catalogue et départements ─────────
    app.get('/v1/acces/catalogue-modules', async (req) => ({ items: svc.catalogue(requireUser(req)) }));
    app.get('/v1/acces/departements', async (req) => ({ items: svc.tree(requireUser(req)) }));
    app.get<{ Querystring: { entity?: string; module?: string } }>('/v1/acces/departements/liens', async (req) => {
      const q = parse(z.object({ entity: z.string().max(40).optional(), module: z.string().max(40).optional() }).strict(), req.query);
      return { items: svc.history(requireUser(req), { ...(q.entity ? { entity: q.entity } : {}), ...(q.module ? { moduleCode: q.module } : {}) }) };
    });
    app.post<P>('/v1/acces/departements/liens/:id/decision', async (req) => svc.decide(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), note: motif }).strict(), req.body)));
    app.get<P>('/v1/acces/departements/:id', async (req) => svc.entityView(requireUser(req), req.params.id));
    app.post<P>('/v1/acces/departements/:id/modules', async (req, reply) => {
      const b = parse(z.object({
        moduleCode: z.string().min(2).max(40), motif, from: isoDateString.optional(), to: isoDateString.optional(),
        actReference: z.string().trim().min(3).max(200).optional(), beneficiaryAliases: z.array(z.string().min(3)).max(5).optional(),
      }).strict(), req.body);
      return reply.code(201).send(svc.attach(requireUser(req), { ...b, entity: req.params.id }));
    });
    app.post<{ Params: { id: string; code: string } }>('/v1/acces/departements/:id/modules/:code/detachement', async (req) => {
      const b = parse(z.object({ motif, to: isoDateString.optional() }).strict(), req.body);
      return svc.detach(requireUser(req), { moduleCode: req.params.code, entity: req.params.id, motif: b.motif, ...(b.to ? { to: b.to } : {}) });
    });

    // ───────── Menu (présentation) ─────────
    app.get('/v1/acces/menu-rattachements', async (req) => svc.menuFor(requireUser(req)));
  },
});
