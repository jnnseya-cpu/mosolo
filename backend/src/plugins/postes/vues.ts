/**
 * Écrans des postes de décision (Cahier nouvelle version, ch. 27, et maquettes des cinq postes) : écran d'accueil sans
 * aucune saisie (ni filtre, ni période, ni commune : l'exercice en cours par défaut, avec le delta du jour), vues des
 * menus, note du lundi, recherche, postes de travail des opérateurs, indicateur de taille des corbeilles, exports.
 *
 * Tous les chiffres passent par `chiffre()` (§ 27.10 : état, comparaison, date, taux, source en trois niveaux) ; aucune
 * donnée fiscale individuelle n'apparaît sur un écran d'accueil ; les illustrations des maquettes sont des données de
 * démonstration marquées [EXEMPLE], montrées à part des chiffres calculés, jamais à leur place.
 */
import type { MoneyJSON, RevenueLadderLevel } from '@mosolo/shared';
import { ROLES } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { InMemoryAppendOnlyRepository } from '../../core/repository.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { computeLadder, drill, type Filters, type LadderContext } from '../pilotage/ladder.js';
import type { PilotageService } from '../pilotage/service.js';
import type { KpiResult } from '../pilotage/kpis.js';
import {
  ACTE_LABELS, ajouterJours, ALERTES_TECHNIQUES, BUDGETS_ATTENTION, CATALOGUE_POSTES, CATEGORIES, causeEnUnePhrase, chiffre, COLONNES_EXPORT, DEUX_FAMILLES_SEPAREES,
  ETAT_EXECUTION_LABELS, ETAT_LABELS, ETAT_PREPARATION_LABELS, EXEMPLE, FAMILLES, FILTRE_EST_LA_FONCTION, HABILITATIONS_INCHANGEES, INTERDITS_AUTORITE, isMoney,
  JAMAIS_REMONTE, JAMAIS_SUR_ECRAN_EXECUTIF, joursEntre, ligneExport, MENTION_MAQUETTE, MENUS, PAR_DEFAUT, PIED_POSTES, POSTES_TRAVAIL, QUATRE_REGLES, REGLES_CHIFFRES,
  REGLES_ECRANS, REPERES, ROLES_POSTE_DECISION, semaineKinshasa, SIX_ETATS, TEST_ACCEPTATION_90S, TITRES_POSTES, TROIS_ECRANS, BLOCS_FICHE,
  type Chiffre, type EtatChiffre, type ProfilPoste,
} from './model.js';
import { GOUVERNEUR_CORBEILLE, type Execution, type Fiche, type PostesService } from './service.js';

interface Plan {
  gapMap(u: User, q: { year?: string }): { certified: boolean; totals?: { ratePct: string | null; targetCdf: MoneyJSON; realisedCdf: MoneyJSON }; byCommune: { commune: string; ratePctCdf: string | null }[]; set?: { act: { reference: string } } };
  fundedProjects(range: { from: string; to: string }): { byCommune: { commune: string; projects: { code: string; title: string; domain: string; status: string; decisionReference: string }[] }[] } | null;
  instructions: { all(): { id: string; number: string; subject: string; authority: string; issuedBy: string; issuedAt: string; deadline: string; status: string; assignee: { entity: string; role?: string; userId?: string }; closure?: { at: string } }[] };
  targets: { all(): { fiscalYear: string; status: string; entries: { commune: string; category: string; amount: MoneyJSON }[] }[] };
}

export interface NoteHebdo { id: string; userId: string; semaine: { code: string; lundi: string; dimanche: string }; produiteLe: string; produitePar: string; version: number; sha256: string; contenu: ReturnType<Vues['contenuNote']> }

const pct = (num: number, den: number) => (den > 0 ? ((Math.round((num * 1000) / den) / 10).toFixed(1)) : null);
const moneyCdf = (v: bigint | number | string) => ({ amount: typeof v === 'bigint' ? `${v}.00` : Number(v).toFixed(2), currency: 'CDF' as const });

export class Vues {
  constructor(private readonly s: PostesService) {}

  private get ctx() { return this.s.ctx; }
  private get pil(): PilotageService | undefined { return this.ctx.ext.pilotage as PilotageService | undefined; }
  private get plan(): Plan | undefined { return this.ctx.ext.planification as Plan | undefined; }
  private annee(): string { return this.s.today().slice(0, 4); }
  private exercice(): Filters { return { from: `${this.annee()}-01-01`, to: this.s.today() }; }
  private exercicePrecedent(): Filters {
    const y = Number(this.annee()) - 1;
    return { from: `${y}-01-01`, to: `${y}${this.s.today().slice(4)}` };
  }

  /** Échelle de la recette sur des filtres (lecture seule du pilotage : agrégats seulement). */
  private ladder(f: Filters) {
    const pil = this.pil;
    if (!pil) return null;
    const c: LadderContext = { facts: pil.facts(), filters: f, convert: (m) => this.ctx.fx.convert(m, 'CDF').amount, verifiedObjects: 0 };
    return computeLadder(c);
  }
  private niveauCdf(levels: ReturnType<Vues['ladder']>, level: RevenueLadderLevel): bigint | null {
    const l = levels?.find((x) => x.level === level);
    if (!l || !l.measured || l.measure !== 'MONTANT') return null;
    return BigInt(Math.trunc(Number(l.consolidatedCdf?.amount ?? '0')));
  }
  private sommeEntites(entities: string[] | null, f: Filters, level: RevenueLadderLevel): bigint | null {
    if (!entities) return this.niveauCdf(this.ladder(f), level);
    let total = 0n; let measured = false;
    for (const e of entities) {
      const v = this.niveauCdf(this.ladder({ ...f, entity: e }), level);
      if (v !== null) { total += v; measured = true; }
    }
    return measured ? total : null;
  }

  /** Les six états (§ 27.10) sur l'exercice, comparés à la même période de l'exercice précédent. */
  sixEtats(entities: string[] | null, chemin: string): Chiffre[] {
    const f = this.exercice(), p = this.exercicePrecedent();
    const jour: Filters = { from: this.s.today(), to: this.s.today() };
    const src = (lv: string) => ({ libelle: 'Échelle unifiée de la recette (pilotage)', chemin: [chemin, '/pilotage/indicateurs', `/pilotage/tableaux?niveau=${lv}`], api: '/v1/pilotage/echelle' });
    const map: [string, EtatChiffre, RevenueLadderLevel][] = [['POTENTIEL', 'POTENTIEL_ESTIME', 'potential'], ['CONSTATE', 'CONSTATE', 'assessed'], ['ENCAISSE', 'ENCAISSE', 'confirmed'], ['REGLE', 'REGLE', 'settled'], ['RAPPROCHE', 'RAPPROCHE', 'reconciled'], ['DISPONIBLE', 'DISPONIBLE', 'available']];
    return map.map(([code, etat, lv]) => {
      const cur = this.sommeEntites(entities, f, lv);
      const prev = this.sommeEntites(entities, p, lv);
      const today = this.sommeEntites(entities, jour, lv);
      const ecart = cur !== null && prev !== null && prev > 0n ? `${pct(Number(cur - prev), Number(prev))} %` : null;
      const c = this.s.montant(code, `${ETAT_LABELS[etat]} — exercice ${this.annee()}`, cur !== null ? moneyCdf(cur) : null, etat,
        { type: 'PERIODE_PRECEDENTE', libelle: `Même période de l’exercice ${Number(this.annee()) - 1}`, valeur: prev !== null ? `${prev}.00` : null, ecart, tendance: cur === null || prev === null ? 'INDISPONIBLE' : cur > prev ? 'HAUSSE' : cur < prev ? 'BAISSE' : 'STABLE' },
        src(lv), { estimation: etat === 'POTENTIEL_ESTIME' });
      return { ...c, deltaDuJour: today !== null ? `${today}.00` : null, ...(cur === null ? { valeur: null, equivalents: { CDF: null, USD: null } } : {}) };
    });
  }

  /** Écart à l'assignation certifiée de l'exercice (non mesuré sans assignation certifiée). */
  ecartAssignation(u: User, chemin: string): Chiffre {
    let valeur: string | null = null; let note = 'Aucune assignation certifiée pour l’exercice : écart non mesuré.';
    try {
      const g = this.plan?.gapMap(u, { year: this.annee() });
      if (g?.certified && g.totals?.ratePct) { valeur = (Number(g.totals.ratePct) - 100).toFixed(1); note = `Assignation certifiée (${g.set?.act.reference ?? 'acte'})`; }
    } catch { /* lecture non autorisée pour ce profil : non mesuré */ }
    return chiffre({
      code: 'ECART_ASSIGNATION', libelle: 'Écart à l’assignation (rapproché ÷ assignation − 100)', valeur, unite: '%', etat: 'RATIO', estimation: false, date: this.s.now(),
      comparaison: { type: 'OBJECTIF', libelle: note, valeur: '0', ecart: valeur, tendance: 'INDISPONIBLE' },
      source: { libelle: 'Assignations et écarts', chemin: [chemin, '/pilotage/assignations', '/pilotage/assignations?vue=ecarts'], api: '/v1/pilotage/assignations/ecarts' },
    });
  }

