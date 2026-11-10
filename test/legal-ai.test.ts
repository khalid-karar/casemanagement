import { describe, expect, it } from 'vitest';
import { LegalLibrary } from '../src/legal';
import { answerFromLaws } from '../src/ai';
import type { ChatProvider } from '../src/ai';

const ed = { id: 'ed', roles: ['legal_content_editor'], tenantId: 'platform' };
const co = { id: 'co', roles: ['legal_verifier'], tenantId: 'platform' };
const RAW = 'المادة 71\nلا يجوز توقيع جزاء على العامل إلا بعد إبلاغه كتابة بما نسب إليه.';

function lib(verify: boolean) {
  const l = new LegalLibrary();
  l.addInstrument({ id: 'labour', tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', titleEn: 'Labour Law', issuer: 'MHRSD' }, ed, 'x');
  l.uploadVersion({ id: 'v1', instrumentId: 'labour', versionLabel: 'orig', effectiveFrom: '2005-01-01', rawText: RAW }, ed, 'x');
  if (verify) { l.submitForReview('v1', ed, 'x'); l.verify('v1', co, 'ok', 'x'); }
  return l;
}
const run = (library: LegalLibrary, reply: string) => {
  let called = false;
  const provider: ChatProvider = { model: 't', complete: async () => { called = true; return reply; } };
  return { p: answerFromLaws({ question: 'توقيع جزاء على العامل', tenantId: 't1', asOf: '2026-11-10', library, provider, lang: 'ar' }), wasCalled: () => called };
};

describe('AI over verified laws', () => {
  it('refuses without calling the model when nothing is verified', async () => {
    const r = run(lib(false), 'from memory');
    const a = await r.p;
    expect(a.noVerifiedSource).toBe(true);
    expect(r.wasCalled()).toBe(false);
  });
  it('cites the exact verified article and version, and drops invented citations', async () => {
    const a = await run(lib(true), 'يجب الإبلاغ كتابة [[law:labour:v1:71]] [[law:labour:v1:999]]').p;
    expect(a.citations).toEqual([{ key: 'labour:v1:71', instrument: 'Labour Law', article: '71', versionLabel: 'orig', effectiveFrom: '2005-01-01' }]);
    expect(a.rejectedCitations).toEqual(['labour:v1:999']);
    expect(a.status).toBe('DRAFT_REQUIRES_HUMAN_REVIEW');
  });
});
