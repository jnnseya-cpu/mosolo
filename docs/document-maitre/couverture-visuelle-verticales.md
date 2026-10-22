# Couverture visuelle — verticales, stationnement, publicité, chaîne véhicule

*KINSHASA MOSOLO · document maître, annexe I (ajout du 27/09/2026). Périmètre : `frontend/src/modules/verticales`,
`modules/parking`, `modules/publicite`, `modules/vehicules-controle`, `frontend/src/verticals`, `pages/VerticalSpace.tsx`
(`/services/:slug`) et les plugins serveur correspondants.*

Tous les graphiques utilisent la trousse partagée (`components/viz`) et la charte (`charte-visualisation.md`) ; les
adaptateurs communs sont dans `frontend/src/verticals/visuels.tsx` (répartition par état, montants **par devise**,
courbes mensuelles en mois de Kinshasa, barres de comptage). Chaque écran charge **les mêmes routes, avec les mêmes
droits** qu'auparavant : aucun droit élargi ; une donnée que le rôle ne peut pas lire n'est pas dessinée. Aucun
tableau, formulaire ni bouton existant n'a été retiré. Démonstration signalée « EXEMPLE — non opposable » ; aucune
cible inventée (jauges « Suivi (sans cible) », sauf la fourchette de l'acte ParkSmart 15 à 25 % servie par le serveur).

Contrôle fonctionnel (navigateur Chromium, démo `--demo`, 1280 et 360 px) : chaque écran ouvert avec un rôle
habilité, aucune erreur console, aucune réponse 5xx, aucun défilement horizontal à 360 px ; onglets de la console des
verticales, des fiches 13 à 25, de ParkSmart, de la régie stationnement, de l'espace usager stationnement, de l'espace
exploitant, de la régie et de l'inspection publicité parcourus un à un (aucune erreur). Captures :
`docs/captures/visualisation/verticales/`.

| Écran (route) | Graphiques ajoutés | Source des données | Contrôle fonctionnel |
|---|---|---|---|
| Espace d'une verticale `/services/:slug` (17 verticales) | Tuiles (éléments, obligations à payer, quittances, démarches) ; obligations par état ; montants par devise ; éléments par statut probatoire ; démarches par état ; quittances par état ; paiements quittancés par mois. Vue agent : tuiles + démarches par issue | `/v1/verticales/:slug/space` ; agents : `/v1/verticales/indicators` (R01–R29) | **Corrigé** : `/services/actifs` renvoyait 403 à tous (la fiche était masquée par la liste réservée du patrimoine) → `GET /v1/verticales/catalogue/:slug` ; débordement à 360 px du parcours de bout en bout corrigé (6 verticales) |
| Console des verticales `/verticales/console` | Démarches par état, par verticale, par mois, carte des communes ; plaques et scans par agent ; situations NFIU par agent ; déclarations AVIA par état, passagers déclarés / embarqués par mois ; chaîne des départs (connus → comptés → vérifiés → compensés) ; rapprochements avec / sans écart ; exécutions des écarts ; télécom (concordants / non déclarés / non relevés) ; indicateurs par verticale, étals avec titre, couverture NFIU | `/v1/verticales/cases`, `plates-report/daily`, `nfiu/rapports`, `avia/declarations`, `avia/overview`, `avia/rrh/overview`, `avia/auto`, `telecom/reconciliation`, `indicators` | **Corrigé** : le panneau des habilitations NFIU s'affichait en erreur 403 pour la direction DGTK ; il n'apparaît plus qu'au périmètre servi (DGIPK) |
| Vérifier une plaque `/verifier-plaque` | — (écran public sans registre lisible) | — | Vérification fonctionnelle, aucune erreur |
| CALCU `/controle/calcu` | Tuiles (taux vert, ambre, rouge, paiements bloqués = 0) ; opérations par score ; comptes validés conjointement ; montants par banque (par devise) ; opérations par mois ; rapports par état | `/v1/verticales/calcu/overview` | Aucune erreur |
| Organe CALCU `/controle/calcu/organe` | Montants contrôlés / récupérés (par devise) ; exécution des recommandations échues ; institutions à risque (rouge / ambre / vert) ; carte des zones exposées | `/v1/verticales/calcu/organe` | Aucune erreur |
| Fiches sectorielles `/verticales/fiches` (+ module 18) | Tuiles ; modules par état de la règle ; indicateurs mesurés / non mesurés ; indicateurs chiffrés ; registre de chaque module par statut probatoire et par commune ; liquidations par état et par module ; plastique (tuiles, déclarations) | `/v1/verticales/fiches/indicateurs`, `…/:module/objets`, `…/liquidations`, `/v1/verticales/plastique` | 14 onglets parcourus, aucune erreur |
| Patrimoine `/verticales/actifs` | Tuiles ; actifs par étape, par nature, carte des communes ; revenus liquidé / payé / rapproché par devise | `/v1/verticales/actifs`, `…/revenus` | Aucune erreur |
| Environnement `/verticales/environnement` | Tuiles ; tonnage par assujetti ; assujettis par catégorie ; carte des communes | `/v1/verticales/environnement/registre` | Aucune erreur |
| Modules sectoriels `/verticales/secteurs` | Tuiles ; activité par module ; déclarations par état | `/v1/verticales/secteurs`, `…/declarations` | Aucune erreur |
| Grands redevables `/grands-redevables` | Gestionnaire dédié (en place / rotation due / à désigner) ; portefeuille par secteur ; recettes par redevable (par devise) ; échues impayées | `/v1/grands-redevables` | Aucune erreur (DGTK) ; 403 voulu hors périmètre (`sameEntity`) |
| Stationnement usager `/stationnement` | Tuiles ; sessions par état, par mois ; paiements par zone (par devise) | `/v1/parking/sessions/mine` | 6 onglets, aucune erreur |
| Contrôle `/stationnement/controle` | Tuiles ; constats par état, par nature, par mois, carte des communes | `/v1/parking/violations` | Aucune erreur |
| Mes gains `/mes-gains` | Lignes par état ; validation avant versement ; lignes par mois ; commission de référence par module (par devise) | `/v1/agents/me/earnings` | Aucune erreur |
| Validation des commissions | Demandes par état, par agent ; commission demandée (par devise) | `/v1/agents/commission-validations` | Aucune erreur |
| Surveillance des constats | Agents par niveau de signal ; issue des constats par agent ; taux de constats | `/v1/agents/monitoring` | Aucune erreur |
| Régie `/stationnement/regie` | Tuiles ; constats, réservations, zones par état ; occupation des zones (occupées / réservées / libres) | `/v1/parking/violations`, `reservations`, `zones` | 6 onglets, aucune erreur |
| Tableau de bord `/stationnement/tableau-de-bord` | (graphiques existants conservés) + zones vs cible ; jauges occupation et conformité ; sessions payées par zone ; recettes par commune (par devise) ; commissions : points, contrôles aboutis, quote-part | `/v1/parking/indicators`, `/v1/agents/earnings` | Aucune erreur (Gouverneur compris) |
| ParkSmart `/stationnement/parksmart` | Tuiles ; carte de chaleur places libres zone × heure ; heures saturées / dans la cible / sous-utilisées ; tarif appliqué et fourchette de l'acte par heure | `/v1/parking/occupancy`, `tarification-dynamique` | 9 onglets, aucune erreur |
| Espace exploitant `/publicite` | Tuiles ; supports par état, par droits, par type | `/v1/publicite/devices/mine` | 5 onglets, aucune erreur |
| Inspection `/publicite/inspection` | Tuiles ; constats par nature, par mois ; inventaire par état ; carte des communes | `/v1/publicite/inspections`, `inventory` | Inspecteur et superviseur, aucune erreur |
| Régie publicité `/publicite/regie` | Tuiles ; demandes par état, par mois ; dossiers par état, par commune | `/v1/publicite/authorizations`, `cases` | 3 onglets, aucune erreur |
| Supervision `/publicite/tableau-de-bord` | (graphiques existants conservés) + parc par état ; taux d'autorisation ; dossiers de constat ; carte des communes ; supports par commune ; recettes par commune ; qualité des équipes | `/v1/publicite/indicators` | Aucune erreur |
| Carte et pilote `/publicite/carte` | Tuiles ; densité par commune ; motifs des zones à contrôler ; supports par état ; avancement du pilote | `/v1/publicite/carte/couches`, `pilote` | Aucune erreur |
| Contrats `/publicite/contrats` | Échéances par état ; frise des échéances | `/v1/publicite/echeances` | Aucune erreur |
| Vérifier / Signaler (public) | — (aucun registre public lisible) | — | Aucune erreur |
| Contrôle technique `/vehicules/controle-technique` | Tuiles ; parc par état CT (états disjoints) ; vignettes par état ; PV par mois, par résultat, par centre | `/v1/vehicules/indicateurs`, `controles-techniques`, `vignettes-securisees` | Aucune erreur |
| Scan unique `/vehicules/scan` | Activité du scan (R09, R11 seulement) | `/v1/vehicules/indicateurs` | Aucune erreur |
| Fourrières `/vehicules/fourrieres` | Tuiles ; dossiers par étape ; occupation des sites ; entrées / sorties / en garde ; recette liquidée / payée (par devise) | `/v1/vehicules/indicateurs`, `/v1/fourrieres/*` | Aucune erreur |
| Centres agréés `/vehicules/centres-agrees` | Tuiles ; centres par état, par commune ; taux de réussite vs pairs (servi) | `/v1/centres-agrees`, `…/analytique` | Aucune erreur |
| RFCK `/vehicules/rfck` | Tuiles ; flux par état ; séquence d'intégration ; six exigences du domaine | `/v1/rfck/*` | Aucune erreur |
| Mes véhicules `/vehicules/mes-vehicules` | Tuiles ; CT, vignette fiscale, quitus par état | `/v1/vehicules/mes-vehicules` | Aucune erreur |
| Vérifier une vignette (public) | — | — | Aucune erreur |

Exigences des matrices `couverture-modules-13-26`, `59-74`, `75-81` du périmètre : aucune ligne restée « partielle »
ou « manquante ». Restent dépendantes d'un tiers (jamais simulées comme réelles) : conventions RFCK (flux « À
RACCORDER »), interfaces compagnies / RVA / DGM (AVIA, adaptateurs bac à sable), passerelles bancaires CALCU,
capteurs ParkSmart, actes (grilles tarifaires réelles, barèmes des modules « acte requis »).

Tests : `frontend/test/visuels-verticales.test.tsx` ; `backend/test/verticales-fiche-catalogue.test.ts`.
