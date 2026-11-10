/**
 * Domaine officiel de vérification (chapitre 18) : paramètre de plateforme détenu par la Ville. Le QR d'une vignette
 * sécurisée encode l'adresse COMPLÈTE de vérification sur ce domaine (jamais un tiers ni un raccourcisseur) ; la
 * vérification refuse ou signale tout QR pointant vers un autre domaine ; les anciens domaines sont conservés en
 * redirection pour une période fixée ; les domaines ressemblants sont surveillés (signalement, demande de retrait).
 * Toute modification du domaine est proposée par une personne et validée par une autre.
 */
import type { User } from '../../core/auth.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { InMemoryRepository } from '../../core/repository.js';
import type { VcDeps } from './common.js';

/** Domaine de démonstration [EXEMPLE] tant que la Ville n'a pas désigné le sien. */
export const DOMAINE_EXEMPLE = 'verification.exemple.cd';
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface OfficialDomain {
  host: string;
  ownedBy: string;
  status: 'EXEMPLE' | 'PROPOSE' | 'VALIDE';
  proposedBy?: string;
  proposedAt?: string;
  validatedBy?: string;
  validatedAt?: string;
  pending?: { host: string; ownedBy: string; proofRef: string; proposedBy: string; proposedAt: string };
}
export interface LegacyDomain { id: string; host: string; redirectUntil: string; reason: string; addedBy: string; addedAt: string }
export type WatchStatus = 'SIGNALE' | 'RETRAIT_DEMANDE' | 'RETIRE' | 'CLASSE';
export interface WatchedDomain { id: string; host: string; evidence: string; status: WatchStatus; reportedBy: string; reportedAt: string; history: { at: string; by: string; to: WatchStatus; note: string }[] }

export type HostCheck = { verdict: 'OFFICIEL' } | { verdict: 'ANCIEN_DOMAINE'; redirectUntil: string } | { verdict: 'DOMAINE_NON_OFFICIEL'; host: string };

export class DomaineService {
  domain: OfficialDomain = { host: DOMAINE_EXEMPLE, ownedBy: 'Ville-Province de Kinshasa [EXEMPLE — domaine à désigner]', status: 'EXEMPLE' };
  readonly legacy = new InMemoryRepository<LegacyDomain>();
  readonly watch = new InMemoryRepository<WatchedDomain>();

  constructor(private readonly d: VcDeps) {}

  /** Adresse complète de vérification encodée dans le QR (domaine officiel, chemin court, aucun paramètre de suivi). */
  verifyUrl(kind: 'ct' | 'centre', code: string): string {
    return `https://${this.domain.host}/v/${kind}/${encodeURIComponent(code)}`;
  }

  /** Contrôle d'un hôte présenté dans un QR. */
  checkHost(host: string): HostCheck {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (h === this.domain.host) return { verdict: 'OFFICIEL' };
    const today = this.d.today();
    const l = this.legacy.findOne((x) => x.host === h && x.redirectUntil >= today);
    if (l) return { verdict: 'ANCIEN_DOMAINE', redirectUntil: l.redirectUntil };
    return { verdict: 'DOMAINE_NON_OFFICIEL', host: h };
  }

  propose(user: User, input: { host: string; ownedBy: string; proofRef: string }) {
    authorize(user, 'domaine:propose');
    const host = input.host.trim().toLowerCase();
    if (!HOST_RE.test(host)) throw unprocessable('DOMAINE_INVALIDE', 'Nom de domaine invalide.');
    if (this.domain.pending) throw conflict('PROPOSITION_EN_ATTENTE', 'Une proposition de domaine est déjà en attente.');
    this.domain = { ...this.domain, pending: { host, ownedBy: input.ownedBy, proofRef: input.proofRef, proposedBy: user.id, proposedAt: this.d.now() } };
    this.d.audit(user, 'domaine.official.proposed', 'domaine_officiel', host, { ownedBy: input.ownedBy, proofRef: input.proofRef });
    return this.domain;
  }

