/**
 * MOSOLO AVIA — cadre juridique et valeurs du dossier source (Cahier v2.9, § 11C.1, 11C.4, 11C.5, 11C.6).
 *
 * 1. Mesures proposées par le dossier source (§ 11C.4) : « billet sans IFA KIN-AVIA = non validable au départ »,
 *    pénalités électroniques, suspension d'accès au départ, retrait d'agrément. Conservées comme mesures PARAMÉTRÉES,
 *    ouvertes SEULEMENT quand : (a) l'arrêté provincial est enregistré (référence de l'acte, empreinte du texte,
 *    double validation par deux personnes distinctes) ; (b) la liste de coordination est complète (RVA, DGM,
 *    autorité de l'aviation civile, compagnies). Même alors, chaque mesure est PROPOSÉE sur des faits constatés par le
 *    pôle de rapprochement puis DÉCIDÉE au cas par cas par l'autorité compétente : le système constate et calcule,
 *    il ne sanctionne pas seul (§ 21, Annexe B point 23 ; ARB-12). Aucun paramètre n'est inventé : les valeurs
 *    (pénalité par billet, délai d'intégration) sont celles saisies depuis l'arrêté, sinon « non fixé ».
 * 2. Clé de rémunération spécifique (§ 11C.6) : 65 % Ville / 35 % Groupe Nseya sur les montants effectivement
 *    récupérés — conservée comme clé ALTERNATIVE, statut ACTE_REQUIS, simulation seulement ; le modèle retenu pour
 *    l'ensemble de MOSOLO reste la clé du § 37A (module de rémunération construit séparément) ; ARB-07 inchangé.
 * 3. Chiffres du § 11C.1 et scénario prudent du § 11C.5 : données du dossier source [À VÉRIFIER], affichées telles
 *    quelles, jamais recalculées ni présentées comme des faits constatés.
 */
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { centsToUsd, usdToCents, type AviaRrhService } from './avia-rrh.js';
import { P } from './policies.js';

// ------------------------------------------------------------------------------------------------ données source

export const AVIA_SOURCE_FIGURES = {
  tag: '[À VÉRIFIER]',
  notice: 'Données du dossier source affichées telles quelles : ni calculées, ni vérifiées par MOSOLO. Les faits constatés sont ceux du pôle de rapprochement.',
  constat: {
    origin: 'Dossier source — Cahier v2.9, § 11C.1 (constat chiffré, à vérifier)',
    rows: [
      { label: 'Passagers au départ', value: '≈ 420 000 par an' },
      { label: 'Taxe moyenne', value: '≈ 5 USD par passager' },
      { label: 'Potentiel théorique annuel (hors fret)', value: '≈ 2,1 M USD' },
      { label: 'Recettes constatées historiquement', value: '≈ 0,4 à 0,5 M USD par an' },
      { label: 'Collecte 2017 – mi-2019', value: '1,409 M USD, pour des projections annuelles d’environ 3 M USD' },
      { label: 'Fret aérien', value: '≈ 0 USD déclaré' },
    ],
  },
  scenarioPrudent: {
    origin: 'Dossier source — Cahier v2.9, § 11C.5 (scénario prudent, à vérifier)',
    rows: [
      { label: 'Taux de récupération du potentiel', value: '85 %' },
      { label: 'Recettes annuelles visées', value: '≈ 1,8 M USD par an' },
      { label: 'Gain structurel net', value: '≈ + 1,3 M USD par an, hors fret (le potentiel du fret s’ajoute)' },
    ],
    principles: ['Aucune nouvelle taxe', 'Aucun coût supplémentaire pour le voyageur', 'Aucune interférence avec Go-Pass', 'Alignement sur les standards IATA'],
  },
} as const;

// ------------------------------------------------------------------------------------------------ mesures

export type AviaMeasureCode = 'BILLET_SANS_IFA_NON_VALIDABLE' | 'PENALITE_ELECTRONIQUE' | 'SUSPENSION_ACCES_DEPART' | 'RETRAIT_AGREMENT';
export const AVIA_MEASURES: { code: AviaMeasureCode; label: string; computation: string }[] = [
  { code: 'BILLET_SANS_IFA_NON_VALIDABLE', label: 'Billet sans IFA KIN-AVIA non validable au départ', computation: 'Nombre de passagers embarqués sans IFA rapproché (constat RRH).' },
  { code: 'PENALITE_ELECTRONIQUE', label: 'Pénalité électronique', computation: 'Passagers sans IFA × pénalité par billet fixée par l’arrêté (aucune valeur par défaut).' },
  { code: 'SUSPENSION_ACCES_DEPART', label: 'Suspension d’accès au départ', computation: 'Mois constatés sans billetterie transmise (non-intégration) ; aucune suspension exécutée par le système.' },
  { code: 'RETRAIT_AGREMENT', label: 'Retrait d’agrément', computation: 'Mois constatés sans billetterie transmise ; décision et exécution par l’autorité compétente.' },
];

