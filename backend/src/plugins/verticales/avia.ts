/**
 * MOSOLO AVIA (KIN-AVIA FISCUS, modules 62 et 78) — préparation derrière « acte requis » (J23, D21).
 * Parcours : déclaration mensuelle des mouvements par la compagnie → données de l'exploitant (RVA, DGM) →
 * rapprochement par un analyste → procédure contradictoire en cas d'écart → validation motivée par une autre personne →
 * facturation SEULEMENT sur demande humaine et sur règle ACTIVE. Jamais de facturation automatique, jamais de sanction
 * (« billet sans IFA non validable », suspension, retrait d'agrément : non paramétrables avant arrêté — ARB-12).
 * Répartition 65/35 de la source : non retenue (ARB-07). Aucune interférence avec Go-Pass.
 *
 * Harmonisation avec le Cahier v2.9, chapitre 11C (27/09/2026) — ajouts PAR-DESSUS ce circuit, rien n'est retiré :
 *  - Pôle de rapprochement des recettes (Revenue Reconciliation Hub, RRH, `avia-rrh.ts`) : trois flux (billetterie
 *    IATA BSP/GDS/TTBS par connecteur, API des compagnies structurées dont DCS, portail des agences certifiées ;
 *    embarquements RVA ; sorties DGM), plus les reversements BSP et les relevés des banques collectrices, et le fret.
 *    Le rapprochement mensuel ALIMENTE ce circuit : il n'ouvre la procédure contradictoire que par le `reconcile`
 *    ci-dessous (ou un constat sur un mois non déclaré), à l'initiative d'un analyste. Facturation ou compensation
 *    des écarts : PROPOSÉES, décidées par une personne distincte (`requestBilling` sur règle ACTIVE, `decideCompensation`).
 *  - Identifiant fiscal aérien (IFA) : un par vol et par passager, signé Ed25519 comme les titres (QR hors ligne).
 *  - « Billet sans IFA non validable », pénalités, suspension, retrait d'agrément (ARB-12 maintenu) : mesures
 *    paramétrées (`avia-cadre.ts`) ouvertes SEULEMENT après enregistrement de l'arrêté provincial (référence + double
 *    validation) et liste de coordination complète (RVA, DGM, aviation civile, compagnies) ; chaque mesure est décidée
 *    au cas par cas par l'autorité compétente : le système constate et calcule, il ne sanctionne pas.
 *  - Clé 65 % Ville / 35 % Groupe Nseya (§ 11C.6) : conservée comme clé ALTERNATIVE, statut ACTE_REQUIS, simulation
 *    seulement, à côté de la clé du § 37A (ARB-07 inchangé : elle exige une décision et un acte distincts).
 *  - Chiffres du § 11C.1 et scénario prudent du § 11C.5 : affichés comme données source [À VÉRIFIER], jamais calculés.
 *
 * Décision du maître d'ouvrage (27/09/2026, « Exécution automatique après acte ») — ajoutée PAR-DESSUS ce circuit :
 * UNE FOIS l'arrêté enregistré (`avia-cadre.ts`), la facturation ou la compensation des écarts mensuels est exécutée
 * automatiquement par `avia-auto.ts` (planificateur mensuel, idempotent, audité, procédure contradictoire maintenue
 * après l'avis). Avant l'arrêté, ce circuit reste inchangé : proposition, décision et facturation humaines ci-dessous.
 */
import { isRuleExecutable } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { assertDistinctPerson, authorize, evaluate } from '../../core/policy.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { P } from './policies.js';

export type AviaStatus = 'DECLAREE' | 'RAPPROCHEE' | 'ECART_CONSTATE' | 'OBSERVATIONS_RECUES' | 'VALIDEE' | 'FACTUREE' | 'COMPENSEE';
export const AVIA_STATUS_LABEL: Record<AviaStatus, string> = {
  DECLAREE: 'Déclarée', RAPPROCHEE: 'Rapprochée sans écart', ECART_CONSTATE: 'Écart constaté — procédure contradictoire ouverte',
  OBSERVATIONS_RECUES: 'Observations de la compagnie reçues', VALIDEE: 'Validée — facturation possible sur décision', FACTUREE: 'Avis émis sur règle active',
  COMPENSEE: 'Compensation décidée par une personne habilitée — exécution sur acte',
};

