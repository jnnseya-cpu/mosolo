/**
 * Module d'extension « moteur-repartition » : moteur de paiement, de règlement et de répartition des recettes
 * (spécifications du 29/09/2026, v1 et v1.0), construit par-dessus la clé du § 37A (module « repartition »).
 *
 * Routes françaises /v1/pilotage/moteur-repartition/… ; alias anglais de la spécification v1.0 (§ 28) sous /api/…,
 * qui appellent les mêmes services ou relaient vers les routes /v1 existantes — contrôle d'accès côté serveur partout.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CURRENCIES, type CurrencyCode } from '@mosolo/shared';
import { ACR, requireAcr, requireUser, type User } from '../../../../core/auth.js';
import { forbidden } from '../../../../core/errors.js';
import { isoDateString, parse } from '../../../../core/http.js';
import { authorize, definePolicy, GRANTS, PUBLIC_AGENT_ROLES } from '../../../../core/policy.js';
import { definePlugin } from '../../../types.js';
import { FLOW_CODES } from '../model.js';
import { ETATS_DROIT, METHODES, MODES_COUTS, MODES_POOL, MODES_REGLEMENT, POSTES_COUTS, TYPES_AGENT, LECTURES_POOL, type PosteCout } from './model.js';
import { ENTITE_GROUPE_NSEYA, MoteurRepartitionService, type Filtre } from './service.js';
import { TableauxMoteur } from './tableaux.js';

const { always } = GRANTS;
// Décision du 29/09/2026 : seuls R01, R02, R03, R05 (et R38 par sa liste de lecture) voient les gains des autres.
const EXEC = { R01: always, R02: always, R03: always, R05: always } as const;
/** Configuration (lecture) : direction, Finances, juridique, Trésor, coffre, audit, exploitation technique. */
definePolicy('moteur:config.read', { ...EXEC, R17: always, R18: always, R22: always, R23: always, R14: always, R15: always, R16: always, R19: always, R26: always, R27: always });
// Matrice versionnée : rédaction → vérification → approbation → activation, quatre personnes distinctes (§ 18).
definePolicy('moteur:regle.proposer', { R26: always, R05: always, R15: always });
definePolicy('moteur:regle.verifier', { R14: always, R15: always });
definePolicy('moteur:regle.approuver', { R05: always, R02: always });
definePolicy('moteur:regle.activer', { R01: always, R05: always, R16: always });
// Compte de règlement principal (§ 2) : Trésor → gestionnaire du coffre → Gouverneur.
definePolicy('moteur:compte.proposer', { R17: always });
definePolicy('moteur:compte.verifier', { R19: always });
definePolicy('moteur:compte.autoriser', { R01: always });
// Tableaux (§ 12) ; Groupe Nseya (R38) lit par la liste fermée de lecture du point de décision (core/policy.ts).
definePolicy('moteur:executif.read', EXEC);
definePolicy('moteur:entite.read', { ...EXEC, R04: always, R06: always, R07: always, R08: always });
definePolicy('moteur:nseya.read', { ...EXEC });
definePolicy('moteur:sous-traitant.read', { R35: always });
definePolicy('moteur:agent.read', { R10: always });
definePolicy('moteur:export', { ...EXEC });
// Affectations des agents (§ 9, § 18) : proposées par la régie, confirmées par une autre personne.
definePolicy('moteur:agents.read', { ...EXEC, R06: always, R07: always, R09: always });
definePolicy('moteur:agents.fiche.proposer', { R06: always, R07: always, R09: always });
definePolicy('moteur:agents.fiche.confirmer', { R06: always, R07: always });
// Demandes de règlement (§ 6 ; v1.0 § 14) : demandeur → Finance (examen) → Gouvernement (approbation) → Trésor → rapprochement.
definePolicy('moteur:reglement.demander', { R17: always, R38: always, R06: always, R08: always });
definePolicy('moteur:reglement.examiner', { R15: always, R17: always });
definePolicy('moteur:reglement.approuver', { R05: always, R02: always });
definePolicy('moteur:reglement.payer', { R17: always });
definePolicy('moteur:reglement.rapprocher', { R18: always });
definePolicy('moteur:litige.ouvrir', { R17: always, R38: always, R06: always, R08: always });
definePolicy('moteur:litige.decider', { R05: always, R17: always });
// Coûts technologiques (§ 14 ; v1.0 § 25) : saisis par le Trésor ou Groupe Nseya (facture), vérifiés par une autre personne.
definePolicy('moteur:couts.proposer', { R17: always, R38: always });
definePolicy('moteur:couts.verifier', { R15: always, R17: always });
definePolicy('moteur:synchroniser', { R17: always, R18: always, R22: always });

