/**
 * Catalogue des indicateurs (§ 39, annexe H § H.19, questions de décision § 26.1) : chaque indicateur porte sa
 * définition, sa formule, sa source, sa valeur calculée sur les données réelles, sa cible et sa tendance.
 * Un indicateur sans mesure possible est déclaré « non mesuré » — jamais une valeur inventée.
 */
import { DAY_MS, kinshasaDay } from '../../core/clock.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import type { Facts } from './facts.js';
import {
  isConfirmed, isDue, isReconciled, isSettled, matchesChannel, matchesDims, type Filters,
} from './ladder.js';
import { CurrencyTotals, hoursOf, mean, median, pct } from './money.js';


/** Canaux numériques (paiement dématérialisé de bout en bout). Le guichet bancaire et le point agréé sont « assistés ». */
export const DIGITAL_CHANNELS = ['MOBILE_MONEY', 'CARD', 'USSD', 'QR', 'TRANSFER'];
export const ASSISTED_CHANNELS = ['USSD', 'AGENT_POINT', 'BANK'];

/** Données du socle hors échelle, déjà filtrées au périmètre. */
export interface KpiInputs {
  facts: Facts;
  filters: Filters;
  objects: { commune: string; category: string; status: string; id: string; createdAt: string }[];
  leases: { unitObjectId: string; createdAt: string; end?: string }[];
  rules: { status: string; sourceVerification: string; demo?: boolean }[];
  exceptions: { type: string; openedAt: string; computed?: boolean }[];
  comms: { attempted: number; delivered: number; sandboxLogged: number };
  alerts: { severity: string; at: string }[];
  ai: { status: string; createdAt?: string }[];
  /** Compléments (§ 39, § 8.6, § 2) : lus dans les modules chargés ; absents ⇒ indicateur « non mesuré ». */
  extra?: KpiExtra;
}

/**
 * Données complémentaires des indicateurs § 39 / § 8.6 / équation du § 2. Chaque champ est facultatif : un champ absent
 * signifie « source non disponible » et l'indicateur correspondant reste « non mesuré » (jamais une valeur inventée).
 */
export interface KpiExtra {
  /** Objets du périmètre : contribuable rattaché vérifié (N2 ou N3) et géolocalisation valide. */
  objectsQuality?: { id: string; verifiedTaxpayer: boolean; geolocated: boolean }[];
  /** Avis notifiés (recouvrement) : obligation et date d'émission. */
  notices?: { obligationId: string; issuedAt: string }[];
  /** Arbitrages entre entités (§ 10A.3). */
  arbitrations?: { openedAt: string; decidedAt?: string }[];
  /** RANV (§ 38.2) : calculée seulement sur une base de référence CERTIFIÉE. */
  ranv?: { certified: boolean; value: string | null; detail: string };
  /** Coûts certifiés de la période (contre-valeur CDF indicative, unités mineures) et recettes correspondantes. */
  costs?: { collectionCdfMinor: bigint | null; recoveryCdfMinor: bigint | null; reconciledCdfMinor: bigint; recoveredArrearsCdfMinor: bigint; period: string };
  satisfaction?: { count: number; sumTenths: number };
  availability?: { probes: number; ok: number };
  sla?: { definitions: number; onTime: number; late: number };
  instructions?: { onTime: number; late: number; open: number };
  targets?: { year: string; realisedCdfMinor: bigint; targetCdfMinor: bigint };
}

export type KpiStatus = 'ATTEINTE' | 'NON_ATTEINTE' | 'SANS_CIBLE' | 'NON_MESURE' | 'NON_CALCULABLE';

export interface KpiValue {
  value: string | null;
  numerator?: number;
  denominator?: number;
  detail?: string;
}

export interface KpiDefinition {
  code: string;
  domain: string;
  label: string;
  question?: string;
  definition: string;
  formula: string;
  source: string;
  unit: '%' | 'h' | 's' | 'j' | 'nombre';
  /** Cible chiffrée (comparable) ou null. */
  target: { op: '>=' | '<=' | '<' | '>' | '='; value: string } | null;
  targetLabel: string;
  /** Sens favorable. */
  better: 'HAUSSE' | 'BAISSE' | 'NEUTRE';
  reference: string;
  measurable: boolean;
  /** Mesure structurelle : garantie par construction plutôt qu'observée. */
  structural?: boolean;
  /** Mesurabilité conditionnelle : l'indicateur n'est mesuré que si la source existe (sinon « non mesuré »). */
  measurableWhen?: (i: KpiInputs) => boolean;
  compute?: (i: KpiInputs) => KpiValue;
}

const scopedObligations = (i: KpiInputs) => i.facts.obligations.filter((o) => matchesDims(o, i.filters));
const scopedOrders = (i: KpiInputs) => i.facts.orders.filter((o) => matchesDims(o, i.filters) && matchesChannel(o, i.filters));
const ratio = (n: number, d: number, detail?: string): KpiValue => ({ value: pct(n, d), numerator: n, denominator: d, ...(detail ? { detail } : {}) });
const ms = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();
/** Ratio en pour cent sur montants BigInt (unités mineures), une décimale, arrondi au plus proche ; signe conservé. */
export function pctBig(num: bigint, den: bigint): string | null {
  if (den <= 0n) return null;
  const neg = num < 0n;
  const n = (neg ? -num : num) * 1000n;
  const q = (n * 2n + den) / (2n * den);
  return `${neg && q > 0n ? '-' : ''}${q / 10n}.${q % 10n}`;
}
const cdfOf = (minor: bigint) => `${minor / 100n}`;
/** Obligations réglées après leur échéance (arriérés régularisés), au périmètre. */
const recoveredArrears = (i: KpiInputs) => scopedObligations(i).filter((o) => o.paidAt && !o.cancelled && o.paidAt.slice(0, 10) > o.dueDate);

