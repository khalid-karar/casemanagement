-- Notifications (in-app inbox, optional e-mail) and the extra per-person facts needed to send them safely.
ALTER TABLE tenant_people ADD COLUMN clearance text NOT NULL DEFAULT 'STANDARD';
ALTER TABLE tenant_people ADD COLUMN email text;
ALTER TABLE tenant_people ADD COLUMN email_optout boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_people ADD COLUMN matters text NOT NULL DEFAULT '';

-- A notification says that something happened on a case, never what is inside it: no field values, no note text.
CREATE TABLE notifications (
  tenant_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL,
  case_id text NOT NULL,
  actor_id text,
  dedupe_key text,
  created_at text NOT NULL,
  read_at text,
  emailed_at text,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user ON notifications (tenant_id, user_id, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = app_tenant() AND app_tenant() <> '') WITH CHECK (tenant_id = app_tenant() AND app_tenant() <> '');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON notifications TO cms_app;
  END IF;
END $$;
