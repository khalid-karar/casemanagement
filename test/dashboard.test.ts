import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { TEST_USERS, asPrincipal } from '../src/api/test-users';

let t = 0;
const clock = () => new Date(Date.UTC(2026, 10, 10, 8, 0, 0, ++t)).toISOString();
function build() {
  const d = new Directory(); TEST_USERS.forEach((u) => d.add(asPrincipal(u)));
  const app = createApp({ repo: new MemoryRepo(), directory: d, clock });
  const j = (who: string, m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });
  return { app, j };
}
type W = ReturnType<typeof build>;
const SECRET = 'Whistleblower Nora Al-Qahtani';
async function world() {
  const w = build();
  await w.j('a-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'Falsified expense claims', severity: 'HIGH', reporterIdentity: SECRET, subjectEmployee: 'emp-77' } });
  await w.j('a-hr-mgr', 'POST', '/cases', { id: 'HR-2', caseType: 'hr.misconduct', fields: { allegationSummary: 'Late attendance pattern' } });
  await w.j('a-sec-mgr', 'POST', '/cases', { id: 'SEC-1', caseType: 'security.incident', fields: { narrative: 'Door forced at warehouse' } });
  await w.j('b-hr-mgr', 'POST', '/cases', { id: 'HR-B1', caseType: 'hr.misconduct', fields: { allegationSummary: 'Tenant B only' } });
  return w;
}
const get = async (w: W, who: string, path: string) => (await w.j(who, 'GET', path)).json() as Promise<any>;

describe('case search and dashboard', () => {
  it('never contain a sealed or personal value, for anyone, in any list or count', async () => {
    const w = await world();
    for (const who of TEST_USERS.map((u) => u.id)) {
      for (const p of ['/cases/search?pageSize=100', '/dashboard', `/cases/search?q=${encodeURIComponent('Nora')}`]) {
        const body = JSON.stringify(await get(w, who, p));
        expect(body, `${who} ${p}`).not.toContain('Nora');
        expect(body, `${who} ${p}`).not.toContain('emp-77');
      }
    }
  });

  it('search matches the id and the visible title only, never hidden fields', async () => {
    const w = await world();
    expect((await get(w, 'a-hr-mgr', '/cases/search?q=Nora')).total).toBe(0);
    expect((await get(w, 'a-hr-mgr', '/cases/search?q=expense')).items.map((i: any) => i.id)).toEqual(['HR-1']);
    expect((await get(w, 'a-hr-mgr', '/cases/search?q=hr-2')).items.map((i: any) => i.id)).toEqual(['HR-2']);
  });

  it('respects the tenant and department walls', async () => {
    const w = await world();
    const hr = (await get(w, 'a-hr-mgr', '/cases/search')).items.map((i: any) => i.id).sort();
    expect(hr).toEqual(['HR-1', 'HR-2']);
    expect((await get(w, 'a-sec-mgr', '/cases/search')).items.map((i: any) => i.id)).toEqual(['SEC-1']);
    expect((await get(w, 'b-hr-mgr', '/cases/search')).items.map((i: any) => i.id)).toEqual(['HR-B1']);
    const d = await get(w, 'a-sec-mgr', '/dashboard');
    expect(d.counts.open).toBe(1);
  });

  it('filters, sorts and paginates', async () => {
    const w = await world();
    for (let i = 0; i < 25; i++) await w.j('a-hr-mgr', 'POST', '/cases', { id: `HR-X${String(i).padStart(2, '0')}`, caseType: 'hr.misconduct', fields: { allegationSummary: `bulk ${i}` } });
    const p1 = await get(w, 'a-hr-mgr', '/cases/search?pageSize=10&sort=id&order=asc');
    expect(p1.total).toBe(27); expect(p1.items).toHaveLength(10); expect(p1.items[0].id).toBe('HR-1');
    const p3 = await get(w, 'a-hr-mgr', '/cases/search?pageSize=10&page=3&sort=id&order=asc');
    expect(p3.items).toHaveLength(7);
    expect((await get(w, 'a-hr-mgr', '/cases/search?state=NEW&q=bulk 1')).total).toBe(11);
    expect((await get(w, 'a-hr-mgr', '/cases/search?state=TRIAGED')).total).toBe(0);
    expect((await get(w, 'a-hr-mgr', '/cases/search?pageSize=9999')).pageSize).toBe(100);
  });

  it('numbers cases on the server when no id is given, uniquely', async () => {
    const w = build();
    const ids = new Set<string>();
    for (let i = 0; i < 12; i++) { const r = await w.j('a-hr-mgr', 'POST', '/cases', { caseType: 'hr.misconduct', fields: {} }); expect(r.status).toBe(201); ids.add(((await r.json()) as any).id); }
    expect(ids.size).toBe(12);
    for (const id of ids) expect(id).toMatch(/^HR-2026-[A-Z0-9]{6}$/);
  });

  it('puts assigned cases and overdue actions on my home page', async () => {
    const w = await world();
    await w.j('a-hr-mgr', 'POST', '/cases/HR-1/assignee', { id: 'a-hr-mgr', reportsTo: [] });
    await w.j('a-hr-mgr', 'POST', '/cases/HR-1/actions', { id: 'act-1', description: 'Retrain team', ownerId: 'a-hr-mgr', dueDate: '2026-11-01' });
    await w.j('a-hr-mgr', 'POST', '/cases/HR-1/actions', { id: 'act-2', description: 'Update policy', ownerId: 'a-hr-mgr', dueDate: '2026-11-14' });
    const d = await get(w, 'a-hr-mgr', '/dashboard');
    expect(d.queue.map((q: any) => q.id)).toContain('HR-1');
    expect(d.counts).toMatchObject({ open: 2, overdue: 1, dueSoon: 1 });
    expect(d.actions.find((a: any) => a.actionId === 'act-1').overdue).toBe(true);
    const mineOnly = await get(w, 'a-hr-mgr', '/cases/search?mine=1');
    expect(mineOnly.items.map((i: any) => i.id)).toEqual(['HR-1']);
  });
});
