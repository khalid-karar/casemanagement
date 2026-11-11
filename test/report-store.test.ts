import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createReport, reporterReply, verifyReport } from '../src/engine';
import type { Report } from '../src/engine';
import { MemoryRepo } from '../src/api/repo';
import type { Repo, ReportChannel } from '../src/api/repo';
import { PgRepo } from '../src/api/pg-repo';
import { DataCrypto, MasterKeys } from '../src/security/crypto';
import { EncryptedRepo } from '../src/security/encrypted-repo';
import { generateReportCode, hashReportCode } from '../src/security/reportcode';
import { APP, PG_ENABLED, freshDatabase, newRepo, resetData } from './helpers/pg';

const A = 'tenant-a';
const B = 'tenant-b';
const t0 = '2026-11-11T08:00:00.000Z';
const t1 = '2026-11-11T09:00:00.000Z';
const TOKEN_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const channel = (tenantId: string, token: string, id = `ch-${tenantId}`): ReportChannel =>
  ({ id, tenantId, token, label: { ar: 'موقع الشمال', en: 'North site' }, active: true, createdAt: t0, createdBy: 'u-admin' });
const mk = (tenantId = A, id = 'rpt-1', text = 'My supervisor is falsifying timesheets.', code = generateReportCode()): Report =>
  createReport({ id, tenantId, channelId: `ch-${tenantId}`, category: 'HR', language: 'ar', text, codeHash: hashReportCode(code) }, t0);
const mkMaster = () => new MasterKeys('k1', Object.fromEntries(Object.entries(MasterKeys.generate('k1')).map(([k, v]) => [k, Buffer.from(v, 'base64')])));

