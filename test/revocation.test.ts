import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { OidcAuthenticator } from '../src/api/oidc';
import { createApp } from '../src/api/app';
import { MemoryRepo } from '../src/api/repo';
import { Revocations } from '../src/api/revocation';

const ISS = 'https://id.example.sa/realms/cms';
let priv: any, jwks: any;
beforeAll(async () => {
  const kp = await generateKeyPair('RS256'); priv = kp.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
});
const sign = (claims: Record<string, unknown>, o: { aud?: string; iat?: number; sub?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(o.sub ?? 'u-1').setIssuer(ISS).setAudience(o.aud ?? 'case-api').setIssuedAt(o.iat ?? Math.floor(Date.now() / 1000)).setExpirationTime('10m').setJti(crypto.randomUUID()).sign(priv);
const access = (o: { iat?: number; sub?: string } = {}) => sign({ azp: 'case-web', typ: 'Bearer', tenant_id: 'neom', departments: ['HR'], realm_access: { roles: ['tenant_admin'] } }, o);
const logoutTok = (claims: Record<string, unknown> = {}, o: { sub?: string } = {}) =>
  sign({ events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, ...claims }, { aud: 'case-web', ...o });

function world() {
  const repo = new MemoryRepo(); const rev = new Revocations(repo, 1_000_000);
  const auth = new OidcAuthenticator({ issuer: ISS, audience: 'case-api', allowedClients: ['case-web'], jwks, revocations: rev });
  const app = createApp({ repo, directory: auth, revocations: rev, verifyLogoutToken: (t) => auth.verifyLogoutToken(t) });
  return { repo, rev, auth, app };
}
const me = (app: any, t: string) => app.request('/me', { headers: { authorization: `Bearer ${t}` } });
const logout = (app: any, t: string) => app.request('/auth/backchannel-logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `logout_token=${t}` });

describe('session revocation', () => {
  it('a valid logout token ends the person’s existing tokens immediately; a token issued afterwards works', async () => {
    const { app } = world();
    const now = Math.floor(Date.now() / 1000);
    const old = await access({ iat: now - 60 });
    expect((await me(app, old)).status).toBe(200);
    expect((await logout(app, await logoutTok())).status).toBe(200);
    expect((await me(app, old)).status).toBe(401);
    expect((await me(app, await access({ iat: now + 5 }))).status).toBe(200); // signs in again later
  });
  it('does not touch other people', async () => {
    const { app } = world();
    await logout(app, await logoutTok());
    expect((await me(app, await access({ sub: 'u-2', iat: Math.floor(Date.now() / 1000) - 60 }))).status).toBe(200);
  });
  it('rejects forged, wrong-audience, nonce-bearing and event-less logout tokens, and anonymous junk', async () => {
    const { app, rev } = world();
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('u-1').setIssuer(ISS).setAudience('case-web').setIssuedAt().setJti('x').setExpirationTime('5m').sign(privateKey);
    for (const t of [forged, await logoutTok({ nonce: 'n' }), await sign({}, { aud: 'case-web' }), await sign({ events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }, { aud: 'someone-else' }), 'junk', '']) {
      expect((await logout(app, t)).status).toBe(400);
    }
    expect(rev.isRevoked('u-1', 0)).toBe(false);
  });
  it('an ID/access token cannot be replayed as a logout token (no events claim)', async () => {
    const { app } = world();
    expect((await logout(app, await access())).status).toBe(400);
  });
  it('a tenant admin can revoke a person; others cannot', async () => {
    const { app } = world();
    const now = Math.floor(Date.now() / 1000);
    const victim = await access({ sub: 'u-9', iat: now - 30 });
    const admin = await access({ sub: 'admin-1', iat: now - 30 });
    const post = (t: string) => app.request('/admin/revoke-sessions', { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'u-9' }) });
    const nonAdmin = await sign({ azp: 'case-web', typ: 'Bearer', tenant_id: 'neom', departments: ['HR'], realm_access: { roles: ['hr_manager'] } }, { sub: 'u-3', iat: now - 30 });
    expect((await post(nonAdmin)).status).toBe(403);
    expect((await me(app, victim)).status).toBe(200);
    expect((await post(admin)).status).toBe(200);
    expect((await me(app, victim)).status).toBe(401);
  });
  it('another server picks the revocation up from the shared store', async () => {
    const repo = new MemoryRepo();
    const a = new Revocations(repo, 1_000_000), b = new Revocations(repo, 1_000_000);
    await a.revoke('u-1', 2000);
    expect(b.isRevoked('u-1', 1000)).toBe(false); // not yet polled
    await b.refresh();
    expect(b.isRevoked('u-1', 1000)).toBe(true);
    expect(b.isRevoked('u-1', 2000)).toBe(false);
  });
});

import { PG_ENABLED, freshDatabase, newRepo } from './helpers/pg';
describe.skipIf(!PG_ENABLED)('revocation store on Postgres', () => {
  it('persists, never moves a revocation backwards, and is shared by two servers', async () => {
    await freshDatabase();
    const r1 = await newRepo(), r2 = await newRepo();
    await r1.setRevocation('u-1', 2000); await r1.setRevocation('u-1', 1000);
    expect(await r2.loadRevocations()).toEqual({ 'u-1': 2000 });
    await r1.close?.(); await r2.close?.();
  });
});
