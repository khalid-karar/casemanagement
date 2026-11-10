-- Department, clearance and privilege walls enforced by the database, not only by application code.
-- Mirrors canAccess() in src/engine/permissions.ts. The application sets, per transaction:
--   app.scope       'actor' (a signed-in person: walls apply) or 'full' (trusted internal job: tenant isolation only)
--   app.departments, app.roles, app.matters   comma-separated lists
--   app.kind        human | ai | external | system
--   app.clearance   0 STANDARD, 1 RESTRICTED, 2 PRIVILEGED
-- With no scope set, nothing is visible (fail closed). Tenant isolation from 0001 still applies on top.

CREATE FUNCTION app_scope() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.scope', true), '') $$;
CREATE FUNCTION app_list(name text) RETURNS text[] LANGUAGE sql STABLE AS
  $$ SELECT string_to_array(coalesce(nullif(current_setting(name, true), ''), ''), ',') $$;
CREATE FUNCTION app_kind() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.kind', true), '') $$;
CREATE FUNCTION app_clearance() RETURNS int LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.clearance', true), '')::int, -1) $$;
CREATE FUNCTION conf_rank(c text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE c WHEN 'STANDARD' THEN 0 WHEN 'RESTRICTED' THEN 1 WHEN 'PRIVILEGED' THEN 2 ELSE 99 END $$;

-- Can the current actor read / write a case with these attributes?
CREATE FUNCTION app_case_visible(dept text, conf text, matter text, for_write boolean) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN app_scope() = 'full' THEN true
    WHEN app_scope() <> 'actor' THEN false
    WHEN app_kind() = 'ai' AND for_write THEN false
    WHEN app_kind() = 'external' THEN matter IS NOT NULL AND matter = ANY (app_list('app.matters'))
    ELSE
      (dept = ANY (app_list('app.departments'))
        OR (NOT for_write AND 'audit_assurance' = ANY (app_list('app.roles')) AND conf <> 'PRIVILEGED'))
      AND conf_rank(conf) <= app_clearance()
      AND (conf <> 'PRIVILEGED' OR 'LEGAL' = ANY (app_list('app.departments')))
  END
$$;

DROP POLICY tenant_isolation ON cases;
CREATE POLICY tenant_select ON cases FOR SELECT
  USING (tenant_id = app_tenant() AND app_tenant() <> '' AND app_case_visible(department, confidentiality, data->>'matterId', false));
CREATE POLICY tenant_insert ON cases FOR INSERT
  WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '' AND app_case_visible(department, confidentiality, data->>'matterId', true));
CREATE POLICY tenant_update ON cases FOR UPDATE
  USING (tenant_id = app_tenant() AND app_tenant() <> '' AND app_case_visible(department, confidentiality, data->>'matterId', true))
  WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '' AND app_case_visible(department, confidentiality, data->>'matterId', true));

-- Audit events and documents are visible exactly when their case is (the subquery is itself subject to the cases policy).
DROP POLICY tenant_isolation ON audit_events;
CREATE POLICY tenant_select ON audit_events FOR SELECT
  USING (tenant_id = app_tenant() AND app_tenant() <> '' AND EXISTS (SELECT 1 FROM cases c WHERE c.tenant_id = audit_events.tenant_id AND c.id = audit_events.case_id));
CREATE POLICY tenant_insert ON audit_events FOR INSERT
  WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '' AND EXISTS (SELECT 1 FROM cases c WHERE c.tenant_id = audit_events.tenant_id AND c.id = audit_events.case_id));

DROP POLICY tenant_isolation ON case_documents;
CREATE POLICY tenant_select ON case_documents FOR SELECT
  USING (tenant_id = app_tenant() AND app_tenant() <> '' AND EXISTS (SELECT 1 FROM cases c WHERE c.tenant_id = case_documents.tenant_id AND c.id = case_documents.case_id));
CREATE POLICY tenant_insert ON case_documents FOR INSERT
  WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '' AND EXISTS (SELECT 1 FROM cases c WHERE c.tenant_id = case_documents.tenant_id AND c.id = case_documents.case_id));
