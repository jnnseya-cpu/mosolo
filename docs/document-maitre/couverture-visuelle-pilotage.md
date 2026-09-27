# Couverture visuelle — périmètre « pilotage et décision »

*KINSHASA MOSOLO · document maître, annexe I (ajout du 27/09/2026). Écrans des modules `pilotage/*`, `decision/*`,
`postes/*` et `chaine/*`, équipés avec la trousse partagée (`frontend/src/components/viz`, charte :
`charte-visualisation.md`). Rien n'a été retiré : chaque tableau, formulaire et bouton existant reste en place ; les
visuels sont ajoutés au-dessus. Aides communes : `frontend/src/modules/pilotage/visuels.tsx` (tuiles d'indicateurs,
répartitions par état, barres « une devise par graphique », jauges) et `frontend/src/modules/postes/visuels.tsx`.*

Règles appliquées partout : données réelles de la vue déjà chargée (aucun droit élargi) ; devises jamais additionnées
(`BarresParDevise` : un graphique par devise) ; « non mesuré » motivé ; cible dessinée seulement si le serveur la sert
(ou si elle découle de l'objet mesuré : assignation certifiée, 100 % d'une chaîne, total des actions) ; valeurs par
défaut marquées « à confirmer par le maître d'ouvrage » ; exemples `[EXEMPLE]`.

Vérification navigateur (démo, Chromium, 360 px et 1280 px, thème clair) : aucune erreur console, aucune réponse 5xx,
aucun défilement horizontal de la page (les seuls éléments plus larges que 360 px sont dans leur cadre défilant prévu :
carte des risques en tableau, frise des treize maillons). Captures : `docs/captures/visualisation/pilotage/`.

