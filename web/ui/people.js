// People & access (tenant admins): who has signed in, their departments and roles, and an immediate "end sessions" action.
(() => {
  const K = CMS, { esc } = K;
  CMS.views.people = async () => {
    if (!K.s.me.roles.includes('tenant_admin')) { const e = new Error('nf'); e.notFound = true; throw e; }
    const r = await K.api('GET', '/people');
    const list = r.j || [];
    const row = (p) => `<tr><th scope="row">${esc(p.name)}${p.id === K.s.me.id ? ` <span class="badge">${esc(L.t('youLbl'))}</span>` : ''}</th>
      <td data-l="${esc(L.t('pDept'))}">${esc((p.departments ?? []).map((d) => L.dept(d)).join('، ') || '—')}</td>
      <td data-l="${esc(L.t('pRoles'))}">${(p.roles ?? []).map((x) => `<span class="chip-s">${esc(L.role(x))}</span>`).join(' ') || '—'}</td>
      <td data-l="${esc(L.t('pSeen'))}">${p.lastSeen ? `<span title="${esc(K.dateTime(p.lastSeen))}">${esc(K.rel ? K.rel(p.lastSeen) : K.dateTime(p.lastSeen))}</span>` : `<span class="mute">${esc(L.t('pNever'))}</span>`}</td>
      <td>${p.id === K.s.me.id ? '' : `<button class="secondary sm" data-end="${esc(p.id)}" data-name="${esc(p.name)}">${esc(L.t('endSessions'))}</button>`}</td></tr>`;
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('peopleT'))}</h2></div><p class="mute">${esc(L.t('peopleSub'))}</p>
      <section class="card">${list.length ? `<div><table class="tbl stack"><thead><tr><th scope="col">${esc(L.t('pName'))}</th><th scope="col">${esc(L.t('pDept'))}</th><th scope="col">${esc(L.t('pRoles'))}</th><th scope="col">${esc(L.t('pSeen'))}</th><th scope="col"><span class="sr-only">${esc(L.t('endSessions'))}</span></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>` : `<p class="mute">${esc(L.t('noPeople'))}</p>`}</section>`;
    const after = (root) => K.$$('[data-end]', root).forEach((b) => (b.onclick = async () => {
      const res = await K.dialog({ title: L.t('endSessionsT'), ok: L.t('endSessions'), danger: true, body: `<p><b>${esc(b.dataset.name)}</b></p><p>${esc(L.t('endSessionsBody'))}</p>` });
      if (!res.ok) return;
      const out = await K.api('POST', '/admin/revoke-sessions', { subject: b.dataset.end });
      if (K.report(out)) K.toast(L.t('endSessionsDone'));
    }));
    return { title: L.t('peopleT'), html, after };
  };
})();
