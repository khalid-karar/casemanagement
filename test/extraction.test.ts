import { describe, expect, it } from 'vitest';
import { LegalLibrary, extractProposals, parseFindings } from '../src/legal';
import type { ChatProvider } from '../src/ai';

const ed = { id: 'ed', roles: ['legal_content_editor'], tenantId: 'platform' };
const co = { id: 'co', roles: ['legal_verifier'], tenantId: 'platform' };
const client = { id: 'cl', roles: ['legal_verifier', 'legal_content_editor'], tenantId: 't1' };
const RAW = 'المادة 72\nيبلغ العامل بالجزاء كتابة خلال خمسة عشر يوما.';

function setup(reply: string) {
  const l = new LegalLibrary();
  l.addInstrument({ id: 'labour', tenantId: null, kind: 'LAW', titleAr: 'نظام العمل', issuer: 'MHRSD' }, ed, 'x');
  const { version } = l.uploadVersion({ id: 'v1', instrumentId: 'labour', versionLabel: '1', effectiveFrom: '2005-01-01', rawText: RAW }, ed, 'x');
  const provider: ChatProvider = { model: 'm', complete: async () => reply };
  return { l, version, provider };
}

describe('extraction', () => {
  it('keeps findings whose quote is verbatim and drops invented quotes', async () => {
    const reply = '```json\n[{"kind":"DEADLINE","summary":"15 days","quote":"خلال خمسة عشر يوما"},{"kind":"PENALTY","summary":"x","quote":"غرامة مئة ألف"}]\n```';
    const { version, provider } = setup(reply);
    const r = await extractProposals(version, null, provider);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]?.status).toBe('PROPOSED');
    expect(r.droppedUnquoted).toBe(1);
  });
  it('tolerates garbage model output', () => {
    expect(parseFindings('sorry I cannot')).toEqual([]);
    expect(parseFindings('[not json')).toEqual([]);
  });
  it('shows proposals only to reviewers of that scope, never to clients', async () => {
    const { l, version, provider } = setup('[{"kind":"DEADLINE","summary":"s","quote":"خمسة عشر يوما"}]');
    l.storeProposals((await extractProposals(version, null, provider)).proposals);
    expect(l.proposalsFor('v1', co)).toHaveLength(1);
    expect(() => l.proposalsFor('v1', client)).toThrow('SCOPE_MISMATCH');
    expect(() => l.proposalsFor('v1', { ...ed, tenantId: 't1' })).toThrow('SCOPE_MISMATCH');
    expect(l.versionsFor(client)).toHaveLength(0);
  });
  it('only a verifier can accept', async () => {
    const { l, version, provider } = setup('[{"kind":"DEADLINE","summary":"s","quote":"خمسة عشر يوما"}]');
    const { proposals } = await extractProposals(version, null, provider);
    l.storeProposals(proposals);
    expect(() => l.decideProposal(proposals[0]!.id, true, ed)).toThrow();
    expect(l.decideProposal(proposals[0]!.id, true, co).status).toBe('ACCEPTED');
  });
});
