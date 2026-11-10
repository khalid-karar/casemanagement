/**
 * Per-user request limiter (fixed window, in memory).
 *
 * This is defence in depth, not the perimeter: it keeps one authenticated account from hammering the
 * API or the expensive routes (AI, file upload and OCR). It is per server instance, so with N instances
 * the effective limit is N times higher. IP-level limiting, bot protection and volumetric DoS belong at
 * the gateway / WAF in front of the app (Oracle Cloud). Login brute force is Keycloak's job (lockout).
 */
export interface Limit { max: number; windowMs: number }

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastPrune = 0;
  constructor(private now: () => number = Date.now) {}

  /** Returns 0 if allowed, otherwise the seconds to wait. */
  take(key: string, limit: Limit): number {
    const t = this.now();
    if (t - this.lastPrune > 60_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
      this.lastPrune = t;
    }
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) { this.hits.set(key, { count: 1, resetAt: t + limit.windowMs }); return 0; }
    if (cur.count >= limit.max) return Math.max(1, Math.ceil((cur.resetAt - t) / 1000));
    cur.count++;
    return 0;
  }
}

/** Routes that cost real CPU, memory or money: stricter limit. */
export const isHeavyRoute = (method: string, path: string) =>
  path.startsWith('/ai/') || (method === 'POST' && (path === '/laws/files' || path === '/laws/versions' || /^\/laws\/versions\/[^/]+\/extract$/.test(path)));
