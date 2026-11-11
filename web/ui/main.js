// Shell, router, boot. Hash routes keep every screen linkable and make the browser's back button work.
(() => {
  const K = CMS, { esc } = K;
  const parse = () => {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, q = ''] = h.split('?');
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
    const query = new URLSearchParams(q);
    if (!seg.length) return { name: 'home', params: [], query };
    if (seg[0] === 'cases' && seg[1]) return { name: 'case', params: [seg[1], seg[2]], query };
    return { name: ['cases', 'laws', 'ai', 'review', 'people', 'inbox'].includes(seg[0]) ? seg[0] : 'home', params: [], query };
  };
  K.go = (path) => { if (('#' + path) === location.hash) K.render(); else location.hash = path; };
  const isBack = () => K.s.me?.tenantId === 'platform';
  const navItems = () => (isBack() ? [['/review', 'navReview', 'scale', 'review'], ['/laws', 'navLaws', 'scale', 'laws']] : [['/', 'navHome', 'home', 'home'], ['/cases', 'navCases', 'folder', 'cases'], ['/laws', 'navLaws', 'scale', 'laws'], ['/ai', 'navAi', 'spark', 'ai'], ...(K.s.me?.roles?.includes('tenant_admin') ? [['/people', 'navPeople', 'user', 'people']] : [])]);

  function chrome(route) {
    const doc = document.documentElement;
    doc.lang = K.s.lang; doc.dir = K.ar() ? 'rtl' : 'ltr';
    K.$('#skip').textContent = L.t('skip');
    K.$('#appTitle').textContent = L.t('app');
    K.$('#nav').innerHTML = navItems().map(([href, lbl, ic, name]) => `<li><a href="#${href}" ${route.name === name || (route.name === 'case' && name === 'cases') ? 'aria-current="page"' : ''}>${K.ic(ic)} ${esc(L.t(lbl))}</a></li>`).join('');
    K.$('#navWrap').setAttribute('aria-label', L.t('navMain'));
    K.$('#prefsSum').innerHTML = `${K.ic('cog')}<span class="sr-only">${esc(L.t('prefs'))}</span>`; K.$('#prefsSum').title = L.t('prefs');
    const lb = K.$('#langBtn'); lb.textContent = L.t('langSwitch'); lb.lang = K.ar() ? 'en' : 'ar';
    const db = K.$('#digitsBtn'); db.textContent = K.s.digits === 'arab' ? L.t('digitsLatn') : L.t('digitsArab'); db.setAttribute('aria-label', `${L.t('digits')}: ${db.textContent}`);
    const who = K.$('#who');
    if (Auth.mode === 'oidc') who.innerHTML = `${K.ic('user')} ${esc(Auth.me.name)} <button id="outBtn" type="button">${esc(L.t('signOut'))}</button>`, K.$('#outBtn').onclick = Auth.logout;
    else {
      const byT = Auth.users.reduce((m, u) => ((m[u.tenantId] ??= []).push(u), m), {});
      who.innerHTML = `<label>${esc(L.t('user'))} <select id="user">${Object.entries(byT).map(([t, us]) => `<optgroup label="${esc(t)}">${us.map((u) => `<option value="${esc(u.id)}" ${u.id === K.s.user ? 'selected' : ''}>${esc(u.id)} — ${esc(u.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
      K.$('#user').onchange = (e) => { K.s.user = e.target.value; K.ls.set('user', K.s.user); K.s.me = null; K.s.people = null; location.hash = '/'; K.render(); };
    }
  }

  let seq = 0;
  K.render = async ({ keepScroll = false } = {}) => {
    const my = ++seq; const view = K.$('#view'); const y = window.scrollY;
    if (!K.s.me) {
      const me = Auth.mode === 'oidc' ? Auth.me : (await K.api('GET', '/me')).j;
      if (!me?.id) { view.innerHTML = `<div class="empty">${K.ic('lock')}<p>${esc(L.t('e_401'))}</p></div>`; return; }
      K.s.me = me;
      const pp = (await K.api('GET', '/people')).j; K.s.people = Array.isArray(pp) ? pp : [];
      K.s.names = Object.fromEntries(K.s.people.map((u) => [u.id, u.name])); K.s.names[me.id] = me.name;
      K.s.defs = Object.fromEntries(((await K.api('GET', '/case-types')).j || []).map((d) => [d.key, d]));
    }
    const route = parse();
    chrome(route);
    if (!keepScroll) view.innerHTML = `<div aria-busy="true"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div><span class="sr-only" role="status">${esc(L.t('loading'))}</span>`;
    let out;
    try {
      const fn = K.views[route.name === 'home' && isBack() ? 'home' : route.name];
      out = await fn(route);
    } catch (e) {
      if (my !== seq) return;
      view.innerHTML = e.notFound ? `<div class="empty">${K.ic('search')}<h2 id="h">${esc(L.t('e_404'))}</h2><p><a class="btn secondary" href="#/cases">${esc(L.t('cases'))}</a></p></div>` : `<div class="empty">${K.ic('alert')}<h2 id="h">${esc(L.t('e_generic'))}</h2><button class="secondary" id="retry">${esc(L.t('retry'))}</button></div>`;
      const rt = K.$('#retry'); if (rt) rt.onclick = () => K.render(); document.title = L.t('app'); return;
    }
    if (my !== seq) return;
    if (K.bell) K.bell();
    view.innerHTML = out.html; document.title = `${out.title} · ${L.t('app')}`;
    out.after?.(view);
    if (keepScroll) window.scrollTo(0, y); else { window.scrollTo(0, 0); const h = K.$('#h'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
  };

  window.addEventListener('hashchange', () => K.render());
  K.$('#langBtn').onclick = () => { K.$('#prefs').open = false; K.s.lang = K.ar() ? 'en' : 'ar'; K.ls.set('lang', K.s.lang); K.render({ keepScroll: true }); };
  K.$('#digitsBtn').onclick = () => { K.$('#prefs').open = false; K.s.digits = K.s.digits === 'arab' ? 'latn' : 'arab'; K.ls.set('digits', K.s.digits); K.render({ keepScroll: true }); };
  Auth.init().then(() => K.render());
})();
