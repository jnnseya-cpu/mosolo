/**
 * Module d'extension « programme » (Document maître FR 2, ch. 41 à 48) : registre des risques, recette (critères
 * d'acceptation, carnet de récits, stratégie de tests et suivis du monde réel), plan de livraison par versions, plan
 * des 100 premiers jours, registre des décisions du Gouvernement provincial, exportation signée de la carte des écarts.
 * Voisin du module « planification » : il en réutilise le circuit des instructions sans le modifier.
 */
import { z } from 'zod';
import { ROLES, type RoleCode } from '@mosolo/shared';
import { ACR, requireAcr, requireUser } from '../../../core/auth.js';
import { isoDateString, parse } from '../../../core/http.js';
import { definePolicy, GRANTS } from '../../../core/policy.js';
import { definePlugin } from '../../types.js';
import { ETATS_ACTION, ETATS_SUIVI, ETATS_VERSION, IMPACTS, PROBABILITES, RISQUES_41, type EtatAction, type EtatSuivi, type EtatVersion, type Impact, type Probabilite } from './referentiels.js';
import { ProgrammeService, SUPERVISION } from './service.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
/** Lecture : direction, régies, juristes, Trésor, audit, exploitation et sécurité (aucune donnée personnelle). */
const LECTEURS: RoleCode[] = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28'];
const PROPRIETAIRES = [...new Set(RISQUES_41.map((r) => r.proprietaire))];

definePolicy('programme:read', g(LECTEURS));
/** Revue d'un risque : propriétaire désigné ou supervision (contrôle fin dans le service). */
definePolicy('programme:risque.revue', g([...new Set([...SUPERVISION, ...PROPRIETAIRES, 'R22' as RoleCode, 'R28' as RoleCode])]));
definePolicy('programme:risque.proprietaire', g(SUPERVISION));
/** Suivis du monde réel (recette utilisateur, test d'intrusion, charge, reprise) : programme, exploitation, sécurité, audit. */
definePolicy('programme:suivi.write', g(['R02', 'R03', 'R05', 'R22', 'R23', 'R26', 'R27', 'R28']));
definePolicy('programme:version.write', g(['R02', 'R03', 'R05', 'R27']));
definePolicy('programme:plan.write', g(['R01', 'R02', 'R03', 'R05']));
/** Décisions du Gouvernement : enregistrées par le cabinet, le secrétariat général ou les Finances ; validées par une autre personne. */
definePolicy('programme:decision.enregistrer', g(['R02', 'R03', 'R05']));
definePolicy('programme:decision.valider', g(['R01', 'R03', 'R05']));

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const sha = z.string().regex(/^[0-9a-fA-F]{64}$/, 'empreinte SHA-256 (64 caractères hexadécimaux)');
const preuve = z.object({ reference: z.string().trim().min(3).max(200), sha256: sha }).strict();
// Conversion justifiée : le raffinement garantit un code de rôle connu ; zod ne restreint pas le type littéral.
const role = z.string().refine((r) => r in ROLES, 'rôle inconnu') as unknown as z.ZodType<RoleCode>;
const revueSchema = z.object({
  probabilite: z.enum(Object.keys(PROBABILITES) as [Probabilite, ...Probabilite[]]), impact: z.enum(Object.keys(IMPACTS) as [Impact, ...Impact[]]), commentaire: motif,
}).strict();
const ownerSchema = z.object({ role, motif }).strict();
const suiviSchema = z.object({ etat: z.enum(Object.keys(ETATS_SUIVI) as [EtatSuivi, ...EtatSuivi[]]), motif, echeance: isoDateString.optional(), preuve: preuve.optional() }).strict();
const versionSchema = z.object({ etat: z.enum(Object.keys(ETATS_VERSION) as [EtatVersion, ...EtatVersion[]]), motif, preuve: preuve.optional() }).strict();
const startSchema = z.object({ debut: isoDateString, motif }).strict();
const actionSchema = z.object({ etat: z.enum(Object.keys(ETATS_ACTION) as [EtatAction, ...EtatAction[]]), note: motif, preuve: preuve.optional() }).strict();
const instructionSchema = z.object({ entity: z.string().regex(/^[A-Z0-9_-]{2,40}$/), role: z.string().regex(/^R\d{2}$/).optional() }).strict();
const acte = z.object({ reference: z.string().trim().min(3).max(200), titre: z.string().trim().min(3).max(300), date: isoDateString, sha256: sha }).strict();
const recordSchema = z.object({ statut: z.enum(['PRISE', 'REFUSEE']), acte: acte.optional(), motif }).strict();
const validateSchema = z.object({ approve: z.boolean(), motif }).strict();
const ecartsQuery = z.object({ annee: z.string().regex(/^\d{4}$/).optional() }).strict();

