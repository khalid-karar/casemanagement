-- Report & Track: anonymous reports that sit before the case, and the channels (QR codes) they arrive through.
--
-- Two tables, two different trust problems.
--
-- report_channels is looked up by an unauthenticated caller who knows only a token printed on a poster, so there is no
-- tenant yet. The ONLY thing a request with no tenant may do is read the single row whose token it presents
-- (app.channel_token), so it cannot list channels, learn that other tenants exist, or touch anything else.
--
-- reports holds sensitive free text and is plain tenant isolation. Its history is append-only in the database itself, so
-- the hash chain kept inside each row cannot be quietly rewritten by anything with UPDATE on the table.

CREATE TABLE report_channels (
  tenant_id text NOT NULL,
  id text NOT NULL,
  token text NOT NULL UNIQUE,
  label jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at text NOT NULL,
  created_by text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE report_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_channels
  USING (tenant_id = app_tenant() AND app_tenant() <> '') WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '');
CREATE POLICY token_lookup ON report_channels FOR SELECT
  USING (token = nullif(current_setting('app.channel_token', true), ''));

CREATE TABLE reports (
  tenant_id text NOT NULL,
  id text NOT NULL,
  channel_id text NOT NULL,
  -- SHA-256 of the reference code. The code is the reporter's only credential and is never stored.
  code_hash text NOT NULL,
  -- The columns below are what the staff inbox sorts and filters on, so listing never has to read or decrypt a message.
  status text NOT NULL,
  category text NOT NULL,
  language text NOT NULL,
  message_count integer NOT NULL,
  awaiting_staff boolean NOT NULL,
  case_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX reports_code ON reports (tenant_id, code_hash);
CREATE INDEX reports_inbox ON reports (tenant_id, status, updated_at DESC);
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reports
  USING (tenant_id = app_tenant() AND app_tenant() <> '') WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '');

-- A report's history only ever grows. Message text is re-encrypted on each save (new nonce, new ciphertext), so the
-- check is on the history, which holds digests and never ciphertext, and on the fields that define whose report it is.
CREATE FUNCTION reports_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; i int;
BEGIN
  -- Identity lives in columns (for lookup) and in the JSON (for the application); both must stay as they were.
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.code_hash <> OLD.code_hash OR NEW.created_at <> OLD.created_at OR NEW.channel_id <> OLD.channel_id
     OR NEW.data->>'codeHash' IS DISTINCT FROM OLD.data->>'codeHash' OR NEW.data->>'createdAt' IS DISTINCT FROM OLD.data->>'createdAt'
     OR NEW.data->>'channelId' IS DISTINCT FROM OLD.data->>'channelId' OR NEW.data->>'id' IS DISTINCT FROM OLD.data->>'id' THEN
    RAISE EXCEPTION 'report identity is immutable';
  END IF;
  n := jsonb_array_length(OLD.data->'events');
  IF jsonb_array_length(NEW.data->'events') < n THEN
    RAISE EXCEPTION 'report history is append-only';
  END IF;
  FOR i IN 0..n-1 LOOP
    IF (OLD.data->'events'->i) IS DISTINCT FROM (NEW.data->'events'->i) THEN
      RAISE EXCEPTION 'report history is append-only';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER reports_append_only BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION reports_history_append_only();
-- Nothing deletes a report. The application role is not granted DELETE; this stops a future grant from doing it silently.
CREATE FUNCTION reports_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'reports cannot be deleted'; END $$;
CREATE TRIGGER reports_no_delete BEFORE DELETE ON reports FOR EACH ROW EXECUTE FUNCTION reports_no_delete();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON report_channels TO cms_app;
    GRANT SELECT, INSERT, UPDATE ON reports TO cms_app;
  END IF;
END $$;
