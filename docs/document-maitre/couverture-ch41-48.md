# Couverture du Document maître FR 2 — chapitres 41 à 48 et annexes A–B

Source : `docs/sources/Document_Maitre_FR_2_nouvelle_version.txt.md` (texte extrait intégral, reçu le 27/09/2026) et le
fichier Word de la même version (le 13e point de l'annexe B n'apparaît que dans le fichier Word).

Chaque phrase ou élément de liste est rattaché au code qui le met en œuvre et au test qui le prouve.

- **CONSTRUIT** : existait avant ce lot ; vérifié et relié.
- **CONSTRUIT-ICI** : ajouté ou complété par ce lot.
- **EXTERNE** : exige une exécution dans le monde réel. Suivi par un code de suivi (écran « Recette — critères
  d'acceptation », route `POST /v1/pilotage/programme/recette/suivis/:code`), jamais simulé.

Les chemins sont relatifs à la racine du dépôt. Les référentiels sont dans
`backend/src/plugins/pilotage/programme/referentiels.ts` (abrégé **REF**). Le fichier
`backend/test/programme.test.ts` (abrégé **PT**) vérifie trois choses :

- chaque texte est cité mot pour mot par rapport à la source ;
- chaque fichier et chaque titre de test cité existent réellement ;
- les parcours de l'API fonctionnent.

## Ch. 41 — Registre des risques

| Élément de la source | Mise en œuvre | Preuve | Statut |
|---|---|---|---|
| Le registre (13 risques, probabilité, impact, traitement), repris mot pour mot | REF `RISQUES_41` ; `GET /v1/pilotage/programme/risques` ; écran `/pilotage/risques` (`frontend/src/modules/pilotage/Risques.tsx`) | PT « ch. 41 : 13 risques… » ; PT « carte de chaleur… » ; `frontend/test/programme.test.tsx` | CONSTRUIT-ICI |
| Échelle probabilité / impact | REF `PROBABILITES`, `IMPACTS`, `zoneDe` ; carte de chaleur 4 × 4 (rangs et zones : par défaut, à confirmer) | PT « carte de chaleur… » | CONSTRUIT-ICI |
| Propriétaire (rôle) et date de revue par risque | REF `proprietaire` (par défaut, à confirmer) ; `designateOwner` (supervision, motivé, journalisé) ; `prochaineRevue` = dernière revue + 90 j (par défaut) | PT « carte de chaleur… » | CONSTRUIT-ICI |
| Revue périodique par une personne ; revue en retard signalée ; audit | `ProgrammeService.reviewRisk` (propriétaire ou supervision, commentaire obligatoire) ; `revueEnRetard` ; actions d'audit `programme.risque.reviewed` et `programme.risque.owner_designated` | PT « carte de chaleur… » | CONSTRUIT-ICI |
| RQ01 Référentiel appuyé sur un texte abrogé — relevé juridique certifié avant paramétrage | `rules/service.ts` `SOURCE_NOT_CERTIFIED` | `legal.test.ts` « visas dans l'ordre… source non certifiée bloquée » | CONSTRUIT |
| RQ01 — blocage technique sans référence légale valide | `rules/service.ts` `ABROGATED_INSTRUMENT`, `INSTRUMENT_NOT_IN_FORCE` | `legal.test.ts` AC-LEG-03 ; `chaine.test.ts` ; `recette-criteres.test.ts` C42-01 | CONSTRUIT |
| RQ02 Résistance des agents — primes sur résultats vérifiés | `sanctions/commissions.ts` (livrables vérifiés) ; versement conditionné à J10 | `terrain.test.ts` « rémunération indicative sur livrables vérifiés… » | CONSTRUIT |
| RQ02 — dialogue social préalable | — | — | EXTERNE (hors plateforme) |
| RQ02 — déploiement progressif | `planification/model.ts` `PILOT_COMMUNES` | `planification.test.ts` « critères du § 45.3… » | CONSTRUIT |
| RQ02 — rotation des zones | `terrain/qualite-fraude.ts` `rotation()` | `terrain-qualite-detecteurs.test.ts` « rotation des zones… » | CONSTRUIT |
| RQ03 Rejet politique ou social — attestation de bail | `fiscal/clearances.ts` `issueLeaseAttestation` | `fiscal.test.ts` « délivrée aux parties du bail… » ; `carnet-recits.test.ts` R43-03 | CONSTRUIT |
| RQ03 — échéancier | `recouvrement/service.ts` (échéancier sur acte) | `recouvrement.test.ts` « aucun échéancier sans acte l'autorisant » | CONSTRUIT |
| RQ03 — quittance unique | `receipts/service.ts` | `payments.test.ts` AC-PAY-04 | CONSTRUIT |
| RQ03 — publication des réalisations financées | `pilotage/transparency.ts` `FundedProjectsSection` | `planification.test.ts` « l'IA propose des scénarios classés… » | CONSTRUIT |
| RQ04 Protocoles de données — recensement terrain en parallèle | `terrain/service.ts` `submitFinding` | `terrain.test.ts` « constat géolocalisé… » | CONSTRUIT |
| RQ04 — négociation au niveau du Gouvernement provincial | Décision n° 5 du registre (ch. 48) ; état calculé `RECOUPEMENT_DONNEES` | PT décisions | EXTERNE (décision) |
| RQ04 — séquencement par source | `juridique/gates.ts` `recoupementDonneesAutorise` ; `fiscal/census.ts` `recordProvenance` | `juridique.test.ts` « trancher un point… » | CONSTRUIT |
| RQ05 Double imposition — référentiel unique avec autorité compétente | `rules/routes.ts` (`competentAuthority` obligatoire) ; catégories | `juridique.test.ts` « RECETTE_CENTRALE exclue… » | CONSTRUIT |
| RQ05 — refus des doublons sur un même fait générateur | `fiscal/declarations.ts` ; garde de liquidation (module accès) | `integration.test.ts` « jamais de double perception… » | CONSTRUIT |
| RQ06 Changement institutionnel — régie paramétrable, rôles reconfigurables | `acces/service.ts` (entités, modules, invitations) | `acces.test.ts` « sème entités… », AC-INV-02 | CONSTRUIT |
| RQ07 Dépendance au prestataire — séquestre du code | — | Décision n° 10 | EXTERNE |
| RQ07 — formats ouverts | `pilotage/exports.ts` (CSV/JSON signés) ; `persistence/backup.ts` | `pilotage.test.ts` « CSV + JSON… » | CONSTRUIT |
| RQ07 — transfert de compétences contractuel | Apprentissage et certification (§ 24) | — | EXTERNE |
| RQ07 — test annuel de réversibilité | Restauration complète prouvée par test | `socle.test.ts` « sauvegarde signée… restauration… » | EXTERNE (exercice annuel) |
| RQ08 Sécurité — zéro confiance | `core/policy.ts` `authorize` (RBAC + ABAC) | `audit-access.test.ts` « ABAC… » | CONSTRUIT |
| RQ08 — chiffrement | `frontend/src/lib/offlineQueue.ts` (AES-GCM) | `frontend/test/securite-acces-audit.test.tsx` | CONSTRUIT |
| RQ08 — tests d'intrusion | Suivi `TEST_INTRUSION_TIERS` | — | EXTERNE |
| RQ08 — plan d'incident | `integrite/service.ts` (incidents) | `integrite.test.ts` « déclaration, propriétaire, cycle… » | CONSTRUIT |
| RQ08 — sauvegarde immuable | `persistence/backup.ts` ; copie WORM | `securite-acces-audit.test.ts` « copie WORM… » | CONSTRUIT |
| RQ09 Fraude interne — séparation des fonctions | `core/policy.ts` `assertDistinctPerson` ; `INCOMPATIBLE_ROLES` | `legal.test.ts` AC-LEG-02 | CONSTRUIT |
| RQ09 — quatre yeux | `integrite/gouvernance/circuits.ts` `CIRCUITS` | `treasury-vault.test.ts` AC-BEN-01 | CONSTRUIT |
| RQ09 — accès temporaire | `acces/elevations.ts` (juste-à-temps) | `securite-acces-audit.test.ts` « demande motivée → approbation… » | CONSTRUIT |
| RQ09 — audit indépendant | Rôle R23 en lecture ; piste d'audit par dossier | `pilotage.test.ts` « chronologie fusionnée… » | EXTERNE (mission) |
| RQ10 GPS — tolérance paramétrée | `terrain/service.ts` `toleranceFor` | `terrain.test.ts` « indicateurs de production et tolérance GPS… » | CONSTRUIT |
| RQ10 — preuve photographique | `terrain/service.ts` (empreinte photo, drapeau `SANS_PHOTO`) | `carnet-recits.test.ts` R43-04 | CONSTRUIT |
| RQ10 — validation hiérarchique | `terrain/service.ts` `reviewFinding` | `terrain.test.ts` « validation indépendante… » | CONSTRUIT |
| RQ11 Connectivité — hors ligne d'abord | `titres/service.ts` `offlinePack` | `titres.test.ts` « paquet signé Ed25519… » | CONSTRUIT |
| RQ11 — synchronisation différée | `modules/field/routes.ts` `/v1/field-sync/batches` | `field-appeals.test.ts` « lot signé accepté… » | CONSTRUIT |
| RQ11 — files locales | `frontend/src/lib/offlineQueue.ts` | `frontend/test/recette-hors-ligne.test.ts` | CONSTRUIT |
| RQ12 Surdimensionnement — monolithe modulaire | `backend/src/plugins/index.ts` | `integration.test.ts` | CONSTRUIT |
| RQ12 — périmètre pilote restreint ; portes de phase | `PILOT_COMMUNES`, `PILOT_MILESTONES` (revues signées) | `planification.test.ts` | CONSTRUIT |
| RQ13 Promesses de recettes — base de référence mesurée | `planification/model.ts` `BASELINE_METRICS` | `planification.test.ts` « RANV… » | CONSTRUIT |
| RQ13 — scénarios | `planification/model.ts` `SCENARIOS` | `planification.test.ts` « prudent = conservateur… » | CONSTRUIT |
| RQ13 — communication prudente | Affichage « non mesuré » ; rapproché seulement | `pilotage.test.ts` « onze niveaux… » | EXTERNE (discipline de communication) |

## Ch. 42 — Critères d'acceptation

Quinze critères figurent au référentiel `CRITERES_42`, sur l'écran `/pilotage/recette` et à la route
`GET /v1/pilotage/programme/recette`.

- **Critères 1 à 10** : ceux du Document maître FR 2, cités mot pour mot.
- **Critères 11 à 15** : ajoutés le 27/09/2026 ; leur libellé a été transmis par le coordinateur (voir la fin du tableau).

| Critère | Mise en œuvre | Preuve | Statut |
|---|---|---|---|
| 1. Aucune obligation ne peut être créée sans règle publiée portant une référence légale valide : test négatif obligatoire. | Garde de liquidation (`RULE_NOT_EXECUTABLE`) ; blocages de publication (`ABROGATED_INSTRUMENT`, `INSTRUMENT_NOT_IN_FORCE`, `UNKNOWN_LEGAL_INSTRUMENT`) | `recette-criteres.test.ts` C42-01 (test négatif) ; `legal.test.ts` AC-LEG-01, AC-LEG-03 ; `chaine.test.ts` | CONSTRUIT |
| 2. Aucune quittance ne peut être générée sans confirmation serveur à serveur d'un prestataire agréé. | Rappel signé HMAC v2 des prestataires enregistrés ; aucune route de quittance côté client | `recette-criteres.test.ts` C42-02 ; `payments.test.ts` AC-PAY-02 ; `chaine.test.ts` | CONSTRUIT |
| 3. Aucun compte bénéficiaire ne peut être modifié par un seul utilisateur, quel que soit son rôle. | Coffre : deux approbateurs distincts, vérification hors bande, 72 h ; aucune route de modification directe | `recette-criteres.test.ts` C42-03 ; `treasury-vault.test.ts` | CONSTRUIT |
| 4. Aucun événement d'audit ne peut être modifié ou supprimé, y compris par le super-administrateur : test d'altération obligatoire. | Journal chaîné en ajout seul (405 `AUDIT_APPEND_ONLY`, tentative journalisée) ; vérification de la chaîne | `recette-criteres.test.ts` C42-04 (super-administrateur, DELETE/PUT/PATCH, altération en base) ; `audit-access.test.ts` | CONSTRUIT |
| 5. Toute consultation d'un dossier individuel est journalisée avec acteur, motif et horodatage. | Consultation motivée (module accès) ; `core/consultation.ts` : motif enregistré sur `taxpayer.viewed` et `obligation.viewed` (en-tête `x-motif-consultation`, sinon finalité du rôle) | `recette-criteres.test.ts` C42-05 ; `acces.test.ts` | CONSTRUIT-ICI (motif sur la lecture directe) |
| 6. L'application terrain fonctionne sans réseau pendant une journée complète de mission et synchronise sans perte. | File locale chiffrée (conservation 72 h, par défaut) ; constats idempotents (`clientRef`) ; lots signés | `frontend/test/recette-hors-ligne.test.ts` ; `recette-criteres.test.ts` C42-06 ; `field-appeals.test.ts` | CONSTRUIT (tests de la journée complète : CONSTRUIT-ICI) |
| 7. Le rapprochement quotidien produit des files d'exception exploitables et traçables. | Import de relevé, exceptions typées (relevé, ligne, date, statut), audit et notification | `recette-criteres.test.ts` C42-07 ; `treasury-vault.test.ts` ; `tresor.test.ts` | CONSTRUIT |
| 8. La vérification publique d'une quittance ne divulgue aucune donnée personnelle au-delà du nécessaire. | Vérification publique minimale | `recette-criteres.test.ts` C42-08 ; `payments.test.ts` AC-RCP-01 | CONSTRUIT |
| 9. Un recours déposé est horodaté, affecté et suivi jusqu'à décision motivée. | Accusé horodaté (numéro, empreinte) ; **affectation dès le dépôt** à la file d'instruction de l'entité administratrice (`appeals/service.ts` `affectation`) ; délais ; décision motivée par une personne distincte | `recette-criteres.test.ts` C42-09 ; `recouvrement.test.ts` ; `field-appeals.test.ts` | CONSTRUIT-ICI (affectation) |
| 10. Les tableaux de bord distinguent explicitement potentiel, constaté, encaissé, réglé, rapproché et disponible. | `shared/src/programme.ts` `SIX_ETATS` ; `sixEtats` dans `GET /v1/pilotage/echelle` ; bandeau « Six états de la recette » (Tableaux) | `recette-criteres.test.ts` C42-10 ; `pilotage.test.ts` | CONSTRUIT-ICI (distinction explicite) |
| 11 à 15 (postes de décision : compréhension en 90 s ; aucune donnée fiscale individuelle en accueil ; aucune modification financière, test négatif par profil ; état, date et taux de conversion, y compris à l'export ; décisions de la corbeille motivées et journalisées) | Lot « postes de décision » (autre branche) ; preuves partielles déjà présentes (AC-ACC-02, exports signés, tableaux par profil) | `backend/test/postes-decision-acceptation.test.ts` — **PENDING_MERGE** : « preuve : lot postes de décision (à relier à la fusion) » | À relier à la fusion |

Chaque fichier de test cité doit exister et porter exactement le titre cité : c'est ce que vérifie PT « chaque test cité existe ».

- **Exception unique :** le fichier `postes-decision-acceptation.test.ts`, marqué `PENDING_MERGE` et toléré explicitement jusqu'à la fusion.
- **Libellé des critères 11 à 15 :** il a été transmis par le coordinateur et s'appuie sur le Cahier (nouvelle version), ch. 27 (§ 27.2, 27.3, 27.10, 27.12).
- **À confirmer :** le texte exact du ch. 42 mis à jour, à la fusion.

## Ch. 43 — Carnet de développement

La phrase d'introduction de la source dit que « le carnet complet est produit en phase 1 et priorisé par valeur de recette et par risque ». Cette production relève de la phase 1 du programme.

Les 10 récits sont repris au référentiel `RECITS_43`. Le fichier `backend/test/carnet-recits.test.ts` contient un test de bout en bout par récit.

| Récit | Critères et mise en œuvre | Preuve | Statut |
|---|---|---|---|
| Kinois : compte avec mon téléphone | Inscription N0 sans pièce ; code à usage unique (défi à usage unique) ; aucune obligation sans objet rattaché | R43-01 | CONSTRUIT |
| Bailleur : déclarer mes unités louées (IRL) | Une unité (un objet) par déclaration ; **bloc « calcul » : taux, retenue et arrêté lus dans la fiche de règle** ; **pièce justificative facultative (empreinte)** ; écran de déclaration | R43-02 | CONSTRUIT-ICI (calcul affiché, pièce) |
| Locataire : enregistrer mon bail, attestation | Bail déclaré par le locataire → avis obligatoire au bailleur ; attestation signée avec QR ; vérification publique sans nom ni loyer | R43-03 | CONSTRUIT |
| Agent recenseur : objet non enregistré hors ligne | Constat « objet non enregistré » avec GPS, empreinte photo et **catégorie** (scellée) ; aucun objet ni obligation avant qualification ; rejeu idempotent ; qualification par une personne distincte | R43-04 | CONSTRUIT-ICI (catégorie) |
| Contrôleur : vérifier une plaque | Réponse mesurée < 3 s en ligne ; paquet hors ligne minimal signé (plaque, numéro, validité) ; consultation journalisée | R43-05 | CONSTRUIT |
| Juriste : publier une règle après validation | Quatre visas de quatre personnes ; date d'effet obligatoire ; version numérotée | R43-06 | CONSTRUIT |
| Comptable public : rapprocher les règlements du jour | Import, appariement automatique, file d'exception, relevé modifié refusé (`STATEMENT_ALREADY_IMPORTED`) | R43-07 | CONSTRUIT |
| Gouverneur : écart assignation / rapproché par commune | Tableau et **carte schématique des 24 communes** ; six états ; **exportation signée** de la carte des écarts (`GET /v1/pilotage/assignations/ecarts/export`), vérifiable | R43-08 | CONSTRUIT-ICI (carte, export signé) |
| Auditeur : chaîne complète pour un objet | Piste d'audit : de `object.declared` aux écritures du grand livre, acteurs, horodatages, empreintes | R43-09 | CONSTRUIT |
| Contribuable : contester une donnée erronée | Formulaire typé (types fermés) ; accusé horodaté ; délai légal suivi ; décision motivée | R43-10 | CONSTRUIT |

## Ch. 44 — Plan de livraison par versions

| Version (contenu, public) | Modules qui la livrent (vérifiés à l'exécution) | Preuve | Statut |
|---|---|---|---|
| V0.1 socle interne — Identité, objets, référentiel, audit — Équipes internes | socle `taxpayers`, `users`, `objects`, `rules`, `audit` ; modules `acces`, `socle`, `fiscal`, `juridique`, `referentiel`, `integrite-securite`, `chaine` | PT « versions V0.1 à V3.0… » | CONSTRUIT-ICI (référentiel et écran) |
| V0.5 pilote restreint — Déclaration, liquidation, paiement mobile, quittance, application terrain — Une commune pilote | `fiscal`, `assessment`, `payments`, `canaux`, `receipts`, `field`, `terrain` | idem | idem |
| V1.0 pilote complet — Quatre communes, tableaux de bord, rapprochement, recours | `planification`, `pilotage`, `treasury`/`tresor`, `appeals` | idem (V1.0 « partiel » si la planification n'est pas chargée) | idem |
| V1.5 campagne — Déclarations pré-remplies, relances, quitus numérique | `fiscal`, `campagnes`, `recouvrement` | idem | idem |
| V2.0 extension — Nouvelles communes, grands redevables, publicité, antennes, domaine public | `planification`, `verticales`, `publicite` | idem | idem |
| V2.5 intelligence — Agents IA de priorisation, prévision, détection de fraude | `ia`, `opportunites`, `planification`, `integrite`, `integrite-detecteurs` | idem | idem |
| V3.0 généralisation — 24 communes, affectation et transparence publique | `pilotage`, `planification`, `repartition` | idem | idem |
| État de mise en service de chaque version | Décision d'une personne, procès-verbal (référence et empreinte) exigé pour « en service » ; écran `/pilotage/versions` | PT ; `frontend/test/programme.test.tsx` | CONSTRUIT-ICI |

## Ch. 45 — Stratégie de tests

| Point de la source | Mise en œuvre et preuve | Statut | Suivi |
|---|---|---|---|
| Tests unitaires et d'intégration sur le moteur de règles, avec jeux de cas juridiques validés par les juristes provinciaux. | Circuit des cas juridiques (`juridique.test.ts` « publication bloquée sans cas… ») ; évaluateur (`legal.test.ts`) | CONSTRUIT ; validation par les juristes EXTERNE | `VALIDATION_JEUX_JURIDIQUES` |
| Tests de liquidation comparés à des dossiers réels anonymisés des campagnes précédentes. | Liquidation déterministe (`misc.test.ts`) ; aucun dossier réel dans le dépôt | EXTERNE | `COMPARAISON_DOSSIERS_REELS` |
| Tests de bout en bout du paiement avec chaque prestataire, en environnement de recette, y compris scénarios d'échec, de doublon et de rappel frauduleux. | `recette-criteres.test.ts` S45-3 ; `payments.test.ts` ; `titres.test.ts` | CONSTRUIT (simulateur signé) ; prestataires réels EXTERNE | `RECETTE_PRESTATAIRES` |
| Tests de charge calés sur les pics de campagne de fin janvier. | `tools/charge/pic-fin-janvier.mjs` (Node seul, contre un serveur local, jamais en intégration continue) ; `tools/charge/pic-fevrier.k6.js` (existant) | CONSTRUIT-ICI (script Node) ; exécution cible EXTERNE | `CHARGE_PIC_FIN_JANVIER` |
| Tests hors ligne : journée complète sans réseau, perte d'appareil, conflit de synchronisation. | `frontend/test/recette-hors-ligne.test.ts` ; `recette-criteres.test.ts` C42-06 ; `field-appeals.test.ts` (terminal révoqué, conflit) | CONSTRUIT (+ journée complète : CONSTRUIT-ICI) | — |
| Tests de sécurité : intrusion externe, élévation de privilèges, tentative d'altération du journal d'audit, exfiltration massive. | `recette-criteres.test.ts` S45-6 et C42-04 ; `acces.test.ts` AC-INV-02 ; `securite-acces-audit.test.ts` (DLP, trois visas) | CONSTRUIT ; intrusion externe EXTERNE | `TEST_INTRUSION_TIERS` |
| Tests d'accessibilité et d'usage sur terminaux d'entrée de gamme et connexions lentes. | `frontend/test/programme.test.tsx` « accessibilité : … » ; `autosave-status.test.tsx` | Contrôles automatiques CONSTRUIT-ICI ; terminaux réels EXTERNE | `ACCESSIBILITE_TERMINAUX` |
| Recette utilisateur avec agents réels dans une commune, avant toute mise en production. | — | EXTERNE | `RECETTE_UTILISATEUR_AGENTS` |
| Répétition de la reprise après sinistre avec restauration complète et vérification d'intégrité. | `persistence/backup.ts`, `backup-cli.ts` (`npm run db:backup` / `db:restore` / `db:verify`) ; `socle.test.ts` « sauvegarde signée… restauration… » | CONSTRUIT ; répétition sur l'infrastructure réelle EXTERNE | `REPETITION_REPRISE_SINISTRE` |

## Ch. 46 — Plan de pilote de 180 jours

| Élément | Mise en œuvre | Preuve | Statut |
|---|---|---|---|
| 46.1 Quatre communes, raison du choix et objets prioritaires (Gombe, Limete, Kalamu, Ngaliema) | `planification/model.ts` `PILOT_COMMUNES` (existant) et `PILOT_COMMUNES_46` ; bloc `chapitre46` du tableau du pilote ; écran `/pilotage/pilote` | PT « ch. 46… » et « synthèse du programme et pilote… » | CONSTRUIT (communes) ; CONSTRUIT-ICI (raisons, objets) |
| 46.2 Séquence en cinq étapes (semaines 1–4, 5–12, 13–16, 17–22, 23–26) | `PILOT_SEQUENCE_46` ; étape en cours calculée depuis la date de démarrage | idem | CONSTRUIT-ICI |
| 46.3 Couverture des objets prioritaires > 80 % | Critère `COUVERTURE_OBJETS` (`TAUX_RECENSEMENT`) + indicateur § 40 `COUVERTURE_RECENSEMENT` | idem | CONSTRUIT (mesure non disponible : déclarée « non mesurée ») |
| 46.3 Part électronique des encaissements > 90 % | `PART_ELECTRONIQUE` (`PART_NUMERIQUE`) + `PART_ELECTRONIQUE_RECETTES` | idem | CONSTRUIT |
| 46.3 Aucun encaissement d'espèces par un agent | `ESPECES_AGENTS` | idem | CONSTRUIT |
| 46.3 Écart de rapprochement < 1 % | `ECART_RAPPROCHEMENT_J2` + `DELAI_PAIEMENT_RAPPROCHEMENT` | idem | CONSTRUIT |
| 46.3 Délai moyen de quittance < une minute | `DELAI_QUITTANCE` + `DELAI_PAIEMENT_QUITTANCE` | idem | CONSTRUIT |
| 46.3 Contestations traitées dans le délai légal > 90 % | **Désormais mesuré** par `RECOURS_DANS_DELAI` (auparavant « non mesuré ») | idem | CONSTRUIT-ICI |
| 46.3 Progression des recettes pilotes significativement supérieure aux communes témoins | Comparaison pilotes / témoins (témoins désignés par une personne) ; significativité appréciée par l'évaluation indépendante | `planification.test.ts` | CONSTRUIT |
| Comparaison avec les communes témoins, pour chaque indicateur | `indicateurs40[].pilot` / `.controls` / `.gapPoints` pour chaque critère | PT | CONSTRUIT-ICI |

## Ch. 47 — Plan des 100 premiers jours

| Période (actions citées, responsable) | Mise en œuvre | Preuve | Statut |
|---|---|---|---|
| 1 à 15 — Décision provinciale, nomination du directeur de programme et du comité de pilotage, lettre de mission — Gouverneur et ministre provincial des Finances | REF `PLAN_100_JOURS_47` ; `GET /v1/pilotage/programme/cent-jours` ; jour 1 fixé par une personne ; suivi par action (état, note, preuve) ; instruction de suivi par le circuit existant des instructions (`PlanificationService.issueInstruction`) ; écran `/pilotage/cent-jours` | PT « 100 premiers jours… » ; `frontend/test/programme.test.tsx` | CONSTRUIT-ICI |
| 16 à 30 — Relevé juridique certifié… ; inventaire des systèmes… ; base de référence des recettes — Services juridiques, régies, programme | idem ; liens : registre juridique, base de référence (§ 38.1) | idem | CONSTRUIT-ICI |
| 31 à 45 — Signature des protocoles… ; sélection des communes pilotes ; cadrage de l'architecture et de la sécurité — Comité de pilotage | idem | idem | CONSTRUIT-ICI |
| 46 à 60 — Paramétrage des premières fiches… ; conventions avec les prestataires… ; recrutement des agents — Programme et régies | idem | idem | CONSTRUIT-ICI |
| 61 à 80 — Développement du socle ; formation et certification… ; préparation des terminaux — Programme | idem | idem | CONSTRUIT-ICI |
| 81 à 100 — Recette technique et test d'intrusion ; démarrage du recensement… ; premier tableau de bord en service — Programme, sécurité, régie | idem | idem | CONSTRUIT-ICI |

Les phases de la feuille de route, les plans datés à 30, 90 et 180 jours et à 12 et 24 mois, le modèle opérationnel et les comités (ch. 35–37) relèvent d'un autre lot. Ce lot ne les duplique pas.

## Ch. 48 — Décisions requises du Gouvernement provincial

| Décision | Ce qu'elle débloque (état calculé, jamais forcé) | Preuve | Statut |
|---|---|---|---|
| 1. Approuver KINSHASA MOSOLO comme système unique… | Aucun verrou technique propre | PT décisions | CONSTRUIT-ICI (registre) |
| 2. Désigner l'autorité porteuse et installer le comité de pilotage… | Gouvernance (ch. 35–37, autre lot) ; actions J1–15 | idem | idem |
| 3. Ordonner la refondation du référentiel sur l'OL 18/004… en écartant expressément l'OL 13/001 abrogée. | `OL_13_001_REFUSEE` : l'instrument `ol-13-001` est ABROGÉ et toute règle qui le cite est refusée à la publication | PT « refus des règles fondées sur l'OL 13/001… » ; `legal.test.ts` AC-LEG-03 ; `juridique.test.ts` | CONSTRUIT (garde) ; CONSTRUIT-ICI (registre) |
| 4. Faire certifier par les services juridiques les taux applicables (IRL, retenue par rang) | `IRL_TAUX_CERTIFIES` : fiches IRL au statut À VÉRIFIER → simulation non opposable | PT | idem |
| 5. Autoriser la signature des protocoles d'échange de données… | `RECOUPEMENT_DONNEES` (J13, J8) | PT | idem |
| 6. Approuver les quatre communes pilotes et l'objectif de campagne de février 2027. | `PILOTE_COMMUNES` | PT | idem |
| 7. Adopter l'acte autorisant le paiement fractionné par voie mobile (IF, IRL) | `ECHEANCIERS_MOBILE_MONEY` : reste « acte requis » (J14) tant que le point n'est pas tranché par son propre circuit | PT (décision prise, verrou inchangé) | idem |
| 8. Étendre l'exigence du quitus fiscal numérique… | `QUITUS_CONDITIONNE` (J6) | PT | idem |
| 9. Interdire toute manipulation d'espèces par les agents et fixer le régime des primes | `ESPECES_AGENTS_ZERO` ; `COMMISSIONS_VERSEMENT` (J10) | PT | idem |
| 10. Retenir un modèle contractuel hybride, sans pourcentage automatique sur les recettes publiques… | **Contradiction signalée au maître d'ouvrage — arbitrage attendu** : le modèle du § 37A (10 % promoteur après acte) n'est pas modifié ; `CLE_37A_ACTE_REQUIS` affiché « inchangé » | PT | CONSTRUIT-ICI (signalement) |
| Statut A_PRENDRE / PRISE / REFUSEE ; acte (référence, date, empreinte SHA-256) ; enregistrement par une personne et validation par une autre (second facteur) ; audit | `ProgrammeService.recordDecision` / `validateDecision` ; circuit `DECISION_GOUVERNEMENT` (`circuits.ts`) ; écran `/pilotage/decisions-gouvernement` | PT ; `frontend/test/programme.test.tsx` | CONSTRUIT-ICI |
| 48.2 Synthèse finale (7 lignes) et devise | REF `SYNTHESE_48_2`, `DEVISE_FR2` ; affichées à l'écran des décisions | PT « ch. 47, 48 et annexes… » | CONSTRUIT-ICI |

## Annexe A — Sources consultées et niveau de fiabilité

| Source | Rattachement | Statut |
|---|---|---|
| Les 11 sources (OL 18/004, OL 18/003, TADAT 2025, communiqués 2026, matinée fiscale FEC–DGRK, atelier du 14 mai 2026, contrat de performance DGRK, taux budgétaire 2025, note KIN-RECETTES, communiqués RFCK, site de la RFCK), avec usage et fiabilité cités | `backend/src/plugins/juridique/points.ts` `SOURCES_ANNEXE_A` ; rattachées aux instruments du registre des textes (statut affiché) et aux points J ; `GET /v1/juridique/points` (`annexeA`) ; onglet « Annexe A — sources » de l'écran des points juridiques | CONSTRUIT-ICI |

Le taux budgétaire de 2 859,2 CDF par dollar est cité comme source. Il n'est paramétré nulle part : les conversions restent régies par les règles de change certifiées.

## Annexe B — Points à vérifier avant mise en production

| Points | Rattachement | Statut |
|---|---|---|
| 1 à 8 (nomenclature consolidée, Loi 18/014, arrêtés de taux, édit budgétaire, Code du numérique, habilitation BCC, textes DGRFK/DGTK, régime des primes) | J1, J2, J3, J3, J7–J8, J9, J5, J10 — déjà présents (`POINTS_JURIDIQUES`) ; J5 cite la DGIPK : dénomination à harmoniser selon les textes | CONSTRUIT |
| 9. Texte de création et statuts de la RFCK… | **J31** (ajouté) | CONSTRUIT-ICI |
| 10. Arrêté ministériel du 12 novembre 2025… | **J32** (ajouté) | CONSTRUIT-ICI |
| 11. Redevances de fourrière… | **J33** (ajouté) et J24 | CONSTRUIT-ICI |
| 12. Nom de domaine officiel de la Ville Province… | **J34** (ajouté) | CONSTRUIT-ICI |
| 13. Valeur probante de la vignette électronique et de la vérification en ligne… (fichier Word) | **J35** (ajouté), J21, J7 | CONSTRUIT-ICI |
| Annexe B affichée | `ANNEXE_B_FR2` ; `GET /v1/juridique/points` (`annexeBFr2`) ; onglet dédié ; chaque point se tranche par le circuit existant (acte, deux personnes) | CONSTRUIT-ICI |

Pour J31 à J35, l'autorité, l'hypothèse intérimaire et le verrou sont marqués « PAR_DEFAUT — à confirmer ». Les tests `juridique.test.ts` vérifient désormais 35 points ; J1 à J30 restent inchangés et dans l'ordre.