export const KPI_CATALOGUE: KpiDefinition[] = [
  {
    code: 'PAIEMENT_ECHEANCE', domain: 'Paiement', label: 'Taux de paiement à l’échéance',
    question: 'Les contribuables régularisent-ils sans coercition ?',
    definition: 'Part des obligations échues (non contestées, non annulées) ayant un paiement confirmé.',
    formula: 'Obligations échues avec paiement confirmé / obligations échues', source: 'Obligations × ordres de paiement',
    unit: '%', target: null, targetLabel: 'Base de référence + 15 points (§ 39)', better: 'HAUSSE', reference: '§ 39 Conversion', measurable: true,
    compute: (i) => {
      const due = scopedObligations(i).filter((o) => isDue(o, i.facts.asOf));
      return ratio(due.filter((o) => o.paidAt).length, due.length);
    },
  },
  {
    code: 'PAIEMENT_EMISES', domain: 'Paiement', label: 'Taux de paiement des obligations émises',
    definition: 'Part des obligations émises (non annulées) ayant un paiement confirmé, échues ou non.',
    formula: 'Obligations avec paiement confirmé / obligations émises', source: 'Obligations × ordres de paiement',
    unit: '%', target: null, targetLabel: 'À fixer après la base de référence', better: 'HAUSSE', reference: '§ 26.2 Obligations', measurable: true,
    compute: (i) => {
      const live = scopedObligations(i).filter((o) => !o.cancelled);
      return ratio(live.filter((o) => o.paidAt).length, live.length);
    },
  },
  {
    code: 'RAPPROCHEMENT_J1', domain: 'Rapprochement', label: 'Taux de rapprochement à J+1',
    question: 'L’argent est-il arrivé aux comptes publics ?',
    definition: 'Part des paiements confirmés rapprochés avec le relevé du compte public dans les 24 heures.',
    formula: 'Rapprochés en ≤ 24 h / confirmés depuis ≥ 24 h ou déjà rapprochés', source: 'Ordres de paiement, rapprochements du Trésor',
    unit: '%', target: { op: '>=', value: '95' }, targetLabel: '≥ 95 %', better: 'HAUSSE', reference: '§ 39 Rapprochement', measurable: true,
    compute: (i) => {
      const now = new Date(i.facts.asOf).getTime();
      const base = scopedOrders(i).filter((o) => isConfirmed(o) && (isReconciled(o) || now - new Date(o.confirmedAt!).getTime() >= DAY_MS));
      return ratio(base.filter((o) => isReconciled(o) && ms(o.confirmedAt!, o.reconciledAt!) <= DAY_MS).length, base.length);
    },
  },
  {
    code: 'ECART_RAPPROCHEMENT_J2', domain: 'Rapprochement', label: 'Écart de rapprochement à J+2',
    question: 'Quels paiements exigent une investigation ?',
    definition: 'Part des paiements confirmés depuis plus de 48 heures toujours sans appariement.',
    formula: 'Confirmés depuis > 48 h non rapprochés / confirmés depuis > 48 h', source: 'Ordres de paiement',
    unit: '%', target: { op: '<', value: '1' }, targetLabel: '< 1 % (annexe H § H.19)', better: 'BAISSE', reference: 'Annexe H § H.19', measurable: true,
    compute: (i) => {
      const now = new Date(i.facts.asOf).getTime();
      const old = scopedOrders(i).filter((o) => isConfirmed(o) && now - new Date(o.confirmedAt!).getTime() > 2 * DAY_MS);
      return ratio(old.filter((o) => !isReconciled(o)).length, old.length);
    },
  },
  {
    code: 'DELAI_REGLEMENT', domain: 'Règlement', label: 'Délai moyen confirmation → règlement',
    definition: 'Durée moyenne entre la confirmation prestataire et le crédit constaté sur le compte public.',
    formula: 'Moyenne (règlement − confirmation), en heures', source: 'Ordres de paiement réglés',
    unit: 'h', target: { op: '<=', value: '24' }, targetLabel: '≤ 1 jour ouvré (§ 39)', better: 'BAISSE', reference: '§ 39 Règlement', measurable: true,
    compute: (i) => {
      const d = scopedOrders(i).filter((o) => isSettled(o) && o.confirmedAt).map((o) => ms(o.confirmedAt!, o.settledAt!));
      const m = mean(d); const med = median(d);
      return { value: m === null ? null : hoursOf(m), denominator: d.length, ...(med !== null ? { detail: `Médiane ${hoursOf(med)} h sur ${d.length} paiement(s) réglé(s).` } : {}) };
    },
  },
  {
    code: 'DELAI_QUITTANCE', domain: 'Quittance', label: 'Délai confirmation → quittance provisoire',
    definition: 'Durée moyenne entre la confirmation signée du prestataire et l’émission de la quittance provisoire.',
    formula: 'Moyenne (émission quittance − confirmation), en secondes', source: 'Quittances, ordres de paiement',
    unit: 's', target: { op: '<', value: '60' }, targetLabel: '< 60 s (§ 39)', better: 'BAISSE', reference: '§ 39 Quittance', measurable: true,
    compute: (i) => {
      const d = scopedOrders(i).filter((o) => o.confirmedAt && o.receiptIssuedAt).map((o) => Math.max(0, ms(o.confirmedAt!, o.receiptIssuedAt!)));
      const m = mean(d);
      return { value: m === null ? null : String(Math.round(m / 1000)), denominator: d.length };
    },
  },
  {
    code: 'PART_NUMERIQUE', domain: 'Numérique', label: 'Part des paiements numériques',
    definition: 'Part, en nombre, des paiements confirmés par un canal numérique (monnaie mobile, carte, USSD, QR, virement).',
    formula: 'Paiements confirmés par canal numérique / paiements confirmés', source: 'Ordres de paiement (canal)',
    unit: '%', target: { op: '>=', value: '80' }, targetLabel: '≥ 80 % (§ 39)', better: 'HAUSSE', reference: '§ 39 Numérique', measurable: true,
    compute: (i) => {
      const c = scopedOrders(i).filter(isConfirmed);
      return ratio(c.filter((o) => DIGITAL_CHANNELS.includes(o.channel)).length, c.length);
    },
  },
  {
    code: 'PARCOURS_ASSISTES', domain: 'Inclusion', label: 'Part des parcours assistés',
    definition: 'Part des paiements confirmés passés par un canal assisté (USSD, point agréé, guichet bancaire).',
    formula: 'Paiements confirmés USSD + point agréé + banque / paiements confirmés', source: 'Ordres de paiement (canal)',
    unit: '%', target: null, targetLabel: 'Suivi par commune (§ 39 Inclusion)', better: 'NEUTRE', reference: '§ 39 Inclusion', measurable: true,
    compute: (i) => {
      const c = scopedOrders(i).filter(isConfirmed);
      return ratio(c.filter((o) => ASSISTED_CHANNELS.includes(o.channel)).length, c.length);
    },
  },
  {
    code: 'COMMUNES_RECETTE', domain: 'Territoire', label: 'Communes avec recette rapprochée',
    definition: 'Nombre de communes (sur 24) ayant au moins une recette rapprochée, selon la commune du fait générateur.',
    formula: 'Communes distinctes (hors non attribué) avec paiement rapproché / 24', source: 'Rapprochements × attribution (§ 20.3)',
    unit: 'nombre', target: null, targetLabel: '24 communes au passage à l’échelle', better: 'HAUSSE', reference: '§ 20.3, § 45', measurable: true,
    compute: (i) => {
      const set = new Set(scopedOrders(i).filter(isReconciled).map((o) => o.commune).filter((c) => (COMMUNES as readonly string[]).includes(c)));
      return { value: String(set.size), numerator: set.size, denominator: COMMUNES.length };
    },
  },
  {
    code: 'NON_ATTRIBUE', domain: 'Territoire', label: 'Part des paiements non attribués',
    definition: 'Part des paiements confirmés dont l’objet n’a pas de commune établie (jamais devinée).',
    formula: 'Paiements confirmés NON_ATTRIBUE / paiements confirmés', source: 'Ordres de paiement × attribution',
    unit: '%', target: { op: '=', value: '0' }, targetLabel: '0 %', better: 'BAISSE', reference: '§ 20.3', measurable: true,
    compute: (i) => {
      const c = scopedOrders(i).filter(isConfirmed);
      return ratio(c.filter((o) => o.commune === 'NON_ATTRIBUE').length, c.length);
    },
  },
  {
    code: 'EXCEPTIONS_OUVERTES', domain: 'Exceptions', label: 'Exceptions de rapprochement ouvertes',
    definition: 'Exceptions de rapprochement ouvertes, y compris règlements manquants à J+1 et attentes prestataire.',
    formula: 'Nombre d’exceptions au statut OUVERTE', source: 'Files d’exceptions du Trésor',
    unit: 'nombre', target: null, targetLabel: 'Suivi — revue quotidienne', better: 'BAISSE', reference: '§ 39 Exceptions', measurable: true,
    compute: (i) => ({ value: String(i.exceptions.length), numerator: i.exceptions.length }),
  },
  {
    code: 'EXCEPTIONS_ANCIENNES', domain: 'Exceptions', label: 'Exceptions de plus de 30 jours',
    definition: 'Exceptions ouvertes depuis plus de 30 jours.',
    formula: 'Nombre d’exceptions ouvertes dont l’âge dépasse 30 jours', source: 'Files d’exceptions du Trésor',
    unit: 'nombre', target: { op: '=', value: '0' }, targetLabel: '0 (§ 39)', better: 'BAISSE', reference: '§ 39 Exceptions', measurable: true,
    compute: (i) => {
      const now = new Date(i.facts.asOf).getTime();
      const n = i.exceptions.filter((e) => now - new Date(e.openedAt).getTime() > 30 * DAY_MS).length;
      return { value: String(n), numerator: n };
    },
  },
  {
    code: 'OBLIGATIONS_CONTESTEES', domain: 'Recours', label: 'Obligations contestées (indicateur séparé)',
    definition: 'Obligations sous réclamation non encore décidée — hors échelle de la recette.',
    formula: 'Nombre d’obligations sous réclamation ouverte', source: 'Réclamations × obligations',
    unit: 'nombre', target: null, targetLabel: 'Suivi', better: 'NEUTRE', reference: 'Échelle § 26.1 (indicateur séparé)', measurable: true,
    compute: (i) => {
      const n = scopedObligations(i).filter((o) => o.contested).length;
      return { value: String(n), numerator: n };
    },
  },
  {
    code: 'DELAI_RECOURS', domain: 'Recours', label: 'Délai médian dépôt → décision',
    definition: 'Médiane du délai entre le dépôt d’une réclamation et la décision motivée.',
    formula: 'Médiane (décision − dépôt), en jours', source: 'Réclamations',
    unit: 'j', target: null, targetLabel: 'Délai légal', better: 'BAISSE', reference: '§ 39 Recours', measurable: true,
    compute: (i) => {
      const scope = new Set(scopedObligations(i).map((o) => o.id));
      const d = i.facts.appeals.filter((a) => a.decidedAt && scope.has(a.obligationId)).map((a) => ms(a.submittedAt, a.decidedAt!));
      const m = median(d);
      return { value: m === null ? null : hoursOf(m / 24), denominator: d.length };
    },
  },
  {
    code: 'RECOURS_FONDES', domain: 'Recours', label: 'Taux de réclamations fondées',
    definition: 'Part des décisions favorables (totalement ou partiellement) au contribuable.',
    formula: 'Décisions ACCEPTEE ou PARTIELLEMENT_ACCEPTEE / décisions', source: 'Réclamations',
    unit: '%', target: { op: '<=', value: '20' }, targetLabel: 'Suivi — alerte au-delà de 20 % sur un motif', better: 'BAISSE', reference: '§ 39 Recours', measurable: true,
    compute: (i) => {
      const scope = new Set(scopedObligations(i).map((o) => o.id));
      const d = i.facts.appeals.filter((a) => a.decision && scope.has(a.obligationId));
      return ratio(d.filter((a) => a.decision !== 'REJETEE').length, d.length);
    },
  },
  {
    code: 'EXACTITUDE_LIQUIDATION', domain: 'Liquidation', label: 'Exactitude de la liquidation',
    definition: 'Part des obligations émises n’ayant pas fait l’objet d’une rectification fondée.',
    formula: 'Obligations sans rectification / obligations émises', source: 'Obligations (rectifications)',
    unit: '%', target: { op: '>=', value: '98' }, targetLabel: '≥ 98 % (§ 39)', better: 'HAUSSE', reference: '§ 39 Liquidation', measurable: true,
    compute: (i) => {
      const all = scopedObligations(i);
      return ratio(all.filter((o) => !o.rectified).length, all.length);
    },
  },
  {
    code: 'COUVERTURE_LOCATIVE', domain: 'Locatif', label: 'Couverture locative',
    definition: 'Part des unités locatives recensées ayant un bail enregistré.',
    formula: 'Unités locatives avec bail / unités locatives recensées', source: 'Objets fiscaux, baux',
    unit: '%', target: null, targetLabel: 'Suivi par avenue, quartier, commune', better: 'HAUSSE', reference: 'Annexe H § H.19 Locatif', measurable: true,
    compute: (i) => {
      const units = i.objects.filter((o) => o.category === 'UNITE_LOCATIVE');
      const leased = new Set(i.leases.map((l) => l.unitObjectId));
      return ratio(units.filter((u) => leased.has(u.id)).length, units.length, `${i.leases.length} bail(aux) enregistré(s).`);
    },
  },
  {
    code: 'VALIDATION_OBJETS', domain: 'Couverture', label: 'Objets validés',
    definition: 'Part des objets recensés passés au statut VALIDE (assiette vérifiée).',
    formula: 'Objets VALIDE / objets recensés', source: 'Registre des objets fiscaux',
    unit: '%', target: null, targetLabel: 'Suivi', better: 'HAUSSE', reference: 'Échelle niveau 2', measurable: true,
    compute: (i) => ratio(i.objects.filter((o) => o.status === 'VALIDE').length, i.objects.length),
  },
  {
    code: 'TAUX_RECENSEMENT', domain: 'Couverture', label: 'Taux de recensement',
    question: 'Quelles zones sont insuffisamment recensées ?',
    definition: 'Objets recensés rapportés aux objets estimés dans les quartiers.',
    formula: 'Objets recensés / objets estimés', source: 'Estimation du parc (modèle) — non disponible',
    unit: '%', target: { op: '>=', value: '90' }, targetLabel: '≥ 90 % quartiers pilotes (§ 39)', better: 'HAUSSE', reference: '§ 39 Couverture', measurable: false,
  },
  {
    code: 'REGLES_CERTIFIEES', domain: 'Légalité', label: 'Règles actives certifiées',
    definition: 'Part des règles actives adossées à une pièce officielle certifiée.',
    formula: 'Règles ACTIVE avec source OFFICIEL_CERTIFIE / règles ACTIVE', source: 'Registre juridique',
    unit: '%', target: { op: '>=', value: '100' }, targetLabel: '100 % (§ 39)', better: 'HAUSSE', reference: '§ 39 Légalité', measurable: true,
    compute: (i) => {
      const active = i.rules.filter((r) => r.status === 'ACTIVE');
      const demo = active.filter((r) => r.demo).length;
      return ratio(active.filter((r) => r.sourceVerification === 'OFFICIEL_CERTIFIE').length, active.length, demo ? `Dont ${demo} règle(s) FICTIVE(S) de démonstration.` : undefined);
    },
  },
  {
    code: 'DELIVRANCE_MESSAGES', domain: 'Communication', label: 'Délivrance des communications',
    definition: 'Part des messages délivrés parmi les messages tentés (bac à sable journalisé = non délivré).',
    formula: 'Messages délivrés / tentés', source: 'Journal des délivrances',
    unit: '%', target: { op: '>=', value: '95' }, targetLabel: '≥ 95 % (§ 39)', better: 'HAUSSE', reference: '§ 39 Communication', measurable: true,
    compute: (i) => ratio(i.comms.delivered, i.comms.attempted, `${i.comms.sandboxLogged} message(s) journalisé(s) en bac à sable.`),
  },
  {
    code: 'ALERTES_CRITIQUES', domain: 'Intégrité', label: 'Alertes critiques',
    question: 'Quelle déperdition évitée ou récupérée ?',
    definition: 'Alertes de sécurité ou de fraude de sévérité critique levées.',
    formula: 'Nombre d’alertes CRITICAL', source: 'Alertes de sécurité et de fraude',
    unit: 'nombre', target: { op: '=', value: '0' }, targetLabel: '0 au-delà du délai d’instruction', better: 'BAISSE', reference: 'Annexe H § H.19 Intégrité', measurable: true,
    compute: (i) => {
      const n = i.alerts.filter((a) => a.severity === 'CRITICAL').length;
      return { value: String(n), numerator: n, detail: `${i.alerts.length} alerte(s) au total.` };
    },
  },
  {
    code: 'ACCEPTATION_IA', domain: 'IA', label: 'Acceptation des recommandations d’IA',
    definition: 'Part des recommandations acceptées parmi celles décidées par une personne habilitée.',
    formula: 'Recommandations ACCEPTEE / décidées', source: 'Recommandations de la couche d’intelligence',
    unit: '%', target: null, targetLabel: 'Suivi — alerte si < 30 % ou > 95 %', better: 'NEUTRE', reference: '§ 39 IA', measurable: true,
    compute: (i) => {
      const decided = i.ai.filter((r) => r.status !== 'EMISE');
      return ratio(decided.filter((r) => r.status === 'ACCEPTEE').length, decided.length);
    },
  },
  {
    code: 'ESPECES_AGENTS', domain: 'Intégrité', label: 'Manipulations d’espèces par les agents',
    definition: 'Aucune fonction d’encaissement n’existe pour les agents de terrain, contrôleurs et sous-traitants.',
    formula: 'Nombre de fonctions d’encaissement ouvertes aux agents', source: 'Matrice d’habilitations (§ 12.4)',
    unit: 'nombre', target: { op: '=', value: '0' }, targetLabel: '0 toléré', better: 'BAISSE', reference: '§ 39 Intégrité', measurable: true, structural: true,
    compute: () => ({ value: '0', numerator: 0, detail: 'Garantie par construction : aucun rôle agent ne détient l’action de paiement.' }),
  },
  {
    code: 'COUT_COLLECTE', domain: 'Coût', label: 'Coût de collecte',
    question: 'Combien coûte chaque franc net mobilisé ?',
    definition: 'Coût total de collecte rapporté aux recettes rapprochées.',
    formula: 'Coût total / recettes rapprochées', source: 'Comptabilité analytique — non intégrée',
    unit: '%', target: null, targetLabel: 'En baisse', better: 'BAISSE', reference: '§ 39 Coût', measurable: false,
    // Mesuré dès qu'un relevé de coûts CERTIFIÉ (deux personnes) couvre la période : coût / recettes rapprochées (contre-valeur CDF indicative).
    measurableWhen: (i) => i.extra?.costs?.collectionCdfMinor != null || i.extra?.costs?.recoveryCdfMinor != null,
    compute: (i) => {
      const c = i.extra!.costs!;
      const cost = (c.collectionCdfMinor ?? 0n) + (c.recoveryCdfMinor ?? 0n);
      return { value: pctBig(cost, c.reconciledCdfMinor), detail: `Relevé de coûts certifié ${c.period} : ${cdfOf(cost)} CDF pour ${cdfOf(c.reconciledCdfMinor)} CDF rapprochés (contre-valeur indicative).` };
    },
  },
  {
    code: 'RANV', domain: 'Résultat', label: 'Recette additionnelle nette vérifiée (RANV)',
    definition: 'Recette additionnelle nette par rapport à une base de référence auditée (§ 38.2).',
    formula: '§ 38.2', source: 'Base de référence auditée — non disponible',
    unit: '%', target: null, targetLabel: 'Positive et certifiée', better: 'HAUSSE', reference: '§ 39 Résultat', measurable: false,
    // Mesurée UNIQUEMENT sur une base de référence certifiée (§ 38.1) : RANV rapportée aux encaissements de la base (même durée).
    measurableWhen: (i) => i.extra?.ranv?.certified === true,
    compute: (i) => ({ value: i.extra!.ranv!.value, detail: i.extra!.ranv!.detail }),
  },
  {
    code: 'SATISFACTION', domain: 'Service', label: 'Satisfaction après paiement',
    definition: 'Note moyenne de l’enquête post-paiement.',
    formula: 'Moyenne des notes (sur 5)', source: 'Enquête post-paiement — non déployée',
    unit: 'nombre', target: { op: '>=', value: '4' }, targetLabel: '≥ 4/5', better: 'HAUSSE', reference: '§ 39 Service', measurable: false,
    // Mesurée dès que des réponses (facultatives) à l'enquête après paiement ou après visite existent.
    measurableWhen: (i) => (i.extra?.satisfaction?.count ?? 0) > 0,
    compute: (i) => {
      const s = i.extra!.satisfaction!;
      const tenths = Math.round(s.sumTenths / s.count);
      return { value: `${Math.floor(tenths / 10)}.${tenths % 10}`, denominator: s.count, detail: `${s.count} réponse(s) facultative(s), agrégées sans nom.` };
    },
  },
  // ——— Indicateurs complémentaires (§ 39, leviers du § 8.6, équation de croissance du § 2) ———
  {
    code: 'TAUX_RATTACHEMENT', domain: 'Identité', label: 'Taux de rattachement (identification)',
    question: 'Les objets sont-ils rattachés à la bonne personne ?',
    definition: 'Part des objets recensés rattachés à un contribuable vérifié (niveau N2 ou N3).',
    formula: 'Objets avec contribuable vérifié / objets recensés', source: 'Registre des objets × identités (niveau de vérification)',
    unit: '%', target: null, targetLabel: 'Fixée après la base de référence (§ 39)', better: 'HAUSSE', reference: '§ 39 Identité ; § 8.6 levier 2 ; § 2', measurable: false,
    measurableWhen: (i) => i.extra?.objectsQuality !== undefined,
    compute: (i) => { const o = i.extra!.objectsQuality!; return ratio(o.filter((x) => x.verifiedTaxpayer).length, o.length); },
  },
  {
    code: 'COUVERTURE_SIG', domain: 'Couverture', label: 'Couverture géographique (SIG)',
    question: 'Quelles zones sont insuffisamment recensées ?',
    definition: 'Part des objets enregistrés portant une géolocalisation valide.',
    formula: 'Objets géolocalisés / objets enregistrés', source: 'Registre des objets fiscaux (coordonnées)',
    unit: '%', target: null, targetLabel: 'Fixée après la base de référence (§ 39)', better: 'HAUSSE', reference: '§ 39 Couverture GIS', measurable: false,
    measurableWhen: (i) => i.extra?.objectsQuality !== undefined,
    compute: (i) => { const o = i.extra!.objectsQuality!; return ratio(o.filter((x) => x.geolocated).length, o.length); },
  },
  {
    code: 'DEPOT_A_TEMPS', domain: 'Conformité', label: 'Dépôt à temps des déclarations',
    definition: 'Déclarations déposées dans le délai rapportées aux déclarations attendues.',
    formula: 'Déclarations à temps / déclarations attendues', source: 'Calendrier des déclarations attendues — non intégré',
    unit: '%', target: null, targetLabel: 'Fixée après la base de référence (§ 39)', better: 'HAUSSE', reference: '§ 39 Conformité ; § 8.6 levier 5 ; § 2', measurable: false,
  },
  {
    code: 'CONVERSION_AVIS_PAIEMENT', domain: 'Paiement', label: 'Conversion avis → paiement',
    question: 'Les contribuables régularisent-ils après notification ?',
    definition: 'Part des obligations ayant reçu un avis notifié (échéance dépassée, relance, avis formel, mise en demeure) payées après cet avis.',
    formula: 'Obligations notifiées payées après l’avis / obligations notifiées', source: 'Avis du recouvrement × paiements confirmés',
    unit: '%', target: null, targetLabel: '> 50 % dans le délai légal (§ 39) — délai légal à confirmer', better: 'HAUSSE', reference: '§ 39 ; § 8.6 levier 6', measurable: false,
    measurableWhen: (i) => i.extra?.notices !== undefined,
    compute: (i) => {
      const scope = new Map(scopedObligations(i).map((o) => [o.id, o]));
      const first = new Map<string, string>();
      for (const n of i.extra!.notices!) {
        if (!scope.has(n.obligationId) || n.issuedAt > i.facts.asOf) continue;
        const cur = first.get(n.obligationId);
        if (!cur || n.issuedAt < cur) first.set(n.obligationId, n.issuedAt);
      }
      const paid = [...first.entries()].filter(([id, at]) => { const p = scope.get(id)!.paidAt; return !!p && p >= at; }).length;
      return ratio(paid, first.size);
    },
  },
  {
    code: 'ARRIERES_RECOUVRES', domain: 'Recouvrement', label: 'Arriérés recouvrés',
    definition: 'Obligations payées après leur échéance (régularisation d’arriérés), en nombre ; montants bruts par devise en détail.',
    formula: 'Nombre d’obligations réglées après l’échéance ; montant brut (et net des coûts certifiés)', source: 'Obligations × paiements confirmés',
    unit: 'nombre', target: null, targetLabel: 'Suivi — brut et net des coûts (§ 39)', better: 'HAUSSE', reference: '§ 39 Arriérés recouvrés ; § 8.6 levier 8', measurable: true,
    compute: (i) => {
      const r = recoveredArrears(i);
      const t = new CurrencyTotals();
      r.forEach((o) => t.add(o.amount));
      const brut = t.toJSON().map((m) => `${m.amount} ${m.currency}`).join(' · ');
      return { value: String(r.length), numerator: r.length, ...(r.length ? { detail: `Montant brut : ${brut}.` } : {}) };
    },
  },
  {
    code: 'RENDEMENT_CONTROLE', domain: 'Contrôle', label: 'Rendement net du contrôle',
    question: 'Quels contrôles créent un gain mesurable ?',
    definition: 'Recettes récupérées (arriérés régularisés) diminuées du coût certifié du recouvrement, rapportées à ce coût.',
    formula: '(Recettes récupérées − coût) / coût', source: 'Arriérés régularisés × relevé de coûts certifié',
    unit: '%', target: null, targetLabel: 'Positif (§ 39)', better: 'HAUSSE', reference: '§ 39 Contrôle ; § 8.6 levier 8', measurable: false,
    measurableWhen: (i) => (i.extra?.costs?.recoveryCdfMinor ?? 0n) > 0n,
    compute: (i) => {
      const c = i.extra!.costs!;
      return { value: pctBig(c.recoveredArrearsCdfMinor - c.recoveryCdfMinor!, c.recoveryCdfMinor!), detail: `Récupéré ${cdfOf(c.recoveredArrearsCdfMinor)} CDF ; coût certifié ${cdfOf(c.recoveryCdfMinor!)} CDF (${c.period}, contre-valeur indicative).` };
    },
  },
  {
    code: 'DISPONIBILITE', domain: 'Exploitation', label: 'Disponibilité du service',
    definition: 'Part des sondes de disponibilité réussies (sondes externes enregistrées par l’exploitation).',
    formula: 'Sondes réussies / sondes enregistrées', source: 'Registre des sondes de disponibilité',
    unit: '%', target: null, targetLabel: 'Fixée par l’accord de service (§ 39)', better: 'HAUSSE', reference: '§ 39 Disponibilité et sécurité', measurable: false,
    measurableWhen: (i) => (i.extra?.availability?.probes ?? 0) > 0,
    compute: (i) => ratio(i.extra!.availability!.ok, i.extra!.availability!.probes),
  },
  {
    code: 'ARBITRAGES_OUVERTS', domain: 'Coexistence', label: 'Arbitrages entre entités ouverts',
    definition: 'Dossiers d’arbitrage entre entités non encore décidés ; délai médian de résolution en détail.',
    formula: 'Nombre d’arbitrages OUVERT ou INSTRUIT', source: 'Arbitrages du module d’accès (§ 10A.3)',
    unit: 'nombre', target: null, targetLabel: 'Suivi — délai de résolution', better: 'BAISSE', reference: '§ 39 Coexistence ; § 10A.3', measurable: false,
    measurableWhen: (i) => i.extra?.arbitrations !== undefined,
    compute: (i) => {
      const a = i.extra!.arbitrations!.filter((x) => x.openedAt <= i.facts.asOf);
      const open = a.filter((x) => !x.decidedAt || x.decidedAt > i.facts.asOf).length;
      const m = median(a.filter((x) => x.decidedAt && x.decidedAt <= i.facts.asOf).map((x) => ms(x.openedAt, x.decidedAt!)));
      return { value: String(open), numerator: open, denominator: a.length, ...(m !== null ? { detail: `Délai médian de résolution : ${hoursOf(m / 24)} j.` } : {}) };
    },
  },
  {
    code: 'ACCORDS_SERVICE', domain: 'Coexistence', label: 'Respect des accords de niveau de service entre entités',
    definition: 'Part des demandes inter-entités (instruction, reversement, vérification, réponse) traitées dans le délai de l’accord.',
    formula: 'Demandes closes dans le délai / (demandes closes + demandes ouvertes hors délai)', source: 'Registre des accords de service et suivi des demandes',
    unit: '%', target: null, targetLabel: 'Fixée par chaque accord (§ 10A.3)', better: 'HAUSSE', reference: '§ 39 ; § 10A.3', measurable: false,
    measurableWhen: (i) => (i.extra?.sla?.definitions ?? 0) > 0,
    compute: (i) => { const s = i.extra!.sla!; return ratio(s.onTime, s.onTime + s.late); },
  },
  {
    code: 'INSTRUCTIONS_DELAIS', domain: 'Pilotage', label: 'Instructions exécutées dans les délais',
    question: 'Les instructions du Gouverneur et du cabinet sont-elles suivies ?',
    definition: 'Part des instructions closes dans le délai fixé, rapportée aux instructions closes et aux instructions ouvertes hors délai.',
    formula: 'Instructions closes à temps / (closes + ouvertes hors délai)', source: 'Circuit des instructions (§ 26.1, § 26.2)',
    unit: '%', target: null, targetLabel: 'Suivi du cabinet', better: 'HAUSSE', reference: '§ 26.1 ; § 26.2', measurable: false,
    measurableWhen: (i) => { const s = i.extra?.instructions; return !!s && s.onTime + s.late + s.open > 0; },
    compute: (i) => { const s = i.extra!.instructions!; return ratio(s.onTime, s.onTime + s.late, `${s.open} instruction(s) ouverte(s).`); },
  },
  {
    code: 'ECART_ASSIGNATION', domain: 'Pilotage', label: 'Réalisation des assignations budgétaires',
    question: 'Quel écart entre la cible et le réalisé ?',
    definition: 'Recettes rapprochées de l’exercice rapportées aux assignations certifiées (commune × catégorie), en contre-valeur CDF indicative.',
    formula: 'Rapproché de l’exercice / assignation certifiée', source: 'Registre des assignations certifié × rapprochements',
    unit: '%', target: null, targetLabel: '100 % à la clôture de l’exercice', better: 'HAUSSE', reference: '§ 26.1 ; § 8.6 levier 12', measurable: false,
    measurableWhen: (i) => (i.extra?.targets?.targetCdfMinor ?? 0n) > 0n,
    compute: (i) => { const t = i.extra!.targets!; return { value: pctBig(t.realisedCdfMinor, t.targetCdfMinor), detail: `Exercice ${t.year} : ${cdfOf(t.realisedCdfMinor)} CDF rapprochés pour ${cdfOf(t.targetCdfMinor)} CDF assignés.` }; },
  },
  /* ── Tableau du § 40 (nouvelle numérotation ; ancien § 39) : « Cible à 18 mois ». Ajouts ; les indicateurs ci-dessus
     sont conservés. Écarts de cible signalés au maître d'ouvrage : PART_NUMERIQUE (≥ 80 %, en nombre) et
     TAUX_RECENSEMENT (≥ 90 % quartiers pilotes) restent affichés à côté des cibles du § 40. ── */
  {
    code: 'COUVERTURE_RECENSEMENT', domain: 'Couverture', label: 'Taux de couverture du recensement',
    question: 'Quelle part des objets estimés est enregistrée, par commune et catégorie ?',
    definition: 'Objets enregistrés rapportés aux objets estimés, par commune et catégorie.',
    formula: 'Objets enregistrés / objets estimés', source: 'Registre des objets × estimation du parc (modèle) — non disponible',
    unit: '%', target: { op: '>', value: '80' }, targetLabel: 'Communes pilotes : > 80 % (§ 40, cible à 18 mois)', better: 'HAUSSE', reference: '§ 40 Couverture', measurable: false,
  },
  {
    code: 'PART_ELECTRONIQUE_RECETTES', domain: 'Numérique', label: 'Part électronique des recettes',
    question: 'Quelle part des recettes encaissées passe par voie électronique ?',
    definition: 'Recettes encaissées (paiements confirmés) par voie électronique rapportées au total encaissé, en montant, par devise — jamais de mélange de devises.',
    formula: 'Montant confirmé par canal numérique / montant confirmé total (par devise)', source: 'Ordres de paiement (canal, montant)',
    unit: '%', target: { op: '>', value: '90' }, targetLabel: '> 90 % sur le périmètre couvert (§ 40, cible à 18 mois)', better: 'HAUSSE', reference: '§ 40 Numérique', measurable: true,
    compute: (i) => {
      const c = scopedOrders(i).filter(isConfirmed);
      const tot = new CurrencyTotals(); const dig = new CurrencyTotals();
      for (const o of c) { tot.add(o.amount); if (DIGITAL_CHANNELS.includes(o.channel)) dig.add(o.amount); }
      if (tot.empty) return { value: null, denominator: 0 };
      const parts = tot.currencies().map((cur) => ({ cur, share: pctBig(dig.get(cur)?.minor ?? 0n, tot.get(cur)!.minor) }));
      const main = parts.find((p) => p.cur === 'CDF') ?? parts[0]!;
      return { value: main.share, denominator: c.length, detail: parts.map((p) => `${p.cur} : ${p.share ?? '—'} %`).join(' ; ') };
    },
  },
  {
    code: 'DELAI_PAIEMENT_QUITTANCE', domain: 'Quittance', label: 'Délai paiement → quittance (médiane)',
    definition: 'Médiane du délai entre la confirmation signée du paiement et l’émission de la quittance.',
    formula: 'Médiane (émission quittance − confirmation), en secondes', source: 'Quittances, ordres de paiement',
    unit: 's', target: { op: '<', value: '60' }, targetLabel: '< 60 s (§ 40, cible à 18 mois)', better: 'BAISSE', reference: '§ 40 Quittance', measurable: true,
    compute: (i) => {
      const d = scopedOrders(i).filter((o) => o.confirmedAt && o.receiptIssuedAt).map((o) => Math.max(0, ms(o.confirmedAt!, o.receiptIssuedAt!)));
      const med = median(d);
      return { value: med === null ? null : String(Math.round(med / 1000)), denominator: d.length };
    },
  },
  {
    code: 'DELAI_PAIEMENT_RAPPROCHEMENT', domain: 'Rapprochement', label: 'Délai paiement → rapprochement bancaire (médiane)',
    definition: 'Médiane du délai entre la confirmation du paiement et son rapprochement avec le relevé du compte public.',
    formula: 'Médiane (rapprochement − confirmation), en heures', source: 'Ordres de paiement, rapprochements du Trésor',
    unit: 'h', target: { op: '<', value: '24' }, targetLabel: '< 24 heures (§ 40, cible à 18 mois)', better: 'BAISSE', reference: '§ 40 Rapprochement', measurable: true,
    compute: (i) => {
      const d = scopedOrders(i).filter((o) => o.confirmedAt && isReconciled(o)).map((o) => Math.max(0, ms(o.confirmedAt!, o.reconciledAt!)));
      const med = median(d);
      return { value: med === null ? null : hoursOf(med), denominator: d.length };
    },
  },
  {
    code: 'RECOURS_DANS_DELAI', domain: 'Recours', label: 'Délai de traitement des recours',
    question: 'Les recours sont-ils clos dans le délai légal ?',
    definition: 'Part des recours clos dans le délai légal de décision, parmi les recours clos et ceux dont le délai est déjà dépassé sans décision.',
    formula: 'Recours décidés au plus tard à la date limite / (recours décidés + recours ouverts hors délai)', source: 'Recours (procédure et délais du module Recours)',
    unit: '%', target: { op: '>', value: '90' }, targetLabel: '> 90 % (§ 40, cible à 18 mois)', better: 'HAUSSE', reference: '§ 40 Recours ; § 23', measurable: true,
    compute: (i) => {
      const scope = new Set(scopedObligations(i).map((o) => o.id));
      const today = kinshasaDay(i.facts.asOf);
      const a = i.facts.appeals.filter((x) => scope.has(x.obligationId) && x.decisionDueBy);
      const decided = a.filter((x) => x.decidedAt);
      const inTime = decided.filter((x) => kinshasaDay(x.decidedAt!) <= x.decisionDueBy!).length;
      const lateOpen = a.filter((x) => !x.decidedAt && today > x.decisionDueBy!).length;
      return ratio(inTime, decided.length + lateOpen, `${decided.length} recours clos, dont ${inTime} dans le délai ; ${lateOpen} ouvert(s) hors délai.`);
    },
  },
  {
    code: 'BAUX_ENREGISTRES', domain: 'Locatif', label: 'Baux enregistrés',
    definition: 'Nombre de baux actifs enregistrés (non échus à la date d’arrêté), avec la série de fin de mois des douze derniers mois pour la publication mensuelle.',
    formula: 'Baux enregistrés dont la fin n’est pas atteinte', source: 'Registre des baux',
    unit: 'nombre', target: null, targetLabel: 'Croissance continue, publiée mensuellement (§ 40)', better: 'HAUSSE', reference: '§ 40 Locatif', measurable: true,
    compute: (i) => {
      const activeAt = (day: string) => i.leases.filter((l) => l.createdAt.slice(0, 10) <= day && (!l.end || l.end.slice(0, 10) >= day)).length;
      const today = kinshasaDay(i.facts.asOf);
      const series: string[] = [];
      const [y, m] = today.split('-').map(Number) as [number, number];
      for (let k = 11; k >= 1; k--) {
        const last = new Date(Date.UTC(y, m - 1 - k + 1, 0)).toISOString().slice(0, 10);
        series.push(`${last.slice(0, 7)} : ${activeAt(last)}`);
      }
      const n = activeAt(today);
      series.push(`${today.slice(0, 7)} (au ${today}) : ${n}`);
      return { value: String(n), numerator: n, detail: `Fin de mois — ${series.join(' ; ')}.` };
    },
  },
];

