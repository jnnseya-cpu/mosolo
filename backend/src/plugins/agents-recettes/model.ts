/**
 * « Agents IA de recettes » (consigne du maître d'ouvrage, 01/10/2026 : « tous les construire ») — catalogue des agents
 * proposés le 30/09/2026 pour faire de MOSOLO une machine à recettes SANS heurter la population.
 *
 * Doctrine commune (rappelée par chaque proposition) :
 *  - plus de recettes de ceux qui devraient déjà payer et ne paient pas, et des fuites — jamais en alourdissant ceux qui
 *    paient ; aucune nouvelle charge sans acte signé (l'IA ne crée aucun impôt) ;
 *  - les grands d'abord (grandes entreprises, grands contrats, grosses dettes), les petits commerçants ensuite ;
 *  - aider avant de punir : rappel → échéancier → pénalité ; sanctions décidées par une personne, recours en un clic ;
 *  - l'IA propose, une personne décide ; données agrégées, aucune donnée personnelle divulguée ;
 *  - contrôle d'équité mensuel des propositions de l'IA (aucune commune ciblée injustement) ;
 *  - toute valeur non confirmée est marquée « par défaut — à confirmer par le maître d'ouvrage ».
 * Chaque agent est rattaché à un agent du catalogue IA (§ 23.2) : même fiche de contrôle, même journal.
 */
import type { RoleCode } from '@mosolo/shared';

export const A_CONFIRMER = 'par défaut — à confirmer par le maître d’ouvrage';

export type Famille = 'ASSIETTE' | 'PAIEMENT' | 'FUITES' | 'ARRIERES' | 'TARIFS' | 'CONFIANCE' | 'TERRAIN';
export const FAMILLES: Record<Famille, { ordre: number; libelle: string; but: string }> = {
  ASSIETTE: { ordre: 1, libelle: 'Trouver qui ne paie pas encore (élargir l’assiette)', but: 'Recenser ce qui échappe au registre ; une personne vérifie sur le terrain avant tout enrôlement.' },
  PAIEMENT: { ordre: 2, libelle: 'Rendre le paiement facile', but: 'Rappels au bon moment, dans la langue de la personne ; paiement sans smartphone ; échéancier avant pénalité.' },
  FUITES: { ordre: 3, libelle: 'Arrêter les fuites', but: 'Écarts de collecte par zone et par agent, paiements non rapprochés, fausses quittances.' },
  ARRIERES: { ordre: 4, libelle: 'Recouvrer les arriérés intelligemment', but: 'Les grosses dettes d’abord ; fenêtre de régularisation simulée avant toute décision.' },
  TARIFS: { ordre: 5, libelle: 'Tarifs et prévisions', but: 'Mesurer qui paierait plus avant tout changement ; prévoir les recettes.' },
  CONFIANCE: { ordre: 6, libelle: 'Confiance de la population', but: 'Aucune charge illégale ; montrer où va l’argent ; écouter les doléances ; alerte précoce sur le mécontentement.' },
  TERRAIN: { ordre: 7, libelle: 'Copilote des agents de terrain', but: 'Tournée du jour et liste de contrôle ; paiement sur le téléphone, jamais d’espèces.' },
};

export type AgentRecetteCode =
  | 'DECOUVERTE_CROISEE' | 'GRANDS_CONTRATS'
  | 'RAPPELS' | 'VOCAL_USSD' | 'ECHEANCIERS'
  | 'ANOMALIES_TERRAIN' | 'RAPPROCHEMENT' | 'VERIFICATION_PUBLIQUE'
  | 'PRIORITE_ARRIERES' | 'REGULARISATION'
  | 'IMPACT_TARIF' | 'PRIX_STATIONNEMENT' | 'PREVISION_RECETTES'
  | 'GARDIEN_LEGALITE' | 'OU_VA_ARGENT' | 'DOLEANCES' | 'HUMEUR'
  | 'COPILOTE_TERRAIN' | 'EQUITE';

