// Anonymous Report & Track page. It stores nothing in the browser (no cookies, no local storage), loads nothing from any
// other site, and sends nothing but what the person types. The reference code lives only in memory and on screen.
(function () {
  'use strict';
  var token = (location.pathname.match(/^\/r\/([A-Za-z0-9_-]{22})\/?$/) || [])[1];
  var base = '/public/' + token;
  var lang = /^en/i.test(navigator.language || '') ? 'en' : 'ar';
  var info = null, tab = 'new', code = null, thread = null, busy = false;

  var S = {
    ar: {
      title: 'تقديم بلاغ', sub: 'بلاغك يصل إلى مسؤول الأخلاقيات في الجهة. لا يُطلب منك اسم ولا تسجيل دخول.',
      tabNew: 'بلاغ جديد', tabTrack: 'متابعة بلاغ', cat: 'نوع البلاغ', text: 'ما الذي حدث؟',
      textHelp: 'اكتب ما تعرفه: ماذا، ومتى، وأين، ومن المعنيّ. كلما كانت التفاصيل أوضح تمكّنّا من المتابعة.',
      send: 'إرسال البلاغ', sending: 'جارٍ الإرسال…', chars: 'حرف', min: 'اكتب 10 أحرف على الأقل.',
      privacyH: 'إن أردت أن تبقى مجهولًا',
      privacy: ['لا نسجّل عنوانك ولا نوع جهازك ولا نضع ملفات تعريف ارتباط.', 'لا تذكر في البلاغ ما يدلّ على هويتك إن كنت لا تريد ذلك، فطريقة الكتابة والتفاصيل الدقيقة قد تكشف صاحبها.', 'إن كنت تخشى أن تُعرَف، فاستخدم جهازًا وشبكة لا يخصّان جهة العمل.'],
      doneH: 'تم استلام بلاغك', codeH: 'رمز المتابعة', codeWarn: 'احفظ هذا الرمز الآن. هو الطريقة الوحيدة للاطلاع على الردود أو إضافة معلومات. لا نحتفظ به ولا نستطيع استرجاعه أو إعادة إصداره، وإن ضاع فلن تستطيع متابعة هذا البلاغ، وستحتاج إلى تقديم بلاغ جديد.',
      copy: 'نسخ الرمز', copied: 'تم النسخ', download: 'حفظ في ملف', trackNow: 'متابعة البلاغ', again: 'تقديم بلاغ آخر',
      enterCode: 'رمز المتابعة', open: 'فتح', notFound: 'لم نجد بلاغًا بهذا الرمز. تأكد من كتابته كما هو.',
      you: 'أنت', team: 'فريق الأخلاقيات', status: { RECEIVED: 'تم الاستلام وهو قيد المراجعة', ACCEPTED: 'تم قبول البلاغ وفتح إجراء بشأنه', CLOSED: 'أُغلق البلاغ' },
      reply: 'إضافة رد أو معلومات', replyBtn: 'إرسال', closedHint: 'يمكنك الرد إن كانت لديك معلومات إضافية، وسيُعاد النظر في البلاغ.',
      limited: 'محاولات كثيرة. حاول بعد قليل.', fail: 'تعذّر الإرسال. لم يُحفظ شيء، حاول مرة أخرى.', gone: 'هذا الرابط غير صالح.', refresh: 'تحديث', other: 'English',
      cats: { HR: 'سلوك وظيفي / موارد بشرية', SECURITY: 'أمن وسلامة', AUDIT: 'مالي / تدقيق / احتيال', LEGAL: 'قانوني / نظامي', UNSURE: 'لست متأكدًا' },
    },
    en: {
      title: 'Report a concern', sub: 'Your report goes to the organisation’s ethics officer. No name and no sign-in is needed.',
      tabNew: 'New report', tabTrack: 'Follow up', cat: 'Type of concern', text: 'What happened?',
      textHelp: 'Say what you know: what, when, where and who is involved. The clearer the detail, the better we can follow up.',
      send: 'Send report', sending: 'Sending…', chars: 'characters', min: 'Write at least 10 characters.',
      privacyH: 'If you want to stay anonymous',
      privacy: ['We do not record your address or device type, and set no cookies.', 'Leave out details that point to you if you do not want to be identified: wording and very specific details can give a writer away.', 'If you fear being identified, use a device and network that do not belong to your employer.'],
      doneH: 'Your report was received', codeH: 'Your follow-up code', codeWarn: 'Save this code now. It is the only way to read replies or add information. We do not keep it and cannot recover or reissue it; if it is lost you will not be able to follow this report and would need to file a new one.',
      copy: 'Copy code', copied: 'Copied', download: 'Save as a file', trackNow: 'Follow this report', again: 'File another report',
      enterCode: 'Follow-up code', open: 'Open', notFound: 'No report matches this code. Check that it is typed exactly.',
      you: 'You', team: 'Ethics team', status: { RECEIVED: 'Received and under review', ACCEPTED: 'Accepted: action has been opened', CLOSED: 'This report was closed' },
      reply: 'Add a reply or more information', replyBtn: 'Send', closedHint: 'You can still reply if you have more information; the report will be looked at again.',
      limited: 'Too many attempts. Try again shortly.', fail: 'Could not send. Nothing was saved; please try again.', gone: 'This link is not valid.', refresh: 'Refresh', other: 'العربية',
      cats: { HR: 'Conduct / HR', SECURITY: 'Security and safety', AUDIT: 'Financial / audit / fraud', LEGAL: 'Legal / regulatory', UNSURE: 'Not sure' },
    },
  };
  var t = function () { return S[lang]; };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var root = document.getElementById('app');
  function paint(nodes) { root.textContent = ''; nodes.forEach(function (n) { root.appendChild(n); }); root.focus({ preventScroll: true }); }
  function fmt(iso) { try { return new Date(iso).toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Riyadh' }); } catch (e) { return iso; } }

  function api(path, body) {
    return fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }
  var failMsg = function (r) { return r.status === 429 ? t().limited : t().fail; };

  function header() {
    var label = info && info.label ? info.label[lang] : '';
    return [
      el('div', { class: 'bar' }, [el('span', { class: 'muted', text: label }), el('button', { type: 'button', text: t().other, onclick: function () { lang = lang === 'ar' ? 'en' : 'ar'; document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; render(); } })]),
      el('h1', { text: t().title }), el('p', { class: 'muted', text: t().sub }),
      el('div', { class: 'tabs', role: 'tablist' }, ['new', 'track'].map(function (k) {
        return el('button', { type: 'button', role: 'tab', 'aria-selected': tab === k ? 'true' : 'false', text: k === 'new' ? t().tabNew : t().tabTrack, onclick: function () { tab = k; thread = null; code = null; render(); } });
      })),
    ];
  }

  function newForm(msg) {
    var cat = el('select', { id: 'cat' }, info.categories.map(function (c) { return el('option', { value: c, text: t().cats[c] || c }); }));
    cat.value = 'UNSURE';
    var ta = el('textarea', { id: 'txt', maxlength: String(info.limits.maxText), required: true });
    var count = el('div', { class: 'count', 'aria-live': 'off' });
    var errBox = el('div', { 'aria-live': 'polite' });
    if (msg) errBox.appendChild(el('div', { class: 'err', text: msg }));
    var btn = el('button', { type: 'submit', class: 'primary', text: t().send });
    ta.addEventListener('input', function () { count.textContent = ta.value.length + ' / ' + info.limits.maxText + ' ' + t().chars; });
    var form = el('form', { novalidate: true, onsubmit: function (e) {
      e.preventDefault(); if (busy) return;
      if (ta.value.trim().length < info.limits.minText) { errBox.textContent = ''; errBox.appendChild(el('div', { class: 'err', text: t().min })); return; }
      busy = true; btn.disabled = true; btn.textContent = t().sending;
      api('/reports', { category: cat.value, language: lang, text: ta.value }).then(function (r) {
        busy = false;
        if (r.status === 201) { code = r.body.code; thread = r.body; ta.value = ''; done(); }
        else { btn.disabled = false; btn.textContent = t().send; errBox.textContent = ''; errBox.appendChild(el('div', { class: 'err', text: failMsg(r) })); }
      }).catch(function () { busy = false; btn.disabled = false; btn.textContent = t().send; errBox.textContent = ''; errBox.appendChild(el('div', { class: 'err', text: t().fail })); });
    } }, [el('label', { for: 'cat', text: t().cat }), cat, el('label', { for: 'txt', text: t().text }), el('p', { class: 'muted', text: t().textHelp }), ta, count, errBox, el('p', {}, [btn])]);
    return [form, el('div', { class: 'card' }, [el('h2', { text: t().privacyH }), el('ul', {}, t().privacy.map(function (p) { return el('li', { text: p }); }))])];
  }

  function done() {
    var shown = code;
    function save() {
      var blob = new Blob([shown + '\n'], { type: 'text/plain' });
      var u = URL.createObjectURL(blob);
      var a = el('a', { href: u, download: 'report-code.txt' }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
    }
    var status = el('span', { class: 'sr-only', 'aria-live': 'polite' });
    paint([
      el('h1', { text: t().doneH }),
      el('h2', { text: t().codeH }),
      el('div', { class: 'code', text: shown }),
      el('div', { class: 'note', role: 'alert', text: t().codeWarn }),
      el('div', { class: 'row' }, [
        el('button', { type: 'button', text: t().copy, onclick: function () { (navigator.clipboard ? navigator.clipboard.writeText(shown) : Promise.reject()).then(function () { status.textContent = t().copied; }).catch(function () {}); } }),
        el('button', { type: 'button', text: t().download, onclick: save }),
      ]), status,
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'primary', text: t().trackNow, onclick: function () { tab = 'track'; render(); } }),
        el('button', { type: 'button', text: t().again, onclick: function () { code = null; thread = null; tab = 'new'; render(); } }),
      ]),
    ]);
  }

  function trackForm(msg) {
    var inp = el('input', { id: 'code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', dir: 'ltr' });
    if (code) inp.value = code;
    var errBox = el('div', { 'aria-live': 'polite' });
    if (msg) errBox.appendChild(el('div', { class: 'err', text: msg }));
    var form = el('form', { onsubmit: function (e) { e.preventDefault(); load(inp.value, errBox); } }, [el('label', { for: 'code', text: t().enterCode }), inp, errBox, el('p', {}, [el('button', { type: 'submit', class: 'primary', text: t().open })])]);
    return [form];
  }
  function load(value, errBox) {
    api('/track', { code: value }).then(function (r) {
      if (r.status === 200) { code = value; thread = r.body; render(); }
      else { errBox.textContent = ''; errBox.appendChild(el('div', { class: 'err', text: r.status === 404 ? t().notFound : failMsg(r) })); }
    }).catch(function () { errBox.textContent = ''; errBox.appendChild(el('div', { class: 'err', text: t().fail })); });
  }
  function threadView() {
    var errBox = el('div', { 'aria-live': 'polite' });
    var ta = el('textarea', { id: 'rep', maxlength: String(info.limits.maxReply) });
    ta.style.minHeight = '110px';
    var msgs = thread.messages.map(function (m) {
      return el('div', { class: 'msg ' + (m.from === 'YOU' ? 'you' : 'team') }, [el('small', { text: (m.from === 'YOU' ? t().you : t().team) + ' · ' + fmt(m.at) }), document.createTextNode(m.text)]);
    });
    var form = !thread.canReply ? null : el('form', { onsubmit: function (e) {
      e.preventDefault(); if (!ta.value.trim()) return;
      api('/track/reply', { code: code, text: ta.value }).then(function (r) {
        if (r.status === 200) { thread = r.body; render(); }
        else { errBox.textContent = ''; errBox.appendChild(el('div', { class: 'err', text: r.status === 404 ? t().notFound : failMsg(r) })); }
      });
    } }, [el('label', { for: 'rep', text: t().reply }), thread.status === 'CLOSED' ? el('p', { class: 'muted', text: t().closedHint }) : null, ta, errBox, el('p', {}, [el('button', { type: 'submit', class: 'primary', text: t().replyBtn })])]);
    return [el('div', { class: thread.status === 'ACCEPTED' ? 'ok' : 'card', text: t().status[thread.status] }), ...msgs, form,
      el('p', {}, [el('button', { type: 'button', text: t().refresh, onclick: function () { load(code, errBox); } })])].filter(Boolean);
  }

  function render() {
    if (!info) return;
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    var body = tab === 'new' ? newForm() : (thread ? threadView() : trackForm());
    paint(header().concat(body));
  }

  if (!token) { paint([el('p', { class: 'err', text: S.ar.gone + ' · ' + S.en.gone })]); return; }
  api('').then(function (r) {
    if (r.status !== 200) { paint([el('p', { class: 'err', text: r.status === 429 ? t().limited : S.ar.gone + ' · ' + S.en.gone })]); return; }
    info = r.body; render();
  }).catch(function () { paint([el('p', { class: 'err', text: t().fail })]); });
})();
