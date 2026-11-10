/**
 * Conduite du programme — modèle (pur) du Cahier nouvelle version :
 *  - ch. 35 « Feuille de route de mise en œuvre » : phases 0 à 6 et leurs portes de sortie (§ 35.1),
 *    plans d'action datés à 30 jours, 90 jours, 180 jours, 12 mois et 24 mois (§ 35.2) ;
 *  - ch. 36 « Modèle opérationnel » : huit fonctions, effectifs indicatifs au pilote, rattachements, principe de
 *    montée en autonomie (binôme provincial et calendrier de transfert écrit pour chaque poste externe) ;
 *  - ch. 37 « Gouvernance du programme » : cinq instances, composition (libellés de rôles seulement), rôle, fréquence.
 * Les textes du Cahier sont repris mot pour mot. Aucun nom de personne ; aucune date par défaut : la date de
 * démarrage du programme est saisie par une personne. Les délais de périodicité en jours sont des valeurs
 * PAR_DEFAUT — à confirmer par le maître d'ouvrage.
 */
import { addDays } from '../planification/model.js';

export const PAR_DEFAUT = 'PAR_DEFAUT — à confirmer par le maître d’ouvrage';

// ————————————————————————— § 35.1 Phases —————————————————————————

export const PHASE_STATES = ['A_VENIR', 'EN_COURS', 'PORTE_DEMANDEE', 'FRANCHIE', 'REFUSEE'] as const;
export type PhaseState = (typeof PHASE_STATES)[number];
export const PHASE_STATE_LABELS: Record<PhaseState, string> = {
  A_VENIR: 'À venir', EN_COURS: 'En cours', PORTE_DEMANDEE: 'Porte de sortie demandée', FRANCHIE: 'Porte franchie', REFUSEE: 'Porte refusée',
};

export interface PhaseDef {
  code: string;
  rank: number;
  label: string;
  /** Texte du Cahier (colonne « Objectifs »), mot pour mot. */
  objectifs: string;
  /** Texte du Cahier (colonne « Livrables »), mot pour mot. */
  livrablesTexte: string;
  /** Livrables suivis un à un (découpage du texte ci-dessus, sans reformulation). */
  livrables: { code: string; label: string }[];
  /** Texte du Cahier (colonne « Porte de sortie »), mot pour mot. */
  porteDeSortie: string;
}

const phase = (rank: number, label: string, objectifs: string, livrablesTexte: string, porteDeSortie: string): PhaseDef => ({
  code: `P${rank}`, rank, label, objectifs, livrablesTexte, porteDeSortie,
  livrables: livrablesTexte.split(', ').map((l, i) => ({ code: `P${rank}-L${i + 1}`, label: l })),
});

export const PHASES: PhaseDef[] = [
  phase(0, 'Phase 0 — Mandat et mobilisation juridique', 'Sponsor, gouvernance, revue juridique, inventaire des systèmes, base de référence des recettes',
    'Décision provinciale, comité de pilotage, relevé juridique certifié, inventaire', 'Décision signée et référentiel juridique arrêté'),
  phase(1, 'Phase 1 — Cadrage et architecture', 'Cartographie des processus, audit des données et des systèmes existants, recherche utilisateur, architecture',
    'Spécifications, dictionnaire de données, architecture de sécurité, choix des communes pilotes', 'Architecture validée et pilote approuvé'),
  phase(2, 'Phase 2 — Socle', 'Identité, compte, objets, règles, paiements, quittances, cartographie, audit, application terrain, tableaux de bord',
    'Version pilote éprouvée, tests d\'intrusion, documentation', 'Recette technique et sécurité passée'),
  phase(3, 'Phase 3 — Pilote', 'Recensement et campagne réelle dans quatre communes',
    'Registre pilote, résultats de campagne, rapport d\'évaluation indépendant', 'Objectifs de couverture et d\'encaissement atteints'),
  phase(4, 'Phase 4 — Extension', 'Communes supplémentaires, nouveaux modules, canaux et intégrations',
    'Déploiement progressif, formation, conventions partenaires', 'Stabilité opérationnelle par vague'),
  phase(5, 'Phase 5 — Généralisation', 'Couverture des 24 communes et des catégories majeures',
    'Exploitation courante, transfert de compétences', 'Autonomie des équipes provinciales'),
  phase(6, 'Phase 6 — Optimisation', 'Amélioration par la donnée, extension des gisements, réduction des coûts',
    'Revues trimestrielles, plan d\'amélioration', 'Indicateurs en progression soutenue'),
];
export const PHASE_CODES = PHASES.map((p) => p.code);
export const phaseDef = (code: string) => PHASES.find((p) => p.code === code);

