const I = {
  ar: { app:'منصة إدارة القضايا', user:'المستخدم', tabCases:'القضايا', tabLaws:'المكتبة النظامية', tabAi:'المساعد الذكي',
    newCase:'قضية جديدة', type:'النوع', id:'المعرّف', create:'إنشاء', state:'الحالة', open:'فتح', back:'رجوع',
    actions:'الإجراءات المتاحة', blockers:'موانع التنفيذ', run:'تنفيذ', fields:'الحقول', artifacts:'المستندات', audit:'سجل التدقيق',
    chainOk:'سلسلة التدقيق سليمة', chainBad:'سلسلة التدقيق تالفة', addArtifact:'إضافة مستند', artType:'نوع المستند', save:'حفظ',
    approve:'اعتماد بصفتي', role:'الدور', lawsTitle:'الأنظمة الموثّقة السارية', upload:'رفع نظام / نسخة', instId:'معرّف النظام', titleAr:'العنوان بالعربية',
    verId:'معرّف النسخة', label:'وسم النسخة', eff:'تاريخ السريان', text:'النص الكامل (المادة 1 … المادة 2 …)', submit:'إرسال للمراجعة', verify:'توثيق (اعتماد)', reject:'رفض',
    draftNote:'نص غير موثّق: لا يراه المساعد الذكي ولا تُبنى عليه القواعد حتى يعتمده مراجع قانوني مختلف عن الرافع.',
    ask:'اسأل', askLaw:'سؤال عن الأنظمة', askCase:'سؤال عن القضايا', question:'السؤال', draft:'مسودة تتطلب مراجعة بشرية — ليست رأياً قانونياً',
    citations:'المراجع', none:'لا شيء', noLaws:'لا توجد أنظمة موثّقة بعد', stale:'قواعد تحتاج إعادة اعتماد', article:'المادة', saved:'تم', err:'خطأ', engine:'محرك الذكاء الاصطناعي', engSov:'نموذجنا الخاص', engIk:'مزوّد سحابي داخل المملكة', consentT:'تفويض استخدام مزوّد داخل المملكة', inclP:'السماح بإرسال الأسماء والبيانات الشخصية', signName:'الاسم', signTitle:'المسمى الوظيفي', ack:'أقرّ بأنني مخوّل بالتوقيع وقرأت النص كاملاً', signB:'توقيع وتفعيل', revokeB:'سحب التفويض', signedBy:'وُقّع بواسطة', offNote:'لم يُفعَّل مزوّد سحابي لمنشأتك: لا تُرسل أي بيانات خارج بنيتنا.', noAi:'الذكاء الاصطناعي غير مفعّل', ready:'جاهزية القواعد النظامية', syncB:'ربط القواعد بالأنظمة الموثّقة', st_READY:'جاهز', st_NEEDS_COUNSEL:'يحتاج اعتماد المستشار', st_NO_STATUTORY_RULES_MAPPED:'لا توجد قواعد نظامية مربوطة بعد', staleN:'قواعد متقادمة', unboundN:'غير مربوطة', tabReview:'مراجعة الأنظمة (للفريق)', source:'النص المصدر', findings:'ما استخرجه الذكاء الاصطناعي', accept:'قبول', rejectP:'رفض', pending:'بانتظار التوثيق', nothing:'لا توجد نسخ قيد المراجعة', aiOnly:'مقترحات الذكاء الاصطناعي تظهر لفريق المنصة فقط ولا يراها العملاء' },
  en: { app:'Case Management Platform', user:'User', tabCases:'Cases', tabLaws:'Legal library', tabAi:'AI assistant',
    newCase:'New case', type:'Type', id:'ID', create:'Create', state:'State', open:'Open', back:'Back',
    actions:'Available actions', blockers:'Blockers', run:'Run', fields:'Fields', artifacts:'Artifacts', audit:'Audit log',
    chainOk:'Audit chain intact', chainBad:'Audit chain broken', addArtifact:'Add artifact', artType:'Artifact type', save:'Save',
    approve:'Approve as me', role:'Role', lawsTitle:'Verified laws in force', upload:'Upload law / version', instId:'Instrument ID', titleAr:'Arabic title',
    verId:'Version ID', label:'Version label', eff:'Effective from', text:'Full text (Article 1 … Article 2 …)', submit:'Submit for review', verify:'Verify (approve)', reject:'Reject',
    draftNote:'Unverified text: invisible to the AI and rules until a different legal reviewer approves it.',
    ask:'Ask', askLaw:'Ask about the laws', askCase:'Ask about cases', question:'Question', draft:'Draft requiring human review — not legal advice',
    citations:'Citations', none:'None', noLaws:'No verified laws yet', stale:'Rules needing re-approval', article:'Article', saved:'Done', err:'Error', engine:'AI engine', engSov:'Our own model', engIk:'In-Kingdom cloud provider', consentT:'Authorisation to use an in-Kingdom provider', inclP:'Allow names and personal data to be sent', signName:'Name', signTitle:'Job title', ack:'I am authorised to sign and have read the full text', signB:'Sign and enable', revokeB:'Withdraw authorisation', signedBy:'Signed by', offNote:'No cloud provider is enabled for your organisation: no data leaves our infrastructure.', noAi:'AI is not enabled', ready:'Legal rules readiness', syncB:'Bind rules to verified laws', st_READY:'Ready', st_NEEDS_COUNSEL:'Needs counsel', st_NO_STATUTORY_RULES_MAPPED:'No statutory rules mapped yet', staleN:'Stale rules', unboundN:'Unbound', tabReview:'Law review (team)', source:'Source text', findings:'AI-extracted findings', accept:'Accept', rejectP:'Reject', pending:'Awaiting verification', nothing:'No versions under review', aiOnly:'AI proposals are visible to the platform team only, never to clients' },
};
Object.assign(I.ar, { nzTitle:'التقديم عبر ناجز', nzSim:'محاكاة: ليست ناجز الحقيقية ولن يُرفع أي طلب فعلي', nzOff:'ناجز غير مفعّل لمنشأتك', nzNotConfigured:'الربط بناجز غير مكتمل (ينتظر بيانات الوصول)', nzState:'حالة التقديم', nzPreview:'ما سيُرسل بالضبط', nzSubmit:'تقديم الدعوى عبر ناجز', nzSync:'تحديث من ناجز', nzReconcile:'مطابقة يدوية', nzBlocked:'غير متاح الآن', nzFiled:'تم رفعها (أدخل رقم المرجع)', nzNotFiled:'لم تُرفع', nzRef:'رقم مرجع ناجز', nzConfirm:'سيُرسل هذا إلى المحكمة ولا يمكن التراجع عنه. متابعة؟', NOT_SUBMITTED:'لم تُقدَّم', IN_PROGRESS:'قيد التنفيذ', UNCONFIRMED:'غير مؤكدة: تحتاج مطابقة', SUBMITTED:'قُدّمت', uploadDoc:'رفع مستند', docType:'نوع المستند (filing / exhibit)', file:'الملف', download:'تنزيل', parties:'الأطراف', forum:'الجهة', attachments:'المرفقات' });
Object.assign(I.en, { nzTitle:'Filing through Najiz', nzSim:'SIMULATION: not the real Najiz, nothing is actually filed', nzOff:'Najiz is not enabled for your organisation', nzNotConfigured:'Najiz connection incomplete (waiting for access details)', nzState:'Filing status', nzPreview:'Exactly what will be sent', nzSubmit:'File the claim through Najiz', nzSync:'Update from Najiz', nzReconcile:'Reconcile manually', nzBlocked:'Not available now', nzFiled:'It was filed (enter the reference)', nzNotFiled:'It was not filed', nzRef:'Najiz reference', nzConfirm:'This will be sent to the court and cannot be undone. Continue?', NOT_SUBMITTED:'Not filed', IN_PROGRESS:'In progress', UNCONFIRMED:'Unconfirmed: needs reconciliation', SUBMITTED:'Filed', uploadDoc:'Upload document', docType:'Document type (filing / exhibit)', file:'File', download:'Download', parties:'Parties', forum:'Forum', attachments:'Attachments' });
let lang = localStorage.getItem('lang') || 'ar';
let user = localStorage.getItem('user') || 'a-hr-mgr';
// Who the server says the selected account is. Tabs and admin-only panels follow this, never a hard-coded id.
let me = null;
let tab = 'cases';
let openId = null;
const t = (k) => I[lang][k];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isBack = () => me?.tenantId === 'platform';

