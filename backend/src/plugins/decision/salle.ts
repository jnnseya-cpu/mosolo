/**
 * Salle de contrôle finances et trésorerie (module 45, § H.14 « salle de contrôle ») : suivi en temps réel des
 * règlements et des exceptions, incidents (propriétaire, sévérité, délai, preuve de clôture), surveillance des
 * changements de paramètres sensibles, et ESCALADE de toute exception ou de tout incident hors délai.
 * Aucune correction silencieuse : la salle LIT et ESCALADE ; toute correction passe par les circuits existants
 * (Trésor à quatre yeux, incidents d'intégrité, registre des seuils), journalisés.
 */
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS, kinshasaDay } from '../../core/clock.js';
import { conflict, notFound } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { isReconciled, isSettled } from '../pilotage/ladder.js';
import { CurrencyTotals } from '../pilotage/money.js';
import type { PilotageService } from '../pilotage/service.js';

/** Délai de traitement d'une exception : même valeur que le module Trésor (48 h, § 20 — par défaut, à confirmer). */
export const SALLE_EXCEPTION_SLA_HOURS = 48;

/** Familles de paramètres sensibles surveillés (préfixes d'actions du journal d'audit chaîné). */
export const SENSITIVE_FAMILIES = [
  { code: 'SEUILS', label: 'Registre des seuils anti-fraude et de sécurité', prefixes: ['integrite.threshold', 'integrite.parameter'] },
  { code: 'REGLES', label: 'Règles de recette (cycle de vie, taux, prorogations)', prefixes: ['rule.'] },
  { code: 'BENEFICIAIRES', label: 'Comptes bénéficiaires (coffre)', prefixes: ['beneficiary.', 'vault.'] },
  { code: 'REPARTITION', label: 'Clé de répartition et partage légal', prefixes: ['repartition.key', 'repartition.act', 'legal_share.'] },
  { code: 'RATTACHEMENTS', label: 'Rattachements de modules et entités', prefixes: ['acces.module', 'module.'] },
  { code: 'CLES', label: 'Clés cryptographiques et signatures', prefixes: ['integrite.key', 'socle.key', 'receipts.key'] },
  { code: 'CONFIGURATION', label: 'Configuration technique et déploiements', prefixes: ['plateforme.config', 'plateforme.deployment'] },
  { code: 'MODELES_IA', label: 'Modèles d’IA (mise en service, retour arrière)', prefixes: ['ia.model'] },
] as const;

export interface Escalation {
  id: string;
  subjectKind: 'EXCEPTION' | 'INCIDENT';
  subjectId: string;
  label: string;
  openedAt: string;
  dueAt: string;
  escalatedAt: string;
  escalatedBy: string;
  notified: string[];
  acknowledgement?: { by: string; at: string; motif: string };
}

type Integrite = { incidents?: { all(): { id: string; title: string; category: string; severity: string; status: string; ownerId?: string; declaredAt: string; dueAt: string; log: { at: string; status: string }[]; closure?: { proofSha256: string; at: string } }[] } };
type Tresor = { cases?: { all(): { id: string; status: string; decision?: { approvedAt: string } }[] } };