const motif = z.string().trim().min(10, 'motif d’au moins 10 caractères').max(2000);
const pct = z.string().regex(/^\d{1,3}(\.\d{1,3})?$/, 'pourcentage en chaîne décimale (trois décimales au plus)');
const currency = z.string().refine((c) => c in CURRENCIES, 'devise inconnue');
const beneficiarySchema = z.object({
  code: z.enum(['GROUPE_NSEYA', 'TUTELLE', 'AGENTS_SOUS_TRAITANTS', 'GOUVERNEMENT_PROVINCIAL']),
  label: z.string().trim().min(3).max(200), pct, flow: z.enum(FLOW_CODES as unknown as [string, ...string[]]),
  remainder: z.boolean(), modeReglement: z.enum(Object.keys(MODES_REGLEMENT) as [string, ...string[]]),
}).strict();
const poolSchema = z.object({
  mode: z.enum(Object.keys(MODES_POOL) as [string, ...string[]]), lecture: z.enum(Object.keys(LECTURES_POOL) as [string, ...string[]]),
  direct: z.object({ agentPct: pct, sousTraitantPct: pct }).strict(), sousTraitance: z.object({ agentPct: pct, sousTraitantPct: pct }).strict(),
}).strict();
const versionSchema = z.object({
  label: z.string().trim().min(5).max(300), beneficiaries: z.array(beneficiarySchema).min(4).max(8),
  scope: z.object({ revenus: z.array(z.string().max(80)).max(50).optional(), modules: z.array(z.string().max(40)).max(200).optional(), methodes: z.array(z.enum(['*', ...METHODES] as [string, ...string[]])).max(3).optional() }).strict().optional(),
  effectiveFrom: isoDateString, effectiveUntil: isoDateString.nullable().optional(),
  legalBasis: z.string().trim().min(5).max(500), approvalDocument: z.string().trim().max(200).nullable().optional(),
  pool: poolSchema.optional(),
  couts: z.object({ mode: z.enum(Object.keys(MODES_COUTS) as [string, ...string[]]), fraisGestionPct: pct.nullable() }).strict().optional(),
  fractionnement: z.object({ infrastructureApprouvee: z.string().trim().min(3).max(200).nullable() }).strict().optional(),
  motif,
}).strict();
const decision = z.object({ approve: z.boolean(), motif }).strict();
const filtreSchema = z.object({
  period: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/).optional(), from: isoDateString.optional(), to: isoDateString.optional(), currency: currency.optional(),
  module: z.string().max(60).optional(), methode: z.enum(METHODES as unknown as [string, ...string[]]).optional(), mode: z.enum(['REEL', 'SIMULATION']).optional(),
  entity: z.string().max(60).optional(), commune: z.string().max(60).optional(), agent: z.string().max(80).optional(), subcontractor: z.string().max(80).optional(),
  provider: z.string().max(80).optional(), revenueType: z.string().max(80).optional(), state: z.enum(Object.keys(ETATS_DROIT) as [string, ...string[]]).optional(),
  beneficiaire: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional(),
  motif: z.string().max(500).optional(),
}).strict();

function filtreOf(q: z.infer<typeof filtreSchema>): Filtre {
  const { beneficiaire: _b, limit: _l, offset: _o, motif: _m, ...f } = q;
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Filtre;
}
const motifOf = (req: FastifyRequest, q: { motif?: string }) => {
  const h = req.headers['x-motif-consultation'];
  const raw = typeof h === 'string' ? decodeURIComponent(h) : q.motif;
  return raw && raw.trim() ? raw : undefined;
};

