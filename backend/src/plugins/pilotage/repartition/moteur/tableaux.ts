/**
 * Tableaux de bord du moteur de répartition (§ 11, § 12, § 13 ; spécification v1.0, § 21 à § 24) — LECTURE SEULE.
 *
 *  - exécutif (Gouverneur, cabinet, secrétariat exécutif, ministre des Finances ; Trésor et audit pour l'exploitation)
 *    et Groupe Nseya (R38) : 100 % des recettes, chaque chiffre cliquable (« Expliquer ce chiffre ») ;
 *  - ministère / département : son seul périmètre (entité et sous-entités, departements.ts / acces) ;
 *  - Groupe Nseya : « Ma position commerciale » et « Contrôle financier de la ville » — agrégats complets, transactions
 *    PSEUDONYMISÉES ; un dossier individuel ne s'ouvre qu'avec un motif déclaré et journalisé (C42-05) ;
 *  - sous-traitant : son ombrelle (agents, recette, 7 % / 3 %, réglé, restant) ; agent : sa propre activité ;
 *  - super-administrateur : configuration et technique seulement (aucun montant, aucune mutation).
 * Chaque montant porte son état et sa date ; toute somme affichée est la somme des lignes du sous-grand-livre.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../../../context.js';
import type { User } from '../../../../core/auth.js';
import { kinshasaDate } from '../../../../core/clock.js';
import { forbidden, notFound } from '../../../../core/errors.js';
import { authorize } from '../../../../core/policy.js';
import { ETATS_DROIT, MODES_POOL, STATUTS_VERSION, TYPES_BENEFICIAIRE, type AllocationLine, type EtatDroit } from './model.js';
import { CONTRADICTIONS, MoteurRepartitionService, type Allocation, type Filtre, type Visibility } from './service.js';

type Rows = ReturnType<MoteurRepartitionService['rows']>;

/** Groupes de bénéficiaires cliquables du tableau exécutif. */
export const GROUPES = {
  TOTAL: 'Recette éligible rapprochée (100 %)',
  GOUVERNORAT: 'Gouvernorat de Kinshasa',
  GROUPE_NSEYA: 'Groupe Nseya',
  MINISTERES: 'Ministères et départements responsables des modules',
  AGENTS: 'Agents de terrain',
  SOUS_TRAITANTS: 'Sous-traitants',
  RESERVE_POOL: 'Réserve du pool des opérations de terrain (non attribuée ou par points × qualité)',
} as const;
export type Groupe = keyof typeof GROUPES;

export function matchGroup(key: string): (b: string, l: AllocationLine) => boolean {
  switch (key) {
    case 'TOTAL': return () => true;
    case 'GOUVERNORAT': return (b) => b === 'GOUVERNORAT';
    case 'GROUPE_NSEYA': return (b) => b === 'GROUPE_NSEYA';
    case 'MINISTERES': return (_b, l) => l.kind === 'TUTELLE';
    case 'AGENTS': return (_b, l) => l.kind === 'AGENT';
    case 'SOUS_TRAITANTS': return (_b, l) => l.kind === 'SOUS_TRAITANT';
    case 'RESERVE_POOL': return (b) => b.startsWith('POOL:');
    default: return (b) => b === key;
  }
}

const today = (svc: MoteurRepartitionService) => kinshasaDate(svc.ctx.clock.now());

export class TableauxMoteur {
  private readonly ctx: AppContext;
  private readonly salt = randomBytes(16);
  constructor(private readonly svc: MoteurRepartitionService) { this.ctx = svc.ctx; }

  private defaultMode(f: Filtre): 'REEL' | 'SIMULATION' {
    if (f.mode) return f.mode;
    return this.svc.allocations.all().some((a) => a.mode === 'REEL') ? 'REEL' : 'SIMULATION';
  }

  private currencies(rows: Rows): CurrencyCode[] {
    return [...new Set(rows.map((r) => r.a.base.currency))].sort();
  }

  private stamp(mode: 'REEL' | 'SIMULATION') {
    return {
      mode, asOf: today(this.svc),
      etat: mode === 'REEL' ? 'Droits réels (version de règle ACTIVE)' : 'SIMULATION — règle non active (acte requis) : aucun droit exigible, montants non contractuels',
    };
  }

