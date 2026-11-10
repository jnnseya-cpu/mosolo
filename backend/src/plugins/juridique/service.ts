/**
 * Registre des points juridiques (J1–J30, § 6.4, annexe B) et gouvernance des données (classification C1–C5, purge
 * par durée de conservation).
 *
 * Trancher un point : proposition motivée par un juriste (acte : référence + empreinte SHA-256) puis décision par une
 * AUTRE personne habilitée (circuit POINT_JURIDIQUE, garde de rotation). Purge : aperçu (simulation) → proposition
 * → approbation par une seconde personne (circuit PURGE_CONSERVATION) → exécution sur les seuls enregistrements
 * encore éligibles. Tout est journalisé ; rien n'est supprimé du journal ; aucune donnée financière, d'audit ou de
 * preuve n'est jamais purgée.
 */
import { runScheduledJob } from '../../core/jobs.js';
import type { PointJuridiqueStatut } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository, type Entity } from '../../core/repository.js';
import { discover, isAppendOnly } from '../../persistence/registry.js';
import { classer, purgeInterdite, type RegleConservation } from './classification.js';
import { ANNEXE_B_29, ANNEXE_B_FR2, FONCTIONS_CONDITIONNEES, POINTS_JURIDIQUES, SEPT_QUESTIONS_6_4, SOURCES_ANNEXE_A, type FonctionConditionnee, type PointJuridique } from './points.js';

export interface ActeReference { reference: string; titre: string; sha256: string }

export interface PointState {
  id: string; // code J…
  statut: PointJuridiqueStatut;
  proposition?: { acte: ActeReference; motif: string; proposedBy: string; proposedAt: string };
  decision?: { acte: ActeReference; motif: string; proposedBy: string; decidedBy: string; at: string };
  history: { at: string; by: string; action: string; motif: string; acte?: ActeReference }[];
}

export interface PurgeLigne { depot: string; parametre: string; dureeJours: number; statut: 'DUREE_NON_FIXEE' | 'ELIGIBLE' | 'RIEN_A_PURGER' | 'INTERDIT'; motif?: string; ids: string[]; champsEffaces: string[] }
export interface PurgeRequest {
  id: string;
  status: 'PROPOSEE' | 'EXECUTEE' | 'REJETEE';
  at: string;
  proposedBy: string;
  motif: string;
  apercu: { generatedAt: string; lignes: PurgeLigne[]; total: number };
  decision?: { by: string; at: string; motif: string; approve: boolean };
  execution?: { at: string; effaces: Record<string, number>; ignores: { depot: string; id: string; raison: string }[] };
}

export const EFFACE = '[EFFACÉ — conservation échue]';

export class JuridiqueService {
  readonly states = new InMemoryRepository<PointState>();
  readonly purges = new InMemoryRepository<PurgeRequest>();
  private readonly ids = new IdGenerator();
  private timer: NodeJS.Timeout | null = null;
  /** Dernier aperçu produit par la tâche planifiée (simulation seulement, jamais d'effacement). */
  lastScheduled: PurgeRequest['apercu'] | null = null;

