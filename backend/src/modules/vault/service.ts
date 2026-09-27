/**
 * Coffre des comptes bénéficiaires (§ 12.6, § 18.5).
 * Les canaux ne reçoivent qu'un ALIAS ; le compte réel n'est modifiable que par :
 * proposition du Trésor (R17) → deux approbations distinctes de gestionnaires du coffre (R19)
 * avec vérification hors bande → délai de refroidissement de 72 h → effet. Notifications multiples.
 * Pendant l'attente et le refroidissement, un veto motivé (Gouverneur R01, ministre des Finances R05, audit R22, ou tout
 * gestionnaire du coffre R19 autre que le proposant) annule définitivement la demande.
 */
import type { CurrencyCode } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import { HOUR_MS, type Clock } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService } from '../communications/service.js';
import { userRecipient } from '../identity/recipients.js';

export const COOLING_OFF_HOURS = 72;
export const REQUIRED_VAULT_APPROVALS = 2;

/** Veto d'un changement de compte bénéficiaire en attente ou en refroidissement. */
definePolicy('vault:beneficiary.veto', { R01: GRANTS.always, R05: GRANTS.always, R22: GRANTS.always, R19: GRANTS.always });

export interface BeneficiaryAccount {
  id: string; // = alias
  alias: string;
  entity: string;
  bankName: string;
  accountNumber: string;
  holderName: string;
  currency: CurrencyCode;
  version: number;
  effectiveSince: string;
}

export interface ChangeRequest {
  id: string;
  alias: string;
  proposed: { bankName: string; accountNumber: string; holderName: string };
  reason: string;
  requestedBy: string;
  requestedAt: string;
  approvals: { userId: string; at: string; outOfBandVerified: true }[];
  status: 'EN_ATTENTE_APPROBATION' | 'EN_REFROIDISSEMENT' | 'EFFECTIF' | 'ANNULEE';
  coolingEndsAt?: string;
  effectiveAt?: string;
  /** Veto motivé : la demande est définitivement annulée, le compte en vigueur ne change pas. */
  veto?: { by: string; at: string; motif: string };
}

export function maskAccount(n: string): string {
  return '•••• ' + n.slice(-4);
}