  private groupCard(rows: Rows, key: Groupe, cur: CurrencyCode, extra: Record<string, unknown> = {}) {
    const g = rows.filter((r) => matchGroup(key)(r.l.beneficiary, r.l));
    const fig = this.svc.figures(g, cur);
    return { code: key, label: GROUPES[key], ...fig, montant: key === 'TOTAL' ? fig.recettesEligibles : fig.droit, expliquer: `beneficiaire=${key}&currency=${cur}`, ...extra };
  }

  private breakdown(rows: Rows, cur: CurrencyCode, keyOf: (a: Allocation, l: AllocationLine) => string | null, labelOf?: (k: string) => string) {
    const m = new Map<string, Rows>();
    for (const r of rows) {
      if (r.a.base.currency !== cur) continue;
      const k = keyOf(r.a, r.l);
      if (k === null) continue;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => {
      const fig = this.svc.figures(rs, cur);
      return { key: k, label: labelOf ? labelOf(k) : k, droit: fig.droit, recettesEligibles: fig.recettesEligibles, regle: fig.regle, resteDu: fig.resteDu, transactions: fig.transactions };
    });
  }

  /** Recettes confirmées ou réglées mais pas encore rapprochées (§ 21 : « non rapproché ») — hors assiette. */
  private nonRapproche(cur: CurrencyCode, f: Filtre): MoneyJSON {
    return this.ctx.payments.orders.all().filter((o) => (o.status === 'CONFIRME' || o.status === 'REGLE') && !o.reconciledAt && o.amount.currency === cur
      && (!f.period || kinshasaDate(new Date(o.confirmedAt ?? '1970-01-01')).startsWith(f.period)))
      .reduce((m, o) => m.add(Money.fromJSON(o.amount)), Money.zero(cur)).toJSON();
  }

  /** Centre de commandement financier exécutif (§ 21) — chaque carte cliquable. */
  executif(user: User, f: Filtre) {
    const vis = this.svc.visibility(user);
    if (vis.kind !== 'EXECUTIF' && vis.kind !== 'GROUPE_NSEYA') authorize(user, 'moteur:executif.read');
    this.svc.sync();
    const mode = this.defaultMode(f);
    const rows = this.svc.rows(vis, { ...f, mode });
    const v = this.svc.currentVersion();
    this.audit(user, 'moteur.tableau.executif.consulte', { mode, filtre: f });
    return {
      generatedAt: new Date(this.ctx.clock.now()).toISOString(), ...this.stamp(mode),
      version: { id: v.id, status: v.status, statusLabel: STATUTS_VERSION[v.status], poolMode: v.pool.mode, poolModeLabel: MODES_POOL[v.pool.mode], beneficiaries: v.beneficiaries },
      parDevise: this.currencies(rows).map((cur) => {
        const total = this.groupCard(rows, 'TOTAL', cur);
        const groupes = (['GOUVERNORAT', 'GROUPE_NSEYA', 'MINISTERES', 'AGENTS', 'SOUS_TRAITANTS', 'RESERVE_POOL'] as Groupe[]).map((k) => this.groupCard(rows, k, cur));
        const somme = groupes.reduce((m, g) => m.add(Money.fromJSON(g.droit)), Money.zero(cur));
        const gouv = Money.fromJSON(groupes[0]!.droit);
        return {
          currency: cur,
          cartes: [
            total,
            { code: 'ELECTRONIQUE', label: 'Recette électronique', montant: this.svc.figures(rows.filter((r) => r.a.methode === 'ELECTRONIQUE' && matchGroup('TOTAL')(r.l.beneficiary, r.l)), cur).recettesEligibles, expliquer: `beneficiaire=TOTAL&methode=ELECTRONIQUE&currency=${cur}` },
            { code: 'ESPECES', label: 'Recette en espèces (points agréés et guichets)', montant: this.svc.figures(rows.filter((r) => r.a.methode === 'ESPECES'), cur).recettesEligibles, expliquer: `beneficiaire=TOTAL&methode=ESPECES&currency=${cur}` },
            { code: 'NON_RAPPROCHE', label: 'Confirmé, non encore rapproché (hors assiette)', montant: this.nonRapproche(cur, f), expliquer: null },
          ],
          groupes,
          controle: { sommeDesParts: somme.toJSON(), recetteEligible: total.recettesEligibles, egal: somme.equals(Money.fromJSON(total.recettesEligibles)) },
          parEntite: this.breakdown(rows.filter((r) => r.l.kind === 'TUTELLE'), cur, (a) => a.entity, (k) => this.svc.allocations.all().find((a) => a.entity === k)?.entityLabel ?? k),
          parModule: this.breakdown(rows, cur, (a) => a.module ?? a.ruleCode, (k) => this.svc.allocations.all().find((a) => (a.module ?? a.ruleCode) === k)?.moduleLabel ?? k),
          parMethode: this.breakdown(rows, cur, (a) => a.methode),
          parMois: this.breakdown(rows, cur, (a) => kinshasaDate(new Date(a.paidAt)).slice(0, 7)),
          coutsTechnologiques: this.svc.positionNette(gouv, f.period),
        };
      }),
      contradictions: CONTRADICTIONS,
    };
  }

