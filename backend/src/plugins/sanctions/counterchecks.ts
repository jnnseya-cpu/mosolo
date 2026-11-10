/**
 * Contre-vérification aléatoire des constats retenus (stationnement, publicité) : un échantillon (5 % par défaut,
 * paramètre à valider par l'inspection des services) est mis en file pour un superviseur, qui revoit les preuves ou
 * retourne sur place et enregistre son résultat. Un résultat « infirmé » ouvre une alerte (examen humain) ; il n'annule
 * rien automatiquement : l'annulation éventuelle passe par le circuit de recours.
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { hmacSha256Hex } from '../../core/crypto.js';
import { conflict, forbidden, notFound } from '../../core/errors.js';
import { assertDistinctPerson } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';

/** Taux d'échantillonnage (pour dix mille) des constats retenus. */
export const COUNTER_CHECK_RATE_PER_10K = 500;

export interface CounterCheck {
  id: string;
  module: 'STATIONNEMENT' | 'PUBLICITE';
  caseId: string;
  reference: string;
  agentId: string;
  commune: string;
  /** Personnes déjà intervenues (constat, vérification, décision) : jamais contre-vérificatrices. */
  involved: string[];
  sampledAt: string;
  status: 'A_CONTRE_VERIFIER' | 'CONFIRME' | 'INFIRME';
  outcome?: { by: string; at: string; note: string };
}

/** Superviseurs et anti-fraude habilités à contre-vérifier (hors personnes intervenues sur le dossier). */
export const COUNTER_CHECK_ROLES = new Set(['R09', 'R22', 'R24']);

export class CounterChecks {
  readonly items = new InMemoryRepository<CounterCheck>();
  private readonly ids = new IdGenerator();
  /**
   * Tirage (0 ≤ n < 10 000) : HMAC du dossier sous une clé serveur (dérivée, séparée par domaine) — imprévisible pour
   * l'agent, mais reproductible (un même dossier donne toujours le même tirage) ; remplaçable dans les tests.
   */
  draw: (key: string) => number = (key) => Number.parseInt(hmacSha256Hex(this.ctx.secrets.auditHmacKey, `mosolo/contre-verification/v1|${key}`).slice(0, 8), 16) % 10_000;

  constructor(private readonly ctx: AppContext) {}

  /** Tirage au sort d'un constat retenu ; idempotent (un dossier n'est échantillonné qu'une fois). */
  maybeSample(input: Omit<CounterCheck, 'id' | 'sampledAt' | 'status' | 'outcome'>): CounterCheck | null {
    if (this.items.findOne((c) => c.module === input.module && c.caseId === input.caseId)) return null;
    if (this.draw(`${input.module}|${input.caseId}`) >= COUNTER_CHECK_RATE_PER_10K) return null;
    const cc = this.items.insert({ ...input, id: this.ids.next('CVX'), sampledAt: this.ctx.clock.now().toISOString(), status: 'A_CONTRE_VERIFIER' });
    this.ctx.audit.append({
      actor: { kind: 'system', id: 'contre-verification' }, action: 'agents.countercheck.sampled', resourceType: 'counter_check', resourceId: cc.id,
      details: { module: cc.module, caseId: cc.caseId, reference: cc.reference, agentId: cc.agentId },
    });
    return cc;
  }

  private assertRole(user: User) {
    if (!user.roles.some((r) => COUNTER_CHECK_ROLES.has(r))) throw forbidden('FORBIDDEN', 'Contre-vérification réservée aux superviseurs et à l’anti-fraude.');
  }

  /** File des contre-vérifications (un superviseur territorial ne voit que son périmètre). */
  list(user: User, status?: string): CounterCheck[] {
    this.assertRole(user);
    const scoped = !!user.territory?.length && !user.roles.some((r) => r === 'R22' || r === 'R24');
    return this.items.find((c) => (!status || c.status === status) && (!scoped || user.territory!.includes(c.commune))).sort((a, b) => b.sampledAt.localeCompare(a.sampledAt));
  }

  /** Résultat de la contre-vérification, par une personne non intervenue sur le dossier. */
  record(user: User, id: string, input: { outcome: 'CONFIRME' | 'INFIRME'; note: string }): CounterCheck {
    this.assertRole(user);
    const c = this.items.get(id);
    if (!c) throw notFound('COUNTER_CHECK_NOT_FOUND', `Contre-vérification inconnue : ${id}`);
    if (user.territory?.length && !user.roles.some((r) => r === 'R22' || r === 'R24') && !user.territory.includes(c.commune)) throw forbidden('FORBIDDEN', 'Hors de votre périmètre.');
    if (c.status !== 'A_CONTRE_VERIFIER') throw conflict('COUNTER_CHECK_DONE', `Contre-vérification déjà enregistrée (${c.status}).`);
    assertDistinctPerson(user.id, c.involved, 'La contre-vérification revient à une personne qui n’est pas intervenue sur le constat.');
    const at = this.ctx.clock.now().toISOString();
    const saved = this.items.update({ ...c, status: input.outcome, outcome: { by: user.id, at, note: input.note } });
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'agents.countercheck.recorded', resourceType: 'counter_check', resourceId: c.id,
      details: { outcome: input.outcome, module: c.module, caseId: c.caseId, agentId: c.agentId },
    });
    if (input.outcome === 'INFIRME') {
      this.ctx.alerts.raise({
        type: 'CONTRE_VERIFICATION_INFIRMEE', severity: 'MEDIUM', source: 'sanctions', actor: { kind: 'user', id: user.id, roles: user.roles },
        detail: `Constat ${c.reference} (${c.module}) infirmé à la contre-vérification — examen humain du dossier et des constats de l’agent ${c.agentId}.`,
        context: { counterCheckId: c.id, caseId: c.caseId, agentId: c.agentId },
      });
    }
    return saved;
  }
}