  constructor(readonly ctx: AppContext) {}

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }
  private actor(u: User) {
    return { kind: 'user' as const, id: u.id, roles: u.roles };
  }

  /* ── Points juridiques ── */

  definition(code: string): PointJuridique {
    const p = POINTS_JURIDIQUES.find((x) => x.code === code.toUpperCase());
    if (!p) throw notFound('POINT_JURIDIQUE_INCONNU', `Point juridique inconnu : ${code}`);
    return p;
  }

  statut(code: string): PointJuridiqueStatut {
    return this.states.get(code.toUpperCase())?.statut ?? 'OUVERT';
  }

  view(p: PointJuridique) {
    const s = this.states.get(p.code);
    return {
      ...p, statut: s?.statut ?? 'OUVERT', decision: s?.decision ?? null, proposition: s?.proposition ?? null, history: s?.history ?? [],
      annexeB: ANNEXE_B_29.filter((a) => a.points.includes(p.code)).map((a) => a.point),
      septQuestions: SEPT_QUESTIONS_6_4.filter((q) => q.points.includes(p.code)).map((q) => q.rang),
      fonctions: (Object.keys(FONCTIONS_CONDITIONNEES) as FonctionConditionnee[]).filter((f) => (FONCTIONS_CONDITIONNEES[f].points as readonly string[]).includes(p.code)),
    };
  }

  register(user: User) {
    authorize(user, 'juridique:points.read');
    const points = POINTS_JURIDIQUES.map((p) => this.view(p));
    const tranche = (codes: string[]) => codes.every((c) => this.statut(c) === 'TRANCHE');
    return {
      points,
      septQuestions: SEPT_QUESTIONS_6_4.map((q) => ({ ...q, statut: tranche(q.points) ? 'TRANCHE' : 'OUVERT' })),
      annexeB: ANNEXE_B_29.map((a) => ({ ...a, statut: tranche(a.points) ? 'TRANCHE' : 'OUVERT' })),
      // Document maître FR 2 : annexe B (13 points) et annexe A (sources et fiabilité), rattachées au registre.
      annexeBFr2: ANNEXE_B_FR2.map((a) => ({ ...a, statut: tranche(a.points) ? 'TRANCHE' : 'OUVERT' })),
      annexeA: SOURCES_ANNEXE_A.map((a) => ({ ...a, instrumentsStatut: a.instruments.map((id) => ({ id, statut: this.ctx.rules.instrument(id)?.status ?? 'ABSENT' })) })),
      fonctions: (Object.keys(FONCTIONS_CONDITIONNEES) as FonctionConditionnee[]).map((f) => this.fonction(f)),
      summary: { total: points.length, ouverts: points.filter((p) => p.statut === 'OUVERT').length, tranches: points.filter((p) => p.statut === 'TRANCHE').length },
      note: 'Trancher un point exige un acte (référence et empreinte) proposé par un juriste puis décidé par une autre personne. Aucune fonction existante n’est désactivée par ce registre : chaque écran affiche ce qu’il attend.',
    };
  }

  fonction(f: FonctionConditionnee) {
    const def = FONCTIONS_CONDITIONNEES[f];
    const points = def.points.map((c) => ({ code: c, statut: this.statut(c), question: this.definition(c).question }));
    const enAttente = points.some((p) => p.statut !== 'TRANCHE');
    return {
      code: f, label: def.label, enAttente, points,
      message: enAttente ? `${def.attente} (${points.filter((p) => p.statut !== 'TRANCHE').map((p) => p.code).join(', ')}).` : 'Base légale tranchée.',
    };
  }

  proposeDecision(user: User, code: string, input: { acte: ActeReference; motif: string }): PointState {
    authorize(user, 'juridique:points.propose');
    const p = this.definition(code);
    const s = this.states.get(p.code);
    if (s?.statut === 'TRANCHE') throw conflict('POINT_DEJA_TRANCHE', `${p.code} est déjà tranché (${s.decision?.acte.reference ?? ''}).`);
    if (s?.proposition) throw conflict('PROPOSITION_EN_ATTENTE', `Une proposition attend déjà une décision pour ${p.code}.`);
    const at = this.now();
    const proposition = { acte: { ...input.acte, sha256: input.acte.sha256.toLowerCase() }, motif: input.motif.trim(), proposedBy: user.id, proposedAt: at };
    const next: PointState = {
      id: p.code, statut: 'OUVERT', proposition,
      history: [...(s?.history ?? []), { at, by: user.id, action: 'PROPOSITION', motif: proposition.motif, acte: proposition.acte }],
    };
    if (s) this.states.update(next); else this.states.insert(next);
    this.ctx.audit.append({ actor: this.actor(user), action: 'juridique.point.decision_proposed', resourceType: 'point_juridique', resourceId: p.code, details: { acte: proposition.acte, motif: proposition.motif } });
    return this.states.get(p.code)!;
  }

  decide(user: User, code: string, input: { approve: boolean; motif: string }): PointState {
    authorize(user, 'juridique:points.decide');
    const p = this.definition(code);
    const s = this.states.get(p.code);
    if (!s?.proposition) throw conflict('AUCUNE_PROPOSITION', `Aucune proposition en attente pour ${p.code}.`);
    const prop = s.proposition;
    try {
      assertDistinctPerson(user.id, [prop.proposedBy], 'Trancher un point juridique exige deux personnes : l’auteur de la proposition ne peut pas la décider.');
    } catch (e) {
      this.ctx.audit.append({ actor: this.actor(user), action: 'juridique.point.decision_refused', resourceType: 'point_juridique', resourceId: p.code, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    const at = this.now();
    const { proposition: _p, ...rest } = s;
    if (!input.approve) {
      this.states.update({ ...rest, history: [...s.history, { at, by: user.id, action: 'REJET', motif: input.motif.trim() }] });
      this.ctx.audit.append({ actor: this.actor(user), action: 'juridique.point.decision_rejected', resourceType: 'point_juridique', resourceId: p.code, details: { proposedBy: prop.proposedBy, motif: input.motif.trim() } });
      return this.states.get(p.code)!;
    }
    this.states.update({
      ...rest, statut: 'TRANCHE', decision: { acte: prop.acte, motif: input.motif.trim(), proposedBy: prop.proposedBy, decidedBy: user.id, at },
      history: [...s.history, { at, by: user.id, action: 'TRANCHE', motif: input.motif.trim(), acte: prop.acte }],
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'juridique.point.tranche', resourceType: 'point_juridique', resourceId: p.code, details: { acte: prop.acte, proposedBy: prop.proposedBy, motif: input.motif.trim() } });
    return this.states.get(p.code)!;
  }

  /* ── Classification et purge ── */

  classification(user: User) {
    authorize(user, 'juridique:donnees.read');
    const { repos } = discover(this.ctx);
    const depots = [...repos.entries()].map(([depot, repo]) => {
      const c = classer(depot);
      const refus = purgeInterdite(depot, c);
      return {
        depot, enregistrements: repo.count(), classe: c.classe, nature: c.nature, libelle: c.libelle, source: c.source,
        champs: 'champs' in c ? c.champs ?? {} : {}, conservation: 'conservation' in c ? c.conservation ?? null : null,
        purgeable: !refus && !isAppendOnly(repo), refusPurge: refus,
      };
    });
    depots.unshift({ depot: 'core.audit', enregistrements: this.ctx.audit.list({ limit: 1 }).total, classe: 'C5', nature: 'AUDIT', libelle: 'Journal d’audit chaîné (permanent, archives)', source: 'EXACT', champs: {}, conservation: null, purgeable: false, refusPurge: purgeInterdite('core.audit', { nature: 'AUDIT' }) });
    return {
      classes: { C1: 'Public', C2: 'Interne', C3: 'Personnel', C4: 'Personnel sensible / secret fiscal', C5: 'Secret (clés, preuves d’enquête, journal)' },
      depots, aClasser: depots.filter((d) => d.source === 'A_CLASSER').length,
      note: 'Classification par dépôt et par champ (ch. 32). Seuls les champs personnels des dépôts techniques porteurs d’une règle de conservation sont effacés à l’échéance ; jamais les données financières, d’audit ou de preuve.',
    };
  }

  private duree(parametre: string): number {
    const gouv = this.ctx.ext['integrite-gouvernance'] as { value(id: string): number | boolean } | undefined;
    try {
      const v = gouv?.value(parametre);
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  private eligibles(regle: RegleConservation, repo: InMemoryRepository<Entity>, dureeJours: number): string[] {
    const cutoff = this.ctx.clock.now().getTime() - dureeJours * 86_400_000;
    return repo.all().filter((r) => {
      // Conversion justifiée : purge générique de conservation, indépendante du type d'entité du dépôt (champs listés par la règle).
      const rec = r as unknown as Record<string, unknown>;
      if (rec.purgedAt) return false;
      if (regle.statutsExclus?.includes(String(rec.status ?? ''))) return false;
      const d = typeof rec[regle.champDate] === 'string' ? Date.parse(rec[regle.champDate] as string) : Number.NaN;
      return Number.isFinite(d) && d < cutoff;
    }).map((r) => r.id);
  }

  /** Aperçu (simulation) : ce qui serait effacé aujourd'hui, par dépôt. Aucun effet. */
  apercu(): PurgeRequest['apercu'] {
    const { repos } = discover(this.ctx);
    const lignes: PurgeLigne[] = [];
    for (const [depot, repo] of repos) {
      const c = classer(depot);
      if (!('conservation' in c) || !c.conservation) continue;
      const regle = c.conservation;
      const refus = purgeInterdite(depot, c) ?? (isAppendOnly(repo) ? 'Dépôt en ajout seul : jamais modifié.' : null);
      const dureeJours = this.duree(regle.parametre);
      if (refus) { lignes.push({ depot, parametre: regle.parametre, dureeJours, statut: 'INTERDIT', motif: refus, ids: [], champsEffaces: [] }); continue; }
      if (!dureeJours) { lignes.push({ depot, parametre: regle.parametre, dureeJours: 0, statut: 'DUREE_NON_FIXEE', motif: 'Durée de conservation non fixée (0) : à fixer par acte ; aucune purge.', ids: [], champsEffaces: regle.champsEffaces }); continue; }
      const ids = this.eligibles(regle, repo as InMemoryRepository<Entity>, dureeJours);
      lignes.push({ depot, parametre: regle.parametre, dureeJours, statut: ids.length ? 'ELIGIBLE' : 'RIEN_A_PURGER', ids, champsEffaces: regle.champsEffaces });
    }
    return { generatedAt: this.now(), lignes, total: lignes.reduce((a, l) => a + l.ids.length, 0) };
  }

  apercuAs(user: User): PurgeRequest['apercu'] {
    authorize(user, 'juridique:purge.propose');
    const a = this.apercu();
    this.ctx.audit.append({ actor: this.actor(user), action: 'privacy.purge.dry_run', resourceType: 'purge', resourceId: 'apercu', details: { total: a.total, depots: a.lignes.map((l) => `${l.depot}:${l.statut}:${l.ids.length}`) } });
    return a;
  }

  proposePurge(user: User, input: { motif: string }): PurgeRequest {
    authorize(user, 'juridique:purge.propose');
    if (this.purges.findOne((p) => p.status === 'PROPOSEE')) throw conflict('PURGE_EN_ATTENTE', 'Une proposition de purge attend déjà une décision.');
    const apercu = this.apercu();
    if (!apercu.total) throw unprocessable('RIEN_A_PURGER', 'Aucun enregistrement éligible (durées non fixées ou rien d’échu) : aucune proposition.');
    const r = this.purges.insert({ id: this.ids.next('PURGE'), status: 'PROPOSEE', at: this.now(), proposedBy: user.id, motif: input.motif.trim(), apercu });
    this.ctx.audit.append({ actor: this.actor(user), action: 'privacy.purge.proposed', resourceType: 'purge', resourceId: r.id, details: { total: apercu.total, motif: r.motif } });
    return r;
  }

  decidePurge(user: User, id: string, input: { approve: boolean; motif: string }): PurgeRequest {
    authorize(user, 'juridique:purge.decide');
    const r = this.purges.get(id);
    if (!r) throw notFound('PURGE_INCONNUE', `Proposition de purge inconnue : ${id}`);
    if (r.status !== 'PROPOSEE') throw conflict('PURGE_DEJA_DECIDEE', `Proposition au statut ${r.status}.`);
    assertDistinctPerson(user.id, [r.proposedBy], 'La purge exige deux personnes : l’auteur de la proposition ne peut pas l’approuver.');
    const at = this.now();
    const decision = { by: user.id, at, motif: input.motif.trim(), approve: input.approve };
    if (!input.approve) {
      const out = this.purges.update({ ...r, status: 'REJETEE', decision });
      this.ctx.audit.append({ actor: this.actor(user), action: 'privacy.purge.rejected', resourceType: 'purge', resourceId: id, details: { proposedBy: r.proposedBy, motif: decision.motif } });
      return out;
    }
    const execution = this.execute(r);
    const out = this.purges.update({ ...r, status: 'EXECUTEE', decision, execution });
    this.ctx.audit.append({ actor: this.actor(user), action: 'privacy.purge.executed', resourceType: 'purge', resourceId: id, details: { proposedBy: r.proposedBy, effaces: execution.effaces, ignores: execution.ignores.length } });
    return out;
  }

  /** Exécution : re-vérifie garde et éligibilité au moment de l'effacement ; efface les seuls champs listés. */
  private execute(r: PurgeRequest): NonNullable<PurgeRequest['execution']> {
    const { repos } = discover(this.ctx);
    const effaces: Record<string, number> = {};
    const ignores: { depot: string; id: string; raison: string }[] = [];
    for (const l of r.apercu.lignes) {
      if (l.statut !== 'ELIGIBLE') continue;
      const repo = repos.get(l.depot);
      const c = classer(l.depot);
      const refus = !repo ? 'Dépôt introuvable' : purgeInterdite(l.depot, c) ?? (isAppendOnly(repo) ? 'Dépôt en ajout seul' : null);
      if (refus || !repo || !('conservation' in c) || !c.conservation) { for (const id of l.ids) ignores.push({ depot: l.depot, id, raison: refus ?? 'Règle absente' }); continue; }
      const still = new Set(this.eligibles(c.conservation, repo as InMemoryRepository<Entity>, this.duree(c.conservation.parametre)));
      let n = 0;
      for (const id of l.ids) {
        if (!still.has(id)) { ignores.push({ depot: l.depot, id, raison: 'Plus éligible (durée modifiée ou enregistrement actif)' }); continue; }
        // Conversion justifiée : purge générique de conservation, indépendante du type d'entité du dépôt (champs listés par la règle).
        const rec = (repo as InMemoryRepository<Entity>).get(id) as unknown as Record<string, unknown>;
        const next: Record<string, unknown> = { ...rec, purgedAt: this.now(), purgeRequestId: r.id };
        for (const f of c.conservation.champsEffaces) {
          const v = rec[f];
          if (v === undefined) continue;
          next[f] = typeof v === 'string' ? EFFACE : typeof v === 'number' ? 0 : v && typeof v === 'object' ? {} : null;
        }
        // Conversion justifiée : purge générique de conservation, indépendante du type d'entité du dépôt (champs listés par la règle).
        (repo as InMemoryRepository<Entity>).update(next as unknown as Entity);
        n++;
      }
      effaces[l.depot] = n;
    }
    return { at: this.now(), effaces, ignores };
  }

  list(user: User) {
    authorize(user, 'juridique:donnees.read');
    return { items: this.purges.all().sort((a, b) => b.at.localeCompare(a.at)), lastScheduled: this.lastScheduled };
  }

  /** Tâche planifiée : aperçu seulement (journalisé) ; l'effacement exige toujours deux personnes. */
  runScheduled(): PurgeRequest['apercu'] {
    const a = this.apercu();
    this.lastScheduled = a;
    this.ctx.audit.append({ actor: { kind: 'system', id: 'purge-planifiee' }, action: 'privacy.purge.dry_run', resourceType: 'purge', resourceId: 'planifiee', details: { total: a.total } });
    return a;
  }

  startScheduler(ms: number): void {
    this.stopScheduler();
    this.timer = setInterval(() => { runScheduledJob(this.ctx, 'juridique.execution-planifiee', () => { this.runScheduled(); }); }, ms);
    this.timer.unref?.();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  assertActe(a: ActeReference): void {
    if (!/^[0-9a-f]{64}$/i.test(a.sha256)) throw badRequest('ACTE_EMPREINTE_INVALIDE', 'Empreinte SHA-256 de l’acte attendue (64 caractères hexadécimaux).');
  }
}
