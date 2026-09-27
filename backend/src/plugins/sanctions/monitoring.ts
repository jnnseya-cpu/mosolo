/**
 * Surveillance des constats par agent (recommandation retenue par le maître d'ouvrage) : la commission de 10 % sur les
 * pénalités crée une incitation à multiplier les constats ; ce tableau la rend visible.
 *
 * Pour chaque agent et chaque module : contrôles, défauts relevés, constats, constats écartés à la vérification,
 * classés à la décision, contestés, annulés ; photos à position approximative ou à horloge douteuse ; part des
 * pénalités dans sa commission. Des SIGNAUX « à examiner » comparent l'agent à la médiane de ses pairs.
 * Un signal n'entraîne AUCUNE mesure automatique : il ouvre un examen humain (superviseur, contrôle mystère § 15A) —
 * chaque signal « à examiner » lève une alerte (anti-fraude), une seule fois par agent, signal, module et mois.
 * Signaux de collusion sur les paiements générés : délai contrôle → paiement anormalement court (médiane), part de
 * paiements générés très supérieure à celle des pairs.
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { GPS_WARN_ACCURACY_M, PAYMENT_ATTRIBUTION_MINUTES } from '../parking/field.js';
import type { ParkingService } from '../parking/service.js';
import { kinshasaMonth } from '../parking/support.js';
import { InMemoryRepository } from '../../core/repository.js';
import { inspectionWeakEvidence, type PubliciteService } from '../publicite/service.js';
import type { TitresService } from '../titres/service.js';
import type { VerticalesService } from '../verticales/service.js';
import type { TerrainService } from '../terrain/service.js';
import type { CommissionService } from './commissions.js';

export interface AgentModuleStats {
  module: string;
  moduleLabel: string;
  controls: number;
  defects: number;
  constats: number;
  rejected: number;
  retained: number;
  dismissed: number;
  contested: number;
  annulled: number;
  weakEvidence: number;
  /** Paiements générés attribués (lignes de commission « paiement »). */
  generatedPayments: number;
}

/** Alerte déjà levée pour un signal (dédoublonnage : agent, signal, module, mois de Kinshasa). */
export interface RaisedSignal { id: string; agentId: string; code: string; module: string; period: string; alertId: string; at: string }

export interface AgentSignal { code: string; module: string; level: 'A_EXAMINER' | 'INFO'; text: string }

export interface AgentMonitoringRow {
  agentId: string;
  agentName: string;
  modules: AgentModuleStats[];
  totals: Omit<AgentModuleStats, 'module' | 'moduleLabel'>;
  constatRatePct: string | null;
  penaltyCommissionSharePct: string | null;
  signals: AgentSignal[];
}

const LABEL: Record<string, string> = { STATIONNEMENT: 'Stationnement', PUBLICITE: 'Publicité', TITRES: 'Titres et pass wewa', VERTICALES: 'Verticales (plaques)', TERRAIN: 'Terrain (missions)' };
const pct = (n: number, d: number) => (d > 0 ? ((n * 100) / d).toFixed(1) : null);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Rôles de portée générale (pilotage, régies, audit, anti-fraude) : rapport complet, sans filtre de périmètre. */
const CITYWIDE_MONITOR_ROLES = new Set(['R01', 'R02', 'R05', 'R06', 'R07', 'R22', 'R23', 'R24']);

/** Seuils des signaux (paramètres à valider par l'inspection des services ; aucun effet automatique). */
export const MONITORING_THRESHOLDS = {
  minControls: 5, constatRateVsMedian: 2, minConstats: 3, rejectionPct: 30, dismissalPct: 40, contestPct: 30, weakEvidencePct: 30, penaltySharePct: 70,
  /** Délai médian contrôle rouge → session payée en deçà duquel le signal est levé (minutes). */
  checkToPaymentMedianMinutes: 3,
  /** Part de paiements générés (par défaut relevé) : au-delà de ce multiple de la médiane des pairs. */
  generatedRateVsMedian: 2,
};

