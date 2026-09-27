# Couverture visuelle — périmètre « trésor »

*KINSHASA MOSOLO · document maître, annexe I (§ I.26, ajout du 27/09/2026).* Trésor, recouvrement, canaux inclusifs,
RakaPay et titres. Chaque graphique est construit avec la trousse partagée (`components/viz`, charte :
[`charte-visualisation.md`](charte-visualisation.md)) à partir des données **réelles** déjà chargées par l'écran ; aucune
route nouvelle, aucun droit élargi ; une liste vide affiche « Aucune donnée pour cette période », une valeur absente est
« non mesurée » avec son motif ; les montants restent par devise. Rien de l'existant n'a été retiré.

**Vérification (27/09/2026)** : serveur de démonstration (`--demo`, interface compilée), Chromium sans interface,
chaque écran à 360 px et 1280 px (clair) : aucune erreur JavaScript, aucune réponse 5xx, aucun défilement horizontal
(après correction). Seule réponse d'erreur encore journalisée par le navigateur : `404 GET /v1/drafts/treasury-statement`
au premier chargement de `/tresor` — absence de brouillon, **réponse attendue** du module transverse des brouillons
(hors périmètre, testée comme telle côté serveur). Les refus 403 attendus ne sont plus provoqués : l'écran vérifie le
rôle avant d'appeler et affiche un message clair.

