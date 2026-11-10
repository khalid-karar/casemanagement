import { NajizHttpGateway } from './http';
import { NAJIZ_CONTRACT } from './contract';
import { simulatorRegistry } from './simulator';
import type { FilingParty, NajizGateway, NajizRegistry } from './types';

/**
 * Chooses the Najiz gateway per client from the environment.
 *
 *   NAJIZ_MODE=off          (default) Najiz is not offered to anyone.
 *   NAJIZ_MODE=simulated    the labelled simulator for every tenant. Refused when NODE_ENV=production.
 *   NAJIZ_MODE=live         NAJIZ_TENANTS describes each client that has Najiz access. Secrets are NOT in that JSON:
 *                           it names environment variables (or mounted secret files) that hold them.
 *
 *   NAJIZ_TENANTS='{"tenant-a":{"baseUrl":"https://…","tokenUrl":"https://…","allowedHosts":["…"],
 *       "keyEnv":"NAJIZ_A_KEY","secretEnv":"NAJIZ_A_SECRET",
 *       "claimant":{"identifierType":"UNIFIED_NATIONAL_NUMBER","identifier":"7…","name":"…"}}}'
 */
export function najizFromEnv(env: NodeJS.ProcessEnv): NajizRegistry | undefined {
  const mode = env['NAJIZ_MODE'] ?? 'off';
  if (mode === 'off') return undefined;
  if (mode === 'simulated') {
    if (env['NODE_ENV'] === 'production') throw new Error('NAJIZ_MODE=simulated is not allowed in production');
    return simulatorRegistry();
  }
  if (mode !== 'live') throw new Error(`Unknown NAJIZ_MODE: ${mode}`);
  const cfg = JSON.parse(env['NAJIZ_TENANTS'] ?? '{}') as Record<string, { baseUrl: string; tokenUrl: string; allowedHosts: string[]; keyEnv: string; secretEnv: string; claimant: Pick<FilingParty, 'identifierType' | 'identifier' | 'name'> }>;
  const gateways = new Map<string, { gw: NajizGateway; claimant: FilingParty }>();
  for (const [tenant, t] of Object.entries(cfg)) {
    const clientId = env[t.keyEnv]; const clientSecret = env[t.secretEnv];
    if (!clientId || !clientSecret) throw new Error(`Najiz credentials for ${tenant} are not set (${t.keyEnv}, ${t.secretEnv})`);
    gateways.set(tenant, {
      gw: new NajizHttpGateway({ baseUrl: t.baseUrl, tokenUrl: t.tokenUrl, allowedHosts: t.allowedHosts, clientId, clientSecret, contract: NAJIZ_CONTRACT }),
      claimant: { role: 'CLAIMANT', kind: 'ORGANISATION', ...t.claimant },
    });
  }
  return { gatewayFor: (t) => gateways.get(t)?.gw, claimantFor: (t) => gateways.get(t)?.claimant };
}
