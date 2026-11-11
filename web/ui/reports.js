// Reports inbox (ethics officer) and reporting channels (administrator). A report arrives without sign-in and sits here
// before it is a case. Nothing on this screen can identify the reporter: there is nothing stored to show.
(() => {
  const K = CMS, { esc } = K;
  const isOfficer = () => K.s.me?.roles?.includes('ethics_officer');
  const isAdmin = () => K.s.me?.roles?.includes('tenant_admin');
  const KINDS = { HR: { type: 'hr.misconduct', what: 'allegationSummary' }, SEC: { type: 'security.incident', what: 'narrative' } };

  const list = async (route) => {
    const st = route.query.get('status') || '';
    const [rr, cc] = await Promise.all([isOfficer() ? K.api('GET', '/reports' + (st ? `?status=${encodeURIComponent(st)}` : '')) : Promise.resolve(null), isAdmin() ? K.api('GET', '/report-channels') : Promise.resolve(null)]);
    const items = Array.isArray(rr?.j) ? rr.j : [];
    const chans = Array.isArray(cc?.j) ? cc.j : [];
    const filters = ['', 'UNTRIAGED', 'CONVERTED', 'DISMISSED'].map((x) => `<a class="chip" href="#/reports${x ? `?status=${x}` : ''}" ${x === st ? 'aria-current="true"' : ''}>${esc(x ? L.t('rptStatus_' + x) : L.t('rptFilterAll'))}</a>`).join(' ');
    const inbox = !isOfficer() ? '' : `<section class="card"><div class="page-h"><h3>${esc(L.t('rptT'))}</h3></div><p class="mute">${esc(L.t('rptSub'))}</p><p>${filters}</p>
      ${items.length ? `<ul class="notifs">${items.map((r) => `<li class="${r.awaitingStaff ? 'unread' : ''}"><a href="#/reports/${encodeURIComponent(r.id)}"><span>${esc(L.t('rptCat_' + r.category))} · ${esc(L.t('rptStatus_' + r.status))}${r.awaitingStaff ? ` · <b>${esc(L.t('rptWaiting'))}</b>` : ''}</span><span class="mute">${r.messageCount} ${esc(L.t('rptMsgs'))}</span><span class="mute">${K.time(r.updatedAt)}</span></a></li>`).join('')}</ul>` : `<div class="empty">${K.ic('inbox')}<p>${esc(L.t('rptEmpty'))}</p></div>`}</section>`;
    const channels = !isAdmin() ? '' : `<section class="card"><h3>${esc(L.t('chT'))}</h3><p class="mute">${esc(L.t('chSub'))}</p>
      ${chans.length ? chans.map((c) => `<article class="chan${c.active ? '' : ' off'}" data-ch="${esc(c.id)}"><div class="qr"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.qr)}" width="140" height="140"></div>
        <div><strong>${esc(c.label[K.s.lang])}</strong>${c.active ? '' : ` <span class="mute">(${esc(L.t('chOff'))})</span>`}<div class="mute code" dir="ltr">${esc(c.url)}</div>
        <p class="row"><button class="secondary sm" data-print="${esc(c.id)}">${esc(L.t('chPrint'))}</button> <button class="secondary sm" data-toggle="${esc(c.id)}" data-to="${c.active ? 'off' : 'on'}">${esc(c.active ? L.t('chDisable') : L.t('chEnable'))}</button></p></div></article>`).join('') : `<p class="mute">${esc(L.t('chNone'))}</p>`}
      <form id="chf" class="grid"><h4>${esc(L.t('chNew'))}</h4>
        <div class="field"><label for="cha">${esc(L.t('chLabelAr'))}</label><input id="cha" required minlength="2" maxlength="120"></div>
        <div class="field"><label for="che">${esc(L.t('chLabelEn'))}</label><input id="che" required minlength="2" maxlength="120" dir="ltr"></div>
        <div class="row"><button type="submit">${esc(L.t('chCreate'))}</button></div></form></section>`;
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('navReports'))}</h2></div>${inbox}${channels}`;
    const after = (root) => {
      const f = K.$('#chf', root);
      if (f) f.onsubmit = async (e) => { e.preventDefault(); const res = await K.api('POST', '/report-channels', { labelAr: K.$('#cha', root).value, labelEn: K.$('#che', root).value }); if (K.report(res, L.t('saved'))) K.render({ keepScroll: true }); };
      K.$$('[data-toggle]', root).forEach((b) => (b.onclick = async () => { const res = await K.api('PATCH', `/report-channels/${encodeURIComponent(b.dataset.toggle)}`, { active: b.dataset.to === 'on' }); if (K.report(res, L.t('saved'))) K.render({ keepScroll: true }); }));
      K.$$('[data-print]', root).forEach((b) => (b.onclick = () => {
        const c = chans.find((x) => x.id === b.dataset.print); if (!c) return;
        const w = document.createElement('div'); w.className = 'poster-print';
        w.innerHTML = `<h1>${esc(L.t('chScan'))}</h1><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.qr)}" width="420" height="420"><p>${esc(c.label.ar)} · ${esc(c.label.en)}</p><p dir="ltr" class="code">${esc(c.url)}</p>`;
        document.body.appendChild(w); document.body.classList.add('printing-poster');
        const done = () => { w.remove(); document.body.classList.remove('printing-poster'); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done); window.print();
      }));
    };
    return { title: L.t('navReports'), html, after };
  };

  const one = async (id) => {
    const r = await K.api('GET', `/reports/${encodeURIComponent(id)}`);
    if (r.status === 404) { const e = new Error('nf'); e.notFound = true; throw e; }
    if (!r.ok) throw new Error('fail');
    const x = r.j, open = x.status === 'UNTRIAGED';
    const msgs = x.messages.map((m) => `<div class="msg ${m.author === 'REPORTER' ? 'rep' : 'staff'}"><div class="mute">${esc(m.author === 'REPORTER' ? L.t('rptReporter') : (K.who(m.authorId) || L.t('rptTeam')))} · ${K.time(m.at)}</div><div class="msgtext">${esc(m.text)}</div></div>`).join('');
    const kinds = Object.entries(KINDS).filter(([, v]) => K.s.defs[v.type]);
    const first = x.messages[0]?.text ?? '';
    const html = `<nav class="crumb"><a href="#/reports">${esc(L.t('rptBack'))}</a></nav>
      <div class="page-h"><h2 id="h">${esc(L.t('rptCat_' + x.category))} · ${esc(L.t('rptStatus_' + x.status))}</h2></div><p class="mute">${esc(L.t('rptAnonNote'))}</p>
      ${x.caseId ? `<p><a class="btn secondary" href="#/cases/${encodeURIComponent(x.caseId)}">${esc(L.t('rptCaseLink'))}: <span class="code">${esc(x.caseId)}</span></a></p>` : ''}
      ${x.closingNote ? `<section class="card"><h3>${esc(L.t('rptClosedNote'))}</h3><p>${esc(x.closingNote)}</p></section>` : ''}
      <section class="card thread">${msgs}</section>
      ${x.status === 'CONVERTED' ? '' : `<section class="card"><form id="rpf" class="grid"><div class="field"><label for="rpt">${esc(L.t('rptReplyPh'))}</label><textarea id="rpt" rows="4" required maxlength="5000"></textarea></div><div class="row"><button type="submit">${K.ic('send')} ${esc(L.t('rptSend'))}</button></div></form></section>`}
      ${open ? `<section class="card"><h3>${esc(L.t('rptConvert'))}</h3>${kinds.length ? `<form id="cvf" class="grid"><div class="field"><label for="cvk">${esc(L.t('rptConvertKind'))}</label><select id="cvk">${kinds.map(([k]) => `<option value="${k}">${esc(L.t('reportKind' + k))}</option>`).join('')}</select></div>
        <div class="field"><label for="cvs">${esc(L.t('rptConvertSummary'))}</label><textarea id="cvs" rows="5" required maxlength="5000">${esc(first.slice(0, 5000))}</textarea></div><div class="row"><button type="submit">${esc(L.t('rptConvertGo'))}</button></div></form>` : ''}</section>
        <section class="card"><form id="dsf" class="grid"><div class="field"><label for="dsn">${esc(L.t('rptDismissNote'))}</label><textarea id="dsn" rows="2" required minlength="5" maxlength="2000"></textarea></div><div class="row"><button type="submit" class="secondary">${esc(L.t('rptDismiss'))}</button></div></form></section>` : ''}`;
    const after = (root) => {
      const rp = K.$('#rpf', root); if (rp) rp.onsubmit = async (e) => { e.preventDefault(); const res = await K.api('POST', `/reports/${encodeURIComponent(id)}/reply`, { text: K.$('#rpt', root).value }); if (K.report(res, L.t('rptSent'))) K.render({ keepScroll: true }); };
      const cv = K.$('#cvf', root); if (cv) cv.onsubmit = async (e) => { e.preventDefault(); const k = KINDS[K.$('#cvk', root).value]; const res = await K.api('POST', `/reports/${encodeURIComponent(id)}/convert`, { caseType: k.type, fields: { [k.what]: K.$('#cvs', root).value.trim() } }); if (K.report(res, L.t('rptConverted'))) K.go(`/cases/${encodeURIComponent(res.j.caseId)}`); };
      const ds = K.$('#dsf', root); if (ds) ds.onsubmit = async (e) => { e.preventDefault(); const res = await K.api('POST', `/reports/${encodeURIComponent(id)}/dismiss`, { note: K.$('#dsn', root).value }); if (K.report(res, L.t('saved'))) K.render({ keepScroll: true }); };
    };
    return { title: L.t('navReports'), html, after };
  };

  CMS.views.reports = (route) => (route.params[0] ? one(route.params[0]) : list(route));
})();