| Écran (rôle de contrôle) | Graphiques ajoutés | Source des données | Contrôle fonctionnel |
|---|---|---|---|
| `/tresor` — synthèse (R17 ; aussi R18, R19, R22) | Tuiles : écritures du grand livre (état équilibré), exceptions (délai 48 h), suspens, part comptabilisée, créances sur prestataires ; soldes des comptes **un graphique par devise** ; état comptable des rapprochés ; suspens par ancienneté ; lignes de relevés par jour de valeur (une série par devise, en nombre de lignes) ; relevés par état | `/v1/ledger/balance`, `/v1/tresor/overview`, `/v1/tresor/suspense`, `/v1/settlements/imports` (rôles habilités seulement) | « Vérifier le scellement » → `GET …/grand-livre/verification` 200 et résultat affiché ; R18/R19 : messages « réservé » au lieu d'erreurs 403 |
| `/tresor` › Files d'exception | Exceptions par file (pile ouvertes / en cours / clôturées), exceptions par état (+ au-delà de 48 h) | `/v1/tresor/exceptions` | Filtre par file, « Ouvrir » → tiroir ; affectation, prise en charge, justificatif, proposition, validation à quatre yeux (existants) |
| `/tresor` › Suspens | Suspens par ancienneté (nombre) ; montants par ancienneté, un graphique par devise | `/v1/tresor/suspense` | Lecture ; apurement via « Double validation » |
| `/tresor` › Double validation | Opérations par état ; opérations par nature | `/v1/tresor/operations` | « Proposer » (contrepassation sur référence inconnue) → 404 motivé affiché (refus attendu) |
| `/tresor` › Clôtures et comptabilisation | Écritures par journée clôturée ; journées équilibrées / déséquilibrées ; état comptable des rapprochés ; rapprochés par devise | `/v1/tresor/closures`, `/v1/tresor/accounting` | « Imputer » → 200 ; « Clôturer la journée » → 201 ; « Export CSV signé » → 200 et empreinte affichée |
| `/tresor` › Vérifications publiques | Vérifications par jour empilées par résultat (agrégats, aucun code) | `/v1/tresor/verification-journal` | Lecture |
| `/tresor` › Relevés, grand livre, coffre | Relevés par état ; relevés et compte public par devise ; délai des clôtures ; comptes verrouillés par nature ; demandes de changement par état | `/v1/settlements/imports`, `/v1/tresor/grand-livre/indicateurs`, `/v1/beneficiary-accounts` | Dépôt de relevé, validation, veto (existants) |
| `/tresor/appariements` (R17) | Tuiles (crédits en exception, candidats proposables, propositions, confirmés) ; score des candidats avec repère du seuil servi ; propositions par état | `/v1/tresor/appariements` | Lecture ; proposer / confirmer (existants, quatre yeux) |
| `/tresor/points-agrees` (R17) | Tuiles ; contrats par état ; carte des 24 communes (points) ; retards de versement ; pénalités par état | `/v1/tresor/points` | Lecture ; contrat, pénalité proposée / décidée (existants) |
| `/recouvrement` (R20, R21) | Balance âgée **par devise** ; carte des communes ; arriérés par segment ; profil de risque (aide, aucune mesure) ; décisions ; échéanciers par état ; jauges « taux de régularisation » et « avis lus » (sans cible) | `/v1/recouvrement/arrieres`, `…/indicateurs`, `…/echeanciers` | « Exécuter la planification » → 200 et message ; onglets ; « Ouvrir » → tiroir |
| `/recouvrement/avis/:id` | Chronologie de la notification (émission, envois, remise, lecture) ; envois par résultat | `/v1/recouvrement/avis/:id/preuve` | Accusé de lecture, remise terrain (existants) |
| `/mes-arrieres` (R30) | Tuiles (arriérés, échéances, avis non lus, réclamations) ; frise des échéances ; échéances d'échéancier par état | `/v1/recouvrement/mes-arrieres`, `/v1/appeals` | Lecture ; demande d'échéancier, observations, réclamation (existants) |
| `/recours` (R20) | Tuiles (en cours, hors délai, échéance proche, décidés) ; recours par état ; par délai ; recours déposés par mois | `/v1/appeals`, `/v1/appeals/indicateurs` | Onglets ; instruction / décision (existants) |
| `/recouvrement/remises` (R20) | Remises par état ; montants demandés / accordés par devise | `/v1/recouvrement/remises` | Demande, instruction, décision (existants) |
| `/recouvrement/non-valeurs` (R20) | Admissions par état ; montants proposés / admis par devise | `/v1/recouvrement/non-valeurs` | Proposition, décision (existants) |
| `/recouvrement/campagnes` (R06) | Frise du calendrier (échéances, relances) ; campagnes par état ; communes couvertes ; messages simulés par canal ; cibles par groupe (test / témoin / réserve / exclues) ; contacts et visites | `/v1/campagnes`, `…/calendrier`, `/v1/campagnes-recouvrement` | « Simuler » → 200 ; débordement à 360 px corrigé |
| `/recouvrement/rendement` (R06) | Brut, coûts et net par devise (net « non mesuré » tant que les coûts ne sont pas saisis) ; dossiers chiffrés ; garanties ; file priorisée par commune | `/v1/recouvrement/rendement`, `…/priorites` | Saisie d'un coût, garanties (existants) |
| `/canaux/ussd` (tous ; indicateurs pour les agents) | Tuiles de la session ; sessions par canal ; opérations à la voix ; appels par langue | Session USSD/SVI ; `/v1/channels/indicators` (agents) | « Appeler » → 201 ; touche 1 + envoyer → 200, demande du code secret |
| `/points-de-paiement` (public) | Tuiles du réseau ; carte des 24 communes ; points par type — EXEMPLE | `/v1/public/payment-points` | Filtre par commune ; vérification d'un code → réponse ou limitation de fréquence (anti-énumération, attendue) |
| `/canaux/verifier-carte` | Verdict public inchangé ; pour les agents : cartes par état, vérifications par code court | `/v1/channels/indicators` | Vérification par jeton (existant) |
| `/canaux/contestation` (R12) | Obligations de la personne par état ; frise des échéances contestables | `/v1/taxpayers/:id` | Recherche `TP-DEMO-0001` → obligations et graphiques ; enregistrement (existant) |
| `/canaux/enrolement` (R09, R10) | Tuiles ; dossiers par état, par commune, par lieu, par langue ; dossiers par jour — EXEMPLE | `/v1/assisted-enrolments` | Saisie hors ligne, synchronisation signée, revue des doublons (existants) |
| `/canaux/carte/:numéro` (R12) | Sommes dues par devise ; frise des échéances de l'avis ; cartes par état (agents) — hors impression | `/v1/pictogram-notices/:id`, `/v1/channels/indicators` | Imprimer, bloquer, réémission, code secret (existants) |
| `/canaux/point-agree` (R32) | Tuiles du jour de caisse ; attendu / compté / versé par devise ; encaissements par heure (Kinshasa) — EXEMPLE | `/v1/payment-points/:id/cash-days/:jour` | Référence inconnue → 422 motivé ; carte → situation → « Générer la référence » → 201, référence affichée |
| `/canaux/points-supervision` (R17) | Points par état ; points actifs par commune ; encaissements du jour par point ; communes couvertes ; enrôlements par commune ; cartes par état ; usage des canaux | `/v1/payment-points`, `/v1/channels/indicators` | Référencement, activation, décisions (existants) |
| `/canaux/jour-de-caisse` (R17) | Sans point choisi : réseau ; avec point : caisse du jour ; relevés (appariées / en attente) | `/v1/payment-points`, `…/cash-days/…`, `/v1/settlements/statements` | Constatation proposée / approuvée (existants) |
| `/titres/controle` (R10) | Tuiles du contrôleur (constats, file hors ligne, paquet) ; constats par état, par motif, par jour | `/v1/titres/constats`, paquet hors ligne | « Télécharger le paquet » → paquet affiché ; plaque `KN-M 20417` → 201 « VALIDE » |
| `/titres/catalogue` (public ; indicateurs R01…) | Tuiles ; types par statut d'acte ; types par module ; supports ; résultats des contrôles ; titres par état ; part en rouge ; renouvellements ; terminaux ; constats | `/v1/titres/types`, `/v1/titres/indicateurs` | Lecture |
| `/rakapay/pilotage` (R01, R06) | Jauge du paiement numérique (cible servie) ; conformité ; motos par commune ; couverture par station (estimations EXEMPLE) ; pass par canal ; constats ; plaintes ; plaintes par commune ; billetterie ; recette par commune et par devise ; constats des modules 76 et 81 | `/v1/rakapay/indicateurs`, `/v1/titres/constats` | « Actualiser » ; signalements lus seulement par les rôles habilités (plus de 403) |
| `/rakapay/cooperative` (coopérative) | Membres par conformité ; membres par station ; paiements groupés par état — EXEMPLE | `/v1/rakapay/cooperatives/:id` | Paiement groupé (existant) |
| `/rakapay/operateurs` (R07, R06, R30) | Opérateurs par état ; opérateurs par commune ; offres par état et par famille ; deux circuits par devise (jamais additionnés) ; revues de ventes ; ventes privées par heure / zone / agent ; analyse quotidienne avec tendance vs 7 jours | `/v1/rakapay/operateurs`, `…/offres`, `…/circuits`, `…/revues-ventes`, `…/tableau`, `…/analyse-quotidienne` | « Lancer la détection » → 200 ; circuits lus seulement par les rôles habilités |

## Exigences et parties externes

Les matrices de couverture (`couverture-*.md`) ne signalent, pour ce périmètre, aucune exigence manquante ou
partielle construisible ici. Restent **externes** (adaptateurs en place, non simulés comme réels) : passerelle USSD et
numéro vert SVI des opérateurs télécoms (convention J29), conventions des points agréés et des banques (J9, J20).

## Correctifs transverses minimes

- `components/viz/TimelineStrip.tsx` : une frise **vide** levait `RangeError: Invalid time value` (graduations calculées
  sur une date absente) et faisait tomber l'écran au lieu d'afficher l'état vide ; corrigé, test de non-régression.
- `hooks/useInsight.ts` : paramètre facultatif `enabled` (défaut : oui), sans effet sur les usages existants.
- `frontend/test/setup.ts` : bouchon inerte de `ResizeObserver` pour jsdom (la trousse l'utilise).
