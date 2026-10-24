/**
 * Renseignement anti-fraude — compléments du module 40 (spécification fonctionnelle) construits SUR le module
 * d'intégrité existant (alertes, dossiers d'enquête, ligne protégée), sans circuit parallèle :
 *  - SIGNAUX complémentaires (même file d'alertes, même examen) : réutilisation d'appareils entre comptes, constats hors
 *    zone répétés, doublons de paiement, annulations et exonérations anormales, quittances manipulées présumées ;
 *  - SCORES EXPLICABLES : chaque alerte reçoit un score 0–100 décomposé (gravité, confiance), avec ses variables et
 *    leurs sources ; pondération PAR_DEFAUT à confirmer ; le score ORDONNE l'examen, il ne décide rien ;
 *  - SUSPENSION CONSERVATOIRE d'un accès technique : proposée par l'enquêteur du dossier pour une personne mise en cause,
 *    exécutée par le responsable sécurité (personne distincte), limitée dans le temps, levée par une personne ;
 *  - TRANSMISSION à l'autorité compétente après la décision de saisine : bordereau scellé (pièces par empreinte,
 *    chronologie, conclusions, décision), accusé de réception enregistré ;
 *  - DÉPERDITION ÉVITÉE : montants constatés avec pièce justificative, par dossier (sinon « non mesurée »).
 * Aucune sanction automatique : la qualification et la sanction relèvent de l'autorité compétente.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import { actorOf } from '../../../core/audit.js';
import type { User } from '../../../core/auth.js';
import { canonicalJson, hmacSha256Hex, sha256Hex } from '../../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../../core/repository.js';
import type { IntegriteService } from '../service.js';
import type { FraudAlert, FraudCase } from '../types.js';
import { enqueteParam } from './parametres.js';

const { always } = GRANTS;
definePolicy('integrite:score.read', { R24: always, R22: always, R28: always });
definePolicy('integrite:suspension.propose', { R24: always });
definePolicy('integrite:suspension.execute', { R28: always, R26: always });
definePolicy('integrite:suspension.read', { R24: always, R22: always, R28: always, R26: always });
definePolicy('integrite:transmission', { R06: always, R21: always });
definePolicy('integrite:loss.record', { R24: always, R22: always });

const DAY = 86_400_000;
/** Pondération du score (méthode publiée) — PAR_DEFAUT, à confirmer par le maître d'ouvrage. */
export const SCORE_WEIGHTS = {
  severity: { FAIBLE: 25, MOYENNE: 50, ELEVEE: 75, CRITIQUE: 100 },
  confidence: { FAIBLE: 0.5, MOYENNE: 0.75, ELEVEE: 1 },
  statut: 'PAR_DEFAUT — pondération à confirmer par le maître d’ouvrage',
} as const;

export interface ExplainedScore {
  alertId: string;
  score: number;
  band: 'FAIBLE' | 'MOYEN' | 'ELEVE';
  factors: { factor: string; value: string; contribution: string; source: string }[];
  variables: { name: string; value: string; source: string }[];
  confidence: FraudAlert['confidence'];
  method: string;
  automaticEffect: 'AUCUN';
}

export interface AccessSuspension {
  id: string;
  caseId: string;
  userId: string;
  reason: string;
  days: number;
  status: 'PROPOSEE' | 'EN_VIGUEUR' | 'LEVEE' | 'EXPIREE' | 'REFUSEE';
  proposedBy: string;
  proposedAt: string;
  execution?: { by: string; at: string; until: string };
  end?: { by: string; at: string; reason: string };
}

export interface Transmission {
  id: string;
  caseId: string;
  authority: string;
  bordereau: { pieces: { sha256: string; label: string }[]; timeline: { at: string; kind: string; text: string }[]; conclusions: unknown; decision: unknown; alerts: string[]; reports: string[] };
  bordereauHash: string;
  seal: string;
  transmittedBy: string;
  transmittedAt: string;
  acknowledgement?: { reference: string; at: string; recordedBy: string };
}

