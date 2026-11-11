// Notifications: header bell (unread count, polled) and the inbox page. A notification names an event; it never holds case content.
(() => {
  const K = CMS, { esc } = K;
  let timer = null;
  K.bell = async () => {
    const a = K.$('#bell'); if (!a) return;
    const r = await K.api('GET', '/notifications/count').catch(() => null); const n = r?.j?.unread ?? 0;
    a.innerHTML = `${K.ic('bell')}${n ? `<span class="bell-n">${n > 99 ? '99+' : n}</span>` : ''}<span class="sr-only">${esc(L.t('bell'))}${n ? ` (${n})` : ''}</span>`;
    a.title = L.t('bell');
    if (!timer) timer = setInterval(() => { if (!document.hidden) K.bell(); }, 60000);
  };
  CMS.views.inbox = async () => {
    const [r, st] = await Promise.all([K.api('GET', '/notifications'), K.api('GET', '/notifications/settings')]);
    const items = r.j?.items || [], unread = r.j?.unread ?? 0, s = st.j || {};
    const row = (n) => `<li class="${n.read ? '' : 'unread'}"><a href="#/${n.kind.startsWith('REPORT_') ? 'reports' : 'cases'}/${encodeURIComponent(n.caseId)}${n.kind === 'MENTIONED' ? '/notes' : ''}" data-n="${esc(n.id)}"><span>${esc(L.notif(n, K.s.names || {}))}</span><span class="mute">${n.case ? esc(n.case.title || n.caseId) : esc(n.caseId)}</span><span class="mute">${K.time(n.createdAt)}</span></a></li>`;
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('inboxT'))}</h2><span class="spacer"></span>${unread ? `<button class="secondary sm" id="markall">${esc(L.t('markAll'))}</button>` : ''}</div>
      <section class="card">${items.length ? `<ul class="notifs">${items.map(row).join('')}</ul>` : `<div class="empty">${K.ic('inbox')}<p>${esc(L.t('inboxEmpty'))}</p></div>`}</section>
      <section class="card"><label class="check"><input type="checkbox" id="emailpref" ${s.emailOptout ? '' : 'checked'} ${s.hasEmail ? '' : 'disabled'}> ${esc(L.t('emailMe'))}</label>${s.hasEmail ? '' : `<p class="mute">${esc(L.t('noEmailAddr'))}</p>`}</section>`;
    const after = (root) => {
      const m = K.$('#markall', root); if (m) m.onclick = async () => { await K.api('POST', '/notifications/read', { all: true }); K.render({ keepScroll: true }); };
      K.$$('[data-n]', root).forEach((a) => (a.onclick = () => { K.api('POST', '/notifications/read', { ids: [a.dataset.n] }); }));
      const e = K.$('#emailpref', root); if (e) e.onchange = async () => { const res = await K.api('PUT', '/notifications/settings', { emailOptout: !e.checked }); if (K.report(res, L.t('saved'))) { /* ok */ } };
    };
    return { title: L.t('inboxT'), html, after };
  };
})();
