/**
 * Catalogue des points juridiques à trancher avant la production : J1 à J16 (document maître, § 6.13), J17 à J30
 * (annexe H.3.2), rattachés aux sept questions du § 6.4 du Cahier et aux 29 points de son annexe B. Textes repris
 * des sources ; aucune hypothèse n'est inventée. Le statut (OUVERT / TRANCHÉ) vit dans le service, pas ici.
 */

export interface PointJuridique {
  code: string;
  question: string;
  autorite: string;
  /** Hypothèse intérimaire sûre appliquée tant que le point n'est pas tranché. */
  hypothese: string;
  /** Verrou technique (effet dans la plateforme tant que le point est ouvert). */
  verrou: string;
  /** Données ou actes requis pour trancher (J1–J16). */
  donnees?: string;
  source: 'Document maître § 6.13' | 'Annexe H.3.2' | 'Document maître FR 2, annexe B';
}

export const POINTS_JURIDIQUES: PointJuridique[] = [
  { code: 'J1', question: 'Texte intégral et consolidé de l’OL 18/004 ; liste et clés de répartition ; ratification', autorite: 'Service juridique provincial + ministère provincial des Finances', donnees: 'JO du 23 avril 2018, lois de ratification, modifications', hypothese: 'Seules les trois recettes nommées par l’art. 204 pt 16 sont modélisées en priorité', verrou: 'Aucune règle INTERET_COMMUN ou PARTAGEE activable sans clé certifiée', source: 'Document maître § 6.13' },
  { code: 'J2', question: 'Objet réel de la « Loi n° 18/014 du 9 juillet 2018 »', autorite: 'Service juridique provincial', donnees: 'Journal officiel', hypothese: 'Référence non citée', verrou: 'Instrument au statut A_VERIFIER', source: 'Document maître § 6.13' },
  { code: 'J3', question: 'Arrêtés et édit fixant les taux 2026 (IRL, IF, véhicules)', autorite: 'Ministère provincial des Finances', donnees: 'Textes signés et publiés', hypothese: 'Taux de presse enregistrés en A_VERIFIER', verrou: 'Pas d’obligation émise', source: 'Document maître § 6.13' },
  { code: 'J4', question: 'Contenu et mise à jour de l’Édit n° 005/2021 (procédure)', autorite: 'Service juridique provincial', donnees: 'Texte, amendements', hypothese: 'Aucune pénalité automatique ; notification papier doublée', verrou: 'Règles de pénalités désactivées', source: 'Document maître § 6.13' },
  { code: 'J5', question: 'Arrêtés de création de la DGIPK et de la DGTK ; transfert des compétences et des comptes', autorite: 'Cabinet du Gouverneur, Finances', donnees: 'Arrêtés, décisions de transfert', hypothese: 'Administration paramétrable par règle', verrou: 'Pas de règle sans entité administratrice valide', source: 'Document maître § 6.13' },
  { code: 'J6', question: 'Acte instituant le quitus fiscal et liste des démarches conditionnées', autorite: 'Finances, services concernés', donnees: 'Acte', hypothese: 'Quitus informatif uniquement', verrou: 'Aucun blocage de service sans règle de conditionnalité certifiée', source: 'Document maître § 6.13' },
  { code: 'J7', question: 'Valeur probante de la quittance et de la notification électroniques', autorite: 'Services juridiques ; autorité intérimaire du numérique', donnees: 'Code du numérique et textes d’application', hypothese: 'Double preuve (électronique + imprimable signée)', verrou: '—', source: 'Document maître § 6.13' },
  { code: 'J8', question: 'Formalités de protection des données et analyse d’impact', autorite: 'Délégué à la protection des données du programme', donnees: 'Registre des traitements', hypothese: 'Minimisation maximale ; pas de partage de données partenaires sans protocole', verrou: 'Connecteurs partenaires désactivés sans protocole signé', source: 'Document maître § 6.13' },
  { code: 'J9', question: 'Habilitation BCC des prestataires de paiement et besoin d’agrément d’agrégation', autorite: 'Finances + BCC', donnees: 'Agréments', hypothese: 'Seuls des prestataires déjà agréés, sous contrat avec la Province', verrou: 'Connecteur de canal non activable sans preuve d’agrément', source: 'Document maître § 6.13' },
  { code: 'J10', question: 'Régime des incitations des agents (primes, quotes-parts)', autorite: 'Finances, Fonction publique provinciale', donnees: 'LOFIP, édit, arrêté', hypothese: 'Aucune prime calculée par la plateforme', verrou: 'Module de performance en mode « indicateurs » seulement', source: 'Document maître § 6.13' },
  { code: 'J11', question: 'Régime juridique de la rémunération du prestataire (marché, PPP, pourcentage)', autorite: 'Finances, ARMP/DGCMP, UC-PPP', donnees: 'Loi 10/010, Loi 18/016, LOFIP', hypothese: 'Rémunération contractuelle payée sur crédit budgétaire (ch. 37)', verrou: 'Aucun flux de décaissement automatique vers un compte privé', source: 'Document maître § 6.13' },
  { code: 'J12', question: 'Assujettissement de la plateforme aux régimes de déclaration ou d’autorisation des services numériques (2026)', autorite: 'Ministère de l’Économie numérique', donnees: 'Arrêtés du 11 mars 2026', hypothese: 'Déclaration préventive', verrou: '—', source: 'Document maître § 6.13' },
  { code: 'J13', question: 'Conditions de partage de données avec les distributeurs d’énergie, d’eau, les opérateurs télécoms, les brasseries, les employeurs', autorite: 'Juridique + autorité de protection des données', donnees: 'Protocoles', hypothese: 'Aucun échange de données personnelles sans protocole', verrou: 'Connecteurs désactivés', source: 'Document maître § 6.13' },
  { code: 'J14', question: 'Base légale des échéanciers et de la régularisation volontaire (abandon de pénalités)', autorite: 'Finances / Assemblée provinciale', donnees: 'Texte', hypothese: 'Modules 83 et 90 désactivés', verrou: '—', source: 'Document maître § 6.13' },
  { code: 'J15', question: 'Compétence provinciale pour une contribution plastique ou une REP (art. 174 Constitution, nomenclature, Décret 17/018)', autorite: 'Juridique + Environnement + pouvoir central', donnees: 'Analyse', hypothese: 'Aucune activation', verrou: 'Catégorie ACTE_REQUIS', source: 'Document maître § 6.13' },
  { code: 'J16', question: 'Portée d’une décision de la Cour constitutionnelle de 2024 sur la création d’impôts provinciaux hors nomenclature, rapportée par la presse', autorite: 'Service juridique', donnees: 'Arrêt', hypothese: 'Aucune recette nouvelle hors nomenclature', verrou: 'Catégorie ACTE_REQUIS', source: 'Document maître § 6.13' },
  { code: 'J17', question: 'Délai maximal entre quittance provisoire et quittance définitive ; effet d’un règlement non constaté', autorite: 'Services juridiques ; Trésor', hypothese: 'Délai de conception : J+2 ouvrés, puis exception « règlement manquant » ; le contribuable de bonne foi n’est jamais privé de ses droits (§ 18.6)', verrou: 'Tant que le délai n’est pas certifié, la quittance provisoire porte la mention « en attente de règlement » sans date d’échéance', source: 'Annexe H.3.2' },
  { code: 'J18', question: 'Valeur du consentement par empreinte, enregistrement vocal ou témoin ; régime de la donnée biométrique', autorite: 'Services juridiques ; autorité (intérimaire) de protection des données', hypothese: 'Consentement par enregistrement vocal ou témoin identifié ; empreinte seulement comme marque de consentement, jamais comme identifiant de recherche', verrou: 'Capture d’empreinte désactivée tant que J18 n’est pas certifié', source: 'Annexe H.3.2' },
  { code: 'J19', question: 'Délégation de missions de recensement, d’enrôlement et de constat à des sous-traitants privés ; obligations de protection des données', autorite: 'Services juridiques ; Fonction publique ; régies', hypothese: 'Les sous-traitants observent et documentent ; tout acte opposable est validé et signé par un agent public habilité', verrou: 'Rôle « agent sous-traitant » sans permission de signature d’acte ; convention de sous-traitance de données avant activation du lot', source: 'Annexe H.3.2' },
  { code: 'J20', question: 'Encaissement pour compte de la Ville par des agents de monnaie mobile et des guichets bancaires ; régime de la commission', autorite: 'Finances ; BCC ; Trésor', hypothese: 'Seuls des établissements régulés, sous convention, encaissent ; la commission n’est jamais déduite du montant dû (§ 20.1)', verrou: 'Point de paiement non activable sans convention signée et agrément vérifié', source: 'Annexe H.3.2' },
  { code: 'J21', question: 'Valeur juridique des titres dématérialisés (ticket, vignette, droit d’étal, pass) ; acte par module', autorite: 'Services juridiques ; entité responsable du module', hypothese: 'Titre dématérialisé doublé d’une preuve imprimable ou SMS vérifiable', verrou: 'Type de titre non activable sans référence d’acte dans la fiche de configuration du module', source: 'Annexe H.3.2' },
  { code: 'J22', question: 'Compétences province / communes / opérateurs délégués pour les services partagés ; opposabilité de l’arbitrage', autorite: 'Services juridiques ; Comité juridique et tarifaire', hypothese: 'Une seule revendication par fait générateur ; la seconde est bloquée et arbitrée (§ 10.3)', verrou: 'Blocage automatique de la seconde obligation ; aucune exposition au citoyen', source: 'Annexe H.3.2' },
  { code: 'J23', question: 'Mesures AVIA ; compétences respectives de la Ville, de la RVA, de la DGM et de l’aviation civile', autorite: 'Gouvernement provincial ; autorités aéroportuaires et migratoires', hypothese: 'Rapprochement informatif ; aucune mesure contraignante', verrou: 'Mesures non paramétrables sans arrêté certifié', source: 'Annexe H.3.2' },
  { code: 'J24', question: 'Zonage et tarifs du stationnement ; surréservation ; fourrière ; affectation des recettes', autorite: 'Ministère provincial des Transports ; Finances ; juridique', hypothese: 'Stationnement payant uniquement dans les zones délimitées par acte ; surréservation désactivée ; affectation = engagement de programmation publié', verrou: 'Règles ACTE_REQUIS ; option de surréservation non activable', source: 'Annexe H.3.2' },
  { code: 'J25', question: 'Vendeurs d’opérateurs délégués comme points agréés ; base légale de la taxe journalière des transports', autorite: 'Finances ; BCC ; Transports', hypothese: 'Vente en espèces uniquement par points agréés régulés ; taxe journalière non liquidée avant certification', verrou: 'Canal « vendeur délégué » désactivé sans agrément ; règle ACTE_REQUIS', source: 'Annexe H.3.2' },
  { code: 'J26', question: 'Texte CALCU : déclaration obligatoire des comptes publics, transmission bancaire, valeur de la preuve numérique, responsabilité des gestionnaires, secret bancaire', autorite: 'Gouvernement provincial ; ministère national des Finances ; BCC', hypothese: 'Déclaration volontaire des entités pilotes ; aucune transmission bancaire sans convention', verrou: 'Connecteurs bancaires CALCU désactivés sans texte et convention', source: 'Annexe H.3.2' },
  { code: 'J27', question: 'Acte NFIU : immatriculation fiscale obligatoire, reconnaissance du QR, interdiction de mise en bail d’un bien non immatriculé', autorite: 'Assemblée provinciale ou Gouvernement provincial', hypothese: 'Plaque posée à titre d’identification administrative, sans effet restrictif', verrou: 'Aucune restriction de location appliquée par le système', source: 'Annexe H.3.2' },
  { code: 'J28', question: 'Pass wewa : base légale, redevable, tarif, articulation avec vignette, autorisation de transport et prélèvements communaux, gilets et autocollants, coopératives, pouvoirs de contrôle', autorite: 'Ministère provincial des Transports ; Finances ; communes', hypothese: 'Enregistrement gratuit des motos et conducteurs (recensement) ; aucun pass payant ni contrôle avant acte', verrou: 'Règle du pass ACTE_REQUIS ; période de grâce paramétrable', source: 'Annexe H.3.2' },
  { code: 'J29', question: 'Financement des moyens physiques ; prise en charge des frais d’USSD, de SVI et de SMS « gratuits pour l’appelant »', autorite: 'Gouvernement provincial ; opérateurs ; partenaires', hypothese: 'Conventions avec les opérateurs financées sur le budget du programme', verrou: 'Canal gratuit non annoncé au public tant que la convention n’est pas signée', source: 'Annexe H.3.2' },
  { code: 'J30', question: 'Base légale et cadrage sectoriel des verticales ports et fluvial', autorite: 'Transports ; autorités portuaires ; régies', hypothese: 'Recensement des embarcations et quais sans liquidation', verrou: 'Modules 13 et 24 non activables avant certification', source: 'Annexe H.3.2' },
  // Document maître FR 2 (27/09/2026), annexe B, points 9 à 13 : questions nouvelles (textes cités mot pour mot). Autorité,
  // hypothèse et verrou : PAR_DEFAUT — à confirmer par le maître d'ouvrage (mêmes verrous prudents que J1–J30).
  { code: 'J31', question: 'Texte de création et statuts de la RFCK, et articulation précise de ses compétences avec celles de la régie fiscale provinciale et du service des transports', autorite: 'Service juridique provincial ; ministère provincial des Transports [PAR_DEFAUT — à confirmer]', hypothese: 'Aucune compétence propre de la RFCK n’est présumée ; une seule revendication par fait générateur (§ 10.3)', verrou: 'Aucune règle administrée par la RFCK activable sans texte certifié (instrument au statut A_VERIFIER)', source: 'Document maître FR 2, annexe B' },
  { code: 'J32', question: 'Arrêté ministériel du 12 novembre 2025 : texte intégral, périodicité du contrôle technique, tarifs applicables et procédure encadrant l’immobilisation puis la disposition des véhicules non conformes', autorite: 'Ministère provincial des Transports ; service juridique provincial [PAR_DEFAUT — à confirmer]', hypothese: 'Aucune périodicité ni aucun tarif paramétré ; aucune immobilisation ni disposition automatique', verrou: 'Types de titres correspondants non activables sans référence d’acte certifiée (J21) ; toute mesure décidée par une personne', source: 'Document maître FR 2, annexe B' },
  { code: 'J33', question: 'Base légale et barèmes des redevances d’enlèvement et de gardiennage en fourrière, et régime des recettes non fiscales correspondantes', autorite: 'Ministère provincial des Transports ; Finances ; juridique [PAR_DEFAUT — à confirmer]', hypothese: 'Aucune redevance de fourrière liquidée avant certification (voir aussi J24)', verrou: 'Règles de fourrière ACTE_REQUIS', source: 'Document maître FR 2, annexe B' },
  { code: 'J34', question: 'Nom de domaine officiel de la Ville Province destiné aux services publics de vérification, et titularité de son enregistrement et de son certificat', autorite: 'Gouvernement provincial ; autorité du numérique [PAR_DEFAUT — à confirmer]', hypothese: 'Les liens de vérification sont servis par la plateforme ; aucun domaine officiel n’est présumé', verrou: '—', source: 'Document maître FR 2, annexe B' },
  { code: 'J35', question: 'Valeur probante de la vignette électronique et de la vérification en ligne, au regard du Code du numérique et des textes régissant le contrôle technique', autorite: 'Services juridiques ; autorité (intérimaire) du numérique [PAR_DEFAUT — à confirmer]', hypothese: 'Double preuve : titre électronique vérifiable et preuve imprimable (comme J7 et J21)', verrou: 'Vérification affichée comme informative tant que le point n’est pas tranché', source: 'Document maître FR 2, annexe B' },
];