export interface AviaFigures { flights: number; passengersDeparting: number; freightKg: number }

export interface AviaOperatorData {
  id: string;
  period: string;
  airlineTaxpayerId: string;
  source: 'RVA' | 'DGM' | 'EXPLOITANT';
  flights: number;
  passengersBoarded: number;
  passengersExited?: number;
  freightKg: number;
  fileSha256?: string;
  submittedBy: string;
  submittedAt: string;
}

/** Chiffres du pôle de rapprochement (RRH) repris dans un rapprochement (voir avia-rrh.ts). */
export interface AviaRrhFigures {
  reconciliationId: string;
  flights: number;
  sold: number;
  boarded: number;
  boardedWithoutIfa: number;
  exited: number;
  /** Taxe urbaine portée par les billets des passagers embarqués (donnée billetterie), en USD. */
  taxOnBoarded: string;
  remitted: string;
  remittanceGap: string;
  freightDeclaredKg: number;
  freightManifestKg: number;
  hasGap: boolean;
  gapLabels: string[];
}

export interface AviaDeclaration {
  id: string;
  /** Origine : déclaration de la compagnie (défaut) ou constat du RRH sur un mois non déclaré (chiffres déclarés à zéro). */
  origin?: 'COMPAGNIE' | 'CONSTAT_RRH';
  taxpayerId: string;
  period: string;
  aircraftObjectIds: string[];
  declared: AviaFigures;
  declaredBy: string;
  declaredAt: string;
  status: AviaStatus;
  reconciliation?: {
    at: string;
    by: string;
    operatorDataIds: string[];
    observed: { flights: number; passengersBoarded: number; passengersExited: number | null; freightKg: number };
    gaps: { flights: number; passengers: number; passengersExited: number | null; freightKg: number };
    /** Écart relatif de passagers, en pour cent (chaîne décimale). */
    passengerGapRate: string;
    /** Flux du pôle de rapprochement (billetterie, embarquements, sorties, reversements, fret), s'il a été exécuté. */
    rrh?: AviaRrhFigures;
  };
  contradictory?: { openedAt: string; deadline: string; observations: { at: string; by: string; text: string; documents: string[] }[] };
  validation?: { by: string; at: string; reason: string };
  billing: { at: string; by: string; outcome: 'REFUSEE' | 'EMISE'; reason: string; obligationId?: string }[];
  /** Décisions humaines de compensation ou de classement d'un écart (jamais automatiques). */
  gapDecisions?: { at: string; by: string; outcome: 'COMPENSATION' | 'CLASSEMENT'; reason: string; proposalRef?: string }[];
}

/** Délai de la procédure contradictoire (démonstration) [À VÉRIFIER : délai fixé par l'arrêté]. */
export const CONTRADICTORY_DAYS = 15;
export const AVIA_RULE_CODE = 'AVIA-TAXE-PASSAGER';

export class AviaService {
  readonly declarations = new InMemoryRepository<AviaDeclaration>();
  readonly operatorData = new InMemoryRepository<AviaOperatorData>();
  private readonly ids = new IdGenerator();
  /** Branchement du pôle de rapprochement (RRH) : chiffres du dernier rapprochement mensuel d'une compagnie. */
  rrhLookup?: (airlineTaxpayerId: string, period: string) => AviaRrhFigures | undefined;

  constructor(private readonly ctx: AppContext) {}

  private get(id: string): AviaDeclaration {
    const d = this.declarations.get(id);
    if (!d) throw notFound('AVIA_DECLARATION_NOT_FOUND', `Déclaration inconnue : ${id}`);
    return d;
  }

  private resource(d: { taxpayerId: string }) {
    return { taxpayerId: d.taxpayerId, entity: 'DGTK' };
  }

