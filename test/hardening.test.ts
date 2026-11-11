import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { TEST_USERS, asPrincipal } from '../src/api/test-users';
import { AccessDeniedError, FieldError, createCase, setFields } from '../src/engine';
import type { Actor } from '../src/engine';
import { hrMisconduct as hr } from '../src/case-types';

const T = 'tenant-a';
const now = '2026-11-10T08:00:00.000Z';
const actor = (roles: string[]): Actor => ({ id: 'u-' + roles[0], kind: 'human', tenantId: T, departments: ['HR'], roles, reportsTo: [], clearance: 'RESTRICTED' });
const mgr = actor(['hr_manager']);
const ethics = actor(['ethics_officer']);
const fresh = (fields: Record<string, unknown> = {}) => createCase(hr, { id: 'c1', fields }, mgr, now).case;
const problems = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof FieldError ? { kind: e.kind, codes: e.problems.map((p) => `${p.field}:${p.code}`) } : e; } return null; };

describe('field validation', () => {
  it('rejects unknown fields and wrong types, enums, dates and the redaction marker', () => {
    const c = fresh();
    expect(problems(() => setFields(c, { nope: 1 }, mgr, now, hr))).toEqual({ kind: 'VALIDATION', codes: ['nope:UNKNOWN_FIELD'] });
    expect(problems(() => setFields(c, { severity: 'EXTREME' }, mgr, now, hr))).toMatchObject({ codes: ['severity:NOT_AN_ALLOWED_OPTION'] });
    expect(problems(() => setFields(c, { incidentDate: '2026-02-31' }, mgr, now, hr))).toMatchObject({ codes: ['incidentDate:EXPECTED_DATE_YYYY_MM_DD'] });
    expect(problems(() => setFields(c, { incidentDate: '10/11/2026' }, mgr, now, hr))).toMatchObject({ kind: 'VALIDATION' });
    expect(problems(() => setFields(c, { allegationSummary: 5 }, mgr, now, hr))).toMatchObject({ codes: ['allegationSummary:EXPECTED_LONGTEXT'] });
    expect(problems(() => setFields(c, { allegationSummary: 'x'.repeat(20_001) }, mgr, now, hr))).toMatchObject({ kind: 'VALIDATION' });
    expect(problems(() => setFields(c, { subjectEmployee: '[REDACTED]' }, mgr, now, hr))).toMatchObject({ codes: ['subjectEmployee:REDACTED_MARKER'] });
    expect(setFields(c, { severity: 'HIGH', incidentDate: '2026-10-04' }, mgr, now, hr).case.fields).toMatchObject({ severity: 'HIGH' });
  });
  it('applies the same rules when a case is created, and to ids', () => {
    expect(problems(() => createCase(hr, { id: 'x', fields: { bogus: 1 } }, mgr, now))).toMatchObject({ kind: 'VALIDATION' });
    for (const id of ['', ' ', 'a b', '../x', '<script>', 'x'.repeat(65), 'é']) {
      expect(problems(() => createCase(hr, { id }, mgr, now)), JSON.stringify(id)).toMatchObject({ codes: ['id:INVALID_ID'] });
    }
    expect(createCase(hr, { id: 'HR-2026-001' }, mgr, now).case.id).toBe('HR-2026-001');
  });
});