/** Les sept points juridiques du § 6.4 du Cahier (question, autorité, effet si non tranchée) et leur rattachement. */
export const SEPT_QUESTIONS_6_4: { rang: number; question: string; autorite: string; effet: string; points: string[] }[] = [
  { rang: 1, question: 'Statut consolidé des textes fiscaux provinciaux après 18/004', autorite: 'Service juridique provincial', effet: 'Risque d’appuyer une liquidation sur un texte abrogé', points: ['J1'] },
  { rang: 2, question: 'Taux IRL applicables et retenue par rang de localité', autorite: 'Ministère provincial des Finances', effet: 'Liquidations erronées et contentieux de masse', points: ['J3'] },
  { rang: 3, question: 'Valeur juridique de la quittance électronique et de la signature', autorite: 'Services juridiques et Code du numérique', effet: 'Contestation de la preuve de paiement', points: ['J7', 'J17'] },
  { rang: 4, question: 'Base légale des échéanciers de paiement par Mobile Money', autorite: 'Assemblée provinciale ou arrêté', effet: 'Impossible de proposer le paiement fractionné', points: ['J14'] },
  { rang: 5, question: 'Conditions de partage de données avec les distributeurs d’énergie, d’eau et les opérateurs', autorite: 'Autorité de protection des données et services juridiques', effet: 'Blocage du moteur de recoupement', points: ['J13'] },
  { rang: 6, question: 'Régime des incitations de performance des agents', autorite: 'LOFIP, édit, arrêté', effet: 'Risque de rémunération irrégulière sur recettes publiques', points: ['J10'] },
  { rang: 7, question: 'Habilitation des agrégateurs de paiement', autorite: 'Banque Centrale du Congo', effet: 'Irrégularité du circuit d’encaissement', points: ['J9'] },
];

