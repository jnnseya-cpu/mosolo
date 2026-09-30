/**
 * Routes de la chaîne véhicule : contrôle technique et vignette sécurisée (/v1/vehicules), fourrières (/v1/fourrieres),
 * centres agréés (/v1/centres-agrees), raccordement RFCK et domaine officiel (/v1/rfck), vérifications publiques
 * (/v1/public/…). Toute route authentifiée appelle le point de décision des politiques ; chaque action est journalisée.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { ApiError } from '../../core/errors.js';
import { isoDateString, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { CENTRE_ACTIVITIES, CENTRE_KINDS, CT_POINTS, INTEGRATION_STEPS, INTERFACE_FLOWS, VEHICLE_CATEGORIES, type FlowCode, type StepCode } from './model.js';
import type { VehiculesControleService } from './service.js';

const t = (min: number, max: number) => z.string().trim().min(min).max(max);
const category = z.enum(VEHICLE_CATEGORIES);
const photo = z.object({ slot: t(1, 30), imageBase64: z.string().min(4).max(1_300_000), sha256: z.string().regex(/^[0-9a-fA-F]{64}$/), lat: z.number().min(-90).max(90).optional(), lon: z.number().min(-180).max(180).optional() }).strict();
const gps = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000).optional() }).strict();
const place = z.object({ commune: t(1, 60).optional(), lat: z.number().min(-90).max(90).optional(), lon: z.number().min(-180).max(180).optional() }).strict();
const hours = z.object({ open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/) }).strict();
const quotas = z.object({ stockVignettes: z.number().int().min(0).max(1_000_000), inspectionsParJour: z.number().int().min(0).max(10_000) }).strict();
const decision = z.object({ approve: z.boolean(), motif: t(3, 1000) }).strict();

const pvSchema = z.object({
  centreId: t(3, 60), plate: t(3, 20), category, inspecteur: t(2, 60), startedAt: z.string().datetime(), endedAt: z.string().datetime(),
  points: z.record(z.string(), z.object({ conforme: z.boolean(), note: t(1, 500).optional() }).strict()), result: z.enum(['FAVORABLE', 'DEFAVORABLE']), echeance: isoDateString,
  supersedes: t(3, 60).optional(), rectificationReason: t(3, 500).optional(),
}).strict();
// Aucun champ de montant, de remise ni d'encaissement : le schéma strict refuse toute saisie de ce type.
const constatSchema = z.object({ plate: t(3, 20), motifLegal: t(3, 500), commune: t(2, 60), etat: t(3, 1000), gps: gps.optional(), photos: z.array(photo).max(5) }).strict();
const removalSchema = z.object({ motifLegal: t(3, 500), legalBasis: t(3, 500), source: z.object({ kind: z.enum(['DECISION_AUTORITE', 'CONSTAT_STATIONNEMENT', 'RECOUVREMENT']), ref: t(1, 120) }).strict(), origine: t(1, 40).optional() }).strict();
const entrySchema = z.object({
  siteId: t(2, 40), photos: z.array(photo).max(5), conditionReport: t(1, 2000), inventory: z.array(z.object({ label: t(1, 120), quantity: z.number().int().min(0).max(1000) }).strict()).max(100),
  contradictoire: z.object({ kind: z.enum(['PROPRIETAIRE_PRESENT', 'TEMOIN']), ref: t(1, 120) }).strict(),
}).strict();
const exitSchema = z.object({ receipt: t(3, 400).optional(), photos: z.array(photo).max(5), collector: z.object({ pieceType: t(2, 40), pieceNumber: t(3, 60), qualite: t(2, 80) }).strict() }).strict();
const disposalSchema = z.object({
  kind: z.enum(['VENTE', 'DESTRUCTION']), authorityDecisionRef: t(3, 200), legalBasis: t(3, 500), motif: t(3, 1000),
  notification: z.object({ sentAt: z.string().datetime(), receivedAt: z.string().datetime(), proofSha256: z.string() }).strict(), appealDeadline: isoDateString, origine: t(1, 40).optional(),
}).strict();

/** Limiteur simple des vérifications publiques (anti-énumération) : fenêtre d'une minute par client. */
function publicLimiter(max = 30) {
  const hits = new Map<string, { at: number; n: number }>();
  return (req: FastifyRequest) => {
    const k = `ip:${req.ip || 'inconnu'}`;
    const now = Date.now();
    const h = hits.get(k);
    if (!h || now - h.at > 60_000) { hits.set(k, { at: now, n: 1 }); return; }
    h.n++;
    if (h.n > max) throw new ApiError(429, 'TROP_DE_VERIFICATIONS', 'Trop de vérifications : réessayez dans une minute.');
  };
}

