/**
 * Supervision et santé du système (module 55, § 28.6) — disponibilité, performance et réponse aux incidents :
 *  - OBSERVABILITÉ : métriques collectées sur chaque requête (volume, erreurs, latence par gabarit de route — jamais
 *    l'URL brute, qui peut porter un identifiant), exposées au format texte Prometheus ; journaux du serveur expurgés
 *    (en-têtes d'authentification, jetons, téléphones, courriels) ; trace : identifiant de requête (x-request-id) ;
 *  - ALERTES : disponibilité (taux d'erreurs serveur contre la cible de 99,9 % du § 28.6), latence (p95 au-delà d'un
 *    seuil PAR DÉFAUT à confirmer), erreurs ; levées une seule fois par fenêtre, notifiées à l'exploitation et à la sécurité ;
 *  - INCIDENTS : procédure (déclaration, prise en charge par l'astreinte, rétablissement, clôture avec revue post-incident)
 *    et tableau d'astreinte ; délai de rétablissement comparé au RTO du § 28.6 (4 h au pilote, 1 h à maturité).
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';

/** Cibles du Cahier (§ 28.6) : disponibilité mensuelle ; temps de reprise critique au pilote et à maturité. */
export const SLO_AVAILABILITY_PCT = '99.9';
export const RTO_HOURS = { PILOTE: 4, MATURITE: 1 } as const;
export type Phase = keyof typeof RTO_HOURS;
/** Seuils d'alerte PAR DÉFAUT (à confirmer par le maître d'ouvrage) : latence p95 et fenêtre d'observation. */
export const LATENCY_P95_ALERT_MS = 2000;
export const ALERT_WINDOW_MIN = 15;
export const MIN_REQUESTS_FOR_ALERT = 20;
const BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 5000];

interface RouteStat { method: string; route: string; count: number; errors5xx: number; errors4xx: number; sumMs: number; buckets: number[] }
interface Sample { t: number; ms: number; status: number }

export const SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;
export type Severity = (typeof SEVERITIES)[number];
export interface OpsIncident {
  id: string; title: string; service: string; severity: Severity; detectedAt: string; declaredBy: string; declaredAt: string;
  deploymentId?: string;
  status: 'DECLARE' | 'PRIS_EN_CHARGE' | 'RETABLI' | 'CLOS';
  acknowledged?: { by: string; at: string };
  restored?: { by: string; at: string; action: string };
  closed?: { by: string; at: string; rootCause: string; postMortemSha256: string };
  timeline: { at: string; by: string; step: string; note?: string }[];
}
export interface OnCallShift { id: string; userId: string; level: 'PRINCIPAL' | 'SECOURS'; from: string; to: string; createdBy: string }

/** Expurgation des journaux du serveur : aucun secret, aucune donnée personnelle inutile. */
export function scrubUrl(url: string): string {
  const [path, query] = url.split('?');
  const cleanPath = (path ?? '').replace(/\+?\d{9,15}/g, '[numéro]').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[courriel]');
  if (!query) return cleanPath;
  const params = query.split('&').map((kv) => { const [k] = kv.split('='); return `${k}=[expurgé]`; });
  return `${cleanPath}?${params.join('&')}`;
}
export function loggerOptions(): NonNullable<FastifyServerOptions['logger']> {
  return {
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-demo-user"]', 'req.headers["x-signature"]', 'req.headers["x-mosolo-signature"]', 'req.headers["x-client-cert-sha256"]'], censor: '[expurgé]' },
    serializers: { req: (req: { method: string; url: string; id?: string }) => ({ method: req.method, url: scrubUrl(req.url), id: req.id }) },
  };
}

export class SupervisionService {
  private readonly stats = new Map<string, RouteStat>();
  private readonly samples: Sample[] = [];
  private readonly startedAt: number;
  readonly incidents = new InMemoryRepository<OpsIncident>();
  readonly shifts = new InMemoryRepository<OnCallShift>();
  private readonly ids = new IdGenerator();
  phase: Phase = 'PILOTE';

