# KINSHASA MOSOLO — kits de déploiement

Aucun kit ne réduit la plateforme : la même image (tous les modules, API + application web) est publiée partout ;
la production ne démarre **jamais** en `--demo` et exige PostgreSQL et des clés réelles. État : **kits prêts,
exécution réelle EXTERNE / NON TESTÉE** (voir `docs/production-readiness.md`, § 19).

| Dossier | Cible | Point d'entrée |
|---|---|---|
| [`gcp/`](gcp/) | **Google Cloud** (principal) : Cloud Run, Cloud SQL PostgreSQL 16 (IP privée, PITR), Secret Manager, tâches de migration et de sauvegarde, Cloud Scheduler, domaine ; variante **démonstration** séparée (remplace Render) | `PROJECT_ID=… ./infra/gcp/deploy.sh` |
| [`vps/`](vps/) | **VPS / centre de données national** : Docker Compose (application, PostgreSQL 16, Caddy HTTPS, sauvegarde quotidienne) | `./infra/vps/install.sh` puis `./infra/vps/deploy.sh` |
| [`static/`](static/) | **Vercel / Firebase Hosting** : application web seule, `/v1/*` réécrit vers le backend | `./infra/static/preparer.sh vercel\|firebase` |
| [`docker/`](docker/) | Point d'entrée de l'image (`demo`, `production`, `migrate`, `backup-once`, `backup-cron`, `verify`, `restore`, `bootstrap-check`) | `Dockerfile` |

Validation hors ligne de tout le kit (sans compte cloud, rien n'est déployé) : `./infra/valider.sh` — syntaxe et
shellcheck des scripts, hadolint, simulations `DRY_RUN=1`, YAML/JSON stricts, `docker compose config`.
Côté logiciel : `backend/test/deploiement.test.ts` (migrations rejouables, démarrage de production avec la liste
documentée des variables, refus nommant chaque variable manquante, bail de l'instance active, rôles PostgreSQL).