| Écran (route, rôle d'essai) | Visuels ajoutés | Source des données | Contrôle fonctionnel (démo) |
|---|---|---|---|
| Tableaux par profil `/pilotage/tableaux` (R01, R17) | Tuiles du jour vs veille (sinon 4 indicateurs avec tendance), six états, indicateurs par état, carte de chaleur des communes, anneaux canal / catégorie, courbe mensuelle, retards et suspens par âge, prestataires, assiette, instructions par statut | `GET /v1/pilotage/tableaux/:profil` | Onglets de profil, filtres, export signé : OK |
| Indicateurs `/pilotage/indicateurs` (R01) | Tuiles de synthèse (mesurés sur total), répartition par état, états par domaine (pile) | `GET /v1/pilotage/indicateurs` | Filtres, domaines, export CSV + JSON signés (téléchargement et empreinte) : OK |
| Indicateurs 27–40 (R01) | Tuiles, mesurés / non mesurés par module, anneau de couverture | `GET /v1/pilotage/indicateurs-modules/27-40` | Lecture : OK |
| Répartition § 37A `/pilotage/repartition` (R05) | Tuiles (clé et statut, assiette par devise, répartitions), anneau de la clé (parts par défaut — à confirmer), parts calculées par devise, assiette mois par mois, jauge de la réserve des agents, parts des tutelles | `GET /v1/pilotage/repartition`, `/cle` | Filtres période / devise, actualiser : OK ; actions d'acte et d'activation inchangées (gardes quatre yeux) |
| Réductions `/pilotage/reductions` (R01) | Tuiles par devise (part du brut), du brut à l'encaissé par devise, réductions par type, par commune, assiette en attente d'acte | `GET /v1/pilotage/reductions` | Filtres et détection (inchangés) : OK |
| Piste d'audit `/pilotage/piste-audit` (R22) | Tuiles, dossiers par état d'obligation, par commune ; pour une piste : contrôles « sans trou », chronologie par source | `GET /v1/pilotage/piste-audit[/:ref]` | Ouverture d'un dossier, filtres de source, extraction signée : OK |
| Transparence `/transparence` (public) | Carte de chaleur des communes par devise (cellules masquées = non mesurées, motif), anneau par catégorie ; parts de la clé et montants ; suivi (autorités) : publications à temps, consultations par jour | `GET /v1/public/transparency`, `/v1/public/transparence/repartition/:p`, `/v1/decision/transparence` | Vérification d'authenticité : OK |
| Base de référence et RANV (R05, R22) | Tuiles (RANV ou non mesurée motivée, jeux, certifiés, en attente), jeux par statut, composantes de la RANV, origines (§ 8.7) | `GET /v1/pilotage/base-reference`, `/ranv` | Import (R05) puis certification par une autre personne (R22) : OK |
| Pilote de 180 jours (R01) | Tuiles (jour, critères, revues, communes), critères par statut, pilotes vs témoins (en %), jalons J30…J180 | `GET /v1/pilotage/pilote` | Configuration du protocole : OK |
| Feuille de route (R01) | Tuiles, phases par état, plans d'action par horizon, jauge d'autonomie (postes externes transférés), postes par fonction, instances de gouvernance | `GET /v1/pilotage/feuille-de-route`, `/modele-operationnel`, `/gouvernance` | Lecture ; formulaires inchangés |
| Scénarios (R05) | Recette additionnelle nette par scénario, sensibilité, conformité et potentiel par recette, registre des hypothèses ; exemple du Cahier `[EXEMPLE]` (Cahier vs recalcul) | `GET /v1/pilotage/scenarios`, `/hypotheses`, `/exemple-illustratif` | Enregistrement d'une hypothèse : OK |
| Assignations (R15, R05) | Tuiles, jauge de réalisation (cible = assignation certifiée), carte de chaleur des communes, assigné / rapproché par devise, registre par statut | `GET /v1/pilotage/assignations`, `/ecarts` | Import (R15), certification (R05), export signé : OK |
| Instructions (R01, R06, R02) | Tuiles, statuts, blocs d'origine, échéances, services destinataires | `GET /v1/pilotage/instructions` | Émettre (R01) → accuser et déposer le rapport (R06) → clore (R02) : OK |
| Accords de service (R02, R06) | Tuiles, respect des délais par accord (pile), demandes par état, jauges de satisfaction (masquées sous le seuil) | `GET /v1/pilotage/accords-service`, `/satisfaction` | Enregistrer un accord (R02), ouvrir une demande (R06) : OK |
| Projets et budget voté (R05) | Tuiles, projets par statut, domaine, maturité, coûts par devise, avancement des projets financés, scénarios ; enveloppes par statut et par devise, indicateurs du module 48 | `GET /v1/pilotage/projets` | Demander des scénarios : OK (décision humaine requise) |
| Partage légal (R05) | Tuiles, clés par statut, parts par entité (rapproché / comptabilisé) par devise, assiette des clés non calculables | `GET /v1/legal-shares/*` | Calcul (aucun virement) : OK |
| Risques (R01) | Tuiles, matrice probabilité × impact (nombre de risques), zones, prochaines revues | `GET /v1/pilotage/programme/risques` | Revue d'un risque : OK |
| Recette (R01) | Tuiles (critères prouvés), stratégie construite / partielle / externe, suivis du monde réel, critères reliés à un test | `GET /v1/pilotage/programme/recette` | Lecture ; suivis inchangés |
| Versions (R01) | Tuiles, contenus construits par version, mise en service | `GET /v1/pilotage/programme/versions` | Lecture |
| 100 jours (R01) | Tuiles, actions par état, avancement par période | `GET /v1/pilotage/programme/cent-jours` | Lecture |
| Décisions du Gouvernement (R01) | Tuiles, décisions par statut, contrôles débloqués (libellés français des états, aussi dans le tableau) | `GET /v1/pilotage/programme/decisions` | Lecture |
| Donner mon avis `/satisfaction` (R30) | Jauge de la note choisie ; renvoi vers les moyennes agrégées des autorités | aucun registre lisible par R30 (droits non élargis) | Envoi : OK |
| Centre de commandement `/decision/commandement` (R01) | Tuiles, indicateurs, six états, intensité du recouvrement par commune, situation des obligations (pile), alertes par sévérité et par famille, jauges des indicateurs en % | `GET /v1/decision/commandement` | Décision tracée, rapport signé, changement de dimension : OK |
| Régie fiscale (R06) | Tuiles, liquidé / payé / rapproché par recette et par commune (par devise), arriérés par ancienneté, campagnes par validation, missions par zone, constats des agents | `GET /v1/decision/regie-fiscale` | Lecture ; liens vers campagnes et supervision |
| Régie des taxes (R07 DGTK) | Tuiles, recettes par taxe (par devise), autorisations, contrôles par résultat (titres, stationnement, publicité) | `GET /v1/decision/regie-taxes` | Lecture |
| Tableau ministériel (R01, R17) | Tuiles, recettes et part de tutelle par module, part calculée / versée / reste par devise, versements par statut, paiement à l'échéance par module | `GET /v1/decision/ministere` | Choix du ministère ; constat de versement (R17) inchangé |
| Salle de contrôle (R17) | Tuiles du jour, chaîne des paiements, exceptions par type, incidents par sévérité et clôture, paramètres sensibles, escalades | `GET /v1/decision/salle-controle` | « Vérifier les délais » : OK |
| Audit et investigation (R22) | Tuiles, missions, constats par gravité, recommandations, événements scellés par jour | `GET /v1/decision/audit/missions` | Mission → échantillon → constat (gravité désormais choisie) → recommandation → export scellé : OK |
| Prévision de trésorerie (R05) | Tuiles, prévisions par scénario, frise ; écart : prévu et réalisé par semaine (une courbe par devise), par catégorie, jauge réalisé / prévu ; états chargement et erreur de l'écart ajoutés | `GET /v1/decision/previsions[/:id/ecart]` | Générer puis écart : OK |
| Poste de décision `/poste-de-decision` (R01, R02, R03, R05, R36) | Structure des maquettes conservée ; ajouts dans les blocs : dossiers par état d'instruction (cabinet), actes par état d'exécution et échéances (secrétariat, suivi, retards), tuiles des recettes (ministre, autorité habilitée), carte des communes (vue « Communes »), taille des corbeilles avec le seuil servi | `GET /v1/postes/accueil`, `/v1/postes/vues/:vue`, `/v1/postes/indicateurs` | Menus et gestes inchangés ; affichage à 360 px corrigé (le contenu des blocs débordait du cadre téléphone) |
| Poste de travail (R11) | Tuiles, éléments par module source, échéances de la file | `GET /v1/postes/travail` | Liens vers les écrans sources : OK |
| Chaîne `/chaine` (R11, R22) | Obligations du périmètre (état, catégorie) avec accès direct à la chaîne et à l'objet (plus besoin de connaître un identifiant) ; ruptures par gravité et par nature (audit) ; pour un objet ou une obligation : maillons par état, réponses par état, part accomplie | `GET /v1/obligations` (droit `obligation.read`), `/v1/integrite/chaine/ruptures`, `/v1/obligations/:id/chaine` | Accès direct depuis la liste : OK |

Correctifs partagés (minimes) : `TimelineStrip` ne plante plus sans événement ni bornes (graduations calculées sur une
date invalide) ; bouchon `ResizeObserver` dans `frontend/test/setup.ts` ; ligne « critères 11 à 15 » de
`couverture-ch41-48.md` mise à jour (preuve fusionnée).

Tests : `frontend/test/pilotage-visuels.test.tsx` (agrégations, une devise par graphique, états vides, non mesuré
motivé, jauges, chronologie vide) ; tests existants conservés (assertions ajustées de « un seul » à « au moins un »
élément lorsque les visuels répètent un libellé).
