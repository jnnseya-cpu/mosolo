/**
 * MOSOLO Parking (ParkSmart, § 11A ; document maître § H.27.5).
 *
 * - Zones délimitées par ACTE : tant que la grille tarifaire n'est pas une règle ACTIVE du registre, la zone est
 *   « ACTE_REQUIS » et aucune session ne peut être vendue (RW3). Démonstration : zones FICTIVES liées à une règle
 *   fictive publiée par le circuit à quatre visas.
 * - Session payée au temps, liée à la PLAQUE : chaque achat ou prolongation est une obligation liquidée par le
 *   moteur commun sur la règle ACTIVE, payée par le circuit commun (ordre de paiement → confirmation signée →
 *   quittance). La validité court à partir de la confirmation du paiement ; rappel « ambre » avant expiration.
 * - Contrôle par plaque : résultat minimal (vert / ambre / rouge), sans nom ni adresse.
 * - Constat HUMAIN photographique (RW1) : constat (R11) → vérification (R09) → proposition préparée par le système
 *   selon le barème ACTIF → décision motivée (R06/R07, personne distincte) → notification → contestation / recours.
 *   Jamais d'amende, de blocage ni de fourrière automatiques (ARB-12) ; surréservation désactivée (ARB-14).
 * - Attribution de chaque recette à la commune de la zone (§ 20.3) via l'objet « occupation de voirie ».
 */
import { Money, readValidity, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS, isoDate } from '../../core/clock.js';
import { checkChar, randomCode } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate, hasAnyGrant } from '../../core/policy.js';
import { validityView } from '../../core/validity.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { isCommune } from '../../reference/kinshasa.js';
import {
  actorOf, activeRule, DGTK, enginePrincipal, latestRule, normalizePlate, paymentState, pct, perUnit, PLATE_RE, sumByCurrency, type PaymentState,
} from './support.js';

/** Surréservation (10 à 15 % du dossier source) : DÉSACTIVÉE jusqu'à validation juridique (ARB-14, J24). */
export const OVERBOOKING_ENABLED = false;
/** Rappel « ambre » avant l'expiration d'une session (paramètre de démonstration, fixé par l'acte en production). */
/** Code de ticket de stationnement : « PKT » + 6 caractères aléatoires + caractère de contrôle. */
export function newTicketCode(): string {
  const core = randomCode(6);
  return `PKT${core}${checkChar(`PKT${core}`)}`;
}

/** @deprecated la couleur suit désormais la règle 50 % / 1 % (core/validity.ts). */
export const REMINDER_MINUTES = 10;
/** Validité d'une référence non payée avant abandon de la demande de session. */
const UNPAID_ABANDON_MS = 48 * HOUR_MS;
const MINUTE = 60_000;

export const ZONE_KINDS = ['ZONE_INTEGRALE', 'ARTERE', 'SECTEUR'] as const;
export const VIOLATION_NATURES = ['NON_PAIEMENT', 'DEPASSEMENT', 'STATIONNEMENT_INTERDIT', 'PLACE_RESERVEE', 'DOUBLE_FILE'] as const;
export const RESERVATION_PURPOSES = ['DEMENAGEMENT', 'CHANTIER', 'LIVRAISON', 'EVENEMENT'] as const;
export const PARTNER_KINDS = ['PARKING_PRIVE', 'MARCHAND'] as const;

export type LonLat = [number, number];

export interface ParkingZone {
  id: string;
  code: string;
  name: string;
  commune: string;
  quartier: string;
  kind: (typeof ZONE_KINDS)[number];
  /** Géométrie simple : polygone (zone) ou ligne (artère), en [longitude, latitude]. */
  geometry: { type: 'Polygon' | 'LineString'; coordinates: LonLat[] };
  center: { lat: number; lon: number };
  localityRank: 1 | 2 | 3 | 4;
  capacity: { standard: number; livraison: number; pmr: number };
  linearMeters: number | null;
  /** Référence de l'acte de zonage (null ⇒ acte requis). */
  actReference: string | null;
  /** Code de la règle du registre portant la grille tarifaire (null ⇒ acte requis). */
  tariffRuleCode: string | null;
  /** Code de la règle portant le barème des pénalités (null ⇒ aucune pénalité proposable). */
  penaltyRuleCode: string | null;
  maxDurationMinutes: number | null;
  entity: string;
  suspended?: { reason: string; by: string; at: string };
  demo: boolean;
  note?: string;
  createdBy: string;
  createdAt: string;
}

export interface Vehicle {
  id: string;
  plate: string;
  taxpayerId: string;
  declaredBy: string;
  declaredAt: string;
  probativeStatus: 'DECLARE';
}

export interface SessionSegment {
  obligationId: string;
  minutes: number;
  kind: 'INITIALE' | 'PROLONGATION';
  requestedAt: string;
  requestedBy: string;
}

export interface ParkingSession {
  id: string;
  zoneId: string;
  commune: string;
  plate: string;
  payerTaxpayerId: string;
  objectId: string;
  segments: SessionSegment[];
  createdAt: string;
  createdBy: string;
  endedAt?: string;
  endedBy?: string;
  reminderSentAt?: string;
  /** Code de ticket aléatoire (non séquentiel) : vérification publique, SMS, WhatsApp, impression. */
  ticketCode?: string;
}

export type SessionStatus = 'EN_ATTENTE_PAIEMENT' | 'ACTIVE' | 'EXPIREE' | 'TERMINEE' | 'ABANDONNEE';
export type Light = 'VERT' | 'AMBRE' | 'ROUGE';

export interface ControlCheck {
  id: string;
  plate: string;
  zoneId: string | null;
  commune: string | null;
  light: Light;
  title: 'SESSION' | 'RESERVATION' | null;
  agentId: string;
  at: string;
}

export interface ViolationEvidence {
  id: string;
  violationId: string;
  photoSha256: string[];
  lat: number;
  lon: number;
  gpsAccuracyM: number | null;
  observedAt: string;
  deviceId: string | null;
  agentId: string;
  observations: string;
}

export interface ViolationContest {
  id: string;
  by: string;
  taxpayerId: string;
  at: string;
  grounds: string;
  stage: 'AVANT_DECISION' | 'APRES_DECISION';
  appealId?: string;
}

export interface ParkingViolation {
  id: string;
  reference: string;
  zoneId: string;
  commune: string;
  plate: string;
  nature: (typeof VIOLATION_NATURES)[number];
  lightAtCheck: Light | null;
  checkId: string | null;
  evidenceId: string;
  agentId: string;
  createdAt: string;
  holderTaxpayerId: string | null;
  status: 'CONSTATE' | 'VERIFIE' | 'REJETE' | 'RETENU' | 'CLASSE';
  verification?: { by: string; at: string; outcome: 'CONFIRME' | 'REJETE'; note: string };
  proposal?: {
    status: 'PROPOSEE' | 'ACTE_REQUIS';
    ruleCode: string | null;
    ruleVersion: number | null;
    amount: MoneyJSON | null;
    basis: string;
    preparedAt: string;
  };
  decision?: { by: string; at: string; outcome: 'RETENUE' | 'CLASSEE'; reason: string; obligationId: string | null; effect: string };
  contests: ViolationContest[];
}

export interface RoadReservation {
  id: string;
  reference: string;
  /** Code de ticket aléatoire (non séquentiel) pour la vérification publique et l'impression. */
  ticketCode?: string;
  zoneId: string;
  commune: string;
  taxpayerId: string;
  requestedBy: string;
  requestedAt: string;
  purpose: (typeof RESERVATION_PURPOSES)[number];
  places: number;
  startAt: string;
  endAt: string;
  plate: string | null;
  notes: string;
  status: 'DEMANDEE' | 'APPROUVEE' | 'REFUSEE';
  decision?: { by: string; at: string; reason: string };
  obligationId?: string;
  objectId?: string;
}

