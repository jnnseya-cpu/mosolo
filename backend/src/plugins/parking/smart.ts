/**
 * ParkSmart — compléments du chapitre 11A (Cahier v2.9), construits PAR-DESSUS la verticale existante (zones, sessions,
 * contrôle, constats RW1, réservations de voirie, partenaires, terrain) et sur le socle commun :
 *
 * - § 11A.2 Tarification : chaque mode tarifaire (horaire/journalier/zone, demande différenciée, événement, pré-réservation
 *   premium, résidentiel digital, entreprises, courte durée, longue durée majorée) est une GRILLE = règle du registre
 *   juridique (§ 6.2). Aucun tarif n'est écrit dans le code : statut ACTIVE (règle publiée), A_VERIFIER (règle au registre,
 *   non publiée) ou ACTE_REQUIS (aucune règle). Abonnements et permis = TITRES du moteur § 19A liés à la plaque.
 * - Cible d'occupation 15–25 % de places libres : indicateur par zone et par heure (sessions, réservations, flux capteur),
 *   alerte hors cible et RECOMMANDATION tarifaire, jamais appliquée : un changement de tarif est une nouvelle version de
 *   règle approuvée par le circuit à quatre visas. Décision du maître d'ouvrage (27/09/2026), ajoutée par-dessus :
 *   lorsque l'acte (règle ACTIVE) fixe des fourchettes par zone et par heure, le tarif est ajusté AUTOMATIQUEMENT à
 *   l'intérieur de ces fourchettes (`tarification-dynamique.ts`) ; hors fourchette ou sans acte, la recommandation
 *   ci-dessous reste la seule voie.
 * - § 11A.3 Sources de recettes (catalogue), zones premium, données urbaines agrégées et anonymisées (seuil k, sans plaque).
 * - § 11A.4 / 11A.6 Plaque identifiant central : historique, profil de récidive, score de conformité EXPLICABLE, servant
 *   uniquement à prioriser les patrouilles et les propositions ; blocage et fourrière relèvent de l'autorité compétente
 *   (circuit de recouvrement : proposition R20, décision R21, procédure légale), jamais de l'algorithme.
 * - § 11A.5 Surréservation 10–15 % calculée sur l'historique réel, DÉSACTIVÉE tant qu'aucune validation juridique
 *   (protection du consommateur) n'est enregistrée ; garantie de place ou compensation automatique. Registre des
 *   reconfigurations (épi, baies, livraison, rotation, longue durée en périphérie).
 * - § 11A.7 Affectation : engagement de programmation publié (universalité budgétaire, LOFIP) — aucune affectation
 *   automatique. § 11A.8 Phases de déploiement conditionnées par l'acte réglementaire.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { Principal, User } from '../../core/auth.js';
import { DAY_MS, HOUR_MS, kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { pct } from '../../core/percent.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import { MIN_CONTRIBUTORS } from '../pilotage/transparency.js';
import type { CredentialType } from '../titres/model.js';
import type { TitresService } from '../titres/service.js';
import { statusAt, controlResultOf } from '../titres/validity.js';
import { actorOf, activeRule, DGTK, latestRule, paymentState, sumByCurrency } from './support.js';
import type { ParkingService, ParkingZone } from './service.js';

// ------------------------------------------------------------------------------------------------ Paramètres

/** Cible du dossier source (§ 11A.2) : 15 à 25 % de places libres. Objectif de pilotage, jamais une sanction. */
export const FREE_TARGET = { minPct: 15, maxPct: 25 } as const;
/** Bornes de la surréservation du dossier source (§ 11A.5) : 10 à 15 %. */
export const OVERBOOKING_BOUNDS = { minPct: 10, maxPct: 15 } as const;
/** Historique minimal (réservations échues) pour calculer un taux d'annulation — par défaut, à confirmer par le maître d'ouvrage. */
export const OVERBOOKING_MIN_SAMPLE = 30;
/** Fenêtre d'observation de la récidive (jours) — par défaut, à confirmer par le maître d'ouvrage. */
export const RECIDIVISM_WINDOW_DAYS = 365;
/** Seuil k des données urbaines : même seuil que la transparence publique (contribuables / plaques distincts par cellule). */
export const URBAN_K_THRESHOLD = MIN_CONTRIBUTORS;
/** Module du moteur de titres pour les titres de stationnement (chapitre 11A). */
export const PARKSMART_TITLE_MODULE = '11A';
/** Lieu d'un titre valable dans toutes les zones payantes ouvertes. */
export const ALL_ZONES = 'PARKSMART-TOUTES-ZONES';

export const TARIFF_MODES = [
  { mode: 'HORAIRE_ZONE', label: 'Horaire, journalière, par zone', usage: 'Base tarifaire', title: false },
  { mode: 'JOURNALIER', label: 'Forfait journalier', usage: 'Base tarifaire (journée)', title: false },
  { mode: 'DEMANDE_DIFFERENCIEE', label: 'Différenciée selon la demande', usage: 'Zones et heures de forte demande', title: false },
  { mode: 'EVENEMENT', label: 'Événements', usage: 'Tarif spécial ponctuel', title: true },
  { mode: 'PRE_RESERVATION_PREMIUM', label: 'Pré-réservation premium', usage: 'Place garantie avec prime', title: true },
  { mode: 'RESIDENTIEL', label: 'Résidentielle digitale', usage: 'Abonnement virtuel lié à la plaque', title: true },
  { mode: 'ENTREPRISES', label: 'Entreprises et zones commerciales', usage: 'Abonnements professionnels', title: true },
  { mode: 'COURTE_DUREE', label: 'Courte durée', usage: 'Rotation rapide devant les commerces', title: false },
  { mode: 'LONGUE_DUREE_MAJOREE', label: 'Longue durée majorée', usage: 'Dissuader l’occupation prolongée', title: false },
] as const;
export type TariffMode = (typeof TARIFF_MODES)[number]['mode'];
// Conversion justifiée : z.enum exige un tuple non vide ; la liste est dérivée d'une constante `as const` non vide.
export const TARIFF_MODE_CODES = TARIFF_MODES.map((m) => m.mode) as unknown as readonly [TariffMode, ...TariffMode[]];

export const PREMIUM_CATEGORIES = ['HAUTE_DEMANDE', 'COMMERCIALE', 'ADMINISTRATIVE', 'GOUVERNEMENTALE'] as const;
export const RECONFIG_KINDS = ['STATIONNEMENT_EN_EPI', 'NOUVELLES_BAIES', 'ZONE_LIVRAISON', 'ZONE_ROTATION_RAPIDE', 'LONGUE_DUREE_PERIPHERIE'] as const;
export const RECONFIG_STATUSES = ['ETUDE', 'PROGRAMMEE', 'REALISEE', 'ABANDONNEE'] as const;
export const AFFECTATION_DOMAINS = ['ENTRETIEN_ROUTIER', 'SIGNALISATION', 'MODERNISATION_VOIRIE', 'SECURITE_URBAINE', 'MOBILITE', 'PROJETS_ENVIRONNEMENTAUX'] as const;
export const ENFORCEMENT_MEASURES = ['BLOCAGE_ADMINISTRATIF', 'FOURRIERE'] as const;
export const GUARANTEES = ['GARANTIE_PLACE', 'COMPENSATION_AUTOMATIQUE'] as const;

/** Types de titres ParkSmart du moteur § 19A (réels : acte requis ; démonstration : règles fictives publiées). */
export const PARKSMART_TITLE_TYPES = {
  RESIDENTIEL: { real: 'PKS-RESIDENTIEL', demo: 'DEMO-PKS-RESIDENTIEL' },
  ENTREPRISES: { real: 'PKS-PROFESSIONNEL', demo: 'DEMO-PKS-PROFESSIONNEL' },
  PRE_RESERVATION_PREMIUM: { real: 'PKS-PREMIUM', demo: 'DEMO-PKS-PREMIUM' },
  EVENEMENT: { real: 'PKS-EVENEMENT', demo: 'DEMO-PKS-EVENEMENT' },
} as const;

// ------------------------------------------------------------------------------------------------ Modèle

export type GridStatus = 'ACTIVE' | 'A_VERIFIER' | 'ACTE_REQUIS';

