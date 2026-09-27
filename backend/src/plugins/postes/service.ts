/**
 * Postes de décision des autorités (Cahier nouvelle version, ch. 27 ; modules n° 41 à 44 du catalogue) — service.
 *
 * Il PRÉSENTE ce qui attend une décision ; il ne décide jamais par lui-même et ne modifie aucune habilitation :
 *  - la corbeille relit les éléments en attente des modules sources (sources.ts) et les dossiers d'orientation instruits
 *    par les services (fiches à neuf blocs du § 27.3) ; seuls les dix catégories du § 27.4 l'atteignent, au-delà de
 *    leurs seuils (registre des seuils, deux personnes) ;
 *  - « Approuver » et « Refuser » passent par la route de décision EXISTANTE de la source (relais interne, mêmes gardes,
 *    mêmes quatre yeux) ; aucune route qui modifie une dette, un paiement, une quittance ou un compte bénéficiaire n'est
 *    jamais relayée (§ 27.12) ;
 *  - la délégation route une catégorie ou une fiche vers une personne nommée de rang inférieur, pour une durée et un
 *    périmètre déclarés ; elle expire d'elle-même, se révoque, et ne confère jamais plus que les droits du délégant :
 *    pour un élément d'un module source, le délégataire décide avec SES propres droits (la matrice n'est pas modifiée) ;
 *  - chaque geste (décision, refus, délégation, complément, report, préparation, relance) est motivé et journalisé.
 */
