import { Hono } from 'hono';
import {
  AccessDeniedError, ConflictOfInterestError, TransitionBlockedError, addArtifact, addAction, applyTransition,
  assignCase, canAccess, createCase, evaluateTransition, placeLegalHold, recordApproval, redactForActor, releaseLegalHold, setFields,
} from '../engine';
import type { Principal } from './auth';
import { Directory } from './auth';
import { Store } from './store';
import { CASE_TYPES } from '../case-types';
import { LegalError } from '../legal';
import { answerFromLaws, answerQuestion } from '../ai';
import type { ChatProvider } from '../ai';

export interface AppDeps { store: Store; directory: Directory; provider: ChatProvider; clock?: () => string }
type Env = { Variables: { user: Principal; lang: 'ar' | 'en' } };

const T = {
  unauthenticated: { ar: 'غير مصرّح', en: 'Not authenticated' },
  notFound: { ar: 'غير موجود', en: 'Not found' },
  forbidden: { ar: 'ليس لديك صلاحية', en: 'Access denied' },
  blocked: { ar: 'لا يمكن تنفيذ الإجراء', en: 'Transition blocked' },
  conflict: { ar: 'تعارض مصالح', en: 'Conflict of interest' },
  badRequest: { ar: 'طلب غير صالح', en: 'Invalid request' },
} as const;

/** Arabic is the default language; English when asked (?lang=en or Accept-Language: en). */
const pickLang = (q: string | undefined, h: string | undefined): 'ar' | 'en' =>
  q === 'en' || (!q && /^en/i.test(h ?? '')) ? 'en' : 'ar';

const STATIC = new Set(['/', '/index.html', '/app.js', '/style.css', '/favicon.ico']);

