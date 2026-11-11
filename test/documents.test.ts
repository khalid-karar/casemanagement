import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { TEST_USERS, asPrincipal } from '../src/api/test-users';

const now = '2026-11-10T08:00:00.000Z';
const PDF = new Uint8Array(readFileSync(new URL('./fixtures/law-en-digital.pdf', import.meta.url)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const build = () => {
  const d = new Directory();
  TEST_USERS.forEach((u) => d.add(asPrincipal(u)));
  return createApp({ repo: new MemoryRepo(), directory: d, clock: () => now });
};
type App = ReturnType<typeof build>;
const auth = (who: string) => ({ authorization: `Bearer dev:${who}` });
const json = (app: App, who: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...auth(who), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const upload = (app: App, who: string, caseId: string, bytes: Uint8Array, name = 'f.pdf', type = 'findings_report') => {
  const fd = new FormData();
  fd.set('file', new File([bytes], name));
  fd.set('type', type);
  return app.request(`/cases/${caseId}/documents`, { method: 'POST', headers: auth(who), body: fd });
};
async function world() {
  const app = build();
  await json(app, 'a-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x' } });
  await json(app, 'b-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'B' } });
  return app;
}

describe('orphaned bytes', () => {
  it('are never served: a download needs an artifact on the case that references the hash', async () => {
    const d = new Directory(); TEST_USERS.forEach((u) => d.add(asPrincipal(u)));
    const repo = new MemoryRepo();
    const app = createApp({ repo, directory: d, clock: () => now });
    await json(app, 'a-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: {} });
    // bytes stored (e.g. an upload whose artifact step failed) but no artifact references them
    await repo.putCaseDocument('tenant-a', 'HR-1', { sha256: sha(PDF), name: 'o.pdf', mime: 'application/pdf', bytes: PDF, uploadedBy: 'x', uploadedAt: now });
    expect((await app.request(`/cases/HR-1/documents/${sha(PDF)}`, { headers: auth('a-hr-mgr') })).status).toBe(404);
  });
});

describe('case documents', () => {
  it('stores the bytes under their SHA-256, adds the artifact carrying that hash, and returns identical bytes', async () => {
    const app = await world();
    const r = await upload(app, 'a-hr-mgr', 'HR-1', PDF);
    expect(r.status).toBe(201);
    const body = await r.json() as any;
    expect(body.sha256).toBe(sha(PDF));
    const art = body.case.artifacts.find((a: any) => a.id === body.artifactId);
    expect(art).toMatchObject({ type: 'findings_report', hash: sha(PDF), payload: { name: 'f.pdf', mime: 'application/pdf', size: PDF.byteLength } });
    const dl = await app.request(`/cases/HR-1/documents/${body.sha256}`, { headers: auth('a-hr-mgr') });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(dl.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF);
  });

  it('decides the type from the bytes: HTML named .pdf is served as plain-text attachment, never as HTML', async () => {
    const app = await world();
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const body = await (await upload(app, 'a-hr-mgr', 'HR-1', html, 'evil.pdf', 'evidence')).json() as any;
    const dl = await app.request(`/cases/HR-1/documents/${body.sha256}`, { headers: auth('a-hr-mgr') });
    expect(dl.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses binaries, empty files, a missing file and a bad artifact type; strips paths from names', async () => {
    const app = await world();
    expect((await upload(app, 'a-hr-mgr', 'HR-1', new Uint8Array([0x4d, 0x5a, 0, 0, 1, 2]), 'x.exe')).status).toBe(400);
    expect((await upload(app, 'a-hr-mgr', 'HR-1', new Uint8Array(0))).status).toBe(400);
    expect((await upload(app, 'a-hr-mgr', 'HR-1', PDF, 'f.pdf', 'Bad Type!')).status).toBe(400);
    const noFile = new FormData(); noFile.set('type', 'evidence');
    expect((await app.request('/cases/HR-1/documents', { method: 'POST', headers: auth('a-hr-mgr'), body: noFile })).status).toBe(400);
    const r = await (await upload(app, 'a-hr-mgr', 'HR-1', PDF, '..\\..\\etc/passwd<>.pdf')).json() as any;
    expect(r.case.artifacts.at(-1).payload.name).not.toMatch(/[\\/<>]/);
  });

  it('applies every wall: other tenant, other department, low clearance, and a hash the case does not reference', async () => {
    const app = await world();
    const { sha256 } = await (await upload(app, 'a-hr-mgr', 'HR-1', PDF)).json() as any;
    const get = (who: string, id = 'HR-1', h = sha256) => app.request(`/cases/${id}/documents/${h}`, { headers: auth(who) });
    expect((await get('b-hr-mgr')).status).toBe(404);          // same case id, other tenant: nothing stored there
    expect((await get('a-sec-mgr')).status).toBe(404);          // other department
    expect((await get('a-low')).status).toBe(404);              // insufficient clearance
    expect((await get('a-hr-mgr', 'HR-1', 'f'.repeat(64))).status).toBe(404);
    expect((await get('a-hr-mgr', 'HR-1', 'nothex')).status).toBe(404);
    expect((await upload(app, 'a-sec-mgr', 'HR-1', PDF)).status).toBe(404);
    expect((await upload(app, 'b-hr-mgr', 'HR-1', PDF, 'b.pdf')).status).toBe(201); // B's own HR-1 is a different case
  });

  it('keeps document bytes out of audit read-across', async () => {
    const app = await world();
    const { sha256 } = await (await upload(app, 'a-hr-mgr', 'HR-1', PDF)).json() as any;
    expect((await json(app, 'a-assurance', 'GET', '/cases/HR-1')).status).toBe(200); // the redacted case is readable
    expect((await app.request(`/cases/HR-1/documents/${sha256}`, { headers: auth('a-assurance') })).status).toBe(404); // the bytes are not
  });

  it('does not store the same artifact twice, and counts uploads as heavy requests', async () => {
    const app = build();
    await json(app, 'a-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: {} });
    expect((await upload(app, 'a-hr-mgr', 'HR-1', PDF)).status).toBe(201);
    expect((await upload(app, 'a-hr-mgr', 'HR-1', PDF)).status).not.toBe(201);
    const limited = createApp({ repo: new MemoryRepo(), directory: (() => { const d = new Directory(); TEST_USERS.forEach((u) => d.add(asPrincipal(u))); return d; })(), clock: () => now, limits: { heavyPerMinute: 2 } });
    await json(limited, 'a-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: {} });
    const codes = [] as number[];
    for (const n of ['a', 'b', 'c']) codes.push((await upload(limited, 'a-hr-mgr', 'HR-1', new TextEncoder().encode('doc ' + n), n + '.txt', 'evidence_' + n)).status);
    expect(codes).toEqual([201, 201, 429]);
  });
});