export interface TariffGrid {
  id: string;
  mode: TariffMode;
  ruleCode: string;
  scope: 'REEL' | 'DEMO';
  /** Zones couvertes (vide : toutes les zones ouvertes). */
  zoneIds: string[];
  /** Type de titre du moteur § 19A porté par cette grille (abonnements, pré-réservation, événement). */
  titleTypeCode: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface SensorReading {
  id: string;
  zoneId: string;
  sensorId: string;
  occupied: number;
  at: string;
  receivedAt: string;
  by: string;
}

export interface PricingRecommendation {
  id: string;
  zoneId: string;
  date: string;
  observedHours: number;
  hoursSaturated: number;
  hoursUnderused: number;
  direction: 'HAUSSE_A_ETUDIER' | 'BAISSE_A_ETUDIER';
  basis: string;
  tariffRuleCode: string | null;
  tariffRuleVersion: number | null;
  status: 'PROPOSEE' | 'RETENUE_POUR_NOUVELLE_VERSION' | 'ECARTEE';
  /** Toujours faux : une recommandation ne modifie jamais un tarif. */
  applied: false;
  createdAt: string;
  decision?: { by: string; at: string; reason: string };
}

export interface PlateReferral {
  id: string;
  plate: string;
  measure: (typeof ENFORCEMENT_MEASURES)[number];
  grounds: string;
  unpaidObligationIds: string[];
  retainedViolationIds: string[];
  by: string;
  at: string;
  status: 'TRANSMISE_AU_CONTENTIEUX';
  /** Aucune mesure n'est prise par la transmission : proposition R20 puis décision R21 dans le circuit de recouvrement. */
  measureTaken: false;
}

export interface OverbookingValidation {
  id: string;
  reference: string;
  guarantee: (typeof GUARANTEES)[number];
  reason: string;
  by: string;
  at: string;
}

export interface OverbookingActivation {
  id: string;
  enabled: boolean;
  ratePct: number;
  reason: string;
  validationId: string | null;
  by: string;
  at: string;
}

export interface ReservationCompensation {
  id: string;
  reservationId: string;
  guarantee: (typeof GUARANTEES)[number];
  reason: string;
  amount: MoneyJSON | null;
  status: 'COMPENSATION_DUE' | 'RELOGEMENT_A_ORGANISER';
  by: string;
  at: string;
}

export interface Reconfiguration {
  id: string;
  zoneId: string;
  kind: (typeof RECONFIG_KINDS)[number];
  description: string;
  expectedEffect: string;
  status: (typeof RECONFIG_STATUSES)[number];
  history: { status: string; reason: string; by: string; at: string }[];
  demo: boolean;
  createdBy: string;
  createdAt: string;
}

export interface AffectationCommitment {
  id: string;
  domain: (typeof AFFECTATION_DOMAINS)[number];
  label: string;
  legalForm: 'ENGAGEMENT_DE_PROGRAMMATION' | 'ACTE_JURIDIQUE';
  actReference: string | null;
  period: string;
  programmedAmount: MoneyJSON | null;
  published: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
  demo: boolean;
  createdBy: string;
  createdAt: string;
}

export interface DeploymentPhase {
  id: string;
  number: 1 | 2 | 3;
  label: string;
  duration: string;
  perimeter: string;
  zoneIds: string[];
  status: 'PLANIFIEE' | 'ACTIVEE';
  activation?: { actReference: string; reason: string; by: string; at: string };
}

const DOMAIN_LABEL: Record<(typeof AFFECTATION_DOMAINS)[number], string> = {
  ENTRETIEN_ROUTIER: 'Entretien routier', SIGNALISATION: 'Signalisation', MODERNISATION_VOIRIE: 'Modernisation de la voirie',
  SECURITE_URBAINE: 'Sécurité urbaine', MOBILITE: 'Mobilité', PROJETS_ENVIRONNEMENTAUX: 'Projets environnementaux',
};

const MINUTE = 60_000;
const KINSHASA_OFFSET_MS = HOUR_MS;

/** Heure de Kinshasa (0–23) d'un instant. */
export function kinshasaHour(d: Date): number {
  return new Date(d.getTime() + KINSHASA_OFFSET_MS).getUTCHours();
}

/** Instant (milieu de l'heure `h`) d'une journée « AAAA-MM-JJ » de Kinshasa. */
function hourMid(date: string, h: number): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - KINSHASA_OFFSET_MS + h * HOUR_MS + 30 * MINUTE);
}

/** Position d'un taux de places libres par rapport à la cible 15–25 %. */
export function freeTargetOf(freeRate: string | null): 'SATURE' | 'SOUS_UTILISE' | 'DANS_LA_CIBLE' | 'SANS_OBJET' {
  if (freeRate === null) return 'SANS_OBJET';
  const v = Number.parseFloat(freeRate);
  return v < FREE_TARGET.minPct ? 'SATURE' : v > FREE_TARGET.maxPct ? 'SOUS_UTILISE' : 'DANS_LA_CIBLE';
}

