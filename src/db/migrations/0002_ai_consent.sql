-- Per-tenant AI engine choice and the signed consent that permits an external in-Kingdom provider.
CREATE TABLE tenant_ai_settings (
  tenant_id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('SOVEREIGN','IN_KINGDOM_API')),
  data jsonb NOT NULL
);
-- Append-only record of consent changes and every AI call (no prompt content is stored).
CREATE TABLE ai_log (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  at text NOT NULL,
  actor_id text NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX ai_log_tenant_idx ON ai_log (tenant_id, id DESC);
CREATE TRIGGER ai_log_no_change BEFORE UPDATE OR DELETE ON ai_log FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER ai_log_no_truncate BEFORE TRUNCATE ON ai_log FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_ai_settings','ai_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant() AND app_tenant() <> '''') WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '''')', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON tenant_ai_settings TO cms_app;
    GRANT SELECT, INSERT ON ai_log TO cms_app;
    GRANT USAGE ON SEQUENCE ai_log_id_seq TO cms_app;
  END IF;
END $$;
