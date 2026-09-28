/**
 * Trésor avancé et cycle complet de la quittance (§ 19, § 20, document maître ch. 18–20, H.10) :
 *  - files d'exception traitables (affectation, en cours, résolue / classée avec motif, justificatif, quatre yeux) ;
 *  - compte d'attente (suspens) daté, justifié, avec ancienneté, apuré sous double validation ;
 *  - opérations financières en double validation (proposition, validation par une autre personne) :
 *    annulation et remplacement de quittance, contrepassation, remboursement, contre-écriture, apurement, nomenclature ;
 *  - clôture quotidienne signée (empreinte chaînée) et clôture mensuelle ;
 *  - imputation selon une nomenclature paramétrable (état « Comptabilisé ») et export signé vers la comptabilité publique.
 * Le système constate et propose ; une personne habilitée décide, une autre valide. Aucun fonds ne sort vers un compte
 * privé : un remboursement retourne vers l'instrument de paiement d'origine uniquement, exécuté par le Trésor.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canTransition, Money, type CurrencyCode, type MoneyJSON, type RevenueCategory } from '@mosolo/shared';
import { actorOf, type AuditActor } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, HOUR_MS } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { AppContext } from '../../context.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import type { PaymentOrder, UnappliedPayment } from '../../modules/payments/service.js';
import type { Receipt, ReceiptDecision } from '../../modules/receipts/service.js';
import type { LedgerEntry } from '../../modules/treasury/ledger.js';
import type { ExceptionStatus, ExceptionType, ReconciliationException } from '../../modules/treasury/service.js';
import type { MatchingService } from './appariement.js';
import type { PointContractsService } from './points-contrats.js';

/* ------------------------------------------------------------------ types */

export const EXCEPTION_SLA_HOURS = 48;
export const SUSPENSE_SLA_DAYS = 5;
export const SUSPENSE_MAX_DAYS = 30;
/** Délai de règlement prestataire (jours) : au-delà, la créance est en retard (alerte ; clôture quotidienne bloquée sauf dérogation). */
export const PROVIDER_SETTLEMENT_DELAY_DAYS = 3;

/**
 * Seuils (PARAMÈTRES DE DÉMONSTRATION, à fixer par acte) à partir desquels un remboursement ou une restitution exige une
 * seconde validation (trois personnes distinctes : proposant + deux valideurs). Par devise, SANS conversion : une devise
 * sans seuil déclaré exige toujours la seconde validation.
 */
export const REFUND_EXTRA_APPROVAL_THRESHOLDS: Partial<Record<CurrencyCode, MoneyJSON>> = {
  USD: { amount: '1000.00', currency: 'USD' },
  CDF: { amount: '2850000.00', currency: 'CDF' },
};

/**
 * Exceptions portant de l'argent (crédit constaté ou créance sur prestataire) : jamais « classées sans suite » ; elles se
 * terminent par une mise en suspens passée, un rapprochement ou une opération financière exécutée, avec justificatif.
 */
export const MONEY_EXCEPTION_TYPES: ReadonlySet<ExceptionType> = new Set<ExceptionType>([
  'ORPHAN_CREDIT', 'CREDIT_WITHOUT_CONFIRMATION', 'UNKNOWN_ACCOUNT', 'DUPLICATE_CREDIT', 'AMOUNT_MISMATCH', 'MISSING_SETTLEMENT',
  'PROVIDER_AMBIGUOUS', 'UNAPPLIED_PAYMENT', 'WRONG_ACCOUNT', 'ACCOUNT_VERSION_MISMATCH', 'RECEIPT_NOT_FINALIZABLE', 'CREDIT_GROUPE_ECART',
  'PROVIDER_EVENT_UNKNOWN_REFERENCE', 'PROVIDER_EVENT_MISMATCH',
]);

/** Écritures appartenant à un objet métier : corrigées par leur propre opération (contrepassation, remboursement, apurement). */
export const BUSINESS_OWNED_SOURCES: ReadonlySet<string> = new Set(['payment_order', 'obligation', 'suspense', 'unapplied_payment']);

/**
 * Clé privée Ed25519 de signature des clôtures et exports (MOSOLO_CLOSURE_SIGNING_KEY) : PEM PKCS#8 ou DER PKCS#8 en
 * base64. Absente ⇒ undefined (clé éphémère : démonstration, tests ; les clôtures persistées ne se vérifient plus après
 * redémarrage). Fournie mais illisible ou d'un autre algorithme ⇒ erreur (jamais de repli silencieux).
 */
export function loadClosureSigningKey(raw: string | undefined): KeyObject | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let key: KeyObject;
  try {
    key = value.includes('-----BEGIN')
      ? createPrivateKey(value.replace(/\\n/g, '\n'))
      : createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('MOSOLO_CLOSURE_SIGNING_KEY illisible : clé privée Ed25519 PKCS#8 attendue (PEM ou base64 DER).');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`MOSOLO_CLOSURE_SIGNING_KEY : clé Ed25519 attendue (reçu ${key.asymmetricKeyType ?? 'inconnu'}).`);
  return key;
}

export interface Evidence {
  label: string;
  /** Empreinte SHA-256 de la pièce (la pièce elle-même reste dans la GED). */
  sha256?: string;
  note?: string;
  addedBy: string;
  addedAt: string;
}

export interface CaseEvent {
  at: string;
  by: string;
  action: 'AFFECTEE' | 'PRISE_EN_CHARGE' | 'JUSTIFICATIF' | 'RESOLUTION_PROPOSEE' | 'RESOLUTION_VALIDEE' | 'RESOLUTION_REJETEE';
  note?: string;
}

/**
 * AUCUNE : seulement pour une exception sans argent. MISE_EN_SUSPENS : crédit constaté porté au compte d'attente.
 * RAPPROCHEMENT : ligne de relevé qui règle un paiement non affecté (doublon, retard) déjà en compte d'attente.
 * OPERATION : opération financière exécutée à quatre yeux (contrepassation, remboursement, apurement) qui éteint l'exception.
 */
export type ResolutionAction = 'AUCUNE' | 'MISE_EN_SUSPENS' | 'RAPPROCHEMENT' | 'OPERATION';

export interface ExceptionCase {
  id: string; // = identifiant de l'exception
  status: ExceptionStatus;
  assignee?: string;
  assignedBy?: string;
  assignedAt?: string;
  startedAt?: string;
  evidence: Evidence[];
  proposal?: { outcome: 'RESOLUE' | 'CLASSEE'; motif: string; action: ResolutionAction; operationId?: string; proposedBy: string; proposedAt: string };
  decision?: { approvedBy: string; approvedAt: string; suspenseId?: string; unappliedId?: string; ledgerEntryId?: string; operationId?: string; reference?: string };
  history: CaseEvent[];
}

export interface SuspenseItem {
  id: string;
  accountAlias: string;
  amount: MoneyJSON;
  valueDate: string;
  statementId?: string;
  paymentReference?: string;
  exceptionId?: string;
  /** Justification de la mise en suspens (obligatoire). */
  justification: string;
  openedAt: string;
  openedBy: string;
  approvedBy?: string;
  ledgerEntryId: string;
  status: 'OUVERT' | 'APURE';
  clearing?: {
    operationId: string; mode: 'AFFECTATION' | 'RESTITUTION' | 'FUSION'; paymentReference?: string; ledgerEntryId: string; at: string;
    /** Restitution : instrument d'origine, référence de remboursement du prestataire ou de la banque, empreinte de la pièce. */
    destination?: string; refundReference?: string; evidenceSha256?: string;
  };
  /**
   * Instrument d'origine des fonds (empreinte du MSISDN payeur, contrepartie du relevé) : SEULE destination possible
   * d'une restitution. Absent ⇒ restitution impossible tant que l'origine n'est pas identifiée.
   */
  sourceInstrument?: string;
  demo?: boolean;
  /**
   * Paiement reçu mais non affecté (doublon, référence expirée…) : fonds encore chez le prestataire. Seule la
   * restitution à l'instrument d'origine est possible ; elle solde la créance sur le prestataire.
   */
  unappliedId?: string;
}

export type OperationKind =
  | 'ANNULATION_QUITTANCE' | 'REMPLACEMENT_QUITTANCE' | 'CONTREPASSATION' | 'REMBOURSEMENT'
  | 'CONTRE_ECRITURE' | 'APUREMENT_SUSPENS' | 'PARAMETRE_NOMENCLATURE'
  /** Instruction de virement d'un des DEUX flux de la clé de répartition du § 37A (jamais automatique). */
  | 'DECAISSEMENT_REPARTITION'
  /**
   * Récupération des sommes versées à un sous-traitant pour des objets fictifs ou des constats frauduleux (§ 15A.7) :
   * ordre de reversement émis après une décision à deux personnes du contrôle qualité, puis validé ici à quatre yeux.
   */
  | 'RECUPERATION_SOUS_TRAITANT';

export const RECEIPT_KINDS: OperationKind[] = ['ANNULATION_QUITTANCE', 'REMPLACEMENT_QUITTANCE'];

export interface OperationInput {
  kind: OperationKind;
  reason: string;
  /** Motif générique affiché publiquement (quittances) ; défaut selon le type. */
  publicReason?: string;
  receipt?: string;
  paymentReference?: string;
  ledgerEntryId?: string;
  suspenseId?: string;
  mode?: 'AFFECTATION' | 'RESTITUTION';
  /** Remboursement / restitution : empreinte de l'instrument de destination, qui doit être l'instrument d'origine. */
  destination?: string;
  nomenclature?: { revenueCategory: RevenueCategory; code: string; label: string; officialAct?: string };
  /** Décaissement de répartition (§ 37A.4) : répartition arrêtée et flux (deux flux seulement). */
  repartition?: { distributionId: string; flow: string };
  /** Récupération auprès d'un sous-traitant (§ 15A.7) : décision de récupération du module terrain. */
  recuperation?: { clawbackId: string };
}

/**
 * Passerelle vers les décisions de récupération du contrôle qualité terrain (§ 15A.7), branchée par le module terrain.
 * Le Trésor ne calcule rien : il demande la cible (refus si la récupération n'est pas décidée ou déjà ordonnée) puis,
 * après validation, fait constater l'ordre de reversement (aucun fonds ne sort ; le sous-traitant reverse).
 */
export interface RecuperationGate {
  target(input: OperationInput): { key: string; label: string; amount: MoneyJSON };
  executed(op: FinancialOperation, user: User, at: string): Record<string, unknown>;
}

/**
 * Passerelle vers la clé de répartition du § 37A (module pilotage/repartition), branchée après construction. Le Trésor
 * ne calcule rien : il demande la cible (refus si la clé n'est pas ACTIVE, si le flux n'est pas l'un des deux flux ou
 * s'il a déjà été instruit) et, après la seconde validation, fait constater l'instruction de virement.
 */
export interface RepartitionGate {
  target(input: OperationInput): { key: string; label: string; amount: MoneyJSON };
  executed(op: FinancialOperation, user: User, at: string, actor?: AuditActor): Record<string, unknown>;
}

export interface FinancialOperation {
  id: string;
  kind: OperationKind;
  status: 'PROPOSEE' | 'EXECUTEE' | 'REJETEE';
  input: OperationInput;
  /** Résumé lisible de la cible, calculé à la proposition (aucune donnée nominative). */
  target: { label: string; amount?: MoneyJSON; key: string };
  proposedBy: string;
  proposedAt: string;
  /** Validations reçues (remboursement au-delà du seuil : deux valideurs distincts avant exécution). */
  approvals?: { by: string; at: string; note?: string }[];
  requiredApprovals?: number;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  result?: Record<string, unknown>;
  /**
   * Exécution AUTOMATIQUE (répartition du § 37A, décision du maître d'ouvrage du 27/09/2026) : fondée sur l'acte et la
   * convention tripartite enregistrés, sans validation humaine au cas par cas ; piste d'audit complète.
   */
  automatic?: { acte: string; convention: string };
}

export interface NomenclatureEntry {
  revenueCategory: RevenueCategory;
  code: string;
  label: string;
  /** Code de démonstration (fictif) tant qu'aucun acte officiel n'est référencé (J1 : nomenclature consolidée). */
  demo: boolean;
  officialAct?: string;
  version: number;
  updatedAt: string;
  approvedBy?: string;
}

export interface Imputation {
  id: string; // = identifiant de l'ordre de paiement
  paymentReference: string;
  receiptNumber?: string;
  ledgerEntryId: string;
  entryDate: string;
  code: string;
  label: string;
  demo: boolean;
  nomenclatureVersion: number;
  amount: MoneyJSON;
  imputedAt: string;
  imputedBy: string;
}

