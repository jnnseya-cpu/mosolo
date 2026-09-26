/**
 * Mémoire structurée à quatre niveaux (§ 23.5.4) : utilisateur, espace (entité), processus, intelligence.
 * Chaque niveau a une finalité, une durée de conservation, des règles de consultation et un effacement contrôlé.
 * Minimisation : liste blanche de clés, refus des données de contact dans la mémoire, agrégats pseudonymisés.
 *
 * Durées de conservation : PROPOSITIONS du socle, à valider par le délégué à la protection des données (R25, ch. 32).
 */
import { REQUIRED_APPROVALS } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { evaluate } from '../../core/policy.js';
import { IdGenerator } from '../../core/repository.js';

const DAY = 86_400_000;

export type MemoryLevel = 'UTILISATEUR' | 'ENTITE' | 'PROCESSUS' | 'INTELLIGENCE';

export const MEMORY_LEVELS: {
  level: MemoryLevel; label: string; contenu: string; limites: string; conservation: string; consultation: string; effacement: string; retentionDays: number | null;
}[] = [
  {
    level: 'UTILISATEUR', label: 'Mémoire utilisateur',
    contenu: 'Rôle, préférences, langue, tâches fréquentes, priorités, sorties enregistrées, objectifs récurrents.',
    limites: 'Agents publics : aide au travail, jamais utilisée pour l’évaluation disciplinaire sans procédure. Contribuables : préférences de service uniquement, aucun profilage comportemental.',
    conservation: 'Agents publics : 12 mois après la dernière utilisation. Contribuables : 24 mois après la dernière utilisation.',
    consultation: 'L’utilisateur seul. Le délégué à la protection des données voit le registre (volumes, durées), jamais le contenu.',
    effacement: 'Par l’utilisateur, à tout moment, en tout ou clé par clé ; purge automatique à l’échéance.',
    retentionDays: 365,
  },
  {
    level: 'ENTITE', label: 'Mémoire d’espace (entité)',
    contenu: 'Données de l’entité, règles, modèles, circuits, décisions historiques, hypothèses.',
    limites: 'Cloisonnée par entité (§ 10.3) ; les décisions historiques ne contiennent aucune donnée de contact.',
    conservation: 'Décisions historiques : 10 ans (niveau du journal d’audit). Hypothèses et modèles : 3 ans après la dernière mise à jour.',
    consultation: 'Agents publics de l’entité ; auditeurs internes et externes.',
    effacement: 'Contrôlé : administrateur de l’entité ou délégué à la protection des données, motif obligatoire, journalisé ; décisions non effaçables avant l’échéance.',
    retentionDays: 3 * 365,
  },
  {
    level: 'PROCESSUS', label: 'Mémoire de processus',
    contenu: 'Étape atteinte, fait, en attente, bloqué, changé récemment, prochaine décision.',
    limites: 'Liée au dossier ; consultable seulement par qui peut consulter le dossier.',
    conservation: 'Conservée avec le dossier (même durée que le dossier).',
    consultation: 'Selon les droits sur le dossier (règle, recours, obligation, changement de bénéficiaire, recommandation).',
    effacement: 'Uniquement avec le dossier lui-même.',
    retentionDays: null,
  },
  {
    level: 'INTELLIGENCE', label: 'Mémoire d’intelligence',
    contenu: 'Tendances, risques, problèmes répétés, signaux de performance, de coût, de productivité, de prévision.',
    limites: 'Agrégée et pseudonymisée (aucun identifiant de personne) ; alimente les modèles uniquement via des jeux approuvés (§ 23.4).',
    conservation: '36 mois par période mensuelle.',
    consultation: 'Agents publics (agrégats).',
    effacement: 'Gestionnaire des modèles ou délégué à la protection des données, motif obligatoire.',
    retentionDays: 36 * 31,
  },
];

const AGENT_KEYS = ['langue', 'priorites', 'objectifs', 'preferences.affichage', 'preferences.agentsFavoris', 'preferences.filtreBoite'] as const;
const TAXPAYER_KEYS = ['langue', 'canalPrefere', 'formatMontants', 'accessibilite', 'rappelsFacultatifs'] as const;
const PII = [/\+?\d[\d .-]{7,}\d/, /[^\s@]+@[^\s@]+\.[^\s@]+/, /\bTP-[A-Z0-9-]+/i];

export type MemoryValue = string | string[];

