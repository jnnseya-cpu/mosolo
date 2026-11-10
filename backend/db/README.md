# Persistance PostgreSQL, sauvegarde et restauration

Le socle fonctionne **en mémoire par défaut** (tests, démonstration). La persistance est **opt-in** : elle s'active
uniquement lorsque `DATABASE_URL` est définie et que le serveur est lancé par `npm run start:persistent -w backend`
(point d'entrée `src/persistence/server.ts`, qui charge aussi le module « socle »).

## Principe (étape transitoire)

- Chaque dépôt de l'application (`InMemoryRepository`, `InMemoryAppendOnlyRepository`, socle et modules d'extension)
  est découvert automatiquement dans le contexte et nommé par son chemin (`payments.orders`, `ledger.entries`,
  `ext.socle.idp.sessions`…). Le journal d'audit chaîné est persisté sous `core.audit`.
- Les lectures restent en mémoire ; chaque écriture (`insert`, `update`, `append`) est journalisée en base par lots
  courts (écriture différée de 25 ms, vidage garanti à l'arrêt propre du serveur).
- Deux tables (migrations versionnées dans `db/migrations`, table `schema_migrations`) :

| Table | Contenu | Écriture | Protection |
|---|---|---|---|
| `repository_snapshot` | Documents modifiables (JSONB), rang d'insertion | `UPSERT` | — |
| `append_only_journal` | Audit, grand livre, délivrances, observations, alertes, preuves… | `INSERT … ON CONFLICT DO NOTHING` | Déclencheur : `UPDATE`, `DELETE`, `TRUNCATE` refusés (migration `002_*.pg.sql`), levé **uniquement** pour un opérateur de restauration (migration `003_*.pg.sql`) ; `UPDATE, DELETE, TRUNCATE` retirés à `PUBLIC` |

- Au démarrage : migrations → chargement de l'instantané → données de démonstration semées (**en démonstration
  seulement** ; hors démonstration rien n'est semé) → **fusion** (l'instantané prévaut, les nouveautés semées sont
  conservées) → rechargement de la chaîne d'audit **et vérification** → **comparaison à l'ancre externe** → avance
  des générateurs d'identifiants au-delà des numéros restaurés → amorçage `MOSOLO_BOOTSTRAP_FILE` (hors démonstration).

## Ancre externe de la chaîne d'audit (`MOSOLO_AUDIT_ANCHOR_PATH`)

Rechargée depuis la base, la chaîne d'audit est cohérente par construction : une troncature, ou la réinjection d'une
ancienne sauvegarde signée, passerait la vérification. La tête de la chaîne **persistée** (rang, empreinte, heure,
signature HMAC dérivée de `MOSOLO_AUDIT_HMAC_KEY`) est donc écrite **hors de la base** après chaque lot d'audit, dans
le fichier `MOSOLO_AUDIT_ANCHOR_PATH` (écriture atomique, 0600 ; à placer sur un volume distinct, répliqué ou WORM), et
recopiée dans les traces à l'arrêt. Au démarrage, la chaîne persistée doit **prolonger** l'ancre (longueur ≥ rang
ancré, même empreinte à ce rang) ; sinon — ou si l'ancre est mal signée — démarrage **refusé** hors démonstration,
sauf `MOSOLO_AUDIT_ACCEPT_UNVERIFIED=true` après enquête (événement `audit.anchor.mismatch` ajouté à la chaîne).
Obligatoire avec `DATABASE_URL` hors démonstration.

## Rôles PostgreSQL (migration 003)

- Rôle de **migration** (propriétaire des tables) ; rôle **applicatif** : `SELECT, INSERT` sur `append_only_journal`,
  `SELECT, INSERT, UPDATE` sur `repository_snapshot` — `REVOKE UPDATE, DELETE, TRUNCATE ON append_only_journal FROM <role_applicatif>`.