/** NOUVEAU : calculé par ce module ; EXISTANT : circuit déjà en service, résumé et lien ; SOURCE : alimenté par un lot importé. */
export type Mode = 'NOUVEAU' | 'EXISTANT' | 'SOURCE' | 'SIMULATION';

export interface AgentRecette {
  code: AgentRecetteCode;
  nom: string;
  famille: Famille;
  /** Agent du catalogue IA (§ 23.2) auquel les propositions sont rattachées. */
  agentIa: string;
  mode: Mode;
  mission: string;
  /** Données utilisées (jamais de donnée personnelle divulguée). */
  donnees: string[];
  /** Ce que l'agent ne fait JAMAIS. */
  jamais: string;
  /** Écran du circuit existant qui prend le relais. */
  lien?: string;
}

export const AGENTS_RECETTES: AgentRecette[] = [
  { code: 'DECOUVERTE_CROISEE', nom: 'Découverte croisée de l’assiette', famille: 'ASSIETTE', agentIa: 'DECOUVERTE', mode: 'SOURCE',
    mission: 'Croiser l’imagerie (bâtiments), les raccordements SNEL et REGIDESO, les marchands de monnaie mobile et les plaques relevées avec le registre ; proposer les éléments absents pour vérification sur le terrain.',
    donnees: ['Lots importés et validés par deux personnes (sans nom ni téléphone)', 'Registre des objets (position, catégorie)', 'Registre des véhicules'], jamais: 'Enrôler ou liquider sans vérification par un agent sur le terrain.', lien: '/terrain' },
  { code: 'GRANDS_CONTRATS', nom: 'Surveillance des grands contrats', famille: 'ASSIETTE', agentIa: 'DECOUVERTE', mode: 'SOURCE',
    mission: 'Comparer ce que déclarent les grands opérateurs (antennes, panneaux, concessions, carrières, établissements) avec ce qui est observé ; proposer un rappel de déclaration.',
    donnees: ['Relevés d’observation par opérateur (lot validé)', 'Objets enregistrés de l’opérateur'], jamais: 'Liquider un écart sans constat contradictoire.', lien: '/grands-redevables' },
  { code: 'RAPPELS', nom: 'Rappels personnalisés', famille: 'PAIEMENT', agentIa: 'COMMUNICATION', mode: 'NOUVEAU',
    mission: 'Proposer un rappel par contribuable dont une échéance approche ou est dépassée, dans sa langue, au meilleur moment (après la paie), avec le lien de paiement ; envoi sur décision d’une personne.',
    donnees: ['Obligations impayées et échéances', 'Langue et canaux choisis par la personne'], jamais: 'Envoyer sans décision ; contourner les préférences de la personne (désinscription, WhatsApp sans consentement).', lien: '/communications' },
  { code: 'VOCAL_USSD', nom: 'Assistant vocal et USSD', famille: 'PAIEMENT', agentIa: 'COMMUNICATION', mode: 'EXISTANT',
    mission: '« Combien je dois ? Payer maintenant » par téléphone simple : menus USSD et serveur vocal (SVI), consultation après code secret, paiement par référence du circuit commun.',
    donnees: ['Sessions USSD / SVI (numéro masqué)'], jamais: 'Afficher nom ou historique sans code secret.', lien: '/canaux/ussd' },
  { code: 'ECHEANCIERS', nom: 'Proposition d’échéanciers', famille: 'PAIEMENT', agentIa: 'COPILOTE', mode: 'NOUVEAU',
    mission: 'Proposer un échéancier aux personnes en difficulté (retard ancien), avant toute pénalité ; la décision passe par le circuit des échéanciers du recouvrement.',
    donnees: ['Obligations en retard', 'Échéanciers déjà en vigueur'], jamais: 'Accorder un échéancier : seule une personne habilitée le fait.', lien: '/recouvrement' },
  { code: 'ANOMALIES_TERRAIN', nom: 'Écarts par zone et par agent', famille: 'FUITES', agentIa: 'FRAUDE', mode: 'NOUVEAU',
    mission: 'Signaler les communes dont le taux de recouvrement est très inférieur à la médiane, et les agents de terrain dont l’activité est très inférieure à celle de leurs pairs.',
    donnees: ['Liquidé et rapproché par commune', 'Contrôles par agent (30 jours)'], jamais: 'Sanctionner : une personne instruit, l’autorité compétente décide.', lien: '/terrain/qualite' },
  { code: 'RAPPROCHEMENT', nom: 'Paiements à rapprocher', famille: 'FUITES', agentIa: 'RAPPROCHEMENT', mode: 'NOUVEAU',
    mission: 'Lister les paiements confirmés non rapprochés au-delà du délai, à réclamer au prestataire ou à la banque.',
    donnees: ['Ordres de paiement (statut et dates)'], jamais: 'Rapprocher sans relevé.', lien: '/tresor' },
  { code: 'VERIFICATION_PUBLIQUE', nom: 'Vérification publique des quittances', famille: 'FUITES', agentIa: 'FRAUDE', mode: 'EXISTANT',
    mission: 'Toute personne scanne le QR d’une quittance ou d’un titre ; une fausse quittance est détectée aussitôt ; dossiers de fraude sur les preuves.',
    donnees: ['Résolveur universel des preuves', 'Dossiers de fraude'], jamais: 'Afficher des données personnelles au public.', lien: '/anti-fraude/preuves' },
  { code: 'PRIORITE_ARRIERES', nom: 'Priorisation des arriérés', famille: 'ARRIERES', agentIa: 'COPILOTE', mode: 'NOUVEAU',
    mission: 'Classer les dettes par montant et capacité apparente : les grands débiteurs d’abord ; l’ordre est proposé, une personne décide.',
    donnees: ['Obligations en retard par contribuable', 'Nombre d’objets et paiements passés (capacité apparente)'], jamais: 'Engager une mesure de recouvrement forcé.', lien: '/recouvrement' },
  { code: 'REGULARISATION', nom: 'Simulateur de fenêtre de régularisation', famille: 'ARRIERES', agentIa: 'PREVISION', mode: 'SIMULATION',
    mission: 'Simuler une fenêtre limitée (ex. pénalités remises si paiement sous N jours) : montants en jeu, pénalités remises, recouvrement attendu au taux observé.',
    donnees: ['Arriérés (principal et pénalités)', 'Taux de paiement observé après échéance'], jamais: 'Accorder une remise : il faut un acte.', lien: '/recouvrement' },
  { code: 'IMPACT_TARIF', nom: 'Simulateur d’impact avant changement de tarif', famille: 'TARIFS', agentIa: 'DECISION_EXECUTIVE', mode: 'SIMULATION',
    mission: 'Avant toute modification d’un tarif : qui paierait plus, par commune et par rang de localité ; alerte quand la charge pèse sur les rangs modestes.',
    donnees: ['Obligations de la règle', 'Rang de localité des objets'], jamais: 'Modifier un tarif : seul le circuit des règles (quatre visas, acte) le fait.', lien: '/registre' },
  { code: 'PRIX_STATIONNEMENT', nom: 'Prix du stationnement', famille: 'TARIFS', agentIa: 'PREVISION', mode: 'EXISTANT',
    mission: 'Ajuster le prix du stationnement à l’intérieur des fourchettes de l’acte pour garder 15 à 25 % de places libres (décision du 27/09/2026).',
    donnees: ['Occupation des zones'], jamais: 'Sortir des fourchettes de l’acte.', lien: '/stationnement' },
  { code: 'PREVISION_RECETTES', nom: 'Prévision des recettes', famille: 'TARIFS', agentIa: 'PREVISION', mode: 'NOUVEAU',
    mission: 'Prévoir les recettes rapprochées des trois prochains mois par devise, pour un budget réaliste.',
    donnees: ['Recettes rapprochées mensuelles'], jamais: 'Présenter une prévision comme une recette.' },
  { code: 'GARDIEN_LEGALITE', nom: 'Gardien de la légalité', famille: 'CONFIANCE', agentIa: 'VEILLE_JURIDIQUE', mode: 'NOUVEAU',
    mission: 'Signaler toute charge sans base légale valide (texte abrogé ou inconnu, règle non active) et toute double imposition d’un même objet.',
    donnees: ['Règles et textes', 'Obligations ouvertes'], jamais: 'Annuler une obligation : il propose, une personne décide.', lien: '/registre' },
  { code: 'OU_VA_ARGENT', nom: 'Où va votre argent', famille: 'CONFIANCE', agentIa: 'COMMUNICATION', mode: 'NOUVEAU',
    mission: 'Publier par commune les recettes rapprochées et les réalisations financées ; page publique, sans donnée individuelle.',
    donnees: ['Recettes rapprochées par commune (seuil de 5 contribuables)', 'Réalisations financées sur acte'], jamais: 'Publier une commune de moins de 5 contribuables.', lien: '/ou-va-votre-argent' },
  { code: 'DOLEANCES', nom: 'Doléances', famille: 'CONFIANCE', agentIa: 'COMMUNICATION', mode: 'NOUVEAU',
    mission: 'Recevoir les doléances (comportement d’un agent, montant, paiement, service), les orienter vers le bon service, suivre le délai de réponse ; alerte quand une commune ou un agent en attire anormalement.',
    donnees: ['Doléances déposées par les usagers'], jamais: 'Révéler l’auteur d’une doléance à l’agent mis en cause.', lien: '/mes-doleances' },
  { code: 'HUMEUR', nom: 'Baromètre du mécontentement', famille: 'CONFIANCE', agentIa: 'DECISION_EXECUTIVE', mode: 'NOUVEAU',
    mission: 'Alerte précoce par commune à partir de signaux agrégés (doléances, recours, avis) ; aucun individu suivi.',
    donnees: ['Doléances et recours agrégés par commune', 'Avis de satisfaction (global)'], jamais: 'Suivre une personne ou une opinion individuelle.' },
  { code: 'COPILOTE_TERRAIN', nom: 'Copilote de l’agent de terrain', famille: 'TERRAIN', agentIa: 'MISSIONS_TERRAIN', mode: 'NOUVEAU',
    mission: 'Tournée du jour dans le territoire et les modules de l’agent : objets à vérifier, éléments découverts à confirmer, ordre de passage ; paiement sur le téléphone de la personne.',
    donnees: ['Objets impayés du territoire (sans montant)', 'Découvertes acceptées'], jamais: 'Encaisser des espèces ; afficher des montants à l’agent de terrain.', lien: '/terrain' },
  { code: 'EQUITE', nom: 'Contrôle d’équité des propositions', famille: 'CONFIANCE', agentIa: 'APPRENTISSAGE_CONTINU', mode: 'NOUVEAU',
    mission: 'Chaque mois : vérifier que les propositions de l’IA ne ciblent pas certaines communes plus que leur poids dans le registre.',
    donnees: ['Propositions des agents par commune', 'Objets du registre par commune'], jamais: 'Corriger seul : il signale à la direction.' },
];