/** Les 29 points de l'annexe B du Cahier et leur rattachement (annexe H.3.2). */
export const ANNEXE_B_29: { point: number; objet: string; points: string[]; note?: string }[] = [
  { point: 1, objet: 'Texte consolidé de la nomenclature provinciale et des ordonnances-lois de 1969 après modifications', points: ['J1'] },
  { point: 2, objet: 'Objet exact et statut de la Loi n° 18/014 du 9 juillet 2018', points: ['J2'] },
  { point: 3, objet: 'Arrêtés provinciaux fixant les taux de l’IF, de l’IRL et de la taxe sur les véhicules pour l’exercice en cours', points: ['J3'] },
  { point: 4, objet: 'Texte intégral de l’édit budgétaire en vigueur de la Ville de Kinshasa', points: ['J3'] },
  { point: 5, objet: 'Code du numérique : résidence des données, signature électronique, protection des données personnelles', points: ['J7', 'J8'], note: 'Voir aussi § 33 (hébergement).' },
  { point: 6, objet: 'Habilitation des agrégateurs et prestataires de paiement auprès de la BCC', points: ['J9'] },
  { point: 7, objet: 'Textes créant la DGRFK et la DGTK, et répartition définitive des compétences', points: ['J5'] },
  { point: 8, objet: 'Régime légal des primes de performance des agents publics sur recettes fiscales', points: ['J10'] },
  { point: 9, objet: 'Valeur juridique de la quittance « en attente de règlement » et délai maximal avant bascule (§ 18.6)', points: ['J7', 'J17'] },
  { point: 10, objet: 'Base légale des verticales ports et fluvial et MOSOLO AVIA', points: ['J30', 'J23'] },
  { point: 11, objet: 'Rémunération du prestataire indexée sur les recettes additionnelles nettes (§ 37)', points: ['J11'] },
  { point: 12, objet: 'Valeur du consentement par empreinte, voix ou témoin ; régime de capture de l’empreinte (§ 13A.3)', points: ['J18'] },
  { point: 13, objet: 'Délégation à des sous-traitants privés du recensement, de l’enrôlement et des constats (§ 15A)', points: ['J19'] },
  { point: 14, objet: 'Encaissement pour compte de la Ville par agents Mobile Money et guichets bancaires ; commission (§ 18A.2, § 37)', points: ['J9', 'J20'] },
  { point: 15, objet: 'Obligations des sous-traitants au titre de la protection des données', points: ['J8', 'J19'] },
  { point: 16, objet: 'Valeur juridique des titres dématérialisés et acte réglementaire par module (§ 19A)', points: ['J21'] },
  { point: 17, objet: 'Compétences province / communes / opérateurs délégués pour les services partagés ; arbitrage opposable (§ 10A.3)', points: ['J22'] },
  { point: 18, objet: 'Acte instituant la clé de répartition 10/10/10/70 et compatibilité avec la LOFIP (§ 37A)', points: ['J11'], note: 'Clé du § 37A enregistrée au statut ACTE_REQUIS (simulation seulement) ; activation par son propre circuit sur acte.' },
  { point: 19, objet: 'Application ou exclusion de la clé aux parts ETD et du pouvoir central (§ 37A.3)', points: ['J1'], note: 'Seules les clés légales sont paramétrées.' },
  { point: 20, objet: 'Régime d’un contrat de 30 ans rémunéré par une part des recettes', points: ['J11'] },
  { point: 21, objet: 'Convention tripartite de règlement ; traitement fiscal des sommes versées', points: ['J11', 'J10'] },
  { point: 22, objet: 'Financement des moyens physiques ; frais USSD, SVI et SMS (§ 37A.1)', points: ['J29'] },
  { point: 23, objet: 'Mesures KIN-AVIA FISCUS ; compétences Ville, RVA, DGM, aviation civile (§ 11C.4)', points: ['J23'] },
  { point: 24, objet: 'Clé de répartition spécifique à la verticale AVIA (§ 11C.6)', points: ['J11'] },
  { point: 25, objet: 'Affectation des recettes de stationnement ; zones payantes ; surréservation ; fourrière (§ 11A)', points: ['J24'] },
  { point: 26, objet: 'Vendeur d’opérateur délégué comme point agréé ; base légale de la taxe journalière des transports (§ 11D.4)', points: ['J25'] },
  { point: 27, objet: 'Texte CALCU : déclaration obligatoire des comptes, transmission bancaire, preuve, responsabilité, secret bancaire (§ 27A)', points: ['J26'] },
  { point: 28, objet: 'Acte NFIU : immatriculation obligatoire, interdiction de mise en bail d’un bien non immatriculé (§ 16.7)', points: ['J27'] },
  { point: 29, objet: 'Pass wewa : base légale, redevable, tarif, articulation, supports, coopératives, contrôle (§ 11D.8)', points: ['J28'] },
];

