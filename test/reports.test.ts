import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { toCsv } from '../src/api/summary';

const NOW = { v: '2026-11-11T05:00:00.000Z' };
function world() {
  const d = new Directory();
  d.add({ id: 'm', name: 'M', kind: 'human', tenantId: 't1', departments: ['HR'], roles: ['hr_intake', 'hr_manager'], reportsTo: [], clearance: 'RESTRICTED' });
  const app = createApp({ repo: new MemoryRepo(), directory: d, clock: () => NOW.v });
  const call = (m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: 'Bearer dev:m', 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });
  return { call };
}

describe('reports', () => {
  it('ranks the queue past-target first and reports weekly trends', async () => {
    const { call } = world();
    await call('POST', '/cases', { id: 'HR-OLD', caseType: 'hr.misconduct', fields: { allegationSummary: 'old' } });
    await call('POST', '/cases/HR-OLD/assignee', { id: 'm' });
    NOW.v = '2026-11-20T05:00:00.000Z';
    await call('POST', '/cases', { id: 'HR-NEW', caseType: 'hr.misconduct', fields: { allegationSummary: 'new' } });
    const d = (await (await call('GET', '/dashboard')).json()) as any;
    expect(d.queue[0].id).toBe('HR-OLD'); expect(d.queue[0].slaStatus).toBe('BREACHED');
    expect(d.trends.weeks).toHaveLength(8);
    expect(d.trends.weeks.reduce((n: number, w: any) => n + w.opened, 0)).toBe(2);
    expect(d.trends.slaBreached).toBe(1);
  });
  it('exports the filtered list as CSV with formula cells neutralised', async () => {
    const { call } = world();
    await call('POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: '=HYPERLINK("x")' } });
    const r = await call('GET', '/cases/export.csv?open=1');
    expect(r.headers.get('content-type')).toContain('text/csv');
    const buf = new Uint8Array(await r.arrayBuffer()); const t = new TextDecoder().decode(buf);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]); expect(t.startsWith('id,')).toBe(true); expect(t).toContain('HR-1'); expect(t).toContain(`"'=HYPERLINK`);
    expect(t).not.toMatch(/,=HYPERLINK/);
    expect(toCsv([])).toContain('id,type');
  });
});
