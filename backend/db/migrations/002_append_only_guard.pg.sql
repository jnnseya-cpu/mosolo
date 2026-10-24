-- KINSHASA MOSOLO — migration 002 (PostgreSQL uniquement) : le journal en ajout seul refuse UPDATE et DELETE.
-- Complément d'exploitation : l'utilisateur applicatif ne reçoit que SELECT, INSERT sur append_only_journal.
--   REVOKE UPDATE, DELETE, TRUNCATE ON append_only_journal FROM <role_applicatif>;
-- La restauration d'une sauvegarde (npm run db:restore -w backend) s'exécute avec un rôle d'exploitation distinct,
-- en double validation, et désactive ce déclencheur le temps de la transaction (voir backend/db/README.md).

CREATE OR REPLACE FUNCTION mosolo_forbid_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('mosolo.restore_in_progress', true) = 'on' THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  RAISE EXCEPTION 'Journal en ajout seul : % interdit sur %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS append_only_journal_no_update ON append_only_journal;
CREATE TRIGGER append_only_journal_no_update
  BEFORE UPDATE OR DELETE ON append_only_journal
  FOR EACH ROW EXECUTE FUNCTION mosolo_forbid_journal_mutation();

DROP TRIGGER IF EXISTS append_only_journal_no_truncate ON append_only_journal;
CREATE TRIGGER append_only_journal_no_truncate
  BEFORE TRUNCATE ON append_only_journal
  FOR EACH STATEMENT EXECUTE FUNCTION mosolo_forbid_journal_mutation();
