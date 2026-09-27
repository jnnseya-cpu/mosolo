# Couverture visuelle — écrans généraux, terrain, apprentissage, prestataires

*KINSHASA MOSOLO · document maître, annexe I (§ I.26), ajout du 27/09/2026. Charte : `charte-visualisation.md`.*

Méthode : chaque écran a été ouvert dans le navigateur (serveur de démonstration, Chromium, 360 px et 1280 px, mode
clair) avec un rôle habilité ; contrôle automatique : aucune erreur console, aucune réponse 4xx/5xx non voulue, aucun
défilement horizontal à 360 px ; puis parcours des boutons principaux (Playwright). Les visuels sont dérivés des
données que l'écran charge déjà ; aucun droit n'a été élargi.

Code : `frontend/src/pages/visuels.tsx`, `frontend/src/modules/terrain/visuels.tsx`,
`frontend/src/modules/apprentissage/visuels.tsx`, `frontend/src/modules/prestataires/Prestataires.tsx`.

| Écran (rôle de contrôle) | Graphiques ajoutés | Source des données | Contrôle fonctionnel |
|---|---|---|---|
| Accueil `/` (public) | Pile par catégorie : événements obligatoires / facultatifs | Catalogue d'événements du paquet partagé (`EVENTS`) | OK ; aucune erreur |
| Espace contribuable `/espace` (R30) | 5 tuiles (reste dû par devise) ; obligations par état ; anneau des biens par statut probant ; biens par commune ; quittances par état ; frise des échéances | `GET /v1/taxpayers/:id` (déjà chargé) | « Comment ce montant est calculé », « Sept questions », « Payer » → `POST …/payment-orders` 201 et référence affichée ; « Contester » ouvre le formulaire |
| Inscription `/inscription` (R12) | Pièces en attente par type ; niveau de vérification des comptes | `GET /v1/acces/identity-proofs` (R06, R07, R11, R12 seulement) | Validation client des deux formulaires (erreurs affichées) ; plus de 404 console sur le brouillon (`?siAbsent=vide`) |
| Trésor `/tresor` (R17) | Tuiles d'équilibre ; soldes par compte, **un graphique par devise** ; demandes du coffre par état | `GET /v1/ledger/balance`, `GET /v1/beneficiary-accounts` | **Corrigé** : un relevé incomplet déclenchait un 400 ; désormais contrôlé à l'écran avant envoi. Autres panneaux (imports, rapprochement, grand livre, coffre) inchangés |
| Audit `/audit` (R22) | Chaîne (intacte/altérée) ; événements par jour ; domaines les plus actifs (repli « Autres ») ; issues ; recours | `GET /v1/audit/verify`, `/v1/audit/events`, `/v1/appeals/indicateurs` | « Revérifier » recharge chaîne et événements |
| Terrain `/terrain` (R10) | Missions ouvertes, constats vs objectif, validés, file ; avancement par mission ; file par état | `GET /v1/terrain/me` + file locale | Sélection d'un objet ouvre la saisie ; synchronisation inchangée |
| Communications `/communications` (R06) | Remise des messages (suivi sans cible) ; derniers envois par état ; catalogue par gravité | `GET /v1/communications/overview`, `/events` | « Aperçu » affiche le gabarit ; « Envoyer un test » → `POST /v1/communications/test` 201 |
| Registre des règles `/registre` (R13, R14) | Tuiles ; règles par état ; visas obtenus sur 4 ; devise | `GET /v1/legal-rules` | « Ouvrir » ouvre la fiche (tiroir) ; création inchangée |
| Services `/services` (R30) | Services par statut juridique ; ma situation par service | `GET /v1/verticales`, `/v1/verticales/me/summary` | Cartes → espaces des verticales |
| Verticale `/services/:slug` (R30) | Tuiles ; obligations et démarches par état | `GET /v1/verticales/:slug/space` | « Démarches en ligne » ouvre le formulaire |
| RakaPay `/services/rakapay` (conducteur wewa) | Pass par état + frise de validité ; commandes par état et par jour (onglet Historique) | `GET /v1/rakapay/wewa/moi`, `/v1/titres/commandes` | Onglets Pass / Tickets / Historique fonctionnels |
| Vérification `/verifier` (public) | — (verdict unitaire déjà en couleur d'état + icône + libellé ; aucun registre lisible par le public) | — | OK |
| Couche d'intelligence `/ia` (R06) | Recommandations par agent ; par niveau d'autonomie (A / B / C) | `GET /v1/ia/inbox` | Cinq onglets fonctionnels |
| Supervision `/terrain/supervision` (R09) | Missions, constats, agents, sous-traitants, vérifications de badges par état ; constats par jour ; production par commune ; **carte des 24 communes** ; photos / écarts GPS | `GET /v1/terrain/indicators` (bandeau d'indicateurs conservé) | Onglets et « Nouvelle mission » fonctionnels |
| Inspection `/terrain/inspection` (R11) | Tuiles ; constats et PV par état ; jauge du taux de validation | `GET /v1/terrain/inspection/indicateurs` (panneau textuel conservé) | Préparation, paquet hors ligne, PV inchangés |
| PV me concernant `/mes-proces-verbaux` (R30) | PV par état ; contestations répondues / en attente | `GET …/mes-proces-verbaux` | Affiché dès qu'un PV existe (aucun sur le contribuable de démonstration) |
| Sous-traitants `/terrain/sous-traitants` (R06) | Accréditations ; agents par état ; agents par structure | `GET /v1/terrain/subcontractors`, `/agents` | Invitation, habilitation inchangées |
| Qualité `/terrain/qualite` (R06) | Présomptions ; ancienneté des équipes avec la ligne de rotation **servie** (90 j, « par défaut — à confirmer ») ; récupérations par état et par devise | `GET /v1/terrain/qualite` | OK |
| Équipements `/terrain/equipements` (R28) | Terminaux par état ; liaison appareil–utilisateur ; incidents | `GET /v1/equipements` | « Exécuter l'expiration des données » → 200, message affiché |
| Réserve des agents `/agents/reserve` (R06) | Tuiles (mode simulation / calcul) ; points par agent et par nature ; points par état ; note de qualité ; réserve par module **par devise** | `GET /v1/agents/reserve` | « Actualiser », sélection du mois |
| Vérifier un agent `/verifier-agent` (public) | Contrôles mystère agrégés (sans donnée personnelle) | `GET /v1/public/terrain/mystery-checks/summary` | OK |
| Espace d'apprentissage `/apprentissage` (R10) | Tuiles ; derniers scores vs seuil servi (non passés = non mesurés) ; exigences de certification | `GET /v1/apprentissage/espace` | Épreuves inchangées |
| Mes certificats (R10) | Certificats par état | `GET /v1/apprentissage/mes-certificats` | OK |
| Certifications `/apprentissage/certifications` (R06) | Comptes certifiés / à compléter ; par public ; couverture par public ; jauge de compréhension (non mesurée tant qu'aucun dossier) | `GET /v1/apprentissage/certifications`, `/indicateurs` | Trois onglets fonctionnels |
| Procédures `/apprentissage/procedures` (R06) | Publication ; versions par procédure | `GET /v1/apprentissage/procedures` | « Lire » ouvre la procédure |
| Prestataires `/tresor/prestataires` (R17) | Ordres / confirmés / rapprochés par prestataire (côte à côte, niveaux emboîtés) ; webhooks par issue ; ordres par état | `GET /v1/providers/connectors` | Simulation signée disponible dès qu'un ordre de bac à sable existe |
| Tableau du Gouverneur `/gouverneur` (R01) | Déjà équipé (§ I.25) — vérifié : 13 visuels, aucune erreur | — | OK |

Résultat du contrôle navigateur (24 écrans × 2 largeurs) : 0 erreur console, 0 réponse 4xx/5xx non voulue, 0 défilement
horizontal à 360 px.

**Exigences.** Les matrices `couverture-*.md` ne portent aucune exigence « manquante » ou « partielle » dans ce
périmètre (terrain, apprentissage, prestataires, écrans généraux) ; les seuls statuts restants sont **EXTERNE**
(recette avec agents réels, prestataires réels agréés BCC, tests d'intrusion tiers…) : ils exigent une partie
extérieure et ne sont pas simulés. Chaque écran du périmètre est accessible depuis le menu pour ses rôles
(`modules/registry.tsx`, `App.tsx`).

Captures : `docs/captures/visualisation/pages/`.