  /** Alertes (§ 27.5 bloc 3) : jamais techniques ; classées par enjeu financier ; cause en une phrase. */
  alertes(u: User, max = 3) {
    const today = this.s.today();
    const rows = this.ctx.alerts.alerts.all()
      .filter((a) => !ALERTES_TECHNIQUES.test(a.type) && !ALERTES_TECHNIQUES.test(String(a.source).toUpperCase()))
      .filter((a) => {
        const ent = typeof a.context.entity === 'string' ? a.context.entity : null;
        return !ent || this.s.dansPerimetre(u, [ent]);
      })
      .map((a) => {
        const m = Object.values(a.context).find(isMoney) ?? null;
        const enjeuCdf = m ? this.s.toCdf(m) : 0n;
        return {
          id: a.id, type: a.type, gravite: a.severity, cause: causeEnUnePhrase(a.detail), ageJours: joursEntre(a.at.slice(0, 10), today),
          enjeu: m ? this.s.montant('ENJEU_ALERTE', 'Enjeu financier', m, 'CONSTATE', { type: 'SEUIL', libelle: 'Seuil de déperdition', valeur: String(this.s.param('postes.seuil.alerte_deperdition_cdf')), ecart: null, tendance: 'INDISPONIBLE' },
            { libelle: 'Alertes', chemin: ['/poste-de-decision', '/poste-de-decision/alertes', `/poste-de-decision/alertes?id=${a.id}`], api: '/v1/postes/vues/alertes' }) : null,
          enjeuCdf, lien: `/poste-de-decision/alertes?id=${encodeURIComponent(a.id)}`, saisirAudit: '/audit',
        };
      })
      .sort((a, b) => (a.enjeuCdf === b.enjeuCdf ? b.ageJours - a.ageJours : a.enjeuCdf > b.enjeuCdf ? -1 : 1));
    return { total: rows.length, items: rows.slice(0, max) };
  }

  /** Vignette des communes (couleur selon l'écart à l'objectif). */
  communesVignette(u: User) {
    let by = new Map<string, string | null>();
    let mesure = false;
    try {
      const g = this.plan?.gapMap(u, { year: this.annee() });
      if (g?.certified) { mesure = true; by = new Map(g.byCommune.map((c) => [c.commune, c.ratePctCdf])); }
    } catch { /* non mesuré */ }
    const couleur = (r: string | null | undefined) => (r === null || r === undefined ? 'GRIS' : Number(r) >= 100 ? 'VERT' : Number(r) >= 80 ? 'ORANGE' : 'ROUGE');
    return {
      mesure, note: mesure ? 'Couleur selon l’écart à l’assignation certifiée (vert ≥ 100 %, orange ≥ 80 %, rouge en deçà — bornes de couleur PAR_DEFAUT — à confirmer par le maître d’ouvrage).' : 'Aucune assignation certifiée : couleurs non mesurées (gris).',
      communes: COMMUNES.map((c) => ({ commune: c, tauxPct: by.get(c) ?? null, couleur: couleur(by.get(c)), lien: `/poste-de-decision/communes?commune=${encodeURIComponent(c)}` })),
    };
  }

  illustrations(profil: ProfilPoste, ministere?: string) {
    const out: Record<string, unknown[]> = {};
    for (const i of this.s.illustrations.all().filter((x) => x.profil === profil && (!x.ministere || x.ministere === ministere)).sort((a, b) => a.ordre - b.ordre)) {
      (out[i.bloc] ??= []).push({ ...(i.chiffre ?? {}), ...(i.texte ? { texte: i.texte } : {}), exemple: true, mention: `${EXEMPLE} ${MENTION_MAQUETTE}` });
    }
    return out;
  }

  private commun(u: User, profil: ProfilPoste) {
    return {
      profil, titre: TITRES_POSTES[profil], famille: 'POSTE_DE_DECISION', zeroSaisie: true, exercice: this.annee(), genereLe: this.s.now(),
      budget: BUDGETS_ATTENTION.find((b) => b.profil === profil) ?? null, menu: MENUS[profil], reperes: REPERES[profil],
      regles: REGLES_ECRANS, sixEtats: SIX_ETATS, pied: PIED_POSTES, habilitations: HABILITATIONS_INCHANGEES, securite: this.s.exigencesSecurite(u),
    };
  }

  // ————————————————————————— écrans d'accueil (zéro saisie) —————————————————————————

  accueil(u: User) {
    const profil = this.s.profilDe(u);
    if (!profil) throw forbidden('PAS_DE_POSTE_DE_DECISION', 'Aucun poste de décision pour ce profil : votre écran est le poste de travail (/v1/postes/travail).');
    if (profil === 'AUTORITE_HABILITEE') return this.accueilAutorite(u);
    authorize(u, 'postes:decision.read');
    const c = this.s.corbeille(u, { accueil: true });
    const urgentes = c.fiches.filter((f) => f.echeance.urgente || f.echeance.enRetard).length;
    const al = this.alertes(u);
    this.s.balayerNotifications(u, c.fiches, al.items.map((a) => ({ id: a.id, enjeuCdf: a.enjeuCdf })));
    this.s.audit(u, 'postes.accueil.consulte', 'poste', profil, { taille: c.fiches.length });
    const entete = { enAttente: c.fiches.length, urgentes, libelle: `${c.fiches.length} dossier${c.fiches.length > 1 ? 's' : ''} · ${urgentes} urgent${urgentes > 1 ? 's' : ''}` };
    const base = { ...this.commun(u, profil), entete, corbeille: { taille: c.fiches.length, differes: c.differes, nonPresentables: c.nonPresentables } };
    const alertes = al.items.map(({ enjeuCdf: _e, ...x }) => x);
    switch (profil) {
      case 'GOUVERNEUR': {
        const six = this.sixEtats(null, '/poste-de-decision');
        return {
          ...base,
          bloc1: { titre: 'Ce qui attend votre décision', fiches: this.plusEngageantes(c.fiches, 3) },
          bloc2: { titre: 'La Ville aujourd’hui · exercice en cours', chiffres: [six.find((x) => x.code === 'ENCAISSE')!, six.find((x) => x.code === 'REGLE')!, six.find((x) => x.code === 'RAPPROCHE')!, this.ecartAssignation(u, '/poste-de-decision')] },
          bloc3: { titre: 'Ce qui ne va pas', alertes, total: al.total },
          communes: this.communesVignette(u),
          jamaisRemonte: JAMAIS_REMONTE, illustrations: this.illustrations('GOUVERNEUR'),
        };
      }
      case 'DIRECTEUR_CABINET': return { ...base, ...this.cabinetAccueil(u), fiches: c.fiches, illustrations: this.illustrations('DIRECTEUR_CABINET') };
      case 'SECRETAIRE_EXECUTIF': return { ...base, ...this.secretariat(u, 'accueil'), fiches: c.fiches, illustrations: this.illustrations('SECRETAIRE_EXECUTIF') };
      case 'MINISTRE': return { ...base, ...this.ministre(u, 'accueil', c.fiches, alertes) };
      case 'DIRECTION_REGIE': return { ...base, fiches: c.fiches, alertes, travail: { lien: '/poste-de-travail', note: DEUX_FAMILLES_SEPAREES, enAttente: this.fileDeTravail(u).length } };
    }
  }

  /** Les fiches les plus engageantes : urgence, puis enjeu, puis gravité (bloc 1 du Gouverneur). */
  private plusEngageantes(fiches: Fiche[], n: number): Fiche[] {
    const g = { NORMALE: 1, HAUTE: 2, CRITIQUE: 3 } as const;
    return [...fiches].sort((a, b) => (Number(b.echeance.urgente) - Number(a.echeance.urgente)) || (BigInt(b.enjeuCdf) > BigInt(a.enjeuCdf) ? 1 : BigInt(b.enjeuCdf) < BigInt(a.enjeuCdf) ? -1 : 0) || (g[b.gravite] - g[a.gravite])).slice(0, n);
  }

  // ————————————————————————— § 27.6 Directeur de cabinet —————————————————————————

