-- KINSHASA MOSOLO — migration 003 (PostgreSQL uniquement) : fin du contournement du journal en ajout seul par
-- n'importe quelle session. Jusqu'ici, `set_config('mosolo.restore_in_progress', 'on', true)` suffisait à lever le
-- déclencheur : toute connexion applicative pouvait réécrire ou vider le journal.
--
-- Désormais :
--   1. le déclencheur ne s'efface QUE pour une session dont l'utilisateur de CONNEXION (session_user, inchangé par
--      SET ROLE) est membre du rôle `mosolo_restore` (ou superutilisateur), ET dans une restauration en cours ;
--   2. la purge de restauration passe par la fonction SECURITY DEFINER `mosolo_restore_purge()`, exécutable
--      seulement par `mosolo_restore` (EXECUTE retiré à PUBLIC) ;
--   3. UPDATE, DELETE, TRUNCATE sont retirés à PUBLIC sur le journal.
--
-- Exploitation (voir backend/db/README.md) : la base appartient à un rôle de MIGRATION ; le rôle APPLICATIF ne reçoit
-- que SELECT, INSERT sur append_only_journal et SELECT, INSERT, UPDATE sur repository_snapshot :
--   REVOKE UPDATE, DELETE, TRUNCATE ON append_only_journal FROM <role_applicatif>;
--   GRANT mosolo_restore TO <role_exploitation>;   -- JAMAIS au rôle applicatif
-- Si le rôle de migration ne peut pas créer de rôle (CREATEROLE absent), `mosolo_restore` doit être créé par l'administrateur
-- de la base ; en son absence, seul un superutilisateur peut restaurer.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mosolo_restore') THEN
    BEGIN
      CREATE ROLE mosolo_restore NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Rôle mosolo_restore non créé (privilège CREATEROLE absent) : à créer par l’administrateur de la base.';
    END;
  END IF;
END;
$$;

-- Opérateur de restauration : utilisateur de connexion superutilisateur ou membre de mosolo_restore.
CREATE OR REPLACE FUNCTION mosolo_is_restore_operator() RETURNS boolean LANGUAGE plpgsql STABLE
SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper) THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mosolo_restore') THEN
    RETURN pg_has_role(session_user, 'mosolo_restore', 'MEMBER');
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION mosolo_forbid_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Le drapeau seul ne suffit plus : il doit être posé par un opérateur de restauration (session_user).
  IF current_setting('mosolo.restore_in_progress', true) = 'on' AND mosolo_is_restore_operator() THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  RAISE EXCEPTION 'Journal en ajout seul : % interdit sur %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Purge transactionnelle avant réinsertion d'une sauvegarde vérifiée (appelée par `npm run db:restore`).
CREATE OR REPLACE FUNCTION mosolo_restore_purge() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT mosolo_is_restore_operator() THEN
    RAISE EXCEPTION 'Restauration réservée au rôle mosolo_restore (utilisateur de connexion %)', session_user USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('mosolo.restore_in_progress', 'on', true);
  DELETE FROM repository_snapshot;
  DELETE FROM append_only_journal;
  PERFORM set_config('mosolo.restore_in_progress', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION mosolo_restore_purge() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mosolo_restore') THEN
    GRANT EXECUTE ON FUNCTION mosolo_restore_purge() TO mosolo_restore;
  END IF;
END;
$$;

REVOKE UPDATE, DELETE, TRUNCATE ON append_only_journal FROM PUBLIC;
