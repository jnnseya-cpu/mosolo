# Couverture visuelle — périmètre « fiscal » (27/09/2026)

*KINSHASA MOSOLO · document maître, annexe I. Périmètre : écrans `frontend/src/modules/fiscal`, `citoyen`, `referentiel`,
`juridique`, `opportunites` et leurs routes serveur. Règles : [charte de visualisation](charte-visualisation.md).*

Chaque écran reçoit en tête un résumé visuel construit avec la trousse partagée (`components/viz`) à partir des **seules
données qu'il charge déjà** (aucune route élargie, aucun droit ajouté, aucun chiffre ni cible inventé). Les tableaux,
listes, formulaires et boutons existants sont conservés sous les visuels. Les éléments issus du jeu de démonstration
portent le ruban « EXEMPLE — non opposable ». Les visuels sont regroupés par module dans un fichier `visuels.tsx`
(`fiscal/visuels.tsx`, `citoyen/visuels.tsx`, `referentiel/visuels.tsx`, `juridique/visuels.tsx`,
`opportunites/visuels.tsx`).

Contrôle fonctionnel : démo lancée (`--demo`), navigateur Chromium (Playwright), rôle habilité de démonstration ; chaque
écran visité à 360 px et 1280 px (aucune erreur console, aucun 4xx/5xx, aucun défilement horizontal) puis une action réelle
exécutée avec résultat visible.

