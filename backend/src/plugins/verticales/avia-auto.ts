/**
 * MOSOLO AVIA — exécution AUTOMATIQUE de la facturation ou de la compensation des écarts mensuels (modules 62 et 78),
 * décision du maître d'ouvrage du 27/09/2026 (« Exécution automatique après acte ») construite PAR-DESSUS le circuit
 * existant (déclarations, pôle de rapprochement RRH, procédure contradictoire, cadre juridique) — rien n'est retiré :
 *
 *  - AVANT l'arrêté provincial (acte non enregistré ou non encore en vigueur pour le mois) : PROPOSITION seulement —
 *    le rapprochement mensuel est exécuté au calendrier, ses propositions restent à l'initiative d'un analyste, aucune
 *    obligation n'est émise (comportement d'origine inchangé, journalisé « proposition seulement »).
 *  - APRÈS l'arrêté (enregistré à quatre yeux dans `avia-cadre.ts`, mois égal ou postérieur à sa signature : jamais de
 *    rétroactivité) : chaque mois échu, le planificateur (1) exécute le rapprochement du RRH s'il manque, (2) soumet
 *    chaque écart à la procédure contradictoire existante (constat du mois, déclaration rapprochée ou rouverte),
 *    (3) FACTURE l'écart de reversement par le moteur commun de liquidation sur la règle ACTIVE du registre
 *    (`AVIA-ECART-REVERSEMENT`, base = taxe portée par les billets des embarqués non créditée à la Ville, chiffrée par le
 *    RRH) et, s'il y a lieu, les passagers embarqués sans IFA rapproché (`AVIA-TAXE-PASSAGER`) — ou (4) COMPENSE un
 *    trop-reversé : crédit en faveur de la compagnie, imputé automatiquement sur son prochain écart facturé.
 *  - Idempotent : une exécution par compagnie et par mois (clé `AVIA-AUTO-<mois>-<compagnie>`) ; un nouveau passage du
 *    planificateur, un redémarrage ou un déclenchement manuel n'émet jamais un second avis.
 *  - Audité : chaque passage (`avia.auto.run`), chaque avis (`avia.auto.billing.issued`), chaque compensation
 *    (`avia.auto.compensation.recorded`), chaque imputation et chaque refus faute de règle ACTIVE sont journalisés.
 *  - Procédure contradictoire APRÈS l'avis : la compagnie dispose du délai de l'arrêté (sinon du délai de démonstration
 *    `CONTRADICTORY_DAYS`, à vérifier) pour présenter ses observations ; chaque observation ouvre une réclamation sur
 *    l'avis par le circuit commun des recours (décision motivée d'une autorité distincte, rectification possible).
 *  - Aucune sanction : les mesures du § 11C.4 (billet non validable, suspension, retrait d'agrément) restent décidées
 *    au cas par cas par l'autorité compétente (`avia-cadre.ts`) ; aucune interférence avec Go-Pass.
 */