export interface UserMemory {
  userId: string;
  audience: 'AGENT_PUBLIC' | 'CONTRIBUABLE';
  purpose: 'SERVICE';
  items: Record<string, { value: MemoryValue; updatedAt: string; source: 'UTILISATEUR' | 'AUTOMATIQUE' }>;
  frequentTasks: Record<string, number>;
  savedOutputs: string[];
  createdAt: string;
  lastUsedAt: string;
}

export interface EntityMemoryItem {
  id: string;
  entity: string;
  kind: 'DECISION' | 'HYPOTHESE' | 'MODELE';
  title: string;
  content: string;
  refs: string[];
  source: 'DECISION_HUMAINE' | 'SAISIE';
  createdAt: string;
  createdBy: string;
  retainUntil: string;
  status: 'ACTIVE' | 'EFFACEE';
  erasedAt?: string;
  erasedBy?: string;
  erasureReason?: string;
}

export interface ProcessState {
  key: string;
  resourceType: string;
  resourceId: string;
  step: string;
  done: string[];
  pending: string[];
  blockedBy: string | null;
  nextDecision: string | null;
  owner: string | null;
  recentChanges: { action: string; at: string; actorKind: string }[];
  history: { step: string; at: string }[];
  retention: string;
  computedAt: string;
}

export interface IntelligenceSignal {
  id: string;
  period: string;
  agentCode: string;
  metric: string;
  dimension: string;
  count: number;
  updatedAt: string;
}

/** Petit magasin avec effacement (les dépôts du socle n'ont volontairement pas de suppression). */
class Store<T> {
  private readonly m = new Map<string, T>();
  get(id: string): T | undefined { const v = this.m.get(id); return v === undefined ? undefined : structuredClone(v); }
  set(id: string, v: T): T { this.m.set(id, structuredClone(v)); return structuredClone(v); }
  delete(id: string): boolean { return this.m.delete(id); }
  all(): T[] { return [...this.m.values()].map((v) => structuredClone(v)); }
  size(): number { return this.m.size; }
}

const isTaxpayer = (u: User) => u.roles.every((r) => r === 'R30' || r === 'R31');

export class MemoryService {
  readonly users = new Store<UserMemory>();
  readonly entityItems = new Store<EntityMemoryItem>();
  readonly processes = new Store<ProcessState>();
  readonly signals = new Store<IntelligenceSignal>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now(): string { return this.ctx.clock.now().toISOString(); }
  private actor(u: User) { return { kind: 'user' as const, id: u.id, roles: u.roles }; }

  // ---------- Niveau 1 : utilisateur ----------
  private userMem(u: User): UserMemory {
    return this.users.get(u.id) ?? {
      userId: u.id, audience: isTaxpayer(u) ? 'CONTRIBUABLE' : 'AGENT_PUBLIC', purpose: 'SERVICE', items: {}, frequentTasks: {}, savedOutputs: [],
      createdAt: this.now(), lastUsedAt: this.now(),
    };
  }

  allowedKeys(u: User): readonly string[] {
    return isTaxpayer(u) ? TAXPAYER_KEYS : AGENT_KEYS;
  }

  getUser(u: User) {
    const m = this.users.get(u.id);
    const base = m ?? this.userMem(u);
    return {
      ...base,
      role: u.roles.join(', '),
      allowedKeys: this.allowedKeys(u),
      retention: base.audience === 'CONTRIBUABLE' ? '24 mois après la dernière utilisation' : '12 mois après la dernière utilisation',
      expiresAt: new Date(new Date(base.lastUsedAt).getTime() + this.retentionDays(base) * DAY).toISOString(),
      notice: base.audience === 'CONTRIBUABLE'
        ? 'Préférences de service uniquement : aucun profilage comportemental.'
        : 'Aide au travail : jamais utilisée pour une évaluation disciplinaire sans procédure.',
    };
  }

  private retentionDays(m: UserMemory): number { return m.audience === 'CONTRIBUABLE' ? 730 : 365; }