export interface ParkingPartner {
  id: string;
  name: string;
  kind: (typeof PARTNER_KINDS)[number];
  commune: string;
  quartier: string;
  lat: number;
  lon: number;
  capacity: number;
  operatorTaxpayerId: string | null;
  status: 'CONVENTION_EN_COURS' | 'PARTENAIRE' | 'SUSPENDU';
  statusHistory: { status: string; reason: string; by: string; at: string }[];
  declaredFree?: { places: number; at: string; by: string };
  demo: boolean;
  createdBy: string;
  createdAt: string;
}

export interface CreateZoneInput {
  code: string;
  name: string;
  commune: string;
  quartier: string;
  kind: ParkingZone['kind'];
  geometry: ParkingZone['geometry'];
  localityRank: 1 | 2 | 3 | 4;
  capacity: ParkingZone['capacity'];
  linearMeters?: number | null;
  actReference?: string | null;
  tariffRuleCode?: string | null;
  penaltyRuleCode?: string | null;
  maxDurationMinutes?: number | null;
  note?: string;
}

export class ParkingService {
  readonly zones = new InMemoryRepository<ParkingZone>();
  readonly vehicles = new InMemoryRepository<Vehicle>();
  readonly sessions = new InMemoryRepository<ParkingSession>();
  readonly checks = new InMemoryAppendOnlyRepository<ControlCheck>();
  /** Preuves du constat : ajout seul, jamais modifiées ni supprimées. */
  readonly evidence = new InMemoryAppendOnlyRepository<ViolationEvidence>();
  readonly violations = new InMemoryRepository<ParkingViolation>();
  readonly reservations = new InMemoryRepository<RoadReservation>();
  readonly partners = new InMemoryRepository<ParkingPartner>();
  private readonly ids = new IdGenerator();
  /** Moteur de liquidation des sessions achetées par l'usager (règle ACTIVE seulement). */
  readonly engine = enginePrincipal('svc-parking-liquidation', 'Moteur de liquidation ParkSmart (compte technique)', DGTK);

  constructor(private readonly ctx: AppContext) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  // ---------------------------------------------------------------- Zones

  zoneStatus(z: ParkingZone): { legalStatus: 'OUVERTE' | 'ACTE_REQUIS' | 'SUSPENDUE'; tariffRule: RuleSummary | null; penaltyRule: RuleSummary | null } {
    const tariff = activeRule(this.ctx, z.tariffRuleCode);
    const penalty = activeRule(this.ctx, z.penaltyRuleCode);
    const summary = (code: string | null, active: typeof tariff): RuleSummary | null => {
      if (!code) return null;
      const r = active ?? latestRule(this.ctx, code);
      return r
        ? { code: r.code, version: r.version, status: r.status, label: r.label, demo: r.demo === true, currency: r.currency, rateTable: active ? r.rateTable : {}, formula: r.formula }
        : { code, version: null, status: 'INCONNUE', label: code, demo: false, currency: null, rateTable: {}, formula: null };
    };
    const legalStatus = !tariff ? 'ACTE_REQUIS' : z.suspended ? 'SUSPENDUE' : 'OUVERTE';
    return { legalStatus, tariffRule: summary(z.tariffRuleCode, tariff), penaltyRule: summary(z.penaltyRuleCode, penalty) };
  }

  zoneView(z: ParkingZone) {
    const st = this.zoneStatus(z);
    const now = this.now();
    const active = this.sessions.find((s) => s.zoneId === z.id).filter((s) => this.sessionDerived(s, now).status === 'ACTIVE').length;
    const reserved = this.reservedPlaces(z.id, now, now);
    const cap = z.capacity.standard;
    return {
      ...z,
      ...st,
      occupancy: { active, reserved, capacity: cap, rate: pct(active + reserved, cap), free: Math.max(0, cap - active - reserved) },
      overbookingEnabled: OVERBOOKING_ENABLED,
    };
  }

  listZones() {
    return this.zones.all().sort((a, b) => a.code.localeCompare(b.code)).map((z) => this.zoneView(z));
  }

  getZone(id: string): ParkingZone {
    const z = this.zones.get(id) ?? this.zones.findOne((x) => x.code === id);
    if (!z) throw notFound('PARKING_ZONE_NOT_FOUND', `Zone de stationnement inconnue : ${id}`);
    return z;
  }

  createZone(user: User, input: CreateZoneInput, opts: { demo?: boolean; id?: string } = {}): ParkingZone {
    authorize(user, 'parking:zone.manage', { entity: DGTK });
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    if (this.zones.findOne((z) => z.code === input.code)) throw conflict('PARKING_ZONE_CODE_EXISTS', `Code de zone déjà utilisé : ${input.code}`);
    const pts = input.geometry.coordinates;
    if (input.geometry.type === 'Polygon' && pts.length < 3) throw badRequest('INVALID_GEOMETRY', 'Un polygone exige au moins trois sommets.');
    if (input.geometry.type === 'LineString' && pts.length < 2) throw badRequest('INVALID_GEOMETRY', 'Une artère exige au moins deux points.');
    const center = {
      lon: pts.reduce((s, p) => s + p[0], 0) / pts.length,
      lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
    };
    const zone = this.zones.insert({
      id: opts.id ?? this.ids.next('PKZ', 4),
      code: input.code,
      name: input.name,
      commune: input.commune,
      quartier: input.quartier,
      kind: input.kind,
      geometry: input.geometry,
      center,
      localityRank: input.localityRank,
      capacity: input.capacity,
      linearMeters: input.linearMeters ?? null,
      actReference: input.actReference ?? null,
      tariffRuleCode: input.tariffRuleCode ?? null,
      penaltyRuleCode: input.penaltyRuleCode ?? null,
      maxDurationMinutes: input.maxDurationMinutes ?? null,
      entity: DGTK,
      demo: opts.demo === true,
      ...(input.note ? { note: input.note } : {}),
      createdBy: user.id,
      createdAt: this.now().toISOString(),
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'parking.zone.created', resourceType: 'parking_zone', resourceId: zone.id,
      details: { code: zone.code, commune: zone.commune, kind: zone.kind, tariffRuleCode: zone.tariffRuleCode, legalStatus: this.zoneStatus(zone).legalStatus, demo: zone.demo },
    });
    return zone;
  }

  /** Rattache la grille tarifaire (règle du registre) et l'acte de zonage. Aucun montant n'est saisi ici. */
  setTariff(user: User, id: string, input: { tariffRuleCode: string | null; penaltyRuleCode?: string | null; actReference: string | null; maxDurationMinutes?: number | null }) {
    const z = this.getZone(id);
    authorize(user, 'parking:zone.manage', { entity: z.entity });
    for (const code of [input.tariffRuleCode, input.penaltyRuleCode]) {
      if (code && !latestRule(this.ctx, code)) throw unprocessable('UNKNOWN_RULE', `Règle inconnue du registre : ${code}`);
    }
    const updated = this.zones.update({
      ...z,
      tariffRuleCode: input.tariffRuleCode,
      ...(input.penaltyRuleCode !== undefined ? { penaltyRuleCode: input.penaltyRuleCode } : {}),
      actReference: input.actReference,
      ...(input.maxDurationMinutes !== undefined ? { maxDurationMinutes: input.maxDurationMinutes } : {}),
    });
    const st = this.zoneStatus(updated);
    this.ctx.audit.append({
      actor: actorOf(user), action: 'parking.zone.tariff_linked', resourceType: 'parking_zone', resourceId: z.id,
      details: { tariffRuleCode: input.tariffRuleCode, penaltyRuleCode: updated.penaltyRuleCode, actReference: input.actReference, legalStatus: st.legalStatus },
    });
    return this.zoneView(updated);
  }

  /** Suspension motivée (chantier, événement) ou réouverture : décision humaine tracée. */
  setSuspension(user: User, id: string, input: { suspended: boolean; reason: string }) {
    const z = this.getZone(id);
    authorize(user, 'parking:zone.manage', { entity: z.entity });
    const { suspended: _s, ...rest } = z;
    const updated = this.zones.update(input.suspended ? { ...z, suspended: { reason: input.reason, by: user.id, at: this.now().toISOString() } } : rest);
    this.ctx.audit.append({
      actor: actorOf(user), action: input.suspended ? 'parking.zone.suspended' : 'parking.zone.reopened', resourceType: 'parking_zone', resourceId: z.id,
      details: { reason: input.reason },
    });
    return this.zoneView(updated);
  }