  validate(user: User, input: { approve: boolean; motif: string; legacyRedirectUntil?: string }) {
    authorize(user, 'domaine:validate');
    const p = this.domain.pending;
    if (!p) throw notFound('AUCUNE_PROPOSITION', 'Aucune proposition de domaine en attente.');
    assertDistinctPerson(user.id, [p.proposedBy], 'Le domaine officiel est validé par une personne distincte de celle qui l’a proposé.');
    const previous = this.domain;
    if (!input.approve) {
      const { pending: _p, ...rest } = previous;
      this.domain = rest;
      this.d.audit(user, 'domaine.official.rejected', 'domaine_officiel', p.host, { proposedBy: p.proposedBy, motif: input.motif });
      return this.domain;
    }
    // L'ancien domaine (s'il n'était pas un exemple) est conservé en redirection pour la période fixée.
    if (previous.status === 'VALIDE' && input.legacyRedirectUntil) {
      this.legacy.insert({ id: this.d.ids.next('DOM-ANC', 3), host: previous.host, redirectUntil: input.legacyRedirectUntil, reason: `Remplacé par ${p.host}`, addedBy: user.id, addedAt: this.d.now() });
    }
    this.domain = { host: p.host, ownedBy: p.ownedBy, status: 'VALIDE', proposedBy: p.proposedBy, proposedAt: p.proposedAt, validatedBy: user.id, validatedAt: this.d.now() };
    this.d.audit(user, 'domaine.official.validated', 'domaine_officiel', p.host, { proposedBy: p.proposedBy, motif: input.motif, previous: previous.host });
    return this.domain;
  }

  addLegacy(user: User, input: { host: string; redirectUntil: string; reason: string }) {
    authorize(user, 'domaine:legacy');
    const host = input.host.trim().toLowerCase();
    if (!HOST_RE.test(host)) throw unprocessable('DOMAINE_INVALIDE', 'Nom de domaine invalide.');
    const l = this.legacy.insert({ id: this.d.ids.next('DOM-ANC', 3), host, redirectUntil: input.redirectUntil, reason: input.reason, addedBy: user.id, addedAt: this.d.now() });
    this.d.audit(user, 'domaine.legacy.added', 'domaine_ancien', l.id, { host, redirectUntil: input.redirectUntil });
    return l;
  }

  report(user: User, input: { host: string; evidence: string }) {
    authorize(user, 'domaine:watch');
    const host = input.host.trim().toLowerCase();
    if (host === this.domain.host) throw unprocessable('DOMAINE_OFFICIEL', 'Il s’agit du domaine officiel.');
    const w = this.watch.insert({ id: this.d.ids.next('DOM-VEI', 3), host, evidence: input.evidence, status: 'SIGNALE', reportedBy: user.id, reportedAt: this.d.now(), history: [{ at: this.d.now(), by: user.id, to: 'SIGNALE', note: input.evidence }] });
    this.d.ctx.alerts.raise({ type: 'DOMAINE_RESSEMBLANT', severity: 'HIGH', source: 'vehicules-controle', detail: `Domaine ressemblant signalé : ${host}.`, context: { host }, actor: { kind: 'user', id: user.id, roles: user.roles } });
    this.d.audit(user, 'domaine.lookalike.reported', 'domaine_surveille', w.id, { host });
    return w;
  }

  advance(user: User, id: string, input: { to: WatchStatus; note: string }) {
    authorize(user, 'domaine:takedown');
    const w = this.watch.get(id);
    if (!w) throw notFound('DOMAINE_INCONNU', `Signalement inconnu : ${id}`);
    const allowed: Record<WatchStatus, WatchStatus[]> = { SIGNALE: ['RETRAIT_DEMANDE', 'CLASSE'], RETRAIT_DEMANDE: ['RETIRE', 'CLASSE'], RETIRE: [], CLASSE: [] };
    if (!allowed[w.status].includes(input.to)) throw conflict('TRANSITION_INTERDITE', `${w.status} → ${input.to} non permis.`);
    const out = this.watch.update({ ...w, status: input.to, history: [...w.history, { at: this.d.now(), by: user.id, to: input.to, note: input.note }] });
    this.d.audit(user, 'domaine.lookalike.advanced', 'domaine_surveille', w.id, { to: input.to, note: input.note });
    return out;
  }

  view() {
    return { domain: this.domain, legacy: this.legacy.all(), watch: this.watch.all(), sampleQr: this.verifyUrl('ct', 'VTS-EXEMPLE') };
  }
}
