import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { PgRepo } from '../src/api/pg-repo';
import type { ChatProvider } from '../src/ai';
import { ADMIN, APP, PG_ENABLED, freshDatabase, newRepo, resetData } from './helpers/pg';

const T1 = 'tenant-a';
const T2 = 'tenant-b';
const provider: ChatProvider = { model: 't', complete: async () => 'x' };
const clock = () => '2026-11-10T08:00:00.000Z';
function appFor(repo: PgRepo) {
  const d = new Directory();
  const mk = (id: string, departments: any, roles: string[], tenantId = T1) => d.add({ id, name: id, kind: 'human', tenantId, departments, roles, reportsTo: [], clearance: 'RESTRICTED' });
  mk('mgr', ['HR'], ['hr_intake', 'hr_manager']);
  mk('mgr-b', ['HR'], ['hr_manager'], T2);
  mk('editor', ['LEGAL'], ['legal_content_editor'], 'platform');
  mk('verifier', ['LEGAL'], ['legal_verifier'], 'platform');
  mk('client-counsel', ['LEGAL'], ['legal_verifier', 'legal_content_editor'], T1);
  return createApp({ repo, directory: d, provider, clock });
}
const call = (app: ReturnType<typeof appFor>, who: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

async function sqlAs(tenant: string | null, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: APP });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (tenant !== null) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const r = await c.query(text, params);
    await c.query('COMMIT');
    return r;
  } finally {
    await c.end();
  }
}