export interface LossAvoided { id: string; caseId: string; amount: MoneyJSON; evidenceSha256: string; motif: string; recordedBy: string; recordedAt: string }

export class EnquetesService {
  readonly suspensions = new InMemoryRepository<AccessSuspension>();
  readonly transmissions = new InMemoryRepository<Transmission>();
  readonly losses = new InMemoryRepository<LossAvoided>();
  private readonly ids = new IdGenerator();
  private readonly sealKey: string;

  constructor(private readonly ctx: AppContext, private readonly integrite: IntegriteService) {
    this.sealKey = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:integrite:bordereau:v1');
    integrite.extraDetectors.push((raise) => this.detect(raise));
  }

  private now() { return this.ctx.clock.now().toISOString(); }
  private p(id: string) { return enqueteParam(this.ctx, id); }

  // ───────────────────────── signaux complémentaires ─────────────────────────

  detect(raise: (a: Omit<FraudAlert, 'id' | 'status' | 'automaticEffect' | 'raisedAt' | 'history'>) => void): void {
    const now = this.ctx.clock.now().getTime();
    const terrain = this.ctx.ext['terrain'] as { findings?: { all(): { id: string; agentId: string; deviceId?: string; flags: string[]; capturedAt: string; commune: string }[] } } | undefined;
    const findings = terrain?.findings?.all() ?? [];

    // Réutilisation d'appareils : un même terminal utilisé par plusieurs comptes de travail.
    const byDevice = new Map<string, Set<string>>();
    for (const f of findings) if (f.deviceId) (byDevice.get(f.deviceId) ?? byDevice.set(f.deviceId, new Set()).get(f.deviceId)!).add(f.agentId);
    for (const o of this.ctx.field.observations.all()) (byDevice.get(o.deviceId) ?? byDevice.set(o.deviceId, new Set()).get(o.deviceId)!).add(o.agentId);
    for (const d of this.ctx.field.devices.all()) byDevice.get(d.id)?.add(d.agentUserId);
    const minAccounts = this.p('enquete.appareil_min_comptes');
    for (const [deviceId, users] of byDevice) {
      if (users.size < minAccounts) continue;
      const list = [...users].sort();
      raise({
        ruleCode: 'REUTILISATION_APPAREIL', ruleLabel: 'Réutilisation d’un appareil entre comptes',
        fingerprint: `RAP:${deviceId}:${list.join(',')}`, severity: 'ELEVEE', confidence: 'MOYENNE',
        explanation: `Le terminal ${deviceId} a servi à ${users.size} comptes de travail (${list.join(', ')}). Prêt de terminal, usurpation de compte ou erreur d’enrôlement : à vérifier.`,
        variables: [{ name: 'Terminal', value: deviceId, source: 'terminaux enrôlés, constats et lots synchronisés' }, { name: 'Comptes', value: list.join(', '), source: 'constats et lots synchronisés' }, { name: 'Seuil', value: String(minAccounts), source: 'registre des seuils (PAR_DEFAUT)' }],
        subjects: [{ kind: 'APPAREIL', ref: deviceId }, ...list.map((ref) => ({ kind: 'AGENT', ref }))],
      });
    }

    // Constats hors zone ou à distance du point enregistré, répétés par agent.
    const win = this.p('enquete.hors_zone_fenetre_jours') * DAY;
    const minOut = this.p('enquete.hors_zone_min');
    const outByAgent = new Map<string, string[]>();
    for (const f of findings) if ((f.flags.includes('HORS_ZONE') || f.flags.includes('DISTANCE')) && now - Date.parse(f.capturedAt) <= win) outByAgent.set(f.agentId, [...(outByAgent.get(f.agentId) ?? []), f.id]);
    for (const [agent, ids] of outByAgent) {
      if (ids.length < minOut) continue;
      raise({
        ruleCode: 'CONSTATS_HORS_ZONE', ruleLabel: 'Constats hors zone répétés',
        fingerprint: `CHZ:${agent}:${ids.length}`, severity: 'MOYENNE', confidence: 'MOYENNE',
        explanation: `${ids.length} constats de ${agent} hors de la zone de mission ou loin du point enregistré en ${this.p('enquete.hors_zone_fenetre_jours')} jours : constats fictifs ou erreurs de position possibles.`,
        variables: [{ name: 'Constats', value: ids.slice(0, 10).join(', '), source: 'géorepérage des constats (module terrain)' }, { name: 'Seuil', value: String(minOut), source: 'registre des seuils (PAR_DEFAUT)' }],
        subjects: [{ kind: 'AGENT', ref: agent }],
      });
    }

    // Doublons de paiement (rappels dupliqués écartés par le socle) : concentration par obligation.
    const dup = new Map<string, string[]>();
    for (const o of this.ctx.payments.orders.all()) if (o.status === 'DOUBLON') dup.set(o.obligationId, [...(dup.get(o.obligationId) ?? []), o.paymentReference]);
    for (const e of this.ctx.audit.list({ action: 'payment.duplicate_detected', limit: 100_000 }).items) {
      const o = e.resourceId ? this.ctx.payments.orders.get(e.resourceId) : undefined;
      if (o && !(dup.get(o.obligationId) ?? []).includes(`${o.paymentReference}#${e.id}`)) dup.set(o.obligationId, [...(dup.get(o.obligationId) ?? []), `${o.paymentReference}#${e.id}`]);
    }
    for (const [obligationId, refs] of dup) {
      raise({
        ruleCode: 'DOUBLONS_PAIEMENT', ruleLabel: 'Doublons de paiement sur une obligation',
        fingerprint: `DBP:${obligationId}:${refs.length}`, severity: 'MOYENNE', confidence: 'ELEVEE',
        explanation: `${refs.length} paiement(s) en double écarté(s) pour l’obligation ${obligationId} : rejeu de confirmation ou tentative de double comptabilisation à vérifier.`,
        variables: [{ name: 'Références', value: refs.join(', '), source: 'ordres de paiement (statut DOUBLON) et journal des doublons détectés' }],
        subjects: [{ kind: 'OBLIGATION', ref: obligationId }],
      });
    }

    // Annulations et exonérations anormales : volume par personne dans la fenêtre.
    const aWin = this.p('enquete.annulations_fenetre_jours') * DAY;
    const aMin = this.p('enquete.annulations_min');
    const KEYS = new Set(['treasury.operation.executed:ANNULATION_QUITTANCE', 'exemption.granted', 'reduction.granted', 'recovery.remission.granted', 'titres.issuance.cancelled', 'recovery.write_off.decided']);
    const byActor = new Map<string, { action: string; id: string }[]>();
    for (const e of this.ctx.audit.list({ limit: 1_000_000 }).items) {
      if (e.actor.kind !== 'user' || now - Date.parse(e.at) > aWin || e.outcome === 'FAILURE') continue;
      const kind = typeof e.details?.kind === 'string' ? `${e.action}:${e.details.kind}` : null;
      const key = kind && KEYS.has(kind) ? kind : KEYS.has(e.action) ? e.action : null;
      if (key) byActor.set(e.actor.id, [...(byActor.get(e.actor.id) ?? []), { action: key, id: e.id }]);
    }
    for (const [actor, acts] of byActor) {
      if (acts.length < aMin) continue;
      raise({
        ruleCode: 'ANNULATIONS_EXONERATIONS_ANORMALES', ruleLabel: 'Annulations et exonérations anormales',
        fingerprint: `AEA:${actor}:${acts.length}`, severity: 'ELEVEE', confidence: 'FAIBLE',
        explanation: `${acts.length} annulations, exonérations, remises ou réductions accordées par ${actor} en ${this.p('enquete.annulations_fenetre_jours')} jours. Peut être légitime (campagne, décision collective) ; examen requis.`,
        variables: [{ name: 'Actes', value: [...new Set(acts.map((a) => a.action))].join(', '), source: `journal d’audit (${acts.slice(0, 5).map((a) => a.id).join(', ')})` }, { name: 'Seuil', value: String(aMin), source: 'registre des seuils (PAR_DEFAUT)' }],
        subjects: [{ kind: 'AGENT', ref: actor }],
      });
    }

    // Quittances manipulées présumées : vérifications répétées d'un code inconnu ou à clé de contrôle invalide.
    const qMin = this.p('enquete.quittance_echecs_min');
    const failed = new Map<string, number>();
    for (const e of this.ctx.audit.list({ action: 'receipt.verified', limit: 100_000 }).items) {
      if (e.details.found === false && now - Date.parse(e.at) <= DAY && e.resourceId) failed.set(e.resourceId, (failed.get(e.resourceId) ?? 0) + 1);
    }
    for (const [code, n] of failed) {
      if (n < qMin) continue;
      raise({
        ruleCode: 'QUITTANCE_MANIPULEE', ruleLabel: 'Quittance manipulée présumée',
        fingerprint: `QMA:${code}:${n}`, severity: 'ELEVEE', confidence: 'MOYENNE',
        explanation: `Le code « ${code} » a été présenté ${n} fois en 24 h sans correspondre à une quittance émise : fausse quittance ou quittance modifiée en circulation.`,
        variables: [{ name: 'Vérifications infructueuses', value: String(n), source: 'journal des vérifications publiques' }, { name: 'Seuil', value: String(qMin), source: 'registre des seuils (PAR_DEFAUT)' }],
        subjects: [{ kind: 'QUITTANCE', ref: code }],
      });
    }
  }

