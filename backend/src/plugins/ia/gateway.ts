/**
 * Passerelle de données en LECTURE SEULE offerte à un agent (§ 23.3 : « contrôle droits + finalité + masquage »).
 * Chaque méthode correspond à un domaine de la fiche de contrôle : toute lecture d'un domaine non autorisé lève une
 * erreur (IA_DATA_DOMAIN_FORBIDDEN). Les vues sont minimisées : ni nom, ni téléphone, ni courriel, ni coordonnées GPS,
 * ni numéro de compte ; les identifiants d'agents publics sont pseudonymisés dans les journaux et agrégats.
 * La passerelle mémorise les données lues : leur empreinte et les références citées alimentent le journal IA.
 */
import type { AppContext } from '../../context.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { forbidden } from '../../core/errors.js';
import type { AgentSheet } from './catalogue.js';
import type { Citation, DataDomain } from './types.js';

export const pseudo = (id: string): string => `ps-${sha256Hex(`mosolo-ia:${id}`).slice(0, 8)}`;

/** Pages d'aide publiques (base de connaissances de l'agent « Apprentissage de l'usager »). */
export const KNOWLEDGE_BASE = [
  { id: 'aide-payer', title: 'Payer une obligation', text: 'Le paiement se fait uniquement par une référence de paiement MOSOLO vers le compte public de la régie, par monnaie mobile, banque ou carte. Aucun agent ne perçoit d’espèces.' },
  { id: 'aide-quittance', title: 'Quittance', text: 'Une quittance provisoire est délivrée à la confirmation signée du prestataire ; elle devient définitive après rapprochement. Une capture d’écran ou un SMS ne vaut jamais quittance.' },
  { id: 'aide-recours', title: 'Réclamation (recours)', text: 'Toute obligation peut être contestée par une réclamation motivée depuis l’espace contribuable ; une autorité habilitée décide, avec motif.' },
  { id: 'aide-echeance', title: 'Échéance', text: 'La date d’échéance figure sur chaque obligation. Le dépassement ne déclenche aucune sanction automatique : une personne habilitée constate et décide.' },
  { id: 'aide-humain', title: 'Parler à un agent', text: 'Pour toute question, le guichet de la régie et le centre d’appel restent disponibles. Les réponses de l’assistant n’ont aucun effet juridique.' },
] as const;

export class DataGateway {
  readonly used = new Set<DataDomain>();
  readonly citations: Citation[] = [];
  readonly masked = new Set<string>();
  private readonly reads: Record<string, unknown> = {};

  constructor(
    private readonly ctx: AppContext,
    readonly sheet: AgentSheet,
    readonly today: string,
    readonly scope: { taxpayerId?: string; decisions?: () => { agentCode: string; status: string; autonomy: string }[] } = {},
  ) {}

  private use<T>(domain: DataDomain, key: string, value: T, masked: string[] = []): T {
    if (!this.sheet.allowedData.includes(domain)) {
      throw forbidden('IA_DATA_DOMAIN_FORBIDDEN', `L'agent « ${this.sheet.name} » n'est pas autorisé à lire le domaine ${domain}.`);
    }
    this.used.add(domain);
    for (const m of masked) this.masked.add(m);
    this.reads[`${domain}:${key}`] = value;
    return value;
  }

  cite(domain: DataDomain, ref: string, label: string): void {
    if (!this.sheet.allowedData.includes(domain)) throw forbidden('IA_DATA_DOMAIN_FORBIDDEN', `Citation d'un domaine non autorisé : ${domain}.`);
    if (!this.citations.some((c) => c.ref === ref && c.domain === domain)) this.citations.push({ domain, ref, label });
  }

  /** Empreinte des données effectivement lues (reconstitution, C3-188). */
  inputHash(): string {
    return sha256Hex(canonicalJson(this.reads));
  }