  /** Tableau d'une entité (ministère, département) : son seul périmètre (§ 11 ; spécification v1.0, § 6). */
  entite(user: User, f: Filtre) {
    authorize(user, 'moteur:entite.read');
    const vis = this.svc.visibility(user);
    const scoped: Visibility = vis.kind === 'EXECUTIF' || vis.kind === 'GROUPE_NSEYA'
      ? { kind: 'ENTITE', entities: new Set([f.entity ?? user.entity]) }
      : vis.kind === 'ENTITE' ? vis : { kind: 'AUCUNE' };
    if (scoped.kind !== 'ENTITE') throw forbidden('HORS_PERIMETRE', 'Tableau d’entité : périmètre de votre entité seulement.');
    if (vis.kind === 'ENTITE' && f.entity && !vis.entities.has(f.entity)) throw forbidden('HORS_PERIMETRE', 'Un ministère ne voit pas les données financières d’un autre ministère.');
    this.svc.sync();
    const mode = this.defaultMode(f);
    const { entity: _e, ...rest } = f;
    const rows = this.svc.rows(scoped, { ...rest, mode });
    return {
      ...this.stamp(mode), entity: user.entity, perimetre: [...scoped.entities].sort(),
      parDevise: this.currencies(rows).map((cur) => ({
        currency: cur,
        droit: { ...this.svc.figures(rows, cur), expliquer: `beneficiaire=MINISTERES&currency=${cur}` },
        parEntite: this.breakdown(rows, cur, (_a, l) => l.beneficiary),
        parModule: this.breakdown(rows, cur, (a) => a.module ?? a.ruleCode),
        parCommune: this.breakdown(rows, cur, (a) => a.commune ?? 'Non attribuée'),
        parMethode: this.breakdown(rows, cur, (a) => a.methode),
        parMois: this.breakdown(rows, cur, (a) => kinshasaDate(new Date(a.paidAt)).slice(0, 7)),
      })),
      note: 'Périmètre : votre entité et ses sous-entités. Un ministère ne voit pas les données financières d’un autre ministère.',
    };
  }

  /** Centre de commandement Groupe Nseya (§ 22) : « Ma position commerciale » et « Contrôle financier de la ville ». */
  groupeNseya(user: User, f: Filtre) {
    const vis = this.svc.visibility(user);
    if (vis.kind !== 'GROUPE_NSEYA' && vis.kind !== 'EXECUTIF') authorize(user, 'moteur:nseya.read');
    this.svc.sync();
    const mode = this.defaultMode(f);
    const rows = this.svc.rows({ kind: 'GROUPE_NSEYA' }, { ...f, mode });
    const mine = rows.filter((r) => r.l.beneficiary === 'GROUPE_NSEYA');
    const demandes = this.svc.demandes.find((d) => d.beneficiary === 'GROUPE_NSEYA');
    this.audit(user, 'moteur.tableau.groupe_nseya.consulte', { mode, filtre: f });
    return {
      ...this.stamp(mode),
      positionCommerciale: this.currencies(rows).map((cur) => {
        const fig = this.svc.figures(mine, cur);
        const costs = this.svc.positionNette(Money.zero(cur), f.period);
        return {
          ...fig, expliquer: `beneficiaire=GROUPE_NSEYA&currency=${cur}`,
          enAttenteApprobation: demandes.filter((d) => d.currency === cur && ['SOUMISE', 'EN_EXAMEN'].includes(d.status)).reduce((m, d) => m.add(Money.fromJSON(d.amount)), Money.zero(cur)).toJSON(),
          remboursementsTechnologiques: costs.coutsFinancesParNseya, fraisGestion: costs.fraisGestion, detteServices: costs.detteServicesNseya,
          especesPayables: this.svc.figures(mine.filter((r) => r.a.methode === 'ESPECES'), cur).payable,
          demandes: demandes.filter((d) => d.currency === cur).map((d) => ({ id: d.id, status: d.status, amount: d.amount, createdAt: d.createdAt })),
        };
      }),
      controleVille: this.executifLike(rows, f),
      confidentialite: 'Agrégats complets ; transactions pseudonymisées. Un dossier individuel ne s’ouvre qu’avec un motif déclaré, journalisé (consultation motivée, C42-05).',
    };
  }

