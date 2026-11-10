import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CASE_TYPES } from '../src/case-types';

// Loads the browser dictionary exactly as the page does, then checks that nothing the UI can show lacks a translation.
const dir = new URL('../web/ui/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const ctx: any = { window: {}, localStorage: { getItem: () => null, setItem() {} }, document: {}, Intl, location: {}, console };
ctx.window = ctx; ctx.CMS = undefined;
runInNewContext(read('kit.js'), ctx); runInNewContext(read('labels.js') + ';this.L=L;', ctx);
const L = ctx.L;
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const src = files.map(read).join('\n');

describe('UI labels', () => {
  it('Arabic and English dictionaries have exactly the same keys', () => {
    expect(Object.keys(L.D.ar).sort()).toEqual(Object.keys(L.D.en).sort());
    for (const lang of ['ar', 'en']) for (const [k, v] of Object.entries(L.D[lang])) expect(String(v).trim(), `${lang}.${k}`).not.toBe('');
  });

  it('every L.t(key) used in the UI exists', () => {
    const used = new Set([...src.matchAll(/L\.t\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]!));
    // keys chosen at run time: tabs, nav, sorts, najiz states, error and status codes
    const dynamic = ['tabOverview', 'tabDocuments', 'tabActions', 'tabNajiz', 'tabTimeline', 'navHome', 'navCases', 'navLaws', 'navAi', 'navReview', 'updated', 'created', 'age', 'caseId', 'title', 'state', 'actionDue', 'NOT_SUBMITTED', 'IN_PROGRESS', 'UNCONFIRMED', 'SUBMITTED', 'st_READY', 'st_NEEDS_COUNSEL', 'st_NO_STATUTORY_RULES_MAPPED', 'status_DRAFT', 'status_UNDER_REVIEW', 'status_VERIFIED', 'status_REJECTED', 'status_PROPOSED', 'status_ACCEPTED', 'e_401', 'e_403', 'e_404', 'e_409', 'e_413', 'e_429', 'e_503', 'e_generic', 'digitsLatn', 'digitsArab', 'langSwitch'];
    const missing = [...used, ...dynamic].filter((k) => !(k in L.D.ar) || !(k in L.D.en));
    expect(missing).toEqual([]);
  });

  it('every state, field and enum option the server can produce has Arabic and English', () => {
    const missing: string[] = [];
    const arabic = /[؀-ۿ]/;
    for (const d of Object.values(CASE_TYPES)) {
      for (const s of d.states) { if (!s.label.ar || !s.label.en) missing.push(`state ${d.key}.${s.key}`); if (!arabic.test(s.label.ar)) missing.push(`state-ar ${s.key}`); }
      for (const f of d.fields) {
        if (!f.label.ar || !f.label.en) missing.push(`field ${f.key}`);
        for (const o of f.options ?? []) for (const lang of ['ar', 'en']) if (!L.E[lang].option[o]) missing.push(`option ${lang}.${o}`);
      }
      for (const t of d.transitions) if (!t.label.ar || !t.label.en) missing.push(`action ${t.action}`);
      if (!L.E.ar.dept[d.domain] || !L.E.en.dept[d.domain]) missing.push(`dept ${d.domain}`);
    }
    expect(missing).toEqual([]);
  });

  it('every artifact type the case types require, and every audit event, is translated', () => {
    const missing: string[] = [];
    const types = new Set<string>(['evidence', 'exhibit', 'referral_packet']);
    for (const d of Object.values(CASE_TYPES)) for (const t of d.transitions) for (const g of t.guards as any[]) if (g.kind === 'artifact_present' || g.kind === 'artifact_attr') types.add(g.artifactType);
    for (const k of ['pending', 'result', 'rejected', 'not_sent', 'unconfirmed']) types.add(`najiz_filing_${k}`);
    for (const k of ['najiz_reconciliation', 'najiz_status', 'najiz_notice']) types.add(k);
    for (const t of types) for (const lang of ['ar', 'en']) if (!L.E[lang].artifact[t]) missing.push(`artifact ${lang}.${t}`);
    const events = new Set([...[...(readFileSync(new URL('../src/engine/workflow.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/engine/legalhold.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/engine/referral.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/api/app.ts', import.meta.url), 'utf8')).matchAll(/type: '([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!)]);
    for (const e of events) for (const lang of ['ar', 'en']) if (!L.E[lang].ev[e]) missing.push(`event ${lang}.${e}`);
    expect(missing).toEqual([]);
  });

  it('every role named in a guard, every field error and every Najiz rule code is translated', () => {
    const missing: string[] = [];
    const roles = new Set<string>();
    for (const d of Object.values(CASE_TYPES)) for (const t of d.transitions) for (const g of t.guards as any[]) { for (const r of g.anyOf ?? []) roles.add(r); if (g.approverRole) roles.add(g.approverRole); }
    for (const r of roles) for (const lang of ['ar', 'en']) if (!L.E[lang].role[r]) missing.push(`role ${lang}.${r}`);
    const codes = new Set([...readFileSync(new URL('../src/engine/fields.ts', import.meta.url), 'utf8').matchAll(/'(EXPECTED_[A-Z_]+|NOT_AN_ALLOWED_OPTION|UNKNOWN_FIELD|REDACTED_MARKER|INVALID_ID|CASE_CLOSED|FIELD_LOCKED_IN_STATE)'/g)].map((m) => m[1]!));
    const nz = new Set([...readFileSync(new URL('../src/najiz/workflow.ts', import.meta.url), 'utf8').matchAll(/NajizRuleError\('([A-Z_]+)/g)].map((m) => m[1]!));
    for (const c of codes) for (const lang of ['ar', 'en']) if (!L.E[lang].err[c]) missing.push(`err ${lang}.${c}`);
    for (const c of nz) for (const lang of ['ar', 'en']) if (!L.E[lang].nz[c]) missing.push(`nz ${lang}.${c}`);
    expect(missing).toEqual([]);
  });

  it('the UI never uses inline style attributes (strict CSP) or inline scripts', () => {
    expect(src).not.toMatch(/style="/);
    expect(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')).not.toMatch(/<script>(?!<\/script>)|onclick=/);
  });
});
