import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  AccessDeniedError, ConflictOfInterestError, FieldError, TransitionBlockedError, addArtifact, addAction, applyTransition,
  assignCase, canAccess, completeAction, createCase, evaluateTransition, placeLegalHold, recordApproval, redactForActor, releaseLegalHold, setFields, SAUDI_CALENDAR, slaForCase, statutoryClocks,
} from '../engine';
import type { Principal } from './auth';
import { Directory } from './auth';
import type { Repo, Tx } from './repo';
import { RateLimiter, isHeavyRoute } from './ratelimit';
import { CASE_TYPES } from '../case-types';
import { CryptoError } from '../security/crypto';
import type { Revocations } from './revocation';
import { FileError, LegalError, extractProposals, extractText } from '../legal';
import { MAX_BYTES } from '../legal/files';
import { ARTIFACT_TYPE, describeUpload, safeName } from './documents';
import type { LegalLibrary } from '../legal';
import { ocrAvailable } from '../legal/ocr';
import type { VisionOcr } from '../legal';
import { legalStatus, syncBindings } from '../case-types/legal-sources';
import { CONSENT_VERSION, answerFromLaws, answerQuestion, consentHash, consentText, selectProvider } from '../ai';
import type { AiProviders, ChatProvider, InKingdomProvider } from '../ai';
import { dashboard as buildDashboard, search as searchCases, toCsv } from './summary';
import { NajizError } from '../najiz/types';
import { syncCase } from '../najiz/sync';
import { makeNotifier, personToActor } from './notify';
import { summarise } from './summary';
import type { NajizRegistry } from '../najiz/types';
import { NajizRuleError, approverOf, currentApprovals, assertMaySubmit, importUpdates, najizState, pendingArtifact, planPacket, reconcile, resolution } from '../najiz/workflow';

export interface AppDeps {
  repo: Repo; paidOcr?: VisionOcr;
  /** Session revocation (sign-out and admin revoke take effect immediately). */
  revocations?: Revocations;
  /** Verifies an identity-provider logout token and returns the person it names. */
  verifyLogoutToken?: (token: string) => Promise<string | undefined>;
  /** Resolves a verified Principal from an Authorization header (dev Directory or OIDC). */
  directory: { resolve(header: string | undefined): Principal | undefined | Promise<Principal | undefined>; all?(): Principal[] };
  /**
   * Public sign-in settings for the web app. In dev mode it also carries the demo user list that
   * fills the switcher, so the UI never holds its own copy of the test-user ids. Never populated
   * in oidc mode, and dev mode is refused when NODE_ENV=production.
   */
  authInfo?: { mode: 'dev' | 'oidc'; issuer?: string; clientId?: string; users?: { id: string; name: string; tenantId: string }[] };
  /** Our own (sovereign) model. */
  provider?: ChatProvider;
  /** External in-Kingdom provider, usable only for tenants with a valid signed consent. */
  inKingdom?: InKingdomProvider;
  clock?: () => string;
  /** Which Najiz gateway serves which client. Absent = Najiz is off for everyone. The simulator is refused in production. */
  najiz?: NajizRegistry;
  /** Per-user request limits per minute (see ratelimit.ts). Defaults: 300 general, 20 for AI/upload routes. */
  limits?: { perMinute?: number; heavyPerMinute?: number };
  /** Largest JSON body in bytes (default 1 MB). File uploads have their own cap. */
  maxJsonBytes?: number;
}
type Env = { Variables: { user: Principal; lang: 'ar' | 'en' } };

const T = {
  unauthenticated: { ar: 'غير مصرّح', en: 'Not authenticated' },
  notFound: { ar: 'غير موجود', en: 'Not found' },
  forbidden: { ar: 'ليس لديك صلاحية', en: 'Access denied' },
  blocked: { ar: 'لا يمكن تنفيذ الإجراء', en: 'Transition blocked' },
  conflict: { ar: 'تعارض مصالح', en: 'Conflict of interest' },
  badRequest: { ar: 'طلب غير صالح', en: 'Invalid request' },
  tooMany: { ar: 'عدد الطلبات كبير، حاول لاحقاً', en: 'Too many requests, try again shortly' },
  tooLarge: { ar: 'حجم الطلب أكبر من المسموح', en: 'Request body too large' },
  locked: { ar: 'لا يمكن تعديل هذا الحقل في الحالة الحالية', en: 'This field cannot be changed in the current state' },
} as const;

/** Arabic is the default language; English when asked (?lang=en or Accept-Language: en). */
const pickLang = (q: string | undefined, h: string | undefined): 'ar' | 'en' =>
  q === 'en' || (!q && /^en/i.test(h ?? '')) ? 'en' : 'ar';

const STATIC = new Set(['/', '/index.html', '/auth.js', '/style.css', '/favicon.ico', '/auth/config']);

