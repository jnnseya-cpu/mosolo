/**
 * Modules sectoriels du catalogue (§ 11) branchés sur le socle commun, derrière ACTE_REQUIS :
 *  11 Véhicules et circulation (vignette, taxe spéciale de circulation, mutations, contrôle par plaque),
 *  13 / 24 Embarquement, ports et accostage (points, quais, relevés, titres à usage unique),
 *  16 Antennes (sites, opérateurs, liquidation annuelle proposée),
 *  17 Boissons, alcools et tabac + 56 Grands redevables (déclaration mensuelle des volumes rapprochée des données
 *     d'accises et de facturation),
 *  21 Spectacles (billetterie déclarée — voir la verticale Événements),
 *  22 Carrières (sites, sorties de camions comptées rapprochées des déclarations, bons de sortie),
 *  23 Recettes forestières (concessions, produits non ligneux aux points de contrôle),
 *  25 Péage provincial (axes, passages, reçus électroniques).
 *
 * Doctrine : aucune obligation ni aucun montant tant que l'acte n'est pas adopté (ACTE_REQUIS) ; les titres sont ceux
 * du moteur de titres (§ 19A.4, types amorcés non activables) ; un écart entre déclaration et données observées ouvre
 * une procédure CONTRADICTOIRE, jamais une taxation automatique ; la personne qui décide est distincte de celle qui a
 * rapproché. Réponse de contrôle minimale : ni nom ni adresse.
 */
import { normalizePlate } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { dec, decToString } from '../../core/decimal.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { TitresService } from '../titres/service.js';
import { statusAt } from '../titres/validity.js';
import { P } from './policies.js';
import type { VerticalesService } from './service.js';

export const SECTOR_ENTITY = 'DGTK';

export const OBSERVATION_SOURCES = [
  'ACCISES', 'FACTURATION', 'COMPTAGE_SORTIES', 'POINT_CONTROLE', 'PASSAGE_PEAGE', 'RELEVE_EMBARQUEMENT', 'RELEVE_ACCOSTAGE',
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];
export const SOURCE_LABEL: Record<ObservationSource, string> = {
  ACCISES: 'Données d’accises (protocole)', FACTURATION: 'Données de facturation (protocole)', COMPTAGE_SORTIES: 'Comptage des sorties de camions',
  POINT_CONTROLE: 'Relevé au point de contrôle', PASSAGE_PEAGE: 'Passage au péage', RELEVE_EMBARQUEMENT: 'Relevé d’embarquement', RELEVE_ACCOSTAGE: 'Relevé d’accostage',
};
/** Sources versées par un partenaire de données sous protocole (jamais par un agent de terrain). */
const THIRD_PARTY: ObservationSource[] = ['ACCISES', 'FACTURATION'];

export const DECLARATION_KINDS = {
  VOLUMES_BAT: {
    module: '17', label: 'Déclaration mensuelle des volumes (bière, alcools, spiritueux, tabac)',
    keys: { biere_litres: 'Bière (litres)', alcools_litres: 'Vins et alcools (litres)', spiritueux_litres: 'Spiritueux (litres)', tabac_unites: 'Tabac (unités)' },
    sources: ['ACCISES', 'FACTURATION'] as ObservationSource[],
  },
  SORTIES_CARRIERE: {
    module: '22', label: 'Déclaration mensuelle des sorties de carrière', objectType: 'CARRIERE',
    keys: { camions: 'Camions sortis', volume_m3: 'Volume extrait (m³)' }, sources: ['COMPTAGE_SORTIES'] as ObservationSource[],
  },
  PFNL: {
    module: '23', label: 'Déclaration de produits forestiers non ligneux', keys: { quantite_kg: 'Quantité (kg)' }, sources: ['POINT_CONTROLE'] as ObservationSource[],
  },
} as const;
export type DeclarationKind = keyof typeof DECLARATION_KINDS;
type KindDef = { module: string; label: string; keys: Record<string, string>; sources: ObservationSource[]; objectType?: string };
const kindDef = (k: DeclarationKind): KindDef => DECLARATION_KINDS[k] as KindDef;

export interface SectorModuleDef {
  module: string;
  name: string;
  function: string;
  vertical: string;
  legal: 'ACTE_REQUIS';
  prerequisites: string[];
  revenueCodes: string[];
  objectTypes: string[];
  credentialTypes: string[];
  declarations: DeclarationKind[];
  observationSources: ObservationSource[];
  referenceKinds: SectorReference['kind'][];
  control: ('PLAQUE' | 'QR' | 'CODE_COURT')[];
  routes: string[];
  note?: string;
}

