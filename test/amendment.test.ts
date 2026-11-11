import { describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  FieldError,
  addAction,
  amendCase,
  completeAction,
  createCase,
  effectiveField,
  redactForActor,
  setFields,
} from '../src/engine';
import type { Actor, CaseState } from '../src/engine';
import { hrMisconduct as hr } from '../src/case-types';

const T = 'tenant-a';
const now = '2026-11-11T08:00:00.000Z';
const later = '2026-11-12T08:00:00.000Z';

const actor = (roles: string[], departments: Actor['departments'] = ['HR']): Actor => ({
  id: 'u-' + roles[0], kind: 'human', tenantId: T, departments, roles, reportsTo: [], clearance: 'RESTRICTED',
});
const mgr = actor(['hr_manager']);
const caseManager = actor(['case_manager']);
const ethics = actor(['ethics_officer', 'case_manager']);

const open = (fields: Record<string, unknown> = {}): CaseState => createCase(hr, { id: 'c1', fields }, mgr, now).case;
const closed = (fields: Record<string, unknown> = {}): CaseState => ({ ...open(fields), state: 'CLOSED', closedAt: now });
const problems = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof FieldError ? { kind: e.kind, codes: e.problems.map((p) => `${p.field}:${p.code}`) } : e; }
  return null;
};
const good = { id: 'am-1', field: 'allegationSummary', correctedValue: 'corrected text', reason: 'Transcription error found on review' };

describe('amendments correct a closed case without editing it', () => {
  it('appends the correction and leaves the original field exactly as it closed', () => {
    const c = closed({ allegationSummary: 'original text' });
    const m = amendCase(c, good, caseManager, later, hr);

    expect(m.case.fields.allegationSummary).toBe('original text'); // the frozen record is untouched
    expect(m.case.amendments).toHaveLength(1);
    expect(m.case.amendments![0]).toMatchObject({
      field: 'allegationSummary', originalValue: 'original text', correctedValue: 'corrected text', authorId: 'u-case_manager', at: later,
    });
    expect(effectiveField(m.case, 'allegationSummary')).toBe('corrected text');
    expect(m.event.type).toBe('case.amended');
  });

  it('is the only write path once a case is closed, and the field edit path still refuses', () => {
    const c = closed({ allegationSummary: 'original text' });
    expect(problems(() => setFields(c, { allegationSummary: 'sneaky' }, caseManager, later, hr)))
      .toEqual({ kind: 'LOCKED', codes: ['allegationSummary:CASE_CLOSED'] });
  });

  it('refuses to amend a case that is still open: edit the field instead', () => {
    expect(problems(() => amendCase(open({ allegationSummary: 'draft' }), good, caseManager, later, hr)))
      .toMatchObject({ codes: ['allegationSummary:CASE_NOT_CLOSED'] });
  });

  it('requires an accountable role, a real field, a valid value, a reason and an actual change', () => {
    const c = closed({ allegationSummary: 'original text' });
    expect(() => amendCase(c, good, mgr, later, hr)).toThrow(AccessDeniedError); // hr_manager is not enough
    expect(problems(() => amendCase(c, { ...good, field: 'nope' }, caseManager, later, hr)))
      .toMatchObject({ codes: ['nope:UNKNOWN_FIELD'] });
    expect(problems(() => amendCase(c, { ...good, field: 'severity', correctedValue: 'EXTREME' }, caseManager, later, hr)))
      .toMatchObject({ codes: ['severity:NOT_AN_ALLOWED_OPTION'] });
    expect(problems(() => amendCase(c, { ...good, reason: 'typo' }, caseManager, later, hr)))
      .toMatchObject({ codes: ['reason:REASON_REQUIRED'] });
    expect(problems(() => amendCase(c, { ...good, correctedValue: 'original text' }, caseManager, later, hr)))
      .toMatchObject({ codes: ['allegationSummary:NO_CHANGE'] });
  });

  it('keeps amendments append-only: ids cannot be reused, and corrections stack in order', () => {
    const c = closed({ allegationSummary: 'v1' });
    const once = amendCase(c, good, caseManager, later, hr).case;
    expect(() => amendCase(once, good, caseManager, later, hr)).toThrow(AccessDeniedError);

    const twice = amendCase(once, { ...good, id: 'am-2', correctedValue: 'v3' }, caseManager, later, hr).case;
    expect(twice.amendments!.map((a) => a.correctedValue)).toEqual(['corrected text', 'v3']);
    expect(twice.fields.allegationSummary).toBe('v1'); // still never rewritten
    expect(effectiveField(twice, 'allegationSummary')).toBe('v3');
  });
});