  private fileInstruction() {
    const gouv = this.s.corbeilleItems(GOUVERNEUR_CORBEILLE);
    const rangs = new Map(gouv.fiches.map((f, i) => [f.it.id, i + 1]));
    const items: { id: string; objet: string; etat: keyof typeof ETAT_PREPARATION_LABELS; etatLabel: string; detail: string; position: string | null; dossierId: string | null; exemple: boolean; reexamenLe?: string }[] = [];
    const seen = new Set<string>();
    for (const d of this.s.dossiers.find((x) => x.destinataireRole === 'R01' && x.statut === 'EN_ATTENTE')) {
      const id = `DOSSIER:${d.id}`; seen.add(id);
      const rang = rangs.get(id);
      const o = this.s.ordre.get(id);
      const detail = d.preparation === 'INCOMPLET'
        ? `${d.manque ?? (d.fondement.some((f) => f.trim()) ? 'Complément demandé' : 'Base légale non produite')} · à renvoyer au service`
        : d.preparation === 'A_INSTRUIRE' ? `${d.validationAmont ?? 'Instruction en cours'} · ${d.manque ?? 'pièces à compléter'}`
          : `${d.demandeur.libelle} · ${d.serviceInstructeur} · ${d.pieces.length ? 'pièces complètes' : 'pièces à produire'}`;
      items.push({
        id, objet: d.objet, etat: d.preparation, etatLabel: ETAT_PREPARATION_LABELS[d.preparation], detail,
        position: d.transmis && rang ? (rang === 1 && (o?.decalage ?? 0) > 0 ? 'monté en 1ʳᵉ position' : `${rang}ᵉ position`) : d.transmis ? 'transmis' : null,
        dossierId: d.id, exemple: !!d.exemple, ...(o?.differeJusquau ? { reexamenLe: o.differeJusquau } : {}),
      });
    }
    for (const f of gouv.fiches) {
      if (seen.has(f.it.id)) continue;
      items.push({ id: f.it.id, objet: f.it.objet, etat: 'INSTRUIT', etatLabel: 'Instruit', detail: `${f.it.module} · ${f.it.serviceInstructeur}`, position: `${rangs.get(f.it.id)}ᵉ position`, dossierId: null, exemple: !!f.it.exemple });
    }
    for (const it of gouv.nonPresentables) {
      if (seen.has(it.id)) continue;
      items.push({ id: it.id, objet: it.objet, etat: 'INCOMPLET', etatLabel: 'Incomplet', detail: `${it.module} · Base légale non produite · à renvoyer au service`, position: null, dossierId: null, exemple: !!it.exemple });
    }
    for (const d of gouv.differes) {
      if (seen.has(d.it.id)) continue;
      items.push({ id: d.it.id, objet: d.it.objet, etat: 'INSTRUIT', etatLabel: 'Instruit — différé', detail: `Différé : réexamen le ${d.jusquau}`, position: null, dossierId: null, exemple: !!d.it.exemple, reexamenLe: d.jusquau });
    }
    return { items, prets: gouv.fiches.length, taille: gouv.fiches.length };
  }

  private suiviExecutions(u: User) {
    return this.lignesExecution(u).filter((e) => e.etat !== 'EXECUTE').sort((a, b) => (a.echeance < b.echeance ? -1 : 1))
      .map((e) => ({ id: e.id, objet: e.acteLibelle, jalon: e.joursRestants === null ? '—' : `J${e.joursRestants >= 0 ? '+' : ''}${e.joursRestants}`, detail: [e.note, e.etatLabel, e.responsable.libelle].filter(Boolean).join(' · '), responsable: e.responsable.libelle, echeance: e.echeance, enRetard: e.enRetard, relancable: !e.id.startsWith('INSTR:'), exemple: !!e.exemple }));
  }