/** The contract every Repo implementation must meet, so the in-memory repo used by the other suites cannot drift from Postgres. */
function contract(name: string, make: () => Promise<Repo>, reset?: () => Promise<void>) {
  describe(name, () => {
    let repo: Repo;
    beforeEach(async () => { await reset?.(); repo = await make(); });

    it('stores a report, finds it by id and by the hash of its code, and lists it without its messages', async () => {
      const code = generateReportCode();
      const r = mk(A, 'rpt-1', 'My supervisor is falsifying timesheets.', code);
      await repo.reportTx(A, (tx) => tx.save(r, true));
      const got = await repo.reportTx(A, (tx) => tx.get('rpt-1'));
      expect(got?.messages[0]?.text).toBe('My supervisor is falsifying timesheets.');
      expect((await repo.reportTx(A, (tx) => tx.getByCodeHash(hashReportCode(code))))?.id).toBe('rpt-1');
      expect(await repo.reportTx(A, (tx) => tx.getByCodeHash(hashReportCode(generateReportCode())))).toBeUndefined();
      const rows = await repo.reportTx(A, (tx) => tx.list());
      expect(rows).toEqual([expect.objectContaining({ id: 'rpt-1', status: 'UNTRIAGED', messageCount: 1, awaitingStaff: true, category: 'HR' })]);
      expect(JSON.stringify(rows)).not.toContain('falsifying');
    });

    it('round-trips a thread and the chain still verifies afterwards', async () => {
      let r = mk();
      await repo.reportTx(A, (tx) => tx.save(r, true));
      r = reporterReply(r, 'A follow-up with more detail.', t1);
      await repo.reportTx(A, (tx) => tx.save(r));
      const got = (await repo.reportTx(A, (tx) => tx.get('rpt-1')))!;
      expect(got.messages.map((m) => m.text)).toEqual(['My supervisor is falsifying timesheets.', 'A follow-up with more detail.']);
      expect(verifyReport(got)).toEqual({ valid: true });
    });

    it('filters the inbox by status', async () => {
      await repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-1'), true));
      await repo.reportTx(A, (tx) => tx.save({ ...mk(A, 'rpt-2'), status: 'DISMISSED' }, true));
      expect((await repo.reportTx(A, (tx) => tx.list({ status: 'UNTRIAGED' }))).map((x) => x.id)).toEqual(['rpt-1']);
      expect((await repo.reportTx(A, (tx) => tx.list())).map((x) => x.id).sort()).toEqual(['rpt-1', 'rpt-2']);
    });

    it('refuses a duplicate id or a duplicate code, and an update to a report that is not there', async () => {
      const code = generateReportCode();
      await repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-1', 'first report text', code), true));
      await expect(repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-1', 'same id again', generateReportCode()), true))).rejects.toThrow();
      await expect(repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-2', 'same code again', code), true))).rejects.toThrow();
      await expect(repo.reportTx(A, (tx) => tx.save(mk(A, 'ghost')))).rejects.toThrow();
    });

    it('keeps tenants apart: another tenant sees nothing, not even by id or by code', async () => {
      const code = generateReportCode();
      await repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-1', 'tenant A report text', code), true));
      expect(await repo.reportTx(B, (tx) => tx.get('rpt-1'))).toBeUndefined();
      expect(await repo.reportTx(B, (tx) => tx.getByCodeHash(hashReportCode(code)))).toBeUndefined();
      expect(await repo.reportTx(B, (tx) => tx.list())).toEqual([]);
      await expect(repo.reportTx(B, (tx) => tx.save(mk(A, 'rpt-x'), true))).rejects.toThrow(); // cannot write into another tenant
    });

    it('refuses to rewrite a report’s history or its identity', async () => {
      const r = reporterReply(mk(), 'a second message here', t1);
      await repo.reportTx(A, (tx) => tx.save(r, true));
      const rewritten = { ...r, events: [{ ...r.events[0]!, at: '2020-01-01T00:00:00.000Z' }, ...r.events.slice(1)] };
      await expect(repo.reportTx(A, (tx) => tx.save(rewritten))).rejects.toThrow();
      await expect(repo.reportTx(A, (tx) => tx.save({ ...r, events: r.events.slice(0, 1) }))).rejects.toThrow();
      await expect(repo.reportTx(A, (tx) => tx.save({ ...r, codeHash: hashReportCode(generateReportCode()) }))).rejects.toThrow();
      await expect(repo.reportTx(A, (tx) => tx.save({ ...r, createdAt: '2020-01-01T00:00:00.000Z' }))).rejects.toThrow();
    });

    it('finds a channel by token only, never lists across tenants, and keeps a tenant’s own list private', async () => {
      await repo.saveChannel(channel(A, TOKEN_A));
      await repo.saveChannel(channel(B, TOKEN_B));
      expect(await repo.channelByToken(TOKEN_A)).toMatchObject({ tenantId: A, id: 'ch-tenant-a', active: true });
      expect(await repo.channelByToken('CCCCCCCCCCCCCCCCCCCCCC')).toBeUndefined();
      expect((await repo.listChannels(A)).map((c) => c.token)).toEqual([TOKEN_A]);
      await repo.saveChannel({ ...channel(A, TOKEN_A), active: false });
      expect((await repo.channelByToken(TOKEN_A))?.active).toBe(false);
      await expect(repo.saveChannel(channel(B, TOKEN_A, 'ch-other'))).rejects.toThrow(); // a token belongs to one channel
    });

    it('lets background jobs see a tenant that has only set up a channel', async () => {
      await repo.saveChannel(channel(A, TOKEN_A));
      expect(await repo.listTenants()).toContain(A);
    });
  });
}

contract('MemoryRepo', async () => new MemoryRepo());

describe.skipIf(!PG_ENABLED)('Postgres', () => {
  beforeAll(freshDatabase);
  contract('PgRepo', () => newRepo(), resetData);

  describe('what only the database enforces', () => {
    beforeEach(resetData);

    /** Raw SQL as the application role, with exactly the session settings a given kind of request would carry. */
    async function sql(settings: Record<string, string>, text: string, params: unknown[] = []) {
      const c = new pg.Client({ connectionString: APP });
      await c.connect();
      try {
        await c.query('BEGIN');
        for (const [k, v] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [k, v]);
        const r = await c.query(text, params);
        await c.query('COMMIT');
        return r;
      } finally { await c.end(); }
    }
    const seed = async () => {
      const repo = await newRepo();
      await repo.saveChannel(channel(A, TOKEN_A));
      await repo.saveChannel(channel(B, TOKEN_B));
      await repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-a', 'tenant A secret report'), true));
      await repo.reportTx(B, (tx) => tx.save(mk(B, 'rpt-b', 'tenant B secret report'), true));
      await repo.close?.();
    };

    it('shows a request with no tenant and no token nothing at all', async () => {
      await seed();
      expect((await sql({}, 'SELECT * FROM report_channels')).rowCount).toBe(0);
      expect((await sql({}, 'SELECT * FROM reports')).rowCount).toBe(0);
    });

    it('lets a presented channel token reveal that one channel and nothing else', async () => {
      await seed();
      const one = await sql({ 'app.tenant_id': '', 'app.channel_token': TOKEN_A }, 'SELECT tenant_id, token FROM report_channels');
      expect(one.rows).toEqual([{ tenant_id: A, token: TOKEN_A }]);
      // The token opens the channel table and nothing beside it: no reports, no other tenant's channel.
      expect((await sql({ 'app.tenant_id': '', 'app.channel_token': TOKEN_A }, 'SELECT * FROM reports')).rowCount).toBe(0);
      expect((await sql({ 'app.tenant_id': '', 'app.channel_token': 'not-a-real-token' }, 'SELECT * FROM report_channels')).rowCount).toBe(0);
      // A token cannot be used to write.
      await expect(sql({ 'app.tenant_id': '', 'app.channel_token': TOKEN_A }, "UPDATE report_channels SET active = false WHERE token = $1", [TOKEN_A])).resolves.toMatchObject({ rowCount: 0 });
      expect((await (await newRepo()).channelByToken(TOKEN_A))?.active).toBe(true);
    });

    it('limits a tenant to its own channels and reports, even when it names another tenant’s rows', async () => {
      await seed();
      expect((await sql({ 'app.tenant_id': A }, 'SELECT tenant_id FROM report_channels')).rows).toEqual([{ tenant_id: A }]);
      expect((await sql({ 'app.tenant_id': A }, 'SELECT id FROM reports WHERE id = $1', ['rpt-b'])).rowCount).toBe(0);
      await expect(sql({ 'app.tenant_id': A }, "INSERT INTO report_channels (tenant_id,id,token,label,active,created_at,created_by) VALUES ('tenant-b','x','ZZZZZZZZZZZZZZZZZZZZZZ','{}',true,'t','u')")).rejects.toThrow();
    });

    it('stops the application role from deleting a report, or from rewriting its history, in SQL', async () => {
      await seed();
      await expect(sql({ 'app.tenant_id': A }, 'DELETE FROM reports')).rejects.toThrow(/permission denied|cannot be deleted/);
      await expect(sql({ 'app.tenant_id': A }, `UPDATE reports SET data = jsonb_set(data, '{events,0,at}', '"2020-01-01T00:00:00.000Z"') WHERE id = 'rpt-a'`)).rejects.toThrow(/append-only/);
      await expect(sql({ 'app.tenant_id': A }, `UPDATE reports SET data = jsonb_set(data, '{events}', '[]'::jsonb) WHERE id = 'rpt-a'`)).rejects.toThrow(/append-only/);
      await expect(sql({ 'app.tenant_id': A }, `UPDATE reports SET code_hash = 'f' || substr(code_hash, 2) WHERE id = 'rpt-a'`)).rejects.toThrow(/immutable/);
      await expect(sql({ 'app.tenant_id': A }, `UPDATE reports SET channel_id = 'other' WHERE id = 'rpt-a'`)).rejects.toThrow(/immutable/);
      // Identity is checked inside the JSON too, so the column and the blob cannot be made to disagree.
      await expect(sql({ 'app.tenant_id': A }, `UPDATE reports SET data = jsonb_set(data, '{codeHash}', '"f"') WHERE id = 'rpt-a'`)).rejects.toThrow(/immutable/);
      // The ordinary path still works: the report is unchanged by all of the above.
      const repo = await newRepo();
      expect(verifyReport((await repo.reportTx(A, (tx) => tx.get('rpt-a')))!)).toEqual({ valid: true });
    });
  });

  describe('encrypted at rest', () => {
    it('stores no message or closing note in clear, and survives text that imitates ciphertext', async () => {
      const inner = await newRepo();
      const repo = new EncryptedRepo(inner, new DataCrypto(mkMaster(), inner));
      await resetData();
      const sneaky = 'enc:v1:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA attacker-chosen text';
      await repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-1', 'Plain secret about the supervisor'), true));
      await repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-2', sneaky), true));

      const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
      await admin.connect();
      const rows = (await admin.query("SELECT id, data::text AS t FROM reports ORDER BY id")).rows;
      await admin.end();
      expect(rows[0].t).not.toContain('Plain secret');
      expect(rows[0].t).toContain('"sealed": true');
      expect(rows[1].t).not.toContain('attacker-chosen'); // stored encrypted even though it looked encrypted already

      const a = (await repo.reportTx(A, (tx) => tx.get('rpt-1')))!;
      const b = (await repo.reportTx(A, (tx) => tx.get('rpt-2')))!;
      expect(a.messages[0]!.text).toBe('Plain secret about the supervisor');
      expect(b.messages[0]!.text).toBe(sneaky); // round-trips exactly
      expect(a.sealed).toBeUndefined();
      expect(verifyReport(a)).toEqual({ valid: true });
      expect(verifyReport(b)).toEqual({ valid: true });
      await inner.close?.();
    });

    it('fails closed when two messages’ ciphertexts are swapped in the database', async () => {
      const inner = await newRepo();
      const repo = new EncryptedRepo(inner, new DataCrypto(mkMaster(), inner));
      await resetData();
      await repo.reportTx(A, (tx) => tx.save(reporterReply(mk(A, 'rpt-1', 'the original first message'), 'the second message', t1), true));
      const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
      await admin.connect();
      await admin.query(`UPDATE reports SET data = jsonb_set(jsonb_set(data, '{messages,0,text}', data->'messages'->1->'text'), '{messages,1,text}', data->'messages'->0->'text')`);
      await admin.end();
      await expect(repo.reportTx(A, (tx) => tx.get('rpt-1'))).rejects.toThrow(); // bound to report and message number
      await inner.close?.();
    });
  });
});

describe('encrypted at rest (memory)', () => {
  it('encrypts text that merely begins with the ciphertext prefix instead of mistaking it for ciphertext', async () => {
    const inner = new MemoryRepo();
    const repo = new EncryptedRepo(inner, new DataCrypto(mkMaster(), inner));
    const sneaky = 'enc:v1:1:AAAA attacker-chosen text';
    await repo.reportTx(A, (tx) => tx.save(mk(A, 'rpt-1', sneaky), true));
    const stored = (await inner.reportTx(A, (tx) => tx.get('rpt-1')))!;
    expect(stored.sealed).toBe(true);
    expect(stored.messages[0]!.text).not.toContain('attacker-chosen');
    expect((await repo.reportTx(A, (tx) => tx.get('rpt-1')))!.messages[0]!.text).toBe(sneaky);
  });
});