export function createApp(deps: AppDeps) {
  const { repo, directory, paidOcr } = deps;
  // Remember who has signed in (names for the UI, assignable people, management chain). At most every 10 minutes per person.
  const notifier = makeNotifier(repo, () => now());
  const touched = new Map<string, number>();
  const touchPerson = async (u: Principal) => {
    if (u.tenantId === 'platform' || (u.kind !== 'human' && u.kind !== 'external')) return;
    const k = `${u.tenantId}|${u.id}`; const n = Date.now();
    if ((touched.get(k) ?? 0) > n - 600_000) return;
    touched.set(k, n);
    try { await repo.touchPerson({ id: u.id, name: u.name, kind: u.kind, tenantId: u.tenantId, departments: u.departments, roles: u.roles, reportsTo: u.reportsTo, lastSeen: new Date().toISOString(), clearance: u.clearance, email: u.email ?? null, ...(u.counselMatterIds ? { counselMatterIds: u.counselMatterIds } : {}) }); }
    catch (e) { touched.delete(k); console.error('touchPerson failed', (e as Error).message); }
  };
  const peopleOf = async (tenantId: string) => {
    const m = new Map((await repo.listPeople(tenantId)).map((p) => [p.id, p]));
    for (const u of directory.all?.() ?? []) if (u.tenantId === tenantId && !m.has(u.id) && (u.kind === 'human' || u.kind === 'external'))
      m.set(u.id, { id: u.id, name: u.name, kind: u.kind, tenantId, departments: u.departments, roles: u.roles, reportsTo: u.reportsTo, lastSeen: '', clearance: u.clearance, email: u.email ?? null, ...(u.counselMatterIds ? { counselMatterIds: u.counselMatterIds } : {}) });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const providers: AiProviders = { ...(deps.provider ? { sovereign: deps.provider } : {}), ...(deps.inKingdom ? { inKingdom: deps.inKingdom } : {}) };
  const now = deps.clock ?? (() => new Date().toISOString());
  const app = new Hono<Env>();
  const isUpload = (m: string, p: string) => m === 'POST' && (p === '/laws/files' || /^\/cases\/[^/]+\/documents$/.test(p));
  const limiter = new RateLimiter();
  const generalMax = deps.limits?.perMinute ?? 300;
  const heavyMax = deps.limits?.heavyPerMinute ?? 20;

  // Body size is capped before anything is read: JSON 1 MB, law file upload 25 MB plus multipart overhead.
  const tooLarge = (c: any) => c.json({ error: 'PAYLOAD_TOO_LARGE', message: T.tooLarge[c.get('lang') as 'ar' | 'en'] }, 413);
  const jsonCap = bodyLimit({ maxSize: deps.maxJsonBytes ?? 1024 * 1024, onError: tooLarge });
  const fileCap = bodyLimit({ maxSize: MAX_BYTES + 1024 * 1024, onError: tooLarge });
  app.use('*', async (c, next) => { c.set('lang', pickLang(c.req.query('lang'), c.req.header('accept-language'))); return (isUpload(c.req.method, c.req.path) ? fileCap : jsonCap)(c, next); });

  app.use('*', async (c, next) => {
    c.set('lang', pickLang(c.req.query('lang'), c.req.header('accept-language')));
    c.header('content-language', c.get('lang'));
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const idp = deps.authInfo?.issuer ? new URL(deps.authInfo.issuer).origin : '';
    c.header('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${idp}; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${idp}`.replace(/\s+;/g, ';'));
    c.header('cache-control', 'no-store');
    if (c.req.path === '/health' || c.req.path === '/auth/backchannel-logout' || STATIC.has(c.req.path) || /^\/ui\/[a-z0-9-]+\.js$/.test(c.req.path)) return next();
    const user = await directory.resolve(c.req.header('authorization'));
    if (!user) return c.json({ error: 'UNAUTHENTICATED', message: T.unauthenticated[c.get('lang')] }, 401);
    c.set('user', user);
    void touchPerson(user);
    // Per-user limits, after sign-in so the key is the verified account, never a header the caller controls.
    const heavy = isHeavyRoute(c.req.method, c.req.path);
    const wait = limiter.take(`${heavy ? 'h' : 'g'}:${user.tenantId}:${user.id}`, { windowMs: 60_000, max: heavy ? heavyMax : generalMax });
    if (wait) { c.header('retry-after', String(wait)); return c.json({ error: 'RATE_LIMITED', message: T.tooMany[c.get('lang')] }, 429); }
    return next();
  });

  app.onError((err, c) => {
    const lang = c.get('lang') ?? 'ar';
    if (err instanceof TransitionBlockedError) {
      return c.json({ error: 'BLOCKED', message: T.blocked[lang], blockers: err.blockers.map((b) => ({ code: b.code, message: lang === 'ar' ? b.messageAr ?? b.message : b.message })) }, 409);
    }
    if (err instanceof NajizRuleError) return c.json({ error: 'NAJIZ_BLOCKED', code: err.code, message: T.blocked[lang] }, 409);
    if (err instanceof AccessDeniedError) return c.json({ error: 'FORBIDDEN', reason: err.reason, message: T.forbidden[lang] }, 403);
    if (err instanceof FieldError) return c.json({ error: err.kind === 'LOCKED' ? 'FIELD_LOCKED' : 'INVALID_FIELDS', problems: err.problems, message: err.kind === 'LOCKED' ? T.locked[lang] : T.badRequest[lang] }, err.kind === 'LOCKED' ? 409 : 400);
    if (err instanceof ConflictOfInterestError) return c.json({ error: 'CONFLICT_OF_INTEREST', codes: err.codes, message: T.conflict[lang] }, 409);
    if (err instanceof FileError) return c.json({ error: err.code, message: T.badRequest[lang] }, err.code === 'FILE_TOO_LARGE' ? 413 : err.code === 'OCR_NOT_INSTALLED' ? 503 : 400);
    if (err instanceof LegalError) return c.json({ error: err.code, message: T.forbidden[lang] }, err.code === 'UNKNOWN_VERSION' || err.code === 'UNKNOWN_INSTRUMENT' ? 404 : 403);
    if ((err as { code?: string }).code === '23505' || (err as Error).message === 'CASE_EXISTS') return c.json({ error: 'CASE_EXISTS', message: T.badRequest[lang] }, 409);
    // Stored data could not be decrypted (wrong/missing key, tampering): fail closed, say nothing about why.
    if (err instanceof CryptoError) { console.error(`decryption failure: ${err.code}`); return c.json({ error: 'SERVER_ERROR', message: T.badRequest[lang] }, 500); }
    // Never leak internals.
    return c.json({ error: 'BAD_REQUEST', message: T.badRequest[lang] }, 400);
  });

  // Called by the identity provider (no user session): the signature on the logout token is the authentication.
  app.post('/auth/backchannel-logout', async (c) => {
    c.header('cache-control', 'no-store');
    if (!deps.verifyLogoutToken || !deps.revocations) return c.json({ error: 'NOT_ENABLED' }, 404);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const tok = typeof form['logout_token'] === 'string' ? form['logout_token'] : '';
    const sub = tok ? await deps.verifyLogoutToken(tok) : undefined;
    if (!sub) return c.json({ error: 'INVALID_LOGOUT_TOKEN' }, 400);
    await deps.revocations.revoke(sub);
    return c.body(null, 200);
  });
  // A client admin ends every session of one person (a leaver, a lost laptop). Effective on all servers within seconds.
  app.post('/admin/revoke-sessions', async (c) => {
    const user = c.get('user');
    if (user.tenantId === 'platform' || !user.roles.includes('tenant_admin')) throw new AccessDeniedError('ROLE_REQUIRED:tenant_admin');
    if (!deps.revocations) return c.json({ error: 'NOT_ENABLED' }, 404);
    const b = await c.req.json<{ subject?: string }>().catch(() => ({} as { subject?: string }));
    if (!b.subject || typeof b.subject !== 'string' || b.subject.length > 200) return c.json({ error: 'INVALID_FIELDS' }, 400);
    if (!(await peopleOf(user.tenantId)).some((x) => x.id === b.subject)) return c.json({ error: 'UNKNOWN_PERSON' }, 404); // only people of your own organisation
    await deps.revocations.revoke(b.subject);
    console.log(JSON.stringify({ event: 'sessions_revoked', by: user.id, tenant: user.tenantId, subject: b.subject }));
    return c.json({ ok: true });
  });

  app.get('/auth/config', (c) => c.json(deps.authInfo ?? { mode: 'dev' }));
  app.get('/me', (c) => { const u = c.get('user'); return c.json({ id: u.id, name: u.name, tenantId: u.tenantId, roles: u.roles, departments: u.departments, kind: u.kind, clearance: u.clearance }); });
  // Public liveness only. Capability details (OCR, paid OCR) need a platform sign-in.
  // Names for ids, and who can be assigned. Roles and last sign-in are for tenant admins only.
  app.get('/people', async (c) => {
    const u = c.get('user'); if (u.tenantId === 'platform') return c.json([]);
    const admin = u.roles.includes('tenant_admin');
    return c.json((await peopleOf(u.tenantId)).map((p) => ({ id: p.id, name: p.name, kind: p.kind, departments: p.departments, ...(admin ? { roles: p.roles, lastSeen: p.lastSeen } : {}) })));
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/health/details', async (c) => {
    if (c.get('user').tenantId !== 'platform') return nf(c);
    return c.json({ ok: true, ocr: await ocrAvailable(), paidOcrForPlatformLaw: Boolean(paidOcr) });
  });

  // Not-found and not-permitted look identical so existence is not leaked across walls.
  const load = async (tx: Tx, id: string, user: Principal, action: 'read' | 'write' | 'transition' = 'read', lock = false) => {
    const cs = await tx.getCase(id, lock);
    if (!cs || cs.tenantId !== user.tenantId || !canAccess(user, cs, action).allowed) return undefined;
    return cs;
  };
  const nf = (c: any) => c.json({ error: 'NOT_FOUND', message: T.notFound[c.get('lang') as 'ar' | 'en'] }, 404);
  /**
   * The ONLY way a case leaves the API. Every route that returns a case goes through this, so a sealed
   * reporter or a masked personal field can never be read back from a write response.
   * (Regression: write routes once returned the stored case, leaking the sealed reporter to HR managers.)
   */
  const view = (cs: any, user: Principal) => redactForActor(CASE_TYPES[cs.caseTypeKey]!, cs, user);

  // ---- Cases -----------------------------------------------------------------
  app.get('/case-types', async (c) => {
    const lib = await repo.lib(c.get('user').tenantId, 'read', (l) => l);
    return c.json(Object.values(CASE_TYPES).map((d) => ({ key: d.key, domain: d.domain, label: d.label, legalReview: d.legalReview.status, legal: legalStatus(lib, d.key),
      states: d.states.map((x) => ({ key: x.key, label: x.label, kind: x.kind ?? 'OPEN' })),
      artifactTypes: [...new Set([...d.transitions.flatMap((t) => t.guards).flatMap((g: any) => (g.kind === 'artifact_present' ? [g.artifactType] : [])), 'evidence', ...(d.domain === 'LEGAL' ? ['exhibit'] : [])])],
      fields: d.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options ?? null, sensitivity: f.sensitivity, required: Boolean(f.required), lockedIn: f.lockedIn ?? [] })) })));
  });

  app.post('/cases', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ id?: string; caseType: string; fields?: Record<string, unknown>; parties?: any[] }>();
    const def = CASE_TYPES[b.caseType];
    if (!def) return c.json({ error: 'UNKNOWN_CASE_TYPE' }, 400);
    // No id given: the server numbers the case (HR-2026-K7M2QX). Collisions are retried; a client-chosen id still works.
    const prefix = { HR: 'HR', SECURITY: 'SEC', AUDIT: 'AUD', LEGAL: 'LEG' }[def.domain] ?? 'CS';
    const gen = () => `${prefix}-${now().slice(0, 4)}-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (x) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[x % 31]).join('')}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = b.id || gen();
      // For a party who is a known person, their management chain comes from the directory, not from the form.
      const known = new Map((await peopleOf(user.tenantId)).map((p) => [p.id, p]));
      const parties = (b.parties ?? []).map((p) => (p && known.has(p.personId) ? { ...p, reportsTo: known.get(p.personId)!.reportsTo } : p));
      const m = createCase(def, { id, fields: b.fields ?? {}, parties }, user, now());
      try { await repo.tx(user, (tx) => tx.saveCase(m.case, m.event, true)); return c.json(view(m.case, user), 201); }
      catch (e) { if (b.id || !((e as { code?: string }).code === '23505' || (e as Error).message === 'CASE_EXISTS')) throw e; }
    }
    return c.json({ error: 'CASE_EXISTS' }, 409);
  });

  app.get('/cases', async (c) => {
    const user = c.get('user');
    const all = await repo.tx(user, (tx) => tx.listCases());
    return c.json(all.filter((x) => canAccess(user, x, 'read').allowed).map((x) => view(x, user)));
  });

  // Lists and the home page are built from redacted summaries (see summary.ts): no sealed or personal value can enter them.
  app.get('/cases/search', async (c) => {
    const user = c.get('user');
    const q = c.req.query();
    const all = await repo.tx(user, (tx) => tx.listCases());
    return c.json(searchCases(all, user, CASE_TYPES, now(), {
      q: q['q'] ?? '', state: q['state'] ?? '', dept: q['dept'] ?? '', type: q['type'] ?? '', mine: q['mine'] === '1', open: q['open'] === '1', overdue: q['overdue'] === '1', due: Number(q['due']) || 0, needsAction: q['needs'] === '1',
      sort: q['sort'] ?? 'updated', order: q['order'] === 'asc' ? 'asc' : 'desc', page: Number(q['page']) || 1, pageSize: Number(q['pageSize']) || 20,
    }));
  });
  // Same filters as the list; summaries only (no sealed or personal values), capped at 5,000 rows.
  app.get('/cases/export.csv', async (c) => {
    const user = c.get('user');
    const q = c.req.query();
    const all = await repo.tx(user, (tx) => tx.listCases());
    const base = { q: q['q'] ?? '', state: q['state'] ?? '', dept: q['dept'] ?? '', type: q['type'] ?? '', mine: q['mine'] === '1', open: q['open'] === '1', overdue: q['overdue'] === '1', due: Number(q['due']) || 0, needsAction: q['needs'] === '1', sort: q['sort'] ?? 'updated', order: (q['order'] === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc', pageSize: 100 };
    const items = [];
    for (let page = 1; page <= 50; page++) { const r = searchCases(all, user, CASE_TYPES, now(), { ...base, page }); items.push(...r.items); if (page * 100 >= r.total) break; }
    return new Response(toCsv(items), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cases-${now().slice(0, 10)}.csv"`, 'cache-control': 'no-store' } });
  });
  app.get('/dashboard', async (c) => {
    const user = c.get('user');
    const all = await repo.tx(user, (tx) => tx.listCases());
    return c.json(buildDashboard(all, user, CASE_TYPES, now()));
  });

  app.get('/cases/:id', async (c) => {
    const user = c.get('user');
    const cs = await repo.tx(user, (tx) => load(tx, c.req.param('id'), user));
    if (!cs) return nf(c);
    const def = CASE_TYPES[cs.caseTypeKey]!;
    const actions = def.transitions
      .filter((t) => t.from.includes(cs.state))
      .map((t) => {
        const ev = evaluateTransition(def, cs, t.action, user);
        const lang = c.get('lang');
        return { action: t.action, label: t.label, allowed: ev.allowed, blockers: ev.blockers.map((b) => ({ code: b.code, message: lang === 'ar' ? b.messageAr ?? b.message : b.message })) };
      });
    const nowIso = now();
    const kind = def.states.find((x) => x.key === cs.state)?.kind ?? 'OPEN';
    const deadlines = { sla: kind === 'OPEN' ? slaForCase(def, cs, SAUDI_CALENDAR, nowIso) : null, clocks: statutoryClocks(def, cs, SAUDI_CALENDAR, nowIso) };
    return c.json({ case: view(cs, user), actions, deadlines });
  });

  app.post('/cases/:id/transitions/:action', async (c) => {
    const user = c.get('user');
    // Row lock: two people acting on one case are serialised, so guards always see the latest state.
    const out = await repo.tx(user, async (tx) => {
      const cs = await load(tx, c.req.param('id'), user, 'transition', true);
      if (!cs) return undefined;
      const m = applyTransition(CASE_TYPES[cs.caseTypeKey]!, cs, c.req.param('action'), user, now());
      await tx.saveCase(m.case, m.event);
      return m.case;
    });
    if (out?.assignee) {
      const a = (await peopleOf(user.tenantId)).find((x) => x.id === out.assignee!.id);
      await notifier.notify(out, [a], 'STATE_CHANGED', user.id).catch((e) => console.error('notify failed', (e as Error).message));
    }
    return out ? c.json(view(out, user)) : nf(c);
  });

  const mutate = (fn: (cs: any, user: Principal, body: any, c: any) => { case: any; event: any }, action: 'write' | 'transition' = 'write') =>
    async (c: any) => {
      const user = c.get('user') as Principal;
      const body = await c.req.json().catch(() => ({}));
      const out = await repo.tx(user, async (tx) => {
        const cs = await load(tx, c.req.param('id'), user, action, true);
        if (!cs) return undefined;
        const m = fn(cs, user, body, c);
        await tx.saveCase(m.case, m.event);
        return m.case;
      });
      return out ? c.json(view(out, user)) : nf(c);
    };
  app.patch('/cases/:id/fields', mutate((cs, u, b) => setFields(cs, b, u, now(), CASE_TYPES[cs.caseTypeKey]!)));
  app.post('/cases/:id/artifacts', mutate((cs, u, b) => {
    if (b?.type === 'note') throw new FieldError('VALIDATION', [{ field: 'type', code: 'USE_NOTES_ENDPOINT' }]); // notes have their own validated route
    return addArtifact(cs, b, u, now());
  }));
  // ---- Notes: a discussion on the case. Stored as append-only, timestamped, encrypted case records, visible to everyone who can see the case.
  app.post('/cases/:id/notes', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ text?: unknown; mentions?: unknown }>().catch(() => ({} as { text?: unknown; mentions?: unknown }));
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const mentions = Array.isArray(b.mentions) ? [...new Set(b.mentions.filter((x): x is string => typeof x === 'string'))] : [];
    if (!text || text.length > 5000 || mentions.length > 20) return c.json({ error: 'INVALID_FIELDS' }, 400);
    const people = await peopleOf(user.tenantId);
    const known = mentions.map((id) => people.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
    const noteId = `note-${crypto.randomUUID().slice(0, 12)}`;
    const out = await repo.tx(user, async (tx) => {
      const cs = await load(tx, c.req.param('id'), user, 'write', true);
      if (!cs) return undefined;
      const m = addArtifact(cs, { id: noteId, type: 'note', payload: { text, mentions: known.map((p) => p.id) } }, user, now());
      await tx.saveCase(m.case, m.event);
      return m.case;
    });
    if (!out) return nf(c);
    // Only people who may read this case are told; the author learns who could not be reached (so nothing is silently dropped).
    const reachable = known.filter((p) => canAccess(personToActor(p), out, 'read').allowed);
    await notifier.notify(out, reachable, 'MENTIONED', user.id).catch((e) => console.error('notify failed', (e as Error).message));
    return c.json({ case: view(out, user), noteId, notReached: known.filter((p) => !reachable.includes(p)).map((p) => p.id) }, 201);
  });

  // ---- Notifications (own only). A notification names an event on a case; it holds no case content.
  app.get('/notifications', async (c) => {
    const user = c.get('user'); if (user.tenantId === 'platform') return c.json({ items: [], unread: 0 });
    const unreadOnly = c.req.query('unread') === '1';
    const items = await repo.listNotifications(user.tenantId, user.id, { unreadOnly, limit: 50 });
    const cases = new Map<string, any>();
    await repo.tx(user, async (tx) => { for (const id of new Set(items.map((n) => n.caseId))) { const cs = await tx.getCase(id); if (cs && canAccess(user, cs, 'read').allowed) cases.set(id, summarise(cs, user, CASE_TYPES[cs.caseTypeKey]!, now())); } });
    return c.json({ unread: await repo.countUnread(user.tenantId, user.id), items: items.map((n) => ({ id: n.id, kind: n.kind, caseId: n.caseId, actorId: n.actorId ?? null, createdAt: n.createdAt, read: Boolean(n.readAt), case: cases.get(n.caseId) ?? null })) });
  });
  app.get('/notifications/count', async (c) => { const u = c.get('user'); return c.json({ unread: u.tenantId === 'platform' ? 0 : await repo.countUnread(u.tenantId, u.id) }); });
  app.post('/notifications/read', async (c) => {
    const u = c.get('user'); const b = await c.req.json<{ ids?: unknown; all?: unknown }>().catch(() => ({} as { ids?: unknown; all?: unknown }));
    const ids = b.all === true ? 'all' as const : Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
    if (ids === 'all' || ids.length) await repo.markRead(u.tenantId, u.id, ids, now());
    return c.json({ unread: await repo.countUnread(u.tenantId, u.id) });
  });
  app.get('/notifications/settings', async (c) => { const u = c.get('user'); const me = (await peopleOf(u.tenantId)).find((p) => p.id === u.id); return c.json({ emailOptout: Boolean(me?.emailOptout), hasEmail: Boolean(u.email) }); });
  app.put('/notifications/settings', async (c) => {
    const u = c.get('user'); const b = await c.req.json<{ emailOptout?: unknown }>().catch(() => ({} as { emailOptout?: unknown }));
    if (typeof b.emailOptout !== 'boolean') return c.json({ error: 'INVALID_FIELDS' }, 400);
    await touchPerson(u); await repo.setEmailOptout(u.tenantId, u.id, b.emailOptout);
    return c.json({ emailOptout: b.emailOptout });
  });

  // The assignee is looked up server-side: the management chain used for conflict-of-interest checks must not come from the request.
  app.post('/cases/:id/assignee', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));
    const p = typeof b.id === 'string' ? (await peopleOf(user.tenantId)).find((x) => x.id === b.id) : undefined;
    if (!p) return c.json({ error: 'UNKNOWN_ASSIGNEE', message: T.badRequest[c.get('lang')] }, 422);
    const out = await repo.tx(user, async (tx) => {
      const cs = await load(tx, c.req.param('id'), user, 'write', true);
      if (!cs) return undefined;
      const m = assignCase(cs, { id: p.id, reportsTo: p.reportsTo }, user, now());
      await tx.saveCase(m.case, m.event);
      return m.case;
    });
    if (out) await notifier.notify(out, [p], 'ASSIGNED', user.id).catch((e) => console.error('notify failed', (e as Error).message));
    return out ? c.json(view(out, user)) : nf(c);
  });
  app.post('/cases/:id/actions', mutate((cs, u, b) => addAction(cs, b, u, now())));
  app.post('/cases/:id/actions/:aid/complete', mutate((cs, u, _b, c) => completeAction(cs, c.req.param('aid'), u, now())));
  app.post('/cases/:id/approvals', mutate((cs, u, b) => recordApproval(cs, b.role, u, now()), 'transition'));
  app.post('/cases/:id/legal-hold', mutate((cs, u, b) => placeLegalHold(cs, u, b.reason, now())));
  app.delete('/cases/:id/legal-hold', mutate((cs, u, b) => releaseLegalHold(cs, u, b.reason ?? '', now())));

  app.get('/cases/:id/audit', async (c) => {
    const user = c.get('user');
    const r = await repo.tx(user, async (tx) => {
      const cs = await load(tx, c.req.param('id'), user);
      return cs ? tx.getAudit(cs.id) : undefined;
    });
    return r ? c.json({ events: r, integrity: repo.verifyChain(r) }) : nf(c);
  });

  // ---- Case documents ------------------------------------------------------------------
  // The bytes behind an artifact. Upload stores them under their SHA-256 and adds the artifact carrying that hash in one
  // step, so "evidence" and "filing" always point at exactly what was stored. Same access rule as editing the case.
  app.post('/cases/:id/documents', async (c) => {
    const user = c.get('user');
    const form = await c.req.parseBody();
    const f = form['file'];
    const type = String(form['type'] ?? '');
    if (!(f instanceof File) || !ARTIFACT_TYPE.test(type)) throw new FileError('NO_FILE');
    const bytes = new Uint8Array(await f.arrayBuffer());
    const d = describeUpload(bytes);
    const name = safeName(f.name);
    const caseId = c.req.param('id');
    const found = await repo.tx(user, (tx) => load(tx, caseId, user, 'write'));
    if (!found) return nf(c);
    await repo.putCaseDocument(user, caseId, { sha256: d.sha256, name, mime: d.mime, bytes, uploadedBy: user.id, uploadedAt: now() });
    const out = await repo.tx(user, async (tx) => {
      const cs = await load(tx, caseId, user, 'write', true);
      if (!cs) return undefined;
      const m = addArtifact(cs, { id: `${type}-${d.sha256.slice(0, 16)}`, type, hash: d.sha256, payload: { name, mime: d.mime, size: d.size } }, user, now());
      await tx.saveCase(m.case, m.event);
      return m.case;
    });
    return out ? c.json({ sha256: d.sha256, artifactId: `${type}-${d.sha256.slice(0, 16)}`, case: view(out, user) }, 201) : nf(c);
  });
  app.get('/cases/:id/documents/:sha256', async (c) => {
    const user = c.get('user');
    const sha = c.req.param('sha256');
    if (!/^[0-9a-f]{64}$/.test(sha)) return nf(c);
    // 'write' access, not 'read': audit-assurance read-across covers the redacted case view, never the document bytes
    // (an exhibit can contain exactly what redaction hides, such as a reporter's name).
    const cs = await repo.tx(user, (tx) => load(tx, c.req.param('id'), user, 'write'));
    if (!cs || !cs.artifacts.some((a) => a.hash === sha)) return nf(c); // only documents the case actually references
    const doc = await repo.getCaseDocument(user, cs.id, sha);
    if (!doc) return nf(c);
    return new Response(new Blob([Buffer.from(doc.bytes)]), { headers: { 'content-type': doc.mime, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' } });
  });

  // ---- Najiz (court filing) --------------------------------------------------------------
  // See src/najiz/workflow.ts for the rules. The simulator is a stand-in until a client has Najiz access; it is refused
  // in production so a fake filing can never be mistaken for a real one.
  const najizFor = (tenantId: string) => {
    const gw = deps.najiz?.gatewayFor(tenantId);
    const claimant = deps.najiz?.claimantFor(tenantId);
    if (!gw || !claimant || (gw.simulated && process.env['NODE_ENV'] === 'production')) return undefined;
    return { gw, claimant };
  };
  const najizOff = (c: any) => c.json({ error: 'NAJIZ_NOT_ENABLED', message: T.notFound[c.get('lang') as 'ar' | 'en'] }, 404);
  const najizNotReady = (c: any) => c.json({ error: 'NAJIZ_CONTRACT_NOT_CONFIGURED' }, 503);

  app.get('/cases/:id/najiz', async (c) => {
    const user = c.get('user');
    const cs = await repo.tx(user, (tx) => load(tx, c.req.param('id'), user, 'write'));
    if (!cs || cs.caseTypeKey !== 'legal.matter') return nf(c);
    const nz = najizFor(user.tenantId);
    if (!nz) return c.json({ enabled: false });
    const st = najizState(cs);
    let preview: unknown = null;
    let blockedBy: string | null = null;
    try { preview = planPacket(cs, nz.claimant, st.attempts).packet; } catch (e) { if (e instanceof NajizRuleError) blockedBy = e.code; else throw e; }
    if (!blockedBy) { try { assertMaySubmit(CASE_TYPES[cs.caseTypeKey]!, cs, user); } catch (e) { blockedBy = e instanceof NajizRuleError ? e.code : e instanceof AccessDeniedError ? e.reason : 'BLOCKED'; } }
    return c.json({ enabled: true, simulated: nz.gw.simulated, configured: nz.gw.configured, gateway: nz.gw.name, ...st, canSubmit: !blockedBy && nz.gw.configured, blockedBy, approvedBy: currentApprovals(cs), preview });
  });

  app.post('/cases/:id/najiz/submit', async (c) => {
    const user = c.get('user');
    const nz = najizFor(user.tenantId);
    if (!nz) return najizOff(c);
    if (!nz.gw.configured) return najizNotReady(c);
    const caseId = c.req.param('id');
    // Step 1 (locked): check every rule, build the packet from the allowlist, and COMMIT the attempt before anything is sent.
    const prep = await repo.tx(user, async (tx) => {
      const cs = await load(tx, caseId, user, 'write', true);
      if (!cs) return undefined;
      const def = CASE_TYPES[cs.caseTypeKey]!;
      const st = assertMaySubmit(def, cs, user);
      const plan = planPacket(cs, nz.claimant, st.attempts);
      const m = addArtifact(cs, pendingArtifact(plan, user, now(), approverOf(cs, user), nz.gw.simulated), user, now());
      await tx.saveCase(m.case, m.event);
      return { plan, key: plan.packet.idempotencyKey };
    });
    if (!prep) return nf(c);
    const attachments = [];
    for (const a of prep.plan.packet.attachments) {
      const doc = await repo.getCaseDocument(user, caseId, a.sha256);
      if (!doc) { attachments.length = 0; break; }
      attachments.push({ ...a, bytes: doc.bytes });
    }
    // Step 2 (no transaction held): the call. Step 3 (locked): record what happened.
    let outcome: Parameters<typeof resolution>[1];
    if (attachments.length !== prep.plan.packet.attachments.length) outcome = { err: new NajizError('UNAVAILABLE', 'DOCUMENT_BYTES_MISSING') }; // nothing was sent
    else {
      try { outcome = { ok: await nz.gw.submitFiling({ ...prep.plan.packet, attachments }) }; }
      catch (e) { outcome = { err: e instanceof NajizError ? e : new NajizError('AMBIGUOUS') }; }
    }
    const art = resolution(prep.key, outcome, nz.gw.simulated);
    const out = await repo.tx(user, async (tx) => {
      const cs = await load(tx, caseId, user, 'write', true);
      if (!cs) return undefined;
      const m = addArtifact(cs, art, user, now());
      await tx.saveCase(m.case, m.event);
      return m.case;
    });
    if (!out) return nf(c);
    if ('ok' in outcome) return c.json({ status: 'SUBMITTED', najizRef: outcome.ok.najizRef, najiz: outcome.ok.status, simulated: nz.gw.simulated, case: view(out, user) }, 201);
    const code = outcome.err.code;
    const http = code === 'REJECTED' ? 422 : code === 'AMBIGUOUS' ? 502 : 503;
    return c.json({ error: 'NAJIZ_' + code, outcome: code === 'AMBIGUOUS' ? 'UNCONFIRMED_RECONCILE_REQUIRED' : code === 'REJECTED' ? 'REJECTED_CORRECT_AND_RESUBMIT' : 'NOT_SENT_SAFE_TO_RETRY', ...(code === 'REJECTED' && outcome.err.detail ? { reason: outcome.err.detail.slice(0, 500) } : {}), case: view(out, user) }, http);
  });

  app.post('/cases/:id/najiz/reconcile', mutate((cs, u, b) => reconcile(cs, u, b ?? {}, now()), 'transition'));

  app.post('/cases/:id/najiz/sync', async (c) => {
    const user = c.get('user');
    const nz = najizFor(user.tenantId);
    if (!nz) return najizOff(c);
    if (!nz.gw.configured) return najizNotReady(c);
    const caseId = c.req.param('id');
    const cs0 = await repo.tx(user, (tx) => load(tx, caseId, user, 'write'));
    if (!cs0 || cs0.caseTypeKey !== 'legal.matter') return nf(c);
    if (!user.roles.includes('legal_counsel')) throw new AccessDeniedError('ROLE_REQUIRED:legal_counsel');
    const r = await syncCase(repo, nz.gw, user, caseId, now);
    if (!r.ok) return r.error === 'NOT_FOUND' ? nf(c) : c.json({ error: 'NAJIZ_' + r.error }, r.error === 'REJECTED' ? 422 : 503);
    return c.json({ status: r.status, imported: r.imported, case: view(r.case, user) });
  });

  // ---- Legal library -----------------------------------------------------------
  const lp = (u: Principal) => ({ id: u.id, roles: u.roles, tenantId: u.tenantId });
  const rd = <T>(c: any, fn: (lib: LegalLibrary, u: ReturnType<typeof lp>) => T) => repo.lib(c.get('user').tenantId, 'read', (l) => fn(l, lp(c.get('user'))));
  const wr = <T>(c: any, fn: (lib: LegalLibrary, u: ReturnType<typeof lp>) => T) => repo.lib(c.get('user').tenantId, 'write', (l) => fn(l, lp(c.get('user'))));

  app.get('/laws', async (c) => {
    const user = c.get('user');
    const date = c.req.query('asOf') ?? now().slice(0, 10);
    return c.json(await rd(c, (l) => l.verifiedProvisions(user.tenantId, date).map((p) => ({ instrument: p.instrument.titleAr, instrumentEn: p.instrument.titleEn, version: p.version.versionLabel, effectiveFrom: p.version.effectiveFrom, article: p.provision.number, textAr: p.provision.textAr, textEn: p.provision.textEn }))));
  });
  app.post('/laws/instruments', async (c) => { const b = await c.req.json(); await wr(c, (l, u) => l.addInstrument(b, u, now())); return c.json(b, 201); });
  // One upload: split into articles and go straight to review. The reviewer's single action is verify.
  app.post('/laws/versions', async (c) => {
    const body = await c.req.json();
    const r = await wr(c, (l, u) => {
      const up = l.uploadVersion(body, u, now());
      l.submitForReview(up.version.id, u, now());
      return { ...up, version: l.versions.get(up.version.id)!, scope: l.instruments.get(up.version.instrumentId)!.tenantId };
    });
    // Extraction runs in the background; the upload never waits on the model or fails because of it.
    const tenantId = c.get('user').tenantId;
    const pick = selectProvider('platform', { tenantId: 'platform', mode: 'SOVEREIGN' }, providers);
    if (pick.ok) void extractProposals(r.version, r.scope, pick.provider).then((x) => repo.lib(tenantId, 'write', (l) => l.storeProposals(x.proposals))).catch(() => {});
    return c.json({ version: r.version, warnings: r.warnings }, 201);
  });
  app.get('/laws/review', async (c) => c.json(await rd(c, (l, u) => l.versionsFor(u).map((v) => ({ ...v, proposals: l.proposalsFor(v.id, u) })))));
  // File in, text out: nothing is stored as law until a person uploads the (edited) text and another verifies it.
  app.post('/laws/files', async (c) => {
    const u = lp(c.get('user'));
    if (!u.roles.includes('legal_content_editor')) throw new LegalError('ROLE_REQUIRED:legal_content_editor');
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) throw new FileError('NO_FILE');
    const bytes = new Uint8Array(await f.arrayBuffer());
    // Scope is decided here from the authenticated tenant, never from the request.
    const out = await extractText(bytes, { scope: u.tenantId === 'platform' ? 'platform' : 'client', ...(paidOcr ? { paidOcr } : {}) });
    await repo.putFile(u.tenantId, { sha256: out.sha256, name: f.name, bytes, uploadedBy: u.id });
    return c.json({ text: out.text, kind: out.kind, method: out.method, confidence: out.confidence, sha256: out.sha256, warnings: out.warnings });
  });
  app.post('/laws/bindings/sync', async (c) => c.json(await wr(c, (l, u) => syncBindings(l, u, now()))));
  app.post('/laws/bindings/:id/reapprove', async (c) => c.json(await wr(c, (l, u) => l.reapproveBinding(decodeURIComponent(c.req.param('id')), u, now()))));
  app.get('/laws/bindings', async (c) => c.json(await rd(c, (l) => [...l.bindings.values()])));
  app.post('/laws/versions/:id/extract', async (c) => {
    const id = c.req.param('id');
    const { v, scope } = await rd(c, (l, u) => {
      if (!l.canSeeProposals(id, u)) throw new LegalError('SCOPE_MISMATCH');
      const ver = l.versions.get(id)!;
      return { v: ver, scope: l.instruments.get(ver.instrumentId)!.tenantId };
    });
    const pick = selectProvider('platform', { tenantId: 'platform', mode: 'SOVEREIGN' }, providers);
    if (!pick.ok) throw new LegalError('NO_AI_PROVIDER');
    const x = await extractProposals(v, scope, pick.provider);
    await wr(c, (l) => l.storeProposals(x.proposals));
    return c.json({ proposals: x.proposals.length, droppedUnquoted: x.droppedUnquoted });
  });
  app.post('/laws/proposals/:id/:decision', async (c) => c.json(await wr(c, (l, u) => l.decideProposal(c.req.param('id'), c.req.param('decision') === 'accept', u))));
  app.post('/laws/versions/:id/submit', async (c) => c.json(await wr(c, (l, u) => l.submitForReview(c.req.param('id'), u, now()))));
  app.post('/laws/versions/:id/verify', async (c) => { const note = (await c.req.json()).note ?? ''; return c.json(await wr(c, (l, u) => l.verify(c.req.param('id'), u, note, now()))); });
  app.post('/laws/versions/:id/reject', async (c) => { const note = (await c.req.json()).note ?? ''; return c.json(await wr(c, (l, u) => l.reject(c.req.param('id'), u, note, now()))); });
  app.get('/laws/versions/:id', async (c) => { const v = await rd(c, (l) => l.versions.get(c.req.param('id'))); return v ? c.json(v) : nf(c); });
  app.get('/laws/stale-rules', async (c) => c.json(await rd(c, (l) => l.staleBindings())));

  // ---- AI (always drafts) ------------------------------------------------------
  const engineOf = (sel: Extract<ReturnType<typeof selectProvider>, { ok: true }>) => ({ mode: sel.mode, label: sel.label });
  const choose = async (user: Principal) => selectProvider(user.tenantId, await repo.getAiSettings(user.tenantId), providers);
  const unavailable = (c: any) => c.json({ error: 'AI_UNAVAILABLE', message: c.get('lang') === 'ar' ? 'الذكاء الاصطناعي غير مفعّل لمنشأتك' : 'AI is not enabled for your organisation' }, 503);
  const logCall = (user: Principal, kind: string, sel: Extract<ReturnType<typeof selectProvider>, { ok: true }>, extra: Record<string, unknown> = {}) =>
    repo.logAi(user.tenantId, { at: now(), actorId: user.id, type: 'ai.call', data: { kind, mode: sel.mode, provider: sel.label, model: sel.provider.model, ...extra } });

  app.post('/ai/laws', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ question: string; caseId?: string }>();
    const sel = await choose(user);
    if (!sel.ok) return unavailable(c);
    let asOf = now().slice(0, 10);
    if (b.caseId) {
      const cs = await repo.tx(user, (tx) => load(tx, b.caseId!, user));
      if (!cs) return nf(c);
      const d = (cs.fields.incidentDate ?? cs.fields.occurredAt) as string | undefined;
      if (typeof d === 'string') asOf = d.slice(0, 10); // law as it stood on the event date
    }
    const library = await rd(c, (l) => l);
    const out = await answerFromLaws({ question: b.question, tenantId: user.tenantId, asOf, library, provider: sel.provider, lang: c.get('lang') });
    await logCall(user, 'laws', sel, { answered: !out.noVerifiedSource });
    return c.json({ ...out, engine: engineOf(sel) });
  });
  app.post('/ai/cases', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ question: string }>();
    const sel = await choose(user);
    if (!sel.ok) return unavailable(c);
    const visible = await repo.tx(user, (tx) => tx.listCases());
    const out = await answerQuestion({ question: b.question, actor: user, cases: visible, defs: CASE_TYPES, provider: sel.provider, policy: { external: sel.external, includePersonal: sel.includePersonal } });
    await logCall(user, 'cases', sel, { citations: out.citations.length });
    return c.json({ ...out, engine: engineOf(sel) });
  });

  // ---- AI engine choice and signed consent (client admin only) -----------------------
  const adminOnly = (user: Principal) => {
    if (user.tenantId === 'platform' || !user.roles.includes('tenant_admin')) throw new AccessDeniedError('ROLE_REQUIRED:tenant_admin');
  };
  app.get('/ai/settings', async (c) => {
    const user = c.get('user');
    const s = await repo.getAiSettings(user.tenantId);
    const sel = await choose(user);
    return c.json({ mode: s.mode, consent: s.consent ?? null, current: sel.ok ? engineOf(sel) : null, inKingdomOffered: providers.inKingdom ? { name: providers.inKingdom.name, region: providers.inKingdom.region } : null, sovereignAvailable: Boolean(providers.sovereign) });
  });
  app.get('/ai/consent-text', (c) => {
    const ik = providers.inKingdom;
    if (!ik) return c.json({ error: 'NOT_OFFERED' }, 404);
    const t = consentText({ providerName: ik.name, region: ik.region, includePersonal: c.req.query('includePersonal') === 'true' });
    return c.json({ ...t, sha256: consentHash(t) });
  });
  app.post('/ai/consent', async (c) => {
    const user = c.get('user');
    adminOnly(user);
    const ik = providers.inKingdom;
    if (!ik) return c.json({ error: 'NOT_OFFERED' }, 404);
    const b = await c.req.json<{ includePersonal?: boolean; name: string; title: string; textSha256: string; acknowledge: boolean }>();
    const includePersonal = b.includePersonal === true;
    const t = consentText({ providerName: ik.name, region: ik.region, includePersonal });
    // The signer must submit the hash of the exact wording served to them: proof of what was shown.
    if (b.acknowledge !== true || !b.name?.trim() || !b.title?.trim() || b.textSha256 !== consentHash(t)) throw new AccessDeniedError('CONSENT_INCOMPLETE');
    const settings = { tenantId: user.tenantId, mode: 'IN_KINGDOM_API' as const, consent: { version: CONSENT_VERSION, textSha256: b.textSha256, signedByUserId: user.id, signedByName: b.name.trim(), signedByTitle: b.title.trim(), signedAt: now(), providerName: ik.name, region: ik.region, includePersonal } };
    await repo.saveAiSettings(user.tenantId, settings, { at: now(), actorId: user.id, type: 'consent.signed', data: { version: CONSENT_VERSION, textSha256: b.textSha256, includePersonal, provider: ik.name, region: ik.region, signedByName: settings.consent.signedByName } });
    return c.json(settings, 201);
  });
  app.delete('/ai/consent', async (c) => {
    const user = c.get('user');
    adminOnly(user);
    const cur = await repo.getAiSettings(user.tenantId);
    const next = { tenantId: user.tenantId, mode: 'SOVEREIGN' as const, ...(cur.consent ? { consent: { ...cur.consent, revokedAt: now(), revokedBy: user.id } } : {}) };
    await repo.saveAiSettings(user.tenantId, next, { at: now(), actorId: user.id, type: 'consent.revoked', data: {} });
    return c.json(next);
  });
  app.get('/ai/log', async (c) => {
    const user = c.get('user');
    adminOnly(user);
    return c.json(await repo.listAiLog(user.tenantId, 200));
  });

  return app;
}