- Rôle **`mosolo_restore`** (NOLOGIN, créé par la migration si le rôle de migration a `CREATEROLE`, sinon par
  l'administrateur) : `GRANT mosolo_restore TO <role_exploitation>`, **jamais** au rôle applicatif.
- Le drapeau `mosolo.restore_in_progress` ne suffit plus à lever le déclencheur : l'utilisateur de connexion
  (`session_user`, inchangé par `SET ROLE`) doit être membre de `mosolo_restore` (ou superutilisateur). La purge de
  restauration passe par la fonction `SECURITY DEFINER` `mosolo_restore_purge()`, dont l'exécution est retirée à `PUBLIC`.
- Sérialisation sans perte (`src/persistence/codec.ts`) : BigInt (montants), dates, Map, Set, octets.

Le schéma relationnel cible (`db/schema.sql`, PostgreSQL + PostGIS) reste la référence ; il remplacera l'instantané
JSONB dépôt par dépôt, derrière les mêmes interfaces `Repository<T>`.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Active la persistance (`postgres://utilisateur:motdepasse@hôte:5432/base`). |
| `MOSOLO_AUDIT_HMAC_KEY` | **Obligatoire en persistance** : clé stable du journal d'audit ; sans elle, démarrage refusé hors démonstration (avertissement en démonstration). Obligatoire aussi pour `db:restore` (la chaîne est vérifiée avant toute restauration). |
| `MOSOLO_AUDIT_ANCHOR_PATH` | **Obligatoire en persistance hors démonstration** : fichier de l'ancre externe de la tête du journal d'audit (voir ci-dessus) ; même chemin pour `db:restore`. |
| `MOSOLO_AUDIT_ACCEPT_UNVERIFIED` | `true` : démarrer malgré une chaîne d'audit restaurée non vérifiée ou non conforme à l'ancre (événements `audit.chain.restored_unverified` / `audit.anchor.mismatch` ajoutés à la chaîne). Sinon, démarrage refusé hors démonstration. |
| `MOSOLO_BACKUP_KEY` | Clé HMAC de signature des sauvegardes (16 caractères minimum), distincte de la clé d'audit. |
| `MOSOLO_JWT_PRIVATE_KEY` | Clé Ed25519 PKCS#8 (PEM) des jetons de session ; générée au démarrage si absente (les sessions ne survivent alors pas au redémarrage). |
| `MOSOLO_DEMO_MODE` | `true` : en-tête `x-demo-user`, codes affichés et comptes de démonstration activés (défaut : **désactivés** ; interdit avec `NODE_ENV=production`). |

## Sauvegarde, vérification, restauration

```bash
cd backend
DATABASE_URL=… MOSOLO_BACKUP_KEY=… npm run db:backup -- /chemin/sauvegarde.json
MOSOLO_BACKUP_KEY=… MOSOLO_AUDIT_HMAC_KEY=… npm run db:verify -- /chemin/sauvegarde.json
# Serveur arrêté, rôle d'exploitation (membre de mosolo_restore), double validation :
DATABASE_URL=… MOSOLO_BACKUP_KEY=… MOSOLO_AUDIT_HMAC_KEY=… MOSOLO_AUDIT_ANCHOR_PATH=… \
  npm run db:restore -- /chemin/sauvegarde.json --confirm [--operator=nom] [--confirm-rollback]
```

**Retour arrière.** Une sauvegarde qui ne prolonge pas la chaîne d'audit en place **ni** l'ancre externe (sauvegarde
plus ancienne, ou autre histoire) est un retour arrière : refusé sans `--confirm-rollback`. Dans tous les cas,
l'événement `audit.restored` (têtes en place / ancrée / restaurée, retour arrière, nombre d'enregistrements perdus,
empreinte de la sauvegarde) est chaîné à la suite de la chaîne restaurée, puis l'ancre est réécrite.

La sauvegarde est un document JSON `mosolo-sauvegarde/1` : toutes les lignes, un manifeste par dépôt (nombre,
SHA-256), l'empreinte SHA-256 du contenu et une signature HMAC-SHA256. La restauration est **refusée** si la signature,
l'empreinte, le manifeste ou (clé d'audit fournie) la chaîne d'audit ne se vérifient pas. Elle remplace tout le
contenu dans une transaction (purge par `mosolo_restore_purge()`, réservée aux opérateurs de restauration).

