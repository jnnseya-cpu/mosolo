-- =====================================================================================
-- KINSHASA MOSOLO — schéma PostgreSQL de référence (documentation du socle)
-- Le socle s'exécute avec des dépôts en mémoire (backend/src/core/repository.ts) ;
-- un adaptateur PostgreSQL implémentera les mêmes interfaces Repository<T> / AppendOnlyRepository<T>
-- sur ce schéma. Montants : NUMERIC exact + code ISO 4217 (jamais de flottant).
-- =====================================================================================

CREATE SCHEMA IF NOT EXISTS mosolo;
SET search_path = mosolo;

-- ---------- Types ----------
CREATE DOMAIN currency_code AS CHAR(3) CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN money_amount  AS NUMERIC(24, 6);

-- ---------- Fonction : interdit UPDATE / DELETE (tables en ajout seul) ----------
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % en ajout seul : % interdit', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---------- Identité ----------
CREATE TABLE app_user (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  entity        TEXT NOT NULL,
  territory     TEXT[],
  taxpayer_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_role (
  user_id     TEXT NOT NULL REFERENCES app_user(id),
  role_code   CHAR(3) NOT NULL CHECK (role_code ~ '^R[0-3][0-9]$'),
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ,
  PRIMARY KEY (user_id, role_code)
);
-- Les incompatibilités (§ 12.5) sont vérifiées par le service (shared hasIncompatibility) et par un contrôle
-- d'intégrité périodique ; une contrainte d'exclusion peut être ajoutée par paire interdite.

CREATE TABLE taxpayer (
  id                  TEXT PRIMARY KEY,
  iuc                 TEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL,
  phone               TEXT NOT NULL UNIQUE,
  email               TEXT,
  language            TEXT NOT NULL CHECK (language IN ('fr','ln','sw','kg','lua','en')),
  situation           TEXT NOT NULL,
  verification_level  TEXT NOT NULL CHECK (verification_level IN ('N0','N0A','N1','N2','N3')),
  prefs               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Objets fiscaux ----------
CREATE TABLE fiscal_object (
  id               TEXT PRIMARY KEY,
  taxpayer_id      TEXT REFERENCES taxpayer(id),
  category         TEXT NOT NULL,
  commune          TEXT NOT NULL,
  quartier         TEXT NOT NULL,
  locality_rank    SMALLINT NOT NULL CHECK (locality_rank BETWEEN 1 AND 4),
  lat              NUMERIC(9,6) NOT NULL,
  lon              NUMERIC(9,6) NOT NULL,
  attributes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL CHECK (status IN ('PROVISOIRE','VALIDE')),
  probative_status TEXT NOT NULL CHECK (probative_status IN ('DECLARE','OBSERVE','VERIFIE','CONTESTE')),
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fiscal_object_taxpayer ON fiscal_object(taxpayer_id);
CREATE INDEX fiscal_object_commune ON fiscal_object(commune);

CREATE TABLE lease (
  id               TEXT PRIMARY KEY,
  unit_object_id   TEXT NOT NULL REFERENCES fiscal_object(id),
  lessor_id        TEXT REFERENCES taxpayer(id),
  lessee_id        TEXT REFERENCES taxpayer(id),
  rent_amount      money_amount NOT NULL CHECK (rent_amount > 0),
  rent_currency    currency_code NOT NULL,
  periodicity      TEXT NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE,
  declared_by      TEXT NOT NULL,
  declared_by_role TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (lessor_id IS NOT NULL OR lessee_id IS NOT NULL),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE field_observation (          -- constats terrain : ajout seul
  id           TEXT PRIMARY KEY,
  object_id    TEXT NOT NULL REFERENCES fiscal_object(id),
  field        TEXT NOT NULL,
  value        JSONB,
  agent_id     TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  batch_id     TEXT NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER field_observation_append_only BEFORE UPDATE OR DELETE ON field_observation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE field_conflict (
  id         TEXT PRIMARY KEY,
  object_id  TEXT NOT NULL REFERENCES fiscal_object(id),
  field      TEXT NOT NULL,
  versions   JSONB NOT NULL,
  status     TEXT NOT NULL,
  opened_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device (
  id             TEXT PRIMARY KEY,
  agent_user_id  TEXT NOT NULL REFERENCES app_user(id),
  key_ref        TEXT NOT NULL,              -- référence HSM/KMS, jamais la clé en clair
  status         TEXT NOT NULL CHECK (status IN ('ACTIF','REVOQUE')),
  enrolled_at    TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);

-- ---------- Registre juridique ----------
CREATE TABLE legal_instrument (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('A_VERIFIER','EN_VIGUEUR','MODIFIE','ABROGE')),
  abrogated_on           DATE,
  abrogated_by           TEXT REFERENCES legal_instrument(id),
  official_document_hash TEXT
);

CREATE TABLE legal_rule (
  id                        TEXT PRIMARY KEY,
  code                      TEXT NOT NULL,
  version                   INTEGER NOT NULL,
  revenue_category          TEXT NOT NULL,
  label                     TEXT NOT NULL,
  articles                  TEXT[] NOT NULL,
  competent_authority       TEXT NOT NULL,
  administering_entity      TEXT NOT NULL,
  taxable_event             TEXT NOT NULL,
  liable_party              TEXT NOT NULL,
  withholding_agent         TEXT,
  base_definition           TEXT NOT NULL,
  formula                   TEXT NOT NULL,
  rate_table                JSONB NOT NULL,     -- valeurs décimales en chaînes
  currency                  currency_code NOT NULL,
  rounding                  TEXT NOT NULL,
  periodicity               TEXT NOT NULL,
  due_rule                  TEXT NOT NULL,
  exemptions                JSONB NOT NULL DEFAULT '[]'::jsonb,
  penalties                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_from            DATE NOT NULL,
  effective_to              DATE,
  beneficiary_account_alias TEXT NOT NULL,
  appeal_path               TEXT NOT NULL,
  status                    TEXT NOT NULL,
  source_verification       TEXT NOT NULL,
  supersedes_version_id     TEXT REFERENCES legal_rule(id),
  change_reason             TEXT,
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at              TIMESTAMPTZ,
  UNIQUE (code, version)
);

CREATE TABLE legal_rule_instrument (
  rule_id        TEXT NOT NULL REFERENCES legal_rule(id),
  instrument_id  TEXT NOT NULL REFERENCES legal_instrument(id),
  PRIMARY KEY (rule_id, instrument_id)
);

CREATE TABLE legal_rule_approval (         -- visas : ajout seul, quatre personnes distinctes
  rule_id  TEXT NOT NULL REFERENCES legal_rule(id),
  role     TEXT NOT NULL CHECK (role IN ('REDACTEUR','VERIFICATEUR_JURIDIQUE','VALIDATEUR_FINANCIER','AUTORITE_PUBLICATION')),
  user_id  TEXT NOT NULL REFERENCES app_user(id),
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, role),
  UNIQUE (rule_id, user_id)                -- une personne = un seul visa par règle
);
CREATE TRIGGER legal_rule_approval_append_only BEFORE UPDATE OR DELETE ON legal_rule_approval FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Obligations ----------
CREATE TABLE obligation (
  id                         TEXT PRIMARY KEY,
  taxpayer_id                TEXT NOT NULL REFERENCES taxpayer(id),
  object_id                  TEXT NOT NULL REFERENCES fiscal_object(id),
  rule_id                    TEXT NOT NULL REFERENCES legal_rule(id),
  rule_version               INTEGER NOT NULL,          -- version figée
  revenue_category           TEXT NOT NULL,
  entity                     TEXT NOT NULL,
  beneficiary_account_alias  TEXT NOT NULL,
  amount                     money_amount NOT NULL CHECK (amount >= 0),
  currency                   currency_code NOT NULL,
  status                     TEXT NOT NULL,
  due_date                   DATE NOT NULL,
  explanation                JSONB NOT NULL,           -- AC-ASS-01
  trace                      JSONB NOT NULL,
  supersedes                 TEXT REFERENCES obligation(id),
  superseded_by              TEXT REFERENCES obligation(id),
  appeal_id                  TEXT,
  created_by                 TEXT NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Une obligation n'est jamais supprimée : rectification par obligation liée (supersedes).
CREATE TRIGGER obligation_no_delete BEFORE DELETE ON obligation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Coffre des bénéficiaires ----------
CREATE TABLE beneficiary_account (
  alias            TEXT PRIMARY KEY,
  entity           TEXT NOT NULL,
  bank_name        TEXT NOT NULL,
  account_number   TEXT NOT NULL,          -- chiffré au repos (pgcrypto / KMS)
  holder_name      TEXT NOT NULL,
  currency         currency_code NOT NULL,
  version          INTEGER NOT NULL,
  effective_since  TIMESTAMPTZ NOT NULL
);

CREATE TABLE beneficiary_change_request (
  id               TEXT PRIMARY KEY,
  alias            TEXT NOT NULL REFERENCES beneficiary_account(alias),
  proposed         JSONB NOT NULL,
  reason           TEXT NOT NULL,
  requested_by     TEXT NOT NULL REFERENCES app_user(id),
  requested_at     TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('EN_ATTENTE_APPROBATION','EN_REFROIDISSEMENT','EFFECTIF')),
  cooling_ends_at  TIMESTAMPTZ,
  effective_at     TIMESTAMPTZ
);

CREATE TABLE beneficiary_change_approval (
  request_id           TEXT NOT NULL REFERENCES beneficiary_change_request(id),
  user_id              TEXT NOT NULL REFERENCES app_user(id),
  out_of_band_verified BOOLEAN NOT NULL CHECK (out_of_band_verified),
  at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
CREATE TRIGGER beneficiary_change_approval_append_only BEFORE UPDATE OR DELETE ON beneficiary_change_approval FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Paiements ----------
CREATE TABLE payment_order (
  id                  TEXT PRIMARY KEY,
  payment_reference   TEXT NOT NULL UNIQUE,
  obligation_id       TEXT NOT NULL REFERENCES obligation(id),
  taxpayer_id         TEXT NOT NULL REFERENCES taxpayer(id),
  channel             TEXT NOT NULL,
  amount              money_amount NOT NULL CHECK (amount > 0),
  currency            currency_code NOT NULL,
  indicative_amount   JSONB,               -- {amount, rate, rateDate, source}
  beneficiary_alias   TEXT NOT NULL REFERENCES beneficiary_account(alias),
  expires_at          TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL,
  provider            TEXT,
  provider_txn_id     TEXT,
  payer_amount        JSONB,
  confirmed_at        TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  reconciled_at       TIMESTAMPTZ,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_key (
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE provider_nonce (
  provider   TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, nonce)
);

CREATE TABLE provider_confirmation (       -- ajout seul ; unicité de provider_txn_id (anti-rejeu)
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  provider_txn_id    TEXT NOT NULL,
  payment_reference  TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('CONFIRME','ECHOUE','DOUBLON')),
  response           JSONB NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_txn_id)
);
CREATE TRIGGER provider_confirmation_append_only BEFORE UPDATE OR DELETE ON provider_confirmation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Quittances ----------
CREATE TABLE receipt (
  id                  TEXT PRIMARY KEY,
  number              TEXT NOT NULL UNIQUE,
  code                TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('PROVISOIRE','DEFINITIVE','ANNULEE','REMPLACEE','SUSPECTE')),
  payment_order_id    TEXT NOT NULL UNIQUE REFERENCES payment_order(id),
  obligation_id       TEXT NOT NULL REFERENCES obligation(id),
  taxpayer_id         TEXT NOT NULL REFERENCES taxpayer(id),
  amount              money_amount NOT NULL,
  currency            currency_code NOT NULL,
  payer_amount        JSONB,
  indicative_amount   JSONB,
  administration      TEXT NOT NULL,
  revenue_category    TEXT NOT NULL,
  provider_txn_id     TEXT NOT NULL,
  paid_at             TIMESTAMPTZ NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL,
  finalized_at        TIMESTAMPTZ,
  signature           TEXT NOT NULL,       -- Ed25519 (production : PKI provinciale / HSM)
  qr_payload          TEXT NOT NULL
);
CREATE TRIGGER receipt_no_delete BEFORE DELETE ON receipt FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Rapprochement et grand livre ----------
CREATE TABLE settlement_statement (
  id            TEXT PRIMARY KEY,
  fingerprint   TEXT NOT NULL,
  imported_by   TEXT NOT NULL,
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  result        JSONB NOT NULL
);

CREATE TABLE reconciliation_exception (
  id                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL,
  statement_id       TEXT REFERENCES settlement_statement(id),
  payment_reference  TEXT,
  line               JSONB,
  detail             TEXT NOT NULL,
  status             TEXT NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entry (                -- grand livre : ajout seul, chaîné
  id           TEXT PRIMARY KEY,
  seq          BIGINT NOT NULL UNIQUE,
  at           TIMESTAMPTZ NOT NULL,
  event_type   TEXT NOT NULL,
  description  TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  reversal_of  TEXT UNIQUE REFERENCES ledger_entry(id),   -- une seule contre-écriture par original
  reason       TEXT,
  prev_hash    CHAR(64) NOT NULL,
  hash         CHAR(64) NOT NULL UNIQUE
);
CREATE TABLE ledger_line (
  entry_id  TEXT NOT NULL REFERENCES ledger_entry(id),
  line_no   SMALLINT NOT NULL,
  account   TEXT NOT NULL,
  side      TEXT NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
  amount    money_amount NOT NULL CHECK (amount > 0),
  currency  currency_code NOT NULL,
  PRIMARY KEY (entry_id, line_no)
);
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON ledger_entry FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_line_append_only BEFORE UPDATE OR DELETE ON ledger_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Équilibre débit = crédit par écriture et par devise, vérifié en fin de transaction.
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_line WHERE entry_id = NEW.entry_id
    GROUP BY currency
    HAVING SUM(CASE side WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0
  ) THEN
    RAISE EXCEPTION 'Écriture % déséquilibrée', NEW.entry_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_line_balanced AFTER INSERT ON ledger_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- ---------- Réclamations ----------
CREATE TABLE appeal (
  id                          TEXT PRIMARY KEY,
  obligation_id               TEXT NOT NULL REFERENCES obligation(id),
  taxpayer_id                 TEXT NOT NULL REFERENCES taxpayer(id),
  grounds                     TEXT NOT NULL,
  requested_amount            JSONB,
  status                      TEXT NOT NULL,
  submitted_by                TEXT NOT NULL,
  submitted_at                TIMESTAMPTZ NOT NULL,
  instructor_id               TEXT REFERENCES app_user(id),
  proposal                    JSONB,
  decision                    JSONB,
  decided_by                  TEXT REFERENCES app_user(id),
  rectifying_obligation_id    TEXT REFERENCES obligation(id),
  CHECK (decided_by IS NULL OR instructor_id IS NULL OR decided_by <> instructor_id)   -- décideur ≠ instructeur
);

-- ---------- Communications ----------
CREATE TABLE delivery (                    -- journal de délivrance : ajout seul (preuve de notification)
  id               TEXT PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL,
  event_code       TEXT NOT NULL,
  category         TEXT NOT NULL,
  channel          TEXT NOT NULL,
  recipient_id     TEXT NOT NULL,
  recipient_kind   TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('en_file','envoye','delivre','lu','echoue','journalise','supprime_par_preference')),
  provider         TEXT NOT NULL,
  mandatory        BOOLEAN NOT NULL,
  entity           TEXT NOT NULL,
  lang             TEXT NOT NULL,
  attempts         SMALLINT NOT NULL,
  content_hash     CHAR(64) NOT NULL,
  CHECK (NOT (mandatory AND channel = 'whatsapp'))                                 -- jamais d'avis obligatoire sur WhatsApp
);
CREATE TRIGGER delivery_append_only BEFORE UPDATE OR DELETE ON delivery FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Brouillons (autosave) ----------
CREATE TABLE draft_version (
  owner_id        TEXT NOT NULL,
  key             TEXT NOT NULL,
  version         INTEGER NOT NULL,
  saved_at        TIMESTAMPTZ NOT NULL,
  data            JSONB NOT NULL,
  changes         JSONB NOT NULL,
  change_summary  TEXT NOT NULL,
  content_hash    CHAR(64) NOT NULL,
  PRIMARY KEY (owner_id, key, version)
);
CREATE TRIGGER draft_version_append_only BEFORE UPDATE OR DELETE ON draft_version FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Intelligence ----------
CREATE TABLE ai_recommendation (
  id                TEXT PRIMARY KEY,
  context           TEXT NOT NULL,
  agent             TEXT NOT NULL,
  model_version     TEXT NOT NULL,
  autonomy          TEXT NOT NULL CHECK (autonomy IN ('A_AUTO','B_VALIDATION','C_RECOMMANDATION')),
  output            JSONB NOT NULL,          -- 8 rubriques + bloc de décision
  status            TEXT NOT NULL CHECK (status IN ('EMISE','ACCEPTEE','MODIFIEE','REJETEE')),
  decided_by        TEXT REFERENCES app_user(id),
  decided_at        TIMESTAMPTZ,
  decision_reason   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Alertes de sécurité ----------
CREATE TABLE security_alert (
  id        TEXT PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL,
  type      TEXT NOT NULL,
  severity  TEXT NOT NULL,
  source    TEXT NOT NULL,
  detail    TEXT NOT NULL,
  context   JSONB NOT NULL
);
CREATE TRIGGER security_alert_append_only BEFORE UPDATE OR DELETE ON security_alert FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Journal d'audit chaîné (ajout seul) ----------
CREATE TABLE audit_event (
  seq            BIGINT PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,
  at             TIMESTAMPTZ NOT NULL,
  actor          JSONB NOT NULL,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','FAILURE')),
  details        JSONB NOT NULL,
  prev_hash      CHAR(64) NOT NULL,
  hash           CHAR(64) NOT NULL UNIQUE,   -- sha256(prev_hash || JSON canonique)
  signature      CHAR(64) NOT NULL           -- HMAC-SHA256(hash) — clé en HSM
);
CREATE INDEX audit_event_action ON audit_event(action);
CREATE INDEX audit_event_resource ON audit_event(resource_id);
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Ancrage de la tête de chaîne (horodatage tiers / WORM hors du contrôle des administrateurs).
CREATE TABLE audit_anchor (
  anchored_at  TIMESTAMPTZ PRIMARY KEY,
  head_seq     BIGINT NOT NULL,
  head_hash    CHAR(64) NOT NULL,
  tsa_token    TEXT
);
CREATE TRIGGER audit_anchor_append_only BEFORE UPDATE OR DELETE ON audit_anchor FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rôle applicatif : aucun droit UPDATE/DELETE sur les tables en ajout seul.
-- REVOKE UPDATE, DELETE, TRUNCATE ON audit_event, ledger_entry, ledger_line, delivery, provider_confirmation FROM mosolo_app;