export interface DailyClosure {
  id: string;
  date: string;
  fromSeq: number;
  toSeq: number;
  entries: number;
  totals: { currency: CurrencyCode; debit: MoneyJSON; credit: MoneyJSON; balanced: boolean }[];
  balanced: boolean;
  entriesHash: string;
  ledgerHeadHash: string | null;
  openExceptions: number;
  openSuspense: number;
  unimputed: number;
  /** Dérogation validée par un second comptable (exceptions d'argent ouvertes, créances prestataire en retard). */
  waiver?: { id: string; motif: string; requestedBy: string; approvedBy: string; blockers: ClosureBlockers };
  prevHash: string;
  hash: string;
  signature: string;
  closedBy: string;
  closedAt: string;
}

export interface MonthlyClosure {
  id: string;
  month: string;
  dailyClosures: string[];
  dailyHashes: string[];
  totals: { currency: CurrencyCode; debit: MoneyJSON; credit: MoneyJSON }[];
  imputed: number;
  prevHash: string;
  hash: string;
  signature: string;
  closedBy: string;
  closedAt: string;
}

export interface ClosureBlockers {
  openMoneyExceptions: number;
  overdueProviderReceivables: number;
}

/** Dérogation de clôture quotidienne : demandée par un comptable (R17) avec motif, validée par un AUTRE R17. */
export interface ClosureWaiver {
  id: string;
  date: string;
  motif: string;
  blockers: ClosureBlockers;
  status: 'DEMANDEE' | 'APPROUVEE' | 'UTILISEE';
  requestedBy: string;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  closureId?: string;
}

export interface ApprovalInput {
  note?: string;
  /** Exécution d'un remboursement / d'une restitution : référence du prestataire ou de la banque et empreinte de la pièce. */
  refundReference?: string;
  evidenceSha256?: string;
}

const GENESIS = '0'.repeat(64);

const DEFAULT_PUBLIC_REASON: Partial<Record<OperationKind, string>> = {
  ANNULATION_QUITTANCE: 'Annulée par décision motivée de la régie.',
  REMPLACEMENT_QUITTANCE: 'Remplacée par décision motivée de la régie.',
  CONTREPASSATION: 'Paiement contrepassé.',
  REMBOURSEMENT: 'Paiement remboursé.',
};

/** Date civile de Kinshasa (UTC+1, sans heure d'été). */
export function kinDate(iso: string | Date): string {
  const t = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime();
  return new Date(t + HOUR_MS).toISOString().slice(0, 10);
}

function sumByCurrency(items: MoneyJSON[]): MoneyJSON[] {
  const m = new Map<CurrencyCode, Money>();
  for (const j of items) {
    const v = Money.fromJSON(j);
    m.set(v.currency, (m.get(v.currency) ?? Money.zero(v.currency)).add(v));
  }
  return [...m.values()].map((v) => v.toJSON());
}

/* ------------------------------------------------------------------ service */

export class TresorService {
  readonly cases = new InMemoryRepository<ExceptionCase>();
  readonly suspense = new InMemoryRepository<SuspenseItem>();
  readonly operations = new InMemoryRepository<FinancialOperation>();
  /** Clé de répartition du § 37A (absente : aucun décaissement de répartition possible). */
  private repartitionGate: RepartitionGate | undefined;
  /** Décisions de récupération auprès des sous-traitants (module terrain, § 15A.7). */
  private recuperationGate: RecuperationGate | undefined;
  /** Rapprochement proposé et crédits groupés (§ 20.1) — branché par le module (plugin.ts). */
  matching!: MatchingService;
  /** Clauses contractuelles des points de paiement agréés (§ 37) — branché par le module (plugin.ts). */
  pointContracts!: PointContractsService;
  readonly nomenclature = new Map<string, NomenclatureEntry>();
  readonly imputations = new InMemoryRepository<Imputation>();
  readonly daily = new InMemoryAppendOnlyRepository<DailyClosure>();
  readonly monthly = new InMemoryAppendOnlyRepository<MonthlyClosure>();
  readonly waivers = new InMemoryRepository<ClosureWaiver>();
  private nomenclatureVersion = 0;
  private readonly ids = new IdGenerator();
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private readonly agedNotified = new Set<string>();
  /** Alertes déjà levées (créance prestataire en retard, écart grand livre / états métier) : une seule fois chacune. */
  private readonly alerted = new Set<string>();