  private executifLike(rows: Rows, f: Filtre) {
    return this.currencies(rows).map((cur) => ({
      currency: cur,
      groupes: (['TOTAL', 'GOUVERNORAT', 'GROUPE_NSEYA', 'MINISTERES', 'AGENTS', 'SOUS_TRAITANTS', 'RESERVE_POOL'] as Groupe[]).map((k) => this.groupCard(rows, k, cur)),
      parEntite: this.breakdown(rows.filter((r) => r.l.kind === 'TUTELLE'), cur, (a) => a.entity),
      parModule: this.breakdown(rows, cur, (a) => a.module ?? a.ruleCode),
      parAgent: this.breakdown(rows.filter((r) => r.l.kind === 'AGENT'), cur, (a) => a.agentId),
      parSousTraitant: this.breakdown(rows.filter((r) => r.l.kind === 'SOUS_TRAITANT'), cur, (a) => a.subcontractorId),
      nonRapproche: this.nonRapproche(cur, f),
    }));
  }

  /** Tableau du sous-traitant (§ 10 ; spécification v1.0, § 24) : son ombrelle, par agent puis transactions. */
  sousTraitant(user: User, f: Filtre) {
    authorize(user, 'moteur:sous-traitant.read');
    const vis = this.svc.visibility(user);
    if (vis.kind !== 'SOUS_TRAITANT') throw forbidden('HORS_PERIMETRE', 'Tableau réservé au sous-traitant pour son ombrelle.');
    this.svc.sync();
    const mode = this.defaultMode(f);
    const rows = this.svc.rows(vis, { ...f, mode });
    const reserve = (this.ctx.ext.sanctions as { reserve?: { forSubcontractor(id: string, m?: string): unknown } } | undefined)?.reserve;
    return {
      ...this.stamp(mode), subcontractorIds: vis.subcontractorIds,
      parRecette: this.currencies(rows).map((cur) => {
        const agents = rows.filter((r) => r.l.kind === 'AGENT');
        const own = rows.filter((r) => r.l.kind === 'SOUS_TRAITANT');
        const base = this.svc.figures(rows, cur).recettesEligibles;
        return {
          currency: cur, recetteGeneree: base, agents: this.svc.figures(agents, cur), monDroit: { ...this.svc.figures(own, cur), expliquer: `beneficiaire=SOUS_TRAITANTS&currency=${cur}` },
          parAgent: [...new Set(agents.map((r) => r.a.agentId!))].sort().map((id) => {
            const ra = rows.filter((r) => r.a.agentId === id);
            return {
              agentId: id, transactions: new Set(ra.map((r) => r.a.id)).size, recette: this.svc.figures(ra, cur).recettesEligibles,
              agent: this.svc.figures(ra.filter((r) => r.l.kind === 'AGENT'), cur).droit, sousTraitant: this.svc.figures(ra.filter((r) => r.l.kind === 'SOUS_TRAITANT'), cur).droit,
            };
          }),
        };
      }),
      parPointsQualite: reserve ? vis.subcontractorIds.map((id) => ({ subcontractorId: id, reserve: reserve.forSubcontractor(id, f.period && f.period.length === 7 ? f.period : undefined) })) : [],
      note: 'Mode par recette générée (décision du 29/09/2026) : agent 7 %, sous-traitant 3 % de la recette éligible rapprochée ; la vue par points × qualité (décision du 27/09/2026) reste affichée.',
    };
  }

