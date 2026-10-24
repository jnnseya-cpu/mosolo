# Matrice de couverture — modules 75 à 81 et Partie V (spécification fonctionnelle, lignes 1914–2202)

Légende : BUILT = existant, implémenté et testé ; BUILT-NOW = construit ou complété dans cette passe (y compris la reprise du travail partiel) ; ADAPTER = système externe non raccordable sans convention (adaptateur de bac à sable, interface, tests, libellé « à raccorder »).
Chemins backend relatifs à `backend/src/plugins/`, écrans à `frontend/src/`, tests à `backend/test/` ou `frontend/test/`.

## Partie I — principes communs appliqués aux modules 75 à 81

| Module | Item (court) | Implémentation (fichier/route/écran) | Test (fichier : test) | Statut |
|---|---|---|---|---|
| 75–81 | Légalité : aucun tarif/pénalité sans règle publiée | règles ACTIVE du registre partout (`parking/support.ts activeRule`, `titres liquidatePenalty`, `verticales/avia-auto.ts activeRule`, `ruleCodeFor`) | parksmart-tarification-auto : « à la borne… aucun tarif inventé » ; rakapay-billetterie : « grâce… pénalité » ; avia-auto : « trop-reversé… sans règle ACTIVE : proposition » | BUILT |
| 75–81 | Compte unique / objet | obligations rattachées à un objet du redevable (`occupationObject`, `serviceObject`, `objectFor` AVIA) | verticales-bout-en-bout (17 tests) | BUILT |
| 75–81 | Zéro espèce | `PRIVATE_CHANNELS` sans espèces, commissions payées par l'opérateur, `AGENT_POINT` seul canal espèces | operateurs-publicite : « AC-TKT-01 » ; verticales-bout-en-bout : Markets (agent refusé) | BUILT |
| 75–81 | Preuve (audit horodaté, avant/après) | `parking.pricing.auto_adjusted` (before/after), `avia.auto.*`, `nfiu.*`, `rakapay.offer.price_adjusted`, `rakapay.agent.blocked` | avia-auto, parksmart-tarification-auto, nfiu-situation, rakapay-billetterie | BUILT-NOW |
| 75–81 | Accès (rôles/attributs, pas d'élévation) | `PN.habilitate` (jamais soi-même), limites approuvées par la supervision (pas l'opérateur) | nfiu-situation : « habilitation nominative (jamais soi-même) » ; rakapay-billetterie | BUILT-NOW |
| 75–81 | Séparation des pouvoirs | levée de blocage ≠ décideur ; grâce proposée/approuvée par deux personnes ; acte AVIA à quatre yeux | rakapay-billetterie ; avia-rrh : « arrêté enregistré à quatre yeux » | BUILT-NOW |
| 75–81 | IA assistive (aucune sanction automatique) | recommandations tarifaires jamais appliquées ; mesures AVIA décidées par l'autorité ; blocage préventif = décision motivée | parksmart-11a ; avia-rrh | BUILT |
| 75–81 | Recours | constats RakaPay contestables (`/v1/titres/constats/:id/contestation`) ; observations AVIA après l'avis → réclamation ; recours parking/pub | rakapay-billetterie ; avia-auto ; parking : « vérification puis décision… recours » | BUILT-NOW |
| 75–81 | Inclusion (sans smartphone) | USSD/SMS (titres `supports`), guichet NFIU (`/plates/:code/counter`), coopérative | rakapay : « conducteur : référence… (USSD) » ; verticales : « guichet : obligations payables par plaque » | BUILT |
| 75–81 | Hors ligne | paquet signé Ed25519 + lots HMAC (`/v1/titres/hors-ligne/paquet`, `/controles/lots`) pour wewa/tickets ; IFA vérifiable hors ligne | titres : « paquet signé Ed25519 » ; avia-rrh : « QR… vérifiable hors ligne » | BUILT |
| 75–81 | Heure serveur | `ctx.clock` partout (planificateurs, délais contradictoires, grâce, rapports journaliers) | avia-auto, nfiu-situation (horloge manuelle) | BUILT |

