import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { MAX_REPLY_TEXT, MAX_REPORT_TEXT, MIN_REPORT_TEXT, REPORT_CATEGORIES, REPORT_LANGUAGES, createReport, reporterReply, reporterView } from '../engine';
import { formatReportCode, generateReportCode, hashReportCode, normaliseReportCode } from '../security/reportcode';
import { CHANNEL_TOKEN } from './repo';
import type { ReportStore } from './repo';
import { RateLimiter } from './ratelimit';

/**
 * The only routes that answer to someone who is not signed in.
 *
 * What it can reach is deliberately small: it is handed a ReportStore (reports and channels) and nothing else, so no
 * case, person, or audit record is reachable from here by construction. It resolves a tenant from a channel token and
 * from nothing else, never trusts a client-supplied tenant, and answers every "no" the same way, so a caller cannot tell
 * a wrong token from a retired channel or a wrong code from a code that was never issued.
 *
 * Privacy of the reporter is the point, so this module also keeps what it does not do in one place:
 *   - it never stores or logs an address, a user agent, a cookie, or a header;
 *   - the per-source limiter keys on a salted hash of the address, held in memory only, whose salt changes every day, so
 *     the limiter cannot be turned into a record of who reported (and a restart forgets everything);
 *   - the reference code appears once, in the response that creates the report, and only its hash is kept.
 * The gateway in front of the app must follow the same rule: no access logs with client addresses on /public and /r
 * (docs/OPERATIONS.md). Volumetric abuse and bot traffic are the gateway's to stop; the limits here are the second line.
 */
export interface PublicLimits {
  /** Reports one source may file per hour. */
  createPerSourceHour: number;
  /** Replies and code lookups one source may make per ten minutes. */
  trackPerSource10Min: number;
  /** Reports a whole channel accepts per hour. When this is exhausted nobody can file through that channel until the hour passes. */
  createPerChannelHour: number;
  /** Code lookups a whole channel accepts per minute. */
  trackPerChannelMinute: number;
}
export const DEFAULT_PUBLIC_LIMITS: PublicLimits = { createPerSourceHour: 5, trackPerSource10Min: 30, createPerChannelHour: 200, trackPerChannelMinute: 300 };

export type ReportEvent = { kind: 'REPORT_NEW' | 'REPORT_REPLY'; tenantId: string; reportId: string; n: number };

export interface PublicDeps {
  store: Pick<ReportStore, 'reportTx' | 'channelByToken'>;
  now: () => string;
  /** The caller's network address as the server sees it (after trusted proxies). Used only to derive a rotating hash. */
  address?: (c: Context) => string | undefined;
  limits?: Partial<PublicLimits>;
  /** Told that staff should look. Failure here never affects the reporter. */
  onEvent?: (e: ReportEvent) => Promise<void>;
  /** Replaced in tests. */
  clock?: () => number;
}

const NOT_FOUND = { error: 'NOT_FOUND' } as const;
/** JSON for the largest allowed report (20,000 characters, three bytes each in the worst case) plus the envelope. */
const BODY_CAP = MAX_REPORT_TEXT * 3 + 2048;

