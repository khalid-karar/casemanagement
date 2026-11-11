import { describe, expect, it } from 'vitest';
import {
  AccessDeniedError, FieldError, MAX_THREAD_MESSAGES, appendEvent, canAccess, convertReport, createReport, dismissReport,
  reporterReply, reporterView, staffReply, staffView, verifyReport,
} from '../src/engine';
import type { Actor, Report } from '../src/engine';
import { CODE_LENGTH, formatReportCode, generateReportCode, hashReportCode, normaliseReportCode } from '../src/security/reportcode';

const T = 'tenant-a';
const t0 = '2026-11-11T08:00:00.000Z';
const t1 = '2026-11-11T09:00:00.000Z';
const t2 = '2026-11-11T10:00:00.000Z';
const actor = (id: string, roles: string[], tenantId = T, kind: Actor['kind'] = 'human'): Actor =>
  ({ id, kind, tenantId, departments: ['HR'], roles, reportsTo: [], clearance: 'RESTRICTED' });
const ethics = actor('u-ethics', ['ethics_officer']);
const hrMgr = actor('u-hr', ['hr_manager']);

const code = generateReportCode();
const fresh = (over: Partial<Parameters<typeof createReport>[0]> = {}): Report =>
  createReport({ id: 'rpt-1', tenantId: T, channelId: 'ch-1', category: 'HR', language: 'ar', text: 'My supervisor is falsifying timesheets.', codeHash: hashReportCode(code), ...over }, t0);
const problems = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof FieldError ? e.problems.map((p) => `${p.field}:${p.code}`) : e; } return null; };

describe('reference codes', () => {
  it('are 120 bits, in an unambiguous alphabet, and different every time', () => {
    const a = generateReportCode();
    expect(a).toHaveLength(CODE_LENGTH);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/); // no I, L, O or U
    expect(new Set(Array.from({ length: 500 }, generateReportCode)).size).toBe(500);
    expect(formatReportCode(a)).toMatch(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);
  });

  it('are read back through the mistakes real people make', () => {
    const c = generateReportCode();
    const shown = formatReportCode(c);
    expect(normaliseReportCode(shown)).toBe(c);
    expect(normaliseReportCode(shown.toLowerCase())).toBe(c);
    expect(normaliseReportCode(`  ${shown.replace(/-/g, ' ')}  `)).toBe(c);
    expect(normaliseReportCode(shown.replace(/-/g, '‏-‎'))).toBe(c); // bidi marks from copying out of Arabic text
    // Typed on an Arabic keyboard: digits arrive as Arabic-Indic. O/I/L are read as 0/1/1.
    const withDigits = 'ABCD0123456789ABCDEFGHJK';
    const arabic = withDigits.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    expect(normaliseReportCode(arabic)).toBe(withDigits);
    expect(normaliseReportCode('OOOO-IIII-LLLL-0000-1111-ABCD')).toBe('0000' + '1111' + '1111' + '0000' + '1111' + 'ABCD');
  });

  it('are rejected quietly when they cannot be a code', () => {
    for (const bad of [undefined, null, 5, {}, '', 'short', 'x'.repeat(500), generateReportCode().slice(0, 23), generateReportCode() + 'A', 'U'.repeat(24)]) {
      expect(normaliseReportCode(bad as unknown)).toBeUndefined();
    }
  });

  it('are stored only as a domain-separated hash', () => {
    const h = hashReportCode(code);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code);
    expect(h).not.toBe(hashReportCode(generateReportCode()));
  });
});

