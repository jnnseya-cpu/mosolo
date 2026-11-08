# Verrou de non-régression (08/11/2026)

Demande du maître d'ouvrage : « stabiliser et verrouiller tout ce qui a été fait ; rien ne change ni ne disparaît en
silence ». Application mécanique de la règle n° 1 de `CLAUDE.md` (on ajoute, on ne retire jamais).

| Fichier | Ce qu'il verrouille |
|---|---|
| `inventaire.json` | Relevé de référence : routes d'API, écrans, menus, modules du serveur, contrôles (codes d'erreur), titres de tests, agents d'IA, actions interdites à l'IA, articles du blog, rôles, variables de la console des clés, sections du document maître, décisions de `CLAUDE.md`, fichiers suivis |
| `donnees-demo.json` | Données de démonstration (décision du 27/09/2026) : chaque dépôt semé garde au moins son nombre d'enregistrements (semis à horloge fixe) |
| `retraits.md` | Journal des seuls retraits autorisés : date, élément, motif, décision du maître d'ouvrage (créé au premier retrait) |

## Utilisation

- `npm test` commence par `python3 tools/verrou.py` ; la CI le lance aussi (étape « Verrou de non-régression ») et le
  test `backend/test/verrou-donnees-demo.test.ts` contrôle les données de démonstration.
- Après un ajout : `npm run verrou:ajouter` (le relevé ne fait que croître, rien n'en sort).
- Un renommage ou un retrait n'est jamais silencieux : sur décision du maître d'ouvrage seulement,
  `python3 tools/verrou.py --retirer CATEGORIE "ELEMENT" --motif "…" --decision "…"` (consigné dans `retraits.md`).
- Point de restauration : étiquette git `stable-2026-11-08` (état complet verrouillé à cette date).