/** Paramètres des agents — tous « par défaut — à confirmer par le maître d'ouvrage ». */
export const PARAMETRES = {
  rayonRapprochementM: 30,
  rappelAvantEcheanceJours: 7,
  /** Jour du mois conseillé pour un rappel d'impayé (après la paie). */
  jourApresPaie: 26,
  echeancierRetardMinJours: 30,
  echeancierMensualites: 3,
  /** Fraction de la médiane sous laquelle une zone ou un agent est signalé. */
  seuilAnomalie: 0.5,
  /** Délai au-delà duquel un paiement confirmé non rapproché est réclamé (décision du 29/09/2026 : 10 jours). */
  rapprochementJours: 10,
  arrieresMax: 50,
  doleanceDelaiJours: 15,
  /** Multiple de la médiane à partir duquel une commune ou un agent attire anormalement de doléances. */
  doleanceAlerteMultiple: 2,
  /** Ratio (part des propositions / part du registre) au-delà duquel une commune est signalée au contrôle d'équité. */
  equiteRatio: 1.5,
  copiloteArrets: 15,
  previsionMois: 3,
  /** Baromètre : signaux sur 30 jours par commune — ATTENTION / ALERTE. */
  humeurAttention: 3,
  humeurAlerte: 6,
} as const;

/** Sources externes importées par lot (validation par une seconde personne) : jamais de nom ni de téléphone. */
export type SourceKind = 'IMAGERIE_BATIMENTS' | 'SNEL' | 'REGIDESO' | 'MARCHANDS_MOBILE' | 'RELEVES_PLAQUES' | 'OBSERVATIONS_OPERATEURS';
export const SOURCES: Record<SourceKind, { libelle: string; agent: AgentRecetteCode; categories: string[] }> = {
  IMAGERIE_BATIMENTS: { libelle: 'Imagerie aérienne ou satellite — bâtiments détectés', agent: 'DECOUVERTE_CROISEE', categories: ['BATIMENT', 'PARCELLE', 'UNITE_LOCATIVE'] },
  SNEL: { libelle: 'Raccordements électriques (SNEL)', agent: 'DECOUVERTE_CROISEE', categories: ['BATIMENT', 'PARCELLE', 'UNITE_LOCATIVE', 'ACTIVITE'] },
  REGIDESO: { libelle: 'Raccordements d’eau (REGIDESO)', agent: 'DECOUVERTE_CROISEE', categories: ['BATIMENT', 'PARCELLE', 'UNITE_LOCATIVE', 'ACTIVITE'] },
  MARCHANDS_MOBILE: { libelle: 'Marchands de monnaie mobile (opérateurs)', agent: 'DECOUVERTE_CROISEE', categories: ['ACTIVITE'] },
  RELEVES_PLAQUES: { libelle: 'Plaques relevées aux points de contrôle', agent: 'DECOUVERTE_CROISEE', categories: ['VEHICULE'] },
  OBSERVATIONS_OPERATEURS: { libelle: 'Observations par grand opérateur (antennes, panneaux, établissements)', agent: 'GRANDS_CONTRATS', categories: ['PANNEAU', 'ACTIVITE', 'AUTRE'] },
};