export class AgentMonitoring {
  /** Signaux déjà transmis en alerte (persistés : une seule alerte par agent, signal, module et mois). */
  readonly raised = new InMemoryRepository<RaisedSignal>();

  constructor(private readonly ctx: AppContext, private readonly commissions: CommissionService) {}

  private blank(module: string): AgentModuleStats {
    return { module, moduleLabel: LABEL[module] ?? module, controls: 0, defects: 0, constats: 0, rejected: 0, retained: 0, dismissed: 0, contested: 0, annulled: 0, weakEvidence: 0, generatedPayments: 0 };
  }

  /**
   * Délais (minutes) entre les contrôles ROUGES de chaque agent et la première session de la plaque ouverte ensuite
   * dans la même zone (dans l'heure) : un délai très court et répété suggère un paiement arrangé avec l'usager.
   */
  private checkToPaymentMinutes(communes: string[] | null): Map<string, number[]> {
    const out = new Map<string, number[]>();
    const pk = this.ctx.ext.parking as ParkingService | undefined;
    if (!pk) return out;
    const sessions = new Map<string, number[]>();
    for (const s of pk.sessions.all()) {
      const k = `${s.plate}|${s.zoneId}`;
      sessions.set(k, [...(sessions.get(k) ?? []), Date.parse(s.createdAt)]);
    }
    for (const c of pk.checks.all()) {
      if (c.light !== 'ROUGE' || !c.zoneId || (communes && (!c.commune || !communes.includes(c.commune)))) continue;
      const t = Date.parse(c.at);
      const next = (sessions.get(`${c.plate}|${c.zoneId}`) ?? []).filter((x) => x >= t && x - t <= PAYMENT_ATTRIBUTION_MINUTES * 60_000).sort((a, b) => a - b)[0];
      if (next !== undefined) out.set(c.agentId, [...(out.get(c.agentId) ?? []), (next - t) / 60_000]);
    }
    return out;
  }

