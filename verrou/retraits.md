# Retraits explicites du verrou de non-régression

Chaque ligne : date, catégorie, élément, motif, décision.

| Date | Catégorie | Élément | Motif | Décision |
|---|---|---|---|---|
| 2026-11-10 | tests | backend/test/tendances.test.ts :: les rappels de l’agent existant « Rappels personnalisés » reprennent la mention du brief approuvé — et l’oublient dès qu’il est révoqué | Remplacé par le test de l'alignement en métadonnée interne (aucune mention visible), même contrôle de révocation | Maître d'ouvrage, 10/11/2026 : fonctionnement invisible pour les usagers |
| 2026-11-10 | tests | backend/test/tendances.test.ts :: l’agent « Veille des tendances » figure dans le catalogue des Agents IA de recettes, avec son circuit | Remplacé par le test qui vérifie que l'agent est masqué du catalogue affiché (code conservé) | Maître d'ouvrage, 10/11/2026 : fonctionnement invisible pour les usagers |
