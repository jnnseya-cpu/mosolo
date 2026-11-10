# Audit de lancement (launch-audit) — KINSHASA MOSOLO

Dossier de travail de l'audit de préparation au lancement (« Master Prompt v2 », 24/10/2026), en complément de
`docs/production-readiness.md` (rapport de référence, porte par porte) — rien n'y est retiré.

| Fichier | Contenu |
|---|---|
| `evidence-ledger.md` | Chaque contrôle : identifiant, commande, statut (PASS · FAIL · PARTIAL · BLOCKED · NOT TESTED · N/A), preuve |
| `defects.md` | Un enregistrement par défaut (gravité P0–P4, cause, correctif, test, statut) |
| `truth-audit.md` | Promesses publiques et état réel (REAL · PARTIAL · STUBBED · ABSENT · BROKEN) |
| `novice-walkthrough.md` | Parcours de l'usager novice : frictions relevées, ce qui n'a pas pu être testé |
| `cycle-reports/` | Rapport de chaque cycle (corrigé, cassé, restant, portes) |
| `human-actions.md` | Ce que seule une personne peut fournir ou décider |
| `evidence/` | Preuves sans donnée personnelle (parcours automatisé à 360 px, etc.) |

Règle du projet (CLAUDE.md, règle n° 1) : rien n'est supprimé sans décision du maître d'ouvrage. Là où l'audit
demande de « retirer », l'élément est corrigé, isolé ou signalé, et la suppression est proposée dans `human-actions.md`.