export const recetteProgrammePlugin = definePlugin<ProgrammeService>({
  name: 'recette-programme',
  create: (ctx) => new ProgrammeService(ctx),
  routes: (app, _ctx, svc) => {
    app.get('/v1/pilotage/programme', async (req) => svc.synthese(requireUser(req)));
    // Programme routier du Gouvernorat (30/09/2026) : km annoncés et recettes liées à la route mises en regard.
    app.get('/v1/pilotage/programme/routes', async (req) => svc.programmeRoutier(requireUser(req)));
    // ch. 41 — registre des risques
    app.get('/v1/pilotage/programme/risques', async (req) => svc.registreRisques(requireUser(req)));
    app.post<{ Params: { code: string } }>('/v1/pilotage/programme/risques/:code/revues', async (req, reply) => reply.code(201).send(svc.reviewRisk(requireUser(req), req.params.code, parse(revueSchema, req.body))));
    app.post<{ Params: { code: string } }>('/v1/pilotage/programme/risques/:code/proprietaire', async (req) => svc.designateOwner(requireUser(req), req.params.code, parse(ownerSchema, req.body)));
    // ch. 42, 43, 45 — recette
    app.get('/v1/pilotage/programme/recette', async (req) => svc.recette(requireUser(req)));
    app.post<{ Params: { code: string } }>('/v1/pilotage/programme/recette/suivis/:code', async (req) => svc.trackExternal(requireUser(req), req.params.code, parse(suiviSchema, req.body)));
    // ch. 44 — plan de livraison
    app.get('/v1/pilotage/programme/versions', async (req) => svc.planVersions(requireUser(req)));
    app.post<{ Params: { code: string } }>('/v1/pilotage/programme/versions/:code/etat', async (req) => svc.setVersionState(requireUser(req), req.params.code, parse(versionSchema, req.body)));
    // ch. 47 — 100 premiers jours
    app.get('/v1/pilotage/programme/cent-jours', async (req) => svc.centJours(requireUser(req)));
    app.post('/v1/pilotage/programme/cent-jours/demarrage', async (req) => svc.startPlan(requireUser(req), parse(startSchema, req.body)));
    app.post<{ Params: { id: string } }>('/v1/pilotage/programme/cent-jours/actions/:id/etat', async (req) => svc.setActionState(requireUser(req), req.params.id, parse(actionSchema, req.body)));
    app.post<{ Params: { id: string } }>('/v1/pilotage/programme/cent-jours/actions/:id/instruction', async (req, reply) => reply.code(201).send(svc.followWithInstruction(requireUser(req), req.params.id, parse(instructionSchema, req.body))));
    // ch. 48 — décisions du Gouvernement provincial
    app.get('/v1/pilotage/programme/decisions', async (req) => svc.registreDecisions(requireUser(req)));
    app.post<{ Params: { numero: string } }>('/v1/pilotage/programme/decisions/:numero/enregistrement', async (req, reply) => reply.code(201).send(svc.recordDecision(requireUser(req), req.params.numero, parse(recordSchema, req.body))));
    app.post<{ Params: { numero: string } }>('/v1/pilotage/programme/decisions/:numero/validation', async (req) => {
      const user = requireUser(req);
      requireAcr(user, ACR.MFA); // valider une décision du Gouvernement : acte sensible
      return svc.validateDecision(user, req.params.numero, parse(validateSchema, req.body));
    });
    // Récit 43-8 : exportation signée de la carte des écarts (vérifiable par POST /v1/pilotage/exports/verify).
    app.get('/v1/pilotage/assignations/ecarts/export', async (req) => svc.exportEcarts(requireUser(req), parse(ecartsQuery, req.query)));
  },
});

export { ProgrammeService } from './service.js';
