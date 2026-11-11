// Typed inputs generated from the case type's field definitions. The server still validates everything; this only makes
// the right input appear (date picker, number, list of options with translated names) so people cannot type nonsense.
(() => {
  const K = CMS;
  K.fieldControl = (f, value, { id, disabled = false, required = false } = {}) => {
    const v = value === undefined || value === null || value === '[REDACTED]' ? '' : value;
    const a = `id="${K.esc(id)}" name="${K.esc(f.key)}" ${disabled ? 'disabled' : ''} ${required ? 'required' : ''}`;
    if (f.type === 'enum') return `<select ${a}><option value="">—</option>${(f.options ?? []).map((o) => `<option value="${K.esc(o)}" ${o === v ? 'selected' : ''}>${K.esc(L.opt(o))}</option>`).join('')}</select>`;
    if (f.type === 'boolean') return `<select ${a}><option value="">—</option><option value="true" ${v === true ? 'selected' : ''}>${K.esc(L.t('yes'))}</option><option value="false" ${v === false ? 'selected' : ''}>${K.esc(L.t('no'))}</option></select>`;
    if (f.type === 'longtext') return `<textarea ${a} rows="4" maxlength="20000">${K.esc(v)}</textarea>`;
    if (f.type === 'date') return `<input ${a} type="date" value="${K.esc(v)}">`;
    if (f.type === 'number' || f.type === 'money') return `<input ${a} type="number" step="any" ${f.type === 'money' ? 'min="0"' : ''} inputmode="decimal" value="${K.esc(v)}">`;
    return `<input ${a} type="text" maxlength="${f.type === 'person' ? 200 : 500}" value="${K.esc(v)}" ${f.type === 'person' ? 'autocomplete="off"' : ''}>`;
  };
  /** Reads a control back as the type the server expects. Returns undefined when left empty. */
  K.readControl = (f, el) => {
    const raw = el.value;
    if (raw === '' || raw === undefined) return undefined;
    if (f.type === 'number' || f.type === 'money') return Number(raw);
    if (f.type === 'boolean') return raw === 'true';
    return raw;
  };
  K.fieldRow = (f, value, id, opts = {}) => {
    const hint = f.sensitivity === 'SEALED' ? L.t('sealedNote') : f.sensitivity === 'PERSONAL' ? L.t('personalNote') : '';
    return `<div class="field"><label for="${K.esc(id)}">${K.esc(L.lab(f.label))}${opts.required ? ` <span class="hint">(${K.esc(L.t('required'))})</span>` : ''}</label>${K.fieldControl(f, value, { id, ...opts })}${hint ? `<span class="hint">${K.ic('lock')} ${K.esc(hint)}</span>` : ''}${opts.why ? `<span class="hint">${K.ic('lock')} ${K.esc(opts.why)}</span>` : ''}</div>`;
  };
})();