  // ───────────────────────── scores explicables ─────────────────────────

  scoreOf(a: FraudAlert): ExplainedScore {
    const sev = SCORE_WEIGHTS.severity[a.severity];
    const conf = SCORE_WEIGHTS.confidence[a.confidence];
    const score = Math.round(sev * conf);
    return {
      alertId: a.id, score, band: score >= 60 ? 'ELEVE' : score >= 35 ? 'MOYEN' : 'FAIBLE',
      factors: [
        { factor: 'Gravité', value: a.severity, contribution: `${sev} points`, source: `règle ${a.ruleCode}` },
        { factor: 'Confiance', value: a.confidence, contribution: `× ${conf}`, source: `règle ${a.ruleCode}` },
      ],
      variables: a.variables.map((v) => ({ name: v.name, value: String(v.value), source: v.source })),
      confidence: a.confidence,
      method: `Score = points de gravité × coefficient de confiance (${SCORE_WEIGHTS.statut}). Il ordonne l’examen ; il ne vaut ni preuve ni décision.`,
      automaticEffect: 'AUCUN',
    };
  }

  scores(u: User) {
    authorize(u, 'integrite:score.read');
    return this.integrite.listAlerts(u).map((a) => ({ id: a.id, ruleLabel: a.ruleLabel, status: a.status, raisedAt: a.raisedAt, ...this.scoreOf(a) })).sort((x, y) => y.score - x.score);
  }

