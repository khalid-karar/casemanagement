import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import type { Repo } from '../src/api/repo';
import { EncryptedRepo } from '../src/security/encrypted-repo';
import { DataCrypto, MasterKeys } from '../src/security/crypto';
import { deadlineAlerts } from '../src/ops/alerts';
import { composeMail } from '../src/ops/mailer';
import { PG_ENABLED, freshDatabase, newRepo, resetData } from './helpers/pg';

const TOKEN = 'abcdefghijklmnopqrstuv'; // 22 characters
const NOW = { v: '2026-11-11T05:00:00.000Z' };
const mkMaster = () => new MasterKeys('k1', Object.fromEntries(Object.entries(MasterKeys.generate('k1')).map(([k, v]) => [k, Buffer.from(v, 'base64')])));
const TEXT = 'The warehouse supervisor has been signing off deliveries that never arrived.';

async function world(repo: Repo, opts: { limits?: object; ip?: string } = {}) {
  const d = new Directory();
  const mk = (id: string, tenantId: string, departments: any[], roles: string[]) => d.add({ id, name: id, kind: 'human', tenantId, departments, roles, reportsTo: [], clearance: 'RESTRICTED' });
  mk('eth', 't1', ['HR'], ['ethics_officer']); mk('hrm', 't1', ['HR'], ['hr_manager', 'hr_intake', 'tenant_admin']); mk('adm', 't1', ['HR'], ['tenant_admin']);
  mk('eth2', 't2', ['HR'], ['ethics_officer']);
  const ip = { v: opts.ip ?? '10.0.0.1' };
  const app = createApp({ repo, directory: d, clock: () => NOW.v, publicReports: { address: () => ip.v, ...(opts.limits ? { limits: opts.limits } : {}) } });
  const anon = (m: string, p: string, b?: unknown, headers: Record<string, string> = {}) => app.request(p, { method: m, headers: { 'content-type': 'application/json', ...headers }, ...(b !== undefined ? { body: typeof b === 'string' ? b : JSON.stringify(b) } : {}) });
  const as = (who: string, m: string, p: string, b?: unknown) => anon(m, p, b, { authorization: `Bearer dev:${who}` });
  await repo.saveChannel({ id: 'ch1', tenantId: 't1', token: TOKEN, label: { ar: 'مستودع الرياض', en: 'Riyadh warehouse' }, active: true, createdAt: NOW.v, createdBy: 'adm' });
  const file = async (b: object = { category: 'AUDIT', language: 'en', text: TEXT }) => (await anon('POST', `/public/${TOKEN}/reports`, b)).json() as Promise<any>;
  return { repo, app, anon, as, file, ip };
}

