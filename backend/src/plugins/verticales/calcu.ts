/**
 * CALCU — contrôle de la dépense publique (module 80, Cahier § 27A, Annexe H § H.15.2), en mode pilote de démonstration.
 * Registre des comptes publics (validation conjointe Finances + organe de contrôle), justificatifs par empreinte,
 * passerelle bancaire qui standardise sans analyser, moteur de correspondance (vert / ambre / rouge), rapports d'anomalie
 * numérotés. CALCU NE BLOQUE AUCUN PAIEMENT (AC-CAL-01) et respecte le secret bancaire. Le gel administratif d'un
 * dossier n'est jamais automatique : décision humaine motivée de l'organe de contrôle, dans ses pouvoirs légaux (ARB-12).
 * Cadre juridique à adopter (J26) : fonctionnement limité à une entité pilote volontaire.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { conflict, forbidden, notFound } from '../../core/errors.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { P } from './policies.js';
import { kinshasaDay } from '../../core/clock.js';
import type { BudgetLine, CalcuControlService, ControlMission, JusticeReferral, Recommendation, Recovery, Supplier } from './calcu-controle.js';

export const ACCOUNT_TYPES = ['FONCTIONNEMENT', 'INVESTISSEMENT', 'PROJET', 'SPECIAL'] as const;
export const DOCUMENT_TYPES = ['DEVIS', 'BON_COMMANDE', 'ENGAGEMENT', 'CONTRAT', 'FOURNISSEUR'] as const;
export type Score = 'VERT' | 'AMBRE' | 'ROUGE';

export interface PublicAccount {
  id: string;
  entityName: string;
  bank: string;
  accountNumberMasked: string;
  accountNumberHash: string;
  currency: string;
  type: (typeof ACCOUNT_TYPES)[number];
  signatories: string[];
  declaredBy: string;
  declaredAt: string;
  status: 'DECLARE' | 'VALIDE';
  validations: { finances?: { by: string; at: string }; controle?: { by: string; at: string } };
}

export interface SupportingDocument {
  id: string;
  accountId: string;
  operationRef: string;
  type: (typeof DOCUMENT_TYPES)[number];
  supplier: string;
  amount: MoneyJSON;
  date: string;
  sha256: string;
  registeredBy: string;
  registeredAt: string;
  /** Justificatif géolocalisé (§ 27A.4 : pièces horodatées, géolocalisées et liées à la transaction). */
  geo?: { lat: number; lon: number; accuracyM: number; capturedAt: string };
  /** Commune du lieu de la dépense (zones exposées de l'organe de contrôle). */
  commune?: string;
  /** Ligne budgétaire de l'engagement (contrôle de conformité budgétaire). */
  budgetLineId?: string;
  /** Fournisseur du registre des fournisseurs enregistrés. */
  supplierId?: string;
}

/** Contrôle complémentaire du moteur de correspondance (registre des fournisseurs, conformité budgétaire…). */
export type CalcuCheck = (tx: { accountId: string | null; amount: MoneyJSON; beneficiary: string; reference: string; accountNumberHash: string }, docs: SupportingDocument[], acc: PublicAccount | undefined) => { score: Score; finding: string }[];

export interface BankTransaction {
  id: string;
  bank: string;
  accountNumberHash: string;
  accountId: string | null;
  amount: MoneyJSON;
  at: string;
  beneficiary: string;
  reference: string;
  receivedAt: string;
  submittedBy: string;
  score: Score;
  findings: string[];
  reportId: string | null;
  /** Toujours faux : CALCU ne bloque aucun paiement. */
  blocked: false;
}

export interface AnomalyReport {
  id: string;
  transactionId: string;
  score: Score;
  findings: string[];
  createdAt: string;
  sha256: string;
  status: 'OUVERT' | 'GELE' | 'CLOS';
  freeze?: { by: string; at: string; reason: string; legalBasis: string };
  closure?: { by: string; at: string; reason: string };
}

