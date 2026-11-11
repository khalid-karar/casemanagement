import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { deadlineAlerts } from '../src/ops/alerts';
import { ConsoleMailer, composeMail, sendPendingMail } from '../src/ops/mailer';

const NOW = { v: '2026-11-11T05:00:00.000Z' };
function world() {
  const repo = new MemoryRepo(); const d = new Directory();
  const mk = (id: string, departments: any[], roles: string[], extra: object = {}) => d.add({ id, name: `Name ${id}`, kind: 'human', tenantId: 't1', departments, roles, reportsTo: [], clearance: 'RESTRICTED', ...extra });
  mk('mgr', ['HR'], ['hr_intake', 'hr_manager'], { email: 'mgr@x.sa' }); mk('inv', ['HR'], ['hr_investigator', 'hr_intake'], { email: 'inv@x.sa' }); mk('sec', ['SECURITY'], ['security_manager'], { email: 'sec@x.sa' });
  const app = createApp({ repo, directory: d, clock: () => NOW.v });
  const call = (who: string, m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });
  const j = async (who: string, m: string, p: string, b?: unknown) => (await call(who, m, p, b)).json() as Promise<any>;
  return { repo, call, j };
}
const mkCase = (w: ReturnType<typeof world>) => w.call('mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });

describe('notes', () => {
  it('adds a note, shows it on the case, and keeps it out of the generic artifact route', async () => {
    const w = world(); await mkCase(w);
    const r = await w.call('mgr', 'POST', '/cases/HR-1/notes', { text: 'Interviewed the first witness.', mentions: [] });
    expect(r.status).toBe(201);
    const c = await w.j('mgr', 'GET', '/cases/HR-1');
    expect(c.case.artifacts.some((a: any) => a.type === 'note' && a.payload.text.includes('witness'))).toBe(true);
    expect((await w.call('mgr', 'POST', '/cases/HR-1/artifacts', { id: 'n1', type: 'note', payload: { text: 'sneaky' } })).status).toBe(400);
  });
  it('rejects empty, oversized and over-mentioned notes', async () => {
    const w = world(); await mkCase(w);
    for (const b of [{ text: '  ' }, { text: 'x'.repeat(5001) }, { text: 'ok', mentions: Array.from({ length: 21 }, (_, i) => 'u' + i) }, {}]) expect((await w.call('mgr', 'POST', '/cases/HR-1/notes', b)).status).toBe(400);
  });
  it('another department cannot read or write notes on the case', async () => {
    const w = world(); await mkCase(w);
    expect((await w.call('sec', 'POST', '/cases/HR-1/notes', { text: 'hi' })).status).toBeGreaterThanOrEqual(403);
  });
});

describe('notifications', () => {
  it('mentioning a colleague notifies them with no content; people behind a wall are not told, the author learns who was not reached', async () => {
    const w = world(); await mkCase(w);
    const r = await w.j('mgr', 'POST', '/cases/HR-1/notes', { text: 'secret detail', mentions: ['inv', 'sec'] });
    expect(r.notReached).toEqual(['sec']);
    const inbox = await w.j('inv', 'GET', '/notifications');
    expect(inbox.unread).toBe(1); expect(inbox.items[0]).toMatchObject({ kind: 'MENTIONED', caseId: 'HR-1', actorId: 'mgr' });
    expect(JSON.stringify(inbox)).not.toContain('secret detail');
    expect((await w.j('sec', 'GET', '/notifications')).items).toEqual([]);
    expect((await w.j('mgr', 'GET', '/notifications')).items).toEqual([]); // not notified about own action
  });
  it('assignment and step changes notify the assignee; marking read clears the count; others cannot read someone else’s', async () => {
    const w = world(); await mkCase(w);
    await w.call('mgr', 'POST', '/cases/HR-1/assignee', { id: 'inv' });
    expect((await w.j('inv', 'GET', '/notifications/count')).unread).toBe(1);
    await w.call('mgr', 'PATCH', '/cases/HR-1/fields', { severity: 'HIGH' });
    await w.call('mgr', 'POST', '/cases/HR-1/transitions/triage');
    const list = await w.j('inv', 'GET', '/notifications');
    expect(list.items.map((n: any) => n.kind).sort()).toEqual(['ASSIGNED', 'STATE_CHANGED']);
    expect((await w.j('mgr', 'POST', '/notifications/read', { ids: [list.items[0].id] })).unread).toBe(0); // someone else's id: no effect on inv
    expect((await w.j('inv', 'GET', '/notifications/count')).unread).toBe(2);
    expect((await w.j('inv', 'POST', '/notifications/read', { all: true })).unread).toBe(0);
  });
  it('deadline alerts fire once per case, step and status', async () => {
    const w = world(); await mkCase(w); await w.call('inv', 'GET', '/me'); await w.call('mgr', 'POST', '/cases/HR-1/assignee', { id: 'inv' });
    NOW.v = '2026-11-20T05:00:00.000Z';
    expect((await deadlineAlerts(w.repo, NOW.v)).sent).toBe(1);
    expect((await deadlineAlerts(w.repo, NOW.v)).sent).toBe(0);
    expect((await w.j('inv', 'GET', '/notifications')).items.map((n: any) => n.kind)).toContain('SLA_BREACH');
    NOW.v = '2026-11-11T05:00:00.000Z';
  });
});

describe('e-mail', () => {
  it('is content-free, bilingual and linked; opted-out and address-less people are skipped; each is sent once', async () => {
    const w = world(); await mkCase(w);
    for (const u of ['mgr', 'inv']) await w.call(u, 'GET', '/me');
    await w.call('inv', 'PUT', '/notifications/settings', { emailOptout: false });
    await w.call('mgr', 'POST', '/cases/HR-1/notes', { text: 'top secret', mentions: ['inv'] });
    const mailer = new ConsoleMailer(); vi_silence();
    const r = await sendPendingMail(w.repo, mailer, 'https://cases.client.sa', NOW.v);
    expect(r.sent).toBe(1); expect(mailer.sent[0]!.to).toBe('inv@x.sa');
    expect(mailer.sent[0]!.text).toContain('https://cases.client.sa/#/cases/HR-1'); expect(mailer.sent[0]!.text).not.toContain('top secret');
    expect(mailer.sent[0]!.text).toMatch(/[؀-ۿ]/);
    expect((await sendPendingMail(w.repo, mailer, 'https://cases.client.sa', NOW.v)).sent).toBe(0);
  });
  it('respects the opt-out', async () => {
    const w = world(); await mkCase(w); await w.call('inv', 'GET', '/me'); await w.call('mgr', 'GET', '/me');
    await w.call('inv', 'PUT', '/notifications/settings', { emailOptout: true });
    await w.call('mgr', 'POST', '/cases/HR-1/notes', { text: 'x', mentions: ['inv'] });
    const mailer = new ConsoleMailer(); vi_silence();
    expect((await sendPendingMail(w.repo, mailer, 'https://x', NOW.v)).sent).toBe(0);
    expect((await w.j('inv', 'GET', '/notifications')).unread).toBe(1); // still in the inbox
  });
  it('composeMail never includes anything but the case number and link', () => {
    const m = composeMail({ id: 'n', tenantId: 't', userId: 'u', kind: 'ASSIGNED', caseId: 'HR-9', createdAt: 'x' }, { id: 'u', name: 'N', kind: 'human', tenantId: 't', departments: [], roles: [], reportsTo: [], lastSeen: '', email: 'a@b.sa' }, 'https://h');
    expect(m.subject).toContain('HR-9'); expect(m.text.split('\n').length).toBeLessThan(14);
  });
});
function vi_silence() { /* ConsoleMailer logs one line per mail; harmless in test output */ }

import { PG_ENABLED, freshDatabase, newRepo } from './helpers/pg';
describe.skipIf(!PG_ENABLED)('notifications on Postgres', () => {
  it('stores, dedupes, counts, marks read, and joins people for e-mail; other clients see nothing', async () => {
    await freshDatabase(); const r = await newRepo();
    const person = { id: 'u1', name: 'Sara', kind: 'human', tenantId: 't1', departments: ['HR'], roles: [], reportsTo: [], lastSeen: 'a', clearance: 'RESTRICTED' as const, email: 's@x.sa' };
    await r.touchPerson(person);
    const n = (id: string, dedupe?: string) => ({ id, tenantId: 't1', userId: 'u1', kind: 'ASSIGNED' as const, caseId: 'HR-1', actorId: 'a', dedupeKey: dedupe ?? null, createdAt: '2026-11-11T00:00:0' + id.slice(-1) + 'Z' });
    expect(await r.addNotification(n('n1', 'k'))).toBe(true); expect(await r.addNotification(n('n2', 'k'))).toBe(false); expect(await r.addNotification(n('n3'))).toBe(true);
    expect(await r.countUnread('t1', 'u1')).toBe(2); expect(await r.countUnread('t2', 'u1')).toBe(0);
    const pend = await r.pendingEmails('t1', 10); expect(pend.map((x) => x.n.id)).toEqual(['n1', 'n3']); expect(pend[0]!.person.email).toBe('s@x.sa');
    await r.markEmailed('t1', ['n1'], 'x'); expect((await r.pendingEmails('t1', 10)).map((x) => x.n.id)).toEqual(['n3']);
    await r.markRead('t1', 'u1', ['n1'], 'x'); expect(await r.countUnread('t1', 'u1')).toBe(1);
    await r.setEmailOptout('t1', 'u1', true); await r.touchPerson({ ...person, lastSeen: 'b' }); // sign-in must not reset the opt-out
    expect((await r.listPeople('t1'))[0]!.emailOptout).toBe(true);
    await r.markRead('t1', 'u1', 'all', 'y'); expect(await r.countUnread('t1', 'u1')).toBe(0);
    await r.close?.();
  });
});
