# Couverture visuelle — périmètre « intégrité, accès, IA, socle, plateforme, documents, communication, preuves »

*KINSHASA MOSOLO · document maître, annexe I (27/09/2026). Complète `charte-visualisation.md` ; rien n'est retiré.*

Méthode : chaque visuel est dérivé des données que l'écran charge déjà (mêmes routes, mêmes droits ; aucun droit
élargi). Les cibles et seuils affichés sont ceux servis par le serveur (registre des seuils : « par défaut — à
confirmer » tant qu'aucun acte ne les fixe). Données de démonstration marquées `[EXEMPLE]` (ruban « EXEMPLE — non
opposable »). Vérification : démonstration `--demo` sur navigateur Chromium (Playwright), 360 × 800 et 1280 × 900,
thème clair : aucune erreur console, aucune réponse 5xx, aucun défilement horizontal à 360 px sur les 48 parcours
ci-dessous. Captures représentatives : `docs/captures/visualisation/integrite/`.

Légende de la colonne « Contrôle fonctionnel » : **OK** = boutons et formulaires essayés (appel d'API, résultat
visible) ; **corrigé** = anomalie trouvée puis corrigée dans cette passe.

## Intégrité (`modules/integrite`)

| Écran (route, rôle d'essai) | Visuels ajoutés | Source des données | Contrôle fonctionnel |
|---|---|---|---|
| Console d'enquête (`/integrite/enquetes`, R24) | 4 tuiles (courbes 14 j), états des signalements / alertes / dossiers, alertes par gravité, anneau des canaux, barres des natures, carte de chaleur des 24 communes, activité quotidienne | `/v1/integrite/indicators`, `/reports`, `/alerts`, `/cases` | **corrigé** : « Lancer la détection » affiche désormais « N nouvelle(s) alerte(s) — aucun effet automatique » (200) ; ancienne rangée d'indicateurs conservée, repliée |
| Collusion sous quatre yeux (`/integrite/collusion`, R22) | Signaux par gravité, jauge de la part des refus, barres approbations / refus par valideur, part du proposant avec le seuil du registre, décisions par circuit | `/v1/integrite/collusion` | **corrigé** : « Lever les alertes » affiche le nombre de signaux et d'alertes (200) |
| Contrôles mystère (`/integrite/controles-mystere`, R22) | Étapes, résultats, réalisés / conformes par cible, jauges de conformité, carte de chaleur des communes | `/v1/integrite/mystery-checks`, `/v1/public/integrite/summary` | OK (planification : tiroir existant) |
| Détecteurs (`/integrite/detecteurs`, R22) | Signaux par détecteur, anneau détecteurs avec / sans signal | `/v1/integrite/detecteurs` | **corrigé** : « Exécuter maintenant » affiche le résultat (200) |
| Protection des données (`/integrite/donnees`, R25, R22, R30) | Demandes par état et par droit, activité ; traitements par base légale / module, part sensible ; journal : issues, événements, activité | `/v1/integrite/privacy/requests`, `/registry`, `/access-log` | OK (onglets, filtre du journal) ; visuel ajouté aussi à « Mes demandes » |
| Incidents de sécurité (`/integrite/incidents`, R28) | 4 tuiles (courbe 14 j), états, gravités, natures | `/v1/integrite/incidents`, `/incidents/candidates` | OK |
| Registre des seuils (`/integrite/seuils`, R22) | Jauge « confirmés par acte », statuts, pile par famille, demandes | `/v1/integrite/thresholds` | OK |
| Renseignement (`/integrite/renseignement`, R24) | 4 tuiles, bandes de score, distribution des scores, suspensions, transmissions | `/v1/integrite/scores`, `/suspensions-conservatoires`, `/transmissions`, `/renseignement/indicateurs` | OK ; texte d'origine conservé sous les tuiles |
| Revue des accès (`/integrite/revue-acces`, R28) | Jauge d'avancement, décisions, pile par rôle | `/v1/integrite/access-reviews` | OK |
| Santé des clés (`/integrite/cles`, R26) | Clés par état, âge des clés (non mesuré si date inconnue) | `/v1/integrite/key-health` | OK |
| Scellement du journal (`/integrite/scellement`, R28) | Jauge de copie WORM, contrôles, enregistrements par racine, racines horodatées / publiées | `/v1/integrite/scellement` | OK : « Copier (WORM) » → 200 et message |
| Surveillance technique (`/integrite/surveillance-technique`, R28) | Attestations, appareils partagés, vitesses GPS avec seuil, références du jour par canal (seuil / plafond « non fixé » jamais dessiné à zéro) | `/v1/integrite/appareils`, `/gps/anomalies`, `/plafonds-references` | OK (attestation : saisie existante) |
| Signaler un abus (`/signaler`, public) | 4 tuiles publiques (reçus, clos, part confirmée — non mesurée sans clôture —, contrôles mystère) | `/v1/public/integrite/summary` (sans donnée personnelle) | OK : envoi → 201, référence et code de suivi |

## Accès et entités (`modules/acces`)

| Écran | Visuels ajoutés | Source | Contrôle fonctionnel |
|---|---|---|---|
| Entités et modules (`/acces/entites`, R26) | Fiches par étape du circuit, jauge des modules activés, arbitrages ; comptes par entité, entités par état | `/v1/acces/indicateurs`, `/entities` | OK |
| Invitations et comptes (`/acces/invitations`, R08) | Invitations par issue, jauge du taux d'acceptation, finalisation lien / opérateur, comptes par état, activité envoyées / finalisées, niveaux d'accès | `/v1/acces/indicateurs`, `/invitations` | OK |
| Mes mandataires (`/acces/mandats`, R30) | Mandats par état, actions confiées, frise des fins de validité | `/v1/acces/mandates` | OK |
| Registre d'identité (`/acces/identite`, R12, R11) | Pièces par nature, doublons par motif, fusions par état | `/v1/acces/identity-proofs`, `/duplicates` | OK |
| Arbitrages (`/acces/arbitrages`, R06) | États, avancement dans le circuit, objet des litiges ; **la liste « Circuit » affiche les comptes par marche** | `/v1/acces/arbitrations` | **corrigé** : liste descriptive devenue chiffrée |
| Consultation motivée (`/acces/consultation`, R11, R22) | Modes, revue, finalités, activité | `/v1/acces/consultations` | OK : demande → 201, dossier ouvert |
| Accès juste-à-temps (`/acces/elevations`, R28) | 4 tuiles (courbe 14 j), états, rôles temporaires | `/v1/acces/elevations` | OK |
| Accès et délégations (`/acces/delegations`, R08) | Indicateurs en tuiles et jauges, délégations par état, détections | `/v1/acces/delegations` | **corrigé** : statut affiché en français ; « Exécuter l'échéancier » → 200 et message |
| Finaliser mon invitation (`/invitation`, public) | Jauge des étapes remplies (téléphone, code, pièce, photo, second facteur) | état du formulaire | OK |

## Couche d'intelligence (`modules/ia`)

| Écran | Visuels ajoutés | Source | Contrôle fonctionnel |
|---|---|---|---|
| Boîte de réception (`/ia`, R22) | 2 tuiles (courbe 14 j), états, niveaux d'autonomie, jauge « retenues », pile par agent, activité | `/v1/ia/inbox` | OK |
| Agents (`/ia?vue=agents`) | Activité des agents par issue, actifs / coupés, niveaux | `/v1/ia/agents` | OK : balayage → 200, « N nouvelle(s) recommandation(s) » |
| Autonomie (`/ia/autonomie`, R08) | Jauges des actions et agents à exécution automatique (état du formulaire) | `/v1/ia/autonomy/:entité`, `/agents` | OK |
| Mémoire (`/ia/memoire`) | Tâches fréquentes, tuiles | `/v1/ia/memory/me` | OK |
| Journal IA (`/ia/journal`, R22) | 3 tuiles (délai médian de décision), types, acteurs, activité | `/v1/ia/journal` | OK (filtres) |
| Registre des modèles (`/ia/modeles`, R29) | Versions par statut, jeux de données, acceptation par version ; indicateurs en tuiles | `/v1/ia/modeles` | **corrigé** : statut des jeux en français |

## Socle, plateforme, documents, communication, preuves

| Écran | Visuels ajoutés | Source | Contrôle fonctionnel |
|---|---|---|---|
| Dérogations à la base (`/liquidation/derogations`, R06) | États, champs abaissés, activité | `/v1/assessments/base-overrides` | OK (onglets) |
| Extractions (`/donnees/extractions`, R26) | Étapes des trois visas, lignes demandées face au seuil servi (par défaut — à confirmer) | `/v1/socle/exports/requests` | OK |
| Mes profils (`/mon-espace/profils`, R30 ; agent R11) | Questions par parcours, rôles déclarés par état, file d'instruction | `/v1/public/enrolement/profils`, `/v1/enrolement/roles` | OK |
| Récupérer mon compte (`/recuperation-compte`, agent R12) | Demandes par étape, activité (formulaire public : pas de registre public) | `/v1/enrolement/recuperations` | OK |
| API partenaires (`/plateforme/partenaires`, R26) | Indicateurs en tuiles, appels par résultat, contrats, appels par client, activité, livraisons | `/v1/plateforme/partenaires` | **corrigé** : statuts, résultats et livraisons en français |
| Administration (`/plateforme/administration`, R26) | Indicateurs, changements par état et nature, par environnement | `/v1/plateforme/administration` | **corrigé** : nature et statut des changements en français |
| Supervision (`/plateforme/supervision`, R26) | Indicateurs, jauge de disponibilité (cible servie, source Cahier), jauge p95 (baisse favorable), routes, incidents | `/v1/plateforme/supervision` | **corrigé** : statut des incidents en français |
| Gestion documentaire (`/documents`, R22 ; R30) | 4 tuiles, jauge d'intégrité (non mesurée sans contrôle), classification, catégories, états, dépôts | `/v1/documents`, `/indicateurs` | **corrigé** : liste des demandes de purge (`GET /v1/documents/purges`, nouveau) avec approbation / rejet ; plus de 403 pour le contribuable ; « Vérifier l'intégrité » → 200 |
| Notifications (`/communication/notifications`, R06) | 4 tuiles, jauges d'ouverture (non mesurées sans accusé fournisseur), avis sur plaque, modèles par état et langue | `/v1/communication/indicateurs`, `/modeles`, `/avis-plaque` | OK |
| Mes préférences (`/mes-preferences`, R30) | Canaux préféré / autorisés / refusés (état du formulaire), modifications | `/v1/communication/preferences/:id` | OK |
| Vérifier une preuve (`/preuve/:code`, public) | Jauge de validité restante (bandes vert / orange / rouge du compte à rebours) | `/v1/public/preuves` | OK (code inconnu : « Code inconnu ») |
| Galerie (`/visualisation/galerie`) | — (hors périmètre, conservée) | — | 403 `/v1/postes/accueil` pour R22 : refus voulu, repli `[EXEMPLE]` |

## Écrans sans graphique (motivé)

| Écran | Motif |
|---|---|
| Connexion (`/connexion`) | Aucune donnée n'est lisible avant l'authentification. |
| Version imprimable d'une preuve (`/preuve/:code/imprimer`) | Support papier : l'échéancier des couleurs imprimé tient lieu de visuel. |
| WhatsApp et SMS (`/canaux/whatsapp-sms`) | Simulateur de conversation sans registre : le fil de messages est la représentation. OK : « Bonjour » → 200, « AIDE » par SMS → 200. |
| Récupérer mon compte, vue publique | Formulaire public : aucun registre consultable sans habilitation. |

## Exigences

Les matrices `couverture-modules-*.md` ne signalent aucune exigence manquante ou partielle pour ces modules (tous
BUILT, BUILT-NOW, CONSTRUIT ou ADAPTER). Tous les écrans du périmètre sont atteignables depuis le menu pour leurs rôles
(`modules/registry.tsx`). Parties nécessitant un tiers externe (inchangées, libellées [À RACCORDER]) : code court USSD
et numéro court SMS (convention opérateur), accusés de délivrance / d'ouverture des fournisseurs de messages
(indicateurs « non mesurés » tant qu'ils ne sont pas raccordés), autorité d'horodatage externe du scellement.