/** Refus serveur : aucun agent public (R01–R29) ni sous-traitant terrain (R35) n'encaisse d'espèces (décision du 29/09/2026). */
export function refuseEspecesAgent(svc: MoteurRepartitionService, user: User): void {
  if (user.roles.some((r) => (PUBLIC_AGENT_ROLES as readonly string[]).includes(r) || r === 'R35')) {
    svc.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'moteur.especes.refusees_agent', resourceType: 'cash', resourceId: user.id, details: { roles: user.roles }, outcome: 'DENIED' });
    throw forbidden('ESPECES_INTERDITES_AGENT', 'Aucune espèce pour les agents (décision du maître d’ouvrage du 29/09/2026) : les espèces ne sont reçues qu’aux points de paiement agréés et aux guichets bancaires.');
  }
}

const FORWARD_HEADERS = ['authorization', 'cookie', 'x-demo-user', 'idempotency-key', 'x-motif-consultation', 'x-mosolo-device-id', 'x-mosolo-device-fingerprint', 'accept-language'];

export const moteurRepartitionPlugin = definePlugin<MoteurRepartitionService>({
  name: 'moteur-repartition',
  create: (ctx) => new MoteurRepartitionService(ctx),
  seed: (ctx, svc) => {
    svc.ensureV1();
    // Transactions FICTIVES [EXEMPLE] répartis en SIMULATION (démonstration seulement) : écrans chiffrés et expliqués.
    svc.seedDemo();
    // Compte Groupe Nseya [EXEMPLE] (rôle dédié R38, lecture complète) et son entité de rattachement.
    const acces = ctx.ext.acces as { entities: { get(id: string): unknown; insert(e: Record<string, unknown>): unknown } } | undefined;
    if (acces && !acces.entities.get(ENTITE_GROUPE_NSEYA)) {
      acces.entities.insert({ id: ENTITE_GROUPE_NSEYA, name: 'Groupe Nseya — investisseur et opérateur [EXEMPLE]', shortName: 'Groupe Nseya', kind: 'OPERATEUR_DELEGUE', parentId: null, status: 'ACTIVE', createdAt: ctx.clock.now().toISOString(), createdBy: 'systeme', demo: true });
    }
    // Décision du 29/09/2026 : plus de second compte Groupe Nseya — le compte de démonstration « Groupe Nseya —
    // super-administrateur » (u-superadmin, R26 + R38, seed.ts) porte les deux rôles, comme sur la plateforme réelle.
    // Compte de règlement principal du Gouvernement [EXEMPLE] : PROPOSÉ (alias fictif du coffre), autorisation du Gouverneur requise.
    const tresor = ctx.users.get('u-tresor');
    if (tresor && ctx.vault.aliasExists('GVT-PROV-FLUX2-USD') && !svc.comptes.count()) {
      svc.proposeCompte(tresor, { alias: 'GVT-PROV-FLUX2-USD', effectiveFrom: '2026-10-01', motif: 'Proposition de démonstration [EXEMPLE] : compte du Gouvernement provincial au Trésor (Flux 2), numéro fictif.', demo: true });
    }
  },
  routes: (app, _ctx, svc) => {
    const tb = new TableauxMoteur(svc);
    const B = '/v1/pilotage/moteur-repartition';
    const q = (req: FastifyRequest) => parse(filtreSchema, req.query);

    // ——— matrice versionnée
    const listRules = async (req: FastifyRequest) => svc.listVersions(requireUser(req));
    const proposeRule = async (req: FastifyRequest, reply: FastifyReply) => reply.code(201).send(svc.proposeVersion(requireUser(req), parse(versionSchema, req.body) as Parameters<MoteurRepartitionService['proposeVersion']>[1]));
    const activateRule = async (req: FastifyRequest<{ Params: { id: string } }>) => {
      const user = requireUser(req);
      requireAcr(user, ACR.MFA); // effet sur la répartition des recettes publiques : authentification forte
      return svc.activateVersion(user, req.params.id, parse(decision, req.body));
    };
    app.get(`${B}/regles`, listRules);
    app.post(`${B}/regles`, proposeRule);
    app.post<{ Params: { id: string } }>(`${B}/regles/:id/verification`, async (req) => svc.verifyVersion(requireUser(req), req.params.id, parse(decision, req.body)));
    app.post<{ Params: { id: string } }>(`${B}/regles/:id/approbation`, async (req) => svc.approveVersion(requireUser(req), req.params.id, parse(decision, req.body)));
    app.post<{ Params: { id: string } }>(`${B}/regles/:id/activation`, activateRule);

    // ——— compte de règlement principal (§ 2)
    app.get(`${B}/comptes-reglement`, async (req) => ({ ...svc.listComptes(requireUser(req)), coherenceConvention: svc.coherenceConvention() }));
    app.post(`${B}/comptes-reglement`, async (req, reply) => reply.code(201).send(svc.proposeCompte(requireUser(req), parse(z.object({ alias: z.string().trim().min(3).max(80), effectiveFrom: isoDateString, motif }).strict(), req.body))));
    app.post<{ Params: { id: string } }>(`${B}/comptes-reglement/:id/verification`, async (req) => svc.verifyCompte(requireUser(req), req.params.id, parse(decision, req.body)));
    app.post<{ Params: { id: string } }>(`${B}/comptes-reglement/:id/autorisation`, async (req) => {
      const user = requireUser(req);
      requireAcr(user, ACR.MFA);
      return svc.authoriseCompte(user, req.params.id, parse(z.object({ approve: z.boolean(), motif, approvalReference: z.string().trim().min(3).max(120) }).strict(), req.body));
    });

    // ——— propriété des modules (§ 7, § 17) et affectations des agents (§ 9, § 18)
    app.get(`${B}/proprietes-modules`, async (req) => svc.ownershipRegister(requireUser(req)));
    app.get(`${B}/agents`, async (req) => svc.listFiches(requireUser(req)));
    app.post(`${B}/agents/affectations`, async (req, reply) => reply.code(201).send(svc.proposeFiche(requireUser(req), parse(z.object({
      agent_id: z.string().trim().min(2).max(80), agent_name: z.string().trim().min(2).max(200), agent_type: z.enum(Object.keys(TYPES_AGENT) as [string, ...string[]]),
      parent_ministry_id: z.string().max(60).nullable(), parent_department_id: z.string().max(60).nullable(), subcontractor_id: z.string().max(80).nullable(),
      commission_rule_id: z.string().max(60).optional(), territory: z.array(z.string().max(60)).max(30), module_permissions: z.array(z.string().max(40)).max(100),
      effective_from: isoDateString, effective_to: isoDateString.nullable(),
    }).strict(), req.body) as Parameters<MoteurRepartitionService['proposeFiche']>[1])));
    app.post<{ Params: { id: string } }>(`${B}/agents/affectations/:id/confirmation`, async (req) => svc.confirmFiche(requireUser(req), req.params.id, parse(decision, req.body)));

    // ——— sous-grand-livre des droits
    app.post(`${B}/synchroniser`, async (req) => svc.sync(requireUser(req)));
    app.get(`${B}/droits`, async (req) => {
      const user = requireUser(req);
      const vis = svc.visibility(user);
      if (vis.kind === 'AUCUNE') throw forbidden('HORS_PERIMETRE', 'Aucune visibilité financière pour ce compte.');
      svc.sync();
      return { reel: svc.ledgerBalances('REEL').filter((b) => svc.canSeeBeneficiary(vis, b.beneficiary)), simulation: svc.ledgerBalances('SIMULATION').filter((b) => svc.canSeeBeneficiary(vis, b.beneficiary)), chaine: svc.verifyChain() };
    });

    // ——— tableaux et « Expliquer ce chiffre »
    const executive = async (req: FastifyRequest) => tb.executif(requireUser(req), filtreOf(q(req)));
    const nseya = async (req: FastifyRequest) => tb.groupeNseya(requireUser(req), filtreOf(q(req)));
    const subcontractor = async (req: FastifyRequest) => tb.sousTraitant(requireUser(req), filtreOf(q(req)));
    const agent = async (req: FastifyRequest) => tb.agent(requireUser(req), filtreOf(q(req)));
    const entity = async (req: FastifyRequest<{ Params: { id?: string } }>) => { const f = filtreOf(q(req)); return tb.entite(requireUser(req), { ...f, ...(req.params.id ? { entity: req.params.id } : {}) }); };
    const explain = async (req: FastifyRequest<{ Params: { metricId?: string } }>) => { const x = q(req); return tb.expliquer(requireUser(req), req.params.metricId ?? x.beneficiaire ?? 'TOTAL', filtreOf(x)); };
    const txs = async (req: FastifyRequest) => { const x = q(req); return tb.transactions(requireUser(req), x.beneficiaire ?? 'TOTAL', filtreOf(x), { ...(x.limit ? { limit: x.limit } : {}), ...(x.offset ? { offset: x.offset } : {}), ...(motifOf(req, x) ? { motif: motifOf(req, x)! } : {}) }); };
    const tx = async (req: FastifyRequest<{ Params: { id: string } }>) => { const x = q(req); const id = req.params.id.startsWith('AL-') ? req.params.id : `AL-${req.params.id}`; return tb.transaction(requireUser(req), id, { ...(motifOf(req, x) ? { motif: motifOf(req, x)! } : {}) }); };
    app.get(`${B}/tableau/executif`, executive);
    app.get(`${B}/tableau/entite`, entity);
    app.get(`${B}/tableau/groupe-nseya`, nseya);
    app.get(`${B}/tableau/sous-traitant`, subcontractor);
    app.get(`${B}/tableau/agent`, agent);
    app.get(`${B}/expliquer`, explain);
    app.get(`${B}/transactions`, txs);
    app.get<{ Params: { id: string } }>(`${B}/transactions/:id`, tx);
    app.get(`${B}/configuration`, async (req) => tb.configuration(requireUser(req)));
    app.get(`${B}/export`, async (req, reply) => {
      const user = requireUser(req);
      const vis = svc.visibility(user);
      if (vis.kind !== 'GROUPE_NSEYA') authorize(user, 'moteur:export');
      const x = q(req);
      const data = tb.transactions(user, x.beneficiaire ?? 'TOTAL', filtreOf(x), { limit: 500, offset: x.offset ?? 0 });
      svc.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'moteur.export.financier', resourceType: 'moteur_repartition', resourceId: user.id, details: { beneficiaire: x.beneficiaire ?? 'TOTAL', lignes: data.items.length } });
      const head = ['transaction', 'date', 'module', 'entite', 'methode', 'version', 'mode', 'beneficiaire', 'pct', 'montant', 'devise', 'etat'];
      const rows = data.items.map((i) => [('transaction' in i ? i.transaction : i.allocationId) as string, i.date, i.module ?? '', i.entity, i.methode, i.versionId, i.mode, i.beneficiaire, i.pct, i.montant.amount, i.montant.currency, i.etat]);
      const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="moteur-repartition.csv"').send(csv);
    });

    // ——— demandes de règlement (DRAFT → … → CLOSED)
    const draftSchema = z.object({ beneficiary: z.string().trim().min(3).max(120), currency, periodStart: isoDateString.optional(), periodEnd: isoDateString.optional(), amount: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/).optional(), motif }).strict();
    const draft = async (req: FastifyRequest, reply: FastifyReply) => { const b = parse(draftSchema, req.body); return reply.code(201).send(svc.draftSettlement(requireUser(req), { ...b, currency: b.currency as CurrencyCode } as Parameters<MoteurRepartitionService['draftSettlement']>[1])); };
    const approveReq = async (req: FastifyRequest<{ Params: { id: string } }>) => svc.approveSettlement(requireUser(req), req.params.id, parse(decision, req.body));
    const confirmPay = async (req: FastifyRequest<{ Params: { id: string } }>) => svc.confirmSettlementPayment(requireUser(req), req.params.id, parse(z.object({ reference: z.string().trim().min(3).max(120) }).strict(), req.body));
    const reconcileReq = async (req: FastifyRequest<{ Params: { id: string } }>) => svc.reconcileSettlement(requireUser(req), req.params.id, parse(z.object({ reference: z.string().trim().min(3).max(120) }).strict(), req.body));
    app.get(`${B}/demandes`, async (req) => svc.listDemandes(requireUser(req)));
    app.post(`${B}/demandes`, draft);
    app.post<{ Params: { id: string } }>(`${B}/demandes/:id/soumission`, async (req) => svc.submitSettlement(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body)));
    app.post<{ Params: { id: string } }>(`${B}/demandes/:id/examen`, async (req) => svc.reviewSettlement(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body)));
    app.post<{ Params: { id: string } }>(`${B}/demandes/:id/approbation`, approveReq);
    app.post<{ Params: { id: string } }>(`${B}/demandes/:id/instruction`, async (req) => svc.instructSettlement(requireUser(req), req.params.id, parse(z.object({ operationId: z.string().trim().min(3).max(80), motif }).strict(), req.body)));
    app.post<{ Params: { id: string } }>(`${B}/demandes/:id/paiement`, confirmPay);
    app.post<{ Params: { id: string } }>(`${B}/demandes/:id/rapprochement`, reconcileReq);
    app.post<{ Params: { id: string } }>(`${B}/demandes/:id/cloture`, async (req) => svc.closeSettlement(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body)));

    // ——— litiges et coûts technologiques
    app.get(`${B}/litiges`, async (req) => { const user = requireUser(req); const vis = svc.visibility(user); if (vis.kind === 'AUCUNE') throw forbidden('HORS_PERIMETRE', 'Aucune visibilité financière.'); return { items: svc.litiges.all().filter((l) => svc.canSeeBeneficiary(vis, l.beneficiary)) }; });
    app.post(`${B}/litiges`, async (req, reply) => reply.code(201).send(svc.openDispute(requireUser(req), parse(z.object({ allocationId: z.string().max(120), beneficiary: z.string().max(120), motif }).strict(), req.body))));
    app.post<{ Params: { id: string } }>(`${B}/litiges/:id/decision`, async (req) => svc.decideDispute(requireUser(req), req.params.id, parse(z.object({ fonde: z.boolean(), motif }).strict(), req.body)));
    app.get(`${B}/couts`, async (req) => svc.listCouts(requireUser(req)));
    app.post(`${B}/couts`, async (req, reply) => {
      const b = parse(z.object({
        provider: z.string().trim().min(2).max(120), category: z.enum(Object.keys(POSTES_COUTS) as [string, ...string[]]), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        quantity: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/), unitCost: z.string().regex(/^\d{1,15}(\.\d{1,6})?$/), currency, fundedBy: z.enum(['GOUVERNORAT', 'GROUPE_NSEYA']),
        supportingInvoiceId: z.string().max(120).optional(), motif,
      }).strict(), req.body);
      return reply.code(201).send(svc.proposeCout(requireUser(req), { ...b, category: b.category as PosteCout, currency: b.currency as CurrencyCode } as Parameters<MoteurRepartitionService['proposeCout']>[1]));
    });
    app.post<{ Params: { id: string } }>(`${B}/couts/:id/verification`, async (req) => svc.verifyCout(requireUser(req), req.params.id, parse(decision, req.body)));

    // ——— alias anglais de la spécification v1.0 (§ 28) : mêmes services, mêmes contrôles côté serveur
    registerApiAliases(app, svc, { listRules, proposeRule, activateRule, executive, nseya, subcontractor, agent, entity, explain, txs, tx, draft, approveReq, confirmPay, reconcileReq });
  },
});