  alertScore(u: User, id: string): ExplainedScore {
    authorize(u, 'integrite:score.read');
    const a = this.integrite.listAlerts(u).find((x) => x.id === id);
    if (!a) throw notFound('ALERT_NOT_FOUND', `Alerte inconnue ou hors de votre périmètre : ${id}`);
    return this.scoreOf(a);
  }

  // ───────────────────────── suspension conservatoire ─────────────────────────

  private case(id: string): FraudCase {
    const c = this.integrite.cases.get(id);
    if (!c) throw notFound('CASE_NOT_FOUND', `Dossier d'enquête inconnu : ${id}`);
    return c;
  }

  /** Échéances et réapplication (heure du serveur) : suspensions expirées levées, suspensions en vigueur réappliquées. */
  sweep(): void {
    const now = this.now();
    for (const s of this.suspensions.find((x) => x.status === 'EN_VIGUEUR')) {
      if (s.execution!.until <= now) {
        this.ctx.users.releaseAccess(s.userId);
        this.suspensions.update({ ...s, status: 'EXPIREE', end: { by: 'systeme', at: now, reason: 'Échéance de la mesure conservatoire.' } });
        this.ctx.audit.append({ actor: { kind: 'system', id: 'integrite' }, action: 'integrite.access.suspension_expired', resourceType: 'user', resourceId: s.userId, details: { suspensionId: s.id, caseId: s.caseId } });
      } else if (!this.ctx.users.accessHold(s.userId) && this.ctx.users.get(s.userId)) {
        this.ctx.users.holdAccess(s.userId, { reference: s.id, until: s.execution!.until, reason: s.reason });
      }
    }
  }

