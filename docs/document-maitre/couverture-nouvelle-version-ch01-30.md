# Couverture du Document maître FR 2 (nouvelle version) — chapitres 1 à 17 et 19 à 30

Source : `docs/sources/Document_Maitre_FR_2_nouvelle_version.txt.md` (reçu le 27/09/2026). Analyse mot à mot des chapitres 1 à 17 et 19 à 30 ; le chapitre 18 (RFCK), les chapitres 31 et 35 à 48 relèvent d’autres lots. Chaque exigence est rapprochée du code qui la met en œuvre (`fichier:ligne`) et d’au moins un test automatisé qui l’exerce (route, service ou écran). Les emplacements ont été vérifiés automatiquement à la génération de ce tableau (motif présent à la ligne citée ; ligne de test portant un `it(`/`describe(`).

Règle n° 1 appliquée : rien n’a été retiré. Les ajouts se superposent à l’existant (mêmes circuits, mêmes règles, même vocabulaire) ; les écarts avec l’existant sont signalés ci-dessous, sans suppression.

## Légende des statuts

| Statut | Sens |
|---|---|
| CONSTRUIT | Déjà construit et testé avant cette analyse ; preuve citée. |
| CONSTRUIT-MAINTENANT | Manquant, ou présent sans route ni écran, ou sans test : construit et testé dans ce lot. |
| EXTERNE-SUIVI | Relève d’un autre lot (chapitre 18, 27, 40, modules 41–44 et 59–61) : suivi, non construit ici. |
| CONTRADICTION-SIGNALÉE | L’exigence contredit une décision du maître d’ouvrage : l’existant est conservé, la contradiction est portée à l’arbitrage. |
| CONTEXTE | Texte d’argumentaire sans exigence logicielle (chiffres cités, jamais utilisés comme paramètres). |

## Synthèse

260 exigences rapprochées : CONSTRUIT 236 ; CONSTRUIT-MAINTENANT 14 ; CONTEXTE 1 ; CONTRADICTION-SIGNALÉE 2 ; EXTERNE-SUIVI 7.

### Construit dans ce lot

| Exigence | Construit | Routes / écrans | Tests |
|---|---|---|---|
| § 17.2 identifiant « KIN-<commune>-<quartier>-<voie>-<n°> » | Alias au format du Cahier attribué à la validation, en plus du format territorial existant (conservé) ; registre non réattribuable ; résolution dans les deux formats ; sous-objets prolongés | `GET /v1/fiscal/igf/:code` ; fiche « Mes biens », « Corrections d’objets » | `backend/test/document-maitre-fr2.test.ts` (§ 17.2) |
| § 30 / § 17.3 cycle de vie de l’objet fiscal (provisoire, actif, suspendu, clos) | Suspension motivée (litige de limites, contestation, habitat informel), levée, clôture à quatre yeux ; garde de liquidation (aucune nouvelle obligation) ; objet en litige en bleu | `POST /v1/fiscal/objects/:id/suspension`, `/reactivation`, `/closure` ; `POST /v1/fiscal/object-closures/:id/decision` ; `GET /v1/fiscal/object-closures` ; panneau « Cycle de vie » (`/fiscal/corrections`) | backend + frontend |
| § 30 bail résilié | Résiliation datée par une partie (bailleur, locataire, mandataire), notification de l’autre partie, bail conservé | `POST /v1/fiscal/leases/:id/resiliation` ; `/fiscal/baux` | backend + frontend |
| § 16.6 couverture locative par avenue, quartier, commune | Effectifs, occupation, bailleurs et locataires, valeur locative annualisée par devise, base vérifiée, obligations payées/impayées, concentration ; estimé et couverture « non mesurés » | `GET /v1/fiscal/couverture-locative` ; `/fiscal/recensement` | backend + frontend |
| § 17.1 couches du cadastre fiscal | Catalogue des 21 couches avec source, route et effectif ; couches sans source « non disponibles », potentiel « non mesuré » | `GET /v1/fiscal/couches` ; `/fiscal/carte` | backend + frontend |
| § 15.2 signature ou refus à la remise | Remise en personne d’un avis formel par l’agent de constat : empreinte de la signature ou refus consigné, position, témoin, valeur probante À VÉRIFIER | `POST /v1/recouvrement/avis/:id/remise` ; `/recouvrement/avis/:id` | backend + frontend |
| § 23 / § 13.4 propriétaire de chaque recours ; indicateur de délai (direction de la régie et audit interne) | Propriétaire dès le dépôt (service compétent), affectation nominative par la direction, instructeur propriétaire par défaut ; indicateurs sans nom ; écran de traitement des recours (les routes d’instruction et de décision existaient sans écran agent) | `POST /v1/appeals/:id/assign`, `GET /v1/appeals/indicateurs`, `GET /v1/appeals/proprietaires` ; écrans `/recours` et `/audit` | backend + frontend |
| § 30 modèle de données ; § 12 matrice d’habilitations | Catalogue vivant des 29 lignes du ch. 30 (états du Cahier ↔ états du code, exhaustivité vérifiée à la compilation, effectifs sans nom) ; 16 rôles du ch. 12 évalués en direct par le point de décision (interdits refusés, facultés câblées, incompatibilités) | `GET /v1/referentiel/modele-donnees`, `GET /v1/referentiel/matrice-habilitations` ; écran `/referentiel/modele-donnees` | backend (dont contrôle négatif) + frontend |

### Différences et contradictions signalées au maître d’ouvrage (rien n’a été supprimé)

1. **Identifiant géographique fiscal (§ 17.2).** Le code existant (`backend/src/plugins/fiscal/geo.ts`) produit `KIN-<commune>-Q<nnn>-<catégorie><n° sur 6>` (ex. `KIN-GOM-Q012-P004517`, catégorie de l’objet, sans voie). Le Cahier propose `KIN-<commune>-<quartier>-<voie>-<n°>` (ex. `KIN-GOM-GOMBE-AV-MONT-001245`, voie, sans catégorie). Les deux formats coexistent : l’existant est conservé, le format du Cahier est ajouté comme alias stable et non réattribuable ; `GET /v1/fiscal/igf/:code` résout l’un et l’autre. Codes de voie (abréviation + premier mot significatif) et de quartier : valeurs de conception, à arrêter avec le cadastre. Arbitrage demandé : format affiché par défaut sur la plaque.
2. **§ 28.1 « L’administrateur de la plateforme ne perçoit aucune part automatique de recette publique »** contredit le modèle du promoteur (§ 37A : clé 10/10/10/70 sur 30 ans, exécution automatique une fois l’acte et la convention enregistrés — décision du maître d’ouvrage du 27/09/2026). Le § 37A n’a PAS été modifié ; avant l’acte, simulation seulement. Contradiction portée à l’arbitrage. (La même tension existe avec la décision n° 10 du ch. 48 « sans pourcentage automatique sur les recettes publiques », hors lot.)
3. **§ 11, modules 59–61** : le Cahier nouvelle version numérote 59 « Contrôle technique et vignette sécurisée », 60 « Fourrières », 61 « Centres agréés » ; la plateforme utilise déjà 59 (grand livre), 60 (coffre des bénéficiaires), 61 (découverte des recettes), et 82–84 (quitus, échéanciers, remboursements) au document maître v3.0. Les modules RFCK sont construits par un autre lot : la collision de numérotation est signalée pour arbitrage.
4. **§ 11, lignes 41–44** : remplacées par le maître d’ouvrage (postes de décision, postes de travail des régies, postes ministériels) : construit par un autre lot (postes de décision).
5. **§ 11, module 4 « Application citoyenne Android »** : la décision du maître d’ouvrage (Android ET iOS) est conservée.
6. **§ 27** remplacé par « Postes de décision des autorités et postes de travail des opérateurs » : construit par le lot postes de décision ; ce lot a seulement confirmé que les anciens tableaux (§ 27.1 huit blocs du Gouverneur, § 27.2 tableaux par profil) existent et sont testés.
7. **Obligation « calculée » / « notifiée » (§ 30)** : la plateforme émet l’obligation et publie l’avis dans la même transaction ; « notifiée » est rapportée à l’existence d’un avis d’imposition opposable (module Recouvrement). À confirmer.
8. **Données de démonstration existantes** : le semis du socle (`backend/src/seed.ts`) contient des noms de personnes et des numéros de téléphone fictifs (antérieurs à ce lot, conservés, non modifiés). Aucun nom ni numéro n’a été ajouté par ce lot.

## Comparaison du chapitre 11 (61 lignes) avec le catalogue de la plateforme

| N° (Cahier FR 2) | Module (Cahier FR 2) | Plateforme | Statut |
|---|---|---|---|
| 1 | Identité et compte contribuable | 1 (même numéro, même objet) | CONSTRUIT |
| 2 | Enrôlement et vérification | 2 (même numéro, même objet) | CONSTRUIT |
| 3 | Portail contribuable | 3 (même numéro, même objet) | CONSTRUIT |
| 4 | Application citoyenne Android | 4 — application citoyenne (PWA Android et iOS) | CONSTRUIT — décision du maître d’ouvrage : Android ET iOS |
| 5 | Portail web public | 5 (même numéro, même objet) | CONSTRUIT |
| 6 | USSD et SMS | 6 (même numéro, même objet) | CONSTRUIT |
| 7 | Gestionnaire de relations contribuable–objet | 7 (même numéro, même objet) | CONSTRUIT |
| 8 | Cadastre fiscal géospatial | 8 (même numéro, même objet) | CONSTRUIT |
| 9 | Intelligence foncière et locative | 9 (même numéro, même objet) | CONSTRUIT |
| 10 | Registre des activités et patentes | 10 (même numéro, même objet) | CONSTRUIT |
| 11 | Véhicules et circulation | 11 (même numéro, même objet) | CONSTRUIT |
| 12 | Autorisations de transport | 12 (même numéro, même objet) | CONSTRUIT |
| 13 | Embarquement et débarquement | 13 (même numéro, même objet) | CONSTRUIT |
| 14 | Stationnement public | 14 (même numéro, même objet) | CONSTRUIT |
| 15 | Publicité extérieure | 15 (même numéro, même objet) | CONSTRUIT |
| 16 | Antennes et infrastructures télécoms | 16 (même numéro, même objet) | CONSTRUIT |
| 17 | Boissons, alcools et tabac | 17 (même numéro, même objet) | CONSTRUIT |
| 18 | Contribution plastique et environnement | 18 (même numéro, même objet) | CONSTRUIT |
| 19 | Assainissement, voirie et drainage | 19 (même numéro, même objet) | CONSTRUIT |
| 20 | Marchés et domaine public | 20 (même numéro, même objet) | CONSTRUIT |
| 21 | Spectacles et événements | 21 (même numéro, même objet) | CONSTRUIT |
| 22 | Carrières et recettes minières | 22 (même numéro, même objet) | CONSTRUIT |
| 23 | Recettes forestières | 23 (même numéro, même objet) | CONSTRUIT |
| 24 | Ports, embarcations et accostage | 24 (même numéro, même objet) | CONSTRUIT |
| 25 | Péage provincial | 25 (même numéro, même objet) | CONSTRUIT |
| 26 | Moteur de règles juridiques et tarifaires | 26 (même numéro, même objet) | CONSTRUIT |
| 27 | Déclaration et liquidation | 27 (même numéro, même objet) | CONSTRUIT |
| 28 | Orchestration des paiements | 28 (même numéro, même objet) | CONSTRUIT |
| 29 | Règlement en trésorerie | 29 (même numéro, même objet) | CONSTRUIT |
| 30 | Rapprochement | 30 (même numéro, même objet) | CONSTRUIT |
| 31 | Quittances électroniques | 31 (même numéro, même objet) | CONSTRUIT |
| 32 | Arriérés et créances | 32 (même numéro, même objet) | CONSTRUIT |
| 33 | Campagnes de recouvrement | 33 (même numéro, même objet) | CONSTRUIT |
| 34 | Recensement terrain | 34 (même numéro, même objet) | CONSTRUIT |
| 35 | Inspection et constat | 35 (même numéro, même objet) | CONSTRUIT |
| 36 | Gestion des dossiers d’exécution | 36 (même numéro, même objet) | CONSTRUIT |
| 37 | Réclamations et recours | 37 (même numéro, même objet) | CONSTRUIT |
| 38 | Gestion documentaire | 38 (même numéro, même objet) | CONSTRUIT |
| 39 | Notifications et communication | 39 (même numéro, même objet) | CONSTRUIT |
| 40 | Renseignement anti-fraude | 40 (même numéro, même objet) | CONSTRUIT |
| 41 | Postes de décision des autorités (ex-Centre de commandement exécutif) | — | EXTERNE-SUIVI — construit par un autre lot (postes de décision) |
| 42 | Poste de travail — régie fiscale | — | EXTERNE-SUIVI — construit par un autre lot (postes de décision) |
| 43 | Poste de travail — régie des taxes | — | EXTERNE-SUIVI — construit par un autre lot (postes de décision) |
| 44 | Postes ministériels | — | EXTERNE-SUIVI — construit par un autre lot (postes de décision) |
| 45 | Salle de contrôle finances et trésorerie | 45 (même numéro, même objet) | CONSTRUIT |
| 46 | Audit et investigation | 46 (même numéro, même objet) | CONSTRUIT |
| 47 | Prévision des recettes | 47 (même numéro, même objet) | CONSTRUIT |
| 48 | Recommandation d’investissement public | 48 (même numéro, même objet) | CONSTRUIT |
| 49 | Gestion des agents IA | 49 (même numéro, même objet) | CONSTRUIT |
| 50 | Apprentissage et connaissance | 50 (même numéro, même objet) | CONSTRUIT |
| 51 | Accès et délégations | 51 (même numéro, même objet) | CONSTRUIT |
| 52 | Intégration et API | 52 (même numéro, même objet) | CONSTRUIT |
| 53 | Administration de la plateforme | 53 (même numéro, même objet) | CONSTRUIT |
| 54 | Transparence publique | 54 (même numéro, même objet) | CONSTRUIT |
| 55 | Supervision et santé du système | 55 (même numéro, même objet) | CONSTRUIT |
| 56 | Grands redevables | 56 (même numéro, même objet) | CONSTRUIT |
| 57 | Registre des exonérations | 57 (même numéro, même objet) | CONSTRUIT |
| 58 | Gestion des équipements terrain | 58 (même numéro, même objet) | CONSTRUIT |
| 59 | Contrôle technique et vignette sécurisée | 59–61 de la plateforme = grand livre, coffre, découverte (conservés) | EXTERNE-SUIVI — lot RFCK (ch. 18) ; collision de numérotation signalée |
| 60 | Fourrières, enlèvement et gardiennage | 59–61 de la plateforme = grand livre, coffre, découverte (conservés) | EXTERNE-SUIVI — lot RFCK (ch. 18) ; collision de numérotation signalée |
| 61 | Centres agréés et tiers de confiance | 59–61 de la plateforme = grand livre, coffre, découverte (conservés) | EXTERNE-SUIVI — lot RFCK (ch. 18) ; collision de numérotation signalée |

