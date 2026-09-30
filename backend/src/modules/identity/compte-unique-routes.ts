/**
 * « Mon compte unique » (ch. 9) — agrégation de tout ce qui est rattaché à un compte, dans tous les modules.
 *
 * ABAC côté serveur :
 *  - le titulaire lit tout son compte (téléphone complet) ;
 *  - un mandataire (R31) lit seulement dans le périmètre d'un mandat ACTIF comportant « CONSULTER » : objets du mandat
 *    (liste vide = tous), sans consentements, documents, notifications ni autres mandats ; identité masquée ;
 *  - un agent habilité (`taxpayer.read` complet dans son périmètre) lit seulement avec une CONSULTATION MOTIVÉE active
 *    (circuit existant POST /v1/acces/consultations) : motif journalisé, lecture comptée ;
 *  - toute autre personne : 403.
 * Chaque lecture est journalisée (acteur, motif, horodatage).
 */
import type { FastifyInstance } from 'fastify';
import { formatMoney, Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { MOTIF_HEADER, motifConsultation } from '../../core/consultation.js';
import { badRequest, forbidden } from '../../core/errors.js';
import { evaluate } from '../../core/policy.js';
import { RUBRIQUE_LABELS, type CompteElement, type CompteSection, type Rubrique } from './compte-unique.js';
import { maskPhone } from './service.js';
import { aFaire, lienUsager } from './a-faire.js';

type Viewer = 'self' | 'mandataire' | 'agent';

/** Rubriques jamais montrées à un mandataire (données personnelles du mandant hors objet du mandat). */
const HORS_MANDAT: Rubrique[] = ['CONSENTEMENT', 'DOCUMENT', 'NOTIFICATION', 'MANDAT_DONNE', 'MANDAT_RECU', 'CARTE', 'FICHE_METIER', 'ORGANISATION', 'ROLE'];
/** Rubriques qui ne dépendent d'aucun objet : visibles d'un mandataire seulement si le mandat couvre tous les objets. */
const OBLIGATION_OUVERTE = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];

function add(totals: Map<string, bigint>, m: MoneyJSON): void {
  const minor = Money.fromJSON(m).minor;
  totals.set(m.currency, (totals.get(m.currency) ?? 0n) + minor);
}

/** Synthèse calculée côté serveur (devises jamais mélangées, montants exacts). */
export function synthese(sections: CompteSection[], now: Date) {
  const elements = sections.flatMap((s) => s.elements);
  const parRubrique = Object.fromEntries(Object.keys(RUBRIQUE_LABELS).map((r) => [r, 0])) as Record<Rubrique, number>;
  for (const e of elements) parRubrique[e.rubrique] += 1;
  const objetsParNature: Record<string, number> = {};
  for (const e of elements.filter((x) => ['OBJET', 'VEHICULE', 'ENTREPRISE', 'ENSEIGNE'].includes(x.rubrique) && x.nature)) objetsParNature[e.nature!] = (objetsParNature[e.nature!] ?? 0) + 1;
  // Obligations par statut ET par devise (jamais additionnées entre devises).
  const obl = new Map<string, { statut: string; devise: string; nombre: number; total: bigint }>();
  for (const e of elements.filter((x) => x.rubrique === 'OBLIGATION' && x.montant)) {
    const k = `${e.statut}|${e.montant!.currency}`;
    const cur = obl.get(k) ?? { statut: e.statut ?? 'INCONNU', devise: e.montant!.currency, nombre: 0, total: 0n };
    cur.nombre += 1;
    cur.total += Money.fromJSON(e.montant!).minor;
    obl.set(k, cur);
  }
  const resteDu = new Map<string, bigint>();
  for (const e of elements.filter((x) => x.rubrique === 'OBLIGATION' && x.montant && OBLIGATION_OUVERTE.includes(x.statut ?? ''))) add(resteDu, e.montant!);
  const today = now.toISOString();
  const titres = elements.filter((x) => x.rubrique === 'TITRE' || x.rubrique === 'PASS');
  return {
    parRubrique,
    objetsParNature,
    obligationsParStatutEtDevise: [...obl.values()].map((o) => ({ statut: o.statut, devise: o.devise, nombre: o.nombre, total: Money.fromMinor(o.total, o.devise as MoneyJSON['currency']).toJSON() })),
    resteDuParDevise: [...resteDu.entries()].map(([devise, minor]) => {
      const m = Money.fromMinor(minor, devise as MoneyJSON['currency']);
      return { ...m.toJSON(), affichage: formatMoney(m.toJSON()) };
    }),
    titres: {
      valides: titres.filter((t) => !t.echeance || t.echeance >= today).filter((t) => !['EXPIRE', 'ANNULE', 'REVOQUE', 'REMPLACE', 'SUSPENDU'].includes(t.statut ?? '')).length,
      expires: titres.filter((t) => (t.echeance && t.echeance < today) || ['EXPIRE', 'ANNULE', 'REVOQUE', 'REMPLACE'].includes(t.statut ?? '')).length,
      total: titres.length,
    },
    prochainesEcheances: elements
      .filter((x) => x.rubrique === 'OBLIGATION' && x.echeance && OBLIGATION_OUVERTE.includes(x.statut ?? ''))
      .sort((a, b) => a.echeance!.localeCompare(b.echeance!)).slice(0, 5)
      .map((x) => ({ id: x.id, libelle: x.libelle, echeance: x.echeance!, montant: x.montant ?? null, statut: x.statut ?? null })),
    modules: sections.filter((s) => s.elements.length > 0).map((s) => s.module),
  };
}