  putUser(u: User, key: string, value: MemoryValue) {
    if (!this.allowedKeys(u).includes(key)) {
      throw unprocessable('MEMORY_KEY_NOT_ALLOWED', isTaxpayer(u)
        ? `Clé « ${key} » refusée : la mémoire d’un contribuable ne contient que des préférences de service (${TAXPAYER_KEYS.join(', ')}).`
        : `Clé « ${key} » non prévue dans la mémoire utilisateur (${AGENT_KEYS.join(', ')}).`);
    }
    const vals = Array.isArray(value) ? value : [value];
    if (vals.length > 20 || vals.some((v) => typeof v !== 'string' || v.length > 500)) throw unprocessable('MEMORY_VALUE_TOO_LARGE', 'Valeur trop volumineuse (minimisation).');
    if (vals.some((v) => PII.some((re) => re.test(v)))) throw unprocessable('MEMORY_PERSONAL_DATA_REFUSED', 'Les coordonnées et identifiants de personnes ne sont pas conservés en mémoire (minimisation).');
    const m = this.userMem(u);
    m.items[key] = { value, updatedAt: this.now(), source: 'UTILISATEUR' };
    m.lastUsedAt = this.now();
    this.users.set(u.id, m);
    this.ctx.audit.append({ actor: this.actor(u), action: 'ia.memory.user.updated', resourceType: 'ia_memory', resourceId: `user:${u.id}`, details: { key } });
    return this.getUser(u);
  }

  /** Tâches fréquentes : compteur par agent sollicité (agents publics seulement : aucun profilage des contribuables). */
  touchTask(u: User, agentCode: string): void {
    if (isTaxpayer(u)) return;
    const m = this.userMem(u);
    m.frequentTasks[agentCode] = (m.frequentTasks[agentCode] ?? 0) + 1;
    m.lastUsedAt = this.now();
    this.users.set(u.id, m);
  }

  saveOutput(u: User, recommendationId: string) {
    const m = this.userMem(u);
    if (!m.savedOutputs.includes(recommendationId)) m.savedOutputs = [...m.savedOutputs, recommendationId].slice(-50);
    m.lastUsedAt = this.now();
    this.users.set(u.id, m);
    return this.getUser(u);
  }

  eraseUser(u: User, key?: string) {
    const m = this.users.get(u.id);
    if (m) {
      if (key) {
        if (key === 'frequentTasks') m.frequentTasks = {};
        else if (key === 'savedOutputs') m.savedOutputs = [];
        else delete m.items[key];
        this.users.set(u.id, m);
      } else this.users.delete(u.id);
    }
    this.ctx.audit.append({ actor: this.actor(u), action: 'ia.memory.user.erased', resourceType: 'ia_memory', resourceId: `user:${u.id}`, details: { key: key ?? '*' } });
    return { erased: key ?? 'TOUT', at: this.now() };
  }

  /** Consultation de la mémoire d'autrui : refusée à tous (aucun usage disciplinaire sans procédure). */
  getOtherUser(requester: User, userId: string): never {
    this.ctx.audit.append({ actor: this.actor(requester), action: 'ia.memory.user.access_denied', resourceType: 'ia_memory', resourceId: `user:${userId}`, outcome: 'DENIED' });
    throw forbidden('MEMORY_PRIVATE', 'La mémoire utilisateur n’est consultable que par son titulaire ; aucun usage disciplinaire ou hiérarchique sans procédure.');
  }

  // ---------- Niveau 2 : espace (entité) ----------
  entity(entity: string) {
    const items = this.entityItems.all().filter((i) => i.entity === entity && i.status === 'ACTIVE').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rules = this.ctx.rules.rules.all().filter((r) => r.administeringEntity === entity && ['ACTIVE', 'PUBLIEE'].includes(r.status))
      .map((r) => ({ id: r.id, code: r.code, version: r.version, status: r.status, label: r.label, demo: Boolean(r.demo) }));
    return {
      entity,
      decisions: items.filter((i) => i.kind === 'DECISION'),
      hypotheses: items.filter((i) => i.kind === 'HYPOTHESE'),
      modeles: items.filter((i) => i.kind === 'MODELE'),
      regles: rules,
      circuits: [
        'Règle : rédaction (R13) → vérification juridique (R14) → validation financière (R15) → publication (R16)',
        'Recours : dépôt → instruction (R20) → décision motivée (R21)',
        'Compte bénéficiaire : proposition (R17) → deux approbations hors bande (R19) → refroidissement',
        'Recommandation IA : niveau A journalisé / B validé par un agent habilité / C circuit maker-checker',
      ],
      erased: this.entityItems.all().filter((i) => i.entity === entity && i.status === 'EFFACEE').map((i) => ({ id: i.id, kind: i.kind, erasedAt: i.erasedAt, erasureReason: i.erasureReason })),
    };
  }