import { ROLES, type MoneyJSON, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { ACR, requireAcr, type User } from '../../core/auth.js';
import { kinshasaDay } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { FX_SOURCE } from '../../modules/fx/service.js';
import {
  ACTE_LABELS, ACTION_LABELS, ajouterJours, CATEGORIES, categorieDef, chiffre, estAgentPublic, estRouteFinanciere, ETAT_EXECUTION_LABELS, ETAT_PREPARATION_LABELS,
  EXEMPLE, GRAVITE_RANG, joursEntre, MOTIF_MIN, NATURES_REFUSEES, PARENT_REMONTEE, POSITION_MAX, rangDe, ROLES_POSTE_DECISION, trancheMontant,
  type ActeAProduire, type ActionFiche, type ActionOrdre, type ActionPreparation, type CategorieDecision, type Chiffre, type EtatChiffre, type EtatExecution,
  type EtatPreparation, type Gravite, type ProfilPoste, type Taux,
} from './model.js';
import { posteParam } from './parametres.js';
import { rolesDeciders, Sources, type Forward, type SourceItem } from './sources.js';

// ————————————————————————— enregistrements —————————————————————————

export interface DossierOrientation {
  id: string;
  categorie: CategorieDecision;
  destinataireRole: RoleCode;
  /** Entité du destinataire (ministère) : périmètre de la corbeille. */
  destinataireEntity?: string;
  objet: string;
  demandeur: { userId: string; libelle: string };
  serviceInstructeur: string;
  validationAmont: string | null;
  enjeu: { texte: string; montant?: MoneyJSON; etat: EtatChiffre; nombre?: string; commune?: string; figures?: { libelle: string; valeur: string; unite: string }[] };
  echeance: string;
  consequenceSilence: string;
  fondement: string[];
  position: { recommandation: string; reserves: string[] };
  siRien: string;
  pieces: { libelle: string; reference?: string; sha256?: string }[];
  libellesActions?: Partial<Record<ActionFiche, string>>;
  delegationSuggeree?: { userId: string; libelle: string };
  execution: { acte: ActeAProduire; libelle: string; responsable: { entity: string; role?: RoleCode; userId?: string; libelle: string }; delaiJours: number; lien?: { type: 'CENTRE_SUSPENSION'; centreId: string } };
  individuel: boolean;
  finaliteNominative?: string;
  /** Ce qui manque au dossier (vu par le cabinet : « avis juridique manquant », « base légale non produite »…). */
  manque?: string;
  preparation: EtatPreparation;
  /** Transmis à la corbeille du Gouverneur par le cabinet (§ 27.6) ; sans objet pour les autres destinataires. */
  transmis: boolean;
  statut: 'EN_ATTENTE' | 'APPROUVE' | 'REFUSE';
  complements: { by: string; at: string; motif: string; reponse?: { by: string; at: string; texte: string } }[];
  journal: { at: string; by: string; action: string; motif: string }[];
  decision?: { by: string; at: string; approve: boolean; motif: string; delegationId?: string; parDelegationDe?: string };
  entities: string[];
  createdBy: string;
  createdAt: string;
  exemple?: boolean;
}

export interface Delegation {
  id: string;
  delegantId: string;
  delegataireId: string;
  categorie: CategorieDecision;
  /** Portée limitée à une fiche (sinon toute la catégorie, dans le périmètre du délégant). */
  ficheId?: string;
  perimetre: string;
  motif: string;
  debut: string;
  fin: string;
  statut: 'PROGRAMMEE' | 'ACTIVE' | 'EXPIREE' | 'REVOQUEE';
  creeLe: string;
  revocation?: { by: string; at: string; motif: string };
}

export interface GesteRecord {
  id: string;
  at: string;
  userId: string;
  ficheId: string;
  objet: string;
  categorie: CategorieDecision | null;
  geste: ActionFiche | ActionOrdre | ActionPreparation | 'RELANCE' | 'JUSTIFICATION';
  motif: string;
  resultat: 'ENREGISTRE' | 'REFUSE_PAR_LA_SOURCE';
  parDelegationDe?: string;
  delegationId?: string;
  route?: string;
}

export interface OrdreEntry { id: string; decalage: number; differeJusquau?: string; historique: { at: string; by: string; action: ActionOrdre; motif: string; reexamenLe?: string }[] }

export interface Execution {
  id: string;
  decision: { objet: string; date: string; autorite: string; autoriteId?: string; ficheId?: string };
  acte: ActeAProduire;
  acteLibelle: string;
  responsable: { entity: string; role?: RoleCode; userId?: string; libelle: string };
  echeance: string;
  etat: EtatExecution;
  note?: string;
  blocage?: { cause: string; declareLe: string; declarePar: string };
  preuve?: { reference: string; sha256?: string; version?: string; publieLe?: string };
  executeLe?: string;
  lien?: { type: 'CENTRE_SUSPENSION'; centreId: string };
  historique: { at: string; by: string; etat: EtatExecution; motif: string }[];
  relances: { at: string; by: string; motif: string }[];
  justifications: { at: string; by: string; texte: string }[];
  exemple?: boolean;
}

export interface Habilitation {
  id: string;
  userId: string;
  perimetre: { libelle: string; entities: string[]; communes: string[]; categories: string[] };
  du: string;
  au: string;
  declarePar: string;
  declareLe: string;
  motif: string;
  renouvellements: { at: string; by: string; ancienneFin: string; nouvelleFin: string; motif: string }[];
}

export interface Illustration { id: string; profil: ProfilPoste; bloc: string; ordre: number; chiffre?: Chiffre; texte?: { titre: string; detail: string; enjeu?: string } ; ministere?: string }

export interface NotificationPoste { id: string; userId: string; at: string; jour: string; type: 'DECISION_URGENTE' | 'ALERTE_MONTANT' | 'DELAI_EXPIRANT' | 'SYNTHESE'; texte: string; cle: string }

/** Fiche présentée (§ 27.3) : neuf blocs, identiques quelle que soit la nature du dossier. */
export interface Fiche {
  id: string;
  source: string;
  module: string;
  categorie: { code: CategorieDecision; libelle: string; niveau: string } | null;
  presence: ('DECIDEUR' | 'DELEGATION' | 'NIVEAU_HABITUEL' | 'REMONTEE')[];
  remontee?: { niveau: number; raisons: string[] };
  delegation?: { id: string; delegantId: string; delegant: string };
  objet: string;
  demandeur: { id: string | null; libelle: string; serviceInstructeur: string; validationAmont: string | null };
  enjeu: { texte: string; chiffres: Chiffre[]; nombre: string | null; commune: string | null; figures: { libelle: string; valeur: string; unite: string }[] };
  echeance: { date: string; joursRestants: number; urgente: boolean; enRetard: boolean; consequenceSilence: string };
  fondement: string[];
  position: { recommandation: string; reserves: string[] };
  siRienNestDecide: string;
  pieces: { replie: true; nombre: number; items: { libelle: string; reference?: string; sha256?: string }[] };
  actions: { code: ActionFiche; libelle: string; possible: boolean; raison?: string; motifObligatoire: true }[];
  delegationSuggeree?: { userId: string; libelle: string };
  individuel: boolean;
  information: boolean;
  gravite: Gravite;
  complements: { at: string; motif: string; repondu: boolean }[];
  ecran: string;
  exemple: boolean;
  /** Clé de tri : enjeu en contre-valeur CDF (0 si non chiffré). */
  enjeuCdf: string;
}

interface Item extends SourceItem { dossier?: DossierOrientation }

const PROVINCE_ROLES: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R17', 'R18', 'R22', 'R23', 'R24', 'R16', 'R21', 'R13', 'R14', 'R15', 'R19', 'R25', 'R26', 'R27', 'R28', 'R29'];
const GOUVERNEUR: User = { kind: 'user', id: 'poste:gouverneur', name: 'Gouverneur (corbeille)', roles: ['R01'], entity: 'GOUVERNORAT' };

export class PostesService {
  readonly dossiers = new InMemoryRepository<DossierOrientation>();
  readonly delegations = new InMemoryRepository<Delegation>();
  readonly gestes = new InMemoryAppendOnlyRepository<GesteRecord>();
  readonly ordre = new InMemoryRepository<OrdreEntry>();
  readonly executions = new InMemoryRepository<Execution>();
  readonly habilitations = new InMemoryRepository<Habilitation>();
  readonly consultations = new InMemoryAppendOnlyRepository<{ id: string; userId: string; at: string; vue: string }>();
  readonly illustrations = new InMemoryRepository<Illustration>();
  readonly notifications = new InMemoryAppendOnlyRepository<NotificationPoste>();
  readonly preferences = new InMemoryRepository<{ id: string; plafondJournalier: number; fixeLe: string }>();
  readonly tailles = new InMemoryRepository<{ id: string; userId: string; jour: string; taille: number }>();
  /** Notes du lundi produites (historique conservé, empreinte SHA-256 de chaque version). */
  readonly notes = new InMemoryAppendOnlyRepository<{ id: string; userId: string; semaine: { code: string; lundi: string; dimanche: string }; produiteLe: string; produitePar: string; version: number; sha256: string; contenu: unknown }>();
  readonly sources: Sources;
  readonly ids = new IdGenerator();

  constructor(readonly ctx: AppContext) {
    this.sources = new Sources(ctx);
  }

  // ————————————————————————— utilitaires —————————————————————————

  now(): string { return this.ctx.clock.now().toISOString(); }
  today(): string { return kinshasaDay(this.now()); }
  param(id: string): number { return posteParam(this.ctx, id); }
  audit(user: User | 'system', action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}, outcome?: 'DENIED') {
    const actor = user === 'system' ? { kind: 'system' as const, id: 'postes:production-automatique' } : { kind: 'user' as const, id: user.id, roles: user.roles };
    this.ctx.audit.append({ actor, action, resourceType, resourceId, details, ...(outcome ? { outcome } : {}) });
  }
  userName(id: string | null | undefined): string { return this.sources.userLabel(id); }
  private get acces(): { subtree(root: string): Set<string>; entities: { get(id: string): { name: string } | undefined; all(): { id: string; name: string; shortName: string; kind: string; parentId: string | null }[] } } | undefined {
    return this.ctx.ext.acces as never;
  }
  /** Entités du périmètre d'une personne (sous-arbre de son entité dans l'espace des entités). */
  entitesDe(u: User): Set<string> {
    const a = this.acces;
    const s = a ? a.subtree(u.entity) : new Set<string>();
    s.add(u.entity);
    return s;
  }
  provinceEntiere(u: User): boolean { return u.roles.some((r) => PROVINCE_ROLES.includes(r)); }
  dansPerimetre(u: User, entities: string[]): boolean {
    if (this.provinceEntiere(u)) return true;
    if (!entities.length) return false;
    const mine = this.entitesDe(u);
    return entities.some((e) => mine.has(e));
  }
  toCdf(m: MoneyJSON): bigint {
    const cdf = m.currency === 'CDF' ? m : this.ctx.fx.convert(m, 'CDF').amount;
    return BigInt(Math.trunc(Number(cdf.amount)));
  }
  taux(): Taux {
    const d = this.today();
    return { devise: 'USD', cdfParUnite: this.ctx.fx.rate('USD', 'CDF', d), date: d, source: FX_SOURCE, nature: 'Taux indicatif affiché (le taux budgétaire de l’exercice n’est pas intégré à la plateforme) — PAR_DEFAUT — à confirmer par le maître d’ouvrage' };
  }
  /** Chiffre monétaire en CDF et USD, avec taux (§ 27.10). */
  montant(code: string, libelle: string, m: MoneyJSON | null, etat: EtatChiffre, comparaison: Chiffre['comparaison'], source: Chiffre['source'], opts: { exemple?: boolean; estimation?: boolean } = {}): Chiffre {
    const cdf = m ? (m.currency === 'CDF' ? m.amount : this.ctx.fx.convert(m, 'CDF').amount.amount) : null;
    const usd = cdf !== null ? this.ctx.fx.convert({ amount: cdf, currency: 'CDF' }, 'USD').amount.amount : null;
    return chiffre({
      code, libelle, valeur: cdf, unite: 'CDF', etat, estimation: opts.estimation ?? etat === 'POTENTIEL_ESTIME', date: this.now(),
      equivalents: { CDF: cdf, USD: usd }, taux: this.taux(), comparaison, source, ...(opts.exemple ? { exemple: true } : {}),
    });
  }

  profilDe(u: User): ProfilPoste | null {
    if (u.roles.includes('R01')) return 'GOUVERNEUR';
    if (u.roles.includes('R02')) return 'DIRECTEUR_CABINET';
    if (u.roles.includes('R03')) return 'SECRETAIRE_EXECUTIF';
    if (u.roles.includes('R04') || u.roles.includes('R05')) return 'MINISTRE';
    if (u.roles.includes('R06') || u.roles.includes('R07')) return 'DIRECTION_REGIE';
    if (this.habilitationDe(u.id)) return 'AUTORITE_HABILITEE';
    return null;
  }

  habilitationDe(userId: string): Habilitation | undefined {
    return this.habilitations.find((h) => h.userId === userId).sort((a, b) => (a.au < b.au ? 1 : -1))[0];
  }

  // ————————————————————————— délégations : balayage des échéances —————————————————————————

  sweep(): void {
    const today = this.today();
    for (const d of this.delegations.all()) {
      if (d.statut === 'PROGRAMMEE' && d.debut <= today && d.fin > today) this.delegations.update({ ...d, statut: 'ACTIVE' });
      else if ((d.statut === 'ACTIVE' || d.statut === 'PROGRAMMEE') && d.fin <= today) {
        this.delegations.update({ ...d, statut: 'EXPIREE' });
        this.audit('system', 'postes.delegation.expiree', 'delegation', d.id, { delegantId: d.delegantId, delegataireId: d.delegataireId, categorie: d.categorie, fin: d.fin, note: 'Expiration automatique à l’échéance, sans action humaine.' });
      }
    }
  }

  delegationsActivesPour(delegataireId: string): Delegation[] {
    this.sweep();
    return this.delegations.find((d) => d.delegataireId === delegataireId && d.statut === 'ACTIVE');
  }

  // ————————————————————————— éléments (sources + dossiers d'orientation) —————————————————————————

  private dossierItem(d: DossierOrientation): Item {
    return {
      id: `DOSSIER:${d.id}`, source: 'DOSSIER', sourceId: d.id, module: 'Postes de décision — dossiers instruits', categorie: d.categorie, objet: d.objet,
      demandeurId: d.demandeur.userId, serviceInstructeur: d.serviceInstructeur, validationAmont: d.validationAmont, date: d.createdAt, echeance: d.echeance,
      enjeu: { montant: d.enjeu.montant ?? null, etat: d.enjeu.etat, nombre: d.enjeu.nombre ?? null, commune: d.enjeu.commune ?? null, texte: d.enjeu.texte },
      entities: d.entities, fondement: d.fondement, position: d.position, siRien: d.siRien, pieces: d.pieces, individuel: d.individuel,
      gravite: categorieDef(d.categorie)?.gravite ?? 'NORMALE', deciderAction: null,
      eligible: (u) => d.statut === 'EN_ATTENTE' && u.roles.includes(d.destinataireRole) && (d.destinataireRole !== 'R01' || d.transmis)
        && (!d.destinataireEntity || this.entitesDe(u).has(d.destinataireEntity) || this.provinceEntiere(u)) && u.id !== d.createdBy && u.id !== d.demandeur.userId,
      ecran: `/poste-de-decision/fiche/${encodeURIComponent(`DOSSIER:${d.id}`)}`, ...(d.exemple ? { exemple: true } : {}), dossier: d,
    };
  }

  items(): Item[] {
    const seuil = this.param('postes.seuil.exoneration_degrevement_cdf');
    const src: Item[] = this.sources.collect({ seuilExonerationCdf: seuil, toCdf: (m) => this.toCdf(m) });
    return [...src, ...this.dossiers.find((d) => d.statut === 'EN_ATTENTE').map((d) => this.dossierItem(d))];
  }

  /** Seuil de la catégorie : l'élément ne remonte qu'au-delà (0 = tout élément de la catégorie). */
  private auDelaDuSeuil(it: Item): boolean {
    if (!it.categorie) return false;
    const def = categorieDef(it.categorie)!;
    const s = this.param(def.seuil);
    if (s <= 0) return true;
    if (!it.enjeu.montant) return it.source === 'DOSSIER'; // dossier instruit : le service atteste le dépassement du seuil
    return this.toCdf(it.enjeu.montant) >= BigInt(Math.trunc(s));
  }

  private echeanceDe(it: Item): string { return it.echeance ?? ajouterJours(it.date.slice(0, 10), this.param('postes.fiche.delai_defaut_jours')); }

  /** Remontée : ancienneté, enjeu, gravité → niveau 0, 1 ou 2 au-dessus des décideurs d'origine (qui gardent l'élément). */
  remontee(it: Item): { niveau: number; raisons: string[]; roles: RoleCode[] } {
    const today = this.today();
    const age = joursEntre(it.date.slice(0, 10), today);
    const raisons: string[] = [];
    let n = 0;
    const a1 = this.param('postes.remontee.age_n1_jours'), a2 = this.param('postes.remontee.age_n2_jours');
    if (age >= a2) { n = 2; raisons.push(`En attente depuis ${age} jours (seuil ${a2} j)`); } else if (age >= a1) { n = 1; raisons.push(`En attente depuis ${age} jours (seuil ${a1} j)`); }
    if (it.enjeu.montant) {
      const cdf = this.toCdf(it.enjeu.montant);
      const m1 = this.param('postes.remontee.montant_n1_cdf'), m2 = this.param('postes.remontee.montant_n2_cdf');
      if (m2 > 0 && cdf >= BigInt(Math.trunc(m2))) { n = Math.max(n, 2); raisons.push(`Enjeu au-delà de ${m2.toLocaleString('fr-FR')} CDF`); } else if (m1 > 0 && cdf >= BigInt(Math.trunc(m1))) { n = Math.max(n, 1); raisons.push(`Enjeu au-delà de ${m1.toLocaleString('fr-FR')} CDF`); }
    }
    const overdue = this.echeanceDe(it) < today;
    const grav = Math.min(3, GRAVITE_RANG[it.gravite] + (overdue ? 1 : 0));
    if (grav >= this.param('postes.remontee.gravite_min')) { n = Math.max(n, 1); raisons.push(overdue ? 'Échéance dépassée (gravité relevée)' : `Gravité ${it.gravite.toLowerCase()}`); }
    if (n === 0) return { niveau: 0, raisons: [], roles: [] };
    const deciders = new Set<RoleCode>(it.dossier ? [it.dossier.destinataireRole] : rolesDeciders(it.deciderAction, it.entities));
    const lvl1 = new Set<RoleCode>([...deciders].map((r) => PARENT_REMONTEE[r]).filter((r): r is RoleCode => !!r && !deciders.has(r)));
    const lvl2 = new Set<RoleCode>([...lvl1].map((r) => PARENT_REMONTEE[r]).filter((r): r is RoleCode => !!r && !deciders.has(r) && !lvl1.has(r)));
    return { niveau: n, raisons, roles: [...lvl1, ...(n >= 2 ? lvl2 : [])] };
  }

  /** L'élément est-il présentable (fondement affiché) ? « Aucune décision sans base légale affichée. » */
  presentable(it: Item): boolean { return it.fondement.filter((f) => f.trim()).length > 0 && (!it.dossier || (it.dossier.preparation === 'INSTRUIT')); }

  /**
   * Corbeille d'une personne : seules les dix catégories, au-delà de leurs seuils, présentables, dans son périmètre.
   * Présence : décideur (selon la source), délégation, niveau habituel de la catégorie, remontée (lecture et relance).
   */
  corbeilleItems(u: User): { fiches: { it: Item; presence: Fiche['presence']; remontee?: { niveau: number; raisons: string[] }; delegation?: Delegation }[]; nonPresentables: Item[]; differes: { it: Item; jusquau: string }[] } {
    const items = this.items();
    const decisionPost = u.roles.some((r) => ROLES_POSTE_DECISION.includes(r));
    const delegs = this.delegationsActivesPour(u.id);
    const today = this.today();
    const out: { it: Item; presence: Fiche['presence']; remontee?: { niveau: number; raisons: string[] }; delegation?: Delegation }[] = [];
    const nonPresentables: Item[] = [];
    const differes: { it: Item; jusquau: string }[] = [];
    for (const it of items) {
      if (!it.categorie || !this.auDelaDuSeuil(it)) continue;
      const def = categorieDef(it.categorie)!;
      const presence: Fiche['presence'] = [];
      const inScope = this.dansPerimetre(u, it.entities) || (!!it.dossier?.destinataireEntity && this.entitesDe(u).has(it.dossier.destinataireEntity));
      // Dossier adressé au Gouverneur : il n'atteint sa corbeille qu'une fois transmis par le cabinet (§ 27.6).
      const retenuParLeCabinet = !!it.dossier && it.dossier.destinataireRole === 'R01' && !it.dossier.transmis && u.roles.includes('R01');
      if (decisionPost && it.eligible(u)) presence.push('DECIDEUR');
      if (decisionPost && inScope && !retenuParLeCabinet && u.roles.some((r) => def.niveauRoles.includes(r))) presence.push('NIVEAU_HABITUEL');
      let rem: { niveau: number; raisons: string[] } | undefined;
      if (decisionPost && inScope) {
        const r = this.remontee(it);
        if (r.niveau > 0 && u.roles.some((x) => r.roles.includes(x))) { presence.push('REMONTEE'); rem = { niveau: r.niveau, raisons: r.raisons }; }
      }
      let delegation: Delegation | undefined;
      for (const d of delegs) {
        if (d.categorie !== it.categorie || (d.ficheId && d.ficheId !== it.id)) continue;
        const delegant = this.ctx.users.get(d.delegantId);
        if (!delegant) continue;
        // Jamais au-delà des droits du délégant : l'élément doit figurer dans le périmètre du délégant.
        const delegantVoit = it.eligible(delegant) || (this.dansPerimetre(delegant, it.entities) && delegant.roles.some((r) => def.niveauRoles.includes(r)));
        if (delegantVoit) { delegation = d; presence.push('DELEGATION'); break; }
      }
      if (!presence.length) continue;
      if (!this.presentable(it)) { nonPresentables.push(it); continue; }
      const o = this.ordre.get(it.id);
      if (o?.differeJusquau && o.differeJusquau > today && u.roles.includes('R01')) { differes.push({ it, jusquau: o.differeJusquau }); continue; }
      out.push({ it, presence: [...new Set(presence)], ...(rem ? { remontee: rem } : {}), ...(delegation ? { delegation } : {}) });
    }
    // Tri : échéance puis enjeu ; ordonnancement du cabinet (monter / descendre) appliqué à la corbeille du Gouverneur.
    out.sort((a, b) => {
      const ea = this.echeanceDe(a.it), eb = this.echeanceDe(b.it);
      if (ea !== eb) return ea < eb ? -1 : 1;
      const ca = a.it.enjeu.montant ? this.toCdf(a.it.enjeu.montant) : 0n, cb = b.it.enjeu.montant ? this.toCdf(b.it.enjeu.montant) : 0n;
      return ca === cb ? a.it.id.localeCompare(b.it.id) : ca > cb ? -1 : 1;
    });
    if (u.roles.includes('R01')) {
      const shifted = out.map((x, i) => ({ x, rank: i - (this.ordre.get(x.it.id)?.decalage ?? 0) * 1.5 }));
      shifted.sort((a, b) => a.rank - b.rank);
      return { fiches: shifted.map((s) => s.x), nonPresentables, differes };
    }
    return { fiches: out, nonPresentables, differes };
  }

  /** Construit la fiche (§ 27.3) ; `accueil` masque toute donnée individuelle (montant exact, identité). */
  fiche(u: User, e: { it: Item; presence: Fiche['presence']; remontee?: { niveau: number; raisons: string[] }; delegation?: Delegation }, opts: { accueil: boolean } = { accueil: true }): Fiche {
    const { it } = e;
    const def = it.categorie ? categorieDef(it.categorie)! : null;
    const today = this.today();
    const echeance = this.echeanceDe(it);
    const jr = joursEntre(today, echeance);
    const dossier = it.dossier;
    const decidable = e.presence.includes('DECIDEUR') || (!!dossier && e.presence.includes('DELEGATION') && dossier.statut === 'EN_ATTENTE');
    const seuil = def ? this.param(def.seuil) : 0;
    const chiffres: Chiffre[] = [];
    if (it.enjeu.montant) {
      const comp: Chiffre['comparaison'] = { type: 'SEUIL', libelle: def ? `Seuil de remontée « ${def.libelle} »` : 'Seuil de remontée', valeur: seuil > 0 ? String(seuil) : null, ecart: null, tendance: 'INDISPONIBLE' };
      const src = { libelle: it.module, chemin: ['/poste-de-decision', `/poste-de-decision/fiche/${encodeURIComponent(it.id)}`, it.ecran].slice(0, 3), api: `/v1/postes/fiches/${encodeURIComponent(it.id)}` };
      if (it.individuel && opts.accueil) {
        // Montant individuel : jamais sur un écran d'accueil (§ 27.12) — tranche seulement.
        chiffres.push(chiffre({ code: 'ENJEU', libelle: `Enjeu : ${trancheMontant(this.toCdf(it.enjeu.montant), seuil)}`, valeur: null, unite: 'CDF', etat: it.enjeu.etat, estimation: it.enjeu.etat === 'POTENTIEL_ESTIME', date: this.now(), comparaison: comp, source: src }));
      } else {
        chiffres.push(this.montant('ENJEU', 'Enjeu', it.enjeu.montant, it.enjeu.etat, comp, src, { ...(it.exemple ? { exemple: true } : {}) }));
      }
    }
    const act = (code: ActionFiche, possible: boolean, raison?: string) => ({ code, libelle: dossier?.libellesActions?.[code] ?? ACTION_LABELS[code], possible, ...(possible ? {} : { raison: raison ?? 'Action indisponible.' }), motifObligatoire: true as const });
    const hors = it.horsPoste ?? 'Décision sur l’écran de la source.';
    const infoOnly = !decidable;
    const approvable = decidable && (!!dossier || (!!it.approuver && !estRouteFinanciere(it.approuver.url)));
    const refusable = decidable && (!!dossier || (!!it.refuser && !estRouteFinanciere(it.refuser.url)));
    const reserveDecision = infoOnly ? `Décision réservée au titulaire du droit (${rolesDeciders(it.deciderAction, it.entities).map((r) => ROLES[r]).join(', ') || (dossier ? ROLES[dossier.destinataireRole] : 'service compétent')}) : présentation seulement, les habilitations ne changent pas.` : hors;
    const complements = dossier ? dossier.complements.map((c) => ({ at: c.at, motif: c.motif, repondu: !!c.reponse })) : this.gestes.find((g) => g.ficheId === it.id && g.geste === 'COMPLEMENT').map((g) => ({ at: g.at, motif: g.motif, repondu: false }));
    return {
      id: it.id, source: it.source, module: it.module, categorie: def ? { code: def.code, libelle: def.libelle, niveau: def.niveau } : null,
      presence: e.presence, ...(e.remontee ? { remontee: e.remontee } : {}),
      ...(e.delegation ? { delegation: { id: e.delegation.id, delegantId: e.delegation.delegantId, delegant: this.userName(e.delegation.delegantId) } } : {}),
      objet: it.objet,
      demandeur: { id: it.demandeurId, libelle: dossier ? dossier.demandeur.libelle : this.userName(it.demandeurId), serviceInstructeur: it.serviceInstructeur, validationAmont: it.validationAmont },
      enjeu: { texte: it.enjeu.texte, chiffres, nombre: it.enjeu.nombre, commune: it.enjeu.commune, figures: dossier?.enjeu.figures ?? [] },
      echeance: { date: echeance, joursRestants: jr, urgente: jr <= this.param('postes.fiche.urgence_jours'), enRetard: jr < 0, consequenceSilence: dossier?.consequenceSilence ?? it.siRien },
      fondement: it.fondement, position: { recommandation: it.position.recommandation.slice(0, POSITION_MAX), reserves: it.position.reserves }, siRienNestDecide: it.siRien,
      pieces: { replie: true, nombre: it.pieces.length, items: opts.accueil && it.individuel ? [] : it.pieces },
      actions: [
        act('APPROUVER', approvable, infoOnly ? reserveDecision : hors),
        act('REFUSER', refusable, infoOnly ? reserveDecision : hors),
        act('DELEGUER', e.presence.includes('DECIDEUR') && !e.delegation && !!it.categorie, 'Seul le titulaire de la décision délègue ; un délégataire ne subdélègue pas.'),
        act('COMPLEMENT', true),
      ],
      ...(dossier?.delegationSuggeree ? { delegationSuggeree: dossier.delegationSuggeree } : {}),
      individuel: it.individuel, information: infoOnly || !!it.information, gravite: it.gravite, complements, ecran: it.ecran, exemple: !!it.exemple,
      enjeuCdf: it.enjeu.montant ? this.toCdf(it.enjeu.montant).toString() : '0',
    };
  }

  corbeille(u: User, opts: { accueil: boolean } = { accueil: true }) {
    authorize(u, 'postes:decision.read');
    const c = this.corbeilleItems(u);
    const fiches = c.fiches.map((e) => this.fiche(u, e, opts));
    this.noterTaille(u, fiches.length);
    return { fiches, nonPresentables: c.nonPresentables.length, differes: c.differes.map((d) => ({ id: d.it.id, objet: d.it.objet, reexamenLe: d.jusquau })) };
  }

  /** Taille de corbeille : indicateur suivi au même titre que les recettes (§ 27.4). */
  private noterTaille(u: User, taille: number): void {
    const jour = this.today();
    const id = `${u.id}|${jour}`;
    const prev = this.tailles.get(id);
    if (prev) this.tailles.update({ ...prev, taille });
    else this.tailles.insert({ id, userId: u.id, jour, taille });
    const seuil = this.param('postes.corbeille.taille_alerte');
    const n = this.param('postes.corbeille.alerte_jours');
    const hist = this.tailles.find((t) => t.userId === u.id).sort((a, b) => (a.jour < b.jour ? 1 : -1)).slice(0, n);
    if (hist.length >= n && hist.every((t) => t.taille > seuil) && !this.ctx.audit.list({ action: 'postes.corbeille.surcharge', resourceId: `${u.id}|${jour}`, limit: 1 }).total) {
      this.audit('system', 'postes.corbeille.surcharge', 'corbeille', `${u.id}|${jour}`, { userId: u.id, taille, seuil, jours: n, consigne: 'Revoir les seuils de délégation, pas l’écran (§ 27.4).' });
    }
  }

  /** Fiche détaillée (écran 3 — Comprendre) ; un dossier nominatif exige une finalité déclarée, journalisée. */
  ficheDetail(u: User, id: string, finalite?: string) {
    authorize(u, 'postes:decision.read');
    const e = this.corbeilleItems(u).fiches.find((x) => x.it.id === id);
    if (!e) throw notFound('FICHE_INCONNUE', `Fiche inconnue dans votre corbeille : ${id}.`);
    if (e.it.individuel) {
      if (!finalite || finalite.trim().length < MOTIF_MIN) {
        throw unprocessable('FINALITE_REQUISE', 'Dossier d’un contribuable nommément désigné : finalité déclarée, enregistrée et journalisée requise (§ 27.4).');
      }
      this.audit(u, 'postes.fiche.consultation_nominative', 'fiche', id, { finalite: finalite.trim() });
    }
    const f = this.fiche(u, e, { accueil: !e.it.individuel });
    this.audit(u, 'postes.fiche.consultee', 'fiche', id, { categorie: f.categorie?.code ?? null });
    return { fiche: f, historique: this.gestes.find((g) => g.ficheId === id) };
  }

  // ————————————————————————— sécurité des postes de décision (§ 27.11) —————————————————————————

  exigencesSecurite(u: User, device?: string) {
    const max = this.param('postes.session.duree_max_min');
    const age = u.auth ? Math.round((Date.parse(this.now()) - Date.parse(u.auth.authTime)) / 60_000) : null;
    return {
      exigences: [
        'Authentification résistante à l’hameçonnage : clé d’accès (FIDO2) pour les rôles sensibles qui en ont enregistré une, à défaut mot de passe et code TOTP (niveau MFA) — jamais un seul facteur.',
        'Appareil enregistré : empreinte d’installation transmise avec chaque session (aucune donnée personnelle).',
        `Session courte : ${max} minutes au plus pour décider (${'PAR_DEFAUT — à confirmer par le maître d’ouvrage'}).`,
      ],
      session: { niveau: u.auth?.acr ?? 'DEMONSTRATION', ageMinutes: age, dureeMaxMinutes: max, appareil: device ? 'transmis' : u.auth ? 'absent' : 'sans objet (démonstration)' },
    };
  }

  /** Gardes avant toute décision : MFA, session courte, appareil enregistré (jamais en deçà des exigences existantes). */
  garderDecision(u: User, device?: string): void {
    requireAcr(u, ACR.MFA);
    if (!u.auth) return;
    const max = this.param('postes.session.duree_max_min');
    const age = (Date.parse(this.now()) - Date.parse(u.auth.authTime)) / 60_000;
    if (age > max) throw unauthorized('SESSION_DECISION_EXPIREE', `Poste de décision : session de plus de ${max} minutes, nouvelle authentification requise avant de décider.`);
    if (!device) throw forbidden('APPAREIL_NON_ENREGISTRE', 'Poste de décision : décision depuis un appareil enregistré seulement (empreinte d’installation absente).');
  }

  // ————————————————————————— les quatre actions d'une fiche (§ 27.3) —————————————————————————

  /**
   * Prépare l'action : contrôle du motif, de la présence dans la corbeille, de la séparation des tâches. Pour une
   * approbation ou un refus d'un élément d'un module source, renvoie le relais vers la route EXISTANTE ; le plugin
   * exécute le relais puis appelle `enregistrerRelais`.
   */
  agir(u: User, ficheId: string, input: { action: ActionFiche; motif: string; delegataireId?: string; jusquau?: string; perimetre?: string }, device?: string):
    { relais: Forward & { approve: boolean }; fiche: Fiche; item: Item; delegation?: Delegation } | { resultat: unknown } {
    authorize(u, 'postes:decision.act');
    const motif = (input.motif ?? '').trim();
    if (motif.length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', `Toute issue d’une fiche est motivée (${MOTIF_MIN} caractères au moins) et journalisée.`);
    const e = this.corbeilleItems(u).fiches.find((x) => x.it.id === ficheId);
    if (!e) throw notFound('FICHE_INCONNUE', `Fiche inconnue dans votre corbeille : ${ficheId}.`);
    const f = this.fiche(u, e, { accueil: false });
    const it = e.it;
    const record = (geste: GesteRecord['geste'], extra: Partial<GesteRecord> = {}) => this.gestes.append({
      id: this.ids.next('GESTE'), at: this.now(), userId: u.id, ficheId, objet: it.objet, categorie: it.categorie, geste, motif, resultat: 'ENREGISTRE',
      ...(e.delegation ? { parDelegationDe: this.userName(e.delegation.delegantId), delegationId: e.delegation.id } : {}), ...extra,
    });
    const mention = e.delegation ? `par délégation de ${this.userName(e.delegation.delegantId)} (${e.delegation.delegantId})` : null;

    if (input.action === 'COMPLEMENT') {
      if (it.dossier) {
        const d = this.dossiers.get(it.dossier.id)!;
        this.dossiers.update({ ...d, preparation: 'INCOMPLET', transmis: d.destinataireRole === 'R01' ? false : d.transmis, complements: [...d.complements, { by: u.id, at: this.now(), motif }], journal: [...d.journal, { at: this.now(), by: u.id, action: 'COMPLEMENT', motif }] });
      }
      const g = record('COMPLEMENT');
      this.audit(u, 'postes.fiche.complement_demande', 'fiche', ficheId, { motif, categorie: it.categorie, demandeurId: it.demandeurId, ...(mention ? { mention, delegationId: e.delegation!.id } : {}) });
      if (it.demandeurId) this.notifier(it.demandeurId, 'DELAI_EXPIRANT', `Complément demandé sur « ${it.objet} »`, `complement:${g.id}`);
      return { resultat: { geste: g, message: 'Complément demandé au service ; la fiche reste en attente.' } };
    }

    if (input.action === 'DELEGUER') {
      if (!f.actions.find((a) => a.code === 'DELEGUER')?.possible) throw forbidden('DELEGATION_IMPOSSIBLE', 'Seul le titulaire de la décision délègue ; un délégataire ne subdélègue pas.');
      if (!input.delegataireId || !input.jusquau) throw badRequest('DELEGATAIRE_REQUIS', 'Délégation : personne nommée et date de fin requises.');
      const d = this.creerDelegation(u, { delegataireId: input.delegataireId, categorie: it.categorie!, ficheId, fin: input.jusquau, motif, perimetre: input.perimetre ?? `Fiche « ${it.objet} »` });
      const g = record('DELEGUER');
      return { resultat: { geste: g, delegation: d } };
    }

    // APPROUVER / REFUSER
    const approve = input.action === 'APPROUVER';
    const possible = f.actions.find((a) => a.code === input.action)!;
    if (!possible.possible) {
      this.audit(u, 'postes.fiche.action_refusee', 'fiche', ficheId, { action: input.action, raison: possible.raison }, 'DENIED');
      throw forbidden('ACTION_INDISPONIBLE', possible.raison ?? 'Action indisponible depuis le poste.');
    }
    if (it.demandeurId === u.id) throw forbidden('SEPARATION_OF_DUTIES', 'Une personne ne décide jamais un élément qu’elle a demandé (y compris par délégation).');
    this.garderDecision(u, device);
    if (it.dossier) {
      const d = this.dossiers.get(it.dossier.id)!;
      if (d.statut !== 'EN_ATTENTE') throw conflict('ALREADY_DECIDED', 'Dossier déjà décidé.');
      assertDistinctPerson(u.id, [d.createdBy, d.demandeur.userId], 'Le dossier est décidé par une personne distincte de celle qui l’a instruit ou demandé.');
      const at = this.now();
      const out = this.dossiers.update({ ...d, statut: approve ? 'APPROUVE' : 'REFUSE', decision: { by: u.id, at, approve, motif, ...(e.delegation ? { delegationId: e.delegation.id, parDelegationDe: this.userName(e.delegation.delegantId) } : {}) }, journal: [...d.journal, { at, by: u.id, action: input.action, motif }] });
      const g = record(input.action);
      this.audit(u, approve ? 'postes.dossier.approuve' : 'postes.dossier.refuse', 'dossier_orientation', d.id, { motif, categorie: d.categorie, proposedBy: d.createdBy, ...(mention ? { mention, delegationId: e.delegation!.id, delegantId: e.delegation!.delegantId } : {}) });
      let execution: Execution | undefined;
      if (approve) execution = this.creerExecution(u, d);
      return { resultat: { dossier: out, geste: g, ...(execution ? { execution } : {}), orientation: 'Orientation approuvée : l’exécution relève du service compétent, suivie par le Secrétariat exécutif (aucune écriture manipulée depuis le poste).' } };
    }
    const fw = approve ? it.approuver : it.refuser;
    if (!fw) throw forbidden('ACTION_INDISPONIBLE', it.horsPoste ?? 'Décision sur l’écran de la source.');
    if (estRouteFinanciere(fw.url)) throw unprocessable('ACTION_FINANCIERE_INTERDITE', 'Aucun poste de décision ne modifie une dette, un paiement, une quittance ou un compte bénéficiaire (§ 27.12).');
    return { relais: { ...fw, approve }, fiche: f, item: it, ...(e.delegation ? { delegation: e.delegation } : {}) };
  }

  /** Journal du relais vers la route de décision de la source (auteur, motif, route, résultat). */
  enregistrerRelais(u: User, ficheId: string, input: { action: ActionFiche; motif: string }, relais: { url: string }, item: Item, status: number, delegation?: Delegation): GesteRecord {
    const ok = status < 400;
    const mention = delegation ? `par délégation de ${this.userName(delegation.delegantId)} (${delegation.delegantId})` : null;
    const g = this.gestes.append({
      id: this.ids.next('GESTE'), at: this.now(), userId: u.id, ficheId, objet: item.objet, categorie: item.categorie, geste: input.action, motif: input.motif.trim(),
      resultat: ok ? 'ENREGISTRE' : 'REFUSE_PAR_LA_SOURCE', route: `POST ${relais.url}`, ...(delegation ? { parDelegationDe: this.userName(delegation.delegantId), delegationId: delegation.id } : {}),
    });
    this.audit(u, input.action === 'APPROUVER' ? 'postes.fiche.approuvee' : 'postes.fiche.refusee', 'fiche', ficheId,
      { motif: input.motif.trim(), categorie: item.categorie, route: `POST ${relais.url}`, statutSource: status, source: item.source, ...(mention ? { mention, delegationId: delegation!.id } : {}) }, ok ? undefined : 'DENIED');
    if (ok && input.action === 'APPROUVER') {
      // Décision exécutée par la source elle-même : suivie comme exécutée (Secrétariat exécutif).
      const at = this.now();
      this.executions.insert({
        id: this.ids.next('EXEC'), decision: { objet: item.objet, date: at, autorite: this.userName(u.id), autoriteId: u.id, ficheId }, acte: 'DECISION', acteLibelle: `Décision enregistrée par ${item.module}`,
        responsable: { entity: item.entities[0] ?? u.entity, libelle: item.module }, echeance: this.today(), etat: 'EXECUTE', executeLe: at,
        historique: [{ at, by: u.id, etat: 'EXECUTE', motif: 'Décision appliquée par la source (route de décision existante).' }], relances: [], justifications: [],
        ...(item.exemple ? { exemple: true } : {}),
      });
    }
    return g;
  }

  // ————————————————————————— délégations (§ 27.11) —————————————————————————

  candidatsDelegation(u: User, categorie: string) {
    authorize(u, 'postes:delegation.create');
    const rang = rangDe(u.roles);
    return this.ctx.users.all()
      .filter((x) => x.id !== u.id && estAgentPublic(x.roles) && rangDe(x.roles) > rang && !this.comptePartage(x) && (this.provinceEntiere(u) || this.entitesDe(u).has(x.entity)))
      .map((x) => ({ id: x.id, nom: x.name, roles: x.roles.map((r) => ROLES[r]), entity: x.entity }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
      .slice(0, 200)
      .map((x) => ({ ...x, categorie }));
  }

  /** Compte partagé (guichet collectif, poste commun) : jamais délégataire ni suppléant (§ 27.11). */
  comptePartage(x: User): boolean { return /(partag|commun|collectif|g[ée]n[ée]rique)/i.test(`${x.id} ${x.name}`); }

  creerDelegation(u: User, input: { delegataireId: string; categorie: CategorieDecision; ficheId?: string; debut?: string; fin: string; motif: string; perimetre: string }): Delegation {
    authorize(u, 'postes:delegation.create');
    const def = categorieDef(input.categorie);
    if (!def) throw badRequest('CATEGORIE_INCONNUE', `Catégorie inconnue : ${input.categorie}.`);
    const motif = input.motif.trim();
    if (motif.length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'La délégation porte un motif écrit.');
    const today = this.today();
    const debut = input.debut ?? today;
    if (debut < today) throw badRequest('DEBUT_PASSE', 'Une délégation ne commence pas dans le passé.');
    if (input.fin <= debut) throw badRequest('FIN_INVALIDE', 'La délégation a une fin postérieure à son début.');
    const max = this.param('postes.delegation.duree_max_jours');
    if (joursEntre(debut, input.fin) > max) throw unprocessable('DUREE_EXCESSIVE', `Délégation de ${max} jours au plus (${'PAR_DEFAUT — à confirmer par le maître d’ouvrage'}).`);
    const x = this.ctx.users.get(input.delegataireId);
    if (!x) throw notFound('USER_NOT_FOUND', `Personne inconnue : ${input.delegataireId}.`);
    assertDistinctPerson(u.id, [x.id], 'On ne se délègue pas à soi-même.');
    if (!estAgentPublic(x.roles)) throw unprocessable('DELEGATAIRE_NON_AGENT', 'Délégation à un agent public nommé seulement.');
    if (this.comptePartage(x)) throw unprocessable('COMPTE_PARTAGE', 'Suppléance jamais transférable à un compte partagé (§ 27.11).');
    if (rangDe(x.roles) <= rangDe(u.roles)) throw forbidden('RANG_NON_INFERIEUR', 'Délégation à une personne de rang inférieur seulement.');
    if (!this.provinceEntiere(u) && !this.entitesDe(u).has(x.entity)) throw forbidden('HORS_PERIMETRE', 'Délégataire hors du périmètre du délégant.');
    // Jamais au-delà des droits du délégant : il doit lui-même tenir la catégorie (niveau habituel) ou décider la fiche.
    if (input.ficheId) {
      const e = this.corbeilleItems(u).fiches.find((f) => f.it.id === input.ficheId);
      if (!e || !(e.presence.includes('DECIDEUR'))) throw forbidden('AU_DELA_DES_DROITS', 'Délégation d’une fiche que le délégant décide lui-même seulement.');
      if (e.presence.includes('DELEGATION') && !e.presence.includes('DECIDEUR')) throw forbidden('SUBDELEGATION', 'Un délégataire ne subdélègue pas.');
    } else if (!u.roles.some((r) => def.niveauRoles.includes(r))) {
      throw forbidden('AU_DELA_DES_DROITS', `La catégorie « ${def.libelle} » ne relève pas de votre niveau (${def.niveau}) : délégation impossible.`);
    }
    if (this.delegations.findOne((d) => d.delegantId === u.id && d.delegataireId === x.id && d.categorie === input.categorie && (d.ficheId ?? null) === (input.ficheId ?? null) && (d.statut === 'ACTIVE' || d.statut === 'PROGRAMMEE'))) {
      throw conflict('DELEGATION_EXISTANTE', 'Une délégation identique est déjà en cours.');
    }
    const d = this.delegations.insert({
      id: this.ids.next('DELEG'), delegantId: u.id, delegataireId: x.id, categorie: input.categorie, ...(input.ficheId ? { ficheId: input.ficheId } : {}), perimetre: input.perimetre.trim(),
      motif, debut, fin: input.fin, statut: debut <= today ? 'ACTIVE' : 'PROGRAMMEE', creeLe: this.now(),
    });
    this.audit(u, 'postes.delegation.creee', 'delegation', d.id, { delegataireId: x.id, delegataire: x.name, categorie: d.categorie, ficheId: d.ficheId ?? null, perimetre: d.perimetre, debut, fin: d.fin, motif });
    this.notifier(x.id, 'DECISION_URGENTE', `Délégation reçue : « ${def.libelle} » jusqu’au ${d.fin}`, `delegation:${d.id}`);
    return d;
  }

  revoquerDelegation(u: User, id: string, motif: string): Delegation {
    authorize(u, 'postes:delegation.create');
    this.sweep();
    const d = this.delegations.get(id);
    if (!d) throw notFound('DELEGATION_INCONNUE', `Délégation inconnue : ${id}.`);
    if (d.delegantId !== u.id && !u.roles.includes('R01')) throw forbidden('NON_DELEGANT', 'Seul le délégant (ou le Gouverneur) révoque une délégation.');
    if (d.statut !== 'ACTIVE' && d.statut !== 'PROGRAMMEE') throw conflict('DELEGATION_TERMINEE', `Délégation au statut ${d.statut}.`);
    if (motif.trim().length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'La révocation est motivée.');
    const out = this.delegations.update({ ...d, statut: 'REVOQUEE', revocation: { by: u.id, at: this.now(), motif: motif.trim() } });
    this.audit(u, 'postes.delegation.revoquee', 'delegation', d.id, { delegataireId: d.delegataireId, categorie: d.categorie, motif: motif.trim() });
    return out;
  }

  listeDelegations(u: User) {
    authorize(u, 'postes:decision.read');
    this.sweep();
    const oversight = u.roles.some((r) => ['R01', 'R02', 'R22', 'R23'].includes(r));
    return this.delegations.all().filter((d) => oversight || d.delegantId === u.id || d.delegataireId === u.id)
      .map((d) => ({ ...d, delegant: this.userName(d.delegantId), delegataire: this.userName(d.delegataireId), categorieLibelle: categorieDef(d.categorie)?.libelle ?? d.categorie }))
      .sort((a, b) => (a.creeLe < b.creeLe ? 1 : -1));
  }

  // ————————————————————————— dossiers d'orientation instruits par les services —————————————————————————

  soumettreDossier(u: User, input: Omit<DossierOrientation, 'id' | 'preparation' | 'transmis' | 'statut' | 'complements' | 'journal' | 'decision' | 'createdBy' | 'createdAt' | 'entities' | 'demandeur' | 'exemple'> & { nature?: string; entities?: string[]; demandeurLibelle?: string }, opts: { exemple?: boolean; preparation?: EtatPreparation; transmis?: boolean; createdAt?: string } = {}): DossierOrientation {
    authorize(u, 'postes:dossier.submit');
    if (input.nature && NATURES_REFUSEES[input.nature]) {
      throw unprocessable('NE_REMONTE_JAMAIS', `Cette nature d’élément ne remonte jamais à une autorité (${NATURES_REFUSEES[input.nature]}) : le service la traite lui-même (§ 27.4).`);
    }
    const def = categorieDef(input.categorie);
    if (!def) throw unprocessable('CATEGORIE_NON_REMONTANTE', 'Seules les dix catégories du § 27.4 atteignent un poste de décision.');
    if (!['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07'].includes(input.destinataireRole)) throw badRequest('DESTINATAIRE_INVALIDE', 'Destinataire : une autorité tenant un poste de décision.');
    if (input.position.recommandation.length > POSITION_MAX) throw badRequest('POSITION_TROP_LONGUE', 'Position du service : deux lignes au plus.');
    if (input.individuel && (!input.finaliteNominative || input.finaliteNominative.trim().length < MOTIF_MIN)) {
      throw unprocessable('FINALITE_REQUISE', 'Dossier d’un contribuable nommément désigné : finalité déclarée, enregistrée et journalisée requise.');
    }
    const complet = input.fondement.some((f) => f.trim()) && input.position.recommandation.trim().length > 0;
    const preparation: EtatPreparation = opts.preparation ?? (input.fondement.some((f) => f.trim()) ? (complet ? 'INSTRUIT' : 'A_INSTRUIRE') : 'INCOMPLET');
    const { nature: _n, demandeurLibelle, entities, ...rest } = input;
    const at = opts.createdAt ?? this.now();
    const d = this.dossiers.insert({
      ...rest, id: this.ids.next('DOSS'), demandeur: { userId: u.id, libelle: demandeurLibelle ?? this.userName(u.id) }, preparation,
      transmis: opts.transmis ?? (input.destinataireRole !== 'R01'), statut: 'EN_ATTENTE', complements: [], journal: [{ at, by: u.id, action: 'SOUMISSION', motif: input.objet }],
      entities: entities?.length ? entities : [u.entity], createdBy: u.id, createdAt: at, ...(opts.exemple ? { exemple: true } : {}),
    });
    this.audit(u, 'postes.dossier.soumis', 'dossier_orientation', d.id, { categorie: d.categorie, destinataire: d.destinataireRole, preparation, fondement: d.fondement.length, ...(input.individuel ? { finalite: input.finaliteNominative } : {}) });
    return d;
  }

  repondreComplement(u: User, id: string, texte: string): DossierOrientation {
    authorize(u, 'postes:dossier.submit');
    const d = this.dossiers.get(id);
    if (!d) throw notFound('DOSSIER_INCONNU', `Dossier inconnu : ${id}.`);
    if (d.createdBy !== u.id && !(u.entity && d.entities.includes(u.entity))) throw forbidden('NON_INSTRUCTEUR', 'Réponse du service instructeur seulement.');
    if (texte.trim().length < MOTIF_MIN) throw badRequest('REPONSE_REQUISE', 'Réponse motivée requise.');
    const at = this.now();
    const complements = d.complements.map((c) => (c.reponse ? c : { ...c, reponse: { by: u.id, at, texte: texte.trim() } }));
    const out = this.dossiers.update({ ...d, complements, preparation: d.fondement.some((f) => f.trim()) ? 'INSTRUIT' : 'INCOMPLET', journal: [...d.journal, { at, by: u.id, action: 'REPONSE_COMPLEMENT', motif: texte.trim() }] });
    this.audit(u, 'postes.dossier.complement_repondu', 'dossier_orientation', id, { texte: texte.trim() });
    return out;
  }

  // ————————————————————————— § 27.6 préparation et ordre du jour du cabinet —————————————————————————

  preparer(u: User, id: string, input: { action: ActionPreparation; motif: string; fondement?: string[] }): DossierOrientation {
    authorize(u, 'postes:cabinet.prepare');
    const d = this.dossiers.get(id);
    if (!d || d.destinataireRole !== 'R01') throw notFound('DOSSIER_INCONNU', `Dossier inconnu dans la file d’instruction : ${id}.`);
    if (d.statut !== 'EN_ATTENTE') throw conflict('ALREADY_DECIDED', 'Dossier déjà décidé.');
    const motif = input.motif.trim();
    if (motif.length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'Chaque geste de préparation est motivé et journalisé.');
    const at = this.now();
    let patch: Partial<DossierOrientation> = {};
    if (input.action === 'TRANSMETTRE') {
      if (!d.fondement.some((f) => f.trim())) throw unprocessable('FONDEMENT_REQUIS', 'Une fiche sans base légale ne peut être présentée au Gouverneur : à renvoyer au service.');
      if (d.preparation !== 'INSTRUIT') throw conflict('DOSSIER_NON_INSTRUIT', `Dossier « ${ETAT_PREPARATION_LABELS[d.preparation]} » : seul un dossier instruit monte au Gouverneur.`);
      patch = { transmis: true };
    } else {
      patch = { preparation: 'INCOMPLET', transmis: false };
    }
    const out = this.dossiers.update({ ...d, ...patch, journal: [...d.journal, { at, by: u.id, action: input.action, motif }] });
    this.gestes.append({ id: this.ids.next('GESTE'), at, userId: u.id, ficheId: `DOSSIER:${d.id}`, objet: d.objet, categorie: d.categorie, geste: input.action, motif, resultat: 'ENREGISTRE' });
    this.audit(u, `postes.cabinet.${input.action.toLowerCase()}`, 'dossier_orientation', d.id, { motif, categorie: d.categorie, ecarte: input.action !== 'TRANSMETTRE' });
    if (input.action !== 'TRANSMETTRE') this.notifier(d.createdBy, 'DELAI_EXPIRANT', `Dossier renvoyé par le cabinet : « ${d.objet} »`, `prep:${d.id}:${at}`);
    return out;
  }

  ordonner(u: User, input: { ficheId: string; action: ActionOrdre; motif: string; reexamenLe?: string }) {
    authorize(u, 'postes:cabinet.prepare');
    const motif = input.motif.trim();
    if (motif.length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'Monter, descendre ou différer : motif enregistré.');
    const gouv = this.corbeilleItems(GOUVERNEUR);
    const present = gouv.fiches.some((x) => x.it.id === input.ficheId) || gouv.differes.some((x) => x.it.id === input.ficheId);
    if (!present) throw notFound('FICHE_INCONNUE', 'Fiche absente de la corbeille du Gouverneur.');
    if (input.action === 'DIFFERER') {
      if (!input.reexamenLe || input.reexamenLe <= this.today()) throw badRequest('REEXAMEN_REQUIS', 'Un dossier différé porte sa date de réexamen (postérieure à aujourd’hui).');
    }
    const at = this.now();
    const prev = this.ordre.get(input.ficheId) ?? { id: input.ficheId, decalage: 0, historique: [] };
    const next: OrdreEntry = {
      ...prev,
      decalage: prev.decalage + (input.action === 'MONTER' ? 1 : input.action === 'DESCENDRE' ? -1 : 0),
      ...(input.action === 'DIFFERER' ? { differeJusquau: input.reexamenLe! } : {}),
      historique: [...prev.historique, { at, by: u.id, action: input.action, motif, ...(input.reexamenLe ? { reexamenLe: input.reexamenLe } : {}) }],
    };
    const out = this.ordre.get(input.ficheId) ? this.ordre.update(next) : this.ordre.insert(next);
    this.gestes.append({ id: this.ids.next('GESTE'), at, userId: u.id, ficheId: input.ficheId, objet: input.ficheId, categorie: null, geste: input.action, motif, resultat: 'ENREGISTRE' });
    this.audit(u, `postes.ordre.${input.action.toLowerCase()}`, 'fiche', input.ficheId, { motif, ...(input.reexamenLe ? { reexamenLe: input.reexamenLe } : {}) });
    return out;
  }

  // ————————————————————————— § 27.7 exécution des décisions —————————————————————————

  private creerExecution(u: User, d: DossierOrientation): Execution {
    const at = this.now();
    const e = this.executions.insert({
      id: this.ids.next('EXEC'), decision: { objet: d.objet, date: at, autorite: this.userName(u.id), autoriteId: u.id, ficheId: `DOSSIER:${d.id}` }, acte: d.execution.acte, acteLibelle: d.execution.libelle,
      responsable: d.execution.responsable, echeance: ajouterJours(this.today(), d.execution.delaiJours), etat: 'NON_ENGAGE', ...(d.execution.lien ? { lien: d.execution.lien } : {}),
      historique: [{ at, by: u.id, etat: 'NON_ENGAGE', motif: 'Décision prise : acte à produire.' }], relances: [], justifications: [], ...(d.exemple ? { exemple: true } : {}),
    });
    this.audit(u, 'postes.execution.ouverte', 'execution', e.id, { dossierId: d.id, acte: e.acte, responsable: e.responsable.entity, echeance: e.echeance });
    return e;
  }

  /** État d'exécution relu à la source quand elle existe (suspension effective d'un centre agréé). */
  etatExecution(e: Execution): { etat: EtatExecution; executeLe?: string } {
    if (e.lien?.type === 'CENTRE_SUSPENSION') {
      const vc = this.ctx.ext['vehicules-controle'] as { centres?: { centres: { get(id: string): { status: string; suspension?: { at: string } } | undefined } } } | undefined;
      const c = vc?.centres?.centres.get(e.lien.centreId);
      if (c?.status === 'SUSPENDU' && c.suspension && c.suspension.at >= e.decision.date) return { etat: 'EXECUTE', executeLe: c.suspension.at };
    }
    return { etat: e.etat, ...(e.executeLe ? { executeLe: e.executeLe } : {}) };
  }

  estResponsable(u: User, e: Execution): boolean {
    if (e.responsable.userId) return e.responsable.userId === u.id;
    return u.entity === e.responsable.entity && (!e.responsable.role || u.roles.includes(e.responsable.role));
  }

  mettreAJourExecution(u: User, id: string, input: { etat: EtatExecution; motif: string; blocage?: string; preuve?: { reference: string; sha256?: string; version?: string; publieLe?: string } }): Execution {
    authorize(u, 'postes:execution.update');
    const e = this.executions.get(id);
    if (!e) throw notFound('EXECUTION_INCONNUE', `Exécution inconnue : ${id}.`);
    if (!this.estResponsable(u, e)) throw forbidden('NON_RESPONSABLE', 'L’état d’exécution et la cause d’un blocage sont déclarés par le service responsable, pas constatés par un tiers.');
    if (input.motif.trim().length < 3) throw badRequest('MOTIF_OBLIGATOIRE', 'Motif requis.');
    if ((input.etat === 'PRODUIT' || input.etat === 'EXECUTE') && !input.preuve && !e.preuve) throw unprocessable('PREUVE_REQUISE', 'Acte produit ou exécuté : référence de l’acte requise.');
    const at = this.now();
    const out = this.executions.update({
      ...e, etat: input.etat, ...(input.preuve ? { preuve: input.preuve } : {}), ...(input.etat === 'EXECUTE' ? { executeLe: at } : {}),
      ...(input.blocage ? { blocage: { cause: input.blocage.trim(), declareLe: at, declarePar: u.id } } : {}),
      historique: [...e.historique, { at, by: u.id, etat: input.etat, motif: input.motif.trim() }],
    });
    this.audit(u, 'postes.execution.etat', 'execution', id, { etat: input.etat, motif: input.motif.trim(), ...(input.blocage ? { blocageDeclare: input.blocage.trim() } : {}), ...(input.preuve ? { preuve: input.preuve.reference } : {}) });
    return out;
  }

  relancer(u: User, id: string, motif: string): Execution {
    authorize(u, 'postes:execution.relance');
    const e = this.executions.get(id);
    if (!e) throw notFound('EXECUTION_INCONNUE', `Exécution inconnue : ${id}.`);
    if (motif.trim().length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'Relance motivée.');
    const out = this.executions.update({ ...e, relances: [...e.relances, { at: this.now(), by: u.id, motif: motif.trim() }] });
    this.gestes.append({ id: this.ids.next('GESTE'), at: this.now(), userId: u.id, ficheId: `EXEC:${id}`, objet: e.decision.objet, categorie: null, geste: 'RELANCE', motif: motif.trim(), resultat: 'ENREGISTRE' });
    this.audit(u, 'postes.execution.relance', 'execution', id, { motif: motif.trim(), responsable: e.responsable.entity });
    const cibles = this.ctx.users.all().filter((x) => this.estResponsable(x, e));
    for (const c of cibles) this.notifier(c.id, 'DELAI_EXPIRANT', `Relance nominative : « ${e.acteLibelle} » (échéance ${e.echeance})`, `relance:${id}:${this.now()}`);
    return out;
  }

  justifier(u: User, id: string, texte: string): Execution {
    authorize(u, 'postes:execution.relance');
    const e = this.executions.get(id);
    if (!e) throw notFound('EXECUTION_INCONNUE', `Exécution inconnue : ${id}.`);
    if (texte.trim().length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'Justification motivée.');
    const out = this.executions.update({ ...e, justifications: [...e.justifications, { at: this.now(), by: u.id, texte: texte.trim() }] });
    this.audit(u, 'postes.execution.justification', 'execution', id, { texte: texte.trim() });
    return out;
  }

  vueExecution(e: Execution) {
    const { etat, executeLe } = this.etatExecution(e);
    const today = this.today();
    const jr = joursEntre(today, e.echeance);
    const late = etat !== 'EXECUTE' ? jr < 0 : !!executeLe && executeLe.slice(0, 10) > e.echeance;
    return {
      ...e, etat, etatLabel: ETAT_EXECUTION_LABELS[etat], acteType: ACTE_LABELS[e.acte], ...(executeLe ? { executeLe } : {}),
      joursRestants: etat === 'EXECUTE' ? null : jr, enRetard: late, joursRetard: late && etat !== 'EXECUTE' ? -jr : 0,
      blocage: e.blocage ?? null, blocageLibelle: e.blocage ? `Blocage déclaré : ${e.blocage.cause}` : late ? 'Cause non déclarée — à déclarer par le service responsable (jamais déduite)' : null,
      exempleMention: e.exemple ? EXEMPLE : null,
    };
  }

  // ————————————————————————— § 27.9 habilitations de consultation —————————————————————————

  declarerHabilitation(u: User, input: { userId: string; perimetre: Habilitation['perimetre']; du?: string; au: string; motif: string }): Habilitation {
    authorize(u, 'postes:habilitation.declare');
    const x = this.ctx.users.get(input.userId);
    if (!x) throw notFound('USER_NOT_FOUND', `Personne inconnue : ${input.userId}.`);
    const du = input.du ?? this.today();
    if (input.au <= du) throw badRequest('FIN_INVALIDE', 'Habilitation à durée déterminée : date de fin postérieure au début.');
    const max = this.param('postes.consultation.duree_max_jours');
    if (joursEntre(du, input.au) > max) throw unprocessable('DUREE_EXCESSIVE', `Habilitation de ${max} jours au plus.`);
    if (input.motif.trim().length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'Portée déclarée et motivée à l’ouverture des droits.');
    const h = this.habilitations.insert({ id: this.ids.next('HABIL'), userId: x.id, perimetre: input.perimetre, du, au: input.au, declarePar: u.id, declareLe: this.now(), motif: input.motif.trim(), renouvellements: [] });
    this.audit(u, 'postes.habilitation.declaree', 'habilitation_consultation', h.id, { userId: x.id, perimetre: h.perimetre, du, au: h.au });
    return h;
  }

  renouvelerHabilitation(u: User, id: string, input: { au: string; motif: string }): Habilitation {
    authorize(u, 'postes:habilitation.declare');
    const h = this.habilitations.get(id);
    if (!h) throw notFound('HABILITATION_INCONNUE', `Habilitation inconnue : ${id}.`);
    if (input.motif.trim().length < MOTIF_MIN) throw badRequest('MOTIF_OBLIGATOIRE', 'Renouvellement explicite et motivé (jamais tacite).');
    const debut = h.au > this.today() ? h.au : this.today();
    if (input.au <= debut) throw badRequest('FIN_INVALIDE', 'Nouvelle échéance postérieure à l’échéance en cours.');
    if (joursEntre(this.today(), input.au) > this.param('postes.consultation.duree_max_jours')) throw unprocessable('DUREE_EXCESSIVE', 'Durée maximale dépassée.');
    const out = this.habilitations.update({ ...h, au: input.au, renouvellements: [...h.renouvellements, { at: this.now(), by: u.id, ancienneFin: h.au, nouvelleFin: input.au, motif: input.motif.trim() }] });
    this.audit(u, 'postes.habilitation.renouvelee', 'habilitation_consultation', id, { ancienneFin: h.au, nouvelleFin: input.au, motif: input.motif.trim() });
    return out;
  }

  /** Habilitation active (lève une erreur si absente ou expirée : renouvellement explicite requis). */
  habilitationActive(u: User): Habilitation {
    const h = this.habilitationDe(u.id);
    if (!h) throw forbidden('SANS_HABILITATION', 'Aucune habilitation de consultation déclarée pour vous.');
    const today = this.today();
    if (h.au < today) {
      this.audit(u, 'postes.consultation.refusee', 'habilitation_consultation', h.id, { raison: 'HABILITATION_EXPIREE', au: h.au }, 'DENIED');
      throw forbidden('HABILITATION_EXPIREE', `Habilitation expirée le ${h.au} : renouvellement explicite requis (jamais tacite).`);
    }
    if (h.du > today) throw forbidden('HABILITATION_NON_COMMENCEE', `Habilitation valable à partir du ${h.du}.`);
    return h;
  }

  noterConsultation(u: User, vue: string): void {
    this.consultations.append({ id: this.ids.next('CONS'), userId: u.id, at: this.now(), vue });
    this.audit(u, 'postes.consultation.vue', 'poste', vue, { vue });
  }

  // ————————————————————————— § 27.11 notifications —————————————————————————

  plafond(userId: string): number { return this.preferences.get(userId)?.plafondJournalier ?? this.param('postes.notifications.plafond_defaut'); }

  fixerPlafond(u: User, plafond: number) {
    authorize(u, 'postes:decision.read');
    if (!Number.isInteger(plafond) || plafond < 1 || plafond > 100) throw badRequest('PLAFOND_INVALIDE', 'Plafond journalier entre 1 et 100.');
    const rec = { id: u.id, plafondJournalier: plafond, fixeLe: this.now() };
    if (this.preferences.get(u.id)) this.preferences.update(rec); else this.preferences.insert(rec);
    this.audit(u, 'postes.notifications.plafond', 'poste', u.id, { plafond });
    return rec;
  }

  /** Notification d'un poste : jamais de donnée fiscale individuelle ; au-delà du plafond, une synthèse unique du jour. */
  notifier(userId: string, type: NotificationPoste['type'], texte: string, cle: string): NotificationPoste | null {
    if (this.notifications.find((n) => n.userId === userId && n.cle === cle).length) return null;
    const jour = this.today();
    const duJour = this.notifications.find((n) => n.userId === userId && n.jour === jour);
    const plafond = this.plafond(userId);
    const u = this.ctx.users.get(userId);
    if (duJour.filter((n) => n.type !== 'SYNTHESE').length >= plafond) {
      const synth = duJour.find((n) => n.type === 'SYNTHESE');
      if (synth) return null;
      const n = this.notifications.append({ id: this.ids.next('NOTIF'), userId, at: this.now(), jour, type: 'SYNTHESE', texte: `Synthèse du jour : d’autres éléments attendent votre poste de décision (plafond de ${plafond} notifications atteint).`, cle: `synthese:${jour}` });
      if (u) try { this.ctx.comms.publish('approval.requested', [userRecipient(u)], { objet: n.texte }, { entity: u.entity }); } catch { /* la notification n'empêche jamais le poste */ }
      return n;
    }
    const n = this.notifications.append({ id: this.ids.next('NOTIF'), userId, at: this.now(), jour, type, texte, cle });
    if (u) try { this.ctx.comms.publish('approval.requested', [userRecipient(u)], { objet: texte }, { entity: u.entity }); } catch { /* idem */ }
    return n;
  }

  /** Déclenchement uniquement par seuil ou par échéance (§ 27.11). */
  balayerNotifications(u: User, fiches: Fiche[], alertes: { id: string; enjeuCdf: bigint }[]): void {
    for (const f of fiches) {
      if (f.echeance.urgente) this.notifier(u.id, 'DECISION_URGENTE', `Décision urgente : ${f.categorie?.libelle ?? 'dossier'} (échéance ${f.echeance.date})`, `urgente:${f.id}`);
      else if (f.echeance.joursRestants <= 1) this.notifier(u.id, 'DELAI_EXPIRANT', `Délai sur le point d’expirer : ${f.categorie?.libelle ?? 'dossier'}`, `delai:${f.id}`);
    }
    const seuil = this.param('postes.seuil.alerte_deperdition_cdf');
    if (u.roles.includes('R01')) for (const a of alertes) if (a.enjeuCdf >= BigInt(Math.trunc(seuil))) this.notifier(u.id, 'ALERTE_MONTANT', 'Alerte de déperdition au-delà du seuil : information immédiate.', `alerte:${a.id}`);
  }

  // ————————————————————————— helpers de hachage (note hebdomadaire) —————————————————————————

  empreinte(contenu: unknown): string { return sha256Hex(JSON.stringify(contenu)); }

  evaluer(u: User, action: string): boolean { return evaluate(u, action as never) !== false; }
}

export { GOUVERNEUR as GOUVERNEUR_CORBEILLE };
