-- Case documents: the bytes behind an artifact (a filing, an exhibit, evidence). Content-addressed per case:
-- the primary key includes the SHA-256, so a stored document can never be swapped for different bytes, and the
-- artifact's `hash` is the proof of what was stored. Append-only: no update, no delete, even for the app role.
-- Tenant isolation is row-level security, exactly as for cases. (Encryption of the bytes is a separate open item:
-- see docs/handoff/KNOWN-GAPS.md S8.)
CREATE TABLE case_documents (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  sha256 char(64) NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  bytes bytea NOT NULL,
  uploaded_by text NOT NULL,
  uploaded_at text NOT NULL,
  PRIMARY KEY (tenant_id, case_id, sha256)
);

CREATE TRIGGER case_documents_no_change BEFORE UPDATE OR DELETE ON case_documents
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER case_documents_no_truncate BEFORE TRUNCATE ON case_documents
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

ALTER TABLE case_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON case_documents
  USING (tenant_id = app_tenant() AND app_tenant() <> '')
  WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT ON case_documents TO cms_app;
  END IF;
END $$;
