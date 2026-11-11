// End-to-end UI flows against a running, seeded dev server:  BASE_URL=http://localhost:3000 node test/e2e/flows.cjs
// (start it with: AUTH_MODE=dev NAJIZ_MODE=simulated pnpm start, then: pnpm seed). Exits non-zero on the first failure.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const RUN = Date.now().toString(36);
const fails = []; const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails.push(m); };
const RAW = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b|\b[a-z]+_[a-z_]+\b/; // an untranslated code on screen

(async () => {
  const b = await chromium.launch();
  const open = async (user, lang) => {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.addInitScript(([u, l]) => { localStorage.setItem('user', u); localStorage.setItem('lang', l); }, [user, lang]);
    const p = await ctx.newPage(); p.on('dialog', (d) => d.accept());
    const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    p.errs = errs; return p;
  };
  const toast = (p, re) => p.locator('#toasts .toast', { hasText: re }).first().waitFor({ timeout: 6000 }).then(() => true, () => false);

  console.log('HR manager: create, edit, assign, step, document, action, history');
  let p = await open('a-hr-mgr', 'en');
  await p.goto(BASE + '/#/'); await p.waitForSelector('.stat');
  await p.click('text=New case'); await p.waitForSelector('dialog[open]');
  await p.fill('#nf-allegationSummary', `E2E ${RUN}: duplicate vendor payments`); await p.click('#dlg-ok');
  await p.waitForSelector('.stepper'); const url = p.url(); const id = decodeURIComponent(url.split('/cases/')[1].split('/')[0]);
  ok(/^HR-2026-[A-Z0-9]{6}$/.test(id), `server-numbered case ${id}`);
  ok(await p.locator('h2#h', { hasText: RUN }).count() === 1, 'title shown');
  ok(await p.locator('button:has-text("Triage")').isDisabled(), 'Triage disabled until a severity is set');
  ok(await p.locator('ul.hint li', { hasText: /severity/i }).count() > 0, 'reason shown in plain language');
  await p.click('#edit'); await p.selectOption('#ef-severity', 'HIGH'); await p.click('#ef button[type=submit]');
  ok(await toast(p, /Saved/), 'details saved'); await p.waitForSelector('.kv');
  ok(await p.locator('.kv td', { hasText: 'High' }).count() === 1, 'enum shown translated, not HIGH');
  await p.click('#assignMe'); ok(await toast(p, /Saved/), 'assigned'); await p.waitForSelector('b:has-text("HR Manager (A)")');
  await p.click('button[data-act=triage]'); ok(await toast(p, /Step completed/), 'triage ran');
  await p.waitForSelector('.badge.info:has-text("Triaged")'); ok(true, 'state now Triaged');
  await p.click('#tab-documents'); await p.waitForSelector('#upf');
  await p.selectOption('#ut', 'evidence'); await p.setInputFiles('#uf', { name: 'receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('payment receipt 123') });
  await p.click('#upf button[type=submit]'); ok(await toast(p, /uploaded/i), 'document uploaded');
  await p.waitForSelector('button[data-dl]'); const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button[data-dl]')]);
  ok(dl.suggestedFilename() === 'receipt.txt', 'document downloads');
  await p.click('#tab-actions'); await p.waitForSelector('#aaf');
  await p.fill('#ad', 'Retrain AP team'); await p.fill('#adue', '2026-12-01'); await p.click('#aaf button[type=submit]');
  ok(await toast(p, /Saved/), 'action added'); await p.waitForSelector('[data-done]'); await p.click('[data-done]');
  ok(await toast(p, /Saved/), 'action completed'); await p.waitForSelector('.badge.ok:has-text("Done")');
  await p.click('#tab-history'); await p.waitForSelector('.timeline');
  const hist = await p.locator('.timeline').innerText();
  ok(/created the case/.test(hist) && /moved the case from “New” to “Triaged”/.test(hist), 'history reads as sentences');
  ok(!RAW.test(await p.locator('#view').innerText()), 'no raw codes on the history screen');
  ok(p.errs.length === 0, 'no console/page errors ' + p.errs.join('|'));

  console.log('Case list: search, filters, sort, saved view');
  await p.goto(BASE + '/#/cases'); await p.waitForSelector('#results table');
  await p.fill('#q', RUN); await p.waitForTimeout(600);
  ok(await p.locator('#results tbody tr').count() === 1, 'search narrows to one case');
  await p.fill('#q', 'zzz-nothing'); await p.waitForTimeout(600);
  ok(await p.locator('#results .empty', { hasText: 'No matching cases' }).count() === 1, 'empty state for no results');
  await p.click('#clr2'); await p.waitForSelector('#results table');
  await p.click('details.filters summary'); await p.check('#fneeds'); await p.waitForTimeout(500); ok(await p.locator('#chips .chip').count() === 1, 'active filter chip');
  await p.click('#saveView'); await p.fill('#vn', 'Mine'); await p.click('#dlg-ok'); ok(await toast(p, /View saved/), 'view saved');
  await p.reload(); await p.waitForSelector('#views .chip a:has-text("Mine")'); ok(true, 'saved view survives reload');
  await p.click('#views .chip a'); await p.waitForTimeout(500);

  console.log('Raw-code scan on every screen, both languages');
  for (const lang of ['en', 'ar']) {
    const q = await open('a-hr-mgr', lang);
    for (const h of ['/', '/cases', `/cases/${id}`, `/cases/${id}/documents`, `/cases/${id}/actions`, `/cases/${id}/history`, '/laws', '/ai']) {
      await q.goto(BASE + '/#' + h); await q.waitForSelector('#h'); await q.waitForTimeout(400);
      const text = (await q.locator('#view').innerText()).split('\n').filter((l) => !/^[A-Z]{2,4}-\d{4}-/.test(l) && !/^[0-9a-f]{12}/.test(l)).join('\n');
      const m = text.match(RAW); ok(!m, `${lang} ${h} has no untranslated code${m ? ' (' + m[0] + ')' : ''}`);
    }
    await q.context().close();
  }

  console.log('Legal: dual control and Najiz review step through the UI');
  const api = async (who, method, path, body) => (await fetch(BASE + path, { method, headers: { authorization: 'Bearer dev:' + who, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json().catch(() => ({}));
  const mid = 'E2E-' + Date.now().toString(36);
  await api('a-counsel', 'POST', '/cases', { id: mid, caseType: 'legal.matter', fields: { title: 'E2E vendor claim', forum: 'COMMERCIAL_COURT', claimValueSar: 90000 } });
  await api('a-counsel', 'POST', `/cases/${mid}/assignee`, { id: 'a-counsel', reportsTo: [] });
  await api('a-counsel', 'POST', `/cases/${mid}/transitions/assign_counsel`); await api('a-counsel', 'POST', `/cases/${mid}/legal-hold`, { reason: 'e2e' });
  await api('a-counsel', 'POST', `/cases/${mid}/transitions/begin_pre_action`);
  const fd = new FormData(); fd.set('file', new File([Buffer.from('%PDF-1.4\n%%EOF')], 'claim.pdf')); fd.set('type', 'filing');
  await fetch(BASE + `/cases/${mid}/documents`, { method: 'POST', headers: { authorization: 'Bearer dev:a-counsel' }, body: fd });
  p = await open('a-counsel', 'en'); await p.goto(BASE + `/#/cases/${mid}/najiz`); await p.waitForSelector('#nzs');
  ok(await p.locator('#nzs').isDisabled(), 'submit disabled without a second approver');
  ok(await p.locator('.banner.sim').count() === 1, 'simulation banner shown');
  const g = await open('a-gc', 'en'); await g.goto(BASE + `/#/cases/${mid}/najiz`); await g.waitForSelector('#nzapprove');
  await g.click('#nzapprove'); ok(await toast(g, /approval was recorded/), 'general counsel approves with one click (no role typing)');
  await p.reload(); await p.waitForSelector('#nzs:not([disabled])'); ok(true, 'submit enabled after approval');
  await p.click('#nzs'); await p.waitForSelector('dialog[open]');
  ok((await p.locator('dialog').innerText()).includes('claim.pdf'), 'review dialog lists what is sent');
  await p.click('#dlg-ok'); ok(await toast(p, /sent to Najiz/), 'filing sent (simulator)');
  await p.waitForSelector('.badge.ok:has-text("Filed")'); ok(true, 'status shows Filed');
  await p.click('#nzy'); ok(await toast(p, /Updated from Najiz/), 'sync works');

  console.log('Keyboard');
  await p.goto(BASE + `/#/cases/${mid}`); await p.waitForSelector('#tab-overview');
  await p.focus('#tab-overview'); await p.keyboard.press('ArrowRight'); await p.waitForSelector('#tab-documents[aria-selected=true]'); ok(true, 'arrow keys move between tabs');
  console.log('Clearing a field, people & access, phone layout');
  p = await open('a-hr-mgr', 'en');
  await p.goto(BASE + `/#/cases/${id}`); await p.waitForSelector('#edit');
  await p.click('#edit'); await p.fill('#ef-incidentDate', '2026-10-04'); await p.click('#ef button[type=submit]'); ok(await toast(p, /Saved/), 'date saved');
  await p.waitForSelector('#edit'); await p.click('#edit'); await p.fill('#ef-incidentDate', ''); await p.click('#ef button[type=submit]');
  await p.waitForSelector('#edit'); await p.click('#edit'); ok((await p.inputValue('#ef-incidentDate')) === '', 'emptying a field clears it');
  p = await open('a-admin', 'en');
  await p.goto(BASE + '/#/people'); await p.waitForSelector('table.tbl');
  ok(await p.locator('th[scope=row]', { hasText: 'HR Manager (A)' }).count() === 1, 'people list shows names');
  ok(await p.locator('tbody tr', { hasText: 'Client Admin (A)' }).locator('button').count() === 0, 'no end-sessions button on yourself');
  await p.locator('tbody tr', { hasText: 'HR Intake (A)' }).locator('button').click(); await p.waitForSelector('dialog[open]');
  await p.click('#dlg-ok'); ok(await toast(p, /Sessions ended/), 'admin ends a person’s sessions');
  p = await open('a-hr-mgr', 'en'); await p.goto(BASE + '/#/');
  ok(await p.locator('a[href="#/people"]').count() === 0, 'people screen hidden from non-admins');
  const pm = await b.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
  await pm.addInitScript(() => { localStorage.setItem('user', 'a-hr-mgr'); localStorage.setItem('lang', 'ar'); });
  const mp = await pm.newPage(); await mp.goto(BASE + `/#/cases/${id}`); await mp.waitForSelector('#tab-overview');
  const nav = await mp.locator('nav.main').boundingBox(); ok(nav && nav.y + nav.height >= 790 && nav.width >= 388, 'phone: main navigation is a bottom bar');
  ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no sideways page scroll');
  ok(await mp.evaluate(() => { const t = document.querySelector('.tabs'); return t.scrollWidth <= t.clientWidth + 1; }), 'phone: case tabs all visible without scrolling');
  await b.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED'); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
