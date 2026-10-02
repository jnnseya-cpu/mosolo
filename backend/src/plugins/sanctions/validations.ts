/**
 * Validation humaine à deux personnes d'une commission AVANT versement (circuit à quatre yeux) :
 *  1. l'agent bénéficiaire DEMANDE la validation de ses lignes ACQUISES (rapprochées au compte public) ;
 *  2. un superviseur (R09, R07 ou R06) DISTINCT de l'agent et des personnes qui ont vérifié ou décidé le constat
 *     d'origine VALIDE ou REFUSE, avec motif. Toute décision est journalisée ; la route de décision est soumise à la
 *     garde de rotation (paire agent → superviseur) du module Intégrité.
 * Seules les lignes validées sont « payables » par le Trésor. Les conditions d'attribution (délai de grâce, présence
 * attestée, constat validé et photographié, dossier retenu…) restent celles du calcul : à la décision, chaque ligne
 * est recalculée et doit être encore ACQUISE et attribuée au même agent — sinon nouvelle demande.
 * Aucune validation automatique : le système calcule, un humain décide.
 */
import type { MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate, voitTousLesGains } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { sumByCurrency } from '../parking/support.js';
import type { CommissionLine, CommissionService } from './commissions.js';

export type LineValidation = 'A_DEMANDER' | 'DEMANDEE' | 'VALIDEE' | 'REFUSEE';

export interface ValidationLine {
  key: string;
  module: string;
  source: CommissionLine['source'];
  reference: string;
  obligationId: string;
  orderId: string;
  commission: MoneyJSON;
  verifierIds: string[];
}

export interface CommissionValidation {
  id: string;
  agentId: string;
  lines: ValidationLine[];
  total: MoneyJSON[];
  /** Personnes exclues de la décision : l'agent et les intervenants des constats (vérification, décision). */
  excluded: string[];
  status: 'DEMANDEE' | 'VALIDEE' | 'REFUSEE';
  requestedAt: string;
  motif?: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
}

/** Clé stable d'une ligne de commission (une ligne ACQUISE est toujours fondée sur un ordre payé). */
export const lineKey = (l: Pick<CommissionLine, 'source' | 'orderId'>): string | null => (l.orderId ? `${l.source}:${l.orderId}` : null);