Modules 62 à 95 de la plateforme (AVIA, enrôlement assisté, SVI, carte MOSOLO, points agréés, partenaires, titres, stationnement intelligent, billetterie RakaPay, quitus, échéanciers, remboursements, etc.) : conservés, hors du catalogue de 61 lignes du Cahier FR 2 (règle n° 1).

## Matrice exigence → code → test

### 1. Résumé exécutif

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 1 | Compte unique par personne physique ou morale, objets et rôles rattachés | `backend/src/modules/identity/service.ts:43`<br>`backend/src/plugins/acces/service.ts:974` | `backend/test/misc.test.ts:33`<br>`backend/test/acces.test.ts:316` | CONSTRUIT |  |
| 1 | Applique uniquement des règles officiellement validées et versionnées (aucun montant sans règle ACTIVE) | `backend/src/modules/assessment/service.ts:267` | `backend/test/legal.test.ts:29`<br>`backend/test/chaine.test.ts:171` | CONSTRUIT |  |
| 1 | Oriente chaque paiement vers le compte public désigné (bénéficiaire jamais fourni par le client) | `backend/src/modules/payments/service.ts:407` | `backend/test/payments.test.ts:22` | CONSTRUIT |  |
| 1 | Quittance électronique vérifiable par code QR | `backend/src/modules/receipts/service.ts:198` | `backend/test/payments.test.ts:152`<br>`frontend/test/tresor.test.tsx:5` | CONSTRUIT |  |
| 1 | Rapproche automatiquement obligation, paiement, règlement bancaire et comptabilisation | `backend/src/modules/treasury/service.ts:56` | `backend/test/chaine.test.ts:93`<br>`backend/test/treasury-vault.test.ts:45` | CONSTRUIT |  |
| 1 | Preuve d’audit inaltérable de chaque action (journal chaîné) | `backend/src/core/audit.ts:222` | `backend/test/audit-access.test.ts:6`<br>`backend/test/audit-access.test.ts:21` | CONSTRUIT |  |
| 1 | Ne crée aucun impôt, taxe, pénalité ni taux (IA interdite ; règle à quatre visas) | `shared/src/ai.ts:38` | `backend/test/ai-drafts.test.ts:62`<br>`backend/test/opportunites.test.ts:90` | CONSTRUIT |  |
| 1 | N’encaisse pas dans un compte privé (coffre des comptes publics) | `backend/src/modules/vault/service.ts:73` | `backend/test/treasury-vault.test.ts:70`<br>`backend/test/connectors.test.ts:263` | CONSTRUIT |  |
| 1 | Ne transforme pas un signal statistique en dette fiscale | `backend/src/plugins/fiscal/anomalies.ts:324` | `backend/test/fiscalite-parcours-campagnes.test.ts:37`<br>`backend/test/verticales.test.ts:412` | CONSTRUIT |  |
| 1 | Aucun acteur ne modifie seul une dette, n’annule un paiement, ne substitue un bénéficiaire ni n’efface une trace | `backend/src/core/policy.ts:91`<br>`backend/src/core/policy.ts:110` | `backend/test/audit-access.test.ts:50`<br>`backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT | Matrice du ch. 12 évaluée en direct (voir ch. 12). |
| 1 | Quitus fiscal provincial numérique, instantané et vérifiable | `backend/src/plugins/fiscal/clearances.ts:55` | `backend/test/fiscal.test.ts:364`<br>`backend/test/fiscal.test.ts:387` | CONSTRUIT |  |
| 1 | Administration compétente = donnée de configuration (DGRFK/DGTK), jamais codée en dur | `backend/src/modules/rules/service.ts:259`<br>`backend/src/plugins/acces/service.ts:57` | `backend/test/acces.test.ts:400`<br>`backend/test/acces.test.ts:426` | CONSTRUIT | Espaces d’entité et fiches de module (module 72). |
| 1 | Faiblesses TADAT : registre, télépaiement, contrôle interne, audit interne, prévision | `backend/src/plugins/fiscal/geo.ts:102` | `backend/test/chaine.test.ts:57` | CONSTRUIT | Réponses détaillées aux lignes du ch. 4. |
| 1 | Alerte juridique : OL 13/001 abrogée par l’OL 18/004 ; aucune règle sur la nomenclature de 2013 | `backend/src/modules/rules/textes.ts:23` | `backend/test/juridique.test.ts:174`<br>`backend/test/legal.test.ts:76` | CONSTRUIT |  |
| 1 | Pilote de 180 jours dans quatre communes, campagne de février 2027 comme premier test | `backend/src/plugins/pilotage/planification/service.ts:47`<br>`backend/src/plugins/recouvrement/campaigns.ts:2` | `backend/test/planification.test.ts:128`<br>`backend/test/fiscalite-parcours-campagnes.test.ts:315` | CONSTRUIT |  |
| 1 (8 résultats) | Couverture : recensement terrain hors ligne, auto-enrôlement, recoupement partenaires | `backend/src/plugins/fiscal/census.ts:59` | `backend/test/canaux.test.ts:225`<br>`backend/test/opportunites.test.ts:147`<br>`frontend/test/securite-acces-audit.test.tsx:16` | CONSTRUIT |  |
| 1 (8 résultats) | Assiette : objets non enregistrés, régularisation volontaire, requalification contrôlée | `backend/src/plugins/fiscal/anomalies.ts:44` | `backend/test/fiscalite-parcours-campagnes.test.ts:37`<br>`backend/test/reductions.test.ts:272` | CONSTRUIT |  |
| 1 (8 résultats) | Encaissement : Mobile Money, banques, cartes, USSD, QR, agents agréés | `backend/src/modules/payments/service.ts:31` | `backend/test/canaux.test.ts:131`<br>`backend/test/canaux.test.ts:369` | CONSTRUIT |  |
| 1 (8 résultats) | Traçabilité : registre en ajout seul, signature électronique, rapprochement quotidien | `backend/src/modules/treasury/ledger.ts:44` | `backend/test/treasury-vault.test.ts:7`<br>`backend/test/tresor.test.ts:280` | CONSTRUIT |  |
| 1 (8 résultats) | Intégrité : séparation des fonctions, double validation, accès privilégié temporaire, journal immuable | `backend/src/core/policy.ts:235`<br>`backend/src/plugins/acces/elevations.ts:51` | `backend/test/securite-acces-audit.test.ts:157`<br>`backend/test/audit-access.test.ts:6` | CONSTRUIT |  |
| 1 (8 résultats) | Service : compte unique, déclaration pré-remplie, paiement mobile, quittance instantanée | `backend/src/plugins/fiscal/declarations.ts:107` | `backend/test/fiscal.test.ts:203`<br>`backend/test/payments.test.ts:70` | CONSTRUIT |  |
| 1 (8 résultats) | Pilotage : tableau du Gouverneur, cartes de chaleur, files d’exception | `frontend/src/pages/Governor.tsx:280` | `backend/test/misc.test.ts:97`<br>`backend/test/pilotage.test.ts:74` | CONSTRUIT | Le ch. 27 est repris par le lot « postes de décision » (voir ch. 27). |
| 1 (8 résultats) | Affectation : recommandation d’affectation, transparence publique | `backend/src/plugins/pilotage/transparency.ts:123` | `backend/test/planification.test.ts:276`<br>`backend/test/pilotage.test.ts:282` | CONSTRUIT |  |
| 1 | Dix décisions demandées au Gouvernement provincial | — | — | EXTERNE-SUIVI | Chapitre 48 (hors périmètre de ce lot). |

### 2. Argumentaire politique et économique

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 2 | Argumentaire (budget ~1,2 Md USD, 20 M d’habitants, contrat de performance 500 M USD, 40 Md CDF à fin janvier 2026, taux 2 859,2) | — | — | CONTEXTE | Texte d’argumentaire ; chiffres cités par le document, non utilisés comme paramètres (aucun taux inventé). |
| 2 | Cinq causes : recensement partiel, identification faible, dispersion, friction, déperdition | `backend/src/plugins/chaine/service.ts:45` | `backend/test/chaine.test.ts:57` | CONSTRUIT | Réponses aux lignes du ch. 4. |
| 2 | Absorber la déclaration en ligne existante (e-DGRK), ne pas la dupliquer | `backend/src/plugins/fiscal/imports.ts:112` | `backend/test/fiscalite-parcours-campagnes.test.ts:153`<br>`backend/test/fiscalite-parcours-campagnes.test.ts:182` | CONSTRUIT |  |
| 2 | Programme auditable et non prédateur (pas de fermage fiscal) | `backend/src/plugins/pilotage/repartition/service.ts:108` | `backend/test/repartition.test.ts:90` | CONTRADICTION-SIGNALÉE | Voir § 28.1 : le modèle du promoteur (§ 37A) est conservé ; contradiction signalée. |

### 3. Vision du projet

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 3 | Sept questions pour chaque objet et chaque obligation (qui, quoi, où, quelle règle, combien, payé, arrivé et comptabilisé) | `backend/src/plugins/chaine/model.ts:62` | `backend/test/chaine.test.ts:57`<br>`frontend/test/chaine.test.tsx:45` | CONSTRUIT | GET /v1/objects/:id/sept-questions, GET /v1/obligations/:id/chaine. |
| 3 | Chaîne RECENSER → … → PLANIFIER (13 maillons), chaque maillon produit un événement horodaté, signé, inaltérable | `backend/src/plugins/chaine/model.ts:9` | `backend/test/chaine.test.ts:57`<br>`backend/test/chaine.test.ts:93` | CONSTRUIT |  |
| 3 | Pas de quittance sans paiement confirmé | `backend/src/plugins/chaine/invariants.ts:18` | `backend/test/chaine.test.ts:142`<br>`backend/test/chaine.test.ts:195` | CONSTRUIT |  |
| 3 | Pas de paiement sans obligation liquidée | `backend/src/plugins/chaine/invariants.ts:20` | `backend/test/chaine.test.ts:158`<br>`backend/test/obligation-closure.test.ts:6` | CONSTRUIT |  |
| 3 | Pas d’obligation sans règle validée | `backend/src/plugins/chaine/invariants.ts:21` | `backend/test/chaine.test.ts:171` | CONSTRUIT |  |
| 3 | Pas de règle sans texte en vigueur | `backend/src/plugins/chaine/invariants.ts:22` | `backend/test/chaine.test.ts:183`<br>`backend/test/legal.test.ts:76` | CONSTRUIT | Détecteur planifié des ruptures : terrain-qualite-detecteurs.test.ts:95. |
| 3 | Souveraineté : données, référentiel et clés à la Ville ; réversibilité (export signé, restauration) | `backend/src/plugins/socle/exports.ts:65` | `backend/test/socle.test.ts:231`<br>`backend/test/plateforme-integrite.test.ts:255` | CONSTRUIT |  |
| 3 | Légalité stricte : toute règle porte sa référence légale et l’historique de ses versions | `backend/src/modules/rules/service.ts:223` | `backend/test/juridique.test.ts:154`<br>`backend/test/recouvrement.test.ts:96` | CONSTRUIT |  |
| 3 | Un contribuable, un compte, plusieurs objets, plusieurs rôles | `backend/src/plugins/fiscal/relations.ts:15` | `backend/test/fiscal.test.ts:137`<br>`backend/test/fiscalite-parcours-campagnes.test.ts:230` | CONSTRUIT |  |
| 3 | Preuve avant sanction : un signal ouvre une vérification humaine, jamais une taxation automatique | `backend/src/plugins/ia/catalogue.ts:117` | `backend/test/ia.test.ts:284`<br>`backend/test/integrite.test.ts:246` | CONSTRUIT |  |
| 3 | Zéro espèces entre les mains de l’agent | `shared/src/domain.ts:96` | `shared/test/shared.test.ts:124`<br>`backend/test/canaux.test.ts:428`<br>`backend/test/assisted-payment.test.ts:32` | CONSTRUIT |  |
| 3 | Hors ligne d’abord pour le terrain, temps réel pour le pilotage | `frontend/src/lib/offlineQueue.ts:28` | `frontend/test/securite-acces-audit.test.tsx:16`<br>`backend/test/titres.test.ts:331`<br>`backend/test/pilotage.test.ts:74` | CONSTRUIT |  |
| 3 | Minimisation des données (finalité administrative, fiscale ou de service) | `backend/src/plugins/ia/memory.ts:180` | `backend/test/ia.test.ts:338`<br>`backend/test/juridique.test.ts:263` | CONSTRUIT |  |

### 4. Énoncé du problème

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 4 | Registre incomplet → registre géofiscal par objet, identifiant unique, enrôlement continu | `backend/src/plugins/fiscal/geo.ts:153` | `backend/test/fiscal.test.ts:44`<br>`backend/test/document-maitre-fr2.test.ts:58` | CONSTRUIT |  |
| 4 | Absence d’adresse géolocalisée → identifiant géographique fiscal et code QR par objet | `backend/src/plugins/fiscal/properties.ts:122` | `backend/test/fiscal.test.ts:83` | CONSTRUIT |  |
| 4 | Télépaiement non opérationnel → orchestration multicanale vers comptes publics | `backend/src/modules/payments/service.ts:283` | `backend/test/connectors.test.ts:127`<br>`backend/test/payments.test.ts:70` | CONSTRUIT |  |
| 4 | Dispersion des bases → socle unique, API, référentiel partagé | `backend/src/plugins/index.ts:39` | `backend/test/integration.test.ts:16` | CONSTRUIT |  |
| 4 | Contribuable ne sachant quoi, combien, où → espace unique, pré-remplissage, échéancier, notifications | `frontend/src/pages/TaxpayerSpace.tsx:276` | `backend/test/fiscal.test.ts:203`<br>`backend/test/recouvrement.test.ts:445` | CONSTRUIT |  |
| 4 | Contrôle terrain sans données fiables → application hors ligne, dossier d’inspection préparé, géorepérage | `backend/src/plugins/terrain/service.ts:670` | `backend/test/terrain.test.ts:184`<br>`backend/test/fiscal-nearby.test.ts:47` | CONSTRUIT |  |
| 4 | Contrôle interne faible → journal en ajout seul, séparation des fonctions, accès auditeur indépendant | `backend/src/core/policy.ts:108` | `backend/test/audit-access.test.ts:38`<br>`backend/test/pilotage.test.ts:349` | CONSTRUIT |  |
| 4 | Faible prévision → modèle de potentiel par commune, catégorie et objet | `backend/src/plugins/pilotage/planification/service.ts:370` | `backend/test/planification.test.ts:159` | CONSTRUIT | Potentiel « non mesuré » tant qu’aucun modèle certifié n’existe (aucune valeur inventée). |

### 5. Objectifs stratégiques

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 5.1 | Registre géolocalisé des objets, commune par commune | `backend/src/plugins/fiscal/census.ts:97` | `backend/test/fiscalite-parcours-campagnes.test.ts:195` | CONSTRUIT |  |
| 5.2 | Identité fiscale unique et rattachement de tous les objets et rôles | `backend/src/modules/identity/service.ts:53` | `backend/test/misc.test.ts:33`<br>`backend/test/fiscal.test.ts:137` | CONSTRUIT |  |
| 5.3 | Chaque obligation fondée sur une règle validée, datée, référencée, versionnée | `backend/src/plugins/chaine/invariants.ts:61` | `backend/test/legal.test.ts:87`<br>`backend/test/misc.test.ts:58` | CONSTRUIT |  |
| 5.4 | Part électronique dominante à 18 mois (indicateur) | `backend/src/plugins/pilotage/kpis.ts:507` | `backend/test/pilotage.test.ts:229` | EXTERNE-SUIVI | Indicateurs du ch. 40 (kpis.ts, autre lot) ; cible suivie. |
| 5.5 | Paiement → quittance < 1 min ; paiement → rapprochement < 24 h | `backend/src/plugins/pilotage/kpis.ts:523` | `backend/test/pilotage.test.ts:266` | EXTERNE-SUIVI | Indicateurs du ch. 40 (autre lot). |
| 5.6 | Supprimer la manipulation d’espèces par les agents | `shared/src/domain.ts:100` | `backend/test/acces.test.ts:387`<br>`backend/test/canaux.test.ts:681` | CONSTRUIT |  |
| 5.7 | Réduire la déperdition mesurable (non rapprochés, non appariés, annulations, exonérations) | `backend/src/plugins/pilotage/reductions.ts:335` | `backend/test/reductions-gouvernance.test.ts:154` | CONSTRUIT |  |
| 5.8 | Pilotage distinguant potentiel, constaté, encaissé, réglé, rapproché, disponible | `shared/src/domain.ts:64` | `backend/test/pilotage.test.ts:74`<br>`frontend/test/pilotage.test.tsx:12` | CONSTRUIT |  |
| 5.9 | Publier le lien recettes ↔ réalisations publiques par commune | `backend/src/plugins/pilotage/transparency.ts:203` | `backend/test/pilotage.test.ts:282`<br>`backend/test/planification.test.ts:276` | CONSTRUIT |  |
| 5.10 | Capacité des agents : environnement outillé, formé, évalué sur résultats vérifiables | `backend/src/plugins/apprentissage/model.ts:38` | `backend/test/apprentissage.test.ts:78`<br>`backend/test/apprentissage.test.ts:131` | CONSTRUIT |  |

### 6. Analyse juridique et réglementaire

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 6.1 | Tableau des textes de référence (Constitution art. 204, OL 18/004, 18/003, 69/006, 69/009, LOFIP, édits, arrêtés, Code du numérique) | `backend/src/modules/rules/textes.ts:20` | `backend/test/juridique.test.ts:174` | CONSTRUIT |  |
| 6.1 | À vérifier : Loi n° 18/014 et statut consolidé des OL de 1969 | `backend/src/modules/rules/textes.ts:31` | `backend/test/juridique.test.ts:193` | CONSTRUIT | Registre des points juridiques J1–J30. |
| 6.2 | Règle d’or : aucune recette activable sans fiche complète, validée et approuvée (13 champs bloquants) | `shared/src/juridique.ts:64` | `backend/test/juridique.test.ts:154`<br>`frontend/test/juridique.test.tsx:44`<br>`backend/test/juridique.test.ts:85` | CONSTRUIT |  |
| 6.2 | Compte public bénéficiaire verrouillé, double validation pour modification | `backend/src/modules/vault/service.ts:57` | `backend/test/treasury-vault.test.ts:70`<br>`backend/test/tresor-fuites.test.ts:295` | CONSTRUIT |  |
| 6.2 | Approbation et version : rédacteur, valideur juridique, approbateur — quatre yeux obligatoires | `backend/src/modules/rules/service.ts:163` | `backend/test/legal.test.ts:55`<br>`backend/test/legal.test.ts:97` | CONSTRUIT |  |
| 6.3 | Séparation des compétences : provinciale, intérêt commun (clé), ETD, pouvoir central, acte nouveau | `shared/src/juridique.ts:49` | `backend/test/juridique.test.ts:37`<br>`backend/test/juridique.test.ts:62` | CONSTRUIT |  |
| 6.3 | Refus de toute obligation reproduisant un même fait générateur pour un même redevable | `backend/src/modules/assessment/service.ts:276` | `backend/test/integration.test.ts:45`<br>`backend/test/acces.test.ts:433` | CONSTRUIT |  |
| 6.3 | Impôt personnel minimum : communal, non activé ; espace distinct pour les recettes communales | `backend/src/plugins/referentiel/service.ts:149` | `backend/test/recettes-secteurs.test.ts:37` | CONSTRUIT |  |
| 6.4 | Points juridiques à trancher avant production (statut, taux IRL, quittance, échéanciers, partage de données, primes, agrégateurs) | `backend/src/plugins/juridique/points.ts:56` | `backend/test/juridique.test.ts:193`<br>`backend/test/juridique.test.ts:203` | CONSTRUIT |  |

### 7. Paysage des recettes provinciales

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 7.1–7.3 | Paysage des recettes (4 impôts, 5 taxes d’intérêt commun, 10 recettes spécifiques) au statut À VÉRIFIER | `shared/src/recettes.ts:85` | `backend/test/recettes-secteurs.test.ts:37`<br>`frontend/test/recettes-secteurs-operateurs.test.tsx:39` | CONSTRUIT |  |
| 7.2 | Boissons, alcools et tabac : déclaration mensuelle rapprochée des accises | `backend/src/plugins/verticales/secteurs.ts:49` | `backend/test/recettes-secteurs.test.ts:152` | CONSTRUIT |  |
| 7.3 | Débits de boissons : recoupement avec les points de livraison brassicoles | `backend/src/plugins/opportunites/model.ts:268` | `backend/test/opportunites.test.ts:168` | CONSTRUIT |  |
| 7.3 | Publicité : tout panneau sans plaque est non enregistré | `backend/src/plugins/publicite/service.ts:233` | `backend/test/publicite.test.ts:38`<br>`backend/test/publicite-terrain.test.ts:24` | CONSTRUIT |  |
| 7.3 | Antennes : liquidation annuelle automatique (décision du maître d’ouvrage : automatique sur règle ACTIVE) | `backend/src/plugins/verticales/catalogue.ts:242` | `backend/test/recettes-secteurs.test.ts:229`<br>`backend/test/verticales.test.ts:412` | CONSTRUIT | Liquidation proposée tant qu’aucune règle ACTIVE ; automatique sur règle ACTIVE (CLAUDE.md). |
| 7.3 | Carrières : sorties de camions rapprochées des déclarations | `backend/src/plugins/verticales/secteurs.ts:54` | `backend/test/recettes-secteurs.test.ts:191` | CONSTRUIT |  |
| 7.3 | Occupation du domaine public, marchés, parkings : plan géoréférencé, redevance mobile | `backend/src/plugins/verticales/service.ts:191` | `backend/test/verticales.test.ts:107`<br>`backend/test/recettes-secteurs.test.ts:113`<br>`backend/test/parking.test.ts:81` | CONSTRUIT |  |
| 7.3 | Spectacles : autorisation conditionnée, assiette sur billetterie déclarée | `backend/src/plugins/verticales/service.ts:194` | `backend/test/verticales.test.ts:253` | CONSTRUIT |  |

### 8. Nouvelles opportunités de recettes

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 8.1 | Gisements sans texte nouveau (7 pistes) avec priorité | `backend/src/plugins/opportunites/service.ts:3` | `backend/test/opportunites.test.ts:38` | CONSTRUIT |  |
| 8.2 | Gisements exigeant un acte provincial (8 pistes) : voie juridique, risques | `backend/src/plugins/opportunites/service.ts:3` | `backend/test/opportunites.test.ts:38`<br>`backend/test/opportunites.test.ts:90` | CONSTRUIT |  |
| 8.3 | Grille d’évaluation (faisabilité, objectif, autorité, fait générateur, population, méthode, coûts, impacts, 3 scénarios, corruption, contrôle, texte, priorité, pilote) | `backend/src/plugins/opportunites/model.ts:73` | `backend/test/opportunites.test.ts:38`<br>`frontend/test/opportunites.test.tsx:24` | CONSTRUIT | Aucune projection présentée comme acquise ; hypothèses datées et sourcées. |

### 9. Modèle un utilisateur, un compte

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 9.1 | Clé principale NIF ; sinon demande de NIF en arrière-plan | `backend/src/plugins/fiscal/enrolment.ts:24` | `backend/test/fiscalite-parcours-campagnes.test.ts:212` | CONSTRUIT |  |
| 9.1 | Clé de repli : téléphone vérifié par OTP + pièce d’identité légalement acceptée | `backend/src/modules/identity/service.ts:27` | `backend/test/acces.test.ts:91`<br>`backend/test/socle.test.ts:314` | CONSTRUIT |  |
| 9.1 | Personnes morales : NIF, registre du commerce, mandataires nommément habilités | `backend/src/modules/identity/service.ts:12` | `backend/test/acces.test.ts:118`<br>`frontend/test/acces.test.tsx:26` | CONSTRUIT |  |
| 9.1 | Un compte principal par personne, plusieurs rôles et objets | `backend/src/plugins/acces/service.ts:974` | `backend/test/acces.test.ts:316`<br>`backend/test/misc.test.ts:33` | CONSTRUIT |  |
| 9.1 | Aucune fusion automatique sur la seule similitude de noms ; preuve, double validation, réversible | `backend/src/plugins/acces/model.ts:380` | `backend/test/acces.test.ts:480`<br>`backend/test/acces.test.ts:503`<br>`backend/test/canaux.test.ts:282` | CONSTRUIT |  |
| 9.2 | Niveaux N0 à N3 : preuve exigée et droits ouverts | `backend/src/plugins/acces/model.ts:326` | `backend/test/acces.test.ts:132`<br>`backend/test/fiscal.test.ts:155` | CONSTRUIT | N0-A (enrôlement assisté) ajouté par la plateforme. |
| 9.3 | Parcours d’enrôlement par profil (19 profils), la déclaration d’un rôle ouvre une instruction | `shared/src/profiles.ts:40` | `backend/test/fiscalite-parcours-campagnes.test.ts:212`<br>`frontend/test/fiscalite-parcours-campagnes.test.tsx:96` | CONSTRUIT |  |
| 9.4 | Profil unifié : blocs identité, contact, adresse, rôles, objets, situation, preuves, historique, avec classification | `backend/src/modules/identity/service.ts:43`<br>`backend/src/plugins/juridique/classification.ts:2` | `backend/test/juridique.test.ts:243`<br>`backend/test/integration.test.ts:34` | CONSTRUIT | Classification des dépôts C1–C5 ; modèle de données du ch. 30. |
| 9.5 | Une seule saisie : informations vérifiées réutilisées par tous les modules | `backend/src/plugins/fiscal/declarations.ts:83` | `backend/test/fiscal.test.ts:203` | CONSTRUIT |  |
| 9.5 | Vue unique des obligations, objets, échéances, quittances | `frontend/src/pages/TaxpayerSpace.tsx:276` | `backend/test/verticales.test.ts:58`<br>`frontend/test/recouvrement.test.tsx:76` | CONSTRUIT |  |
| 9.5 | Droit de contestation depuis chaque objet, suivi du délai légal | `backend/src/modules/appeals/procedure.ts:25` | `backend/test/recouvrement.test.ts:177`<br>`backend/test/document-maitre-fr2.test.ts:259` | CONSTRUIT |  |
| 9.5 / 13.5 | Mode diaspora : paiement par carte, mandataire local aux droits limités et révocables, quittances à distance, actes notifiés au mandant | `backend/src/modules/payments/service.ts:31`<br>`backend/src/plugins/acces/service.ts:1687` | `backend/test/acces.test.ts:533`<br>`backend/test/securite-acces-audit.test.ts:303`<br>`backend/test/rapprochement-propose.test.ts:157` | CONSTRUIT |  |

### 10. Architecture fonctionnelle

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 10 | Sept domaines fonctionnels propriétaires de leurs données (identité, objets, droit, liquidation, paiement, contrôle, pilotage) | `backend/src/plugins/index.ts:39` | `backend/test/integration.test.ts:16` | CONSTRUIT | Monolithe modulaire : modules du socle et modules d’extension. |
| 10 | Chaque domaine « ne fait pas » (objets ne déterminent pas la propriété, paiement ne crée pas d’obligation, pilotage ne décide pas…) | `backend/src/core/policy.ts:94` | `backend/test/pilotage.test.ts:444`<br>`backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT |  |
| 10 | Faits immuables ; correction par acte contraire motivé, signé, relié à l’original | `backend/src/modules/assessment/service.ts:567` | `backend/test/treasury-vault.test.ts:7`<br>`backend/test/field-appeals.test.ts:79`<br>`backend/test/money-path.test.ts:232` | CONSTRUIT |  |

