/**
 * Module d'extension « postes » : postes de décision des autorités et postes de travail des opérateurs (Cahier nouvelle
 * version, ch. 27 ; catalogue n° 41 « Postes de décision des autorités », n° 42 « Poste de travail — régie fiscale »,
 * n° 43 « Poste de travail — régie des taxes », n° 44 « Postes ministériels »). Construit PAR-DESSUS les tableaux de
 * bord existants (pilotage, planification, programme, accès), qui restent tous disponibles (règle n° 1).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { DEVICE_FINGERPRINT_HEADER, isoDateString, parse } from '../../core/http.js';
import { definePlugin } from '../types.js';
import { ACTIONS_FICHE, ACTIONS_ORDRE, ACTIONS_PREPARATION, ACTES_A_PRODUIRE, CATEGORIES_DECISION, ETATS_CHIFFRE, ETATS_EXECUTION, MOTIF_MIN, POSITION_MAX } from './model.js';
import { registerPostesPolicies } from './policy.js';
import { seedPostes } from './seed.js';
import { PostesService } from './service.js';
import { Vues } from './vues.js';

export class PostesModule extends PostesService {
  readonly vues: Vues = new Vues(this);
}

const motif = z.string().trim().min(MOTIF_MIN, `motif d’au moins ${MOTIF_MIN} caractères`).max(2000);
const texte = (min: number, max: number) => z.string().trim().min(min).max(max);
const roleCode = z.string().regex(/^R\d{2}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);

const actionSchema = z.object({
  action: z.enum(ACTIONS_FICHE), motif: z.string().max(2000).optional().default(''),
  delegataireId: z.string().max(80).optional(), jusquau: isoDateString.optional(), perimetre: texte(3, 300).optional(),
}).strict();
const delegationSchema = z.object({
  delegataireId: z.string().min(2).max(80), categorie: z.enum(CATEGORIES_DECISION), ficheId: z.string().max(200).optional(), debut: isoDateString.optional(), fin: isoDateString, motif, perimetre: texte(3, 300),
}).strict();
const dossierSchema = z.object({
  categorie: z.enum(CATEGORIES_DECISION), nature: z.string().max(40).optional(), destinataireRole: roleCode, destinataireEntity: z.string().max(80).optional(),
  objet: texte(5, 300), serviceInstructeur: texte(2, 200), validationAmont: texte(2, 300).nullable().optional().transform((v) => v ?? null), demandeurLibelle: texte(2, 200).optional(),
  enjeu: z.object({
    texte: texte(2, 400), montant: z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/), currency: z.string().length(3) }).strict().optional(),
    etat: z.enum([...ETATS_CHIFFRE, 'OBJECTIF', 'COMPTAGE', 'RATIO', 'DELAI'] as [string, ...string[]]), nombre: texte(1, 100).optional(), commune: texte(2, 60).optional(),
    figures: z.array(z.object({ libelle: texte(1, 120), valeur: texte(1, 40), unite: z.string().max(20) }).strict()).max(8).optional(),
  }).strict(),
  echeance: isoDateString, consequenceSilence: texte(5, 400), fondement: z.array(texte(3, 400)).max(10),
  position: z.object({ recommandation: z.string().trim().max(POSITION_MAX), reserves: z.array(texte(3, 300)).max(5) }).strict(),
  siRien: texte(5, 400), pieces: z.array(z.object({ libelle: texte(2, 300), reference: z.string().max(200).optional(), sha256: sha.optional() }).strict()).max(30),
  execution: z.object({
    acte: z.enum(ACTES_A_PRODUIRE), libelle: texte(3, 300), delaiJours: z.number().int().min(0).max(365),
    responsable: z.object({ entity: z.string().min(2).max(80), role: roleCode.optional(), userId: z.string().max(80).optional(), libelle: texte(2, 200) }).strict(),
    lien: z.object({ type: z.literal('CENTRE_SUSPENSION'), centreId: z.string().max(80) }).strict().optional(),
  }).strict(),
  individuel: z.boolean(), finaliteNominative: texte(10, 400).optional(), manque: texte(3, 300).optional(), entities: z.array(z.string().max(80)).max(10).optional(),
  delegationSuggeree: z.object({ userId: z.string().max(80), libelle: texte(2, 200) }).strict().optional(),
  libellesActions: z.object({ APPROUVER: texte(3, 80).optional(), REFUSER: texte(3, 80).optional(), DELEGUER: texte(3, 80).optional(), COMPLEMENT: texte(3, 80).optional() }).strict().optional(),
}).strict();
const habilitationSchema = z.object({
  userId: z.string().min(2).max(80), du: isoDateString.optional(), au: isoDateString, motif,
  perimetre: z.object({ libelle: texte(3, 300), entities: z.array(z.string().max(80)).max(30), communes: z.array(z.string().max(60)).max(24), categories: z.array(z.string().max(60)).max(30) }).strict(),
}).strict();

const REQUEST_DROP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'content-type']);

/** Relais interne vers la route de décision EXISTANTE de la source (même pipeline, mêmes gardes, même journal). */
async function relayer(app: FastifyInstance, req: FastifyRequest, url: string, body: unknown) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !REQUEST_DROP.has(k)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  if (req.correlationId) headers['x-request-id'] = req.correlationId;
  headers['content-type'] = 'application/json';
  const res = await app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body), remoteAddress: req.ip });
  let json: unknown;
  try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json };
}

