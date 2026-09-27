/**
 * Détecteurs complémentaires du plan anti-fraude (§ 25, tableau des vecteurs de fraude ; § 15A.5) — ALERTES SEULEMENT :
 *  - encaissement non déclaré : écart entre constats de terrain et paiements dans une zone ;
 *  - baisse inexpliquée des recettes d'une zone (fenêtre courante / fenêtre précédente) ;
 *  - collusion agent–contribuable : proximité récurrente agent–objet ;
 *  - rotation des zones des agents de terrain dépassée.
 * Et exécution planifiée du contrôle des ruptures de la chaîne opératoire (module chaine), selon le même schéma que la
 * détection de la collusion (setInterval + unref, désactivée sous les tests).
 * Chaque exécution est journalisée ; chaque signal est une alerte à examiner par un humain, jamais une sanction.
 */
import { Money, type CurrencyCode } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import { actorOf, type AuditActor } from '../../../core/audit.js';
import type { User } from '../../../core/auth.js';
import { DAY_MS } from '../../../core/clock.js';
import { authorize } from '../../../core/policy.js';
import { checkChainInvariants } from '../../chaine/invariants.js';
import type { TerrainService } from '../../terrain/service.js';

/** Paramètres des détecteurs — valeurs PAR_DEFAUT, à confirmer par le maître d'ouvrage (registre des seuils). */
export const DETECTEURS_PARAMS = {
  /** Écart constats / paiements : fenêtre d'analyse des constats (jours). */
  ecartFenetreJours: 90,
  /** Délai laissé au paiement après le constat avant de le compter « sans paiement » (jours). */
  ecartDelaiPaiementJours: 30,
  /** Nombre minimal de constats dans la zone pour mesurer l'écart. */
  ecartMinConstats: 5,
  /** Part de constats sans paiement à partir de laquelle une alerte est levée (%). */
  ecartPartMinPct: 60,
  /** Baisse des recettes : durée de chaque fenêtre comparée (jours). */
  baisseFenetreJours: 30,
  /** Baisse relative à partir de laquelle une alerte est levée (%). */
  baissePartMinPct: 40,
  /** Nombre minimal de paiements dans la fenêtre précédente pour mesurer une baisse. */
  baisseMinPaiements: 5,
  /** Proximité agent–objet : fenêtre (jours) et nombre d'interventions d'un même agent sur un même objet. */
  proximiteFenetreJours: 180,
  proximiteMinInterventions: 3,
  /** Exécution planifiée des détecteurs et du contrôle des ruptures de chaîne (heures ; 0 = désactivée). */
  intervalleHeures: 24,
} as const;

export type DetectorCode = 'ECART_CONSTATS_PAIEMENTS' | 'BAISSE_RECETTES_ZONE' | 'PROXIMITE_AGENT_OBJET' | 'ROTATION_ZONE_DEPASSEE';
export interface DetectorSignal { code: DetectorCode; label: string; subject: string; detail: string; variables: Record<string, unknown>; fingerprint: string }

export const DETECTORS: { code: DetectorCode; label: string; vecteur: string; source: string }[] = [
  { code: 'ECART_CONSTATS_PAIEMENTS', label: 'Écart entre constats et paiements dans une zone', vecteur: 'Encaissement en espèces non déclaré', source: 'Constats de terrain validés ↔ paiements confirmés des obligations de l’objet' },
  { code: 'BAISSE_RECETTES_ZONE', label: 'Baisse inexpliquée des recettes d’une zone', vecteur: 'Déperdition, encaissement parallèle', source: 'Paiements confirmés par commune, fenêtre courante / précédente, par devise' },
  { code: 'PROXIMITE_AGENT_OBJET', label: 'Proximité récurrente agent–objet', vecteur: 'Collusion agent–contribuable', source: 'Constats de terrain d’un même agent sur un même objet' },
  { code: 'ROTATION_ZONE_DEPASSEE', label: 'Rotation des zones des agents de terrain dépassée', vecteur: 'Collusion, capture d’une zone', source: 'Missions affectées (série sur une même commune)' },
];

