import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { Directory } from './auth';
import { OidcAuthenticator } from './oidc';
import { MemoryRepo } from './repo';
import { PgRepo } from './pg-repo';
import { openAICompatProvider } from '../ai';
import { visionFromConfig } from '../legal';
import { TEST_USERS, asPrincipal } from './test-users';

// Sign-in. Real deployments use OIDC (Keycloak). The dev directory exists only for local demos and is refused in production.
const authMode = process.env.AUTH_MODE;
if (authMode !== 'oidc' && authMode !== 'dev') throw new Error("Set AUTH_MODE to 'oidc' (real sign-in) or 'dev' (local demo only)");
if (authMode === 'dev' && process.env.NODE_ENV === 'production') throw new Error('AUTH_MODE=dev is not allowed when NODE_ENV=production');
const directory = new Directory();
const repo = process.env.DATABASE_URL
  ? await PgRepo.connect(process.env.DATABASE_URL)
  : (console.warn('DATABASE_URL not set: using in-memory storage. Data is lost on restart.'), new MemoryRepo());

// Demo users for local development and QA only. The same matrix becomes the QA Keycloak realm
// (`pnpm gen:realm:qa`), so a wall proved here is the same wall proved through real sign-in.
if (authMode === 'dev') for (const u of TEST_USERS) directory.add(asPrincipal(u));

// Sovereign model (own GPU). Optional: leave LLM_BASE_URL unset until a client needs own-model-only.
const baseUrl = process.env.LLM_BASE_URL;
const provider = baseUrl ? openAICompatProvider({
  baseUrl,
  model: process.env.LLM_MODEL ?? 'qwen3.8-27b',
  allowedHosts: (process.env.LLM_ALLOWED_HOSTS ?? new URL(baseUrl).hostname).split(','),
  ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}),
}) : undefined;

// External in-Kingdom provider (Azure / Google / etc.): used only for tenants that signed the consent.
const ikUrl = process.env.INKINGDOM_LLM_BASE_URL;
if (ikUrl && (!process.env.INKINGDOM_LLM_REGION || !process.env.INKINGDOM_LLM_NAME || !process.env.INKINGDOM_LLM_MODEL || !process.env.INKINGDOM_LLM_ALLOWED_HOSTS)) {
  throw new Error('INKINGDOM_LLM_NAME, _REGION, _MODEL and _ALLOWED_HOSTS are required with INKINGDOM_LLM_BASE_URL');
}
const inKingdom = ikUrl ? {
  name: process.env.INKINGDOM_LLM_NAME!, region: process.env.INKINGDOM_LLM_REGION!,
  provider: openAICompatProvider({ baseUrl: ikUrl, model: process.env.INKINGDOM_LLM_MODEL!, allowedHosts: process.env.INKINGDOM_LLM_ALLOWED_HOSTS!.split(','), ...(process.env.INKINGDOM_LLM_API_KEY ? { apiKey: process.env.INKINGDOM_LLM_API_KEY } : {}), ...(process.env.INKINGDOM_LLM_AUTH_HEADER ? { authHeader: process.env.INKINGDOM_LLM_AUTH_HEADER } : {}) }),
} : undefined;

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
let authn: { resolve: (h: string | undefined) => any } = directory;
let authInfo: { mode: 'dev' | 'oidc'; issuer?: string; clientId?: string; users?: { id: string; name: string; tenantId: string }[] } =
  { mode: 'dev', users: TEST_USERS.map(({ id, name, tenantId }) => ({ id, name, tenantId })) };
if (authMode === 'oidc') {
  const issuer = process.env.OIDC_ISSUER;
  if (!issuer) throw new Error('OIDC_ISSUER is required');
  const clientId = process.env.OIDC_CLIENT_ID ?? 'case-web';
  authn = new OidcAuthenticator({
    issuer,
    audience: process.env.OIDC_AUDIENCE ?? 'case-api',
    allowedClients: (process.env.OIDC_ALLOWED_CLIENTS ?? clientId).split(','),
    allowInsecureIssuer: process.env.OIDC_ALLOW_INSECURE_ISSUER === 'true' && process.env.NODE_ENV !== 'production',
  });
  authInfo = { mode: 'oidc', issuer, clientId };
}
const app = createApp({ repo, directory: authn, authInfo, ...(provider ? { provider } : {}), ...(inKingdom ? { inKingdom } : {}), ...(paidOcr ? { paidOcr } : {}) });
app.use('/*', serveStatic({ root: './web' }));
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`listening on :${port}`);
