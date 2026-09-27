/**
 * ParkSmart — travail de terrain (décision du maître d'ouvrage du 27/09/2026) :
 *
 * 1. PREUVES PHOTOGRAPHIQUES : quand une plaque est ROUGE, la caméra géolocalisée s'ouvre ; l'agent prend jusqu'à
 *    5 photos des ABORDS du véhicule (devant, derrière, à droite, à gauche, une autre vue) — la preuve du lieu et des
 *    circonstances du stationnement, pas un gros plan de la plaque. Chaque photo porte, incrustés dans
 *    l'image : date et heure (horloge du serveur), agent, coordonnées GPS et lieu saisi par l'agent. Le serveur vérifie
 *    l'empreinte SHA-256, conserve l'image telle que reçue (jamais modifiable), et note l'écart d'horloge.
 * 2. PÉNALITÉS VISIBLES : tout agent du module stationnement voit les pénalités d'un usager au contrôle ; au-delà de
 *    30 jours sans paiement, tout agent de tout module les voit après un contrôle (registre « sanctions »).
 * 3. COMMISSION DES AGENTS : 10 % des recettes de pénalités et des paiements générés par leurs contrôles, calculés
 *    sur des recettes CONFIRMÉES au compte public, versés par le Trésor : un agent ne touche jamais l'argent de l'usager.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { Money } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { Obligation } from '../../modules/assessment/service.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import type { User } from '../../core/auth.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { actorOf, kinshasaMonth, ordersByObligation, paidOrders, paymentState, sumByCurrency, type PaidOrder } from './support.js';
import type { ControlCheck, ParkingService, ParkingViolation } from './service.js';

/**
 * Vues de preuve : les ABORDS du véhicule (où et comment il est stationné), pas la plaque — la plaque est déjà lue
 * au contrôle. Devant, derrière, à droite, à gauche, plus une vue libre (panneau, marquage au sol, contexte).
 */
export const EVIDENCE_SLOTS = ['ABORDS_AVANT', 'ABORDS_ARRIERE', 'ABORDS_DROITE', 'ABORDS_GAUCHE', 'AUTRE'] as const;
export type EvidenceSlot = (typeof EVIDENCE_SLOTS)[number];
export const SLOT_LABEL: Record<EvidenceSlot, string> = {
  ABORDS_AVANT: 'Abords — devant le véhicule', ABORDS_ARRIERE: 'Abords — derrière le véhicule', ABORDS_DROITE: 'Abords — côté droit',
  ABORDS_GAUCHE: 'Abords — côté gauche', AUTRE: 'Autre vue (panneau, marquage, contexte)',
};
export const MAX_PHOTOS_PER_CHECK = 5;
export const MAX_PHOTO_BYTES = 900_000;
/** Délai pour photographier après un contrôle rouge. */
export const PHOTO_WINDOW_MINUTES = 30;
/** Écart d'horloge toléré entre l'heure incrustée et l'heure de réception (au-delà : signalé au vérificateur). */
export const CLOCK_SKEW_WARN_SECONDS = 300;

/** Taux de commission des agents (décision du maître d'ouvrage) — acte requis avant tout versement réel. */
export const AGENT_COMMISSION_PCT = 10;
/** Un paiement de stationnement est attribué à l'agent si la session est créée dans ce délai après son contrôle rouge. */
export const PAYMENT_ATTRIBUTION_MINUTES = 60;
/**
 * Délai de grâce (paramètre à fixer par l'acte) : un paiement effectué dans ce délai après la PREMIÈRE observation
 * rouge de la plaque dans la zone est présumé spontané (l'usager paie en arrivant) et n'est attribué à aucun contrôle.
 */
export const PARKING_GRACE_MINUTES = 10;
/**
 * Présence attestée d'un contrôle ouvrant droit à commission (tous modules à contrôle localisé) : position GPS de
 * l'agent, précision au plus `PRESENCE_MAX_ACCURACY_M`, à au plus `PRESENCE_MAX_DISTANCE_M` de la zone ou de l'objet.
 * Un contrôle sans position reste valable (feu, constat) mais ne fonde aucune commission.
 */
