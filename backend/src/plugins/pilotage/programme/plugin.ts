/**
 * Module d'extension « programme » (pilotage, à côté de la planification) : feuille de route de mise en œuvre
 * (Cahier nouvelle version ch. 35), modèle opérationnel (ch. 36) et gouvernance du programme (ch. 37).
 * Politiques refusées par défaut ; toute écriture est journalisée ; les portes de phase sont décidées par une
 * personne distincte du demandeur, membre du comité de pilotage, sur une réunion consignée.
 */
import { z } from 'zod';
import type { RoleCode } from '@mosolo/shared';
import { requireUser } from '../../../core/auth.js';
import { isoDateString, parse } from '../../../core/http.js';
import { definePolicy, GRANTS } from '../../../core/policy.js';
import { definePlugin } from '../../types.js';
import { ACTION_STATUSES, BODIES, BODY_CODES, FUNCTION_CODES } from './model.js';
import { ProgrammeService } from './service.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
/** Lecteurs : tableaux de pilotage, validation financière, juristes, protection des données, sécurité, observateur. */
const READERS: RoleCode[] = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R13', 'R14', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28', 'R36'];
definePolicy('planification:programme.read', g(READERS));
/** Direction de programme (rattachée au ministère provincial des Finances), Cabinet, SG, direction de régie. */
definePolicy('planification:programme.write', g(['R02', 'R03', 'R05', 'R06']));
definePolicy('planification:programme.gate.request', g(['R02', 'R03', 'R05', 'R06']));
/** Comité de pilotage : mêmes rôles que acces:module.activate (Gouverneur, Cabinet, ministre des Finances). */
definePolicy('planification:programme.gate.decide', g(['R01', 'R02', 'R05']));
/** Secrétariats des cinq instances (contrôle fin par instance dans le service). */
definePolicy('planification:programme.meeting.record', g([...new Set(BODIES.flatMap((b) => b.secretariat))] as RoleCode[]));

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const sha = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 hexadécimale attendue');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const proof = z.object({ reference: text(3, 200), sha256: sha }).strict();
const startSchema = z.object({ startDate: isoDateString, motif }).strict();
const phaseStartSchema = z.object({ motif }).strict();
const proofSchema = z.object({ livrable: z.string().regex(/^P\d-L\d{1,2}$/), reference: text(3, 200), sha256: sha, note: text(3, 1000).optional() }).strict();
const gateSchema = z.object({ proofIds: z.array(z.string().max(60)).min(1).max(200), motif }).strict();
const decisionSchema = z.object({ approve: z.boolean(), motif, meetingId: z.string().min(3).max(60) }).strict();
const actionSchema = z.object({ owner: text(2, 200).optional(), status: z.enum(ACTION_STATUSES).optional(), proof: proof.optional(), note: text(3, 1000).optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, 'au moins un champ attendu');
const postSchema = z.object({ functionCode: z.enum(FUNCTION_CODES as [string, ...string[]]), roleLabel: text(3, 200), holderLabel: text(3, 200).optional(), external: z.boolean().optional() }).strict();
const pairSchema = z.object({
  agentLabel: text(3, 200), agentUserId: z.string().max(80).optional(), motif,
  calendar: z.array(z.object({ label: text(3, 300), dueDate: isoDateString }).strict()).min(1).max(50),
}).strict();
const meetingSchema = z.object({
  body: z.enum(BODY_CODES as [string, ...string[]]), date: isoDateString, attendees: z.array(text(2, 200)).min(1).max(60), agenda: z.array(text(3, 500)).min(1).max(50),
  minutes: proof, decisions: z.array(text(3, 1000)).max(100), ruleVersionIds: z.array(z.string().max(80)).max(200).optional(),
}).strict();

export const programmePlugin = definePlugin<ProgrammeService>({
  name: 'programme',
  create: (ctx) => new ProgrammeService(ctx),
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, _ctx, svc) => {
    // Feuille de route (ch. 35) : phases, portes de sortie, plans d'action datés
    app.get('/v1/pilotage/feuille-de-route', async (req) => svc.roadmapView(requireUser(req)));
    app.post('/v1/pilotage/feuille-de-route/demarrage', async (req) => svc.setStartDate(requireUser(req), parse(startSchema, req.body)));
    app.post<{ Params: { code: string } }>('/v1/pilotage/feuille-de-route/phases/:code/demarrage', async (req) => svc.startPhase(requireUser(req), req.params.code, parse(phaseStartSchema, req.body).motif));
    app.post<{ Params: { code: string } }>('/v1/pilotage/feuille-de-route/phases/:code/preuves', async (req, reply) => reply.code(201).send(svc.addProof(requireUser(req), req.params.code, parse(proofSchema, req.body))));
    app.post<{ Params: { code: string } }>('/v1/pilotage/feuille-de-route/phases/:code/porte', async (req, reply) => reply.code(201).send(svc.requestGate(requireUser(req), req.params.code, parse(gateSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/pilotage/feuille-de-route/portes/:id/decision', async (req) => svc.decideGate(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
    app.post<{ Params: { code: string } }>('/v1/pilotage/feuille-de-route/actions/:code', async (req) => svc.updateAction(requireUser(req), req.params.code, parse(actionSchema, req.body)));
    // Modèle opérationnel (ch. 36) : postes, binômes, calendrier de transfert
    app.get('/v1/pilotage/modele-operationnel', async (req) => svc.operatingModelView(requireUser(req)));
    app.post('/v1/pilotage/modele-operationnel/postes', async (req, reply) => reply.code(201).send(svc.createPost(requireUser(req), parse(postSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/pilotage/modele-operationnel/postes/:id/binome', async (req) => svc.designatePair(requireUser(req), req.params.id, parse(pairSchema, req.body)));
    app.post<{ Params: { id: string; jalon: string } }>('/v1/pilotage/modele-operationnel/postes/:id/jalons/:jalon', async (req) => svc.completeMilestone(requireUser(req), req.params.id, req.params.jalon, parse(proof, req.body)));
    // Gouvernance du programme (ch. 37) : instances et réunions consignées
    app.get('/v1/pilotage/gouvernance', async (req) => svc.governanceView(requireUser(req)));
    app.post('/v1/pilotage/gouvernance/reunions', async (req, reply) => reply.code(201).send(svc.recordMeeting(requireUser(req), parse(meetingSchema, req.body))));
  },
});

export { ProgrammeService } from './service.js';
