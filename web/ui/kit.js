// UI kit: state, API, icons, toast, dialog, formatting. No framework, no build step. Everything user-visible goes through
// labels.js so Arabic and English stay in step.
window.CMS = window.CMS || {};
(() => {
  const K = CMS;
  const ls = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  K.ls = ls;
  K.views = {};
  K.s = { lang: ls.get('lang', 'ar'), user: ls.get('user', 'a-hr-mgr'), digits: ls.get('digits', 'latn'), me: null, defs: {} };
  K.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  K.$ = (s, r = document) => r.querySelector(s);
  K.$$ = (s, r = document) => [...r.querySelectorAll(s)];
  K.ar = () => K.s.lang === 'ar';

  // ---- Icons (24px, stroke) ----------------------------------------------------------
  const P = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', folder: '<path d="M3 6a2 2 0 012-2h4l2 3h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    scale: '<path d="M12 3v18M6 21h12M5 7h14"/><path d="M5 7l-3 7a3 3 0 006 0zM19 7l-3 7a3 3 0 006 0z"/>', spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="M5 12l5 5 9-10"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>', file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 20h16"/>', download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>', chevL: '<path d="M15 6l-6 6 6 6"/>', chevR: '<path d="M9 6l6 6-6 6"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    gavel: '<path d="M14 4l6 6-3 3-6-6zM9 9l-6 6 3 3 6-6M12 18h9"/>', hist: '<path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.5L3 9"/><path d="M3 4v5h5M12 8v4l3 2"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
    sort: '<path d="M8 4v16M4 16l4 4 4-4M16 20V4M12 8l4-4 4 4"/>', filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>', bell: '<path d="M6 17V11a6 6 0 0112 0v6l2 2H4z"/><path d="M10 21h4"/>', note: '<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8M8 12h5"/>', send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  };
  K.ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[n] ?? ''}</svg>`;

  // ---- API ---------------------------------------------------------------------------
  K.api = async (method, path, body) => {
    const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'lang=' + K.s.lang, {
      method, headers: { authorization: Auth.header(K.s.user), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  };

  // ---- Toast and result reporting ----------------------------------------------------
  K.toast = (msg, kind = 'ok', details = []) => {
    const box = K.$('#toasts'); if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind; el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML = `${K.ic(kind === 'err' ? 'alert' : 'check')}<div><div>${K.esc(msg)}</div>${details.length ? `<ul>${details.map((d) => `<li>${K.esc(d)}</li>`).join('')}</ul>` : ''}</div>`;
    box.append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 9000 : 3500);
  };
  /** Reports an API result in plain language. Returns r.ok so callers can chain. */
  K.report = (r, okMsg) => {
    if (r.ok) { K.toast(okMsg ?? L.t('saved'), 'ok'); return true; }
    const d = (r.j.blockers ?? []).map((b) => b.message);
    if (r.j.problems) d.push(...r.j.problems.map((p) => `${L.field(null, p.field)}: ${L.err(p.code)}`));
    K.toast(L.errorText(r.j, r.status), 'err', d);
    return false;
  };

  // ---- Dialog (native <dialog>: focus trap, Esc, inert background for free) ----------
  /** A person's name for an id (falls back to the id itself when unknown, e.g. someone who has not signed in yet). */
  K.who = (id) => (id && K.s.names?.[id]) || id || '';
  K.dialog = ({ title, body, ok, cancel, danger = false, hideCancel = false, onOpen }) => new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.setAttribute('aria-labelledby', 'dlg-t');
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3 id="dlg-t">${K.esc(title)}</h3>${body}</div><div class="dlg-f">${hideCancel ? '' : `<button class="secondary" value="cancel">${K.esc(cancel ?? L.t('cancel'))}</button>`}<button class="${danger ? 'danger' : ''}" value="ok" id="dlg-ok">${K.esc(ok ?? L.t('ok'))}</button></div></form>`;
    document.body.append(d);
    d.addEventListener('close', () => { const v = d.returnValue === 'ok'; const data = Object.fromEntries(new FormData(d.querySelector('form'))); d.remove(); resolve(v ? { ok: true, data } : { ok: false }); });
    K.$('#dlg-ok', d).addEventListener('click', (e) => { const f = K.$('form', d); if (!f.checkValidity()) { e.preventDefault(); f.reportValidity(); } });
    d.showModal(); onOpen?.(d); (K.$('[autofocus]', d) ?? K.$('#dlg-ok', d)).focus();
  });

  // ---- Formatting: Riyadh time, Hijri, digit style ----------------------------------
  const loc = () => (K.s.lang === 'ar' ? 'ar-SA' : 'en-GB') + `-u-nu-${K.s.digits === 'arab' ? 'arab' : 'latn'}`;
  const TZ = 'Asia/Riyadh';
  const valid = (iso) => iso && !Number.isNaN(Date.parse(iso));
  K.num = (n) => (typeof n === 'number' ? new Intl.NumberFormat(loc()).format(n) : String(n ?? ''));
  K.date = (iso) => (valid(iso) ? new Intl.DateTimeFormat(loc() + '-ca-gregory', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '');
  K.dateTime = (iso) => (valid(iso) ? new Intl.DateTimeFormat(loc() + '-ca-gregory', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '');
  K.hijri = (iso) => (valid(iso) ? new Intl.DateTimeFormat((K.s.lang === 'ar' ? 'ar-SA' : 'en-GB') + `-u-ca-islamic-umalqura-nu-${K.s.digits === 'arab' ? 'arab' : 'latn'}`, { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)) : '');
  /** Date with Hijri beneath: the form Saudi legal and HR documents use. */
  K.dateBoth = (iso) => (valid(iso) ? `${K.date(iso)} <span class="mute">· ${K.hijri(iso)}</span>` : '');
  K.rel = (iso) => {
    if (!valid(iso)) return '';
    const secs = (Date.parse(iso) - Date.now()) / 1000; const abs = Math.abs(secs);
    const rtf = new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' });
    if (abs < 45) return rtf.format(0, 'second');
    const [v, u] = abs < 3600 ? [Math.round(secs / 60), 'minute'] : abs < 86400 ? [Math.round(secs / 3600), 'hour'] : abs < 86400 * 30 ? [Math.round(secs / 86400), 'day'] : [Math.round(secs / 86400 / 30), 'month'];
    return rtf.format(v, u);
  };
  /** Age in days for lists: "Today" instead of "0 d". */
  K.age = (n) => (n < 1 ? L.t('today') : `${K.num(n)} ${L.t('daysShort')}`);
  K.time = (iso) => (valid(iso) ? `<time datetime="${K.esc(iso)}" title="${K.esc(K.dateTime(iso))}">${K.esc(K.rel(iso))}</time>` : '');
  K.daysUntil = (ymd) => Math.floor((Date.parse(ymd + 'T00:00:00+03:00') - Date.now()) / 86400000);
})();
