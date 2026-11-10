-- Multi-tenant core. Every tenant table has RLS keyed on app.tenant_id; an unset setting
-- yields NULL and therefore matches no rows (fail-closed). NOT YET RUN AGAINST A LIVE POSTGRES.
CREATE TABLE cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  case_type_key text NOT NULL,
  case_type_version int NOT NULL,
  department text NOT NULL,
  state text NOT NULL,
  state_entered_at timestamptz NOT NULL,
  confidentiality text NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}',
  parties jsonb NOT NULL DEFAULT '[]',
  artifacts jsonb NOT NULL DEFAULT '[]',
  approvals jsonb NOT NULL DEFAULT '[]',
  actions jsonb NOT NULL DEFAULT '[]',
  assignee jsonb,
  legal_hold jsonb,
  parent_case_id uuid,
  matter_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  closed_at timestamptz
);

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  seq bigint NOT NULL,
  type text NOT NULL,
  actor_id text NOT NULL,
  actor_kind text NOT NULL,
  at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  prev_hash char(64) NOT NULL,
  hash char(64) NOT NULL,
  PRIMARY KEY (case_id, seq)
);

CREATE TABLE evidence_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  sha256 char(64) NOT NULL,
  custody jsonb NOT NULL DEFAULT '[]'
);

-- Audit rows are append-only at the database level too.
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['cases','audit_events','evidence_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
