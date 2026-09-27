/**
 * Postes de décision des autorités et postes de travail des opérateurs (Cahier nouvelle version, chapitre 27 ; catalogue
 * des modules n° 41 à 44, renommés le 27/09/2026) — modèle pur, sans dépendance d'exécution.
 *
 * Ce chapitre NE MODIFIE AUCUNE HABILITATION : il définit ce qui est présenté en premier, sous quelle forme et dans quel
 * volume. Les droits, périmètres et séparations des fonctions restent ceux des politiques des modules sources, relues
 * ici sans jamais être changées. Les textes du Cahier sont repris mot pour mot ; toute valeur chiffrée non fixée par le
 * Cahier est marquée PAR_DEFAUT — à confirmer par le maître d'ouvrage.
 */
import type { MoneyJSON, RoleCode } from '@mosolo/shared';

export const PAR_DEFAUT = 'PAR_DEFAUT — à confirmer par le maître d’ouvrage';
export const EXEMPLE = '[EXEMPLE]';
export const MENTION_MAQUETTE = 'Maquette de travail soumise à validation — les dossiers, montants et communes affichés sont des illustrations.';

// ————————————————————————— Catalogue n° 41 à 44 : anciens et nouveaux noms —————————————————————————

/** Noms du catalogue (Cahier ch. 11) : le nom nouveau d'abord, l'ancien conservé comme alias (règle n° 1). */
export const CATALOGUE_POSTES = [
  { numero: 41, nom: 'Postes de décision des autorités', ancienNom: 'Centre de commandement exécutif', contenu: 'Corbeille de décisions, seuils de remontée, délégations, note hebdomadaire' },
  { numero: 42, nom: 'Poste de travail — régie fiscale', ancienNom: 'Tableau de bord régie fiscale', contenu: 'Assiette, liquidation, recouvrement, contentieux' },
  { numero: 43, nom: 'Poste de travail — régie des taxes', ancienNom: 'Tableau de bord régie des taxes', contenu: 'Droits, taxes et redevances urbaines' },
  { numero: 44, nom: 'Postes ministériels', ancienNom: 'Tableaux de bord ministériels', contenu: 'Périmètre légal de chaque ministère, décisions et exécution' },
] as const;

// ————————————————————————— § 27 introduction : deux familles d'interfaces —————————————————————————

export const FAMILLES = [
  {
    code: 'POSTE_DE_DECISION', libelle: 'Poste de décision',
    pourQui: 'Gouverneur, Directeur de cabinet, Secrétaire exécutif, ministres provinciaux, autorités habilitées',
    question: '« Qu’attend-on de moi, maintenant ? »',
    forme: 'Corbeille de décisions, quelques chiffres, exceptions ; consultation par exception',
  },
  {
    code: 'POSTE_DE_TRAVAIL', libelle: 'Poste de travail',
    pourQui: 'Directeurs de régie, chefs de centre, trésorerie, juristes, contrôleurs, auditeurs, agents',
    question: '« Que dois-je traiter aujourd’hui ? »',
    forme: 'Files de travail, dossiers, listes, outils de saisie ; consultation continue',
  },
] as const;

export const HABILITATIONS_INCHANGEES = 'Ce chapitre ne modifie aucune habilitation. Les droits d’accès, les périmètres et les règles de séparation des fonctions sont ceux définis au chapitre consacré aux rôles et à la matrice d’habilitations : seul change ce qui est présenté en premier, et en quel volume.';

/** § 27.1 — les quatre règles du poste de décision. */
export const QUATRE_REGLES = [
  'Un écran répond à une seule question. S’il en pose deux, il en manque un.',
  'Rien n’est affiché qui n’appelle ni une décision, ni une vérification, ni une comparaison utile.',
  'Toute information affichée porte sa date, sa source et son état ; un chiffre nu n’a pas sa place devant une autorité.',
  'La consultation se fait par exception : on ne montre pas ce qui va bien, on montre ce qui appelle une action.',
] as const;

// ————————————————————————— § 27.2 budget d'attention et règle des trois écrans —————————————————————————

export type ProfilPoste = 'GOUVERNEUR' | 'DIRECTEUR_CABINET' | 'SECRETAIRE_EXECUTIF' | 'MINISTRE' | 'DIRECTION_REGIE' | 'AUTORITE_HABILITEE';

export interface BudgetAttention {
  profil: ProfilPoste;
  autorite: string;
  temps: string;
  minSecondes: number;
  maxSecondes: number;
  frequence: string;
  support: string;
}

/** Référentiel des budgets d'attention (§ 27.2) : contraintes de conception, pas des souhaits. */
export const BUDGETS_ATTENTION: BudgetAttention[] = [
  { profil: 'GOUVERNEUR', autorite: 'Gouverneur', temps: '60 à 90 secondes', minSecondes: 60, maxSecondes: 90, frequence: 'Quotidienne, souvent en déplacement', support: 'Téléphone' },
  { profil: 'DIRECTEUR_CABINET', autorite: 'Directeur de cabinet', temps: '5 à 10 minutes', minSecondes: 300, maxSecondes: 600, frequence: 'Plusieurs fois par jour', support: 'Téléphone et ordinateur' },
  { profil: 'SECRETAIRE_EXECUTIF', autorite: 'Secrétaire exécutif du Gouvernement provincial', temps: '10 à 15 minutes', minSecondes: 600, maxSecondes: 900, frequence: 'Quotidienne', support: 'Ordinateur' },
  { profil: 'MINISTRE', autorite: 'Ministre provincial', temps: '3 à 5 minutes', minSecondes: 180, maxSecondes: 300, frequence: 'Quotidienne', support: 'Téléphone' },
  { profil: 'AUTORITE_HABILITEE', autorite: 'Autre autorité habilitée', temps: '3 à 5 minutes', minSecondes: 180, maxSecondes: 300, frequence: 'Hebdomadaire ou par exception', support: 'Téléphone' },
];