### 11. Catalogue des modules

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 11 (1–40, 45–58) | Catalogue des 61 modules : lignes 1 à 40 et 45 à 58 identiques (même numéro) au catalogue de la plateforme | `docs/document-maitre/09-compte-unique-architecture-modules.md:187` | `backend/test/verticales.test.ts:39`<br>`backend/test/recettes-secteurs.test.ts:144` | CONSTRUIT | Voir la section « Comparaison du ch. 11 » ci-dessous. |
| 11 (41–44) | Lignes 41–44 remplacées par le maître d’ouvrage (postes de décision, postes de travail des régies, postes ministériels) | — | — | EXTERNE-SUIVI | Construit par un autre lot (postes de décision). |
| 11 (4) | Module 4 « Application citoyenne Android » | `frontend/vite.config.ts:46` | `frontend/test/qr-scan.test.tsx:26` | CONSTRUIT | Décision du maître d’ouvrage : Android ET iOS (PWA) — conservée. |
| 11 (59–61) | Contrôle technique et vignette sécurisée ; fourrières ; centres agréés | — | — | EXTERNE-SUIVI | Construits par un autre lot (RFCK, ch. 18). Collision de numérotation signalée : 59–61 désignent aujourd’hui le grand livre, le coffre et la découverte des recettes. |