  addEntityItem(u: User, entity: string, input: { kind: 'HYPOTHESE' | 'MODELE'; title: string; content: string; refs?: string[] }, opts: { silent?: boolean } = {}): EntityMemoryItem {
    if ([input.title, input.content].some((v) => PII.some((re) => re.test(v)))) throw unprocessable('MEMORY_PERSONAL_DATA_REFUSED', 'Aucune donnée de contact ou identifiant de personne dans la mémoire d’entité.');
    const now = this.now();
    const item: EntityMemoryItem = {
      id: this.ids.next('MEM-ENT'), entity, kind: input.kind, title: input.title, content: input.content, refs: input.refs ?? [], source: 'SAISIE',
      createdAt: now, createdBy: u.id, retainUntil: new Date(Date.parse(now) + 3 * 365 * DAY).toISOString(), status: 'ACTIVE',
    };
    this.entityItems.set(item.id, item);
    if (!opts.silent) this.ctx.audit.append({ actor: this.actor(u), action: 'ia.memory.entity.added', resourceType: 'ia_memory', resourceId: item.id, details: { entity, kind: input.kind } });
    return item;
  }

  /** Alimentée par les décisions humaines sur les recommandations de l'entité. */
  recordDecision(entity: string, d: { recommendationId: string; agent: string; decision: string; reasonSummary: string; decidedByRole: string }): EntityMemoryItem {
    const now = this.now();
    const item: EntityMemoryItem = {
      id: this.ids.next('MEM-ENT'), entity, kind: 'DECISION', title: `${d.agent} — ${d.decision}`,
      content: `Décision ${d.decision} par ${d.decidedByRole} : ${PII.reduce((t, re) => t.replace(new RegExp(re.source, 'gi'), '[masqué]'), d.reasonSummary).slice(0, 300)}`,
      refs: [d.recommendationId], source: 'DECISION_HUMAINE', createdAt: now, createdBy: d.decidedByRole,
      retainUntil: new Date(Date.parse(now) + 10 * 365 * DAY).toISOString(), status: 'ACTIVE',
    };
    this.entityItems.set(item.id, item);
    return item;
  }

  eraseEntityItem(u: User, id: string, reason: string): EntityMemoryItem {
    const item = this.entityItems.get(id);
    if (!item) throw notFound('MEMORY_ITEM_NOT_FOUND', `Élément de mémoire inconnu : ${id}`);
    if (item.status === 'EFFACEE') throw conflict('MEMORY_ALREADY_ERASED', 'Élément déjà effacé.');
    if (item.kind === 'DECISION' && this.now() < item.retainUntil) {
      throw conflict('MEMORY_RETENTION_ACTIVE', `Décision historique conservée jusqu’au ${item.retainUntil.slice(0, 10)} : effacement impossible avant l’échéance.`);
    }
    const updated = this.entityItems.set(id, { ...item, status: 'EFFACEE', content: '[effacé]', title: `[effacé] ${item.kind}`, erasedAt: this.now(), erasedBy: u.id, erasureReason: reason });
    this.ctx.audit.append({ actor: this.actor(u), action: 'ia.memory.entity.erased', resourceType: 'ia_memory', resourceId: id, details: { entity: item.entity, kind: item.kind, reason } });
    return updated;
  }

  // ---------- Niveau 3 : processus ----------
  canReadProcess(u: User, type: string, id: string): boolean {
    const c = this.ctx;
    switch (type) {
      case 'rule': return Boolean(evaluate(u, 'rule.read'));
      case 'appeal': {
        const a = c.appeals.appeals.get(id);
        if (!a) return false;
        return Boolean(evaluate(u, 'appeal.submit', { taxpayerId: a.taxpayerId }) || evaluate(u, 'appeal.instruct') || evaluate(u, 'appeal.decide') || evaluate(u, 'audit.read'));
      }
      case 'obligation': {
        const o = c.assessment.obligations.get(id);
        if (!o) return false;
        return evaluate(u, 'obligation.read', { taxpayerId: o.taxpayerId, entity: o.entity }) === 'full';
      }
      case 'beneficiary': return Boolean(evaluate(u, 'beneficiary.read'));
      default: return false;
    }
  }