/** Catalogue des modules sectoriels (noms du § 11, fonction principale ; verticale de rattachement du § 11.1). */
export const SECTOR_MODULES: SectorModuleDef[] = [
  { module: '11', name: 'Véhicules et circulation', function: 'Vignette, taxe de circulation, mutations, contrôles', vertical: 'mobilite', legal: 'ACTE_REQUIS',
    prerequisites: ['J3 — barèmes véhicules', 'J1 — taxe spéciale de circulation', 'Protocole avec le pouvoir central (immatriculations)'],
    revenueCodes: ['R71-VIG', 'R72-TSCR'], objectTypes: ['VEHICULE'], credentialTypes: ['VIG-ANNUELLE', 'TSC-ANNUELLE'], declarations: [], observationSources: [], referenceKinds: [],
    control: ['PLAQUE', 'QR'], routes: ['GET /v1/verticales/vehicules/:plaque/controle', 'POST /v1/verticales/mobilite/cases (DECLARATION_MUTATION)'] },
  { module: '13', name: 'Embarquement et débarquement', function: 'Points, flux, perception, reçus', vertical: 'ports', legal: 'ACTE_REQUIS',
    prerequisites: ['J30 — cadrage sectoriel et base légale'], revenueCodes: ['R73-TRANSPORT-EMB'], objectTypes: ['EMBARCATION'], credentialTypes: ['EMB-CARTE'],
    declarations: [], observationSources: ['RELEVE_EMBARQUEMENT'], referenceKinds: ['POINT_EMBARQUEMENT'], control: ['QR', 'CODE_COURT'], routes: ['POST /v1/verticales/secteurs/13/releves'] },
  { module: '16', name: 'Antennes et infrastructures télécoms', function: 'Sites, opérateurs, liquidation annuelle', vertical: 'telecom', legal: 'ACTE_REQUIS',
    prerequisites: ['J1, J3 — base légale et barème', 'J13 — protocole avec les opérateurs et l’ARPTC'], revenueCodes: ['R73-ANTENNES'], objectTypes: ['SITE_TELECOM'], credentialTypes: [],
    declarations: [], observationSources: [], referenceKinds: [], control: ['QR'], routes: ['GET /v1/verticales/secteurs/antennes/liquidation-annuelle', 'GET /v1/verticales/telecom/reconciliation'],
    note: 'Liquidation annuelle : proposée par le système, exécutée par une personne sur une règle ACTIVE — aucune taxation automatique.' },
  { module: '17', name: 'Boissons, alcools et tabac', function: 'Volumes, déclarations, rapprochement grands redevables', vertical: 'entreprises', legal: 'ACTE_REQUIS',
    prerequisites: ['J1 — taxe d’intérêt commun et clé', 'J13 — protocoles de données (accises, facturation)'], revenueCodes: ['R72-CONSO-BAT', 'R73-DEBIT-BOISSONS'], objectTypes: ['ETABLISSEMENT'], credentialTypes: [],
    declarations: ['VOLUMES_BAT'], observationSources: ['ACCISES', 'FACTURATION'], referenceKinds: [], control: [], routes: ['POST /v1/verticales/secteurs/declarations', 'POST /v1/verticales/secteurs/donnees-tierces'] },
  { module: '21', name: 'Spectacles et événements', function: 'Autorisations, billetterie déclarée, liquidation', vertical: 'evenements', legal: 'ACTE_REQUIS',
    prerequisites: ['J1, J3 — base légale et tarif'], revenueCodes: ['R73-SPECTACLES'], objectTypes: ['EVENEMENT'], credentialTypes: [], declarations: [], observationSources: [], referenceKinds: [],
    control: ['QR'], routes: ['POST /v1/verticales/evenements/cases (DECLARATION_BILLETTERIE)', 'POST /v1/verticales/evenements/events/:objectId/ticketing', 'POST /v1/verticales/evenements/events/:objectId/controls'],
    note: 'La billetterie déclarée est rapprochée du contrôle de jauge sur place (verticale Événements).' },
  { module: '22', name: 'Carrières et recettes minières', function: 'Sites, superficies, flux, déclarations', vertical: 'construction', legal: 'ACTE_REQUIS',
    prerequisites: ['J1 — base légale des carrières'], revenueCodes: ['R73-CARRIERES', 'R71-SUP-MIN', 'R72-MAT-PREC'], objectTypes: ['CARRIERE'], credentialTypes: ['CAR-BON'],
    declarations: ['SORTIES_CARRIERE'], observationSources: ['COMPTAGE_SORTIES'], referenceKinds: [], control: ['PLAQUE', 'QR', 'CODE_COURT'], routes: ['POST /v1/verticales/secteurs/22/releves'] },
  { module: '23', name: 'Recettes forestières', function: 'Concessions, produits non ligneux', vertical: 'environnement', legal: 'ACTE_REQUIS',
    prerequisites: ['Base légale forestière provinciale à certifier (chapitre 6)'], revenueCodes: ['R72-SUP-FOR', 'R73-PFNL'], objectTypes: ['CONCESSION_FORESTIERE'], credentialTypes: [],
    declarations: ['PFNL'], observationSources: ['POINT_CONTROLE'], referenceKinds: ['POINT_CONTROLE'], control: [], routes: ['POST /v1/verticales/secteurs/23/releves'],
    note: 'Rattachement à la verticale Environnement indicatif [À VÉRIFIER] : le § 11.1 ne le précise pas.' },
  { module: '24', name: 'Ports, embarcations et accostage', function: 'Embarcations, quais, mouvements, redevances', vertical: 'ports', legal: 'ACTE_REQUIS',
    prerequisites: ['J30 — cadrage sectoriel et base légale'], revenueCodes: ['R73-PEAGE-ACCOSTAGE'], objectTypes: ['EMBARCATION'], credentialTypes: ['ACC-ACCOSTAGE'],
    declarations: [], observationSources: ['RELEVE_ACCOSTAGE'], referenceKinds: ['QUAI'], control: ['QR', 'CODE_COURT'], routes: ['POST /v1/verticales/secteurs/24/releves'] },
  { module: '25', name: 'Péage provincial', function: 'Axes, passages, reçus électroniques', vertical: 'mobilite', legal: 'ACTE_REQUIS',
    prerequisites: ['J1 — péage (acte)'], revenueCodes: ['R73-PEAGE-ACCOSTAGE'], objectTypes: ['VEHICULE'], credentialTypes: ['PEA-PASSAGE', 'PEA-CARNET', 'PEA-ABONNEMENT'],
    declarations: [], observationSources: ['PASSAGE_PEAGE'], referenceKinds: ['AXE'], control: ['PLAQUE', 'QR'], routes: ['POST /v1/verticales/secteurs/25/releves'] },
  { module: '56', name: 'Grands redevables', function: 'Suivi dédié des redevables à fort enjeu', vertical: 'entreprises', legal: 'ACTE_REQUIS',
    prerequisites: ['J13 — conventions de déclaration et de rapprochement'], revenueCodes: ['R72-CONSO-BAT', 'R73-ANTENNES', 'R73-CARRIERES'], objectTypes: [], credentialTypes: [],
    declarations: [], observationSources: [], referenceKinds: [], control: [], routes: ['POST /v1/verticales/secteurs/grands-redevables'] },
];