// ————————————————————————— § 35.2 Plans d'action datés —————————————————————————

export const ACTION_STATUSES = ['A_FAIRE', 'EN_COURS', 'REALISEE'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = { A_FAIRE: 'À faire', EN_COURS: 'En cours', REALISEE: 'Réalisée' };

export interface HorizonDef {
  code: string;
  label: string;
  /** Échéance relative à la date de démarrage du programme (jours ou mois calendaires). */
  offset: { days: number } | { months: number };
  actionsTexte: string;
  actions: { code: string; label: string }[];
  /** Texte du Cahier (colonne « Preuve de réalisation »), mot pour mot. */
  preuveAttendue: string;
}

const horizon = (code: string, label: string, offset: HorizonDef['offset'], actionsTexte: string, preuveAttendue: string): HorizonDef => ({
  code, label, offset, actionsTexte, preuveAttendue,
  actions: actionsTexte.split(' ; ').map((a, i) => ({ code: `${code}-A${i + 1}`, label: a })),
});

export const HORIZONS: HorizonDef[] = [
  horizon('H30J', '30 jours', { days: 30 },
    'Décision provinciale ; nomination du comité de pilotage ; relevé juridique sur l\'Ordonnance-loi n° 18/004 et l\'édit en vigueur ; inventaire des systèmes et des bases existantes ; base de référence des recettes ; lettre d\'intention aux partenaires de données',
    'Acte de nomination, relevé juridique signé, inventaire remis'),
  horizon('H90J', '90 jours', { days: 90 },
    'Référentiel des recettes prioritaires paramétré et validé ; architecture et sécurité approuvées ; protocoles de données signés ; communes pilotes arrêtées ; équipes recrutées et formées ; socle en développement',
    'Référentiel versionné, protocoles signés, socle démontrable'),
  horizon('H180J', '180 jours', { days: 180 },
    'Recensement locatif et commercial des communes pilotes ; paiements électroniques opérationnels ; quittance vérifiable en service ; tableaux de bord en production ; campagne de février prête avec déclarations pré-remplies',
    'Rapport de pilote, statistiques de couverture, recettes rapprochées'),
  horizon('H12M', '12 mois', { months: 12 },
    'Extension à la moitié des communes ; cellule grands redevables opérationnelle ; publicité et antennes intégrées ; arriérés en campagne ; audit indépendant du premier exercice',
    'Rapport d\'audit, part électronique des recettes, taux de couverture'),
  horizon('H24M', '24 mois', { months: 24 },
    'Couverture des 24 communes ; catégories majeures intégrées ; transfert de compétences réalisé ; module d\'affectation et transparence publique en service',
    'Rapport annuel public, indicateurs consolidés'),
];
export const ACTION_CODES = HORIZONS.flatMap((h) => h.actions.map((a) => a.code));
export const actionDef = (code: string) => {
  for (const h of HORIZONS) { const a = h.actions.find((x) => x.code === code); if (a) return { horizon: h, action: a }; }
  return undefined;
};

/** Ajoute des mois calendaires à une date AAAA-MM-JJ (fin de mois bornée : 31/01 + 1 mois = 28 ou 29/02). */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12); const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Échéance d'un horizon : date de démarrage + décalage ; nulle tant qu'aucune date n'a été saisie. */
export function horizonDueDate(h: HorizonDef, startDate: string | null): string | null {
  if (!startDate) return null;
  return 'days' in h.offset ? addDays(startDate, h.offset.days) : addMonths(startDate, h.offset.months);
}

/** Une action est en retard si son échéance est dépassée (jour de Kinshasa) sans réalisation prouvée. */
export function isOverdue(dueDate: string | null, today: string, status: ActionStatus): boolean {
  return !!dueDate && dueDate < today && status !== 'REALISEE';
}

// ————————————————————————— ch. 36 Modèle opérationnel —————————————————————————

export interface FunctionDef {
  code: string;
  label: string;
  /** Effectif indicatif au pilote, texte du Cahier mot pour mot (jamais un chiffre contractuel). */
  effectifIndicatif: string;
  rattachement: string;
  /** Postes de cette fonction présumés externes (prestataire) : doublés d'un agent provincial désigné. */
  externeParDefaut: boolean;
}