### 12. Rôles et matrice d’habilitations

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 12 | Modèle rôles + attributs (territoire, période, dossier, appareil, sensibilité) | `backend/src/core/policy.ts:55` | `backend/test/audit-access.test.ts:99`<br>`backend/test/pilotage.test.ts:165` | CONSTRUIT |  |
| 12 | Action financière sensible : double validation par deux personnes, authentification renforcée, justification | `backend/src/core/policy.ts:235` | `backend/test/treasury-vault.test.ts:70`<br>`backend/test/money-path.test.ts:232` | CONSTRUIT |  |
| 12 (matrice) | Matrice des 16 rôles (voit / peut faire / ne peut jamais) — interdits évalués en direct | `backend/src/plugins/referentiel/matrice-roles.ts:42` | `backend/test/document-maitre-fr2.test.ts:324`<br>`backend/test/document-maitre-fr2.test.ts:364`<br>`frontend/test/document-maitre-fr2.test.tsx:110` | CONSTRUIT-MAINTENANT | GET /v1/referentiel/matrice-habilitations ; écran /referentiel/modele-donnees. |
| 12 (Gouverneur) | Gouverneur : ne peut supprimer une transaction, réécrire une quittance, changer un bénéficiaire, modifier le journal | `backend/src/core/policy.ts:21` | `backend/test/audit-access.test.ts:75`<br>`backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT |  |
| 12 (Super-administrateur) | Super-administrateur : aucune modification de dette, paiement, bénéficiaire, quittance, journal | `shared/src/domain.ts:92` | `backend/test/audit-access.test.ts:50` | CONSTRUIT |  |
| 12 (Administrateur) | Administrateur ministériel : ne peut élargir son propre périmètre | `backend/src/plugins/acces/service.ts:809` | `backend/test/acces.test.ts:199` | CONSTRUIT |  |
| 12 (Juriste) | Juriste : ne crée, ne valide et ne publie pas seul la même règle | `shared/src/domain.ts:91` | `backend/test/legal.test.ts:55` | CONSTRUIT |  |
| 12 (Enquêteur) | Enquêteur : ne sanctionne pas sans décision compétente | `backend/src/plugins/integrite/policy.ts:32` | `backend/test/integrite.test.ts:286`<br>`backend/test/document-maitre-fr2.test.ts:364` | CONSTRUIT |  |
| 12 (Agents) | Recenseur : ni encaisser, ni fixer une dette, ni déterminer la propriété ; contrôleur : ni espèces, ni annulation | `backend/src/core/policy.ts:127` | `backend/test/fiscal.test.ts:70`<br>`backend/test/terrain.test.ts:184` | CONSTRUIT |  |
| 12 (Contribuable, partenaire) | Contribuable : aucune donnée de tiers ; partenaire : strictement les points d’API contractés | `backend/src/core/policy.ts:49` | `backend/test/payments.test.ts:39`<br>`backend/test/verticales.test.ts:348` | CONSTRUIT |  |
| 12.1 | Moindre privilège et séparation des fonctions par conception | `backend/src/core/policy.ts:73` | `backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT |  |
| 12.1 | Quatre yeux : règle, bénéficiaire, annulation, remboursement, exonération, fusion, extraction massive | `backend/src/plugins/socle/exports.ts:26` | `backend/test/legal.test.ts:55`<br>`backend/test/treasury-vault.test.ts:70`<br>`backend/test/tresor.test.ts:62`<br>`backend/test/tresor.test.ts:161`<br>`backend/test/fiscal.test.ts:263`<br>`backend/test/acces.test.ts:480`<br>`backend/test/securite-acces-audit.test.ts:212` | CONSTRUIT |  |
| 12.1 | Accès privilégié juste-à-temps, motivé, tracé, expirant | `backend/src/plugins/acces/elevations.ts:51` | `backend/test/securite-acces-audit.test.ts:157` | CONSTRUIT |  |
| 12.1 | MFA pour tout utilisateur interne ; authentification résistante au hameçonnage pour les rôles sensibles | `backend/src/core/auth.ts:46` | `backend/test/socle.test.ts:373`<br>`backend/test/securite-acces-audit.test.ts:385` | CONSTRUIT |  |
| 12.1 | Liaison appareil–utilisateur des agents, révocation à distance | `backend/src/modules/field/service.ts:98` | `backend/test/field-appeals.test.ts:13`<br>`backend/test/securite-acces-audit.test.ts:267` | CONSTRUIT |  |
| 12.1 | Revue trimestrielle des habilitations ; détection des conflits d’intérêts | `backend/src/plugins/integrite/common.ts:26` | `backend/test/integrite.test.ts:434`<br>`backend/test/fraude-agents.test.ts:312` | CONSTRUIT |  |
| 12.1 | Journalisation intégrale, y compris des consultations de dossiers individuels | `backend/src/plugins/acces/service.ts:71` | `backend/test/acces.test.ts:511`<br>`backend/test/acces.test.ts:551` | CONSTRUIT |  |

