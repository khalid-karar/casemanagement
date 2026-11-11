import { NajizError } from './types';
import type { FilingPacket, NajizGateway, SubmitResult, UpdatesResult } from './types';
import type { HttpRequest, NajizContract } from './contract';

export interface NajizHttpConfig {
  /** e.g. the Apigee host Najiz issues for your application. https only. */
  baseUrl: string;
  /** OAuth token endpoint of the Authorize step. https only. */
  tokenUrl: string;
  /** Hosts the gateway may contact. Anything else is refused (no redirect or config can send data elsewhere). */
  allowedHosts: string[];
  clientId: string;
  clientSecret: string;
  contract: NajizContract | null;
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Najiz over HTTPS with OAuth client credentials (Consumer Key / Secret, Bearer token: as the portal guide describes).
 * ASSUMPTION to confirm against the portal's Authorize step: the standard `client_credentials` grant with HTTP Basic
 * client authentication. If Najiz's Authorize step differs, only `token()` changes.
 *
 * Rules that protect against filing twice (a lawsuit is not undoable):
 *  - never follow redirects; refuse non-https and hosts that are not allow-listed;
 *  - a timeout, dropped connection or 5xx AFTER the request was sent is AMBIGUOUS and is never retried here;
 *  - only a refused token (401) is retried, once, with a fresh token, because nothing was processed;
 *  - secrets are never logged and never appear in error messages.
 */
export class NajizHttpGateway implements NajizGateway {
  readonly name = 'NAJIZ';
  readonly simulated = false;
  get configured() { return this.cfg.contract !== null; }
  private cached: { token: string; expiresAt: number } | undefined;
  private f: typeof fetch;
  private now: () => number;

  constructor(private cfg: NajizHttpConfig) {
    for (const u of [cfg.baseUrl, cfg.tokenUrl]) this.checkUrl(u);
    this.f = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  private checkUrl(u: string) {
    const url = new URL(u);
    if (url.protocol !== 'https:') throw new Error('Najiz URLs must use https');
    if (!this.cfg.allowedHosts.includes(url.hostname)) throw new Error(`Najiz host not allow-listed: ${url.hostname}`);
  }

  private async token(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAt > this.now() + 30_000) return this.cached.token;
    let res: Response;
    try {
      res = await this.f(this.cfg.tokenUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64') },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      });
    } catch { throw new NajizError('UNAVAILABLE', 'Najiz token endpoint unreachable'); } // nothing was sent to a service
    if (res.status === 401 || res.status === 403) throw new NajizError('AUTH', 'Najiz refused our credentials');
    if (!res.ok) throw new NajizError('UNAVAILABLE', `Najiz token endpoint answered ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number | string };
    if (!j.access_token) throw new NajizError('AUTH', 'Najiz token response had no access token');
    this.cached = { token: j.access_token, expiresAt: this.now() + (Number(j.expires_in) || 300) * 1000 };
    return this.cached.token;
  }

  private async call(req: HttpRequest, idempotencyKey?: string, idemHeader?: string, retriedAuth = false): Promise<{ status: number; body: unknown }> {
    const contract = this.cfg.contract;
    if (!contract) throw new NajizError('CONTRACT_NOT_CONFIGURED', 'Najiz request/response mapping is not configured (src/najiz/contract.ts)');
    const url = new URL(req.path, this.cfg.baseUrl);
    this.checkUrl(url.toString());
    const bearer = await this.token();
    let res: Response;
    try {
      res = await this.f(url, {
        method: req.method, redirect: 'error', signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', ...(req.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey && idemHeader ? { [idemHeader]: idempotencyKey } : {}), ...(req.headers ?? {}) },
        ...(req.json !== undefined ? { body: JSON.stringify(req.json) } : req.form ? { body: req.form } : {}),
      });
    } catch {
      // The request may have reached Najiz. We cannot know.
      throw new NajizError('AMBIGUOUS', 'No answer from Najiz: the request may or may not have been processed');
    }
    if (res.status === 401 && !retriedAuth) { await this.token(true); return this.call(req, idempotencyKey, idemHeader, true); }
    const body = await res.json().catch(() => undefined);
    if (res.status === 401 || res.status === 403) throw new NajizError('AUTH', 'Najiz refused our credentials');
    if (res.status >= 500) throw new NajizError('AMBIGUOUS', `Najiz answered ${res.status} after the request was sent`);
    if (res.status === 429) throw new NajizError('UNAVAILABLE', 'Najiz rate limit: not processed'); // refused before processing
    if (!res.ok) throw new NajizError(contract.classify?.(res.status, body) ?? 'REJECTED', `Najiz answered ${res.status}`, typeof (body as any)?.message === 'string' ? (body as any).message : undefined);
    return { status: res.status, body };
  }

  async submitFiling(p: FilingPacket): Promise<SubmitResult> {
    const c = this.cfg.contract;
    if (!c) throw new NajizError('CONTRACT_NOT_CONFIGURED', 'Najiz request/response mapping is not configured (src/najiz/contract.ts)');
    const r = await this.call(c.submit.build(p), p.idempotencyKey, c.submit.idempotencyHeader);
    try { return c.submit.parse(r.status, r.body); } catch { throw new NajizError('AMBIGUOUS', 'Najiz answered, but the answer could not be understood'); }
  }

  async fetchUpdates(ref: string): Promise<UpdatesResult> {
    const c = this.cfg.contract;
    if (!c) throw new NajizError('CONTRACT_NOT_CONFIGURED', 'Najiz request/response mapping is not configured (src/najiz/contract.ts)');
    const r = await this.call(c.updates.build(ref));
    try { return c.updates.parse(r.status, r.body); } catch { throw new NajizError('UNAVAILABLE', 'Najiz answered, but the answer could not be understood'); }
  }
}