  constructor(private readonly ctx: AppContext) {
    this.startedAt = ctx.clock.now().getTime();
  }

  private now() { return this.ctx.clock.now().toISOString(); }

  /** Collecte : un crochet de réponse par requête (gabarit de route seulement, jamais l'URL brute). */
  install(app: FastifyInstance) {
    app.addHook('onResponse', async (req, reply) => {
      const route = req.routeOptions.url ?? 'ROUTE_INCONNUE';
      this.record(req.method, route, reply.statusCode, reply.elapsedTime);
    });
  }

  record(method: string, route: string, status: number, ms: number) {
    const k = `${method} ${route}`;
    const s = this.stats.get(k) ?? { method, route, count: 0, errors5xx: 0, errors4xx: 0, sumMs: 0, buckets: BUCKETS_MS.map(() => 0) };
    s.count++; s.sumMs += ms;
    if (status >= 500) s.errors5xx++; else if (status >= 400) s.errors4xx++;
    BUCKETS_MS.forEach((b, i) => { if (ms <= b) s.buckets[i]!++; });
    this.stats.set(k, s);
    const t = this.ctx.clock.now().getTime();
    this.samples.push({ t, ms, status });
    while (this.samples.length && t - this.samples[0]!.t > 24 * HOUR_MS) this.samples.shift();
  }

  private window(minutes: number) {
    const t = this.ctx.clock.now().getTime();
    const xs = this.samples.filter((s) => t - s.t <= minutes * 60_000);
    const sorted = xs.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : null;
    const e5 = xs.filter((s) => s.status >= 500).length;
    return { requests: xs.length, errors5xx: e5, availabilityPct: xs.length ? (100 - (e5 * 100) / xs.length).toFixed(3) : null, p95Ms: p95 === null ? null : Math.round(p95) };
  }

  /** Format d'exposition texte Prometheus 0.0.4 (compteurs, histogramme de latence, jauges). */
  prometheus(): string {
    const lines: string[] = [];
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push('# HELP mosolo_http_requests_total Requêtes HTTP traitées, par méthode, gabarit de route et classe de statut.', '# TYPE mosolo_http_requests_total counter');
    for (const s of this.stats.values()) {
      const ok = s.count - s.errors4xx - s.errors5xx;
      for (const [cls, n] of [['2xx', ok], ['4xx', s.errors4xx], ['5xx', s.errors5xx]] as const) if (n) lines.push(`mosolo_http_requests_total{method="${s.method}",route="${esc(s.route)}",status_class="${cls}"} ${n}`);
    }
    lines.push('# HELP mosolo_http_request_duration_ms Latence des requêtes HTTP (millisecondes).', '# TYPE mosolo_http_request_duration_ms histogram');
    for (const s of this.stats.values()) {
      const lbl = `method="${s.method}",route="${esc(s.route)}"`;
      BUCKETS_MS.forEach((b, i) => lines.push(`mosolo_http_request_duration_ms_bucket{${lbl},le="${b}"} ${s.buckets[i]}`));
      lines.push(`mosolo_http_request_duration_ms_bucket{${lbl},le="+Inf"} ${s.count}`, `mosolo_http_request_duration_ms_sum{${lbl}} ${s.sumMs.toFixed(3)}`, `mosolo_http_request_duration_ms_count{${lbl}} ${s.count}`);
    }
    const w = this.window(ALERT_WINDOW_MIN);
    lines.push('# HELP mosolo_uptime_seconds Durée depuis le démarrage du service.', '# TYPE mosolo_uptime_seconds gauge', `mosolo_uptime_seconds ${Math.round((this.ctx.clock.now().getTime() - this.startedAt) / 1000)}`);
    lines.push('# HELP mosolo_availability_ratio Part des requêtes sans erreur serveur (fenêtre glissante).', '# TYPE mosolo_availability_ratio gauge', `mosolo_availability_ratio ${w.availabilityPct === null ? 'NaN' : (Number(w.availabilityPct) / 100).toFixed(5)}`);
    lines.push('# HELP mosolo_audit_chain_length Longueur du journal d’audit chaîné.', '# TYPE mosolo_audit_chain_length gauge', `mosolo_audit_chain_length ${this.ctx.audit.list({ limit: 1 }).total ?? 0}`);
    lines.push('# HELP mosolo_ops_incidents_open Incidents d’exploitation ouverts.', '# TYPE mosolo_ops_incidents_open gauge', `mosolo_ops_incidents_open ${this.incidents.find((i) => i.status !== 'CLOS' && i.status !== 'RETABLI').length}`);
    const mem = process.memoryUsage();
    lines.push('# HELP mosolo_process_resident_memory_bytes Mémoire résidente du processus.', '# TYPE mosolo_process_resident_memory_bytes gauge', `mosolo_process_resident_memory_bytes ${mem.rss}`);
    return `${lines.join('\n')}\n`;
  }

