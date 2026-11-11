-- People seen signing in, per client: gives the UI names instead of ids, a list to assign cases to, and the management chain
-- (from the identity provider's reports_to claim) the server needs for conflict-of-interest checks on assignment.
CREATE TABLE tenant_people (
  tenant_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  departments text NOT NULL,   -- comma separated
  roles text NOT NULL,
  reports_to text NOT NULL,
  last_seen text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE tenant_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_people FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_people
  USING (tenant_id = app_tenant() AND app_tenant() <> '') WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON tenant_people TO cms_app;
  END IF;
END $$;
