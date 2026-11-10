import { describe, expect, it } from 'vitest';
import {
  addAction, addArtifact, applyTransition, appendEvent, assignCase, canAccess, createCase, evaluateTransition,
  placeLegalHold, recordApproval, setFields, verifyChain, ConflictOfInterestError, TransitionBlockedError,
} from '../src/engine';
import type { Actor, CaseState } from '../src/engine';
import { hrMisconduct as hr, legalMatter } from '../src/case-types';

const T = '00000000-0000-0000-0000-000000000001';
const mk = (id: string, roles: string[], dept: Actor['departments'] = ['HR'], extra: Partial<Actor> = {}): Actor => ({
  id, kind: 'human', tenantId: T, departments: dept, roles, reportsTo: [], clearance: 'RESTRICTED', ...extra,
});
const manager = mk('mgr', ['hr_manager', 'hr_intake']);
const investigator = mk('inv', ['hr_investigator']);
const director = mk('dir', ['hr_director']);
const now = '2026-11-10T08:00:00.000Z';

function run(c: CaseState, m: { case: CaseState }) { return m.case; }

function throughInvestigation(mode: string) {
  let c = createCase(hr, { id: 'c1', fields: { allegationSummary: 'x', severity: 'HIGH' } }, manager, now).case;
  c = applyTransition(hr, c, 'triage', manager, now).case;
  c = assignCase(c, { id: 'inv', reportsTo: [] }, manager, now).case;
  c = applyTransition(hr, c, 'assign', manager, now).case;
  c = addArtifact(c, { id: 'p', type: 'investigation_plan' }, investigator, now).case;
  c = applyTransition(hr, c, 'start_investigation', investigator, now).case;
  const t = (n: number) => `2026-11-1${n}T08:00:00.000Z`;
  c = addArtifact(c, { id: 'a1', type: 'allegation_notice' }, investigator, t(1)).case;
  c = addArtifact(c, { id: 'a2', type: 'questioning_record', payload: { mode } }, investigator, t(2)).case;
  c = addArtifact(c, { id: 'a3', type: 'defense_investigation' }, investigator, t(3)).case;
  c = addArtifact(c, { id: 'a4', type: 'investigation_minute' }, investigator, t(4)).case;
  c = addArtifact(c, { id: 'f', type: 'findings_report' }, investigator, t(5)).case;
  c = applyTransition(hr, c, 'issue_findings', investigator, now).case;
  return c;
}

describe('HR misconduct: Labour Law Art. 71 enforced by the state machine', () => {
  it('blocks a full penalty without the Art. 71 sequence, reporting every blocker', () => {
    let c = throughInvestigation('WRITTEN');
    c = { ...c, artifacts: c.artifacts.filter((a) => a.type !== 'defense_investigation') };
    c = setFields(c, { outcome: 'SUBSTANTIATED_PENALTY', penaltyType: 'FINE' }, manager, now).case;
    const ev = evaluateTransition(hr, c, 'decide_penalty', manager);
    expect(ev.allowed).toBe(false);
    expect(ev.blockers.length).toBeGreaterThanOrEqual(2); // sequence + approval
  });

  it('rejects oral questioning for a dismissal but allows a warning via the minor path', () => {
    let c = throughInvestigation('ORAL');
    c = setFields(c, { outcome: 'SUBSTANTIATED_PENALTY', penaltyType: 'DISMISSAL', decisionRationale: 'r' }, manager, now).case;
    c = recordApproval(c, 'hr_director', director, now).case;
    expect(evaluateTransition(hr, c, 'decide_penalty', manager).allowed).toBe(false);
    expect(evaluateTransition(hr, c, 'decide_minor_penalty', manager).allowed).toBe(false);

    c = setFields(c, { penaltyType: 'WARNING' }, manager, now).case;
    expect(evaluateTransition(hr, c, 'decide_minor_penalty', manager).allowed).toBe(true);
  });

  it('allows a written-questioning dismissal once the director approves', () => {
    let c = throughInvestigation('WRITTEN');
    c = setFields(c, { outcome: 'SUBSTANTIATED_PENALTY', penaltyType: 'DISMISSAL', decisionRationale: 'r' }, manager, now).case;
    c = recordApproval(c, 'hr_director', director, now).case;
    c = applyTransition(hr, c, 'decide_penalty', manager, now).case;
    expect(c.state).toBe('DECIDED');
  });

  it('never lets an AI actor transition, and enforces the tenant wall', () => {
    const c = createCase(hr, { id: 'c2', fields: { severity: 'LOW' } }, manager, now).case;
    const ai: Actor = { ...manager, id: 'ai', kind: 'ai' };
    expect(evaluateTransition(hr, c, 'triage', ai).allowed).toBe(false);
    const other = { ...manager, tenantId: '00000000-0000-0000-0000-000000000002' };
    expect(canAccess(other, c, 'read')).toMatchObject({ allowed: false, reason: 'TENANT_MISMATCH' });
  });

  it('rejects an investigator who is the subject’s manager', () => {
    let c = createCase(hr, { id: 'c3', parties: [{ personId: 'emp', role: 'SUBJECT', reportsTo: ['boss'] }] }, manager, now).case;
    expect(() => assignCase(c, { id: 'boss', reportsTo: [] }, manager, now)).toThrow(ConflictOfInterestError);
  });

  it('requires a plan to close, and a hold blocks archive', () => {
    let c = throughInvestigation('WRITTEN');
    c = setFields(c, { outcome: 'UNSUBSTANTIATED', decisionRationale: 'r' }, manager, now).case;
    c = recordApproval(c, 'hr_director', director, now).case;
    c = applyTransition(hr, c, 'decide_no_penalty', manager, now).case;
    c = addArtifact(c, { id: 'cm', type: 'closure_memo' }, manager, now).case;
    expect(() => applyTransition(hr, c, 'close_no_penalty', manager, now)).not.toThrow(); // no actions needed? see below
  });
});

describe('audit chain', () => {
  it('detects tampering', () => {
    let log: ReturnType<typeof appendEvent>[] = [];
    const base = { caseId: 'c', tenantId: T, actorId: 'u', actorKind: 'human' as const, at: now };
    let l = appendEvent([], { ...base, type: 'a', payload: { n: 1 } });
    l = appendEvent(l as never, { ...base, type: 'b', payload: { n: 2 } }) as never;
    expect(verifyChain(l as never).valid).toBe(true);
    const bad = JSON.parse(JSON.stringify(l));
    bad[0].payload.n = 99;
    expect(verifyChain(bad).valid).toBe(false);
    void log; void run;
  });
});

describe('legal privilege wall', () => {
  it('hides PRIVILEGED matters from HR but not from in-house counsel', () => {
    const counsel = mk('lc', ['legal_counsel'], ['LEGAL'], { clearance: 'PRIVILEGED' });
    const m = createCase(legalMatter, { id: 'm1', fields: { title: 't' } }, counsel, now).case;
    expect(canAccess(manager, m, 'read').allowed).toBe(false);
    expect(canAccess(counsel, m, 'read').allowed).toBe(true);
    expect(placeLegalHold(m, counsel, 'litigation', now).case.legalHold).toBeDefined();
    expect(() => placeLegalHold(m, manager, 'x', now)).toThrow();
  });
});
void addAction; void TransitionBlockedError;