  proposeSuspension(u: User, caseId: string, input: { userId: string; days: number; reason: string }): AccessSuspension {
    authorize(u, 'integrite:suspension.propose');
    const c = this.case(caseId);
    if (c.investigatorId !== u.id) throw forbidden('NOT_CASE_INVESTIGATOR', 'Seul l’enquêteur en charge propose une mesure conservatoire.');
    if (c.status === 'DECIDE') throw conflict('CASE_DECIDED', 'Dossier décidé : la mesure relève désormais de l’autorité compétente.');
    if (!c.implicatedUserIds.includes(input.userId)) throw unprocessable('NOT_IMPLICATED', 'La personne doit être mise en cause dans le dossier.');
    if (!this.ctx.users.get(input.userId)) throw notFound('USER_NOT_FOUND', `Compte inconnu : ${input.userId}`);
    const max = this.p('enquete.suspension_max_jours');
    if (input.days < 1 || input.days > max) throw unprocessable('DURATION_OUT_OF_RANGE', `Durée de 1 à ${max} jours (registre des seuils, PAR_DEFAUT).`);
    if (input.reason.trim().length < 20) throw badRequest('REASON_REQUIRED', 'Motif circonstancié (20 caractères au moins).');
    if (this.suspensions.findOne((s) => s.userId === input.userId && ['PROPOSEE', 'EN_VIGUEUR'].includes(s.status))) throw conflict('SUSPENSION_PENDING', 'Une mesure est déjà proposée ou en vigueur pour ce compte.');
    const s = this.suspensions.insert({ id: this.ids.next('SUSP', 6), caseId, userId: input.userId, reason: input.reason.trim(), days: input.days, status: 'PROPOSEE', proposedBy: u.id, proposedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(u), action: 'integrite.access.suspension_proposed', resourceType: 'user', resourceId: input.userId, details: { suspensionId: s.id, caseId, days: s.days } });
    return s;
  }

  /** Exécution par le responsable sécurité (personne distincte) : l'accès technique est suspendu jusqu'à l'échéance. */
  decideSuspension(u: User, id: string, input: { execute: boolean; reason: string }): AccessSuspension {
    authorize(u, 'integrite:suspension.execute');
    const s = this.suspensions.get(id);
    if (!s) throw notFound('SUSPENSION_NOT_FOUND', `Mesure inconnue : ${id}`);
    if (s.status !== 'PROPOSEE') throw conflict('SUSPENSION_DECIDED', `Mesure au statut ${s.status}.`);
    assertDistinctPerson(u.id, [s.proposedBy, s.userId], 'La mesure conservatoire est exécutée par une personne distincte de l’enquêteur et de la personne visée.');
    const at = this.now();
    if (!input.execute) {
      const out = this.suspensions.update({ ...s, status: 'REFUSEE', end: { by: u.id, at, reason: input.reason } });
      this.ctx.audit.append({ actor: actorOf(u), action: 'integrite.access.suspension_refused', resourceType: 'user', resourceId: s.userId, details: { suspensionId: id, reason: input.reason } });
      return out;
    }
    const until = new Date(Date.parse(at) + s.days * DAY).toISOString();
    this.ctx.users.holdAccess(s.userId, { reference: s.id, until, reason: s.reason });
    const out = this.suspensions.update({ ...s, status: 'EN_VIGUEUR', execution: { by: u.id, at, until } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'integrite.access.suspended', resourceType: 'user', resourceId: s.userId, details: { suspensionId: id, caseId: s.caseId, until, precautionary: true, automaticEffect: 'AUCUN' } });
    return out;
  }

