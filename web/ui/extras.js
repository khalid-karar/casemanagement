// Person case history, confidential report intake, keyboard shortcuts and the first-visit tour.
(() => {
  const K = CMS, { esc } = K;

  CMS.views.person = async (route) => {
    const pid = route.params[0];
    const r = await K.api('GET', `/persons/${encodeURIComponent(pid)}/cases`);
    const items = r.j?.items || [];
    const rows = items.map((c) => `<tr><td data-l="${esc(L.t('title'))}"><a class="row-link" href="#/cases/${encodeURIComponent(c.id)}">${esc(c.title ?? L.caseType(c.caseTypeKey))}</a><div class="mute"><span class="code">${esc(c.id)}</span> · ${esc(L.caseType(c.caseTypeKey))}</div></td><td data-l="${esc(L.t('roleInCase'))}">${esc(L.party(c.partyRole))}</td><td data-l="${esc(L.t('state'))}"><span class="badge ${c.stateKind === 'OPEN' ? 'info' : ''}">${esc(L.state(K.s.defs[c.caseTypeKey], c.state))}</span></td><td data-l="${esc(L.t('dept'))}">${esc(L.dept(c.department))}</td><td data-l="${esc(L.t('created'))}">${K.time(c.createdAt)}</td></tr>`).join('');
    const html = `<nav class="crumb" aria-label="breadcrumb"><a href="#/cases">${esc(L.t('cases'))}</a> ${K.ic(K.ar() ? 'chevL' : 'chevR')} <span>${esc(K.who(pid))}</span></nav>
      <div class="page-h"><h2 id="h">${esc(L.t('personT'))}: ${esc(K.who(pid))}</h2></div><p class="mute">${esc(L.t('personSub'))}</p>
      <section class="card">${items.length ? `<table class="tbl stack"><thead><tr><th scope="col">${esc(L.t('title'))}</th><th scope="col">${esc(L.t('roleInCase'))}</th><th scope="col">${esc(L.t('state'))}</th><th scope="col">${esc(L.t('dept'))}</th><th scope="col">${esc(L.t('created'))}</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${K.ic('folder')}<p>${esc(L.t('noPersonCases'))}</p></div>`}</section>`;
    return { title: L.t('personT'), html };
  };

  // Confidential intake: a plain form for the person who receives a concern. The reporter's identity is stored only in the sealed field.
  const KINDS = { HR: { type: 'hr.misconduct', what: 'allegationSummary' }, SEC: { type: 'security.incident', what: 'narrative' } };
  CMS.views.report = async () => {
    const kinds = Object.entries(KINDS).filter(([, v]) => K.s.defs[v.type]);
    if (!kinds.length) { const e = new Error('nf'); e.notFound = true; throw e; }
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('reportT'))}</h2></div><p class="mute">${esc(L.t('reportSub'))}</p>
      <section class="card"><form id="rf" class="grid">
        <div class="field"><label for="rk">${esc(L.t('reportKind'))}</label><select id="rk">${kinds.map(([k]) => `<option value="${k}">${esc(L.t('reportKind' + k))}</option>`).join('')}</select></div>
        <div class="field"><label for="rw">${esc(L.t('reportWhat'))}</label><textarea id="rw" rows="5" required maxlength="5000"></textarea></div>
        <div class="field"><label for="rd">${esc(L.t('reportWhen'))}</label><input id="rd" type="date"></div>
        <div class="field"><label for="rc">${esc(L.t('reportVia'))}</label><select id="rc">${['PORTAL', 'HOTLINE', 'EMAIL', 'IN_PERSON'].map((x) => `<option value="${x}">${esc(L.t('ch' + x))}</option>`).join('')}</select></div>
        <div class="field"><label class="check"><input type="checkbox" id="ra"> ${esc(L.t('reportAnon'))}</label><p class="mute" id="ranote" hidden>${esc(L.t('reportAnonNote'))}</p></div>
        <div class="field" id="rwhoW"><label for="rwho">${esc(L.t('reportWho'))}</label><input id="rwho" maxlength="120"></div>
        <div class="row"><button type="submit">${K.ic('send')} ${esc(L.t('reportSend'))}</button></div></form></section>`;
    const after = (root) => {
      const a = K.$('#ra', root); a.onchange = () => { K.$('#ranote', root).hidden = !a.checked; K.$('#rwhoW', root).hidden = a.checked; };
      K.$('#rf', root).onsubmit = async (e) => {
        e.preventDefault(); const k = KINDS[K.$('#rk', root).value]; const def = K.s.defs[k.type]; const fields = { [k.what]: K.$('#rw', root).value.trim() };
        const d = K.$('#rd', root).value; if (d && def.fields.some((f) => f.key === 'incidentDate')) fields.incidentDate = d;
        if (def.fields.some((f) => f.key === 'reporterChannel')) fields.reporterChannel = a.checked ? 'ANONYMOUS_PORTAL' : K.$('#rc', root).value;
        const who = K.$('#rwho', root).value.trim(); if (!a.checked && who && def.fields.some((f) => f.key === 'reporterIdentity')) fields.reporterIdentity = who;
        const res = await K.api('POST', '/cases', { caseType: k.type, fields });
        if (K.report(res, L.t('reportOk'))) K.go(`/cases/${encodeURIComponent(res.j.id)}`);
      };
    };
    return { title: L.t('reportT'), html, after };
  };

  // Keyboard shortcuts (never while typing in a field).
  const typing = (t) => t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  const help = () => K.dialog({ title: L.t('helpT'), hideCancel: true, ok: L.t('ok'), body: `<dl class="kb"><dt><kbd>/</kbd></dt><dd>${esc(L.t('kbSearch'))}</dd><dt><kbd>g</kbd> <kbd>h</kbd></dt><dd>${esc(L.t('kbHome'))}</dd><dt><kbd>g</kbd> <kbd>c</kbd></dt><dd>${esc(L.t('kbCases'))}</dd><dt><kbd>g</kbd> <kbd>i</kbd></dt><dd>${esc(L.t('kbInbox'))}</dd><dt><kbd>n</kbd></dt><dd>${esc(L.t('kbNew'))}</dd><dt><kbd>?</kbd></dt><dd>${esc(L.t('kbHelp'))}</dd></dl>` });
  K.help = help;
  let g = 0;
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector('dialog[open]')) return;
    if (g && Date.now() - g < 1200) { g = 0; const m = { h: '/', c: '/cases', i: '/inbox' }[e.key]; if (m) { e.preventDefault(); K.go(m); } return; }
    if (e.key === 'g') { g = Date.now(); return; }
    if (e.key === '/') { const q = K.$('#q'); if (q) { e.preventDefault(); q.focus(); } else { e.preventDefault(); K.go('/cases'); } }
    else if (e.key === 'n') { e.preventDefault(); K.go('/cases?new=1'); }
    else if (e.key === '?') { e.preventDefault(); help(); }
  });

  // First-visit tour: four short steps, shown once per person per browser.
  K.tour = async (force = false) => {
    if (!force && navigator.webdriver) return; // automated test browsers
    const key = 'tour:' + (K.s.me?.id ?? ''); if (!force && K.ls.get(key, '')) return;
    K.ls.set(key, '1');
    for (let i = 1; i <= 4; i++) {
      const r = await K.dialog({ title: L.t(`tour${i}T`), ok: L.t(i === 4 ? 'tourDone' : 'tourNext'), cancel: L.t('tourSkip'), body: `<p>${esc(L.t(`tour${i}B`))}</p><p class="tour-n">${esc(K.num(i))} ${esc(L.t('tourOf'))} ${esc(K.num(4))}</p>` });
      if (!r.ok) return;
    }
  };
})();
