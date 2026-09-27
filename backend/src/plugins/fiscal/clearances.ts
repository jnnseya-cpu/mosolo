/**
 * Quitus fiscal numérique (module 82) et attestation de bail enregistré (module 9).
 *
 * Quitus : délivré seulement si aucune obligation EXIGIBLE n'est impayée (les obligations contestées avec effet
 * suspensif sont exclues) et si chaque obligation exigible est soldée sur QUITTANCE DÉFINITIVE (une quittance
 * provisoire ne suffit pas, § H.10). Validité limitée (modèle « glissant conditionnel »), révocable par décision
 * motivée, vérifiable par QR sans donnée sensible. Tant que l'acte de conditionnalité n'est pas certifié (J6),
 * le quitus est INFORMATIF : il ne bloque aucun service (ARB-17).
 */
import type { User } from '../../core/auth.js';
import { conflict, notFound, unprocessable, forbidden } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { validityView } from '../../core/validity.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { actorOf, addDays, CATEGORY_LABELS, formatShortCode, maskIuc, newShortCode, normalizeShortCode, type FiscalDeps } from './common.js';

/** Durée de validité et seuil ambre — [paramètres de DÉMONSTRATION ; « période fixée par la règle », acte J6]. */
export const CLEARANCE_VALIDITY_DAYS = 90;

export interface ClearanceBlocker { obligationId: string; label: string; dueDate: string; reason: 'IMPAYEE' | 'EN_ATTENTE_DE_RAPPROCHEMENT' | 'CONTESTEE_SANS_EFFET_SUSPENSIF' }

export interface Clearance {
  id: string;
  number: string;
  shortCode: string;
  signature: string;
  taxpayerId: string;
  issuedAt: string;
  validFrom: string;
  validUntil: string;
  status: 'ACTIF' | 'REVOQUE';
  informative: true;
  verificationLevel: string;
  basis: { obligationsExamined: number; settledOnDefinitiveReceipt: string[]; contestedExcluded: string[]; notYetDue: string[] };
  requestedBy: string;
  revocation?: { reason: string; by: string; at: string };
}

export interface LeaseAttestation {
  id: string;
  number: string;
  shortCode: string;
  signature: string;
  leaseId: string;
  issuedTo: string;
  issuedToRole: 'BAILLEUR' | 'LOCATAIRE';
  issuedAt: string;
  status: 'VALIDE' | 'REVOQUEE';
}

export type ClearanceCheckResult = 'VALIDE' | 'BIENTOT_EXPIRE' | 'EXPIRE' | 'REVOQUE' | 'SIGNATURE_INVALIDE' | 'INCONNU';