### 13. Parcours du contribuable

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 13.1.1 | Création du compte par téléphone et pièce d’identité ; le rôle est indiqué | `backend/src/modules/identity/routes.ts:20` | `backend/test/misc.test.ts:33`<br>`backend/test/acces.test.ts:80` | CONSTRUIT |  |
| 13.1.2 | Déclaration d’un objet (parcelle, unité, commerce, véhicule, panneau, embarcation) | `backend/src/modules/objects/service.ts:16` | `backend/test/misc.test.ts:33`<br>`backend/test/publicite.test.ts:38` | CONSTRUIT |  |
| 13.1.3 | Géolocalisation, identifiant géographique provisoire, pièces demandées | `backend/src/modules/objects/service.ts:31` | `backend/test/fiscal.test.ts:137`<br>`backend/test/verticales.test.ts:179` | CONSTRUIT |  |
| 13.1.4 | Seules les obligations applicables à cet objet, ce lieu et cette période sont affichées | `shared/src/rules.ts:117` | `backend/test/verticales.test.ts:58`<br>`backend/test/fiscalite-parcours-campagnes.test.ts:103` | CONSTRUIT |  |
| 13.1.5 | Après vérification, objet vérifié ; obligation exigible à l’échéance légale | `backend/src/modules/objects/service.ts:239` | `backend/test/fiscal.test.ts:44`<br>`backend/test/pilotage.test.ts:120` | CONSTRUIT |  |
| 13.2 | Déclaration pré-remplie : confirmer ou contester, canal, référence unique, paiement mobile, quittance QR, échéancier avec rappels | `backend/src/plugins/fiscal/declarations.ts:107` | `backend/test/fiscal.test.ts:203`<br>`backend/test/fiscal.test.ts:228`<br>`backend/test/recouvrement.test.ts:420` | CONSTRUIT |  |
| 13.3 | Locataire : bail en quelques minutes, retenue légale calculée, attestation de bail enregistré, bailleur informé | `backend/src/plugins/fiscal/clearances.ts:223`<br>`backend/src/modules/objects/service.ts:420` | `backend/test/fiscal.test.ts:427`<br>`backend/test/misc.test.ts:33`<br>`backend/test/fiscal.test.ts:203` | CONSTRUIT | Retenue : règles IRL v2 (20 % / 15 %) au statut À VÉRIFIER. |
| 13.4 | Contestation typée depuis chaque objet (bien non détenu, activité fermée, véhicule vendu, information erronée, double imposition) | `backend/src/modules/appeals/procedure.ts:25` | `backend/test/recouvrement.test.ts:177`<br>`backend/test/fiscalite-parcours-campagnes.test.ts:254` | CONSTRUIT |  |
| 13.4 | Suspension ou non de l’exigibilité selon la règle légale (effet suspensif décidé par l’autorité) | `backend/src/modules/appeals/service.ts:301` | `backend/test/recouvrement.test.ts:177`<br>`backend/test/recouvrement.test.ts:378` | CONSTRUIT |  |
| 13.4 | Horodatée, affectée au service compétent, suivie jusqu’à la décision motivée | `backend/src/modules/appeals/service.ts:265`<br>`frontend/src/modules/recouvrement/Recours.tsx:148` | `backend/test/document-maitre-fr2.test.ts:241`<br>`frontend/test/document-maitre-fr2.test.tsx:51` | CONSTRUIT-MAINTENANT | Propriétaire du recours dès le dépôt + écran de traitement (instruction R20, décision R21) — les routes existaient sans écran agent. |
| 13.5 | Diaspora : carte en devise autorisée, mandataire limité et révocable, quittances téléchargées, actes notifiés | `backend/src/plugins/acces/service.ts:1687` | `backend/test/securite-acces-audit.test.ts:303`<br>`backend/test/acces.test.ts:533` | CONSTRUIT |  |

### 14. Parcours des utilisateurs gouvernementaux

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 14 | Gouverneur : centre de commandement, écarts du jour, commune en difficulté, demande d’explication → décision tracée | `backend/src/plugins/pilotage/planification/model.ts:257` | `backend/test/planification.test.ts:210`<br>`backend/test/misc.test.ts:97` | CONSTRUIT |  |
| 14 | Ministre des Finances : assignations, campagnes, exceptions de trésorerie (pilotage sur le rapproché) | `backend/src/plugins/pilotage/planification/service.ts:49` | `backend/test/planification.test.ts:191`<br>`backend/test/fiscalite-parcours-campagnes.test.ts:315` | CONSTRUIT |  |
| 14 | Directeur de régie : zones, agents, notifications, contentieux ; charge priorisée par potentiel et risque | `frontend/src/modules/recouvrement/Recours.tsx:148` | `backend/test/recouvrement.test.ts:311`<br>`backend/test/recouvrement-rendement.test.ts:55`<br>`backend/test/document-maitre-fr2.test.ts:259` | CONSTRUIT |  |
| 14 | Chef de centre communal : objets non enregistrés de sa zone, missions, régularisations | `backend/src/plugins/fiscal/anomalies.ts:129` | `backend/test/fiscalite-parcours-campagnes.test.ts:37`<br>`backend/test/terrain.test.ts:184` | CONSTRUIT |  |
| 14 | Juriste : rédaction et proposition de fiche, mise à jour après édit | `backend/src/core/policy.ts:82` | `backend/test/legal.test.ts:87`<br>`backend/test/recouvrement.test.ts:96` | CONSTRUIT |  |
| 14 | Comptable public : relevés, imputation, écarts sans saisie manuelle | `backend/src/plugins/tresor/service.ts:1314` | `backend/test/tresor.test.ts:280`<br>`backend/test/canaux-releve.test.ts:45` | CONSTRUIT |  |
| 14 | Auditeur : échantillon, reconstitution d’une chaîne complète, extraction probante | `backend/src/plugins/pilotage/trail.ts:82` | `backend/test/pilotage.test.ts:349`<br>`backend/test/pilotage.test.ts:396` | CONSTRUIT |  |

### 15. Parcours de l’agent de terrain

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 15.1 | Mission bornée dans le temps et l’espace : objets, itinéraire, documents, consignes | `backend/src/plugins/terrain/model.ts:160` | `backend/test/terrain.test.ts:184`<br>`backend/test/ia.test.ts:203` | CONSTRUIT |  |
| 15.1 | Données téléchargées sur terminal enregistré et chiffré, expiration automatique | `frontend/src/lib/offlineQueue.ts:28` | `frontend/test/securite-acces-audit.test.tsx:16`<br>`frontend/test/securite-acces-audit.test.tsx:58` | CONSTRUIT |  |
| 15.2 | Localiser, vérifier, scanner le QR ou créer un objet provisoire | `backend/src/plugins/fiscal/properties.ts:281` | `backend/test/fiscal.test.ts:110`<br>`backend/test/fiscal-nearby.test.ts:18` | CONSTRUIT |  |
| 15.2 | Coordonnées, photographies selon protocole contrôlé, caractéristiques | `frontend/src/lib/evidenceJpeg.ts:23` | `backend/test/fraude-agents.test.ts:76`<br>`backend/test/parking-field.test.ts:49` | CONSTRUIT |  |
| 15.2 | Constater l’occupation sans conclure à la propriété | `backend/src/plugins/fiscal/situation.ts:71` | `backend/test/fiscal.test.ts:110` | CONSTRUIT |  |
| 15.2 | Notification numérique si la loi l’autorise ; signature recueillie ou refus enregistré | `backend/src/plugins/recouvrement/service.ts:492`<br>`frontend/src/modules/recouvrement/RemiseTerrain.tsx:29` | `backend/test/recouvrement.test.ts:242`<br>`backend/test/document-maitre-fr2.test.ts:287`<br>`frontend/test/document-maitre-fr2.test.tsx:173` | CONSTRUIT-MAINTENANT | POST /v1/recouvrement/avis/:id/remise ; écran de l’avis (/recouvrement/avis/:id). Valeur probante À VÉRIFIER (point juridique). Notification numérique existante inchangée. |
| 15.2 | Ne recevoir aucun paiement : le contribuable paie lui-même | `backend/src/plugins/canaux/assisted.ts:130` | `backend/test/assisted-payment.test.ts:32`<br>`backend/test/canaux.test.ts:428` | CONSTRUIT |  |
| 15.3 | Synchronisation et résolution des conflits (deux agents, contribuable hors ligne, GPS imprécis, objets fusionnés, terminal perdu) | `backend/src/modules/field/service.ts:77` | `backend/test/field-appeals.test.ts:38`<br>`backend/test/field-appeals.test.ts:57`<br>`backend/test/field-appeals.test.ts:13` | CONSTRUIT |  |
| 15.3 | Perte du terminal : révocation à distance, expiration seule des données locales | `backend/src/modules/field/service.ts:26` | `backend/test/field-appeals.test.ts:13`<br>`frontend/test/securite-acces-audit.test.tsx:36` | CONSTRUIT |  |
| 15.3 | Prime calculée sur régularisations confirmées par une quittance payée, jamais sur des espèces | `backend/src/plugins/sanctions/commissions.ts:24` | `backend/test/parking-field.test.ts:170`<br>`backend/test/fraude-agents.test.ts:114`<br>`backend/test/terrain.test.ts:302` | CONSTRUIT | Réserve des agents (§ 37A.5) : décision du maître d’ouvrage conservée. |

### 16. Modèle foncier et intelligence locative

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 16.1 | Structure parcelle → bâtiment → unité → bail → occupation → statut (déclaré, constaté, vérifié, contesté) | `backend/src/modules/objects/service.ts:36`<br>`shared/src/domain.ts:4` | `backend/test/fiscal.test.ts:44`<br>`backend/test/document-maitre-fr2.test.ts:158` | CONSTRUIT |  |
| 16.2 | Taux de l’impôt (22 %) distinct de la retenue (20 % rang 1 ; 15 % rangs 2–4), paramétrés avec leur arrêté | `shared/src/rules.ts:216` | `backend/test/repartition.test.ts:257` | CONSTRUIT | Statut « à vérifier » (décision du maître d’ouvrage). |
| 16.3 | Élargissement d’assiette 2026 (baux emphytéotiques, sociétés immobilières, indemnités de logement) : formulaire propre, cohérence, recours | `backend/src/plugins/fiscal/assiette2026.ts:91` | `backend/test/fiscalite-parcours-campagnes.test.ts:83` | CONSTRUIT |  |
| 16.4 | Six signaux de détection d’anomalies locatives → sortie (visite, notification employeur, enquête, rapprochement, requalification) | `backend/src/plugins/fiscal/anomalies.ts:43` | `backend/test/fiscalite-parcours-campagnes.test.ts:37`<br>`frontend/test/fiscalite-parcours-campagnes.test.tsx:40` | CONSTRUIT |  |
| 16.5 | Carte interne vert / orange / rouge / gris / bleu (objet en litige = bleu) ; public sans donnée individuelle ; agent au minimum | `backend/src/plugins/fiscal/situation.ts:17` | `backend/test/fiscal.test.ts:445`<br>`backend/test/document-maitre-fr2.test.ts:100` | CONSTRUIT | Objet suspendu pour litige de limites ⇒ bleu (ajout § 17.3). |
| 16.6 | Indicateurs de couverture locative par avenue, quartier et commune (estimé, enregistré, occupé/loué, bailleurs/locataires, valeur locative, base, payé/impayé, concentration, couverture) | `backend/src/plugins/fiscal/couverture-locative.ts:55` | `backend/test/document-maitre-fr2.test.ts:177`<br>`frontend/test/document-maitre-fr2.test.tsx:132` | CONSTRUIT-MAINTENANT | GET /v1/fiscal/couverture-locative ; écran /fiscal/recensement. Estimé et taux de couverture « non mesurés » (aucun modèle certifié). |