export class ParkSmart {
  readonly grids = new InMemoryRepository<TariffGrid>();
  /** Flux capteur (maquette) : ajout seul. */
  readonly sensorReadings = new InMemoryAppendOnlyRepository<SensorReading>();
  readonly recommendations = new InMemoryRepository<PricingRecommendation>();
  readonly referrals = new InMemoryAppendOnlyRepository<PlateReferral>();
  readonly overbookingValidations = new InMemoryAppendOnlyRepository<OverbookingValidation>();
  readonly overbookingActivations = new InMemoryAppendOnlyRepository<OverbookingActivation>();
  readonly compensations = new InMemoryAppendOnlyRepository<ReservationCompensation>();
  readonly reconfigurations = new InMemoryRepository<Reconfiguration>();
  readonly commitments = new InMemoryRepository<AffectationCommitment>();
  readonly phases = new InMemoryRepository<DeploymentPhase>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly svc: ParkingService) {
    this.definePhases();
  }

  /** Moteur de titres (§ 19A), s'il est chargé : les abonnements et permis y sont émis. */
  get titres(): TitresService | null {
    return (this.ctx.ext['titres'] as TitresService | undefined) ?? null;
  }

  private now(): Date {
    return this.ctx.clock.now();
  }

  // ============================================================================ § 11A.2 Grilles tarifaires

  gridStatus(g: Pick<TariffGrid, 'ruleCode'>): { status: GridStatus; rule: RuleRecord | null } {
    const active = activeRule(this.ctx, g.ruleCode);
    if (active) return { status: 'ACTIVE', rule: active };
    const latest = latestRule(this.ctx, g.ruleCode);
    return latest ? { status: 'A_VERIFIER', rule: latest } : { status: 'ACTE_REQUIS', rule: null };
  }

  gridView(g: TariffGrid) {
    const { status, rule } = this.gridStatus(g);
    return {
      ...g,
      status,
      zones: g.zoneIds.map((id) => this.svc.zones.get(id)).filter((z): z is ParkingZone => !!z).map((z) => ({ id: z.id, code: z.code, name: z.name })),
      rule: rule ? {
        code: rule.code, version: rule.version, status: rule.status, label: rule.label, demo: rule.demo === true, currency: rule.currency,
        formula: rule.formula, rateTable: status === 'ACTIVE' ? rule.rateTable : {}, requiredInputs: this.ctx.rules.requiredInputs(rule),
      } : null,
      notice: status === 'ACTIVE'
        ? (rule?.demo ? 'Grille FICTIVE de démonstration [EXEMPLE] : aucune valeur juridique.' : 'Grille publiée au registre (quatre visas).')
        : status === 'A_VERIFIER' ? 'Règle au registre, non publiée : à vérifier puis approuver (quatre visas) avant toute activation.' : 'Acte requis : aucune règle au registre pour cette grille.',
    };
  }

  tariffModes() {
    return TARIFF_MODES.map((m) => ({
      ...m,
      grids: this.grids.find((g) => g.mode === m.mode).sort((a, b) => a.scope.localeCompare(b.scope)).map((g) => this.gridView(g)),
      titleTypes: m.title && this.titres ? this.titleTypesOf(m.mode) : [],
    }));
  }

  private titleTypesOf(mode: TariffMode) {
    const t = this.titres;
    const codes = (PARKSMART_TITLE_TYPES as Record<string, { real: string; demo: string }>)[mode];
    if (!t || !codes) return [];
    return [codes.real, codes.demo].map((c) => t.types.findOne((x) => x.code === c)).filter((x): x is CredentialType => !!x).map((x) => t.typeView(t.type(x.code)));
  }

  /** Rattache une règle du registre à un mode tarifaire (aucun montant saisi ici). */
  linkGrid(user: User, input: { mode: TariffMode; ruleCode: string; zoneIds?: string[]; scope?: 'REEL' | 'DEMO'; titleTypeCode?: string | null; note?: string }) {
    authorize(user, 'parking:zone.manage', { entity: DGTK });
    if (!TARIFF_MODES.some((m) => m.mode === input.mode)) throw badRequest('UNKNOWN_TARIFF_MODE', `Mode tarifaire inconnu : ${input.mode}`);
    if (!latestRule(this.ctx, input.ruleCode)) throw unprocessable('UNKNOWN_RULE', `Règle inconnue du registre : ${input.ruleCode}`);
    for (const z of input.zoneIds ?? []) this.svc.getZone(z);
    const g = this.grids.insert({
      id: this.ids.next('PKG', 4), mode: input.mode, ruleCode: input.ruleCode, scope: input.scope ?? 'REEL',
      zoneIds: (input.zoneIds ?? []).map((z) => this.svc.getZone(z).id), titleTypeCode: input.titleTypeCode ?? null, note: input.note ?? '',
      createdBy: user.id, createdAt: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.tariff_grid.linked', resourceType: 'parking_tariff_grid', resourceId: g.id, details: { mode: g.mode, ruleCode: g.ruleCode, status: this.gridStatus(g).status } });
    return this.gridView(g);
  }

  /**
   * Entrées d'une formule tarifaire, déduites de la situation (durée, places, heure de pointe selon la TABLE de la règle,
   * jours, mois, heures). Seules les entrées requises par la formule sont fournies (aucune entrée non autorisée).
   */
  tariffInputs(rule: RuleRecord, ctx: { minutes: number; places: number; at: Date; days?: number; months?: number; zone?: ParkingZone }): Record<string, string> {
    const required = new Set(this.ctx.rules.requiredInputs(rule));
    // Module 75 : tarif dynamique en vigueur à l'heure (fourchettes de l'acte), fixé automatiquement — jamais saisi.
    const dynamic: Record<string, string> = required.has('tarif_dynamique') && ctx.zone ? { tarif_dynamique: this.svc.tarification.currentRate(ctx.zone, rule, ctx.at) } : {};
    const hh = String(kinshasaHour(ctx.at)).padStart(2, '0');
    const known: Record<string, string> = {
      duree_minutes: String(ctx.minutes),
      places: String(ctx.places),
      heures: String(Math.ceil(ctx.minutes / 60)),
      jours: String(ctx.days ?? Math.max(1, Math.ceil(ctx.minutes / (24 * 60)))),
      mois: String(ctx.months ?? 1),
      pointe: rule.rateTable[`heure_pointe_${hh}`] === '1' ? '1' : '0',
      ...dynamic,
    };
    return Object.fromEntries([...required].filter((k) => k in known).map((k) => [k, known[k]!]));
  }

  /** Simulation (jamais une liquidation) d'un mode tarifaire sur une zone, à partir de la grille ACTIVE applicable. */
  simulate(user: User, input: { mode: TariffMode; zoneId: string; durationMinutes: number; places?: number; at?: string; days?: number; months?: number }) {
    authorize(user, 'parking:zone.read');
    const z = this.svc.getZone(input.zoneId);
    const grids = this.grids.find((g) => g.mode === input.mode && (g.zoneIds.length === 0 || g.zoneIds.includes(z.id)));
    const usable = grids.map((g) => ({ g, ...this.gridStatus(g) })).find((x) => x.status === 'ACTIVE');
    if (!usable) {
      const st = grids.map((g) => this.gridStatus(g).status);
      return { mode: input.mode, zoneId: z.id, executable: false, status: st.includes('A_VERIFIER') ? 'A_VERIFIER' : 'ACTE_REQUIS', amount: null, reason: 'Aucune grille ACTIVE applicable à cette zone pour ce mode : aucun tarif ne peut être calculé.' };
    }
    const at = input.at ? new Date(input.at) : this.now();
    if (Number.isNaN(at.getTime())) throw badRequest('INVALID_DATE', 'Date invalide.');
    const rule = usable.rule!;
    const inputs = this.tariffInputs(rule, { minutes: input.durationMinutes, places: input.places ?? 1, at, zone: z, ...(input.days ? { days: input.days } : {}), ...(input.months ? { months: input.months } : {}) });
    const ev = this.ctx.rules.evaluate(rule, inputs, z.localityRank);
    return {
      mode: input.mode, zoneId: z.id, executable: true, status: 'ACTIVE' as const, gridId: usable.g.id,
      amount: Money.of(ev.value, rule.currency, rule.rounding).toJSON(), ruleCode: rule.code, ruleVersion: rule.version, demo: rule.demo === true,
      inputs: ev.inputs, rates: ev.rates, peakHour: inputs['pointe'] === '1', localityRank: z.localityRank,
      notice: rule.demo ? 'Simulation sur une grille FICTIVE [EXEMPLE] : montant non opposable.' : 'Simulation : la liquidation réelle se fait à l’achat, sur la règle ACTIVE.',
    };
  }

  // ============================================================================ Titres du moteur § 19A (abonnements, permis)

  /** Définit les types de titres ParkSmart dans le moteur de titres (si chargé). Réels : acte requis. */
  defineTitleTypes(): void {
    const t = this.titres;
    if (!t) return;
    const base = { module: PARKSMART_TITLE_MODULE, moduleLabel: 'MOSOLO Parking (ParkSmart, § 11A)', prefix: 'STA', entity: DGTK, transferable: false, plateBound: true };
    const month = { model: 'ABONNEMENT' as const, periodDays: 30, amberMinutes: 3 * 1440, toleranceMinutes: 0, startMode: 'PAIEMENT' as const, extendable: true, refundable: false };
    const defs: { key: keyof typeof PARKSMART_TITLE_TYPES; label: string; validity: CredentialType['validity']; supports: CredentialType['supports']; rule: { real: string; demo: string }; inputs: Record<string, string> }[] = [
      { key: 'RESIDENTIEL', label: 'Abonnement résidentiel digital (lié à la plaque, sans papier)', validity: month, supports: ['PLAQUE', 'QR_DYNAMIQUE', 'SMS', 'USSD'], rule: { real: 'PKS-RESIDENTIEL', demo: 'DEMO-PARK-RESIDENTIEL' }, inputs: { mois: '1' } },
      { key: 'ENTREPRISES', label: 'Abonnement professionnel — entreprises et zones commerciales', validity: { ...month, model: 'HEBDOMADAIRE_MENSUEL' }, supports: ['PLAQUE', 'QR_DYNAMIQUE', 'SMS'], rule: { real: 'PKS-PROFESSIONNEL', demo: 'DEMO-PARK-PROFESSIONNEL' }, inputs: { mois: '1' } },
      { key: 'PRE_RESERVATION_PREMIUM', label: 'Pré-réservation premium (place garantie avec prime)', validity: { model: 'DUREE_COURTE', durationMinutes: 60, maxDurationMinutes: 60, amberMinutes: 10, toleranceMinutes: 0, startMode: 'HEURE_CHOISIE', extendable: false, refundable: false }, supports: ['PLAQUE', 'QR_DYNAMIQUE', 'SMS'], rule: { real: 'PKS-PREMIUM', demo: 'DEMO-PARK-PREMIUM' }, inputs: { heures: '1' } },
      { key: 'EVENEMENT', label: 'Titre événement (tarif spécial ponctuel)', validity: { model: 'PAR_EVENEMENT', amberMinutes: 60, toleranceMinutes: 0, startMode: 'HEURE_CHOISIE', extendable: false, refundable: false }, supports: ['PLAQUE', 'QR_DYNAMIQUE', 'SMS'], rule: { real: 'PKS-EVENEMENT', demo: 'DEMO-PARK-EVENEMENT' }, inputs: { jours: '1' } },
    ];
    for (const d of defs) {
      const codes = PARKSMART_TITLE_TYPES[d.key];
      if (!t.types.findOne((x) => x.code === codes.real)) {
        t.defineType({ ...base, code: codes.real, label: d.label, validity: d.validity, supports: d.supports, pricing: { ruleCode: d.rule.real, inputs: d.inputs }, legalAct: { ref: 'Acte réglementaire ParkSmart (à prendre)', status: 'ACTE_REQUIS', note: 'Zonage, redevables et tarifs à fixer par l’acte réglementaire (§ 11A.1).' }, demo: false }, 'parking');
      }
      // Types « DÉMONSTRATION » (règles fictives) : seulement si des données de démonstration sont semées — jamais en production.
      if (this.ctx.demoData !== false && !t.types.findOne((x) => x.code === codes.demo)) {
        t.defineType({ ...base, code: codes.demo, label: `DÉMONSTRATION — ${d.label}`, validity: d.validity, supports: d.supports, pricing: { ruleCode: d.rule.demo, inputs: d.inputs }, legalAct: { ref: 'Acte FICTIF de démonstration', status: 'DEMONSTRATION', note: 'Règle FICTIVE [EXEMPLE] : aucun titre réel avant l’acte.' }, demo: true }, 'parking');
      }
    }
  }

  /** Titre du moteur § 19A valable pour la plaque dans la zone (abonnement, pré-réservation, événement). */
  titleCredentialFor(plate: string, zoneId: string | null, now: Date): { light: 'VERT' | 'AMBRE'; number: string; validFrom: string; validUntil: string; zoneId: string | null } | null {
    const t = this.titres;
    if (!t) return null;
    t.sync();
    for (const c of t.byPlate(plate, PARKSMART_TITLE_MODULE, now)) {
      if (zoneId && c.place.sourceId !== zoneId && c.place.sourceId !== ALL_ZONES) continue;
      const s = statusAt(c, now);
      if (controlResultOf(s.status) !== 'VALIDE' || s.status === 'PAS_ENCORE_ACTIF') continue;
      return { light: s.status === 'VALIDE' ? 'VERT' : 'AMBRE', number: c.number, validFrom: c.validFrom, validUntil: c.validUntil, zoneId: c.place.sourceId === ALL_ZONES ? zoneId : c.place.sourceId };
    }
    return null;
  }

  // ============================================================================ Occupation (cible 15–25 %) et capteurs

  /** Relevé de capteur d'occupation (maquette du flux ; en production, connecteur signé). */
  recordSensor(user: User, zoneId: string, input: { sensorId: string; occupied: number; at?: string }) {
    const z = this.svc.getZone(zoneId);
    authorize(user, 'parking:zone.manage', { entity: z.entity });
    const at = input.at ? new Date(input.at) : this.now();
    if (Number.isNaN(at.getTime()) || at > this.now()) throw badRequest('INVALID_DATE', 'Horodatage du relevé invalide ou futur.');
    const total = z.capacity.standard + z.capacity.livraison + z.capacity.pmr;
    if (input.occupied < 0 || input.occupied > total) throw badRequest('INVALID_OCCUPANCY', `Places occupées : 0 à ${total}.`);
    const r = this.sensorReadings.append({ id: this.ids.next('PKCAP'), zoneId: z.id, sensorId: input.sensorId, occupied: input.occupied, at: at.toISOString(), receivedAt: this.now().toISOString(), by: user.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.sensor.reading', resourceType: 'parking_zone', resourceId: z.id, details: { sensorId: r.sensorId, occupied: r.occupied, at: r.at } });
    return r;
  }

  /** Places occupées selon les sessions payées et les réservations confirmées à un instant. */
  private occupiedAt(z: ParkingZone, at: Date): number {
    const sessions = this.svc.sessions.find((s) => s.zoneId === z.id).filter((s) => {
      const d = this.svc.sessionDerived(s, at);
      if (!d.startAt || !d.paidUntil) return false;
      const end = s.endedAt ? Math.min(new Date(s.endedAt).getTime(), d.paidUntil.getTime()) : d.paidUntil.getTime();
      return d.startAt <= at && end > at.getTime();
    }).length;
    const reserved = this.svc.reservations.find((r) => r.zoneId === z.id && r.status === 'APPROUVEE' && new Date(r.startAt) <= at && new Date(r.endAt) > at).reduce((a, r) => a + r.places, 0);
    return sessions + reserved;
  }

  /** Profil horaire d'une zone pour une journée de Kinshasa : sessions + réservations, ou relevé capteur s'il existe. */
  hourlyProfile(z: ParkingZone, date: string) {
    const now = this.now();
    const cap = z.capacity.standard;
    return Array.from({ length: 24 }, (_, h) => {
      const mid = hourMid(date, h);
      const start = new Date(mid.getTime() - 30 * MINUTE);
      if (start > now) return { hour: h, observed: false, occupied: null, source: null, freeRate: null, target: 'SANS_OBJET' as const };
      const at = mid > now ? now : mid;
      const sensor = this.sensorReadings.find((r) => r.zoneId === z.id && new Date(r.at) >= start && new Date(r.at) <= at).sort((a, b) => b.at.localeCompare(a.at))[0];
      const occupied = sensor ? Math.min(sensor.occupied, cap) : this.occupiedAt(z, at);
      const freeRate = cap > 0 ? pct(Math.max(0, cap - occupied), cap) : null;
      return { hour: h, observed: true, occupied, source: sensor ? 'CAPTEUR' as const : 'SESSIONS' as const, freeRate, target: freeTargetOf(freeRate) };
    });
  }

  /** Occupation par zone et par heure, alertes hors cible (jamais une sanction). */
  occupancy(user: User, date?: string) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    const day = date ?? kinshasaDate(this.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('INVALID_DATE', 'Date attendue : AAAA-MM-JJ.');
    const zones = this.svc.zones.all().sort((a, b) => a.code.localeCompare(b.code)).map((z) => {
      const legalStatus = this.svc.zoneStatus(z).legalStatus;
      const hours = z.capacity.standard > 0 ? this.hourlyProfile(z, day) : [];
      const observed = hours.filter((h) => h.observed);
      const current = observed.at(-1) ?? null;
      return {
        zoneId: z.id, code: z.code, name: z.name, commune: z.commune, capacity: z.capacity.standard, legalStatus, demo: z.demo, premium: z.premium ?? null,
        hours, current,
        hoursSaturated: observed.filter((h) => h.target === 'SATURE').length,
        hoursUnderused: observed.filter((h) => h.target === 'SOUS_UTILISE').length,
        alert: current && legalStatus === 'OUVERTE' && (current.target === 'SATURE' || current.target === 'SOUS_UTILISE')
          ? { level: current.target, freeRate: current.freeRate, text: current.target === 'SATURE' ? `Moins de ${FREE_TARGET.minPct} % de places libres : rotation insuffisante.` : `Plus de ${FREE_TARGET.maxPct} % de places libres : zone sous-utilisée.` }
          : null,
      };
    });
    return {
      date: day, target: FREE_TARGET, generatedAt: this.now().toISOString(), zones,
      alerts: zones.filter((z) => z.alert).map((z) => ({ zoneId: z.zoneId, code: z.code, name: z.name, ...z.alert! })),
      notice: 'Occupation = sessions payées + réservations confirmées, ou relevé de capteur (maquette de flux) lorsqu’il existe. Cible du dossier source : 15 à 25 % de places libres.',
    };
  }

  /**
   * Recommandations tarifaires (préparées par le système, jamais appliquées) : une zone ouverte majoritairement hors cible
   * sur la journée reçoit une recommandation « hausse à étudier » ou « baisse à étudier ». Aucun montant n'est proposé :
   * toute nouvelle grille est une nouvelle version de règle rédigée et approuvée par le circuit à quatre visas.
   */
  runRecommendations(user: User, date?: string) {
    authorize(user, 'parking:zone.manage', { entity: DGTK });
    const occ = this.occupancy(user, date);
    const created: PricingRecommendation[] = [];
    for (const z of occ.zones) {
      if (z.legalStatus !== 'OUVERTE') continue;
      const observed = z.hours.filter((h) => h.observed).length;
      if (!observed) continue;
      const out = Math.max(z.hoursSaturated, z.hoursUnderused);
      if (out * 2 <= observed) continue;
      if (this.recommendations.findOne((r) => r.zoneId === z.zoneId && r.status === 'PROPOSEE')) continue;
      const zone = this.svc.getZone(z.zoneId);
      const rule = activeRule(this.ctx, zone.tariffRuleCode);
      const direction = z.hoursSaturated >= z.hoursUnderused ? 'HAUSSE_A_ETUDIER' as const : 'BAISSE_A_ETUDIER' as const;
      const rec = this.recommendations.insert({
        id: this.ids.next('PKREC', 4), zoneId: z.zoneId, date: occ.date, observedHours: observed, hoursSaturated: z.hoursSaturated, hoursUnderused: z.hoursUnderused,
        direction, tariffRuleCode: zone.tariffRuleCode, tariffRuleVersion: rule?.version ?? null,
        basis: `${z.code} : ${direction === 'HAUSSE_A_ETUDIER' ? z.hoursSaturated : z.hoursUnderused} heure(s) sur ${observed} ${direction === 'HAUSSE_A_ETUDIER' ? `sous ${FREE_TARGET.minPct} %` : `au-dessus de ${FREE_TARGET.maxPct} %`} de places libres le ${occ.date}. Recommandation : ${direction === 'HAUSSE_A_ETUDIER' ? 'étudier une hausse ou une différenciation horaire' : 'étudier une baisse ou une réaffectation des places'} par une nouvelle version de la règle ${zone.tariffRuleCode ?? '(aucune)'}.`,
        status: 'PROPOSEE', applied: false, createdAt: this.now().toISOString(),
      });
      created.push(rec);
      this.ctx.audit.append({ actor: { kind: 'system', id: 'parksmart-recommandations' }, action: 'parking.pricing.recommendation_prepared', resourceType: 'parking_zone', resourceId: z.zoneId, details: { recommendationId: rec.id, direction, applied: false } });
    }
    return { created, items: this.recommendations.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  /**
   * Recommandation ciblée préparée par la tarification dynamique (module 75) quand l'ajustement automatique n'est pas
   * possible (hors fourchette de l'acte, sans acte, sans pas d'ajustement) : même dépôt, même décision humaine, jamais
   * appliquée. Une seule recommandation PROPOSÉE par zone.
   */
  prepareRecommendation(zoneId: string, input: { date: string; hour: number; direction: PricingRecommendation['direction']; basis: string; freeRate: string | null }): PricingRecommendation | null {
    if (this.recommendations.findOne((r) => r.zoneId === zoneId && r.status === 'PROPOSEE')) return null;
    const zone = this.svc.getZone(zoneId);
    const rule = activeRule(this.ctx, zone.tariffRuleCode);
    const rec = this.recommendations.insert({
      id: this.ids.next('PKREC', 4), zoneId, date: input.date, observedHours: 1,
      hoursSaturated: input.direction === 'HAUSSE_A_ETUDIER' ? 1 : 0, hoursUnderused: input.direction === 'BAISSE_A_ETUDIER' ? 1 : 0,
      direction: input.direction, tariffRuleCode: zone.tariffRuleCode, tariffRuleVersion: rule?.version ?? null,
      basis: `${zone.code}, ${String(input.hour).padStart(2, '0')} h le ${input.date} : ${input.freeRate ?? '—'} % de places libres. ${input.basis}`,
      status: 'PROPOSEE', applied: false, createdAt: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'parksmart-tarification' }, action: 'parking.pricing.recommendation_prepared', resourceType: 'parking_zone', resourceId: zoneId, details: { recommendationId: rec.id, direction: rec.direction, applied: false, source: 'TARIFICATION_DYNAMIQUE' } });
    return rec;
  }

  listRecommendations(user: User) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    return this.recommendations.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({ ...r, zone: this.zoneRef(r.zoneId) }));
  }

  /** Décision humaine motivée : retenir pour rédaction d'une nouvelle version (circuit à quatre visas) ou écarter. */
  decideRecommendation(user: User, id: string, input: { outcome: 'RETENUE_POUR_NOUVELLE_VERSION' | 'ECARTEE'; reason: string }) {
    authorize(user, 'parking:pricing.decide', { entity: DGTK });
    const r = this.recommendations.get(id);
    if (!r) throw notFound('RECOMMENDATION_NOT_FOUND', `Recommandation inconnue : ${id}`);
    if (r.status !== 'PROPOSEE') throw conflict('RECOMMENDATION_ALREADY_DECIDED', `Recommandation déjà traitée (${r.status}).`);
    const updated = this.recommendations.update({ ...r, status: input.outcome, decision: { by: user.id, at: this.now().toISOString(), reason: input.reason } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.pricing.recommendation_decided', resourceType: 'parking_zone', resourceId: r.zoneId, details: { recommendationId: r.id, outcome: input.outcome, reason: input.reason, tariffChanged: false } });
    return { ...updated, nextStep: input.outcome === 'RETENUE_POUR_NOUVELLE_VERSION' ? 'Rédiger une nouvelle version de la règle tarifaire au registre ; activation après les quatre visas (rédaction, juridique, financier, publication).' : 'Aucune suite.' };
  }

  // ============================================================================ § 11A.3 Sources de recettes, zones premium, données urbaines

  setPremium(user: User, zoneId: string, input: { category: (typeof PREMIUM_CATEGORIES)[number] | null; reason: string }) {
    const z = this.svc.getZone(zoneId);
    authorize(user, 'parking:zone.manage', { entity: z.entity });
    const { premium: _p, ...rest } = z;
    const updated = this.svc.zones.update(input.category ? { ...z, premium: { category: input.category, reason: input.reason, by: user.id, at: this.now().toISOString() } } : rest);
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.zone.premium_classified', resourceType: 'parking_zone', resourceId: z.id, details: { category: input.category, reason: input.reason } });
    return this.svc.zoneView(updated);
  }

  /** Catalogue des sources de recettes du § 11A.3, avec l'état de chaque source et les recettes confirmées par nature. */
  revenueSources(user: User) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    const ind = this.svc.indicators(user);
    const kind = (k: 'SESSION' | 'RESERVATION' | 'PENALITE') => sumByCurrency(ind.zones.flatMap((z) => z.revenueByKind[k]));
    const titles: MoneyJSON[] = [];
    const t = this.titres;
    if (t) {
      t.sync();
      for (const c of t.credentials.find((x) => x.module === PARKSMART_TITLE_MODULE)) if (c.amount) titles.push(c.amount);
    }
    const premiumZones = this.svc.zones.find((z) => !!z.premium).map((z) => ({ id: z.id, code: z.code, name: z.name, category: z.premium!.category }));
    return {
      generatedAt: this.now().toISOString(),
      sources: [
        { code: 'REDEVANCES', label: 'Redevances de stationnement', content: 'Paiement horaire, journalier, anticipé ; prolongation à distance ; abonnements professionnels et résidentiels virtuels', status: 'EN_SERVICE', revenue: kind('SESSION'), titlesRevenue: sumByCurrency(titles), via: ['/v1/parking/sessions', '/v1/titres'] },
        { code: 'PENALITES', label: 'Pénalités', content: 'Selon le barème ACTIF et le circuit RW1 (constat, vérification, décision motivée, contestation) ; blocage des récidivistes décidé par l’autorité compétente selon la procédure légale', status: 'EN_SERVICE', revenue: kind('PENALITE'), via: ['/v1/parking/violations', '/v1/recouvrement'] },
        { code: 'RESERVATIONS_VOIRIE', label: 'Réservations temporaires de voirie', content: 'Déménagements, chantiers, livraisons, événements : demande → décision motivée → redevance → paiement → titre contrôlable par plaque', status: 'EN_SERVICE', revenue: kind('RESERVATION'), via: ['/v1/parking/reservations'] },
        { code: 'ZONES_PREMIUM', label: 'Zones premium', content: 'Zones à haute demande, commerciales, administratives, gouvernementales ; tarif par grille rattachée à la zone', status: premiumZones.length ? 'EN_SERVICE' : 'ACTE_REQUIS', zones: premiumZones, via: ['/v1/parking/zones/{id}/premium', '/v1/parking/tariff-grids'] },
        {
          code: 'SERVICES_VALEUR_AJOUTEE', label: 'Services à valeur ajoutée', status: 'PARTIEL',
          items: [
            { label: 'Pré-réservation garantie', status: t ? 'EN_SERVICE' : 'MODULE_TITRES_ABSENT' },
            { label: 'Zone VIP', status: 'ACTE_REQUIS' },
            { label: 'Stationnement avec recharge électrique', status: 'PHASE_FUTURE' },
            { label: 'Analyses urbaines', status: 'EN_SERVICE' },
            { label: 'Partenariats commerciaux locaux', status: 'EN_SERVICE' },
          ],
          via: ['/v1/titres', '/v1/parking/urban-data', '/v1/parking/partners'],
        },
        { code: 'DONNEES_URBAINES', label: 'Données urbaines', content: `Flux, zones congestionnées, appui à la planification — agrégées et anonymisées (seuil k = ${URBAN_K_THRESHOLD}, aucune plaque)`, status: 'EN_SERVICE', via: ['/v1/parking/urban-data'] },
      ],
      notice: 'Recettes = paiements confirmés par le prestataire, versés au compte public ; aucune recette ne transite par un agent.',
    };
  }

  /**
   * Données urbaines AGRÉGÉES ET ANONYMISÉES (§ 8.2, § 32) : par zone et par heure, sessions commencées et plaques
   * distinctes ; toute cellule de moins de k plaques distinctes est masquée. Aucune plaque, aucun identifiant.
   */
  urbanData(user: User, date?: string) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    const day = date ?? kinshasaDate(this.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('INVALID_DATE', 'Date attendue : AAAA-MM-JJ.');
    let suppressed = 0;
    const zones = this.svc.zones.all().sort((a, b) => a.code.localeCompare(b.code)).map((z) => {
      const occ = z.capacity.standard > 0 ? this.hourlyProfile(z, day) : [];
      const cells = Array.from({ length: 24 }, (_, h) => {
        const from = hourMid(day, h).getTime() - 30 * MINUTE;
        const to = from + HOUR_MS;
        const plates = new Set<string>();
        let started = 0;
        for (const s of this.svc.sessions.find((x) => x.zoneId === z.id)) {
          const d = this.svc.sessionDerived(s, this.now());
          if (d.startAt && d.startAt.getTime() >= from && d.startAt.getTime() < to) { started += 1; plates.add(s.plate); }
        }
        const hidden = plates.size > 0 && plates.size < URBAN_K_THRESHOLD;
        if (hidden) suppressed += 1;
        const o = occ[h];
        return { hour: h, sessionsStarted: hidden ? null : started, distinctVehicles: hidden ? null : plates.size, suppressed: hidden ? 'SEUIL' as const : null, congestion: o?.target === 'SATURE' };
      });
      return { zoneCode: z.code, commune: z.commune, demo: z.demo, cells };
    });
    return {
      date: day, kThreshold: URBAN_K_THRESHOLD, suppressedCells: suppressed, zones,
      notice: `Agrégats anonymisés : aucune plaque ni identifiant ; cellules de moins de ${URBAN_K_THRESHOLD} véhicules distincts masquées (même seuil que la transparence publique).`,
    };
  }

  // ============================================================================ § 11A.4 / 11A.6 Plaque : historique, récidive, score explicable

  private zoneRef(id: string | null) {
    const z = id ? this.svc.zones.get(id) : undefined;
    return z ? { id: z.id, code: z.code, name: z.name } : null;
  }

  /** Profil de la plaque : sert UNIQUEMENT à prioriser patrouilles et propositions ; jamais une décision. */
  plateProfileData(plate: string) {
    const now = this.now();
    const since = now.getTime() - RECIDIVISM_WINDOW_DAYS * DAY_MS;
    const checks = this.svc.checks.find((c) => c.plate === plate);
    const violations = this.svc.violations.find((v) => v.plate === plate);
    const retained = violations.filter((v) => v.status === 'RETENU' && Date.parse(v.decision?.at ?? v.createdAt) >= since);
    const unpaid = retained.filter((v) => v.decision?.obligationId).filter((v) => {
      const st = paymentState(this.ctx, v.decision!.obligationId!).state;
      return st !== 'PAYE' && st !== 'RAPPROCHE';
    });
    const compliant = checks.filter((c) => c.light !== 'ROUGE').length;
    const complianceScore = pct(compliant, checks.length);
    const level = unpaid.length >= 2 || retained.length >= 3 ? 'RECIDIVE' : retained.length >= 1 ? 'ANTECEDENT' : 'AUCUN';
    return {
      plate, checks, violations, retained, unpaid, compliant,
      score: {
        complianceScore,
        recidivism: level as 'RECIDIVE' | 'ANTECEDENT' | 'AUCUN',
        explanation: [
          `Contrôles : ${checks.length}, dont ${compliant} avec titre valide (score de conformité = part des contrôles conformes${complianceScore ? ` : ${complianceScore} %` : ' : sans objet'}).`,
          `Constats retenus sur ${RECIDIVISM_WINDOW_DAYS} jours : ${retained.length} (fenêtre par défaut — à confirmer par le maître d’ouvrage).`,
          `Pénalités retenues impayées : ${unpaid.length}.`,
          `Niveau : ${level === 'RECIDIVE' ? 'récidive (au moins 2 pénalités impayées ou 3 constats retenus)' : level === 'ANTECEDENT' ? 'antécédent (au moins un constat retenu)' : 'aucun antécédent'} — seuils par défaut, à confirmer par le maître d’ouvrage.`,
        ],
      },
    };
  }

  plateProfile(user: User, rawPlate: string) {
    authorize(user, 'parking:plate.profile', { entity: DGTK });
    const plate = this.svc.plate(rawPlate);
    const p = this.plateProfileData(plate);
    const now = this.now();
    const t = this.titres;
    const titles = t ? t.byPlate(plate, PARKSMART_TITLE_MODULE, now).slice(0, 20).map((c) => ({ number: c.number, typeCode: c.typeCode, zone: c.place.label, validFrom: c.validFrom, validUntil: c.validUntil, status: statusAt(c, now).status })) : [];
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.plate.profile_viewed', resourceType: 'plate', resourceId: plate, details: { purpose: 'PRIORISATION' } });
    return {
      plate,
      usage: 'PRIORISATION_PATROUILLES_ET_PROPOSITIONS',
      automaticMeasure: false,
      measureAuthority: 'Blocage administratif et fourrière : décision de l’autorité compétente selon la procédure légale (circuit de recouvrement : proposition R20, décision R21), jamais déclenchés par l’algorithme.',
      score: p.score,
      history: {
        sessions: this.svc.sessions.find((s) => s.plate === plate).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map((s) => {
          const v = this.svc.sessionView(s);
          return { id: v.id, zone: v.zone, status: v.status, startAt: v.startAt, paidUntil: v.paidUntil, totalMinutes: v.totalMinutes };
        }),
        checks: p.checks.slice(-50).reverse().map((c) => ({ id: c.id, at: c.at, zone: this.zoneRef(c.zoneId), light: c.light, title: c.title })),
        violations: p.violations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((v) => ({ id: v.id, reference: v.reference, nature: v.nature, status: v.status, createdAt: v.createdAt, zone: this.zoneRef(v.zoneId), obligationId: v.decision?.obligationId ?? null, payment: v.decision?.obligationId ? paymentState(this.ctx, v.decision.obligationId).state : null })),
        reservations: this.svc.reservations.find((r) => r.plate === plate).map((r) => ({ id: r.id, reference: r.reference, purpose: r.purpose, status: r.status, startAt: r.startAt, endAt: r.endAt })),
        titles,
        referrals: this.referrals.find((r) => r.plate === plate),
      },
    };
  }

  /** Classement des plaques pour orienter patrouilles et propositions (tri lexicographique explicable, sans pondération inventée). */
  platePriorities(user: User) {
    authorize(user, 'parking:plate.profile', { entity: DGTK });
    const plates = new Set([...this.svc.violations.all().map((v) => v.plate), ...this.svc.checks.all().filter((c) => c.light === 'ROUGE').map((c) => c.plate)]);
    const rows = [...plates].map((plate) => {
      const p = this.plateProfileData(plate);
      return { plate, retained: p.retained.length, unpaid: p.unpaid.length, redChecks: p.checks.length - p.compliant, checks: p.checks.length, complianceScore: p.score.complianceScore, recidivism: p.score.recidivism };
    }).sort((a, b) => b.unpaid - a.unpaid || b.retained - a.retained || b.redChecks - a.redChecks || a.plate.localeCompare(b.plate));
    return {
      items: rows,
      order: 'Pénalités impayées, puis constats retenus, puis contrôles sans titre (décroissant).',
      usage: 'PRIORISATION_PATROUILLES_ET_PROPOSITIONS',
      automaticMeasure: false,
      notice: 'Ce classement oriente les patrouilles et la préparation des propositions ; aucune mesure (blocage, fourrière, pénalité) n’en découle automatiquement.',
    };
  }

  /**
   * Transmission HUMAINE d'une plaque au contentieux (régie) pour une mesure envisagée : aucune mesure n'est prise.
   * La mesure suit le circuit de recouvrement (proposition motivée R20, décision R21 selon la procédure légale).
   */
  refer(principal: Principal, rawPlate: string, input: { measure: PlateReferral['measure']; grounds: string }) {
    authorize(principal, 'parking:plate.refer', { entity: DGTK });
    const user = principal as User;
    const plate = this.svc.plate(rawPlate);
    const p = this.plateProfileData(plate);
    if (p.unpaid.length === 0) throw unprocessable('NO_UNPAID_PENALTY', 'Aucune pénalité retenue impayée pour cette plaque : aucune mesure ne peut être envisagée.');
    const r = this.referrals.append({
      id: this.ids.next('PKTR', 4), plate, measure: input.measure, grounds: input.grounds,
      unpaidObligationIds: p.unpaid.map((v) => v.decision!.obligationId!), retainedViolationIds: p.retained.map((v) => v.id),
      by: user.id, at: this.now().toISOString(), status: 'TRANSMISE_AU_CONTENTIEUX', measureTaken: false,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.plate.referred', resourceType: 'plate', resourceId: plate, details: { referralId: r.id, measure: r.measure, measureTaken: false } });
    return { ...r, nextStep: 'Le contentieux (R20) instruit et, le cas échéant, propose la mesure dans le circuit de recouvrement ; l’autorité compétente (R21) décide selon la procédure légale.' };
  }

  // ============================================================================ § 11A.5 Surréservation contrôlée

  /** Taux d'annulation observé : réservations approuvées échues sans paiement à l'heure de début / réservations approuvées échues. */
  overbookingStats() {
    const now = this.now();
    const due = this.svc.reservations.find((r) => r.status === 'APPROUVEE' && new Date(r.startAt) <= now);
    const cancelled = due.filter((r) => {
      const st = paymentState(this.ctx, r.obligationId);
      return !((st.state === 'PAYE' || st.state === 'RAPPROCHE') && st.confirmedAt && st.confirmedAt <= r.startAt);
    });
    const t = this.titres;
    let premiumDue = 0;
    let premiumCancelled = 0;
    if (t) {
      const premium = new Set<string>([PARKSMART_TITLE_TYPES.PRE_RESERVATION_PREMIUM.real, PARKSMART_TITLE_TYPES.PRE_RESERVATION_PREMIUM.demo]);
      for (const i of t.issuances.all()) {
        if (!i.items.some((it) => premium.has(it.typeCode))) continue;
        if (i.status === 'EN_ATTENTE_PAIEMENT') continue;
        premiumDue += 1;
        if (i.status === 'ANNULEE' || i.status === 'EXPIREE') premiumCancelled += 1;
      }
    }
    const sample = due.length + premiumDue;
    const cancelledN = cancelled.length + premiumCancelled;
    const observed = pct(cancelledN, sample);
    const enough = sample >= OVERBOOKING_MIN_SAMPLE;
    const suggested = enough && observed !== null ? Math.min(Math.floor(Number.parseFloat(observed)), OVERBOOKING_BOUNDS.maxPct) : null;
    return {
      sample, cancelled: cancelledN, observedCancellationRate: observed, minSample: OVERBOOKING_MIN_SAMPLE, enoughHistory: enough,
      suggestedRatePct: suggested, bounds: OVERBOOKING_BOUNDS,
      basis: enough ? `Taux d’annulation observé sur ${sample} réservation(s) échue(s), plafonné à ${OVERBOOKING_BOUNDS.maxPct} %.` : `Historique insuffisant (${sample} sur ${OVERBOOKING_MIN_SAMPLE} requis — seuil par défaut, à confirmer par le maître d’ouvrage).`,
    };
  }

  overbookingState() {
    const validation = this.overbookingValidations.all().at(-1) ?? null;
    const activation = this.overbookingActivations.all().at(-1) ?? null;
    const active = !!validation && !!activation?.enabled;
    return { active, ratePct: active ? activation!.ratePct : 0, validation, activation, stats: this.overbookingStats() };
  }

  overbookingActive(): boolean {
    return this.overbookingState().active;
  }

  /** Places supplémentaires autorisées dans une zone (0 tant que la surréservation n'est pas validée ET activée). */
  overbookingAllowance(z: ParkingZone): number {
    const st = this.overbookingState();
    return st.active ? Math.floor((z.capacity.standard * st.ratePct) / 100) : 0;
  }

  /** Validation juridique au regard de la protection du consommateur (autorité compétente, référence de l'avis). */
  validateOverbooking(user: User, input: { reference: string; guarantee: OverbookingValidation['guarantee']; reason: string }) {
    authorize(user, 'parking:overbooking.validate', { entity: DGTK });
    const v = this.overbookingValidations.append({ id: this.ids.next('PKOVV', 4), reference: input.reference, guarantee: input.guarantee, reason: input.reason, by: user.id, at: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.overbooking.legal_validation', resourceType: 'parking_overbooking', resourceId: v.id, details: { reference: v.reference, guarantee: v.guarantee } });
    return this.overbookingState();
  }

  /** Activation ou désactivation (décision humaine) : exige la validation juridique et un taux fondé sur l'historique réel. */
  setOverbooking(user: User, input: { enabled: boolean; ratePct?: number; reason: string }) {
    authorize(user, 'parking:overbooking.validate', { entity: DGTK });
    const validation = this.overbookingValidations.all().at(-1) ?? null;
    let rate = 0;
    if (input.enabled) {
      if (!validation) throw unprocessable('LEGAL_VALIDATION_REQUIRED', 'Surréservation non activable : aucune validation juridique (protection du consommateur) n’est enregistrée.');
      const stats = this.overbookingStats();
      if (stats.suggestedRatePct === null) throw unprocessable('INSUFFICIENT_HISTORY', stats.basis);
      rate = input.ratePct ?? stats.suggestedRatePct;
      if (!Number.isInteger(rate) || rate < 0 || rate > stats.suggestedRatePct) throw badRequest('INVALID_RATE', `Taux : entier de 0 à ${stats.suggestedRatePct} % (historique réel, plafond ${OVERBOOKING_BOUNDS.maxPct} %).`);
    }
    const a = this.overbookingActivations.append({ id: this.ids.next('PKOVA', 4), enabled: input.enabled, ratePct: rate, reason: input.reason, validationId: validation?.id ?? null, by: user.id, at: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: input.enabled ? 'parking.overbooking.enabled' : 'parking.overbooking.disabled', resourceType: 'parking_overbooking', resourceId: a.id, details: { ratePct: rate, reason: input.reason } });
    return this.overbookingState();
  }

  /**
   * Place indisponible pour une réservation confirmée : garantie de place (relogement à organiser) ou compensation
   * automatique (remboursement intégral dû, exécuté par le circuit de remboursement du Trésor) selon la validation.
   */
  declareUnavailable(user: User, reservationId: string, reason: string) {
    authorize(user, 'parking:reservation.decide', { entity: DGTK });
    const r = this.svc.reservations.get(reservationId);
    if (!r) throw notFound('RESERVATION_NOT_FOUND', `Réservation inconnue : ${reservationId}`);
    if (r.status !== 'APPROUVEE') throw conflict('RESERVATION_NOT_APPROVED', 'Seule une réservation approuvée peut être déclarée indisponible.');
    if (this.compensations.findOne((c) => c.reservationId === r.id)) throw conflict('ALREADY_COMPENSATED', 'Indisponibilité déjà déclarée pour cette réservation.');
    const guarantee = this.overbookingValidations.all().at(-1)?.guarantee ?? 'COMPENSATION_AUTOMATIQUE';
    const pay = paymentState(this.ctx, r.obligationId);
    const c = this.compensations.append({
      id: this.ids.next('PKCOMP', 4), reservationId: r.id, guarantee, reason, amount: guarantee === 'COMPENSATION_AUTOMATIQUE' ? pay.amount ?? null : null,
      status: guarantee === 'COMPENSATION_AUTOMATIQUE' ? 'COMPENSATION_DUE' : 'RELOGEMENT_A_ORGANISER', by: user.id, at: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.reservation.unavailable', resourceType: 'road_reservation', resourceId: r.id, details: { compensationId: c.id, guarantee, amount: c.amount } });
    this.ctx.comms.publish('permit.refused', [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference: r.reference }, { entity: DGTK });
    return c;
  }

  // ============================================================================ § 11A.5 Reconfiguration des espaces

  createReconfiguration(user: User, input: { zoneId: string; kind: Reconfiguration['kind']; description: string; expectedEffect: string }, opts: { demo?: boolean } = {}) {
    authorize(user, 'parking:zone.manage', { entity: DGTK });
    const z = this.svc.getZone(input.zoneId);
    const now = this.now().toISOString();
    const r = this.reconfigurations.insert({
      id: this.ids.next('PKRCF', 4), zoneId: z.id, kind: input.kind, description: input.description, expectedEffect: input.expectedEffect, status: 'ETUDE',
      history: [{ status: 'ETUDE', reason: 'Inscription au registre', by: user.id, at: now }], demo: opts.demo === true, createdBy: user.id, createdAt: now,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.reconfiguration.proposed', resourceType: 'parking_zone', resourceId: z.id, details: { reconfigurationId: r.id, kind: r.kind } });
    return this.reconfigView(r);
  }

  /** Changement de statut motivé. La capacité de la zone n'est jamais modifiée ici : elle suit l'acte et le relevé. */
  setReconfigurationStatus(user: User, id: string, input: { status: Reconfiguration['status']; reason: string }) {
    authorize(user, 'parking:zone.manage', { entity: DGTK });
    const r = this.reconfigurations.get(id);
    if (!r) throw notFound('RECONFIGURATION_NOT_FOUND', `Reconfiguration inconnue : ${id}`);
    if (r.status === 'REALISEE' || r.status === 'ABANDONNEE') throw conflict('RECONFIGURATION_CLOSED', `Reconfiguration close (${r.status}).`);
    const updated = this.reconfigurations.update({ ...r, status: input.status, history: [...r.history, { status: input.status, reason: input.reason, by: user.id, at: this.now().toISOString() }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.reconfiguration.status_changed', resourceType: 'parking_zone', resourceId: r.zoneId, details: { reconfigurationId: r.id, status: input.status, reason: input.reason } });
    return this.reconfigView(updated);
  }

  private reconfigView(r: Reconfiguration) {
    return { ...r, zone: this.zoneRef(r.zoneId) };
  }

  listReconfigurations(user: User) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    return this.reconfigurations.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => this.reconfigView(r));
  }

  // ============================================================================ § 11A.7 Affectation : engagement de programmation

  createCommitment(user: User, input: { domain: AffectationCommitment['domain']; label: string; legalForm?: AffectationCommitment['legalForm']; actReference?: string | null; period: string; programmedAmount?: MoneyJSON | null }, opts: { demo?: boolean } = {}) {
    authorize(user, 'parking:affectation.manage', { entity: DGTK });
    const legalForm = input.legalForm ?? 'ENGAGEMENT_DE_PROGRAMMATION';
    if (legalForm === 'ACTE_JURIDIQUE' && !input.actReference) throw unprocessable('ACT_REFERENCE_REQUIRED', 'Une affectation par acte juridique exige la référence d’un acte compatible avec l’universalité budgétaire (LOFIP).');
    const c = this.commitments.insert({
      id: this.ids.next('PKAFF', 4), domain: input.domain, label: input.label, legalForm, actReference: input.actReference ?? null, period: input.period,
      programmedAmount: input.programmedAmount ? Money.fromJSON(input.programmedAmount).toJSON() : null, published: false, publishedAt: null, publishedBy: null,
      demo: opts.demo === true, createdBy: user.id, createdAt: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.affectation.commitment_created', resourceType: 'parking_affectation', resourceId: c.id, details: { domain: c.domain, legalForm, period: c.period } });
    return c;
  }

  publishCommitment(user: User, id: string) {
    authorize(user, 'parking:affectation.manage', { entity: DGTK });
    const c = this.commitments.get(id);
    if (!c) throw notFound('COMMITMENT_NOT_FOUND', `Engagement inconnu : ${id}`);
    if (c.published) throw conflict('ALREADY_PUBLISHED', 'Engagement déjà publié.');
    assertDistinctPerson(user.id, [c.createdBy], 'Publication : personne distincte de l’auteur de l’engagement (quatre yeux).');
    const updated = this.commitments.update({ ...c, published: true, publishedAt: this.now().toISOString(), publishedBy: user.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.affectation.commitment_published', resourceType: 'parking_affectation', resourceId: c.id, details: { domain: c.domain } });
    return updated;
  }

  listCommitments(user: User) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    return this.commitments.all().map((c) => ({ ...c, domainLabel: DOMAIN_LABEL[c.domain] }));
  }

  /** Tableau de transparence (public) : engagements PUBLIÉS seulement ; aucune affectation automatique des recettes. */
  publicAffectation() {
    return {
      automaticEarmarking: false,
      principle: 'Les recettes de stationnement sont versées au compte public (universalité budgétaire, LOFIP). Une affectation exige un acte juridique compatible ; à défaut, elle prend la forme d’un engagement de programmation publié ici (§ 27.3).',
      items: this.commitments.find((c) => c.published).map((c) => ({ id: c.id, domain: c.domain, domainLabel: DOMAIN_LABEL[c.domain], label: c.label, legalForm: c.legalForm, actReference: c.actReference, period: c.period, programmedAmount: c.programmedAmount, publishedAt: c.publishedAt, demo: c.demo })),
    };
  }

  // ============================================================================ § 11A.8 Phases de déploiement

  private definePhases(): void {
    const defs: Omit<DeploymentPhase, 'id' | 'zoneIds' | 'status'>[] = [
      { number: 1, label: 'Activation', duration: '3 mois', perimeter: 'Gombe intégrale et axes structurants pilotes' },
      { number: 2, label: 'Extension', duration: '6 mois', perimeter: 'Routes commerciales majeures, zones administratives' },
      { number: 3, label: 'Généralisation', duration: 'Progressive', perimeter: 'Extension communale, zones à forte densité' },
    ];
    for (const d of defs) if (!this.phases.get(`PKPH-${d.number}`)) this.phases.insert({ ...d, id: `PKPH-${d.number}`, zoneIds: [], status: 'PLANIFIEE' });
  }

  private phase(n: number): DeploymentPhase {
    const p = this.phases.get(`PKPH-${n}`);
    if (!p) throw notFound('PHASE_NOT_FOUND', `Phase inconnue : ${n}`);
    return p;
  }

  phaseView(p: DeploymentPhase) {
    const zones = p.zoneIds.map((id) => this.svc.zones.get(id)).filter((z): z is ParkingZone => !!z).map((z) => ({ id: z.id, code: z.code, name: z.name, legalStatus: this.svc.zoneStatus(z).legalStatus, actReference: z.actReference, demo: z.demo }));
    const blockers = zones.filter((z) => z.legalStatus === 'ACTE_REQUIS').map((z) => `${z.code} : acte de zonage et grille tarifaire non publiés`);
    return { ...p, zones, blockers, activable: p.status === 'PLANIFIEE' && zones.length > 0 && blockers.length === 0 };
  }

  deployment(user: User) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    return {
      phases: this.phases.all().sort((a, b) => a.number - b.number).map((p) => this.phaseView(p)),
      notice: 'Chaque phase n’est activée que par décision de l’autorité, sur la référence de l’acte réglementaire, quand toutes ses zones ont un acte et une grille publiée au registre.',
    };
  }

  addPhaseZone(user: User, n: number, zoneId: string) {
    authorize(user, 'parking:zone.manage', { entity: DGTK });
    const p = this.phase(n);
    const z = this.svc.getZone(zoneId);
    const other = this.phases.findOne((x) => x.id !== p.id && x.zoneIds.includes(z.id));
    if (other) throw conflict('ZONE_IN_OTHER_PHASE', `Zone déjà inscrite en phase ${other.number}.`);
    if (p.zoneIds.includes(z.id)) return this.phaseView(p);
    const updated = this.phases.update({ ...p, zoneIds: [...p.zoneIds, z.id] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.deployment.zone_planned', resourceType: 'parking_phase', resourceId: p.id, details: { zoneId: z.id } });
    return this.phaseView(updated);
  }

  activatePhase(user: User, n: number, input: { actReference: string; reason: string }) {
    authorize(user, 'parking:deployment.activate', { entity: DGTK });
    const p = this.phase(n);
    if (p.status === 'ACTIVEE') throw conflict('PHASE_ALREADY_ACTIVE', `Phase ${n} déjà activée.`);
    if (n > 1 && this.phase(n - 1).status !== 'ACTIVEE') throw unprocessable('PREVIOUS_PHASE_REQUIRED', `La phase ${n - 1} doit être activée avant la phase ${n}.`);
    const v = this.phaseView(p);
    if (v.zones.length === 0) throw unprocessable('PHASE_WITHOUT_ZONE', 'Aucune zone inscrite dans cette phase.');
    if (v.blockers.length) throw unprocessable('ZONE_ACT_REQUIRED', `Activation impossible : ${v.blockers.join(' ; ')}.`, { blockers: v.blockers });
    const updated = this.phases.update({ ...p, status: 'ACTIVEE', activation: { actReference: input.actReference, reason: input.reason, by: user.id, at: this.now().toISOString() } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.deployment.phase_activated', resourceType: 'parking_phase', resourceId: p.id, details: { actReference: input.actReference, zones: p.zoneIds } });
    return this.phaseView(updated);
  }
}