| Écran (route) | Rôle de contrôle | Visuels ajoutés | Source des données | Contrôle fonctionnel |
|---|---|---|---|---|
| Biens et relations (`/fiscal/biens`) | R30, R06 | 4 tuiles (biens, validés IGF, QR émis, relations validées) ; situation fiscale par couleur ; anneau par catégorie ; relations par statut ; carte de chaleur des 24 communes (agents) ; volumes de la file de validation | `GET /v1/fiscal/objects`, `GET /v1/fiscal/relationships/queue` | Scan de plaque (NFIU affiché) ; validation d'objet (IGF attribué) ; rattachement par le contribuable (demande enregistrée) — OK |
| Déclarations (`/fiscal/declarations`) | R30, R11 | 4 tuiles (déclarations, liquidées, simulations non opposables, vérifications demandées) ; états ; anneau par impôt ; suite donnée ; barres par période | `GET /v1/fiscal/declarations` | Pré-remplissage puis dépôt (accusé de réception) — OK |
| Exonérations (`/fiscal/exonerations`) | R30, R06 | 4 tuiles (dont montants remis par devise, sinon « non mesuré » motivé) ; états ; exonérations / remises | `GET /v1/fiscal/exemptions` | Filtre « Toutes » ; « Vérifier les échéances maintenant » (message) — OK |
| Quitus (`/fiscal/quitus`) | R30, R06 | Conditions (réunies / non), obligations bloquantes, quitus délivrés, jours de validité restants + jauge ; quitus par état ; agents : quitus à revoir par motif | `GET /v1/fiscal/clearances/eligibility`, `/clearances`, `/clearances/review` | Conditions et quitus actif affichés (demande possible seulement sans quitus actif) — OK |
| Attestations de bail (`/fiscal/baux`) | R30 | Tuiles (baux, attestations, vérifiés, résiliés) ; baux par état ; loyers en cours par périodicité, une devise par graphique | `GET /v1/fiscal/leases` | « Obtenir l'attestation » (QR émis) — OK |
| Corrections d'objets (`/fiscal/corrections`) | R06 | Tuiles (corrections en attente, objets, actifs) ; objets par rang ; cycle de vie ; statut probant | `GET /v1/fiscal/objects`, `/object-corrections` | Ouverture des corrections d'un objet — OK |
| Carte à deux couches (`/fiscal/carte`) | R06 | Répartition des couleurs (toutes communes) ; carte de chaleur des objets par commune (maille masquée = non mesurée) | `GET /v1/fiscal/map` | Bascule de couche (situation / couverture) — OK |
| Autour de moi (`/autour-de-moi`) | R10 (GPS simulé) | Biens proches par couleur ; biens par tranche de distance | `GET /v1/fiscal/nearby` | Position GPS précise → liste et visuels — OK |
| Anomalies locatives (`/fiscal/anomalies-locatives`) | R06 | Tuiles (dossiers ouverts, signaux, protocoles actifs) ; dossiers par signal (sans protocole = non mesuré) ; dossiers par état ; carte des communes | `GET /v1/fiscal/anomalies/catalogue`, `/anomalies` | « Lancer les rapprochements » (dossiers créés) — OK ; débordement à 360 px corrigé |
| Assiette 2026 (`/fiscal/assiette-2026`) | R30 | Tuiles (cas, règles actives, déclarations, points à vérifier) ; champs et contrôles par cas ; cohérence de mes déclarations | `GET /v1/fiscal/assiette-2026`, `/assiette-2026/declarations` | Formulaires par cas affichés — OK |
| Conditions des services (`/fiscal/dependances`) | R30, R06 | Tuiles ; conditions par mode (informatif / bloquant) ; versions de règle par service | `GET /v1/public/fiscal/dependances` | « Vérifier » (conditions remplies / non) — OK |
| Recensement (`/fiscal/recensement`) | R06 | Tuiles ; objets ayant atteint chaque vague ; vague atteinte par commune (pile) ; carte des communes ; occupation des unités (couverture locative) | `GET /v1/fiscal/census/coverage`, `/couverture-locative` | Filtre commune, niveau de couverture — OK |
| Reprise e-DGRK (`/fiscal/reprise`) | R06 | Tuiles (lots, intégrés, lignes valides, doublons) ; lots par état ; lignes par résultat | `GET /v1/fiscal/imports` | Validation à blanc d'un lot CSV (lot créé) — OK |
| Vérification publique (`/fiscal/verifier`) | anonyme | Aucun agrégat (divulgation minimale) : compte à rebours de validité existant | `GET /v1/public/fiscal/*` | Code inconnu → verdict « Code inconnu » — OK |
| Référentiel des recettes (`/referentiel/recettes`) | R06 | Tuiles (lignes, activables, inventaire § 7.4, codes) ; lignes par section ; lignes par compétence ; complétude de l'inventaire (suivi sans cible) — aucun pourcentage (le référentiel ne porte aucun taux) | `GET /v1/public/referentiel/recettes`, `/v1/referentiel/recettes`, `/v1/referentiel/codes` | Inventaire déplié — OK |
| Modèle de données (`/referentiel/modele-donnees`) | R06 | Effectifs par entité ; matrice d'habilitations conforme / écart | `GET /v1/referentiel/modele-donnees`, `/matrice-habilitations` | Onglet matrice — OK |
| Opportunités (`/opportunites`) | R06 | Opportunités par état ; étapes complétées du pipeline ; origine ; opportunités par étape (indicateurs) | `GET /v1/opportunites`, `/v1/opportunites-indicateurs` | Ouverture d'une fiche — OK |
| Recoupement (`/opportunites/recoupement`) | R06 | Liste de travail : tuiles, états, règles, communes ; sources par état et lots ; services bloqués | `GET /v1/recoupement/liste-travail`, `/sources`, `/blocages` | Élément de liste ouvert ; onglet sources — OK |
| Maximisation (`/opportunites/maximisation`) | R06 | Classées / non classées par nature ; commerces visibles × patentes par commune ; paiements non rapprochés ; leviers mesurés / non mesurés | `GET /v1/opportunites-maximisation/*`, `/v1/opportunites-leviers` | Onglets cas d'usage et leviers — OK |
| Points juridiques (`/juridique/points`) | R13 | Progression des points tranchés (suivi sans cible) ; points par statut ; fonctions conditionnées ; points ouverts par autorité | `GET /v1/juridique/points` | « Proposer l'acte » ouvre le formulaire — OK |
| Données et conservation (`/juridique/donnees`) | R28 | Dépôts et enregistrements par classe C1–C5 ; conservation (purgeable / jamais purgé / à classer) | `GET /v1/juridique/donnees/classification` | « Aperçu (simulation) » — OK |
| Application (`/application`) | R30 | Titres du portefeuille par état serveur (après synchronisation) | `GET /v1/titres` | Code d'accès, synchronisation chiffrée — OK |
| Informations et simulateurs (`/simulateurs`) | R30 | Simulateurs disponibles ; règles par nature ; calendrier confirmé / à vérifier | `GET /v1/public/simulateurs`, `/v1/public/informations` | « Simuler » (illustration non opposable) — OK |
| Contrôle des pièces (`/citoyen/pieces`) | R12 | Points par facteur du score ; cas à risque par tranche de score | `POST /v1/citoyen/enrolement/pieces`, `GET …/revues` | « Contrôler la pièce » (score affiché) — OK |
| Attestation de situation (`/mon-espace/situation`) | R30 | Mes obligations par état ; mes objets par catégorie | `POST /v1/citoyen/situation/attestations` | Émission (attestation + QR) — OK |
| Relations (`/citoyen/relations`) | R06 | Tuiles d'indicateurs du module 7 ; obligations à revoir par statut | `GET /v1/citoyen/relations/*` | Écran et décisions motivées — OK |
| Cadastre (`/citoyen/cadastre`) | R06 | Objets par couche ; carte de chaleur de l'indicateur choisi ; cas difficiles par statut ; tuiles du module 8 | `GET /v1/citoyen/cadastre/*` | Historique d'un objet affiché — OK |
| Locatif (`/citoyen/locatif`) | R06 | Couverture par zone (avec bail / vérifié) ; nature des calculs IRL ; tuiles du module 9 | `GET /v1/citoyen/locatif/*` | Changement de niveau — OK |
| Activités et patentes (`/citoyen/activites`) | R06 | Tuiles ; établissements et patente ; carte des communes ; signaux par statut | `GET /v1/citoyen/activites`, `/signaux` | « Détecter sur le registre » ; « Obligations » — OK |
| Véhicules (`/citoyen/vehicules`) | R06 | Véhicules au référentiel ; par usage ; par commune | `GET /v1/citoyen/vehicules` | Contrôle de plaque (dernier paiement) — OK |
| Transport (`/citoyen/transport`) | R06 | Autorisations par statut ; par catégorie ; tuiles du module 12 | `GET /v1/citoyen/transport/*` | « Envoyer les rappels » (nombre envoyé) — OK |
| Indicateurs 1 à 12 (`/citoyen/indicateurs`) | R06 | Mesurés / non mesurés ; indicateurs par module ; une tuile par indicateur (ratio avec numérateur / dénominateur, sinon « non mesuré » + raison) ; ventilations (canal, niveau, plateforme, page) en barres | `GET /v1/citoyen/indicateurs` | Lecture — OK |

