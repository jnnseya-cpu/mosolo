# KINSHASA MOSOLO — frontend (PWA)

Application web progressive de la plateforme souveraine des recettes de la Ville Province de Kinshasa.
Vite 5 + React 18 + TypeScript strict, react-router 6, Recharts 2, CSS natif (propriétés personnalisées, aucun framework CSS).
Le frontend n’importe **jamais** de code backend : il n’utilise que `@mosolo/shared` (types, `formatMoney`, `CURRENCIES`, `LANGUAGES`, `t()`, catalogue `EVENTS`, format `AIRecommendation`) et les routes de `specs/contrat-api.md`.

## Démarrer

```bash
# depuis la racine du dépôt
npm run dev -w frontend          # http://localhost:5173
npm run typecheck -w frontend
npm test -w frontend             # vitest + jsdom
npm run build -w frontend        # tsc + vite build + service worker (dist/)
npm run preview -w frontend      # sert dist/ (http://localhost:4173) — PWA installable
```

Variable d’environnement : `VITE_API_URL` (défaut `http://localhost:8080`), par ex. `VITE_API_URL=https://api.mosolo.example npm run build -w frontend`.

L’authentification de démonstration passe par l’en-tête `x-demo-user` : choisissez l’utilisateur dans l’en-tête (liste `GET /v1/demo/users`, libellés courts par rôle, nom complet en infobulle).

## Écrans

| Route | Écran | Appels |
|---|---|---|
| `/` | Accueil éditorial : visuel officiel, plan nocturne procédural, chaîne des 13 maillons (frise pilotée par le défilement), chiffres sourcés, principes, index des espaces, pied de page institutionnel | — |
| `/inscription` | Inscription, question « Quelle est votre situation à cette adresse ? » (8 situations), brouillon enregistré automatiquement | `POST /v1/registrations` |
| `/espace` | Espace contribuable : biens (couleur de situation + libellé), obligations (cartes sur mobile), « Comment ce montant est calculé », paiement (canal, clé d’idempotence, référence, instructions USSD), quittances (texte du QR), réclamation enregistrée automatiquement | `GET /v1/taxpayers/:id`, `GET /v1/obligations/:id`, `POST …/payment-orders`, `POST /v1/appeals` |
| `/verifier` | Vérification publique minimale, grand pictogramme d’état, scan QR par caméra (BarcodeDetector si disponible) | `GET /v1/public/receipts/:code` |
| `/gouverneur` | Centre de commandement : tuiles, communes (triables), catégories, échelle de la recette (11 niveaux), cumul vs cible, scénarios, grille des communes, alertes, actions recommandées ; consolidation CDF avec bascule USD (taux et date affichés) | `GET /v1/dashboards/governor`, `POST /v1/ai/insights` |
| `/communications` | Console du module 39 : synthèse, couverture par canal, QA des modèles (aperçu en `iframe` bac à sable + envoi de test), dernières délivrances, catalogue par catégorie | `GET /v1/communications/overview · events · preview/:code`, `POST /v1/communications/test` |
| `/registre` | Registre juridique : statuts (« À vérifier — aucun effet financier » en rouge), fiche complète, frise des 4 approbations distinctes, approbation par rôle, création de fiche (brouillon) | `GET/POST /v1/legal-rules`, `POST …/approve` |
| `/tresor` | Grand livre (équilibre), exceptions de rapprochement, import de relevé (brouillon), coffre des comptes bénéficiaires (vérification hors bande, compte à rebours de 72 h) | `GET /v1/reconciliation/exceptions`, `GET /v1/ledger/balance`, `POST /v1/settlements/statements`, `GET /v1/beneficiary-accounts`, `POST …/change-requests[/:id/approve]` |
| `/terrain` | Application terrain hors ligne : missions (démo), GPS + précision, photo hachée SHA-256 sur l’appareil, observations, file locale, lot signé HMAC (`x-device-signature`) | `POST /v1/field-sync/batches` |
| `/audit` | Intégrité de la chaîne d’audit + événements | `GET /v1/audit/verify · events` |
| `/ia` | Recommandations à instruire (accepter / rejeter avec motif) | `GET /v1/ai/recommendations`, `POST …/decide` |
| `/hors-ligne`, `*` | Page hors ligne, page 404 | — |

Composants transverses : `AutosaveStatus` + `useAutosave` (PUT `/v1/drafts/:key` 1,5 s après chaque modification, copie locale immédiate, repli hors ligne, restauration au rechargement, historique des versions), `AIInsightPanel` (8 champs + bloc de décision + avertissement), `StatusBadge` (couleur + icône + libellé), `MoneyText` (`formatMoney` : drapeau + code ISO ; contre-valeur indicative en CDF si la devise légale diffère), `ChartCard` (bascule « Vue tableau », mention EXEMPLE), `EmptyState`, `ErrorState`, `OfflineBanner`.

Dégradation : si le backend est injoignable, chaque écran affiche un état d’erreur explicite ; le centre de commandement, la console des communications et le registre (fiches de l’Annexe B) basculent sur des données embarquées clairement marquées **EXEMPLE — non opposable**.

## PWA

