/**
 * Moteur de paiement, de règlement et de répartition des recettes (spécification du 29/09/2026) — service.
 *
 * Construit PAR-DESSUS l'existant, sans rien en retirer :
 *  - clé du § 37A (repartition/service.ts) : ACTE_REQUIS tant que l'acte n'est pas enregistré ; ses deux flux (Flux 1
 *    Groupe Nseya, Flux 2 Gouvernement provincial au Trésor), son exécution automatique après acte et convention et ses
 *    simulations restent le SEUL chemin des fonds ; ce moteur n'émet AUCUN virement ;
 *  - matrice versionnée (KIN-REV-001) : les constantes du § 37A deviennent la V1 proposée (ACTE_REQUIS) ;
 *  - sous-grand-livre des DROITS (en partie double, en ajout seul, chaîné) : droits constatés sur chaque paiement
 *    éligible RAPPROCHÉ, contre-écritures négatives sur remboursement ou contrepassation (soldes recouvrables),
 *    règlements constatés (flux exécutés du § 37A ou demande de règlement à quatre personnes) ; soldes toujours
 *    calculés à partir des écritures ;
 *  - espèces : acceptées aux seuls points agréés (module 66), jamais par un agent de terrain ; le droit de Groupe Nseya
 *    issu d'espèces est PAYABLE, jamais présenté comme réglé avant le règlement constaté ;
 *  - coffre des comptes bénéficiaires (module 60) : le compte de règlement principal du Gouvernement désigne un alias
 *    VERROUILLÉ du coffre ; son numéro ne change que par le circuit existant du coffre (deux approbateurs, hors bande, 72 h).
 *
 * L'IA n'intervient nulle part ; aucune sanction automatique ; le super-administrateur ne modifie rien de financier.
 */
