-- "Everything issued to this person before not_before is no longer valid." Global (subjects are unguessable identity-provider ids);
-- holds no case data. Written by sign-out (back-channel logout) and by tenant admins revoking a person's sessions.
CREATE TABLE session_revocations (
  subject text PRIMARY KEY,
  not_before bigint NOT NULL,   -- unix seconds
  created_at text NOT NULL
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    GRANT SELECT, INSERT, UPDATE ON session_revocations TO cms_app;
  END IF;
END $$;
