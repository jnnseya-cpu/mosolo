/**
 * ParkSmart (module 75) — tarification dynamique AUTOMATIQUE à l'intérieur des fourchettes fixées par l'acte, pour
 * maintenir 15 à 25 % de places libres (décision du maître d'ouvrage du 27/09/2026), construite PAR-DESSUS les grilles
 * tarifaires et les recommandations existantes (`smart.ts`) — rien n'est retiré :
 *
 *  - L'ACTE est la règle tarifaire ACTIVE de la zone (registre, quatre visas). Sa formule utilise l'entrée
 *    `tarif_dynamique` ; sa table porte les FOURCHETTES par zone et par heure, jamais inventées par le code :
 *      `fourchette_min.<CODE_ZONE>.<HH>` / `fourchette_max.<CODE_ZONE>.<HH>` (heure de Kinshasa, 00 à 23),
 *      à défaut `fourchette_min.<CODE_ZONE>` / `fourchette_max.<CODE_ZONE>` (toutes heures),
 *      et le pas d'ajustement `pas_ajustement.<CODE_ZONE>` ou `pas_ajustement`.
 *  - Chaque heure écoulée, pour chaque zone ouverte munie de fourchettes, le taux de places libres observé (sessions
 *    payées, réservations, ou capteur) est comparé à la cible : moins de 15 % → hausse d'un pas, plus de 25 % → baisse
 *    d'un pas, toujours bornée par la fourchette de l'heure ; le nouveau tarif s'applique à la même heure les jours
 *    suivants (liquidation au tarif en vigueur à l'heure de l'achat, heure du serveur). Le tarif initial d'une heure
 *    est le minimum de sa fourchette (le plus favorable à l'usager).
 *  - Hors fourchette (le tarif est à la borne et l'écart persiste), sans acte (zone non ouverte, règle non ACTIVE) ou
 *    sans fourchette dans la règle : RECOMMANDATION seulement, par le circuit existant (décision humaine, nouvelle
 *    version de règle à quatre visas).
 *  - Idempotent (une évaluation par zone, par jour et par heure), journalisé avant/après (`parking.pricing.auto_adjusted`),
 *    planificateur horaire (désactivé sous les tests, `MOSOLO_PARKSMART_PRICING_SCHEDULER`). Jamais une sanction.
 */
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS, kinshasaDate } from '../../core/clock.js';
import { dec, decToString } from '../../core/decimal.js';
import { badRequest, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import type { ParkingService, ParkingZone } from './service.js';
import { FREE_TARGET, kinshasaHour, type ParkSmart } from './smart.js';
import { activeRule, DGTK, enginePrincipal } from './support.js';

export const DYNAMIC_INPUT = 'tarif_dynamique';
const hh = (h: number) => String(h).padStart(2, '0');

export interface DynamicBand { min: string; max: string; step: string | null; source: string }

export interface DynamicRate {
  /** `<zoneId>|<HH>` */
  id: string;
  zoneId: string;
  hour: number;
  rate: string;
  currency: string;
  ruleCode: string;
  ruleVersion: number;
  band: { min: string; max: string };
  /** Dernière heure évaluée (jour de Kinshasa) : garantit l'idempotence du planificateur. */
  lastEvaluated: string | null;
  updatedAt: string;
  history: { at: string; date: string; from: string; to: string; freeRate: string | null; reason: string; trigger: 'PLANIFIEE' | 'MANUELLE' }[];
}

export interface PricingRun {
  id: string;
  date: string;
  hour: number;
  trigger: 'PLANIFIEE' | 'MANUELLE';
  by: string;
  at: string;
  adjusted: { zoneId: string; from: string; to: string; freeRate: string | null }[];
  unchanged: { zoneId: string; freeRate: string | null }[];
  recommendationOnly: { zoneId: string; reason: string }[];
  recommendations: string[];
}

const cmp = (a: string, b: string) => { const x = dec(a); const y = dec(b); return x < y ? -1 : x > y ? 1 : 0; };
const clamp = (v: string, band: { min: string; max: string }) => (cmp(v, band.min) < 0 ? band.min : cmp(v, band.max) > 0 ? band.max : v);
const norm = (v: string) => decToString(dec(v));

export class TarificationDynamique {
  readonly rates = new InMemoryRepository<DynamicRate>();
  readonly runs = new InMemoryAppendOnlyRepository<PricingRun>();
  private readonly ids = new IdGenerator();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Principal technique du planificateur (régie DGTK) : jamais sélectionnable comme utilisateur de démonstration. */
  readonly system: User = { ...enginePrincipal('svc-parksmart-tarification', 'Tarification dynamique ParkSmart (calendrier horaire)', DGTK), roles: ['R07'] };

  constructor(private readonly ctx: AppContext, private readonly svc: ParkingService, private readonly smart: ParkSmart) {}

  private now() { return this.ctx.clock.now(); }

  /** La règle tarifaire utilise-t-elle la tarification dynamique (entrée `tarif_dynamique`) ? */
  usesDynamic(rule: RuleRecord): boolean {
    return this.ctx.rules.requiredInputs(rule).includes(DYNAMIC_INPUT);
  }

  /** Fourchette de l'acte pour une zone et une heure (clé horaire, puis clé de zone) ; null si l'acte n'en fixe pas. */
  band(rule: RuleRecord, z: ParkingZone, hour: number): DynamicBand | null {
    const t = rule.rateTable;
    const pick = (k: string) => [`${k}.${z.code}.${hh(hour)}`, `${k}.${z.code}`].find((key) => Object.hasOwn(t, key));
    const kmin = pick('fourchette_min');
    const kmax = pick('fourchette_max');
    if (!kmin || !kmax) return null;
    const min = norm(t[kmin]!);
    const max = norm(t[kmax]!);
    if (cmp(min, max) > 0) return null;
    const kstep = [`pas_ajustement.${z.code}`, 'pas_ajustement'].find((key) => Object.hasOwn(t, key));
    return { min, max, step: kstep ? norm(t[kstep]!) : null, source: `${kmin} / ${kmax}${kstep ? ` / ${kstep}` : ''} (règle ${rule.code} v${rule.version})` };
  }

  /** État d'une zone : automatique (acte + fourchettes) ou recommandation seulement, avec le motif. */
  zoneMode(z: ParkingZone): { mode: 'AUTOMATIQUE' | 'RECOMMANDATION_SEULEMENT'; reason: string; rule: RuleRecord | null } {
    const st = this.svc.zoneStatus(z).legalStatus;
    const rule = activeRule(this.ctx, z.tariffRuleCode);
    if (st !== 'OUVERTE' || !rule) return { mode: 'RECOMMANDATION_SEULEMENT', reason: `Sans acte : zone ${st === 'OUVERTE' ? 'sans règle tarifaire ACTIVE' : `au statut ${st}`}.`, rule };
    if (!this.usesDynamic(rule)) return { mode: 'RECOMMANDATION_SEULEMENT', reason: `La règle ${rule.code} v${rule.version} ne prévoit pas de tarif dynamique (entrée « ${DYNAMIC_INPUT} ») : tarif fixe, recommandations seulement.`, rule };
    const any = Array.from({ length: 24 }, (_, h) => this.band(rule, z, h)).some((b) => b !== null);
    if (!any) return { mode: 'RECOMMANDATION_SEULEMENT', reason: `La règle ${rule.code} v${rule.version} ne fixe aucune fourchette pour la zone ${z.code}.`, rule };
    return { mode: 'AUTOMATIQUE', reason: `Fourchettes fixées par la règle ${rule.code} v${rule.version}.`, rule };
  }

  private rateRecord(z: ParkingZone, rule: RuleRecord, hour: number, band: DynamicBand): DynamicRate {
    const id = `${z.id}|${hh(hour)}`;
    const existing = this.rates.get(id);
    if (existing && existing.ruleCode === rule.code && existing.ruleVersion === rule.version) {
      // Nouvelle fourchette de la même version : impossible (règle figée) ; conservation telle quelle.
      return existing;
    }
    // Nouvelle version de l'acte : le tarif en vigueur est ramené dans la nouvelle fourchette (journalisé).
    const rate = existing ? clamp(existing.rate, band) : band.min;
    const rec: DynamicRate = {
      id, zoneId: z.id, hour, rate, currency: rule.currency, ruleCode: rule.code, ruleVersion: rule.version, band: { min: band.min, max: band.max },
      lastEvaluated: existing?.lastEvaluated ?? null, updatedAt: this.now().toISOString(),
      history: [...(existing?.history ?? []), ...(existing && existing.rate !== rate ? [{ at: this.now().toISOString(), date: kinshasaDate(this.now()), from: existing.rate, to: rate, freeRate: null, reason: `Nouvelle version de l’acte (${rule.code} v${rule.version}) : tarif ramené dans la fourchette.`, trigger: 'PLANIFIEE' as const }] : [])],
    };
    return existing ? this.rates.update(rec) : this.rates.insert(rec);
  }

  /**
   * Tarif dynamique en vigueur pour une zone à un instant (entrée `tarif_dynamique` de la liquidation). Refus sans
   * fourchette pour l'heure : aucun tarif inventé.
   */
  currentRate(z: ParkingZone, rule: RuleRecord, at: Date): string {
    const hour = kinshasaHour(at);
    const band = this.band(rule, z, hour);
    if (!band) throw unprocessable('DYNAMIC_BAND_MISSING', `La règle ${rule.code} v${rule.version} ne fixe pas de fourchette pour la zone ${z.code} à ${hh(hour)} h : aucun tarif ne peut être appliqué.`);
    return clamp(this.rateRecord(z, rule, hour, band).rate, band);
  }

  /**
   * Évaluation d'une heure écoulée (défaut : l'heure précédente de Kinshasa) : ajustement automatique borné par la
   * fourchette, sinon recommandation. Même chemin pour le planificateur et pour la régie.
   */
  run(user: User | 'system', input: { date?: string; hour?: number } = {}): PricingRun {
    const actor = user === 'system' ? this.system : user;
    if (user !== 'system') authorize(user, 'parking:zone.manage', { entity: DGTK });
    const trigger: PricingRun['trigger'] = user === 'system' ? 'PLANIFIEE' : 'MANUELLE';
    const prev = new Date(this.now().getTime() - HOUR_MS);
    const date = input.date ?? kinshasaDate(prev);
    const hour = input.hour ?? kinshasaHour(prev);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || hour < 0 || hour > 23) throw badRequest('INVALID_HOUR', 'Jour AAAA-MM-JJ et heure 0 à 23 attendus.');
    const nowIso = this.now().toISOString();
    const out: PricingRun = { id: this.ids.next(`PKDYN-${date}-${hh(hour)}`), date, hour, trigger, by: actor.id, at: nowIso, adjusted: [], unchanged: [], recommendationOnly: [], recommendations: [] };
    const recommend = (zoneId: string, target: string, freeRate: string | null, basis: string) => {
      if (target !== 'SATURE' && target !== 'SOUS_UTILISE') return;
      const r = this.smart.prepareRecommendation(zoneId, { date, hour, direction: target === 'SATURE' ? 'HAUSSE_A_ETUDIER' : 'BAISSE_A_ETUDIER', basis, freeRate });
      if (r) out.recommendations.push(r.id);
    };
    for (const z of this.svc.zones.all().sort((a, b) => a.code.localeCompare(b.code))) {
      if (z.capacity.standard <= 0) continue;
      const m = this.zoneMode(z);
      const profile = this.smart.hourlyProfile(z, date)[hour];
      if (!profile || !profile.observed) continue;
      if (m.mode !== 'AUTOMATIQUE' || !m.rule) {
        if (this.svc.zoneStatus(z).legalStatus === 'OUVERTE') { out.recommendationOnly.push({ zoneId: z.id, reason: m.reason }); recommend(z.id, profile.target, profile.freeRate, `${m.reason} Recommandation seulement : nouvelle version de règle à quatre visas.`); }
        continue;
      }
      const band = this.band(m.rule, z, hour);
      if (!band) { out.recommendationOnly.push({ zoneId: z.id, reason: `Aucune fourchette de l’acte pour ${hh(hour)} h.` }); continue; }
      const rec = this.rateRecord(z, m.rule, hour, band);
      const key = `${date}|${hh(hour)}`;
      if (rec.lastEvaluated === key) { out.unchanged.push({ zoneId: z.id, freeRate: profile.freeRate }); continue; }
      let next = rec.rate;
      let reason = `Taux de places libres ${profile.freeRate ?? '—'} % dans la cible ${FREE_TARGET.minPct}–${FREE_TARGET.maxPct} % : tarif inchangé.`;
      if (profile.target === 'SATURE' || profile.target === 'SOUS_UTILISE') {
        if (!band.step) {
          out.recommendationOnly.push({ zoneId: z.id, reason: 'Pas d’ajustement non fixé par l’acte : recommandation seulement.' });
          recommend(z.id, profile.target, profile.freeRate, 'Pas d’ajustement non fixé par l’acte : recommandation seulement.');
          this.rates.update({ ...rec, lastEvaluated: key });
          continue;
        }
        const up = profile.target === 'SATURE';
        const target = up ? decToString(dec(rec.rate) + dec(band.step)) : decToString(dec(rec.rate) - dec(band.step));
        next = clamp(target, band);
        if (next === rec.rate) {
          // À la borne de la fourchette et l'écart persiste : hors fourchette → recommandation (décision humaine).
          const why = `Tarif à la borne ${up ? 'haute' : 'basse'} de la fourchette (${up ? band.max : band.min}) : hors fourchette, recommandation seulement.`;
          out.recommendationOnly.push({ zoneId: z.id, reason: why });
          recommend(z.id, profile.target, profile.freeRate, `${why} Toute nouvelle fourchette est une nouvelle version de la règle (quatre visas).`);
          this.rates.update({ ...rec, lastEvaluated: key });
          continue;
        }
        reason = `${profile.freeRate} % de places libres (${up ? `< ${FREE_TARGET.minPct}` : `> ${FREE_TARGET.maxPct}`} %) : ${up ? 'hausse' : 'baisse'} d’un pas (${band.step}) dans la fourchette ${band.min}–${band.max}.`;
      }
      const changed = next !== rec.rate;
      this.rates.update({
        ...rec, rate: next, lastEvaluated: key, updatedAt: nowIso,
        history: changed ? [...rec.history, { at: nowIso, date, from: rec.rate, to: next, freeRate: profile.freeRate, reason, trigger }] : rec.history,
      });
      if (changed) {
        out.adjusted.push({ zoneId: z.id, from: rec.rate, to: next, freeRate: profile.freeRate });
        this.ctx.audit.append({
          actor: actorOf(actor), action: 'parking.pricing.auto_adjusted', resourceType: 'parking_zone', resourceId: z.id,
          details: { hour: hh(hour), date, before: rec.rate, after: next, currency: rec.currency, freeRate: profile.freeRate, band: { min: band.min, max: band.max, step: band.step }, rule: `${m.rule.code} v${m.rule.version}`, trigger },
        });
      } else out.unchanged.push({ zoneId: z.id, freeRate: profile.freeRate });
    }
    this.runs.append(out);
    this.ctx.audit.append({ actor: actorOf(actor), action: 'parking.pricing.auto_run', resourceType: 'parking_pricing_run', resourceId: out.id, details: { date, hour: hh(hour), trigger, adjusted: out.adjusted.length, recommendationOnly: out.recommendationOnly.length } });
    return out;
  }

  /** Passage du planificateur : évalue l'heure précédente une seule fois (idempotence par zone et par heure). */
  scheduledTick(): { ran: boolean } {
    const prev = new Date(this.now().getTime() - HOUR_MS);
    const date = kinshasaDate(prev);
    const hour = kinshasaHour(prev);
    if (this.runs.findOne((r) => r.date === date && r.hour === hour)) return { ran: false };
    try { this.run('system', { date, hour }); return { ran: true }; } catch (e) {
      this.ctx.audit.append({ actor: actorOf(this.system), action: 'parking.pricing.auto_run_failed', resourceType: 'parking_pricing_run', resourceId: `${date}|${hh(hour)}`, outcome: 'FAILURE', details: { error: e instanceof Error ? e.message : String(e) } });
      return { ran: false };
    }
  }

  startScheduler(tickMs = 300_000): void {
    this.stopScheduler();
    this.timer = setInterval(() => { try { this.scheduledTick(); } catch { /* journalisé */ } }, tickMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  get schedulerActive(): boolean { return this.timer !== undefined; }

  /** Vue de pilotage : mode par zone, fourchettes et tarifs en vigueur par heure, historique, derniers passages. */
  view(user: User) {
    authorize(user, 'parking:indicators', { entity: DGTK });
    const at = this.now();
    return {
      target: FREE_TARGET, scheduler: { active: this.schedulerActive, frequency: 'Chaque heure écoulée (heure de Kinshasa)' },
      zones: this.svc.zones.all().sort((a, b) => a.code.localeCompare(b.code)).map((z) => {
        const m = this.zoneMode(z);
        const hours = m.mode === 'AUTOMATIQUE' && m.rule ? Array.from({ length: 24 }, (_, h) => {
          const band = this.band(m.rule!, z, h);
          const rec = this.rates.get(`${z.id}|${hh(h)}`);
          return { hour: h, band: band ? { min: band.min, max: band.max, step: band.step } : null, rate: band ? clamp(rec?.rate ?? band.min, band) : null, lastEvaluated: rec?.lastEvaluated ?? null };
        }) : [];
        const history = this.rates.find((r) => r.zoneId === z.id).flatMap((r) => r.history.map((x) => ({ ...x, hour: r.hour }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
        const currentBand = m.rule && m.mode === 'AUTOMATIQUE' ? this.band(m.rule, z, kinshasaHour(at)) : null;
        return {
          zoneId: z.id, code: z.code, name: z.name, commune: z.commune, demo: z.demo, mode: m.mode, reason: m.reason,
          rule: m.rule ? { code: m.rule.code, version: m.rule.version, demo: m.rule.demo === true, currency: m.rule.currency } : null,
          currentHour: kinshasaHour(at), currentRate: currentBand && m.rule ? clamp(this.rates.get(`${z.id}|${hh(kinshasaHour(at))}`)?.rate ?? currentBand.min, currentBand) : null,
          hours, history,
        };
      }),
      runs: this.runs.all().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 24),
      notice: 'Tarification automatique à l’intérieur des fourchettes fixées par l’acte (règle ACTIVE du registre) pour maintenir 15 à 25 % de places libres ; hors fourchette ou sans acte : recommandation seulement, décision humaine.',
    };
  }
}

/** Planificateur horaire : actif par défaut, désactivé sous les tests ; MOSOLO_PARKSMART_PRICING_SCHEDULER=off|on. */
export function pricingSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.MOSOLO_PARKSMART_PRICING_SCHEDULER ?? '').trim().toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return !env.VITEST;
}
