import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/** Applies migrations/*.sql in order, once each, in a transaction. Run as the table OWNER, not cms_app. */
export async function migrate(connectionString: string, dir = join(import.meta.dirname, 'migrations')) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }
  return applied;
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) { console.error('Set MIGRATE_DATABASE_URL (owner role)'); process.exit(1); }
  migrate(url).then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'up to date'));
}
