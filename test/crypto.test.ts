import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import type { Repo } from '../src/api/repo';
import { CryptoError, DataCrypto, MasterKeys } from '../src/security/crypto';
import { EncryptedRepo } from '../src/security/encrypted-repo';
import { ADMIN, PG_ENABLED, freshDatabase, newRepo, resetData } from './helpers/pg';

const T1 = 'tenant-a', T2 = 'tenant-b';
const clock = () => '2026-11-10T08:00:00.000Z';
const mkMaster = (id = 'k1') => new MasterKeys(id, Object.fromEntries(Object.entries(MasterKeys.generate(id)).map(([k, v]) => [k, Buffer.from(v, 'base64')])));
const provider = { model: 't', complete: async () => 'x' };

function appOver(repo: Repo) {
  const d = new Directory();
  d.add({ id: 'mgr', name: 'mgr', kind: 'human', tenantId: T1, departments: ['HR'], roles: ['hr_intake', 'hr_manager', 'ethics_officer'], reportsTo: [], clearance: 'RESTRICTED' });
  d.add({ id: 'mgr-b', name: 'mgr-b', kind: 'human', tenantId: T2, departments: ['HR'], roles: ['hr_intake', 'hr_manager', 'ethics_officer'], reportsTo: [], clearance: 'RESTRICTED' });
  return createApp({ repo, directory: d, provider, clock });
}
const call = (app: ReturnType<typeof appOver>, who: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

const SECRET = 'Reporter-Name-Fatima-Al-Qahtani';

describe('DataCrypto', () => {
  it('round-trips values and bytes, and different encryptions of one value differ', async () => {
    const inner = new MemoryRepo(); const dc = new DataCrypto(mkMaster(), inner);
    const a = await dc.encryptValue(T1, 'x', { n: 1 }); const b = await dc.encryptValue(T1, 'x', { n: 1 });
    expect(a).not.toBe(b);
    expect(await dc.decryptValue(T1, 'x', a)).toEqual({ n: 1 });
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(await dc.decryptBytes(T1, 'd', await dc.encryptBytes(T1, 'd', bytes))).toEqual(bytes);
  });
  it('binds ciphertext to tenant and context: a moved value fails instead of appearing elsewhere', async () => {
    const dc = new DataCrypto(mkMaster(), new MemoryRepo());
    const c = await dc.encryptValue(T1, 'field|c1|a', 'secret');
    await expect(dc.decryptValue(T1, 'field|c1|b', c)).rejects.toBeInstanceOf(CryptoError);
    await expect(dc.decryptValue(T2, 'field|c1|a', c)).rejects.toBeInstanceOf(CryptoError);
    const tampered = c.slice(0, -3) + (c.endsWith('AAA') ? 'BBB' : 'AAA');
    await expect(dc.decryptValue(T1, 'field|c1|a', tampered)).rejects.toBeInstanceOf(CryptoError);
  });
  it('each tenant has its own data key', async () => {
    const store = new MemoryRepo(); const dc = new DataCrypto(mkMaster(), store);
    await dc.encryptValue(T1, 'x', 1); await dc.encryptValue(T2, 'x', 1);
    expect((await store.getTenantKeys(T1))[0]!.wrapped).not.toBe((await store.getTenantKeys(T2))[0]!.wrapped);
  });
  it('concurrent first use creates exactly one key (race-safe)', async () => {
    const store = new MemoryRepo();
    const make = () => new DataCrypto(mkMaster('k1'), store); // two processes sharing a store, same master
    const m = mkMaster('k1');
    const d1 = new DataCrypto(m, store), d2 = new DataCrypto(m, store);
    void make;
    const [c1, c2] = await Promise.all([d1.encryptValue(T1, 'x', 'a'), d2.encryptValue(T1, 'x', 'b')]);
    expect((await store.getTenantKeys(T1))).toHaveLength(1);
    expect(await d2.decryptValue(T1, 'x', c1)).toBe('a');
    expect(await d1.decryptValue(T1, 'x', c2)).toBe('b');
  });
  it('fails closed with the wrong or missing master key', async () => {
    const store = new MemoryRepo();
    const dc = new DataCrypto(mkMaster('k1'), store);
    const c = await dc.encryptValue(T1, 'x', 'secret');
    const other = new DataCrypto(mkMaster('k1'), store); // different key material under the same id
    await expect(other.decryptValue(T1, 'x', c)).rejects.toBeInstanceOf(CryptoError);
    const renamed = new DataCrypto(mkMaster('k9'), store);
    await expect(renamed.decryptValue(T1, 'x', c)).rejects.toBeInstanceOf(CryptoError);
  });
  it('master rotation: rewrapped keys read old data under the new master, old master no longer needed', async () => {
    const store = new MemoryRepo();
    const raw = { ...MasterKeys.generate('k1') };
    const k1 = new MasterKeys('k1', { k1: Buffer.from(raw['k1']!, 'base64') });
    const d1 = new DataCrypto(k1, store);
    const c = await d1.encryptValue(T1, 'x', 'secret');
    const both = new MasterKeys('k2', { k1: Buffer.from(raw['k1']!, 'base64'), k2: Buffer.from(MasterKeys.generate('k2')['k2']!, 'base64') });
    const d2 = new DataCrypto(both, store);
    const row = (await store.getTenantKeys(T1))[0]!;
    const re = d2.rewrap(T1, row);
    expect(re.masterKeyId).toBe('k2'); expect(re.wrapped).not.toBe(row.wrapped);
    const onlyNew = new MasterKeys('k2', { k2: both.get('k2') });
    const store2 = new MemoryRepo(); await store2.putTenantKey(T1, re);
    expect(await new DataCrypto(onlyNew, store2).decryptValue(T1, 'x', c)).toBe('secret');
  });
  it('data-key rotation: new writes use the new version, old ciphertext stays readable', async () => {
    const store = new MemoryRepo(); const dc = new DataCrypto(mkMaster(), store);
    const old = await dc.encryptValue(T1, 'x', 'old');
    expect(await dc.rotateDataKey(T1)).toBe(2);
    const fresh = await dc.encryptValue(T1, 'x', 'new');
    expect(old.startsWith('enc:v1:1:')).toBe(true); expect(fresh.startsWith('enc:v1:2:')).toBe(true);
    expect(await dc.decryptValue(T1, 'x', old)).toBe('old'); expect(await dc.decryptValue(T1, 'x', fresh)).toBe('new');
  });
});

describe('EncryptedRepo through the API', () => {
  let inner: MemoryRepo; let app: ReturnType<typeof appOver>;
  beforeEach(() => { inner = new MemoryRepo(); app = appOver(new EncryptedRepo(inner, new DataCrypto(mkMaster(), inner))); });

  async function makeCase() {
    const r = await call(app, 'mgr', 'POST', '/cases', { caseType: 'hr.misconduct', fields: { allegationSummary: 'Late approvals', severity: 'HIGH', reporterIdentity: SECRET, subjectEmployee: 'emp-77' } });
    expect(r.status).toBe(201);
    return ((await r.json()) as any).id as string;
  }

  it('stores sensitive fields and parties encrypted but serves them back normally', async () => {
    const id = await makeCase();
    const stored = JSON.stringify(await inner.tx(T1, (tx) => tx.getCase(id)));
    expect(stored).not.toContain(SECRET); expect(stored).not.toContain('emp-77');
    expect(stored).toContain('Late approvals'); // NORMAL fields stay readable for filtering
    const got = (await (await call(app, 'mgr', 'GET', `/cases/${id}`)).json()) as any;
    expect(JSON.stringify(got)).toContain(SECRET);
  });

  it('encrypts uploaded documents at rest and returns the original bytes', async () => {
    const id = await makeCase();
    const marker = 'CONFIDENTIAL-EVIDENCE-TEXT-12345';
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${marker}\n%%EOF`));
    const fd = new FormData(); fd.set('file', new File([bytes], 'e.pdf')); fd.set('type', 'findings_report');
    const up = await app.request(`/cases/${id}/documents`, { method: 'POST', headers: { authorization: 'Bearer dev:mgr' }, body: fd });
    expect(up.status).toBe(201);
    const body = (await up.json()) as any;
    const raw = await inner.getCaseDocument(T1, id, body.sha256);
    expect(Buffer.from(raw!.bytes).toString('latin1')).not.toContain(marker);
    expect(JSON.stringify(await inner.tx(T1, (tx) => tx.getCase(id)))).not.toContain('e.pdf'); // artifact payload sealed too
    const dl = await app.request(`/cases/${id}/documents/${body.sha256}`, { headers: { authorization: 'Bearer dev:mgr' } });
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toContain(marker);
  });

  it('data written before encryption was switched on is still readable and gets encrypted on next save', async () => {
    const plain = appOver(inner);
    const r = await call(plain, 'mgr', 'POST', '/cases', { caseType: 'hr.misconduct', fields: { allegationSummary: 'old', severity: 'LOW', reporterIdentity: SECRET } });
    const id = ((await r.json()) as any).id as string;
    expect(JSON.stringify(await inner.tx(T1, (tx) => tx.getCase(id)))).toContain(SECRET);
    expect(JSON.stringify(await (await call(app, 'mgr', 'GET', `/cases/${id}`)).json())).toContain(SECRET);
    const tr = await call(app, 'mgr', 'POST', `/cases/${id}/transitions/triage`);
    expect(tr.status).toBe(200);
    expect(JSON.stringify(await inner.tx(T1, (tx) => tx.getCase(id)))).not.toContain(SECRET);
  });

  it('a different master key cannot read the data (fails closed, no partial output)', async () => {
    const id = await makeCase();
    const wrong = appOver(new EncryptedRepo(inner, new DataCrypto(mkMaster(), inner)));
    const r = await call(wrong, 'mgr', 'GET', `/cases/${id}`);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await r.text()).not.toContain(SECRET);
  });
});

describe.skipIf(!PG_ENABLED)('EncryptedRepo on Postgres', () => {
  beforeAll(freshDatabase);
  beforeEach(resetData);

  it('raw rows hold no plaintext for sensitive fields, parties or documents, and tenant_keys is tenant-isolated', async () => {
    const pgRepo = await newRepo();
    const app = appOver(new EncryptedRepo(pgRepo, new DataCrypto(mkMaster(), pgRepo)));
    const r = await call(app, 'mgr', 'POST', '/cases', { caseType: 'hr.misconduct', fields: { allegationSummary: 'Late approvals', severity: 'HIGH', reporterIdentity: SECRET, subjectEmployee: 'emp-77' } });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as any).id as string;
    const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
    try {
      const raw = JSON.stringify((await admin.query('SELECT * FROM cases')).rows);
      expect(raw).not.toContain(SECRET); expect(raw).not.toContain('emp-77'); expect(raw).toContain('enc:v1:');
      const audit = JSON.stringify((await admin.query('SELECT * FROM audit_events')).rows);
      expect(audit).not.toContain(SECRET);
      expect((await admin.query('SELECT count(*)::int n FROM tenant_keys WHERE tenant_id = $1', [T1])).rows[0].n).toBe(1);
      expect(JSON.stringify((await admin.query('SELECT * FROM tenant_keys')).rows)).not.toMatch(/[A-Za-z0-9+/]{43}=/); // wrapped, not a raw 32-byte key
    } finally { await admin.end(); }
    expect(JSON.stringify(await (await call(app, 'mgr', 'GET', `/cases/${id}`)).json())).toContain(SECRET);
    // tenant B cannot see tenant A's keys
    expect(await pgRepo.getTenantKeys(T2)).toEqual([]);
  });
});