export interface SectorReference {
  id: string;
  module: string;
  kind: 'AXE' | 'QUAI' | 'POINT_EMBARQUEMENT' | 'POINT_CONTROLE' | 'POINT_PEAGE';
  label: string;
  commune: string;
  lat: number;
  lon: number;
  demo: boolean;
  /** Opérateur de rattachement (point d'embarquement, port privé) — fiches 13 et 24. */
  operatorTaxpayerId?: string;
  /** Quai ou port privé (fiche 24). */
  privateQuay?: boolean;
}

export interface SectorObservation {
  id: string;
  module: string;
  source: ObservationSource;
  referenceId?: string;
  objectId?: string;
  taxpayerId?: string;
  plate?: string;
  commune: string;
  period: string;
  lines: Record<string, string>;
  fileSha256?: string;
  gps?: { lat: number; lon: number; accuracyM?: number };
  titleCheck?: { status: 'ACTE_REQUIS' | 'TITRE_VALIDE' | 'AUCUN_TITRE_VALIDE' | 'SANS_OBJET'; detail: string };
  by: string;
  at: string;
}

export type DeclarationStatus = 'DEPOSEE' | 'RAPPROCHEE' | 'ECART_A_INSTRUIRE' | 'SANS_DONNEE_TIERCE' | 'VALIDEE' | 'EN_CONTRADICTOIRE';
export interface SectorDeclaration {
  id: string;
  module: string;
  kind: DeclarationKind;
  taxpayerId: string;
  objectId?: string;
  commune: string | null;
  entity: string;
  period: string;
  lines: Record<string, string>;
  documents: string[];
  status: DeclarationStatus;
  reconciliation?: { by: string; at: string; bySource: { source: ObservationSource; observed: Record<string, string>; gaps: Record<string, string>; records: number }[]; proposal: 'VALIDER' | 'OUVRIR_CONTRADICTOIRE'; note: string };
  contradictory: { by: string; at: string; text: string; documents: string[] }[];
  decision?: { by: string; at: string; decision: 'VALIDER' | 'OUVRIR_CONTRADICTOIRE'; motif: string };
  liquidation: { status: 'ACTE_REQUIS'; note: string };
  declaredBy: string;
  declaredAt: string;
}

export interface LargeTaxpayer {
  id: string;
  taxpayerId: string;
  sectors: string[];
  status: 'SUIVI' | 'LEVE';
  history: { by: string; at: string; action: 'DESIGNATION' | 'LEVEE'; motif: string }[];
}

/** Quantités relevées sur le terrain, par source. */
const OBSERVATION_KEYS: Partial<Record<ObservationSource, Record<string, string>>> = {
  COMPTAGE_SORTIES: { camions: 'Camions', volume_m3: 'Volume (m³)' }, POINT_CONTROLE: { quantite_kg: 'Quantité (kg)' }, PASSAGE_PEAGE: { passages: 'Passages' },
  RELEVE_EMBARQUEMENT: { passagers: 'Passagers' }, RELEVE_ACCOSTAGE: { accostages: 'Accostages', passagers: 'Passagers' },
};
const VALID_STATUSES = ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'];

const DECIMAL = /^\d{1,12}(\.\d{1,4})?$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const NO_LEVY_NOTE = 'Acte requis : aucune obligation ni aucun montant ne peut être émis ; l’écart éventuel ouvre une procédure contradictoire.';

