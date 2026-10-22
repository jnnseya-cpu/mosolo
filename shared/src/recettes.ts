/**
 * Référentiel des recettes (Cahier ch. 7 : § 7.1 impôts provinciaux, § 7.2 taxes d'intérêt commun, § 7.3 taxes,
 * droits et redevances spécifiques à Kinshasa, § 7.4 inventaire de référence, § 7.5 recettes administratives) et
 * compétences (§ 6.3).
 *
 * Doctrine : chaque ligne reste au statut A_VERIFIER (chapitre 6) ; AUCUN taux, tarif ni montant n'est porté ici
 * (le montant vient d'une règle ACTIVE du registre, quatre visas). Les attributs d'inventaire du § 7.4 inconnus valent
 * « non renseigné » : ils ne sont jamais inventés. Les colonnes « rendement » sont l'appréciation qualitative du Cahier.
 * Les codes de recette sont STABLES et NON RÉUTILISABLES (§ 6.2, exigences complémentaires du registre).
 */
import type { RevenueCategory } from './domain.js';

export const NON_RENSEIGNE = 'non renseigné';

/** Séparation des compétences (§ 6.3) : cinq cas explicites pour chaque ligne. */
export const COMPETENCES = ['PROVINCIALE', 'INTERET_COMMUN_CLE', 'ETD', 'CENTRALE', 'ACTE_NOUVEAU'] as const;
export type Competence = (typeof COMPETENCES)[number];
export const COMPETENCE_LABEL: Record<Competence, string> = {
  PROVINCIALE: 'Recette exclusivement provinciale',
  INTERET_COMMUN_CLE: 'Recette d’intérêt commun avec clé de répartition',
  ETD: 'Recette des entités territoriales décentralisées (commune, chefferie)',
  CENTRALE: 'Recette du pouvoir central',
  ACTE_NOUVEAU: 'Recette nécessitant un acte nouveau',
};

/** Espaces de recettes : le Kinois garde un compte unique, chaque administration ne voit que ses recettes (§ 6.3). */
export const ESPACES_RECETTES = ['PROVINCIAL', 'COMMUNAL'] as const;
export type EspaceRecettes = (typeof ESPACES_RECETTES)[number];

export type RevenueSection = '7.1' | '7.2' | '7.3' | '7.5' | '6.3';

/** Attributs de l'inventaire de référence (§ 7.4) — chaque valeur inconnue vaut NON_RENSEIGNE. */
export const INVENTORY_ATTRIBUTES = [
  { key: 'administration', label: 'Administration', expected: 'Régie ou service légalement responsable' },
  { key: 'legalBasis', label: 'Base légale', expected: 'Texte, article' },
  { key: 'legalBasisStatus', label: 'Statut de validation de la base légale', expected: 'A_VERIFIER, VALIDEE, ABROGEE…' },
  { key: 'collectionMode', label: 'Mode actuel de perception', expected: 'Déclaratif, liquidation d’office, perception au point de service, etc.' },
  { key: 'channel', label: 'Canal', expected: 'Guichet, banque, Mobile Money, agent, autre' },
  { key: 'destinationAccount', label: 'Compte', expected: 'Compte public de destination actuel' },
  { key: 'volumes', label: 'Volumétrie', expected: 'Nombre d’assujettis et d’opérations par période' },
  { key: 'collectionCost', label: 'Coût', expected: 'Coût de collecte observé' },
  { key: 'estimatedLeakage', label: 'Déperdition estimée (leakage)', expected: 'Écart estimé entre dû et rapproché' },
  { key: 'dataSources', label: 'Données disponibles — sources', expected: 'Sources' },
  { key: 'dataQuality', label: 'Données disponibles — qualité et format', expected: 'Qualité, format' },
  { key: 'dataFreshness', label: 'Données disponibles — fraîcheur', expected: 'Fraîcheur' },
  { key: 'dependencies', label: 'Dépendances', expected: 'Partenaires, textes, systèmes dont dépend la recette' },
] as const;
export type InventoryKey = (typeof INVENTORY_ATTRIBUTES)[number]['key'];

