/**
 * Routes du module « citoyen » (modules 1 à 12 de la Spécification fonctionnelle). Toute décision d'accès passe par la
 * politique (`authorize`) côté serveur ; les routes publiques (/v1/public/…) ne renvoient jamais de donnée individuelle.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse, isRealCalendarDate } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import type { AppContext } from '../../context.js';
import { SOURCES_RECOUPEMENT } from './activites.js';
import { INSTALLATION_HEADER, PLATEFORMES } from './application.js';
import { SOURCES_GEOMETRIE, TYPES_CAS } from './cadastre.js';
import { FAMILLES_SIMULATION, PAGES_PUBLIQUES } from './portail.js';
import { TYPES_PIECE } from './pieces.js';
import type { CitoyenService } from './service.js';
import { CATEGORIES_TRANSPORT } from './transport.js';

type P = { Params: { id: string } };
const motif = z.string().trim().min(3).max(1000);
const coord = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export function registerCitoyenRoutes(app: FastifyInstance, ctx: AppContext, svc: CitoyenService): void {
  // ───────── Gardes transverses ─────────
  app.addHook('preHandler', async (req) => {
    svc.portail.garde(req);
    svc.application.garde(req);
    svc.gardeAuthForte(req);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 500) return payload;
    const path = req.url.split('?')[0] ?? '';
    if (req.method === 'POST' && path === '/v1/registrations' && reply.statusCode < 300 && typeof payload === 'string') {
      // Module 2 : enrôlements par canal (application installée ou web).
      try {
        const body = JSON.parse(payload) as { taxpayerId?: string };
        const inst = req.headers[INSTALLATION_HEADER];
        ctx.audit.append({ actor: { kind: 'public', id: 'inscription' }, action: 'enrolement.channel.recorded', resourceType: 'taxpayer', resourceId: body.taxpayerId ?? 'inconnu', details: { channel: inst ? 'APPLICATION' : 'WEB' } });
      } catch { /* mesure sans effet sur la réponse */ }
    }
    let body: unknown;
    if (typeof payload === 'string' && req.method === 'POST' && req.headers[INSTALLATION_HEADER]) { try { body = JSON.parse(payload); } catch { body = undefined; } }
    svc.application.compter(req, reply.statusCode, body);
    return payload;
  });

  // ───────── Indicateurs des modules 1 à 12 ─────────
  app.get('/v1/citoyen/indicateurs', async (req) => svc.indicateurs(requireUser(req)));

  // ───────── Module 2 : contrôle des pièces, score de confiance, rapprochements, revue des cas à risque ─────────
  app.post('/v1/citoyen/enrolement/pieces', async (req, reply) => reply.code(201).send(svc.pieces.controler(requireUser(req), parse(z.object({
    type: z.enum(TYPES_PIECE), numero: z.string().trim().min(3).max(40), nomDeclare: z.string().trim().min(2).max(120), taxpayerId: z.string().max(60).optional(),
    telephone: z.string().regex(/^\+?\d{9,15}$/).optional(), photoSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), dateExpiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate, 'date inexistante au calendrier').optional(),
    lectureAuto: z.object({ texte: z.string().max(4000).optional(), nom: z.string().max(200).optional(), numero: z.string().max(40).optional(), mrzLigne2: z.string().max(60).optional() }).strict().optional(),
    canal: z.enum(['EN_LIGNE', 'APPLICATION', 'GUICHET', 'AGENT']).optional(),
  }).strict(), req.body))));
  app.get('/v1/citoyen/enrolement/pieces/revues', async (req) => svc.pieces.revues(requireUser(req)));
  app.post<P>('/v1/citoyen/enrolement/pieces/:id/decision', async (req) => svc.pieces.decider(requireUser(req), req.params.id, parse(z.object({ decision: z.enum(['VALIDEE', 'REJETEE', 'COMPLEMENT_DEMANDE']), motif }).strict(), req.body)));

  // ───────── Module 3 : attestation de situation (le quitus garde son propre circuit) ─────────
  app.post('/v1/citoyen/situation/attestations', async (req, reply) => reply.code(201).send(svc.situation.emettre(requireUser(req), parse(z.object({ taxpayerId: z.string().max(60).optional() }).strict(), req.body ?? {}).taxpayerId)));
  app.get('/v1/public/attestations-situation/:id', async (req) => svc.situation.verifier((req.params as { id: string }).id, (req.query as { sig?: string }).sig));

  // ───────── Module 4 : application Android et iOS ─────────
  app.post('/v1/public/application/installations', async (req, reply) => {
    const b = parse(z.object({ installationId: z.string().regex(/^APP-[0-9a-f-]{36}$/).optional(), plateforme: z.enum(PLATEFORMES), versionApp: z.string().trim().min(1).max(20), langue: z.string().trim().min(2).max(5) }).strict(), req.body);
    return reply.code(201).send(svc.application.enregistrer(b, req.user));
  });
  app.post<P>('/v1/public/application/installations/:id/integrite', async (req) => svc.application.integrite(req.params.id, parse(z.object({
    racine: z.boolean(), jailbreak: z.boolean(), emulateur: z.boolean(), debogage: z.boolean(), signatureAlteree: z.boolean().optional(), source: z.enum(['MODULE_NATIF', 'NAVIGATEUR']),
  }).strict(), req.body)));
  app.post<P>('/v1/public/application/installations/:id/avis', async (req, reply) => reply.code(201).send(svc.application.avisDonne(req.params.id, parse(z.object({ note: z.number().int().min(1).max(5), commentaire: z.string().trim().max(500).optional() }).strict(), req.body))));
  app.get('/v1/citoyen/application/indicateurs', async (req) => svc.application.indicateurs(requireUser(req)));

  // ───────── Module 5 : portail web public ─────────
  app.get('/v1/public/defi', async () => svc.portail.nouveauDefi());
  app.post('/v1/public/visites', async (req) => svc.portail.visite(parse(z.object({ page: z.enum(PAGES_PUBLIQUES) }).strict(), req.body).page));
  app.get('/v1/public/simulateurs', async () => svc.portail.catalogue());
  app.post('/v1/public/simulations', async (req) => svc.portail.simuler(parse(z.object({
    famille: z.enum(FAMILLES_SIMULATION), regle: z.string().trim().max(60).optional(), rang: z.number().int().min(1).max(4).optional(),
    entrees: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.string().regex(/^\d{1,15}(\.\d{1,6})?$/)),
  }).strict(), req.body)));
  app.get('/v1/public/informations', async () => svc.portail.informations());
  app.get('/v1/public/transport/cartes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { sig } = req.query as { sig?: string };
    return svc.transport.verifierCarte(id, sig);
  });

  // ───────── Module 7 : relations (revue des obligations à la date d'effet) ─────────
  app.get<{ Querystring: { statut?: string } }>('/v1/citoyen/relations/revues', async (req) => svc.relations.liste(requireUser(req), req.query.statut));
  app.post<P>('/v1/citoyen/relations/revues/:id/decision', async (req) => svc.relations.decider(requireUser(req), req.params.id, parse(z.object({ statut: z.enum(['MAINTENUE', 'A_RECTIFIER']), motif }).strict(), req.body)));
  app.get('/v1/citoyen/relations/indicateurs', async (req) => { authorize(requireUser(req), 'citoyen:indicateurs'); return svc.relations.indicateurs(); });

  // ───────── Module 8 : cadastre fiscal géospatial ─────────
  app.get('/v1/public/cadastre/couches', async (req) => svc.cadastre.couches(req.user));
  app.get('/v1/citoyen/cadastre/couches', async (req) => svc.cadastre.couches(requireUser(req)));
  app.get<P>('/v1/citoyen/cadastre/objets/:id/historique', async (req) => svc.cadastre.historique(requireUser(req), req.params.id));
  app.get<P>('/v1/citoyen/cadastre/objets/:id/hierarchie', async (req) => svc.cadastre.hierarchie(requireUser(req), req.params.id));
  app.post<P>('/v1/citoyen/cadastre/objets/:id/geometries', async (req, reply) => reply.code(201).send(svc.cadastre.enregistrerGeometrie(requireUser(req), req.params.id, parse(z.object({
    type: z.enum(['POINT', 'POLYGONE']), coordonnees: z.array(coord).min(1).max(200), precisionM: z.number().min(0).max(10_000), source: z.enum(SOURCES_GEOMETRIE), motif,
  }).strict(), req.body))));
  app.get('/v1/citoyen/cadastre/superpositions', async (req) => svc.cadastre.listeSuperpositions(requireUser(req)));
  app.post<P>('/v1/citoyen/cadastre/superpositions/:id/decision', async (req) => svc.cadastre.deciderSuperposition(requireUser(req), req.params.id, parse(z.object({ decision: z.enum(['DISTINCTS', 'DOUBLON_CONFIRME']), motif }).strict(), req.body)));
  app.get<{ Querystring: { commune?: string } }>('/v1/citoyen/cadastre/cas', async (req) => svc.cadastre.listeCas(requireUser(req), req.query.commune));
  app.post('/v1/citoyen/cadastre/cas', async (req, reply) => reply.code(201).send(svc.cadastre.ouvrirCas(requireUser(req), parse(z.object({
    type: z.enum(TYPES_CAS), objectId: z.string().max(60).optional(), commune: z.string().min(2).max(40), quartier: z.string().max(80).optional(), repere: z.string().trim().max(300).optional(),
    photoFacadeSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), unitesEstimees: z.number().int().min(1).max(10_000).optional(), precisionM: z.number().min(0).optional(),
    objetsVoisins: z.array(z.string().max(60)).max(20).optional(), note: motif,
  }).strict(), req.body))));
  app.post<P>('/v1/citoyen/cadastre/cas/:id/decision', async (req) => svc.cadastre.deciderCas(requireUser(req), req.params.id, parse(z.object({ statut: z.enum(['RENVOYE_SERVICE_FONCIER', 'RESOLU']), motif }).strict(), req.body)));
  app.get<{ Querystring: { indicateur?: string } }>('/v1/citoyen/cadastre/chaleur', async (req) => svc.cadastre.chaleur(requireUser(req), parse(z.enum(['potentiel', 'conformite', 'couverture', 'recettes']), req.query.indicateur ?? 'potentiel')));
  app.get<{ Querystring: { commune?: string } }>('/v1/citoyen/cadastre/couverture', async (req) => svc.cadastre.couverture(requireUser(req), req.query.commune));
  app.get('/v1/citoyen/cadastre/indicateurs', async (req) => { authorize(requireUser(req), 'citoyen:indicateurs'); return svc.cadastre.indicateurs(); });

  // ───────── Module 9 : intelligence foncière et locative ─────────
  app.get<{ Querystring: { commune?: string; tous?: string } }>('/v1/citoyen/locatif/calcul', async (req) => svc.locatif.calcul(requireUser(req), { ...(req.query.commune ? { commune: req.query.commune } : {}), verifiesSeulement: req.query.tous !== 'true' }));
  app.get<{ Querystring: { niveau?: string; commune?: string } }>('/v1/citoyen/locatif/couverture', async (req) => svc.locatif.couverture(requireUser(req), parse(z.enum(['commune', 'quartier', 'avenue']), req.query.niveau ?? 'commune'), req.query.commune));
  app.get('/v1/citoyen/locatif/indicateurs', async (req) => { authorize(requireUser(req), 'citoyen:indicateurs'); return svc.locatif.indicateurs(); });

  // ───────── Module 10 : activités et patentes ─────────
  app.get<{ Querystring: { commune?: string; categorie?: string; sansPatente?: string } }>('/v1/citoyen/activites', async (req) => svc.activites.registre(requireUser(req), { ...(req.query.commune ? { commune: req.query.commune } : {}), ...(req.query.categorie ? { categorie: req.query.categorie } : {}), sansPatente: req.query.sansPatente === 'true' }));
  app.get<{ Params: { id: string }; Querystring: { periode?: string } }>('/v1/citoyen/activites/:id/obligations', async (req) => svc.activites.obligations(requireUser(req), req.params.id, req.query.periode));
  app.post('/v1/citoyen/activites/detection', async (req) => svc.activites.detecter(requireUser(req)));
  app.post('/v1/citoyen/activites/signaux', async (req, reply) => reply.code(201).send(svc.activites.signaler(requireUser(req), parse(z.object({ objectId: z.string().min(1).max(60), detail: motif }).strict(), req.body))));
  app.get<{ Querystring: { statut?: string } }>('/v1/citoyen/activites/signaux', async (req) => svc.activites.listeSignaux(requireUser(req), req.query.statut));
  app.post<P>('/v1/citoyen/activites/signaux/:id/mission', async (req) => svc.activites.planifierVisite(requireUser(req), req.params.id, parse(z.object({ missionId: z.string().min(1).max(60) }).strict(), req.body).missionId));
  app.post<P>('/v1/citoyen/activites/signaux/:id/decision', async (req) => svc.activites.decider(requireUser(req), req.params.id, parse(z.object({ statut: z.enum(['CONFIRME', 'ECARTE']), motif }).strict(), req.body)));
  app.post('/v1/citoyen/activites/recoupements', async (req, reply) => reply.code(201).send(svc.activites.recouper(requireUser(req), parse(z.object({
    source: z.enum(Object.keys(SOURCES_RECOUPEMENT) as [keyof typeof SOURCES_RECOUPEMENT, ...(keyof typeof SOURCES_RECOUPEMENT)[]]),
    lignes: z.array(z.object({ reference: z.string().trim().min(2).max(60), nom: z.string().trim().max(120).optional(), commune: z.string().max(40).optional() }).strict()).min(1).max(5000),
  }).strict(), req.body))));

  // ───────── Module 11 : véhicules et circulation ─────────
  app.get<{ Querystring: { commune?: string; categorie?: string; plaque?: string } }>('/v1/citoyen/vehicules', async (req) => svc.vehicules.referentiel(requireUser(req), req.query));
  app.get<{ Params: { plaque: string }; Querystring: { commune?: string } }>('/v1/citoyen/vehicules/:plaque/controle', async (req) => svc.vehicules.controle(requireUser(req), req.params.plaque, req.query.commune));
  app.post<{ Params: { plaque: string } }>('/v1/citoyen/vehicules/:plaque/mutation-verification', async (req) => svc.vehicules.verifierMutation(requireUser(req), req.params.plaque));
  app.post('/v1/citoyen/vehicules/immatriculations', async (req, reply) => reply.code(201).send(svc.vehicules.importer(requireUser(req), parse(z.object({
    source: z.string().trim().min(3).max(120),
    lignes: z.array(z.object({ plaque: z.string().trim().min(4).max(20), categorie: z.string().trim().max(30).optional(), usage: z.string().trim().max(60).optional(), proprietaire: z.string().trim().max(120).optional(), dateImmatriculation: z.string().max(10).optional() }).strict()).min(1).max(20_000),
  }).strict(), req.body))));
  app.get('/v1/citoyen/vehicules/immatriculations', async (req) => { authorize(requireUser(req), 'citoyen:vehicules.import'); return svc.vehicules.lots.all().reverse(); });
  app.post<P>('/v1/citoyen/vehicules/immatriculations/:id/ecarts', async (req) => svc.vehicules.deciderEcart(requireUser(req), req.params.id, parse(z.object({ plaque: z.string().min(4).max(20), champ: z.string().min(3).max(30), retenu: z.enum(['REGISTRE_RETENU', 'MOSOLO_RETENU']), motif }).strict(), req.body)));
  app.post('/v1/citoyen/vehicules/liquidations', async (req, reply) => reply.code(201).send(svc.vehicules.liquider(requireUser(req), parse(z.object({ categorie: z.string().trim().min(2).max(30), exercice: z.string().regex(/^\d{4}$/) }).strict(), req.body))));

  // ───────── Module 12 : autorisations de transport ─────────
  app.get('/v1/citoyen/transport/autorisations', async (req) => svc.transport.liste(requireUser(req)));
  app.post('/v1/citoyen/transport/autorisations', async (req, reply) => reply.code(201).send(svc.transport.enregistrer(requireUser(req), parse(z.object({
    certificatCode: z.string().trim().min(3).max(60), categorie: z.enum(CATEGORIES_TRANSPORT), plaque: z.string().trim().min(4).max(20), zones: z.array(z.string().min(2).max(40)).max(24),
    corridor: z.string().trim().max(200).optional(), horaires: z.object({ debut: hhmm, fin: hhmm }).strict(), renouvelle: z.string().max(60).optional(),
  }).strict(), req.body))));
  app.post<P>('/v1/citoyen/transport/autorisations/:id/activation', async (req) => svc.transport.activer(requireUser(req), req.params.id));
  app.post<P>('/v1/citoyen/transport/autorisations/:id/cartes', async (req, reply) => reply.code(201).send(svc.transport.emettreCarte(requireUser(req), req.params.id, parse(z.object({ conducteurTaxpayerId: z.string().min(2).max(60), permisRef: z.string().trim().min(4).max(40) }).strict(), req.body))));
  app.post<P>('/v1/citoyen/transport/autorisations/:id/suspension', async (req) => svc.transport.proposerSuspension(requireUser(req), req.params.id, parse(z.object({ action: z.enum(['SUSPENDRE', 'LEVER']), motif, decisionRef: z.string().trim().min(3).max(120) }).strict(), req.body)));
  app.post<P>('/v1/citoyen/transport/autorisations/:id/suspension/decision', async (req) => svc.transport.approuverSuspension(requireUser(req), req.params.id, parse(z.object({ approuver: z.boolean(), motif }).strict(), req.body)));
  app.post<P>('/v1/citoyen/transport/autorisations/:id/renouvellement', async (req, reply) => reply.code(201).send(svc.transport.demanderRenouvellement(requireUser(req), req.params.id)));
  app.post('/v1/citoyen/transport/controles', async (req) => svc.transport.controler(requireUser(req), parse(z.object({ plaque: z.string().trim().max(20).optional(), qr: z.string().trim().max(200).optional(), commune: z.string().min(2).max(40) }).strict(), req.body)));
  app.post('/v1/citoyen/transport/rappels', async (req) => { authorize(requireUser(req), 'citoyen:transport.gerer'); return { rappels: svc.transport.rappels() }; });
  app.get('/v1/citoyen/transport/indicateurs', async (req) => { authorize(requireUser(req), 'citoyen:indicateurs'); return svc.transport.indicateurs(); });
}
