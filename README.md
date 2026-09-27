<img src="docs/assets/couverture-ville-de-kinshasa.webp" alt="Ville de Kinshasa" width="100%">

# KINSHASA MOSOLO

**Système d'exploitation souverain de maximisation des recettes de la Ville Province de Kinshasa**

*Plateforme unique de recensement, de géolocalisation, de gestion, de paiement, de contrôle et de maximisation des recettes de la Ville Province de Kinshasa.*

> « Une ville, un contribuable, une donnée, une quittance. »

`RECENSER → IDENTIFIER → GÉOLOCALISER → QUALIFIER → CALCULER → NOTIFIER → PAYER → RAPPROCHER → QUITTANCER → CONTRÔLER → RECOUVRER → AUDITER → PLANIFIER`

## Contenu du dépôt

| Dossier | Contenu |
|---|---|
| [`docs/document-maitre/`](docs/document-maitre/) | **Document maître v3.0** en Markdown (47 chapitres, conclusion stratégique, annexes A à I), diagrammes Mermaid, figures en couleur |
| `docs/KINSHASA_MOSOLO_Document_Maitre_v3.0.docx` | Version Word aux couleurs de la charte (générée) |
| `docs/KINSHASA_MOSOLO_Document_Maitre_v3.0.md` | Version Markdown assemblée en un seul fichier (générée) |
| [`docs/sources/`](docs/sources/) | Documents de travail d'origine (Cahier v2.9, Spécification fonctionnelle, Dossier Gouverneur, Note exécutive) |
| [`docs/assets/`](docs/assets/) | Visuels officiels, utilisés sans modification : couverture Ville de Kinshasa (`couverture-ville-de-kinshasa.webp`, copie PNG sans perte pour Word), logo de la Ville (`logo-ville-de-kinshasa.webp`, et copie PNG sans perte), logo Groupe Nseya |
| [`specs/`](specs/) | Contrat d'API, OpenAPI 3.1, catalogue des 555 routes (`routes-api.md`), catalogue des 255 événements de communication, référentiel des devises et langues, prompt système de la couche d'intelligence |
| [`shared/`](shared/) | Paquet partagé `@mosolo/shared` : montants exacts, devises (🇨🇩 CDF principale, drapeaux), langues, catalogue d'événements, fiches de règles, états et rôles, format des recommandations IA |
| [`backend/`](backend/) | API REST (Node.js, TypeScript, Fastify) : identité, objets, registre juridique, liquidation, paiements, coffre des bénéficiaires, rapprochement, grand livre, quittances, journal d'audit chaîné, communications, autosauvegarde, IA ; **14 modules d'extension** (`src/plugins/`) : accès et entités, fiscal, Trésor, recouvrement, titres, RakaPay et pass wewa, stationnement, publicité, verticales (AVIA, NFIU, CALCU…), canaux (USSD, SVI, points de paiement agréés), terrain, intégrité, pilotage, IA ; persistance PostgreSQL optionnelle et identité compatible OIDC |
| [`frontend/`](frontend/) | Application web progressive (PWA) React : portail contribuable, vérification de quittance, centre de commandement du Gouverneur, console des communications, registre juridique, Trésor, terrain hors ligne, audit, et 70 écrans des modules (`src/modules/`) |
| [`tools/`](tools/) | Générateurs : catalogue d'événements, graphiques, version Word |

Le `frontend` ne dépend du `backend` que par l'API ; la logique commune vit dans `shared`.

## Démarrer

```bash
npm install
npm test                 # tests des trois paquets
npm run dev:backend      # API sur http://localhost:8080 (mode démonstration explicite : --demo)
npm run dev:frontend     # PWA sur http://localhost:5173
```

Régénérer les artefacts documentaires :

```bash
pip install pypandoc_binary python-docx matplotlib
python3 tools/gen_evenements.py      # catalogue d'événements (YAML, JSON partagé, annexe G)
python3 tools/gen_graphiques.py      # figures en couleur
MMDC=/chemin/vers/mmdc PUPPETEER_CONFIG=pp.json python3 tools/build_docx.py   # version Word
```

## Principes non négociables

1. Le système applique le droit, il ne le crée pas : aucune obligation sans règle **active et certifiée** ; les fiches de règles fournies sont au statut `A_VERIFIER` et ne produisent aucun effet financier.
2. Fonds publics sur comptes publics : la plateforme ne détient jamais de fonds.
3. Aucune personne ne peut seule modifier une dette, un paiement, un compte bénéficiaire, une règle ou une trace.
4. Toute correction est une contre-écriture ; rien ne disparaît.
5. L'IA recommande ; les agents habilités décident.
6. Zéro espèce entre les mains des agents.

## Statut

Document de travail et socle logiciel de démonstration, soumis à validation juridique provinciale. L'authentification (en-tête de démonstration), le stockage (mémoire) et l'IA (générateur déterministe) sont des implémentations de démonstration ; voir les README de chaque paquet et l'Annexe E du document maître.