export interface RevenueLine {
  /** Code stable et non réutilisable (§ 6.2). */
  code: string;
  section: RevenueSection;
  label: string;
  /** Objet dans le système. */
  object: string;
  /** Où se trouvent déjà les assujettis (§ 7.1) — NON_RENSEIGNE si le Cahier ne le dit pas. */
  liableWhere: string;
  /** Mécanisme de capture (§ 7.2, § 7.3) — NON_RENSEIGNE si le Cahier ne le dit pas. */
  capture: string;
  /** Rendement : appréciation propre à Kinshasa (Cahier), jamais un chiffre. */
  yield: string;
  competence: Competence;
  /** Clé de répartition (intérêt commun) : jamais inventée. */
  sharingKey?: string;
  revenueCategory: RevenueCategory;
  status: 'A_VERIFIER';
  /** Espace où la recette vit : provincial, ou communal (espace distinct, non activé à ce jour). */
  space: EspaceRecettes;
  /** Activée dans le périmètre provincial de MOSOLO ? (IPM : non.) */
  provincialScope: boolean;
  /** Modules du catalogue (§ 11) et verticale qui portent la recette. */
  modules: number[];
  vertical?: string;
  /** Types de titres du moteur (§ 19A.4) qui en matérialisent le droit. */
  credentialTypes?: string[];
  note?: string;
}

const L = (l: Omit<RevenueLine, 'status' | 'space' | 'provincialScope'> & Partial<Pick<RevenueLine, 'space' | 'provincialScope'>>): RevenueLine =>
  ({ status: 'A_VERIFIER', space: 'PROVINCIAL', provincialScope: true, ...l });
const KEY = 'Clé de répartition non renseignée — à certifier (chapitre 6)';

