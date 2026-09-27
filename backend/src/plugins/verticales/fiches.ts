/**
 * Fiches sectorielles (Spécification fonctionnelle, modules 13 à 25) — fonctions construites PAR-DESSUS les modules
 * sectoriels « acte requis » (secteurs.ts), le moteur de titres (§ 19A), la liquidation commune et le circuit de paiement :
 *
 *  - configuration par module : règle du registre (code) et type de titre, fixés par la régie avec la référence de l'acte
 *    (aucune valeur par défaut : sans règle ACTIVE, le module reste en « acte requis ») ;
 *  - registres géoréférencés : points d'embarquement rattachés à un opérateur, quais et ports privés, axes et points de
 *    péage (références) ; sites télécoms, carrières, concessions forestières, embarcations (objets du cadastre commun) ;
 *  - 13/24 : départs, manifestes, titres par passager ou par départ (paiement Mobile Money ou point agréé, jamais à
 *    l'agent), mouvements (départ, arrivée), rapprochement manifeste ↔ titres ↔ paiements, contrôle d'une embarcation ;
 *  - 16 : import des listes de sites (opérateur, régulateur), liquidation ANNUELLE AUTOMATIQUE par site sur règle ACTIVE
 *    (idempotente par site et exercice, avis d'imposition, suivi du règlement), mutation de site entre opérateurs
 *    (décision d'une autre personne), recouvrement par opérateur, suivi par la cellule grands redevables (module 56) ;
 *  - 17 : points de livraison (partenaire sous protocole), carte restreinte, points non autorisés transmis au module 10,
 *    cohérence mensuelle des volumes, suivi des paiements et relances par redevable ;
 *  - 19 : rattachement automatique au portefeuille d'objets existants, application de la règle, avis unique par objet ;
 *  - 20 : rapprochement occupations ↔ titres ↔ paiements par marché ; 21 : recettes par événement ;
 *  - 22/23 : liquidation automatique sur superficie (règle ACTIVE), volumes validés ; accès restreint aux forêts ;
 *  - 25 : passage consommé à chaque franchissement (moteur de titres), solde d'un carnet, fraude détectée ;
 *  - indicateurs de chaque fiche, calculés sur les données (ou « non mesuré » avec la raison : donnée source absente).
 *
 * Doctrine : une liquidation sur une règle publiée et ACTIVE n'est pas une sanction — elle est automatique quand la fiche
 * le prévoit (16, 22, 23 ; 19 sur commande de la régie), idempotente et tracée ; sans règle ACTIVE, seule une PROPOSITION
 * (bases, sans montant) est produite. Écarts, constats et pénalités restent décidés par une personne (aucune sanction
 * automatique) ; la personne qui décide est distincte de celle qui propose.
 */
