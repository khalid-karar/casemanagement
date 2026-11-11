/**
 * Key administration. Connects with DATABASE_ADMIN_URL: a role that can see every tenant (owner/superuser with BYPASSRLS).
 * Never give that URL to the running application.
 *
 *   pnpm crypto gen-master <id>     print a new master key entry (store it in your secret manager, NOT in git)
 *   pnpm crypto status              which master key wraps which tenant key, how much data is still plaintext
 *   pnpm crypto rewrap              re-wrap every tenant key under the current master (after adding a new master key)
 *   pnpm crypto rotate-dek [tenant] new data-key version (all tenants, or one); new writes use it
 *   pnpm crypto reencrypt           encrypt any plaintext case data and move cases to the newest data key
 *
 * Stored documents are append-only by design; they stay readable under the key version they were written with.
 */
import pg from 'pg';
import { DataCrypto, MasterKeys, type KeyStore, type TenantKey } from '../src/security/crypto';
import { EncryptedRepo } from '../src/security/encrypted-repo';
import type { Repo } from '../src/api/repo';

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'gen-master') {
  console.log(JSON.stringify(MasterKeys.generate(arg ?? `k${new Date().getFullYear()}`), null, 2));
  console.log('\nAdd this entry to DATA_MASTER_KEYS (keep older entries until `rewrap` has run) and set DATA_MASTER_KEY_ID to its id.');
  process.exit(0);
}
const url = process.env['DATABASE_ADMIN_URL'];
if (!url) throw new Error('Set DATABASE_ADMIN_URL');
const master = MasterKeys.fromEnv(process.env);
if (!master) throw new Error('Set DATA_MASTER_KEYS and DATA_MASTER_KEY_ID');
const db = new pg.Client({ connectionString: url });
await db.connect();

const store: KeyStore = {
  async getTenantKeys(t) { return (await db.query('SELECT version, master_key_id, wrapped, created_at FROM tenant_keys WHERE tenant_id=$1 ORDER BY version', [t])).rows.map((r) => ({ version: r.version, masterKeyId: r.master_key_id, wrapped: r.wrapped, createdAt: r.created_at }) as TenantKey); },
  async putTenantKey(t, k) { return (await db.query('INSERT INTO tenant_keys (tenant_id,version,master_key_id,wrapped,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [t, k.version, k.masterKeyId, k.wrapped, k.createdAt])).rowCount === 1; },
};
const dc = new DataCrypto(master, store);
const tenants = async () => (await db.query('SELECT DISTINCT tenant_id FROM (SELECT tenant_id FROM cases UNION SELECT tenant_id FROM tenant_keys) x ORDER BY 1')).rows.map((r) => r.tenant_id as string);

try {
  if (cmd === 'status') {
    for (const t of await tenants()) {
      const keys = await store.getTenantKeys(t);
      const plain = (await db.query("SELECT count(*)::int n FROM cases WHERE tenant_id=$1 AND data::text NOT LIKE '%enc:v1:%'", [t])).rows[0].n;
      console.log(`${t}: keys ${keys.map((k) => `v${k.version}@${k.masterKeyId}`).join(', ') || '(none yet)'}; cases with no encrypted content: ${plain}`);
    }
  } else if (cmd === 'rewrap') {
    let n = 0;
    await db.query('BEGIN');
    for (const t of await tenants()) for (const k of await store.getTenantKeys(t)) {
      if (k.masterKeyId === master.currentId) continue;
      const r = dc.rewrap(t, k);
      await db.query('UPDATE tenant_keys SET master_key_id=$3, wrapped=$4 WHERE tenant_id=$1 AND version=$2', [t, k.version, r.masterKeyId, r.wrapped]);
      n++;
    }
    await db.query('COMMIT');
    console.log(`Re-wrapped ${n} tenant key(s) under master key "${master.currentId}". Old master keys may be retired once this has run on every environment and backup you still need to restore.`);
  } else if (cmd === 'rotate-dek') {
    for (const t of arg ? [arg] : await tenants()) console.log(`${t}: now at data key v${await dc.rotateDataKey(t)}`);
  } else if (cmd === 'reencrypt') {
    const er = new EncryptedRepo({} as Repo, dc);
    let n = 0;
    for (const t of await tenants()) {
      for (const row of (await db.query('SELECT id, data FROM cases WHERE tenant_id=$1', [t])).rows) {
        const sealed = await er.seal(await er.open(row.data)); // decrypt whatever is there, re-encrypt with the newest key
        await db.query('UPDATE cases SET data=$3 WHERE tenant_id=$1 AND id=$2', [t, row.id, JSON.stringify(sealed)]);
        n++;
      }
    }
    console.log(`Re-encrypted ${n} case(s).`);
  } else console.log('Commands: gen-master <id> | status | rewrap | rotate-dek [tenant] | reencrypt');
} finally { await db.end(); }
