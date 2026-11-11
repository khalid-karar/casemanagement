import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { FileAnchorSink, MemoryAnchorSink, anchorAll, verifyAnchors } from '../src/ops/anchor';
import { Scheduler } from '../src/ops/scheduler';

const mkApp = (repo: MemoryRepo, at = '2026-11-10T08:00:00.000Z') => {
  const d = new Directory();
  d.add({ id: 'm', name: 'm', kind: 'human', tenantId: 't1', departments: ['HR'], roles: ['hr_intake', 'hr_manager'], reportsTo: [], clearance: 'RESTRICTED' });
  return createApp({ repo, directory: d, clock: () => at });
};
const call = (app: any, m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: 'Bearer dev:m', 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });

describe('audit anchoring', () => {
  it('records chain heads, chains the anchors, and verifies against the live data', async () => {
    const repo = new MemoryRepo(); const app = mkApp(repo); const sink = new MemoryAnchorSink();
    await call(app, 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
    await anchorAll(repo, sink, '2026-11-10T09:00:00Z');
    await call(app, 'POST', '/cases/HR-1/transitions/triage');
    await anchorAll(repo, sink, '2026-11-10T10:00:00Z');
    expect(sink.records).toHaveLength(2);
    expect(sink.records[1]!.prev).toBe(sink.records[0]!.hash);
    expect(await verifyAnchors(repo, sink, 't1')).toEqual([]);
  });
  it('detects a rewritten history (a different chain under the same case id)', async () => {
    const repo = new MemoryRepo(); const sink = new MemoryAnchorSink();
    await call(mkApp(repo), 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'original' } });
    await anchorAll(repo, sink, '2026-11-10T09:00:00Z');
    const forged = new MemoryRepo(); // same case id, different content => different chain hashes
    await call(mkApp(forged, '2026-11-10T08:00:01.000Z'), 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'doctored' } });
    expect((await verifyAnchors(forged, sink, 't1')).map((p) => p.kind)).toContain('HISTORY_REWRITTEN');
    const empty = new MemoryRepo();
    expect((await verifyAnchors(empty, sink, 't1')).map((p) => p.kind)).toContain('CASE_MISSING');
  });
  it('detects an edited or deleted anchor', async () => {
    const repo = new MemoryRepo(); const app = mkApp(repo); const sink = new MemoryAnchorSink();
    await call(app, 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: {} });
    await anchorAll(repo, sink, 'a'); await anchorAll(repo, sink, 'b'); await anchorAll(repo, sink, 'c');
    sink.records.splice(1, 1);
    expect((await verifyAnchors(repo, sink, 't1')).map((p) => p.kind)).toContain('ANCHOR_CHAIN_BROKEN');
    sink.records[0]!.heads = [];
    expect((await verifyAnchors(repo, sink, 't1')).map((p) => p.kind)).toContain('ANCHOR_ALTERED');
  });
  it('the file sink persists across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anch-')); const repo = new MemoryRepo();
    await call(mkApp(repo), 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: {} });
    await anchorAll(repo, new FileAnchorSink(dir), 'a');
    await anchorAll(repo, new FileAnchorSink(dir), 'b'); // new instance = restart
    expect(await verifyAnchors(repo, new FileAnchorSink(dir), 't1')).toEqual([]);
    expect((await new FileAnchorSink(dir).all('t1'))).toHaveLength(2);
  });
});

describe('scheduler', () => {
  it('runs a job, records the outcome, and survives a failing job', async () => {
    const repo = new MemoryRepo(); const ok = vi.fn(async () => 'done'); const bad = vi.fn(async () => { throw new Error('boom'); });
    const s = new Scheduler(repo, [{ name: 'a', everyMs: 1e9, run: ok }, { name: 'b', everyMs: 1e9, run: bad }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await s.runOnce({ name: 'a', everyMs: 1, run: ok }); await s.runOnce({ name: 'b', everyMs: 1, run: bad });
    expect(s.last.get('a')).toMatchObject({ ok: true, result: 'done' });
    expect(s.last.get('b')).toMatchObject({ ok: false, error: 'boom' });
  });
  it('never overlaps itself, and only one server runs a job at a time', async () => {
    const repo = new MemoryRepo(); let n = 0; let release!: () => void;
    const slow = { name: 's', everyMs: 1, run: () => new Promise<void>((r) => { n++; release = r; }) };
    const s1 = new Scheduler(repo, [slow]); const s2 = new Scheduler(repo, [slow]);
    const first = s1.runOnce(slow);
    await new Promise((r) => setTimeout(r, 5));
    expect(await s1.runOnce(slow)).toBe(false); // same server: no overlap
    expect(await s2.runOnce(slow)).toBe(false); // another server: lock held
    expect(n).toBe(1);
    release(); await first;
    expect(await s2.runOnce({ ...slow, run: async () => {} })).toBe(true);
  });
});

import { PG_ENABLED, freshDatabase, newRepo } from './helpers/pg';
describe.skipIf(!PG_ENABLED)('ops on Postgres', () => {
  it('lists tenants that have data and shares a job lock across servers', async () => {
    await freshDatabase();
    const r1 = await newRepo(), r2 = await newRepo();
    const d = new Directory();
    d.add({ id: 'm', name: 'm', kind: 'human', tenantId: 't1', departments: ['HR'], roles: ['hr_intake'], reportsTo: [], clearance: 'RESTRICTED' });
    const app = createApp({ repo: r1, directory: d, clock: () => '2026-11-10T08:00:00.000Z' });
    await call(app, 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: {} });
    expect(await r2.listTenants()).toEqual(['t1']);
    let inner = true; let second: boolean | undefined;
    await r1.withLock('x', async () => { second = await r2.withLock('x', async () => { inner = false; }); });
    expect(second).toBe(false); expect(inner).toBe(true);
    expect(await r2.withLock('x', async () => {})).toBe(true); // released
    await r1.close?.(); await r2.close?.();
  });
});