export function createApp(deps: AppDeps) {
  const { store, directory, provider } = deps;
  const now = deps.clock ?? (() => new Date().toISOString());
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.set('lang', pickLang(c.req.query('lang'), c.req.header('accept-language')));
    c.header('content-language', c.get('lang'));
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
    if (c.req.path === '/health' || STATIC.has(c.req.path)) return next();
    const user = directory.resolve(c.req.header('authorization'));
    if (!user) return c.json({ error: 'UNAUTHENTICATED', message: T.unauthenticated[c.get('lang')] }, 401);
    c.set('user', user);
    return next();
  });

  app.onError((err, c) => {
    const lang = c.get('lang') ?? 'ar';
    if (err instanceof TransitionBlockedError) {
      return c.json({ error: 'BLOCKED', message: T.blocked[lang], blockers: err.blockers.map((b) => ({ code: b.code, message: lang === 'ar' ? b.messageAr ?? b.message : b.message })) }, 409);
    }
    if (err instanceof AccessDeniedError) return c.json({ error: 'FORBIDDEN', reason: err.reason, message: T.forbidden[lang] }, 403);
    if (err instanceof ConflictOfInterestError) return c.json({ error: 'CONFLICT_OF_INTEREST', codes: err.codes, message: T.conflict[lang] }, 409);
    if (err instanceof LegalError) return c.json({ error: err.code, message: T.forbidden[lang] }, err.code === 'UNKNOWN_VERSION' || err.code === 'UNKNOWN_INSTRUMENT' ? 404 : 403);
    // Never leak internals.
    return c.json({ error: 'BAD_REQUEST', message: T.badRequest[lang] }, 400);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  const load = (id: string, user: Principal, action: 'read' | 'write' | 'transition' = 'read') => {
    const cs = store.cases.get(id);
    // Not-found and not-permitted look identical so existence is not leaked across walls.
    if (!cs || cs.tenantId !== user.tenantId || !canAccess(user, cs, action).allowed) return undefined;
    return cs;
  };
  const nf = (c: any) => c.json({ error: 'NOT_FOUND', message: T.notFound[c.get('lang') as 'ar' | 'en'] }, 404);

  // ---- Cases -----------------------------------------------------------------
  app.get('/case-types', (c) =>
    c.json(Object.values(CASE_TYPES).map((d) => ({ key: d.key, domain: d.domain, label: d.label, legalReview: d.legalReview.status }))));

  app.post('/cases', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ id: string; caseType: string; fields?: Record<string, unknown>; parties?: any[] }>();
    const def = CASE_TYPES[b.caseType];
    if (!def) return c.json({ error: 'UNKNOWN_CASE_TYPE' }, 400);
    const m = createCase(def, { id: b.id, fields: b.fields ?? {}, parties: b.parties ?? [] }, user, now());
    store.save(m.case, m.event);
    return c.json(m.case, 201);
  });

  app.get('/cases', (c) => {
    const user = c.get('user');
    const out = [...store.cases.values()]
      .filter((x) => x.tenantId === user.tenantId && canAccess(user, x, 'read').allowed)
      .map((x) => redactForActor(CASE_TYPES[x.caseTypeKey]!, x, user));
    return c.json(out);
  });

  app.get('/cases/:id', (c) => {
    const user = c.get('user');
    const cs = load(c.req.param('id'), user);
    if (!cs) return nf(c);
    const def = CASE_TYPES[cs.caseTypeKey]!;
    const actions = def.transitions
      .filter((t) => t.from.includes(cs.state))
      .map((t) => {
        const ev = evaluateTransition(def, cs, t.action, user);
        const lang = c.get('lang');
        return { action: t.action, label: t.label, allowed: ev.allowed, blockers: ev.blockers.map((b) => ({ code: b.code, message: lang === 'ar' ? b.messageAr ?? b.message : b.message })) };
      });
    return c.json({ case: redactForActor(def, cs, user), actions });
  });

  app.post('/cases/:id/transitions/:action', (c) => {
    const user = c.get('user');
    const cs = load(c.req.param('id'), user, 'transition');
    if (!cs) return nf(c);
    const m = applyTransition(CASE_TYPES[cs.caseTypeKey]!, cs, c.req.param('action'), user, now());
    store.save(m.case, m.event);
    return c.json(m.case);
  });

  const mutate = (fn: (cs: any, user: Principal, body: any) => { case: any; event: any }, action: 'write' | 'transition' = 'write') =>
    async (c: any) => {
      const user = c.get('user') as Principal;
      const cs = load(c.req.param('id'), user, action);
      if (!cs) return nf(c);
      const m = fn(cs, user, await c.req.json());
      store.save(m.case, m.event);
      return c.json(m.case);
    };
  app.patch('/cases/:id/fields', mutate((cs, u, b) => setFields(cs, b, u, now())));
  app.post('/cases/:id/artifacts', mutate((cs, u, b) => addArtifact(cs, b, u, now())));
  app.post('/cases/:id/assignee', mutate((cs, u, b) => assignCase(cs, b, u, now())));
  app.post('/cases/:id/actions', mutate((cs, u, b) => addAction(cs, b, u, now())));
  app.post('/cases/:id/approvals', mutate((cs, u, b) => recordApproval(cs, b.role, u, now()), 'transition'));
  app.post('/cases/:id/legal-hold', mutate((cs, u, b) => placeLegalHold(cs, u, b.reason, now())));
  app.delete('/cases/:id/legal-hold', mutate((cs, u, b) => releaseLegalHold(cs, u, b.reason ?? '', now())));

  app.get('/cases/:id/audit', (c) => {
    const cs = load(c.req.param('id'), c.get('user'));
    if (!cs) return nf(c);
    return c.json({ events: store.audit.get(cs.id) ?? [], integrity: store.verify(cs.id) });
  });

  // ---- Legal library -----------------------------------------------------------
  const lp = (u: Principal) => ({ id: u.id, roles: u.roles, tenantId: u.tenantId });
  app.get('/laws', (c) => {
    const user = c.get('user');
    const date = c.req.query('asOf') ?? now().slice(0, 10);
    return c.json(store.library.verifiedProvisions(user.tenantId, date).map((p) => ({ instrument: p.instrument.titleAr, instrumentEn: p.instrument.titleEn, version: p.version.versionLabel, effectiveFrom: p.version.effectiveFrom, article: p.provision.number, textAr: p.provision.textAr, textEn: p.provision.textEn })));
  });
  app.post('/laws/instruments', async (c) => { const b = await c.req.json(); store.library.addInstrument(b, lp(c.get('user')), now()); return c.json(b, 201); });
  // One upload: split into articles and go straight to review. The reviewer's single action is verify.
  app.post('/laws/versions', async (c) => {
    const u = lp(c.get('user'));
    const r = store.library.uploadVersion(await c.req.json(), u, now());
    store.library.submitForReview(r.version.id, u, now());
    return c.json({ ...r, version: store.library.versions.get(r.version.id) }, 201);
  });
  app.post('/laws/versions/:id/submit', (c) => c.json(store.library.submitForReview(c.req.param('id'), lp(c.get('user')), now())));
  app.post('/laws/versions/:id/verify', async (c) => c.json(store.library.verify(c.req.param('id'), lp(c.get('user')), (await c.req.json()).note ?? '', now())));
  app.post('/laws/versions/:id/reject', async (c) => c.json(store.library.reject(c.req.param('id'), lp(c.get('user')), (await c.req.json()).note ?? '', now())));
  app.get('/laws/versions/:id', (c) => { const v = store.library.versions.get(c.req.param('id')); return v ? c.json(v) : nf(c); });
  app.get('/laws/stale-rules', (c) => c.json(store.library.staleBindings()));

  // ---- AI (always drafts) ------------------------------------------------------
  app.post('/ai/laws', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ question: string; caseId?: string }>();
    let asOf = now().slice(0, 10);
    if (b.caseId) {
      const cs = load(b.caseId, user);
      if (!cs) return nf(c);
      const d = (cs.fields.incidentDate ?? cs.fields.occurredAt) as string | undefined;
      if (typeof d === 'string') asOf = d.slice(0, 10); // law as it stood on the event date
    }
    return c.json(await answerFromLaws({ question: b.question, tenantId: user.tenantId, asOf, library: store.library, provider, lang: c.get('lang') }));
  });
  app.post('/ai/cases', async (c) => {
    const user = c.get('user');
    const b = await c.req.json<{ question: string }>();
    const visible = [...store.cases.values()].filter((x) => x.tenantId === user.tenantId);
    return c.json(await answerQuestion({ question: b.question, actor: user, cases: visible, defs: CASE_TYPES, provider }));
  });

  return app;
}