async function api(method, path, body) {
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'lang=' + lang, {
    method, headers: { authorization: Auth.header(user), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
const flash = (r) => alert(r.ok ? t('saved') : `${t('err')}: ${r.j.message ?? r.j.error}` + (r.j.blockers ? '\n- ' + r.j.blockers.map((b) => b.message).join('\n- ') : ''));
const stLabel = (def, k) => lab((def?.states ?? []).find((x) => x.key === k)?.label) || k;
const fLabel = (def, k) => lab((def?.fields ?? []).find((x) => x.key === k)?.label) || k;
let defs = {};
const lab = (x) => (x && typeof x === 'object' ? x[lang] ?? x.en : x);

function chrome() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $('#appTitle').textContent = t('app');
  document.querySelector('[data-i=user]').textContent = t('user');
  $('#langBtn').textContent = lang === 'ar' ? 'English' : 'العربية';
  if (Auth.mode === 'oidc') { $('#user').parentElement.hidden = true; $('#who').innerHTML = `${esc(Auth.me.name)} <button id="outBtn" type="button">${lang === 'ar' ? 'خروج' : 'Sign out'}</button>`; $('#outBtn').onclick = Auth.logout; }
  else {
    // Grouped by tenant so a tester can see at a glance which organisation they are acting as.
    const byTenant = Auth.users.reduce((m, u) => ((m[u.tenantId] ??= []).push(u), m), {});
    $('#user').innerHTML = Object.entries(byTenant).map(([tid, us]) =>
      `<optgroup label="${esc(tid)}">${us.map((u) => `<option value="${esc(u.id)}" ${u.id === user ? 'selected' : ''}>${esc(u.id)} — ${esc(u.name)}</option>`).join('')}</optgroup>`).join('');
    $('#who').textContent = me ? `${me.tenantId} · ${me.departments.join(', ')} · ${me.clearance ?? ''}` : '';
  }
  if (isBack() && tab !== 'review' && tab === 'cases') tab = 'review';
  if (!isBack() && tab === 'review') tab = 'cases';
  $('#tabs').innerHTML = (isBack() ? [['review', 'tabReview'], ['laws', 'tabLaws']] : [['cases', 'tabCases'], ['laws', 'tabLaws'], ['ai', 'tabAi']])
    .map(([k, n]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${t(n)}</button>`).join('');
}

async function viewCases() {
  defs = Object.fromEntries(((await api('GET', '/case-types')).j || []).map((d) => [d.key, d]));
  if (openId) return viewCase();
  const [types, list] = await Promise.all([api('GET', '/case-types'), api('GET', '/cases')]);
  $('#view').innerHTML = `
  <div class="card"><h3>${t('newCase')}</h3><div class="row">
    <select id="nt">${(types.j || []).map((d) => `<option value="${d.key}">${esc(lab(d.label))}</option>`).join('')}</select>
    <input id="nid" class="grow" placeholder="${t('id')}"><button id="mk">${t('create')}</button></div></div>
  <div class="card"><table><tr><th>${t('id')}</th><th>${t('type')}</th><th>${t('state')}</th><th></th></tr>
  ${(list.j || []).map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.caseTypeKey)}</td><td><span class="tag">${esc(stLabel(defs[c.caseTypeKey], c.state))}</span></td><td><a class="lnk" data-open="${esc(c.id)}">${t('open')}</a></td></tr>`).join('')}</table></div>`;
  $('#mk').onclick = async () => { const id = $('#nid').value.trim(); if (!id) return; flash(await api('POST', '/cases', { id, caseType: $('#nt').value, fields: {} })); render(); };
}

async function viewCase() {
  const r = await api('GET', '/cases/' + encodeURIComponent(openId));
  if (!r.ok) { openId = null; return viewCases(); }
  const { case: c, actions } = r.j;
  const au = await api('GET', `/cases/${encodeURIComponent(openId)}/audit`);
  const def = ((await api('GET', '/case-types')).j || []).find((x) => x.key === c.caseTypeKey);
  $('#view').innerHTML = `
  <p><a class="lnk" id="bk">← ${t('back')}</a></p>
  <div class="card"><h3>${esc(c.id)} <span class="tag">${esc(stLabel(def, c.state))}</span></h3><div class="mute">${esc(c.caseTypeKey)} · ${esc(c.confidentiality)}</div></div>
  <div class="card"><h3>${t('actions')}</h3>
   ${actions.map((a) => `<div class="row"><button data-act="${a.action}" ${a.allowed ? '' : 'disabled'}>${esc(lab(a.label))}</button>
     ${a.allowed ? '' : `<ul class="blk bad">${a.blockers.map((b) => `<li>${esc(b.message)}</li>`).join('')}</ul>`}</div>`).join('') || '—'}
   <div class="row mt8"><input id="role" placeholder="${t('role')} (hr_director)"><button class="alt" id="apv">${t('approve')}</button></div></div>
  <div class="card"><h3>${t('fields')}</h3><table>${Object.entries(c.fields).map(([k, v]) => `<tr><td>${esc(fLabel(def, k))}</td><td>${esc(v)}</td></tr>`).join('')}</table>
   <div class="row"><select id="fk">${(def?.fields ?? []).map((f) => `<option value="${esc(f.key)}">${esc(lab(f.label))}</option>`).join('')}</select><span id="fvw" class="grow"></span><button class="alt" id="fs">${t('save')}</button></div></div>
  <div class="card"><h3>${t('artifacts')}</h3><ul>${c.artifacts.map((a) => `<li>${esc(a.type)} ${a.payload?.simulated ? '<span class="sim">SIM</span> ' : ''}${a.hash && a.payload?.name ? `<a class="lnk" data-dl="${esc(a.hash)}" data-name="${esc(a.payload.name)}">${esc(a.payload.name)} · ${t('download')}</a> ` : ''}<span class="mute">${esc(a.createdAt)}</span></li>`).join('')}</ul>
   <div class="row"><input id="dt" placeholder="${t('docType')}"><input id="df" type="file"><button class="alt" id="du">${t('uploadDoc')}</button></div>
   <div class="row"><input id="at" class="grow" placeholder="${t('artType')}"><button class="alt" id="as">${t('addArtifact')}</button></div></div>
  <div id="nz"></div>
  <div class="card"><h3>${t('audit')}</h3><p class="${au.j.integrity?.valid ? 'ok' : 'bad'}">${au.j.integrity?.valid ? t('chainOk') : t('chainBad')}</p>
   <ul>${(au.j.events || []).map((e) => `<li>${esc(e.type)} · ${esc(e.actorId)} <span class="mute">${esc(e.at)}</span></li>`).join('')}</ul></div>`;
  $('#bk').onclick = () => { openId = null; render(); };
  document.querySelectorAll('[data-dl]').forEach((a) => (a.onclick = async () => {
    const r = await fetch(`/cases/${encodeURIComponent(openId)}/documents/${a.dataset.dl}`, { headers: { authorization: Auth.header(user) } });
    if (!r.ok) return flash({ ok: false, j: { error: r.status } });
    const url = URL.createObjectURL(await r.blob()); const l = document.createElement('a'); l.href = url; l.download = a.dataset.name; l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  $('#du').onclick = async () => {
    const f = $('#df').files[0]; if (!f) return;
    const fd = new FormData(); fd.set('file', f); fd.set('type', $('#dt').value);
    const r = await fetch(`/cases/${encodeURIComponent(openId)}/documents?lang=${lang}`, { method: 'POST', headers: { authorization: Auth.header(user) }, body: fd });
    flash({ ok: r.ok, j: await r.json().catch(() => ({})) }); render();
  };
  if (c.caseTypeKey === 'legal.matter') drawNajiz();
  document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => { flash(await api('POST', `/cases/${encodeURIComponent(openId)}/transitions/${b.dataset.act}`)); render(); }));
  $('#apv').onclick = async () => { flash(await api('POST', `/cases/${encodeURIComponent(openId)}/approvals`, { role: $('#role').value })); render(); };
  // Typed editor: the input matches the field's type, and the value is sent as that type (the server rejects anything else).
  const drawInput = () => {
    const f = (def?.fields ?? []).find((x) => x.key === $('#fk').value); if (!f) return;
    const w = $('#fvw');
    if (f.type === 'enum') w.innerHTML = `<select id="fv">${f.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
    else if (f.type === 'boolean') w.innerHTML = `<select id="fv"><option value="true">${lang === 'ar' ? 'نعم' : 'Yes'}</option><option value="false">${lang === 'ar' ? 'لا' : 'No'}</option></select>`;
    else if (f.type === 'longtext') w.innerHTML = `<textarea id="fv" rows="3" class="w100"></textarea>`;
    else w.innerHTML = `<input id="fv" class="w100" type="${f.type === 'date' ? 'date' : f.type === 'number' || f.type === 'money' ? 'number' : 'text'}" ${f.type === 'money' ? 'min="0"' : ''} step="any">`;
  };
  if ($('#fk')) { $('#fk').onchange = drawInput; drawInput(); }
  $('#fs').onclick = async () => {
    const f = (def?.fields ?? []).find((x) => x.key === $('#fk').value); if (!f) return;
    const raw = $('#fv').value;
    const value = f.type === 'number' || f.type === 'money' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw;
    flash(await api('PATCH', `/cases/${encodeURIComponent(openId)}/fields`, { [f.key]: value })); render();
  };
  $('#as').onclick = async () => { flash(await api('POST', `/cases/${encodeURIComponent(openId)}/artifacts`, { id: 'a' + Date.now(), type: $('#at').value })); render(); };
}

async function drawNajiz() {
  const r = await api('GET', `/cases/${encodeURIComponent(openId)}/najiz`);
  if (!r.ok) return;
  const n = r.j;
  if (!n.enabled) { $('#nz').innerHTML = `<div class="card"><h3>${t('nzTitle')}</h3><p class="mute">${t('nzOff')}</p></div>`; return; }
  const pv = n.preview;
  $('#nz').innerHTML = `<div class="card"><h3>${t('nzTitle')}</h3>
   ${n.simulated ? `<p class="sim">${t('nzSim')}</p>` : ''}${n.configured ? '' : `<p class="warn">${t('nzNotConfigured')}</p>`}
   <p>${t('nzState')}: <span class="tag">${esc(t(n.state))}</span> ${n.najizRef ? `<span class="mute">${esc(n.najizRef)}</span>` : ''}</p>
   ${pv ? `<div class="mt8"><b>${t('nzPreview')}</b><table>
     <tr><td>${t('forum')}</td><td>${esc(pv.forum)}</td></tr><tr><td>${t('parties')}</td><td>${pv.parties.map((p) => esc(p.name)).join('، ')}</td></tr>
     <tr><td>${t('attachments')}</td><td>${pv.attachments.map((a) => `${esc(a.name)} <span class="mute">${esc(a.sha256.slice(0, 12))}…</span>`).join('<br>')}</td></tr></table></div>` : ''}
   ${n.blockedBy ? `<p class="mute">${t('nzBlocked')}: ${esc(n.blockedBy)}</p>` : ''}
   <div class="row mt8"><button id="nzs" ${n.canSubmit ? '' : 'disabled'}>${t('nzSubmit')}</button>
    <button class="alt" id="nzy" ${n.state === 'SUBMITTED' ? '' : 'disabled'}>${t('nzSync')}</button></div>
   ${n.state === 'UNCONFIRMED' || n.state === 'IN_PROGRESS' ? `<div class="row mt8"><select id="nzo"><option value="filed">${t('nzFiled')}</option><option value="not_filed">${t('nzNotFiled')}</option></select><input id="nzr" placeholder="${t('nzRef')}"><button class="alt" id="nzc">${t('nzReconcile')}</button></div>` : ''}</div>`;
  const base = `/cases/${encodeURIComponent(openId)}/najiz`;
  if ($('#nzs')) $('#nzs').onclick = async () => { if (!confirm(t('nzConfirm'))) return; flash(await api('POST', base + '/submit')); render(); };
  $('#nzy').onclick = async () => { flash(await api('POST', base + '/sync')); render(); };
  if ($('#nzc')) $('#nzc').onclick = async () => { flash(await api('POST', base + '/reconcile', { outcome: $('#nzo').value, najizRef: $('#nzr').value || undefined })); render(); };
}

async function viewLaws() {
  const [laws, stale] = await Promise.all([api('GET', '/laws'), api('GET', '/laws/stale-rules')]);
  $('#view').innerHTML = `
  <div class="card"><h3>${t('lawsTitle')}</h3>
  ${(laws.j || []).length ? `<table>${laws.j.map((l) => `<tr><td>${esc(lang === 'ar' ? l.instrument : l.instrumentEn ?? l.instrument)}<div class="mute">${esc(l.version)} · ${esc(l.effectiveFrom)}</div></td><td>${t('article')} ${esc(l.article)}</td><td>${esc(l.textAr)}</td></tr>`).join('')}</table>` : `<p class="mute">${t('noLaws')}</p>`}</div>
  ${(stale.j || []).length ? `<div class="warn">${t('stale')}: ${stale.j.map((s) => esc(s.ruleRef)).join(', ')}</div>` : ''}
`;
}

async function viewReview() {
  const [r, ct] = await Promise.all([api('GET', '/laws/review'), api('GET', '/case-types')]);
  const list = (r.j || []).filter((v) => v.status === 'UNDER_REVIEW' || v.status === 'DRAFT');
  $('#view').innerHTML = `<div class="warn">${t('aiOnly')}</div>
  <div class="card"><h3>${t('ready')}</h3><table>${(ct.j || []).map((d) => `<tr><td>${esc(lab(d.label))}</td><td><span class="tag">${t('st_' + d.legal.status)}</span></td><td class="mute">${d.legal.stale.length ? t('staleN') + ': ' + esc(d.legal.stale.join(', ')) : ''} ${d.legal.unbound.length ? t('unboundN') + ': ' + esc(d.legal.unbound.join(', ')) : ''}</td></tr>`).join('')}</table>
  <button class="alt" id="sync">${t('syncB')}</button></div>
    <div class="card"><h3>${t('upload')}</h3>
   <div class="row"><input id="li" placeholder="${t('instId')}"><input id="lt" class="grow" placeholder="${t('titleAr')}"><button class="alt" id="lia">${t('create')}</button></div>
   <div class="row mt8"><input id="vi" placeholder="${t('verId')}"><input id="vl" placeholder="${t('label')}"><input id="ve" type="date" title="${t('eff')}"><input id="vin" placeholder="${t('instId')}"></div>
   <div class="row mt8"><input type="file" id="vf" accept=".pdf,.docx,.txt,.png,.jpg,.jpeg"><span class="mute">PDF · Word · TXT · PNG/JPG (OCR)</span></div>
   <textarea id="vt" rows="6" class="w100 mt8" placeholder="${t('text')}"></textarea>
   <div class="row"><button id="vu">${t('upload')}</button></div></div>
  ${list.map((v) => `<div class="card"><h3>${esc(v.id)} · ${esc(v.versionLabel)} <span class="tag">${esc(v.status)}</span> <span class="mute">${esc(v.effectiveFrom)}</span></h3>
   <div class="row top"><div class="grow"><b>${t('source')}</b>${v.provisions.map((p) => `<p><b>${t('article')} ${esc(p.number)}</b><br>${esc(p.textAr)}</p>`).join('')}</div>
   <div class="grow"><b>${t('findings')}</b>${v.proposals.map((p) => `<div class="card"><span class="tag">${esc(p.kind)}</span> ${t('article')} ${esc(p.provisionNumber)} <span class="tag">${esc(p.status)}</span><br>${esc(p.summary)}<div class="mute">«${esc(p.quote)}»</div>
     <button class="alt" data-pd="${esc(p.id)}" data-d="accept">${t('accept')}</button> <button class="alt" data-pd="${esc(p.id)}" data-d="reject">${t('rejectP')}</button></div>`).join('') || `<p class="mute">${t('none')}</p>`}</div></div>
   <div class="row"><button data-vv="${esc(v.id)}">${t('verify')}</button><button class="alt" data-vr="${esc(v.id)}">${t('reject')}</button></div></div>`).join('') || `<p class="mute">${t('nothing')}</p>`}`;
  $('#sync').onclick = async () => { const x = await api('POST', '/laws/bindings/sync'); flash(x); render(); };
  const vid = () => encodeURIComponent($('#vi').value);
  $('#lia').onclick = async () => flash(await api('POST', '/laws/instruments', { id: $('#li').value, tenantId: null, kind: 'LAW', titleAr: $('#lt').value, issuer: '—' }));
  let fileSha;
  $('#vf').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch('/laws/files?lang=' + lang, { method: 'POST', headers: { authorization: Auth.header(user) }, body: fd });
    const j = await r.json();
    if (!r.ok) return alert(`${t('err')}: ${j.error}`);
    $('#vt').value = j.text; fileSha = j.sha256;
    if (j.method === 'ocr') alert(`OCR · ${j.confidence}/100`);
    if (j.warnings.length) alert(j.warnings.join('\n'));
  };
  $('#vu').onclick = async () => { const x = await api('POST', '/laws/versions', { ...(fileSha ? { sourceFileSha256: fileSha } : {}), id: $('#vi').value, instrumentId: $('#vin').value, versionLabel: $('#vl').value, effectiveFrom: $('#ve').value, rawText: $('#vt').value }); flash(x); if (x.ok && x.j.warnings?.length) alert(x.j.warnings.join('\n')); render(); };
  document.querySelectorAll('[data-pd]').forEach((b) => (b.onclick = async () => { flash(await api('POST', `/laws/proposals/${encodeURIComponent(b.dataset.pd)}/${b.dataset.d}`)); render(); }));
  document.querySelectorAll('[data-vv]').forEach((b) => (b.onclick = async () => { flash(await api('POST', `/laws/versions/${encodeURIComponent(b.dataset.vv)}/verify`, { note: 'verified against official source' })); render(); }));
  document.querySelectorAll('[data-vr]').forEach((b) => (b.onclick = async () => { flash(await api('POST', `/laws/versions/${encodeURIComponent(b.dataset.vr)}/reject`, { note: 'rejected' })); render(); }));
}

async function viewAi() {
  const st = await api('GET', '/ai/settings');
  const S = st.j || {};
  const label = (e) => (e ? `${e.mode === 'in_kingdom' ? t('engIk') : t('engSov')} — ${esc(e.label)}` : t('noAi'));
  const isAdmin = (me?.roles ?? []).includes('tenant_admin');
  $('#view').innerHTML = `<div class="card"><h3>${t('tabAi')}</h3><div class="warn">${t('draft')}</div>
  <p class="mute">${t('engine')}: <b>${label(S.current)}</b></p>
  <textarea id="q" rows="3" class="w100" placeholder="${t('question')}"></textarea>
  <div class="row"><button id="al">${t('askLaw')}</button><button class="alt" id="ac">${t('askCase')}</button></div><div id="ans"></div></div>
  <div id="consent"></div>`;
  const show = (r) => { const a = r.j; $('#ans').innerHTML = `<pre>${esc(a.text ?? a.message)}</pre><div class="mute">${t('citations')}: ${(a.citations || []).map((c) => esc(c.article ? `${c.instrument} ${t('article')} ${c.article} (${c.versionLabel})` : c)).join(' · ') || t('none')}${a.engine ? ' · ' + t('engine') + ': ' + esc(a.engine.label) : ''}</div>`; };
  $('#al').onclick = async () => show(await api('POST', '/ai/laws', { question: $('#q').value }));
  $('#ac').onclick = async () => show(await api('POST', '/ai/cases', { question: $('#q').value }));
  if (!isAdmin) return;
  const c = S.consent && !S.consent.revokedAt && S.mode === 'IN_KINGDOM_API' ? S.consent : null;
  if (c) {
    $('#consent').innerHTML = `<div class="card"><h3>${t('consentT')}</h3><p>${t('signedBy')}: <b>${esc(c.signedByName)}</b> (${esc(c.signedByTitle)}) · ${esc(c.signedAt)}<br><span class="mute">${esc(c.providerName)} · ${esc(c.region)} · v${esc(c.version)}</span></p><button class="alt" id="rv">${t('revokeB')}</button></div>`;
    $('#rv').onclick = async () => { flash(await api('DELETE', '/ai/consent')); render(); };
    return;
  }
  if (!S.inKingdomOffered) { $('#consent').innerHTML = `<div class="card mute">${t('offNote')}</div>`; return; }
  const draw = async () => {
    const ip = $('#ip')?.checked === true;
    const tx = (await api('GET', '/ai/consent-text?includePersonal=' + ip)).j;
    const body = (lang === 'ar' ? tx.ar : tx.en).map((l) => `<li>${esc(l)}</li>`).join('');
    $('#consent').innerHTML = `<div class="card"><h3>${t('consentT')}</h3><div class="warn">${t('offNote')}</div><ul>${body}</ul>
      <label><input type="checkbox" id="ip" ${ip ? 'checked' : ''}> ${t('inclP')}</label>
      <div class="row mt8"><input id="sn" placeholder="${t('signName')}"><input id="st" placeholder="${t('signTitle')}"></div>
      <label><input type="checkbox" id="ak"> ${t('ack')}</label><div><button id="sg">${t('signB')}</button></div></div>`;
    $('#ip').onchange = draw;
    $('#sg').onclick = async () => { flash(await api('POST', '/ai/consent', { includePersonal: $('#ip').checked, name: $('#sn').value, title: $('#st').value, textSha256: tx.sha256, acknowledge: $('#ak').checked })); render(); };
  };
  draw();
}

async function render() {
  // Identity first: tabs and the admin panel are decided by what the server says this account is.
  me = Auth.mode === 'oidc' ? Auth.me : (await api('GET', '/me')).j;
  chrome();
  if (tab === 'cases') await viewCases(); else if (tab === 'review') await viewReview(); else if (tab === 'laws') await viewLaws(); else await viewAi();
}
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]'); if (o) { openId = o.dataset.open; render(); }
  const tb = e.target.closest('[data-tab]'); if (tb) { tab = tb.dataset.tab; openId = null; render(); }
});
$('#langBtn').onclick = () => { lang = lang === 'ar' ? 'en' : 'ar'; localStorage.setItem('lang', lang); render(); };
if ($('#user').tagName === 'SELECT') $('#user').onchange = (e) => { user = e.target.value; localStorage.setItem('user', user); openId = null; render(); };
Auth.init().then(render);
