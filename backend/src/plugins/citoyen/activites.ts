/**
 * Module 10 — Registre des activités et patentes (Spécification fonctionnelle ; § 7, § 19A.4, catalogue PAT-ANNUELLE).
 *
 * Par-dessus les objets « établissement » (catégorie ACTIVITE), le titre PAT-ANNUELLE (certificat de patente à QR
 * vérifiable, rappel ambre, prolongation par Mobile Money) et la démarche « autorisation d'exploitation » (débits de
 * boissons) de la verticale Entreprises, ce service apporte :
 *  - le REGISTRE DES ÉTABLISSEMENTS : entreprise, établissement, activité, catégorie, localisation, dirigeants
 *    (représentants de la personne morale), situation de patente et autorisations liées ;
 *  - la DÉTERMINATION DES OBLIGATIONS selon activité, lieu, catégorie et période : seules les RÈGLES du registre
 *    décident (l'existence d'une activité n'est pas un assujettissement) ;
 *  - le SIGNALEMENT des commerces visibles sans patente active : une liste de VÉRIFICATION, jamais une dette ; une
 *    visite n'a lieu que dans une mission autorisée (module terrain) ;
 *  - le RECOUPEMENT (codes marchands Mobile Money, livraisons brassicoles, RCCM) : sources sous protocole, rapprochées
 *    par fichier transmis ; aucun effet sans décision humaine ;
 *  - les indicateurs du module.
 */
import { isRuleExecutable } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { actorOf } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { statusAt } from '../titres/validity.js';
import { accesOf, norm, pct, titresOf, verticalesOf } from './common.js';

const { always, inTerritory, ownTaxpayer, mandant } = GRANTS;
definePolicy('citoyen:activites.read', { R01: always, R05: always, R06: always, R07: always, R11: always, R22: always, R24: always, R09: inTerritory('minimal'), R10: inTerritory('minimal'), R30: ownTaxpayer, R31: mandant });
definePolicy('citoyen:activites.signal', { R06: always, R07: always, R11: always, R09: inTerritory('full'), R10: inTerritory('full') });
definePolicy('citoyen:activites.decide', { R06: always, R07: always, R11: always });

/** Sources de recoupement du module 10 (sous protocole : fichier transmis, jamais une connexion directe sans convention). */
export const SOURCES_RECOUPEMENT = {
  CODES_MARCHANDS_MM: 'Codes marchands Mobile Money (opérateurs, sous protocole)',
  LIVRAISONS_BRASSICOLES: 'Livraisons brassicoles (brasseries, sous protocole)',
  RCCM: 'Registre du commerce et du crédit mobilier (RCCM, sous convention)',
} as const;
export type SourceRecoupement = keyof typeof SOURCES_RECOUPEMENT;

const PATENTE = 'PAT-ANNUELLE';
const ACTIVE_BANDS = ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'];

export interface SignalPatente {
  id: string;
  objectId: string;
  commune: string;
  motif: 'SANS_PATENTE_ACTIVE' | 'PATENTE_EXPIREE' | 'RECOUPEMENT';
  source: 'REGISTRE' | 'RELEVE_TERRAIN' | SourceRecoupement;
  detail: string;
  statut: 'A_VERIFIER' | 'EN_MISSION' | 'CONFIRME' | 'ECARTE';
  missionId?: string;
  ouvertLe: string;
  ouvertPar: string;
  decision?: { par: string; at: string; motif: string };
}

export interface LotRecoupement {
  id: string;
  source: SourceRecoupement;
  recuLe: string;
  recuPar: string;
  lignes: number;
  rapproches: number;
  inconnus: { reference: string; nom?: string; commune?: string }[];
  signaux: string[];
}