function restrictToMandate(sections: CompteSection[], objectIds: string[]): CompteSection[] {
  const scoped = new Set(objectIds);
  return sections.map((s) => ({
    ...s,
    elements: s.elements.filter((e: CompteElement) => !HORS_MANDAT.includes(e.rubrique) && (scoped.size === 0 || (!!e.objectId && scoped.has(e.objectId)))),
  })).filter((s) => s.elements.length > 0 || !!s.erreur);
}

export function registerCompteUniqueRoutes(app: FastifyInstance, ctx: AppContext): void {
  const reg = ctx.compteUnique;

  const view = (user: User, taxpayerIdRaw: string, headers: Record<string, string | string[] | undefined>, consultationId?: string) => {
    // Troisième passe (D3-04) : pour une personne du public (titulaire R30, mandataire R31), un identifiant inexistant
    // reçoit le MÊME refus qu'un compte existant d'autrui (aucune sonde d'existence) ; les agents gardent le 404.
    const publicOnly = user.roles.every((r) => r === 'R30' || r === 'R31');
    let tp: ReturnType<typeof ctx.taxpayers.resolve>;
    try {
      tp = ctx.taxpayers.resolve(taxpayerIdRaw);
    } catch (err) {
      if (!publicOnly) throw err;
      throw user.roles.includes('R31')
        ? forbidden('MANDATE_SCOPE', 'Aucun mandat actif vous autorisant à consulter ce compte (action « CONSULTER »).')
        : forbidden('FORBIDDEN', 'Compte unique : accès réservé au titulaire, à son mandataire et aux agents habilités dans leur périmètre.');
    }
    let viewer: Viewer;
    let objectIds: string[] = [];
    let mandateId: string | null = null;
    if (user.taxpayerId && ctx.taxpayers.resolve(user.taxpayerId).id === tp.id) viewer = 'self';
    else if (user.roles.includes('R31')) {
      const m = reg.gates.mandate?.(user.id, tp.id) ?? null;
      if (!m) throw forbidden('MANDATE_SCOPE', 'Aucun mandat actif vous autorisant à consulter ce compte (action « CONSULTER »).');
      viewer = 'mandataire';
      objectIds = m.objectIds;
      mandateId = m.mandateId;
    } else {
      const objects = ctx.objects.byTaxpayer(tp.id);
      const access = evaluate(user, 'taxpayer.read', {
        taxpayerId: tp.id, entities: [...new Set(['DGIPK', ...ctx.assessment.byTaxpayer(tp.id).map((o) => o.entity)])], communes: objects.map((o) => o.commune),
      });
      if (access !== 'full') throw forbidden('FORBIDDEN', 'Compte unique : accès réservé au titulaire, à son mandataire et aux agents habilités dans leur périmètre.');
      if (!consultationId || !reg.gates.consultation?.(user.id, tp.id, consultationId)) {
        throw forbidden('CONSULTATION_MOTIVEE_REQUISE', 'Consultation d’un compte : ouvrez d’abord une consultation motivée (POST /v1/acces/consultations) et indiquez-la (?consultation=).');
      }
      viewer = 'agent';
    }
    let sections = reg.collect(tp.id);
    if (viewer === 'mandataire') sections = restrictToMandate(sections, objectIds);
    // Usager (titulaire, mandataire) : liens vers SES écrans, jamais vers un écran de travail des agents (30/09/2026).
    if (viewer !== 'agent') {
      sections = sections.map((s) => ({ ...s, lien: lienUsager(s.lien) ?? s.lien, elements: s.elements.map((e) => (e.lien ? { ...e, lien: lienUsager(e.lien) ?? e.lien } : e)) }));
    }
    ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'compte_unique.viewed', resourceType: 'taxpayer', resourceId: tp.id,
      details: { viewer, mandateId, consultationId: consultationId ?? null, sections: sections.length, ...motifConsultation(headers, user, viewer !== 'agent') },
    });
    const identite = reg.gates.identite?.(tp.id, viewer) ?? {};
    return {
      viewer,
      compte: {
        taxpayerId: tp.id, iuc: tp.iuc, nom: tp.fullName, nature: tp.kind ?? 'PERSONNE_PHYSIQUE',
        telephone: viewer === 'self' ? tp.phone : tp.phone ? maskPhone(tp.phone) : null,
        telephoneVerifie: !!tp.phoneVerifiedAt, niveau: tp.verificationLevel, langue: tp.language, creeLe: tp.createdAt, statut: tp.status ?? 'ACTIF',
        ...(taxpayerIdRaw !== tp.id ? { compteDemande: taxpayerIdRaw, note: 'Compte fusionné : le compte conservé est présenté.' } : {}),
      },
      identite,
      sections,
      synthese: synthese(sections, ctx.clock.now()),
      ...(viewer === 'mandataire' ? { mandat: { id: mandateId, objets: objectIds.length ? objectIds : 'TOUS' } } : {}),
      principe: 'Un compte, une personne : les informations vérifiées sont réutilisées par chaque module ; une correction passe par la contestation ou la rectification, jamais par une nouvelle saisie.',
      correction: { contestation: '/v1/appeals', rectification: '/v1/acces/identity/:id/proofs', recuperation: '/v1/public/enrolement/recuperations' },
      genereLe: ctx.clock.now().toISOString(),
    };
  };

  app.get('/v1/compte-unique/me', async (req) => {
    const user = requireUser(req);
    if (!user.taxpayerId) {
      throw user.roles.includes('R31')
        ? badRequest('TAXPAYER_REQUIRED', 'Mandataire : indiquez le compte du mandant (GET /v1/compte-unique/:taxpayerId).')
        : forbidden('FORBIDDEN', 'Espace réservé aux titulaires d’un compte contribuable.');
    }
    return view(user, user.taxpayerId, req.headers);
  });

  /**
   * « À faire » de l'usager (30/09/2026) : ce qu'il doit faire, ce que l'administration vérifie, ce qui est à jour —
   * en un seul endroit, sur le même compte unique (mêmes droits : titulaire ; mandataire dans son mandat).
   */
  app.get<{ Querystring: { taxpayerId?: string } }>('/v1/moi/a-faire', async (req) => {
    const user = requireUser(req);
    const target = req.query.taxpayerId ?? user.taxpayerId;
    if (!target) {
      throw user.roles.includes('R31')
        ? badRequest('TAXPAYER_REQUIRED', 'Mandataire : indiquez le compte du mandant (?taxpayerId=).')
        : forbidden('FORBIDDEN', 'Espace réservé aux titulaires d’un compte contribuable.');
    }
    const v = view(user, target, req.headers);
    // Obligation dont le solde est nul (paiements confirmés, rapprochement en cours) : jamais proposée « à payer ».
    const dejaCouverte = (id: string) => { try { const o = ctx.assessment.get(id); const reste = Money.fromJSON(o.amount).subtract(ctx.payments.paidOn(id)); return reste.isZero() || reste.isNegative(); } catch { return false; } };
    return { compte: { taxpayerId: v.compte.taxpayerId, nom: v.compte.nom }, viewer: v.viewer, ...aFaire(v.sections, ctx.clock.now(), dejaCouverte), genereLe: ctx.clock.now().toISOString() };
  });

  app.get<{ Params: { taxpayerId: string }; Querystring: { consultation?: string } }>('/v1/compte-unique/:taxpayerId', async (req) => {
    const user = requireUser(req);
    const cid = req.query.consultation ?? (typeof req.headers['x-consultation-id'] === 'string' ? req.headers['x-consultation-id'] : undefined);
    return view(user, req.params.taxpayerId, req.headers, cid);
  });

  /** Fiches « personne » de métier des modules : rattachées au compte unique ou signalées (jamais fusionnées d'office). */
  app.get('/v1/compte-unique/fiches-metier', async (req) => {
    const user = requireUser(req);
    if (!user.roles.some((r) => ['R12', 'R22', 'R23', 'R26'].includes(r))) throw forbidden('FORBIDDEN', 'Contrôle des fiches de métier : guichet, audit et administration de la plateforme.');
    const fiches = reg.fiches();
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'compte_unique.fiches_listed', resourceType: 'compte_unique', resourceId: 'fiches', details: { total: fiches.length } });
    return {
      total: fiches.length,
      rattachees: fiches.filter((f) => !!f.taxpayerId).length,
      nonRattachees: fiches.filter((f) => !f.taxpayerId).map((f) => ({ module: f.module, type: f.type, id: f.id, libelle: f.libelle, telephone: f.phone ? maskPhone(f.phone) : null })),
      parModule: Object.entries(fiches.reduce<Record<string, { total: number; rattachees: number }>>((acc, f) => {
        const k = `${f.module}:${f.type}`;
        acc[k] ??= { total: 0, rattachees: 0 };
        acc[k].total += 1;
        if (f.taxpayerId) acc[k].rattachees += 1;
        return acc;
      }, {})).map(([k, v]) => ({ fiche: k, ...v })),
      regle: 'Rattachement exact seulement (téléphone vérifié par code, NIF) ; un nom semblable ne rattache jamais : circuit de fusion contrôlé (preuve, deux personnes, réversible).',
      enTete: MOTIF_HEADER,
    };
  });
}