export const PRESENCE_MAX_ACCURACY_M = 100;
export const PRESENCE_MAX_DISTANCE_M = 150;
/** Au-delà, une pénalité impayée devient visible des agents de tous les modules après un contrôle. */
export const OVERDUE_VISIBILITY_DAYS = 30;

export interface EvidencePhoto {
  id: string;
  checkId: string;
  plate: string;
  zoneId: string;
  commune: string;
  slot: EvidenceSlot;
  sha256: string;
  mime: 'image/jpeg';
  sizeBytes: number;
  dataBase64: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  gpsSource: 'GPS' | 'MANUEL' | 'ZONE';
  place: string;
  /** Heure incrustée dans l'image (horloge serveur synchronisée sur l'appareil). */
  stampedAt: string;
  receivedAt: string;
  clockSkewSeconds: number;
  agentId: string;
  agentName: string;
  violationId: string | null;
  supersededBy: string | null;
}

export type PhotoMeta = Omit<EvidencePhoto, 'dataBase64'> & {
  slotLabel: string; url: string; clockWarning: boolean;
  /** Distance au centre de la zone contrôlée (m) et signaux de position pour le vérificateur. */
  distanceFromZoneM: number | null; lowAccuracy: boolean; farFromZone: boolean;
};

/** Précision GPS au-delà de laquelle la position est signalée au vérificateur (m). */
export const GPS_WARN_ACCURACY_M = 30;
/** Distance au centre de la zone au-delà de laquelle la photo est signalée (m). */
export const ZONE_WARN_DISTANCE_M = 600;

/** Position imprécise : source autre que le GPS, précision inconnue ou au-delà du seuil. */
export function lowAccuracy(source: string | null | undefined, accuracyM: number | null | undefined): boolean {
  return source !== 'GPS' || (accuracyM ?? Infinity) > GPS_WARN_ACCURACY_M;
}

/** Distance géodésique (haversine), en mètres. */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000; const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r; const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Position déclarée par le terminal de l'agent au moment d'un contrôle. */
export interface AgentFix { lat: number; lon: number; accuracyM: number }

/** Présence attestée : précision suffisante et distance au lieu contrôlé dans la tolérance. */
export function presenceOk(fix: AgentFix | null | undefined, distance: number | null): boolean {
  return !!fix && Number.isFinite(fix.accuracyM) && fix.accuracyM <= PRESENCE_MAX_ACCURACY_M && distance !== null && distance <= PRESENCE_MAX_DISTANCE_M;
}

/**
 * Distance (m) d'un point à la géométrie d'une zone : 0 à l'intérieur d'un polygone, sinon distance au bord (segments)
 * ou à l'artère (ligne). Projection plane locale (écarts de quelques kilomètres : précision largement suffisante).
 */
