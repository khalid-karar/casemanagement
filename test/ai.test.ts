import { describe, expect, it } from 'vitest';
import { answerQuestion, openAICompatProvider, stripThinking, ProviderConfigError } from '../src/ai';
import type { ChatProvider } from '../src/ai';
import { createCase } from '../src/engine';
import type { Actor } from '../src/engine';
import { CASE_TYPES, hrMisconduct, legalMatter } from '../src/case-types';

const T = '00000000-0000-0000-0000-000000000001';
const now = '2026-11-10T08:00:00.000Z';
const hr: Actor = { id: 'h', kind: 'human', tenantId: T, departments: ['HR'], roles: ['hr_manager'], reportsTo: [], clearance: 'RESTRICTED' };
const counsel: Actor = { id: 'l', kind: 'human', tenantId: T, departments: ['LEGAL'], roles: ['legal_counsel'], reportsTo: [], clearance: 'PRIVILEGED' };

describe('AI assistant', () => {
  it('never puts privileged matters into an HR user’s prompt', async () => {
    const m = createCase(legalMatter, { id: 'm1', fields: { title: 'zebrafish settlement ceiling' } }, counsel, now).case;
    const h = createCase(hrMisconduct, { id: 'h1', fields: { allegationSummary: 'late arrival' } }, hr, now).case;
    let seen = '';
    const provider: ChatProvider = { model: 't', complete: async (msgs) => { seen = msgs.map((x) => x.content).join(); return 'ok [[chunk:m1:fields]] [[chunk:h1:fields]]'; } };
    const d = await answerQuestion({ question: 'late arrival settlement', actor: hr, cases: [m, h], defs: CASE_TYPES, provider });
    expect(seen).not.toContain('zebrafish');
    expect(d.citations).toEqual(['h1:fields']);
    expect(d.rejectedCitations).toEqual(['m1:fields']);
    expect(d.status).toBe('DRAFT');
  });

  it('strips reasoning blocks', () => {
    expect(stripThinking('<think>hmm</think>answer')).toBe('answer');
  });

  it('refuses hosts outside the in-Kingdom allowlist', () => {
    expect(() => openAICompatProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', allowedHosts: ['gpu.sa'] })).toThrow(ProviderConfigError);
  });
});