export type DoleanceCategorie = 'AGENT' | 'MONTANT' | 'PAIEMENT' | 'SERVICE' | 'AUTRE';
export const DOLEANCE_CATEGORIES: Record<DoleanceCategorie, { libelle: string; service: string; circuit?: string }> = {
  AGENT: { libelle: 'Comportement d’un agent', service: 'Intégrité et contrôle qualité' },
  MONTANT: { libelle: 'Montant contesté', service: 'Régie concernée — recours', circuit: '/recours' },
  PAIEMENT: { libelle: 'Paiement non pris en compte', service: 'Trésor — rapprochement' },
  SERVICE: { libelle: 'Service public (accueil, délai, information)', service: 'Cabinet du Gouverneur — relation usagers' },
  AUTRE: { libelle: 'Autre', service: 'Cabinet du Gouverneur — relation usagers' },
};

/** Rôles (lecture : direction, régies, analyse, audit, exploitation ; décision : direction et régies). */
export const LECTEURS: RoleCode[] = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R20', 'R21', 'R22', 'R23', 'R24', 'R26', 'R27', 'R28'];
export const LANCEURS: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R15', 'R17', 'R20', 'R22', 'R23'];
export const DECIDEURS: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R20', 'R21'];
export const IMPORTATEURS: RoleCode[] = ['R06', 'R07', 'R08', 'R15'];
export const VALIDATEURS_SOURCE: RoleCode[] = ['R05', 'R06', 'R07', 'R08', 'R22'];
export const TERRAIN: RoleCode[] = ['R09', 'R10', 'R11'];
export const TRAITEURS_DOLEANCES: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R22', 'R23'];
