import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { Directory } from './auth';
import { MemoryRepo } from './repo';
import { PgRepo } from './pg-repo';
import { openAICompatProvider } from '../ai';
import { visionFromConfig } from '../legal';

const directory = new Directory();
const repo = process.env.DATABASE_URL
  ? await PgRepo.connect(process.env.DATABASE_URL)
  : (console.warn('DATABASE_URL not set: using in-memory storage. Data is lost on restart.'), new MemoryRepo());

// Demo users for local development only.
const T = '00000000-0000-0000-0000-000000000001';
const u = (id: string, name: string, departments: any, roles: string[], clearance: any = 'RESTRICTED', tenantId = T) =>
  directory.add({ id, name, kind: 'human', tenantId, departments, roles, reportsTo: [], clearance });
u('hr-mgr', 'HR Manager', ['HR'], ['hr_intake', 'hr_manager']);
u('hr-inv', 'HR Investigator', ['HR'], ['hr_investigator']);
u('hr-dir', 'HR Director', ['HR'], ['hr_director']);
u('counsel', 'In-house Counsel', ['LEGAL'], ['legal_counsel', 'general_counsel'], 'PRIVILEGED');
u('editor', 'Legal Content Editor', ['LEGAL'], ['legal_content_editor'], 'RESTRICTED', 'platform');
u('verifier', 'Legal Verifier (Counsel)', ['LEGAL'], ['legal_verifier'], 'RESTRICTED', 'platform');

const baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:8000/v1';
const provider = openAICompatProvider({
  baseUrl,
  model: process.env.LLM_MODEL ?? 'qwen3.8-27b',
  allowedHosts: (process.env.LLM_ALLOWED_HOSTS ?? new URL(baseUrl).hostname).split(','),
  ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}),
});

// Optional paid OCR, used ONLY for national law uploaded by the platform team. Client uploads always stay on local OCR.
if (process.env.PAID_OCR_API_KEY && !process.env.PAID_OCR_MODEL) throw new Error('PAID_OCR_MODEL is required when PAID_OCR_API_KEY is set');
const paidOcr = process.env.PAID_OCR_API_KEY
  ? visionFromConfig({
      kind: (process.env.PAID_OCR_KIND as 'openai' | 'anthropic') ?? 'anthropic',
      baseUrl: process.env.PAID_OCR_BASE_URL ?? 'https://api.anthropic.com',
      model: process.env.PAID_OCR_MODEL!,
      apiKey: process.env.PAID_OCR_API_KEY,
    })
  : undefined;
const app = createApp({ repo, directory, provider, ...(paidOcr ? { paidOcr } : {}) });
app.use('/*', serveStatic({ root: './web' }));
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`listening on :${port}`);