describe('locks', () => {
  it('freezes every field once a case is closed or archived', () => {
    for (const state of ['CLOSED', 'ARCHIVED']) {
      const c = { ...fresh({ severity: 'LOW' }), state };
      expect(problems(() => setFields(c, { severity: 'HIGH' }, mgr, now, hr))).toEqual({ kind: 'LOCKED', codes: ['severity:CASE_CLOSED'] });
    }
  });
  it('freezes the decision fields at DECIDED, severity included, and a no-op is not a change', () => {
    const c = { ...fresh({ outcome: 'SUBSTANTIATED_PENALTY', penaltyType: 'WARNING', severity: 'LOW' }), state: 'DECIDED' };
    expect(problems(() => setFields(c, { penaltyType: 'DISMISSAL' }, mgr, now, hr))).toEqual({ kind: 'LOCKED', codes: ['penaltyType:FIELD_LOCKED_IN_STATE'] });
    expect(problems(() => setFields(c, { outcome: 'UNSUBSTANTIATED' }, mgr, now, hr))).toMatchObject({ kind: 'LOCKED' });
    // Art. 66: severity sets the lawful penalty ceiling, so it cannot be restated to fit the penalty.
    expect(problems(() => setFields(c, { severity: 'HIGH' }, mgr, now, hr))).toEqual({ kind: 'LOCKED', codes: ['severity:FIELD_LOCKED_IN_STATE'] });
    expect((setFields(c, { penaltyType: 'WARNING' }, mgr, now, hr).event.payload as any).changes).toEqual({}); // same value: nothing to lock or log
  });

  it('freezes each field from its own state onward, not all at once', () => {
    // The allegation is editable while the case is being worked, and fixed once findings are issued:
    // under Art. 71 the employee defends a specific allegation, which must not change afterwards.
    const triaged = { ...fresh({ allegationSummary: 'first draft' }), state: 'TRIAGED' };
    expect(setFields(triaged, { allegationSummary: 'corrected' }, mgr, now, hr).case.fields.allegationSummary).toBe('corrected');

    for (const state of ['FINDINGS_ISSUED', 'DECIDED', 'PENALTY_NOTIFIED']) {
      const c = { ...fresh({ allegationSummary: 'first draft' }), state };
      expect(problems(() => setFields(c, { allegationSummary: 'rewritten' }, mgr, now, hr)), state)
        .toEqual({ kind: 'LOCKED', codes: ['allegationSummary:FIELD_LOCKED_IN_STATE'] });
    }

    // The respondent is fixed at assignment: changing it would defeat the conflict-of-interest check
    // that ran there, and is a new case rather than an edit.
    const assigned = { ...fresh({ subjectEmployee: 'emp-1' }), state: 'ASSIGNED' };
    expect(problems(() => setFields(assigned, { subjectEmployee: 'emp-2' }, mgr, now, hr)))
      .toEqual({ kind: 'LOCKED', codes: ['subjectEmployee:FIELD_LOCKED_IN_STATE'] });
  });
});

describe('sealed fields are write-once for everyone without the sealed role', () => {
  it('lets intake record the reporter once, refuses a later replacement, allows the ethics officer', () => {
    let c = fresh();
    c = setFields(c, { reporterIdentity: 'emp-1' }, mgr, now, hr).case;
    expect(() => setFields(c, { reporterIdentity: 'emp-2' }, mgr, now, hr)).toThrow(AccessDeniedError);
    expect(c.fields.reporterIdentity).toBe('emp-1');
    expect(setFields(c, { reporterIdentity: 'emp-1' }, mgr, now, hr).case.fields.reporterIdentity).toBe('emp-1'); // unchanged: fine
    expect(setFields(c, { reporterIdentity: 'emp-3' }, ethics, now, hr).case.fields.reporterIdentity).toBe('emp-3');
  });
});

describe('audit records old and new values without copying secrets', () => {
  it('stores ordinary values in clear and personal and sealed values as SHA-256 only', () => {
    const c = fresh({ severity: 'LOW', subjectEmployee: 'emp-77', reporterIdentity: 'emp-9002' });
    const m = setFields(c, { severity: 'HIGH', subjectEmployee: 'emp-88', reporterIdentity: 'emp-9002' }, ethics, now, hr);
    const ch = (m.event.payload as any).changes;
    expect(ch.severity).toEqual({ from: 'LOW', to: 'HIGH' });
    expect(ch.subjectEmployee.fromSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.subjectEmployee.toSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.reporterIdentity).toBeUndefined(); // unchanged
    const text = JSON.stringify(m.event);
    for (const secret of ['emp-77', 'emp-88', 'emp-9002']) expect(text).not.toContain(secret);
  });
});

// ---- API ------------------------------------------------------------------------------------
const build = (extra: Partial<Parameters<typeof createApp>[0]> = {}) => {
  const d = new Directory();
  for (const u of TEST_USERS) d.add(asPrincipal(u));
  const repo = new MemoryRepo();
  return { repo, app: createApp({ repo, directory: d, clock: () => now, ...extra }) };
};
const call = (app: ReturnType<typeof build>['app'], who: string | null, method: string, path: string, body?: unknown, raw?: string) =>
  app.request(path, { method, headers: { ...(who ? { authorization: `Bearer dev:${who}` } : {}), 'content-type': 'application/json' }, ...(raw !== undefined ? { body: raw } : body ? { body: JSON.stringify(body) } : {}) });

