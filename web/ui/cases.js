// Case list: search, filters, sort, pagination, saved views, and the create-case dialog.
(() => {
  const K = CMS, { esc } = K;
  const SORTS = [['updated', 'updated'], ['created', 'created'], ['age', 'age'], ['id', 'caseId'], ['title', 'title'], ['state', 'state'], ['due', 'actionDue']];
  const KEYS = ['q', 'state', 'dept', 'type', 'mine', 'open', 'needs', 'overdue', 'due', 'sort', 'order', 'page'];
  const viewsKey = () => 'views:' + K.s.user;
  const readViews = () => { try { return JSON.parse(K.ls.get(viewsKey(), '[]')); } catch { return []; } };

  K.createCaseDialog = async (preType) => {
    const types = Object.values(K.s.defs);
    // Default to a type from the person's own department, so most people never have to choose.
    preType = preType ?? (types.find((d) => (K.s.me.departments ?? []).includes(d.domain)) ?? types[0])?.key;
    const fieldsHtml = (key) => (K.s.defs[key]?.fields ?? []).filter((f) => f.required).map((f, i) => K.fieldRow(f, '', 'nf-' + f.key, { required: true })).join('') || `<p class="hint">${esc(L.t('createFirst'))}</p>`;
    const r = await K.dialog({
      title: L.t('createTitle'), ok: L.t('create'),
      body: `<p class="hint">${esc(L.t('createFirst'))}</p><div class="field"><label for="nf-type">${esc(L.t('caseType'))}</label><select id="nf-type" name="__type" autofocus>${types.map((d) => `<option value="${esc(d.key)}" ${d.key === preType ? 'selected' : ''}>${esc(L.lab(d.label))}</option>`).join('')}</select></div><div id="nf-fields" class="grid mt8">${fieldsHtml(preType ?? types[0]?.key)}</div>`,
      onOpen: (d) => { K.$('#nf-type', d).onchange = (e) => { K.$('#nf-fields', d).innerHTML = fieldsHtml(e.target.value); }; },
    });
    if (!r.ok) return null;
    const def = K.s.defs[r.data.__type]; const fields = {};
    for (const f of def.fields) { const raw = r.data[f.key]; if (raw !== undefined && raw !== '') fields[f.key] = f.type === 'number' || f.type === 'money' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw; }
    const res = await K.api('POST', '/cases', { caseType: def.key, fields });
    if (!K.report(res, L.t('created_ok'))) return null;
    return res.j.id;
  };

  CMS.views.cases = async (route) => {
    const qs = route.query; // URLSearchParams
    const state = Object.fromEntries(KEYS.map((k) => [k, qs.get(k) ?? '']));
    const allStates = [...new Map(Object.values(K.s.defs).flatMap((d) => d.states.map((s) => [s.key, s]))).values()];
    const sel = (id, label, opts, cur) => `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}"><option value="">${esc(L.t('all'))}</option>${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
    const chk = (id, label, on) => `<label class="row gap6"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('cases'))}</h2><span class="spacer"></span><button class="gold" id="new">${K.ic('plus')} ${esc(L.t('newCase'))}</button></div>
    <section class="card"><details class="filters" ${innerWidth > 700 ? 'open' : ''}><summary>${K.ic('filter')} ${esc(L.t('filterTitle'))}</summary><form id="f" role="search" class="grid g3">
      <div class="field span-all"><label for="q">${esc(L.t('search'))}</label><div class="input-icon">${K.ic('search')}<input id="q" type="search" value="${esc(state.q)}" placeholder="${esc(L.t('searchPh'))}" autocomplete="off"></div></div>
      ${sel('fstate', L.t('filterState'), allStates.map((s) => [s.key, L.lab(s.label)]), state.state)}
      ${sel('fdept', L.t('filterDept'), ['HR', 'SECURITY', 'AUDIT', 'LEGAL'].map((d) => [d, L.dept(d)]), state.dept)}
      ${sel('ftype', L.t('filterType'), Object.values(K.s.defs).map((d) => [d.key, L.lab(d.label)]), state.type)}
      <div class="field"><span class="lbl">${esc(L.t('quickFilters'))}</span><div class="row">${chk('fmine', L.t('filterMine'), state.mine === '1')}${chk('fopen', L.t('filterOpen'), state.open === '1')}${chk('fneeds', L.t('needAction'), state.needs === '1')}</div></div>
      <div class="field"><label for="fsort">${esc(L.t('sortBy'))}</label><select id="fsort">${SORTS.map(([v, k]) => `<option value="${v}" ${v === (state.sort || 'updated') ? 'selected' : ''}>${esc(L.t(k))}</option>`).join('')}</select></div>
    </form>
    <div class="row mt8"><span class="lbl">${esc(L.t('savedViews'))}:</span><span id="views" class="chips"></span><button class="ghost sm" id="saveView" type="button">${K.ic('plus')} ${esc(L.t('saveView'))}</button></div></details><div id="chips" class="mt8"></div></section>
    <section class="card" aria-live="polite" aria-busy="false"><div id="results"></div></section>`;

    const after = (root) => {
      const cur = { ...state };
      const sync = () => { const p = new URLSearchParams(); for (const k of KEYS) if (cur[k]) p.set(k, cur[k]); history.replaceState(null, '', '#/cases' + (p.size ? '?' + p : '')); };
      const params = () => { const p = new URLSearchParams(); for (const k of KEYS) if (cur[k]) p.set(k, cur[k]); p.set('pageSize', '15'); return p; };
      const chips = () => {
        const labels = { q: () => `“${cur.q}”`, state: () => L.state(Object.values(K.s.defs).find((d) => d.states.some((s) => s.key === cur.state)), cur.state), dept: () => L.dept(cur.dept), type: () => L.caseType(cur.type), mine: () => L.t('filterMine'), open: () => L.t('filterOpen'), needs: () => L.t('needAction'), overdue: () => L.t('overdue'), due: () => L.t('dueSoon') };
        const on = Object.keys(labels).filter((k) => cur[k]);
        K.$('#chips', root).innerHTML = on.length ? `<div class="chips" role="list" aria-label="${esc(L.t('activeFilters'))}">${on.map((k) => `<span class="chip" role="listitem">${esc(labels[k]())}<button type="button" data-rm="${k}" aria-label="${esc(L.t('clear'))}: ${esc(labels[k]())}">${K.ic('x')}</button></span>`).join('')}<button class="ghost sm" type="button" id="clearAll">${esc(L.t('clearFilters'))}</button></div>` : '';
        K.$$('[data-rm]', root).forEach((b) => (b.onclick = () => { cur[b.dataset.rm] = ''; cur.page = ''; push(); }));
        const ca = K.$('#clearAll', root); if (ca) ca.onclick = () => { for (const k of KEYS) if (k !== 'sort' && k !== 'order') cur[k] = ''; push(); };
      };
      const views = () => {
        const v = readViews();
        K.$('#views', root).innerHTML = v.map((x, i) => `<span class="chip"><a href="#/cases?${esc(x.qs)}">${esc(x.name)}</a><button type="button" data-dv="${i}" aria-label="${esc(L.t('deleteView'))}: ${esc(x.name)}">${K.ic('x')}</button></span>`).join('') || `<span class="mute">${esc(L.t('none'))}</span>`;
        K.$$('[data-dv]', root).forEach((b) => (b.onclick = () => { const a = readViews(); a.splice(Number(b.dataset.dv), 1); K.ls.set(viewsKey(), JSON.stringify(a)); views(); }));
      };
      let seq = 0;
      const load = async () => {
        const my = ++seq; const box = K.$('#results', root); box.parentElement.setAttribute('aria-busy', 'true');
        const r = await K.api('GET', '/cases/search?' + params());
        if (my !== seq) return; box.parentElement.setAttribute('aria-busy', 'false');
        if (!r.ok) { box.innerHTML = `<div class="empty">${K.ic('alert')}<p>${esc(L.t('e_generic'))}</p><button class="secondary" id="again">${esc(L.t('retry'))}</button></div>`; K.$('#again', root).onclick = load; return; }
        const { items, total, page, pageSize } = r.j;
        const filtered = KEYS.some((k) => !['sort', 'order', 'page'].includes(k) && cur[k]);
        if (!total) { box.innerHTML = `<div class="empty">${K.ic('folder')}<p><b>${esc(filtered ? L.t('noResults') : L.t('noCases'))}</b></p>${filtered ? `<button class="secondary" id="clr2">${esc(L.t('clearFilters'))}</button>` : `<p>${esc(L.t('noCasesHint'))}</p><button class="gold" id="new2">${K.ic('plus')} ${esc(L.t('newCase'))}</button>`}</div>`; const a = K.$('#clr2', root); if (a) a.onclick = () => { for (const k of KEYS) cur[k] = ''; push(); }; const b = K.$('#new2', root); if (b) b.onclick = () => K.$('#new', root).click(); return; }
        const ord = cur.order === 'asc' ? 'ascending' : 'descending';
        const th = (key, label) => `<th scope="col" aria-sort="${(cur.sort || 'updated') === key ? ord : 'none'}"><button type="button" data-sort="${key}">${esc(L.t(label))} ${K.ic('sort')}</button></th>`;
        box.innerHTML = `<table class="tbl stack"><caption class="sr-only">${esc(L.t('cases'))}</caption><thead><tr>${th('title', 'title')}${th('state', 'state')}<th scope="col">${esc(L.t('dept'))}</th><th scope="col">${esc(L.t('owner'))}</th>${th('age', 'age')}${th('updated', 'updated')}</tr></thead><tbody>${items.map((c) => {
          const def = K.s.defs[c.caseTypeKey];
          return `<tr><td data-l="${esc(L.t('title'))}"><a class="row-link" href="#/cases/${encodeURIComponent(c.id)}">${esc(c.title ?? L.caseType(c.caseTypeKey))}</a><div class="mute"><span class="code">${esc(c.id)}</span> · ${esc(L.caseType(c.caseTypeKey))}</div>${c.overdueActions ? `<span class="badge bad">${K.ic('alert')} ${esc(L.t('overdueB'))}</span> ` : ''}${c.legalHold ? `<span class="badge gold">${K.ic('lock')} ${esc(L.t('legalHold'))}</span>` : ''}</td>
          <td data-l="${esc(L.t('state'))}"><span class="badge ${c.stateKind === 'OPEN' ? 'info' : ''}">${esc(L.state(def, c.state))}</span></td><td data-l="${esc(L.t('dept'))}">${esc(L.dept(c.department))}</td><td data-l="${esc(L.t('owner'))}">${c.assigneeId ? esc(K.who(c.assigneeId)) : `<span class="mute">${esc(L.t('unassigned'))}</span>`}</td>
          <td data-l="${esc(L.t('age'))}" class="num">${esc(K.num(c.ageDays))} ${esc(L.t('daysShort'))}</td><td data-l="${esc(L.t('updated'))}">${K.time(c.stateEnteredAt)}</td></tr>`;
        }).join('')}</tbody></table>
        <div class="pager"><span class="mute">${esc(L.t('showing'))} <span class="num">${esc(K.num((page - 1) * pageSize + 1))}–${esc(K.num(Math.min(total, page * pageSize)))}</span> ${esc(L.t('of'))} <span class="num">${esc(K.num(total))}</span> ${esc(L.t('results'))}</span>
        <span class="row"><button class="secondary sm" id="prev" ${page <= 1 ? 'disabled' : ''}>${K.ic(K.ar() ? 'chevR' : 'chevL')} ${esc(L.t('prev'))}</button><span class="num">${esc(L.t('pageN'))} ${esc(K.num(page))}</span><button class="secondary sm" id="next" ${page * pageSize >= total ? 'disabled' : ''}>${esc(L.t('next'))} ${K.ic(K.ar() ? 'chevL' : 'chevR')}</button></span></div>`;
        K.$$('[data-sort]', root).forEach((b) => (b.onclick = () => { const k = b.dataset.sort; if ((cur.sort || 'updated') === k) cur.order = cur.order === 'asc' ? 'desc' : 'asc'; else { cur.sort = k; cur.order = 'asc'; } cur.page = ''; push(); }));
        K.$('#prev', root).onclick = () => { cur.page = String(page - 1); push(); }; K.$('#next', root).onclick = () => { cur.page = String(page + 1); push(); };
      };
      const push = () => { sync(); const f = K.$('#f', root); K.$('#q', f).value = cur.q; K.$('#fstate', f).value = cur.state; K.$('#fdept', f).value = cur.dept; K.$('#ftype', f).value = cur.type; K.$('#fmine', f).checked = cur.mine === '1'; K.$('#fopen', f).checked = cur.open === '1'; K.$('#fneeds', f).checked = cur.needs === '1'; K.$('#fsort', f).value = cur.sort || 'updated'; chips(); load(); };
      let t; K.$('#q', root).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { cur.q = e.target.value.trim(); cur.page = ''; sync(); chips(); load(); }, 250); };
      const bind = (id, key, fn = (e) => e.target.value) => (K.$(id, root).onchange = (e) => { cur[key] = fn(e); cur.page = ''; push(); });
      bind('#fstate', 'state'); bind('#fdept', 'dept'); bind('#ftype', 'type'); bind('#fmine', 'mine', (e) => (e.target.checked ? '1' : '')); bind('#fopen', 'open', (e) => (e.target.checked ? '1' : '')); bind('#fneeds', 'needs', (e) => (e.target.checked ? '1' : ''));
      K.$('#fsort', root).onchange = (e) => { cur.sort = e.target.value; cur.order = ['updated', 'created', 'age'].includes(cur.sort) ? 'desc' : 'asc'; cur.page = ''; push(); };
      K.$('#f', root).onsubmit = (e) => e.preventDefault();
      K.$('#saveView', root).onclick = async () => { const r = await K.dialog({ title: L.t('saveView'), ok: L.t('save'), body: `<div class="field"><label for="vn">${esc(L.t('viewName'))}</label><input id="vn" name="n" required maxlength="40" autofocus></div>` }); if (!r.ok) return; const p = new URLSearchParams(); for (const k of KEYS) if (cur[k]) p.set(k, cur[k]); const a = readViews(); a.push({ name: r.data.n, qs: p.toString() }); K.ls.set(viewsKey(), JSON.stringify(a.slice(-12))); views(); K.toast(L.t('viewSaved')); };
      K.$('#new', root).onclick = async () => { const id = await K.createCaseDialog(cur.type || undefined); if (id) K.go('/cases/' + encodeURIComponent(id)); };
      chips(); views(); load();
      if (qs.get('new') === '1') { history.replaceState(null, '', '#/cases'); K.$('#new', root).click(); }
    };
    return { title: L.t('cases'), html, after };
  };
})();
