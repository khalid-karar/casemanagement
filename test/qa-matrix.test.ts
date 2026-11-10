import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { TEST_USERS, asPrincipal } from '../src/api/test-users';

/**
 * Executable form of docs/handoff/QA-TEST-PLAN.md section "Access walls". The QA team re-proves each
 * of these by hand and through real sign-in; this keeps the expected results in the plan honest.
 * Every expectation here uses the accounts in src/api/test-users.ts, which also drive the QA realm.
 */
const build = () => {
  const d = new Directory();
  for (const u of TEST_USERS) d.add(asPrincipal(u));
  return createApp({ repo: new MemoryRepo(), directory: d, clock: () => '2026-11-10T08:00:00.000Z' });
};
type App = ReturnType<typeof build>;
const call = (app: App, who: string | null, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...(who ? { authorization: `Bearer dev:${who}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const json = async (r: Response) => r.json() as Promise<any>;

async function world() {
  const app = build();
  const make = async (who: string, body: object) => expect((await call(app, who, 'POST', '/cases', body)).status).toBe(201);
  await make('a-hr-mgr', {
    id: 'HR-1', caseType: 'hr.misconduct',
    fields: { allegationSummary: 'x', severity: 'HIGH', reporterIdentity: 'emp-9002', subjectEmployee: 'emp-1' },
    parties: [{ personId: 'emp-9002', role: 'REPORTER', reportsTo: [], sealed: true }, { personId: 'emp-1', role: 'SUBJECT', reportsTo: [] }],
  });
  await make('a-sec-mgr', { id: 'SEC-1', caseType: 'security.incident', fields: { narrative: 'n', severity: 'LOW' } });
  await make('a-counsel', { id: 'm-1', caseType: 'legal.matter', fields: { title: 'matter one' } });
  await make('a-counsel', { id: 'm-2', caseType: 'legal.matter', fields: { title: 'matter two' } });
  await make('b-hr-mgr', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'B’s own', severity: 'LOW' } });
  await make('b-counsel', { id: 'm-1', caseType: 'legal.matter', fields: { title: 'B matter' } });
  return app;
}
const ids = async (app: App, who: string) => (await json(await call(app, who, 'GET', '/cases'))).map((c: any) => c.id).sort();

describe('tenant wall', () => {
  it('shows tenant-b nothing of tenant-a, even to its most privileged user, and answers 404 not 403', async () => {
    const app = await world();
    for (const who of ['b-hr-mgr', 'b-counsel']) {
      expect((await call(app, who, 'GET', '/cases/SEC-1')).status).toBe(404);
      expect((await call(app, who, 'GET', '/cases/m-2')).status).toBe(404);
    }
    expect(await ids(app, 'b-counsel')).toEqual(['m-1']);
    expect(await ids(app, 'b-hr-mgr')).toEqual(['HR-1']);
  });
  it('lets the same case id exist in both tenants without collision, each seeing its own', async () => {
    const app = await world();
    expect((await json(await call(app, 'a-hr-mgr', 'GET', '/cases/HR-1'))).case.fields.allegationSummary).toBe('x');
    expect((await json(await call(app, 'b-hr-mgr', 'GET', '/cases/HR-1'))).case.fields.allegationSummary).toBe('B’s own');
  });
  it('does not let tenant-b’s admin touch tenant-a’s AI settings or log', async () => {
    const app = await world();
    expect((await call(app, 'a-hr-mgr', 'GET', '/ai/log')).status).toBe(403);
    expect((await call(app, 'p-editor', 'GET', '/ai/log')).status).toBe(403);
    expect((await json(await call(app, 'b-admin', 'GET', '/ai/log'))).every((e: any) => e.data?.tenant !== 'tenant-a')).toBe(true);
  });
});

describe('department wall and read-across', () => {
  it('hides other departments’ cases from a manager with the same clearance', async () => {
    const app = await world();
    expect((await call(app, 'a-sec-mgr', 'GET', '/cases/HR-1')).status).toBe(404);
    expect((await call(app, 'a-hr-mgr', 'GET', '/cases/SEC-1')).status).toBe(404);
    expect(await ids(app, 'a-hr-mgr')).toEqual(['HR-1']);
  });
  it('lets audit assurance READ across departments, redacted, but never write or act', async () => {
    const app = await world();
    const r = await call(app, 'a-assurance', 'GET', '/cases/HR-1');
    expect(r.status).toBe(200);
    const c = (await json(r)).case;
    expect(c.fields.reporterIdentity).toBe('[REDACTED]');
    expect(c.fields.subjectEmployee).toBe('[REDACTED]');
    expect(c.parties.some((p: any) => p.sealed)).toBe(false);
    expect((await call(app, 'a-assurance', 'PATCH', '/cases/HR-1/fields', { severity: 'LOW' })).status).toBe(404);
    expect((await call(app, 'a-assurance', 'POST', '/cases/HR-1/transitions/triage')).status).toBe(404);
  });
});

describe('privilege wall and clearance', () => {
  it('keeps PRIVILEGED legal matters from every non-legal user, including assurance and directors', async () => {
    const app = await world();
    for (const who of ['a-hr-mgr', 'a-aud-dir', 'a-assurance', 'a-sec-mgr']) {
      expect((await call(app, who, 'GET', '/cases/m-1')).status).toBe(404);
      expect(await ids(app, who)).not.toContain('m-1');
    }
    expect((await call(app, 'a-counsel', 'GET', '/cases/m-1')).status).toBe(200);
  });
  it('refuses a STANDARD-clearance user a RESTRICTED case in their own department', async () => {
    const app = await world();
    expect((await call(app, 'a-low', 'GET', '/cases/HR-1')).status).toBe(404);
    expect(await ids(app, 'a-low')).toEqual([]);
  });
});

describe('sealed reporter identity', () => {
  it('is redacted for the HR manager and visible only to the ethics officer', async () => {
    const app = await world();
    const mgr = (await json(await call(app, 'a-hr-mgr', 'GET', '/cases/HR-1'))).case;
    expect(mgr.fields.reporterIdentity).toBe('[REDACTED]');
    expect(mgr.parties.map((p: any) => p.personId)).toEqual(['emp-1']);
    const eth = (await json(await call(app, 'a-ethics', 'GET', '/cases/HR-1'))).case;
    expect(eth.fields.reporterIdentity).toBe('emp-9002');
    expect(eth.parties.map((p: any) => p.personId)).toContain('emp-9002');
  });
});

describe('sealed identity is not readable back from any write route', () => {
  // Regression: PATCH / transition / artifact / create once returned the stored case, unredacted.
  const sealedSeen = (c: any) => c.fields?.reporterIdentity !== '[REDACTED]' || (c.parties ?? []).some((p: any) => p.sealed);
  it('redacts the response of every route that returns a case', async () => {
    const app = await world();
    const responses = [
      await call(app, 'a-hr-mgr', 'PATCH', '/cases/HR-1/fields', {}),
      await call(app, 'a-hr-mgr', 'POST', '/cases/HR-1/transitions/triage'),
      await call(app, 'a-hr-mgr', 'POST', '/cases/HR-1/artifacts', { id: 'z', type: 'note' }),
      await call(app, 'a-hr-mgr', 'POST', '/cases/HR-1/actions', { id: 'act1', description: 'd' }),
      await call(app, 'a-hr-mgr', 'POST', '/cases', { id: 'HR-9', caseType: 'hr.misconduct', fields: { allegationSummary: 'y', reporterIdentity: 'emp-5' }, parties: [{ personId: 'emp-5', role: 'REPORTER', reportsTo: [], sealed: true }] }),
    ];
    for (const r of responses) {
      expect([200, 201, 409]).toContain(r.status);
      if (r.status !== 409) expect(sealedSeen(await json(r))).toBe(false);
    }
  });
  it('still shows the identity to the ethics officer on a write response', async () => {
    const app = await world();
    const r = await json(await call(app, 'a-ethics', 'PATCH', '/cases/HR-1/fields', {}));
    expect(r.fields.reporterIdentity).toBe('emp-9002');
  });
  it('does not store the redaction marker back over the real value', async () => {
    const app = await world();
    await call(app, 'a-hr-mgr', 'PATCH', '/cases/HR-1/fields', { severity: 'LOW' });
    expect((await json(await call(app, 'a-ethics', 'GET', '/cases/HR-1'))).case.fields.reporterIdentity).toBe('emp-9002');
  });
});

describe('external counsel', () => {
  it('reaches only their instructed matter, in their own tenant, and cannot move it', async () => {
    const app = await world();
    expect((await call(app, 'a-ext-counsel', 'GET', '/cases/m-1')).status).toBe(200);
    expect((await call(app, 'a-ext-counsel', 'GET', '/cases/m-2')).status).toBe(404);
    expect((await call(app, 'a-ext-counsel', 'GET', '/cases/HR-1')).status).toBe(404);
    expect(await ids(app, 'a-ext-counsel')).toEqual(['m-1']);
    expect((await call(app, 'a-ext-counsel', 'POST', '/cases/m-1/transitions/assign_counsel')).status).toBe(404);
    // They can see m-1, so a refused ACTION on it is 403 (nothing to hide); a matter they cannot see is 404.
    expect((await call(app, 'a-ext-counsel', 'POST', '/cases/m-1/legal-hold', { reason: 'x' })).status).toBe(403);
  });
});

describe('separation of duties', () => {
  it('stops the investigator and the intake clerk deciding, and the manager deciding without the director', async () => {
    const app = await world();
    // An approval names a role; only a holder of that role may record it. 403 = visible case, refused action.
    for (const who of ['a-hr-inv', 'a-hr-intake', 'a-hr-mgr']) {
      expect((await call(app, who, 'POST', '/cases/HR-1/approvals', { role: 'hr_director' })).status).toBe(403);
    }
    expect((await call(app, 'a-hr-dir', 'POST', '/cases/HR-1/approvals', { role: 'hr_director' })).status).toBe(200);
  });
});

describe('four-eyes on national law', () => {
  it('refuses a client user, an editor verifying, and the same person uploading and verifying', async () => {
    const app = await world();
    await call(app, 'p-editor', 'POST', '/laws/instruments', { id: 'L', tenantId: null, kind: 'LAW', titleAr: 'نظام', issuer: 'x' });
    expect((await call(app, 'p-editor', 'POST', '/laws/versions', { id: 'L1', instrumentId: 'L', versionLabel: 'v1', effectiveFrom: '2025-01-01', rawText: 'المادة 1\nنص المادة الأولى كاملاً هنا.' })).status).toBe(201);
    expect((await call(app, 'p-editor', 'POST', '/laws/versions/L1/verify', { note: 'self' })).status).toBe(403);
    expect((await call(app, 'a-hr-mgr', 'POST', '/laws/versions/L1/verify', { note: 'client' })).status).toBe(403);
    expect((await call(app, 'p-verifier', 'POST', '/laws/versions/L1/verify', { note: 'ok' })).status).toBe(200);
  });
  it('shows a client only VERIFIED law, never a draft', async () => {
    const app = await world();
    await call(app, 'p-editor', 'POST', '/laws/instruments', { id: 'L', tenantId: null, kind: 'LAW', titleAr: 'نظام', issuer: 'x' });
    await call(app, 'p-editor', 'POST', '/laws/versions', { id: 'L1', instrumentId: 'L', versionLabel: 'v1', effectiveFrom: '2025-01-01', rawText: 'المادة 1\nنص المادة الأولى كاملاً هنا.' });
    expect(await json(await call(app, 'a-hr-mgr', 'GET', '/laws'))).toEqual([]);
    await call(app, 'p-verifier', 'POST', '/laws/versions/L1/verify', { note: 'ok' });
    expect((await json(await call(app, 'a-hr-mgr', 'GET', '/laws'))).length).toBe(1);
  });
});