/** Reads the address the way a deployment tells us to: the socket, or the entry added by the Nth trusted proxy. */
export function addressFrom(c: Context, trustedProxyHops: number): string | undefined {
  if (trustedProxyHops > 0) {
    const parts = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const hop = parts[parts.length - trustedProxyHops];
    if (hop) return hop;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress;
}

export function publicReports(deps: PublicDeps) {
  const app = new Hono();
  const limits = { ...DEFAULT_PUBLIC_LIMITS, ...deps.limits };
  const limiter = new RateLimiter(deps.clock ?? Date.now);
  const clock = deps.clock ?? Date.now;
  // Never leaves memory, never logged. A new process starts with a new secret.
  const secret = randomBytes(32);
  const source = (c: Context): string => {
    const day = Math.floor(clock() / 86_400_000);
    return createHmac('sha256', secret).update(`${day}|${deps.address?.(c) ?? 'unknown'}`).digest('base64url').slice(0, 22);
  };

  app.use('*', async (c, next) => {
    c.header('x-robots-tag', 'noindex, nofollow, noarchive');
    c.header('cache-control', 'no-store');
    return next();
  });
  app.use('*', bodyLimit({ maxSize: BODY_CAP, onError: (c) => c.json({ error: 'PAYLOAD_TOO_LARGE' }, 413) }));

  const tooMany = (c: Context, wait: number) => { c.header('retry-after', String(wait)); return c.json({ error: 'RATE_LIMITED' }, 429); };
  const channelOf = async (token: string) => {
    if (!CHANNEL_TOKEN.test(token)) return undefined;
    const ch = await deps.store.channelByToken(token);
    return ch && ch.active ? ch : undefined;
  };
  const readJson = async (c: Context): Promise<Record<string, unknown>> => {
    const b: unknown = await c.req.json().catch(() => undefined);
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };
  const tell = async (e: ReportEvent) => { try { await deps.onEvent?.(e); } catch { /* the reporter's submission must not fail because staff could not be told */ } };

  // What the page needs to draw itself. No tenant name or id: the label is what is printed on the poster anyway.
  app.get('/:token', async (c) => {
    const wait = limiter.take(`i:${source(c)}`, { windowMs: 60_000, max: 60 });
    if (wait) return tooMany(c, wait);
    const ch = await channelOf(c.req.param('token'));
    if (!ch) return c.json(NOT_FOUND, 404);
    return c.json({ label: ch.label, categories: REPORT_CATEGORIES, languages: REPORT_LANGUAGES, limits: { minText: MIN_REPORT_TEXT, maxText: MAX_REPORT_TEXT, maxReply: MAX_REPLY_TEXT } });
  });

  app.post('/:token/reports', async (c) => {
    const src = source(c);
    const wait = limiter.take(`c:${src}`, { windowMs: 3_600_000, max: limits.createPerSourceHour });
    if (wait) return tooMany(c, wait);
    const ch = await channelOf(c.req.param('token'));
    if (!ch) return c.json(NOT_FOUND, 404);
    // A circuit breaker for the channel as a whole. It also stops an attacker who rotates addresses; the price is that a
    // flood can hold a channel shut for the rest of the hour. That is an accepted trade, recorded in docs/KNOWN-GAPS.md.
    const chWait = limiter.take(`cc:${ch.tenantId}:${ch.id}`, { windowMs: 3_600_000, max: limits.createPerChannelHour });
    if (chWait) return tooMany(c, chWait);
    const b = await readJson(c);
    const now = deps.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateReportCode();
      const report = createReport({ id: randomUUID(), tenantId: ch.tenantId, channelId: ch.id, category: b['category'], language: b['language'], text: b['text'], codeHash: hashReportCode(code) }, now);
      try {
        await deps.store.reportTx(ch.tenantId, (tx) => tx.save(report, true));
      } catch (e) {
        // A 120-bit code does not collide; this is here so that a storage fault is retried rather than surfaced as a lost report.
        if (attempt < 2 && ((e as { code?: string }).code === '23505' || /exist/i.test((e as Error).message))) continue;
        throw e;
      }
      await tell({ kind: 'REPORT_NEW', tenantId: ch.tenantId, reportId: report.id, n: 1 });
      return c.json({ code: formatReportCode(code), ...reporterView(report) }, 201);
    }
    return c.json({ error: 'TRY_AGAIN' }, 503);
  });

  /** Finds the report a code opens. Every failure is the same answer. */
  const open = async (c: Context, body: Record<string, unknown>) => {
    const wait = limiter.take(`t:${source(c)}`, { windowMs: 600_000, max: limits.trackPerSource10Min });
    if (wait) return { limited: wait } as const;
    const ch = await channelOf(c.req.param('token') ?? '');
    const code = normaliseReportCode(body['code']);
    if (!ch || !code) return {} as const;
    const chWait = limiter.take(`ct:${ch.tenantId}:${ch.id}`, { windowMs: 60_000, max: limits.trackPerChannelMinute });
    if (chWait) return { limited: chWait } as const;
    return { ch, hash: hashReportCode(code) } as const;
  };

  app.post('/:token/track', async (c) => {
    const o = await open(c, await readJson(c));
    if ('limited' in o) return tooMany(c, o.limited!);
    if (!o.ch) return c.json(NOT_FOUND, 404);
    const r = await deps.store.reportTx(o.ch.tenantId, (tx) => tx.getByCodeHash(o.hash));
    // A code from another channel of the same organisation still opens its report: the code, not the poster, is the credential.
    return r ? c.json(reporterView(r)) : c.json(NOT_FOUND, 404);
  });

  app.post('/:token/track/reply', async (c) => {
    const body = await readJson(c);
    const o = await open(c, body);
    if ('limited' in o) return tooMany(c, o.limited!);
    if (!o.ch) return c.json(NOT_FOUND, 404);
    const ch = o.ch;
    const out = await deps.store.reportTx(ch.tenantId, async (tx) => {
      const r = await tx.getByCodeHash(o.hash);
      if (!r) return undefined;
      const next = reporterReply(r, body['text'], deps.now());
      await tx.save(next);
      return next;
    });
    if (!out) return c.json(NOT_FOUND, 404);
    await tell({ kind: 'REPORT_REPLY', tenantId: ch.tenantId, reportId: out.id, n: out.messages.length });
    return c.json(reporterView(out));
  });

  return app;
}