const PAID = new Set(['CONFIRME', 'REGLE', 'RAPPROCHE']);

export class DetecteursService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastScheduled: number | null | undefined;

  constructor(private readonly ctx: AppContext) {}

  private terrain(): TerrainService | undefined { return this.ctx.ext.terrain as TerrainService | undefined; }
  private nowMs(): number { return this.ctx.clock.now().getTime(); }

  /* ------------------------------------------------------------ détecteurs */

  ecartConstatsPaiements(): DetectorSignal[] {
    const t = this.terrain();
    if (!t) return [];
    const P = DETECTEURS_PARAMS;
    const now = this.nowMs();
    const zones = new Map<string, { findings: number; unpaid: number; agents: Map<string, number> }>();
    for (const f of t.findings.find((x) => x.status === 'VALIDE' && x.outcome === 'CONSTATE' && !!x.objectId)) {
      const at = new Date(f.capturedAt).getTime();
      if (now - at > P.ecartFenetreJours * DAY_MS || now - at < P.ecartDelaiPaiementJours * DAY_MS) continue;
      const obligations = new Set(this.ctx.assessment.obligations.find((o) => o.objectId === f.objectId).map((o) => o.id));
      const paid = this.ctx.payments.orders.find((o) => obligations.has(o.obligationId) && PAID.has(o.status) && !!o.confirmedAt && o.confirmedAt >= f.capturedAt).length > 0;
      const z = zones.get(f.commune) ?? { findings: 0, unpaid: 0, agents: new Map() };
      z.findings++;
      if (!paid) { z.unpaid++; z.agents.set(f.agentId, (z.agents.get(f.agentId) ?? 0) + 1); }
      zones.set(f.commune, z);
    }
    const out: DetectorSignal[] = [];
    for (const [commune, z] of zones) {
      const pct = Math.round((z.unpaid * 100) / z.findings);
      if (z.findings < P.ecartMinConstats || pct < P.ecartPartMinPct) continue;
      const agents = [...z.agents.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ agentId: id, constatsSansPaiement: n }));
      out.push({
        code: 'ECART_CONSTATS_PAIEMENTS', label: DETECTORS[0]!.label, subject: commune,
        detail: `${commune} : ${z.unpaid} constat(s) validé(s) sur ${z.findings} sans paiement dans les ${P.ecartDelaiPaiementJours} jours (${pct} %, seuil ${P.ecartPartMinPct} %). Encaissement non déclaré possible : à vérifier (contre-visites, contrôle mystère).`,
        variables: { commune, constats: z.findings, sansPaiement: z.unpaid, partPct: pct, agents }, fingerprint: `DET:ECART:${commune}:${new Date(now).toISOString().slice(0, 10)}`,
      });
    }
    return out;
  }

  baisseRecettesZone(): DetectorSignal[] {
    const P = DETECTEURS_PARAMS;
    const now = this.nowMs();
    const w = P.baisseFenetreJours * DAY_MS;
    const rows = new Map<string, { cur: Money; prev: Money; curN: number; prevN: number }>();
    for (const o of this.ctx.payments.orders.find((x) => PAID.has(x.status) && !!x.confirmedAt)) {
      const at = new Date(o.confirmedAt!).getTime();
      const age = now - at;
      if (age < 0 || age >= 2 * w) continue;
      const key = `${o.attribution?.commune ?? 'NON_ATTRIBUE'}|${o.amount.currency}`;
      const zero = Money.zero(o.amount.currency as CurrencyCode);
      const r = rows.get(key) ?? { cur: zero, prev: zero, curN: 0, prevN: 0 };
      if (age < w) { r.cur = r.cur.add(Money.fromJSON(o.amount)); r.curN++; } else { r.prev = r.prev.add(Money.fromJSON(o.amount)); r.prevN++; }
      rows.set(key, r);
    }
    const out: DetectorSignal[] = [];
    for (const [key, r] of rows) {
      if (r.prevN < P.baisseMinPaiements || r.prev.isZero()) continue;
      const prev = Number(r.prev.toDecimalString());
      const drop = Math.round(((prev - Number(r.cur.toDecimalString())) * 100) / prev);
      if (drop < P.baissePartMinPct) continue;
      const [commune, currency] = key.split('|') as [string, string];
      out.push({
        code: 'BAISSE_RECETTES_ZONE', label: DETECTORS[1]!.label, subject: commune,
        detail: `${commune} (${currency}) : recettes des ${P.baisseFenetreJours} derniers jours ${r.cur.toDecimalString()} contre ${r.prev.toDecimalString()} la période précédente (−${drop} %, seuil ${P.baissePartMinPct} %). Baisse à expliquer (calendrier, règle suspendue, panne) avant toute autre hypothèse.`,
        variables: { commune, currency, courant: r.cur.toDecimalString(), precedent: r.prev.toDecimalString(), paiementsCourants: r.curN, paiementsPrecedents: r.prevN, baissePct: drop },
        fingerprint: `DET:BAISSE:${key}:${new Date(now).toISOString().slice(0, 10)}`,
      });
    }
    return out;
  }

  proximiteAgentObjet(): DetectorSignal[] {
    const t = this.terrain();
    if (!t) return [];
    const P = DETECTEURS_PARAMS;
    const now = this.nowMs();
    const pairs = new Map<string, string[]>();
    for (const f of t.findings.find((x) => !!x.objectId && now - new Date(x.capturedAt).getTime() <= P.proximiteFenetreJours * DAY_MS)) {
      const k = `${f.agentId}|${f.objectId}`;
      pairs.set(k, [...(pairs.get(k) ?? []), f.id]);
    }
    const out: DetectorSignal[] = [];
    for (const [k, ids] of pairs) {
      if (ids.length < P.proximiteMinInterventions) continue;
      const [agentId, objectId] = k.split('|') as [string, string];
      out.push({
        code: 'PROXIMITE_AGENT_OBJET', label: DETECTORS[2]!.label, subject: `${agentId} ↔ ${objectId}`,
        detail: `L’agent ${agentId} est intervenu ${ids.length} fois sur l’objet ${objectId} en ${P.proximiteFenetreJours} jours (seuil ${P.proximiteMinInterventions}). Proximité récurrente à examiner ; rotation à envisager.`,
        variables: { agentId, objectId, interventions: ids.length, constats: ids }, fingerprint: `DET:PROX:${k}:${ids.length}`,
      });
    }
    return out;
  }

  rotationDepassee(): DetectorSignal[] {
    const t = this.terrain();
    if (!t?.qualite) return [];
    const r = t.qualite.rotation();
    return r.items.filter((i) => i.overdue).map((i) => ({
      code: 'ROTATION_ZONE_DEPASSEE' as const, label: DETECTORS[3]!.label, subject: `${i.kind === 'AGENT' ? 'Agent' : 'Sous-traitant'} ${i.id}`,
      detail: `${i.kind === 'AGENT' ? 'L’agent' : 'Le sous-traitant'} ${i.name} travaille sur ${i.commune} depuis ${i.days} jours (durée maximale ${r.maxDays} j, par défaut — à confirmer) : rotation à organiser.`,
      variables: { ...i }, fingerprint: `DET:ROT:${i.kind}:${i.id}:${i.commune}:${i.since}`,
    }));
  }

  compute(): DetectorSignal[] {
    return [...this.ecartConstatsPaiements(), ...this.baisseRecettesZone(), ...this.proximiteAgentObjet(), ...this.rotationDepassee()];
  }

  /* ------------------------------------------------------------ exécution */

  run(by: User | 'system', trigger: 'MANUELLE' | 'PLANIFIEE' = 'MANUELLE') {
    if (by !== 'system') authorize(by, 'integrite:detecteurs.run');
    const actor: AuditActor = by === 'system' ? { kind: 'system', id: 'integrite:detecteurs' } : actorOf(by);
    const signals = this.compute();
    const raised = signals.map((s) => this.ctx.alerts.raiseOnce(s.fingerprint, {
      type: `DETECTEUR_${s.code}`, severity: s.code === 'ECART_CONSTATS_PAIEMENTS' ? 'HIGH' : 'MEDIUM', source: 'integrite:detecteurs', detail: s.detail,
      context: { code: s.code, subject: s.subject, variables: s.variables, automaticEffect: 'AUCUN' }, actor, notifyRoles: ['R22', 'R24'],
    })).filter((a) => a !== null);
    const chaine = checkChainInvariants(this.ctx);
    this.ctx.audit.append({
      actor, action: 'integrite.detecteurs.run', resourceType: 'detecteurs', resourceId: '*',
      details: { trigger, signals: signals.length, raised: raised.length, chaineRuptures: chaine.total, chaineAlertes: chaine.alertsRaised, automaticEffect: 'AUCUN' },
    });
    return { signals, raised: raised.length, alertIds: raised.map((a) => a!.id), chaine: { total: chaine.total, counts: chaine.counts, alertsRaised: chaine.alertsRaised }, automaticEffect: 'AUCUN' as const };
  }

  private lastScheduledRun(): number | null {
    if (this.lastScheduled === undefined) {
      const runs = this.ctx.audit.list({ action: 'integrite.detecteurs.run', limit: Number.MAX_SAFE_INTEGER }).items.filter((e) => e.details.trigger === 'PLANIFIEE');
      this.lastScheduled = runs.length ? Date.parse(runs[runs.length - 1]!.at) : null;
    }
    return this.lastScheduled;
  }

  /** Passage du planificateur : exécution si l'intervalle est écoulé depuis la dernière exécution planifiée (journalisée). */
  scheduledTick(): { ran: boolean; signals?: number } {
    const hours = DETECTEURS_PARAMS.intervalleHeures;
    if (!(hours > 0)) return { ran: false };
    const now = this.nowMs();
    const last = this.lastScheduledRun();
    if (last !== null && now - last < hours * 3_600_000) return { ran: false };
    this.lastScheduled = now;
    try {
      const r = this.run('system', 'PLANIFIEE');
      return { ran: true, signals: r.signals.length };
    } catch (e) {
      this.ctx.audit.append({
        actor: { kind: 'system', id: 'integrite:detecteurs' }, action: 'integrite.detecteurs.run_failed', resourceType: 'detecteurs', resourceId: '*', outcome: 'FAILURE',
        details: { trigger: 'PLANIFIEE', error: e instanceof Error ? e.message : String(e) },
      });
      return { ran: false };
    }
  }

  startScheduler(tickMs = 300_000): void {
    this.stopScheduler();
    this.timer = setInterval(() => { try { this.scheduledTick(); } catch { /* échec journalisé par scheduledTick */ } }, tickMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  get schedulerActive(): boolean { return this.timer !== undefined; }

  overview(user: User) {
    authorize(user, 'integrite:detecteurs.read');
    const runs = this.ctx.audit.list({ action: 'integrite.detecteurs.run', limit: Number.MAX_SAFE_INTEGER }).items;
    const last = runs.at(-1);
    return {
      detectors: DETECTORS, params: DETECTEURS_PARAMS, statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage',
      schedule: { intervalHours: DETECTEURS_PARAMS.intervalleHeures, active: this.schedulerActive, lastRunAt: last?.at ?? null, lastTrigger: (last?.details.trigger as string | undefined) ?? null, includesChainRuptures: true },
      signals: this.compute(),
      alerts: this.ctx.alerts.list().filter((a) => a.source === 'integrite:detecteurs').slice(0, 100),
      note: 'Signaux à examiner par un humain : ils ne valent ni preuve ni soupçon établi. Aucune sanction automatique.',
    };
  }
}

/** Détection planifiée : active par défaut, désactivée sous les tests (VITEST) ; MOSOLO_DETECTEURS_SCHEDULER=off|on. */
export function detecteursSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.MOSOLO_DETECTEURS_SCHEDULER ?? '').trim().toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return !env.VITEST;
}