describe('a report is not a case', () => {
  it('starts untriaged with the reporter’s text as message 1 and a chain that commits to it', () => {
    const r = fresh();
    expect(r.status).toBe('UNTRIAGED');
    expect(r.messages).toHaveLength(1);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'report.received', actorKind: 'reporter', actorId: 'reporter' });
    expect(r.events[0]!.payload.textSha256).toBe(r.messages[0]!.sha256);
    expect(JSON.stringify(r.events)).not.toContain('falsifying'); // the chain never holds the text
    expect(verifyReport(r)).toEqual({ valid: true });
  });

  it('validates what the reporter sends', () => {
    expect(problems(() => fresh({ text: 'short' }))).toEqual(['text:TEXT_TOO_SHORT']);
    expect(problems(() => fresh({ text: 'x'.repeat(20_001) }))).toEqual(['text:TEXT_TOO_LONG']);
    expect(problems(() => fresh({ text: 42 }))).toEqual(['text:EXPECTED_TEXT']);
    expect(problems(() => fresh({ category: 'MURDER' }))).toEqual(['category:NOT_AN_ALLOWED_OPTION']);
    expect(problems(() => fresh({ language: 'klingon' }))).toEqual(['language:NOT_AN_ALLOWED_OPTION']);
    expect(fresh({ text: '  \u0000padded\u0007 text here  ' }).messages[0]!.text).toBe('padded text here');
  });

  it('can never be read through the case permission check, whatever else is set on the actor', () => {
    const reporterActor = actor('reporter', ['ethics_officer', 'case_manager'], T, 'reporter');
    expect(canAccess(reporterActor, { tenantId: T, department: 'HR', confidentiality: 'STANDARD' }, 'read')).toEqual({ allowed: false, reason: 'REPORTER_HAS_NO_CASE_ACCESS' });
  });
});

describe('triage is for ethics officers only', () => {
  it('refuses everyone else, other tenants and AI actors, for every staff action', () => {
    const r = fresh();
    for (const who of [hrMgr, actor('u-x', ['ethics_officer'], 'tenant-b'), actor('ai', ['ethics_officer'], T, 'ai')]) {
      expect(() => staffReply(r, 'hello', who, t1), who.id).toThrow(AccessDeniedError);
      expect(() => convertReport(r, 'c-1', who, t1), who.id).toThrow(AccessDeniedError);
      expect(() => dismissReport(r, 'not credible at all', who, t1), who.id).toThrow(AccessDeniedError);
    }
  });

  it('converts once, records the case, and refuses to convert or dismiss again', () => {
    const c = convertReport(fresh(), 'from-rpt-1', ethics, t1);
    expect(c).toMatchObject({ status: 'CONVERTED', caseId: 'from-rpt-1' });
    expect(c.events.at(-1)).toMatchObject({ type: 'report.converted', actorId: 'u-ethics', actorKind: 'human' });
    expect(() => convertReport(c, 'other', ethics, t2)).toThrow(AccessDeniedError);
    expect(() => dismissReport(c, 'changed my mind here', ethics, t2)).toThrow(AccessDeniedError);
  });

  it('dismisses only with a real reason, kept out of the chain as a digest', () => {
    expect(problems(() => dismissReport(fresh(), 'no', ethics, t1))).toEqual(['note:TEXT_TOO_SHORT']);
    const d = dismissReport(fresh(), 'Duplicate of an already investigated matter', ethics, t1);
    expect(d.status).toBe('DISMISSED');
    expect(d.closingNote).toBe('Duplicate of an already investigated matter');
    expect(JSON.stringify(d.events)).not.toContain('Duplicate');
    expect(verifyReport(d)).toEqual({ valid: true });
  });
});

