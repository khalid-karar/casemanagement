import { describe, expect, it } from 'vitest';
import { LegalLibrary, LegalError, splitArticles } from '../src/legal';
import type { LegalActor } from '../src/legal';

const editor: LegalActor = { id: 'ed', roles: ['legal_content_editor'], tenantId: 'platform' };
const counsel: LegalActor = { id: 'co', roles: ['legal_verifier'], tenantId: 'platform' };
const RAW = `المادة 70
يجوز لصاحب العمل فسخ العقد في حالات محددة.
المادة (71)
لا يجوز توقيع جزاء إلا بعد إبلاغ العامل كتابة بما نسب إليه.
المادة ٧٢
يبلغ العامل بالجزاء كتابة.`;
const lib = () => {
  const l = new LegalLibrary();
  l.addInstrument({ id: 'labour', tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', issuer: 'MHRSD' }, editor, '2026-11-10');
  return l;
};

describe('legal ingest', () => {
  it('splits Arabic and Latin digit article headings', () => {
    const { provisions, warnings } = splitArticles(RAW);
    expect(provisions.map((p) => p.number)).toEqual(['70', '71', '72']);
    expect(warnings).toEqual([]);
  });
  it('warns on duplicates and stray text', () => {
    const { warnings } = splitArticles('مقدمة\nالمادة 1\nنص\nالمادة 1\nنص');
    expect(warnings.length).toBe(2);
  });
});

describe('human verification', () => {
  it('keeps unverified text out of the AI-visible set', () => {
    const l = lib();
    l.uploadVersion({ id: 'v1', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: RAW }, editor, '2026-11-10');
    expect(l.verifiedProvisions('t1', '2026-11-10')).toHaveLength(0);
  });
  it('requires a different person to verify, and the right role', () => {
    const l = lib();
    l.uploadVersion({ id: 'v1', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: RAW }, editor, '2026-11-10');
    l.submitForReview('v1', editor, '2026-11-10');
    expect(() => l.verify('v1', editor, 'ok', '2026-11-10')).toThrow(LegalError);
    const selfCounsel = { ...counsel, id: 'ed' };
    expect(() => l.verify('v1', selfCounsel, 'ok', '2026-11-10')).toThrow('VERIFIER_MUST_DIFFER_FROM_UPLOADER');
    l.verify('v1', counsel, 'checked against Umm Al-Qura', '2026-11-10');
    expect(l.verifiedProvisions('t1', '2026-11-10')).toHaveLength(3);
  });
  it('verified text is immutable', () => {
    const l = lib();
    l.uploadVersion({ id: 'v1', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: RAW }, editor, 'x');
    l.submitForReview('v1', editor, 'x'); l.verify('v1', counsel, 'ok', 'x');
    expect(() => l.editProvision('v1', '71', { textAr: 'تغيير' }, editor, 'x')).toThrow('VERIFIED_TEXT_IMMUTABLE');
  });
  it('tenant users cannot touch the platform baseline', () => {
    const l = lib();
    expect(() => l.uploadVersion({ id: 'v', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: RAW }, { ...editor, tenantId: 't1' }, 'x')).toThrow('SCOPE_MISMATCH');
  });
});

describe('effective dating and stale rules', () => {
  function withAmendment() {
    const l = lib();
    l.uploadVersion({ id: 'v1', instrumentId: 'labour', versionLabel: 'original', effectiveFrom: '2005-01-01', rawText: RAW }, editor, '2026-11-10');
    l.submitForReview('v1', editor, 'x'); l.verify('v1', counsel, 'ok', '2026-11-10');
    const b = l.bindRule({ id: 'b1', caseTypeKey: 'hr.misconduct', ruleRef: 'clock:employee_grievance_window', instrumentId: 'labour', provisionNumber: '72' }, counsel, '2026-11-10T00:00:00Z');
    const amended = RAW.replace('يبلغ العامل بالجزاء كتابة.', 'يبلغ العامل بالجزاء كتابة وله التظلم خلال مدة جديدة.');
    l.uploadVersion({ id: 'v2', instrumentId: 'labour', versionLabel: 'M/44', effectiveFrom: '2025-02-19', amendedBy: 'M/44', rawText: amended }, editor, '2026-11-10');
    return { l, b };
  }
  it('picks the version in force on the event date, not today', () => {
    const { l } = withAmendment();
    l.submitForReview('v2', editor, 'x'); l.verify('v2', counsel, 'ok', '2026-11-10');
    expect(l.inForce('labour', '2025-01-01')?.id).toBe('v1');
    expect(l.inForce('labour', '2026-01-01')?.id).toBe('v2');
  });
  it('flags a bound rule stale when its article changes, until counsel re-approves', () => {
    const { l, b } = withAmendment();
    expect(l.staleBindings()).toHaveLength(0);
    l.submitForReview('v2', editor, 'x'); l.verify('v2', counsel, 'ok', '2026-11-10');
    expect(b.stale).toBe(true);
    l.reapproveBinding('b1', counsel, '2026-11-10T00:00:00Z');
    expect(l.staleBindings()).toHaveLength(0);
  });
  it('does not flag rules bound to unchanged articles', () => {
    const { l } = withAmendment();
    l.bindRule({ id: 'b2', caseTypeKey: 'hr.misconduct', ruleRef: 'transition:decide_penalty', instrumentId: 'labour', provisionNumber: '71' }, counsel, '2026-11-10T00:00:00Z');
    l.submitForReview('v2', editor, 'x'); l.verify('v2', counsel, 'ok', '2026-11-10');
    expect(l.staleBindings().map((s) => s.id)).toEqual(['b1']);
  });
});