  private trace() {
    return this.s.gestes.find((g) => ['RENVOYER', 'RECLAMER_PIECE', 'REFORMULER', 'DIFFERER', 'DESCENDRE', 'MONTER', 'TRANSMETTRE'].includes(g.geste))
      .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50).map((g) => ({ at: g.at, par: this.s.userName(g.userId), geste: g.geste, objet: g.objet, motif: g.motif, ficheId: g.ficheId }));
  }

  private cabinetAccueil(u: User) {
    const f = this.fileInstruction();
    const incomplets = f.items.filter((i) => i.etat === 'INCOMPLET').length;
    return {
      fileInstruction: {
        titre: 'File d’instruction', dossiers: f.items.length, incomplets, pretsPourGouverneur: f.prets,
        libelle: `${f.items.length} dossier${f.items.length > 1 ? 's' : ''} · ${incomplets} incomplet${incomplets > 1 ? 's' : ''}`,
        texte: `Prêts pour le Gouverneur : ${f.prets}. Vous décidez de ce qui monte, dans quel ordre, et dans quel état. Chaque arbitrage est enregistré.`,
      },
      aTraiter: f.items, decidePasExecute: this.suiviExecutions(u),
      corbeilleGouverneur: {
        taille: f.taille, cible: '≤ 10', alerte: f.taille > this.s.param('postes.corbeille.taille_alerte'),
        chiffre: chiffre({ code: 'TAILLE_CORBEILLE_GOUVERNEUR', libelle: 'Éléments dans la corbeille du Gouverneur', valeur: String(f.taille), unite: 'éléments', etat: 'COMPTAGE', estimation: false, date: this.s.now(),
          comparaison: { type: 'SEUIL', libelle: 'Éléments visés : une dizaine au plus', valeur: String(this.s.param('postes.corbeille.taille_alerte')), ecart: String(f.taille - this.s.param('postes.corbeille.taille_alerte')), tendance: 'INDISPONIBLE' },
          source: { libelle: 'Ordre du jour du Gouverneur', chemin: ['/poste-de-decision', '/poste-de-decision/ordre-du-jour'], api: '/v1/postes/vues/ordre-du-jour' } }),
      },
      traceNote: 'La trace protège le filtre : ce qui a été écarté, par qui et pour quel motif reste consultable ; un dossier différé porte sa date de réexamen.',
      trace: this.trace(),
    };
  }

  private coordination(u: User) {
    // Vue transversale des services et des régies : comptages seulement, aucun dossier individuel.
    const par = new Map<string, { entity: string; enAttente: number; instructionsEnRetard: number; actesEnRetard: number }>();
    const row = (e: string) => { const r = par.get(e) ?? { entity: e, enAttente: 0, instructionsEnRetard: 0, actesEnRetard: 0 }; par.set(e, r); return r; };
    for (const it of this.s.items()) for (const e of it.entities.slice(0, 1)) row(e).enAttente++;
    const today = this.s.today();
    for (const i of this.plan?.instructions.all() ?? []) if (i.status !== 'CLOSE' && i.deadline < today) row(i.assignee.entity).instructionsEnRetard++;
    for (const e of this.lignesExecution(u)) if (e.enRetard) row(e.responsable.entity).actesEnRetard++;
    const acces = this.ctx.ext.acces as { entities: { get(id: string): { name: string } | undefined } } | undefined;
    return {
      services: [...par.values()].map((r) => ({ ...r, nom: acces?.entities.get(r.entity)?.name ?? r.entity })).sort((a, b) => b.enAttente + b.actesEnRetard - (a.enAttente + a.actesEnRetard)),
      actions: [{ libelle: 'Convoquer (instruction au service)', lien: '/pilotage/instructions' }, { libelle: 'Saisir le comité technique', lien: '/pilotage/feuille-de-route' }, { libelle: 'Arbitrer en amont (ordre du jour)', lien: '/poste-de-decision/ordre-du-jour' }],
      note: 'Sans accès aux dossiers individuels : comptages par service seulement.',
    };
  }

  // ————————————————————————— § 27.7 Secrétariat exécutif —————————————————————————

  /** Lignes d'exécution : décisions des postes + instructions (§ 26.1), relues sans modification. */
  lignesExecution(u: User): (ReturnType<PostesService['vueExecution']> & { source: string })[] {
    const rows = this.s.executions.all().map((e) => ({ ...this.s.vueExecution(e), source: 'POSTE' }));
    const today = this.s.today();
    const map: Record<string, keyof typeof ETAT_EXECUTION_LABELS> = { EMISE: 'NON_ENGAGE', ACCUSEE: 'EN_COURS', RAPPORT_DEPOSE: 'PRODUIT', CLOSE: 'EXECUTE' };
    for (const i of this.plan?.instructions.all() ?? []) {
      const etat = map[i.status] ?? 'NON_ENGAGE';
      const jr = joursEntre(today, i.deadline);
      const late = etat !== 'EXECUTE' ? jr < 0 : !!i.closure && i.closure.at.slice(0, 10) > i.deadline;
      const e: Execution = {
        id: `INSTR:${i.id}`, decision: { objet: `${i.number} — ${i.subject}`, date: i.issuedAt, autorite: i.authority, autoriteId: i.issuedBy }, acte: 'INSTRUCTION', acteLibelle: `Instruction ${i.number} — ${i.subject}`,
        responsable: { entity: i.assignee.entity, ...(i.assignee.role ? { role: i.assignee.role as never } : {}), ...(i.assignee.userId ? { userId: i.assignee.userId } : {}), libelle: i.assignee.entity }, echeance: i.deadline, etat,
        historique: [], relances: [], justifications: [], ...(i.closure ? { executeLe: i.closure.at } : {}),
      };
      rows.push({ ...e, etatLabel: ETAT_EXECUTION_LABELS[etat], acteType: ACTE_LABELS.INSTRUCTION, joursRestants: etat === 'EXECUTE' ? null : jr, enRetard: late, joursRetard: late && etat !== 'EXECUTE' ? -jr : 0, blocage: null, blocageLibelle: late ? 'Cause non déclarée — à déclarer par le service responsable (jamais déduite)' : null, exempleMention: null, source: 'INSTRUCTION' });
    }
    // Périmètre : province entière pour les autorités centrales ; sinon, services du périmètre.
    return rows.filter((r) => this.s.provinceEntiere(u) || this.s.dansPerimetre(u, [r.responsable.entity]) || r.decision.autoriteId === u.id);
  }

  indicateurExecution(u: User) {
    const today = this.s.today();
    const debut = ajouterJours(today, -90);
    const rows = this.lignesExecution(u).filter((r) => r.decision.date.slice(0, 10) >= debut);
    const echues = rows.filter((r) => r.etat === 'EXECUTE' || r.echeance < today);
    const aTemps = echues.filter((r) => r.etat === 'EXECUTE' && !r.enRetard).length;
    const valeur = pct(aTemps, echues.length);
    const retards = this.lignesExecution(u).filter((r) => r.enRetard && r.etat !== 'EXECUTE');
    return {
      principal: chiffre({ code: 'EXECUTION_DANS_LE_DELAI', libelle: 'Décisions exécutées dans le délai', valeur, unite: '%', etat: 'RATIO', estimation: false, date: this.s.now(),
        comparaison: { type: 'OBJECTIF', libelle: 'Délai prévu de chaque acte (90 derniers jours)', valeur: '100', ecart: valeur !== null ? (Number(valeur) - 100).toFixed(1) : null, tendance: 'INDISPONIBLE' },
        source: { libelle: 'Exécution des décisions', chemin: ['/poste-de-decision', '/poste-de-decision/execution', '/poste-de-decision/retards'], api: '/v1/postes/vues/execution' } }),
      periode: '90 derniers jours', decisionsEchues: echues.length, executeesATemps: aTemps,
      retards: { total: retards.length, auDela30: retards.filter((r) => r.joursRetard > 30).length },
    };
  }

  secretariat(u: User, vue: string) {
    const rows = this.lignesExecution(u).sort((a, b) => (Number(b.enRetard) - Number(a.enRetard)) || (a.echeance < b.echeance ? -1 : 1));
    const base = { question: 'Ce qui a été décidé est-il fait ?', indicateur: this.indicateurExecution(u), phrase: 'Cet écran ne parle pas de recettes. Il répond à une seule question, et il la pose nommément à chaque service.' };
    switch (vue) {
      case 'accueil': case 'execution': return { ...base, actes: rows, etats: ETAT_EXECUTION_LABELS };
      case 'retards': return { ...base, retards: rows.filter((r) => r.enRetard), regle: 'Le blocage doit être déclaré, pas constaté : la cause affichée est celle déclarée par le service responsable.' };
      case 'coordination': {
        let calendrier: unknown[] = [];
        try {
          const pg = this.ctx.ext.programme as { governanceView(u: User): { bodies: { code: string; label: string; frequence: string; nextDueDate: string | null; lastMeetingDate: string | null; overdue: boolean | null }[] } } | undefined;
          calendrier = pg?.governanceView(u).bodies.map((b) => ({ instance: b.label, frequence: b.frequence, derniere: b.lastMeetingDate, prochaine: b.nextDueDate, enRetard: b.overdue })) ?? [];
        } catch { /* lecture non autorisée : calendrier non affiché */ }
        return { ...base, interservices: this.coordination(u).services, calendrierInstitutionnel: calendrier };
      }
      case 'documentation': return { ...base, documents: rows.filter((r) => r.preuve || r.etat === 'PRODUIT' || r.etat === 'NOTIFIE' || r.etat === 'EXECUTE').map((r) => ({ id: r.id, acte: r.acteType, libelle: r.acteLibelle, reference: r.preuve?.reference ?? null, version: r.preuve?.version ?? null, publieLe: r.preuve?.publieLe ?? r.executeLe?.slice(0, 10) ?? null, etat: r.etatLabel, exemple: !!r.exemple })) };
      default: throw notFound('VUE_INCONNUE', `Vue inconnue : ${vue}.`);
    }
  }

  // ————————————————————————— § 27.8 Ministre provincial —————————————————————————

  private entitesMinistere(u: User): string[] { return [...this.s.entitesDe(u)]; }

  /** Recettes du ministère par catégorie, face aux objectifs (agrégats uniquement). */
  private recettesParCategorie(entities: string[] | null, chemin: string) {
    const pil = this.pil;
    if (!pil) return [];
    const f = this.exercice();
    const byCat = new Map<string, bigint>();
    for (const e of entities ?? [null]) {
      const c: LadderContext = { facts: pil.facts(), filters: { ...f, ...(e ? { entity: e } : {}) }, convert: (m) => this.ctx.fx.convert(m, 'CDF').amount, verifiedObjects: 0 };
      for (const r of drill('category', c).rows) {
        const v = BigInt(Math.trunc(Number((r.values.reconciled as { consolidatedCdf: MoneyJSON }).consolidatedCdf.amount)));
        byCat.set(r.key, (byCat.get(r.key) ?? 0n) + v);
      }
    }
    const t = this.plan?.targets.all().find((x) => x.fiscalYear === this.annee() && x.status === 'CERTIFIEE');
    const cible = new Map<string, bigint>();
    for (const en of t?.entries ?? []) cible.set(en.category, (cible.get(en.category) ?? 0n) + this.s.toCdf(en.amount));
    return [...byCat.entries()].filter(([, v]) => v > 0n).sort((a, b) => (a[1] > b[1] ? -1 : 1)).map(([cat, v]) => {
      const obj = cible.get(cat);
      const part = obj && obj > 0n ? pct(Number(v), Number(obj)) : null;
      return this.s.montant(`RECETTE_${cat}`, `${cat.toLowerCase().replace(/_/g, ' ')} — rapproché`, moneyCdf(v), 'RAPPROCHE',
        { type: 'OBJECTIF', libelle: obj ? 'Part de l’objectif de l’exercice' : 'Aucun objectif certifié pour cette catégorie', valeur: obj ? `${obj}.00` : null, ecart: part ? `${part} % de l’objectif` : null, tendance: 'INDISPONIBLE' },
        { libelle: 'Recettes par catégorie', chemin: [chemin, '/pilotage/indicateurs', `/pilotage/tableaux?categorie=${cat}`], api: '/v1/pilotage/drill/category' });
    });
  }

  ministre(u: User, vue: string, fichesIn?: Fiche[], alertesIn?: unknown[]) {
    const entities = this.entitesMinistere(u);
    const acces = this.ctx.ext.acces as { entities: { get(id: string): { name: string } | undefined } } | undefined;
    const nom = acces?.entities.get(u.entity)?.name ?? u.entity;
    const fiches = fichesIn ?? this.s.corbeille(u, { accueil: true }).fiches;
    const alertes = alertesIn ?? this.alertes(u, 10).items.map(({ enjeuCdf: _e, ...x }) => x);
    const finances = u.roles.includes('R05');
    const lignes = this.lignesExecution(u);
    const exceptions = [
      ...lignes.filter((r) => r.enRetard && r.etat !== 'EXECUTE').map((r) => ({ type: 'HORS_DELAI', titre: `${r.acteLibelle} — hors délai`, detail: r.blocageLibelle ?? '', instruction: 'Instruction par ses services, pas d’action financière directe.' })),
      ...fiches.filter((f) => f.echeance.enRetard).map((f) => ({ type: 'FICHE_EN_RETARD', titre: `${f.objet} — échéance dépassée`, detail: f.echeance.consequenceSilence, instruction: 'Décision attendue.' })),
      ...(alertes as { cause: string; type: string }[]).map((a) => ({ type: 'ALERTE', titre: a.cause, detail: a.type, instruction: 'Instruction par ses services, pas d’action financière directe.' })),
    ];
    const base = {
      titre: `Ministre provincial — ${nom}`, ministere: nom, entites: entities, phrase: 'Le périmètre affiché est celui du ministère, et lui seul. Aucun dossier nominatif n’apparaît sans finalité déclarée.',
      illustrations: this.illustrations('MINISTRE', u.entity),
    };
    const financesBloc = finances ? this.competencesFinances(u) : null;
    switch (vue) {
      case 'accueil':
        return { ...base, mesDecisions: { libelle: `${fiches.length} dossier${fiches.length > 1 ? 's' : ''} de mon périmètre`, fiches: fiches.slice(0, 3) }, mesRecettes: [this.sixEtats(entities, '/poste-de-decision').find((x) => x.code === 'RAPPROCHE')!, ...this.recettesParCategorie(entities, '/poste-de-decision').slice(0, 3)], mesExceptions: exceptions.slice(0, 3), ...(financesBloc ? { finances: financesBloc } : {}) };
      case 'mes-decisions': return { ...base, fiches, historique: this.historique(u) };
      case 'mes-recettes': return { ...base, sixEtats: this.sixEtats(entities, '/poste-de-decision/mes-recettes'), parCategorie: this.recettesParCategorie(entities, '/poste-de-decision/mes-recettes'), note: 'Agrégats uniquement ; aucun dossier nominatif sans finalité déclarée.' };
      case 'mes-services': {
        const coord = this.coordination(u).services.filter((s) => entities.includes(s.entity));
        const acc = this.ctx.ext.acces as { entities: { all(): { id: string; name: string; kind: string }[] } } | undefined;
        const services = (acc?.entities.all() ?? []).filter((e) => entities.includes(e.id)).map((e) => {
          const c = coord.find((x) => x.entity === e.id);
          return { entity: e.id, nom: e.name, nature: e.kind, enAttente: c?.enAttente ?? 0, instructionsEnRetard: c?.instructionsEnRetard ?? 0, actesEnRetard: c?.actesEnRetard ?? 0 };
        });
        return { ...base, services, note: 'Pas d’accès aux agents d’un autre ministère : performance par service, sans liste nominative.' };
      }
      case 'mes-exceptions': return { ...base, exceptions };
      case 'mes-engagements': return { ...base, engagements: lignes.filter((r) => r.decision.autoriteId === u.id || entities.includes(r.responsable.entity)), actions: ['Lecture', 'Relance', 'Justification'] };
      default: throw notFound('VUE_INCONNUE', `Vue inconnue : ${vue}.`);
    }
  }

  /** Compétences propres du ministre des Finances : arbitrage des assignations, trésorerie consolidée, seuils de délégation. */
  private competencesFinances(u: User) {
    const gouv = this.ctx.ext['integrite-gouvernance'] as { entry?(d: unknown): { value: unknown; status: string; statusLabel: string } } | undefined;
    const defs = ['postes.seuil.exoneration_degrevement_cdf'];
    const seuils = defs.map((id) => ({ id, valeur: this.s.param(id), unite: 'CDF', statut: PAR_DEFAUT, modification: 'Registre des seuils : proposition motivée puis approbation par une autre personne (le ministre des Finances figure parmi les approbateurs).', lien: '/integrite/seuils' }));
    void gouv;
    let tresorerie: unknown;
    try {
      const t = this.pil?.profile(u, 'tresor', {}) as { tiles?: unknown; suspense?: unknown; exceptions?: unknown } | undefined;
      tresorerie = t ? { tuiles: t.tiles ?? null, suspens: t.suspense ?? null, exceptions: t.exceptions ?? null, note: 'Vue consolidée de trésorerie : agrégats seulement.' } : null;
    } catch { tresorerie = null; }
    return {
      arbitrageAssignations: { enAttente: this.s.corbeille(u, { accueil: true }).fiches.filter((f) => f.categorie?.code === 'ARBITRAGE_ASSIGNATIONS').length, ecart: this.ecartAssignation(u, '/poste-de-decision'), lien: '/pilotage/assignations' },
      tresorerieConsolidee: tresorerie, seuilsDelegation: seuils,
    };
  }

  // ————————————————————————— § 27.9 autres autorités habilitées —————————————————————————

  private perimetreEntities(u: User): string[] | null {
    const h = this.s.habilitationActive(u);
    return h.perimetre.entities.length ? h.perimetre.entities : null;
  }

  accueilAutorite(u: User) {
    authorize(u, 'postes:consultation.read');
    const h = this.s.habilitationActive(u);
    this.s.noterConsultation(u, 'accueil');
    const entities = this.perimetreEntities(u);
    const six = this.sixEtats(entities, '/poste-de-decision');
    return {
      ...this.commun(u, 'AUTORITE_HABILITEE'),
      bandeau: `Accès en consultation. Périmètre déclaré : ${h.perimetre.libelle}. Habilitation valable jusqu’au ${h.au.split('-').reverse().join('/')}. Chaque consultation est enregistrée.`,
      habilitation: { du: h.du, au: h.au, perimetre: h.perimetre },
      entete: { enAttente: 0, urgentes: 0, libelle: 'Aucune corbeille de décision (poste de consultation)' },
      corbeille: { taille: 0, differes: [], nonPresentables: 0 },
      recettes: [six.find((x) => x.code === 'ENCAISSE')!, six.find((x) => x.code === 'RAPPROCHE')!],
      parCategorie: this.recettesParCategorie(entities, '/poste-de-decision'),
      realisations: this.realisations(),
      alertes: [], interdits: INTERDITS_AUTORITE, phrase: 'Aucune corbeille de décision, aucune donnée fiscale individuelle, aucune action possible depuis ce poste.',
      illustrations: this.illustrations('AUTORITE_HABILITEE'),
    };
  }

  private realisations() {
    const today = this.s.today();
    const fp = this.plan?.fundedProjects({ from: `${this.annee()}-01-01`, to: today });
    const items = (fp?.byCommune ?? []).flatMap((c) => c.projects.map((p) => ({ titre: p.title, domaine: p.domain, statut: p.status, commune: c.commune, reference: p.decisionReference })));
    const pubs = (this.pil?.publicIndex() as { periods?: { period: string }[] } | undefined)?.periods ?? [];
    return { items, publications: pubs, lien: '/transparence', note: 'Même source que le tableau public de transparence : aucune donnée personnelle.' };
  }

  vueAutorite(u: User, vue: string) {
    authorize(u, 'postes:consultation.read');
    const h = this.s.habilitationActive(u);
    this.s.noterConsultation(u, vue);
    const entities = this.perimetreEntities(u);
    switch (vue) {
      case 'recettes': return { sixEtats: this.sixEtats(entities, '/poste-de-decision/recettes'), parCategorie: this.recettesParCategorie(entities, '/poste-de-decision/recettes'), note: 'Agrégats provinciaux dans le périmètre déclaré.' };
      case 'realisations': return this.realisations();
      case 'mon-habilitation': return {
        habilitation: { ...h, declareParNom: this.s.userName(h.declarePar) }, expireDans: joursEntre(this.s.today(), h.au),
        consultations: this.s.consultations.find((c) => c.userId === u.id).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100),
        regle: 'Renouvellement explicite, jamais tacite : à l’échéance, l’accès cesse de lui-même.',
      };
      default: throw notFound('VUE_INCONNUE', `Vue inconnue : ${vue}.`);
    }
  }

  // ————————————————————————— vues des menus —————————————————————————

  vue(u: User, code: string) {
    const profil = this.s.profilDe(u);
    if (!profil) throw forbidden('PAS_DE_POSTE_DE_DECISION', 'Aucun poste de décision pour ce profil.');
    if (profil === 'AUTORITE_HABILITEE') return this.vueAutorite(u, code);
    authorize(u, 'postes:decision.read');
    this.s.audit(u, 'postes.vue.consultee', 'poste', `${profil}:${code}`, {});
    if (profil === 'MINISTRE' && code.startsWith('mes-')) return this.ministre(u, code);
    if (profil === 'SECRETAIRE_EXECUTIF' && ['execution', 'retards', 'coordination', 'documentation'].includes(code)) return this.secretariat(u, code);
    if (profil === 'DIRECTEUR_CABINET') {
      if (code === 'instruction') { const f = this.fileInstruction(); return { items: f.items, pretsPourGouverneur: f.prets, actions: ['TRANSMETTRE', 'RENVOYER', 'RECLAMER_PIECE', 'REFORMULER'] }; }
      if (code === 'ordre-du-jour') {
        const gouv = this.s.corbeilleItems(GOUVERNEUR_CORBEILLE);
        return {
          corbeille: gouv.fiches.map((e, i) => ({ rang: i + 1, ...this.s.fiche(GOUVERNEUR_CORBEILLE, e, { accueil: true }), ordre: this.s.ordre.get(e.it.id)?.historique ?? [] })),
          differes: gouv.differes.map((d) => ({ id: d.it.id, objet: d.it.objet, reexamenLe: d.jusquau, historique: this.s.ordre.get(d.it.id)?.historique ?? [] })),
          taille: gouv.fiches.length, cible: '≤ 10', trace: this.trace(),
        };
      }
      if (code === 'suivi') return { decidePasExecute: this.suiviExecutions(u) };
      if (code === 'coordination') return this.coordination(u);
    }
    switch (code) {
      case 'decisions': case 'mes-decisions': return { fiches: this.s.corbeille(u, { accueil: true }).fiches, historique: this.historique(u) };
      case 'recettes': return { sixEtats: this.sixEtats(this.s.provinceEntiere(u) ? null : [...this.s.entitesDe(u)], '/poste-de-decision/recettes'), parCategorie: this.recettesParCategorie(this.s.provinceEntiere(u) ? null : [...this.s.entitesDe(u)], '/poste-de-decision/recettes'), parCommune: this.recettesParCommune(u), illustrations: this.illustrations(profil) };
      case 'alertes': return this.vueAlertes(u);
      case 'communes': return this.vueCommunes(u);
      case 'travail': return this.travail(u);
      default: throw notFound('VUE_INCONNUE', `Vue inconnue : ${code}.`);
    }
  }

  historique(u: User) {
    return this.s.gestes.find((g) => g.userId === u.id).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 200);
  }

  private recettesParCommune(u: User) {
    const pil = this.pil;
    if (!pil) return [];
    const c: LadderContext = { facts: pil.facts(), filters: { ...this.exercice(), ...(this.s.provinceEntiere(u) ? {} : { entity: u.entity }) }, convert: (m) => this.ctx.fx.convert(m, 'CDF').amount, verifiedObjects: 0 };
    return drill('commune', c).rows.map((r) => this.s.montant(`COMMUNE_${r.key}`, `${r.key} — rapproché`, (r.values.reconciled as { consolidatedCdf: MoneyJSON }).consolidatedCdf, 'RAPPROCHE',
      { type: 'COMMUNES', libelle: 'Comparaison aux autres communes (classement)', valeur: null, ecart: null, tendance: 'INDISPONIBLE' },
      { libelle: 'Recettes par commune', chemin: ['/poste-de-decision/recettes', '/poste-de-decision/communes', `/poste-de-decision/communes?commune=${encodeURIComponent(r.key)}`], api: '/v1/pilotage/drill/commune' }));
  }

  private vueAlertes(u: User) {
    const al = this.alertes(u, 50);
    const today = this.s.today();
    const integ = this.ctx.ext.integrite as { cases?: { all(): { status: string }[] } } | undefined;
    const fraudes = (integ?.cases?.all() ?? []).filter((c) => !['CLOTURE', 'CLASSE', 'CLOTUREE'].includes(c.status));
    const fiches = this.s.corbeille(u, { accueil: true }).fiches.filter((f) => f.echeance.enRetard);
    const instr = (this.plan?.instructions.all() ?? []).filter((i) => i.status !== 'CLOSE' && i.deadline < today && this.s.dansPerimetre(u, [i.assignee.entity]));
    return {
      deperditions: al.items.map(({ enjeuCdf: _e, ...x }) => x),
      fraudesEnInstruction: { nombre: fraudes.length, note: 'Nombre de dossiers d’enquête ouverts ; aucun dossier individuel sur cet écran.' },
      delaisDepasses: [
        ...fiches.map((f) => ({ type: 'DECISION', objet: f.objet, echeance: f.echeance.date, lien: `/poste-de-decision/fiche/${encodeURIComponent(f.id)}` })),
        ...instr.map((i) => ({ type: 'INSTRUCTION', objet: `${i.number} — ${i.subject}`, echeance: i.deadline, lien: '/pilotage/instructions' })),
      ],
      illustrations: this.illustrations(this.s.profilDe(u) ?? 'GOUVERNEUR'),
    };
  }

  private vueCommunes(u: User) {
    const v = this.communesVignette(u);
    const objets = this.ctx.objects.objects.all();
    const acces = this.ctx.ext.acces as { entities: { all(): { id: string; name: string; kind: string }[] } } | undefined;
    const communesEnt = (acces?.entities.all() ?? []).filter((e) => e.kind === 'COMMUNE');
    const rows = v.communes.map((c) => {
      const mine = objets.filter((o) => o.commune === c.commune);
      const valides = mine.filter((o) => o.status === 'VALIDE').length;
      const ent = communesEnt.find((e) => e.name.includes(c.commune));
      const admin = ent ? this.ctx.users.all().find((x) => x.entity === ent.id && x.roles.includes('R08')) : undefined;
      return {
        ...c, objets: mine.length, couverture: chiffre({ code: `COUVERTURE_${c.commune}`, libelle: 'Couverture du recensement (objets validés)', valeur: pct(valides, mine.length), unite: '%', etat: 'RATIO', estimation: false, date: this.s.now(),
          comparaison: { type: 'COMMUNES', libelle: 'Comparaison aux autres communes', valeur: null, ecart: null, tendance: 'INDISPONIBLE' },
          source: { libelle: 'Registre des objets', chemin: ['/poste-de-decision/communes', `/poste-de-decision/communes?commune=${encodeURIComponent(c.commune)}`, '/fiscal/recensement'], api: '/v1/pilotage/indicateurs' } }),
        responsable: admin ? { nom: admin.name, role: ROLES[admin.roles[0]!], interpeller: '/pilotage/instructions' } : null,
      };
    });
    rows.sort((a, b) => (a.tauxPct === null ? 1 : b.tauxPct === null ? -1 : Number(a.tauxPct) - Number(b.tauxPct)));
    return { ...v, classement: rows, illustrations: this.illustrations(this.s.profilDe(u) ?? 'GOUVERNEUR') };
  }

  // ————————————————————————— § 27.13 postes de travail —————————————————————————

  fileDeTravail(u: User) {
    const corbeille = new Set(this.s.profilDe(u) && u.roles.some((r) => ROLES_POSTE_DECISION.includes(r)) ? this.s.corbeilleItems(u).fiches.map((f) => f.it.id) : []);
    const today = this.s.today();
    return this.s.items().filter((it) => !corbeille.has(it.id) && it.eligible(u)).map((it) => ({
      id: it.id, module: it.module, objet: it.objet, demandeur: this.s.userName(it.demandeurId), depose: it.date, echeance: it.echeance, enRetard: !!it.echeance && it.echeance < today,
      ecran: it.ecran, categorie: it.categorie, individuel: it.individuel,
    })).sort((a, b) => (a.depose < b.depose ? -1 : 1));
  }

  travail(u: User) {
    authorize(u, 'postes:travail.read');
    const postes = POSTES_TRAVAIL.filter((p) => p.roles.some((r) => u.roles.includes(r)));
    const kpis: KpiResult[] = (() => {
      try {
        const scope = this.pil?.filtersFor(u, {});
        return scope ? this.pil!.computeKpis(scope.filters) : [];
      } catch { return []; }
    })();
    const indicateur = (codes: string[], code: string) => {
      if (code === 'JURISTE') {
        const actives = this.ctx.rules.rules.find((r) => r.status === 'ACTIVE');
        const sans = actives.filter((r) => !r.legalInstrumentIds.some((id) => ['EN_VIGUEUR', 'MODIFIE'].includes(this.ctx.rules.instruments.get(id)?.status ?? ''))).length;
        return [{ code: 'REGLES_SANS_REFERENCE_VALIDE', libelle: 'Règles en vigueur sans référence valide', valeur: String(sans), unite: 'règles', statut: sans === 0 ? 'ATTEINTE' : 'NON_ATTEINTE' }];
      }
      if (code === 'ADMINISTRATEUR') {
        const integ = this.ctx.ext.integrite as { incidents?: { all(): { status: string }[] } } | undefined;
        const open = (integ?.incidents?.all() ?? []).filter((i) => !['CLOS', 'CLOTURE', 'RESOLU'].includes(i.status)).length;
        return [{ code: 'INCIDENTS_OUVERTS', libelle: 'Incidents ouverts', valeur: String(open), unite: 'incidents', statut: open === 0 ? 'ATTEINTE' : 'NON_ATTEINTE' }];
      }
      if (code === 'AUDITEUR') {
        const integ = this.ctx.ext.integrite as { cases?: { all(): { status: string; openedAt: string }[] } } | undefined;
        const open = (integ?.cases?.all() ?? []).filter((c) => !['CLOTURE', 'CLASSE', 'CLOTUREE'].includes(c.status));
        const moy = open.length ? Math.round(open.reduce((a, c) => a + joursEntre(c.openedAt.slice(0, 10), this.s.today()), 0) / open.length) : null;
        return [{ code: 'DELAI_INSTRUCTION', libelle: 'Délai d’instruction moyen des dossiers ouverts', valeur: moy === null ? null : String(moy), unite: 'jours', statut: moy === null ? 'NON_MESURE' : 'SANS_CIBLE' }];
      }
      if (code === 'CONTRIBUABLE') return [{ code: 'SITUATION_PERSONNELLE', libelle: 'Situation personnelle', valeur: null, unite: '', statut: 'VOIR_MON_ESPACE' }];
      return codes.map((k) => { const x = kpis.find((y) => y.code === k); return { code: k, libelle: x?.label ?? k, valeur: x?.value ?? null, unite: x?.unit ?? '', statut: x?.status ?? 'NON_MESURE' }; });
    };
    const file = this.fileDeTravail(u);
    this.s.audit(u, 'postes.travail.consulte', 'poste', 'travail', { enAttente: file.length });
    return {
      famille: 'POSTE_DE_TRAVAIL', question: '« Que dois-je traiter aujourd’hui ? »',
      postes: postes.map((p) => ({ ...p, indicateur: indicateur(p.kpis, p.code) })),
      file, enAttente: file.length,
      corbeille: u.roles.some((r) => ROLES_POSTE_DECISION.includes(r)) ? { lien: '/poste-de-decision', note: DEUX_FAMILLES_SEPAREES } : null,
    };
  }

  // ————————————————————————— recherche (menu « Rechercher ») —————————————————————————

  recherche(u: User, q: string) {
    const t = q.trim().toLowerCase();
    if (t.length < 2) throw badRequest('RECHERCHE_TROP_COURTE', 'Deux caractères au moins.');
    const profil = this.s.profilDe(u);
    if (profil === 'AUTORITE_HABILITEE') this.s.habilitationActive(u);
    else authorize(u, 'postes:travail.read');
    const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(t);
    const communes = COMMUNES.filter((c) => has(c)).map((c) => ({ type: 'COMMUNE', libelle: c, lien: `/poste-de-decision/communes?commune=${encodeURIComponent(c)}` }));
    const recettes = this.ctx.rules.rules.find((r) => ['ACTIVE', 'PUBLIEE'].includes(r.status) && (has(r.label) || has(r.code))).slice(0, 20).map((r) => ({ type: 'RECETTE', libelle: `${r.code} — ${r.label}`, lien: '/referentiel/recettes' }));
    const decisionPost = u.roles.some((r) => ROLES_POSTE_DECISION.includes(r));
    const fiches = decisionPost ? this.s.corbeille(u, { accueil: true }).fiches.filter((f) => has(f.objet) || has(f.categorie?.libelle)).map((f) => ({ type: 'DOSSIER', libelle: f.objet, lien: `/poste-de-decision/fiche/${encodeURIComponent(f.id)}` })) : [];
    const travail = profil === 'AUTORITE_HABILITEE' ? [] : this.fileDeTravail(u).filter((w) => has(w.objet)).slice(0, 20).map((w) => ({ type: 'DOSSIER', libelle: w.objet, lien: w.ecran }));
    const decisions = this.historique(u).filter((g) => has(g.objet) || has(g.motif)).map((g) => ({ type: 'DECISION', libelle: `${g.geste} — ${g.objet}`, lien: '/poste-de-decision/decisions' }));
    const actes = (profil === 'SECRETAIRE_EXECUTIF' || profil === 'DIRECTEUR_CABINET' || profil === 'MINISTRE') ? this.lignesExecution(u).filter((e) => has(e.acteLibelle) || has(e.responsable.libelle)).slice(0, 20).map((e) => ({ type: 'ACTE', libelle: e.acteLibelle, lien: '/poste-de-decision/execution' })) : [];
    this.s.audit(u, 'postes.recherche', 'poste', 'recherche', { longueur: t.length });
    return { q, resultats: [...fiches, ...decisions, ...communes, ...recettes, ...travail, ...actes].slice(0, 60), note: 'Recherche dans votre seul périmètre (habilitations inchangées).' };
  }

  // ————————————————————————— indicateur : taille des corbeilles (§ 27.4) —————————————————————————

  indicateurs(u: User) {
    authorize(u, 'postes:indicateurs.read');
    const seuil = this.s.param('postes.corbeille.taille_alerte');
    const jours = this.s.param('postes.corbeille.alerte_jours');
    const autorites = this.ctx.users.all().filter((x) => x.roles.some((r) => ['R01', 'R02', 'R03', 'R04', 'R05'].includes(r)));
    return {
      regle: FILTRE_EST_LA_FONCTION, seuil, jours, statut: PAR_DEFAUT,
      autorites: autorites.map((a) => {
        const taille = this.s.corbeilleItems(a).fiches.length;
        const hist = this.s.tailles.find((t) => t.userId === a.id).sort((x, y) => (x.jour < y.jour ? 1 : -1));
        const consecutifs = (() => { let n = 0; for (const h of hist) { if (h.taille > seuil) n++; else break; } return n; })();
        return {
          userId: a.id, nom: a.name, role: ROLES[a.roles[0]!], taille, historique: hist.slice(0, 30), joursConsecutifsAuDela: consecutifs, alerte: consecutifs >= jours,
          chiffre: chiffre({ code: 'TAILLE_CORBEILLE', libelle: 'Éléments présentés', valeur: String(taille), unite: 'éléments', etat: 'COMPTAGE', estimation: false, date: this.s.now(),
            comparaison: { type: 'SEUIL', libelle: 'Une dizaine d’éléments au plus', valeur: String(seuil), ecart: String(taille - seuil), tendance: 'INDISPONIBLE' },
            source: { libelle: 'Corbeilles des autorités', chemin: ['/poste-de-decision', '/poste-de-decision/indicateurs'], api: '/v1/postes/indicateurs' } }),
        };
      }),
    };
  }

  // ————————————————————————— note du lundi (§ 27.5) —————————————————————————

  contenuNote(u: User, semaine: { code: string; lundi: string; dimanche: string }) {
    const profil = this.s.profilDe(u);
    const entities = this.s.provinceEntiere(u) ? null : [...this.s.entitesDe(u)];
    const fin = semaine.dimanche < this.s.today() ? semaine.dimanche : this.s.today();
    const f: Filters = { from: semaine.lundi, to: fin };
    const p: Filters = { from: ajouterJours(semaine.lundi, -7), to: ajouterJours(fin, -7) };
    const map: [string, EtatChiffre, RevenueLadderLevel][] = [['POTENTIEL', 'POTENTIEL_ESTIME', 'potential'], ['CONSTATE', 'CONSTATE', 'assessed'], ['ENCAISSE', 'ENCAISSE', 'confirmed'], ['REGLE', 'REGLE', 'settled'], ['RAPPROCHE', 'RAPPROCHE', 'reconciled'], ['DISPONIBLE', 'DISPONIBLE', 'available']];
    const recettes = map.map(([code, etat, lv]) => {
      const cur = this.sommeEntites(entities, f, lv); const prev = this.sommeEntites(entities, p, lv);
      const ch = this.s.montant(code, `${ETAT_LABELS[etat]} — semaine ${semaine.code}`, cur !== null ? moneyCdf(cur) : null, etat,
        { type: 'PERIODE_PRECEDENTE', libelle: 'Semaine précédente', valeur: prev !== null ? `${prev}.00` : null, ecart: cur !== null && prev !== null && prev > 0n ? `${pct(Number(cur - prev), Number(prev))} %` : null, tendance: cur === null || prev === null ? 'INDISPONIBLE' : cur > prev ? 'HAUSSE' : cur < prev ? 'BAISSE' : 'STABLE' },
        { libelle: 'Échelle unifiée de la recette (pilotage)', chemin: ['/poste-de-decision/note', '/pilotage/indicateurs', `/pilotage/tableaux?niveau=${lv}`], api: '/v1/pilotage/echelle' }, { estimation: etat === 'POTENTIEL_ESTIME' });
      return { ...ch, date: `${fin}T23:59:59.000Z`, ...(cur === null ? { valeur: null, equivalents: { CDF: null, USD: null } } : {}) };
    });
    // Communes : classement sur l'assignation certifiée, sinon variation du rapproché sur la semaine précédente.
    let base = 'Aucune assignation certifiée : classement selon la variation du rapproché par rapport à la semaine précédente.';
    let classement: { commune: string; valeur: string | null }[] = [];
    try {
      const g = this.plan?.gapMap(u, { year: this.annee() });
      if (g?.certified) { base = 'Classement selon le taux de réalisation de l’assignation certifiée.'; classement = g.byCommune.filter((c) => c.ratePctCdf !== null).map((c) => ({ commune: c.commune, valeur: c.ratePctCdf })); }
    } catch { /* non mesuré */ }
    if (!classement.length && this.pil) {
      const conv = (m: MoneyJSON) => this.ctx.fx.convert(m, 'CDF').amount;
      const facts = this.pil.facts();
      const cur = new Map(drill('commune', { facts, filters: f, convert: conv, verifiedObjects: 0 }).rows.map((r) => [r.key, Number((r.values.reconciled as { consolidatedCdf: MoneyJSON }).consolidatedCdf.amount)]));
      const prev = new Map(drill('commune', { facts, filters: p, convert: conv, verifiedObjects: 0 }).rows.map((r) => [r.key, Number((r.values.reconciled as { consolidatedCdf: MoneyJSON }).consolidatedCdf.amount)]));
      classement = [...new Set([...cur.keys(), ...prev.keys()])].filter((c) => (COMMUNES as readonly string[]).includes(c)).map((c) => ({ commune: c, valeur: ((cur.get(c) ?? 0) - (prev.get(c) ?? 0)).toFixed(2) }));
    }
    classement.sort((a, b) => Number(b.valeur) - Number(a.valeur) || a.commune.localeCompare(b.commune, 'fr'));
    const gestes = this.s.gestes.find((g) => g.userId === u.id && g.at.slice(0, 10) >= semaine.lundi && g.at.slice(0, 10) <= semaine.dimanche && ['APPROUVER', 'REFUSER', 'DELEGUER', 'COMPLEMENT'].includes(g.geste))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id)));
    const execs = this.lignesExecution(u);
    const fiches = u.roles.some((r) => ROLES_POSTE_DECISION.includes(r)) ? this.s.corbeille(u, { accueil: true }).fiches : [];
    const al = this.alertes(u, 20).items;
    let kpis: KpiResult[];
    try { const sc = this.pil?.filtersFor(u, {}); kpis = sc ? this.pil!.computeKpis(sc.filters) : []; } catch { kpis = []; }
    return {
      titre: 'La note du lundi', semaine, arreteAu: fin, autorite: this.s.userName(u.id), profil,
      sources: ['Échelle unifiée de la recette (pilotage)', 'Assignations certifiées (planification)', 'Journal des gestes des postes de décision', 'Alertes (intégrité)', 'Catalogue des indicateurs (§ 40)'],
      decisions: gestes.map((g) => ({ date: g.at.slice(0, 10), geste: g.geste, objet: g.objet, motif: g.motif, ...(g.parDelegationDe ? { parDelegationDe: g.parDelegationDe } : {}),
        effet: execs.find((e) => e.decision.ficheId === g.ficheId)?.etatLabel ?? (g.geste === 'APPROUVER' ? 'Appliquée par la source' : g.geste === 'DELEGUER' ? 'Déléguée' : g.geste === 'COMPLEMENT' ? 'Complément attendu' : 'Refusée') })),
      recettes, communes: { base, enAvance: classement.slice(0, 3), enRetard: classement.slice(-3).reverse(), source: 'Pilotage — assignations et échelle' },
      alertes: al.map((a) => ({ cause: a.cause, ageJours: a.ageJours, type: a.type })),
      echeances7j: fiches.filter((x) => x.echeance.joursRestants <= 7).map((x) => ({ objet: x.objet, echeance: x.echeance.date, categorie: x.categorie?.libelle ?? null, joursRestants: x.echeance.joursRestants })),
      remontees: fiches.filter((x) => x.presence.includes('REMONTEE')).map((x) => ({ objet: x.objet, raisons: x.remontee?.raisons ?? [] })),
      indicateursHorsCible: kpis.filter((k) => k.status === 'NON_ATTEINTE').map((k) => ({ code: k.code, libelle: k.label, valeur: k.value, cible: k.targetLabel, source: k.source })),
      ia: 'Note déterministe, produite sans IA : aucune synthèse automatique n’est ajoutée.',
    };
  }

  produireNote(u: User, par: 'SYSTEME' | 'PERSONNE') {
    const semaine = semaineKinshasa(this.s.today());
    const contenu = this.contenuNote(u, semaine);
    const sha256 = this.s.empreinte(contenu);
    const version = this.notesDe(u.id).filter((n) => n.semaine.code === semaine.code).length + 1;
    const n = { id: this.s.ids.next('NOTE'), userId: u.id, semaine, produiteLe: this.s.now(), produitePar: par === 'SYSTEME' ? 'production automatique' : u.id, version, sha256, contenu };
    this.notesRepo().append(n);
    this.s.audit(par === 'SYSTEME' ? 'system' : u, 'postes.note.produite', 'note_hebdomadaire', n.id, { userId: u.id, semaine: semaine.code, sha256, version });
    return n;
  }

  // Conversion justifiée : le dépôt des notes est déclaré sous un type générique par le service ; contenu NoteHebdo.
  notesRepo() { return this.s.notes as unknown as InMemoryAppendOnlyRepository<NoteHebdo>; }
  notesDe(userId: string) { return this.notesRepo().find((n) => n.userId === userId); }

  /** Note courante : produite automatiquement une fois par semaine, historique conservé. */
  notes(u: User) {
    const profil = this.s.profilDe(u);
    if (!profil || profil === 'AUTORITE_HABILITEE') throw forbidden('PAS_DE_NOTE', 'La note du lundi accompagne les postes de décision.');
    authorize(u, 'postes:decision.read');
    const semaine = semaineKinshasa(this.s.today());
    if (!this.notesDe(u.id).some((n) => n.semaine.code === semaine.code)) this.produireNote(u, 'SYSTEME');
    const all = this.notesDe(u.id).sort((a, b) => (a.produiteLe < b.produiteLe ? 1 : -1));
    return { courante: all[0], historique: all.map(({ contenu: _c, ...m }) => m), horsConnexion: 'Consultable hors connexion : la note courante est conservée sur l’appareil.' };
  }

  note(u: User, id: string) {
    authorize(u, 'postes:decision.read');
    const n = this.notesRepo().get(id);
    if (!n || n.userId !== u.id) throw notFound('NOTE_INCONNUE', `Note inconnue : ${id}.`);
    return n;
  }

  // ————————————————————————— exports (§ 27.10 règle 7) —————————————————————————

  chiffresAccueil(u: User, vue?: string): Chiffre[] {
    const a = (vue ? this.vue(u, vue) : this.accueil(u)) as Record<string, unknown>;
    const out: Chiffre[] = [];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        // Conversion justifiée : forme d'un chiffre vérifiée champ par champ juste avant (garde de type manuelle).
        if (typeof o.etat === 'string' && 'comparaison' in o && 'source' in o && typeof o.code === 'string') { out.push(o as unknown as Chiffre); return; }
        Object.values(o).forEach(visit);
      }
    };
    visit(a);
    return out;
  }

  exportCsv(rows: Chiffre[]): string {
    const esc = (x: string) => { const s = /^[=+\-@]/.test(x) ? `'${x}` : x; return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [COLONNES_EXPORT.join(';'), ...rows.map((r) => ligneExport(r).map(esc).join(';'))].join('\n');
  }

  exportHtml(titre: string, rows: Chiffre[], extra = ''): string {
    const h = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const lignes = rows.map((r) => `<tr class="${r.estimation ? 'estimation' : ''}${r.exemple ? ' exemple' : ''}">${ligneExport(r).map((c) => `<td>${h(c)}</td>`).join('')}</tr>`).join('');
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${h(titre)}</title><style>body{font-family:sans-serif;font-size:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:3px}.estimation td{font-style:italic;background:#fff7e0}.exemple td{border-style:dashed;color:#555}</style></head><body><h1>${h(titre)}</h1><p>Chaque chiffre conserve son état, sa date de production et son taux de conversion (§ 27.10). Les estimations sont en italique ; les illustrations ${EXEMPLE} sont en pointillés.</p>${extra}<table><thead><tr>${COLONNES_EXPORT.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${lignes}</tbody></table><p>${h(PIED_POSTES)}</p></body></html>`;
  }

  // ————————————————————————— référentiel (§ 27) —————————————————————————

  referentiel() {
    return {
      catalogue: CATALOGUE_POSTES, familles: FAMILLES, habilitations: HABILITATIONS_INCHANGEES, quatreRegles: QUATRE_REGLES, budgets: BUDGETS_ATTENTION, troisEcrans: TROIS_ECRANS,
      testAcceptation: TEST_ACCEPTATION_90S, blocsFiche: BLOCS_FICHE, categories: CATEGORIES, jamaisRemonte: JAMAIS_REMONTE, filtre: FILTRE_EST_LA_FONCTION, menus: MENUS,
      reglesChiffres: REGLES_CHIFFRES, jamaisSurEcranExecutif: JAMAIS_SUR_ECRAN_EXECUTIF, postesTravail: POSTES_TRAVAIL, deuxFamilles: DEUX_FAMILLES_SEPAREES, regles: REGLES_ECRANS, reperes: REPERES,
      statutValeurs: PAR_DEFAUT,
    };
  }
}
