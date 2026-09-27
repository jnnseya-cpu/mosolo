/**
 * Module 11 — Véhicules et circulation (Spécification fonctionnelle ; § 19A.4 titres VIG et TSC, § 10A.3 dépendances).
 *
 * La vignette et la taxe spéciale de circulation portent sur le MÊME objet véhicule (catégorie VEHICULE, plaque) et se
 * contrôlent par le MÊME scan de plaque (titres VIG-ANNUELLE et TSC-ANNUELLE, contrôle hors ligne par paquet signé).
 * Ce service ajoute :
 *  - le RÉFÉRENTIEL des véhicules : plaque, catégorie, usage, propriétaire (masqué selon le rôle), mutations ;
 *  - l'IMPORT ET LE RAPPROCHEMENT du registre des immatriculations (fichier transmis sous protocole avec le pouvoir
 *    central) : rapprochés, écarts (revue humaine), inconnus (à enrôler) — aucune création ni modification automatique ;
 *  - la LIQUIDATION PAR CATÉGORIE ET EXERCICE sur la règle ACTIVE « VIG-<catégorie> » du registre (sinon refus : acte
 *    requis J3) — jamais deux obligations pour un même véhicule, une même règle et un même exercice ;
 *  - l'affichage « payée / non régularisée » au contrôleur, avec la date du dernier paiement ; toute consultation par
 *    plaque est journalisée ; aucune immobilisation n'est décidée par l'algorithme ;
 *  - les relances à l'approche de l'échéance (rappel ambre des titres) et l'indicateur « mutations bloquées puis
 *    régularisées » (moteur de dépendances, service MUTATION_VEHICULE).
 */
import { isRuleExecutable, normalizePlate } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { actorOf } from '../../core/audit.js';
import { kinshasaDate } from '../../core/clock.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { statusAt } from '../titres/validity.js';
import { fiscalOf, pct, titresOf, verticalesOf } from './common.js';

const { always, inTerritory } = GRANTS;
definePolicy('citoyen:vehicules.read', { R01: always, R05: always, R06: always, R07: always, R11: always, R22: always, R24: always, R09: inTerritory('minimal'), R10: inTerritory('minimal') });
/** Propriétaire d'un véhicule : régie, contrôle et audit seulement (données sensibles masquées sinon). */
definePolicy('citoyen:vehicules.proprietaire', { R06: always, R07: always, R11: always, R22: always, R24: always });
definePolicy('citoyen:vehicules.import', { R06: always, R07: always, R11: always });
definePolicy('citoyen:vehicules.controle', { R06: always, R07: always, R11: always, R09: inTerritory('minimal'), R10: inTerritory('minimal'), R35: always });

export const CATEGORIES_VEHICULE = ['VOITURE', 'CAMIONNETTE', 'CAMION', 'BUS', 'MINIBUS', 'MOTO', 'TRICYCLE', 'ENGIN'] as const;
const VIGNETTE = 'VIG-ANNUELLE';
const TSC = 'TSC-ANNUELLE';
const ACTIVE_BANDS = ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'];

export interface LigneImmatriculation { plaque: string; categorie?: string; usage?: string; proprietaire?: string; dateImmatriculation?: string }
export interface LotImmatriculations {
  id: string;
  source: string;
  recuLe: string;
  recuPar: string;
  lignes: number;
  rapproches: { plaque: string; objectId: string }[];
  ecarts: { plaque: string; objectId: string; champ: string; registre: string; mosolo: string; statut: 'A_REVOIR' | 'REGISTRE_RETENU' | 'MOSOLO_RETENU'; decision?: { par: string; at: string; motif: string } }[];
  inconnus: { plaque: string; categorie?: string; usage?: string }[];
}

const plateOf = (o: FiscalObject) => {
  const p = o.attributes['plaque'] ?? o.attributes['immatriculation'];
  return typeof p === 'string' && p.trim() ? normalizePlate(p) : undefined;
};
const catOf = (o: FiscalObject) => String(o.attributes['categorie'] ?? o.attributes['categorieVehicule'] ?? '').toUpperCase() || null;

