# KINSHASA MOSOLO — démonstration sur un VPS (Hostinger ou tout Ubuntu)

Démonstration complète (données fictives, non contractuelles) sur **un seul VPS**, pour un coût fixe et faible, à la
place de Google Cloud (décision du 05/10/2026). Aucune base de données : les données de démonstration sont en mémoire
et repartent à zéro à chaque redémarrage — comme sur Cloud Run. Le déploiement de **production** (PostgreSQL,
sauvegardes) reste celui de `../` (README du dossier parent), pour plus tard.

| Conteneur | Rôle |
|---|---|
| `app` | MOSOLO en mode démonstration (image construite depuis le `Dockerfile` du dépôt), lecture seule, sans privilège |
| `caddy` | HTTPS automatique (Let's Encrypt) ; seuls ports ouverts : 80 et 443 |

Taille conseillée : 2 vCPU, 4 à 8 Go de mémoire (la construction de l'application web en demande environ 3 Go).

## Mise en service (une fois)

Dans le panneau Hostinger : système **Ubuntu 22.04 ou 24.04**, puis se connecter en SSH (`ssh root@<adresse-IP>`).

```bash
git clone <URL du dépôt> /opt/mosolo && cd /opt/mosolo
git checkout claude/beautiful-hawking-3tw7gb          # branche de travail actuelle
sudo infra/vps/install.sh                             # Docker, pare-feu (22, 80, 443), mises à jour automatiques
cd infra/vps/demo && ./demo.sh                        # demande l'e-mail du certificat, construit, démarre
```

Sans nom de domaine, l'adresse est `https://<IP-avec-tirets>.sslip.io` (HTTPS valide, sans achat de domaine). Avec un
domaine : enregistrement DNS A vers l'IP du VPS, puis `MOSOLO_DOMAIN=demo.mondomaine.cd` dans `.env` et `./demo.sh`.

## Clés BitriPay, KODA et IA (facultatives, durables)

```bash
nano .env        # coller chaque clé après le « = », sans espace ; enregistrer (Ctrl+O, Entrée, Ctrl+X)
./demo.sh        # redémarre avec les clés ; refuse un jeu incomplet et dit lequel, sans jamais afficher de valeur
```

Par prestataire, **toutes** ses clés ou aucune : BitriPay (3), KODA (2) ; IA : une suffit. Les clés de `.env` (droits
600, jamais versionné) survivent aux redémarrages et priment sur la console « Clés et raccordements ».

## Exploitation

```bash
./demo.sh            # mise à jour : git pull, reconstruction, redémarrage, contrôle de santé
./demo.sh status     # état et adresse
./demo.sh logs       # messages de l'application (aucune clé n'y figure)
./demo.sh stop       # arrêt
```

Sans activité, rien n'est facturé en plus : le prix du VPS est fixe.
