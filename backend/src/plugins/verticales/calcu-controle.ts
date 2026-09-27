/**
 * CALCU — compléments du § 27A.4 et du § 27A.5 (organe de contrôle), construits sur le moteur existant (calcu.ts) :
 *  - registre des FOURNISSEURS ENREGISTRÉS (déclaration, validation par l'organe de contrôle, radiation motivée) ;
 *  - lignes BUDGÉTAIRES et contrôle de CONFORMITÉ BUDGÉTAIRE (cumul des paiements d'une ligne ≤ dotation) ;
 *  - justificatifs GÉOLOCALISÉS (position, précision, horodatage de capture, commune) ;
 *  - rapport d'anomalie en PDF (cachet électronique avancé) ;
 *  - MISSIONS CIBLÉES sans déplacement (accès aux preuves) ;
 *  - TRANSMISSION À LA JUSTICE : proposée par un membre de l'organe, décidée par un autre (bordereau horodaté, pièces
 *    par empreinte) — jamais automatique ;
 *  - tableaux de l'organe de contrôle : montants contrôlés et récupérés, institutions à risque, zones exposées, taux
 *    d'exécution des recommandations.
 * CALCU ne bloque toujours aucun paiement (AC-CAL-01) ; les contrôles ajoutés ne font que qualifier une transaction.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDay } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator } from '../../core/repository.js';
import { buildPdf, sealPdf } from '../../modules/receipts/pdf.js';
import type { CalcuService, Score, SupportingDocument } from './calcu.js';
import { P } from './policies.js';

const { always } = GRANTS;
/** Organe de contrôle : missions, transmissions, recommandations, récupérations. */
definePolicy('verticales:calcu.control', { R22: always });

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface Supplier {
  id: string; name: string; nif: string; rccm?: string;
  status: 'DECLARE' | 'VALIDE' | 'RADIE';
  declaredBy: string; declaredAt: string; validatedBy?: string; validatedAt?: string; radiation?: { by: string; at: string; motif: string };
}
export interface BudgetLine {
  id: string; entityName: string; exercice: number; code: string; label: string; allotted: MoneyJSON; actRef: string;
  status: 'DECLAREE' | 'VALIDEE'; declaredBy: string; declaredAt: string; validatedBy?: string; validatedAt?: string;
}
export interface ControlMission {
  id: string; reportId?: string; entityName: string; objet: string; scope: string; mode: 'SANS_DEPLACEMENT';
  status: 'OUVERTE' | 'CLOTUREE'; openedBy: string; openedAt: string; conclusions?: string; closedBy?: string; closedAt?: string;
}
export interface JusticeReferral {
  id: string; reportId: string; motif: string; authority: string; pieces: string[];
  status: 'PROPOSEE' | 'TRANSMISE' | 'REJETEE'; proposedBy: string; proposedAt: string;
  decidedBy?: string; decidedAt?: string; decisionMotif?: string; bordereau?: { number: string; at: string; sha256: string };
}
export interface Recovery { id: string; reportId: string; amount: MoneyJSON; evidenceSha256: string; note: string; recordedBy: string; recordedAt: string }
export interface Recommendation {
  id: string; reportId?: string; entityName: string; text: string; dueDate: string;
  status: 'EMISE' | 'EN_COURS' | 'EXECUTEE' | 'NON_EXECUTEE'; issuedBy: string; issuedAt: string; followUp: { at: string; by: string; status: string; note: string }[];
}

