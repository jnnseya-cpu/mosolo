/**
 * Service des verticales (§ 11.3) : catalogue, espace de l'usager par verticale (objets, obligations, quittances issus
 * du socle), démarches en ligne génériques (dépôt, pièces par empreinte, instruction, visite, décision motivée),
 * plaques (NFIU et plaques d'objets), marchés sans espèces (titres d'étal), événements (billetterie, certificat QR),
 * construction (visite, quitus de chantier), télécom (rapprochement contradictoire des sites).
 *
 * Doctrine : aucune obligation sans règle ACTIVE (quatre visas) ; les verticales « acte requis » n'en produisent aucune ;
 * tout paiement passe par le circuit commun (obligation → ordre de paiement → rappel signé → quittance) ; aucune sanction,
 * aucun blocage automatique : le système constate et propose, une personne habilitée décide avec motif.
 */
import { createHmac } from 'node:crypto';
import { isRuleExecutable, Money, type MoneyJSON, type PaymentStatus } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, isoDate } from '../../core/clock.js';
import { validityView, type ValidityView } from '../../core/validity.js';
import { checkChar, randomSecret, safeEqualHex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate, type Access } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { PAYABLE_STATUSES, type Obligation } from '../../modules/assessment/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import {
  CERTIFICATE_LABEL, COMMUNE_CENTROIDS, findVertical, LEGAL_LABEL, NO_LEVY_STATUSES, OBJECT_TYPE_VERTICAL, VERTICALS,
  type CertificateKind, type ProcedureDef, type VerticalDef,
} from './catalogue.js';
import { AviaService } from './avia.js';
import { CalcuService } from './calcu.js';
import { P } from './policies.js';

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export type CaseStatus = 'DEPOSE' | 'EN_INSTRUCTION' | 'COMPLEMENT_DEMANDE' | 'PROPOSE' | 'ACCEPTE' | 'REFUSE';
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  DEPOSE: 'Déposée', EN_INSTRUCTION: 'En instruction', COMPLEMENT_DEMANDE: 'Complément demandé', PROPOSE: 'Proposition en attente de décision',
  ACCEPTE: 'Acceptée', REFUSE: 'Refusée',
};

export interface CaseDocument { label: string; sha256: string; addedAt: string; addedBy: string }
export interface CaseEvent { at: string; by: string; action: string; status: CaseStatus; note?: string }
export type VisitResult = 'CONFORME' | 'NON_CONFORME' | 'A_REVOIR';
export interface Visit { id: string; date: string; result: VisitResult; observations: string; evidenceSha256?: string; by: string; at: string }

export interface VxCase {
  id: string;
  vertical: string;
  type: string;
  typeLabel: string;
  kind: ProcedureDef['kind'];
  taxpayerId: string;
  objectId?: string;
  entity: string;
  commune: string | null;
  details: Record<string, string>;
  documents: CaseDocument[];
  status: CaseStatus;
  history: CaseEvent[];
  visits: Visit[];
  submittedBy: string;
  createdAt: string;
  updatedAt: string;
  instructorId?: string;
  proposal?: { outcome: 'ACCEPTER' | 'REFUSER'; reason: string; by: string; at: string };
  decision?: { outcome: 'ACCEPTE' | 'REFUSE'; reason: string; by: string; at: string };
  createdObjectId?: string;
  certificateCode?: string;
  /** Signalement protégé (demande d'espèces) : instruit par l'anti-fraude, identité du déclarant masquée aux agents. */
  protectedReport?: boolean;
}

export interface Certificate {
  id: string;
  code: string;
  kind: CertificateKind;
  label: string;
  vertical: string;
  caseId: string;
  objectId?: string;
  taxpayerId: string;
  commune: string | null;
  validFrom: string;
  validUntil?: string;
  status: 'VALIDE' | 'REVOQUE';
  issuedBy: string;
  issuedAt: string;
  signature: string;
}

export type PlateKind = 'NFIU' | 'ETAL' | 'SITE_TELECOM' | 'EMBARCATION' | 'CHANTIER';
export const PLATE_LABEL: Record<PlateKind, string> = {
  NFIU: 'Plaque fiscale immobilière (NFIU)', ETAL: 'Plaque d’étal', SITE_TELECOM: 'Plaque de site télécom', EMBARCATION: 'Plaque d’embarcation', CHANTIER: 'Panneau de chantier',
};
const PLATE_PREFIX: Record<PlateKind, string> = { NFIU: 'KIN', ETAL: 'MCH', SITE_TELECOM: 'TEL', EMBARCATION: 'EMB', CHANTIER: 'CHT' };

export interface Plate {
  id: string;
  code: string;
  kind: PlateKind;
  objectId: string;
  commune: string;
  quartier: string;
  status: 'POSEE' | 'REMPLACEE';
  issuedBy: string;
  issuedAt: string;
  replacedBy?: string;
  replacementReason?: string;
  signature: string;
}

export interface PlateScan {
  id: string; plateCode: string; by: string; at: string; access: Access;
  /** Couleur de situation de l'objet AU MOMENT du scan (rouge = défaut révélé : impayé à l'échéance). */
  situation?: 'green' | 'amber' | 'red' | 'grey';
  /** Obligations de l'objet exigibles et impayées au moment du scan (seules attribuables au scan). */
  dueObligationIds?: string[];
}

export interface Market { id: string; name: string; commune: string; quartier: string }
export interface Stall {
  id: string;
  marketId: string;
  row: string;
  number: string;
  category: string;
  surfaceM2: string;
  holderTaxpayerId?: string;
  objectId?: string;
}
export type TitlePeriod = 'JOUR' | 'SEMAINE' | 'MOIS';
export const TITLE_DAYS: Record<TitlePeriod, number> = { JOUR: 1, SEMAINE: 7, MOIS: 30 };
export interface StallTitle { id: string; stallId: string; taxpayerId: string; period: TitlePeriod; obligationId: string; requestedBy: string; createdAt: string }

export interface TicketingDeclaration {
  id: string;
  eventObjectId: string;
  taxpayerId: string;
  ticketsSold: number;
  source: 'RAKAPAY' | 'AUTRE_OPERATEUR' | 'DECLARATION_MANUELLE';
  fileSha256?: string;
  declaredBy: string;
  declaredAt: string;
  obligationId?: string;
  controls: { observedAttendance: number; by: string; at: string; gap: number; note: string }[];
}

export interface Cessation { id: string; objectId: string; dateEffet: string; caseId: string; decidedBy: string }

/** Codes des règles FICTIVES de démonstration par verticale (publiées par le circuit des quatre visas au semis). */
export const VX_DEMO_RULES: Record<string, string> = {
  marches: 'DEMO-VX-MCH-ETAL',
  evenements: 'DEMO-VX-EVT-SPEC',
  construction: 'DEMO-VX-CHT-VOIRIE',
  mobilite: 'DEMO-VX-VIG',
};

export const DEMO_RULE_NOTICE = 'Règle fictive de démonstration, non opposable';

const COMMUNE_CODES: Record<string, string> = {
  Bandalungwa: 'BDL', Barumbu: 'BRB', Bumbu: 'BMB', Gombe: 'GMB', Kalamu: 'KLM', 'Kasa-Vubu': 'KSV', Kimbanseke: 'KMB', Kinshasa: 'KIN',
  Kintambo: 'KTB', Kisenso: 'KSS', Lemba: 'LMB', Limete: 'LMT', Lingwala: 'LGW', Makala: 'MKL', Maluku: 'MLK', Masina: 'MSN',
  Matete: 'MTT', 'Mont-Ngafula': 'MNG', Ndjili: 'NDJ', Ngaba: 'NGB', Ngaliema: 'NGL', 'Ngiri-Ngiri': 'NGN', Nsele: 'NSL', Selembao: 'SLB',
};

const CONFIRMED: PaymentStatus[] = ['CONFIRME', 'REGLE', 'RAPPROCHE'];

const actorOf = (u: User) => ({ kind: 'user' as const, id: u.id, roles: u.roles });

// ---------------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------------

export class VerticalesService {
  readonly cases = new InMemoryRepository<VxCase>();
  readonly certificates = new InMemoryRepository<Certificate>();
  readonly plates = new InMemoryRepository<Plate>();
  readonly scans = new InMemoryAppendOnlyRepository<PlateScan>();
  readonly markets = new InMemoryRepository<Market>();
  readonly stalls = new InMemoryRepository<Stall>();
  readonly titles = new InMemoryRepository<StallTitle>();
  readonly ticketing = new InMemoryRepository<TicketingDeclaration>();
  readonly cessations = new InMemoryAppendOnlyRepository<Cessation>();
  private readonly ids = new IdGenerator();
  /** Clé de signature des plaques et certificats (démonstration : générée au démarrage ; production : HSM). */
  private readonly signingKey = randomSecret();

  /**
   * Principal technique qui liquide les titres à tarif fixe demandés par l'usager lui-même (droit d'étal) : il n'agit
   * qu'à la demande explicite du redevable et seulement sur une règle ACTIVE. Toujours tracé dans l'audit.
   */
  readonly titleService: User = { kind: 'user', id: 'svc-verticales-titres', name: 'Service des titres à tarif fixe (verticales)', roles: ['R11'], entity: 'DGTK' };