### 17. Cadastre fiscal géospatial

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 17 | Le cadastre fiscal n’est pas un cadastre de propriété (ne tranche aucun droit réel) | `backend/src/plugins/fiscal/geo.ts:7` | `backend/test/fiscal.test.ts:165` | CONSTRUIT |  |
| 17.1 | 21 couches (communes … potentiel estimé) | `backend/src/plugins/fiscal/couches.ts:28` | `backend/test/document-maitre-fr2.test.ts:213`<br>`frontend/test/document-maitre-fr2.test.tsx:158` | CONSTRUIT-MAINTENANT | GET /v1/fiscal/couches ; écran /fiscal/carte. Ports, infrastructures publiques : « non disponible » ; potentiel : « non mesuré ». |
| 17.2 | Format KIN-<commune>-<quartier>-<voie>-<n°> (ex. KIN-GOM-GOMBE-AV-MONT-001245), stable, non réattribuable, lié au QR | `backend/src/plugins/fiscal/geo.ts:171` | `backend/test/document-maitre-fr2.test.ts:49`<br>`backend/test/document-maitre-fr2.test.ts:58` | CONSTRUIT-MAINTENANT | Ajouté EN PLUS du format territorial existant (KIN-GOM-Q012-P004517), conservé ; résolution croisée GET /v1/fiscal/igf/:code. Différence signalée. |
| 17.2 | L’identifiant relie localisation, catégorie, contribuable, photos, documents, inspections, règles, obligations, paiements, quittances, litiges, audit | `backend/src/plugins/chaine/service.ts:449` | `backend/test/chaine.test.ts:57` | CONSTRUIT |  |
| 17.3 | Objet sans adresse formelle : point GPS + repère de voisinage + photo de façade | `backend/src/plugins/fiscal/geo.ts:73` | `backend/test/document-maitre-fr2.test.ts:49` | CONSTRUIT | Code voie « SV » (sans voie) ; photo et position : constats terrain. |
| 17.3 | Habitat informel : recensement par grappes, identifiant provisoire, aucune conséquence fiscale avant qualification | `backend/src/plugins/fiscal/lifecycle.ts:29` | `backend/test/document-maitre-fr2.test.ts:100`<br>`backend/test/fiscalite-parcours-campagnes.test.ts:195` | CONSTRUIT-MAINTENANT | Suspension « habitat informel à qualifier » : aucune liquidation. |
| 17.3 | GPS imprécis : tolérance par commune, photo horodatée, validation du superviseur | `backend/src/plugins/terrain/routes.ts:175` | `backend/test/terrain.test.ts:324`<br>`backend/test/terrain.test.ts:184` | CONSTRUIT |  |
| 17.3 | Litige de limites : objet en litige, obligations suspendues, renvoi au service foncier | `backend/src/plugins/fiscal/lifecycle.ts:29` | `backend/test/document-maitre-fr2.test.ts:100`<br>`frontend/test/document-maitre-fr2.test.tsx:84` | CONSTRUIT-MAINTENANT | Suspension motivée : aucune nouvelle liquidation, bleu sur la carte ; obligations émises non modifiées d’office. |
| 17.3 | Plusieurs activités à une adresse : un objet par activité ; une entreprise sur plusieurs sites : un compte, plusieurs établissements | `backend/src/plugins/verticales/catalogue.ts:187` | `backend/test/verticales.test.ts:58` | CONSTRUIT |  |
| 17.3 | Immeuble à unités multiples : un bâtiment, plusieurs unités, un bail par unité | `backend/src/modules/objects/service.ts:371` | `backend/test/opportunites.test.ts:194`<br>`backend/test/fiscal.test.ts:44` | CONSTRUIT |  |

### 18. RFCK, contrôle technique et chaîne véhicule (hors lot)

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 18 | RFCK, contrôle technique, fourrières, centres agréés | — | — | EXTERNE-SUIVI | Hors périmètre de ce lot (autre agent). |

### 19. Modèle de paiement et de règlement

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 19.1 | Canaux : Mobile Money, banques, cartes, virements, USSD, QR, agents agréés ; aucun canal exclusif | `backend/src/modules/payments/service.ts:31` | `backend/test/canaux.test.ts:131`<br>`backend/test/connectors.test.ts:127`<br>`backend/test/canaux.test.ts:369` | CONSTRUIT |  |
| 19.2 | Cycle : obligation → référence unique (idempotence, unicité, expiration) → initiation → confirmation signée → règlement → rapprochement → quittance → comptabilisation → exception | `shared/src/domain.ts:37` | `backend/test/payments.test.ts:6`<br>`backend/test/money-path.test.ts:83`<br>`backend/test/chaine.test.ts:93`<br>`backend/test/tresor.test.ts:280` | CONSTRUIT |  |
| 19.3 | États distincts : initié, confirmé, réglé, rapproché, échoué, dupliqué, contrepassé, remboursé, contesté | `shared/src/domain.ts:34` | `shared/test/shared.test.ts:116`<br>`backend/test/payments.test.ts:137`<br>`backend/test/tresor.test.ts:139`<br>`backend/test/tresor.test.ts:161` | CONSTRUIT |  |
| 19.3 | Quittance définitive seulement sur confirmation serveur à serveur ; jamais sur capture d’écran ou message | `backend/src/core/policy.ts:15` | `backend/test/payments.test.ts:70`<br>`backend/test/connectors.test.ts:272` | CONSTRUIT |  |
| 19.4 | Comptes bénéficiaires verrouillés : double validation, authentification renforcée, notification au comité | `backend/src/modules/vault/service.ts:57` | `backend/test/treasury-vault.test.ts:70`<br>`backend/test/tresor-fuites.test.ts:295` | CONSTRUIT |  |
| 19.4 | Anti-rejeu et signature des rappels ; refus des rappels non signés ou hors délai | `backend/src/modules/payments/callback-signing.ts:2` | `backend/test/callback-hmac.test.ts:23`<br>`backend/test/callback-hmac.test.ts:42`<br>`backend/test/payments.test.ts:109` | CONSTRUIT |  |
| 19.4 | Détection des doublons (référence, montant, objet, fenêtre) | `backend/src/modules/payments/service.ts:595` | `backend/test/payments.test.ts:137`<br>`backend/test/money-path.test.ts:123` | CONSTRUIT |  |
| 19.4 | Plafonds et seuils d’alerte par canal, par agent et par point d’encaissement | `backend/src/plugins/integrite/gouvernance/parametres-securite.ts:47` | `backend/test/securite-acces-audit.test.ts:319` | CONSTRUIT | Seuils « par défaut — à confirmer » au registre des seuils. |
| 19.4 | Remboursement seulement si la loi le permet, décision motivée, double validation, écriture contraire | `backend/src/plugins/tresor/service.ts:150` | `backend/test/tresor.test.ts:161`<br>`backend/test/tresor-fuites.test.ts:262` | CONSTRUIT |  |
| 19.4 | Interdiction technique de l’encaissement en espèces par un agent | `shared/src/domain.ts:96` | `backend/test/canaux.test.ts:428`<br>`backend/test/acces.test.ts:387` | CONSTRUIT |  |
| 19.4 | MOSOLO n’est pas une caisse ; habilitation des agrégateurs à confirmer auprès de la BCC | `backend/src/plugins/juridique/points.ts:61` | `backend/test/juridique.test.ts:193` | CONSTRUIT |  |

### 20. Quittance électronique

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 20 | Mentions de la quittance (13 : contribuable, paiement, nature, montant, devise, date, règlement, administration, transaction, QR, signature, statut, vérification) | `backend/src/modules/receipts/service.ts:36` | `backend/test/payments.test.ts:70`<br>`backend/test/rapprochement-propose.test.ts:157` | CONSTRUIT |  |
| 20 | Scan du QR : statut public minimal (valide, en attente, annulée, contrepassée, remplacée, suspecte) | `backend/src/modules/receipts/service.ts:198` | `backend/test/payments.test.ts:152`<br>`backend/test/payments.test.ts:170`<br>`backend/test/tresor.test.ts:104` | CONSTRUIT |  |
| 20 | Page publique sans information personnelle au-delà du strict nécessaire | `backend/src/modules/receipts/service.ts:582` | `backend/test/payments.test.ts:152`<br>`backend/test/tresor.test.ts:339` | CONSTRUIT |  |

### 21. Rapprochement

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 21 | Rapprochement continu, quatre files : paiement sans obligation ; obligation payée sans règlement ; règlement sans paiement ; écart de montant ou de devise | `backend/src/modules/treasury/service.ts:56` | `backend/test/treasury-vault.test.ts:45`<br>`backend/test/tresor.test.ts:206`<br>`backend/test/canaux-releve.test.ts:66` | CONSTRUIT |  |
| 21 | Appariement automatique continu (système, tout écart) | `backend/src/modules/treasury/service.ts:174` | `backend/test/rapprochement-propose.test.ts:56` | CONSTRUIT |  |
| 21 | Rapprochement bancaire quotidien (Trésorerie) : écart > seuil ou > 24 h | `backend/src/plugins/pilotage/kpis.ts:127` | `backend/test/pilotage.test.ts:266`<br>`backend/test/tresor-fuites.test.ts:205` | CONSTRUIT |  |
| 21 | Revue des exceptions quotidienne (contrôle interne) : file non traitée sous 48 h | `backend/src/plugins/tresor/service.ts:32` | `backend/test/tresor.test.ts:256` | CONSTRUIT |  |
| 21 | Clôture comptable mensuelle (comptable public) : écritures non imputées | `backend/src/plugins/tresor/service.ts:1314` | `backend/test/tresor.test.ts:280`<br>`backend/test/money-path.test.ts:253` | CONSTRUIT |  |
| 21 | Audit indépendant trimestriel : toute correction non motivée | `backend/src/plugins/integrite/common.ts:26` | `backend/test/securite-acces-audit.test.ts:144`<br>`backend/test/pilotage.test.ts:349` | CONSTRUIT |  |

### 22. Recouvrement et exécution

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 22 | Rappels amiables J-15 et J-3 (preuve d’envoi conservée) | `backend/src/plugins/recouvrement/parameters.ts:13` | `backend/test/recouvrement.test.ts:400` | CONSTRUIT | Valeurs de conception à certifier (Édit n° 005/2021). |
| 22 | Avis d’échéance dépassée J+1 (référence maintenue) | `backend/src/plugins/recouvrement/parameters.ts:15` | `backend/test/recouvrement.test.ts:311` | CONSTRUIT |  |
| 22 | Relance ciblée J+15 (aucune sanction) | `backend/src/plugins/recouvrement/parameters.ts:17` | `backend/test/recouvrement.test.ts:311` | CONSTRUIT |  |
| 22 | Constat et notification formelle J+30 (motivation, voie de recours) | `backend/src/plugins/recouvrement/parameters.ts:21` | `backend/test/recouvrement.test.ts:311`<br>`backend/test/recouvrement.test.ts:242` | CONSTRUIT |  |
| 22 | Mise en demeure : double validation hiérarchique | `backend/src/plugins/recouvrement/service.ts:59` | `backend/test/recouvrement.test.ts:311`<br>`backend/test/recouvrement.test.ts:369` | CONSTRUIT |  |
| 22 | Mesures d’exécution légales : décision motivée, jamais automatique | `backend/src/plugins/recouvrement/service.ts:140` | `backend/test/recouvrement.test.ts:311`<br>`backend/test/recouvrement.test.ts:369` | CONSTRUIT |  |
| 22 | Plan d’apurement à tout moment, sous réserve d’un acte autorisant l’échéancier | `backend/src/plugins/recouvrement/service.ts:325` | `backend/test/recouvrement.test.ts:445`<br>`backend/test/recouvrement.test.ts:474` | CONSTRUIT |  |
| 22 | Interdiction structurante : aucune sanction, fermeture, immobilisation, pénalité par un algorithme | `shared/src/ai.ts:39` | `backend/test/recouvrement.test.ts:369`<br>`backend/test/parksmart-11a.test.ts:145`<br>`backend/test/recouvrement.test.ts:484` | CONSTRUIT |  |