  /**
   * Statistiques brutes : agent → module → compteurs. `communes` : périmètre du lecteur (superviseur territorial) —
   * seuls les contrôles, constats et preuves situés dans ces communes sont comptés.
   */
  private stats(communes: string[] | null): Map<string, Map<string, AgentModuleStats>> {
    const byAgent = new Map<string, Map<string, AgentModuleStats>>();
    const inScope = (c: string | null | undefined) => !communes || (!!c && communes.includes(c));
    const get = (agent: string, module: string) => {
      if (!byAgent.has(agent)) byAgent.set(agent, new Map());
      const m = byAgent.get(agent)!;
      if (!m.has(module)) m.set(module, this.blank(module));
      return m.get(module)!;
    };
    const annulled = (obligationId: string | null | undefined) => !!obligationId && this.ctx.assessment.obligations.get(obligationId)?.status === 'ANNULEE';

    const pk = this.ctx.ext.parking as ParkingService | undefined;
    if (pk) {
      for (const c of pk.checks.all()) { if (!inScope(c.commune)) continue; const s = get(c.agentId, 'STATIONNEMENT'); s.controls += 1; if (c.light === 'ROUGE') s.defects += 1; }
      for (const v of pk.violations.all()) {
        if (!inScope(v.commune)) continue;
        const s = get(v.agentId, 'STATIONNEMENT');
        s.constats += 1;
        if (v.status === 'REJETE') s.rejected += 1;
        if (v.status === 'RETENU') s.retained += 1;
        if (v.status === 'CLASSE') s.dismissed += 1;
        if (v.contests.length) s.contested += 1;
        if (annulled(v.decision?.obligationId)) s.annulled += 1;
      }
      // Même règle que les signaux montrés au vérificateur (précision inconnue ou > 30 m, source autre que GPS, loin de
      // la zone, horloge décalée).
      for (const p of pk.field.photos.all()) if (!p.supersededBy && inScope(p.commune) && pk.field.weakEvidence(p)) get(p.agentId, 'STATIONNEMENT').weakEvidence += 1;
    }
    const pub = this.ctx.ext.publicite as PubliciteService | undefined;
    if (pub) {
      for (const i of pub.inspections.all()) {
        const kase = i.caseId ? pub.cases.get(i.caseId) : undefined;
        if (!inScope(kase?.commune ?? pub.devices.get(i.deviceId)?.commune)) continue;
        const s = get(i.inspectorId, 'PUBLICITE'); s.controls += 1; if (i.finding !== 'CONFORME') s.defects += 1;
        // Aucune photo conservée au serveur (empreintes seulement), ou position imprécise / ajustée à la main.
        if (inspectionWeakEvidence(i)) s.weakEvidence += 1;
      }
      for (const c of pub.cases.all()) {
        const insp = pub.inspections.get(c.inspectionId);
        if (!insp || !inScope(c.commune)) continue;
        const s = get(insp.inspectorId, 'PUBLICITE');
        s.constats += 1;
        if (c.status === 'REJETE_QA') s.rejected += 1;
        if (c.status === 'RETENU') s.retained += 1;
        if (c.status === 'CLASSE') s.dismissed += 1;
        if (c.contests.length) s.contested += 1;
        if (annulled(c.decision?.obligationId)) s.annulled += 1;
      }
    }
    const ti = this.ctx.ext.titres as TitresService | undefined;
    if (ti) {
      const communeOf = (p: unknown) => (p as { commune?: string } | undefined)?.commune;
      for (const e of ti.controls.all()) { if (!inScope(communeOf(e.place))) continue; const s = get(e.controllerId, 'TITRES'); s.controls += 1; if (e.result !== 'VALIDE') s.defects += 1; }
      for (const k of ti.constats.all()) {
        if (!inScope(communeOf(k.place))) continue;
        const s = get(k.controllerId, 'TITRES');
        s.constats += 1;
        if (k.status === 'CLASSE') s.dismissed += 1;
        if (k.status === 'TRANSMIS') s.retained += 1;
      }
    }
    const vx = this.ctx.ext.verticales as VerticalesService | undefined;
    if (vx) {
      for (const sc of vx.scans.all()) {
        if (!inScope(vx.plates.get(sc.plateCode)?.commune)) continue;
        const s = get(sc.by, 'VERTICALES'); s.controls += 1; if (sc.situation === 'red') s.defects += 1;
      }
    }
    const te = this.ctx.ext.terrain as TerrainService | undefined;
    if (te) {
      for (const f of te.findings.all()) {
        if (!inScope(f.commune)) continue;
        const s = get(f.agentId, 'TERRAIN');
        s.controls += 1;
        if (f.outcome === 'CONSTATE' || f.outcome === 'OBJET_NON_ENREGISTRE') { s.defects += 1; s.constats += 1; }
        // Position ajustée à la main ou déduite de la zone, ou précision au-delà du seuil (source absente : GPS).
        if (f.gps.accuracyM > GPS_WARN_ACCURACY_M || (!!f.gps.source && f.gps.source !== 'GPS')) s.weakEvidence += 1;
      }
    }
    return byAgent;
  }

