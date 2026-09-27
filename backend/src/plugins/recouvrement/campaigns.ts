/**
 * Gestion des campagnes (§ 8, § 10A.2, § 21.4, § 45) : campagne de déclaration pré-remplie (ex. février 2027) par
 * entité et calendrier, lot de pré-remplissage, calendrier de relances, SIMULATION avant lancement (avis attendus,
 * canaux, volumes — calculés uniquement sur les données réelles du registre), lancement à deux personnes, arrêt motivé.
 * Prorogation d'échéance (§ 6.2) : acte daté enregistré sur la fiche de règle (quatre yeux), sans nouvelle version.
 * Aucune campagne ne crée d'obligation : seules les règles ACTIVES liquident, au dépôt par le contribuable.
 */
import { getEvent, isRuleExecutable, resolveChannels, type DueDateExtension } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { AppContext } from '../../context.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { RECOVERY_PROCEDURE } from './parameters.js';

const { always } = GRANTS;
definePolicy('campagnes:read', { R01: always, R02: always, R05: always, R06: always, R07: always, R11: always, R13: always, R16: always, R22: always, R23: always });
definePolicy('campagnes:manage', { R06: always, R07: always });
definePolicy('campagnes:approve', { R01: always, R02: always, R05: always, R06: always });
definePolicy('campagnes:prorogation.propose', { R06: always, R07: always, R13: always });
definePolicy('campagnes:prorogation.approve', { R05: always, R06: always, R16: always });

type Kind = 'IF' | 'IRL';
const KIND_OBJECTS: Record<Kind, string[]> = { IF: ['PARCELLE', 'BATIMENT'], IRL: ['UNITE_LOCATIVE', 'BATIMENT', 'PARCELLE'] };
const KIND_RULES: Record<Kind, string[]> = { IF: ['IF-KIN-PP-BATI', 'IF-KIN-PM', 'DEMO-IF-BATI'], IRL: ['IRL-KIN-R1', 'IRL-KIN-R234'] };

export interface CampaignReminder { offsetDays: number; event: 'declaration.due_soon'; label: string }

export interface CampaignSimulation {
  at: string;
  basis: 'DONNEES_REELLES_DU_REGISTRE';
  targets: number;
  taxpayers: number;
  excluded: { withoutHolder: number; alreadyFiled: number; notApplicable: number };
  expectedNotices: number;
  channels: Record<string, number>;
  unreachable: number;
  reminders: { offsetDays: number; date: string; expectedMessages: number }[];
  totalMessages: number;
  rules: { kind: Kind; code: string | null; status: string; executable: boolean; note: string }[];
  observedFilingRate: { period: string; eligible: number; filed: number; pct: number } | null;
  warnings: string[];
}

export interface Campaign {
  id: string;
  code: string;
  label: string;
  entity: string;
  kinds: Kind[];
  period: string;
  communes: string[];
  dueDate: string;
  dueDateStatus: 'A_VERIFIER' | 'CONFIRMEE';
  dueDateSource: string;
  reminders: CampaignReminder[];
  remindersStatus: string;
  stopCriteria: string[];
  status: 'BROUILLON' | 'SIMULEE' | 'LANCEMENT_PROPOSE' | 'LANCEE' | 'ARRETEE' | 'CLOTUREE';
  simulation?: CampaignSimulation;
  prefill?: { at: string; items: { objectId: string; taxpayerId: string; kind: Kind; ruleCode: string; executable: boolean; missingFields: number }[]; errors: { objectId: string; kind: Kind; error: string }[] };
  launch?: { proposedBy: string; proposedAt: string; approvedBy?: string; approvedAt?: string; notified?: number };
  remindersSent: { offsetDays: number; at: string; count: number }[];
  stop?: { by: string; at: string; reason: string };
  createdBy: string;
  createdAt: string;
  history: { at: string; by: string; action: string; note?: string }[];
}

export interface DueExtensionRequest {
  id: string;
  ruleCode: string;
  appliesFrom: string;
  appliesTo: string;
  extendedTo: string;
  actReference: string;
  actDate: string;
  reason: string;
  status: 'PROPOSEE' | 'ENREGISTREE' | 'REJETEE';
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; reason: string };
  notified?: number;
}

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