  /** Évaluation des alertes (disponibilité, latence, erreurs) : levée une seule fois par fenêtre, sans effet automatique. */
  evaluateAlerts(): { code: string; raised: boolean; detail: string }[] {
    const w = this.window(ALERT_WINDOW_MIN);
    const out: { code: string; raised: boolean; detail: string }[] = [];
    if (w.requests < MIN_REQUESTS_FOR_ALERT) return out;
    const slot = Math.floor(this.ctx.clock.now().getTime() / (ALERT_WINDOW_MIN * 60_000));
    const raise = (code: string, severity: 'HIGH' | 'MEDIUM', detail: string) => {
      const raised = !!this.ctx.alerts.raiseOnce(`supervision:${code}:${slot}`, { type: `SUPERVISION_${code}`, severity, source: 'plateforme:supervision', detail, context: { window: w }, notifyRoles: ['R27', 'R28'] });
      out.push({ code, raised, detail });
    };
    if (w.availabilityPct !== null && Number(w.availabilityPct) < Number(SLO_AVAILABILITY_PCT)) raise('DISPONIBILITE', 'HIGH', `Disponibilité ${w.availabilityPct} % sur ${ALERT_WINDOW_MIN} min, sous la cible de ${SLO_AVAILABILITY_PCT} % (§ 28.6) : ${w.errors5xx} erreur(s) serveur sur ${w.requests} requêtes.`);
    if (w.p95Ms !== null && w.p95Ms > LATENCY_P95_ALERT_MS) raise('LATENCE', 'MEDIUM', `Latence p95 ${w.p95Ms} ms sur ${ALERT_WINDOW_MIN} min, au-delà du seuil par défaut de ${LATENCY_P95_ALERT_MS} ms.`);
    if (w.errors5xx > 0 && w.errors5xx * 100 >= w.requests) raise('ERREURS', 'MEDIUM', `${w.errors5xx} erreur(s) serveur sur ${w.requests} requêtes (≥ 1 %).`);
    return out;
  }

  // ─────────────────────────── incidents et astreinte ───────────────────────────

