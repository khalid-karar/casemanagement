// Board report: figures for senior management, printable. It holds counts, rates and averages only.
(() => {
  const K = CMS, { esc } = K;
  const iso = (d) => d.toISOString().slice(0, 10);
  CMS.views.board = async (route) => {
    const to = route.query.get('to') || iso(new Date());
    const from = route.query.get('from') || iso(new Date(Date.parse(to) - 89 * 86400000));
    const r = await K.api('GET', `/board-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const x = r.j;
    const tile = (label, value, note = '') => `<div class="stat"><div class="n">${esc(value)}</div><div class="l">${esc(label)}</div>${note ? `<div class="mute">${esc(note)}</div>` : ''}</div>`;
    const dash = (v, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`);
    const body = !r.ok ? `<div class="banner warn">${esc(L.errorText(r.j, r.status))}</div>` : `
      <div class="stats">${tile(L.t('boardOpened'), x.opened)}${tile(L.t('boardClosed'), x.closed)}${tile(L.t('boardOpenNow'), x.openNow)}${tile(L.t('boardSubst'), dash(x.substantiation.rate, '%'), L.t('boardSubstNote'))}${tile(L.t('boardAvgClose'), dash(x.avgDaysToClose))}${tile(L.t('boardSla'), x.pastTarget)}${tile(L.t('boardActions'), x.overdueActions)}${x.reports ? tile(L.t('boardRepIn'), x.reports.received) + tile(L.t('boardRepWait'), x.reports.awaitingTriage) : ''}</div>
      <section class="card"><h3>${esc(L.t('boardAging'))} (${esc(L.t('boardDays'))})</h3><table class="tbl"><tbody>${x.aging.map((a) => `<tr><th scope="row">${esc(a.bucket)}</th><td>${a.count}</td></tr>`).join('')}</tbody></table></section>
      <section class="card"><h3>${esc(L.t('boardByDomain'))}</h3>${x.byDomain.length ? `<table class="tbl"><thead><tr><th></th><th>${esc(L.t('boardOpened'))}</th><th>${esc(L.t('boardClosed'))}</th><th>${esc(L.t('boardOpenNow'))}</th></tr></thead><tbody>${x.byDomain.map((d) => `<tr><th scope="row">${esc(L.E[K.s.lang].dept[d.domain] ?? d.domain)}</th><td>${d.opened}</td><td>${d.closed}</td><td>${d.open}</td></tr>`).join('')}</tbody></table>` : `<p class="mute">${esc(L.t('boardNoData'))}</p>`}</section>
      <section class="card"><h3>${esc(L.t('boardByOutcome'))}</h3>${x.byOutcome.length ? `<table class="tbl"><tbody>${x.byOutcome.map((o) => `<tr><th scope="row">${esc(L.E[K.s.lang].option[o.outcome] ?? o.outcome)}</th><td>${o.count}</td></tr>`).join('')}</tbody></table>` : `<p class="mute">${esc(L.t('boardNoData'))}</p>`}</section>`;
    const html = `<div class="page-h"><h2 id="h">${esc(L.t('boardT'))}</h2><span class="spacer"></span><button class="secondary" id="bprint" type="button">${esc(L.t('boardPrint'))}</button><button class="secondary" id="bcsv" type="button">${K.ic('download')} ${esc(L.t('boardCsv'))}</button></div>
      <p class="mute">${esc(L.t('boardSub'))}</p>
      <form id="bf" class="row noprint"><label>${esc(L.t('boardFrom'))} <input type="date" id="bfrom" value="${esc(from)}" required></label> <label>${esc(L.t('boardTo'))} <input type="date" id="bto" value="${esc(to)}" required></label> <button type="submit">${esc(L.t('boardRun'))}</button></form>${body}`;
    const after = (root) => {
      K.$('#bf', root).onsubmit = (e) => { e.preventDefault(); K.go(`/board?from=${K.$('#bfrom', root).value}&to=${K.$('#bto', root).value}`); };
      K.$('#bprint', root).onclick = () => window.print();
      K.$('#bcsv', root).onclick = async () => { const res = await fetch(`/board-report?format=csv&from=${from}&to=${to}`, { headers: { authorization: Auth.header(K.s.user) } }); if (!res.ok) return K.toast(L.t('e_' + res.status), 'err'); const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = `board-report-${from}_${to}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    };
    return { title: L.t('boardT'), html, after };
  };
})();