/** Référentiel des recettes du chapitre 7 (4 + 5 + 10 lignes) et de l'ancien IPM (§ 6.3). */
export const REVENUE_REFERENCE: RevenueLine[] = [
  // § 7.1 Impôts provinciaux
  L({ code: 'R71-IF', section: '7.1', label: 'Impôt foncier (bâti et non bâti)', object: 'Parcelle, bâtiment, rang de localité, surface', liableWhere: 'Titres fonciers, permis de bâtir, raccordements énergie et eau, historique déclaratif', capture: NON_RENSEIGNE, yield: 'Élevé', competence: 'PROVINCIALE', revenueCategory: 'IMPOT_PROVINCIAL', modules: [7, 8, 9], vertical: 'propriete' }),
  L({ code: 'R71-IRL', section: '7.1', label: 'Impôt sur les revenus locatifs', object: 'Unité louée, bail, bailleur, locataire', liableWhere: 'Indemnités de logement en paie, agences immobilières, baux d’entreprises, compteurs multiples', capture: NON_RENSEIGNE, yield: 'Le plus élevé', competence: 'PROVINCIALE', revenueCategory: 'IMPOT_PROVINCIAL', modules: [9], vertical: 'locatif' }),
  L({ code: 'R71-VIG', section: '7.1', label: 'Impôt sur les véhicules automoteurs (vignette)', object: 'Véhicule, plaque, catégorie, usage', liableWhere: 'Registre des immatriculations, polices d’assurance, mutations, contrôles routiers', capture: NON_RENSEIGNE, yield: 'Élevé', competence: 'PROVINCIALE', revenueCategory: 'IMPOT_PROVINCIAL', modules: [11], vertical: 'mobilite', credentialTypes: ['VIG-ANNUELLE'] }),
  L({ code: 'R71-SUP-MIN', section: '7.1', label: 'Impôt sur la superficie des concessions minières et d’hydrocarbures', object: 'Concession, superficie, titulaire', liableWhere: 'Cadastre minier', capture: NON_RENSEIGNE, yield: 'Faible à Kinshasa', competence: 'PROVINCIALE', revenueCategory: 'IMPOT_PROVINCIAL', modules: [22], vertical: 'construction' }),
  // § 7.2 Taxes d'intérêt commun
  L({ code: 'R72-CONSO-BAT', section: '7.2', label: 'Taxe de consommation sur bière, alcools, spiritueux et tabac', object: 'Producteur, importateur, volumes', liableWhere: NON_RENSEIGNE, capture: 'Cellule grands contribuables : déclaration mensuelle de volumes rapprochée des données d’accises et de facturation', yield: 'Très élevé, très peu de redevables', competence: 'INTERET_COMMUN_CLE', sharingKey: KEY, revenueCategory: 'INTERET_COMMUN', modules: [17, 56], vertical: 'entreprises' }),
  L({ code: 'R72-PATENTE', section: '7.2', label: 'Taxe annuelle pour la délivrance de la patente', object: 'Commerce, étal, activité', liableWhere: NON_RENSEIGNE, capture: 'Recensement par marché, code marchand Mobile Money, vignette QR sur devanture', yield: 'Volume élevé, ticket faible', competence: 'INTERET_COMMUN_CLE', sharingKey: KEY, revenueCategory: 'INTERET_COMMUN', modules: [10], vertical: 'entreprises', credentialTypes: ['PAT-ANNUELLE'] }),
  L({ code: 'R72-TSCR', section: '7.2', label: 'Taxe spéciale de circulation routière', object: 'Véhicule', liableWhere: NON_RENSEIGNE, capture: 'Même objet véhicule et même scan de contrôle que la vignette', yield: 'Moyen à élevé', competence: 'INTERET_COMMUN_CLE', sharingKey: KEY, revenueCategory: 'INTERET_COMMUN', modules: [11], vertical: 'mobilite', credentialTypes: ['TSC-ANNUELLE'] }),
  L({ code: 'R72-SUP-FOR', section: '7.2', label: 'Taxe de superficie sur les concessions forestières et minières', object: 'Concession', liableWhere: NON_RENSEIGNE, capture: 'Liquidation automatique sur la superficie du titre', yield: 'Faible à Kinshasa', competence: 'INTERET_COMMUN_CLE', sharingKey: KEY, revenueCategory: 'INTERET_COMMUN', modules: [22, 23], vertical: 'environnement' }),
  L({ code: 'R72-MAT-PREC', section: '7.2', label: 'Taxe sur les ventes de matières précieuses artisanales', object: 'Comptoir, négociant, transaction', liableWhere: NON_RENSEIGNE, capture: 'Déclaration par transaction des comptoirs agréés', yield: 'Faible à Kinshasa', competence: 'INTERET_COMMUN_CLE', sharingKey: KEY, revenueCategory: 'INTERET_COMMUN', modules: [22], vertical: 'construction' }),
  // § 7.3 Taxes, droits et redevances spécifiques à Kinshasa
  L({ code: 'R73-DEBIT-BOISSONS', section: '7.3', label: 'Autorisation d’exploitation d’un débit de boissons', object: 'Établissement, catégorie', liableWhere: NON_RENSEIGNE, capture: 'Recoupement avec les points de livraison des dépôts brassicoles : chaque point livré est un débit potentiel', yield: 'Élevé', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [10, 17], vertical: 'entreprises' }),
  L({ code: 'R73-PUBLICITE', section: '7.3', label: 'Publicité extérieure', object: 'Panneau, face, surface, emplacement', liableWhere: NON_RENSEIGNE, capture: 'Identifiant géographique et plaque QR par panneau ; tout panneau sans plaque est non enregistré', yield: 'Élevé', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [15], vertical: 'publicite' }),
  L({ code: 'R73-ANTENNES', section: '7.3', label: 'Taxe sur les antennes', object: 'Site, pylône, opérateur', liableWhere: NON_RENSEIGNE, capture: 'Liste des sites des opérateurs ; très peu de redevables, liquidation annuelle automatique', yield: 'Élevé', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [16], vertical: 'telecom' }),
  L({ code: 'R73-TRANSPORT-EMB', section: '7.3', label: 'Autorisation de transport ; embarquement et débarquement', object: 'Véhicule de transport, embarcation, point d’embarquement', liableWhere: NON_RENSEIGNE, capture: 'Autorisation rattachée à l’objet ; perception par voie mobile au point de départ', yield: 'Moyen', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [12, 13], vertical: 'mobilite', credentialTypes: ['LIC-TAXI', 'LIC-BUS', 'LIC-MOTO', 'EMB-CARTE'] }),
  L({ code: 'R73-SPECTACLES', section: '7.3', label: 'Taxe sur les spectacles', object: 'Événement, salle, organisateur', liableWhere: NON_RENSEIGNE, capture: 'Autorisation d’événement conditionnée à l’enregistrement ; assiette sur la billetterie déclarée', yield: 'Moyen', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [21], vertical: 'evenements' }),
  L({ code: 'R73-CARRIERES', section: '7.3', label: 'Carrières à ciel ouvert', object: 'Site d’extraction, exploitant', liableWhere: NON_RENSEIGNE, capture: 'Sites géoréférencés, comptage des sorties de camions rapproché des déclarations', yield: 'Moyen', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [22], vertical: 'construction', credentialTypes: ['CAR-BON'] }),
  L({ code: 'R73-VOIRIE', section: '7.3', label: 'Voirie, drainage, assainissement', object: 'Parcelle, activité', liableWhere: NON_RENSEIGNE, capture: 'Adossé aux objets existants, sans recensement supplémentaire', yield: 'Moyen', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [19], vertical: 'environnement' }),
  L({ code: 'R73-DOMAINE-PUBLIC', section: '7.3', label: 'Occupation du domaine public, marchés, parkings', object: 'Emprise, étal, place', liableWhere: NON_RENSEIGNE, capture: 'Plan géoréférencé des emprises et des places ; redevance périodique par voie mobile', yield: 'Moyen à élevé', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [14, 19, 20], vertical: 'domaine-public' }),
  L({ code: 'R73-PEAGE-ACCOSTAGE', section: '7.3', label: 'Péage provincial, accostage en ports privés', object: 'Axe, quai, embarcation', liableWhere: NON_RENSEIGNE, capture: 'Reçu électronique lié à la plaque ou à l’embarcation', yield: 'Moyen', competence: 'ACTE_NOUVEAU', revenueCategory: 'ACTE_REQUIS', modules: [24, 25], vertical: 'mobilite', credentialTypes: ['PEA-PASSAGE', 'PEA-CARNET', 'PEA-ABONNEMENT', 'ACC-ACCOSTAGE'], note: 'Acte requis (J1 péage ; J30 cadrage portuaire) avant toute perception.' }),
  L({ code: 'R73-PFNL', section: '7.3', label: 'Produits forestiers non ligneux', object: 'Point de vente, quantité', liableWhere: NON_RENSEIGNE, capture: 'Déclaration aux points de contrôle', yield: 'Faible', competence: 'PROVINCIALE', revenueCategory: 'PROVINCIAL_SPECIFIQUE', modules: [23], vertical: 'environnement' }),
  // § 6.3 Ancien impôt personnel minimum : recette de la commune ou de la chefferie, NON activée dans le périmètre provincial.
  L({ code: 'ETD-IPM', section: '6.3', label: 'Impôt personnel minimum (ancien IPM)', object: 'Personne physique', liableWhere: NON_RENSEIGNE, capture: NON_RENSEIGNE, yield: NON_RENSEIGNE, competence: 'ETD', revenueCategory: 'RECETTE_ETD', modules: [], space: 'COMMUNAL', provincialScope: false, note: 'Relève désormais de la commune ou de la chefferie : non activé dans le périmètre provincial de MOSOLO ; accueil ultérieur dans l’espace communal distinct.' }),
];

