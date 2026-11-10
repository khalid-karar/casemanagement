-- Multi-tenant core. Tenant isolation is enforced by Postgres itself (RLS), not only by app code.
-- app.tenant_id is set per transaction; if unset, current_setting returns '' and nothing matches (fail-closed).
-- tenant_id is text because platform staff use the reserved tenant 'platform' (no cases, baseline law only).
-- Timestamps are ISO-8601 text on purpose: audit hashes cover them, so they must round-trip byte for byte.

CREATE TABLE cases (
  tenant_id text NOT NULL,
  id text NOT NULL,
  case_type_key text NOT NULL,
  case_type_version int NOT NULL,
  department text NOT NULL,
  state text NOT NULL,
  confidentiality text NOT NULL,
  data jsonb NOT NULL,              -- full CaseState (fields, parties, artifacts, approvals, actions, hold)
  updated_at text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX cases_state_idx ON cases (tenant_id, state);

CREATE TABLE audit_events (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  seq bigint NOT NULL,
  type text NOT NULL,
  actor_id text NOT NULL,
  actor_kind text NOT NULL,
  at text NOT NULL,
  payload jsonb NOT NULL,
  prev_hash char(64) NOT NULL,
  hash char(64) NOT NULL,
  PRIMARY KEY (tenant_id, case_id, seq)
);

-- Audit rows can never be changed or removed, even by the application role.
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

-- Legal library. scope_tenant_id NULL = platform baseline (national law), else the owning tenant's policy.
CREATE TABLE legal_instruments (
  id text PRIMARY KEY,
  scope_tenant_id text,
  data jsonb NOT NULL
);
CREATE TABLE legal_versions (
  id text PRIMARY KEY,
  scope_tenant_id text,
  instrument_id text NOT NULL,
  status text NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE legal_bindings (id text PRIMARY KEY, scope_tenant_id text, data jsonb NOT NULL);
CREATE TABLE legal_proposals (id text PRIMARY KEY, scope_tenant_id text, version_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE legal_files (
  sha256 char(64) PRIMARY KEY, scope_tenant_id text, name text NOT NULL, bytes bytea NOT NULL, uploaded_by text NOT NULL
);
CREATE TABLE legal_log (
  id bigserial PRIMARY KEY, scope_tenant_id text, at text NOT NULL, actor_id text NOT NULL, type text NOT NULL, ref text NOT NULL
);
CREATE TRIGGER legal_log_no_update BEFORE UPDATE OR DELETE ON legal_log
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- ---- Row-level security ------------------------------------------------------------------
-- Helper: the tenant of the current transaction ('' when unset => matches nothing).
CREATE FUNCTION app_tenant() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.tenant_id', true), '') $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['cases','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant() AND app_tenant() <> '''') WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '''')', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['legal_instruments','legal_versions','legal_bindings','legal_proposals','legal_files','legal_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Instruments and bindings: everyone reads the baseline plus their own; only the owner scope writes.
-- Writing the baseline (NULL scope) requires the platform tenant.
CREATE POLICY read_scope ON legal_instruments FOR SELECT USING (scope_tenant_id IS NULL OR scope_tenant_id = app_tenant());
CREATE POLICY read_scope ON legal_bindings    FOR SELECT USING (scope_tenant_id IS NULL OR scope_tenant_id = app_tenant());
-- Versions: clients see only VERIFIED baseline text, never drafts; platform sees everything of the baseline.
CREATE POLICY read_scope ON legal_versions FOR SELECT USING (
  scope_tenant_id = app_tenant()
  OR (scope_tenant_id IS NULL AND (status = 'VERIFIED' OR app_tenant() = 'platform')));
-- AI proposals, original files and the review log: visible only to the owning scope's reviewers.
CREATE POLICY read_scope ON legal_proposals FOR SELECT USING (scope_tenant_id = app_tenant() OR (scope_tenant_id IS NULL AND app_tenant() = 'platform'));
CREATE POLICY read_scope ON legal_files     FOR SELECT USING (scope_tenant_id = app_tenant() OR (scope_tenant_id IS NULL AND app_tenant() = 'platform'));
CREATE POLICY read_scope ON legal_log       FOR SELECT USING (scope_tenant_id = app_tenant() OR (scope_tenant_id IS NULL AND app_tenant() = 'platform'));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['legal_instruments','legal_versions','legal_bindings','legal_proposals','legal_files','legal_log'] LOOP
    EXECUTE format('CREATE POLICY write_scope ON %I FOR INSERT WITH CHECK (scope_tenant_id = app_tenant() OR (scope_tenant_id IS NULL AND app_tenant() = ''platform''))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['legal_instruments','legal_versions','legal_bindings','legal_proposals','legal_files'] LOOP
    EXECUTE format('CREATE POLICY update_scope ON %I FOR UPDATE USING (scope_tenant_id = app_tenant() OR (scope_tenant_id IS NULL AND app_tenant() = ''platform'')) WITH CHECK (scope_tenant_id = app_tenant() OR (scope_tenant_id IS NULL AND app_tenant() = ''platform''))', t);
  END LOOP;
END $$;

-- The application connects as cms_app (no ownership, no BYPASSRLS). See docs/DB-SETUP.md.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON cases, legal_instruments, legal_versions, legal_bindings, legal_proposals, legal_files TO cms_app;
    GRANT SELECT, INSERT ON audit_events, legal_log TO cms_app;
    GRANT USAGE ON SEQUENCE legal_log_id_seq TO cms_app;
  END IF;
END $$;
