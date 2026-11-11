import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';

function world() {
  const d = new Directory();
  const mk = (id: string, roles: string[], reportsTo: string[] = [], tenantId = 't1') => d.add({ id, name: `Name ${id}`, kind: 'human', tenantId, departments: ['HR'], roles, reportsTo, clearance: 'RESTRICTED' });
  mk('mgr', ['hr_intake', 'hr_manager', 'tenant_admin']); mk('boss-of-subject', ['hr_manager'], ['emp-77']); mk('plain', ['hr_intake']); mk('other', ['hr_manager'], [], 't2');
  const app = createApp({ repo: new MemoryRepo(), directory: d, clock: () => '2026-11-10T08:00:00.000Z' });
  const call = (who: string, m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });
  return { call };
}

describe('people and assignment', () => {
  it('lists names for the tenant only; roles and last sign-in only for tenant admins', async () => {
    const { call } = world();
    const asAdmin = (await (await call('mgr', 'GET', '/people')).json()) as any[];
    expect(asAdmin.map((p) => p.id).sort()).toEqual(['boss-of-subject', 'mgr', 'plain']);
    expect(asAdmin.find((p) => p.id === 'mgr').roles).toContain('tenant_admin');
    const asPlain = (await (await call('plain', 'GET', '/people')).json()) as any[];
    expect(asPlain[0]).toHaveProperty('name'); expect(asPlain[0]).not.toHaveProperty('roles'); expect(asPlain[0]).not.toHaveProperty('lastSeen');
  });
  it('assignee comes from the directory, not the request: a spoofed empty management chain does not hide a conflict', async () => {
    const { call } = world();
    const r = await call('mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' }, parties: [{ personId: 'emp-77', role: 'SUBJECT', reportsTo: [] }] });
    expect(r.status).toBe(201);
    const bad = await call('mgr', 'POST', '/cases/HR-1/assignee', { id: 'boss-of-subject', reportsTo: [] });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await call('mgr', 'POST', '/cases/HR-1/assignee', { id: 'plain' })).status).toBe(200);
  });
  it('rejects assigning someone unknown or from another client', async () => {
    const { call } = world();
    await call('mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
    expect((await call('mgr', 'POST', '/cases/HR-1/assignee', { id: 'nobody' })).status).toBe(422);
    expect((await call('mgr', 'POST', '/cases/HR-1/assignee', { id: 'other' })).status).toBe(422);
  });
});

import { PG_ENABLED, freshDatabase, newRepo } from './helpers/pg';
describe.skipIf(!PG_ENABLED)('people on Postgres', () => {
  it('stores people per client, updates on re-sign-in, and hides other clients', async () => {
    await freshDatabase(); const r = await newRepo();
    const p = { id: 'u1', name: 'Sara', kind: 'human', tenantId: 't1', departments: ['HR'], roles: ['hr_manager'], reportsTo: ['b1'], lastSeen: 'a' };
    await r.touchPerson(p); await r.touchPerson({ ...p, name: 'Sara A', lastSeen: 'b' });
    expect(await r.listPeople('t1')).toEqual([{ ...p, name: 'Sara A', lastSeen: 'b' }]);
    expect(await r.listPeople('t2')).toEqual([]);
    await r.close?.();
  });
});

describe('clearing a field', () => {
  it('null clears an ordinary field, is audited with the old value, and leaves other fields alone', async () => {
    const { call } = world();
    await call('mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x', incidentDate: '2026-10-04' } });
    const r = await call('mgr', 'PATCH', '/cases/HR-1/fields', { incidentDate: null });
    expect(r.status).toBe(200);
    const c = (await r.json()) as any;
    expect(c.fields.incidentDate).toBeUndefined(); expect(c.fields.allegationSummary).toBe('x');
    const audit = (await (await call('mgr', 'GET', '/cases/HR-1/audit')).json()) as any;
    expect(JSON.stringify(audit.events.at(-1).payload)).toContain('2026-10-04');
  });
  it('still rejects a wrong value, and a null for an unknown field', async () => {
    const { call } = world();
    await call('mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: {} });
    expect((await call('mgr', 'PATCH', '/cases/HR-1/fields', { incidentDate: 'nope' })).status).toBe(400);
    expect((await call('mgr', 'PATCH', '/cases/HR-1/fields', { nonsense: null })).status).toBe(400);
  });
});
