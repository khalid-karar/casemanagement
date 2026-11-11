-- Which tenants exist, for background jobs (audit anchoring, scheduled sync). Global, holds no case data.
CREATE TABLE tenant_registry (tenant_id text PRIMARY KEY, created_at text NOT NULL);
INSERT INTO tenant_registry (tenant_id, created_at) SELECT DISTINCT tenant_id, 'migrated' FROM cases ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT ON tenant_registry TO cms_app;
  END IF;
END $$;