export const TROIS_ECRANS = [
  { niveau: 1, code: 'DECIDER', libelle: 'Écran 1 — Décider', contenu: 'Corbeille des décisions qui attendent cette autorité, classées par échéance et par enjeu', role: 'C’est l’écran d’accueil ; il s’ouvre là, toujours' },
  { niveau: 2, code: 'SITUER', libelle: 'Écran 2 — Situer', contenu: 'Quatre à six chiffres seulement, avec leur écart à l’objectif et leur tendance', role: 'Donner le contexte nécessaire pour décider, pas davantage' },
  { niveau: 3, code: 'COMPRENDRE', libelle: 'Écran 3 — Comprendre', contenu: 'Le détail d’un point précis : une commune, une recette, une alerte, un dossier', role: 'Atteint par un clic depuis l’écran 1 ou 2, jamais par le menu' },
] as const;

export const TEST_ACCEPTATION_90S = 'Une autorité qui ouvre la plateforme pour la première fois, sans formation et sans accompagnement, doit pouvoir dire en moins de quatre-vingt-dix secondes ce qu’on attend d’elle et ce qui ne va pas dans sa ville. Si elle doit d’abord choisir un filtre, une période ou une commune, l’écran est à refaire.';

// ————————————————————————— § 27.3 fiche de décision —————————————————————————

export const BLOCS_FICHE = [
  { code: 'OBJET', libelle: 'Objet', contenu: 'Une phrase : ce qui est demandé', raison: 'L’autorité doit comprendre sans lire le dossier' },
  { code: 'DEMANDEUR', libelle: 'Demandeur et service instructeur', contenu: 'Qui propose, qui a instruit, qui a validé en amont', raison: 'Établit la responsabilité de la proposition' },
  { code: 'ENJEU', libelle: 'Enjeu', contenu: 'Montant concerné, nombre de contribuables ou d’objets, commune', raison: 'Permet de hiérarchiser sans ouvrir le détail' },
  { code: 'ECHEANCE', libelle: 'Échéance', contenu: 'Date limite et conséquence du silence', raison: 'Distingue l’urgent du reste ; le silence n’est jamais neutre' },
  { code: 'FONDEMENT', libelle: 'Fondement', contenu: 'Référence légale ou réglementaire applicable', raison: 'Aucune décision sans base légale affichée' },
  { code: 'POSITION', libelle: 'Position du service', contenu: 'Recommandation motivée en deux lignes, avec les réserves éventuelles', raison: 'L’autorité arbitre une proposition, elle ne rédige pas' },
  { code: 'SI_RIEN', libelle: 'Ce qui se passe si rien n’est décidé', contenu: 'Effet concret de l’absence de décision à l’échéance', raison: 'Rend visible le coût de l’inaction' },
  { code: 'PIECES', libelle: 'Pièces', contenu: 'Dossier complet, accessible mais replié par défaut', raison: 'Disponible pour qui veut vérifier, invisible pour qui ne le veut pas' },
  { code: 'ACTIONS', libelle: 'Actions', contenu: 'Approuver · Refuser · Déléguer · Demander un complément', raison: 'Quatre issues, toutes motivées et journalisées' },
] as const;

export const ACTIONS_FICHE = ['APPROUVER', 'REFUSER', 'DELEGUER', 'COMPLEMENT'] as const;
export type ActionFiche = (typeof ACTIONS_FICHE)[number];
export const ACTION_LABELS: Record<ActionFiche, string> = { APPROUVER: 'Approuver', REFUSER: 'Refuser', DELEGUER: 'Déléguer', COMPLEMENT: 'Demander un complément' };

/** Longueur maximale de la position du service : « deux lignes » (environ 2 × 140 caractères). */
export const POSITION_MAX = 280;
export const MOTIF_MIN = 10;

// ————————————————————————— § 27.4 filtre de remontée —————————————————————————

export const CATEGORIES_DECISION = [
  'PUBLICATION_REGLE', 'CHANGEMENT_COMPTE_BENEFICIAIRE', 'EXONERATION_DEGREVEMENT', 'SUSPENSION_TIERS', 'MESURE_IRREVERSIBLE_BIEN',
  'OUVERTURE_ENQUETE_INTERNE', 'ARBITRAGE_ASSIGNATIONS', 'PHASE_CONTRAINTE', 'AFFECTATION_FONDS', 'ALERTE_DEPERDITION',
] as const;
export type CategorieDecision = (typeof CATEGORIES_DECISION)[number];

export interface CategorieDef {
  code: CategorieDecision;
  libelle: string;
  niveau: string;
  /** Rôles du « niveau habituel » (présentation seulement : la décision reste réservée aux titulaires du droit). */
  niveauRoles: RoleCode[];
  pourquoi: string;
  /** Paramètre du registre des seuils (contre-valeur CDF) au-delà duquel la catégorie remonte. */
  seuil: string;
  /** Gravité de présentation par défaut (classement, pas un seuil) — PAR_DEFAUT. */
  gravite: Gravite;
  /** Remontée d'information : la fiche informe, la décision appartient au service compétent. */
  information?: boolean;
}

export type Gravite = 'NORMALE' | 'HAUTE' | 'CRITIQUE';
export const GRAVITE_RANG: Record<Gravite, number> = { NORMALE: 1, HAUTE: 2, CRITIQUE: 3 };