export const FUNCTIONS: FunctionDef[] = [
  { code: 'DIRECTION_PROGRAMME', label: 'Direction de programme', effectifIndicatif: '1 directeur, 1 adjoint', rattachement: 'Ministère provincial des Finances', externeParDefaut: false },
  { code: 'REFERENTIEL_JURIDIQUE', label: 'Référentiel juridique', effectifIndicatif: '2 juristes, 1 tarificateur', rattachement: 'Services juridiques provinciaux', externeParDefaut: false },
  { code: 'PRODUIT_SERVICE', label: 'Produit et service', effectifIndicatif: '1 responsable produit, 1 designer de service', rattachement: 'Programme', externeParDefaut: false },
  { code: 'INGENIERIE', label: 'Ingénierie', effectifIndicatif: '6 à 10 développeurs, 1 architecte, 1 spécialiste données spatiales', rattachement: 'Prestataire avec transfert de compétences', externeParDefaut: true },
  { code: 'SECURITE_AUDIT_TECHNIQUE', label: 'Sécurité et audit technique', effectifIndicatif: '1 responsable sécurité, audit externe périodique', rattachement: 'Programme et inspection', externeParDefaut: false },
  { code: 'OPERATIONS_TERRAIN', label: 'Opérations terrain', effectifIndicatif: 'Par commune pilote : 1 chef de centre, 10 à 20 recenseurs, 4 à 8 contrôleurs', rattachement: 'Régie compétente', externeParDefaut: false },
  { code: 'ASSISTANCE_FORMATION', label: 'Assistance et formation', effectifIndicatif: '1 centre d\'appui, formateurs par commune', rattachement: 'Régie compétente', externeParDefaut: false },
  { code: 'TRESORERIE_RAPPROCHEMENT', label: 'Trésorerie et rapprochement', effectifIndicatif: '2 comptables publics dédiés', rattachement: 'Trésorerie provinciale', externeParDefaut: false },
];
export const FUNCTION_CODES = FUNCTIONS.map((f) => f.code);
export const PRINCIPE_EXPLOITATION = 'Le principe d\'exploitation est la montée en autonomie : chaque poste externe est doublé d\'un agent provincial désigné, avec un calendrier de transfert écrit et vérifié à chaque porte de phase.';
export const POSTE_A_POURVOIR = 'Poste à pourvoir';

export interface TransferMilestone { id: string; label: string; dueDate: string; done?: { at: string; by: string; reference: string; sha256: string } }
export interface Pairing { agentLabel: string; agentUserId?: string; designatedBy: string; designatedAt: string; motif: string; calendar: TransferMilestone[] }

/** Transfert achevé : calendrier écrit dont tous les jalons sont réalisés avec preuve. */
export const transferComplete = (p: Pairing | undefined) => !!p && p.calendar.length > 0 && p.calendar.every((m) => !!m.done);
export const overdueMilestones = (p: Pairing | undefined, today: string) => (p ? p.calendar.filter((m) => !m.done && m.dueDate < today) : []);

// ————————————————————————— ch. 37 Gouvernance du programme —————————————————————————

export interface BodyDef {
  code: string;
  label: string;
  /** Composition : libellés de rôles seulement (aucun nom de personne), texte du Cahier. */
  composition: string[];
  role: string;
  frequence: string;
  /** Délai au-delà duquel une réunion est en retard ; null = pas de périodicité (« À chaque évolution »). */
  delaiJours: number | null;
  delaiStatut: string | null;
  /** Rôles de la plateforme habilités à consigner une réunion de cette instance (secrétariat). */
  secretariat: string[];
  /** Circuits et droits déjà construits auxquels l'instance se rattache (liens, sans duplication). */
  liens: { type: 'POLITIQUE' | 'CIRCUIT' | 'ROUTE' | 'REGISTRE'; reference: string; description: string }[];
}