  /** Tableau de l'agent : sa seule activité (un agent ne voit jamais le compte d'un autre). */
  agent(user: User, f: Filtre) {
    authorize(user, 'moteur:agent.read');
    const vis = this.svc.visibility(user);
    if (vis.kind !== 'AGENT') throw forbidden('HORS_PERIMETRE', 'Tableau réservé à l’agent pour sa propre activité.');
    this.svc.sync();
    const mode = this.defaultMode(f);
    const rows = this.svc.rows(vis, { ...f, mode });
    const reserve = (this.ctx.ext.sanctions as { reserve?: { mine(u: User, m?: string): unknown } } | undefined)?.reserve;
    return {
      ...this.stamp(mode), agentId: user.id, profil: this.svc.agentProfile(user.id),
      parDevise: this.currencies(rows).map((cur) => ({
        ...this.svc.figures(rows, cur), expliquer: `beneficiaire=AGENT:${user.id}&currency=${cur}`,
        parModule: this.breakdown(rows, cur, (a) => a.module ?? a.ruleCode), parJour: this.breakdown(rows, cur, (a) => kinshasaDate(new Date(a.paidAt))),
      })),
      parPointsQualite: reserve ? (() => { try { return reserve.mine(user, f.period && f.period.length === 7 ? f.period : undefined); } catch { return null; } })() : null,
    };
  }

  // ————————————————————————————————————————— « Expliquer ce chiffre » (§ 13 ; spécification v1.0, § 23)

  private assertCanExplain(vis: Visibility, key: string) {
    if (vis.kind === 'AUCUNE') throw forbidden('HORS_PERIMETRE', 'Aucune visibilité financière pour ce compte.');
    if (vis.kind === 'EXECUTIF' || vis.kind === 'GROUPE_NSEYA') return;
    if (key in GROUPES) return; // agrégat restreint au périmètre par rows()
    if (!this.svc.canSeeBeneficiary(vis, key)) throw forbidden('HORS_PERIMETRE', 'Chiffre hors de votre périmètre.');
  }

  expliquer(user: User, key: string, f: Filtre) {
    const vis = this.svc.visibility(user);
    this.assertCanExplain(vis, key);
    this.svc.sync();
    const mode = this.defaultMode(f);
    const rows = this.svc.rows(vis, { ...f, mode }, matchGroup(key));
    const label = (GROUPES as Record<string, string>)[key] ?? key;
    return {
      beneficiaire: key, label, ...this.stamp(mode), filtre: f,
      parDevise: this.currencies(rows).map((cur) => {
        const rs = rows.filter((r) => r.a.base.currency === cur);
        const fig = this.svc.figures(rs, cur);
        const byVersion = new Map<string, { pct: Set<string>; base: Money; droit: Money }>();
        for (const r of rs) {
          const v = this.svc.versions.get(r.a.versionId);
          const pct = key === 'TOTAL' ? '100' : v?.beneficiaries.find((b) => b.code === r.l.slice)?.pct ?? r.l.pct;
          const e = byVersion.get(r.a.versionId) ?? { pct: new Set<string>(), base: Money.zero(cur), droit: Money.zero(cur) };
          e.pct.add(key === 'TOTAL' ? '100' : r.l.kind === 'AGENT' || r.l.kind === 'SOUS_TRAITANT' ? r.l.pct : pct);
          if (!r.cp) e.droit = e.droit.add(Money.fromJSON(r.l.amount));
          byVersion.set(r.a.versionId, e);
        }
        const seen = new Set<string>();
        for (const r of rs) {
          if (seen.has(r.a.id) || r.cp) continue;
          seen.add(r.a.id);
          const e = byVersion.get(r.a.versionId)!;
          e.base = e.base.add(Money.fromJSON(r.a.base));
        }
        const taux = [...byVersion.entries()].map(([versionId, e]) => ({ versionId, pct: [...e.pct].sort(), recetteEligible: e.base.toJSON(), droit: e.droit.toJSON() }));
        const exact = taux.reduce((m, t) => (t.pct.length === 1 ? m.add(Money.fromJSON(t.recetteEligible).percent(t.pct[0]!, 'DOWN')) : m.add(Money.fromJSON(t.droit))), Money.zero(cur));
        const sumLines = rs.filter((r) => !r.cp).reduce((m, r) => m.add(Money.fromJSON(r.l.amount)), Money.zero(cur));
        const dim = (k: (a: Allocation, l: AllocationLine) => string | null) => this.breakdown(rs, cur, k);
        return {
          currency: cur,
          recetteEligible: fig.recettesEligibles, taux, droitCalcule: fig.droit,
          formule: key === 'TOTAL' ? 'Recette éligible = paiements rapprochés − remboursements − contrepassations (jamais liquidé, déclaré ni initié).' : 'Recette éligible × taux = droit ; chaque part est tronquée au centime, les arrondis vont au Gouvernorat (solde).',
          arrondis: Money.fromJSON(fig.droit).subtract(exact).toJSON(),
          electronique: fig.electronique, especes: fig.especes,
          etats: { regle: fig.regle, approuve: fig.approuve, enAttente: fig.enAttente, conteste: fig.conteste, recouvrable: fig.recouvrable, payable: fig.payable, enRetard: fig.enRetard, contrepasse: fig.contrepasse },
          transactions: fig.transactions,
          controle: { sommeDesLignes: sumLines.toJSON(), egalAuDroit: sumLines.equals(Money.fromJSON(fig.droit)), electroniquePlusEspeces: Money.fromJSON(fig.electronique).add(Money.fromJSON(fig.especes)).equals(Money.fromJSON(fig.droit)) },
          par: {
            methode: dim((a) => a.methode), entite: dim((a) => a.entity), module: dim((a) => a.module ?? a.ruleCode), commune: dim((a) => a.commune ?? 'Non attribuée'),
            agent: dim((a) => a.agentId), sousTraitant: dim((a) => a.subcontractorId), jour: dim((a) => kinshasaDate(new Date(a.paidAt))), mois: dim((a) => kinshasaDate(new Date(a.paidAt)).slice(0, 7)),
            etat: this.byState(rs, cur),
          },
          voirTransactions: `/v1/pilotage/moteur-repartition/transactions?beneficiaire=${encodeURIComponent(key)}&currency=${cur}&mode=${mode}${f.period ? `&period=${f.period}` : ''}${f.methode ? `&methode=${f.methode}` : ''}`,
        };
      }),
    };
  }