export const CATEGORIES: CategorieDef[] = [
  { code: 'PUBLICATION_REGLE', libelle: 'Publication d’une règle de recette ou d’un nouveau taux', niveau: 'Ministre ou Gouverneur selon le texte', niveauRoles: ['R05', 'R01'], pourquoi: 'Engage la légalité de toutes les liquidations qui suivront', seuil: 'postes.seuil.publication_regle_cdf', gravite: 'HAUTE' },
  { code: 'CHANGEMENT_COMPTE_BENEFICIAIRE', libelle: 'Changement d’un compte public bénéficiaire', niveau: 'Gouverneur, après double validation technique', niveauRoles: ['R01'], pourquoi: 'Point de bascule le plus sensible de tout le circuit financier', seuil: 'postes.seuil.changement_compte_beneficiaire_cdf', gravite: 'CRITIQUE' },
  { code: 'EXONERATION_DEGREVEMENT', libelle: 'Exonération, annulation ou dégrèvement au-delà d’un seuil', niveau: 'Ministre provincial des Finances', niveauRoles: ['R05'], pourquoi: 'Perte de recette discrétionnaire ; exige une traçabilité au plus haut niveau', seuil: 'postes.seuil.exoneration_degrevement_cdf', gravite: 'HAUTE' },
  { code: 'SUSPENSION_TIERS', libelle: 'Suspension d’un partenaire, d’un centre agréé ou d’un prestataire', niveau: 'Ministre de tutelle, information du Gouverneur', niveauRoles: ['R04', 'R01'], pourquoi: 'Effet économique immédiat sur un tiers', seuil: 'postes.seuil.suspension_tiers_cdf', gravite: 'HAUTE' },
  { code: 'MESURE_IRREVERSIBLE_BIEN', libelle: 'Mesure irréversible sur un bien', niveau: 'Autorité légalement compétente', niveauRoles: ['R04'], pourquoi: 'Touche au droit de propriété', seuil: 'postes.seuil.mesure_irreversible_bien_cdf', gravite: 'HAUTE' },
  { code: 'OUVERTURE_ENQUETE_INTERNE', libelle: 'Ouverture d’une enquête interne', niveau: 'Gouverneur ou ministre concerné', niveauRoles: ['R01', 'R04', 'R05'], pourquoi: 'Met en cause des agents publics', seuil: 'postes.seuil.ouverture_enquete_interne_cdf', gravite: 'HAUTE' },
  { code: 'ARBITRAGE_ASSIGNATIONS', libelle: 'Arbitrage des assignations et objectifs', niveau: 'Gouverneur sur proposition des régies', niveauRoles: ['R01'], pourquoi: 'Détermine la pression de collecte de l’exercice', seuil: 'postes.seuil.arbitrage_assignations_cdf', gravite: 'HAUTE' },
  { code: 'PHASE_CONTRAINTE', libelle: 'Déclenchement ou levée d’une phase de contrainte', niveau: 'Gouverneur', niveauRoles: ['R01'], pourquoi: 'Décision de politique publique visible par toute la ville', seuil: 'postes.seuil.phase_contrainte_cdf', gravite: 'HAUTE' },
  { code: 'AFFECTATION_FONDS', libelle: 'Scénario d’affectation de fonds disponibles', niveau: 'Gouverneur et autorités budgétaires', niveauRoles: ['R01', 'R05'], pourquoi: 'Engage l’emploi de la recette', seuil: 'postes.seuil.affectation_fonds_cdf', gravite: 'NORMALE' },
  { code: 'ALERTE_DEPERDITION', libelle: 'Alerte de déperdition au-delà d’un seuil', niveau: 'Gouverneur, en information immédiate', niveauRoles: ['R01'], pourquoi: 'Toute minute compte pour préserver la preuve', seuil: 'postes.seuil.alerte_deperdition_cdf', gravite: 'CRITIQUE', information: true },
];
export const categorieDef = (code: string) => CATEGORIES.find((c) => c.code === code);

/** § 27.4 « Ce qui ne remonte jamais » : appliqué par le filtre (la fonction, pas un réglage). */
export const JAMAIS_REMONTE = [
  { code: 'DOSSIER_NOMINATIF', texte: 'le dossier fiscal d’un contribuable nommément désigné, sauf finalité déclarée, enregistrée et journalisée' },
  { code: 'TACHE_PRODUCTION', texte: 'les tâches de production : liquidations courantes, notifications, relances, rapprochements ordinaires' },
  { code: 'INCIDENT_TECHNIQUE', texte: 'les anomalies techniques, les incidents d’exploitation et les indicateurs de disponibilité' },
  { code: 'VARIATION_QUOTIDIENNE', texte: 'les variations quotidiennes sans signification, qui appellent un suivi et non une décision' },
  { code: 'TRANCHABLE_PAR_LE_SERVICE', texte: 'tout élément qu’un service peut trancher lui-même dans son propre périmètre' },
] as const;
export type MotifNonRemontee = (typeof JAMAIS_REMONTE)[number]['code'];

/** Natures de dossier refusées à la soumission : elles ne remontent jamais (§ 27.4). */
export const NATURES_REFUSEES: Record<string, MotifNonRemontee> = {
  LIQUIDATION: 'TACHE_PRODUCTION', NOTIFICATION: 'TACHE_PRODUCTION', RELANCE: 'TACHE_PRODUCTION', RAPPROCHEMENT: 'TACHE_PRODUCTION',
  INCIDENT: 'INCIDENT_TECHNIQUE', DISPONIBILITE: 'INCIDENT_TECHNIQUE', VARIATION: 'VARIATION_QUOTIDIENNE',
};

export const FILTRE_EST_LA_FONCTION = 'Le filtre est la fonction, pas un réglage. Une corbeille qui dépasse une dizaine d’éléments cesse d’être lue : s’il augmente durablement, ce sont les seuils de délégation qui doivent être revus, pas l’écran.';

/** Types d'alertes techniques ou d'exploitation (jamais sur un écran exécutif, § 27.12). */
export const ALERTES_TECHNIQUES = /ELEVATION|DISPONIBILITE|INCIDENT|CLE|SCELLEMENT|WORM|APPAREIL|GPS|DLP|SESSION|CONNEXION|MFA|MOT_DE_PASSE|LECTURE_MASSIVE|EXPORT|TECHNIQUE/;

// ————————————————————————— § 27.5 poste du Gouverneur —————————————————————————