export class CalcuControlService {
  // Dépôts portés par le service CALCU (persistance : chemin `ext.verticales.calcu.*`).
  private get suppliers() { return this.calcu.suppliers; }
  private get budgetLines() { return this.calcu.budgetLines; }
  private get missions() { return this.calcu.missions; }
  private get referrals() { return this.calcu.referrals; }
  private get recoveries() { return this.calcu.recoveries; }
  private get recommendations() { return this.calcu.recommendations; }
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly calcu: CalcuService) {
    calcu.addCheck((tx, docs) => this.checkSupplier(tx.beneficiary, docs));
    calcu.addCheck((tx, docs) => this.checkBudget(tx, docs));
  }

  private now(): string { return this.ctx.clock.now().toISOString(); }

  /* ---------------------------------------------------------- contrôles du moteur */

  /** Registre actif (au moins un fournisseur validé) : bénéficiaire hors registre ⇒ ambre ; fournisseur radié ⇒ rouge. */
  private checkSupplier(beneficiary: string, docs: SupportingDocument[]): { score: Score; finding: string }[] {
    const all = this.suppliers.all();
    const hit = all.find((s) => norm(s.name) === norm(beneficiary));
    if (hit?.status === 'RADIE') return [{ score: 'ROUGE', finding: `Bénéficiaire ${hit.name} radié du registre des fournisseurs (${hit.radiation?.motif ?? 'motif au registre'}).` }];
    if (!all.some((s) => s.status === 'VALIDE')) return [];
    if (!hit || hit.status !== 'VALIDE') return [{ score: 'AMBRE', finding: 'Bénéficiaire absent du registre des fournisseurs enregistrés (ou non encore validé).' }];
    const declared = docs.find((d) => d.supplierId && d.supplierId !== hit.id);
    return declared ? [{ score: 'AMBRE', finding: 'Justificatif rattaché à un autre fournisseur du registre que le bénéficiaire payé.' }] : [];
  }

  /** Conformité budgétaire : ligne validée, cumul des paiements rattachés à la ligne (même devise) ≤ dotation. */
  private checkBudget(tx: { amount: MoneyJSON; reference: string }, docs: SupportingDocument[]): { score: Score; finding: string }[] {
    const lineId = docs.find((d) => d.budgetLineId)?.budgetLineId;
    if (!lineId) return [];
    const line = this.budgetLines.get(lineId);
    if (!line) return [{ score: 'AMBRE', finding: `Ligne budgétaire ${lineId} inconnue : conformité budgétaire non vérifiable.` }];
    if (line.status !== 'VALIDEE') return [{ score: 'AMBRE', finding: `Ligne budgétaire ${line.code} non encore validée par les Finances.` }];
    if (line.allotted.currency !== tx.amount.currency) return [{ score: 'AMBRE', finding: `Paiement en ${tx.amount.currency}, ligne budgétaire en ${line.allotted.currency}.` }];
    const refs = new Set(this.calcu.documents.find((d) => d.budgetLineId === line.id).map((d) => d.operationRef));
    const prior = this.calcu.transactions.find((t) => refs.has(t.reference) && t.amount.currency === tx.amount.currency);
    const cumul = prior.reduce((m, t) => m.add(Money.fromJSON(t.amount)), Money.fromJSON(tx.amount));
    if (cumul.compare(Money.fromJSON(line.allotted)) > 0) {
      return [{ score: 'ROUGE', finding: `Dépassement de la ligne budgétaire ${line.code} : cumul payé ${cumul.toDecimalString()} ${cumul.currency} > dotation ${line.allotted.amount} ${line.allotted.currency} (non-conformité budgétaire).` }];
    }
    return [];
  }

  /* ---------------------------------------------------------- registres */

  declareSupplier(user: User, input: { name: string; nif: string; rccm?: string }): Supplier {
    authorize(user, P.calcuDeclare, {});
    if (this.suppliers.findOne((s) => s.nif === input.nif || norm(s.name) === norm(input.name))) throw conflict('SUPPLIER_ALREADY_DECLARED', 'Fournisseur déjà déclaré (même NIF ou même nom).');
    const s = this.suppliers.insert({ id: this.ids.next('CALCU-FRN'), name: input.name, nif: input.nif, ...(input.rccm ? { rccm: input.rccm } : {}), status: 'DECLARE', declaredBy: user.id, declaredAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.supplier.declared', resourceType: 'calcu_supplier', resourceId: s.id, details: { name: s.name, nif: s.nif } });
    return s;
  }

  validateSupplier(user: User, id: string): Supplier {
    authorize(user, P.calcuValidateControl, {});
    const s = this.suppliers.get(id);
    if (!s) throw notFound('SUPPLIER_NOT_FOUND', `Fournisseur inconnu : ${id}`);
    if (s.status !== 'DECLARE') throw conflict('SUPPLIER_NOT_PENDING', `Fournisseur au statut ${s.status}.`);
    assertDistinctPerson(user.id, [s.declaredBy], 'Déclaration et validation par deux personnes distinctes.');
    const r = this.suppliers.update({ ...s, status: 'VALIDE', validatedBy: user.id, validatedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.supplier.validated', resourceType: 'calcu_supplier', resourceId: id, details: { declaredBy: s.declaredBy } });
    return r;
  }

  strikeSupplier(user: User, id: string, motif: string): Supplier {
    authorize(user, P.calcuValidateControl, {});
    const s = this.suppliers.get(id);
    if (!s) throw notFound('SUPPLIER_NOT_FOUND', `Fournisseur inconnu : ${id}`);
    if (s.status === 'RADIE') throw conflict('SUPPLIER_STRUCK', 'Fournisseur déjà radié.');
    const r = this.suppliers.update({ ...s, status: 'RADIE', radiation: { by: user.id, at: this.now(), motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.supplier.struck', resourceType: 'calcu_supplier', resourceId: id, details: { motif } });
    return r;
  }

  declareBudgetLine(user: User, input: { entityName: string; exercice: number; code: string; label: string; allotted: MoneyJSON; actRef: string }): BudgetLine {
    authorize(user, P.calcuDeclare, {});
    if (this.budgetLines.findOne((l) => l.entityName === input.entityName && l.exercice === input.exercice && l.code === input.code)) throw conflict('BUDGET_LINE_EXISTS', 'Ligne budgétaire déjà déclarée pour cette entité et cet exercice.');
    const l = this.budgetLines.insert({ id: this.ids.next('CALCU-LB'), ...input, allotted: Money.parseStrict(input.allotted).toJSON(), status: 'DECLAREE', declaredBy: user.id, declaredAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.budget_line.declared', resourceType: 'calcu_budget_line', resourceId: l.id, details: { code: l.code, allotted: l.allotted, actRef: l.actRef } });
    return l;
  }

  validateBudgetLine(user: User, id: string): BudgetLine {
    authorize(user, P.calcuValidateFinances, {});
    const l = this.budgetLines.get(id);
    if (!l) throw notFound('BUDGET_LINE_NOT_FOUND', `Ligne budgétaire inconnue : ${id}`);
    if (l.status !== 'DECLAREE') throw conflict('BUDGET_LINE_VALIDATED', 'Ligne déjà validée.');
    assertDistinctPerson(user.id, [l.declaredBy], 'Déclaration et validation par deux personnes distinctes.');
    const r = this.budgetLines.update({ ...l, status: 'VALIDEE', validatedBy: user.id, validatedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.budget_line.validated', resourceType: 'calcu_budget_line', resourceId: id, details: { declaredBy: l.declaredBy } });
    return r;
  }

  /** Justificatif enrichi (géolocalisation, commune, ligne budgétaire, fournisseur) : enregistré par le moteur existant. */
  registerDocument(user: User, input: Omit<SupportingDocument, 'id' | 'registeredBy' | 'registeredAt'>) {
    if (input.budgetLineId && !this.budgetLines.get(input.budgetLineId)) throw notFound('BUDGET_LINE_NOT_FOUND', `Ligne budgétaire inconnue : ${input.budgetLineId}`);
    if (input.supplierId && !this.suppliers.get(input.supplierId)) throw notFound('SUPPLIER_NOT_FOUND', `Fournisseur inconnu : ${input.supplierId}`);
    if (input.geo && new Date(input.geo.capturedAt).getTime() > this.ctx.clock.now().getTime() + 5 * 60_000) throw unprocessable('CAPTURE_IN_FUTURE', 'Horodatage de capture dans le futur.');
    return this.calcu.registerDocument(user, input);
  }

  /* ---------------------------------------------------------- rapport PDF */

  reportPdf(user: User, reportId: string) {
    const access = authorize(user, P.calcuRead, {});
    if (access === 'minimal') throw unprocessable('ACCESS_MINIMAL', 'Accès minimal : le rapport détaillé est réservé à l’organe de contrôle et aux Finances.');
    const r = this.calcu.reports.get(reportId);
    if (!r) throw notFound('CALCU_REPORT_NOT_FOUND', `Rapport inconnu : ${reportId}`);
    const tx = this.calcu.transactions.get(r.transactionId);
    const acc = tx?.accountId ? this.calcu.accounts.get(tx.accountId) : undefined;
    const docs = tx ? this.calcu.documents.find((d) => d.operationRef === tx.reference) : [];
    const pdf = buildPdf({
      title: `Rapport d’anomalie ${r.id}`, subject: 'CALCU — contrôle de la dépense publique',
      blocks: [
        { text: 'KINSHASA MOSOLO — CALCU (contrôle de la dépense publique)', size: 9 },
        { text: `Rapport d’anomalie n° ${r.id}`, size: 16, bold: true, gap: 6 },
        { text: `Score : ${r.score} — statut du dossier : ${r.status}`, bold: true, gap: 4 },
        { text: `Créé le ${r.createdAt} — empreinte du rapport : ${r.sha256}`, size: 8 },
        { text: 'Transaction', size: 12, bold: true, gap: 10 },
        ...(tx ? [
          { text: `Identifiant : ${tx.id} — banque ${tx.bank} — compte ${acc ? `${acc.entityName} (${acc.accountNumberMasked})` : 'non enregistré au registre'}` },
          { text: `Montant : ${tx.amount.amount} ${tx.amount.currency} — date ${tx.at} — bénéficiaire ${tx.beneficiary} — référence ${tx.reference}` },
          { text: 'Paiement non bloqué : CALCU ne bloque aucun paiement.', size: 8 },
        ] : [{ text: 'Transaction introuvable.' }]),
        { text: 'Détail des écarts', size: 12, bold: true, gap: 10 },
        ...r.findings.map((f) => ({ text: `• ${f}` })),
        { text: 'Justificatifs', size: 12, bold: true, gap: 10 },
        ...(docs.length ? docs.map((d) => ({ text: `• ${d.type} — ${d.supplier} — ${d.amount.amount} ${d.amount.currency} — ${d.date} — empreinte ${d.sha256.slice(0, 16)}…${d.geo ? ` — géolocalisé (${d.geo.lat.toFixed(5)}, ${d.geo.lon.toFixed(5)} ±${d.geo.accuracyM} m, ${d.geo.capturedAt})` : ' — non géolocalisé'}` })) : [{ text: 'Aucun justificatif lié.' }]),
        ...(r.freeze ? [{ text: `Gel administratif du dossier : ${r.freeze.at} par ${r.freeze.by} — ${r.freeze.reason} (base légale : ${r.freeze.legalBasis})`, gap: 8 }] : []),
        ...(r.closure ? [{ text: `Clôture : ${r.closure.at} par ${r.closure.by} — ${r.closure.reason}` }] : []),
        { text: `Document généré le ${this.now()} ; cachet électronique avancé (Ed25519) sur l’ensemble du fichier.`, size: 8, gap: 10 },
      ],
    });
    const sealed = sealPdf(pdf, this.ctx.receipts);
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.report.pdf_exported', resourceType: 'calcu_report', resourceId: r.id, details: { sha256: sealed.sha256, keyId: sealed.keyId } });
    return { ...sealed, fileName: `rapport-${r.id}.pdf` };
  }

  /* ---------------------------------------------------------- missions, justice, recommandations, récupérations */

  openMission(user: User, input: { reportId?: string; entityName: string; objet: string; scope: string }): ControlMission {
    authorize(user, 'verticales:calcu.control');
    if (input.reportId && !this.calcu.reports.get(input.reportId)) throw notFound('CALCU_REPORT_NOT_FOUND', `Rapport inconnu : ${input.reportId}`);
    const m = this.missions.insert({ id: this.ids.next('CALCU-MIS'), ...input, mode: 'SANS_DEPLACEMENT', status: 'OUVERTE', openedBy: user.id, openedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.mission.opened', resourceType: 'calcu_mission', resourceId: m.id, details: { entityName: m.entityName, reportId: m.reportId ?? null } });
    return m;
  }

  /** Preuves de la mission : comptes, transactions, justificatifs et rapports de l'entité (lecture tracée). */
  missionEvidence(user: User, id: string) {
    authorize(user, 'verticales:calcu.control');
    const m = this.missions.get(id);
    if (!m) throw notFound('CALCU_MISSION_NOT_FOUND', `Mission inconnue : ${id}`);
    const accounts = this.calcu.accounts.find((a) => a.entityName === m.entityName);
    const ids = new Set(accounts.map((a) => a.id));
    const transactions = this.calcu.transactions.find((t) => !!t.accountId && ids.has(t.accountId));
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.mission.evidence_viewed', resourceType: 'calcu_mission', resourceId: id, details: { transactions: transactions.length } });
    return {
      mission: m, accounts, transactions,
      documents: this.calcu.documents.find((d) => ids.has(d.accountId)),
      reports: this.calcu.reports.find((r) => transactions.some((t) => t.id === r.transactionId)),
    };
  }

  closeMission(user: User, id: string, conclusions: string): ControlMission {
    authorize(user, 'verticales:calcu.control');
    const m = this.missions.get(id);
    if (!m) throw notFound('CALCU_MISSION_NOT_FOUND', `Mission inconnue : ${id}`);
    if (m.status !== 'OUVERTE') throw conflict('MISSION_CLOSED', 'Mission déjà clôturée.');
    const r = this.missions.update({ ...m, status: 'CLOTUREE', conclusions, closedBy: user.id, closedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.mission.closed', resourceType: 'calcu_mission', resourceId: id, details: { conclusions } });
    return r;
  }

  proposeReferral(user: User, reportId: string, input: { motif: string; authority: string; pieces: string[] }): JusticeReferral {
    authorize(user, 'verticales:calcu.control');
    const rep = this.calcu.reports.get(reportId);
    if (!rep) throw notFound('CALCU_REPORT_NOT_FOUND', `Rapport inconnu : ${reportId}`);
    if (this.referrals.findOne((x) => x.reportId === reportId && x.status !== 'REJETEE')) throw conflict('REFERRAL_EXISTS', 'Une transmission est déjà proposée ou faite pour ce rapport.');
    const j = this.referrals.insert({ id: this.ids.next('CALCU-JUS'), reportId, ...input, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.referral.proposed', resourceType: 'calcu_report', resourceId: reportId, details: { referralId: j.id, authority: j.authority, pieces: j.pieces.length } });
    return j;
  }

  decideReferral(user: User, id: string, input: { approve: boolean; motif: string }): JusticeReferral {
    authorize(user, 'verticales:calcu.control');
    const j = this.referrals.get(id);
    if (!j) throw notFound('REFERRAL_NOT_FOUND', `Transmission inconnue : ${id}`);
    if (j.status !== 'PROPOSEE') throw conflict('REFERRAL_DECIDED', `Transmission ${id} déjà ${j.status}.`);
    assertDistinctPerson(user.id, [j.proposedBy], 'Décision humaine séparée : la transmission à la justice est décidée par une autre personne que son auteur.');
    const at = this.now();
    let bordereau: JusticeReferral['bordereau'];
    if (input.approve) {
      const number = `BT-${j.id}`;
      bordereau = { number, at, sha256: sha256Hex(canonicalJson({ number, at, reportId: j.reportId, authority: j.authority, pieces: j.pieces, motif: j.motif, proposedBy: j.proposedBy, decidedBy: user.id })) };
    }
    const r = this.referrals.update({ ...j, status: input.approve ? 'TRANSMISE' : 'REJETEE', decidedBy: user.id, decidedAt: at, decisionMotif: input.motif, ...(bordereau ? { bordereau } : {}) });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'calcu.referral.transmitted' : 'calcu.referral.rejected', resourceType: 'calcu_report', resourceId: j.reportId, details: { referralId: id, proposedBy: j.proposedBy, bordereau: bordereau?.sha256 ?? null } });
    return r;
  }

  recordRecovery(user: User, reportId: string, input: { amount: MoneyJSON; evidenceSha256: string; note: string }): Recovery {
    authorize(user, 'verticales:calcu.control');
    if (!this.calcu.reports.get(reportId)) throw notFound('CALCU_REPORT_NOT_FOUND', `Rapport inconnu : ${reportId}`);
    const r = this.recoveries.insert({ id: this.ids.next('CALCU-REC'), reportId, amount: Money.parseStrict(input.amount).toJSON(), evidenceSha256: input.evidenceSha256, note: input.note, recordedBy: user.id, recordedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.recovery.recorded', resourceType: 'calcu_report', resourceId: reportId, details: { recoveryId: r.id, amount: r.amount, evidenceSha256: r.evidenceSha256 } });
    return r;
  }

  issueRecommendation(user: User, input: { reportId?: string; entityName: string; text: string; dueDate: string }): Recommendation {
    authorize(user, 'verticales:calcu.control');
    const r = this.recommendations.insert({ id: this.ids.next('CALCU-RCO'), ...input, status: 'EMISE', issuedBy: user.id, issuedAt: this.now(), followUp: [] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.recommendation.issued', resourceType: 'calcu_recommendation', resourceId: r.id, details: { entityName: r.entityName, dueDate: r.dueDate } });
    return r;
  }

  followRecommendation(user: User, id: string, input: { status: 'EN_COURS' | 'EXECUTEE' | 'NON_EXECUTEE'; note: string }): Recommendation {
    authorize(user, 'verticales:calcu.control');
    const r = this.recommendations.get(id);
    if (!r) throw notFound('RECOMMENDATION_NOT_FOUND', `Recommandation inconnue : ${id}`);
    const u = this.recommendations.update({ ...r, status: input.status, followUp: [...r.followUp, { at: this.now(), by: user.id, status: input.status, note: input.note }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'calcu.recommendation.followed', resourceType: 'calcu_recommendation', resourceId: id, details: input });
    return u;
  }

  /* ---------------------------------------------------------- tableaux de l'organe de contrôle */

  dashboard(user: User) {
    const access = authorize(user, P.calcuRead, {});
    const txs = this.calcu.transactions.all();
    const sum = (items: MoneyJSON[]) => {
      const m = new Map<string, Money>();
      for (const i of items) m.set(i.currency, (m.get(i.currency) ?? Money.zero(i.currency as CurrencyCode)).add(Money.fromJSON(i)));
      return [...m.values()].map((x) => x.toJSON());
    };
    const entityOf = (accountId: string | null) => (accountId ? this.calcu.accounts.get(accountId)?.entityName : undefined) ?? 'COMPTE NON ENREGISTRÉ';
    const institutions = new Map<string, { rouge: number; ambre: number; vert: number; amounts: MoneyJSON[] }>();
    for (const t of txs) {
      const k = entityOf(t.accountId);
      const r = institutions.get(k) ?? { rouge: 0, ambre: 0, vert: 0, amounts: [] };
      if (t.score === 'ROUGE') r.rouge++; else if (t.score === 'AMBRE') r.ambre++; else r.vert++;
      if (t.score !== 'VERT') r.amounts.push(t.amount);
      institutions.set(k, r);
    }
    const zones = new Map<string, { anomalies: number; amounts: MoneyJSON[] }>();
    for (const t of txs.filter((x) => x.score !== 'VERT')) {
      const communes = new Set(this.calcu.documents.find((d) => d.operationRef === t.reference && !!d.commune).map((d) => d.commune!));
      for (const c of communes.size ? communes : new Set(['NON_LOCALISE'])) {
        const z = zones.get(c) ?? { anomalies: 0, amounts: [] };
        z.anomalies++; z.amounts.push(t.amount);
        zones.set(c, z);
      }
    }
    const recos = this.recommendations.all();
    const due = recos.filter((r) => r.dueDate <= kinshasaDay(this.now()) || r.status === 'EXECUTEE' || r.status === 'NON_EXECUTEE');
    const base = {
      controlled: { transactions: txs.length, amounts: sum(txs.map((t) => t.amount)) },
      recovered: { count: this.recoveries.count(), amounts: sum(this.recoveries.all().map((r) => r.amount)) },
      recommendations: {
        issued: recos.length, executed: recos.filter((r) => r.status === 'EXECUTEE').length, due: due.length,
        executionRate: due.length ? `${Math.round((recos.filter((r) => r.status === 'EXECUTEE').length * 1000) / due.length) / 10} %` : null,
      },
      notice: 'Tableaux de l’organe de contrôle (§ 27A.5). CALCU ne bloque aucun paiement.',
    };
    if (access === 'minimal') return base;
    return {
      ...base,
      institutionsAtRisk: [...institutions.entries()].map(([entityName, r]) => ({ entityName, ...r, amounts: sum(r.amounts) })).filter((x) => x.rouge + x.ambre > 0).sort((a, b) => b.rouge - a.rouge || b.ambre - a.ambre),
      exposedZones: [...zones.entries()].map(([commune, z]) => ({ commune, anomalies: z.anomalies, amounts: sum(z.amounts) })).sort((a, b) => b.anomalies - a.anomalies),
      suppliers: this.suppliers.all(), budgetLines: this.budgetLines.all(),
      missions: this.missions.all(), referrals: this.referrals.all(), recoveriesList: this.recoveries.all(), recommendationsList: recos,
    };
  }
}
