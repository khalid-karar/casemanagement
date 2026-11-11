/**
 * Builds a static, backend-less PREVIEW of the web app for showing the design to people (for example on Netlify).
 *
 * It starts a throwaway in-memory server, seeds the QA data, records what the real UI asks for as each demo user in
 * both languages, and writes dist-demo/: the real web/ files + demo-data.json + demo.js (a small fetch shim that
 * answers from the recording). Reading works for every recorded screen; anything that would change data is refused
 * with a "preview only" notice. The anonymous report page works against an in-browser fake.
 *
 * SAMPLE DATA ONLY. Never run against a client environment, never publish real case data.
 *   pnpm demo:build        # then deploy dist-demo/ (drag it into Netlify, or `netlify deploy --dir dist-demo --prod`)
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const PORT = 3977, BASE = `http://localhost:${PORT}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const PERSONAS = ['a-hr-intake', 'a-hr-mgr', 'a-hr-inv', 'a-hr-dir', 'a-ethics', 'a-sec-mgr', 'a-aud-mgr', 'a-counsel', 'a-admin', 'p-editor'];
const LANGS = ['ar', 'en'];

const server = spawn('pnpm', ['exec', 'tsx', 'src/api/server.ts'], { env: { ...process.env, AUTH_MODE: 'dev', PORT: String(PORT) }, stdio: 'ignore' });
const stop = () => server.kill();
process.on('exit', stop);
async function up() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error('server did not start'); }
const call = async (user: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer dev:${user}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
};

try {
  await up();
  spawnSync('pnpm', ['exec', 'tsx', 'scripts/seed.mts'], { env: { ...process.env, BASE_URL: BASE }, stdio: 'ignore' });

  // Sample anonymous reports, so the inbox is not empty.
  const ch = (await call('a-admin', 'POST', '/report-channels', { labelAr: 'مستودع الرياض الرئيسي', labelEn: 'Riyadh main warehouse' })).j;
  await call('a-admin', 'POST', '/report-channels', { labelAr: 'مبنى الإدارة', labelEn: 'Head office' });
  const pub = (p: string, b: unknown) => fetch(`${BASE}/public/${ch.token}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<any>);
  const r1 = await pub('/reports', { category: 'AUDIT', language: 'ar', text: 'أحد المشرفين في المستودع يوقّع على استلام شحنات لم تصل فعليًا منذ عدة أشهر، وأعتقد أن هناك تواطؤًا مع أحد الموردين.' });
  await pub('/reports', { category: 'HR', language: 'ar', text: 'مدير القسم يتعامل بشكل مهين مع الموظفات ويهدد بالفصل عند أي اعتراض. حدث ذلك أمامي أكثر من مرة هذا الشهر.' });
  await pub('/reports', { category: 'SECURITY', language: 'en', text: 'The rear gate lock has been broken for two weeks and contractors are entering without badges after 10pm.' });
  const list = (await call('a-ethics', 'GET', '/reports')).j as any[];
  const first = list.find((x) => x.category === 'AUDIT');
  await call('a-ethics', 'POST', `/reports/${first.id}/reply`, { text: 'شكرًا لك. هل يمكنك تحديد الموقع التقريبي للمستودع والفترة الزمنية؟' });
  await pub('/track/reply', { code: r1.code, text: 'مستودع رقم ٤، آخر ثلاثة أشهر تقريبًا.' });

  // Record what the real UI asks for.
  const cfg = await (await fetch(`${BASE}/auth/config`)).text();
  const rec: Record<string, { s: number; b: string }> = {};
  const norm = (u: URL) => { const q = new URLSearchParams(u.search); q.delete('lang'); const s = q.toString(); return u.pathname + (s ? `?${s}` : ''); };
  const browser = await chromium.launch();
  for (const user of PERSONAS) for (const lang of LANGS) {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.addInitScript(([u, l]: string[]) => { localStorage.setItem('user', u!); localStorage.setItem('lang', l!); localStorage.setItem('tour', 'done'); }, [user, lang]);
    page.on('response', async (res: any) => {
      const u = new URL(res.url());
      if (u.origin !== BASE || res.request().method() !== 'GET' || !(res.headers()['content-type'] ?? '').includes('json')) return;
      rec[`${user}|${lang}|${norm(u)}`] = { s: res.status(), b: await res.text().catch(() => '') };
    });
    const visit = async (hash: string) => { await page.goto(`${BASE}/#${hash}`); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(250); };
    for (const h of ['/', '/cases', '/inbox', '/laws', '/people', '/report', '/reports', '/board', '/ai', '/review']) await visit(h);
    const ids = ((await call(user, 'GET', '/cases')).j as any[] | undefined)?.map?.((c) => c.id) ?? [];
    for (const id of Array.isArray(ids) ? ids : []) {
      await visit(`/cases/${encodeURIComponent(id)}`);
      for (const sub of ['related', 'audit', 'documents', 'najiz']) {
        const r = await call(user, 'GET', `/cases/${encodeURIComponent(id)}/${sub}?lang=${lang}`);
        rec[`${user}|${lang}|/cases/${encodeURIComponent(id)}/${sub}`] = { s: r.status, b: JSON.stringify(r.j) };
      }
    }
    const rl = (await call(user, 'GET', '/reports')).j; for (const r of Array.isArray(rl) ? rl : []) if (r?.id) await visit(`/reports/${r.id}`);
    await ctx.close();
  }
  await browser.close();

  rmSync('dist-demo', { recursive: true, force: true }); mkdirSync('dist-demo', { recursive: true });
  cpSync('web', 'dist-demo', { recursive: true });
  writeFileSync('dist-demo/demo-data.json', JSON.stringify({ config: JSON.parse(cfg), r: rec }));
  cpSync('web/demo.js', 'dist-demo/demo.js');
  const html = readFileSync('web/index.html', 'utf8').replace('<script src="/auth.js"></script>', '<script src="/demo.js"></script>\n<script src="/auth.js"></script>');
  writeFileSync('dist-demo/index.html', html);
  writeFileSync('dist-demo/_redirects', '/r/*  /report.html  200\n');
  console.log(`dist-demo ready: ${Object.keys(rec).length} recorded responses, ${(readFileSync('dist-demo/demo-data.json').length / 1e6).toFixed(1)} MB`);
} finally { stop(); }
