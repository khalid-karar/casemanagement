import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import { TEST_USERS, asPrincipal } from '../src/api/test-users';
import { SimulatedNajiz, simulatorRegistry } from '../src/najiz/simulator';
import { NajizError } from '../src/najiz/types';
import { najizFromEnv } from '../src/najiz/registry';

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 10, 8, 0, 0, ++tick)).toISOString(); // every call later than the last
const auth = (who: string) => ({ authorization: `Bearer dev:${who}` });

function build(sim = new SimulatedNajiz()) {
  const d = new Directory(); TEST_USERS.forEach((u) => d.add(asPrincipal(u)));
  const repo = new MemoryRepo();
  const reg = simulatorRegistry(sim);
  const app = createApp({ repo, directory: d, clock, najiz: reg });
  const j = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { ...auth(who), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const up = (who: string, id: string, type: string, bytes: Uint8Array, name = 'f.pdf') => {
    const fd = new FormData(); fd.set('file', new File([bytes], name)); fd.set('type', type);
    return app.request(`/cases/${id}/documents`, { method: 'POST', headers: auth(who), body: fd });
  };
  return { app, repo, sim, j, up };
}
type W = ReturnType<typeof build>;

/** A matter ready to file: counsel assigned, pre-action, legal hold, filing attached, forum set. */
async function ready(w: W, id = 'L-1', who = 'a-counsel') {
  expect((await w.j(who, 'POST', '/cases', { id, caseType: 'legal.matter', fields: { title: 'Claim X', forum: 'COMMERCIAL_COURT', claimValueSar: 50000 } })).status).toBe(201);
  await w.j(who, 'POST', `/cases/${id}/assignee`, { id: who, reportsTo: [] });
  expect((await w.j(who, 'POST', `/cases/${id}/transitions/assign_counsel`)).status).toBe(200);
  await w.j(who, 'POST', `/cases/${id}/legal-hold`, { reason: 'dispute' });
  expect((await w.j(who, 'POST', `/cases/${id}/transitions/begin_pre_action`)).status).toBe(200);
  expect((await w.up(who, id, 'filing', PDF, 'claim.pdf')).status).toBe(201);
}
const approve = (w: W, id = 'L-1', who = 'a-gc') => w.j(who, 'POST', `/cases/${id}/approvals`, { role: 'general_counsel' });
const submit = (w: W, id = 'L-1', who = 'a-counsel') => w.j(who, 'POST', `/cases/${id}/najiz/submit`);
const arts = async (w: W, id = 'L-1') => ((await (await w.j('a-counsel', 'GET', `/cases/${id}`)).json()) as any).case.artifacts as any[];

describe('Najiz submission rules', () => {
  it('needs a different general counsel to have approved; counsel cannot approve their own filing', async () => {
    const w = build(); await ready(w);
    let r = await submit(w); expect(r.status).toBe(409); expect(((await r.json()) as any).code).toBe('APPROVAL_REQUIRED');
    await approve(w, 'L-1', 'a-counsel'); // a-counsel also holds general_counsel but is the submitter
    r = await submit(w); expect(((await r.json()) as any).code).toBe('APPROVAL_REQUIRED');
    expect(w.sim.received).toHaveLength(0);
    await approve(w);
    r = await submit(w); expect(r.status).toBe(201);
    expect(w.sim.received).toHaveLength(1);
  });

  it('an approval covers one version: changing the filing or a failed attempt needs a fresh approval', async () => {
    const w = build(); await ready(w); await approve(w);
    await w.up('a-counsel', 'L-1', 'filing', new TextEncoder().encode('%PDF-1.4\nrevised\n%%EOF'), 'claim-v2.pdf'); // filing changed after approval
    const r = await submit(w); expect(((await r.json()) as any).code).toBe('APPROVAL_REQUIRED');
    await approve(w);
    w.sim.failNext(new NajizError('UNAVAILABLE'));
    expect((await submit(w)).status).toBe(503);
    expect(((await (await submit(w)).json()) as any).code).toBe('APPROVAL_REQUIRED'); // retry needs its own approval
  });

  it('only counsel may submit; the file prerequisites of the matter still apply', async () => {
    const w = build(); await ready(w); await approve(w);
    expect((await submit(w, 'L-1', 'a-gc')).status).toBe(403);
    const w2 = build();
    await w2.j('a-counsel', 'POST', '/cases', { id: 'L-2', caseType: 'legal.matter', fields: { title: 'T', forum: 'LABOUR_COURT' } });
    const r = await submit(w2, 'L-2'); expect(((await r.json()) as any).code).toBe('MATTER_NOT_IN_PRE_ACTION');
  });

  it('a labour claim cannot be sent before the amicable-settlement attempt is recorded', async () => {
    const w = build(); await ready(w, 'L-3');
    await w.j('a-counsel', 'PATCH', '/cases/L-3/fields', { forum: 'LABOUR_COURT' });
    await approve(w, 'L-3');
    const r = await submit(w, 'L-3'); const b = (await r.json()) as any;
    expect(b.code).toMatch(/^FILE_PREREQUISITES/);
    expect(w.sim.received).toHaveLength(0);
  });

  it('sends only the allowlisted packet: filing and exhibits, no other artifact, no other field', async () => {
    const w = build(); await ready(w);
    await w.j('a-counsel', 'POST', '/cases/L-1/artifacts', { id: 'advice-1', type: 'privileged_advice', hash: 'a'.repeat(64), payload: { secret: 'legal advice' } });
    await w.up('a-counsel', 'L-1', 'exhibit', new TextEncoder().encode('exhibit one'), 'ex1.txt');
    await w.up('a-counsel', 'L-1', 'internal_memo', new TextEncoder().encode('do not send'), 'memo.txt');
    await approve(w);
    expect((await submit(w)).status).toBe(201);
    const p = w.sim.received[0]!;
    expect(p.attachments.map((a) => a.name)).toEqual(['claim.pdf', 'ex1.txt']);
    expect(Object.keys(p).sort()).toEqual(['attachments', 'claimSubject', 'claimValueSar', 'forum', 'idempotencyKey', 'matterId', 'parties', 'title']);
    expect(JSON.stringify(p, (_, v) => (v instanceof Uint8Array ? '[bytes]' : v))).not.toMatch(/legal advice|do not send/);
  });

  it('the preview shows approvers what would be sent, without file bytes', async () => {
    const w = build(); await ready(w); await approve(w);
    const g = (await (await w.j('a-counsel', 'GET', '/cases/L-1/najiz')).json()) as any;
    expect(g).toMatchObject({ enabled: true, simulated: true, state: 'NOT_SUBMITTED', canSubmit: true });
    expect(g.preview.attachments[0]).toMatchObject({ name: 'claim.pdf' });
    expect(JSON.stringify(g)).not.toContain('bytes');
  });
});

describe('Najiz failure handling: a lawsuit filed twice cannot be undone', () => {
  it('a lost answer is UNCONFIRMED: never retried automatically, blocks resubmission until a person reconciles', async () => {
    const w = build(); await ready(w); await approve(w);
    w.sim.failNext(new NajizError('AMBIGUOUS')); // the simulator DID receive it, then "lost" the answer
    const r = await submit(w); expect(r.status).toBe(502);
    expect(((await r.json()) as any).outcome).toBe('UNCONFIRMED_RECONCILE_REQUIRED');
    expect(w.sim.received).toHaveLength(1);
    await approve(w);
    expect(((await (await submit(w)).json()) as any).code).toBe('ATTEMPT_UNCONFIRMED_RECONCILE_FIRST');
    expect(w.sim.received).toHaveLength(1);
    // only a general counsel can reconcile, and must give a reference when the filing did land
    expect((await w.j('a-hr-mgr', 'POST', '/cases/L-1/najiz/reconcile', { outcome: 'filed', najizRef: 'X-1' })).status).toBe(404);
    expect((await w.j('a-gc', 'POST', '/cases/L-1/najiz/reconcile', { outcome: 'filed' })).status).toBe(409);
    expect((await w.j('a-gc', 'POST', '/cases/L-1/najiz/reconcile', { outcome: 'filed', najizRef: 'SIM-REAL-1' })).status).toBe(200);
    const g = (await (await w.j('a-counsel', 'GET', '/cases/L-1/najiz')).json()) as any;
    expect(g).toMatchObject({ state: 'SUBMITTED', najizRef: 'SIM-REAL-1' });
  });

  it('reconciling as "not filed" allows a new, separately approved attempt with a different idempotency key', async () => {
    const w = build(); await ready(w); await approve(w);
    w.sim.failNext(new NajizError('AMBIGUOUS'));
    await submit(w);
    await w.j('a-gc', 'POST', '/cases/L-1/najiz/reconcile', { outcome: 'not_filed' });
    await approve(w);
    expect((await submit(w)).status).toBe(201);
    expect(w.sim.received).toHaveLength(2);
    expect(w.sim.received[0]!.idempotencyKey).not.toBe(w.sim.received[1]!.idempotencyKey);
  });

  it('a rejection is recorded with its reason and can be corrected and resubmitted; an unreachable service is safe to retry', async () => {
    const w = build(); await ready(w); await approve(w);
    w.sim.failNext(new NajizError('REJECTED', undefined, 'missing attachment'));
    const r = await submit(w); const b = (await r.json()) as any;
    expect(r.status).toBe(422); expect(b).toMatchObject({ outcome: 'REJECTED_CORRECT_AND_RESUBMIT', reason: 'missing attachment' });
    await approve(w); w.sim.failNext(new NajizError('UNAVAILABLE'));
    expect(((await (await submit(w)).json()) as any).outcome).toBe('NOT_SENT_SAFE_TO_RETRY');
    await approve(w);
    expect((await submit(w)).status).toBe(201);
    const types = (await arts(w)).map((a) => a.type);
    expect(types).toContain('najiz_filing_rejected'); expect(types).toContain('najiz_filing_not_sent'); expect(types).toContain('najiz_filing_result');
  });

  it('two submits at once cannot both send: the attempt is committed before the call', async () => {
    const w = build(); await ready(w); await approve(w);
    const slow = w.sim.submitFiling.bind(w.sim);
    w.sim.submitFiling = async (p) => { await new Promise((r) => setTimeout(r, 30)); return slow(p); };
    const [a, b] = await Promise.all([submit(w), submit(w)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(w.sim.received).toHaveLength(1);
  });

  it('a crash between commit and answer leaves the attempt IN_PROGRESS and blocks another', async () => {
    const w = build(); await ready(w); await approve(w);
    w.sim.submitFiling = async () => { throw new Error('process died'); };
    expect((await submit(w)).status).toBe(502); // unknown error is treated as ambiguous
    expect(((await (await w.j('a-counsel', 'GET', '/cases/L-1/najiz')).json()) as any).state).toBe('UNCONFIRMED');
  });
});

describe('Najiz sync', () => {
  it('imports hearings and the judgment as artifacts with their documents, idempotently, and never moves the case', async () => {
    const w = build(); await ready(w); await approve(w);
    const ref = ((await (await submit(w)).json()) as any).najizRef as string;
    w.sim.advance(ref); w.sim.advance(ref); w.sim.advance(ref);
    const s1 = (await (await w.j('a-counsel', 'POST', '/cases/L-1/najiz/sync')).json()) as any;
    expect(s1.imported).toBe(2);
    const types = s1.case.artifacts.map((a: any) => a.type);
    expect(types).toContain('hearing_record'); expect(types).toContain('judgment');
    expect(s1.case.state).toBe('PRE_ACTION'); // no automatic transition
    expect(s1.case.fields.courtCaseNumber).toMatch(/^SIM-CASE-/);
    const j = s1.case.artifacts.find((a: any) => a.type === 'judgment');
    const dl = await w.app.request(`/cases/L-1/documents/${j.hash}`, { headers: auth('a-counsel') });
    expect(dl.status).toBe(200); expect(await dl.text()).toContain('SIMULATED JUDGMENT');
    const s2 = (await (await w.j('a-counsel', 'POST', '/cases/L-1/najiz/sync')).json()) as any;
    expect(s2.imported).toBe(0);
    expect(s2.case.artifacts).toHaveLength(s1.case.artifacts.length);
  });

  it('does not overwrite a court case number counsel already recorded', async () => {
    const w = build(); await ready(w); await w.j('a-counsel', 'PATCH', '/cases/L-1/fields', { courtCaseNumber: 'REAL-123' }); await approve(w);
    const ref = ((await (await submit(w)).json()) as any).najizRef; w.sim.advance(ref);
    const s = (await (await w.j('a-counsel', 'POST', '/cases/L-1/najiz/sync')).json()) as any;
    expect(s.case.fields.courtCaseNumber).toBe('REAL-123');
  });

  it('needs a submitted filing and counsel role', async () => {
    const w = build(); await ready(w);
    expect(((await (await w.j('a-counsel', 'POST', '/cases/L-1/najiz/sync')).json()) as any).code).toBe('NOT_SUBMITTED');
    expect((await w.j('a-gc', 'POST', '/cases/L-1/najiz/sync')).status).toBe(403);
  });
});

describe('Najiz walls and switches', () => {
  it('is invisible across tenants and to people who cannot see the matter', async () => {
    const w = build(); await ready(w); await approve(w);
    for (const who of ['b-counsel', 'a-hr-mgr', 'a-aud-dir']) {
      for (const [m, p] of [['GET', '/cases/L-1/najiz'], ['POST', '/cases/L-1/najiz/submit'], ['POST', '/cases/L-1/najiz/sync']] as const) {
        expect((await w.j(who, m, p)).status, `${who} ${m} ${p}`).toBe(404);
      }
    }
  });

  it('external counsel (matter-scoped) cannot submit', async () => {
    const w = build();
    await w.j('a-counsel', 'POST', '/cases', { id: 'm-1', caseType: 'legal.matter', fields: { title: 'T', forum: 'OTHER' } });
    expect([403, 404]).toContain((await w.j('a-ext-counsel', 'POST', '/cases/m-1/najiz/submit')).status);
  });

  it('is off unless a gateway is configured, and the simulator is refused in production', async () => {
    const d = new Directory(); TEST_USERS.forEach((u) => d.add(asPrincipal(u)));
    const app = createApp({ repo: new MemoryRepo(), directory: d, clock });
    await app.request('/cases', { method: 'POST', headers: { ...auth('a-counsel'), 'content-type': 'application/json' }, body: JSON.stringify({ id: 'L-9', caseType: 'legal.matter', fields: {} }) });
    expect((await app.request('/cases/L-9/najiz/submit', { method: 'POST', headers: auth('a-counsel') })).status).toBe(404);
    expect(((await (await app.request('/cases/L-9/najiz', { headers: auth('a-counsel') })).json()) as any).enabled).toBe(false);
    expect(() => najizFromEnv({ NAJIZ_MODE: 'simulated', NODE_ENV: 'production' })).toThrow(/production/);
    expect(najizFromEnv({})).toBeUndefined();
  });

  it('even if wired in by mistake, the simulator does nothing when NODE_ENV=production', async () => {
    const w = build(); await ready(w); await approve(w);
    const old = process.env['NODE_ENV']; process.env['NODE_ENV'] = 'production';
    try { expect((await submit(w)).status).toBe(404); } finally { if (old === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = old; }
    expect(w.sim.received).toHaveLength(0);
  });

  it('live mode with no wire mapping refuses before recording anything', async () => {
    const reg = najizFromEnv({ NAJIZ_MODE: 'live', NAJIZ_TENANTS: JSON.stringify({ 'tenant-a': { baseUrl: 'https://api.example.sa', tokenUrl: 'https://api.example.sa/token', allowedHosts: ['api.example.sa'], keyEnv: 'K', secretEnv: 'S', claimant: { identifierType: 'UNIFIED_NATIONAL_NUMBER', identifier: '7001', name: 'Client A' } } }), K: 'k', S: 's' })!;
    const d = new Directory(); TEST_USERS.forEach((u) => d.add(asPrincipal(u)));
    const repo = new MemoryRepo();
    const app = createApp({ repo, directory: d, clock, najiz: reg });
    const w = { app, repo, sim: new SimulatedNajiz(), j: (who: string, m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: { ...auth(who), 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) }), up: (who: string, id: string, type: string, bytes: Uint8Array, name = 'f.pdf') => { const fd = new FormData(); fd.set('file', new File([bytes], name)); fd.set('type', type); return app.request(`/cases/${id}/documents`, { method: 'POST', headers: auth(who), body: fd }); } } as W;
    await ready(w); await approve(w);
    const r = await submit(w); expect(r.status).toBe(503); expect(((await r.json()) as any).error).toBe('NAJIZ_CONTRACT_NOT_CONFIGURED');
    expect((await arts(w)).some((a) => a.type.startsWith('najiz_'))).toBe(false);
  });
});