  liftSuspension(u: User, id: string, reason: string): AccessSuspension {
    authorize(u, 'integrite:suspension.execute');
    const s = this.suspensions.get(id);
    if (!s) throw notFound('SUSPENSION_NOT_FOUND', `Mesure inconnue : ${id}`);
    if (s.status !== 'EN_VIGUEUR') throw conflict('SUSPENSION_NOT_ACTIVE', `Mesure au statut ${s.status}.`);
    this.ctx.users.releaseAccess(s.userId);
    const out = this.suspensions.update({ ...s, status: 'LEVEE', end: { by: u.id, at: this.now(), reason } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'integrite.access.suspension_lifted', resourceType: 'user', resourceId: s.userId, details: { suspensionId: id, reason } });
    return out;
  }

  listSuspensions(u: User): AccessSuspension[] {
    authorize(u, 'integrite:suspension.read');
    this.sweep();
    return this.suspensions.all().filter((s) => s.userId !== u.id).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  // ───────────────────────── transmission à l'autorité compétente ─────────────────────────

  transmit(u: User, caseId: string, authority: string): Transmission {
    authorize(u, 'integrite:transmission');
    const c = this.case(caseId);
    if (c.implicatedUserIds.includes(u.id)) throw forbidden('CONFLICT_OF_INTEREST', 'Une personne mise en cause ne transmet pas le dossier.');
    if (c.decision?.decision !== 'SAISINE_AUTORITE_COMPETENTE') throw conflict('NO_REFERRAL_DECISION', 'Transmission seulement après une décision motivée de saisine de l’autorité compétente.');
    if (this.transmissions.findOne((t) => t.caseId === caseId)) throw conflict('ALREADY_TRANSMITTED', 'Dossier déjà transmis.');
    const bordereau: Transmission['bordereau'] = {
      pieces: c.evidence.map((e) => ({ sha256: e.sha256, label: e.label })), timeline: c.timeline.map((t) => ({ at: t.at, kind: t.kind, text: t.text })),
      conclusions: c.conclusions ?? null, decision: c.decision, alerts: c.alertIds, reports: c.reportIds,
    };
    const bordereauHash = sha256Hex(canonicalJson({ caseId, authority, bordereau }));
    const t = this.transmissions.insert({ id: this.ids.next('TRANS', 6), caseId, authority: authority.trim(), bordereau, bordereauHash, seal: hmacSha256Hex(this.sealKey, bordereauHash), transmittedBy: u.id, transmittedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(u), action: 'integrite.case.transmitted', resourceType: 'fraud-case', resourceId: caseId, details: { transmissionId: t.id, authority: t.authority, bordereauHash, pieces: bordereau.pieces.length } });
    return t;
  }

  acknowledge(u: User, id: string, reference: string): Transmission {
    authorize(u, 'integrite:transmission');
    const t = this.transmissions.get(id);
    if (!t) throw notFound('TRANSMISSION_NOT_FOUND', `Transmission inconnue : ${id}`);
    if (t.acknowledgement) throw conflict('ALREADY_ACKNOWLEDGED', 'Accusé de réception déjà enregistré.');
    const out = this.transmissions.update({ ...t, acknowledgement: { reference: reference.trim(), at: this.now(), recordedBy: u.id } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'integrite.case.transmission_acknowledged', resourceType: 'fraud-case', resourceId: t.caseId, details: { transmissionId: id, reference } });
    return out;
  }

  verifyTransmission(id: string): { valid: boolean } {
    const t = this.transmissions.get(id);
    if (!t) throw notFound('TRANSMISSION_NOT_FOUND', `Transmission inconnue : ${id}`);
    const h = sha256Hex(canonicalJson({ caseId: t.caseId, authority: t.authority, bordereau: t.bordereau }));
    return { valid: h === t.bordereauHash && hmacSha256Hex(this.sealKey, h) === t.seal };
  }

  listTransmissions(u: User): Transmission[] {
    authorize(u, 'integrite:case.read');
    return this.transmissions.all().filter((t) => !this.case(t.caseId).implicatedUserIds.includes(u.id));
  }

  // ───────────────────────── déperdition évitée, indicateurs ─────────────────────────

  recordLoss(u: User, caseId: string, input: { amount: MoneyJSON; evidenceSha256: string; motif: string }): LossAvoided {
    authorize(u, 'integrite:loss.record');
    const c = this.case(caseId);
    if (c.implicatedUserIds.includes(u.id)) throw forbidden('CONFLICT_OF_INTEREST', 'Personne mise en cause.');
    const amount = Money.parseStrict(input.amount);
    if (amount.isNegative() || amount.isZero()) throw unprocessable('INVALID_AMOUNT', 'Montant strictement positif attendu.');
    const l = this.losses.insert({ id: this.ids.next('DEP', 6), caseId, amount: amount.toJSON(), evidenceSha256: input.evidenceSha256.toLowerCase(), motif: input.motif, recordedBy: u.id, recordedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(u), action: 'integrite.loss_avoided.recorded', resourceType: 'fraud-case', resourceId: caseId, details: { amount: l.amount, evidenceSha256: l.evidenceSha256 } });
    return l;
  }

  /** Indicateurs du module 40 : alertes ouvertes / résolues, délai d'instruction (médiane), déperdition évitée. */
  indicators() {
    const alerts = this.integrite.alerts.all();
    const cases = this.integrite.cases.all();
    const decided = cases.filter((c) => c.decision).map((c) => (Date.parse(c.decision!.at) - Date.parse(c.openedAt)) / DAY).sort((a, b) => a - b);
    const loss: Record<string, string> = {};
    for (const l of this.losses.all()) loss[l.amount.currency] = Money.fromJSON({ amount: loss[l.amount.currency] ?? '0', currency: l.amount.currency }).add(Money.fromJSON(l.amount)).toDecimalString();
    return {
      alertes: { ouvertes: alerts.filter((a) => ['A_EXAMINER', 'EN_EXAMEN', 'CLOTURE_PROPOSEE'].includes(a.status)).length, resolues: alerts.filter((a) => a.status === 'CLASSEE' || a.status === 'DOSSIER_OUVERT').length, parRegle: Object.fromEntries([...new Set(alerts.map((a) => a.ruleCode))].map((r) => [r, alerts.filter((a) => a.ruleCode === r).length])) },
      delaiInstruction: decided.length ? { statut: 'MESURE' as const, medianeJours: Math.round(decided[Math.floor(decided.length / 2)]! * 10) / 10, dossiers: decided.length } : { statut: 'NON_MESURE' as const, motif: 'Aucun dossier décidé.' },
      deperditionEvitee: this.losses.count() ? { statut: 'MESURE' as const, montants: loss, constats: this.losses.count() } : { statut: 'NON_MESURE' as const, motif: 'Aucune déperdition évitée constatée avec pièce justificative.' },
      suspensions: { enVigueur: this.suspensions.find((s) => s.status === 'EN_VIGUEUR').length, proposees: this.suspensions.find((s) => s.status === 'PROPOSEE').length },
      transmissions: { total: this.transmissions.count(), accusees: this.transmissions.find((t) => !!t.acknowledgement).length },
      signalementsCitoyens: this.integrite.reports.count(),
    };
  }
}