  private byState(rs: Rows, cur: CurrencyCode) {
    const m = new Map<EtatDroit, Money>();
    for (const r of rs) m.set(r.state, (m.get(r.state) ?? Money.zero(cur)).add(Money.fromJSON(r.l.amount)));
    return [...m.entries()].map(([k, v]) => ({ key: k, label: ETATS_DROIT[k], montant: v.toJSON() }));
  }

  /** Transactions sources d'un chiffre (pseudonymisées sauf habilitation ou motif déclaré et journalisé). */
  transactions(user: User, key: string, f: Filtre, opts: { limit?: number; offset?: number; motif?: string }) {
    const vis = this.svc.visibility(user);
    this.assertCanExplain(vis, key);
    this.svc.sync();
    const mode = this.defaultMode(f);
    const rows = this.svc.rows(vis, { ...f, mode }, matchGroup(key)).sort((a, b) => b.a.paidAt.localeCompare(a.a.paidAt) || a.a.id.localeCompare(b.a.id));
    const personal = this.personalAccess(user, vis, opts.motif, { key, filtre: f });
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const totals = this.currencies(rows).map((cur) => ({ currency: cur, droit: this.svc.figures(rows, cur).droit, lignes: rows.filter((r) => r.a.base.currency === cur).length }));
    return {
      beneficiaire: key, ...this.stamp(mode), total: rows.length, offset, limit, totals, donneesPersonnelles: personal ? 'VISIBLES' : 'PSEUDONYMISEES',
      items: rows.slice(offset, offset + limit).map((r) => ({
        allocationId: r.a.id, date: r.a.paidAt, reconciledAt: r.a.reconciledAt, module: r.a.module, moduleLabel: r.a.moduleLabel, entity: r.a.entity, methode: r.a.methode, canal: r.a.channel,
        commune: r.a.commune, versionId: r.a.versionId, mode: r.a.mode, recette: r.a.base, beneficiaire: r.l.beneficiary, beneficiaryType: r.l.beneficiaryType, typeLabel: TYPES_BENEFICIAIRE[r.l.beneficiaryType],
        pct: r.l.pct, montant: r.cp ? Money.fromJSON(r.l.amount).negate().toJSON() : r.l.amount, montantInitial: r.l.amount, contrepasse: !!r.cp, etat: r.state, etatLabel: ETATS_DROIT[r.state], regle: r.settled.toJSON(),
        ...(personal ? { paymentReference: r.a.paymentReference, taxpayerId: r.a.taxpayerId, obligationId: r.a.obligationId } : { transaction: this.pseudo(r.a.orderId) }),
      })),
    };
  }