function suite(name: string, make: () => Promise<Repo>) {
  describe(name, () => {
    it('files a report with no sign-in, gives the code once, and never echoes staff or case information', async () => {
      const w = await world(await make());
      const r = await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'AUDIT', language: 'en', text: TEXT });
      expect(r.status).toBe(201);
      expect(r.headers.get('x-robots-tag')).toContain('noindex');
      const body = await r.json() as any;
      expect(body.code).toMatch(/^[0-9A-Z-]{24,}$/);
      expect(body.status).toBe('RECEIVED');
      expect(Object.keys(body).sort()).toEqual(['canReply', 'code', 'createdAt', 'messages', 'status']);
      // the same code opens it, written in lower case with the dashes dropped
      const t = await w.anon('POST', `/public/${TOKEN}/track`, { code: body.code.toLowerCase().replace(/-/g, '') });
      expect(t.status).toBe(200);
      expect((await t.json() as any).messages[0]).toMatchObject({ n: 1, from: 'YOU', text: TEXT });
    });

    it('answers every "no" the same: wrong token, retired channel, wrong code, malformed code', async () => {
      const w = await world(await make());
      const ok = await w.file();
      await w.repo.saveChannel({ id: 'ch2', tenantId: 't1', token: 'ZZZZZZZZZZZZZZZZZZZZZZ', label: { ar: 'x', en: 'x' }, active: false, createdAt: NOW.v, createdBy: 'adm' });
      const cases: [string, unknown][] = [
        [`/public/${'q'.repeat(22)}/track`, { code: ok.code }], [`/public/ZZZZZZZZZZZZZZZZZZZZZZ/track`, { code: ok.code }], ['/public/short/track', { code: ok.code }],
        [`/public/${TOKEN}/track`, { code: 'AAAAAAAAAAAAAAAAAAAAAAAA' }], [`/public/${TOKEN}/track`, { code: 'nope' }], [`/public/${TOKEN}/track`, {}], [`/public/${TOKEN}/track`, '{broken'],
      ];
      const seen = new Set<string>();
      for (const [p, b] of cases) { const r = await w.anon('POST', p, b); expect(r.status).toBe(404); seen.add(await r.text()); }
      expect(seen.size).toBe(1);
      expect((await w.anon('POST', '/public/ZZZZZZZZZZZZZZZZZZZZZZ/reports', { category: 'HR', language: 'en', text: TEXT })).status).toBe(404);
    });

    it('rejects bad input without saving, and caps the body size', async () => {
      const w = await world(await make(), { limits: { createPerSourceHour: 100 } });
      for (const b of [{ category: 'HR', language: 'en', text: 'short' }, { category: 'NOPE', language: 'en', text: TEXT }, { category: 'HR', language: 'xx', text: TEXT }, { category: 'HR', language: 'en' }, []]) {
        expect((await w.anon('POST', `/public/${TOKEN}/reports`, b)).status).toBe(400);
      }
      expect((await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'HR', language: 'en', text: 'x'.repeat(20_001) })).status).toBe(400);
      expect((await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'HR', language: 'en', text: 'x'.repeat(200_000) })).status).toBe(413);
      expect(await w.repo.reportTx('t1', (tx) => tx.list())).toHaveLength(0);
    });

    it('a two-way thread: reporter and ethics officer talk, and the reporter sees "Team" without a name', async () => {
      const w = await world(await make());
      const { code } = await w.file();
      const list = await (await w.as('eth', 'GET', '/reports')).json() as any[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ status: 'UNTRIAGED', awaitingStaff: true, messageCount: 1, category: 'AUDIT' });
      const id = list[0].id;
      expect((await w.as('eth', 'POST', `/reports/${id}/reply`, { text: 'Can you say which site, and roughly when?' })).status).toBe(200);
      const view = await (await w.anon('POST', `/public/${TOKEN}/track`, { code })).json() as any;
      expect(view.messages.map((m: any) => m.from)).toEqual(['YOU', 'TEAM']);
      expect(JSON.stringify(view)).not.toMatch(/eth|authorId|caseId|hash/i);
      const rep = await w.anon('POST', `/public/${TOKEN}/track/reply`, { code, text: 'Site 4, last quarter.' });
      expect(rep.status).toBe(200);
      expect((await rep.json() as any).messages).toHaveLength(3);
      const staff = await (await w.as('eth', 'GET', `/reports/${id}`)).json() as any;
      expect(staff.messages.map((m: any) => m.author)).toEqual(['REPORTER', 'STAFF', 'REPORTER']);
      expect(staff.awaitingStaff).toBe(true);
    });

    it('only an ethics officer of the same organisation can read or triage: not an admin, not a manager, not another tenant', async () => {
      const w = await world(await make());
      await w.file();
      const id = (await (await w.as('eth', 'GET', '/reports')).json() as any[])[0].id;
      for (const who of ['hrm', 'adm']) {
        for (const [m, p, b] of [['GET', '/reports'], ['GET', `/reports/${id}`], ['POST', `/reports/${id}/reply`, { text: 'hello' }], ['POST', `/reports/${id}/dismiss`, { note: 'no basis found' }], ['POST', `/reports/${id}/convert`, { caseType: 'hr.misconduct', fields: {} }]] as const) {
          expect((await w.as(who, m, p, b)).status, `${who} ${m} ${p}`).toBe(403);
        }
      }
      expect((await w.as('eth2', 'GET', `/reports/${id}`)).status).toBe(404);
      expect(await (await w.as('eth2', 'GET', '/reports')).json()).toEqual([]);
      expect((await w.anon('GET', '/reports')).status).toBe(401);
    });

    it('converts a report to a case once, marks the case as coming from the anonymous portal, and tells the reporter only "accepted"', async () => {
      const w = await world(await make());
      const { code } = await w.file({ category: 'HR', language: 'en', text: TEXT });
      const id = (await (await w.as('eth', 'GET', '/reports')).json() as any[])[0].id;
      const r = await w.as('eth', 'POST', `/reports/${id}/convert`, { caseType: 'hr.misconduct', fields: { allegationSummary: 'Falsified delivery sign-offs' } });
      expect(r.status).toBe(200);
      const out = await r.json() as any;
      expect(out.status).toBe('CONVERTED'); expect(out.caseId).toMatch(/^HR-R-/);
      const c = await (await w.as('eth', 'GET', `/cases/${out.caseId}`)).json() as any;
      expect(c.case.fields.reporterChannel).toBe('ANONYMOUS_PORTAL');
      expect((await w.as('eth', 'POST', `/reports/${id}/convert`, { caseType: 'hr.misconduct', fields: {} })).status).toBe(409);
      const view = await (await w.anon('POST', `/public/${TOKEN}/track`, { code })).json() as any;
      expect(view.status).toBe('ACCEPTED');
      expect(JSON.stringify(view)).not.toContain(out.caseId);
      expect((await w.as('eth', 'POST', `/reports/${id}/dismiss`, { note: 'changed my mind about this' })).status).toBe(403);
    });

    it('dismissing needs a reason, the reporter sees "closed", and a reply reopens it', async () => {
      const w = await world(await make());
      const { code } = await w.file();
      const id = (await (await w.as('eth', 'GET', '/reports')).json() as any[])[0].id;
      expect((await w.as('eth', 'POST', `/reports/${id}/dismiss`, { note: '' })).status).toBe(400);
      expect((await w.as('eth', 'POST', `/reports/${id}/dismiss`, { note: 'Duplicate of an existing matter' })).status).toBe(200);
      expect(((await (await w.anon('POST', `/public/${TOKEN}/track`, { code })).json()) as any).status).toBe('CLOSED');
      await w.anon('POST', `/public/${TOKEN}/track/reply`, { code, text: 'You missed the second half.' });
      expect((await (await w.as('eth', 'GET', `/reports/${id}`)).json() as any).status).toBe('UNTRIAGED');
    });

    it('notifies ethics officers of the right tenant, with no content, and the mail links to the report', async () => {
      const w = await world(await make());
      const { code } = await w.file();
      await w.anon('POST', `/public/${TOKEN}/track/reply`, { code, text: 'more detail' });
      const mine = await (await w.as('eth', 'GET', '/notifications')).json() as any;
      const items = Array.isArray(mine) ? mine : mine.items;
      expect(items.map((n: any) => n.kind).sort()).toEqual(['REPORT_NEW', 'REPORT_REPLY']);
      expect(JSON.stringify(items)).not.toContain('warehouse');
      expect(await (await w.as('eth2', 'GET', '/notifications')).json()).toSatisfy((x: any) => (Array.isArray(x) ? x : x.items).length === 0);
      const mail = composeMail({ ...items[0], emailedAt: null } as any, { id: 'eth', email: 'e@x.sa' } as any, 'https://app.example');
      expect(mail.text).toContain('https://app.example/#/reports/');
      expect(mail.text).not.toContain('warehouse');
    });

    it('flags a report whose reporter has been waiting, once', async () => {
      const w = await world(await make());
      await w.as('eth', 'GET', '/reports'); await w.as('eth', 'GET', '/notifications'); // the officer has signed in, so the directory knows them
      await w.file();
      const before = await deadlineAlerts(w.repo, NOW.v);
      const later = '2026-11-15T05:00:00.000Z';
      await deadlineAlerts(w.repo, later); const again = await deadlineAlerts(w.repo, later);
      const n = await (await w.as('eth', 'GET', '/notifications')).json() as any;
      const kinds = (Array.isArray(n) ? n : n.items).map((x: any) => x.kind).filter((k: string) => k === 'REPORT_STALE');
      expect(before).toBeDefined(); expect(again).toBeDefined();
      expect(kinds).toHaveLength(1);
    });

    it('limits one source, then the whole channel, and the counters do not carry a recognisable address', async () => {
      const w = await world(await make(), { limits: { createPerSourceHour: 2, createPerChannelHour: 3 } });
      expect((await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'HR', language: 'en', text: TEXT })).status).toBe(201);
      expect((await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'HR', language: 'en', text: TEXT })).status).toBe(201);
      const third = await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'HR', language: 'en', text: TEXT });
      expect(third.status).toBe(429); expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
      w.ip.v = '10.0.0.2';
      expect((await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'HR', language: 'en', text: TEXT })).status).toBe(201);
      w.ip.v = '10.0.0.3';
      expect((await w.anon('POST', `/public/${TOKEN}/reports`, { category: 'HR', language: 'en', text: TEXT })).status).toBe(429); // channel breaker
      // nothing the reporter did is stored beside the report
      const row = JSON.stringify(await w.repo.reportTx('t1', (tx) => tx.list()));
      expect(row).not.toMatch(/10\.0\.0|user-agent|mozilla/i);
    });

    it('administrators create channels, the token is 22 URL-safe characters, and a retired channel stops accepting reports', async () => {
      const w = await world(await make());
      expect((await w.as('eth', 'POST', '/report-channels', { labelAr: 'مدخل', labelEn: 'Entrance' })).status).toBe(403);
      const made = await w.as('adm', 'POST', '/report-channels', { labelAr: 'مدخل المبنى', labelEn: 'Main entrance' });
      expect(made.status).toBe(201);
      const ch = await made.json() as any;
      expect(ch.token).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(ch.path).toBe(`/r/${ch.token}`);
      expect((await w.anon('GET', `/public/${ch.token}`)).status).toBe(200);
      expect((await w.as('adm', 'POST', '/report-channels', { labelAr: '', labelEn: 'x' })).status).toBe(400);
      expect((await w.as('adm', 'PATCH', `/report-channels/${ch.id}`, { active: false })).status).toBe(200);
      expect((await w.anon('GET', `/public/${ch.token}`)).status).toBe(404);
      expect((await w.as('adm', 'GET', '/report-channels')).status).toBe(200);
    });

    it('the public routes are the only ones that skip sign-in', async () => {
      const w = await world(await make());
      for (const [m, p] of ([['GET', '/cases'], ['GET', '/reports'], ['GET', '/report-channels'], ['POST', '/cases'], ['GET', '/notifications']] as [string, string][])) expect((await w.anon(m, p)).status).toBe(401);
    });
  });
}

suite('Report & Track API (memory, encrypted)', async () => new EncryptedRepo(new MemoryRepo(), new DataCrypto(mkMaster(), new MemoryRepo())));

describe.skipIf(!PG_ENABLED)('Report & Track API (Postgres, encrypted)', () => {
  beforeAll(freshDatabase);
  suite('on Postgres', async () => { await resetData(); const inner = await newRepo(); return new EncryptedRepo(inner, new DataCrypto(mkMaster(), inner)); });
});