export class SalleControleService {
  readonly escalations = new InMemoryRepository<Escalation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly pil: () => PilotageService) {}

  private now() { return this.ctx.clock.now().toISOString(); }

  private openExceptions() {
    const cases = new Map(((this.ctx.ext.tresor as Tresor | undefined)?.cases?.all() ?? []).map((c) => [c.id, c]));
    return this.ctx.treasury.exceptions.all().map((e) => ({ ...e, status: cases.get(e.id)?.status ?? e.status })).filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE');
  }

  private incidents() {
    return (this.ctx.ext.integrite as Integrite | undefined)?.incidents?.all() ?? [];
  }

  /**
   * Escalade de toute exception ou de tout incident HORS DÉLAI (idempotente : une escalade par dossier) : notification
   * au comité finances (R05), au Trésor (R17) et à l'audit (R22). Information seulement : aucune correction automatique.
   */
  escalate(actor: User | 'system') {
    const now = this.now();
    const nowMs = Date.parse(now);
    const created: Escalation[] = [];
    const candidates: Omit<Escalation, 'id' | 'escalatedAt' | 'escalatedBy' | 'notified'>[] = [];
    for (const e of this.openExceptions()) {
      const due = Date.parse(e.openedAt) + SALLE_EXCEPTION_SLA_HOURS * HOUR_MS;
      if (nowMs > due) candidates.push({ subjectKind: 'EXCEPTION', subjectId: e.id, label: `Exception de rapprochement ${e.type}`, openedAt: e.openedAt, dueAt: new Date(due).toISOString() });
    }
    for (const i of this.incidents()) {
      if (!['RESOLU', 'CLOS'].includes(i.status) && i.dueAt < now) candidates.push({ subjectKind: 'INCIDENT', subjectId: i.id, label: `Incident ${i.category} — ${i.severity}`, openedAt: i.declaredAt, dueAt: i.dueAt });
    }
    const recipients = ['R05', 'R17', 'R22'].flatMap((r) => this.ctx.users.withRole(r as 'R05'));
    for (const c of candidates) {
      if (this.escalations.findOne((x) => x.subjectKind === c.subjectKind && x.subjectId === c.subjectId)) continue;
      const esc = this.escalations.insert({ id: this.ids.next('ESC'), ...c, escalatedAt: now, escalatedBy: actor === 'system' ? 'systeme' : actor.id, notified: [...new Set(recipients.map((u) => u.id))] });
      created.push(esc);
      this.ctx.audit.append({
        actor: actor === 'system' ? { kind: 'system', id: 'salle-de-controle' } : actorOf(actor), action: 'decision.control_room.escalated', resourceType: c.subjectKind === 'EXCEPTION' ? 'reconciliation_exception' : 'incident', resourceId: c.subjectId,
        details: { escalationId: esc.id, dueAt: c.dueAt, automaticEffect: 'AUCUN' },
      });
      if (recipients.length) this.ctx.comms.publish('approval.escalated', recipients.map(userRecipient), { objet: `${c.label} (${c.subjectId}) hors délai depuis le ${c.dueAt.slice(0, 16).replace('T', ' ')}` }, { entity: 'TRESOR' });
    }
    return created;
  }

  acknowledge(user: User, id: string, motif: string) {
    authorize(user, 'decision:salle.acknowledge');
    const e = this.escalations.get(id);
    if (!e) throw notFound('ESCALATION_NOT_FOUND', `Escalade inconnue : ${id}`);
    if (e.acknowledgement) throw conflict('ALREADY_ACKNOWLEDGED', 'Escalade déjà prise en charge.');
    const out = this.escalations.update({ ...e, acknowledgement: { by: user.id, at: this.now(), motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'decision.control_room.escalation_acknowledged', resourceType: 'escalation', resourceId: id, details: { subject: e.subjectId, motif } });
    return out;
  }

  view(user: User) {
    authorize(user, 'decision:salle.read');
    this.escalate('system');
    const pil = this.pil();
    const facts = pil.facts();
    const today = kinshasaDay(facts.asOf);
    const nowMs = Date.parse(facts.asOf);
    const at = (pred: (o: (typeof facts.orders)[number]) => string | undefined) => {
      const t = new CurrencyTotals(); let n = 0;
      facts.orders.forEach((o) => { const ts = pred(o); if (ts && kinshasaDay(ts) === today) { t.add(o.amount); n++; } });
      return { count: n, amounts: t.toJSON() };
    };
    const suspense = facts.orders.filter((o) => o.confirmedAt && !isReconciled(o));
    const exceptions = this.openExceptions();
    const byType = new Map<string, { open: number; overdue: number }>();
    for (const e of exceptions) {
      const r = byType.get(e.type) ?? { open: 0, overdue: 0 };
      r.open++; if (nowMs - Date.parse(e.openedAt) > SALLE_EXCEPTION_SLA_HOURS * HOUR_MS) r.overdue++;
      byType.set(e.type, r);
    }
    // Délai de clôture : exceptions résolues (validation à quatre yeux) et incidents clos (preuve de clôture).
    const cases = (this.ctx.ext.tresor as Tresor | undefined)?.cases?.all() ?? [];
    const openedAt = new Map(this.ctx.treasury.exceptions.all().map((e) => [e.id, e.openedAt]));
    const durations: number[] = [];
    cases.forEach((c) => { const o = openedAt.get(c.id); if (c.decision?.approvedAt && o) durations.push(Date.parse(c.decision.approvedAt) - Date.parse(o)); });
    const incidents = this.incidents();
    incidents.forEach((i) => { if (i.closure) durations.push(Date.parse(i.closure.at) - Date.parse(i.declaredAt)); });
    const meanHours = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length / HOUR_MS).toFixed(1) : null;
    const since = new Date(nowMs - 30 * 24 * HOUR_MS).toISOString();
    const records = this.ctx.audit.list({ limit: 1_000_000 }).items;
    const sensitive = SENSITIVE_FAMILIES.map((f) => {
      const hits = records.filter((r) => f.prefixes.some((p) => r.action.startsWith(p)));
      return {
        code: f.code, label: f.label, total: hits.length, last30Days: hits.filter((r) => r.at >= since).length,
        recent: hits.slice(-5).reverse().map((r) => ({ at: r.at, action: r.action, actor: r.actor.kind === 'user' ? `${r.actor.id}${r.actor.roles?.length ? ` (${r.actor.roles.join(', ')})` : ''}` : r.actor.kind, resource: `${r.resourceType}${r.resourceId ? ` ${r.resourceId}` : ''}`, reason: r.trace?.reason ?? null, seq: r.seq })),
      };
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'decision.control_room.viewed', resourceType: 'dashboard', resourceId: 'salle-controle', details: {} });
    return {
      generatedAt: facts.asOf, silentCorrection: false,
      rule: 'La salle de contrôle lit et escalade : aucune correction silencieuse. Toute correction passe par le circuit à quatre yeux du Trésor ou par le traitement tracé des incidents.',
      settlements: {
        today, confirmed: at((o) => o.confirmedAt), settled: at((o) => (isSettled(o) ? o.settledAt : undefined)), reconciled: at((o) => o.reconciledAt),
        suspense: { count: suspense.length, over48h: suspense.filter((o) => nowMs - Date.parse(o.confirmedAt!) > 48 * HOUR_MS).length },
      },
      exceptions: { open: exceptions.length, overdue: [...byType.values()].reduce((a, r) => a + r.overdue, 0), slaHours: SALLE_EXCEPTION_SLA_HOURS, byType: [...byType.entries()].map(([type, r]) => ({ type, ...r })) },
      incidents: {
        open: incidents.filter((i) => !['RESOLU', 'CLOS'].includes(i.status)).map((i) => ({ id: i.id, title: i.title, category: i.category, severity: i.severity, status: i.status, owner: i.ownerId ? this.ctx.users.get(i.ownerId)?.name ?? i.ownerId : null, dueAt: i.dueAt, overdue: i.dueAt < facts.asOf })),
        closedWithProof: incidents.filter((i) => !!i.closure).length,
        closedWithoutProof: incidents.filter((i) => i.status === 'CLOS' && !i.closure).length,
      },
      sensitiveParameters: sensitive,
      escalations: this.escalations.all().sort((a, b) => (a.escalatedAt < b.escalatedAt ? 1 : -1)),
      indicators: [
        { code: 'EXCEPTIONS_OUVERTES', label: 'Exceptions ouvertes', measured: true, value: String(exceptions.length), unit: 'exceptions' },
        meanHours === null
          ? { code: 'DELAI_CLOTURE', label: 'Délai moyen de clôture', measured: false, value: null, unit: 'heures', reason: 'Aucune exception résolue ni aucun incident clos avec preuve : pas encore mesurable.' }
          : { code: 'DELAI_CLOTURE', label: 'Délai moyen de clôture', measured: true, value: meanHours, unit: 'heures', basis: durations.length },
      ],
    };
  }
}
