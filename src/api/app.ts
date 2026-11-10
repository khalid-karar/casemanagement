import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  AccessDeniedError, ConflictOfInterestError, FieldError, TransitionBlockedError, addArtifact, addAction, applyTransition,
  assignCase, canAccess, createCase, evaluateTransition, placeLegalHold, recordApproval, redactForActor, releaseLegalHold, setFields,
} from '../engine';
import type { Principal } from './auth';
import { Directory } from './auth';
import type { Repo, Tx } from './repo';
import { RateLimiter, isHeavyRoute } from './ratelimit';
import { CASE_TYPES } from '../case-types';
import { FileError, LegalError, extractProposals, extractText } from '../legal';
import { MAX_BYTES } from '../legal/files';
import type { LegalLibrary } from '../legal';
import { ocrAvailable } from '../legal/ocr';
import type { VisionOcr } from '../legal';
import { legalStatus, syncBindings } from '../case-types/legal-sources';
import { CONSENT_VERSION, answerFromLaws, answerQuestion, consentHash, consentText, selectProvider } from '../ai';
import type { AiProviders, ChatProvider, InKingdomProvider } from '../ai';

export interface AppDeps {
  repo: Repo; paidOcr?: VisionOcr;
  /** Resolves a verified Principal from an Authorization header (dev Directory or OIDC). */
  directory: { resolve(header: string | undefined): Principal | undefined | Promise<Principal | undefined> };
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

const STATIC = new Set(['/', '/index.html', '/app.js', '/auth.js', '/style.css', '/favicon.ico', '/auth/config']);

export function createApp(deps: AppDeps) {
  const { repo, directory, paidOcr } = deps;
  const providers: AiProviders = { ...(deps.provider ? { sovereign: deps.provider } : {}), ...(deps.inKingdom ? { inKingdom: deps.inKingdom } : {}) };
  const now = deps.clock ?? (() => new Date().toISOString());
  const app = new Hono<Env>();
  const limiter = new RateLimiter();
  const generalMax = deps.limits?.perMinute ?? 300;
  const heavyMax = deps.limits?.heavyPerMinute ?? 20;

  // Body size is capped before anything is read: JSON 1 MB, law file upload 25 MB plus multipart overhead.
  const tooLarge = (c: any) => c.json({ error: 'PAYLOAD_TOO_LARGE', message: T.tooLarge[c.get('lang') as 'ar' | 'en'] }, 413);
  const jsonCap = bodyLimit({ maxSize: deps.maxJsonBytes ?? 1024 * 1024, onError: tooLarge });
  const fileCap = bodyLimit({ maxSize: MAX_BYTES + 1024 * 1024, onError: tooLarge });
  app.use('*', async (c, next) => { c.set('lang', pickLang(c.req.query('lang'), c.req.header('accept-language'))); return (c.req.path === '/laws/files' ? fileCap : jsonCap)(c, next); });

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
    if (c.req.path === '/health' || STATIC.has(c.req.path)) return next();
    const user = await directory.resolve(c.req.header('authorization'));
    if (!user) return c.json({ error: 'UNAUTHENTICATED', message: T.unauthenticated[c.get('lang')] }, 401);
    c.set('user', user);
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
    if (err instanceof AccessDeniedError) return c.json({ error: 'FORBIDDEN', reason: err.reason, message: T.forbidden[lang] }, 403);
    if (err instanceof FieldError) return c.json({ error: err.kind === 'LOCKED' ? 'FIELD_LOCKED' : 'INVALID_FIELDS', problems: err.problems, message: err.kind === 'LOCKED' ? T.locked[lang] : T.badRequest[lang] }, err.kind === 'LOCKED' ? 409 : 400);
    if (err instanceof ConflictOfInterestError) return c.json({ error: 'CONFLICT_OF_INTEREST', codes: err.codes, message: T.conflict[lang] }, 409);
    if (err instanceof FileError) return c.json({ error: err.code, message: T.badRequest[lang] }, err.code === 'FILE_TOO_LARGE' ? 413 : err.code === 'OCR_NOT_INSTALLED' ? 503 : 400);
    if (err instanceof LegalError) return c.json({ error: err.code, message: T.forbidden[lang] }, err.code === 'UNKNOWN_VERSION' || err.code === 'UNKNOWN_INSTRUMENT' ? 404 : 403);
    if ((err as { code?: string }).code === '23505' || (err as Error).message === 'CASE_EXISTS') return c.json({ error: 'CASE_EXISTS', message: T.badRequest[lang] }, 409);
    // Never leak internals.
    return c.json({ error: 'BAD_REQUEST', message: T.badRequest[lang] }, 400);
  });

  app.get('/auth/config', (c) => c.json(deps.authInfo ?? { mode: 'dev' }));
  app.get('/me', (c) => { const u = c.get('user'); return c.json({ id: u.id, name: u.name, tenantId: u.tenantId, roles: u.roles, departments: u.departments, kind: u.kind, clearance: u.clearance }); });
  // Public liveness only. Capability details (OCR, paid OCR) need a platform sign-in.
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
      fields: d.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options ?? null, sensitivity: f.sensitivity, lockedIn: f.lockedIn ?? [] })) })));
  });

  app.post('/cases', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ id: string; caseType: string; fields?: Record<string, unknown>; parties?: any[] }>();
    const def = CASE_TYPES[b.caseType];
    if (!def) return c.json({ error: 'UNKNOWN_CASE_TYPE' }, 400);
    const m = createCase(def, { id: b.id, fields: b.fields ?? {}, parties: b.parties ?? [] }, user, now());
    await repo.tx(user.tenantId, (tx) => tx.saveCase(m.case, m.event, true));
    return c.json(view(m.case, user), 201);
  });

  app.get('/cases', async (c) => {
    const user = c.get('user');
    const all = await repo.tx(user.tenantId, (tx) => tx.listCases());
    return c.json(all.filter((x) => canAccess(user, x, 'read').allowed).map((x) => view(x, user)));
  });

  app.get('/cases/:id', async (c) => {
    const user = c.get('user');
    const cs = await repo.tx(user.tenantId, (tx) => load(tx, c.req.param('id'), user));
    if (!cs) return nf(c);
    const def = CASE_TYPES[cs.caseTypeKey]!;
    const actions = def.transitions
      .filter((t) => t.from.includes(cs.state))
      .map((t) => {
        const ev = evaluateTransition(def, cs, t.action, user);
        const lang = c.get('lang');
        return { action: t.action, label: t.label, allowed: ev.allowed, blockers: ev.blockers.map((b) => ({ code: b.code, message: lang === 'ar' ? b.messageAr ?? b.message : b.message })) };
      });
    return c.json({ case: view(cs, user), actions });
  });

  app.post('/cases/:id/transitions/:action', async (c) => {
    const user = c.get('user');
    // Row lock: two people acting on one case are serialised, so guards always see the latest state.
    const out = await repo.tx(user.tenantId, async (tx) => {
      const cs = await load(tx, c.req.param('id'), user, 'transition', true);
      if (!cs) return undefined;
      const m = applyTransition(CASE_TYPES[cs.caseTypeKey]!, cs, c.req.param('action'), user, now());
      await tx.saveCase(m.case, m.event);
      return m.case;
    });
    return out ? c.json(view(out, user)) : nf(c);
  });

  const mutate = (fn: (cs: any, user: Principal, body: any) => { case: any; event: any }, action: 'write' | 'transition' = 'write') =>
    async (c: any) => {
      const user = c.get('user') as Principal;
      const body = await c.req.json();
      const out = await repo.tx(user.tenantId, async (tx) => {
        const cs = await load(tx, c.req.param('id'), user, action, true);
        if (!cs) return undefined;
        const m = fn(cs, user, body);
        await tx.saveCase(m.case, m.event);
        return m.case;
      });
      return out ? c.json(view(out, user)) : nf(c);
    };
  app.patch('/cases/:id/fields', mutate((cs, u, b) => setFields(cs, b, u, now(), CASE_TYPES[cs.caseTypeKey]!)));
  app.post('/cases/:id/artifacts', mutate((cs, u, b) => addArtifact(cs, b, u, now())));
  app.post('/cases/:id/assignee', mutate((cs, u, b) => assignCase(cs, b, u, now())));
  app.post('/cases/:id/actions', mutate((cs, u, b) => addAction(cs, b, u, now())));
  app.post('/cases/:id/approvals', mutate((cs, u, b) => recordApproval(cs, b.role, u, now()), 'transition'));
  app.post('/cases/:id/legal-hold', mutate((cs, u, b) => placeLegalHold(cs, u, b.reason, now())));
  app.delete('/cases/:id/legal-hold', mutate((cs, u, b) => releaseLegalHold(cs, u, b.reason ?? '', now())));

  app.get('/cases/:id/audit', async (c) => {
    const user = c.get('user');
    const r = await repo.tx(user.tenantId, async (tx) => {
      const cs = await load(tx, c.req.param('id'), user);
      return cs ? tx.getAudit(cs.id) : undefined;
    });
    return r ? c.json({ events: r, integrity: repo.verifyChain(r) }) : nf(c);
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
      const cs = await repo.tx(user.tenantId, (tx) => load(tx, b.caseId!, user));
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
    const visible = await repo.tx(user.tenantId, (tx) => tx.listCases());
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