const normalizeAccount = (n: string) => n.replace(/[\s-]/g, '').toUpperCase();
const mask = (n: string) => `•••• ${normalizeAccount(n).slice(-4)}`;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export class CalcuService {
  readonly accounts = new InMemoryRepository<PublicAccount>();
  readonly documents = new InMemoryAppendOnlyRepository<SupportingDocument>();
  readonly transactions = new InMemoryAppendOnlyRepository<BankTransaction>();
  readonly reports = new InMemoryRepository<AnomalyReport>();
  private readonly ids = new IdGenerator();
  /** Contrôles complémentaires branchés par l'organe de contrôle (§ 27A.4). */
  private readonly checks: CalcuCheck[] = [];
  /** Registres de l'organe de contrôle (§ 27A.4, § 27A.5), exploités par `controle`. */
  readonly suppliers = new InMemoryRepository<Supplier>();
  readonly budgetLines = new InMemoryRepository<BudgetLine>();
  readonly missions = new InMemoryRepository<ControlMission>();
  readonly referrals = new InMemoryRepository<JusticeReferral>();
  readonly recoveries = new InMemoryRepository<Recovery>();
  readonly recommendations = new InMemoryRepository<Recommendation>();
  /** Compléments du § 27A.4 et du § 27A.5 (registres, missions, justice, tableaux) — branchés par le module. */
  controle?: CalcuControlService;

  addCheck(fn: CalcuCheck): void {
    this.checks.push(fn);
  }

  constructor(private readonly ctx: AppContext) {}

  declareAccount(user: User, input: { entityName: string; bank: string; accountNumber: string; currency: string; type: PublicAccount['type']; signatories: string[] }) {
    authorize(user, P.calcuDeclare, {});
    const hash = sha256Hex(normalizeAccount(input.accountNumber));
    if (this.accounts.findOne((a) => a.accountNumberHash === hash)) throw conflict('ACCOUNT_ALREADY_DECLARED', 'Ce compte est déjà déclaré au registre.');
    const acc = this.accounts.insert({
      id: this.ids.next('CALCU-CPT'), entityName: input.entityName, bank: input.bank, accountNumberMasked: mask(input.accountNumber), accountNumberHash: hash,
      currency: input.currency, type: input.type, signatories: input.signatories, declaredBy: user.id, declaredAt: this.ctx.clock.now().toISOString(), status: 'DECLARE', validations: {},
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.account.declared', resourceType: 'calcu_account', resourceId: acc.id, details: { entityName: acc.entityName, type: acc.type, bank: acc.bank } });
    return acc;
  }

  /** Validation conjointe : les Finances ET l'organe de contrôle, par deux personnes distinctes du déclarant. */
  validateAccount(user: User, id: string, as: 'FINANCES' | 'CONTROLE') {
    const acc = this.accounts.get(id);
    if (!acc) throw notFound('CALCU_ACCOUNT_NOT_FOUND', `Compte inconnu : ${id}`);
    authorize(user, as === 'FINANCES' ? P.calcuValidateFinances : P.calcuValidateControl, {});
    const key = as === 'FINANCES' ? 'finances' : 'controle';
    if (acc.validations[key]) throw conflict('ALREADY_VALIDATED', 'Validation déjà enregistrée pour ce volet.');
    const others = [acc.declaredBy, acc.validations.finances?.by, acc.validations.controle?.by].filter((x): x is string => !!x);
    assertDistinctPerson(user.id, others, 'Déclaration et validations conjointes : trois personnes distinctes.');
    const validations = { ...acc.validations, [key]: { by: user.id, at: this.ctx.clock.now().toISOString() } };
    const saved = this.accounts.update({ ...acc, validations, status: validations.finances && validations.controle ? 'VALIDE' : 'DECLARE' });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.account.validated', resourceType: 'calcu_account', resourceId: id, details: { as, status: saved.status } });
    return saved;
  }

  registerDocument(user: User, input: Omit<SupportingDocument, 'id' | 'registeredBy' | 'registeredAt'>) {
    authorize(user, P.calcuDeclare, {});
    if (!this.accounts.get(input.accountId)) throw notFound('CALCU_ACCOUNT_NOT_FOUND', `Compte inconnu : ${input.accountId}`);
    const doc = this.documents.append({ ...input, amount: Money.fromJSON(input.amount).toJSON(), id: this.ids.next('CALCU-DOC'), registeredBy: user.id, registeredAt: this.ctx.clock.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.document.registered', resourceType: 'calcu_document', resourceId: doc.id, details: { operationRef: doc.operationRef, type: doc.type, sha256: doc.sha256 } });
    return doc;
  }

  /** Moteur de correspondance : attribue un score et des constats ; ne bloque rien. */
  private match(tx: Omit<BankTransaction, 'score' | 'findings' | 'reportId' | 'id' | 'blocked'>): { score: Score; findings: string[] } {
    const findings: string[] = [];
    let score: Score = 'VERT';
    const worst = (s: Score) => { if (s === 'ROUGE' || (s === 'AMBRE' && score === 'VERT')) score = s; };
    const acc = tx.accountId ? this.accounts.get(tx.accountId) : undefined;
    if (!acc) { findings.push('Compte émetteur non enregistré au registre — réputé irrégulier (signalement administratif).'); worst('ROUGE'); }
    else if (acc.status !== 'VALIDE') { findings.push('Compte déclaré mais pas encore validé conjointement.'); worst('AMBRE'); }
    const docs = this.documents.find((d) => d.operationRef === tx.reference && (!acc || d.accountId === acc.id));
    if (!docs.length) { findings.push('Aucun justificatif lié à l’opération (devis, bon de commande, engagement, contrat, fournisseur).'); worst('ROUGE'); }
    else {
      const has = (t: SupportingDocument['type']) => docs.some((d) => d.type === t);
      const missing = [!has('ENGAGEMENT') && 'engagement budgétaire', !(has('BON_COMMANDE') || has('CONTRAT')) && 'bon de commande ou contrat', !(has('DEVIS') || has('CONTRAT')) && 'devis', !has('FOURNISSEUR') && 'fournisseur enregistré'].filter(Boolean);
      if (missing.length) { findings.push(`Justificatifs incomplets : ${missing.join(', ')}.`); worst('AMBRE'); }
      const engagement = docs.find((d) => d.type === 'ENGAGEMENT') ?? docs.find((d) => d.type === 'CONTRAT');
      const amount = Money.fromJSON(tx.amount);
      if (engagement) {
        const ref = Money.fromJSON(engagement.amount);
        // Cumul des paiements de la même opération sur le même compte (y compris celui-ci) : un engagement ne se
        // dépasse pas non plus par fractionnement en plusieurs virements.
        const prior = this.transactions.find((t) => t.accountNumberHash === tx.accountNumberHash && t.reference === tx.reference && t.amount.currency === amount.currency);
        const cumul = prior.reduce((m, t) => m.add(Money.fromJSON(t.amount)), amount);
        if (ref.currency !== amount.currency) { findings.push('Devise différente de celle de l’engagement.'); worst('AMBRE'); }
        else if (cumul.compare(ref) > 0) {
          findings.push(prior.length
            ? `Cumul des paiements de l’opération (${cumul.toDecimalString()} ${cumul.currency}) supérieur à l’engagement (${ref.toDecimalString()} ${ref.currency}) : surfacturation présumée.`
            : `Montant supérieur à l’engagement (${ref.toDecimalString()} ${ref.currency}) : surfacturation présumée.`);
          worst('ROUGE');
        }
      }
      if (!docs.some((d) => norm(d.supplier) === norm(tx.beneficiary))) { findings.push('Bénéficiaire différent du fournisseur des justificatifs : dépense hors objet présumée.'); worst('AMBRE'); }
      if (docs.some((d) => d.date > kinshasaDay(tx.at))) { findings.push('Justificatif daté après le paiement.'); worst('AMBRE'); }
    }
    const previous = this.transactions.find((t) => t.accountNumberHash === tx.accountNumberHash);
    if (previous.some((t) => t.reference === tx.reference && norm(t.beneficiary) === norm(tx.beneficiary) && Money.fromJSON(t.amount).equals(Money.fromJSON(tx.amount)))) {
      findings.push('Paiement répété présumé (même référence, même bénéficiaire, même montant).'); worst('ROUGE');
    }
    const sameDay = previous.filter((t) => norm(t.beneficiary) === norm(tx.beneficiary) && kinshasaDay(t.at) === kinshasaDay(tx.at));
    if (sameDay.length >= 2) { findings.push('Plusieurs paiements le même jour au même bénéficiaire : fractionnement présumé.'); worst('AMBRE'); }
    for (const check of this.checks) for (const r of check(tx, docs, acc)) { findings.push(r.finding); worst(r.score); }
    if (score === 'VERT') findings.push('Conformité totale : compte enregistré, justificatifs complets et cohérents.');
    return { score, findings };
  }

  /** Passerelle bancaire : transmet et standardise ; l'opération est TOUJOURS enregistrée, jamais bloquée. */
  receiveTransaction(user: User, input: { bank: string; accountNumber: string; amount: MoneyJSON; at: string; beneficiary: string; reference: string }) {
    authorize(user, P.calcuGateway, {});
    const hash = sha256Hex(normalizeAccount(input.accountNumber));
    const acc = this.accounts.findOne((a) => a.accountNumberHash === hash);
    const base = {
      bank: input.bank, accountNumberHash: hash, accountId: acc?.id ?? null, amount: Money.fromJSON(input.amount).toJSON(), at: input.at,
      beneficiary: input.beneficiary, reference: input.reference, receivedAt: this.ctx.clock.now().toISOString(), submittedBy: user.id,
    };
    const { score, findings } = this.match(base);
    const id = this.ids.next('CALCU-TX', 8);
    let reportId: string | null = null;
    if (score !== 'VERT') {
      const year = this.ctx.clock.now().getUTCFullYear();
      reportId = this.ids.next(`CALCU-RPT-${year}`);
      const createdAt = this.ctx.clock.now().toISOString();
      this.reports.insert({ id: reportId, transactionId: id, score, findings, createdAt, sha256: sha256Hex(canonicalJson({ reportId, id, score, findings, createdAt })), status: 'OUVERT' });
    }
    const tx = this.transactions.append({ ...base, id, score, findings, reportId, blocked: false });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.transaction.received', resourceType: 'calcu_transaction', resourceId: id, details: { score, reportId, blocked: false } });
    return { id: tx.id, score: tx.score, reportId, blocked: false as const, message: 'Opération enregistrée. CALCU ne bloque aucun paiement.' };
  }

  /** Gel administratif d'un DOSSIER (jamais d'un paiement) : décision humaine motivée, base légale citée. */
  freeze(user: User, reportId: string, input: { reason: string; legalBasis: string }) {
    authorize(user, P.calcuFreeze, {});
    const r = this.reports.get(reportId);
    if (!r) throw notFound('CALCU_REPORT_NOT_FOUND', `Rapport inconnu : ${reportId}`);
    if (r.status !== 'OUVERT') throw conflict('REPORT_NOT_OPEN', 'Seul un dossier ouvert peut être gelé.');
    const saved = this.reports.update({ ...r, status: 'GELE', freeze: { by: user.id, at: this.ctx.clock.now().toISOString(), ...input } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.report.frozen', resourceType: 'calcu_report', resourceId: reportId, details: input });
    return saved;
  }

  close(user: User, reportId: string, reason: string) {
    authorize(user, P.calcuFreeze, {});
    const r = this.reports.get(reportId);
    if (!r) throw notFound('CALCU_REPORT_NOT_FOUND', `Rapport inconnu : ${reportId}`);
    if (r.status === 'CLOS') throw conflict('REPORT_CLOSED', 'Dossier déjà clos.');
    if (r.freeze?.by === user.id) throw forbidden('SEPARATION_OF_DUTIES', 'La clôture d’un dossier gelé revient à une autre personne que celle qui l’a gelé.');
    const saved = this.reports.update({ ...r, status: 'CLOS', closure: { by: user.id, at: this.ctx.clock.now().toISOString(), reason } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.report.closed', resourceType: 'calcu_report', resourceId: reportId, details: { reason } });
    return saved;
  }

  overview(user: User) {
    const access = authorize(user, P.calcuRead, {});
    const txs = this.transactions.all();
    const count = (s: Score) => txs.filter((t) => t.score === s).length;
    const totals = { transactions: txs.length, vert: count('VERT'), ambre: count('AMBRE'), rouge: count('ROUGE'), blocked: 0 };
    const complianceRate = txs.length ? `${Math.round((totals.vert * 1000) / txs.length) / 10}` : '0';
    const base = {
      notice: 'Pilote de démonstration sur une entité volontaire — cadre juridique à adopter (J26). CALCU ne bloque aucun paiement.',
      totals, complianceRate,
      accounts: { declared: this.accounts.count(), validated: this.accounts.find((a) => a.status === 'VALIDE').length },
    };
    if (access === 'minimal') return base;
    return {
      ...base,
      accountsList: this.accounts.all(),
      transactions: txs.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
      reports: this.reports.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      documents: this.documents.all(),
    };
  }
}