## Module 75 — Stationnement intelligent (ParkSmart)

| Module | Item (court) | Implémentation | Test | Statut |
|---|---|---|---|---|
| 75 | Zones payantes Gombe intégrale, artères | `parking/service.ts createZone/setTariff`, seed `PKZ-GOMBE-INTEGRALE`, `PKZ-BD-30-JUIN` ; écran `/stationnement/regie` | parking : « les zones proposées restent ACTE_REQUIS… », « la régie crée une zone… » | BUILT |
| 75 | Tarification dynamique (heure, zone, demande, événement) | grilles `smart.ts TARIFF_MODES` + **tarification automatique dans les fourchettes de l'acte** `parking/tarification-dynamique.ts` ; routes `GET /v1/parking/tarification-dynamique`, `POST …/run` ; onglet « Tarification automatique » de `/stationnement/parksmart` (`modules/parking/TarificationDynamique.tsx`) | parksmart-11a : « simulation différenciée… » ; parksmart-tarification-auto : 2 tests ; frontend partie5-modules : « Module 75… » | BUILT-NOW |
| 75 | Réservations de voirie | `parking/service.ts reservations`, `/v1/parking/reservations` ; écran régie | parking : « réservation de voirie… » | BUILT |
| 75 | Capteurs et LPR (déploiement progressif) | relevés capteurs `smart.ts recordSensor` (`/v1/parking/zones/:id/sensor-readings`) ; LPR agent = OCR embarqué `components/PlateScanner.tsx` ; capteurs/caméras LPR fixes : flux fournisseur | parksmart-tarification-auto (relevés capteurs) ; qr-scan / parking-pub-smoke (frontend) | ADAPTER (capteurs et caméras fixes : convention fournisseur) |
| 75 | Score de conformité par plaque | `smart.ts plateProfile` (score explicable) ; `/v1/parking/plates/:plate/profile` ; onglet « Plaques » | parksmart-11a : « le classement ne décide rien… » | BUILT |
| 75 | Maintenir 15–25 % de places libres par la tarification | `tarification-dynamique.ts run()` (hausse/baisse d'un pas, bornée) + planificateur horaire idempotent | parksmart-tarification-auto : « saturation → hausse d'un pas… » | BUILT-NOW |
| 75 | Hors fourchette ou sans acte → recommandation | `smart.ts prepareRecommendation` + `runRecommendations` | parksmart-tarification-auto : « à la borne de la fourchette… » ; parksmart-11a : « profil horaire, alertes… » | BUILT-NOW |
| 75 | Prioriser les patrouilles par la donnée | `smart.ts platePriorities` (`/v1/parking/plates/priorities`) | parksmart-11a : « le classement ne décide rien… » | BUILT |
| 75 | Fourrière et blocage par l'autorité compétente | `smart.ts refer` (transmission R20/R21), aucune route de fourrière | parking : « un rouge au contrôle ne crée AUCUNE obligation… (aucune route de fourrière) » | BUILT |
| 75 | Données : ParkingZone, Reservation, capteurs | `parking/service.ts`, `smart.ts SensorReading`, `DynamicRate` | ci-dessus | BUILT-NOW |
| 75 | Intégrations 14, 70, 71, 76 | titres ParkSmart (§ 19A) `smart.defineTitleTypes`, contrôle par plaque, RakaPay offres STATIONNEMENT | parksmart-11a : « la plaque abonnée est VERTE… » | BUILT |
| 75 | Indicateurs : occupation, rotation, recettes/mètre linéaire | `parking/service.ts indicators` (rotation, revenuePerLinearMeter), `smart.occupancy` ; `/stationnement/tableau-de-bord` | parking : « indicateurs agrégés : occupation, rotation… » | BUILT |

## Module 76 — Billetterie multi-opérateurs (RakaPay)

| Module | Item (court) | Implémentation | Test | Statut |
|---|---|---|---|---|
| 76 | Opérateurs : catalogue, prix approuvés, localisation | `rakapay/operateurs.ts` (agrément 4 yeux, offres localisées) ; `/rakapay/operateurs` | operateurs-publicite : « agrément à quatre yeux… », « offre publique : le prix vient d'une règle ACTIVE… » | BUILT |
| 76 | Tickets 1 h à 30 jours | `OFFER_DURATIONS`, types RKP-BUS-* (moteur de titres) | operateurs-publicite (DURATION_NOT_ALLOWED) ; rakapay : « ticket de bus… » | BUILT |
| 76 | Pénalités — % réglementaire du ticket, contestable | `titres/service.ts decideConstat RETENU / liquidatePenalty / contestConstat` (règle `PEN-TITRE-<module>`), `/v1/titres/constats/mine`, `/contestation` ; `ConstatsPanel`, `MesPenalites` (`modules/rakapay/Billetterie.tsx`) | rakapay-billetterie : « grâce approuvée… pénalité… contestée » ; frontend partie5-modules | BUILT-NOW |
| 76 | Multidevise, multilingue | prix `moneySchema` (devise), interface i18n | operateurs-publicite ; language-selector (frontend) | BUILT |
| 76 | Vente app / USSD / point agréé ; SMS de secours | `buyTicket` (canaux), supports SMS/code court | rakapay : « ticket de bus… » | BUILT |
| 76 | Contrôler et tracer toute vente sur infraction | contrôle journalisé → constat → pénalité liquidée rattachée au constat (`penalty.obligationId`) | titres : « constat : le contrôleur auteur ne décide pas… » ; rakapay-billetterie | BUILT-NOW |
| 76 | Commission instantanée selon la grille de l'opérateur | `rakapay/billetterie.ts onSale` (appelé par `recordPrivateSale`), `/v1/rakapay/operateurs/:id/grille-commissions`, `/v1/rakapay/commissions/mes-commissions` ; `OperatorTools` | rakapay-billetterie : « l'opérateur ajuste prix et commissions… » | BUILT-NOW |
| 76 | Analyse quotidienne + ajustement prix/commissions dans les limites approuvées | `billetterie.ts approveLimits / adjustPrice / setGrid / dailyAnalysis` ; routes `/limites`, `/offres/:id/prix`, `/analyse-quotidienne` ; `OperatorTools` + `SupervisedOperators` | rakapay-billetterie ; frontend partie5-modules : « analyse quotidienne et ajustement… » | BUILT-NOW |
| 76 | Audit du comportement + blocage préventif motivé | `operateurs.detectUnusualSales` + `billetterie.block/lift` (`/agents/:userId/blocage`, `/blocages/:id/levee`) | operateurs-publicite : « revue des ventes atypiques… » ; rakapay-billetterie | BUILT-NOW |
| 76 | Séparation comptable privés / publics | `operateurs.circuits` (jamais additionnés) | operateurs-publicite : « AC-TKT-01… » | BUILT |
| 76 | Espèces via point agréé ; agent exclusif sans visibilité croisée | `CASH_NOT_ALLOWED`, `AGENT_EXCLUSIVE`, `NO_CROSS_VISIBILITY` | operateurs-publicite ; rakapay-billetterie (op-agent-b 403) | BUILT |
| 76 | Données Ticket, Merchant | credentials (titres), `Operator`, `Offer`, `PrivateSale`, `AgentCommission` | ci-dessus | BUILT-NOW |
| 76 | Intégrations 12, 14, 20, 25, 70 | titres, offres STATIONNEMENT/ACCES | verticales-bout-en-bout : RakaPay | BUILT |
| 76 | Indicateurs : tickets vendus ; contrôles ; pénalités contestées | `rakapay/service.ts indicators().tickets` (+ `penaltiesRetained`, `penaltiesContested`) ; `titres indicators().constats.contested` ; `/rakapay/pilotage` | rakapay-billetterie (`constats.contested`) ; rakapay : « …indicateurs agrégés » | BUILT-NOW |

## Module 77 — Publicité extérieure augmentée (KIN PUB CONTROL)

| Module | Item (court) | Implémentation | Test | Statut |
|---|---|---|---|---|
| 77 | OCR des références | `publicite/service.ts inspect (ocrMatches)`, `lookup` ; `/publicite/inspection` | publicite : « inventaire… lecture optique » | BUILT |
| 77 | Rechercher automatiquement l'autorisation correspondante | `lookup` + **appariement automatique à l'inspection** (`autoMatched`) ; affiché dans `AdInspector` | publicite-ocr-auto : « le texte lu par OCR retrouve seul le support… » | BUILT-NOW |
| 77 | Dossier de constat — preuves, observations | `AdCase`, photos serveur, `inspectionWeakEvidence` | publicite : « le constat est en ajout seul… » ; parking-field | BUILT |
| 77 | Notification — délais, recours, paiement officiel | `decideCase` (notifiedAt, `noticeOf`), `/cases/:id/contest` | publicite : « le constat est en ajout seul… (contestation) » | BUILT |
| 77 | Supervision — équipes, infractions, recettes | `indicators()` (inspecteurs, byCommune, revenue) ; `/publicite/tableau-de-bord` | publicite : « indicateurs agrégés… » | BUILT |
| 77 | Contrôleur constate, superviseur vérifie, autorité décide | `verifyCase` / `decideCase` | publicite : « dossier non conforme vérifié… » | BUILT |
| 77 | Données InspectionCase, AdvertisingPanel | `AdInspection`, `AdCase`, `AdDevice` | ci-dessus | BUILT |
| 77 | Intégrations 15, 35, 69 | plaque QR, carte, accréditations | publicite-terrain | BUILT |
| 77 | Indicateurs : supports régularisés ; constats validés | `totals.regularized`, **`totals.casesValidated`** ; `AdDashboard` | publicite-ocr-auto ; publicite : « indicateurs agrégés… » | BUILT-NOW |

## Module 78 — Hub de réconciliation aérienne (KIN-AVIA FISCUS) et module 62

| Module | Item (court) | Implémentation | Test | Statut |
|---|---|---|---|---|
| 78 | Connecteurs BSP, GDS, DCS | `verticales/avia-rrh.ts TicketingConnector` (interface), `SandboxTicketingConnector` [EXEMPLE] raccordé, IATA-BSP/GDS « accord requis » ; API compagnie (DCS) | avia-rrh : « rapprochement mensuel automatique… (CONNECTOR_AGREEMENT_REQUIRED) » | ADAPTER (IATA BSP/GDS : accord d'accès requis) |
| 78 | Portail agences — comptes certifiés | `requestAgency/decideAgency/agencyDeclareTickets` | avia-rrh : « flux : agences certifiées à quatre yeux… » | BUILT |
| 78 | IFA dans le QR de la carte d'embarquement | `AviaRrhService.ifaFor`, jeton Ed25519, `/v1/public/verticales/avia/ifa/verify` | avia-rrh : « QR de la carte d'embarquement vérifiable hors ligne… » | BUILT |
| 78 | Rapprochement billets, embarquements, sorties, reversements | `runMonthly/computeLine` | avia-rrh : « rapprochement mensuel automatique… » | BUILT |
| 78/62 | Facturer ou compenser les écarts mensuels — AUTOMATIQUE après arrêté | `verticales/avia-auto.ts` (planificateur mensuel, idempotent, audité ; règle `AVIA-ECART-REVERSEMENT` + `AVIA-TAXE-PASSAGER` ; compensation imputée) ; routes `/v1/verticales/avia/auto*` ; onglet « Écarts mensuels : exécution après arrêté » (`AviaAuto.tsx`) | avia-auto : 3 tests ; frontend partie5-modules : « Modules 62 et 78… » | BUILT-NOW |
| 78/62 | Avant l'arrêté : proposition seulement ; jamais rétroactif | `AviaAutoService.mode()` | avia-auto : « avant l'arrêté : proposition seulement… », « …jamais rétroactif » | BUILT-NOW |
| 78/62 | Procédure contradictoire offerte APRÈS l'avis | `AviaAutoService.observe` → réclamation (circuit commun) ; `AviaAutoAirline` (espace compagnie) | avia-auto (observations, délai expiré) ; frontend partie5-modules : « compagnie : observations… » | BUILT-NOW |
| 78 | Mesures contraignantes seulement après arrêté | `avia-cadre.ts availability/proposeMeasure/decideMeasure` | avia-rrh : « arrêté enregistré à quatre yeux… » | BUILT |
| 62 | Calculer l'écart mensuel par compagnie | `computeLine` (par compagnie et par vol) | avia-rrh | BUILT |
| 78 | Données Flight, AirTaxId, AirReconciliation | `AviaTicket`, `RrhReconciliation`, `AviaAutoExecution` | ci-dessus | BUILT-NOW |
| 78 | Intégrations 52, 62 | reversements banques collectrices, rapprochement | avia-rrh | BUILT |
| 78/62 | Indicateurs : passagers tracés ; écart de reversement | `departuresKpi`, `totals.remittanceGap`, `AviaAutoService.overview().totals` | avia-rrh ; avia-auto | BUILT-NOW |

## Module 79 — Plaque fiscale immobilière (NFIU)

| Module | Item (court) | Implémentation | Test | Statut |
|---|---|---|---|---|
| 79 | Plaque officielle — NFIU, QR, commune, quartier | `verticales/service.ts issuePlate` (signature, code KIN-…) | verticales : « pose dans le territoire seulement… » | BUILT |
| 79 | Statut — occupé ou loué, loyer déclaré | `nfiu.ts fullSituation().occupation` (baux, loyers) | nfiu-situation : « habilitation nominative… situation complète » | BUILT-NOW |
| 79 | Situation — payé, en attente, impayé (avec pénalités) | `fullSituation().obligations` (IF/IRL, payState, pénalités du recouvrement), historique | nfiu-situation ; frontend partie5-modules : « situation complète en lecture seule… » | BUILT-NOW |
| 79 | Agent habilité : situation complète ; rôles minimaux inchangés | `NfiuService.canSeeFull` + habilitations `/v1/verticales/nfiu/habilitations` ; `scanPlate` enrichi ; `NfiuHabilitations`, `NfiuSituation` (console `/verticales/console`) | nfiu-situation (minimal → habilité → révoqué) ; verticales : « scan agent journalisé : accès minimal… » | BUILT-NOW |
| 79 | Paiement sans smartphone — banque ou guichet avec le NFIU | `counterLookup` (`/plates/:code/counter`), ordre AGENT_POINT/BANK | verticales : « …guichet : obligations payables par plaque » | BUILT |
| 79 | Rapports journaliers des agents | `nfiu.ts generate/report/scheduledTick` (planificateur quotidien, idempotent), `/v1/verticales/nfiu/rapports*` ; `dailyReport` enrichi ; `NfiuRapports` | nfiu-situation : « rapports journaliers des agents… » | BUILT-NOW |
| 79 | Montants non modifiables par l'agent ; scan public minimal | aucune route d'écriture, `editable:false` ; `publicPlate` minimal | nfiu-situation (public sans nom ni montant) ; verticales : « vérification publique… » | BUILT |
| 79 | Données Plaques, statuts | `Plate`, `PlateScan`, `NfiuHabilitation`, `NfiuDailyReport` | ci-dessus | BUILT-NOW |
| 79 | Intégrations 8, 9, 71 | objets/IGF, baux, contrôle | verticales-bout-en-bout : Property | BUILT |
| 79 | Indicateurs : maisons immatriculées ; conformité IF et IRL | `NfiuService.indicators()` (`/v1/verticales/nfiu/indicateurs`), `platesIndicators` | nfiu-situation (indicateurs) | BUILT-NOW |

## Module 80 — Contrôle de la dépense publique (CALCU)

| Module | Item (court) | Implémentation | Test | Statut |
|---|---|---|---|---|
| 80 | Registre des comptes publics (non enregistré = irrégulier) | `verticales/calcu.ts accounts` (validation conjointe) ; `/controle/calcu` | verticales : « validation conjointe d'un compte… », « scores vert / ambre / rouge… » | BUILT |
| 80 | Passerelle bancaire sans analyse ni blocage | `receiveTransaction` (jamais bloquée) | verticales : « …jamais de blocage » ; calcu-organe : « …paiement jamais bloqué » | BUILT (flux bancaire réel : ADAPTER convention banques) |
| 80 | Justificatifs devis/BC/engagement/contrat | `registerDocument`, fournisseurs `calcu-controle.ts` | calcu-organe | BUILT |
| 80 | Score vert/orange/rouge | `match()` ; libellés « Vert / Orange / Rouge » (`CalcuConsole.tsx`, harmonisés) | verticales : « scores vert / ambre / rouge… » | BUILT |
| 80 | Rapports PDF horodatés, numéro unique | `calcu-controle.ts reportPdf` (cachet) | calcu-organe : « rapport PDF cacheté… » | BUILT |
| 80 | Détecter surfacturation, fractionnement, doublons, hors objet | `match()` | verticales : « engagement dépassé par cumul… » | BUILT |
| 80 | Ne bloque pas ; secret bancaire | `blocked: 0`, empreinte du numéro de compte | verticales | BUILT |
| 80 | Intégrations 48, 52, 59 ; données | `PublicAccount`, `BankTransaction`, `SupportingDocument`, rapports | calcu-organe | BUILT |
| 80 | Indicateurs : transactions vertes ; montants récupérés | `overview().totals.vert`, `controle.dashboard().recovered` ; `CalcuOrgane.tsx` | calcu-organe : « …tableaux » | BUILT |

## Module 81 — Pass moto-taxis (wewa)

| Module | Item (court) | Implémentation | Test | Statut |
|---|---|---|---|---|
| 81 | Registre motos/conducteurs/stations géoréférencées | `rakapay/service.ts registerMoto/registerDriver`, stations | rakapay : « enregistrement gratuit… » | BUILT |
| 81 | Pass jour/semaine/mois/abonnement, lié plaque+conducteur, non transférable | `WEWA_TYPE`, `/v1/titres/:id/abonnement` | rakapay : « non transférable… » ; titres : « prolongation… abonnement » | BUILT |
| 81 | Supports gilet QR, autocollant, carte, USSD | types `supports` | rakapay : « wewa en vert… gilet » | BUILT |
| 81 | Paiement téléphone / groupé coopérative / point agréé | `buyPass`, `groupPayment` | rakapay : « une référence pour le groupe… » | BUILT |
| 81 | Contrôle protecteur en ligne/hors ligne, vert = rien à payer | `control`, paquets hors ligne | rakapay ; titres : « paquet signé… » | BUILT |
| 81 | Vérification passager | `/v1/public/wewa/:code` | rakapay : « passager : vérification publique minimale… » | BUILT |
| 81 | Espace coopérative (membres, conformité, paiements groupés, alertes) | `coopView` ; `/rakapay/cooperative` | rakapay : « la coopérative ne contrôle pas… » | BUILT |
| 81 | Rappels SMS en phase ambre | titres rappels `ticket.expiring` | parking : « …rappel ambre… » ; titres | BUILT |
| 81 | Enregistrer gratuitement lors des campagnes | registre sans obligation | rakapay : « enregistrement gratuit… » | BUILT |
| 81 | Activer individuellement chaque pass d'un paiement groupé | `groupPayment` | rakapay | BUILT |
| 81 | Statut, conducteur vérifié et validité au contrôleur | `control` (`driverVerified`) | rakapay : « wewa en vert… » | BUILT |
| 81 | Journaliser chaque contrôle | titres `controls` + audit | rakapay | BUILT |
| 81 | Période de grâce PARAMÉTRABLE avant pénalités | `billetterie.ts proposeGrace/decideGrace` (quatre yeux) → `titres.gracePeriods` ; `/v1/rakapay/periode-grace` ; `GracePanel` (`/rakapay/pilotage`) | rakapay-billetterie : « grâce approuvée à quatre yeux… » ; frontend partie5-modules | BUILT-NOW |
| 81 | Aucun encaissement espèces sur la route ; tarif par acte ; aucune immobilisation algorithmique | canaux numériques, règle `DEMO-WEWA-PASS` [EXEMPLE], constats sans montant | rakapay : « pass absent : constat… » | BUILT |
| 81 | Indicateurs : wewa enregistrés ; conformité ; part numérique ; plaintes de prélèvements irréguliers | `indicators()` (+ `complaints.irregularLevies`, `irregularLeviesConfirmed`) ; `/rakapay/pilotage` | rakapay : « …indicateurs agrégés » ; rakapay-billetterie | BUILT-NOW |

## Partie V — verticales de bout en bout (catalogue `verticales/parcours.ts`, panneau `modules/verticales/Parcours.tsx` dans `/services/:slug`)

Chaque parcours : `backend/test/verticales-bout-en-bout.test.ts` (une verticale = un test, application complète, routes réelles) ; cohérence des routes : `partie5-routes-check.test.ts`.

| Verticale | Parcours (étapes) | Implémentation clé | Test | Statut |
|---|---|---|---|---|
| Property | recensement → propriétaire avec preuve → plaque NFIU → IF sur règle publiée → payé visible au scan | `/v1/fiscal-objects`, `/v1/fiscal/relationships`, `/v1/verticales/plates`, `/v1/assessments/calculate`, `/v1/public/verticales/plates/:code` | « MOSOLO Property… » | BUILT-NOW (test) |
| Rental | signal → vérification (aucune dette) → bail → retenue et IRL ([EXEMPLE] ACTIVE) → attestation → campagne préremplie | `/v1/fiscal/anomalies*`, `/v1/leases`, `/v1/fiscal/declarations`, `/attestations`, `/v1/campagnes/:id/pre-remplissage` | « MOSOLO Rental… » | BUILT-NOW (test) |
| Business | établissement → détermination (la règle décide) → autorisation QR → recoupement tiers → grands redevables | `verticales/entreprises.ts` (`/etablissements/:id/obligations`, écran `Determination.tsx`), `/secteurs/donnees-tierces`, `/secteurs/grands-redevables` | « MOSOLO Business… » ; frontend : « entreprises : la règle décide » | BUILT-NOW |
| Mobility | registre → vignette → autorisation de transport → péage (acte requis) → contrôle par plaque | `/v1/verticales/mobilite/*`, `/secteurs/25/releves`, `/vehicules/:plaque/controle` | « MOSOLO Mobility… » | BUILT-NOW (test) |
| Parking | zones → ticket plaque → rappel ambre → contrôle → constat et recours | `/v1/parking/*` | « MOSOLO Parking… » | BUILT-NOW (test) |
| Advertising | recensement QR → autorisation/liquidation → OCR → constat/validation/notification → paiement | `/v1/publicite/*` | « MOSOLO Advertising… » | BUILT-NOW (test) |
| Telecom | listes → rapprochement → avis annuel AUTOMATIQUE sur règle [EXEMPLE] ACTIVE (idempotent, planificateur quotidien) → grands redevables | `/telecom/reconciliation`, `secteurs.ts antennesAuto` (`POST /v1/verticales/secteurs/antennes/liquidation-annuelle/automatique`), exécution manuelle conservée | « MOSOLO Telecom… » | BUILT-NOW |
| Markets | plan → titre d'étal → plaque QR → contrôle sans téléphone | `/marches/plan`, `/stalls/:id/titles`, plaques | « MOSOLO Markets… » | BUILT-NOW (test) |
| Public Domain | demande → titre à durée ([EXEMPLE]) → contrôle (plaque) → libération | `/domaine-public/cases`, liquidation `VX-DP-OCCUPATION` | « MOSOLO Public Domain… » | BUILT-NOW |
| Environment | registre → simulation → activation après édit → déclarations et reversements | `verticales/environnement.ts` ; écran `/verticales/environnement` | « MOSOLO Environment… » ; frontend : « environnement… » | BUILT-NOW |
| Ports | registre → titre d'embarquement (cadrage requis) → manifestes → rapprochement | `/ports/cases`, `/v1/titres/types`, `/secteurs/24/releves` | « MOSOLO Ports… » | BUILT-NOW (test) |
| AVIA | BSP/GDS et portail → IFA → RVA/DGM → rapprochement → facturation des écarts après arrêté | `avia-rrh.ts`, `avia-auto.ts` | « MOSOLO AVIA… » | BUILT-NOW |
| Events | autorisation → billetterie → certificat QR → liquidation et contrôle | `/evenements/*` | « MOSOLO Events… » | BUILT-NOW (test) |
| Construction | sites → bons de sortie (acte requis) → droits de voirie → quitus | `/construction/*`, `/secteurs/22/releves`, `/secteurs/declarations` | « MOSOLO Construction… » | BUILT-NOW (test) |
| Assets | inventaire → évaluation → appel public → revenus domaniaux | `verticales/actifs.ts` ; écran `/verticales/actifs` (`Patrimoine.tsx`) | « MOSOLO Assets… » ; frontend : « patrimoine provincial… » | BUILT-NOW |
| RakaPay | opérateurs accrédités → tickets à durée → achat → contrôle → analyse et blocage | `/v1/rakapay/*`, `billetterie.ts` | « MOSOLO RakaPay… » | BUILT-NOW |
| Recovery | segmentation → campagnes graduées → plan d'apurement → mesures et clôture | `/v1/recouvrement/*` | « MOSOLO Recovery… » | BUILT-NOW (test) |

## Adaptateurs restants (système externe, convention requise)

| Élément | Adaptateur / interface | Raison |
|---|---|---|
| IATA BSP / GDS / TTBS (module 78) | `TicketingConnector`, bac à sable `BSP-BAC-A-SABLE` [EXEMPLE] ; connecteurs réels « Accord d'accès requis » dans l'écran RRH | Accord d'accès aux données IATA et des GDS |
| DCS des compagnies (module 78) | API compagnie `API_COMPAGNIE` (portail) | Convention par compagnie |
| Capteurs de stationnement et caméras LPR fixes (module 75) | route de relevés `/v1/parking/zones/:id/sensor-readings` (maquette de flux) ; LPR agent déjà servi par l'OCR embarqué | Marché fournisseur et convention |
| Flux bancaires réels CALCU (module 80) | passerelle `/v1/verticales/calcu/gateway/transactions` (banque partenaire R33) | Convention avec les banques ; secret bancaire |
| Banques collectrices / BSP (reversements AVIA) | `recordRemittance` (R33/R34) | Protocole de données |

## Décompte par module

| Module | BUILT | BUILT-NOW | ADAPTER |
|---|---|---|---|
| 62 | 1 | 0 | 0 |
| 75 | 7 | 4 | 1 |
| 75–81 | 7 | 4 | 0 |
| 76 | 7 | 7 | 0 |
| 77 | 7 | 2 | 0 |
| 78 | 5 | 1 | 1 |
| 78/62 | 0 | 4 | 0 |
| 79 | 4 | 6 | 0 |
| 80 | 9 | 0 | 0 |
| 81 | 13 | 2 | 0 |
| Partie V | 0 | 17 | 0 |
