import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { Directory } from './auth';
import { MemoryRepo } from './repo';
import { PgRepo } from './pg-repo';
import { openAICompatProvider } from '../ai';

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

const app = createApp({ repo, directory, provider });
app.use('/*', serveStatic({ root: './web' }));
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`listening on :${port}`);
