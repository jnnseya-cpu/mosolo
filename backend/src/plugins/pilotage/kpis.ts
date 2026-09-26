/**
 * Catalogue des indicateurs (§ 39, annexe H § H.19, questions de décision § 26.1) : chaque indicateur porte sa
 * définition, sa formule, sa source, sa valeur calculée sur les données réelles, sa cible et sa tendance.
 * Un indicateur sans mesure possible est déclaré « non mesuré » — jamais une valeur inventée.
 */
import { COMMUNES } from '../../reference/kinshasa.js';
import type { Facts } from './facts.js';
import {
  isConfirmed, isDue, isReconciled, isSettled, matchesChannel, matchesDims, type Filters,
} from './ladder.js';
import { hoursOf, mean, median, pct } from './money.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Canaux numériques (paiement dématérialisé de bout en bout). Le guichet bancaire et le point agréé sont « assistés ». */
export const DIGITAL_CHANNELS = ['MOBILE_MONEY', 'CARD', 'USSD', 'QR', 'TRANSFER'];
export const ASSISTED_CHANNELS = ['USSD', 'AGENT_POINT', 'BANK'];

/** Données du socle hors échelle, déjà filtrées au périmètre. */
export interface KpiInputs {
  facts: Facts;
  filters: Filters;
  objects: { commune: string; category: string; status: string; id: string; createdAt: string }[];
  leases: { unitObjectId: string; createdAt: string }[];
  rules: { status: string; sourceVerification: string; demo?: boolean }[];
  exceptions: { type: string; openedAt: string; computed?: boolean }[];
  comms: { attempted: number; delivered: number; sandboxLogged: number };
  alerts: { severity: string; at: string }[];
  ai: { status: string; createdAt?: string }[];
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
  target: { op: '>=' | '<=' | '<' | '='; value: string } | null;
  targetLabel: string;
  /** Sens favorable. */
  better: 'HAUSSE' | 'BAISSE' | 'NEUTRE';
  reference: string;
  measurable: boolean;
  /** Mesure structurelle : garantie par construction plutôt qu'observée. */
  structural?: boolean;
  compute?: (i: KpiInputs) => KpiValue;
}

const scopedObligations = (i: KpiInputs) => i.facts.obligations.filter((o) => matchesDims(o, i.filters));
const scopedOrders = (i: KpiInputs) => i.facts.orders.filter((o) => matchesDims(o, i.filters) && matchesChannel(o, i.filters));
const ratio = (n: number, d: number, detail?: string): KpiValue => ({ value: pct(n, d), numerator: n, denominator: d, ...(detail ? { detail } : {}) });
const ms = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();

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
      const base = scopedOrders(i).filter((o) => isConfirmed(o) && (isReconciled(o) || now - new Date(o.confirmedAt!).getTime() >= DAY));
      return ratio(base.filter((o) => isReconciled(o) && ms(o.confirmedAt!, o.reconciledAt!) <= DAY).length, base.length);
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
      const old = scopedOrders(i).filter((o) => isConfirmed(o) && now - new Date(o.confirmedAt!).getTime() > 2 * DAY);
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
      const n = i.exceptions.filter((e) => now - new Date(e.openedAt).getTime() > 30 * DAY).length;
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
  },
  {
    code: 'RANV', domain: 'Résultat', label: 'Recette additionnelle nette vérifiée (RANV)',
    definition: 'Recette additionnelle nette par rapport à une base de référence auditée (§ 38.2).',
    formula: '§ 38.2', source: 'Base de référence auditée — non disponible',
    unit: '%', target: null, targetLabel: 'Positive et certifiée', better: 'HAUSSE', reference: '§ 39 Résultat', measurable: false,
  },
  {
    code: 'SATISFACTION', domain: 'Service', label: 'Satisfaction après paiement',
    definition: 'Note moyenne de l’enquête post-paiement.',
    formula: 'Moyenne des notes (sur 5)', source: 'Enquête post-paiement — non déployée',
    unit: 'nombre', target: { op: '>=', value: '4' }, targetLabel: '≥ 4/5', better: 'HAUSSE', reference: '§ 39 Service', measurable: false,
  },
];

function meets(target: NonNullable<KpiDefinition['target']>, value: string): boolean {
  const v = Number(value); const t = Number(target.value);
  switch (target.op) {
    case '>=': return v >= t;
    case '<=': return v <= t;
    case '<': return v < t;
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
  return KPI_CATALOGUE.map(({ compute, ...def }) => {
    if (!def.measurable || !compute) {
      return { ...def, value: null, status: 'NON_MESURE' as const, trend: { previous: null, window, direction: 'INDISPONIBLE' as const, favorable: null } };
    }
    const cur = compute(current);
    const prev = previous ? compute(previous) : null;
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
