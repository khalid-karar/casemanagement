import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { TEST_USERS, asPrincipal } from '../src/api/test-users';
import { boardCsv, boardReport } from '../src/api/board';
import { CASE_TYPES } from '../src/case-types';
import { createCase } from '../src/engine';
import type { CaseState } from '../src/engine';

const NOW = '2026-11-11T05:00:00.000Z';
const hrDef = CASE_TYPES['hr.misconduct']!;
const mgr = asPrincipal(TEST_USERS.find((u) => u.id === 'a-hr-mgr')!);
const mk = (id: string, createdAt: string, extra: Partial<CaseState> = {}, fields: Record<string, unknown> = {}): CaseState =>
  ({ ...createCase(hrDef, { id, fields }, mgr, createdAt).case, ...extra });
const closed = (id: string, createdAt: string, closedAt: string, outcome?: string) => mk(id, createdAt, { state: 'CLOSED', closedAt }, outcome ? { outcome } : {});

describe('board report', () => {
  const cases = [
    mk('open-new', '2026-11-01T00:00:00.000Z'), mk('open-old', '2026-06-01T00:00:00.000Z'),
    closed('c1', '2026-10-01T00:00:00.000Z', '2026-10-11T00:00:00.000Z', 'SUBSTANTIATED_PENALTY'),
    closed('c2', '2026-10-01T00:00:00.000Z', '2026-10-21T00:00:00.000Z', 'UNSUBSTANTIATED'),
    closed('c3', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'), // closed with no outcome recorded
    closed('before', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'SUBSTANTIATED_PENALTY'), // outside the period
  ];
  const r = boardReport(cases, mgr, CASE_TYPES, NOW, { from: '2026-10-01', to: '2026-11-11' });

  it('counts volumes inside the period and what is open now', () => {
    expect(r).toMatchObject({ opened: 4, closed: 3, openNow: 2, scope: 'READABLE_CASES' });
    expect(r.aging.find((a) => a.bucket === '90+')!.count).toBe(1);
    expect(r.aging.find((a) => a.bucket === '0-30')!.count).toBe(1);
  });
  it('measures time to close and the substantiation rate only over cases that recorded an outcome', () => {
    expect(r.avgDaysToClose).toBe(20);
    expect(r.substantiation).toEqual({ decided: 2, substantiated: 1, rate: 50 });
    expect(r.byOutcome.map((o) => o.outcome).sort()).toEqual(['SUBSTANTIATED_PENALTY', 'UNSUBSTANTIATED']);
  });
  it('says nothing when there is nothing to measure, rather than 0 or NaN', () => {
    const e = boardReport([], mgr, CASE_TYPES, NOW, { from: '2026-10-01', to: '2026-11-11' });
    expect(e.avgDaysToClose).toBeNull(); expect(e.substantiation.rate).toBeNull();
  });
  it('holds no case numbers and no names, in JSON or CSV', () => {
    const all = JSON.stringify(r) + boardCsv(r);
    for (const id of ['open-new', 'open-old', 'c1', 'c2', 'c3', 'a-hr-mgr']) expect(all).not.toContain(id);
  });
  it('leaves out a case the requester may not read', () => {
    const sec = asPrincipal(TEST_USERS.find((u) => u.id === 'a-sec-mgr')!);
    expect(boardReport(cases, sec, CASE_TYPES, NOW, { from: '2026-10-01', to: '2026-11-11' }).openNow).toBe(0);
  });
  it('neutralises spreadsheet formulas in the CSV', () => {
    expect(boardCsv({ ...r, byOutcome: [{ outcome: '=HYPERLINK("x")', count: 1 }] })).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('board report and evidence folders over the API', () => {
  const d = new Directory(); TEST_USERS.forEach((u) => d.add(asPrincipal(u)));
  const app = createApp({ repo: new MemoryRepo(), directory: d, clock: () => NOW });
  const as = (who: string, m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });

  it('needs sign-in, validates dates, and returns the same figures as CSV', async () => {
    expect((await app.request('/board-report')).status).toBe(401);
    for (const q of ['from=2026-13-40', 'from=2026-11-12&to=2026-11-01', 'from=nope', 'from=2020-01-01&to=2026-11-11']) expect((await as('a-hr-mgr', 'GET', `/board-report?${q}`)).status, q).toBe(400);
    await as('a-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
    const j = await (await as('a-hr-mgr', 'GET', '/board-report')).json() as any;
    expect(j.opened).toBe(1); expect(j.reports).toBeUndefined(); // not an ethics officer
    const csv = await as('a-hr-mgr', 'GET', '/board-report?format=csv');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('volume,opened,1');
    expect(((await (await as('a-ethics', 'GET', '/board-report')).json()) as any).reports).toEqual({ received: 0, awaitingTriage: 0 });
  });

  it('files an uploaded document under a folder, cleaning the label', async () => {
    await as('a-hr-mgr', 'POST', '/cases', { id: 'HR-2', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
    const send = async (folder?: string) => {
      const fd = new FormData();
      fd.set('file', new File([new TextEncoder().encode(`note ${folder === undefined ? 'none' : 'some'}`)], 'n.txt')); fd.set('type', 'evidence'); if (folder !== undefined) fd.set('folder', folder);
      return app.request('/cases/HR-2/documents', { method: 'POST', headers: { authorization: 'Bearer dev:a-hr-mgr' }, body: fd });
    };
    expect((await send('  Witness:\u0000  <b>Ahmed</b>\n ')).status).toBe(201);
    expect((await send()).status).toBe(201);
    const c = await (await as('a-hr-mgr', 'GET', '/cases/HR-2')).json() as any;
    const folders = c.case.artifacts.filter((a: any) => a.type === 'evidence').map((a: any) => a.payload.folder);
    expect(folders).toContain('Witness: bAhmed/b');
    expect(folders).toContain(undefined);
  });

  it('a channel carries a QR image of its public address', async () => {
    d.add({ id: 'adm', name: 'adm', kind: 'human', tenantId: 'tenant-a', departments: ['HR'], roles: ['tenant_admin'], reportsTo: [], clearance: 'RESTRICTED' });
    const ch = await (await as('adm', 'POST', '/report-channels', { labelAr: 'مدخل', labelEn: 'Entrance' })).json() as any;
    expect(ch.qr).toContain('<svg'); expect(ch.url).toMatch(/\/r\/[A-Za-z0-9_-]{22}$/);
  });
});