  declare(user: User, input: { taxpayerId?: string; period: string; aircraftObjectIds: string[]; flights: number; passengersDeparting: number; freightKg: number }) {
    const taxpayerId = input.taxpayerId ?? user.taxpayerId;
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Compagnie concernée requise.');
    this.ctx.taxpayers.get(taxpayerId);
    authorize(user, P.aviaDeclare, { taxpayerId });
    if (input.period >= kinshasaDate(this.ctx.clock.now()).slice(0, 7)) throw unprocessable('PERIOD_NOT_CLOSED', 'Seul un mois échu peut être déclaré.');
    for (const id of input.aircraftObjectIds) {
      const o = this.ctx.objects.get(id);
      if (o.taxpayerId !== taxpayerId || o.attributes.objectType !== 'AERONEF') throw unprocessable('AIRCRAFT_NOT_OWNED', `Aéronef non rattaché à la compagnie : ${id}`);
    }
    if (this.declarations.findOne((d) => d.taxpayerId === taxpayerId && d.period === input.period)) {
      throw conflict('AVIA_PERIOD_ALREADY_DECLARED', `Le mois ${input.period} est déjà déclaré ; toute correction passe par les observations.`);
    }
    const d = this.declarations.insert({
      id: this.ids.next(`AVIA-DEC-${input.period}`), taxpayerId, period: input.period, aircraftObjectIds: input.aircraftObjectIds,
      declared: { flights: input.flights, passengersDeparting: input.passengersDeparting, freightKg: input.freightKg },
      declaredBy: user.id, declaredAt: this.ctx.clock.now().toISOString(), status: 'DECLAREE', billing: [],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.declaration.submitted', resourceType: 'avia_declaration', resourceId: d.id, details: { period: d.period, ...d.declared } });
    this.ctx.comms.publish('declaration.submitted', [taxpayerRecipient(this.ctx.taxpayers.get(taxpayerId))], { reference: d.id }, { entity: 'DGTK' });
    return this.view(d);
  }

  /** Données de l'exploitant (RVA : embarqués ; DGM : sorties validées) — partenaire de données sous protocole. */
  submitOperatorData(user: User, input: Omit<AviaOperatorData, 'id' | 'submittedBy' | 'submittedAt'>) {
    authorize(user, P.aviaOperatorData, {});
    this.ctx.taxpayers.get(input.airlineTaxpayerId);
    if (this.operatorData.findOne((o) => o.period === input.period && o.airlineTaxpayerId === input.airlineTaxpayerId && o.source === input.source)) {
      throw conflict('OPERATOR_DATA_ALREADY_SUBMITTED', `Données ${input.source} déjà transmises pour ${input.period}.`);
    }
    const rec = this.operatorData.insert({ ...input, id: this.ids.next('AVIA-OPD'), submittedBy: user.id, submittedAt: this.ctx.clock.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.operator_data.received', resourceType: 'avia_operator_data', resourceId: rec.id, details: { period: rec.period, source: rec.source, airline: rec.airlineTaxpayerId } });
    return rec;
  }

  /** Rapprochement : déclaré ↔ embarqués (RVA) ↔ sortis (DGM). Constate un écart ; ne facture rien. */
  reconcile(user: User, id: string) {
    const d = this.get(id);
    authorize(user, P.aviaReconcile, this.resource(d));
    if (d.status !== 'DECLAREE') throw conflict('INVALID_AVIA_STATE', `Rapprochement impossible au statut ${AVIA_STATUS_LABEL[d.status]}.`);
    const data = this.operatorData.find((o) => o.period === d.period && o.airlineTaxpayerId === d.taxpayerId);
    const boarding = data.find((o) => o.source === 'RVA' || o.source === 'EXPLOITANT');
    const rrh = this.rrhLookup?.(d.taxpayerId, d.period);
    if (!boarding && !rrh) throw unprocessable('OPERATOR_DATA_MISSING', 'Données d’embarquement de l’exploitant absentes : rapprochement impossible.');
    const exits = data.find((o) => o.source === 'DGM');
    // Priorité aux agrégats transmis par l'exploitant (circuit d'origine) ; à défaut, flux passager par passager du RRH.
    const observed = boarding
      ? {
          flights: boarding.flights, passengersBoarded: boarding.passengersBoarded,
          passengersExited: exits?.passengersExited ?? boarding.passengersExited ?? (rrh ? rrh.exited : null), freightKg: boarding.freightKg,
        }
      : { flights: rrh!.flights, passengersBoarded: rrh!.boarded, passengersExited: exits?.passengersExited ?? rrh!.exited, freightKg: rrh!.freightManifestKg };
    const gaps = {
      flights: observed.flights - d.declared.flights,
      passengers: observed.passengersBoarded - d.declared.passengersDeparting,
      passengersExited: observed.passengersExited === null ? null : observed.passengersExited - d.declared.passengersDeparting,
      freightKg: observed.freightKg - d.declared.freightKg,
    };
    // Écart relatif en pour mille puis formaté (entiers : aucun flottant pour une valeur publiée).
    const base = Math.max(1, observed.passengersBoarded);
    const permille = Math.round((Math.abs(gaps.passengers) * 1000) / base);
    const passengerGapRate = `${Math.floor(permille / 10)}.${permille % 10}`;
    const now = this.ctx.clock.now();
    const hasGap = gaps.flights !== 0 || gaps.passengers !== 0 || gaps.freightKg !== 0 || (gaps.passengersExited !== null && gaps.passengersExited !== 0) || !!rrh?.hasGap;
    const next: AviaDeclaration = {
      ...d,
      status: hasGap ? 'ECART_CONSTATE' : 'RAPPROCHEE',
      reconciliation: { at: now.toISOString(), by: user.id, operatorDataIds: data.map((x) => x.id), observed, gaps, passengerGapRate, ...(rrh ? { rrh } : {}) },
      ...(hasGap ? { contradictory: { openedAt: now.toISOString(), deadline: kinshasaDate(new Date(now.getTime() + CONTRADICTORY_DAYS * DAY_MS)), observations: [] } } : {}),
    };
    const saved = this.declarations.update(next);
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.declaration.reconciled', resourceType: 'avia_declaration', resourceId: id, details: { gaps, passengerGapRate, contradictory: hasGap, ...(rrh ? { rrhReconciliationId: rrh.reconciliationId } : {}) } });
    if (hasGap) {
      this.ctx.comms.publish('appeal.info_requested', [taxpayerRecipient(this.ctx.taxpayers.get(d.taxpayerId))], { reference: id }, { entity: 'DGTK' });
    }
    return this.view(saved);
  }

  /** Observations de la compagnie (procédure contradictoire). */
  observe(user: User, id: string, input: { text: string; documents: string[] }) {
    const d = this.get(id);
    authorize(user, P.aviaDeclare, { taxpayerId: d.taxpayerId });
    if (!d.contradictory || !['ECART_CONSTATE', 'OBSERVATIONS_RECUES'].includes(d.status)) throw conflict('NO_CONTRADICTORY_PROCEDURE', 'Aucune procédure contradictoire ouverte.');
    const saved = this.declarations.update({
      ...d, status: 'OBSERVATIONS_RECUES',
      contradictory: { ...d.contradictory, observations: [...d.contradictory.observations, { at: this.ctx.clock.now().toISOString(), by: user.id, text: input.text, documents: input.documents }] },
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.declaration.observations', resourceType: 'avia_declaration', resourceId: id, details: { documents: input.documents.length } });
    return this.view(saved);
  }

  /** Validation motivée par une personne distincte de l'analyste, après la procédure contradictoire. */
  validate(user: User, id: string, reason: string) {
    const d = this.get(id);
    authorize(user, P.aviaValidate, this.resource(d));
    if (!['RAPPROCHEE', 'ECART_CONSTATE', 'OBSERVATIONS_RECUES'].includes(d.status)) throw conflict('INVALID_AVIA_STATE', `Validation impossible au statut ${AVIA_STATUS_LABEL[d.status]}.`);
    if (d.status === 'ECART_CONSTATE' && d.contradictory && kinshasaDate(this.ctx.clock.now()) <= d.contradictory.deadline) {
      throw conflict('CONTRADICTORY_PROCEDURE_OPEN', `Procédure contradictoire en cours jusqu’au ${d.contradictory.deadline} : la compagnie doit pouvoir répondre.`);
    }
    assertDistinctPerson(user.id, [d.reconciliation?.by ?? ''], 'La validation doit être faite par une personne distincte de l’analyste qui a rapproché.');
    const saved = this.declarations.update({ ...d, status: 'VALIDEE', validation: { by: user.id, at: this.ctx.clock.now().toISOString(), reason } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.declaration.validated', resourceType: 'avia_declaration', resourceId: id, details: { reason } });
    return this.view(saved);
  }

  /**
   * Facturation : uniquement sur demande d'une personne habilitée, après validation, et seulement si une règle ACTIVE
   * existe au registre (arrêté J23). Sans règle : refus tracé « acte requis » — aucun montant.
   */
  requestBilling(user: User, id: string) {
    const d = this.get(id);
    authorize(user, P.aviaBill, this.resource(d));
    if (d.status !== 'VALIDEE') throw conflict('AVIA_NOT_VALIDATED', 'Aucune facturation avant validation de la déclaration.');
    const now = this.ctx.clock.now();
    const rule = this.ctx.rules.list().filter((r) => r.code === AVIA_RULE_CODE && isRuleExecutable(r, now).ok).sort((a, b) => b.version - a.version)[0];
    if (!rule) {
      const reason = 'ACTE REQUIS (J23, D21) : aucune règle ACTIVE au registre pour les taxes aériennes provinciales.';
      this.declarations.update({ ...d, billing: [...d.billing, { at: now.toISOString(), by: user.id, outcome: 'REFUSEE', reason }] });
      this.ctx.audit.append({ actor: actorOf(user), action: 'avia.billing.refused', resourceType: 'avia_declaration', resourceId: id, outcome: 'DENIED', details: { reason: 'ACTE_REQUIS' } });
      throw unprocessable('ACTE_REQUIS', reason);
    }
    const aircraft = d.aircraftObjectIds[0];
    if (!aircraft) throw unprocessable('AIRCRAFT_REQUIRED', 'La déclaration doit citer au moins un aéronef (objet du fait générateur).');
    // Assiette : passagers embarqués constatés par l'exploitant (la Ville calcule), jamais la seule déclaration.
    const passengers = String(d.reconciliation?.observed.passengersBoarded ?? d.declared.passengersDeparting);
    const res = this.ctx.assessment.calculate(user, { ruleId: rule.id, taxpayerId: d.taxpayerId, objectId: aircraft, inputs: { passagers: passengers }, simulate: false });
    const saved = this.declarations.update({ ...d, status: 'FACTUREE', billing: [...d.billing, { at: now.toISOString(), by: user.id, outcome: 'EMISE', reason: `Règle ${rule.code} v${rule.version}`, obligationId: res.obligation!.id }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.billing.issued', resourceType: 'avia_declaration', resourceId: id, details: { obligationId: res.obligation!.id } });
    return this.view(saved);
  }

  /**
   * Constat du RRH sur un mois NON déclaré par la compagnie : la Ville ne dépend plus des déclarations (§ 11C) mais
   * ne déclare pas à la place de la compagnie — le dossier porte des chiffres déclarés à zéro, marqué « constat RRH »,
   * puis suit le MÊME rapprochement et la MÊME procédure contradictoire (la compagnie répond par ses observations).
   */
  openRrhFinding(user: User, airlineTaxpayerId: string, period: string) {
    authorize(user, P.aviaReconcile, { taxpayerId: airlineTaxpayerId, entity: 'DGTK' });
    this.ctx.taxpayers.get(airlineTaxpayerId);
    if (this.declarations.findOne((d) => d.taxpayerId === airlineTaxpayerId && d.period === period)) {
      throw conflict('AVIA_PERIOD_ALREADY_DECLARED', `Le mois ${period} a déjà un dossier pour cette compagnie.`);
    }
    if (!this.rrhLookup?.(airlineTaxpayerId, period)) throw unprocessable('RRH_NOT_RUN', 'Aucun rapprochement mensuel du RRH pour cette compagnie et ce mois.');
    const d = this.declarations.insert({
      id: this.ids.next(`AVIA-DEC-${period}`), origin: 'CONSTAT_RRH', taxpayerId: airlineTaxpayerId, period, aircraftObjectIds: [],
      declared: { flights: 0, passengersDeparting: 0, freightKg: 0 },
      declaredBy: user.id, declaredAt: this.ctx.clock.now().toISOString(), status: 'DECLAREE', billing: [],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.declaration.rrh_finding', resourceType: 'avia_declaration', resourceId: d.id, details: { period, airline: airlineTaxpayerId } });
    return this.reconcile(user, d.id);
  }

  /**
   * Nouvel écart révélé par le RRH sur un mois déjà « rapproché sans écart » : l'analyste rouvre le MÊME circuit
   * (retour au statut « déclarée » puis rapprochement), tracé. Aucune réouverture après validation ou décision.
   */
  reopenForRrh(user: User, id: string) {
    const d = this.get(id);
    authorize(user, P.aviaReconcile, this.resource(d));
    if (d.status !== 'RAPPROCHEE') throw conflict('INVALID_AVIA_STATE', `Réouverture impossible au statut ${AVIA_STATUS_LABEL[d.status]}.`);
    this.declarations.update({ ...d, status: 'DECLAREE' });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.declaration.reopened_rrh', resourceType: 'avia_declaration', resourceId: id, details: { previous: d.reconciliation?.at ?? null } });
    return this.reconcile(user, id);
  }

  /**
   * Compensation (ou classement) d'un écart validé : PROPOSÉE par le RRH, DÉCIDÉE par une personne habilitée distincte
   * de l'analyste, motivée. Aucun mouvement de fonds : l'exécution comptable suit l'acte et une règle ACTIVE.
   */
  decideCompensation(user: User, id: string, input: { outcome: 'COMPENSATION' | 'CLASSEMENT'; reason: string; proposalRef?: string }) {
    const d = this.get(id);
    authorize(user, P.aviaValidate, this.resource(d));
    if (d.status !== 'VALIDEE') throw conflict('AVIA_NOT_VALIDATED', 'Aucune décision sur l’écart avant validation de la déclaration.');
    assertDistinctPerson(user.id, [d.reconciliation?.by ?? ''], 'La décision doit être prise par une personne distincte de l’analyste qui a rapproché.');
    const entry = { at: this.ctx.clock.now().toISOString(), by: user.id, outcome: input.outcome, reason: input.reason, ...(input.proposalRef ? { proposalRef: input.proposalRef } : {}) };
    const saved = this.declarations.update({ ...d, status: input.outcome === 'COMPENSATION' ? 'COMPENSEE' : d.status, gapDecisions: [...(d.gapDecisions ?? []), entry] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.gap.decided', resourceType: 'avia_declaration', resourceId: id, details: { outcome: input.outcome, reason: input.reason } });
    return this.view(saved);
  }

  view(d: AviaDeclaration) {
    return { ...d, statusLabel: AVIA_STATUS_LABEL[d.status] };
  }

  list(user: User, taxpayerId?: string) {
    return this.declarations
      .find((d) => !taxpayerId || d.taxpayerId === taxpayerId)
      .filter((d) => evaluate(user, P.aviaRead, this.resource(d)))
      .map((d) => this.view(d))
      .sort((a, b) => b.period.localeCompare(a.period));
  }

  read(user: User, id: string) {
    const d = this.get(id);
    authorize(user, P.aviaRead, this.resource(d));
    return this.view(d);
  }

  /** Indicateurs agrégés : passagers tracés, écart de passagers (aucun montant : taux non fixé par acte). */
  overview(user: User) {
    authorize(user, P.aviaRead, { entity: 'DGTK' });
    const periods = [...new Set(this.declarations.all().map((d) => d.period))].sort().reverse();
    return {
      notice: 'Aucun montant : les taxes aériennes provinciales restent « acte requis » (J23). Écart de reversement monétaire calculable seulement après arrêté.',
      periods: periods.map((p) => {
        const ds = this.declarations.find((d) => d.period === p);
        const declared = ds.reduce((n, d) => n + d.declared.passengersDeparting, 0);
        const boarded = ds.reduce((n, d) => n + (d.reconciliation?.observed.passengersBoarded ?? 0), 0);
        return { period: p, declarations: ds.length, passengersDeclared: declared, passengersBoarded: boarded, withGap: ds.filter((d) => d.contradictory).length, validated: ds.filter((d) => d.status === 'VALIDEE' || d.status === 'FACTUREE' || d.status === 'COMPENSEE').length };
      }),
    };
  }
}