describe.skipIf(!PG_ENABLED)('Postgres', () => {
  beforeAll(freshDatabase);
  beforeEach(resetData);

  it('refuses to start as a role that bypasses row-level security', async () => {
    await expect(PgRepo.connect(ADMIN!)).rejects.toThrow(/bypasses row-level security/);
  });

  it('survives a restart and the audit chain still verifies after the round trip', async () => {
    const a1 = appFor(await newRepo());
    await call(a1, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x', severity: 'HIGH' } });
    await call(a1, 'mgr', 'POST', '/cases/c1/transitions/triage');
    const a2 = appFor(await newRepo()); // new pool and app = restarted server
    const got = (await (await call(a2, 'mgr', 'GET', '/cases/c1')).json()) as any;
    expect(got.case.state).toBe('TRIAGED');
    const audit = (await (await call(a2, 'mgr', 'GET', '/cases/c1/audit')).json()) as any;
    expect(audit.events).toHaveLength(2);
    expect(audit.integrity.valid).toBe(true);
  });

  it('laws survive a restart: upload, verify, then read from a fresh server', async () => {
    const a1 = appFor(await newRepo());
    await call(a1, 'editor', 'POST', '/laws/instruments', { id: 'labour', tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', issuer: 'MHRSD' });
    await call(a1, 'editor', 'POST', '/laws/versions', { id: 'v1', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: 'المادة 71\nنص' });
    expect((await call(a1, 'verifier', 'POST', '/laws/versions/v1/verify', { note: 'ok' })).status).toBe(200);
    const a2 = appFor(await newRepo());
    expect(((await (await call(a2, 'mgr', 'GET', '/laws')).json()) as any[]).length).toBe(1);
  });

  it('isolates tenants in the database itself, not just in app code', async () => {
    const a = appFor(await newRepo());
    await call(a, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: {} });
    expect((await sqlAs(T1, 'SELECT * FROM cases')).rowCount).toBe(1);
    expect((await sqlAs(T2, 'SELECT * FROM cases')).rowCount).toBe(0);
    expect((await sqlAs(null, 'SELECT * FROM cases')).rowCount).toBe(0); // no tenant set: fail-closed
    expect((await sqlAs('', 'SELECT * FROM audit_events')).rowCount).toBe(0);
    // Even a buggy query that forgets its tenant filter sees nothing of another tenant.
    await expect(sqlAs(T2, "INSERT INTO cases (tenant_id,id,case_type_key,case_type_version,department,state,confidentiality,data,updated_at) VALUES ('tenant-a','x','k',1,'HR','NEW','STANDARD','{}','t')")).rejects.toThrow(/row-level security/);
    expect((await call(a, 'mgr-b', 'GET', '/cases/c1')).status).toBe(404);
  });

  it('keeps the audit trail append-only even for the application role', async () => {
    const a = appFor(await newRepo());
    await call(a, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: {} });
    await expect(sqlAs(T1, "UPDATE audit_events SET type = 'forged'")).rejects.toThrow(/permission denied|append-only/);
    await expect(sqlAs(T1, 'DELETE FROM audit_events')).rejects.toThrow(/permission denied|append-only/);
  });

  it('shows clients only verified baseline law, never drafts, proposals or originals', async () => {
    const a = appFor(await newRepo());
    await call(a, 'editor', 'POST', '/laws/instruments', { id: 'labour', tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', issuer: 'MHRSD' });
    await call(a, 'editor', 'POST', '/laws/versions', { id: 'v1', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: 'المادة 71\nنص' });
    expect((await sqlAs(T1, 'SELECT * FROM legal_versions')).rowCount).toBe(0); // unverified draft hidden from clients
    expect((await sqlAs('platform', 'SELECT * FROM legal_versions')).rowCount).toBe(1);
    await call(a, 'verifier', 'POST', '/laws/versions/v1/verify', { note: 'ok' });
    expect((await sqlAs(T1, 'SELECT * FROM legal_versions')).rowCount).toBe(1);
    expect((await sqlAs(T1, 'SELECT * FROM legal_proposals')).rowCount).toBe(0);
    expect((await sqlAs(T1, 'SELECT * FROM legal_files')).rowCount).toBe(0);
  });

  it('only the platform tenant can write the national baseline', async () => {
    await expect(sqlAs(T1, "INSERT INTO legal_instruments (id, scope_tenant_id, data) VALUES ('evil', NULL, '{}')")).rejects.toThrow(/row-level security/);
    await sqlAs('platform', "INSERT INTO legal_instruments (id, scope_tenant_id, data) VALUES ('ok', NULL, '{}')");
    const a = appFor(await newRepo());
    const r = await call(a, 'client-counsel', 'POST', '/laws/instruments', { id: 'x', tenantId: null, kind: 'LAW', titleAr: 'x', issuer: 'x' });
    expect(r.status).toBe(403);
  });

  it('serialises concurrent actions on one case with a row lock', async () => {
    const a = appFor(await newRepo());
    await call(a, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: { severity: 'HIGH' } });
    const rs = await Promise.all([1, 2, 3].map(() => call(a, 'mgr', 'POST', '/cases/c1/transitions/triage')));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const audit = (await (await call(a, 'mgr', 'GET', '/cases/c1/audit')).json()) as any;
    expect(audit.integrity.valid).toBe(true);
    expect(audit.events).toHaveLength(2); // created + exactly one transition
  });

  it('keeps AI consent across a restart, isolated per tenant, with an append-only log', async () => {
    const mkApp = async () => {
      const d = new Directory();
      d.add({ id: 'admin', name: 'a', kind: 'human', tenantId: T1, departments: ['HR'], roles: ['tenant_admin'], reportsTo: [], clearance: 'RESTRICTED' });
      d.add({ id: 'admin-b', name: 'b', kind: 'human', tenantId: T2, departments: ['HR'], roles: ['tenant_admin'], reportsTo: [], clearance: 'RESTRICTED' });
      const ext: ChatProvider = { model: 'ext', complete: async () => 'x' };
      return createApp({ repo: await newRepo(), directory: d, provider, inKingdom: { provider: ext, name: 'CloudX', region: 'Dammam' }, clock });
    };
    const a1 = await mkApp();
    const t = (await (await call(a1, 'admin', 'GET', '/ai/consent-text?includePersonal=false')).json()) as any;
    expect((await call(a1, 'admin', 'POST', '/ai/consent', { includePersonal: false, name: 'S', title: 'GC', textSha256: t.sha256, acknowledge: true })).status).toBe(201);
    const a2 = await mkApp(); // restarted server
    expect(((await (await call(a2, 'admin', 'GET', '/ai/settings')).json()) as any).mode).toBe('IN_KINGDOM_API');
    expect(((await (await call(a2, 'admin-b', 'GET', '/ai/settings')).json()) as any).mode).toBe('SOVEREIGN');
    expect((await sqlAs(T2, 'SELECT * FROM tenant_ai_settings')).rowCount).toBe(0);
    expect((await sqlAs(T2, 'SELECT * FROM ai_log')).rowCount).toBe(0);
    expect((await sqlAs(T1, 'SELECT * FROM ai_log')).rowCount).toBe(1);
    await expect(sqlAs(T1, "UPDATE ai_log SET type = 'forged'")).rejects.toThrow(/permission denied|append-only/);
    await expect(sqlAs(T1, 'DELETE FROM ai_log')).rejects.toThrow(/permission denied|append-only/);
  });

  it('rejects a duplicate case id with 409, not a crash', async () => {
    const a = appFor(await newRepo());
    await call(a, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: {} });
    expect((await call(a, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: {} })).status).toBe(409);
  });

  // NOT RUN in the build environment (no PostgreSQL server there): run with TEST_ADMIN_URL / TEST_APP_URL set.
  it('stores case documents per tenant, append-only, behind row-level security', async () => {
    const repo = await newRepo();
    const doc = { sha256: 'a'.repeat(64), name: 'f.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]), uploadedBy: 'mgr', uploadedAt: clock() };
    await repo.putCaseDocument(T1, 'c1', doc);
    await repo.putCaseDocument(T1, 'c1', doc); // idempotent
    expect(Array.from((await repo.getCaseDocument(T1, 'c1', doc.sha256))!.bytes)).toEqual([1, 2, 3]);
    expect(await repo.getCaseDocument(T2, 'c1', doc.sha256)).toBeUndefined(); // other tenant: nothing
    expect((await sqlAs(T2, 'SELECT * FROM case_documents')).rowCount).toBe(0);
    expect((await sqlAs(null, 'SELECT * FROM case_documents')).rowCount).toBe(0); // no tenant set: fails closed
    expect((await sqlAs(T1, 'SELECT * FROM case_documents')).rowCount).toBe(1);
    await expect(sqlAs(T1, "UPDATE case_documents SET name = 'x'")).rejects.toThrow(/permission denied|append-only/);
    await expect(sqlAs(T1, 'DELETE FROM case_documents')).rejects.toThrow(/permission denied|append-only/);
    await expect(sqlAs(T2, "INSERT INTO case_documents VALUES ('tenant-a','c1','" + 'b'.repeat(64) + "','n','m',1,'\\x00','u','t')")).rejects.toThrow(/row-level security/);
  });
});