describe('the thread', () => {
  it('is two-way, append-only and chained', () => {
    let r = fresh();
    r = staffReply(r, 'Can you tell us which site?', ethics, t1);
    r = reporterReply(r, 'The north camp, building 4.', t2);
    expect(r.messages.map((m) => [m.n, m.author])).toEqual([[1, 'REPORTER'], [2, 'STAFF'], [3, 'REPORTER']]);
    expect(r.events.map((e) => e.type)).toEqual(['report.received', 'report.staff_message', 'report.reporter_message']);
    expect(r.messages.map((m) => m.eventSeq)).toEqual([1, 2, 3]);
    expect(verifyReport(r)).toEqual({ valid: true });
  });

  it('is caught if a message is altered, swapped, dropped or the chain is rewritten', () => {
    const r = staffReply(fresh(), 'a staff question', ethics, t1);
    const edited = { ...r, messages: r.messages.map((m) => (m.n === 1 ? { ...m, text: 'something else entirely' } : m)) };
    expect(verifyReport(edited)).toEqual({ valid: false, reason: 'MESSAGE_1_ALTERED' });
    // Same edit with a recomputed per-message digest still fails: the chain committed to the original.
    const resigned = { ...edited, messages: edited.messages.map((m) => (m.n === 1 ? { ...m, sha256: 'a'.repeat(64) } : m)) };
    expect(verifyReport(resigned)).toEqual({ valid: false, reason: 'MESSAGE_1_NOT_IN_CHAIN' });
    // Deleting the reporter's original words must not verify, nor must reordering what is left.
    expect(verifyReport({ ...r, messages: [r.messages[1]!] })).toEqual({ valid: false, reason: 'MESSAGE_MISSING' });
    expect(verifyReport({ ...r, messages: [] })).toEqual({ valid: false, reason: 'MESSAGE_MISSING' });
    expect(verifyReport({ ...r, messages: [r.messages[1]!, r.messages[0]!] })).toEqual({ valid: false, reason: 'MESSAGE_ORDER' });
    const tamperedChain = { ...r, events: [{ ...r.events[0]!, at: '2020-01-01T00:00:00.000Z' }, r.events[1]!] };
    expect(verifyReport(tamperedChain)).toMatchObject({ valid: false });
  });

  it('caps the conversation, and the cap applies to the reporter too', () => {
    let r = fresh();
    for (let i = 1; i < MAX_THREAD_MESSAGES; i++) r = reporterReply(r, `message ${i}`, t1);
    expect(r.messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(() => reporterReply(r, 'one more', t2)).toThrow(AccessDeniedError);
    expect(() => staffReply(r, 'and one more', ethics, t2)).toThrow(AccessDeniedError);
  });

  it('is reopened by a reporter who writes after a dismissal, but not by one who writes after acceptance', () => {
    const dismissed = dismissReport(fresh(), 'Insufficient detail to act upon', ethics, t1);
    const again = reporterReply(dismissed, 'You missed the second page of evidence', t2);
    expect(again.status).toBe('UNTRIAGED');
    expect(again.events.map((e) => e.type).slice(-2)).toEqual(['report.reporter_message', 'report.reopened']);
    expect(verifyReport(again)).toEqual({ valid: true });

    const converted = convertReport(fresh(), 'from-rpt-1', ethics, t1);
    expect(reporterReply(converted, 'further detail', t2).status).toBe('CONVERTED');
  });
});

describe('what each side can see', () => {
  const r = convertReport(staffReply(fresh(), 'Which site was this?', ethics, t1), 'from-rpt-1', ethics, t2);

  it('gives the reporter their words and the team’s, and nothing about who or where', () => {
    const v = reporterView(r);
    expect(v.status).toBe('ACCEPTED');
    expect(v.messages).toEqual([
      { n: 1, at: t0, from: 'YOU', text: 'My supervisor is falsifying timesheets.' },
      { n: 2, at: t1, from: 'TEAM', text: 'Which site was this?' },
    ]);
    const wire = JSON.stringify(v);
    for (const secret of ['u-ethics', 'from-rpt-1', 'rpt-1', 'ch-1', r.codeHash, 'authorId', 'caseId', 'sha256', 'closingNote', 'HR']) {
      expect(wire, secret).not.toContain(secret);
    }
  });

  it('shows staff the thread and the outcome, but never the code hash or the chain', () => {
    const v = staffView(r);
    expect(v).toMatchObject({ id: 'rpt-1', status: 'CONVERTED', caseId: 'from-rpt-1', category: 'HR', awaitingStaff: false });
    expect(v.messages[1]).toMatchObject({ author: 'STAFF', authorId: 'u-ethics' });
    const wire = JSON.stringify(v);
    expect(wire).not.toContain(r.codeHash);
    expect(wire).not.toContain('prevHash');
  });

  it('flags a report whose last word is the reporter’s', () => {
    expect(staffView(fresh()).awaitingStaff).toBe(true);
    expect(staffView(staffReply(fresh(), 'received, thank you', ethics, t1)).awaitingStaff).toBe(false);
  });
});

describe('report history uses the shared chain', () => {
  it('refuses to chain an event from a different report', () => {
    const r = fresh();
    expect(() => appendEvent(r.events, { caseId: 'other', tenantId: T, type: 'x', actorId: 'a', actorKind: 'reporter', at: t1, payload: {} })).toThrow();
  });
});