const objectType = (o: FiscalObject) => String(o.attributes['objectType'] ?? '');
const isEtablissement = (o: FiscalObject) => o.category === 'ACTIVITE' && !['ETAL', 'SITE_TELECOM', 'CARRIERE'].includes(objectType(o));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export class ActivitesService {
  readonly signaux = new InMemoryRepository<SignalPatente>();
  readonly lots = new InMemoryRepository<LotRecoupement>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now() { return this.ctx.clock.now(); }

  /** Patentes (titres PAT-ANNUELLE) portant sur l'établissement, la plus récente d'abord. */
  patentesDe(objectId: string) {
    const titres = titresOf(this.ctx);
    if (!titres) return [];
    return titres.credentials.find((c) => c.typeCode === PATENTE && c.subject.objectId === objectId && c.state !== 'REMPLACE')
      .sort((a, b) => b.validUntil.localeCompare(a.validUntil));
  }

  situationPatente(objectId: string) {
    const now = this.now();
    const list = this.patentesDe(objectId);
    const active = list.find((c) => c.state === 'EMIS' && ACTIVE_BANDS.includes(statusAt(c, now).status));
    const derniere = list[0];
    const type = titresOf(this.ctx)?.types.findOne((t) => t.code === PATENTE);
    return {
      active: !!active,
      titre: active ? { numero: active.number, validUntil: active.validUntil, statut: statusAt(active, now).text } : null,
      derniere: derniere ? { numero: derniere.number, validUntil: derniere.validUntil, statut: statusAt(derniere, now).status } : null,
      exigible: type?.legalAct?.status !== 'ACTE_REQUIS',
      acte: type?.legalAct ?? null,
    };
  }

  private dirigeants(o: FiscalObject): { nom: string; fonction: string }[] {
    const acces = accesOf(this.ctx);
    if (!o.taxpayerId || !acces) return [];
    return acces.organisations.find((x) => x.taxpayerId === o.taxpayerId).flatMap((x) => x.representatives.map((r) => ({ nom: r.fullName, fonction: r.fonction })));
  }

  private autorisations(o: FiscalObject) {
    const vx = verticalesOf(this.ctx);
    if (!vx) return [];
    return vx.certificates.find((c) => c.objectId === o.id).map((c) => ({ code: c.code, nature: c.kind, libelle: c.label, statut: vx.certificateStatus(c), validUntil: c.validUntil ?? null }));
  }

  /** Registre des établissements (vue par rôle : un contribuable ne voit que les siens). */
  registre(user: User, filtre: { commune?: string; categorie?: string; sansPatente?: boolean } = {}) {
    const own = user.roles.some((r) => r === 'R30' || r === 'R31');
    if (!own) authorize(user, 'citoyen:activites.read', filtre.commune ? { communes: [filtre.commune] } : {});
    const tps = own ? [user.taxpayerId, ...(user.mandants ?? [])].filter((x): x is string => !!x) : [];
    const lignes = this.ctx.objects.objects.find(isEtablissement).filter((o) => {
      if (filtre.commune && o.commune !== filtre.commune) return false;
      if (filtre.categorie && String(o.attributes['categorie'] ?? o.attributes['activite'] ?? '') !== filtre.categorie) return false;
      if (own) return !!o.taxpayerId && tps.includes(o.taxpayerId) && !!evaluate(user, 'citoyen:activites.read', { taxpayerId: o.taxpayerId });
      return !!evaluate(user, 'citoyen:activites.read', { communes: [o.commune] });
    }).map((o) => {
      const tp = o.taxpayerId ? this.ctx.taxpayers.taxpayers.get(o.taxpayerId) : undefined;
      const org = o.taxpayerId ? accesOf(this.ctx)?.organisations.findOne((x) => x.taxpayerId === o.taxpayerId) : undefined;
      return {
        objectId: o.id, igf: o.igf?.code ?? null,
        entreprise: org?.raisonSociale ?? tp?.fullName ?? null, rccm: org?.rccmDeclared ? `${org.rccmDeclared.slice(0, 4)}•••` : null,
        etablissement: str(o.attributes['nom']) ?? str(o.attributes['enseigne']) ?? 'Établissement',
        activite: str(o.attributes['activite']) ?? str(o.attributes['objectType']) ?? null,
        categorie: str(o.attributes['categorie']) ?? null,
        localisation: { commune: o.commune, quartier: o.quartier, avenue: o.avenue ?? null, lat: o.lat, lon: o.lon },
        dirigeants: this.dirigeants(o), statut: o.status,
        patente: this.situationPatente(o.id), autorisations: this.autorisations(o),
        signauxOuverts: this.signaux.find((s) => s.objectId === o.id && (s.statut === 'A_VERIFIER' || s.statut === 'EN_MISSION')).length,
      };
    }).filter((l) => !filtre.sansPatente || !l.patente.active);
    return { lignes, notice: 'Existence d’une activité ≠ assujettissement : seule une règle publiée décide. Aucune visite sans mission autorisée.' };
  }

  /**
   * Obligations applicables selon activité, lieu, catégorie et période : titres et règles du registre qui visent
   * l'établissement, avec leur statut juridique (aucune obligation sans règle ACTIVE).
   */
  obligations(user: User, objectId: string, periode?: string) {
    const o = this.ctx.objects.get(objectId);
    if (!isEtablissement(o)) throw badRequest('PAS_UN_ETABLISSEMENT', 'Objet non enregistré comme établissement (catégorie activité).');
    authorize(user, 'citoyen:activites.read', { communes: [o.commune], ...(o.taxpayerId ? { taxpayerId: o.taxpayerId } : {}) });
    const annee = periode ?? String(this.now().getUTCFullYear());
    if (!/^\d{4}$/.test(annee)) throw badRequest('INVALID_PERIOD', 'Période AAAA attendue.');
    const cat = str(o.attributes['categorie']);
    const activite = norm(str(o.attributes['activite']) ?? str(o.attributes['objectType']) ?? '');
    const boissons = /boisson|bar|buvette|debit/.test(activite);
    const now = this.now();
    const regles = this.ctx.rules.list().filter((r) => r.code.startsWith('PAT-') || (boissons && r.code.startsWith('DEB-')))
      .filter((r) => !['ABROGEE', 'ARCHIVEE', 'BROUILLON'].includes(r.status))
      .filter((r) => !cat || !Object.keys(r.rateTable).some((k) => k.startsWith('categorie:')) || r.rateTable[`categorie:${cat}`] !== undefined)
      .filter((r) => r.effectiveFrom <= `${annee}-12-31` && (!r.effectiveTo || r.effectiveTo >= `${annee}-01-01`))
      .map((r) => { const ex = isRuleExecutable(r, now); return { code: r.code, version: r.version, libelle: r.label, statut: r.status, applicable: ex.ok, motif: ex.ok ? null : ex.reason, rang: o.localityRank }; });
    const titres = titresOf(this.ctx)?.types.all().filter((t) => t.module === '10' || (boissons && t.code.startsWith('DEB'))).map((t) => ({ code: t.code, libelle: t.label, acte: t.legalAct ?? null })) ?? [];
    const ob = this.ctx.assessment.obligations.find((x) => x.objectId === o.id && x.dueDate.startsWith(annee) && !x.supersededBy).map((x) => ({ id: x.id, libelle: x.label, montant: x.amount, statut: x.status, echeance: x.dueDate }));
    this.ctx.audit.append({ actor: actorOf(user), action: 'activites.obligations.determined', resourceType: 'fiscal_object', resourceId: o.id, details: { periode: annee, regles: regles.map((r) => r.code), applicables: regles.filter((r) => r.applicable).length } });
    return {
      objectId: o.id, periode: annee, lieu: { commune: o.commune, rang: o.localityRank }, activite: str(o.attributes['activite']) ?? null, categorie: cat ?? null,
      regles, titres, obligationsEmises: ob, patente: this.situationPatente(o.id),
      conclusion: regles.some((r) => r.applicable)
        ? 'Obligation(s) déterminée(s) par une règle ACTIVE du registre.'
        : 'Aucune règle ACTIVE : aucune obligation n’est due au titre de cette activité (acte requis ou fiche à vérifier).',
    };
  }

  // ─────────────── Signalement des commerces sans patente active ───────────────

  /** Détection sur le registre : établissements VALIDÉS sans patente active (liste de vérification, jamais une dette). */
  detecter(user: User) {
    authorize(user, 'citoyen:activites.signal');
    const created: SignalPatente[] = [];
    for (const o of this.ctx.objects.objects.find((x) => isEtablissement(x) && x.status === 'VALIDE')) {
      if (!evaluate(user, 'citoyen:activites.signal', { communes: [o.commune] })) continue;
      const s = this.situationPatente(o.id);
      if (s.active) continue;
      if (this.signaux.findOne((x) => x.objectId === o.id && (x.statut === 'A_VERIFIER' || x.statut === 'EN_MISSION'))) continue;
      created.push(this.ouvrir(user, {
        objectId: o.id, motif: s.derniere ? 'PATENTE_EXPIREE' : 'SANS_PATENTE_ACTIVE', source: 'REGISTRE',
        detail: s.derniere ? `Dernière patente ${s.derniere.numero} échue le ${s.derniere.validUntil.slice(0, 10)}.` : 'Aucune patente enregistrée pour cet établissement.',
      }));
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'activites.unlicensed.detected', resourceType: 'activites', resourceId: 'signaux', details: { crees: created.length } });
    return { crees: created.length, signaux: created, notice: 'Signal ⇒ vérification, jamais une dette. Une visite suppose une mission autorisée.' };
  }

  /** Signal saisi sur le terrain (commerce visible sans patente) : un objet enregistré est requis. */
  signaler(user: User, input: { objectId: string; detail: string }) {
    const o = this.ctx.objects.get(input.objectId);
    authorize(user, 'citoyen:activites.signal', { communes: [o.commune] });
    if (!isEtablissement(o)) throw badRequest('PAS_UN_ETABLISSEMENT', 'Objet non enregistré comme établissement.');
    const s = this.situationPatente(o.id);
    if (s.active) throw conflict('PATENTE_ACTIVE', `Patente active (${s.titre?.numero}) : aucun signal.`);
    return this.ouvrir(user, { objectId: o.id, motif: 'SANS_PATENTE_ACTIVE', source: 'RELEVE_TERRAIN', detail: input.detail });
  }

  private ouvrir(user: User, input: { objectId: string; motif: SignalPatente['motif']; source: SignalPatente['source']; detail: string }) {
    const o = this.ctx.objects.get(input.objectId);
    const s = this.signaux.insert({ id: this.ids.next('SPA'), objectId: o.id, commune: o.commune, motif: input.motif, source: input.source, detail: input.detail, statut: 'A_VERIFIER', ouvertLe: this.now().toISOString(), ouvertPar: user.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'activites.signal.opened', resourceType: 'fiscal_object', resourceId: o.id, details: { signal: s.id, motif: s.motif, source: s.source } });
    return s;
  }

  listeSignaux(user: User, statut?: string) {
    authorize(user, 'citoyen:activites.read');
    return this.signaux.find((s) => (!statut || s.statut === statut) && !!evaluate(user, 'citoyen:activites.read', { communes: [s.commune] })).map((s) => {
      const o = this.ctx.objects.objects.get(s.objectId);
      return { ...s, etablissement: o ? str(o.attributes['nom']) ?? 'Établissement' : null, igf: o?.igf?.code ?? null, quartier: o?.quartier ?? null };
    });
  }

  /** Visite : uniquement dans une mission autorisée du module terrain couvrant l'objet. */
  planifierVisite(user: User, id: string, missionId: string) {
    authorize(user, 'citoyen:activites.decide');
    const s = this.getSignal(id);
    if (s.statut !== 'A_VERIFIER') throw conflict('ETAT_INVALIDE', `Signal au statut ${s.statut}.`);
    const terrain = this.ctx.ext['terrain'] as { missions?: InMemoryRepository<{ id: string; objectIds: string[]; status?: string; commune: string }> } | undefined;
    const m = terrain?.missions?.get(missionId);
    if (!m) throw notFound('MISSION_INCONNUE', 'Pas de visite sans mission autorisée : mission inconnue.');
    if (!m.objectIds.includes(s.objectId)) throw conflict('HORS_MISSION', 'Pas de visite sans mission autorisée : l’établissement ne figure pas dans la mission.');
    if (m.status && ['ANNULEE', 'TERMINEE'].includes(m.status)) throw conflict('MISSION_NON_AUTORISEE', `Mission au statut ${m.status} : visite impossible.`);
    const out = this.signaux.update({ ...s, statut: 'EN_MISSION', missionId });
    this.ctx.audit.append({ actor: actorOf(user), action: 'activites.signal.mission_linked', resourceType: 'patente_signal', resourceId: id, details: { missionId } });
    return out;
  }

  decider(user: User, id: string, input: { statut: 'CONFIRME' | 'ECARTE'; motif: string }) {
    authorize(user, 'citoyen:activites.decide');
    const s = this.getSignal(id);
    if (s.statut === 'CONFIRME' || s.statut === 'ECARTE') throw conflict('SIGNAL_DECIDE', 'Signal déjà décidé.');
    const out = this.signaux.update({ ...s, statut: input.statut, decision: { par: user.id, at: this.now().toISOString(), motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'activites.signal.decided', resourceType: 'patente_signal', resourceId: id, details: { statut: input.statut, motif: input.motif } });
    return { ...out, suite: input.statut === 'CONFIRME' ? 'Invitation à régulariser (patente) par le circuit commun ; aucune sanction automatique.' : 'Signal écarté, motif conservé.' };
  }

  private getSignal(id: string) {
    const s = this.signaux.get(id);
    if (!s) throw notFound('SIGNAL_INCONNU', `Signal inconnu : ${id}`);
    return s;
  }

  // ─────────────── Recoupement (fichiers transmis sous protocole) ───────────────

  /**
   * Rapprochement d'un fichier transmis (codes marchands, livraisons, RCCM) : chaque ligne est rapprochée d'un
   * établissement par référence (RCCM, code marchand, plaque ou IGF) ou par nom + commune ; une ligne rapprochée d'un
   * établissement sans patente active ouvre un signal ; une ligne inconnue est listée (commerce non enregistré détecté).
   */
  recouper(user: User, input: { source: SourceRecoupement; lignes: { reference: string; nom?: string; commune?: string }[] }) {
    authorize(user, 'citoyen:activites.decide');
    if (!input.lignes.length) throw badRequest('LOT_VIDE', 'Fichier vide.');
    const etabs = this.ctx.objects.objects.find(isEtablissement);
    const orgs = accesOf(this.ctx)?.organisations.all() ?? [];
    const lot: LotRecoupement = { id: this.ids.next('RCP'), source: input.source, recuLe: this.now().toISOString(), recuPar: user.id, lignes: input.lignes.length, rapproches: 0, inconnus: [], signaux: [] };
    for (const l of input.lignes) {
      const ref = l.reference.trim().toUpperCase();
      const byRef = etabs.find((o) => [o.igf?.code, str(o.attributes['codeMarchand']), str(o.attributes['rccm']), o.id].filter(Boolean).map((x) => String(x).toUpperCase()).includes(ref))
        ?? (() => { const org = orgs.find((x) => x.rccmDeclared?.toUpperCase() === ref); return org ? etabs.find((o) => o.taxpayerId === org.taxpayerId) : undefined; })();
      const byName = !byRef && l.nom ? etabs.find((o) => norm(str(o.attributes['nom']) ?? '') === norm(l.nom!) && (!l.commune || o.commune === l.commune)) : undefined;
      const o = byRef ?? byName;
      if (!o) { lot.inconnus.push({ reference: ref, ...(l.nom ? { nom: l.nom } : {}), ...(l.commune ? { commune: l.commune } : {}) }); continue; }
      lot.rapproches++;
      if (!this.situationPatente(o.id).active && !this.signaux.findOne((x) => x.objectId === o.id && (x.statut === 'A_VERIFIER' || x.statut === 'EN_MISSION'))) {
        lot.signaux.push(this.ouvrir(user, { objectId: o.id, motif: 'RECOUPEMENT', source: input.source, detail: `${SOURCES_RECOUPEMENT[input.source]} : activité constatée (${ref}) sans patente active.` }).id);
      }
    }
    this.lots.insert(lot);
    this.ctx.audit.append({ actor: actorOf(user), action: 'activites.crosscheck.imported', resourceType: 'crosscheck_batch', resourceId: lot.id, details: { source: lot.source, lignes: lot.lignes, rapproches: lot.rapproches, inconnus: lot.inconnus.length, signaux: lot.signaux.length } });
    return { ...lot, protocole: 'Source sous protocole : fichier transmis et journalisé ; connexion directe à l’opérateur [À RACCORDER — convention requise].' };
  }

  indicateurs() {
    const etabs = this.ctx.objects.objects.find(isEtablissement);
    const now = this.now();
    const titres = titresOf(this.ctx);
    const pat = titres ? titres.credentials.find((c) => c.typeCode === PATENTE && c.state !== 'REMPLACE') : [];
    const actives = pat.filter((c) => c.state === 'EMIS' && ACTIVE_BANDS.includes(statusAt(c, now).status));
    // Renouvellement : patentes arrivées à échéance (ou renouvelées) dont un titre suivant existe.
    const echues = pat.filter((c) => c.validUntil <= now.toISOString() || pat.some((n) => n.renewsId === c.id));
    const renouvelees = echues.filter((c) => pat.some((n) => n.renewsId === c.id || (n.subject.objectId && n.subject.objectId === c.subject.objectId && n.validFrom >= c.validUntil.slice(0, 10))));
    const inconnus = this.lots.all().reduce((s, l) => s + l.inconnus.length, 0);
    return {
      etablissementsRecenses: { valeur: etabs.length, valides: etabs.filter((o) => o.status === 'VALIDE').length },
      patentesActives: { valeur: actives.length, acte: titres?.types.findOne((t) => t.code === PATENTE)?.legalAct ?? null },
      tauxRenouvellement: echues.length ? { valeur: pct(renouvelees.length, echues.length), numerateur: renouvelees.length, denominateur: echues.length } : { valeur: null, raison: 'Aucune patente arrivée à échéance : renouvellement non mesuré.' },
      commercesNonEnregistresDetectes: { valeur: this.signaux.find((s) => s.statut !== 'ECARTE').length + inconnus, signaux: this.signaux.count(), inconnusRecoupement: inconnus },
    };
  }
}