export function distanceToZoneM(zone: { geometry: { type: 'Polygon' | 'LineString'; coordinates: [number, number][] }; center: { lat: number; lon: number } }, p: { lat: number; lon: number }): number {
  const pts = zone.geometry.coordinates;
  if (pts.length === 0) return distanceM(p, zone.center);
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180); const ky = 110_574;
  const xy = ([lon, lat]: [number, number]) => [(lon - p.lon) * kx, (lat - p.lat) * ky] as const;
  const ring = pts.map(xy);
  if (zone.geometry.type === 'Polygon' && ring.length >= 3) {
    // Point dans le polygone (lancer de rayon depuis l'origine = le point).
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!; const [xj, yj] = ring[j]!;
      if ((yi > 0) !== (yj > 0) && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return 0;
  }
  const segs: [readonly [number, number], readonly [number, number]][] = [];
  for (let i = 0; i + 1 < ring.length; i++) segs.push([ring[i]!, ring[i + 1]!]);
  if (zone.geometry.type === 'Polygon' && ring.length >= 3) segs.push([ring[ring.length - 1]!, ring[0]!]);
  if (!segs.length) return Math.round(Math.hypot(ring[0]![0], ring[0]![1]));
  let best = Infinity;
  for (const [[ax, ay], [bx, by]] of segs) {
    const dx = bx - ax; const dy = by - ay; const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return Math.round(best);
}

export interface PenaltyLine {
  module: 'STATIONNEMENT' | 'PUBLICITE';
  reference: string;
  nature: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  obligationId: string | null;
  amount: MoneyJSON | null;
  payment: string;
  unpaid: boolean;
  overdueDays: number | null;
  plate?: string;
  zone?: string;
}

export interface EarningLine {
  module?: string;
  moduleLabel?: string;
  obligationId?: string;
  /** Instant du fait générateur (contrôle, constat) : sert à attribuer un paiement une seule fois, au premier. */
  triggerAt?: string;
  agentId?: string;
  source: 'PENALITE' | 'PAIEMENT';
  reference: string;
  plate: string;
  zone: string;
  at: string;
  base: MoneyJSON;
  commission: MoneyJSON;
  state: 'EN_ATTENTE' | 'CONFIRMEE' | 'ACQUISE' | 'ANNULEE';
  stateLabel: string;
  /** Ordre de paiement (échéance) qui fonde la ligne ; absent pour le solde en attente. */
  orderId?: string;
  /** Date du paiement confirmé (null tant que rien n'est payé). */
  paidAt?: string | null;
}

const NATURE_LABEL: Record<string, string> = {
  NON_PAIEMENT: 'Stationnement non payé', DEPASSEMENT: 'Dépassement de durée', STATIONNEMENT_INTERDIT: 'Stationnement interdit',
  PLACE_RESERVEE: 'Place réservée occupée', DOUBLE_FILE: 'Double file',
};
const DAY_MS = 86_400_000;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export class ParkingField {
  readonly photos = new InMemoryRepository<EvidencePhoto>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly svc: ParkingService) {}

  // ------------------------------------------------------------------ Preuves photographiques

  meta(p: EvidencePhoto): PhotoMeta {
    const { dataBase64: _omit, ...rest } = p;
    const z = this.svc.zones.get(p.zoneId);
    const dist = z?.center ? distanceM({ lat: p.lat, lon: p.lon }, z.center) : null;
    return {
      ...rest, slotLabel: SLOT_LABEL[p.slot], url: `/v1/parking/evidence-photos/${p.id}`, clockWarning: p.clockSkewSeconds > CLOCK_SKEW_WARN_SECONDS,
      distanceFromZoneM: dist, lowAccuracy: lowAccuracy(p.gpsSource, p.accuracyM), farFromZone: dist !== null && dist > ZONE_WARN_DISTANCE_M,
    };
  }

  /** Preuve faible (même règle que les signaux montrés au vérificateur) : position imprécise, loin de la zone, horloge décalée. */
  weakEvidence(p: EvidencePhoto): boolean {
    const m = this.meta(p);
    return m.lowAccuracy || m.farFromZone || m.clockWarning;
  }

  activeForCheck(checkId: string): EvidencePhoto[] {
    return this.photos.find((p) => p.checkId === checkId && !p.supersededBy);
  }

  upload(user: User, input: {
    checkId: string; slot: EvidenceSlot; imageBase64: string; sha256: string; lat: number; lon: number; accuracyM?: number;
    gpsSource: 'GPS' | 'MANUEL' | 'ZONE'; place: string; stampedAt: string;
  }): PhotoMeta {
    const check = this.svc.checks.get(input.checkId);
    if (!check) throw notFound('CHECK_NOT_FOUND', 'Contrôle inconnu.');
    if (check.agentId !== user.id) throw forbidden('NOT_CHECK_AGENT', 'Seul l’agent qui a effectué le contrôle peut en photographier le véhicule.');
    if (check.light !== 'ROUGE') throw unprocessable('CHECK_NOT_RED', 'Photos de preuve réservées à un contrôle ROUGE (aucun titre valide).');
    if (!check.zoneId) throw unprocessable('CHECK_WITHOUT_ZONE', 'Le contrôle doit porter sur une zone.');
    const zone = this.svc.getZone(check.zoneId);
    authorize(user, 'parking:violation.record', { communes: [zone.commune] });
    const now = this.svc.now();
    if (now.getTime() - Date.parse(check.at) > PHOTO_WINDOW_MINUTES * 60_000) throw unprocessable('CHECK_TOO_OLD', `Photos à prendre dans les ${PHOTO_WINDOW_MINUTES} minutes du contrôle : refaites un contrôle.`);
    const buf = Buffer.from(input.imageBase64, 'base64');
    if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) throw badRequest('PHOTO_SIZE', `Photo vide ou trop lourde (${Math.round(MAX_PHOTO_BYTES / 1000)} Ko au plus).`);
    if (!buf.subarray(0, 3).equals(JPEG_MAGIC)) throw badRequest('PHOTO_FORMAT', 'Photo JPEG attendue.');
    const sha = sha256Hex(buf);
    if (sha !== input.sha256.toLowerCase()) throw unprocessable('PHOTO_HASH_MISMATCH', 'Empreinte SHA-256 différente de l’image reçue : photo altérée en transit.');
    if (this.photos.findOne((p) => p.sha256 === sha)) throw conflict('PHOTO_DUPLICATE', 'Cette photo a déjà été versée (une même image ne peut pas servir deux fois).');
    const active = this.activeForCheck(check.id);
    const previous = active.find((p) => p.slot === input.slot);
    if (previous?.violationId) throw conflict('PHOTO_LOCKED', 'Photo déjà jointe à un constat : elle ne peut plus être remplacée.');
    if (!previous && active.length >= MAX_PHOTOS_PER_CHECK) throw unprocessable('PHOTO_LIMIT', `${MAX_PHOTOS_PER_CHECK} photos au plus par contrôle.`);
    const skew = Math.round(Math.abs(now.getTime() - Date.parse(input.stampedAt)) / 1000);
    const id = this.ids.next('PKP');
    const photo = this.photos.insert({
      id, checkId: check.id, plate: check.plate, zoneId: zone.id, commune: zone.commune, slot: input.slot, sha256: sha, mime: 'image/jpeg', sizeBytes: buf.length,
      dataBase64: buf.toString('base64'), lat: input.lat, lon: input.lon, accuracyM: input.accuracyM ?? null, gpsSource: input.gpsSource, place: input.place,
      stampedAt: input.stampedAt, receivedAt: now.toISOString(), clockSkewSeconds: Number.isFinite(skew) ? skew : 999_999, agentId: user.id, agentName: user.name,
      violationId: null, supersededBy: null,
    });
    // Reprise d'une vue : l'ancienne photo reste conservée (jamais effacée), marquée remplacée.
    if (previous) this.photos.update({ ...previous, supersededBy: id });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'parking.evidence.photo.received', resourceType: 'parking_evidence_photo', resourceId: id,
      details: { checkId: check.id, plate: check.plate, slot: input.slot, sha256: sha, bytes: buf.length, gpsSource: input.gpsSource, clockSkewSeconds: photo.clockSkewSeconds, replaces: previous?.id ?? null },
    });
    return this.meta(photo);
  }

  /** Photos désignées pour un constat : même agent, même contrôle, même plaque, non déjà jointes. */
  claimForViolation(user: User, photoIds: string[], checkId: string | undefined, plate: string): EvidencePhoto[] {
    if (!checkId) throw badRequest('CHECK_REQUIRED', 'Les photos de preuve se rattachent à un contrôle : checkId requis.');
    const uniq = [...new Set(photoIds)];
    if (uniq.length === 0 || uniq.length > MAX_PHOTOS_PER_CHECK) throw badRequest('PHOTO_COUNT', `1 à ${MAX_PHOTOS_PER_CHECK} photos.`);
    return uniq.map((id) => {
      const p = this.photos.get(id);
      if (!p) throw notFound('PHOTO_NOT_FOUND', `Photo inconnue : ${id}`);
      if (p.agentId !== user.id || p.checkId !== checkId || p.plate !== plate) throw unprocessable('PHOTO_MISMATCH', 'Photo d’un autre contrôle, d’une autre plaque ou d’un autre agent.');
      if (p.supersededBy) throw unprocessable('PHOTO_SUPERSEDED', 'Photo remplacée par une prise plus récente.');
      if (p.violationId) throw conflict('PHOTO_ALREADY_USED', 'Photo déjà jointe à un constat.');
      return p;
    });
  }

  link(photos: EvidencePhoto[], violationId: string): void {
    for (const p of photos) this.photos.update({ ...p, violationId });
  }

  /** Lecture d'une photo : l'agent auteur tant qu'elle n'est pas jointe ; ensuite, les lecteurs du constat (dont l'usager). */
  read(user: User, id: string): { mime: string; data: Buffer; sha256: string } {
    const p = this.photos.get(id);
    if (!p) throw notFound('PHOTO_NOT_FOUND', 'Photo inconnue.');
    if (p.violationId) {
      const v = this.svc.violations.get(p.violationId)!;
      authorize(user, 'parking:violation.read', { taxpayerId: v.holderTaxpayerId ?? undefined, communes: [v.commune], entity: 'DGTK' });
    } else if (p.agentId !== user.id && !evaluate(user, 'parking:violation.verify', { communes: [p.commune] })) {
      throw forbidden('FORBIDDEN', 'Photo non encore jointe à un constat : visible de son auteur et du superviseur.');
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.evidence.photo.viewed', resourceType: 'parking_evidence_photo', resourceId: id, details: { violationId: p.violationId } });
    return { mime: p.mime, data: Buffer.from(p.dataBase64, 'base64'), sha256: p.sha256 };
  }

  photosOfViolation(violationId: string): PhotoMeta[] {
    return this.photos.find((p) => p.violationId === violationId).sort((a, b) => EVIDENCE_SLOTS.indexOf(a.slot) - EVIDENCE_SLOTS.indexOf(b.slot)).map((p) => this.meta(p));
  }

  // ------------------------------------------------------------------ Pénalités d'un usager

  private overdueDays(v: ParkingViolation, unpaid: boolean): number | null {
    if (!unpaid || !v.decision) return null;
    return Math.floor((this.svc.now().getTime() - Date.parse(v.decision.at)) / DAY_MS);
  }

  /** Toutes les pénalités (constats en cours et retenus) d'un usager, par plaque et par titulaire — vue du module. */
  penaltiesFor(subject: { plate?: string | null; taxpayerId?: string | null }): PenaltyLine[] {
    const plate = subject.plate ? this.svc.plate(subject.plate) : null;
    const plates = new Set<string>(plate ? [plate] : []);
    if (subject.taxpayerId) for (const v of this.svc.vehicles.find((x) => x.taxpayerId === subject.taxpayerId)) plates.add(v.plate);
    return this.svc.violations
      .find((v) => (plates.has(v.plate) || (!!subject.taxpayerId && v.holderTaxpayerId === subject.taxpayerId)) && v.status !== 'REJETE' && v.status !== 'CLASSE')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((v) => {
        const ob = v.decision?.obligationId ? this.ctx.assessment.get(v.decision.obligationId) : null;
        const pay = ob ? paymentState(this.ctx, ob.id).state : 'AUCUNE_REFERENCE';
        const unpaid = !!ob && pay !== 'PAYE' && pay !== 'RAPPROCHE' && ob.status !== 'ANNULEE' && ob.status !== 'SOLDEE';
        // Montant : seulement celui fixé par la décision ; jamais le montant proposé d'un constat non encore décidé.
        return {
          module: 'STATIONNEMENT' as const, reference: v.reference, nature: NATURE_LABEL[v.nature] ?? v.nature, status: v.status, createdAt: v.createdAt,
          decidedAt: v.decision?.at ?? null, obligationId: ob?.id ?? null, amount: ob?.amount ?? null, payment: pay, unpaid,
          overdueDays: this.overdueDays(v, unpaid), plate: v.plate, zone: this.svc.zones.get(v.zoneId)?.name ?? v.zoneId,
        };
      });
  }

  // ------------------------------------------------------------------ Commission des agents (10 %)

  /**
   * Lignes de commission du stationnement, TOUS agents, calculées une seule fois (contrôles rouges indexés par plaque,
   * ordres de paiement indexés par obligation) :
   * - PÉNALITÉ : constat de l'agent, vérifié et retenu par deux autres personnes, pénalité émise ;
   * - PAIEMENT : session de stationnement ouverte pour la plaque dans l'heure qui suit un contrôle ROUGE de l'agent
   *   (régularisation provoquée par le contrôle ; une session n'est attribuée qu'une fois, au premier contrôle).
   * Base : montants réellement payés, échéance par échéance (un paiement partiel ne vaut pas paiement complet).
   * État de chaque ligne : celui de SES ordres — CONFIRMEE (payé, rapprochement bancaire en cours) → ACQUISE (rapproché
   * au compte public : due par le Trésor) ; EN_ATTENTE pour le solde d'une pénalité ; ANNULEE si la pénalité est annulée.
   */
  allEarningsLines(orders: Map<string, PaymentOrder[]> = ordersByObligation(this.ctx)): EarningLine[] {
    const lines: EarningLine[] = [];
    const zoneName = (id: string) => this.svc.zones.get(id)?.name ?? id;
    for (const v of this.svc.violations.find((x) => x.status === 'RETENU' && !!x.decision?.obligationId)) {
      const ob = this.ctx.assessment.obligations.get(v.decision!.obligationId!);
      if (!ob) continue;
      lines.push(...obligationEarningLines(this.ctx, ob, orders, {
        module: 'STATIONNEMENT', moduleLabel: 'Stationnement', obligationId: ob.id, triggerAt: v.createdAt, agentId: v.agentId, source: 'PENALITE',
        reference: v.reference, plate: v.plate, zone: zoneName(v.zoneId), at: v.decision!.at,
      }, { withBalance: true }));
    }
    // Attribution des paiements : premier contrôle ROUGE à présence attestée (GPS près de la zone), précédant la session
    // dans le délai ; aucune attribution si la session suit de moins du délai de grâce la PREMIÈRE observation rouge de
    // la plaque dans la zone (paiement spontané à l'arrivée, quel que soit l'agent).
    const reds = new Map<string, ControlCheck[]>();
    for (const c of this.svc.checks.all()) {
      if (c.light !== 'ROUGE' || !c.zoneId) continue;
      const k = `${c.plate}|${c.zoneId}`;
      const l = reds.get(k);
      if (l) l.push(c); else reds.set(k, [c]);
    }
    for (const l of reds.values()) l.sort((a, b) => a.at.localeCompare(b.at));
    const win = PAYMENT_ATTRIBUTION_MINUTES * 60_000; const grace = PARKING_GRACE_MINUTES * 60_000;
    for (const s of this.svc.sessions.all()) {
      const created = Date.parse(s.createdAt);
      const seen = (reds.get(`${s.plate}|${s.zoneId}`) ?? []).filter((c) => Date.parse(c.at) <= created && created - Date.parse(c.at) <= win + grace);
      if (!seen.length || created - Date.parse(seen[0]!.at) < grace) continue;
      const trigger = seen.find((c) => c.presenceVerified === true && created - Date.parse(c.at) <= win);
      if (!trigger) continue;
      for (const g of s.segments) {
        const ob = this.ctx.assessment.obligations.get(g.obligationId);
        if (!ob) continue;
        lines.push(...obligationEarningLines(this.ctx, ob, orders, {
          module: 'STATIONNEMENT', moduleLabel: 'Stationnement', obligationId: ob.id, triggerAt: trigger.at, agentId: trigger.agentId, source: 'PAIEMENT',
          reference: `${s.ticketCode ?? s.id} · ${g.kind === 'INITIALE' ? 'session' : 'prolongation'}`, plate: s.plate, zone: zoneName(s.zoneId), at: s.createdAt,
        }, { withBalance: false }));
      }
    }
    return lines.sort((a, b) => b.at.localeCompare(a.at));
  }

  earningsLines(agentId: string): EarningLine[] {
    return this.allEarningsLines().filter((l) => l.agentId === agentId);
  }

  earningsSummary(agentId: string, lines: EarningLine[] = this.earningsLines(agentId)) {
    return {
      agentId, ratePct: AGENT_COMMISSION_PCT,
      totals: earningTotals(lines, this.svc.now()),
      counts: { penalites: lines.filter((l) => l.source === 'PENALITE').length, paiements: lines.filter((l) => l.source === 'PAIEMENT').length },
      lines,
      rules: [
        `Commission de ${AGENT_COMMISSION_PCT} % : uniquement sur les pénalités issues de vos constats et sur les paiements de stationnement effectués dans l’heure qui suit votre contrôle rouge (position GPS attestée près de la zone ; aucun paiement dans les ${PARKING_GRACE_MINUTES} minutes de la première observation du véhicule).`,
        'Calculée sur des recettes arrivées au compte public ; acquise après rapprochement bancaire ; versée par le Trésor (paie). Vous ne recevez jamais d’argent de l’usager.',
        'Une pénalité n’existe qu’après vérification (superviseur) et décision (régie) par deux autres personnes ; annulée sur recours, elle annule la commission.',
        'Taux fixé par décision du maître d’ouvrage : un acte (arrêté) est requis avant tout versement réel.',
      ],
    };
  }

  /** Récapitulatif de tous les agents du stationnement, calculé en une seule passe. */
  earningsByAgent(): { agentId: string; totals: ReturnType<typeof earningTotals>; counts: { penalites: number; paiements: number } }[] {
    const by = new Map<string, EarningLine[]>();
    for (const a of new Set([...this.svc.checks.all().map((c) => c.agentId), ...this.svc.violations.all().map((v) => v.agentId)])) by.set(a, []);
    for (const l of this.allEarningsLines()) by.get(l.agentId!)?.push(l);
    return [...by].map(([agentId, lines]) => { const e = this.earningsSummary(agentId, lines); return { agentId, totals: e.totals, counts: e.counts }; });
  }
}

