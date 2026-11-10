import pg from 'pg';
import { migrate } from '../../src/db/migrate';
import { PgRepo } from '../../src/api/pg-repo';

export const ADMIN = process.env.TEST_ADMIN_URL; // superuser/owner, used only to build and reset the test database
export const APP = process.env.TEST_APP_URL; // cms_app (no bypass rls)
export const PG_ENABLED = Boolean(ADMIN && APP);

export async function freshDatabase() {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;');
  await c.end();
  await migrate(ADMIN!);
}

export async function resetData() {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query('ALTER TABLE audit_events DISABLE TRIGGER audit_no_truncate');
  await c.query('ALTER TABLE ai_log DISABLE TRIGGER ai_log_no_truncate');
  await c.query('TRUNCATE cases, audit_events, legal_instruments, legal_versions, legal_bindings, legal_proposals, legal_files, legal_log, tenant_ai_settings, ai_log');
  await c.query('ALTER TABLE audit_events ENABLE TRIGGER audit_no_truncate');
  await c.query('ALTER TABLE ai_log ENABLE TRIGGER ai_log_no_truncate');
  await c.end();
}
export const newRepo = () => PgRepo.connect(APP!);