export type AviaCoordinationPartner = 'RVA' | 'DGM' | 'AAC' | 'COMPAGNIES';
export const AVIA_COORDINATION: { partner: AviaCoordinationPartner; label: string }[] = [
  { partner: 'RVA', label: 'Régie des Voies Aériennes (RVA) — scans d’embarquement et accès aux infrastructures' },
  { partner: 'DGM', label: 'Direction Générale de Migration (DGM) — validations de sortie' },
  { partner: 'AAC', label: 'Autorité de l’aviation civile — autorisations d’exploitation et agréments' },
  { partner: 'COMPAGNIES', label: 'Compagnies aériennes — intégration de l’IFA et des flux de billetterie' },
];

export interface AviaLegalAct {
  id: string;
  reference: string;
  title: string;
  signedOn: string;
  documentSha256: string;
  measuresEnabled: AviaMeasureCode[];
  /** Paramètres recopiés de l'arrêté ; null = non fixé par l'acte (aucune valeur inventée). */
  parameters: { penaltyPerTicketUsd: string | null; integrationDelayDays: number | null };
  status: 'EN_ATTENTE_VALIDATION' | 'ENREGISTRE' | 'REJETE' | 'REMPLACE';
  recordedBy: string;
  recordedAt: string;
  validation?: { by: string; at: string; approve: boolean; reason: string };
}

export interface AviaCoordinationEntry { partner: AviaCoordinationPartner; confirmedBy: string; confirmedAt: string; reference: string; note?: string }

export interface AviaMeasureCase {
  id: string;
  measure: AviaMeasureCode;
  airlineTaxpayerId: string;
  period: string;
  actId: string;
  actReference: string;
  facts: { reconciliationId: string; boardedWithoutIfa: number; monthsWithoutTicketing: number; ticketingConnected: boolean };
  computation: { penaltyPerTicketUsd: string | null; amountUsd: string | null; note: string };
  status: 'PROPOSEE' | 'RETENUE' | 'ECARTEE';
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; authority: string; reason: string };
}

// ------------------------------------------------------------------------------------------------ clé alternative

export const AVIA_ALTERNATIVE_KEY = {
  code: 'AVIA-CLE-ALTERNATIVE-65-35',
  label: 'Clé alternative spécifique AVIA — 65 % Ville / 35 % Groupe Nseya (dossier source, § 11C.6)',
  villePercent: 65,
  groupePercent: 35,
  base: 'Montants effectivement récupérés (reversements de rattrapage crédités à la Ville après constat d’écart)',
  status: 'ACTE_REQUIS' as const,
  statusLabel: 'Acte requis — décision et acte distincts nécessaires (Annexe B, point 24 ; ARB-07) ; simulation seulement',
  reference: 'Modèle retenu pour l’ensemble de MOSOLO : clé du § 37A (module de rémunération, construit séparément)',
};

// ------------------------------------------------------------------------------------------------ service