export class CommissionValidations {
  readonly requests = new InMemoryRepository<CommissionValidation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly commissions: CommissionService) {}

  private actor(u: User) {
    return { kind: 'user' as const, id: u.id, roles: u.roles };
  }

  /** État de validation d'une ligne : celui de la DERNIÈRE demande qui la contient (une ligne validée l'est pour toujours). */
  stateOf(key: string): LineValidation {
    let out: LineValidation = 'A_DEMANDER';
    for (const r of this.requests.all().sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id))) {
      if (!r.lines.some((l) => l.key === key)) continue;
      if (r.status === 'VALIDEE') return 'VALIDEE';
      out = r.status;
    }
    return out;
  }

  /** Demande de validation par l'agent bénéficiaire : ses lignes ACQUISES non encore demandées ni validées. */
  request(user: User, input: { lineKeys?: string[]; motif?: string } = {}): CommissionValidation {
    const acquired = this.commissions.lines(user.id).filter((l) => l.state === 'ACQUISE' && lineKey(l));
    const open = acquired.filter((l) => { const s = this.stateOf(lineKey(l)!); return s === 'A_DEMANDER' || s === 'REFUSEE'; });
    const wanted = input.lineKeys?.length ? open.filter((l) => input.lineKeys!.includes(lineKey(l)!)) : open;
    if (input.lineKeys?.length && wanted.length !== new Set(input.lineKeys).size) {
      throw conflict('COMMISSION_LINE_NOT_OPEN', 'Une ligne demandée n’est pas une commission acquise en attente de validation (déjà demandée, validée, ou non acquise).');
    }
    if (!wanted.length) throw badRequest('NO_ACQUIRED_COMMISSION', 'Aucune commission acquise à faire valider : seules les commissions rapprochées au compte public le sont.');
    const lines: ValidationLine[] = wanted.map((l) => ({
      key: lineKey(l)!, module: l.module, source: l.source, reference: l.reference, obligationId: l.obligationId, orderId: l.orderId!,
      commission: l.commission, verifierIds: l.verifierIds ?? [],
    }));
    const excluded = [...new Set([user.id, ...lines.flatMap((l) => l.verifierIds)])];
    const motif = input.motif?.trim();
    const r = this.requests.insert({
      id: this.ids.next('COMV'), agentId: user.id, lines, total: sumByCurrency(lines.map((l) => l.commission)), excluded,
      status: 'DEMANDEE', requestedAt: this.ctx.clock.now().toISOString(), ...(motif ? { motif } : {}),
    });
    this.ctx.audit.append({
      actor: this.actor(user), action: 'agents.commission.validation_requested', resourceType: 'commission_validation', resourceId: r.id,
      details: { agentId: user.id, lines: lines.length, total: r.total, references: lines.map((l) => l.reference) },
    });
    return r;
  }

  /** Motif empêchant `user` de décider (null : peut décider). */
  blockReason(user: User, r: CommissionValidation): string | null {
    if (!evaluate(user, 'sanctions:commission.validate', {})) return 'Validation réservée aux superviseurs (R09), chefs de service (R07) et directions de régie (R06).';
    if (r.agentId === user.id) return 'Vous êtes le bénéficiaire de cette commission.';
    if (r.excluded.includes(user.id)) return 'Vous avez vérifié ou décidé un constat à l’origine de cette commission.';
    return null;
  }

  /** File des demandes (superviseurs) ; chaque demande indique si la personne qui consulte peut décider. */
  queue(user: User, status?: string) {
    const full = voitTousLesGains(user, 'AGENTS') || evaluate(user, 'sanctions:commission.validations.read', {}) !== false;
    if (!full && !evaluate(user, 'sanctions:commission.validate', {})) {
      throw forbidden('FORBIDDEN', 'File de validation réservée aux superviseurs et aux régies (leurs agents) et au pilotage.');
    }
    // Décision du 29/09/2026 : un superviseur ou une régie ne voit que les demandes des agents de sa propre entité.
    const sameEntity = (agentId: string) => this.ctx.users.get(agentId)?.entity === user.entity;
    const items = this.requests.find((r) => (!status || r.status === status) && (full || sameEntity(r.agentId)))
      .sort((a, b) => (a.status === 'DEMANDEE' ? 0 : 1) - (b.status === 'DEMANDEE' ? 0 : 1) || b.requestedAt.localeCompare(a.requestedAt))
      .map((r) => ({ ...r, agentName: this.ctx.users.get(r.agentId)?.name ?? r.agentId, blockReason: r.status === 'DEMANDEE' ? this.blockReason(user, r) : null }));
    return {
      items,
      pending: items.filter((r) => r.status === 'DEMANDEE').length,
      rule: 'Une commission n’est payable qu’après validation par un superviseur distinct de l’agent bénéficiaire et des personnes qui ont vérifié ou décidé le constat. Décision motivée et journalisée ; aucune validation automatique.',
    };
  }

  decide(user: User, id: string, input: { approve: boolean; motif: string }): CommissionValidation {
    authorize(user, 'sanctions:commission.validate');
    const r = this.requests.get(id);
    if (!r) throw notFound('COMMISSION_VALIDATION_NOT_FOUND', `Demande inconnue : ${id}`);
    if (r.status !== 'DEMANDEE') throw conflict('COMMISSION_VALIDATION_ALREADY_DECIDED', `Demande au statut ${r.status}.`);
    // Intervenants recalculés : un constat a pu être vérifié ou décidé depuis la demande.
    const current = new Map(this.commissions.lines(r.agentId).filter((l) => lineKey(l)).map((l) => [lineKey(l)!, l]));
    const excluded = [...new Set([...r.excluded, ...r.lines.flatMap((l) => current.get(l.key)?.verifierIds ?? [])])];
    assertDistinctPerson(user.id, excluded, 'Quatre yeux : la commission est validée par un superviseur distinct de l’agent bénéficiaire et des personnes qui ont vérifié ou décidé le constat.');
    const motif = input.motif.trim();
    const at = this.ctx.clock.now().toISOString();
    if (input.approve) {
      // Conditions d'attribution toujours réunies : ligne encore ACQUISE, pour le même agent et le même montant.
      const changed = r.lines.filter((l) => { const c = current.get(l.key); return !c || c.state !== 'ACQUISE' || c.commission.amount !== l.commission.amount || c.commission.currency !== l.commission.currency; });
      if (changed.length) {
        throw conflict('COMMISSION_LINE_CHANGED', `Commission modifiée depuis la demande (${changed.map((l) => l.reference).join(', ')}) : refusez cette demande ; l’agent en dépose une nouvelle.`);
      }
    }
    const out = this.requests.update({ ...r, excluded, status: input.approve ? 'VALIDEE' : 'REFUSEE', decision: { by: user.id, at, approve: input.approve, motif } });
    this.ctx.audit.append({
      actor: this.actor(user), action: input.approve ? 'agents.commission.validated' : 'agents.commission.validation_refused', resourceType: 'commission_validation', resourceId: id,
      details: { agentId: r.agentId, proposedBy: r.agentId, lines: r.lines.length, total: r.total, motif, payable: input.approve },
    });
    return out;
  }
}
