import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from 'jose';
import { OidcAuthenticator, principalFromClaims } from '../src/api/oidc';
import { createApp } from '../src/api/app';
import { MemoryRepo } from '../src/api/repo';

const ISS = 'https://id.example.sa/realms/cms';
let priv: any, other: any, auth: OidcAuthenticator;

async function token(claims: Record<string, unknown> = {}, opts: { key?: any; iss?: string; aud?: string; exp?: string; alg?: string } = {}) {
  return new SignJWT({ azp: 'case-web', typ: 'Bearer', tenant_id: 'neom', departments: ['HR'], realm_access: { roles: ['hr_manager', 'bogus_admin'] }, name: 'Sara', ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
    .setSubject('u-1').setIssuer(opts.iss ?? ISS).setAudience(opts.aud ?? 'case-api')
    .setIssuedAt().setExpirationTime(opts.exp ?? '5m').sign(opts.key ?? priv);
}
const hdr = (t: string) => `Bearer ${t}`;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256'); priv = kp.privateKey;
  other = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  auth = new OidcAuthenticator({ issuer: ISS, audience: 'case-api', allowedClients: ['case-web'], jwks: createLocalJWKSet({ keys: [jwk] }) });
});

describe('OIDC token verification', () => {
  it('accepts a valid token and maps claims; unknown roles are dropped', async () => {
    const p = await auth.resolve(hdr(await token()));
    expect(p).toMatchObject({ id: 'u-1', tenantId: 'neom', departments: ['HR'], kind: 'human' });
    expect(p!.roles).toContain('hr_manager');
    expect(p!.roles).not.toContain('bogus_admin');
  });
  it('rejects wrong issuer, audience, signature, expiry and client', async () => {
    expect(await auth.resolve(hdr(await token({}, { iss: 'https://evil.example/realms/cms' })))).toBeUndefined();
    expect(await auth.resolve(hdr(await token({}, { aud: 'other-api' })))).toBeUndefined();
    expect(await auth.resolve(hdr(await token({}, { key: other })))).toBeUndefined();
    expect(await auth.resolve(hdr(await token({}, { exp: '-5m' })))).toBeUndefined();
    expect(await auth.resolve(hdr(await token({ azp: 'some-other-client' })))).toBeUndefined();
    expect(await auth.resolve(hdr(await token({ typ: 'ID' })))).toBeUndefined();
  });
  it('rejects alg=none and malformed headers', async () => {
    const none = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ iss: ISS, aud: 'case-api', sub: 'x', tenant_id: 'neom', azp: 'case-web', exp: 9999999999 })).toString('base64url') + '.';
    expect(await auth.resolve(hdr(none))).toBeUndefined();
    expect(await auth.resolve(undefined)).toBeUndefined();
    expect(await auth.resolve('Basic abc')).toBeUndefined();
  });
  it('requires a valid tenant claim; never mints AI/system actors', async () => {
    expect(await auth.resolve(hdr(await token({ tenant_id: undefined })))).toBeUndefined();
    expect(await auth.resolve(hdr(await token({ tenant_id: "x'; drop" })))).toBeUndefined();
    expect((await auth.resolve(hdr(await token({ actor_kind: 'ai' }))))!.kind).toBe('human');
    expect(principalFromClaims({ sub: 'a', tenant_id: 'neom', clearance: 'GOD' } as any)!.clearance).toBe('STANDARD');
  });
  it('refuses a plain-http issuer outside development', () => {
    expect(() => new OidcAuthenticator({ issuer: 'http://id.local/realms/cms', audience: 'a', allowedClients: ['c'] })).toThrow();
  });
});

describe('API with OIDC', () => {
  it('401 without a token, 200 with one, and tenant comes from the token', async () => {
    const app = createApp({ repo: new MemoryRepo(), directory: auth, authInfo: { mode: 'oidc', issuer: ISS, clientId: 'case-web' } });
    expect((await app.request('/cases')).status).toBe(401);
    const r = await app.request('/me', { headers: { authorization: hdr(await token()) } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).tenantId).toBe('neom');
    const cfg = await app.request('/auth/config');
    expect(((await cfg.json()) as any).mode).toBe('oidc');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
