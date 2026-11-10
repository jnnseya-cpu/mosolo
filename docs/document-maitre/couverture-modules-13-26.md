# Matrice de couverture — Spécification fonctionnelle, modules 13 à 26 (lignes 771–1042)

Légende : BUILT = existait et est testé ; BUILT-NOW = construit ou complété dans ce lot ; ADAPTER = adaptateur (sandbox + interface + test + étiquette « À RACCORDER — convention requise »).
Abréviations : `fiches.ts` = backend/src/plugins/verticales/fiches.ts ; `FS` = backend/test/fiches-sectorielles.test.ts ; `S14` = backend/test/stationnement-14.test.ts ; `R26` = backend/test/regles-26.test.ts ; `FFS` = frontend/test/fiches-sectorielles.test.tsx ; écran « Fiches » = /verticales/fiches (frontend/src/modules/verticales/Fiches.tsx).
Principes de la Partie I appliqués à chaque ligne : règle publiée (aucun montant sans règle ACTIVE), compte unique + objet, zéro espèce (canaux numériques seulement), audit horodaté en ajout seul, rôles/entité, séparation (proposant ≠ décideur), IA non décisionnelle, heure du serveur.

| Module | Item (court) | Implémentation (fichier / route / écran) | Test (fichier : test) | Statut |
|---|---|---|---|---|
| 13 | Points d’embarquement géoréférencés rattachés à un opérateur | fiches.ts `registerReference` ; POST/GET /v1/verticales/fiches/references ; Fiches › 13 « Registre géoréférencé » | FS : « point rattaché à un opérateur, départ… » (OPERATOR_REQUIRED puis rattachement) | BUILT-NOW |
| 13 | Titres à usage unique — QR consommé au scan (§ 19A.4) | fiches.ts `boardingScan` → titres.control (module 13) ; POST /v1/verticales/fiches/departs/:id/embarquements ; Fiches › 13 « Scanner un titre » ; type [EXEMPLE] EMB-CARTE-EX (seed.ts `seedSingleUseDemoTypes`) | FS : même test (VALIDE puis « DÉJÀ UTILISÉ », titre d’un autre départ refusé non consommé) ; FFS : « 13 : l’agent scanne… » | BUILT-NOW |
| 13 | Paiement au départ — Mobile Money ou point agréé, jamais à l’agent | fiches.ts `orderTitles` (DEPARTURE_CHANNELS, refus journalisé) ; POST …/departs/:id/titres ; Fiches › 13 « Commander les titres » | FS : CHANNEL_NOT_ALLOWED + audit `channel_refused` | BUILT-NOW |
| 13 | Manifestes (passagers ou volumes par départ) | fiches.ts `submitManifest` (capacité, historique) ; POST …/departs/:id/manifeste ; Fiches › 13 | FS : OVER_CAPACITY puis manifeste 3 passagers + volume | BUILT-NOW |
| 13 | Générer un titre par passager ou par départ | fiches.ts `orderTitles` (PAR_PASSAGER / PAR_DEPART) | FS : 3 titres pour 3 passagers (3000 CDF [EXEMPLE]) | BUILT-NOW |
| 13 | Consommer au premier scan valide, « DÉJÀ UTILISÉ » ensuite | titres/service.ts `recordControl` + fiches.ts `boardingScan` | FS ; FFS | BUILT-NOW |
| 13 | Rapprocher manifestes, titres et paiements | fiches.ts `reconcileDeparture` ; GET …/departs/:id/rapprochement ; Fiches › 13 bouton « Rapprocher » | FS : avant paiement (anomalie « non payé ») / après (paid 3, consumed 2) | BUILT-NOW |
| 13 | Contrôle : aucun encaissement par l’agent de quai | canaux restreints + agent sans rôle d’encaissement (scan seulement) | FS (canal refusé) | BUILT-NOW |
| 13 | Données : points, départs, titres, manifestes | `SectorReference`, `Departure`, crédits du moteur de titres | FS | BUILT-NOW |
| 13 | Intégrations 24, 70, 71, 76 | embarcation (24), moteur de titres/contrôle (70/71), même moteur de titres que la billetterie RakaPay (76) | FS | BUILT-NOW |
| 13 | Indicateurs : départs tracés, titres consommés, écart manifeste/titres | fiches.ts `indicators` ; GET /v1/verticales/fiches/indicateurs ; Fiches › Indicateurs | FS (départs 1, consommés 2) ; FFS « indicateurs… non mesuré » | BUILT-NOW |
| 14 | Zones et places géoréférencées, tarifées par zone et par heure | parking/service.ts `createZone`, `setTariff` ; smart.ts grilles (heure de pointe) ; écran Régie › Zones | parking.test.ts « la régie crée une zone… » ; parksmart-11a « simulation différenciée : heure de pointe… » | BUILT |
| 14 | Sessions par application (démarrage, prolongation, fin) | parking/service.ts start/extend/end ; écran Stationnement | parking.test.ts « démarrer (idempotent)… », « prolongation, rappel ambre… » | BUILT |
| 14 | Sessions par USSD ou SMS | parking/stationnement-14.ts `handle` (STAT/PROL/FIN/ETAT, 1*…/2*…/3*…/4*…), passerelle signée POST /v1/parking/canal-texte/passerelle/:operator, simulateur POST /v1/parking/canal-texte/simulateur, statistiques ; écran Stationnement › « USSD / SMS » | S14 : « simulateur : démarrer (SMS)… », « passerelle de l’opérateur : signature v2… » ; FFS « l’usager stationne par SMS » | BUILT-NOW + ADAPTER (code court/numéro SMS opérateur) |
| 14 | Abonnements résidentiels, professionnels | smart.ts types § 19A liés à la plaque | parksmart-11a « la plaque abonnée est VERTE… » | BUILT |
| 14 | Titre lié à la plaque — aucun papier | sessions/titres par plaque ; contrôle par plaque | parking.test.ts « contrôle : résultat minimal… » | BUILT |
| 14 | Exemptions — véhicules officiels et cas prévus par la règle | stationnement-14.ts `requestExemption`/`decideExemption`/`revokeExemption`/`exemptionFor` ; service.ts `titleFor` (EXEMPTION VERT), `startSession` (PLATE_EXEMPTED) ; routes /v1/parking/exemptions* ; écran Régie › Exemptions | S14 : « véhicule officiel… », « cas prévu par la règle… » ; FFS « la régie demande une exemption… » | BUILT-NOW |
| 14 | Calculer le prix selon zone, heure et durée | smart.ts `tariffInputs` (rang de zone, pointe) + règle | parksmart-11a ; S14 « le contrôleur voit toutes les sessions… » (montant > 0, rang) | BUILT |
| 14 | Vert, ambre puis rouge sur l’heure du serveur | service.ts `sessionDerived` (readValidity) | parking.test.ts « prolongation, rappel ambre… » ; S14 (VERT → AMBRE → ROUGE) | BUILT |
| 14 | Afficher au contrôleur tous les titres actifs d’une plaque | stationnement-14.ts `activeTitles` ; `control` renvoie `activeTitles` ; GET /v1/parking/plates/:plate/active-titles ; écran Contrôle (liste) | S14 ; FFS « le contrôleur voit tous les titres actifs » | BUILT-NOW |
| 14 | Pénalité selon le barème réglementaire, contestable | service.ts decideViolation (penaltyRuleCode ACTIVE), contestViolation | parking.test.ts « vérification puis décision… pénalité selon le barème actif ; recours… » | BUILT |
| 14 | Données : ParkingZone, sessions, abonnements, titres (+ exemptions) | service.ts / stationnement-14.ts | parking.test.ts ; S14 | BUILT |
| 14 | Intégrations 70, 71, 75, 76 | moteur de titres (abonnements), ParkSmart (75) | parksmart-11a | BUILT |
| 14 | Indicateurs : occupation, rotation, recettes par place, conformité | service.ts `indicators` ; écran Tableau de bord stationnement ; synthèse dans Fiches › Indicateurs (module 14) | parking.test.ts « indicateurs agrégés : occupation, rotation… » | BUILT |
| 15 | Inventaire géolocalisé — panneau, face, surface, emplacement | publicite/service.ts declareDevice (surface calculée, faces) ; écrans Publicité | publicite.test.ts « l’annonceur déclare un dispositif… » | BUILT |
| 15 | Autorisations — demande, instruction, validité, renouvellement | service.ts instruct/decide ; complements.ts renewal ; écrans AdRegie, AdContrats | publicite.test.ts « dépôt → complément → instruction… » ; operateurs-publicite « renouvellement en ligne… » | BUILT |
| 15 | Plaque QR — sans plaque = non enregistré | public/devices/:token ; statut NON_DECLARE | publicite.test.ts (AD_PLATE_UNKNOWN) ; publicite-terrain « constat non déclaré » | BUILT |
| 15 | Liquidation par surface, face et zone | service.ts liquidation propose/approve (surface_m2, faces, rang de zone) | publicite.test.ts « …obligation liquidée par la règle… » | BUILT |
| 15 | Croiser autorisation ↔ objet ↔ obligation ↔ paiement ↔ échéance | service.ts `situation` | publicite.test.ts ; publicite-terrain « droits impayés… » | BUILT |
| 15 | Signaler les autorisations arrivant à échéance | service.ts `tick` (préavis/expiration) ; /v1/publicite/echeances | publicite.test.ts « échéances : préavis puis expiration… » | BUILT |
| 15 | Transmettre les supports suspects au module 77 pour constat | complements.ts `triageReport` (A_INSPECTER), IA propositions vérifiées ; inspections (77) | operateurs-publicite « portail citoyen… », « analyse d’image : proposition seulement » | BUILT |
| 15 | Aucune sanction sans validation de l’autorité | cases verify/decide distincts | publicite.test.ts « …la décision n’émet aucune pénalité… », « séparation vérificateur / décideur » | BUILT |
| 15 | Indicateurs : panneaux recensés, taux autorisés, recettes par m² | service.ts `indicators` ; AdDashboard ; Fiches › Indicateurs (15) | publicite.test.ts « indicateurs agrégés… recettes par m² » | BUILT |
| 16 | Registre des sites — pylône, opérateur, coordonnées, emprise | fiches.ts SECTOR_OBJECTS['16'], `registerObject`, `listObjects` ; Fiches › 16 | FS « import des listes… » | BUILT-NOW |
| 16 | Import des listes (opérateurs, régulateur) | fiches.ts `importSites` ; POST …/antennes/imports ; Fiches › 16 formulaire | FS (created/known ; régulateur réservé) | BUILT-NOW |
| 16 | Liquidation annuelle AUTOMATIQUE par site | fiches.ts `runAutomatic` (règle ACTIVE, idempotent site × exercice, avis, audit système) ; planificateur horaire par défaut (plugin.ts) ; POST/GET …/liquidations/automatique ; Fiches › Liquidations | FS : exécution = sites déclarés, 2e passage 0, avis `AVIS_IMPOSITION`, audit `auto_executed` acteur système ; FFS « liquidations : doctrine… » | BUILT-NOW |
| 16 | Proposition tant que la règle n’est pas ACTIVE | fiches.ts `propose`/`createLiquidation` (ACTE_REQUIS, sans montant) | FS (ACTE_REQUIS, run0 executed 0) | BUILT-NOW |
| 16 | Rapprochement déclarés ↔ observés ↔ paiements | fiches.ts `telecomRecovery` (+ service.ts telecomReconciliation) | FS ; verticales.test « site observé absent des listes… » | BUILT-NOW |
| 16 | Détecter un site observé absent de la liste déclarée | service.ts `telecomReconciliation` | verticales.test ; FS (observedNotDeclared ≥ 1) | BUILT |
| 16 | Générer l’avis annuel et suivre le règlement | fiches.ts `execute` (issueAssessmentNotice) ; `listLiquidations` (paymentState) | FS (noticeId, paiement PAYE, recoveryRate) | BUILT-NOW |
| 16 | Mutations de site entre opérateurs | fiches.ts propose/decideMutation ; routes …/antennes/…/mutations ; Fiches › 16 | FS « mutation de site entre opérateurs… » | BUILT-NOW |
| 16 | Suivi par la cellule grands redevables (56) | secteurs.ts largeTaxpayers ; `telecomRecovery.largeTaxpayer` | FS (largeTaxpayer SUIVI) | BUILT-NOW |
| 16 | Indicateurs : sites recensés vs déclarés ; recouvrement par opérateur | fiches.ts indicators ; telecomRecovery | FS | BUILT-NOW |
| 17 | Déclaration mensuelle des volumes | secteurs.ts `declare` (VOLUMES_BAT) ; écran Modules sectoriels | recettes-secteurs « boissons et tabac : déclaration mensuelle… » | BUILT |
| 17 | Rapprochement accises, facture normalisée, livraisons | secteurs.ts `reconcile` (ACCISES, FACTURATION) + fiches.ts `volumeCoherence` (livraisons) | recettes-secteurs ; FS « le partenaire verse les livraisons… » (LIVRAISONS_SUPERIEURES_AU_DECLARE) | BUILT-NOW |
| 17 | Carte des points de livraison | fiches.ts `recordDeliveries`, `deliveryMap` ; Fiches › 17 | FS ; FFS « 17 : … » | BUILT-NOW |
| 17 | Suivi des écarts déclarés / observés | secteurs.ts statuts ECART_A_INSTRUIRE ; fiches.ts coherence flags | recettes-secteurs ; FS | BUILT-NOW |
| 17 | Contrôler la cohérence mensuelle | fiches.ts `volumeCoherence` (mois non déclarés, variation, livraisons > déclaré) | FS | BUILT-NOW |
| 17 | Listes de points non autorisés pour le module 10 | fiches.ts `unauthorizedPoints`, `transmitToActivities` (crée des établissements OBSERVÉS au registre des activités) | FS (établissement OBSERVE, source POINT_DE_LIVRAISON_BOISSONS) ; FFS | BUILT-NOW |
| 17 | Suivre paiements et relances par redevable | fiches.ts `beverageFollowUp`, `remind` | FS (relance) | BUILT-NOW |
| 17 | Accès restreint aux données commerciales sensibles | policies.ts `beverageSensitive`, `beverageDeliveries` ; consultations journalisées | FS (terrain 403, contribuable 403) ; FFS | BUILT-NOW |
| 17 | Indicateurs : volumes déclarés, écart de rapprochement, recettes mensuelles | fiches.ts indicators (non mesuré avec raison si absent) | FS (volumesDeclares 500) | BUILT-NOW |
| 18 | Registre des assujettis | plastique.ts `registerLiable` ; POST /v1/verticales/plastique/assujettis ; Fiches › 18 | FS « registre des assujettis et étude… » | BUILT-NOW |
| 18 | Déclarations — volumes et catégories | plastique.ts `declare` (refusée tant que désactivé) | FS (MODULE_DESACTIVE puis 201) ; FFS « module désactivé » | BUILT-NOW |
| 18 | Reversements — liquidation et suivi | plastique.ts `liquidate` (autre personne, pas de double) ; paymentState | FS (2000 CDF, ALREADY_LIQUIDATED) | BUILT-NOW |
| 18 | Étude d’impact | plastique.ts `addStudyData` | FS | BUILT-NOW |
| 18 | Rester désactivé tant que la règle n’est pas publiée | plastique.ts `status`/`assertActive` | FS ; FFS | BUILT-NOW |
| 18 | Simuler l’impact avant activation | plastique.ts `simulate` (fiche brouillon/acte requis, non opposable, aucune obligation) | FS (total 39000, 0 obligation) | BUILT-NOW |
| 18 | Aucune obligation sans texte en vigueur | assertActive + règle ACTE_REQUIS jamais publiable | FS ; juridique.test « ACTE_REQUIS : jamais publiable… » | BUILT-NOW |
| 18 | Indicateurs : assujettis identifiés, simulations réalisées | plastique.ts `indicators` ; fiches indicators '18' | FS | BUILT-NOW |
| 19 | Rattachement automatique aux objets existants | fiches.ts `portfolio` (catégories configurées) ; Fiches › 19 | FS « la règle s’applique aux objets existants… » | BUILT-NOW |
| 19 | Liquidation groupée — avis unique | fiches.ts `groupedNotice` ; GET …/objets/:id/avis-unique ; Fiches › 19 | FS (≥ 2 lignes sur l’avis) | BUILT-NOW |
| 19 | Droits de voirie — chantiers et permis de bâtir | verticale Construction (liquidateObject 'construction', quitus) | verticales.test « construction : visite et quitus de chantier… » | BUILT |
| 19 | Appliquer la règle au portefeuille | fiches.ts `applyPortfolio` (décision R06/R07, idempotent) | FS (instructeur 403, 2e passage 0) | BUILT-NOW |
| 19 | Aucune double facturation d’un même fait générateur | fiches.ts `execute` (DOUBLE_BILLING), `existing` | FS (DEJA_LIQUIDE) ; FS 22 (LIQUIDATION_EXISTS) | BUILT-NOW |
| 19 | Indicateurs : recettes par objet, taux de paiement groupé | fiches.ts indicators | FS | BUILT-NOW |
| 20 | Plan géoréférencé — marchés, étals, emprises | service.ts `marketPlan` ; secteurs.ts `domainPlan` ; écrans Console, Modules sectoriels | verticales.test « demande d’emplacement… » ; recettes-secteurs « occupation permanente… plan » | BUILT |
| 20 | Droits d’occupation jour, semaine, mois | service.ts `requestStallTitle` | verticales.test « paiement du titre → … » | BUILT |
| 20 | Droits d’occupation — abonnement | fiches.ts `subscribeStall`, `runStallSubscriptions` (consentement, renouvellement idempotent) ; routes …/marches/… ; Fiches › 20 | FS « abonnement du droit d’étal… » | BUILT-NOW |
| 20 | Plaque QR de l’étal vérifiable sans téléphone | service.ts issuePlate/scanPlate ; /verifier-plaque | verticales.test « plaques NFIU… » | BUILT |
| 20 | Occupations temporaires (terrasses, chantiers, événements) | catalogue.ts DEMANDE_OCCUPATION_TEMPORAIRE (Domaine public) | recettes-secteurs « occupation permanente… » (même circuit) | BUILT |
| 20 | Émettre les titres d’occupation à durée | requestStallTitle (TITLE_DAYS) | verticales.test | BUILT |
| 20 | Contrôler par scan de la plaque de l’étal | scanPlate | verticales.test « scan agent journalisé… » | BUILT |
| 20 | Rapprocher occupations, titres et paiements | fiches.ts `marketReconciliation` ; Fiches › 20 | FS (titles ≥ 2, paidTitles 1) | BUILT-NOW |
| 20 | Aucun encaissement par le placier | paiement numérique ; SIGNALEMENT_DEMANDE_ESPECES | verticales.test « signalement de demande d’espèces… » | BUILT |
| 20 | Indicateurs : étals recensés, taux d’occupation payée, recettes par marché | fiches.ts indicators ; service.ts indicators | FS (indicateurs) ; verticales.test « indicateurs agrégés… » | BUILT-NOW |
| 21 | Demande d’autorisation en ligne avec pièces | verticales submitCase (DEMANDE_AUTORISATION_EVENEMENT) | verticales.test « événements : certificat QR… » ; FS « événement… » | BUILT |
| 21 | Déclaration de billetterie ou jauge | service.ts declareTicketing | verticales.test ; FS | BUILT |
| 21 | Certificat QR affiché sur le lieu | certificats + vérification publique | verticales.test « certificat public minimal… » | BUILT |
| 21 | Calculer la taxe sur billetterie déclarée OU contrôlée | fiches.ts `liquidateEvent` (CONTROLEE : décideur ≠ contrôleur) ; POST …/evenements/:id/liquidation ; Fiches › 21 | FS (650 × 200 = 130000 CDF, NO_CONTROL, DOUBLE_BILLING) | BUILT-NOW |
| 21 | Rapprocher déclaration et contrôle sur place | service.ts controlEvent (écart) ; fiches.ts eventsRevenue | verticales.test (contrôle de jauge) ; FS (gap 250) | BUILT |
| 21 | Autorisation refusée sans enregistrement préalable | submitCase TAXPAYER_REQUIRED (compte unique) | FS (TAXPAYER_REQUIRED pour un mandataire sans compte) | BUILT |
| 21 | Indicateurs : événements autorisés, recettes par événement | fiches.ts indicators/eventsRevenue | FS | BUILT-NOW |
| 22 | Registre des sites — superficie, exploitant, titre | fiches.ts SECTOR_OBJECTS['22'] ; Fiches › 22 | FS « bon QR par camion… » (FIELD_REQUIRED) | BUILT-NOW |
| 22 | Bons de sortie — QR à usage unique par camion | fiches.ts `orderExitSlips` (type configuré, [EXEMPLE] CAR-BON-EX) ; POST …/carrieres/:id/bons ; Fiches › 22 | FS (10000 CDF pour 2 camions, BANK refusé) | BUILT-NOW |
| 22 | Comptage — sorties aux points de contrôle | fiches.ts `exitCheckpoint` (observation COMPTAGE_SORTIES puis contrôle) ; POST/GET …/carrieres/:id/sorties ; Fiches › 22 | FS (4 sorties comptées) | BUILT-NOW |
| 22 | Liquider sur superficie et volumes (automatique) | fiches.ts `runAutomatic` module 22 : par site et par mois VALIDÉ | FS (14000 CDF, idempotent, rien avant validation) | BUILT-NOW |
| 22 | Détecter l’écart sorties comptées / déclarées | secteurs.ts `reconcile` (COMPTAGE_SORTIES) | FS (écart 2) ; recettes-secteurs « carrières… » | BUILT |
| 22 | Bon à usage unique non réutilisable | titres USAGE_UNIQUE + `exitCheckpoint` (autre site non consommé) | FS (DÉJÀ UTILISÉ, AUTRE_SITE, état EMIS conservé) | BUILT-NOW |
| 22 | Indicateurs : sites actifs, écart sorties / déclarations | fiches.ts indicators | FS | BUILT-NOW |
| 23 | Concessions — superficie, titulaire | fiches.ts SECTOR_OBJECTS['23'] ; Fiches › 23 | FS « concessions liquidées… » | BUILT-NOW |
| 23 | Produits non ligneux — déclaration aux points de contrôle | fiches.ts `checkpointDeclaration`, `listForestDeclarations` ; routes …/forets/declarations ; Fiches › 23 | FS | BUILT-NOW |
| 23 | Liquidation automatique sur superficie | fiches.ts `runAutomatic` module 23 (exercice) | FS (150000 CDF, idempotent) | BUILT-NOW |
| 23 | Accès limité aux services compétents | policies.ts `forestRead` ; consultations journalisées | FS (terrain 403, audit forest.consulted) | BUILT-NOW |
| 23 | Indicateurs : concessions liquidées, déclarations enregistrées | fiches.ts indicators | FS | BUILT-NOW |
| 24 | Registre des embarcations — identifiant, QR, propriétaire, capacité | fiches.ts SECTOR_OBJECTS['24'], plaque QR ; Fiches › 24 | FS (SECTOR_OBJECT_EXISTS, plaque QR) | BUILT-NOW |
| 24 | Quais et ports privés géoréférencés | registerReference QUAI privateQuay | FS | BUILT-NOW |
| 24 | Mouvements — départ, destination, historique | fiches.ts `recordMovement`, `boatControl.movements` | FS (DEPART, ARRIVEE, INVALID_MOVEMENT) | BUILT-NOW |
| 24 | Redevances — accostage, mouvement | type ACC-ACCOSTAGE (acte requis) ; liquidation par mouvement ou période (`propose` movementId) | FS (movementId, LIQUIDATION_EXISTS) | BUILT-NOW |
| 24 | Contrôler une embarcation par QR ou numéro | fiches.ts `boatControl` ; GET …/embarcations/:ref/controle ; Fiches › 24 | FS (identifiant, plaque QR, inconnue) | BUILT-NOW |
| 24 | Liquider par mouvement ou période | fiches.ts `propose`/`baseFor` (mouvements, passagers) | FS | BUILT-NOW |
| 24 | Rapprocher mouvements et paiements | fiches.ts `portReconciliation` | FS (gap 1) | BUILT-NOW |
| 24 | Pilote après cadrage sectoriel | module ACTE_REQUIS (J30) : aucun montant sans règle ACTIVE | recettes-secteurs « catalogue… » | BUILT |
| 24 | Indicateurs : embarcations, mouvements, recettes portuaires | fiches.ts indicators | FS (mouvements 2) | BUILT-NOW |
| 25 | Axes et points de péage géoréférencés | registerReference AXE/POINT_PEAGE ; Fiches › 25 | FS (AXE-EX-02) | BUILT-NOW |
| 25 | Titres — passage unique, carnet, abonnement liés à la plaque | titres catalogue PEA-* (acte requis) + [EXEMPLE] PEA-PASSAGE-EX / PEA-CARNET-EX ; fiches.ts `buyToll` ; POST …/peage/titres ; Fiches › 25 | FS (2000 / 20000 CDF) ; FFS « 25 : achat… » | BUILT-NOW |
| 25 | Reçus électroniques QR | quittance provisoire + titre QR du moteur de titres | titres.test.ts ; FS (paiement confirmé → titre) | BUILT |
| 25 | Consommer un passage à chaque franchissement | fiches.ts `passage` → titres.control (module 25) | FS (VALIDE puis INVALIDE + constat) | BUILT-NOW |
| 25 | Afficher le solde d’un carnet | fiches.ts `carnet` ; GET …/peage/carnets/:plaque ; Fiches › 25 | FS (usesLeft 9 / 10) ; FFS | BUILT-NOW |
| 25 | Aucun encaissement non tracé | canaux numériques seulement (CHANNEL_NOT_ALLOWED) | FS | BUILT-NOW |
| 25 | Indicateurs : passages, recettes par axe, fraude détectée | fiches.ts indicators | FS (passages 4, fraude 1, recettes par axe mesurées) | BUILT-NOW |
| 26 | Fiche de recette complète (référence, autorité, fait générateur, assiette, formule, taux, exonérations, pénalités, compte, recours, dates) | rules/service.ts RuleInput ; LegalRegister (création) | legal.test « cycle : 4 visas… » ; juridique.test « fiche en snake_case… » | BUILT |
| 26 | Cycle de vie brouillon → revue → approuvée → publiée → suspendue → archivée | rules/service.ts approve/suspend ; veille.ts `requestArchive`/`decideArchive` (quatre yeux) ; LegalRegister + panneau Veille | legal.test ; reductions-gouvernance (suspension) ; R26 « seule une version sans effet s’archive… » ; FFS « veille du registre » | BUILT-NOW (archivage) |
| 26 | Versionnage — chaque liquidation garde sa version | obligation.ruleVersion ; versions() | juridique.test ; misc.test (ruleVersion) | BUILT |
| 26 | Simulation sur échantillon avant publication | legal-tests.ts sample-simulations | juridique.test « publication bloquée sans… échantillon » | BUILT |
| 26 | Veille — règles expirantes, conflits de normes | veille.ts `expiring`, `conflicts` ; GET /v1/legal-rules/veille ; LegalRegister › VeilleRegles | R26 « règles expirantes… », « conflit de normes… » ; FFS | BUILT-NOW |
| 26 | Séparation des compétences (province, ETD, central, acte nouveau) | refusParCategorie (liquidation) + conflit COMPETENCE (veille) | juridique.test « RECETTE_CENTRALE exclue… » | BUILT |
| 26 | Bloquer toute publication sans texte en vigueur | publicationBlockers (INSTRUMENT_NOT_IN_FORCE, ABROGATED_INSTRUMENT) | legal.test AC-LEG-03 | BUILT |
| 26 | Empêcher la même personne de créer, valider et publier | approve (assertDistinctPerson) | legal.test AC-LEG-02 ; R26 « la même personne… » | BUILT |
| 26 | Refuser toute obligation doublonnant une autre administration | service.ts `sameTaxableEventElsewhere` → blocage DOUBLON_ADMINISTRATION à la publication ; veille (conflit) | R26 « une règle d’une autre entité… » | BUILT-NOW |
| 26 | Bloquer la rétroactivité non autorisée | publicationBlockers RETROACTIVITY_NOT_AUTHORIZED | recouvrement.test (RETROACTIVITY_NOT_AUTHORIZED) | BUILT |
| 26 | Quatre yeux ; code recette stable et non réutilisable | 4 visas ; referentiel codes ; archivage conserve le code (nouvelle version) | recettes-secteurs « codes de recette stables… » ; R26 (version > 1 après archivage) | BUILT |
| 26 | Données : LegalInstrument, RevenueRule, RateVersion | rules/service.ts | legal.test | BUILT |
| 26 | Indicateurs : règles actives validées, règles expirant, délai d’approbation | veille.ts `indicators` ; panneau Veille | R26 ; FFS | BUILT-NOW |