export const postesPlugin = definePlugin<PostesModule>({
  name: 'postes',
  create: (ctx) => {
    registerPostesPolicies();
    return new PostesModule(ctx);
  },
  seed: (ctx, svc) => seedPostes(ctx, svc),
  routes: (app, _ctx, svc) => {
    const U = (req: FastifyRequest) => requireUser(req);
    const device = (req: FastifyRequest) => { const h = req.headers[DEVICE_FINGERPRINT_HEADER]; return Array.isArray(h) ? h[0] : h; };
    const v = svc.vues;

    // Référentiel du chapitre 27 (familles, budgets d'attention, trois écrans, catégories, règles d'affichage)
    app.get('/v1/postes/referentiel', async (req) => { U(req); return v.referentiel(); });
    // Écran d'accueil : zéro saisie (aucun filtre, aucune période, aucune commune)
    app.get('/v1/postes/accueil', async (req) => v.accueil(U(req)));
    app.get<{ Querystring: { format?: string; vue?: string } }>('/v1/postes/accueil/export', async (req, reply: FastifyReply) => {
      const u = U(req);
      const rows = v.chiffresAccueil(u, req.query.vue);
      svc.audit(u, 'postes.accueil.exporte', 'poste', svc.profilDe(u) ?? 'poste', { format: req.query.format ?? 'csv', chiffres: rows.length });
      if ((req.query.format ?? 'csv') === 'html') return reply.type('text/html; charset=utf-8').send(v.exportHtml(`Poste de décision — ${svc.userName(u.id)} — ${svc.today()}`, rows));
      return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="poste-de-decision-${svc.today()}.csv"`).send(v.exportCsv(rows));
    });
    app.get<{ Params: { vue: string } }>('/v1/postes/vues/:vue', async (req) => v.vue(U(req), req.params.vue));
    // Corbeille et fiches (§ 27.3)
    app.get('/v1/postes/corbeille', async (req) => { const u = U(req); return { ...svc.corbeille(u, { accueil: true }), historique: v.historique(u) }; });
    app.get<{ Params: { id: string }; Querystring: { finalite?: string } }>('/v1/postes/fiches/:id', async (req) => svc.ficheDetail(U(req), req.params.id, req.query.finalite));
    app.post<{ Params: { id: string } }>('/v1/postes/fiches/:id/action', async (req, reply) => {
      const u = U(req);
      const b = parse(actionSchema, req.body);
      const r = svc.agir(u, req.params.id, b, device(req));
      if ('resultat' in r) return r.resultat;
      const res = await relayer(app, req, r.relais.url, r.relais.body(b.motif.trim(), r.relais.approve));
      const geste = svc.enregistrerRelais(u, req.params.id, b, r.relais, r.item, res.status, r.delegation);
      if (res.status >= 400) return reply.code(res.status).send({ ...(res.body && typeof res.body === 'object' ? res.body : { detail: String(res.body) }), geste, routeSource: `POST ${r.relais.url}` });
      return { geste, routeSource: `POST ${r.relais.url}`, resultatSource: res.body };
    });
    // Poste de travail (§ 27.13), recherche, indicateurs
    app.get('/v1/postes/travail', async (req) => v.travail(U(req)));
    app.get<{ Querystring: { q?: string } }>('/v1/postes/recherche', async (req) => v.recherche(U(req), req.query.q ?? ''));
    app.get('/v1/postes/indicateurs', async (req) => v.indicateurs(U(req)));
    // Délégations (§ 27.11)
    app.get('/v1/postes/delegations', async (req) => ({ items: svc.listeDelegations(U(req)) }));
    app.get<{ Querystring: { categorie?: string } }>('/v1/postes/delegations/candidats', async (req) => ({ items: svc.candidatsDelegation(U(req), req.query.categorie ?? '') }));
    app.post('/v1/postes/delegations', async (req, reply) => reply.code(201).send(svc.creerDelegation(U(req), parse(delegationSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/postes/delegations/:id/revocation', async (req) => svc.revoquerDelegation(U(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    // Dossiers d'orientation instruits par les services
    app.post('/v1/postes/dossiers', async (req, reply) => reply.code(201).send(svc.soumettreDossier(U(req), parse(dossierSchema, req.body) as never)));
    app.post<{ Params: { id: string } }>('/v1/postes/dossiers/:id/reponse', async (req) => svc.repondreComplement(U(req), req.params.id, parse(z.object({ texte: motif }).strict(), req.body).texte));
    // Directeur de cabinet (§ 27.6) : préparation et ordre du jour
    app.post<{ Params: { id: string } }>('/v1/postes/cabinet/dossiers/:id/preparation', async (req) => svc.preparer(U(req), req.params.id, parse(z.object({ action: z.enum(ACTIONS_PREPARATION), motif }).strict(), req.body)));
    app.post('/v1/postes/cabinet/ordre-du-jour', async (req) => svc.ordonner(U(req), parse(z.object({ ficheId: z.string().min(3).max(200), action: z.enum(ACTIONS_ORDRE), motif, reexamenLe: isoDateString.optional() }).strict(), req.body)));
    // Exécution des décisions (§ 27.7)
    app.post<{ Params: { id: string } }>('/v1/postes/executions/:id/etat', async (req) => svc.mettreAJourExecution(U(req), req.params.id, parse(z.object({
      etat: z.enum(ETATS_EXECUTION), motif: texte(3, 1000), blocage: texte(3, 500).optional(),
      preuve: z.object({ reference: texte(3, 200), sha256: sha.optional(), version: texte(1, 40).optional(), publieLe: isoDateString.optional() }).strict().optional(),
    }).strict(), req.body)));
    app.post<{ Params: { id: string } }>('/v1/postes/executions/:id/relance', async (req) => svc.relancer(U(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post<{ Params: { id: string } }>('/v1/postes/executions/:id/justification', async (req) => svc.justifier(U(req), req.params.id, parse(z.object({ texte: motif }).strict(), req.body).texte));
    // Autres autorités habilitées (§ 27.9)
    app.post('/v1/postes/habilitations', async (req, reply) => reply.code(201).send(svc.declarerHabilitation(U(req), parse(habilitationSchema, req.body))));
    app.post<{ Params: { id: string } }>('/v1/postes/habilitations/:id/renouvellement', async (req) => svc.renouvelerHabilitation(U(req), req.params.id, parse(z.object({ au: isoDateString, motif }).strict(), req.body)));
    // Note du lundi (§ 27.5)
    app.get('/v1/postes/notes', async (req) => v.notes(U(req)));
    app.post('/v1/postes/notes/production', async (req, reply) => {
      const u = U(req);
      v.notes(u);
      return reply.code(201).send(v.produireNote(u, 'PERSONNE'));
    });
    app.get<{ Params: { id: string } }>('/v1/postes/notes/:id', async (req) => v.note(U(req), req.params.id));
    app.get<{ Params: { id: string } }>('/v1/postes/notes/:id/impression', async (req, reply) => {
      const u = U(req);
      const n = v.note(u, req.params.id);
      const c = n.contenu as ReturnType<Vues['contenuNote']>;
      svc.audit(u, 'postes.note.exportee', 'note_hebdomadaire', n.id, { sha256: n.sha256 });
      const extra = `<p>Semaine ${c.semaine.code} (du ${c.semaine.lundi} au ${c.semaine.dimanche}) · arrêtée au ${c.arreteAu} · produite le ${n.produiteLe} · version ${n.version}</p><p>Empreinte SHA-256 : <code>${n.sha256}</code></p><h2>Décisions et effets</h2><ul>${c.decisions.map((d) => `<li>${d.date} — ${d.geste} — ${d.objet} : ${d.effet}</li>`).join('') || '<li>Aucune décision cette semaine.</li>'}</ul><h2>Communes</h2><p>${c.communes.base}</p><p>En avance : ${c.communes.enAvance.map((x) => x.commune).join(', ') || '—'} · En retard : ${c.communes.enRetard.map((x) => x.commune).join(', ') || '—'}</p><h2>Alertes ouvertes</h2><ul>${c.alertes.map((a) => `<li>${a.cause} (${a.ageJours} j)</li>`).join('') || '<li>Aucune.</li>'}</ul><h2>Décisions attendues dans les sept jours</h2><ul>${c.echeances7j.map((e) => `<li>${e.echeance} — ${e.objet}</li>`).join('') || '<li>Aucune.</li>'}</ul><h2>Sources</h2><p>${c.sources.join(' · ')}</p>`;
      return reply.type('text/html; charset=utf-8').header('x-mosolo-empreinte', n.sha256).send(v.exportHtml(`${c.titre} — ${c.autorite}`, c.recettes as never, extra));
    });
    // Notifications (§ 27.11)
    app.get('/v1/postes/notifications', async (req) => { const u = U(req); return { plafondJournalier: svc.plafond(u.id), items: svc.notifications.find((n) => n.userId === u.id).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100) }; });
    app.post('/v1/postes/notifications/plafond', async (req) => svc.fixerPlafond(U(req), parse(z.object({ plafondJournalier: z.number().int() }).strict(), req.body).plafondJournalier));
  },
});