export function registerVehiculesRoutes(app: FastifyInstance, s: VehiculesControleService): void {
  const U = (req: FastifyRequest) => requireUser(req);
  const limit = publicLimiter();

  // ——— Référentiel, indicateurs, lignes de recettes ———
  app.get('/v1/vehicules/referentiel', async (req) => { const u = U(req); authorize(u, 'vc:read'); return s.referentiel(); });
  app.get('/v1/vehicules/indicateurs', async (req) => s.indicators(U(req)));
  app.get<{ Params: { plaque: string } }>('/v1/vehicules/:plaque/lignes-de-recettes', async (req) => s.revenueLines(U(req), req.params.plaque));
  app.get<{ Params: { plaque: string } }>('/v1/vehicules/:plaque/controle-technique', async (req) => { authorize(U(req), 'vc:read'); return s.ct.status(req.params.plaque); });

  // ——— Procès-verbaux, échéances ———
  app.post('/v1/vehicules/controles-techniques', async (req, reply) => reply.code(201).send(s.ct.submitPv(U(req), parse(pvSchema, req.body))));
  app.get<{ Querystring: { plaque?: string; centre?: string } }>('/v1/vehicules/controles-techniques', async (req) => ({ items: s.ct.listPvs(U(req), { ...(req.query.plaque ? { plate: req.query.plaque } : {}), ...(req.query.centre ? { centreId: req.query.centre } : {}) }), points: CT_POINTS }));
  app.post('/v1/vehicules/controles-techniques/rappels', async (req) => s.ct.runReminders(U(req)));

  // ——— Vignettes sécurisées ———
  app.post('/v1/vehicules/vignettes-securisees/lots', async (req, reply) => reply.code(201).send(s.ct.issueLot(U(req), parse(z.object({ centreId: t(3, 60), quantity: z.number().int().min(1).max(10_000) }).strict(), req.body))));
  app.get<{ Querystring: { centre?: string } }>('/v1/vehicules/vignettes-securisees', async (req) => {
    const u = U(req);
    const mine = u.roles.includes('R34');
    authorize(u, mine ? 'vc:sticker.assign' : 'vc:read');
    const scope = mine ? u.entity : req.query.centre;
    return { items: s.ct.stickers.all().filter((x) => !scope || x.centreId === scope), lots: s.ct.lots.all().filter((x) => !scope || x.centreId === scope) };
  });
  app.post<{ Params: { numero: string } }>('/v1/vehicules/vignettes-securisees/:numero/attribution', async (req) => s.ct.assignSticker(U(req), { number: req.params.numero, ...parse(z.object({ pvId: t(3, 60) }).strict(), req.body) }));
  app.post<{ Params: { numero: string } }>('/v1/vehicules/vignettes-securisees/:numero/annulation', async (req) => s.ct.cancelSticker(U(req), req.params.numero, parse(z.object({ motif: t(3, 500) }).strict(), req.body).motif, 'ANNULEE'));
  app.post<{ Params: { numero: string } }>('/v1/vehicules/vignettes-securisees/:numero/revocation', async (req) => s.ct.cancelSticker(U(req), req.params.numero, parse(z.object({ motif: t(3, 500) }).strict(), req.body).motif, 'REVOQUEE'));
  app.get('/v1/vehicules/vignettes-securisees/revocations', async (req) => { const u = U(req); if (!u.roles.some((r) => ['R09', 'R10', 'R11'].includes(r))) authorize(u, 'vc:read'); return s.ct.revocationList(); });

  // ——— Mode courtoisie ———
  app.get('/v1/vehicules/courtoisie', async (req) => { authorize(U(req), 'vc:read'); return { items: s.ct.courtesy.all(), phases2026: s.referentiel().phases2026 }; });
  app.post('/v1/vehicules/courtoisie', async (req, reply) => reply.code(201).send(s.ct.decideCourtesy(U(req), parse(z.object({ categories: z.array(category).max(8), communes: z.array(t(2, 60)).max(24), from: isoDateString, to: isoDateString, authority: t(3, 200), decisionRef: t(3, 200), reason: t(3, 1000) }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/vehicules/courtoisie/:id/fin', async (req) => s.ct.endCourtesy(U(req), req.params.id, parse(z.object({ motif: t(3, 500) }).strict(), req.body).motif));

  // ——— Scan unique ———
  app.post('/v1/vehicules/scan', async (req) => s.scan.scan(U(req), parse(z.object({ saisie: t(3, 2000), place, deviceId: t(1, 80).optional() }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/vehicules/scans/:id/decision', async (req, reply) => reply.code(201).send(s.scan.decide(U(req), req.params.id, parse(z.object({ decision: z.enum(['AUCUNE_SUITE', 'INFORMATION_USAGER', 'CONSTAT_A_INSTRUIRE']), motif: t(3, 1000), position: place }).strict(), req.body))));
  app.get('/v1/vehicules/hors-ligne/paquet', async (req) => s.scan.offlinePack(U(req)));

  // ——— Couche usager ———
  app.get('/v1/vehicules/mes-vehicules', async (req) => s.myVehicles(U(req)));
  app.post('/v1/vehicules/rendez-vous', async (req, reply) => reply.code(201).send(s.ct.book(U(req), parse(z.object({ plate: t(3, 20), centreId: t(3, 60), date: isoDateString }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/vehicules/rendez-vous/:id/confirmation', async (req) => s.ct.appointmentView(s.ct.confirmAppointment(U(req), req.params.id)));
  app.get('/v1/vehicules/rendez-vous', async (req) => {
    const u = U(req);
    if (u.roles.includes('R34')) { authorize(u, 'vc:appointment.confirm'); return { items: s.ct.appointments.find((a) => a.centreId === u.entity).map((a) => s.ct.appointmentView(a)) }; }
    authorize(u, 'vc:vehicle.own', { ...(u.taxpayerId ? { taxpayerId: u.taxpayerId } : {}) });
    return { items: s.ct.appointments.find((a) => a.taxpayerId === u.taxpayerId).map((a) => s.ct.appointmentView(a)) };
  });

  // ——— Fourrières ———
  app.get('/v1/fourrieres/sites', async (req) => { authorize(U(req), 'fourriere:read'); return { items: s.fourriere.sites.all().map((x) => ({ ...x, occupancy: s.fourriere.occupancy(x.id) })) }; });
  app.post('/v1/fourrieres/sites', async (req, reply) => reply.code(201).send(s.fourriere.createSite(U(req), parse(z.object({ name: t(3, 120), commune: t(2, 60), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), capacity: z.number().int().min(1).max(100_000), operatorCentreId: t(3, 60).optional() }).strict(), req.body))));
  app.get<{ Querystring: { statut?: string; plaque?: string } }>('/v1/fourrieres/dossiers', async (req) => ({ items: s.fourriere.list(U(req), { ...(req.query.statut ? { status: req.query.statut } : {}), ...(req.query.plaque ? { plate: req.query.plaque } : {}) }) }));
  app.get<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id', async (req) => s.fourriere.getView(U(req), req.params.id));
  app.post('/v1/fourrieres/constats', async (req, reply) => reply.code(201).send(s.fourriere.constat(U(req), parse(constatSchema, req.body))));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/decision-enlevement', async (req) => s.fourriere.decideRemoval(U(req), req.params.id, parse(removalSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/entree', async (req) => s.fourriere.entry(U(req), req.params.id, parse(entrySchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/ecritures-contraires', async (req, reply) => reply.code(201).send(s.fourriere.proposeCorrection(U(req), req.params.id, parse(z.object({ field: z.enum(['entryAt', 'exitAt']), to: z.string().datetime(), reason: t(5, 1000) }).strict(), req.body))));
  app.post<{ Params: { id: string; cid: string } }>('/v1/fourrieres/dossiers/:id/ecritures-contraires/:cid/decision', async (req) => s.fourriere.decideCorrection(U(req), req.params.id, req.params.cid, parse(decision, req.body)));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/liquidation', async (req) => s.fourriere.liquidate(U(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/encaissement', async (req) => s.fourriere.refuseCash(U(req), req.params.id, (req.body && typeof req.body === 'object' ? req.body : {}) as { amount?: string; note?: string }));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/mainlevee', async (req) => s.fourriere.mainlevee(U(req), req.params.id, parse(z.object({ motif: t(5, 1000) }).strict(), req.body).motif));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/sortie', async (req) => s.fourriere.exit(U(req), req.params.id, parse(exitSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/contestation', async (req, reply) => reply.code(201).send(s.fourriere.contest(U(req), req.params.id, parse(z.object({ motif: t(5, 2000) }).strict(), req.body).motif)));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/contestation/decision', async (req) => s.fourriere.decideContest(U(req), req.params.id, parse(z.object({ accueillie: z.boolean(), motif: t(5, 1000) }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/destination-legale', async (req) => s.fourriere.proposeDisposal(U(req), req.params.id, parse(disposalSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/fourrieres/dossiers/:id/destination-legale/validation', async (req) => s.fourriere.validateDisposal(U(req), req.params.id, parse(z.object({ level: z.union([z.literal(1), z.literal(2)]), approve: z.boolean(), motif: t(3, 1000) }).strict(), req.body)));
  app.get('/v1/fourrieres/priorisation', async (req) => s.fourriere.prioritise(U(req)));
  app.post('/v1/fourrieres/alertes/garde', async (req) => s.fourriere.runOverdueAlerts(U(req)));
  app.get('/v1/fourrieres/rapprochement', async (req) => { authorize(U(req), 'fourriere:read'); return { sites: s.fourriere.reconciliation() }; });
  app.get('/v1/fourrieres/indicateurs', async (req) => { authorize(U(req), 'fourriere:read'); return s.fourriere.indicators(); });

  // ——— Centres agréés ———
  app.get('/v1/centres-agrees', async (req) => ({ items: s.centres.list(U(req)), indicators: s.centres.indicators() }));
  app.post('/v1/centres-agrees/invitations', async (req, reply) => reply.code(201).send(s.centres.invite(U(req), parse(z.object({ kind: z.enum(CENTRE_KINDS), name: t(3, 160), commune: t(2, 60), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), categories: z.array(category).min(1).max(8), activities: z.array(z.enum(CENTRE_ACTIVITIES)).min(1).max(4), declaredHours: hours }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/dossier', async (req) => s.centres.submitDossier(U(req), req.params.id, parse(z.object({ invitationCode: t(4, 100), legalExistence: t(3, 500), quitusRef: t(3, 200), conflictDeclaration: t(3, 1000), linksWithOfficials: t(3, 1000) }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/diligences', async (req) => s.centres.recordDiligence(U(req), req.params.id, parse(z.object({ checks: z.array(z.object({ code: t(2, 40), label: t(2, 200), ok: z.boolean(), note: t(1, 500).optional() }).strict()).min(1).max(30) }).strict(), req.body).checks));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/proposition', async (req) => s.centres.propose(U(req), req.params.id, parse(z.object({ motif: t(3, 1000), habilitation: z.object({ from: isoDateString, to: isoDateString }).strict(), quotas }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/decision', async (req) => s.centres.decide(U(req), req.params.id, parse(decision, req.body)));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/habilitation', async (req) => s.centres.updateHabilitation(U(req), req.params.id, parse(z.object({ categories: z.array(category).max(8).optional(), activities: z.array(z.enum(CENTRE_ACTIVITIES)).max(4).optional(), habilitation: z.object({ from: isoDateString, to: isoDateString }).strict().optional(), quotas: quotas.optional(), motif: t(3, 1000) }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/suspension', async (req) => s.centres.suspend(U(req), req.params.id, parse(z.object({ motif: t(5, 1000), legalRef: t(3, 300) }).strict(), req.body)));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/retablissement-demande', async (req) => s.centres.requestReinstatement(U(req), req.params.id, parse(z.object({ motif: t(5, 1000) }).strict(), req.body).motif));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/retablissement-decision', async (req) => s.centres.decideReinstatement(U(req), req.params.id, parse(decision, req.body)));
  app.get('/v1/centres-agrees/analytique', async (req) => s.centres.analytics(U(req), s.ct.activePvs(), s.ct.stickers.all()));
  app.post('/v1/centres-agrees/analytique/alertes', async (req) => s.centres.analytics(U(req), s.ct.activePvs(), s.ct.stickers.all(), { raise: true }));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/:id/enrolements', async (req, reply) => reply.code(201).send(s.raccordement.startEnrolment(U(req), req.params.id, parse(z.object({ phone: z.string().regex(/^\+?\d[\d\s-]{7,18}$/), fullName: t(3, 120).optional(), plate: t(3, 20).optional() }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/centres-agrees/enrolements/:id/code', async (req) => s.raccordement.completeEnrolment(U(req), req.params.id, parse(z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), req.body).code));

  // ——— Raccordement RFCK ———
  const flow = z.enum(INTERFACE_FLOWS.map((f) => f.code) as [FlowCode, ...FlowCode[]]);
  app.get('/v1/rfck/flux', async (req) => { authorize(U(req), 'rfck:read'); return { items: s.raccordement.flowsView(), connector: { id: s.raccordement.connector.id, mode: s.raccordement.connector.mode, label: s.raccordement.connector.label } }; });
  app.post('/v1/rfck/conventions', async (req, reply) => reply.code(201).send(s.raccordement.recordConvention(U(req), parse(z.object({ flow, reference: t(3, 200), signedOn: isoDateString, signatories: t(3, 500), documentSha256: z.string() }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/rfck/conventions/:id/conformite', async (req) => s.raccordement.recordCompliance(U(req), req.params.id, parse(z.object({ conclusion: z.enum(['CONFORME', 'NON_CONFORME']), note: t(3, 1000) }).strict(), req.body)));
  app.post<{ Params: { flux: string } }>('/v1/rfck/flux/:flux/echanges', async (req, reply) => reply.code(201).send(s.raccordement.exchange(U(req), parse(flow, req.params.flux), parse(z.object({ direction: z.enum(['ENVOI', 'RECEPTION']), payload: z.array(z.unknown()).max(10_000) }).strict(), req.body))));
  app.post('/v1/rfck/rapprochement-registre', async (req) => s.raccordement.reconcileRegistry(U(req)));
  app.get('/v1/rfck/reprises', async (req) => { authorize(U(req), 'rfck:read'); return { items: s.raccordement.reprises.all().map(({ records, ...r }) => ({ ...r, count: records.length })) }; });
  app.post('/v1/rfck/reprises', async (req, reply) => reply.code(201).send(s.raccordement.importReprise(U(req), parse(z.object({ source: t(3, 200), records: z.array(z.object({ plate: t(3, 20), category }).strict()).min(1).max(100_000) }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/rfck/reprises/:id/controle', async (req) => s.raccordement.controlReprise(U(req), req.params.id, parse(z.object({ conforming: z.number().int().min(0), note: t(3, 1000) }).strict(), req.body)));
  app.get('/v1/rfck/chiffres-publies', async (req) => { authorize(U(req), 'rfck:read'); return { items: s.raccordement.figuresView() }; });
  app.post<{ Params: { code: string } }>('/v1/rfck/chiffres-publies/:code/decision', async (req) => s.raccordement.decideFigure(U(req), req.params.code, parse(z.object({ decision: z.enum(['CONFIRME', 'RETIRE']), motif: t(3, 1000), source: t(3, 500) }).strict(), req.body)));
  app.get('/v1/rfck/integration', async (req) => { authorize(U(req), 'rfck:read'); return { steps: s.raccordement.stepsView(), cashAttestation: s.raccordement.cashAttestation }; });
  app.post<{ Params: { etape: string } }>('/v1/rfck/integration/:etape/validation', async (req) => s.raccordement.validateStep(U(req), parse(z.enum(INTEGRATION_STEPS.map((x) => x.code) as [StepCode, ...StepCode[]]), req.params.etape), parse(z.object({ motif: t(3, 1000) }).strict(), req.body).motif));
  app.post('/v1/rfck/integration/fermeture-especes', async (req) => s.raccordement.attestCashClosure(U(req), parse(z.object({ motif: t(5, 1000), reference: t(3, 200) }).strict(), req.body)));
  app.get('/v1/rfck/entite', async (req) => { authorize(U(req), 'rfck:read'); return { entity: s.referentiel().entity, arrete: s.referentiel().arrete, contacts: s.raccordement.contacts, modules: s.referentiel().modules, numerotation: s.referentiel().numerotation }; });
  app.post('/v1/rfck/entite/contacts', async (req) => s.raccordement.updateContacts(U(req), parse(z.object({ adresse: t(0, 300).optional(), telephone: t(0, 40).optional(), courriel: z.string().email().optional() }).strict(), req.body)));

  // ——— Domaine officiel de vérification ———
  app.get('/v1/rfck/domaine', async (req) => { authorize(U(req), 'rfck:read'); return { ...s.domaine.view(), requirements: s.domainRequirements() }; });
  app.get('/v1/rfck/domaine/exigences', async (req) => { authorize(U(req), 'rfck:read'); return { items: s.domainRequirements() }; });
  app.post('/v1/rfck/domaine/proposition', async (req) => s.domaine.propose(U(req), parse(z.object({ host: t(4, 253), ownedBy: t(3, 200), proofRef: t(3, 300) }).strict(), req.body)));
  app.post('/v1/rfck/domaine/validation', async (req) => s.domaine.validate(U(req), parse(z.object({ approve: z.boolean(), motif: t(3, 1000), legacyRedirectUntil: isoDateString.optional() }).strict(), req.body)));
  app.post('/v1/rfck/domaine/anciens', async (req, reply) => reply.code(201).send(s.domaine.addLegacy(U(req), parse(z.object({ host: t(4, 253), redirectUntil: isoDateString, reason: t(3, 500) }).strict(), req.body))));
  app.post('/v1/rfck/domaine/surveillance', async (req, reply) => reply.code(201).send(s.domaine.report(U(req), parse(z.object({ host: t(4, 253), evidence: t(3, 1000) }).strict(), req.body))));
  app.post<{ Params: { id: string } }>('/v1/rfck/domaine/surveillance/:id/suite', async (req) => s.domaine.advance(U(req), req.params.id, parse(z.object({ to: z.enum(['RETRAIT_DEMANDE', 'RETIRE', 'CLASSE']), note: t(3, 1000) }).strict(), req.body)));

  // ——— Vérifications publiques (sans compte, limitées, journalisées) ———
  app.get<{ Querystring: { qr?: string; numero?: string } }>('/v1/public/vehicules/vignettes/verifier', async (req) => { limit(req); return s.ct.publicVerify(req.query.qr ?? req.query.numero ?? ''); });
  app.get<{ Params: { numero: string } }>('/v1/public/vehicules/vignettes/:numero', async (req) => { limit(req); return s.ct.publicVerify(req.params.numero); });
  app.get<{ Params: { code: string } }>('/v1/public/centres-agrees/:code', async (req) => { limit(req); return s.centres.publicVerify(req.params.code); });
  // Annuaire public des centres agréés (30/09/2026) : choix du centre par l'usager (rendez-vous de contrôle technique).
  app.get('/v1/public/centres-agrees', async (req) => { limit(req); return { items: s.centres.publicDirectory() }; });
  app.get('/v1/public/vehicules/domaine-officiel', async () => ({ host: s.domaine.domain.host, status: s.domaine.domain.status, ownedBy: s.domaine.domain.ownedBy }));
}
