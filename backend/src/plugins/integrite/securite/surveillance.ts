/**
 * Surveillance transverse (§ 25.1, § 18.4 / H.10, § 40) — détections explicables, alertes seulement, jamais de
 * sanction automatique ; seuils lus au registre des seuils (PAR_DEFAUT — à confirmer) :
 *  - lecture massive de données personnelles (DLP) par une même personne sur une fenêtre glissante ;
 *  - registre des empreintes d'appareil : un appareil qui sert plusieurs comptes ; statut d'attestation / MDM des
 *    terminaux de terrain (raccordement MDM [À RACCORDER] : statut saisi par la sécurité ou poussé par l'outil MDM) ;
 *  - plausibilité GPS : vitesse impossible entre deux actions de terrain successives d'une même personne ;
 *  - plafonds de références de paiement par canal et par agent générateur (seuil d'alerte, plafond bloquant
 *    facultatif), présentés avec les plafonds par point agréé déjà en vigueur (canaux/points.ts).
 */
import type { RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import type { AuditRecord } from '../../../core/audit.js';
import type { User } from '../../../core/auth.js';
import { kinshasaDate } from '../../../core/clock.js';
import { ApiError, notFound } from '../../../core/errors.js';
import { authorize } from '../../../core/policy.js';
import { InMemoryRepository } from '../../../core/repository.js';
import { haversineKm } from '../common.js';
import { REFERENCE_CHANNELS, securityNum } from '../gouvernance/parametres-securite.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type AttestationStatus = 'NON_ATTESTE' | 'CONFORME' | 'NON_CONFORME' | 'INCONNU';

export interface DeviceAccount { userId: string; firstSeen: string; lastSeen: string; requests: number }
export interface DeviceRecord {
  /** `empreinte:<valeur>` (navigateur) ou `terminal:<identifiant>` (terminal enrôlé). */
  id: string;
  kind: 'EMPREINTE' | 'TERMINAL';
  accounts: DeviceAccount[];
  firstSeen: string;
  lastSeen: string;
  attestation: {
    status: AttestationStatus;
    mdmEnrolled: boolean | null;
    rooted: boolean | null;
    source: 'AUCUNE' | 'MDM' | 'ATTESTATION_PLATEFORME' | 'DECLARATIF';
    note?: string;
    updatedAt?: string;
    updatedBy?: string;
  };
}

export interface GpsPoint { lat: number; lon: number; at: string; action?: string; auditId?: string }
export interface GpsAnomaly {
  id: string;
  userId: string;
  from: GpsPoint;
  to: GpsPoint;
  distanceKm: number;
  seconds: number;
  speedKmh: number;
  maxKmh: number;
  detectedAt: string;
  alertId: string | null;
}

const PERSONAL_GET_PREFIXES = ['/v1/taxpayers', '/v1/obligations', '/v1/objects', '/v1/acces/identity', '/v1/acces/consultations', '/v1/fiscal/', '/v1/receipts', '/v1/leases', '/v1/recouvrement/', '/v1/appeals'];
const READ_ACTIONS = new Set(['taxpayer.viewed', 'obligation.viewed', 'acces.identity.viewed', 'acces.consultation.read', 'titres.plate.consulted', 'parking.evidence.photo.viewed', 'publicite.evidence.photo.viewed', 'recovery.notice.read']);
const PUBLIC_ROLES: RoleCode[] = ['R30', 'R31'];
const isAgent = (roles: RoleCode[] | undefined) => !!roles?.length && roles.some((r) => !PUBLIC_ROLES.includes(r));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Coordonnées portées par un enregistrement d'audit (lat/lon, gps, position, location). */
export function coordinatesOf(details: Record<string, unknown>): { lat: number; lon: number } | null {
  const pick = (o: unknown): { lat: number; lon: number } | null => {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    const lat = num(r.lat) ?? num(r.latitude);
    const lon = num(r.lon) ?? num(r.lng) ?? num(r.longitude);
    return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  };
  return pick(details) ?? pick(details.gps) ?? pick(details.position) ?? pick(details.location);
}

/** Vitesse entre deux points (km/h) ; null si l'intervalle est nul ou négatif (évaluation impossible). */
export function speedBetween(a: GpsPoint, b: GpsPoint): { distanceKm: number; seconds: number; speedKmh: number | null } {
  const distanceKm = haversineKm(a, b);
  const seconds = (Date.parse(b.at) - Date.parse(a.at)) / 1000;
  return { distanceKm, seconds, speedKmh: seconds > 0 ? (distanceKm / seconds) * 3600 : null };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class SurveillanceService {
  readonly devices = new InMemoryRepository<DeviceRecord>();
  readonly gpsAnomalies = new InMemoryRepository<GpsAnomaly>();
  private readonly lastPoint = new Map<string, GpsPoint>();
  private readonly reads = new Map<string, number[]>();
  private readonly counted = new Set<string>();
  private refDay = '';
  private readonly refByAgent = new Map<string, number>();
  private readonly refByChannel = new Map<string, number>();
  private gpsSeq = 0;

  constructor(private readonly ctx: AppContext) {
    ctx.audit.onAppend((r) => this.onAudit(r));
  }

  private now(): Date {
    return this.ctx.clock.now();
  }

  private onAudit(r: AuditRecord): void {
    if (r.action === 'security.alert.raised' || r.action.startsWith('integrite.surveillance.')) return;
    if (r.actor.kind === 'user' && READ_ACTIONS.has(r.action)) this.countRead(r.actor.id, r.actor.roles as RoleCode[] | undefined, r.trace?.correlationId ?? r.id, r.at);
    if (r.actor.kind === 'user' && r.outcome === 'SUCCESS') {
      const c = coordinatesOf(r.details);
      if (c) {
        const observed = [r.details.observedAt, r.details.capturedAt, r.details.gpsAt].find((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v))) as string | undefined;
        this.gpsPoint(r.actor.id, { ...c, at: observed ?? r.at, action: r.action, auditId: r.id });
      }
    }
    if (r.action === 'payment.reference.issued' && r.actor.kind === 'user') this.countReference(r);
  }

  /* ---------------- Lecture massive (DLP) ---------------- */

  /** Appelé pour chaque lecture réussie d'une route de données personnelles (une seule fois par requête). */
  countRead(userId: string, roles: RoleCode[] | undefined, correlationId: string, at: string): void {
    if (!isAgent(roles)) return;
    const key = `${userId}|${correlationId}`;
    if (this.counted.has(key)) return;
    this.counted.add(key);
    if (this.counted.size > 50_000) this.counted.clear();
    const windowMs = securityNum(this.ctx, 'dlp.fenetre_min') * 60_000;
    const max = securityNum(this.ctx, 'dlp.lectures_max');
    const t = Date.parse(at);
    const list = (this.reads.get(userId) ?? []).filter((x) => x > t - windowMs);
    list.push(t);
    this.reads.set(userId, list);
    if (list.length > max) {
      const bucket = Math.floor(t / windowMs);
      this.ctx.alerts.raiseOnce(`DLP:LECTURE_MASSIVE:${userId}:${bucket}`, {
        type: 'DLP_LECTURE_MASSIVE', severity: 'HIGH', source: 'integrite:dlp',
        detail: `${userId} : ${list.length} lectures de données personnelles en ${windowMs / 60_000} min (seuil ${max}, par défaut — à confirmer). Examen humain requis.`,
        context: { userId, reads: list.length, windowMinutes: windowMs / 60_000, max, automaticEffect: 'AUCUN' }, notifyRoles: ['R22', 'R25'],
      });
    }
  }

  isPersonalRead(method: string, url: string): boolean {
    const path = url.split('?')[0] ?? '';
    return method === 'GET' && PERSONAL_GET_PREFIXES.some((p) => path.startsWith(p));
  }

  /** Alerte immédiate sur une extraction massive (export au-delà du seuil). */
  bulkExportAlert(userId: string, rows: number, threshold: number, reference: string): void {
    this.ctx.alerts.raiseOnce(`DLP:EXPORT_MASSIF:${reference}`, {
      type: 'DLP_EXPORT_MASSIF', severity: 'HIGH', source: 'integrite:dlp',
      detail: `Demande d’extraction massive ${reference} par ${userId} : ${rows} lignes (seuil ${threshold}). Circuit à trois visas engagé.`,
      context: { userId, rows, threshold, reference, automaticEffect: 'AUCUN' }, notifyRoles: ['R22', 'R25'],
    });
  }

  /* ---------------- Empreintes d'appareil ---------------- */

  observeDevice(user: User, device: { deviceId?: string; deviceFingerprint?: string }, sharedDevice: boolean): void {
    const at = this.now().toISOString();
    const ids: [DeviceRecord['kind'], string][] = [];
    if (device.deviceFingerprint) ids.push(['EMPREINTE', `empreinte:${device.deviceFingerprint}`]);
    if (device.deviceId) ids.push(['TERMINAL', `terminal:${device.deviceId}`]);
    for (const [kind, id] of ids) {
      const d = this.devices.get(id) ?? this.devices.insert({ id, kind, accounts: [], firstSeen: at, lastSeen: at, attestation: { status: 'NON_ATTESTE', mdmEnrolled: null, rooted: null, source: 'AUCUNE' } });
      const accounts = d.accounts.slice();
      const i = accounts.findIndex((a) => a.userId === user.id);
      // Compte déjà connu vu il y a moins de 5 minutes : aucune écriture (pas d'écriture persistante à chaque requête).
      if (i >= 0 && Date.parse(at) - Date.parse(accounts[i]!.lastSeen) < 300_000) continue;
      if (i >= 0) accounts[i] = { ...accounts[i]!, lastSeen: at, requests: accounts[i]!.requests + 1 };
      else accounts.push({ userId: user.id, firstSeen: at, lastSeen: at, requests: 1 });
      this.devices.update({ ...d, accounts, lastSeen: at });
      const max = securityNum(this.ctx, 'appareil.comptes_max');
      if (i < 0 && !sharedDevice && accounts.length > max) {
        this.ctx.alerts.raiseOnce(`APPAREIL:MULTI_COMPTES:${id}:${accounts.length}`, {
          type: 'APPAREIL_MULTI_COMPTES', severity: 'MEDIUM', source: 'integrite:appareils',
          detail: `L’appareil ${id.slice(0, 40)} sert ${accounts.length} comptes distincts (seuil ${max}) : ${accounts.map((a) => a.userId).join(', ')}. Vérifier un éventuel prêt d’appareil ou d’identifiants.`,
          context: { deviceId: id, accounts: accounts.map((a) => a.userId), automaticEffect: 'AUCUN' }, notifyRoles: ['R22'],
        });
      }
    }
  }

  listDevices(user: User) {
    authorize(user, 'integrite:appareils.read');
    const max = securityNum(this.ctx, 'appareil.comptes_max');
    const known = new Set(this.devices.all().map((d) => d.id));
    // Terminaux enrôlés du socle terrain encore jamais vus : présentés avec leur statut d'attestation (non attesté).
    const terminals = this.ctx.field.devices.all().filter((t) => !known.has(`terminal:${t.id}`)).map((t) => ({
      id: `terminal:${t.id}`, kind: 'TERMINAL' as const, accounts: t.agentUserId ? [{ userId: t.agentUserId, firstSeen: '', lastSeen: '', requests: 0 }] : [],
      firstSeen: '', lastSeen: '', attestation: { status: 'NON_ATTESTE' as const, mdmEnrolled: null, rooted: null, source: 'AUCUNE' as const },
    }));
    const items = [...this.devices.all(), ...terminals].map((d) => ({ ...d, multiAccounts: d.accounts.length > max }));
    return {
      items, max,
      mdm: { wired: false, note: 'Connecteur MDM / attestation d’appareil [À RACCORDER] : le statut est saisi par la sécurité ou poussé par l’outil MDM.' },
      automaticEffect: 'AUCUN' as const,
    };
  }

  setAttestation(user: User, id: string, input: { status: AttestationStatus; mdmEnrolled?: boolean; rooted?: boolean; source: 'MDM' | 'ATTESTATION_PLATEFORME' | 'DECLARATIF'; note: string }): DeviceRecord {
    authorize(user, 'integrite:appareils.attest');
    const key = id.includes(':') ? id : `terminal:${id}`;
    let d = this.devices.get(key);
    if (!d) {
      if (!key.startsWith('terminal:') || !this.ctx.field.devices.get(key.slice('terminal:'.length))) throw notFound('DEVICE_NOT_FOUND', `Appareil inconnu : ${id}`);
      const at = this.now().toISOString();
      d = this.devices.insert({ id: key, kind: 'TERMINAL', accounts: [], firstSeen: at, lastSeen: at, attestation: { status: 'NON_ATTESTE', mdmEnrolled: null, rooted: null, source: 'AUCUNE' } });
    }
    const before = d.attestation;
    const attestation: DeviceRecord['attestation'] = {
      status: input.status, mdmEnrolled: input.mdmEnrolled ?? null, rooted: input.rooted ?? null, source: input.source, note: input.note,
      updatedAt: this.now().toISOString(), updatedBy: user.id,
    };
    const out = this.devices.update({ ...d, attestation });
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integrite.surveillance.device_attested', resourceType: 'device', resourceId: key,
      details: { status: input.status, mdmEnrolled: input.mdmEnrolled ?? null, rooted: input.rooted ?? null, source: input.source, motif: input.note }, before, after: attestation,
    });
    if (input.status === 'NON_CONFORME' || input.rooted === true) {
      this.ctx.alerts.raiseOnce(`APPAREIL:NON_CONFORME:${key}:${attestation.updatedAt}`, {
        type: 'APPAREIL_NON_CONFORME', severity: 'HIGH', source: 'integrite:appareils',
        detail: `Terminal ${key} déclaré non conforme${input.rooted ? ' (système modifié : root ou jailbreak)' : ''} : révocation à décider par une personne habilitée.`,
        context: { deviceId: key, automaticEffect: 'AUCUN' }, actor: { kind: 'user', id: user.id, roles: user.roles },
      });
    }
    return out;
  }

  /* ---------------- Plausibilité GPS ---------------- */

  private gpsPoint(userId: string, p: GpsPoint): void {
    const prev = this.lastPoint.get(userId);
    if (!prev || Date.parse(p.at) >= Date.parse(prev.at)) this.lastPoint.set(userId, p);
    if (!prev) return;
    const [a, b] = Date.parse(p.at) >= Date.parse(prev.at) ? [prev, p] : [p, prev];
    const s = speedBetween(a, b);
    const maxKmh = securityNum(this.ctx, 'gps.vitesse_max_kmh');
    const minKm = securityNum(this.ctx, 'gps.distance_min_m') / 1000;
    if (s.speedKmh === null || s.distanceKm < minKm || s.speedKmh <= maxKmh) return;
    const id = `GPS-${String(++this.gpsSeq).padStart(6, '0')}`;
    const alert = this.ctx.alerts.raiseOnce(`GPS:VITESSE:${userId}:${a.auditId ?? a.at}>${b.auditId ?? b.at}`, {
      type: 'GPS_VITESSE_IMPLAUSIBLE', severity: 'MEDIUM', source: 'integrite:gps',
      detail: `${userId} : ${s.distanceKm.toFixed(1)} km en ${Math.round(s.seconds)} s entre « ${a.action ?? '?'} » et « ${b.action ?? '?'} » (${Math.round(s.speedKmh)} km/h, seuil ${maxKmh} km/h). Position ou horloge à vérifier.`,
      context: { userId, from: a, to: b, speedKmh: Math.round(s.speedKmh), automaticEffect: 'AUCUN' }, notifyRoles: ['R09'],
    });
    this.gpsAnomalies.insert({ id, userId, from: a, to: b, distanceKm: Number(s.distanceKm.toFixed(3)), seconds: Math.round(s.seconds), speedKmh: Math.round(s.speedKmh), maxKmh, detectedAt: this.now().toISOString(), alertId: alert?.id ?? null });
  }

  /** Évaluation d'une suite de positions (terminal, contrôle a posteriori) : segments dont la vitesse est implausible. */
  evaluate(points: GpsPoint[]) {
    const maxKmh = securityNum(this.ctx, 'gps.vitesse_max_kmh');
    const minKm = securityNum(this.ctx, 'gps.distance_min_m') / 1000;
    const sorted = points.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const segments = sorted.slice(1).map((b, i) => {
      const a = sorted[i]!;
      const s = speedBetween(a, b);
      const implausible = s.speedKmh !== null && s.distanceKm >= minKm && s.speedKmh > maxKmh;
      return { from: a, to: b, distanceKm: Number(s.distanceKm.toFixed(3)), seconds: Math.round(s.seconds), speedKmh: s.speedKmh === null ? null : Math.round(s.speedKmh), implausible };
    });
    return { maxKmh, minDistanceM: minKm * 1000, plausible: !segments.some((s) => s.implausible), segments };
  }

  listGps(user: User) {
    authorize(user, 'integrite:appareils.read');
    return { items: this.gpsAnomalies.all().slice().reverse(), maxKmh: securityNum(this.ctx, 'gps.vitesse_max_kmh'), automaticEffect: 'AUCUN' as const };
  }

  /* ---------------- Plafonds de références de paiement ---------------- */

  private ensureDay(day: string, excludeId?: string): void {
    if (this.refDay === day) return;
    this.refDay = day;
    this.refByAgent.clear();
    this.refByChannel.clear();
    // Reconstitution depuis le journal (redémarrage, restauration) : les références du jour.
    for (const r of this.ctx.audit.list({ action: 'payment.reference.issued', limit: Number.MAX_SAFE_INTEGER }).items) {
      if (r.id !== excludeId && r.actor.kind === 'user' && kinshasaDate(new Date(r.at)) === day) this.tally(r, false);
    }
  }

  private tally(r: AuditRecord, check: boolean): void {
    const channel = typeof r.details.channel === 'string' ? r.details.channel : 'INCONNU';
    const c = (this.refByChannel.get(channel) ?? 0) + 1;
    this.refByChannel.set(channel, c);
    const agent = isAgent(r.actor.roles as RoleCode[] | undefined);
    const a = agent ? (this.refByAgent.get(r.actor.id) ?? 0) + 1 : 0;
    if (agent) this.refByAgent.set(r.actor.id, a);
    if (!check) return;
    const day = this.refDay;
    const chAlert = this.channelParam(channel, 'alerte_jour');
    if (chAlert > 0 && c >= chAlert) {
      this.ctx.alerts.raiseOnce(`PLAFOND:CANAL:${channel}:${day}`, {
        type: 'PLAFOND_REFERENCES_CANAL', severity: 'MEDIUM', source: 'integrite:plafonds',
        detail: `Canal ${channel} : ${c} références de paiement le ${day} (seuil d’alerte ${chAlert}).`, context: { channel, day, count: c, automaticEffect: 'AUCUN' },
      });
    }
    const agAlert = securityNum(this.ctx, 'plafonds.agent.alerte_jour');
    if (agent && agAlert > 0 && a >= agAlert) {
      this.ctx.alerts.raiseOnce(`PLAFOND:AGENT:${r.actor.id}:${day}`, {
        type: 'PLAFOND_REFERENCES_AGENT', severity: 'MEDIUM', source: 'integrite:plafonds',
        detail: `${r.actor.id} a généré ${a} références de paiement le ${day} (seuil d’alerte ${agAlert}, par défaut — à confirmer).`,
        context: { userId: r.actor.id, day, count: a, automaticEffect: 'AUCUN' }, notifyRoles: ['R09'],
      });
    }
  }

  private countReference(r: AuditRecord): void {
    // Reconstitution éventuelle SANS cet enregistrement (déjà au journal) : il est compté une seule fois, ci-dessous.
    this.ensureDay(kinshasaDate(new Date(r.at)), r.id);
    this.tally(r, true);
  }

  private channelParam(channel: string, kind: 'alerte_jour' | 'max_jour'): number {
    return (REFERENCE_CHANNELS as readonly string[]).includes(channel) ? securityNum(this.ctx, `plafonds.canal.${channel.toLowerCase()}.${kind}`) : 0;
  }

  /** Garde AVANT la création d'une référence : plafonds journaliers bloquants (0 = non fixé, aucun blocage). */
  guardReference(user: User, channel: string | undefined): void {
    this.ensureDay(kinshasaDate(this.now()));
    const refuse = (code: string, detail: string, ctx: Record<string, unknown>) => {
      this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integrite.surveillance.reference_ceiling_refused', resourceType: 'payment_reference', resourceId: channel ?? '?', outcome: 'DENIED', details: { code, ...ctx } });
      throw new ApiError(429, code, detail, ctx);
    };
    if (channel) {
      const max = this.channelParam(channel, 'max_jour');
      const n = this.refByChannel.get(channel) ?? 0;
      if (max > 0 && n >= max) refuse('CHANNEL_REFERENCE_CEILING', `Plafond journalier de références du canal ${channel} atteint (${max}).`, { channel, max, count: n });
    }
    if (isAgent(user.roles)) {
      const max = securityNum(this.ctx, 'plafonds.agent.max_jour');
      const n = this.refByAgent.get(user.id) ?? 0;
      if (max > 0 && n >= max) refuse('AGENT_REFERENCE_CEILING', `Plafond journalier de références générées par agent atteint (${max}).`, { max, count: n });
    }
  }

  ceilings(user: User) {
    authorize(user, 'integrite:plafonds.read');
    this.ensureDay(kinshasaDate(this.now()));
    const canaux = (this.ctx.ext.canaux as { points?: { points?: { all(): { id: string; name?: string; status?: string; limits?: unknown }[] } } } | undefined)?.points?.points;
    return {
      day: this.refDay,
      channels: REFERENCE_CHANNELS.map((c) => ({ channel: c, today: this.refByChannel.get(c) ?? 0, alertPerDay: this.channelParam(c, 'alerte_jour'), maxPerDay: this.channelParam(c, 'max_jour') })),
      agent: { alertPerDay: securityNum(this.ctx, 'plafonds.agent.alerte_jour'), maxPerDay: securityNum(this.ctx, 'plafonds.agent.max_jour') },
      agents: [...this.refByAgent.entries()].map(([userId, today]) => ({ userId, today })).sort((a, b) => b.today - a.today).slice(0, 50),
      points: canaux ? canaux.all().map((p) => ({ id: p.id, name: p.name ?? p.id, status: p.status ?? null, limits: p.limits ?? null })) : [],
      note: 'Plafonds par canal et par agent (registre des seuils, par défaut — à confirmer ; 0 = non fixé) ; plafonds par point agréé : fiche du point (module Canaux).',
      automaticEffect: 'AUCUN' as const,
    };
  }
}
