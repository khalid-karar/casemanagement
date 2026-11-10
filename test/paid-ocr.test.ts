import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractText, routeOcr, visionFromConfig, readPages } from '../src/legal';
import type { VisionOcr } from '../src/legal';
import { ocrAvailable } from '../src/legal/ocr';
import { createApp } from '../src/api/app';
import { Directory } from '../src/api/auth';
import { MemoryRepo } from '../src/api/repo';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const HAS_OCR = await ocrAvailable();
const PAID_TEXT = 'المادة 71\nلا يجوز توقيع جزاء على العامل إلا بعد إبلاغه كتابة بما نسب إليه';

function fakePaid(opts: { fail?: boolean } = {}) {
  const calls: number[] = [];
  const engine: VisionOcr = {
    name: 'fake:vision',
    async readPage(png) { calls.push(png.length); if (opts.fail) throw new Error('down'); return PAID_TEXT; },
  };
  return { engine, calls };
}

describe('OCR routing policy', () => {
  it('only platform-scope uploads may use the paid engine', () => {
    const { engine } = fakePaid();
    expect(routeOcr('platform', engine)).toBe('paid');
    expect(routeOcr('client', engine)).toBe('local');
    expect(routeOcr('platform', undefined)).toBe('local');
  });
});

describe.skipIf(!HAS_OCR)('paid OCR in extraction', () => {
  it('uses the paid engine for platform law and says so', async () => {
    const { engine, calls } = fakePaid();
    const r = await extractText(fx('law-ar-digital.pdf'), { scope: 'platform', paidOcr: engine });
    expect(r.method).toBe('paid-ocr');
    expect(calls.length).toBe(1);
    expect(r.text).toContain('لا يجوز توقيع جزاء');
    expect(r.warnings[0]).toMatch(/^PAID_OCR_USED/);
  });
  it('NEVER sends a client document to the paid engine, even when one is configured', async () => {
    const { engine, calls } = fakePaid();
    for (const f of ['law-ar-digital.pdf', 'law-ar-scan.png', 'law-ar-scan.pdf']) {
      const r = await extractText(fx(f), { scope: 'client', paidOcr: engine });
      expect(r.method).toBe('ocr');
    }
    expect(calls).toHaveLength(0);
  });
  it('falls back to local OCR if the paid engine fails', async () => {
    const { engine } = fakePaid({ fail: true });
    const r = await extractText(fx('law-ar-digital.pdf'), { scope: 'platform', paidOcr: engine });
    expect(r.method).toBe('ocr');
    expect(r.warnings.some((w) => w.startsWith('PAID_OCR_FAILED'))).toBe(true);
    expect(r.text).toContain('لا يجوز توقيع جزاء');
  });
  it('via the API: platform editor gets paid OCR, a client editor never does', async () => {
    const { engine, calls } = fakePaid();
    const d = new Directory();
    d.add({ id: 'pe', name: 'pe', kind: 'human', tenantId: 'platform', departments: ['LEGAL'], roles: ['legal_content_editor'], reportsTo: [], clearance: 'RESTRICTED' });
    d.add({ id: 'ce', name: 'ce', kind: 'human', tenantId: 'tenant-a', departments: ['LEGAL'], roles: ['legal_content_editor'], reportsTo: [], clearance: 'RESTRICTED' });
    const app = createApp({ repo: new MemoryRepo(), directory: d, provider: { model: 't', complete: async () => '' }, paidOcr: engine });
    const send = async (who: string) => {
      const fd = new FormData();
      fd.append('file', new File([fx('law-ar-digital.pdf')], 'a.pdf'));
      return (await (await app.request('/laws/files', { method: 'POST', headers: { authorization: `Bearer dev:${who}` }, body: fd })).json()) as any;
    };
    expect((await send('pe')).method).toBe('paid-ocr');
    const before = calls.length;
    expect((await send('ce')).method).toBe('ocr');
    expect(calls.length).toBe(before);
  });
});

describe('vision adapters and concurrency', () => {
  const png = Buffer.from([1, 2, 3]);
  it('builds the right request for each vendor shape and requires https', async () => {
    const seen: any[] = [];
    const f = (async (url: string, init: any) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); return new Response(JSON.stringify(url.endsWith('/messages') ? { content: [{ type: 'text', text: 'نص' }] } : { choices: [{ message: { content: 'نص' } }] })); }) as unknown as typeof fetch;
    const a = visionFromConfig({ kind: 'anthropic', baseUrl: 'https://x.example', model: 'm', apiKey: 'k', fetchImpl: f });
    const o = visionFromConfig({ kind: 'openai', baseUrl: 'https://y.example/v1', model: 'm', apiKey: 'k', fetchImpl: f });
    expect(await a.readPage(png)).toBe('نص');
    expect(await o.readPage(png)).toBe('نص');
    expect(seen[0].url).toBe('https://x.example/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe('k');
    expect(seen[1].url).toBe('https://y.example/v1/chat/completions');
    expect(() => visionFromConfig({ kind: 'openai', baseUrl: 'http://insecure.example', model: 'm', apiKey: 'k' })).toThrow(/https/);
  });
  it('reads pages in parallel, keeps page order, and never exceeds the limit', async () => {
    let live = 0, peak = 0;
    const engine: VisionOcr = { name: 'x', async readPage(b) { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 20)); live--; return String(b[0]); } };
    const pages = Array.from({ length: 10 }, (_, i) => Buffer.from([i]));
    expect(await readPages(engine, pages, 4)).toEqual(pages.map((_, i) => String(i)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});