export const BODIES: BodyDef[] = [
  {
    code: 'COMITE_PILOTAGE', label: 'Comité de pilotage',
    composition: ['Ministre provincial des Finances', 'directeurs des régies', 'services juridiques', 'informatique', 'représentant du Gouverneur'],
    role: 'Arbitrage, validation des portes de phase, approbation du référentiel', frequence: 'Mensuelle', delaiJours: 31, delaiStatut: PAR_DEFAUT,
    secretariat: ['R01', 'R02', 'R03', 'R05'],
    liens: [
      { type: 'POLITIQUE', reference: 'acces:module.activate', description: 'Comité de pilotage (Gouverneur, Cabinet, ministre des Finances) : activation des modules sur référence d’arrêté (acces/policy.ts).' },
      { type: 'POLITIQUE', reference: 'planification:programme.gate.decide', description: 'Décision motivée sur les portes de sortie de phase, rattachée à une réunion consignée du comité.' },
      { type: 'CIRCUIT', reference: 'PILOTAGE_PORTE_PHASE', description: 'Circuit à deux personnes : demande de porte → décision du comité de pilotage.' },
    ],
  },
  {
    code: 'COMITE_TECHNIQUE', label: 'Comité technique',
    composition: ['Programme', 'architecte', 'sécurité', 'régies', 'trésorerie'],
    role: 'Suivi d\'exécution, risques, dépendances', frequence: 'Hebdomadaire', delaiJours: 7, delaiStatut: PAR_DEFAUT,
    secretariat: ['R02', 'R03', 'R05', 'R06', 'R17', 'R26', 'R27', 'R28'],
    liens: [{ type: 'ROUTE', reference: 'GET /v1/pilotage/feuille-de-route', description: 'Suivi d’exécution : phases, actions en retard, binômes et jalons de transfert.' }],
  },
  {
    code: 'COMITE_JURIDIQUE_TARIFAIRE', label: 'Comité juridique et tarifaire',
    composition: ['Juristes provinciaux', 'régies', 'contrôle'],
    role: 'Validation des fiches de recettes et des versions', frequence: 'À chaque évolution', delaiJours: null, delaiStatut: null,
    secretariat: ['R05', 'R06', 'R07', 'R13', 'R14', 'R22'],
    liens: [
      { type: 'POLITIQUE', reference: 'acces:arbitration.opinion', description: 'Comité juridique et tarifaire : avis juridique puis décision par une autorité distincte (acces/policy.ts).' },
      { type: 'POLITIQUE', reference: 'acces:arbitration.decide', description: 'Décision d’arbitrage par une autorité distincte de l’auteur de l’avis.' },
      { type: 'REGISTRE', reference: 'GET /v1/legal-rules', description: 'Registre des règles : chaque version en revue juridique ou financière est rattachée à une réunion du comité.' },
    ],
  },
  {
    code: 'CONTROLE_INDEPENDANT', label: 'Contrôle indépendant',
    composition: ['Inspection provinciale', 'audit interne', 'observateur de la société civile'],
    role: 'Vérification des résultats publiés et des écarts', frequence: 'Trimestrielle', delaiJours: 92, delaiStatut: PAR_DEFAUT,
    secretariat: ['R22', 'R23', 'R36'],
    liens: [{ type: 'ROUTE', reference: 'GET /v1/public/transparency', description: 'Résultats publiés (transparence trimestrielle) vérifiés par le contrôle indépendant.' }],
  },
  {
    code: 'COMITE_DONNEES', label: 'Comité des données',
    composition: ['Responsable des données', 'juridique', 'sécurité', 'régies'],
    role: 'Protocoles, finalités, conservation, publications', frequence: 'Mensuelle', delaiJours: 31, delaiStatut: PAR_DEFAUT,
    secretariat: ['R02', 'R03', 'R05', 'R06', 'R13', 'R14', 'R25', 'R28'],
    liens: [
      { type: 'POLITIQUE', reference: 'socle:export.committee', description: 'Décision du comité des données sur les extractions massives (socle/exports.ts).' },
      { type: 'CIRCUIT', reference: 'SOCLE_EXTRACTION_MASSIVE', description: 'Demandeur → responsable des données → comité des données (integrite/gouvernance/circuits.ts).' },
    ],
  },
];
export const BODY_CODES = BODIES.map((b) => b.code);
export const bodyDef = (code: string) => BODIES.find((b) => b.code === code);

/** Statuts d'une version de règle « en attente de validation » par le comité juridique et tarifaire. */
export const RULE_STATUSES_AWAITING = ['REVUE_JURIDIQUE', 'REVUE_FINANCIERE'] as const;

/** Réunion en retard : dernière réunion (ou aucune) au-delà du délai de la fréquence, en jours de Kinshasa. */
export function meetingOverdue(delaiJours: number | null, lastMeetingDate: string | null, today: string): boolean | null {
  if (delaiJours === null) return null;
  if (!lastMeetingDate) return true;
  return addDays(lastMeetingDate, delaiJours) < today;
}