/** Recette administrative (§ 7.5) : toujours rattachée à une demande, un acte ou une prestation. */
export interface AdministrativeRevenue {
  code: string;
  label: string;
  nature: 'ACTE' | 'PERMIS' | 'DUPLICATA' | 'SERVICE';
  linkedTo: { kind: 'DEMARCHE' | 'ACTE' | 'PRESTATION'; ref: string; label: string };
  revenueCategory: 'DROIT_ADMINISTRATIF';
  status: 'A_VERIFIER';
  competence: Competence;
}

const A = (code: string, label: string, nature: AdministrativeRevenue['nature'], linkedTo: AdministrativeRevenue['linkedTo']): AdministrativeRevenue =>
  ({ code, label, nature, linkedTo, revenueCategory: 'DROIT_ADMINISTRATIF', status: 'A_VERIFIER', competence: 'PROVINCIALE' });

/** Recettes administratives recensées dans les démarches existantes (verticales, quitus, preuves) — aucun tarif. */
export const ADMINISTRATIVE_REVENUES: AdministrativeRevenue[] = [
  A('R75-AUT-EVENEMENT', 'Délivrance de l’autorisation d’événement', 'ACTE', { kind: 'DEMARCHE', ref: 'evenements:DEMANDE_AUTORISATION_EVENEMENT', label: 'Demande d’autorisation d’événement' }),
  A('R75-AUT-EXPLOITATION', 'Délivrance de l’autorisation d’exploitation (débit de boissons)', 'ACTE', { kind: 'DEMARCHE', ref: 'entreprises:DEMANDE_AUTORISATION', label: 'Demande d’autorisation d’exploitation' }),
  A('R75-AUT-TRANSPORT', 'Délivrance de l’autorisation de transport', 'ACTE', { kind: 'DEMARCHE', ref: 'mobilite:DEMANDE_AUTORISATION_TRANSPORT', label: 'Demande d’autorisation de transport' }),
  A('R75-PERMIS-VOIE', 'Permis d’occuper la voie (chantier)', 'PERMIS', { kind: 'DEMARCHE', ref: 'construction:DEMANDE_AUTORISATION_CHANTIER', label: 'Demande de chantier' }),
  A('R75-QUITUS-CHANTIER', 'Quitus de chantier', 'ACTE', { kind: 'DEMARCHE', ref: 'construction:DEMANDE_QUITUS_CHANTIER', label: 'Demande de quitus de chantier' }),
  A('R75-AUT-OCCUPATION', 'Autorisation d’occupation du domaine public', 'PERMIS', { kind: 'DEMARCHE', ref: 'domaine-public:DEMANDE_OCCUPATION_TEMPORAIRE', label: 'Demande d’occupation temporaire' }),
  A('R75-AUT-OCCUPATION-PERM', 'Autorisation d’occupation permanente du domaine public', 'PERMIS', { kind: 'DEMARCHE', ref: 'domaine-public:DEMANDE_OCCUPATION_PERMANENTE', label: 'Demande d’occupation permanente' }),
  A('R75-DUPLICATA-PLAQUE', 'Remplacement (duplicata) d’une plaque d’objet', 'DUPLICATA', { kind: 'PRESTATION', ref: 'verticales:plates.replace', label: 'Remplacement motivé d’une plaque' }),
  A('R75-QUITUS-FISCAL', 'Délivrance du quitus fiscal numérique', 'ACTE', { kind: 'PRESTATION', ref: 'fiscal:clearances', label: 'Quitus fiscal' }),
  A('R75-AUTHENTIFICATION', 'Authentification documentaire (vérification d’un titre ou d’une preuve)', 'SERVICE', { kind: 'PRESTATION', ref: 'preuves:verify', label: 'Vérification d’une preuve' }),
];

/** Une recette ETD ou centrale n'est jamais activée ni liquidée dans le périmètre provincial (§ 6.3). */
export function activableInProvincialScope(l: RevenueLine): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!l.provincialScope || l.competence === 'ETD') reasons.push('Recette des entités territoriales décentralisées : hors périmètre provincial (espace communal distinct).');
  if (l.competence === 'CENTRALE') reasons.push('Recette du pouvoir central : exclue du périmètre provincial.');
  if (l.competence === 'ACTE_NOUVEAU' || l.revenueCategory === 'ACTE_REQUIS') reasons.push('Acte nouveau requis avant toute activation.');
  if (l.status === 'A_VERIFIER') reasons.push('Ligne au statut A_VERIFIER : base légale à certifier (chapitre 6).');
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
