// Home: what needs my attention, in this order: waiting on me, overdue, then the shape of the work.
(() => {
  const K = CMS, { esc } = K;
  const why = (w) => ({ ASSIGNED: ['info', L.t('assignedToMe')], READY: ['ok', L.t('readyToAct')], APPROVAL: ['warn', L.t('waitingApproval')] }[w] ?? ['', w]);
  const link = (h, inner, cls = '') => `<a href="#${h}" class="${cls}">${inner}</a>`;
  const stat = (n, label, href, tone = '') => `<a class="stat ${tone}" href="#${href}"><span class="n num">${esc(K.num(n))}</span><span class="l">${esc(label)}</span></a>`;
  const bars = (rows, labelOf, href) => { const max = Math.max(1, ...rows.map((r) => r.count)); return rows.length ? `<div class="bars">${rows.map((r) => `<a class="bar-r" href="#${href(r)}"><span>${esc(labelOf(r))}</span><span class="track" aria-hidden="true"><span class="fill" data-w="${Math.round((r.count / max) * 100)}"></span></span><b class="num">${esc(K.num(r.count))}</b></a>`).join('')}</div>` : `<p class="empty">${esc(L.t('none'))}</p>`; };

  CMS.views = CMS.views || {};
  CMS.views.home = async () => {
    const me = K.s.me;
    if (me.tenantId === 'platform') {
      const [rev, ct] = await Promise.all([K.api('GET', '/laws/review'), K.api('GET', '/case-types')]);
      const pending = (rev.j || []).filter((v) => v.status === 'UNDER_REVIEW' || v.status === 'DRAFT').length;
      const need = (ct.j || []).filter((d) => d.legal.status !== 'READY').length;
      return { title: L.t('platformHome'), html: `<div class="page-h"><h2 id="h">${esc(L.t('platformHome'))}</h2></div><p class="mute">${esc(L.t('platformHomeSub'))}</p>
        <div class="grid g3">${stat(pending, L.t('versionsPending'), '/review', pending ? 'warnish' : '')}${stat(need, L.t('rulesNeed'), '/review')}</div>` };
    }
    const r = await K.api('GET', '/dashboard');
    if (!r.ok) throw new Error('dashboard');
    const d = r.j, c = d.counts;
    const typeShort = (k) => L.caseType(k);
    const queue = d.queue.length ? `<ul class="list">${d.queue.map((q) => `<li><div class="t"><a class="row-link" href="#/cases/${encodeURIComponent(q.id)}"><b>${esc(q.title ?? q.id)}</b></a><div class="mute"><span class="code">${esc(q.id)}</span> · ${esc(typeShort(q.caseTypeKey))}</div></div>
        <span class="badge">${esc(L.state(K.s.defs[q.caseTypeKey], q.state))}</span>${q.why.map((w) => { const [tone, t] = why(w); return `<span class="badge ${tone}">${esc(t)}</span>`; }).join('')}<span class="mute num">${esc(K.num(q.ageDays))} ${esc(L.t('daysShort'))}</span></li>`).join('')}</ul>` : `<div class="empty">${K.ic('check')}<p>${esc(L.t('queueEmpty'))}</p></div>`;
    const acts = d.actions.length ? `<ul class="list">${d.actions.map((a) => `<li><div class="t"><a class="row-link" href="#/cases/${encodeURIComponent(a.caseId)}/actions"><b>${esc(a.description)}</b></a><div class="mute">${esc(a.caseTitle ?? a.caseId)}${a.ownerId ? ` · ${esc(L.t('ownerLbl'))}: ${esc(a.ownerId)}` : ''}</div></div><span class="badge ${a.overdue ? 'bad' : 'warn'}">${a.overdue ? K.ic('alert') + ' ' + esc(L.t('overdueB')) : esc(L.t('dueOn'))} ${K.date(a.dueDate)}</span></li>`).join('')}</ul>` : `<p class="empty">${esc(L.t('none'))}</p>`;
    const html = `<div class="page-h"><div><h2 id="h">${esc(L.t('hello'))}، ${esc(me.name)}</h2><div class="mute">${esc(L.t('homeSub'))} · ${K.dateBoth(new Date().toISOString())}</div></div><span class="spacer"></span><a class="btn gold" href="#/cases?new=1">${K.ic('plus')} ${esc(L.t('newCase'))}</a></div>
      <div class="stats">${stat(c.needsMe, L.t('needsMe'), '/cases?needs=1', c.needsMe ? 'warnish' : '')}${stat(c.overdue, L.t('overdue'), '/cases?overdue=1', c.overdue ? 'alert' : '')}${stat(c.dueSoon, L.t('dueSoon'), '/cases?due=7')}${stat(c.open, L.t('openCases'), '/cases?open=1')}${stat(c.onHold, L.t('onHold'), '/cases?open=1')}${stat(c.closed, L.t('closedCases'), '/cases')}</div>
      <div class="grid g2 mt16"><section class="card" aria-labelledby="q-h"><div class="card-h">${K.ic('inbox')}<h3 id="q-h">${esc(L.t('myQueue'))}</h3></div>${queue}</section>
      <section class="card" aria-labelledby="a-h"><div class="card-h">${K.ic('clock')}<h3 id="a-h">${esc(L.t('actionsDue'))}</h3></div>${acts}</section></div>
      <div class="grid g2"><section class="card" aria-labelledby="s-h"><h3 id="s-h">${esc(L.t('byState'))}</h3>${bars(d.byState, (r) => `${typeShort(r.caseTypeKey)} · ${L.state(K.s.defs[r.caseTypeKey], r.state)}`, (r) => `/cases?type=${encodeURIComponent(r.caseTypeKey)}&state=${encodeURIComponent(r.state)}`)}</section>
      <section class="card" aria-labelledby="d-h"><h3 id="d-h">${esc(L.t('byDept'))}</h3>${bars(d.byDept, (r) => L.dept(r.key), (r) => `/cases?open=1&dept=${encodeURIComponent(r.key)}`)}</section></div>
      <section class="card" aria-labelledby="r-h"><h3 id="r-h">${esc(L.t('recent'))}</h3><ul class="list">${d.recent.map((q) => `<li><div class="t"><a class="row-link" href="#/cases/${encodeURIComponent(q.id)}"><b>${esc(q.title ?? q.id)}</b></a><div class="mute"><span class="code">${esc(q.id)}</span></div></div><span class="badge">${esc(L.state(K.s.defs[q.caseTypeKey], q.state))}</span>${K.time(q.stateEnteredAt)}</li>`).join('') || `<li class="empty">${esc(L.t('noCases'))}</li>`}</ul><p><a href="#/cases">${esc(L.t('allCases'))}</a></p></section>`;
    return { title: L.t('navHome'), html, after: (root) => K.$$('.fill', root).forEach((f) => (f.style.width = f.dataset.w + '%')) };
  };
})();