  /**
   * Données personnelles d'un contribuable : visibles pour les rôles déjà habilités à la lecture fiscale ; pour Groupe
   * Nseya (R38) et l'exécutif, seulement avec un MOTIF déclaré — chaque consultation est journalisée (C42-05).
   */
  private personalAccess(user: User, vis: Visibility, motif: string | undefined, ctx: Record<string, unknown>): boolean {
    if (vis.kind === 'EXECUTIF' && vis.personal) return true;
    if ((vis.kind === 'GROUPE_NSEYA' || vis.kind === 'EXECUTIF') && motif && motif.trim().length >= 10) {
      this.audit(user, 'moteur.donnees_personnelles.consultees', { motif: motif.trim(), motifDeclare: true, ...ctx });
      return true;
    }
    return false;
  }

  /** Descente jusqu'à la transaction : paiement → quittance → répartition → écritures → règlement → circuit espèces. */
  transaction(user: User, allocationId: string, opts: { motif?: string }) {
    const vis = this.svc.visibility(user);
    if (vis.kind === 'AUCUNE') throw forbidden('HORS_PERIMETRE', 'Aucune visibilité financière pour ce compte.');
    this.svc.sync();
    const a = this.svc.allocations.get(allocationId);
    if (!a) throw notFound('TRANSACTION_INCONNUE', `Transaction inconnue : ${allocationId}`);
    const visible = this.svc.rows(vis, {}, undefined).filter((r) => r.a.id === a.id);
    if (!visible.length) throw forbidden('HORS_PERIMETRE', 'Transaction hors de votre périmètre.');
    const personal = this.personalAccess(user, vis, opts.motif, { allocationId });
    const cp = this.svc.contrepassations.get(`CP-${a.orderId}`);
    const receipt = this.ctx.receipts.byPaymentOrder(a.orderId);
    const lines = visible.map((r) => ({ ...r.l, etat: r.state, etatLabel: ETATS_DROIT[r.state], regle: r.settled.toJSON(), chemin: this.svc.settlementPath(a, r.l) }));
    const sum = lines.reduce((m, l) => m.add(Money.fromJSON(l.amount)), Money.zero(a.base.currency));
    return {
      transaction: {
        allocationId: a.id, date: a.paidAt, reconciledAt: a.reconciledAt, methode: a.methode, canal: a.channel, provider: a.provider, commune: a.commune, montant: a.base,
        module: a.module, moduleLabel: a.moduleLabel, ruleCode: a.ruleCode, revenueType: a.revenueCategory, entity: a.entity, entityLabel: a.entityLabel, rattachement: a.entityBasis,
        agentId: vis.kind === 'AGENT' && a.agentId !== vis.agentId ? null : a.agentId, agentType: a.agentType, subcontractorId: a.subcontractorId,
        versionId: a.versionId, mode: a.mode, avantEffet: !!a.avantEffet, blocked: a.blocked ?? null,
        ...(personal ? { paymentReference: a.paymentReference, taxpayerId: a.taxpayerId, obligationId: a.obligationId } : { transaction: this.pseudo(a.orderId) }),
      },
      quittance: receipt ? { number: receipt.number, status: receipt.status } : null,
      repartition: { lignes: lines, somme: sum.toJSON(), complete: vis.kind === 'EXECUTIF' || vis.kind === 'GROUPE_NSEYA', egalRecette: vis.kind === 'EXECUTIF' || vis.kind === 'GROUPE_NSEYA' ? sum.equals(Money.fromJSON(a.base)) : null },
      contrepassation: cp ? { id: cp.id, cause: cp.cause, lignes: cp.lines.filter((l) => visible.some((r) => r.l.beneficiary === l.beneficiary)), recouvrable: cp.recoverable, at: cp.createdAt } : null,
      ecritures: vis.kind === 'EXECUTIF' || vis.kind === 'GROUPE_NSEYA' ? this.svc.ecritures.find((e) => e.allocationId === a.id) : [],
      demandes: this.svc.demandes.find((d) => d.items.some((i) => i.allocationId === a.id) && visible.some((r) => r.l.beneficiary === d.beneficiary)).map((d) => ({ id: d.id, status: d.status, beneficiary: d.beneficiary })),
      circuitEspeces: a.methode === 'ESPECES' ? this.cashCircuit(a) : null,
    };
  }

