/**
 * Seeds a QA environment with cases and a verified law, so testers start with data instead of an
 * empty screen. Idempotent-ish: re-running against the same database fails on CASE_EXISTS, which is
 * reported and skipped.
 *
 * TEST DATA ONLY — never run against a client environment.
 *
 *   pnpm start:dev                     # terminal 1
 *   pnpm seed                          # terminal 2 (dev tokens)
 *
 *   # against the QA Keycloak realm instead:
 *   SEED_AUTH=oidc OIDC_ISSUER=https://id.qa.example.sa/realms/cms pnpm seed
 *
 * Env: BASE_URL (default http://localhost:3000), SEED_AUTH=dev|oidc, OIDC_ISSUER,
 *      QA_CLIENT (default case-qa), QA_PASSWORD (default matches scripts/gen-realm.mts).
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const MODE = process.env.SEED_AUTH ?? 'dev';
const QA_CLIENT = process.env.QA_CLIENT ?? 'case-qa';
const QA_PASSWORD = process.env.QA_PASSWORD ?? 'Qa-Test-Only-Passw0rd!';

const tokens = new Map<string, string>();
async function auth(userId: string): Promise<string> {
  if (MODE === 'dev') return `Bearer dev:${userId}`;
  if (!tokens.has(userId)) {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) throw new Error('OIDC_ISSUER is required when SEED_AUTH=oidc');
    const r = await fetch(`${issuer.replace(/\/$/, '')}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: QA_CLIENT, username: userId, password: QA_PASSWORD, scope: 'openid' }),
    });
    if (!r.ok) throw new Error(`token for ${userId}: ${r.status} ${await r.text()}`);
    tokens.set(userId, ((await r.json()) as { access_token: string }).access_token);
  }
  return `Bearer ${tokens.get(userId)}`;
}

let failures = 0;
async function call(userId: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: await auth(userId), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    failures++;
    console.error(`  ✗ ${userId} ${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  }
  return { ok: r.ok, status: r.status, body: j as any };
}

const step = (s: string) => console.log(`\n${s}`);
const done = (s: string) => console.log(`  ✓ ${s}`);

// ---- Legal library: one real-looking Arabic instrument, verified by a second person -------------
async function seedLaw() {
  step('platform: national law baseline');
  await call('p-editor', 'POST', '/laws/instruments', {
    id: 'labour-law', tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', titleEn: 'Labour Law',
    issuer: 'المملكة العربية السعودية', sourceUrl: 'https://laws.boe.gov.sa/',
  });
  // Paraphrased placeholder text: QA replaces it with the real gazetted text (see KNOWN-GAPS).
  const rawText = [
    'المادة 71',
    'لا يجوز توقيع جزاء على العامل إلا بعد إبلاغه كتابةً بما هو منسوب إليه، واستجوابه، وتحقيق دفاعه، وإثبات ذلك في محضر يودع في ملفه الخاص. [نص تجريبي للاختبار فقط]',
    'المادة 72',
    'للعامل الاعتراض على الجزاء الموقع عليه خلال المهلة النظامية، ويقدم الاعتراض إلى الجهة المختصة. [نص تجريبي للاختبار فقط]',
  ].join('\n');
  const v = await call('p-editor', 'POST', '/laws/versions', {
    id: 'labour-law-v1', instrumentId: 'labour-law', versionLabel: 'اختبار 1', effectiveFrom: '2025-02-19', rawText,
  });
  if (v.ok) done(`uploaded ${v.body.version?.provisions?.length ?? 0} articles, now UNDER_REVIEW`);
  // Four eyes: a different person verifies.
  const ver = await call('p-verifier', 'POST', '/laws/versions/labour-law-v1/verify', { note: 'QA seed: checked against the source.' });
  if (ver.ok) done('verified by p-verifier (different person from the uploader)');
  await call('p-verifier', 'POST', '/laws/bindings/sync', {});
}

// ---- tenant-a: cases at several points of the workflow -----------------------------------------
async function seedTenantA() {
  step('tenant-a: HR, Security, Audit and Legal cases');

  // 1. A brand-new case, for triage testing.
  await call('a-hr-intake', 'POST', '/cases', {
    id: 'HR-2026-001', caseType: 'hr.misconduct',
    fields: { allegationSummary: 'تأخر متكرر عن مواعيد العمل دون عذر', incidentDate: '2026-10-04' },
  });
  done('HR-2026-001 — NEW (no severity yet: triage must be blocked)');

  // 2. A case carried to FINDINGS_ISSUED with the full written Art. 71 sequence, so the decision
  //    guards (director approval, oral-questioning rule) can be exercised without 10 setup steps.
  const id = 'HR-2026-002';
  await call('a-hr-mgr', 'POST', '/cases', {
    id, caseType: 'hr.misconduct',
    fields: { allegationSummary: 'استخدام عهدة الشركة لأغراض شخصية', severity: 'HIGH', incidentDate: '2026-09-21' },
    parties: [{ personId: 'emp-4471', role: 'SUBJECT', reportsTo: ['mgr-22'] }],
  });
  await call('a-hr-mgr', 'POST', `/cases/${id}/transitions/triage`);
  await call('a-hr-mgr', 'POST', `/cases/${id}/assignee`, { id: 'a-hr-inv', reportsTo: [] });
  await call('a-hr-mgr', 'POST', `/cases/${id}/transitions/assign`);
  await call('a-hr-inv', 'POST', `/cases/${id}/artifacts`, { id: 'plan', type: 'investigation_plan' });
  await call('a-hr-inv', 'POST', `/cases/${id}/transitions/start_investigation`);
  for (const [aid, type, payload] of [
    ['n1', 'allegation_notice', undefined],
    ['q1', 'questioning_record', { mode: 'WRITTEN' }],
    ['d1', 'defense_investigation', undefined],
    ['m1', 'investigation_minute', undefined],
    ['f1', 'findings_report', undefined],
  ] as const) {
    await call('a-hr-inv', 'POST', `/cases/${id}/artifacts`, { id: aid, type, ...(payload ? { payload } : {}) });
  }
  await call('a-hr-inv', 'POST', `/cases/${id}/transitions/issue_findings`);
  await call('a-hr-mgr', 'PATCH', `/cases/${id}/fields`, { outcome: 'SUBSTANTIATED_PENALTY', penaltyType: 'DISMISSAL', decisionRationale: 'ثبوت المخالفة' });
  done(`${id} — FINDINGS_ISSUED, written questioning, awaiting the director's approval`);

  // 3. Anonymous report with a sealed reporter: only a-ethics may see the identity.
  await call('a-hr-mgr', 'POST', '/cases', {
    id: 'HR-2026-003', caseType: 'hr.misconduct',
    fields: {
      allegationSummary: 'بلاغ عن تضارب مصالح في لجنة المشتريات', severity: 'CRITICAL',
      reporterChannel: 'ANONYMOUS_PORTAL', reporterIdentity: 'emp-9002',
    },
    parties: [{ personId: 'emp-9002', role: 'REPORTER', reportsTo: [], sealed: true }],
  });
  done('HR-2026-003 — sealed reporter identity (only a-ethics may read it)');

  await call('a-sec-mgr', 'POST', '/cases', {
    id: 'SEC-2026-001', caseType: 'security.incident',
    fields: { narrative: 'دخول غير مصرّح به إلى مستودع المواد', incidentType: 'ACCESS_VIOLATION', severity: 'HIGH', occurredAt: '2026-10-28', location: 'المستودع الرئيسي' },
  });
  await call('a-sec-mgr', 'POST', '/cases/SEC-2026-001/transitions/triage');
  done('SEC-2026-001 — Security, TRIAGED (HR accounts must not see it)');

  await call('a-aud-mgr', 'POST', '/cases', {
    id: 'AUD-2026-001', caseType: 'audit.finding',
    fields: { title: 'ضعف الفصل بين المهام في دورة الصرف', engagementRef: 'ENG-2026-07', riskRating: 'HIGH', fraudIndicators: false },
  });
  done('AUD-2026-001 — Audit finding, DRAFT');

  // Matter id m-1 matches a-ext-counsel's instruction, so external-counsel scoping is testable.
  await call('a-counsel', 'POST', '/cases', {
    id: 'm-1', caseType: 'legal.matter',
    fields: { title: 'مطالبة عمالية أمام المحكمة العمالية', forum: 'LABOUR_COURT', claimValueSar: 150000 },
  });
  done('m-1 — PRIVILEGED legal matter, the only matter a-ext-counsel may touch');
  await call('a-counsel', 'POST', '/cases', {
    id: 'm-2', caseType: 'legal.matter',
    fields: { title: 'نزاع تعاقدي مع مورد', forum: 'COMMERCIAL_COURT' },
  });
  done('m-2 — second matter, OUTSIDE a-ext-counsel’s instruction');
}

// ---- tenant-b: the other side of the tenant wall ------------------------------------------------
async function seedTenantB() {
  step('tenant-b: a second client organisation');
  await call('b-hr-mgr', 'POST', '/cases', {
    id: 'HR-2026-001', caseType: 'hr.misconduct', // same id as tenant-a on purpose: ids must not collide across tenants
    fields: { allegationSummary: 'بلاغ داخلي — منشأة ب', severity: 'LOW' },
  });
  done('tenant-b HR-2026-001 — same case id as tenant-a (both must exist, neither visible to the other)');
  await call('b-counsel', 'POST', '/cases', { id: 'm-1', caseType: 'legal.matter', fields: { title: 'قضية منشأة ب', forum: 'LABOUR_COURT' } });
  done('tenant-b m-1 — same matter id as tenant-a (a-ext-counsel must NOT reach it)');
}

step(`seeding ${BASE} (auth: ${MODE})`);
const alive = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
const health = alive ? await fetch(`${BASE}/health/details`, { headers: { authorization: await auth('p-editor') } }).then((r) => r.json() as Promise<{ ocr: boolean; paidOcrForPlatformLaw: boolean }>).catch(() => null) : null;
if (!health) { console.error(`Cannot reach ${BASE}. Start the server first (pnpm start:dev).`); process.exit(1); }
console.log(`  server up — OCR available: ${health.ocr}, paid OCR for platform law: ${health.paidOcrForPlatformLaw}`);

// Quiet probe: a 404 here is the normal "not seeded yet" answer, not an error.
const probe = await fetch(`${BASE}/cases/HR-2026-002`, { headers: { authorization: await auth('a-hr-mgr') } });
if (probe.ok) {
  console.log('\nAlready seeded (HR-2026-002 exists). In-memory server: restart it. PostgreSQL: reset the QA database. Nothing changed.');
  process.exit(0);
}
await seedLaw();
await seedTenantA();
await seedTenantB();

console.log(`\n${failures ? `finished with ${failures} failed call(s) — see above` : 'seed complete'}`);
console.log('Accounts and what each is for: src/api/test-users.ts · Test cases: docs/handoff/QA-TEST-PLAN.md');
process.exit(failures ? 1 : 0);
