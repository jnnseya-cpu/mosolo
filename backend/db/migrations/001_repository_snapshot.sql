-- KINSHASA MOSOLO — migration 001 : instantané JSONB des dépôts (persistance opt-in, DATABASE_URL).
-- Étape transitoire documentée (backend/db/README.md) avant le schéma relationnel cible backend/db/schema.sql.

-- Dépôts modifiables (InMemoryRepository) : une ligne par document, remplacée à chaque mise à jour.
CREATE TABLE IF NOT EXISTS repository_snapshot (
  repo        TEXT        NOT NULL,
  id          TEXT        NOT NULL,
  -- Rang de première insertion (conserve l'ordre des documents au rechargement) ; inchangé par une mise à jour.
  seq         BIGINT      NOT NULL,
  doc         JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repo, id)
);

-- Journaux en ajout seul (audit chaîné, grand livre, délivrances, observations, alertes, preuves…) :
-- insertion seule (ON CONFLICT DO NOTHING) ; UPDATE / DELETE interdits par la migration 002 (PostgreSQL).
CREATE TABLE IF NOT EXISTS append_only_journal (
  repo         TEXT        NOT NULL,
  id           TEXT        NOT NULL,
  seq          BIGINT      NOT NULL,
  doc          JSONB       NOT NULL,
  appended_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repo, id)
);