describe('API field rules', () => {
  it('answers 400 with the offending fields, 400 for a bad id, and 409 for a locked field', async () => {
    const { app, repo } = build();
    expect((await call(app, 'a-hr-mgr', 'POST', '/cases', { id: 'HR-1', caseType: 'hr.misconduct', fields: { allegationSummary: 'x', severity: 'LOW' } })).status).toBe(201);
    const bad = await call(app, 'a-hr-mgr', 'PATCH', '/cases/HR-1/fields', { severity: 'EXTREME', nope: 1 });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).problems.map((p: any) => p.field).sort()).toEqual(['nope', 'severity']);
    expect((await call(app, 'a-hr-mgr', 'POST', '/cases', { id: '../etc', caseType: 'hr.misconduct' })).status).toBe(400);
    expect((await call(app, 'a-hr-mgr', 'POST', '/cases/HR-1/artifacts', { id: '<b>', type: 'note' })).status).toBe(400);

    const cs = (await repo.tx(T, (tx) => tx.getCase('HR-1')))!;
    await repo.tx(T, (tx) => tx.saveCase({ ...cs, state: 'CLOSED' }, { caseId: 'HR-1', tenantId: T, type: 'test.closed', actorId: 'x', actorKind: 'human', at: now, payload: {} }));
    const locked = await call(app, 'a-hr-mgr', 'PATCH', '/cases/HR-1/fields', { severity: 'HIGH' });
    expect(locked.status).toBe(409);
    expect((await locked.json() as any).error).toBe('FIELD_LOCKED');
  });
  it('describes each case type\'s fields so the UI can send typed values', async () => {
    const { app } = build();
    const types = await (await call(app, 'a-hr-mgr', 'GET', '/case-types')).json() as any[];
    const f = types.find((t) => t.key === 'hr.misconduct').fields.find((x: any) => x.key === 'severity');
    expect(f).toMatchObject({ type: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] });
  });
});

describe('request limits', () => {
  it('rejects an oversized JSON body with 413 before parsing it', async () => {
    const { app } = build({ maxJsonBytes: 2000 });
    const r = await call(app, 'a-hr-mgr', 'POST', '/cases', undefined, JSON.stringify({ id: 'x', caseType: 'hr.misconduct', fields: { allegationSummary: 'y'.repeat(5000) } }));
    expect(r.status).toBe(413);
    expect((await r.json() as any).error).toBe('PAYLOAD_TOO_LARGE');
  });
  it('limits each signed-in account separately and tells it when to retry', async () => {
    const { app } = build({ limits: { perMinute: 3, heavyPerMinute: 2 } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(app, 'a-hr-mgr', 'GET', '/cases')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await call(app, 'a-hr-mgr', 'GET', '/cases');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call(app, 'b-hr-mgr', 'GET', '/cases')).status).toBe(200); // another account, another tenant: unaffected
  });
  it('applies a stricter limit to AI and upload routes', async () => {
    const { app } = build({ limits: { perMinute: 100, heavyPerMinute: 2 } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call(app, 'a-hr-mgr', 'POST', '/ai/laws', { question: 'q' })).status);
    expect(codes).toEqual([503, 503, 429, 429]); // 503 = AI not enabled for the tenant; the limiter counts the attempt anyway
    expect((await call(app, 'a-hr-mgr', 'GET', '/cases')).status).toBe(200); // general traffic is a separate budget
  });
  it('does not rate-limit by anything the caller controls (no header trick)', async () => {
    const { app } = build({ limits: { perMinute: 2 } });
    const hit = () => app.request('/cases', { headers: { authorization: 'Bearer dev:a-hr-mgr', 'x-forwarded-for': String(Math.random()) } });
    expect([(await hit()).status, (await hit()).status, (await hit()).status]).toEqual([200, 200, 429]);
  });
});

describe('public surface', () => {
  it('exposes only liveness without sign-in, capability details only to the platform, and a CSP without unsafe-inline', async () => {
    const { app } = build();
    const h = await call(app, null, 'GET', '/health');
    expect(await h.json()).toEqual({ ok: true });
    expect((await call(app, null, 'GET', '/health/details')).status).toBe(401);
    expect((await call(app, 'a-hr-mgr', 'GET', '/health/details')).status).toBe(404);
    expect(await (await call(app, 'p-editor', 'GET', '/health/details')).json()).toMatchObject({ ok: true, ocr: expect.any(Boolean) });
    const csp = h.headers.get('content-security-policy')!;
    expect(csp).toContain("style-src 'self';");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });
});
