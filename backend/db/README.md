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
| `append_only_journal` | Audit, grand livre, délivrances, observations, alertes, preuves… | `INSERT … ON CONFLICT DO NOTHING` | Déclencheur : `UPDATE`, `DELETE`, `TRUNCATE` refusés (migration `002_*.pg.sql`) ; `REVOKE UPDATE, DELETE` recommandé pour le rôle applicatif |

- Au démarrage : migrations → chargement de l'instantané → données de démonstration semées → **fusion** (l'instantané
  prévaut, les nouveautés semées sont conservées) → rechargement de la chaîne d'audit **et vérification** → avance des
  générateurs d'identifiants au-delà des numéros restaurés.
- Sérialisation sans perte (`src/persistence/codec.ts`) : BigInt (montants), dates, Map, Set, octets.

Le schéma relationnel cible (`db/schema.sql`, PostgreSQL + PostGIS) reste la référence ; il remplacera l'instantané
JSONB dépôt par dépôt, derrière les mêmes interfaces `Repository<T>`.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Active la persistance (`postgres://utilisateur:motdepasse@hôte:5432/base`). |
| `MOSOLO_AUDIT_HMAC_KEY` | **Obligatoire en persistance** : clé stable du journal d'audit ; sans elle, démarrage refusé hors démonstration (avertissement en démonstration). Obligatoire aussi pour `db:restore` (la chaîne est vérifiée avant toute restauration). |
| `MOSOLO_AUDIT_ACCEPT_UNVERIFIED` | `true` : démarrer malgré une chaîne d'audit restaurée non vérifiée (événement `audit.chain.restored_unverified` ajouté à la chaîne). Sinon, démarrage refusé hors démonstration. |
| `MOSOLO_BACKUP_KEY` | Clé HMAC de signature des sauvegardes (16 caractères minimum), distincte de la clé d'audit. |
| `MOSOLO_JWT_PRIVATE_KEY` | Clé Ed25519 PKCS#8 (PEM) des jetons de session ; générée au démarrage si absente (les sessions ne survivent alors pas au redémarrage). |
| `MOSOLO_DEMO_MODE` | `true` : en-tête `x-demo-user`, codes affichés et comptes de démonstration activés (défaut : **désactivés** ; interdit avec `NODE_ENV=production`). |

## Sauvegarde, vérification, restauration

```bash
cd backend
DATABASE_URL=… MOSOLO_BACKUP_KEY=… npm run db:backup -- /chemin/sauvegarde.json
MOSOLO_BACKUP_KEY=… MOSOLO_AUDIT_HMAC_KEY=… npm run db:verify -- /chemin/sauvegarde.json
# Serveur arrêté, rôle d'exploitation distinct, double validation :
DATABASE_URL=… MOSOLO_BACKUP_KEY=… MOSOLO_AUDIT_HMAC_KEY=… npm run db:restore -- /chemin/sauvegarde.json --confirm
```

La sauvegarde est un document JSON `mosolo-sauvegarde/1` : toutes les lignes, un manifeste par dépôt (nombre,
SHA-256), l'empreinte SHA-256 du contenu et une signature HMAC-SHA256. La restauration est **refusée** si la signature,
l'empreinte, le manifeste ou (clé d'audit fournie) la chaîne d'audit ne se vérifient pas. Elle remplace tout le
contenu dans une transaction (le déclencheur d'ajout seul est levé pour cette seule transaction).

L'export applicatif `POST /v1/socle/exports` (R26, R27 ; MFA ; motif obligatoire ; journalisé) produit le même format
depuis l'état en cours, **sans les secrets d'authentification** (empreintes de mot de passe et de PIN, secrets TOTP,
clés des terminaux, empreintes de codes et de jetons ; liste dans le champ `redacted`). La sauvegarde intégrale passe
par `db:backup`, serveur arrêté, sous un rôle d'exploitation distinct.

## Limites connues

- État non encore persisté : magasin d'idempotence, versions de brouillons, lots terrain, annuaire des utilisateurs de
  démonstration (recréé au démarrage), boîtes de réception in-app. À migrer vers des dépôts (changement de socle).
- Écriture différée : une coupure brutale peut perdre les dernières 25 ms d'écritures ; la cible transactionnelle
  (écriture synchrone dans la transaction métier, outbox) viendra avec le schéma relationnel.
- Secrets TOTP stockés en clair dans `repository_snapshot` : chiffrement par le coffre de secrets (KMS/HSM) [À RACCORDER].