function meets(target: NonNullable<KpiDefinition['target']>, value: string): boolean {
  const v = Number(value); const t = Number(target.value);
  switch (target.op) {
    case '>=': return v >= t;
    case '<=': return v <= t;
    case '<': return v < t;
    case '>': return v > t;
    case '=': return v === t;
  }
}

export interface KpiResult extends Omit<KpiDefinition, 'compute'> {
  value: string | null;
  numerator?: number;
  denominator?: number;
  detail?: string;
  status: KpiStatus;
  trend: { previous: string | null; window: string; direction: 'HAUSSE' | 'BAISSE' | 'STABLE' | 'INDISPONIBLE'; favorable: boolean | null };
}

/** Calcule le catalogue ; `previous` = entrées à la date d'arrêté antérieure (tendance). */
export function computeKpis(current: KpiInputs, previous: KpiInputs | null, window = '7 jours'): KpiResult[] {
  return KPI_CATALOGUE.map(({ compute, measurableWhen, ...rest }) => {
    // Mesurabilité conditionnelle : mesurée seulement si la source existe à la date d'arrêté courante.
    const def = measurableWhen ? { ...rest, measurable: measurableWhen(current) } : rest;
    if (!def.measurable || !compute) {
      return { ...def, value: null, status: 'NON_MESURE' as const, trend: { previous: null, window, direction: 'INDISPONIBLE' as const, favorable: null } };
    }
    const cur = compute(current);
    const prev = previous && (!measurableWhen || measurableWhen(previous)) ? compute(previous) : null;
    const status: KpiStatus = cur.value === null ? 'NON_CALCULABLE' : def.target ? (meets(def.target, cur.value) ? 'ATTEINTE' : 'NON_ATTEINTE') : 'SANS_CIBLE';
    let direction: KpiResult['trend']['direction'] = 'INDISPONIBLE';
    let favorable: boolean | null = null;
    if (cur.value !== null && prev?.value != null) {
      const d = Number(cur.value) - Number(prev.value);
      direction = d > 0 ? 'HAUSSE' : d < 0 ? 'BAISSE' : 'STABLE';
      favorable = direction === 'STABLE' || def.better === 'NEUTRE' ? null : direction === def.better;
    }
    return { ...def, ...cur, status, trend: { previous: prev?.value ?? null, window, direction, favorable } };
  });
}