### 23. Recours et droits du contribuable

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 23.1 | Droit d’accès à ses données et à l’historique des actions | `backend/src/plugins/integrite/routes.ts:254` | `backend/test/integrite.test.ts:389` | CONSTRUIT |  |
| 23.2 | Droit de rectification par la contestation, accusé de réception horodaté | `backend/src/modules/appeals/service.ts:262` | `backend/test/recouvrement.test.ts:177`<br>`backend/test/integrite.test.ts:407` | CONSTRUIT |  |
| 23.3 | Droit d’être informé du fondement légal (référence du texte) | `backend/src/modules/assessment/service.ts:52` | `backend/test/misc.test.ts:58`<br>`backend/test/recouvrement.test.ts:242` | CONSTRUIT |  |
| 23.4 | Recours hiérarchique puis juridictionnel, délais affichés, décompte visible | `backend/src/modules/appeals/procedure.ts:17` | `backend/test/recouvrement.test.ts:212`<br>`backend/test/kinshasa-dates.test.ts:33` | CONSTRUIT |  |
| 23.5 | Droit à la preuve : quittance vérifiable, copie des constats, photographies | `backend/src/plugins/parking/field.ts:5` | `backend/test/parking-field.test.ts:49`<br>`backend/test/payments.test.ts:152` | CONSTRUIT |  |
| 23.6 | Droit à la protection : aucune publication de situation individuelle | `backend/src/plugins/fiscal/map.ts:18` | `backend/test/pilotage.test.ts:282`<br>`backend/test/fiscal.test.ts:445` | CONSTRUIT |  |
| 23.7 | Droit d’être entendu avant toute mesure d’exécution | `backend/src/plugins/recouvrement/service.ts:891` | `backend/test/recouvrement.test.ts:311` | CONSTRUIT |  |
| 23 | Chaque recours a un PROPRIÉTAIRE (service compétent dès le dépôt, agent désigné par la direction) | `backend/src/modules/appeals/service.ts:318` | `backend/test/document-maitre-fr2.test.ts:241`<br>`frontend/test/document-maitre-fr2.test.tsx:51` | CONSTRUIT-MAINTENANT | POST /v1/appeals/:id/assign ; GET /v1/appeals/proprietaires. |
| 23 | Chaque recours a un délai légal et un état | `backend/src/modules/appeals/service.ts:169` | `backend/test/recouvrement.test.ts:177` | CONSTRUIT |  |
| 23 | Chaque recours a une décision motivée | `backend/src/modules/appeals/service.ts:437` | `backend/test/field-appeals.test.ts:79`<br>`backend/test/reductions.test.ts:136` | CONSTRUIT |  |
| 23 | Non-respect du délai : indicateur au tableau du directeur de régie ET de l’audit interne | `backend/src/modules/appeals/service.ts:349`<br>`frontend/src/pages/Audit.tsx:11` | `backend/test/document-maitre-fr2.test.ts:259`<br>`backend/test/recouvrement.test.ts:212`<br>`frontend/test/document-maitre-fr2.test.tsx:43` | CONSTRUIT-MAINTENANT | GET /v1/appeals/indicateurs ; écrans /recours et /audit (existait déjà : « Recours hors délai » au /recouvrement). |

### 24. Architecture des agents d’intelligence artificielle

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 24 | Le socle fiscal fonctionne sans l’IA | `backend/src/plugins/ia/catalogue.ts:169` | `backend/test/ia.test.ts:271` | CONSTRUIT | Coupe-circuit par agent. |
| 24 (1) | Découverte de recettes — ne crée aucune obligation | `backend/src/plugins/ia/catalogue.ts:42` | `backend/test/ia.test.ts:54`<br>`backend/test/opportunites.test.ts:126` | CONSTRUIT |  |
| 24 (2) | Enrôlement — ne valide pas une identité seul | `backend/src/plugins/ia/catalogue.ts:51` | `backend/test/ia.test.ts:54` | CONSTRUIT |  |
| 24 (3) | Apprentissage utilisateur (français et lingala) — pas de conseil juridique opposable | `backend/src/plugins/ia/catalogue.ts:60` | `backend/test/ia.test.ts:302` | CONSTRUIT |  |
| 24 (4) | Copilote agent public — ne signe ni ne notifie | `backend/src/plugins/ia/catalogue.ts:69` | `backend/test/ia.test.ts:163` | CONSTRUIT |  |
| 24 (5) | Veille juridique — ne publie aucune règle sans validation humaine | `backend/src/plugins/ia/catalogue.ts:78` | `backend/test/ia.test.ts:69` | CONSTRUIT |  |
| 24 (6) | Intelligence locative — ne conclut ni à la propriété ni à la fraude | `backend/src/plugins/ia/catalogue.ts:87` | `backend/test/ia.test.ts:69` | CONSTRUIT |  |
| 24 (7) | Mission terrain — n’affecte pas hors périmètre | `backend/src/plugins/ia/service.ts:308` | `backend/test/ia.test.ts:203` | CONSTRUIT |  |
| 24 (8) | Rapprochement — ne corrige pas une écriture sans validation | `backend/src/plugins/ia/catalogue.ts:105` | `backend/test/tresor.test.ts:184` | CONSTRUIT |  |
| 24 (9) | Détection de fraude — n’accuse personne ; ouvre un dossier d’enquête | `backend/src/plugins/ia/catalogue.ts:114` | `backend/test/ia.test.ts:284`<br>`backend/test/integrite.test.ts:272` | CONSTRUIT |  |
| 24 (10) | Prévision — ne fixe pas d’assignation | `backend/src/plugins/ia/catalogue.ts:123` | `backend/test/planification.test.ts:159` | CONSTRUIT |  |
| 24 (11) | Décision exécutive — ne décide pas | `backend/src/plugins/ia/catalogue.ts:132` | `backend/test/ai-drafts.test.ts:39` | CONSTRUIT |  |
| 24 (12) | Affectation des ressources — n’engage aucune dépense | `backend/src/plugins/ia/catalogue.ts:141` | `backend/test/planification.test.ts:276` | CONSTRUIT |  |
| 24 (13) | Apprentissage continu — ne se réentraîne pas silencieusement | `backend/src/plugins/ia/catalogue.ts:150` | `backend/test/planification.test.ts:310` | CONSTRUIT | Agent Communication ajouté par la plateforme (14e fiche). |
| 24.1 | Jeux d’entraînement approuvés, datés ; versionnage, validation humaine, biais, dérive, explicabilité, retour arrière | `backend/src/plugins/ia/modeles.ts:2` | `backend/test/planification.test.ts:310` | CONSTRUIT |  |
| 24.1 | Journal intégral des décisions assistées : entrée, version du modèle, sortie, humain qui a tranché | `backend/src/plugins/ia/service.ts:47` | `backend/test/ia.test.ts:69`<br>`backend/test/ia.test.ts:424` | CONSTRUIT |  |
| 24.1 | Dix interdictions absolues appliquées dans le code (impôt, pénalité, propriété, saisie, suspension de droit, exonération, clôture de recours, transfert, bénéficiaire, destruction de preuve) | `backend/src/core/policy.ts:166` | `backend/test/ai-drafts.test.ts:62`<br>`backend/test/integrite.test.ts:272` | CONSTRUIT |  |

### 25. Apprentissage des utilisateurs et environnement de travail

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 25 | Apprentissage intégré au poste de travail (aide contextuelle) | `frontend/src/modules/apprentissage/AideContextuelle.tsx:12` | `backend/test/apprentissage.test.ts:28`<br>`frontend/test/apprentissage.test.tsx:38` | CONSTRUIT |  |
| 25 | Sept publics et leur mode de validation (contribuables : taux de dossiers complets ; recenseurs : certification avant affectation ; contrôleurs : recertification annuelle ; guichet : évaluation continue ; cadres : résultats vérifiés ; finances : échantillon ; administrateurs : habilitation renouvelable) | `backend/src/plugins/apprentissage/model.ts:38` | `backend/test/apprentissage.test.ts:78`<br>`backend/test/apprentissage.test.ts:131`<br>`backend/test/apprentissage.test.ts:150` | CONSTRUIT |  |
| 25 | Suivi d’activité limité à la sécurité et à l’exploitation ; indicateurs sur résultats vérifiables, pas de surveillance | `backend/src/plugins/apprentissage/model.ts:92` | `backend/test/apprentissage.test.ts:62`<br>`backend/test/ia.test.ts:338` | CONSTRUIT |  |

### 26. Prévention de la fraude et de la déperdition

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 26 (1) | Espèces non déclarées : aucune fonction d’encaissement ; écart constats/paiements ; journal des constats | `backend/src/plugins/integrite/detecteurs/service.ts:43` | `backend/test/terrain-qualite-detecteurs.test.ts:95`<br>`backend/test/canaux.test.ts:428` | CONSTRUIT |  |
| 26 (2) | Fausse quittance : signature et QR ; vérification publique ; registre des quittances | `backend/src/modules/receipts/service.ts:203` | `backend/test/payments.test.ts:170` | CONSTRUIT |  |
| 26 (3) | Changement de bénéficiaire : verrou, double validation ; alerte au comité ; journal | `backend/src/modules/vault/service.ts:57` | `backend/test/treasury-vault.test.ts:70`<br>`backend/test/tresor-fuites.test.ts:313` | CONSTRUIT |  |
| 26 (4) | Annulation/dégrèvement irrégulier : motif, quatre yeux ; statistiques par agent et service ; écriture contraire | `backend/src/plugins/pilotage/reductions.ts:540` | `backend/test/reductions-gouvernance.test.ts:245`<br>`backend/test/tresor.test.ts:92` | CONSTRUIT |  |
| 26 (5) | Exonération indue : registre avec preuve et durée ; revue et alerte ; dossier | `backend/src/plugins/fiscal/exemptions.ts:61` | `backend/test/fiscal.test.ts:263`<br>`backend/test/reductions.test.ts:199` | CONSTRUIT |  |
| 26 (6) | Doublon d’identité : anti-doublon ; rapprochement jamais automatique ; fusion réversible | `backend/src/plugins/acces/service.ts:974` | `backend/test/acces.test.ts:480`<br>`backend/test/canaux.test.ts:282` | CONSTRUIT |  |
| 26 (7) | Collusion agent–contribuable : rotation, séparation ; proximité récurrente ; journal géolocalisé | `backend/src/plugins/integrite/detecteurs/service.ts:43` | `backend/test/terrain-qualite-detecteurs.test.ts:95`<br>`backend/test/integrite-gouvernance.test.ts:150` | CONSTRUIT |  |
| 26 (8) | Faux constat hors zone : géorepérage, horodatage ; distance anormale ; photo, GPS, appareil | `backend/src/plugins/integrite/securite/surveillance.ts:7` | `backend/test/securite-acces-audit.test.ts:284`<br>`backend/test/terrain.test.ts:184` | CONSTRUIT |  |
| 26 (9) | Manipulation de rappel : signature, anti-rejeu ; rejet et alerte ; historique des appels | `backend/src/modules/payments/service.ts:611` | `backend/test/payments.test.ts:98`<br>`backend/test/connectors.test.ts:150` | CONSTRUIT |  |
| 26 (10) | Effacement de trace : écriture unique, sauvegarde indépendante ; empreinte chaînée ; copie hors exploitation | `backend/src/core/audit.ts:185` | `backend/test/securite-acces-audit.test.ts:104`<br>`backend/test/plateforme-integrite.test.ts:190` | CONSTRUIT |  |
| 26.1 | Socle d’intégrité : événements immuables, empreintes chaînées, signatures, horodatage de confiance, registre en ajout seul, partie double, WORM, sauvegarde, double validation, plafonds, verrou des bénéficiaires, anomalies, empreinte d’appareil, géorepérage, plausibilité GPS, intégrité des photos, surveillance des accès privilégiés, prévention des fuites, accès indépendant de l’auditeur | `backend/src/plugins/integrite/securite/horodatage.ts:2`<br>`backend/src/modules/treasury/ledger.ts:44`<br>`backend/src/core/http.ts:74` | `backend/test/securite-acces-audit.test.ts:104`<br>`backend/test/treasury-vault.test.ts:7`<br>`backend/test/socle.test.ts:231`<br>`backend/test/securite-acces-audit.test.ts:267`<br>`backend/test/securite-acces-audit.test.ts:257`<br>`backend/test/fraude-agents.test.ts:76`<br>`backend/test/audit-access.test.ts:38` | CONSTRUIT |  |