export class CampaignService {
  readonly campaigns = new InMemoryRepository<Campaign>();
  readonly extensions = new InMemoryRepository<DueExtensionRequest>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private today() { return kinshasaDate(this.ctx.clock.now()); }
  private now() { return this.ctx.clock.now().toISOString(); }
  private actor(u: User) { return { kind: 'user' as const, id: u.id, roles: u.roles }; }

  get(id: string): Campaign {
    const c = this.campaigns.get(id);
    if (!c) throw notFound('CAMPAIGN_NOT_FOUND', `Campagne inconnue : ${id}`);
    return c;
  }

  /** Relances par défaut : valeurs de conception du recouvrement (J-15, J-3) — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
  static defaultReminders(): CampaignReminder[] {
    return RECOVERY_PROCEDURE.reminderBeforeDays.map((d) => ({ offsetDays: d, event: 'declaration.due_soon' as const, label: `Rappel J-${d}` }));
  }

  create(user: User, input: { code: string; label: string; entity: string; kinds: Kind[]; period: string; communes: string[]; dueDate: string; dueDateStatus?: Campaign['dueDateStatus']; dueDateSource: string; reminderOffsets?: number[]; stopCriteria?: string[] }): Campaign {
    authorize(user, 'campagnes:manage');
    if (this.campaigns.findOne((c) => c.code === input.code)) throw conflict('CAMPAIGN_CODE_EXISTS', `Code de campagne déjà utilisé : ${input.code}`);
    const bad = input.communes.filter((c) => !isCommune(c));
    if (bad.length) throw badRequest('UNKNOWN_COMMUNE', `Communes inconnues : ${bad.join(', ')}`);
    if (!input.kinds.length) throw badRequest('KINDS_REQUIRED', 'Au moins un type de déclaration.');
    const reminders = input.reminderOffsets?.length
      ? [...new Set(input.reminderOffsets)].sort((a, b) => b - a).map((d) => ({ offsetDays: d, event: 'declaration.due_soon' as const, label: `Rappel J-${d}` }))
      : CampaignService.defaultReminders();
    const at = this.now();
    const c = this.campaigns.insert({
      id: this.ids.next('CAMP'), code: input.code, label: input.label, entity: input.entity, kinds: input.kinds, period: input.period, communes: input.communes,
      dueDate: input.dueDate, dueDateStatus: input.dueDateStatus ?? 'A_VERIFIER', dueDateSource: input.dueDateSource, reminders,
      remindersStatus: input.reminderOffsets?.length ? 'Calendrier saisi — à confirmer par le maître d’ouvrage' : 'PAR DÉFAUT — valeurs de conception du recouvrement (J-15, J-3), à confirmer par le maître d’ouvrage',
      stopCriteria: input.stopCriteria?.length ? input.stopCriteria : ['Coût disproportionné', 'Erreurs de données constatées', 'Impact social non conforme (§ 21.4)'],
      status: 'BROUILLON', remindersSent: [], createdBy: user.id, createdAt: at, history: [{ at, by: user.id, action: 'Création' }],
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'campaign.created', resourceType: 'campaign', resourceId: c.id, details: { code: c.code, entity: c.entity, dueDate: c.dueDate, communes: c.communes } });
    return c;
  }

  private declarationsRepo() {
    const fiscal = this.ctx.ext['fiscal'] as { declarations?: { declarations: { findOne(p: (x: { objectId: string; kind: string; period: string; status: string }) => boolean): unknown; find(p: (x: { objectId: string; kind: string; period: string; status: string }) => boolean): unknown[] }; prefill(u: 'systeme', i: { objectId: string; kind: Kind; period: string }): { rule: { code: string; executable: boolean }; fields: { value: string | null }[] } } } | undefined;
    return fiscal?.declarations;
  }

  /** Cibles réelles : objets des communes, applicables au type, avec redevable rattaché, sans déclaration déposée. */
  private targets(c: Campaign, period = c.period) {
    const decls = this.declarationsRepo();
    const out: { objectId: string; taxpayerId: string; kind: Kind }[] = [];
    let withoutHolder = 0;
    let alreadyFiled = 0;
    let notApplicable = 0;
    for (const o of this.ctx.objects.objects.find((x) => c.communes.includes(x.commune))) {
      for (const kind of c.kinds) {
        if (!KIND_OBJECTS[kind].includes(o.category)) { notApplicable++; continue; }
        if (kind === 'IRL' && !this.ctx.objects.leases.findOne((l) => l.unitObjectId === o.id)) { notApplicable++; continue; }
        if (!o.taxpayerId) { withoutHolder++; continue; }
        if (decls?.declarations.findOne((d) => d.objectId === o.id && d.kind === kind && d.period === period && d.status !== 'REMPLACEE')) { alreadyFiled++; continue; }
        out.push({ objectId: o.id, taxpayerId: o.taxpayerId, kind });
      }
    }
    return { items: out, excluded: { withoutHolder, alreadyFiled, notApplicable } };
  }

