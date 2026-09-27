# Matrice de couverture — modules 41 à 58 (spécification fonctionnelle, lignes 1305–1620)

Légende : BUILT = existait et vérifié par un test ; BUILT-NOW = construit ou complété dans cette passe (avec test) ; ADAPTER = système externe raccordable seulement par convention (adaptateur bac à sable + interface + test + étiquette UI).
Tests backend : `backend/test/*.test.ts` ; tests frontend : `frontend/test/*.test.tsx`. BE = backend, FE = frontend.

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 41 | Échelle des onze états | decision/commandement.ts `ladder` (pilotage.ladder) · GET /v1/decision/commandement · écran /decision/commandement | decision.test.ts:« carte de chaleur… » (ladder.levels = 11) ; FE modules-41-58:« 41 : carte de chaleur… » | BUILT-NOW |
| 41 | Carte de chaleur commune / quartier / catégorie / situation | commandement.ts `commandCentre` (dimension, SITUATIONS) | decision.test.ts:« carte de chaleur par commune, quartier… » | BUILT |
| 41 | Alertes écarts, fraude, retards | commandement.ts `alertFeed` | decision.test.ts:« carte de chaleur… » (byFamily) ; FE 41 | BUILT |
| 41 | Décisions tracées (explication, plan d’action) | POST /v1/decision/commandement/decisions → circuit des instructions | decision.test.ts:« rapport signé vérifiable ; décision tracée… » ; FE 41 (POST) | BUILT |
| 41 | Agréger sans données individuelles | `aggregatesOnly`, aucune clé contribuable | decision.test.ts (not.toContain taxpayerId) | BUILT |
| 41 | Exporter un rapport signé | GET /v1/decision/commandement/rapport (HMAC, verify) | decision.test.ts:« rapport signé vérifiable… » | BUILT |
| 41 | Aucune capacité d’édition financière | politique decision:command.read seulement ; contre-écriture 403 | decision.test.ts:« réservé au Gouverneur… aucune capacité d’édition » | BUILT |
| 41 | Indicateurs écart assignation / rapproché, couverture, alertes critiques | `indicators` (non mesuré + motif si pas d’assignation certifiée) | decision.test.ts:« carte de chaleur… » (gap.measured=false, reason) | BUILT |
| 42 | Assiette et liquidation par recette et commune | decision/regie-fiscale.ts `regieFiscale` · GET /v1/decision/regie-fiscale · écran /decision/regie-fiscale | decision.test.ts:« Module 42 — … périmètre strict » ; FE « 42 et 43 » | BUILT-NOW |
| 42 | Recouvrement : arriérés, campagnes | regie-fiscale.ts `recovery.arrears`, `recovery.campaigns` (validation) | idem | BUILT-NOW |
| 42 | Contentieux : recours et délais | regie-fiscale.ts `litigation` (APPEAL_PROCEDURE.decisionDelayDays) | idem | BUILT-NOW |
| 42 | Performance agents et équipes | regie-fiscale.ts `performance.agents/teams` | idem | BUILT-NOW |
| 42 | Affecter les zones et suivre les agents | zones (lots, missions) + lien /terrain/supervision (affectation existante) | idem ; terrain.test.ts (affectation) | BUILT-NOW |
| 42 | Valider les campagnes | statut de validation + lien /recouvrement/campagnes (lancement à deux) | idem ; fiscalite-parcours-campagnes.test.ts | BUILT |
| 42 | Périmètre limité à la compétence de la régie | OUT_OF_COMPETENCE / NOT_A_FISCAL_REGIE | decision.test.ts:« Module 42 » (DGTK 403, entity=DGTK 403/400) | BUILT-NOW |
| 42 | Indicateurs taux de recouvrement ; délai de contentieux | `indicators` TAUX_RECOUVREMENT, DELAI_CONTENTIEUX | decision.test.ts:« Module 42 » | BUILT-NOW |
| 43 | Recettes par taxe (patente, publicité, stationnement, domaine public) | decision/regie-taxes.ts · GET /v1/decision/regie-taxes · écran /decision/regie-taxes ; rattachement corrigé (domaine public avant publicité) | decision.test.ts:« recettes par taxe… » ; FE « 42 et 43 » | BUILT-NOW |
| 43 | Autorisations : échéances, renouvellements | `authorizations.titres/publicite` | idem | BUILT |
| 43 | Contrôles : résultats | `controls` | idem | BUILT |
| 43 | Périmètre limité à la compétence | OUT_OF_COMPETENCE (DGIPK refusée) | idem | BUILT |
| 43 | Indicateurs recettes par taxe ; renouvellements à temps | `indicators` | idem | BUILT |
| 44 | Modules rattachés par l’administrateur (§ 12A.3) | decision/ministere.ts `modulesOf` (acces.modules) · écran /decision/ministere | decision.test.ts:« filtrage strict… part de 10 % » ; FE « 44 » | BUILT |
| 44 | Part de 10 % calculée, rapprochée, versée | `share` (clé § 37A sur rapproché, SIMULATION sans acte) + versements constatés à quatre yeux | idem | BUILT |
| 44 | Performance par module | `performance` | idem | BUILT |
| 44 | Filtrage strict / aucune consultation hors compétence | `entityFor` (OUT_OF_COMPETENCE) | idem (+ not.toContain('MINFIN')) | BUILT-NOW |
| 44 | Indicateurs recettes par module ; part versée | RECETTES_PAR_MODULE (montants par module), PART_VERSEE | idem (byModule) | BUILT-NOW |
| 45 | Suivi en temps réel règlements, exceptions | decision/salle.ts `view` · écran /decision/salle-controle | decision.test.ts:« temps réel, incidents… escalade » ; FE « 45, 46, 47 » | BUILT |
| 45 | Incidents : propriétaire, sévérité, délai, preuve de clôture | `incidents` | idem | BUILT |
| 45 | Paramètres sensibles : surveillance | `sensitiveParameters` | idem | BUILT |
| 45 | Escalader toute exception hors délai | `escalate` (idempotent, notifications) | idem | BUILT |
| 45 | Aucune correction silencieuse | lecture + escalade seulement (exception inchangée) | idem | BUILT |
| 45 | Indicateurs exceptions ouvertes ; délai de clôture | `indicators` | idem | BUILT |
| 46 | Lecture intégrale preuves et journaux | liens journal, piste d’audit ; reconstitution par référence | decision.test.ts:« mission, échantillon… corrections » | BUILT |
| 46 | Échantillonnage | `drawSample` déterministe · POST …/echantillons | decision.test.ts:« tirage reproductible » | BUILT |
| 46 | Export scellé, chaîne de possession | POST …/scelle, …/remise | decision.test.ts:« mission… export scellé » | BUILT |
| 46 | Racine quotidienne — vérification d’intégrité | audit-missions.ts `dailyRoots` (scellement) + intégrité de la chaîne | decision.test.ts (dailyRoots.available) ; FE « 45, 46, 47 » | BUILT-NOW |
| 46 | Reconstituer une correction | GET /v1/decision/audit/corrections/:ref | decision.test.ts | BUILT |
| 46 | Aucune modification possible | contre-écriture 403 pour l’audit | decision.test.ts | BUILT |
| 46 | Indicateurs missions ; constats ; recommandations suivies | `indicators` ; écran /decision/audit (émission et suivi des recommandations) | decision.test.ts ; FE | BUILT-NOW (écran) |
| 47 | Scénarios prudent / attendu / ambitieux | planification `simulate` (PRUDENT, ATTENDU, TRANSFORMATIONNEL = ambitieux) · /pilotage/scenarios | planification.test.ts:« scénarios » | BUILT |
| 47 | Sensibilité conformité, change, protocoles | HYPOTHESIS_VARIABLES | planification.test.ts (TAUX_CHANGE, DELAI_PROTOCOLES_MOIS) | BUILT |
| 47 | Prévision de trésorerie hebdo par catégorie et commune | decision/prevision.ts · /decision/previsions | decision.test.ts:« Module 47 » | BUILT |
| 47 | Joindre les hypothèses | `hypotheses` + empreinte | idem | BUILT |
| 47 | Ne fixe pas d’assignation | `assignation: 'AUCUNE'`, cibles inchangées | idem | BUILT |
| 47 | Indicateur écart prévision / réalisé | `gap`, indicateur ECART_PREVISION_REALISE (test corrigé : semaines écoulées mesurées) | idem | BUILT-NOW (test) |
| 48 | Capacité disponible selon le budget voté | planification `envelopes` (import + certification 2 personnes), `recommend` plafonné · POST /v1/pilotage/projets/enveloppes[/:id/certification] · écran Projets (EnveloppesBudget) | modules-48-57.test.ts:« Module 48 » ; FE « 54 et 48 » | BUILT-NOW |
| 48 | Scénarios par domaine | PROJECT_DOMAINS | planification.test.ts:« Projets publics… » | BUILT |
| 48 | Fiche projet (montant, bénéficiaires, impact, risques, autorité) | projectSchema | idem | BUILT |
| 48 | Classer ; aucune exécution de dépense ; l’IA propose, l’autorité décide | `recommend` (3 variantes), `decideScenario` | idem ; modules-48-57 (notice) | BUILT |
| 48 | Indicateurs scénarios produits et retenus | listProjects `indicators` | modules-48-57.test.ts:« Module 48 » | BUILT-NOW |
| 49 | Registre modèles, jeux, versions | ia/modeles.ts | planification.test.ts (jeux, mise en service, retour arrière) | BUILT |
| 49 | Registre des prompts versionnés | `prompts()` · GET /v1/ia/prompts · écran /ia/modeles | modules-48-57.test.ts:« registre des prompts… » | BUILT-NOW |
| 49 | Évaluations biais, dérive, explicabilité | évaluations, tests de biais, `monitoring` | planification.test.ts | BUILT |
| 49 | Coupe-circuit | POST /v1/ia/agents/:code/state | ia.test.ts:« coupe-circuit » ; modules-48-57:« coupe-circuit » | BUILT |
| 49 | Journal des décisions assistées | /v1/ia/journal | ia.test.ts:« journal IA » | BUILT |
| 49 | Valider avant mise en service ; revenir en arrière si dérive | promotion à deux, rollback ; `rollbackSuggested` sur dérive | planification.test.ts | BUILT / BUILT-NOW (suggestion) |
| 49 | Interdictions absolues | core/policy `assertAiMay` | modules-48-57.test.ts:« interdictions absolues » | BUILT |
| 49 | Indicateurs dérive détectée ; taux d’acceptation | `indicators()` | modules-48-57.test.ts:« registre des prompts » ; FE (ModelesPage) | BUILT-NOW |
| 50 | Micro-apprentissage contextuel multilingue | apprentissage (fiches, lingala) | apprentissage.test.ts | BUILT |
| 50 | Certification avant affectation, recertification annuelle | certificats, garde terrain | apprentissage.test.ts ; terrain.test.ts | BUILT |
| 50 | Base de procédures versionnée | type PROCEDURE, GET /v1/apprentissage/procedures · écran /apprentissage/procedures ; démo v1→v2 | modules-48-57.test.ts:« Module 50 » ; FE « 56… 50… 57 » | BUILT-NOW |
| 50 | Bloquer l’habilitation d’un agent non certifié | CERTIFICATION_APPRENTISSAGE_MANQUANTE | apprentissage.test.ts | BUILT |
| 50 | Suivi des résultats, pas surveillance intrusive | schémas stricts | apprentissage.test.ts | BUILT |
| 50 | Indicateurs agents certifiés ; taux de réussite | `indicateurs().indicators` | modules-48-57.test.ts:« Module 50 » | BUILT-NOW |
| 51 | RBAC + ABAC (territoire, module, dossier, période, appareil, sensibilité) | acces/delegations.ts `explain` · POST /v1/acces/abac/explication · écran /acces/delegations | acces-equipements.test.ts:« RBAC + ABAC expliqué » | BUILT-NOW |
| 51 | Délégations temporaires, expirantes | `request/decide/end` (sans élévation, non délégables, durée max) | acces-equipements.test.ts:« délégation temporaire… » | BUILT-NOW |
| 51 | Accès juste-à-temps motivé, journalisé | acces/elevations.ts | securite-acces-audit.test.ts | BUILT |
| 51 | Revues trimestrielles / mensuelles privilégiés | integrite reviews | securite-acces-audit.test.ts | BUILT |
| 51 | Détecter les conflits d’intérêts | `detect` (cumul incompatible, agent lié à un contribuable) | acces-equipements.test.ts:« cumul incompatible… » | BUILT-NOW |
| 51 | Révoquer automatiquement à la fin d’une affectation | `sweep` → terrain `expireAssignments` + délégations + comptes | acces-equipements.test.ts:« révocation automatique… » | BUILT-NOW |
| 51 | Comptes partagés interdits | détection COMPTE_PARTAGE (≥ 3 appareils / 24 h) + un compte par personne (existant) | acces-equipements.test.ts:« comptes partagés » | BUILT-NOW |
| 51 | Indicateurs accès revus ; privilèges excessifs | `view().indicators` | acces-equipements.test.ts | BUILT-NOW |
| 52 | API versionnées REST/JSON, événements | plateforme/partenaires.ts · /v1/partenaires/api/v1/… | plateforme.test.ts (tous) | BUILT-NOW |
| 52 | OAuth2 client credentials, portées | POST /v1/oauth/token ; jetons `mpt_` | plateforme.test.ts:« registre des interfaces… » | BUILT-NOW |
| 52 | mTLS facultatif (socle/mtls.ts) | liaison certificat (RFC 8705) | plateforme.test.ts:« liaison TLS mutuel » | BUILT-NOW |
| 52 | Rappels signés | abonnements, HMAC horodaté, transport HTTP ou journal | plateforme.test.ts:« événements signés » | BUILT-NOW |
| 52 | Quotas | par minute / par jour (PAR DÉFAUT) | plateforme.test.ts:« quotas » | BUILT-NOW |
| 52 | Registre des interfaces, contrats, consentements | contrats (protocole signé, 2 personnes) · écran /plateforme/partenaires | plateforme.test.ts ; FE « 52 » | BUILT-NOW |
| 52 | Journaliser chaque appel | `calls` | plateforme.test.ts | BUILT-NOW |
| 52 | Rejeter les appels hors objet contracté | invalid_scope, OUT_OF_CONTRACTED_OBJECT (portée ou prestataire) | plateforme.test.ts | BUILT-NOW |
| 52 | Protocole signé pour chaque échange | contrat ACTIF requis avant tout client | plateforme.test.ts (409) | BUILT-NOW |
| 52 | Indicateurs appels ; erreurs ; disponibilité des partenaires | `view().indicators` | plateforme.test.ts | BUILT-NOW |
| 53 | Environnements recette / pré-prod / prod | plateforme/deploiements.ts · écran /plateforme/administration | plateforme.test.ts:« promotion ordonnée… » ; FE « 53 et 55 » | BUILT-NOW |
| 53 | Déploiements, versions, retour arrière | changements DEPLOIEMENT / RETOUR_ARRIERE | idem | BUILT-NOW |
| 53 | Configuration technique non financière | FINANCIAL_KEY refusée | idem | BUILT-NOW |
| 53 | Validation du comité de contrôle des changements | quorum 2 personnes distinctes (PAR DÉFAUT) | idem | BUILT-NOW |
| 53 | Aucune lecture métier libre ni modification financière | rôles R26/R27 sans politique métier | plateforme.test.ts:« aucune lecture métier libre… » | BUILT-NOW |
| 53 | Indicateurs déploiements réussis ; incidents post-déploiement | `view().indicators` | plateforme.test.ts:« incidents post-déploiement » | BUILT-NOW |
| 54 | Recettes agrégées par commune | pilotage transparence | pilotage.test.ts | BUILT |
| 54 | Réalisations financées par projet | fundedProjects | planification.test.ts | BUILT |
| 54 | Parts de répartition par catégorie (§ 37A.6) | decision/transparence.ts · GET /v1/public/transparence/repartition/:period · écran /transparence | decision.test.ts:« Module 54 » ; FE « 54 et 48 » | BUILT-NOW |
| 54 | Publier après test anti-ré-identification ; aucune donnée individuelle | reidentificationCheck ; seuil de contributeurs sur les parts | pilotage.test.ts ; decision.test.ts | BUILT |
| 54 | Indicateurs consultations ; publications à temps | `indicators` · GET /v1/decision/transparence | decision.test.ts:« Module 54 » | BUILT-NOW |
| 55 | Observabilité métriques, journaux, traces | plateforme/supervision.ts ; GET /v1/plateforme/metrics (Prometheus) ; x-request-id | plateforme.test.ts:« métriques… » | BUILT-NOW |
| 55 | Alertes disponibilité, latence, erreurs | `evaluateAlerts` (99,9 %, p95 PAR DÉFAUT) | plateforme.test.ts:« alertes… » | BUILT-NOW |
| 55 | Incidents : procédure, astreinte | incidents d’exploitation, astreinte, clôture à deux (S1/S2) · écran /plateforme/supervision | plateforme.test.ts:« incident : astreinte… » ; FE | BUILT-NOW |
| 55 | Tenir 99,9 % et le RTO du § 28.6 | cibles, délai de rétablissement vs RTO | idem | BUILT-NOW |
| 55 | Journaux sans secrets ni données inutiles | `loggerOptions` (app.ts), `scrubUrl` | plateforme.test.ts:« journaux sans secrets » | BUILT-NOW |
| 55 | Indicateurs disponibilité ; délai de rétablissement | `view().indicators` | plateforme.test.ts | BUILT-NOW |
| 56 | Portefeuille dédié | verticales/grands-redevables.ts · GET /v1/grands-redevables · écran /grands-redevables | modules-48-57.test.ts:« Module 56 » ; FE | BUILT-NOW |
| 56 | Conventions : déclaration et rapprochement | conventions (base légale, 2 personnes), conformité déclarative | idem | BUILT-NOW |
| 56 | Gestion de cas : garanties, décisions tracées | journal (décision cadre), garanties du recouvrement | idem ; recouvrement-rendement.test.ts (garanties) | BUILT-NOW |
| 56 | Gestionnaire dédié par redevable | `assignManager` (non lié au redevable) | idem | BUILT-NOW |
| 56 | Rotation des gestionnaires | durée max (PAR DÉFAUT), rotation due, ROTATION_REQUIRED | idem | BUILT-NOW |
| 56 | Indicateurs recettes grands redevables ; délais de paiement | `view().indicators` | idem | BUILT-NOW |
| 57 | Demande avec pièces | fiscal/exemptions.ts | fiscal.test.ts | BUILT |
| 57 | Décision double validation | instruct / legalVisa / decide | fiscal.test.ts | BUILT |
| 57 | Échéance et révision automatiques | `runReminders`, `reviewDate`, échéancier horaire · POST /v1/fiscal/exemptions/rappels · écran Exonérations (RegistreExonerations) | modules-48-57.test.ts:« Module 57 » ; FE | BUILT-NOW |
| 57 | Alerter concentration agent ou zone | `concentrationAlerts` (+ AGENT) | modules-48-57.test.ts:« Module 57 » ; fiscal.test.ts | BUILT-NOW |
| 57 | Aucune exonération sans base légale | LEGAL_BASIS_* | fiscal.test.ts | BUILT |
| 57 | Indicateurs actives ; montants ; anomalies | `indicators()` · GET /v1/fiscal/exemptions/registre | modules-48-57.test.ts | BUILT-NOW |
| 58 | MDM enrôlement, politiques, effacement à distance | equipements/service.ts · /v1/equipements/… · écran /terrain/equipements | acces-equipements.test.ts:« enrôlement MDM… », « expiration automatique… » | BUILT-NOW / ADAPTER (outil MDM) |
| 58 | Liaison appareil–utilisateur attestée | défi signé HMAC | acces-equipements.test.ts:« enrôlement MDM… » | BUILT-NOW |
| 58 | Expiration des données automatique | `dataExpiry.purgeBefore`, `expireData` (échéancier) | acces-equipements.test.ts:« expiration automatique… » | BUILT-NOW |
| 58 | Révoquer en masse (suspension d’un sous-traitant) | terrain cascade (existant) + effacement programmé (abonné) | terrain.test.ts ; acces-equipements.test.ts:« révocation en masse » | BUILT / BUILT-NOW |
| 58 | Détection d’appareil modifié | `checkIn` → QUARANTAINE, garde de synchronisation | acces-equipements.test.ts:« appareil modifié… » | BUILT-NOW |
| 58 | Indicateurs terminaux actifs ; incidents ; révocations | `view().indicators` | acces-equipements.test.ts | BUILT-NOW |
| I | Preuve / séparation des pouvoirs / IA assistive / heure serveur | audit sur chaque action ; quatre yeux (contrats, comité, conventions, enveloppes, délégations, levée de quarantaine) ; horloge serveur | tests ci-dessus (403 auto-approbation) | BUILT-NOW |