import { runScheduledJob } from '../../core/jobs.js';
import { isRuleExecutable, Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import { AVIA_RULE_CODE, CONTRADICTORY_DAYS, type AviaService } from './avia.js';
import type { AviaCadreService } from './avia-cadre.js';
import { centsToUsd, signedCents, usdToCents, type AviaRrhService, type RrhAirlineLine } from './avia-rrh.js';
import { P } from './policies.js';

/** Règle du registre qui liquide l'écart de reversement (formule sur `ecart_reversement`) : aucune valeur par défaut. */
export const AVIA_GAP_RULE_CODE = 'AVIA-ECART-REVERSEMENT';

export type AviaAutoKind = 'FACTURATION' | 'COMPENSATION' | 'AUCUN_MONTANT';

export interface AviaAutoBilling {
  ruleCode: string;
  ruleVersion: number;
  obligationId: string;
  amount: MoneyJSON;
  base: Record<string, string>;
  label: string;
}

export interface AviaAutoExecution {
  id: string;
  period: string;
  airlineTaxpayerId: string;
  airlineName: string;
  reconciliationId: string;
  declarationId: string | null;
  actId: string;
  actReference: string;
  trigger: 'PLANIFIEE' | 'MANUELLE';
  kind: AviaAutoKind;
  gapLabels: string[];
  remittanceGap: string;
  boardedWithoutIfa: number;
  billings: AviaAutoBilling[];
  /** Crédits de compensation antérieurs imputés sur cet avis (USD). */
  creditsApplied: { executionId: string; amount: string }[];
  /** Trop-reversé constaté : crédit en faveur de la compagnie (USD), imputé sur un prochain avis. */
  compensation: { amount: string; remaining: string; imputations: { executionId: string; amount: string; at: string }[] } | null;
  /** Écarts sans montant exécutable (règle absente, fret hors règle…) : restent des propositions. */
  notExecuted: { label: string; reason: string }[];
  contradictory: { openedAt: string; deadline: string; observations: { at: string; by: string; text: string; documents: string[]; appealIds: string[] }[] };
  at: string;
}

export interface AviaAutoRun {
  id: string;
  period: string;
  mode: 'EXECUTION' | 'PROPOSITION';
  trigger: 'PLANIFIEE' | 'MANUELLE';
  by: string;
  at: string;
  reason: string;
  reconciliationId: string | null;
  executions: string[];
  skipped: { airlineTaxpayerId: string; reason: string }[];
}

const previousMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

export class AviaAutoService {
  readonly executions = new InMemoryRepository<AviaAutoExecution>();
  readonly runs = new InMemoryRepository<AviaAutoRun>();
  private readonly ids = new IdGenerator();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Principal technique du planificateur (contrôleur DGTK) : jamais sélectionnable comme utilisateur de démonstration. */
  readonly system: User = { kind: 'user', id: 'svc-avia-auto', name: 'Exécution automatique AVIA (calendrier mensuel, après arrêté)', roles: ['R11'], entity: 'DGTK' };

  constructor(private readonly ctx: AppContext, private readonly avia: AviaService, private readonly rrh: AviaRrhService, private readonly cadre: AviaCadreService) {}

  private now() { return this.ctx.clock.now(); }

  private activeRule(code: string): RuleRecord | undefined {
    const now = this.now();
    return this.ctx.rules.list().filter((r) => r.code === code && isRuleExecutable(r, now).ok).sort((a, b) => b.version - a.version)[0];
  }

  /**
   * État de l'automatisme pour un mois : exécutable seulement si l'arrêté est enregistré (double validation) ET si le
   * mois n'est pas antérieur à sa signature (aucune rétroactivité). Sinon : proposition seulement.
   */
  mode(period: string): { mode: 'EXECUTION' | 'PROPOSITION'; reason: string; act: { id: string; reference: string; signedOn: string } | null } {
    const act = this.cadre.activeAct();
    if (!act) return { mode: 'PROPOSITION', reason: 'Arrêté provincial non enregistré : proposition seulement (rapprochement, propositions à l’initiative d’un analyste).', act: null };
    if (period < act.signedOn.slice(0, 7)) {
      return { mode: 'PROPOSITION', reason: `Mois ${period} antérieur à l’arrêté ${act.reference} (${act.signedOn}) : aucune exécution rétroactive, proposition seulement.`, act: { id: act.id, reference: act.reference, signedOn: act.signedOn } };
    }
    return { mode: 'EXECUTION', reason: `Arrêté ${act.reference} enregistré : facturation ou compensation automatique des écarts, procédure contradictoire ouverte après l’avis.`, act: { id: act.id, reference: act.reference, signedOn: act.signedOn } };
  }

  /** Délai de la procédure contradictoire après l'avis : délai de démonstration [À VÉRIFIER : fixé par l'arrêté]. */
  private contradictoryDays(): number {
    return CONTRADICTORY_DAYS;
  }

  /** Objet de rattachement de la liquidation : l'aéronef déclaré, sinon l'objet « exploitation au départ de Kinshasa ». */
  private objectFor(airline: string, declarationId: string | null): string {
    const decl = declarationId ? this.avia.declarations.get(declarationId) : undefined;
    const declared = decl?.aircraftObjectIds[0];
    if (declared) return declared;
    const existing = this.ctx.objects.objects.findOne((o) => o.taxpayerId === airline && (o.attributes.objectType === 'EXPLOITATION_AERIENNE' || o.attributes.objectType === 'AERONEF'));
    if (existing) return existing.id;
    return this.ctx.objects.create(this.system, {
      taxpayerId: airline, category: 'AUTRE', commune: 'Nsele', quartier: 'Aéroport international de N’djili (départs)', localityRank: 2, lat: -4.3858, lon: 15.4446,
      attributes: { verticale: 'avia', objectType: 'EXPLOITATION_AERIENNE', nom: 'Exploitation au départ de Kinshasa (objet de rattachement AVIA)' },
    }).id;
  }

  /** Crédits de compensation disponibles d'une compagnie (trop-reversés constatés, non encore imputés). */
  creditsOf(airline: string) {
    return this.executions.find((e) => e.airlineTaxpayerId === airline && !!e.compensation && usdToCents(e.compensation.remaining) > 0n)
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  private submitToContradictory(rec: { id: string }, line: RrhAirlineLine): string | null {
    if (line.submission) return line.submission.declarationId;
    const decl = this.avia.declarations.findOne((d) => d.taxpayerId === line.airlineTaxpayerId && d.period === this.rrh.reconciliations.get(rec.id)!.period);
    if (decl && !['DECLAREE', 'RAPPROCHEE'].includes(decl.status)) return decl.id;
    return this.rrh.submitLine(this.system, rec.id, line.airlineTaxpayerId).declaration.id;
  }

  private execute(period: string, recId: string, line: RrhAirlineLine, act: { id: string; reference: string }, trigger: AviaAutoRun['trigger']): AviaAutoExecution {
    const id = `AVIA-AUTO-${period}-${line.airlineTaxpayerId}`;
    const nowIso = this.now().toISOString();
    const declarationId = this.submitToContradictory({ id: recId }, line);
    const billings: AviaAutoBilling[] = [];
    const notExecuted: AviaAutoExecution['notExecuted'] = [];
    const creditsApplied: AviaAutoExecution['creditsApplied'] = [];
    let compensation: AviaAutoExecution['compensation'] = null;
    const gap = signedCents(line.remittanceGap);
    const objectId = () => this.objectFor(line.airlineTaxpayerId, declarationId);

    if (gap > 0n) {
      const rule = this.activeRule(AVIA_GAP_RULE_CODE);
      if (!rule) notExecuted.push({ label: `Écart de reversement ${line.remittanceGap} USD`, reason: `Aucune règle ACTIVE au registre (clé ${AVIA_GAP_RULE_CODE}) : proposition seulement.` });
      else {
        // Imputation des crédits de compensation antérieurs (trop-reversés) sur l'écart facturé : jamais sans avis.
        let due = gap;
        for (const c of this.creditsOf(line.airlineTaxpayerId)) {
          if (due === 0n) break;
          const avail = usdToCents(c.compensation!.remaining);
          const used = avail < due ? avail : due;
          due -= used;
          creditsApplied.push({ executionId: c.id, amount: centsToUsd(used) });
          this.executions.update({ ...c, compensation: { ...c.compensation!, remaining: centsToUsd(avail - used), imputations: [...c.compensation!.imputations, { executionId: id, amount: centsToUsd(used), at: nowIso }] } });
          this.ctx.audit.append({ actor: actorOf(this.system), action: 'avia.auto.compensation.imputed', resourceType: 'avia_auto_execution', resourceId: c.id, details: { on: id, amount: centsToUsd(used) } });
        }
        if (due === 0n) notExecuted.push({ label: `Écart de reversement ${line.remittanceGap} USD`, reason: 'Entièrement couvert par des compensations antérieures : aucun avis.' });
        else {
          const base = { ecart_reversement: centsToUsd(due) };
          const res = this.ctx.assessment.calculate(this.system, { ruleId: rule.id, taxpayerId: line.airlineTaxpayerId, objectId: objectId(), inputs: this.ctx.rules.pickRequiredInputs(rule, base), simulate: false });
          billings.push({ ruleCode: rule.code, ruleVersion: rule.version, obligationId: res.obligation!.id, amount: res.obligation!.amount, base, label: `Taxe portée par les billets des embarqués non créditée à la Ville (${period})` });
        }
      }
    } else if (gap < 0n) {
      compensation = { amount: centsToUsd(-gap), remaining: centsToUsd(-gap), imputations: [] };
    }
    if (line.boardedWithoutIfa > 0) {
      const rule = this.activeRule(AVIA_RULE_CODE);
      if (!rule) notExecuted.push({ label: `${line.boardedWithoutIfa} passager(s) embarqué(s) sans IFA`, reason: `Aucune règle ACTIVE au registre (clé ${AVIA_RULE_CODE}) : proposition seulement.` });
      else {
        const base = { passagers: String(line.boardedWithoutIfa) };
        const res = this.ctx.assessment.calculate(this.system, { ruleId: rule.id, taxpayerId: line.airlineTaxpayerId, objectId: objectId(), inputs: this.ctx.rules.pickRequiredInputs(rule, base), simulate: false });
        billings.push({ ruleCode: rule.code, ruleVersion: rule.version, obligationId: res.obligation!.id, amount: res.obligation!.amount, base, label: `Passagers embarqués sans IFA rapproché d’un billet (${period})` });
      }
    }
    if (line.freight.gapKg !== 0) notExecuted.push({ label: `Fret : ${line.freight.gapKg} kg d’écart`, reason: 'Taxe d’embarquement du fret hors de cette règle : écart soumis à la procédure contradictoire, décision humaine.' });

    const kind: AviaAutoKind = billings.length ? 'FACTURATION' : compensation ? 'COMPENSATION' : 'AUCUN_MONTANT';
    const deadline = kinshasaDate(new Date(this.now().getTime() + this.contradictoryDays() * DAY_MS));
    const exec = this.executions.insert({
      id, period, airlineTaxpayerId: line.airlineTaxpayerId, airlineName: line.airlineName, reconciliationId: recId, declarationId, actId: act.id, actReference: act.reference,
      trigger, kind, gapLabels: line.gapLabels, remittanceGap: line.remittanceGap, boardedWithoutIfa: line.boardedWithoutIfa,
      billings, creditsApplied, compensation, notExecuted,
      contradictory: { openedAt: nowIso, deadline, observations: [] }, at: nowIso,
    });
    // La déclaration du circuit d'origine porte l'avis ou la décision : même dossier, même procédure contradictoire.
    if (declarationId) {
      const d = this.avia.declarations.get(declarationId);
      if (d) {
        const contradictory = { openedAt: d.contradictory?.openedAt ?? nowIso, deadline: deadline > (d.contradictory?.deadline ?? '') ? deadline : d.contradictory!.deadline, observations: d.contradictory?.observations ?? [] };
        if (billings.length) {
          this.avia.declarations.update({ ...d, status: 'FACTUREE', contradictory, billing: [...d.billing, ...billings.map((b) => ({ at: nowIso, by: this.system.id, outcome: 'EMISE' as const, reason: `Exécution automatique après arrêté ${act.reference} — règle ${b.ruleCode} v${b.ruleVersion}`, obligationId: b.obligationId }))] });
        } else if (compensation) {
          this.avia.declarations.update({ ...d, status: 'COMPENSEE', contradictory, gapDecisions: [...(d.gapDecisions ?? []), { at: nowIso, by: this.system.id, outcome: 'COMPENSATION', reason: `Compensation automatique après arrêté ${act.reference} : trop-reversé de ${compensation.amount} USD imputé sur le prochain avis.`, proposalRef: recId }] });
        }
      }
    }
    for (const b of billings) {
      this.ctx.audit.append({ actor: actorOf(this.system), action: 'avia.auto.billing.issued', resourceType: 'avia_auto_execution', resourceId: id, details: { obligationId: b.obligationId, ruleCode: b.ruleCode, ruleVersion: b.ruleVersion, amount: b.amount, base: b.base, act: act.reference, trigger } });
    }
    if (compensation) this.ctx.audit.append({ actor: actorOf(this.system), action: 'avia.auto.compensation.recorded', resourceType: 'avia_auto_execution', resourceId: id, details: { amount: compensation.amount, act: act.reference, trigger } });
    for (const n of notExecuted) this.ctx.audit.append({ actor: actorOf(this.system), action: 'avia.auto.not_executed', resourceType: 'avia_auto_execution', resourceId: id, outcome: 'DENIED', details: n });
    const tp = this.ctx.taxpayers.taxpayers.get(line.airlineTaxpayerId);
    // L'avis émis est notifié par le moteur de liquidation ; la compensation et l'ouverture du contradictoire le sont ici.
    if (tp && !billings.length) this.ctx.comms.publish('appeal.info_requested', [taxpayerRecipient(tp)], { reference: id }, { entity: 'DGTK' });
    return exec;
  }

  /**
   * Passage mensuel : mois échu (défaut : mois précédent). Idempotent par compagnie et par mois. Planifié (système) ou
   * déclenché par un contrôleur habilité : même chemin, mêmes gardes.
   */
  runMonth(user: User | 'system', input: { period?: string } = {}) {
    const actor = user === 'system' ? this.system : user;
    if (user !== 'system') authorize(user, P.aviaReconcile, { entity: 'DGTK' });
    const trigger: AviaAutoRun['trigger'] = user === 'system' ? 'PLANIFIEE' : 'MANUELLE';
    const period = input.period ?? previousMonth(this.now());
    if (!/^\d{4}-\d{2}$/.test(period)) throw badRequest('INVALID_PERIOD', 'Mois attendu : AAAA-MM.');
    if (period >= kinshasaDate(this.now()).slice(0, 7)) throw unprocessable('PERIOD_NOT_CLOSED', 'Seul un mois échu est exécuté.');
    const m = this.mode(period);
    let rec = this.rrh.latest(period);
    if (!rec) {
      try { rec = this.rrh.runMonthly(this.rrh.system, period, 'AUTOMATIQUE_MENSUEL'); } catch { rec = undefined; }
    }
    const executions: string[] = [];
    const skipped: AviaAutoRun['skipped'] = [];
    if (rec && m.mode === 'EXECUTION' && m.act) {
      for (const line of rec.lines) {
        if (!line.hasGap) { skipped.push({ airlineTaxpayerId: line.airlineTaxpayerId, reason: 'Aucun écart.' }); continue; }
        if (this.executions.get(`AVIA-AUTO-${period}-${line.airlineTaxpayerId}`)) { skipped.push({ airlineTaxpayerId: line.airlineTaxpayerId, reason: 'Déjà exécuté (idempotence).' }); continue; }
        const decl = this.avia.declarations.findOne((d) => d.taxpayerId === line.airlineTaxpayerId && d.period === period);
        if (decl && ['VALIDEE', 'FACTUREE', 'COMPENSEE'].includes(decl.status) && !line.submission) {
          skipped.push({ airlineTaxpayerId: line.airlineTaxpayerId, reason: `Dossier ${decl.id} déjà décidé par une personne (${decl.status}) : aucune double facturation.` });
          continue;
        }
        try {
          executions.push(this.execute(period, rec.id, line, m.act, trigger).id);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          skipped.push({ airlineTaxpayerId: line.airlineTaxpayerId, reason });
          this.ctx.audit.append({ actor: actorOf(this.system), action: 'avia.auto.execution_failed', resourceType: 'avia_rrh_reconciliation', resourceId: rec.id, outcome: 'FAILURE', details: { airline: line.airlineTaxpayerId, reason } });
        }
      }
    }
    const run = this.runs.insert({
      id: this.ids.next(`AVIA-AUTO-RUN-${period}`), period, mode: m.mode, trigger, by: actor.id, at: this.now().toISOString(),
      reason: rec ? m.reason : `${m.reason} Aucun flux reçu pour ${period} : rien à rapprocher.`, reconciliationId: rec?.id ?? null, executions, skipped,
    });
    this.ctx.audit.append({ actor: actorOf(actor), action: 'avia.auto.run', resourceType: 'avia_auto_run', resourceId: run.id, details: { period, mode: m.mode, trigger, executions: executions.length, skipped: skipped.length, act: m.act?.reference ?? null } });
    return { run, executions: executions.map((id) => this.executions.get(id)!) };
  }

  /**
   * Passage du planificateur : le mois précédent est traité une fois en exécution ; un mois traité en « proposition »
   * est repris si l'arrêté (non rétroactif) le couvre désormais. Toute erreur est journalisée.
   */
  scheduledTick(): { ran: boolean } {
    const period = previousMonth(this.now());
    const runs = this.runs.find((r) => r.period === period);
    if (runs.some((r) => r.mode === 'EXECUTION')) return { ran: false };
    if (runs.length && this.mode(period).mode === 'PROPOSITION') return { ran: false };
    try {
      this.runMonth('system', { period });
      return { ran: true };
    } catch (e) {
      this.ctx.audit.append({ actor: actorOf(this.system), action: 'avia.auto.run_failed', resourceType: 'avia_auto_run', resourceId: period, outcome: 'FAILURE', details: { error: e instanceof Error ? e.message : String(e) } });
      return { ran: false };
    }
  }

  startScheduler(tickMs = 3_600_000): void {
    this.stopScheduler();
    this.timer = setInterval(() => { runScheduledJob(this.ctx, 'verticales.avia-facturation-auto', () => { this.scheduledTick(); }); }, tickMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  get schedulerActive(): boolean { return this.timer !== undefined; }

  // ---------------------------------------------------------------------------------------------- contradictoire

  private exec(id: string): AviaAutoExecution {
    const e = this.executions.get(id);
    if (!e) throw notFound('AVIA_AUTO_EXECUTION_NOT_FOUND', `Exécution inconnue : ${id}`);
    return e;
  }

  /**
   * Observations de la compagnie APRÈS l'avis (procédure contradictoire maintenue) : dans le délai, chaque observation
   * ouvre une réclamation sur chaque avis émis par le circuit commun des recours (décision motivée d'une autre personne).
   */
  observe(user: User, id: string, input: { text: string; documents: string[] }) {
    const e = this.exec(id);
    authorize(user, P.aviaDeclare, { taxpayerId: e.airlineTaxpayerId });
    if (kinshasaDate(this.now()) > e.contradictory.deadline) throw conflict('CONTRADICTORY_CLOSED', `Délai de la procédure contradictoire expiré le ${e.contradictory.deadline} : la voie de recours de droit commun reste ouverte.`);
    if (input.text.trim().length < 10) throw badRequest('OBSERVATIONS_REQUIRED', 'Observations de 10 caractères au moins.');
    const appealIds: string[] = [];
    for (const b of e.billings) {
      const open = this.ctx.appeals.openFor(b.obligationId);
      if (open) { appealIds.push(open.id); continue; }
      appealIds.push(this.ctx.appeals.submit(user, { obligationId: b.obligationId, grounds: `Procédure contradictoire AVIA (${e.period}) : ${input.text.trim()}` }).id);
    }
    const saved = this.executions.update({ ...e, contradictory: { ...e.contradictory, observations: [...e.contradictory.observations, { at: this.now().toISOString(), by: user.id, text: input.text.trim(), documents: input.documents, appealIds }] } });
    if (e.declarationId) {
      const d = this.avia.declarations.get(e.declarationId);
      if (d?.contradictory) this.avia.declarations.update({ ...d, contradictory: { ...d.contradictory, observations: [...d.contradictory.observations, { at: this.now().toISOString(), by: user.id, text: input.text.trim(), documents: input.documents }] } });
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.auto.observations', resourceType: 'avia_auto_execution', resourceId: id, details: { documents: input.documents.length, appealIds } });
    return this.view(saved);
  }

  view(e: AviaAutoExecution) {
    const obligations = e.billings.map((b) => {
      const ob = this.ctx.assessment.obligations.get(b.obligationId);
      const appeal = this.ctx.appeals.openFor(b.obligationId);
      return { ...b, status: ob?.status ?? null, dueDate: ob?.dueDate ?? null, appeal: appeal ? { id: appeal.id, status: appeal.status } : null };
    });
    const total = e.billings.reduce((s, b) => s.add(Money.fromJSON(b.amount)), Money.zero('USD'));
    return {
      ...e, billings: obligations, total: total.toJSON(), contradictoryOpen: kinshasaDate(this.now()) <= e.contradictory.deadline,
      notice: 'Avis émis automatiquement après l’arrêté, sur règle ACTIVE du registre ; la compagnie présente ses observations dans le délai et chaque avis reste contestable (circuit commun des recours).',
    };
  }

  list(user: User) {
    return this.executions.all()
      .filter((e) => evaluate(user, P.aviaRead, { taxpayerId: e.airlineTaxpayerId, entity: 'DGTK' }))
      .sort((a, b) => b.period.localeCompare(a.period) || a.airlineTaxpayerId.localeCompare(b.airlineTaxpayerId))
      .map((e) => this.view(e));
  }

  read(user: User, id: string) {
    const e = this.exec(id);
    if (!evaluate(user, P.aviaRead, { taxpayerId: e.airlineTaxpayerId, entity: 'DGTK' })) throw forbidden('FORBIDDEN', 'Accès refusé.');
    return this.view(e);
  }

  overview(user: User) {
    authorize(user, P.aviaRead, { entity: 'DGTK' });
    const period = previousMonth(this.now());
    const m = this.mode(period);
    const gapRule = this.activeRule(AVIA_GAP_RULE_CODE);
    const paxRule = this.activeRule(AVIA_RULE_CODE);
    const billed = this.executions.all().flatMap((e) => e.billings.map((b) => b.amount));
    const credits = this.executions.all().filter((e) => e.compensation).reduce((s, e) => s + usdToCents(e.compensation!.amount), 0n);
    const remaining = this.executions.all().filter((e) => e.compensation).reduce((s, e) => s + usdToCents(e.compensation!.remaining), 0n);
    return {
      currentMode: { period, ...m },
      scheduler: { active: this.schedulerActive, frequency: 'Mensuelle (mois échu), vérifiée chaque heure', lastRun: this.runs.all().sort((a, b) => b.at.localeCompare(a.at))[0] ?? null },
      rules: [
        { code: AVIA_GAP_RULE_CODE, label: 'Écart de reversement (taxe portée par les billets non créditée)', status: gapRule ? 'ACTIVE' : 'ACTE_REQUIS', version: gapRule?.version ?? null, demo: gapRule?.demo === true },
        { code: AVIA_RULE_CODE, label: 'Taxe passager (passagers embarqués sans IFA rapproché)', status: paxRule ? 'ACTIVE' : 'ACTE_REQUIS', version: paxRule?.version ?? null, demo: paxRule?.demo === true },
      ],
      totals: {
        executions: this.executions.count(), billed: billed.length ? [billed.reduce((s, b) => s.add(Money.fromJSON(b)), Money.zero('USD')).toJSON()] : [],
        compensated: centsToUsd(credits), creditsRemaining: centsToUsd(remaining), observations: this.executions.all().reduce((n, e) => n + e.contradictory.observations.length, 0),
      },
      runs: this.runs.all().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 24),
      executions: this.list(user),
      notice: 'Avant l’arrêté : proposition seulement. Après l’arrêté (non rétroactif) : facturation ou compensation automatique des écarts mensuels, idempotente et journalisée ; la procédure contradictoire reste ouverte après l’avis.',
    };
  }
}
