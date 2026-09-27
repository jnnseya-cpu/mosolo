# KINSHASA MOSOLO — déploiement sur un VPS (Docker Compose)

Pour un serveur **Ubuntu 22.04 ou 24.04** (VPS ou centre de données **national**, solution préférée par le Cahier).
Kit **répété localement** avec Docker Compose et PostgreSQL 16 réels (voir « Ce qui a été vérifié ») ; il n'a pas été
exécuté sur un vrai VPS avec un vrai nom de domaine : cette exécution reste **EXTERNE / NON TESTÉE**.

## Ce qui tourne

| Conteneur | Rôle |
|---|---|
| `app` | Application (API + application web), argument `production` : `NODE_ENV=production`, jamais `--demo`, PostgreSQL obligatoire ; système de fichiers en lecture seule, aucune capacité, utilisateur non privilégié ; sonde `/health` |
| `postgres` | PostgreSQL 16, volume `mosolo_pg` ; jamais publié sur l'hôte |
| `caddy` | HTTPS automatique (Let's Encrypt) pour `MOSOLO_DOMAIN`, redirection HTTP → HTTPS, HTTP/3 ; seuls ports publiés : 80 et 443 |
| `sauvegarde` | Sauvegarde **signée et vérifiée** chaque jour (outil existant `npm run db:backup`), heure de Kinshasa, rotation locale dans `./sauvegardes` |
| `migration` (profil `outils`) | Tâche de migration rejouable, lancée par `deploy.sh` avant chaque mise à jour ; crée le rôle applicatif `mosolo_app` à droits minimaux |
| `outils` (profil `outils`) | Vérification et restauration d'une sauvegarde |

Volumes : `mosolo_pg` (base), `mosolo_donnees` (ancre externe de la chaîne d'audit, copie WORM, publication des
racines — hors de la base), `caddy_data` (certificats). Dossiers hôte : `./sauvegardes` (à copier hors du serveur),
`./amorcage` (fichier d'amorçage facultatif, lecture seule).

## Commandes exactes

```bash
# Sur le serveur, en root, une fois : Docker + Compose, pare-feu ufw (22, 80, 443), fail2ban, mises à jour automatiques
git clone <URL du dépôt> /opt/mosolo && cd /opt/mosolo/infra/vps
sudo ./install.sh                      # DRY_RUN=1 sudo ./install.sh pour relire d'abord ; SSH_PORT=2222 si besoin

# Configuration (une fois)
cp .env.example .env && chmod 600 .env
./deploy.sh secrets                    # génère toutes les clés et mots de passe vides (rien n'est affiché)
nano .env                              # MOSOLO_DOMAIN, MOSOLO_ACME_EMAIL, MOSOLO_PUBLIC_URL, MOSOLO_CORS_ORIGINS,
                                       # MOSOLO_WEBAUTHN_RP_ID / _ORIGINS ; secrets des prestataires convenus avec eux
# DNS : enregistrement A (et AAAA) de MOSOLO_DOMAIN vers l'adresse du serveur, AVANT le premier déploiement.

# Déploiement / mise à jour (git pull, construction, migration, redémarrage, santé, retour automatique si échec)
./deploy.sh
DRY_RUN=1 ./deploy.sh                  # simulation : affiche les commandes sans rien exécuter

# Exploitation
./deploy.sh status
./deploy.sh rollback                   # image précédente (ou : ./deploy.sh rollback <étiquette>)
./deploy.sh backup-now                 # sauvegarde signée immédiate dans ./sauvegardes
./deploy.sh verify mosolo-20261001T011500Z.json
./deploy.sh restore mosolo-20261001T011500Z.json <nom de l'opérateur>
```

Amorçage (comptes de travail, comptes du coffre) : placer `amorcage.json` dans `./amorcage/`, le contrôler
(`docker compose run --rm --no-deps app bootstrap-check /amorcage/amorcage.json`), puis dans `.env` :
`MOSOLO_BOOTSTRAP_FILE=/amorcage/amorcage.json` et `MOSOLO_BOOTSTRAP_CREDENTIALS_OUT=/var/lib/mosolo/identifiants-initiaux.json` ;
récupérer ensuite le fichier des identifiants (`docker compose cp app:/var/lib/mosolo/identifiants-initiaux.json .`),
le remettre en main propre et le **détruire** dans le conteneur et sur l'hôte.

## Retour automatique

`deploy.sh` note l'image en service (`.etat/image-courante`, `.etat/historique`, `MOSOLO_IMAGE_TAG` dans `.env`).
Si la nouvelle image n'est pas **saine** (sonde `/health`) dans `HEALTH_TIMEOUT` secondes (240 par défaut), l'image
précédente est relancée automatiquement et le script sort en erreur. Si la migration échoue, rien n'est redémarré :
l'ancienne version reste en service. Les migrations sont **additives** : l'image précédente relit la base migrée.

## Sauvegardes hors site et restauration

- Chaque nuit (02:00, heure de Kinshasa, `MOSOLO_BACKUP_HOUR`) : `./sauvegardes/mosolo-<horodatage>.json`, signé par
  `MOSOLO_BACKUP_KEY`, vérifié aussitôt (signature et chaîne d'audit), conservé `MOSOLO_BACKUP_RETENTION_DAYS` jours
  (14 par défaut — **à confirmer par le maître d'ouvrage**).
- **Hors site** (obligatoire) : copier `./sauvegardes` vers un stockage national distinct, par exemple
  `rclone copy /opt/mosolo/infra/vps/sauvegardes <distant>:mosolo-sauvegardes` ou `restic backup …` dans une tâche cron
  de l'hôte. Conserver aussi, hors du serveur, une copie de `.env` (coffre de secrets) : sans `MOSOLO_BACKUP_KEY` et
  `MOSOLO_AUDIT_HMAC_KEY`, une sauvegarde ne peut pas être vérifiée.
- Copie physique complémentaire : `docker compose exec postgres pg_dump -U mosolo_migration -Fc mosolo > mosolo.dump`.

**Restauration** (sauvegarde signée) :

```bash
./deploy.sh verify <fichier>                      # 1. vérifier (signature, chaîne d'audit)
./deploy.sh restore <fichier> <nom de l'opérateur>  # 2. arrêt de l'application, restauration, redémarrage, santé
CONFIRM_ROLLBACK=1 ./deploy.sh restore <fichier> <nom>   # sauvegarde plus ANCIENNE que la chaîne en place :
                                                  #    seulement après décision écrite (tracée dans la chaîne d'audit)
```

La restauration est faite par le rôle de migration (opérateur de restauration, migration 003), jamais par le rôle
applicatif ; elle compare la sauvegarde à l'ancre externe (retour arrière détecté) et ajoute `audit.restored`.
Restauration sur un **nouveau** serveur : `install.sh`, copier `.env` et le fichier de sauvegarde dans `./sauvegardes`,
`./deploy.sh` (base vide migrée), puis `./deploy.sh restore …` ; l'ancre du nouveau serveur étant vide, aucun retour
arrière n'est signalé.

## Ce qui a été vérifié (répétition locale, Docker 29 / Compose v5, PostgreSQL 16)

`./deploy.sh secrets` (aucune valeur affichée) → `./deploy.sh` : base créée, migrations 001 à 004 appliquées, rôle
`mosolo_app` créé (UPDATE/DELETE du journal refusés), application **saine**, HTTPS par Caddy (HTTP/2, redirection 308,
CSP et HSTS présents), en-tête de démonstration refusé (401) ; sauvegarde signée **CONFORME** ; redémarrage « Chaîne
d'audit conforme à l'ancre externe » ; restauration d'une sauvegarde plus ancienne **refusée** sans
`CONFIRM_ROLLBACK=1`, puis acceptée et tracée ; image défectueuse → **retour automatique** à l'image précédente (code
de sortie 1) ; mise à jour d'une base existante (migration 004 seule) ; deux instances simultanées : l'ancienne cesse
d'écrire (bail). Non vérifiés ici : `install.sh` sur un vrai Ubuntu (simulé), certificat Let's Encrypt réel (Caddy a
servi un certificat interne pour `localhost`), copie hors site.

## Simulations (`DRY_RUN=1`)

`DRY_RUN=1 ./install.sh` (conteneur Debian sans Docker, pour montrer la branche d'installation complète) :

<!-- SIMULATION:vps-install.txt -->
```text
==> Contrôles préalables
    ATTENTION : système Debian GNU/Linux 12 (bookworm) — kit validé pour Ubuntu 22.04 / 24.04 uniquement.
    Distribution debian bookworm, port SSH 22

==> Paquets de base (certificats, pare-feu, fail2ban, mises à jour automatiques, openssl, git)
    + apt-get update -q
    + apt-get install -y -q ca-certificates curl gnupg ufw fail2ban unattended-upgrades apt-listchanges openssl git

==> Docker Engine et Compose (dépôt officiel download.docker.com)
    + install -m 0755 -d /etc/apt/keyrings
    + curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    + chmod a+r /etc/apt/keyrings/docker.asc
    + écrire /etc/apt/sources.list.d/docker.list :
        deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu bookworm stable
    + apt-get update -q
    + apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    + install -m 0755 -d /etc/docker
    + écrire /etc/docker/daemon.json :
        {
          "log-driver": "json-file",
          "log-opts": { "max-size": "20m", "max-file": "5" },
          "live-restore": true
        }
    + systemctl enable --now docker

==> Pare-feu ufw : entrées refusées sauf SSH (22), HTTP (80), HTTPS (443 TCP et UDP/HTTP3)
    + ufw default deny incoming
    + ufw default allow outgoing
    + ufw allow 22/tcp
    + ufw allow 80/tcp
    + ufw allow 443/tcp
    + ufw allow 443/udp
    + ufw --force enable
    Docker publie seulement 80/443 (Caddy) ; PostgreSQL et l'application ne sont jamais publiés sur l'hôte.

==> fail2ban : protection SSH (5 échecs → bannissement 1 h)
    + écrire /etc/fail2ban/jail.d/mosolo-sshd.local :
        [sshd]
        enabled = true
        port = 22
        maxretry = 5
        findtime = 10m
        bantime = 1h
    + systemctl enable --now fail2ban
    + systemctl restart fail2ban

==> Mises à jour de sécurité automatiques (unattended-upgrades ; pas de redémarrage automatique)
    + écrire /etc/apt/apt.conf.d/20auto-upgrades :
        APT::Periodic::Update-Package-Lists "1";
        APT::Periodic::Unattended-Upgrade "1";
        APT::Periodic::AutocleanInterval "7";
    + écrire /etc/apt/apt.conf.d/52mosolo-unattended :
        // KINSHASA MOSOLO : redémarrage décidé par l'exploitant (fenêtre de maintenance), jamais automatique.
        Unattended-Upgrade::Automatic-Reboot "false";
        Unattended-Upgrade::Remove-Unused-Dependencies "true";
    + systemctl enable --now unattended-upgrades

==> Mémoire d'échange (construction du frontend : ~700 Mo de tas Node, 3 Go réservés par défaut)
    15 Go de RAM : pas de mémoire d'échange ajoutée

==> Terminé
    Suite : cd infra/vps && cp .env.example .env && chmod 600 .env && ./deploy.sh secrets
    puis renseigner MOSOLO_DOMAIN (DNS A/AAAA vers ce serveur), MOSOLO_ACME_EMAIL, MOSOLO_PUBLIC_URL… et ./deploy.sh
```

`DRY_RUN=1 ./deploy.sh secrets` puis `DRY_RUN=1 SKIP_PULL=1 ./deploy.sh` (sans `.env` : lecture de `.env.example`) :

<!-- SIMULATION:vps-secrets.txt -->
```text
==> [21:59:33Z] Secrets de .env (générés localement, jamais affichés)
    + cp <dépôt>/infra/vps/.env.example <dépôt>/infra/vps/.env
    + chmod 600 <dépôt>/infra/vps/.env
    + MOSOLO_RECEIPT_SIGNING_KEY <- (valeur générée localement, non affichée)
    + MOSOLO_CLOSURE_SIGNING_KEY <- (valeur générée localement, non affichée)
    + MOSOLO_JWT_PRIVATE_KEY <- (valeur générée localement, non affichée)
    + POSTGRES_PASSWORD <- (valeur générée localement, non affichée)
    + MOSOLO_DB_APP_PASSWORD <- (valeur générée localement, non affichée)
    + MOSOLO_AUDIT_HMAC_KEY <- (valeur générée localement, non affichée)
    + MOSOLO_BACKUP_KEY <- (valeur générée localement, non affichée)
    + MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A <- (valeur générée localement, non affichée)
    + MOSOLO_PROVIDER_SECRET_BANK_A <- (valeur générée localement, non affichée)
    + MOSOLO_PROVIDER_SECRET_CARD_GATEWAY <- (valeur générée localement, non affichée)
    + MOSOLO_INTEGRITE_KEY <- (valeur générée localement, non affichée)
    + MOSOLO_PAYMENT_POINT_MASTER_KEY <- (valeur générée localement, non affichée)
    + MOSOLO_METRICS_TOKEN <- (valeur générée localement, non affichée)
    + DATABASE_URL <- postgres://<MOSOLO_DB_APP_ROLE>:***@postgres:5432/<POSTGRES_DB>
    0 secret(s) généré(s). Les secrets des prestataires sont à REMPLACER par les valeurs convenues avec eux.
    Renseigner aussi : MOSOLO_DOMAIN, MOSOLO_ACME_EMAIL, MOSOLO_PUBLIC_URL, MOSOLO_CORS_ORIGINS, MOSOLO_WEBAUTHN_*.
```

<!-- SIMULATION:vps-deploy.txt -->
```text
    (DRY_RUN) .env absent : lecture de .env.example à titre d'illustration

==> [21:59:33Z] Contrôle de .env
    (DRY_RUN) variables encore vides : DATABASE_URL MOSOLO_RECEIPT_SIGNING_KEY MOSOLO_CLOSURE_SIGNING_KEY MOSOLO_JWT_PRIVATE_KEY MOSOLO_AUDIT_HMAC_KEY MOSOLO_BACKUP_KEY MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A MOSOLO_PROVIDER_SECRET_BANK_A MOSOLO_PROVIDER_SECRET_CARD_GATEWAY POSTGRES_PASSWORD MOSOLO_DB_APP_PASSWORD

==> [21:59:33Z] Mise à jour du code source
    git pull ignoré (SKIP_PULL=1 ou dépôt absent)

==> [21:59:33Z] Construction de l'image mosolo:83edd29-20260927215933 (tas Node 3072 Mo pour le frontend)
    + docker build --pull --build-arg MOSOLO_BUILD_HEAP_MB=3072 -t mosolo:83edd29-20260927215933 -f <dépôt>/Dockerfile <dépôt>

==> [21:59:33Z] Dossiers hôte (sauvegardes, amorçage) : propriétaire uid 1000 (utilisateur node de l'image)
    + mkdir -p <dépôt>/infra/vps/sauvegardes <dépôt>/infra/vps/amorcage
    + chown 1000:1000 <dépôt>/infra/vps/sauvegardes
    + chmod 700 <dépôt>/infra/vps/sauvegardes

==> [21:59:33Z] Base de données
    + docker compose --project-directory <dépôt>/infra/vps -f <dépôt>/infra/vps/docker-compose.yml up -d --wait postgres

==> [21:59:33Z] Migrations (tâche rejouable ; rôle applicatif et droits minimaux)
    + docker compose --project-directory <dépôt>/infra/vps -f <dépôt>/infra/vps/docker-compose.yml --profile outils run --rm migration

==> [21:59:33Z] Redémarrage sur mosolo:83edd29-20260927215933 (précédente : aucune)
    + docker compose --project-directory <dépôt>/infra/vps -f <dépôt>/infra/vps/docker-compose.yml up -d --remove-orphans postgres app sauvegarde caddy

==> [21:59:33Z] Contrôle de santé
    + attente de l'état healthy du conteneur app (sonde /health, 240 s au plus)

==> [21:59:33Z] Déploiement réussi : mosolo:83edd29-20260927215933 — https://mosolo.exemple.cd
```