## Comptes par module

| Module | BUILT | BUILT-NOW | ADAPTER |
|---|---|---|---|
| 13 | 0 | 11 | 0 |
| 14 | 8 | 3 | 1 (passerelle USSD/SMS de l’opérateur, avec sandbox — ligne comptée aussi en BUILT-NOW) |
| 15 | 9 | 0 | 0 |
| 16 | 1 | 9 | 0 |
| 17 | 1 | 8 | 0 |
| 18 | 0 | 8 | 0 |
| 19 | 1 | 5 | 0 |
| 20 | 7 | 3 | 0 |
| 21 | 5 | 2 | 0 |
| 22 | 1 | 6 | 0 |
| 23 | 0 | 5 | 0 |
| 24 | 1 | 8 | 0 |
| 25 | 1 | 6 | 0 |
| 26 | 10 | 4 | 0 |

## Adaptateurs restants

- Module 14 — passerelle USSD / SMS de l’opérateur télécom : code court USSD et numéro SMS attribués par convention (J29) — `PARKING_TEXT_ACCESS` affiché « À RACCORDER — convention requise ». Interface : POST /v1/parking/canal-texte/passerelle/:operator (signature HMAC v2, nonce, fenêtre ±5 min, anti-rejeu) ; sandbox : simulateur authentifié ; tests S14.

## Contradictions / arbitrages à soumettre au maître d’ouvrage

1. Module 22 : la fiche dit « liquider sur superficie et volumes » ; la décision « automatique par objet/exercice » a été appliquée par site et par MOIS dont la déclaration de sorties est VALIDÉE (les volumes n’existent qu’après rapprochement) ; une liquidation annuelle proposée reste possible. À confirmer : périodicité mensuelle ou annuelle.
2. Planificateur de la liquidation automatique : toutes les heures par défaut (paramètre technique « à confirmer »), en plus d’un passage idempotent à la lecture de la liste des liquidations.
3. Horizon de veille des règles expirantes : 90 jours par défaut, « à confirmer ».
4. Doublon d’administration : détection sur le libellé normalisé du fait générateur (+ nature si renseignée) ; un libellé différent pour le même fait n’est pas détecté — préférer un code de fait générateur normalisé au registre.
5. Module 14 — exemption « cas prévu par la règle » : acceptée seulement si l’exonération est inscrite mot pour mot dans la fiche de la grille tarifaire ACTIVE de la zone ; « véhicule officiel » : pièce obligatoire, décision d’une autre personne ; aucune liste officielle des véhicules n’existe au registre.