  /** Circuit des espèces (§ 6 ; spécification v1.0, § 13) : point agréé → déclaration → vérification → dépôt → rapprochement. */
  cashCircuit(a: Allocation) {
    const canaux = this.ctx.ext.canaux as { points?: { collections: { findOne(p: (c: { paymentOrderId: string }) => boolean): { id: string; pointId: string; collectedAt: string; cashDay: string } | undefined }; cashDays: { findOne(p: (c: { pointId: string; day: string }) => boolean): { status: string; closedAt?: string; deposit?: { declaredAt: string; bankSlipRef: string; bankMatch?: { approvedAt?: string; auto?: true } } } | undefined } } } | undefined;
    const c = canaux?.points?.collections.findOne((x) => x.paymentOrderId === a.orderId);
    const day = c ? canaux!.points!.cashDays.findOne((x) => x.pointId === c.pointId && x.day === c.cashDay) : undefined;
    const d = this.svc.demandes.find((x) => x.beneficiary === 'GROUPE_NSEYA' && x.items.some((i) => i.allocationId === a.id))[0];
    const step = (code: string, label: string, at: string | null | undefined, detail?: string) => ({ code, label, fait: !!at, at: at ?? null, ...(detail ? { detail } : {}) });
    return [
      step('ENCAISSEMENT', 'Encaissement au point agréé (jamais par un agent de terrain)', c?.collectedAt, c ? `Point ${c.pointId}` : 'Encaissement non retrouvé au registre des points'),
      step('DECLARATION', 'Déclaration d’espèces (clôture de caisse)', day?.closedAt),
      step('DEPOT', 'Dépôt bancaire au compte public', day?.deposit?.declaredAt, day?.deposit?.bankSlipRef),
      step('VERIFICATION_DEPOT', 'Vérification du dépôt (relevé bancaire, quatre yeux)', day?.deposit?.bankMatch?.approvedAt ?? (day?.deposit?.bankMatch?.auto ? day.deposit.declaredAt : null)),
      step('RAPPROCHEMENT', 'Rapprochement', a.reconciledAt),
      step('REPARTITION', 'Répartition (droits constatés)', a.createdAt),
      step('PAYABLE_NSEYA', 'Droit de Groupe Nseya PAYABLE (jamais présenté comme réglé)', a.mode === 'REEL' ? a.createdAt : null),
      step('DEMANDE', 'Demande de règlement', d?.createdAt),
      step('APPROBATION', 'Approbation du Gouvernement', d?.approval?.approve ? d.approval.at : null),
      step('PAIEMENT', 'Paiement (Flux 1)', d?.payment?.at),
      step('RAPPROCHEMENT_REGLEMENT', 'Rapprochement du règlement', d?.reconciliation?.at),
    ];
  }

  /** Vue technique du super-administrateur : configuration seulement, AUCUN montant, AUCUNE mutation financière. */
  configuration(user: User) {
    authorize(user, 'moteur:config.read');
    const versions = this.svc.listVersions(user);
    return {
      mutationFinanciere: 'AUCUNE',
      versions: versions.items.map((v) => ({ id: v.id, version: v.version, status: v.status, statusLabel: v.statusLabel, sum: v.sum, checks: v.checks, effectiveFrom: v.effectiveFrom, effectiveUntil: v.effectiveUntil, poolMode: v.pool.mode, beneficiaries: v.beneficiaries.map((b) => ({ code: b.code, pct: b.pct, flow: b.flow, modeReglement: b.modeReglement })) })),
      comptesReglement: this.svc.comptes.all().map((c) => ({ id: c.id, currency: c.currency, status: c.status, alias: c.account_reference })),
      sousGrandLivre: this.svc.verifyChain(),
      circuit: versions.circuit,
      note: 'Super-administrateur : saisie de pourcentages PROPOSÉS seulement ; aucune vérification, approbation, activation, désignation de compte, demande de règlement ni écriture financière.',
    };
  }

  private audit(user: User, action: string, details: Record<string, unknown>) {
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action, resourceType: 'moteur_repartition', resourceId: user.id, details });
  }

  /** Pseudonyme d'une transaction (HMAC salé propre au processus) : jamais la référence de paiement ni l'identité du payeur. */
  private pseudo(orderId: string): string {
    return `TX-${createHmac('sha256', this.salt).update(orderId).digest('hex').slice(0, 12).toUpperCase()}`;
  }
}