import { runScheduledJob } from '../../core/jobs.js';
import { normalizePlate, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { dec, decToString } from '../../core/decimal.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { pct } from '../../core/percent.js';
import { assertDistinctPerson, authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import type { PaymentChannel } from '../../modules/payments/service.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { isCommune } from '../../reference/kinshasa.js';
import { activeRule, enginePrincipal, latestRule, paymentState, perUnit, sumByCurrency } from '../parking/support.js';
import type { TitresService } from '../titres/service.js';
import { statusAt } from '../titres/validity.js';
import { P } from './policies.js';
import { SECTOR_ENTITY, type SectorReference } from './secteurs.js';
import type { VerticalesService } from './service.js';

/** Modules couverts par les fiches (ordre de la Spécification fonctionnelle). */
export const FICHE_MODULES = ['13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25'] as const;

/** Objets sectoriels du cadastre commun : type, verticale de rattachement et attributs exigés à l'enregistrement. */
export const SECTOR_OBJECTS: Record<string, { objectType: string; vertical: string; label: string; attributes: { key: string; label: string; decimal?: boolean; required: boolean }[] }> = {
  '16': { objectType: 'SITE_TELECOM', vertical: 'telecom', label: 'Site ou pylône télécom', attributes: [
    { key: 'reference', label: 'Référence du site (liste de l’opérateur)', required: true }, { key: 'type', label: 'Type (pylône, toit, autre)', required: true },
    { key: 'emprise_m2', label: 'Emprise (m²)', decimal: true, required: false }] },
  '22': { objectType: 'CARRIERE', vertical: 'construction', label: 'Site d’extraction (carrière)', attributes: [
    { key: 'nom', label: 'Nom du site', required: true }, { key: 'superficie_ha', label: 'Superficie (ha)', decimal: true, required: true }, { key: 'titre', label: 'Titre d’exploitation', required: true }] },
  '23': { objectType: 'CONCESSION_FORESTIERE', vertical: 'environnement', label: 'Concession forestière', attributes: [
    { key: 'nom', label: 'Nom de la concession', required: true }, { key: 'superficie_ha', label: 'Superficie (ha)', decimal: true, required: true }, { key: 'titre', label: 'Titre de concession', required: true }] },
  '24': { objectType: 'EMBARCATION', vertical: 'ports', label: 'Embarcation', attributes: [
    { key: 'identifiant', label: 'Identifiant (immatriculation)', required: true }, { key: 'capacite_passagers', label: 'Capacité (passagers)', decimal: true, required: true },
    { key: 'capacite_tonnes', label: 'Capacité (tonnes)', decimal: true, required: false }, { key: 'nom', label: 'Nom de l’embarcation', required: false }] },
};

/** Modules dont la liquidation est AUTOMATIQUE sur règle ACTIVE (fiche : « liquidation annuelle automatique », « sur superficie »). */
export const AUTO_LIQUIDATION_MODULES = ['16', '22', '23'] as const;
/** Canaux admis au point de départ (§ 18A) : Mobile Money (y compris par USSD) ou point agréé — jamais l'agent. */
export const DEPARTURE_CHANNELS: PaymentChannel[] = ['MOBILE_MONEY', 'USSD', 'AGENT_POINT'];

const DECIMAL = /^\d{1,12}(\.\d{1,4})?$/;
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
/** Acteur technique de la liquidation automatique (piste d'audit : acteur « system »). */
export const AUTO_ACTOR = 'fiches-liquidation-automatique';
/** Intervalle par défaut du passage automatique (1 heure) — paramètre technique par défaut, à confirmer par le maître d'ouvrage. */
export const AUTO_RUN_DEFAULT_MS = 3_600_000;
const near = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0005; // ≈ 50 m

export interface ModuleConfig {
  module: string;
  ruleCode: string | null;
  credentialTypeCode: string | null;
  /** Types de titres supplémentaires retenus pour le module (ex. carnet et abonnement du péage). */
  extraCredentialTypeCodes?: string[];
  /** Module 19 : catégories d'objets du portefeuille auquel la règle s'applique. */
  objectCategories: string[];
  actReference: string;
  history: { by: string; at: string; ruleCode: string | null; credentialTypeCode: string | null; objectCategories: string[]; actReference: string; motif: string }[];
}

export interface Departure {
  id: string;
  module: '13';
  pointId: string;
  commune: string;
  embarcationId?: string;
  operatorTaxpayerId: string;
  destination: string;
  scheduledAt: string;
  titleMode: 'PAR_PASSAGER' | 'PAR_DEPART';
  status: 'PREVU' | 'PARTI' | 'ARRIVE' | 'ANNULE';
  manifest?: { passengers: number; volumeT: string | null; documents: string[]; by: string; at: string };
  manifestHistory: { passengers: number; volumeT: string | null; by: string; at: string }[];
  issuanceIds: string[];
  events: { at: string; by: string; kind: 'DECLARE' | 'MANIFESTE' | 'TITRES' | 'EMBARQUEMENT' | 'DEPART' | 'ARRIVEE' | 'ANNULE'; note?: string }[];
  arrivalPointId?: string;
  createdBy: string;
  createdAt: string;
}

export type LiquidationStatus = 'ACTE_REQUIS' | 'BASE_INCOMPLETE' | 'PROPOSEE' | 'EXECUTEE' | 'REJETEE';
export interface SectorLiquidation {
  id: string;
  module: string;
  objectId: string;
  taxpayerId: string;
  period: string;
  /** Module 24 : liquidation d'un mouvement (départ) précis ; sinon liquidation de la période. */
  movementId?: string;
  basis: Record<string, string>;
  mode: 'AUTOMATIQUE' | 'PROPOSITION';
  ruleCode: string | null;
  ruleVersion: number | null;
  status: LiquidationStatus;
  simulated?: MoneyJSON;
  proposedBy: string;
  proposedAt: string;
  note: string;
  decision?: { by: string; at: string; decision: 'EXECUTER' | 'REJETER'; motif: string };
  obligationId?: string;
  noticeId?: string;
  /** Avis produit à l'exécution : avis d'imposition numéroté, ou notification du moteur de liquidation. */
  notice?: 'AVIS_IMPOSITION' | 'NOTIFICATION';
  executedAt?: string;
}

export interface SiteImport { id: string; source: 'OPERATEUR' | 'REGULATEUR'; operatorTaxpayerId: string; fileSha256: string | null; received: number; created: number; known: number; by: string; at: string }
export interface SiteMutation {
  id: string; objectId: string; fromTaxpayerId: string | null; toTaxpayerId: string; dateEffet: string; documents: string[]; motif: string;
  status: 'PROPOSEE' | 'ACCEPTEE' | 'REFUSEE'; proposedBy: string; proposedAt: string; decision?: { by: string; at: string; motif: string };
}
export interface TollPassage {
  id: string; pointId: string; axisLabel: string; commune: string; plate: string; at: string; by: string; observationId: string;
  controlId: string | null; result: 'VALIDE' | 'INVALIDE' | 'EXPIRE' | 'ACTE_REQUIS'; fraud: boolean; constatId: string | null;
}
export interface DeliveryPoint { id: string; label: string; commune: string; quartier: string | null; lat: number; lon: number; establishmentRef: string | null; suppliers: string[]; firstAt: string }
export interface DeliveryRecord { id: string; pointId: string; supplierTaxpayerId: string; period: string; volumeLitres: string; fileSha256: string | null; by: string; at: string }
export interface Transmission { id: string; target: '10'; pointIds: string[]; motif: string; by: string; at: string }
export interface Reminder { id: string; taxpayerId: string; kind: 'DECLARATION' | 'PAIEMENT'; motif: string; by: string; at: string }
export interface SlipOrder { id: string; objectId: string; issuanceId: string; plates: string[]; typeCode: string; channel: PaymentChannel; by: string; at: string }
export interface ExitPassage { id: string; objectId: string; plate: string | null; presented: 'QR' | 'CODE_COURT' | 'PLAQUE'; observationId: string; controlId: string | null; result: 'VALIDE' | 'INVALIDE' | 'EXPIRE' | 'ACTE_REQUIS' | 'AUTRE_SITE'; alreadyUsed: boolean; constatId: string | null; by: string; at: string }
export interface Boarding { id: string; departureId: string; controlId: string | null; result: 'VALIDE' | 'INVALIDE' | 'EXPIRE' | 'AUTRE_DEPART'; alreadyUsed: boolean; text: string; by: string; at: string }
export interface ForestDeclaration { id: string; pointId: string; commune: string; produit: string; quantiteKg: string; taxpayerId: string | null; declarant: string; plate: string | null; observationId: string; by: string; at: string }
export interface StallSubscription { id: string; stallId: string; taxpayerId: string; status: 'ACTIF' | 'RESILIE'; consentAt: string; consentBy: string; renewals: { at: string; obligationId: string }[]; endedAt?: string; endedBy?: string }
export interface GroupedNotice { id: string; objectId: string; taxpayerId: string; exercice: string; obligationIds: string[]; totals: MoneyJSON[]; by: string; at: string }

export class FichesService {
  readonly configs = new InMemoryRepository<ModuleConfig & { id: string }>();
  readonly departures = new InMemoryRepository<Departure>();
  readonly liquidations = new InMemoryRepository<SectorLiquidation>();
  readonly siteImports = new InMemoryAppendOnlyRepository<SiteImport>();
  readonly mutations = new InMemoryRepository<SiteMutation>();
  readonly passages = new InMemoryAppendOnlyRepository<TollPassage>();
  readonly deliveryPoints = new InMemoryRepository<DeliveryPoint>();
  readonly deliveries = new InMemoryAppendOnlyRepository<DeliveryRecord>();
  readonly transmissions = new InMemoryAppendOnlyRepository<Transmission>();
  readonly reminders = new InMemoryAppendOnlyRepository<Reminder>();
  readonly groupedNotices = new InMemoryRepository<GroupedNotice>();
  readonly slipOrders = new InMemoryAppendOnlyRepository<SlipOrder>();
  readonly exits = new InMemoryAppendOnlyRepository<ExitPassage>();
  readonly boardings = new InMemoryAppendOnlyRepository<Boarding>();
  readonly forestDeclarations = new InMemoryAppendOnlyRepository<ForestDeclaration>();
  readonly stallSubscriptions = new InMemoryRepository<StallSubscription>();
  private readonly ids = new IdGenerator();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Dernier passage de la liquidation automatique (affiché à la régie). */
  lastRun: { at: string; exercice: string; modules: { module: string; status: string; executed: number; errors: number }[] } | null = null;
  /** Intervalle du passage planifié (null : planificateur arrêté). */
  schedulerMs: number | null = null;
  /** Module 18 (branché par le module d'extension). */
  plastique?: { indicators(): { assujettis: number; simulations: number } };

  constructor(private readonly ctx: AppContext, private readonly vx: VerticalesService) {}

  private now(): Date { return this.ctx.clock.now(); }
  private exercice(): string { return kinshasaDate(this.now()).slice(0, 4); }
  private titres(): TitresService | undefined { return this.ctx.ext.titres as TitresService | undefined; }
  private res(extra: Record<string, unknown> = {}) { return { entity: SECTOR_ENTITY, ...extra }; }

  // ================================================================== configuration par module (règle, type de titre)

  config(module: string): ModuleConfig {
    const c = this.configs.get(module);
    return c ?? { module, ruleCode: null, credentialTypeCode: null, objectCategories: [], actReference: '', history: [] };
  }

  /** Types de titres retenus par la régie pour le module (type principal puis types supplémentaires). */
  configuredTypes(module: string): string[] {
    const c = this.configs.get(module);
    return c ? [...new Set([...(c.credentialTypeCode ? [c.credentialTypeCode] : []), ...(c.extraCredentialTypeCodes ?? [])])] : [];
  }

  /** Règle ACTIVE du module (null ⇒ acte requis) et statut lisible. */
  ruleStatus(module: string): { ruleCode: string | null; active: RuleRecord | null; status: string } {
    const c = this.config(module);
    const active = activeRule(this.ctx, c.ruleCode);
    const latest = latestRule(this.ctx, c.ruleCode);
    return { ruleCode: c.ruleCode, active, status: active ? 'ACTIVE' : latest ? latest.status : 'ACTE_REQUIS' };
  }

  setConfig(user: User, module: string, input: { ruleCode: string | null; credentialTypeCode?: string | null; extraCredentialTypeCodes?: string[]; objectCategories?: string[]; actReference: string; motif: string }) {
    if (!(FICHE_MODULES as readonly string[]).includes(module)) throw notFound('FICHE_MODULE_NOT_FOUND', `Module sans fiche : ${module}`);
    authorize(user, P.sectorConfigure, this.res());
    if (input.ruleCode && !latestRule(this.ctx, input.ruleCode)) throw unprocessable('UNKNOWN_RULE', `Règle inconnue du registre : ${input.ruleCode}`);
    const t = this.titres();
    for (const code of [...(input.credentialTypeCode ? [input.credentialTypeCode] : []), ...(input.extraCredentialTypeCodes ?? [])]) {
      const type = t?.types.findOne((x) => x.code === code);
      if (!type) throw unprocessable('UNKNOWN_CREDENTIAL_TYPE', `Type de titre inconnu : ${code}`);
      if (type.module !== module) throw unprocessable('CREDENTIAL_TYPE_OTHER_MODULE', `Le type ${type.code} relève du module ${type.module}.`);
    }
    const prev = this.config(module);
    const at = this.now().toISOString();
    const next = {
      id: module, module, ruleCode: input.ruleCode, credentialTypeCode: input.credentialTypeCode === undefined ? prev.credentialTypeCode : input.credentialTypeCode,
      extraCredentialTypeCodes: input.extraCredentialTypeCodes ?? prev.extraCredentialTypeCodes ?? [], objectCategories: input.objectCategories ?? prev.objectCategories,
      actReference: input.actReference,
      history: [...prev.history, { by: user.id, at, ruleCode: input.ruleCode, credentialTypeCode: input.credentialTypeCode === undefined ? prev.credentialTypeCode : input.credentialTypeCode, objectCategories: input.objectCategories ?? prev.objectCategories, actReference: input.actReference, motif: input.motif }],
    };
    const saved = this.configs.get(module) ? this.configs.update(next) : this.configs.insert(next);
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.fiche.configured', resourceType: 'sector_module', resourceId: module, details: { ruleCode: input.ruleCode, credentialTypeCode: saved.credentialTypeCode, actReference: input.actReference, motif: input.motif } });
    return { ...saved, rule: this.ruleView(module) };
  }

  private ruleView(module: string) {
    const r = this.ruleStatus(module);
    return { ruleCode: r.ruleCode, status: r.status, version: r.active?.version ?? null, demo: r.active?.demo === true };
  }

  // ================================================================== registres géoréférencés

  registerReference(user: User, input: { module: string; kind: SectorReference['kind']; label: string; commune: string; lat: number; lon: number; operatorTaxpayerId?: string; privateQuay?: boolean }) {
    authorize(user, P.sectorReference, this.res());
    const allowed: Record<string, SectorReference['kind'][]> = { '13': ['POINT_EMBARQUEMENT'], '24': ['QUAI'], '25': ['AXE', 'POINT_PEAGE'], '23': ['POINT_CONTROLE'] };
    if (!allowed[input.module]?.includes(input.kind)) throw badRequest('REFERENCE_KIND_NOT_APPLICABLE', `Référence ${input.kind} non prévue pour le module ${input.module}.`);
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    if (input.module === '13' && !input.operatorTaxpayerId) throw badRequest('OPERATOR_REQUIRED', 'Un point d’embarquement est rattaché à un opérateur.');
    if (input.operatorTaxpayerId) this.ctx.taxpayers.get(input.operatorTaxpayerId);
    const r: SectorReference = {
      id: this.ids.next(`REF-${input.module}`), module: input.module, kind: input.kind, label: input.label, commune: input.commune, lat: input.lat, lon: input.lon, demo: false,
      ...(input.operatorTaxpayerId ? { operatorTaxpayerId: input.operatorTaxpayerId } : {}), ...(input.privateQuay !== undefined ? { privateQuay: input.privateQuay } : {}),
    };
    this.vx.secteurs.references.insert(r);
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.reference.registered', resourceType: 'sector_reference', resourceId: r.id, details: { module: r.module, kind: r.kind, commune: r.commune, operator: r.operatorTaxpayerId ?? null } });
    return r;
  }

  private reference(id: string, module?: string): SectorReference {
    const r = this.vx.secteurs.references.get(id);
    if (!r || (module && r.module !== module)) throw notFound('SECTOR_REFERENCE_NOT_FOUND', `Référence inconnue${module ? ` pour le module ${module}` : ''} : ${id}`);
    return r;
  }

  /** Objet sectoriel (site, carrière, concession, embarcation) enregistré au cadastre commun ; plaque QR facultative. */
  registerObject(user: User, input: { module: string; taxpayerId?: string; commune: string; quartier: string; lat: number; lon: number; attributes: Record<string, string>; withPlate?: boolean }) {
    const def = SECTOR_OBJECTS[input.module];
    if (!def) throw badRequest('NO_SECTOR_OBJECT', `Aucun objet sectoriel pour le module ${input.module}.`);
    const taxpayerId = input.taxpayerId ?? user.taxpayerId;
    authorize(user, P.sectorRegister, this.res({ ...(taxpayerId ? { taxpayerId } : {}), communes: [input.commune] }));
    const attrs: Record<string, unknown> = { verticale: def.vertical, objectType: def.objectType };
    for (const a of def.attributes) {
      const v = input.attributes[a.key]?.trim();
      if (!v) { if (a.required) throw badRequest('FIELD_REQUIRED', `Champ requis : ${a.label}`); continue; }
      if (a.decimal && !DECIMAL.test(v)) throw badRequest('INVALID_NUMBER', `${a.label} : nombre positif attendu.`);
      attrs[a.key] = v;
    }
    const key = input.module === '24' ? 'identifiant' : input.module === '16' ? 'reference' : null;
    if (key) {
      const dup = this.objectsOf(input.module).find((o) => String(o.attributes[key] ?? '').toUpperCase() === String(attrs[key]).toUpperCase());
      if (dup) throw conflict('SECTOR_OBJECT_EXISTS', `${def.label} déjà enregistré(e) : ${dup.id}.`, { objectId: dup.id });
    }
    const o = this.ctx.objects.create(user, { ...(taxpayerId ? { taxpayerId } : {}), category: 'AUTRE', commune: input.commune, quartier: input.quartier, localityRank: 4, lat: input.lat, lon: input.lon, attributes: attrs });
    let plate: { code: string } | null = null;
    if (input.withPlate && evaluate(user, P.plateIssue, { communes: [o.commune] })) plate = this.vx.issuePlate(user, o.id);
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.object.registered', resourceType: 'fiscal_object', resourceId: o.id, details: { module: input.module, objectType: def.objectType, plate: plate?.code ?? null } });
    return { object: o, plate };
  }

  objectsOf(module: string): FiscalObject[] {
    const def = SECTOR_OBJECTS[module];
    return def ? this.ctx.objects.objects.find((o) => o.attributes.objectType === def.objectType) : [];
  }

  listObjects(user: User, module: string) {
    const def = SECTOR_OBJECTS[module];
    if (!def) throw badRequest('NO_SECTOR_OBJECT', `Aucun objet sectoriel pour le module ${module}.`);
    authorize(user, module === '23' ? P.forestRead : P.sectorRead, this.res());
    if (module === '23') this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.forest.consulted', resourceType: 'sector_module', resourceId: '23', details: {} });
    return this.objectsOf(module).map((o) => ({
      objectId: o.id, commune: o.commune, quartier: o.quartier, lat: o.lat, lon: o.lon, probativeStatus: o.probativeStatus, taxpayerId: o.taxpayerId ?? null,
      operator: o.taxpayerId ? this.ctx.taxpayers.taxpayers.get(o.taxpayerId)?.fullName ?? o.taxpayerId : null,
      attributes: Object.fromEntries(def.attributes.map((a) => [a.key, o.attributes[a.key] ?? null])),
      plate: this.vx.plates.findOne((p) => p.objectId === o.id && p.status === 'POSEE')?.code ?? null,
      liquidations: this.liquidations.find((l) => l.objectId === o.id).map((l) => ({ period: l.period, status: l.status, obligationId: l.obligationId ?? null })),
    }));
  }

  // ================================================================== 13 / 24 — départs, manifestes, titres, mouvements

  declareDeparture(user: User, input: { pointId: string; embarcationId?: string; operatorTaxpayerId?: string; destination: string; scheduledAt: string; titleMode: Departure['titleMode'] }) {
    const point = this.vx.secteurs.references.get(input.pointId);
    if (!point || !['POINT_EMBARQUEMENT', 'QUAI'].includes(point.kind)) throw notFound('DEPARTURE_POINT_NOT_FOUND', `Point d’embarquement ou quai inconnu : ${input.pointId}`);
    const operator = input.operatorTaxpayerId ?? user.taxpayerId ?? point.operatorTaxpayerId;
    if (!operator) throw badRequest('OPERATOR_REQUIRED', 'Opérateur (batelier ou opérateur portuaire) requis.');
    this.ctx.taxpayers.get(operator);
    authorize(user, P.departDeclare, this.res({ taxpayerId: operator }));
    if (Number.isNaN(Date.parse(input.scheduledAt))) throw badRequest('INVALID_DATE', 'Heure de départ prévue invalide.');
    if (input.embarcationId) {
      const boat = this.ctx.objects.get(input.embarcationId);
      if (boat.attributes.objectType !== 'EMBARCATION') throw unprocessable('OBJECT_WRONG_TYPE', `${boat.id} n’est pas une embarcation.`);
      if (boat.taxpayerId && boat.taxpayerId !== operator) throw forbidden('BOAT_NOT_OPERATED', 'L’embarcation n’est pas rattachée à cet opérateur.');
    }
    const at = this.now().toISOString();
    const d = this.departures.insert({
      id: this.ids.next('DEP'), module: '13', pointId: point.id, commune: point.commune, ...(input.embarcationId ? { embarcationId: input.embarcationId } : {}),
      operatorTaxpayerId: operator, destination: input.destination, scheduledAt: input.scheduledAt, titleMode: input.titleMode, status: 'PREVU',
      manifestHistory: [], issuanceIds: [], events: [{ at, by: user.id, kind: 'DECLARE' }], createdBy: user.id, createdAt: at,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.departure.declared', resourceType: 'departure', resourceId: d.id, details: { pointId: d.pointId, embarcationId: d.embarcationId ?? null, titleMode: d.titleMode } });
    return this.departureView(d);
  }

  private departure(id: string): Departure {
    const d = this.departures.get(id);
    if (!d) throw notFound('DEPARTURE_NOT_FOUND', `Départ inconnu : ${id}`);
    return d;
  }

  /** Manifeste : passagers (ou volumes) déclarés par départ ; toute correction est conservée (historique en ajout seul). */
  submitManifest(user: User, id: string, input: { passengers: number; volumeT?: string; documents: string[] }) {
    const d = this.departure(id);
    authorize(user, P.departDeclare, this.res({ taxpayerId: d.operatorTaxpayerId }));
    if (d.status !== 'PREVU') throw conflict('DEPARTURE_CLOSED', `Manifeste figé : départ au statut ${d.status}.`);
    if (!Number.isInteger(input.passengers) || input.passengers < 0) throw badRequest('INVALID_PASSENGERS', 'Nombre de passagers entier positif attendu.');
    if (input.volumeT && !DECIMAL.test(input.volumeT)) throw badRequest('INVALID_VOLUME', 'Volume (t) : nombre positif attendu.');
    if (d.embarcationId) {
      const cap = Number.parseFloat(String(this.ctx.objects.get(d.embarcationId).attributes.capacite_passagers ?? ''));
      if (Number.isFinite(cap) && input.passengers > cap) throw unprocessable('OVER_CAPACITY', `Manifeste supérieur à la capacité déclarée de l’embarcation (${cap}).`);
    }
    const at = this.now().toISOString();
    const saved = this.departures.update({
      ...d, manifest: { passengers: input.passengers, volumeT: input.volumeT ?? null, documents: input.documents, by: user.id, at },
      manifestHistory: [...d.manifestHistory, { passengers: input.passengers, volumeT: input.volumeT ?? null, by: user.id, at }],
      events: [...d.events, { at, by: user.id, kind: 'MANIFESTE', note: `${input.passengers} passager(s)` }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.manifest.submitted', resourceType: 'departure', resourceId: id, details: { passengers: input.passengers, volumeT: input.volumeT ?? null, version: saved.manifestHistory.length } });
    return this.departureView(saved);
  }

  /**
   * Titres d'embarquement : un par passager (PAR_PASSAGER) ou un par départ (PAR_DEPART), commandés au moteur de titres
   * (§ 19A) ; paiement Mobile Money ou point agréé, jamais à l'agent. Type non activable (acte requis) : refus journalisé.
   */
  orderTitles(user: User, id: string, input: { channel: PaymentChannel }) {
    const d = this.departure(id);
    authorize(user, P.departDeclare, this.res({ taxpayerId: d.operatorTaxpayerId }));
    if (!DEPARTURE_CHANNELS.includes(input.channel)) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.titles.channel_refused', resourceType: 'departure', resourceId: id, outcome: 'DENIED', details: { channel: input.channel } });
      throw unprocessable('CHANNEL_NOT_ALLOWED', 'Paiement au départ : Mobile Money ou point agréé uniquement — jamais à l’agent de quai.');
    }
    if (d.status !== 'PREVU') throw conflict('DEPARTURE_CLOSED', `Départ au statut ${d.status}.`);
    if (!d.manifest) throw conflict('MANIFEST_REQUIRED', 'Déposer le manifeste avant de commander les titres.');
    const t = this.titres();
    if (!t) throw unprocessable('TITRES_UNAVAILABLE', 'Moteur de titres non chargé.');
    const typeCode = this.config('13').credentialTypeCode ?? 'EMB-CARTE';
    const already = this.titlesOf(d).length;
    const wanted = d.titleMode === 'PAR_DEPART' ? 1 : d.manifest.passengers;
    const missing = wanted - already;
    if (missing <= 0) throw conflict('TITLES_ALREADY_ORDERED', 'Les titres de ce départ sont déjà commandés.');
    const point = this.reference(d.pointId);
    const item = {
      typeCode, holderTaxpayerId: d.operatorTaxpayerId,
      subject: { label: `Départ ${d.id} → ${d.destination}`, ...(d.embarcationId ? { objectId: d.embarcationId } : {}) },
      place: { commune: point.commune, sourceId: point.id, label: point.label, basis: 'STATION_DEPART' as const, lat: point.lat, lon: point.lon },
    };
    const iss = t.purchase(user, { payerTaxpayerId: d.operatorTaxpayerId, channel: input.channel, items: Array.from({ length: missing }, () => structuredClone(item)), context: `depart:${d.id}` });
    const at = this.now().toISOString();
    this.departures.update({ ...d, issuanceIds: [...d.issuanceIds, iss.id], events: [...d.events, { at, by: user.id, kind: 'TITRES', note: `${missing} titre(s) commandé(s)` }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.titles.ordered', resourceType: 'departure', resourceId: id, details: { issuanceId: iss.id, count: missing, channel: input.channel } });
    return { departure: this.departureView(this.departure(id)), issuance: { id: iss.id, status: iss.status, payments: iss.payments.map((p) => ({ paymentReference: p.paymentReference, amount: p.amount, expiresAt: p.expiresAt })) } };
  }

  /** Mouvement (départ effectif, arrivée) à l'heure du serveur ; l'historique de l'embarcation en découle (module 24). */
  recordMovement(user: User, id: string, input: { kind: 'DEPART' | 'ARRIVEE' | 'ANNULE'; arrivalPointId?: string; note?: string }) {
    const d = this.departure(id);
    const point = this.reference(d.pointId);
    const asOperator = evaluate(user, P.departDeclare, this.res({ taxpayerId: d.operatorTaxpayerId }));
    if (!asOperator) authorize(user, P.sectorObserve, this.res({ communes: [point.commune] }));
    const next: Record<string, Departure['status']> = { DEPART: 'PARTI', ARRIVEE: 'ARRIVE', ANNULE: 'ANNULE' };
    const from: Record<string, Departure['status'][]> = { DEPART: ['PREVU'], ARRIVEE: ['PARTI'], ANNULE: ['PREVU'] };
    if (!from[input.kind]!.includes(d.status)) throw conflict('INVALID_MOVEMENT', `Mouvement ${input.kind} impossible au statut ${d.status}.`);
    if (input.arrivalPointId) this.reference(input.arrivalPointId);
    const at = this.now().toISOString();
    const saved = this.departures.update({
      ...d, status: next[input.kind]!, ...(input.arrivalPointId ? { arrivalPointId: input.arrivalPointId } : {}),
      events: [...d.events, { at, by: user.id, kind: input.kind, ...(input.note ? { note: input.note } : {}) }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.movement.recorded', resourceType: 'departure', resourceId: id, details: { kind: input.kind, embarcationId: d.embarcationId ?? null } });
    return this.departureView(saved);
  }

  private titlesOf(d: Departure) {
    const t = this.titres();
    if (!t) return [];
    const out: { id: string; number: string; state: string; consumed: boolean; paid: boolean }[] = [];
    for (const issId of d.issuanceIds) {
      const iss = t.issuances.get(issId);
      if (!iss) continue;
      for (const it of iss.items) {
        const pay = iss.payments.find((p) => p.paymentOrderId === it.paymentOrderId);
        const c = it.credentialId ? t.credentials.get(it.credentialId) : undefined;
        out.push({ id: c?.id ?? `${issId}#${out.length}`, number: c?.number ?? '—', state: c?.state ?? iss.status, consumed: c?.state === 'CONSOMME' || (c?.firstUse !== undefined), paid: pay?.status === 'PAYE' || !!c });
      }
    }
    return out;
  }

  /** Rapprochement manifeste ↔ titres ↔ paiements ↔ embarquements contrôlés (aucune taxation automatique). */
  reconcileDeparture(user: User, id: string) {
    const d = this.departure(id);
    authorize(user, P.departRead, this.res({ taxpayerId: d.operatorTaxpayerId, communes: [d.commune] }));
    this.titres()?.sync();
    const titles = this.titlesOf(d);
    const manifested = d.manifest?.passengers ?? 0;
    const expected = d.titleMode === 'PAR_DEPART' ? (d.manifest ? 1 : 0) : manifested;
    const issued = titles.length;
    const paid = titles.filter((x) => x.paid).length;
    const consumed = titles.filter((x) => x.consumed).length;
    const gaps = { manifesteMoinsTitres: expected - issued, titresNonPayes: issued - paid, embarquesMoinsManifeste: d.titleMode === 'PAR_PASSAGER' ? consumed - manifested : 0 };
    const anomalies = [
      ...(gaps.manifesteMoinsTitres > 0 ? [`${gaps.manifesteMoinsTitres} passager(s) du manifeste sans titre`] : []),
      ...(gaps.titresNonPayes > 0 ? [`${gaps.titresNonPayes} titre(s) commandé(s) non payé(s)`] : []),
      ...(gaps.embarquesMoinsManifeste > 0 ? [`${gaps.embarquesMoinsManifeste} embarquement(s) contrôlé(s) au-delà du manifeste`] : []),
    ];
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.departure.reconciled', resourceType: 'departure', resourceId: id, details: { expected, issued, paid, consumed } });
    return {
      departureId: d.id, titleMode: d.titleMode, manifested, expectedTitles: expected, issued, paid, consumed, gaps, anomalies,
      proposal: anomalies.length ? 'Écart à instruire avec l’opérateur (procédure contradictoire) — aucune taxation ni sanction automatique.' : 'Manifeste, titres et paiements concordants.',
      serverTime: this.now().toISOString(),
    };
  }

  departureView(d: Departure) {
    return { ...d, point: this.vx.secteurs.references.get(d.pointId)?.label ?? d.pointId, titles: this.titlesOf(d).length };
  }

  listDepartures(user: User, filter: { embarcationId?: string; status?: string } = {}) {
    return this.departures.find((d) => (!filter.embarcationId || d.embarcationId === filter.embarcationId) && (!filter.status || d.status === filter.status))
      .filter((d) => !!evaluate(user, P.departRead, this.res({ taxpayerId: d.operatorTaxpayerId, communes: [d.commune] })))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((d) => this.departureView(d));
  }

  /** Contrôle d'une embarcation par QR (plaque MOSOLO), identifiant ou numéro d'objet : réponse minimale, sans nom. */
  boatControl(user: User, ref: string, commune?: string) {
    authorize(user, P.boatControl, commune ? { communes: [commune] } : {});
    const r = ref.trim();
    const byPlate = this.vx.plates.findOne((p) => p.code.toUpperCase() === r.toUpperCase());
    const boat = this.objectsOf('24').find((o) => o.id === r || (byPlate && o.id === byPlate.objectId) || String(o.attributes.identifiant ?? '').toUpperCase() === r.toUpperCase());
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.boat.controlled', resourceType: 'boat', resourceId: boat?.id ?? r, details: { found: !!boat, commune: commune ?? null } });
    if (!boat) return { registered: false, reference: r, notice: 'Embarcation non enregistrée : recensement à proposer (aucune sanction automatique).', serverTime: this.now().toISOString() };
    const t = this.titres();
    const now = this.now();
    const titles = t ? t.credentials.find((c) => c.subject.objectId === boat.id && (c.module === '24' || c.module === '13')).map((c) => {
      const st = statusAt(c, now);
      return { module: c.module, typeCode: c.typeCode, number: c.number, status: st.status, text: st.text, validUntil: c.validUntil };
    }) : [];
    const movements = this.departures.find((d) => d.embarcationId === boat.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
      .map((d) => ({ id: d.id, status: d.status, destination: d.destination, scheduledAt: d.scheduledAt, events: d.events.filter((e) => e.kind === 'DEPART' || e.kind === 'ARRIVEE').map((e) => ({ kind: e.kind, at: e.at })) }));
    return {
      registered: true, objectId: boat.id, identifiant: boat.attributes.identifiant ?? null, capacitePassagers: boat.attributes.capacite_passagers ?? null, commune: boat.commune,
      plate: this.vx.plates.findOne((p) => p.objectId === boat.id && p.status === 'POSEE')?.code ?? null, titles, movements,
      credentialTypes: this.vx.secteurs.catalogue().filter((m) => m.module === '24' || m.module === '13').flatMap((m) => m.credentialTypes.map((x) => ({ code: x.code, activable: x.activable }))),
      notice: 'Réponse minimale (ni nom ni adresse du propriétaire). Accostage et embarquement : titres du moteur § 19A ; sans titre activable (acte requis), aucun constat ni montant.',
      serverTime: now.toISOString(),
    };
  }

  /** Rapprochement mouvements ↔ titres d'accostage payés, par embarcation et par période (AAAA-MM). */
  portReconciliation(user: User, period: string) {
    authorize(user, P.sectorRead, this.res());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('INVALID_PERIOD', 'Période AAAA-MM attendue.');
    const t = this.titres();
    return this.objectsOf('24').map((boat) => {
      const movements = this.departures.find((d) => d.embarcationId === boat.id && d.events.some((e) => e.kind === 'DEPART' && kinshasaDate(new Date(e.at)).startsWith(period))).length;
      const titles = t ? t.credentials.find((c) => c.module === '24' && c.subject.objectId === boat.id && kinshasaDate(new Date(c.issuedAt)).startsWith(period)) : [];
      const paid = sumByCurrency(titles.filter((c) => c.amount).map((c) => c.amount!));
      return { objectId: boat.id, identifiant: boat.attributes.identifiant ?? null, movements, accostageTitles: titles.length, paid, gap: movements - titles.length,
        proposal: movements > titles.length ? 'Mouvements sans titre d’accostage : vérification contradictoire (aucune sanction automatique).' : 'Concordant.' };
    });
  }

  // ================================================================== liquidations (proposition, automatique, décision)

  /** Bases de liquidation tirées des données (aucune valeur saisie) : superficie, volumes VALIDÉS, mouvements, site. */
  baseFor(module: string, o: FiscalObject, period: string, movementId?: string): Record<string, string> {
    const a = o.attributes;
    const s = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
    const out: Record<string, string> = {};
    const put = (k: string, v: string | null) => { if (v !== null && DECIMAL.test(v)) out[k] = v; };
    if (module === '16') { out.sites = '1'; put('emprise_m2', s(a.emprise_m2)); }
    if (module === '22' || module === '23') put('superficie_ha', s(a.superficie_ha));
    if (module === '22') {
      const decl = this.vx.secteurs.declarations.findOne((d) => d.kind === 'SORTIES_CARRIERE' && d.objectId === o.id && d.period === period && d.status === 'VALIDEE');
      if (decl) for (const [k, v] of Object.entries(decl.lines)) put(k, v);
    }
    if (module === '17') {
      const decl = this.vx.secteurs.declarations.findOne((d) => d.kind === 'VOLUMES_BAT' && d.taxpayerId === o.taxpayerId && d.period === period && d.status === 'VALIDEE');
      if (decl) for (const [k, v] of Object.entries(decl.lines)) put(k, v);
    }
    if (module === '24') {
      const mv = movementId ? this.departures.find((d) => d.id === movementId && d.embarcationId === o.id && d.events.some((e) => e.kind === 'DEPART'))
        : this.departures.find((d) => d.embarcationId === o.id && d.events.some((e) => e.kind === 'DEPART' && kinshasaDate(new Date(e.at)).startsWith(period)));
      out.mouvements = String(mv.length);
      out.passagers = String(mv.reduce((n, d) => n + (d.manifest?.passengers ?? 0), 0));
    }
    if (module === '19') {
      for (const [k, v] of Object.entries(a)) if (typeof v === 'string' || typeof v === 'number') put(k, String(v));
    }
    return out;
  }

  private inputsFor(rule: RuleRecord, basis: Record<string, string>): { inputs: Record<string, string>; missing: string[] } {
    const req = this.ctx.rules.requiredInputs(rule);
    const missing = req.filter((k) => basis[k] === undefined);
    return { inputs: Object.fromEntries(req.filter((k) => basis[k] !== undefined).map((k) => [k, basis[k]!])), missing };
  }

  private objectForModule(module: string, objectId: string): FiscalObject {
    const o = this.ctx.objects.get(objectId);
    const def = SECTOR_OBJECTS[module];
    if (def && o.attributes.objectType !== def.objectType) throw unprocessable('OBJECT_WRONG_TYPE', `${o.id} n’est pas un objet du module ${module} (${def.objectType}).`);
    if (module === '17' && o.attributes.objectType !== 'ETABLISSEMENT') throw unprocessable('OBJECT_WRONG_TYPE', 'Module 17 : l’objet liquidé est l’établissement du redevable.');
    if (!o.taxpayerId) throw unprocessable('OBJECT_WITHOUT_TAXPAYER', 'Objet sans redevable rattaché : aucune obligation possible.');
    return o;
  }

  private periodOk(module: string, period: string) {
    if (!PERIOD.test(period)) throw badRequest('INVALID_PERIOD', 'Période AAAA (exercice) ou AAAA-MM attendue.');
    if ((AUTO_LIQUIDATION_MODULES as readonly string[]).includes(module) && module !== '22' && period.length !== 4) throw badRequest('ANNUAL_PERIOD', `Module ${module} : liquidation annuelle (exercice AAAA).`);
    if (period > kinshasaDate(this.now()).slice(0, period.length)) throw badRequest('FUTURE_PERIOD', 'Une liquidation porte sur une période échue ou en cours (heure du serveur).');
  }

  private existing(module: string, objectId: string, period: string, movementId?: string) {
    return this.liquidations.findOne((l) => l.module === module && l.objectId === objectId && l.period === period && (l.movementId ?? null) === (movementId ?? null) && l.status !== 'REJETEE');
  }

  /** Proposition de liquidation : bases tirées des données ; montant simulé seulement si une règle ACTIVE est configurée. */
  propose(user: User, input: { module: string; objectId: string; period: string; movementId?: string }) {
    authorize(user, P.sectorLiquidate, this.res());
    this.periodOk(input.module, input.period);
    const o = this.objectForModule(input.module, input.objectId);
    if (input.movementId) {
      if (input.module !== '24') throw badRequest('MOVEMENT_NOT_APPLICABLE', 'Liquidation par mouvement : module 24 seulement.');
      const d = this.departure(input.movementId);
      if (d.embarcationId !== o.id) throw unprocessable('MOVEMENT_OTHER_BOAT', 'Ce mouvement ne concerne pas cette embarcation.');
      const dep = d.events.find((e) => e.kind === 'DEPART');
      if (!dep) throw unprocessable('MOVEMENT_NOT_DONE', 'Mouvement non effectué : aucun départ enregistré.');
      if (!kinshasaDate(new Date(dep.at)).startsWith(input.period)) throw badRequest('MOVEMENT_PERIOD', `Le départ a eu lieu le ${kinshasaDate(new Date(dep.at))} : période ${kinshasaDate(new Date(dep.at)).slice(0, 7)} attendue.`);
      // Aucune double facturation : un mouvement déjà compris dans une liquidation de la période n'est pas refacturé.
      const periodLiq = this.existing('24', o.id, input.period);
      if (periodLiq) throw conflict('LIQUIDATION_EXISTS', `La période ${input.period} est déjà liquidée pour ${o.id} (${periodLiq.id}) : aucune double facturation.`, { liquidationId: periodLiq.id });
    } else if (input.module === '24' && this.liquidations.findOne((l) => l.module === '24' && l.objectId === o.id && l.period === input.period && !!l.movementId && l.status !== 'REJETEE')) {
      throw conflict('LIQUIDATION_EXISTS', `Des mouvements de ${input.period} sont déjà liquidés un par un : aucune double facturation.`);
    }
    const dup = this.existing(input.module, o.id, input.period, input.movementId);
    if (dup) throw conflict('LIQUIDATION_EXISTS', `Une liquidation existe déjà pour ${o.id} (${input.period}${input.movementId ? `, ${input.movementId}` : ''}) : ${dup.id} — aucune double facturation.`, { liquidationId: dup.id });
    return this.createLiquidation(user, input.module, o, input.period, 'PROPOSITION', input.movementId);
  }

  private createLiquidation(user: User, module: string, o: FiscalObject, period: string, mode: SectorLiquidation['mode'], movementId?: string): SectorLiquidation {
    const basis = this.baseFor(module, o, period, movementId);
    const rs = this.ruleStatus(module);
    let status: LiquidationStatus = 'ACTE_REQUIS';
    let simulated: MoneyJSON | undefined;
    let note = rs.ruleCode ? `Règle ${rs.ruleCode} au statut ${rs.status} : aucun montant (acte requis).` : 'Aucune règle configurée pour ce module : aucun montant (acte requis).';
    if (rs.active) {
      const { inputs, missing } = this.inputsFor(rs.active, basis);
      if (missing.length) {
        status = 'BASE_INCOMPLETE';
        note = `Bases manquantes pour la règle ${rs.active.code} : ${missing.join(', ')} — à compléter par les données (aucune valeur saisie).`;
      } else {
        const trace = this.ctx.assessment.calculate(this.engine(rs.active), { ruleId: rs.active.id, taxpayerId: o.taxpayerId!, objectId: o.id, inputs, simulate: true }).trace;
        simulated = trace.result;
        status = 'PROPOSEE';
        note = `Montant simulé par la règle ${rs.active.code} v${rs.active.version} (non opposable avant décision).`;
      }
    }
    const l = this.liquidations.insert({
      id: this.ids.next(`LIQ-${module}`), module, objectId: o.id, taxpayerId: o.taxpayerId!, period, ...(movementId ? { movementId } : {}), basis, mode, ruleCode: rs.ruleCode, ruleVersion: rs.active?.version ?? null,
      status, ...(simulated ? { simulated } : {}), proposedBy: user.id, proposedAt: this.now().toISOString(), note,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.liquidation.proposed', resourceType: 'sector_liquidation', resourceId: l.id, details: { module, objectId: o.id, period, status, basis, mode } });
    return l;
  }

  private engine(rule: RuleRecord): User {
    return enginePrincipal('svc-fiches-liquidation', 'Moteur de liquidation des fiches sectorielles', rule.administeringEntity);
  }

  /** Exécution d'une liquidation : règle ACTIVE, aucune double facturation, obligation + avis d'imposition. */
  private execute(l: SectorLiquidation, rule: RuleRecord, by: { id: string; auto: boolean }): SectorLiquidation {
    const o = this.ctx.objects.get(l.objectId);
    const basis = this.baseFor(l.module, o, l.period, l.movementId);
    const { inputs, missing } = this.inputsFor(rule, basis);
    if (missing.length) throw unprocessable('BASIS_INCOMPLETE', `Bases manquantes pour la règle ${rule.code} : ${missing.join(', ')}.`);
    const year = l.period.slice(0, 4);
    const dup = this.ctx.assessment.obligations.findOne((ob) => ob.objectId === o.id && ob.ruleCode === rule.code && ob.status !== 'ANNULEE'
      && (l.period.length === 4 ? ob.createdAt.startsWith(year) || this.liquidations.find((x) => x.obligationId === ob.id && x.period === l.period).length > 0 : this.liquidations.find((x) => x.obligationId === ob.id && x.period === l.period && (x.movementId ?? null) === (l.movementId ?? null)).length > 0));
    if (dup) throw conflict('DOUBLE_BILLING', `Une obligation existe déjà pour ce fait générateur (${dup.id}) : aucune double facturation.`, { obligationId: dup.id });
    const res = this.ctx.assessment.calculate(this.engine(rule), { ruleId: rule.id, taxpayerId: o.taxpayerId!, objectId: o.id, inputs, simulate: false });
    const ob = res.obligation!;
    // Avis d'imposition numéroté (module de recouvrement) ; à défaut, la notification « assessment.issued » du moteur de
    // liquidation tient lieu d'avis (canal du redevable) — l'avis numéroté peut être émis ensuite par la régie.
    let noticeId: string | undefined;
    const rec = this.ctx.ext.recouvrement as { issueAssessmentNotice?: (u: User, id: string) => { id: string } } | undefined;
    if (rec?.issueAssessmentNotice) {
      try { noticeId = rec.issueAssessmentNotice(this.engine(rule), ob.id).id; } catch { /* avis émis ensuite par la régie */ }
    }
    const saved = this.liquidations.update({ ...l, basis, ruleCode: rule.code, ruleVersion: rule.version, status: 'EXECUTEE', obligationId: ob.id, ...(noticeId ? { noticeId } : {}), notice: noticeId ? 'AVIS_IMPOSITION' : 'NOTIFICATION', simulated: ob.amount, executedAt: this.now().toISOString() });
    this.ctx.audit.append({
      actor: by.auto ? { kind: 'system', id: AUTO_ACTOR } : { kind: 'user', id: by.id }, action: by.auto ? 'verticales.sector.liquidation.auto_executed' : 'verticales.sector.liquidation.executed',
      resourceType: 'sector_liquidation', resourceId: l.id, details: { module: l.module, objectId: o.id, period: l.period, obligationId: ob.id, ruleCode: rule.code, ruleVersion: rule.version, noticeId: noticeId ?? null },
    });
    return saved;
  }

  decide(user: User, id: string, input: { decision: 'EXECUTER' | 'REJETER'; motif: string }) {
    const l = this.liquidations.get(id);
    if (!l) throw notFound('LIQUIDATION_NOT_FOUND', `Liquidation inconnue : ${id}`);
    authorize(user, P.sectorDecide, this.res());
    if (l.status === 'EXECUTEE' || l.status === 'REJETEE') throw conflict('LIQUIDATION_CLOSED', `Liquidation déjà ${l.status.toLowerCase()}.`);
    try {
      assertDistinctPerson(user.id, [l.proposedBy], 'La personne qui décide doit être distincte de celle qui a proposé la liquidation.');
    } catch (e) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.liquidation.refused', resourceType: 'sector_liquidation', resourceId: id, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    const decision = { by: user.id, at: this.now().toISOString(), decision: input.decision, motif: input.motif };
    if (input.decision === 'REJETER') {
      const saved = this.liquidations.update({ ...l, status: 'REJETEE', decision });
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.liquidation.rejected', resourceType: 'sector_liquidation', resourceId: id, details: { motif: input.motif } });
      return saved;
    }
    const rs = this.ruleStatus(l.module);
    if (!rs.active) throw unprocessable('ACTE_REQUIS', `Aucune règle ACTIVE pour le module ${l.module} : exécution impossible (acte requis).`);
    this.liquidations.update({ ...l, decision });
    return this.execute(this.liquidations.get(id)!, rs.active, { id: user.id, auto: false });
  }

  /**
   * Liquidation AUTOMATIQUE (fiches 16, 22, 23) : sur règle ACTIVE seulement, pour chaque objet rattaché à un redevable,
   * une fois par objet et par exercice (idempotente), avec avis d'imposition ; sites télécoms seulement déclarés ou
   * vérifiés (un site seulement observé passe d'abord par la vérification contradictoire). Sans règle ACTIVE : rien.
   */
  runAutomatic(exercice = this.exercice(), modules: readonly string[] = AUTO_LIQUIDATION_MODULES) {
    const out: { module: string; status: string; executed: number; skipped: number; errors: { objectId: string; reason: string }[] }[] = [];
    const system: User = { kind: 'user', id: AUTO_ACTOR, name: 'Liquidation automatique (règle ACTIVE)', roles: [], entity: SECTOR_ENTITY };
    for (const module of modules) {
      const rs = this.ruleStatus(module);
      if (!rs.active) { out.push({ module, status: rs.ruleCode ? `REGLE_${rs.status}` : 'ACTE_REQUIS', executed: 0, skipped: 0, errors: [] }); continue; }
      let executed = 0; let skipped = 0;
      const errors: { objectId: string; reason: string }[] = [];
      // 16 et 23 : une fois par objet et par exercice (superficie, site) ; 22 : une fois par site et par mois dont la
      // déclaration des sorties est VALIDÉE (superficie et volumes validés après rapprochement), pour l'exercice demandé.
      const targets: { o: FiscalObject; period: string }[] = module === '22'
        ? this.vx.secteurs.declarations.find((d) => d.kind === 'SORTIES_CARRIERE' && d.status === 'VALIDEE' && !!d.objectId && d.period.startsWith(exercice))
          .map((d) => ({ o: this.ctx.objects.get(d.objectId!), period: d.period }))
        : this.objectsOf(module).map((o) => ({ o, period: exercice }));
      for (const { o, period } of targets) {
        if (!o.taxpayerId || (module === '16' && o.probativeStatus === 'OBSERVE')) { skipped += 1; continue; }
        const prev = this.existing(module, o.id, period);
        if (prev && prev.status === 'EXECUTEE') { skipped += 1; continue; }
        try {
          const l = prev ?? this.createLiquidation(system, module, o, period, 'AUTOMATIQUE');
          this.execute(l, rs.active, { id: AUTO_ACTOR, auto: true });
          executed += 1;
        } catch (e) {
          errors.push({ objectId: o.id, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      out.push({ module, status: 'ACTIVE', executed, skipped, errors });
    }
    this.lastRun = { at: this.now().toISOString(), exercice, modules: out.map((m) => ({ module: m.module, status: m.status, executed: m.executed, errors: m.errors.length })) };
    if (out.some((m) => m.executed > 0)) this.ctx.audit.append({ actor: { kind: 'system', id: AUTO_ACTOR }, action: 'verticales.sector.liquidation.auto_run', resourceType: 'sector_module', resourceId: modules.join(','), details: { exercice, out: out.map((m) => `${m.module}:${m.executed}`) } });
    return { exercice, modules: out, serverTime: this.now().toISOString() };
  }

  /** État de la liquidation automatique : règle de chaque module, planificateur, dernier passage. */
  automaticStatus(user: User) {
    authorize(user, P.sectorRead, this.res());
    return {
      modules: AUTO_LIQUIDATION_MODULES.map((m) => ({ module: m, rule: this.ruleView(m), mode: this.ruleStatus(m).active ? 'AUTOMATIQUE' : 'PROPOSITION' })),
      schedulerMs: this.schedulerMs, schedulerNote: `Passage planifié toutes les ${Math.round((this.schedulerMs ?? AUTO_RUN_DEFAULT_MS) / 60_000)} minutes par défaut (paramètre technique à confirmer par le maître d’ouvrage).`,
      lastRun: this.lastRun,
      doctrine: 'Sur règle ACTIVE : liquidation automatique, idempotente par objet et exercice, tracée, avec avis ; sans règle ACTIVE : proposition seulement. Pénalités et sanctions : décision d’une personne.',
    };
  }

  listBoardings(user: User, departureId: string) {
    const d = this.departure(departureId);
    authorize(user, P.departRead, this.res({ taxpayerId: d.operatorTaxpayerId, communes: [d.commune] }));
    return this.boardings.find((b) => b.departureId === d.id).slice().reverse();
  }

  runAutomaticAs(user: User, exercice?: string) {
    authorize(user, P.sectorLiquidate, this.res());
    if (exercice && !/^\d{4}$/.test(exercice)) throw badRequest('INVALID_YEAR', 'Exercice AAAA attendu.');
    return this.runAutomatic(exercice ?? this.exercice());
  }

  startScheduler(ms: number): void {
    this.stopScheduler();
    this.schedulerMs = ms;
    this.timer = setInterval(() => { runScheduledJob(this.ctx, 'verticales.liquidation-automatique', () => { this.runAutomatic(); }); }, ms);
    this.timer.unref?.();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.schedulerMs = null;
  }

  listLiquidations(user: User, filter: { module?: string; status?: string } = {}) {
    authorize(user, filter.module === '23' ? P.forestRead : P.sectorRead, this.res());
    // Passage idempotent de la liquidation automatique (règle ACTIVE seulement) avant lecture.
    const auto = (AUTO_LIQUIDATION_MODULES as readonly string[]).filter((m) => !filter.module || m === filter.module);
    if (auto.length) this.runAutomatic(this.exercice(), auto);
    return this.liquidations.find((l) => (!filter.module || l.module === filter.module) && (!filter.status || l.status === filter.status))
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))
      .map((l) => ({ ...l, payment: l.obligationId ? paymentState(this.ctx, l.obligationId) : null }));
  }

  // ================================================================== 16 — antennes : import, mutations, recouvrement

  importSites(user: User, input: { source: SiteImport['source']; operatorTaxpayerId: string; fileSha256?: string; sites: { reference: string; commune: string; quartier: string; lat: number; lon: number; type: string; emprise_m2?: string }[] }) {
    authorize(user, P.telecomImport, this.res({ taxpayerId: input.operatorTaxpayerId }));
    if (input.source === 'REGULATEUR' && !user.roles.includes('R34') && !user.roles.includes('R11')) throw forbidden('REGULATOR_SOURCE', 'Liste du régulateur : versée par le partenaire de données sous protocole ou par la régie.');
    this.ctx.taxpayers.get(input.operatorTaxpayerId);
    const engine = enginePrincipal('svc-fiches-import', 'Import des listes de sites', SECTOR_ENTITY);
    let created = 0; let known = 0;
    for (const s of input.sites) {
      if (!isCommune(s.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${s.commune} (site ${s.reference})`);
      if (s.emprise_m2 && !DECIMAL.test(s.emprise_m2)) throw badRequest('INVALID_NUMBER', `Emprise invalide (site ${s.reference}).`);
      const dup = this.objectsOf('16').find((o) => String(o.attributes.reference ?? '').toUpperCase() === s.reference.toUpperCase() && (o.taxpayerId ?? null) === input.operatorTaxpayerId);
      if (dup) { known += 1; continue; }
      const o = this.ctx.objects.create(engine, {
        taxpayerId: input.operatorTaxpayerId, category: 'AUTRE', commune: s.commune, quartier: s.quartier, localityRank: 4, lat: s.lat, lon: s.lon,
        attributes: { verticale: 'telecom', objectType: 'SITE_TELECOM', reference: s.reference, type: s.type, ...(s.emprise_m2 ? { emprise_m2: s.emprise_m2 } : {}), listeSource: input.source },
      });
      this.ctx.objects.setProbativeStatus(o.id, 'DECLARE');
      created += 1;
    }
    const rec = this.siteImports.append({ id: this.ids.next('IMP-SIT'), source: input.source, operatorTaxpayerId: input.operatorTaxpayerId, fileSha256: input.fileSha256 ?? null, received: input.sites.length, created, known, by: user.id, at: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.telecom.sites.imported', resourceType: 'site_import', resourceId: rec.id, details: { source: rec.source, operator: rec.operatorTaxpayerId, received: rec.received, created, known, file: rec.fileSha256 } });
    return rec;
  }

  proposeMutation(user: User, objectId: string, input: { toTaxpayerId: string; dateEffet: string; documents: string[]; motif: string }) {
    const o = this.ctx.objects.get(objectId);
    if (o.attributes.objectType !== 'SITE_TELECOM') throw unprocessable('OBJECT_WRONG_TYPE', 'Mutation réservée aux sites télécoms.');
    authorize(user, P.siteMutation, this.res({ ...(o.taxpayerId ? { taxpayerId: o.taxpayerId } : {}) }));
    this.ctx.taxpayers.get(input.toTaxpayerId);
    if (o.taxpayerId === input.toTaxpayerId) throw unprocessable('SAME_OPERATOR', 'Le site est déjà rattaché à cet opérateur.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateEffet)) throw badRequest('INVALID_DATE', 'Date d’effet AAAA-MM-JJ attendue.');
    if (this.mutations.findOne((m) => m.objectId === objectId && m.status === 'PROPOSEE')) throw conflict('MUTATION_PENDING', 'Une mutation est déjà en cours pour ce site.');
    const m = this.mutations.insert({ id: this.ids.next('MUT-SIT'), objectId, fromTaxpayerId: o.taxpayerId ?? null, toTaxpayerId: input.toTaxpayerId, dateEffet: input.dateEffet, documents: input.documents, motif: input.motif, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.telecom.mutation.proposed', resourceType: 'site_mutation', resourceId: m.id, details: { objectId, from: m.fromTaxpayerId, to: m.toTaxpayerId, dateEffet: m.dateEffet } });
    return m;
  }

  decideMutation(user: User, id: string, input: { approve: boolean; motif: string }) {
    const m = this.mutations.get(id);
    if (!m) throw notFound('MUTATION_NOT_FOUND', `Mutation inconnue : ${id}`);
    authorize(user, P.sectorDecide, this.res());
    if (m.status !== 'PROPOSEE') throw conflict('MUTATION_CLOSED', 'Mutation déjà décidée.');
    assertDistinctPerson(user.id, [m.proposedBy], 'La décision de mutation est prise par une personne distincte de l’auteur de la demande.');
    const saved = this.mutations.update({ ...m, status: input.approve ? 'ACCEPTEE' : 'REFUSEE', decision: { by: user.id, at: this.now().toISOString(), motif: input.motif } });
    if (input.approve) {
      const o = this.ctx.objects.get(m.objectId);
      this.ctx.objects.setHolder(m.objectId, m.toTaxpayerId);
      this.ctx.objects.objects.update({ ...this.ctx.objects.get(m.objectId), attributes: { ...o.attributes, mutations: [...(Array.isArray(o.attributes.mutations) ? o.attributes.mutations as unknown[] : []), { from: m.fromTaxpayerId, to: m.toTaxpayerId, dateEffet: m.dateEffet, mutationId: m.id }] } });
      for (const tp of [m.fromTaxpayerId, m.toTaxpayerId]) {
        const t = tp ? this.ctx.taxpayers.taxpayers.get(tp) : undefined;
        if (t) this.ctx.comms.publish('approval.approved', [taxpayerRecipient(t)], { reference: m.id }, { entity: SECTOR_ENTITY });
      }
    }
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'verticales.telecom.mutation.accepted' : 'verticales.telecom.mutation.refused', resourceType: 'site_mutation', resourceId: id, details: { objectId: m.objectId, motif: input.motif } });
    return saved;
  }

  listMutations(user: User) {
    authorize(user, P.sectorRead, this.res());
    return this.mutations.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  /** Sites déclarés ↔ observés ↔ liquidés ↔ payés, par opérateur ; suivi grands redevables (module 56). */
  telecomRecovery(user: User, exercice = this.exercice()) {
    authorize(user, P.telecomReconcile, this.res());
    this.runAutomatic(exercice, ['16']);
    const sites = this.objectsOf('16');
    const rec = this.vx.telecomReconciliation(user);
    const byOp = new Map<string, FiscalObject[]>();
    for (const s of sites) byOp.set(s.taxpayerId ?? 'NON_IDENTIFIE', [...(byOp.get(s.taxpayerId ?? 'NON_IDENTIFIE') ?? []), s]);
    const operators = [...byOp.entries()].map(([tp, list]) => {
      const liqs = this.liquidations.find((l) => l.module === '16' && l.period === exercice && list.some((s) => s.id === l.objectId));
      const executed = liqs.filter((l) => l.status === 'EXECUTEE');
      const due: MoneyJSON[] = []; const paid: MoneyJSON[] = [];
      for (const l of executed) {
        const ob = this.ctx.assessment.obligations.get(l.obligationId!);
        if (ob) due.push(ob.amount);
        const p = paymentState(this.ctx, l.obligationId);
        if (p.amount) paid.push(p.amount);
      }
      const lt = tp !== 'NON_IDENTIFIE' ? this.vx.secteurs.largeTaxpayers.get(tp) : undefined;
      const dueSum = sumByCurrency(due); const paidSum = sumByCurrency(paid);
      return {
        taxpayerId: tp, name: tp === 'NON_IDENTIFIE' ? 'Opérateur non identifié' : this.ctx.taxpayers.taxpayers.get(tp)?.fullName ?? tp,
        sites: list.length, declared: list.filter((s) => s.probativeStatus === 'DECLARE').length, observed: list.filter((s) => s.probativeStatus === 'OBSERVE').length,
        verified: list.filter((s) => s.probativeStatus === 'VERIFIE').length, liquidated: executed.length, proposals: liqs.filter((l) => l.status !== 'EXECUTEE').length,
        due: dueSum, paid: paidSum,
        recoveryRate: dueSum.length === 1 && paidSum.length <= 1 ? pct(Number(paidSum[0]?.amount ?? '0'), Number(dueSum[0]!.amount)) : null,
        largeTaxpayer: lt ? { status: lt.status, sectors: lt.sectors } : null,
      };
    });
    return {
      exercice, rule: this.ruleView('16'), observedNotDeclared: rec.observedNotDeclared, declaredNotObserved: rec.declaredNotObserved,
      indicators: { sitesRecenses: sites.length, sitesDeclares: rec.declared, sitesObserves: rec.observed, concordants: rec.matched },
      operators, imports: this.siteImports.all().slice(-10).reverse(), mutations: this.mutations.find((m) => m.status === 'PROPOSEE').length,
      notice: 'Liquidation annuelle automatique par site sur règle ACTIVE (une fois par site et par exercice) ; sans règle ACTIVE, proposition seulement. Un site observé non déclaré passe par la vérification contradictoire.',
    };
  }

  // ================================================================== 25 — péage

  passage(user: User, input: { pointId: string; plate: string; lat?: number; lon?: number }) {
    const point = this.reference(input.pointId, '25');
    authorize(user, P.tollPassage, this.res({ communes: [point.commune] }));
    const plate = normalizePlate(input.plate);
    if (plate.length < 4) throw badRequest('INVALID_PLATE', 'Plaque illisible.');
    const obs = this.vx.secteurs.observe(user, '25', { source: 'PASSAGE_PEAGE', referenceId: point.id, plate, lines: { passages: '1' }, ...(input.lat !== undefined && input.lon !== undefined ? { gps: { lat: input.lat, lon: input.lon } } : {}) });
    const t = this.titres();
    let result: TollPassage['result'] = 'ACTE_REQUIS';
    let controlId: string | null = null; let constatId: string | null = null;
    let view: unknown = null;
    if (obs.titleCheck?.status !== 'ACTE_REQUIS' && t) {
      const v = t.control(user, { plate, module: '25', place: { commune: point.commune, label: point.label, ...(input.lat !== undefined ? { lat: input.lat } : {}), ...(input.lon !== undefined ? { lon: input.lon } : {}) } });
      result = v.result; controlId = v.controlId; constatId = v.constat?.id ?? null; view = v;
    }
    const p = this.passages.append({
      id: this.ids.next('PSG'), pointId: point.id, axisLabel: point.label, commune: point.commune, plate, at: this.now().toISOString(), by: user.id, observationId: obs.id,
      controlId, result, fraud: result === 'INVALIDE' || result === 'EXPIRE', constatId,
    });
    return {
      passage: p, control: view,
      notice: result === 'ACTE_REQUIS' ? 'Péage : acte requis — passage enregistré, aucun constat ni montant.' : result === 'VALIDE' ? 'Passage consommé sur le titre.' : 'Aucun titre valide : constat à instruire par une personne habilitée (aucun montant automatique).',
    };
  }

  /** Solde d'un carnet (et titres de péage) d'une plaque : contrôleur habilité ou titulaire. */
  carnet(user: User, plateRaw: string) {
    const plate = normalizePlate(plateRaw);
    const t = this.titres();
    const creds = t ? t.byPlate(plate, '25') : [];
    const holder = creds.length > 0 && creds.every((c) => c.holderTaxpayerId && (c.holderTaxpayerId === user.taxpayerId || (user.mandants ?? []).includes(c.holderTaxpayerId)));
    if (!holder) authorize(user, P.tollPassage, this.res(user.territory ? { communes: user.territory } : {}));
    const now = this.now();
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.toll.carnet.consulted', resourceType: 'plate', resourceId: plate, details: { found: creds.length } });
    return {
      plate, serverTime: now.toISOString(),
      titles: creds.map((c) => { const st = statusAt(c, now); return { number: c.number, typeCode: c.typeCode, model: c.model, usesTotal: c.usesTotal ?? null, usesLeft: c.usesLeft ?? null, status: st.status, text: st.text, validUntil: c.validUntil }; }),
    };
  }

  // ================================================================== 17 — boissons : livraisons, carte, points non autorisés, suivi

  recordDeliveries(user: User, input: { taxpayerId: string; period: string; fileSha256?: string; points: { label: string; commune: string; quartier?: string; lat: number; lon: number; volumeLitres: string; establishmentRef?: string }[] }) {
    authorize(user, P.beverageDeliveries);
    this.ctx.taxpayers.get(input.taxpayerId);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw badRequest('INVALID_PERIOD', 'Période AAAA-MM attendue.');
    const at = this.now().toISOString();
    const records: DeliveryRecord[] = [];
    for (const p of input.points) {
      if (!isCommune(p.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${p.commune}`);
      if (!DECIMAL.test(p.volumeLitres)) throw badRequest('INVALID_QUANTITY', 'Volume livré (litres) : nombre positif attendu.');
      const key = p.label.trim().toUpperCase();
      let point = this.deliveryPoints.findOne((x) => (x.label.toUpperCase() === key && x.commune === p.commune) || near(x, p));
      if (!point) point = this.deliveryPoints.insert({ id: this.ids.next('PLV'), label: p.label.trim(), commune: p.commune, quartier: p.quartier ?? null, lat: p.lat, lon: p.lon, establishmentRef: p.establishmentRef ?? null, suppliers: [input.taxpayerId], firstAt: at });
      else if (!point.suppliers.includes(input.taxpayerId)) point = this.deliveryPoints.update({ ...point, suppliers: [...point.suppliers, input.taxpayerId] });
      records.push(this.deliveries.append({ id: this.ids.next('LIV'), pointId: point.id, supplierTaxpayerId: input.taxpayerId, period: input.period, volumeLitres: p.volumeLitres, fileSha256: input.fileSha256 ?? null, by: user.id, at }));
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.beverage.deliveries.recorded', resourceType: 'taxpayer', resourceId: input.taxpayerId, details: { period: input.period, points: records.length, file: input.fileSha256 ?? null } });
    return { received: records.length, points: this.deliveryPoints.count() };
  }

  private pointStatus(p: DeliveryPoint): { status: 'AUTORISE' | 'NON_AUTORISE' | 'A_IDENTIFIER'; establishmentId: string | null; evidence: string | null } {
    const estabs = this.ctx.objects.objects.find((o) => o.attributes.objectType === 'ETABLISSEMENT');
    const e = estabs.find((o) => o.id === p.establishmentRef) ?? estabs.find((o) => near(o, p));
    if (!e) return { status: 'A_IDENTIFIER', establishmentId: null, evidence: null };
    const cert = this.vx.certificates.find((c) => c.objectId === e.id).find((c) => this.vx.certificateStatus(c) === 'VALIDE');
    if (cert) return { status: 'AUTORISE', establishmentId: e.id, evidence: cert.code };
    const t = this.titres();
    const cred = t?.credentials.find((c) => c.subject.objectId === e.id && ['10', '17'].includes(c.module)).find((c) => ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'].includes(statusAt(c, this.now()).status));
    if (cred) return { status: 'AUTORISE', establishmentId: e.id, evidence: cred.number };
    return { status: 'NON_AUTORISE', establishmentId: e.id, evidence: null };
  }

  /** Carte des points de livraison (données commerciales sensibles : accès restreint, consultation journalisée). */
  deliveryMap(user: User) {
    authorize(user, P.beverageSensitive, this.res());
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.beverage.map.consulted', resourceType: 'sector_module', resourceId: '17', details: { points: this.deliveryPoints.count() } });
    return this.deliveryPoints.all().map((p) => {
      const st = this.pointStatus(p);
      const vols = this.deliveries.find((d) => d.pointId === p.id);
      return { ...p, ...st, deliveries: vols.length, volumeLitres: decToString(vols.reduce((n, d) => n + dec(d.volumeLitres), 0n)), transmitted: this.transmissions.all().some((t) => t.pointIds.includes(p.id)) };
    });
  }

  /** Liste des points de vente livrés sans autorisation, à transmettre au registre des activités (module 10). */
  unauthorizedPoints(user: User) {
    return this.deliveryMap(user).filter((p) => p.status !== 'AUTORISE');
  }

  transmitToActivities(user: User, input: { pointIds: string[]; motif: string }) {
    authorize(user, P.beverageSensitive, this.res());
    const unknown = input.pointIds.filter((id) => !this.deliveryPoints.get(id));
    if (unknown.length) throw notFound('DELIVERY_POINT_NOT_FOUND', `Points inconnus : ${unknown.join(', ')}`);
    const authorized = input.pointIds.filter((id) => this.pointStatus(this.deliveryPoints.get(id)!).status === 'AUTORISE');
    if (authorized.length) throw unprocessable('POINT_AUTHORIZED', `Points déjà autorisés : ${authorized.join(', ')}.`);
    const tr = this.transmissions.append({ id: this.ids.next('TRM-10'), target: '10', pointIds: input.pointIds, motif: input.motif, by: user.id, at: this.now().toISOString() });
    // Registre des activités (module 10) : un point livré non identifié devient un établissement OBSERVÉ à régulariser
    // (vérification contradictoire, aucune obligation) ; un établissement connu sans autorisation est signalé.
    const engine = enginePrincipal('svc-fiches-transmission', 'Transmission des points de livraison au registre des activités', SECTOR_ENTITY);
    for (const id of input.pointIds) {
      const p = this.deliveryPoints.get(id)!;
      const st = this.pointStatus(p);
      if (st.establishmentId) {
        const e = this.ctx.objects.get(st.establishmentId);
        this.ctx.objects.objects.update({ ...e, attributes: { ...e.attributes, signalementsModule10: [...(Array.isArray(e.attributes.signalementsModule10) ? e.attributes.signalementsModule10 as string[] : []), tr.id] } });
      } else {
        const o = this.ctx.objects.create(engine, {
          category: 'ACTIVITE', commune: p.commune, quartier: p.quartier ?? p.commune, localityRank: 4, lat: p.lat, lon: p.lon,
          attributes: { verticale: 'entreprises', objectType: 'ETABLISSEMENT', nom: p.label, source: 'POINT_DE_LIVRAISON_BOISSONS', transmission: tr.id, deliveryPointId: p.id },
        });
        this.ctx.objects.setProbativeStatus(o.id, 'OBSERVE');
        this.deliveryPoints.update({ ...p, establishmentRef: o.id });
      }
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.beverage.points.transmitted', resourceType: 'transmission', resourceId: tr.id, details: { target: 'module 10 — registre des activités', points: tr.pointIds.length, motif: tr.motif } });
    return tr;
  }

  listTransmissions(user: User) {
    authorize(user, P.beverageSensitive, this.res());
    return this.transmissions.all().slice().reverse().map((t) => ({ ...t, points: t.pointIds.map((id) => this.deliveryPoints.get(id)?.label ?? id) }));
  }

  private monthsBetween(from: string, to: string): string[] {
    const out: string[] = [];
    let [y, m] = from.split('-').map(Number) as [number, number];
    const [ty, tm] = to.split('-').map(Number) as [number, number];
    while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
    return out;
  }

  /**
   * Cohérence mensuelle des volumes : mois non déclarés, variation par rapport au mois précédent (informative, sans seuil
   * inventé), livraisons du partenaire supérieures au volume déclaré, écarts défavorables des rapprochements.
   */
  volumeCoherence(user: User) {
    authorize(user, P.beverageSensitive, this.res());
    const decls = this.vx.secteurs.declarations.find((d) => d.kind === 'VOLUMES_BAT');
    const taxpayers = [...new Set([...decls.map((d) => d.taxpayerId), ...this.deliveries.all().map((d) => d.supplierTaxpayerId)])];
    const current = kinshasaDate(this.now()).slice(0, 7);
    const litres = (l: Record<string, string>) => ['biere_litres', 'alcools_litres', 'spiritueux_litres'].reduce((n, k) => n + (l[k] ? dec(l[k]!) : 0n), 0n);
    return taxpayers.map((tp) => {
      const mine = decls.filter((d) => d.taxpayerId === tp).sort((a, b) => a.period.localeCompare(b.period));
      const first = mine[0]?.period ?? this.deliveries.find((d) => d.supplierTaxpayerId === tp).map((d) => d.period).sort()[0] ?? current;
      const months = this.monthsBetween(first, current).map((period, i, arr) => {
        const d = mine.find((x) => x.period === period);
        const declared = d ? litres(d.lines) : null;
        const prevD = i > 0 ? mine.find((x) => x.period === arr[i - 1]) : undefined;
        const prev = prevD ? litres(prevD.lines) : null;
        const delivered = this.deliveries.find((x) => x.supplierTaxpayerId === tp && x.period === period).reduce((n, x) => n + dec(x.volumeLitres), 0n);
        const flags: string[] = [];
        if (!d && period < current) flags.push('NON_DECLARE');
        if (declared !== null && delivered > declared) flags.push('LIVRAISONS_SUPERIEURES_AU_DECLARE');
        if (d && (d.status === 'ECART_A_INSTRUIRE' || d.status === 'EN_CONTRADICTOIRE')) flags.push('ECART_RAPPROCHEMENT');
        return {
          period, declarationId: d?.id ?? null, status: d?.status ?? null, declaredLitres: declared === null ? null : decToString(declared), deliveredLitres: decToString(delivered),
          variationVsPreviousPct: declared !== null && prev !== null && prev > 0n ? pct(Number(decToString(declared - prev)), Number(decToString(prev))) : null, flags,
        };
      });
      return { taxpayerId: tp, name: this.ctx.taxpayers.taxpayers.get(tp)?.fullName ?? tp, months, incoherences: months.reduce((n, m) => n + m.flags.length, 0) };
    });
  }

  /** Suivi des paiements et relances par redevable (déclarations, obligations issues des liquidations du module 17). */
  beverageFollowUp(user: User) {
    authorize(user, P.beverageSensitive, this.res());
    return this.volumeCoherence(user).map((r) => {
      const liqs = this.liquidations.find((l) => l.module === '17' && l.taxpayerId === r.taxpayerId);
      const obligations = liqs.filter((l) => l.obligationId).map((l) => ({ liquidationId: l.id, period: l.period, obligationId: l.obligationId!, payment: paymentState(this.ctx, l.obligationId) }));
      return {
        taxpayerId: r.taxpayerId, name: r.name, missingDeclarations: r.months.filter((m) => m.flags.includes('NON_DECLARE')).map((m) => m.period),
        obligations, unpaid: obligations.filter((o) => o.payment.state !== 'PAYE' && o.payment.state !== 'RAPPROCHE').length,
        reminders: this.reminders.find((x) => x.taxpayerId === r.taxpayerId).slice(-5).reverse(),
        largeTaxpayer: this.vx.secteurs.largeTaxpayers.get(r.taxpayerId)?.status ?? null,
      };
    });
  }

  remind(user: User, taxpayerId: string, input: { kind: Reminder['kind']; motif: string }) {
    authorize(user, P.beverageSensitive, this.res());
    const tp = this.ctx.taxpayers.get(taxpayerId);
    const r = this.reminders.append({ id: this.ids.next('RLC'), taxpayerId, kind: input.kind, motif: input.motif, by: user.id, at: this.now().toISOString() });
    this.ctx.comms.publish(input.kind === 'DECLARATION' ? 'declaration.late' : 'recovery.reminder.1', [taxpayerRecipient(tp)], { reference: r.id }, { entity: SECTOR_ENTITY });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.beverage.reminder.sent', resourceType: 'taxpayer', resourceId: taxpayerId, details: { kind: input.kind, motif: input.motif } });
    return r;
  }

  // ================================================================== 19 — assainissement : portefeuille, application, avis unique

  portfolio(user: User, exercice = this.exercice()) {
    authorize(user, P.sectorRead, this.res());
    const c = this.config('19');
    const rs = this.ruleStatus('19');
    const cats = c.objectCategories;
    const objects = cats.length ? this.ctx.objects.objects.find((o) => cats.includes(o.category) && !!o.taxpayerId) : [];
    const items = objects.map((o) => {
      const done = this.existing('19', o.id, exercice);
      let state: 'DEJA_LIQUIDE' | 'A_LIQUIDER' | 'BASE_INCOMPLETE' | 'ACTE_REQUIS' = done?.status === 'EXECUTEE' ? 'DEJA_LIQUIDE' : 'ACTE_REQUIS';
      let missing: string[] = [];
      if (state !== 'DEJA_LIQUIDE' && rs.active) {
        missing = this.inputsFor(rs.active, this.baseFor('19', o, exercice)).missing;
        state = missing.length ? 'BASE_INCOMPLETE' : 'A_LIQUIDER';
      }
      return { objectId: o.id, category: o.category, commune: o.commune, taxpayerId: o.taxpayerId!, state, missing };
    });
    return {
      exercice, rule: this.ruleView('19'), categories: cats, total: items.length,
      byState: Object.fromEntries(['A_LIQUIDER', 'DEJA_LIQUIDE', 'BASE_INCOMPLETE', 'ACTE_REQUIS'].map((s) => [s, items.filter((i) => i.state === s).length])), items: items.slice(0, 500),
      notice: cats.length ? 'Rattachement automatique aux objets existants (aucun recensement supplémentaire).' : 'Catégories d’objets du portefeuille non configurées par la régie.',
    };
  }

  /** Application de la règle au portefeuille (commande de la régie) : idempotente par objet et exercice. */
  applyPortfolio(user: User, input: { exercice?: string; motif: string }) {
    authorize(user, P.sectorDecide, this.res());
    const exercice = input.exercice ?? this.exercice();
    if (!/^\d{4}$/.test(exercice)) throw badRequest('INVALID_YEAR', 'Exercice AAAA attendu.');
    const rs = this.ruleStatus('19');
    if (!rs.active) throw unprocessable('ACTE_REQUIS', 'Aucune règle ACTIVE configurée pour l’assainissement, la voirie et le drainage.');
    const pf = this.portfolio(user, exercice);
    let executed = 0; const skipped: { objectId: string; reason: string }[] = [];
    for (const it of pf.items) {
      if (it.state !== 'A_LIQUIDER') { skipped.push({ objectId: it.objectId, reason: it.state }); continue; }
      const o = this.ctx.objects.get(it.objectId);
      try {
        const l = this.existing('19', o.id, exercice) ?? this.createLiquidation(user, '19', o, exercice, 'AUTOMATIQUE');
        this.execute(l, rs.active, { id: user.id, auto: false });
        executed += 1;
      } catch (e) { skipped.push({ objectId: it.objectId, reason: e instanceof Error ? e.message : String(e) }); }
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sanitation.portfolio.applied', resourceType: 'sector_module', resourceId: '19', details: { exercice, executed, skipped: skipped.length, motif: input.motif } });
    return { exercice, executed, skipped };
  }

  /** Avis unique : toutes les obligations de l'objet pour l'exercice, sur un même avis (totaux par devise). */
  groupedNotice(user: User, objectId: string, exercice = this.exercice()) {
    const o = this.ctx.objects.get(objectId);
    if (!o.taxpayerId) throw unprocessable('OBJECT_WITHOUT_TAXPAYER', 'Objet sans redevable.');
    const own = user.taxpayerId === o.taxpayerId || (user.mandants ?? []).includes(o.taxpayerId);
    if (!own) authorize(user, P.sectorRead, this.res());
    const obls = this.ctx.assessment.obligations.find((ob) => ob.objectId === o.id && ob.status !== 'ANNULEE' && ob.createdAt.startsWith(exercice));
    if (!obls.length) throw unprocessable('NO_OBLIGATION', 'Aucune obligation pour cet objet et cet exercice.');
    const existing = this.groupedNotices.findOne((n) => n.objectId === o.id && n.exercice === exercice && n.obligationIds.length === obls.length);
    const n = existing ?? this.groupedNotices.insert({ id: this.ids.next('AVU'), objectId: o.id, taxpayerId: o.taxpayerId, exercice, obligationIds: obls.map((x) => x.id), totals: sumByCurrency(obls.map((x) => x.amount)), by: user.id, at: this.now().toISOString() });
    if (!existing) this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.notice.grouped', resourceType: 'fiscal_object', resourceId: o.id, details: { noticeId: n.id, obligations: n.obligationIds.length } });
    return {
      ...n, lines: obls.map((ob) => ({ obligationId: ob.id, label: ob.label, ruleCode: ob.ruleCode, amount: ob.amount, status: ob.status, payment: paymentState(this.ctx, ob.id).state })),
      paid: obls.every((ob) => ['PAYE', 'RAPPROCHE'].includes(paymentState(this.ctx, ob.id).state)),
    };
  }

  // ================================================================== 20, 21 — marchés et événements

  marketReconciliation(user: User) {
    authorize(user, P.domainPlan, this.res());
    return this.marketRows();
  }

  private marketRows() {
    return this.vx.marketPlan().map((m) => {
      const stallIds = new Set(m.stalls.map((s) => s.id));
      const titles = this.vx.titles.find((t) => stallIds.has(t.stallId));
      const paid: MoneyJSON[] = [];
      let paidTitles = 0;
      for (const t of titles) {
        const p = paymentState(this.ctx, t.obligationId);
        if (p.amount && (p.state === 'PAYE' || p.state === 'RAPPROCHE')) { paid.push(p.amount); paidTitles += 1; }
      }
      return {
        marketId: m.id, name: m.name, commune: m.commune, stalls: m.stalls.length, occupied: m.occupied, paidOccupied: m.paidOccupied,
        occupiedWithoutPaidTitle: m.occupied - m.paidOccupied, titles: titles.length, paidTitles, unpaidTitles: titles.length - paidTitles,
        paidOccupancyRate: pct(m.paidOccupied, m.occupied), revenue: sumByCurrency(paid),
      };
    });
  }

  eventsRevenue(user: User) {
    authorize(user, P.sectorRead, this.res());
    const events = this.ctx.objects.objects.find((o) => o.attributes.objectType === 'EVENEMENT');
    return events.map((e) => {
      const cert = this.vx.certificates.find((c) => c.objectId === e.id && c.kind === 'AUTORISATION_EVENEMENT')[0];
      const tk = this.vx.ticketing.findOne((t) => t.eventObjectId === e.id);
      const obls = this.ctx.assessment.obligations.find((ob) => ob.objectId === e.id && ob.status !== 'ANNULEE');
      const paid = obls.map((ob) => paymentState(this.ctx, ob.id)).filter((p) => p.amount && (p.state === 'PAYE' || p.state === 'RAPPROCHE' || p.state === 'PARTIEL')).map((p) => p.amount!);
      return {
        objectId: e.id, name: String(e.attributes.nom ?? e.id), commune: e.commune, authorized: !!cert && this.vx.certificateStatus(cert) !== 'REVOQUE', certificate: cert?.code ?? null,
        ticketsDeclared: tk?.ticketsSold ?? null, attendanceObserved: tk?.controls.at(-1)?.observedAttendance ?? null,
        gap: tk?.controls.length ? tk.controls.at(-1)!.gap : null, obligations: obls.length, revenue: sumByCurrency(paid),
      };
    });
  }

  // ================================================================== 13 — embarquement : titre à usage unique consommé au scan

  /**
   * Scan d'un titre d'embarquement au quai (QR ou code court) : le titre doit appartenir à CE départ ; il est consommé
   * au premier scan valide par le moteur de titres (§ 19A.4) et tout nouveau scan affiche « DÉJÀ UTILISÉ ». Un titre
   * d'un autre départ est refusé sans être consommé. Contrôleur sans encaissement (aucun paiement à l'agent de quai).
   */
  boardingScan(user: User, departureId: string, input: { qr?: string; code?: string; lat?: number; lon?: number; deviceId?: string }) {
    const d = this.departure(departureId);
    authorize(user, P.sectorObserve, this.res({ communes: [d.commune] }));
    if (d.status !== 'PREVU') throw conflict('DEPARTURE_CLOSED', `Embarquement clos : départ au statut ${d.status}.`);
    const t = this.titres();
    if (!t) throw unprocessable('TITRES_UNAVAILABLE', 'Moteur de titres non chargé.');
    const presented = (input.qr ?? input.code ?? '').trim();
    if (!presented) throw badRequest('NOTHING_PRESENTED', 'QR ou code court requis.');
    t.sync();
    const at = this.now().toISOString();
    const res = t.resolvePresented(presented, this.now().getTime());
    const mine = new Set(this.titlesOf(d).map((x) => x.id));
    if (res.credential && !mine.has(res.credential.id)) {
      const b = this.boardings.append({ id: this.ids.next('EMBQ'), departureId: d.id, controlId: null, result: 'AUTRE_DEPART', alreadyUsed: false, text: 'INVALIDE — titre d’un autre départ', by: user.id, at });
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.port.boarding.refused', resourceType: 'departure', resourceId: d.id, outcome: 'DENIED', details: { reason: 'AUTRE_DEPART', credential: res.credential.number } });
      return { boarding: b, control: null, notice: 'Titre d’un autre départ : embarquement refusé, titre non consommé.' };
    }
    const point = this.reference(d.pointId);
    const view = t.control(user, {
      ...(input.qr ? { qr: input.qr } : { code: presented }), module: '13', ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      place: { commune: point.commune, label: point.label, ...(input.lat !== undefined ? { lat: input.lat } : {}), ...(input.lon !== undefined ? { lon: input.lon } : {}) },
    });
    const b = this.boardings.append({
      id: this.ids.next('EMBQ'), departureId: d.id, controlId: view.controlId, result: view.result === 'VALIDE' ? 'VALIDE' : view.result === 'EXPIRE' ? 'EXPIRE' : 'INVALIDE',
      alreadyUsed: !!view.alreadyUsed, text: view.text, by: user.id, at,
    });
    if (view.result === 'VALIDE') {
      const cur = this.departure(d.id);
      this.departures.update({ ...cur, events: [...cur.events, { at, by: user.id, kind: 'EMBARQUEMENT', note: view.text }] });
    }
    return {
      boarding: b, control: view,
      notice: view.result === 'VALIDE' ? 'Embarquement validé : titre consommé.' : view.alreadyUsed ? 'DÉJÀ UTILISÉ : titre déjà consommé (constat sans montant).' : 'Titre non valide : constat à instruire (aucun montant automatique).',
    };
  }

  // ================================================================== 22 — carrières : bons de sortie à usage unique, comptage

  /** Bons de sortie par camion (plaque), payés par l'exploitant au compte public (Mobile Money ou point agréé). */
  orderExitSlips(user: User, objectId: string, input: { plates: string[]; channel: PaymentChannel }) {
    const o = this.objectForModule('22', objectId);
    authorize(user, P.departDeclare, this.res({ taxpayerId: o.taxpayerId! }));
    if (!DEPARTURE_CHANNELS.includes(input.channel)) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.quarry.slips.channel_refused', resourceType: 'fiscal_object', resourceId: o.id, outcome: 'DENIED', details: { channel: input.channel } });
      throw unprocessable('CHANNEL_NOT_ALLOWED', 'Bons de sortie : Mobile Money ou point agréé uniquement — jamais à un agent.');
    }
    const plates = [...new Set(input.plates.map((p) => normalizePlate(p)))];
    if (!plates.length || plates.some((p) => p.length < 4)) throw badRequest('INVALID_PLATE', 'Plaque de camion illisible.');
    const t = this.titres();
    if (!t) throw unprocessable('TITRES_UNAVAILABLE', 'Moteur de titres non chargé.');
    const typeCode = this.config('22').credentialTypeCode ?? 'CAR-BON';
    const label = String(o.attributes.nom ?? o.id);
    const iss = t.purchase(user, {
      payerTaxpayerId: o.taxpayerId!, channel: input.channel, context: `carriere:${o.id}`,
      items: plates.map((plate) => ({ typeCode, holderTaxpayerId: o.taxpayerId!, subject: { plate, objectId: o.id, label: `Sortie de ${label}` }, place: { commune: o.commune, sourceId: o.id, label, basis: 'LIEU_OBJET' as const, lat: o.lat, lon: o.lon } })),
    });
    const rec = this.slipOrders.append({ id: this.ids.next('BON'), objectId: o.id, issuanceId: iss.id, plates, typeCode, channel: input.channel, by: user.id, at: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.quarry.slips.ordered', resourceType: 'fiscal_object', resourceId: o.id, details: { issuanceId: iss.id, count: plates.length, typeCode } });
    return { order: rec, issuance: { id: iss.id, status: iss.status, payments: iss.payments.map((p) => ({ paymentReference: p.paymentReference, amount: p.amount, expiresAt: p.expiresAt })) } };
  }

  /**
   * Point de contrôle de sortie : chaque camion est COMPTÉ (observation « comptage des sorties », rapprochée ensuite des
   * déclarations) et son bon est contrôlé puis CONSOMMÉ (usage unique : un second passage affiche « DÉJÀ UTILISÉ »).
   * Un bon d'un autre site est refusé sans être consommé ; tout défaut produit un constat sans montant.
   */
  exitCheckpoint(user: User, objectId: string, input: { qr?: string; code?: string; plate?: string; volume_m3?: string; lat?: number; lon?: number; deviceId?: string }) {
    const o = this.objectForModule('22', objectId);
    authorize(user, P.sectorObserve, this.res({ communes: [o.commune] }));
    if (!input.qr && !input.code && !input.plate) throw badRequest('NOTHING_PRESENTED', 'QR, code court ou plaque du camion requis.');
    if (input.volume_m3 && !DECIMAL.test(input.volume_m3)) throw badRequest('INVALID_VOLUME', 'Volume (m³) : nombre positif attendu.');
    const t = this.titres();
    const now = this.now();
    let resolved: { id: string; module: string; objectId?: string; plate?: string } | undefined;
    if (t) {
      t.sync();
      const c = input.plate ? t.byPlate(input.plate, '22')[0] : t.resolvePresented((input.qr ?? input.code)!, now.getTime()).credential;
      if (c) resolved = { id: c.id, module: c.module, ...(c.subject.objectId ? { objectId: c.subject.objectId } : {}), ...(c.subject.plate ? { plate: c.subject.plate } : {}) };
    }
    const plate = input.plate ? normalizePlate(input.plate) : resolved?.plate ? normalizePlate(resolved.plate) : undefined;
    // Comptage d'abord (toute sortie est comptée, titre ou non), puis contrôle du bon.
    const obs = this.vx.secteurs.observe(user, '22', {
      source: 'COMPTAGE_SORTIES', objectId: o.id, lines: { camions: '1', ...(input.volume_m3 ? { volume_m3: input.volume_m3 } : {}) }, ...(plate ? { plate } : {}),
      ...(input.lat !== undefined && input.lon !== undefined ? { gps: { lat: input.lat, lon: input.lon } } : {}),
    });
    const at = now.toISOString();
    const presented: ExitPassage['presented'] = input.qr ? 'QR' : input.code ? 'CODE_COURT' : 'PLAQUE';
    if (resolved && resolved.module === '22' && resolved.objectId && resolved.objectId !== o.id) {
      const e = this.exits.append({ id: this.ids.next('SOR'), objectId: o.id, plate: plate ?? null, presented, observationId: obs.id, controlId: null, result: 'AUTRE_SITE', alreadyUsed: false, constatId: null, by: user.id, at });
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.quarry.exit.refused', resourceType: 'fiscal_object', resourceId: o.id, outcome: 'DENIED', details: { reason: 'AUTRE_SITE' } });
      return { exit: e, control: null, notice: 'Bon émis pour un autre site : sortie comptée, bon non consommé, vérification à faire.' };
    }
    if (!t || !this.vx.secteurs.credentialTypesOf('22').some((x) => x.activable)) {
      const e = this.exits.append({ id: this.ids.next('SOR'), objectId: o.id, plate: plate ?? null, presented, observationId: obs.id, controlId: null, result: 'ACTE_REQUIS', alreadyUsed: false, constatId: null, by: user.id, at });
      return { exit: e, control: null, notice: 'Bons de sortie : acte requis — sortie comptée, aucun constat ni montant.' };
    }
    const view = t.control(user, {
      ...(input.plate ? { plate: input.plate } : input.qr ? { qr: input.qr } : { code: input.code! }), module: '22', ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      place: { commune: o.commune, label: String(o.attributes.nom ?? o.id), ...(input.lat !== undefined ? { lat: input.lat } : {}), ...(input.lon !== undefined ? { lon: input.lon } : {}) },
    });
    const e = this.exits.append({
      id: this.ids.next('SOR'), objectId: o.id, plate: plate ?? null, presented, observationId: obs.id, controlId: view.controlId,
      result: view.result === 'VALIDE' ? 'VALIDE' : view.result === 'EXPIRE' ? 'EXPIRE' : 'INVALIDE', alreadyUsed: !!view.alreadyUsed, constatId: view.constat?.id ?? null, by: user.id, at,
    });
    return {
      exit: e, control: view,
      notice: view.result === 'VALIDE' ? 'Sortie autorisée : bon consommé.' : view.alreadyUsed ? 'DÉJÀ UTILISÉ : bon déjà consommé (constat sans montant).' : 'Aucun bon valide : constat à instruire par une personne habilitée (aucun montant automatique).',
    };
  }

  quarryExits(user: User, objectId: string) {
    const o = this.objectForModule('22', objectId);
    authorize(user, P.sectorRead, this.res());
    const exits = this.exits.find((e) => e.objectId === o.id).slice().reverse();
    return {
      objectId: o.id, total: exits.length, valid: exits.filter((e) => e.result === 'VALIDE').length, refused: exits.filter((e) => e.result !== 'VALIDE' && e.result !== 'ACTE_REQUIS').length,
      items: exits.slice(0, 200), slips: this.slipOrders.find((s) => s.objectId === o.id),
    };
  }

  // ================================================================== 25 — péage : achat d'un titre lié à la plaque

  /** Passage unique, carnet ou abonnement lié à la plaque (moteur de titres) ; paiement au compte public seulement. */
  buyToll(user: User, input: { typeCode: string; plate: string; pointId: string; channel: PaymentChannel; payerTaxpayerId?: string }) {
    const t = this.titres();
    if (!t) throw unprocessable('TITRES_UNAVAILABLE', 'Moteur de titres non chargé.');
    const type = t.type(input.typeCode);
    if (type.module !== '25') throw unprocessable('CREDENTIAL_TYPE_OTHER_MODULE', `Le type ${type.code} ne relève pas du péage.`);
    if (!DEPARTURE_CHANNELS.includes(input.channel)) throw unprocessable('CHANNEL_NOT_ALLOWED', 'Péage : Mobile Money ou point agréé uniquement — aucun encaissement non tracé.');
    const point = this.reference(input.pointId, '25');
    const payer = input.payerTaxpayerId ?? user.taxpayerId;
    if (!payer) throw badRequest('TAXPAYER_REQUIRED', 'Compte contribuable requis (compte unique MOSOLO).');
    const iss = t.purchase(user, {
      payerTaxpayerId: payer, channel: input.channel, context: `peage:${point.id}`,
      items: [{ typeCode: type.code, holderTaxpayerId: payer, subject: { plate: normalizePlate(input.plate), label: `Péage ${point.label}` }, place: { commune: point.commune, sourceId: point.id, label: point.label, basis: 'ZONE_SERVICE', lat: point.lat, lon: point.lon } }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.toll.title.ordered', resourceType: 'plate', resourceId: normalizePlate(input.plate), details: { typeCode: type.code, pointId: point.id, issuanceId: iss.id } });
    return { issuance: { id: iss.id, status: iss.status, payments: iss.payments.map((p) => ({ paymentReference: p.paymentReference, amount: p.amount, expiresAt: p.expiresAt })) } };
  }

  // ================================================================== 23 — forêts : déclaration au point de contrôle

  /** Déclaration de produits non ligneux enregistrée par l'agent du point de contrôle (vendeur enregistré ou non). */
  checkpointDeclaration(user: User, input: { pointId: string; produit: string; quantiteKg: string; taxpayerId?: string; declarant: string; plate?: string }) {
    const point = this.reference(input.pointId, '23');
    authorize(user, P.sectorObserve, this.res({ communes: [point.commune] }));
    if (!DECIMAL.test(input.quantiteKg)) throw badRequest('INVALID_QUANTITY', 'Quantité (kg) : nombre positif attendu.');
    if (input.taxpayerId) this.ctx.taxpayers.get(input.taxpayerId);
    const obs = this.vx.secteurs.observe(user, '23', { source: 'POINT_CONTROLE', referenceId: point.id, lines: { quantite_kg: input.quantiteKg }, ...(input.plate ? { plate: input.plate } : {}) });
    const d = this.forestDeclarations.append({
      id: this.ids.next('DPF'), pointId: point.id, commune: point.commune, produit: input.produit, quantiteKg: input.quantiteKg, taxpayerId: input.taxpayerId ?? null,
      declarant: input.declarant, plate: input.plate ? normalizePlate(input.plate) : null, observationId: obs.id, by: user.id, at: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.forest.checkpoint_declaration', resourceType: 'sector_reference', resourceId: point.id, details: { declarationId: d.id, produit: d.produit, quantiteKg: d.quantiteKg } });
    return d;
  }

  listForestDeclarations(user: User) {
    authorize(user, P.forestRead, this.res());
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.forest.consulted', resourceType: 'sector_module', resourceId: '23', details: { view: 'declarations' } });
    return this.forestDeclarations.all().slice().reverse().map((d) => ({ ...d, point: this.vx.secteurs.references.get(d.pointId)?.label ?? d.pointId }));
  }

  // ================================================================== 21 — événements : taxe sur billetterie déclarée ou contrôlée

  /**
   * Liquidation de la taxe sur la billetterie : sur la billetterie DÉCLARÉE, ou sur la fréquentation CONTRÔLÉE sur place
   * quand le contrôle révèle un écart — décision motivée d'une personne distincte du contrôleur (aucune taxation
   * automatique de l'écart). Règle ACTIVE du registre seulement (liquidation de la verticale Événements).
   */
  liquidateEvent(user: User, objectId: string, input: { basis: 'DECLAREE' | 'CONTROLEE'; motif: string }) {
    authorize(user, P.sectorDecide, this.res());
    const o = this.ctx.objects.get(objectId);
    if (o.attributes.objectType !== 'EVENEMENT') throw unprocessable('NOT_AN_EVENT', 'Cet objet n’est pas un événement.');
    const tk = this.vx.ticketing.findOne((x) => x.eventObjectId === o.id);
    if (!tk) throw unprocessable('NO_TICKETING_DECLARATION', 'Liquidation impossible sans déclaration de billetterie.');
    let inputs: Record<string, string> = {};
    if (input.basis === 'CONTROLEE') {
      const last = tk.controls.at(-1);
      if (!last) throw unprocessable('NO_CONTROL', 'Aucun contrôle sur place : liquider sur la billetterie déclarée.');
      if (last.gap <= 0) throw unprocessable('NO_GAP', 'Le contrôle ne révèle aucun écart défavorable : liquider sur la billetterie déclarée.');
      assertDistinctPerson(user.id, [last.by], 'La personne qui décide de liquider sur le contrôle est distincte du contrôleur.');
      inputs = { billets_vendus: String(last.observedAttendance) };
    }
    const ob = this.vx.liquidateObject(user, 'evenements', o.id, inputs);
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.event.liquidation.decided', resourceType: 'fiscal_object', resourceId: o.id, details: { basis: input.basis, motif: input.motif, obligationId: ob.id, tickets: inputs.billets_vendus ?? String(tk.ticketsSold) } });
    return { basis: input.basis, obligation: ob };
  }

  // ================================================================== 20 — marchés : abonnement du droit d'étal

  /** Abonnement (consentement du titulaire) : le titre mensuel suivant est demandé à l'échéance ; paiement toujours numérique. */
  subscribeStall(user: User, stallId: string, input: { consent: boolean }) {
    const stall = this.vx.stalls.get(stallId);
    if (!stall || !stall.holderTaxpayerId) throw notFound('STALL_NOT_FOUND', `Étal inconnu ou non attribué : ${stallId}`);
    authorize(user, P.marketTitle, { taxpayerId: stall.holderTaxpayerId });
    const cur = this.stallSubscriptions.findOne((x) => x.stallId === stallId && x.status === 'ACTIF');
    const at = this.now().toISOString();
    if (!input.consent) {
      if (!cur) throw notFound('SUBSCRIPTION_NOT_FOUND', 'Aucun abonnement actif pour cet étal.');
      const ended = this.stallSubscriptions.update({ ...cur, status: 'RESILIE', endedAt: at, endedBy: user.id });
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.stall.subscription.ended', resourceType: 'stall', resourceId: stallId, details: { subscriptionId: cur.id } });
      return ended;
    }
    if (cur) throw conflict('SUBSCRIPTION_EXISTS', 'Abonnement déjà actif pour cet étal.');
    const sub = this.stallSubscriptions.insert({ id: this.ids.next('ABO-ETAL'), stallId, taxpayerId: stall.holderTaxpayerId, status: 'ACTIF', consentAt: at, consentBy: user.id, renewals: [] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.stall.subscription.started', resourceType: 'stall', resourceId: stallId, details: { subscriptionId: sub.id } });
    this.runStallSubscriptions();
    return this.stallSubscriptions.get(sub.id)!;
  }

  mySubscriptions(user: User) {
    const tp = user.taxpayerId;
    return this.stallSubscriptions.find((x) => (tp && x.taxpayerId === tp) || (user.mandants ?? []).includes(x.taxpayerId));
  }

  /** Renouvellement des abonnements (idempotent) : titre MOIS demandé quand le titre courant est à moins de 1 %, échu ou absent. */
  runStallSubscriptions() {
    let renewed = 0;
    for (const sub of this.stallSubscriptions.find((x) => x.status === 'ACTIF')) {
      const cur = this.vx.currentTitle(sub.stallId);
      if (!['ROUGE', 'ECHU', 'AUCUN'].includes(cur.status)) continue;
      const holder: User = { kind: 'user', id: `abonnement:${sub.id}`, name: 'Abonnement du titulaire (consentement enregistré)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: sub.taxpayerId };
      try {
        const r = this.vx.requestStallTitle(holder, sub.stallId, 'MOIS');
        const latest = this.stallSubscriptions.get(sub.id)!;
        this.stallSubscriptions.update({ ...latest, renewals: [...latest.renewals, { at: this.now().toISOString(), obligationId: r.title.obligationId }] });
        renewed += 1;
      } catch { /* titre en attente de paiement ou règle non ACTIVE : passage suivant */ }
    }
    return { renewed };
  }

  // ================================================================== indicateurs des fiches (13 à 25)

  indicators(user: User) {
    authorize(user, P.sectorRead, this.res());
    const t = this.titres();
    const now = this.now();
    const year = this.exercice();
    type Ind = { key: string; label: string; value: string | number | MoneyJSON[] | { label: string; amounts: MoneyJSON[] }[] | null; measured: boolean; reason?: string };
    const m = (key: string, label: string, value: Ind['value']): Ind => ({ key, label, value, measured: true });
    const nm = (key: string, label: string, reason: string): Ind => ({ key, label, value: null, measured: false, reason });
    const credsOf = (mod: string) => t?.credentials.find((c) => c.module === mod) ?? [];
    const sum = (xs: MoneyJSON[]) => sumByCurrency(xs);
    const liqPaid = (mod: string, filter: (l: SectorLiquidation) => boolean = () => true) => sum(this.liquidations.find((l) => l.module === mod && !!l.obligationId && filter(l)).map((l) => paymentState(this.ctx, l.obligationId)).filter((p) => !!p.amount).map((p) => p.amount!));
    const out: Record<string, Ind[]> = {};

    // 13
    const deps = this.departures.all();
    const titles13 = credsOf('13');
    const gapManifest = deps.reduce((n, d) => n + ((d.titleMode === 'PAR_DEPART' ? (d.manifest ? 1 : 0) : d.manifest?.passengers ?? 0) - this.titlesOf(d).length), 0);
    out['13'] = [
      m('departsTraces', 'Départs tracés', deps.filter((d) => d.events.some((e) => e.kind === 'DEPART')).length),
      m('titresConsommes', 'Titres consommés', titles13.filter((c) => c.state === 'CONSOMME').length),
      deps.some((d) => d.manifest) ? m('ecartManifesteTitres', 'Écart manifeste / titres', gapManifest) : nm('ecartManifesteTitres', 'Écart manifeste / titres', 'Aucun manifeste déposé.'),
    ];
    // 14, 15 : tableaux de bord dédiés (mêmes données) — synthèse ici.
    const parking = this.ctx.ext.parking as { indicators?: (u: User) => { totals?: Record<string, unknown> } } | undefined;
    try {
      const pk = parking?.indicators?.(user)?.totals as Record<string, unknown> | undefined;
      const capOpen = Number(pk?.capacityOpen ?? 0);
      out['14'] = pk ? [
        m('occupation', 'Occupation (%)', (pk.occupancyRate as string | null) ?? null),
        capOpen ? m('rotation', 'Rotation (sessions payées du jour par place)', (Math.round((Number(pk.paidSessionsToday ?? 0) * 100) / capOpen) / 100).toFixed(2)) : nm('rotation', 'Rotation', 'Aucune zone ouverte (capacité nulle).'),
        capOpen ? m('recettesParPlace', 'Recettes par place', perUnit((pk.revenue as MoneyJSON[]) ?? [], String(capOpen))) : nm('recettesParPlace', 'Recettes par place', 'Aucune zone ouverte.'),
        m('tauxConformite', 'Taux de conformité (%)', (pk.complianceRate as string | null) ?? null),
      ] : [nm('stationnement', 'Stationnement', 'Module de stationnement non chargé.')];
    } catch { out['14'] = [nm('stationnement', 'Stationnement', 'Tableau de bord du stationnement réservé à la régie (accès refusé pour ce profil).')]; }
    const pub = this.ctx.ext.publicite as { indicators?: (u: User) => { totals: Record<string, unknown> } } | undefined;
    try {
      const pb = pub?.indicators?.(user)?.totals;
      out['15'] = pb ? [
        m('panneauxRecenses', 'Panneaux recensés', pb.devices as number), m('tauxAutorises', 'Taux de panneaux autorisés (%)', (pb.authorizedRate as string | null) ?? null),
        m('recettesParM2', 'Recettes par m²', (pb.revenuePerM2 as MoneyJSON[]) ?? []),
      ] : [nm('publicite', 'Publicité', 'Module de publicité non chargé.')];
    } catch { out['15'] = [nm('publicite', 'Publicité', 'Tableau de bord de la publicité réservé à la régie (accès refusé pour ce profil).')]; }
    // 16
    const sites = this.objectsOf('16');
    const executed16 = this.liquidations.find((l) => l.module === '16' && l.status === 'EXECUTEE');
    out['16'] = [
      m('sitesRecenses', 'Sites recensés', sites.length), m('sitesDeclares', 'Sites déclarés', sites.filter((s) => s.probativeStatus === 'DECLARE' || s.probativeStatus === 'VERIFIE').length),
      executed16.length ? m('recouvrement', 'Recouvrement (payé, toutes opérateurs)', liqPaid('16')) : nm('recouvrement', 'Recouvrement par opérateur', 'Aucune liquidation exécutée (règle non ACTIVE : acte requis).'),
    ];
    // 17
    const vb = this.vx.secteurs.declarations.find((d) => d.kind === 'VOLUMES_BAT');
    const totalLitres = vb.reduce((n, d) => n + Object.values(d.lines).reduce((a, v) => a + dec(v), 0n), 0n);
    const gaps17 = vb.filter((d) => d.reconciliation).reduce((n, d) => n + d.reconciliation!.bySource.reduce((a, s) => a + Object.values(s.gaps).reduce((b, g) => b + dec(g), 0n), 0n), 0n);
    const liq17 = this.liquidations.find((l) => l.module === '17' && !!l.obligationId);
    out['17'] = [
      m('volumesDeclares', 'Volumes déclarés (unités cumulées)', decToString(totalLitres)),
      vb.some((d) => d.reconciliation) ? m('ecartRapprochement', 'Écart de rapprochement (observé − déclaré)', decToString(gaps17)) : nm('ecartRapprochement', 'Écart de rapprochement', 'Aucun rapprochement effectué (données d’accises ou de facturation absentes).'),
      liq17.length ? m('recettesMensuelles', `Recettes du mois ${kinshasaDate(now).slice(0, 7)}`, liqPaid('17', (l) => l.period === kinshasaDate(now).slice(0, 7))) : nm('recettesMensuelles', 'Recettes mensuelles', 'Aucune liquidation (acte requis).'),
    ];
    // 18
    const pi = this.plastique?.indicators();
    out['18'] = pi ? [m('assujettisIdentifies', 'Assujettis identifiés', pi.assujettis), m('simulations', 'Simulations réalisées', pi.simulations)] : [nm('plastique', 'Contribution plastique', 'Module non chargé.')];
    // 19
    const liq19 = this.liquidations.find((l) => l.module === '19' && l.status === 'EXECUTEE');
    const gn = this.groupedNotices.all();
    out['19'] = [
      liq19.length ? m('recettesParObjet', 'Recettes par objet (payé / objets liquidés)', perUnit(liqPaid('19'), String(new Set(liq19.map((l) => l.objectId)).size))) : nm('recettesParObjet', 'Recettes par objet', 'Aucune liquidation (règle non ACTIVE ou portefeuille non configuré).'),
      gn.length ? m('tauxPaiementGroupe', 'Taux de paiement groupé (%)', pct(gn.filter((n) => n.obligationIds.every((id) => ['PAYE', 'RAPPROCHE'].includes(paymentState(this.ctx, id).state))).length, gn.length)) : nm('tauxPaiementGroupe', 'Taux de paiement groupé', 'Aucun avis unique émis.'),
    ];
    // 20
    const mr = this.marketRows();
    const occ = mr.reduce((n, x) => n + x.occupied, 0);
    out['20'] = [
      m('etalsRecenses', 'Étals recensés', mr.reduce((n, x) => n + x.stalls, 0)),
      occ ? m('tauxOccupationPayee', 'Taux d’occupation payée (%)', pct(mr.reduce((n, x) => n + x.paidOccupied, 0), occ)) : nm('tauxOccupationPayee', 'Taux d’occupation payée', 'Aucun étal occupé.'),
      m('recettesParMarche', 'Recettes par marché', mr.map((x) => ({ label: x.name, amounts: x.revenue }))),
    ];
    // 21
    const ev = this.eventsRevenue(user);
    out['21'] = [m('evenementsAutorises', 'Événements autorisés', ev.filter((e) => e.authorized).length), m('recettesParEvenement', 'Recettes des événements', sum(ev.flatMap((e) => e.revenue)))];
    // 22
    const quarries = this.objectsOf('22');
    const active22 = quarries.filter((q) => this.vx.secteurs.declarations.find((d) => d.objectId === q.id && d.period.startsWith(year)).length > 0 || this.vx.secteurs.observations.find((o) => o.objectId === q.id && o.period.startsWith(year)).length > 0);
    const decl22 = this.vx.secteurs.declarations.find((d) => d.kind === 'SORTIES_CARRIERE' && !!d.reconciliation);
    out['22'] = [
      m('sitesActifs', `Sites actifs (exercice ${year})`, active22.length),
      decl22.length ? m('ecartSortiesDeclarations', 'Écart sorties comptées / déclarées (camions)', decToString(decl22.reduce((n, d) => n + d.reconciliation!.bySource.reduce((a, s) => a + (s.gaps.camions ? dec(s.gaps.camions) : 0n), 0n), 0n))) : nm('ecartSortiesDeclarations', 'Écart sorties / déclarations', 'Aucun rapprochement de sorties effectué.'),
    ];
    // 23
    out['23'] = [
      m('concessionsLiquidees', 'Concessions liquidées', new Set(this.liquidations.find((l) => l.module === '23' && l.status === 'EXECUTEE').map((l) => l.objectId)).size),
      m('declarationsEnregistrees', 'Déclarations enregistrées (points de contrôle)', this.vx.secteurs.declarations.find((d) => d.kind === 'PFNL').length + this.vx.secteurs.observations.find((o) => o.module === '23').length),
    ];
    // 24
    const accost = credsOf('24');
    out['24'] = [
      m('embarcationsRecensees', 'Embarcations recensées', this.objectsOf('24').length),
      m('mouvementsTraces', 'Mouvements tracés', deps.reduce((n, d) => n + d.events.filter((e) => e.kind === 'DEPART' || e.kind === 'ARRIVEE').length, 0)),
      accost.length || this.liquidations.find((l) => l.module === '24' && !!l.obligationId).length ? m('recettesPortuaires', 'Recettes portuaires', sum([...accost.filter((c) => c.amount).map((c) => c.amount!), ...liqPaid('24')])) : nm('recettesPortuaires', 'Recettes portuaires', 'Aucun titre d’accostage ni liquidation (acte requis, cadrage J30).'),
    ];
    // 25
    const ps = this.passages.all();
    const axes = [...new Set(ps.map((p) => p.pointId))];
    const creds25 = credsOf('25');
    out['25'] = [
      m('passages', 'Passages', ps.length),
      creds25.length ? m('recettesParAxe', 'Recettes par axe', [...new Set([...axes, ...creds25.map((c) => c.place.sourceId)])].map((a) => ({ label: this.vx.secteurs.references.get(a)?.label ?? a, amounts: sum(creds25.filter((c) => c.place.sourceId === a && c.amount).map((c) => c.amount!)) }))) : nm('recettesParAxe', 'Recettes par axe', 'Aucun titre de péage émis (acte requis).'),
      m('fraudeDetectee', 'Fraude détectée (passages sans titre valide)', ps.filter((p) => p.fraud).length),
    ];
    return { generatedAt: now.toISOString(), modules: FICHE_MODULES.map((mod) => ({ module: mod, rule: this.ruleView(mod), indicators: out[mod] ?? [] })) };
  }
}