  readonly avia: AviaService;
  readonly calcu: CalcuService;

  constructor(readonly ctx: AppContext) {
    this.avia = new AviaService(ctx);
    this.calcu = new CalcuService(ctx);
  }

  // ------------------------------------------------------------------ utilitaires

  now(): Date {
    return this.ctx.clock.now();
  }

  sign(payload: string): string {
    return createHmac('sha256', this.signingKey).update(payload).digest('hex');
  }

  verifySignature(payload: string, signature: string): boolean {
    return safeEqualHex(this.sign(payload), signature);
  }

  vertical(slug: string): VerticalDef {
    const v = findVertical(slug);
    if (!v) throw notFound('VERTICAL_NOT_FOUND', `Verticale inconnue : ${slug}`);
    return v;
  }

  /** Verticale d'un objet : attribut `verticale` explicite, sinon type d'objet, sinon catégorie du socle. */
  verticalOf(o: FiscalObject): string | undefined {
    const explicit = typeof o.attributes.verticale === 'string' ? o.attributes.verticale : undefined;
    if (explicit && findVertical(explicit)) return explicit;
    const t = typeof o.attributes.objectType === 'string' ? o.attributes.objectType : undefined;
    if (t && OBJECT_TYPE_VERTICAL[t]) return OBJECT_TYPE_VERTICAL[t];
    return VERTICALS.find((v) => v.objectCategories.includes(o.category))?.slug;
  }