export const MENU_GOUVERNEUR = [
  { code: 'decisions', libelle: 'Décisions', ouvre: 'La corbeille complète, avec l’historique de ses propres décisions', pourquoi: 'C’est la raison d’être de l’accès' },
  { code: 'recettes', libelle: 'Recettes', ouvre: 'Potentiel, constaté, encaissé, réglé, rapproché, disponible — par commune et par catégorie', pourquoi: 'Répondre à la question du niveau de ressources' },
  { code: 'alertes', libelle: 'Alertes', ouvre: 'Déperditions, fraudes en cours d’instruction, délais dépassés', pourquoi: 'Savoir où l’on perd' },
  { code: 'communes', libelle: 'Communes', ouvre: 'Carte et classement, écart à l’assignation, couverture du recensement', pourquoi: 'Interpeller un responsable nommément' },
  { code: 'rechercher', libelle: 'Rechercher', ouvre: 'Accès direct à une commune, une recette, un dossier, une décision', pourquoi: 'Remplace toute arborescence supplémentaire' },
] as const;

export const MENU_CABINET = [
  { code: 'instruction', libelle: 'Instruction', ouvre: 'Dossiers en cours : instruit, incomplet, à instruire', pourquoi: 'Renvoyer au service, réclamer une pièce, reformuler' },
  { code: 'ordre-du-jour', libelle: 'Ordre du jour', ouvre: 'Ordonnancement de la corbeille du Gouverneur', pourquoi: 'Monter, différer ou descendre, avec motif enregistré' },
  { code: 'suivi', libelle: 'Suivi', ouvre: 'Décisions prises et non exécutées, avec responsable', pourquoi: 'Relancer nommément un service' },
  { code: 'coordination', libelle: 'Coordination', ouvre: 'Vue transversale des services et des régies', pourquoi: 'Sans accès aux dossiers individuels' },
  { code: 'rechercher', libelle: 'Rechercher', ouvre: 'Accès direct à un dossier ou à une décision', pourquoi: 'Remplace toute arborescence supplémentaire' },
] as const;

export const MENU_SECRETARIAT = [
  { code: 'execution', libelle: 'Exécution', ouvre: 'Décision, acte à produire, responsable, échéance, état — Non engagé · En cours · Produit · Notifié · Exécuté', pourquoi: 'Ce qui a été décidé est-il fait ?' },
  { code: 'retards', libelle: 'Retards', ouvre: 'Actes hors délai et cause déclarée du blocage', pourquoi: 'Le blocage doit être déclaré, pas constaté' },
  { code: 'coordination', libelle: 'Coordination', ouvre: 'Interservices, calendrier institutionnel', pourquoi: 'Coordination interservices' },
  { code: 'documentation', libelle: 'Documentation', ouvre: 'Arrêtés, notes, conventions, désignations — version et date de publication', pourquoi: 'Documentation institutionnelle' },
  { code: 'rechercher', libelle: 'Rechercher', ouvre: 'Une décision, un acte, un service', pourquoi: 'Remplace toute arborescence supplémentaire' },
] as const;

export const MENU_MINISTRE = [
  { code: 'mes-decisions', libelle: 'Mes décisions', ouvre: 'Corbeille filtrée sur les compétences du ministère', pourquoi: 'Aucune décision relevant d’un autre ministère' },
  { code: 'mes-recettes', libelle: 'Mes recettes', ouvre: 'Recettes dont le ministère est responsable, dans les six états, face aux objectifs', pourquoi: 'Agrégats uniquement' },
  { code: 'mes-services', libelle: 'Mes services', ouvre: 'Performance des directions et services rattachés, délais de traitement, contentieux', pourquoi: 'Pas d’accès aux agents d’un autre ministère' },
  { code: 'mes-exceptions', libelle: 'Mes exceptions', ouvre: 'Dossiers hors délai, écarts de rapprochement, alertes de son périmètre', pourquoi: 'Instruction par ses services, pas d’action financière' },
  { code: 'mes-engagements', libelle: 'Mes engagements', ouvre: 'Décisions prises par lui ou le concernant, et leur état d’exécution', pourquoi: 'Lecture, relance, justification' },
] as const;

export const MENU_AUTORITE = [
  { code: 'recettes', libelle: 'Recettes', ouvre: 'Agrégats provinciaux, par catégorie et par commune, dans le périmètre déclaré', pourquoi: 'Consultation d’agrégats uniquement' },
  { code: 'realisations', libelle: 'Réalisations', ouvre: 'Même source que le tableau public de transparence', pourquoi: 'Réalisations financées, sans donnée personnelle' },
  { code: 'mon-habilitation', libelle: 'Mon habilitation', ouvre: 'Périmètre, date d’expiration, historique de mes consultations', pourquoi: 'Renouvellement explicite, jamais tacite' },
] as const;

export const MENU_DIRECTION = [
  { code: 'decisions', libelle: 'Décisions', ouvre: 'Ce qui relève de votre signature', pourquoi: 'Corbeille de décision, séparée de la file de travail' },
  { code: 'travail', libelle: 'File de travail', ouvre: 'Assiette, recouvrement, contentieux, performance des agents et des centres', pourquoi: 'Poste de travail (§ 27.13)' },
  { code: 'rechercher', libelle: 'Rechercher', ouvre: 'Une commune, une recette, un dossier, une décision', pourquoi: 'Remplace toute arborescence supplémentaire' },
] as const;

export const MENUS: Record<ProfilPoste, readonly { code: string; libelle: string; ouvre: string; pourquoi: string }[]> = {
  GOUVERNEUR: MENU_GOUVERNEUR, DIRECTEUR_CABINET: MENU_CABINET, SECRETAIRE_EXECUTIF: MENU_SECRETARIAT, MINISTRE: MENU_MINISTRE, AUTORITE_HABILITEE: MENU_AUTORITE, DIRECTION_REGIE: MENU_DIRECTION,
};

