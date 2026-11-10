# Veille des tendances (Trend Intelligence) — fusion dans MOSOLO (10/11/2026)

Source : « Trend Intelligence AI — Developer build and distribution specification » v2.3 du 10/11/2026, conservée telle
quelle dans `docs/sources/trend-intelligence-ai-build-spec-v2.3.md`. Décision du maître d'ouvrage : **fusionner** dans
MOSOLO, code **dans ce dépôt**. Conformément à la règle n° 1 (`CLAUDE.md`), la spécification est construite **sur** les
circuits existants (moteur de politiques, journal d'audit chaîné, idempotence, relais d'IA, pages publiques), pas en
parallèle. Rien d'existant n'est retiré.

## Invisible et automatique dans des bornes (décision du 10/11/2026)

Rien n'est visible des usagers : aucune entrée de menu, agent masqué du catalogue affiché, aucune mention publique.
Un cycle en arrière-plan collecte et calcule chaque heure ; après l'opt-in unique du directeur de cabinet, il applique
seul les modifications réversibles des articles et pages (score et confiance ≥ 85, mentions approuvées, une par page et
par période de repos) et les retire seul si le brief expire ou si la mesure se dégrade. Jamais d'envoi, de dépense ni
de sanction automatiques. `MOSOLO_TENDANCES_AUTO=off` coupe le cycle.

## Intégrée à toute la plateforme (décision du 10/11/2026 : « pas une plateforme à part »)

- **Aucune entrée de menu à part** : la Veille des tendances est l'agent `TENDANCES` du hub existant « Agents IA de
  recettes » (famille Paiement) ; son écran de travail `/tendances` s'ouvre par « Ouvrir le circuit ».
- **Signaux de tous les modules** : ordres de paiement de chaque démarche (vignette, stationnement, publicité, étals,
  spectacles, voirie…), doléances par catégorie, visites des articles du blog et des pages propres.
- **Surfaces existantes** : les articles du blog public (`/blog/:slug`) suivent la révision approuvée (titre, accroche,
  appel) — démonstration : « Stationnement intelligent (ParkSmart) » ; sans révision, l'article d'origine s'affiche.
  La page propre `/page/:slug` ne sert qu'aux démarches sans article.
- **Agents existants** : l'agent « Rappels personnalisés » lit le brief approuvé à chaque calcul (canal `lifecycle`,
  circuit existant : envoi sur décision d'une personne, préférences et consentements respectés) et reprend sa mention
  et son appel ; dès que le brief expire ou est révoqué, le rappel revient à son texte de base.
- **Mêmes circuits** : moteur de politiques, chaîne d'audit, idempotence, relais d'IA Claude → OpenAI → Gemini et ses
  plafonds, persistance commune, verrou de non-régression.

## Où se trouve quoi