export class VehiculesService {
  readonly lots = new InMemoryRepository<LotImmatriculations>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now() { return this.ctx.clock.now(); }

  vehicules(): FiscalObject[] {
    return this.ctx.objects.objects.find((o) => o.category === 'VEHICULE' && !!plateOf(o));
  }

  parPlaque(plaque: string): FiscalObject | undefined {
    const p = normalizePlate(plaque);
    return this.vehicules().find((o) => plateOf(o) === p);
  }

  private titresPlaque(plaque: string) {
    const titres = titresOf(this.ctx);
    if (!titres) return [];
    return titres.byPlate(plaque, '11').filter((c) => c.state !== 'REMPLACE');
  }

  /** Mutations connues : démarches de mutation de la verticale Mobilité et relations closes pour vente ou mutation. */
  mutations(o: FiscalObject) {
    const vx = verticalesOf(this.ctx);
    const cases = vx ? vx.cases.find((c) => c.objectId === o.id && c.type === 'DECLARATION_MUTATION').map((c) => ({ nature: 'DEMARCHE', id: c.id, statut: c.status, date: c.details['dateMutation'] ?? c.createdAt.slice(0, 10), decision: c.decision?.outcome ?? null })) : [];
    const rels = fiscalOf(this.ctx)?.relations.relations.find((r) => r.objectId === o.id && r.status === 'CLOSE' && (r.closeReason === 'VENTE' || r.closeReason === 'MUTATION')).map((r) => ({ nature: 'RELATION_CLOSE', id: r.id, statut: r.closeReason ?? 'CLOSE', date: r.to ?? '', decision: null })) ?? [];
    return [...cases, ...rels].sort((a, b) => a.date.localeCompare(b.date));
  }

  referentiel(user: User, filtre: { commune?: string; categorie?: string; plaque?: string } = {}) {
    authorize(user, 'citoyen:vehicules.read', filtre.commune ? { communes: [filtre.commune] } : {});
    const voitProprio = !!evaluate(user, 'citoyen:vehicules.proprietaire');
    const plaque = filtre.plaque ? normalizePlate(filtre.plaque) : undefined;
    if (plaque) this.journaliserPlaque(user, plaque, 'referentiel');
    return this.vehicules().filter((o) => (!filtre.commune || o.commune === filtre.commune) && (!filtre.categorie || catOf(o) === filtre.categorie.toUpperCase()) && (!plaque || plateOf(o) === plaque) && !!evaluate(user, 'citoyen:vehicules.read', { communes: [o.commune] }))
      .map((o) => {
        const tp = o.taxpayerId ? this.ctx.taxpayers.taxpayers.get(o.taxpayerId) : undefined;
        return {
          objectId: o.id, plaque: plateOf(o)!, categorie: catOf(o), usage: String(o.attributes['usage_vehicule'] ?? o.attributes['usage'] ?? '') || null,
          proprietaire: voitProprio ? (tp ? { id: tp.id, nom: tp.fullName } : null) : (tp ? { id: null, nom: `${tp.fullName.slice(0, 1)}***` } : null),
          commune: o.commune, statut: o.status, mutations: this.mutations(o), situation: this.situation(plateOf(o)!),
        };
      });
  }