export const EARNING_STATE_LABEL: Record<EarningLine['state'], string> = {
  EN_ATTENTE: 'En attente du paiement de l’usager', CONFIRMEE: 'Payé — rapprochement bancaire en cours', ACQUISE: 'Acquise — à verser par le Trésor', ANNULEE: 'Annulée (pénalité annulée)',
};

export function commissionOf(m: MoneyJSON): MoneyJSON {
  return Money.fromJSON(m).multiply(`${AGENT_COMMISSION_PCT / 100}`).toJSON();
}

/**
 * Lignes de commission d'une obligation : une par ordre payé (échéance), base = montant de l'ordre, état = celui de
 * l'ordre ; `accept` filtre les ordres attribuables (fenêtre du module). Avec `withBalance` (pénalité) : le solde
 * restant dû en attente, ou une ligne annulée si l'obligation est annulée.
 */
export function obligationEarningLines(
  ctx: AppContext, ob: Obligation, orders: Map<string, PaymentOrder[]> | undefined,
  line: Omit<EarningLine, 'base' | 'commission' | 'state' | 'stateLabel' | 'orderId' | 'paidAt'>,
  opts: { withBalance: boolean; accept?: (o: PaidOrder) => boolean },
): EarningLine[] {
  if (ob.status === 'ANNULEE') {
    return opts.withBalance ? [{ ...line, base: ob.amount, commission: commissionOf(ob.amount), state: 'ANNULEE', stateLabel: EARNING_STATE_LABEL.ANNULEE, paidAt: null }] : [];
  }
  const paid = paidOrders(ctx, ob.id, orders);
  const out: EarningLine[] = paid.filter((o) => !opts.accept || opts.accept(o)).map((o) => {
    const state: EarningLine['state'] = o.reconciled ? 'ACQUISE' : 'CONFIRMEE';
    return { ...line, orderId: o.id, paidAt: o.at, base: o.amount, commission: commissionOf(o.amount), state, stateLabel: EARNING_STATE_LABEL[state] };
  });
  if (opts.withBalance && ob.status !== 'SOLDEE') {
    const rest = paid.reduce((m, o) => m.subtract(Money.fromJSON(o.amount)), Money.fromJSON(ob.amount));
    if (rest.compare(Money.zero(rest.currency)) > 0) out.push({ ...line, base: rest.toJSON(), commission: commissionOf(rest.toJSON()), state: 'EN_ATTENTE', stateLabel: EARNING_STATE_LABEL.EN_ATTENTE, paidAt: null });
  }
  return out;
}

/** Totaux par état et par devise ; « ce mois » : commissions payées (confirmées ou acquises) ce mois-ci à Kinshasa. */
export function earningTotals(lines: EarningLine[], now: Date) {
  const by = (st: EarningLine['state']) => sumByCurrency(lines.filter((l) => l.state === st).map((l) => l.commission));
  const month = kinshasaMonth(now);
  return {
    acquise: by('ACQUISE'), confirmee: by('CONFIRMEE'), enAttente: by('EN_ATTENTE'), annulee: by('ANNULEE'),
    base: sumByCurrency(lines.filter((l) => l.state !== 'ANNULEE').map((l) => l.base)),
    ceMois: sumByCurrency(lines.filter((l) => (l.state === 'CONFIRMEE' || l.state === 'ACQUISE') && !!l.paidAt && kinshasaMonth(l.paidAt) === month).map((l) => l.commission)),
  };
}