export class SecteursService {
  readonly references = new InMemoryRepository<SectorReference>();
  readonly observations = new InMemoryAppendOnlyRepository<SectorObservation>();
  readonly declarations = new InMemoryRepository<SectorDeclaration>();
  readonly largeTaxpayers = new InMemoryRepository<LargeTaxpayer>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly vx: VerticalesService) {}

  private now(): Date { return this.ctx.clock.now(); }
  private period(): string { return kinshasaDate(this.now()).slice(0, 7); }
  private titres(): TitresService | undefined { return this.ctx.ext.titres as TitresService | undefined; }

  moduleDef(module: string): SectorModuleDef {
    const m = SECTOR_MODULES.find((x) => x.module === module);
    if (!m) throw notFound('SECTOR_MODULE_NOT_FOUND', `Module sectoriel inconnu : ${module}`);
    return m;
  }

  /** Types de titres du moteur (§ 19A.4) portés par un module : statut d'activation, jamais un prix inventé. */
  private credentialTypes(m: SectorModuleDef) {
    const t = this.titres();
    // Types amorcés du catalogue (acte requis), puis les types que la régie a retenus pour le module dans la
    // configuration de la fiche (avec la référence de l'acte) — par exemple un type de DÉMONSTRATION [EXEMPLE] sur
    // règle fictive ACTIVE. Chacun garde son statut d'activation et sa marque demo.
    const extra = (this.vx.fiches?.configuredTypes(m.module) ?? []).filter((c) => !m.credentialTypes.includes(c));
    return [...m.credentialTypes, ...extra].map((code) => {
      const type = t ? t.types.find((x) => x.code === code).sort((a, b) => b.version - a.version)[0] : undefined;
      const act = type && t ? t.activation(type) : { ok: false as const, reason: 'Moteur de titres non chargé.' };
      return { code, label: type?.label ?? code, prefix: type?.prefix ?? null, model: type?.validity.model ?? null, legalAct: type?.legalAct ?? null, demo: type?.demo === true, activable: act.ok, reason: act.ok ? null : act.reason };
    });
  }

  /** Types de titres d'un module sectoriel (catalogue et types retenus par la régie), avec leur statut d'activation. */
  credentialTypesOf(module: string) {
    return this.credentialTypes(this.moduleDef(module));
  }

  /** Tous les types déclarés au moteur de titres pour un module (choix offert à la régie dans la configuration). */
  availableCredentialTypes(module: string) {
    const t = this.titres();
    if (!t) return [];
    const codes = [...new Set(t.types.all().filter((x) => x.module === module).map((x) => x.code))];
    return codes.map((code) => {
      const type = t.types.find((x) => x.code === code).sort((a, b) => b.version - a.version)[0]!;
      const act = t.activation(type);
      return { code, label: type.label, model: type.validity.model, demo: type.demo, legalAct: type.legalAct, activable: act.ok, reason: act.ok ? null : act.reason };
    });
  }

  catalogue() {
    return SECTOR_MODULES.map((m) => ({
      ...m, verticalName: this.vx.vertical(m.vertical).name,
      declarationKinds: m.declarations.map((k) => ({ kind: k, ...kindDef(k) })),
      credentialTypes: this.credentialTypes(m),
      counts: {
        references: this.references.find((r) => r.module === m.module).length,
        declarations: this.declarations.find((d) => d.module === m.module).length,
        observations: this.observations.find((o) => o.module === m.module).length,
      },
    }));
  }

  moduleDetail(user: User, module: string) {
    const m = this.moduleDef(module);
    authorize(user, P.sectorRead, { entity: SECTOR_ENTITY });
    const obs = this.observations.find((o) => o.module === module);
    return {
      ...this.catalogue().find((x) => x.module === module)!,
      references: this.references.find((r) => r.module === module),
      observations: { total: obs.length, bySource: m.observationSources.map((s) => ({ source: s, label: SOURCE_LABEL[s], count: obs.filter((o) => o.source === s).length })) },
      liquidation: { status: 'ACTE_REQUIS', note: NO_LEVY_NOTE },
    };
  }

  // ------------------------------------------------------------------ déclarations du redevable

  private checkLines(keys: Record<string, string>, lines: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(lines)) {
      if (!(k in keys)) throw badRequest('UNKNOWN_QUANTITY', `Quantité non prévue : ${k}`);
      if (!DECIMAL.test(v)) throw badRequest('INVALID_QUANTITY', `${keys[k]} : nombre positif attendu.`);
      out[k] = v;
    }
    if (!Object.keys(out).length) throw badRequest('QUANTITIES_REQUIRED', 'Au moins une quantité est requise.');
    return out;
  }

  declare(user: User, input: { kind: DeclarationKind; taxpayerId?: string; objectId?: string; period: string; lines: Record<string, string>; documents: string[] }) {
    const def = kindDef(input.kind);
    const taxpayerId = input.taxpayerId ?? user.taxpayerId;
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable concerné requis (mandataire : préciser taxpayerId).');
    this.ctx.taxpayers.get(taxpayerId);
    authorize(user, P.sectorDeclare, { taxpayerId });
    if (!PERIOD.test(input.period)) throw badRequest('INVALID_PERIOD', 'Période AAAA-MM attendue.');
    if (input.period > this.period()) throw badRequest('FUTURE_PERIOD', 'Une déclaration porte sur une période échue ou en cours.');
    let commune: string | null = null;
    if (def.objectType) {
      if (!input.objectId) throw badRequest('OBJECT_REQUIRED', `Cette déclaration porte sur un objet (${def.objectType}).`);
      const o = this.ctx.objects.get(input.objectId);
      if (o.taxpayerId !== taxpayerId) throw forbidden('OBJECT_NOT_OWNED', 'L’objet n’est pas rattaché à ce contribuable.');
      if (o.attributes.objectType !== def.objectType) throw unprocessable('OBJECT_WRONG_TYPE', `L’objet ${o.id} n’est pas de type ${def.objectType}.`);
      commune = o.commune;
    }
    const lines = this.checkLines(def.keys, input.lines);
    const dup = this.declarations.findOne((d) => d.kind === input.kind && d.taxpayerId === taxpayerId && d.period === input.period && (d.objectId ?? '') === (input.objectId ?? ''));
    if (dup) throw conflict('DECLARATION_EXISTS', `Déclaration déjà déposée pour ${input.period} (${dup.id}) : toute correction passe par les observations contradictoires.`, { declarationId: dup.id });
    const at = this.now().toISOString();
    const d = this.declarations.insert({
      id: this.ids.next(`DSE-${input.period.replace('-', '')}`), module: def.module, kind: input.kind, taxpayerId, ...(def.objectType ? { objectId: input.objectId } : {}), commune,
      entity: SECTOR_ENTITY, period: input.period, lines, documents: input.documents, status: 'DEPOSEE', contradictory: [],
      liquidation: { status: 'ACTE_REQUIS', note: NO_LEVY_NOTE }, declaredBy: user.id, declaredAt: at,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.declared', resourceType: 'sector_declaration', resourceId: d.id, details: { module: d.module, kind: d.kind, period: d.period, lines } });
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    if (tp) this.ctx.comms.publish('declaration.submitted', [taxpayerRecipient(tp)], { reference: d.id }, { entity: SECTOR_ENTITY });
    return d;
  }

  getDeclaration(id: string): SectorDeclaration {
    const d = this.declarations.get(id);
    if (!d) throw notFound('SECTOR_DECLARATION_NOT_FOUND', `Déclaration inconnue : ${id}`);
    return d;
  }

  private declResource(d: SectorDeclaration) {
    return { taxpayerId: d.taxpayerId, entity: d.entity, communes: d.commune ? [d.commune] : [] };
  }

  readDeclaration(user: User, id: string) {
    const d = this.getDeclaration(id);
    authorize(user, P.sectorDeclRead, this.declResource(d));
    return d;
  }

  listDeclarations(user: User, filter: { module?: string; status?: string }) {
    return this.declarations
      .find((d) => (!filter.module || d.module === filter.module) && (!filter.status || d.status === filter.status))
      .filter((d) => !!evaluate(user, P.sectorDeclRead, this.declResource(d)))
      .sort((a, b) => b.declaredAt.localeCompare(a.declaredAt));
  }

  /** Observations contradictoires du déclarant (pièces par empreinte). */
  contest(user: User, id: string, input: { text: string; documents: string[] }) {
    const d = this.getDeclaration(id);
    authorize(user, P.sectorDeclare, { taxpayerId: d.taxpayerId });
    if (d.status === 'VALIDEE') throw conflict('DECLARATION_CLOSED', 'Déclaration validée : la contestation passe par la voie de recours.');
    const saved = this.declarations.update({ ...d, contradictory: [...d.contradictory, { by: user.id, at: this.now().toISOString(), text: input.text, documents: input.documents }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.contradictory_observation', resourceType: 'sector_declaration', resourceId: id, details: { documents: input.documents.length } });
    return saved;
  }

  // ------------------------------------------------------------------ données observées (terrain) et tierces (protocole)

  private assertSource(m: SectorModuleDef, source: ObservationSource) {
    if (!m.observationSources.includes(source)) throw badRequest('SOURCE_NOT_APPLICABLE', `Source ${source} non prévue pour le module ${m.module} (${m.name}).`);
  }

  /** Vérifie un titre lié à la plaque pour le module (sans constat : le contrôle de titre passe par le moteur de titres). */
  private titleCheck(m: SectorModuleDef, plate?: string): SectorObservation['titleCheck'] {
    if (!plate || !m.credentialTypes.length) return { status: 'SANS_OBJET', detail: 'Aucun titre lié à la plaque pour ce relevé.' };
    const types = this.credentialTypes(m);
    if (!types.some((t) => t.activable)) return { status: 'ACTE_REQUIS', detail: `Titres ${types.map((t) => t.code).join(', ')} : acte requis — relevé enregistré, aucun constat ni montant.` };
    const t = this.titres()!;
    const valid = t.byPlate(plate, m.module).filter((c) => VALID_STATUSES.includes(statusAt(c, this.now()).status));
    return valid.length
      ? { status: 'TITRE_VALIDE', detail: `Titre valide : ${valid[0]!.number}.` }
      : { status: 'AUCUN_TITRE_VALIDE', detail: 'Aucun titre valide lié à la plaque : contrôle à faire par le moteur de titres (constat sans montant).' };
  }

  observe(user: User, module: string, input: {
    source: ObservationSource; referenceId?: string; objectId?: string; plate?: string; period?: string; lines: Record<string, string>;
    gps?: { lat: number; lon: number; accuracyM?: number }; commune?: string;
  }): SectorObservation {
    const m = this.moduleDef(module);
    this.assertSource(m, input.source);
    if (THIRD_PARTY.includes(input.source)) throw forbidden('THIRD_PARTY_SOURCE', 'Données tierces : versées par le partenaire de données sous protocole.');
    const ref = input.referenceId ? this.references.get(input.referenceId) : undefined;
    if (input.referenceId && (!ref || ref.module !== module)) throw notFound('SECTOR_REFERENCE_NOT_FOUND', `Référence inconnue pour ce module : ${input.referenceId}`);
    const obj = input.objectId ? this.ctx.objects.get(input.objectId) : undefined;
    const commune = obj?.commune ?? ref?.commune ?? input.commune;
    if (!commune || !isCommune(commune)) throw badRequest('COMMUNE_REQUIRED', 'Lieu du relevé requis : référence, objet ou commune.');
    authorize(user, P.sectorObserve, { entity: SECTOR_ENTITY, communes: [commune] });
    const period = input.period ?? this.period();
    if (!PERIOD.test(period)) throw badRequest('INVALID_PERIOD', 'Période AAAA-MM attendue.');
    const lines = this.checkLines(OBSERVATION_KEYS[input.source] ?? {}, input.lines);
    const plate = input.plate ? normalizePlate(input.plate) : undefined;
    const o = this.observations.append({
      id: this.ids.next('OBS-SEC'), module, source: input.source, ...(ref ? { referenceId: ref.id } : {}), ...(obj ? { objectId: obj.id, ...(obj.taxpayerId ? { taxpayerId: obj.taxpayerId } : {}) } : {}),
      ...(plate ? { plate } : {}), commune, period, lines, ...(input.gps ? { gps: input.gps } : {}), titleCheck: this.titleCheck(m, plate), by: user.id, at: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.observed', resourceType: 'sector_observation', resourceId: o.id, details: { module, source: o.source, commune, period, lines, plate: plate ?? null, titleCheck: o.titleCheck?.status ?? null } });
    return o;
  }

  thirdPartyData(user: User, input: { module: string; source: ObservationSource; taxpayerId: string; period: string; lines: Record<string, string>; fileSha256?: string }): SectorObservation {
    const m = this.moduleDef(input.module);
    authorize(user, P.sectorThirdParty);
    this.assertSource(m, input.source);
    if (!THIRD_PARTY.includes(input.source)) throw badRequest('NOT_THIRD_PARTY_SOURCE', 'Source relevée sur le terrain : versement réservé aux agents.');
    this.ctx.taxpayers.get(input.taxpayerId);
    if (!PERIOD.test(input.period)) throw badRequest('INVALID_PERIOD', 'Période AAAA-MM attendue.');
    const kind = m.declarations[0]!;
    const lines = this.checkLines(kindDef(kind).keys, input.lines);
    const o = this.observations.append({
      id: this.ids.next('OBS-TRS'), module: m.module, source: input.source, taxpayerId: input.taxpayerId, commune: 'NON_ATTRIBUE', period: input.period, lines,
      ...(input.fileSha256 ? { fileSha256: input.fileSha256 } : {}), by: user.id, at: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.third_party_data', resourceType: 'sector_observation', resourceId: o.id, details: { module: m.module, source: o.source, period: o.period, file: input.fileSha256 ?? null } });
    return o;
  }

  // ------------------------------------------------------------------ rapprochement (contrôleur) puis décision (autre personne)

  reconcile(user: User, id: string) {
    const d = this.getDeclaration(id);
    authorize(user, P.sectorReconcile, this.declResource(d));
    if (d.status === 'VALIDEE') throw conflict('DECLARATION_CLOSED', 'Déclaration déjà validée.');
    const def = kindDef(d.kind);
    const mine = (o: SectorObservation) => o.module === d.module && o.period === d.period && (d.objectId ? o.objectId === d.objectId : o.taxpayerId === d.taxpayerId);
    const obs = this.observations.find(mine);
    const bySource = def.sources.map((source) => {
      const records = obs.filter((o) => o.source === source);
      const observed: Record<string, string> = {};
      const gaps: Record<string, string> = {};
      if (records.length) {
        for (const k of Object.keys(def.keys)) {
          const sum = records.reduce((acc, o) => acc + (o.lines[k] ? dec(o.lines[k]!) : 0n), 0n);
          if (!records.some((o) => o.lines[k] !== undefined)) continue;
          observed[k] = decToString(sum);
          gaps[k] = decToString(sum - dec(d.lines[k] ?? '0'));
        }
      }
      return { source, observed, gaps, records: records.length };
    });
    const any = bySource.some((s) => s.records > 0);
    // Tout écart défavorable (observé supérieur au déclaré) est instruit : aucun seuil de tolérance n'est inventé.
    const unfavourable = bySource.some((s) => Object.values(s.gaps).some((g) => dec(g) > 0n));
    const status: DeclarationStatus = !any ? 'SANS_DONNEE_TIERCE' : unfavourable ? 'ECART_A_INSTRUIRE' : 'RAPPROCHEE';
    const proposal = unfavourable ? 'OUVRIR_CONTRADICTOIRE' as const : 'VALIDER' as const;
    const note = !any ? 'Aucune donnée observée ni tierce pour cette période : rapprochement à reprendre.' : unfavourable
      ? 'Écart défavorable : proposition d’ouvrir la procédure contradictoire avec le redevable (aucune taxation automatique).'
      : 'Aucun écart défavorable constaté.';
    const saved = this.declarations.update({ ...d, status, reconciliation: { by: user.id, at: this.now().toISOString(), bySource, proposal, note } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.reconciled', resourceType: 'sector_declaration', resourceId: id, details: { status, proposal, sources: bySource.map((s) => `${s.source}:${s.records}`) } });
    return saved;
  }

  decide(user: User, id: string, input: { decision: 'VALIDER' | 'OUVRIR_CONTRADICTOIRE'; motif: string }) {
    const d = this.getDeclaration(id);
    authorize(user, P.sectorDecide, this.declResource(d));
    if (!d.reconciliation) throw conflict('NOT_RECONCILED', 'Décision impossible sans rapprochement préalable.');
    if (d.status === 'VALIDEE') throw conflict('DECLARATION_CLOSED', 'Déclaration déjà validée.');
    try {
      assertDistinctPerson(user.id, [d.reconciliation.by], 'La personne qui décide doit être distincte de celle qui a rapproché.');
    } catch (e) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.decision.refused', resourceType: 'sector_declaration', resourceId: id, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    const status: DeclarationStatus = input.decision === 'VALIDER' ? 'VALIDEE' : 'EN_CONTRADICTOIRE';
    const saved = this.declarations.update({ ...d, status, decision: { by: user.id, at: this.now().toISOString(), decision: input.decision, motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.sector.decided', resourceType: 'sector_declaration', resourceId: id, details: { decision: input.decision, motif: input.motif, liquidation: 'ACTE_REQUIS' } });
    const tp = this.ctx.taxpayers.taxpayers.get(d.taxpayerId);
    if (tp) this.ctx.comms.publish(input.decision === 'VALIDER' ? 'approval.approved' : 'approval.returned', [taxpayerRecipient(tp)], { reference: id }, { entity: d.entity });
    return saved;
  }

  // ------------------------------------------------------------------ grands redevables (module 56)

  designateLargeTaxpayer(user: User, input: { taxpayerId: string; sectors: string[]; motif: string }) {
    authorize(user, P.sectorLargeTaxpayer, { entity: SECTOR_ENTITY });
    this.ctx.taxpayers.get(input.taxpayerId);
    for (const s of input.sectors) this.moduleDef(s);
    const at = this.now().toISOString();
    const existing = this.largeTaxpayers.get(input.taxpayerId);
    if (existing?.status === 'SUIVI') throw conflict('ALREADY_DESIGNATED', 'Redevable déjà suivi par la cellule des grands redevables.');
    const entry: LargeTaxpayer = {
      id: input.taxpayerId, taxpayerId: input.taxpayerId, sectors: input.sectors, status: 'SUIVI',
      history: [...(existing?.history ?? []), { by: user.id, at, action: 'DESIGNATION', motif: input.motif }],
    };
    const saved = existing ? this.largeTaxpayers.update(entry) : this.largeTaxpayers.insert(entry);
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.large_taxpayer.designated', resourceType: 'taxpayer', resourceId: input.taxpayerId, details: { sectors: input.sectors, motif: input.motif } });
    return saved;
  }

  liftLargeTaxpayer(user: User, taxpayerId: string, motif: string) {
    authorize(user, P.sectorLargeTaxpayer, { entity: SECTOR_ENTITY });
    const e = this.largeTaxpayers.get(taxpayerId);
    if (!e || e.status !== 'SUIVI') throw notFound('LARGE_TAXPAYER_NOT_FOUND', 'Redevable non suivi.');
    const saved = this.largeTaxpayers.update({ ...e, status: 'LEVE', history: [...e.history, { by: user.id, at: this.now().toISOString(), action: 'LEVEE', motif }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.large_taxpayer.lifted', resourceType: 'taxpayer', resourceId: taxpayerId, details: { motif } });
    return saved;
  }

  listLargeTaxpayers(user: User) {
    authorize(user, P.sectorRead, { entity: SECTOR_ENTITY });
    return this.largeTaxpayers.all().map((e) => {
      const decls = this.declarations.find((d) => d.taxpayerId === e.taxpayerId);
      return {
        ...e, name: this.ctx.taxpayers.taxpayers.get(e.taxpayerId)?.fullName ?? e.taxpayerId,
        declarations: decls.length, openGaps: decls.filter((d) => d.status === 'ECART_A_INSTRUIRE' || d.status === 'EN_CONTRADICTOIRE').length,
        lastPeriod: decls.map((d) => d.period).sort().pop() ?? null,
      };
    });
  }

  // ------------------------------------------------------------------ antennes : liquidation annuelle proposée (module 16)

  antennesAnnual(user: User, exercice: string) {
    authorize(user, P.telecomReconcile, { entity: SECTOR_ENTITY });
    if (!/^\d{4}$/.test(exercice)) throw badRequest('INVALID_YEAR', 'Exercice AAAA attendu.');
    const sites = this.ctx.objects.objects.find((o) => o.attributes.objectType === 'SITE_TELECOM');
    const operators = new Map<string, typeof sites>();
    for (const s of sites) operators.set(s.taxpayerId ?? 'NON_IDENTIFIE', [...(operators.get(s.taxpayerId ?? 'NON_IDENTIFIE') ?? []), s]);
    const telecom = this.vx.vertical('telecom');
    return {
      exercice, vertical: telecom.name, rule: { status: 'ACTE_REQUIS', note: 'Aucune règle ACTIVE au registre pour la taxe sur les antennes : aucun montant.' },
      operators: [...operators.entries()].map(([taxpayerId, list]) => ({
        taxpayerId, name: taxpayerId === 'NON_IDENTIFIE' ? 'Opérateur non identifié' : this.ctx.taxpayers.taxpayers.get(taxpayerId)?.fullName ?? taxpayerId,
        sites: list.length, declared: list.filter((s) => s.probativeStatus === 'DECLARE').length, observed: list.filter((s) => s.probativeStatus === 'OBSERVE').length,
        verified: list.filter((s) => s.probativeStatus === 'VERIFIE').length,
        proposal: taxpayerId === 'NON_IDENTIFIE' ? 'Identifier l’opérateur (vérification contradictoire)' : 'Liquidation annuelle à exécuter par une personne habilitée dès qu’une règle ACTIVE existe',
      })),
      notice: 'Proposition seulement : la liquidation annuelle n’est jamais automatique ; chaque site reste contestable.',
    };
  }

  // ------------------------------------------------------------------ contrôle d'un véhicule par plaque (module 11, 12, 25)

  vehicleControl(user: User, plateRaw: string, place: { commune: string; lat?: number; lon?: number }) {
    if (!isCommune(place.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${place.commune}`);
    authorize(user, P.vehicleControl, { communes: [place.commune] });
    const plate = normalizePlate(plateRaw);
    if (plate.length < 4) throw badRequest('INVALID_PLATE', 'Plaque illisible.');
    const plateOf = (a: Record<string, unknown>) => normalizePlate(String(a.plaque ?? a.immatriculation ?? a.plate ?? ''));
    const vehicles = this.ctx.objects.objects.find((o) => o.category === 'VEHICULE' && plateOf(o.attributes) === plate);
    const t = this.titres();
    const titles = t ? ['11', '12', '25'].flatMap((mod) => t.byPlate(plate, mod).map((c) => {
      const st = statusAt(c, this.now());
      return { module: mod, typeCode: c.typeCode, label: t.types.findOne((x) => x.code === c.typeCode)?.label ?? c.typeCode, valid: VALID_STATUSES.includes(st.status), status: st.status, text: st.text, validUntil: c.validUntil };
    })) : [];
    const ids = new Set(vehicles.map((v) => v.id));
    const auth = this.vx.certificates.find((c) => c.kind === 'AUTORISATION_TRANSPORT' && !!c.objectId && ids.has(c.objectId)).map((c) => ({ code: c.code, status: this.vx.certificateStatus(c), validUntil: c.validUntil ?? null }));
    const mutation = this.vx.cases.find((c) => c.type === 'DECLARATION_MUTATION' && !!c.objectId && ids.has(c.objectId) && !['ACCEPTE', 'REFUSE'].includes(c.status)).length > 0;
    const types = [...this.credentialTypes(this.moduleDef('11')), ...this.credentialTypes(this.moduleDef('25'))];
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.vehicle.controlled', resourceType: 'vehicle_plate', resourceId: plate, details: { commune: place.commune, registered: vehicles.length > 0, titles: titles.length } });
    return {
      plate, registered: vehicles.length > 0,
      vehicle: vehicles[0] ? { category: vehicles[0].category, usage: String(vehicles[0].attributes.usage_vehicule ?? vehicles[0].attributes.usage ?? '') || null, commune: vehicles[0].commune, probativeStatus: vehicles[0].probativeStatus } : null,
      titles, transportAuthorizations: auth, mutationPending: mutation,
      credentialTypes: types.map((x) => ({ code: x.code, label: x.label, activable: x.activable, reason: x.reason })),
      serverTime: this.now().toISOString(),
      notice: 'Réponse minimale (ni nom ni adresse). Vignette, taxe de circulation et péage : acte requis — aucun constat de défaut de titre ni montant tant que les types ne sont pas activables.',
    };
  }

  // ------------------------------------------------------------------ domaine public : plan des emprises (modules 19, 20)

  domainPlan(user: User) {
    const access = authorize(user, P.domainPlan, { entity: SECTOR_ENTITY });
    const types = ['EMPRISE', 'EMPRISE_TEMPORAIRE', 'EMPRISE_PERMANENTE'];
    return this.ctx.objects.objects.find((o) => types.includes(String(o.attributes.objectType ?? ''))).map((o) => {
      const cert = this.vx.certificates.find((c) => c.objectId === o.id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
      const ceased = this.vx.cessations.findOne((c) => c.objectId === o.id);
      return {
        objectId: o.id, objectType: o.attributes.objectType, commune: o.commune, quartier: o.quartier, lat: o.lat, lon: o.lon,
        usage: access === 'full' ? String(o.attributes.usage ?? '') || null : null, surfaceM2: String(o.attributes.surface_m2 ?? '') || null,
        probativeStatus: o.probativeStatus, authorization: cert ? { code: cert.code, status: this.vx.certificateStatus(cert), validUntil: cert.validUntil ?? null } : null,
        freed: ceased ? ceased.dateEffet : null, positionIndicative: o.attributes.positionIndicative === true,
      };
    });
  }

  // ------------------------------------------------------------------ références (données de démonstration)

  seedReference(r: Omit<SectorReference, 'demo'>) {
    if (!this.references.get(r.id)) this.references.insert({ ...r, demo: true });
  }
}