## Corrections apportées pendant la vérification

- **Conversion vers l'inscription (module 5)** : le serveur rapportait toutes les inscriptions historiques aux seules
  visites mesurées (4 400 % en démonstration). Le taux est désormais calculé sur la même période (inscriptions postérieures
  à la première visite comptée), avec `depuis` et `inscriptionsAvantMesure` servis ; test `backend/test/citoyen.test.ts`.
- **Anomalies locatives à 360 px** : les boutons à libellé long débordaient (371 px) ; ils passent à la ligne
  (`fiscal.css`).
- **Tests** : bouchon `ResizeObserver` partagé dans `frontend/test/setup.ts` (jsdom), nécessaire aux graphiques.

## Ce qui dépend d'un tiers (non simulé)

Marqué « ADAPTER » dans [couverture-modules-01-12.md](couverture-modules-01-12.md) : registre NIF (DGI) / RCCM,
publication sur les magasins d'applications (comptes développeur de la Ville), opérateurs télécoms (USSD, SMS :
taux de délivrance et coût par message « non mesurés »), cadastre foncier et imagerie sous licence, données des
distributeurs d'énergie et d'eau et des employeurs (protocoles requis, J13), flux directs du registre des
immatriculations et des codes marchands. Les graphiques correspondants affichent « non mesuré » avec ce motif.

Captures (clair, 360 et 1280 px ; un exemple sombre) : `docs/captures/visualisation/fiscal/`.
Tests : `frontend/test/visuels-fiscal.test.tsx` (rendu avec données, état vide, vue tableau, non mesuré, aucun
pourcentage dans le référentiel) ; tests d'écrans existants conservés et passants.
