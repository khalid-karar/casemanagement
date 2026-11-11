import { describe, expect, it } from 'vitest';
import { NajizHttpGateway } from '../src/najiz/http';
import type { NajizContract } from '../src/najiz/contract';
import { NajizError } from '../src/najiz/types';
import type { FilingPacket } from '../src/najiz/types';

// A FAKE contract, only to exercise the mechanics around it. It is not Najiz's wire format.
const contract: NajizContract = {
  submit: { idempotencyHeader: 'x-idem', build: (p) => ({ method: 'POST', path: '/v1/filings', json: { t: p.title } }), parse: (_s, b: any) => ({ najizRef: b.ref, status: 'RECEIVED', acceptedAt: 'now' }) },
  updates: { build: (r) => ({ method: 'GET', path: `/v1/filings/${r}` }), parse: (_s, b: any) => ({ status: b.status, events: [] }) },
};
const packet: FilingPacket = { idempotencyKey: 'k1', matterId: 'm', forum: 'OTHER', title: 'T', claimSubject: 'T', parties: [], attachments: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function gw(handler: (url: string, init: RequestInit) => Response | Promise<Response>, over: Partial<ConstructorParameters<typeof NajizHttpGateway>[0]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (u: any, init: RequestInit) => { const url = String(u); calls.push({ url, init }); if (url.endsWith('/token')) return json(200, { access_token: 'tok' + calls.filter((c) => c.url.endsWith('/token')).length, expires_in: 300 }); return handler(url, init); }) as typeof fetch;
  const g = new NajizHttpGateway({ baseUrl: 'https://api.najiz.test', tokenUrl: 'https://api.najiz.test/token', allowedHosts: ['api.najiz.test'], clientId: 'KEY', clientSecret: 'SECRET-VALUE', contract, fetch: f, ...over });
  return { g, calls };
}
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof NajizError ? e.code : 'other'));

describe('NajizHttpGateway', () => {
  it('gets a token with client credentials, sends it as Bearer, and caches it', async () => {
    const { g, calls } = gw(() => json(200, { ref: 'R1' }));
    expect((await g.submitFiling(packet)).najizRef).toBe('R1');
    await g.submitFiling(packet);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    const call = calls.find((c) => c.url.endsWith('/v1/filings'))!;
    expect((call.init.headers as any).authorization).toBe('Bearer tok1');
    expect((call.init.headers as any)['x-idem']).toBe('k1');
    expect(call.init.redirect).toBe('error');
  });

  it('refreshes the token once on 401; a second 401 is an AUTH error', async () => {
    let n = 0;
    const a = gw(() => (++n === 1 ? json(401, {}) : json(200, { ref: 'R2' })));
    expect((await a.g.submitFiling(packet)).najizRef).toBe('R2');
    expect(a.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
    expect(await code(gw(() => json(401, {})).g.submitFiling(packet))).toBe('AUTH');
  });

  it('a timeout, dropped connection or 5xx after sending is AMBIGUOUS and is sent exactly once', async () => {
    for (const h of [() => { throw new TypeError('socket hang up'); }, () => json(502, {}), () => json(500, {})]) {
      const { g, calls } = gw(h);
      expect(await code(g.submitFiling(packet))).toBe('AMBIGUOUS');
      expect(calls.filter((c) => c.url.endsWith('/v1/filings'))).toHaveLength(1);
    }
  });

  it('answers it cannot understand are AMBIGUOUS for a filing (it may have been accepted)', async () => {
    expect(await code(gw(() => json(200, { unexpected: true }), { contract: { ...contract, submit: { ...contract.submit, parse: () => { throw new Error('bad'); } } } }).g.submitFiling(packet))).toBe('AMBIGUOUS');
  });

  it('4xx is a definitive REJECTED with the reason; 429 is safe to retry', async () => {
    const r = gw(() => json(422, { message: 'bad claim' }));
    await expect(r.g.submitFiling(packet)).rejects.toMatchObject({ code: 'REJECTED', detail: 'bad claim' });
    expect(await code(gw(() => json(429, {})).g.submitFiling(packet))).toBe('UNAVAILABLE');
  });

  it('an unreachable or refusing token endpoint means nothing was sent', async () => {
    const down = gw(() => json(200, {}), { fetch: (async () => { throw new TypeError('down'); }) as any });
    expect(await code(down.g.submitFiling(packet))).toBe('UNAVAILABLE');
    expect(await code(gw(() => json(200, {}), { fetch: (async () => json(401, {})) as any }).g.submitFiling(packet))).toBe('AUTH');
  });

  it('refuses http, hosts outside the allowlist, and a contract that sends elsewhere', async () => {
    expect(() => gw(() => json(200, {}), { baseUrl: 'http://api.najiz.test' })).toThrow(/https/);
    expect(() => gw(() => json(200, {}), { baseUrl: 'https://evil.test' })).toThrow(/allow-listed/);
    const evil: NajizContract = { ...contract, submit: { ...contract.submit, build: () => ({ method: 'POST', path: 'https://evil.test/steal', json: {} }) } };
    const { g, calls } = gw(() => json(200, { ref: 'x' }), { contract: evil });
    await expect(g.submitFiling(packet)).rejects.toThrow(/allow-listed/);
    expect(calls.some((c) => c.url.includes('evil'))).toBe(false);
  });

  it('with no contract installed it is not configured and refuses', async () => {
    const { g, calls } = gw(() => json(200, {}), { contract: null });
    expect(g.configured).toBe(false);
    expect(await code(g.submitFiling(packet))).toBe('CONTRACT_NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('never puts the secret in an error message', async () => {
    const e = await gw(() => json(401, {})).g.submitFiling(packet).catch((x) => x);
    expect(JSON.stringify([e.message, e.detail, String(e.stack)])).not.toMatch(/SECRET-VALUE|KEY/);
  });
});
