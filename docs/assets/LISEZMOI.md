# Logos — règles d'usage

| Fichier | Rôle | Statut |
|---|---|---|
| `logo-ville-de-kinshasa.png` | **Logo principal** de la plateforme (en-têtes, page d'accueil, documents, graphiques, courriels) | **À déposer** : le fichier original transmis par la Ville doit être copié ici tel quel. Il est ensuite repris automatiquement par `tools/gen_graphiques.py`, `tools/build_docx.py` et, via `frontend/public/`, par l'application |
| `logo-groupe-nseya.png` | Mention « réalisé par » | Présent (extrait sans modification des documents de travail) |

Règles : les logos sont utilisés **sans aucune modification** (pas de recadrage, de recoloration, de filtre, de redessin) ; seul le redimensionnement proportionnel est permis. L'usage de l'emblème officiel de la Ville est soumis à l'autorisation de la Ville de Kinshasa.

Après dépôt du logo de la Ville :

```bash
cp docs/assets/logo-ville-de-kinshasa.png frontend/public/
python3 tools/gen_graphiques.py && python3 tools/build_docx.py
```

Charte de couleurs : marine de l'écu `#232C6B` ; bleu du drapeau `#1E9BD7` ; jaune `#F7D618` ; rouge `#D7141A` ; or `#E0A526` ; vert `#1E8C3A` ; encre `#111111`.