  constructor(private readonly ctx: AppContext, opts: { closureSigningKey?: KeyObject } = {}) {
    // Clé stable entre redémarrages (MOSOLO_CLOSURE_SIGNING_KEY) ; à défaut, clé éphémère (démonstration, tests).
    const key = opts.closureSigningKey ?? loadClosureSigningKey(process.env.MOSOLO_CLOSURE_SIGNING_KEY);
    if (key) {
      this.privateKey = key;
      this.publicKey = createPublicKey(key);
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    ctx.treasury.setExceptionOverlay((e) => this.decorate(e));
    // Crédit expliqué par le système (versement de point agréé constaté au relevé) : dossier clos, jamais supprimé.
    ctx.treasury.onExceptionResolved((id, r) => {
      const c = this.caseOf(id);
      this.cases.update({ ...c, status: 'RESOLUE', decision: { approvedBy: r.resolvedBy, approvedAt: r.resolvedAt, reference: r.reference }, history: [...c.history, { at: r.resolvedAt, by: r.resolvedBy, action: 'RESOLUTION_VALIDEE', note: r.motif }] });
    });
    // Paiement non affecté : porté au compte d'attente (écriture déjà passée par le module paiements), daté, justifié.
    ctx.payments.onUnapplied((u) => this.onUnapplied(u));
  }

  private onUnapplied(u: UnappliedPayment): void {
    const item = this.openSuspense({
      accountAlias: u.beneficiaryAlias, amount: u.amount, valueDate: kinDate(u.receivedAt), paymentReference: u.paymentReference,
      exceptionId: `EXC-NAFF-${u.id}`, unappliedId: u.id, openedBy: 'systeme:paiements',
      ...(u.payerInstrumentHash ? { sourceInstrument: u.payerInstrumentHash } : {}),
      justification: `Paiement ${u.provider} ${u.providerTxnId} non affecté (${u.reason}) : remboursement vers l'instrument d'origine à décider.`,
    }, u.ledgerEntryId);
    // Le crédit de ce même paiement est DÉJÀ au compte d'attente depuis une ligne de relevé (relevé arrivé avant le
    // rappel) : les deux suspens désignent une seule unité monétaire. Le suspens de relevé est fusionné (créance sur le
    // prestataire soldée) ; seul le suspens du paiement non affecté reste restituable, une seule fois.
    const line = this.suspense.findOne((s) => s.status === 'OUVERT' && !s.unappliedId && !!s.statementId && s.paymentReference === u.paymentReference
      && s.accountAlias === u.beneficiaryAlias && Money.fromJSON(s.amount).equals(Money.fromJSON(u.amount)));
    if (!line) return;
    const at = this.now();
    const entry = this.ctx.ledger.postPair({
      eventType: 'SUSPENSE_MERGED', description: `Suspens ${line.id} (relevé ${line.statementId}) fusionné avec le paiement non affecté ${u.id} : même crédit`,
      sourceType: 'suspense', sourceId: line.id, debit: 'COMPTE_ATTENTE', credit: 'FONDS_A_RECEVOIR_PRESTATAIRES', amount: u.amount,
    });
    this.ctx.payments.markUnappliedSettled(u.id, { statementId: line.statementId!, ledgerEntryId: entry.id, at });
    this.suspense.update({ ...line, status: 'APURE', clearing: { operationId: `FUSION-${item.id}`, mode: 'FUSION', ledgerEntryId: entry.id, at } });
    this.suspense.update({ ...this.suspense.get(item.id)!, ...(line.sourceInstrument && !item.sourceInstrument ? { sourceInstrument: line.sourceInstrument } : {}) });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'tresor' }, action: 'suspense.merged', resourceType: 'suspense', resourceId: line.id, details: { into: item.id, unappliedId: u.id, ledgerEntryId: entry.id } });
    this.ctx.alerts.raise({
      type: 'SUSPENSE_MERGED', severity: 'HIGH', source: 'tresor',
      detail: `Crédit ${u.paymentReference} constaté sur relevé puis annoncé comme paiement non affecté : suspens ${line.id} fusionné dans ${item.id} (une seule restitution possible).`,
      context: { suspenseId: line.id, into: item.id, unappliedId: u.id },
    });
  }

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  private signHex(hash: string): string {
    return sign(null, Buffer.from(hash), this.privateKey).toString('base64url');
  }

  /* ---------------------------------------------------------- exceptions */

  private decorate(e: ReconciliationException): ReconciliationException {
    const c = this.cases.get(e.id);
    const opened = new Date(e.openedAt).getTime();
    const now = this.ctx.clock.now().getTime();
    const dueAt = new Date(opened + EXCEPTION_SLA_HOURS * HOUR_MS).toISOString();
    const status: ExceptionStatus = c?.status ?? e.status;
    const done = status === 'RESOLUE' || status === 'CLASSEE';
    const assignee = c?.assignee ? this.ctx.users.get(c.assignee) : undefined;
    return {
      ...e,
      status,
      dueAt,
      ageHours: Math.max(0, Math.floor((now - opened) / HOUR_MS)),
      overdue: !done && now > opened + EXCEPTION_SLA_HOURS * HOUR_MS,
      ...(c?.assignee ? { assignee: c.assignee, assigneeName: assignee?.name ?? c.assignee } : {}),
      ...(c?.proposal ? { proposal: c.proposal } : {}),
      ...(c?.decision ? { decision: c.decision } : {}),
      evidence: c?.evidence ?? [],
      history: c?.history ?? [],
      carriesMoney: this.carriesMoney(e),
    };
  }

  /** Exception portant de l'argent : crédit constaté (ligne de relevé) ou type monétaire. */
  private carriesMoney(e: ReconciliationException): boolean {
    return !!e.line || MONEY_EXCEPTION_TYPES.has(e.type);
  }

  private exception(user: User, id: string): ReconciliationException {
    const e = this.ctx.treasury.listExceptions(user).find((x) => x.id === id);
    if (!e) throw notFound('EXCEPTION_NOT_FOUND', `Exception inconnue ou déjà sortie de la file : ${id}`);
    return e;
  }

  private caseOf(id: string): ExceptionCase {
    return this.cases.get(id) ?? this.cases.insert({ id, status: 'OUVERTE', evidence: [], history: [] });
  }

  listExceptions(user: User, filter: { queue?: string; status?: string } = {}) {
    authorize(user, 'tresor:exception.read');
    const all = this.ctx.treasury.listExceptions(user);
    // Exceptions ayant dépassé le délai de 48 h : signalées une seule fois au Trésor (revue du contrôle interne).
    const aged = all.filter((e) => e.overdue === true && !this.agedNotified.has(e.id));
    if (aged.length) {
      for (const e of aged) this.agedNotified.add(e.id);
      this.ctx.comms.publish('reconciliation.exception.aged', this.ctx.users.withRole('R17').map(userRecipient), { reference: aged.map((e) => e.id).join(', ') }, { entity: 'TRESOR' });
    }
    const items = all.filter((e) => (!filter.queue || e.queue === filter.queue) && (!filter.status || e.status === filter.status));
    const queues = ['PAIEMENT_SANS_OBLIGATION', 'OBLIGATION_SANS_REGLEMENT', 'REGLEMENT_SANS_PAIEMENT', 'ECART_MONTANT'].map((q) => {
      const inQ = all.filter((e) => e.queue === q);
      return {
        queue: q,
        open: inQ.filter((e) => e.status === 'OUVERTE').length,
        inProgress: inQ.filter((e) => e.status === 'EN_COURS').length,
        closed: inQ.filter((e) => e.status === 'RESOLUE' || e.status === 'CLASSEE').length,
        overdue: inQ.filter((e) => e.overdue === true).length,
      };
    });
    return { items, queues, slaHours: EXCEPTION_SLA_HOURS };
  }

  assign(user: User, id: string, assigneeId: string) {
    authorize(user, 'tresor:exception.assign');
    const e = this.exception(user, id);
    if (e.status === 'RESOLUE' || e.status === 'CLASSEE') throw conflict('EXCEPTION_CLOSED', `L'exception ${id} est close.`);
    const assignee = this.ctx.users.get(assigneeId);
    if (!assignee || !assignee.roles.some((r) => r === 'R18' || r === 'R17')) {
      throw unprocessable('ASSIGNEE_NOT_ELIGIBLE', 'Une exception ne s’affecte qu’à un analyste de rapprochement ou à un comptable public.');
    }
    const c = this.caseOf(id);
    const at = this.now();
    const updated = this.cases.update({
      ...c, assignee: assigneeId, assignedBy: user.id, assignedAt: at, status: c.status === 'OUVERTE' ? 'OUVERTE' : c.status,
      history: [...c.history, { at, by: user.id, action: 'AFFECTEE', note: assignee.name }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.assigned', resourceType: 'reconciliation_exception', resourceId: id, details: { assignee: assigneeId } });
    this.ctx.comms.publish('reconciliation.exception.opened', [userRecipient(assignee)], { reference: id }, { entity: 'TRESOR' });
    void updated;
    return this.exception(user, id);
  }

  private requireAssignee(user: User, c: ExceptionCase, id: string): void {
    if (c.assignee !== user.id) throw conflict('NOT_ASSIGNEE', `Seule la personne affectée à l'exception ${id} peut la traiter${c.assignee ? '' : ' (aucune affectation)'}.`);
  }

  start(user: User, id: string) {
    authorize(user, 'tresor:exception.work');
    this.exception(user, id); // contrôle d'accès et d'existence
    const c = this.caseOf(id);
    this.requireAssignee(user, c, id);
    if (c.status !== 'OUVERTE') throw conflict('EXCEPTION_INVALID_TRANSITION', `Exception ${id} : déjà ${c.status}.`);
    const at = this.now();
    this.cases.update({ ...c, status: 'EN_COURS', startedAt: at, history: [...c.history, { at, by: user.id, action: 'PRISE_EN_CHARGE' }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.started', resourceType: 'reconciliation_exception', resourceId: id });
    return this.exception(user, id);
  }

  addEvidence(user: User, id: string, input: { label: string; sha256?: string; note?: string }) {
    authorize(user, 'tresor:exception.work');
    this.exception(user, id); // contrôle d'accès et d'existence
    const c = this.caseOf(id);
    this.requireAssignee(user, c, id);
    if (c.status === 'RESOLUE' || c.status === 'CLASSEE') throw conflict('EXCEPTION_CLOSED', `L'exception ${id} est close.`);
    const at = this.now();
    const ev: Evidence = { label: input.label, ...(input.sha256 ? { sha256: input.sha256 } : {}), ...(input.note ? { note: input.note } : {}), addedBy: user.id, addedAt: at };
    this.cases.update({ ...c, evidence: [...c.evidence, ev], history: [...c.history, { at, by: user.id, action: 'JUSTIFICATIF', note: input.label }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.evidence_added', resourceType: 'reconciliation_exception', resourceId: id, details: { label: input.label, sha256: input.sha256 ?? null } });
    return this.exception(user, id);
  }

  proposeResolution(user: User, id: string, input: { outcome: 'RESOLUE' | 'CLASSEE'; motif: string; action: ResolutionAction; operationId?: string }) {
    authorize(user, 'tresor:exception.work');
    const e = this.exception(user, id);
    const c = this.caseOf(id);
    this.requireAssignee(user, c, id);
    if (c.status !== 'EN_COURS') throw conflict('EXCEPTION_INVALID_TRANSITION', `Exception ${id} : prise en charge requise avant toute proposition (état ${c.status}).`);
    if (c.proposal && !c.decision) throw conflict('RESOLUTION_ALREADY_PROPOSED', `Une résolution attend déjà validation pour ${id}.`);
    // Séparation des tâches : qui affecte ne propose pas (et ne validera pas).
    if (c.assignedBy) assertDistinctPerson(user.id, [c.assignedBy], 'Séparation des tâches : la personne qui a affecté l’exception ne propose pas sa résolution.');
    if (input.outcome === 'RESOLUE' && c.evidence.length === 0) throw unprocessable('EVIDENCE_REQUIRED', 'Une résolution exige au moins un justificatif.');
    this.assertResolutionAllowed(e, c, input);
    const at = this.now();
    this.cases.update({ ...c, proposal: { ...input, proposedBy: user.id, proposedAt: at }, history: [...c.history, { at, by: user.id, action: 'RESOLUTION_PROPOSEE', note: `${input.outcome} — ${input.motif}` }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.resolution_proposed', resourceType: 'reconciliation_exception', resourceId: id, details: { ...input } });
    return this.exception(user, id);
  }

  /**
   * Une exception qui porte de l'argent ne se « classe » jamais sans suite : RESOLUE, avec justificatif ayant une
   * empreinte, et l'action financière correspondante (mise en suspens passée, rapprochement, opération exécutée).
   */
  private assertResolutionAllowed(e: ReconciliationException, c: ExceptionCase, p: { outcome: 'RESOLUE' | 'CLASSEE'; action: ResolutionAction; operationId?: string }): void {
    if (this.carriesMoney(e)) {
      if (p.outcome !== 'RESOLUE' || p.action === 'AUCUNE') {
        throw unprocessable('MONEY_EXCEPTION_NEEDS_FINANCIAL_ACTION', `L'exception ${e.id} (${e.type}) porte de l'argent : ni classement ni résolution sans action ; mise en suspens, rapprochement ou opération financière exécutée requis.`);
      }
      if (!c.evidence.some((ev) => !!ev.sha256)) throw unprocessable('EVIDENCE_REQUIRED', 'Exception portant de l’argent : un justificatif avec empreinte SHA-256 est requis.');
    }
    if (p.action === 'MISE_EN_SUSPENS') this.assertSuspendable(e);
    if (p.action === 'RAPPROCHEMENT') this.unappliedFor(e);
    if (p.action === 'OPERATION') this.assertOperationFor(e, p.operationId);
  }

  /** Paiement non affecté que règle la ligne de relevé de l'exception (même référence, même montant, même compte). */
  private unappliedFor(e: ReconciliationException): UnappliedPayment {
    if (!e.line) throw unprocessable('RAPPROCHEMENT_NEEDS_STATEMENT_LINE', 'Seule une ligne de relevé peut régler un paiement non affecté.');
    let amount: Money;
    try {
      amount = Money.parseStrict(e.line.amount);
    } catch {
      throw unprocessable('INVALID_AMOUNT', `Montant de ligne illisible : ${e.line.amount.amount} ${e.line.amount.currency}.`);
    }
    const u = this.ctx.payments.findSettleableUnapplied(e.line.paymentReference, amount, e.line.accountAlias);
    if (!u) throw unprocessable('NO_UNAPPLIED_TO_SETTLE', `Aucun paiement non affecté en attente de règlement pour ${e.line.paymentReference} (${e.line.amount.amount} ${e.line.amount.currency}).`);
    return u;
  }

  /** Opération financière exécutée (quatre yeux) qui éteint l'exception : même paiement ou suspens de l'exception. */
  private assertOperationFor(e: ReconciliationException, operationId: string | undefined): FinancialOperation {
    const op = operationId ? this.operations.get(operationId) : undefined;
    if (!op) throw unprocessable('OPERATION_REQUIRED', 'Une opération financière exécutée doit être référencée (operationId).');
    if (op.status !== 'EXECUTEE') throw conflict('OPERATION_NOT_EXECUTED', `L'opération ${op.id} est ${op.status} : seule une opération exécutée éteint une exception.`);
    const s = op.input.suspenseId ? this.suspense.get(op.input.suspenseId) : undefined;
    const related = (['CONTREPASSATION', 'REMBOURSEMENT'] as OperationKind[]).includes(op.kind)
      ? !!e.paymentReference && op.input.paymentReference === e.paymentReference
      : op.kind === 'APUREMENT_SUSPENS' && !!s && (s.exceptionId === e.id || (!!e.paymentReference && s.paymentReference === e.paymentReference));
    if (!related) throw unprocessable('OPERATION_UNRELATED', `L'opération ${op.id} (${op.kind}) ne porte ni sur le paiement ni sur le suspens de l'exception ${e.id}.`);
    const used = this.cases.findOne((x) => x.id !== e.id && x.proposal?.operationId === op.id);
    if (used) throw conflict('OPERATION_ALREADY_USED', `L'opération ${op.id} éteint déjà l'exception ${used.id}.`);
    return op;
  }

  private assertSuspendable(e: ReconciliationException): void {
    if (!e.line) throw unprocessable('SUSPENSE_NEEDS_STATEMENT_LINE', 'Seul un crédit constaté sur relevé peut être porté en compte d’attente.');
    if (!this.ctx.vault.current(e.line.accountAlias)) throw unprocessable('SUSPENSE_UNKNOWN_ACCOUNT', `Le compte ${e.line.accountAlias} n'est pas un compte public du coffre : aucun suspens possible.`);
    if (this.suspense.findOne((s) => s.exceptionId === e.id)) throw conflict('SUSPENSE_ALREADY_OPENED', `Un suspens existe déjà pour ${e.id}.`);
    // Ce crédit est celui d'un paiement non affecté déjà en compte d'attente : jamais un second suspens (double
    // restitution) ; la ligne se RAPPROCHE du paiement non affecté.
    let amount: Money | undefined;
    try {
      amount = Money.parseStrict(e.line.amount);
    } catch {
      amount = undefined;
    }
    const u = amount ? this.ctx.payments.findSettleableUnapplied(e.line.paymentReference, amount, e.line.accountAlias) : undefined;
    if (u) throw conflict('SUSPENSE_COVERED_BY_UNAPPLIED', `Ce crédit règle le paiement non affecté ${u.id} déjà en compte d'attente : résolution par RAPPROCHEMENT, jamais un second suspens.`);
  }

  approveResolution(user: User, id: string) {
    authorize(user, 'tresor:exception.approve');
    const e = this.exception(user, id);
    const c = this.caseOf(id);
    if (!c.proposal || c.decision) throw conflict('NO_PENDING_RESOLUTION', `Aucune résolution en attente pour ${id}.`);
    assertDistinctPerson(user.id, [c.proposal.proposedBy, ...(c.assignedBy ? [c.assignedBy] : [])], 'Quatre yeux : la résolution est validée par une personne distincte de son auteur et de celle qui a affecté l’exception.');
    // Contrôles rejoués à la validation : l'état a pu changer depuis la proposition.
    this.assertResolutionAllowed(e, c, c.proposal);
    const at = this.now();
    let suspenseId: string | undefined;
    let settled: { unappliedId: string; ledgerEntryId: string } | undefined;
    if (c.proposal.action === 'MISE_EN_SUSPENS') {
      suspenseId = this.openSuspense({
        accountAlias: e.line!.accountAlias, amount: e.line!.amount, valueDate: e.line!.valueDate,
        ...(e.statementId ? { statementId: e.statementId } : {}), ...(e.paymentReference ? { paymentReference: e.paymentReference } : {}),
        ...(e.line!.counterparty ? { sourceInstrument: e.line!.counterparty } : {}),
        exceptionId: id, justification: c.proposal.motif, openedBy: c.proposal.proposedBy, approvedBy: user.id,
      }).id;
    } else if (c.proposal.action === 'RAPPROCHEMENT') {
      const u = this.unappliedFor(e);
      const r = this.ctx.treasury.settleUnapplied(u, {
        statementId: e.statementId ?? `EXC-${id}`, ...(e.line!.accountVersion !== undefined ? { accountVersion: e.line!.accountVersion } : {}), actor: actorOf(user),
      });
      settled = { unappliedId: u.id, ledgerEntryId: r.ledgerEntryId };
    }
    this.cases.update({
      ...c, status: c.proposal.outcome,
      decision: {
        approvedBy: user.id, approvedAt: at, ...(suspenseId ? { suspenseId } : {}), ...(settled ?? {}),
        ...(c.proposal.operationId ? { operationId: c.proposal.operationId } : {}),
      },
      history: [...c.history, { at, by: user.id, action: 'RESOLUTION_VALIDEE', note: suspenseId ? `Suspens ${suspenseId}` : settled ? `Rapprochement ${settled.unappliedId}` : c.proposal.operationId }],
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: `reconciliation.exception.${c.proposal.outcome === 'RESOLUE' ? 'resolved' : 'classified'}`,
      resourceType: 'reconciliation_exception', resourceId: id,
      details: { proposedBy: c.proposal.proposedBy, assignedBy: c.assignedBy ?? null, motif: c.proposal.motif, action: c.proposal.action, suspenseId: suspenseId ?? null, unappliedId: settled?.unappliedId ?? null, operationId: c.proposal.operationId ?? null },
    });
    return this.exception(user, id);
  }

  rejectResolution(user: User, id: string, motif: string) {
    authorize(user, 'tresor:exception.approve');
    this.exception(user, id); // contrôle d'accès et d'existence
    const c = this.caseOf(id);
    if (!c.proposal || c.decision) throw conflict('NO_PENDING_RESOLUTION', `Aucune résolution en attente pour ${id}.`);
    assertDistinctPerson(user.id, [c.proposal.proposedBy], 'Quatre yeux : le rejet revient à une autre personne que l’auteur.');
    const at = this.now();
    const { proposal: _p, ...rest } = c;
    this.cases.update({ ...rest, status: 'EN_COURS', history: [...c.history, { at, by: user.id, action: 'RESOLUTION_REJETEE', note: motif }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'reconciliation.exception.resolution_rejected', resourceType: 'reconciliation_exception', resourceId: id, details: { motif } });
    return this.exception(user, id);
  }

  /* ------------------------------------------------------------ suspens */

  /** `existingEntryId` : écriture de mise en attente déjà passée (paiement non affecté), aucune nouvelle écriture. */
  private openSuspense(input: Omit<SuspenseItem, 'id' | 'openedAt' | 'ledgerEntryId' | 'status'>, existingEntryId?: string): SuspenseItem {
    const id = this.ids.next('SUSP');
    const entryId = existingEntryId ?? this.ctx.ledger.postPair({
      eventType: 'SUSPENSE_OPENED', description: `Fonds non identifiés sur ${input.accountAlias} (${input.valueDate}) portés en compte d'attente`,
      sourceType: 'suspense', sourceId: id, debit: 'COMPTE_PUBLIC_RECETTES', credit: 'COMPTE_ATTENTE', amount: input.amount,
    }).id;
    const item = this.suspense.insert({ ...input, id, openedAt: this.now(), ledgerEntryId: entryId, status: 'OUVERT' });
    this.ctx.audit.append({
      actor: input.unappliedId ? { kind: 'system', id: input.openedBy } : { kind: 'user', id: input.approvedBy ?? input.openedBy }, action: 'suspense.opened', resourceType: 'suspense', resourceId: id,
      details: { amount: input.amount, accountAlias: input.accountAlias, exceptionId: input.exceptionId ?? null, proposedBy: input.openedBy },
    });
    return item;
  }

  private suspenseView(s: SuspenseItem) {
    const now = this.ctx.clock.now().getTime();
    const ref = new Date(`${s.valueDate}T00:00:00.000Z`).getTime();
    const ageDays = Math.max(0, Math.floor((now - ref) / DAY_MS));
    const bucket = ageDays <= 2 ? '0-2 j' : ageDays <= SUSPENSE_SLA_DAYS ? `3-${SUSPENSE_SLA_DAYS} j` : ageDays <= SUSPENSE_MAX_DAYS ? `${SUSPENSE_SLA_DAYS + 1}-${SUSPENSE_MAX_DAYS} j` : `> ${SUSPENSE_MAX_DAYS} j`;
    return { ...s, ageDays: s.status === 'OUVERT' ? ageDays : undefined, bucket: s.status === 'OUVERT' ? bucket : undefined, overSla: s.status === 'OUVERT' && ageDays > SUSPENSE_SLA_DAYS, overMax: s.status === 'OUVERT' && ageDays > SUSPENSE_MAX_DAYS };
  }

  listSuspense(user: User) {
    authorize(user, 'tresor:suspense.read');
    const items = this.suspense.all().map((s) => this.suspenseView(s)).sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    const open = items.filter((s) => s.status === 'OUVERT');
    const buckets = ['0-2 j', `3-${SUSPENSE_SLA_DAYS} j`, `${SUSPENSE_SLA_DAYS + 1}-${SUSPENSE_MAX_DAYS} j`, `> ${SUSPENSE_MAX_DAYS} j`].map((b) => ({
      bucket: b, count: open.filter((s) => s.bucket === b).length, amounts: sumByCurrency(open.filter((s) => s.bucket === b).map((s) => s.amount)),
    }));
    return { items, open: open.length, totals: sumByCurrency(open.map((s) => s.amount)), buckets, slaDays: SUSPENSE_SLA_DAYS, maxDays: SUSPENSE_MAX_DAYS };
  }

  /* ------------------------------------------------ double validation */

  /** Branche les décisions de récupération du contrôle qualité terrain (§ 15A.7). */
  attachRecuperation(gate: RecuperationGate): void {
    this.recuperationGate = gate;
  }

  /** Branche la clé de répartition du § 37A (module pilotage/repartition). */
  attachRepartition(gate: RepartitionGate): void {
    this.repartitionGate = gate;
  }

  private receiptKinds(kind: OperationKind): boolean {
    return RECEIPT_KINDS.includes(kind);
  }

  private order(ref: string | undefined): PaymentOrder {
    if (!ref) throw badRequest('PAYMENT_REFERENCE_REQUIRED', 'Référence de paiement requise.');
    const o = this.ctx.payments.byReference(ref);
    if (!o) throw notFound('PAYMENT_NOT_FOUND', `Référence de paiement inconnue : ${ref}`);
    return o;
  }

  private settlementEntries(orderId: string): LedgerEntry[] {
    return this.ctx.ledger.list({ sourceId: orderId }).filter((e) => !e.reversalOf && !this.ctx.ledger.isReversed(e.id));
  }

  /** Contrôles de recevabilité, rejoués à la validation (l'état a pu changer entre-temps). */
  private precheck(input: OperationInput): FinancialOperation['target'] {
    switch (input.kind) {
      case 'ANNULATION_QUITTANCE': {
        const r = this.ctx.receipts.require(input.receipt ?? '');
        if (r.status === 'DEFINITIVE') throw conflict('RECEIPT_DEFINITIVE', `La quittance ${r.number} est définitive : elle ne s'annule pas (remplacement, contrepassation ou remboursement).`);
        this.ctx.receipts.assertTransition(r, 'ANNULEE');
        // Un paiement confirmé compte comme payé (cumul de l'obligation) et sera rapproché : sa quittance ne s'annule
        // pas (elle laisserait un paiement confirmé sans quittance) ; la contrepassation est la seule voie.
        const o = this.ctx.payments.orders.get(r.paymentOrderId);
        if (o && (o.status === 'CONFIRME' || o.status === 'REGLE' || o.status === 'RAPPROCHE')) {
          throw conflict('PAYMENT_CONFIRMED_USE_REVERSAL', `Le paiement ${o.paymentReference} est ${o.status} : annulation de quittance impossible, utiliser la contrepassation.`);
        }
        return { key: `receipt:${r.id}`, label: `Quittance ${r.number} (${r.status})`, amount: r.amount };
      }
      case 'REMPLACEMENT_QUITTANCE': {
        const r = this.ctx.receipts.require(input.receipt ?? '');
        this.ctx.receipts.assertReplaceable(r);
        return { key: `receipt:${r.id}`, label: `Quittance ${r.number} (${r.status})`, amount: r.amount };
      }
      case 'CONTREPASSATION': {
        const o = this.order(input.paymentReference);
        if (o.status !== 'CONTREPASSE' && !canTransition(o.status, 'CONTREPASSE')) {
          throw conflict('INVALID_PAYMENT_TRANSITION', `Paiement ${o.paymentReference} au statut ${o.status} : contrepassation impossible (confirmé ou contesté requis).`);
        }
        const r = this.ctx.receipts.byPaymentOrder(o.id);
        if (o.status === 'CONTREPASSE' && (!r || r.status === 'CONTREPASSEE')) throw conflict('ALREADY_REVERSED', `Paiement ${o.paymentReference} déjà contrepassé.`);
        return { key: `payment:${o.id}`, label: `Paiement ${o.paymentReference} (${o.status})${r ? ` — quittance ${r.number}` : ''}`, amount: o.amount };
      }
      case 'REMBOURSEMENT': {
        const o = this.order(input.paymentReference);
        if (!canTransition(o.status, 'REMBOURSE')) throw conflict('INVALID_PAYMENT_TRANSITION', `Paiement ${o.paymentReference} au statut ${o.status} : remboursement possible seulement après rapprochement ou sur doublon.`);
        this.assertDestination(o.payerInstrumentHash, input.destination, `paiement ${o.paymentReference}`);
        return { key: `payment:${o.id}`, label: `Remboursement ${o.paymentReference} vers l'instrument d'origine (${o.channel}${o.provider ? `, ${o.provider}` : ''})`, amount: o.amount };
      }
      case 'CONTRE_ECRITURE': {
        const e = this.ctx.ledger.get(input.ledgerEntryId ?? '');
        if (!e) throw notFound('LEDGER_ENTRY_NOT_FOUND', `Écriture inconnue : ${input.ledgerEntryId}`);
        if (e.reversalOf) throw conflict('CANNOT_REVERSE_REVERSAL', 'Une contre-écriture ne se contrepasse pas.');
        if (this.ctx.ledger.isReversed(e.id)) throw conflict('ALREADY_REVERSED', `L'écriture ${e.id} est déjà contrepassée.`);
        // Une écriture d'objet métier (paiement, obligation, suspens, non affecté) ne se contre-passe jamais « à nu » :
        // l'état métier resterait inchangé et la recette disparaîtrait du grand livre. Opération propre à l'objet requise.
        if (BUSINESS_OWNED_SOURCES.has(e.sourceType)) {
          throw conflict('ENTRY_OWNED_BY_BUSINESS_OBJECT', `L'écriture ${e.id} (${e.eventType}) appartient à ${e.sourceType} ${e.sourceId} : utiliser la contrepassation, le remboursement ou l'apurement de cet objet.`);
        }
        return { key: `ledger:${e.id}`, label: `Écriture ${e.id} — ${e.description}`, amount: e.lines[0]!.amount };
      }
      case 'APUREMENT_SUSPENS': {
        const s = this.suspense.get(input.suspenseId ?? '');
        if (!s) throw notFound('SUSPENSE_NOT_FOUND', `Suspens inconnu : ${input.suspenseId}`);
        if (s.status !== 'OUVERT') throw conflict('SUSPENSE_CLEARED', `Le suspens ${s.id} est déjà apuré.`);
        if (input.mode === 'AFFECTATION') {
          if (s.unappliedId) throw unprocessable('UNAPPLIED_PAYMENT_REFUND_ONLY', `Le suspens ${s.id} porte un paiement non affecté : seule la restitution à l'instrument d'origine est possible.`);
          const o = this.order(input.paymentReference);
          if (o.status !== 'CONFIRME') throw conflict('PAYMENT_NOT_CONFIRMED', `Le paiement ${o.paymentReference} doit être confirmé par le prestataire (statut ${o.status}).`);
          if (!Money.fromJSON(o.amount).equals(Money.fromJSON(s.amount))) throw unprocessable('AMOUNT_MISMATCH', `Montant du suspens ${s.amount.amount} ${s.amount.currency} ≠ montant dû ${o.amount.amount} ${o.amount.currency}.`);
          if (o.beneficiaryAlias !== s.accountAlias) throw unprocessable('WRONG_ACCOUNT', `Le suspens est sur ${s.accountAlias}, le paiement est destiné à ${o.beneficiaryAlias}.`);
          return { key: `suspense:${s.id}`, label: `Affectation du suspens ${s.id} au paiement ${o.paymentReference}`, amount: s.amount };
        }
        if (input.mode === 'RESTITUTION') {
          if (s.unappliedId && this.ctx.payments.unappliedState(s.unappliedId)?.restituted) throw conflict('UNAPPLIED_ALREADY_RESTITUTED', `Le paiement non affecté ${s.unappliedId} est déjà restitué.`);
          this.assertDestination(s.sourceInstrument, input.destination, `suspens ${s.id}`);
          return { key: `suspense:${s.id}`, label: `Restitution du suspens ${s.id} à l'émetteur d'origine`, amount: s.amount };
        }
        throw badRequest('MODE_REQUIRED', 'Mode d’apurement requis : AFFECTATION ou RESTITUTION.');
      }
      case 'PARAMETRE_NOMENCLATURE': {
        const n = input.nomenclature;
        if (!n) throw badRequest('NOMENCLATURE_REQUIRED', 'Entrée de nomenclature requise.');
        return { key: `nomenclature:${n.revenueCategory}`, label: `Imputation ${n.revenueCategory} → ${n.code}${n.officialAct ? '' : ' [DÉMO]'}` };
      }
      case 'DECAISSEMENT_REPARTITION': {
        if (!this.repartitionGate) throw unprocessable('REPARTITION_INDISPONIBLE', 'Clé de répartition du § 37A non chargée : aucun décaissement de répartition.');
        return this.repartitionGate.target(input);
      }
      case 'RECUPERATION_SOUS_TRAITANT': {
        if (!this.recuperationGate) throw unprocessable('RECUPERATION_INDISPONIBLE', 'Module terrain non chargé : aucune récupération auprès d’un sous-traitant.');
        return this.recuperationGate.target(input);
      }
    }
  }

  /** Destination d'un remboursement / d'une restitution : l'instrument d'origine, connu et désigné à l'identique. */
  private assertDestination(original: string | undefined, destination: string | undefined, what: string): void {
    if (!original) throw unprocessable('ORIGINAL_INSTRUMENT_UNKNOWN', `Instrument d'origine inconnu pour ${what} : aucune restitution tant que l'émetteur n'est pas identifié (empreinte prestataire ou contrepartie du relevé).`);
    if (!destination) throw unprocessable('DESTINATION_REQUIRED', `Destination requise pour ${what} : empreinte de l'instrument d'origine.`);
    if (destination !== original) throw unprocessable('DESTINATION_NOT_ORIGINAL_INSTRUMENT', `La destination ne correspond pas à l'instrument d'origine de ${what} : aucun fonds ne sort vers un autre compte.`);
  }

  private isRefund(input: OperationInput): boolean {
    return input.kind === 'REMBOURSEMENT' || (input.kind === 'APUREMENT_SUSPENS' && input.mode === 'RESTITUTION');
  }

  /** Nombre de validations requises : deux (trois personnes) pour un remboursement au-delà du seuil de sa devise. */
  private requiredApprovals(input: OperationInput, amount: MoneyJSON | undefined): number {
    if (!this.isRefund(input) || !amount) return 1;
    const threshold = REFUND_EXTRA_APPROVAL_THRESHOLDS[amount.currency];
    if (!threshold) return 2;
    return Money.fromJSON(amount).compare(Money.fromJSON(threshold)) >= 0 ? 2 : 1;
  }

  propose(user: User, input: OperationInput): FinancialOperation {
    authorize(user, this.receiptKinds(input.kind) ? 'tresor:receipt.propose' : 'tresor:finance.propose');
    const target = this.precheck(input);
    const pending = this.operations.findOne((o) => o.status === 'PROPOSEE' && o.target.key === target.key);
    if (pending) throw conflict('OPERATION_ALREADY_PENDING', `Une opération ${pending.id} attend déjà validation sur cette cible.`);
    const op = this.operations.insert({
      id: this.ids.next('OPF'), kind: input.kind, status: 'PROPOSEE', input, target, proposedBy: user.id, proposedAt: this.now(),
      approvals: [], requiredApprovals: this.requiredApprovals(input, target.amount),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.operation.proposed', resourceType: 'financial_operation', resourceId: op.id, details: { kind: op.kind, target: target.label, reason: input.reason } });
    if (input.kind === 'REMBOURSEMENT') {
      const o = this.order(input.paymentReference);
      this.ctx.comms.publish('refund.requested', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: 'TRESOR' });
    }
    return op;
  }

  /**
   * Exécution AUTOMATIQUE d'un flux de répartition du § 37A : clé ACTIVE, acte et convention tripartite enregistrés
   * (vérifiés par la passerelle). Même cible et mêmes refus que la voie à quatre yeux (deux flux seulement, flux déjà
   * instruit refusé) ; l'opération est journalisée comme exécutée par le traitement automatique.
   */
  executeRepartitionAutomatically(input: OperationInput, principal: User, actor: AuditActor, basis: { acte: string; convention: string }): FinancialOperation {
    if (input.kind !== 'DECAISSEMENT_REPARTITION' || !this.repartitionGate) throw unprocessable('REPARTITION_INDISPONIBLE', 'Exécution automatique réservée aux flux de la répartition du § 37A.');
    const target = this.precheck(input);
    const at = this.now();
    const op = this.operations.insert({
      id: this.ids.next('OPF'), kind: input.kind, status: 'PROPOSEE', input, target, proposedBy: principal.id, proposedAt: at,
      approvals: [], requiredApprovals: 0, automatic: basis,
    });
    const result = this.repartitionGate.executed(op, principal, at, actor);
    const updated = this.operations.update({ ...op, status: 'EXECUTEE', decidedBy: principal.id, decidedAt: at, decisionNote: `Exécution automatique — acte ${basis.acte}, convention ${basis.convention}`, result });
    this.ctx.audit.append({ actor, action: 'treasury.operation.executed_automatically', resourceType: 'financial_operation', resourceId: op.id, details: { kind: op.kind, target: target.label, reason: input.reason, ...basis, ...result } });
    return updated;
  }

  listOperations(user: User, status?: string) {
    authorize(user, 'tresor:operation.read');
    return this.operations.all().filter((o) => !status || o.status === status).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  private requireOperation(id: string): FinancialOperation {
    const op = this.operations.get(id);
    if (!op) throw notFound('OPERATION_NOT_FOUND', `Opération inconnue : ${id}`);
    if (op.status !== 'PROPOSEE') throw conflict('OPERATION_ALREADY_DECIDED', `L'opération ${id} est déjà ${op.status}.`);
    return op;
  }

  reject(user: User, id: string, note: string): FinancialOperation {
    authorize(user, 'tresor:operation.approve');
    const op = this.requireOperation(id);
    assertDistinctPerson(user.id, [op.proposedBy], 'Double validation : le rejet revient à une autre personne que l’auteur.');
    const updated = this.operations.update({ ...op, status: 'REJETEE', decidedBy: user.id, decidedAt: this.now(), decisionNote: note });
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.operation.rejected', resourceType: 'financial_operation', resourceId: id, details: { kind: op.kind, note } });
    if (op.kind === 'REMBOURSEMENT') {
      const o = this.ctx.payments.byReference(op.input.paymentReference ?? '');
      if (o) this.ctx.comms.publish('refund.refused', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: 'TRESOR' });
    }
    return updated;
  }

  approve(user: User, id: string, input: ApprovalInput | string = {}): FinancialOperation {
    authorize(user, 'tresor:operation.approve');
    const opts: ApprovalInput = typeof input === 'string' ? { note: input } : input;
    const note = opts.note;
    const op = this.requireOperation(id);
    const prior = op.approvals ?? [];
    assertDistinctPerson(user.id, [op.proposedBy, ...prior.map((a) => a.by)], 'Double validation : l’opération est validée par des personnes distinctes de son auteur et entre elles.');
    const target = this.precheck(op.input);
    const at = this.now();
    const required = Math.max(op.requiredApprovals ?? 1, this.requiredApprovals(op.input, target.amount));
    const approvals = [...prior, { by: user.id, at, ...(note ? { note } : {}) }];
    if (approvals.length < required) {
      // Remboursement au-delà du seuil : première validation enregistrée, exécution par une troisième personne.
      const pending = this.operations.update({ ...op, approvals, requiredApprovals: required });
      this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.operation.approval_recorded', resourceType: 'financial_operation', resourceId: id, details: { kind: op.kind, approvals: approvals.length, required } });
      return pending;
    }
    let execution: { refundReference: string; evidenceSha256: string } | undefined;
    if (this.isRefund(op.input)) {
      if (!opts.refundReference || !opts.evidenceSha256) {
        throw unprocessable('REFUND_EXECUTION_PROOF_REQUIRED', 'Exécution d’un remboursement : référence de remboursement du prestataire ou de la banque et empreinte SHA-256 de la pièce requises.');
      }
      const dup = this.operations.findOne((o) => o.id !== op.id && o.status === 'EXECUTEE' && (o.result as { refundReference?: string } | undefined)?.refundReference === opts.refundReference);
      if (dup) throw conflict('REFUND_REFERENCE_ALREADY_USED', `La référence de remboursement ${opts.refundReference} justifie déjà l'opération ${dup.id}.`);
      execution = { refundReference: opts.refundReference, evidenceSha256: opts.evidenceSha256 };
    }
    const decision: ReceiptDecision = {
      operationId: op.id, proposedBy: op.proposedBy, approvedBy: user.id, reason: op.input.reason,
      publicReason: op.input.publicReason ?? DEFAULT_PUBLIC_REASON[op.kind] ?? 'Décision motivée de la régie.', at,
    };
    const result = { ...this.execute(user, op, decision, execution), ...(execution ?? {}), ...(approvals.length > 1 ? { approvedBy: approvals.map((a) => a.by) } : {}) };
    const updated = this.operations.update({ ...op, approvals, requiredApprovals: required, status: 'EXECUTEE', decidedBy: user.id, decidedAt: at, ...(note ? { decisionNote: note } : {}), result });
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.operation.executed', resourceType: 'financial_operation', resourceId: id, details: { kind: op.kind, proposedBy: op.proposedBy, ...result } });
    return updated;
  }

  /**
   * Après contrepassation ou remboursement : l'obligation en vigueur reprend l'état que justifie le cumul encore payé
   * (SOLDEE, PARTIELLEMENT_PAYEE ou EXIGIBLE). Seuls ces états « de paiement » sont recalculés ; ANNULEE, CONTESTEE…
   * ne sont jamais touchés.
   */
  private restoreObligationStatus(obligationId: string) {
    const ob = this.ctx.assessment.get(this.ctx.payments.currentObligationId(obligationId));
    if (ob.status !== 'SOLDEE' && ob.status !== 'PARTIELLEMENT_PAYEE') return ob;
    const paid = this.ctx.payments.paidOn(ob.id);
    const status = paid.compare(Money.fromJSON(ob.amount)) >= 0 ? 'SOLDEE' : paid.isZero() ? 'EXIGIBLE' : 'PARTIELLEMENT_PAYEE';
    return status === ob.status ? ob : this.ctx.assessment.setStatus(ob.id, status);
  }

  private notifyTaxpayer(event: string, r: Receipt | undefined, reference: string): void {
    if (!r) return;
    this.ctx.comms.publish(event, [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference }, { entity: r.administration });
  }

  private execute(user: User, op: FinancialOperation, decision: ReceiptDecision, execution?: { refundReference: string; evidenceSha256: string }): Record<string, unknown> {
    const actor = actorOf(user);
    const input = op.input;
    switch (input.kind) {
      case 'ANNULATION_QUITTANCE': {
        const r = this.ctx.receipts.applyDecision(input.receipt!, 'ANNULEE', decision);
        this.notifyTaxpayer('receipt.cancelled', r, r.number);
        return { receiptNumber: r.number, receiptStatus: r.status };
      }
      case 'REMPLACEMENT_QUITTANCE': {
        const r = this.ctx.receipts.require(input.receipt!);
        const tp = this.ctx.taxpayers.get(r.taxpayerId);
        const ob = this.ctx.assessment.get(r.obligationId);
        const { original, replacement } = this.ctx.receipts.replace(r.id, { taxpayerRef: tp.iuc, revenueCategory: ob.label, administration: ob.entity }, decision);
        this.notifyTaxpayer('receipt.replaced', replacement, replacement.number);
        return { receiptNumber: original.number, replacedBy: replacement.number, replacementCode: replacement.code };
      }
      case 'CONTREPASSATION': {
        const o = this.order(input.paymentReference);
        const reversed: string[] = [];
        for (const e of this.settlementEntries(o.id)) reversed.push(this.ctx.ledger.reverse(e.id, `Contrepassation ${op.id} : ${input.reason}`, actor).id);
        if (o.status !== 'CONTREPASSE') {
          // Transition contrôlée par la table partagée des états de paiement (CONFIRME|CONTESTE → CONTREPASSE).
          this.ctx.payments.markReversed(o.id, reversed);
          this.ctx.audit.append({ actor, action: 'payment.reversed', resourceType: 'payment_order', resourceId: o.id, details: { operationId: op.id, from: o.status, proposedBy: op.proposedBy } });
        }
        const r = this.ctx.receipts.byPaymentOrder(o.id);
        let receiptNumber: string | undefined;
        if (r && (r.status === 'PROVISOIRE' || r.status === 'DEFINITIVE' || r.status === 'SUSPECTE')) receiptNumber = this.ctx.receipts.applyDecision(r.id, 'CONTREPASSEE', decision).number;
        const ob = this.restoreObligationStatus(o.obligationId);
        this.ctx.comms.publish('payment.reversed', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: ob.entity });
        return { paymentReference: o.paymentReference, reversalEntries: reversed, receiptNumber: receiptNumber ?? null };
      }
      case 'REMBOURSEMENT': {
        const o = this.order(input.paymentReference);
        // Plafond : exactement le montant payé ; destination : l'instrument d'origine, jamais un compte saisi.
        const entry = this.ctx.ledger.postPair({
          eventType: 'REFUND', description: `Remboursement ${o.paymentReference} vers l'instrument d'origine (${op.id})`,
          sourceType: 'payment_order', sourceId: o.id, debit: 'RECETTES_CONSTATEES', credit: 'COMPTE_PUBLIC_RECETTES', amount: o.amount,
        });
        this.ctx.payments.markRefunded(o.id, entry.id);
        // Comme pour la contrepassation : l'obligation redevient due à hauteur de ce qui a été restitué.
        this.restoreObligationStatus(o.obligationId);
        this.ctx.audit.append({ actor, action: 'payment.refunded', resourceType: 'payment_order', resourceId: o.id, details: { operationId: op.id, ledgerEntryId: entry.id, destination: 'INSTRUMENT_ORIGINE', destinationHash: o.payerInstrumentHash ?? null, refundReference: execution?.refundReference ?? null, evidenceSha256: execution?.evidenceSha256 ?? null } });
        const r = this.ctx.receipts.byPaymentOrder(o.id);
        const receipt = r && r.status === 'DEFINITIVE' ? this.ctx.receipts.applyDecision(r.id, 'REMBOURSEE', decision) : undefined;
        this.ctx.comms.publish('refund.approved', [taxpayerRecipient(this.ctx.taxpayers.get(o.taxpayerId))], { reference: o.paymentReference }, { entity: 'TRESOR' });
        return { paymentReference: o.paymentReference, ledgerEntryId: entry.id, destination: 'INSTRUMENT_ORIGINE', receiptNumber: receipt?.number ?? null };
      }
      case 'CONTRE_ECRITURE': {
        const rev = this.ctx.ledger.reverse(input.ledgerEntryId!, `${input.reason} (${op.id}, validée par ${user.id})`, actor);
        return { ledgerEntryId: input.ledgerEntryId, reversalId: rev.id };
      }
      case 'APUREMENT_SUSPENS': {
        const s = this.suspense.get(input.suspenseId!)!;
        let ledgerEntryId: string;
        let paymentReference: string | undefined;
        if (input.mode === 'AFFECTATION') {
          const o = this.order(input.paymentReference);
          const m = this.ctx.treasury.completeMatch(o.id, { debit: 'COMPTE_ATTENTE', description: `Apurement du suspens ${s.id} au profit de ${o.paymentReference} (${op.id})`, actor, details: { suspenseId: s.id, operationId: op.id } });
          ledgerEntryId = m.ledgerEntryId;
          paymentReference = o.paymentReference;
        } else {
          // Paiement non affecté encore chez le prestataire : restitué par lui au payeur (créance sur le prestataire
          // soldée). Déjà réglé sur le compte public (relevé) : restitué depuis le compte public. Une seule fois.
          const settledOnPublic = !s.unappliedId || !!this.ctx.payments.unappliedState(s.unappliedId)?.settled;
          ledgerEntryId = this.ctx.ledger.postPair({
            eventType: 'SUSPENSE_RESTITUTION', description: `Restitution du suspens ${s.id} à l'émetteur d'origine (${op.id})`,
            sourceType: 'suspense', sourceId: s.id, debit: 'COMPTE_ATTENTE', credit: settledOnPublic ? 'COMPTE_PUBLIC_RECETTES' : 'FONDS_A_RECEVOIR_PRESTATAIRES', amount: s.amount,
          }).id;
          if (s.unappliedId) this.ctx.payments.markUnappliedRestituted(s.unappliedId, { operationId: op.id, ledgerEntryId, at: decision.at });
        }
        this.suspense.update({
          ...s, status: 'APURE',
          clearing: {
            operationId: op.id, mode: input.mode!, ...(paymentReference ? { paymentReference } : {}), ledgerEntryId, at: decision.at,
            ...(input.mode === 'RESTITUTION' ? { destination: s.sourceInstrument, ...(execution ?? {}) } : {}),
          },
        });
        if (s.unappliedId && s.exceptionId) {
          // L'exception « paiement non affecté » est résolue par cette restitution validée à quatre yeux.
          const c = this.caseOf(s.exceptionId);
          this.cases.update({
            ...c, status: 'RESOLUE', decision: { approvedBy: user.id, approvedAt: decision.at, suspenseId: s.id },
            history: [...c.history, { at: decision.at, by: user.id, action: 'RESOLUTION_VALIDEE', note: `Restitution ${op.id}` }],
          });
        }
        this.ctx.audit.append({ actor, action: 'suspense.cleared', resourceType: 'suspense', resourceId: s.id, details: { mode: input.mode, paymentReference: paymentReference ?? null, operationId: op.id } });
        return { suspenseId: s.id, mode: input.mode, ledgerEntryId, paymentReference: paymentReference ?? null };
      }
      case 'PARAMETRE_NOMENCLATURE': {
        const n = input.nomenclature!;
        const entry = this.setNomenclature({ ...n, demo: !n.officialAct }, user.id);
        return { revenueCategory: n.revenueCategory, code: entry.code, version: entry.version, demo: entry.demo };
      }
      case 'DECAISSEMENT_REPARTITION':
        // Aucun fonds ne transite par MOSOLO : l'instruction est constatée, la banque de règlement exécute (§ 37A.4).
        return this.repartitionGate!.executed(op, user, decision.at);
      case 'RECUPERATION_SOUS_TRAITANT':
        // Ordre de reversement constaté : le sous-traitant reverse ; aucun fonds ne sort du compte public.
        return this.recuperationGate!.executed(op, user, decision.at);
    }
  }

  /* ---------------------------------------------------------- nomenclature */

  private setNomenclature(n: { revenueCategory: RevenueCategory; code: string; label: string; demo: boolean; officialAct?: string }, approvedBy?: string): NomenclatureEntry {
    this.nomenclatureVersion += 1;
    const entry: NomenclatureEntry = {
      revenueCategory: n.revenueCategory, code: n.code, label: n.label, demo: n.demo, ...(n.officialAct ? { officialAct: n.officialAct } : {}),
      version: this.nomenclatureVersion, updatedAt: this.now(), ...(approvedBy ? { approvedBy } : {}),
    };
    this.nomenclature.set(n.revenueCategory, entry);
    return entry;
  }

  listNomenclature(user: User) {
    authorize(user, 'tresor:nomenclature.read');
    return {
      version: this.nomenclatureVersion,
      entries: [...this.nomenclature.values()],
      notice: 'Codes marqués DÉMO : fictifs. La nomenclature officielle (OL 18/004 et textes d’application) est un acte requis ; tout changement passe par la double validation.',
    };
  }

  /* ---------------------------------------------------------- imputation */

  private settlementEntryOf(o: PaymentOrder): LedgerEntry | undefined {
    // Une écriture de règlement contrepassée ne justifie plus ni imputation ni export.
    return this.ctx.ledger.list({ sourceId: o.id }).find((e) => e.eventType === 'SETTLEMENT_CREDITED' && !e.reversalOf && !this.ctx.ledger.isReversed(e.id));
  }

  /** Impute les paiements rapprochés non encore imputés (état « Comptabilisé »). */
  runImputation(user: User) {
    authorize(user, 'tresor:imputation.run');
    const imputed: Imputation[] = [];
    const unmapped: { paymentReference: string; revenueCategory: string }[] = [];
    for (const o of this.ctx.payments.orders.find((x) => x.status === 'RAPPROCHE')) {
      if (this.imputations.get(o.id)) continue;
      const ob = this.ctx.assessment.get(o.obligationId);
      const n = this.nomenclature.get(ob.revenueCategory);
      const entry = this.settlementEntryOf(o);
      if (!n || !entry) {
        unmapped.push({ paymentReference: o.paymentReference, revenueCategory: ob.revenueCategory });
        continue;
      }
      const receipt = this.ctx.receipts.byPaymentOrder(o.id);
      imputed.push(this.imputations.insert({
        id: o.id, paymentReference: o.paymentReference, ...(receipt ? { receiptNumber: receipt.number } : {}), ledgerEntryId: entry.id,
        entryDate: kinDate(entry.at), code: n.code, label: n.label, demo: n.demo, nomenclatureVersion: n.version, amount: o.amount,
        imputedAt: this.now(), imputedBy: user.id,
      }));
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.imputation.run', resourceType: 'imputation', resourceId: `run-${this.now()}`, details: { imputed: imputed.length, unmapped: unmapped.length } });
    return { imputed, unmapped };
  }

  private lastDaily(): DailyClosure | undefined {
    return this.daily.all().at(-1);
  }

  /** État comptable des paiements rapprochés : Rapproché → Comptabilisé (imputé), jour clôturé ou non. */
  accountingStatus(user: User) {
    authorize(user, 'tresor:closure.read');
    const closedSeq = this.lastDaily()?.toSeq ?? 0;
    const rows = this.ctx.payments.orders
      .find((o) => o.status === 'RAPPROCHE' || o.status === 'REMBOURSE' || this.imputations.get(o.id) !== undefined)
      .map((o) => {
        const imp = this.imputations.get(o.id);
        const entry = this.settlementEntryOf(o);
        return {
          paymentReference: o.paymentReference, paymentStatus: o.status, amount: o.amount,
          receiptNumber: this.ctx.receipts.byPaymentOrder(o.id)?.number ?? null,
          state: imp ? 'COMPTABILISE' : 'RAPPROCHE',
          code: imp?.code ?? null, demoCode: imp?.demo ?? null,
          ledgerEntryId: entry?.id ?? null, dayClosed: !!entry && entry.seq <= closedSeq,
        };
      });
    return {
      rows,
      counts: { rapproche: rows.filter((r) => r.state === 'RAPPROCHE').length, comptabilise: rows.filter((r) => r.state === 'COMPTABILISE').length },
    };
  }

  /* -------------------------------------------------------------- clôtures */

  private openCounts(user: User) {
    return {
      openExceptions: this.ctx.treasury.listExceptions(user).filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE').length,
      openSuspense: this.suspense.find((s) => s.status === 'OUVERT').length,
      unimputed: this.ctx.payments.orders.find((o) => o.status === 'RAPPROCHE' && !this.imputations.get(o.id)).length,
    };
  }

  /**
   * Clôture quotidienne signée : couvre toutes les écritures non encore clôturées datées (Kinshasa) du jour ou avant ;
   * empreinte = SHA-256(empreinte précédente + contenu canonique), signée Ed25519. Aucune écriture n'est modifiée.
   */
  closeDay(user: User, date: string): DailyClosure {
    authorize(user, 'tresor:closure.write');
    const today = kinDate(this.ctx.clock.now());
    if (date > today) throw unprocessable('CLOSURE_IN_FUTURE', `Impossible de clôturer une journée future (${date}).`);
    const last = this.lastDaily();
    if (last && date <= last.date) throw conflict('DAY_ALREADY_CLOSED', `Journée ${date} déjà couverte par la clôture ${last.id}.`);
    const fromSeq = (last?.toSeq ?? 0) + 1;
    const entries = this.ctx.ledger.list().filter((e) => e.seq >= fromSeq && kinDate(e.at) <= date);
    // Une journée antérieure encore ouverte se clôture d'abord : jamais deux journées dans une même clôture (les totaux
    // mensuels resteraient mélangés). Les écritures tardives d'une journée déjà clôturée suivent la clôture suivante.
    const earlier = entries.find((e) => kinDate(e.at) < date && (!last || kinDate(e.at) > last.date));
    if (earlier) {
      const day = kinDate(earlier.at);
      throw conflict('EARLIER_DAY_NOT_CLOSED', `La journée du ${day} comporte des écritures non clôturées : clôturez-la avant celle du ${date}.`, { date: day });
    }
    // Exceptions d'argent ouvertes ou créances prestataire en retard : clôture seulement sur dérogation motivée,
    // demandée par un comptable et validée par un second (R17 distincts), consignée dans la clôture signée.
    const blockers = this.closureBlockers(user);
    let waiver: ClosureWaiver | undefined;
    if (blockers.openMoneyExceptions > 0 || blockers.overdueProviderReceivables > 0) {
      waiver = this.waivers.findOne((w) => w.date === date && w.status === 'APPROUVEE');
      if (!waiver) {
        throw conflict('CLOSURE_APPROVAL_REQUIRED', `Journée ${date} : ${blockers.openMoneyExceptions} exception(s) portant de l'argent ouverte(s), ${blockers.overdueProviderReceivables} créance(s) prestataire au-delà de ${PROVIDER_SETTLEMENT_DELAY_DAYS} j. Dérogation motivée validée par un second comptable requise.`, { blockers });
      }
      if (blockers.openMoneyExceptions > waiver.blockers.openMoneyExceptions || blockers.overdueProviderReceivables > waiver.blockers.overdueProviderReceivables) {
        throw conflict('CLOSURE_WAIVER_OUTDATED', `La dérogation ${waiver.id} ne couvre pas la situation actuelle (${blockers.openMoneyExceptions} exception(s), ${blockers.overdueProviderReceivables} créance(s)) : nouvelle dérogation requise.`, { blockers, waiver: waiver.blockers });
      }
    }
    const toSeq = entries.at(-1)?.seq ?? fromSeq - 1;
    const totals = new Map<CurrencyCode, { debit: Money; credit: Money }>();
    for (const e of entries) for (const l of e.lines) {
      const m = Money.fromJSON(l.amount);
      const t = totals.get(m.currency) ?? { debit: Money.zero(m.currency), credit: Money.zero(m.currency) };
      if (l.side === 'DEBIT') t.debit = t.debit.add(m); else t.credit = t.credit.add(m);
      totals.set(m.currency, t);
    }
    const totalsJson = [...totals.entries()].map(([currency, t]) => ({ currency, debit: t.debit.toJSON(), credit: t.credit.toJSON(), balanced: t.debit.equals(t.credit) }));
    const content = {
      id: `CLJ-${date}`, date, fromSeq, toSeq, entries: entries.length, totals: totalsJson, balanced: totalsJson.every((t) => t.balanced),
      entriesHash: sha256Hex(entries.map((e) => e.hash).join('')), ledgerHeadHash: this.ctx.ledger.balance().headHash,
      ...this.openCounts(user),
      ...(waiver ? { waiver: { id: waiver.id, motif: waiver.motif, requestedBy: waiver.requestedBy, approvedBy: waiver.approvedBy!, blockers } } : {}),
      prevHash: last?.hash ?? GENESIS, closedBy: user.id, closedAt: this.now(),
    };
    const hash = sha256Hex(content.prevHash + canonicalJson(content));
    const closure = this.daily.append({ ...content, hash, signature: this.signHex(hash) });
    if (waiver) this.waivers.update({ ...waiver, status: 'UTILISEE', closureId: closure.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'ledger.day_closed', resourceType: 'closure', resourceId: closure.id, details: { hash, entries: closure.entries, fromSeq, toSeq } });
    this.ctx.comms.publish('ledger.day_closed', this.ctx.users.withRole('R17').map(userRecipient), { reference: closure.id }, { entity: 'TRESOR' });
    return closure;
  }

  /** Ce qui empêche une clôture quotidienne sans dérogation. */
  closureBlockers(user: User): ClosureBlockers {
    return {
      openMoneyExceptions: this.ctx.treasury.listExceptions(user).filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE' && this.carriesMoney(e)).length,
      overdueProviderReceivables: this.receivableItems().filter((r) => r.overdue).length,
    };
  }

  /** Demande de dérogation de clôture (R17, motif) : la situation bloquante est figée dans la demande. */
  requestClosureWaiver(user: User, date: string, motif: string): ClosureWaiver {
    authorize(user, 'tresor:closure.write');
    if (this.waivers.findOne((w) => w.date === date && w.status !== 'UTILISEE')) throw conflict('CLOSURE_WAIVER_PENDING', `Une dérogation est déjà en cours pour le ${date}.`);
    const blockers = this.closureBlockers(user);
    if (blockers.openMoneyExceptions === 0 && blockers.overdueProviderReceivables === 0) throw unprocessable('CLOSURE_WAIVER_NOT_NEEDED', `Rien ne bloque la clôture du ${date} : aucune dérogation nécessaire.`);
    const w = this.waivers.insert({ id: this.ids.next('DERCL'), date, motif, blockers, status: 'DEMANDEE', requestedBy: user.id, requestedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'ledger.day_close_waiver.requested', resourceType: 'closure_waiver', resourceId: w.id, details: { date, motif, ...blockers } });
    return w;
  }

  /** Validation de la dérogation par un SECOND comptable public (distinct du demandeur). */
  approveClosureWaiver(user: User, id: string): ClosureWaiver {
    authorize(user, 'tresor:closure.write');
    const w = this.waivers.get(id);
    if (!w) throw notFound('CLOSURE_WAIVER_NOT_FOUND', `Dérogation inconnue : ${id}`);
    if (w.status !== 'DEMANDEE') throw conflict('CLOSURE_WAIVER_ALREADY_DECIDED', `La dérogation ${id} est ${w.status}.`);
    assertDistinctPerson(user.id, [w.requestedBy], 'Quatre yeux : la dérogation de clôture est validée par un second comptable.');
    const updated = this.waivers.update({ ...w, status: 'APPROUVEE', approvedBy: user.id, approvedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'ledger.day_close_waiver.approved', resourceType: 'closure_waiver', resourceId: id, details: { date: w.date, requestedBy: w.requestedBy, motif: w.motif, ...w.blockers } });
    return updated;
  }

  /* ------------------------------------------------ créances sur prestataires */

  /**
   * Créances sur prestataires (FONDS_A_RECEVOIR_PRESTATAIRES) : paiements confirmés non encore crédités au compte
   * public, paiements non affectés ni réglés ni restitués. Ancienneté depuis la confirmation / la réception.
   */
  private receivableItems() {
    const now = this.ctx.clock.now().getTime();
    const D = PROVIDER_SETTLEMENT_DELAY_DAYS;
    const rows = [
      ...this.ctx.payments.orders.find((o) => o.status === 'CONFIRME' || o.status === 'REGLE').map((o) => ({
        kind: 'PAIEMENT_CONFIRME' as const, id: o.id, provider: o.provider ?? 'inconnu', paymentReference: o.paymentReference, amount: o.amount, since: o.confirmedAt ?? o.createdAt,
      })),
      ...this.ctx.payments.openUnappliedReceivables().map((u) => ({
        kind: 'PAIEMENT_NON_AFFECTE' as const, id: u.id, provider: u.provider, paymentReference: u.paymentReference, amount: u.amount, since: u.receivedAt,
      })),
    ];
    return rows.map((r) => {
      const age = now - new Date(r.since).getTime();
      const ageDays = Math.max(0, Math.floor(age / DAY_MS));
      const bucket = ageDays <= 1 ? '0-1 j' : ageDays <= D ? `2-${D} j` : `> ${D} j`;
      return { ...r, ageDays, bucket, overdue: age > D * DAY_MS };
    });
  }

  /** Alerte (une seule fois par créance) au-delà du délai de règlement prestataire. */
  private alertOverdueReceivables(): void {
    for (const r of this.receivableItems().filter((x) => x.overdue)) {
      const key = `recv:${r.kind}:${r.id}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      this.ctx.alerts.raise({
        type: 'PROVIDER_SETTLEMENT_OVERDUE', severity: 'HIGH', source: 'tresor',
        detail: `Créance sur ${r.provider} de ${r.amount.amount} ${r.amount.currency} (${r.paymentReference}) non réglée au compte public depuis ${r.ageDays} j (délai ${PROVIDER_SETTLEMENT_DELAY_DAYS} j).`,
        context: { kind: r.kind, id: r.id, provider: r.provider, paymentReference: r.paymentReference, amount: r.amount, since: r.since },
      });
    }
  }

  /** Balance âgée des créances sur prestataires, par prestataire et tranche d'ancienneté. */
  providerReceivables(user: User) {
    authorize(user, 'tresor:receivables.read');
    this.alertOverdueReceivables();
    const items = this.receivableItems().sort((a, b) => b.ageDays - a.ageDays);
    const D = PROVIDER_SETTLEMENT_DELAY_DAYS;
    const bucketNames = ['0-1 j', `2-${D} j`, `> ${D} j`];
    const providers = [...new Set(items.map((i) => i.provider))].sort().map((provider) => {
      const mine = items.filter((i) => i.provider === provider);
      return {
        provider, count: mine.length, totals: sumByCurrency(mine.map((i) => i.amount)), overdue: mine.filter((i) => i.overdue).length,
        buckets: bucketNames.map((b) => ({ bucket: b, count: mine.filter((i) => i.bucket === b).length, amounts: sumByCurrency(mine.filter((i) => i.bucket === b).map((i) => i.amount)) })),
      };
    });
    return {
      delayDays: D, items, providers, totals: sumByCurrency(items.map((i) => i.amount)), overdue: items.filter((i) => i.overdue).length,
      ledger: this.ctx.ledger.balance().accounts.filter((a) => a.account === 'FONDS_A_RECEVOIR_PRESTATAIRES'),
    };
  }

  /* --------------------------------------------- cohérence grand livre / états métier */

  /**
   * Contrôle de cohérence : soldes du grand livre par nature de source rapprochés des états métier. Un écart signale
   * une écriture passée ou contrepassée hors de l'opération de son objet (recette masquée, créance fictive…).
   */
  ledgerConsistency() {
    const accounts = this.ctx.ledger.balance().accounts;
    const bal = (account: string, currency: CurrencyCode) => {
      const a = accounts.find((x) => x.account === account && x.currency === currency);
      return a ? Money.fromJSON(a.balance) : Money.zero(currency);
    };
    const gaps: { check: string; ref?: string; currency?: CurrencyCode; expected?: MoneyJSON; actual?: MoneyJSON; detail: string }[] = [];
    const compare = (check: string, account: string, expected: MoneyJSON[], detail: string) => {
      const exp = new Map(expected.map((m) => [m.currency, Money.fromJSON(m)] as const));
      const currencies = new Set<CurrencyCode>([...exp.keys(), ...accounts.filter((a) => a.account === account).map((a) => a.currency)]);
      for (const c of currencies) {
        const e = exp.get(c) ?? Money.zero(c);
        const a = bal(account, c);
        if (!e.equals(a)) gaps.push({ check, currency: c, expected: e.toJSON(), actual: a.toJSON(), detail });
      }
    };
    // Compte d'attente (solde créditeur) = total des suspens ouverts.
    compare('COMPTE_ATTENTE_VS_SUSPENS', 'COMPTE_ATTENTE', sumByCurrency(this.suspense.find((x) => x.status === 'OUVERT').map((x) => Money.fromJSON(x.amount).negate().toJSON())), 'Solde du compte d’attente ≠ suspens ouverts.');
    // Créances sur prestataires = paiements confirmés non réglés + paiements non affectés ni réglés ni restitués.
    compare('CREANCES_PRESTATAIRES_VS_PAIEMENTS', 'FONDS_A_RECEVOIR_PRESTATAIRES', sumByCurrency(this.receivableItems().map((r) => r.amount)), 'Créances sur prestataires ≠ paiements confirmés non réglés et non affectés en attente.');
    // Par paiement : écritures actives attendues selon l'état.
    const active = (o: PaymentOrder, type: string) => this.ctx.ledger.list({ sourceId: o.id }).some((e) => e.eventType === type && !e.reversalOf && !this.ctx.ledger.isReversed(e.id));
    for (const o of this.ctx.payments.orders.all()) {
      const confirmedLike = ['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE'].includes(o.status) || (o.status === 'REMBOURSE' && !!o.confirmedAt);
      if (confirmedLike && !active(o, 'PAYMENT_CONFIRMED')) gaps.push({ check: 'PAIEMENT_SANS_ECRITURE_CONFIRMATION', ref: o.paymentReference, detail: `Paiement ${o.paymentReference} ${o.status} sans écriture de confirmation active.` });
      const settledLike = o.status === 'RAPPROCHE' || (o.status === 'REMBOURSE' && !!o.reconciledAt);
      if (settledLike && !active(o, 'SETTLEMENT_CREDITED')) gaps.push({ check: 'RAPPROCHE_SANS_ECRITURE_REGLEMENT', ref: o.paymentReference, detail: `Paiement ${o.paymentReference} ${o.status} sans écriture de règlement active.` });
      if (o.status === 'CONTREPASSE' && (active(o, 'PAYMENT_CONFIRMED') || active(o, 'SETTLEMENT_CREDITED'))) gaps.push({ check: 'CONTREPASSE_AVEC_ECRITURE_ACTIVE', ref: o.paymentReference, detail: `Paiement ${o.paymentReference} contrepassé mais écriture encore active.` });
    }
    for (const g of gaps) {
      const key = `gap:${g.check}:${g.ref ?? ''}:${g.currency ?? ''}:${g.actual?.amount ?? ''}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      this.ctx.alerts.raise({ type: 'LEDGER_DOMAIN_GAP', severity: 'CRITICAL', source: 'tresor', detail: g.detail, context: { ...g } });
    }
    return { consistent: gaps.length === 0, gaps, checkedAt: this.now() };
  }

  consistency(user: User) {
    authorize(user, 'tresor:overview');
    return this.ledgerConsistency();
  }

  /** Clôture mensuelle : toutes les écritures du mois clôturées au jour le jour et aucune écriture rapprochée non imputée. */
  closeMonth(user: User, month: string): MonthlyClosure {
    authorize(user, 'tresor:closure.write');
    if (month > kinDate(this.ctx.clock.now()).slice(0, 7)) throw unprocessable('CLOSURE_IN_FUTURE', `Mois futur : ${month}.`);
    if (this.monthly.get(`CLM-${month}`)) throw conflict('MONTH_ALREADY_CLOSED', `Mois ${month} déjà clôturé.`);
    const lastMonth = this.monthly.all().at(-1);
    if (lastMonth && month <= lastMonth.month) throw conflict('MONTH_ALREADY_CLOSED', `Une clôture mensuelle postérieure existe (${lastMonth.id}).`);
    const closedSeq = this.lastDaily()?.toSeq ?? 0;
    const inMonth = this.ctx.ledger.list().filter((e) => kinDate(e.at).startsWith(month));
    const uncovered = inMonth.filter((e) => e.seq > closedSeq);
    if (uncovered.length) throw conflict('DAYS_NOT_CLOSED', `${uncovered.length} écriture(s) du mois ${month} ne sont couvertes par aucune clôture quotidienne.`, { count: uncovered.length });
    const unimputed = this.ctx.payments.orders.find((o) => o.status === 'RAPPROCHE' && !this.imputations.get(o.id) && kinDate(this.settlementEntryOf(o)?.at ?? o.reconciledAt ?? this.now()).startsWith(month));
    if (unimputed.length) throw conflict('UNIMPUTED_ENTRIES', `${unimputed.length} paiement(s) rapproché(s) du mois ne sont pas imputés selon la nomenclature.`, { count: unimputed.length });
    const days = this.daily.find((d) => d.date.startsWith(month));
    // Totaux du mois = écritures DATÉES du mois (toutes couvertes par une clôture quotidienne, contrôlé ci-dessus),
    // jamais la somme de clôtures qui pourraient porter des écritures tardives d'un autre mois.
    const totals = new Map<CurrencyCode, { debit: Money; credit: Money }>();
    for (const e of inMonth) for (const l of e.lines) {
      const m = Money.fromJSON(l.amount);
      const cur = totals.get(m.currency) ?? { debit: Money.zero(m.currency), credit: Money.zero(m.currency) };
      totals.set(m.currency, l.side === 'DEBIT' ? { ...cur, debit: cur.debit.add(m) } : { ...cur, credit: cur.credit.add(m) });
    }
    const content = {
      id: `CLM-${month}`, month, dailyClosures: days.map((d) => d.id), dailyHashes: days.map((d) => d.hash),
      totals: [...totals.entries()].map(([currency, t]) => ({ currency, debit: t.debit.toJSON(), credit: t.credit.toJSON() })),
      imputed: this.imputations.find((i) => i.entryDate.startsWith(month)).length,
      prevHash: lastMonth?.hash ?? GENESIS, closedBy: user.id, closedAt: this.now(),
    };
    const hash = sha256Hex(content.prevHash + canonicalJson(content));
    const closure = this.monthly.append({ ...content, hash, signature: this.signHex(hash) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'ledger.month_closed', resourceType: 'closure', resourceId: closure.id, details: { hash, days: days.length } });
    return closure;
  }

  /** Recalcule la chaîne des clôtures et vérifie chaque signature. */
  verifyClosures(): { valid: boolean; brokenAt?: string } {
    const check = <T extends { id: string; prevHash: string; hash: string; signature: string }>(list: T[]) => {
      let prev = GENESIS;
      for (const c of list) {
        const { hash, signature, ...content } = c;
        if (content.prevHash !== prev || sha256Hex(prev + canonicalJson(content)) !== hash) return c.id;
        if (!verify(null, Buffer.from(hash), this.publicKey, Buffer.from(signature, 'base64url'))) return c.id;
        prev = hash;
      }
      return undefined;
    };
    const broken = check(this.daily.all()) ?? check(this.monthly.all());
    return broken ? { valid: false, brokenAt: broken } : { valid: true };
  }

  listClosures(user: User) {
    authorize(user, 'tresor:closure.read');
    const today = kinDate(this.ctx.clock.now());
    const last = this.lastDaily();
    const pending = this.ctx.ledger.list().filter((e) => e.seq > (last?.toSeq ?? 0));
    return {
      daily: [...this.daily.all()].reverse(), monthly: [...this.monthly.all()].reverse(), chain: this.verifyClosures(),
      today, lastClosedDate: last?.date ?? null, unclosedEntries: pending.length,
      oldestUnclosedDate: pending[0] ? kinDate(pending[0].at) : null,
      algorithm: 'Ed25519', publicKeyPem: this.publicKeyPem(),
    };
  }

  /* ---------------------------------------------------------------- export */

  /** Export signé vers la comptabilité publique : écritures imputées, sans aucune donnée nominative. */
  exportAccounting(user: User, q: { format: 'csv' | 'json'; from?: string; to?: string }) {
    authorize(user, 'tresor:export');
    const closedSeq = this.lastDaily()?.toSeq ?? 0;
    const rows = this.imputations.all()
      .filter((i) => (!q.from || i.entryDate >= q.from) && (!q.to || i.entryDate <= q.to))
      .sort((a, b) => a.ledgerEntryId.localeCompare(b.ledgerEntryId))
      .map((i) => {
        const e = this.ctx.ledger.get(i.ledgerEntryId)!;
        const debit = e.lines.find((l) => l.side === 'DEBIT')!;
        const credit = e.lines.find((l) => l.side === 'CREDIT')!;
        return {
          date: i.entryDate, piece: e.id, paymentReference: i.paymentReference, receiptNumber: i.receiptNumber ?? '',
          imputationCode: i.code, demoCode: i.demo, nomenclatureVersion: i.nomenclatureVersion,
          debitAccount: debit.account, creditAccount: credit.account, amount: i.amount.amount, currency: i.amount.currency,
          dayClosed: e.seq <= closedSeq, ledgerHash: e.hash,
        };
      });
    const generatedAt = this.now();
    let body: string;
    if (q.format === 'csv') {
      const head = ['date', 'piece', 'reference_paiement', 'quittance', 'code_imputation', 'code_demo', 'version_nomenclature', 'compte_debit', 'compte_credit', 'montant', 'devise', 'jour_cloture', 'empreinte_ecriture'];
      const esc = (v: unknown) => { const s = String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      body = [head.join(';'), ...rows.map((r) => [r.date, r.piece, r.paymentReference, r.receiptNumber, r.imputationCode, r.demoCode ? 'OUI' : 'NON', r.nomenclatureVersion, r.debitAccount, r.creditAccount, r.amount, r.currency, r.dayClosed ? 'OUI' : 'NON', r.ledgerHash].map(esc).join(';'))].join('\n') + '\n';
    } else {
      body = canonicalJson(rows);
    }
    const sha256 = sha256Hex(body);
    const signature = this.signHex(sha256);
    this.ctx.audit.append({ actor: actorOf(user), action: 'treasury.export', resourceType: 'export', resourceId: sha256.slice(0, 16), details: { format: q.format, rows: rows.length, from: q.from ?? null, to: q.to ?? null, sha256 } });
    return {
      format: q.format, generatedAt, from: q.from ?? null, to: q.to ?? null, count: rows.length, rows, body, sha256, signature, algorithm: 'Ed25519' as const,
      demo: rows.some((r) => r.demoCode),
      notice: 'Codes d’imputation de démonstration (fictifs) signalés « code_demo = OUI » : non opposables à la comptabilité publique.',
    };
  }

  /* ----------------------------------------------------------- quittances */

  receiptView(user: User, ref: string) {
    const r = this.ctx.receipts.require(ref);
    authorize(user, 'tresor:receipt.read', { taxpayerId: r.taxpayerId });
    const chain: { number: string; status: string }[] = [];
    let cur: Receipt | undefined = r.replaces ? this.ctx.receipts.find(r.replaces) : undefined;
    while (cur) { chain.unshift({ number: cur.number, status: cur.status }); cur = cur.replaces ? this.ctx.receipts.find(cur.replaces) : undefined; }
    const order = this.ctx.payments.orders.get(r.paymentOrderId);
    return {
      number: r.number, code: r.code, status: r.status, mention: r.mention, amount: r.amount, paymentReference: r.paymentReference,
      paymentStatus: order?.status ?? null, revenueCategory: r.revenueCategory, administration: r.administration, issuedAt: r.issuedAt,
      finalizedAt: r.finalizedAt ?? null, replaces: r.replaces ?? null, replacedBy: r.replacedBy ?? null, previous: chain,
      decision: r.decision ?? null, duplicates: r.duplicates ?? 0, lastDuplicateAt: r.lastDuplicateAt ?? null,
      pendingOperations: this.operations.find((o) => o.status === 'PROPOSEE' && (o.target.key === `receipt:${r.id}` || o.target.key === `payment:${r.paymentOrderId}`)).map((o) => o.id),
    };
  }

  duplicate(user: User, ref: string) {
    const r = this.ctx.receipts.require(ref);
    authorize(user, 'tresor:receipt.duplicate', { taxpayerId: r.taxpayerId });
    return this.ctx.receipts.duplicate(r.id, user.id);
  }

  verificationJournal(user: User) {
    authorize(user, 'tresor:verification.journal');
    return this.ctx.receipts.verificationJournal();
  }

  /* -------------------------------------------------------------- synthèse */

  overview(user: User) {
    authorize(user, 'tresor:overview');
    const ex = this.ctx.treasury.listExceptions(user);
    const open = ex.filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE');
    const susp = this.suspense.find((s) => s.status === 'OUVERT').map((s) => this.suspenseView(s));
    const last = this.lastDaily();
    return {
      exceptions: { open: open.length, overdue: open.filter((e) => e.overdue === true).length, unassigned: open.filter((e) => !e.assignee).length },
      suspense: { open: susp.length, totals: sumByCurrency(susp.map((s) => s.amount)), oldestDays: susp.reduce((m, s) => Math.max(m, s.ageDays ?? 0), 0) },
      operations: { pending: this.operations.find((o) => o.status === 'PROPOSEE').length },
      closures: { lastClosedDate: last?.date ?? null, lastHash: last?.hash ?? null, chainValid: this.verifyClosures().valid },
      accounting: { imputed: this.imputations.count(), unimputed: this.ctx.payments.orders.find((o) => o.status === 'RAPPROCHE' && !this.imputations.get(o.id)).length },
      providerReceivables: (() => {
        this.alertOverdueReceivables();
        const r = this.receivableItems();
        return { count: r.length, overdue: r.filter((x) => x.overdue).length, totals: sumByCurrency(r.map((x) => x.amount)), delayDays: PROVIDER_SETTLEMENT_DELAY_DAYS };
      })(),
      closureBlockers: this.closureBlockers(user),
      consistency: this.ledgerConsistency(),
    };
  }

  /* ----------------------------------------------------------------- démo */

  seedDemo(): void {
    this.ctx.users.add({ id: 'tresor-chef-comptable', name: 'Chef comptable — Trésor, second valideur (démo)', roles: ['R17'], entity: 'TRESOR' });
    this.ctx.users.add({ id: 'tresor-analyste-2', name: 'Analyste de rapprochement n° 2 (démo)', roles: ['R18'], entity: 'TRESOR' });
    const demo: [RevenueCategory, string, string][] = [
      ['IMPOT_PROVINCIAL', 'DEMO-IMP-701', '[DÉMO] Impôts provinciaux — code fictif'],
      ['INTERET_COMMUN', 'DEMO-IC-702', '[DÉMO] Impôts d’intérêt commun — code fictif'],
      ['DROIT_ADMINISTRATIF', 'DEMO-DA-703', '[DÉMO] Droits et actes administratifs — code fictif'],
      ['REDEVANCE_SERVICE', 'DEMO-RS-704', '[DÉMO] Redevances de service — code fictif'],
      ['CONCESSION_DOMANIALE', 'DEMO-CD-705', '[DÉMO] Concessions et domaine public — code fictif'],
      ['RECETTE_ETD', 'DEMO-ETD-706', '[DÉMO] Recettes des ETD — code fictif'],
    ];
    for (const [revenueCategory, code, label] of demo) this.setNomenclature({ revenueCategory, code, label, demo: true });
    // Un suspens de démonstration (crédit non identifié, 4 jours) pour illustrer l'ancienneté et l'apurement.
    const valueDate = kinDate(new Date(this.ctx.clock.now().getTime() - 4 * DAY_MS));
    this.openSuspense({
      accountAlias: 'KIN-DGIPK-RECETTES-01', amount: { amount: '75.00', currency: 'USD' }, valueDate, statementId: 'REL-DEMO-SUSPENS',
      justification: '[DÉMONSTRATION] Crédit sans référence de paiement sur relevé fictif ; recherche prestataire en cours.',
      openedBy: 'u-analyste-rappro', approvedBy: 'u-tresor', demo: true,
    });
  }
}