  /** Rapport ; un superviseur territorial (sans rôle de portée générale) ne voit que son périmètre. */
  report(viewer?: User) {
    const T = MONITORING_THRESHOLDS;
    const scoped = !!viewer?.territory?.length && !viewer.roles.some((r) => CITYWIDE_MONITOR_ROLES.has(r));
    const raw = this.stats(scoped ? viewer!.territory! : null);
    // Commissions : un seul calcul pour tous les agents, groupé par agent.
    const earnings = this.commissions.byAgent();
    for (const [agent, mods] of raw) {
      for (const l of earnings.get(agent) ?? []) {
        const s = mods.get(l.module);
        if (s && l.source === 'PAIEMENT' && l.state !== 'ANNULEE') s.generatedPayments += 1;
      }
    }
    const intervals = this.checkToPaymentMinutes(scoped ? viewer!.territory! : null);
    // Médiane des pairs par module : paiements générés par défaut relevé.
    const peerGen = new Map<string, { agent: string; rate: number }[]>();
    for (const [agent, mods] of raw) for (const s of mods.values()) {
      if (s.defects >= T.minConstats) peerGen.set(s.module, [...(peerGen.get(s.module) ?? []), { agent, rate: s.generatedPayments / s.defects }]);
    }
    // Médiane des pairs par module : taux de constats des agents ayant au moins `minControls` contrôles.
    const peerRates = new Map<string, { agent: string; rate: number }[]>();
    for (const [agent, mods] of raw) for (const s of mods.values()) {
      if (s.controls >= T.minControls) peerRates.set(s.module, [...(peerRates.get(s.module) ?? []), { agent, rate: s.constats / s.controls }]);
    }
    const rows: AgentMonitoringRow[] = [];
    for (const [agentId, mods] of raw) {
      const modules = [...mods.values()].sort((a, b) => a.module.localeCompare(b.module));
      const totals = modules.reduce((acc, s) => {
        for (const k of ['controls', 'defects', 'constats', 'rejected', 'retained', 'dismissed', 'contested', 'annulled', 'weakEvidence', 'generatedPayments'] as const) acc[k] += s[k];
        return acc;
      }, { controls: 0, defects: 0, constats: 0, rejected: 0, retained: 0, dismissed: 0, contested: 0, annulled: 0, weakEvidence: 0, generatedPayments: 0 });
      const signals: AgentSignal[] = [];
      for (const s of modules) {
        // Médiane des AUTRES agents du module (l'agent n'est pas comparé à lui-même).
        const med = median((peerRates.get(s.module) ?? []).filter((p) => p.agent !== agentId).map((p) => p.rate));
        const rate = s.controls ? s.constats / s.controls : 0;
        if (s.controls >= T.minControls && s.constats >= T.minConstats && med > 0 && rate > T.constatRateVsMedian * med) {
          signals.push({ code: 'TAUX_CONSTATS_ELEVE', module: s.module, level: 'A_EXAMINER', text: `${s.moduleLabel} : ${(rate * 100).toFixed(0)} % de contrôles suivis d’un constat, plus du double de la médiane des pairs (${(med * 100).toFixed(0)} %).` });
        }
        const verified = s.rejected + s.retained + s.dismissed;
        if (verified >= T.minConstats && (s.rejected * 100) / verified >= T.rejectionPct) signals.push({ code: 'PREUVES_ECARTEES', module: s.module, level: 'A_EXAMINER', text: `${s.moduleLabel} : ${pct(s.rejected, verified)} % des constats écartés à la vérification (preuves insuffisantes).` });
        const decided = s.retained + s.dismissed;
        if (decided >= T.minConstats && (s.dismissed * 100) / decided >= T.dismissalPct) signals.push({ code: 'CONSTATS_CLASSES', module: s.module, level: 'A_EXAMINER', text: `${s.moduleLabel} : ${pct(s.dismissed, decided)} % des constats classés sans suite par la décision.` });
        if (s.retained >= T.minConstats && ((s.contested + s.annulled) * 100) / s.retained >= T.contestPct) signals.push({ code: 'CONTESTATIONS', module: s.module, level: 'A_EXAMINER', text: `${s.moduleLabel} : ${pct(s.contested + s.annulled, s.retained)} % des pénalités retenues contestées ou annulées.` });
        if (s.constats >= T.minConstats && (s.weakEvidence * 100) / Math.max(1, s.constats * (s.module === 'STATIONNEMENT' ? 5 : 1)) >= T.weakEvidencePct) signals.push({ code: 'PREUVES_FAIBLES', module: s.module, level: 'A_EXAMINER', text: `${s.moduleLabel} : photos ou positions souvent imprécises (GPS absent, ajusté à la main ou > ${GPS_WARN_ACCURACY_M} m, loin de la zone, horloge décalée, photo non conservée au serveur).` });
        const genMed = median((peerGen.get(s.module) ?? []).filter((p) => p.agent !== agentId).map((p) => p.rate));
        const genRate = s.defects ? s.generatedPayments / s.defects : 0;
        if (s.defects >= T.minConstats && s.generatedPayments >= T.minConstats && genMed > 0 && genRate > T.generatedRateVsMedian * genMed) {
          signals.push({ code: 'PAIEMENTS_GENERES_ELEVES', module: s.module, level: 'A_EXAMINER', text: `${s.moduleLabel} : ${(genRate * 100).toFixed(0)} % des défauts relevés suivis d’un paiement attribué, plus du double de la médiane des pairs (${(genMed * 100).toFixed(0)} %).` });
        }
      }
      const iv = intervals.get(agentId) ?? [];
      if (iv.length >= T.minConstats && median(iv) < T.checkToPaymentMedianMinutes) {
        signals.push({ code: 'PAIEMENT_IMMEDIAT', module: 'STATIONNEMENT', level: 'A_EXAMINER', text: `Stationnement : délai médian de ${median(iv).toFixed(1)} min entre le contrôle rouge et le paiement de la session (${iv.length} cas) — paiement possiblement arrangé avec l’usager.` });
      }
      const earn = (earnings.get(agentId) ?? []).filter((l) => l.state !== 'ANNULEE');
      const pen = earn.filter((l) => l.source === 'PENALITE').length;
      const share = pct(pen, earn.length);
      if (earn.length >= T.minConstats && share !== null && Number(share) >= T.penaltySharePct) signals.push({ code: 'COMMISSION_PENALITES', module: 'TOUS', level: 'INFO', text: `${share} % de la commission provient de pénalités (plutôt que de paiements provoqués) : à suivre.` });
      rows.push({
        agentId, agentName: this.ctx.users.get(agentId)?.name ?? agentId, modules, totals,
        constatRatePct: pct(totals.constats, totals.controls), penaltyCommissionSharePct: share, signals,
      });
    }
    rows.sort((a, b) => b.signals.filter((x) => x.level === 'A_EXAMINER').length - a.signals.filter((x) => x.level === 'A_EXAMINER').length || a.agentName.localeCompare(b.agentName, 'fr'));
    const alertsRaised = this.raiseAlerts(rows);
    return {
      generatedAt: this.ctx.clock.now().toISOString(), thresholds: T, rows, alertsRaised,
      notice: 'Un signal ouvre un examen humain (superviseur, contrôle mystère) ; il n’entraîne aucune mesure automatique contre l’agent. Seuils à valider par l’inspection des services.',
    };
  }

  /**
   * Chaque signal « à examiner » ouvre une alerte (anti-fraude, sécurité) pour examen humain — une seule fois par
   * agent, signal, module et mois de Kinshasa. Aucune mesure automatique contre l'agent.
   */
  private raiseAlerts(rows: AgentMonitoringRow[]): number {
    const now = this.ctx.clock.now();
    const period = kinshasaMonth(now);
    let n = 0;
    for (const r of rows) {
      for (const sig of r.signals) {
        if (sig.level !== 'A_EXAMINER') continue;
        const id = `${r.agentId}|${sig.code}|${sig.module}|${period}`;
        if (this.raised.get(id)) continue;
        const alert = this.ctx.alerts.raise({
          type: `AGENT_${sig.code}`, severity: 'MEDIUM', source: 'sanctions',
          detail: `Surveillance des agents — ${r.agentName} : ${sig.text} Examen humain requis (aucune mesure automatique).`,
          context: { agentId: r.agentId, signal: sig.code, module: sig.module, period },
        });
        this.raised.insert({ id, agentId: r.agentId, code: sig.code, module: sig.module, period, alertId: alert.id, at: now.toISOString() });
        n += 1;
      }
    }
    return n;
  }
}