### 27. Tableaux de bord → Postes de décision (autre lot)

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 27 | Chapitre remplacé : « Postes de décision des autorités et postes de travail des opérateurs » | — | — | EXTERNE-SUIVI | Construit par le lot postes de décision (autre agent). |
| 27.1 (ancien) | Échelle potentiel → disponible (8 états distincts) — confirmée existante | `shared/src/domain.ts:64` | `backend/test/pilotage.test.ts:74` | CONSTRUIT | Confirmation seulement. |
| 27.1 (ancien) | Huit blocs du Gouverneur et leur action (instructions d’origine ENCAISSEMENT … AFFECTATION) — confirmés existants | `backend/src/plugins/pilotage/planification/model.ts:256` | `backend/test/misc.test.ts:97`<br>`backend/test/planification.test.ts:210` | CONSTRUIT | Confirmation seulement. |
| 27.2 (ancien) | Autres tableaux (cabinet, secrétaire, ministre, régies, trésorerie, juristes, superviseurs, auditeurs, enquêteurs, agents, contribuables, administrateurs, public) — confirmés existants | `backend/src/plugins/pilotage/service.ts:29` | `backend/test/pilotage.test.ts:190`<br>`backend/test/planification.test.ts:254` | CONSTRUIT | Confirmation seulement. |

### 28. Affectation des recettes et planification de l’investissement public

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 28 | Séparation collecte, comptabilisation, répartition légale, trésorerie, crédits, dépense ; aucune répartition discrétionnaire | `backend/src/plugins/pilotage/partage-legal/service.ts:2` | `backend/test/planification.test.ts:337` | CONSTRUIT |  |
| 28.1 | Affectation selon la loi, le budget voté, la trésorerie et la comptabilité publique | `backend/src/plugins/pilotage/planification/model.ts:42` | `backend/test/planification.test.ts:276` | CONSTRUIT |  |
| 28.1 | Clés de répartition légales province / ETD paramétrées et versionnées | `backend/src/plugins/pilotage/partage-legal/service.ts:2` | `backend/test/planification.test.ts:337` | CONSTRUIT |  |
| 28.1 | Incitations de performance : base légale, formule, conditions, plafond, anti-optimisation, fiscalité, approbation, comptabilisation | `backend/src/plugins/sanctions/commissions.ts:24` | `backend/test/commissions-validation.test.ts:45`<br>`backend/test/repartition.test.ts:232` | CONSTRUIT |  |
| 28.1 | « L’administrateur de la plateforme ne perçoit aucune part automatique de recette publique » | `shared/src/rules.ts:236` | `backend/test/repartition.test.ts:143`<br>`backend/test/repartition.test.ts:187` | CONTRADICTION-SIGNALÉE | CONTREDIT le modèle du promoteur (§ 37A : clé 10/10/10/70, exécution automatique après acte — décision du maître d’ouvrage). § 37A NON modifié ; contradiction signalée pour arbitrage. Avant l’acte : simulation seulement. |
| 28.2 | Recommandation d’emploi des fonds : scénarios (montant, source légale, affectation, bénéficiaires, impact, résultat, maturité, coût récurrent, marchés, risques, autorité) | `backend/src/plugins/pilotage/planification/service.ts:30` | `backend/test/planification.test.ts:276` | CONSTRUIT |  |
| 28.2 | L’IA d’affectation propose des scénarios classés ; n’approuve aucune dépense | `backend/src/plugins/ia/catalogue.ts:141` | `backend/test/planification.test.ts:276` | CONSTRUIT |  |
| 28.3 | Tableau public par commune : recettes agrégées et réalisations, sans donnée individuelle | `backend/src/plugins/pilotage/transparency.ts:5` | `backend/test/pilotage.test.ts:282`<br>`backend/test/pilotage.test.ts:333` | CONSTRUIT |  |

### 29. Architecture technique

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 29.1 | Monolithe modulaire orienté domaines ; événementiel pour paiements et audit | `backend/src/plugins/index.ts:39` | `backend/test/integration.test.ts:16` | CONSTRUIT |  |
| 29.1 | Sourcing d’événements pour l’audit et le registre financier (ajout seul) | `backend/src/persistence/store.ts:4` | `backend/test/socle.test.ts:157`<br>`backend/test/plateforme-integrite.test.ts:190` | CONSTRUIT |  |
| 29.2 | Composants : accès (PWA citoyenne et terrain hors ligne, portail, USSD/SMS, passerelle), identité (MFA, passkeys, appareils), domaines, données, intelligence, exploitation | `backend/src/plugins/socle/passkeys.ts:76` | `backend/test/securite-acces-audit.test.ts:385`<br>`backend/test/canaux.test.ts:111`<br>`backend/test/preuves.test.ts:87` | CONSTRUIT | Base spatiale PostGIS : schéma cible (backend/db/schema.sql) ; persistance transitoire JSONB. |
| 29.3 | Séquence paiement : avis → référence → initiation → confirmation signée → règlement → rapprochement → quittance → comptabilisation ; idempotence par référence | `shared/src/domain.ts:37` | `backend/test/chaine.test.ts:93`<br>`backend/test/payments.test.ts:6` | CONSTRUIT |  |
| 29.3 | Séquence synchronisation terrain : attribution → téléchargement chiffré borné → hors ligne → file locale → transmission → conflits → purge | `frontend/src/lib/offlineQueue.ts:29` | `frontend/test/securite-acces-audit.test.tsx:16`<br>`backend/test/field-appeals.test.ts:13`<br>`backend/test/titres.test.ts:331` | CONSTRUIT |  |
| 29.3 | Séquence contrôle d’accès : rôle et attributs → élévation motivée → journalisation de la consultation → expiration | `backend/src/plugins/acces/elevations.ts:51` | `backend/test/securite-acces-audit.test.ts:157`<br>`backend/test/acces.test.ts:511` | CONSTRUIT |  |
| 29.4 | Diagrammes à produire au démarrage (9 : contexte, conteneurs, domaines, flux, paiement, synchronisation, habilitation, décision IA, reprise) | `docs/document-maitre/28-architecture-technique.md:58` | — | CONSTRUIT | Livrable documentaire (document maître, ch. 28 architecture) ; aucun test logiciel applicable. |

### 30. Modèle de données conceptuel

| § | Exigence | Code | Test | Statut | Note |
|---|---|---|---|---|---|
| 30 | Chaque entité porte finalité, champs, relations, validation, cycle de vie, audit, conservation, confidentialité (29 lignes) | `backend/src/plugins/referentiel/modele-donnees.ts:66` | `backend/test/document-maitre-fr2.test.ts:324`<br>`frontend/test/document-maitre-fr2.test.tsx:110` | CONSTRUIT-MAINTENANT | GET /v1/referentiel/modele-donnees ; conservation « par défaut — à confirmer » (dictionnaire = livrable de phase 1). |
| 30 (Utilisateur) | actif, suspendu, clos — Personnel | `backend/src/plugins/acces/model.ts:240` | `backend/test/acces.test.ts:287`<br>`backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT | clos = REVOQUE ou EXPIRE. |
| 30 (Contribuable) | provisoire, vérifié, fusionné — Fiscal sensible | `backend/src/modules/identity/service.ts:31` | `backend/test/acces.test.ts:480`<br>`backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT | provisoire / vérifié : niveau de vérification (N0–N1 / N2–N3). |
| 30 (Identité) | N0 à N3 — Personnel sensible | `shared/src/domain.ts:13` | `backend/test/acces.test.ts:132` | CONSTRUIT |  |
| 30 (Adresse) | déclarée, vérifiée — Personnel | `shared/src/domain.ts:4` | `backend/test/fiscal.test.ts:44` | CONSTRUIT |  |
| 30 (ObjetFiscal) | provisoire, actif, suspendu, clos — Fiscal | `backend/src/modules/objects/service.ts:81` | `backend/test/document-maitre-fr2.test.ts:100`<br>`backend/test/document-maitre-fr2.test.ts:131` | CONSTRUIT-MAINTENANT | suspendu et clos ajoutés (auparavant PROVISOIRE / VALIDE seulement, conservés). |
| 30 (Bail) | déclaré, vérifié, résilié, contesté — Fiscal sensible | `backend/src/modules/objects/service.ts:145` | `backend/test/document-maitre-fr2.test.ts:158`<br>`frontend/test/document-maitre-fr2.test.tsx:98` | CONSTRUIT-MAINTENANT | résilié ajouté (POST /v1/fiscal/leases/:id/resiliation) ; écran /fiscal/baux. |
| 30 (TexteLégal) | en vigueur, modifié, abrogé — Public | `shared/src/domain.ts:27` | `backend/test/recouvrement.test.ts:87`<br>`backend/test/juridique.test.ts:174` | CONSTRUIT |  |
| 30 (Obligation) | calculée, notifiée, payée, contestée, annulée — Fiscal sensible | `shared/src/domain.ts:30` | `backend/test/recouvrement.test.ts:242`<br>`backend/test/reductions.test.ts:155`<br>`backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT | notifiée = avis d’imposition opposable enregistré ; annulée = ANNULEE ou ADMISE_EN_NON_VALEUR. |
| 30 (ÉvénementAudit) | ajout seul — Audit, inaltérable | `backend/src/core/policy.ts:110` | `backend/test/audit-access.test.ts:21` | CONSTRUIT |  |
| 30 (autres entités) | Organisation, Géolocalisation, Parcelle/Bâtiment/Unité, Activité, Véhicule, objets spécifiques, Licence, TypeDeRecette, Exonération, Déclaration, AvisDePaiement, Ordre/Événement de paiement, Règlement/Rapprochement, Quittance, Inspection/Mission/Preuve, Notification, Recours/Pénalité/Dossier, Affectation, Habilitations, IA/Alerte : relations et confidentialité | `backend/src/plugins/referentiel/modele-donnees.ts:66` | `backend/test/document-maitre-fr2.test.ts:324` | CONSTRUIT-MAINTENANT | États de chaque entité vérifiés exhaustifs à la compilation (types du code). |

## Vérification

`npm run typecheck && npm run lint && npm test && npm run build -w frontend` au vert ; `python3 tools/gen_routes.py` exécuté (`specs/routes-api.md`). Tests de ce lot : `backend/test/document-maitre-fr2.test.ts` et `frontend/test/document-maitre-fr2.test.tsx`.

## Limites connues (honnêteté)

- Les paramètres cités par le Cahier (délais J-15/J-3/J+1/J+15/J+30, délais de recours, seuils de rapprochement, plafonds) restent des valeurs de conception « à confirmer » ; aucun taux, tarif ni seuil n’a été inventé.
- Nombre estimé de parcelles et d’unités, taux de couverture du recensement et potentiel estimé : « non mesurés » tant qu’aucun modèle de potentiel certifié n’existe.
- Couches « ports et points d’embarquement », « infrastructures publiques » et tracé des « axes de transport » : aucune donnée géoréférencée dans la plateforme ; déclarées non disponibles (jamais simulées).
- Durées de conservation par entité (ch. 30) : « par défaut — à confirmer » (dictionnaire de données = livrable de phase 1).
- Diagrammes du § 29.4 : livrables documentaires (document maître, architecture), non testables par le logiciel.