export class VaultService {
  readonly accounts = new InMemoryRepository<BeneficiaryAccount>();
  readonly requests = new InMemoryRepository<ChangeRequest>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly users: UserDirectory,
  ) {}

  seedAccount(a: Omit<BeneficiaryAccount, 'id' | 'version' | 'effectiveSince'>): void {
    this.accounts.insert({ ...a, id: a.alias, version: 1, effectiveSince: this.clock.now().toISOString() });
  }

  aliasExists(alias: string): boolean {
    return this.accounts.get(alias) !== undefined;
  }

  /** Résout un alias pour un ordre de paiement : seul l'alias sort du coffre. */
  resolveAlias(alias: string): string {
    this.applyDue();
    if (!this.aliasExists(alias)) throw unprocessable('UNKNOWN_BENEFICIARY_ALIAS', `Alias inconnu du coffre : ${alias}`);
    return alias;
  }

  /** Usage interne (rapprochement) : version du compte en vigueur. */
  current(alias: string): BeneficiaryAccount | undefined {
    this.applyDue();
    return this.accounts.get(alias);
  }

  private watchers(): ReturnType<typeof userRecipient>[] {
    // Notification au Gouverneur, au ministre des Finances, à l'audit et au coffre (§ 12.6).
    return (['R01', 'R05', 'R22', 'R19'] as const).flatMap((r) => this.users.withRole(r)).map(userRecipient);
  }

  propose(user: User, input: { alias: string; bankName: string; accountNumber: string; holderName: string; reason: string }): ChangeRequest {
    authorize(user, 'beneficiary.propose');
    if (!this.aliasExists(input.alias)) throw notFound('UNKNOWN_BENEFICIARY_ALIAS', `Alias inconnu du coffre : ${input.alias}`);
    const req = this.requests.insert({
      id: this.ids.next('CHG'),
      alias: input.alias,
      proposed: { bankName: input.bankName, accountNumber: input.accountNumber, holderName: input.holderName },
      reason: input.reason,
      requestedBy: user.id,
      requestedAt: this.clock.now().toISOString(),
      approvals: [],
      status: 'EN_ATTENTE_APPROBATION',
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles },
      action: 'beneficiary.change.proposed',
      resourceType: 'beneficiary_change',
      resourceId: req.id,
      details: { alias: req.alias, proposedAccountHash: sha256Hex(input.accountNumber), reason: input.reason },
    });
    this.comms.publish('beneficiary.change.proposed', this.watchers(), { reference: req.id }, { entity: 'TRESOR' });
    return req;
  }

  approve(user: User, id: string, outOfBandVerified: boolean): ChangeRequest {
    authorize(user, 'beneficiary.approve');
    this.applyDue();
    const req = this.requests.get(id);
    if (!req) throw notFound('CHANGE_REQUEST_NOT_FOUND', `Demande inconnue : ${id}`);
    if (!outOfBandVerified) {
      throw unprocessable('OUT_OF_BAND_VERIFICATION_REQUIRED', 'La confirmation hors bande auprès de la banque est obligatoire avant approbation.');
    }
    if (req.status !== 'EN_ATTENTE_APPROBATION') throw conflict('INVALID_CHANGE_REQUEST_STATE', `Demande au statut ${req.status}.`);
    assertDistinctPerson(user.id, [req.requestedBy, ...req.approvals.map((a) => a.userId)], 'Les deux approbateurs doivent être distincts entre eux et du proposant.');
    const now = this.clock.now();
    const approvals = [...req.approvals, { userId: user.id, at: now.toISOString(), outOfBandVerified: true as const }];
    const quorum = approvals.length >= REQUIRED_VAULT_APPROVALS;
    const updated = this.requests.update({
      ...req,
      approvals,
      ...(quorum ? { status: 'EN_REFROIDISSEMENT' as const, coolingEndsAt: new Date(now.getTime() + COOLING_OFF_HOURS * HOUR_MS).toISOString() } : {}),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles },
      action: 'beneficiary.change.approved',
      resourceType: 'beneficiary_change',
      resourceId: id,
      details: { approvals: approvals.length, outOfBandVerified: true, status: updated.status },
    });
    if (quorum) this.comms.publish('beneficiary.change.cooling_off', this.watchers(), { reference: id }, { entity: 'TRESOR' });
    return updated;
  }

  /**
   * Veto pendant l'attente d'approbation ou le refroidissement : R01, R05, R22 ou un R19 autre que le proposant.
   * Définitif (ANNULEE) ; notifié aux mêmes destinataires que la proposition.
   */
  veto(user: User, id: string, motif: string): ChangeRequest {
    authorize(user, 'vault:beneficiary.veto');
    this.applyDue();
    const req = this.requests.get(id);
    if (!req) throw notFound('CHANGE_REQUEST_NOT_FOUND', `Demande inconnue : ${id}`);
    if (req.status !== 'EN_ATTENTE_APPROBATION' && req.status !== 'EN_REFROIDISSEMENT') {
      throw conflict('INVALID_CHANGE_REQUEST_STATE', `Demande au statut ${req.status} : veto possible seulement avant l'effet.`);
    }
    assertDistinctPerson(user.id, [req.requestedBy], 'Le proposant ne peut pas opposer son veto à sa propre demande (il peut la laisser rejeter).');
    const at = this.clock.now().toISOString();
    const updated = this.requests.update({ ...req, status: 'ANNULEE', veto: { by: user.id, at, motif } });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'beneficiary.change.vetoed', resourceType: 'beneficiary_change', resourceId: id,
      details: { alias: req.alias, from: req.status, motif },
    });
    this.comms.publish('beneficiary.change.blocked', this.watchers(), { reference: id }, { entity: 'TRESOR' });
    return updated;
  }

  /** Applique les changements dont le délai de refroidissement est écoulé (horloge injectée). */
  applyDue(): void {
    const now = this.clock.now();
    for (const req of this.requests.find((r) => r.status === 'EN_REFROIDISSEMENT')) {
      if (!req.coolingEndsAt || new Date(req.coolingEndsAt) > now) continue;
      const acc = this.accounts.get(req.alias)!;
      this.accounts.update({ ...acc, ...req.proposed, version: acc.version + 1, effectiveSince: now.toISOString() });
      this.requests.update({ ...req, status: 'EFFECTIF', effectiveAt: now.toISOString() });
      this.audit.append({
        actor: { kind: 'system', id: 'coffre' },
        action: 'beneficiary.change.effective',
        resourceType: 'beneficiary_change',
        resourceId: req.id,
        details: { alias: req.alias, version: acc.version + 1 },
      });
      this.comms.publish('beneficiary.change.effective', this.watchers(), { reference: req.id }, { entity: 'TRESOR' });
    }
  }

  getRequest(id: string): ChangeRequest {
    this.applyDue();
    const r = this.requests.get(id);
    if (!r) throw notFound('CHANGE_REQUEST_NOT_FOUND', `Demande inconnue : ${id}`);
    return r;
  }

  view() {
    this.applyDue();
    return {
      accounts: this.accounts.all().map((a) => ({ ...a, accountNumber: maskAccount(a.accountNumber) })),
      changeRequests: this.requests.all().map((r) => ({ ...r, proposed: { ...r.proposed, accountNumber: maskAccount(r.proposed.accountNumber) } })),
    };
  }

  maskedRequest(r: ChangeRequest): ChangeRequest {
    return { ...r, proposed: { ...r.proposed, accountNumber: maskAccount(r.proposed.accountNumber) } };
  }
}