  /** `withName: false` (accès minimal, « Autour de moi ») : type seul, sans nom ni raison sociale. */
  describeObject(o: FiscalObject, opts: { withName?: boolean } = {}): { label: string; ref: string; detail: string } {
    const a = o.attributes;
    const s = (k: string) => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]) : undefined);
    const type = s('objectType');
    const place = `${o.commune} · ${o.quartier}`;
    const labels: Record<string, string> = {
      PARCELLE: 'Parcelle', BATIMENT: 'Bâtiment', UNITE_LOCATIVE: 'Unité locative', ACTIVITE: 'Établissement', VEHICULE: 'Véhicule', PANNEAU: 'Dispositif publicitaire', AUTRE: 'Objet',
    };
    const typeLabels: Record<string, string> = {
      ETABLISSEMENT: 'Établissement', ETAL: 'Étal', EMPRISE: 'Emprise du domaine public', SITE_TELECOM: 'Site télécom', METTEUR_EN_MARCHE: 'Metteur en marché',
      POINT_COLLECTE: 'Point de collecte', EMBARCATION: 'Embarcation', EVENEMENT: 'Événement', CHANTIER: 'Chantier', AERONEF: 'Aéronef',
    };
    const base = (type && typeLabels[type]) ?? labels[o.category] ?? 'Objet';
    const name = opts.withName === false ? undefined : s('nom') ?? s('raisonSociale') ?? s('nature') ?? s('usage') ?? s('description');
    const label = name ? `${base} — ${name}` : base;
    const ref = s('immatriculation') ?? s('plaque') ?? s('reference') ?? s('stallId') ?? o.id;
    const extra = [s('lieu'), s('dateDebut') && `du ${s('dateDebut')}`, s('dateFin') && `au ${s('dateFin')}`, s('usage_vehicule'), s('type')].filter(Boolean).join(' · ');
    return { label, ref, detail: extra ? `${place} · ${extra}` : place };
  }

  private coords(commune: string): { lat: number; lon: number } {
    const c = COMMUNE_CENTROIDS[commune] ?? [-4.33, 15.31];
    return { lat: c[0], lon: c[1] };
  }

  private recipientsOfTaxpayer(taxpayerId: string) {
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    return tp ? [taxpayerRecipient(tp)] : [];
  }

  private agentsOf(entity: string, roles: string[]) {
    return this.ctx.users.all().filter((u) => u.entity === entity && u.roles.some((r) => roles.includes(r))).map(userRecipient);
  }

  /** Utilisateur « contribuable » rattaché à un contribuable (pour créer un objet au statut DÉCLARÉ). */
  private ownerUser(taxpayerId: string): User | undefined {
    return this.ctx.users.all().find((u) => u.roles.includes('R30') && u.taxpayerId === taxpayerId);
  }

  /** Règle la plus récente d'un code, et statut d'exécutabilité à l'instant. */
  ruleByCode(code: string): RuleRecord | undefined {
    return this.ctx.rules.list().filter((r) => r.code === code).sort((a, b) => b.version - a.version)[0];
  }

  activeRuleFor(slug: string): RuleRecord | undefined {
    const code = VX_DEMO_RULES[slug];
    if (!code) return undefined;
    const rules = this.ctx.rules.list().filter((r) => r.code === code && isRuleExecutable(r, this.now()).ok);
    return rules.sort((a, b) => b.version - a.version)[0];
  }

  // ------------------------------------------------------------------ catalogue

  catalogueSummary(v: VerticalDef) {
    return {
      slug: v.slug, name: v.name, short: v.short, icon: v.icon, accent: v.accent, modules: v.modules,
      legal: v.legal, legalLabel: LEGAL_LABEL[v.legal], acceptsLevies: !NO_LEVY_STATUSES.includes(v.legal),
      entity: v.entity, entityName: v.entityName, tutelle: v.tutelle, release: v.release,
      audience: v.audience, promise: v.promise, vigilance: v.vigilance, managedBy: v.managedBy ?? null,
    };
  }

  catalogueDetail(v: VerticalDef) {
    const code = VX_DEMO_RULES[v.slug];
    const rule = code ? this.ruleByCode(code) : undefined;
    return {
      ...this.catalogueSummary(v),
      prerequisites: v.prerequisites,
      objectsTitle: v.objectsTitle,
      procedures: v.procedures,
      pendingLevies: v.pendingLevies,
      rights: v.rights,
      rules: rule
        ? [{
            code: rule.code, version: rule.version, label: rule.label, status: rule.status, demo: rule.demo === true,
            executable: isRuleExecutable(rule, this.now()).ok,
            notice: rule.demo ? DEMO_RULE_NOTICE : isRuleExecutable(rule, this.now()).ok ? 'Règle active' : 'Non exigible tant que la règle n’est pas ACTIVE',
          }]
        : [],
    };
  }

  // ------------------------------------------------------------------ espace de l'usager

  private obligationView(o: Obligation) {
    const rule = this.ctx.rules.rules.get(o.ruleId);
    const orders = this.ctx.payments.byObligation(o.id);
    const confirmed = orders.find((p) => CONFIRMED.includes(p.status));
    const pending = orders.find((p) => p.status === 'INITIE' && new Date(p.expiresAt) > this.now());
    const demo = rule?.demo === true;
    const payable = PAYABLE_STATUSES.includes(o.status) && !confirmed;
    return {
      id: o.id, label: o.label, objectId: o.objectId, ruleCode: o.ruleCode, ruleVersion: o.ruleVersion,
      ruleStatus: rule?.status ?? 'INCONNU', demo,
      ruleNotice: demo ? DEMO_RULE_NOTICE : `Règle ${o.ruleCode} v${o.ruleVersion} — ${rule?.status ?? 'statut inconnu'}`,
      amount: o.amount, status: o.status, dueDate: o.dueDate, commune: o.attribution.commune, createdAt: o.createdAt,
      payable,
      payment: confirmed
        ? { status: confirmed.status, paymentReference: confirmed.paymentReference, confirmedAt: confirmed.confirmedAt ?? null }
        : pending
          ? { status: pending.status, paymentReference: pending.paymentReference, confirmedAt: null }
          : null,
    };
  }

  private objectView(o: FiscalObject) {
    const d = this.describeObject(o);
    const plate = this.plates.findOne((p) => p.objectId === o.id && p.status === 'POSEE');
    const cessation = this.cessations.findOne((c) => c.objectId === o.id);
    return {
      id: o.id, ...d, category: o.category, objectType: typeof o.attributes.objectType === 'string' ? o.attributes.objectType : null,
      commune: o.commune, quartier: o.quartier, probativeStatus: o.probativeStatus, status: o.status,
      plate: plate ? { code: plate.code, kind: plate.kind, status: plate.status } : null,
      cessation: cessation ? { dateEffet: cessation.dateEffet, caseId: cessation.caseId } : null,
    };
  }

  /** Objets, obligations, quittances, démarches et titres d'un contribuable pour une verticale — vraies données du socle. */
  space(user: User, slug: string, taxpayerId: string) {
    const v = this.vertical(slug);
    this.ctx.taxpayers.get(taxpayerId);
    authorize(user, P.spaceRead, { taxpayerId });
    const objects = this.ctx.objects.byTaxpayer(taxpayerId).filter((o) => this.verticalOf(o) === v.slug);
    const objectIds = new Set(objects.map((o) => o.id));
    // Verticale « acte requis » : aucune obligation ne peut exister ; on n'en affiche aucune, même par erreur de rattachement.
    const obligations = NO_LEVY_STATUSES.includes(v.legal)
      ? []
      : this.ctx.assessment.byTaxpayer(taxpayerId).filter((o) => objectIds.has(o.objectId) && o.status !== 'ANNULEE');
    const oblIds = new Set(obligations.map((o) => o.id));
    const receipts = this.ctx.receipts.byTaxpayer(taxpayerId).filter((r) => oblIds.has(r.obligationId));
    const cases = this.cases.find((c) => c.vertical === v.slug && c.taxpayerId === taxpayerId);
    const certificates = this.certificates.find((c) => c.vertical === v.slug && c.taxpayerId === taxpayerId);
    return {
      vertical: this.catalogueDetail(v),
      taxpayerId,
      objects: objects.map((o) => this.objectView(o)),
      obligations: obligations.map((o) => this.obligationView(o)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      receipts: receipts.map((r) => ({
        number: r.number, code: r.code, status: r.status, amount: r.amount, paidAt: r.paidAt, obligationId: r.obligationId,
        label: obligations.find((o) => o.id === r.obligationId)?.label ?? r.revenueCategory,
      })),
      cases: cases.map((c) => this.caseView(c, 'full')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      certificates: certificates.map((c) => this.certificateView(c)),
      ...(v.slug === 'marches' ? { stalls: this.stallsOf(taxpayerId) } : {}),
      ...(v.slug === 'evenements' ? { ticketing: this.ticketing.find((t) => t.taxpayerId === taxpayerId) } : {}),
    };
  }

  /** Synthèse par verticale pour le portail (compteurs). */
  summary(user: User, taxpayerId: string) {
    authorize(user, P.spaceRead, { taxpayerId });
    const objects = this.ctx.objects.byTaxpayer(taxpayerId);
    const obligations = this.ctx.assessment.byTaxpayer(taxpayerId).filter((o) => o.status !== 'ANNULEE');
    return VERTICALS.map((v) => {
      const objs = objects.filter((o) => this.verticalOf(o) === v.slug);
      const ids = new Set(objs.map((o) => o.id));
      const obls = NO_LEVY_STATUSES.includes(v.legal) ? [] : obligations.filter((o) => ids.has(o.objectId));
      const toPay = obls.filter((o) => this.obligationView(o).payable).length;
      const openCases = this.cases.find((c) => c.vertical === v.slug && c.taxpayerId === taxpayerId && !['ACCEPTE', 'REFUSE'].includes(c.status)).length;
      return { slug: v.slug, objects: objs.length, obligations: obls.length, toPay, openCases };
    });
  }

  // ------------------------------------------------------------------ démarches en ligne

  caseResource(c: VxCase) {
    return { taxpayerId: c.taxpayerId, entity: c.entity, communes: c.commune ? [c.commune] : [] };
  }

  caseView(c: VxCase, access: Access) {
    const base = {
      id: c.id, vertical: c.vertical, type: c.type, typeLabel: c.typeLabel, kind: c.kind, status: c.status, statusLabel: CASE_STATUS_LABEL[c.status],
      entity: c.entity, commune: c.commune, objectId: c.objectId ?? null, createdAt: c.createdAt, updatedAt: c.updatedAt,
      documents: c.documents, visits: c.visits, history: c.history, proposal: c.proposal ?? null, decision: c.decision ?? null,
      instructorId: c.instructorId ?? null, createdObjectId: c.createdObjectId ?? null, certificateCode: c.certificateCode ?? null,
      protectedReport: c.protectedReport === true,
    };
    // Accès minimal (agent de terrain) : ni détails déclarés, ni identité du demandeur.
    if (access === 'minimal') return { ...base, details: {}, taxpayerId: null, documents: [], masked: true };
    return { ...base, details: c.details, taxpayerId: c.protectedReport ? null : c.taxpayerId };
  }

  getCase(id: string): VxCase {
    const c = this.cases.get(id);
    if (!c) throw notFound('CASE_NOT_FOUND', `Démarche inconnue : ${id}`);
    return c;
  }

  readCase(user: User, id: string) {
    const c = this.getCase(id);
    const access = authorize(user, P.caseRead, this.caseResource(c));
    // Le déclarant d'un signalement protégé voit son dossier ; les agents de l'entité gestionnaire ne le voient pas.
    return this.caseView(c, access);
  }

  listCases(user: User, filter: { vertical?: string; status?: string; taxpayerId?: string }) {
    const all = this.cases.find((c) =>
      (!filter.vertical || c.vertical === filter.vertical) && (!filter.status || c.status === filter.status) && (!filter.taxpayerId || c.taxpayerId === filter.taxpayerId));
    return all.flatMap((c) => {
      const access = evaluate(user, P.caseRead, this.caseResource(c));
      return access ? [this.caseView(c, access)] : [];
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private push(c: VxCase, user: User, action: string, status: CaseStatus, note?: string): VxCase {
    const at = this.now().toISOString();
    return { ...c, status, updatedAt: at, history: [...c.history, { at, by: user.id, action, status, ...(note ? { note } : {}) }] };
  }

  submitCase(
    user: User,
    slug: string,
    input: { type: string; taxpayerId?: string; objectId?: string; details: Record<string, string>; documents: { label: string; sha256: string }[] },
  ) {
    const v = this.vertical(slug);
    if (v.managedBy) throw unprocessable('VERTICAL_MANAGED_ELSEWHERE', `Les démarches de ${v.name} sont servies par leur module dédié.`);
    const proc = v.procedures.find((p) => p.code === input.type);
    if (!proc) throw badRequest('UNKNOWN_PROCEDURE', `Démarche inconnue pour ${v.name} : ${input.type}`);
    const taxpayerId = input.taxpayerId ?? user.taxpayerId;
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable concerné requis (mandataire : préciser taxpayerId).');
    this.ctx.taxpayers.get(taxpayerId);
    authorize(user, P.caseSubmit, { taxpayerId });

    let commune: string | null = null;
    if (proc.requiresObject) {
      if (!input.objectId) throw badRequest('OBJECT_REQUIRED', 'Cette démarche porte sur un objet : préciser objectId.');
      const o = this.ctx.objects.get(input.objectId);
      if (o.taxpayerId !== taxpayerId) throw forbidden('OBJECT_NOT_OWNED', 'L’objet n’est pas rattaché à ce contribuable.');
      if (this.verticalOf(o) !== v.slug) throw unprocessable('OBJECT_WRONG_VERTICAL', `L’objet ${o.id} ne relève pas de ${v.name}.`);
      commune = o.commune;
    }
    for (const f of proc.fields) {
      const val = input.details[f.key];
      if (f.required && (val === undefined || String(val).trim() === '')) throw badRequest('FIELD_REQUIRED', `Champ requis : ${f.label}`);
      if (val === undefined || val === '') continue;
      if (f.type === 'commune' && !isCommune(val)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${val}`);
      if (f.type === 'number' && !/^\d{1,12}(\.\d{1,4})?$/.test(val)) throw badRequest('INVALID_NUMBER', `${f.label} : nombre positif attendu.`);
      if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) throw badRequest('INVALID_DATE', `${f.label} : date AAAA-MM-JJ attendue.`);
      if (f.type === 'select' && f.options && !f.options.some((o) => o.value === val)) throw badRequest('INVALID_OPTION', `${f.label} : valeur non prévue.`);
    }
    const allowed = new Set(proc.fields.map((f) => f.key));
    const details = Object.fromEntries(Object.entries(input.details).filter(([k]) => allowed.has(k)).map(([k, val]) => [k, String(val).trim()]));
    if (!commune && details.commune) commune = details.commune;
    if (proc.effect.kind === 'ASSIGN_STALL') {
      const stall = this.stalls.get(details.stallId ?? '');
      if (!stall) throw unprocessable('STALL_NOT_FOUND', `Étal inconnu du plan : ${details.stallId}`);
      if (stall.holderTaxpayerId) throw conflict('STALL_TAKEN', `L’étal ${stall.id} est déjà attribué.`);
      commune = this.markets.get(stall.marketId)?.commune ?? null;
    }
    const at = this.now().toISOString();
    const entity = proc.protectedReport ? 'AUDIT' : v.entity;
    const c = this.cases.insert({
      id: this.ids.next(`DEM-${this.now().getUTCFullYear()}`),
      vertical: v.slug, type: proc.code, typeLabel: proc.label, kind: proc.kind, taxpayerId,
      ...(input.objectId && proc.requiresObject ? { objectId: input.objectId } : {}),
      entity, commune, details,
      documents: input.documents.map((d) => ({ label: d.label, sha256: d.sha256, addedAt: at, addedBy: user.id })),
      status: 'DEPOSE', history: [{ at, by: user.id, action: 'Dépôt', status: 'DEPOSE' }], visits: [],
      submittedBy: user.id, createdAt: at, updatedAt: at,
      ...(proc.protectedReport ? { protectedReport: true } : {}),
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'vertical.case.submitted', resourceType: 'vertical_case', resourceId: c.id,
      details: { vertical: v.slug, type: proc.code, taxpayerId: proc.protectedReport ? 'protégé' : taxpayerId, documents: c.documents.length, entity },
    });
    this.ctx.comms.publish(proc.kind === 'AUTORISATION' ? 'permit.application.received' : 'declaration.submitted', this.recipientsOfTaxpayer(taxpayerId), { reference: c.id }, { entity: v.entity });
    if (proc.protectedReport) {
      this.ctx.comms.publish('fraud.cash_request_reported', this.agentsOf('AUDIT', ['R24']), { reference: c.id }, { entity: 'AUDIT' });
    }
    return this.caseView(c, 'full');
  }

  addDocuments(user: User, id: string, docs: { label: string; sha256: string }[]) {
    let c = this.getCase(id);
    authorize(user, P.caseSubmit, { taxpayerId: c.taxpayerId });
    if (!['DEPOSE', 'EN_INSTRUCTION', 'COMPLEMENT_DEMANDE'].includes(c.status)) {
      throw conflict('CASE_CLOSED', `Démarche au statut ${CASE_STATUS_LABEL[c.status]} : aucune pièce ne peut être ajoutée.`);
    }
    const at = this.now().toISOString();
    const known = new Set(c.documents.map((d) => d.sha256));
    const added = docs.filter((d) => !known.has(d.sha256)).map((d) => ({ label: d.label, sha256: d.sha256, addedAt: at, addedBy: user.id }));
    c = { ...c, documents: [...c.documents, ...added], updatedAt: at };
    if (c.status === 'COMPLEMENT_DEMANDE') c = this.push(c, user, 'Complément déposé', 'EN_INSTRUCTION');
    const saved = this.cases.update(c);
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.case.documents_added', resourceType: 'vertical_case', resourceId: id, details: { added: added.length } });
    return this.caseView(saved, 'full');
  }

  take(user: User, id: string) {
    const c = this.getCase(id);
    authorize(user, P.caseInstruct, this.caseResource(c));
    if (c.status !== 'DEPOSE') throw conflict('INVALID_CASE_STATE', `Prise en charge impossible au statut ${CASE_STATUS_LABEL[c.status]}.`);
    const saved = this.cases.update({ ...this.push(c, user, 'Prise en charge', 'EN_INSTRUCTION'), instructorId: user.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.case.taken', resourceType: 'vertical_case', resourceId: id });
    return this.caseView(saved, 'full');
  }

  private assertInstructor(user: User, c: VxCase) {
    authorize(user, P.caseInstruct, this.caseResource(c));
    if (c.instructorId !== user.id) throw forbidden('NOT_CASE_INSTRUCTOR', 'Seul l’agent qui instruit le dossier peut effectuer cette action.');
  }

  requestInfo(user: User, id: string, note: string) {
    const c = this.getCase(id);
    this.assertInstructor(user, c);
    if (c.status !== 'EN_INSTRUCTION') throw conflict('INVALID_CASE_STATE', `Demande de complément impossible au statut ${CASE_STATUS_LABEL[c.status]}.`);
    const saved = this.cases.update(this.push(c, user, 'Complément demandé', 'COMPLEMENT_DEMANDE', note));
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.case.info_requested', resourceType: 'vertical_case', resourceId: id, details: { note } });
    this.ctx.comms.publish('approval.returned', this.recipientsOfTaxpayer(c.taxpayerId), { reference: id }, { entity: c.entity });
    return this.caseView(saved, 'full');
  }

  /** Constat de visite : l'agent constate (photo par empreinte), il ne décide ni ne sanctionne. */
  recordVisit(user: User, id: string, input: { date: string; result: VisitResult; observations: string; evidenceSha256?: string }) {
    const c = this.getCase(id);
    authorize(user, P.caseVisit, this.caseResource(c));
    const proc = this.vertical(c.vertical).procedures.find((p) => p.code === c.type);
    if (!proc || proc.visit === 'SANS') throw unprocessable('VISIT_NOT_APPLICABLE', 'Cette démarche ne comporte pas de visite sur place.');
    if (!['EN_INSTRUCTION', 'COMPLEMENT_DEMANDE'].includes(c.status)) throw conflict('INVALID_CASE_STATE', 'La visite se consigne pendant l’instruction.');
    const at = this.now().toISOString();
    const visit: Visit = { id: this.ids.next('VIS'), date: input.date, result: input.result, observations: input.observations, ...(input.evidenceSha256 ? { evidenceSha256: input.evidenceSha256 } : {}), by: user.id, at };
    const saved = this.cases.update({ ...c, visits: [...c.visits, visit], updatedAt: at, history: [...c.history, { at, by: user.id, action: `Visite : ${input.result}`, status: c.status, note: input.observations }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.case.visit_recorded', resourceType: 'vertical_case', resourceId: id, details: { result: input.result, evidence: input.evidenceSha256 ?? null } });
    this.ctx.comms.publish('object.field_visit.done', this.recipientsOfTaxpayer(c.taxpayerId), { reference: id }, { entity: c.entity });
    return this.caseView(saved, 'full');
  }

  propose(user: User, id: string, input: { outcome: 'ACCEPTER' | 'REFUSER'; reason: string }) {
    const c = this.getCase(id);
    this.assertInstructor(user, c);
    if (c.status !== 'EN_INSTRUCTION') throw conflict('INVALID_CASE_STATE', `Proposition impossible au statut ${CASE_STATUS_LABEL[c.status]}.`);
    if (input.outcome === 'ACCEPTER') this.assertAcceptable(c);
    const at = this.now().toISOString();
    const saved = this.cases.update({ ...this.push(c, user, `Proposition : ${input.outcome === 'ACCEPTER' ? 'accepter' : 'refuser'}`, 'PROPOSE', input.reason), proposal: { ...input, by: user.id, at } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.case.proposed', resourceType: 'vertical_case', resourceId: id, details: { outcome: input.outcome } });
    this.ctx.comms.publish('approval.requested', this.agentsOf(c.entity, ['R07', 'R06', ...(c.protectedReport ? ['R22'] : [])]), { reference: id }, { entity: c.entity });
    return this.caseView(saved, 'full');
  }

  /** Conditions d'acceptation vérifiées par le système (il constate ; la personne habilitée décide). */
  conditionsFor(c: VxCase): { code: string; label: string; met: boolean }[] {
    const proc = this.vertical(c.vertical).procedures.find((p) => p.code === c.type);
    const out: { code: string; label: string; met: boolean }[] = [];
    if (!proc) return out;
    const last = c.visits[c.visits.length - 1];
    if (proc.visit === 'OBLIGATOIRE') out.push({ code: 'VISIT_DONE', label: 'Visite sur place consignée', met: c.visits.length > 0 });
    if ((proc.kind === 'AUTORISATION' || proc.kind === 'QUITUS') && proc.visit === 'OBLIGATOIRE') {
      out.push({ code: 'VISIT_CONFORME', label: 'Dernière visite : conforme', met: last?.result === 'CONFORME' });
    }
    if (proc.kind === 'QUITUS' && c.objectId) {
      const obls = this.ctx.assessment.obligations.find((o) => o.objectId === c.objectId && o.status !== 'ANNULEE');
      const unpaid = obls.filter((o) => o.status !== 'SOLDEE' && !this.ctx.payments.byObligation(o.id).some((p) => CONFIRMED.includes(p.status)));
      out.push({ code: 'DUES_SETTLED', label: unpaid.length ? `Droits du chantier non réglés : ${unpaid.map((o) => o.id).join(', ')}` : 'Droits liés au chantier réglés (paiement confirmé)', met: unpaid.length === 0 });
      const contested = obls.some((o) => o.status === 'CONTESTEE');
      out.push({ code: 'NO_OPEN_DISPUTE', label: 'Aucune contestation en cours sur le chantier', met: !contested });
    }
    if (proc.effect.kind === 'ASSIGN_STALL') {
      const stall = this.stalls.get(c.details.stallId ?? '');
      out.push({ code: 'STALL_FREE', label: 'Étal toujours libre', met: !!stall && !stall.holderTaxpayerId });
    }
    return out;
  }

  private assertAcceptable(c: VxCase) {
    const unmet = this.conditionsFor(c).filter((x) => !x.met);
    if (unmet.length) {
      throw unprocessable('CONDITIONS_UNMET', `Conditions non remplies : ${unmet.map((u) => u.label).join(' ; ')}.`, { unmet });
    }
  }

  decide(user: User, id: string, input: { decision: 'ACCEPTE' | 'REFUSE'; reason: string }) {
    const c = this.getCase(id);
    authorize(user, P.caseDecide, this.caseResource(c));
    if (c.status !== 'PROPOSE') throw conflict('INVALID_CASE_STATE', 'Une décision suppose une proposition d’instruction préalable.');
    const previous = [c.instructorId, ...c.visits.map((vv) => vv.by)].filter((x): x is string => !!x);
    try {
      assertDistinctPerson(user.id, previous, 'La personne qui décide doit être distincte de celle qui a instruit ou visité le dossier.');
    } catch (e) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.case.decision.refused', resourceType: 'vertical_case', resourceId: id, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    if (input.decision === 'ACCEPTE') this.assertAcceptable(c);
    const at = this.now().toISOString();
    let next: VxCase = { ...this.push(c, user, input.decision === 'ACCEPTE' ? 'Décision : acceptée' : 'Décision : refusée', input.decision, input.reason), decision: { outcome: input.decision, reason: input.reason, by: user.id, at } };
    const v = this.vertical(c.vertical);
    const proc = v.procedures.find((p) => p.code === c.type)!;
    if (input.decision === 'ACCEPTE') next = this.applyEffect(user, next, v, proc);
    const saved = this.cases.update(next);
    this.ctx.audit.append({
      actor: actorOf(user), action: 'vertical.case.decided', resourceType: 'vertical_case', resourceId: id,
      details: { decision: input.decision, createdObjectId: saved.createdObjectId ?? null, certificate: saved.certificateCode ?? null },
    });
    const accepted = input.decision === 'ACCEPTE';
    const event = saved.certificateCode
      ? proc.kind === 'QUITUS' ? 'clearance.issued' : 'permit.issued'
      : accepted ? 'approval.approved' : proc.kind === 'AUTORISATION' ? 'permit.refused' : 'approval.rejected';
    this.ctx.comms.publish(event, this.recipientsOfTaxpayer(c.taxpayerId), { reference: saved.certificateCode ?? id }, { entity: c.entity });
    return this.caseView(saved, 'full');
  }

  private applyEffect(user: User, c: VxCase, v: VerticalDef, proc: ProcedureDef): VxCase {
    const e = proc.effect;
    if (e.kind === 'CREATE_OBJECT') {
      const commune = c.details.commune ?? 'Gombe';
      const creator = this.ownerUser(c.taxpayerId) ?? user;
      const obj = this.ctx.objects.create(creator, {
        taxpayerId: c.taxpayerId, category: e.category, commune, quartier: c.details.quartier ?? 'À préciser', localityRank: 2, ...this.coords(commune),
        attributes: { ...c.details, verticale: v.slug, objectType: e.objectType, demarche: c.id, positionIndicative: true },
      });
      let out: VxCase = { ...c, createdObjectId: obj.id };
      if (e.certificate) out = { ...out, certificateCode: this.issueCertificate(user, out, v, e.certificate, obj.id).code };
      return out;
    }
    if (e.kind === 'CERTIFICATE') return { ...c, certificateCode: this.issueCertificate(user, c, v, e.certificate, c.objectId).code };
    if (e.kind === 'CESSATION') {
      if (c.objectId) this.cessations.append({ id: this.ids.next('CES'), objectId: c.objectId, dateEffet: c.details.dateEffet ?? isoDate(this.now()), caseId: c.id, decidedBy: user.id });
      return c;
    }
    if (e.kind === 'ASSIGN_STALL') {
      const stall = this.stalls.get(c.details.stallId ?? '')!;
      const obj = this.assignStall(stall, c.taxpayerId, c.details.categorie);
      return { ...c, createdObjectId: obj.id };
    }
    return c;
  }

  // ------------------------------------------------------------------ certificats (QR vérifiable)

  private certificateValidity(kind: CertificateKind, c: VxCase): { from: string; until?: string } {
    const today = isoDate(this.now());
    const addDays = (n: number) => isoDate(new Date(this.now().getTime() + n * DAY_MS));
    switch (kind) {
      case 'AUTORISATION_EVENEMENT': return { from: c.details.dateDebut ?? today, until: c.details.dateFin ?? addDays(1) };
      case 'AUTORISATION_OCCUPATION': return { from: c.details.debut ?? today, until: c.details.fin ?? addDays(30) };
      case 'PERMIS_OCCUPER_VOIE': return { from: today, until: addDays(30 * Math.max(1, Number.parseInt(c.details.dureeMois ?? '1', 10) || 1)) };
      case 'QUITUS_CHANTIER': return { from: today, until: addDays(90) };
      default: return { from: today, until: `${this.now().getUTCFullYear()}-12-31` };
    }
  }

  issueCertificate(user: User, c: VxCase, v: VerticalDef, kind: CertificateKind, objectId?: string): Certificate {
    const prefix: Record<CertificateKind, string> = {
      AUTORISATION_EVENEMENT: 'EVT', PERMIS_OCCUPER_VOIE: 'POV', QUITUS_CHANTIER: 'QTC', AUTORISATION_OCCUPATION: 'OCC', AUTORISATION_ACTIVITE: 'AUT', AUTORISATION_TRANSPORT: 'TRP',
    };
    const seq = this.ids.next(`CRT-${prefix[kind]}`, 5).split('-').pop()!;
    const body = `${prefix[kind]}${this.now().getUTCFullYear()}${seq}`;
    const code = `${prefix[kind]}-${this.now().getUTCFullYear()}-${seq}-${checkChar(body)}`;
    const validity = this.certificateValidity(kind, c);
    const commune = objectId ? this.ctx.objects.objects.get(objectId)?.commune ?? c.commune : c.commune;
    const cert = this.certificates.insert({
      id: code, code, kind, label: CERTIFICATE_LABEL[kind], vertical: v.slug, caseId: c.id, ...(objectId ? { objectId } : {}), taxpayerId: c.taxpayerId,
      commune: commune ?? null, validFrom: validity.from, ...(validity.until ? { validUntil: validity.until } : {}), status: 'VALIDE',
      issuedBy: user.id, issuedAt: this.now().toISOString(), signature: this.sign(`${code}|${kind}|${validity.from}|${validity.until ?? ''}`),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.certificate.issued', resourceType: 'vertical_certificate', resourceId: code, details: { kind, caseId: c.id, validUntil: cert.validUntil ?? null } });
    return cert;
  }

  certificateView(c: Certificate) {
    return { code: c.code, kind: c.kind, label: c.label, vertical: c.vertical, caseId: c.caseId, objectId: c.objectId ?? null, commune: c.commune, validFrom: c.validFrom, validUntil: c.validUntil ?? null, status: this.certificateStatus(c), validity: validityView(c.validFrom, c.validUntil ?? null, this.now()) };
  }

  certificateStatus(c: Certificate): 'VALIDE' | 'EXPIRE' | 'A_VENIR' | 'REVOQUE' {
    if (c.status === 'REVOQUE') return 'REVOQUE';
    const today = isoDate(this.now());
    if (c.validUntil && today > c.validUntil) return 'EXPIRE';
    if (today < c.validFrom) return 'A_VENIR';
    return 'VALIDE';
  }

  /** Vérification publique minimale : ni nom, ni adresse, ni montant. */
  publicCertificate(code: string) {
    const c = this.certificates.get(code.trim().toUpperCase());
    if (!c) return { code, authentique: false, message: 'Aucun titre ne correspond à ce code.' };
    const status = this.certificateStatus(c);
    const signatureValide = this.verifySignature(`${c.code}|${c.kind}|${c.validFrom}|${c.validUntil ?? ''}`, c.signature);
    const messages = { VALIDE: 'Titre authentique et en cours de validité.', EXPIRE: 'Titre authentique, validité échue.', A_VENIR: 'Titre authentique, validité non encore ouverte.', REVOQUE: 'Titre révoqué.' };
    return { code: c.code, authentique: signatureValide, type: c.label, verticale: this.vertical(c.vertical).name, commune: c.commune, validFrom: c.validFrom, validUntil: c.validUntil ?? null, statut: status, message: messages[status], validity: status === 'REVOQUE' ? null : validityView(c.validFrom, c.validUntil ?? null, this.now()) };
  }

  // ------------------------------------------------------------------ plaques (NFIU et objets)

  plateKindFor(o: FiscalObject): PlateKind {
    if (o.category === 'PARCELLE' || o.category === 'BATIMENT') return 'NFIU';
    const t = o.attributes.objectType;
    if (t === 'ETAL') return 'ETAL';
    if (t === 'SITE_TELECOM') return 'SITE_TELECOM';
    if (t === 'EMBARCATION') return 'EMBARCATION';
    if (t === 'CHANTIER') return 'CHANTIER';
    throw unprocessable('PLATE_NOT_APPLICABLE', `Aucune plaque n’est prévue pour cet objet (${o.category}${typeof t === 'string' ? ` / ${t}` : ''}).`);
  }

  private plateView(p: Plate) {
    return { code: p.code, kind: p.kind, label: PLATE_LABEL[p.kind], objectId: p.objectId, commune: p.commune, quartier: p.quartier, status: p.status, issuedAt: p.issuedAt, issuedBy: p.issuedBy, replacedBy: p.replacedBy ?? null };
  }

  issuePlate(user: User, objectId: string, replacing?: { plate: Plate; reason: string }) {
    const o = this.ctx.objects.get(objectId);
    authorize(user, P.plateIssue, { communes: [o.commune] });
    const kind = this.plateKindFor(o);
    const active = this.plates.findOne((p) => p.objectId === o.id && p.status === 'POSEE');
    if (active && active.code !== replacing?.plate.code) throw conflict('PLATE_ALREADY_ISSUED', `Une plaque est déjà posée sur cet objet : ${active.code}.`, { plateCode: active.code });
    const com = COMMUNE_CODES[o.commune] ?? 'XXX';
    const seq = this.ids.next(`PLQ-${PLATE_PREFIX[kind]}-${com}`, 6).split('-').pop()!;
    const body = `${PLATE_PREFIX[kind]}${com}${seq}`;
    const code = `${PLATE_PREFIX[kind]}-${com}-${seq}-${checkChar(body)}`;
    const at = this.now().toISOString();
    const plate = this.plates.insert({
      id: code, code, kind, objectId: o.id, commune: o.commune, quartier: o.quartier, status: 'POSEE', issuedBy: user.id, issuedAt: at,
      signature: this.sign(`${code}|${o.id}|${o.commune}|${o.quartier}`),
    });
    if (replacing) {
      this.plates.update({ ...replacing.plate, status: 'REMPLACEE', replacedBy: code, replacementReason: replacing.reason });
    }
    this.ctx.audit.append({ actor: actorOf(user), action: replacing ? 'vertical.plate.replaced' : 'vertical.plate.issued', resourceType: 'plate', resourceId: code, details: { objectId: o.id, kind, commune: o.commune, replaces: replacing?.plate.code ?? null, reason: replacing?.reason ?? null } });
    if (o.taxpayerId) this.ctx.comms.publish('object.plate.issued', this.recipientsOfTaxpayer(o.taxpayerId), { reference: code }, { entity: kind === 'NFIU' ? 'DGIPK' : 'DGTK' });
    return this.plateView(plate);
  }

  getPlate(code: string): Plate {
    const p = this.plates.get(code.trim().toUpperCase());
    if (!p) throw notFound('PLATE_NOT_FOUND', `Plaque inconnue : ${code}`);
    return p;
  }

  replacePlate(user: User, code: string, reason: string) {
    const p = this.getPlate(code);
    if (p.status !== 'POSEE') throw conflict('PLATE_NOT_ACTIVE', 'Seule une plaque posée peut être remplacée.');
    return this.issuePlate(user, p.objectId, { plate: p, reason });
  }

  /** Vérification publique minimale (§ 16.8, ARB-76) : plaque authentique, objet enregistré, commune, quartier. Jamais « payé / non payé ». */
  publicPlate(code: string) {
    const p = this.plates.get(code.trim().toUpperCase());
    if (!p) return { code, authentique: false, message: 'Aucune plaque ne correspond à ce code. Signalez une plaque suspecte à la Ville.' };
    const authentique = this.verifySignature(`${p.code}|${p.objectId}|${p.commune}|${p.quartier}`, p.signature);
    return {
      code: p.code, authentique, type: PLATE_LABEL[p.kind], statut: p.status === 'POSEE' ? 'EN_SERVICE' : 'REMPLACEE',
      enregistre: true, commune: p.commune, quartier: p.quartier,
      // Le Cahier des exigences prévaut (décision de la Ville) : couleur de situation publique, sans nom, montant ni date de paiement.
      ...(authentique && p.status === 'POSEE' ? (() => { const sit = this.objectSituation(p.objectId); return { situation: { color: sit.color, label: sit.label } }; })() : {}),
      // Plaque d'étal : validité du titre d'occupation en cours (droit de place), sans nom ni montant.
      ...(authentique && p.status === 'POSEE' && p.kind === 'ETAL' ? (() => {
        const stall = this.stalls.findOne((x) => x.objectId === p.objectId);
        if (!stall) return {};
        const t = this.currentTitle(stall.id);
        return { titre: { statut: t.status, label: t.statusLabel, validFrom: t.validFrom ?? null, validUntil: t.validUntil, validity: t.validity ?? null } };
      })() : {}),
      message: p.status === 'POSEE' ? 'Plaque authentique, objet enregistré.' : 'Plaque remplacée : elle n’est plus en service.',
    };
  }

  /** Situation fiscale de l'objet (couleur) : calculée serveur ; l'agent ne peut rien modifier ni négocier. */
  private objectSituation(objectId: string): { color: 'green' | 'amber' | 'red' | 'grey'; label: string; lastPaymentAt: string | null; dueIds: string[] } {
    const obls = this.ctx.assessment.obligations.find((o) => o.objectId === objectId && o.status !== 'ANNULEE');
    if (!obls.length) return { color: 'grey', label: 'Aucune obligation émise', lastPaymentAt: null, dueIds: [] };
    let late = false; let open = false; let last: string | null = null;
    const dueIds: string[] = [];
    for (const o of obls) {
      const paid = this.ctx.payments.byObligation(o.id).filter((p) => CONFIRMED.includes(p.status));
      for (const p of paid) if (p.confirmedAt && (!last || p.confirmedAt > last)) last = p.confirmedAt;
      if (o.status === 'SOLDEE' || paid.length) continue;
      if (o.status === 'CONTESTEE') continue;
      dueIds.push(o.id);
      if (o.dueDate < isoDate(this.now()) || o.status === 'EN_RETARD') late = true;
      else open = true;
    }
    if (late) return { color: 'red', label: 'Impayé à l’échéance', lastPaymentAt: last, dueIds };
    if (open) return { color: 'amber', label: 'En attente de paiement', lastPaymentAt: last, dueIds };
    return { color: 'green', label: 'À jour', lastPaymentAt: last, dueIds };
  }

  /** Scan par un agent habilité : lecture seule, journalisée ; accès minimal sans montant. */
  scanPlate(user: User, code: string) {
    const p = this.getPlate(code);
    const access = authorize(user, P.plateScan, { communes: [p.commune] });
    const o = this.ctx.objects.get(p.objectId);
    // Situation constatée au scan, conservée : seul un scan ROUGE (défaut révélé) peut fonder une commission.
    const found = this.objectSituation(o.id);
    this.scans.append({ id: this.ids.next('SCAN', 8), plateCode: p.code, by: user.id, at: this.now().toISOString(), access, situation: found.color, dueObligationIds: found.dueIds });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.plate.scanned', resourceType: 'plate', resourceId: p.code, details: { access, objectId: o.id } });
    const leases = this.ctx.objects.leases.find((l) => l.unitObjectId === o.id || this.ctx.objects.objects.get(l.unitObjectId)?.attributes.parcelleId === o.id);
    const occupation = p.kind === 'NFIU' ? (leases.length ? 'MIS_EN_BAIL' : 'OCCUPE_PAR_LE_PROPRIETAIRE_OU_NON_DECLARE') : null;
    const situation = { color: found.color, label: found.label, lastPaymentAt: found.lastPaymentAt };
    const stall = p.kind === 'ETAL' ? this.stalls.findOne((s) => s.objectId === o.id) : undefined;
    const lastVisit = this.cases.find((c) => c.objectId === o.id).flatMap((c) => c.visits).sort((a, b) => b.at.localeCompare(a.at))[0];
    const base = {
      plate: this.plateView(p), access, object: { id: o.id, category: o.category, commune: o.commune, quartier: o.quartier, probativeStatus: o.probativeStatus, gps: { lat: o.lat, lon: o.lon } },
      occupation, situation, lastFinding: lastVisit ? { date: lastVisit.date, result: lastVisit.result } : null,
      stallTitle: stall ? this.currentTitle(stall.id) : null,
      notice: 'Lecture seule : aucun montant ne peut être modifié, négocié ou estimé sur place. Aucun encaissement par l’agent.',
    };
    if (access === 'minimal') return base;
    const obligations = this.ctx.assessment.obligations.find((ob) => ob.objectId === o.id && ob.status !== 'ANNULEE').map((ob) => this.obligationView(ob));
    return { ...base, obligations };
  }

  /** Guichet / banque sans smartphone : obligations payables d'un objet sur présentation de la plaque. */
  counterLookup(user: User, code: string) {
    const p = this.getPlate(code);
    authorize(user, P.plateCounter, {});
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.plate.counter_lookup', resourceType: 'plate', resourceId: p.code });
    const obligations = this.ctx.assessment.obligations.find((o) => o.objectId === p.objectId && o.status !== 'ANNULEE').map((o) => this.obligationView(o)).filter((o) => o.payable);
    return { plate: this.plateView(p), obligations, notice: 'Le guichet émet une référence de paiement vers le compte public ; il n’encaisse aucune espèce hors point agréé.' };
  }

  /** Rapport journalier automatique d'activité des agents (poses, scans), sans montant. */
  dailyReport(user: User, date: string) {
    authorize(user, P.plateReport, {});
    const issued = this.plates.find((p) => p.issuedAt.startsWith(date));
    const scans = this.scans.find((s) => s.at.startsWith(date));
    const agents = new Set([...issued.map((p) => p.issuedBy), ...scans.map((s) => s.by)]);
    const rows = [...agents].map((id) => ({
      agentId: id, agentName: this.ctx.users.get(id)?.name ?? id,
      platesIssued: issued.filter((p) => p.issuedBy === id).length,
      platesReplaced: issued.filter((p) => p.issuedBy === id && this.plates.findOne((x) => x.replacedBy === p.code)).length,
      scans: scans.filter((s) => s.by === id).length,
      communes: [...new Set(issued.filter((p) => p.issuedBy === id).map((p) => p.commune))],
    }));
    return { date, generatedAt: this.now().toISOString(), totals: { platesIssued: issued.length, scans: scans.length }, agents: rows };
  }

  platesIndicators() {
    const all = this.plates.all();
    const nfiu = all.filter((p) => p.kind === 'NFIU' && p.status === 'POSEE');
    const buildings = this.ctx.objects.objects.find((o) => o.category === 'PARCELLE' || o.category === 'BATIMENT').length;
    return { platesInService: all.filter((p) => p.status === 'POSEE').length, nfiuInService: nfiu.length, buildingsRegistered: buildings };
  }

  // ------------------------------------------------------------------ marchés sans espèces

  seedMarket(m: Market) {
    return this.markets.insert(m);
  }

  seedStall(s: Stall) {
    return this.stalls.insert(s);
  }

  assignStall(stall: Stall, taxpayerId: string, category?: string): FiscalObject {
    const market = this.markets.get(stall.marketId)!;
    const creator = this.ownerUser(taxpayerId);
    if (!creator) throw unprocessable('OWNER_ACCOUNT_REQUIRED', 'Le commerçant doit disposer d’un compte pour recevoir un étal.');
    const obj = this.ctx.objects.create(creator, {
      taxpayerId, category: 'AUTRE', commune: market.commune, quartier: market.quartier, localityRank: 2, ...this.coords(market.commune),
      attributes: { verticale: 'marches', objectType: 'ETAL', nom: `${category ?? stall.category} — ${market.name}, rangée ${stall.row}`, stallId: stall.id, marche: market.name, surface_m2: stall.surfaceM2, positionIndicative: true },
    });
    this.stalls.update({ ...stall, holderTaxpayerId: taxpayerId, objectId: obj.id, ...(category ? { category } : {}) });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'verticales' }, action: 'vertical.stall.assigned', resourceType: 'stall', resourceId: stall.id, details: { objectId: obj.id } });
    return obj;
  }

  marketPlan() {
    return this.markets.all().map((m) => {
      const stalls = this.stalls.find((s) => s.marketId === m.id);
      return {
        ...m,
        stalls: stalls.map((s) => ({ id: s.id, row: s.row, number: s.number, category: s.category, surfaceM2: s.surfaceM2, occupied: !!s.holderTaxpayerId, titleStatus: s.holderTaxpayerId ? this.currentTitle(s.id).status : null })),
        occupied: stalls.filter((s) => s.holderTaxpayerId).length,
        paidOccupied: stalls.filter((s) => s.holderTaxpayerId && ['VERT', 'AMBRE', 'ROUGE'].includes(this.currentTitle(s.id).status)).length,
      };
    });
  }

  private stallsOf(taxpayerId: string) {
    return this.stalls.find((s) => s.holderTaxpayerId === taxpayerId).map((s) => {
      const m = this.markets.get(s.marketId)!;
      const plate = s.objectId ? this.plates.findOne((p) => p.objectId === s.objectId && p.status === 'POSEE') : undefined;
      return {
        id: s.id, market: m.name, commune: m.commune, row: s.row, number: s.number, category: s.category, objectId: s.objectId ?? null, plateCode: plate?.code ?? null,
        current: this.currentTitle(s.id),
        titles: this.titles.find((t) => t.stallId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => this.titleView(t)),
      };
    });
  }

  /**
   * Statut d'un titre (heure serveur), règle 50 % / 1 % : GRIS en attente de paiement ; VERT (≥ 50 % restant),
   * AMBRE (1–50 %), ROUGE (< 1 %, encore valable) ; ECHU (validité échue).
   */
  titleView(t: StallTitle) {
    const o = this.ctx.assessment.obligations.get(t.obligationId);
    const paid = this.ctx.payments.byObligation(t.obligationId).filter((p) => CONFIRMED.includes(p.status) && p.confirmedAt).sort((a, b) => a.confirmedAt!.localeCompare(b.confirmedAt!))[0];
    const base = { id: t.id, period: t.period, days: TITLE_DAYS[t.period], obligationId: t.obligationId, amount: o?.amount ?? null, createdAt: t.createdAt };
    if (!paid) return { ...base, status: o?.status === 'ANNULEE' ? ('ANNULE' as const) : ('GRIS' as const), statusLabel: 'En attente de paiement', validFrom: null, validUntil: null, validity: null };
    const from = new Date(paid.confirmedAt!);
    const until = new Date(from.getTime() + TITLE_DAYS[t.period] * DAY_MS);
    const validity = validityView(from.toISOString(), until.toISOString(), this.now());
    const status = validity.band === 'EXPIRE' ? ('ECHU' as const) : validity.band === 'ROUGE' ? ('ROUGE' as const) : validity.band === 'AMBRE' ? ('AMBRE' as const) : ('VERT' as const);
    const label = { VERT: 'Valide', AMBRE: 'Valide — expire bientôt', ROUGE: 'Valide — expire très bientôt', ECHU: 'Échu' }[status];
    return { ...base, status, statusLabel: label, validFrom: from.toISOString(), validUntil: until.toISOString(), validity };
  }

  currentTitle(stallId: string): { status: 'VERT' | 'AMBRE' | 'ROUGE' | 'ECHU' | 'GRIS' | 'AUCUN'; statusLabel: string; validFrom?: string | null; validUntil: string | null; validity?: ValidityView | null } {
    const views = this.titles.find((t) => t.stallId === stallId).map((t) => this.titleView(t));
    const valid = views.filter((v) => v.status === 'VERT' || v.status === 'AMBRE' || v.status === 'ROUGE').sort((a, b) => (b.validUntil ?? '').localeCompare(a.validUntil ?? ''))[0];
    if (valid) return { status: valid.status as 'VERT' | 'AMBRE' | 'ROUGE', statusLabel: valid.statusLabel, validFrom: valid.validFrom, validUntil: valid.validUntil, validity: valid.validity };
    const expired = views.filter((v) => v.status === 'ECHU').sort((a, b) => (b.validUntil ?? '').localeCompare(a.validUntil ?? ''))[0];
    if (expired) return { status: 'ECHU', statusLabel: 'Échu', validFrom: expired.validFrom, validUntil: expired.validUntil, validity: expired.validity };
    if (views.some((v) => v.status === 'GRIS')) return { status: 'GRIS', statusLabel: 'En attente de paiement', validUntil: null };
    return { status: 'AUCUN', statusLabel: 'Aucun titre', validUntil: null };
  }

  /**
   * Titre d'étal demandé par le commerçant : obligation liquidée sur la règle ACTIVE du registre (circuit commun), puis
   * paiement par /v1/obligations/:id/payment-orders. Le titre ne devient valide qu'à la confirmation signée du prestataire.
   */
  requestStallTitle(user: User, stallId: string, period: TitlePeriod) {
    const stall = this.stalls.get(stallId);
    if (!stall) throw notFound('STALL_NOT_FOUND', `Étal inconnu : ${stallId}`);
    if (!stall.holderTaxpayerId || !stall.objectId) throw unprocessable('STALL_NOT_ASSIGNED', 'Étal non attribué.');
    authorize(user, P.marketTitle, { taxpayerId: stall.holderTaxpayerId });
    const pending = this.titles.find((t) => t.stallId === stallId).map((t) => this.titleView(t)).find((t) => t.status === 'GRIS');
    if (pending) throw conflict('TITLE_PENDING_PAYMENT', 'Un titre attend déjà son paiement pour cet étal.', { obligationId: pending.obligationId });
    const rule = this.activeRuleFor('marches');
    if (!rule) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.stall_title.refused', resourceType: 'stall', resourceId: stallId, outcome: 'DENIED', details: { reason: 'NO_ACTIVE_RULE' } });
      throw unprocessable('NO_ACTIVE_RULE', 'Aucune règle ACTIVE au registre pour le droit d’étal : aucun montant n’est exigible.');
    }
    const res = this.ctx.assessment.calculate(this.titleService, {
      ruleId: rule.id, taxpayerId: stall.holderTaxpayerId, objectId: stall.objectId, inputs: { jours: String(TITLE_DAYS[period]) }, simulate: false,
    });
    const title = this.titles.insert({
      id: this.ids.next('TIT-ETAL'), stallId, taxpayerId: stall.holderTaxpayerId, period, obligationId: res.obligation!.id, requestedBy: user.id, createdAt: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.stall_title.requested', resourceType: 'stall', resourceId: stallId, details: { period, obligationId: title.obligationId, liquidatedBy: this.titleService.id } });
    return { title: this.titleView(title), obligation: this.obligationView(res.obligation!), paymentPath: `/v1/obligations/${res.obligation!.id}/payment-orders` };
  }

  // ------------------------------------------------------------------ événements : billetterie, liquidation, contrôle

  declareTicketing(user: User, eventObjectId: string, input: { ticketsSold: number; source: TicketingDeclaration['source']; fileSha256?: string }) {
    const o = this.ctx.objects.get(eventObjectId);
    if (o.attributes.objectType !== 'EVENEMENT') throw unprocessable('NOT_AN_EVENT', 'Cet objet n’est pas un événement autorisé.');
    authorize(user, P.eventTicketing, { taxpayerId: o.taxpayerId });
    const existing = this.ticketing.findOne((t) => t.eventObjectId === eventObjectId);
    if (existing?.obligationId) throw conflict('TICKETING_ALREADY_LIQUIDATED', 'La billetterie a déjà été liquidée ; toute correction passe par une réclamation.');
    const at = this.now().toISOString();
    const decl: TicketingDeclaration = {
      id: existing?.id ?? this.ids.next('BIL'), eventObjectId, taxpayerId: o.taxpayerId!, ticketsSold: input.ticketsSold, source: input.source,
      ...(input.fileSha256 ? { fileSha256: input.fileSha256 } : {}), declaredBy: user.id, declaredAt: at, controls: existing?.controls ?? [],
    };
    const saved = existing ? this.ticketing.update(decl) : this.ticketing.insert(decl);
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.event.ticketing_declared', resourceType: 'fiscal_object', resourceId: eventObjectId, details: { ticketsSold: input.ticketsSold, source: input.source, replaces: existing ? true : false } });
    this.ctx.comms.publish('declaration.submitted', this.recipientsOfTaxpayer(o.taxpayerId!), { reference: saved.id }, { entity: 'DGTK' });
    return saved;
  }

  /** Contrôle de jauge par échantillonnage : constat d'écart, jamais de sanction automatique. */
  controlEvent(user: User, eventObjectId: string, observedAttendance: number) {
    const o = this.ctx.objects.get(eventObjectId);
    authorize(user, P.eventControl, { entity: 'DGTK', communes: [o.commune] });
    const decl = this.ticketing.findOne((t) => t.eventObjectId === eventObjectId);
    if (!decl) throw unprocessable('NO_TICKETING_DECLARATION', 'Aucune déclaration de billetterie à rapprocher.');
    const gap = observedAttendance - decl.ticketsSold;
    const note = gap > 0
      ? 'Écart constaté : fréquentation observée supérieure à la billetterie déclarée. Proposition : réexamen contradictoire avec l’organisateur (aucune sanction automatique).'
      : 'Aucun écart défavorable constaté.';
    const saved = this.ticketing.update({ ...decl, controls: [...decl.controls, { observedAttendance, by: user.id, at: this.now().toISOString(), gap, note }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.event.controlled', resourceType: 'fiscal_object', resourceId: eventObjectId, details: { observedAttendance, declared: decl.ticketsSold, gap } });
    return saved;
  }

  // ------------------------------------------------------------------ liquidation par un agent (règle ACTIVE seulement)

  liquidateObject(user: User, slug: string, objectId: string, explicitInputs: Record<string, string> = {}) {
    const v = this.vertical(slug);
    const o = this.ctx.objects.get(objectId);
    if (this.verticalOf(o) !== v.slug) throw unprocessable('OBJECT_WRONG_VERTICAL', `L’objet ${o.id} ne relève pas de ${v.name}.`);
    authorize(user, P.objectLiquidate, { entity: v.entity, communes: [o.commune] });
    if (!o.taxpayerId) throw unprocessable('OBJECT_WITHOUT_TAXPAYER', 'Objet sans redevable rattaché : aucune obligation possible.');
    if (NO_LEVY_STATUSES.includes(v.legal)) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.liquidation.refused', resourceType: 'fiscal_object', resourceId: objectId, outcome: 'DENIED', details: { vertical: v.slug, reason: v.legal } });
      throw unprocessable('ACTE_REQUIS', `${v.name} : ${LEGAL_LABEL[v.legal]}. Aucune obligation ne peut être émise.`);
    }
    const code = VX_DEMO_RULES[v.slug];
    const latest = code ? this.ruleByCode(code) : undefined;
    if (!latest) throw unprocessable('NO_RULE', `Aucune règle au registre pour ${v.name} : aucun montant n’est exigible.`);
    const rule = this.activeRuleFor(v.slug) ?? latest; // une règle non ACTIVE est refusée (et journalisée) par le moteur de liquidation
    const year = String(this.now().getUTCFullYear());
    const dup = this.ctx.assessment.obligations.findOne((ob) => ob.objectId === objectId && ob.ruleCode === rule.code && ob.status !== 'ANNULEE' && ob.createdAt.startsWith(year));
    if (dup) throw conflict('DOUBLE_BILLING', `Une obligation existe déjà pour ce fait générateur (${dup.id}) : aucune double facturation.`, { obligationId: dup.id });
    let inputs = explicitInputs;
    if (v.slug === 'evenements' && !Object.keys(inputs).length) {
      const decl = this.ticketing.findOne((t) => t.eventObjectId === objectId);
      if (!decl) throw unprocessable('NO_TICKETING_DECLARATION', 'Liquidation impossible sans déclaration de billetterie.');
      inputs = { billets_vendus: String(decl.ticketsSold) };
    }
    if (v.slug === 'construction' && !Object.keys(inputs).length) {
      const a = o.attributes;
      inputs = { emprise_voie_m2: String(a.emprise_voie_m2 ?? '0'), duree_mois: String(a.dureeMois ?? '1') };
    }
    const res = this.ctx.assessment.calculate(user, { ruleId: rule.id, taxpayerId: o.taxpayerId, objectId, inputs, simulate: false });
    if (v.slug === 'evenements') {
      const decl = this.ticketing.findOne((t) => t.eventObjectId === objectId);
      if (decl) this.ticketing.update({ ...decl, obligationId: res.obligation!.id });
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'vertical.object.liquidated', resourceType: 'fiscal_object', resourceId: objectId, details: { vertical: v.slug, obligationId: res.obligation!.id, demoRule: rule.demo === true } });
    return this.obligationView(res.obligation!);
  }

  // ------------------------------------------------------------------ télécom : rapprochement contradictoire

  telecomReconciliation(user: User) {
    authorize(user, P.telecomReconcile, { entity: 'DGTK' });
    const sites = this.ctx.objects.objects.find((o) => o.attributes.objectType === 'SITE_TELECOM');
    const declared = sites.filter((s) => s.probativeStatus === 'DECLARE');
    const observed = sites.filter((s) => s.probativeStatus === 'OBSERVE');
    const near = (a: FiscalObject, b: FiscalObject) => Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0005; // ≈ 50 m
    const observedNotDeclared = observed.filter((ob) => !declared.some((d) => near(d, ob) || (d.attributes.reference && d.attributes.reference === ob.attributes.reference)));
    const declaredNotObserved = declared.filter((d) => !observed.some((ob) => near(d, ob) || (d.attributes.reference && d.attributes.reference === ob.attributes.reference)));
    const view = (o: FiscalObject) => ({ objectId: o.id, reference: typeof o.attributes.reference === 'string' ? o.attributes.reference : null, commune: o.commune, quartier: o.quartier, operator: o.taxpayerId ?? null });
    return {
      declared: declared.length, observed: observed.length, matched: observed.length - observedNotDeclared.length,
      observedNotDeclared: observedNotDeclared.map((o) => ({ ...view(o), proposal: 'Vérification contradictoire avec l’opérateur — aucune taxation automatique' })),
      declaredNotObserved: declaredNotObserved.map((o) => ({ ...view(o), proposal: 'Relevé terrain à programmer' })),
      generatedAt: this.now().toISOString(),
    };
  }

  // ------------------------------------------------------------------ indicateurs agrégés (sans nominatif)

  indicators() {
    const cases = this.cases.all();
    const byVertical = VERTICALS.map((v) => {
      const cs = cases.filter((c) => c.vertical === v.slug);
      const objs = this.ctx.objects.objects.find((o) => this.verticalOf(o) === v.slug);
      return {
        slug: v.slug, objects: objs.length, cases: cs.length,
        open: cs.filter((c) => !['ACCEPTE', 'REFUSE'].includes(c.status)).length,
        accepted: cs.filter((c) => c.status === 'ACCEPTE').length, refused: cs.filter((c) => c.status === 'REFUSE').length,
      };
    });
    const plan = this.marketPlan();
    const stalls = plan.reduce((n, m) => n + m.stalls.length, 0);
    const occupied = plan.reduce((n, m) => n + m.occupied, 0);
    const paid = plan.reduce((n, m) => n + m.paidOccupied, 0);
    return {
      generatedAt: this.now().toISOString(), byVertical,
      markets: { stalls, occupied, paidOccupied: paid, paidOccupancyRate: occupied ? `${Math.round((paid * 1000) / occupied) / 10}` : '0' },
      events: { authorized: this.certificates.find((c) => c.kind === 'AUTORISATION_EVENEMENT').length, ticketingDeclared: this.ticketing.count() },
      plates: this.platesIndicators(),
      certificates: this.certificates.count(),
    };
  }

  /** Montant d'exemple lisible (jamais utilisé pour un calcul). */
  static money(m: MoneyJSON): string {
    return Money.fromJSON(m).toDecimalString();
  }
}
