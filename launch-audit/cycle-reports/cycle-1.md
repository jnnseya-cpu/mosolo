# Cycle 1 — 24/10/2026 (commit 7ae85f1, dépendances : commit précédent)

**Reconnaissance :** quatre audits en lecture seule (hygiène, sécurité du code récent, câblage fonctionnel, isolement
des données de démonstration), `npm audit`, parcours automatisé de 205 routes × 5 rôles à 360 px.

**Corrigé :** D-01, D-02, D-04, D-05, D-06, D-07, D-09, D-10, D-11, D-12, D-14 (voir `../defects.md`), ainsi que
`.gcloudignore` à la racine, `render.yaml` marqué historique et les variables manquantes du modèle `.env` de production.

**Tests ajoutés :** `cles-garde.test.ts`, `traduction-budget.test.ts`, cas « par devise » de `agents-recettes.test.ts`,
cas « tableau du Gouverneur » de `mode-production.test.ts`, `frontend/test/liens-serveur.test.ts`,
`frontend/test/mode-production-front.test.tsx`.

**Cassé puis réparé dans le cycle :** une erreur de lint introduite par le correctif D-01 (affectation inutile) ; un
résultat attendu erroné dans un test neuf (le commentaire du test était juste, la valeur non).

**Régression :** typecheck, lint, 1 327 + 445 + 32 tests, construction : verts.

**Portes :** sécurité — 0 P0/P1 ouvert après cycle (D-01 corrigé) ; les autres portes restent bloquées par des
éléments externes (`../human-actions.md`).