import { createHash } from 'node:crypto';
import { isRuleExecutable, Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../../../context.js';
import { actorOf, type AuditActor } from '../../../../core/audit.js';
import type { User } from '../../../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../../../core/clock.js';
import { canonicalJson } from '../../../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate } from '../../../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../../../core/repository.js';
import type { PaymentOrder } from '../../../../modules/payments/service.js';
import { maskAccount } from '../../../../modules/vault/service.js';
import { catalogueModule, TUTELLE_PAR_DEFAUT } from '../../../acces/catalogue-modules.js';
import type { AccesService } from '../../../acces/service.js';
import type { TresorService } from '../../../tresor/service.js';
import type { FlowCode, SliceCode } from '../model.js';
import { CONDITIONS, KEY_RULE_CODE, type RepartitionService } from '../service.js';
import {
  allocateTransaction, CADENCE_JOURS, CANAUX_ESPECES, checkVersionShape, DELAI_GRACE_REGLEMENT_JOURS, defaultBeneficiaries, defaultPool, ENTITE_A_RATTACHER,
  MODES_COUTS, MODES_POOL, MODES_REGLEMENT, moduleOfRule, POSTES_COUTS, REGLE_REPARTITION_ALIAS, REGLE_REPARTITION_ID, STATUTS_VERSION, sumLines, sumPct, TOUT, TYPES_AGENT,
  V1_DATE_EFFET, type EtatDroit,
  type AllocationLine, type AllocationRuleVersion, type BeneficiaireRegle, type CoutsConfig, type MethodePaiement, type ModeReglement, type PoolConfig,
  type PosteCout, type TypeAgent,
} from './model.js';

/** Rôles de la visibilité financière d'ensemble (§ 12) : Gouverneur, cabinet, secrétariat exécutif, ministre des Finances ; Trésor et audit pour l'exploitation. */
export const ROLES_EXECUTIF = ['R01', 'R02', 'R03', 'R05', 'R17', 'R18', 'R22', 'R23'] as const;
/** Rôles qui voient l'identifiant du contribuable dans le détail d'une transaction (lecture fiscale déjà habilitée). */
const ROLES_DONNEES_PERSONNELLES = ['R12', 'R17', 'R22', 'R23', 'R24'];
/** Entité des comptes Groupe Nseya (rôle dédié R38 « Groupe Nseya — super-administrateur (lecture complète) »). */
export const ENTITE_GROUPE_NSEYA = 'GROUPE_NSEYA';
/** Rôle dédié de Groupe Nseya (décision du maître d'ouvrage du 29/09/2026, spécification v1.0 § 4). */
export const ROLE_GROUPE_NSEYA = 'R38';

/** Contradictions entre la spécification et l'existant : harmonisées, signalées au maître d'ouvrage (Règle n° 1). */
export const CONTRADICTIONS = [
  { code: 'A', titre: 'Pool des opérations de terrain : par recette générée (spéc. § 8, décision du 29/09/2026) ou par points vérifiés × qualité (décision du 27/09/2026)', harmonisation: 'Tranché le 29/09/2026 : la V1 proposée (KIN-DEFAULT) répartit PAR RECETTE GÉNÉRÉE ; le mode PAR_POINTS_QUALITE et ses écrans restent disponibles ; seul le circuit d’approbation d’une version change de mode.', statut: 'TRANCHE' },
  { code: 'B', titre: 'Fractionnement en temps réel chez le prestataire (§ 4, § 12) et « deux flux seulement » (§ 37A.4)', harmonisation: 'Tranché le 29/09/2026 : fractionnement admis pour les DEUX flux du § 37A seulement (Groupe Nseya, Trésor), sur infrastructure approuvée ; jamais vers un ministère, un agent ou un sous-traitant.', statut: 'TRANCHE' },
  { code: 'C', titre: 'Espèces (§ 13 : « l’agent enregistre l’encaissement ») et « les agents de terrain ne reçoivent jamais d’espèces »', harmonisation: 'Tranché le 29/09/2026 : aucune espèce pour les agents de terrain (refus serveur) ; espèces aux seuls points agréés (module 66) et guichets bancaires : déclaration → vérification → dépôt → appariement → rapprochement → répartition ; droit de Groupe Nseya PAYABLE.', statut: 'TRANCHE' },
  { code: 'D', titre: 'Visibilité complète de Groupe Nseya (§ 4, § 12) et protection des données personnelles', harmonisation: 'Rôle dédié R38 : lecture et export des agrégats sur toute la plateforme ; toute lecture d’un dossier individuel passe par la consultation motivée (motif déclaré et journalisé, critère C42-05) ; aucune mutation de l’historique.', statut: 'TRANCHE' },
  { code: 'E', titre: 'Lecture des « 7 % » (§ 8) : 7 points de la transaction ou 7 % des 10 %', harmonisation: 'Tranché le 29/09/2026 : 7 POINTS de la transaction (70 / 10 / 10 / 7 / 3) ; la lecture « pourcentage du pool » reste configurable par le circuit d’approbation.', statut: 'TRANCHE' },
  { code: 'F', titre: 'Ministre des Finances : visibilité complète (§ 12) alors que les ministres ne voient que leur ministère (décision du 28/09/2026)', harmonisation: 'Tranché le 29/09/2026 : visibilité complète du ministre des Finances limitée à CE moteur financier ; son menu reste celui de son ministère.', statut: 'TRANCHE' },
  { code: 'G', titre: 'Guichet bancaire : espèces ou électronique pour le règlement du droit de Groupe Nseya', harmonisation: 'Par défaut : seul le canal « point agréé » (AGENT_POINT) est classé espèces ; le dépôt au guichet bancaire est déjà au compte public (classé électronique). À confirmer.', statut: 'A_ARBITRER' },
  { code: 'H', titre: 'Dette envers Groupe Nseya au titre des coûts technologiques (§ 25) : frais de gestion', harmonisation: 'Montant distinct des 10 %, pourcentage de gestion fixé par la version de règle approuvée ; aucun pourcentage par défaut (à confirmer).', statut: 'A_ARBITRER' },
] as const;

// ————————————————————————————————————————— objets

export interface CompteReglement {
  id: string;
  account_id: string;
  account_name: string;
  financial_institution: string;
  /** Alias VERROUILLÉ du coffre (jamais un numéro saisi). */
  account_reference: string;
  currency: CurrencyCode;
  effective_from: string;
  effective_to: string | null;
  status: 'PROPOSE' | 'VERIFIE' | 'ACTIF' | 'REMPLACE' | 'REJETE';
  authorised_by: string | null;
  approval_reference: string | null;
  created_by: string;
  verified_by: string | null;
  motif: string;
  history: { at: string; by: string; action: string; motif?: string }[];
  demo?: boolean;
}

export interface Allocation {
  id: string;
  orderId: string;
  paymentReference: string;
  obligationId: string;
  taxpayerId: string;
  ruleCode: string;
  revenueCategory: string;
  module: string | null;
  moduleLabel: string;
  entity: string;
  entityLabel: string;
  entityBasis: 'FICHE_ACTIVE' | 'TUTELLE_PAR_DEFAUT' | 'A_RATTACHER';
  methode: MethodePaiement;
  channel: string;
  provider: string | null;
  commune: string | null;
  agentId: string | null;
  agentType: TypeAgent | null;
  subcontractorId: string | null;
  base: MoneyJSON;
  paidAt: string;
  reconciledAt: string;
  versionId: string;
  versionNumber: number;
  poolMode: PoolConfig['mode'];
  /** REEL : version ACTIVE à la date du paiement ; SIMULATION sinon (comptes d'ordre, aucun droit exigible). */
  mode: 'REEL' | 'SIMULATION';
  lines: AllocationLine[];
  /** Espèces encaissées par un agent public (interdit) : droits bloqués, alerte. */
  blocked?: string;
  /** Paiement antérieur à la date d'effet de toute version : simulation sur la V1 (présentation seulement). */
  avantEffet?: true;
  /** Donnée de démonstration [EXEMPLE] (transaction fictive, simulation, non contractuelle). */
  demo?: true;
  entryId: string;
  createdAt: string;
}

export interface Contrepassation {
  id: string;
  allocationId: string;
  orderId: string;
  cause: 'REMBOURSE' | 'CONTREPASSE';
  /** Lignes NÉGATIVES (-70 / -10 / -10 / -10). */
  lines: AllocationLine[];
  /** Bénéficiaires dont le droit était déjà réglé : solde recouvrable. */
  recoverable: string[];
  entryId: string;
  createdAt: string;
}

export type TypeEcriture = 'CONSTAT' | 'CONTREPASSATION' | 'REGLEMENT' | 'RECOUVREMENT';
export interface EcritureDroits {
  id: string;
  seq: number;
  at: string;
  type: TypeEcriture;
  mode: 'REEL' | 'SIMULATION';
  allocationId: string;
  orderId: string;
  description: string;
  /** Bénéficiaire concerné (règlement, recouvrement). */
  beneficiary?: string;
  reference?: { demandeId?: string; distributionId?: string; operationId?: string; flow?: FlowCode };
  lines: { account: string; side: 'DEBIT' | 'CREDIT'; amount: MoneyJSON }[];
  prevHash: string;
  hash: string;
}

/** États d'une demande de règlement (spécification v1.0, § 14) — nom français d'abord, terme anglais entre parenthèses. */
export const STATUTS_DEMANDE = {
  BROUILLON: 'Brouillon (DRAFT)', SOUMISE: 'Soumise (SUBMITTED)', EN_EXAMEN: 'En examen (UNDER_REVIEW)', APPROUVEE: 'Approuvée (APPROVED)',
  PAIEMENT_INSTRUIT: 'Paiement instruit (PAYMENT_INSTRUCTED)', PAYEE: 'Payée (PAID)', RAPPROCHEE: 'Rapprochée (RECONCILED)', CLOTUREE: 'Clôturée (CLOSED)',
  REJETEE: 'Rejetée (REJECTED)',
} as const;
export type StatutDemande = keyof typeof STATUTS_DEMANDE;

export interface DemandeReglement {
  id: string;
  beneficiary: string;
  currency: CurrencyCode;
  periodStart: string | null;
  periodEnd: string | null;
  /** Droits retenus (par transaction) ; la dernière ligne peut être partielle. */
  items: { allocationId: string; amount: MoneyJSON }[];
  /** Soldes recouvrables compensés (contrepassations de droits déjà réglés). */
  deductions: { contrepassationId: string; allocationId: string; amount: MoneyJSON }[];
  /** Montant net demandé : jamais supérieur au reste dû. */
  amount: MoneyJSON;
  eligibleBase: MoneyJSON;
  rate: string;
  flow: FlowCode;
  motif: string;
  status: StatutDemande;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  review?: { by: string; at: string; motif: string };
  approval?: { by: string; at: string; approve: boolean; motif: string };
  instruction?: { by: string; at: string; operationId: string; distributionId: string };
  payment?: { by: string; at: string; operationId: string; reference: string };
  reconciliation?: { by: string; at: string; reference: string };
  history: { at: string; by: string; action: string; motif?: string }[];
}

export interface Litige {
  id: string;
  allocationId: string;
  beneficiary: string;
  motif: string;
  status: 'OUVERT' | 'FONDE' | 'NON_FONDE';
  openedBy: string;
  openedAt: string;
  decision?: { by: string; at: string; motif: string };
}

/** Coût technologique (TechnologyCost, spécification v1.0 § 25) : hors répartition initiale. */
export interface TechnologyCost {
  id: string;
  provider: string;
  category: PosteCout;
  categoryLabel: string;
  period: string;
  quantity: string;
  unitCost: MoneyJSON;
  grossCost: MoneyJSON;
  currency: CurrencyCode;
  fundedBy: 'GOUVERNORAT' | 'GROUPE_NSEYA';
  managementFeeRate: string | null;
  managementFeeAmount: MoneyJSON | null;
  supportingInvoiceId: string | null;
  versionId: string;
  motif: string;
  status: 'SOUMIS' | 'VALIDE' | 'REJETE';
  recordedBy: string;
  recordedAt: string;
  verifiedBy?: string;
  verifiedAt?: string;
}

export interface FicheAgent {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_type: TypeAgent;
  parent_ministry_id: string | null;
  parent_department_id: string | null;
  subcontractor_id: string | null;
  commission_rule_id: string;
  territory: string[];
  module_permissions: string[];
  status: 'PROPOSEE' | 'ACTIVE' | 'REJETEE' | 'REMPLACEE';
  effective_from: string;
  effective_to: string | null;
  proposedBy: string;
  proposedAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

export type Visibility =
  | { kind: 'EXECUTIF'; personal: boolean }
  | { kind: 'GROUPE_NSEYA' }
  | { kind: 'ENTITE'; entities: Set<string> }
  | { kind: 'SOUS_TRAITANT'; subcontractorIds: string[]; agentIds: Set<string> }
  | { kind: 'AGENT'; agentId: string }
  | { kind: 'AUCUNE' };

export interface Filtre {
  period?: string; from?: string; to?: string; currency?: string; module?: string; methode?: string; mode?: 'REEL' | 'SIMULATION';
  entity?: string; commune?: string; agent?: string; subcontractor?: string; provider?: string; revenueType?: string; state?: EtatDroit;
}

const AUTO_ACTOR: AuditActor = { kind: 'system', id: 'moteur-repartition' };
const PERIOD_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const isoDay = (iso: string) => kinshasaDate(new Date(iso));
const addMoney = (m: Map<string, Money>, k: string, v: Money) => m.set(k, (m.get(k) ?? Money.zero(v.currency)).add(v));

export class MoteurRepartitionService {
  readonly versions = new InMemoryRepository<AllocationRuleVersion>();
  readonly comptes = new InMemoryRepository<CompteReglement>();
  readonly allocations = new InMemoryAppendOnlyRepository<Allocation>();
  readonly contrepassations = new InMemoryAppendOnlyRepository<Contrepassation>();
  readonly ecritures = new InMemoryAppendOnlyRepository<EcritureDroits>();
  readonly demandes = new InMemoryRepository<DemandeReglement>();
  readonly litiges = new InMemoryRepository<Litige>();
  readonly couts = new InMemoryRepository<TechnologyCost>();
  readonly fiches = new InMemoryRepository<FicheAgent>();
  private readonly ids = new IdGenerator();

  constructor(readonly ctx: AppContext) {}

  private now(): string { return this.ctx.clock.now().toISOString(); }
  private today(): string { return kinshasaDate(this.ctx.clock.now()); }
  private repartition(): RepartitionService | undefined { return this.ctx.ext.repartition as RepartitionService | undefined; }
  private tresor(): TresorService | undefined { return this.ctx.ext.tresor as TresorService | undefined; }
  private acces(): AccesService | undefined { return this.ctx.ext.acces as AccesService | undefined; }
  private audit(user: User | AuditActor, action: string, resourceType: string, resourceId: string, details: Record<string, unknown>) {
    const actor = 'kind' in user && user.kind === 'user' && 'roles' in user && Array.isArray((user as User).roles) && 'name' in user ? actorOf(user as User) : user as AuditActor;
    this.ctx.audit.append({ actor, action, resourceType, resourceId, details });
  }
  /** Le super-administrateur ne fait AUCUNE mutation financière (§ 18), même s'il cumulait un autre rôle. */
  private noSuperAdmin(user: User): void {
    if (user.roles.includes('R26')) {
      this.audit(user, 'moteur.mutation_refusee', 'moteur', 'R26', { reason: 'SUPER_ADMIN' });
      throw forbidden('SUPER_ADMIN_SANS_MUTATION_FINANCIERE', 'Super-administrateur : configuration et technique seulement, aucune modification financière (§ 18).');
    }
  }

  // ═════════════════════════════ Matrice versionnée (§ 3, § 15, § 18)

  /** V1 : constantes du § 37A reprises telles quelles, PROPOSÉES par défaut (ACTE_REQUIS) — créée au premier accès. */
  ensureV1(): AllocationRuleVersion {
    const id = `${REGLE_REPARTITION_ID}-V1`;
    const v = this.versions.get(id);
    if (v) return v;
    return this.versions.insert({
      id, ruleId: REGLE_REPARTITION_ID, version: 1, label: 'KIN-DEFAULT V1 — 70 / 10 / 10 / 10 ; pool de terrain : agent direct 10 / 0, agent de sous-traitant 7 / 3 (proposée)',
      beneficiaries: defaultBeneficiaries(), scope: { revenus: [TOUT], modules: [TOUT], methodes: [TOUT] },
      effectiveFrom: V1_DATE_EFFET, effectiveUntil: null,
      legalBasis: 'Cahier des exigences v2.9, § 37A (clé CLE-REPARTITION-37A) ; spécification v1.0 du 29/09/2026 (§ 2, § 3, § 16) ; décision du maître d’ouvrage du 29/09/2026 (pool par recette générée) — acte juridique provincial requis (§ 37A.8)', approvalDocument: null,
      pool: defaultPool(), couts: { mode: 'AUCUN', fraisGestionPct: null }, fractionnement: { infrastructureApprouvee: null }, status: 'ACTE_REQUIS', parDefaut: true,
      createdBy: 'systeme', createdAt: this.now(),
      history: [{ at: this.now(), by: 'systeme', action: 'VERSION_PROPOSEE_PAR_DEFAUT', motif: 'Reprise des constantes du § 37A (aucune valeur supprimée ni modifiée) et du pool décidé le 29/09/2026 ; activation par le circuit à quatre personnes après l’acte.' }],
    });
  }

  private version(id: string): AllocationRuleVersion {
    this.ensureV1();
    const v = this.versions.get(id);
    if (!v) throw notFound('VERSION_INCONNUE', `Version de règle inconnue : ${id}`);
    return v;
  }

  private versionView(v: AllocationRuleVersion) {
    return { ...v, statusLabel: STATUTS_VERSION[v.status], sum: sumPct(v.beneficiaries), checks: checkVersionShape(v), poolModeLabel: MODES_POOL[v.pool.mode], coutsModeLabel: MODES_COUTS[v.couts.mode] };
  }

  listVersions(user: User) {
    authorize(user, 'moteur:config.read');
    this.ensureV1();
    return {
      ruleId: REGLE_REPARTITION_ID, alias: REGLE_REPARTITION_ALIAS,
      items: this.versions.all().sort((a, b) => a.version - b.version).map((v) => this.versionView(v)),
      modesReglement: MODES_REGLEMENT, modesPool: MODES_POOL, modesCouts: MODES_COUTS, typesAgent: TYPES_AGENT, postesCouts: POSTES_COUTS,
      circuit: [
        'Rédaction (maker) : super-administrateur, ministre des Finances ou validateur financier — saisie de pourcentages PROPOSÉS, sans effet.',
        'Vérification (checker) : juriste vérificateur ou validateur financier, personne distincte du rédacteur.',
        'Approbation (approver) : ministre des Finances ou directeur de cabinet, personne distincte des deux premières.',
        'Activation : Gouverneur, ministre des Finances ou autorité de publication, quatrième personne distincte, authentification forte ; refusée sauf somme = 100,000 %, clé du § 37A ACTIVE (acte et conditions du § 37A.8) et règle CLE-REPARTITION-37A certifiée portant les mêmes taux.',
      ],
      contradictions: CONTRADICTIONS,
      note: 'Historique jamais réécrit : chaque transaction garde la version qui l’a répartie ; une nouvelle version ne s’applique qu’à partir de sa date d’effet.',
    };
  }

  proposeVersion(user: User, input: {
    label: string; beneficiaries: BeneficiaireRegle[]; scope?: { revenus?: string[]; modules?: string[]; methodes?: string[] };
    effectiveFrom: string; effectiveUntil?: string | null; legalBasis: string; approvalDocument?: string | null; pool?: PoolConfig; couts?: CoutsConfig; motif: string;
  }) {
    authorize(user, 'moteur:regle.proposer');
    this.ensureV1();
    if (input.effectiveUntil && input.effectiveUntil < input.effectiveFrom) throw badRequest('DATES_INCOHERENTES', 'Date de fin antérieure à la date d’effet.');
    const version = Math.max(...this.versions.all().map((v) => v.version)) + 1;
    const at = this.now();
    const v = this.versions.insert({
      id: `${REGLE_REPARTITION_ID}-V${version}`, ruleId: REGLE_REPARTITION_ID, version, label: input.label,
      beneficiaries: input.beneficiaries.map((b) => ({ ...b })),
      scope: { revenus: input.scope?.revenus?.length ? input.scope.revenus : [TOUT], modules: input.scope?.modules?.length ? input.scope.modules : [TOUT], methodes: input.scope?.methodes?.length ? input.scope.methodes : [TOUT] },
      effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil ?? null, legalBasis: input.legalBasis, approvalDocument: input.approvalDocument ?? null,
      pool: input.pool ?? defaultPool(), couts: input.couts ?? { mode: 'AUCUN', fraisGestionPct: null },
      status: 'PROPOSEE', parDefaut: false, createdBy: user.id, createdAt: at,
      history: [{ at, by: user.id, action: 'VERSION_PROPOSEE', motif: input.motif }],
    });
    this.audit(user, 'moteur.regle.proposee', 'allocation_rule_version', v.id, { version, motif: input.motif, beneficiaries: v.beneficiaries.map((b) => `${b.code}:${b.pct}:${b.modeReglement}`), poolMode: v.pool.mode, effectiveFrom: v.effectiveFrom });
    return this.versionView(v);
  }

  private assertShape(v: AllocationRuleVersion): void {
    const errs = checkVersionShape(v);
    if (errs.length) throw unprocessable(errs[0]!.code, errs.map((e) => e.message).join(' '), { checks: errs });
  }

  private rejectVersion(user: User, v: AllocationRuleVersion, step: string, motif: string) {
    const out = this.versions.update({ ...v, status: 'REJETEE', history: [...v.history, { at: this.now(), by: user.id, action: `REJETEE_${step}`, motif }] });
    this.audit(user, `moteur.regle.rejetee_${step.toLowerCase()}`, 'allocation_rule_version', v.id, { motif, proposedBy: step === 'VERIFICATION' ? v.createdBy : step === 'APPROBATION' ? v.reviewedBy : v.approvedBy });
    return this.versionView(out);
  }

  verifyVersion(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'moteur:regle.verifier');
    this.noSuperAdmin(user);
    const v = this.version(id);
    if (v.status !== 'PROPOSEE' && v.status !== 'ACTE_REQUIS') throw conflict('ETAPE_INVALIDE', `Version au statut ${v.status} : aucune vérification attendue.`);
    assertDistinctPerson(user.id, [v.createdBy], 'Quatre personnes : le vérificateur est distinct du rédacteur.');
    if (!input.approve) return this.rejectVersion(user, v, 'VERIFICATION', input.motif);
    this.assertShape(v);
    const at = this.now();
    const out = this.versions.update({ ...v, status: 'VERIFIEE', reviewedBy: user.id, reviewedAt: at, history: [...v.history, { at, by: user.id, action: 'VERIFIEE', motif: input.motif }] });
    this.audit(user, 'moteur.regle.verifiee', 'allocation_rule_version', v.id, { proposedBy: v.createdBy, motif: input.motif });
    this.audit(user, 'moteur.regle.transmise_approbation', 'allocation_rule_version', v.id, { motif: input.motif });
    return this.versionView(out);
  }

  approveVersion(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'moteur:regle.approuver');
    this.noSuperAdmin(user);
    const v = this.version(id);
    if (v.status !== 'VERIFIEE') throw conflict('ETAPE_INVALIDE', `Version au statut ${v.status} : aucune approbation attendue.`);
    assertDistinctPerson(user.id, [v.createdBy, v.reviewedBy ?? ''].filter(Boolean), 'Quatre personnes : l’approbateur est distinct du rédacteur et du vérificateur.');
    if (!input.approve) return this.rejectVersion(user, v, 'APPROBATION', input.motif);
    this.assertShape(v);
    const at = this.now();
    const out = this.versions.update({ ...v, status: 'APPROUVEE', approvedBy: user.id, approvedAt: at, history: [...v.history, { at, by: user.id, action: 'APPROUVEE', motif: input.motif }] });
    this.audit(user, 'moteur.regle.approuvee', 'allocation_rule_version', v.id, { proposedBy: v.reviewedBy, motif: input.motif });
    this.audit(user, 'moteur.regle.transmise_activation', 'allocation_rule_version', v.id, { motif: input.motif });
    return this.versionView(out);
  }

  /** Conditions du § 37A (acte, conditions préalables, clé active, règle certifiée aux mêmes taux) pour une version. */
  actConditions(v: AllocationRuleVersion): { ok: boolean; missing: string[]; ruleId?: string } {
    const missing: string[] = [];
    const rep = this.repartition();
    if (!rep) return { ok: false, missing: ['Module de répartition du § 37A non chargé'] };
    const k = rep.key();
    if (!k.legalAct) missing.push('Acte juridique provincial enregistré sur la clé du § 37A');
    else {
      const absent = (Object.keys(CONDITIONS) as (keyof typeof CONDITIONS)[]).filter((c) => !k.legalAct!.conditions[c]?.trim());
      if (absent.length) missing.push(`Conditions du § 37A.8 : ${absent.map((c) => CONDITIONS[c]).join(' ; ')}`);
    }
    if (k.status !== 'ACTIVE') missing.push('Clé du § 37A ACTIVE (activation décidée par deux personnes)');
    const at = new Date(Math.max(this.ctx.clock.now().getTime(), Date.parse(`${v.effectiveFrom}T12:00:00+01:00`)));
    const rate = (b: SliceCode) => v.beneficiaries.find((x) => x.code === b)?.pct ?? '';
    const same = (a: string | undefined, b: string) => a !== undefined && Number(a) === Number(b);
    // Règle PUBLIÉE (date d'effet future) ou ACTIVE : exécutable à la date d'effet de la version (quatre visas, source certifiée).
    const executable = (r: (typeof all)[number]) => isRuleExecutable(r.status === 'PUBLIEE' ? { ...r, status: 'ACTIVE' } : r, at).ok;
    const all = this.ctx.rules.list();
    const rule = all.filter((r) => r.code === KEY_RULE_CODE && executable(r) && (!k.legalAct || r.legalInstrumentIds.includes(k.legalAct.instrumentId)))
      .find((r) => same(r.rateTable.part_groupe_nseya, rate('GROUPE_NSEYA')) && same(r.rateTable.part_tutelle, rate('TUTELLE')) && same(r.rateTable.part_agents, rate('AGENTS_SOUS_TRAITANTS')) && same(r.rateTable.part_gouvernement, rate('GOUVERNEMENT_PROVINCIAL')));
    if (!rule) missing.push(`Règle ${KEY_RULE_CODE} certifiée (quatre visas, acte cité) portant les mêmes taux, exécutable à la date d’effet`);
    return { ok: missing.length === 0, missing, ...(rule ? { ruleId: rule.id } : {}) };
  }

  activateVersion(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'moteur:regle.activer');
    this.noSuperAdmin(user);
    const v = this.version(id);
    if (v.status !== 'APPROUVEE') throw conflict('ETAPE_INVALIDE', `Version au statut ${v.status} : aucune activation attendue.`);
    assertDistinctPerson(user.id, [v.createdBy, v.reviewedBy ?? '', v.approvedBy ?? ''].filter(Boolean), 'Quatre personnes : l’activation est décidée par une personne distincte du rédacteur, du vérificateur et de l’approbateur.');
    if (!input.approve) return this.rejectVersion(user, v, 'ACTIVATION', input.motif);
    this.assertShape(v);
    const cond = this.actConditions(v);
    if (!cond.ok) throw unprocessable('ACTE_REQUIS', `Activation refusée : ${cond.missing.join(' ; ')}.`, { missing: cond.missing });
    const today = this.today();
    // Historique jamais réécrit : une version active antérieure est close la veille de la date d'effet (future ou du jour).
    const previous = this.versions.find((x) => x.id !== v.id && x.status === 'ACTIVE' && (!x.effectiveUntil || x.effectiveUntil >= v.effectiveFrom));
    if (previous.length && v.effectiveFrom < today) throw unprocessable('EFFET_RETROACTIF', 'Une nouvelle version ne s’applique qu’à partir d’aujourd’hui ou d’une date future : l’historique n’est jamais réécrit.');
    const at = this.now();
    for (const p of previous) {
      const until = kinshasaDate(new Date(Date.parse(`${v.effectiveFrom}T12:00:00+01:00`) - DAY_MS));
      this.versions.update({ ...p, effectiveUntil: until, history: [...p.history, { at, by: user.id, action: `CLOTUREE_PAR_V${v.version}`, motif: `Effet jusqu’au ${until} ; transactions antérieures inchangées.` }] });
    }
    const out = this.versions.update({ ...v, status: 'ACTIVE', activatedBy: user.id, activatedAt: at, history: [...v.history, { at, by: user.id, action: 'ACTIVEE', motif: input.motif }] });
    this.audit(user, 'moteur.regle.activee', 'allocation_rule_version', v.id, { proposedBy: v.approvedBy, createdBy: v.createdBy, reviewedBy: v.reviewedBy, motif: input.motif, registryRuleId: cond.ruleId, closed: previous.map((p) => p.id) });
    this.ctx.alerts.raise({ type: 'MOTEUR_REGLE_ACTIVEE', severity: 'HIGH', source: 'moteur-repartition', detail: `Version ${v.id} de la règle de répartition activée par ${user.id} (rédaction ${v.createdBy}, vérification ${v.reviewedBy}, approbation ${v.approvedBy}).`, context: { versionId: v.id }, notifyRoles: ['R22', 'R17'] });
    return this.versionView(out);
  }

  /**
   * Version applicable à une transaction (date du paiement) : ACTIVE (réel, à partir du jour de son activation) d'abord,
   * sinon la plus récente non rejetée (SIMULATION). Avant la date d'effet de toute version : SIMULATION sur la V1,
   * marquée « avant la date d'effet » (présentation, jamais un droit exigible).
   */
  versionFor(day: string, a: { module: string | null; revenueCategory: string; methode: MethodePaiement }): { version: AllocationRuleVersion; mode: 'REEL' | 'SIMULATION'; avantEffet?: true } | null {
    this.ensureV1();
    const inScope = (list: string[], val: string | null) => list.includes(TOUT) || (val !== null && list.includes(val));
    const scoped = this.versions.all().filter((v) => v.status !== 'REJETEE' && inScope(v.scope.modules, a.module) && inScope(v.scope.revenus, a.revenueCategory) && inScope(v.scope.methodes, a.methode))
      .sort((x, y) => y.version - x.version);
    const candidates = scoped.filter((v) => v.effectiveFrom <= day && (!v.effectiveUntil || day <= v.effectiveUntil));
    const active = candidates.find((v) => v.status === 'ACTIVE' && v.activatedAt && isoDay(v.activatedAt) <= day);
    if (active) return { version: active, mode: 'REEL' };
    const sim = candidates.find((v) => v.status !== 'ACTIVE') ?? candidates[0];
    if (sim) return { version: sim, mode: 'SIMULATION' };
    const first = scoped.filter((v) => day < v.effectiveFrom).sort((x, y) => x.effectiveFrom.localeCompare(y.effectiveFrom) || x.version - y.version)[0];
    return first ? { version: first, mode: 'SIMULATION', avantEffet: true } : null;
  }

  // ═════════════════════════════ Compte de règlement principal du Gouvernement (§ 2)

  listComptes(user: User) {
    authorize(user, 'moteur:config.read');
    return {
      items: this.comptes.all().sort((a, b) => a.id.localeCompare(b.id)).map((c) => this.compteView(c)),
      regle: 'Désigné par le Gouverneur : proposé par le Trésor, vérifié par un gestionnaire du coffre, autorisé par le Gouverneur (trois personnes, authentification forte). Le numéro du compte ne change que par le circuit du coffre (deux approbateurs, vérification hors bande, 72 h). Aucun administrateur — y compris le super-administrateur — ne peut le remplacer.',
    };
  }

  private compteView(c: CompteReglement) {
    const acc = this.ctx.vault.current(c.account_reference);
    const pending = this.ctx.vault.requests.find((r) => r.alias === c.account_reference && (r.status === 'EN_ATTENTE_APPROBATION' || r.status === 'EN_REFROIDISSEMENT'));
    return { ...c, maskedNumber: acc ? maskAccount(acc.accountNumber) : null, vaultVersion: acc?.version ?? null, pendingVaultChanges: pending.map((r) => ({ id: r.id, status: r.status, coolingEndsAt: r.coolingEndsAt ?? null })) };
  }

  proposeCompte(user: User, input: { alias: string; effectiveFrom: string; motif: string; demo?: boolean }) {
    authorize(user, 'moteur:compte.proposer');
    this.noSuperAdmin(user);
    const acc = this.ctx.vault.current(input.alias);
    if (!acc) throw unprocessable('UNKNOWN_BENEFICIARY_ALIAS', `Alias inconnu du coffre des comptes bénéficiaires : ${input.alias} (aucun numéro de compte n’est saisi ici).`);
    const id = this.ids.next('CRG');
    const at = this.now();
    const c = this.comptes.insert({
      id, account_id: id, account_name: acc.holderName, financial_institution: acc.bankName, account_reference: acc.alias, currency: acc.currency,
      effective_from: input.effectiveFrom, effective_to: null, status: 'PROPOSE', authorised_by: null, approval_reference: null, created_by: user.id, verified_by: null,
      motif: input.motif, history: [{ at, by: user.id, action: 'PROPOSE', motif: input.motif }], ...(input.demo ? { demo: true } : {}),
    });
    this.audit(user, 'moteur.compte_reglement.propose', 'settlement_account', id, { alias: acc.alias, currency: acc.currency, motif: input.motif });
    return this.compteView(c);
  }

  verifyCompte(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'moteur:compte.verifier');
    this.noSuperAdmin(user);
    const c = this.comptes.get(id);
    if (!c) throw notFound('COMPTE_INCONNU', `Compte de règlement inconnu : ${id}`);
    if (c.status !== 'PROPOSE') throw conflict('ETAPE_INVALIDE', `Compte au statut ${c.status}.`);
    assertDistinctPerson(user.id, [c.created_by], 'Le gestionnaire du coffre qui vérifie est distinct du proposant.');
    const at = this.now();
    const out = this.comptes.update({ ...c, status: input.approve ? 'VERIFIE' : 'REJETE', verified_by: user.id, history: [...c.history, { at, by: user.id, action: input.approve ? 'VERIFIE' : 'REJETE', motif: input.motif }] });
    this.audit(user, input.approve ? 'moteur.compte_reglement.verifie' : 'moteur.compte_reglement.rejete', 'settlement_account', id, { proposedBy: c.created_by, motif: input.motif });
    return this.compteView(out);
  }

  authoriseCompte(user: User, id: string, input: { approve: boolean; motif: string; approvalReference: string }) {
    authorize(user, 'moteur:compte.autoriser');
    this.noSuperAdmin(user);
    const c = this.comptes.get(id);
    if (!c) throw notFound('COMPTE_INCONNU', `Compte de règlement inconnu : ${id}`);
    if (c.status !== 'VERIFIE') throw conflict('ETAPE_INVALIDE', `Compte au statut ${c.status} : vérification du coffre requise avant l’autorisation du Gouverneur.`);
    assertDistinctPerson(user.id, [c.created_by, c.verified_by ?? ''].filter(Boolean), 'Trois personnes : le Gouverneur autorise, distinct du proposant et du vérificateur.');
    const at = this.now();
    if (!input.approve) {
      const out = this.comptes.update({ ...c, status: 'REJETE', history: [...c.history, { at, by: user.id, action: 'REJETE', motif: input.motif }] });
      this.audit(user, 'moteur.compte_reglement.rejete', 'settlement_account', id, { proposedBy: c.created_by, motif: input.motif });
      return this.compteView(out);
    }
    for (const prev of this.comptes.find((x) => x.status === 'ACTIF' && x.currency === c.currency)) {
      this.comptes.update({ ...prev, status: 'REMPLACE', effective_to: c.effective_from, history: [...prev.history, { at, by: user.id, action: `REMPLACE_PAR_${c.id}` }] });
    }
    const out = this.comptes.update({ ...c, status: 'ACTIF', authorised_by: user.id, approval_reference: input.approvalReference, history: [...c.history, { at, by: user.id, action: 'AUTORISE', motif: input.motif }] });
    this.audit(user, 'moteur.compte_reglement.autorise', 'settlement_account', id, { proposedBy: c.created_by, verifiedBy: c.verified_by, approvalReference: input.approvalReference, alias: c.account_reference });
    this.ctx.alerts.raise({ type: 'MOTEUR_COMPTE_REGLEMENT', severity: 'HIGH', source: 'moteur-repartition', detail: `Compte de règlement principal (${c.currency}) désigné : ${c.account_reference}, autorisé par ${user.id}.`, context: { id }, notifyRoles: ['R22', 'R17'] });
    return this.compteView(out);
  }

  /** Cohérence : le Flux 2 de la convention tripartite vise-t-il le compte de règlement désigné ? (information, jamais bloquant) */
  coherenceConvention() {
    const conv = this.repartition()?.key().convention;
    return this.comptes.find((c) => c.status === 'ACTIF').map((c) => {
      const alias = conv?.beneficiaries.find((b) => b.flow === 'FLUX_2' && b.currency === c.currency)?.alias ?? null;
      return { currency: c.currency, compteDesigne: c.account_reference, conventionFlux2: alias, coherent: alias === null ? null : alias === c.account_reference };
    });
  }

  // ═════════════════════════════ Rattachement officiel module → entité (§ 7)

  /**
   * Propriété OFFICIELLE du module (ModuleOwnership, § 7 / § 17) : fiche de module ACTIVE citant la règle, sinon fiche
   * active du domaine de compétence du module, sinon tutelle ministérielle par défaut (à confirmer) ; jamais le collecteur.
   * Département responsable (régie, service) : la part lui revient, son ministère de tutelle est indiqué.
   */
  owner(ruleCode: string): { module: string | null; moduleLabel: string; entity: string; entityLabel: string; entityType: 'MINISTERE' | 'DEPARTEMENT'; ministry: string | null; basis: Allocation['entityBasis'] } {
    const acces = this.acces();
    const label = (e: string) => (e === ENTITE_A_RATTACHER ? 'À rattacher (arrêté requis)' : acces?.entities.get(e)?.name ?? e);
    const typeOf = (e: string): { entityType: 'MINISTERE' | 'DEPARTEMENT'; ministry: string | null } => {
      const ent = acces?.entities.get(e);
      if (!ent) return { entityType: e.startsWith('MIN') ? 'MINISTERE' : 'DEPARTEMENT', ministry: e.startsWith('MIN') ? e : null };
      if (ent.kind === 'MINISTERE') return { entityType: 'MINISTERE', ministry: ent.id };
      let cur = ent.parentId; let guard = 0;
      while (cur && guard++ < 10) { const p = acces!.entities.get(cur); if (p?.kind === 'MINISTERE') return { entityType: 'DEPARTEMENT', ministry: p.id }; cur = p?.parentId ?? null; }
      return { entityType: 'DEPARTEMENT', ministry: null };
    };
    const direct = acces?.modules.findOne((m) => m.status === 'ACTIF' && m.ruleCodes.includes(ruleCode));
    const module = moduleOfRule(ruleCode);
    const cat = module ? catalogueModule(module) : undefined;
    const moduleLabel = cat ? `${cat.code} — ${cat.label}` : 'Module non identifié';
    const out = (entity: string, basis: Allocation['entityBasis']) => ({ module, moduleLabel, entity, entityLabel: label(entity), ...typeOf(entity), basis });
    if (direct) return out(direct.responsibleEntity, 'FICHE_ACTIVE');
    const byScope = cat?.revenueScope ? acces?.modules.findOne((m) => m.status === 'ACTIF' && m.revenueScope === cat.revenueScope) : undefined;
    if (byScope) return out(byScope.responsibleEntity, 'FICHE_ACTIVE');
    const def = module ? TUTELLE_PAR_DEFAUT[module] : undefined;
    if (def) return out(def, 'TUTELLE_PAR_DEFAUT');
    return { ...out(ENTITE_A_RATTACHER, 'A_RATTACHER'), entityType: 'MINISTERE', ministry: null };
  }

  ownershipRegister(user: User) {
    authorize(user, 'moteur:config.read');
    const codes = [...new Set(this.ctx.rules.list().map((r) => r.code))].sort();
    return {
      items: codes.map((c) => {
        const o = this.owner(c);
        return {
          ruleCode: c, moduleId: o.module, moduleName: o.moduleLabel, responsibleMinistryId: o.ministry, responsibleDepartmentId: o.entityType === 'DEPARTEMENT' ? o.entity : null,
          responsibleEntity: o.entity, responsibleEntityLabel: o.entityLabel, basis: o.basis, allocationRuleId: REGLE_REPARTITION_ID, effectiveFrom: V1_DATE_EFFET, effectiveUntil: null,
        };
      }),
      note: 'La part « ministère / département » suit la propriété OFFICIELLE du module (fiche de module active, sinon tutelle par défaut à confirmer) — jamais l’entité qui encaisse (§ 7, § 17).',
    };
  }

  // ═════════════════════════════ Agents et sous-traitants (§ 9)

  /**
   * Affectation de l'agent (AgentAssignment, § 18) À LA DATE DE LA TRANSACTION : fiche confirmée en vigueur ce jour-là,
   * sinon sous-traitant du registre terrain, sinon entité du compte. Un changement ultérieur ne modifie jamais une
   * répartition déjà constatée (les lignes sont figées).
   */
  agentProfile(agentId: string, day: string = this.today()): { type: TypeAgent; subcontractorId: string | null; source: 'FICHE' | 'TERRAIN' | 'ENTITE' } {
    const f = this.fiches.find((x) => x.agent_id === agentId && (x.status === 'ACTIVE' || x.status === 'REMPLACEE') && !!x.confirmedAt && x.effective_from <= day && (!x.effective_to || day < x.effective_to))
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    if (f) return { type: f.agent_type, subcontractorId: f.subcontractor_id, source: 'FICHE' };
    const terrain = this.ctx.ext.terrain as { agents?: { get(id: string): { subcontractorId?: string } | undefined } } | undefined;
    const st = terrain?.agents?.get(agentId)?.subcontractorId;
    if (st) return { type: 'SUBCONTRACTOR_AGENT', subcontractorId: st, source: 'TERRAIN' };
    const entity = this.ctx.users.get(agentId)?.entity ?? '';
    const kind = this.acces()?.entities.get(entity)?.kind;
    const type: TypeAgent = entity === 'GOUVERNORAT' ? 'DIRECT_GOVERNMENT' : kind === 'MINISTERE' || entity.startsWith('MIN') ? 'DIRECT_MINISTRY' : 'DIRECT_DEPARTMENT';
    return { type, subcontractorId: null, source: 'ENTITE' };
  }

  listFiches(user: User) {
    authorize(user, 'moteur:agents.read');
    return { items: this.fiches.all().sort((a, b) => a.id.localeCompare(b.id)), typesAgent: TYPES_AGENT, note: 'Fiche explicite (proposée puis confirmée par une autre personne) ; à défaut : sous-traitant du registre terrain, sinon entité du compte.' };
  }

  proposeFiche(user: User, input: Omit<FicheAgent, 'id' | 'status' | 'proposedBy' | 'proposedAt' | 'confirmedBy' | 'confirmedAt' | 'commission_rule_id'> & { commission_rule_id?: string }) {
    authorize(user, 'moteur:agents.fiche.proposer');
    this.noSuperAdmin(user);
    if (!this.ctx.users.get(input.agent_id)) throw notFound('AGENT_INCONNU', `Compte d’agent inconnu : ${input.agent_id}`);
    if (input.agent_type === 'SUBCONTRACTOR_AGENT' && !input.subcontractor_id) throw unprocessable('SOUS_TRAITANT_REQUIS', 'Agent de sous-traitant : sous-traitant agréé requis.');
    if (input.agent_type !== 'SUBCONTRACTOR_AGENT' && input.subcontractor_id) throw unprocessable('SOUS_TRAITANT_INATTENDU', 'Agent rattaché directement : aucun sous-traitant (0 %).');
    const id = this.ids.next('FAG');
    const f = this.fiches.insert({ ...input, commission_rule_id: input.commission_rule_id ?? REGLE_REPARTITION_ID, id, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now() });
    this.audit(user, 'moteur.agent.fiche_proposee', 'agent_profile', id, { agentId: input.agent_id, type: input.agent_type, subcontractorId: input.subcontractor_id });
    return f;
  }

  confirmFiche(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'moteur:agents.fiche.confirmer');
    this.noSuperAdmin(user);
    const f = this.fiches.get(id);
    if (!f) throw notFound('FICHE_INCONNUE', `Fiche inconnue : ${id}`);
    if (f.status !== 'PROPOSEE') throw conflict('ETAPE_INVALIDE', `Fiche au statut ${f.status}.`);
    assertDistinctPerson(user.id, [f.proposedBy, f.agent_id], 'La fiche d’un agent est confirmée par une autre personne que le proposant et que l’agent.');
    if (input.approve) for (const o of this.fiches.find((x) => x.agent_id === f.agent_id && x.status === 'ACTIVE')) this.fiches.update({ ...o, status: 'REMPLACEE', effective_to: f.effective_from });
    const out = this.fiches.update({ ...f, status: input.approve ? 'ACTIVE' : 'REJETEE', confirmedBy: user.id, confirmedAt: this.now() });
    this.audit(user, input.approve ? 'moteur.agent.fiche_confirmee' : 'moteur.agent.fiche_rejetee', 'agent_profile', id, { proposedBy: f.proposedBy, motif: input.motif });
    return out;
  }

  // ═════════════════════════════ Sous-grand-livre des droits (§ 17)

  private post(e: Omit<EcritureDroits, 'id' | 'seq' | 'at' | 'prevHash' | 'hash'>): EcritureDroits {
    const sums = new Map<string, bigint>();
    for (const l of e.lines) {
      const m = Money.fromJSON(l.amount);
      if (m.isNegative() || m.isZero()) throw new Error('Sous-grand-livre des droits : montants de ligne strictement positifs.');
      sums.set(m.currency, (sums.get(m.currency) ?? 0n) + (l.side === 'DEBIT' ? m.minor : -m.minor));
    }
    if ([...sums.values()].some((v) => v !== 0n) || e.lines.length < 2) throw new Error('Sous-grand-livre des droits : écriture déséquilibrée.');
    const seq = this.ecritures.count() + 1;
    const prevHash = this.ecritures.all().at(-1)?.hash ?? '0'.repeat(64);
    const base = { ...e, id: `DR-${String(seq).padStart(8, '0')}`, seq, at: this.now(), prevHash };
    return this.ecritures.append({ ...base, hash: createHash('sha256').update(prevHash + canonicalJson(base)).digest('hex') });
  }

  verifyChain() {
    let prev = '0'.repeat(64);
    for (const e of this.ecritures.all()) {
      const { hash, ...base } = e;
      if (e.prevHash !== prev || createHash('sha256').update(prev + canonicalJson(base)).digest('hex') !== hash) return { valid: false, brokenAt: e.id };
      prev = hash;
    }
    return { valid: true, entries: this.ecritures.count() };
  }

  /** Règlement automatique : Gouvernorat (Flux 2) et Groupe Nseya pour l'électronique (Flux 1) ; sinon demande de règlement. */
  settlementPath(a: Allocation, l: AllocationLine): 'FLUX_AUTOMATIQUE' | 'DEMANDE_DE_REGLEMENT' {
    if (l.kind === 'GOUVERNEMENT_PROVINCIAL') return 'FLUX_AUTOMATIQUE';
    if (l.kind === 'GROUPE_NSEYA' && a.methode === 'ELECTRONIQUE') return 'FLUX_AUTOMATIQUE';
    return 'DEMANDE_DE_REGLEMENT';
  }

  private attributionMap(): Map<string, string> {
    const m = new Map<string, string>();
    const s = this.ctx.ext.sanctions as { commissions?: { lines(): { source?: string; state?: string; orderId?: string; agentId?: string }[] } } | undefined;
    try {
      for (const l of s?.commissions?.lines() ?? []) if (l.orderId && l.agentId && l.state === 'ACQUISE' && !m.has(l.orderId)) m.set(l.orderId, l.agentId);
    } catch { /* module des commissions indisponible : aucune attribution (réserve du pool) */ }
    return m;
  }

  private cashCollector(orderId: string): string | null {
    const canaux = this.ctx.ext.canaux as { points?: { collections: { findOne(p: (c: { paymentOrderId: string }) => boolean): { operatorUserId: string } | undefined } } } | undefined;
    return canaux?.points?.collections.findOne((c) => c.paymentOrderId === orderId)?.operatorUserId ?? null;
  }

  /**
   * Données de démonstration [EXEMPLE] (mode démonstration seulement, non contractuelles) : répartitions SIMULÉES de
   * transactions fictives (aucun paiement réel, aucun virement), pour que les écrans montrent des chiffres expliqués.
   * Marquées `demo` ; jamais réglées, jamais exigibles (V1 non active). Le traitement réel ne les touche pas.
   */
  seedDemo(): number {
    if (this.allocations.find((a) => !!a.demo).length) return 0;
    const v = this.ensureV1();
    const terrain = this.ctx.ext.terrain as { agents?: { find(p: (a: { subcontractorId?: string; status?: string }) => boolean): { id: string; subcontractorId?: string }[] } } | undefined;
    const stAgent = terrain?.agents?.find((a) => !!a.subcontractorId)[0];
    const cases: { rule: string; revenue: string; amount: string; cur: CurrencyCode; methode: MethodePaiement; channel: string; commune: string; day: string; agent?: string; st?: { agent: string; sub: string } }[] = [
      { rule: 'DEMO-IF-BATI', revenue: 'IMPOT_PROVINCIAL', amount: '450.00', cur: 'USD', methode: 'ELECTRONIQUE', channel: 'MOBILE_MONEY', commune: 'Limete', day: '2026-09-02', agent: 'u-agent-terrain' },
      { rule: 'DEMO-IF-BATI', revenue: 'IMPOT_PROVINCIAL', amount: '150.00', cur: 'USD', methode: 'ESPECES', channel: 'AGENT_POINT', commune: 'Limete', day: '2026-09-05' },
      { rule: 'IRL-KIN-R1', revenue: 'IMPOT_PROVINCIAL', amount: '1320.00', cur: 'USD', methode: 'ELECTRONIQUE', channel: 'BANK', commune: 'Gombe', day: '2026-09-08', agent: 'u-agent-gombe' },
      { rule: 'STAT-GOMBE-DEMO', revenue: 'REDEVANCE_SERVICE', amount: '85000.00', cur: 'CDF', methode: 'ELECTRONIQUE', channel: 'MOBILE_MONEY', commune: 'Gombe', day: '2026-09-10', agent: 'u-agent-gombe' },
      { rule: 'PUB-KIN-DEMO', revenue: 'PROVINCIAL_SPECIFIQUE', amount: '2400.00', cur: 'USD', methode: 'ELECTRONIQUE', channel: 'BANK', commune: 'Gombe', day: '2026-09-12' },
      { rule: 'PATENTE-DEMO', revenue: 'PROVINCIAL_SPECIFIQUE', amount: '120000.00', cur: 'CDF', methode: 'ESPECES', channel: 'AGENT_POINT', commune: 'Kalamu', day: '2026-09-15' },
      { rule: 'DEMO-IF-BATI', revenue: 'IMPOT_PROVINCIAL', amount: '580.00', cur: 'USD', methode: 'ELECTRONIQUE', channel: 'USSD', commune: 'Lemba', day: '2026-09-18', ...(stAgent ? { st: { agent: stAgent.id, sub: stAgent.subcontractorId! } } : { agent: 'u-agent-terrain-2' }) },
      { rule: 'IRL-KIN-R1', revenue: 'IMPOT_PROVINCIAL', amount: '960.00', cur: 'USD', methode: 'ELECTRONIQUE', channel: 'MOBILE_MONEY', commune: 'Ngaba', day: '2026-09-22', ...(stAgent ? { st: { agent: stAgent.id, sub: stAgent.subcontractorId! } } : {}) },
    ];
    let n = 0;
    for (const c of cases) {
      n += 1;
      const own = this.owner(c.rule);
      const base = Money.of(c.amount, c.cur);
      const agentId = c.st?.agent ?? c.agent ?? null;
      const agentType: TypeAgent | null = c.st ? 'SUBCONTRACTOR_AGENT' : agentId ? this.agentProfile(agentId, c.day).type : null;
      const lines = allocateTransaction(base, v, { entity: own.entity, entityLabel: own.entityLabel, entityType: own.entityType, pool: { agentId, agentType, subcontractorId: c.st?.sub ?? null, module: own.module ?? c.rule } });
      const orderId = `DEMO-EXEMPLE-${String(n).padStart(3, '0')}`;
      const id = `AL-${orderId}`;
      const at = `${c.day}T10:00:00.000Z`;
      const entry = this.post({
        type: 'CONSTAT', mode: 'SIMULATION', allocationId: id, orderId, description: `[EXEMPLE] Droits simulés — transaction fictive ${orderId} (${v.id}, démonstration non contractuelle)`,
        lines: [{ account: 'RECETTE_ELIGIBLE', side: 'DEBIT', amount: base.toJSON() }, ...lines.filter((l) => !Money.fromJSON(l.amount).isZero()).map((l) => ({ account: `A_REGLER:${l.beneficiary}`, side: 'CREDIT' as const, amount: l.amount }))],
      });
      this.allocations.append({
        id, orderId, paymentReference: `[EXEMPLE] ${orderId}`, obligationId: `[EXEMPLE] ${orderId}`, taxpayerId: '[EXEMPLE] contribuable fictif', ruleCode: c.rule, revenueCategory: c.revenue,
        module: own.module, moduleLabel: own.moduleLabel, entity: own.entity, entityLabel: own.entityLabel, entityBasis: own.basis, methode: c.methode, channel: c.channel, provider: null, commune: c.commune,
        agentId, agentType, subcontractorId: c.st?.sub ?? null, base: base.toJSON(), paidAt: at, reconciledAt: at, versionId: v.id, versionNumber: v.version, poolMode: v.pool.mode,
        mode: 'SIMULATION', lines, avantEffet: true, demo: true, entryId: entry.id, createdAt: this.now(),
      });
    }
    return n;
  }

  private allocateOrder(o: PaymentOrder, attribution: () => Map<string, string>): Allocation | null {
    const ob = this.ctx.assessment.obligations.get(o.obligationId);
    const ruleCode = ob?.ruleCode ?? 'INCONNU';
    const revenueCategory = this.ctx.rules.list().find((r) => r.code === ruleCode)?.revenueCategory ?? 'INCONNUE';
    const own = this.owner(ruleCode);
    const methode: MethodePaiement = CANAUX_ESPECES.includes(o.channel) ? 'ESPECES' : 'ELECTRONIQUE';
    const paidAt = o.confirmedAt ?? o.reconciledAt!;
    const day = isoDay(paidAt);
    const pick = this.versionFor(day, { module: own.module, revenueCategory, methode });
    if (!pick) return null;
    const { version: v, mode, avantEffet } = pick;
    const agentId = v.pool.mode === 'PAR_RECETTE_GENEREE' ? attribution().get(o.id) ?? null : null;
    const prof = agentId ? this.agentProfile(agentId, day) : null;
    const base = Money.fromJSON(o.amount);
    const lines = allocateTransaction(base, v, { entity: own.entity, entityLabel: own.entityLabel, entityType: own.entityType, pool: { agentId, agentType: prof?.type ?? null, subcontractorId: prof?.subcontractorId ?? null, module: own.module ?? ruleCode } });
    if (!sumLines(lines, base.currency).equals(base)) throw new Error(`Répartition incohérente de ${o.id} : la somme des lignes diffère de l’assiette.`);
    // Espèces : jamais encaissées par un agent public (règle constante) — droits BLOQUÉS et alerte, jamais un règlement.
    const collector = methode === 'ESPECES' ? this.cashCollector(o.id) : null;
    const collectorUser = collector ? this.ctx.users.get(collector) : undefined;
    const blocked = collectorUser && collectorUser.roles.some((r) => /^R(0[1-9]|1\d|2\d|35)$/.test(r)) ? 'ESPECES_AGENT_INTERDIT' : undefined;
    const id = `AL-${o.id}`;
    const entry = this.post({
      type: 'CONSTAT', mode, allocationId: id, orderId: o.id, description: `Droits constatés — paiement ${o.id} (${v.id}, ${mode === 'REEL' ? 'réel' : 'simulation'})`,
      lines: [
        { account: 'RECETTE_ELIGIBLE', side: 'DEBIT', amount: o.amount },
        ...lines.filter((l) => !Money.fromJSON(l.amount).isZero()).map((l) => ({ account: `A_REGLER:${l.beneficiary}`, side: 'CREDIT' as const, amount: l.amount })),
      ],
    });
    const a = this.allocations.append({
      id, orderId: o.id, paymentReference: o.paymentReference, obligationId: o.obligationId, taxpayerId: o.taxpayerId, ruleCode, revenueCategory,
      module: own.module, moduleLabel: own.moduleLabel, entity: own.entity, entityLabel: own.entityLabel, entityBasis: own.basis,
      methode, channel: o.channel, provider: o.provider ?? null, commune: o.attribution?.commune ?? null,
      agentId, agentType: prof?.type ?? null, subcontractorId: prof?.subcontractorId ?? null,
      base: o.amount, paidAt, reconciledAt: o.reconciledAt!, versionId: v.id, versionNumber: v.version, poolMode: v.pool.mode, mode, lines,
      ...(blocked ? { blocked } : {}), ...(avantEffet ? { avantEffet } : {}), entryId: entry.id, createdAt: this.now(),
    });
    if (blocked) {
      this.ctx.alerts.raise({ type: 'ESPECES_AGENT_PUBLIC', severity: 'CRITICAL', source: 'moteur-repartition', detail: `Espèces du paiement ${o.id} encaissées par un compte d’agent public (${collector}) : droits bloqués, examen humain requis (aucune sanction automatique).`, context: { orderId: o.id }, notifyRoles: ['R22', 'R24', 'R17'] });
    }
    return a;
  }

  private settledBeneficiaries(allocationId: string): Map<string, Money> {
    const m = new Map<string, Money>();
    for (const e of this.ecritures.find((x) => x.allocationId === allocationId && x.type === 'REGLEMENT')) {
      const l = e.lines.find((x) => x.side === 'DEBIT')!;
      addMoney(m, e.beneficiary!, Money.fromJSON(l.amount));
    }
    return m;
  }

  private reverse(a: Allocation, cause: 'REMBOURSE' | 'CONTREPASSE'): Contrepassation {
    const settled = this.settledBeneficiaries(a.id);
    const id = `CP-${a.orderId}`;
    const neg = a.lines.map((l) => ({ ...l, amount: Money.fromJSON(l.amount).negate().toJSON() }));
    const entry = this.post({
      type: 'CONTREPASSATION', mode: a.mode, allocationId: a.id, orderId: a.orderId, description: `Contre-écriture (${cause === 'REMBOURSE' ? 'remboursement' : 'contrepassation'}) du paiement ${a.orderId} — droits négatifs`,
      lines: [
        ...a.lines.filter((l) => !Money.fromJSON(l.amount).isZero()).map((l) => ({ account: `A_REGLER:${l.beneficiary}`, side: 'DEBIT' as const, amount: l.amount })),
        { account: 'RECETTE_ELIGIBLE', side: 'CREDIT', amount: a.base },
      ],
    });
    return this.contrepassations.append({ id, allocationId: a.id, orderId: a.orderId, cause, lines: neg, recoverable: [...settled.keys()], entryId: entry.id, createdAt: this.now() });
  }

  /** Distributions « vivantes » du § 37A contenant l'ordre, avec l'opération EXÉCUTÉE de chaque flux. */
  private flowCoverage(): Map<string, { distributionId: string; flow: FlowCode; operationId: string }[]> {
    const out = new Map<string, { distributionId: string; flow: FlowCode; operationId: string }[]>();
    const rep = this.repartition();
    const ops = this.tresor()?.operations.all() ?? [];
    if (!rep) return out;
    for (const d of rep.distributions.all()) {
      for (const flow of ['FLUX_1', 'FLUX_2'] as FlowCode[]) {
        const op = ops.find((x) => x.target.key === `repartition:${d.id}:${flow}` && x.status === 'EXECUTEE');
        if (!op) continue;
        for (const oid of d.orderIds ?? []) out.set(`O:${oid}`, [...(out.get(`O:${oid}`) ?? []), { distributionId: d.id, flow, operationId: op.id }]);
        for (const oid of d.regularisation?.orderIds ?? []) out.set(`R:${oid}`, [...(out.get(`R:${oid}`) ?? []), { distributionId: d.id, flow, operationId: op.id }]);
      }
    }
    return out;
  }

  /**
   * Traitement idempotent : constat des droits de chaque paiement RAPPROCHÉ non encore traité, contre-écritures des
   * paiements remboursés ou contrepassés, règlements constatés par les flux EXÉCUTÉS du § 37A, recouvrements par les
   * régularisations exécutées. N'émet aucun virement.
   */
  sync(trigger?: User) {
    if (trigger) { authorize(trigger, 'moteur:synchroniser'); this.noSuperAdmin(trigger); }
    this.ensureV1();
    let attrib: Map<string, string> | null = null;
    const attribution = () => (attrib ??= this.attributionMap());
    const created: string[] = []; const reversed: string[] = []; const settledIds: string[] = []; const recovered: string[] = []; let sansRegle = 0;
    for (const o of this.ctx.payments.orders.all()) {
      if (!o.reconciledAt) continue;
      let a = this.allocations.get(`AL-${o.id}`) ?? null;
      if (!a) {
        a = this.allocateOrder(o, attribution);
        if (!a) { sansRegle += 1; continue; }
        created.push(a.id);
      }
      if ((o.status === 'REMBOURSE' || o.status === 'CONTREPASSE') && !this.contrepassations.get(`CP-${o.id}`)) {
        reversed.push(this.reverse(a, o.status).id);
      }
    }
    // Règlements constatés par les deux flux du § 37A (jamais un troisième) ; recouvrements par régularisation.
    const cover = this.flowCoverage();
    for (const a of this.allocations.all()) {
      if (a.mode !== 'REEL' || a.blocked) continue;
      const cp = this.contrepassations.get(`CP-${a.orderId}`);
      const settled = this.settledBeneficiaries(a.id);
      if (!cp) {
        for (const l of a.lines) {
          if (settled.has(l.beneficiary) || Money.fromJSON(l.amount).isZero() || this.settlementPath(a, l) !== 'FLUX_AUTOMATIQUE') continue;
          const c = (cover.get(`O:${a.orderId}`) ?? []).find((x) => x.flow === l.flow);
          if (!c) continue;
          const e = this.post({
            type: 'REGLEMENT', mode: 'REEL', allocationId: a.id, orderId: a.orderId, beneficiary: l.beneficiary, reference: { distributionId: c.distributionId, operationId: c.operationId, flow: c.flow },
            description: `Règlement constaté — ${l.label} par le ${c.flow === 'FLUX_1' ? 'Flux 1' : 'Flux 2'} (répartition ${c.distributionId}, opération ${c.operationId})`,
            lines: [{ account: `A_REGLER:${l.beneficiary}`, side: 'DEBIT', amount: l.amount }, { account: `REGLE:${l.beneficiary}`, side: 'CREDIT', amount: l.amount }],
          });
          settledIds.push(e.id);
        }
      } else {
        for (const b of cp.recoverable) {
          if (this.ecritures.findOne((x) => x.type === 'RECOUVREMENT' && x.allocationId === a.id && x.beneficiary === b)) continue;
          const l = a.lines.find((x) => x.beneficiary === b)!;
          if (this.settlementPath(a, l) !== 'FLUX_AUTOMATIQUE') continue;
          const c = (cover.get(`R:${a.orderId}`) ?? []).find((x) => x.flow === l.flow);
          if (!c) continue;
          const e = this.post({
            type: 'RECOUVREMENT', mode: 'REEL', allocationId: a.id, orderId: a.orderId, beneficiary: b, reference: { distributionId: c.distributionId, operationId: c.operationId, flow: c.flow },
            description: `Recouvrement — régularisation déduite par la répartition ${c.distributionId}`,
            lines: [{ account: `REGLE:${b}`, side: 'DEBIT', amount: settled.get(b)!.toJSON() }, { account: `A_REGLER:${b}`, side: 'CREDIT', amount: settled.get(b)!.toJSON() }],
          });
          recovered.push(e.id);
        }
      }
    }
    if (created.length || reversed.length || settledIds.length || recovered.length || trigger) {
      this.audit(trigger ?? AUTO_ACTOR, 'moteur.droits.synchronises', 'entitlement_ledger', 'sous-grand-livre', { created: created.length, reversed, settled: settledIds.length, recovered: recovered.length, sansRegle });
    }
    return { created: created.length, reversed: reversed.length, settled: settledIds.length, recovered: recovered.length, sansRegle, chain: this.verifyChain() };
  }

  // ═════════════════════════════ Visibilité (§ 12)

  visibility(user: User): Visibility {
    if (user.roles.some((r) => (ROLES_EXECUTIF as readonly string[]).includes(r))) return { kind: 'EXECUTIF', personal: user.roles.some((r) => ROLES_DONNEES_PERSONNELLES.includes(r)) };
    if (user.roles.includes(ROLE_GROUPE_NSEYA)) return { kind: 'GROUPE_NSEYA' };
    if (user.roles.some((r) => ['R04', 'R06', 'R07', 'R08'].includes(r))) {
      const acces = this.acces();
      return { kind: 'ENTITE', entities: acces?.entities.get(user.entity) ? acces.subtree(user.entity) : new Set([user.entity]) };
    }
    if (user.roles.includes('R35')) {
      const terrain = this.ctx.ext.terrain as { subcontractors?: { find(p: (s: { managers: string[] }) => boolean): { id: string }[] }; agents?: { find(p: (a: { subcontractorId?: string }) => boolean): { id: string }[] } } | undefined;
      const subs = terrain?.subcontractors?.find((s) => s.managers.includes(user.id)).map((s) => s.id) ?? [];
      const agents = new Set<string>([
        ...(terrain?.agents?.find((a) => !!a.subcontractorId && subs.includes(a.subcontractorId)).map((a) => a.id) ?? []),
        ...this.fiches.find((f) => f.status === 'ACTIVE' && !!f.subcontractor_id && subs.includes(f.subcontractor_id)).map((f) => f.agent_id),
      ]);
      return { kind: 'SOUS_TRAITANT', subcontractorIds: subs, agentIds: agents };
    }
    if (user.roles.includes('R10')) return { kind: 'AGENT', agentId: user.id };
    return { kind: 'AUCUNE' };
  }

  canSeeBeneficiary(vis: Visibility, b: string): boolean {
    switch (vis.kind) {
      case 'EXECUTIF': case 'GROUPE_NSEYA': return true;
      case 'ENTITE': return b.startsWith('ENTITE:') && vis.entities.has(b.slice(7));
      case 'SOUS_TRAITANT': return (b.startsWith('SOUS_TRAITANT:') && vis.subcontractorIds.includes(b.slice(14))) || (b.startsWith('AGENT:') && vis.agentIds.has(b.slice(6)));
      case 'AGENT': return b === `AGENT:${vis.agentId}`;
      default: return false;
    }
  }

  // ═════════════════════════════ États d'un droit et agrégats (§ 4, § 11, § 13, § 20)

  /** État d'une ligne (bénéficiaire × transaction) à l'instant présent. */
  lineState(a: Allocation, l: AllocationLine, ctx: { settled: Money; cp?: Contrepassation; recovered: boolean; openDispute: boolean; inRequest?: DemandeReglement }): EtatDroit {
    if (a.mode === 'SIMULATION') return 'SIMULATION';
    if (a.blocked) return 'BLOQUE';
    const amount = Money.fromJSON(l.amount);
    if (ctx.cp) return ctx.settled.isZero() ? 'CONTREPASSE' : ctx.recovered ? 'RECOUVRE' : 'RECOUVRABLE';
    if (!amount.isZero() && ctx.settled.compare(amount) >= 0) return 'REGLE';
    if (ctx.openDispute) return 'CONTESTE';
    if (ctx.inRequest && ['APPROUVEE', 'PAIEMENT_INSTRUIT', 'PAYEE'].includes(ctx.inRequest.status)) return 'APPROUVE';
    if (!ctx.settled.isZero()) return 'PARTIELLEMENT_REGLE';
    if (l.modeReglement === 'CONSTATE_NON_EXIGIBLE') return 'NON_EXIGIBLE';
    const cadence = CADENCE_JOURS[l.modeReglement];
    if (cadence !== null && Date.parse(a.reconciledAt) + (cadence + DELAI_GRACE_REGLEMENT_JOURS) * DAY_MS < this.ctx.clock.now().getTime()) return 'EN_RETARD';
    return this.settlementPath(a, l) === 'DEMANDE_DE_REGLEMENT' ? 'PAYABLE' : 'CONSTATE';
  }

  /** Lignes visibles (bénéficiaire × transaction) avec leur état, filtrées (§ 21 : filtres). */
  rows(vis: Visibility, f: Filtre, beneficiary?: (b: string, l: AllocationLine) => boolean) {
    const disputes = new Set(this.litiges.find((x) => x.status === 'OUVERT').map((x) => `${x.allocationId}|${x.beneficiary}`));
    const requests = new Map<string, DemandeReglement>();
    for (const d of this.demandes.find((x) => x.status !== 'REJETEE' && x.status !== 'BROUILLON')) for (const it of d.items) requests.set(`${it.allocationId}|${d.beneficiary}`, d);
    const settledAll = new Map<string, Money>();
    const recoveredAll = new Set<string>();
    for (const e of this.ecritures.all()) {
      if (e.type === 'REGLEMENT') addMoney(settledAll, `${e.allocationId}|${e.beneficiary}`, Money.fromJSON(e.lines.find((x) => x.side === 'DEBIT')!.amount));
      if (e.type === 'RECOUVREMENT') recoveredAll.add(`${e.allocationId}|${e.beneficiary}`);
    }
    const out: { a: Allocation; l: AllocationLine; state: EtatDroit; settled: Money; recoverable: Money; cp?: Contrepassation }[] = [];
    for (const a of this.allocations.all()) {
      const day = isoDay(a.paidAt);
      if (f.period && !(day.startsWith(`${f.period}-`) || day === f.period)) continue;
      if (f.from && day < f.from) continue;
      if (f.to && day > f.to) continue;
      if (f.currency && a.base.currency !== f.currency) continue;
      if (f.module && a.module !== f.module && a.ruleCode !== f.module) continue;
      if (f.methode && a.methode !== f.methode) continue;
      if (f.mode && a.mode !== f.mode) continue;
      if (f.entity && a.entity !== f.entity) continue;
      if (f.commune && a.commune !== f.commune) continue;
      if (f.agent && a.agentId !== f.agent) continue;
      if (f.subcontractor && a.subcontractorId !== f.subcontractor) continue;
      if (f.provider && a.provider !== f.provider) continue;
      if (f.revenueType && a.revenueCategory !== f.revenueType) continue;
      if (vis.kind === 'ENTITE' && !vis.entities.has(a.entity)) continue;
      const cp = this.contrepassations.get(`CP-${a.orderId}`);
      for (const l of a.lines) {
        if (!this.canSeeBeneficiary(vis, l.beneficiary)) continue;
        if (beneficiary && !beneficiary(l.beneficiary, l)) continue;
        const key = `${a.id}|${l.beneficiary}`;
        const settled = settledAll.get(key) ?? Money.zero(a.base.currency);
        const req = requests.get(key);
        const state = this.lineState(a, l, { settled, ...(cp ? { cp } : {}), recovered: recoveredAll.has(key), openDispute: disputes.has(key), ...(req ? { inRequest: req } : {}) });
        if (f.state && state !== f.state) continue;
        out.push({ a, l, state, settled, recoverable: state === 'RECOUVRABLE' ? settled : Money.zero(a.base.currency), ...(cp ? { cp } : {}) });
      }
    }
    return out;
  }

  /** Chiffres d'un ensemble de lignes (une devise) : recette éligible, droit net, électronique / espèces, états. */
  figures(rows: ReturnType<MoteurRepartitionService['rows']>, currency: CurrencyCode) {
    const z = () => Money.zero(currency);
    let droit = z(); let electronique = z(); let especes = z(); let regle = z(); let regleNet = z(); let approuve = z(); let conteste = z(); let recouvrable = z(); let payable = z(); let enRetard = z(); let brut = z(); let contrepasse = z();
    const bases = new Map<string, Money>();
    for (const r of rows) {
      if (r.a.base.currency !== currency) continue;
      const amt = Money.fromJSON(r.l.amount);
      const net = r.cp ? z() : amt;
      brut = brut.add(amt);
      if (r.cp) contrepasse = contrepasse.add(amt);
      droit = droit.add(net);
      if (r.a.methode === 'ESPECES') especes = especes.add(net); else electronique = electronique.add(net);
      if (!bases.has(r.a.id)) bases.set(r.a.id, r.cp ? z() : Money.fromJSON(r.a.base));
      regle = regle.add(r.settled);
      if (!r.cp) regleNet = regleNet.add(r.settled);
      recouvrable = recouvrable.add(r.recoverable);
      if (r.state === 'APPROUVE') approuve = approuve.add(amt.subtract(r.settled));
      if (r.state === 'CONTESTE') conteste = conteste.add(amt.subtract(r.settled));
      if (r.state === 'PAYABLE' || r.state === 'EN_RETARD' || r.state === 'PARTIELLEMENT_REGLE') payable = payable.add(amt.subtract(r.settled));
      if (r.state === 'EN_RETARD') enRetard = enRetard.add(amt.subtract(r.settled));
    }
    const recettesEligibles = [...bases.values()].reduce((m, b) => m.add(b), z());
    const resteDu = droit.subtract(regleNet);
    const enAttente = resteDu.subtract(approuve).subtract(conteste);
    return {
      currency, recettesEligibles: recettesEligibles.toJSON(), droitBrut: brut.toJSON(), contrepasse: contrepasse.negate().toJSON(), droit: droit.toJSON(),
      electronique: electronique.toJSON(), especes: especes.toJSON(),
      regle: regle.toJSON(), approuve: approuve.add(regleNet).toJSON(), enAttente: (enAttente.isNegative() ? z() : enAttente).toJSON(), conteste: conteste.toJSON(),
      recouvrable: recouvrable.toJSON(), payable: payable.toJSON(), enRetard: enRetard.toJSON(), resteDu: resteDu.toJSON(),
      transactions: new Set(rows.filter((r) => r.a.base.currency === currency).map((r) => r.a.id)).size,
    };
  }

  /** Soldes par bénéficiaire calculés à partir des ÉCRITURES du sous-grand-livre (jamais un champ de solde). */
  ledgerBalances(mode: 'REEL' | 'SIMULATION' = 'REEL') {
    const acc = new Map<string, Money>();
    const byType = new Map<string, Money>();
    for (const e of this.ecritures.all()) {
      if (e.mode !== mode) continue;
      for (const l of e.lines) {
        const m = Money.fromJSON(l.amount);
        addMoney(acc, `${l.account}|${m.currency}`, l.side === 'CREDIT' ? m : m.negate());
        if (l.account.startsWith('A_REGLER:')) addMoney(byType, `${e.type}|${l.account.slice(9)}|${m.currency}`, m);
      }
    }
    const keys = [...new Set([...acc.keys()].filter((k) => k.startsWith('A_REGLER:')).map((k) => k.slice(9)))].sort();
    return keys.map((k) => {
      const [b, cur] = k.split('|') as [string, CurrencyCode];
      const t = (type: string) => byType.get(`${type}|${b}|${cur}`) ?? Money.zero(cur);
      const solde = acc.get(`A_REGLER:${b}|${cur}`) ?? Money.zero(cur);
      return {
        beneficiary: b, currency: cur, constate: t('CONSTAT').subtract(t('CONTREPASSATION')).toJSON(), regle: t('REGLEMENT').toJSON(), recouvre: t('RECOUVREMENT').toJSON(),
        solde: solde.toJSON(), resteDu: (solde.isNegative() ? Money.zero(cur) : solde).toJSON(), recouvrable: (solde.isNegative() ? solde.negate() : Money.zero(cur)).toJSON(),
      };
    });
  }

  /** Reste dû (constaté − réglé + recouvré) d'un bénéficiaire, calculé depuis les écritures RÉELLES. */
  outstanding(beneficiary: string, currency: CurrencyCode): Money {
    const b = this.ledgerBalances('REEL').find((x) => x.beneficiary === beneficiary && x.currency === currency);
    return b ? Money.fromJSON(b.solde) : Money.zero(currency);
  }

  // ═════════════════════════════ Demandes de règlement (§ 6 ; spécification v1.0, § 14)

  listDemandes(user: User) {
    const vis = this.visibility(user);
    if (vis.kind === 'AUCUNE') authorize(user, 'moteur:executif.read');
    return {
      items: this.demandes.all().filter((d) => this.canSeeBeneficiary(vis, d.beneficiary)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      etats: STATUTS_DEMANDE,
      circuit: 'Brouillon (DRAFT) → Soumise (SUBMITTED) → En examen (UNDER_REVIEW) → Approuvée (APPROVED) → Paiement instruit (PAYMENT_INSTRUCTED) → Payée (PAID) → Rapprochée (RECONCILED) → Clôturée (CLOSED). Jamais au-dessus du reste dû ; paiement par l’un des deux flux du § 37A.',
    };
  }

  private demande(id: string): DemandeReglement {
    const d = this.demandes.get(id);
    if (!d) throw notFound('DEMANDE_INCONNUE', `Demande de règlement inconnue : ${id}`);
    return d;
  }

  private step(user: User, d: DemandeReglement, to: DemandeReglement['status'], action: string, motif: string, patch: Partial<DemandeReglement> = {}, details: Record<string, unknown> = {}) {
    const at = this.now();
    const out = this.demandes.update({ ...d, ...patch, status: to, updatedAt: at, history: [...d.history, { at, by: user.id, action: to, motif }] });
    this.audit(user, `moteur.reglement.${action}`, 'settlement_request', d.id, { beneficiary: d.beneficiary, amount: d.amount, ...details });
    return out;
  }

  private settledOf(allocationId: string, beneficiary: string): Money {
    const a = this.allocations.get(allocationId)!;
    return this.settledBeneficiaries(allocationId).get(beneficiary) ?? Money.zero(a.base.currency);
  }

  /** Montants déjà engagés dans des demandes soumises et non rapprochées (net des déductions). */
  private lockedNet(beneficiary: string, currency: CurrencyCode, except?: string): Money {
    return this.demandes.find((d) => d.id !== except && d.beneficiary === beneficiary && d.currency === currency && !['REJETEE', 'RAPPROCHEE', 'CLOTUREE', 'BROUILLON'].includes(d.status))
      .reduce((m, d) => m.add(Money.fromJSON(d.amount)), Money.zero(currency));
  }

  /**
   * Brouillon de demande de règlement (§ 14) : droits PAYABLES du bénéficiaire sur la période (espèces rapprochées
   * éligibles pour Groupe Nseya), montant JAMAIS supérieur au reste dû ; soldes recouvrables déduits.
   */
  draftSettlement(user: User, input: { beneficiary: string; currency: CurrencyCode; periodStart?: string; periodEnd?: string; amount?: string; motif: string }) {
    authorize(user, 'moteur:reglement.demander');
    this.noSuperAdmin(user);
    this.sync();
    const vis = this.visibility(user);
    const own = user.roles.includes('R17') || (vis.kind === 'GROUPE_NSEYA' && input.beneficiary === 'GROUPE_NSEYA') || (vis.kind === 'ENTITE' && this.canSeeBeneficiary(vis, input.beneficiary));
    if (!own) throw forbidden('HORS_PERIMETRE', 'Demande de règlement limitée à votre propre droit.');
    const locked = new Map<string, Money>();
    for (const d of this.demandes.find((x) => !['REJETEE', 'RAPPROCHEE', 'CLOTUREE'].includes(x.status) && x.beneficiary === input.beneficiary)) {
      for (const it of d.items) addMoney(locked, it.allocationId, Money.fromJSON(it.amount));
    }
    const rows = this.rows({ kind: 'EXECUTIF', personal: false }, { currency: input.currency, mode: 'REEL', ...(input.periodStart ? { from: input.periodStart } : {}), ...(input.periodEnd ? { to: input.periodEnd } : {}) }, (b) => b === input.beneficiary)
      .filter((r) => ['PAYABLE', 'EN_RETARD', 'PARTIELLEMENT_REGLE'].includes(r.state) && this.settlementPath(r.a, r.l) === 'DEMANDE_DE_REGLEMENT')
      .map((r) => ({ r, remaining: Money.fromJSON(r.l.amount).subtract(r.settled).subtract(locked.get(r.a.id) ?? Money.zero(input.currency)) }))
      .filter((x) => !x.remaining.isNegative() && !x.remaining.isZero())
      .sort((x, y) => x.r.a.reconciledAt.localeCompare(y.r.a.reconciledAt));
    if (!rows.length) throw unprocessable('AUCUN_DROIT_PAYABLE', `Aucun droit payable pour ${input.beneficiary} en ${input.currency} sur la période.`);
    const used = new Set(this.demandes.find((d) => d.status !== 'REJETEE').flatMap((d) => d.deductions.map((x) => x.contrepassationId)));
    const deductions = this.contrepassations.all().filter((c) => c.recoverable.includes(input.beneficiary) && !used.has(c.id))
      .map((c) => ({ c, a: this.allocations.get(c.allocationId)! }))
      .filter(({ a }) => a.mode === 'REEL' && a.base.currency === input.currency && !this.ecritures.findOne((x) => x.type === 'RECOUVREMENT' && x.allocationId === a.id && x.beneficiary === input.beneficiary)
        && this.settlementPath(a, a.lines.find((l) => l.beneficiary === input.beneficiary)!) === 'DEMANDE_DE_REGLEMENT')
      .map(({ c, a }) => ({ contrepassationId: c.id, allocationId: a.id, amount: this.settledOf(a.id, input.beneficiary).toJSON() }));
    const available = rows.reduce((m, x) => m.add(x.remaining), Money.zero(input.currency));
    const deducted = deductions.reduce((m, d) => m.add(Money.fromJSON(d.amount)), Money.zero(input.currency));
    const outstanding = this.outstanding(input.beneficiary, input.currency).subtract(this.lockedNet(input.beneficiary, input.currency));
    const net = available.subtract(deducted);
    const cap = net.compare(outstanding) < 0 ? net : outstanding;
    const requested = input.amount !== undefined ? Money.of(input.amount, input.currency) : cap;
    if (cap.isNegative() || cap.isZero()) throw unprocessable('SOLDE_RECOUVRABLE', 'Rien à régler : soldes recouvrables ou demandes en cours supérieurs aux droits payables.');
    if (requested.isNegative() || requested.isZero()) throw badRequest('MONTANT_INVALIDE', 'Montant strictement positif attendu.');
    if (requested.compare(cap) > 0) throw unprocessable('REGLEMENT_SUPERIEUR_AU_RESTANT', `Montant demandé (${requested.toDecimalString()} ${input.currency}) supérieur au reste dû payable (${cap.toDecimalString()} ${input.currency}) : refusé.`, { restant: cap.toJSON() });
    // Lignes retenues dans l'ordre chronologique jusqu'au montant brut (net + déductions) ; la dernière peut être partielle.
    let gross = requested.add(deducted);
    const items: DemandeReglement['items'] = [];
    for (const x of rows) {
      if (gross.isZero()) break;
      const take = x.remaining.compare(gross) <= 0 ? x.remaining : gross;
      items.push({ allocationId: x.r.a.id, amount: take.toJSON() });
      gross = gross.subtract(take);
    }
    const id = this.ids.next('DRG');
    const at = this.now();
    const d = this.demandes.insert({
      id, beneficiary: input.beneficiary, currency: input.currency, flow: rows[0]!.r.l.flow, motif: input.motif, status: 'BROUILLON',
      periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null, requestedBy: user.id, createdAt: at, updatedAt: at,
      items, deductions, amount: requested.toJSON(), rate: rows[0]!.r.l.pct,
      eligibleBase: [...new Set(items.map((i) => i.allocationId))].reduce((m, aid) => m.add(Money.fromJSON(this.allocations.get(aid)!.base)), Money.zero(input.currency)).toJSON(),
      history: [{ at, by: user.id, action: 'BROUILLON', motif: input.motif }],
    });
    this.audit(user, 'moteur.reglement.brouillon', 'settlement_request', id, { beneficiary: d.beneficiary, amount: d.amount, items: items.length, deductions: deductions.length });
    return d;
  }

  submitSettlement(user: User, id: string, input: { motif: string }) {
    authorize(user, 'moteur:reglement.demander');
    this.noSuperAdmin(user);
    const d = this.demande(id);
    if (d.status !== 'BROUILLON') throw conflict('ETAPE_INVALIDE', `Demande au statut ${d.status}.`);
    if (d.requestedBy !== user.id) throw forbidden('HORS_PERIMETRE', 'Seul l’auteur du brouillon le soumet.');
    const cap = this.outstanding(d.beneficiary, d.currency).subtract(this.lockedNet(d.beneficiary, d.currency, d.id));
    if (Money.fromJSON(d.amount).compare(cap) > 0) throw unprocessable('REGLEMENT_SUPERIEUR_AU_RESTANT', 'Le reste dû a diminué depuis le brouillon : montant supérieur au restant, refusé.', { restant: cap.toJSON() });
    return this.step(user, d, 'SOUMISE', 'demande', input.motif);
  }

  reviewSettlement(user: User, id: string, input: { motif: string }) {
    authorize(user, 'moteur:reglement.examiner');
    this.noSuperAdmin(user);
    const d = this.demande(id);
    if (d.status !== 'SOUMISE') throw conflict('ETAPE_INVALIDE', `Demande au statut ${d.status}.`);
    assertDistinctPerson(user.id, [d.requestedBy], 'L’examen (Finance) est fait par une autre personne que le demandeur.');
    return this.step(user, d, 'EN_EXAMEN', 'en_examen', input.motif, { review: { by: user.id, at: this.now(), motif: input.motif } }, { requestedBy: d.requestedBy });
  }

  approveSettlement(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'moteur:reglement.approuver');
    this.noSuperAdmin(user);
    const d = this.demande(id);
    if (d.status !== 'EN_EXAMEN') throw conflict('ETAPE_INVALIDE', `Demande au statut ${d.status} : examen par la Finance requis avant l’approbation.`);
    assertDistinctPerson(user.id, [d.requestedBy, d.review?.by ?? ''].filter(Boolean), 'L’approbation du Gouvernement est donnée par une personne distincte du demandeur et de l’examinateur.');
    if (input.approve) {
      const cap = this.outstanding(d.beneficiary, d.currency).subtract(this.lockedNet(d.beneficiary, d.currency, d.id));
      if (Money.fromJSON(d.amount).compare(cap) > 0) throw unprocessable('REGLEMENT_SUPERIEUR_AU_RESTANT', 'Montant supérieur au reste dû : refusé.', { restant: cap.toJSON() });
    }
    const approval = { by: user.id, at: this.now(), approve: input.approve, motif: input.motif };
    return this.step(user, d, input.approve ? 'APPROUVEE' : 'REJETEE', input.approve ? 'approuve' : 'rejete', input.motif, { approval }, { requestedBy: d.requestedBy });
  }

  /** Opération du Trésor d'un des deux flux du § 37A couvrant les paiements de la demande (jamais un troisième flux). */
  private flowOperation(d: DemandeReglement, operationId: string, requireExecuted: boolean) {
    const op = this.tresor()?.operations.get(operationId);
    const m = op?.target.key.match(/^repartition:(.+):(FLUX_1|FLUX_2)$/);
    if (!op || !m) throw unprocessable('FLUX_NON_AUTORISE', 'Le règlement passe par un des deux flux du § 37A : citer une opération de décaissement de répartition (Flux 1 ou Flux 2).');
    if (op.status === 'REJETEE') throw unprocessable('FLUX_NON_EXECUTE', `Opération ${op.id} rejetée.`);
    if (requireExecuted && op.status !== 'EXECUTEE') throw unprocessable('FLUX_NON_EXECUTE', `Opération ${op.id} au statut ${op.status} : flux non exécuté.`);
    if (m[2] !== d.flow) throw unprocessable('FLUX_NON_AUTORISE', `${d.beneficiary} est réglé par le ${d.flow === 'FLUX_1' ? 'Flux 1' : 'Flux 2'} : l’opération citée relève de l’autre flux (§ 37A.4).`);
    const dist = this.repartition()?.distributions.get(m[1]!);
    const covered = new Set(dist?.orderIds ?? []);
    const missing = d.items.map((it) => this.allocations.get(it.allocationId)!).filter((a) => !covered.has(a.orderId));
    if (missing.length) throw unprocessable('PAIEMENTS_NON_COUVERTS', `La répartition ${m[1]} ne comprend pas ${missing.length} paiement(s) de la demande.`, { orderIds: missing.map((a) => a.orderId) });
    return { op, distributionId: m[1]! };
  }

  instructSettlement(user: User, id: string, input: { operationId: string; motif: string }) {
    authorize(user, 'moteur:reglement.payer');
    this.noSuperAdmin(user);
    const d = this.demande(id);
    if (d.status !== 'APPROUVEE') throw conflict('ETAPE_INVALIDE', `Demande au statut ${d.status} : approbation requise avant l’instruction du paiement.`);
    assertDistinctPerson(user.id, [d.requestedBy, d.approval!.by], 'L’instruction de paiement est faite par une personne distincte du demandeur et de l’approbateur.');
    const { op, distributionId } = this.flowOperation(d, input.operationId, false);
    return this.step(user, d, 'PAIEMENT_INSTRUIT', 'paiement_instruit', input.motif, { instruction: { by: user.id, at: this.now(), operationId: op.id, distributionId } }, { operationId: op.id, flow: d.flow });
  }

  confirmSettlementPayment(user: User, id: string, input: { reference: string }) {
    authorize(user, 'moteur:reglement.payer');
    this.noSuperAdmin(user);
    const d = this.demande(id);
    if (d.status !== 'PAIEMENT_INSTRUIT') throw conflict('ETAPE_INVALIDE', `Demande au statut ${d.status} : paiement instruit requis.`);
    assertDistinctPerson(user.id, [d.requestedBy, d.approval!.by], 'Le paiement est constaté par une personne distincte du demandeur et de l’approbateur.');
    const { op } = this.flowOperation(d, d.instruction!.operationId, true);
    return this.step(user, d, 'PAYEE', 'paye', input.reference, { payment: { by: user.id, at: this.now(), operationId: op.id, reference: input.reference } }, { operationId: op.id, reference: input.reference, approvedBy: d.approval!.by });
  }

  /** Rapprochement du règlement : écritures REGLEMENT (droits réglés) et RECOUVREMENT (compensations). */
  reconcileSettlement(user: User, id: string, input: { reference: string }) {
    authorize(user, 'moteur:reglement.rapprocher');
    this.noSuperAdmin(user);
    const d = this.demande(id);
    if (d.status !== 'PAYEE') throw conflict('ETAPE_INVALIDE', `Demande au statut ${d.status} : paiement constaté requis.`);
    assertDistinctPerson(user.id, [d.requestedBy, d.approval!.by, d.payment!.by], 'Le rapprochement du règlement est fait par une quatrième personne.');
    const ref = { demandeId: d.id, operationId: d.payment!.operationId, flow: d.flow };
    for (const it of d.items) {
      const a = this.allocations.get(it.allocationId)!;
      this.post({
        type: 'REGLEMENT', mode: 'REEL', allocationId: a.id, orderId: a.orderId, beneficiary: d.beneficiary, reference: ref, description: `Règlement rapproché — demande ${d.id} (${d.beneficiary})`,
        lines: [{ account: `A_REGLER:${d.beneficiary}`, side: 'DEBIT', amount: it.amount }, { account: `REGLE:${d.beneficiary}`, side: 'CREDIT', amount: it.amount }],
      });
    }
    for (const x of d.deductions) {
      const a = this.allocations.get(x.allocationId)!;
      this.post({
        type: 'RECOUVREMENT', mode: 'REEL', allocationId: a.id, orderId: a.orderId, beneficiary: d.beneficiary, reference: ref, description: `Recouvrement par compensation — demande ${d.id}`,
        lines: [{ account: `REGLE:${d.beneficiary}`, side: 'DEBIT', amount: x.amount }, { account: `A_REGLER:${d.beneficiary}`, side: 'CREDIT', amount: x.amount }],
      });
    }
    return this.step(user, d, 'RAPPROCHEE', 'rapproche', input.reference, { reconciliation: { by: user.id, at: this.now(), reference: input.reference } }, { paidBy: d.payment!.by });
  }

  closeSettlement(user: User, id: string, input: { motif: string }) {
    authorize(user, 'moteur:reglement.payer');
    this.noSuperAdmin(user);
    const d = this.demande(id);
    if (d.status !== 'RAPPROCHEE') throw conflict('ETAPE_INVALIDE', `Demande au statut ${d.status} : rapprochement requis avant la clôture.`);
    return this.step(user, d, 'CLOTUREE', 'cloture', input.motif);
  }

  // ═════════════════════════════ Litiges

  openDispute(user: User, input: { allocationId: string; beneficiary: string; motif: string }) {
    authorize(user, 'moteur:litige.ouvrir');
    this.noSuperAdmin(user);
    const vis = this.visibility(user);
    if (!user.roles.includes('R17') && !((vis.kind === 'GROUPE_NSEYA' && input.beneficiary === 'GROUPE_NSEYA') || (vis.kind === 'ENTITE' && this.canSeeBeneficiary(vis, input.beneficiary)))) {
      throw forbidden('HORS_PERIMETRE', 'Contestation limitée à votre propre droit.');
    }
    const a = this.allocations.get(input.allocationId);
    if (!a || !a.lines.some((l) => l.beneficiary === input.beneficiary)) throw notFound('DROIT_INCONNU', 'Droit inconnu pour ce bénéficiaire.');
    if (this.litiges.findOne((x) => x.allocationId === a.id && x.beneficiary === input.beneficiary && x.status === 'OUVERT')) throw conflict('LITIGE_OUVERT', 'Un litige est déjà ouvert sur ce droit.');
    const id = this.ids.next('LIT');
    const l = this.litiges.insert({ id, allocationId: a.id, beneficiary: input.beneficiary, motif: input.motif, status: 'OUVERT', openedBy: user.id, openedAt: this.now() });
    this.audit(user, 'moteur.litige.ouvert', 'entitlement_dispute', id, { allocationId: a.id, beneficiary: input.beneficiary });
    return l;
  }

  decideDispute(user: User, id: string, input: { fonde: boolean; motif: string }) {
    authorize(user, 'moteur:litige.decider');
    this.noSuperAdmin(user);
    const l = this.litiges.get(id);
    if (!l) throw notFound('LITIGE_INCONNU', `Litige inconnu : ${id}`);
    if (l.status !== 'OUVERT') throw conflict('ETAPE_INVALIDE', `Litige au statut ${l.status}.`);
    assertDistinctPerson(user.id, [l.openedBy], 'Le litige est tranché par une autre personne que celle qui l’a ouvert.');
    const out = this.litiges.update({ ...l, status: input.fonde ? 'FONDE' : 'NON_FONDE', decision: { by: user.id, at: this.now(), motif: input.motif } });
    this.audit(user, 'moteur.litige.decide', 'entitlement_dispute', id, { proposedBy: l.openedBy, fonde: input.fonde, motif: input.motif });
    return out;
  }

  // ═════════════════════════════ Coûts technologiques (§ 14 ; spécification v1.0, § 25)

  listCouts(user: User) {
    const vis = this.visibility(user);
    if (vis.kind !== 'GROUPE_NSEYA') authorize(user, 'moteur:config.read');
    return {
      items: this.couts.all().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)), categories: POSTES_COUTS, modes: MODES_COUTS,
      note: 'Hors répartition initiale : les coûts ne modifient jamais les droits. Financés par le Gouvernorat : position nette (présentation). Financés par Groupe Nseya : coût réel + frais de gestion autorisés = dette du Gouvernement, DISTINCTE des 10 %. Traitement désactivé par défaut ; valeurs à confirmer.',
    };
  }

  proposeCout(user: User, input: { provider: string; category: PosteCout; period: string; quantity: string; unitCost: string; currency: CurrencyCode; fundedBy: 'GOUVERNORAT' | 'GROUPE_NSEYA'; supportingInvoiceId?: string; motif: string }) {
    authorize(user, 'moteur:couts.proposer');
    this.noSuperAdmin(user);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw badRequest('INVALID_PERIOD', 'Mois attendu : AAAA-MM.');
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(input.quantity)) throw badRequest('QUANTITE_INVALIDE', 'Quantité décimale positive attendue.');
    const unit = Money.of(input.unitCost, input.currency);
    if (unit.isNegative()) throw badRequest('MONTANT_NEGATIF', 'Coût unitaire positif attendu.');
    const gross = unit.multiply(input.quantity, 'HALF_UP');
    const v = this.currentVersion();
    const feeRate = input.fundedBy === 'GROUPE_NSEYA' && v.couts.mode === 'FRAIS_GESTION_NSEYA' ? v.couts.fraisGestionPct : null;
    const fee = feeRate ? gross.percent(feeRate, 'HALF_UP') : null;
    const id = this.ids.next('CST');
    const c = this.couts.insert({
      id, provider: input.provider, category: input.category, categoryLabel: POSTES_COUTS[input.category], period: input.period, quantity: input.quantity, unitCost: unit.toJSON(),
      grossCost: gross.toJSON(), currency: input.currency, fundedBy: input.fundedBy, managementFeeRate: feeRate, managementFeeAmount: fee?.toJSON() ?? null,
      supportingInvoiceId: input.supportingInvoiceId ?? null, versionId: v.id, motif: input.motif, status: 'SOUMIS', recordedBy: user.id, recordedAt: this.now(),
    });
    this.audit(user, 'moteur.couts.propose', 'technology_cost', id, { category: input.category, period: input.period, grossCost: c.grossCost, fundedBy: input.fundedBy, managementFeeAmount: c.managementFeeAmount });
    return c;
  }

  verifyCout(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'moteur:couts.verifier');
    this.noSuperAdmin(user);
    const c = this.couts.get(id);
    if (!c) throw notFound('COUT_INCONNU', `Coût technologique inconnu : ${id}`);
    if (c.status !== 'SOUMIS') throw conflict('ETAPE_INVALIDE', `Coût au statut ${c.status}.`);
    assertDistinctPerson(user.id, [c.recordedBy], 'Le coût technologique est vérifié par une autre personne que celle qui l’a saisi.');
    const out = this.couts.update({ ...c, status: input.approve ? 'VALIDE' : 'REJETE', verifiedBy: user.id, verifiedAt: this.now() });
    this.audit(user, input.approve ? 'moteur.couts.verifie' : 'moteur.couts.rejete', 'technology_cost', id, { proposedBy: c.recordedBy, motif: input.motif });
    return out;
  }

  /** Coûts validés d'une devise et période : position nette du Gouvernorat et dette envers Groupe Nseya (distincte des 10 %). */
  positionNette(gouvernoratDroit: Money, period: string | undefined) {
    const v = this.currentVersion();
    const cur = gouvernoratDroit.currency;
    const valid = this.couts.find((c) => c.status === 'VALIDE' && c.currency === cur && (!period || c.period === period || c.period.startsWith(`${period}-`)));
    const sum = (xs: TechnologyCost[], f: (c: TechnologyCost) => MoneyJSON | null) => xs.reduce((m, c) => { const x = f(c); return x ? m.add(Money.fromJSON(x)) : m; }, Money.zero(cur));
    const gouv = valid.filter((c) => c.fundedBy === 'GOUVERNORAT');
    const nseya = valid.filter((c) => c.fundedBy === 'GROUPE_NSEYA');
    const coutsGouvernorat = sum(gouv, (c) => c.grossCost);
    const coutsNseya = sum(nseya, (c) => c.grossCost);
    const frais = sum(nseya, (c) => c.managementFeeAmount);
    return {
      mode: v.couts.mode, modeLabel: MODES_COUTS[v.couts.mode], versionId: v.id, aConfirmer: true, couts: valid.map((c) => c.id),
      coutsGouvernorat: coutsGouvernorat.toJSON(), partBrute: gouvernoratDroit.toJSON(),
      positionNette: (v.couts.mode === 'DEDUCTION_PART_GOUVERNORAT' ? gouvernoratDroit.subtract(coutsGouvernorat) : gouvernoratDroit).toJSON(),
      coutsFinancesParNseya: coutsNseya.toJSON(), fraisGestion: frais.toJSON(), fraisGestionPct: v.couts.fraisGestionPct,
      detteServicesNseya: coutsNseya.add(frais).toJSON(),
      note: 'Dette technologique envers Groupe Nseya : distincte de sa part de 10 %, jamais confondue.',
    };
  }

  // ═════════════════════════════ Contrôle de période

  static checkPeriod(p?: string) {
    if (p && !PERIOD_RE.test(p)) throw badRequest('INVALID_PERIOD', 'Période attendue : AAAA ou AAAA-MM.');
  }

  currentVersion(): AllocationRuleVersion {
    this.ensureV1();
    const today = this.today();
    const all = this.versions.all().sort((a, b) => b.version - a.version);
    return all.find((v) => v.status === 'ACTIVE' && v.effectiveFrom <= today && (!v.effectiveUntil || today <= v.effectiveUntil))
      ?? all.find((v) => v.status === 'ACTIVE') ?? this.version(`${REGLE_REPARTITION_ID}-V1`);
  }

  canReadPersonal(user: User): boolean {
    return evaluate(user, 'taxpayer.read', {}) === 'full' && user.roles.some((r) => ROLES_DONNEES_PERSONNELLES.includes(r));
  }

  modeLabel(m: ModeReglement) { return MODES_REGLEMENT[m]; }
}