/**
 * Fonctions conditionnées par un point juridique : rien n'est désactivé par ce registre ; chaque écran affiche ce
 * qu'il attend (ex. « paiement en attente de base légale »). Les verrous existants des modules restent en place.
 */
export const FONCTIONS_CONDITIONNEES = {
  ECHEANCIERS_MOBILE_MONEY: { label: 'Échéanciers de paiement par monnaie mobile (Mobile Money)', points: ['J14'], attente: 'Paiement fractionné en attente de base légale' },
  COMMISSIONS_VERSEMENT: { label: 'Versement des commissions des agents', points: ['J10'], attente: 'Paiement en attente de base légale' },
  AGREGATEURS_ACTIVATION: { label: 'Activation des agrégateurs et prestataires de paiement', points: ['J9', 'J20'], attente: 'Activation en production en attente d’habilitation BCC' },
  QUITTANCE_ELECTRONIQUE: { label: 'Valeur juridique de la quittance électronique', points: ['J7', 'J17'], attente: 'Valeur juridique de la quittance électronique en attente de confirmation : double preuve (électronique et imprimable signée)' },
  RECOUPEMENT_DONNEES: { label: 'Recoupement avec les données des partenaires (énergie, eau, opérateurs)', points: ['J13', 'J8'], attente: 'Ingestion de données partenaires en attente de protocole et de base légale' },
} as const;
export type FonctionConditionnee = keyof typeof FONCTIONS_CONDITIONNEES;

