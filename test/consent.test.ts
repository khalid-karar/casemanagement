import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';
import type { ChatProvider } from '../src/ai';
import { CONSENT_VERSION, buildChunks, consentHash, consentText, consentValid, defaultSettings, selectProvider } from '../src/ai';
import { CASE_TYPES, hrMisconduct, legalMatter } from '../src/case-types';
import { createCase } from '../src/engine';
import type { Actor } from '../src/engine';

const T = 'tenant-a';
const spy = (name: string) => { const calls: string[] = []; const p: ChatProvider = { model: name, complete: async (m) => { calls.push(m.map((x) => x.content).join('\n')); return 'answer'; } }; return { p, calls }; };
const ik = (p: ChatProvider) => ({ provider: p, name: 'CloudX', region: 'Dammam' });

describe('provider selection (fail-closed)', () => {
  const sov = spy('own').p, ext = spy('ext').p;
  const providers = { sovereign: sov, inKingdom: ik(ext) };
  const signed = (over = {}) => ({ tenantId: T, mode: 'IN_KINGDOM_API' as const, consent: { version: CONSENT_VERSION, textSha256: 'x', signedByUserId: 'u', signedByName: 'n', signedByTitle: 't', signedAt: 'a', providerName: 'CloudX', region: 'Dammam', includePersonal: false, ...over } });
  it('uses own model by default, never the external provider without consent', () => {
    const r = selectProvider(T, defaultSettings(T), providers);
    expect(r.ok && r.mode).toBe('sovereign');
  });
  it('uses the external provider only with valid consent', () => {
    const r = selectProvider(T, signed(), providers);
    expect(r.ok && r.mode).toBe('in_kingdom');
  });
  it.each([
    ['revoked', { revokedAt: 'now' }],
    ['old wording', { version: 'old' }],
    ['different provider', { providerName: 'Other' }],
    ['different region', { region: 'Elsewhere' }],
  ])('refuses the external provider when consent is %s', (_n, over) => {
    expect(consentValid(signed(over), { providerName: 'CloudX', region: 'Dammam' })).toBe(false);
    const r = selectProvider(T, signed(over), providers);
    expect(r.ok && r.mode).toBe('sovereign');
  });
  it('with no own model and no consent, AI is off rather than falling to the external provider', () => {
    expect(selectProvider(T, defaultSettings(T), { inKingdom: ik(ext) })).toEqual({ ok: false, reason: 'NO_PROVIDER' });
  });
});

describe('what may leave our infrastructure', () => {
  const hr: Actor = { id: 'h', kind: 'human', tenantId: T, departments: ['HR'], roles: ['hr_manager', 'ethics_officer'], reportsTo: [], clearance: 'PRIVILEGED' };
  const counsel: Actor = { ...hr, id: 'l', departments: ['LEGAL'], roles: ['legal_counsel'] };
  const now = '2026-11-10T08:00:00.000Z';
  const hrCase = createCase(hrMisconduct, { id: 'h1', fields: { allegationSummary: 'late', reporterIdentity: 'REPORTER-NAME', subjectEmployee: 'SUBJECT-NAME' } }, hr, now).case;
  const legal = createCase(legalMatter, { id: 'm1', fields: { title: 'privileged strategy' } }, counsel, now).case;
  const text = (cs: any[]) => buildChunks(cs, CASE_TYPES, { ...hr, departments: ['HR', 'LEGAL'], roles: ['hr_manager', 'ethics_officer', 'legal_counsel'] }, ...[] as []).map((c) => c.text).join();
  const ext = (inc: boolean) => buildChunks([hrCase, legal], CASE_TYPES, { ...hr, departments: ['HR', 'LEGAL'], roles: ['hr_manager', 'ethics_officer', 'legal_counsel'] }, { external: true, includePersonal: inc }).map((c) => c.text).join();
  it('own model sees everything the user may see (control)', () => {
    expect(text([hrCase, legal])).toContain('REPORTER-NAME');
    expect(text([hrCase, legal])).toContain('privileged strategy');
  });
  it('external provider never gets privileged matters or sealed identities, even for an authorised user', () => {
    const t = ext(true);
    expect(t).not.toContain('privileged strategy');
    expect(t).not.toContain('REPORTER-NAME');
    expect(t).toContain('SUBJECT-NAME'); // personal allowed because the client opted in
  });
  it('masks personal fields unless the client opted in', () => {
    expect(ext(false)).not.toContain('SUBJECT-NAME');
  });
});

