# KINSHASA MOSOLO — consignes permanentes du maître d'ouvrage

## Règle n° 1 : on ajoute, on ne retire jamais (27/09/2026)

Les nouvelles spécifications s'ajoutent à l'existant. **Rien de ce qui existe ne doit être supprimé, retiré ni omis** :
modules, écrans, routes, règles, contrôles anti-fraude, tests, documents (document maître, annexes, captures, PDF, Word),
données de démonstration.

- Toute nouvelle exigence est construite **par-dessus** l'existant, ou l'**enrichit** : fusionner, combiner et
  harmoniser avec ce qui est déjà construit (mêmes circuits, mêmes règles, même vocabulaire), jamais en parallèle.
- Si une nouvelle exigence semble contredire l'existant : ne rien supprimer ; harmoniser (l'ancien comportement reste
  disponible ou est étendu) et signaler la contradiction au maître d'ouvrage pour arbitrage.
- Un nettoyage technique (code mort, doublons) ne retire aucune fonctionnalité ni aucun contrôle ; en cas de doute, on garde.
- Le document maître (`docs/document-maitre/`, annexe I) est mis à jour à chaque ajout, sans effacer les sections existantes.

## Autres principes constants

- Les agents de terrain ne reçoivent jamais d'espèces ; paiements numériques vers le compte public uniquement.
- L'IA propose, une personne décide ; aucune sanction automatique.
- Aucun taux, tarif ni seuil inventé : les valeurs non confirmées sont marquées « par défaut — à confirmer par le maître
  d'ouvrage » ; les données de démonstration sont marquées non contractuelles.
- Logos non modifiés ; interface et commentaires en français.
- **Noms en français d'abord (27/09/2026)** : tous les modules, verticales, écrans, menus, statuts et autres noms affichés
  dans la plateforme ont un nom français principal ; un nom de marque ou un terme anglais n'apparaît qu'en second, entre
  parenthèses (ex. « Stationnement intelligent (ParkSmart) », « Centre de commandement (Command Centre) »).
- Avant de livrer : `npm run typecheck && npm run lint && npm test && npm run build -w frontend`, et
  `python3 tools/gen_routes.py` si des routes changent.