/**
 * Document maître FR 2 (27/09/2026), annexe B — treize points à vérifier avant mise en production, cités mot pour mot
 * et rattachés aux points juridiques (1 à 8 : déjà couverts par J1–J10 ; 9 à 13 : J31 à J35, ajoutés).
 */
export const ANNEXE_B_FR2: { point: number; objet: string; points: string[]; note?: string }[] = [
  { point: 1, objet: 'Texte consolidé de la nomenclature provinciale et des ordonnances-lois de 1969 après modifications.', points: ['J1'] },
  { point: 2, objet: 'Objet exact et statut de la Loi n° 18/014 du 9 juillet 2018, non confirmés à ce stade.', points: ['J2'] },
  { point: 3, objet: 'Arrêtés provinciaux fixant les taux de l’impôt foncier, de l’impôt sur les revenus locatifs et de la taxe sur les véhicules pour l’exercice en cours.', points: ['J3'] },
  { point: 4, objet: 'Texte intégral de l’édit budgétaire en vigueur de la Ville de Kinshasa.', points: ['J3'] },
  { point: 5, objet: 'Dispositions du Code du numérique sur la résidence des données, la signature électronique et la protection des données personnelles.', points: ['J7', 'J8'] },
  { point: 6, objet: 'Conditions d’habilitation des agrégateurs et prestataires de paiement auprès de la Banque Centrale du Congo.', points: ['J9'] },
  { point: 7, objet: 'Textes créant la DGRFK et la DGTK, et répartition définitive des compétences.', points: ['J5'], note: 'J5 cite la DGIPK : dénomination à harmoniser selon les textes (DGRFK / DGIPK).' },
  { point: 8, objet: 'Régime légal des primes de performance des agents publics sur recettes fiscales.', points: ['J10'] },
  { point: 9, objet: 'Texte de création et statuts de la RFCK, et articulation précise de ses compétences avec celles de la régie fiscale provinciale et du service des transports.', points: ['J31'] },
  { point: 10, objet: 'Arrêté ministériel du 12 novembre 2025 : texte intégral, périodicité du contrôle technique, tarifs applicables et procédure encadrant l’immobilisation puis la disposition des véhicules non conformes.', points: ['J32'] },
  { point: 11, objet: 'Base légale et barèmes des redevances d’enlèvement et de gardiennage en fourrière, et régime des recettes non fiscales correspondantes.', points: ['J33', 'J24'] },
  { point: 12, objet: 'Nom de domaine officiel de la Ville Province destiné aux services publics de vérification, et titularité de son enregistrement et de son certificat.', points: ['J34'] },
  { point: 13, objet: 'Valeur probante de la vignette électronique et de la vérification en ligne, au regard du Code du numérique et des textes régissant le contrôle technique.', points: ['J35', 'J21', 'J7'] },
];