export class AviaCadreService {
  readonly acts = new InMemoryRepository<AviaLegalAct>();
  readonly coordination = new InMemoryRepository<AviaCoordinationEntry & { id: string }>();
  readonly measures = new InMemoryRepository<AviaMeasureCase>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly rrh: AviaRrhService) {
    rrh.measureStatus = () => {
      const s = this.availability();
      return { available: s.available && !!s.act?.measuresEnabled.includes('BILLET_SANS_IFA_NON_VALIDABLE'), reason: s.reasons.join(' ') || 'Mesure non retenue par l’arrêté.' };
    };
  }

  private now() {
    return this.ctx.clock.now().toISOString();
  }

  activeAct(): AviaLegalAct | undefined {
    return this.acts.findOne((a) => a.status === 'ENREGISTRE');
  }

  availability() {
    const act = this.activeAct();
    const missing = AVIA_COORDINATION.filter((c) => !this.coordination.get(c.partner)).map((c) => c.partner);
    const reasons: string[] = [];
    if (!act) reasons.push('Arrêté provincial non enregistré (référence de l’acte et double validation requises).');
    if (missing.length) reasons.push(`Coordination non confirmée : ${missing.join(', ')}.`);
    return { available: reasons.length === 0, act: act ?? null, missing, reasons };
  }

  /** Enregistrement de l'arrêté provincial : référence, date de signature, empreinte du texte, mesures et paramètres. */
  recordAct(user: User, input: { reference: string; title: string; signedOn: string; documentSha256: string; measuresEnabled: AviaMeasureCode[]; parameters: { penaltyPerTicketUsd: string | null; integrationDelayDays: number | null } }) {
    authorize(user, P.aviaActRecord, { entity: 'DGTK' });
    if (input.parameters.penaltyPerTicketUsd !== null) usdToCents(input.parameters.penaltyPerTicketUsd);
    if (this.acts.findOne((a) => a.status === 'EN_ATTENTE_VALIDATION')) throw conflict('ACT_PENDING', 'Un arrêté attend déjà sa seconde validation.');
    const a = this.acts.insert({ ...input, id: this.ids.next('AVIA-ACTE'), status: 'EN_ATTENTE_VALIDATION', recordedBy: user.id, recordedAt: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.act.recorded', resourceType: 'avia_legal_act', resourceId: a.id, details: { reference: a.reference, measures: a.measuresEnabled } });
    return a;
  }

  /** Seconde validation par une personne distincte de celle qui a enregistré l'acte. */
  validateAct(user: User, id: string, input: { approve: boolean; reason: string }) {
    const a = this.acts.get(id);
    if (!a) throw notFound('ACT_NOT_FOUND', `Acte inconnu : ${id}`);
    authorize(user, P.aviaActValidate, { entity: 'DGTK' });
    if (a.status !== 'EN_ATTENTE_VALIDATION') throw conflict('ACT_NOT_PENDING', 'Acte déjà traité.');
    assertDistinctPerson(user.id, [a.recordedBy], 'La seconde validation est faite par une personne distincte de celle qui a enregistré l’acte.');
    if (input.approve) {
      const prev = this.activeAct();
      if (prev) this.acts.update({ ...prev, status: 'REMPLACE' });
    }
    const saved = this.acts.update({ ...a, status: input.approve ? 'ENREGISTRE' : 'REJETE', validation: { by: user.id, at: this.now(), approve: input.approve, reason: input.reason } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.act.validated', resourceType: 'avia_legal_act', resourceId: id, details: { approve: input.approve, reason: input.reason } });
    return saved;
  }

  /** Confirmation d'un partenaire de la liste de coordination (référence du protocole ou du procès-verbal). */
  confirmCoordination(user: User, partner: AviaCoordinationPartner, input: { reference: string; note?: string }) {
    authorize(user, P.aviaActRecord, { entity: 'DGTK' });
    if (!AVIA_COORDINATION.some((c) => c.partner === partner)) throw notFound('PARTNER_NOT_FOUND', `Partenaire inconnu : ${partner}`);
    const entry = { id: partner, partner, confirmedBy: user.id, confirmedAt: this.now(), reference: input.reference, ...(input.note ? { note: input.note } : {}) };
    const saved = this.coordination.get(partner) ? this.coordination.update(entry) : this.coordination.insert(entry);
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.coordination.confirmed', resourceType: 'avia_coordination', resourceId: partner, details: { reference: input.reference } });
    return saved;
  }

  /** Proposition d'une mesure sur les faits du pôle de rapprochement : le système calcule, il ne décide pas. */
  proposeMeasure(user: User, input: { measure: AviaMeasureCode; airlineTaxpayerId: string; period: string }) {
    authorize(user, P.aviaMeasurePropose, { entity: 'DGTK' });
    const s = this.availability();
    if (!s.available || !s.act) throw unprocessable('ACTE_REQUIS', `Mesure indisponible. ${s.reasons.join(' ')}`);
    if (!s.act.measuresEnabled.includes(input.measure)) throw unprocessable('MEASURE_NOT_IN_ACT', 'Mesure non prévue par l’arrêté enregistré.');
    const rec = this.rrh.latest(input.period);
    const line = rec?.lines.find((l) => l.airlineTaxpayerId === input.airlineTaxpayerId);
    if (!rec || !line) throw unprocessable('RRH_NOT_RUN', 'Aucun rapprochement mensuel pour cette compagnie et ce mois.');
    const monthsWithoutTicketing = [...new Set(this.rrh.reconciliations.all().map((r) => r.period))]
      .map((p) => this.rrh.latest(p)!.lines.find((l) => l.airlineTaxpayerId === input.airlineTaxpayerId))
      .filter((l) => l && !l.ticketingConnected && l.boarded > 0).length;
    const per = s.act.parameters.penaltyPerTicketUsd;
    const computation = input.measure === 'PENALITE_ELECTRONIQUE'
      ? per === null
        ? { penaltyPerTicketUsd: null, amountUsd: null, note: 'Pénalité par billet non fixée par l’arrêté : aucun montant calculé.' }
        : { penaltyPerTicketUsd: per, amountUsd: centsToUsd(usdToCents(per) * BigInt(line.boardedWithoutIfa)), note: `${line.boardedWithoutIfa} passager(s) sans IFA × ${per} USD (arrêté ${s.act.reference}).` }
      : input.measure === 'BILLET_SANS_IFA_NON_VALIDABLE'
        ? { penaltyPerTicketUsd: null, amountUsd: null, note: `${line.boardedWithoutIfa} passager(s) embarqué(s) sans IFA constaté(s).` }
        : { penaltyPerTicketUsd: null, amountUsd: null, note: `${monthsWithoutTicketing} mois constaté(s) sans billetterie transmise${s.act.parameters.integrationDelayDays !== null ? ` ; délai d’intégration de l’arrêté : ${s.act.parameters.integrationDelayDays} jours` : ''}.` };
    const m = this.measures.insert({
      id: this.ids.next('AVIA-MES'), measure: input.measure, airlineTaxpayerId: input.airlineTaxpayerId, period: input.period, actId: s.act.id, actReference: s.act.reference,
      facts: { reconciliationId: rec.id, boardedWithoutIfa: line.boardedWithoutIfa, monthsWithoutTicketing, ticketingConnected: line.ticketingConnected },
      computation, status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.measure.proposed', resourceType: 'avia_measure', resourceId: m.id, details: { measure: m.measure, airline: m.airlineTaxpayerId, amountUsd: computation.amountUsd } });
    return m;
  }

  /** Décision au cas par cas par l'autorité compétente, distincte du proposant, motivée. Aucune exécution automatique. */
  decideMeasure(user: User, id: string, input: { decision: 'RETENUE' | 'ECARTEE'; authority: string; reason: string }) {
    const m = this.measures.get(id);
    if (!m) throw notFound('MEASURE_NOT_FOUND', `Mesure inconnue : ${id}`);
    authorize(user, P.aviaMeasureDecide, { entity: 'DGTK' });
    if (m.status !== 'PROPOSEE') throw conflict('MEASURE_ALREADY_DECIDED', 'Mesure déjà décidée.');
    assertDistinctPerson(user.id, [m.proposedBy], 'La mesure est décidée par une autorité distincte de la personne qui l’a proposée.');
    const saved = this.measures.update({ ...m, status: input.decision, decision: { by: user.id, at: this.now(), authority: input.authority, reason: input.reason } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.measure.decided', resourceType: 'avia_measure', resourceId: id, details: { decision: input.decision, authority: input.authority } });
    return saved;
  }

  /** Simulation de la clé alternative 65/35 (ACTE_REQUIS) : sur un montant saisi ou les rattrapages crédités. */
  simulateAlternativeKey(user: User, input: { period?: string; amount?: string }) {
    authorize(user, P.aviaRead, { entity: 'DGTK' });
    const base = input.amount !== undefined
      ? usdToCents(input.amount)
      : this.rrh.remittances.find((r) => r.source === 'BANQUE_COLLECTRICE' && r.nature === 'RATTRAPAGE' && (!input.period || r.period === input.period)).reduce((s, r) => s + usdToCents(r.amount.amount), 0n);
    // Arrondi au centime demi vers le haut pour la part Ville ; la part du groupe est le complément exact.
    const ville = (base * BigInt(AVIA_ALTERNATIVE_KEY.villePercent) * 2n + 100n) / 200n;
    return {
      key: AVIA_ALTERNATIVE_KEY, simulation: true, opposable: false, period: input.period ?? null,
      baseSource: input.amount !== undefined ? 'Montant saisi pour la simulation' : 'Rattrapages crédités par les banques collectrices (constatés par le RRH)',
      baseUsd: centsToUsd(base), villeUsd: centsToUsd(ville), groupeUsd: centsToUsd(base - ville),
      notice: 'Simulation non opposable : la clé alternative exige une décision et un acte distincts ; la clé du § 37A reste le modèle retenu.',
    };
  }

  view(user: User) {
    authorize(user, P.aviaRead, { entity: 'DGTK' });
    const s = this.availability();
    return {
      availability: s,
      acts: this.acts.all().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
      coordination: AVIA_COORDINATION.map((c) => ({ ...c, entry: this.coordination.get(c.partner) ?? null })),
      measuresCatalogue: AVIA_MEASURES,
      measures: this.measures.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      alternativeKey: AVIA_ALTERNATIVE_KEY,
      sourceFigures: AVIA_SOURCE_FIGURES,
      notice: 'Le système constate et calcule ; il ne sanctionne pas seul. Chaque mesure est décidée au cas par cas par l’autorité compétente, après arrêté et coordination (RVA, DGM, aviation civile, compagnies).',
    };
  }
}