  /** Simulation avant lancement : uniquement à partir des données réelles ; aucun taux ni montant supposé. */
  simulate(user: User, id: string): Campaign {
    authorize(user, 'campagnes:manage');
    const c = this.get(id);
    if (!['BROUILLON', 'SIMULEE'].includes(c.status)) throw conflict('CAMPAIGN_BAD_STATE', `Simulation impossible au statut ${c.status}.`);
    const t = this.targets(c);
    const tpIds = [...new Set(t.items.map((i) => i.taxpayerId))];
    const event = getEvent('declaration.prefilled_ready')!;
    const channels: Record<string, number> = {};
    let unreachable = 0;
    for (const id2 of tpIds) {
      const tp = this.ctx.taxpayers.taxpayers.get(id2);
      if (!tp) continue;
      const chans = resolveChannels(event, tp.prefs).filter((ch) => ch === 'in-app' || (ch === 'email' ? !!tp.email : !!tp.phone));
      if (!chans.length || (chans.length === 1 && chans[0] === 'in-app' && !tp.phone && !tp.email)) unreachable++;
      for (const ch of chans) channels[ch] = (channels[ch] ?? 0) + 1;
    }
    const perMessage = Object.values(channels).reduce((a, b) => a + b, 0);
    const rules = c.kinds.map((kind) => {
      const r = this.ctx.rules.list().filter((x) => KIND_RULES[kind].includes(x.code)).sort((a, b) => Number(isRuleExecutable(b, this.ctx.clock.now()).ok) - Number(isRuleExecutable(a, this.ctx.clock.now()).ok) || b.version - a.version)[0];
      const exec = r ? isRuleExecutable(r, this.ctx.clock.now()) : null;
      return { kind, code: r?.code ?? null, status: r?.status ?? 'ABSENTE', executable: !!exec?.ok, note: exec?.ok ? 'Règle ACTIVE : le dépôt produit une obligation expliquée.' : `Règle non exécutable (${exec && !exec.ok ? exec.reason : 'absente'}) : dépôts en simulation non opposable, aucune obligation.` };
    });
    const prev = String(Number(c.period) - 1);
    const prevT = this.targets(c, prev);
    const prevEligible = prevT.items.length + prevT.excluded.alreadyFiled;
    const warnings: string[] = [];
    if (c.dueDateStatus === 'A_VERIFIER') warnings.push(`Échéance du ${c.dueDate} À VÉRIFIER (${c.dueDateSource}).`);
    if (rules.some((r) => !r.executable)) warnings.push('Au moins une règle n’est pas ACTIVE : la campagne informe et pré-remplit, sans créer d’obligation.');
    if (t.excluded.withoutHolder) warnings.push(`${t.excluded.withoutHolder} objet(s) sans redevable rattaché : rattachement préalable requis (hors campagne).`);
    if (unreachable) warnings.push(`${unreachable} contribuable(s) sans téléphone ni courriel : relais par guichet ou visite.`);
    const sim: CampaignSimulation = {
      at: this.now(), basis: 'DONNEES_REELLES_DU_REGISTRE', targets: t.items.length, taxpayers: tpIds.length, excluded: t.excluded,
      expectedNotices: t.items.length, channels, unreachable,
      reminders: c.reminders.map((r) => ({ offsetDays: r.offsetDays, date: addDays(c.dueDate, -r.offsetDays), expectedMessages: perMessage })),
      totalMessages: perMessage * (1 + c.reminders.length), rules,
      observedFilingRate: prevEligible > 0 ? { period: prev, eligible: prevEligible, filed: prevT.excluded.alreadyFiled, pct: Math.round((prevT.excluded.alreadyFiled * 1000) / prevEligible) / 10 } : null,
      warnings,
    };
    const out = this.campaigns.update({ ...c, simulation: sim, status: 'SIMULEE', history: [...c.history, { at: sim.at, by: user.id, action: 'Simulation', note: `${sim.targets} avis attendus, ${sim.totalMessages} messages` }] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'campaign.simulated', resourceType: 'campaign', resourceId: id, details: { targets: sim.targets, taxpayers: sim.taxpayers, totalMessages: sim.totalMessages } });
    return out;
  }