export const TITRES_POSTES: Record<ProfilPoste, string> = {
  GOUVERNEUR: 'Cabinet du Gouverneur', DIRECTEUR_CABINET: 'Directeur de cabinet', SECRETAIRE_EXECUTIF: 'Secrétariat exécutif du Gouvernement provincial',
  MINISTRE: 'Ministre provincial', AUTORITE_HABILITEE: 'Consultation · habilitation à durée déterminée', DIRECTION_REGIE: 'Direction de régie — poste de décision',
};

/** Repères des maquettes (bas d'écran), mot pour mot. */
export const REPERES: Record<ProfilPoste, { valeur: string; libelle: string }[]> = {
  GOUVERNEUR: [{ valeur: '90 s', libelle: 'temps de consultation visé' }, { valeur: '3', libelle: 'niveaux de profondeur au maximum' }, { valeur: 'Lundi', libelle: 'note hebdomadaire hors connexion' }],
  DIRECTEUR_CABINET: [{ valeur: '5–10 min', libelle: 'plusieurs fois par jour' }, { valeur: '≤ 10', libelle: 'éléments visés dans la corbeille du Gouverneur' }],
  SECRETAIRE_EXECUTIF: [{ valeur: '10–15 min', libelle: 'consultation quotidienne' }, { valeur: '1', libelle: 'question posée par l’écran' }],
  MINISTRE: [{ valeur: '3–5 min', libelle: 'consultation quotidienne' }, { valeur: 'Téléphone', libelle: 'support dominant' }],
  AUTORITE_HABILITEE: [{ valeur: '3–5 min', libelle: 'hebdomadaire ou par exception' }, { valeur: 'Expire', libelle: 'habilitation à durée déterminée' }],
  DIRECTION_REGIE: [{ valeur: '2', libelle: 'familles d’interfaces, séparées à l’écran' }, { valeur: '3', libelle: 'niveaux de profondeur au maximum' }],
};

/** Bloc commun « Les règles qui tiennent ces écrans » (présent sur les cinq maquettes). */
export const REGLES_ECRANS = [
  { titre: 'Jamais un chiffre nu', texte: 'Tout montant porte son état.' },
  { titre: 'La règle des trois écrans', texte: '1. Décider — la corbeille, écran d’accueil, toujours ; 2. Situer — quatre à six chiffres, pas davantage ; 3. Comprendre — le détail, atteint par un clic, jamais par le menu.' },
  { titre: 'Voir sans manipuler', texte: 'Aucun poste de décision ne permet de modifier une dette, un paiement, une quittance ou un compte bénéficiaire.' },
  { titre: 'Le filtre est la fonction', texte: 'Au-delà d’une dizaine d’éléments, revoir les seuils de délégation, pas l’écran.' },
  { titre: 'Le test des 90 secondes', texte: 'Critère d’acceptation.' },
  { titre: 'Les habilitations ne changent pas', texte: 'Seul change ce qui est présenté en premier, et en quel volume.' },
] as const;
export const PIED_POSTES = `KINSHASA MOSOLO · Postes de décision des autorités provinciales · ${MENTION_MAQUETTE}`;

// ————————————————————————— § 27.10 règles communes d'affichage des chiffres —————————————————————————

export const ETATS_CHIFFRE = ['POTENTIEL_ESTIME', 'CONSTATE', 'ENCAISSE', 'REGLE', 'RAPPROCHE', 'DISPONIBLE'] as const;
export type EtatRecette = (typeof ETATS_CHIFFRE)[number];
/** États d'un chiffre : les six états d'une recette, plus les comptages et ratios hors montant. */
export type EtatChiffre = EtatRecette | 'OBJECTIF' | 'COMPTAGE' | 'RATIO' | 'DELAI';
export const ETAT_LABELS: Record<EtatChiffre, string> = {
  POTENTIEL_ESTIME: 'Potentiel estimé', CONSTATE: 'Constaté', ENCAISSE: 'Encaissé', REGLE: 'Réglé en compte public', RAPPROCHE: 'Rapproché', DISPONIBLE: 'Disponible pour affectation',
  OBJECTIF: 'Objectif (assignation)', COMPTAGE: 'Comptage', RATIO: 'Ratio', DELAI: 'Délai',
};
/** Bandeau des six états (maquettes). */
export const SIX_ETATS = ['Potentiel', 'Constaté', 'Encaissé', 'Réglé', 'Rapproché', 'Disponible'] as const;
/** Correspondance avec l'échelle unifiée de la recette (§ 26.1, pilotage/ladder.ts). */
export const ETAT_NIVEAU_ECHELLE: Record<EtatRecette, string> = {
  POTENTIEL_ESTIME: 'potential', CONSTATE: 'assessed', ENCAISSE: 'confirmed', REGLE: 'settled', RAPPROCHE: 'reconciled', DISPONIBLE: 'available',
};

export const REGLES_CHIFFRES = [
  'Aucun chiffre n’est affiché sans son état : potentiel estimé, constaté, encaissé, réglé en compte public, rapproché, ou disponible pour affectation. Un montant sans état est une source d’illusion budgétaire.',
  'Aucun chiffre n’est affiché seul : il porte toujours une comparaison, à l’objectif, à la période précédente ou aux autres communes.',
  'Tout chiffre porte sa date de production et son taux de conversion lorsqu’il est exprimé en devises.',
  'Une estimation est visuellement distincte d’une donnée constatée, et le demeure dans tout export.',
  'Tout chiffre est cliquable jusqu’à sa source, en trois niveaux au maximum.',
  'Toute alerte énonce sa cause en une phrase ; une alerte qui exige une enquête pour être comprise est mal conçue.',
  'Les exports reprennent ces mentions ; un chiffre sorti de la plateforme ne doit jamais perdre son état ni sa date.',
] as const;