describe('consent over the API', () => {
  function build(withInKingdom = true) {
    const d = new Directory();
    const mk = (id: string, roles: string[], tenantId = T) => d.add({ id, name: id, kind: 'human', tenantId, departments: ['HR'], roles, reportsTo: [], clearance: 'RESTRICTED' });
    mk('admin', ['tenant_admin']); mk('mgr', ['hr_manager', 'hr_intake']); mk('other-admin', ['tenant_admin'], 'tenant-b');
    const own = spy('own'), ext = spy('ext');
    const app = createApp({ repo: new MemoryRepo(), directory: d, provider: own.p, ...(withInKingdom ? { inKingdom: ik(ext.p) } : {}), clock: () => '2026-11-10T08:00:00.000Z' });
    const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { authorization: `Bearer dev:${who}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { call, own, ext };
  }
  const sign = async (call: any, over: Record<string, unknown> = {}) => {
    const t = (await (await call('admin', 'GET', '/ai/consent-text?includePersonal=false')).json()) as any;
    return call('admin', 'POST', '/ai/consent', { includePersonal: false, name: 'Sara Alharbi', title: 'General Counsel', textSha256: t.sha256, acknowledge: true, ...over });
  };

  it('starts on our own model; the external provider is untouched until consent', async () => {
    const { call, own, ext } = build();
    await call('mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: { allegationSummary: 'late arrival' } });
    const r = (await (await call('mgr', 'POST', '/ai/cases', { question: 'late arrival' })).json()) as any;
    expect(r.engine.mode).toBe('sovereign');
    expect(own.calls.length).toBe(1);
    expect(ext.calls.length).toBe(0);
  });
  it('only a client admin can sign, and only with the exact wording shown', async () => {
    const { call } = build();
    expect((await call('mgr', 'POST', '/ai/consent', {})).status).toBe(403);
    expect((await sign(call, { textSha256: 'forged' })).status).toBe(403);
    expect((await sign(call, { acknowledge: false })).status).toBe(403);
    expect((await sign(call, { name: ' ' })).status).toBe(403);
    expect((await sign(call)).status).toBe(201);
  });
  it('after signing the external provider is used, with an audit trail; revoking stops it at once', async () => {
    const { call, own, ext } = build();
    await call('mgr', 'POST', '/cases', { id: 'c1', caseType: 'hr.misconduct', fields: { allegationSummary: 'late arrival' } });
    await sign(call);
    const a = (await (await call('mgr', 'POST', '/ai/cases', { question: 'late arrival' })).json()) as any;
    expect(a.engine.mode).toBe('in_kingdom');
    expect(ext.calls.length).toBe(1);
    expect(await (await call('admin', 'DELETE', '/ai/consent')).json()).toMatchObject({ mode: 'SOVEREIGN' });
    const b = (await (await call('mgr', 'POST', '/ai/cases', { question: 'late arrival' })).json()) as any;
    expect(b.engine.mode).toBe('sovereign');
    expect(ext.calls.length).toBe(1);
    expect(own.calls.length).toBe(1);
    const log = (await (await call('admin', 'GET', '/ai/log')).json()) as any[];
    expect(log.map((l) => l.type).sort()).toEqual(['ai.call', 'ai.call', 'consent.revoked', 'consent.signed']);
    expect(JSON.stringify(log)).not.toContain('late arrival'); // no prompt content in the log
    expect((await call('mgr', 'GET', '/ai/log')).status).toBe(403);
  });
  it('one tenant’s consent never applies to another tenant', async () => {
    const { call, ext } = build();
    await sign(call);
    const s = (await (await call('other-admin', 'GET', '/ai/settings')).json()) as any;
    expect(s.mode).toBe('SOVEREIGN');
    expect(ext.calls.length).toBe(0);
  });
  it('without any provider, AI is cleanly unavailable', async () => {
    const d = new Directory();
    d.add({ id: 'mgr', name: 'm', kind: 'human', tenantId: T, departments: ['HR'], roles: ['hr_manager'], reportsTo: [], clearance: 'RESTRICTED' });
    const app = createApp({ repo: new MemoryRepo(), directory: d });
    const r = await app.request('/ai/cases', { method: 'POST', headers: { authorization: 'Bearer dev:mgr', 'content-type': 'application/json' }, body: JSON.stringify({ question: 'x' }) });
    expect(r.status).toBe(503);
  });
  it('consent text is bilingual and its hash changes if the choice changes', () => {
    const a = consentText({ providerName: 'X', region: 'R', includePersonal: false });
    const b = consentText({ providerName: 'X', region: 'R', includePersonal: true });
    expect(a.ar.length).toBe(a.en.length);
    expect(consentHash(a)).not.toBe(consentHash(b));
  });
});
