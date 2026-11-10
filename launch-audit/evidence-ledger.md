# Registre des preuves — audit du 24/10/2026

Statuts : PASS · FAIL · PARTIAL · BLOCKED · NOT TESTED · N/A. Une revue de code seule ne donne jamais PASS.
Environnement : copie locale du dépôt, serveur en mode démonstration (`tsx backend/src/server.ts --demo`, port 8099),
Chromium (Playwright), Node.js 22.22.2 local (l'image de production exige 22.23.4+). Aucun paiement réel, aucun message
réel, aucune action sur la production.

| ID | Contrôle | Commande / méthode | Résultat | Statut |
|---|---|---|---|---|
| E-01 | Installation reproductible | `npm ci` (verrou unique `package-lock.json`) | Sans erreur ; `npm ci --dry-run` cohérent après mise à jour du verrou | PASS |
| E-02 | Typage | `npm run typecheck` (3 espaces de travail) | 0 erreur | PASS |
| E-03 | Lint | `npm run lint` | 0 erreur, 0 avertissement (1 erreur introduite puis corrigée pendant le cycle) | PASS |
| E-04 | Tests automatisés | `npm test` | partagé 32 · serveur 1 327 (+1 ignoré, antérieur) · application 445 — tous verts après cycle 1 ; cycle 2 : voir `cycle-reports/cycle-2.md` | PASS |
| E-05 | Construction de production | `npm run build -w frontend` | Réussie (PWA, service worker, manifeste) | PASS |
| E-06 | Catalogue des routes | `python3 tools/gen_routes.py` | 1 674 routes (44 manquaient avant correctif D-10) | PASS |
| E-07 | Dépendances de production | `npm audit --omit=dev` | Avant : 3 (zod élevée, fast-uri modérée, fastify faible) · après : 1 (zod, D-13) | PARTIAL |
| E-08 | Dépendances de développement | `npm audit` | vitest / vite / esbuild : correctifs en montée majeure, outillage seulement | PARTIAL |
| E-09 | Secrets dans le dépôt | Recherche de motifs (clés, PEM, `sk_live_`, `whsec_`, `AIza`, `sk-ant-`) sur les fichiers suivis | Aucun secret réel (valeurs de test et préfixes seulement) ; historique git complet non analysé par un outil dédié | PARTIAL |
| E-10 | Parcours de toutes les routes sans paramètre, 5 rôles, 360 × 800 | Script Playwright (205 routes × 5 rôles) | 1 025 visites · 0 erreur JavaScript · 0 réponse 5xx · 67 débordements → corrigés (D-11), 0 restant à la re-vérification | PASS |
| E-11 | Liens d'écran de l'application | Analyse de 432 cibles `to=` / `href=` / `navigate(` contre 223 routes | 0 lien cassé | PASS |
| E-12 | Liens d'écran envoyés par le serveur | `frontend/test/liens-serveur.test.ts` | 3 cassés → corrigés (D-09) ; le test échoue si l'un est réintroduit (vérifié) | PASS |
| E-13 | Appels de l'application vers le serveur | 1 367 chemins `/v1` comparés aux 1 674 routes | 0 appel mort | PASS |
| E-14 | Démonstration refusée en production | `mode-production.test.ts`, `securite.test.ts`, `deploiement.test.ts` | En-tête `x-demo-user`, liste des comptes fictifs, page de paiement simulée, secrets de démonstration : refusés hors démonstration | PASS |
| E-15 | Garde-fous de la console des clés | `backend/test/cles-garde.test.ts` | Hôte étranger refusé (403), désactivation des signatures refusée, plafond IA entier, verrou de démonstration publique | PASS |
| E-16 | Seuil de publication par devise | `agents-recettes.test.ts` | Un seul payeur en USD : devise non publiée | PASS |
| E-17 | Budget de traduction | `traduction-budget.test.ts` | Au-delà du budget : aucun appel, texte en français | PASS |
| E-18 | Tableau du Gouverneur en production | `mode-production.test.ts` | Aucune donnée d'exemple | PASS |
| E-19 | Application face à un serveur de production | `mode-production-front.test.tsx` | Sélecteur masqué, utilisateur fictif oublié, aucun repli d'exemple | PASS |
| E-20 | Base de démonstration relue en production | `mode-production.test.ts` | Démarrage refusé | PASS |
| E-21 | Manifeste PWA | Lecture de `frontend/dist/manifest.webmanifest` | Nom, `standalone`, `fr`, icônes 192/512 + « maskable » (D-24), service worker, `viewport-fit=cover` | PARTIAL |
| E-22 | Paiement réel (BitriPay / KODA) | — | Aucune clé de bac à sable dans cet environnement | BLOCKED (H-01) |
| E-23 | Rapprochement bancaire réel | — | Aucun relevé réel | BLOCKED (H-03) |
| E-24 | Sauvegarde → restauration sur PostgreSQL réel, chronométrée | — | Prouvé sur pg-mem et en CI (rapport du 27/09) ; pas d'exercice sur l'infrastructure cible | BLOCKED (H-05) |
| E-25 | Déploiement → retour arrière en environnement de production | — | Aucune production | BLOCKED (H-05) |
| E-26 | Charge sur l'infrastructure cible | — | Mesure du 27/09 sur machine partagée (1 200 utilisateurs virtuels, p99 1,5 s) ; non refaite | NOT TESTED |
| E-27 | Lecteur d'écran, zoom 200 %, WCAG 2.2 AA complet | — | Parcours clavier outillé existant ; pas d'audit complet | NOT TESTED |
| E-28 | Parcours « novice » chronométré sur réseau 3G lent | — | Voir `novice-walkthrough.md` | NOT TESTED |
| E-29 | Évaluation de qualité de l'IA (jeu d'évaluation, hallucinations, coûts) | — | Fournisseurs facultatifs, aucune clé ici ; règles internes testées | NOT TESTED |
| E-30 | Alertes reçues par une personne | — | Aucune astreinte réelle | BLOCKED (H-08) |
