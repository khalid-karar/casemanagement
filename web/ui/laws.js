// Legal library (all tenants), law review (platform team) and the AI assistant. Behaviour is unchanged from the first UI;
// the presentation, labels and feedback follow the same system as the rest.
(() => {
  const K = CMS, { esc } = K;

  CMS.views.laws = async () => {
    const [laws, stale] = await Promise.all([K.api('GET', '/laws'), K.api('GET', '/laws/stale-rules')]);
    const list = laws.j || [];
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('lawsTitle'))}</h2></div>
      ${(stale.j || []).length ? `<div class="banner warn">${K.ic('alert')} <span>${esc(L.t('stale'))}: ${(stale.j).map((s) => `<span class="code">${esc(s.ruleRef)}</span>`).join(' ')}</span></div>` : ''}
      <section class="card"><div class="field"><label for="ls">${esc(L.t('search'))}</label><div class="input-icon">${K.ic('search')}<input id="ls" type="search" placeholder="${esc(L.t('lawSearch'))}" autocomplete="off"></div></div>
      <div id="lawlist" class="mt16"></div></section>`;
    const after = (root) => {
      const draw = (q) => {
        const rows = list.filter((l) => !q || `${l.instrument} ${l.instrumentEn ?? ''} ${l.article} ${l.textAr}`.toLowerCase().includes(q));
        K.$('#lawlist', root).innerHTML = rows.length ? `<ul class="list">${rows.map((l) => `<li class="row top"><div class="t"><b>${esc(K.ar() ? l.instrument : l.instrumentEn ?? l.instrument)}</b> · ${esc(L.t('article'))} <span class="num">${esc(l.article)}</span><div class="mute">${esc(l.version)} · ${esc(L.t('effective'))} ${K.dateBoth(l.effectiveFrom)}</div><p lang="ar" dir="rtl">${esc(l.textAr)}</p></div></li>`).join('')}</ul>` : `<div class="empty">${K.ic('scale')}<p>${esc(L.t('noLaws'))}</p></div>`;
      };
      let t; K.$('#ls', root).oninput = (e) => { clearTimeout(t); t = setTimeout(() => draw(e.target.value.trim().toLowerCase()), 150); }; draw('');
    };
    return { title: L.t('lawsTitle'), html, after };
  };

  CMS.views.review = async () => {
    const [r, ct] = await Promise.all([K.api('GET', '/laws/review'), K.api('GET', '/case-types')]);
    const list = (r.j || []).filter((v) => v.status === 'UNDER_REVIEW' || v.status === 'DRAFT');
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('reviewT'))}</h2></div><div class="banner info">${K.ic('info')} <span>${esc(L.t('aiOnly'))}</span></div>
    <section class="card"><h3>${esc(L.t('ready'))}</h3><table class="tbl stack"><tbody>${(ct.j || []).map((d) => `<tr><td data-l="">${esc(L.lab(d.label))}</td><td><span class="badge ${d.legal.status === 'READY' ? 'ok' : 'warn'}">${esc(L.t('st_' + d.legal.status))}</span></td><td class="mute">${d.legal.stale.length ? esc(L.t('staleN')) + ': ' + d.legal.stale.map((x) => `<span class="code">${esc(x)}</span>`).join(' ') : ''} ${d.legal.unbound.length ? esc(L.t('unboundN')) + ': ' + d.legal.unbound.map((x) => `<span class="code">${esc(x)}</span>`).join(' ') : ''}</td></tr>`).join('')}</tbody></table><button class="secondary mt8" id="sync">${esc(L.t('syncB'))}</button></section>
    <section class="card" aria-labelledby="ul-h"><h3 id="ul-h">${esc(L.t('uploadLaw'))}</h3>
      <div class="grid g3"><div class="field"><label for="li">${esc(L.t('instId'))}</label><input id="li" class="dir-ltr"></div><div class="field"><label for="lt">${esc(L.t('titleAr'))}</label><input id="lt" lang="ar" dir="rtl"></div><div class="field"><span class="lbl">&nbsp;</span><button class="secondary" id="lia">${K.ic('plus')} ${esc(L.t('create'))}</button></div></div>
      <div class="grid g3 mt16"><div class="field"><label for="vi">${esc(L.t('verId'))}</label><input id="vi" class="dir-ltr"></div><div class="field"><label for="vl">${esc(L.t('verLabel'))}</label><input id="vl"></div><div class="field"><label for="ve">${esc(L.t('eff'))}</label><input id="ve" type="date"></div><div class="field"><label for="vin">${esc(L.t('instId'))}</label><input id="vin" class="dir-ltr"></div></div>
      <div class="field mt16"><span class="lbl">${esc(L.t('file'))}</span><div class="file"><label class="btn secondary" for="vf">${K.ic('upload')} ${esc(L.t('chooseFile'))}</label><input type="file" id="vf" accept=".pdf,.docx,.txt,.png,.jpg,.jpeg" aria-describedby="vfn"><span id="vfn" class="mute">${esc(L.t('noFile'))}</span></div><span class="hint">PDF · Word · TXT · PNG/JPG (OCR)</span></div>
      <div class="field mt16"><label for="vt">${esc(L.t('lawText'))}</label><textarea id="vt" rows="6" lang="ar" dir="rtl"></textarea></div><div class="mt8"><button id="vu">${K.ic('upload')} ${esc(L.t('uploadLaw'))}</button></div></section>
    ${list.map((v) => `<section class="card"><div class="card-h"><h3>${esc(v.id)} · ${esc(v.versionLabel)}</h3><span class="badge warn">${esc(L.t('status_' + v.status))}</span><span class="mute">${K.dateBoth(v.effectiveFrom)}</span></div>
      <div class="grid g2"><div><b>${esc(L.t('source'))}</b>${v.provisions.map((p) => `<p lang="ar" dir="rtl"><b>${esc(L.t('article'))} ${esc(p.number)}</b><br>${esc(p.textAr)}</p>`).join('')}</div>
      <div><b>${esc(L.t('findings'))}</b>${v.proposals.map((p) => `<div class="card"><span class="badge">${esc(p.kind)}</span> ${esc(L.t('article'))} ${esc(p.provisionNumber)} <span class="badge">${esc(L.t('status_' + p.status))}</span><p>${esc(p.summary)}</p><div class="mute" lang="ar" dir="rtl">«${esc(p.quote)}»</div><div class="row mt8"><button class="secondary sm" data-pd="${esc(p.id)}" data-d="accept">${esc(L.t('accept'))}</button><button class="secondary sm" data-pd="${esc(p.id)}" data-d="reject">${esc(L.t('rejectP'))}</button></div></div>`).join('') || `<p class="mute">${esc(L.t('none'))}</p>`}</div></div>
      <div class="row mt8"><button data-vv="${esc(v.id)}">${K.ic('check')} ${esc(L.t('verify'))}</button><button class="secondary" data-vr="${esc(v.id)}">${esc(L.t('rejectV'))}</button></div></section>`).join('') || `<div class="empty">${K.ic('scale')}<p>${esc(L.t('nothingReview'))}</p></div>`}`;
    const after = (root) => {
      const reload = () => K.render({ keepScroll: true });
      K.$('#sync', root).onclick = async () => { if (K.report(await K.api('POST', '/laws/bindings/sync'))) reload(); };
      K.$('#lia', root).onclick = async () => K.report(await K.api('POST', '/laws/instruments', { id: K.$('#li', root).value, tenantId: null, kind: 'LAW', titleAr: K.$('#lt', root).value, issuer: '—' }));
      let fileSha;
      K.$('#vf', root).onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return; K.$('#vfn', root).textContent = f.name;
        const fd = new FormData(); fd.append('file', f);
        const res = await fetch('/laws/files?lang=' + K.s.lang, { method: 'POST', headers: { authorization: Auth.header(K.s.user) }, body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return K.report({ ok: false, status: res.status, j });
        K.$('#vt', root).value = j.text; fileSha = j.sha256;
        K.toast(j.method === 'ocr' ? `${L.t('ocrNote')}: ${K.num(j.confidence)}/100` : L.t('saved'), 'ok', j.warnings ?? []);
      };
      K.$('#vu', root).onclick = async () => { const x = await K.api('POST', '/laws/versions', { ...(fileSha ? { sourceFileSha256: fileSha } : {}), id: K.$('#vi', root).value, instrumentId: K.$('#vin', root).value, versionLabel: K.$('#vl', root).value, effectiveFrom: K.$('#ve', root).value, rawText: K.$('#vt', root).value }); if (K.report(x)) { if (x.j.warnings?.length) K.toast(L.t('saved'), 'ok', x.j.warnings); reload(); } };
      K.$$('[data-pd]', root).forEach((b) => (b.onclick = async () => { if (K.report(await K.api('POST', `/laws/proposals/${encodeURIComponent(b.dataset.pd)}/${b.dataset.d}`))) reload(); }));
      K.$$('[data-vv]', root).forEach((b) => (b.onclick = async () => { const ok = await K.dialog({ title: L.t('verify'), ok: L.t('verify'), body: `<div class="field"><label for="vn">${esc(L.t('note'))}</label><input id="vn" name="note" required maxlength="300" autofocus></div>` }); if (ok.ok && K.report(await K.api('POST', `/laws/versions/${encodeURIComponent(b.dataset.vv)}/verify`, { note: ok.data.note }))) reload(); }));
      K.$$('[data-vr]', root).forEach((b) => (b.onclick = async () => { const ok = await K.dialog({ title: L.t('rejectV'), ok: L.t('rejectV'), danger: true, body: `<div class="field"><label for="vn">${esc(L.t('note'))}</label><input id="vn" name="note" required maxlength="300" autofocus></div>` }); if (ok.ok && K.report(await K.api('POST', `/laws/versions/${encodeURIComponent(b.dataset.vr)}/reject`, { note: ok.data.note }))) reload(); }));
    };
    return { title: L.t('reviewT'), html, after };
  };

  CMS.views.ai = async () => {
    const st = await K.api('GET', '/ai/settings'); const S = st.j || {};
    const label = (e) => (e ? `${e.mode === 'in_kingdom' ? L.t('engIk') : L.t('engSov')} — ${e.label}` : L.t('noAi'));
    const isAdmin = (K.s.me?.roles ?? []).includes('tenant_admin');
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('aiT'))}</h2></div><section class="card"><div class="banner warn">${K.ic('alert')} <span>${esc(L.t('aiDraft'))}</span></div>
      <p class="mute">${esc(L.t('engine'))}: <b>${esc(label(S.current))}</b></p>
      <div class="field"><label for="q">${esc(L.t('question'))}</label><textarea id="q" rows="3"></textarea></div>
      <div class="row mt8"><button id="al">${esc(L.t('askLaw'))}</button><button class="secondary" id="ac">${esc(L.t('askCase'))}</button></div><div id="ans" class="mt16" aria-live="polite"></div></section><div id="consent"></div>`;
    const after = (root) => {
      const show = (res) => { const a = res.j; if (!res.ok) { K.$('#ans', root).innerHTML = ''; return K.report(res); } K.$('#ans', root).innerHTML = `<pre lang="ar" dir="auto">${esc(a.text ?? a.message)}</pre><div class="mute">${esc(L.t('citations'))}: ${(a.citations || []).map((c) => esc(c.article ? `${c.instrument} ${L.t('article')} ${c.article} (${c.versionLabel})` : c)).join(' · ') || esc(L.t('none'))}${a.engine ? ' · ' + esc(L.t('engine')) + ': ' + esc(a.engine.label) : ''}</div>`; };
      const ask = async (path) => { const q = K.$('#q', root).value.trim(); if (!q) return; K.$('#ans', root).innerHTML = `<div class="skel"></div><div class="skel"></div><span class="sr-only">${esc(L.t('thinking'))}</span>`; show(await K.api('POST', path, { question: q })); };
      K.$('#al', root).onclick = () => ask('/ai/laws'); K.$('#ac', root).onclick = () => ask('/ai/cases');
      if (!isAdmin) return;
      const reload = () => K.render({ keepScroll: true });
      const c = S.consent && !S.consent.revokedAt && S.mode === 'IN_KINGDOM_API' ? S.consent : null;
      const box = K.$('#consent', root);
      if (c) { box.innerHTML = `<section class="card"><h3>${esc(L.t('consentT'))}</h3><p>${esc(L.t('signedBy'))}: <b>${esc(c.signedByName)}</b> (${esc(c.signedByTitle)}) · ${K.dateTime(c.signedAt)}<br><span class="mute">${esc(c.providerName)} · ${esc(c.region)} · v${esc(c.version)}</span></p><button class="secondary" id="rv">${esc(L.t('revokeB'))}</button></section>`; K.$('#rv', root).onclick = async () => { if (K.report(await K.api('DELETE', '/ai/consent'))) reload(); }; return; }
      if (!S.inKingdomOffered) { box.innerHTML = `<section class="card mute">${esc(L.t('offNote'))}</section>`; return; }
      const draw = async () => {
        const ip = K.$('#ip', root)?.checked === true;
        const tx = (await K.api('GET', '/ai/consent-text?includePersonal=' + ip)).j;
        const body = (K.ar() ? tx.ar : tx.en).map((l) => `<li>${esc(l)}</li>`).join('');
        box.innerHTML = `<section class="card"><h3>${esc(L.t('consentT'))}</h3><div class="banner warn">${esc(L.t('offNote'))}</div><ul>${body}</ul>
          <label class="row gap6"><input type="checkbox" id="ip" ${ip ? 'checked' : ''}> ${esc(L.t('inclP'))}</label>
          <div class="grid g2 mt8"><div class="field"><label for="sn">${esc(L.t('signName'))}</label><input id="sn"></div><div class="field"><label for="st">${esc(L.t('signTitle'))}</label><input id="st"></div></div>
          <label class="row gap6 mt8"><input type="checkbox" id="ak"> ${esc(L.t('ack'))}</label><div class="mt8"><button id="sg">${esc(L.t('signB'))}</button></div></section>`;
        K.$('#ip', root).onchange = draw;
        K.$('#sg', root).onclick = async () => { if (K.report(await K.api('POST', '/ai/consent', { includePersonal: K.$('#ip', root).checked, name: K.$('#sn', root).value, title: K.$('#st', root).value, textSha256: tx.sha256, acknowledge: K.$('#ak', root).checked }))) reload(); };
      };
      draw();
    };
    return { title: L.t('aiT'), html, after };
  };
})();