export interface Taux { devise: string; cdfParUnite: string; date: string; source: string; nature: string }
export interface Comparaison { type: 'OBJECTIF' | 'PERIODE_PRECEDENTE' | 'COMMUNES' | 'SEUIL'; libelle: string; valeur: string | null; ecart: string | null; tendance: 'HAUSSE' | 'BAISSE' | 'STABLE' | 'INDISPONIBLE' }

/** Chiffre présentable devant une autorité (§ 27.10) : jamais nu. */
export interface Chiffre {
  code: string;
  libelle: string;
  /** Valeur décimale (chaîne) ; null = non mesuré (jamais inventé). */
  valeur: string | null;
  unite: string;
  etat: EtatChiffre;
  etatLabel: string;
  estimation: boolean;
  /** Production du chiffre (horodatage ISO). */
  date: string;
  /** Contre-valeurs (CDF et USD) quand le chiffre est un montant. */
  equivalents?: { CDF: string | null; USD: string | null };
  taux?: Taux;
  comparaison: Comparaison;
  /** Delta du jour (même état, aujourd'hui seulement), quand il a un sens. */
  deltaDuJour?: string | null;
  /** Hypothèses d'une projection ou d'une estimation (§ 27.12 : jamais une projection sans ses hypothèses). */
  hypotheses?: string[];
  /** Chemin jusqu'à la source : trois niveaux au maximum (écran 1 → 2 → 3). */
  source: { libelle: string; chemin: string[]; api: string };
  exemple?: boolean;
}

export class RegleAffichageError extends Error {}

/** Construit un chiffre en appliquant les règles du § 27.10 (lève une erreur si une mention manque). */
export function chiffre(c: Omit<Chiffre, 'etatLabel'>): Chiffre {
  if (!c.etat) throw new RegleAffichageError(`Chiffre ${c.code} sans état (§ 27.10, règle 1).`);
  if (!c.comparaison?.type) throw new RegleAffichageError(`Chiffre ${c.code} sans comparaison (§ 27.10, règle 2).`);
  if (!c.date) throw new RegleAffichageError(`Chiffre ${c.code} sans date de production (§ 27.10, règle 3).`);
  if (c.equivalents && !c.taux) throw new RegleAffichageError(`Chiffre ${c.code} exprimé en devises sans taux de conversion (§ 27.10, règle 3).`);
  if (c.etat === 'POTENTIEL_ESTIME' && !c.estimation) throw new RegleAffichageError(`Chiffre ${c.code} : un potentiel est une estimation (§ 27.10, règle 4).`);
  if (c.estimation && c.valeur !== null && !c.hypotheses?.length) throw new RegleAffichageError(`Chiffre ${c.code} : une estimation chiffrée porte ses hypothèses (§ 27.12).`);
  if (!c.source?.chemin?.length || c.source.chemin.length > 3) throw new RegleAffichageError(`Chiffre ${c.code} : source en trois niveaux au maximum (§ 27.10, règle 5).`);
  return { ...c, etatLabel: ETAT_LABELS[c.etat] };
}

/** § 27.10 règle 6 : cause d'une alerte en une phrase (première phrase, bornée, sans donnée personnelle). */
export function causeEnUnePhrase(texte: string): string {
  const masque = texte
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[masqué]')
    .replace(/\b(TP|CTB|TAXPAYER|tp)[-_][A-Za-z0-9-]+/g, '[contribuable]')
    .replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(masque);
  const phrase = (m ? m[1]! : masque).trim();
  return phrase.length > 200 ? `${phrase.slice(0, 197).trimEnd()}…` : phrase;
}

/** § 27.10 règle 7 : ligne d'export d'un chiffre (état, estimation, date et taux conservés). */
export const COLONNES_EXPORT = ['code', 'libelle', 'valeur', 'unite', 'etat', 'estimation', 'exemple', 'date_production', 'equivalent_CDF', 'equivalent_USD', 'taux', 'comparaison', 'ecart', 'source'] as const;
export function ligneExport(c: Chiffre): string[] {
  return [
    c.code, c.libelle, c.valeur ?? 'non mesuré', c.unite, c.etatLabel, c.estimation ? 'ESTIMATION' : 'CONSTATÉ', c.exemple ? EXEMPLE : '', c.date,
    c.equivalents?.CDF ?? '', c.equivalents?.USD ?? '', c.taux ? `1 ${c.taux.devise} = ${c.taux.cdfParUnite} CDF (${c.taux.date}, ${c.taux.source})` : '',
    `${c.comparaison.libelle}${c.comparaison.valeur !== null ? ` : ${c.comparaison.valeur}` : ''}`, c.comparaison.ecart ?? '', c.source.chemin.join(' > '),
  ];
}

// ————————————————————————— § 27.7 exécution —————————————————————————

export const ETATS_EXECUTION = ['NON_ENGAGE', 'EN_COURS', 'PRODUIT', 'NOTIFIE', 'EXECUTE'] as const;
export type EtatExecution = (typeof ETATS_EXECUTION)[number];
export const ETAT_EXECUTION_LABELS: Record<EtatExecution, string> = { NON_ENGAGE: 'Non engagé', EN_COURS: 'En cours', PRODUIT: 'Produit', NOTIFIE: 'Notifié', EXECUTE: 'Exécuté' };
export const ACTES_A_PRODUIRE = ['ARRETE', 'NOTE', 'CONVENTION', 'INSTRUCTION', 'DESIGNATION', 'DECISION'] as const;
export type ActeAProduire = (typeof ACTES_A_PRODUIRE)[number];
export const ACTE_LABELS: Record<ActeAProduire, string> = { ARRETE: 'Arrêté', NOTE: 'Note', CONVENTION: 'Convention', INSTRUCTION: 'Instruction', DESIGNATION: 'Désignation', DECISION: 'Décision' };

// ————————————————————————— § 27.6 préparation par le cabinet —————————————————————————