  // ---- Domaines ----
  objects() {
    return this.use('OBJETS', 'objects', this.ctx.objects.objects.all().map((o) => ({
      id: o.id, category: o.category, commune: o.commune, quartier: o.quartier, localityRank: o.localityRank, status: o.status,
      taxpayerId: o.taxpayerId ?? null, parcelId: typeof o.attributes['parcelleId'] === 'string' ? (o.attributes['parcelleId'] as string) : null,
    })), ['coordonnées GPS', 'attributs déclarés détaillés']);
  }

  leases() {
    return this.use('BAUX', 'leases', this.ctx.objects.leases.all().map((l) => ({
      id: l.id, unitObjectId: l.unitObjectId, start: l.start, end: l.end ?? null, periodicity: l.periodicity, probativeStatus: l.probativeStatus,
    })), ['montant du loyer', 'identité des parties']);
  }

  observations() {
    return this.use('OBSERVATIONS_TERRAIN', 'observations', this.ctx.field.observations.all().map((o) => ({ objectId: o.objectId, field: o.field, value: o.value, observedAt: o.observedAt })), ['agent observateur']);
  }

  conflicts() {
    return this.use('CONFLITS_TERRAIN', 'conflicts', this.ctx.field.conflicts.all().map((c) => ({ id: c.id, objectId: c.objectId, field: c.field, status: c.status })));
  }

  fieldTeams() {
    return this.use('EQUIPES_TERRAIN', 'teams', this.ctx.users.withRole('R10').map((u) => ({ userId: u.id, entity: u.entity, territory: u.territory ?? [] })), ['nom des agents']);
  }

  ownAccount() {
    const id = this.scope.taxpayerId;
    if (!id) return this.use('COMPTE_PROPRE', 'account', null);
    const t = this.ctx.taxpayers.taxpayers.get(id);
    if (!t) return this.use('COMPTE_PROPRE', 'account', null);
    const objects = this.ctx.objects.objects.find((o) => o.taxpayerId === id);
    return this.use('COMPTE_PROPRE', 'account', {
      id: t.id, language: t.language, situation: t.situation, verificationLevel: t.verificationLevel,
      hasEmail: Boolean(t.email), hasPhone: Boolean(t.phone),
      optedOut: Boolean(t.prefs.optedOut),
      duplicatePhone: this.ctx.taxpayers.taxpayers.find((x) => x.id !== t.id && x.phone === t.phone).length > 0,
      objects: objects.map((o) => ({ id: o.id, category: o.category, commune: o.commune, status: o.status, probativeStatus: o.probativeStatus })),
      leases: this.ctx.objects.leasesOf(id).map((l) => ({ id: l.id, unitObjectId: l.unitObjectId, declaredByRole: l.declaredByRole })),
    }, ['nom', 'téléphone', 'courriel']);
  }

  ownObligations() {
    const id = this.scope.taxpayerId;
    const list = id ? this.ctx.assessment.byTaxpayer(id) : [];
    return this.use('OBLIGATIONS_PROPRES', 'ownObligations', list.map((o) => ({
      id: o.id, label: o.label, status: o.status, dueDate: o.dueDate, amount: o.amount, ruleCode: o.ruleCode, ruleVersion: o.ruleVersion, entity: o.entity,
      nonOpposable: o.trace.nonOpposable,
    })));
  }

  obligations() {
    return this.use('OBLIGATIONS', 'obligations', this.ctx.assessment.obligations.all().map((o) => ({
      id: o.id, status: o.status, dueDate: o.dueDate, amount: o.amount, ruleCode: o.ruleCode, entity: o.entity,
      commune: o.attribution?.commune ?? null, taxpayerId: o.taxpayerId, appealId: o.appealId ?? null,
    })), ['identité du redevable']);
  }

  payments() {
    return this.use('PAIEMENTS', 'payments', this.ctx.payments.orders.all().map((p) => ({
      id: p.id, reference: p.paymentReference, obligationId: p.obligationId, status: p.status, amount: p.amount, beneficiaryAlias: p.beneficiaryAlias,
      confirmedAt: p.confirmedAt ?? null, settledAt: p.settledAt ?? null, reconciledAt: p.reconciledAt ?? null, commune: p.attribution?.commune ?? null,
    })), ['payeur', 'numéro de téléphone du payeur']);
  }