/**
 * Document maître FR 2, annexe A — sources consultées et niveau de fiabilité (cités mot pour mot). Rattachement aux
 * instruments du registre des textes et aux points juridiques : une source n'active jamais rien par elle-même.
 */
export const SOURCES_ANNEXE_A: { rang: number; source: string; usage: string; fiabilite: string; instruments: string[]; points: string[] }[] = [
  { rang: 1, source: 'Ordonnance-loi n° 18/004 du 13 mars 2018 (bases documentaires juridiques internationales)', usage: 'Nomenclature provinciale en vigueur, abrogation de l’Ordonnance-loi n° 13/001', fiabilite: 'Élevée, à confirmer sur le Journal officiel', instruments: ['ol-18-004', 'ol-13-001'], points: ['J1'] },
  { rang: 2, source: 'Ordonnance-loi n° 18/003 du 13 mars 2018', usage: 'Nomenclature du pouvoir central, exclusion des doublons', fiabilite: 'Élevée', instruments: ['ol-18-003'], points: [] },
  { rang: 3, source: 'Restitution de l’évaluation TADAT de la DGRK, septembre 2025', usage: 'Diagnostic des faiblesses administratives', fiabilite: 'Élevée, presse spécialisée', instruments: [], points: [] },
  { rang: 4, source: 'Communiqués et campagnes fiscales de la Ville, janvier à mars 2026', usage: 'Taux IF et IRL, retenues par rang, échéances, quitus fiscal, télédéclaration', fiabilite: 'Moyenne à élevée, à confirmer par les arrêtés', instruments: ['arrete-taux-irl-2026', 'arrete-taux-if-2026'], points: ['J3', 'J6'] },
  { rang: 5, source: 'Matinée fiscale FEC–DGRK, mars 2026', usage: 'Innovations de l’édit budgétaire 2026', fiabilite: 'Moyenne, à confirmer par le texte de l’édit', instruments: ['edit-budgetaire-kinshasa'], points: ['J3'] },
  { rang: 6, source: 'Atelier du 14 mai 2026 sur la création de la DGRFK et de la DGTK', usage: 'Réforme institutionnelle en cours', fiabilite: 'Moyenne, presse partiellement générée automatiquement, à confirmer par les textes', instruments: [], points: ['J5'] },
  { rang: 7, source: 'Contrat de performance de la DGRK et recettes IF/IRL de janvier 2026', usage: 'Ordre de grandeur des assignations et du réalisé', fiabilite: 'Moyenne, presse', instruments: [], points: [] },
  { rang: 8, source: 'Taux budgétaire moyen 2025 (2 859,2 CDF par dollar)', usage: 'Conversions indicatives', fiabilite: 'Moyenne à élevée', instruments: [], points: [] },
  { rang: 9, source: 'Note de projet KIN-RECETTES transmise le 22 septembre 2026', usage: 'Concept initial, exemples d’interfaces, chaîne opératoire', fiabilite: 'Document de travail interne', instruments: [], points: [] },
  { rang: 10, source: 'Communiqués de la RFCK et couverture de presse, mars à septembre 2026', usage: 'Mandat de la régie, arrêté du 12 novembre 2025, vignette à code QR, phases de contrôle, réseau des centres agréés', fiabilite: 'Moyenne : communiqués et presse ; à confirmer par les textes', instruments: [], points: ['J31', 'J32', 'J35'] },
  { rang: 11, source: 'Site institutionnel de la RFCK', usage: 'Siège, contacts, profil du Directeur général, missions déclarées, vérification de plaque en ligne, compteurs publiés', fiabilite: 'Source institutionnelle, sans valeur juridique propre ; pages inachevées et compteurs à confirmer par la régie', instruments: [], points: ['J31', 'J35'] },
];