| Élément | Emplacement |
|---|---|
| Module serveur (calculs, contrat, service, routes) | `backend/src/plugins/tendances/` (`scoring.ts`, `contrat.ts`, `model.ts`, `service.ts`, `plugin.ts`) |
| Écran de travail « Veille des tendances (Trend Intelligence) » | `frontend/src/modules/tendances/Tendances.tsx` → `/tendances` (depuis « Agents IA de recettes ») |
| Articles du blog qui suivent la révision approuvée | `frontend/src/pages/Blog.tsx` |
| Rappels alignés sur le brief | `backend/src/plugins/agents-recettes/service.ts` (`rappels`) |
| Page propre publique (révision active seulement, mesure agrégée) | `frontend/src/modules/tendances/PagePropre.tsx` → `/page/:slug` |
| Contrat Growth Brief v1 (copie exacte de l'annexe A) et fixtures | `trend-intelligence/contracts/` |
| Scénarios de conformité | `backend/test/tendances.test.ts` |

## Correspondance des routes (spécification → MOSOLO)

Les chemins sont en français et portent l'installation (`:inst`) ; la portée et le rôle viennent toujours de la session.

| Spécification (§ 6, § 16) | MOSOLO |
|---|---|
| `PUT /v1/profile` (If-Match / If-None-Match: *) | `PUT /v1/tendances/installations/:inst/profil` (mêmes en-têtes ; 428 sans précondition) |
| `POST /v1/observations:batch` | `POST /v1/tendances/installations/:inst/observations/lot` (Idempotency-Key, lot atomique, 409 si valeur divergente) |
| — (collecte automatique propre) | `POST /v1/tendances/installations/:inst/collecte` · calcul : `POST …/calcul` |
| `GET /v1/opportunities` | `GET /v1/tendances/installations/:inst/opportunites` |
| `POST /v1/briefs` | `POST /v1/tendances/installations/:inst/opportunites/:id/brief` |
| `POST /v1/briefs/{id}:approve` (If-Match) | `POST /v1/tendances/installations/:inst/briefs/:id/approbation` (If-Match) · révocation : `…/revocation` |
| `GET /v1/briefs:effective` (204 si rien) | `GET /v1/tendances/installations/:inst/brief-effectif?marche&locale&sujet&canal` (204 si rien) |
| `POST /v1/actions` | `POST /v1/tendances/installations/:inst/briefs/:id/generation` (agents SEO et marketing, même brief) |
| `POST /v1/actions/{id}:approve` | `POST /v1/tendances/installations/:inst/actions/:id/approbation` (empreinte exacte, auteur ≠ approbateur) |
| `POST /v1/actions/{id}:execute` | file d'exécution : déclenchée à l'approbation, reprise par `POST /v1/tendances/travaux` (exploitation, R27) |
| `POST /v1/actions/{id}:rollback` | `POST /v1/tendances/installations/:inst/actions/:id/retour` |
| `GET /v1/actions/{id}` | `GET /v1/tendances/installations/:inst/actions/:id` (avant / après) |
| `GET /v1/experiments/{id}` | `GET /v1/tendances/installations/:inst/actions/:id/mesure` |
| `POST /v1/outcomes:batch` | mesure propre : `POST /v1/public/tendances/pages/:slug/evenements` (agrégats) |
| gel d'urgence (§ 8) | `POST /v1/tendances/installations/:inst/gel` |

## Couverture des scénarios de conformité (§ 21)

| ID | État | Remarque |
|---|---|---|
| TI-01 | Couvert | Doublons comptés ; même clé, autre valeur ⇒ 409 |
| TI-02 | Partiel | Isolement par installation (404) ; pas de rôle SQL ni de sécurité au niveau des lignes (persistance MOSOLO) |
| TI-03 | Couvert | 86,25 / 83,5 exacts, aucun arrondi avant décision |
| TI-04 | Partiel | Sources périmées et une seule famille plafonnées ; déduplication des reprises d'un même article non construite (pas de flux public) |
| TI-05 | Couvert | Brief expiré ou révoqué : 204, action en file refusée |
| TI-06 | Couvert | Sortie du modèle à clés fermées ; chiffres et mentions contrôlés ; repli déterministe |
| TI-07 | Couvert | Reçu de l'adaptateur ⇒ un seul effet après panne |
| TI-08 | Couvert | Conflit de révision avant écriture et au retour arrière |
| TI-09 | Couvert | Réservation par unité de travail ; 429 au plafond |
| TI-10 | Partiel | Mode déterministe sans aucun appel externe ; **aucun modèle local embarqué** |
| TI-11 | Partiel | Gel : plus d'écriture, retour arrière possible ; pas de plan commercial ni d'expiration d'essai |
| TI-12 | Couvert | Aucun circuit d'envoi direct (courriel, SMS) dans ce module |
| TI-13 | Non construit | Pas de facturation (plan commercial hors périmètre MOSOLO) |
| TI-14 | Couvert | Sujet hors profil ⇒ veto |
| TI-15 | Non construit | Effacement puis restauration : à traiter avec la politique de conservation MOSOLO |
| TI-16 | Couvert | Brouillons approuvés puis export consigné |
| TI-17 | Couvert | Deux installations neutres (fixtures A et B) sans condition sur le nom |
| TI-18 | Couvert | IA de l'hôte = relais Claude → OpenAI → Gemini de MOSOLO ; aucune clé dans le module |
| TI-19 | Couvert | Sans IA : détection, score, modèles déterministes |
| TI-20 | Partiel | Page propre native ; pas d'adaptateur vers un CMS externe |
| TI-21 | Partiel | Chaîne complète sur la page propre, mais rédaction déterministe (pas d'inférence locale) |
| TI-22 | Couvert | Source qui exigerait une clé nouvelle : « indisponible », jamais demandée |

## Contradictions et choix à arbitrer (signalés au maître d'ouvrage)

1. **Pile technique.** La spécification prévoit un service Python / FastAPI / PostgreSQL (sécurité au niveau des lignes),
   des images signées et Helm. La règle n° 1 impose de fusionner dans les circuits existants : le module est en
   TypeScript / Fastify sur la persistance MOSOLO. Les contrats (Growth Brief v1, états, codes d'erreur, idempotence)
   sont respectés ; le service autonome Python, les SDK Python / TypeScript et l'emballage Helm ne sont pas construits.
2. **Porte de publication complète (§ 20).** Elle exige une inférence **locale** embarquée (Qwen3-8B / llama.cpp) avec
   sortie réelle d'un modèle, sans aucun accès réseau. MOSOLO n'embarque aucun modèle : sans clé, la rédaction est
   déterministe (signalée « dégradée »). La porte n'est donc **pas** franchie ; décision attendue (serveur GPU, coût).
3. **Plan commercial (§ 19).** Abonnements, droits, facturation, licence hors ligne : non construits (sans objet pour
   MOSOLO tant qu'aucune revente n'est décidée). Seul le quota mensuel de générations existe (50 — à confirmer).
4. **Rôles.** Proposer : R06, R07, R08, R29 ; approuver (brief, action, page, retour) : R02, R03 ; geler : R02, R26, R28 ;
   file d'exécution : R27 — par défaut, à confirmer.
5. **Flux publics sans clé (RSS, Google Trends Trending Now).** Le lecteur n'est pas construit (aucun accès réseau sortant
   en démonstration) ; l'import CSV couvre le besoin. L'API Google Trends est affichée « indisponible ».
6. **Seuils.** Tous ceux de la spécification (20 / 2 / 4 périodes, 60 / 55 / 75 / 85, plafond 69, 7 jours / 24 h,
   échantillon 30, retour à 80 %) sont repris « par défaut — à confirmer », jamais inventés.
7. **Coût de l'IA.** Chaque génération par l'IA compte dans le plafond MOSOLO de 100 appels par jour et 10 par personne
   et par heure (§ I.56).