  process(u: User, type: string, id: string, iaResolver?: (id: string) => Omit<ProcessState, 'key' | 'history' | 'recentChanges' | 'computedAt' | 'retention'> | null): ProcessState {
    let base: Omit<ProcessState, 'key' | 'history' | 'recentChanges' | 'computedAt' | 'retention'> | null = null;
    if (type === 'ia') {
      base = iaResolver?.(id) ?? null;
    } else {
      if (!this.canReadProcess(u, type, id)) {
        const exists = type === 'rule' ? this.ctx.rules.rules.get(id) : type === 'appeal' ? this.ctx.appeals.appeals.get(id)
          : type === 'obligation' ? this.ctx.assessment.obligations.get(id) : type === 'beneficiary' ? this.ctx.vault.requests.get(id) : undefined;
        if (!exists) throw notFound('PROCESS_NOT_FOUND', `Dossier inconnu : ${type}/${id}`);
        throw forbidden('FORBIDDEN', 'Accès au dossier refusé : la mémoire de processus suit les droits sur le dossier.');
      }
      base = this.computeProcess(type, id);
    }
    if (!base) throw notFound('PROCESS_NOT_FOUND', `Dossier inconnu : ${type}/${id}`);
    const key = `${type}:${id}`;
    const prev = this.processes.get(key);
    const now = this.now();
    const history = prev?.history ?? [];
    if (!prev || prev.step !== base.step) history.push({ step: base.step, at: now });
    const recentChanges = this.ctx.audit.list({ resourceId: id, limit: 100_000 }).items.slice(-5).reverse()
      .map((r) => ({ action: r.action, at: r.at, actorKind: r.actor.kind }));
    const state: ProcessState = { ...base, key, history, recentChanges, retention: 'Conservée avec le dossier', computedAt: now };
    return this.processes.set(key, state);
  }

