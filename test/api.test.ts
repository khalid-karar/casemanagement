import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import type { Repo } from '../src/api/repo';
import { PG_ENABLED, freshDatabase, newRepo, resetData } from './helpers/pg';
import type { ChatProvider } from '../src/ai';

const T1 = '00000000-0000-0000-0000-000000000001';
const T2 = '00000000-0000-0000-0000-000000000002';
const provider: ChatProvider = { model: 't', complete: async () => 'draft' };
async function build0(repo: Repo) {
  const d = new Directory();
  const mk = (id: string, departments: any, roles: string[], tenantId = T1, clearance: any = 'RESTRICTED') =>
    d.add({ id, name: id, kind: 'human', tenantId, departments, roles, reportsTo: [], clearance });
  mk('mgr', ['HR'], ['hr_intake', 'hr_manager']);
  mk('other-tenant', ['HR'], ['hr_manager'], T2);
  mk('sec', ['SECURITY'], ['security_manager']);
  mk('editor', ['LEGAL'], ['legal_content_editor'], 'platform');
  mk('verifier', ['LEGAL'], ['legal_verifier'], 'platform');
  return createApp({ repo, directory: d, provider, clock: () => '2026-11-10T08:00:00.000Z' });
}
const call = (app: Awaited<ReturnType<typeof build0>>, who: string | null, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...(who ? { authorization: `Bearer dev:${who}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });


const backends: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => new MemoryRepo()],
  ...(PG_ENABLED ? [['postgres', async () => { await resetData(); return newRepo(); }] as [string, () => Promise<Repo>]] : []),
];
import { beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { ocrAvailable } from '../src/legal/ocr';
beforeAll(async () => { if (PG_ENABLED) await freshDatabase(); });

describe.each(backends)('API on %s', (_name, mk) => {
  const build = async () => build0(await mk());
  it('rejects unauthenticated requests', async () => {
    expect((await call(await build(), null, 'GET', '/cases')).status).toBe(401);
  });
  it('defaults to Arabic and returns English on request', async () => {
    const app = await build();
    expect((await call(app, null, 'GET', '/cases')).headers.get('content-language')).toBe('ar');
    expect((await call(app, null, 'GET', '/cases?lang=en')).headers.get('content-language')).toBe('en');
  });
  it('creates a case, reports blockers in Arabic, and enforces transitions', async () => {
    const app = await build();
    expect((await call(app, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } })).status).toBe(201);
    const blocked = await call(app, 'mgr', 'POST', '/cases/c1/transitions/triage'); // no severity
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as any;
    expect(body.blockers[0].message).toMatch(/[؀-ۿ]/);
    await call(app, 'mgr', 'PATCH', '/cases/c1/fields', { severity: 'HIGH' });
    expect((await call(app, 'mgr', 'POST', '/cases/c1/transitions/triage')).status).toBe(200);
  });
  it('hides cases across tenants and departments as 404', async () => {
    const app = await build();
    await call(app, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: {} });
    expect((await call(app, 'other-tenant', 'GET', '/cases/c1')).status).toBe(404);
    expect((await call(app, 'sec', 'GET', '/cases/c1')).status).toBe(404);
    expect(((await (await call(app, 'sec', 'GET', '/cases')).json()) as any[]).length).toBe(0);
  });
  it('exposes a verifiable audit chain', async () => {
    const app = await build();
    await call(app, 'mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: {} });
    const a = (await (await call(app, 'mgr', 'GET', '/cases/c1/audit')).json()) as any;
    expect(a.integrity.valid).toBe(true);
    expect(a.events.length).toBe(1);
  });
  it('runs law upload → verify end-to-end with dual control', async () => {
    const app = await build();
    await call(app, 'editor', 'POST', '/laws/instruments', { id: 'labour', tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', issuer: 'MHRSD' });
    const up = await call(app, 'editor', 'POST', '/laws/versions', { id: 'v1', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: 'المادة 71\nنص المادة' });
    expect(up.status).toBe(201);
    expect((await call(app, 'editor', 'POST', '/laws/versions/v1/verify', { note: 'x' })).status).toBe(403);
    expect(((await (await call(app, 'mgr', 'GET', '/laws')).json()) as any[]).length).toBe(0);
    expect((await call(app, 'verifier', 'POST', '/laws/versions/v1/verify', { note: 'ok' })).status).toBe(200);
    expect(((await (await call(app, 'mgr', 'GET', '/laws')).json()) as any[]).length).toBe(1);
  });
  it('does not leak internals on bad input', async () => {
    const app = await build();
    const r = await app.request('/cases', { method: 'POST', headers: { authorization: 'Bearer dev:mgr', 'content-type': 'application/json' }, body: '{bad' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).not.toMatch(/Syntax|at /);
  });
});

describe('API file upload', () => {
  it('OCRs an Arabic PDF end to end and tells the reviewer it was OCR', async () => {
    if (!(await ocrAvailable())) return;
    const app = await build0(new MemoryRepo());
    const fd = new FormData();
    fd.append('file', new File([readFileSync(new URL('./fixtures/law-ar-digital.pdf', import.meta.url))], 'law.pdf', { type: 'application/pdf' }));
    const r = await app.request('/laws/files', { method: 'POST', headers: { authorization: 'Bearer dev:editor' }, body: fd });
    const j = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(j.method).toBe('ocr');
    expect(j.text).toContain('لا يجوز توقيع جزاء');
    expect(j.warnings[0]).toMatch(/^OCR_USED/);
    const denied = await app.request('/laws/files', { method: 'POST', headers: { authorization: 'Bearer dev:mgr' }, body: fd });
    expect(denied.status).toBe(403);
  });
});

describe.each(backends)('API legal readiness on %s', (_name, mk) => {
  const build = async () => build0(await mk());
  it('exposes per-case-type legal status', async () => {
    const app = await build();
    const r = (await (await call(app, 'mgr', 'GET', '/case-types')).json()) as any[];
    expect(r.find((x) => x.key === 'hr.misconduct').legal.status).toBe('NEEDS_COUNSEL');
    expect(r.find((x) => x.key === 'security.incident').legal.status).toBe('NO_STATUTORY_RULES_MAPPED');
  });
});