  /** « Payée / non régularisée » : vignette et TSC de l'exercice, avec la date du dernier paiement (heure serveur). */
  situation(plaque: string) {
    const now = this.now();
    const exercice = String(now.getUTCFullYear());
    const titres = this.titresPlaque(plaque);
    const vue = (code: string) => {
      const list = titres.filter((c) => c.typeCode === code).sort((a, b) => b.validUntil.localeCompare(a.validUntil));
      const valide = list.find((c) => c.state === 'EMIS' && ACTIVE_BANDS.includes(statusAt(c, now).status));
      const type = titresOf(this.ctx)?.types.findOne((t) => t.code === code);
      return {
        code, statut: valide ? 'PAYEE' as const : 'NON_REGULARISEE' as const,
        titre: valide ? { numero: valide.number, validUntil: valide.validUntil, texte: statusAt(valide, now).text } : null,
        exigible: type?.legalAct?.status !== 'ACTE_REQUIS', acte: type?.legalAct?.status ?? null,
      };
    };
    const o = this.parPlaque(plaque);
    const obls = o ? this.ctx.assessment.obligations.find((x) => x.objectId === o.id && !x.supersededBy) : [];
    const paiements = [
      ...titres.map((c) => c.issuedAt),
      ...obls.flatMap((x) => this.ctx.payments.orders.find((p) => p.obligationId === x.id && ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status)).map((p) => p.confirmedAt ?? p.createdAt)),
    ].sort();
    return {
      plaque: normalizePlate(plaque), exercice, vignette: vue(VIGNETTE), taxeCirculation: vue(TSC),
      dernierPaiement: paiements.at(-1) ?? null,
      obligationsOuvertes: obls.filter((x) => ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(x.status)).length,
      heureServeur: now.toISOString(),
      notice: 'Aucune immobilisation décidée par l’algorithme : un constat éventuel est instruit par une personne habilitée.',
    };
  }

  private journaliserPlaque(user: User, plaque: string, motif: string) {
    this.ctx.audit.append({ actor: actorOf(user), action: 'vehicule.plate.consulted', resourceType: 'vehicle_plate', resourceId: plaque, details: { motif } });
  }

  /** Contrôle par plaque (contrôleur routier) : statut instantané, consultation journalisée. */
  controle(user: User, plaque: string, commune?: string) {
    authorize(user, 'citoyen:vehicules.controle', commune ? { communes: [commune] } : {});
    const p = normalizePlate(plaque);
    if (p.length < 4) throw badRequest('INVALID_PLATE', 'Plaque illisible.');
    this.journaliserPlaque(user, p, 'controle');
    const s = this.situation(p);
    const o = this.parPlaque(p);
    return { ...s, enregistre: !!o, categorie: o ? catOf(o) : null, horsLigne: 'Le même statut est disponible hors ligne par le paquet signé des titres (GET /v1/titres/hors-ligne/paquet?module=11).' };
  }

  // ─────────────── Registre des immatriculations ───────────────

  importer(user: User, input: { source: string; lignes: LigneImmatriculation[] }) {
    authorize(user, 'citoyen:vehicules.import');
    if (!input.lignes.length) throw badRequest('LOT_VIDE', 'Fichier vide.');
    const lot: LotImmatriculations = { id: this.ids.next('IMM'), source: input.source, recuLe: this.now().toISOString(), recuPar: user.id, lignes: input.lignes.length, rapproches: [], ecarts: [], inconnus: [] };
    const vus = new Set<string>();
    for (const l of input.lignes) {
      const plaque = normalizePlate(l.plaque);
      if (plaque.length < 4 || vus.has(plaque)) continue;
      vus.add(plaque);
      const o = this.parPlaque(plaque);
      if (!o) { lot.inconnus.push({ plaque, ...(l.categorie ? { categorie: l.categorie.toUpperCase() } : {}), ...(l.usage ? { usage: l.usage } : {}) }); continue; }
      lot.rapproches.push({ plaque, objectId: o.id });
      const cat = catOf(o);
      if (l.categorie && cat && l.categorie.toUpperCase() !== cat) lot.ecarts.push({ plaque, objectId: o.id, champ: 'categorie', registre: l.categorie.toUpperCase(), mosolo: cat, statut: 'A_REVOIR' });
      const usage = String(o.attributes['usage_vehicule'] ?? o.attributes['usage'] ?? '');
      if (l.usage && usage && l.usage.trim().toLowerCase() !== usage.trim().toLowerCase()) lot.ecarts.push({ plaque, objectId: o.id, champ: 'usage', registre: l.usage, mosolo: usage, statut: 'A_REVOIR' });
    }
    this.lots.insert(lot);
    this.ctx.audit.append({ actor: actorOf(user), action: 'vehicule.registry.imported', resourceType: 'registry_batch', resourceId: lot.id, details: { source: lot.source, lignes: lot.lignes, rapproches: lot.rapproches.length, ecarts: lot.ecarts.length, inconnus: lot.inconnus.length } });
    return { ...lot, notice: 'Rapprochement seulement : aucun véhicule créé ni modifié automatiquement ; les écarts sont revus par une personne, les inconnus sont à enrôler.', protocole: 'Flux direct du registre national des immatriculations [À RACCORDER — convention requise] ; fichier transmis accepté.' };
  }

  deciderEcart(user: User, lotId: string, input: { plaque: string; champ: string; retenu: 'REGISTRE_RETENU' | 'MOSOLO_RETENU'; motif: string }) {
    authorize(user, 'citoyen:vehicules.import');
    const lot = this.lots.get(lotId);
    if (!lot) throw notFound('LOT_INCONNU', `Lot inconnu : ${lotId}`);
    const e = lot.ecarts.find((x) => x.plaque === normalizePlate(input.plaque) && x.champ === input.champ && x.statut === 'A_REVOIR');
    if (!e) throw notFound('ECART_INCONNU', 'Écart inconnu ou déjà revu.');
    const ecarts = lot.ecarts.map((x) => (x === e ? { ...x, statut: input.retenu, decision: { par: user.id, at: this.now().toISOString(), motif: input.motif } } : x));
    this.lots.update({ ...lot, ecarts });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vehicule.registry.gap_decided', resourceType: 'vehicle_plate', resourceId: e.plaque, details: { lot: lotId, champ: e.champ, retenu: input.retenu, motif: input.motif } });
    return { ...e, statut: input.retenu, suite: input.retenu === 'REGISTRE_RETENU' ? 'Correction de l’objet à porter par le circuit de correction à double validation (aucune modification automatique).' : 'Donnée MOSOLO conservée ; écart clos.' };
  }

  // ─────────────── Liquidation par catégorie et exercice ───────────────

  regleVignette(categorie: string) {
    const code = `VIG-${categorie.toUpperCase()}`;
    return this.ctx.rules.list().filter((r) => r.code === code && isRuleExecutable(r, this.now()).ok).sort((a, b) => b.version - a.version)[0];
  }

  liquider(user: User, input: { categorie: string; exercice: string }) {
    authorize(user, 'assessment.liquidate');
    if (!/^\d{4}$/.test(input.exercice)) throw badRequest('INVALID_PERIOD', 'Exercice AAAA attendu.');
    const regle = this.regleVignette(input.categorie);
    if (!regle) throw unprocessable('REGLE_NON_PUBLIEE', `Aucune règle ACTIVE « VIG-${input.categorie.toUpperCase()} » au registre : liquidation impossible (acte requis J3 — barèmes véhicules).`);
    const cibles = this.vehicules().filter((o) => catOf(o) === input.categorie.toUpperCase());
    const out = { regle: { code: regle.code, version: regle.version }, exercice: input.exercice, liquidees: [] as string[], dejaLiquidees: [] as string[], sansRedevable: [] as string[] };
    for (const o of cibles) {
      if (!o.taxpayerId) { out.sansRedevable.push(plateOf(o)!); continue; }
      const deja = this.ctx.assessment.obligations.findOne((x) => x.objectId === o.id && x.ruleCode === regle.code && !x.supersededBy && x.status !== 'ANNULEE' && (x.explanation as { period?: string }).period === input.exercice)
        ?? this.ctx.assessment.obligations.findOne((x) => x.objectId === o.id && x.ruleCode === regle.code && !x.supersededBy && x.status !== 'ANNULEE' && x.createdAt.startsWith(input.exercice));
      if (deja) { out.dejaLiquidees.push(plateOf(o)!); continue; }
      const r = this.ctx.assessment.calculate(user, { ruleId: regle.id, taxpayerId: o.taxpayerId, objectId: o.id, inputs: {}, simulate: false });
      if (r.obligation) out.liquidees.push(r.obligation.id);
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'vehicule.liquidation.batch', resourceType: 'rule', resourceId: regle.id, details: { categorie: input.categorie, exercice: input.exercice, liquidees: out.liquidees.length, deja: out.dejaLiquidees.length } });
    return out;
  }

  // ─────────────── Mutations ───────────────

  /** Vérification de mutation (moteur de dépendances) : bloquée sans quitus lorsque la règle l'exige ; journalisée. */
  verifierMutation(user: User, plaque: string) {
    const o = this.parPlaque(plaque);
    if (!o) throw notFound('VEHICULE_INCONNU', 'Véhicule inconnu pour cette plaque.');
    if (!o.taxpayerId) throw unprocessable('SANS_PROPRIETAIRE', 'Véhicule sans propriétaire rattaché.');
    const fiscal = fiscalOf(this.ctx);
    if (!fiscal) throw unprocessable('MODULE_ABSENT', 'Moteur de dépendances indisponible.');
    return fiscal.dependencies.check(user, 'MUTATION_VEHICULE', o.taxpayerId, { plate: plateOf(o)! });
  }

  indicateurs() {
    const vs = this.vehicules();
    const now = this.now();
    const couverts = vs.filter((o) => this.titresPlaque(plateOf(o)!).some((c) => c.typeCode === VIGNETTE && c.state === 'EMIS' && ACTIVE_BANDS.includes(statusAt(c, now).status)));
    const obls = this.ctx.assessment.obligations.find((x) => x.ruleCode.startsWith('VIG-') && !x.supersededBy && x.status !== 'ANNULEE');
    const vig = titresOf(this.ctx)?.credentials.find((c) => c.typeCode === VIGNETTE) ?? [];
    const payees = obls.filter((x) => x.status === 'SOLDEE').length;
    const controles = titresOf(this.ctx)?.controls.find((c) => c.module === '11' || c.typeCode === VIGNETTE || c.typeCode === TSC) ?? [];
    const consultations = this.ctx.audit.list({ action: 'vehicule.plate.consulted' }).items.filter((r) => (r.details as { motif?: string } | undefined)?.motif === 'controle');
    const jours = new Map<string, number>();
    for (const c of controles) jours.set(kinshasaDate(new Date(c.at)), (jours.get(kinshasaDate(new Date(c.at))) ?? 0) + 1);
    for (const c of consultations) jours.set(kinshasaDate(new Date(c.at)), (jours.get(kinshasaDate(new Date(c.at))) ?? 0) + 1);
    const checks = fiscalOf(this.ctx)?.dependencies.checks.find((c) => c.service === 'MUTATION_VEHICULE') ?? [];
    const bloques = new Set(checks.filter((c) => c.blocked).map((c) => c.taxpayerId));
    const regularises = [...bloques].filter((tp) => { const firstBlock = checks.find((c) => c.taxpayerId === tp && c.blocked)!; return checks.some((c) => c.taxpayerId === tp && !c.blocked && c.at > firstBlock.at); });
    const totalControles = [...jours.values()].reduce((s, n) => s + n, 0);
    return {
      couvertureParc: { valeur: pct(couverts.length, vs.length), numerateur: couverts.length, denominateur: vs.length, definition: 'Véhicules à vignette valide / véhicules enregistrés.', ...(vs.length ? {} : { raison: 'Aucun véhicule enregistré.' }) },
      tauxPaiement: obls.length
        ? { valeur: pct(payees, obls.length), numerateur: payees, denominateur: obls.length, definition: 'Obligations de vignette soldées / émises.' }
        : { valeur: vig.length ? pct(vig.filter((c) => c.state === 'EMIS').length, vig.length) : null, raison: 'Aucune obligation de vignette liquidée (règle non ACTIVE, acte J3) : taux calculé sur les titres de vignette émis seulement.' },
      controlesParJour: jours.size ? { valeur: (Math.round((totalControles / jours.size) * 10) / 10).toFixed(1), jours: jours.size, total: totalControles } : { valeur: null, raison: 'Aucun contrôle de plaque enregistré.' },
      mutationsBloqueesPuisRegularisees: { bloquees: bloques.size, regularisees: regularises.length, valeur: pct(regularises.length, bloques.size), ...(bloques.size ? {} : { raison: 'Aucune mutation bloquée (conditions informatives tant que l’acte n’est pas publié).' }) },
      lotsImmatriculations: this.lots.count(),
    };
  }
}