export class ClearanceService {
  readonly clearances = new InMemoryRepository<Clearance>();
  readonly attestations = new InMemoryRepository<LeaseAttestation>();
  readonly checks = new InMemoryAppendOnlyRepository<{ id: string; at: string; kind: string; result: string; channel: string; actorId: string }>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps) {}

  /** Examen des conditions (serveur uniquement), sans aucune donnée de tiers. */
  eligibility(taxpayerId: string) {
    const today = this.d.today();
    const obligations = this.d.ctx.assessment.byTaxpayer(taxpayerId).filter((o) => o.status !== 'ANNULEE' && !o.supersededBy);
    const blockers: ClearanceBlocker[] = [];
    const settled: string[] = [];
    const contested: string[] = [];
    const notYetDue: string[] = [];
    for (const o of obligations) {
      if (o.status === 'CONTESTEE') {
        // Recours en cours : effet bloquant suspendu (ARB-17), sauf refus exprès de l'effet suspensif par l'autorité.
        const appeal = this.d.ctx.appeals.appeals.find((a) => a.obligationId === o.id).at(-1) as { suspensiveEffect?: { status?: string } } | undefined;
        if (appeal?.suspensiveEffect?.status === 'REFUSE' && o.dueDate < today) blockers.push({ obligationId: o.id, label: o.label, dueDate: o.dueDate, reason: 'CONTESTEE_SANS_EFFET_SUSPENSIF' });
        else contested.push(o.id);
        continue;
      }
      if (o.status === 'SOLDEE') {
        const orders = this.d.ctx.payments.byObligation(o.id);
        const receipts = orders.map((p) => this.d.ctx.receipts.byPaymentOrder(p.id)).filter((r) => !!r);
        // Obligation soldée sans paiement (montant nul après exonération) ou sur quittance définitive.
        if (orders.length === 0 || receipts.some((r) => r!.status === 'DEFINITIVE')) settled.push(o.id);
        else blockers.push({ obligationId: o.id, label: o.label, dueDate: o.dueDate, reason: 'EN_ATTENTE_DE_RAPPROCHEMENT' });
        continue;
      }
      if (!PAYABLE_STATUSES.includes(o.status)) continue;
      const exigible = o.status === 'EXIGIBLE' || o.status === 'EN_RETARD' || o.dueDate < today;
      if (!exigible) { notYetDue.push(o.id); continue; }
      const confirmed = this.d.ctx.payments.byObligation(o.id).some((p) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status));
      blockers.push({ obligationId: o.id, label: o.label, dueDate: o.dueDate, reason: confirmed ? 'EN_ATTENTE_DE_RAPPROCHEMENT' : 'IMPAYEE' });
    }
    const tp = this.d.ctx.taxpayers.get(taxpayerId);
    return {
      eligible: blockers.length === 0,
      blockers,
      basis: { obligationsExamined: obligations.length, settledOnDefinitiveReceipt: settled, contestedExcluded: contested, notYetDue },
      verificationLevel: tp.verificationLevel,
      levelNote: ['N3'].includes(tp.verificationLevel) ? null : 'Niveau N3 attendu pour un quitus opposable (§ 9.3) ; en dessous, le quitus reste informatif.',
      informative: true as const,
      notice: 'Quitus INFORMATIF : aucun service n’est conditionné tant que l’acte instituant le quitus n’est pas certifié (J6, ARB-17).',
      checkedAt: this.d.nowIso(),
    };
  }

  private payload(c: { shortCode: string; number: string; taxpayerId: string; validUntil: string }) {
    return `quitus|${c.shortCode}|${c.number}|${c.taxpayerId}|${c.validUntil}`;
  }

  active(taxpayerId: string): Clearance | undefined {
    const today = this.d.today();
    return this.clearances.findOne((c) => c.taxpayerId === taxpayerId && c.status === 'ACTIF' && c.validUntil >= today);
  }

  request(user: User, taxpayerIdIn?: string): { clearance: Clearance; reused: boolean } {
    const taxpayerId = taxpayerIdIn ?? (user.roles.includes('R30') ? user.taxpayerId : undefined);
    if (!taxpayerId) throw unprocessable('TAXPAYER_REQUIRED', 'Contribuable requis.');
    authorize(user, 'fiscal:clearance.request', { taxpayerId });
    const existing = this.active(taxpayerId);
    if (existing) return { clearance: existing, reused: true };
    const e = this.eligibility(taxpayerId);
    if (!e.eligible) {
      this.d.ctx.audit.append({ actor: actorOf(user), action: 'clearance.refused', resourceType: 'taxpayer', resourceId: taxpayerId, outcome: 'DENIED', details: { blockers: e.blockers.map((b) => b.obligationId) } });
      throw unprocessable('CLEARANCE_NOT_ELIGIBLE', 'Quitus impossible : au moins une obligation exigible n’est pas régularisée sur quittance définitive.', { blockers: e.blockers });
    }
    const today = this.d.today();
    const year = today.slice(0, 4);
    const base = { shortCode: newShortCode(), number: this.ids.next(`QTS-${year}`), taxpayerId, validUntil: addDays(today, CLEARANCE_VALIDITY_DAYS) };
    const c = this.clearances.insert({
      id: this.ids.next('QUITUS'), ...base, signature: this.d.sign(this.payload(base)), issuedAt: this.d.nowIso(), validFrom: today,
      status: 'ACTIF', informative: true, verificationLevel: e.verificationLevel, basis: e.basis, requestedBy: user.id,
    });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'clearance.issued', resourceType: 'clearance', resourceId: c.id, details: { number: c.number, validUntil: c.validUntil, basis: c.basis } });
    this.d.ctx.comms.publish('clearance.issued', [taxpayerRecipient(this.d.ctx.taxpayers.get(taxpayerId))], { reference: c.number, date: c.validUntil }, { entity: 'DGIPK' });
    return { clearance: c, reused: false };
  }

  revoke(user: User, id: string, reason: string): Clearance {
    const c = this.clearances.get(id);
    if (!c) throw notFound('CLEARANCE_NOT_FOUND', `Quitus inconnu : ${id}`);
    authorize(user, 'fiscal:clearance.revoke');
    if (c.status === 'REVOQUE') throw conflict('ALREADY_REVOKED', 'Quitus déjà révoqué.');
    const r = this.clearances.update({ ...c, status: 'REVOQUE', revocation: { reason, by: user.id, at: this.d.nowIso() } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'clearance.revoked', resourceType: 'clearance', resourceId: id, details: { reason } });
    this.d.ctx.comms.publish('clearance.revoked', [taxpayerRecipient(this.d.ctx.taxpayers.get(c.taxpayerId))], { reference: c.number }, { entity: 'DGIPK' });
    return r;
  }

  /**
   * Revue « glissant conditionnel » : quitus actifs dont les conditions ne sont plus réunies. Le système PROPOSE
   * une révocation ; une personne habilitée décide (aucune révocation automatique).
   */
  review(user: User) {
    authorize(user, 'fiscal:clearance.revoke');
    const today = this.d.today();
    return this.clearances.find((c) => c.status === 'ACTIF' && c.validUntil >= today).flatMap((c) => {
      const e = this.eligibility(c.taxpayerId);
      return e.eligible ? [] : [{ clearanceId: c.id, number: c.number, taxpayerId: c.taxpayerId, blockers: e.blockers, proposal: 'Révocation à examiner (décision humaine motivée).' }];
    });
  }

  statusOf(c: Clearance): ClearanceCheckResult {
    const today = this.d.today();
    if (c.status === 'REVOQUE') return 'REVOQUE';
    if (c.validUntil < today) return 'EXPIRE';
    // Règle 50 % / 1 % : sous 50 % de validité restante, le quitus est signalé « expire bientôt » (ambre ou rouge).
    const v = validityView(c.validFrom, c.validUntil, new Date(this.d.nowIso()));
    if (v.band === 'EXPIRE') return 'EXPIRE';
    if (v.band === 'AMBRE' || v.band === 'ROUGE') return 'BIENTOT_EXPIRE';
    return 'VALIDE';
  }

  view(c: Clearance) {
    return {
      ...c, shortCodeDisplay: formatShortCode(c.shortCode), check: this.statusOf(c), validity: validityView(c.validFrom, c.validUntil, new Date(this.d.nowIso())),
      verifyPath: `/fiscal/verifier/quitus/${c.shortCode}?s=${c.signature}`,
      notice: 'Quitus informatif (acte J6 non certifié) — vérifiable par QR ; ne contient aucune donnée sensible.',
    };
  }

  private byCode(raw: string): Clearance | undefined {
    const code = normalizeShortCode(raw);
    return code ? this.clearances.findOne((c) => c.shortCode === code) : undefined;
  }

  /** Vérification publique : ni nom, ni adresse, ni montant ; identifiant contribuable masqué. */
  publicCheck(raw: string, signature?: string, channel: 'PUBLIC' | 'SERVICE' = 'PUBLIC', actorId = 'public') {
    const c = this.byCode(raw);
    let result: ClearanceCheckResult;
    if (!c) result = 'INCONNU';
    else if (signature !== undefined && !this.d.verify(this.payload(c), signature)) result = 'SIGNATURE_INVALIDE';
    else result = this.statusOf(c);
    const at = this.d.nowIso();
    this.checks.append({ id: this.ids.next('CHK-QTS', 8), at, kind: 'QUITUS', result, channel, actorId });
    this.d.ctx.audit.append({ actor: channel === 'PUBLIC' ? { kind: 'public', id: 'verification-quitus' } : { kind: 'user', id: actorId }, action: 'clearance.checked', resourceType: 'clearance', resourceId: c?.id ?? 'inconnu', outcome: result === 'INCONNU' || result === 'SIGNATURE_INVALIDE' ? 'FAILURE' : 'SUCCESS', details: { result, channel } });
    if (!c || result === 'INCONNU' || result === 'SIGNATURE_INVALIDE') return { result, checkedAt: at };
    const tp = this.d.ctx.taxpayers.get(c.taxpayerId);
    return {
      result, checkedAt: at, number: c.number, taxpayerRef: maskIuc(tp.iuc), validFrom: c.validFrom, validUntil: c.validUntil,
      validity: validityView(c.validFrom, c.validUntil, new Date(at)),
      informative: true, notice: 'Quitus informatif : il atteste l’absence d’obligation exigible impayée à la date de délivrance.',
    };
  }

  /** API des services utilisateurs du quitus (R37) : oui / non + validité ; le contribuable est informé. */
  serviceCheck(user: User, raw: string) {
    authorize(user, 'fiscal:clearance.verify-service');
    const r = this.publicCheck(raw, undefined, 'SERVICE', user.id);
    const c = this.byCode(raw);
    if (c && r.result !== 'INCONNU') {
      this.d.ctx.comms.publish('clearance.verified_by_service', [taxpayerRecipient(this.d.ctx.taxpayers.get(c.taxpayerId))], { service: user.name }, { entity: 'DGIPK' });
    }
    return { valid: r.result === 'VALIDE' || r.result === 'BIENTOT_EXPIRE', ...r };
  }

  // ——— Attestation de bail enregistré ———

  private attPayload(a: { shortCode: string; number: string; leaseId: string }) {
    return `bail|${a.shortCode}|${a.number}|${a.leaseId}`;
  }

  issueLeaseAttestation(user: User, leaseId: string): LeaseAttestation {
    const lease = this.d.ctx.objects.leases.get(leaseId);
    if (!lease) throw notFound('LEASE_NOT_FOUND', `Bail inconnu : ${leaseId}`);
    authorize(user, 'fiscal:lease-attestation.issue');
    let party: string | undefined;
    if (user.roles.includes('R30')) party = user.taxpayerId;
    else if (user.roles.includes('R31')) party = (user.mandants ?? []).find((m) => m === lease.lessorId || m === lease.lesseeId);
    else party = lease.lesseeId ?? lease.lessorId; // guichet : délivrance au locataire par défaut
    if (!party || (party !== lease.lessorId && party !== lease.lesseeId)) {
      throw forbidden('NOT_A_LEASE_PARTY', 'Seuls le bailleur, le locataire ou leur mandataire obtiennent une attestation de ce bail.');
    }
    const role: LeaseAttestation['issuedToRole'] = party === lease.lesseeId ? 'LOCATAIRE' : 'BAILLEUR';
    const existing = this.attestations.findOne((a) => a.leaseId === leaseId && a.issuedTo === party && a.status === 'VALIDE');
    if (existing) return existing;
    const base = { shortCode: newShortCode(), number: this.ids.next(`ATB-${this.d.today().slice(0, 4)}`), leaseId };
    const a = this.attestations.insert({ id: this.ids.next('ATT-BAIL'), ...base, signature: this.d.sign(this.attPayload(base)), issuedTo: party, issuedToRole: role, issuedAt: this.d.nowIso(), status: 'VALIDE' });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'lease.attestation.issued', resourceType: 'lease', resourceId: leaseId, details: { number: a.number, role } });
    return a;
  }

  attestationView(a: LeaseAttestation) {
    const lease = this.d.ctx.objects.leases.get(a.leaseId)!;
    const unit = this.d.ctx.objects.objects.get(lease.unitObjectId);
    const name = (id?: string) => (id ? this.d.ctx.taxpayers.taxpayers.get(id)?.fullName ?? '—' : 'Non renseigné');
    return {
      ...a, shortCodeDisplay: formatShortCode(a.shortCode),
      verifyPath: `/fiscal/verifier/bail/${a.shortCode}?s=${a.signature}`,
      lease: {
        id: lease.id, unitIgf: unit?.igf?.code ?? unit?.id ?? '—', unitLabel: unit ? CATEGORY_LABELS[unit.category] : '—',
        commune: unit?.commune ?? '—', quartier: unit?.quartier ?? '—',
        lessor: name(lease.lessorId), lessee: name(lease.lesseeId), rent: lease.rent, periodicity: lease.periodicity,
        start: lease.start, end: lease.end ?? null, probativeStatus: lease.probativeStatus,
      },
      legalNote: 'Valeur juridique de l’attestation électronique [À VÉRIFIER — J7]. Distincte de l’attestation de retenue.',
    };
  }

  leaseAttestationsOf(taxpayerId: string) {
    return this.attestations.find((a) => a.issuedTo === taxpayerId).map((a) => this.attestationView(a));
  }

  /** Vérification publique d'une attestation de bail : ni nom, ni loyer. */
  publicCheckAttestation(raw: string, signature?: string) {
    const code = normalizeShortCode(raw);
    const a = code ? this.attestations.findOne((x) => x.shortCode === code) : undefined;
    let result: 'VALIDE' | 'REVOQUEE' | 'SIGNATURE_INVALIDE' | 'INCONNU';
    if (!a) result = 'INCONNU';
    else if (signature !== undefined && !this.d.verify(this.attPayload(a), signature)) result = 'SIGNATURE_INVALIDE';
    else result = a.status === 'VALIDE' ? 'VALIDE' : 'REVOQUEE';
    const at = this.d.nowIso();
    this.checks.append({ id: this.ids.next('CHK-ATB', 8), at, kind: 'ATTESTATION_BAIL', result, channel: 'PUBLIC', actorId: 'public' });
    if (!a || result === 'INCONNU' || result === 'SIGNATURE_INVALIDE') return { result, checkedAt: at };
    const lease = this.d.ctx.objects.leases.get(a.leaseId)!;
    const unit = this.d.ctx.objects.objects.get(lease.unitObjectId);
    return {
      result, checkedAt: at, number: a.number, issuedAt: a.issuedAt, unitIgf: unit?.igf?.code ?? null,
      commune: unit?.commune ?? null, quartier: unit?.quartier ?? null, leaseStart: lease.start, leaseEnd: lease.end ?? null,
      notice: 'Bail enregistré dans KINSHASA MOSOLO. Aucune donnée personnelle ni loyer n’est affiché.',
    };
  }
}
