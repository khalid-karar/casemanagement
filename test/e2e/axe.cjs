const { chromium } = require('playwright'); const fs = require('fs');
const axeSrc = fs.readFileSync(require('path').resolve(__dirname, '../../node_modules/axe-core/axe.min.js'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
(async () => {
  const b = await chromium.launch(); const out = {};
  const run = async (user, lang, routes, vp = { width: 1200, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, bypassCSP: true });
    await ctx.addInitScript(([u, l]) => { localStorage.setItem('user', u); localStorage.setItem('lang', l); }, [user, lang]);
    const p = await ctx.newPage(); p.on('dialog', (d) => d.accept());
    for (const [hash, wait] of routes) {
      await p.goto(BASE + '/#' + hash); await p.waitForSelector(wait, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(400);
      await p.evaluate(axeSrc);
      const r = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 3).join(' | ')) })));
      for (const v of r) (out[`${v.id} [${v.impact}]`] ??= []).push(`${user}/${lang}${hash}: ${v.sample.join(' ;; ')}`);
    }
    await ctx.close();
  };
  const hr = [['/', '.stat'], ['/cases', '#results table, #results .empty'], ['/cases/HR-2026-001', '.stepper'], ['/cases/HR-2026-001/notes', '#nf'], ['/inbox', '.page-h'], ['/report', '#rf'], ['/person/emp-1', '.page-h'], ['/cases/HR-2026-001/file', '#doPrint'], ['/cases/HR-2026-001/documents', '#upf'], ['/cases/HR-2026-001/actions', '#aaf'], ['/cases/HR-2026-001/history', '.timeline'], ['/laws', '#lawlist'], ['/ai', '#al']];
  for (const lang of ['ar', 'en']) {
    await run('a-hr-mgr', lang, hr); await run('a-counsel', lang, [['/cases/m-1/najiz', '#panel .card']]); await run('p-verifier', lang, [['/review', '.card']]); await run('a-admin', lang, [['/people', 'table.tbl']]);
  }
  await run('a-hr-mgr', 'ar', [['/', '.stat'], ['/cases', '#results table'], ['/cases/HR-2026-001', '.stepper']], { width: 390, height: 800 });
  await run('a-admin', 'en', [['/people', 'table.tbl']], { width: 390, height: 800 });
  const keys = Object.keys(out); console.log(keys.length ? '' : 'NO VIOLATIONS');
  for (const k of keys) console.log(k, 'x' + out[k].length, '\n   ', out[k].slice(0, 2).join('\n    '));
  await b.close();
})();