  addShift(user: User, input: { userId: string; level: 'PRINCIPAL' | 'SECOURS'; from: string; to: string }) {
    authorize(user, 'plateforme:supervision.manage');
    if (!this.ctx.users.get(input.userId)) throw notFound('USER_NOT_FOUND', `Personne inconnue : ${input.userId}`);
    if (input.to <= input.from) throw badRequest('INVALID_PERIOD', 'Fin d’astreinte avant le début.');
    const s = this.shifts.insert({ id: this.ids.next('AST'), ...input, createdBy: user.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.oncall.scheduled', resourceType: 'oncall_shift', resourceId: s.id, details: { userId: s.userId, level: s.level, from: s.from, to: s.to } });
    return s;
  }

  onCallNow() {
    const now = this.now();
    return this.shifts.find((s) => s.from <= now && s.to > now).map((s) => ({ ...s, name: this.ctx.users.get(s.userId)?.name ?? s.userId }));
  }

  declare(user: User, input: { title: string; service: string; severity: Severity; detectedAt?: string; deploymentId?: string }) {
    authorize(user, 'plateforme:supervision.incident');
    const at = this.now();
    if (input.detectedAt && input.detectedAt > at) throw badRequest('FUTURE_DETECTION', 'Détection postérieure à l’heure du serveur.');
    const i = this.incidents.insert({ id: this.ids.next('INC-EXP'), title: input.title, service: input.service, severity: input.severity, detectedAt: input.detectedAt ?? at, declaredBy: user.id, declaredAt: at, ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}), status: 'DECLARE', timeline: [{ at, by: user.id, step: 'DECLARE' }] });
    const onCall = this.onCallNow();
    const recipients = (onCall.length ? onCall.map((s) => this.ctx.users.get(s.userId)!).filter(Boolean) : this.ctx.users.withRole('R27'));
    this.ctx.alerts.raise({ type: 'INCIDENT_EXPLOITATION', severity: input.severity === 'S1' ? 'CRITICAL' : input.severity === 'S2' ? 'HIGH' : 'MEDIUM', source: 'plateforme:supervision', detail: `${i.id} — ${i.title} (${i.service}, ${i.severity})`, context: { incidentId: i.id, astreinte: recipients.map((u) => u.id) }, notifyRoles: ['R27', 'R28'] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.incident.declared', resourceType: 'ops_incident', resourceId: i.id, details: { severity: i.severity, service: i.service, onCall: recipients.map((u) => u.id) } });
    return { incident: i, notified: recipients.map((u) => u.id) };
  }

  private incident(id: string) {
    const i = this.incidents.get(id);
    if (!i) throw notFound('INCIDENT_NOT_FOUND', `Incident inconnu : ${id}`);
    return i;
  }

  step(user: User, id: string, input: { step: 'PRISE_EN_CHARGE' | 'RETABLI' | 'CLOS'; note: string; rootCause?: string; postMortemSha256?: string }) {
    authorize(user, 'plateforme:supervision.incident');
    const i = this.incident(id);
    const at = this.now();
    let next: OpsIncident;
    if (input.step === 'PRISE_EN_CHARGE') {
      if (i.status !== 'DECLARE') throw conflict('INVALID_STATE', `Incident au statut ${i.status}.`);
      next = { ...i, status: 'PRIS_EN_CHARGE', acknowledged: { by: user.id, at } };
    } else if (input.step === 'RETABLI') {
      if (!['DECLARE', 'PRIS_EN_CHARGE'].includes(i.status)) throw conflict('INVALID_STATE', `Incident au statut ${i.status}.`);
      next = { ...i, status: 'RETABLI', restored: { by: user.id, at, action: input.note } };
    } else {
      if (i.status !== 'RETABLI') throw conflict('RESTORE_FIRST', 'Clôture après rétablissement seulement.');
      if (!input.rootCause || !input.postMortemSha256) throw badRequest('POST_MORTEM_REQUIRED', 'Clôture : cause racine et empreinte de la revue post-incident requises.');
      if (i.severity === 'S1' || i.severity === 'S2') assertDistinctPerson(user.id, [i.restored!.by], 'Incident majeur : la clôture est prononcée par une personne distincte de celle qui a rétabli le service.');
      next = { ...i, status: 'CLOS', closed: { by: user.id, at, rootCause: input.rootCause, postMortemSha256: input.postMortemSha256 } };
    }
    const out = this.incidents.update({ ...next, timeline: [...i.timeline, { at, by: user.id, step: input.step, note: input.note }] });
    this.ctx.audit.append({ actor: actorOf(user), action: `plateforme.incident.${input.step.toLowerCase()}`, resourceType: 'ops_incident', resourceId: id, details: { note: input.note } });
    return out;
  }

  setPhase(user: User, phase: Phase) {
    authorize(user, 'plateforme:supervision.manage');
    if (!(phase in RTO_HOURS)) throw badRequest('INVALID_PHASE', 'Phase inconnue.');
    if (user.roles.every((r) => r !== 'R26')) throw forbidden('FORBIDDEN', 'Changement de phase réservé au super-administrateur.');
    this.phase = phase;
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.supervision.phase_set', resourceType: 'supervision', resourceId: 'phase', details: { phase, rtoHours: RTO_HOURS[phase] } });
    return { phase, rtoHours: RTO_HOURS[phase] };
  }

  view(user: User, probes: { total: number; ok: number } | null) {
    authorize(user, 'plateforme:supervision.read');
    const alerts = this.evaluateAlerts();
    const all = this.incidents.all().sort((a, b) => (a.declaredAt < b.declaredAt ? 1 : -1));
    const rto = RTO_HOURS[this.phase];
    const ttr = all.filter((i) => i.restored).map((i) => ({ id: i.id, hours: (Date.parse(i.restored!.at) - Date.parse(i.detectedAt)) / HOUR_MS }));
    const mean = ttr.length ? ttr.reduce((a, b) => a + b.hours, 0) / ttr.length : null;
    const w24 = this.window(24 * 60);
    const availability = probes && probes.total
      ? { measured: true, value: ((probes.ok * 100) / probes.total).toFixed(3), source: 'Sondes de disponibilité externes (registre des sondes)' }
      : w24.availabilityPct !== null ? { measured: true, value: w24.availabilityPct, source: 'Requêtes servies sans erreur serveur (24 h, mesure interne)' } : { measured: false, value: null, source: 'Aucune requête ni sonde : non mesurable.' };
    return {
      targets: { availabilityPct: SLO_AVAILABILITY_PCT, rtoHours: RTO_HOURS, phase: this.phase, source: 'Cahier § 28.6' },
      thresholds: { latencyP95Ms: LATENCY_P95_ALERT_MS, windowMinutes: ALERT_WINDOW_MIN, minRequests: MIN_REQUESTS_FOR_ALERT, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      window15: this.window(ALERT_WINDOW_MIN), window24h: w24,
      routes: [...this.stats.values()].sort((a, b) => b.count - a.count).slice(0, 25).map((s) => ({ method: s.method, route: s.route, count: s.count, errors5xx: s.errors5xx, errors4xx: s.errors4xx, meanMs: s.count ? Math.round(s.sumMs / s.count) : null })),
      alerts, onCall: this.onCallNow(), shifts: this.shifts.all(), incidents: all,
      procedure: ['1. Déclarer (service, sévérité S1 à S4, heure de détection) : l’astreinte est notifiée.', '2. Prise en charge par l’astreinte.', '3. Rétablissement : action menée, heure du serveur.', '4. Clôture : cause racine et revue post-incident (empreinte) ; incident majeur clos par une personne distincte.'],
      logs: { redacted: ['authorization', 'cookie', 'x-demo-user', 'signatures', 'empreinte de certificat', 'paramètres de requête', 'numéros', 'courriels'], note: 'Journaux sans secrets ni données personnelles inutiles.' },
      metricsEndpoint: 'GET /v1/plateforme/metrics (format texte Prometheus)',
      indicators: [
        { code: 'DISPONIBILITE', label: 'Disponibilité', measured: availability.measured, value: availability.value, unit: '%', target: SLO_AVAILABILITY_PCT, source: availability.source, meetsTarget: availability.value === null ? null : Number(availability.value) >= Number(SLO_AVAILABILITY_PCT) },
        mean === null
          ? { code: 'DELAI_RETABLISSEMENT', label: 'Délai moyen de rétablissement', measured: false, value: null, unit: 'heures', target: rto, reason: 'Aucun incident rétabli : pas encore mesurable.' }
          : { code: 'DELAI_RETABLISSEMENT', label: 'Délai moyen de rétablissement', measured: true, value: mean.toFixed(2), unit: 'heures', target: rto, meetsTarget: mean <= rto, beyondRto: ttr.filter((x) => x.hours > rto).map((x) => x.id) },
      ],
    };
  }
}
