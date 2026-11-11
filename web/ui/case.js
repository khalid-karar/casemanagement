// Case workspace: overview (steps, approvals, details), documents, corrective actions, najiz, history.
(() => {
  const K = CMS, { esc } = K;
  const TABS = (def) => [['overview', 'tabOverview', 'info'], ['documents', 'tabDocuments', 'file'], ['actions', 'tabActions', 'check'], ...(def.domain === 'LEGAL' ? [['najiz', 'tabNajiz', 'gavel']] : []), ['history', 'tabTimeline', 'hist']];
  const sizeOk = 25 * 1024 * 1024;

  CMS.views.case = async (route) => {
    const id = route.params[0], tab = route.params[1] || 'overview';
    const r = await K.api('GET', '/cases/' + encodeURIComponent(id));
    if (!r.ok) { const e = new Error('nf'); e.notFound = true; throw e; }
    const { case: c, actions } = r.j; const dl = r.j.deadlines ?? {};
    const def = K.s.defs[c.caseTypeKey];
    const me = K.s.me;
    const open = (def.states.find((s) => s.key === c.state)?.kind ?? 'OPEN') === 'OPEN';
    const title = (['title', 'allegationSummary', 'narrative'].map((k) => c.fields[k]).find((v) => typeof v === 'string' && v && v !== '[REDACTED]')) ?? L.caseType(c.caseTypeKey);
    const tabs = TABS(def);
    const reload = () => K.render({ keepScroll: true });
    const base = '/cases/' + encodeURIComponent(id);

    // Stepper: every state except ARCHIVED, in the order the case type defines them.
    const steps = def.states.filter((s) => s.kind !== 'ARCHIVED');
    const nowIdx = steps.findIndex((s) => s.key === c.state);
    const stepper = `<ol class="stepper" tabindex="0" aria-label="${esc(L.t('caseStateNow'))}">${steps.map((s, i) => `<li class="${i < nowIdx ? 'done' : i === nowIdx ? 'now' : ''}" ${i === nowIdx ? 'aria-current="step"' : ''}>${esc(L.lab(s.label))}<span class="sr-only"> (${esc(i < nowIdx ? L.t('stepsDone') : i === nowIdx ? L.t('stepNow') : '')})</span></li>`).join('')}</ol>`;

    const head = `<nav class="crumb" aria-label="breadcrumb"><a href="#/cases">${esc(L.t('cases'))}</a> ${K.ic(K.ar() ? 'chevL' : 'chevR')} <span class="code">${esc(c.id)}</span></nav>
      <div class="page-h"><div><h2 id="h">${esc(String(title).slice(0, 120))}</h2><div class="row mt8"><span class="badge info">${esc(L.state(def, c.state))}</span><span class="badge">${esc(L.caseType(c.caseTypeKey))}</span><span class="badge">${esc(L.dept(c.department))}</span>${c.confidentiality !== 'STANDARD' ? `<span class="badge gold">${K.ic('lock')} ${esc(L.conf(c.confidentiality))}</span>` : ''}${c.legalHold ? `<span class="badge bad">${K.ic('lock')} ${esc(L.t('legalHold'))}</span>` : ''}<span class="mute">${esc(L.t('since'))} ${K.time(c.stateEnteredAt)}</span></div></div></div>
      <section class="card" aria-label="${esc(L.t('caseStateNow'))}">${stepper}</section>
      <div class="tabs" role="tablist" aria-label="${esc(L.t('tabsLabel'))}">${tabs.map(([k, lbl, ic]) => `<button role="tab" id="tab-${k}" aria-selected="${k === tab}" aria-controls="panel" tabindex="${k === tab ? 0 : -1}" data-tab="${k}">${K.ic(ic)} ${esc(L.t(lbl))}</button>`).join('')}</div>`;

    let nz = null;
    if (def.domain === 'LEGAL') { const nr = await K.api('GET', base + '/najiz'); nz = nr.ok ? nr.j : { enabled: false }; }
    const approveFiling = Boolean(nz?.enabled && c.state === 'PRE_ACTION' && nz.state === 'NOT_SUBMITTED' && me.roles.includes('general_counsel') && !(nz.approvedBy ?? []).includes(me.id) && !['FORUM_REQUIRED', 'TITLE_REQUIRED', 'FILING_DOCUMENT_REQUIRED'].includes(nz.blockedBy));
    // ---- Overview ---------------------------------------------------------------------------
    const approvalRoles = new Set(); // roles whose approval some blocked step is waiting for
    for (const a of actions) for (const b of a.blockers) { const m = /^APPROVAL_REQUIRED:(.+)$/.exec(b.code); if (m) approvalRoles.add(m[1]); }
    const myApprovalRoles = [...approvalRoles].filter((role) => me.roles.includes(role));
    const iApproved = (role) => c.approvals.some((a) => a.role === role && a.approverId === me.id);
    const stepsCard = `<section class="card" aria-labelledby="st-h"><div class="card-h">${K.ic('list')}<h3 id="st-h">${esc(L.t('nextSteps'))}</h3></div>${open ? (actions.length ? actions.map((a) => `<div class="row top mt8"><button data-act="${esc(a.action)}" ${a.allowed ? '' : 'disabled aria-describedby="why-' + esc(a.action) + '"'} class="${a.allowed ? '' : 'secondary'}">${esc(L.lab(a.label))}</button></div>${a.allowed ? '' : `<ul class="hint" id="why-${esc(a.action)}" aria-label="${esc(L.t('whyBlocked'))}">${a.blockers.map((b) => `<li>${esc(b.message)}</li>`).join('')}</ul>`}`).join('') : `<p class="mute">${esc(L.t('none'))}</p>`) : `<p class="mute">${esc(L.state(def, c.state))}</p>`}
      ${open && myApprovalRoles.length ? `<div class="mt16 banner info"><div>${myApprovalRoles.map((role) => `<button data-appr="${esc(role)}" ${iApproved(role) ? 'disabled' : ''}>${K.ic('check')} ${esc(L.t('approveAs'))} ${esc(L.role(role))}</button>`).join(' ')}</div></div>` : ''}</section>`;
    const apprCard = `<section class="card" aria-labelledby="ap-h"><h3 id="ap-h">${esc(L.t('approvals'))}</h3>${c.approvals.length ? `<ul class="list">${c.approvals.map((a) => `<li><span class="badge ok">${K.ic('check')} ${esc(L.role(a.role))}</span><span class="t">${esc(L.t('approvedBy'))} <b>${esc(K.who(a.approverId))}</b></span>${K.time(a.at)}</li>`).join('')}</ul>` : `<p class="mute">${esc(L.t('noApprovals'))}</p>`}</section>`;
    const lockedIn = (f) => (f.lockedIn ?? []).includes(c.state) || !open;
    const rows = def.fields.filter((f) => !(typeof c.fields[f.key] === 'string' && c.fields[f.key] === title && String(title).length <= 120)).map((f) => `<tr><th scope="row">${esc(L.lab(f.label))}${f.sensitivity !== 'NORMAL' ? ` <span class="badge" title="${esc(L.sens(f.sensitivity))}">${K.ic('lock')}</span>` : ''}</th><td>${L.value(f, c.fields[f.key])}${lockedIn(f) && c.fields[f.key] !== undefined ? ` <span class="hint">${K.ic('lock')} ${esc(L.t('fieldLocked'))}</span>` : ''}</td></tr>`).join('');
    const detailsCard = `<section class="card" aria-labelledby="dt-h"><div class="card-h"><h3 id="dt-h">${esc(L.t('fields'))}</h3><span class="spacer"></span>${open ? `<button class="secondary sm" id="edit">${esc(L.t('editFields'))}</button>` : ''}</div><div id="details"><table class="kv"><tbody>${rows}</tbody></table></div></section>`;
    const people = K.s.people ?? [];
    const assignCard = `<section class="card" aria-labelledby="as-h"><h3 id="as-h">${esc(L.t('assignee'))}</h3><p>${c.assignee ? `<b>${esc(K.who(c.assignee.id))}</b>` : `<span class="mute">${esc(L.t('noAssignee'))}</span>`}</p>${open ? `<div class="row">${c.assignee?.id !== me.id ? `<button class="secondary sm" id="assignMe">${esc(L.t('assignToMe'))}</button>` : ''}${people.length ? `<label class="sr-only" for="asel">${esc(L.t('assignTo'))}</label><select id="asel"><option value="">${esc(L.t('assignTo'))}…</option>${people.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select>` : `<label class="sr-only" for="asel">${esc(L.t('assignTo'))}</label><input id="asel" placeholder="${esc(L.t('assignTo'))}">`}</div>` : ''}</section>`;
    const canHold = me.roles.includes('legal_counsel');
    const holdCard = c.legalHold || canHold ? `<section class="card" aria-labelledby="lh-h"><h3 id="lh-h">${esc(L.t('legalHold'))}</h3>${c.legalHold ? `<div class="banner warn">${K.ic('lock')}<div><b>${esc(L.t('holdActive'))}</b><br>${esc(c.legalHold.reason ?? '')} · ${K.time(c.legalHold.placedAt)}</div></div>` : `<p class="mute">${esc(L.t('none'))}</p>`}${canHold ? `<button class="secondary sm" id="hold">${esc(c.legalHold ? L.t('holdRelease') : L.t('holdPlace'))}</button>` : ''}</section>` : '';
    const partiesCard = c.parties.length ? `<section class="card" aria-labelledby="pt-h"><h3 id="pt-h">${esc(L.t('parties'))}</h3><ul class="list">${c.parties.map((p) => `<li><span class="badge">${esc(L.party(p.role))}</span><span class="t">${p.personId === '[REDACTED]' ? `<span class="badge">${K.ic('lock')} ${esc(L.t('sealed'))}</span>` : esc(p.personId)}</span></li>`).join('')}</ul></section>` : '';
    const slaTone = { ON_TRACK: ['ok', 'slaOn'], AT_RISK: ['warn', 'slaRisk'], BREACHED: ['bad', 'slaBreach'] };
    const dlRows = [];
    if (dl.sla) { const [tone, lbl] = slaTone[dl.sla.status]; dlRows.push(`<li class="row top"><div class="t"><b>${esc(L.t('slaTarget'))}</b><div class="mute">${esc(L.state(def, dl.sla.state))}</div></div><div class="end"><span class="badge ${tone}">${esc(L.t(lbl))}</span><div class="mute"><time datetime="${esc(dl.sla.dueAt)}" title="${esc(K.dateTime(dl.sla.dueAt))}">${esc(K.dateBoth(dl.sla.dueAt))} · ${esc(K.rel(dl.sla.dueAt))}</time></div></div></li>`); }
    for (const k of dl.clocks ?? []) {
      if (k.status === 'NOT_STARTED') continue;
      const tone = k.status === 'EXPIRED' ? 'bad' : k.status === 'RUNNING' ? 'info' : 'warn';
      const lbl = k.status === 'EXPIRED' ? 'clockExpired' : k.status === 'RUNNING' ? 'clockRun' : 'clockWait';
      dlRows.push(`<li class="row top"><div class="t"><b>${esc(L.lab(k.label))}</b><div class="mute">${esc(L.t('clockBasis'))}: ${esc(k.legalBasis)}</div></div><div class="end"><span class="badge ${tone}">${esc(L.t(lbl))}</span>${k.dueAt ? `<div class="mute"><time datetime="${esc(k.dueAt)}">${esc(K.dateBoth(k.dueAt))} · ${esc(K.rel(k.dueAt))}</time></div>` : ''}</div></li>`);
    }
    const deadlineCard = dlRows.length ? `<section class="card" aria-labelledby="dl-h"><div class="card-h">${K.ic('clock')}<h3 id="dl-h">${esc(L.t('deadlineT'))}</h3></div><ul class="list">${dlRows.join('')}</ul></section>` : '';
    const overview = `<div class="grid g2"><div>${deadlineCard}${stepsCard}${apprCard}${assignCard}${holdCard}</div><div>${detailsCard}${partiesCard}</div></div>`;

    // ---- Documents ----------------------------------------------------------------------------
    const types = def.artifactTypes ?? [];
    const docs = c.artifacts.filter((a) => !a.type.startsWith('najiz_status'));
    const docsTab = `<section class="card"><div class="card-h">${K.ic('file')}<h3>${esc(L.t('docs'))}</h3></div>${docs.length ? `<table class="tbl stack"><thead><tr><th scope="col">${esc(L.t('docKind'))}</th><th scope="col">${esc(L.t('file'))}</th><th scope="col">${esc(L.t('addedBy'))}</th><th scope="col">${esc(L.t('sha'))}</th></tr></thead><tbody>${docs.map((a) => `<tr><td data-l="${esc(L.t('docKind'))}"><b>${esc(L.artifact(a.type))}</b> ${a.payload?.simulated ? `<span class="badge sim">${esc(L.t('simBadge'))}</span>` : ''}${a.payload?.summary ? `<div class="mute">${esc(a.payload.summary)}</div>` : ''}</td><td data-l="${esc(L.t('file'))}">${a.hash && a.payload?.name ? `<button class="ghost sm" data-dl="${esc(a.hash)}" data-name="${esc(a.payload.name)}">${K.ic('download')} ${esc(a.payload.name)}</button>` : '<span class="mute">—</span>'}</td><td data-l="${esc(L.t('addedBy'))}">${esc(K.who(a.createdBy))}<div>${K.time(a.createdAt)}</div></td><td data-l="${esc(L.t('sha'))}">${a.hash ? `<span class="code">${esc(a.hash.slice(0, 12))}…</span>` : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${K.ic('file')}<p>${esc(L.t('noDocs'))}</p></div>`}</section>
      ${open ? `<section class="card" aria-labelledby="up-h"><h3 id="up-h">${esc(L.t('uploadDoc'))}</h3><form id="upf" class="grid g3"><div class="field"><label for="ut">${esc(L.t('docKind'))}</label><select id="ut" required><option value="">${esc(L.t('pickType'))}</option>${types.map((t) => `<option value="${esc(t)}">${esc(L.artifact(t))}</option>`).join('')}</select></div><div class="field"><span class="lbl" id="ufl">${esc(L.t('file'))}</span><div class="file"><label class="btn secondary" for="uf">${K.ic('upload')} ${esc(L.t('chooseFile'))}</label><input id="uf" type="file" accept=".pdf,.docx,.txt,.png,.jpg,.jpeg" aria-describedby="ufn"><span id="ufn" class="mute">${esc(L.t('noFile'))}</span></div><span class="hint">${esc(L.t('sizeLimit'))}</span></div><div class="field"><span class="lbl">&nbsp;</span><button type="submit">${K.ic('upload')} ${esc(L.t('uploadDoc'))}</button></div></form><p class="mt8"><button class="ghost sm" id="rec">${esc(L.t('addRecord'))}</button></p></section>` : ''}`;

    // ---- Corrective actions -------------------------------------------------------------------
    const actionsTab = `<section class="card"><div class="card-h">${K.ic('check')}<h3>${esc(L.t('actionsT'))}</h3></div>${c.actions.length ? `<ul class="list">${c.actions.map((a) => { const late = a.status === 'OPEN' && a.dueDate && K.daysUntil(a.dueDate) < 0; return `<li><div class="t"><b>${esc(a.description)}</b><div class="mute">${a.ownerId ? esc(L.t('ownerLbl')) + ': ' + esc(K.who(a.ownerId)) : ''} ${a.dueDate ? '· ' + esc(L.t('actionDue')) + ': ' + K.dateBoth(a.dueDate) : ''}</div></div><span class="badge ${a.status === 'DONE' ? 'ok' : late ? 'bad' : 'warn'}">${esc(a.status === 'DONE' ? L.t('actionDone') : late ? L.t('overdueB') : L.t('actionOpen'))}</span>${a.status === 'OPEN' ? `<button class="secondary sm" data-done="${esc(a.id)}">${K.ic('check')} ${esc(L.t('complete'))}</button>` : ''}</li>`; }).join('')}</ul>` : `<div class="empty">${K.ic('check')}<p>${esc(L.t('noActionsT'))}</p></div>`}</section>
      ${open ? `<section class="card" aria-labelledby="aa-h"><h3 id="aa-h">${esc(L.t('addAction'))}</h3><form id="aaf" class="grid g3"><div class="field span-all"><label for="ad">${esc(L.t('actionDesc'))}</label><input id="ad" required maxlength="500"></div><div class="field"><label for="ao">${esc(L.t('actionOwner'))}</label><input id="ao" required value="${esc(me.id)}"></div><div class="field"><label for="adue">${esc(L.t('actionDue'))}</label><input id="adue" type="date" required></div><div class="field"><span class="lbl">&nbsp;</span><button type="submit">${K.ic('plus')} ${esc(L.t('addAction'))}</button></div></form></section>` : ''}`;

    // ---- History ------------------------------------------------------------------------------
    const au = await K.api('GET', base + '/audit');
    const ev = au.j.events ?? [];
    const names = K.s.names ?? {};
    const detail = (e) => { const ch = e.payload?.changes; if (!ch) return ''; return `<ul class="hint">${Object.entries(ch).map(([k, v]) => { const f = def.fields.find((x) => x.key === k); return `<li>${esc(L.field(def, k))}: ${'to' in v ? `${L.value(f, v.from)} ${esc(L.t('to'))} ${L.value(f, v.to)}` : `<span class="badge">${K.ic('lock')} ${esc(L.t('hashOnly'))}</span>`}</li>`; }).join('')}</ul>`; };
    const hist = `<section class="card"><div class="card-h">${K.ic('hist')}<h3>${esc(L.t('auditT'))}</h3><span class="spacer"></span><span class="badge ${au.j.integrity?.valid ? 'ok' : 'bad'}">${K.ic(au.j.integrity?.valid ? 'shield' : 'alert')} ${esc(au.j.integrity?.valid ? L.t('chainOk') : L.t('chainBad'))}</span></div><p class="hint">${esc(L.t('auditExplain'))}</p>
      <ol class="timeline">${[...ev].reverse().map((e) => `<li><div>${L.event(e, def, names)}</div>${detail(e)}<div class="when" title="${esc(K.dateTime(e.at))}">${esc(K.dateTime(e.at))} · ${K.time(e.at)}</div></li>`).join('')}</ol></section>`;

    // ---- Najiz (legal matters) ----------------------------------------------------------------
    let najiz = '';
    if (def.domain === 'LEGAL') {
      if (!nz.enabled) najiz = `<section class="card"><h3>${esc(L.t('nzTitle'))}</h3><div class="banner info">${K.ic('info')}<span>${esc(L.t('nzOff'))}</span></div></section>`;
      else {
        const pv = nz.preview;
        najiz = `<section class="card"><div class="card-h">${K.ic('gavel')}<h3>${esc(L.t('nzTitle'))}</h3></div>${nz.simulated ? `<div class="banner sim" role="note">${K.ic('alert')} ${esc(L.t('nzSim'))}</div>` : ''}${nz.configured ? '' : `<div class="banner warn">${K.ic('alert')} ${esc(L.t('nzNotConfigured'))}</div>`}
        <p>${esc(L.t('nzState'))}: <span class="badge ${nz.state === 'SUBMITTED' ? 'ok' : nz.state === 'UNCONFIRMED' ? 'bad' : ''}">${esc(L.t(nz.state))}</span> ${nz.najizRef ? `<span class="code">${esc(nz.najizRef)}</span>` : ''}</p>
        ${nz.state === 'UNCONFIRMED' ? `<div class="banner warn">${K.ic('alert')} ${esc(L.t('nzUnconfirmedHelp'))}</div>` : ''}
        ${pv ? `<h4>${esc(L.t('nzPreview'))}</h4><table class="kv"><tbody><tr><th scope="row">${esc(L.t('forum'))}</th><td>${esc(L.forum(pv.forum))}</td></tr><tr><th scope="row">${esc(L.t('parties'))}</th><td>${pv.parties.map((p) => esc(p.name)).join('، ')}</td></tr>${pv.claimValueSar !== undefined ? `<tr><th scope="row">${esc(L.t('claimValue'))}</th><td>${L.value({ type: 'money' }, pv.claimValueSar)}</td></tr>` : ''}<tr><th scope="row">${esc(L.t('attachments'))}</th><td>${pv.attachments.map((a) => `${esc(a.name)} <span class="code">${esc(a.sha256.slice(0, 12))}…</span>`).join('<br>')}</td></tr></tbody></table>` : ''}
        ${nz.blockedBy ? `<div class="banner info">${K.ic('info')} <span>${esc(L.t('nzBlocked'))}: ${esc(L.nz(nz.blockedBy))}${nz.blockedBy === 'FILING_DOCUMENT_REQUIRED' ? ` · <a href="#/cases/${encodeURIComponent(id)}/documents">${esc(L.t('goDocs'))}</a>` : ''}</span></div>` : ''}
        ${(nz.approvedBy ?? []).length ? `<p>${esc(L.t('nzApprovedBy'))}: ${nz.approvedBy.map((a) => `<span class="badge ok">${K.ic('check')} ${esc(K.who(a))}</span>`).join(' ')}</p>` : ''}
        ${approveFiling ? `<div class="banner info">${K.ic('shield')} <div><b>${esc(L.t('nzApproveHelp'))}</b><br><button id="nzapprove" class="mt8">${K.ic('check')} ${esc(L.t('nzApprove'))}</button></div></div>` : ''}
        <div class="row mt16"><button id="nzs" class="gold" ${nz.canSubmit ? '' : 'disabled'}>${K.ic('send')} ${esc(L.t('nzSubmit'))}</button><button class="secondary" id="nzy" ${nz.state === 'SUBMITTED' ? '' : 'disabled'}>${esc(L.t('nzSync'))}</button></div>
        ${nz.state === 'UNCONFIRMED' || nz.state === 'IN_PROGRESS' ? `<form id="nzf" class="grid g3 mt16"><div class="field"><label for="nzo">${esc(L.t('nzReconcile'))}</label><select id="nzo"><option value="filed">${esc(L.t('nzFiled'))}</option><option value="not_filed">${esc(L.t('nzNotFiled'))}</option></select></div><div class="field"><label for="nzr">${esc(L.t('nzRef'))}</label><input id="nzr" class="dir-ltr"></div><div class="field"><span class="lbl">&nbsp;</span><button class="secondary" type="submit">${esc(L.t('nzReconcile'))}</button></div></form>` : ''}</section>`;
      }
    }

    const panel = { overview, documents: docsTab, actions: actionsTab, najiz, history: hist }[tab] ?? overview;
    const html = head + `<div id="panel" role="tabpanel" aria-labelledby="tab-${tab}" tabindex="0">${panel}</div>`;

    const after = (root) => {
      K.$$('[data-tab]', root).forEach((b) => { b.onclick = () => K.go(`/cases/${encodeURIComponent(id)}/${b.dataset.tab}`); b.onkeydown = (e) => { const i = tabs.findIndex((t) => t[0] === tab); const j = e.key === 'ArrowRight' ? i + (K.ar() ? -1 : 1) : e.key === 'ArrowLeft' ? i + (K.ar() ? 1 : -1) : -1; if (j >= 0 && tabs[(j + tabs.length) % tabs.length]) { e.preventDefault(); K.go(`/cases/${encodeURIComponent(id)}/${tabs[(j + tabs.length) % tabs.length][0]}`); } }; });
      const post = async (path, body, okMsg) => { const res = await K.api('POST', path, body); if (K.report(res, okMsg)) await reload(); return res; };
      K.$$('[data-act]', root).forEach((b) => (b.onclick = async () => { const res = await K.api('POST', `${base}/transitions/${b.dataset.act}`); if (K.report(res, L.t('stepDone'))) reload(); }));
      K.$$('[data-appr]', root).forEach((b) => (b.onclick = () => post(`${base}/approvals`, { role: b.dataset.appr }, L.t('approve_ok'))));
      const am = K.$('#assignMe', root); if (am) am.onclick = () => post(`${base}/assignee`, { id: me.id }, L.t('saved'));
      const ag = K.$('#asel', root); if (ag) ag.onchange = () => { const v = ag.value.trim(); if (v) post(`${base}/assignee`, { id: v }, L.t('assignedNow')); };
      const hold = K.$('#hold', root); if (hold) hold.onclick = async () => { const r2 = await K.dialog({ title: c.legalHold ? L.t('holdRelease') : L.t('holdPlace'), ok: L.t('ok'), body: `<div class="field"><label for="hr">${esc(L.t('holdReason'))}</label><input id="hr" name="reason" required maxlength="300" autofocus></div>` }); if (!r2.ok) return; const res = await K.api(c.legalHold ? 'DELETE' : 'POST', `${base}/legal-hold`, { reason: r2.data.reason }); if (K.report(res)) reload(); };
      const ed = K.$('#edit', root); if (ed) ed.onclick = () => {
        const editable = def.fields.filter((f) => !(f.sensitivity === 'SEALED' && c.fields[f.key] === '[REDACTED]'));
        K.$('#details', root).innerHTML = `<form id="ef" class="grid">${editable.map((f) => { const lock = lockedIn(f) && c.fields[f.key] !== undefined && c.fields[f.key] !== ''; const sealedHeld = f.sensitivity === 'SEALED' && c.fields[f.key] && !(def.sealedFieldRoles?.[f.key] ?? ['ethics_officer']).some((r) => me.roles.includes(r)); const dis = lock || sealedHeld; return K.fieldRow(f, c.fields[f.key], 'ef-' + f.key, { disabled: dis, why: lock ? L.t('fieldLocked') : sealedHeld ? L.t('sealedNote') : '' }); }).join('')}<div class="row"><button type="submit">${esc(L.t('save'))}</button><button type="button" class="secondary" id="ecancel">${esc(L.t('cancel'))}</button></div></form>`;
        K.$('#ecancel', root).onclick = reload;
        K.$('#ef', root).onsubmit = async (e) => { e.preventDefault(); const patch = {}; for (const f of editable) { const el = K.$('#ef-' + f.key, root); if (!el || el.disabled) continue; let v = K.readControl(f, el); if (v === undefined && c.fields[f.key] !== undefined && c.fields[f.key] !== null && c.fields[f.key] !== '') v = null; if (v !== undefined && JSON.stringify(v) !== JSON.stringify(c.fields[f.key])) patch[f.key] = v; } if (!Object.keys(patch).length) return reload(); const res = await K.api('PATCH', `${base}/fields`, patch); if (K.report(res)) reload(); };
      };
      K.$$('[data-dl]', root).forEach((b) => (b.onclick = async () => {
        const res = await fetch(`${base}/documents/${b.dataset.dl}`, { headers: { authorization: Auth.header(K.s.user) } });
        if (!res.ok) return K.toast(L.t('e_' + res.status), 'err');
        const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = b.dataset.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
      }));
      const uf = K.$('#uf', root); if (uf) { uf.onchange = () => { K.$('#ufn', root).textContent = uf.files[0]?.name ?? L.t('noFile'); }; K.$('#upf', root).onsubmit = async (e) => { e.preventDefault(); const f = uf.files[0]; if (!f) return K.toast(L.t('pickFile'), 'err'); if (f.size > sizeOk) return K.toast(L.t('e_413'), 'err'); const fd = new FormData(); fd.set('file', f); fd.set('type', K.$('#ut', root).value); const res = await fetch(`${base}/documents?lang=${K.s.lang}`, { method: 'POST', headers: { authorization: Auth.header(K.s.user) }, body: fd }); const j = await res.json().catch(() => ({})); if (K.report({ ok: res.ok, status: res.status, j }, L.t('uploaded_ok'))) reload(); }; }
      const rec = K.$('#rec', root); if (rec) rec.onclick = async () => { const r2 = await K.dialog({ title: L.t('docRecord'), ok: L.t('save'), body: `<div class="field"><label for="rt">${esc(L.t('docKind'))}</label><select id="rt" name="type" autofocus>${types.map((t) => `<option value="${esc(t)}">${esc(L.artifact(t))}</option>`).join('')}</select></div><div class="field"><label for="rs">${esc(L.t('note'))}</label><input id="rs" name="summary" maxlength="300"></div>` }); if (!r2.ok) return; const res = await K.api('POST', `${base}/artifacts`, { id: `${r2.data.type}-${Date.now().toString(36)}`, type: r2.data.type, payload: r2.data.summary ? { summary: r2.data.summary } : {} }); if (K.report(res)) reload(); };
      K.$$('[data-done]', root).forEach((b) => (b.onclick = async () => { const res = await K.api('POST', `${base}/actions/${encodeURIComponent(b.dataset.done)}/complete`); if (K.report(res)) reload(); }));
      const aaf = K.$('#aaf', root); if (aaf) aaf.onsubmit = async (e) => { e.preventDefault(); const res = await K.api('POST', `${base}/actions`, { id: 'act-' + Date.now().toString(36), description: K.$('#ad', root).value, ownerId: K.$('#ao', root).value, dueDate: K.$('#adue', root).value }); if (K.report(res)) reload(); };
      // Najiz
      const nzs = K.$('#nzs', root); if (nzs) nzs.onclick = async () => {
        const pv = nz.preview;
        const r2 = await K.dialog({ title: L.t('nzReviewTitle'), ok: L.t('nzReviewConfirm'), danger: true, body: `<p>${esc(L.t('nzReviewBody'))}</p>${nz.simulated ? `<div class="banner sim">${esc(L.t('nzSim'))}</div>` : ''}<table class="kv"><tbody><tr><th scope="row">${esc(L.t('forum'))}</th><td>${esc(L.forum(pv.forum))}</td></tr><tr><th scope="row">${esc(L.t('parties'))}</th><td>${pv.parties.map((p) => esc(p.name)).join('، ')}</td></tr><tr><th scope="row">${esc(L.t('attachments'))}</th><td>${pv.attachments.map((a) => esc(a.name)).join('<br>')}</td></tr><tr><th scope="row">${esc(L.t('nzApprovedBy'))}</th><td>${esc(c.approvals.filter((a) => a.role === 'general_counsel').map((a) => a.approverId).pop() ?? '—')}</td></tr></tbody></table>` });
        if (!r2.ok) return; const res = await K.api('POST', `${base}/najiz/submit`); if (K.report(res, L.t('nzSent'))) reload(); else reload();
      };
      const nza = K.$('#nzapprove', root); if (nza) nza.onclick = () => post(`${base}/approvals`, { role: 'general_counsel' }, L.t('approve_ok'));
      const nzy = K.$('#nzy', root); if (nzy) nzy.onclick = async () => { const res = await K.api('POST', `${base}/najiz/sync`); if (K.report(res, L.t('nzSynced') + (res.ok ? ` (${K.num(res.j.imported)} ${L.t('nzImported')})` : ''))) reload(); };
      const nzf = K.$('#nzf', root); if (nzf) nzf.onsubmit = async (e) => { e.preventDefault(); const res = await K.api('POST', `${base}/najiz/reconcile`, { outcome: K.$('#nzo', root).value, najizRef: K.$('#nzr', root).value || undefined }); if (K.report(res)) reload(); };
    };
    return { title: String(title).slice(0, 60), html, after };
  };
})();