  exceptions() {
    return this.use('EXCEPTIONS_TRESOR', 'exceptions', this.ctx.treasury.exceptions.all().map((e) => ({
      id: e.id, type: e.type, paymentReference: e.paymentReference ?? null, openedAt: e.openedAt, status: e.status,
    })));
  }

  rules() {
    return this.use('REGLES', 'rules', this.ctx.rules.rules.all().map((r) => ({
      id: r.id, code: r.code, version: r.version, status: r.status, label: r.label, legalInstrumentIds: r.legalInstrumentIds,
      effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null, administeringEntity: r.administeringEntity, sample: Boolean(r.sample), demo: Boolean(r.demo),
    })));
  }

  instruments() {
    return this.use('INSTRUMENTS', 'instruments', this.ctx.rules.instruments.all().map((i) => ({ id: i.id, title: i.title, status: i.status, abrogatedBy: i.abrogatedBy ?? null })));
  }

  appeals() {
    return this.use('RECOURS', 'appeals', this.ctx.appeals.appeals.all().map((a) => ({
      id: a.id, obligationId: a.obligationId, status: a.status, grounds: a.grounds, submittedAt: a.submittedAt,
      requestedAmount: a.requestedAmount ?? null, proposal: a.proposal ? { decision: a.proposal.decision, at: a.proposal.at } : null,
    })), ['identité du réclamant']);
  }

  alerts() {
    return this.use('ALERTES', 'alerts', this.ctx.alerts.list().map((a) => ({ id: a.id, type: a.type, severity: a.severity, at: a.at, source: a.source })));
  }

  auditMeta() {
    const recs = this.ctx.audit.list({ limit: 100_000 }).items;
    return this.use('JOURNAL_AUDIT', 'audit', recs.map((r) => ({
      id: r.id, action: r.action, outcome: r.outcome, at: r.at, actor: r.actor.kind === 'user' || r.actor.kind === 'device' ? pseudo(r.actor.id) : r.actor.kind,
      actorKind: r.actor.kind,
    })), ['identifiants des agents (pseudonymisés)']);
  }

  devices() {
    return this.use('TERMINAUX', 'devices', this.ctx.field.devices.all().map((d) => ({ id: d.id, status: d.status, agent: pseudo(d.agentUserId), revokedAt: d.revokedAt ?? null })), ['clés des terminaux']);
  }

  taxpayerAggregates() {
    const byPhone = new Map<string, number>();
    for (const t of this.ctx.taxpayers.taxpayers.all()) byPhone.set(sha256Hex(t.phone), (byPhone.get(sha256Hex(t.phone)) ?? 0) + 1);
    const groups = [...byPhone.values()].filter((n) => n > 1);
    return this.use('CONTRIBUABLES_AGREGES', 'taxpayerAgg', { total: this.ctx.taxpayers.taxpayers.count(), duplicatePhoneGroups: groups.length, accountsInDuplicateGroups: groups.reduce((a, b) => a + b, 0) }, ['identités (agrégats seulement)']);
  }

  vault() {
    return this.use('COFFRE', 'vault', {
      aliases: this.ctx.vault.accounts.all().map((a) => ({ alias: a.alias, entity: a.entity, currency: a.currency })),
      pendingChanges: this.ctx.vault.requests.all().filter((r) => r.status !== 'EFFECTIF').map((r) => ({ id: r.id, alias: r.alias, status: r.status, requestedAt: r.requestedAt, approvals: r.approvals.length })),
    }, ['numéros de compte']);
  }

  comms() {
    const o = this.ctx.comms.overview();
    return this.use('COMMUNICATIONS', 'comms', { attempted: o.attempted, sandboxLogged: o.sandboxLogged, channelsWired: o.channelsWired, channelsTotal: o.channelsTotal });
  }

  aiDecisions() {
    return this.use('DECISIONS_IA', 'decisions', this.scope.decisions?.() ?? []);
  }

  knowledge() {
    return this.use('BASE_CONNAISSANCES', 'kb', KNOWLEDGE_BASE);
  }
}