export const ETATS_PREPARATION = ['INSTRUIT', 'INCOMPLET', 'A_INSTRUIRE'] as const;
export type EtatPreparation = (typeof ETATS_PREPARATION)[number];
export const ETAT_PREPARATION_LABELS: Record<EtatPreparation, string> = { INSTRUIT: 'Instruit', INCOMPLET: 'Incomplet', A_INSTRUIRE: 'À instruire' };
export const ACTIONS_PREPARATION = ['TRANSMETTRE', 'RENVOYER', 'RECLAMER_PIECE', 'REFORMULER'] as const;
export type ActionPreparation = (typeof ACTIONS_PREPARATION)[number];
export const ACTIONS_ORDRE = ['MONTER', 'DESCENDRE', 'DIFFERER'] as const;
export type ActionOrdre = (typeof ACTIONS_ORDRE)[number];

// ————————————————————————— § 27.9 autres autorités habilitées —————————————————————————

export const INTERDITS_AUTORITE = [
  'Aucune donnée fiscale individuelle.',
  'Aucune corbeille de décision, aucune instruction.',
  'Aucune action.',
] as const;

// ————————————————————————— § 27.12 ce qui ne figure jamais sur un écran exécutif —————————————————————————

export const JAMAIS_SUR_ECRAN_EXECUTIF = [
  'aucune donnée fiscale individuelle sur un écran d’accueil, y compris celui du Gouverneur ;',
  'aucune action financière directe : on approuve une orientation, on ne modifie ni une dette, ni un paiement, ni un compte bénéficiaire depuis un poste de décision ;',
  'aucun indicateur technique d’exploitation, qui relève du poste d’administration ;',
  'aucune donnée non rapprochée présentée comme une recette acquise ;',
  'aucun classement nominatif d’agents publics fondé sur des mesures intrusives ;',
  'aucune projection présentée sans ses hypothèses.',
] as const;

/** Routes qui modifient une dette, un paiement, une quittance ou un compte bénéficiaire : jamais relayées par un poste. */
export const ROUTES_FINANCIERES_INTERDITES = [
  /^\/v1\/obligations\//, /^\/v1\/payment-orders\//, /^\/v1\/paiements\//, /^\/v1\/receipts\//, /^\/v1\/beneficiary-accounts\//, /^\/v1\/ledger\//,
  /^\/v1\/tresor\/operations/, /^\/v1\/recouvrement\/remises\//, /^\/v1\/recouvrement\/non-valeurs\//, /^\/v1\/assessments\//, /^\/v1\/settlements\//,
];
export const estRouteFinanciere = (url: string) => ROUTES_FINANCIERES_INTERDITES.some((r) => r.test(url));

// ————————————————————————— § 27.13 postes de travail des opérateurs —————————————————————————

export interface PosteTravailDef {
  code: string;
  utilisateur: string;
  roles: RoleCode[];
  ecranEntree: string;
  liens: { libelle: string; chemin: string }[];
  indicateurDominant: string;
  /** Indicateur du catalogue (pilotage/kpis.ts) qui le mesure, si disponible. */
  kpis: string[];
}

export const POSTES_TRAVAIL: PosteTravailDef[] = [
  { code: 'DIRECTEUR_REGIE', utilisateur: 'Directeur de régie', roles: ['R06', 'R07'], ecranEntree: 'Assiette, recouvrement, contentieux, performance des agents et des centres', indicateurDominant: 'Écart à l’assignation et couverture du recensement', kpis: ['ECART_ASSIGNATION', 'COUVERTURE_RECENSEMENT'],
    liens: [{ libelle: 'Poste de travail — régie fiscale (n° 42)', chemin: '/decision/regie-fiscale' }, { libelle: 'Poste de travail — régie des taxes (n° 43)', chemin: '/decision/regie-taxes' }, { libelle: 'Assiette (recensement)', chemin: '/fiscal/recensement' }, { libelle: 'Recouvrement', chemin: '/recouvrement' }, { libelle: 'Contentieux (remises, non-valeurs)', chemin: '/recouvrement/remises' }, { libelle: 'Performance des agents', chemin: '/agents/surveillance' }, { libelle: 'Performance des centres', chemin: '/terrain/supervision' }] },
  { code: 'CHEF_CENTRE', utilisateur: 'Chef de centre communal', roles: ['R09'], ecranEntree: 'Objets non enregistrés de sa zone, missions du jour, régularisations', indicateurDominant: 'Progression de la couverture', kpis: ['COUVERTURE_RECENSEMENT', 'TAUX_RECENSEMENT'],
    liens: [{ libelle: 'Supervision terrain', chemin: '/terrain/supervision' }, { libelle: 'Vagues de recensement', chemin: '/fiscal/recensement' }, { libelle: 'Autour de moi', chemin: '/autour-de-moi' }] },
  { code: 'TRESORERIE', utilisateur: 'Trésorerie et comptabilité publique', roles: ['R17', 'R18', 'R19'], ecranEntree: 'Encaissements, règlements, files d’exception, clôture', indicateurDominant: 'Écart de rapprochement et ancienneté des exceptions', kpis: ['ECART_RAPPROCHEMENT_J2', 'EXCEPTIONS_ANCIENNES'],
    liens: [{ libelle: 'Trésor et rapprochement', chemin: '/tresor' }, { libelle: 'Rapprochement proposé', chemin: '/tresor/appariements' }, { libelle: 'Jours de caisse', chemin: '/canaux/jour-de-caisse' }] },
  { code: 'JURISTE', utilisateur: 'Juriste et tarificateur', roles: ['R13', 'R14', 'R15', 'R16'], ecranEntree: 'État du référentiel, règles expirant, conflits de normes', indicateurDominant: 'Règles en vigueur sans référence valide', kpis: ['REGLES_CERTIFIEES'],
    liens: [{ libelle: 'Registre juridique', chemin: '/registre' }, { libelle: 'Points juridiques', chemin: '/juridique/points' }] },
  { code: 'AUDITEUR', utilisateur: 'Auditeur et enquêteur', roles: ['R22', 'R23', 'R24'], ecranEntree: 'Échantillons, pistes, dossiers, extractions probantes', indicateurDominant: 'Délai d’instruction', kpis: [],
    liens: [{ libelle: 'Audit', chemin: '/audit' }, { libelle: 'Piste d’audit par dossier', chemin: '/pilotage/piste-audit' }, { libelle: 'Enquêtes anti-fraude', chemin: '/integrite/enquetes' }] },
  { code: 'AGENT_TERRAIN', utilisateur: 'Agent de terrain', roles: ['R10', 'R11', 'R35'], ecranEntree: 'Mission du jour, itinéraire, objets assignés', indicateurDominant: 'Constats confirmés par une quittance payée', kpis: ['RENDEMENT_CONTROLE'],
    liens: [{ libelle: 'Terrain', chemin: '/terrain' }, { libelle: 'Contrôle des titres', chemin: '/titres/controle' }] },
  { code: 'CONTRIBUABLE', utilisateur: 'Contribuable', roles: ['R30', 'R31'], ecranEntree: 'Ses objets, ses obligations, ses quittances, ses recours', indicateurDominant: 'Situation personnelle', kpis: [],
    liens: [{ libelle: 'Mon espace', chemin: '/espace' }, { libelle: 'Mes arriérés', chemin: '/mes-arrieres' }] },
  { code: 'ADMINISTRATEUR', utilisateur: 'Administrateur de la plateforme', roles: ['R26', 'R27', 'R28'], ecranEntree: 'Disponibilité, intégrations, versions, sécurité', indicateurDominant: 'Incidents ouverts', kpis: ['DISPONIBILITE'],
    liens: [{ libelle: 'Incidents de sécurité', chemin: '/integrite/incidents' }, { libelle: 'Prestataires connectés', chemin: '/tresor/prestataires' }, { libelle: 'Surveillance technique', chemin: '/integrite/surveillance-technique' }] },
];
export const DEUX_FAMILLES_SEPAREES = 'Un même utilisateur peut disposer des deux familles d’interfaces : un directeur de régie tient une file de travail pour son activité quotidienne et une corbeille de décision pour ce qui relève de sa signature. Les deux restent séparées à l’écran, afin que l’urgence de production ne noie jamais la décision qui engage.';