describe('an amendment is not a way around the seal', () => {
  it('refuses a sealed-field correction without the sealed role, and allows it with', () => {
    const c = closed({ reporterIdentity: 'emp-1' });
    const patch = { id: 'am-1', field: 'reporterIdentity', correctedValue: 'emp-2', reason: 'Reporter record merged in HRIS' };
    expect(() => amendCase(c, patch, caseManager, later, hr)).toThrow(AccessDeniedError);
    expect(amendCase(c, patch, ethics, later, hr).case.amendments![0]!.correctedValue).toBe('emp-2');
  });

  it('masks amendment values for a reader who may not see the field', () => {
    const c = amendCase(closed({ reporterIdentity: 'emp-1' }), { id: 'am-1', field: 'reporterIdentity', correctedValue: 'emp-2', reason: 'Reporter record merged in HRIS' }, ethics, later, hr).case;

    const toEthics = redactForActor(hr, c, ethics);
    expect(toEthics.amendments![0]!.correctedValue).toBe('emp-2');

    const toOthers = redactForActor(hr, c, caseManager);
    expect(toOthers.amendments![0]!.correctedValue).toBe('[REDACTED]');
    expect(toOthers.amendments![0]!.originalValue).toBe('[REDACTED]');
  });

  it('masks a PERSONAL amendment across the department wall, even when the field was never set', () => {
    const c = amendCase(closed(), { id: 'am-1', field: 'subjectEmployee', correctedValue: 'emp-9', reason: 'Respondent recorded against the wrong file' }, caseManager, later, hr).case;
    const outsider = redactForActor(hr, c, actor(['case_manager', 'audit_assurance'], ['AUDIT']));
    expect(outsider.amendments![0]!.correctedValue).toBe('[REDACTED]');
  });

  it('records only digests in the audit event for a sensitive field', () => {
    const m = amendCase(closed({ reporterIdentity: 'emp-1' }), { id: 'am-1', field: 'reporterIdentity', correctedValue: 'emp-2', reason: 'Reporter record merged in HRIS' }, ethics, later, hr);
    const payload = m.event.payload as Record<string, unknown>;
    expect(payload.toSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('emp-2');
  });
});

describe('corrective actions outlive the case', () => {
  // Actions are a separate object rather than a case field, so the blanket close lock does not reach
  // them. That is deliberate — remediation is tracked to completion after closure — and this test
  // pins it so a later refactor cannot quietly fold actions into the frozen set.
  it('can still be added and completed after the case is CLOSED and ARCHIVED', () => {
    for (const state of ['CLOSED', 'ARCHIVED']) {
      const c: CaseState = { ...open(), state, closedAt: now };
      const added = addAction(c, { id: 'a-1', description: 'Reissue the site access policy', ownerId: 'emp-7', dueDate: '2026-12-01' }, mgr, later).case;
      expect(added.actions).toHaveLength(1);

      const done = completeAction(added, 'a-1', mgr, later).case;
      expect(done.actions[0]).toMatchObject({ status: 'DONE', completedAt: later });

      expect(done.fields).toEqual(c.fields); // closing still froze everything that IS a field
    }
  });
});