L'export applicatif `POST /v1/socle/exports` (R26, R27 ; MFA ; motif obligatoire ; journalisé) produit le même format
depuis l'état en cours, **sans les secrets d'authentification** (empreintes de mot de passe et de PIN, secrets TOTP,
clés des terminaux, empreintes de codes et de jetons ; liste dans le champ `redacted`). La sauvegarde intégrale passe
par `db:backup`, serveur arrêté, sous un rôle d'exploitation distinct.

## Tâche de migration, rôles et bail de l'instance active (kit de déploiement, 27/09/2026)

```bash
cd backend
# Rôle de MIGRATION (propriétaire) ; rejouable : une deuxième exécution n'applique rien.
DATABASE_URL=… [MOSOLO_DB_APP_ROLE=mosolo_app MOSOLO_DB_APP_PASSWORD=…] [MOSOLO_DB_RESTORE_ROLE=mosolo_migration] npm run db:migrate
DATABASE_URL=… npm run db:migrate -- --check     # migrations en attente, sans rien appliquer (code 3 s'il en reste)
```

- **Idempotence** : journal `schema_migrations` (un fichier appliqué ne l'est plus jamais), fichiers eux-mêmes
  rejouables (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF EXISTS`, blocs `DO` gardés, aucun type énuméré), verrou
  consultatif PostgreSQL pendant la migration (deux démarrages simultanés ne jouent jamais un fichier deux fois).
  Contrôlé par `test/deploiement.test.ts` (pg-mem ; PostgreSQL réel avec `MOSOLO_TEST_PG_URL`), qui refuse aussi toute
  future migration non rejouable.
- **Rôles** (`src/persistence/db-roles.ts`, appliqués par `db:migrate`, jamais par le serveur) : rôle applicatif
  créé s'il manque, mot de passe reposé, droits minimaux — `SELECT, INSERT` sur `append_only_journal`,
  `SELECT, INSERT, UPDATE` sur `repository_snapshot` et `instance_lease`, `SELECT` sur `schema_migrations` ;
  `UPDATE, DELETE, TRUNCATE` du journal et `DELETE, TRUNCATE` de l'instantané retirés. `MOSOLO_DB_RESTORE_ROLE`
  reçoit `mosolo_restore` (jamais le rôle applicatif). Mot de passe jamais journalisé.
- **Bail de l'instance active** (migration `004_instance_lease.sql`) : chaque démarrage du serveur incrémente la
  génération **avant** de charger l'instantané ; chaque lot d'écriture vérifie dans sa transaction (`FOR SHARE`) que sa
  génération est la dernière. Une instance supplantée (ancienne révision Cloud Run encore en service, double démarrage
  par erreur) n'écrit plus jamais : écritures refusées (503), `/health` « degraded », alerte `INSTANCE_SUPPLANTEE`.
  Les outils (`db:backup`, `db:verify`, `db:migrate`) ne prennent pas le bail ; `db:restore` le prend (le serveur en
  service cesse d'écrire avant la purge).

## Limites connues

- État non encore persisté : magasin d'idempotence, versions de brouillons, lots terrain, annuaire des utilisateurs de
  démonstration (recréé au démarrage), boîtes de réception in-app. À migrer vers des dépôts (changement de socle).
- Une seule instance écrit à la fois (bail) : pas de montée en charge horizontale tant que l'état reste en mémoire ;
  lors d'un chevauchement de révisions, le dernier lot différé de l'ancienne instance (25 ms) peut avoir été acquitté
  sans être persisté — mettre à jour en heure creuse.
- Écriture différée : une coupure brutale peut perdre les dernières 25 ms d'écritures ; la cible transactionnelle
  (écriture synchrone dans la transaction métier, outbox) viendra avec le schéma relationnel.
- Secrets TOTP stockés en clair dans `repository_snapshot` : chiffrement par le coffre de secrets (KMS/HSM) [À RACCORDER].