  private computeProcess(type: string, id: string): Omit<ProcessState, 'key' | 'history' | 'recentChanges' | 'computedAt' | 'retention'> | null {
    const c = this.ctx;
    if (type === 'rule') {
      const r = c.rules.rules.get(id);
      if (!r) return null;
      const labels: Record<string, [string, string]> = {
        REDACTEUR: ['Visa du rédacteur', 'R13'], VERIFICATEUR_JURIDIQUE: ['Vérification juridique', 'R14'],
        VALIDATEUR_FINANCIER: ['Validation financière', 'R15'], AUTORITE_PUBLICATION: ['Publication', 'R16'],
      };
      const done = r.approvals.map((a) => labels[a.role]?.[0] ?? a.role);
      const missing = REQUIRED_APPROVALS.filter((role) => !r.approvals.some((a) => a.role === role));
      const weak = r.legalInstrumentIds.filter((i) => ['A_VERIFIER', 'ABROGE'].includes(c.rules.instruments.get(i)?.status ?? 'A_VERIFIER'));
      return {
        resourceType: 'rule', resourceId: id, step: r.status, done, pending: missing.map((m) => labels[m]?.[0] ?? m),
        blockedBy: r.status === 'A_VERIFIER' || weak.length ? `Texte non certifié : ${weak.join(', ') || 'fiche modèle'}` : null,
        nextDecision: missing[0] ? labels[missing[0]]![0] : null, owner: missing[0] ? labels[missing[0]]![1] : null,
      };
    }
    if (type === 'appeal') {
      const a = c.appeals.appeals.get(id);
      if (!a) return null;
      const done = ['Dépôt', ...(a.proposal ? ['Instruction'] : []), ...(a.decision ? ['Décision motivée'] : [])];
      const pending = a.decision ? [] : a.proposal ? ['Décision motivée'] : ['Instruction', 'Décision motivée'];
      return {
        resourceType: 'appeal', resourceId: id, step: a.status, done, pending, blockedBy: null,
        nextDecision: pending[0] ?? null, owner: a.decision ? null : a.proposal ? 'R21' : 'R20',
      };
    }
    if (type === 'obligation') {
      const o = c.assessment.obligations.get(id);
      if (!o) return null;
      const orders = c.payments.byObligation(id);
      const confirmed = orders.some((p) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status));
      const reconciled = orders.some((p) => p.status === 'RAPPROCHE');
      const done = ['Liquidation', ...(orders.length ? ['Référence de paiement'] : []), ...(confirmed ? ['Paiement confirmé (quittance provisoire)'] : []), ...(reconciled ? ['Rapprochement (quittance définitive)'] : [])];
      const pending = ['Référence de paiement', 'Paiement confirmé (quittance provisoire)', 'Rapprochement (quittance définitive)'].filter((s) => !done.includes(s));
      return {
        resourceType: 'obligation', resourceId: id, step: o.status, done, pending: o.status === 'SOLDEE' ? [] : pending,
        blockedBy: o.status === 'CONTESTEE' ? `Réclamation en cours (${o.appealId ?? '—'})` : null,
        nextDecision: o.status === 'CONTESTEE' ? 'Décision sur la réclamation' : null,
        owner: o.status === 'CONTESTEE' ? 'R21' : reconciled ? null : confirmed ? 'R18' : 'R30',
      };
    }
    if (type === 'beneficiary') {
      const r = c.vault.requests.get(id);
      if (!r) return null;
      const done = ['Proposition', ...r.approvals.map((_, i) => `Approbation hors bande n° ${i + 1}`), ...(r.status === 'EFFECTIF' ? ['Refroidissement écoulé'] : [])];
      const pending = r.status === 'EN_ATTENTE_APPROBATION' ? [`Approbation hors bande n° ${r.approvals.length + 1}`, 'Refroidissement'] : r.status === 'EN_REFROIDISSEMENT' ? ['Refroidissement'] : [];
      return {
        resourceType: 'beneficiary', resourceId: id, step: r.status, done, pending,
        blockedBy: r.status === 'EN_REFROIDISSEMENT' ? `Délai de refroidissement jusqu’au ${r.coolingEndsAt ?? '—'}` : null,
        nextDecision: r.status === 'EN_ATTENTE_APPROBATION' ? 'Approbation (R19, personne distincte)' : null,
        owner: r.status === 'EN_ATTENTE_APPROBATION' ? 'R19' : null,
      };
    }
    return null;
  }

  // ---------- Niveau 4 : intelligence ----------
  signal(agentCode: string, metric: string, dimension: string, inc = 1): void {
    if (PII.some((re) => re.test(dimension)) || /\b(u-|OBJ-|AIR-|IAR-)/.test(dimension)) {
      throw unprocessable('MEMORY_NOT_PSEUDONYMISED', 'La mémoire d’intelligence n’accepte que des agrégats sans identifiant.');
    }
    const period = this.now().slice(0, 7);
    const id = `${period}|${agentCode}|${metric}|${dimension}`;
    const s = this.signals.get(id);
    this.signals.set(id, { id, period, agentCode, metric, dimension, count: (s?.count ?? 0) + inc, updatedAt: this.now() });
  }

  intelligence(filter: { agentCode?: string } = {}) {
    return this.signals.all().filter((s) => !filter.agentCode || s.agentCode === filter.agentCode).sort((a, b) => b.period.localeCompare(a.period) || a.id.localeCompare(b.id));
  }

  eraseIntelligence(u: User, filter: { agentCode?: string; period?: string }, reason: string) {
    let n = 0;
    for (const s of this.signals.all()) {
      if ((filter.agentCode && s.agentCode !== filter.agentCode) || (filter.period && s.period !== filter.period)) continue;
      this.signals.delete(s.id);
      n++;
    }
    this.ctx.audit.append({ actor: this.actor(u), action: 'ia.memory.intelligence.erased', resourceType: 'ia_memory', resourceId: 'intelligence', details: { ...filter, reason, count: n } });
    return { erased: n };
  }

  // ---------- Conservation ----------
  /** Purge des éléments arrivés à échéance (horloge injectée). */
  purge(by: string): { users: number; entityItems: number; signals: number } {
    const now = this.ctx.clock.now().getTime();
    let users = 0; let entityItems = 0; let signals = 0;
    for (const m of this.users.all()) {
      if (Date.parse(m.lastUsedAt) + this.retentionDays(m) * DAY < now) { this.users.delete(m.userId); users++; }
    }
    for (const i of this.entityItems.all()) {
      if (i.status === 'ACTIVE' && Date.parse(i.retainUntil) < now) { this.entityItems.delete(i.id); entityItems++; }
    }
    const limit = new Date(now - 36 * 31 * DAY).toISOString().slice(0, 7);
    for (const s of this.signals.all()) if (s.period < limit) { this.signals.delete(s.id); signals++; }
    this.ctx.audit.append({ actor: { kind: 'system', id: by }, action: 'ia.memory.purged', resourceType: 'ia_memory', resourceId: 'retention', details: { users, entityItems, signals } });
    return { users, entityItems, signals };
  }

  /** Registre (pour le délégué à la protection des données) : volumes et durées, jamais le contenu. */
  register() {
    return MEMORY_LEVELS.map((l) => ({
      level: l.level, label: l.label, conservation: l.conservation,
      volume: l.level === 'UTILISATEUR' ? this.users.size() : l.level === 'ENTITE' ? this.entityItems.all().filter((i) => i.status === 'ACTIVE').length
        : l.level === 'PROCESSUS' ? this.processes.size() : this.signals.size(),
    }));
  }
}