  /** Lot de déclarations pré-remplies (aucun dépôt, aucune obligation) : préparé avant le lancement. */
  prepareBatch(user: User, id: string): Campaign {
    authorize(user, 'campagnes:manage');
    const c = this.get(id);
    if (c.status !== 'SIMULEE') throw conflict('SIMULATION_REQUIRED', 'Une simulation doit précéder la préparation du lot.');
    const decls = this.declarationsRepo();
    if (!decls) throw unprocessable('FISCAL_MODULE_REQUIRED', 'Module fiscal requis pour le pré-remplissage.');
    const items: NonNullable<Campaign['prefill']>['items'] = [];
    const errors: NonNullable<Campaign['prefill']>['errors'] = [];
    for (const t of this.targets(c).items) {
      try {
        const p = decls.prefill('systeme', { objectId: t.objectId, kind: t.kind, period: c.period });
        items.push({ ...t, ruleCode: p.rule.code, executable: p.rule.executable, missingFields: p.fields.filter((f) => f.value === null).length });
      } catch (e) {
        errors.push({ objectId: t.objectId, kind: t.kind, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const at = this.now();
    const out = this.campaigns.update({ ...c, prefill: { at, items, errors }, history: [...c.history, { at, by: user.id, action: 'Lot de pré-remplissage', note: `${items.length} déclaration(s), ${errors.length} erreur(s)` }] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'campaign.prefill_prepared', resourceType: 'campaign', resourceId: id, details: { items: items.length, errors: errors.length } });
    return out;
  }

  proposeLaunch(user: User, id: string): Campaign {
    authorize(user, 'campagnes:manage');
    const c = this.get(id);
    if (c.status !== 'SIMULEE' || !c.prefill) throw conflict('CAMPAIGN_NOT_READY', 'Simulation et lot de pré-remplissage requis avant la proposition de lancement.');
    const at = this.now();
    const out = this.campaigns.update({ ...c, status: 'LANCEMENT_PROPOSE', launch: { proposedBy: user.id, proposedAt: at }, history: [...c.history, { at, by: user.id, action: 'Lancement proposé' }] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'campaign.launch.proposed', resourceType: 'campaign', resourceId: id, details: { code: c.code } });
    return out;
  }

  /** Décision de lancement par une seconde personne ; au lancement, chaque cible reçoit l'avis « déclaration pré-remplie prête ». */
  decideLaunch(user: User, id: string, input: { approve: boolean; reason: string }): Campaign {
    authorize(user, 'campagnes:approve');
    const c = this.get(id);
    if (c.status !== 'LANCEMENT_PROPOSE' || !c.launch) throw conflict('CAMPAIGN_BAD_STATE', 'Aucun lancement proposé.');
    assertDistinctPerson(user.id, [c.launch.proposedBy, c.createdBy], 'Le lancement est décidé par une personne distincte de celle qui a préparé et proposé la campagne.');
    const at = this.now();
    if (!input.approve) {
      const out = this.campaigns.update({ ...c, status: 'SIMULEE', history: [...c.history, { at, by: user.id, action: 'Lancement refusé', note: input.reason }] });
      this.ctx.audit.append({ actor: this.actor(user), action: 'campaign.launch.rejected', resourceType: 'campaign', resourceId: id, details: { proposedBy: c.launch.proposedBy, reason: input.reason } });
      return out;
    }
    const tps = [...new Set((c.prefill?.items ?? []).map((i) => i.taxpayerId))];
    for (const tpId of tps) {
      const tp = this.ctx.taxpayers.taxpayers.get(tpId);
      if (tp) this.ctx.comms.publish('declaration.prefilled_ready', [taxpayerRecipient(tp)], { reference: c.code, date: c.dueDate }, { entity: c.entity });
    }
    const out = this.campaigns.update({ ...c, status: 'LANCEE', launch: { ...c.launch, approvedBy: user.id, approvedAt: at, notified: tps.length }, history: [...c.history, { at, by: user.id, action: 'Lancement approuvé', note: input.reason }] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'campaign.launched', resourceType: 'campaign', resourceId: id, details: { proposedBy: c.launch.proposedBy, notified: tps.length, reason: input.reason } });
    return out;
  }

  /** Relances dues à la date du jour (idempotentes) : seulement aux cibles qui n'ont pas encore déposé. */
  runReminders(by: User | 'systeme', id: string): { campaignId: string; sent: { offsetDays: number; count: number }[] } {
    if (by !== 'systeme') authorize(by, 'campagnes:manage');
    const c = this.get(id);
    if (c.status !== 'LANCEE') throw conflict('CAMPAIGN_NOT_LAUNCHED', 'Relances possibles seulement pour une campagne lancée.');
    const today = this.today();
    const sent: { offsetDays: number; count: number }[] = [];
    let cur = c;
    for (const r of c.reminders) {
      if (today < addDays(c.dueDate, -r.offsetDays) || today > c.dueDate || cur.remindersSent.some((x) => x.offsetDays === r.offsetDays)) continue;
      const pending = [...new Set(this.targets(c).items.map((i) => i.taxpayerId))];
      for (const tpId of pending) {
        const tp = this.ctx.taxpayers.taxpayers.get(tpId);
        if (tp) this.ctx.comms.publish(r.event, [taxpayerRecipient(tp)], { reference: c.code, date: c.dueDate }, { entity: c.entity });
      }
      cur = this.campaigns.update({ ...cur, remindersSent: [...cur.remindersSent, { offsetDays: r.offsetDays, at: this.now(), count: pending.length }] });
      sent.push({ offsetDays: r.offsetDays, count: pending.length });
      this.ctx.audit.append({ actor: by === 'systeme' ? { kind: 'system', id: 'campagnes' } : this.actor(by), action: 'campaign.reminder.sent', resourceType: 'campaign', resourceId: id, details: { offsetDays: r.offsetDays, count: pending.length } });
    }
    return { campaignId: id, sent };
  }

  stop(user: User, id: string, reason: string): Campaign {
    authorize(user, 'campagnes:approve');
    const c = this.get(id);
    if (c.status === 'ARRETEE' || c.status === 'CLOTUREE') throw conflict('CAMPAIGN_CLOSED', 'Campagne déjà close.');
    const at = this.now();
    const out = this.campaigns.update({ ...c, status: 'ARRETEE', stop: { by: user.id, at, reason }, history: [...c.history, { at, by: user.id, action: 'Arrêt motivé', note: reason }] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'campaign.stopped', resourceType: 'campaign', resourceId: id, details: { reason } });
    return out;
  }

  /** Calendrier des campagnes par entité (échéances, relances, statut). */
  calendar(user: User) {
    authorize(user, 'campagnes:read');
    const byEntity: Record<string, { code: string; id: string; label: string; status: Campaign['status']; dueDate: string; dueDateStatus: string; reminders: { label: string; date: string }[] }[]> = {};
    for (const c of this.campaigns.all().sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
      (byEntity[c.entity] ??= []).push({ code: c.code, id: c.id, label: c.label, status: c.status, dueDate: c.dueDate, dueDateStatus: c.dueDateStatus, reminders: c.reminders.map((r) => ({ label: r.label, date: addDays(c.dueDate, -r.offsetDays) })) });
    }
    return Object.entries(byEntity).map(([entity, campaigns]) => ({ entity, campaigns }));
  }

  // ——— Prorogation d'échéance (acte daté, fiche de règle, quatre yeux) ———

  proposeExtension(user: User, input: Omit<DueExtensionRequest, 'id' | 'status' | 'proposedBy' | 'proposedAt'>): DueExtensionRequest {
    authorize(user, 'campagnes:prorogation.propose');
    if (!this.ctx.rules.rules.findOne((r) => r.code === input.ruleCode)) throw notFound('RULE_NOT_FOUND', `Règle inconnue : ${input.ruleCode}`);
    if (input.appliesTo < input.appliesFrom) throw badRequest('INVALID_PERIOD', 'Plage d’échéances invalide.');
    if (input.extendedTo <= input.appliesFrom) throw badRequest('INVALID_EXTENSION', 'La nouvelle échéance doit être postérieure aux échéances prorogées.');
    const x = this.extensions.insert({ id: this.ids.next('PROR'), ...input, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now() });
    this.ctx.audit.append({ actor: this.actor(user), action: 'rule.due_extension.proposed', resourceType: 'due_extension', resourceId: x.id, details: { ruleCode: x.ruleCode, extendedTo: x.extendedTo, actReference: x.actReference } });
    return x;
  }

  decideExtension(user: User, id: string, input: { approve: boolean; reason: string }): DueExtensionRequest {
    authorize(user, 'campagnes:prorogation.approve');
    const x = this.extensions.get(id);
    if (!x) throw notFound('EXTENSION_NOT_FOUND', `Prorogation inconnue : ${id}`);
    if (x.status !== 'PROPOSEE') throw conflict('EXTENSION_BAD_STATE', `Prorogation au statut ${x.status}.`);
    assertDistinctPerson(user.id, [x.proposedBy], 'La prorogation est enregistrée par une personne distincte de celle qui l’a proposée.');
    const at = this.now();
    if (!input.approve) {
      const out = this.extensions.update({ ...x, status: 'REJETEE', decision: { by: user.id, at, approve: false, reason: input.reason } });
      this.ctx.audit.append({ actor: this.actor(user), action: 'rule.due_extension.rejected', resourceType: 'due_extension', resourceId: id, details: { proposedBy: x.proposedBy, reason: input.reason } });
      return out;
    }
    const ext: DueDateExtension = { id: x.id, appliesFrom: x.appliesFrom, appliesTo: x.appliesTo, extendedTo: x.extendedTo, actReference: x.actReference, actDate: x.actDate, reason: x.reason, recordedBy: [x.proposedBy, user.id], recordedAt: at };
    // Ajout sur chaque version de la règle (jamais de nouvelle version, jamais d'effacement), historique conservé.
    for (const r of this.ctx.rules.rules.find((rr) => rr.code === x.ruleCode)) {
      this.ctx.rules.rules.update({ ...r, dueDateExtensions: [...(r.dueDateExtensions ?? []), ext], history: [...(r.history ?? []), { at, action: 'rule.due_extension.recorded', by: user.id, status: r.status, detail: `Prorogation ${x.appliesFrom}–${x.appliesTo} → ${x.extendedTo} (${x.actReference})` }] });
    }
    // Information des redevables concernés (obligations payables dont l'échéance est prorogée).
    const affected = this.ctx.assessment.obligations.find((o) => o.ruleCode === x.ruleCode && ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(o.status) && o.dueDate >= x.appliesFrom && o.dueDate <= x.appliesTo);
    for (const tpId of new Set(affected.map((o) => o.taxpayerId))) {
      const tp = this.ctx.taxpayers.taxpayers.get(tpId);
      if (tp) this.ctx.comms.publish('declaration.deadline_extended', [taxpayerRecipient(tp)], { reference: x.ruleCode, date: x.extendedTo }, { entity: 'DGIPK' });
    }
    const out = this.extensions.update({ ...x, status: 'ENREGISTREE', decision: { by: user.id, at, approve: true, reason: input.reason }, notified: new Set(affected.map((o) => o.taxpayerId)).size });
    this.ctx.audit.append({ actor: this.actor(user), action: 'rule.due_extension.recorded', resourceType: 'due_extension', resourceId: id, details: { proposedBy: x.proposedBy, ruleCode: x.ruleCode, extendedTo: x.extendedTo, affected: affected.length } });
    return out;
  }

  /** Campagne de février 2027 (planification) : exercice 2026, communes pilotes du § 45, échéance À VÉRIFIER. */
  seedFebruary2027(by: User): Campaign | undefined {
    if (this.campaigns.findOne((c) => c.code === 'CAMP-IF-IRL-2026-FEV2027')) return undefined;
    return this.create(by, {
      code: 'CAMP-IF-IRL-2026-FEV2027', label: 'Campagne de février 2027 — déclarations pré-remplies IF et IRL (exercice 2026)', entity: 'DGIPK',
      kinds: ['IF', 'IRL'], period: '2026', communes: ['Gombe', 'Limete', 'Kalamu', 'Ngaliema'], dueDate: '2027-02-01', dueDateStatus: 'A_VERIFIER',
      dueDateSource: 'Fiches de règle IF/IRL : « 1er février [de l’année suivante] » [À VÉRIFIER] — pilote § 45 (Gombe, Limete, Kalamu, Ngaliema)',
    });
  }
}
