import { describe, expect, it } from 'vitest';
import { LegalLibrary, extractText, FileError } from '../src/legal';
import { LABOUR_LAW, RULE_SOURCES, invalidSources, legalStatus, syncBindings } from '../src/case-types/legal-sources';

const ed = { id: 'ed', roles: ['legal_content_editor'], tenantId: 'platform' };
const co = { id: 'co', roles: ['legal_verifier'], tenantId: 'platform' };
const LAW = (art72: string) => `المادة 66\nالجزاءات.\nالمادة 71\nالإبلاغ كتابة.\nالمادة 72\n${art72}`;

function lib() {
  const l = new LegalLibrary();
  l.addInstrument({ id: LABOUR_LAW, tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', issuer: 'MHRSD' }, ed, 'x');
  return l;
}
const publish = (l: LegalLibrary, id: string, eff: string, text: string) => {
  l.uploadVersion({ id, instrumentId: LABOUR_LAW, versionLabel: id, effectiveFrom: eff, rawText: text }, ed, 'x');
  l.submitForReview(id, ed, 'x'); l.verify(id, co, 'ok', 'x');
};

describe('case-type legal bindings', () => {
  it('every binding points at a rule that really exists', () => {
    expect(invalidSources()).toEqual([]);
  });
  it('reports pending, never silently binds, before the law is verified', () => {
    const l = lib();
    const r = syncBindings(l, co, '2026-11-10T00:00:00Z');
    expect(r.bound).toEqual([]);
    expect(r.pending.length).toBe(RULE_SOURCES.length);
    expect(legalStatus(l, 'hr.misconduct').status).toBe('NEEDS_COUNSEL');
  });
  it('binds once verified, is READY, then goes stale when Art. 72 is amended', () => {
    const l = lib();
    publish(l, 'v1', '2005-01-01', LAW('الإبلاغ.'));
    syncBindings(l, co, '2026-11-10T00:00:00Z');
    expect(legalStatus(l, 'hr.misconduct').status).toBe('READY');
    publish(l, 'v2', '2025-02-19', LAW('الإبلاغ مع مهلة تظلم جديدة.'));
    const s = legalStatus(l, 'hr.misconduct');
    expect(s.status).toBe('NEEDS_COUNSEL');
    expect(s.stale.sort()).toEqual(['clock:employee_grievance_window', 'clock:employer_grievance_response_window', 'transition:notify_penalty']);
    l.reapproveBinding('hr.misconduct|transition:notify_penalty', co, '2026-11-10T00:00:00Z');
    expect(legalStatus(l, 'hr.misconduct').stale).toHaveLength(2);
  });
  it('does not claim coverage for case types with no mapped statute', () => {
    expect(legalStatus(lib(), 'security.incident').status).toBe('NO_STATUTORY_RULES_MAPPED');
    expect(legalStatus(lib(), 'audit.finding').status).toBe('NO_STATUTORY_RULES_MAPPED');
  });
});

describe('file extraction', () => {
  it('reads plain Arabic text and hashes the file', async () => {
    const bytes = new TextEncoder().encode('المادة 1\nنص نظامي طويل بما يكفي لتجاوز الحد الأدنى.');
    const r = await extractText(bytes);
    expect(r.kind).toBe('txt');
    expect(r.sha256).toHaveLength(64);
    expect(r.text).toContain('المادة 1');
  });
  it('rejects binaries, empty and oversize files by content', async () => {
    await expect(extractText(new Uint8Array([1, 2, 0, 3, 4]))).rejects.toThrow(FileError);
    await expect(extractText(new Uint8Array())).rejects.toThrow('EMPTY_FILE');
    await expect(extractText(new TextEncoder().encode('%PDF-1.4 not really a pdf'))).rejects.toThrow('UNREADABLE_FILE');
  });
});