// ————————————————————————— rangs, remontée, délégation (présentation) —————————————————————————

/** Rôles tenant un poste de décision (§ 27 : autorités ; § 27.13 : un directeur de régie tient les deux familles). */
export const ROLES_POSTE_DECISION: RoleCode[] = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07'];

/**
 * Ordre de remontée d'un élément au-delà des seuils (régie → ministre des Finances → Gouverneur) : de chaque rôle
 * décideur vers l'autorité supérieure. PAR_DEFAUT — à confirmer par le maître d'ouvrage.
 */
export const PARENT_REMONTEE: Partial<Record<RoleCode, RoleCode>> = {
  R07: 'R06', R06: 'R05', R05: 'R01', R04: 'R01', R03: 'R01', R02: 'R01', R16: 'R05', R17: 'R05', R15: 'R05', R14: 'R05', R13: 'R05',
  R21: 'R05', R20: 'R06', R19: 'R01', R11: 'R07', R09: 'R06', R12: 'R07', R08: 'R06', R28: 'R02', R25: 'R02', R26: 'R02', R27: 'R02', R29: 'R28', R22: 'R01', R24: 'R01',
};

/** Rang hiérarchique (1 = le plus élevé) pour la délégation « à une personne de rang inférieur ». PAR_DEFAUT. */
export const RANG_AUTORITE: Partial<Record<RoleCode, number>> = {
  R01: 1, R02: 2, R03: 2, R04: 3, R05: 3, R06: 4, R16: 4, R17: 4, R21: 4, R22: 4, R07: 5, R19: 5, R14: 5, R15: 5, R20: 5, R24: 5, R28: 5,
  R13: 6, R08: 6, R09: 6, R11: 6, R12: 7, R10: 8,
};
export const rangDe = (roles: readonly string[]): number => Math.min(...roles.map((r) => RANG_AUTORITE[r as RoleCode] ?? 9));

/** Rôles des agents publics (délégation possible à un agent public seulement ; jamais à un compte partagé). */
export const estAgentPublic = (roles: readonly string[]) => roles.some((r) => /^R(0[1-9]|1\d|2\d)$/.test(r));

// ————————————————————————— utilitaires temps (Kinshasa) —————————————————————————

const DAY = 86_400_000;
export const ajouterJours = (jour: string, n: number): string => new Date(Date.parse(`${jour}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const joursEntre = (a: string, b: string): number => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY);

/** Semaine de Kinshasa (lundi → dimanche) contenant le jour donné. */
export function semaineKinshasa(jour: string): { lundi: string; dimanche: string; code: string } {
  const d = new Date(`${jour}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lundi
  const lundi = ajouterJours(jour, -dow);
  // Numéro de semaine ISO 8601.
  const t = new Date(`${lundi}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { lundi, dimanche: ajouterJours(lundi, 6), code: `${t.getUTCFullYear()}-S${String(week).padStart(2, '0')}` };
}

/** Tranche d'un montant individuel (jamais le montant exact sur un écran d'accueil, § 27.12). */
export function trancheMontant(cdf: bigint, seuilCdf: number): string {
  if (seuilCdf > 0 && cdf >= BigInt(Math.trunc(seuilCdf))) return `au-delà du seuil de délégation (${seuilCdf.toLocaleString('fr-FR')} CDF, ${PAR_DEFAUT})`;
  return 'en deçà du seuil de délégation';
}

export const isMoney = (v: unknown): v is MoneyJSON =>
  !!v && typeof v === 'object' && typeof (v as MoneyJSON).amount === 'string' && typeof (v as MoneyJSON).currency === 'string';
