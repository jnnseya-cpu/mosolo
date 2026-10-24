# Cycle 2 — 24/10/2026

**Corrigé :** D-08 — une base remplie par une démonstration n'est plus relue hors démonstration (démarrage refusé).

**Test :** `mode-production.test.ts` (détection des lignes marquées et refus au démarrage). Le test existant
`securite.test.ts` (« chaîne d'audit restaurée non vérifiée ») utilisait une base de démonstration comme base de
production : son montage a été ajusté (premier serveur sans données de démonstration, un événement d'audit ordinaire) ;
**ses assertions sont inchangées**. Même ajustement pour `plateforme-integrite.test.ts` (5 tests de l'ancre d'audit : le
serveur « hors démonstration » y était semé de données de démonstration ; il démarre désormais sans elles, et un
événement d'audit ordinaire amorce la chaîne sur une base neuve) — assertions inchangées.

**Régression :** typecheck, lint, partagé 32 · serveur 1 328 (+1 ignoré) · application 445, construction : verts.

**Restant :** voir `../defects.md` (statuts OUVERT / BLOQUÉ) et `../human-actions.md`. Deux cycles supplémentaires ne
lèveraient aucun des blocages externes : la boucle s'arrête sur le cas 3 du prompt (NO-GO avec liste d'actions humaines).