type H = (req: FastifyRequest<never>, reply: FastifyReply) => Promise<unknown>;

function registerApiAliases(app: FastifyInstance, svc: MoteurRepartitionService, h: Record<string, H>): void {
  /** Relais vers une route /v1 existante (mêmes en-têtes d'authentification, même contrôle d'accès). */
  const forward = (method: 'GET' | 'POST', to: (req: FastifyRequest) => string, body?: (req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    const headers: Record<string, string> = {};
    for (const k of FORWARD_HEADERS) { const v = req.headers[k]; if (typeof v === 'string') headers[k] = v; }
    const payload = body ? body(req) : req.body;
    const res = await app.inject({ method, url: to(req), headers: { ...headers, ...(payload !== undefined && method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined && method === 'POST' ? { payload: JSON.stringify(payload) } : {}) });
    const ct = res.headers['content-type'];
    return reply.code(res.statusCode).header('content-type', typeof ct === 'string' ? ct : 'application/json').send(res.body);
  };
  const enc = encodeURIComponent;
  const b = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  const qs = (req: FastifyRequest) => { const u = req.raw.url ?? ''; const i = u.indexOf('?'); return i >= 0 ? u.slice(i) : ''; };
  const cashGuard = (next: ReturnType<typeof forward>) => async (req: FastifyRequest, reply: FastifyReply) => { refuseEspecesAgent(svc, requireUser(req)); return next(req, reply); };

  app.post('/api/payments', forward('POST', (req) => `/v1/obligations/${enc(String(b(req).revenueObligationId ?? ''))}/payment-orders`, (req) => ({ channel: b(req).channel ?? b(req).paymentMethod })));
  app.get('/api/payments', forward('GET', (req) => `/v1/pilotage/moteur-repartition/transactions${qs(req)}`));
  app.get<{ Params: { id: string } }>('/api/payments/:id', h.tx as never);
  app.post<{ Params: { id: string } }>('/api/payments/:id/reconcile', async () => {
    throw forbidden('RAPPROCHEMENT_PAR_RELEVE', 'Le rapprochement d’un paiement se fait uniquement par l’import d’un relevé bancaire ou d’opérateur à double validation (module 29, POST /v1/settlements/statements) : jamais à la main.');
  });
  app.get('/api/allocations', h.txs as never);
  app.get('/api/allocations/rules', h.listRules as never);
  app.post('/api/allocations/rules', h.proposeRule as never);
  app.post<{ Params: { id: string } }>('/api/allocations/rules/:id/version', h.proposeRule as never);
  app.post<{ Params: { id: string } }>('/api/allocations/rules/:id/activate', h.activateRule as never);
  app.get('/api/entitlements', h.txs as never);
  app.get<{ Params: { id: string } }>('/api/entitlements/:id', h.tx as never);
  app.get('/api/settlements', forward('GET', () => '/v1/pilotage/moteur-repartition/demandes'));
  app.post('/api/settlements/request', h.draft as never);
  app.post<{ Params: { id: string } }>('/api/settlements/:id/approve', h.approveReq as never);
  app.post<{ Params: { id: string } }>('/api/settlements/:id/confirm-payment', h.confirmPay as never);
  app.post<{ Params: { id: string } }>('/api/settlements/:id/reconcile', h.reconcileReq as never);
  // Espèces : points agréés et guichets SEULEMENT ; refus serveur explicite pour tout agent (décision du 29/09/2026).
  app.post('/api/cash/declarations', cashGuard(forward('POST', (req) => `/v1/payment-points/${enc(String(b(req).pointId ?? ''))}/cash-days/${enc(String(b(req).day ?? ''))}/close`, (req) => ({ counted: b(req).counted }))));
  app.post('/api/cash/deposits', cashGuard(forward('POST', (req) => `/v1/payment-points/${enc(String(b(req).pointId ?? ''))}/cash-days/${enc(String(b(req).day ?? ''))}/deposit`, (req) => ({ bankSlipRef: b(req).bankSlipRef, depositedAt: b(req).depositedAt, lines: b(req).lines }))));
  app.post('/api/cash/reconcile', cashGuard(forward('POST', (req) => `/v1/payment-points/${enc(String(b(req).pointId ?? ''))}/cash-days/${enc(String(b(req).day ?? ''))}/bank-match`, (req) => ({ statementId: b(req).statementId }))));
  app.post('/api/cash/collections', cashGuard(forward('POST', (req) => `/v1/payment-points/${enc(String(b(req).pointId ?? ''))}/collections`, (req) => ({ reference: b(req).reference }))));
  app.get('/api/finance/executive', h.executive as never);
  app.get('/api/finance/groupe-nseya', h.nseya as never);
  app.get<{ Params: { id: string } }>('/api/finance/ministry/:id', h.entity as never);
  app.get<{ Params: { id: string } }>('/api/finance/subcontractor/:id', h.subcontractor as never);
  app.get<{ Params: { id: string } }>('/api/finance/agent/:id', async (req, reply) => {
    const user = requireUser(req);
    if (req.params.id !== user.id) throw forbidden('HORS_PERIMETRE', 'Un agent ne voit que sa propre activité.');
    return h.agent!(req as never, reply);
  });
  app.get<{ Params: { metricId: string } }>('/api/finance/explain/:metricId', h.explain as never);
  app.post('/api/refunds', forward('POST', () => '/v1/tresor/operations', (req) => ({ ...b(req), kind: 'REMBOURSEMENT' })));
  app.post('/api/reversals', forward('POST', () => '/v1/tresor/operations', (req) => ({ ...b(req), kind: 'CONTREPASSATION' })));
  app.get('/api/audit', forward('GET', (req) => `/v1/audit/events${qs(req)}`));
}

export { MoteurRepartitionService } from './service.js';