- Manifeste : nom « KINSHASA MOSOLO », `short_name` « MOSOLO », `theme_color` `#232C6B`, `background_color` `#F5F7FB`, `lang` fr, `display` standalone, `start_url` `/`.
- Service worker (vite-plugin-pwa / Workbox) : coquille applicative en précache, repli de navigation vers `index.html`, cache **network-first** pour `GET /v1/meta` et les vérifications publiques de quittance.
- Installation : bouton « Installer l’application » (événement `beforeinstallprompt`) sur l’accueil et dans la navigation ; sur iOS, « Partager → Sur l’écran d’accueil ».
- Hors ligne : bandeau d’information, brouillons et constats terrain conservés sur l’appareil puis envoyés au retour du réseau.

## Charte graphique (Ville de Kinshasa)

- **Logo principal** : `public/logo-ville-de-kinshasa.png`, utilisé **sans aucune modification** (mise à l’échelle seule, rapport d’aspect conservé) dans l’en-tête. Tant que le fichier n’est pas fourni, repli sur un mot-symbole texte « VILLE DE KINSHASA » et un filet tricolore vertical — l’emblème n’est jamais redessiné ni imité.
- **Visuel institutionnel** : `public/media/couverture-ville-de-kinshasa.webp`, non modifié (seuls `object-fit`/`object-position`), jamais recadré sur le sceau : ouverture de l’accueil, écran d’attente, page hors ligne, panneau gauche de `/inscription` et `/verifier` (bandeau sur mobile), image Open Graph.
- **Marque du réalisateur** : `public/logo-groupe-nseya.png`, inchangé, uniquement en petit dans le pied de page (« Réalisé par Groupe Nseya »).
- **Icônes PWA** : carré bleu marine avec monogramme « M » blanc et filet tricolore, générées sans dépendance par `node scripts/make-icons.mjs` (aucun emblème).
- **Jetons** : bleu marine du blason `#232C6B` (en-tête, boutons principaux, titres), bleu drapeau `#1E9BD7` (accent, liens sur fond sombre), jaune `#F7D618` (accent uniquement, jamais en texte sur blanc), rouge `#D7141A` (alertes), vert palme `#1E8C3A`, or `#E0A526`, encre `#111111` / `#4A4F5C`, surfaces `#F5F7FB` / `#E9EDF7`. Filet tricolore sous l’en-tête. Thème sombre (préférence système + bascule), jetons sur `:root`.
- **Typographie** : Fraunces (titres, auto-hébergée via @fontsource) et Inter (texte), chiffres tabulaires.
- **Graphiques** : palette catégorielle validée, ordre fixe jamais recyclé `#1E9BD7, #E0A526, #4453b5, #eb6834, #8a5cc2, #e87ba4, #1E8C3A, #e34948` (variante sombre ajustée et validée), couleurs d’état réservées (bon `#0ca30c`, vigilance `#fab219`, sérieux `#ec835a`, critique `#d03b3b`) toujours avec icône et libellé ; traits fins, extrémités arrondies, étiquettes directes, légende dès 2 séries, un seul axe, info-bulles, « Vue tableau ».
- **Sobriété** : aucun émoji d’interface (seuls les drapeaux de devise), aucune icône « magique » ; les fonctions d’IA sont désignées « Analyse » / « Recommandation » avec une marque monochrome. Langues désignées par leur nom natif, jamais par un drapeau.

## Direction artistique — photographies

L’accueil utilise par défaut une vue aérienne nocturne **procédurale** (canvas, parallaxe, grain, vignettage ; image fixe si `prefers-reduced-motion`). Aucune photo n’est générée ni simulée. Pour intégrer de vraies photographies :

1. Déposer `public/media/hero.avif`, `hero.webp` et `hero.jpg` (2400 × 1350 min., sRGB).
2. Dans `src/pages/Home.tsx`, renseigner `HERO_PHOTO = { base: '/media/hero' }` : un élément `<picture>` remplace alors la vue procédurale.

Notes de prise de vue : Kinshasa de nuit, vue aérienne ou depuis un point haut (boulevard du 30 Juin, fleuve Congo, Pool Malebo), lumières chaudes, ciel sombre, zone calme à gauche pour le titre ; aucune personne identifiable, aucun bâtiment privé reconnaissable ; droits d’usage cédés à la Ville.

## Accessibilité

WCAG 2.1 AA visé : libellés explicites, focus visible, cibles tactiles ≥ 44 px, `aria-live` pour l’enregistrement automatique, tableaux repliés en cartes sous 720 px, graphiques doublés d’une vue tableau, contrastes vérifiés en clair et en sombre, lien d’évitement.

## Structure

```
src/
  main.tsx, App.tsx, context.tsx, styles.css, i18n-extra.ts
  components/  Shell, Brand, Selectors, AIInsightPanel, AutosaveStatus, VersionHistory, ChartCard, charts,
               DataTable, Drawer, MoneyText, StatusBadge, MapStatusChip, States, Icon, CityNight, Split
  hooks/       useAutosave, useApi, useOnline, useInstallPrompt, useInsight
  lib/         api, normalize, money, palette, i18n, drafts, crypto, status, types
  pages/       Home, Registration, TaxpayerSpace, Verify, Governor, Communications, LegalRegister,
               Treasury, Field, Audit, AIInbox, NotFound, Offline
  demo/        données d’EXEMPLE embarquées (gouverneur, communications)
test/          vitest (MoneyText, AutosaveStatus, AIInsightPanel, sélecteurs, normalisation)
```

Toutes les chaînes passent par `t()` de `@mosolo/shared` ; les clés propres au frontend sont dans `src/i18n-extra.ts` (français, langue de référence).
