import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { APP, PG_ENABLED, freshDatabase, newRepo, resetData } from './helpers/pg';

const T = 'tenant-a';
const provider = { model: 't', complete: async () => 'x' };
const clock = () => '2026-11-10T08:00:00.000Z';

/** Raw SQL as the application role with a given actor scope: proves the database itself enforces the walls. */
async function sqlAs(scope: Record<string, string>, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: APP }); await c.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(scope)) await c.query('SELECT set_config($1, $2, true)', [k, v]);
    const r = await c.query(text, params); await c.query('COMMIT'); return r;
  } finally { await c.end(); }
}
const actor = (o: { departments: string; clearance: number; roles?: string; kind?: string; matters?: string }) => ({
  'app.tenant_id': T, 'app.scope': 'actor', 'app.kind': o.kind ?? 'human', 'app.departments': o.departments, 'app.roles': o.roles ?? '', 'app.clearance': String(o.clearance), 'app.matters': o.matters ?? '',
});

describe.skipIf(!PG_ENABLED)('database-level walls', () => {
  beforeAll(freshDatabase);
  beforeEach(async () => {
    await resetData();
    const full = { 'app.tenant_id': T, 'app.scope': 'full' };
    const ins = (id: string, dept: string, conf: string, matter?: string) => sqlAs(full,
      `INSERT INTO cases (tenant_id,id,case_type_key,case_type_version,department,state,confidentiality,data,updated_at) VALUES ($1,$2,'x',1,$3,'NEW',$4,$5,'t')`,
      [T, id, dept, conf, JSON.stringify(matter ? { matterId: matter } : {})]);
    await ins('HR-1', 'HR', 'RESTRICTED'); await ins('HR-2', 'HR', 'STANDARD'); await ins('SEC-1', 'SECURITY', 'RESTRICTED');
    await ins('LEG-1', 'LEGAL', 'PRIVILEGED', 'M-1'); await ins('LEG-2', 'LEGAL', 'RESTRICTED', 'M-2');
    await sqlAs(full, `INSERT INTO audit_events (tenant_id,case_id,seq,type,actor_id,actor_kind,at,payload,prev_hash,hash) VALUES ($1,'HR-1',1,'created','u','human','t','{}',$2,$2)`, [T, 'a'.repeat(64)]);
  });
  const ids = async (scope: Record<string, string>) => (await sqlAs(scope, 'SELECT id FROM cases ORDER BY id')).rows.map((r) => r.id);

  it('shows an actor only their own department, within their clearance', async () => {
    expect(await ids(actor({ departments: 'HR', clearance: 1 }))).toEqual(['HR-1', 'HR-2']);
    expect(await ids(actor({ departments: 'HR', clearance: 0 }))).toEqual(['HR-2']); // clearance wall
    expect(await ids(actor({ departments: 'SECURITY', clearance: 1 }))).toEqual(['SEC-1']);
  });
  it('privileged cases need LEGAL membership and PRIVILEGED clearance', async () => {
    expect(await ids(actor({ departments: 'LEGAL', clearance: 2 }))).toEqual(['LEG-1', 'LEG-2']);
    expect(await ids(actor({ departments: 'LEGAL', clearance: 1 }))).toEqual(['LEG-2']);
    expect(await ids(actor({ departments: 'HR', clearance: 2 }))).toEqual(['HR-1', 'HR-2']);
  });
  it('audit assurance reads across departments except privileged, but cannot write', async () => {
    const aa = actor({ departments: 'AUDIT', clearance: 2, roles: 'audit_assurance' });
    expect(await ids(aa)).toEqual(['HR-1', 'HR-2', 'LEG-2', 'SEC-1']);
    const w = await sqlAs(aa, "UPDATE cases SET state='X' WHERE id='HR-1'");
    expect(w.rowCount).toBe(0);
  });
  it('external counsel see only their matters; AI actors cannot write', async () => {
    expect(await ids(actor({ departments: '', clearance: 0, kind: 'external', matters: 'M-1' }))).toEqual(['LEG-1']);
    expect(await ids(actor({ departments: '', clearance: 0, kind: 'external' }))).toEqual([]);
    const ai = actor({ departments: 'HR', clearance: 1, kind: 'ai' });
    expect(await ids(ai)).toEqual(['HR-1', 'HR-2']);
    expect((await sqlAs(ai, "UPDATE cases SET state='X' WHERE id='HR-1'")).rowCount).toBe(0);
  });
  it('fails closed: no scope, wrong tenant, or an unknown scope sees nothing', async () => {
    expect(await ids({ 'app.tenant_id': T })).toEqual([]);
    expect(await ids({ ...actor({ departments: 'HR', clearance: 1 }), 'app.tenant_id': 'other' })).toEqual([]);
    expect(await ids({ 'app.tenant_id': T, 'app.scope': 'whatever' })).toEqual([]);
  });
  it('cannot write into a department the actor is not in', async () => {
    const hr = actor({ departments: 'HR', clearance: 1 });
    await expect(sqlAs(hr, `INSERT INTO cases (tenant_id,id,case_type_key,case_type_version,department,state,confidentiality,data,updated_at) VALUES ($1,'SEC-9','x',1,'SECURITY','NEW','RESTRICTED','{}','t')`, [T])).rejects.toThrow(/row-level security/);
  });
  it('audit events follow their case', async () => {
    const n = async (s: Record<string, string>) => (await sqlAs(s, 'SELECT count(*)::int n FROM audit_events')).rows[0].n;
    expect(await n(actor({ departments: 'HR', clearance: 1 }))).toBe(1);
    expect(await n(actor({ departments: 'SECURITY', clearance: 1 }))).toBe(0);
  });
  it('through the API: another department gets nothing even if the app-level check were skipped', async () => {
    const repo = await newRepo();
    const d = new Directory();
    const mk = (id: string, departments: any, roles: string[]) => d.add({ id, name: id, kind: 'human', tenantId: T, departments, roles, reportsTo: [], clearance: 'RESTRICTED' });
    mk('hr', ['HR'], ['hr_intake', 'hr_manager']); mk('sec', ['SECURITY'], ['security_investigator']);
    const app = createApp({ repo, directory: d, provider, clock });
    const call = (who: string, m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });
    const r = await call('hr', 'POST', '/cases', { id: 'HR-X', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
    expect(r.status).toBe(201);
    expect((await call('hr', 'GET', '/cases/HR-X')).status).toBe(200);
    expect((await call('sec', 'GET', '/cases/HR-X')).status).toBeGreaterThanOrEqual(403);
    expect(((await (await call('sec', 'GET', '/cases')).json()) as any[]).map((x) => x.id)).not.toContain('HR-X');
    expect(((await (await call('hr', 'GET', '/cases')).json()) as any[]).map((x) => x.id)).toContain('HR-X');
  });
});
