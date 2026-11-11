// PREVIEW ONLY. Loaded by the static demo build (scripts/build-demo.mts), never by the real app.
// Answers the app's API calls from a recording of the real server (sample data), refuses changes, and fakes the
// anonymous report page so the whole flow can be looked at without a backend.
(() => {
  const real = window.fetch.bind(window);
  let data = null;
  const ready = real('/demo-data.json').then((r) => r.json()).then((d) => { data = d; });
  const API = /^\/(auth|me|people|case-types|cases|dashboard|persons|notifications|laws|ai|reports|report-channels|board-report|public|health)(\/|$)/;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const lang = () => { try { return localStorage.getItem('lang') || 'ar'; } catch { return 'ar'; } };

  // Banner
  const banner = () => {
    if (document.getElementById('demoBar')) return;
    const b = document.createElement('div'); b.id = 'demoBar'; b.setAttribute('role', 'note');
    b.textContent = lang() === 'ar' ? 'نسخة معاينة ببيانات تجريبية: يمكنك التصفح فقط، ولا يُحفظ أي تغيير.' : 'Preview with sample data: browse only, nothing is saved.';
    Object.assign(b.style, { background: '#b8923a', color: '#14284b', textAlign: 'center', padding: '6px 12px', font: '600 14px system-ui,sans-serif', position: 'sticky', top: '0', zIndex: '9999' });
    document.body.prepend(b);
  };
  document.addEventListener('DOMContentLoaded', () => { if (!location.pathname.startsWith('/r/') && !location.pathname.endsWith('report.html')) banner(); });

  // Fake anonymous reporting, in memory.
  const threads = new Map();
  const view = (t) => ({ status: t.status, canReply: true, createdAt: t.createdAt, messages: t.messages });
  const rcode = () => { const a = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; return Array.from({ length: 6 }, () => Array.from({ length: 4 }, () => a[Math.floor(Math.random() * a.length)]).join('')).join('-'); };
  const pub = (path, method, body) => {
    const m = path.match(/^\/public\/[^/]+(\/.*)?$/); const sub = m?.[1] ?? '';
    if (method === 'GET' && !sub) return json({ label: { ar: 'مستودع الرياض الرئيسي (معاينة)', en: 'Riyadh main warehouse (preview)' }, categories: ['HR', 'SECURITY', 'AUDIT', 'LEGAL', 'UNSURE'], languages: ['ar', 'en', 'other'], limits: { minText: 10, maxText: 20000, maxReply: 5000 } });
    if (method === 'POST' && sub === '/reports') {
      if (typeof body?.text !== 'string' || body.text.trim().length < 10) return json({ error: 'INVALID_FIELDS' }, 400);
      const code = rcode(); const now = new Date().toISOString();
      const t = { status: 'RECEIVED', createdAt: now, messages: [{ n: 1, from: 'YOU', text: body.text, at: now }] };
      threads.set(code.replace(/-/g, ''), t); return json({ code, ...view(t) }, 201);
    }
    const t = threads.get(String(body?.code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, ''));
    if (!t) return json({ error: 'NOT_FOUND' }, 404);
    if (sub === '/track') return json(view(t));
    if (sub === '/track/reply') { t.messages.push({ n: t.messages.length + 1, from: 'YOU', text: String(body.text ?? ''), at: new Date().toISOString() }); return json(view(t)); }
    return json({ error: 'NOT_FOUND' }, 404);
  };

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
    if (url.origin !== location.origin || !API.test(url.pathname)) return real(input, init);
    await ready;
    const method = (init.method || 'GET').toUpperCase();
    let body = null; try { body = init.body ? JSON.parse(init.body) : null; } catch { /* not json */ }
    if (url.pathname.startsWith('/public/')) return pub(url.pathname, method, body);
    if (url.pathname === '/auth/config') return json(data.config);
    if (method !== 'GET') { banner(); const t = document.getElementById('demoBar'); if (t) { t.textContent = lang() === 'ar' ? 'هذه معاينة: لا يمكن حفظ التغييرات.' : 'This is a preview: changes cannot be saved.'; } return json({ error: 'PREVIEW_ONLY' }, 403); }
    const h = init.headers || {}; const auth = h.authorization || h.Authorization || '';
    const user = auth.replace(/^Bearer dev:/, ''); const l = url.searchParams.get('lang') || lang();
    const q = new URLSearchParams(url.search); q.delete('lang'); const s = q.toString();
    const hit = data.r[`${user}|${l}|${url.pathname}${s ? `?${s}` : ''}`] || data.r[`${user}|${l}|${url.pathname}`];
    return hit ? new Response(hit.b, { status: hit.s, headers: { 'content-type': 'application/json' } }) : json({ error: 'NOT_IN_PREVIEW' }, 404);
  };
})();
