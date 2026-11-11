import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';

// Wednesday 11 Nov 2026 08:00 Riyadh. The Saudi weekend is Friday/Saturday.
const NOW = { v: '2026-11-11T05:00:00.000Z' };
function world() {
  const d = new Directory();
  d.add({ id: 'm', name: 'M', kind: 'human', tenantId: 't1', departments: ['HR'], roles: ['hr_intake', 'hr_manager'], reportsTo: [], clearance: 'RESTRICTED' });
  const app = createApp({ repo: new MemoryRepo(), directory: d, clock: () => NOW.v });
  const call = (m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: 'Bearer dev:m', 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });
  return { call };
}

describe('deadlines on the case', () => {
  it('shows the step target (2 business days for a new HR case, skipping the weekend) and its status', async () => {
    const { call } = world();
    await call('POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
    const r = (await (await call('GET', '/cases/HR-1')).json()) as any;
    expect(r.deadlines.sla.status).toBe('ON_TRACK');
    expect(r.deadlines.sla.dueAt.slice(0, 10)).toBe('2026-11-15'); // Wed + 2 business days = Sun 15 Nov
    expect(Array.isArray(r.deadlines.clocks)).toBe(true);
  });
  it('turns overdue once the target passes, and lists carry it', async () => {
    const { call } = world();
    await call('POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
    NOW.v = '2026-11-20T05:00:00.000Z';
    expect(((await (await call('GET', '/cases/HR-1')).json()) as any).deadlines.sla.status).toBe('BREACHED');
    const list = (await (await call('GET', '/cases/search')).json()) as any;
    expect(list.items[0].slaStatus).toBe('BREACHED'); expect(list.items[0].slaDueAt).toBeTruthy();
    NOW.v = '2026-11-11T05:00:00.000Z';
  });
});
