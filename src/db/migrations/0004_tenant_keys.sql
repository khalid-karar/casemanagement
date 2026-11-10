-- Per-tenant data keys, stored WRAPPED by a master key that lives outside the database (see docs/ENCRYPTION.md).
-- Without the master key these rows are useless, so a database copy or backup alone reveals nothing.
-- Append-only for the application role: a key version is never changed or removed (rewrap on master rotation is done by the owner role).
CREATE TABLE tenant_keys (
  tenant_id text NOT NULL,
  version int NOT NULL,
  master_key_id text NOT NULL,
  wrapped text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (tenant_id, version)
);
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_keys
  USING (tenant_id = app_tenant() AND app_tenant() <> '')
  WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT ON tenant_keys TO cms_app;
  END IF;
END $$;