  // ---------------------------------------------------------------- Véhicules (plaque = identifiant central)

  declareVehicle(user: User, plateRaw: string): Vehicle {
    const taxpayerId = this.selfTaxpayer(user);
    authorize(user, 'parking:vehicle.declare', { taxpayerId });
    const plate = this.plate(plateRaw);
    const existing = this.vehicles.findOne((v) => v.plate === plate);
    if (existing) {
      if (existing.taxpayerId === taxpayerId) return existing;
      throw conflict('PLATE_ALREADY_DECLARED', 'Cette plaque est déjà rattachée à un autre compte. Une demande de rectification passe par la régie.');
    }
    const v = this.vehicles.insert({
      id: this.ids.next('VEH'), plate, taxpayerId, declaredBy: user.id, declaredAt: this.now().toISOString(), probativeStatus: 'DECLARE',
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.vehicle.declared', resourceType: 'vehicle', resourceId: v.id, details: { plate } });
    return v;
  }

  myVehicles(user: User): Vehicle[] {
    const taxpayerId = this.selfTaxpayer(user);
    authorize(user, 'parking:vehicle.declare', { taxpayerId });
    return this.vehicles.find((v) => v.taxpayerId === taxpayerId);
  }

  private plate(raw: string): string {
    const p = normalizePlate(raw);
    if (!PLATE_RE.test(p)) throw badRequest('INVALID_PLATE', `Plaque invalide : « ${raw} » (lettres, chiffres et tirets, 4 à 14 caractères).`);
    return p;
  }

  private selfTaxpayer(user: User, forTaxpayer?: string): string {
    const id = forTaxpayer ?? user.taxpayerId;
    if (!id) throw forbidden('NO_TAXPAYER_ACCOUNT', 'Compte contribuable requis (compte unique MOSOLO).');
    return id;
  }

  // ---------------------------------------------------------------- Sessions

  /** Objet fiscal « occupation de voirie » du redevable dans la zone : fonde l'attribution à la commune de la zone (§ 20.3). */
  private occupationObject(taxpayerId: string, z: ParkingZone): string {
    const found = this.ctx.objects.objects.findOne((o) => o.taxpayerId === taxpayerId && o.attributes['parkingZoneId'] === z.id);
    if (found) return found.id;
    return this.ctx.objects.create(this.engine, {
      taxpayerId, category: 'AUTRE', commune: z.commune, quartier: z.quartier, localityRank: z.localityRank, lat: z.center.lat, lon: z.center.lon,
      attributes: { nature: 'OCCUPATION_VOIRIE_STATIONNEMENT', parkingZoneId: z.id, zoneCode: z.code },
    }).id;
  }

  private openZoneRule(z: ParkingZone) {
    const st = this.zoneStatus(z);
    if (st.legalStatus === 'ACTE_REQUIS') {
      throw unprocessable('ZONE_ACT_REQUIRED', `Zone ${z.code} : acte de zonage et grille tarifaire non publiés (règle ACTIVE requise). Aucune session ne peut être vendue.`, { zoneId: z.id });
    }
    if (st.legalStatus === 'SUSPENDUE') throw unprocessable('ZONE_SUSPENDED', `Zone ${z.code} suspendue : ${z.suspended?.reason ?? ''}`);
    return activeRule(this.ctx, z.tariffRuleCode)!;
  }

  private liquidate(user: User, z: ParkingZone, taxpayerId: string, objectId: string, minutes: number, places: number) {
    const rule = this.openZoneRule(z);
    const { obligation } = this.ctx.assessment.calculate(user, {
      ruleId: rule.id, taxpayerId, objectId, inputs: { duree_minutes: String(minutes), places: String(places) }, simulate: false,
    });
    return obligation!;
  }

  private checkDuration(minutes: number, z: ParkingZone, already = 0) {
    if (!Number.isInteger(minutes) || minutes < 15 || minutes % 15 !== 0 || minutes > 24 * 60) {
      throw badRequest('INVALID_DURATION', 'Durée invalide : multiple de 15 minutes, de 15 minutes à 24 heures.');
    }
    if (z.maxDurationMinutes && already + minutes > z.maxDurationMinutes) {
      throw unprocessable('MAX_DURATION_EXCEEDED', `Durée maximale de la zone ${z.code} : ${z.maxDurationMinutes} minutes (acte).`);
    }
  }

  startSession(user: User, input: { zoneId: string; plate: string; durationMinutes: number; taxpayerId?: string }) {
    const taxpayerId = this.selfTaxpayer(user, input.taxpayerId);
    authorize(user, 'parking:session.create', { taxpayerId });
    const z = this.getZone(input.zoneId);
    const plate = this.plate(input.plate);
    this.checkDuration(input.durationMinutes, z);
    this.openZoneRule(z);
    const now = this.now();
    const running = this.sessions.find((s) => s.plate === plate && s.zoneId === z.id).find((s) => {
      const st = this.sessionDerived(s, now).status;
      return st === 'ACTIVE' || st === 'EN_ATTENTE_PAIEMENT';
    });
    if (running) throw conflict('SESSION_ALREADY_RUNNING', `Une session est déjà en cours pour ${plate} dans cette zone : prolongez-la.`, { sessionId: running.id });
    const objectId = this.occupationObject(taxpayerId, z);
    const obligation = this.liquidate(this.engine, z, taxpayerId, objectId, input.durationMinutes, 1);
    const session = this.sessions.insert({
      id: this.ids.next('PKS'), ticketCode: newTicketCode(), zoneId: z.id, commune: z.commune, plate, payerTaxpayerId: taxpayerId, objectId,
      segments: [{ obligationId: obligation.id, minutes: input.durationMinutes, kind: 'INITIALE', requestedAt: now.toISOString(), requestedBy: user.id }],
      createdAt: now.toISOString(), createdBy: user.id,
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'parking.session.requested', resourceType: 'parking_session', resourceId: session.id,
      details: { zoneId: z.id, plate, minutes: input.durationMinutes, obligationId: obligation.id, amount: obligation.amount },
    });
    return { session: this.sessionView(session), obligation: obligationSummary(obligation) };
  }

  extendSession(user: User, id: string, minutes: number) {
    const s = this.getSession(id);
    authorize(user, 'parking:session.create', { taxpayerId: s.payerTaxpayerId });
    const z = this.getZone(s.zoneId);
    const d = this.sessionDerived(s, this.now());
    if (d.status !== 'ACTIVE') throw unprocessable('SESSION_NOT_ACTIVE', `Prolongation impossible : session au statut ${d.status}.`);
    if (d.pendingSegments > 0) throw conflict('EXTENSION_PENDING', 'Une prolongation attend déjà son paiement.');
    this.checkDuration(minutes, z, s.segments.reduce((a, g) => a + g.minutes, 0));
    const obligation = this.liquidate(this.engine, z, s.payerTaxpayerId, s.objectId, minutes, 1);
    const updated = this.sessions.update({
      ...s,
      segments: [...s.segments, { obligationId: obligation.id, minutes, kind: 'PROLONGATION', requestedAt: this.now().toISOString(), requestedBy: user.id }],
    });
    // Le rappel est de nouveau dû après la prolongation.
    if (updated.reminderSentAt) {
      const { reminderSentAt: _r, ...rest } = updated;
      this.sessions.update(rest);
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.session.extension_requested', resourceType: 'parking_session', resourceId: s.id, details: { minutes, obligationId: obligation.id } });
    return { session: this.sessionView(this.getSession(id)), obligation: obligationSummary(obligation) };
  }

  /** Fin anticipée par l'usager : libère la place (indicateurs). Aucun remboursement automatique (règle de l'acte). */
  endSession(user: User, id: string) {
    const s = this.getSession(id);
    authorize(user, 'parking:session.create', { taxpayerId: s.payerTaxpayerId });
    const d = this.sessionDerived(s, this.now());
    if (d.status !== 'ACTIVE' && d.status !== 'EN_ATTENTE_PAIEMENT') throw unprocessable('SESSION_NOT_RUNNING', `Session au statut ${d.status}.`);
    const updated = this.sessions.update({ ...s, endedAt: this.now().toISOString(), endedBy: user.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.session.ended', resourceType: 'parking_session', resourceId: s.id, details: { statusBefore: d.status } });
    return this.sessionView(updated);
  }

  getSession(id: string): ParkingSession {
    const s = this.sessions.get(id);
    if (!s) throw notFound('PARKING_SESSION_NOT_FOUND', `Session inconnue : ${id}`);
    return s;
  }

  readSession(user: User, id: string) {
    const s = this.getSession(id);
    authorize(user, 'parking:session.read', { taxpayerId: s.payerTaxpayerId, entity: DGTK });
    return this.sessionView(s);
  }

  mySessions(user: User) {
    const taxpayerId = this.selfTaxpayer(user);
    authorize(user, 'parking:session.read', { taxpayerId });
    this.tick();
    return this.sessions.find((s) => s.payerTaxpayerId === taxpayerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => this.sessionView(s));
  }

  /** État dérivé d'une session à partir des paiements confirmés du circuit commun (heure du serveur). */
  sessionDerived(s: ParkingSession, now: Date) {
    const pays: (PaymentState & { minutes: number; kind: string; obligationId: string })[] = s.segments.map((g) => ({
      ...paymentState(this.ctx, g.obligationId), minutes: g.minutes, kind: g.kind, obligationId: g.obligationId,
    }));
    const first = pays[0]!;
    const paidInitial = first.state === 'PAYE' || first.state === 'RAPPROCHE';
    let startAt: Date | null = null;
    let paidUntil: Date | null = null;
    let pendingSegments = 0;
    if (paidInitial) {
      startAt = new Date(first.confirmedAt ?? s.createdAt);
      let minutes = 0;
      for (const p of pays) {
        if (p.state === 'PAYE' || p.state === 'RAPPROCHE') minutes += p.minutes;
        else pendingSegments += 1;
      }
      paidUntil = new Date(startAt.getTime() + minutes * MINUTE);
    } else {
      pendingSegments = pays.length;
    }
    let status: SessionStatus;
    if (s.endedAt) status = 'TERMINEE';
    else if (!paidInitial) status = now.getTime() - new Date(s.createdAt).getTime() > UNPAID_ABANDON_MS ? 'ABANDONNEE' : 'EN_ATTENTE_PAIEMENT';
    else status = paidUntil! > now ? 'ACTIVE' : 'EXPIREE';
    let light: Light = 'ROUGE';
    // Feu de CONTRÔLE (VERT/AMBRE = titre valable, ROUGE = aucun titre) ; la couleur d'affichage suit la règle 50 % / 1 %
    // (`validity.band`) : une place encore payée à moins de 1 % s'affiche rouge, mais reste valable au contrôle.
    if (status === 'ACTIVE') light = readValidity(startAt, paidUntil, now).band === 'VERT' ? 'VERT' : 'AMBRE';
    return { status, light, startAt, paidUntil, pendingSegments, payments: pays };
  }

  sessionView(s: ParkingSession) {
    const now = this.now();
    const d = this.sessionDerived(s, now);
    const z = this.zones.get(s.zoneId);
    const amounts = s.segments.map((g) => this.ctx.assessment.get(g.obligationId).amount);
    return {
      id: s.id,
      zone: z ? { id: z.id, code: z.code, name: z.name, commune: z.commune, demo: z.demo } : null,
      plate: s.plate,
      status: d.status,
      light: d.light,
      startAt: d.startAt?.toISOString() ?? null,
      paidUntil: d.paidUntil?.toISOString() ?? null,
      ticketCode: s.ticketCode ?? null,
      validity: d.startAt && d.paidUntil ? validityView(d.startAt.toISOString(), d.paidUntil.toISOString(), now) : null,
      remainingMinutes: d.paidUntil && d.status === 'ACTIVE' ? Math.max(0, Math.round((d.paidUntil.getTime() - now.getTime()) / MINUTE)) : 0,
      totalMinutes: s.segments.reduce((a, g) => a + g.minutes, 0),
      total: sumByCurrency(amounts),
      segments: s.segments.map((g, i) => ({
        kind: g.kind, minutes: g.minutes, obligationId: g.obligationId, amount: amounts[i], requestedAt: g.requestedAt,
        payment: d.payments[i]!.state, paymentReference: d.payments[i]!.paymentReference ?? null,
      })),
      pendingPayment: d.pendingSegments > 0 ? s.segments.find((_, i) => !['PAYE', 'RAPPROCHE'].includes(d.payments[i]!.state))?.obligationId ?? null : null,
      reminderSentAt: s.reminderSentAt ?? null,
      createdAt: s.createdAt,
      endedAt: s.endedAt ?? null,
    };
  }

  /** Rappels « ambre » avant expiration et expirations : tâche idempotente (déclenchée à la lecture ou par la régie). */
  tick(): { reminders: number } {
    const now = this.now();
    let reminders = 0;
    for (const s of this.sessions.all()) {
      if (s.reminderSentAt) continue;
      const d = this.sessionDerived(s, now);
      if (d.status === 'ACTIVE' && d.light === 'AMBRE') {
        this.sessions.update({ ...s, reminderSentAt: now.toISOString() });
        const tp = this.ctx.taxpayers.get(s.payerTaxpayerId);
        this.ctx.comms.publish('ticket.expiring', [taxpayerRecipient(tp)], { reference: s.plate }, { entity: DGTK });
        this.ctx.audit.append({
          actor: { kind: 'system', id: 'parking-rappels' }, action: 'parking.session.reminder_sent', resourceType: 'parking_session', resourceId: s.id,
          details: { paidUntil: d.paidUntil?.toISOString() },
        });
        reminders += 1;
      }
    }
    return { reminders };
  }

  runReminders(user: User) {
    authorize(user, 'parking:reminders.run', { entity: DGTK });
    return this.tick();
  }

  // ---------------------------------------------------------------- Réservations de voirie

  private reservedPlaces(zoneId: string, from: Date, to: Date, exceptId?: string): number {
    return this.reservations
      .find((r) => r.zoneId === zoneId && r.status === 'APPROUVEE' && r.id !== exceptId)
      .filter((r) => new Date(r.startAt) < to && new Date(r.endAt) > from || (from.getTime() === to.getTime() && new Date(r.startAt) <= from && new Date(r.endAt) > from))
      .reduce((a, r) => a + r.places, 0);
  }

  requestReservation(user: User, input: { zoneId: string; purpose: RoadReservation['purpose']; places: number; startAt: string; endAt: string; plate?: string; notes?: string }) {
    const taxpayerId = this.selfTaxpayer(user);
    authorize(user, 'parking:reservation.request', { taxpayerId });
    const z = this.getZone(input.zoneId);
    this.openZoneRule(z);
    const start = new Date(input.startAt);
    const end = new Date(input.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw badRequest('INVALID_PERIOD', 'Période invalide.');
    if (start <= this.now()) throw badRequest('RESERVATION_IN_PAST', 'Une réservation se demande à l’avance.');
    const minutes = Math.round((end.getTime() - start.getTime()) / MINUTE);
    if (minutes % 15 !== 0 || minutes > 7 * 24 * 60) throw badRequest('INVALID_DURATION', 'Durée : multiple de 15 minutes, 7 jours au plus.');
    if (input.places < 1 || input.places > z.capacity.standard) throw badRequest('INVALID_PLACES', `Nombre de places : 1 à ${z.capacity.standard}.`);
    const r = this.reservations.insert({
      id: this.ids.next('PKR'), reference: this.ids.next(`RSV-PK-${this.now().getUTCFullYear()}`), ticketCode: newTicketCode(), zoneId: z.id, commune: z.commune, taxpayerId,
      requestedBy: user.id, requestedAt: this.now().toISOString(), purpose: input.purpose, places: input.places,
      startAt: start.toISOString(), endAt: end.toISOString(), plate: input.plate ? this.plate(input.plate) : null, notes: input.notes ?? '', status: 'DEMANDEE',
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.reservation.requested', resourceType: 'road_reservation', resourceId: r.id, details: { zoneId: z.id, places: r.places, purpose: r.purpose } });
    this.ctx.comms.publish('permit.application.received', [taxpayerRecipient(this.ctx.taxpayers.get(taxpayerId))], { reference: r.reference }, { entity: DGTK });
    return this.reservationView(r);
  }

  /** Décision humaine motivée ; l'approbation liquide la redevance sur la règle ACTIVE (au nom du décideur). */
  decideReservation(user: User, id: string, input: { approve: boolean; reason: string }) {
    const r = this.reservations.get(id);
    if (!r) throw notFound('RESERVATION_NOT_FOUND', `Réservation inconnue : ${id}`);
    authorize(user, 'parking:reservation.decide', { entity: DGTK });
    if (r.status !== 'DEMANDEE') throw conflict('RESERVATION_ALREADY_DECIDED', `Réservation déjà traitée (${r.status}).`);
    const z = this.getZone(r.zoneId);
    const now = this.now().toISOString();
    let updated: RoadReservation;
    if (input.approve) {
      const start = new Date(r.startAt);
      const end = new Date(r.endAt);
      const used = this.reservedPlaces(z.id, start, end, r.id);
      // Aucune surréservation : la capacité publiée est une borne stricte (ARB-14).
      if (!OVERBOOKING_ENABLED && used + r.places > z.capacity.standard) {
        throw conflict('CAPACITY_EXCEEDED', `Capacité de la zone dépassée sur la période (${used} place(s) déjà réservée(s) sur ${z.capacity.standard}). Surréservation désactivée.`);
      }
      const objectId = this.occupationObject(r.taxpayerId, z);
      const minutes = Math.round((end.getTime() - start.getTime()) / MINUTE);
      const obligation = this.liquidate(user, z, r.taxpayerId, objectId, minutes, r.places);
      updated = this.reservations.update({ ...r, status: 'APPROUVEE', decision: { by: user.id, at: now, reason: input.reason }, obligationId: obligation.id, objectId });
      this.ctx.comms.publish('permit.issued', [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference: r.reference }, { entity: DGTK });
    } else {
      updated = this.reservations.update({ ...r, status: 'REFUSEE', decision: { by: user.id, at: now, reason: input.reason } });
      this.ctx.comms.publish('permit.refused', [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference: r.reference }, { entity: DGTK });
    }
    this.ctx.audit.append({
      actor: actorOf(user), action: input.approve ? 'parking.reservation.approved' : 'parking.reservation.refused', resourceType: 'road_reservation', resourceId: r.id,
      details: { reason: input.reason, obligationId: updated.obligationId ?? null },
    });
    return this.reservationView(updated);
  }

  /**
   * Ticket de stationnement (session ou réservation) retrouvé par son code aléatoire — vérification publique minimale :
   * zone, commune, fenêtre payée, jamais le nom du payeur ni le montant ; la plaque est rendue au résolveur, qui la masque.
   */
  ticketByCode(code: string): { kind: 'SESSION' | 'RESERVATION'; zone: string; commune: string; plate: string | null; validFrom: string | null; validUntil: string | null; state: 'ACTIVE' | 'EXPIREE' | 'EN_ATTENTE' | 'TERMINEE' | 'ANNULEE' } | null {
    const c = code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
    const s = this.sessions.findOne((x) => x.ticketCode === c);
    if (s) {
      const d = this.sessionDerived(s, this.now());
      const z = this.zones.get(s.zoneId);
      const state = d.status === 'ACTIVE' ? 'ACTIVE' : d.status === 'EXPIREE' ? 'EXPIREE' : d.status === 'TERMINEE' ? 'TERMINEE' : d.status === 'ABANDONNEE' ? 'ANNULEE' : 'EN_ATTENTE';
      return { kind: 'SESSION', zone: z?.name ?? s.zoneId, commune: s.commune, plate: s.plate, validFrom: d.startAt?.toISOString() ?? null, validUntil: d.paidUntil?.toISOString() ?? null, state };
    }
    const r = this.reservations.findOne((x) => x.ticketCode === c);
    if (r) {
      const v = this.reservationView(r);
      const z = this.zones.get(r.zoneId);
      const state = v.state === 'CONFIRMEE' ? 'ACTIVE' : v.state === 'TERMINEE' ? 'TERMINEE' : v.state === 'REFUSEE' || v.state === 'ANNULEE' ? 'ANNULEE' : 'EN_ATTENTE';
      return { kind: 'RESERVATION', zone: z?.name ?? r.zoneId, commune: r.commune, plate: r.plate, validFrom: r.startAt, validUntil: r.endAt, state };
    }
    return null;
  }

  reservationView(r: RoadReservation) {
    const pay = paymentState(this.ctx, r.obligationId);
    const z = this.zones.get(r.zoneId);
    const now = this.now();
    let state: string = r.status;
    if (r.status === 'APPROUVEE') state = pay.state === 'PAYE' || pay.state === 'RAPPROCHE' ? (new Date(r.endAt) < now ? 'TERMINEE' : 'CONFIRMEE') : 'EN_ATTENTE_PAIEMENT';
    return {
      ...r,
      zone: z ? { id: z.id, code: z.code, name: z.name } : null,
      state,
      payment: pay.state,
      amount: r.obligationId ? this.ctx.assessment.get(r.obligationId).amount : null,
    };
  }

  myReservations(user: User) {
    const taxpayerId = this.selfTaxpayer(user);
    authorize(user, 'parking:reservation.request', { taxpayerId });
    return this.reservations.find((r) => r.taxpayerId === taxpayerId).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map((r) => this.reservationView(r));
  }

  listReservations(user: User) {
    authorize(user, 'parking:reservation.decide', { entity: DGTK });
    return this.reservations.all().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map((r) => this.reservationView(r));
  }

  // ---------------------------------------------------------------- Contrôle par plaque

  /** Titre valide d'une plaque (session payée ou réservation confirmée) — heure du serveur. */
  private titleFor(plate: string, zoneId: string | null, now: Date): { light: Light; title: ControlCheck['title']; validFrom: string | null; validUntil: string | null; zoneId: string | null } {
    let best: { light: Light; title: ControlCheck['title']; validFrom: string | null; validUntil: string | null; zoneId: string | null } = { light: 'ROUGE', title: null, validFrom: null, validUntil: null, zoneId };
    for (const s of this.sessions.find((x) => x.plate === plate && (!zoneId || x.zoneId === zoneId))) {
      const d = this.sessionDerived(s, now);
      if (d.status !== 'ACTIVE') continue;
      if (best.light === 'ROUGE' || (best.light === 'AMBRE' && d.light === 'VERT')) {
        best = { light: d.light, title: 'SESSION', validFrom: d.startAt!.toISOString(), validUntil: d.paidUntil!.toISOString(), zoneId: s.zoneId };
      }
    }
    if (best.light !== 'VERT') {
      for (const r of this.reservations.find((x) => x.plate === plate && x.status === 'APPROUVEE' && (!zoneId || x.zoneId === zoneId))) {
        const pay = paymentState(this.ctx, r.obligationId);
        if ((pay.state === 'PAYE' || pay.state === 'RAPPROCHE') && new Date(r.startAt) <= now && new Date(r.endAt) > now) {
          best = { light: 'VERT', title: 'RESERVATION', validFrom: r.startAt, validUntil: r.endAt, zoneId: r.zoneId };
        }
      }
    }
    return best;
  }

  /** Contrôle par plaque (terminal de l'agent) : résultat MINIMAL, jamais de nom ni d'adresse ; journalisé. */
  control(user: User, plateRaw: string, zoneId?: string) {
    const z = zoneId ? this.getZone(zoneId) : null;
    authorize(user, 'parking:control', { communes: z ? [z.commune] : user.territory ?? [] });
    const plate = this.plate(plateRaw);
    const now = this.now();
    const t = this.titleFor(plate, z?.id ?? null, now);
    const check = this.checks.append({
      id: this.ids.next('CHK'), plate, zoneId: z?.id ?? null, commune: z?.commune ?? null, light: t.light, title: t.title, agentId: user.id, at: now.toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.control.checked', resourceType: 'plate', resourceId: plate, details: { zoneId: z?.id ?? null, light: t.light, checkId: check.id } });
    const guidance: Record<Light, string> = {
      VERT: 'Titre valide : aucune action.',
      AMBRE: 'Titre bientôt expiré : rappel envoyé à l’usager, prolongation possible à distance. Aucune action.',
      ROUGE: 'Aucun titre valide : l’usager peut régulariser immédiatement ; un constat photographique peut être établi par l’agent habilité. Aucune sanction automatique.',
    };
    return {
      checkId: check.id, plate, zone: z ? { id: z.id, code: z.code, name: z.name } : null, light: t.light, title: t.title,
      validFrom: t.validFrom, validUntil: t.validUntil, validity: t.validUntil ? validityView(t.validFrom, t.validUntil, now) : null, checkedAt: check.at, guidance: guidance[t.light],
    };
  }

  // ---------------------------------------------------------------- Constats (circuit RW1)

  recordViolation(user: User, input: {
    zoneId: string; plate: string; nature: ParkingViolation['nature']; checkId?: string; photoSha256: string[];
    lat: number; lon: number; gpsAccuracyM?: number; deviceId?: string; observations: string;
  }) {
    const z = this.getZone(input.zoneId);
    authorize(user, 'parking:violation.record', { communes: [z.commune] });
    const plate = this.plate(input.plate);
    if (input.photoSha256.length === 0) throw badRequest('PHOTO_REQUIRED', 'Constat photographique : au moins une photographie (empreinte SHA-256) est exigée.');
    let lightAtCheck: Light | null = null;
    if (input.checkId) {
      const c = this.checks.get(input.checkId);
      if (!c || c.plate !== plate) throw unprocessable('CHECK_MISMATCH', 'Le contrôle cité ne porte pas sur cette plaque.');
      lightAtCheck = c.light;
    }
    const now = this.now();
    const current = this.titleFor(plate, z.id, now);
    if ((input.nature === 'NON_PAIEMENT' || input.nature === 'DEPASSEMENT') && current.light !== 'ROUGE') {
      throw unprocessable('VALID_TITLE_EXISTS', 'Un titre valide existe pour cette plaque dans la zone : constat de non-paiement impossible.');
    }
    const id = this.ids.next('PKV');
    const ev = this.evidence.append({
      id: this.ids.next('PKE'), violationId: id, photoSha256: input.photoSha256, lat: input.lat, lon: input.lon,
      gpsAccuracyM: input.gpsAccuracyM ?? null, observedAt: now.toISOString(), deviceId: input.deviceId ?? null, agentId: user.id, observations: input.observations,
    });
    const holder = this.vehicles.findOne((v) => v.plate === plate);
    const v = this.violations.insert({
      id, reference: this.ids.next(`CST-PK-${now.getUTCFullYear()}`), zoneId: z.id, commune: z.commune, plate, nature: input.nature,
      lightAtCheck, checkId: input.checkId ?? null, evidenceId: ev.id, agentId: user.id, createdAt: now.toISOString(),
      holderTaxpayerId: holder?.taxpayerId ?? null, status: 'CONSTATE', contests: [],
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'parking.violation.recorded', resourceType: 'parking_violation', resourceId: v.id,
      details: { plate, zoneId: z.id, nature: v.nature, evidenceId: ev.id, photos: input.photoSha256.length, holderIdentified: holder !== undefined },
    });
    // Notification de l'usager identifié (SMS / application) : constat, sans montant tant qu'aucune décision.
    if (holder) this.ctx.comms.publish('parking.violation.recorded', [taxpayerRecipient(this.ctx.taxpayers.get(holder.taxpayerId))], { reference: v.reference }, { entity: DGTK });
    return this.violationView(v);
  }

  private getViolation(id: string): ParkingViolation {
    const v = this.violations.get(id) ?? this.violations.findOne((x) => x.reference === id);
    if (!v) throw notFound('PARKING_VIOLATION_NOT_FOUND', `Constat inconnu : ${id}`);
    return v;
  }

  /** Proposition préparée par le système selon le barème ACTIF de la zone (jamais une décision). */
  private prepareProposal(z: ParkingZone): NonNullable<ParkingViolation['proposal']> {
    const rule = activeRule(this.ctx, z.penaltyRuleCode);
    const at = this.now().toISOString();
    if (!rule) {
      return { status: 'ACTE_REQUIS', ruleCode: z.penaltyRuleCode, ruleVersion: null, amount: null, basis: 'Barème des pénalités non publié (acte requis) : aucune pénalité ne peut être proposée.', preparedAt: at };
    }
    const ev = this.ctx.rules.evaluate(rule, {}, z.localityRank);
    const amount = Money.of(ev.value, rule.currency, rule.rounding).toJSON();
    return {
      status: 'PROPOSEE', ruleCode: rule.code, ruleVersion: rule.version, amount,
      basis: `${rule.label} — ${rule.formula} (rang ${z.localityRank})${rule.demo ? ' [règle fictive de démonstration]' : ''}`, preparedAt: at,
    };
  }

  verifyViolation(user: User, id: string, input: { confirm: boolean; note: string }) {
    const v = this.getViolation(id);
    authorize(user, 'parking:violation.verify', { communes: [v.commune] });
    if (v.status !== 'CONSTATE') throw conflict('VIOLATION_NOT_PENDING_VERIFICATION', `Constat au statut ${v.status}.`);
    assertDistinctPerson(user.id, [v.agentId], 'Le vérificateur doit être distinct de l’agent auteur du constat.');
    const z = this.getZone(v.zoneId);
    const at = this.now().toISOString();
    const updated = this.violations.update({
      ...v,
      status: input.confirm ? 'VERIFIE' : 'REJETE',
      verification: { by: user.id, at, outcome: input.confirm ? 'CONFIRME' : 'REJETE', note: input.note },
      ...(input.confirm ? { proposal: this.prepareProposal(z) } : {}),
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: input.confirm ? 'parking.violation.verified' : 'parking.violation.rejected', resourceType: 'parking_violation', resourceId: v.id,
      details: { note: input.note, proposal: updated.proposal ?? null },
    });
    if (!input.confirm) this.ctx.comms.publish('inspection.qa.rejected', [userRecipient(this.ctx.users.get(v.agentId) ?? { kind: 'user', id: v.agentId, name: v.agentId, roles: [], entity: DGTK })], { reference: v.reference }, { entity: DGTK });
    return this.violationView(updated);
  }

  /**
   * Décision motivée d'une personne habilitée, distincte de l'agent et du vérificateur.
   * RETENUE : si l'usager est identifié et le barème ACTIF, l'obligation de pénalité est liquidée AU NOM DU DÉCIDEUR ;
   * sinon la décision est tracée sans montant. Aucune mesure de blocage ni de fourrière n'existe dans ce module.
   */
  decideViolation(user: User, id: string, input: { outcome: 'RETENUE' | 'CLASSEE'; reason: string }) {
    const v = this.getViolation(id);
    authorize(user, 'parking:violation.decide', { entity: DGTK });
    if (v.status !== 'VERIFIE') throw conflict('VIOLATION_NOT_VERIFIED', `Décision impossible : constat au statut ${v.status} (vérification préalable requise).`);
    assertDistinctPerson(user.id, [v.agentId, v.verification!.by], 'Constat, vérification et décision : trois personnes distinctes sont exigées.');
    const z = this.getZone(v.zoneId);
    let obligationId: string | null = null;
    let effect = 'Constat classé : aucune suite.';
    if (input.outcome === 'RETENUE') {
      const proposal = v.proposal ?? this.prepareProposal(z);
      const rule = activeRule(this.ctx, z.penaltyRuleCode);
      if (proposal.status !== 'PROPOSEE' || !rule) {
        effect = 'Constat retenu sans pénalité : barème non publié (acte requis).';
      } else if (!v.holderTaxpayerId) {
        effect = 'Constat retenu ; redevable non identifié (plaque non rattachée à un compte) : aucune obligation émise.';
      } else {
        const objectId = this.occupationObject(v.holderTaxpayerId, z);
        const { obligation } = this.ctx.assessment.calculate(user, { ruleId: rule.id, taxpayerId: v.holderTaxpayerId, objectId, inputs: {}, simulate: false });
        obligationId = obligation!.id;
        effect = `Pénalité émise selon le barème (${rule.code} v${rule.version}) : obligation ${obligationId}, contestable.`;
      }
    }
    const updated = this.violations.update({
      ...v, status: input.outcome === 'RETENUE' ? 'RETENU' : 'CLASSE',
      decision: { by: user.id, at: this.now().toISOString(), outcome: input.outcome, reason: input.reason, obligationId, effect },
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: input.outcome === 'RETENUE' ? 'parking.violation.decided_retained' : 'parking.violation.decided_dismissed',
      resourceType: 'parking_violation', resourceId: v.id, details: { reason: input.reason, obligationId, effect },
    });
    if (v.holderTaxpayerId) {
      this.ctx.comms.publish('inspection.report.issued', [taxpayerRecipient(this.ctx.taxpayers.get(v.holderTaxpayerId))], { reference: v.reference }, { entity: DGTK });
    }
    return this.violationView(updated);
  }

  /** Contestation par l'usager : observations avant décision ; après décision, recours par le circuit commun des réclamations. */
  contestViolation(user: User, id: string, grounds: string) {
    const v = this.getViolation(id);
    if (!v.holderTaxpayerId) throw forbidden('NOT_VIOLATION_HOLDER', 'Seul le titulaire déclaré de la plaque peut contester ce constat.');
    authorize(user, 'parking:violation.contest', { taxpayerId: v.holderTaxpayerId });
    if (v.status === 'REJETE' || v.status === 'CLASSE') throw conflict('VIOLATION_CLOSED', 'Constat déjà écarté ou classé : aucune contestation nécessaire.');
    const at = this.now().toISOString();
    let appealId: string | undefined;
    const stage: ViolationContest['stage'] = v.status === 'RETENU' ? 'APRES_DECISION' : 'AVANT_DECISION';
    if (stage === 'APRES_DECISION') {
      if (!v.decision?.obligationId) throw unprocessable('NOTHING_TO_APPEAL', 'Aucune obligation émise : aucun recours financier n’est nécessaire.');
      appealId = this.ctx.appeals.submit(user, { obligationId: v.decision.obligationId, grounds }).id;
    }
    const contest: ViolationContest = { id: this.ids.next('PKC'), by: user.id, taxpayerId: v.holderTaxpayerId, at, grounds, stage, ...(appealId ? { appealId } : {}) };
    const updated = this.violations.update({ ...v, contests: [...v.contests, contest] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.violation.contested', resourceType: 'parking_violation', resourceId: v.id, details: { stage, appealId: appealId ?? null } });
    return this.violationView(updated);
  }

  violationView(v: ParkingViolation) {
    const ev = this.evidence.get(v.evidenceId);
    const z = this.zones.get(v.zoneId);
    const ob = v.decision?.obligationId ? this.ctx.assessment.get(v.decision.obligationId) : null;
    return {
      ...v,
      zone: z ? { id: z.id, code: z.code, name: z.name } : null,
      evidence: ev ?? null,
      obligation: ob ? { ...obligationSummary(ob), payment: paymentState(this.ctx, ob.id).state } : null,
      holderIdentified: v.holderTaxpayerId !== null,
    };
  }

  /** Lecture d'un constat : agents habilités (périmètre), ou titulaire de la plaque. */
  readViolation(user: User, id: string) {
    const v = this.getViolation(id);
    authorize(user, 'parking:violation.read', { taxpayerId: v.holderTaxpayerId ?? undefined, communes: [v.commune], entity: DGTK });
    return this.violationView(v);
  }

  listViolations(user: User, status?: string) {
    if (!hasAnyGrant(user, 'parking:violation.read') || user.roles.every((r) => r === 'R30' || r === 'R31')) {
      throw forbidden('FORBIDDEN', 'Liste des constats réservée aux agents habilités (usager : « mes constats »).');
    }
    return this.violations
      .all()
      .filter((v) => (!status || v.status === status) && evaluate(user, 'parking:violation.read', { communes: [v.commune], entity: DGTK }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((v) => this.violationView(v));
  }

  myViolations(user: User) {
    const taxpayerId = this.selfTaxpayer(user);
    authorize(user, 'parking:violation.contest', { taxpayerId });
    return this.violations.find((v) => v.holderTaxpayerId === taxpayerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((v) => this.violationView(v));
  }

  // ---------------------------------------------------------------- Parkings privés et marchands partenaires

  createPartner(user: User, input: { name: string; kind: ParkingPartner['kind']; commune: string; quartier: string; lat: number; lon: number; capacity: number; operatorTaxpayerId?: string }, opts: { demo?: boolean } = {}) {
    authorize(user, 'parking:partner.manage', { entity: DGTK });
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    if (input.operatorTaxpayerId) this.ctx.taxpayers.get(input.operatorTaxpayerId);
    const now = this.now().toISOString();
    const p = this.partners.insert({
      id: this.ids.next('PKP', 4), name: input.name, kind: input.kind, commune: input.commune, quartier: input.quartier, lat: input.lat, lon: input.lon,
      capacity: input.capacity, operatorTaxpayerId: input.operatorTaxpayerId ?? null, status: 'CONVENTION_EN_COURS',
      statusHistory: [{ status: 'CONVENTION_EN_COURS', reason: 'Inscription', by: user.id, at: now }], demo: opts.demo === true, createdBy: user.id, createdAt: now,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.partner.registered', resourceType: 'parking_partner', resourceId: p.id, details: { kind: p.kind, commune: p.commune } });
    return p;
  }

  setPartnerStatus(user: User, id: string, input: { status: ParkingPartner['status']; reason: string }) {
    const p = this.partners.get(id);
    if (!p) throw notFound('PARTNER_NOT_FOUND', `Partenaire inconnu : ${id}`);
    authorize(user, 'parking:partner.manage', { entity: DGTK });
    const updated = this.partners.update({ ...p, status: input.status, statusHistory: [...p.statusHistory, { status: input.status, reason: input.reason, by: user.id, at: this.now().toISOString() }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.partner.status_changed', resourceType: 'parking_partner', resourceId: p.id, details: { status: input.status, reason: input.reason } });
    return updated;
  }

  /** Places libres déclarées par l'exploitant (donnée déclarative, affichée comme telle). */
  declarePartnerOccupancy(user: User, id: string, freePlaces: number) {
    const p = this.partners.get(id);
    if (!p) throw notFound('PARTNER_NOT_FOUND', `Partenaire inconnu : ${id}`);
    authorize(user, 'parking:partner.declare', { taxpayerId: p.operatorTaxpayerId ?? undefined, entity: DGTK });
    if (freePlaces < 0 || freePlaces > p.capacity) throw badRequest('INVALID_FREE_PLACES', `Places libres : 0 à ${p.capacity}.`);
    const updated = this.partners.update({ ...p, declaredFree: { places: freePlaces, at: this.now().toISOString(), by: user.id } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.partner.occupancy_declared', resourceType: 'parking_partner', resourceId: p.id, details: { freePlaces } });
    return updated;
  }

  listPartners() {
    return this.partners.all().map(({ operatorTaxpayerId, statusHistory, ...p }) => ({ ...p, hasOperatorAccount: operatorTaxpayerId !== null, lastStatus: statusHistory.at(-1) ?? null }));
  }

  myPartners(user: User) {
    const taxpayerId = this.selfTaxpayer(user);
    return this.partners.find((p) => p.operatorTaxpayerId === taxpayerId);
  }

  // ---------------------------------------------------------------- Indicateurs (agrégats seulement)

  /** Obligations du module rattachées à une zone (sessions, réservations, pénalités). */
  private zoneObligations(zoneId: string): { kind: 'SESSION' | 'RESERVATION' | 'PENALITE'; obligationId: string }[] {
    const out: { kind: 'SESSION' | 'RESERVATION' | 'PENALITE'; obligationId: string }[] = [];
    for (const s of this.sessions.find((x) => x.zoneId === zoneId)) for (const g of s.segments) out.push({ kind: 'SESSION', obligationId: g.obligationId });
    for (const r of this.reservations.find((x) => x.zoneId === zoneId && x.obligationId !== undefined)) out.push({ kind: 'RESERVATION', obligationId: r.obligationId! });
    for (const v of this.violations.find((x) => x.zoneId === zoneId && !!x.decision?.obligationId)) out.push({ kind: 'PENALITE', obligationId: v.decision!.obligationId! });
    return out;
  }

  indicators(user: User) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    this.tick();
    const now = this.now();
    const today = isoDate(now);
    const zoneRows = this.zones.all().sort((a, b) => a.code.localeCompare(b.code)).map((z) => {
      const view = this.zoneView(z);
      const sessions = this.sessions.find((s) => s.zoneId === z.id);
      const paidToday = sessions.filter((s) => {
        const d = this.sessionDerived(s, now);
        return d.startAt !== null && isoDate(d.startAt) === today;
      }).length;
      const obligations = this.zoneObligations(z.id);
      const paid: MoneyJSON[] = [];
      const reconciled: MoneyJSON[] = [];
      const byKind: Record<string, MoneyJSON[]> = { SESSION: [], RESERVATION: [], PENALITE: [] };
      for (const o of obligations) {
        const p = paymentState(this.ctx, o.obligationId);
        if (p.state === 'PAYE' || p.state === 'RAPPROCHE') {
          paid.push(p.amount!);
          byKind[o.kind]!.push(p.amount!);
          if (p.state === 'RAPPROCHE') reconciled.push(p.amount!);
        }
      }
      const checks = this.checks.find((c) => c.zoneId === z.id);
      const compliant = checks.filter((c) => c.light !== 'ROUGE').length;
      const violations = this.violations.find((v) => v.zoneId === z.id);
      const cap = z.capacity.standard;
      const occupied = view.occupancy.active + view.occupancy.reserved;
      const freeRate = cap > 0 ? pct(cap - occupied, cap) : null;
      const freeNum = freeRate === null ? null : Number.parseFloat(freeRate);
      return {
        zoneId: z.id, code: z.code, name: z.name, commune: z.commune, kind: z.kind, legalStatus: view.legalStatus, demo: z.demo,
        capacity: cap, linearMeters: z.linearMeters,
        activeSessions: view.occupancy.active, reservedPlaces: view.occupancy.reserved,
        occupancyRate: view.occupancy.rate, freeRate,
        /** Cible du dossier source : 15 à 25 % de places libres (objectif de pilotage, jamais une sanction). */
        freeTarget: freeNum === null ? 'SANS_OBJET' : freeNum < 15 ? 'SATURE' : freeNum > 25 ? 'SOUS_UTILISE' : 'DANS_LA_CIBLE',
        paidSessionsToday: paidToday,
        rotation: cap > 0 ? (Math.round((paidToday * 100) / cap) / 100).toFixed(2) : null,
        revenue: sumByCurrency(paid),
        revenueReconciled: sumByCurrency(reconciled),
        revenueByKind: { SESSION: sumByCurrency(byKind.SESSION!), RESERVATION: sumByCurrency(byKind.RESERVATION!), PENALITE: sumByCurrency(byKind.PENALITE!) },
        revenuePerPlace: cap > 0 ? perUnit(sumByCurrency(paid), String(cap)) : [],
        revenuePerLinearMeter: z.linearMeters ? perUnit(sumByCurrency(paid), String(z.linearMeters)) : [],
        checks: checks.length, complianceRate: pct(compliant, checks.length),
        violations: { total: violations.length, pending: violations.filter((v) => v.status === 'CONSTATE' || v.status === 'VERIFIE').length, retained: violations.filter((v) => v.status === 'RETENU').length, contested: violations.filter((v) => v.contests.length > 0).length },
      };
    });
    // Priorisation des patrouilles : SEULE utilisation autorisée d'un « score » (ARB-12) — jamais une sanction.
    const patrol = zoneRows
      .filter((r) => r.checks > 0)
      .map((r) => ({ zoneId: r.zoneId, code: r.code, name: r.name, nonCompliantShare: pct(r.checks - Math.round((Number.parseFloat(r.complianceRate ?? '0') * r.checks) / 100), r.checks), checks: r.checks }))
      .sort((a, b) => Number.parseFloat(b.nonCompliantShare ?? '0') - Number.parseFloat(a.nonCompliantShare ?? '0'));
    const communes = new Map<string, MoneyJSON[]>();
    for (const r of zoneRows) communes.set(r.commune, [...(communes.get(r.commune) ?? []), ...r.revenue]);
    const allChecks = this.checks.count();
    const allCompliant = this.checks.find((c) => c.light !== 'ROUGE').length;
    const cap = zoneRows.filter((r) => r.legalStatus !== 'ACTE_REQUIS').reduce((a, r) => a + r.capacity, 0);
    const occ = zoneRows.reduce((a, r) => a + r.activeSessions + r.reservedPlaces, 0);
    return {
      generatedAt: now.toISOString(),
      notice: 'Agrégats seulement (aucune donnée nominative). Recettes = paiements confirmés par le prestataire ; « rapproché » = arrivé sur le compte public. Les zones de démonstration reposent sur des règles fictives.',
      totals: {
        zones: zoneRows.length,
        openZones: zoneRows.filter((r) => r.legalStatus === 'OUVERTE').length,
        actRequiredZones: zoneRows.filter((r) => r.legalStatus === 'ACTE_REQUIS').length,
        capacityOpen: cap,
        activeSessions: zoneRows.reduce((a, r) => a + r.activeSessions, 0),
        occupancyRate: pct(occ, cap),
        paidSessionsToday: zoneRows.reduce((a, r) => a + r.paidSessionsToday, 0),
        revenue: sumByCurrency(zoneRows.flatMap((r) => r.revenue)),
        checks: allChecks,
        complianceRate: pct(allCompliant, allChecks),
        violationsPending: zoneRows.reduce((a, r) => a + r.violations.pending, 0),
        violationsContested: zoneRows.reduce((a, r) => a + r.violations.contested, 0),
        reservationsPending: this.reservations.find((r) => r.status === 'DEMANDEE').length,
        partners: this.partners.find((p) => p.status === 'PARTENAIRE').length,
      },
      zones: zoneRows,
      byCommune: [...communes.entries()].map(([commune, items]) => ({ commune, revenue: sumByCurrency(items) })).sort((a, b) => a.commune.localeCompare(b.commune)),
      patrolPriorities: patrol,
      safeguards: {
        overbookingEnabled: OVERBOOKING_ENABLED,
        automaticPenalty: false,
        automaticImpoundOrClamp: false,
        cashCollectionByAgents: false,
      },
    };
  }
}

export interface RuleSummary {
  code: string;
  version: number | null;
  status: string;
  label: string;
  demo: boolean;
  currency: string | null;
  rateTable: Record<string, string>;
  formula: string | null;
}

export function obligationSummary(o: { id: string; amount: MoneyJSON; dueDate: string; status: string; label: string; ruleCode: string; ruleVersion: number; attribution: { commune: string | null } }) {
  return { id: o.id, amount: o.amount, dueDate: o.dueDate, status: o.status, label: o.label, ruleCode: o.ruleCode, ruleVersion: o.ruleVersion, commune: o.attribution.commune };
}
